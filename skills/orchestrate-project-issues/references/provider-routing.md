# Agent / model routing

Treat agent and model availability as runtime capability, not repository truth. No Issue or
Project field names an agent or model; the automatic capability discovery path below is the only
source of routes for a normal orchestration run, and the orchestrating agent assigns Issues to
routes at run time.

## Automatic discovery (normal path)

1. `project-issue-orchestrator.mjs` invokes discovery automatically whenever no `--capabilities-file`
   / input capabilities are supplied. By **default it reuses `state/project-issue-capabilities.json`**
   instead of re-probing every adapter on every run — pass `--refresh` to force a full re-discovery, or
   `--invalidate-agent <name>` (repeatable) to drop and re-probe only the agent(s) that just failed at
   dispatch time, without disturbing the rest of the cache. A cached entry is also re-probed
   automatically when its recorded CLI path/`--version` no longer matches. Run
   `node scripts/project-issue-capabilities.mjs` directly only when you specifically want an
   unconditional full re-discovery outside the orchestrator (it always probes every adapter fresh).
2. Adapters are evaluated in fixed order: **Codex → Claude → Grok → Gemini**. Only the independent
   `gemini` CLI is eligible for Gemini. Antigravity (`agy`) is retired as a worker runtime
   and is excluded even when installed or present in an old cache/explicit capability file.
3. Each adapter performs CLI existence and auth/availability checks, then exact model selection. A
   model list alone does not make a route usable: each adapter also runs a **headless execution
   probe** for each exact model/selector pair — spawn the CLI with no TTY attached and a minimal, locally-generated
   tool-use task ("create this exact file with this exact marker"), then check the artifact. Only a
   route whose exact model actually completed that task under a fixed timeout emits capability records of
   shape `{agent, requestedModel, model, role, selector, selectable, verifiable, timeoutMs}`. This
   catches CLIs that answer an auth/model-list check but cannot actually act unattended (e.g. a CLI
   that demands a real TTY, or one whose "print" mode only ever answers in prose and never touches a
   tool). The probe never persists the generated prompt, the marker, or any stdout/stderr — only the
   pass/fail verdict and a closed reason code leave it.
4. Failures use closed reason codes only: `cli-not-found`, `auth-unavailable`,
   `model-not-selectable`, `model-mismatch`, `verification-timeout`, `probe-failed`, and the headless-
   probe-specific `tty-required` (CLI demanded a real terminal), `non-agentic-print-mode` (exited
   cleanly but never produced the artifact), `headless-exec-failed` (any other unexplained failure).
   Diagnostics and run state must never store credentials, prompts, Issue bodies, diffs, or model
   response bodies.
5. Capability JSON is written atomically (`state/project-issue-capabilities.json` by default) with
   `cli` (per-agent resolved path + `--version`) and `probedAt` metadata used for the next run's
   freshness check. A partial or previous file is never treated as a successful new discovery result.
   A dry run never writes the cache, whether reusing it or (re-)discovering fresh.
6. One or more verified worker routes is enough to continue; failed adapters are omitted. Zero
   verified worker routes with runnable Issues fails closed as `no-worker-route-available` before any
   worktree mutation.

`--capabilities-file` remains for tests and intentional non-default runs. Do not hand-author a
Codex-only file for ordinary orchestration; discovery (fresh or cached) is the source of truth.

## Route rules

1. A route is usable only when both `selectable` and `verifiable` are true. `requestedModel` is the
   exact display label when one exists; `model` is the canonical identifier returned or accepted by
   the runtime. A requested route must exactly match either `model` or `requestedModel` on
   the same verified record. Do not infer aliases or normalize case.
2. If the runtime cannot select or prove a requested model machine-readably, that route is
   unavailable (`verifiable: false` / omitted). Do not use a nearby model name and never relabel
   another model.
3. Apply `--unavailable-agent` and `--unavailable-model` only to the current run. They remove routes
   from the run's worker pool; they never trigger substitution. Re-run discovery next time.
4. The parent runtime's own worker records are admitted per its worker mode (see the
   orchestration skill): in `auto`, only while the parent's 5-hour window (exactly 300 minutes)
   has at least 50% left. Only Codex exposes this machine-readably (`codex app-server`,
   `account/rateLimits/read`, bounded by a timeout that terminates the child). Other runtimes
   report `parent-usage-unsupported-runtime` and are never estimated from tokens or logs.
5. Require a positive `timeoutMs` in every external CLI capability record. On timeout, emit a failure
   milestone, terminate only that CLI process (via `project-issue-dispatch.mjs` / the matching
   adapter), and preserve the Issue worktree; pick a handoff recipient from the remaining routes for
   `handoff-issue`.

## Dispatch

When dynamic assignment selects a non-Codex route, launch it through the same adapter that produced
the capability record, reusing the exact `selector` and `model`. Use
`node scripts/project-issue-dispatch.mjs --route-json '…' --issue N --release-policy … --next-milestone …`
or the `dispatchWorker` export. The worker receives only Issue number, agent/model route, release
policy, and next milestone.

Runtime interfaces differ. Verify availability for each supported CLI and exact model.
Antigravity is an explicit operator exclusion, not a transient probe failure; it must not be
reintroduced by cache refresh or handoff.
