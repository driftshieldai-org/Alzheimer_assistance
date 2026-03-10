import os
import asyncio
import base64
import traceback
import uuid
import json
from datetime import datetime

# --- NEW EMAIL IMPORTS ---
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types
from google.cloud import firestore
from google.cloud import storage
from google.cloud import secretmanager
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import jose.jwt as jwt

router = APIRouter()

# --- Configurations & Clients ---
PROJECT_ID = os.environ.get("GCP_PROJECT_ID")
LOCATION = os.environ.get("GCP_REGION", "us-central1")
BUCKET_NAME = os.environ.get("GCS_BUCKET_NAME")
JWT_SECRET = os.environ.get("JWT_SECRET", "fallback_secret_for_dev")

# Email Configurations (Set these in your environment)
SENDER_EMAIL = "driftshieldai@gmail.com"
RECIPIENT_EMAIL = "driftshieldai@gmail.com"
GMAIL_SECRET_ID = os.environ.get("GMAIL_SECRET_ID", f"projects/{PROJECT_ID}/secrets/gmail_oauth_secret/versions/latest")

db = firestore.Client(project=PROJECT_ID)
storage_client = storage.Client(project=PROJECT_ID)
bucket = storage_client.bucket(BUCKET_NAME)
client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)

@router.websocket("/api/live/ws/live/process-stream")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🔌 Client connected to Live Stream", flush=True)

    session_alive = True
    shared_context = {"latest_frame_bytes": None}
    
    try:
        # 1️⃣ Validate Token & User
        token = websocket.query_params.get("token")
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            user_id = payload.get("userId", "Unknown") 
        except Exception as e:
            await websocket.close(code=1008)
            return

        user_name = user_id
        if user_id != "Unknown":
            user_doc = db.collection("users").document(user_id).get()
            if user_doc.exists:
                user_name = user_doc.to_dict().get("name", user_id)

        # 2️⃣ Tools Definition
        agent_tools = types.Tool(
            function_declarations=[
                types.FunctionDeclaration(
                    name="check_past_history",
                    description="Call this immediately when the stream starts or when the background changes to identify the user's location or the people they are with.",
                    parameters=types.Schema(
                        type="OBJECT",
                        properties={
                            "what_you_see": types.Schema(type="STRING", description="Describe the background, room, or person in the current video frame.")
                        },
                        required=["what_you_see"]
                    )
                ),
                types.FunctionDeclaration(
                    name="save_new_memory",
                    description="Saves a new memory to the database. ONLY call this if the user explicitly asks you to save or remember something.",
                    parameters=types.Schema(
                        type="OBJECT",
                        properties={
                            "description": types.Schema(type="STRING", description="The description the user provided for this memory.")
                        },
                        required=["description"]
                    )
                ),
                types.FunctionDeclaration(
                    name="send_emergency_email",
                    description="Sends an emergency alert email to the user's caregiver. Call this IMMEDIATELY if the user says they need help, are lost, or feel unsafe.",
                    parameters=types.Schema(
                        type="OBJECT",
                        properties={
                            "situation_summary": types.Schema(type="STRING", description="A summary of what the user is saying and what you see in the camera so the caregiver knows what is happening.")
                        },
                        required=["situation_summary"]
                    )
                )
            ]
        )

        # 3️⃣ Proactive Guardian System Instruction
        system_instruction = f"""You are MemoryMate, a proactive and caring AI guardian for a user with memory loss.

User name: {user_name}

CRITICAL BEHAVIORAL RULES:
1. **PROACTIVE SCANNING:** When the video stream starts, immediately look at the background/surroundings and call `check_past_history`.
2. **KNOWN LOCATIONS:** If the tool finds a match, state it warmly. (e.g., "Hello {user_name}, I see you are in your store room.")
3. **UNKNOWN LOCATIONS (WARNING):** If the tool finds NO MATCH for the background, you MUST warn them: "It looks like you are at an unknown place [or with an unknown person]. Do you recognize this place, or do you want any help?"
4. **CONTINUOUS MONITORING:** If they say "I know this place", acknowledge it and stay quiet. However, continue watching the stream. If they transition to a completely NEW unknown location, warn them again: "You seem to be moving away from your known locations. Do you recognize this new place, or need help?"
5. **EMERGENCY RESPONSE:** If the user ever says "Yes, I need help", "I am lost", or seems distressed, IMMEDIATELY call the `send_emergency_email` tool. 
6. **REACTIVE MEMORY SAVING:** DO NOT explicitly ask the user to save memories. ONLY call `save_new_memory` if the user explicitly commands you to (e.g., "Save this memory", "Remember this place"). If commanded, confirm their description, then save it.
"""

        MODEL_ID = "gemini-live-2.5-flash-native-audio"  
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede"))
            ),
            system_instruction=types.Content(parts=[types.Part(text=system_instruction)]),
            tools=[agent_tools] 
        )

        print("⏳ Connecting to Gemini Live...", flush=True)
        async with client.aio.live.connect(model=MODEL_ID, config=config) as session:
            print("🟢 Connected to Gemini Live", flush=True)
            session_alive = True

            async def receive_from_gemini():
                nonlocal session_alive
                try:
                    while session_alive:
                        async for response in session.receive():
                            if not session_alive: break
                            
                            # 🚨 Catching Tool Calls
                            if getattr(response, "tool_call", None):
                                function_responses = [] 
                                
                                for fc in response.tool_call.function_calls:
                                    args_dict = fc.args if isinstance(fc.args, dict) else dict(fc.args)
                                    
                                    # 🛠️ TOOL 1: CHECK HISTORY
                                    if fc.name == "check_past_history":
                                        what_you_see = args_dict.get("what_you_see", "")
                                        print(f"👁️ [TOOL] Scanning Background: '{what_you_see}'", flush=True)
                                        
                                        def fetch_db():
                                            return [doc.to_dict() for doc in db.collection("users").document(user_id).collection("photos").stream()]
                                        
                                        try:
                                            photos_data = await asyncio.to_thread(fetch_db)
                                            memories_context = [f"Label: {d.get('description', '')}\nDetails: {d.get('geminiDescription', '')}" for d in photos_data]
                                            tool_result = "Compare the background to these:\n" + "\n---\n".join(memories_context) if memories_context else "No past memories found."
                                        except Exception as e:
                                            tool_result = f"Database error: {e}"
                                            
                                        function_responses.append(types.Part.from_function_response(name=fc.name, response={"result": tool_result}))

                                    # 🛠️ TOOL 2: SAVE NEW MEMORY
                                    elif fc.name == "save_new_memory":
                                        description = args_dict.get("description", "New Memory")
                                        print(f"💾 [TOOL] Saving new memory: '{description}'", flush=True)
                                        
                                        if not shared_context["latest_frame_bytes"]:
                                            tool_result = "Failed: No video frame. Ask user to point the camera."
                                        else:
                                            try:
                                                frame_bytes = shared_context["latest_frame_bytes"]
                                                photo_id = str(uuid.uuid4())
                                                filename = f"photos/{user_id}/{photo_id}.jpg"

                                                def upload_to_gcs():
                                                    bucket.blob(filename).upload_from_string(frame_bytes, content_type="image/jpeg")
                                                await asyncio.to_thread(upload_to_gcs)

                                                prompt = f"""The user provided this short description: '{description}'.
                                                Provide a highly detailed visual description of this exact image. 
                                                CRITICAL INSTRUCTION: If this contains a person, focus heavily on permanent facial/physical features (hair, eyes, skin, scars). Do not rely heavily on clothing.
                                                If it is an object/place, describe unique identifying features and colors."""
                                                ai_response = await client.aio.models.generate_content(
                                                    model='gemini-2.5-flash',
                                                    contents=[prompt, types.Part.from_bytes(data=frame_bytes, mime_type="image/jpeg")]
                                                )
                                                
                                                def save_to_fs():
                                                    db.collection('users').document(user_id).collection('photos').document(photo_id).set({
                                                        "userId": user_id,
                                                        "description": description,
                                                        "geminiDescription": ai_response.text,
                                                        "photoDate": datetime.utcnow().strftime("%Y-%m-%d"),
                                                        "imageUrl": filename,
                                                        "filename": filename,
                                                        "uploadedAt": firestore.SERVER_TIMESTAMP
                                                    })
                                                await asyncio.to_thread(save_to_fs)
                                                tool_result = f"Successfully saved memory."
                                            except Exception as e:
                                                tool_result = f"Failed to save: {e}"

                                        function_responses.append(types.Part.from_function_response(name=fc.name, response={"result": tool_result}))

                                    # 🚨 TOOL 3: SEND EMERGENCY EMAIL WITH IMAGE
                                    elif fc.name == "send_emergency_email":
                                        situation_summary = args_dict.get("situation_summary", "The user requested help.")
                                        print(f"🆘 [EMERGENCY TOOL TRIGGERED] Sending email! Summary: {situation_summary}", flush=True)
                                        
                                        # Safely grab the latest frame before starting the thread
                                        frame_to_send = shared_context["latest_frame_bytes"]

                                        def send_email_task(image_bytes):
                                            try:
                                                # 1. Fetch Secrets
                                                sm_client = secretmanager.SecretManagerServiceClient()
                                                response = sm_client.access_secret_version(request={"name": GMAIL_SECRET_ID})
                                                payload = json.loads(response.payload.data.decode("UTF-8"))
                                                
                                                # 2. Build Credentials
                                                creds = Credentials(
                                                    token=payload.get('access_token'),
                                                    refresh_token=payload.get('refresh_token'),
                                                    token_uri="https://oauth2.googleapis.com/token",
                                                    client_id=payload.get('client_id'),
                                                    client_secret=payload.get('client_secret')
                                                )
                                                gmail_service = build('gmail', 'v1', credentials=creds)
                                                
                                                # 3. Create Multipart Email (Text + Image)
                                                message = MIMEMultipart()
                                                message['to'] = RECIPIENT_EMAIL
                                                message['from'] = SENDER_EMAIL
                                                message['subject'] = f"🚨 URGENT: MemoryMate Alert for {user_name}"

                                                # Add Text Body
                                                text_content = f"EMERGENCY ALERT FOR {user_name}!\n\nAI Summary of Situation:\n{situation_summary}\n\nPlease check on them immediately. See the attached image for their current visual perspective."
                                                message.attach(MIMEText(text_content, 'plain'))

                                                # Add Image Attachment if available
                                                if image_bytes:
                                                    image_part = MIMEImage(image_bytes, name="current_view.jpg")
                                                    message.attach(image_part)

                                                # Send
                                                raw_message = base64.urlsafe_b64encode(message.as_bytes()).decode()
                                                gmail_service.users().messages().send(userId='me', body={'raw': raw_message}).execute()
                                                
                                                return "Emergency email with photo sent successfully to the caregiver."
                                            except Exception as e:
                                                print(f"❌ Email Error: {e}")
                                                return f"Failed to send email. Error: {str(e)}"

                                        # Run the email sending in a background thread
                                        email_result = await asyncio.to_thread(send_email_task, frame_to_send)
                                        function_responses.append(types.Part.from_function_response(name=fc.name, response={"result": email_result}))

                                # Send all tool responses back to Gemini
                                if function_responses:
                                    await session.send_client_content(turns=[types.Content(role="user", parts=function_responses)], turn_complete=True)
                                continue 
                            
                            # 🟢 Standard Text & Audio Handling
                            if response.server_content:
                                server_content = response.server_content
                                
                                if server_content.interrupted:
                                    try: await websocket.send_json({"type": "interrupted"})
                                    except: session_alive = False
                                    continue
                                
                                if server_content.model_turn:
                                    generated_text = ""
                                    generated_audio_base64 = ""
                                    
                                    for part in server_content.model_turn.parts:
                                        if part.text:
                                            print(f"💬 [AI SPEAKING] {part.text.strip()}", flush=True)
                                            generated_text += part.text
                                        if part.inline_data:
                                            generated_audio_base64 = base64.b64encode(part.inline_data.data).decode("utf-8")
                                            
                                    if generated_text or generated_audio_base64:
                                        try:
                                            await websocket.send_json({"type": "audioResponse", "description": generated_text, "audioBase64": generated_audio_base64})
                                        except: session_alive = False

                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    traceback.print_exc()
                    session_alive = False

            # Task 2: Receive from Client & Forward
            async def forward_to_gemini():
                nonlocal session_alive
                try:
                    initial_prompt = [types.Part(text=f"Hello! I am {user_name}. Please greet me, and immediately look at my camera feed to tell me where I am.")]
                    await session.send_client_content(turns=[types.Content(role="user", parts=initial_prompt)], turn_complete=True)

                    while session_alive:
                        try:
                            data = await websocket.receive_json()
                        except WebSocketDisconnect:
                            session_alive = False
                            break

                        if not session_alive: break
                        data_type = data.get("type")
                        
                        try:
                            if data_type == "audio" and "audioBase64" in data:
                                await session.send_realtime_input(media=types.Blob(data=base64.b64decode(data["audioBase64"]), mime_type="audio/pcm;rate=16000"))
                            elif data_type == "frame" and "frameBase64" in data:
                                frame_bytes = base64.b64decode(data["frameBase64"])
                                shared_context["latest_frame_bytes"] = frame_bytes
                                await session.send_realtime_input(media=types.Blob(data=frame_bytes, mime_type="image/jpeg"))
                            elif data_type == "speech_start":
                                await session.send_client_content(turn_complete=False)
                            elif data_type == "end_of_turn":
                                await session.send_client_content(turn_complete=True)
                        except Exception as e:
                            if "closed" in str(e).lower() or "1011" in str(e):
                                session_alive = False
                                break
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    session_alive = False

            receive_task = asyncio.create_task(receive_from_gemini())
            forward_task = asyncio.create_task(forward_to_gemini())

            done, pending = await asyncio.wait([receive_task, forward_task], return_when=asyncio.FIRST_COMPLETED)
            for task in pending: task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    except Exception as e:
        print(f"🔥 CRITICAL WEBSOCKET CRASH: {e}", flush=True)
    finally:
        try: await websocket.close(code=1000)
        except: pass
