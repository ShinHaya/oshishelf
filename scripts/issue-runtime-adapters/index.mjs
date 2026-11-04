import { createAdapter } from "./generic.mjs";
import { loadRuntimeRegistry, findRuntime } from "../ai-template/registry.mjs";
import {
  REASON_CODES,
  isDisallowedModelRoute,
  isRetiredRuntimeRoute,
} from "./shared.mjs";

export function getRuntimeAdapters(root = process.cwd()) {
  return loadRuntimeRegistry(root).enabled.map(createAdapter);
}
export function getAdapter(agentName, root = process.cwd()) {
  const runtime = findRuntime(agentName, root, { enabledOnly: true });
  return runtime ? createAdapter(runtime) : null;
}
export async function discoverAllCapabilities(ctx = {}) {
  const capabilities = [],
    diagnostics = [],
    cli = {};
  const registry = loadRuntimeRegistry(ctx.cwd);
  const only =
    Array.isArray(ctx.only) && ctx.only.length
      ? new Set(
          ctx.only.map(
            (name) =>
              registry.aliases.get(String(name).trim().toLowerCase())?.id,
          ),
        )
      : null;
  for (const adapter of registry.enabled.map(createAdapter)) {
    if (only && !only.has(adapter.id)) continue;
    try {
      // `catalogListings` (runtime id -> listing) comes from the persisted model catalog.
      const catalogEntry = ctx.catalogListings?.[adapter.id];
      const result = await adapter.discover({
        ...ctx,
        ...(catalogEntry ? { catalogEntry } : {}),
        ...(ctx.adapters?.[adapter.agent] ?? ctx.adapters?.[adapter.id] ?? {}),
      });
      capabilities.push(...(result.records ?? []));
      diagnostics.push(...(result.diagnostics ?? []));
      if (result.cliPath) cli[adapter.agent] = { path: result.cliPath };
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
  const root = job?.cwd ?? ctx.cwd;
  if (
    isRetiredRuntimeRoute({ agent: agentName, selector: job?.selector }, root)
  )
    throw new Error("runtime-retired");
  if (
    isDisallowedModelRoute(
      {
        agent: agentName,
        model: job?.model,
        requestedModel: job?.requestedModel,
      },
      root,
    )
  )
    throw new Error("runtime-model-not-allowed");
  const adapter = getAdapter(agentName, root);
  if (!adapter) throw new Error(`dispatch-adapter-unavailable:${agentName}`);
  return adapter.launch(ctx, job);
}
