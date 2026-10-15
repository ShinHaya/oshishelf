import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Product images come from arbitrary shop domains, so plain <img> is intentional.
      "@next/next/no-img-element": "off",
    },
  },
  {
    files: ["scripts/project-issue-*.mjs", "tests/unit/*.mjs"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true,
      }],
    },
  },
  globalIgnores([".worktrees/**", "state/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "public/bookmarklet.js"]),
]);

export default eslintConfig;
