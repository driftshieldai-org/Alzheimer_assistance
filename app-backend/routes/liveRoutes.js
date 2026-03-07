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

     const SYSTEM_INSTRUCTION = `
     You are a polite, helpful AI assistant named MemoryMate with a soft, calming tone.
     The user's name is ${userName}.
     Instructions:
     1. Listen to the user's voice and observe the video stream.
     2. When the user asks you a question or speaks to you, answer naturally based on what you see in the video.
     3. Match against the provided reference photos: If a person or place MATCHES a reference photo, politely inform the user, mentioning the DATE and DESCRIPTION stored with the photo.
     4. If it's a NEW scene, analyze the background and describe the environment contextually.
     5. Keep your responses conversational, short, and natural.
     `;

     const projectId = process.env.GCP_PROJECT_ID;
     const location = process.env.GCP_REGION || "us-central1";
     
     // FIXED: Using the stable GA model
     const model = "gemini-2.0-flash"; 
     const ai = new GoogleGenAI({ vertexai: true, project: projectId, location: location });
     
     // RESTORED: Using your original callback structure which is correct for Node.js
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

           // Handle Model interruption (User started speaking)
           if (message.serverContent?.interrupted) {
             if (ws.readyState === WebSocket.OPEN) {
               ws.send(JSON.stringify({ type: "interrupted" }));
             }
           }

           // Forward audio/text back to frontend accurately
           if (message.serverContent?.modelTurn?.parts) {
             let generatedText = '';
             
             for (const part of message.serverContent.modelTurn.parts) {
               if (part.text) generatedText += part.text;
               
               if (part.inlineData?.data && ws.readyState === WebSocket.OPEN) {
                 ws.send(JSON.stringify({
                   type: "audioResponse",
                   description: generatedText, // attach any text that came before the audio
                   audioBase64: part.inlineData.data
                 }));
                 generatedText = ''; // Clear text so it isn't repeated
               }
             }
             
             // Forward leftover text if no audio came with it
             if (generatedText && ws.readyState === WebSocket.OPEN) {
                 ws.send(JSON.stringify({ type: "audioResponse", description: generatedText }));
             }
           }
         },
         onerror: (err) => {
            console.error("Gemini Live API Error:", err);
         },
         onclose: (e) => { 
            console.log(`⚠️ Gemini WS Closed. Code: ${e.code}, Reason: ${e.reason}`);
            if (ws.readyState === WebSocket.OPEN) ws.close(); 
         }
       }
     });

     // 4. Send Photos + Dates as Context
     if (referencePhotos.length > 0) {
       const initialParts = [];
       referencePhotos.forEach(photo => {
         initialParts.push({ text: `Memory - Description: ${photo.description}, Date: ${photo.date}` });
         initialParts.push({ inlineData: { mimeType: photo.mimeType, data: photo.data } });
       });
       initialParts.push({ text: `Hello, my name is ${userName}. I am ready to start.` });

       // RESTORED AND FIXED: Using your original method, but turnComplete MUST BE TRUE
       await session.sendClientContent({
         turns: [{ role: "user", parts: initialParts }],
         turnComplete: true // CRITICAL FIX: Tells AI "I am done sending setup data, you can speak now!"
       });
     } else {
       await session.sendClientContent({
         turns: [{ role: "user", parts: [{ text: `Hello, my name is ${userName}. I am ready.` }] }],
         turnComplete: true // CRITICAL FIX
       });
     }

     // 5. Forward BOTH Real-time Video Frames and Real-time Microphone Audio
     ws.on('message', async (msg) => {
       const data = JSON.parse(msg);

       // Forward Video frame using your original valid method
       if (data.type === "frame") {
         await session.sendRealtimeInput([{
           mimeType: "image/jpeg",
           data: data.frameBase64
         }]);
       } 
       
       // Forward User's Microphone Audio chunks continuously
       else if (data.type === "audio") {
         await session.sendRealtimeInput([{
           mimeType: "audio/pcm;rate=16000",
           data: data.audioBase64
         }]);
       }
       
       // Note: Removed the custom `speech_start` and `end_of_turn` here. 
       // You don't need them! By sending audio continuously via realtimeInput, 
       // Gemini's built-in VAD will automatically interrupt itself.
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
