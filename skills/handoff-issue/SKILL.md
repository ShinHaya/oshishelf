---
name: handoff-issue
description: Use when resuming an existing GitHub Issue after a session limit, new agent session, CLI interruption, rate limit, or agent change, where the Issue worktree and branch should already exist.
argument-hint: "[issue-number]"
---

# Handoff Issue

## Overview

Resume one existing Issue in its existing worktree without losing inherited WIP or allowing concurrent edits. A successful new-session handoff starts a new audit epoch.

## Input

Accept exactly one explicit GitHub Issue number from `$ARGUMENTS` or the user request, such as `#365` or `365`. If the request has no Issue number, multiple numbers, or could mean a PR number, ask for one Issue number before mutating local or GitHub state.

Use `issue-implementation` instead when the Issue worktree and branch have not been created.

## Workflow

1. Fetch the Issue body and comments. Find its PR if one exists.
2. Run read-only lifecycle diagnostics from any checkout:

   ```bash
   bash scripts/issue-worktree.sh status <issue> --json
   ```

3. Stop if metadata, worktree, branch, or Issue identity is missing, corrupt, duplicated, or mismatched. Never create a replacement worktree in this skill.
4. Inspect the reported HEAD, dirty state, upstream/ahead/behind (`upstream_gone: true` means the tracked remote branch was deleted, for example after a merged PR), Git operation, owner, and epoch. Also inspect the Issue, PR state, diff, commits, CI, and unresolved review threads.
5. Stop while merge, rebase, cherry-pick, or bisect is active. An expired timestamp alone is not permission to discard or overwrite work.
6. Preserve inherited files exactly. Do not stash, commit, reset, clean, switch branches, copy the WIP, or force-remove anything merely to make takeover convenient.
7. Use an ID returned by `node scripts/ai-template.mjs agents list` (registered
   aliases resolve to canonical IDs; retired runtimes are rejected). Choose a stable session identifier available to the current runtime. It must distinguish a new session but must not contain credentials or personal data. Run:

   ```bash
   bash scripts/issue-worktree.sh handoff <issue> \
     --agent <agent-id> \
     --session <session-id>
   ```

   When `scripts/issue-dispatch.mjs` launched this session, use the lease
   session ID from the prompt (also in `ISSUE_WORKTREE_SESSION`).
   Handoff is refused while the lease is held, which means it has not expired
   and its recorded owner process is still running. The refusal names the
   owner's PID, its command, and the lease expiry. If the command is a
   long-running server (for example `opencode serve` or `codex app-server`)
   rather than a worker, wait for the expiry instead of stopping the server.
   After the lease expires, handoff succeeds even while that PID is running.

8. Re-run `status --json`. Verify the owner matches the current agent.
   - A different session MUST increment `handoff_epoch`, including when the agent name is unchanged.
   - Re-running from the same session MUST keep the same epoch.
9. Move every subsequent git and file operation to the absolute `worktree` path returned by status. The primary clone remains human-only.
   From here on, keep the lease the same way `issue-implementation` describes
   under "Keep the lease": renew it with
   `bash scripts/issue-worktree.sh acquire <issue> --agent <agent-id> --session <session-id>`
   before long steps, and before every commit and every push. If `acquire`
   fails, another session took the Issue over: stop without committing or
   pushing.
10. Post a concise audit comment to the Issue before a PR exists, or to the PR once one exists. Include epoch, old/new agent and redacted session identifiers, HEAD, dirty/unpushed/operation status, and the next known step.
11. Read `node scripts/repository-config.mjs` for the configured base branch,
    quality-gate commands and document locations. For empty or omitted commands and
    omitted locations, follow this repository's `AGENTS.md`. Use the same configured
    base branch for freshness checks, diffs and the PR target.
12. Summarize current state, inherited changes, unresolved findings, remaining work, and risks to the user. Then continue the Issue workflow in the same worktree.
    When dispatched as the `implementer` role of an orchestrator role program (the prompt has a `Role: implementer` line), skip the `issue-implementation` reviewer step: the orchestrator runs the review as a separate role. Single-worker and human-driven handoffs keep it.

## Stop Conditions

Stop and report evidence when any of these is true:

- Issue worktree or branch was never created: route to `issue-implementation`.
- PR state is `MERGED`: route to merge cleanup; do not resume implementation.
- Another live session still owns the worktree: the lease has not expired and its owner process is running.
- Your own `acquire` fails before a commit or a push: another session took the Issue over.
- Metadata points to a different Issue or branch.
- A Git operation is incomplete.
- Safe state cannot be established from local and GitHub evidence.

`CLOSED` is not `MERGED`. Never delete a branch or worktree merely because the Issue/PR is closed or the remote branch is absent.

## Red Flags

| Temptation                                                            | Required response                                                                |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| “The remote branch is gone, so start over.”                           | Preserve and inspect the local worktree; it may contain unpublished work.        |
| “The lease expired, so takeover is automatically safe.”               | Diagnose owner and Git operation before explicit handoff.                        |
| “Handoff is refused, so stop the server process that owns the lease.” | Never stop a shared server; other sessions use it. Wait for the lease to expire. |
| “Stash or reset the dirty files first.”                               | Leave inherited WIP in place until it is understood.                             |
| “PR is closed, so cleanup is safe.”                                   | Cleanup requires GitHub state `MERGED` and all local safety checks.              |
