#!/usr/bin/env node
import { normalizeTriageConfig } from "./project-issue-triage-contract.mjs";

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OWNER_TYPES } from "./project-issue-assignment.mjs";
import {
  DEFAULT_CAPABILITIES_OUTPUT,
  loadOrRefreshCapabilities,
} from "./project-issue-capabilities.mjs";
import {
  DEFAULT_CONFIG_PATH,
  loadOrchestratorConfig,
  mergeOrchestratorConfig,
} from "./project-issue-config.mjs";
import { fetchRepositoryIssues } from "./project-issue-github.mjs";
import {
  applyMilestone,
  buildRunPlan,
  buildUsageReport,
  parseProjectItems,
  selectProjectItems,
  selectWorkerRoutes,
  validateCapabilities,
} from "./project-issue-plan.mjs";
import { readState, withStateLock, writeState } from "./project-issue-state.mjs";
import { verifyRepositoryFreshness } from "./project-issue-runtime-adapters/shared.mjs";

// Re-export pure surface for tests and programmatic callers.
export {
  applyMilestone,
  buildRunPlan,
  buildUsageReport,
  parseProjectItems,
  parseProjectMetadata,
  selectProjectItems,
  selectProjectConfig,
  selectWorkerRoutes,
  validateCapabilities,
  validateProjectItems,
} from "./project-issue-plan.mjs";
export { buildProjectItemsQuery, fetchProjectItems, githubGraphql, transitionBacklogToReady } from "./project-issue-github.mjs";
export {
  loadOrRefreshCapabilities,
  DEFAULT_CAPABILITIES_OUTPUT,
} from "./project-issue-capabilities.mjs";
export {
  EXECUTION_MODES,
  VALID_MODES,
  DEFAULT_MODE_CONFIGS,
  RISK_CATEGORIES,
  determineEligibleModes,
  rankAndSelectMode,
  assignRoutesForMode,
  validateWorktreeConcurrency,
  createModeTelemetryRecord,
} from "./project-issue-modes.mjs";

/**
 * Dry-run never mutates disk state and never applies milestones to the plan.
 * Pass `options.simulateMilestone: true` to apply a milestone in memory only
 * (still no disk write) for "what if this event landed" plans.
 *
 * Agent/model routing is run-scoped: the plan carries no per-Issue assignment.
 * The orchestrating agent assigns each runnable Issue to one of the returned
 * `workerRoutes`, and re-runs with `--unavailable-agent` / `--unavailable-model`
 * when a route is lost mid-run (session limit, interruption).
 */
export async function runOrchestration(input) {
  const items = parseProjectItems(input?.items, { completed: input?.state?.completed ?? [] });
  const options = input?.options ?? {};
  const parent = options.parent;
  if (!parent?.agent || !parent?.model) throw new Error("parent-route-required");
  validateCapabilities([{ agent: parent.agent, model: parent.model, role: "parent" }], options.capabilities);

  const dryRun = Boolean(options.dryRun);
  const applyInMemory = Boolean(input.milestone) && (!dryRun || options.simulateMilestone);
  let nextState;

  if (!dryRun && input.milestone) {
    if (!options.statePath) throw new Error("state-path-required");
    nextState = await withStateLock(options.statePath, async () => {
      const lockedState = await readState(options.statePath);
      const updated = applyMilestone(lockedState, input.milestone, {
        issueNumbers: items.map(({ number }) => number),
        releasePolicy: options.releasePolicy,
      });
      await writeState(options.statePath, updated);
      return updated;
    });
  } else {
    const currentState = input.state ?? (await readState(options.statePath));
    nextState =
      applyInMemory && input.milestone
        ? applyMilestone(currentState, input.milestone, {
            issueNumbers: items.map(({ number }) => number),
            releasePolicy: options.releasePolicy,
          })
        : currentState;
  }

  const plan = buildRunPlan(items, {
    completed: nextState.completed,
    existingWorktrees: options.existingWorktrees,
    maxParallel: options.maxParallel,
    releasePolicy: options.releasePolicy,
  });
  const workerRoutes = selectWorkerRoutes(options.capabilities ?? [], {
    parentAgent: parent.agent,
    parentAsWorker: parent.asWorker === true,
    unavailableAgents: options.unavailableAgents,
    unavailableModels: options.unavailableModels,
  });
  if (plan.runnable.length && !workerRoutes.length) throw new Error("no-worker-route-available");
  return {
    dryRun,
    ...(options.triage === undefined ? {} : { triage: normalizeTriageConfig(options.triage) }),
    ...(input.fetchedBytes === undefined ? {} : { fetchedBytes: input.fetchedBytes }),
    plan,
    workerRoutes,
    state: nextState,
    usage: buildUsageReport(
      nextState.usage,
      items.map(({ number }) => number),
    ),
  };
}

export function buildProjectInfo(cli, project) {
  return {
    number: project.number,
    owner: cli.projectOwner,
    ownerType: cli.ownerType ?? "organization",
    fields: project.fields,
  };
}

