import os
import asyncio
import base64
import traceback
import uuid
import json
import time
import math
from datetime import datetime
import pytz

# Email Imports
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

# Email Configurations
SENDER_EMAIL = "driftshieldai@gmail.com"
										   
GMAIL_SECRET_ID = os.environ.get("GMAIL_SECRET_ID", f"projects/{PROJECT_ID}/secrets/gmail-oauth-creds/versions/latest")

db = firestore.Client(project=PROJECT_ID)
storage_client = storage.Client(project=PROJECT_ID)
bucket = storage_client.bucket(BUCKET_NAME)
client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)

def haversine_distance(lat1, lon1, lat2, lon2):
    """Calculate distance in meters between two GPS coordinates."""
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

@router.websocket("/api/live/ws/live/process-stream")
async def websocket_endpoint(websocket: WebSocket):
  await websocket.accept()
  print("🔌 Client connected to Live Stream", flush=True)

  session_alive = True
  shared_context = {"latest_frame_bytes": None, "current_location": None, "last_distance": None}
  ai_last_spoke_time = 0 

  try:
    # 1️⃣ Validate Token & User Setup
    token = websocket.query_params.get("token")
    try:
      payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
      user_id = payload.get("userId", "Unknown") 
    except Exception as e:
      print("❌ Invalid Token")
      await websocket.close(code=1008)
      return

    user_name = user_id
    emergency_email = None
    
    if user_id != "Unknown":
      user_doc = db.collection("users").document(user_id).get()
      if user_doc.exists:
        user_data = user_doc.to_dict()
        user_name = user_data.get("name", user_id)
        emergency_email = user_data.get("emergencyEmail")

    # Pre-fetch saved photos to cache them for fast location checking in the background
    def fetch_saved_photos():
       return [d.to_dict() for d in db.collection("users").document(user_id).collection("photos").stream()]
    
    saved_photos_cache = await asyncio.to_thread(fetch_saved_photos)

    # 2️⃣ Tools Definition
    agent_tools = types.Tool(
      function_declarations=[
        types.FunctionDeclaration(
          name="check_past_history",
          description="Call this immediately when the stream starts or when the background changes to identify the user's location or the people they are with.",
          parameters=types.Schema(
            type="OBJECT",
            properties={
              "what_you_see": types.Schema(type="STRING", description="Describe the background, room, or person in the video.")
            },
            required=["what_you_see"]
          )
        ),
        types.FunctionDeclaration(
          name="fetch_specific_memory_image",
          description="Fetches the actual image of a past memory for direct visual comparison. Call this if you need to visually verify faces or objects due to changes in appearance.",
          parameters=types.Schema(
            type="OBJECT",
            properties={
              "filename": types.Schema(type="STRING", description="The exact filename of the memory.")
            },
            required=["filename"]
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
          description="Sends an emergency alert email to the user's caregiver. Call immediately if user needs help or is lost.",
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

    current_time_str = datetime.now(pytz.UTC).strftime("%I:%M %p on %A, %B %d, %Y")

		
    # 3️⃣ Highly Advanced System Instruction
    system_instruction = f"""You are GuardianMind, a proactive and caring AI guardian for a user with memory loss.

User name: {user_name}
Current Date & Time: {current_time_str}

CRITICAL BEHAVIORAL RULES:
1. **VISUAL TRUTH:** Your absolute source of truth is the LIVE VIDEO. Never guess a name or place. 
2. **PROACTIVE SCANNING:** When the stream first starts, you will receive an image with the initial greeting. Immediately call the `check_past_history` tool to identify the location. Also, call this tool whenever the background in the video feed changes significantly. 
3. NEVER say "I don't see this in your stored memories" UNLESS you have successfully called the tool and received a response. Do not hallucinate the database check.
4. **COMPARE:** Compare the live video to the "Visual Fingerprints" returned by the tool.
5. **KNOWN LOCATIONS:** If there is a clear visual match with the database, state it warmly.Say the description stored in database. (e.g., "Hello {user_name}, you are in the kitchen"). Do not over-describe surroundings if there is a match.
6. **UNKNOWN LOCATIONS (Person checking with image):** If `check_past_history` returns a text description for a person but you are not 100% sure because of visual changes, use the `fetch_specific_memory_image` tool to look at the actual photo.
7. **UNKNOWN LOCATIONS (The Discovery Flow):** If there is NO match in the database for the current location, follow these exact steps:
   - Step A: Gently ask the user: "It looks like you are at a new place right now. Do you recognize this area?"
   - Step B: If the user says NO, ask them: "Would you like me to try to recognize where you are, or do you need some help?"
   - Step C: If they ask you to try to recognize it, use your general knowledge to describe the surroundings in the live video (e.g., "Based on what I see, it looks like you are in a grocery store aisle near the fresh produce").
   - Step D: If they say they need help, immediately follow the Emergency rule below.
8. **LOCATION TRACKING (NEW RULES):** You will periodically receive hidden messages regarding the user's GPS coordinates and movement. 
  - If the prompt tells you the user is at an **UNKNOWN** location, you MUST proactively tell the user they are at a new location, do you recognize this area?
  - if user don't recognise then inform them of the nearest known place (from the prompt data)"
  - If the prompt says the user is moving **CLOSER** to a known location, encourage them warmly.
  - If the prompt says the user is wandering **FURTHER AWAY** from a known location, you MUST warn them immediately.
9. **SILENCE IS GOLDEN:** If the system notification says the user is safe at a known place, DO NOT acknowledge the notification. REMAIN COMPLETELY SILENT unless the user speaks to you first. Do not say "You are at the same place".
10. **SAVING MEMORIES (STRICT FLOW):** Don't store photo until user asks you explicitly.If the user asks you to save or remember a memory, YOU ARE FORBIDDEN from guessing a description. You MUST follow these exact steps:
  - Step 1: Ask the user: "What name or description would you like me to use for this memory?"
  - Step 2: STOP AND WAIT for the user to answer.
  - Step 3: Once they provide a description, CONFIRM IT: "I will save this as '[Description]'. Is that correct?"
   - Step 4: If they say NO to the confirmation, ask if they want to change the description or skip saving.
   - Step 5: If they say YES to the confirmation, say: "I am saving this memory now, please wait a moment."
   - Step 6: call the `save_new_memory` tool with their description.
  - Step 7: Don't store photo without user consent.
11. **EMERGENCY:** If the user asks for help or is lost, immediately call `send_emergency_email`.
12. **SUNDOWNING AWARENESS:** Pay attention to the Current Date & Time. If it is late at night (e.g., 10:00 PM to 5:00 AM) and the user seems confused, be extra soothing and proactively offer to call their caregiver.																																																					   
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
        nonlocal session_alive, ai_last_spoke_time
        try:
          while session_alive:
            async for response in session.receive():
              if not session_alive: break
               
													  
              if getattr(response, "tool_call", None):
                function_responses = [] 
                 
                for fc in response.tool_call.function_calls:
                  args_dict = fc.args if isinstance(fc.args, dict) else dict(fc.args)
                   
																   
                  if fc.name == "check_past_history":
                    try:
																																																				  
                      memories_context = [f"Label: {d.get('description', '')}\nFilename: {d.get('filename', '')}\nDetails: {d.get('geminiDescription', '')}" for d in saved_photos_cache]
																																			 
                      if memories_context:
                        tool_result = "DATABASE KNOWLEDGE BASE:\n" + "\n---\n".join(memories_context) + "\n\nCRITICAL INSTRUCTION: ONLY declare a match if the LIVE VIDEO perfectly aligns with the 'Details' above."
                      else:
                        tool_result = "Database is empty. You are looking at an unknown location/person."
                    except Exception as e:
                      tool_result = f"Database error: {e}"
                       
                    function_responses.append(types.Part.from_function_response(name=fc.name, response={"result": tool_result}))

																																
                  elif fc.name == "fetch_specific_memory_image":
                    filename = args_dict.get("filename", "")
																																																																			   
										
                    def download_image():
                      return bucket.blob(filename).download_as_bytes()
                       
                    try:
                      img_bytes = await asyncio.to_thread(download_image)
                      function_responses.append(types.Part.from_function_response(name=fc.name, response={"result": "I have attached the original photo below. Compare it to the live stream right now!"}))
                      function_responses.append(types.Part.from_bytes(data=img_bytes, mime_type="image/jpeg"))
                    except Exception as e:
																																											
                      function_responses.append(types.Part.from_function_response(name=fc.name, response={"result": f"Could not load image. Decide based on text."}))

																	 
                  elif fc.name == "save_new_memory":
                    description = args_dict.get("description", "New Memory")
                     
										
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

                        prompt = f"""Detailed description of this image, initially labeled as: '{description}'. Describe permanent visual features(eyes, skin, scars). Do not rely heavily on clothing.
                                                If it is an object/place, describe unique identifying features and colors."""
																																																			   
																															 
                        ai_response = await client.aio.models.generate_content(
                          model='gemini-2.5-flash',
                          contents=[prompt, types.Part.from_bytes(data=frame_bytes, mime_type="image/jpeg")]
                        )
                         
                        def save_to_fs():
                          doc_payload = {
                            "userId": user_id,
                            "description": description,
                            "geminiDescription": ai_response.text,
                            "photoDate": datetime.utcnow().strftime("%Y-%m-%d"),
                            "imageUrl": filename,
                            "filename": filename,
                            "uploadedAt": firestore.SERVER_TIMESTAMP
                          }
                          # Save location to memory if available
                          if shared_context["current_location"]:
                              doc_payload["location"] = {
                                  "latitude": shared_context["current_location"]["lat"],
                                  "longitude": shared_context["current_location"]["lng"]
                              }
                          db.collection('users').document(user_id).collection('photos').document(photo_id).set(doc_payload)

                        await asyncio.to_thread(save_to_fs)
                        
                        # Reload cache
                        saved_photos_cache.clear()
                        saved_photos_cache.extend(await asyncio.to_thread(fetch_saved_photos))

                        tool_result = f"Successfully saved memory."
                      except Exception as e:
                        tool_result = f"Failed to save: {e}"

                    function_responses.append(types.Part.from_function_response(name=fc.name, response={"result": tool_result}))

                  elif fc.name == "send_emergency_email":
                    if not emergency_email:
                        tool_result = "CRITICAL INSTRUCTION: You MUST speak EXACTLY these words: 'Sorry, I will not be able to help this time because there is no emergency email configured for your account.' Do not say anything else."
                        function_responses.append(types.Part.from_function_response(name=fc.name, response={"result": tool_result}))
                        continue

                    situation_summary = args_dict.get("situation_summary", "The user requested help.")
                    frame_to_send = shared_context["latest_frame_bytes"]
                    current_loc = shared_context["current_location"]

                    def send_email_task(image_bytes, loc_dict):
                      try:
                        sm_client = secretmanager.SecretManagerServiceClient()
                        response = sm_client.access_secret_version(request={"name": GMAIL_SECRET_ID})
                        payload = json.loads(response.payload.data.decode("UTF-8"))
                         
                        creds = Credentials(
                          token=payload.get('access_token'),
                          refresh_token=payload.get('refresh_token'),
                          token_uri="https://oauth2.googleapis.com/token",
                          client_id=payload.get('client_id'),
                          client_secret=payload.get('client_secret')
                        )
                        gmail_service = build('gmail', 'v1', credentials=creds)
                         
                        message = MIMEMultipart()
                        message['to'] = emergency_email
                        message['from'] = SENDER_EMAIL
                        message['subject'] = f"🚨 URGENT: GuardianMind Alert for {user_name}"

                        # Inject Location Link if available
                        loc_link = ""
                        if loc_dict:
                            loc_link = f"\n\nLive GPS Location Link:\nhttps://maps.google.com/?q={loc_dict['lat']},{loc_dict['lng']}"

                        text_content = f"EMERGENCY ALERT FOR {user_name}!\n\nAI Summary of Situation:\n{situation_summary}{loc_link}\n\nPlease check on them immediately."
                        message.attach(MIMEText(text_content, 'plain'))
                        if image_bytes:
                          image_part = MIMEImage(image_bytes, name="current_view.jpg")
                          message.attach(image_part)
                        raw_message = base64.urlsafe_b64encode(message.as_bytes()).decode()
                        gmail_service.users().messages().send(userId='me', body={'raw': raw_message}).execute()
                         
                        return "Emergency email with photo and location sent successfully to the caregiver."
                      except Exception as e:
                        return f"Failed to send email. Error: {str(e)}"

                    email_result = await asyncio.to_thread(send_email_task, frame_to_send, current_loc)
                     
                    ai_follow_up_command = email_result + "\nCRITICAL INSTRUCTION: You must now speak to the user and say exactly: 'Help is on the way.' Then comfort them."
                     
                    function_responses.append(types.Part.from_function_response(
                      name=fc.name, 
                      response={"result": ai_follow_up_command}
                    ))

                if function_responses:
                  await session.send_client_content(turns=[types.Content(role="user", parts=function_responses)], turn_complete=True)
                continue 
               
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
                      generated_text += part.text
                    if part.inline_data:
                      generated_audio_base64 = base64.b64encode(part.inline_data.data).decode("utf-8")
                       
                  if generated_text or generated_audio_base64:
                    try:
                      ai_last_spoke_time = time.time() 
                      await websocket.send_json({
                        "type": "audioResponse",
                        "description": generated_text,
                        "audioBase64": generated_audio_base64
                      })
                    except: session_alive = False

        except asyncio.CancelledError:
          pass
        except Exception as e:
          traceback.print_exc()
          session_alive = False

      async def forward_to_gemini():
        nonlocal session_alive, ai_last_spoke_time
        last_frame_time = 0
        last_heartbeat_time = time.time()
        user_is_speaking = False
        initial_greeting_sent = False
         
        try:
          # We will now send the initial prompt only AFTER the first frame is sent
          # to ensure the model has visual context before analyzing.
          
          while session_alive:
            try:
              data = await websocket.receive_json()
            except WebSocketDisconnect:
              session_alive = False
              break

            if not session_alive: break
            data_type = data.get("type")
             
            try:
              # Continuous location tracking update
              if data_type == "location" and "lat" in data and "lng" in data:
                  shared_context["current_location"] = {"lat": data["lat"], "lng": data["lng"]}

              elif data_type == "audio" and "audioBase64" in data:
                audio_bytes = base64.b64decode(data["audioBase64"])
                if audio_bytes.startswith(b'RIFF') or audio_bytes.startswith(b'\x1aE\xdf\xa3'):
                  continue
                await session.send_realtime_input(media=types.Blob(data=audio_bytes, mime_type="audio/pcm;rate=16000"))
                 
              elif data_type == "frame" and "frameBase64" in data:
                current_time = time.time()
                if current_time - last_frame_time >= 1:
                  last_frame_time = current_time
                  frame_bytes = base64.b64decode(data["frameBase64"])
                  shared_context["latest_frame_bytes"] = frame_bytes
                  await session.send_realtime_input(media=types.Blob(data=frame_bytes, mime_type="image/jpeg"))

                  # Send the initial greeting only once, after the first frame is sent.
                  if not initial_greeting_sent:
                    initial_greeting_sent = True
                    # This prompt is now sent *after* the first frame, ensuring the model has visual context.
                    initial_prompt = [types.Part(text=f"The stream has just started. Please greet the user, {user_name}.")]
                    await session.send_client_content(turns=[types.Content(role="user", parts=initial_prompt)], turn_complete=True)
                    print("✅ Sent initial greeting after first frame was sent.", flush=True)

                  # 15s Location Validation & Heartbeat Warning logic
                  if not user_is_speaking and (current_time - last_heartbeat_time >= 15.0) and (current_time - ai_last_spoke_time >= 15.0):
                    last_heartbeat_time = current_time
                    
                    loc_prompt_addition = ""
                    curr_loc = shared_context.get("current_location")
                    
                    if curr_loc and saved_photos_cache:
                        min_dist = float('inf')
                        nearest_name = "Unknown Memory Place"
                        
                        # Find nearest location
                        for p in saved_photos_cache:
                            if "location" in p:
                                dist = haversine_distance(curr_loc["lat"], curr_loc["lng"], p["location"]["latitude"], p["location"]["longitude"])
                                if dist < min_dist:
                                    min_dist = dist
                                    nearest_name = p.get("description", "a saved place")
                        
                        prev_dist = shared_context["last_distance"]
                        shared_context["last_distance"] = min_dist

                        if min_dist < 60: # Under 60 meters is basically "at the known place"
                           loc_prompt_addition = f" GPS validates user is currently AT known place: '{nearest_name}'."
                        elif min_dist != float('inf'): # More than 60m away = Wandering/Unknown
                           loc_prompt_addition = f" User is at an UNKNOWN GPS location. The nearest known place is '{nearest_name}' which is {int(min_dist)} meters away."
                           if prev_dist is not None:
                               if min_dist > prev_dist + 5: # Moving further out
                                   loc_prompt_addition += f" WARNING: The user is wandering FURTHER AWAY from {nearest_name}. You MUST verbally warn them that they are moving away from known areas."
                               elif min_dist < prev_dist - 5: # Heading back to safety
                                   loc_prompt_addition += f" The user is moving CLOSER to {nearest_name}. Encourage them that they are heading in the right direction."

                    hidden_prompt = f"[SYSTEM BACKGROUND CONTEXT]: {loc_prompt_addition} \nCRITICAL INSTRUCTION: If the user is safe and stationary, you MUST NOT reply to this prompt. Output absolutely nothing. Only speak if they are actively wandering, lost, or in danger."
																																																																																																																																																																																																
                    await session.send_client_content(
                      turns=[types.Content(role="user", parts=[types.Part(text=hidden_prompt)])],
                      turn_complete=True
                    )
															 
              elif data_type == "speech_start":
                user_is_speaking = True
                await session.send_client_content(turn_complete=False)
              elif data_type == "end_of_turn":
                user_is_speaking = False
                last_heartbeat_time = time.time()
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
    error_msg = str(e).lower()
								
    if "429" in error_msg or "resourceexhausted" in error_msg or "quota" in error_msg:
																														 
      try:
																	  
        await websocket.send_json({
          "type": "systemMessage", 
          "message": "I'm thinking a little too fast! Taking a quick breath..."
        })
																		 
        await websocket.close(code=4029) 
      except: pass
    else:
																	
      traceback.print_exc()
      try: await websocket.close(code=1011)
      except: pass
  finally:
    try: await websocket.close(code=1000)
    except: pass
