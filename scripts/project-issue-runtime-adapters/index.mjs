import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";
import * as gemini from "./gemini.mjs";
import * as grok from "./grok.mjs";
import { REASON_CODES, isRetiredRuntimeRoute } from "./shared.mjs";

/** Fixed evaluation order: Codex → Claude → Grok → Gemini. */
export const RUNTIME_ADAPTERS = Object.freeze([codex, claude, grok, gemini]);

export function getAdapter(agentName) {
  const needle = String(agentName ?? "")
    .trim()
    .toLowerCase();
  return RUNTIME_ADAPTERS.find((adapter) => adapter.agent.toLowerCase() === needle) ?? null;
}

/**
 * Probe every adapter in fixed order, or only the adapters named in
 * `ctx.only` (case-insensitive agent names) for a targeted re-probe after a
 * cache-freshness or runtime-failure invalidation. Partial failures never
 * abort later adapters. Returns capability records (success only), plus
 * non-sensitive diagnostics, plus the resolved CLI path per adapter that got
 * far enough to attempt discovery (used only for cache freshness checks).
 */
export async function discoverAllCapabilities(ctx = {}) {
  const capabilities = [];
  const diagnostics = [];
  const cli = {};
  const only = Array.isArray(ctx.only) && ctx.only.length
    ? new Set(ctx.only.map((name) => String(name).trim().toLowerCase()))
    : null;
  for (const adapter of RUNTIME_ADAPTERS) {
    if (only && !only.has(adapter.agent.toLowerCase())) continue;
    const adapterCtx = {
      ...ctx,
      ...(ctx.adapters?.[adapter.agent] ?? {}),
    };
    try {
      const result = await adapter.discover(adapterCtx);
      capabilities.push(...(result.records ?? []));
      diagnostics.push(...(result.diagnostics ?? []));
      if (typeof result.cliPath === "string" && result.cliPath) {
        cli[adapter.agent] = { path: result.cliPath };
      }
    } catch {
      diagnostics.push({
        agent: adapter.agent,
        status: "failed",
        reason: REASON_CODES.PROBE_FAILED,
      });
    }
  }
  return { capabilities, diagnostics, cli };
}

export async function launchWithAdapter(agentName, job, ctx = {}) {
  if (isRetiredRuntimeRoute({ agent: agentName, selector: job?.selector })) throw new Error("runtime-retired");
  const adapter = getAdapter(agentName);
  if (!adapter?.launch) throw new Error(`dispatch-adapter-unavailable:${agentName}`);
  return adapter.launch(ctx, job);
}

export { claude, codex, gemini, grok };
