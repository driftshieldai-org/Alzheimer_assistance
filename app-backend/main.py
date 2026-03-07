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
    import uvicorn
    # Use PORT from env (Cloud Run uses PORT env var)
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
