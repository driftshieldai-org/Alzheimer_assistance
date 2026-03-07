import os
import asyncio
import base64
import traceback
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types
from google.cloud import firestore

router = APIRouter()

PROJECT_ID = os.environ.get("GCP_PROJECT_ID")
LOCATION = os.environ.get("GCP_REGION", "us-central1")
BUCKET_NAME = os.environ.get("GCS_BUCKET_NAME")
JWT_SECRET = os.environ.get("JWT_SECRET", "fallback_secret_for_dev")

db = firestore.Client(project=PROJECT_ID)
client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)

@router.websocket("/api/live/ws/live/process-stream")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🔌 Client connected to Live Stream")

    try:
        # 1. Validate Token
        token = websocket.query_params.get("token")
        import jose.jwt as jwt
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            user_id = payload.get("userId")
        except Exception as e:
            print(f"❌ Token Error: {e}")
            await websocket.close(code=1008)
            return

        # 2. Load User Info
        user_name = user_id
        user_doc = db.collection('users').document(user_id).get()
        if user_doc.exists:
            user_name = user_doc.to_dict().get('name', user_id)

        # 3. Build System Instructions (Inject GCS URLs directly!)
        # We don't download the images. We just tell Gemini where they are.
        # 3. Build System Instructions (TEXT ONLY!)
        system_parts = [
          types.Part.from_text(text=f"You are MemoryMate. User: {user_name}."),
          types.Part.from_text(text="1. Greet the user warmly.\n2. Listen to their voice and watch the video stream.\n3. Match their video against the stored memories provided in the first message.")
        ]
    
        # Collect photos to send in the FIRST user turn (Not system instructions)
        initial_prompt_parts = []
        photos_ref = db.collection('users').document(user_id).collection('photos').stream()
        for doc in photos_ref:
          data = doc.to_dict()
          if 'filename' in data:
            # Add Description
            initial_prompt_parts.append(types.Part.from_text(
              text=f"\nMemory: {data.get('description', 'Unknown')} on {data.get('photoDate', 'Unknown')}"
            ))
            # Add Image URL 
            initial_prompt_parts.append(types.Part.from_uri(
              file_uri=f"gs://{BUCKET_NAME}/{data['filename']}",
              mime_type="image/jpeg"
            ))
    
        # 4. Configure Gemini
        MODEL_ID = "gemini-live-2.5-flash-native-audio" 
         
        config = types.LiveConnectConfig(
          response_modalities=["AUDIO"],
          speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
              prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede")
            )
          ),
          # System instructions are now safely TEXT ONLY
          system_instruction=types.Content(parts=system_parts)
        )
    
        # 5. Connect Loop
        async with client.aio.live.connect(model=MODEL_ID, config=config) as session:
            print(f"🟢 Connected to {MODEL_ID}")
            
            # Add the spoken greeting to the end of our memory payload
            initial_prompt_parts.append(types.Part.from_text(
                text=f"Hello, I am {user_name}. Please say hello and acknowledge you have received my memories."
            ))
            
            # Send the images + greeting as the very first turn!
            await session.send(input=initial_prompt_parts, end_of_turn=True)
            print("✅ Ready. Mode: LISTENING")

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
            debug_audio_counter = 0
            
            try:
                while True:
                    data = await websocket.receive_json()
                    
                    # The newest Python SDK accepts a simple dictionary for media chunks
                    if data['type'] == 'frame':
                        await session.send(input={
                            "mime_type": "image/jpeg",
                            "data": base64.b64decode(data['frameBase64'])
                        })
                    
                    elif data['type'] == 'audio':
                        debug_audio_counter += 1
                        if debug_audio_counter % 50 == 0:
                            print(f"🎤 Audio Active: Received {debug_audio_counter} chunks")
                            
                        await session.send(input={
                            "mime_type": "audio/pcm;rate=16000",
                            "data": base64.b64decode(data['audioBase64'])
                        })

            except WebSocketDisconnect:
                print("🔌 Client disconnected naturally")
            finally:
                receive_task.cancel()

    except Exception as e:
        print(f"🔥 CRITICAL WEBSOCKET CRASH: {e}")
        print(traceback.format_exc())
        try:
            await websocket.close(code=1011)
        except:
            pass
