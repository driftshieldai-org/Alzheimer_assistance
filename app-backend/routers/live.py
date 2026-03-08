import os
import asyncio
import base64
import traceback
from io import BytesIO

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types
from google.cloud import firestore
from google.cloud import storage
import jose.jwt as jwt
from PIL import Image

router = APIRouter()

PROJECT_ID = os.environ.get("GCP_PROJECT_ID")
LOCATION = os.environ.get("GCP_REGION", "us-central1")
BUCKET_NAME = os.environ.get("GCS_BUCKET_NAME")
JWT_SECRET = os.environ.get("JWT_SECRET", "fallback_secret_for_dev")

# Clients
db = firestore.Client(project=PROJECT_ID)
storage_client = storage.Client(project=PROJECT_ID)
bucket = storage_client.bucket(BUCKET_NAME)

client = genai.Client(
    vertexai=True,
    project=PROJECT_ID,
    location=LOCATION
)


@router.websocket("/api/live/ws/live/process-stream")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🔌 Client connected to Live Stream")

    try:
        # 1️⃣ Validate JWT Token
        token = websocket.query_params.get("token")
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            user_id = payload.get("userId")
        except Exception as e:
            print(f"❌ Token Error: {e}")
            await websocket.close(code=1008)
            return

        # 2️⃣ Load User Info
        user_name = user_id
        user_doc = db.collection("users").document(user_id).get()
        if user_doc.exists:
            user_name = user_doc.to_dict().get("name", user_id)

        # 3️⃣ Load memories as context text
        memories_context = []
        photos_ref = db.collection("users").document(user_id).collection("photos").stream()
        for doc in photos_ref:
            data = doc.to_dict()
            if "description" in data:
                description = data.get("description", "Unknown memory")
                date = data.get("photoDate", "Unknown date")
                memories_context.append(f"- {description} (Date: {date})")
        
        memories_text = "\n".join(memories_context) if memories_context else "No memories stored yet."

        # 4️⃣ System Instruction
        system_instruction = f"""You are MemoryMate, a caring AI assistant helping people with memory.

User name: {user_name}

User's stored memories:
{memories_text}

Instructions:
1. Greet the user warmly by name.
2. Listen to their voice and respond naturally.
3. When they show you something via camera, describe what you see.
4. If what they show matches a stored memory, remind them about it kindly.
5. Speak clearly, slowly, and with compassion.
6. Keep responses concise and helpful.
"""

        # 5️⃣ Gemini Live Config - Audio only model
        MODEL_ID = "gemini-2.0-flash-live-001"
        
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name="Aoede"
                    )
                )
            ),
            system_instruction=types.Content(
                parts=[types.Part(text=system_instruction)]
            )
        )

        # 6️⃣ Connect to Gemini Live
        async with client.aio.live.connect(model=MODEL_ID, config=config) as session:
            print("🟢 Connected to Gemini Live")

            # Send initial greeting prompt
            await session.send_client_content(
                turns=[
                    types.Content(
                        role="user",
                        parts=[types.Part(text=f"Hello! I am {user_name}. Please greet me warmly.")]
                    )
                ],
                turn_complete=True
            )
            print("✅ Initial greeting sent")

            # Flag to track if we're ready for realtime input
            ready_for_realtime = asyncio.Event()

            # 7️⃣ Receive Responses From Gemini
            async def receive_loop():
                try:
                    async for response in session.receive():
                        # Handle server content
                        if response.server_content:
                            server_content = response.server_content
                            
                            # Check for interruption
                            if server_content.interrupted:
                                await websocket.send_json({"type": "interrupted"})
                                continue
                            
                            # Process model turn
                            if server_content.model_turn:
                                for part in server_content.model_turn.parts:
                                    # Audio response
                                    if part.inline_data:
                                        audio_bytes = part.inline_data.data
                                        b64_audio = base64.b64encode(audio_bytes).decode("utf-8")
                                        await websocket.send_json({
                                            "type": "audioResponse",
                                            "audioBase64": b64_audio
                                        })
                                    # Text response (if any)
                                    if part.text:
                                        await websocket.send_json({
                                            "type": "textResponse",
                                            "text": part.text
                                        })
                            
                            # Turn complete - ready for more input
                            if server_content.turn_complete:
                                ready_for_realtime.set()
                                print("✅ Turn complete, ready for realtime input")
                        
                        # Handle setup complete
                        if response.setup_complete:
                            print("✅ Setup complete")
                            
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"❌ Receive Loop Error: {e}")
                    traceback.print_exc()

            receive_task = asyncio.create_task(receive_loop())

            # Wait for initial response to complete
            try:
                await asyncio.wait_for(ready_for_realtime.wait(), timeout=30.0)
            except asyncio.TimeoutError:
                print("⚠️ Timeout waiting for initial response")

            # 8️⃣ Process incoming audio/video from client
            print("🎤 Ready to receive realtime audio/video")
            
            try:
                while True:
                    data = await websocket.receive_json()

                    # Process audio chunks
                    if data["type"] == "audio":
                        try:
                            audio_bytes = base64.b64decode(data["audioBase64"])
                            
                            # Send audio using realtime input
                            await session.send_realtime_input(
                                media=types.Blob(
                                    data=audio_bytes,
                                    mime_type="audio/pcm;rate=16000"
                                )
                            )
                        except Exception as e:
                            print(f"⚠️ Failed to send audio chunk: {e}")

                    # Process video frames
                    elif data["type"] == "frame":
                        try:
                            frame_bytes = base64.b64decode(data["frameBase64"])
                            
                            # Send video frame using realtime input
                            await session.send_realtime_input(
                                media=types.Blob(
                                    data=frame_bytes,
                                    mime_type="image/jpeg"
                                )
                            )
                        except Exception as e:
                            print(f"⚠️ Failed to send video frame: {e}")

            except WebSocketDisconnect:
                print("🔌 Client disconnected")
            finally:
                receive_task.cancel()

    except Exception as e:
        print(f"🔥 CRITICAL WEBSOCKET CRASH: {e}")
        traceback.print_exc()
        try:
            await websocket.close(code=1011)
        except:
            pass
