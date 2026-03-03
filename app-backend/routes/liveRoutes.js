import express from 'express';
import WebSocket from 'ws';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import jwt from 'jsonwebtoken';
// 1. Import the official Gen AI SDK
import { GoogleGenAI } from '@google/genai'; 

export default function (app) {

 const db = new Firestore({ projectId: process.env.GCP_PROJECT_ID });
 const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });

 const bucketName = process.env.GCS_BUCKET_NAME;
 if (!bucketName) {
  console.error("🚨 GCS_BUCKET_NAME is missing.");
  process.exit(1);
 }
 const bucket = storage.bucket(bucketName);

 const SYSTEM_INSTRUCTION = `
You are a polite, helpful AI assistant with a soft, calming tone.
You are given reference photos of a user.
Continuously observe live video stream frames.

If the live stream MATCHES a reference photo:
- Warmly greet them
- Politely state their description

If it DOES NOT MATCH:
- Softly describe what you see in the scene.

Respond ONLY using spoken voice.
Keep responses concise.
`;

 async function getGcsFileAsBase64(filename) {
  const [fileContent] = await bucket.file(filename).download();
  return fileContent.toString('base64');
 }

 app.ws('/api/live/ws/live/process-stream', async (ws, req) => {

  const token = req.query.token;
  if (!token) {
   ws.close(1008, "token required");
   return;
  }

  let userId;
  try {
   const decoded = jwt.verify(token, process.env.JWT_SECRET);
   userId = decoded.userId;
   console.log(`🟢 JWT Verified for User: ${userId}`);
  } catch (err) {
   ws.close(1008, "Invalid token");
   return;
  }

  try {
   console.log("Fetching reference photos...");
   const photosSnapshot = await db
    .collection('users')
    .doc(userId)
    .collection('photos')
    .get();

   const referencePhotos = [];

   for (const doc of photosSnapshot.docs) {
    const photoData = doc.data();
    if (photoData.filename) {
     const base64Image = await getGcsFileAsBase64(photoData.filename);
     referencePhotos.push({
      description: photoData.description || "No description",
      mimeType: "image/jpeg",
      data: base64Image
     });
    }
   }

   console.log(`Loaded ${referencePhotos.length} reference photos`);

   const projectId = process.env.GCP_PROJECT_ID;
   const location = process.env.GCP_REGION || "us-central1";
   const model = "gemini-2.5-flash-live-preview"; // Hackathon standard is usually gemini-2.0-flash-exp

  console.log(`projectid: ${projectId} location: ${location}`);
   // ---------------------------
   // 2. INITIALIZE GOOGLE GEN AI SDK 
   // ---------------------------
   // Passing 'vertexai' automatically retrieves standard GCP credentials (ADC)
   const ai = new GoogleGenAI({
    vertexai: { project: projectId, location: location }
   });

// ---------------------------
   // 3. CONNECT TO GEMINI LIVE API
   // ---------------------------
   const session = await ai.live.connect({
    model: model,
    config: {
     // NOTE: generationConfig is removed. Place fields directly on config.
     responseModalities: ["AUDIO"],
     speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
     },
     systemInstruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }]
     }
    },
    callbacks: {
     onopen: () => {
      console.log("🟢 Connected to Gemini Live API");
     },
     onmessage: (message) => {
      const response = message.serverContent ? message : JSON.parse(message.data);

      if (response.serverContent?.modelTurn?.parts) {
       for (const part of response.serverContent.modelTurn.parts) {
        if (part.inlineData?.data) {
         if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
           type: "audio",
           audioBase64: part.inlineData.data
          }));
         }
        }
        if (part.text) {
         console.log("Model text:", part.text);
        }
       }
      }
     },
     onerror: (err) => {
      console.error("Gemini Live API Error:", err);
     },
     onclose: (e) => {
      console.log("🔴 Gemini WS Closed.");
      if (ws.readyState === WebSocket.OPEN) {
       ws.close();
      }
     }
    }
   });

   // ---------------------------
   // SEND REFERENCE PHOTOS
   // ---------------------------
   referencePhotos.forEach(photo => {
    // Use sendClientContent instead of session.send
    session.sendClientContent({
     turns: [{
      role: "user",
      parts: [
       { text: `Reference person: ${photo.description}` },
       { inlineData: { mimeType: photo.mimeType, data: photo.data } }
      ]
     }],
     turnComplete: true
    });
   });

   // ---------------------------
   // STREAM VIDEO FRAMES
   // ---------------------------
   ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.type === "frame") {
     // Use sendRealtimeInput instead of session.send
     session.sendRealtimeInput([{
      mimeType: "image/jpeg",
      data: data.frameBase64
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
