import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadAssistedApproval, loadApprovedRouteEvidence } from "../../scripts/project-issue-triage-approval.mjs";
import { loadEvalDataset, runTriageEvaluation, createFakeTransport } from "../../scripts/project-issue-triage-eval.mjs";
import { RISKS, SIZES } from "../../scripts/project-issue-triage-contract.mjs";
import { applyTriageDecision } from "../../scripts/project-issue-roles.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const dataset = await loadEvalDataset();
const labels = new Map(dataset.cases.map((c) => [c.title, c.label]));
const choice = (options, selected) => ({ type: "choice", choice: selected, confidence: 1,
  probabilities: Object.fromEntries(options.map((o) => [o, Number(o === selected)])) });
const report = await runTriageEvaluation(dataset, {
  transportKind: "jev-live", now: Date.parse("2026-10-09T00:00:00Z"), clock: () => 0,
  transport: createFakeTransport((text) => {
    const label = labels.get(text.split("\n")[0]);
    return { risk: choice(RISKS, label.risk), size: choice(SIZES, label.size) };
  }),
});

test("approval binds explicit human attestation to measured bytes and the deployed classifier", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "triage-approval-"));
  const dir = path.join(cwd, "state/triage-eval");
  try {
    await fs.mkdir(dir, { recursive: true });
    const raw = JSON.stringify(report);
    await fs.writeFile(path.join(dir, "assisted-evaluation.json"), raw);
    assert.equal(await loadAssistedApproval(cwd, report.model), null);
    const approved = { evaluationSha256: digest(raw), labelsConfirmed: true,
      overrideCausesReviewed: true, decision: "approved", reviewedBy: "Product Owner",
      reviewedAt: "2026-10-10T00:00:00Z" };
    const save = (value) => fs.writeFile(path.join(dir, "assisted-approval.json"), JSON.stringify(value));
    await save(approved);
    assert.ok(await loadAssistedApproval(cwd, report.model));
    assert.deepEqual(await loadApprovedRouteEvidence(cwd, report.model), []);
    for (const change of [{ labelsConfirmed: false }, { decision: "pending" },
      { reviewedBy: "agent" }, { reviewedAt: "2026-10-08T00:00:00Z" },
      { evaluationSha256: "0".repeat(64) }, { unrecognized: true }]) {
      await save({ ...approved, ...change });
      assert.equal(await loadAssistedApproval(cwd, report.model), null);
    }
    const stale = JSON.stringify({ ...report, classifierFingerprint: "old" });
    await fs.writeFile(path.join(dir, "assisted-evaluation.json"), stale);
    await save({ ...approved, evaluationSha256: digest(stale) });
    assert.equal(await loadAssistedApproval(cwd, report.model), null);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test("adoption preserves conservative explicit inputs, dependency and scope counts", () => {
  const original = { number: 1, riskCategory: "critical", size: "XL", dependencies: [2], changeScopeCount: 4 };
  const adopted = applyTriageDecision(original, { action: "override", riskCategory: "low", size: "XS" });
  assert.equal(adopted.riskCategory, "critical");
  assert.equal(adopted.size, "XL");
  assert.deepEqual(adopted.dependencies, [2]);
  assert.equal(adopted.changeScopeCount, 4);
  assert.deepEqual(adopted.roleProgram, ["planner", "implementer", "reviewer"]);
  assert.deepEqual(original, { number: 1, riskCategory: "critical", size: "XL", dependencies: [2], changeScopeCount: 4 });
});
