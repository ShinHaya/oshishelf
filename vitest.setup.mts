import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";

// Load .env.local if it exists (for local development)
// In CI, environment variables are provided directly
if (existsSync(".env.local")) {
  loadEnvFile(".env.local");
}
