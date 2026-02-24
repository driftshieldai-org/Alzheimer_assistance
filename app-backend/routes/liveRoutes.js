import express from 'express';
import expressWs from 'express-ws';
import WebSocket from 'ws'; // For connecting to Gemini
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';

const router = express.Router();
const db = new Firestore({ projectId: process.env.GCP_PROJECT_ID });
const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
const bucket = storage.bucket(process.env.GCS_BUCKET_NAME);

// Ensure your GEMINI_API_KEY is in your .env / Cloud Run environment variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

const SYSTEM_INSTRUCTION = `
You are a polite, helpful AI assistant with a soft, calming tone.
You will be provided with reference photos of a user and their descriptions. 
As I stream live video to you, continuously observe the person in the live stream.
1. If the live stream MATCHES a reference photo, warmly greet them and politely state their description.
2. If the live stream DOES NOT MATCH, politely analyze the scene and provide a soft-spoken explanation of the background.
3. Keep your answers concise and respond exclusively using VOICE.
`;

// Helper: Get image from GCS directly as Base64 (No Signed URLs needed!)
async function getGcsFileAsBase64(filename) {
    const [fileContent] = await bucket.file(filename).download();
    return fileContent.toString('base64');
}

// ----------------------------------------------------------------------
// NEW WEBSOCKET ROUTE: Replaces the old POST '/process-frame'
// ----------------------------------------------------------------------
router.ws('/stream', async (ws, req) => {
    // 1. Get user ID from the connection URL (e.g., wss://your-app.com/stream?userId=123)
    const userId = req.query.userId;
    if (!userId) {
        ws.close(1008, "userId required");
        return;
    }

    try {
        // 2. Fetch User Metadata and Photos from Firestore & GCS
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

        // 3. Open WebSocket Connection directly to the Gemini 2.0 Flash Live API
        const geminiWsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
        const geminiWs = new WebSocket(geminiWsUrl);

        geminiWs.on('open', () => {
            console.log(`Connected to Gemini Live for User: ${userId}`);

            // A. Send the Setup Configuration (Instructions & Voice)
            geminiWs.send(JSON.stringify({
                setup: {
                    model: "models/gemini-2.0-flash",
                    systemInstruction: {
                        parts: [{ text: SYSTEM_INSTRUCTION }]
                    },
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } // Soft Voice
                        }
                    }
                }
            }));

            // B. Send the Reference Photos to Gemini's Memory Immediately
            referencePhotos.forEach(photo => {
                geminiWs.send(JSON.stringify({
                    clientContent: {
                        turns: [{
                            role: "user",
                            parts: [
                                { text: `Reference Person Description: ${photo.description}` },
                                { inlineData: { mimeType: photo.mimeType, data: photo.data } }
                            ]
                        }],
                        turnComplete: true
                    }
                }));
            });
        });

        // 4. Handle incoming Webcam frames from your Frontend browser
        ws.on('message', (msg) => {
            const data = JSON.parse(msg);
            
            // Expected frontend payload: { type: "frame", frameBase64: "..." }
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

        // 5. Handle incoming Audio Responses from Gemini and send to Frontend
        geminiWs.on('message', (data) => {
            const response = JSON.parse(data);
            
            if (response.serverContent?.modelTurn) {
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.inlineData && part.inlineData.data) {
                        // Forward the base64 PCM audio chunk to the browser to play
                        ws.send(JSON.stringify({
                            type: "audio",
                            audioBase64: part.inlineData.data
                        }));
                    }
                }
            }
        });

        // 6. Cleanup connections when the user leaves the page
        ws.on('close', () => geminiWs.close());
        geminiWs.on('close', () => ws.close());

    } catch (error) {
        console.error('Live Stream Error:', error);
        ws.close(1011, "Server Error");
    }
});

export default router;
