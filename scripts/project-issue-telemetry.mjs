import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROHIBITED_FIELDS = new Set([
  "prompt",
  "response",
  "body",
  "title",
  "diff",
  "code",
  "credential",
  "credentials",
  "token_secret",
  "api_key",
  "password",
  "secret",
  "personal_data",
  "pii",
]);

const VALID_EVENT_TYPES = new Set(["route_decision", "role_execution", "terminal_outcome"]);
const VALID_AVAILABILITY = new Set(["exact", "estimate", "unavailable"]);
const VALID_AGENTS = new Set(["Codex", "Claude", "Grok", "Gemini"]);
const VALID_MODES = new Set(["single-agent", "multi-agent", "bounded-retry"]);
const VALID_EXIT_CLASSIFICATIONS = new Set([
  "success",
  "failed",
  "timeout",
  "abandoned",
  "cancelled",
  "error",
]);
const VALID_TERMINAL_STATUSES = new Set([
  "merged",
  "closed_unmerged",
  "failed",
  "cancelled",
  "in_progress",
]);
const VALID_PR_STATES = new Set(["merged", "open", "closed", "not_created"]);

export const VALID_FAILURE_REASON_CODES = new Set([
  "none",
  "duplicate_node_execution",
  "abandoned_worker",
  "timeout",
  "failed_handoff",
  "tests_failed",
  "review_failed",
  "gate_failed",
  "user_cancelled",
  "unknown",
]);

export const VALID_WASTE_REASON_CODES = new Set([
  "duplicate_node_execution",
  "abandoned_worker",
  "timeout",
  "failed_handoff",
  "redundant_retry",
  "unnecessary_review",
]);

/**
 * Telemetry configuration defaults and sanitizer.
 */
export const DEFAULT_TELEMETRY_CONFIG = Object.freeze({
  enabled: true,
  sinkType: "jsonl", // "jsonl" | "sqlite" | "both" | "noop"
  telemetryDir: "state/telemetry",
  jsonlFileName: "events.jsonl",
  sqliteFileName: "telemetry.db",
  retentionDays: 30,
  maxFileSizeBytes: 10 * 1024 * 1024, // 10MB rotation
  rotationMaxFiles: 5,
  redactUnknownFields: true,
});

export function sanitizeTelemetryConfig(rawConfig = {}) {
  const config = { ...DEFAULT_TELEMETRY_CONFIG, ...rawConfig };
  return {
    enabled: Boolean(config.enabled),
    sinkType: ["jsonl", "sqlite", "both", "noop"].includes(config.sinkType)
      ? config.sinkType
      : DEFAULT_TELEMETRY_CONFIG.sinkType,
    telemetryDir: String(config.telemetryDir || DEFAULT_TELEMETRY_CONFIG.telemetryDir),
    jsonlFileName: String(config.jsonlFileName || DEFAULT_TELEMETRY_CONFIG.jsonlFileName),
    sqliteFileName: String(config.sqliteFileName || DEFAULT_TELEMETRY_CONFIG.sqliteFileName),
    retentionDays:
      typeof config.retentionDays === "number" && config.retentionDays > 0
        ? config.retentionDays
        : DEFAULT_TELEMETRY_CONFIG.retentionDays,
    maxFileSizeBytes:
      typeof config.maxFileSizeBytes === "number" && config.maxFileSizeBytes > 0
        ? config.maxFileSizeBytes
        : DEFAULT_TELEMETRY_CONFIG.maxFileSizeBytes,
    rotationMaxFiles:
      typeof config.rotationMaxFiles === "number" && config.rotationMaxFiles > 0
        ? config.rotationMaxFiles
        : DEFAULT_TELEMETRY_CONFIG.rotationMaxFiles,
    redactUnknownFields: Boolean(config.redactUnknownFields),
  };
}

/**
 * Base Abstract / Interface for TelemetrySink.
 */
export class TelemetrySink {
  async emit(_event) {}
  async readEvents() {
    return [];
  }
  async close() {}
}

/**
 * Append-only JSONL sink with auto-creation, rotation, and non-blocking degradation.
 */
export class JsonlTelemetrySink extends TelemetrySink {
  constructor(config = {}) {
    super();
    this.config = sanitizeTelemetryConfig(config);
    this.filePath = path.join(this.config.telemetryDir, this.config.jsonlFileName);
  }

