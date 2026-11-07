import { existsSync } from "node:fs";
import path from "node:path";

/** Load .env.local (then .env) into process.env for CLI scripts. Existing process.env values win. */
export function loadLocalEnv(root = process.cwd()) {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(root, name);
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

loadLocalEnv();
