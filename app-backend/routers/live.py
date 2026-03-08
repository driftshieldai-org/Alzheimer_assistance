import os
import asyncio
import base64
import traceback

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types
from google.cloud import firestore
from google.cloud import storage

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

        # ----------------------------------------------------
        # 1️⃣ Validate JWT Token
        # ----------------------------------------------------

        token = websocket.query_params.get("token")

        import jose.jwt as jwt

        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            user_id = payload.get("userId")
        except Exception as e:
            print(f"❌ Token Error: {e}")
            await websocket.close(code=1008)
            return

        # ----------------------------------------------------
        # 2️⃣ Load User Info
        # ----------------------------------------------------

        user_name = user_id

        user_doc = db.collection("users").document(user_id).get()

        if user_doc.exists:
            user_name = user_doc.to_dict().get("name", user_id)

        # ----------------------------------------------------
        # 3️⃣ System Instruction (TEXT ONLY)
        # ----------------------------------------------------

        system_instruction = f"""
You are MemoryMate.

User name: {user_name}

Instructions:
1. Greet the user warmly.
2. Listen to their voice.
3. Watch their video stream.
4. Match their video to stored memories when possible.
5. Speak clearly and kindly.
"""

        # ----------------------------------------------------
        # 4️⃣ Gemini Live Config
        # ----------------------------------------------------

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
            system_instruction=system_instruction
        )

        # ----------------------------------------------------
        # 5️⃣ Connect to Gemini Live
        # ----------------------------------------------------

        async with client.aio.live.connect(
            model=MODEL_ID,
            config=config
        ) as session:

            print("🟢 Connected to Gemini Live")

            # ------------------------------------------------
            # 6️⃣ Send Stored Memories (Text + Images)
            # ------------------------------------------------

            photos_ref = (
                db.collection("users")
                .document(user_id)
                .collection("photos")
                .stream()
            )

            for doc in photos_ref:

                data = doc.to_dict()

                if "filename" not in data:
                    continue

                description = data.get("description", "Unknown memory")
                date = data.get("photoDate", "Unknown date")

                memory_text = f"Memory: {description} on {date}"

                # Send memory description
                await session.send(input=memory_text)

                # Download image from GCS
                try:

                    blob = bucket.blob(data["filename"])
                    image_bytes = blob.download_as_bytes()

                    image_b64 = base64.b64encode(image_bytes).decode("utf-8")
                    
                    await session.send(
                        input={
                            "mime_type": "image/jpeg",
                            "data": image_b64
                        }
                    )

                except Exception as e:
                    print(f"⚠️ Failed to load image: {e}")

            # Send greeting prompt
            await session.send(
                input=f"Hello, I am {user_name}. Please greet me and confirm you received my memories.",
                end_of_turn=True
            )

            print("✅ Memories sent. Ready for conversation.")

            # ------------------------------------------------
            # 7️⃣ Receive Responses From Gemini
            # ------------------------------------------------

            async def receive_loop():

                try:

                    async for response in session.receive():

                        server_content = response.server_content

                        if server_content is None:
                            continue

                        if server_content.interrupted:
                            await websocket.send_json({
                                "type": "interrupted"
                            })

                        turn = server_content.model_turn

                        if not turn:
                            continue

                        for part in turn.parts:

                            # Audio response
                            if part.inline_data:

                                audio_bytes = part.inline_data.data

                                b64_audio = base64.b64encode(
                                    audio_bytes
                                ).decode("utf-8")

                                await websocket.send_json({
                                    "type": "audioResponse",
                                    "audioBase64": b64_audio
                                })

                            # Text description
                            if part.text:

                                await websocket.send_json({
                                    "type": "audioResponse",
                                    "description": part.text
                                })

                except asyncio.CancelledError:
                    pass

                except Exception as e:
                    print(f"❌ Receive Loop Error: {e}")

            receive_task = asyncio.create_task(receive_loop())

            # ------------------------------------------------
            # 8️⃣ Receive Audio + Video From Frontend
            # ------------------------------------------------

            debug_audio_counter = 0

            try:

                while True:

                    data = await websocket.receive_json()

                    # Video frame
                    if data["type"] == "frame":

                        await session.send(
                            input={
                                "mime_type": "image/jpeg",
                                "data":data["frameBase64"]
                            }
                        )

                    # Audio chunk
                    elif data["type"] == "audio":

                        debug_audio_counter += 1

                        if debug_audio_counter % 50 == 0:
                            print(
                                f"🎤 Audio Active: {debug_audio_counter} chunks"
                            )

                        await session.send(
                            input={
                                "mime_type": "audio/pcm;rate=16000",
                                "data": base64.b64decode(
                                    data["audioBase64"]
                                )
                            }
                        )

            except WebSocketDisconnect:

                print("🔌 Client disconnected")

            finally:

                receive_task.cancel()

    except Exception as e:

        print(f"🔥 CRITICAL WEBSOCKET CRASH: {e}")
        print(traceback.format_exc())

        try:
            await websocket.close(code=1011)
        except:
            pass