  async emit(rawEvent) {
    if (!this.config.enabled) return;
    try {
      const event = validateTelemetryEvent(rawEvent);
      await fs.mkdir(this.config.telemetryDir, { recursive: true });

      // Rotation check
      try {
        const stat = await fs.stat(this.filePath);
        if (stat.size >= this.config.maxFileSizeBytes) {
          await this._rotate();
        }
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }

      const line = `${JSON.stringify(event)}\n`;
      await fs.appendFile(this.filePath, line, "utf8");
    } catch (err) {
      // Non-blocking degradation
      console.warn(`[TelemetrySink:JSONL] Non-blocking emission failure: ${err.message}`);
    }
  }

  async _rotate() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rotatedPath = path.join(
        this.config.telemetryDir,
        `${this.config.jsonlFileName}.${timestamp}`
      );
      await fs.rename(this.filePath, rotatedPath);

      // Prune old rotated files if exceeding rotationMaxFiles (oldest first by name)
      const files = await fs.readdir(this.config.telemetryDir);
      const rotatedFiles = files
        .filter((f) => f.startsWith(`${this.config.jsonlFileName}.`))
        .sort((a, b) => a.localeCompare(b));

      while (rotatedFiles.length > this.config.rotationMaxFiles) {
        const oldest = rotatedFiles.shift();
        await fs.unlink(path.join(this.config.telemetryDir, oldest)).catch(() => {});
      }
    } catch (err) {
      console.warn(`[TelemetrySink:JSONL] Rotation error: ${err.message}`);
    }
  }

  async readEvents() {
    if (!this.config.enabled) return [];
    try {
      const files = await fs.readdir(this.config.telemetryDir);
      const rotatedFiles = files
        .filter((f) => f.startsWith(`${this.config.jsonlFileName}.`))
        .sort((a, b) => a.localeCompare(b)); // Oldest rotated files first

      const jsonlFiles = [...rotatedFiles];
      if (files.includes(this.config.jsonlFileName)) {
        jsonlFiles.push(this.config.jsonlFileName); // Active file last
      }

      const events = [];
      for (const file of jsonlFiles) {
        const content = await fs.readFile(path.join(this.config.telemetryDir, file), "utf8");
        const lines = content.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            events.push(validateTelemetryEvent(parsed));
          } catch {
            // Ignore malformed individual lines to degrade gracefully
          }
        }
      }
      return events;
    } catch (err) {
      if (err.code === "ENOENT") return [];
      console.warn(`[TelemetrySink:JSONL] Error reading events: ${err.message}`);
      return [];
    }
  }
}

/**
 * SQLite sink (using sqlite3 CLI tool or fallback) with non-blocking degradation.
 */
export class SqliteTelemetrySink extends TelemetrySink {
  constructor(config = {}) {
    super();
    this.config = sanitizeTelemetryConfig(config);
    this.dbPath = path.join(this.config.telemetryDir, this.config.sqliteFileName);
    this.initialized = false;
  }

  async _init() {
    if (this.initialized) return;
    try {
      await fs.mkdir(this.config.telemetryDir, { recursive: true });
      const schemaSql = `
        CREATE TABLE IF NOT EXISTS telemetry_events (
          event_id TEXT PRIMARY KEY,
          correlation_id TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          event_type TEXT NOT NULL,
          issue_number INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_correlation_id ON telemetry_events(correlation_id);
        CREATE INDEX IF NOT EXISTS idx_issue_number ON telemetry_events(issue_number);
        CREATE INDEX IF NOT EXISTS idx_event_type ON telemetry_events(event_type);
      `;
      await execFileAsync("sqlite3", [this.dbPath, schemaSql]);
      this.initialized = true;
    } catch (err) {
      // If sqlite3 CLI is missing or fails, mark initialized so we degrade safely
      console.warn(`[TelemetrySink:SQLite] Initialization warning (falling back / non-blocking): ${err.message}`);
      this.initialized = true; // prevent repeated retries if binary missing
      this.disabledFallback = true;
    }
  }

