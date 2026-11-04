import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PERMISSION_ROLES,
  loadRuntimeRegistry,
  permissionFingerprintFor,
  resolvePermission,
  runtimePermissionSummary,
} from "../../scripts/ai-template/registry.mjs";
import { dispatchWorker } from "../../scripts/issue-dispatch.mjs";
import {
  discoverCapabilities,
  loadOrRefreshCapabilities,
} from "../../scripts/issue-capabilities.mjs";
import { launchWithAdapter } from "../../scripts/issue-runtime-adapters/index.mjs";
import {
  PROBE_SCHEMA_VERSION,
  getRepositoryCommit,
  runHeadlessExecProbe,
} from "../../scripts/issue-runtime-adapters/shared.mjs";
import { assignRoleRoutes } from "../../scripts/issue-roles.mjs";

const source = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const ALL_ENABLED = ["claude", "codex", "gemini", "grok", "opencode"];
const BYPASS =
  /bypassPermissions|--dangerously-|--always-approve|--auto\b|--yolo|--full-auto/;

/** A throwaway checkout with the shipped runtime definitions and a fake config. */
function fixture(t, agents = { enabled: ALL_ENABLED }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(source, "agents"), path.join(root, "agents"), {
    recursive: true,
  });
  writeConfig(root, agents);
  return root;
}
function writeConfig(root, agents) {
  fs.mkdirSync(path.join(root, ".ai-template"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".ai-template/config.json"),
    JSON.stringify({ agents }),
  );
}
function editRuntime(root, id, edit) {
  const file = path.join(root, "agents/runtimes", `${id}.json`);
  const runtime = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(runtime);
  fs.writeFileSync(file, JSON.stringify(runtime));
}
function resolved(root, id, role) {
  const registry = loadRuntimeRegistry(root);
  return resolvePermission(
    registry,
    registry.enabled.find((r) => r.id === id),
    role,
  );
}

test("no runtime gets a bypass argument for any role by default", (t) => {
  const root = fixture(t);
  const registry = loadRuntimeRegistry(root);
  assert.deepEqual(registry.permissions.allowBypass, []);
  for (const runtime of registry.enabled) {
    assert.doesNotMatch(runtime.selectorArgs.join(" "), BYPASS);
    for (const role of PERMISSION_ROLES) {
      const permission = resolvePermission(registry, runtime, role);
      assert.notEqual(permission.profile, "bypass");
      assert.doesNotMatch(permission.args.join(" "), BYPASS);
    }
  }
});

test("planner and reviewer get different Claude read-only allow lists", (t) => {
  const root = fixture(t);
  const reviewer = resolved(root, "claude", "reviewer");
  const planner = resolved(root, "claude", "planner");
  const implementer = resolved(root, "claude", "implementer");
  assert.equal(reviewer.profile, "read-only");
  assert.equal(planner.profile, "worktree-setup");
  assert.equal(implementer.profile, "workspace-write");
  for (const permission of [reviewer, planner]) {
    assert.deepEqual(permission.args.slice(0, 5), [
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--disallowedTools=Edit,Write,NotebookEdit",
    ]);
    assert.equal(permission.enforcement, "cli");
  }
  // A reviewer never touches the worktree lifecycle; only the planner creates it.
  assert.doesNotMatch(reviewer.args.join(" "), /issue-worktree\.sh/);
  assert.match(reviewer.args.join(" "), /Bash\(gh pr comment:\*\)/);
  assert.match(
    planner.args.join(" "),
    /Bash\(bash scripts\/issue-worktree\.sh create:\*\)/,
  );
  assert.doesNotMatch(planner.args.join(" "), /gh pr comment|git push/);
  assert.deepEqual(implementer.args.slice(0, 4), [
    "--permission-mode",
    "acceptEdits",
    "--permission-prompts",
    "none",
  ]);
});

test("Codex reviews in a read-only sandbox, which cannot post, so no reviewer role", (t) => {
  const root = fixture(t);
  const reviewer = resolved(root, "codex", "reviewer");
  assert.deepEqual(reviewer.args, ["-s", "read-only"]);
  assert.equal(reviewer.enforcement, "cli");
  assert.equal(reviewer.unavailable, "route-permission-insufficient");
  const registry = loadRuntimeRegistry(root);
  assert.deepEqual(
    runtimePermissionSummary(
      registry,
      registry.enabled.find((r) => r.id === "codex"),
    ).roles,
    ["implementer", "planner"],
  );
  // Workspace-write is not CLI-enforced on Codex and says so.
  assert.equal(resolved(root, "codex", "implementer").enforcement, "inherited");
});

