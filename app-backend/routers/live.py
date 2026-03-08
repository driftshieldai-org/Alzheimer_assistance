import os
import asyncio
import base64
import traceback

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types
from google.cloud import firestore
import jose.jwt as jwt

os.environ['PYTHONUNBUFFERED'] = '1'

def log(msg):
    print(msg, flush=True)


router = APIRouter()

PROJECT_ID = os.environ.get("GCP_PROJECT_ID")
LOCATION = os.environ.get("GCP_REGION", "us-central1")
JWT_SECRET = os.environ.get("JWT_SECRET", "fallback_secret_for_dev")

db = firestore.Client(project=PROJECT_ID)

client = genai.Client(
    vertexai=True,
    project=PROJECT_ID,
    location=LOCATION
)

MODEL_ID = "gemini-live-2.5-flash-preview-native-audio"


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
        except:
            pass

        # ---------------- MEMORIES ----------------
        memories = []

        try:
            photos = (
                db.collection("users")
                .document(user_id)
                .collection("photos")
                .stream()
            )

            for doc in photos:
                data = doc.to_dict()

                if data.get("description"):
                    memories.append(
                        f"{data['description']} (Date: {data.get('photoDate')})"
                    )

        except:
            pass

        memories_text = "\n".join(memories) if memories else "No stored memories."

        # ---------------- SYSTEM PROMPT ----------------
        system_prompt = f"""
You are MemoryMate, helping a user with memory loss.

User: {user_name}

Known memories:
{memories_text}

Speak gently and clearly.
Keep responses short.
"""

        # ---------------- CONFIG ----------------
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

        # ---------------- GEMINI SESSION ----------------
        async with client.aio.live.connect(
            model=MODEL_ID,
            config=config
        ) as session:

            log("🟢 Gemini Live connected")

            # greeting
            await session.send_client_content(
                turns=[
                    types.Content(
                        role="user",
                        parts=[types.Part(text=f"Hello I am {user_name}")]
                    )
                ]
            )

            # ---------------- RECEIVE LOOP ----------------
            async def receive_loop():

                nonlocal session_alive

                try:

                    async for msg in session.receive():

                        if not session_alive:
                            break

                        server = msg.server_content

                        if not server:
                            continue

                        if server.interrupted:
                            await websocket.send_json(
                                {"type": "interrupted"}
                            )
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
                                            "audioBase64": audio
                                        }
                                    )

                                if part.text:

                                    await websocket.send_json(
                                        {
                                            "type": "textResponse",
                                            "text": part.text
                                        }
                                    )

                except Exception as e:
                    print("Receive loop error:", e)
                    session_alive = False

            receive_task = asyncio.create_task(receive_loop())

            # ---------------- STREAM LOOP ----------------
            last_audio = 0
            AUDIO_TIMEOUT = 1.2

            try:

                while session_alive:

                    try:

                        data = await asyncio.wait_for(
                            websocket.receive_json(),
                            timeout=0.5
                        )

                    except asyncio.TimeoutError:

                        # flush audio if user stopped speaking
                        if (
                            last_audio > 0
                            and asyncio.get_event_loop().time() - last_audio
                            > AUDIO_TIMEOUT
                        ):

                            log("🎤 audio_stream_end")

                            await session.send_realtime_input(
                                audio_stream_end=True
                            )

                            last_audio = 0

                        continue

                    except WebSocketDisconnect:
                        break

                    # -------- AUDIO --------
                    if data["type"] == "audio":

                        audio_bytes = base64.b64decode(
                            data["audioBase64"]
                        )

                        await session.send_realtime_input(
                            audio=types.Blob(
                                data=audio_bytes,
                                mime_type="audio/pcm;rate=16000"
                            )
                        )

                        last_audio = asyncio.get_event_loop().time()

                    # -------- VIDEO --------
                    elif data["type"] == "frame":

                        frame_bytes = base64.b64decode(
                            data["frameBase64"]
                        )

                        await session.send_realtime_input(
                            media=types.Blob(
                                data=frame_bytes,
                                mime_type="image/jpeg"
                            )
                        )

            finally:

                session_alive = False
                receive_task.cancel()

                try:
                    await receive_task
                except:
                    pass

    except Exception:
        traceback.print_exc()

    finally:

        try:
            await websocket.close()
        except:
            pass
