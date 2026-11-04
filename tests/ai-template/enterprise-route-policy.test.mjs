import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ENTERPRISE_RECORD_PATH,
  evaluateRoute,
  runtimeHasApprovedRoute,
} from "../../scripts/enterprise-route-policy.mjs";
import {
  loadOrRefreshCapabilities,
  verifyWorkerRoute,
} from "../../scripts/issue-capabilities.mjs";
import { PROBE_SCHEMA_VERSION } from "../../scripts/issue-runtime-adapters/shared.mjs";
import { fetchRuntimeCatalog } from "../../scripts/issue-runtime-adapters/catalog.mjs";
import { isDisallowedModelRoute } from "../../scripts/issue-runtime-adapters/shared.mjs";
import { launchWithAdapter } from "../../scripts/issue-runtime-adapters/index.mjs";
import { loadRuntimeRegistry } from "../../scripts/ai-template/registry.mjs";

const source = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const NOW = new Date("2026-06-15T00:00:00Z");
const cond = (value, confirmation = "self-declared") => ({
  value,
  confirmation,
  evidence: "fake-ticket-1",
});
const route = (over = {}) => ({
  runtime: "claude",
  provider: "fake-provider",
  requestedModel: "sonnet",
  canonicalModel: "fake-sonnet-1",
  purposes: ["implementer"],
  verifiedOn: "2026-06-01",
  expiresOn: "2026-07-01",
  conditions: {
    trainingOptOut: cond("opted-out"),
    retention: cond("zero"),
    externalTransmission: cond("provider-only"),
    telemetry: cond("disabled"),
  },
  ...over,
});
const record = (routes = [route()]) => ({
  version: 1,
  acceptable: {
    trainingOptOut: ["opted-out"],
    retention: ["zero"],
    externalTransmission: ["provider-only"],
    telemetry: ["disabled"],
  },
  routes,
});
/**
 * @param {any} t
 * @param {{ enterprise?: boolean, rec?: unknown }} [options]
 */
function fixture(t, { enterprise = true, rec } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(source, "agents"), path.join(root, "agents"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, ".ai-template"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".ai-template/config.json"),
    JSON.stringify({
      agents: { enabled: ["claude"] },
      ...(enterprise ? { enterprise: { routeAttestation: true } } : {}),
    }),
  );
  if (rec !== undefined) {
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ENTERPRISE_RECORD_PATH),
      typeof rec === "string" ? rec : JSON.stringify(rec),
    );
  }
  return root;
}
const ask = (root, over = {}) =>
  evaluateRoute(
    {
      runtime: "claude",
      requestedModel: "sonnet",
      model: "fake-sonnet-1",
      purpose: "implementer",
      ...over,
    },
    { root, now: NOW },
  );

test("mode off allows everything and needs no record", (t) => {
  const root = fixture(t, { enterprise: false });
  assert.deepEqual(ask(root, { purpose: undefined }), { allow: true });
});

test("valid exact attestation is allowed", (t) => {
  const root = fixture(t, { rec: record() });
  assert.deepEqual(ask(root), { allow: true });
  assert.equal(runtimeHasApprovedRoute("claude", { root, now: NOW }), true);
  assert.equal(runtimeHasApprovedRoute("codex", { root, now: NOW }), false);
});

test("missing, malformed, unknown-version and ambiguous records fail closed", (t) => {
  for (const rec of [
    undefined,
    "{not json",
    { ...record(), version: 2 },
    { ...record(), extra: 1 },
    record([route(), route()]),
    record([route({ expiresOn: "2026-02-30" })]),
  ])
    assert.equal(ask(fixture(t, { rec })).reason, "enterprise-record-invalid");
});

test("identity, purpose and canonical model must match exactly", (t) => {
  const root = fixture(t, { rec: record() });
  assert.equal(
    ask(root, { requestedModel: "son*" }).reason,
    "enterprise-route-not-attested",
  );
  assert.equal(
    ask(root, { runtime: "codex" }).reason,
    "enterprise-route-not-attested",
  );
  assert.equal(
    ask(root, { purpose: "reviewer" }).reason,
    "enterprise-purpose-not-approved",
  );
  assert.equal(
    ask(root, { purpose: "nonsense" }).reason,
    "enterprise-purpose-missing",
  );
  assert.equal(
    ask(root, { model: "other" }).reason,
    "enterprise-model-mismatch",
  );
});

test("expiry, future dates and each condition are enforced independently", (t) => {
  const root = fixture(t, { rec: record() });
  const at = (date) =>
    evaluateRoute(
      {
        runtime: "claude",
        requestedModel: "sonnet",
        purpose: "implementer",
      },
      { root, now: new Date(date) },
    ).reason;
  assert.equal(at("2026-07-02T00:00:00Z"), "enterprise-attestation-expired");
  assert.equal(
    at("2026-05-31T00:00:00Z"),
    "enterprise-attestation-future-dated",
  );
  for (const name of [
    "trainingOptOut",
    "retention",
    "externalTransmission",
    "telemetry",
  ]) {
    const mk = (c) => {
      const r = route();
      r.conditions[name] = c;
      return fixture(t, { rec: record([r]) });
    };
    assert.equal(
      ask(mk(cond("other"))).reason,
      "enterprise-condition-not-acceptable",
    );
    assert.equal(
      ask(mk(cond(record().acceptable[name][0], "unconfirmed"))).reason,
      "enterprise-condition-unconfirmed",
    );
    assert.equal(
      ask(mk(cond(record().acceptable[name][0], "machine-verified"))).reason,
      "enterprise-machine-verification-unsupported",
    );
  }
});

