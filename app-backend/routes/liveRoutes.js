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
      3. Match against the provided reference photos. If matched, mention the DATE and DESCRIPTION.
      4. If it's a NEW scene, describe the environment contextually.
      5. Keep your responses conversational, short, and natural.
      `;

      const projectId = process.env.GCP_PROJECT_ID;
      const location = process.env.GCP_REGION || "us-central1";
      
      // Use the standard Live API model name based on current availability
      const model = "gemini-live-2.5-flash-native-audio"; 
      const ai = new GoogleGenAI({ vertexai: true, project: projectId, location: location });
      
      const session = await ai.live.connect({
        model: model, 
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }
        }
      });

      console.log("🟢 Connected to Gemini Live API");

      // Handle receiving messages from Gemini concurrently
      (async () => {
        try {
          for await (const message of session.receive()) {
            // Forward AI interruption (User started speaking)
            if (message.serverContent?.interrupted && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "interrupted" }));
            }

            // Forward generated audio/text to frontend
            if (message.serverContent?.modelTurn?.parts) {
              let textChunk = '';
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.text) { textChunk += part.text; }
                
                // Send audio chunks individually to avoid overwriting them
                if (part.inlineData?.data && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: "audioResponse",
                    description: textChunk,
                    audioBase64: part.inlineData.data
                  }));
                  textChunk = ''; // Clear text so it's not sent multiple times
                }
              }

              // Send leftover text if there was no audio inline
              if (textChunk && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "audioResponse", description: textChunk }));
              }
            }
          }
        } catch (err) {
          console.error("🔴 Gemini Receive Loop Error:", err);
        }
      })();

      // Send Initial Context explicitly with turnComplete: true
      const initialParts = referencePhotos.flatMap(photo => [
        { text: `Memory - Description: ${photo.description}, Date: ${photo.date}` },
        { inlineData: { mimeType: photo.mimeType, data: photo.data } }
      ]);
      initialParts.push({ text: `Hello, my name is ${userName}. These are my memories. Acknowledge briefly and let's begin.` });

      await session.send({
        clientContent: {
          turns: [{ role: "user", parts: initialParts }],
          turnComplete: true // CRITICAL: Complete the turn so Gemini responds and opens up the mic stream!
        }
      });

      // Forward WebSocket Real-time Audio/Video from React to Gemini
      ws.on('message', async (msg) => {
        const data = JSON.parse(msg);

        if (data.type === "frame") {
          await session.send({
            realtimeInput: { mediaChunks: [{ mimeType: "image/jpeg", data: data.frameBase64 }] }
          });
        } 
        else if (data.type === "audio") {
          await session.send({
            realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: data.audioBase64 }] }
          });
        }
        // Removed `speech_start` and `end_of_turn` handlers:
        // Gemini handles voice activity natively over realtimeInput!
      });

      ws.on('close', () => {
        console.log("Client WS closed connection.");
      });

    } catch (error) {
      console.error("Live Stream Error:", error);
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Server error");
    }
  });
}
