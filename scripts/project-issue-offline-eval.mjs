import { validateTelemetryEvent } from "./project-issue-telemetry.mjs";
import { VALID_MODES } from "./project-issue-modes.mjs";

export const DEFAULT_EVAL_CONFIG = Object.freeze({
  datasetVersion: "1.0.0",
  schemaVersion: "1.0.0",
  orchestratorVersion: "1.0.0",
  policyVersion: "1.0.0",
  baselinePolicyName: "rule-based-v1",
});

/**
 * Prohibited raw data fields that must never be retained in dataset episodes.
 */
const DATASET_PROHIBITED_FIELDS = new Set([
  "prompt",
  "response",
  "body",
  "title",
  "diff",
  "code",
  "credential",
  "credentials",
  "password",
  "secret",
  "personal_data",
  "pii",
  "raw_issue_body",
  "raw_prompt",
  "raw_diff",
]);

/**
 * Validate that an episode or dataset record does not contain prohibited raw fields or sensitive PII.
 */
export function sanitizeEpisodeData(obj) {
  if (obj === null || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeEpisodeData(item));
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (DATASET_PROHIBITED_FIELDS.has(lowerKey)) {
      continue; // Strip prohibited raw fields
    }
    cleaned[key] = sanitizeEpisodeData(value);
  }
  return cleaned;
}

/**
 * Reconstruct versioned episodes from a stream/array of raw telemetry events.
 */
export function buildDatasetFromTelemetryEvents(events = [], options = {}) {
  const datasetVersion = options.datasetVersion || DEFAULT_EVAL_CONFIG.datasetVersion;
  const schemaVersion = options.schemaVersion || DEFAULT_EVAL_CONFIG.schemaVersion;

  // Group events by issue_id or correlationId
  const episodeMap = new Map();

  for (const rawEvent of events) {
    let event;
    try {
      event = validateTelemetryEvent(rawEvent);
    } catch {
      event = rawEvent; // allow raw episode event if already parsed/custom
    }

    const issueId = event.issueNumber ? String(event.issueNumber) : event.issue_id || event.run_id;
    if (!issueId) continue;

    if (!episodeMap.has(issueId)) {
      episodeMap.set(issueId, {
        episode_id: `ep-${issueId}-${event.occurredAt || event.timestamp || Date.now()}`,
        issue_id: issueId,
        run_id: event.correlationId || event.run_id || `run-${issueId}`,
        created_at: event.occurredAt || event.timestamp || new Date().toISOString(),
        issue_features: {
          issue_number: issueId,
          labels: event.payload?.issue_labels || event.issue_labels || [],
          mode_hint: event.payload?.mode || event.mode,
        },
        eligible_modes: Array.from(VALID_MODES),
        eligible_routes: ["Codex", "Claude", "Grok", "Gemini"],
        selected_configuration: {
          execution_mode: event.payload?.mode || event.mode || "direct-review",
          assigned_agent: event.payload?.selected?.agent || event.assigned_agent || "Codex",
        },
        route_decisions: [],
        role_executions: [],
        terminal_outcome: null,
      });
    }

    const episode = episodeMap.get(issueId);
    const eventType = event.type || event.event_type;

    if (eventType === "route_decision") {
      episode.route_decisions.push(event);
      const mode = event.payload?.mode || event.mode;
      const agent = event.payload?.selected?.agent || event.assigned_agent;
      if (mode) episode.selected_configuration.execution_mode = mode;
      if (agent) episode.selected_configuration.assigned_agent = agent;
    } else if (eventType === "role_execution") {
      episode.role_executions.push(event);
    } else if (eventType === "terminal_outcome") {
      episode.terminal_outcome = event.payload || event;
      if (event.occurredAt || event.timestamp) episode.updated_at = event.occurredAt || event.timestamp;
    }
  }

  const episodes = Array.from(episodeMap.values())
    .map((ep) => sanitizeEpisodeData(ep))
    .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));

  return {
    dataset_version: datasetVersion,
    schema_version: schemaVersion,
    generated_at: new Date().toISOString(),
    total_episodes: episodes.length,
    episodes,
  };
}

/**
 * Base Rule-based / Pluggable Policy Interface
 */
