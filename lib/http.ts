import { NextResponse } from "next/server";
import { z } from "zod";
import { BASIC_AUTH_REALM, checkBasicAuth } from "@/lib/auth";
import { checkCustomerCookie, CUSTOMER_COOKIE, readCookie } from "@/lib/customer-auth";
import { serverEnv } from "@/lib/env";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorJson(status: number, error: string, details?: unknown) {
  return json(details === undefined ? { ok: false, error } : { ok: false, error, details }, status);
}

/**
 * Cross-site request check for the dashboard's action routes. Browsers re-send cached Basic auth
 * credentials on cross-site requests, so we also require a JSON content type (which forces a CORS
 * preflight that we never answer) and reject requests whose Origin / Sec-Fetch-Site says another site.
 */
export function isCrossSiteRequest(req: Request): boolean {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return true;
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") {
    try {
      const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
      if (new URL(origin).host !== host) return true;
    } catch {
      return true;
    }
  } else if (origin === "null") {
    return true;
  }
  return false;
}

/**
 * Guard for dashboard action routes: Basic auth (re-checked here even though proxy.ts already does),
 * JSON content type, and same-origin only.
 */
export function requireDashboardAuth(req: Request): NextResponse | null {
  if (!checkBasicAuth(req.headers.get("authorization"), serverEnv().DASHBOARD_PASSWORD)) {
    return new NextResponse(JSON.stringify({ ok: false, error: "Authentication required." }), {
      status: 401,
      headers: { "WWW-Authenticate": BASIC_AUTH_REALM, "Content-Type": "application/json" },
    });
  }
  if (isCrossSiteRequest(req)) return errorJson(403, "Cross-site requests are not allowed.");
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return errorJson(415, "Send the request body as application/json.");
  }
  return null;
}

/** Guard for the dashboard's read routes (GET): Basic auth, same-origin only. */
export function requireDashboardRead(req: Request): NextResponse | null {
  if (!checkBasicAuth(req.headers.get("authorization"), serverEnv().DASHBOARD_PASSWORD)) {
    return new NextResponse(JSON.stringify({ ok: false, error: "Authentication required." }), {
      status: 401,
      headers: { "WWW-Authenticate": BASIC_AUTH_REALM, "Content-Type": "application/json" },
    });
  }
  if (isCrossSiteRequest(req)) return errorJson(403, "Cross-site requests are not allowed.");
  return null;
}

/** Guard for the customer's read routes (GET): the customer cookie, same-origin only. */
export function requireCustomerRead(req: Request): NextResponse | null {
  const cookie = readCookie(req.headers.get("cookie"), CUSTOMER_COOKIE);
  if (!checkCustomerCookie(cookie, serverEnv().CUSTOMER_LINK_TOKEN)) return errorJson(401, "Open your Call Guard link again to sign in.");
  if (isCrossSiteRequest(req)) return errorJson(403, "Cross-site requests are not allowed.");
  return null;
}

/**
 * Guard for the customer's routes (/api/protect/*): the httpOnly customer cookie (re-checked here even though
 * proxy.ts already does), a JSON content type, and same-origin only (the cookie is SameSite=Lax as well).
 */
export function requireCustomerAuth(req: Request): NextResponse | null {
  const cookie = readCookie(req.headers.get("cookie"), CUSTOMER_COOKIE);
  if (!checkCustomerCookie(cookie, serverEnv().CUSTOMER_LINK_TOKEN)) {
    return errorJson(401, "Open your Call Guard link again to sign in.");
  }
  if (isCrossSiteRequest(req)) return errorJson(403, "Cross-site requests are not allowed.");
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return errorJson(415, "Send the request body as application/json.");
  }
  return null;
}

/** Parse a JSON body with zod. Empty bodies are treated as `{}`. */
export async function parseJsonBody<T extends z.ZodType>(
  req: Request,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  let raw: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, response: errorJson(400, "Body must be JSON.") };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: errorJson(400, "Invalid request body.", z.flattenError(parsed.error)) };
  }
  return { ok: true, data: parsed.data };
}

export const uuidParam = z.uuid();
