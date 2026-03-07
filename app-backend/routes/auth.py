import os
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from google.cloud import firestore
from utils.auth import get_password_hash, verify_password, create_access_token

router = APIRouter(prefix="/api/auth", tags=["auth"])
db = firestore.Client(project=os.environ.get("GCP_PROJECT_ID"))

class UserSignup(BaseModel):
    name: str
    userId: str
    password: str

class UserLogin(BaseModel):
    userId: str
    password: str

@router.post("/signup", status_code=201)
async def signup(user: UserSignup):
    if not user.name or not user.userId or not user.password:
        raise HTTPException(status_code=400, detail="Missing fields")
    
    normalized_id = user.userId.lower()
    user_ref = db.collection('users').document(normalized_id)
    
    if user_ref.get().exists:
        raise HTTPException(status_code=400, detail="User ID already taken")
    
    hashed_pw = get_password_hash(user.password)
    
    user_ref.set({
        "name": user.name,
        "userId": normalized_id,
        "password": hashed_pw,
        "createdAt": firestore.SERVER_TIMESTAMP
    })
    
    token = create_access_token({"userId": normalized_id, "name": user.name})
    
    return {
        "message": "User created successfully",
        "token": token,
        "user": {"name": user.name, "userId": normalized_id}
    }

@router.post("/login")
async def login(user: UserLogin):
    if not user.userId or not user.password:
        raise HTTPException(status_code=400, detail="Missing fields")
    
    normalized_id = user.userId.lower()
    doc = db.collection('users').document(normalized_id).get()
    
    if not doc.exists:
        raise HTTPException(status_code=400, detail="Invalid credentials")
    
    user_data = doc.to_dict()
    
    if not verify_password(user.password, user_data.get("password")):
        raise HTTPException(status_code=400, detail="Invalid credentials")
    
    token = create_access_token({"userId": normalized_id, "name": user_data.get("name")})
    
    return {
        "message": "Login successful",
        "token": token,
        "user": {"name": user_data.get("name"), "userId": normalized_id}
    }
