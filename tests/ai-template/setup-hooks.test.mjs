import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/setup-hooks.sh",
);

/**
 * A throwaway repository holding a copy of setup-hooks.sh and a non-executable
 * fake hook. Global and system Git configuration are replaced by a fixture
 * file so the developer's real settings neither leak in nor change.
 */
function repository(t) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "setup-hooks-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(dir, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  const run = (command, args) =>
    spawnSync(command, args, {
      cwd: fs.existsSync(root) ? root : dir,
      env,
      encoding: "utf8",
    });
  const git = (...args) => {
    const result = run("git", args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", root);
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(script, path.join(root, "scripts/setup-hooks.sh"));
  fs.mkdirSync(path.join(root, ".githooks"));
  for (const hook of ["pre-commit", "commit-msg"]) {
    fs.writeFileSync(
      path.join(root, ".githooks", hook),
      "#!/bin/sh\nexit 0\n",
      {
        mode: 0o644,
      },
    );
  }
  return {
    root,
    git,
    setup: () => run("bash", ["scripts/setup-hooks.sh"]),
    localHooksPath: () =>
      run("git", [
        "config",
        "--local",
        "--get",
        "core.hooksPath",
      ]).stdout.trim(),
    hookExecutable: (hook = "commit-msg") =>
      (fs.statSync(path.join(root, ".githooks", hook)).mode & 0o111) !== 0,
  };
}

test("setup-hooks sets an unset core.hooksPath and is idempotent", (t) => {
  const repo = repository(t);
  const first = repo.setup();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(repo.localHooksPath(), ".githooks");
  assert.equal(repo.hookExecutable("commit-msg"), true);
  assert.equal(repo.hookExecutable("pre-commit"), true);

  const again = repo.setup();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already set to \.githooks/);
  assert.equal(repo.localHooksPath(), ".githooks");
});

test("setup-hooks refuses to replace a local core.hooksPath and changes nothing", (t) => {
  const repo = repository(t);
  repo.git("config", "--local", "core.hooksPath", "custom-hooks");

  const refused = repo.setup();
  assert.equal(refused.status, 1);
  assert.match(
    refused.stderr,
    /existing core\.hooksPath = custom-hooks \(local config\)/,
  );
  assert.match(refused.stderr, /git config --local --unset core\.hooksPath/);
  assert.equal(repo.localHooksPath(), "custom-hooks");
  assert.equal(repo.hookExecutable(), false);

  repo.git("config", "--local", "--unset", "core.hooksPath");
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.localHooksPath(), ".githooks");
});

test("setup-hooks refuses to shadow an inherited global core.hooksPath", (t) => {
  const repo = repository(t);
  repo.git("config", "--global", "core.hooksPath", "/fixture/global-hooks");

  const refused = repo.setup();
  assert.equal(refused.status, 1);
  assert.match(
    refused.stderr,
    /existing core\.hooksPath = \/fixture\/global-hooks \(global config\)/,
  );
  assert.match(refused.stderr, /git config --local core\.hooksPath \.githooks/);
  assert.equal(repo.localHooksPath(), "");
  assert.equal(
    repo.git("config", "--global", "--get", "core.hooksPath"),
    "/fixture/global-hooks",
  );
  assert.equal(repo.hookExecutable(), false);

  // The suggested repository-only override is then accepted as already set.
  repo.git("config", "--local", "core.hooksPath", ".githooks");
  const after = repo.setup();
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /already set to \.githooks/);
});

test("template commit-msg gates reference existing npm scripts", (t) => {
  const root = path.resolve(path.dirname(script), "..");
  // Consumers own their hooks and package scripts; this is a template contract.
  if (!fs.existsSync(path.join(root, "ai-template.manifest.json"))) {
    t.skip("consumer-owned quality gates");
    return;
  }
  const hook = fs.readFileSync(path.join(root, ".githooks/commit-msg"), "utf8");
  const { scripts } = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const gates = [
    ...hook.matchAll(/^run_gate\s+"[^"]+"\s+"npm run ([\w:-]+)"/gm),
  ];
  assert.ok(gates.length > 0, "expected npm quality gates in the real hook");
  for (const [, name] of gates) {
    assert.equal(typeof scripts[name], "string", `missing npm script: ${name}`);
  }
});
