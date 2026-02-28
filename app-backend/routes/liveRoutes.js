import express from 'express';
import WebSocket from 'ws'; // For connecting to Gemini
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import jwt from 'jsonwebtoken';
import { GoogleAuth } from "google-auth-library";

// EXPORT A FUNCTION that accepts the patched 'app'
export default function (app) {
    // const router = express.Router();
    
    const db = new Firestore({ projectId: process.env.GCP_PROJECT_ID });
    const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
    
    const bucketName = process.env.GCS_BUCKET_NAME;
    if (!bucketName) {
        console.error("🚨 CRITICAL ERROR: GCS_BUCKET_NAME environment variable is missing.");
        process.exit(1); 
    }
    const bucket = storage.bucket(bucketName);
    
    //const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const GEMINI_API_KEY = "AQ.Ab8RN6KgmxUrnSuRdCeaaDMZmIf7oxSiW_UI-4S5n1Fp1BX3qg"

    const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
    const client = await auth.getClient();
     const token = await client.getAccessToken();
    
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

    // Now router.ws WILL work!
    app.ws('/api/live/ws/live/process-stream', async (ws, req) => {
        //const userId = req.query.userId;
        const token = req.query.token;
        //if (!userId) {
        if (!token) {
            ws.close(1008, "token required");
            return;
        }

        let userId;
        try {
          // Verify and decode the token
          // Make sure process.env.JWT_SECRET matches what you used to sign the token!
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          
          // Extract the userId. 
          userId = decoded.userId; 
          console.log(`🟢 2. JWT Verified for User: ${userId}`);  
          
        } catch (error) {
          console.error('JWT Verification Error:', error.message);
          ws.close(1008, "Invalid or expired token");
          return;
        }

        try {
            console.log("⏳ 3. Fetching photos from Firestore/GCS...");
            const photosSnapshot = await db.collection('users').doc(userId).collection('photos').get();
            const referencePhotos = [];
             
            for (const doc of photosSnapshot.docs) {
                const photoData = doc.data();
                if (photoData.filename) {
                    const
 base64Image = await getGcsFileAsBase64(photoData.filename);
                    referencePhotos.push({
                        description: photoData.description || "No description provided",
                        mimeType: "image/jpeg",
                        data: base64Image
                    });
                }
            }
            
            console.log(`✅ 4. Loaded ${referencePhotos.length} reference photos.`);

            console.log("⏳ 5. Connecting to Gemini Live API...");
      
            // Fixed missing backticks around the URL string
            //const geminiWsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
            const geminiWsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
            
            const geminiWs = new WebSocket(geminiWsUrl,{
                                            headers: {
                                              Authorization: `Bearer ${token.token}`,
                                            },
                                          });

            // --- NEW: GEMINI ERROR AND CLOSE HANDLERS ---
              geminiWs.on('error', (err) => {
                console.error("❌ GEMINI WEBSOCKET ERROR:", err.message || err);
              });
        
              geminiWs.on('close', (code, reason) => {
                console.log(`⚠️ Gemini WS Closed. Code: ${code}, Reason: ${reason}`);
              });

            geminiWs.on('open', () => {
                console.log(`✅ 6. Connected to Gemini Live for User: ${userId}`);
                console.log(`Connected to Gemini Live for User: ${userId}`);

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
                let generatedText = '';
                let generatedAudioBase64 = '';
                if (response.serverContent?.modelTurn) {
                    /*const parts = response.serverContent.modelTurn.parts;
                    for (const part of parts) {
                        if (part.inlineData && part.inlineData.data) {
                            ws.send(JSON.stringify({
                                type: "audio",
                                audioBase64: part.inlineData.data
                            }));
                        }
                    }*/
                    const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                  // Assuming Gemini can send both descriptive text and audio data
                  if (part.text) { // Direct text response part
                    generatedText += part.text;
                  }
                  if (part.inlineData && part.inlineData.data) { // Audio data part
                    generatedAudioBase64 = part.inlineData.data;
                  }
                }

                // Send both parts back to the frontend in a single message
                if (generatedText || generatedAudioBase64) {
                  ws.send(JSON.stringify({
                    type: "audioResponse", // A type for the frontend to recognize
                    description: generatedText,
                    audioBase64: generatedAudioBase64
                  }));
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

    // return router;
}
