import express from 'express';
import WebSocket from 'ws';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import jwt from 'jsonwebtoken';
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
      // 1. Fetch User Data to get User Name
      let userName = userId;
      const userDoc = await db.collection('users').doc(userId).get();
      if (userDoc.exists) {
        userName = userDoc.data().name || userId;
      }

      console.log(`Fetching reference photos for ${userName}...`);
      
      // 2. Fetch User Photos with Dates
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
            date: photoData.photoDate || "an unknown date",
            mimeType: "image/jpeg",
            data: base64Image
          });
        }
      }
      console.log(`Loaded ${referencePhotos.length} reference photos`);

      // 3. System Instruction tuned to handle dates, people, famous places, and general background
      const SYSTEM_INSTRUCTION = `
        You are a polite, helpful AI assistant named MemoryMate with a soft, calming tone.
        The user's name is ${userName}. Always greet them warmly by their name when the session starts.
        You have been given reference photos of the user's memories (people and places) along with the dates they occurred.
        
        Your instructions while continuously observing the live video stream and listening to audio:
        1. SAVED MEMORIES: If the live stream MATCHES a reference photo (person or place), warmly mention it and tell them the specific date. For example: "It looks like you are at [place]. You might have visited this place on [Date]." or "Ah, that is [Person], you met with them on [Date]."
        2. FAMOUS PLACES: If it does NOT match a saved memory, try to identify if the video shows a famous landmark or place globally. If it does, provide an interesting fact about it.
        3. GENERAL BACKGROUND: If it is not a saved memory and not a famous place, observe the immediate background and describe it naturally (e.g., "It looks like you are resting in your bedroom" or "I see you are in the kitchen").
        
        Respond ONLY using spoken voice. Keep responses concise, warm, and highly conversational. Answer naturally to any audio questions they ask.
      `;

      const projectId = process.env.GCP_PROJECT_ID;
      const location = process.env.GCP_REGION || "us-central1";
      const model = "gemini-live-2.5-flash-native-audio";

      console.log(`projectId: ${projectId} location: ${location}`);

      const ai = new GoogleGenAI({
        vertexai: true,
        project: projectId,
        location: location
      });

      let resolveSetupComplete;
      const waitForSetup = new Promise((resolve) => {
        resolveSetupComplete = resolve;
      });

      const session = await ai.live.connect({
        model: model,
        config: {
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
            if (message.setupComplete) {
              console.log("✅ Gemini Live API Setup Complete!");
              resolveSetupComplete(); 
              return;
            }

            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                // Forward Audio back to client
                if (part.inlineData?.data) {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                      type: "audio",
                      audioBase64: part.inlineData.data
                    }));
                  }
                }
                if (part.text) {
                  console.log("Model spoke:", part.text);
                }
              }
            }
          },
          onerror: (err) => {
            console.error("Gemini Live API Error:", err);
          },
          onclose: (e) => {
            console.log(`🔴 Gemini WS Closed. Code: ${e.code}`);
            if (ws.readyState === WebSocket.OPEN) {
              ws.close();
            }
          }
        }
      });

      await waitForSetup;

      // 4. Send Photos + Dates as Context
      if (referencePhotos.length > 0) {
        console.log("Sending reference photos to Gemini...");
        
        const parts = [
          { text: `Here are reference photos of the user's memories. Pay close attention to their descriptions and dates. I am now starting the live stream. Please greet me by my name (${userName})!` }
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
