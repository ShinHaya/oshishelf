import "server-only";
import { type TraceId, type AiFunction, type TelemetryRecord, recordTelemetry, createTraceId } from "./telemetry";

/**
 * Thread-local telemetry context for the current AI operation.
 * Uses a simple global variable with restore/cleanup via returned function.
 */
export interface TelemetryContext {
  traceId: TraceId;
  function: AiFunction;
  uid: string;
  version: string;
  startedAt: number;
  attempt?: number;
  parentTraceId?: TraceId;
}

let currentContext: TelemetryContext | null = null;

export function setTelemetryContext(ctx: TelemetryContext) {
  const prev = currentContext;
  currentContext = ctx;
  return () => {
    currentContext = prev;
  };
}

export function getCurrentContext(): TelemetryContext | null {
  return currentContext;
}

/**
 * Create and set a new telemetry context for an AI operation.
 * The returned function should be called to restore the previous context.
 */
export function startTelemetryTrace(
  function_: AiFunction,
  uid: string,
  version: string,
  parentTraceId?: TraceId,
  attempt?: number,
): () => void {
  const ctx: TelemetryContext = {
    traceId: createTraceId(),
    function: function_,
    uid,
    version,
    startedAt: Date.now(),
    attempt,
    parentTraceId,
  };
  return setTelemetryContext(ctx);
}

/**
 * Record the completion of a telemetry trace.
 * errorType should be normalized and never contain error messages or stack traces.
 */
export async function recordTrace(ok: boolean, errorType?: string, tokens?: TelemetryRecord["tokens"]) {
  const ctx = currentContext;
  if (!ctx) return;

  const model = process.env.LLM_MODEL ?? "gemini-2.0-flash";
  const env = (process.env.ENVIRONMENT ?? "dev") as "dev" | "staging" | "prod";

  await recordTelemetry({
    traceId: ctx.traceId,
    uid: ctx.uid,
    function: ctx.function,
    environment: env,
    model,
    version: ctx.version,
    startedAt: ctx.startedAt,
    finishedAt: Date.now(),
    ok,
    errorType,
    tokens,
    parentTraceId: ctx.parentTraceId,
    attempt: ctx.attempt,
  });
}
