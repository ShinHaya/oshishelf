import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findRuntime,
  loadRuntimeRegistry,
} from "../../scripts/ai-template/registry.mjs";
import { createDefaultDeps } from "../../scripts/issue-graph.mjs";
import {
  readParentUsage,
  decideParentWorker,
} from "../../scripts/issue-parent-usage.mjs";

const fetchedAt = "2026-10-18T00:00:00.000Z";
const now = () => fetchedAt;
async function fixture(t, transport = "exec-json") {
  const cwd = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "usage-registry-")),
  );
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, ".ai-template/runtimes"), { recursive: true });
  const cli = path.join(cwd, "quota cli.mjs");
  const usage = {
    transport,
    command: [process.execPath, cli],
    windows: "$.quota.buckets | $.legacy",
    usedPercent: "used",
    windowDurationMins: "minutes",
    blocked: ["$.allowed == false", "blocked != null"],
    ...(transport !== "exec-json"
      ? {
          initialize: { method: "hello", params: {} },
          ...(transport === "jsonrpc-stdio" ? { initialized: "ready" } : {}),
          request: { method: "quota", params: {} },
        }
      : {}),
  };
  const runtime = {
    ...findRuntime("codex"),
    id: "fixture",
    name: "Fixture",
    aliases: ["fixture-alias"],
    commands: ["fixture-cli"],
    usage,
  };
  const runtimePath = path.join(cwd, ".ai-template/runtimes/fixture.json");
  const save = () => fs.writeFile(runtimePath, JSON.stringify(runtime));
  const configure = (enabled) =>
    fs.writeFile(
      path.join(cwd, ".ai-template/config.json"),
      JSON.stringify({ agents: { enabled } }),
    );
  await save();
  await configure(["fixture"]);
  const respond = async (raw) => {
    const payload = JSON.stringify(raw);
    await fs.writeFile(
      cli,
      transport === "exec-json"
        ? `console.log(${JSON.stringify(payload)})`
        : `
      import readline from 'node:readline';
      let ready = false;
      readline.createInterface({input:process.stdin}).on('line', line => {
        const wire = JSON.parse(line);
        const m = wire.type === 'control_request' ? {method:wire.request.subtype,id:Number(wire.request_id)} : wire;
        const reply = value => console.log(JSON.stringify(wire.type === 'control_request'
          ? {type:'control_response',response:{request_id:wire.request_id,subtype:'success',response:value}}
          : {id:m.id,result:value}));
        if(wire.type === 'control_request' && m.method === 'hello') {ready=true;reply({});return;}
        if(wire.type === 'control_request' && m.method === 'quota') {reply(${payload});return;}
        if(m.method==='hello') console.log(JSON.stringify({id:m.id,result:{}}));
        if(m.method==='ready') ready = true;
        if(m.method==='quota') console.log(JSON.stringify(ready ? {id:m.id,result:${payload}} : {id:m.id,error:{}}));
      });`,
    );
  };
  return { cwd, cli, runtime, save, configure, respond };
}
const response = (used) => ({
  secret: "fixture-account-plan-token",
  allowed: true,
  quota: {
    buckets: {
      weekly: { used: 0, minutes: 10080 },
      hourly: { used, minutes: 300 },
      blocked: null,
    },
  },
});

for (const transport of ["exec-json", "jsonrpc-stdio", "control-stdio"]) {
  test(`${transport}: declaration alone enables a non-Codex parent's boundary, alias and closed snapshot`, async (t) => {
    const f = await fixture(t, transport);
    for (const [used, eligible] of /** @type {[number, boolean][]} */ ([
      [0, true],
      [50, true],
      [51, false],
      [100, false],
    ])) {
      await f.respond(response(used));
      const snapshot = await readParentUsage("fixture-alias", {
        cwd: f.cwd,
        now,
      });
      assert.deepEqual(snapshot, {
        status: "ok",
        remainingPercent: 100 - used,
        windowDurationMins: 300,
        fetchedAt,
      });
      assert.equal(decideParentWorker("auto", snapshot).eligible, eligible);
      assert.equal(JSON.stringify(snapshot).includes("fixture-account"), false);
    }
  });
  test(`${transport}: blocked, malformed and ambiguous windows keep the parent out`, async (t) => {
    const f = await fixture(t, transport);
    const blocked = response(0);
    blocked.quota.buckets.blocked = "fixture-private-reason";
    const cases = [
      null,
      {},
      { ...response(0), allowed: false },
      blocked,
      response("10"),
      response(12.5),
      response(-1),
      response(101),
      { quota: { buckets: { weekly: { used: 0, minutes: 10080 } } } },
      {
        quota: {
          buckets: {
            a: { used: 0, minutes: 300 },
            b: { used: 0, minutes: 300 },
          },
        },
      },
    ];
    for (const raw of cases) {
      await f.respond(raw);
      const snapshot = await readParentUsage("fixture", { cwd: f.cwd, now });
      assert.equal(snapshot.status, "unknown");
      assert.equal(decideParentWorker("auto", snapshot).eligible, false);
      assert.equal(decideParentWorker("always", snapshot).eligible, true);
      assert.equal(JSON.stringify(snapshot).includes("fixture-private"), false);
    }
    await f.respond({ legacy: { short: { used: 25, minutes: 300 } } });
    assert.equal(
      (await readParentUsage("fixture", { cwd: f.cwd })).remainingPercent,
      75,
    );
  });
}

