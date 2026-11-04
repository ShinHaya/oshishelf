/** Runtime children receive only OS basics and exact, runtime-specific opt-ins. */
export const BASE_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
]);
const WINDOWS_KEYS = [
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
];
const FORBIDDEN = [
  "TYPESAFE_API_KEY",
  "ISSUE_WORKTREE_SESSION",
  "ISSUE_WORKTREE_OWNER_PID",
];

/** @param {{ inherit?: string[], required?: string[] }} [policy] */
export function validateEnvironmentPolicy(policy = {}) {
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    Object.keys(policy).some((key) => !["inherit", "required"].includes(key))
  )
    throw new Error("runtime-env-policy-invalid");
  for (const field of ["inherit", "required"]) {
    const keys = Object.hasOwn(policy, field) ? policy[field] : [];
    if (
      !Array.isArray(keys) ||
      new Set(keys).size !== keys.length ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
          FORBIDDEN.includes(key.toUpperCase()),
      )
    )
      throw new Error("runtime-env-policy-invalid");
  }
  if (
    (policy.required ?? []).some((key) => !(policy.inherit ?? []).includes(key))
  )
    throw new Error("runtime-env-policy-invalid");
  return policy;
}

export function mergeEnvironmentPolicies(...policies) {
  policies.forEach((policy) => validateEnvironmentPolicy(policy));
  return {
    inherit: [...new Set(policies.flatMap((policy) => policy?.inherit ?? []))],
    required: [
      ...new Set(policies.flatMap((policy) => policy?.required ?? [])),
    ],
  };
}

/** Values never appear in errors. The parent object is never mutated. */
/** @param {{ parentEnv?: NodeJS.ProcessEnv, policy?: { inherit?: string[], required?: string[] }, platform?: string, lease?: { session: string, ownerPid: number } }} [input] */
export function buildRuntimeEnvironment({
  parentEnv = process.env,
  policy = {},
  platform = process.platform,
  lease = undefined,
} = {}) {
  validateEnvironmentPolicy(policy);
  const normalize = (key) => (platform === "win32" ? key.toUpperCase() : key);
  const source = new Map();
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    const normalized = normalize(key);
    // Ignore forbidden parent values, even when case variants collide.
    if (FORBIDDEN.includes(normalized.toUpperCase())) continue;
    if (source.has(normalized) && source.get(normalized) !== value)
      throw new Error("runtime-env-key-collision");
    source.set(normalized, value);
  }
  const result = Object.create(null);
  for (const key of [
    ...BASE_ENVIRONMENT_KEYS,
    ...(platform === "win32" ? WINDOWS_KEYS : []),
    ...(policy.inherit ?? []),
  ]) {
    const normalized = normalize(key);
    if (source.has(normalized)) result[normalized] = source.get(normalized);
  }
  for (const key of policy.required ?? []) {
    if (!result[normalize(key)])
      throw new Error("runtime-env-required-missing");
  }
  if (lease) {
    result.ISSUE_WORKTREE_SESSION = lease.session;
    result.ISSUE_WORKTREE_OWNER_PID = String(lease.ownerPid);
  }
  return result;
}

export function environmentReason(error) {
  return [
    "runtime-env-policy-invalid",
    "runtime-env-required-missing",
    "runtime-env-policy-required",
    "runtime-env-key-collision",
  ].includes(error?.message)
    ? error.message
    : null;
}
