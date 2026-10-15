import fs from "node:fs/promises";
import { createHash } from "node:crypto";

import { MemorySaver } from "@langchain/langgraph-checkpoint";

import { writeJsonAtomic } from "./project-issue-runtime-adapters/shared.mjs";

/** Domain-separated, closed-alphabet key; avoids prototype names and arbitrary CLI IDs. */
export function triageRunId(threadId) {
  return `t-${createHash("sha256").update(String(threadId)).digest("hex")}`;
}

/**
 * File-backed LangGraph checkpoint saver for project-issue orchestration.
 *
 * Persists `MemorySaver`'s storage to one JSON file per run (thread) so a
 * graph run can be resumed with the same `thread_id` after a process
 * restart, without adding a native database dependency. Values are the
 * serializer's UTF-8 JSON output stored as strings; `loadsTyped("json", …)`
 * accepts strings directly, so no re-encoding is needed on load.
 *
 * Orchestration state must stay non-sensitive (Issue numbers, routing
 * labels, milestones, timestamps, usage). Issue bodies, prompts, diffs,
 * credentials, and personal data are never part of graph state and so are
 * never written here.
 */
export class FileCheckpointSaver extends MemorySaver {
  #filePath;
  #triageBudgets = {};
  #triageAttempts = {};

  /**
   * Persistence is serialized through this chain: LangGraph issues
   * concurrent put/putWrites during a superstep, and parallel
   * `writeJsonAtomic` calls in the same millisecond would collide on the
   * pid+timestamp temp-file name.
   */
  #persistQueue = Promise.resolve();

  constructor(filePath) {
    if (typeof filePath !== "string" || filePath.trim() === "")
      throw new Error("checkpoint-file-required");
    super();
    this.#filePath = filePath;
  }

  /** Create a saver and hydrate it from `filePath` when the file exists. */
  static async load(filePath) {
    const saver = new FileCheckpointSaver(filePath);
    let raw;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return saver;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("checkpoint-file-corrupt");
    }
    if (parsed?.format !== FILE_FORMAT) throw new Error("checkpoint-format-unsupported");
    const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const budgets = parsed.triageBudgets ?? {};
    const attempts = parsed.triageAttempts ?? {};
    if (!plain(budgets) || !Object.values(budgets).every(plain) || !plain(attempts) ||
        !Object.values(attempts).every((list) => Array.isArray(list) && list.every((f) => typeof f === "string")))
      throw new Error("checkpoint-file-corrupt");
    saver.#triageBudgets = budgets;
    saver.#triageAttempts = attempts;
    for (const [threadId, namespaces] of Object.entries(parsed.storage ?? {})) {
      saver.storage[threadId] = Object.create(null);
      for (const [namespace, checkpoints] of Object.entries(namespaces)) {
        saver.storage[threadId][namespace] = Object.create(null);
        for (const [checkpointId, entry] of Object.entries(checkpoints))
          saver.storage[threadId][namespace][checkpointId] = [
            entry.checkpoint,
            entry.metadata,
            entry.parentId ?? undefined,
          ];
      }
    }
    for (const [outerKey, writes] of Object.entries(parsed.writes ?? {})) {
      saver.writes[outerKey] = Object.create(null);
      for (const [innerKey, write] of Object.entries(writes))
        saver.writes[outerKey][innerKey] = [write.taskId, write.channel, write.value];
    }
    return saver;
  }

  #persist() {
    const next = this.#persistQueue.catch(() => {}).then(() => this.#persistNow());
    this.#persistQueue = next;
    return next;
  }

  async #persistNow() {
    const storage = {};
    for (const [threadId, namespaces] of Object.entries(this.storage)) {
      storage[threadId] = {};
      for (const [namespace, checkpoints] of Object.entries(namespaces)) {
        storage[threadId][namespace] = {};
        for (const [checkpointId, [checkpoint, metadata, parentId]] of Object.entries(checkpoints))
          storage[threadId][namespace][checkpointId] = {
            checkpoint: asString(checkpoint),
            metadata: asString(metadata),
            ...(parentId === undefined ? {} : { parentId }),
          };
      }
    }
    const writes = {};
    for (const [outerKey, innerWrites] of Object.entries(this.writes)) {
      writes[outerKey] = {};
      for (const [innerKey, [taskId, channel, value]] of Object.entries(innerWrites))
        writes[outerKey][innerKey] = { taskId, channel, value: asString(value) };
    }
    await writeJsonAtomic(this.#filePath, { format: FILE_FORMAT, storage, writes,
      triageBudgets: this.#triageBudgets, triageAttempts: this.#triageAttempts });
  }

  /** A reservation is durable before the triage child can make a paid request. */
  triageBudget(runId) {
    return this.#triageBudgets[runId] ?? null;
  }

  async reserveTriageBudget(snapshot) {
    const previous = this.#triageBudgets[snapshot.runId];
    if (previous && snapshot.reserved < previous.reserved) throw new Error("triage-budget-regression");
    this.#triageBudgets[snapshot.runId] = { ...snapshot };
    await this.#persist();
  }

  /** A replay after a crash falls back locally instead of sending the same request twice. */
  async beginTriageAttempt(runId, fingerprint) {
    this.#triageAttempts[runId] ??= [];
    if (this.#triageAttempts[runId].includes(fingerprint)) return false;
    this.#triageAttempts[runId].push(fingerprint);
    await this.#persist();
    return true;
  }

  async put(config, checkpoint, metadata, newVersions) {
    const result = await super.put(config, checkpoint, metadata, newVersions);
    await this.#persist();
    return result;
  }

  async putWrites(config, writes, taskId) {
    await super.putWrites(config, writes, taskId);
    await this.#persist();
  }

  async deleteThread(threadId) {
    await super.deleteThread(threadId);
    delete this.#triageBudgets[threadId];
    delete this.#triageAttempts[threadId];
    delete this.#triageBudgets[triageRunId(threadId)];
    delete this.#triageAttempts[triageRunId(threadId)];
    await this.#persist();
  }
}

const FILE_FORMAT = "project-issue-graph-checkpoint/v1";
const decoder = new TextDecoder();

function asString(value) {
  if (typeof value === "string") return value;
  return decoder.decode(value);
}
