---
name: orchestrate-project-issues
description: Use when coordinating multiple GitHub Issues whose implementation order, dependencies, run-time agent/model routing, worktrees, and interruption recovery must be managed together.
---

# Orchestrate Issues

Coordinate many Issues while keeping each Issue's implementation inside its assigned worker. The parent owns graph validation, run-time routing decisions, milestones, the integration quality gate, and exceptions. No agent/model assignment is stored in Issues; every routing decision is made at run time and recorded in run state.

## Inputs and start gate

GitHub Issues are the source of work. Do not query or mutate GitHub Projects.
The script names retain their historical `project-issue-` prefix.

Load `state/project-issue-orchestrator.yaml` when it exists; its `run` section
contains maximum parallelism, release policy, unavailable routes and optional
triage settings. No `project` section or Project token is needed. Legacy files
remain readable, but their Project identifiers are ignored for network access.
Require explicit `--issues <numbers>` for live repository reads. Priority comes
from an unambiguous `priority:P0..P3` label; open Issues are runnable, closed
Issues are completed. Size is not fetched or written; triage may recommend it.

1. Discover verified worker runtimes per [provider-routing.md](references/provider-routing.md).
   Include the parent runtime's worker records only per its worker mode (below) and apply
   unavailable route labels.
2. Use `node scripts/project-issue-orchestrator.mjs --issues <numbers> --dry-run
   --max-parallel <count> --release-policy merged --parent-agent <agent>
   --parent-model <model>`. It fetches only Issue metadata, labels and native
   `Blocked by` relations, never bodies or Project fields. Only the isolated
   opt-in triage child may fetch its current Issue body. Each worker reads its
   own Issue body and comments immediately before its work.
3. Stop before worktree writes on missing/truncated metadata, cross-repository
   dependencies, cycles, an open blocker, ambiguous priority or unavailable routes.
   A closed blocker is completed. No Project status transition is performed.
4. Assign from `workerRoutes` in the resulting runnable plan; routing remains a
   run-time decision. An empty verified pool stops with `no-worker-route-available`.

## Role programs

One Issue is implemented by a *sequence* of workers, not one. The plan gives every runnable
Issue a deterministic execution mode (`scripts/project-issue-modes.mjs`) and the role program
that follows from it:

| Execution mode | Selected when | Role program |
| --- | --- | --- |
| `direct-review` | **low** risk, size XS–M, shallow dependencies | implementer → reviewer |
| `plan-implement-review` | any risk above low, size L–XL, depth ≥ 2, or wide change scope | planner → implementer → reviewer |

Risk above `low` always buys a planner: `direct-review` stays eligible for medium-risk Issues,
so ranking is conditioned on risk rather than always taking the cheapest eligible mode.

Each role runs as its own CLI process on its own verified route, so a reviewer structurally
cannot see the implementer's conversation or reasoning — it reads the Issue, the worktree, and
the diff itself. `implementer` and `reviewer` take distinct routes whenever the pool holds more
than one, in both directions and across handoffs; when no distinct route remains the run
continues on a shared route and records `same-route-reviewer:*`. The first implementation role
to enter an Issue creates the worktree via `issue-implementation`; later implementation roles
resume it via `handoff-issue`. **A reviewer runs no skill at all** — both implementation skills
commit, so it enters the existing worktree read-only.

Review is bounded to one pass per Issue: a
`NEEDS_REVISION` verdict buys one implementer fix pass that is **not** re-reviewed — the Issue
then goes straight to its milestone gate — and `REJECTED` blocks immediately. An
integration-gate rejection reopens the program at the implementer on its **own** single
allowance; that fix is re-checked by the gate, not the reviewer, and a second gate rejection
blocks the Issue (`integration-gate-rejected-twice`). Pass `--single-worker` to fall back to one
worker owning the whole Issue.

`parallel-analysis-implement-review` has no role program yet and is never selected.

## Dynamic assignment

The orchestrating agent assigns each runnable Issue's current role to one route from
`workerRoutes` at dispatch time, considering the Issue's Size and content against each agent's
strengths and the user's run-scoped hints. Rules:

- Choose only from `workerRoutes`; never invent a selector, substitute a nearby model name, or
  relabel a canonical identifier as a different model.
- A reviewer proposal equal to that Issue's implementer route is rejected while another route
  exists; independent review means a different runtime.
