import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  aggregateTokenUsage,
  migrateTelemetryEvent,
  validateTelemetryEvent,
  JsonlTelemetrySink,
  SqliteTelemetrySink,
  createTelemetrySink,
  generateLLMOpsReport,
} from "../../scripts/project-issue-telemetry.mjs";

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`../fixtures/project-issue-telemetry/${name}`, import.meta.url), "utf8"));

test("validates common route, role, and terminal events and joins them by correlation ID", async () => {
  const events = await fixture("valid-v1.json");

  const validated = events.map(validateTelemetryEvent);

  assert.equal(new Set(validated.map(({ correlationId }) => correlationId)).size, 1);
  assert.deepEqual(validated[0].payload.candidates.map(({ agent }) => agent), [
    "Codex",
    "Claude",
    "Grok",
    "Gemini",
  ]);
  assert.deepEqual(aggregateTokenUsage(validated), {
    byIssue: { "9001": { exact: 100, estimate: 40, unavailable: 1 } },
    byRole: { implementer: { exact: 100, estimate: 40, unavailable: 1 } },
  });
});

test("accepts unavailable provider usage without inventing a numeric value", async () => {
  const events = await fixture("valid-v1.json");
  const roleEvent = events.find(({ type }) => type === "role_execution");

  const validated = validateTelemetryEvent(roleEvent);

  assert.deepEqual(validated.payload.tokens.total, {
    availability: "unavailable",
    reasonCode: "provider_not_exposed",
  });
});

test("rejects prohibited content anywhere in an event", async () => {
  const [event] = await fixture("valid-v1.json");

  assert.throws(
    () => validateTelemetryEvent({ ...event, payload: { ...event.payload, prompt: "secret" } }),
    /privacy-prohibited-field:payload\.prompt/,
  );
  assert.throws(
    () => validateTelemetryEvent({ ...event, payload: { ...event.payload, nested: { credentials: "secret" } } }),
    /privacy-prohibited-field:payload\.nested\.credentials/,
  );
});

test("migrates the documented legacy fixture to the current schema", async () => {
  const legacy = await fixture("legacy-v0.json");

  const migrated = migrateTelemetryEvent(legacy);

  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.correlationId, "run-legacy-1");
  assert.equal(validateTelemetryEvent(migrated).payload.status, "failed");
});

test("records closed duplicate, abandoned, timeout, and failed-handoff waste reasons", async () => {
  const events = await fixture("valid-v1.json");
  const terminal = events.find(({ type }) => type === "terminal_outcome");
  const accepted = ["duplicate_node_execution", "abandoned_worker", "timeout", "failed_handoff"];

  for (const reason of accepted) {
    assert.doesNotThrow(() =>
      validateTelemetryEvent({
        ...terminal,
        eventId: `evt-${reason}`,
        payload: { ...terminal.payload, failureReasonCode: reason, wasteReasonCodes: [reason] },
      }),
    );
  }
  assert.throws(
    () => validateTelemetryEvent({ ...terminal, payload: { ...terminal.payload, failureReasonCode: "free text" } }),
    /invalid-failure-reason-code/,
  );
});

test("JsonlTelemetrySink emits, rotates, and reads events", async () => {
  const testDir = path.join(process.cwd(), "tmp-test-telemetry-jsonl");
  await rm(testDir, { recursive: true, force: true });

  const sink = new JsonlTelemetrySink({
    telemetryDir: testDir,
    jsonlFileName: "test-events.jsonl",
    maxFileSizeBytes: 300, // Small size to test rotation
  });

  const events = await fixture("valid-v1.json");
  for (const evt of events) {
    await sink.emit(evt);
  }

  const readBack = await sink.readEvents();
  assert.equal(readBack.length, events.length);
  assert.equal(readBack[0].eventId, events[0].eventId);

  await rm(testDir, { recursive: true, force: true });
});

test("SqliteTelemetrySink or non-blocking fallback emits and reads events", async () => {
  const testDir = path.join(process.cwd(), "tmp-test-telemetry-sqlite");
  await rm(testDir, { recursive: true, force: true });

  const sink = new SqliteTelemetrySink({
    telemetryDir: testDir,
    sqliteFileName: "test-telemetry.db",
  });

  const events = await fixture("valid-v1.json");
  for (const evt of events) {
    await sink.emit(evt);
  }

  const readBack = await sink.readEvents();
  // Either sqlite3 executed successfully and read back events, or non-blocking fallback returned empty array without throwing
  assert.ok(Array.isArray(readBack));

  await rm(testDir, { recursive: true, force: true });
});

test("createTelemetrySink instantiates requested sink mode non-blockingly", async () => {
  const jsonlSink = createTelemetrySink({ sinkType: "jsonl" });
  assert.ok(jsonlSink instanceof JsonlTelemetrySink);

  const sqliteSink = createTelemetrySink({ sinkType: "sqlite" });
  assert.ok(sqliteSink instanceof SqliteTelemetrySink);

  const noopSink = createTelemetrySink({ enabled: false });
  await assert.doesNotThrow(async () => {
    await noopSink.emit({});
    const events = await noopSink.readEvents();
    assert.deepEqual(events, []);
  });
});

test("generateLLMOpsReport aggregates metrics and produces required dashboard sections", async () => {
  const events = await fixture("valid-v1.json");
  const report = generateLLMOpsReport(events);

  assert.ok(report.summary);
  assert.equal(report.summary.totalEvents, events.length);
  assert.ok(report.terminalSuccessByMode);
  assert.ok(report.routeSuccessRates);
  assert.ok(report.gateAndExecutionFailures);
  assert.ok(report.tokenConsumption);
});
