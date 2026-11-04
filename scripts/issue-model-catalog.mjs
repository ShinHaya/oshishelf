#!/usr/bin/env node
import { runtimeEnvironment } from "./ai-template/registry.mjs";

/**
 * Local model catalog: the latest model list each enabled runtime's CLI
 * reports, stored at state/model-catalog.json (ignored by Git, because model
 * availability depends on the machine and account). Listing never executes a
 * model; the costed headless probe stays in issue-capabilities.mjs.
 *
 * The catalog stores only runtime IDs, CLI path/version, listing source, model
 * IDs and labels, timestamps and closed reason codes.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchRuntimeCatalog,
  resolveRuntimeCli,
} from "./issue-runtime-adapters/catalog.mjs";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  readCliVersion,
  runProcess,
  writeJsonAtomic,
} from "./issue-runtime-adapters/shared.mjs";
import {
  findRuntime,
  isModelAllowed,
  isModelDenied,
  loadRuntimeRegistry,
} from "./ai-template/registry.mjs";

export const DEFAULT_MODEL_CATALOG_PATH = "state/model-catalog.json";
export const DEFAULT_CATALOG_MAX_AGE_HOURS = 168;
export const CATALOG_SCHEMA_VERSION = 1;

/**
 * @typedef {{ model: string, label: string }} CatalogModel
 * @typedef {{ name: string, status: "ok" | "failed", reason?: string, source?: string,
 *   cli?: { path: string, version?: string }, models: CatalogModel[], refreshedAt: string }} CatalogEntry
 * @typedef {{ schemaVersion: number, runtimeFingerprint: string, refreshedAt: string,
 *   agents: Record<string, CatalogEntry> }} ModelCatalog
 * @typedef {{ cwd?: string, catalogPath?: string, maxAgeHours?: number, refresh?: boolean, only?: string[],
 *   dryRun?: boolean, now?: () => Date, timeoutMs?: number, env?: NodeJS.ProcessEnv, pathEnv?: string,
 *   runProcess?: typeof runProcess, resolveExecutable?: Function, spawn?: Function,
 *   adapters?: Record<string, Record<string, any>> }} CatalogOptions
 */

/**
 * Stable per-runtime fingerprint of the candidate list; capability caches compare it.
 * Labels count: an alias (`sonnet`) can keep its value while its label names a new generation.
 */
