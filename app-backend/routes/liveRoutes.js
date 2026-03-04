import express from 'express';
import WebSocket from 'ws';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import jwt from 'jsonwebtoken';
import { GoogleGenAI } from '@google/genai'; 
import { GoogleAuth } from 'google-auth-library';

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
      console.log("Fetching User Data and reference photos...");
      
      // Fetch user's actual name to personalize the greeting
      const userDoc = await db.collection('users').doc(userId).get();
      const userName = userDoc.exists ? (userDoc.data().name || userId) : userId;

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
            photoDate: photoData.photoDate || "an unknown date",
            mimeType: "image/jpeg",
            data: base64Image
          });
        }
      }

      console.log(`Loaded ${referencePhotos.length} reference photos for ${userName}`);

      const projectId = process.env.GCP_PROJECT_ID;
      const location = process.env.GCP_REGION || "us-central1";
      // Ensure model supports multimodal real-time stream
      const model = "gemini-2.0-flash-exp"; 

      console.log(`projectid: ${} location: ${}`);
      
      const ai = new GoogleGenAI({
        vertexai: true,     
        project: projectId, 
        location: location  
      });

      // System Instructions tailored to dynamically mention User's Name and rules for places/people
      const SYSTEM_INSTRUCTION = `
You are MemoryMate, a polite, helpful AI assistant with a soft, calming tone.
You are assisting a user named ${userName}. Start the conversation by warmly greeting ${userName} by name!
You will receive reference photos of the user's memories (people and places) along with a real-time continuous video and audio stream.

Your tasks:
1. Listen closely to the user's spoken audio and respond conversationally and naturally.
2. Continuously observe the live video stream. Identify if the scene contains a PERSON or a PLACE.
3. Match against the provided reference photos:
   - If a person or place MATCHES a reference photo, politely inform the user.
   - Crucially, you MUST mention the DATE and DESCRIPTION stored with the photo. For example: "You might have visited this place on [Date]" or "You have met with [Description] on [Date]."
4. If it's a NEW scene (does NOT match reference photos):
   - First, check if it matches a famous world landmark or well-known place. If yes, respond accordingly with a friendly detail.
   - If it is NOT a famous place, analyze the background and describe the environment contextually (e.g., "It looks like you are in your kitchen", "You seem to be in a bedroom").
5. Keep your responses concise, conversational, and ONLY respond using spoken voice.
`;

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
                // Forward Audio back to the client
                if (part.inlineData?.data) {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                      type: "audio",
                      audioBase64: part.inlineData.data
                    }));
                  }
                }
                
                // (Optional) Transcripts logging
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
            console.log(`🔴 Gemini WS Closed. Code: ${e.code}, Reason: ${e.reason || "None"}`);
            if (ws.readyState === WebSocket.OPEN) {
              ws.close();
            }
          }
        }
      });

      await waitForSetup;
      
      // ---------------------------
      // SEND REFERENCE PHOTOS AND START GREETING
      // ---------------------------
      if (referencePhotos.length > 0) {
        console.log("Sending reference photos to Gemini...");
         
        const parts = [
          { text: "Here are reference photos of the user's memories. Pay close attention to their appearance, descriptions, and dates. I am now starting the live video and audio stream. Please greet me!" }
        ];
         
        referencePhotos.forEach(photo => {
          // Injecting the date with the description so the model has the exact context
          parts.push({ text: `Reference photo - Date: ${photo.photoDate}, Description: ${photo.description}` });
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
          turns: [{ role: "user", parts: [{ text: "Hello, I am ready. Please greet me!" }] }],
          turnComplete: true
        });
      }
      
      // ---------------------------
      // CONTINUOUSLY STREAM AUDIO & VIDEO
      // ---------------------------
      ws.on('message', (msg) => {
        const data = JSON.parse(msg);

        // Instantly relay high-frequency frames to Gemini API
        if (data.type === "frame") {
          session.sendRealtimeInput([{
            mimeType: "image/jpeg",
            data: data.frameBase64
          }]);
        } 
        // Instantly relay audio chunks to Gemini API
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
