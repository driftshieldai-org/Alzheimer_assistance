import express from 'express';
import WebSocket from 'ws';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import jwt from 'jsonwebtoken';
import { GoogleAuth } from "google-auth-library";

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

      // ---------------------------
      // AUTH FOR VERTEX AI
      // ---------------------------
      const auth = new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });

      const client = await auth.getClient();
      const accessTokenResponse = await client.getAccessToken();
      const accessToken = accessTokenResponse.token;

      const projectId = process.env.GCP_PROJECT_ID;
      const location = process.env.GCP_REGION || "us-central1";

      console.log(`projectid: ${projectId}`);
      console.log(`location: ${location}`);
      

      const geminiWsUrl =
        `wss://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:streamGenerateContent?alt=ws`;

      const geminiWs = new WebSocket(geminiWsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      });

      geminiWs.on('open', () => {
        console.log("Connected to Gemini Live API");

        // ---------------------------
        // SETUP MESSAGE (Required First Message)
        // ---------------------------
        geminiWs.send(JSON.stringify({
          setup: {
            model: `projects/${projectId}/locations/${location}/publishers/google/models/gemini-2.5-flash-live-preview`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: "Aoede" }
                }
              }
            },
            systemInstruction: {
              parts: [{ text: SYSTEM_INSTRUCTION }]
            }
          }
        }));

        // ---------------------------
        // SEND REFERENCE PHOTOS
        // ---------------------------
        referencePhotos.forEach(photo => {
          geminiWs.send(JSON.stringify({
            clientContent: {
              turns: [{
                role: "user",
                parts: [
                  { text: `Reference person: ${photo.description}` },
                  {
                    inlineData: {
                      mimeType: photo.mimeType,
                      data: photo.data
                    }
                  }
                ]
              }],
              turnComplete: true
            }
          }));
        });
      });

      // ---------------------------
      // STREAM VIDEO FRAMES
      // ---------------------------
      ws.on('message', (msg) => {
        const data = JSON.parse(msg);

        if (data.type === "frame" &&
            geminiWs.readyState === WebSocket.OPEN) {

          geminiWs.send(JSON.stringify({
            realtimeInput: {
              mediaChunks: [{
                mimeType: "image/jpeg",
                data: data.frameBase64
              }]
            }
          }));
        }
      });

      // ---------------------------
      // HANDLE GEMINI RESPONSES
      // ---------------------------
      geminiWs.on('message', (message) => {
        const response = JSON.parse(message);

        if (response.serverContent?.modelTurn?.parts) {
          for (const part of response.serverContent.modelTurn.parts) {

            // Audio response
            if (part.inlineData?.data) {
              ws.send(JSON.stringify({
                type: "audio",
                audioBase64: part.inlineData.data
              }));
            }

            // (Optional) Debug text if model returns any
            if (part.text) {
              console.log("Model text:", part.text);
            }
          }
        }
      });

      geminiWs.on('error', (err) => {
        console.error("Gemini WS Error:", err);
      });

      ws.on('close', () => geminiWs.close());
      geminiWs.on('close', () => ws.close());

    } catch (error) {
      console.error("Live Stream Error:", error);
      ws.close(1011, "Server error");
    }
  });
}
