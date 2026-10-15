import { writeFile, chmod } from "node:fs/promises";
import path from "node:path";

// CLI workflow tests exercise planning, not the real checkout or network.
// Freshness itself is covered with a local Git remote in repository-tooling.test.mjs.
export async function freshCheckoutEnv(directory) {
  const git = path.join(directory, "git");
  await writeFile(git, `#!/bin/sh
case "$*" in
  'fetch origin develop'|'merge-base --is-ancestor origin/develop HEAD') exit 0 ;;
  *) echo 'unexpected git operation in CLI test' >&2; exit 1 ;;
esac
`);
  await chmod(git, 0o755);
  return { ...process.env, PATH: `${directory}:${process.env.PATH}` };
}
