import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  normalizeTriageInput,
  normalizeTriageConfig,
  triageContext,
  fallbackResult,
  parseTriageResult,
} from "./project-issue-triage-contract.mjs";

const CHILD = fileURLToPath(new URL("./project-issue-triage.mjs", import.meta.url));
const safeEnv = (env) =>
  Object.fromEntries(
    Object.entries(env).filter(([key]) => !["NODE_OPTIONS", "NODE_DEBUG", "GH_DEBUG"].includes(key)),
  );

export function runTriageChild(rawInput, rawConfig, { env = process.env, signal, timeoutMs = 10_000 } = {}) {
  const input = normalizeTriageInput(rawInput);
  const config = normalizeTriageConfig(rawConfig);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
    throw new Error("triage-invalid-timeout");
  const context = triageContext(input);
  const fallback = (reason) => ({ result: fallbackResult(context, reason), usage: "unavailable" });
  if (signal?.aborted) return Promise.resolve(fallback("cancelled"));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, String(input.issue)], {
      env: safeEnv(env),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
    });
    let reason;
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const terminate = (nextReason) => {
      reason ??= nextReason;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    };
    const cancel = () => terminate("cancelled");
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve(value);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) terminate("invalid-response");
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => terminate("invalid-response"));
    child.on("error", () => finish(fallback("provider-error")));
    child.on("close", (code) => {
      if (reason || code !== 0) return finish(fallback(reason ?? "invalid-response"));
      try {
        const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = parseTriageResult(raw.result, input, context);
        finish({ result, usage: cleanUsage(raw.usage) });
      } catch {
        finish(fallback("invalid-response"));
      }
    });
    child.stdin.end(JSON.stringify({ input, config }));
  });
}
function cleanUsage(raw) {
  return Number.isSafeInteger(raw?.inputTokens) &&
    raw.inputTokens >= 0 &&
    Number.isSafeInteger(raw?.outputTokens) &&
    raw.outputTokens >= 0
    ? { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens }
    : "unavailable";
}
export function createTriageState(runId) {
  if (typeof runId !== "string" || !/^[\w-]{1,100}$/.test(runId)) throw new Error("triage-invalid-run");
  return { runId, reserved: 0, providerUnavailable: false };
}
function cleanState(raw, runId) {
  if (
    raw?.runId !== runId ||
    !Number.isSafeInteger(raw.reserved) ||
    raw.reserved < 0 ||
    raw.reserved > 20 ||
    typeof raw.providerUnavailable !== "boolean"
  )
    throw new Error("triage-invalid-state");
  return { runId, reserved: raw.reserved, providerUnavailable: raw.providerUnavailable };
}

/**
 * One controller per checkpointed run. Serializes all requests; persistState
 * MUST durably save the supplied snapshot before resolving; the graph
 * checkpoint provides it. Reserved slots are never refunded on interruption.
 */
export function createTriageRunner({ runId, state: initialState, persistState, execute = runTriageChild }) {
  createTriageState(runId);
  let state = cleanState(initialState, runId);
  if (typeof persistState !== "function") throw new Error("triage-persistence-required");
  let queue = Promise.resolve();
  return {
    snapshot: () => ({ ...state }),
    run(rawInput, rawConfig, options = {}) {
      const input = normalizeTriageInput(rawInput);
      const config = normalizeTriageConfig(rawConfig);
      const operation = queue.then(async () => {
        const context = triageContext(input);
        const fallback = (reason) => ({ result: fallbackResult(context, reason), usage: "unavailable" });
        if (config.mode === "off") return fallback("disabled");
        if (config.mode === "assisted") return fallback("input-not-approved");
        if (options.signal?.aborted) return fallback("cancelled");
        if (state.providerUnavailable) return fallback("provider-unavailable");
        if (state.reserved >= config.maxRequests) return fallback("budget-exhausted");
        state = { ...state, reserved: state.reserved + 1 };
        try {
          await persistState({ ...state });
        } catch {
          state = { ...state, providerUnavailable: true };
          return fallback("provider-unavailable");
        }
        let response;
        try {
          const raw = await execute(input, config, options);
          response = { result: parseTriageResult(raw.result, input, context), usage: cleanUsage(raw.usage) };
        } catch {
          response = fallback("invalid-response");
        }
        if (["auth-failed", "rate-limited"].includes(response.result.reason)) {
          state = { ...state, providerUnavailable: true };
          try {
            await persistState({ ...state });
          } catch {
            return fallback("provider-unavailable");
          }
        }
        return response;
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
