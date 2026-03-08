import os
import sys
import asyncio
import base64
import traceback
import struct

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types
from google.cloud import firestore
from google.cloud import storage
import jose.jwt as jwt

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
    log("🔌 Client connected")

    session_alive = True
    
    try:
        token = websocket.query_params.get("token")
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            user_id = payload.get("userId")
        except Exception as e:
            log(f"❌ Token Error: {e}")
            await websocket.close(code=1008)
            return

        user_name = user_id
        user_doc = db.collection("users").document(user_id).get()
        if user_doc.exists:
            user_name = user_doc.to_dict().get("name", user_id)

        memories_context = []
        photos_ref = db.collection("users").document(user_id).collection("photos").stream()
        for doc in photos_ref:
            data = doc.to_dict()
            if "description" in data:
                memories_context.append(f"- {data.get('description')} ({data.get('photoDate', 'unknown date')})")
        
        memories_text = "\n".join(memories_context) if memories_context else "No memories yet."

        system_instruction = f"""You are MemoryMate, a caring AI assistant.
User: {user_name}
Memories: {memories_text}
Be warm, helpful, and describe what you see in images."""

        MODEL_ID = "gemini-2.0-flash-live-001"
        
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede")
                )
            ),
            system_instruction=types.Content(parts=[types.Part(text=system_instruction)])
        )

        async with client.aio.live.connect(model=MODEL_ID, config=config) as session:
            log("🟢 Connected to Gemini")

            async def receive_loop():
                nonlocal session_alive
                try:
                    async for response in session.receive():
                        if not session_alive:
                            break
                        if response.setup_complete:
                            log("✅ Setup complete")
                        if response.server_content:
                            sc = response.server_content
                            if sc.interrupted:
                                await websocket.send_json({"type": "interrupted"})
                            if sc.model_turn:
                                for part in sc.model_turn.parts:
                                    if part.inline_data:
                                        b64 = base64.b64encode(part.inline_data.data).decode()
                                        log(f"🔊 Audio: {len(part.inline_data.data)} bytes")
                                        await websocket.send_json({"type": "audioResponse", "audioBase64": b64})
                            if sc.turn_complete:
                                log("✅ Turn complete")
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    log(f"❌ Receive error: {e}")
                    session_alive = False

            receive_task = asyncio.create_task(receive_loop())
            await asyncio.sleep(0.3)

            await session.send(input=f"Hello, I am {user_name}. Greet me warmly.", end_of_turn=True)
            log("✅ Greeting sent")

            # Track speech activity
            speech_active = False
            silence_count = 0
            SILENCE_THRESHOLD = 20  # ~2 seconds of silence
            
            audio_count = 0
            frame_count = 0
            last_frame_b64 = None
            
            log("🎤 Ready")
            
            try:
                while session_alive:
                    try:
                        data = await asyncio.wait_for(websocket.receive_json(), timeout=0.1)
                    except asyncio.TimeoutError:
                        # Check for end of speech
                        if speech_active:
                            silence_count += 1
                            if silence_count >= SILENCE_THRESHOLD:
                                log("🎙️ Speech ended, requesting response...")
                                speech_active = False
                                silence_count = 0
                                
                                # Send text prompt with last frame context
                                prompt = "The user just spoke to you. Please respond to them."
                                if last_frame_b64:
                                    try:
                                        await session.send(
                                            input={"data": last_frame_b64, "mime_type": "image/jpeg"},
                                            end_of_turn=False
                                        )
                                    except:
                                        pass
                                
                                await session.send(input=prompt, end_of_turn=True)
                        continue
                    except WebSocketDisconnect:
                        log("🔌 Disconnected")
                        break

                    if data["type"] == "audio":
                        audio_bytes = base64.b64decode(data["audioBase64"])
                        audio_count += 1
                        
                        # Check level
                        samples = struct.unpack(f'<{len(audio_bytes)//2}h', audio_bytes)
                        max_val = max(abs(s) for s in samples)
                        
                        if max_val > 1000:  # Speech detected
                            speech_active = True
                            silence_count = 0
                        
                        if audio_count % 50 == 0:
                            log(f"🎤 Audio: {audio_count}, level: {max_val}, speaking: {speech_active}")

                    elif data["type"] == "frame":
                        frame_count += 1
                        last_frame_b64 = data["frameBase64"]
                        if frame_count % 10 == 0:
                            log(f"📹 Frames: {frame_count}")

            except Exception as e:
                log(f"❌ Error: {e}")
            finally:
                session_alive = False
                receive_task.cancel()
                log(f"🔌 Done. Audio: {audio_count}, Frames: {frame_count}")

    except Exception as e:
        log(f"🔥 CRASH: {e}")
        traceback.print_exc()
    finally:
        try:
            await websocket.close(code=1011)
        except:
            pass
