import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# Load .env locally
load_dotenv()

from routers import auth, photos, live

app = FastAPI()

# Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allow all origins for simplicity, tighten for prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include Routers
app.include_router(auth.router)
app.include_router(photos.router)
app.include_router(live.router)

@app.get("/health")
def health_check():
    return {"status": "Backend is running healthily!"}

if __name__ == "__main__":
    # Get PORT from Environment (Cloud Run sets this automatically)
    # If not set (Local), default to 5000 to match your React setup
    port = int(os.environ.get("PORT", 5000))
    
    print(f"🚀 Starting Server on Port {port}...")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
