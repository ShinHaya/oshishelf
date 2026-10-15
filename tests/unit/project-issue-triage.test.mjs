import test from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeTriageInput,
  normalizeTriageConfig,
  triageContext,
  parseDistribution,
  parseTriageDecision,
  fallbackResult,
  RISKS,
  SIZES,
  TRIAGE_POLICY, TRIAGE_RUBRIC_VERSION, TRIAGE_REVIEW_THRESHOLDS,
} from "../../scripts/project-issue-triage-contract.mjs";
import { evaluateTriage, JEV_ENDPOINT, RESPONSE_LIMIT, buildTriageRequest, triageClassifierFingerprint } from "../../scripts/project-issue-triage.mjs";
import {
  runTriageChild,
  createTriageState,
  createTriageRunner,
} from "../../scripts/project-issue-triage-client.mjs";
import { fetchTriageRevision } from "../../scripts/project-issue-github.mjs";
import { loadOrchestratorConfig, mergeOrchestratorConfig } from "../../scripts/project-issue-config.mjs";
import { spawnWorker } from "../../scripts/project-issue-runtime-adapters/shared.mjs";
import { parseCliArgs } from "../../scripts/project-issue-orchestrator.mjs";

const now = Date.parse("2026-09-27T00:00:00Z");
const input = {
  issue: 123,
  issueUpdatedAt: "2026-09-26T00:00:00Z",
  policyVersion: "triage-v3",
  model: "jev-1.13.0",
  routes: [
    { agent: "Codex", model: "fixture-a" },
    { agent: "Claude", model: "fixture-b" },
  ],
  routeEvidence: [],
};
const config = { mode: "shadow" };
const disclosure = {
  isPrivate: false,
  updatedAt: input.issueUpdatedAt,
  title: "Change fixture wording",
  body: "Update a local help message.",
};
const distribution = (options, choice) => ({
  type: "choice",
  choice,
  confidence: 1,
  probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? 1 : 0])),
});
const response = () => ({
  model: input.model,
  answers: { risk: distribution(RISKS, "low"), size: distribution(SIZES, "XS") },
  usage: { input_tokens: 30, output_tokens: 4 },
});
const dependencies = (overrides) => ({
  now,
  env: { TYPESAFE_API_KEY: "fake-test-key" },
  fetchIssue: async () => disclosure,
  fetchImpl: async () => Response.json(response()),
  ...overrides,
});
const fallback = (i, reason) => ({ result: fallbackResult(triageContext(i), reason), usage: "unavailable" });
async function temporary(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "triage-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("shadow sends only bounded issue text to fixed endpoint, projects structured output", async () => {
  let sent;
  const result = await evaluateTriage(
    input,
    config,
    dependencies({
      fetchImpl: async (url, request) => {
        sent = { url, ...request, body: JSON.parse(request.body) };
        return Response.json({ ...response(), rawText: "must never escape", secret: "fake-secret" });
      },
    }),
  );
  assert.equal(sent.url, JEV_ENDPOINT);
  assert.equal(sent.redirect, "error");
  assert.deepEqual(sent.body.state, { title: disclosure.title, body: disclosure.body });
  assert.deepEqual(Object.keys(sent.body.questions), ["risk", "size"]);
  assert.equal(result.result.status, "recommended");
  assert.equal(result.result.route.choice, "abstain");
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 4 });
  assert.doesNotMatch(JSON.stringify(result), /must never escape|fake-secret|help message/);
});

test("the previous policy cannot be sent under the new classifier", async () => {
  let fetched = false;
  await assert.rejects(evaluateTriage({ ...input, policyVersion: "triage-v1" }, config,
    dependencies({ fetchIssue: async () => { fetched = true; return disclosure; } })),
    /triage-invalid-structure/);
  assert.equal(fetched, false);
});

