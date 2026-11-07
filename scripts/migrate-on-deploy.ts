/**
 * Runs before `next build` on Vercel (package.json "vercel-build"). Does nothing unless the deploy asked for it:
 *
 *   vercel deploy --prod -b RUN_DB_MIGRATIONS=1
 *
 * Then it applies pending supabase/migrations (never the seed or --reset-demo) over SUPABASE_DB_URL from the Vercel
 * environment, before the new code is built, so the schema is in place before the deployment goes live. A failed
 * migration fails the build, and production keeps the previous deployment. For machines that can't reach the
 * Postgres pooler ports directly; `npm run db:migrate` is the usual route.
 */
import { applyPendingMigrations, connectDb } from "./lib/migrations";

async function main() {
  const flag = (process.env.RUN_DB_MIGRATIONS ?? "").trim().toLowerCase();
  if (!["1", "true", "yes"].includes(flag)) {
    console.log("migrate-on-deploy: RUN_DB_MIGRATIONS not set; skipping database migrations.");
    return;
  }
  const url = process.env.SUPABASE_DB_URL?.trim();
  if (!url) throw new Error("migrate-on-deploy: RUN_DB_MIGRATIONS is set but SUPABASE_DB_URL is not available to the build.");
  const client = await connectDb(url);
  try {
    const applied = await applyPendingMigrations(client);
    console.log(`migrate-on-deploy: ${applied.length ? `applied ${applied.join(", ")}` : "nothing to apply"}.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error((error as Error).message ?? error);
  process.exit(1);
});
