import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

export const agent = "Claude";
export const evaluationOrder = 1;

const CLI_NAMES = ["claude"];

function parseAuth(stdout) {
  try {
    const json = JSON.parse(String(stdout ?? "").trim());
    return json?.loggedIn === true;
  } catch {
    return /loggedIn"\s*:\s*true/.test(String(stdout ?? ""));
  }
}

async function readSettingsModel(homeDir) {
  try {
    const raw = await fs.readFile(path.join(homeDir, ".claude", "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    if (typeof settings?.model !== "string" || !settings.model.trim()) return null;
    // Strip UI suffixes such as `[1m]`.
    return settings.model
      .trim()
      .replace(/\[[^\]]*\]\s*$/, "")
      .trim();
  } catch {
    return null;
  }
}

function modelEntry(model, requestedModel = model) {
  if (typeof model !== "string" || !model.trim()) return null;
  const normalized = model
    .trim()
    .replace(/\[[^\]]*\]\s*$/, "")
    .trim();
  if (!normalized) return null;
  return {
    model: normalized,
    requestedModel:
      typeof requestedModel === "string" && requestedModel.trim() ? requestedModel.trim() : normalized,
  };
}

function projectPaths(cwd, explicitProjectPath) {
  const start = explicitProjectPath || cwd;
  if (typeof start !== "string" || !start.trim()) return [];
  const paths = [];
  let current = path.resolve(start);
  while (true) {
    paths.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

async function readClaudeJsonModels(homeDir, cwd, explicitProjectPath) {
  try {
    const raw = await fs.readFile(path.join(homeDir, ".claude.json"), "utf8");
    const config = JSON.parse(raw);
    const projects = config?.projects;
    if (!projects || typeof projects !== "object") return null;

    for (const projectPath of projectPaths(cwd, explicitProjectPath)) {
      const project = projects[projectPath];
      const usage = project?.lastModelUsage;
      if (!usage || typeof usage !== "object") continue;
      const models = Object.keys(usage)
        .map((model) => modelEntry(model))
        .filter(Boolean);
      if (models.length) return models;
    }
  } catch {
    // Missing or malformed local state is equivalent to no discovered model.
  }
  return null;
}

async function readAvailableModelOptions(homeDir) {
  try {
    const raw = await fs.readFile(path.join(homeDir, ".claude.json"), "utf8");
    const config = JSON.parse(raw);
    if (!Array.isArray(config?.additionalModelOptionsCache)) return null;
    const models = config.additionalModelOptionsCache
      .map((entry) => modelEntry(entry?.value, entry?.label))
      .filter(Boolean);
    return models.length ? models : null;
  } catch {
    return null;
  }
}

/**
 * Discover Claude routes from interfaces exposed by the installed CLI and its
 * local state. Claude Code has no `models` subcommand; exact model identifiers
 * are recorded in ~/.claude.json after use and its available-model cache is a
 * secondary source. Every candidate still needs the headless execution probe.
 */
export async function discover(ctx = {}) {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const workerTimeoutMs = ctx.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const run = ctx.runProcess ?? runProcess;
  const resolve = ctx.resolveExecutable ?? resolveExecutable;
  const env = ctx.env ?? process.env;
  const homeDir = ctx.homeDir ?? os.homedir();
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

  const auth = await run(cliPath, ["auth", "status"], { timeoutMs, env, cwd: ctx.cwd });
  if (auth.timedOut) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.VERIFICATION_TIMEOUT }));
    return { records, diagnostics };
  }
  if (!parseAuth(auth.stdout)) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.AUTH_UNAVAILABLE }));
    return { records, diagnostics };
  }

  let models = null;
  if (typeof ctx.settingsModel === "string" && ctx.settingsModel.trim()) {
    models = [modelEntry(ctx.settingsModel)];
  } else if (Array.isArray(ctx.candidateModels) && ctx.candidateModels.length) {
    // Explicit test/override candidates only — never production guesses.
    models = ctx.candidateModels
      .map((entry) =>
        typeof entry === "string" ? modelEntry(entry) : modelEntry(entry?.model, entry?.requestedModel),
      )
      .filter(Boolean);
  } else {
    models = await readClaudeJsonModels(homeDir, ctx.cwd, ctx.projectPath);
    if (!models?.length) models = await readAvailableModelOptions(homeDir);
    if (!models?.length) {
      const legacySettingsModel = await readSettingsModel(homeDir);
      if (legacySettingsModel) models = [modelEntry(legacySettingsModel)];
    }
  }

  if (!models?.length) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.MODEL_NOT_SELECTABLE }));
    return { records, diagnostics };
  }

  const candidates = [];
  for (const { model, requestedModel } of models) {
    if (!model) {
      diagnostics.push(
        diagnostic({ agent, status: "failed", reason: REASON_CODES.MODEL_NOT_SELECTABLE, model }),
      );
      continue;
    }
    const modelArg = quoteSelectorArg(model);
    if (!modelArg) {
      diagnostics.push(
        diagnostic({ agent, status: "failed", reason: REASON_CODES.MODEL_NOT_SELECTABLE, model }),
      );
      continue;
    }
    // `--permission-mode bypassPermissions` is required for `-p` to complete
    // a real tool-use task headlessly; without it the worker exits 1 on the
    // first edit permission prompt with no human present to answer it.
    const selector = `${cliPath} --model ${modelArg} --permission-mode bypassPermissions`;
    candidates.push({ model, requestedModel: requestedModel ?? model, selector });
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
  // Claude non-interactive: print mode with the worker contract as the prompt.
  const args = [...tokens.slice(1), "-p", prompt];
  return runSpawn(cliPath, args, {
    timeoutMs: job.timeoutMs,
    env,
    cwd: job.cwd ?? ctx.cwd,
  });
}
