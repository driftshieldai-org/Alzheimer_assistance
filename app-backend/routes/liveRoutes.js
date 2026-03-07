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
      // 1. Fetch User & Photos
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

      // 2. Configure Gemini
      const projectId = process.env.GCP_PROJECT_ID;
      const location = process.env.GCP_REGION || "us-central1";
      const model = "gemini-live-2.5-flash-native-audio"; 

      const ai = new GoogleGenAI({ vertexai: true, project: projectId, location: location });

      const SYSTEM_INSTRUCTION = `
      You are MemoryMate. User: ${userName}.
      1. Greet the user warmly.
      2. Listen to the user's voice and watch the video stream.
      3. If you see a photo match, mention the Date/Description.
      `;

      // 3. Connect WITH CALLBACKS (Fixes the "undefined" crash)
      const session = await ai.live.connect({
        model: model,
        config: {
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } }
        },
        callbacks: {
          onopen: () => {
            console.log("🟢 Connected to Gemini Live API");
          },
          onmessage: (message) => {
            // Handle Interruption
            if (message.serverContent?.interrupted && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "interrupted" }));
            }

            // Handle Audio/Text
            const turn = message.serverContent?.modelTurn;
            if (turn?.parts) {
              for (const part of turn.parts) {
                if (part.inlineData?.data && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: "audioResponse",
                    audioBase64: part.inlineData.data,
                    description: part.text || ""
                  }));
                } else if (part.text && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "audioResponse", description: part.text }));
                }
              }
            }
          },
          onclose: () => {
            console.log("🔴 Gemini Connection Closed");
            if (ws.readyState === WebSocket.OPEN) ws.close();
          },
          onerror: (err) => {
            console.error("Gemini Error:", err);
            if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Gemini Error");
          }
        }
      });

      // 4. Send Context (Fixes the Silence)
      const initialParts = referencePhotos.flatMap(photo => [
        { text: `Memory: ${photo.description} on ${photo.date}` },
        { inlineData: { mimeType: photo.mimeType, data: photo.data } }
      ]);
      initialParts.push({ text: `Hello, I am ${userName}.` });

      // ✅ turnComplete: true is crucial here
      await session.sendClientContent({
        turns: [{ role: "user", parts: initialParts }],
        turnComplete: true 
      });

      console.log("✅ Context sent. Mode switched to: LISTENING.");

      let debugAudioCounter = 0;
      
      // 5. Forward Stream (Uses your working methods)
      ws.on('message', async (msg) => {
        try {
        const data = JSON.parse(msg);

        if (data.type === "frame") {
          await session.sendRealtimeInput([{
            mimeType: "image/jpeg",
            data: data.frameBase64
          }]);
        } 
        else if (data.type === "audio") {
          debugAudioCounter++;
          if (debugAudioCounter % 50 === 0) {
            console.log(`🎤 Audio Active: Received ${debugAudioCounter} chunks`);
          }
          await session.sendRealtimeInput([{
            mimeType: "audio/pcm;rate=16000",
            data: data.audioBase64
          }]);
        }
          } catch (err) {
          console.error("⚠️ Stream Error:", err.message);
        }
      });

      ws.on('close', () => console.log("Client WS closed."));

    } catch (error) {
      console.error("Setup Error:", error);
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Server Error");
    }
  });
}