for (const [name, change, reason] of [
  ["private", { isPrivate: true }, "input-not-approved"],
  ["unknown visibility", { isPrivate: undefined }, "input-not-approved"],
  ["edited", { updatedAt: "2026-09-27T00:00:00Z" }, "stale-input"],
  ["empty", { body: " " }, "insufficient-context"],
  ["email", { body: "fake.person@example.invalid" }, "sensitive-input"],
  ["credential", { body: "password=fake-test-password" }, "sensitive-input"],
  ["phone", { body: "000-0000-0000" }, "sensitive-input"],
  ["oversized", { body: "文".repeat(9000) }, "input-too-large"],
])
  test(`preflight rejects ${name} without external request`, async () => {
    let sent = 0;
    const result = await evaluateTriage(
      input,
      config,
      dependencies({
        fetchIssue: async () => ({ ...disclosure, ...change }),
        fetchImpl: async () => {
          sent++;
          throw Error("unexpected");
        },
      }),
    );
    assert.equal(result.result.reason, reason);
    assert.equal(sent, 0);
  });

test("off, assisted and absent key avoid even the issue-text fetch", async () => {
  for (const [settings, env, reason] of [
    [{}, {}, "disabled"],
    [{ mode: "assisted" }, {}, "input-not-approved"],
    [config, {}, "missing-key"],
  ]) {
    let fetched = 0;
    const result = await evaluateTriage(
      input,
      settings,
      dependencies({
        env,
        fetchIssue: async () => {
          fetched++;
          return disclosure;
        },
      }),
    );
    assert.equal(result.result.reason, reason);
    assert.equal(fetched, 0);
  }
});

for (const [status, reason] of [
  [401, "auth-failed"],
  [403, "auth-failed"],
  [429, "rate-limited"],
  [529, "rate-limited"],
  [500, "provider-error"],
])
  test(`HTTP ${status} returns closed reason with no retries or error text`, async () => {
    let calls = 0;
    const result = await evaluateTriage(
      input,
      config,
      dependencies({
        fetchImpl: async () => {
          calls++;
          return new Response("private-error-body", { status });
        },
      }),
    );
    assert.equal(result.result.reason, reason);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /private-error-body/);
  });

test("malformed, excessive, model-mismatched and malformed-distribution responses fail closed", async () => {
  const bad = response();
  bad.answers.risk.probabilities.low = 0.2;
  for (const make of [
    () => new Response("bad JSON"),
    () => new Response("x".repeat(RESPONSE_LIMIT + 1)),
    () => Response.json({ ...response(), model: "jev-other" }),
    () => Response.json(bad),
  ]) {
    const result = await evaluateTriage(input, config, dependencies({ fetchImpl: async () => make() }));
    assert.equal(result.result.reason, "invalid-response");
  }
});

test("cancellation and request deadline abort transport, without retry", async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    // Keep the event loop live: AbortSignal.timeout's timer is unref'ed.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const result = await evaluateTriage(
        input,
        config,
        dependencies({
          signal: controller.signal,
          requestTimeoutMs: 10,
          fetchImpl: async (_url, { signal }) =>
            new Promise((resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              if (cancel) controller.abort();
            }),
        }),
      );
      assert.equal(result.result.reason, cancel ? "cancelled" : "timeout");
    } finally {
      clearInterval(keepAlive);
    }
  }
});

test("route comparison requires fresh comparable evidence, never names alone", async () => {
  const routeEvidence = input.routes.map((r) => ({
    ...r,
    profileVersion: "v1",
    benchmarkVersion: "suite1",
    evaluatedAt: "2026-09-26T00:00:00Z",
    tasks: [{ kind: "docs", samples: 10, passed: 9, medianDurationMs: 50 }],
  }));
  for (const [evidence, shouldAsk] of [
    [routeEvidence, true],
    [routeEvidence.slice(0, 1), false],
    [routeEvidence.map((e) => ({ ...e, evaluatedAt: "2026-01-01T00:00:00Z" })), false],
    [routeEvidence.map((e, i) => ({ ...e, benchmarkVersion: `suite${i}` })), false],
  ]) {
    let asked;
    const result = await evaluateTriage(
      { ...input, routeEvidence: evidence },
      config,
      dependencies({
        fetchImpl: async (_url, request) => {
          const question = JSON.parse(request.body).questions.route;
          asked = Boolean(question);
          const raw = response();
          if (question) raw.answers.route = distribution(Object.keys(question.criteria), "abstain");
          return Response.json(raw);
        },
      }),
    );
    assert.equal(asked, shouldAsk);
    assert.equal(result.result.route.choice, "abstain");
  }
});

