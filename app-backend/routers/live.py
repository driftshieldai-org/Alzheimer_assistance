import os
import asyncio
import base64
import traceback
import uuid
from datetime import datetime

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
client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)

@router.websocket("/api/live/ws/live/process-stream")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🔌 Client connected to Live Stream", flush=True)

    session_alive = True
    
    # 🧠 Shared context to store the most recent video frame for the save tool
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

        # 2️⃣ Tools Definition (Now includes TWO tools)
        agent_tools = types.Tool(
            function_declarations=[
                types.FunctionDeclaration(
                    name="check_past_history",
                    description="CRITICAL: Call this tool whenever the user asks 'What is this?', 'Do you recognize this?', or asks about their past.",
                    parameters=types.Schema(
                        type="OBJECT",
                        properties={
                            "what_you_see": types.Schema(type="STRING", description="Describe exactly what you see in the live video.")
                        },
                        required=["what_you_see"]
                    )
                ),
                types.FunctionDeclaration(
                    name="save_new_memory",
                    description="Saves the current video frame as a new memory. Call this ONLY AFTER confirming the description with the user.",
                    parameters=types.Schema(
                        type="OBJECT",
                        properties={
                            "description": types.Schema(type="STRING", description="The description the user confirmed for this new memory.")
                        },
                        required=["description"]
                    )
                )
            ]
        )

        # 3️⃣ Aggressive System Instruction with New Conversation Flow
        system_instruction = f"""You are MemoryMate, a caring AI assistant helping people with memory.

User name: {user_name}

Instructions:
1. Greet the user warmly by name. Look
 constantly at the LIVE VIDEO STREAM.
2. If the user asks you to identify an object, place, or person, you MUST call the `check_past_history` tool FIRST.
3. Compare the live video to the "Visual Fingerprints" returned by the tool.
4. IF MATCH FOUND: Say "Yes, I recognize that!" and share the memory label and date.
5. IF NO MATCH (The New Memory Flow):
   - Step A: Say "I don't see this in your stored memories," and tell them what it is using general knowledge.
   - Step B: Immediately ask: "Would you like me to save this to your memories?"
   - Step C: If they say NO, say "Okay!" and continue normally.
   - Step D: If they say YES, ask: "What description or name should I save it under?"
   - Step E: Once they provide a description, CONFIRM IT: "I will save this as '[Description]'. Is that correct?"
   - Step F: If they say NO to the confirmation, ask if they want to change the description or skip saving.
   - Step G: If they say YES to the confirmation, call the `save_new_memory` tool with their description.
6. After the `save_new_memory` tool returns success, confirm it: "I have successfully saved this memory for you!"
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

            # Task 1: Receive from Gemini
            async def receive_from_gemini():
                nonlocal session_alive
                try:
                    while session_alive:
                        async for response in session.receive():
                            if not session_alive: break
                            
                            # 🚨 Catching Tool Calls
                            if getattr(response, "tool_call", None):
                                function_responses = [] # Collect all responses
                                
                                for fc in response.tool_call.function_calls:
                                    args_dict = fc.args if isinstance(fc.args, dict) else dict(fc.args)
                                    
                                    # 🛠️ TOOL 1: CHECK HISTORY
                                    if fc.name == "check_past_history":
                                        what_you_see = args_dict.get("what_you_see", "")
                                        print(f"🛠️ [TOOL] Checking history for: '{what_you_see}'", flush=True)
                                        
                                        def fetch_db():
                                            return [doc.to_dict() for doc in db.collection("users").document(user_id).collection("photos").stream()]
                                        
                                        try:
                                            photos_data = await asyncio.to_thread(fetch_db)
                                            memories_context = [f"Label: {d.get('description', '')} (Date: {d.get('photoDate', '')})\nDetails: {d.get('geminiDescription', '')}" for d in photos_data]
                                            
                                            tool_result = "Compare your 'what_you_see' to these:\n" + "\n---\n".join(memories_context) if memories_context else "No past memories found."
                                        except Exception as e:
                                            tool_result = f"Database error: {e}"
                                            
                                        function_responses.append(types.Part.from_function_response(name=fc.name, response={"result": tool_result}))

                                    # 🛠️ TOOL 2: SAVE NEW MEMORY
                                    elif fc.name == "save_new_memory":
                                        description = args_dict.get("description", "New Memory")
                                        print(f"💾 [TOOL] Saving new memory: '{description}'", flush=True)
                                        
                                        if not shared_context["latest_frame_bytes"]:
                                            tool_result = "Failed: No video frame available. Ask the user to point the camera at the object again."
                                        else:
                                            try:
                                                frame_bytes = shared_context["latest_frame_bytes"]
                                                photo_id = str(uuid.uuid4())
                                                filename = f"photos/{user_id}/{photo_id}.jpg"
                                                current_date = datetime.utcnow().strftime("%Y-%m-%d")

                                                # 1. Upload to GCS
                                                def upload_to_gcs():
                                                    blob = bucket.blob(filename)
                                                    blob.upload_from_string(frame_bytes, content_type="image/jpeg")
                                                await asyncio.to_thread(upload_to_gcs)

                                                # 2. Generate Detailed AI Description
                                                prompt = f"""The user provided this short description: '{description}'.
                                                Provide a highly detailed visual description of this exact image. 
                                                CRITICAL INSTRUCTION: If this contains a person, focus heavily on permanent facial/physical features (hair, eyes, skin, scars). Do not rely heavily on clothing.
                                                If it is an object/place, describe unique identifying features and colors."""
                                                
                                                ai_response = await client.aio.models.generate_content(
                                                    model='gemini-2.5-flash',
                                                    contents=[prompt, types.Part.from_bytes(data=frame_bytes, mime_type="image/jpeg")]
                                                )
                                                gemini_desc = ai_response.text

                                                # 3. Save to Firestore
                                                def save_to_fs():
                                                    db.collection('users').document(user_id).collection('photos').document(photo_id).set({
                                                        "userId": user_id,
                                                        "description": description,
                                                        "geminiDescription": gemini_desc,
                                                        "photoDate": current_date,
                                                        "imageUrl": filename,
                                                        "filename": filename,
                                                        "uploadedAt": firestore.SERVER_TIMESTAMP
                                                    })
                                                await asyncio.to_thread(save_to_fs)
                                                
                                                tool_result = f"Successfully saved memory '{description}' to the database."
                                            except Exception as e:
                                                print(f"❌ Save Error: {e}", flush=True)
                                                tool_result = f"Failed to save due to system error"

                                        function_responses.append(types.Part.from_function_response(name=fc.name, response={"result": tool_result}))

                                # Send all tool responses back to Gemini
                                if function_responses:
                                    await session.send_client_content(
                                        turns=[types.Content(role="user", parts=function_responses)],
                                        turn_complete=True
                                    )
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
                                            await websocket.send_json({
                                                "type": "audioResponse",
                                                "description": generated_text,
                                                "audioBase64": generated_audio_base64
                                            })
                                        except: session_alive = False

                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"❌ Receive Loop Error: {e}", flush=True)
                    traceback.print_exc()
                    session_alive = False

            # Task 2: Receive from Client & Forward
            async def forward_to_gemini():
                nonlocal session_alive
                try:
                    initial_prompt = [types.Part(text=f"Hello! I am {user_name}. Please greet me warmly.")]
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
                                # 📸 Store the latest frame here so the Save Tool can grab it!
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