export function catalogEntryFingerprint(entry) {
  const value =
    entry?.status === "ok"
      ? {
          cli: entry.cli?.path ?? null,
          models: entry.models.map((m) => [m.model, m.label]),
        }
      : null;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Adapter listing form of one catalog entry. */
export function catalogListing(entry) {
  return entry.status === "ok"
    ? {
        status: "ok",
        cliPath: entry.cli?.path,
        source: entry.source,
        models: entry.models,
      }
    : {
        status: "failed",
        reason: entry.reason,
        ...(entry.cli?.path ? { cliPath: entry.cli.path } : {}),
      };
}

/** @param {string} [filePath] @returns {Promise<ModelCatalog | null>} */
export async function readModelCatalog(filePath) {
  if (!filePath) return null;
  try {
    const catalog = JSON.parse(await fs.readFile(filePath, "utf8"));
    return catalog &&
      typeof catalog === "object" &&
      catalog.agents &&
      typeof catalog.agents === "object"
      ? catalog
      : null;
  } catch {
    return null;
  }
}

/**
 * Enabled runtime IDs whose entry must be re-listed: missing catalog or schema/registry
 * change (all), and per runtime a missing or failed entry, an entry older than
 * `maxAgeHours`, a CLI that now resolves to a different path (or none), or whose
 * `--version` changed.
 * @param {ModelCatalog | null} catalog
 * @param {CatalogOptions} [options]
 */
export async function findStaleCatalogAgents(catalog, options = {}) {
  const registry = loadRuntimeRegistry(options.cwd);
  const enabled = registry.enabled.map((runtime) => runtime.id);
  if (
    !catalog ||
    catalog.schemaVersion !== CATALOG_SCHEMA_VERSION ||
    catalog.runtimeFingerprint !== registry.fingerprint
  )
    return enabled;
  const maxAgeMs =
    (options.maxAgeHours ?? DEFAULT_CATALOG_MAX_AGE_HOURS) * 3_600_000;
  const now = (options.now ?? (() => new Date()))().getTime();
  const run = options.runProcess ?? runProcess;
  const stale = [];
  for (const runtime of registry.enabled) {
    const id = runtime.id;
    const entry = catalog.agents[id];
    const refreshedAt = Date.parse(entry?.refreshedAt ?? "");
    if (
      !entry ||
      entry.status !== "ok" ||
      !Number.isFinite(refreshedAt) ||
      now - refreshedAt >= maxAgeMs ||
      typeof entry.cli?.path !== "string" ||
      !entry.cli.path
    ) {
      stale.push(id);
      continue;
    }
    // Re-resolve with the current environment: PATH may now select another installation.
    const ctx = {
      ...options,
      ...(options.adapters?.[id] ?? options.adapters?.[runtime.name] ?? {}),
    };
    let resolved;
    try {
      resolved = await resolveRuntimeCli(runtime, ctx);
    } catch {
      stale.push(id);
      continue;
    }
    if (resolved !== entry.cli.path) {
      stale.push(id);
      continue;
    }
    try {
      await fs.access(entry.cli.path);
    } catch {
      stale.push(id);
      continue;
    }
    const version = await readCliVersion(entry.cli.path, {
      run,
      timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      env: runtimeEnvironment(runtime, ctx),
    });
    if (version !== (entry.cli.version ?? null)) stale.push(id);
  }
  return stale;
}

/**
 * Per-runtime differences between two catalogs; `policy` reflects the current repository config.
 * @param {ModelCatalog | null} previous
 * @param {ModelCatalog} next
 * @param {string} [root]
 */
export function diffCatalogs(previous, next, root = process.cwd()) {
  const diff = {};
  for (const [id, entry] of Object.entries(next.agents)) {
    const before = previous?.agents?.[id];
    const oldModels = new Map(
      (before?.status === "ok" ? before.models : []).map((m) => [
        m.model,
        m.label,
      ]),
    );
    const newModels = new Map(
      (entry.status === "ok" ? entry.models : []).map((m) => [
        m.model,
        m.label,
      ]),
    );
    const added = [...newModels]
      .filter(([model]) => !oldModels.has(model))
      .map(([model, label]) => ({
        model,
        label,
        policy: modelPolicy(id, { model, label }, root),
      }));
    const removed = [...oldModels.keys()].filter(
      (model) => !newModels.has(model),
    );
    const relabeled = [...newModels]
      .filter(
        ([model, label]) =>
          oldModels.has(model) && oldModels.get(model) !== label,
      )
      .map(([model, label]) => ({
        model,
        from: oldModels.get(model),
        to: label,
      }));
    const statusChanged =
      (before?.status ?? null) !== entry.status ||
      (before?.reason ?? null) !== (entry.reason ?? null);
    if (added.length || removed.length || relabeled.length || statusChanged)
      diff[id] = {
        ...(statusChanged
          ? {
              status: {
                from: before?.status ?? null,
                to: entry.status,
                ...(entry.reason ? { reason: entry.reason } : {}),
              },
            }
          : {}),
        added,
        removed,
        relabeled,
      };
  }
  return diff;
}

/** `denied` (deny pattern on value or label) | `not-allowed` (outside allow) | `allowed`. */
export function modelPolicy(agentId, { model, label }, root = process.cwd()) {
  if (isModelDenied(agentId, model, root, label)) return "denied";
  return isModelAllowed(agentId, model, root) ? "allowed" : "not-allowed";
}

/**
 * Load the catalog and re-list only the runtimes that need it (all when `refresh`, or `only`).
 * Writes atomically unless `dryRun`; a failed listing is recorded with its closed reason and
 * never replaces a previous successful entry's models for the purpose of diffs.
 * @param {CatalogOptions} [options]
 * @returns {Promise<{ catalog: ModelCatalog, refreshedAgents: string[], diff: Record<string, any>, written: boolean }>}
 */
export async function ensureModelCatalog(options = {}) {
  const registry = loadRuntimeRegistry(options.cwd);
  const previous = await readModelCatalog(options.catalogPath);
  let targets;
  if (options.only?.length) {
    targets = options.only.map((name) => {
      const runtime = findRuntime(name, options.cwd, { enabledOnly: true });
      if (!runtime) throw new Error(`unknown-catalog-agent:${name}`);
      return runtime.id;
    });
  } else {
    targets = options.refresh
      ? registry.enabled.map((runtime) => runtime.id)
      : await findStaleCatalogAgents(previous, options);
  }
  const reset =
    !previous ||
    previous.schemaVersion !== CATALOG_SCHEMA_VERSION ||
    previous.runtimeFingerprint !== registry.fingerprint;
  const agents = {};
  // Keep only entries of currently enabled runtimes; disabled/retired ones never return.
  for (const runtime of registry.enabled)
    if (!reset && previous.agents[runtime.id])
      agents[runtime.id] = previous.agents[runtime.id];
  const now = (options.now ?? (() => new Date()))().toISOString();
  const run = options.runProcess ?? runProcess;
  for (const runtime of registry.enabled.filter((r) =>
    targets.includes(r.id),
  )) {
    const ctx = {
      ...options,
      ...(options.adapters?.[runtime.id] ??
        options.adapters?.[runtime.name] ??
        {}),
    };
    let listing;
    try {
      listing = await fetchRuntimeCatalog(runtime, ctx);
    } catch {
      listing = { status: "failed", reason: "probe-failed" };
    }
    const version = listing.cliPath
      ? await readCliVersion(listing.cliPath, {
          run,
          timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
          env: runtimeEnvironment(runtime, ctx),
        })
      : null;
    agents[runtime.id] = {
      name: runtime.name,
      status: listing.status,
      ...(listing.status === "failed" ? { reason: listing.reason } : {}),
      ...(listing.source ? { source: listing.source } : {}),
      ...(listing.cliPath
        ? { cli: { path: listing.cliPath, ...(version ? { version } : {}) } }
        : {}),
      models:
        listing.status === "ok"
          ? listing.models.map(({ model, label }) => ({ model, label }))
          : [],
      refreshedAt: now,
    };
  }
  const catalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    runtimeFingerprint: registry.fingerprint,
    refreshedAt: targets.length || !previous ? now : previous.refreshedAt,
    agents,
  };
  const refreshedAgents = registry.enabled
    .map((r) => r.id)
    .filter((id) => targets.includes(id));
  const diff = refreshedAgents.length
    ? diffCatalogs(
        reset ? null : previous,
        {
          ...catalog,
          agents: Object.fromEntries(
            refreshedAgents.map((id) => [id, agents[id]]),
          ),
        },
        options.cwd,
      )
    : {};
  let written = false;
  if (
    !options.dryRun &&
    options.catalogPath &&
    (refreshedAgents.length || reset)
  ) {
    await writeJsonAtomic(options.catalogPath, catalog);
    written = true;
  }
  return { catalog, refreshedAgents, diff, written };
}

