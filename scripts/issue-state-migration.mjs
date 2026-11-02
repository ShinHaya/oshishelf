import fs from "node:fs/promises";
import path from "node:path";
import { withStateLock } from "./issue-state.mjs";

// Transitional compatibility with the former tooling prefix. Remove this
// reader in the next major migration; it is not a second state namespace.
const previousPrefix = ["project", "issue"].join("-");
const supportedName = /^issue-(?:orchestrator\.yaml$|capabilities\.json$|graph(?:$|[.-]))/;

async function stat(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/**
 * Move an old local state path once, only if the new path does not exist.
 * Both-existing paths are preserved. Dry runs read the old path without writes.
 * Notifications go to stderr, keeping machine-readable stdout unchanged.
 * @param {string | undefined} target
 * @param {{ dryRun?: boolean, notify?: (message: string) => unknown }} [options]
 */
export async function migrateLegacyStatePath(target, {
  dryRun = false,
  notify = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  if (!target) return target;
  const resolved = path.resolve(target);
  const name = path.basename(resolved);
  if (!supportedName.test(name)) return resolved;
  const previous = path.join(path.dirname(resolved), name.replace(/^issue/, previousPrefix));
  if (await stat(resolved)) return resolved;
  const old = await stat(previous);
  if (!old) return resolved;
  if (old.isSymbolicLink() || (!old.isFile() && !old.isDirectory()))
    throw new Error("state-migration-unsupported-type");
  if (dryRun) return previous;
  await withStateLock(`${resolved}.migration`, async () => {
    if (await stat(resolved)) return;
    const source = await stat(previous);
    if (!source) return;
    if (source.isSymbolicLink() || (!source.isFile() && !source.isDirectory()))
      throw new Error("state-migration-unsupported-type");
    if (source.isFile()) {
      // Hard-link creation is exclusive, unlike rename's file replacement.
      try { await fs.link(previous, resolved); }
      catch (error) { if (error.code === "EEXIST") return; throw error; }
      await fs.unlink(previous);
    } else {
      // Every default graph opener uses this lock before it creates files.
      await fs.rename(previous, resolved);
    }
    notify(`[issue-state] migrated ${path.basename(previous)} -> ${name}`);
  });
  return resolved;
}