export class EvaluationPolicy {
  constructor(name = "rule-based-v1", version = "1.0.0") {
    this.name = name;
    this.version = version;
  }

  /**
   * Decide configuration for an episode.
   * Return { execution_mode, implementer_route, reviewer_route, retry_policy }
   */
  selectConfiguration(episode) {
    const hint = episode.issue_features?.mode_hint;
    const mode = VALID_MODES.includes(hint) ? hint : "direct-review";
    return {
      execution_mode: mode,
      implementer_route: "Codex",
      reviewer_route: mode === "single-agent" ? null : "Claude",
      retry_policy: "same-route",
    };
  }
}

/**
 * LLM-Ranked Candidate Policy Example
 */
export class LLMRankedPolicy extends EvaluationPolicy {
  constructor(name = "llm-ranked-v1", version = "1.0.0") {
    super(name, version);
  }

  selectConfiguration(episode) {
    const mode = episode.issue_features?.mode_hint || "multi-agent";
    return {
      execution_mode: mode,
      implementer_route: "Claude",
      reviewer_route: "Codex",
      retry_policy: "alternate-route",
    };
  }
}

/**
 * Replay engine for deterministic state-transition simulation on dataset episodes.
 */
export class OfflineReplayEngine {
  constructor(options = {}) {
    this.options = { ...DEFAULT_EVAL_CONFIG, ...options };
  }

  /**
   * Replay an episode against a target policy.
   */
  replayEpisode(episode, policy) {
    const candidateConfig = policy.selectConfiguration(episode);

    // Hard Invariant 1: Candidate set restriction check
    const isModeEligible = episode.eligible_modes.includes(candidateConfig.execution_mode);
    const isImplementerRouteEligible = episode.eligible_routes.includes(candidateConfig.implementer_route);
    const isReviewerRouteEligible =
      !candidateConfig.reviewer_route || episode.eligible_routes.includes(candidateConfig.reviewer_route);

    if (!isModeEligible || !isImplementerRouteEligible || !isReviewerRouteEligible) {
      return {
        episode_id: episode.episode_id,
        issue_id: episode.issue_id,
        disqualified: true,
        disqualification_reason: "CANDIDATE_OUT_OF_BOUNDS",
        policy_name: policy.name,
        policy_version: policy.version,
        terminal_success: false,
        tokens: { total: 0, implementer: 0, reviewer: 0 },
        metrics: {},
      };
    }

    // Determine counterfactual replay status
    const actualConfig = episode.selected_configuration || {};
    const isExactMatch =
      actualConfig.execution_mode === candidateConfig.execution_mode &&
      actualConfig.assigned_agent === candidateConfig.implementer_route;

    const actualTerminal = episode.terminal_outcome || {};
    const terminalSuccess = actualTerminal.terminal_status === "merged";

    // Token / Latency metrics calculation
    let totalTokens = 0;
    let implementerTokens = 0;
    let reviewerTokens = 0;
    let totalLatencyMs = 0;

    for (const roleExec of episode.role_executions || []) {
      const tokens = roleExec.tokens?.total || 0;
      totalTokens += tokens;
      if (roleExec.role === "reviewer") reviewerTokens += tokens;
      else implementerTokens += tokens;
      totalLatencyMs += roleExec.latency_ms || 0;
    }

    // Counterfactual estimation factor if configuration differs from actual replay record
    const counterfactualEstimate = !isExactMatch;
    const estimatedTokens = counterfactualEstimate ? Math.round(totalTokens * 1.05) : totalTokens;

    return {
      episode_id: episode.episode_id,
      issue_id: episode.issue_id,
      disqualified: false,
      is_counterfactual: counterfactualEstimate,
      policy_name: policy.name,
      policy_version: policy.version,
      selected_config: candidateConfig,
      actual_config: actualConfig,
      terminal_success: terminalSuccess,
      gate_passed: actualTerminal.gate_passed ?? terminalSuccess,
      pr_merged: actualTerminal.pr_state === "merged",
      tokens: {
        total: estimatedTokens,
        implementer: implementerTokens,
        reviewer: reviewerTokens,
      },
      latency_ms: totalLatencyMs,
      human_intervention: Boolean(actualTerminal.human_intervention),
      hard_constraint_violations: actualTerminal.hard_constraint_violations || 0,
      reviewer_findings_count: actualTerminal.reviewer_findings_count || 0,
    };
  }

