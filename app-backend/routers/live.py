import os
import asyncio
import base64
import traceback

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types
from google.cloud import firestore
import jose.jwt as jwt

router = APIRouter()

os.environ['PYTHONUNBUFFERED'] = '1'


def log(msg):
    print(msg, flush=True)


# ---------------- ENV ----------------

PROJECT_ID = os.environ.get("GCP_PROJECT_ID")
LOCATION = os.environ.get("GCP_REGION", "us-central1")
JWT_SECRET = os.environ.get("JWT_SECRET", "fallback_secret_for_dev")

MODEL_ID = "gemini-live-2.5-flash-native-audio"

# ---------------- CLIENTS ----------------

db = firestore.Client(project=PROJECT_ID)

client = genai.Client(
    vertexai=True,
    project=PROJECT_ID,
    location=LOCATION
)


# ---------------- WEBSOCKET ----------------

@router.websocket("/api/live/ws/live/process-stream")
async def websocket_endpoint(websocket: WebSocket):

    await websocket.accept()
    log("🔌 Client connected")

    session_alive = True

    try:

        # ---------------- AUTH ----------------
        token = websocket.query_params.get("token")

        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            user_id = payload.get("userId")
        except Exception:
            log("❌ Invalid token")
            await websocket.close(code=1008)
            return

        # ---------------- USER ----------------
        user_name = user_id
        try:
            user_doc = db.collection("users").document(user_id).get()
            if user_doc.exists:
                user_name = user_doc.to_dict().get("name", user_id)
        except Exception:
            pass

        # ---------------- MEMORIES ----------------
        memories = []
        try:
            photos = db.collection("users").document(user_id).collection("photos").stream()
            for doc in photos:
                data = doc.to_dict()
                if data.get("description"):
                    memories.append(f"{data['description']} (Date: {data.get('photoDate')})")
        except Exception:
            pass

        memories_text = "\n".join(memories) if memories else "No stored memories."

        # ---------------- SYSTEM PROMPT ----------------
        system_prompt = f"""
You are MemoryMate, a caring AI helping a person with memory loss.

User: {user_name}

Known memories:
{memories_text}

Speak gently and clearly.
Keep responses short.
If the user shows something using the camera, describe it.
If it matches a stored memory, remind them kindly.
Ask them if they are looking for something else and respond accordingly.
"""

        # ---------------- CONFIG ----------------
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede")
                )
            ),
            system_instruction=types.Content(parts=[types.Part(text=system_prompt)])
        )

        # ---------------- GEMINI SESSION ----------------
        async with client.aio.live.connect(model=MODEL_ID, config=config) as session:

            log("🟢 Gemini Live connected")

            # -------- Greeting --------
            await session.send_client_content(
                turns=[types.Content(role="user", parts=[types.Part(text=f"Hello I am {user_name}")])],
                turn_complete=True
            )

            # ---------------- RECEIVE LOOP ----------------
            async def receive_loop():
                nonlocal session_alive
                try:
                    log("🟢 receive loop started")
                    async for msg in session.receive():

                        if not session_alive:
                            break

                        server = msg.server_content
                        if not server:
                            continue

                        # interruption (barge-in)
                        if server.interrupted:
                            await websocket.send_json({"type": "interrupted"})
                            continue

                        # model response
                        if server.model_turn:
                            for part in server.model_turn.parts:

                                # AUDIO
                                if part.inline_data:
                                    audio = base64.b64encode(part.inline_data.data).decode()
                                    await websocket.send_json({"type": "audioResponse", "audioBase64": audio})

                                # TEXT (optional)
                                if part.text:
                                    await websocket.send_json({"type": "textResponse", "text": part.text})

                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    log(f"❌ Receive loop error: {e}")
                    session_alive = False

            receive_task = asyncio.create_task(receive_loop())

            # ---------------- STREAM LOOP ----------------
            last_audio = 0
            AUDIO_TIMEOUT = 1.2  # seconds

            async def audio_monitor():
                """Send audio_stream_end after silence detected"""
                nonlocal last_audio, session_alive
                while session_alive:
                    if last_audio > 0 and asyncio.get_event_loop().time() - last_audio > AUDIO_TIMEOUT:
                        log("🎤 audio_stream_end triggered by silence")
                        try:
                            await session.send_realtime_input(audio_stream_end=True)
                        except Exception as e:
                            log(f"❌ Failed to send audio_stream_end: {e}")
                            session_alive = False
                            break
                        last_audio = 0
                    await asyncio.sleep(0.1)

            audio_monitor_task = asyncio.create_task(audio_monitor())

            try:
                while session_alive:
                    try:
                        data = await websocket.receive_json()
                    except WebSocketDisconnect:
                        log("🔌 Client disconnected")
                        break
                    except Exception as e:
                        log(f"⚠️ Receive error: {e}")
                        continue

                    # -------- AUDIO --------
                    if data["type"] == "audio":
                        log("🟢 audio received")
                        audio_bytes = base64.b64decode(data["audioBase64"])
                        await session.send_realtime_input(
                            audio=types.Blob(data=audio_bytes, mime_type="audio/pcm;rate=16000")
                        )
                        last_audio = asyncio.get_event_loop().time()

                    # -------- VIDEO FRAME --------
                    elif data["type"] == "frame":
                        log("🟢 frame received")
                        frame_bytes = base64.b64decode(data["frameBase64"])
                        await session.send_realtime_input(
                            media=types.Blob(data=frame_bytes, mime_type="image/jpeg")
                        )

            finally:
                session_alive = False
                audio_monitor_task.cancel()
                receive_task.cancel()
                try:
                    await audio_monitor_task
                except:
                    pass
                try:
                    await receive_task
                except:
                    pass
                log("🧹 Session closed")

    except Exception:
        traceback.print_exc()

    finally:
        try:
            await websocket.close()
        except:
            pass
