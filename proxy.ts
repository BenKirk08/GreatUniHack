import { NextResponse, type NextRequest } from "next/server";
import { BASIC_AUTH_REALM, checkBasicAuth, isMachinePath } from "@/lib/auth";
import {
  checkCustomerCookie,
  checkLinkToken,
  CUSTOMER_COOKIE,
  CUSTOMER_COOKIE_MAX_AGE,
  customerCookieValue,
  isCustomerPath,
  isPublicAppFile,
} from "@/lib/customer-auth";

/**
 * Access control (Next.js 16 renamed middleware.ts to proxy.ts):
 *  - /api/tools/*, /api/webhooks/*, /api/twilio/*, /api/cron/*: public here; each route checks a tool secret, an
 *    HMAC, the Twilio signature or Vercel Cron's CRON_SECRET itself.
 *  - /manifest.webmanifest and /sw.js (exactly): public. They hold nothing private, and browsers fetch them without
 *    cookies (an iPhone can't install Call Guard as a Home Screen app that gets notifications otherwise).
 *  - /protect, /protect/*, /api/protect/*: the customer's httpOnly cookie, set by visiting
 *    /protect?k=CUSTOMER_LINK_TOKEN (the token is then stripped from the URL by a redirect).
 *  - everything else: HTTP basic auth with DASHBOARD_PASSWORD.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isMachinePath(pathname)) return NextResponse.next();
  if (isPublicAppFile(pathname)) return NextResponse.next();
  if (isCustomerPath(pathname)) return customerGate(request);

  const password = process.env.DASHBOARD_PASSWORD?.trim();
  if (!password) {
    // Fail closed if the password isn't configured.
    return new NextResponse("Dashboard password is not configured.", { status: 503 });
  }
  if (checkBasicAuth(request.headers.get("authorization"), password)) return NextResponse.next();

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": BASIC_AUTH_REALM, "Cache-Control": "no-store" },
  });
}

function customerGate(request: NextRequest): NextResponse {
  const token = process.env.CUSTOMER_LINK_TOKEN?.trim();
  if (!token || token.length < 24) return new NextResponse("Call Guard is not configured.", { status: 503 });

  const { pathname, searchParams } = request.nextUrl;
  const linkToken = searchParams.get("k");
  if (pathname === "/protect" && linkToken !== null) {
    if (!checkLinkToken(linkToken, token)) return customerDenied(pathname);
    const clean = request.nextUrl.clone();
    clean.searchParams.delete("k");
    const res = NextResponse.redirect(clean, 303);
    res.cookies.set(CUSTOMER_COOKIE, customerCookieValue(token), {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: CUSTOMER_COOKIE_MAX_AGE,
    });
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  if (checkCustomerCookie(request.cookies.get(CUSTOMER_COOKIE)?.value, token)) return NextResponse.next();
  return customerDenied(pathname);
}

function customerDenied(pathname: string): NextResponse {
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "Open your Call Guard link again to sign in." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (pathname === "/protect" || pathname.startsWith("/protect/")) {
    // A Home Screen app keeps its own cookies, so let the customer paste their link here to sign in again.
    const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Northgate Call Guard</title><meta name="robots" content="noindex"></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#12192b;color:#e2e8f0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif"><main style="max-width:22rem;padding:24px;text-align:center"><h1 style="font-size:1.25rem">Northgate Call Guard</h1><p style="color:#94a3b8;line-height:1.5">Open the personal Call Guard link Northgate sent you to turn on protection on this phone, or paste it here.</p><form id="f" method="get" action="/protect" style="display:flex;gap:8px;margin-top:16px"><input id="k" name="k" placeholder="Paste your link" autocomplete="off" style="flex:1;min-width:0;padding:10px;border-radius:10px;border:1px solid #334155;background:#0b1220;color:#e2e8f0"><button style="padding:10px 14px;border-radius:10px;border:0;background:#38c8d6;color:#0b1220;font-weight:700">Go</button></form></main><script>document.getElementById("f").addEventListener("submit",function(e){var i=document.getElementById("k");try{var u=new URL(i.value.trim());var k=u.searchParams.get("k");if(k)i.value=k}catch(_){}});</script></body></html>`;
    return new NextResponse(html, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return new NextResponse("Not authorised.", { status: 401, headers: { "Cache-Control": "no-store" } });
}

export const config = {
  matcher: ["/((?!api/tools/|api/webhooks/|api/twilio/|api/cron/|_next/static|_next/image|favicon.ico).*)"],
};
