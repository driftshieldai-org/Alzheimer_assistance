import express from 'express';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import jwt from 'jsonwebtoken';
import { GoogleGenAI, Modality } from '@google/genai';

// EXPORT A FUNCTION that accepts the patched 'app'
export default function (app) {

  const db = new Firestore({ projectId: process.env.GCP_PROJECT_ID });
  const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });

  const bucketName = process.env.GCS_BUCKET_NAME;
  if (!bucketName) {
    console.error("🚨 CRITICAL ERROR: GCS_BUCKET_NAME environment variable is missing.");
    process.exit(1);
  }
  const bucket = storage.bucket(bucketName);

  const SYSTEM_INSTRUCTION = `
You are a polite, helpful AI assistant with a soft, calming tone.
You will be provided with reference photos of a user and their descriptions. 
As I stream live video to you, continuously observe the person in the live stream.
If the live stream MATCHES a reference photo, warmly greet them and politely state their description.
If the live stream DOES NOT MATCH, politely analyze the scene and provide a soft-spoken explanation of the background.
Keep your answers concise and respond exclusively using VOICE.
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
    } catch (error) {
      console.error('JWT Verification Error:', error.message);
      ws.close(1008, "Invalid or expired token");
      return;
    }

    try {
      // Fetch reference photos
      const photosSnapshot = await db.collection('users').doc(userId).collection('photos').get();
      const referencePhotos = [];

      for (const doc of photosSnapshot.docs) {
        const photoData = doc.data();
        if (photoData.filename) {
          const base64Image = await getGcsFileAsBase64(photoData.filename);
          referencePhotos.push({
            description: photoData.description || "No description provided",
            mimeType: "image/jpeg",
            data: base64Image
          });
        }
      }

      console.log(`✅ Loaded ${referencePhotos.length} reference photos.`);

      // Create AI client token
      const client = new GoogleGenAI({
                  vertexai: true,
                  project: "aipartnercatalyst-confluent-01",
                  location: "us-central1",
                });
      const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      
      const token = await client.authTokens.create({
          config: {
              uses: 1, // The default
              expireTime: expireTime,
              liveConnectConstraints: {
                  model: 'gemini-2.5-flash-native-audio-preview-12-2025',
                  config: {
                      sessionResumption: {},
                      temperature: 0.7,
                      responseModalities: ['AUDIO']
                  }
              },
              httpOptions: {
                  apiVersion: 'v1alpha'
              }
          }
      });    

      console.log(`✅ Token received: ${token.name}`);
      
      const ai = new GoogleGenAI({
                      apiKey: token.name
                    });
      
      // Connect to Gemini Live API
      const session = await ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
        },
        callbacks: {
          onopen: () => console.log('✅ Connected to Gemini Live API'),
          onmessage: (message) => {
            if (message.serverContent?.modelTurn?.parts) {
              let generatedText = '';
              let generatedAudioBase64 = '';

              for (const part of message.serverContent.modelTurn.parts) {
                if (part.text) generatedText += part.text;
                if (part.inlineData?.data) generatedAudioBase64 = part.inlineData.data;
              }

              ws.send(JSON.stringify({
                type: 'audioResponse',
                description: generatedText,
                audioBase64: generatedAudioBase64
              }));
            }
          },
          onerror: (e) => console.error('Gemini Error:', e.message),
          onclose: (e) => {
            console.log('Gemini session closed:', e?.reason || 'unknown');
            ws.close();
          }
        }
      });

      // Send reference photos to the model
      for (const photo of referencePhotos) {
        await session.sendRealtimeInput({
          media: [{
            mimeType: photo.mimeType,
            data: photo.data
          }],
          text: `Reference Person Description: ${photo.description}`
        });
      }

      // Handle incoming frames from the frontend
      ws.on('message', async (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'frame') {
          await session.sendRealtimeInput({
            media: [{
              mimeType: 'image/jpeg',
              data: data.frameBase64
            }]
          });
        }
      });

      ws.on('close', () => session.close());

    } catch (error) {
      console.error('Live Stream Error:', error);
      ws.close(1011, "Server Error");
    }
  });
}
