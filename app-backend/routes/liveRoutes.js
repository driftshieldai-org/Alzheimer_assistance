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

   const SYSTEM_INSTRUCTION = `
   You are MemoryMate, a polite AI assistant. The user's name is ${userName}.
   Instructions:
   1. Converse naturally based on what the user says and what you see.
   2. Match the environment/people against reference photos. If matched, mention the DATE and DESCRIPTION.
   3. Keep responses conversational and short.
   `;

   const projectId = process.env.GCP_PROJECT_ID;
   const location = process.env.GCP_REGION || "us-central1";
   
   // BACK TO THE WORKING NATIVE AUDIO MODEL
   const model = "gemini-live-2.5-flash-native-audio";

   const ai = new GoogleGenAI({ vertexai: true, project: projectId, location: location });
   
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
      if (message.setupComplete) return;

      if (message.serverContent?.interrupted) {
       console.log("🛑 Model interrupted automatically");
      }

      if (message.serverContent?.modelTurn?.parts) {
       let generatedText = '';
       let generatedAudioBase64 = '';

       for (const part of message.serverContent.modelTurn.parts) {
        if (part.text) generatedText += part.text;
        if (part.inlineData?.data) generatedAudioBase64 = part.inlineData.data;
       }

       if (generatedText) console.log(`🤖 AI Text: ${generatedText}`);

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
      console.log(`🔴 Gemini WS Closed. Code: ${code}, Reason: ${reason}`);
      if (ws.readyState === WebSocket.OPEN) ws.close(); 
     }
    }
   });

   // Setup 1: Context
   if (referencePhotos.length > 0) {
    await session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: `System Note: Here are reference photos of my memories.` }] }],
      turnComplete: false
    });

    for (const photo of referencePhotos) {
     await session.sendClientContent({
       turns: [{ role: "user", parts: [
         { text: `Memory - Description: ${photo.description}, Date: ${photo.date}` },
         { inlineData: { mimeType: photo.mimeType, data: photo.data } }
       ]}],
       turnComplete: false
     });
    }
   }

   // Setup 2: Trigger AI Greeting
   await session.sendClientContent({
     turns: [{ role: "user", parts: [{ text: `Hello, I am ${userName}. I am turning on my camera and microphone now. Let me know when you are ready.` }] }],
     turnComplete: true 
   });

   // Store the most recent video frame in memory
   let latestVideoFrame = null;

   // Stream Handling
   ws.on('message', async (msg) => {
    const data = JSON.parse(msg);

    try {
     if (data.type === "frame") {
      latestVideoFrame = data.frameBase64;
      await session.sendRealtimeInput([{ mimeType: "image/jpeg", data: data.frameBase64 }]);
     } 
     else if (data.type === "audio") {
      await session.sendRealtimeInput([{ mimeType: "audio/pcm;rate=16000", data: data.audioBase64 }]);
     }
     else if (data.type === "speech_start") {
      console.log("🎤 User started speaking.");
     }
     else if (data.type === "end_of_turn") {
      console.log("🤫 User stopped speaking. Closing turn with Image Frame to preserve audio buffer...");
      
      // THE FIX: We use the Video Frame to close the turn!
      // This satisfies the SDK validation, avoids text-overrides, and forces the AI to process your voice!
      if (latestVideoFrame) {
        await session.sendClientContent({
          turns: [{ 
            role: "user", 
            parts: [{ inlineData: { mimeType: "image/jpeg", data: latestVideoFrame } }] 
          }],
          turnComplete: true
        });
      } else {
        // Fallback just in case the camera hasn't sent a frame yet
        await session.sendClientContent({
          turns: [{ role: "user", parts: [{ text: " " }] }],
          turnComplete: true
        });
      }
     }
    } catch (sendErr) {
      console.error("Error sending to Gemini:", sendErr);
    }
   });
   

  } catch (error) {
   console.error("Live Stream Error:", error);
   if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Server error");
  }
 });
}
