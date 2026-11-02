import { writeFile, chmod } from "node:fs/promises";
import path from "node:path";

// CLI workflow tests exercise planning, not the real checkout or network.
// Reject every unexpected Git operation instead of touching the working checkout.
export async function freshCheckoutEnv(directory) {
  const git = path.join(directory, "git");
  await writeFile(git, `#!/bin/sh
case "$*" in
  'fetch origin main'|'merge-base --is-ancestor origin/main HEAD') exit 0 ;;
  *) echo 'unexpected git operation in CLI test' >&2; exit 1 ;;
esac
`);
  await chmod(git, 0o755);
  // Auto parent admission must not read a real operator account in CLI tests.
  const usageCli = path.join(directory, "codex");
  await writeFile(usageCli, "#!/bin/sh\nexit 1\n");
  await chmod(usageCli, 0o755);
  return { ...process.env, PATH: `${directory}:${process.env.PATH}` };
}