test("requireEnforcement excludes a profile the runtime cannot enforce", (t) => {
  const root = fixture(t, {
    enabled: ALL_ENABLED,
    permissions: { requireEnforcement: ["workspace-write", "read-only"] },
  });
  assert.equal(
    resolved(root, "codex", "implementer").unavailable,
    "route-permission-unenforced",
  );
  assert.equal(
    resolved(root, "opencode", "reviewer").unavailable,
    "route-permission-unenforced",
  );
  assert.equal(resolved(root, "claude", "reviewer").unavailable, undefined);
});

test("bypass needs an explicit opt-in for every enabled runtime", (t) => {
  const root = fixture(t, { enabled: ["claude", "grok"] });
  writeConfig(root, {
    enabled: ["claude", "grok"],
    permissions: { roles: { implementer: "bypass" } },
  });
  assert.throws(
    () => loadRuntimeRegistry(root),
    /runtime-permission-bypass-not-allowed:claude/,
  );
  writeConfig(root, {
    enabled: ["claude", "grok"],
    permissions: {
      roles: { implementer: "bypass" },
      allowBypass: ["claude"],
    },
  });
  assert.throws(
    () => loadRuntimeRegistry(root),
    /runtime-permission-bypass-not-allowed:grok/,
  );
  writeConfig(root, {
    enabled: ["claude", "grok"],
    permissions: {
      roles: { implementer: "bypass" },
      allowBypass: ["claude", "grok"],
    },
  });
  assert.deepEqual(resolved(root, "claude", "implementer").args, [
    "--permission-mode",
    "bypassPermissions",
  ]);
  // The opt-in is per role: the reviewer stays read-only.
  assert.equal(resolved(root, "claude", "reviewer").profile, "read-only");
  writeConfig(root, {
    enabled: ["claude", "codex"],
    permissions: { allowBypass: ["codex"] },
  });
  assert.throws(
    () => loadRuntimeRegistry(root),
    /runtime-permission-bypass-undefined:codex/,
  );
});

test("allow rules are configurable per runtime and change the fingerprints", (t) => {
  const root = fixture(t, { enabled: ["claude"] });
  const before = loadRuntimeRegistry(root);
  const beforePermission = permissionFingerprintFor("claude", root);
  writeConfig(root, {
    enabled: ["claude"],
    permissions: {
      runtimes: {
        claude: { "workspace-write": { allow: ["Bash(npm test:*)"] } },
      },
    },
  });
  assert.deepEqual(resolved(root, "claude", "implementer").args.slice(4), [
    "--allowedTools=Bash(npm test:*)",
  ]);
  assert.notEqual(loadRuntimeRegistry(root).fingerprint, before.fingerprint);
  assert.notEqual(permissionFingerprintFor("claude", root), beforePermission);
  writeConfig(root, {
    enabled: ["claude"],
    permissions: {
      runtimes: { claude: { "read-only": { allow: ["Read,Write"] } } },
    },
  });
  assert.throws(
    () => loadRuntimeRegistry(root),
    /runtime-permission-rule-invalid:claude/,
  );
  writeConfig(root, {
    enabled: ["codex"],
    permissions: {
      runtimes: { codex: { "read-only": { allow: ["Read"] } } },
    },
  });
  assert.throws(
    () => loadRuntimeRegistry(root),
    /runtime-permission-allow-unsupported:codex/,
  );
});

test("a runtime definition cannot put permission flags in its selector", (t) => {
  for (const arg of [
    "--permission-mode",
    "--permission-mode=bypassPermissions",
    "--dangerously-skip-permissions",
  ]) {
    const root = fixture(t, { enabled: ["claude"] });
    editRuntime(root, "claude", (runtime) => {
      runtime.selectorArgs = [...runtime.selectorArgs, arg];
    });
    assert.throws(
      () => loadRuntimeRegistry(root),
      /runtime-permission-flag-misplaced:claude/,
    );
  }
  const root = fixture(t, { enabled: ["grok"] });
  editRuntime(root, "grok", (runtime) => {
    runtime.permissions.profiles["read-only"].args = ["--always-approve"];
  });
  assert.throws(
    () => loadRuntimeRegistry(root),
    /runtime-permission-profile-invalid:grok/,
  );
});

