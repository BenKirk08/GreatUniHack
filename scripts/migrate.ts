/**
 * Apply SQL migrations and the seed to Supabase over SUPABASE_DB_URL (Session pooler).
 *
 *   npm run db:migrate                 # migrations + seed + settings row
 *   npm run db:migrate -- --reset-demo # also wipe calls/reports and un-freeze every account
 *
 * If this machine can't reach Postgres (the pooler ports), deploy with `vercel deploy --prod -b RUN_DB_MIGRATIONS=1`:
 * the Vercel build then applies pending migrations (not the seed) before building (scripts/migrate-on-deploy.ts).
 */
import "./lib/load-env";
import { readFileSync } from "node:fs";
import path from "node:path";
import { requireEnv, serverEnv } from "../lib/env";
import { applyPendingMigrations, connectDb } from "./lib/migrations";

const seedFile = path.join(process.cwd(), "supabase", "seed.sql");

async function main() {
  const resetDemo = process.argv.includes("--reset-demo");
  const env = serverEnv();
  const client = await connectDb(requireEnv("SUPABASE_DB_URL"));
  try {
    await applyPendingMigrations(client);

    await client.query(readFileSync(seedFile, "utf8"));
    const { rows } = await client.query<{ n: string }>("select count(*)::text as n from public.bank_accounts");
    console.log(`  seed   bank_accounts: ${rows[0].n} rows`);

    // Settings row: seeded once from AUTO_SEND_REPORTS; afterwards the dashboard toggle owns it.
    await client.query("insert into public.settings (id, auto_send) values (1, $1) on conflict (id) do nothing", [
      env.AUTO_SEND_REPORTS,
    ]);
    const settings = await client.query<{ auto_send: boolean }>("select auto_send from public.settings where id = 1");
    console.log(`  seed   settings.auto_send = ${settings.rows[0].auto_send}`);

    if (resetDemo) {
      await client.query("delete from public.reports; delete from public.calls;");
      await client.query("update public.bank_accounts set status = 'active', frozen_at = null");
      await client.query("update public.settings set auto_send = $1, updated_at = now() where id = 1", [
        env.AUTO_SEND_REPORTS,
      ]);
      console.log("  reset  calls and reports cleared, accounts un-frozen, auto_send reset");
    }

    // Sanity: confirm Realtime publication membership.
    const pub = await client.query<{ tablename: string }>(
      "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by 1",
    );
    console.log(`  realtime tables: ${pub.rows.map((r) => r.tablename).join(", ")}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