  async emit(rawEvent) {
    if (!this.config.enabled) return;
    try {
      await this._init();
      if (this.disabledFallback) return;

      const event = validateTelemetryEvent(rawEvent);
      // Properly quote and escape strings and numbers for sqlite3 CLI execution
      const escapeSql = (str) => String(str).replace(/'/g, "''").replace(/\x00/g, "");
      const sql = `INSERT OR REPLACE INTO telemetry_events (event_id, correlation_id, occurred_at, event_type, issue_number, payload_json) VALUES ('${escapeSql(
        event.eventId
      )}', '${escapeSql(event.correlationId)}', '${escapeSql(
        event.occurredAt
      )}', '${escapeSql(event.type)}', ${Number(event.issueNumber) || 0}, '${escapeSql(
        JSON.stringify(event.payload)
      )}');`;

      await execFileAsync("sqlite3", [this.dbPath, sql]);
    } catch (err) {
      console.warn(`[TelemetrySink:SQLite] Non-blocking emission failure: ${err.message}`);
    }
  }

  async readEvents() {
    if (!this.config.enabled) return [];
    try {
      await this._init();
      if (this.disabledFallback) return [];

      const query = `SELECT event_id, correlation_id, occurred_at, event_type, issue_number, payload_json FROM telemetry_events ORDER BY occurred_at ASC;`;
      const { stdout } = await execFileAsync("sqlite3", [this.dbPath, "-json", query]);
      if (!stdout.trim()) return [];

      const rows = JSON.parse(stdout);
      return rows.map((row) =>
        validateTelemetryEvent({
          schemaVersion: 1,
          eventId: row.event_id,
          correlationId: row.correlation_id,
          occurredAt: row.occurred_at,
          type: row.event_type,
          issueNumber: Number(row.issue_number),
          payload: JSON.parse(row.payload_json),
        })
      );
    } catch {
      return [];
    }
  }
}

/**
 * Composite Sink that broadcasts to multiple sinks.
 */
export class CompositeTelemetrySink extends TelemetrySink {
  constructor(sinks = []) {
    super();
    this.sinks = sinks;
  }

  async emit(event) {
    await Promise.all(
      this.sinks.map((sink) =>
        sink.emit(event).catch((err) => {
          console.warn(`[CompositeTelemetrySink] Sink error: ${err.message}`);
        })
      )
    );
  }

