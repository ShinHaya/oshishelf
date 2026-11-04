import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const source = path.resolve(import.meta.dirname, "../../..");

/**
 * CLI entry points treat the checkout that contains the script as the
 * repository, so spawning `source/scripts/*.mjs` would read this checkout's
 * own `.ai-template/config.json`. Copy the scripts and runtime definitions
 * into a throwaway root without repository settings instead. Dependencies are
 * linked, not copied. Returns the root; spawn `path.join(root, "scripts/…")`.
 * @param {{ after: (fn: () => void) => void }} [t] node:test context for cleanup
 */
export function isolatedScriptRoot(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "script-root-")),
  );
  t?.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const entry of ["scripts", "agents"])
    fs.cpSync(path.join(source, entry), path.join(root, entry), {
      recursive: true,
    });
  // Consumers may have no package.json; the .mjs scripts do not need one.
  if (fs.existsSync(path.join(source, "package.json")))
    fs.copyFileSync(
      path.join(source, "package.json"),
      path.join(root, "package.json"),
    );
  if (fs.existsSync(path.join(source, "node_modules")))
    fs.symlinkSync(
      path.join(source, "node_modules"),
      path.join(root, "node_modules"),
      "dir",
    );
  return root;
}
