import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/auth";

/** httpOnly cookie set when the customer opens /protect?k=CUSTOMER_LINK_TOKEN. */
export const CUSTOMER_COOKIE = "northgate_guard";
export const CUSTOMER_COOKIE_MAX_AGE = 60 * 60 * 24 * 400; // ~400 days (browsers cap cookie lifetimes there)

/**
 * The cookie holds a value derived from the link token rather than the token itself, so the cookie can be
 * invalidated by rotating CUSTOMER_LINK_TOKEN and never echoes the link secret.
 */
export function customerCookieValue(linkToken: string): string {
  return createHmac("sha256", linkToken).update("northgate-call-guard/customer/v1").digest("base64url");
}

export function checkLinkToken(provided: string | null | undefined, linkToken: string | null | undefined): boolean {
  if (!provided || !linkToken) return false;
  return safeEqual(provided.trim(), linkToken);
}

export function checkCustomerCookie(cookieValue: string | null | undefined, linkToken: string | null | undefined): boolean {
  if (!cookieValue || !linkToken) return false;
  return safeEqual(cookieValue, customerCookieValue(linkToken));
}

/** Paths that use the customer cookie instead of the dashboard's basic auth. */
export function isCustomerPath(pathname: string): boolean {
  return pathname === "/protect" || pathname.startsWith("/protect/") || pathname.startsWith("/api/protect/");
}

/**
 * The Call Guard app's manifest and service worker script: public, with no cookie and no basic auth. Neither holds
 * anything private, and browsers fetch them without cookies (WebKit fetches the manifest without them even with
 * crossorigin="use-credentials", and service worker updates can skip them). Without the manifest an iPhone Home
 * Screen icon isn't a web app that can get notifications. Exact paths only.
 */
export function isPublicAppFile(pathname: string): boolean {
  return pathname === "/manifest.webmanifest" || pathname === "/sw.js";
}

/** Read one cookie from a Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
