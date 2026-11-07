/**
 * Dev utility: subscribe to the "northgate-ops" change signals with the anon key and log them, then prove the anon
 * key can't read the tables.   npx tsx scripts/dev/realtime-watch.ts [seconds]
 */
import "../lib/load-env";
import { createClient } from "@supabase/supabase-js";

const seconds = Number(process.argv[2] ?? 120);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const counts: Record<string, number> = {};
for (const table of ["calls", "reports", "bank_accounts", "settings"]) {
  const { data, error } = await db.from(table).select("*").limit(1);
  console.log(`anon read ${table}: ${error ? `refused (${error.code})` : `${data?.length ?? 0} rows`}`);
}
const channel = db.channel("northgate-ops").on("broadcast", { event: "changed" }, ({ payload }) => {
  const key = `${payload.table}:${payload.op}`;
  counts[key] = (counts[key] ?? 0) + 1;
  console.log(`${new Date().toISOString().slice(11, 19)} ${key} ${payload.id} ${JSON.stringify(payload).length} bytes`);
});
channel.subscribe((status) => console.log(`channel: ${status}`));
setTimeout(async () => {
  console.log("SUMMARY", JSON.stringify(counts));
  await db.removeChannel(channel);
  process.exit(0);
}, seconds * 1000);
