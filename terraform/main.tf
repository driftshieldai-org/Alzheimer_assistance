resource "google_project_service" "firestore_api" {
  project = var.project_id
  service = "firestore.googleapis.com"
  disable_on_destroy = false
}

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


# --- NEW: Cloud Storage Bucket for User Photos ---
resource "google_storage_bucket" "guardianmind_photos" {
  name          = "guardianmind-user-photos-${var.project_id}" # Unique bucket name
  location      = var.region
  project       = var.project_id
  uniform_bucket_level_access = true # Recommended for security
  force_destroy = false # Set to true carefully for development if you want it to delete on `terraform destroy`
}

# Grant the Backend Service Account permissions to write to the storage bucket
resource "google_project_iam_member" "backend_storage_access" {
  project = var.project_id
  role    = "roles/storage.objectAdmin" # Allows creating, updating, deleting objects
  member  = "serviceAccount:${google_service_account.backend_gcp_sa.email}"
}

# Grant the Backend Service Account permissions to 
resource "google_project_iam_member" "firestore_access" {
  project = var.project_id
  role    = "roles/datastore.user" 
  member  = "serviceAccount:${google_service_account.backend_gcp_sa.email}"
}



resource "google_firestore_database" "default_firestore_database" {
  project     = var.project_id
  # The name for the database. "(default)" refers to the default database.
  # You can also use a custom database ID here.
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON" # Or "DELETE" if you want Terraform to delete it.

  # Ensure the API is enabled before attempting to create the database.
  depends_on = [
    google_project_service.firestore_api,
  ]
}
