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
    1. SAVED MEMORIES: If the live stream MATCHES a reference photo, warmly mention it and tell them the specific date.
    2. FAMOUS PLACES / BACKGROUND: Observe the immediate background and describe it naturally.
    Respond ONLY using spoken voice. Keep responses concise, warm, and highly conversational. Answer naturally to audio questions.
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

   // FIX: Explicitly tell Gemini these are reference photos, NOT the current camera view.
   const initialParts = [
    { text: `System Note: I am providing you with reference photos of my past memories. Do NOT analyze these as my current surroundings right now. Just store them in your context. Acknowledge me by my name (${userName}) and say you are ready, then wait for the live video stream and my voice.` }
   ];
   
   referencePhotos.forEach(photo => {
    initialParts.push({ text: `Memory - Description: ${photo.description}, Date: ${photo.date}` });
    initialParts.push({ inlineData: { mimeType: photo.mimeType, data: photo.data } });
   });

   session.send({
    clientContent: {
     turns: [{ role: "user", parts: initialParts }],
     turnComplete: true 
    }
   });

    console.log("✅ Reference photos sent successfully.");
   // Forward BOTH Real-time Video Frames and Microphone Audio using standard realtimeInput schema
   ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    if (data.type === "frame") {
     session.send({
      realtimeInput: { mediaChunks: [{ mimeType: "image/jpeg", data: data.frameBase64 }] }
     });
    } else if (data.type === "audio") {
     session.send({
      realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: data.audioBase64 }] }
     });
    }
   });

  } catch (error) {
   console.error("Live Stream Error:", error);
  }
 });
}
