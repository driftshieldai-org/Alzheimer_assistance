import os
import asyncio
import base64
import traceback

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types
from google.cloud import firestore
import jose.jwt as jwt

router = APIRouter()

PROJECT_ID = os.environ.get("GCP_PROJECT_ID")
LOCATION = os.environ.get("GCP_REGION", "us-central1")
JWT_SECRET = os.environ.get("JWT_SECRET", "fallback_secret_for_dev")

db = firestore.Client(project=PROJECT_ID)
client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)

@router.websocket("/api/live/ws/live/process-stream")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🔌 Client connected to Live Stream", flush=True)

    session_alive = True
    
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

        # 2️⃣ Tool Definition
        history_tool = types.Tool(
            function_declarations=[
                types.FunctionDeclaration(
                    name="check_past_history",
                    description="CRITICAL: You MUST call this tool whenever the user asks 'What is this?', 'Do you recognize this?', or asks about their past.",
                    parameters=types.Schema(
                        type="OBJECT",
                        properties={
                            "what_you_see": types.Schema(
                                type="STRING",
                                description="Describe exactly what you see in the live video."
                            )
                        },
                        required=["what_you_see"]
                    )
                )
            ]
        )

        # 3️⃣ Aggressive System Instruction
        system_instruction = f"""You are MemoryMate, a caring AI assistant helping people with memory.

User name: {user_name}

Instructions:
1. Greet the user warmly by name.
2. You are receiving a LIVE VIDEO STREAM. Look at it constantly.
3. **MANDATORY RULE:** If the user asks you to identify an object, place, or person (e.g. "What is this?", "Do you know this?"), you MUST call the `check_past_history` tool FIRST.
4. When you call the tool, pass a description of what you see in the video.
5. NEVER say "I don't see this in your stored memories" UNLESS you have successfully called the tool and received a response. Do not hallucinate the database check.
6. The tool will return "Visual Fingerprints". Compare the live video to these text fingerprints.
7. IF MATCH FOUND: Say "Yes, I recognize that!" and share the memory label and date.
8. IF NO MATCH: Say "I don't see this in your stored memories," and then tell them what it is using general knowledge.
"""

        MODEL_ID = "gemini-live-2.5-flash-native-audio"  
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede")
                )
            ),
            system_instruction=types.Content(parts=[types.Part(text=system_instruction)]),
            tools=[history_tool] 
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
                            
                            # 🚨 THE FIX: Catching top-level tool_call from Live API!
                            if getattr(response, "tool_call", None):
                                for fc in response.tool_call.function_calls:
                                    if fc.name == "check_past_history":
                                        # Use standard dictionary parsing to safely extract args
                                        args_dict = fc.args if isinstance(fc.args, dict) else dict(fc.args)
                                        what_you_see = args_dict.get("what_you_see", "")
                                        
                                        print(f"\n==========================================")
                                        print(f"🛠️ [TOOL TRIGGERED] Gemini called history!")
                                        print(f"👁️  Gemini sees: '{what_you_see}'")
                                        print(f"==========================================\n", flush=True)
                                        
                                        def fetch_db():
                                            return [doc.to_dict() for doc in db.collection("users").document(user_id).collection("photos").stream()]
                                        
                                        try:
                                            photos_data = await asyncio.to_thread(fetch_db)
                                            memories_context = []
                                            for data in photos_data:
                                                user_desc = data.get("description", "Unknown")
                                                ai_desc = data.get("geminiDescription", "No details")
                                                date = data.get("photoDate", "Unknown date")
                                                memories_context.append(f"Label: {user_desc} (Date: {date})\nVisual Details: {ai_desc}")
                                            
                                            if memories_context:
                                                tool_result = "Compare your 'what_you_see' to these:\n\n" + "\n---\n".join(memories_context)
                                            else:
                                                tool_result = "No past memories found."
                                        except Exception as e:
                                            print(f"❌ DB Error: {e}")
                                            tool_result = "Database error."

                                        print("✅ [TOOL] Sending results back to Gemini...", flush=True)
                                        
                                        # Properly send the function response back
                                        await session.send_client_content(
                                            turns=[types.Content(
                                                role="user",
                                                parts=[types.Part.from_function_response(
                                                    name="check_past_history",
                                                    response={"result": tool_result}
                                                )]
                                            )],
                                            turn_complete=True
                                        )
                                continue # Done processing tool calls for this response
                            
                            # 🟢 Standard Text & Audio Handling
                            if response.server_content:
                                server_content = response.server_content
                                
                                if server_content.interrupted:
                                    try:
                                        await websocket.send_json({"type": "interrupted"})
                                    except:
                                        session_alive = False
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
                                        except Exception as e:
                                            session_alive = False

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
                                await session.send_realtime_input(media=types.Blob(data=base64.b64decode(data["frameBase64"]), mime_type="image/jpeg"))
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
        try:
            await websocket.close(code=1000)
        except: pass
