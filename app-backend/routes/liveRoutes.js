import express from 'express';
import WebSocket from 'ws';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import jwt from 'jsonwebtoken';
import { GoogleGenAI, Modality } from '@google/genai'; 

export default function (app) {
 const db = new Firestore({ projectId: process.env.GCP_PROJECT_ID });
 const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
 const bucket = storage.bucket(process.env.GCS_BUCKET_NAME);

 async function getGcsFileAsBase64(filename) {
  const [fileContent] = await bucket.file(filename).download();
  return fileContent.toString('base64');
 }

 app.ws('/api/live/ws/live/process-stream', async (ws, req) => {
  const token = req.query.token;
  if (!token) { ws.close(1008, "token required"); return; }

  let userId;
  try {
   const decoded = jwt.verify(token, process.env.JWT_SECRET);
   userId = decoded.userId;
  } catch (err) {
   ws.close(1008, "Invalid token"); return;
  }

  try {
   let userName = userId;
   const userDoc = await db.collection('users').doc(userId).get();
   if (userDoc.exists) userName = userDoc.data().name || userId;

   const photosSnapshot = await db.collection('users').doc(userId).collection('photos').get();
   const referencePhotos = [];
   for (const doc of photosSnapshot.docs) {
    const photoData = doc.data();
    if (photoData.filename) {
     const base64Image = await getGcsFileAsBase64(photoData.filename);
     referencePhotos.push({
      description: photoData.description || "No description",
      date: photoData.photoDate || "unknown date",
      mimeType: "image/jpeg",
      data: base64Image
     });
    }
   }

   console.log(`Loaded ${referencePhotos.length} reference photos`);
   
   const SYSTEM_INSTRUCTION = `
   You are a polite, helpful AI assistant named MemoryMate with a soft, calming tone.
   The user's name is ${userName}.
   Instructions:
   1. Listen to the user's voice and observe the video stream.
   2. When the user asks you a question or speaks to you, answer naturally based on what you see in the video.
   3. Match against the provided reference photos:
     - If a person or place MATCHES a reference photo, politely inform the user.
     - Crucially, you MUST mention the DATE and DESCRIPTION stored with the photo. For example: "You might have visited this place on [Date]" or "You have met with [Description] on [Date]."
   4. If it's a NEW scene (does NOT match reference photos):
     - First, check if it matches a famous world landmark or well-known place. If yes, respond accordingly with a friendly detail.
     - If it is NOT a famous place, analyze the background and describe the environment contextually.
   5. Keep your responses conversational, short, and natural.
   `;

   const projectId = process.env.GCP_PROJECT_ID;
   const location = process.env.GCP_REGION || "us-central1";
   
   // FIX 1: Use the correct globally available native audio model for Vertex AI
   const model = "gemini-live-2.5-flash-native-audio";

   console.log(`projectId: ${projectId} location: ${location}`);
    
   const ai = new GoogleGenAI({ vertexai: true, project: projectId, location: location });
   
   const session = await ai.live.connect({
    model: model, 
    config: {
     responseModalities: [Modality.AUDIO], // Or ["AUDIO"]
     speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
     systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }
    },
    callbacks: {
     onopen: () => console.log("🟢 Connected to Gemini Live API"),
     onmessage: (message) => {
      if (message.setupComplete) {
       console.log("✅ Gemini Live API Setup Complete!"); 
       return;
      }

      // Handle Model interruption (User started speaking)
      if (message.serverContent?.interrupted) {
       if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "interrupted" }));
       }
      }

      // Forward audio back to frontend
      if (message.serverContent?.modelTurn?.parts) {
       let generatedText = '';
       let generatedAudioBase64 = '';

       for (const part of message.serverContent.modelTurn.parts) {
        if (part.text) {
         generatedText += part.text;
        }
        if (part.inlineData?.data) {
         generatedAudioBase64 = part.inlineData.data;
        }
       }

       if ((generatedText || generatedAudioBase64) && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
         type: "audioResponse",
         description: generatedText,
         audioBase64: generatedAudioBase64
        }));
       }
      }
     },
     onerror: (err) => console.error("Gemini Live API Error:", err),
     onclose: (e) => { 
      console.log(`🔴 Gemini WS Closed. Code: ${e.code}, Reason: ${e.reason || "None"}`);
      if (ws.readyState === WebSocket.OPEN) ws.close(); }
    }
   });

   // Send Photos + Dates as Context
   if (referencePhotos.length > 0) {
    console.log("Sending reference photos to Gemini...");
    
    await session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: `System Note: Here are reference photos of my memories. Use them as context.` }] }],
      turnComplete: false
    });

    for (const photo of referencePhotos) {
      await session.sendClientContent({
        turns: [{
          role: "user",
          parts: [
            { text: `Memory - Description: ${photo.description}, Date: ${photo.date}` },
            { inlineData: { mimeType: photo.mimeType, data: photo.data } }
          ]
        }],
        turnComplete: false
      });
    }
    console.log("✅ Reference photos sent successfully.");
    
    // Final text to prompt the initial AI greeting
    await session.sendClientContent({
     turns: [{ role: "user", parts: [{ text: `Hello, my name is ${userName}. I am ready.` }] }],
     turnComplete: true // FIX 2: Set to TRUE here so the model starts its greeting immediately!
    });
   } else {
    await session.sendClientContent({
     turns: [{ role: "user", parts: [{ text: `Hello, my name is ${userName}. I am ready.` }] }],
     turnComplete: true // FIX 2: Set to TRUE
    });
   }

   // Forward Real-time Video Frames and Microphone Audio
   ws.on('message', async (msg) => {
    const data = JSON.parse(msg);

    // Forward Video frame
    if (data.type === "frame") {
     // FIX 3: Use { video: { ... } } instead of { media: { ... } }
     await session.sendRealtimeInput({ 
      video: {
       mimeType: "image/jpeg",
       data: data.frameBase64
      }
     });
    } 
    
    // Forward User's Microphone Audio chunks
    else if (data.type === "audio") {
     // FIX 4: Use { audio: { ... } } instead of { media: { ... } }
     await session.sendRealtimeInput({ 
      audio: {
       mimeType: "audio/pcm;rate=16000",
       data: data.audioBase64
      }
     });
    }

    // Speech Start (Interrupt AI)
    else if (data.type === "speech_start") {
     console.log("🔴 User interruption detected");
     await session.sendClientContent({
      turnComplete: false
     });
    }
   
    // End of Turn
    else if (data.type === "end_of_turn") {
     console.log("🟢 Sending turnComplete to Gemini");
     await session.sendClientContent({
      turnComplete: true
     });
    }
   });

   ws.on('close', () => {
    console.log("Client WS closed connection.");
   });

  } catch (error) {
   console.error("Live Stream Error:", error);
   if (ws.readyState === WebSocket.OPEN) {
    ws.close(1011, "Server error");
   }
  }
 });
}
