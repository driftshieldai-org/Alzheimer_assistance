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

    session_alive = True
    
    try:
        # Validate JWT Token
        token = websocket.query_params.get("token")
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            user_id = payload.get("userId")
        except Exception as e:
            print(f"❌ Token Error: {e}")
            await websocket.close(code=1008)
            return

        # Load User Info
        user_name = user_id
        user_doc = db.collection("users").document(user_id).get()
        if user_doc.exists:
            user_name = user_doc.to_dict().get("name", user_id)

        # Load memories
        memories_context = []
        photos_ref = db.collection("users").document(user_id).collection("photos").stream()
        for doc in photos_ref:
            data = doc.to_dict()
            if "description" in data:
                description = data.get("description", "Unknown memory")
                date = data.get("photoDate", "Unknown date")
                memories_context.append(f"- {description} (Date: {date})")
        
        memories_text = "\n".join(memories_context) if memories_context else "No memories stored yet."

        # System Instruction
        system_instruction = f"""You are MemoryMate, a caring AI assistant.

User name: {user_name}

User's stored memories:
{memories_text}

Instructions:
1. Greet the user warmly by name.
2. Listen and respond naturally to their voice.
3. Describe what you see when they show the camera.
4. Speak clearly and kindly.
"""

        # Gemini Live Config
        MODEL_ID = "gemini-live-2.5-flash-native-audio"
        
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

        async with client.aio.live.connect(model=MODEL_ID, config=config) as session:
            print("🟢 Connected to Gemini Live")

            # Receive loop
            async def receive_loop():
                nonlocal session_alive
                try:
                    async for response in session.receive():
                        if not session_alive:
                            break
                        
                        if response.setup_complete:
                            print("✅ Setup complete")
                            continue
                            
                        if response.server_content:
                            server_content = response.server_content
                            
                            if server_content.interrupted:
                                print("🔇 Interrupted")
                                await websocket.send_json({"type": "interrupted"})
                                continue
                            
                            if server_content.model_turn:
                                for part in server_content.model_turn.parts:
                                    if part.inline_data:
                                        audio_bytes = part.inline_data.data
                                        b64_audio = base64.b64encode(audio_bytes).decode("utf-8")
                                        print(f"🔊 Audio response: {len(audio_bytes)} bytes")
                                        await websocket.send_json({
                                            "type": "audioResponse",
                                            "audioBase64": b64_audio
                                        })
                                    if part.text:
                                        print(f"📝 Text: {part.text[:50]}...")
                                        await websocket.send_json({
                                            "type": "textResponse",
                                            "text": part.text
                                        })
                            
                            if server_content.turn_complete:
                                print("✅ Turn complete")
                                            
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"❌ Receive Error: {e}")
                    session_alive = False

            receive_task = asyncio.create_task(receive_loop())
            await asyncio.sleep(0.2)

            # Send greeting
            await session.send(
                input=f"Hello! I am {user_name}. Please greet me.",
                end_of_turn=True
            )
            print("✅ Initial greeting sent")
            
            # Wait for greeting response before accepting realtime input
            await asyncio.sleep(3)
            print("🎤 Ready for realtime input")

            # Process client input
            audio_chunk_count = 0
            frame_count = 0
            
            try:
                while session_alive:
                    try:
                        data = await asyncio.wait_for(
                            websocket.receive_json(),
                            timeout=2.0
                        )
                    except asyncio.TimeoutError:
                        continue
                    except WebSocketDisconnect:
                        print("🔌 Client disconnected")
                        break

                    if data["type"] == "audio":
                        try:
                            audio_bytes = base64.b64decode(data["audioBase64"])
                            audio_chunk_count += 1
                            
                            if audio_chunk_count % 100 == 0:
                                print(f"🎤 Audio: {audio_chunk_count} chunks")
                            
                            # Method 1: Using dict format
                            await session.send(
                                input={
                                    "data": data["audioBase64"],
                                    "mime_type": "audio/pcm;rate=16000"
                                },
                                end_of_turn=False
                            )
                            
                        except Exception as e:
                            print(f"⚠️ Audio error: {e}")
                            if "closed" in str(e).lower() or "1011" in str(e):
                                session_alive = False
                                break

                    elif data["type"] == "frame":
                        try:
                            frame_count += 1
                            
                            if frame_count % 10 == 0:
                                print(f"📹 Frames: {frame_count}")
                            
                            # Send image using dict format
                            await session.send(
                                input={
                                    "data": data["frameBase64"],
                                    "mime_type": "image/jpeg"
                                },
                                end_of_turn=False
                            )
                            
                        except Exception as e:
                            print(f"⚠️ Frame error: {e}")
                            if "closed" in str(e).lower() or "1011" in str(e):
                                session_alive = False
                                break

            except Exception as e:
                print(f"❌ Main loop error: {e}")
            finally:
                session_alive = False
                receive_task.cancel()
                print(f"🔌 Done. Audio: {audio_chunk_count}, Frames: {frame_count}")

    except Exception as e:
        print(f"🔥 CRASH: {e}")
        traceback.print_exc()
    finally:
        try:
            await websocket.close(code=1011)
        except:
            pass
