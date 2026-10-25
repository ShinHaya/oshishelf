import "server-only";
import { db } from "../firebase-admin";

/** Unique ID for a trace, linking parent call and child model/tool calls */
export type TraceId = string & { readonly __brand: "TraceId" };

export function createTraceId(): TraceId {
  return (Date.now() + "-" + Math.random().toString(36).slice(2)) as TraceId;
}

export type AiFunction = "guard" | "importer" | "profile" | "twin" | "compat" | "watcher";

export interface TelemetryRecord {
  traceId: TraceId;
  uid: string;
  /** AI function that initiated the trace */
  function: AiFunction;
  environment: "dev" | "staging" | "prod";
  model: string;
  /** Code SHA or release version */
  version: string;
  /** Semver of prompt template */
  promptVersion?: string;
  /** Start timestamp (ms) */
  startedAt: number;
  /** End timestamp (ms), undefined while running */
  finishedAt?: number;
  /** true if succeeded, false if failed, undefined while running */
  ok?: boolean;
  /** Normalized error type, sanitized (no message content) */
  errorType?: string;
  /** Token counts: only included if obtainable, otherwise omitted */
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
  /** Parent trace ID if this is a child call (e.g., Gemini call from importer) */
  parentTraceId?: TraceId;
  /** Tool/model attempt number (1 for first, 2 for first retry, etc.) */
  attempt?: number;
  /** true if this result was served from cache */
  fromCache?: boolean;
}

export interface ToolCall {
  traceId: TraceId;
  tool: string;
  success: boolean;
  /** Normalized error type if failed, sanitized */
  errorType?: string;
  /** Timestamp (ms) */
  timestamp: number;
}

const TELEMETRY_COLLECTION = "aiTelemetry";
const MAX_RECORDS_PER_BATCH = 100;
const TELEMETRY_TIMEOUT_MS = 5000; // Write timeout to prevent blocking main flow
const RETENTION_DAYS = 90;

/** Queue for batching telemetry writes to avoid blocking main flow */
const writeQueue: TelemetryRecord[] = [];
let writeInProgress = false;

/**
 * Record a telemetry event. May be batched and delayed; not guaranteed to succeed.
 * Failures don't block the calling function.
 */
export async function recordTelemetry(record: TelemetryRecord) {
  writeQueue.push(record);
  scheduleWrite();
}

/** Record a tool call in a trace */
export async function recordToolCall(call: ToolCall) {
  try {
    const timeout = Promise.race([
      db.collection(TELEMETRY_COLLECTION).doc(`${call.traceId}-tools`).collection("calls").add(call),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TELEMETRY_TIMEOUT_MS)),
    ]);
    await timeout;
  } catch {
    // Silently drop on timeout or error - don't block main flow
  }
}

function scheduleWrite() {
  if (writeInProgress || writeQueue.length === 0) return;
  if (writeQueue.length < MAX_RECORDS_PER_BATCH && Math.random() > 0.1) {
    // Batch a bit: process if queue large enough or ~10% chance per call
    return;
  }
  writeInProgress = true;
  processWriteQueue().catch(() => {}).finally(() => {
    writeInProgress = false;
    if (writeQueue.length > 0) scheduleWrite();
  });
}

async function processWriteQueue() {
  const batch = writeQueue.splice(0, MAX_RECORDS_PER_BATCH);
  if (batch.length === 0) return;

  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TELEMETRY_TIMEOUT_MS));

  try {
    const writes = batch.map((record) => {
      const docId = `${record.traceId}-${record.attempt ?? 1}`;
      return db.collection(TELEMETRY_COLLECTION).doc(docId).set(record);
    });
    await Promise.race([Promise.all(writes), timeout]);
  } catch {
    // If write fails, drop the batch and continue - don't let telemetry break the app
  }
}

/**
 * Delete telemetry records associated with a user (called on account deletion).
 * This is fire-and-forget to not block account deletion.
 */
export function deleteTelemetryForUser(uid: string) {
  // Fire and forget - don't await
  (async () => {
    try {
      const snap = await db.collection(TELEMETRY_COLLECTION)
        .where("uid", "==", uid)
        .select()
        .get();

      let batch = db.batch();
      let count = 0;

      for (const doc of snap.docs) {
        batch.delete(doc.ref);
        count++;
        if (count % 500 === 0) {
          await batch.commit();
          batch = db.batch(); // Create new batch instance after commit
        }
      }
      if (count % 500 !== 0) await batch.commit();
    } catch {
      // Silently ignore errors
    }
  })();
}

/**
 * Set up a scheduled job to delete telemetry records older than retention period.
 * Call this in a Cloud Function or scheduled task.
 */
export async function deleteExpiredTelemetry() {
  const cutoffTime = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let batch = db.batch();
  let deleted = 0;
  const snap = await db.collection(TELEMETRY_COLLECTION).where("finishedAt", "<", cutoffTime).select().get();

  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    deleted++;
    if (deleted % 500 === 0) {
      await batch.commit();
      batch = db.batch(); // Create new batch instance after commit
    }
  }
  if (deleted % 500 !== 0) await batch.commit();

  return deleted;
}
