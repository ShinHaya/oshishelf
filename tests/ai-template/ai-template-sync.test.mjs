import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  check,
  compilePattern,
  listManagedFiles,
  renderSyncSummary,
  sync,
} from "../../scripts/ai-template/sync.mjs";
import { loadConsumers } from "../../scripts/ai-template/consumers.mjs";
import { generate } from "../../scripts/ai-template/generate.mjs";
import { run } from "../../scripts/ai-template.mjs";

const source = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const cli = path.join(source, "scripts/ai-template.mjs");
const put = (root, file, value, mode) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(
    path.join(root, file),
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(value),
  );
  if (mode) fs.chmodSync(path.join(root, file), mode);
};
const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const commit = (root) => {
  git(root, "add", "-A");
  git(
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  return git(root, "rev-parse", "HEAD").trim();
};
const temp = (t, prefix) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
function template(
  t,
  managed = ["scripts/*.mjs", "skills/shared/**", "bin/tool.sh"],
) {
  const root = temp(t, "ai-template-source-");
  git(root, "init", "-q");
  put(root, "ai-template.manifest.json", { version: 1, managed });
  put(root, "scripts/one.mjs", "export const one = 1;\n");
  put(root, "scripts/two.mjs", "export const two = 2;\n");
  put(
    root,
    "skills/shared/SKILL.md",
    "---\nname: shared\n---\nFixture skill\n",
  );
  put(root, "bin/tool.sh", "#!/bin/sh\necho fixture\n", 0o755);
  put(root, "README.md", "not managed\n");
  return { root, commit: commit(root) };
}
function consumer(t, config) {
  const root = temp(t, "ai-template-consumer-");
  if (config) put(root, ".ai-template/config.json", config);
  return root;
}

test("patterns keep * inside a segment and ** across segments, and reject unsafe roots", () => {
  assert.equal(
    compilePattern("scripts/issue-*.mjs").test("scripts/issue-plan.mjs"),
    true,
  );
  assert.equal(
    compilePattern("scripts/issue-*.mjs").test("scripts/nested/issue-plan.mjs"),
    false,
  );
  assert.equal(
    compilePattern("skills/a/**").test("skills/a/references/x.md"),
    true,
  );
  assert.equal(compilePattern("skills/a/**").test("skills/ab/SKILL.md"), false);
  assert.equal(
    compilePattern("tests/**/fixture.json").test("tests/fixture.json"),
    true,
  );
  for (const bad of [
    ".ai-template/**",
    ".git/config",
    ".github/workflows/ci.yml",
    "a/**b",
    "../x",
    "/abs",
    "ai-template.manifest.json",
  ])
    assert.throws(
      () => compilePattern(bad),
      /manifest-pattern-invalid|runtime-path-invalid/,
      bad,
    );
});

test("first sync copies managed files with modes and writes a deterministic lock", (t) => {
  const { root: from, commit: sha } = template(t);
  const root = consumer(t);
  const result = sync({ from, root, sourceRepository: "example/template" });
  assert.deepEqual(result.written, [
    "bin/tool.sh",
    "scripts/one.mjs",
    "scripts/two.mjs",
    "skills/shared/SKILL.md",
  ]);
  assert.equal(result.from, null);
  assert.equal(result.to, sha);
  assert.equal(fs.existsSync(path.join(root, "README.md")), false);
  assert.notEqual(fs.statSync(path.join(root, "bin/tool.sh")).mode & 0o111, 0);
  assert.equal(fs.statSync(path.join(root, "scripts/one.mjs")).mode & 0o111, 0);
  const lock = JSON.parse(read(root, ".ai-template/lock.json"));
  assert.deepEqual(lock.source, {
    repository: "example/template",
    commit: sha,
  });
  assert.deepEqual(lock.files["bin/tool.sh"].executable, true);
  const before = read(root, ".ai-template/lock.json");
  const again = sync({ from, root, sourceRepository: "example/template" });
  assert.deepEqual([again.written, again.removed, again.drift], [[], [], []]);
  assert.equal(read(root, ".ai-template/lock.json"), before);
});

test("template deletions propagate and prune empty directories; repo-owned files survive", (t) => {
  const { root: from } = template(t);
  const root = consumer(t);
  put(root, "skills/local/SKILL.md", "repo-owned\n");
  sync({ from, root });
  fs.rmSync(path.join(from, "skills/shared"), { recursive: true });
  const sha = commit(from);
  const result = sync({ from, root });
  assert.deepEqual(result.removed, ["skills/shared/SKILL.md"]);
  assert.equal(result.to, sha);
  assert.equal(fs.existsSync(path.join(root, "skills/shared")), false);
  assert.equal(read(root, "skills/local/SKILL.md"), "repo-owned\n");
  assert.equal(
    JSON.parse(read(root, ".ai-template/lock.json")).files[
      "skills/shared/SKILL.md"
    ],
    undefined,
  );
});

test("a repo-owned file at a newly managed path fails unless adoption is explicit", (t) => {
  const { root: from } = template(t);
  const root = consumer(t);
  put(root, "scripts/one.mjs", "consumer copy\n");
  assert.throws(
    () => sync({ from, root }),
    /managed-collision:scripts\/one\.mjs/,
  );
  assert.equal(read(root, "scripts/one.mjs"), "consumer copy\n");
  assert.equal(
    fs.existsSync(path.join(root, "scripts/two.mjs")),
    false,
    "nothing is written before validation completes",
  );
  const result = sync({ from, root, adopt: true });
  assert.deepEqual(result.adopted, ["scripts/one.mjs"]);
  assert.equal(read(root, "scripts/one.mjs"), "export const one = 1;\n");
});

test("byte-identical existing files are adopted without --adopt", (t) => {
  const { root: from } = template(t);
  const root = consumer(t);
  put(root, "scripts/one.mjs", "export const one = 1;\n");
  const result = sync({ from, root });
  assert.equal(result.written.includes("scripts/one.mjs"), false);
});

test("local skills and non-file destinations are never overwritten, even when adopting", (t) => {
  const { root: from } = template(t);
  const root = consumer(t, { localSkills: ["shared"] });
  put(root, "skills/shared/SKILL.md", "repo-owned\n");
  assert.throws(
    () => sync({ from, root, adopt: true }),
    /managed-collision:skills\/shared\/SKILL\.md/,
  );
  const other = consumer(t);
  fs.mkdirSync(path.join(other, "scripts/one.mjs"), { recursive: true });
  assert.throws(
    () => sync({ from, root: other, adopt: true }),
    /managed-collision:scripts\/one\.mjs/,
  );
  const linked = consumer(t);
  fs.symlinkSync(os.tmpdir(), path.join(linked, "scripts"));
  assert.throws(() => sync({ from, root: linked }), /parent-unsafe/);
});

test("a skill declared local after adoption is not deleted when the template drops it", (t) => {
  const { root: from } = template(t);
  const root = consumer(t);
  sync({ from, root });
  put(root, ".ai-template/config.json", { localSkills: ["shared"] });
  put(root, "skills/shared/SKILL.md", "now repo-owned\n");
  fs.rmSync(path.join(from, "skills/shared"), { recursive: true });
  commit(from);
  const lock = read(root, ".ai-template/lock.json");
  assert.throws(
    () => sync({ from, root }),
    /managed-collision:skills\/shared\/SKILL\.md/,
  );
  assert.equal(read(root, "skills/shared/SKILL.md"), "now repo-owned\n");
  assert.equal(read(root, ".ai-template/lock.json"), lock);
});

test("wildcards cannot reach workflows, repo-owned state or the manifest", (t) => {
  for (const pattern of [".github/**", ".ai-*/**", "*.json"]) {
    const { root: from } = template(t, [pattern, "scripts/*.mjs"]);
    put(from, ".github/workflows/ci.yml", "name: ci\n");
    put(from, ".ai-template/config.json", "{}\n");
    commit(from);
    const root = consumer(t);
    assert.throws(
      () => sync({ from, root, adopt: true }),
      /managed-path-forbidden/,
      pattern,
    );
    assert.deepEqual(
      fs.readdirSync(root),
      [],
      `${pattern}: nothing is written`,
    );
  }
  const root = consumer(t);
  put(root, ".ai-template/lock.json", {
    version: 1,
    source: { commit: "x" },
    files: {
      ".github/workflows/ci.yml": { sha256: "0".repeat(64), executable: false },
    },
  });
  const { root: from } = template(t);
  assert.throws(
    () => sync({ from, root }),
    /managed-path-forbidden:\.github\/workflows\/ci\.yml/,
  );
});

test("local edits to managed files are reverted to the template and reported as drift", (t) => {
  const { root: from } = template(t);
  const root = consumer(t);
  sync({ from, root });
  put(root, "scripts/one.mjs", "edited here\n");
  fs.unlinkSync(path.join(root, "scripts/two.mjs"));
  fs.chmodSync(path.join(root, "bin/tool.sh"), 0o644);
  const result = sync({ from, root });
  assert.deepEqual(result.drift, [
    "bin/tool.sh",
    "scripts/one.mjs",
    "scripts/two.mjs",
  ]);
  assert.equal(read(root, "scripts/one.mjs"), "export const one = 1;\n");
  assert.notEqual(fs.statSync(path.join(root, "bin/tool.sh")).mode & 0o111, 0);
  const summary = renderSyncSummary(result, {
    sourceRepository: "example/template",
  });
  assert.match(summary, /reverted to the template \(3\)/);
  assert.match(summary, /`scripts\/one\.mjs`/);
});

test("the source must be a clean Git checkout without managed symlinks", (t) => {
  const { root: from } = template(t);
  const root = consumer(t);
  put(from, "scripts/one.mjs", "uncommitted\n");
  assert.throws(
    () => sync({ from, root }),
    /ai-template-source-dirty:scripts\/one\.mjs/,
  );
  git(from, "checkout", "--", "scripts/one.mjs");
  put(from, "scripts/new.mjs", "untracked\n");
  assert.throws(
    () => sync({ from, root }),
    /ai-template-source-dirty:scripts\/new\.mjs/,
  );
  fs.unlinkSync(path.join(from, "scripts/new.mjs"));
  put(from, "README.md", "unmanaged edits do not block\n");
  assert.equal(sync({ from, root }).written.length, 4);
  git(from, "checkout", "--", "README.md");
  assert.throws(() => sync({ from, root: from }), /ai-template-sync-self/);
  assert.throws(
    () => sync({ from: path.join(from, "scripts"), root }),
    /ai-template-source-not-toplevel/,
  );
  fs.symlinkSync("one.mjs", path.join(from, "scripts/link.mjs"));
  commit(from);
  assert.throws(
    () => sync({ from, root }),
    /managed-not-regular:scripts\/link\.mjs/,
  );
});

test("check reports modified, missing and stale files; the CLI exits non-zero", (t) => {
  const { root: from } = template(t);
  const root = consumer(t, { agents: { enabled: [] } });
  sync({ from, root });
  generate(root);
  assert.deepEqual(check(root), { ok: true, problems: [] });
  put(root, "scripts/one.mjs", "edited here\n");
  fs.unlinkSync(path.join(root, "scripts/two.mjs"));
  fs.unlinkSync(path.join(root, ".ai-template/generated.json"));
  const result = check(root);
  assert.deepEqual(result.problems, [
    "managed-modified:scripts/one.mjs",
    "managed-missing:scripts/two.mjs",
    "generated-stale:.ai-template/generated.json",
  ]);
  const child = spawnSync(process.execPath, [cli, "check", "--root", root], {
    encoding: "utf8",
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /template repository/);
  put(root, ".ai-template/lock.json", "{");
  assert.deepEqual(check(root).problems.slice(0, 1), ["lock-invalid"]);
});

test("check in a template validates manifest coverage and the consumer list", (t) => {
  const { root: from } = template(t, ["scripts/*.mjs", "missing/**"]);
  put(from, ".ai-template/config.json", { agents: { enabled: [] } });
  generate(from);
  put(from, "sync/consumers.json", {
    consumers: [{ repo: "example/one", base: "main" }],
  });
  assert.deepEqual(check(from).problems, [
    "manifest-pattern-unmatched:missing/**",
  ]);
  put(from, "sync/consumers.json", {
    consumers: [{ repo: "example/one", base: "main", extra: 1 }],
  });
  assert.deepEqual(check(from).problems, [
    "manifest-pattern-unmatched:missing/**",
    "consumers-invalid:consumers[0]",
  ]);
});

test("consumer list entries are validated, deduplicated and default to manual merge", (t) => {
  const root = temp(t, "ai-template-consumers-");
  const file = path.join(root, "consumers.json");
  const load = (value) => {
    put(root, "consumers.json", value);
    return loadConsumers(file);
  };
  assert.deepEqual(
    load({ consumers: [{ repo: "example/one", base: "develop" }] }),
    [{ repo: "example/one", base: "develop", autoMerge: false }],
  );
  assert.throws(
    () =>
      load({
        consumers: [
          { repo: "example/one", base: "main" },
          { repo: "Example/One", base: "main" },
        ],
      }),
    /repo-duplicate/,
  );
  assert.throws(
    () => load({ consumers: [{ repo: "example", base: "main" }] }),
    /consumers\[0\]\.repo/,
  );
  assert.throws(
    () => load({ consumers: [{ repo: "example/one", base: "bad..name" }] }),
    /consumers\[0\]\.base/,
  );
  assert.throws(
    () => load({ consumers: [{ repo: "example/one", base: "-x" }] }),
    /consumers\[0\]\.base/,
  );
  assert.throws(
    () =>
      load({
        consumers: [{ repo: "example/one", base: "main", autoMerge: "yes" }],
      }),
    /autoMerge/,
  );
  assert.throws(() => load({ consumers: {} }), /consumers-invalid:root/);
  put(root, "sync/consumers.json", {
    consumers: [
      { repo: "example/one", base: "main" },
      { repo: "example/two", base: "develop", autoMerge: true },
    ],
  });
  assert.deepEqual(run(["consumers", "--repo", "EXAMPLE/two"], root), [
    { repo: "example/two", base: "develop", autoMerge: true },
  ]);
  assert.throws(
    () => run(["consumers", "--repo", "example/three"], root),
    /consumers-repo-unknown/,
  );
});

test("PR summary states the source range and never includes file contents", () => {
  const summary = renderSyncSummary(
    {
      from: "a".repeat(40),
      to: "b".repeat(40),
      written: ["scripts/one.mjs"],
      removed: [],
      drift: [],
      adopted: [],
    },
    { sourceRepository: "example/template" },
  );
  assert.match(summary, /compare\/a{40}\.\.\.b{40}/);
  assert.match(summary, /### Written \(1\)/);
  assert.doesNotMatch(summary, /Removed/);
  assert.match(summary, /\[ \] Confirm the consumer CI runs/);
  for (const command of [
    "node scripts/ai-template.mjs check",
    "node scripts/ai-template.mjs test",
    "bash scripts/test-issue-worktree.sh",
  ])
    assert.ok(summary.includes(command));
  assert.match(summary, /does not modify consumer workflows/);
  assert.match(
    renderSyncSummary({
      from: null,
      to: "b".repeat(40),
      written: [],
      removed: [],
      drift: [],
      adopted: [],
    }),
    /\(none\)/,
  );
});

test(
  "the shipped template syncs into a fresh consumer that then passes generate and check",
  {
    skip:
      !fs.existsSync(path.join(source, "ai-template.manifest.json")) &&
      "consumer checkout has no template manifest",
  },
  (t) => {
    const from = temp(t, "ai-template-shipped-");
    git(from, "init", "-q");
    put(
      from,
      "ai-template.manifest.json",
      read(source, "ai-template.manifest.json"),
    );
    for (const { file, content, executable } of listManagedFiles(source, {
      requireClean: false,
    }).files)
      put(from, file, content, executable ? 0o755 : 0o644);
    commit(from);
    const root = consumer(t, {
      agents: { enabled: ["claude", "codex", "opencode", "grok"] },
      localSkills: ["local-fixture"],
    });
    put(
      root,
      "skills/local-fixture/SKILL.md",
      "---\nname: local-fixture\n---\nRepository-owned fixture\n",
    );
    sync({ from, root });
    generate(root);
    assert.deepEqual(check(root), { ok: true, problems: [] });
    assert.equal(
      fs.readlinkSync(path.join(root, ".claude/skills/local-fixture")),
      "../../skills/local-fixture",
    );
    assert.equal(
      fs.existsSync(path.join(root, ".opencode/agents/deep-reasoner.md")),
      true,
    );
    assert.equal(
      run(["agents", "list"], root).find((r) => r.id === "gemini").status,
      "disabled",
    );
    const lock = read(root, ".ai-template/lock.json");
    assert.deepEqual(sync({ from, root }).written, []);
    assert.equal(read(root, ".ai-template/lock.json"), lock);
    for (const file of Object.keys(JSON.parse(lock).files))
      assert.doesNotMatch(
        file,
        /^(sync\/|\.github\/|ai-template\.manifest\.json)/,
      );
  },
);
