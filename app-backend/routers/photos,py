import os
import uuid
from fastapi import APIRouter, UploadFile, File, Form, Depends, HTTPException
from google.cloud import firestore
from google.cloud import storage
from utils.auth import get_current_user_id

router = APIRouter(prefix="/api/photos", tags=["photos"])

# Clients
PROJECT_ID = os.environ.get("GCP_PROJECT_ID")
BUCKET_NAME = os.environ.get("GCS_BUCKET_NAME")
db = firestore.Client(project=PROJECT_ID)
storage_client = storage.Client(project=PROJECT_ID)
bucket = storage_client.bucket(BUCKET_NAME)

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
    
    # Upload to GCS
    try:
        blob = bucket.blob(filename)
        # Reset file pointer to beginning
        await photo.seek(0)
        content = await photo.read()
        blob.upload_from_string(content, content_type=photo.content_type)
    except Exception as e:
        print(f"GCS Upload Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload to storage")
    
    # Save to Firestore
    try:
        new_doc_ref = db.collection('users').document(user_id).collection('photos').document()
        new_doc_ref.set({
            "userId": user_id,
            "description": description,
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
