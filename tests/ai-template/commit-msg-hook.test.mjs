import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const templateRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const hookSource = path.join(templateRoot, ".githooks/commit-msg");
// Consumers own their hooks, so these tests cover the template's hook only.
const consumerHooks = !fs.existsSync(
  path.join(templateRoot, "ai-template.manifest.json"),
)
  ? "consumer-owned commit hooks"
  : false;

// A stand-in for the real quality gates: it records each gate it was asked to
// run and fails when GATE_FAIL is set, so a test can tell "skipped" apart from
// "ran and passed" or "ran and failed".
const GATE_SCRIPT = `
const fs = require("node:fs");
fs.appendFileSync(process.env.GATE_LOG, process.argv[2] + "\\n");
process.exit(process.env.GATE_FAIL ? 1 : 0);
`;

/**
 * A throwaway repository with the real commit-msg hook installed through
 * core.hooksPath and fake npm gates. Global and system Git configuration are
 * replaced so the developer's real settings neither leak in nor change.
 */
function repository(t) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "commit-msg-hook-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo");
  const gateLog = path.join(dir, "gates.log");
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(dir, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GATE_LOG: gateLog,
  };
  delete env.GATE_FAIL;
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  const run = (
    args,
    { cwd = fs.existsSync(root) ? root : dir, extraEnv = {} } = {},
  ) =>
    spawnSync("git", args, {
      cwd,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
    });
  const git = (...args) => {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main", root);
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  fs.mkdirSync(path.join(root, ".githooks"));
  fs.copyFileSync(hookSource, path.join(root, ".githooks/commit-msg"));
  fs.chmodSync(path.join(root, ".githooks/commit-msg"), 0o755);
  git("config", "core.hooksPath", ".githooks");
  fs.writeFileSync(path.join(root, "gate.cjs"), GATE_SCRIPT);
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({
      private: true,
      scripts: {
        format: "node gate.cjs format",
        lint: "node gate.cjs lint",
        typecheck: "node gate.cjs typecheck",
      },
    })}\n`,
  );
  return {
    root,
    git,
    run,
    /** Commit every change with the given message; returns the spawn result. */
    commit: (message, { fail = false, cwd = root, args = [] } = {}) => {
      run(["add", "-A"], { cwd });
      return run(["commit", "--allow-empty", ...args, "-m", message], {
        cwd,
        extraEnv: fail ? { GATE_FAIL: "1" } : {},
      });
    },
    /** Gates run since the last call, then reset the log. */
    takeGates: () => {
      const gates = fs.existsSync(gateLog)
        ? fs.readFileSync(gateLog, "utf8").split("\n").filter(Boolean)
        : [];
      fs.rmSync(gateLog, { force: true });
      return gates;
    },
    head: () => git("log", "-1", "--format=%s"),
  };
}

test(
  "commit-msg skips the gates on the first commit when its message has [skip-hooks]",
  { skip: consumerHooks },
  (t) => {
    const repo = repository(t);
    const result = repo.commit("first commit [skip-hooks]", { fail: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /skipped: \[skip-hooks\]/);
    assert.deepEqual(repo.takeGates(), []);
    assert.equal(repo.head(), "first commit [skip-hooks]");
  },
);

test(
  "commit-msg runs the gates on a normal commit after a [skip-hooks] commit",
  { skip: consumerHooks },
  (t) => {
    const repo = repository(t);
    assert.equal(repo.commit("earlier commit [skip-hooks]").status, 0);
    repo.takeGates();

    const rejected = repo.commit("normal commit", { fail: true });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /FAILED: npm run format/);
    assert.deepEqual(repo.takeGates(), ["format"]);
    assert.equal(repo.head(), "earlier commit [skip-hooks]");

    const accepted = repo.commit("normal commit");
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(repo.takeGates(), ["format", "lint", "typecheck"]);
    assert.equal(repo.head(), "normal commit");
  },
);

// Simulates an interactive editor: prepends EDIT_PREFIX to the message file
// Git prepared (its comment template and, with -v, the scissors line and diff).
const EDITOR_SCRIPT = `#!/bin/sh
{ printf '%s\\n' "$EDIT_PREFIX"; cat "$1"; } > "$1.tmp" && mv "$1.tmp" "$1"
`;

/**
 * Commit with the given git arguments and failing gates, then check that the
 * hook skipped exactly when the recorded commit message keeps the marker.
 */
function commitAndCompare(repo, args, extraEnv = {}) {
  repo.takeGates();
  const result = repo.run(["commit", "--allow-empty", ...args], {
    extraEnv: { GATE_FAIL: "1", ...extraEnv },
  });
  const gates = repo.takeGates();
  if (result.status !== 0) {
    // Gates ran and blocked the commit; record it with passing gates to see
    // the message Git would have kept.
    assert.deepEqual(gates, ["format"]);
    const recorded = repo.run(["commit", "--allow-empty", ...args], {
      extraEnv,
    });
    assert.equal(recorded.status, 0, recorded.stderr);
    repo.takeGates();
    return { skipped: false, message: repo.git("log", "-1", "--format=%B") };
  }
  assert.deepEqual(gates, []);
  return { skipped: true, message: repo.git("log", "-1", "--format=%B") };
}

test(
  "commit-msg ignores [skip-hooks] that Git strips from an edited message",
  { skip: consumerHooks },
  (t) => {
    const repo = repository(t);
    assert.equal(repo.commit("init").status, 0);
    const editor = path.join(repo.root, "..", "editor.sh");
    fs.writeFileSync(editor, EDITOR_SCRIPT, { mode: 0o755 });
    // A tracked change that itself mentions the marker shows up in `-v` output.
    fs.writeFileSync(
      path.join(repo.root, "notes.txt"),
      "use [skip-hooks] sparingly\n",
    );
    repo.git("add", "notes.txt");
    const outcome = commitAndCompare(repo, ["-v"], {
      GIT_EDITOR: editor,
      EDIT_PREFIX: "add notes\n\n# my own note [skip-hooks]",
    });
    assert.equal(outcome.skipped, false);
    assert.equal(outcome.message, "add notes");
  },
);

for (const scenario of [
  {
    name: "a comment-like paragraph kept by -m",
    args: ["-m", "subject", "-m", "# [skip-hooks]"],
  },
  {
    name: "text below a literal scissors line in -F input",
    file: [
      "subject",
      "",
      "# ------------------------ >8 ------------------------",
      "[skip-hooks]",
      "",
    ],
  },
  {
    name: "a comment line of an edited message under commit.cleanup=verbatim",
    config: ["commit.cleanup", "verbatim"],
    edit: "subject\n\n# [skip-hooks]",
  },
]) {
  test(
    `commit-msg honors [skip-hooks] that Git keeps: ${scenario.name}`,
    { skip: consumerHooks },
    (t) => {
      const repo = repository(t);
      assert.equal(repo.commit("init").status, 0);
      let args = scenario.args ?? [];
      const extraEnv = {};
      if (scenario.file) {
        const messageFile = path.join(repo.root, "..", "message.txt");
        fs.writeFileSync(messageFile, scenario.file.join("\n"));
        args = ["-F", messageFile];
      }
      if (scenario.config) repo.git("config", ...scenario.config);
      if (scenario.edit) {
        const editor = path.join(repo.root, "..", "editor.sh");
        fs.writeFileSync(editor, EDITOR_SCRIPT, { mode: 0o755 });
        Object.assign(extraEnv, {
          GIT_EDITOR: editor,
          EDIT_PREFIX: scenario.edit,
        });
      }
      const outcome = commitAndCompare(repo, args, extraEnv);
      assert.ok(outcome.message.includes("[skip-hooks]"), outcome.message);
      assert.equal(outcome.skipped, true);
    },
  );
}

test(
  "commit-msg skips the gates for a [skip-hooks] first commit in a new linked worktree",
  { skip: consumerHooks },
  (t) => {
    const repo = repository(t);
    assert.equal(repo.commit("init").status, 0);
    repo.takeGates();
    const worktree = path.join(repo.root, "..", "linked");
    repo.git("worktree", "add", "-q", "-b", "feature", worktree);

    const skipped = repo.commit("worktree first commit [skip-hooks]", {
      cwd: worktree,
      fail: true,
    });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.deepEqual(repo.takeGates(), []);

    const gated = repo.commit("worktree second commit", {
      cwd: worktree,
      fail: true,
    });
    assert.notEqual(gated.status, 0);
    assert.deepEqual(repo.takeGates(), ["format"]);
  },
);

test(
  "commit-msg still skips the gates while a merge is being concluded",
  { skip: consumerHooks },
  (t) => {
    const repo = repository(t);
    fs.writeFileSync(path.join(repo.root, "file.txt"), "base\n");
    assert.equal(repo.commit("base").status, 0);
    repo.git("checkout", "-q", "-b", "side");
    fs.writeFileSync(path.join(repo.root, "file.txt"), "side\n");
    assert.equal(repo.commit("side change").status, 0);
    repo.git("checkout", "-q", "main");
    fs.writeFileSync(path.join(repo.root, "file.txt"), "main\n");
    assert.equal(repo.commit("main change").status, 0);
    repo.takeGates();

    const merge = repo.run(["merge", "--no-edit", "side"]);
    assert.notEqual(merge.status, 0, "fixture merge should conflict");
    fs.writeFileSync(path.join(repo.root, "file.txt"), "resolved\n");
    repo.git("add", "file.txt");
    const concluded = repo.run(["commit", "--no-edit"], {
      extraEnv: { GATE_FAIL: "1" },
    });
    assert.equal(concluded.status, 0, concluded.stderr);
    assert.deepEqual(repo.takeGates(), []);
  },
);
