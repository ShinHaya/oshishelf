import fs from "node:fs/promises";
import path from "node:path";

export async function readState(statePath) {
  if (!statePath) return {};
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeState(statePath, state) {
  if (!statePath) throw new Error("state-path-required");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await fs.rename(temporary, statePath);
  // Rename keeps the temp file mode on most platforms; re-assert owner-only access.
  await fs.chmod(statePath, 0o600);
}

/**
 * Directory lock for local single-operator state files only.
 * Stale reclaim is best-effort TOCTOU (two reclaimers can race); do not reuse
 * this for multi-host or multi-user distributed locking.
 */
export async function withStateLock(
  statePath,
  operation,
  { timeoutMs = 5_000, pollMs = 10, staleMs = 30_000 } = {},
) {
  if (!statePath) throw new Error("state-path-required");
  const lockPath = `${statePath}.lock`;
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const lock = await fs.stat(lockPath);
        if (Date.now() - lock.mtimeMs > staleMs) {
          // Best-effort stale reclaim; concurrent reclaimers may race on rename.
          const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}`;
          await fs.rename(lockPath, stalePath);
          await fs.rm(stalePath, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (!new Set(["ENOENT", "EEXIST"]).has(lockError.code)) throw lockError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error("state-lock-timeout");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}
