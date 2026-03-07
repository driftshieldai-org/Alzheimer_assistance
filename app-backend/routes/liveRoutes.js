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

   console.log(`Loaded
 ${referencePhotos.length} reference photos`);
   
   const SYSTEM_INSTRUCTION = `
   You are MemoryMate, a polite, helpful AI assistant with a soft, calming tone.
   The user's name is ${userName}.
   Instructions:
   1. Converse naturally. Listen to the user's voice and observe the video stream.
   2. Match the environment/people against the provided reference photos:
     - If a person or place MATCHES a reference photo, politely inform the user, MUST mention the DATE and DESCRIPTION. Example: "You might have visited this place on [Date]"
   3. If it's a NEW scene (does NOT match reference photos):
     - First, check if it matches a famous world landmark. If yes, respond accordingly.
     - If it is NOT a famous place, analyze the background and describe the environment contextually.
   4. Keep your responses conversational, short, and natural. Do not be overly verbose.
   `;

   const projectId = process.env.GCP_PROJECT_ID;
   const location = process.env.GCP_REGION || "us-central1";
   const model = "gemini-live-2.5-flash-native-audio";

   console.log(`projectId: ${projectId} location: ${location} model: ${model}`);
    
   const ai = new GoogleGenAI({ vertexai: true, project: projectId, location: location });
   
   const session = await ai.live.connect({
    model: model, 
    config: {
     responseModalities: [Modality.AUDIO], 
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

      // Handle Model interruption natively triggered by Google's VAD
      if (message.serverContent?.interrupted) {
       console.log("🛑 Model interrupted automatically by user's voice");
       if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "interrupted" }));
       }
      }

      // Forward generated audio back to frontend
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

       // VISIBILITY LOGS: See exactly what the AI is thinking/sending
       if (generatedText) console.log(`🤖 AI: ${generatedText}`);
       if (generatedAudioBase64) console.log(`🔊 AI sending audio chunk...`);

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
      if (ws.readyState === WebSocket.OPEN) ws.close(); 
     }
    }
   });

   // Setup 1: Send Photos + Dates as Context
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
   }

   // Setup 2: Trigger initial AI greeting (Notice turnComplete is TRUE here!)
   await session.sendClientContent({
     turns: [{ role: "user", parts: [{ text: `Hello, my name is ${userName}. I am turning on my camera and microphone now. Let me know when you are ready.` }] }],
     turnComplete: true 
   });

   // Stream Handling
     ws.on('message', async (msg) => {
    const data = JSON.parse(msg);

    try {
     if (data.type === "frame") {
      await session.sendRealtimeInput([{ mimeType: "image/jpeg", data: data.frameBase64 }]);
     } 
     else if (data.type === "audio") {
      await session.sendRealtimeInput([{ mimeType: "audio/pcm;rate=16000", data: data.audioBase64 }]);
     }
     else if (data.type === "speech_start") {
      console.log("🎤 User started speaking. (Frontend muted AI)");
     }
     else if (data.type === "end_of_turn") {
      console.log("🤫 User stopped speaking. Forcing Gemini to respond...");
      
      // FORCE THE RESPONSE: 
      // Sending a blank space tells the AI "I am done talking."
      // Because the text is blank, it will automatically look at your microphone audio and video frames to generate its answer!
      await session.sendClientContent({ 
          turns: [{ role: "user", parts: [{ text: " " }] }], 
          turnComplete: true 
      });
     }
    } catch (sendErr) {
      console.error("Error sending to Gemini session:", sendErr);
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
