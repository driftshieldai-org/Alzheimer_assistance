import os
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

async def get_gcs_file_bytes(filename: str) -> bytes:
    """Downloads a file from GCS and returns its content as bytes."""
    blob = bucket.blob(filename)
    return await asyncio.to_thread(blob.download_as_bytes)


@router.websocket("/api/live/ws/live/process-stream")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🔌 Client connected to Live Stream", flush=True)

    # Session state tracking
    session_alive = True
    
    try:
        # 1️⃣ Validate JWT Token
        token = websocket.query_params.get("token")
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            user_id = payload.get("userId")
            print(f"✅ Token validated for user: {user_id}", flush=True)
        except Exception as e:
            print(f"❌ Token Error: {e}", flush=True)
            await websocket.close(code=1008)
            return

        # 2️⃣ Load User Info
        user_name = user_id
        user_doc = db.collection("users").document(user_id).get()
        if user_doc.exists:
            user_name = user_doc.to_dict().get("name", user_id)
        print(f"✅ Loaded user info for: {user_name}", flush=True)

        # 3️⃣ Load memories with images as context parts
        memories_context_parts = []
        photos_ref = db.collection("users").document(user_id).collection("photos").stream()
        for doc in photos_ref:
            data = doc.to_dict()
            if "description" in data and "filename" in data:
                description = data.get("description", "Unknown memory")
                date = data.get("photoDate", "Unknown date")
                filename = data.get("filename")
                
                # Add text part for the memory
                memories_context_parts.append(types.Part(text=f"Memory - Description: {description}, Date: {date}"))
                
                # Add image part for the memory
                try:
                    image_bytes = await get_gcs_file_bytes(filename)
                    memories_context_parts.append(types.Part(
                        inline_data=types.Blob(data=image_bytes, mime_type="image/jpeg")
                    ))
                except Exception as e:
                    print(f"⚠️ Could not load image {filename} from GCS: {e}", flush=True)
        print(f"✅ Loaded {len(memories_context_parts) // 2} memories.", flush=True)

        # 4️⃣ System Instruction
        system_instruction = f"""You are MemoryMate, a caring AI assistant helping people with memory.

User name: {user_name}

I have provided you with the user's stored memories (photos and descriptions) in the previous turn.

Instructions:
1. Greet the user warmly by name.
2. Listen to their voice and respond naturally.
3. When they show you something via camera, describe what you see.
4. If what they show matches a stored memory, remind them about it kindly.
5. Speak clearly, slowly, and with compassion.
6. Keep responses concise and helpful.
"""

        # 5️⃣ Gemini Live Config
        # Using a more common and available model. The previous model might not be available in your project/region.
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
        print(f"✅ Configured for model: {MODEL_ID}", flush=True)

        # 6️⃣ Connect to Gemini Live
        print("⏳ Connecting to Gemini Live...", flush=True)
        async with client.aio.live.connect(model=MODEL_ID, config=config) as session:
            print("🟢 Connected to Gemini Live", flush=True)
            session_alive = True

            # Combine memories and the initial greeting into a single, initial turn.
            # This is sent once before starting the concurrent send/receive loops.
            initial_prompt_parts = []
            if memories_context_parts:
                initial_prompt_parts.extend(memories_context_parts)
            initial_prompt_parts.append(
                types.Part(text=f"Hello! I am {user_name}. Please greet me warmly.")
            )
            print("✅ Sending initial context and prompt in a single turn.", flush=True)
            await session.send_client_content(
                turns=[types.Content(role="user", parts=initial_prompt_parts)],
                turn_complete=True
            )

            # Task 1: Receive all messages from Gemini and forward to client
            async def receive_from_gemini():
                nonlocal session_alive
                try:
                    # Single loop to handle all incoming messages from Gemini
                    async for response in session.receive():
                        if not session_alive:
                            break
                            
                        if response.server_content:
                            server_content = response.server_content
                            
                            if server_content.interrupted:
                                try:
                                    await websocket.send_json({"type": "interrupted"})
                                except:
                                    session_alive = False
                                    break
                                continue
                            
                            if server_content.model_turn:
                                generated_text = ""
                                generated_audio_base64 = ""
                                for part in server_content.model_turn.parts:
                                    if part.inline_data:
                                        audio_bytes = part.inline_data.data
                                        generated_audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
                                    if part.text:
                                        generated_text += part.text
                                
                                # Send one combined message to the frontend
                                if generated_text or generated_audio_base64:
                                    try:
                                        await websocket.send_json({
                                            "type": "audioResponse",
                                            "description": generated_text,
                                            "audioBase64": generated_audio_base64
                                        })
                                    except:
                                        session_alive = False
                                        break

                        if response.setup_complete:
                            print("✅ Gemini setup complete.", flush=True)
                                    
                except asyncio.CancelledError:
                    print("➡️ Gemini receive loop cancelled.", flush=True)
                except Exception as e:
                    print(f"❌ Gemini Receive Loop Error: {e}", flush=True)
                    traceback.print_exc()
                    session_alive = False

            # Task 2: Receive all messages from client and forward to Gemini
            async def forward_to_gemini():
                nonlocal session_alive
                audio_chunk_count = 0
                frame_count = 0
                try:
                    while session_alive:
                        try:
                            data = await websocket.receive_json()
                        except WebSocketDisconnect:
                            print("🔌 Client disconnected, stopping forwarder.", flush=True)
                            session_alive = False
                            break

                        if not session_alive: break

                        data_type = data.get("type")
                        try:
                            if data_type == "audio":
                                audio_bytes = base64.b64decode(data["audioBase64"])
                                audio_chunk_count += 1
                                if audio_chunk_count % 50 == 0:
                                    print(f"🎤 Audio chunks sent: {audio_chunk_count}", flush=True)
                                await session.send_realtime_input(
                                    media=types.Blob(data=audio_bytes, mime_type="audio/pcm;rate=16000")
                                )
                            elif data_type == "frame":
                                frame_bytes = base64.b64decode(data["frameBase64"])
                                frame_count += 1
                                if frame_count % 10 == 0:
                                    print(f"📹 Video frames sent: {frame_count}", flush=True)
                                await session.send_realtime_input(
                                    media=types.Blob(data=frame_bytes, mime_type="image/jpeg")
                                )
                            elif data_type == "speech_start":
                                print("🎤 User started speaking, interrupting model.", flush=True)
                                await session.send_client_content(turn_complete=False)
                            elif data_type == "end_of_turn":
                                print("🤫 User stopped speaking, signaling turn complete.", flush=True)
                                await session.send_client_content(turn_complete=True)
                        except Exception as e:
                            print(f"⚠️ Failed to send to Gemini: {e}", flush=True)
                            if "closed" in str(e).lower() or "1011" in str(e):
                                print("❌ Fatal session error, stopping forwarder.", flush=True)
                                session_alive = False
                                break
                except asyncio.CancelledError:
                    print("➡️ Client forwarder loop cancelled.", flush=True)
                except Exception as e:
                    print(f"❌ Client Forwarder Loop Error: {e}", flush=True)
                    traceback.print_exc()
                    session_alive = False

            # Create and run the concurrent tasks
            receive_task = asyncio.create_task(receive_from_gemini())
            forward_task = asyncio.create_task(forward_to_gemini())

            # Wait for either task to finish (which indicates an error or disconnect)
            done, pending = await asyncio.wait(
                [receive_task, forward_task],
                return_when=asyncio.FIRST_COMPLETED
            )

            # Clean up: cancel the other pending task(s)
            for task in pending:
                task.cancel()
            
            # Wait for the cancellation to propagate
            await asyncio.gather(*pending, return_exceptions=True)
            
            print("🔌 Session cleanup complete", flush=True)        

    except Exception as e:
        print(f"🔥 CRITICAL WEBSOCKET CRASH: {e}", flush=True)
        traceback.print_exc()
    finally:
        try:
            await websocket.close(code=1011)
        except:
            pass
