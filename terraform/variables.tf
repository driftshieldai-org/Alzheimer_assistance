variable "project_id" {
  description = "The GCP Project ID"
  type        = string
}

variable "region" {
  description = "The GCP Region"
  type        = string
  default     = "us-central1"
}

variable "gar_repo_name" {
  description = "Name of the Artifact Registry Repo"
  type        = string
  default     = "alzheimer-ui-docker"
}
