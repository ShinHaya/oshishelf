#!/usr/bin/env node
/**
 * Jev triage evaluation harness.
 *
 * Runs labeled fictional Issues through the production `evaluateTriage` boundary
 * with an injected transport: the deterministic keyword baseline for CI, or the
 * live TypeSafe endpoint only behind an explicit opt-in. Records and reports keep
 * case ids, enums, probabilities and counts only — never titles, bodies, request
 * or response text.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateTriage, containsSensitiveInput, triageClassifierFingerprint, JEV_ENDPOINT } from "./project-issue-triage.mjs";
import { RISKS, SIZES, TRIAGE_POLICY, TRIAGE_RUBRIC_VERSION, requiresReview } from "./project-issue-triage-contract.mjs";
import { selectExecutionMode } from "./project-issue-roles.mjs";

export const DEFAULT_DATASET = fileURLToPath(
  new URL("../tests/fixtures/jev-triage-eval/dataset-v1.json", import.meta.url),
);
export const LANGUAGES = ["ja", "en", "mixed"];
export const SPLITS = ["tune", "holdout"];
/** Categories design §9 requires in both the tuning set and the fixed holdout. */
export const REQUIRED_TAGS = [
  "size-risk-mismatch",
  "ambiguous",
  "prompt-injection",
  "fake-secret",
  "issue-517-like",
];
export const TAGS = [
  ...REQUIRED_TAGS,
  "docs",
  "ui",
  "test",
  "ci",
  "refactor",
  "storage",
  "orchestration",
  "egress",
  "crypto",
  "auth",
  "irreversible",
  "personal-data",
];
export const MIN_CASES = 100;
export const MIN_HIGH_CRITICAL = 30;
const FIXTURE_UPDATED_AT = "2026-01-01T00:00:00Z";
// Labels only; the route question is evaluated separately through RouteEvidence.
const FIXTURE_ROUTES = [{ agent: "Codex", model: "eval-fixture" }];
const label = (value) => typeof value === "string" && /^[\w .()+-]{1,100}$/.test(value);
const isHighCritical = (risk) => risk === "high" || risk === "critical";

function fail(reason) {
  throw new Error(`triage-eval-invalid:${reason}`);
}
function onlyKeys(value, allowed, reason) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(reason);
  if (!Object.keys(value).every((key) => allowed.includes(key))) fail(reason);
}

/** Validate the dataset shape, split sizes and the fake-data tripwire alignment. */
export function validateEvalDataset(raw) {
  onlyKeys(
    raw,
    ["datasetVersion", "rubricVersion", "policyVersion", "model", "labeling", "cases"],
    "dataset",
  );
  if (!label(raw.datasetVersion) || !label(raw.rubricVersion)) fail("version");
  if (raw.rubricVersion !== TRIAGE_RUBRIC_VERSION) fail("rubric-version");
  if (raw.policyVersion !== TRIAGE_POLICY || !/^jev-\d+\.\d+\.\d+$/.test(raw.model)) fail("policy");
  onlyKeys(raw.labeling, ["status", "confirmedBy", "confirmedAt"], "labeling");
  const { status, confirmedBy, confirmedAt } = raw.labeling;
  if (status === "human-confirmed") {
    if (!label(confirmedBy) || Number.isNaN(Date.parse(confirmedAt ?? ""))) fail("labeling");
  } else if (status !== "agent-proposed" || confirmedBy !== null || confirmedAt !== null) fail("labeling");
  if (!Array.isArray(raw.cases)) fail("cases");
  const ids = new Set();
  const cases = raw.cases.map((item) => {
    onlyKeys(item, ["id", "split", "language", "tags", "title", "body", "label", "expectedOutcome"], "case");
    if (!/^[TH]\d{3}$/.test(item.id) || ids.has(item.id)) fail("id");
    ids.add(item.id);
    if (!SPLITS.includes(item.split) || item.id[0] !== (item.split === "tune" ? "T" : "H")) fail("split");
    if (!LANGUAGES.includes(item.language)) fail("language");
    if (!Array.isArray(item.tags) || !item.tags.every((tag) => TAGS.includes(tag))) fail("tags");
    if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 200) fail("title");
    if (typeof item.body !== "string" || !item.body.trim() || Buffer.byteLength(item.body) > 8 * 1024)
      fail("body");
    onlyKeys(item.label, ["risk", "size"], "label");
    if (!RISKS.includes(item.label.risk) || !SIZES.includes(item.label.size)) fail("label");
    if (!["classify", "sensitive-input"].includes(item.expectedOutcome)) fail("outcome");
    // Fake secrets live only in cases that expect the pre-send tripwire to fire.
    const sensitive = item.expectedOutcome === "sensitive-input";
    if (sensitive !== item.tags.includes("fake-secret")) fail(`fake-secret-tag:${item.id}`);
    if (containsSensitiveInput(`${item.title}\n${item.body}`) !== sensitive) fail(`tripwire:${item.id}`);
    return { ...item, tags: [...item.tags], label: { ...item.label } };
  });
  const summary = summarizeDataset(cases);
  if (summary.total < MIN_CASES) fail("too-few-cases");
  if (summary.highCritical < MIN_HIGH_CRITICAL) fail("too-few-high-critical");
  if (summary.splits.holdout.highCriticalClassifiable < MIN_HIGH_CRITICAL) fail("holdout-high-critical");
  for (const split of SPLITS) {
    for (const language of LANGUAGES)
      if (!summary.splits[split].languages[language]) fail(`missing-language:${split}:${language}`);
    for (const tag of REQUIRED_TAGS)
      if (!summary.splits[split].tags[tag]) fail(`missing-tag:${split}:${tag}`);
  }
  return {
    datasetVersion: raw.datasetVersion,
    rubricVersion: raw.rubricVersion,
    policyVersion: raw.policyVersion,
    model: raw.model,
    labeling: { status, confirmedBy, confirmedAt },
    cases,
    summary,
  };
}

