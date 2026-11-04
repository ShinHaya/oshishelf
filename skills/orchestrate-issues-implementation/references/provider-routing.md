# Agent / model routing

Treat agent and model availability as runtime capability, not repository truth. No Issue or
Project field names an agent or model; the automatic capability discovery path below is the only
source of routes for a normal orchestration run, and the orchestrating agent assigns Issues to
routes at run time.

## Model catalog

Candidates come from the local model catalog `state/model-catalog.json`, written by
`scripts/issue-model-catalog.mjs` (also by the `refresh-model-catalog` skill). Each runtime's
definition declares how its CLI lists models: a list command (`models.args`) or one
control-protocol request (`models.control`, Claude's `initialize`). Listing never executes a
model and keeps only model IDs, labels, CLI path/version, timestamps and closed reason codes.
Before discovery the orchestrator re-lists a runtime whose entry is missing, failed, older than
`run.modelCatalog.maxAgeHours` (default 168), or whose CLI path/`--version` changed;
`--refresh-catalog` forces it and `--dry-run` never writes it. A runtime whose candidate list
changed is re-probed; unchanged runtimes keep their cached capability records.

## Automatic discovery (normal path)

1. `issue-orchestrator.mjs` invokes discovery automatically whenever no `--capabilities-file`
   / input capabilities are supplied. By **default it reuses `state/issue-capabilities.json`**
   instead of re-probing every adapter on every run — pass `--refresh` to force a full re-discovery, or
   `--invalidate-agent <name>` (repeatable) to drop and re-probe only the agent(s) that just failed at
   dispatch time, without disturbing the rest of the cache. A cached entry is also re-probed
   automatically when its recorded CLI path/`--version` no longer matches. Run
   `node scripts/issue-capabilities.mjs` directly only when you specifically want an
   unconditional full re-discovery outside the orchestrator (it always probes every adapter fresh).
2. Enabled runtime definitions are evaluated by `evaluationOrder`, then ID. Inspect IDs,
   aliases and enabled/disabled/retired status with `node scripts/ai-template.mjs agents list`.
   Definition/config fingerprints invalidate the cache when registration changes, even without a
   commit. Disabled and retired routes cannot return through cached or explicit capabilities.
3. Each adapter takes its candidates from the catalog (a fresh listing for dispatch preflight and
   triage batches), then exact model selection. A model list alone does not make a route usable: each adapter also runs a **headless execution
   probe** for each exact model/selector pair — spawn the CLI with no TTY attached and a minimal, locally-generated
   tool-use task ("create this exact file with this exact marker"), then check the artifact. Only a
   route whose exact model actually completed that task under a fixed timeout emits capability records of
   shape `{agent, requestedModel, model, role, selector, selectable, verifiable, timeoutMs}`. This
   catches CLIs that answer an auth/model-list check but cannot actually act unattended (e.g. a CLI
   that demands a real TTY, or one whose "print" mode only ever answers in prose and never touches a
   tool). The probe never persists the generated prompt, the marker, or any stdout/stderr — only the
   pass/fail verdict and a closed reason code leave it. For a runtime with
   `models.resolveReportedModel` the catalog value is an alias (`sonnet`): the probe must report
   exactly one canonical model, which becomes `model`, and the alias becomes `requestedModel`.
4. Failures use closed reason codes only: `cli-not-found`, `auth-unavailable`,
   `model-not-selectable`, `model-mismatch`, `model-unresolved`, `model-not-allowed`, `model-denied`,
   `verification-timeout`, `probe-failed`, and the headless-
   probe-specific `tty-required` (CLI demanded a real terminal), `non-agentic-print-mode` (exited
   cleanly but never produced the artifact), `headless-exec-failed` (any other unexplained failure).
   Diagnostics and run state must never store credentials, prompts, Issue bodies, diffs, or model
   response bodies.
5. Capability JSON is written atomically (`state/issue-capabilities.json` by default) with
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
3. Repository-owned model policy (`agents.models.<id>.allow` / `.deny` in `.ai-template/config.json`)
   is persistent, not run state: a model outside `allow` (`model-not-allowed`) or matching a `deny`
   pattern (`model-denied`; case-insensitive `*` patterns on the catalog value, its label and the
   reported canonical model, winning over `allow`) is never probed, selected or launched, even from
   a cached or explicit capability record. Do not work around it with explicit capabilities or
   `--unavailable-model`; change the committed policy instead.
4. Apply `--unavailable-agent` and `--unavailable-model` only to the current run. They remove routes
   from the run's worker pool; they never trigger substitution. Re-run discovery next time.
5. The parent runtime's own worker records are admitted per its worker mode (see the
   orchestration skill): in `auto`, only while the parent's 5-hour window (exactly 300 minutes)
   has at least 50% left. Only Codex exposes this machine-readably (`codex app-server`,
   `account/rateLimits/read`, bounded by a timeout that terminates the child). Other runtimes
   report `parent-usage-unsupported-runtime` and are never estimated from tokens or logs.
6. Require a positive `timeoutMs` in every external CLI capability record. On timeout, emit a failure
   milestone, terminate only that CLI process (via `issue-dispatch.mjs` / the matching
   adapter), and preserve the Issue worktree; pick a handoff recipient from the remaining routes for
   `handoff-issue`.

## Dispatch

When dynamic assignment selects a non-Codex route, launch it through the same adapter that produced
the capability record, reusing the exact `selector` and `model`. Use
`node scripts/issue-dispatch.mjs --route-json '…' --issue N --release-policy … --next-milestone …`
or the `dispatchWorker` export. The worker receives only Issue number, agent/model route, release
policy, and next milestone. A worker that owns the Issue worktree (single-worker mode or the
implementer role) also receives a fresh, non-sensitive lease session ID. The dispatcher renews that
lease while the worker runs (`acquire --heartbeat`) and stops when the worker exits.

Runtime interfaces differ. Verify availability for each supported CLI and exact model.
Antigravity is an explicit operator exclusion, not a transient probe failure; it must not be
reintroduced by cache refresh or handoff.
