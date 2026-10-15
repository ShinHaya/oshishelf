#!/usr/bin/env node

/**
 * Deterministic worker-runtime capability discovery for project-issue orchestration.
 *
 * Evaluates Codex → Claude → Grok → Gemini adapters in fixed order, emits only
 * verified capability records, and writes the result atomically. Diagnostics use
 * closed reason codes and never store credentials, prompts, Issue bodies, diffs,
 * or model response bodies.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_WORKER_TIMEOUT_MS,
  PROBE_SCHEMA_VERSION,
  REASON_CODES,
  getRepositoryCommit,
  isAntigravityCommand,
  isRetiredRuntimeRoute,
  readCliVersion,
  runProcess,
  writeJsonAtomic,
} from "./project-issue-runtime-adapters/shared.mjs";
import { RUNTIME_ADAPTERS, discoverAllCapabilities } from "./project-issue-runtime-adapters/index.mjs";

import { selectWorkerRoutes } from "./project-issue-plan.mjs";

export const DEFAULT_CAPABILITIES_OUTPUT = "state/project-issue-capabilities.json";

/** Resolve a user-supplied agent name to its canonical `RUNTIME_ADAPTERS` casing, or null. */
function canonicalAgentName(name) {
  const needle = String(name ?? "").trim().toLowerCase();
  return RUNTIME_ADAPTERS.find((adapter) => adapter.agent.toLowerCase() === needle)?.agent ?? null;
}

/**
 * Run discovery (optionally limited to `options.only` adapter names) and
 * optionally write an atomic capabilities file. The written/returned payload
 * carries `cli` (per-agent resolved path + `--version` string) and
 * `probedAt` so a later run can decide whether the cache is still fresh
 * without re-running any adapter.
 *
 * @returns {{ capabilities: object[], diagnostics: object[], cli: object, probedAt: string, outputPath?: string }}
 */
export async function discoverCapabilities(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const workerTimeoutMs = options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const run = options.runProcess ?? runProcess;
  const result = await discoverAllCapabilities({
    timeoutMs,
    workerTimeoutMs,
    env: options.env,
    pathEnv: options.pathEnv,
    cwd: options.cwd,
    homeDir: options.homeDir,
    adapters: options.adapters,
    runProcess: options.runProcess,
    resolveExecutable: options.resolveExecutable,
    headlessExecProbe: options.headlessExecProbe,
    headlessProbeTimeoutMs: options.headlessProbeTimeoutMs,
    only: options.only,
    modelFilter: options.modelFilter,
  });

  // Strip anything that is not a closed diagnostic field (defense in depth).
  const diagnostics = (result.diagnostics ?? []).map((entry) => ({
    agent: entry.agent,
    status: entry.status,
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.model ? { model: entry.model } : {}),
  }));

  const capabilities = (result.capabilities ?? []).filter(
    (record) =>
      record &&
      typeof record.agent === "string" &&
      typeof record.model === "string" &&
      typeof record.role === "string" &&
      typeof record.selector === "string" &&
      record.selectable === true &&
      record.verifiable === true &&
      Number.isSafeInteger(record.timeoutMs) &&
      record.timeoutMs > 0,
  );

  const cli = {};
  for (const [agentName, meta] of Object.entries(result.cli ?? {})) {
    if (typeof meta?.path !== "string" || !meta.path) continue;
    const version = await readCliVersion(meta.path, { run, timeoutMs, env: options.env });
    cli[agentName] = { path: meta.path, ...(version ? { version } : {}) };
  }

  const repositoryCommit = await getRepositoryCommit(options.cwd ?? process.cwd());
  const payload = {
    capabilities,
    diagnostics,
    cli,
    probedAt: new Date().toISOString(),
    repositoryCommit,
    probeSchemaVersion: PROBE_SCHEMA_VERSION
  };

  let outputPath;
  if (options.outputPath) {
    outputPath = await writeJsonAtomic(options.outputPath, payload);
  }

  return { ...payload, ...(outputPath ? { outputPath } : {}) };
}

/**
 * Check whether each adapter named in a cached `cli` metadata block still
 * resolves to the same executable at the same version. An adapter whose
 * executable moved/disappeared or whose `--version` output changed is
 * reported as stale and must be re-probed before its cached records are
 * trusted again.
 */
