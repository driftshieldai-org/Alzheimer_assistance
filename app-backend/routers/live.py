import os
import sys
import asyncio
import base64
import traceback

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types
from google.cloud import firestore
from google.cloud import storage
import jose.jwt as jwt

os.environ['PYTHONUNBUFFERED'] = '1'

def log(msg):
    print(msg, flush=True)

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
    receive_task = None
    
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

        memories = []
        for doc in db.collection("users").document(user_id).collection("photos").stream():
            data = doc.to_dict()
            if "description" in data:
                memories.append(f"- {data.get('description')} ({data.get('photoDate', '')})")
        memories_text = "\n".join(memories) if memories else "No memories yet."

        system_instruction = f"""You are MemoryMate, a caring AI assistant for {user_name}.

Stored memories:
{memories_text}

Instructions:
- Greet warmly and be compassionate
- Respond naturally to what the user says
- Describe what you see in images when shown
- Connect visuals to stored memories when relevant
- Speak clearly and concisely"""

        MODEL_ID = "gemini-live-2.5-flash-native-audio"
        
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
            log("🟢 Connected to Gemini Live")

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
                                try:
                                    await websocket.send_json({"type": "interrupted"})
                                except:
                                    pass
                            if sc.model_turn:
                                for part in sc.model_turn.parts:
                                    if part.inline_data:
                                        b64 = base64.b64encode(part.inline_data.data).decode()
                                        log(f"🔊 Audio: {len(part.inline_data.data)} bytes")
                                        try:
                                            await websocket.send_json({"type": "audioResponse", "audioBase64": b64})
                                        except:
                                            session_alive = False
                                    if part.text:
                                        log(f"📝 Text: {part.text[:50]}")
                            if sc.turn_complete:
                                log("✅ Turn complete")
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    log(f"❌ Receive error: {e}")
                    session_alive = False

            receive_task = asyncio.create_task(receive_loop())
            await asyncio.sleep(0.2)

            # Initial greeting
            await session.send(input=f"Hello, I am {user_name}. Please greet me warmly.", end_of_turn=True)
            log("✅ Greeting sent")

            frame_count = 0
            last_frame_b64 = None
            
            log("🎤 Ready for input")
            
            try:
                while session_alive:
                    try:
                        data = await asyncio.wait_for(websocket.receive_json(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    except WebSocketDisconnect:
                        log("🔌 Client disconnected")
                        break

                    # Handle text from speech recognition
                    if data["type"] == "text":
                        text = data.get("text", "").strip()
                        if text:
                            log(f"💬 User: {text}")
                            
                            # Send last frame for context if available
                            if last_frame_b64:
                                try:
                                    await session.send(
                                        input={"data": last_frame_b64, "mime_type": "image/jpeg"},
                                        end_of_turn=False
                                    )
                                except:
                                    pass
                            
                            # Send user text
                            await session.send(input=text, end_of_turn=True)

                    # Handle video frames
                    elif data["type"] == "frame":
                        frame_count += 1
                        last_frame_b64 = data["frameBase64"]
                        if frame_count % 10 == 0:
                            log(f"📹 Frames: {frame_count}")

                    # Handle explicit describe request
                    elif data["type"] == "describe":
                        log("👁️ Describe request")
                        if last_frame_b64:
                            await session.send(
                                input={"data": last_frame_b64, "mime_type": "image/jpeg"},
                                end_of_turn=False
                            )
                        await session.send(input="Please describe what you see.", end_of_turn=True)

            except Exception as e:
                log(f"❌ Loop error: {e}")
                traceback.print_exc()
            finally:
                session_alive = False
                if receive_task:
                    receive_task.cancel()
                log(f"🔌 Done. Frames: {frame_count}")

    except Exception as e:
        log(f"🔥 CRASH: {e}")
        traceback.print_exc()
    finally:
        try:
            await websocket.close(code=1011)
        except:
            pass
