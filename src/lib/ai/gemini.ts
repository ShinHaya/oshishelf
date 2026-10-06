import "server-only";
import { GoogleGenAI, HarmBlockThreshold, HarmCategory, type Part, type Schema } from "@google/genai";
import { PROJECT_ID } from "../firebase-admin";

export const LOCATION = process.env.GOOGLE_CLOUD_LOCATION ?? "global";
export const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
export const LITE_MODEL = process.env.GEMINI_LITE_MODEL ?? "gemini-2.5-flash-lite";
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";
export const EMBEDDING_DIM = 768;

// Vertex AI with the Cloud Run service account (no API keys to leak).
export const genai = new GoogleGenAI({ vertexai: true, project: PROJECT_ID, location: LOCATION });

export const SAFETY_SETTINGS = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE }));

function isRetryable(e: unknown) {
  const msg = String((e as { message?: string })?.message ?? e);
  return /429|Resource exhausted|RESOURCE_EXHAUSTED|503|UNAVAILABLE|overloaded|deadline/i.test(msg);
}

/** Retry transient Vertex AI errors (429 / 503) with exponential backoff and jitter. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1 || !isRetryable(e)) {
        if (isRetryable(e)) throw new Error("AIが混み合っています。少し待ってからもう一度お試しください。");
        throw e;
      }
      await new Promise((r) => setTimeout(r, 1500 * 2 ** i + Math.random() * 1000));
    }
  }
}

/** Structured-output call: the model must answer with JSON matching `schema`. */
export async function generateJson<T>(opts: {
  system: string;
  parts: Part[];
  schema: Schema;
  model?: string;
  temperature?: number;
}): Promise<T> {
  const res = await withRetry(() => genai.models.generateContent({
    model: opts.model ?? MODEL,
    contents: [{ role: "user", parts: opts.parts }],
    config: {
      systemInstruction: opts.system,
      responseMimeType: "application/json",
      responseSchema: opts.schema,
      temperature: opts.temperature ?? 0.2,
      safetySettings: SAFETY_SETTINGS,
    },
  }));
  const text = res.text;
  if (!text) throw new Error(`AIが応答を返しませんでした (${res.candidates?.[0]?.finishReason ?? "unknown"})`);
  return JSON.parse(text) as T;
}

export async function embed(texts: string[]): Promise<number[][]> {
  const res = await withRetry(() =>
    genai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: texts,
      config: { outputDimensionality: EMBEDDING_DIM, taskType: "SEMANTIC_SIMILARITY" },
    }),
  );
  return (res.embeddings ?? []).map((e) => normalize(e.values ?? []));
}

function normalize(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
