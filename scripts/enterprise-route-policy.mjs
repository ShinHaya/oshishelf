/**
 * Opt-in enterprise route attestation (Issue #65).
 *
 * When `enterprise.routeAttestation` is true in `.ai-template/config.json`, a runtime/model route
 * is admitted only if the operator's local, ignored record `state/enterprise-route-attestation.json`
 * attests it for the requested purpose. The record is operator self-attestation: this module cannot
 * verify an account, contract or provider setting, and it supplies no machine check, so the
 * `machine-verified` confirmation is rejected until a concrete check exists. Evaluation is pure
 * (apart from reading the record), re-reads the record on every call, and returns only closed
 * reason codes: record contents never reach diagnostics, caches or run state.
 */
import fs from "node:fs";
import path from "node:path";

export const ENTERPRISE_RECORD_PATH = "state/enterprise-route-attestation.json";
export const RECORD_VERSION = 1;
/** Closed purpose set. Mapping from orchestration roles is the identity; `parent` and `triage` are non-role purposes. */
export const PURPOSES = Object.freeze([
  "planner",
  "implementer",
  "reviewer",
  "parent",
  "triage",
]);
export const CONDITIONS = Object.freeze([
  "trainingOptOut",
  "retention",
  "externalTransmission",
  "telemetry",
]);
/** `machine-verified` is reserved: no supported check supplies evidence yet. */
export const CONFIRMATIONS = Object.freeze([
  "self-declared",
  "machine-verified",
  "unconfirmed",
]);
export const DENY_REASONS = Object.freeze({
  PURPOSE: "enterprise-purpose-missing",
  RECORD: "enterprise-record-invalid",
  NOT_ATTESTED: "enterprise-route-not-attested",
  PURPOSE_NOT_APPROVED: "enterprise-purpose-not-approved",
  MODEL_MISMATCH: "enterprise-model-mismatch",
  EXPIRED: "enterprise-attestation-expired",
  NOT_YET_VALID: "enterprise-attestation-future-dated",
  CONDITION: "enterprise-condition-not-acceptable",
  UNCONFIRMED: "enterprise-condition-unconfirmed",
  MACHINE_UNSUPPORTED: "enterprise-machine-verification-unsupported",
});

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/** Model labels may be CLI display names (for example "GPT Test", "Grok 4.5"): single spaces allowed. */
const MODEL_LABEL =
  /^[A-Za-z0-9][A-Za-z0-9._:/()+-]*(?: [A-Za-z0-9._:/()+-]+)*$/;
const VALUE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVIDENCE = /^[A-Za-z0-9][A-Za-z0-9 ._:/#-]{0,159}$/;

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const exactKeys = (value, keys) =>
  isObject(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));
const validDate = (s) =>
  typeof s === "string" &&
  DATE.test(s) &&
  new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** Whether the enterprise guard is switched on in repository config. Missing/other values mean off. */
export function isEnterpriseMode(root = process.cwd()) {
  const file = path.join(path.resolve(root), ".ai-template/config.json");
  if (!fs.existsSync(file)) return false;
  try {
    const enterprise = JSON.parse(fs.readFileSync(file, "utf8")).enterprise;
    if (enterprise === undefined) return false;
    // An invalid shape is rejected by the config loader; here it must not read as "off".
    if (
      !isObject(enterprise) ||
      Object.keys(enterprise).some((k) => k !== "routeAttestation") ||
      (enterprise.routeAttestation !== undefined &&
        typeof enterprise.routeAttestation !== "boolean")
    )
      return true;
    return enterprise.routeAttestation === true;
  } catch {
    // An unreadable config is rejected by the registry loader; never treat it as "off" silently.
    return true;
  }
}

/** Parse and validate the record; returns `{ ok, record }` or `{ ok: false }`. Never throws. */
export function loadAttestationRecord(root = process.cwd()) {
  try {
    const text = fs.readFileSync(
      path.join(path.resolve(root), ENTERPRISE_RECORD_PATH),
      "utf8",
    );
    const record = JSON.parse(text);
    if (!validateRecord(record)) return { ok: false };
    return { ok: true, record };
  } catch {
    return { ok: false };
  }
}

