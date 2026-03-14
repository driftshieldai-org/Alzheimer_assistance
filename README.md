# GuardianMind: AI Companion for Alzheimer's Assistance

GuardianMind is an award-winning web application that acts as a live AI guardian for individuals with Alzheimer's or Elderly people. It uses a real-time, multimodal AI agent powered by the Gemini Live API to provide contextual reminders, identify familiar faces and places, and ensure user safety. By combining a persistent memory store with a live video and audio stream, GuardianMind offers peace of mind to both users and their caregivers.


## Features

-   **Live Guardian Agent**: A real-time, conversational AI that processes live video and audio to provide proactive assistance, identify objects from the user's past, and detect signs of distress or wandering.
-   **Personalized Memory Bank**: Caregivers can upload photos of people, places, and objects to build a personalized knowledge base for the AI.
-   **AI-Powered Visual Fingerprints**: Each uploaded photo is analyzed by Gemini to create detailed descriptions, focusing on permanent features for robust, long-term recognition.
-   **Proactive Safety Alerts**: The system uses GPS data to give the AI situational awareness, allowing it to intelligently detect if a user is lost and automatically alert caregivers via email.
-   **Secure & Scalable Cloud Architecture**: All data is stored securely in Google Cloud, with a fully automated CI/CD pipeline for robust, production-grade deployment.

## Tech Stack

-   **Frontend (`app-ui`)**: A web-based user interface (e.g., React, Vue, or Angular).
-   **Backend (`app-backend`)**: A Python-based API built with FastAPI.
-   **Live Agent**: Real-time audio/video processing and interaction via WebSockets.
-   **Database**: Google Cloud Firestore for storing photo metadata and user information.
-   **File Storage**: Google Cloud Storage for securely storing uploaded images.
-   **AI/ML**: Google Gemini Live Connect API for the real-time agent and Gemini Vision API for memory creation.
-   **Infrastructure as Code**: Terraform for provisioning and managing all Google Cloud resources.
-   **CI/CD**: GitHub Actions for continuous integration and deployment.

## Project Structure

```
.
├── .github/workflows/      # GitHub Actions CI/CD pipeline
│   └── deploy.yml
├── app-backend/            # FastAPI backend service
├── app-ui/                 # Frontend application
├── terraform/              # Terraform for core infrastructure (GCS, Firestore, IAM)
└── terraform-deploy/       # Terraform for application deployment (Cloud Run)
```

## Getting Started / Local Development

### Prerequisites

To work with the project locally, you will need:
-   Google Cloud SDK (`gcloud`)
-   Terraform
-   Docker
-   Node.js (for the UI)
-   Python (for the backend)

### Backend (`app-backend`)

The backend service is a FastAPI application that handles photo uploads, AI processing, and database interactions.

1.  **Install dependencies**:
    ```bash
    pip install -r app-backend/requirements.txt
    ```

2.  **Set Environment Variables**:
    Create a `.env` file in the `app-backend` directory or export the following variables:
    -   `GCP_PROJECT_ID`: Your Google Cloud Project ID.
    -   `GCP_REGION`: The Google Cloud region for services (e.g., `us-central1`).
    -   `GCS_BUCKET_NAME`: The name of the Google Cloud Storage bucket for photo uploads.

3.  **Run the server**:
    ```bash
    cd app-backend
    uvicorn main:app --reload
    ```
    The server will be available at `http://127.0.0.1:8000`.

### Frontend (`app-ui`)

The frontend is a modern JavaScript application that provides the user interface.

1.  **Install dependencies**:
    ```bash
    cd app-ui
    npm install
    ```

2.  **Run the development server**:
    ```bash
    npm start
    ```
    The application will be available at `http://localhost:3000`.

## Backend API

The backend exposes the following endpoint for the frontend to use.

### Upload Photo

-   **Endpoint**: `POST /api/photos/upload`
-   **Description**: Uploads a new photo and its metadata.
-   **Auth**: Requires user authentication.
-   **Request Body**: `multipart/form-data`
    -   `photo`: The image file (`image/*`).
    -   `description`: (string) A short, user-provided description.
    -   `photoDate`: (string) The date the photo was taken.
    -   `latitude`: (string, optional) The latitude where the photo was taken.
    -   `longitude`: (string, optional) The longitude where the photo was taken.
-   **Success Response** (`200 OK`):
    ```json
    {
      "message": "Photo uploaded successfully",
      "gcsObjectName": "photos/user_id/uuid.jpg",
      "photoId": "firestore_document_id"
    }
    ```

## Infrastructure and Deployment

This project is configured for fully automated deployment to Google Cloud using Terraform and GitHub Actions. The infrastructure is split into two parts: core resources and application deployment.

### CI/CD Pipeline

When changes are pushed to the `main` branch, the `.github/workflows/deploy.yml` workflow executes the following steps:

1.  **Terraform Init/Plan/Apply (Core Infra)**: The `terraform` job sets up the foundational GCP resources.
2.  **Build & Push Images**: If changes are detected in `app-ui` or `app-backend`, new Docker images are built and pushed to Google Artifact Registry.
3.  **Terraform Init/Plan/Apply (App Deploy)**: The `terraform-deploy` job deploys the new container images to Google Cloud Run services.

### Core Infrastructure (`terraform/`)

This configuration provisions the foundational resources that are created once or updated infrequently. It manages:

-   **Google Cloud Project**: Enables required APIs (Cloud Run, Artifact Registry, etc.).
-   **Artifact Registry**: Creates a Docker repository to store container images.
-   **Google Cloud Storage (GCS)**: Creates the bucket for photo storage.
-   **Google Cloud Firestore**: Initializes the Firestore database.
-   **IAM**: Creates service accounts and assigns necessary permissions.

### Application Deployment (`terraform-deploy/`)

This configuration deploys the application services to Google Cloud Run. It manages:

-   **Google Cloud Run Service (`alzhemier-ui`)**: Deploys the frontend container.
-   **Google Cloud Run Service (`alzhemier-backend`)**: Deploys the backend API container.
-   **IAM Bindings**: Ensures the Cloud Run services run with the correct service accounts.

### Manual Terraform Usage

To apply infrastructure changes manually from your local machine:

1.  **Authenticate with GCP**: `gcloud auth application-default login`
2.  **Navigate to the directory**: `cd terraform` or `cd terraform-deploy`
3.  **Initialize Terraform**: `terraform init`
4.  **Plan and Apply Changes**: `terraform plan` and then `terraform apply`