export function parseCliArgs(argv) {
  const options = {};
  const valueFlags = new Map([
    ["--input", "inputPath"],
    ["--project-owner", "projectOwner"],
    ["--project-name", "projectName"],
    ["--max-parallel", "maxParallel"],
    ["--release-policy", "releasePolicy"],
    ["--owner-type", "ownerType"],
    ["--issues", "issues"],
    ["--priority", "priority"],
    ["--iteration", "iteration"],
    ["--size", "size"],
    ["--unavailable-model", "unavailableModels"],
    ["--unavailable-agent", "unavailableAgents"],
    ["--invalidate-agent", "invalidateAgents"],
    ["--state-path", "statePath"],
    ["--existing-worktree", "existingWorktrees"],
    ["--milestone-json", "milestoneJson"],
    ["--milestone-file", "milestoneFile"],
    ["--capabilities-file", "capabilitiesFile"],
    ["--capabilities-output", "capabilitiesOutput"],
    ["--parent-agent", "parentAgent"],
    ["--parent-model", "parentModel"],
    ["--config", "configPath"],
    ["--triage", "triage"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (flag === "--simulate-milestone") {
      options.simulateMilestone = true;
      continue;
    }
    if (flag === "--skip-capability-discovery") {
      options.skipCapabilityDiscovery = true;
      continue;
    }
    if (flag === "--parent-as-worker") {
      options.parentAsWorker = true;
      continue;
    }
    // Forces a full re-discovery of every adapter, ignoring any cached
    // state/project-issue-capabilities.json.
    if (flag === "--refresh") {
      options.refresh = true;
      continue;
    }
    // Backward-compatible alias; prefer --parent-agent.
    if (flag === "--parent-provider") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
      options.parentAgent = value;
      continue;
    }
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`unknown-flag:${flag}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
    if (
      [
        "unavailableModels",
        "unavailableAgents",
        "invalidateAgents",
        "existingWorktrees",
        "issues",
        "priority",
        "iteration",
        "size",
      ].includes(key)
    ) {
      options[key] ??= [];
      if (["issues", "priority", "iteration", "size"].includes(key))
        options[key].push(
          ...value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        );
      else options[key].push(key === "existingWorktrees" ? Number(value) : value);
    } else options[key] = ["maxParallel"].includes(key) ? Number(value) : value;
  }
  if (options.triage !== undefined && !["off", "shadow", "assisted"].includes(options.triage))
    throw new Error("triage-invalid-mode");
  if (options.ownerType !== undefined && !OWNER_TYPES.has(options.ownerType))
    throw new Error("invalid-owner-type");
  if (options.milestoneJson && options.milestoneFile) throw new Error("milestone-source-conflict");
  return options;
}

async function readInput(cli) {
  const selectors = {
    issues: cli.issues,
    priority: cli.priority,
    iteration: cli.iteration,
    size: cli.size,
  };
  const applySelection = (input, selection) => ({
    ...input,
    items: selection.items,
    state: {
      ...(input.state ?? {}),
      completed: [...new Set([...(input.state?.completed ?? []), ...selection.completed])].sort(
        (left, right) => left - right,
      ),
    },
  });
  if (cli.inputPath) {
    const input = JSON.parse(await fs.readFile(cli.inputPath, "utf8"));
    return applySelection(input, selectProjectItems(input.items, selectors));
  }
  if (cli.issues?.length) {
    const fetched = await fetchRepositoryIssues({ issues: cli.issues });
    return applySelection(fetched, selectProjectItems(fetched.items, selectors));
  }
  if (cli.projectOwner || cli.projectName || cli.priority?.length || cli.iteration?.length || cli.size?.length)
    throw new Error("issue-numbers-required");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  if (!chunks.length) throw new Error("input-required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  await verifyRepositoryFreshness(repositoryRoot);
  let yamlConfig = {};
  try {
    yamlConfig = await loadOrchestratorConfig(cli.configPath ?? DEFAULT_CONFIG_PATH, {
      cwd: repositoryRoot,
    });
  } catch (error) {
    if (error.message !== "config-file-not-found" || cli.configPath) throw error;
  }
  const merged = mergeOrchestratorConfig({
    yaml: yamlConfig,
    cli: {
      ...(cli.triage === undefined ? {} : { triage: cli.triage }),
      ...(cli.projectOwner === undefined ? {} : { projectOwner: cli.projectOwner }),
      ...(cli.ownerType === undefined ? {} : { ownerType: cli.ownerType }),
      ...(cli.projectName === undefined ? {} : { projectName: cli.projectName }),
      ...(cli.maxParallel === undefined ? {} : { maxParallel: cli.maxParallel }),
      ...(cli.releasePolicy === undefined ? {} : { releasePolicy: cli.releasePolicy }),
      ...(cli.unavailableModels === undefined ? {} : { unavailableModels: cli.unavailableModels }),
      ...(cli.unavailableAgents === undefined ? {} : { unavailableAgents: cli.unavailableAgents }),
      ...(cli.parentAsWorker === undefined ? {} : { parentAsWorker: cli.parentAsWorker }),
    },
  });
  const effectiveCli = {
    ...cli,
    ...(merged.triage === undefined ? {} : { triage: merged.triage }),
    ...(merged.projectOwner === undefined ? {} : { projectOwner: merged.projectOwner }),
    ...(merged.ownerType === undefined ? {} : { ownerType: merged.ownerType }),
    ...(merged.projectName === undefined ? {} : { projectName: merged.projectName }),
    ...(merged.maxParallel === undefined ? {} : { maxParallel: merged.maxParallel }),
    ...(merged.releasePolicy === undefined ? {} : { releasePolicy: merged.releasePolicy }),
    ...(merged.unavailableModels === undefined ? {} : { unavailableModels: merged.unavailableModels }),
    ...(merged.unavailableAgents === undefined ? {} : { unavailableAgents: merged.unavailableAgents }),
    ...(merged.parentAsWorker === undefined ? {} : { parentAsWorker: merged.parentAsWorker }),
  };
  const input = await readInput(effectiveCli);
  if (cli.milestoneJson) input.milestone = JSON.parse(cli.milestoneJson);
  if (cli.milestoneFile) input.milestone = JSON.parse(await fs.readFile(cli.milestoneFile, "utf8"));

  // Capability source of truth for the normal CLI path is automatic discovery,
  // which by default reuses state/project-issue-capabilities.json instead of
  // re-probing every adapter on every run. Explicit sources
  // (file or pre-baked input.options.capabilities) remain for tests and
  // intentional non-default runs; they skip discovery entirely.
  let capabilities;
  let capabilityDiagnostics;
  let capabilityCacheStatus;
  if (cli.capabilitiesFile) {
    const loaded = JSON.parse(await fs.readFile(cli.capabilitiesFile, "utf8"));
    capabilities = Array.isArray(loaded) ? loaded : loaded.capabilities;
    if (!Array.isArray(capabilities)) throw new Error("capability-records-required");
  } else if (Array.isArray(input.options?.capabilities)) {
    capabilities = input.options.capabilities;
  } else if (cli.skipCapabilityDiscovery) {
    capabilities = undefined;
  } else {
    const cachePath = path.resolve(repositoryRoot, cli.capabilitiesOutput ?? DEFAULT_CAPABILITIES_OUTPUT);
    const discovered = await loadOrRefreshCapabilities({
      cachePath,
      refresh: Boolean(cli.refresh),
      invalidateAgents: cli.invalidateAgents,
      dryRun: Boolean(cli.dryRun),
      cwd: repositoryRoot,
    });
    capabilities = discovered.capabilities;
    capabilityDiagnostics = discovered.diagnostics;
    capabilityCacheStatus = discovered.reused
      ? "reused"
      : discovered.reprobedAgents
        ? `reprobed:${discovered.reprobedAgents.join(",")}`
        : "refreshed";
  }

  input.options = {
    ...(input.options ?? {}),
    ...(effectiveCli.triage === undefined ? {} : { triage: effectiveCli.triage }),
    ...(cli.dryRun === undefined ? {} : { dryRun: cli.dryRun }),
    ...(cli.simulateMilestone === undefined ? {} : { simulateMilestone: cli.simulateMilestone }),
    ...(effectiveCli.maxParallel === undefined ? {} : { maxParallel: effectiveCli.maxParallel }),
    ...(effectiveCli.releasePolicy === undefined ? {} : { releasePolicy: effectiveCli.releasePolicy }),
    ...(effectiveCli.unavailableModels === undefined
      ? {}
      : { unavailableModels: effectiveCli.unavailableModels }),
    ...(effectiveCli.unavailableAgents === undefined
      ? {}
      : { unavailableAgents: effectiveCli.unavailableAgents }),
    ...(cli.statePath === undefined ? {} : { statePath: cli.statePath }),
    ...(cli.existingWorktrees === undefined ? {} : { existingWorktrees: cli.existingWorktrees }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(cli.parentAgent && cli.parentModel
      ? { parent: { agent: cli.parentAgent, model: cli.parentModel, ...(effectiveCli.parentAsWorker === true ? { asWorker: true } : {}) } }
      : {}),
  };
  if ((cli.parentAgent && !cli.parentModel) || (!cli.parentAgent && cli.parentModel))
    throw new Error("parent-agent-and-model-required");
  const result = await runOrchestration(input);
  if (capabilityDiagnostics !== undefined) result.capabilityDiagnostics = capabilityDiagnostics;
  if (capabilityCacheStatus !== undefined) result.capabilityCacheStatus = capabilityCacheStatus;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "error", reason: error.message })}\n`);
    process.exitCode = 1;
  });
