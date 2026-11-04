import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildRuntimeEnvironment,
  validateEnvironmentPolicy,
} from "../../scripts/issue-runtime-adapters/environment.mjs";
import {
  readCliVersion,
  runProcess,
  spawnWorker,
} from "../../scripts/issue-runtime-adapters/shared.mjs";
import { fetchUsage } from "../../scripts/issue-runtime-adapters/usage.mjs";
import { fetchRuntimeCatalog } from "../../scripts/issue-runtime-adapters/catalog.mjs";
import { createAdapter } from "../../scripts/issue-runtime-adapters/generic.mjs";
import {
  loadRuntimeRegistry,
  runtimeEnvironment,
} from "../../scripts/ai-template/registry.mjs";

const parentEnv = {
  PATH: path.dirname(process.execPath),
  HOME: path.join(tmpdir(), "fake-runtime-home"),
  EXAMPLE_RUNTIME_TOKEN: "fake-runtime-value",
  HTTPS_PROXY: "fake-proxy-value",
  UNRELATED_SECRET: "fake-unrelated-value",
  TYPESAFE_API_KEY: "fake-triage-value",
  ISSUE_WORKTREE_SESSION: "outer-session",
};
const policy = {
  inherit: ["EXAMPLE_RUNTIME_TOKEN", "HTTPS_PROXY"],
  required: ["EXAMPLE_RUNTIME_TOKEN"],
};
// Every non-retired runtime declares permission profiles (#63). The implementer
// profile carries argv so a test can see it reach the same spawn as the environment.
const permissions = {
  flags: ["--fixture-mode"],
  profiles: {
    "workspace-write": {
      args: ["--fixture-mode", "write"],
      enforcement: "inherited",
      network: true,
    },
    "worktree-setup": { args: [], enforcement: "inherited", network: true },
    "read-only": { args: [], enforcement: "inherited", network: true },
  },
};
const observation = `JSON.stringify({ allowed: process.env.EXAMPLE_RUNTIME_TOKEN === 'fake-runtime-value', proxy: process.env.HTTPS_PROXY === 'fake-proxy-value', unrelated: 'UNRELATED_SECRET' in process.env, triage: 'TYPESAFE_API_KEY' in process.env, lease: 'ISSUE_WORKTREE_SESSION' in process.env })`;
const expected = {
  allowed: true,
  proxy: true,
  unrelated: false,
  triage: false,
  lease: false,
};

test("OS basics and runtime opt-ins reach a real process without changing the parent", async () => {
  const original = { ...parentEnv };
  const env = buildRuntimeEnvironment({ parentEnv, policy });
  const result = await runProcess(
    process.execPath,
    ["-e", `console.log(${observation})`],
    { env },
  );
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(JSON.stringify(parentEnv) === JSON.stringify(original), true);
  assert.equal(env.PATH, parentEnv.PATH);
  assert.equal(env.HOME, parentEnv.HOME);
  assert.equal(
    buildRuntimeEnvironment({ parentEnv }).EXAMPLE_RUNTIME_TOKEN,
    undefined,
  );
});

test("invalid policy and required values fail with closed errors", () => {
  for (const invalid of [
    { inherit: ["TOKEN*"] },
    { inherit: ["TYPESAFE_API_KEY"] },
    { inherit: ["issue_worktree_session"] },
    { inherit: ["A", "A"] },
    { required: ["A"] },
    { inherit: ["A"], extra: true },
  ]) {
    assert.throws(
      () => validateEnvironmentPolicy(invalid),
      /^Error: runtime-env-policy-invalid$/,
    );
  }
  for (const value of [undefined, ""])
    assert.throws(
      () =>
        buildRuntimeEnvironment({
          parentEnv: { EXAMPLE_RUNTIME_TOKEN: value },
          policy,
        }),
      /^Error: runtime-env-required-missing$/,
    );
});

