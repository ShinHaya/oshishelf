terraform {
  required_version = ">= 1.10, < 2.0"
  backend "gcs" {}
  required_providers {
    github = { source = "integrations/github", version = "~> 6.0" }
  }
}
# Authenticate using the existing gh login via GITHUB_TOKEN; never store a token here.
provider "github" { owner = "ShinHaya" }
resource "github_repository_environment" "staging" {
  repository  = "oshishelf"
  environment = "staging"
  wait_timer  = 0
  # No reviewers: staging deploys automatically after its CI checks.
  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
  lifecycle { prevent_destroy = true }
}
resource "github_repository_environment_deployment_policy" "develop" {
  repository     = github_repository_environment.staging.repository
  environment    = github_repository_environment.staging.environment
  branch_pattern = "develop"
}

resource "github_repository_environment_deployment_policy" "pull_requests" {
  repository     = github_repository_environment.staging.repository
  environment    = github_repository_environment.staging.environment
  branch_pattern = "refs/pull/*/merge"
}
