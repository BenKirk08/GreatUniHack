import icon192 from "@/app/protect/_assets/icon-192.png";
import icon512 from "@/app/protect/_assets/icon-512.png";

/**
 * The /protect PWA manifest. Public, with no cookie and no basic auth (proxy.ts): it holds nothing private, and
 * WebKit fetches it without cookies even with crossorigin="use-credentials", so behind the cookie an iPhone's Home
 * Screen icon wasn't a web app that could get notifications. The icons are static imports, so they're served from
 * /_next/static (no auth). start_url is plain /protect: iOS copies Safari's cookies into a Home Screen app when it's
 * added, and the sign-in page there lets the customer paste their link if not.
 */
export function GET() {
  const manifest = {
    id: "/protect",
    name: "Northgate Call Guard",
    short_name: "Call Guard",
    description: "Live scam screening for your calls, with one-tap handover to Northgate.",
    start_url: "/protect",
    scope: "/protect",
    display: "standalone",
    orientation: "portrait",
    background_color: "#12192b",
    theme_color: "#12192b",
    icons: [
      { src: icon192.src, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: icon512.src, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: icon512.src, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" },
  });
}
