import os
import uuid
from fastapi import APIRouter, UploadFile, File, Form, Depends, HTTPException
from google.cloud import firestore
from google.cloud import storage
from google import genai
from google.genai import types
from utils.auth import get_current_user_id

router = APIRouter(prefix="/api/photos", tags=["photos"])

# Clients
PROJECT_ID = os.environ.get("GCP_PROJECT_ID")
LOCATION = os.environ.get("GCP_REGION", "us-central1")
BUCKET_NAME = os.environ.get("GCS_BUCKET_NAME")

db = firestore.Client(project=PROJECT_ID)
storage_client = storage.Client(project=PROJECT_ID)
bucket = storage_client.bucket(BUCKET_NAME)

# Initialize Gemini Client for standard generation
genai_client = genai.Client(
    vertexai=True,
    project=PROJECT_ID,
    location=LOCATION
)

@router.post("/upload")
async def upload_photo(
    photo: UploadFile = File(...),
    description: str = Form(...),
    photoDate: str = Form(...),
    user_id: str = Depends(get_current_user_id)
):
    if not photo.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail="Only image files allowed")
        
    file_ext = photo.filename.split('.')[-1]
    filename = f"photos/{user_id}/{uuid.uuid4()}.{file_ext}"
    
    # Read file content once
    await photo.seek(0)
    content = await photo.read()
        
    # 1️⃣ Upload to GCS
    try:
        blob = bucket.blob(filename)
										 
						   
									
        blob.upload_from_string(content, content_type=photo.content_type)
    except Exception as e:
        print(f"GCS Upload Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload to storage")
        
    # 2️⃣ NEW: Generate detailed visual description with Gemini
    try:

		prompt = f"""The user provided this short description for the photo: '{description}'. 
        Please provide a highly detailed visual description of this exact image. 
        CRITICAL INSTRUCTION FOR PEOPLE: If this image contains a person, focus heavily on their permanent facial and physical features. Describe their facial structure, hair color and style, eye color, skin tone, facial hair, glasses, or distinctive marks (like moles or scars). DO NOT rely heavily on their clothing, as clothing changes.
        If it is an object or place, describe its unique identifying features, layout, and colors.
        This text will be used later by an AI to recognize this exact person, place, or object in a live video stream."""
        
        # Use aio (async) to prevent blocking the FastAPI server
        ai_response = await genai_client.aio.models.generate_content(
            model='gemini-2.5-flash',
            contents=[
                prompt,
                types.Part.from_bytes(data=content, mime_type=photo.content_type)
            ]
        )
        gemini_description = ai_response.text
        print(f"✅ Generated detailed Gemini description for {filename}")
    except Exception as e:
        print(f"⚠️ Gemini Vision Error during upload: {e}")
        # Fallback to the user's basic description if the AI fails
        gemini_description = description 
        
    # 3️⃣ Save to Firestore (Including the new geminiDescription)
    try:
        new_doc_ref = db.collection('users').document(user_id).collection('photos').document()
        new_doc_ref.set({
            "userId": user_id,
            "description": description,           # User's short description
            "geminiDescription": gemini_description, # AI's highly detailed visual description
            "photoDate": photoDate,
            "imageUrl": filename,
            "filename": filename,
            "uploadedAt": firestore.SERVER_TIMESTAMP
        })
        
        return {
            "message": "Photo uploaded successfully",
            "gcsObjectName": filename,
            "photoId": new_doc_ref.id
        }
    except Exception as e:
        print(f"Firestore Error: {e}")
        raise HTTPException(status_code=500, detail="Database error")
