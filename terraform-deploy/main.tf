resource "google_cloud_run_v2_service" "alzheimer-ui" {
  name     = var.cloudrun_name
  location = var.region
  project = var.project_id
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    containers {
      image = "us-central1-docker.pkg.dev/${var.project_id}/${var.repo_name}/${var.ui_image_name}:latest"

      # Inject the Backend URL into the Frontend container dynamically
      env {
        name  = "VITE_BACKEND_URL"
        value = google_cloud_run_v2_service.backend.uri
      }

      resources {
        limits = {
          cpu    = 1
          memory = "512Mi"
        }
      }
    }  
    scaling {
        max_instance_count = 1
        min_instance_count = 0
      }  
    
    
    service_account = var.service_account_id 
  }
  
}

resource "google_cloud_run_v2_service_iam_member" "public_access" {
  project  = google_cloud_run_v2_service.alzheimer-ui.project
  location = google_cloud_run_v2_service.alzheimer-ui.location
  name     = google_cloud_run_v2_service.alzheimer-ui.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}


resource "google_cloud_run_v2_service" "backend" {
  name     = var.backend_cloudrun_name
  location = var.region
  project = var.project_id
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = var.backend_service_account_id
    containers {
      image = "us-central1-docker.pkg.dev/${var.project_id}/${var.repo_name}/${var.backend_image_name}:latest"
      ports { container_port = 5000 }
      env {
        name  = "JWT_SECRET"
        value = "alzheimers_app_production_secret_key" 
      }

    resources {
        limits = {
          cpu    = 1
          memory = "512Mi"
        }
      }
    }

    scaling {
        max_instance_count = 1
        min_instance_count = 0
      } 
  }
}

resource "google_cloud_run_v2_service_iam_member" "backend_public" {
  project  = google_cloud_run_v2_service.backend.project
  location = google_cloud_run_v2_service.backend.location
  name     = google_cloud_run_v2_service.backend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
