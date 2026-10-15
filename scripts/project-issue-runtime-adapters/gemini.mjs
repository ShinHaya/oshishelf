import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_WORKER_TIMEOUT_MS,
  REASON_CODES,
  buildWorkerPrompt,
  capabilityRecord,
  diagnostic,
  isAntigravityCommand,
  quoteSelectorArg,
  resolveExecutable,
  verifyModelCandidate,
  runProcess,
  spawnWorker,
  splitSelector,
} from "./shared.mjs";

export const agent = "Gemini";
export const evaluationOrder = 3;

// Only the independent Gemini CLI is eligible; Antigravity is retired.
const CLI_NAMES = ["gemini"];

function parseModels(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      return json
        .map((entry) => {
          const id = typeof entry === "string" ? entry : (entry?.id ?? entry?.model ?? entry?.name);
          if (typeof id !== "string" || !id.trim()) return null;
          return { model: id.trim(), requestedModel: id.trim() };
        })
        .filter(Boolean);
    }
  } catch {
    // line list
  }
  const models = [];
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim();
    if (!name) continue;
    if (/^available models/i.test(name) || /^usage of/i.test(name)) continue;
    // Reject prose/tips: require a product-style model display name.
    // Preserve model labels returned by the CLI, including spaces.
    if (!/^(Gemini|Claude|GPT)\b/i.test(name)) continue;
    if (/[.!?]$/.test(name)) continue;
    models.push({ model: name, requestedModel: name });
  }
  return models.length ? models : null;
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
  const names = ctx.cliPath ? [ctx.cliPath] : CLI_NAMES;
  for (const name of names) {
    if (isAntigravityCommand(name)) continue;
    const resolved = await resolve(name, { env, pathEnv: ctx.pathEnv });
    if (resolved && !isAntigravityCommand(resolved)) {
      cliPath = resolved;
      break;
    }
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
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.AUTH_UNAVAILABLE }));
    return { records, diagnostics };
  }

  const models = parseModels(listed.stdout);
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
    const selector = `${cliPath} --model ${modelArg}`;
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
    const result = await verifyModelCandidate(candidate, { ...ctx, run, env, extraArgs: [] });
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
  if (isAntigravityCommand(command)) throw new Error("runtime-retired");
  const cliPath = (await resolve(command, { env, pathEnv: ctx.pathEnv })) ?? command;
  if (isAntigravityCommand(cliPath)) throw new Error("runtime-retired");
  const prompt = buildWorkerPrompt(job);
  const args = [...tokens.slice(1), prompt];
  return runSpawn(cliPath, args, {
    timeoutMs: job.timeoutMs,
    env,
    cwd: job.cwd ?? ctx.cwd,
  });
}
