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
    console.log("🔌 Client requested WebSocket connection...");
    
    const token = req.query.token;
    if (!token) { ws.close(1008, "token required"); return; }

    let userId;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.userId;
    } catch (err) {
      console.error("❌ Invalid Token");
      ws.close(1008, "Invalid token"); return;
    }

    try {
      // 1. Load User Context
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

      // 2. Initialize Gemini (USE THIS EXACT MODEL)
      const projectId = process.env.GCP_PROJECT_ID;
      const location = process.env.GCP_REGION || "us-central1";
      const model = "gemini-live-2.5-flash-native-audio"; // <--- THIS IS THE CORRECT VERTEX ID

      console.log(`🚀 Connecting to Gemini Live: ${model} in ${location}`);
      
      const ai = new GoogleGenAI({ vertexai: true, project: projectId, location: location });

      const SYSTEM_INSTRUCTION = `
      You are MemoryMate. User: ${userName}.
      1. Briefly greet the user.
      2. Listen to the audio and watch the video stream continuously.
      3. If the user asks a question, answer it.
      4. If you see a reference photo match in the video, mention the Date/Description.
      `;

      const session = await ai.live.connect({
        model: model,
        config: {
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } }
          }
        }
      });

      console.log("🟢 Connected to Gemini Live API");

      // 3. Receive Loop (Listening to AI)
      (async () => {
        try {
          for await (const message of session.receive()) {
            if (message.serverContent?.interrupted && ws.readyState === WebSocket.OPEN) {
              console.log("⚡ AI Interrupted by User Voice");
              ws.send(JSON.stringify({ type: "interrupted" }));
            }

            const turn = message.serverContent?.modelTurn;
            if (turn?.parts) {
              for (const part of turn.parts) {
                if (part.inlineData?.data && ws.readyState === WebSocket.OPEN) {
                  // Forward Audio
                  ws.send(JSON.stringify({
                    type: "audioResponse",
                    audioBase64: part.inlineData.data,
                    description: part.text || "" 
                  }));
                } else if (part.text && ws.readyState === WebSocket.OPEN) {
                  // Forward Text
                  ws.send(JSON.stringify({ type: "audioResponse", description: part.text }));
                }
              }
            }
          }
        } catch (err) {
          console.error("🔴 Gemini Receive Error:", err);
        }
      })();

      // 4. Send Initial Context
      const initialParts = referencePhotos.flatMap(photo => [
        { text: `Memory: ${photo.description} on ${photo.date}` },
        { inlineData: { mimeType: photo.mimeType, data: photo.data } }
      ]);
      initialParts.push({ text: `Hello, I am ${userName}.` });

      await session.send({
        clientContent: {
          turns: [{ role: "user", parts: initialParts }],
          turnComplete: true 
        }
      });
      console.log("✅ Initial Context Sent. Waiting for Real-time Input...");

      // 5. Forward Audio/Video (WITH DEBUG LOGS)
      let audioChunksCount = 0;
      
      ws.on('message', async (msg) => {
        const data = JSON.parse(msg);
        
        if (data.type === "frame") {
          // Send Video Frame
          await session.send({
            realtimeInput: { mediaChunks: [{ mimeType: "image/jpeg", data: data.frameBase64 }] }
          });
        } 
        else if (data.type === "audio") {
          // Send Audio Chunk
          audioChunksCount++;
          if (audioChunksCount % 50 === 0) {
             console.log(`🎤 Streaming Audio... (${audioChunksCount} chunks sent)`);
          }
          
          await session.send({
            realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: data.audioBase64 }] }
          });
        }
      });

      ws.on('close', () => console.log("❌ Client WS closed."));

    } catch (error) {
      console.error("🔥 Critical Setup Error:", error);
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Server Error");
    }
  });
}