function tally(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
function summarizeDataset(cases) {
  const splitSummary = (subset) => ({
    total: subset.length,
    highCritical: subset.filter((c) => isHighCritical(c.label.risk)).length,
    highCriticalClassifiable: subset.filter(
      (c) => isHighCritical(c.label.risk) && c.expectedOutcome === "classify",
    ).length,
    risks: tally(subset.map((c) => c.label.risk)),
    sizes: tally(subset.map((c) => c.label.size)),
    languages: tally(subset.map((c) => c.language)),
    tags: tally(subset.flatMap((c) => c.tags)),
  });
  return {
    total: cases.length,
    highCritical: cases.filter((c) => isHighCritical(c.label.risk)).length,
    splits: Object.fromEntries(
      SPLITS.map((split) => [split, splitSummary(cases.filter((c) => c.split === split))]),
    ),
  };
}

export async function loadEvalDataset(file = DEFAULT_DATASET) {
  return validateEvalDataset(JSON.parse(await fs.readFile(file, "utf8")));
}

/* ------------------------------------------------------------------ */
/* Transports                                                          */
/* ------------------------------------------------------------------ */

const KEYWORD_GROUPS = {
  egress:
    /外部|送信|送る|送って|送り|クラウド|サーバー|同期|通知|取得して|download|upload|send|webhook|cloud|hosted|relay|outbound|sync|share|POST /i,
  crypto: /暗号|鍵|nonce|KDF|encrypt|crypto|key/i,
  auth: /認証|ログイン|MFA|パスキー|CAPTCHA|cookie|トークン|OAuth|本人確認|資格情報|パスワード|token|sign-in|login|attest|identity|eligibility|same-site|bot check/i,
  irreversible: /削除|退会|上書き|確認なし|省略|wipe|delete|withdraw|overwrite|without asking|confirmation/i,
  personal:
    /個人|住所|電話|カード|CVV|マイナンバー|氏名|契約者|復号|personal|address|card|profile|decrypted|birth|ledger rows/i,
};
const SIZE_RULES = [
  ["XS", /誤字|typo|リンク切れ|anchor|文言|wording|copyright|キャプション|章番号|色トークン/i],
  ["XL", /段階|stages|multiple PRs|複数 PR|backend|service|relay|全サイト定義/i],
  ["L", /スキーマ|schema|migrat|移行|split|分割|across|複数モジュール|multiple modules|stage/i],
  [
    "S",
    /tests only|テストのみ|tests\/unit のみ|1ファイル|one workflow file|one file|renderer only|1箇所|one handler|one constant|one predicate|数行/i,
  ],
];
function distribution(options, choice, p) {
  const rest = (1 - p) / (options.length - 1);
  const probabilities = Object.fromEntries(options.map((option) => [option, option === choice ? p : rest]));
  return { type: "choice", choice, probabilities, confidence: p };
}

/**
 * Deterministic keyword/Size baseline (design §11 "Size とキーワードだけで判定").
 * It is the CI stand-in for the provider, never evidence of Jev's quality.
 */
export function keywordBaselineAnswers(text) {
  const hits = Object.values(KEYWORD_GROUPS).filter((pattern) => pattern.test(text)).length;
  const risk = hits >= 3 ? "critical" : hits === 2 ? "high" : hits === 1 ? "medium" : "low";
  const size = SIZE_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? "M";
  return {
    risk: distribution(RISKS, risk, hits === 1 ? 0.6 : 0.75),
    size: distribution(SIZES, size, size === "M" ? 0.6 : 0.75),
  };
}

/** A fetch stand-in that answers from the request it receives, like the API. */
export function createFakeTransport(answer) {
  return async (_url, init) => {
    const request = JSON.parse(init.body);
    const answers = answer(`${request.state.title}\n${request.state.body}`, request);
    const tokens = Math.ceil(Buffer.byteLength(init.body) / 4);
    return new Response(
      JSON.stringify({ model: request.model, answers, usage: { input_tokens: tokens, output_tokens: 12 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

/**
 * Wraps a transport to audit every outbound call without retaining its body:
 * the fixed endpoint, method, redirect policy, pinned model and closed question set.
 */
function auditedTransport(fetchImpl, model, audit, clock) {
  return async (url, init) => {
    audit.requests += 1;
    let request;
    try {
      request = JSON.parse(init.body);
    } catch {
      request = null;
    }
    const questions = Object.keys(request?.questions ?? {})
      .sort()
      .join(",");
    if (
      url !== JEV_ENDPOINT ||
      init.method !== "POST" ||
      init.redirect !== "error" ||
      request?.model !== model ||
      !["risk,size", "risk,route,size"].includes(questions)
    )
      audit.constraintViolations += 1;
    request = undefined;
    const started = clock();
    try {
      return await fetchImpl(url, init);
    } finally {
      audit.latenciesMs.push(Math.max(0, clock() - started));
    }
  };
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

const projectDistribution = ({ choice, probabilities, confidence }) => ({
  choice,
  probabilities: { ...probabilities },
  confidence,
});

/**
 * Evaluate one split (or all) sequentially — one request in flight, as in production.
 * `transport` is a fetch-compatible function; `apiKey` reaches only evaluateTriage.
 */
export async function runTriageEvaluation(
  dataset,
  {
    split = "holdout",
    transport,
    transportKind,
    apiKey = "offline-fake-transport",
    now = Date.now(),
    clock = Date.now,
    maxRequests = Infinity,
  } = {},
) {
  if (typeof transport !== "function") fail("transport");
  if (!["keyword-baseline", "jev-live", "test-fake"].includes(transportKind)) fail("transport-kind");
  const cases = dataset.cases.filter((c) => split === "all" || c.split === split);
  const classifiable = cases.filter((c) => c.expectedOutcome === "classify").length;
  // Never start a live run that would stop half-way through the split.
  if (classifiable > maxRequests) fail("max-requests-below-split");
  const audit = { requests: 0, constraintViolations: 0, latenciesMs: [] };
  const fetchImpl = auditedTransport(transport, dataset.model, audit, clock);
  const records = [];
  let providerUnavailable = false;
  for (const [index, item] of cases.entries()) {
    const before = audit.requests;
    // Like the run controller: 401/403/429/529 stop every later request.
    const response = providerUnavailable
      ? { result: { status: "fallback", reason: "provider-unavailable" }, usage: "unavailable" }
      : await evaluateTriage(
          {
            issue: index + 1,
            issueUpdatedAt: FIXTURE_UPDATED_AT,
            routes: FIXTURE_ROUTES,
            routeEvidence: [],
            policyVersion: TRIAGE_POLICY,
            model: dataset.model,
          },
          { mode: "shadow", model: dataset.model },
          {
            env: { TYPESAFE_API_KEY: apiKey },
            fetchImpl,
            fetchIssue: async () => ({
              isPrivate: false,
              title: item.title,
              body: item.body,
              updatedAt: FIXTURE_UPDATED_AT,
            }),
            now,
          },
        );
    const { result, usage } = response;
    if (["auth-failed", "rate-limited"].includes(result.reason)) providerUnavailable = true;
    records.push({
      id: item.id,
      split: item.split,
      language: item.language,
      tags: [...item.tags],
      label: { ...item.label },
      expectedOutcome: item.expectedOutcome,
      sent: audit.requests > before,
      status: result.status,
      ...(result.status === "fallback"
        ? { reason: result.reason }
        : {
            risk: projectDistribution(result.risk),
            size: projectDistribution(result.size),
            disposition: result.disposition,
          }),
      usage: usage === "unavailable" ? "unavailable" : { ...usage },
    });
  }
  return {
    classifierFingerprint: triageClassifierFingerprint(),
    datasetVersion: dataset.datasetVersion,
    rubricVersion: dataset.rubricVersion,
    policyVersion: dataset.policyVersion,
    model: dataset.model,
    labeling: { ...dataset.labeling },
    transportKind,
    split,
    evaluatedAt: new Date(now).toISOString(),
    // A provider stop leaves later cases unmeasured; such a run is invalid for the gate.
    complete: !providerUnavailable,
    records,
    audit: { ...audit, latenciesMs: [...audit.latenciesMs] },
  };
}

const RECORD_KEYS = new Set([
  "id",
  "split",
  "language",
  "tags",
  "label",
  "expectedOutcome",
  "sent",
  "status",
  "reason",
  "risk",
  "size",
  "disposition",
  "usage",
]);
/** True when no record carries a field outside the closed allowlist. */
export function recordsWithinAllowlist(records) {
  return records.every((record) => Object.keys(record).every((key) => RECORD_KEYS.has(key)));
}

function confusion(options, pairs) {
  const matrix = Object.fromEntries(
    options.map((row) => [row, Object.fromEntries(options.map((c) => [c, 0]))]),
  );
  for (const [actual, predicted] of pairs) matrix[actual][predicted] += 1;
  return matrix;
}
function brier(options, records, field) {
  if (!records.length) return null;
  const total = records.reduce(
    (sum, r) =>
      sum +
      options.reduce((s, k) => s + (r[field].probabilities[k] - (r.label[field] === k ? 1 : 0)) ** 2, 0),
    0,
  );
  return total / records.length;
}
function reliabilityBins(records, field, bins = 5) {
  return Array.from({ length: bins }, (_, i) => {
    const lower = i / bins;
    const upper = (i + 1) / bins;
    const members = records.filter((r) => {
      const p = r[field].probabilities[r[field].choice];
      return p >= lower && (i === bins - 1 ? p <= upper : p < upper);
    });
    return {
      lower,
      upper,
      count: members.length,
      meanProbability: members.length
        ? members.reduce((s, r) => s + r[field].probabilities[r[field].choice], 0) / members.length
        : null,
      accuracy: members.length
        ? members.filter((r) => r[field].choice === r.label[field]).length / members.length
        : null,
    };
  });
}
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const ratio = (numerator, denominator) => (denominator ? numerator / denominator : null);

/** Execution mode the graph would select if the recommendation were adopted (design §6). */
export function adoptedMode(record) {
  return selectExecutionMode({ riskCategory: record.risk.choice, size: record.size.choice }).mode;
}

export function computeTriageMetrics(run) {
  const { records, audit } = run;
  const expected = records.filter((r) => r.expectedOutcome === "classify");
  const recommended = expected.filter((r) => r.status === "recommended");
  const usable = recommended.filter((r) => r.disposition === "usable");
  const highCritical = expected.filter((r) => isHighCritical(r.label.risk));
  const hcRecommended = highCritical.filter((r) => r.status === "recommended");
  const hcUsable = hcRecommended.filter((r) => r.disposition === "usable");
  const directReviewMisses = hcUsable.filter((r) => adoptedMode(r) === "direct-review").map((r) => r.id);
  // A simulated parent overrides any usable answer that disagrees with the human label.
  const overrides = usable.filter((r) => r.risk.choice !== r.label.risk || r.size.choice !== r.label.size);
  const overrideCauses = {
    riskUnder: overrides.filter((r) => RISKS.indexOf(r.risk.choice) < RISKS.indexOf(r.label.risk)).length,
    riskOver: overrides.filter((r) => RISKS.indexOf(r.risk.choice) > RISKS.indexOf(r.label.risk)).length,
    sizeOnly: overrides.filter((r) => r.risk.choice === r.label.risk).length,
    byTag: tally(overrides.flatMap((r) => r.tags)),
    byLanguage: tally(overrides.map((r) => r.language)),
  };
  const sensitive = records.filter((r) => r.expectedOutcome === "sensitive-input");
  const usage = records.map((r) => r.usage).filter((u) => u !== "unavailable");
  return {
    cases: records.length,
    classifiable: expected.length,
    outcomes: {
      recommended: recommended.length,
      fallback: tally(expected.filter((r) => r.status === "fallback").map((r) => r.reason)),
      reviewRequired: recommended.length - usable.length,
      usable: usable.length,
    },
    risk: {
      confusion: confusion(
        RISKS,
        recommended.map((r) => [r.label.risk, r.risk.choice]),
      ),
      accuracy: ratio(recommended.filter((r) => r.risk.choice === r.label.risk).length, recommended.length),
      brier: brier(RISKS, recommended, "risk"),
      reliability: reliabilityBins(recommended, "risk"),
    },
    size: {
      confusion: confusion(
        SIZES,
        recommended.map((r) => [r.label.size, r.size.choice]),
      ),
      accuracy: ratio(recommended.filter((r) => r.size.choice === r.label.size).length, recommended.length),
      brier: brier(SIZES, recommended, "size"),
    },
    highCritical: {
      labeled: highCritical.length,
      recommended: hcRecommended.length,
      usable: hcUsable.length,
      predictedLowOrMedium: hcRecommended.filter((r) => !isHighCritical(r.risk.choice)).length,
      missRate: ratio(
        hcRecommended.filter((r) => !isHighCritical(r.risk.choice)).length,
        hcRecommended.length,
      ),
      directReviewMisses,
      // Fallback/review-required: not adoptable, so the legacy Size-based mode decides.
      unresolved: highCritical.length - hcUsable.length,
      usableRiskReviewFlags: hcUsable.filter((r) => requiresReview(r.risk)).length,
    },
    abstainRate: ratio(expected.length - usable.length, expected.length),
    overrideRate: ratio(overrides.length, usable.length),
    overrideCauses,
    sensitive: {
      expected: sensitive.length,
      blockedBeforeSend: sensitive.filter((r) => !r.sent && r.reason === "sensitive-input").length,
      leaked: sensitive.filter((r) => r.sent).length,
    },
    boundary: {
      recordsWithinAllowlist: recordsWithinAllowlist(records),
      constraintViolations: audit.constraintViolations,
    },
    cost: {
      requests: audit.requests,
      tokens:
        usage.length === records.filter((r) => r.sent).length && usage.length
          ? {
              status: "exact",
              inputTokens: usage.reduce((s, u) => s + u.inputTokens, 0),
              outputTokens: usage.reduce((s, u) => s + u.outputTokens, 0),
            }
          : { status: usage.length ? "partial" : "unavailable", reportedRequests: usage.length },
      // Unit price is not confirmed for this account; never fabricate a currency amount.
      price: "unavailable",
    },
    latency: {
      medianMs: median(audit.latenciesMs),
      maxMs: audit.latenciesMs.length ? Math.max(...audit.latenciesMs) : null,
    },
  };
}

/**
 * Assisted-migration gate. The harness can only *measure*; label
 * confirmation, override-cause review and the Product Owner decision stay pending
 * until recorded by people, so the gate can never report "met" on its own.
 */
export function assessAssistedGate(run, metrics) {
  const live = run.transportKind === "jev-live";
  // Provider-quality conditions are not measured by a stand-in transport.
  const measured = (ok) => (!live ? "unmeasured" : ok ? "met" : "not-met");
  const conditions = [
    { id: "current-classifier", status: run.policyVersion === TRIAGE_POLICY &&
        run.rubricVersion === TRIAGE_RUBRIC_VERSION &&
        run.model === "jev-1.13.0" &&
        run.classifierFingerprint === triageClassifierFingerprint() ? "met" : "not-met" },
    { id: "live-jev-measurement", status: live ? "met" : "not-met" },
    { id: "complete-run", status: run.complete ? "met" : "not-met" },
    { id: "holdout-split", status: run.split === "holdout" ? "met" : "not-met" },
    { id: "labels-human-confirmed", status: run.labeling.status === "human-confirmed" ? "met" : "pending" },
    {
      id: "holdout-high-critical-usable-at-least-30",
      status: measured(metrics.highCritical.usable >= MIN_HIGH_CRITICAL),
      value: metrics.highCritical.usable,
    },
    {
      id: "zero-direct-review-misses",
      status: measured(metrics.highCritical.directReviewMisses.length === 0),
      value: metrics.highCritical.directReviewMisses.length,
    },
    {
      id: "zero-leaks",
      status: measured(metrics.sensitive.leaked === 0 && metrics.boundary.recordsWithinAllowlist),
      value: metrics.sensitive.leaked,
    },
    {
      id: "zero-constraint-violations",
      status: measured(metrics.boundary.constraintViolations === 0),
      value: metrics.boundary.constraintViolations,
    },
    { id: "override-causes-reviewed", status: "pending" },
    { id: "product-owner-decision", status: "pending" },
  ];
  const overall =
    ["not-met", "unmeasured", "pending"].find((status) => conditions.some((c) => c.status === status)) ??
    "met";
  return { overall, conditions };
}

/* ------------------------------------------------------------------ */
/* Shadow vs. manual assignment comparison                             */
/* ------------------------------------------------------------------ */

const MIN_COMPARISON_SAMPLE = 10;
const issueNumber = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

/**
 * Shadow mode never changes execution, so the useful signal is within shadow runs:
 * outcomes of Issues whose manual route agreed with Jev's recommendation versus
 * those that did not (abstain and fallback apart). Shadow-vs-off is context only —
 * it differs by Issue mix and period, not by recommendation quality.
 * Reads only allowlisted run-summary fields; a summary carries no Issue text.
 */
export function compareShadowRuns(summaries) {
  const strata = { agree: [], disagree: [], abstain: [], fallback: [], unrecorded: [] };
  const context = { shadow: [], off: [] };
  for (const summary of summaries) {
    if (!summary || typeof summary !== "object") fail("summary");
    const shadow = Array.isArray(summary.shadowTriage);
    const completed = new Set((summary.completed ?? []).map(issueNumber));
    const usage = new Map(
      (summary.usage?.issues ?? []).map((entry) => [issueNumber(entry?.number), entry?.usage]),
    );
    const triage = new Map(
      (shadow ? summary.shadowTriage : []).map((entry) => [issueNumber(entry?.issue), entry]),
    );
    for (const assignment of summary.assignments ?? []) {
      const number = issueNumber(assignment?.number);
      if (!number) continue;
      const passes = (summary.roles ?? [])
        .filter((role) => role?.issue === number && Number.isSafeInteger(role.reviewPasses))
        .map((role) => role.reviewPasses);
      const exact = usage.get(number);
      const outcome = {
        completed: completed.has(number),
        reviewPasses: passes.length ? Math.max(...passes) : null,
        wallClockMs: Number.isSafeInteger(exact?.wallClockMs) ? exact.wallClockMs : null,
        tokens:
          Number.isSafeInteger(exact?.inputTokens) && Number.isSafeInteger(exact?.outputTokens)
            ? exact.inputTokens + exact.outputTokens
            : null,
      };
      context[shadow ? "shadow" : "off"].push(outcome);
      if (shadow) strata[agreementOf(triage.get(number))].push(outcome);
    }
  }
  return {
    runs: summaries.length,
    byAgreement: Object.fromEntries(
      Object.entries(strata).map(([key, items]) => [key, describeOutcomes(items)]),
    ),
    context: {
      note: "confounded by Issue mix and period; not evidence of recommendation quality",
      shadow: describeOutcomes(context.shadow),
      off: describeOutcomes(context.off),
    },
  };
}

function agreementOf(entry) {
  const result = entry?.result;
  if (!entry) return "unrecorded";
  if (result?.status !== "recommended") return "fallback";
  const suggested = result.route?.choice === "abstain" ? null : result.routeMap?.[result.route?.choice];
  if (!suggested) return "abstain";
  const assigned = entry.assignedRoute;
  return suggested.agent === assigned?.agent && suggested.model === assigned?.model ? "agree" : "disagree";
}

function describeOutcomes(items) {
  const reviewed = items.filter((i) => i.reviewPasses !== null);
  const tokens = items.map((i) => i.tokens).filter((t) => t !== null);
  return {
    issues: items.length,
    sample: items.length >= MIN_COMPARISON_SAMPLE ? "sufficient" : "insufficient-sample",
    completionRate: ratio(items.filter((i) => i.completed).length, items.length),
    reviewFixRate: ratio(reviewed.filter((i) => i.reviewPasses > 1).length, reviewed.length),
    medianWallClockMs: median(items.map((i) => i.wallClockMs).filter((v) => v !== null)),
    exactTokens:
      tokens.length === items.length && tokens.length ? tokens.reduce((a, b) => a + b, 0) : "unavailable",
  };
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const num = (value, digits = 3) => (value === null ? "n/a" : value.toFixed(digits));
function matrixTable(options, matrix) {
  return [
    `| label \\ predicted | ${options.join(" | ")} |`,
    `|---|${options.map(() => "---").join("|")}|`,
    ...options.map((row) => `| ${row} | ${options.map((col) => matrix[row][col]).join(" | ")} |`),
  ];
}

/** Markdown with case ids, enums and aggregates only. */
export function formatTriageReport(run, metrics, gate) {
  const lines = [
    `### Triage evaluation — ${run.split} (${run.transportKind})`,
    "",
    `- Dataset ${run.datasetVersion}, rubric ${run.rubricVersion}, policy ${run.policyVersion}, model ${run.model}`,
    `- Labels: ${run.labeling.status}; evaluated ${run.evaluatedAt}; complete run: ${run.complete}`,
    `- Cases ${metrics.cases} (classifiable ${metrics.classifiable}); recommended ${metrics.outcomes.recommended}, usable ${metrics.outcomes.usable}, review-required ${metrics.outcomes.reviewRequired}, fallback ${JSON.stringify(metrics.outcomes.fallback)}`,
    "",
    "**Risk confusion matrix**",
    "",
    ...matrixTable(RISKS, metrics.risk.confusion),
    "",
    `- Risk accuracy ${pct(metrics.risk.accuracy)}, Brier ${num(metrics.risk.brier)}; Size accuracy ${pct(metrics.size.accuracy)}, Brier ${num(metrics.size.brier)}`,
    `- High/critical: labeled ${metrics.highCritical.labeled}, recommended ${metrics.highCritical.recommended}, usable ${metrics.highCritical.usable}, predicted low/medium ${metrics.highCritical.predictedLowOrMedium} (miss rate ${pct(metrics.highCritical.missRate)})`,
    `- Direct-review misses (usable high/critical adopted as direct-review): ${metrics.highCritical.directReviewMisses.length}${metrics.highCritical.directReviewMisses.length ? ` (${metrics.highCritical.directReviewMisses.join(", ")})` : ""}; unresolved high/critical left to legacy mode: ${metrics.highCritical.unresolved}`,
    `- Abstain rate ${pct(metrics.abstainRate)}; simulated override rate ${pct(metrics.overrideRate)} (risk under ${metrics.overrideCauses.riskUnder}, risk over ${metrics.overrideCauses.riskOver}, size only ${metrics.overrideCauses.sizeOnly})`,
    `- Override causes by tag: ${JSON.stringify(metrics.overrideCauses.byTag)}; by language: ${JSON.stringify(metrics.overrideCauses.byLanguage)}`,
    `- Fake-secret cases ${metrics.sensitive.expected}: blocked before send ${metrics.sensitive.blockedBeforeSend}, sent ${metrics.sensitive.leaked}; constraint violations ${metrics.boundary.constraintViolations}; records within allowlist ${metrics.boundary.recordsWithinAllowlist}`,
    "",
    "**Risk reliability bins (choice probability)**",
    "",
    "| bin | count | mean p | accuracy |",
    "|---|---|---|---|",
    ...metrics.risk.reliability.map(
      (b) =>
        `| ${b.lower.toFixed(1)}–${b.upper.toFixed(1)} | ${b.count} | ${num(b.meanProbability)} | ${pct(b.accuracy)} |`,
    ),
    "",
    `**Cost and latency (separate from quality)**: requests ${metrics.cost.requests}; tokens ${JSON.stringify(metrics.cost.tokens)}; price ${metrics.cost.price}; median latency ${metrics.latency.medianMs ?? "n/a"} ms, max ${metrics.latency.maxMs ?? "n/a"} ms`,
    "",
    `**Assisted gate**: ${gate.overall}`,
    "",
    ...gate.conditions.map((c) => `- ${c.id}: ${c.status}${c.value === undefined ? "" : ` (${c.value})`}`),
  ];
  if (run.transportKind !== "jev-live")
    lines.push(
      "",
      "> This run used a deterministic stand-in transport. Its numbers describe that baseline, not Jev; Jev quality is unmeasured.",
    );
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function parseEvalArgs(argv) {
  const options = {
    dataset: DEFAULT_DATASET,
    split: "holdout",
    transport: "baseline",
    format: "markdown",
    compareRuns: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`triage-eval-missing-value:${arg}`);
      return next;
    };
    if (arg === "--dataset") options.dataset = value();
    else if (arg === "--split") options.split = value();
    else if (arg === "--transport") options.transport = value();
    else if (arg === "--format") options.format = value();
    else if (arg === "--now") options.now = value();
    else if (arg === "--max-requests") options.maxRequests = Number(value());
    else if (arg === "--compare-runs") options.compareRuns.push(value());
    else throw new Error(`triage-eval-unknown-argument:${arg}`);
  }
  if (![...SPLITS, "all"].includes(options.split)) throw new Error("triage-eval-invalid-split");
  if (!["baseline", "live"].includes(options.transport)) throw new Error("triage-eval-invalid-transport");
  if (!["markdown", "json"].includes(options.format)) throw new Error("triage-eval-invalid-format");
  if (options.now !== undefined && Number.isNaN(Date.parse(options.now)))
    throw new Error("triage-eval-invalid-now");
  if (options.transport === "live" && !(Number.isSafeInteger(options.maxRequests) && options.maxRequests > 0))
    throw new Error("triage-eval-live-requires-max-requests");
  return options;
}

async function main(argv, env) {
  const options = parseEvalArgs(argv);
  if (options.compareRuns.length) {
    const summaries = await Promise.all(
      options.compareRuns.map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))),
    );
    process.stdout.write(`${JSON.stringify(compareShadowRuns(summaries), null, 2)}\n`);
    return;
  }
  const dataset = await loadEvalDataset(options.dataset);
  const live = options.transport === "live";
  if (live && !env.TYPESAFE_API_KEY) throw new Error("triage-eval-missing-key");
  const run = await runTriageEvaluation(dataset, {
    split: options.split,
    transport: live ? fetch : createFakeTransport(keywordBaselineAnswers),
    transportKind: live ? "jev-live" : "keyword-baseline",
    ...(live ? { apiKey: env.TYPESAFE_API_KEY, maxRequests: options.maxRequests } : {}),
    ...(options.now ? { now: Date.parse(options.now) } : {}),
  });
  const metrics = computeTriageMetrics(run);
  const gate = assessAssistedGate(run, metrics);
  process.stdout.write(
    options.format === "json"
      ? `${JSON.stringify({ ...run, metrics, gate }, null, 2)}\n`
      : `${formatTriageReport(run, metrics, gate)}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).catch((error) => {
    // Closed codes only; never echo provider or Issue content.
    const code = /^triage-eval-[\w:-]+$/.test(error?.message ?? "") ? error.message : "triage-eval-failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
