import { z } from "zod";
import { ReportSendConflict, sendReport } from "@/lib/email";
import { errorJson, json, parseJsonBody, requireDashboardAuth, uuidParam } from "@/lib/http";

export const maxDuration = 30;

const bodySchema = z.object({
  approvedBy: z.string().trim().min(1, "Enter the analyst's name.").max(100),
});

/** Human-approval path: an analyst approves a draft report and it is emailed to the fraud team inbox. */
export async function POST(req: Request, ctx: RouteContext<"/api/reports/[id]/send">) {
  const denied = requireDashboardAuth(req);
  if (denied) return denied;

  const id = uuidParam.safeParse((await ctx.params).id);
  if (!id.success) return errorJson(400, "Invalid report id.");
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;

  try {
    const report = await sendReport(id.data, body.data.approvedBy);
    return json({ ok: true, report });
  } catch (error) {
    if (error instanceof ReportSendConflict) return errorJson(409, error.message);
    const message = (error as Error).message;
    if (/not found/i.test(message)) return errorJson(404, "Report not found.");
    console.error("reports/send failed", error);
    return errorJson(502, "Could not send the report email.");
  }
}