async function findStaleCachedAgents(
  cliMeta,
  { env, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, runProcess: run = runProcess } = {},
) {
  const stale = [];
  for (const [agentName, meta] of Object.entries(cliMeta ?? {})) {
    if (typeof meta?.path !== "string" || !meta.path) {
      stale.push(agentName);
      continue;
    }
    try {
      await fs.access(meta.path);
    } catch {
      stale.push(agentName);
      continue;
    }
    // Same budget discoverCapabilities used to record `meta.version`:
    // a shorter default here would read `null` for a
    // slow-but-unchanged CLI, judge it stale, and re-probe every run forever.
    const version = await readCliVersion(meta.path, { run, timeoutMs, env });
    if (version !== (meta.version ?? null)) stale.push(agentName);
  }
  return stale;
}

/**
 * Cache-aware wrapper around {@link discoverCapabilities}. Reuses a
 * previously written capabilities file by default; a run only spawns CLI
 * processes when the cache is missing, explicitly refreshed, or found
 * partially stale (CLI path/version drift, or an agent named in
 * `invalidateAgents` — the signal an orchestration run sends after that
 * agent failed at dispatch time so the *next* run re-probes it instead of
 * trusting the stale "ok" cache entry forever).
 *
 * Never writes the cache file when `dryRun` is true, matching
 * `discoverCapabilities`'s existing no-disk-writes-during-dry-run contract.
 *
 * @returns {{ capabilities: object[], diagnostics: object[], cli: object, probedAt: string, reused: boolean, reprobedAgents?: string[] }}
 */
export async function loadOrRefreshCapabilities(options = {}) {
  const { cachePath, refresh = false, invalidateAgents = [], dryRun = false } = options;
  const discoveryOptions = {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    workerTimeoutMs: options.workerTimeoutMs,
    env: options.env,
    pathEnv: options.pathEnv,
    homeDir: options.homeDir,
    adapters: options.adapters,
    runProcess: options.runProcess,
    resolveExecutable: options.resolveExecutable,
    headlessExecProbe: options.headlessExecProbe,
    headlessProbeTimeoutMs: options.headlessProbeTimeoutMs,
  };

  let cached = null;
  if (!refresh && cachePath) {
    try {
      cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    } catch {
      cached = null;
    }
  }

  const currentRepositoryCommit = await getRepositoryCommit(options.cwd ?? process.cwd());
  const schemaMismatch = cached && cached.probeSchemaVersion !== PROBE_SCHEMA_VERSION;
  const commitMismatch = cached && currentRepositoryCommit && cached.repositoryCommit !== currentRepositoryCommit;

  const retiredCache = cached && ((cached.capabilities ?? []).some(isRetiredRuntimeRoute) ||
    Object.values(cached.cli ?? {}).some(entry => isAntigravityCommand(entry?.path)));
  if (!cached || refresh || schemaMismatch || commitMismatch || retiredCache) {
    const fresh = await discoverCapabilities({
      ...discoveryOptions,
      ...(dryRun ? {} : { outputPath: cachePath }),
    });
    return { ...fresh, reused: false };
  }

  const unknownInvalidateAgents = [];
  const canonicalInvalidateAgents = [];
  for (const name of invalidateAgents ?? []) {
    const canonical = canonicalAgentName(name);
    if (canonical) canonicalInvalidateAgents.push(canonical);
    else unknownInvalidateAgents.push(String(name));
  }
  if (unknownInvalidateAgents.length) {
    throw new Error(`unknown-invalidate-agent:${unknownInvalidateAgents.join(",")}`);
  }

  // Retry wholly unavailable agents, but retain ordinary cache reuse when
  // only a sibling model failed. Fresh triage batches use refreshWorkerRoutes
  // and always re-probe, including models with a previously failed probe.
  const previouslyFailedAgents = (cached.diagnostics ?? [])
    .filter((entry) => entry.status === "failed" && (
      !entry.model || !(cached.capabilities ?? []).some((record) =>
        record.agent === entry.agent && record.selectable === true && record.verifiable === true)
    ))
    .map((entry) => entry.agent);

  const staleAgents = new Set([
    ...canonicalInvalidateAgents,
    ...previouslyFailedAgents,
    ...(await findStaleCachedAgents(cached.cli, discoveryOptions)),
  ]);
  if (!staleAgents.size) {
    return {
      capabilities: cached.capabilities ?? [],
      diagnostics: cached.diagnostics ?? [],
      cli: cached.cli ?? {},
      probedAt: cached.probedAt,
      repositoryCommit: cached.repositoryCommit,
      probeSchemaVersion: cached.probeSchemaVersion,
      reused: true,
    };
  }

  const targeted = await discoverCapabilities({ ...discoveryOptions, only: [...staleAgents] });
  const merged = {
    capabilities: [
      ...(cached.capabilities ?? []).filter((record) => !staleAgents.has(record.agent)),
      ...targeted.capabilities,
    ],
    diagnostics: [
      ...(cached.diagnostics ?? []).filter((entry) => !staleAgents.has(entry.agent)),
      ...targeted.diagnostics,
    ],
    cli: { ...(cached.cli ?? {}), ...targeted.cli },
    probedAt: targeted.probedAt,
    repositoryCommit: targeted.repositoryCommit,
    probeSchemaVersion: targeted.probeSchemaVersion,
  };
  if (!dryRun && cachePath) await writeJsonAtomic(cachePath, merged);
  return { ...merged, reused: false, reprobedAgents: [...staleAgents] };
}