  /**
   * Evaluate a full dataset under multiple policies and generate summary report.
   */
  evaluateDataset(dataset, policies = []) {
    const resultsByPolicy = new Map();

    for (const policy of policies) {
      const episodeResults = [];
      for (const ep of dataset.episodes || []) {
        const res = this.replayEpisode(ep, policy);
        episodeResults.push(res);
      }

      // Compute aggregate quality and efficiency metrics
      const totalCount = episodeResults.length;
      const validResults = episodeResults.filter((r) => !r.disqualified);
      const disqualifiedCount = totalCount - validResults.length;

      const successfulCount = validResults.filter((r) => r.terminal_success).length;
      const prMergedCount = validResults.filter((r) => r.pr_merged).length;
      const totalTokens = validResults.reduce((sum, r) => sum + r.tokens.total, 0);
      const totalLatency = validResults.reduce((sum, r) => sum + r.latency_ms, 0);
      const humanInterventions = validResults.reduce((sum, r) => sum + (r.human_intervention ? 1 : 0), 0);
      const constraintViolations = validResults.reduce((sum, r) => sum + r.hard_constraint_violations, 0);

      const terminalSuccessRate = totalCount > 0 ? successfulCount / totalCount : 0;
      const prMergeRate = totalCount > 0 ? prMergedCount / totalCount : 0;
      const avgTokensPerSuccess = successfulCount > 0 ? totalTokens / successfulCount : 0;

      // Sample size warning
      const sampleSizeWarning = totalCount < 10 ? "Sample size N < 10 is low; confidence interval may be wide." : null;

      resultsByPolicy.set(policy.name, {
        policy_name: policy.name,
        policy_version: policy.version,
        total_episodes: totalCount,
        disqualified_episodes: disqualifiedCount,
        quality_metrics: {
          terminal_success_rate: terminalSuccessRate,
          pr_merge_rate: prMergeRate,
          human_intervention_rate: totalCount > 0 ? humanInterventions / totalCount : 0,
          hard_constraint_violation_count: constraintViolations,
        },
        efficiency_metrics: {
          total_tokens: totalTokens,
          avg_tokens_per_successful_issue: avgTokensPerSuccess,
          total_latency_ms: totalLatency,
          avg_latency_ms: totalCount > 0 ? totalLatency / totalCount : 0,
        },
        sample_size_warning: sampleSizeWarning,
        episode_results: episodeResults,
      });
    }

    return {
      metadata: {
        dataset_version: dataset.dataset_version,
        schema_version: dataset.schema_version,
        orchestrator_version: this.options.orchestratorVersion,
        evaluated_at: new Date().toISOString(),
      },
      policies: Array.from(resultsByPolicy.values()),
    };
  }

  /**
   * Format evaluation results into human-readable text report.
   */
  formatReport(evalSummary) {
    const lines = [];
    lines.push("# Offline Evaluation & Quality-Token Frontier Report");
    lines.push(`Dataset Version: ${evalSummary.metadata.dataset_version}`);
    lines.push(`Evaluated At: ${evalSummary.metadata.evaluated_at}`);
    lines.push("");

    lines.push("## Policy Frontier Summary");
    lines.push("| Policy Name | Version | Success Rate | PR Merge Rate | Avg Tokens/Success | Constraint Violations |");
    lines.push("|---|---|---|---|---|---|");

    for (const p of evalSummary.policies) {
      const q = p.quality_metrics;
      const e = p.efficiency_metrics;
      lines.push(
        `| ${p.policy_name} | ${p.policy_version} | ${(q.terminal_success_rate * 100).toFixed(1)}% | ${(q.pr_merge_rate * 100).toFixed(1)}% | ${Math.round(e.avg_tokens_per_successful_issue)} | ${q.hard_constraint_violation_count} |`
      );
    }
    lines.push("");

    for (const p of evalSummary.policies) {
      if (p.sample_size_warning) {
        lines.push(`> ⚠️ **Warning [${p.policy_name}]**: ${p.sample_size_warning}`);
      }
    }

    return lines.join("\n");
  }
}
