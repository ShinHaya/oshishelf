import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeRegistry, findRuntime } from "../../scripts/ai-template/registry.mjs";
import { generate } from "../../scripts/ai-template/generate.mjs";
import { run } from "../../scripts/ai-template.mjs";
import { discoverCapabilities, loadOrRefreshCapabilities, verifyWorkerRoute } from "../../scripts/issue-capabilities.mjs";
import { launchWithAdapter } from "../../scripts/issue-runtime-adapters/index.mjs";
import { canonicalizeAgent, isKnownAgent } from "../../scripts/issue-assignment.mjs";
import { selectWorkerRoutes } from "../../scripts/issue-plan.mjs";
import { buildDatasetFromTelemetryEvents } from "../../scripts/issue-offline-eval.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const put = (root, file, value) => { fs.mkdirSync(path.dirname(path.join(root,file)), { recursive: true }); fs.writeFileSync(path.join(root,file), typeof value === "string" ? value : JSON.stringify(value)); };
function fixture(t, enabled = ["codex", "claude", "gemini"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(source, "agents"), path.join(root, "agents"), { recursive: true });
  put(root, "skills/example/SKILL.md", "---\nname: example\n---\nFake skill\n");
  put(root, ".ai-template/config.json", { agents: { enabled } });
  return root;
}
function external(calls = []) {
  return {
    resolveExecutable: async name => { calls.push(["resolve", name]); return path.isAbsolute(name) ? name : `/fake/${name}`; },
    runProcess: async (cli, args) => {
      calls.push([cli, ...args]);
      if (args.includes("--version")) return { code: 0, stdout: "fixture-v1" };
      if (args.includes("status")) return { code: 0, stdout: '{"loggedIn":true}' };
      return { code: 0, stdout: cli.endsWith("opencode") ? "fiction/model\n" : '["model"]' };
    },
    headlessExecProbe: async ({cliPath, args}) => { calls.push(["probe", cliPath, ...args]); return { ok: true }; },
  };
}

test("new declaration alone participates in alias resolution, discovery, dispatch and offline selection", async t => {
  const root = fixture(t, ["fiction"]);
  const definition = { ...JSON.parse(fs.readFileSync(path.join(root,"agents/runtimes/opencode.json"),"utf8")), id: "fiction", name: "Fiction", aliases: ["fiction-cli"], commands: ["fiction"], models: { args: ["models"], parser: "json-models" } };
  put(root, ".ai-template/runtimes/fiction.json", definition);
  assert.equal(findRuntime("fiction-cli", root).id, "fiction");
  assert.equal(canonicalizeAgent("FICTION-CLI", root), "Fiction");
  assert.equal(isKnownAgent("fiction", root), true);
  const discovered = await discoverCapabilities({ cwd: root, ...external() });
  assert.deepEqual(discovered.capabilities.map(r => r.agent), ["Fiction", "Fiction"]);
  assert.deepEqual(selectWorkerRoutes(discovered.capabilities, { cwd: root }).map(r => r.model), ["model"]);
  assert.deepEqual(selectWorkerRoutes(discovered.capabilities, { cwd: root, unavailableAgents: ["fiction-cli"] }), []);
  const route = discovered.capabilities[0];
  let launched;
  await launchWithAdapter("fiction-cli", { ...route, issueNumber: 123, cwd: root, releasePolicy: "merged" }, {
    ...external(), spawnWorker: async (cli,args) => { launched = { cli, args }; return { code: 0 }; },
  });
  assert.equal(launched.cli, "/fake/fiction");
  assert.deepEqual(launched.args.slice(0,4), ["run", "--model", "model", "--auto"]);
  const dataset = buildDatasetFromTelemetryEvents([{ issue_id: "123" }], { cwd: root });
  assert.deepEqual(dataset.episodes[0].eligible_routes, ["Fiction"]);
});

test("OpenCode addition and enablement needs no script or skill changes", async t => {
  const root = fixture(t, ["codex"]);
  const opencode = fs.readFileSync(path.join(root,"agents/runtimes/opencode.json"));
  fs.unlinkSync(path.join(root,"agents/runtimes/opencode.json"));
  assert.equal(run(["agents","list"],root).some(r => r.id === "opencode"), false);
  // The only inputs changed are one definition and agents.enabled.
  put(root,"agents/runtimes/opencode.json",opencode.toString());
  put(root,".ai-template/config.json",{agents:{enabled:["opencode"]}});
  const result = await discoverCapabilities({cwd:root,...external()});
  assert.equal(result.capabilities[0].selector, "/fake/opencode run --model fiction/model --auto");
  assert.equal((await verifyWorkerRoute(result.capabilities[0],{cwd:root,...external()})).ok,true);
  assert.equal(run(["agents","list"],root).find(r=>r.id==="opencode").status,"enabled");
  generate(root);
  assert.equal(fs.readlinkSync(path.join(root,".opencode/skills/example")),"../../skills/example");
  const agent = fs.readFileSync(path.join(root,".opencode/agents/deep-reasoner.md"),"utf8");
  assert.match(agent,/mode: "subagent"/);
  assert.match(agent,/"\*":\s*"deny"/);
  assert.match(agent,/AGENTS.md/);
});

