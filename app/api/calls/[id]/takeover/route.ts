import { z } from "zod";
import { errorJson, parseJsonBody, requireDashboardAuth, uuidParam } from "@/lib/http";
import { takeOver } from "@/lib/takeover";
import { takeoverResponse } from "@/lib/takeover-http";

export const maxDuration = 30;

const bodySchema = z
  .object({
    approvedBy: z.string().trim().min(1, "Enter the analyst's name.").max(100),
    /** Sent by dashboards from before the AI voices; the voice is always matched automatically now. */
    persona: z.literal("auto").optional(),
  })
  .strict();

/** Analyst "Take over now" from the dashboard: hand the live call to the AI voice, matched automatically like the customer's. */
export async function POST(req: Request, ctx: RouteContext<"/api/calls/[id]/takeover">) {
  const denied = requireDashboardAuth(req);
  if (denied) return denied;
  const id = uuidParam.safeParse((await ctx.params).id);
  if (!id.success) return errorJson(400, "Invalid call id.");
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;

  const name = body.data.approvedBy.replace(/\s+/g, " ");
  const result = await takeOver(id.data, { by: `analyst:${name}` });
  return takeoverResponse(result);
}
