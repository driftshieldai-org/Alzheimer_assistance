resource "google_artifact_registry_repository" "my_repo" {
  location      = var.region
  repository_id = var.gar_repo_name
  description   = "Docker repository for Alzheimer's UI"
  format        = "DOCKER"
}

resource "google_service_account" "gcp_sa" {
  account_id   = "alzheimer-ui-sa"
  project      = var.project_id
  display_name = "alzheimer UI Service Account"
  description  = "Service account used in alzheimer UI"
}

resource "google_project_iam_member" "sa_roles" {
  for_each = toset(["roles/artifactregistry.reader","roles/run.invoker"])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.gcp_sa.email}"
}

resource "google_service_account" "backend_gcp_sa" {
  account_id   = "alzheimer-backend-sa"
  project      = var.project_id
  display_name = "alzheimer backend Service Account"
  description  = "Service account used in alzheimer backend"
}

resource "google_project_iam_member" "backend_sa_roles" {
  for_each = toset(["roles/datastore.user"])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.backend_gcp_sa.email}"
}
