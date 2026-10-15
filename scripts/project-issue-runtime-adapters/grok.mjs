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

export const agent = "Grok";
export const evaluationOrder = 2;

const CLI_NAMES = ["grok"];

function parseModelsOutput(stdout) {
  const text = String(stdout ?? "");
  if (!text.trim()) return { loggedIn: false, models: null };
  const notLoggedIn = /not\s+logged\s+in/i.test(text);
  const loggedIn =
    !notLoggedIn && (/\blogged\s+in\b/i.test(text) || /available models/i.test(text));
  const models = [];
  for (const line of text.split(/\r?\n/)) {
    const bullet = line.trim().match(/^\*\s+(\S+)/);
    if (bullet) {
      const id = bullet[1];
      // Skip annotation-only tokens.
      if (id === "(default)") continue;
      models.push({ model: id, requestedModel: id });
      continue;
    }
  }
  // Also accept a pure list of model ids (for fakes / future JSON).
  if (!models.length) {
    try {
      const json = JSON.parse(text.trim());
      if (Array.isArray(json)) {
        for (const entry of json) {
          const id = typeof entry === "string" ? entry : entry?.id ?? entry?.model;
          if (typeof id === "string" && id.trim()) {
            models.push({ model: id.trim(), requestedModel: id.trim() });
          }
        }
      }
    } catch {
      // not JSON
    }
  }
  return { loggedIn, models: models.length ? models : null };
}

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

  const listed = await run(cliPath, ["models"], { timeoutMs, env, cwd: ctx.cwd });
  if (listed.timedOut) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.VERIFICATION_TIMEOUT }));
    return { records, diagnostics };
  }
  if (listed.code !== 0) {
    // Auth failures often surface as non-zero exit without a model list.
    const { loggedIn } = parseModelsOutput(listed.stdout + listed.stderr);
    diagnostics.push(
      diagnostic({
        agent,
        status: "failed",
        reason: loggedIn ? REASON_CODES.PROBE_FAILED : REASON_CODES.AUTH_UNAVAILABLE,
      }),
    );
    return { records, diagnostics };
  }

  const { loggedIn, models } = parseModelsOutput(listed.stdout);
  if (!loggedIn && !models) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.AUTH_UNAVAILABLE }));
    return { records, diagnostics };
  }
  if (!models?.length) {
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
    // `--permission-mode bypassPermissions` is required for tool calls (file
    // writes) to complete with no human present to answer an approval
    // prompt. `-p`/`--single` (see launch()) forces the CLI's headless
    // single-turn mode instead of the default interactive TUI, which demands
    // a real TTY and fails with a raw-terminal error when spawned headless.
    const selector = `${cliPath} --model ${modelArg} --permission-mode bypassPermissions`;
    candidates.push({ model, requestedModel, selector });
  }
  const selected = ctx.modelFilter === undefined
    ? candidates
    : candidates.filter((candidate) => candidate.model === ctx.modelFilter);
  if (!selected.length) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.MODEL_NOT_SELECTABLE }));
  }
  for (const candidate of selected) {
    const { model, requestedModel, selector } = candidate;
    const result = await verifyModelCandidate(candidate, { ...ctx, run, env, extraArgs: ["-p"] });
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
  // `-p`/`--single <PROMPT>` forces grok's headless single-turn mode; a bare
  // trailing positional prompt is treated as the initial prompt for an
  // *interactive* session and requires a TTY.
  const args = [...tokens.slice(1), "-p", prompt];
  return runSpawn(cliPath, args, {
    timeoutMs: job.timeoutMs,
    env,
    cwd: job.cwd ?? ctx.cwd,
  });
}