test("disabling a runtime removes owned outputs, invalidates its cache and never probes it", async t => {
  const root=fixture(t,["gemini"]), calls=[];
  // Give this fixture a dedicated discovery directory to observe deletion.
  const p=path.join(root,"agents/runtimes/gemini.json"), def=JSON.parse(fs.readFileSync(p,"utf8"));
  def.skills.discoveryDirs=[".fixture/skills"]; put(root,"agents/runtimes/gemini.json",def);
  generate(root);
  const cachePath=path.join(root,"cache.json");
  await discoverCapabilities({cwd:root,outputPath:cachePath,...external(calls)});
  put(root,".ai-template/config.json",{agents:{enabled:[]}});
  const previousRoute=JSON.parse(fs.readFileSync(cachePath,"utf8")).capabilities[0];
  assert.deepEqual(selectWorkerRoutes([previousRoute], {cwd:root}),[]);
  calls.length=0;
  const result=await loadOrRefreshCapabilities({cwd:root,cachePath,...external(calls)});
  assert.equal(result.reused,false); assert.deepEqual(result.capabilities,[]); assert.deepEqual(calls,[]);
  generate(root);
  assert.equal(fs.existsSync(path.join(root,".fixture/skills/example")),false);
  await assert.rejects(launchWithAdapter("gemini",{cwd:root,selector:"gemini --model model"}),/adapter-unavailable/);
});

test("generation is idempotent, deduplicates shared paths and preserves custom settings and local skills", t => {
  const root=fixture(t,["codex","grok","claude"]);
  put(root,".claude/settings.json",{env:{FAKE:"kept"},hooks:{PreToolUse:[{matcher:"Read",hooks:[{type:"command",command:"echo custom"}]}]}});
  put(root,"skills/local-example/SKILL.md","Fake local skill");
  put(root,".ai-template/config.json",{agents:{enabled:["codex","grok","claude"]},localSkills:["local-example"]});
  generate(root);
  const before=fs.readFileSync(path.join(root,".ai-template/generated.json"),"utf8");
  assert.equal(generate(root).written,0);
  assert.equal(fs.readFileSync(path.join(root,".ai-template/generated.json"),"utf8"),before);
  assert.equal(fs.readlinkSync(path.join(root,".agents/skills/local-example")),"../../skills/local-example");
  const settings=JSON.parse(fs.readFileSync(path.join(root,".claude/settings.json"),"utf8"));
  assert.deepEqual(settings.env,{FAKE:"kept"});assert.equal(settings.hooks.PreToolUse.length,2);
  put(root,".ai-template/config.json",{agents:{enabled:["grok"]}});
  generate(root);
  assert.equal(fs.existsSync(path.join(root,".agents/skills/example")),true);
  assert.equal(fs.existsSync(path.join(root,".claude/skills/example")),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,".claude/settings.json"),"utf8")).hooks.PreToolUse[0].matcher,"Read");
});

test("generation refuses unmanaged and edited files before writing any output", t=>{
  const root=fixture(t,["claude"]);
  put(root,".claude/agents/fast-worker.md","repo-owned text");
  assert.throws(()=>generate(root),/generated-collision/);
  assert.equal(fs.existsSync(path.join(root,".claude/skills")),false);
  fs.unlinkSync(path.join(root,".claude/agents/fast-worker.md"));generate(root);
  put(root,".claude/agents/fast-worker.md","edited text");
  put(root,".ai-template/config.json",{agents:{enabled:[]}});
  assert.throws(()=>generate(root),/generated-edited/);
  assert.equal(fs.readFileSync(path.join(root,".claude/agents/fast-worker.md"),"utf8"),"edited text");
});

test("generation rejects symlink parent escapes",t=>{
  const root=fixture(t,["claude"]),outside=fs.mkdtempSync(path.join(os.tmpdir(),"outside-"));
  t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.symlinkSync(outside,path.join(root,".claude"));
  assert.throws(()=>generate(root),/generated-parent-unsafe/);
  assert.deepEqual(fs.readdirSync(outside),[]);
});

test("invalid definitions/configuration and retired aliases fail before discovery",async t=>{
  const root=fixture(t,[]);
  for(const config of [{agents:{enabled:["absent"]}},{agents:{enabled:["agy"]}},{agents:{enabled:["claude-code"]}},{agents:null},{localSkills:["../escape"]},{toString:"unknown-field"}]){
    put(root,".ai-template/config.json",config);
    await assert.rejects(discoverCapabilities({cwd:root,resolveExecutable:()=>assert.fail("must not spawn")}),/runtime-/);
  }
  put(root,".ai-template/config.json",{agents:{enabled:[]}});
  const base=JSON.parse(fs.readFileSync(path.join(root,"agents/runtimes/opencode.json"),"utf8"));
  for(const change of [{id:"other",aliases:["claude-code"]},{id:"other",skills:{discoveryDirs:["../escape"]}},{id:"other",models:{parser:"arbitrary-code",args:[]}}]){
    put(root,".ai-template/runtimes/other.json",{...base,...change});
    assert.throws(()=>loadRuntimeRegistry(root),/runtime-/);
  }
  fs.rmSync(path.join(root,".ai-template/runtimes"),{recursive:true});
  await assert.rejects(launchWithAdapter("agy",{cwd:root,selector:"agy --model model"}),/runtime-retired/);
});


test("interrupted generation can adopt exact completed outputs without duplicating hooks", t => {
  const root=fixture(t,["claude"]);
  generate(root);
  fs.unlinkSync(path.join(root,".ai-template/generated.json"));
  assert.equal(generate(root).written,0);
  const hooks=JSON.parse(fs.readFileSync(path.join(root,".claude/settings.json"),"utf8")).hooks.PreToolUse;
  assert.equal(hooks.length,1);
});