test("low confidence or margin requires review; closed schemas reject injection", async () => {
  const raw = response();
  raw.answers.risk = {
    type: "choice",
    choice: "low",
    probabilities: { low: 0.5, medium: 0.4, high: 0.1, critical: 0 },
    confidence: 0.9,
  };
  const result = await evaluateTriage(
    input,
    config,
    dependencies({ fetchImpl: async () => Response.json(raw) }),
  );
  assert.equal(result.result.disposition, "review-required");
  assert.throws(() => normalizeTriageInput({ ...input, body: "forbidden" }));
  assert.throws(() => normalizeTriageConfig({ endpoint: "https://example.invalid" }));
  assert.throws(() => normalizeTriageConfig({ model: "jev-latest" }));
  assert.throws(() => normalizeTriageConfig({ maxRequests: 21 }));
  assert.throws(() => parseDistribution({ ...distribution(RISKS, "low"), choice: "high" }, RISKS));
  const context = triageContext(input);
  const { status, reason, ...metadata } = fallbackResult(context, "disabled");
  assert.equal(
    parseTriageDecision(
      { ...metadata, action: "override", reason: "domain-review", riskCategory: "high", size: "S" },
      context,
    ).size,
    "S",
  );
  assert.throws(() =>
    parseTriageDecision(
      {
        ...metadata,
        action: "override",
        reason: "domain-review",
        riskCategory: "high",
        size: "S",
        explanation: "unbounded",
      },
      context,
    ),
  );
});

test("durable reservation precedes execution, is serialized, and survives restart", async (t) => {
  const dir = await temporary(t);
  const stateFile = path.join(dir, "state.json");
  let calls = 0;
  const persistState = (value) => writeFile(stateFile, JSON.stringify(value));
  const execute = async (i) => {
    calls++;
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).reserved, calls);
    return fallback(i, "timeout");
  };
  const runner = createTriageRunner({
    runId: "run-1",
    state: createTriageState("run-1"),
    persistState,
    execute,
  });
  const results = await Promise.all(
    Array.from({ length: 3 }, () => runner.run(input, { ...config, maxRequests: 2 })),
  );
  assert.deepEqual(
    results.map((r) => r.result.reason),
    ["timeout", "timeout", "budget-exhausted"],
  );
  const resumed = createTriageRunner({
    runId: "run-1",
    state: JSON.parse(await readFile(stateFile, "utf8")),
    persistState,
    execute,
  });
  assert.equal((await resumed.run(input, { ...config, maxRequests: 2 })).result.reason, "budget-exhausted");
  assert.equal(calls, 2);
});

