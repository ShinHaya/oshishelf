mock_provider "google" {}
mock_provider "google-beta" {}
variables {
  project_id          = "oshishelf-stg-fictional"
  billing_account     = "000000-000000-000000"
  repository_id       = "1406673146"
  repository_owner_id = "23278980"
}
run "only_operator_staging_workflow_for_develop_is_trusted" {
  command = plan
  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == "assertion.repository_id == '1406673146' && assertion.repository_owner_id == '23278980' && assertion.actor_id == '23278980' && assertion.environment == 'staging' && assertion.workflow_ref == 'ShinHaya/oshishelf/.github/workflows/staging.yml@' + assertion.ref && ((assertion.event_name in ['push', 'workflow_dispatch'] && assertion.ref == 'refs/heads/develop') || (assertion.event_name == 'pull_request' && assertion.base_ref in ['develop', 'refs/heads/develop'] && assertion.ref.matches('^refs/pull/[0-9]+/merge$')))"
    error_message = "OIDC must keep actor, environment, workflow, event and develop target restrictions without a bootstrap exception."
  }
}
