---
name: create-issue
description: Create or standardize GitHub Issues for this repository with labels and native Issue dependencies. Does not use GitHub Projects.
---

# Create Issue

Use `.github/ISSUE_TEMPLATE/implementation-plan.md` to describe goal, scope,
non-scope, approach, verification and open questions. Use fake examples only.

Create the Issue with exactly one type label (`bug`, `enhancement`, or
`documentation`) and optionally one `priority:P0` through `priority:P3` label.
Use native GitHub `Blocked by` relations for dependencies. Do not infer a
release decision, write Size at creation, or assign an agent/model in the body.

GitHub Issues are the source of work. Do not query or mutate Projects or
configure Project fields/iterations/items. Treat any legacy `project-metadata`
block in an existing Issue as historical only. No Project token, GitHub App, or
Project permission is needed.

Use `gh issue create --body-file <file>` with the exact prepared body. Verify
number, title, labels and dependencies afterward with Issue APIs. For a request
to standardize an existing Issue, inspect its content first and preserve its
intent and other workers' work. Apply `docs/github-operations.md` for metadata
and `issue-implementation` / `handoff-issue` for subsequent implementation.
