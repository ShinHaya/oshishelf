import { migrateLegacyStatePath } from "./issue-state-migration.mjs";
import { parseParentWorkerMode } from "./issue-parent-usage.mjs";
import { normalizeTriageConfig } from "./issue-triage-contract.mjs";
import fs from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

export const DEFAULT_CONFIG_PATH = "state/issue-orchestrator.yaml";

const RUN_KEYS = new Set([
  "triage",
  "maxParallel",
  "releasePolicy",
  "unavailableModels",
  "unavailableAgents",
  "parentAsWorker",
  "modelCatalog",
]);

function fail(reason) {
  throw new Error(reason);
}

function assertObject(value, reason) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(reason);
  return value;
}

function assertKeys(value, allowed, prefix) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`config-unknown-key:${prefix}.${key}`);
  }
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "")
    fail(`config-missing:${field}`);
  return value.trim();
}

function parseUnavailableModels(value) {
  if (typeof value === "string" && value.trim().toLowerCase() === "none")
    return [];
  if (!Array.isArray(value) || value.length === 0)
    fail("config-invalid-unavailable-models");
  if (value.some((model) => typeof model !== "string" || model.trim() === ""))
    fail("config-invalid-unavailable-models");
  return value.map((model) => model.trim());
}

function parseUnavailableAgents(value) {
  if (typeof value === "string" && value.trim().toLowerCase() === "none")
    return [];
  if (!Array.isArray(value) || value.length === 0)
    fail("config-invalid-unavailable-agents");
  if (value.some((agent) => typeof agent !== "string" || agent.trim() === ""))
    fail("config-invalid-unavailable-agents");
  return value.map((agent) => agent.trim());
}

/** `run.modelCatalog`: only `maxAgeHours`, a positive number of hours (default 168 = 1 week). */
function parseModelCatalogConfig(value) {
  assertObject(value, "config-invalid-model-catalog");
  assertKeys(value, new Set(["maxAgeHours"]), "run.modelCatalog");
  if (value.maxAgeHours === undefined) return {};
  if (
    typeof value.maxAgeHours !== "number" ||
    !Number.isFinite(value.maxAgeHours) ||
    value.maxAgeHours <= 0
  )
    fail("config-invalid-model-catalog-max-age-hours");
  return { maxAgeHours: value.maxAgeHours };
}

/**
 * Model-catalog settings only, for runs (such as a graph resume) that do not otherwise
 * read the YAML. A missing default config file yields defaults.
 * @param {string} [filePath]
 * @param {{ cwd?: string, explicit?: boolean }} [options]
 */
export async function loadModelCatalogConfig(
  filePath = DEFAULT_CONFIG_PATH,
  { cwd = process.cwd(), explicit = false } = {},
) {
  try {
    return (
      (await loadOrchestratorConfig(filePath, { cwd, dryRun: true }))
        .modelCatalog ?? {}
    );
  } catch (error) {
    if (error.message === "config-file-not-found" && !explicit) return {};
    throw error;
  }
}

function normalizeDocument(document) {
  if (document.errors.length) fail("config-invalid-yaml");
  const root = assertObject(document.toJS(), "config-invalid-root");
  assertKeys(root, new Set(["run"]), "root");
  const run = assertObject(root.run, "config-missing:run");
  assertKeys(run, RUN_KEYS, "run");

  if (!Number.isSafeInteger(run.maxParallel) || run.maxParallel <= 0)
    fail("config-invalid-max-parallel");
  const releasePolicy = requiredString(run.releasePolicy, "run.releasePolicy");
  if (!new Set(["pr-created", "merged"]).has(releasePolicy))
    fail("config-invalid-release-policy");

  return {
    ...(run.triage === undefined
      ? {}
      : { triage: normalizeTriageConfig(run.triage) }),
    maxParallel: run.maxParallel,
    releasePolicy,
    unavailableModels: parseUnavailableModels(run.unavailableModels),
    unavailableAgents: parseUnavailableAgents(run.unavailableAgents ?? "none"),
    // auto | always | never; legacy booleans map onto auto/always.
    parentAsWorker: parseParentWorkerMode(run.parentAsWorker),
    ...(run.modelCatalog === undefined
      ? {}
      : { modelCatalog: parseModelCatalogConfig(run.modelCatalog) }),
  };
}

export async function loadOrchestratorConfig(
  filePath = DEFAULT_CONFIG_PATH,
  { cwd = process.cwd(), dryRun = false } = {},
) {
  const resolvedPath = await migrateLegacyStatePath(
    path.resolve(cwd, filePath),
    { dryRun },
  );
  let source;
  try {
    source = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") fail("config-file-not-found");
    throw error;
  }
  return normalizeDocument(YAML.parseDocument(source, { uniqueKeys: true }));
}

/** @typedef {Record<string, any>} ConfigLayer config layers are free-form until normalized */
/** @param {{ defaults?: ConfigLayer, yaml?: ConfigLayer, cli?: ConfigLayer }} [layers] */
export function mergeOrchestratorConfig({
  defaults = {},
  yaml = {},
  cli = {},
} = {}) {
  const merged = { ...defaults, ...yaml, ...cli };
  if (
    defaults.triage !== undefined ||
    yaml.triage !== undefined ||
    cli.triage !== undefined
  ) {
    merged.triage = normalizeTriageConfig({
      ...(defaults.triage ?? {}),
      ...(yaml.triage ?? {}),
      ...(typeof cli.triage === "string"
        ? { mode: cli.triage }
        : (cli.triage ?? {})),
    });
  }
  if (typeof merged.unavailableModels === "string")
    merged.unavailableModels = parseUnavailableModels(merged.unavailableModels);
  if (typeof merged.unavailableAgents === "string")
    merged.unavailableAgents = parseUnavailableAgents(merged.unavailableAgents);
  merged.parentAsWorker = parseParentWorkerMode(merged.parentAsWorker);
  return merged;
}
