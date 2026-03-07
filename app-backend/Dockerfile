FROM python:3.11-slim

WORKDIR /app

# Install system dependencies (needed for some crypto/audio libs)
RUN apt-get update && apt-get install -y gcc libffi-dev

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Port 8080 is standard for Cloud Run
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