/** A verified-looking Claude route probed under the current policy of `root`. */
function claudeRoute(root, selector = "claude --model sonnet") {
  return {
    agent: "Claude",
    role: "worker",
    model: "claude-sonnet-4-6",
    requestedModel: "sonnet",
    selector,
    selectable: true,
    verifiable: true,
    permissionFingerprint: permissionFingerprintFor("claude", root),
    timeoutMs: 1000,
  };
}
async function dispatch(root, route, role) {
  const launches = [];
  const handle = await dispatchWorker(
    {
      route,
      issueNumber: 7,
      releasePolicy: "pr-created",
      nextMilestone: "pr-created",
      cwd: root,
      ...(role === undefined ? {} : { role }),
    },
    {
      spawnWorker: (cli, args) => {
        launches.push(args);
        return { pid: 1, kill() {}, wait: async () => ({ code: 0 }) };
      },
      startLeaseHeartbeat: () => ({ stop() {} }),
    },
  );
  return { handle, args: launches[0] };
}

test("dispatch rebuilds each role's permission argv from the registry", async (t) => {
  const root = fixture(t, { enabled: ["claude", "codex"] });
  for (const [role, profile] of [
    [undefined, "workspace-write"],
    ["implementer", "workspace-write"],
    ["planner", "worktree-setup"],
    ["reviewer", "read-only"],
  ]) {
    const { handle, args } = await dispatch(root, claudeRoute(root), role);
    const expected = resolved(root, "claude", role);
    assert.equal(expected.profile, profile);
    assert.deepEqual(handle.permission, { profile, enforcement: "cli" });
    // selector, then the profile argv, then the prompt flag and the prompt.
    assert.deepEqual(args.slice(0, 2), ["--model", "sonnet"]);
    assert.deepEqual(args.slice(2, 2 + expected.args.length), expected.args);
    assert.equal(args.at(-2), "-p");
    assert.doesNotMatch(args.slice(0, -1).join(" "), BYPASS);
  }
});

test("dispatch refuses permission argv from a route, a stale fingerprint, or an unservable role", async (t) => {
  const root = fixture(t, { enabled: ["claude", "codex"] });
  for (const selector of [
    "claude --model sonnet --permission-mode bypassPermissions",
    "claude --model sonnet --dangerously-skip-permissions",
    "claude --model sonnet --allowedTools=Bash",
  ])
    await assert.rejects(
      dispatch(root, claudeRoute(root, selector)),
      /^Error: route-permission-args-forbidden$/,
    );
  const unprobed = claudeRoute(root);
  delete unprobed.permissionFingerprint;
  await assert.rejects(
    dispatch(root, unprobed),
    /^Error: route-permission-mismatch$/,
  );
  const probedEarlier = claudeRoute(root);
  writeConfig(root, {
    enabled: ["claude", "codex"],
    permissions: {
      runtimes: { claude: { "read-only": { allow: ["Bash(ls:*)"] } } },
    },
  });
  await assert.rejects(
    dispatch(root, probedEarlier),
    /^Error: route-permission-mismatch$/,
  );
  const codexReviewer = {
    agent: "Codex",
    role: "worker",
    model: "fiction-model",
    selector: "codex exec -m fiction-model",
    selectable: true,
    verifiable: true,
    permissionFingerprint: permissionFingerprintFor("codex", root),
    timeoutMs: 1000,
  };
  await assert.rejects(
    dispatch(root, codexReviewer, "reviewer"),
    /^Error: route-permission-insufficient$/,
  );
  // The exported adapter entry point checks the selector too.
  await assert.rejects(
    launchWithAdapter(
      "Claude",
      {
        ...claudeRoute(root, "claude --model sonnet --permission-mode plan"),
        issueNumber: 7,
        cwd: root,
      },
      { spawnWorker: () => assert.fail("must not launch") },
    ),
    /route-permission-args-forbidden/,
  );
});

/** Fake CLI hooks: each runtime lists one fictional model and passes the probe. */
function fakeClis(probes = []) {
  const listing = (id) => ({
    status: "ok",
    cliPath: `/fake/${id}`,
    models: [{ model: "fiction-model", label: "fiction-model" }],
  });
  return {
    catalogListings: Object.fromEntries(
      ALL_ENABLED.map((id) => [id, listing(id)]),
    ),
    resolveExecutable: async (name) =>
      path.isAbsolute(name) ? name : `/fake/${name}`,
    runProcess: async () => ({ code: 0, stdout: "fixture-v1" }),
    headlessExecProbe: async ({ cliPath, args }) => {
      probes.push([cliPath, ...args]);
      return { ok: true };
    },
  };
}

