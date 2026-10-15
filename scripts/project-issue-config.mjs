import { normalizeTriageConfig } from "./project-issue-triage-contract.mjs";
import fs from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

export const DEFAULT_CONFIG_PATH = "state/project-issue-orchestrator.yaml";

const PROJECT_KEYS = new Set(["owner", "ownerType", "name"]);
const RUN_KEYS = new Set([
  "triage",
  "maxParallel",
  "releasePolicy",
  "unavailableModels",
  "unavailableAgents",
  "parentAsWorker",
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
  if (typeof value !== "string" || value.trim() === "") fail(`config-missing:${field}`);
  return value.trim();
}

function parseUnavailableModels(value) {
  if (typeof value === "string" && value.trim().toLowerCase() === "none") return [];
  if (!Array.isArray(value) || value.length === 0) fail("config-invalid-unavailable-models");
  if (value.some((model) => typeof model !== "string" || model.trim() === ""))
    fail("config-invalid-unavailable-models");
  return value.map((model) => model.trim());
}

function parseUnavailableAgents(value) {
  if (typeof value === "string" && value.trim().toLowerCase() === "none") return [];
  if (!Array.isArray(value) || value.length === 0) fail("config-invalid-unavailable-agents");
  if (value.some((agent) => typeof agent !== "string" || agent.trim() === ""))
    fail("config-invalid-unavailable-agents");
  return value.map((agent) => agent.trim());
}

/** Opt-in: the parent runtime may also receive worker routes. */
function parseParentAsWorker(value) {
  if (typeof value !== "boolean") fail("config-invalid-parent-as-worker");
  return value;
}

function normalizeDocument(document) {
  if (document.errors.length) fail("config-invalid-yaml");
  const root = assertObject(document.toJS(), "config-invalid-root");
  assertKeys(root, new Set(["project", "run"]), "root");
  const project = root.project === undefined ? null : assertObject(root.project, "config-invalid-project");
  const run = assertObject(root.run, "config-missing:run");
  if (project) assertKeys(project, PROJECT_KEYS, "project");
  assertKeys(run, RUN_KEYS, "run");

  // Old files remain readable, but these fields no longer authorize Project IO.
  const legacy = project ? {
    projectOwner: requiredString(project.owner, "project.owner"),
    ownerType: requiredString(project.ownerType, "project.ownerType"),
    projectName: requiredString(project.name, "project.name"),
  } : {};
  if (legacy.ownerType && legacy.ownerType !== "organization") fail("config-invalid-owner-type");

  if (!Number.isSafeInteger(run.maxParallel) || run.maxParallel <= 0) fail("config-invalid-max-parallel");
  const releasePolicy = requiredString(run.releasePolicy, "run.releasePolicy");
  if (!new Set(["pr-created", "merged"]).has(releasePolicy)) fail("config-invalid-release-policy");

  return {
    ...(run.triage === undefined ? {} : { triage: normalizeTriageConfig(run.triage) }),
    ...legacy,
    maxParallel: run.maxParallel,
    releasePolicy,
    unavailableModels: parseUnavailableModels(run.unavailableModels),
    unavailableAgents: parseUnavailableAgents(run.unavailableAgents ?? "none"),
    parentAsWorker: parseParentAsWorker(run.parentAsWorker ?? false),
  };
}

export async function loadOrchestratorConfig(filePath = DEFAULT_CONFIG_PATH, { cwd = process.cwd() } = {}) {
  const resolvedPath = path.resolve(cwd, filePath);
  let source;
  try {
    source = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") fail("config-file-not-found");
    throw error;
  }
  return normalizeDocument(YAML.parseDocument(source, { uniqueKeys: true }));
}

export function mergeOrchestratorConfig({ defaults = {}, yaml = {}, cli = {} } = {}) {
  const merged = { ...defaults, ...yaml, ...cli };
  if (defaults.triage !== undefined || yaml.triage !== undefined || cli.triage !== undefined) {
    merged.triage = normalizeTriageConfig({
      ...(defaults.triage ?? {}), ...(yaml.triage ?? {}),
      ...(typeof cli.triage === "string" ? { mode: cli.triage } : cli.triage ?? {}),
    });
  }
  if (typeof merged.unavailableModels === "string")
    merged.unavailableModels = parseUnavailableModels(merged.unavailableModels);
  if (typeof merged.unavailableAgents === "string")
    merged.unavailableAgents = parseUnavailableAgents(merged.unavailableAgents);
  return merged;
}
