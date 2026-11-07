import { z } from "zod";
import { errorJson, json, parseJsonBody, requireDashboardAuth } from "@/lib/http";
import { getAutoSend, setAutoSend } from "@/lib/settings";

const bodySchema = z.object({ autoSend: z.boolean().optional() }).strict();

/**
 * Switch report auto-send on or off at runtime by updating the settings row (no redeploy needed).
 * Body `{ autoSend: boolean }` sets it; an empty body toggles it.
 */
export async function POST(req: Request) {
  const denied = requireDashboardAuth(req);
  if (denied) return denied;

  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;

  try {
    const next = body.data.autoSend ?? !(await getAutoSend());
    const autoSend = await setAutoSend(next);
    return json({ ok: true, autoSend });
  } catch (error) {
    console.error("settings/auto-send failed", error);
    return errorJson(500, "Could not update the setting.");
  }
}
