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

os.environ['PYTHONUNBUFFERED'] = '1'

def log(message):
    print(message, flush=True)
    sys.stdout.flush()
    
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
    log("🔌 Client connected to Live Stream")

    session_alive = True
    
    try:
        # Validate JWT Token
        token = websocket.query_params.get("token")
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            user_id = payload.get("userId")
        except Exception as e:
            log(f"❌ Token Error: {e}")
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
            log("🟢 Connected to Gemini Live")

            # Receive loop
            async def receive_loop():
                nonlocal session_alive
                try:
                    async for response in session.receive():
                        if not session_alive:
                            break
                        
                        if response.setup_complete:
                            log("✅ Setup complete")
                            continue
                            
                        if response.server_content:
                            server_content = response.server_content
                            
                            if server_content.interrupted:
                                log("🔇 Interrupted")
                                await websocket.send_json({"type": "interrupted"})
                                continue
                            
                            if server_content.model_turn:
                                for part in server_content.model_turn.parts:
                                    if part.inline_data:
                                        audio_bytes = part.inline_data.data
                                        b64_audio = base64.b64encode(audio_bytes).decode("utf-8")
                                        log(f"🔊 Audio response: {len(audio_bytes)} bytes")
                                        await websocket.send_json({
                                            "type": "audioResponse",
                                            "audioBase64": b64_audio
                                        })
                                    if part.text:
                                        log(f"📝 Text: {part.text[:50]}...")
                                        await websocket.send_json({
                                            "type": "textResponse",
                                            "text": part.text
                                        })
                            
                            if server_content.turn_complete:
                                log("✅ Turn complete")
                                            
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    log(f"❌ Receive Error: {e}")
                    session_alive = False

            receive_task = asyncio.create_task(receive_loop())
            await asyncio.sleep(0.2)

            # Send greeting
            await session.send(
                input=f"Hello! I am {user_name}. Please greet me.",
                end_of_turn=True
            )
            log("✅ Initial greeting sent")
            
            # Wait for greeting response
            await asyncio.sleep(3)
            log("🎤 Ready for realtime input")

            # Audio buffering for turn detection
            audio_buffer = []
            last_audio_time = None
            SILENCE_THRESHOLD = 1.5  # seconds of silence to trigger end of turn
            
            # Process client input
            audio_chunk_count = 0
            frame_count = 0
            
            async def check_silence_and_send():
                """Background task to detect silence and send end_of_turn"""
                nonlocal audio_buffer, last_audio_time, session_alive
                
                while session_alive:
                    await asyncio.sleep(0.5)
                    
                    if last_audio_time and len(audio_buffer) > 0:
                        time_since_last_audio = asyncio.get_event_loop().time() - last_audio_time
                        
                        if time_since_last_audio >= SILENCE_THRESHOLD:
                            # User stopped speaking, send accumulated audio with end_of_turn
                            log(f"🎙️ Silence detected, sending {len(audio_buffer)} audio chunks")
                            
                            try:
                                # Send any remaining buffered audio
                                for chunk_b64 in audio_buffer:
                                    await session.send(
                                        input={
                                            "data": chunk_b64,
                                            "mime_type": "audio/pcm;rate=16000"
                                        },
                                        end_of_turn=False
                                    )
                                
                                # Signal end of turn
                                await session.send(input="", end_of_turn=True)
                                log("✅ End of turn sent")
                                
                            except Exception as e:
                                log(f"⚠️ Error sending buffered audio: {e}")
                            
                            audio_buffer = []
                            last_audio_time = None
            
            silence_task = asyncio.create_task(check_silence_and_send())
            
            try:
                while session_alive:
                    try:
                        data = await asyncio.wait_for(
                            websocket.receive_json(),
                            timeout=0.5
                        )
                    except asyncio.TimeoutError:
                        continue
                    except WebSocketDisconnect:
                        log("🔌 Client disconnected")
                        break

                    if data["type"] == "audio":
                        try:
                            audio_chunk_count += 1
                            last_audio_time = asyncio.get_event_loop().time()
                            
                            if audio_chunk_count % 100 == 0:
                                log(f"🎤 Audio: {audio_chunk_count} chunks")
                            
                            # Send audio immediately
                            await session.send(
                                input={
                                    "data": data["audioBase64"],
                                    "mime_type": "audio/pcm;rate=16000"
                                },
                                end_of_turn=False
                            )
                            
                            # Also buffer for silence detection
                            audio_buffer.append(data["audioBase64"])
                            
                            # Keep buffer size manageable
                            if len(audio_buffer) > 200:
                                audio_buffer = audio_buffer[-100:]
                            
                        except Exception as e:
                            log(f"⚠️ Audio error: {e}")
                            if "closed" in str(e).lower() or "1011" in str(e):
                                session_alive = False
                                break

                    elif data["type"] == "frame":
                        try:
                            frame_count += 1
                            
                            if frame_count % 10 == 0:
                                log(f"📹 Frames: {frame_count}")
                            
                            await session.send(
                                input={
                                    "data": data["frameBase64"],
                                    "mime_type": "image/jpeg"
                                },
                                end_of_turn=False
                            )
                            
                        except Exception as e:
                            log(f"⚠️ Frame error: {e}")
                            if "closed" in str(e).lower() or "1011" in str(e):
                                session_alive = False
                                break
                    
                    # Handle explicit end of turn from client
                    elif data["type"] == "endTurn":
                        log("🎙️ Client signaled end of turn")
                        try:
                            await session.send(input="", end_of_turn=True)
                        except Exception as e:
                            log(f"⚠️ End turn error: {e}")

            except Exception as e:
                log(f"❌ Main loop error: {e}")
            finally:
                session_alive = False
                silence_task.cancel()
                receive_task.cancel()
                log(f"🔌 Done. Audio: {audio_chunk_count}, Frames: {frame_count}")

    except Exception as e:
        log(f"🔥 CRASH: {e}")
        traceback.print_exc()
    finally:
        try:
            await websocket.close(code=1011)
        except:
            pass
