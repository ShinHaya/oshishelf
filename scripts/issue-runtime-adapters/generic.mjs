import {
  DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_WORKER_TIMEOUT_MS, REASON_CODES,
  buildWorkerPrompt, capabilityRecord, diagnostic, quoteSelectorArg,
  resolveExecutable, verifyModelCandidate, runProcess, spawnWorker, splitSelector,
} from "./shared.mjs";
import { parseAuthentication, parseCatalog } from "./parsers.mjs";
import { isRetiredCommand } from "../ai-template/registry.mjs";

export function createAdapter(definition) {
  const agent = definition.name;
  return {
    agent, id: definition.id, evaluationOrder: definition.evaluationOrder, definition,
    async discover(ctx = {}) {
      const timeoutMs = ctx.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
      const run = ctx.runProcess ?? runProcess;
      const resolve = ctx.resolveExecutable ?? resolveExecutable;
      const env = ctx.env ?? process.env;
      const records = [], diagnostics = [];
      const fail = reason => ({ records, diagnostics: [...diagnostics, diagnostic({ agent, status: "failed", reason })] });
      if (definition.retired) return fail(REASON_CODES.CLI_NOT_FOUND);
      let cliPath;
      for (const name of ctx.cliPath ? [ctx.cliPath] : definition.commands) {
        if (isRetiredCommand(name, ctx.cwd)) continue;
        const resolved = await resolve(name, { env, pathEnv: ctx.pathEnv });
        if (resolved && !isRetiredCommand(resolved, ctx.cwd)) { cliPath = resolved; break; }
      }
      if (!cliPath) return fail(REASON_CODES.CLI_NOT_FOUND);
      if (definition.auth) {
        const auth = await run(cliPath, definition.auth.args, { timeoutMs, env, cwd: ctx.cwd });
        if (auth.timedOut) return fail(REASON_CODES.VERIFICATION_TIMEOUT);
        if (!parseAuthentication(definition.auth.parser, auth)) return fail(REASON_CODES.AUTH_UNAVAILABLE);
      }
      const listed = definition.models.args.length
        ? await run(cliPath, definition.models.args, { timeoutMs, env, cwd: ctx.cwd }) : { code: 0, stdout: "" };
      if (listed.timedOut) return fail(REASON_CODES.VERIFICATION_TIMEOUT);
      const { models, loggedIn } = await parseCatalog(definition.models.parser, listed, ctx);
      if (listed.code !== 0) return fail(definition.auth || loggedIn ? REASON_CODES.PROBE_FAILED : REASON_CODES.AUTH_UNAVAILABLE);
      if (!models?.length) return fail(loggedIn === false ? REASON_CODES.AUTH_UNAVAILABLE : REASON_CODES.MODEL_NOT_SELECTABLE);
      let selected = 0;
      for (const entry of models) {
        if (ctx.modelFilter !== undefined && entry.model !== ctx.modelFilter) continue;
        selected++;
        const args = [quoteSelectorArg(cliPath), ...definition.selectorArgs.map(arg => quoteSelectorArg(arg === "{model}" ? entry.model : arg))];
        if (args.some(arg => !arg)) { diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.MODEL_NOT_SELECTABLE, model: entry.model })); continue; }
        const selector = args.join(" ");
        const result = await verifyModelCandidate({ ...entry, selector }, { ...ctx, run, env, extraArgs: definition.probeArgs });
        if (!result.ok) { diagnostics.push(diagnostic({ agent, status: "failed", reason: result.reason, model: entry.model })); continue; }
        for (const role of ["worker", "parent"]) records.push(capabilityRecord({ agent, ...entry, role, selector, timeoutMs: ctx.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS }));
        diagnostics.push(diagnostic({ agent, status: "ok", model: entry.model }));
      }
      if (!selected) return fail(REASON_CODES.MODEL_NOT_SELECTABLE);
      return { records, diagnostics, cliPath };
    },
    async launch(ctx = {}, job) {
      if (definition.retired) throw new Error("runtime-retired");
      const env = ctx.env ?? process.env;
      const tokens = splitSelector(job.selector);
      if (isRetiredCommand(tokens[0], job.cwd ?? ctx.cwd)) throw new Error("runtime-retired");
      const cliPath = await (ctx.resolveExecutable ?? resolveExecutable)(tokens[0], { env, pathEnv: ctx.pathEnv }) ?? tokens[0];
      if (isRetiredCommand(cliPath, job.cwd ?? ctx.cwd)) throw new Error("runtime-retired");
      return (ctx.spawnWorker ?? spawnWorker)(cliPath, [...tokens.slice(1), ...definition.promptArgs, buildWorkerPrompt(job)], {
        timeoutMs: job.timeoutMs, env, cwd: job.cwd ?? ctx.cwd,
      });
    },
  };
}
