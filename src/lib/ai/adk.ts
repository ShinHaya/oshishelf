import "server-only";
import { Gemini, InMemoryRunner, isFinalResponse, type LlmAgent } from "@google/adk";
import type { Schema } from "@google/genai";
import { PROJECT_ID } from "../firebase-admin";
import { generateJson, LITE_MODEL, LOCATION, MODEL, withRetry } from "./gemini";

/** Shared Vertex AI Gemini model for ADK agents. */
export function adkModel(model = MODEL) {
  return new Gemini({ model, vertexai: true, project: PROJECT_ID, location: LOCATION });
}

export interface AgentStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentRunResult {
  text: string;
  /** Tool calls the agent decided to make, in order — surfaced in the UI as the agent's "thinking trail". */
  steps: AgentStep[];
  /** Tool results the agent saw (truncated), used to ground the structured-output fallback. */
  observations: string[];
}

/**
 * Run an ADK agent once on an ephemeral session and collect its final text and tool trail.
 * Transient model errors restart the run; tools used here are read-only or idempotent-capped.
 */
export function runAgent(agent: LlmAgent, userId: string, message: string, stateDelta?: Record<string, unknown>): Promise<AgentRunResult> {
  return withRetry(() => runAgentOnce(agent, userId, message, stateDelta), 3);
}

async function runAgentOnce(agent: LlmAgent, userId: string, message: string, stateDelta?: Record<string, unknown>): Promise<AgentRunResult> {
  const runner = new InMemoryRunner({ agent, appName: "oshishelf" });
  const steps: AgentStep[] = [];
  const observations: string[] = [];
  const texts: string[] = [];
  for await (const event of runner.runEphemeral({ userId, newMessage: { role: "user", parts: [{ text: message }] }, stateDelta })) {
    if (event.errorMessage) throw new Error(event.errorMessage);
    for (const part of event.content?.parts ?? []) {
      if (part.functionCall?.name) steps.push({ tool: part.functionCall.name, args: (part.functionCall.args ?? {}) as Record<string, unknown> });
      if (part.functionResponse) observations.push(`${part.functionResponse.name}: ${JSON.stringify(part.functionResponse.response).slice(0, 4000)}`);
      if (part.text && !part.thought && event.author === agent.name) texts.push(part.text);
    }
    if (isFinalResponse(event) && event.author === agent.name) {
      const t = (event.content?.parts ?? []).map((p) => (p.thought ? "" : (p.text ?? ""))).join("");
      if (t.trim()) texts.push(t);
    }
  }
  return { text: (texts.at(-1) ?? "").trim(), steps, observations };
}

/** Extract the first JSON object from an LLM reply (tolerates ```json fences). */
export function parseJsonReply<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const start = text.indexOf("{");
  const raw = fenced ?? (start >= 0 ? text.slice(start, text.lastIndexOf("}") + 1) : "");
  return JSON.parse(raw) as T;
}

/**
 * Run a tool-using agent whose final answer must be JSON. Gemini cannot combine function calling
 * with a response schema, so if the agent's reply isn't valid JSON we hand its findings to a
 * schema-constrained formatter call — the agent decides, the formatter only shapes.
 */
export async function runAgentJson<T>(agent: LlmAgent, userId: string, message: string, schema: Schema, formatHint: string) {
  const run = await runAgent(agent, userId, message);
  try {
    return { data: parseJsonReply<T>(run.text), steps: run.steps };
  } catch {
    const data = await generateJson<T>({
      model: LITE_MODEL,
      system: `エージェントの調査結果を、指定のJSONスキーマに整形してください。${formatHint}\n調査結果にない事実を追加しないでください。`,
      parts: [{ text: `## エージェントの回答\n${run.text || "(なし)"}\n\n## ツールの結果\n${run.observations.join("\n").slice(0, 20000)}` }],
      schema,
    });
    return { data, steps: run.steps };
  }
}
