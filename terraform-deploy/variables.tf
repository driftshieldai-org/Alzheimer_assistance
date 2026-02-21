variable "project_id" {
  description = "The GCP Project ID"
  type        = string
}

variable "region" {
  description = "The GCP Region"
  type        = string
  default     = "us-central1"
}

variable "repo_name" {
  description = "Name of the Artifact Registry Repo"
  type        = string
}

variable "service_account_id" {
  description = "The GCP service account used for application"
  type        = string
}

variable "vpc_network" {
  description = "Name of the VPC network"
  type        = string
}

variable "subnet_name" {
  description = "Name of vpc subnet"
  type        = string
}

variable "ui_image_name" {
  description = "Name of image created for UI cloud run"
  type        = string
}

variable "cloudrun_name" {
  description = "Name of cloud run service created for UI"
  type        = string
}


variable "backend_image_name" {
  description = "Name of image created for backend cloud run"
  type        = string
}

variable "backend_cloudrun_name" {
  description = "Name of cloud run service created for backend"
  type        = string
}

variable "backend_service_account_id" {
  description = "The GCP service account used for application backend"
  type        = string
}

