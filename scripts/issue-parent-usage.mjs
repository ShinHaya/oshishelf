import { environmentReason } from "./issue-runtime-adapters/environment.mjs";
import { findRuntime, runtimeEnvironment } from "./ai-template/registry.mjs";
import { fetchUsage, normalizeUsage } from "./issue-runtime-adapters/usage.mjs";

/**
 * Parent-as-worker gate (Issue #68). The parent runtime joins the worker pool
 * only while its own 5-hour usage window has at least half of its quota left.
 *
 * Fetching, normalizing, and deciding are separate so classic and graph runs
 * share one decision. Only the closed snapshot below ever leaves this module:
 * no account id, plan, credits, or raw server response.
 */

export const PARENT_WORKER_MODES = new Set(["auto", "always", "never"]);
export const PARENT_USAGE_MIN_REMAINING_PERCENT = 50;
export const PARENT_USAGE_WINDOW_MINS = 300;
export const DEFAULT_PARENT_USAGE_TIMEOUT_MS = 15_000;

/**
 * Map a config/CLI value onto a worker mode. `false` was the previous default
 * (and the example config value), so it means "auto" instead of permanently
 * opting out; `never` is the explicit opt-out. `true` keeps its old meaning.
 */
export function parseParentWorkerMode(value) {
  if (value === undefined || value === false) return "auto";
  if (value === true) return "always";
  if (
    typeof value === "string" &&
    PARENT_WORKER_MODES.has(value.trim().toLowerCase())
  )
    return value.trim().toLowerCase();
  throw new Error("config-invalid-parent-as-worker");
}

/**
 * `--parent-as-worker` (legacy, = always) and `--parent-worker-mode` fold into
 * one `parentAsWorker` mode; contradicting both is an error, not a guess.
 */
export function resolveParentWorkerFlags(options) {
  if (options.parentWorkerMode === undefined) return options;
  let mode;
  try {
    mode = parseParentWorkerMode(options.parentWorkerMode);
  } catch {
    throw new Error("invalid-flag-value:--parent-worker-mode");
  }
  if (options.parentAsWorker !== undefined && options.parentAsWorker !== mode)
    throw new Error("parent-worker-mode-conflict");
  options.parentAsWorker = mode;
  delete options.parentWorkerMode;
  return options;
}

/** @returns {import("./issue-runtime-adapters/usage.mjs").UsageSnapshot} */
const unknown = (reason, fetchedAt) => ({
  status: "unknown",
  reason,
  ...(fetchedAt ? { fetchedAt } : {}),
});

/**
 * Decide whether the parent runtime may take worker routes right now.
 * Unknown usage never opts the parent in.
 * @param {string} mode
 * @param {import("./issue-runtime-adapters/usage.mjs").UsageSnapshot} [usage]
 */
export function decideParentWorker(mode, usage) {
  if (mode === "always")
    return { eligible: true, reason: "parent-worker-forced" };
  if (mode === "never")
    return { eligible: false, reason: "parent-worker-disabled" };
  if (mode !== "auto")
    return { eligible: false, reason: "parent-worker-invalid-mode" };
  if (usage?.status !== "ok")
    return { eligible: false, reason: usage?.reason ?? "parent-usage-unknown" };
  return usage.remainingPercent >= PARENT_USAGE_MIN_REMAINING_PERCENT
    ? { eligible: true, reason: "parent-usage-sufficient" }
    : { eligible: false, reason: "parent-usage-low" };
}

/**
 * Read a registered parent's usage; unsupported or failed reads never opt it in.
 * @param {string} agent
 * @param {{ timeoutMs?: number, now?: () => string, cwd?: string, spawn?: Function, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<import("./issue-runtime-adapters/usage.mjs").UsageSnapshot>}
 */
export async function readParentUsage(
  agent,
  {
    timeoutMs = DEFAULT_PARENT_USAGE_TIMEOUT_MS,
    now = () => new Date().toISOString(),
    cwd = process.cwd(),
    ...options
  } = {},
) {
  const fetchedAt = now();
  try {
    const runtime = findRuntime(agent, cwd, { enabledOnly: true });
    if (!runtime || runtime.retired)
      return unknown("parent-usage-unsupported-runtime", fetchedAt);
    if (!runtime.usage)
      return unknown(
        runtime.usageUnavailable
          ? "parent-usage-five-hour-unavailable"
          : "parent-usage-unsupported-runtime",
        fetchedAt,
      );
    return normalizeUsage(
      await fetchUsage(runtime.usage, {
        ...options,
        timeoutMs,
        cwd,
        env: runtimeEnvironment(runtime, { ...options, cwd }),
      }),
      runtime.usage,
      { fetchedAt },
    );
  } catch (error) {
    const reason =
      (environmentReason(error) ?? error?.message === "parent-usage-timeout")
        ? "parent-usage-timeout"
        : "parent-usage-fetch-failed";
    return unknown(reason, fetchedAt);
  }
}