test("record edits take effect on the next evaluation", (t) => {
  const root = fixture(t, { rec: record() });
  assert.equal(ask(root).allow, true);
  fs.writeFileSync(
    path.join(root, ENTERPRISE_RECORD_PATH),
    JSON.stringify(record([route({ expiresOn: "2026-06-10" })])),
  );
  assert.equal(ask(root).reason, "enterprise-attestation-expired");
});

test("unattested runtime: catalog listing makes zero process calls", async (t) => {
  const root = fixture(t, { rec: record([route({ runtime: "codex" })]) });
  const calls = [];
  const definition = loadRuntimeRegistry(root).enabled[0];
  const listing = await fetchRuntimeCatalog(definition, {
    cwd: root,
    resolveExecutable: async (n) => (calls.push(n), `/fake/${n}`),
    runProcess: async (...a) => (calls.push(a), { code: 0, stdout: "" }),
  });
  assert.equal(listing.status, "failed");
  assert.equal(listing.reason, "enterprise-route-denied");
  assert.deepEqual(calls, []);
});

test("route guard and launch reject unattested routes and missing purpose", async (t) => {
  const root = fixture(t, {
    rec: record([route({ expiresOn: "2099-12-31" })]),
  });
  const live = {
    agent: "claude",
    model: "fake-sonnet-1",
    requestedModel: "sonnet",
  };
  assert.equal(isDisallowedModelRoute(live, root), false);
  assert.equal(
    isDisallowedModelRoute({ ...live, requestedModel: "opus" }, root),
    true,
  );
  let spawned = 0;
  const job = {
    ...live,
    selector: "/fake/claude --model sonnet",
    cwd: root,
    timeoutMs: 1000,
  };
  const ctx = {
    cwd: root,
    spawnWorker: async () => (spawned++, { wait: async () => ({}) }),
    resolveExecutable: async (n) => n,
  };
  // No `purpose`: denied before spawn.
  await assert.rejects(launchWithAdapter("claude", job, ctx), /enterprise/);
  await assert.rejects(
    launchWithAdapter("claude", { ...job, purpose: "reviewer" }, ctx),
    /enterprise/,
  );
  assert.equal(spawned, 0);
});

test("display-name model labels with spaces can be attested", (t) => {
  const root = fixture(t, {
    rec: record([
      route({
        runtime: "codex",
        requestedModel: "GPT Test",
        canonicalModel: "GPT Test",
      }),
    ]),
  });
  assert.deepEqual(
    ask(root, {
      runtime: "codex",
      requestedModel: "GPT Test",
      model: "GPT Test",
    }),
    { allow: true },
  );
  assert.equal(
    ask(root, {
      runtime: "codex",
      requestedModel: "GPT  Test",
      model: "GPT Test",
    }).allow,
    false,
  );
});

test("an invalid enterprise config shape is not treated as mode off", (t) => {
  const root = fixture(t, { enterprise: false });
  fs.writeFileSync(
    path.join(root, ".ai-template/config.json"),
    JSON.stringify({ enterprise: { routeAttestation: "true" } }),
  );
  assert.equal(ask(root).allow, false);
});

test("benchmark runs are denied before any process in enterprise mode", async (t) => {
  const { runBenchmarkTask } =
    await import("../../scripts/issue-route-benchmark.mjs");
  const root = fixture(t, { rec: record() });
  let calls = 0;
  const run = async () => {
    calls++;
    return { code: 0 };
  };
  const task = { kind: "fix", files: {}, instruction: "x" };
  await assert.rejects(
    runBenchmarkTask(
      {
        agent: "claude",
        model: "fake-sonnet-1",
        requestedModel: "sonnet",
        selector: "claude --model sonnet",
      },
      task,
      { run, cwd: root },
    ),
    /route-benchmark-enterprise-denied/,
  );
  assert.equal(calls, 0);
});

test("a persisted capability cache is reused while attested, then rejected after revocation without any process", async (t) => {
  const root = fixture(t, {
    rec: record([route({ expiresOn: "2099-12-31" })]),
  });
  const registry = loadRuntimeRegistry(root);
  const cachePath = path.join(root, "state/issue-capabilities.json");
  const live = {
    agent: "claude",
    model: "fake-sonnet-1",
    requestedModel: "sonnet",
    role: "implementer",
    selector: "/fake/claude --model sonnet",
    timeoutMs: 1000,
    selectable: true,
    verifiable: true,
  };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      probeSchemaVersion: PROBE_SCHEMA_VERSION,
      runtimeFingerprint: registry.fingerprint,
      probedAt: new Date().toISOString(),
      capabilities: [live],
      diagnostics: [],
      cli: {},
    }),
  );
  let processes = 0;
  const options = {
    cwd: root,
    cachePath,
    catalogPath: path.join(root, "state/model-catalog.json"),
    runProcess: async () => (processes++, { code: 1, stdout: "", stderr: "" }),
    resolveExecutable: async () => {
      processes++;
      return null;
    },
    dryRun: true,
  };
  const reused = await loadOrRefreshCapabilities(options);
  assert.equal(reused.reused, true);
  assert.equal(reused.capabilities.length, 1);
  // Revoke: the attestation expires (record edited on disk).
  fs.writeFileSync(
    path.join(root, ENTERPRISE_RECORD_PATH),
    JSON.stringify(record([route({ expiresOn: "2020-01-01" })])),
  );
  processes = 0;
  const revoked = await loadOrRefreshCapabilities(options);
  assert.notEqual(revoked.reused, true);
  assert.deepEqual(revoked.capabilities, []);
  assert.equal(processes, 0);
  assert.deepEqual(await verifyWorkerRoute(live, { cwd: root }), {
    ok: false,
    reason: "model-not-allowed",
  });
  assert.equal(processes, 0);
});
