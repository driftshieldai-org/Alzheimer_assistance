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

router = APIRouter()

os.environ['PYTHONUNBUFFERED'] = '1'

def log(msg):
    print(msg, flush=True)
    

PROJECT_ID = os.environ.get("GCP_PROJECT_ID")
LOCATION = os.environ.get("GCP_REGION", "us-central1")
BUCKET_NAME = os.environ.get("GCS_BUCKET_NAME")
JWT_SECRET = os.environ.get("JWT_SECRET", "fallback_secret_for_dev")

# Google clients
db = firestore.Client(project=PROJECT_ID)
storage_client = storage.Client(project=PROJECT_ID)
bucket = storage_client.bucket(BUCKET_NAME)

client = genai.Client(
    vertexai=True,
    project=PROJECT_ID,
    location=LOCATION
)

MODEL_ID = "gemini-live-2.5-flash-native-audio"


@router.websocket("/api/live/ws/live/process-stream")
async def websocket_endpoint(websocket: WebSocket):

    await websocket.accept()
    log("🔌 Client connected")

    session_alive = True

    try:

        # ---------------------------
        # 1️⃣ AUTHENTICATION
        # ---------------------------

        token = websocket.query_params.get("token")

        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            user_id = payload.get("userId")
        except Exception as e:
            log("❌ Token invalid:", e)
            await websocket.close(code=1008)
            return

        # ---------------------------
        # 2️⃣ LOAD USER
        # ---------------------------

        user_name = user_id

        user_doc = db.collection("users").document(user_id).get()
        if user_doc.exists:
            user_name = user_doc.to_dict().get("name", user_id)

        # ---------------------------
        # 3️⃣ LOAD MEMORY CONTEXT
        # ---------------------------

        memories = []

        photos = (
            db.collection("users")
            .document(user_id)
            .collection("photos")
            .stream()
        )

        for doc in photos:
            data = doc.to_dict()

            description = data.get("description")
            date = data.get("photoDate")

            if description:
                memories.append(f"{description} (Date: {date})")

        memories_text = "\n".join(memories) if memories else "No stored memories yet."

        # ---------------------------
        # 4️⃣ SYSTEM PROMPT
        # ---------------------------

        system_prompt = f"""
You are MemoryMate, a compassionate AI helping people with memory loss.

User name: {user_name}

Known memories:
{memories_text}

Rules:
- Speak slowly and kindly
- Keep responses short
- Describe what you see in the camera
- If something matches a stored memory remind the user
"""

        # ---------------------------
        # 5️⃣ GEMINI CONFIG
        # ---------------------------

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
                parts=[types.Part(text=system_prompt)]
            )
        )

        # ---------------------------
        # 6️⃣ CONNECT GEMINI LIVE
        # ---------------------------

        async with client.aio.live.connect(
            model=MODEL_ID,
            config=config
        ) as session:

            log("🟢 Gemini Live connected")

            # ---------------------------
            # SEND INITIAL GREETING
            # ---------------------------

            await session.send_client_content(
                turns=[
                    types.Content(
                        role="user",
                        parts=[types.Part(text=f"Hello I am {user_name}")]
                    )
                ],
                turn_complete=True
            )

            # ---------------------------
            # RECEIVE LOOP
            # ---------------------------

            async def receive_loop():

                nonlocal session_alive

                try:

                    async for response in session.receive():

                        if not session_alive:
                            break

                        if response.server_content:

                            server = response.server_content

                            if server.interrupted:
                                await websocket.send_json({"type": "interrupted"})
                                continue

                            if server.model_turn:

                                for part in server.model_turn.parts:

                                    if part.inline_data:

                                        audio = base64.b64encode(
                                            part.inline_data.data
                                        ).decode()

                                        await websocket.send_json(
                                            {
                                                "type": "audioResponse",
                                                "audioBase64": audio,
                                            }
                                        )

                                    if part.text:

                                        await websocket.send_json(
                                            {
                                                "type": "textResponse",
                                                "text": part.text,
                                            }
                                        )

                except Exception as e:
                    log("❌ Receive loop error:", e)
                    session_alive = False

            receive_task = asyncio.create_task(receive_loop())

            # ---------------------------
            # AUDIO TURN DETECTION
            # ---------------------------

            SILENCE_TIMEOUT = 1.2
            last_audio_time = asyncio.get_event_loop().time()

            # ---------------------------
            # MAIN LOOP
            # ---------------------------

            try:

                while session_alive:

                    # Detect silence → complete turn
                    now = asyncio.get_event_loop().time()

                    if now - last_audio_time > SILENCE_TIMEOUT:

                        try:

                            await session.send_client_content(
                                turns=[],
                                turn_complete=True
                            )

                            last_audio_time = now + 999
                            log("🧠 Turn completed")

                        except Exception as e:
                            log("Turn complete failed:", e)

                    try:

                        data = await asyncio.wait_for(
                            websocket.receive_json(),
                            timeout=1.0
                        )

                    except asyncio.TimeoutError:
                        continue

                    except WebSocketDisconnect:
                        log("🔌 Client disconnected")
                        break

                    # ---------------------------
                    # AUDIO INPUT
                    # ---------------------------

                    if data["type"] == "audio":

                        audio_bytes = base64.b64decode(data["audioBase64"])

                        last_audio_time = asyncio.get_event_loop().time()

                        await session.send_realtime_input(
                            media=types.Blob(
                                data=audio_bytes,
                                mime_type="audio/pcm;rate=16000"
                            )
                        )

                    # ---------------------------
                    # VIDEO INPUT
                    # ---------------------------

                    elif data["type"] == "frame":

                        frame_bytes = base64.b64decode(data["frameBase64"])

                        await session.send_realtime_input(
                            media=types.Blob(
                                data=frame_bytes,
                                mime_type="image/jpeg"
                            )
                        )

            except Exception as e:
                log("❌ Main loop error:", e)

            finally:

                session_alive = False

                receive_task.cancel()

                try:
                    await receive_task
                except:
                    pass

                log("🧹 Session cleaned")

    except Exception as e:

        log("🔥 CRITICAL ERROR")
        traceback.print_exc()

    finally:

        try:
            await websocket.close()
        except:
            pass
