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
7. Choose a stable session identifier available to the current runtime. It must distinguish a new session but must not contain credentials or personal data. Run:

   ```bash
   bash scripts/issue-worktree.sh handoff <issue> \
     --agent <codex|claude|grok|gemini> \
     --session <session-id>
   ```

8. Re-run `status --json`. Verify the owner matches the current agent.
   - A different session MUST increment `handoff_epoch`, including when the agent name is unchanged.
   - Re-running from the same session MUST keep the same epoch.
9. Move every subsequent git and file operation to the absolute `worktree` path returned by status. The primary clone remains human-only.
10. Post a concise audit comment to the Issue before a PR exists, or to the PR once one exists. Include epoch, old/new agent and redacted session identifiers, HEAD, dirty/unpushed/operation status, and the next known step.
11. Summarize current state, inherited changes, unresolved findings, remaining work, and risks to the user. Then continue the Issue workflow in the same worktree.

## Stop Conditions

Stop and report evidence when any of these is true:

- Issue worktree or branch was never created: route to `issue-implementation`.
- PR state is `MERGED`: route to merge cleanup; do not resume implementation.
- Another live session still owns the worktree.
- Metadata points to a different Issue or branch.
- A Git operation is incomplete.
- Safe state cannot be established from local and GitHub evidence.

`CLOSED` is not `MERGED`. Never delete a branch or worktree merely because the Issue/PR is closed or the remote branch is absent.

## Red Flags

| Temptation | Required response |
| --- | --- |
| “The remote branch is gone, so start over.” | Preserve and inspect the local worktree; it may contain unpublished work. |
| “The lease expired, so takeover is automatically safe.” | Diagnose owner and Git operation before explicit handoff. |
| “Stash or reset the dirty files first.” | Leave inherited WIP in place until it is understood. |
| “PR is closed, so cleanup is safe.” | Cleanup requires GitHub state `MERGED` and all local safety checks. |
