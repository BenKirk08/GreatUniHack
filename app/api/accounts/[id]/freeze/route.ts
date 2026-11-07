import { z } from "zod";
import { errorJson, json, parseJsonBody, requireDashboardAuth, uuidParam } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

const bodySchema = z.object({}).strict();

/** Freeze one of Northgate's own accounts (e.g. a suspected mule). Idempotent. */
export async function POST(req: Request, ctx: RouteContext<"/api/accounts/[id]/freeze">) {
  const denied = requireDashboardAuth(req);
  if (denied) return denied;

  const id = uuidParam.safeParse((await ctx.params).id);
  if (!id.success) return errorJson(400, "Invalid account id.");
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;

  const db = supabaseAdmin();
  const { data: existing, error: readError } = await db.from("bank_accounts").select("*").eq("id", id.data).maybeSingle();
  if (readError) return errorJson(500, "Could not read the account.");
  if (!existing) return errorJson(404, "Account not found.");
  if (existing.status === "frozen") return json({ ok: true, account: existing });

  const { data, error } = await db
    .from("bank_accounts")
    .update({ status: "frozen", frozen_at: new Date().toISOString() })
    .eq("id", id.data)
    .select("*")
    .single();
  if (error) return errorJson(500, "Could not freeze the account.");
  return json({ ok: true, account: data });
}