test("failed reservation prevents egress; auth and throttling disable the whole run", async () => {
  for (const reason of ["auth-failed", "rate-limited"]) {
    let saved;
    let calls = 0;
    const runner = createTriageRunner({
      runId: "r",
      state: createTriageState("r"),
      persistState: async (s) => {
        saved = s;
      },
      execute: async (i) => {
        calls++;
        return fallback(i, reason);
      },
    });
    assert.equal((await runner.run(input, config)).result.reason, reason);
    assert.equal((await runner.run(input, config)).result.reason, "provider-unavailable");
    assert.equal(saved.providerUnavailable, true);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const runner = createTriageRunner({
    runId: "r",
    state: createTriageState("r"),
    persistState: async () => {
      throw Error("disk full");
    },
    execute: async (i) => {
      calls++;
      return fallback(i, "timeout");
    },
  });
  assert.equal((await runner.run(input, config)).result.reason, "provider-unavailable");
  assert.equal(calls, 0);
});

test("real child returns metadata only without credentials and supports timeout", async () => {
  const result = await runTriageChild(input, config, { env: {} });
  assert.equal(result.result.reason, "missing-key");
  const timed = await runTriageChild(input, config, { env: {}, timeoutMs: 1 });
  assert.equal(timed.result.reason, "timeout");
});

test("metadata read excludes title/body and treats unavailable revision as null", async () => {
  let query;
  const result = await fetchTriageRevision(123, { repository: "example-org/example-repo",
    graphql: async (q) => {
      query = q;
      return { repository: { issue: { updatedAt: input.issueUpdatedAt } } };
    },
  });
  assert.deepEqual(result, { updatedAt: input.issueUpdatedAt });
  assert.doesNotMatch(query, /\b(body|title)\b/);
  assert.equal(
    await fetchTriageRevision(123, { repository: "example-org/example-repo",
      graphql: async () => {
        throw Error("private error");
      },
    }),
    null,
  );
});

test("YAML triage defaults and CLI mode override preserve pinned model and budget", async (t) => {
  const dir = await temporary(t);
  await writeFile(
    path.join(dir, "config.yaml"),
    `project:\n  owner: example-org\n  ownerType: organization\n  name: Fixture\nrun:\n  maxParallel: 1\n  releasePolicy: merged\n  unavailableModels: none\n  triage:\n    mode: shadow\n    model: jev-1.13.0\n    maxRequests: 3\n`,
  );
  const yaml = await loadOrchestratorConfig("config.yaml", { cwd: dir });
  const cli = parseCliArgs(["--triage", "off"]);
  assert.deepEqual(mergeOrchestratorConfig({ yaml, cli }).triage, {
    mode: "off",
    model: "jev-1.13.0",
    maxRequests: 3,
  });
  assert.equal(normalizeTriageConfig().mode, "off");
  assert.throws(() => parseCliArgs(["--triage", "anything"]));
});

test("ordinary worker process never inherits Jev credential", async (t) => {
  const dir = await temporary(t);
  const output = path.join(dir, "env.json");
  const env = { ...process.env, TYPESAFE_API_KEY: "fake-test-key" };
  const worker = spawnWorker(
    process.execPath,
    [
      "-e",
      'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({hasKey:Object.hasOwn(process.env,"TYPESAFE_API_KEY")}))',
      output,
    ],
    { env, timeoutMs: 5000 },
  );
  t.after(() => worker.kill());
  assert.equal((await worker.wait()).code, 0);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { hasKey: false });
  assert.equal(env.TYPESAFE_API_KEY, "fake-test-key");
});

test("real child fetch keeps private body and gh stderr out of parent", async (t) => {
  const dir = await temporary(t);
  const gh = path.join(dir, "gh");
  const payload = JSON.stringify({
    data: {
      repository: {
        isPrivate: true,
        issue: {
          title: "fake-private-title",
          body: "fake-private-body",
          updatedAt: input.issueUpdatedAt,
        },
      },
    },
  });
  await writeFile(
    gh,
    `#!${process.execPath}\nif (process.env.TYPESAFE_API_KEY) process.exit(9); process.stderr.write("fake-private-error"); process.stdout.write(${JSON.stringify(payload)});\n`,
    { mode: 0o700 },
  );
  const result = await runTriageChild(input, config, {
    env: { PATH: dir, TYPESAFE_API_KEY: "fake-test-key", GITHUB_REPOSITORY: "example-org/example-repo" },
  });
  assert.equal(result.result.reason, "input-not-approved");
  assert.doesNotMatch(JSON.stringify(result), /fake-private|fake-test-key/);
});

test("new run has its own budget while off and cancelled calls reserve nothing", async () => {
  const runner = createTriageRunner({
    runId: "new",
    state: createTriageState("new"),
    persistState: async () => {},
    execute: async (i) => fallback(i, "timeout"),
  });
  assert.equal((await runner.run(input, {})).result.reason, "disabled");
  assert.equal((await runner.run(input, config, { signal: AbortSignal.abort() })).result.reason, "cancelled");
  assert.equal(runner.snapshot().reserved, 0);
  assert.equal((await runner.run(input, config)).result.reason, "timeout");
  assert.equal(runner.snapshot().reserved, 1);
  assert.throws(() =>
    createTriageRunner({ runId: "other", state: runner.snapshot(), persistState: async () => {} }),
  );
});

