import type { Metadata, Viewport } from "next";
import appleTouchIcon from "./_assets/apple-touch-icon.png";
import { ProtectApp } from "@/components/protect/protect-app";

export const metadata: Metadata = {
  title: "Northgate Call Guard",
  description: "Live scam screening for your calls.",
  robots: { index: false, follow: false },
  icons: { apple: appleTouchIcon.src },
  appleWebApp: { capable: true, title: "Call Guard", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#12192b",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * The customer's Call Guard page (a mobile PWA). Access is the httpOnly customer cookie (proxy.ts). Only public,
 * non-secret values are passed to the browser.
 */
export default function ProtectPage() {
  const threshold = Number(process.env.RISK_THRESHOLD) || 70;
  return (
    <>
      {/* The manifest is public (proxy.ts), so it loads even when the browser sends no cookies (WebKit doesn't). */}
      <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
      <ProtectApp
        firstName={process.env.CUSTOMER_FIRST_NAME ?? ""}
        vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ""}
        riskThreshold={threshold}
      />
    </>
  );
}