- The Parent agent runtime joins `workerRoutes` according to its worker mode, set with
  `--parent-worker-mode auto|always|never` (both orchestrator CLIs) or YAML
  `run.parentAsWorker`. CLI beats YAML; the default is `auto`.
  - `auto`: the parent joins only while its own **5-hour** usage window has **50% or more**
    left, read at run time from the runtime's machine-readable interface (Codex: App Server
    `account/rateLimits/read`, the window whose `windowDurationMins` is 300). Unknown usage —
    unsupported runtime (currently every runtime except Codex), fetch failure, timeout, no
    300-minute window, an invalid value, or a server-side block — keeps the parent out; the run
    continues on the other verified routes.
  - `always`: always joins (`--parent-as-worker` and legacy YAML `true`).
  - `never`: never joins. Legacy YAML `false`, the old default, is read as `auto`; write `never`
    to opt out permanently. `--parent-as-worker` together with a different
    `--parent-worker-mode` fails as `parent-worker-mode-conflict`.

  Inclusion and exclusion are by `agent`, not by model. Run-scoped unavailable lists, exact
  model verification, and the different-runtime reviewer rule still apply. The StateGraph
  re-reads usage before every new assignment and handoff; a worker already running on the
  parent route is never stopped because usage dropped. Both CLIs report only
  `{mode, eligible, reason, remainingPercent, windowDurationMins, fetchedAt}` (`parentWorker`
  in classic output, `summary.routing.parentWorker` in the graph); the raw response, account,
  plan, and credentials are never stored. Parent and worker share the same account quota, so
  the check is a point-in-time admission, not a guarantee that 50% stays available.
- Record the chosen route (agent + model labels only) in run state and in the dispatch message.
- Exclusions are run-scoped: YAML `run.unavailableAgents` / `run.unavailableModels` and their
  `--unavailable-agent` / `--unavailable-model` CLI overrides affect only the current run, and
  availability is recomputed from fresh capability records on the next run.
- Apart from the parent's 5-hour check above, budget snapshots are not an input to initial
  assignment; session limits are handled reactively at interruption time (below).

## Scheduling

- Dispatch only Issues returned in `plan.runnable`, in plan order, up to `maxParallel` and the
  number of remaining verified worker routes. A smaller worker pool is valid.
- Release a dependency only on the configured milestone: `pr-created` or `merged`. Never invent a third release condition.
- Use completion notifications and milestone events. Do not short-poll workers, logs, review files, or model availability. A single bounded fallback wakeup may detect lost notifications.
- Supply run-scoped state explicitly with `--unavailable-agent`, `--unavailable-model`, `--state-path`, `--existing-worktree`, and `--milestone-json` or `--milestone-file`. Repeat the agent/model/worktree flags as needed.

## Worker contract

Send only the Issue number, the role, the assigned agent/model route, the skill, release policy,
and next milestone to a worker. The worker fetches its own body/comments, diff, and test results.
Never pass Issue bodies, diffs, plans, or another role's output through the dispatch payload.

Structure every non-trivial dispatch prompt with four short labeled sections:

- **Goal:** the single role outcome.
- **Context:** Issue number, role, verified route, skill, release policy, and next milestone only.
- **Constraints:** state/privacy limits, worktree ownership, and role-specific boundaries.
- **Done when:** the observable milestone and exact concise event shape to return.

Do not embed hidden rationale or repeat repository-wide instructions that the worker loads itself.

- Launch the selected route with the same exact `selector` / `model` from discovery — for external CLIs use `node scripts/project-issue-dispatch.mjs` (or `dispatchWorker`) so non-Codex routes start through their adapter, not a Codex-only path. Role-based launches add `--role`, `--skill`, `--execution-mode`, and (for a reviewer) `--review-pass`.
- No worktree: worker uses `issue-implementation`.
- Existing Issue worktree/metadata: worker uses `handoff-issue` before editing.
- A reviewer is dispatched without `--skill` and must not run `issue-implementation` or
  `handoff-issue`; it works read-only inside the existing Issue worktree. It consults the
  Issue's acceptance criteria, the pull request body, the changed file paths, the branch diff,
  and the test summary, and returns a `PASS` / `NEEDS_REVISION` / `REJECTED` verdict.
- **Findings live on the pull request, not in run state.** The reviewer posts one PR comment
  (`gh pr comment`) whose first line is `role=reviewer pass=<N> verdict=<…>`, and the verdict
  also comes back as the `role-complete` event. GitHub's review feature is unusable here: one
  account owns both the PR and the review, so `gh pr review` is forbidden.
- **A fix pass never opens a second PR.** An implementer re-dispatched after `NEEDS_REVISION`
  receives `--fix-cycle <N>`, is told a PR already exists, reads the findings with
  `gh pr view --comments`, pushes to the same branch, and posts its own PR comment headed
  `role=implementer fix-cycle=<N>` stating what it changed per finding.