  async readEvents() {
    for (const sink of this.sinks) {
      const events = await sink.readEvents();
      if (events.length > 0) return events;
    }
    return [];
  }
}

/**
 * Factory function to create a TelemetrySink based on configuration.
 */
export function createTelemetrySink(rawConfig = {}) {
  const config = sanitizeTelemetryConfig(rawConfig);
  if (!config.enabled || config.sinkType === "noop") {
    return new TelemetrySink(); // noop implementation
  }
  if (config.sinkType === "jsonl") {
    return new JsonlTelemetrySink(config);
  }
  if (config.sinkType === "sqlite") {
    return new SqliteTelemetrySink(config);
  }
  if (config.sinkType === "both") {
    return new CompositeTelemetrySink([
      new JsonlTelemetrySink(config),
      new SqliteTelemetrySink(config),
    ]);
  }
  return new JsonlTelemetrySink(config);
}

/**
 * Generates an LLMOps observability summary report from a list of telemetry events.
 */
export function generateLLMOpsReport(events = []) {
  const validatedEvents = events.map(validateTelemetryEvent);

  const totalEvents = validatedEvents.length;
  const roleExecutions = validatedEvents.filter((e) => e.type === "role_execution");
  const terminalOutcomes = validatedEvents.filter((e) => e.type === "terminal_outcome");

  // Terminal Success Rate by Execution Mode
  const modeStats = {}; // mode -> { total: 0, success: 0 }
  // Success Rate by Route Combination (implementer + reviewer)
  const routeStats = {}; // routeKey -> { total: 0, success: 0 }
  // Failure rates for tests, review, verifier, gate
  const failureCounts = {
    tests_failed: 0,
    review_failed: 0,
    gate_failed: 0,
    timeout: 0,
    abandoned_worker: 0,
    duplicate_node_execution: 0,
    failed_handoff: 0,
    other: 0,
  };

  // Group events by correlationId to track end-to-end Issue execution
  const runsByCorrelation = {};
  for (const event of validatedEvents) {
    if (!runsByCorrelation[event.correlationId]) {
      runsByCorrelation[event.correlationId] = [];
    }
    runsByCorrelation[event.correlationId].push(event);
  }

  let runsWithHandoffs = 0;
  let handoffsWithSuccess = 0;
  let totalHumanInterventions = 0;
  const latenciesMs = [];

  for (const runEvents of Object.values(runsByCorrelation)) {
    const routeDec = runEvents.find((e) => e.type === "route_decision");
    const term = runEvents.find((e) => e.type === "terminal_outcome");

    const mode = routeDec?.payload?.mode || "unknown";
    if (!modeStats[mode]) modeStats[mode] = { total: 0, success: 0 };
    modeStats[mode].total += 1;

    const implAgent = routeDec?.payload?.selected?.agent || "unknown";
    const routeKey = `${mode}:${implAgent}`;
    if (!routeStats[routeKey]) routeStats[routeKey] = { total: 0, success: 0 };
    routeStats[routeKey].total += 1;

    if (term) {
      const isSuccess = term.payload.status === "merged";
      if (isSuccess) {
        modeStats[mode].success += 1;
        routeStats[routeKey].success += 1;
      } else {
        const reason = term.payload.failureReasonCode || "other";
        if (reason in failureCounts) {
          failureCounts[reason] += 1;
        } else {
          failureCounts.other += 1;
        }
      }

      if (term.payload.handoffCount > 0) {
        runsWithHandoffs += 1;
        if (isSuccess) handoffsWithSuccess += 1;
      }
      if (term.payload.humanIntervention) {
        totalHumanInterventions += 1;
      }
    }

    // Calculate latency
    const timestamps = runEvents.map((e) => Date.parse(e.occurredAt)).filter((t) => !isNaN(t));
    if (timestamps.length > 1) {
      const duration = Math.max(...timestamps) - Math.min(...timestamps);
      latenciesMs.push(duration);
    }
  }

  // Token consumption & token efficiency by Issue, Role, Mode
  const tokenUsage = aggregateTokenUsage(roleExecutions);
  const byModeTokenUsage = {};

  for (const exec of roleExecutions) {
    const runEvents = runsByCorrelation[exec.correlationId] || [];
    const routeDec = runEvents.find((e) => e.type === "route_decision");
    const mode = routeDec?.payload?.mode || "unknown";

    if (!byModeTokenUsage[mode]) {
      byModeTokenUsage[mode] = { exact: 0, estimate: 0, unavailable: 0 };
    }
    const tokens = exec.payload.tokens;
    for (const m of [tokens.input, tokens.output, tokens.total]) {
      if (!m) continue;
      if (m.availability === "exact") byModeTokenUsage[mode].exact += m.value;
      else if (m.availability === "estimate") byModeTokenUsage[mode].estimate += m.value;
      else if (m.availability === "unavailable") byModeTokenUsage[mode].unavailable += 1;
    }
  }

  // Quality-adjusted token efficiency (successes / 100k tokens)
  const modeEfficiency = {};
  for (const [mode, stats] of Object.entries(modeStats)) {
    const tokens = byModeTokenUsage[mode]?.exact || 0;
    const rate = stats.total > 0 ? (stats.success / stats.total) * 100 : 0;
    modeEfficiency[mode] = {
      terminalSuccessRatePercent: Number(rate.toFixed(1)),
      totalTokens: tokens,
      successesPer100kTokens: tokens > 0 ? Number(((stats.success / tokens) * 100000).toFixed(2)) : 0,
    };
  }

  latenciesMs.sort((a, b) => a - b);
  const medianLatencyMs = latenciesMs.length ? latenciesMs[Math.floor(latenciesMs.length / 2)] : 0;
  const p95LatencyMs = latenciesMs.length ? latenciesMs[Math.floor(latenciesMs.length * 0.95)] : 0;

  return {
    summary: {
      totalEvents,
      totalRuns: Object.keys(runsByCorrelation).length,
      terminalOutcomesCount: terminalOutcomes.length,
      humanInterventionRatePercent: Object.keys(runsByCorrelation).length > 0
        ? Number(((totalHumanInterventions / Object.keys(runsByCorrelation).length) * 100).toFixed(1))
        : 0,
      handoffSuccessRatePercent: runsWithHandoffs > 0
        ? Number(((handoffsWithSuccess / runsWithHandoffs) * 100).toFixed(1))
        : 0,
      latency: {
        medianMs: medianLatencyMs,
        p95Ms: p95LatencyMs,
      },
    },
    terminalSuccessByMode: modeEfficiency,
    routeSuccessRates: routeStats,
    gateAndExecutionFailures: failureCounts,
    tokenConsumption: {
      byIssue: tokenUsage.byIssue,
      byRole: tokenUsage.byRole,
      byMode: byModeTokenUsage,
    },
  };
}

/**
 * Recursively scans object keys for privacy-prohibited field names.
 */
function checkForProhibitedFields(obj, path = "") {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => checkForProhibitedFields(item, `${path}[${idx}]`));
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    if (PROHIBITED_FIELDS.has(key.toLowerCase())) {
      throw new Error(`privacy-prohibited-field:${currentPath}`);
    }
    if (value && typeof value === "object") {
      checkForProhibitedFields(value, currentPath);
    }
  }
}

