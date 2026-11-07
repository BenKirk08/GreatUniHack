/**
 * Push the project's env vars from .env.local to the linked Vercel project (production + preview).
 *   npx tsx scripts/sync-vercel-env.ts            # all keys listed in .env.example that have a value
 *   npx tsx scripts/sync-vercel-env.ts KEY1 KEY2  # only these keys
 * Secrets are stored as Vercel "sensitive" variables. Values are never printed.
 * Env changes only reach new deployments: run `vercel deploy --prod` afterwards.
 */
import "./lib/load-env";
import { projectEnvKeys, upsertVercelEnv } from "./lib/vercel";

async function main() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is not set");
  const wanted = process.argv.slice(2);
  const keys = wanted.length ? wanted : projectEnvKeys();
  const vars = Object.fromEntries(keys.map((k) => [k, process.env[k] ?? ""]));
  const skipped = keys.filter((k) => !vars[k]);
  const synced = await upsertVercelEnv(vars, { token });
  console.log(`Synced ${synced.length} env vars to Vercel: ${synced.join(", ")}`);
  if (skipped.length) console.log(`Skipped (empty): ${skipped.join(", ")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
