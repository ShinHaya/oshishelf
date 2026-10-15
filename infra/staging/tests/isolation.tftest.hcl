mock_provider "google" {}
mock_provider "google-beta" {}
variables {
  project_id = "oshishelf-stg-fictional"
  app_origin = "https://fictional.run.app"
  image      = "asia-northeast1-docker.pkg.dev/oshishelf-stg-fictional/staging/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
run "reject_production_project" {
  command = plan
  variables {
    project_id = "fictional-production"
    image      = "asia-northeast1-docker.pkg.dev/fictional-production/staging/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [var.project_id, var.image]
}
run "reject_other_staging_image" {
  command = plan
  variables {
    image = "asia-northeast1-docker.pkg.dev/oshishelf-stg-other/staging/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [google_cloud_run_v2_service.app]
}
run "diagnostics_cannot_manage_infrastructure_or_read_user_data" {
  command = plan
  assert {
    condition = alltrue([for grant in google_project_iam_member.ai_diagnostics : contains([
      "roles/logging.viewer", "roles/cloudasset.viewer", "roles/run.viewer", "roles/serviceusage.serviceUsageViewer"
    ], grant.role) && grant.project == var.project_id])
    error_message = "AI diagnostics must stay within staging metadata/log readers; no admin, document or object data roles."
  }
}
