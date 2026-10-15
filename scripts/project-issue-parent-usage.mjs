import { spawn as nodeSpawn } from "node:child_process";

import { canonicalizeAgent } from "./project-issue-assignment.mjs";

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

const KILL_GRACE_MS = 2_000;

/**
 * Map a config/CLI value onto a worker mode. `false` was the previous default
 * (and the example config value), so it means "auto" instead of permanently
 * opting out; `never` is the explicit opt-out. `true` keeps its old meaning.
 */
export function parseParentWorkerMode(value) {
  if (value === undefined || value === false) return "auto";
  if (value === true) return "always";
  if (typeof value === "string" && PARENT_WORKER_MODES.has(value.trim().toLowerCase()))
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

const unknown = (reason, fetchedAt) => ({ status: "unknown", reason, ...(fetchedAt ? { fetchedAt } : {}) });

/**
 * Normalize an `account/rateLimits/read` result into a closed snapshot. The
 * 5-hour window is identified by its 300-minute duration in either slot;
 * a weekly or unlabeled window is never used in its place.
 */
export function normalizeCodexRateLimits(result, { fetchedAt } = {}) {
  if (!result || typeof result !== "object") return unknown("parent-usage-invalid-response", fetchedAt);
  const byId = result.rateLimitsByLimitId;
  const snapshot = byId && typeof byId === "object" && byId.codex ? byId.codex : result.rateLimits;
  if (!snapshot || typeof snapshot !== "object") return unknown("parent-usage-invalid-response", fetchedAt);
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window) => window && typeof window === "object" && window.windowDurationMins === PARENT_USAGE_WINDOW_MINS,
  );
  if (windows.length !== 1) return unknown("parent-usage-window-missing", fetchedAt);
  const [window] = windows;
  const used = window.usedPercent;
  if (!Number.isSafeInteger(used) || used < 0 || used > 100)
    return unknown("parent-usage-invalid-value", fetchedAt);
  // A server-side block outranks the percentage.
  if (result.ordinaryUsageAllowed === false || (snapshot.rateLimitReachedType ?? null) !== null)
    return unknown("parent-usage-blocked", fetchedAt);
  return {
    status: "ok",
    remainingPercent: 100 - used,
    windowDurationMins: PARENT_USAGE_WINDOW_MINS,
    ...(Number.isSafeInteger(window.resetsAt) ? { resetsAt: window.resetsAt } : {}),
    ...(fetchedAt ? { fetchedAt } : {}),
  };
}

/**
 * Decide whether the parent runtime may take worker routes right now.
 * Unknown usage never opts the parent in.
 */
export function decideParentWorker(mode, usage) {
  if (mode === "always") return { eligible: true, reason: "parent-worker-forced" };
  if (mode === "never") return { eligible: false, reason: "parent-worker-disabled" };
  if (mode !== "auto") return { eligible: false, reason: "parent-worker-invalid-mode" };
  if (usage?.status !== "ok") return { eligible: false, reason: usage?.reason ?? "parent-usage-unknown" };
  return usage.remainingPercent >= PARENT_USAGE_MIN_REMAINING_PERCENT
    ? { eligible: true, reason: "parent-usage-sufficient" }
    : { eligible: false, reason: "parent-usage-low" };
}

/**
 * Ask the local Codex App Server for the account's rate limits over stdio
 * JSON-RPC. Stdin stays open until the answer arrives (the server exits on
 * EOF), and the child is always terminated on answer, error, or timeout.
 */
export function fetchCodexRateLimits({
  timeoutMs = DEFAULT_PARENT_USAGE_TIMEOUT_MS,
  spawn = nodeSpawn,
  command = "codex",
  env = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      reject(new Error("parent-usage-fetch-failed"));
      return;
    }
    let settled = false;
    let buffer = "";
    let killTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref?.();
        child.once("exit", () => clearTimeout(killTimer));
      }
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("parent-usage-timeout")), timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", () => finish(new Error("parent-usage-fetch-failed")));
    child.on("exit", () => finish(new Error("parent-usage-fetch-failed")));
    child.stdin.on("error", () => finish(new Error("parent-usage-fetch-failed")));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id === 1) {
          if (message.error) return finish(new Error("parent-usage-fetch-failed"));
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
        } else if (message?.id === 2) {
          if (message.error || !message.result) return finish(new Error("parent-usage-fetch-failed"));
          return finish(null, message.result);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "project-issue-orchestrator", version: "1" } } });
  });
}

/** Runtimes with a verified machine-readable 5-hour usage interface. */
const DEFAULT_FETCHERS = {
  Codex: async (options) => normalizeCodexRateLimits(await fetchCodexRateLimits(options), options),
};

/**
 * Read the parent's 5-hour usage as a closed snapshot. Never throws: any
 * failure becomes `status: "unknown"` with a reason code.
 */
export async function readParentUsage(
  agent,
  { fetchers = DEFAULT_FETCHERS, timeoutMs = DEFAULT_PARENT_USAGE_TIMEOUT_MS, now = () => new Date().toISOString(), spawn } = {},
) {
  const fetchedAt = now();
  const fetcher = fetchers[canonicalizeAgent(agent) ?? ""];
  if (!fetcher) return unknown("parent-usage-unsupported-runtime", fetchedAt);
  try {
    const usage = await fetcher({ timeoutMs, fetchedAt, ...(spawn ? { spawn } : {}) });
    return usage?.status === "ok" || usage?.status === "unknown" ? usage : unknown("parent-usage-invalid-response", fetchedAt);
  } catch (error) {
    const reason = error?.message === "parent-usage-timeout" ? "parent-usage-timeout" : "parent-usage-fetch-failed";
    return unknown(reason, fetchedAt);
  }
}
