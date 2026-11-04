---
name: issue-implementation
description: Implement exactly one explicit GitHub Issue in its dedicated worktree, including reviewer-role dispatch, push, and PR creation. Use for a new single-Issue implementation; use handoff-issue when its worktree already exists.
argument-hint: "[issue-number]"
---

# Issue Implementation

Use this skill when implementing exactly one GitHub Issue from an explicit Issue
number.

## Inputs

Accept one Issue number from `$ARGUMENTS` or the user request as the skill argument. Supported
forms include:

- `#139`
- `139`

If the user asks for this workflow but gives no Issue number, ask for one Issue
number before doing repository-changing work. If the request includes multiple
Issue numbers, ask the user to choose exactly one before starting. If an input
could refer to something other than a GitHub Issue number, confirm the intended
Issue before starting.

Fetch the Issue body and comments first, then derive the branch name and
implementation scope from that Issue content.

## Issue worktree (MUST)

Canonical rules: the repository workflow document selected by
`repository.documents.githubOperations`, or located through `AGENTS.md` when
that setting is omitted. Follow its Issue worktree rules.

- **One dedicated Issue worktree is MUST** on this skill path. Never implement,
  create a branch, or commit on the primary clone.
- **Primary clone is human-only.** Agents must not perform git writes there.
- Worktree: `.worktrees/issue-<number>-<short-english-slug>`.
- Branch: `issue-<number>-<short-english-slug>`.
- Agent identity is lifecycle metadata, not part of the path or branch.

### Start gate (before any implementation write)

1. Run `git worktree list` and inspect `scripts/issue-worktree.sh status <issue> --json`.
2. If lifecycle metadata, an Issue worktree, or an Issue branch already exists,
   do not create another. Use `handoff-issue`.
3. Create and acquire the Issue worktree with the lifecycle helper, passing the
   current agent and a non-sensitive stable session identifier:
   `bash scripts/issue-worktree.sh create <issue> <slug> --agent <agent> --session <session-id>`.
   When `scripts/issue-dispatch.mjs` launched this session, use the lease
   session ID from the prompt (also in `ISSUE_WORKTREE_SESSION`). Do not make
   up another one. Otherwise record the session ID you chose, because every
   later `acquire` and `release` call needs the same value.
4. Move **all** subsequent operations to the absolute path printed by the helper.
5. If creation or validation fails: stop and report. No primary-tree fallback.

### Keep the lease

The lease expires `ISSUE_WORKTREE_LEASE_TTL_SEC` seconds after it was last
renewed (default 1 hour). After that, another session can take the worktree
over with `handoff`, even if the recorded owner process is still running.
Renew the lease by running `acquire` again from the same session:

```bash
bash scripts/issue-worktree.sh acquire <issue> --agent <agent> --session <session-id>
```

- A worker launched by `scripts/issue-dispatch.mjs` gets its lease renewed by
  the dispatcher while it runs. It still runs the check before each commit
  and push.
- Without the dispatcher, run `acquire` before each long step (quality gates,
  reviewer dispatch, CI watch) and at least once per lease period.
- **Before every commit and every push, run `acquire`.** If it fails, another
  session took the Issue over. Stop without committing or pushing, and report
  this to the user. Never run `handoff` to take the lease back.

## Workflow

Follow this workflow:

<!-- Preserve workflow list spacing when integrating concurrent skill updates. -->
<!-- prettier-ignore -->
1. **Issue worktree start gate** (MUST — see above). Do not skip.
2. Resolve repository settings with `node scripts/repository-config.mjs`.
   `repository.baseBranch` selects the trunk; when configuration is absent it
   defaults to `main`. Follow `AGENTS.md` for repository quality gates and
   document locations when the corresponding settings are empty or omitted.
   The lifecycle helper fetches the remote and creates the Issue worktree from
   `origin/<baseBranch>`, then the matching local branch if fetching is unavailable.
   Do not create either base ref with ad hoc Git commands.
3. Implement the Issue, run the applicable checks, and commit the changes (all
   edits and commits stay in the Issue worktree). Prepare a local test summary.
