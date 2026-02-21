resource "google_cloud_run_v2_service" "alzheimer-ui" {
  name     = var.cloudrun_name
  location = var.region
  project = var.project_id
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    containers {
      image = "us-central1-docker.pkg.dev/${var.project_id}/${var.repo_name}/${var.ui_image_name}:latest"
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
