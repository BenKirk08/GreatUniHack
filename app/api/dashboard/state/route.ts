import { errorJson, json, requireDashboardRead } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Everything the dashboard shows on load (basic auth). The browser never reads the tables directly. */
export async function GET(req: Request) {
  const denied = requireDashboardRead(req);
  if (denied) return denied;
  const db = supabaseAdmin();
  const [calls, reports, accounts, settings] = await Promise.all([
    db.from("calls").select("*").order("started_at", { ascending: false }).limit(100),
    db.from("reports").select("*").order("created_at", { ascending: false }).limit(200),
    db.from("bank_accounts").select("*"),
    db.from("settings").select("*").eq("id", 1).maybeSingle(),
  ]);
  const error = calls.error ?? reports.error ?? accounts.error ?? settings.error;
  if (error) {
    console.error("dashboard/state failed", error);
    return errorJson(500, "Could not load the dashboard data.");
  }
  return json({ ok: true, calls: calls.data, reports: reports.data, accounts: accounts.data, settings: settings.data });
}
