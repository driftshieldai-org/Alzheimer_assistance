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

    # Session state tracking
    session_alive = True
    
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

        # 3️⃣ Load memories as context text
        memories_context = []
        photos_ref = db.collection("users").document(user_id).collection("photos").stream()
        for doc in photos_ref:
            data = doc.to_dict()
            if "description" in data:
                description = data.get("description", "Unknown memory")
                date = data.get("photoDate", "Unknown date")
                memories_context.append(f"- {description} (Date: {date})")
        
        memories_text = "\n".join(memories_context) if memories_context else "No memories stored yet."

        # 4️⃣ System Instruction
        system_instruction = f"""You are MemoryMate, a caring AI assistant helping people with memory.

User name: {user_name}

User's stored memories:
{memories_text}

Instructions:
1. Greet the user warmly by name.
2. Listen to their voice and respond naturally.
3. When they show you something via camera, describe what you see.
4. If what they show matches a stored memory, remind them about it kindly.
5. Speak clearly, slowly, and with compassion.
6. Keep responses concise and helpful.
"""

        # 5️⃣ Gemini Live Config
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

        # 6️⃣ Connect to Gemini Live
        async with client.aio.live.connect(model=MODEL_ID, config=config) as session:
            print("🟢 Connected to Gemini Live")

            # Helper function to check if session is still alive
            def check_session_alive():
                nonlocal session_alive
                try:
                    # Check if the underlying connection is closed
                    if hasattr(session, '_ws') and session._ws:
                        if hasattr(session._ws, 'closed') and session._ws.closed:
                            session_alive = False
                    if hasattr(session, 'closed') and session.closed:
                        session_alive = False
                except Exception:
                    pass
                return session_alive

            # Send initial greeting prompt
            try:
                await session.send_client_content(
                    turns=[
                        types.Content(
                            role="user",
                            parts=[types.Part(text=f"Hello! I am {user_name}. Please greet me warmly.")]
                        )
                    ],
                    turn_complete=True
                )
                print("✅ Initial greeting sent")
            except Exception as e:
                print(f"❌ Failed to send initial greeting: {e}")
                session_alive = False
                await websocket.close(code=1011)
                return

            # Wait for the ACTUAL audio response to complete
            greeting_received = False
            try:
                async for response in session.receive():
                    if not check_session_alive():
                        print("❌ Session died while waiting for greeting")
                        break
                        
                    if response.server_content:
                        server_content = response.server_content
                        
                        # Process audio from greeting
                        if server_content.model_turn:
                            for part in server_content.model_turn.parts:
                                if part.inline_data:
                                    audio_bytes = part.inline_data.data
                                    b64_audio = base64.b64encode(audio_bytes).decode("utf-8")
                                    try:
                                        await websocket.send_json({
                                            "type": "audioResponse",
                                            "audioBase64": b64_audio
                                        })
                                        greeting_received = True
                                    except Exception as e:
                                        print(f"❌ Failed to send audio to client: {e}")
                                        session_alive = False
                                        break
                        
                        # Only break when turn is complete AND we received audio
                        if server_content.turn_complete and greeting_received:
                            print("✅ Greeting audio received, ready for realtime input")
                            break
                    
                    # Handle setup complete
                    if response.setup_complete:
                        print("✅ Setup complete")
                        
            except Exception as e:
                print(f"❌ Error receiving greeting: {e}")
                session_alive = False

            if not session_alive or not greeting_received:
                print("❌ Session not ready, closing connection")
                await websocket.close(code=1011)
                return

            # Small delay to ensure session is stable
            await asyncio.sleep(0.5)
            
            # Verify session is still alive after delay
            if not check_session_alive():
                print("❌ Session died after greeting")
                await websocket.close(code=1011)
                return

            print("🎤 Ready to receive realtime audio/video")

            # 7️⃣ Receive loop for ongoing responses
            async def receive_loop():
                nonlocal session_alive
                try:
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
                                for part in server_content.model_turn.parts:
                                    if part.inline_data:
                                        audio_bytes = part.inline_data.data
                                        b64_audio = base64.b64encode(audio_bytes).decode("utf-8")
                                        try:
                                            await websocket.send_json({
                                                "type": "audioResponse",
                                                "audioBase64": b64_audio
                                            })
                                        except:
                                            session_alive = False
                                            break
                                    if part.text:
                                        try:
                                            await websocket.send_json({
                                                "type": "textResponse",
                                                "text": part.text
                                            })
                                        except:
                                            session_alive = False
                                            break
                                            
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"❌ Receive Loop Error: {e}")
                    session_alive = False

            receive_task = asyncio.create_task(receive_loop())

            # 8️⃣ Process incoming audio/video from client
            audio_chunk_count = 0
            frame_count = 0
            last_health_check = asyncio.get_event_loop().time()
            
            try:
                while session_alive:
                    # Periodic health check every 5 seconds
                    current_time = asyncio.get_event_loop().time()
                    if current_time - last_health_check > 5:
                        if not check_session_alive():
                            print("❌ Session health check failed")
                            break
                        last_health_check = current_time
                    
                    try:
                        # Use timeout to allow periodic health checks
                        data = await asyncio.wait_for(
                            websocket.receive_json(),
                            timeout=1.0
                        )
                    except asyncio.TimeoutError:
                        # No data received, continue loop for health check
                        continue
                    except WebSocketDisconnect:
                        print("🔌 Client disconnected")
                        break

                    if data["type"] == "audio":
                        if not session_alive:
                            break
                        try:
                            audio_bytes = base64.b64decode(data["audioBase64"])
                            audio_chunk_count += 1
                            
                            if audio_chunk_count % 50 == 0:
                                print(f"🎤 Audio chunks sent: {audio_chunk_count}")
                            
                            await session.send_realtime_input(
                                media=types.Blob(
                                    data=audio_bytes,
                                    mime_type="audio/pcm;rate=16000"
                                )
                            )
                        except Exception as e:
                            print(f"⚠️ Failed to send audio chunk: {e}")
                            # Check if it's a fatal error
                            if "closed" in str(e).lower() or "1011" in str(e) or "timeout" in str(e).lower():
                                print("❌ Fatal session error, stopping")
                                session_alive = False
                                break

                    elif data["type"] == "frame":
                        if not session_alive:
                            break
                        try:
                            frame_bytes = base64.b64decode(data["frameBase64"])
                            frame_count += 1
                            
                            if frame_count % 10 == 0:
                                print(f"📹 Video frames sent: {frame_count}")
                            
                            await session.send_realtime_input(
                                media=types.Blob(
                                    data=frame_bytes,
                                    mime_type="image/jpeg"
                                )
                            )
                        except Exception as e:
                            print(f"⚠️ Failed to send video frame: {e}")
                            # Check if it's a fatal error
                            if "closed" in str(e).lower() or "1011" in str(e) or "timeout" in str(e).lower():
                                print("❌ Fatal session error, stopping")
                                session_alive = False
                                break

            except WebSocketDisconnect:
                print("🔌 Client disconnected")
            except Exception as e:
                print(f"❌ Error in main loop: {e}")
            finally:
                session_alive = False
                receive_task.cancel()
                try:
                    await receive_task
                except asyncio.CancelledError:
                    pass
                print("🔌 Session
