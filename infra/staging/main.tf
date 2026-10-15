terraform {
  required_version = ">= 1.10, < 2.0"
  backend "gcs" {}
  required_providers {
    google      = { source = "hashicorp/google", version = "~> 7.0" }
    google-beta = { source = "hashicorp/google-beta", version = "~> 7.0" }
  }
}
variable "project_id" {
  type = string
  validation {
    condition     = startswith(var.project_id, "oshishelf-stg-")
    error_message = "Only a new oshishelf-stg-* project is allowed."
  }
}
variable "region" { default = "asia-northeast1" }
variable "image" {
  type        = string
  description = "Immutable image digest in this project's staging repository"
  validation {
    condition     = can(regex("-docker.pkg.dev/oshishelf-stg-[^/]+/staging/app@sha256:[0-9a-f]{64}$", var.image))
    error_message = "Use the staging app image digest."
  }
}
variable "operator_email" {
  default = "hayasaka.cienanosdesoledad@gmail.com"
}
variable "test_users" {
  type    = set(string)
  default = []
}
variable "app_origin" {
  type        = string
  description = "Cloud Run canonical HTTPS URI (available after initial creation)"
}
provider "google" {
  project = var.project_id
}
provider "google-beta" {
  project = var.project_id
}
data "google_project" "staging" { project_id = var.project_id }
resource "google_service_account" "app" {
  account_id = "staging-app"
}
resource "google_service_account" "ai_test" {
  account_id = "staging-ai-test"
}
resource "google_project_iam_member" "app" {
  for_each = toset(["roles/datastore.user", "roles/firebaseauth.admin", "roles/aiplatform.user"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.app.email}"
}
resource "google_service_account_iam_member" "act_as" {
  service_account_id = google_service_account.app.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:staging-terraform@${var.project_id}.iam.gserviceaccount.com"
}
resource "google_service_account_iam_member" "test_token" {
  service_account_id = google_service_account.ai_test.name
  role               = "roles/iam.serviceAccountOpenIdTokenCreator"
  member             = "user:${var.operator_email}"
}
resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = "staging"
  format        = "DOCKER"
}
resource "google_artifact_registry_repository_iam_member" "publisher" {
  location   = var.region
  repository = google_artifact_registry_repository.app.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:staging-deploy@${var.project_id}.iam.gserviceaccount.com"
}
resource "google_firestore_database" "app" {
  name                    = "(default)"
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "PREVENT"
}
resource "google_firebase_project" "app" {
  provider = google-beta
  project  = var.project_id
}
resource "google_firebase_web_app" "app" {
  provider = google-beta

  project      = google_firebase_project.app.project
  display_name = "OshiShelf staging"
}
data "google_firebase_web_app_config" "app" {
  provider = google-beta

  web_app_id = google_firebase_web_app.app.app_id
}
resource "google_identity_platform_config" "app" {
  project            = google_firebase_project.app.project
  authorized_domains = ["${var.project_id}.firebaseapp.com", trimsuffix(trimprefix(var.app_origin, "https://"), "/"), "localhost"]
  sign_in {
    allow_duplicate_emails = false
    email {
      enabled           = true
      password_required = true
    }
  }
}
resource "google_storage_bucket" "measurements" {
  name                        = "${var.project_id}-measurements"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  soft_delete_policy { retention_duration_seconds = 0 }
  lifecycle_rule {
    condition { age = 90 }
    action { type = "Delete" }
  }
}
resource "google_storage_bucket" "prompts" {
  name                        = "${var.project_id}-prompts"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
}
resource "google_storage_bucket_iam_member" "measurements" {
  bucket = google_storage_bucket.measurements.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.app.email}"
}
resource "google_storage_bucket_iam_member" "prompts" {
  bucket = google_storage_bucket.prompts.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.app.email}"
}
resource "google_cloud_run_v2_service" "app" {
  name                = "oshishelf-staging"
  location            = var.region
  deletion_protection = false
  iap_enabled         = true
  ingress             = "INGRESS_TRAFFIC_ALL"
  template {
    service_account = google_service_account.app.email
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    containers {
      image = var.image
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = true
      }
      dynamic "env" {
        for_each = {
          GOOGLE_CLOUD_PROJECT    = var.project_id
          GOOGLE_CLOUD_LOCATION   = "global"
          FIREBASE_WEB_PROJECT_ID = var.project_id
          APP_ORIGIN              = var.app_origin
          MEASUREMENTS_BUCKET     = google_storage_bucket.measurements.name
          PROMPTS_BUCKET          = google_storage_bucket.prompts.name
        }
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
  lifecycle {
    precondition {
      condition     = startswith(var.image, "${var.region}-docker.pkg.dev/${var.project_id}/")
      error_message = "The image must belong to this staging project."
    }
  }
  depends_on = [google_service_account_iam_member.act_as]
}
resource "google_cloud_run_v2_service_iam_member" "iap" {
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.staging.number}@gcp-sa-iap.iam.gserviceaccount.com"
}
resource "google_iap_web_cloud_run_service_iam_binding" "users" {
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.app.name
  role                   = "roles/iap.httpsResourceAccessor"
  members                = concat(["user:${var.operator_email}", "serviceAccount:${google_service_account.ai_test.email}"], [for email in var.test_users : "user:${email}"])
}
output "uri" { value = google_cloud_run_v2_service.app.uri }
output "firebase_web_config" {
  value = {
    api_key     = data.google_firebase_web_app_config.app.api_key
    auth_domain = data.google_firebase_web_app_config.app.auth_domain
    project_id  = var.project_id
    app_id      = google_firebase_web_app.app.app_id
  }
}
output "ai_test_account" { value = google_service_account.ai_test.email }

resource "google_firebaserules_ruleset" "deny_clients" {
  project = var.project_id
  source {
    files {
      name    = "firestore.rules"
      content = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }"
    }
  }
  depends_on = [google_firebase_project.app]
}
resource "google_firebaserules_release" "deny_clients" {
  name         = "cloud.firestore"
  ruleset_name = google_firebaserules_ruleset.deny_clients.name
  depends_on   = [google_firestore_database.app]
}
