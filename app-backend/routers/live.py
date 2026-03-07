import os
import asyncio
import base64
import traceback
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types
from google.cloud import firestore
from google.cloud import storage
from jose import jwt

router = APIRouter()

PROJECT_ID = os.environ.get("GCP_PROJECT_ID")
LOCATION = os.environ.get("GCP_REGION", "us-central1")
BUCKET_NAME = os.environ.get("GCS_BUCKET_NAME")
JWT_SECRET = os.environ.get("JWT_SECRET", "fallback_secret_for_dev")

db = firestore.Client(project=PROJECT_ID)
storage_client = storage.Client(project=PROJECT_ID)
bucket = storage_client.bucket(BUCKET_NAME)
client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)

def get_gcs_base64(filename):
    blob = bucket.blob(filename)
    return base64.b64encode(blob.download_as_bytes()).decode('utf-8')

@router.websocket("/api/live/ws/live/process-stream")
async def websocket_endpoint(websocket: WebSocket):
    # Accept the connection first so we can send errors back if needed
    await websocket.accept()
    print("🔌 Client connected to Live Stream")

    try:
        # 1. Validate Token
        token = websocket.query_params.get("token")
        if not token:
            print("❌ No token provided in query params")
            await websocket.close(code=1008)
            return

        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            user_id = payload.get("userId")
            if not user_id:
                raise ValueError("userId missing from token payload")
        except Exception as e:
            print(f"❌ Token Verification Error: {e}")
            await websocket.close(code=1008)
            return

        # 2. Load User Context
        print(f"👤 Loading context for user: {user_id}...")
        user_name = user_id
        user_doc = db.collection('users').document(user_id).get()
        if user_doc.exists:
            user_name = user_doc.to_dict().get('name', user_id)

        photos_ref = db.collection('users').document(user_id).collection('photos').stream()
        reference_photos = []
        
        for doc in photos_ref:
            data = doc.to_dict()
            if 'filename' in data:
                try:
                    b64 = get_gcs_base64(data['filename'])
                    reference_photos.append({
                        "data": b64,
                        "mime": "image/jpeg",
                        "desc": data.get('description', ''),
                        "date": data.get('photoDate', '')
                    })
                except Exception as e:
                    print(f"⚠️ Error reading photo {data['filename']}: {e}")

        # 3. Configure Gemini
        MODEL_ID = "gemini-live-2.5-flash-native-audio" 
        
        SYSTEM_INSTRUCTION = f"""
        You are MemoryMate. User: {user_name}.
        1. Greet the user warmly immediately.
        2. Listen to the user's voice and watch the video stream.
        3. If you see a photo match, mention the Date/Description.
        """

        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name="Aoede"
                    )
                )
            ),
            # ✅ FIXED TYPO HERE (Was SYSTEM_INSTR)
            system_instruction=types.Content(parts=[types.Part(text=SYSTEM_INSTRUCTION)])
        )

        # 4. Connect Loop
        async with client.aio.live.connect(model=MODEL_ID, config=config) as session:
            print(f"🟢 Connected to {MODEL_ID}")

            # Prepare Initial Context
            initial_parts = []
            for photo in reference_photos:
                text_part = f"Memory: {photo['desc']} on {photo['date']}"
                initial_parts.append(types.Part(text=text_part))
                initial_parts.append(types.Part(inline_data=types.Blob(
                    mime_type=photo['mime'],
                    data=base64.b64decode(photo['data'])
                )))
            
            initial_parts.append(types.Part(text=f"Hello, I am {user_name}. Please say hello."))

            # Send Context
            await session.send(
                input=initial_parts,
                end_of_turn=True
            )
            print("✅ Context sent. Mode: LISTENING")

            # TASK: Receive from Gemini
            async def receive_loop():
                try:
                    async for response in session.receive():
                        server_content = response.server_content
                        if server_content is None:
                            continue
                        
                        if server_content.interrupted:
                            await websocket.send_json({"type": "interrupted"})
                        
                        turn = server_content.model_turn
                        if turn:
                            for part in turn.parts:
                                if part.inline_data:
                                    b64_audio = base64.b64encode(part.inline_data.data).decode('utf-8')
                                    await websocket.send_json({
                                        "type": "audioResponse",
                                        "audioBase64": b64_audio
                                    })
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

            # MAIN LOOP: Receive from React
            try:
                while True:
                    data = await websocket.receive_json()
                    
                    if data['type'] == 'frame':
                        await session.send(
                            input=[types.Part(inline_data=types.Blob(
                                mime_type="image/jpeg",
                                data=base64.b64decode(data['frameBase64'])
                            ))],
                            end_of_turn=False
                        )
                    
                    elif data['type'] == 'audio':
                        await session.send(
                            input=[types.Part(inline_data=types.Blob(
                                mime_type="audio/pcm;rate=16000",
                                data=base64.b64decode(data['audioBase64'])
                            ))],
                            end_of_turn=False
                        )

            except WebSocketDisconnect:
                print("🔌 Client disconnected naturally")
            finally:
                receive_task.cancel()

    except Exception as e:
        # 🚨 THIS CATCHES EVERYTHING ELSE AND PRINTS IT TO CLOUD RUN
        print(f"🔥 CRITICAL WEBSOCKET CRASH: {e}")
        print(traceback.format_exc())
        try:
            await websocket.close(code=1011)
        except:
            pass