- Session limit, CLI interruption, rate limit, or agent change: stop dispatching new work for that Issue, terminate only that worker process tree, add the interrupted agent to the run's `--unavailable-agent` list, and choose the handoff recipient **at that moment** from the remaining `workerRoutes` (which excludes the Parent agent unless the run opted it in; there is no preassigned sub assignee). Route the recipient through `handoff-issue` in the same worktree. Preserve inherited WIP; never stash, reset, clean, copy, or create a duplicate worktree.
- A route that fails at actual dispatch (not just at discovery) is a signal the cached capability record no longer reflects reality. Pass `--invalidate-agent <name>` on the *next* orchestrator invocation (in addition to this run's `--unavailable-agent`) so that agent is dropped from the capability cache and re-probed instead of being trusted as "ok" indefinitely.

Workers return only `started`, `blocked`, `role-complete`, `pr-created`, `merged`, or `failed`,
plus a concise reason and exact usage telemetry when exposed. `role-complete` carries the role
and, for a reviewer, the verdict. Do not return implementation logs or Issue bodies.

Under a role program the `pr-created` milestone is reached by finishing the program — the
reviewer's `PASS` opens the gate. Reporting that milestone directly while roles are still
running is rejected (`role-program-active`), so dependents never release on unreviewed work.
Under `--release-policy merged` the program ends at `pr-created` and the run keeps waiting for
the external `merged` milestone, which is reported as an ordinary milestone event.

## Integration quality gate

On each `pr-created` (or `merged`, per release policy) milestone the parent runs an
integration-scope review before releasing dependents. The gate checks only:

- conflicts with other Issues in the same run (same files, same contracts, incompatible edits);
- contract consistency with the Issues it depends on and the Issues that depend on it
  (interfaces, schemas, documented behavior);
- coverage of the Issue's stated acceptance criteria.

Full implementation review is out of scope here — it belongs to the reviewer role and PR
review. If the gate finds a problem, return the Issue to its worker with a concise reason and do
not release dependents; otherwise record the milestone. The gate reads the PR diff and the
related Issues' acceptance criteria; it never copies Issue bodies or diffs into parent state.

## Optional: LangGraph StateGraph runner

`node scripts/project-issue-graph.mjs --thread-id <id> …` runs this same workflow as an
explicit checkpointed state machine (see the runner source in `scripts/project-issue-graph.mjs`): it pauses for route
assignment, worker events, and every integration-gate verdict, and resumes with
`--resume-json`. Resume payloads are validated against the verified route pool — the rules
above (choose only from `workerRoutes`, fail closed on exhaustion, release only on the
configured milestone, preserve worktrees on handoff) are enforced by the graph itself.
The classic `project-issue-orchestrator.mjs` dry-run remains the default planning path.
Triage is opt-in (`run.triage.mode: off` by default) and calls the external Jev classifier
(TypeSafe API, `TYPESAFE_API_KEY`) only from an isolated child process. With `--triage shadow`, the graph refreshes each CLI model before building the Jev
candidate pool. The assignment interrupt shows the recommendation and existing mode;
it does not adopt Jev's risk, Size, mode, or route. Before first dispatch, a changed Issue,
pool, or unverifiable route withdraws the assignment for a manual re-prompt (a failed
route's model is excluded for the run). A fallback requires manual route
assignment even with `--auto-assign`. `--triage assisted` requires the current live
holdout report at `state/triage-eval/assisted-evaluation.json` and explicit PO
approval at `state/triage-eval/assisted-approval.json`, validated by
`scripts/project-issue-triage-approval.mjs` against the report hash, labels,
override review and current classifier fingerprint. Record the human decision
in the Issue/PR; local artifacts are not a replacement for that decision.
Do not create an approval record without the human decision. Private Issue sending
requires the independent boolean `run.triage.allowPrivateIssues: true`, authorized by
the operator; default is rejection. Only reviewed, non-personal development title/body
from the current repository may be sent; no secrets, comments or attachments. Handle `resolveTriage`
before first role dispatch: accept only certain risk/Size, override with enum values
and a closed reason, or fallback with manual assignment. Adopted values can only
raise existing risk/Size; high/critical need planner, implementer and independent
reviewer. Keep started programs across handoff; discard implementer recommendations
for reviewer selection. Never write Size/status to GitHub. Route abstention is not
capability evidence. The classic dry-run never fetches Issue text or calls Jev.

## State and reporting

Store only non-sensitive Issue numbers, milestones, release policy, routing labels, timestamps, and exact usage values in ignored local state. Never store credentials, Issue bodies, prompts, diffs, or personal data.

Report input, cached-input, output tokens, tool/wait calls, wall-clock duration, and fetched byte counts only when the runtime provides exact values. Use `unavailable` for absent fields. Estimates must be separately labeled and never added to exact totals.

Use this concise summary shape:

```json
{
  "routing": { "parent": "verified|unavailable" },
  "runnable": [101],
  "assignments": [{ "number": 101, "agent": "Codex", "model": "gpt-5" }],
  "roles": [{ "issue": 101, "executionMode": "direct-review", "role": "reviewer", "status": "active", "reviewPasses": 0 }],
  "blocked": [{ "number": 102, "reason": "dependencies-incomplete:101" }],
  "skipped": [],
  "milestones": [{ "issue": 101, "type": "pr-created" }],
  "usage": { "issues": [{ "number": 101, "usage": "unavailable" }], "total": "unavailable" }
}
```

For provider and CLI capability checks, read [provider-routing.md](references/provider-routing.md).
