import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeEpisodeData,
  buildDatasetFromTelemetryEvents,
  EvaluationPolicy,
  LLMRankedPolicy,
  OfflineReplayEngine,
} from "../../scripts/project-issue-offline-eval.mjs";

test("sanitizeEpisodeData strips prohibited raw fields", () => {
  const dirty = {
    issue_id: "444",
    title: "Raw issue title",
    prompt: "Sensitive prompt text",
    diff: "diff --git a/b",
    credentials: "secret_token",
    clean_field: "allowed_value",
    nested: {
      password: "123",
      code: "raw code",
      valid_key: 100,
    },
  };

  const cleaned = sanitizeEpisodeData(dirty);
  assert.equal(cleaned.issue_id, "444");
  assert.equal(cleaned.clean_field, "allowed_value");
  assert.equal(cleaned.nested.valid_key, 100);
  assert.equal(cleaned.title, undefined);
  assert.equal(cleaned.prompt, undefined);
  assert.equal(cleaned.diff, undefined);
  assert.equal(cleaned.credentials, undefined);
  assert.equal(cleaned.nested.password, undefined);
  assert.equal(cleaned.nested.code, undefined);
});

test("buildDatasetFromTelemetryEvents constructs versioned episodes", () => {
  const events = [
    {
      event_type: "route_decision",
      run_id: "run-100",
      issue_id: "444",
      mode: "multi-agent",
      assigned_agent: "Codex",
      timestamp: "2026-07-23T10:00:00Z",
    },
    {
      event_type: "role_execution",
      run_id: "run-100",
      issue_id: "444",
      role: "implementer",
      agent: "Codex",
      tokens: { total: 1000 },
      latency_ms: 1200,
      timestamp: "2026-07-23T10:01:00Z",
    },
    {
      event_type: "terminal_outcome",
      run_id: "run-100",
      issue_id: "444",
      terminal_status: "merged",
      pr_state: "merged",
      gate_passed: true,
      timestamp: "2026-07-23T10:02:00Z",
    },
  ];

  const dataset = buildDatasetFromTelemetryEvents(events, { datasetVersion: "1.2.0" });
  assert.equal(dataset.dataset_version, "1.2.0");
  assert.equal(dataset.total_episodes, 1);
  const ep = dataset.episodes[0];
  assert.equal(ep.issue_id, "444");
  assert.equal(ep.selected_configuration.execution_mode, "multi-agent");
  assert.equal(ep.selected_configuration.assigned_agent, "Codex");
  assert.equal(ep.terminal_outcome.terminal_status, "merged");
});

test("OfflineReplayEngine evaluates policies and computes quality & efficiency metrics", () => {
  const events = [
    {
      event_type: "route_decision",
      run_id: "run-101",
      issue_id: "444",
      mode: "direct-review",
      assigned_agent: "Codex",
      timestamp: "2026-07-23T10:00:00Z",
    },
    {
      event_type: "role_execution",
      run_id: "run-101",
      issue_id: "444",
      role: "implementer",
      agent: "Codex",
      tokens: { total: 2000 },
      latency_ms: 1500,
    },
    {
      event_type: "terminal_outcome",
      run_id: "run-101",
      issue_id: "444",
      terminal_status: "merged",
      pr_state: "merged",
      gate_passed: true,
    },
  ];

  const dataset = buildDatasetFromTelemetryEvents(events);
  const engine = new OfflineReplayEngine();
  const rulePolicy = new EvaluationPolicy("baseline-rule-based");
  const llmPolicy = new LLMRankedPolicy("candidate-llm-ranked");

  const evalSummary = engine.evaluateDataset(dataset, [rulePolicy, llmPolicy]);
  assert.equal(evalSummary.policies.length, 2);

  const baselineRes = evalSummary.policies.find((p) => p.policy_name === "baseline-rule-based");
  assert.equal(baselineRes.quality_metrics.terminal_success_rate, 1.0);
  assert.equal(baselineRes.quality_metrics.pr_merge_rate, 1.0);
  assert.equal(baselineRes.efficiency_metrics.total_tokens, 2000);
  assert.ok(baselineRes.sample_size_warning.includes("Sample size N < 10"));

  const reportText = engine.formatReport(evalSummary);
  assert.ok(reportText.includes("# Offline Evaluation & Quality-Token Frontier Report"));
  assert.ok(reportText.includes("baseline-rule-based"));
});

test("OfflineReplayEngine disqualifies out-of-bounds candidates", () => {
  const invalidEpisode = {
    episode_id: "ep-999",
    issue_id: "999",
    eligible_modes: ["single-agent"],
    eligible_routes: ["Codex"],
    selected_configuration: { execution_mode: "single-agent", assigned_agent: "Codex" },
  };

  class BadPolicy extends EvaluationPolicy {
    selectConfiguration() {
      return {
        execution_mode: "invalid-mode",
        implementer_route: "UnknownAgent",
      };
    }
  }

  const engine = new OfflineReplayEngine();
  const result = engine.replayEpisode(invalidEpisode, new BadPolicy());
  assert.equal(result.disqualified, true);
  assert.equal(result.disqualification_reason, "CANDIDATE_OUT_OF_BOUNDS");
});