test("provider cannot add answer keys or nominate a route outside the current pool", async () => {
  const routeEvidence = input.routes.map((r) => ({
    ...r,
    profileVersion: "v1",
    benchmarkVersion: "suite1",
    evaluatedAt: "2026-09-26T00:00:00Z",
    tasks: [{ kind: "docs", samples: 10, passed: 9, medianDurationMs: 50 }],
  }));
  for (const mutate of [
    (raw) => {
      raw.answers.route = distribution(["r0", "r1", "abstain"], "unavailable-model");
    },
    (raw) => {
      raw.answers.unbounded = "fake-sensitive-response";
    },
    (raw) => {
      raw.answers.risk.type = "noul";
    },
    (raw) => {
      raw.answers.size.confidence = 2;
    },
  ]) {
    const result = await evaluateTriage(
      { ...input, routeEvidence },
      config,
      dependencies({
        fetchImpl: async () => {
          const raw = response();
          raw.answers.route = distribution(["r0", "r1", "abstain"], "abstain");
          mutate(raw);
          return Response.json(raw);
        },
      }),
    );
    assert.equal(result.result.reason, "invalid-response");
    assert.doesNotMatch(JSON.stringify(result), /fake-sensitive-response|unavailable-model/);
  }
});

test("route pool excludes unevaluated models and incompatible task coverage", async () => {
  const routeEvidence = input.routes.map((r) => ({
    ...r,
    profileVersion: "v1",
    benchmarkVersion: "suite1",
    evaluatedAt: "2026-09-26T00:00:00Z",
    tasks: [{ kind: "docs", samples: 10, passed: 9, medianDurationMs: 50 }],
  }));
  const extended = normalizeTriageInput({
    ...input,
    routes: [...input.routes, { agent: "Grok", model: "no-evidence" }],
    routeEvidence,
  });
  const context = triageContext(extended, now);
  assert.equal(Object.keys(context.routeMap).length, 2);
  assert.ok(Object.values(context.routeMap).every((r) => r.agent !== "Grok"));
  extended.routeEvidence[0].tasks[0].kind = "security";
  assert.deepEqual(triageContext(extended, now).routeMap, {});
});

test("accept requires the corresponding usable result and cannot silently override it", async () => {
  const normalized = normalizeTriageInput(input);
  const context = triageContext(normalized, now);
  const { status, reason, ...metadata } = fallbackResult(context, "disabled");
  const decision = { ...metadata, action: "accept", reason: "accepted" };
  const { result } = await evaluateTriage(normalized, config, dependencies());
  assert.equal(parseTriageDecision(decision, context, result).riskCategory, "low");
  assert.throws(() => parseTriageDecision(decision, context));
  assert.throws(() => parseTriageDecision(decision, context, fallbackResult(context, "missing-key")));
  assert.throws(() => parseTriageDecision({ ...decision, riskCategory: "high" }, context, result));
  const uncertain = structuredClone(result);
  uncertain.risk.confidence = 0.1;
  assert.throws(() => parseTriageDecision(decision, context, uncertain));
  assert.throws(() =>
    parseTriageDecision({ ...decision, action: "fallback", reason: "legacy-fallback", size: "S" }, context),
  );
  assert.equal(
    parseTriageDecision(
      { ...decision, action: "override", reason: "domain-review", riskCategory: "high", size: "M" },
      context,
    ).riskCategory,
    "high",
  );
});