/** Catalog view with the current policy per model, for people and the refresh skill. */
export function describeCatalog(catalog, root = process.cwd()) {
  return Object.fromEntries(
    Object.entries(catalog?.agents ?? {}).map(([id, entry]) => [
      id,
      {
        name: entry.name,
        status: entry.status,
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.source ? { source: entry.source } : {}),
        refreshedAt: entry.refreshedAt,
        models: entry.models.map((model) => ({
          ...model,
          policy: modelPolicy(id, model, root),
        })),
      },
    ]),
  );
}

/** @param {string[]} argv */
export function parseModelCatalogCliArgs(argv) {
  const [command, ...rest] = argv;
  if (!["refresh", "show"].includes(command))
    throw new Error(`unknown-command:${command ?? ""}`);
  /** @type {{ command: string, agents: string[], catalogPath?: string, dryRun?: boolean, maxAgeHours?: number }} */
  const options = { command, agents: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--dry-run" && command === "refresh") {
      options.dryRun = true;
      continue;
    }
    const value = rest[index + 1];
    if (
      ["--agent", "--catalog", "--max-age-hours"].includes(flag) &&
      (value === undefined || value.startsWith("--"))
    )
      throw new Error(`missing-flag-value:${flag}`);
    if (flag === "--agent" && command === "refresh") {
      options.agents.push(value);
      index += 1;
      continue;
    }
    if (flag === "--catalog") {
      options.catalogPath = value;
      index += 1;
      continue;
    }
    if (flag === "--max-age-hours" && command === "show") {
      options.maxAgeHours = parseMaxAgeHours(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown-flag:${flag}`);
  }
  return options;
}

/** Positive hour count (fractions allowed) for catalog freshness. */
export function parseMaxAgeHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0)
    throw new Error("invalid-catalog-max-age-hours");
  return hours;
}

async function main() {
  const cli = parseModelCatalogCliArgs(process.argv.slice(2));
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const catalogPath = path.resolve(
    repositoryRoot,
    cli.catalogPath ?? DEFAULT_MODEL_CATALOG_PATH,
  );
  if (cli.command === "refresh") {
    const result = await ensureModelCatalog({
      cwd: repositoryRoot,
      catalogPath,
      refresh: !cli.agents.length,
      only: cli.agents,
      dryRun: Boolean(cli.dryRun),
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "ok",
          catalogPath: result.written ? catalogPath : null,
          refreshedAgents: result.refreshedAgents,
          diff: result.diff,
          agents: describeCatalog(result.catalog, repositoryRoot),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const catalog = await readModelCatalog(catalogPath);
  const stale = await findStaleCatalogAgents(catalog, {
    cwd: repositoryRoot,
    maxAgeHours: cli.maxAgeHours,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: catalog ? "ok" : "missing",
        catalogPath,
        refreshedAt: catalog?.refreshedAt ?? null,
        staleAgents: stale,
        agents: describeCatalog(catalog, repositoryRoot),
      },
      null,
      2,
    )}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ status: "error", reason: error.message })}\n`,
    );
    process.exitCode = 1;
  });
}
