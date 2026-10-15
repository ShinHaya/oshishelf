import { createHash } from "node:crypto";

export const TRIAGE_DEFAULTS = Object.freeze({ mode: "off", model: "jev-1.13.0", maxRequests: 20 });
export const TRIAGE_POLICY = "triage-v3";
export const TRIAGE_RUBRIC_VERSION = "triage-rubric-538-v3";
export const TRIAGE_REVIEW_THRESHOLDS = Object.freeze({ confidence: 0.7, probabilityGap: 0.2 });
export const RISKS = ["low", "medium", "high", "critical"];
export const SIZES = ["XS", "S", "M", "L", "XL"];
export const FALLBACK_REASONS = [
  "disabled",
  "missing-key",
  "provider-unavailable",
  "input-not-approved",
  "sensitive-input",
  "input-too-large",
  "fetch-failed",
  "stale-input",
  "timeout",
  "cancelled",
  "auth-failed",
  "rate-limited",
  "provider-error",
  "invalid-response",
  "budget-exhausted",
  "insufficient-context",
];
const AGENTS = ["Codex", "Claude", "Grok", "Gemini"];
export const TASK_KINDS = ["docs", "local-code", "cross-component", "security"];
const label = (value) => typeof value === "string" && /^[\w .()+-]{1,100}$/.test(value);
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
export const validTimestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requireValue(ok) {
  if (!ok) throw new Error("triage-invalid-structure");
}
function keys(value, allowed) {
  requireValue(object(value) && Object.keys(value).every((k) => allowed.includes(k)));
}
function route(value) {
  keys(value, ["agent", "model"]);
  requireValue(AGENTS.includes(value.agent) && label(value.model));
  return { agent: value.agent, model: value.model };
}
export function normalizeTriageConfig(raw = {}) {
  keys(raw, ["mode", "model", "maxRequests", "allowPrivateIssues"]);
  const config = { ...TRIAGE_DEFAULTS, ...raw };
  requireValue(config.allowPrivateIssues === undefined || typeof config.allowPrivateIssues === "boolean");
  requireValue(["off", "shadow", "assisted"].includes(config.mode));
  requireValue(/^jev-\d+\.\d+\.\d+$/.test(config.model));
  requireValue(
    Number.isSafeInteger(config.maxRequests) && config.maxRequests >= 1 && config.maxRequests <= 20,
  );
  return config;
}
/** Closed RouteEvidence projection (design §4); rejects raw text and unknown fields. */
export function normalizeRouteEvidence(value) {
  keys(value, ["agent", "model", "profileVersion", "benchmarkVersion", "evaluatedAt", "tasks"]);
  const identity = route({ agent: value.agent, model: value.model });
  requireValue(
    label(value.profileVersion) && label(value.benchmarkVersion) && validTimestamp(value.evaluatedAt),
  );
  requireValue(Array.isArray(value.tasks) && value.tasks.length > 0 && value.tasks.length <= 4);
  const seen = new Set();
  const tasks = value.tasks.map((task) => {
    keys(task, ["kind", "samples", "passed", "medianDurationMs"]);
    requireValue(TASK_KINDS.includes(task.kind) && !seen.has(task.kind));
    seen.add(task.kind);
    requireValue(
      Number.isSafeInteger(task.samples) &&
        task.samples >= 0 &&
        Number.isSafeInteger(task.passed) &&
        task.passed >= 0 &&
        task.passed <= task.samples &&
        Number.isFinite(task.medianDurationMs) &&
        task.medianDurationMs >= 0,
    );
    return {
      kind: task.kind,
      samples: task.samples,
      passed: task.passed,
      medianDurationMs: task.medianDurationMs,
    };
  });
  return {
    ...identity,
    profileVersion: value.profileVersion,
    benchmarkVersion: value.benchmarkVersion,
    evaluatedAt: value.evaluatedAt,
    tasks,
  };
}
export function normalizeTriageInput(raw) {
  keys(raw, ["issue", "issueUpdatedAt", "routes", "routeEvidence", "policyVersion", "model"]);
  requireValue(Number.isSafeInteger(raw.issue) && raw.issue > 0 && validTimestamp(raw.issueUpdatedAt));
  requireValue(raw.policyVersion === TRIAGE_POLICY);
  const model = normalizeTriageConfig({ model: raw.model }).model;
  requireValue(Array.isArray(raw.routes) && raw.routes.length > 0 && raw.routes.length <= 256);
  const routes = raw.routes
    .map(route)
    .sort((a, b) => `${a.agent}:${a.model}`.localeCompare(`${b.agent}:${b.model}`, "en"));
  requireValue(new Set(routes.map((r) => `${r.agent}:${r.model}`)).size === routes.length);
  requireValue(Array.isArray(raw.routeEvidence) && raw.routeEvidence.length <= 256);
  const routeEvidence = raw.routeEvidence.map(normalizeRouteEvidence);
  requireValue(new Set(routeEvidence.map((r) => `${r.agent}:${r.model}`)).size === routeEvidence.length);
  return {
    issue: raw.issue,
    issueUpdatedAt: raw.issueUpdatedAt,
    policyVersion: TRIAGE_POLICY,
    model,
    routes,
    routeEvidence,
  };
}
export function triageContext(input, now = Date.now()) {
  const age = 30 * 24 * 60 * 60 * 1000;
  let evidence = input.routeEvidence
    .filter((e) => {
      const elapsed = now - Date.parse(e.evaluatedAt);
      return (
        elapsed >= 0 &&
        elapsed <= age &&
        e.tasks.every((t) => t.samples >= 10) &&
        input.routes.some((r) => r.agent === e.agent && r.model === e.model)
      );
    })
    .sort((a, b) => `${a.agent}:${a.model}`.localeCompare(`${b.agent}:${b.model}`, "en"));
  if (
    new Set(evidence.map((e) => e.benchmarkVersion)).size > 1 ||
    new Set(
      evidence.map((e) =>
        e.tasks
          .map((t) => t.kind)
          .sort()
          .join(","),
      ),
    ).size > 1 ||
    evidence.length < 2 ||
    input.routes.length > 32
  )
    evidence = [];
  const candidates = input.routes.filter((r) =>
    evidence.some((e) => e.agent === r.agent && e.model === r.model),
  );
  const routeMap = Object.fromEntries(candidates.map((r, i) => [`r${i}`, r]));
  return {
    model: input.model,
    issue: input.issue,
    issueUpdatedAt: input.issueUpdatedAt,
    policyVersion: TRIAGE_POLICY,
    routeSetHash: hash(input.routes),
    evidenceVersion: evidence.length ? hash(evidence) : "none",
    routeMap,
    evidence,
  };
}
export function fallbackResult(context, reason) {
  requireValue(FALLBACK_REASONS.includes(reason));
  const { issue, issueUpdatedAt, policyVersion, routeSetHash, evidenceVersion } = context;
  return { issue, issueUpdatedAt, policyVersion, routeSetHash, evidenceVersion, status: "fallback", reason };
}
export function parseDistribution(raw, options) {
  requireValue(object(raw) && raw.type === "choice" && options.includes(raw.choice));
  requireValue(
    object(raw.probabilities) &&
      Object.keys(raw.probabilities).length === options.length &&
      options.every((k) => Object.hasOwn(raw.probabilities, k)),
  );
  const probabilities = Object.fromEntries(
    options.map((k) => {
      const p = raw.probabilities[k];
      requireValue(Number.isFinite(p) && p >= 0 && p <= 1);
      return [k, p];
    }),
  );
  const values = Object.values(probabilities);
  requireValue(
    Math.abs(values.reduce((a, b) => a + b, 0) - 1) <= 1e-6 &&
      probabilities[raw.choice] === Math.max(...values),
  );
  requireValue(Number.isFinite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1);
  return { choice: raw.choice, probabilities, confidence: raw.confidence };
}
export function requiresReview(distribution) {
  const ranked = Object.values(distribution.probabilities).sort((a, b) => b - a);
  return distribution.confidence < TRIAGE_REVIEW_THRESHOLDS.confidence ||
    ranked[0] - (ranked[1] ?? 0) < TRIAGE_REVIEW_THRESHOLDS.probabilityGap;
}
export function parseTriageResponse(raw, input, context) {
  requireValue(object(raw) && raw.model === input.model && object(raw.answers));
  const routeOptions = Object.keys(context.routeMap);
  const answers = routeOptions.length ? ["risk", "size", "route"] : ["risk", "size"];
  requireValue(
    Object.keys(raw.answers).length === answers.length && answers.every((k) => Object.hasOwn(raw.answers, k)),
  );
  const risk = parseDistribution(raw.answers.risk, RISKS);
  const size = parseDistribution(raw.answers.size, SIZES);
  const route = routeOptions.length
    ? parseDistribution(raw.answers.route, [...routeOptions, "abstain"])
    : { choice: "abstain", probabilities: { abstain: 1 }, confidence: 0 };
  const { issue, issueUpdatedAt, policyVersion, routeSetHash, evidenceVersion } = context;
  return {
    issue,
    issueUpdatedAt,
    policyVersion,
    routeSetHash,
    evidenceVersion,
    status: "recommended",
    model: input.model,
    risk,
    size,
    route,
    routeMap: context.routeMap,
    disposition: requiresReview(risk) || requiresReview(size) ? "review-required" : "usable",
  };
}
/** Parent boundary: project output through the same contract, never trust raw child JSON. */
export function parseTriageResult(raw, input, context) {
  requireValue(object(raw));
  for (const k of ["issue", "issueUpdatedAt", "policyVersion", "routeSetHash", "evidenceVersion"])
    requireValue(raw[k] === context[k]);
  if (raw.status === "fallback") return fallbackResult(context, raw.reason);
  requireValue(raw.status === "recommended");
  const answers = { risk: { ...raw.risk, type: "choice" }, size: { ...raw.size, type: "choice" } };
  if (Object.keys(context.routeMap).length) answers.route = { ...raw.route, type: "choice" };
  return parseTriageResponse({ model: raw.model, answers }, input, context);
}
export function parseTriageDecision(raw, context, recommendation) {
  keys(raw, [
    "issue",
    "issueUpdatedAt",
    "policyVersion",
    "routeSetHash",
    "evidenceVersion",
    "action",
    "riskCategory",
    "size",
    "preferredRoute",
    "reason",
  ]);
  for (const k of ["issue", "issueUpdatedAt", "policyVersion", "routeSetHash", "evidenceVersion"])
    requireValue(raw[k] === context[k]);
  requireValue(["accept", "override", "fallback"].includes(raw.action));
  requireValue(
    ["accepted", "domain-review", "insufficient-context", "route-unavailable", "legacy-fallback"].includes(
      raw.reason,
    ),
  );
  if (raw.action !== "fallback") requireValue(validTimestamp(raw.issueUpdatedAt));
  if (raw.action === "override") requireValue(RISKS.includes(raw.riskCategory) && SIZES.includes(raw.size) &&
    ["domain-review", "insufficient-context", "route-unavailable"].includes(raw.reason));
  if (raw.riskCategory !== undefined) requireValue(RISKS.includes(raw.riskCategory));
  if (raw.size !== undefined) requireValue(SIZES.includes(raw.size));
  let result;
  if (raw.action === "accept" || raw.preferredRoute !== undefined) {
    result = parseTriageResult(recommendation, { model: context.model }, context);
    requireValue(result.status === "recommended");
  }
  if (raw.action === "fallback") {
    requireValue(
      raw.riskCategory === undefined && raw.size === undefined && raw.preferredRoute === undefined,
    );
  }
  if (raw.action === "accept") {
    requireValue(result.disposition === "usable" && raw.reason === "accepted");
    requireValue(raw.riskCategory === undefined || raw.riskCategory === result.risk.choice);
    requireValue(raw.size === undefined || raw.size === result.size.choice);
  }
  // Keep the original route distribution for shadow evaluation, but never adopt
  // an abstaining or uncertain answer as a preferred route.
  if (raw.preferredRoute !== undefined) {
    const preferred = route(raw.preferredRoute);
    const suggested = result.routeMap[result.route.choice];
    requireValue(
      !requiresReview(result.route) &&
        suggested &&
        preferred.agent === suggested.agent &&
        preferred.model === suggested.model,
    );
  }
  return {
    ...raw,
    ...(raw.action === "accept" ? { riskCategory: result.risk.choice, size: result.size.choice } : {}),
    ...(raw.preferredRoute ? { preferredRoute: route(raw.preferredRoute) } : {}),
  };
}
