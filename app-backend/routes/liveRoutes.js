import express from 'express';
import WebSocket from 'ws';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import jwt from 'jsonwebtoken';
import { GoogleGenAI } from '@google/genai'; 

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
       - If it is NOT a famous place, analyze the background and describe the environment contextually (e.g., "It looks like you are in your kitchen", "You seem to be in a bedroom").
    5. Keep your responses conversational, short, and natural.
   `;

    const projectId = process.env.GCP_PROJECT_ID;
    const location = process.env.GCP_REGION || "us-central1";
    const model = "gemini-live-2.5-flash-native-audio";

    console.log(`projectId: ${projectId} location: ${location}`);
    
   const ai = new GoogleGenAI({ vertexai: true, project: projectId, location: location || "us-central1" });
   
   let resolveSetupComplete;
   const waitForSetup = new Promise((resolve) => resolveSetupComplete = resolve);

   const session = await ai.live.connect({
    model: model, 
    config: {
     responseModalities: ["AUDIO"],
     speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
     systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }
    },
    callbacks: {
     onopen: () => console.log("🟢 Connected to Gemini Live API"),
     onmessage: (message) => {
      if (message.setupComplete) {
       console.log("✅ Gemini Live API Setup Complete!"); 
       resolveSetupComplete(); 
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
       for (const part of message.serverContent.modelTurn.parts) {
        if (part.inlineData?.data && ws.readyState === WebSocket.OPEN) {
         ws.send(JSON.stringify({ type: "audio", audioBase64: part.inlineData.data }));
        }
       }
      }
     },
     onerror: (err) => console.error("Gemini Live API Error:", err),
     onclose: () => { 
       console.log(`🔴 Gemini WS Closed. Code: ${e.code}`);
       if (ws.readyState === WebSocket.OPEN) ws.close(); }
    }
   });

   await waitForSetup;

      // 4. Send Photos + Dates as Context
      if (referencePhotos.length > 0) {
        console.log("Sending reference photos to Gemini...");
        
        const parts = [
          { text: `System Note: I am providing you with reference photos of my past memories. Do NOT analyze these as my current surroundings right now. Just store them in your context. Acknowledge me by my name (${userName}) and say you are ready, then wait for the live video stream and my voice.` }
        ];
        
        referencePhotos.forEach(photo => {
          parts.push({ text: `Memory - Description: ${photo.description}, Date: ${photo.date}` });
          parts.push({ inlineData: { mimeType: photo.mimeType, data: photo.data } });
        });

        session.sendClientContent({
          turns: [{
            role: "user",
            parts: parts
          }],
          turnComplete: true 
        });
        console.log("✅ Reference photos sent successfully.");
      } else {
        session.sendClientContent({
          turns: [{ role: "user", parts: [{ text: `Hello, my name is ${userName}. I am ready.` }] }],
          turnComplete: true
        });
      }

      // 5. Forward BOTH Real-time Video Frames and Real-time Microphone Audio
      ws.on('message', (msg) => {
        const data = JSON.parse(msg);

        // Forward Video frame
        if (data.type === "frame") {
          session.sendRealtimeInput([{
            mimeType: "image/jpeg",
            data: data.frameBase64
          }]);
        } 
        
        // Forward User's Microphone Audio chunks
        else if (data.type === "audio") {
          session.sendRealtimeInput([{
            mimeType: "audio/pcm;rate=16000",
            data: data.audioBase64
          }]);
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