function validateUsageMetric(metric, path) {
  if (!metric || typeof metric !== "object") {
    throw new Error(`invalid-metric:${path}`);
  }
  if (!VALID_AVAILABILITY.has(metric.availability)) {
    throw new Error(`invalid-availability:${path}.availability`);
  }

  if (metric.availability === "unavailable") {
    if (typeof metric.reasonCode !== "string" || !metric.reasonCode) {
      throw new Error(`missing-reason-code:${path}.reasonCode`);
    }
    if ("value" in metric && metric.value !== undefined) {
      throw new Error(`value-not-allowed-for-unavailable:${path}.value`);
    }
  } else {
    if (typeof metric.value !== "number" || Number.isNaN(metric.value) || metric.value < 0) {
      throw new Error(`invalid-metric-value:${path}.value`);
    }
  }
}

/**
 * Validates a telemetry event against schema v1.
 */
export function validateTelemetryEvent(event) {
  if (!event || typeof event !== "object") {
    throw new Error("invalid-event:must-be-object");
  }

  // Privacy scan on entire event
  checkForProhibitedFields(event);

  if (event.schemaVersion !== 1) {
    throw new Error(`unsupported-schema-version:${event.schemaVersion}`);
  }
  if (typeof event.eventId !== "string" || !event.eventId) {
    throw new Error("invalid-event-id");
  }
  if (typeof event.correlationId !== "string" || !event.correlationId) {
    throw new Error("invalid-correlation-id");
  }
  if (typeof event.occurredAt !== "string" || Number.isNaN(Date.parse(event.occurredAt))) {
    throw new Error("invalid-occurred-at");
  }
  if (!VALID_EVENT_TYPES.has(event.type)) {
    throw new Error(`invalid-event-type:${event.type}`);
  }
  if (typeof event.issueNumber !== "number" || event.issueNumber <= 0) {
    throw new Error("invalid-issue-number");
  }

  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid-payload");
  }

  if (event.type === "route_decision") {
    if (typeof payload.role !== "string" || !payload.role) {
      throw new Error("invalid-route-role");
    }
    if (!VALID_MODES.has(payload.mode)) {
      throw new Error(`invalid-route-mode:${payload.mode}`);
    }
    if (!Array.isArray(payload.candidates) || payload.candidates.length === 0) {
      throw new Error("invalid-route-candidates");
    }
    for (const cand of payload.candidates) {
      if (!cand || !VALID_AGENTS.has(cand.agent) || typeof cand.model !== "string") {
        throw new Error("invalid-route-candidate");
      }
    }
    if (!payload.selected || !VALID_AGENTS.has(payload.selected.agent) || typeof payload.selected.model !== "string") {
      throw new Error("invalid-route-selected");
    }
    if (typeof payload.reasonCode !== "string" || !payload.reasonCode) {
      throw new Error("invalid-route-reason-code");
    }
  } else if (event.type === "role_execution") {
    if (typeof payload.role !== "string" || !payload.role) {
      throw new Error("invalid-role");
    }
    if (!VALID_AGENTS.has(payload.agent)) {
      throw new Error(`invalid-agent:${payload.agent}`);
    }
    if (typeof payload.model !== "string" || !payload.model) {
      throw new Error("invalid-model");
    }

    validateUsageMetric(payload.durationMs, "payload.durationMs");

    if (!payload.tokens || typeof payload.tokens !== "object") {
      throw new Error("invalid-tokens-object");
    }
    validateUsageMetric(payload.tokens.input, "payload.tokens.input");
    validateUsageMetric(payload.tokens.output, "payload.tokens.output");
    validateUsageMetric(payload.tokens.total, "payload.tokens.total");

    if (payload.costUsd) {
      validateUsageMetric(payload.costUsd, "payload.costUsd");
    }

    if (!VALID_EXIT_CLASSIFICATIONS.has(payload.exitClassification)) {
      throw new Error(`invalid-exit-classification:${payload.exitClassification}`);
    }
  } else if (event.type === "terminal_outcome") {
    if (!VALID_TERMINAL_STATUSES.has(payload.status)) {
      throw new Error(`invalid-terminal-status:${payload.status}`);
    }
    if (!VALID_FAILURE_REASON_CODES.has(payload.failureReasonCode)) {
      throw new Error(`invalid-failure-reason-code:${payload.failureReasonCode}`);
    }
    if (!VALID_PR_STATES.has(payload.prState)) {
      throw new Error(`invalid-pr-state:${payload.prState}`);
    }
    if (typeof payload.humanIntervention !== "boolean") {
      throw new Error("invalid-human-intervention");
    }
    if (typeof payload.handoffCount !== "number" || payload.handoffCount < 0) {
      throw new Error("invalid-handoff-count");
    }
    if (!Array.isArray(payload.wasteReasonCodes)) {
      throw new Error("invalid-waste-reason-codes");
    }
    for (const code of payload.wasteReasonCodes) {
      if (!VALID_WASTE_REASON_CODES.has(code)) {
        throw new Error(`invalid-waste-reason-code:${code}`);
      }
    }
  }

  return event;
}