/**
 * Fresh pool for one triage batch. Never reads/writes a capability cache.
 * Call again for every new selection batch; only the caller may share a result
 * within that batch. Parent/unavailable exclusions remain deterministic.
 */
export async function refreshWorkerRoutes(options = {}) {
  const result = await discoverCapabilities({ ...options, outputPath: undefined });
  return { ...result, workerRoutes: selectWorkerRoutes(result.capabilities, options) };
}

/**
 * Dispatch preflight: re-read the selected agent's catalog and probe only the
 * exact model. Never execute the supplied selector; compare it to fresh CLI
 * discovery. A changed selector or a failed model requires route reselection.
 */
export async function verifyWorkerRoute(route, options = {}) {
  if (isRetiredRuntimeRoute(route)) return { ok: false, reason: REASON_CODES.MODEL_NOT_SELECTABLE };
  const agent = canonicalAgentName(route?.agent);
  if (!agent || typeof route?.model !== "string" || !route.model ||
      typeof route?.selector !== "string" || !route.selector) {
    return { ok: false, reason: REASON_CODES.MODEL_NOT_SELECTABLE };
  }
  const result = await refreshWorkerRoutes({
    ...options, only: [agent], modelFilter: route.model,
  });
  const verified = result.workerRoutes.find((candidate) =>
    candidate.agent === agent && candidate.model === route.model && candidate.selector === route.selector);
  if (verified) return { ok: true, route: verified, probedAt: result.probedAt };
  const failure = result.diagnostics.find((entry) =>
    entry.agent === agent && entry.status === "failed" && (!entry.model || entry.model === route.model));
  return { ok: false, reason: failure?.reason ?? REASON_CODES.MODEL_NOT_SELECTABLE };
}

export function parseCapabilitiesCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--stdout") {
      options.stdout = true;
      continue;
    }
    if (flag === "--output" || flag === "--output-path") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
      options.outputPath = value;
      continue;
    }
    if (flag === "--timeout-ms") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
      options.timeoutMs = Number(value);
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
        throw new Error("invalid-timeout-ms");
      continue;
    }
    if (flag === "--worker-timeout-ms") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
      options.workerTimeoutMs = Number(value);
      if (!Number.isSafeInteger(options.workerTimeoutMs) || options.workerTimeoutMs <= 0)
        throw new Error("invalid-worker-timeout-ms");
      continue;
    }
    throw new Error(`unknown-flag:${flag}`);
  }
  return options;
}

async function main() {
  const cli = parseCapabilitiesCliArgs(process.argv.slice(2));
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outputPath =
    cli.outputPath ??
    (cli.stdout ? undefined : path.join(repositoryRoot, DEFAULT_CAPABILITIES_OUTPUT));
  const result = await discoverCapabilities({
    outputPath,
    timeoutMs: cli.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    workerTimeoutMs: cli.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
    cwd: repositoryRoot,
  });
  // Summary only on stdout when writing a file; full JSON when --stdout.
  if (cli.stdout || !outputPath) {
    process.stdout.write(`${JSON.stringify({ capabilities: result.capabilities, diagnostics: result.diagnostics })}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        outputPath: result.outputPath,
        capabilityCount: result.capabilities.length,
        workerRouteCount: result.capabilities.filter((record) => record.role === "worker").length,
        diagnosticCount: result.diagnostics.length,
      })}\n`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "error", reason: error.message })}\n`);
    process.exitCode = 1;
  });
}