test("disabled, retired and undeclared readers never start a CLI; always still allows participation", async (t) => {
  const f = await fixture(t);
  let spawned = 0;
  const options = {
    cwd: f.cwd,
    now,
    spawn: () => {
      spawned++;
      throw new Error("unexpected spawn");
    },
  };
  await f.configure([]);
  const disabled = await readParentUsage("fixture-alias", options);
  assert.equal(disabled.reason, "parent-usage-unsupported-runtime");
  await f.configure(["fixture"]);
  delete f.runtime.usage;
  await f.save();
  assert.equal(
    (await readParentUsage("fixture", options)).reason,
    "parent-usage-unsupported-runtime",
  );
  f.runtime.retired = true;
  await f.save();
  await f.configure([]);
  assert.equal(
    (await readParentUsage("fixture", options)).reason,
    "parent-usage-unsupported-runtime",
  );
  assert.equal(spawned, 0);
  assert.equal(decideParentWorker("auto", disabled).eligible, false);
  assert.equal(decideParentWorker("always", disabled).eligible, true);
});

test("exec-json rejects nonzero exit, bad JSON, excessive output and timeouts with closed errors", async (t) => {
  const f = await fixture(t);
  for (const code of [
    'console.log("private invalid json")',
    'console.log("{}");process.exitCode=1',
    'process.stdout.write("a".repeat(1024*1024+1))',
  ]) {
    await fs.writeFile(f.cli, code);
    assert.deepEqual(await readParentUsage("fixture", { cwd: f.cwd, now }), {
      status: "unknown",
      reason: "parent-usage-fetch-failed",
      fetchedAt,
    });
  }
  await fs.writeFile(f.cli, "setInterval(()=>{},1000)");
  assert.deepEqual(
    await readParentUsage("fixture", { cwd: f.cwd, now, timeoutMs: 200 }),
    {
      status: "unknown",
      reason: "parent-usage-timeout",
      fetchedAt,
    },
  );
});

test("JSON-RPC handles no handshake, malformed notifications, errors and bounded output", async (t) => {
  const f = await fixture(t, "jsonrpc-stdio");
  delete f.runtime.usage.initialize;
  delete f.runtime.usage.initialized;
  await f.save();
  await fs.writeFile(
    f.cli,
    `import readline from 'node:readline';
    readline.createInterface({input:process.stdin}).on('line',line=>{
      console.log('noise'); console.log('null'); console.log(JSON.stringify({method:'notice'}));
      console.log(JSON.stringify({id:JSON.parse(line).id,result:${JSON.stringify(response(50))}}));
    });`,
  );
  assert.equal(
    (await readParentUsage("fixture", { cwd: f.cwd })).remainingPercent,
    50,
  );
  for (const reply of [
    JSON.stringify({ id: 2, error: { message: "secret" } }),
    "a".repeat(1024 * 1024 + 1),
  ]) {
    await fs.writeFile(
      f.cli,
      `process.stdin.once('data',()=>console.log(${JSON.stringify(reply)}));`,
    );
    assert.equal(
      (await readParentUsage("fixture", { cwd: f.cwd })).reason,
      "parent-usage-fetch-failed",
    );
  }
});

test("registry rejects unsupported usage contracts before any execution", async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.runtime.usage);
  for (const patch of [
    { transport: "shell" },
    { windows: "$.quota;process.exit()" },
    { windows: "quota" },
    { usedPercent: "$.used" },
    { windowDurationMins: 10080 },
    { resetsAt: "reset" },
    { resetFormat: "iso" },
    { blocked: ["$.allowed = false"] },
    { request: { method: "bad" } },
    { command: [] },
    { typo: true },
  ]) {
    f.runtime.usage = { ...original, ...patch };
    await f.save();
    assert.throws(() => loadRuntimeRegistry(f.cwd), /runtime-/);
  }
});