test("risk and size may be accepted while uncertain route adoption is refused", async () => {
  const routeEvidence = input.routes.map((r) => ({
    ...r,
    profileVersion: "v1",
    benchmarkVersion: "suite1",
    evaluatedAt: "2026-09-26T00:00:00Z",
    tasks: [{ kind: "docs", samples: 10, passed: 9, medianDurationMs: 50 }],
  }));
  const normalized = normalizeTriageInput({ ...input, routeEvidence });
  const context = triageContext(normalized, now);
  const raw = response();
  raw.answers.route = { ...distribution(["r0", "r1", "abstain"], "r0"), confidence: 0.1 };
  const { result } = await evaluateTriage(
    normalized,
    config,
    dependencies({ fetchImpl: async () => Response.json(raw) }),
  );
  const { status, reason, ...metadata } = fallbackResult(context, "disabled");
  const decision = { ...metadata, action: "accept", reason: "accepted" };
  assert.equal(parseTriageDecision(decision, context, result).preferredRoute, undefined);
  assert.throws(() =>
    parseTriageDecision({ ...decision, preferredRoute: context.routeMap.r0 }, context, result),
  );
  const confident = structuredClone(result);
  confident.route.confidence = 1;
  assert.deepEqual(
    parseTriageDecision({ ...decision, preferredRoute: context.routeMap.r0 }, context, confident)
      .preferredRoute,
    context.routeMap.r0,
  );
});

test("actual CLI applies triage mode override to effective run configuration", async (t) => {
  const dir = await temporary(t);
  await writeFile(path.join(dir, "git"), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  const configPath = path.join(dir, "config.yaml");
  await writeFile(
    configPath,
    `project:\n  owner: example-org\n  ownerType: organization\n  name: Fixture\nrun:\n  maxParallel: 1\n  releasePolicy: merged\n  unavailableModels: none\n  triage:\n    mode: shadow\n    maxRequests: 3\n`,
  );
  const inputPath = path.join(dir, "input.json");
  const route = (agent, role) => ({
    agent,
    role,
    model: "fixture",
    selector: "fixture",
    selectable: true,
    verifiable: true,
    timeoutMs: 1000,
  });
  await writeFile(
    inputPath,
    JSON.stringify({
      items: [
        {
          number: 123,
          title: "Fixture",
          url: "https://example.invalid/issues/123",
          status: "Ready",
          priority: "P2",
          dependencies: [],
        },
      ],
      options: {
        parent: { agent: "Codex", model: "fixture" },
        capabilities: [route("Codex", "parent"), route("Claude", "worker")],
      },
    }),
  );
  const script = new URL("../../scripts/project-issue-orchestrator.mjs", import.meta.url);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      script.pathname,
      "--input",
      inputPath,
      "--issues",
      "123",
      "--config",
      configPath,
      "--triage",
      "off",
      "--dry-run",
    ],
    { env: { ...process.env, PATH: dir } },
  );
  assert.deepEqual(JSON.parse(stdout).triage, { mode: "off", model: "jev-1.13.0", maxRequests: 3 });
});

test("classic dry-run with shadow triage fetches no Issue text and never contacts Jev", async (t) => {
  const dir = await temporary(t);
  const log = path.join(dir, "egress.log");
  await writeFile(log, "");
  await writeFile(path.join(dir, "git"), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  // Any GitHub CLI call (title/body fetch) is recorded and fails.
  await writeFile(
    path.join(dir, "gh"),
    `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, "gh\\n");\nprocess.exit(1);\n`,
    { mode: 0o700 },
  );
  // NODE_OPTIONS also reaches any triage child, so a Jev or GraphQL request is recorded too.
  const recorder = path.join(dir, "record-fetch.mjs");
  await writeFile(
    recorder,
    `import { appendFileSync } from "node:fs";\nglobalThis.fetch = async () => { appendFileSync(${JSON.stringify(log)}, "fetch\\n"); throw new Error("egress-disabled"); };\n`,
  );
  const configPath = path.join(dir, "config.yaml");
  await writeFile(
    configPath,
    `project:\n  owner: example-org\n  ownerType: organization\n  name: Fixture\nrun:\n  maxParallel: 1\n  releasePolicy: merged\n  unavailableModels: none\n`,
  );
  const inputPath = path.join(dir, "input.json");
  const route = (agent, role) => ({
    agent,
    role,
    model: "fixture",
    selector: "fixture",
    selectable: true,
    verifiable: true,
    timeoutMs: 1000,
  });
  await writeFile(
    inputPath,
    JSON.stringify({
      items: [
        {
          number: 123,
          title: "Fixture",
          url: "https://example.invalid/issues/123",
          status: "Ready",
          priority: "P2",
          dependencies: [],
        },
      ],
      options: {
        parent: { agent: "Codex", model: "fixture" },
        capabilities: [route("Codex", "parent"), route("Claude", "worker")],
      },
    }),
  );
  const marker = "FAKE_TRIAGE_KEY_MARKER";
  const script = new URL("../../scripts/project-issue-orchestrator.mjs", import.meta.url);
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [script.pathname, "--input", inputPath, "--issues", "123", "--config", configPath, "--triage", "shadow", "--dry-run"],
    {
      env: {
        ...process.env,
        PATH: dir,
        NODE_OPTIONS: `--import ${new URL(`file://${recorder}`).href}`,
        TYPESAFE_API_KEY: marker,
      },
    },
  );
  assert.equal(JSON.parse(stdout).triage.mode, "shadow");
  assert.equal(await readFile(log, "utf8"), "");
  assert.equal(`${stdout}${stderr}`.includes(marker), false);
});


