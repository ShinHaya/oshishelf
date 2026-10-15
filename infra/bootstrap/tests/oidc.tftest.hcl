mock_provider "google" {}
mock_provider "google-beta" {}
variables {
  project_id          = "oshishelf-stg-fictional"
  billing_account     = "000000-000000-000000"
  repository_id       = "1406673146"
  repository_owner_id = "23278980"
}
run "bootstrap_trust_is_disabled_by_default" {
  command = plan
  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "false && assertion.sha == ''")
    error_message = "The issue branch must not be trusted without an explicitly pinned commit."
  }
}
run "bootstrap_trust_requires_reviewed_sha_and_operator_environment" {
  command = plan
  variables {
    oauth_bootstrap_sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition = alltrue([for required in [
      "assertion.sha == 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
      "assertion.actor_id == '23278980'",
      "assertion.environment == 'staging'",
      "assertion.ref == 'refs/heads/issue-49-staging-terraform'",
      "assertion.workflow_ref == 'ShinHaya/oshishelf/.github/workflows/staging-oauth-bootstrap.yml@refs/heads/issue-49-staging-terraform'"
    ] : strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, required)])
    error_message = "Bootstrap must stay pinned to one commit, the operator, staging environment and the exact workflow."
  }
}
run "reject_mutable_ref_as_bootstrap_sha" {
  command = plan
  variables {
    oauth_bootstrap_sha = "develop"
  }
  expect_failures = [var.oauth_bootstrap_sha]
}
