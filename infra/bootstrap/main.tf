terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    google      = { source = "hashicorp/google", version = "~> 7.0" }
    google-beta = { source = "hashicorp/google-beta", version = "~> 7.0" }
  }
}
variable "project_id" {
  type = string
  validation {
    condition     = startswith(var.project_id, "oshishelf-stg-")
    error_message = "Use a new oshishelf-stg-* project, never the production project."
  }
}
variable "billing_account" { type = string }
variable "region" { default = "asia-northeast1" }
variable "repository_id" {
  type        = string
  description = "Immutable numeric GitHub repository ID"
}
variable "repository_owner_id" {
  type        = string
  description = "Immutable numeric GitHub owner ID"
}
variable "deployment_branch" { default = "develop" }
resource "google_project" "staging" {
  project_id      = var.project_id
  name            = "OshiShelf staging"
  billing_account = var.billing_account
  deletion_policy = "PREVENT"
}
locals {
  apis = toset(["serviceusage.googleapis.com", "cloudresourcemanager.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com", "storage.googleapis.com", "run.googleapis.com", "artifactregistry.googleapis.com", "firestore.googleapis.com", "firebase.googleapis.com", "identitytoolkit.googleapis.com", "aiplatform.googleapis.com", "iap.googleapis.com", "firebaserules.googleapis.com", "logging.googleapis.com", "cloudasset.googleapis.com", "cloudbuild.googleapis.com"])
}
resource "google_project_service" "api" {
  for_each           = local.apis
  project            = google_project.staging.project_id
  service            = each.value
  disable_on_destroy = false
}
resource "google_storage_bucket" "state" {
  project                     = google_project.staging.project_id
  name                        = "${var.project_id}-tfstate"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning { enabled = true }
  lifecycle_rule {
    condition { num_newer_versions = 10 }
    action { type = "Delete" }
  }
  depends_on = [google_project_service.api]
}
resource "google_service_account" "terraform" {
  project      = google_project.staging.project_id
  account_id   = "staging-terraform"
  display_name = "Staging Terraform only"
  depends_on   = [google_project_service.api]
}
resource "google_service_account" "deploy" {
  project      = google_project.staging.project_id
  account_id   = "staging-deploy"
  display_name = "Staging container publisher"
  depends_on   = [google_project_service.api]
}
resource "google_project_iam_member" "terraform" {
  for_each = toset(["roles/run.admin", "roles/iam.serviceAccountAdmin", "roles/resourcemanager.projectIamAdmin", "roles/artifactregistry.admin", "roles/datastore.owner", "roles/firebase.admin", "roles/firebaserules.admin", "roles/identityplatform.admin", "roles/storage.admin", "roles/iap.admin", "roles/serviceusage.serviceUsageConsumer"])
  project  = google_project.staging.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.terraform.email}"
}
resource "google_iam_workload_identity_pool" "github" {
  project                   = google_project.staging.project_id
  workload_identity_pool_id = "github-staging"
  depends_on                = [google_project_service.api]
}
resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = google_project.staging.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
  }
  # Only the reviewed deployment workflow on a trusted branch, never PR code/forks.
  attribute_condition = "assertion.repository_id == '${var.repository_id}' && assertion.repository_owner_id == '${var.repository_owner_id}' && assertion.ref == 'refs/heads/${var.deployment_branch}' && assertion.workflow_ref == 'ShinHaya/oshishelf/.github/workflows/staging.yml@refs/heads/${var.deployment_branch}'"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}
resource "google_service_account_iam_member" "github" {
  for_each           = { terraform = google_service_account.terraform.name, deploy = google_service_account.deploy.name }
  service_account_id = each.value
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${var.repository_id}"
}
output "project_id" { value = google_project.staging.project_id }
output "state_bucket" { value = google_storage_bucket.state.name }
output "workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github.name }
output "terraform_account" { value = google_service_account.terraform.email }
output "deploy_account" { value = google_service_account.deploy.email }

resource "google_project_service_identity" "iap" {
  provider   = google-beta
  project    = google_project.staging.project_id
  service    = "iap.googleapis.com"
  depends_on = [google_project_service.api]
}

# Permit short-lived diagnostic credentials without signBlob/signJwt or key creation.
resource "google_project_iam_custom_role" "diagnostic_tokens" {
  project     = google_project.staging.project_id
  role_id     = "stagingDiagnosticTokenMinter"
  title       = "Staging diagnostic token minter"
  permissions = ["iam.serviceAccounts.getAccessToken", "iam.serviceAccounts.getOpenIdToken"]
}