test("Windows folds keys and refuses conflicting values; POSIX keeps case", () => {
  assert.equal(
    buildRuntimeEnvironment({
      parentEnv: { Path: "example", SystemRoot: "example-os" },
      platform: "win32",
    }).PATH,
    "example",
  );
  assert.throws(
    () =>
      buildRuntimeEnvironment({
        parentEnv: { PATH: "one", Path: "two" },
        platform: "win32",
      }),
    /^Error: runtime-env-key-collision$/,
  );
  assert.equal(
    buildRuntimeEnvironment({
      parentEnv: { PATH: "one", Path: "two" },
      platform: "linux",
    }).PATH,
    "one",
  );
});

test("runtime overrides stay with their canonical runtime and affect registry fingerprint", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "runtime-env-"));
  try {
    await mkdir(path.join(cwd, ".ai-template"));
    const file = path.join(cwd, ".ai-template/config.json");
    const before = loadRuntimeRegistry(cwd).fingerprint;
    await writeFile(
      file,
      JSON.stringify({
        agents: {
          enabled: ["codex", "claude"],
          environment: { codex: policy },
        },
      }),
    );
    assert.notEqual(loadRuntimeRegistry(cwd).fingerprint, before);
    assert.equal(
      runtimeEnvironment({ id: "codex" }, { cwd, env: parentEnv })
        .EXAMPLE_RUNTIME_TOKEN !== undefined,
      true,
    );
    assert.equal(
      runtimeEnvironment({ id: "claude" }, { cwd, env: parentEnv })
        .EXAMPLE_RUNTIME_TOKEN,
      undefined,
    );
    for (const id of ["Codex", "unknown-runtime"]) {
      await writeFile(
        file,
        JSON.stringify({
          agents: { enabled: ["codex"], environment: { [id]: policy } },
        }),
      );
      assert.throws(
        () => loadRuntimeRegistry(cwd),
        /^Error: runtime-env-policy-invalid$/,
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("exec and both server transports use the selected environment from first spawn", async () => {
  const env = buildRuntimeEnvironment({ parentEnv, policy });
  for (const transport of ["exec-json", "jsonrpc-stdio", "control-stdio"]) {
    const script =
      transport === "exec-json"
        ? `console.log(${observation})`
        : `require('node:readline').createInterface({input:process.stdin}).on('line', line => { const message=JSON.parse(line); console.log(JSON.stringify(${transport === "jsonrpc-stdio" ? `{id:message.id,result:JSON.parse(${observation})}` : `{type:'control_response',response:{request_id:message.request_id,subtype:'success',response:JSON.parse(${observation})}}`})); });`;
    const result = await fetchUsage(
      {
        transport,
        command: [process.execPath, "-e", script],
        request: { method: "inspect" },
      },
      { env },
    );
    assert.deepEqual(result, expected);
  }
});

test("adapter auth/list and worker boundaries apply policy before injected launchers", async () => {
  const definition = {
    id: "example-env-runtime",
    name: "Example",
    commands: [process.execPath],
    environment: policy,
    permissions,
    auth: { args: ["auth"], parser: "logged-in-json" },
    models: { args: ["models"], parser: "codex-models" },
    promptArgs: [],
  };
  const seen = [];
  const workerArgs = [];
  await fetchRuntimeCatalog(definition, {
    env: parentEnv,
    resolveExecutable: async () => process.execPath,
    runProcess: async (_command, _args, options) => {
      seen.push(options.env);
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  await createAdapter(definition).launch(
    {
      env: parentEnv,
      spawnWorker: (_command, args, options) => {
        seen.push(options.env);
        workerArgs.push(...args);
        return {};
      },
    },
    { selector: process.execPath, timeoutMs: 1000 },
  );
  assert.equal(seen.length, 2);
  // The minimal environment and the registry permission argv reach one worker spawn.
  assert.deepEqual(workerArgs.slice(0, 2), ["--fixture-mode", "write"]);
  for (const env of seen) {
    assert.equal(env.EXAMPLE_RUNTIME_TOKEN !== undefined, true);
    assert.equal(env.UNRELATED_SECRET, undefined);
    assert.equal(env.ISSUE_WORKTREE_SESSION, undefined);
  }
  let launched = false;
  await assert.rejects(
    createAdapter(definition).launch(
      {
        env: {},
        spawnWorker: () => {
          launched = true;
        },
      },
      { selector: process.execPath },
    ),
    /^Error: runtime-env-required-missing$/,
  );
  assert.equal(launched, false);
});

test("worker gets only a freshly supplied lease and discards output", async () => {
  const env = buildRuntimeEnvironment({
    parentEnv,
    policy,
    lease: { session: "new-session", ownerPid: 42 },
  });
  const worker = spawnWorker(
    process.execPath,
    [
      "-e",
      `process.exit(process.env.ISSUE_WORKTREE_SESSION === 'new-session' && !process.env.UNRELATED_SECRET ? 0 : 1)`,
    ],
    { env, timeoutMs: 5000 },
  );
  assert.equal((await worker.wait()).code, 0);
});

test("low-level AI launchers require an explicit environment", async () => {
  await assert.rejects(
    runProcess(process.execPath, []),
    /^Error: runtime-env-policy-required$/,
  );
  await assert.rejects(
    fetchUsage({ command: [process.execPath] }),
    /^Error: runtime-env-policy-required$/,
  );
  assert.throws(
    () => spawnWorker(process.execPath, [], { timeoutMs: 1000 }),
    /^Error: runtime-env-policy-required$/,
  );
});

test("real custom CLI enforces one policy for auth, catalog, version, headless probe and worker", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "runtime-env-cli-"));
  try {
    const cli = path.join(cwd, "example-cli.mjs");
    await writeFile(
      cli,
      `#!${process.execPath}
import fs from 'node:fs';
const valid = process.env.EXAMPLE_RUNTIME_TOKEN === 'fake-runtime-value' && process.env.HTTPS_PROXY === 'fake-proxy-value' && !process.env.UNRELATED_SECRET && !process.env.TYPESAFE_API_KEY && !process.env.ISSUE_WORKTREE_SESSION;
if (!valid) { console.log('fake-sensitive-failure-output'); console.error('fake-sensitive-failure-output'); process.exit(7); }
const args = process.argv.slice(2);
if (args[0] === 'auth') console.log(JSON.stringify({loggedIn:true}));
else if (args[0] === 'models') console.log(JSON.stringify({models:[{slug:'example-model'}]}));
else if (args[0] === '--version') console.log('fixture-v1');
else {
 const prompt=args.at(-1);
 if (prompt.startsWith('Create a new file at this exact path: ')) {
  const lines=prompt.split('\\n');
  fs.writeFileSync(lines[0].slice('Create a new file at this exact path: '.length), lines[1].slice('The file must contain exactly this text and nothing else: '.length));
 }
}
`,
    );
    await chmod(cli, 0o755);
    const definition = {
      id: "example-env-runtime",
      name: "Example",
      commands: [cli],
      environment: policy,
      permissions,
      auth: { args: ["auth"], parser: "logged-in-json" },
      models: { args: ["models"], parser: "codex-models" },
      selectorArgs: ["{model}"],
      probeArgs: [],
      promptArgs: [],
    };
    const ctx = { cwd, env: parentEnv };
    const result = await createAdapter(definition).discover(ctx);
    assert.equal(result.records.length, 2);
    assert.equal(result.diagnostics[0].status, "ok");
    assert.equal(
      await readCliVersion(cli, { env: runtimeEnvironment(definition, ctx) }),
      "fixture-v1",
    );
    const worker = await createAdapter(definition).launch(ctx, {
      selector: cli,
      cwd,
      timeoutMs: 5000,
      issueNumber: 1,
    });
    assert.equal((await worker.wait()).code, 0);
    const failed = await createAdapter({
      ...definition,
      environment: {},
    }).discover(ctx);
    assert.equal(failed.records.length, 0);
    assert.equal(
      JSON.stringify(failed).includes("fake-sensitive-failure-output"),
      false,
    );
    assert.equal(JSON.stringify(failed).includes("fake-runtime-value"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