4. **Review before push or PR creation.** Dispatch a reviewer role from a
   **different** verified route using
   `node scripts/issue-dispatch.mjs --role reviewer
--execution-mode direct-review --review-pass 1` (plus the route, issue, release
   policy, and next-milestone flags). The reviewer works read-only in the existing
   Issue worktree: it reads the Issue acceptance criteria, changed file paths,
   `git diff origin/<baseBranch>..HEAD`, and the local test summary. No PR exists yet.
   Explicitly use `--next-milestone` to supply these pre-PR inputs and require an
   **Issue comment**, overriding the adapter's existing PR-input/comment guidance;
   do not change the dispatcher or runtime adapters for this workflow.
   The reviewer posts one Issue comment (`gh issue comment <issue>`) whose first
   line is `role=reviewer pass=1 verdict=<PASS|NEEDS_REVISION|REJECTED>`.
   Read the verdict and findings with `gh issue view <issue> --comments`, matching
   the current review pass and reviewed HEAD rather than an older session's verdict.
   Include the reviewed HEAD and test summary location in the dispatch milestone
   and the reviewed HEAD in the verdict comment.
   - **`PASS`**: review is complete. Proceed to push and PR creation.
   - **`NEEDS_REVISION`**: apply one implementer fix pass, run applicable checks,
     and commit. Post a `role=implementer fix-cycle=1` **Issue comment** stating
     what changed per finding. The fix pass is **not** re-reviewed. Then proceed
     to push and PR creation.
   - **`REJECTED`**: stop and report the findings in chat. Do not apply a fix
     pass, push the branch, or create a PR.

   If no distinct route is available, run on a shared route and record
   `same-route-reviewer:*` in the PR description. If route discovery fails,
   state that clearly and proceed without a reviewer pass; record this exception
   in the PR description.

   **Role-program exception:** skip this whole step when you were dispatched as
   the `implementer` role of an orchestrator role program (the prompt has a
   `Role: implementer` line). The orchestrator runs the one review pass per
   Issue as a separate reviewer role after the PR exists, so dispatching a
   reviewer here would review the Issue twice. Go straight to step 5 and do not
   claim a reviewer verdict in the PR description. Single-worker dispatches (no
   `Role:` line) and direct human use of this skill keep this step.
5. Push the branch to GitHub and create a PR with
   `gh pr create --base <baseBranch>`, using the configured branch resolved in
   step 2 even when GitHub has a different default branch. Include
   `Closes #<issue>` in the PR body so GitHub closes the Issue automatically when the PR is merged.
   Include the reviewer verdict and link to its Issue comment; for
   `NEEDS_REVISION`, also include findings and the implementer fix summary.
6. **Monitor CI/CD on the PR.** Initialize a CI fix counter to **0** (separate
   from the single reviewer fix cycle). Wait for GitHub Actions checks on the
   latest PR head to finish using `gh pr checks <pr> --watch` or equivalent.
   If checks have not registered yet, wait for registration; an empty check list
   is not evidence of success. After each push, verify checks belong to the new
   head before assessing the result.
   - When all checks are green, the workflow is complete. Report the PR and
     verification results; this does not authorize merging.
   - If any check fails, inspect the failed run for that head with
     `gh run view <run-id> --log-failed`, identify the cause, and make a scoped
     fix. When the failed check is a Cloud deploy or an infrastructure-as-code
     apply, do not conclude from the CI log alone. A deploy can create a
     revision that never starts or never receives traffic. Inspect the live
     resources, logs, and metrics with the repository's read-only observer
     before deciding the cause. Read the command and the identity name from
     the development document (`repository.documents.development`, or
     `docs/development.md` and `AGENTS.md` when that setting is omitted),
     section [Deploy failure diagnosis](../../docs/development.md#deploy-failure-diagnosis),
     and follow [references/cloud-observer.md](references/cloud-observer.md).
     Do not hard-code a provider command, a configuration name, or a project
     identifier in this skill, and do not fall back to a broader operator
     identity. If the repository records no read-only procedure, say so and
     stop that diagnosis. On a public repository the CI job may only add an
     `::error::` annotation that points at the local procedure. Do not print
     cloud logs, resource payloads, or tokens into the CI log. Run applicable
     local checks, commit, and push to the same branch.
     Increment the counter for each CI fix cycle, then monitor the new head.
     CI fixes do **not** receive another reviewer pass.
   - Allow at most **3 CI fix cycles**. If CI/CD still fails after the third
     fix, stop without a fourth fix. Report in chat the failed check names,
     log summary, branch name, and remaining branch commit count
     (`git rev-list --count origin/<baseBranch>..HEAD`) for handoff. Preserve the
     unmerged branch and PR. If a failure cannot be fixed within Issue scope,
     report it and stop instead of expanding scope.

## Boundaries

- Respect repository instructions, sandbox rules, external-network approval
  requirements, and destructive-command safety boundaries.
- Do not skip the Issue worktree start gate. Do not commit on the primary clone.
- Do not run an open-ended reviewer loop. This workflow allows one review pass
  and at most one implementer fix cycle; the fix pass is never re-reviewed.
- Keep CI/CD fixes bounded to three cycles; do not re-review those fixes.
- Treat PR close as distinct from merge. Close a PR only when the user or the
  repository workflow explicitly asks to close it instead of merging it.