function validateRecord(record) {
  if (!exactKeys(record, ["version", "acceptable", "routes"])) return false;
  if (record.version !== RECORD_VERSION) return false;
  if (!exactKeys(record.acceptable, [...CONDITIONS])) return false;
  for (const c of CONDITIONS) {
    const list = record.acceptable[c];
    if (
      !Array.isArray(list) ||
      !list.length ||
      !list.every((v) => typeof v === "string" && VALUE.test(v)) ||
      new Set(list).size !== list.length
    )
      return false;
  }
  if (!Array.isArray(record.routes) || !record.routes.length) return false;
  const seen = new Set();
  for (const r of record.routes) {
    if (
      !exactKeys(r, [
        "runtime",
        "provider",
        "requestedModel",
        "canonicalModel",
        "purposes",
        "verifiedOn",
        "expiresOn",
        "conditions",
      ])
    )
      return false;
    if (
      ![r.runtime, r.provider].every(
        (v) => typeof v === "string" && TOKEN.test(v),
      )
    )
      return false;
    if (
      ![r.requestedModel, r.canonicalModel].every(
        (v) => typeof v === "string" && v.length <= 128 && MODEL_LABEL.test(v),
      )
    )
      return false;
    if (
      !Array.isArray(r.purposes) ||
      !r.purposes.length ||
      !r.purposes.every((p) => PURPOSES.includes(p)) ||
      new Set(r.purposes).size !== r.purposes.length
    )
      return false;
    if (!validDate(r.verifiedOn) || !validDate(r.expiresOn)) return false;
    if (r.expiresOn < r.verifiedOn) return false;
    if (!exactKeys(r.conditions, [...CONDITIONS])) return false;
    for (const c of CONDITIONS) {
      const e = r.conditions[c];
      if (
        !exactKeys(e, ["value", "confirmation", "evidence"]) ||
        typeof e.value !== "string" ||
        !VALUE.test(e.value) ||
        !CONFIRMATIONS.includes(e.confirmation) ||
        typeof e.evidence !== "string" ||
        !EVIDENCE.test(e.evidence)
      )
        return false;
    }
    // Ambiguity: one record per exact runtime + requested model.
    const key = `${r.runtime}\u0000${r.requestedModel}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

const deny = (reason) => ({ allow: false, reason });

/**
 * Decide whether a route may be used. Exact matching only (no wildcards or fallback).
 * @param {{ runtime?: string, requestedModel?: string, model?: string, purpose?: string }} route
 *   `runtime` is the canonical runtime ID. `model` is the canonical model when known (post-probe,
 *   launch); omit it before a probe. `purpose` omitted means "approved for at least one purpose"
 *   and is only valid for discovery, never for launch.
 * @param {{ root?: string, now?: Date }} [options]
 * @returns {{ allow: boolean, reason?: string }}
 */
export function evaluateRoute(route, { root = process.cwd(), now } = {}) {
  if (!isEnterpriseMode(root)) return { allow: true };
  if (route?.purpose !== undefined && !PURPOSES.includes(route.purpose))
    return deny(DENY_REASONS.PURPOSE);
  const loaded = loadAttestationRecord(root);
  if (!loaded.ok) return deny(DENY_REASONS.RECORD);
  const entry = loaded.record.routes.find(
    (r) =>
      r.runtime === route?.runtime &&
      r.requestedModel === route?.requestedModel,
  );
  if (!entry) return deny(DENY_REASONS.NOT_ATTESTED);
  if (route.purpose !== undefined && !entry.purposes.includes(route.purpose))
    return deny(DENY_REASONS.PURPOSE_NOT_APPROVED);
  if (route.model !== undefined && route.model !== entry.canonicalModel)
    return deny(DENY_REASONS.MODEL_MISMATCH);
  const today = (now ?? new Date()).toISOString().slice(0, 10);
  if (today > entry.expiresOn) return deny(DENY_REASONS.EXPIRED);
  if (today < entry.verifiedOn) return deny(DENY_REASONS.NOT_YET_VALID);
  for (const c of CONDITIONS) {
    const e = entry.conditions[c];
    if (e.confirmation === "unconfirmed") return deny(DENY_REASONS.UNCONFIRMED);
    if (e.confirmation === "machine-verified")
      return deny(DENY_REASONS.MACHINE_UNSUPPORTED);
    if (!loaded.record.acceptable[c].includes(e.value))
      return deny(DENY_REASONS.CONDITION);
  }
  return { allow: true };
}

/** True when the runtime has at least one currently valid attested route (gates catalog listing). */
export function runtimeHasApprovedRoute(runtime, options = {}) {
  const root = options.root ?? process.cwd();
  if (!isEnterpriseMode(root)) return true;
  const loaded = loadAttestationRecord(root);
  if (!loaded.ok) return false;
  return loaded.record.routes.some(
    (r) =>
      r.runtime === runtime &&
      evaluateRoute(
        { runtime, requestedModel: r.requestedModel },
        { ...options, root },
      ).allow,
  );
}
