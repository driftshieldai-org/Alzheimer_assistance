# Use official lightweight Python image
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
# gcc and libffi-dev are often needed for python-jose/cryptography
RUN apt-get update && apt-get install -y gcc libffi-dev && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose port 5000 (Matches your local React setup)
EXPOSE 5000

# Start Uvicorn on Port 5000
# Note: When deploying to Cloud Run, Cloud Run will override the PORT env var,
# and Uvicorn will listen on that port automatically if we use os.environ in main.py.
# But for the CMD here, we explicitly say 5000 for local docker runs.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5000"]
