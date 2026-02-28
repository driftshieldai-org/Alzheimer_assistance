import os
import json
import base64
import asyncio
from datetime import datetime, timedelta

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from google.cloud import firestore
from google.cloud import storage
import jwt

from google import genai
from google.genai import types
from google.genai.types import HttpOptions

app = FastAPI()

# Initialize Firestore & Storage
db = firestore.Client(project=os.getenv("GCP_PROJECT_ID"))
storage_client = storage.Client(project=os.getenv("GCP_PROJECT_ID"))

bucket_name = os.getenv("GCS_BUCKET_NAME")
if not bucket_name:
    raise RuntimeError("🚨 GCS_BUCKET_NAME environment variable is missing.")

bucket = storage_client.bucket(bucket_name)

SYSTEM_INSTRUCTION = """
You are a polite, helpful AI assistant with a soft, calming tone.
You will be provided with reference photos of a user and their descriptions. 
As I stream live video to you, continuously observe the person in the live stream.
If the live stream MATCHES a reference photo, warmly greet them and politely state their description.
If the live stream DOES NOT MATCH, politely analyze the scene and provide a soft-spoken explanation of the background.
Keep your answers concise and respond exclusively using VOICE.
"""


async def get_gcs_file_as_base64(filename: str):
    blob = bucket.blob(filename)
    content = blob.download_as_bytes()
    return base64.b64encode(content).decode("utf-8")


@app.websocket("/api/live/ws/live/process-stream")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()

    token = ws.query_params.get("token")
    if not token:
        await ws.close(code=1008)
        return

    try:
        decoded = jwt.decode(
            token,
            os.getenv("JWT_SECRET"),
            algorithms=["HS256"]
        )
        user_id = decoded["userId"]
        print(f"🟢 JWT Verified for User: {user_id}")
    except Exception as e:
        print("JWT Verification Error:", str(e))
        await ws.close(code=1008)
        return

    try:
        # Fetch reference photos
        photos_ref = db.collection("users").document(user_id).collection("photos")
        docs = photos_ref.stream()

        reference_photos = []

        for doc in docs:
            photo_data = doc.to_dict()
            if photo_data.get("filename"):
                base64_image = await get_gcs_file_as_base64(photo_data["filename"])
                reference_photos.append({
                    "description": photo_data.get("description", "No description provided"),
                    "mimeType": "image/jpeg",
                    "data": base64_image
                })

        print(f"✅ Loaded {len(reference_photos)} reference photos.")

        # Create temporary Gemini token
       # client = genai.Client()

        #expire_time = (datetime.utcnow() + timedelta(minutes=30)).isoformat() + "Z"

        #auth_token = client.auth_tokens.create(
         #   config=types.AuthTokenConfig(
          #      uses=1,
           #     expire_time=expire_time,
            #    live_connect_constraints=types.LiveConnectConstraints(
             #       model="gemini-2.5-flash-native-audio-preview-12-2025",
              #      config=types.LiveConnectConfig(
               #         session_resumption={},
                #        temperature=0.7,
                 #       response_modalities=["AUDIO"]
                  #  )
                #),
                #http_options=types.HttpOptions(api_version="v1alpha")
            #)
        #)

        #print(f"✅ Token received: {auth_token.name}")

        #ai = genai.Client(api_key=auth_token.name)
        ai = genai.Client(http_options=HttpOptions(api_version="v1"))
        async with ai.live.connect(
            model="gemini-2.5-flash-native-audio-preview-12-2025",
            config=types.LiveConnectConfig(
                response_modalities=["AUDIO"],
                system_instruction=SYSTEM_INSTRUCTION
            )
        ) as session:

            print("✅ Connected to Gemini Live API")

            # Send reference photos
            for photo in reference_photos:
                await session.send_realtime_input(
                    media=[types.Blob(
                        mime_type=photo["mimeType"],
                        data=photo["data"]
                    )],
                    text=f"Reference Person Description: {photo['description']}"
                )

            # Handle incoming frames
            try:
                while True:
                    message = await ws.receive_text()
                    data = json.loads(message)

                    if data.get("type") == "frame":
                        await session.send_realtime_input(
                            media=[types.Blob(
                                mime_type="image/jpeg",
                                data=data["frameBase64"]
                            )]
                        )

                    # Receive AI responses
                    async for response in session.receive():
                        if response.server_content:
                            parts = response.server_content.model_turn.parts
                            generated_text = ""
                            generated_audio = ""

                            for part in parts:
                                if part.text:
                                    generated_text += part.text
                                if part.inline_data:
                                    generated_audio = part.inline_data.data

                            await ws.send_text(json.dumps({
                                "type": "audioResponse",
                                "description": generated_text,
                                "audioBase64": generated_audio
                            }))

            except WebSocketDisconnect:
                print("Client disconnected")

    except Exception as e:
        print("Live Stream Error:", str(e))
        await ws.close(code=1011)
