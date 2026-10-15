mock_provider "github" {}
run "automatic_staging_keeps_branch_restriction" {
  command = plan
  assert {
    condition     = github_repository_environment.staging.environment == "staging" && length(github_repository_environment.staging.reviewers) == 0 && github_repository_environment.staging.wait_timer == 0
    error_message = "Only staging should have automatic deployment without reviewer or timer gates."
  }
  assert {
    condition     = github_repository_environment.staging.deployment_branch_policy[0].custom_branch_policies && !github_repository_environment.staging.deployment_branch_policy[0].protected_branches && github_repository_environment_deployment_policy.develop.branch_pattern == "develop" && github_repository_environment_deployment_policy.pull_requests.branch_pattern == "refs/pull/*/merge"
    error_message = "Removing approval must not allow arbitrary source branches or tags to deploy."
  }
}