/**
 * Aggregates token metrics across events by Issue and by Role.
 */
export function aggregateTokenUsage(events) {
  const byIssue = {};
  const byRole = {};

  for (const rawEvent of events) {
    const event = validateTelemetryEvent(rawEvent);
    if (event.type !== "role_execution") continue;

    const issueKey = String(event.issueNumber);
    const roleKey = event.payload.role;
    const tokens = event.payload.tokens;

    // We count metrics from input, output, total
    const metrics = [tokens.input, tokens.output, tokens.total];

    for (const target of [byIssue, byRole]) {
      const key = target === byIssue ? issueKey : roleKey;
      if (!target[key]) {
        target[key] = { exact: 0, estimate: 0, unavailable: 0 };
      }
      for (const m of metrics) {
        if (!m) continue;
        if (m.availability === "exact") {
          target[key].exact += m.value;
        } else if (m.availability === "estimate") {
          target[key].estimate += m.value;
        } else if (m.availability === "unavailable") {
          target[key].unavailable += 1;
        }
      }
    }
  }

  return { byIssue, byRole };
}

/**
 * Migrates a legacy schema (v0) telemetry event to schemaVersion 1.
 */
export function migrateTelemetryEvent(legacyEvent) {
  if (!legacyEvent || typeof legacyEvent !== "object") {
    throw new Error("invalid-legacy-event");
  }

  const version = legacyEvent.schemaVersion ?? legacyEvent.version;
  if (version === 1) {
    return validateTelemetryEvent(legacyEvent);
  }

  if (version === 0) {
    const migrated = {
      schemaVersion: 1,
      eventId: legacyEvent.id ?? `evt-${Date.now()}`,
      correlationId: legacyEvent.runId ?? `run-${legacyEvent.issue ?? "unknown"}`,
      occurredAt: legacyEvent.timestamp ?? new Date().toISOString(),
      type: legacyEvent.eventType ?? "terminal_outcome",
      issueNumber: legacyEvent.issue,
      payload: {
        status: legacyEvent.data?.status ?? "failed",
        failureReasonCode: legacyEvent.data?.failureReasonCode ?? "unknown",
        prState: legacyEvent.data?.prState ?? "not_created",
        humanIntervention: Boolean(legacyEvent.data?.humanIntervention),
        handoffCount: legacyEvent.data?.handoffCount ?? 0,
        wasteReasonCodes: legacyEvent.data?.wasteReasonCodes ?? [],
      },
    };
    return validateTelemetryEvent(migrated);
  }

  throw new Error(`unsupported-legacy-version:${version}`);
}
