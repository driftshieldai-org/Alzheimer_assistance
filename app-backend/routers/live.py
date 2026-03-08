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

        # 3️⃣ System Instruction
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

        # 4️⃣ Gemini Live Config
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
            automatic_activity_detection=True,
            system_instruction=system_instruction
            
        )

        # 5️⃣ Connect to Gemini Live
        async with client.aio.live.connect(model=MODEL_ID, config=config) as session:
            print("🟢 Connected to Gemini Live")

            # 6️⃣ Send Stored Memories (Text + Images)
            photos_ref = db.collection("users").document(user_id).collection("photos").stream()
            for doc in photos_ref:
                data = doc.to_dict()
                if "filename" not in data:
                    continue

                description = data.get("description", "Unknown memory")
                date = data.get("photoDate", "Unknown date")
                memory_text = f"Memory: {description} on {date}"

                # Send memory text safely
                try:
                    await session.send(input=memory_text)
                    print(f"✅ Sent memory text: {memory_text}")
                except Exception as e:
                    print(f"⚠️ Failed to send memory text: {e}")

                # Send memory image safely
                try:
                    blob = bucket.blob(data["filename"])
                    image_bytes = blob.download_as_bytes()

                    # Validate and re-encode image as JPEG RGB
                    img = Image.open(BytesIO(image_bytes)).convert("RGB")
                    # Optional: resize large images
                    img.thumbnail((512, 512))
                    buf = BytesIO()
                    img.save(buf, format="JPEG")
                    image_bytes_jpeg = buf.getvalue()

                    image_b64 = base64.b64encode(image_bytes_jpeg).decode("utf-8")

                    await session.send(
                        input={"mime_type": "image/jpeg", "data": image_b64}
                    )
                    print(f"✅ Sent memory image: {data['filename']}")
                except Exception as e:
                    print(f"⚠️ Failed to load/convert memory image '{data.get('filename')}': {e}")

            # Send initial greeting
            await session.send(
                input=f"Hello, I am {user_name}. Please greet me and confirm you received my memories.",
                end_of_turn=True
            )
            print("✅ Initial greeting sent. Ready for live conversation.")

            # 7️⃣ Receive Responses From Gemini
            async def receive_loop():
                try:
                    async for response in session.receive():
                        server_content = response.server_content
                        if server_content is None:
                            continue
                        if server_content.interrupted:
                            await websocket.send_json({"type": "interrupted"})
                        turn = server_content.model_turn
                        if not turn:
                            continue
                        for part in turn.parts:
                            # Audio response
                            if part.inline_data:
                                audio_bytes = part.inline_data.data
                                b64_audio = base64.b64encode(audio_bytes).decode("utf-8")
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

            # 8️⃣ Receive Live Audio (ignore video frames)
            debug_audio_counter = 0
            try:
                while True:
                    data = await websocket.receive_json()

                    if data["type"] == "frame":
                        try:
                            frame_bytes = base64.b64decode(data["frameBase64"])
                            # Stream video frames using Realtime Input
                            await session.send_realtime_input(
                            video=types.Blob(
                              data=frame_bytes,
                              mime_type="image/jpeg"
                            )
                            )
                        except Exception as e:
                            print(f"⚠️ Failed to send video frame: {}")
                            continue

                    # Process audio chunks
                    if data["type"] == "audio":
                        try:
                            debug_audio_counter += 1
                            audio_bytes = base64.b64decode(data["audioBase64"])

                            if debug_audio_counter % 50 == 0:
                                print(f"🎤 Audio Active: {debug_audio_counter} chunks, size={len(audio_bytes)} bytes")

                            # Send chunk to Gemini Live
                            #await session.send(
                            #    input={
                            #        "mime_type": "audio/wav",
                            #        "data": base64.b64encode(audio_bytes).decode("utf-8")
                            #    },
                            #    end_of_turn=False  # keep streaming multiple chunks
                            #)*/
                            await session.send_realtime_input(
                                audio=types.Blob(
                                  data=audio_bytes,
                                  mime_type="audio/pcm;rate=16000" # 🛠️ FIX: Use raw PCM with correct sample rate
                                )
                              )
                        except Exception as e:
                            print(f"⚠️ Failed to send audio chunk: {e}")

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
