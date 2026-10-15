mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789" }
  }
}
mock_provider "google-beta" {}
variables {
  iap_oauth_client_id = ""
  project_id          = "oshishelf-stg-fictional"
  app_origin          = "https://fictional.run.app"
  image               = "asia-northeast1-docker.pkg.dev/oshishelf-stg-fictional/staging/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
run "bootstrap_without_credentials_does_not_set_empty_oauth" {
  command = plan
  assert {
    condition     = length(google_iap_settings.oauth) == 0
    error_message = "Bootstrap must not overwrite IAP with empty credentials."
  }
}
run "reject_client_without_secret" {
  command = plan
  variables {
    iap_oauth_client_id = "123456789-fictional.apps.googleusercontent.com"
  }
  expect_failures = [var.iap_oauth_client_secret]
}
run "reject_secret_without_client" {
  command = plan
  variables {
    iap_oauth_client_secret = "fictional-secret"
  }
  expect_failures = [var.iap_oauth_client_secret]
}
run "reject_workforce_or_non_google_client" {
  command = plan
  variables {
    iap_oauth_client_id     = "workforce-client"
    iap_oauth_client_secret = "fictional-secret"
  }
  expect_failures = [var.iap_oauth_client_id]
}
run "attach_client_only_to_staging_project" {
  command = plan
  variables {
    iap_oauth_client_id     = "123456789-fictional.apps.googleusercontent.com"
    iap_oauth_client_secret = "fictional-secret"
  }
  assert {
    condition     = google_iap_settings.oauth[0].name == "projects/123456789"
    error_message = "OAuth configuration must target the staging project only."
  }
  assert {
    condition     = google_cloud_run_v2_service.app.iap_enabled && google_iap_web_cloud_run_service_iam_binding.users.role == "roles/iap.httpsResourceAccessor"
    error_message = "Attaching OAuth must retain IAP enforcement and its access policy."
  }
}
