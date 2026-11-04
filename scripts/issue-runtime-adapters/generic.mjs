import { environmentReason } from "./environment.mjs";
import {
  DEFAULT_WORKER_TIMEOUT_MS,
  REASON_CODES,
  buildWorkerPrompt,
  capabilityRecord,
  diagnostic,
  quoteSelectorArg,
  resolveExecutable,
  verifyModelCandidate,
  runProcess,
  selectorHasPermissionArgs,
  spawnWorker,
  splitSelector,
} from "./shared.mjs";
import { fetchRuntimeCatalog } from "./catalog.mjs";
import { evaluateRoute } from "../enterprise-route-policy.mjs";
import {
  runtimeEnvironment,
  isModelAllowed,
  isModelDenied,
  isRetiredCommand,
  loadRuntimeRegistry,
  PERMISSION_ROLES,
  resolvePermission,
  runtimePermissionSummary,
} from "../ai-template/registry.mjs";

export function createAdapter(definition) {
  const agent = definition.name;
  return {
    agent,
    id: definition.id,
    evaluationOrder: definition.evaluationOrder,
    definition,
    /**
     * Probe the runtime's catalog models. Candidates come from `ctx.catalogEntry` (the persisted
     * model catalog) when supplied, otherwise from a fresh listing; both use the same source.
     */
    async discover(ctx = {}) {
      const run = ctx.runProcess ?? runProcess;
      let env;
      try {
        env = runtimeEnvironment(definition, ctx);
      } catch (error) {
        return {
          records: [],
          diagnostics: [
            diagnostic({
              agent,
              status: "failed",
              reason: environmentReason(error) ?? REASON_CODES.PROBE_FAILED,
            }),
          ],
        };
      }
      const records = [],
        diagnostics = [];
      const fail = (reason) => ({
        records,
        diagnostics: [
          ...diagnostics,
          diagnostic({ agent, status: "failed", reason }),
        ],
      });
      if (definition.retired) return fail(REASON_CODES.CLI_NOT_FOUND);
      const listing =
        ctx.catalogEntry ?? (await fetchRuntimeCatalog(definition, ctx));
      if (listing.status !== "ok")
        return fail(listing.reason ?? REASON_CODES.PROBE_FAILED);
      const cliPath = listing.cliPath;
      if (!cliPath || isRetiredCommand(cliPath, ctx.cwd))
        return fail(REASON_CODES.CLI_NOT_FOUND);
      // The probe runs with the implementer's argv, exactly as dispatch launches it.
      const registry = loadRuntimeRegistry(ctx.cwd);
      const permission = runtimePermissionSummary(registry, definition);
      if (!permission.roles.length)
        return fail(REASON_CODES.PERMISSION_UNAVAILABLE);
      const probePermissionArgs = resolvePermission(registry, definition).args;
      // Alias-resolving runtimes pass the catalog value to `--model` and record the canonical
      // model the probe reports; `requestedModel` then carries the catalog value.
      const resolveModel = definition.models.resolveReportedModel === true;
      const filters =
        ctx.modelFilter === undefined
          ? null
          : [ctx.modelFilter].flat().filter(Boolean);
      let selected = 0;
      for (const { model, label } of listing.models) {
        if (filters && !filters.includes(model)) continue;
        selected++;
        // Never probe a model the repository policy excludes (deny wins over allow).
        if (isModelDenied(definition.id, model, ctx.cwd, label)) {
          diagnostics.push(
            diagnostic({
              agent,
              status: "failed",
              reason: REASON_CODES.MODEL_DENIED,
              model,
            }),
          );
          continue;
        }
        if (!isModelAllowed(definition.id, model, ctx.cwd)) {
          diagnostics.push(
            diagnostic({
              agent,
              status: "failed",
              reason: REASON_CODES.MODEL_NOT_ALLOWED,
              model,
            }),
          );
          continue;
        }
        // Enterprise mode: only an exactly attested requested model is ever probed.
        if (
          !evaluateRoute(
            {
              runtime: definition.id,
              requestedModel: resolveModel ? model : label,
            },
            { root: ctx.cwd, now: ctx.now },
          ).allow
        ) {
          diagnostics.push(
            diagnostic({
              agent,
              status: "failed",
              reason: REASON_CODES.ENTERPRISE_DENIED,
              model,
            }),
          );
          continue;
        }
        const args = [
          quoteSelectorArg(cliPath),
          ...definition.selectorArgs.map((arg) =>
            quoteSelectorArg(arg === "{model}" ? model : arg),
          ),
        ];
        if (args.some((arg) => !arg)) {
          diagnostics.push(
            diagnostic({
              agent,
              status: "failed",
              reason: REASON_CODES.MODEL_NOT_SELECTABLE,
              model,
            }),
          );
          continue;
        }
        const selector = args.join(" ");
        const result = await verifyModelCandidate(
          { model, selector },
          {
            ...ctx,
            run,
            env,
            resolveModel,
            extraArgs: [...probePermissionArgs, ...definition.probeArgs],
          },
        );
        if (!result.ok) {
          diagnostics.push(
            diagnostic({
              agent,
              status: "failed",
              reason: result.reason,
              model,
            }),
          );
          continue;
        }
        const entry = resolveModel
          ? { model: result.reportedModel, requestedModel: model }
          : { model, requestedModel: label };
        if (
          resolveModel &&
          isModelDenied(definition.id, entry.model, ctx.cwd)
        ) {
          diagnostics.push(
            diagnostic({
              agent,
              status: "failed",
              reason: REASON_CODES.MODEL_DENIED,
              model,
            }),
          );
          continue;
        }
        if (
          !evaluateRoute(
            {
              runtime: definition.id,
              requestedModel: entry.requestedModel,
              model: entry.model,
            },
            { root: ctx.cwd, now: ctx.now },
          ).allow
        ) {
          diagnostics.push(
            diagnostic({
              agent,
              status: "failed",
              reason: REASON_CODES.ENTERPRISE_DENIED,
              model,
            }),
          );
          continue;
        }
        if (records.some((record) => record.model === entry.model)) continue;
        for (const role of ["worker", "parent"])
          records.push(
            capabilityRecord({
              agent,
              ...entry,
              role,
              selector,
              timeoutMs: ctx.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
              permissionFingerprint: permission.fingerprint,
              permissionRoles: permission.roles,
            }),
          );
        diagnostics.push(
          diagnostic({ agent, status: "ok", model: entry.model }),
        );
      }
      if (!selected) return fail(REASON_CODES.MODEL_NOT_SELECTABLE);
      return { records, diagnostics, cliPath };
    },
    async launch(ctx = {}, job) {
      ctx = { ...ctx, cwd: job.cwd ?? ctx.cwd };
      if (definition.retired) throw new Error("runtime-retired");
      // Re-read the policy immediately before launch; a purpose is mandatory in enterprise mode.
      if (
        !evaluateRoute(
          {
            runtime: definition.id,
            requestedModel: job.requestedModel ?? job.model,
            model: job.model,
            purpose: job.purpose ?? "<missing>",
          },
          { root: job.cwd ?? ctx.cwd, now: ctx.now },
        ).allow
      )
        throw new Error("enterprise-route-denied");
      const root = ctx.cwd;
      const env = runtimeEnvironment(
        definition,
        ctx,
        job.leaseSession
          ? {
              session: job.leaseSession,
              ownerPid: ctx.leaseOwnerPid ?? process.pid,
            }
          : undefined,
      );
      const tokens = splitSelector(job.selector);
      if (isRetiredCommand(tokens[0], root)) throw new Error("runtime-retired");
      if (
        selectorHasPermissionArgs(
          { agent: definition.id, selector: job.selector },
          root,
        )
      )
        throw new Error("route-permission-args-forbidden");
      // Rebuilt from the registry on every launch; a job never supplies permission argv.
      // Any role other than planner/reviewer runs as the implementer, like its prompt.
      const permission = resolvePermission(
        loadRuntimeRegistry(root),
        definition,
        PERMISSION_ROLES.includes(job.role) ? job.role : undefined,
      );
      if (permission.unavailable) throw new Error(permission.unavailable);
      const cliPath =
        (await (ctx.resolveExecutable ?? resolveExecutable)(tokens[0], {
          env,
          pathEnv: ctx.pathEnv,
        })) ?? tokens[0];
      if (isRetiredCommand(cliPath, job.cwd ?? ctx.cwd))
        throw new Error("runtime-retired");
      return (ctx.spawnWorker ?? spawnWorker)(
        cliPath,
        [
          ...tokens.slice(1),
          ...permission.args,
          ...definition.promptArgs,
          buildWorkerPrompt(job),
        ],
        {
          timeoutMs: job.timeoutMs,
          env,
          cwd: job.cwd ?? ctx.cwd,
        },
      );
    },
  };
}