test("classifier approval fingerprint includes route instructions and abstention criteria", () => {
  const { questions } = buildTriageRequest({}, { routeMap: {
    candidate: { agent: "fixture", model: "fixture" },
  }, evidence: [] }, {});
  const fingerprint = () => createHash("sha256").update(JSON.stringify({
    policy: TRIAGE_POLICY, rubric: TRIAGE_RUBRIC_VERSION,
    thresholds: TRIAGE_REVIEW_THRESHOLDS, questions,
  })).digest("hex");
  assert.ok(questions.route);
  assert.equal(fingerprint(), triageClassifierFingerprint());
  questions.route.instructions += " changed policy";
  assert.notEqual(fingerprint(), triageClassifierFingerprint());
  questions.route.instructions = buildTriageRequest({}, { routeMap: {
    candidate: { agent: "fixture", model: "fixture" },
  }, evidence: [] }, {}).questions.route.instructions;
  questions.route.criteria.abstain = "changed abstention";
  assert.notEqual(fingerprint(), triageClassifierFingerprint());
});

test("explicit private opt-in classifies fictional private Issue text inside the isolated boundary", async () => {
  let sent;
  const result = await evaluateTriage(input, { ...config, allowPrivateIssues: true }, dependencies({
    fetchIssue: async () => ({ ...disclosure, isPrivate: true }),
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify(response()), { status: 200 });
    },
  }));
  assert.deepEqual(sent.state, { title: disclosure.title, body: disclosure.body });
  assert.equal(result.result.status, "recommended");
  assert.doesNotMatch(JSON.stringify(result), /Change fixture wording|Update a local help message|fake-secret/);
});

for (const [name, change, reason] of [
  ["unknown visibility", { isPrivate: undefined }, "input-not-approved"],
  ["changed revision", { updatedAt: "2026-09-27T00:00:00Z" }, "stale-input"],
  ["password", { body: '"password": "fake-private-password"' }, "sensitive-input"],
  ["OTP", { body: "OTP=123456" }, "sensitive-input"],
  ["CVV", { body: "CVV=123" }, "sensitive-input"],
  ["token", { body: "token=fake-private-token" }, "sensitive-input"],
  ["personal email", { body: "fake.person@example.invalid" }, "sensitive-input"],
  ["oversized", { body: "文".repeat(9000) }, "input-too-large"],
]) test(`private opt-in does not bypass ${name}`, async () => {
  let sent = 0;
  const result = await evaluateTriage(input, { ...config, allowPrivateIssues: true }, dependencies({
    fetchIssue: async () => ({ ...disclosure, isPrivate: true, ...change }),
    fetchImpl: async () => { sent++; throw new Error("unexpected"); },
  }));
  assert.equal(result.result.reason, reason);
  assert.equal(sent, 0);
});

test("private input consent is a boolean, not a truthy string or Issue text instruction", () => {
  for (const value of ["true", 1, {}, null])
    assert.throws(() => normalizeTriageConfig({ ...config, allowPrivateIssues: value }), /triage-invalid-structure/);
  assert.equal(normalizeTriageConfig({ ...config, allowPrivateIssues: false }).allowPrivateIssues, false);
});
