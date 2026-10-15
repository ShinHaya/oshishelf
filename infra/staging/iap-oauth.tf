# Google Account OAuth client creation requires a one-time Console bootstrap:
# https://docs.cloud.google.com/iap/docs/deprecations/migrate-oauth-client
# Manage the IAP attachment here; never use the retired google_iap_brand/client API.
variable "iap_oauth_client_id" {
  type        = string
  default     = ""
  description = "Pre-created Google Account web OAuth client ID; commit the public ID as this default after one-time bootstrap."
  validation {
    condition     = var.iap_oauth_client_id == "" || can(regex("^[0-9]+-[a-zA-Z0-9_-]+\\.apps\\.googleusercontent\\.com$", var.iap_oauth_client_id))
    error_message = "Use a Google Account web OAuth client ID ending in .apps.googleusercontent.com."
  }
}
variable "iap_oauth_client_secret" {
  type        = string
  default     = ""
  sensitive   = true
  description = "OAuth client secret from a local TF_VAR or GitHub Environment secret; never commit it. Stored in protected Terraform state."
  validation {
    condition     = (var.iap_oauth_client_id == "") == (var.iap_oauth_client_secret == "")
    error_message = "Provide both IAP OAuth client ID and secret, or neither during initial bootstrap."
  }
}
resource "google_iap_settings" "oauth" {
  count = var.iap_oauth_client_id == "" ? 0 : 1
  # Apply at project level so all Cloud Run URL formats inherit the same client.
  name            = "projects/${data.google_project.staging.number}"
  deletion_policy = "PREVENT"
  access_settings {
    oauth_settings {
      client_id     = var.iap_oauth_client_id
      client_secret = var.iap_oauth_client_secret
    }
  }
  lifecycle {
    # Missing CI credentials must fail instead of removing a working OAuth setup.
    prevent_destroy = true
  }
}