test("discovery probes with the implementer argv and records permission roles", async (t) => {
  const root = fixture(t, { enabled: ["grok", "codex"] });
  const probes = [];
  const result = await discoverCapabilities({ cwd: root, ...fakeClis(probes) });
  const grokProbe = probes.find((p) => p[0] === "/fake/grok");
  const implementer = resolved(root, "grok", "implementer");
  assert.deepEqual(
    grokProbe.slice(3, 3 + implementer.args.length),
    implementer.args,
  );
  assert.doesNotMatch(grokProbe.join(" "), BYPASS);
  const records = Object.fromEntries(
    result.capabilities
      .filter((r) => r.role === "worker")
      .map((r) => [r.agent, r]),
  );
  assert.deepEqual(records.Grok.permissionRoles, [
    "implementer",
    "planner",
    "reviewer",
  ]);
  assert.deepEqual(records.Codex.permissionRoles, ["implementer", "planner"]);
  assert.equal(
    records.Codex.permissionFingerprint,
    permissionFingerprintFor("codex", root),
  );
  assert.doesNotMatch(records.Grok.selector, /--permission-mode/);
});

test("a runtime the policy leaves no role is never probed", async (t) => {
  const root = fixture(t, {
    enabled: ["codex"],
    permissions: { requireEnforcement: ["workspace-write", "worktree-setup"] },
  });
  const probes = [];
  const result = await discoverCapabilities({ cwd: root, ...fakeClis(probes) });
  assert.deepEqual(probes, []);
  assert.deepEqual(result.capabilities, []);
  assert.deepEqual(
    result.diagnostics.map((d) => d.reason),
    ["permission-unavailable"],
  );
});

test("a cached selector that carries permission flags is re-probed", async (t) => {
  const root = fixture(t, { enabled: ["claude"] });
  const cachePath = path.join(root, "capabilities.json");
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      probeSchemaVersion: PROBE_SCHEMA_VERSION,
      runtimeFingerprint: loadRuntimeRegistry(root).fingerprint,
      repositoryCommit: await getRepositoryCommit(root),
      capabilities: [
        {
          ...claudeRoute(
            root,
            "/fake/claude --model sonnet --permission-mode bypassPermissions",
          ),
        },
      ],
      diagnostics: [],
      cli: {},
    }),
  );
  const result = await loadOrRefreshCapabilities({
    cwd: root,
    cachePath,
    ...fakeClis(),
    resolveExecutable: async () => null,
  });
  assert.equal(result.reused, false);
  assert.deepEqual(result.capabilities, []);
});

test("a probe whose tool calls were denied fails as permission-denied", async () => {
  const result = await runHeadlessExecProbe({
    cliPath: "/fake/claude",
    run: async () => ({
      code: 0,
      timedOut: false,
      stdout: `${JSON.stringify({ type: "result", permission_denials: [{ tool_name: "Write" }] })}\n`,
      stderr: "",
    }),
  });
  assert.deepEqual(result, { ok: false, reason: "permission-denied" });
});

test("role routes skip a runtime whose policy cannot run the role", () => {
  const codex = {
    agent: "Codex",
    model: "fiction-a",
    permissionRoles: ["implementer", "planner"],
  };
  const claude = {
    agent: "Claude",
    model: "fiction-b",
    permissionRoles: ["implementer", "planner", "reviewer"],
  };
  const { routes, degraded } = assignRoleRoutes(
    [codex, claude],
    ["planner", "implementer", "reviewer"],
  );
  assert.equal(routes.implementer, codex);
  assert.equal(routes.reviewer, claude);
  assert.equal(routes.planner, claude);
  assert.equal(degraded, undefined);
  // Claude first: Codex implements so that Claude stays free to review.
  const swapped = assignRoleRoutes(
    [claude, codex],
    ["implementer", "reviewer"],
  );
  assert.equal(swapped.routes.implementer, codex);
  assert.equal(swapped.routes.reviewer, claude);
  // With no permitted distinct reviewer the roles share a route, recorded as degraded.
  const alone = assignRoleRoutes([claude], ["implementer", "reviewer"]);
  assert.equal(alone.routes.reviewer, claude);
  const codexOnly = assignRoleRoutes(
    [codex, { ...codex, model: "fiction-c" }],
    ["implementer", "reviewer"],
  );
  assert.equal(codexOnly.routes.reviewer, codex);
  assert.equal(
    codexOnly.degraded,
    "same-route-reviewer:no-permitted-distinct-route",
  );
});
