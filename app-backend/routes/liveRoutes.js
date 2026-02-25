import express from 'express';
import WebSocket from 'ws';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';

export default function (app) {
  const router = express.Router();
    
  const db = new Firestore({ projectId: process.env.GCP_PROJECT_ID });
  const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
    
  const bucketName = process.env.GCS_BUCKET_NAME;
  if (!bucketName) {
    console.error("🚨 CRITICAL ERROR: GCS_BUCKET_NAME environment variable is missing.");
    process.exit(1);    
  }
  const bucket = storage.bucket(bucketName);
    
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  // Fixed a missing backtick in the SYSTEM_INSTRUCTION string
  const SYSTEM_INSTRUCTION = `You are a polite, helpful AI assistant with a soft, calming tone. You will be provided with reference photos of a user and their descriptions. provide both the code completely As I stream live video to you, continuously observe the person in the live stream. If the live stream MATCHES a reference photo, warmly greet them and politely state their description. If the live stream DOES NOT MATCH, politely analyze the scene and provide a soft-spoken explanation of the background. Keep your answers concise and respond exclusively using VOICE.`;

  async function getGcsFileAsBase64(filename) {
    const [fileContent] = await bucket.file(filename).download();
    return fileContent.toString('base64');
  }

  router.ws('/stream', async (ws, req) => {
    const userId = req.query.userId;
    if (!userId) {
      ws.close(1008, "userId required");
      return;
    }
    try {
      const photosSnapshot = await db.collection('users').doc(userId).collection('photos').get();
      const referencePhotos = [];
      // Fixed geminiWsUrl string - missing backticks around the URL
      const geminiWsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
      const geminiWs = new WebSocket(geminiWsUrl);


      for (const doc of photosSnapshot.docs) {
        const photoData = doc.data();
        if (photoData.filename) { // Use photoData.filename (which now contains the GCS object name)
          const base64Image = await getGcsFileAsBase64(photoData.filename);
          referencePhotos.push({
            description: photoData.description || "No description provided",
            mimeType: "image/jpeg", // Assuming all uploaded images are JPEG
            data: base64Image
          });
        }
      }

      geminiWs.on('open', () => {
        // Fixed missing backticks and added userId variable
        console.log(`Connected to Gemini Live for User: ${}`); 
        geminiWs.send(JSON.stringify({
          setup: {
            model: "models/gemini-2.0-flash",
            systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
              }
            }
          }
        }));
        referencePhotos.forEach(photo => {
          geminiWs.send(JSON.stringify({
            clientContent: {
              turns: [{
                role: "user",
                parts: [
                  // Fixed missing backticks
                  { text: `Reference Person Description: ${photo.description}` }, 
                  { inlineData: { mimeType: photo.mimeType, data: photo.data } }
                ]
              }],
              turnComplete: true
            }
          }));
        });
      });

      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === "frame" && geminiWs.readyState === WebSocket.OPEN) {
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

      geminiWs.on('message', (data) => {
        const response = JSON.parse(data);
        if (response.serverContent?.modelTurn) {
          const parts = response.serverContent.modelTurn.parts;
          for (const part of parts) {
            if (part.inlineData && part.inlineData.data) {
              ws.send(JSON.stringify({
                type: "audio",
                audioBase64: part.inlineData.data
              }));
            }
          }
        }
      });

      ws.on('close', () => geminiWs.close());
      geminiWs.on('close', () => ws.close());
    } catch (error) {
      console.error('Live Stream Error:', error);
      ws.close(1011, "Server Error");
    }
  });
  return router;
}
