import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_WORKER_TIMEOUT_MS,
  REASON_CODES,
  buildWorkerPrompt,
  capabilityRecord,
  diagnostic,
  quoteSelectorArg,
  resolveExecutable,
  verifyModelCandidate,
  runProcess,
  spawnWorker,
  splitSelector,
} from "./shared.mjs";

export const agent = "Codex";
export const evaluationOrder = 0;

const CLI_NAMES = ["codex"];

function parseLoginStatus(stdout) {
  const text = String(stdout ?? "");
  try {
    const json = JSON.parse(text);
    if (json?.loggedIn === true || json?.status === "logged-in") return true;
    if (json?.loggedIn === false) return false;
  } catch {
    // plain-text status
  }
  // Require a positive "logged in" and reject the common "Not logged in" form.
  if (/not\s+logged\s+in/i.test(text)) return false;
  if (/\blogged\s+in\b/i.test(text)) return true;
  return false;
}

function parseModelCatalog(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    if (start < 0) return null;
    try {
      payload = JSON.parse(text.slice(start));
    } catch {
      return null;
    }
  }
  const models = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : null;
  if (!models) return null;
  const out = [];
  for (const entry of models) {
    const slug = typeof entry?.slug === "string" ? entry.slug.trim() : "";
    if (!slug) continue;
    // Prefer models the CLI exposes for interactive/list selection.
    if (entry?.visibility && entry.visibility !== "list") continue;
    const display =
      typeof entry?.display_name === "string" && entry.display_name.trim()
        ? entry.display_name.trim()
        : slug;
    out.push({ model: slug, requestedModel: display });
  }
  return out;
}

/**
 * Discover Codex worker/parent routes. Uses `codex login status` and
 * `codex debug models` only — never stores catalog prose or auth material.
 */
export async function discover(ctx = {}) {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const workerTimeoutMs = ctx.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const run = ctx.runProcess ?? runProcess;
  const resolve = ctx.resolveExecutable ?? resolveExecutable;
  const env = ctx.env ?? process.env;
  const diagnostics = [];
  const records = [];

  let cliPath = null;
  for (const name of CLI_NAMES) {
    cliPath = await resolve(ctx.cliPath ?? name, { env, pathEnv: ctx.pathEnv });
    if (cliPath) break;
  }
  if (!cliPath) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.CLI_NOT_FOUND }));
    return { records, diagnostics };
  }

  const auth = await run(cliPath, ["login", "status"], { timeoutMs, env, cwd: ctx.cwd });
  if (auth.timedOut) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.VERIFICATION_TIMEOUT }));
    return { records, diagnostics };
  }
  if (!parseLoginStatus(auth.stdout) && !parseLoginStatus(auth.stderr)) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.AUTH_UNAVAILABLE }));
    return { records, diagnostics };
  }

  const catalog = await run(cliPath, ["debug", "models"], { timeoutMs, env, cwd: ctx.cwd });
  if (catalog.timedOut) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.VERIFICATION_TIMEOUT }));
    return { records, diagnostics };
  }
  if (catalog.code !== 0) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.PROBE_FAILED }));
    return { records, diagnostics };
  }
  const models = parseModelCatalog(catalog.stdout);
  if (!models) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.MODEL_NOT_SELECTABLE }));
    return { records, diagnostics };
  }
  if (!models.length) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.MODEL_NOT_SELECTABLE }));
    return { records, diagnostics };
  }

  const candidates = [];
  for (const { model, requestedModel } of models) {
    const modelArg = quoteSelectorArg(model);
    if (!modelArg) {
      diagnostics.push(
        diagnostic({ agent, status: "failed", reason: REASON_CODES.MODEL_NOT_SELECTABLE, model }),
      );
      continue;
    }
    candidates.push({ model, requestedModel, selector: `${cliPath} exec -m ${modelArg}` });
  }
  const selected = ctx.modelFilter === undefined
    ? candidates
    : candidates.filter((candidate) => candidate.model === ctx.modelFilter);
  if (!selected.length) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.MODEL_NOT_SELECTABLE }));
  }
  for (const candidate of selected) {
    const { model, requestedModel, selector } = candidate;
    const result = await verifyModelCandidate(candidate, { ...ctx, run, env, extraArgs: ["--skip-git-repo-check"] });
    if (!result.ok) {
      diagnostics.push(diagnostic({ agent, status: "failed", reason: result.reason, model }));
      continue;
    }
    for (const role of ["worker", "parent"]) {
      records.push(capabilityRecord({
        agent, requestedModel, model, role, selector, timeoutMs: workerTimeoutMs,
      }));
    }
    diagnostics.push(diagnostic({ agent, status: "ok", model }));
  }
  return { records, diagnostics, cliPath };
}

export async function launch(ctx, job) {
  const runSpawn = ctx.spawnWorker ?? spawnWorker;
  const resolve = ctx.resolveExecutable ?? resolveExecutable;
  const env = ctx.env ?? process.env;
  const tokens = splitSelector(job.selector);
  const command = tokens[0];
  const cliPath = (await resolve(command, { env, pathEnv: ctx.pathEnv })) ?? command;
  const prompt = buildWorkerPrompt(job);
  // Selector is `… exec -m <model>`; append the worker prompt as the final arg.
  const args = [...tokens.slice(1), prompt];
  return runSpawn(cliPath, args, {
    timeoutMs: job.timeoutMs,
    env,
    cwd: job.cwd ?? ctx.cwd,
  });
}