test("graph default dependencies resolve the parent alias in the supplied repository cwd", async (t) => {
  const f = await fixture(t);
  await f.respond(response(40));
  const deps = createDefaultDeps({ cwd: f.cwd, threadId: "fixture-thread" });
  const snapshot = await deps.readParentUsage("fixture-alias");
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.remainingPercent, 60);
});

test("literal argv and cwd reach the CLI without shell evaluation", async (t) => {
  const f = await fixture(t);
  f.runtime.usage.command.push("$(exit 9);literal argument");
  await f.save();
  await fs.writeFile(
    f.cli,
    `
    if(process.cwd() !== ${JSON.stringify(f.cwd)} || process.argv[2] !== '$(exit 9);literal argument') process.exit(1);
    console.log(${JSON.stringify(JSON.stringify(response(45)))});
  `,
  );
  assert.equal(
    (await readParentUsage("fixture", { cwd: f.cwd })).remainingPercent,
    55,
  );
});

test("declared five-hour self window accepts decimal percentages and rejects expired/locked/missing values", async (t) => {
  const f = await fixture(t, "control-stdio");
  Object.assign(f.runtime.usage, {
    windows: "$.quota.five_hour",
    windowSelection: "self",
    windowDurationMins: 300,
    percentFormat: "number",
    resetsAt: "reset",
    resetFormat: "iso",
    blocked: ["locked != null"],
  });
  await f.save();
  const raw = (used, reset = "2050-01-01T00:00:00Z", extra = {}) => ({
    quota: {
      five_hour: { used, reset, ...extra },
      seven_day: { used: 0, reset: "2050-01-01T00:00:00Z" },
    },
  });
  for (const [used, eligible] of /** @type {[number, boolean][]} */ ([
    [49.9, true],
    [50, true],
    [50.1, false],
  ])) {
    await f.respond(raw(used));
    const snapshot = await readParentUsage("fixture", { cwd: f.cwd, now });
    assert.equal(snapshot.remainingPercent, 100 - used);
    assert.equal(decideParentWorker("auto", snapshot).eligible, eligible);
  }
  for (const payload of [
    raw(0, "2020-01-01T00:00:00Z"),
    raw(0, "2026-10-18T00:00:00Z"),
    raw(0, null),
    raw(0, "not-a-date"),
    raw(0, "2050-01-01T00:00:00"),
    raw(null),
    raw("0"),
    raw(0, undefined, { locked: "fixture-block" }),
    { quota: { seven_day: { used: 0, reset: "2050-01-01T00:00:00Z" } } },
  ]) {
    await f.respond(payload);
    const snapshot = await readParentUsage("fixture", { cwd: f.cwd, now });
    assert.equal(snapshot.status, "unknown");
    assert.equal(decideParentWorker("auto", snapshot).eligible, false);
  }
});

test("control-stdio errors, wrong response IDs and silent servers fail closed", async (t) => {
  const f = await fixture(t, "control-stdio");
  for (const phase of ["1", "2"]) {
    await fs.writeFile(
      f.cli,
      `import readline from 'node:readline';
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);console.log(JSON.stringify({type:'control_response',response:{request_id:m.request_id,
          subtype:m.request_id===${JSON.stringify(phase)}?'error':'success',response:{},error:'fixture-secret'}}));
      });`,
    );
    assert.equal(
      (await readParentUsage("fixture", { cwd: f.cwd })).reason,
      "parent-usage-fetch-failed",
    );
  }
  await fs.writeFile(
    f.cli,
    `process.stdin.on('data',()=>console.log(JSON.stringify({type:'control_response',response:{request_id:'wrong',subtype:'success',response:{}}})));`,
  );
  assert.equal(
    (await readParentUsage("fixture", { cwd: f.cwd, timeoutMs: 200 })).reason,
    "parent-usage-timeout",
  );
});

test("explicit no-five-hour declarations distinguish unavailable quota without spawning a CLI", async () => {
  let spawned = false;
  const u = await readParentUsage("grok", {
    now,
    spawn: () => {
      spawned = true;
      throw Error("unexpected");
    },
  });
  assert.deepEqual(u, {
    status: "unknown",
    reason: "parent-usage-five-hour-unavailable",
    fetchedAt,
  });
  assert.equal(spawned, false);
  assert.equal(decideParentWorker("auto", u).eligible, false);
});
