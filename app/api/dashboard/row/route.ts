import { z } from "zod";
import { errorJson, json, requireDashboardRead } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

const querySchema = z.discriminatedUnion("table", [
  z.object({ table: z.enum(["calls", "reports", "bank_accounts"]), id: z.uuid() }),
  z.object({ table: z.literal("settings"), id: z.literal("1") }),
]);

/** One row, re-read after a Realtime change signal (basic auth). 404 means it was deleted. */
export async function GET(req: Request) {
  const denied = requireDashboardRead(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({ table: url.searchParams.get("table"), id: url.searchParams.get("id") });
  if (!parsed.success) return errorJson(400, "Invalid table or id.");
  const { table, id } = parsed.data;
  const { data, error } = await supabaseAdmin().from(table).select("*").eq("id", id).maybeSingle();
  if (error) return errorJson(500, "Could not load the row.");
  if (!data) return errorJson(404, "Not found.");
  return json({ ok: true, table, row: data });
}
