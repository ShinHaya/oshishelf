import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { computeTriageMetrics, assessAssistedGate } from "./project-issue-triage-eval.mjs";
import { normalizeRouteEvidence, validTimestamp } from "./project-issue-triage-contract.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Local, explicit PO attestation bound to the exact measured artifacts. Never self-approves. */
export async function loadAssistedApproval(cwd, model) {
  try {
    const raw = await fs.readFile(path.resolve(cwd, "state/triage-eval/assisted-evaluation.json"));
    const report = JSON.parse(raw);
    const approval = JSON.parse(await fs.readFile(path.resolve(cwd, "state/triage-eval/assisted-approval.json"), "utf8"));
    const allowed = ["evaluationSha256", "routeEvidenceSha256", "labelsConfirmed", "overrideCausesReviewed", "decision", "reviewedBy", "reviewedAt"];
    if (!approval || Object.keys(approval).some((k) => !allowed.includes(k)) ||
        approval.evaluationSha256 !== digest(raw) || approval.decision !== "approved" ||
        approval.labelsConfirmed !== true || approval.overrideCausesReviewed !== true ||
        approval.reviewedBy !== "Product Owner" || !validTimestamp(approval.reviewedAt) ||
        !validTimestamp(report.evaluatedAt) || Date.parse(approval.reviewedAt) < Date.parse(report.evaluatedAt) ||
        Date.parse(approval.reviewedAt) > Date.now() || report.model !== model)
      return null;
    const gate = assessAssistedGate(report, computeTriageMetrics(report));
    const human = new Set(["labels-human-confirmed", "override-causes-reviewed", "product-owner-decision"]);
    if (gate.conditions.some((c) => !human.has(c.id) && c.status !== "met")) return null;
    return { approval, report };
  } catch {
    return null;
  }
}

/** Only the reviewed evidence artifact may propose routes; availability is checked elsewhere. */
export async function loadApprovedRouteEvidence(cwd, model) {
  const accepted = await loadAssistedApproval(cwd, model);
  if (!accepted) return [];
  try {
    const raw = await fs.readFile(path.resolve(cwd, "state/route-evidence.json"));
    if (accepted.approval.routeEvidenceSha256 !== digest(raw)) return [];
    const evidence = JSON.parse(raw);
    if (!Array.isArray(evidence) || evidence.length > 256) return [];
    return evidence.map(normalizeRouteEvidence);
  } catch {
    return [];
  }
}
