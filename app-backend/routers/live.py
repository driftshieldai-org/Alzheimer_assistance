import os
import sys
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
        system_instruction = f"""You are MemoryMate, a caring AI assistant helping people with memory challenges.

User name: {user_name}

User's stored memories:
{memories_text}

Instructions:
1. Greet the user warmly by name when they first connect.
2. Listen carefully to what they say via audio.
3. Watch the video stream and describe what you see when relevant.
4. If something in the video matches a stored memory, kindly remind them.
5. Speak clearly, slowly, and with compassion.
6. Keep responses concise but helpful.
7. Always respond when the user speaks to you.
"""

        # Gemini Live Config with proper audio settings
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
            ),
            # Enable automatic voice activity detection
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    disabled=False,
                    start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
                    end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_HIGH,
                    prefix_padding_ms=300,
                    silence_duration_ms=1000
                )
            )
        )

        async with client.aio.live.connect(model=MODEL_ID, config=config) as session:
            log("🟢 Connected to Gemini Live")

            # Receive loop - handles all responses from Gemini
            async def receive_loop():
                nonlocal session_alive
                try:
                    async for response in session.receive():
                        if not session_alive:
                            break
                        
                        if response.setup_complete:
                            log("✅ Setup complete")
                            continue
                        
                        # Handle tool calls if any
                        if response.tool_call:
                            log(f"🔧 Tool call: {response.tool_call}")
                            continue
                            
                        if response.server_content:
                            server_content = response.server_content
                            
                            if server_content.interrupted:
                                log("🔇 Interrupted by user")
                                try:
                                    await websocket.send_json({"type": "interrupted"})
                                except:
                                    pass
                                continue
                            
                            if server_content.model_turn:
                                for part in server_content.model_turn.parts:
                                    if part.inline_data:
                                        audio_bytes = part.inline_data.data
                                        b64_audio = base64.b64encode(audio_bytes).decode("utf-8")
                                        log(f"🔊 Audio response: {len(audio_bytes)} bytes")
                                        try:
                                            await websocket.send_json({
                                                "type": "audioResponse",
                                                "audioBase64": b64_audio
                                            })
                                        except Exception as e:
                                            log(f"❌ Failed to send audio: {e}")
                                            session_alive = False
                                            break
                                    if part.text:
                                        log(f"📝 Text: {part.text[:100]}...")
                                        try:
                                            await websocket.send_json({
                                                "type": "textResponse",
                                                "text": part.text
                                            })
                                        except:
                                            pass
                            
                            if server_content.turn_complete:
                                log("✅ Turn complete")
                                            
                except asyncio.CancelledError:
                    log("📭 Receive loop cancelled")
                except Exception as e:
                    log(f"❌ Receive Error: {e}")
                    traceback.print_exc()
                    session_alive = False

            receive_task = asyncio.create_task(receive_loop())
            
            # Wait for setup
            await asyncio.sleep(0.5)

            # Send initial greeting to trigger first response
            await session.send_client_content(
                turns=[
                    types.Content(
                        role="user",
                        parts=[types.Part(text=f"Hello! I am {user_name}. Please greet me warmly and tell me you're ready to help.")]
                    )
                ],
                turn_complete=True
            )
            log("✅ Initial greeting sent")

            # Process incoming audio/video from client
            audio_chunk_count = 0
            frame_count = 0
            
            log("🎤 Ready for realtime input")
            
            try:
                while session_alive:
                    try:
                        data = await asyncio.wait_for(
                            websocket.receive_json(),
                            timeout=0.1
                        )
                    except asyncio.TimeoutError:
                        continue
                    except WebSocketDisconnect:
                        log("🔌 Client disconnected")
                        break

                    if data["type"] == "audio":
                        try:
                            audio_bytes = base64.b64decode(data["audioBase64"])
                            audio_chunk_count += 1
                            
                            if audio_chunk_count % 50 == 0:
                                import struct
                                samples = struct.unpack(f'<{len(audio_bytes)//2}h', audio_bytes)
                                max_val = max(abs(s) for s in samples)
                                log(f"🎤 Audio: {audio_chunk_count} chunks, max level: {max_val}/32768")
                            
                            # Send raw audio bytes directly
                            await session.send_realtime_input(
                                audio=types.Blob(
                                    data=audio_bytes,
                                    mime_type="audio/pcm;rate=16000"
                                )
                            )
                            
                        except Exception as e:
                            error_str = str(e).lower()
                            if audio_chunk_count % 100 == 0:
                                log(f"⚠️ Audio error: {e}")
                            if "closed" in error_str or "1011" in error_str:
                                session_alive = False
                                break

                    elif data["type"] == "frame":
                        try:
                            frame_bytes = base64.b64decode(data["frameBase64"])
                            frame_count += 1
                            
                            if frame_count % 10 == 0:
                                log(f"📹 Frames: {frame_count}")
                            
                            # Send video frame
                            await session.send_realtime_input(
                                video=types.Blob(
                                    data=frame_bytes,
                                    mime_type="image/jpeg"
                                )
                            )
                            
                        except Exception as e:
                            if frame_count % 10 == 0:
                                log(f"⚠️ Frame error: {e}")

            except Exception as e:
                log(f"❌ Main loop error: {e}")
                traceback.print_exc()
            finally:
                session_alive = False
                receive_task.cancel()
                try:
                    await receive_task
                except:
                    pass
                log(f"🔌 Done. Audio: {audio_chunk_count}, Frames: {frame_count}")

    except Exception as e:
        log(f"🔥 CRASH: {e}")
        traceback.print_exc()
    finally:
        try:
            await websocket.close(code=1011)
        except:
            pass
