resource "google_artifact_registry_repository" "my_repo" {
  location      = var.region
  repository_id = var.gar_repo_name
  description   = "Docker repository for Alzheimer's UI"
  format        = "DOCKER"
}
