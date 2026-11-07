import type { Metadata, Viewport } from "next";
import { VoiceTwinSettings } from "@/components/protect/voice-twin-settings";
import { VOICE_TWIN_SAMPLE_PARAGRAPH, voiceTwinSettings } from "@/lib/voice-twin/config";

export const metadata: Metadata = {
  title: "Settings · Northgate Call Guard",
  description: "Your AI voice match, and consent, progress and deletion for your AI Voice Twin.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#12192b",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * The twin's thresholds for the page. voiceTwinSettings() validates the whole server env; if that can't run here
 * (e.g. a build without every secret), fall back to the same defaults. The page re-reads the live numbers from
 * /api/protect/voice-twin anyway.
 */
function thresholds(): { minSeconds: number; targetSeconds: number } {
  try {
    const { minSeconds, targetSeconds } = voiceTwinSettings();
    return { minSeconds, targetSeconds };
  } catch {
    const minSeconds = Number(process.env.VOICE_TWIN_MIN_SECONDS) || 15;
    return { minSeconds, targetSeconds: Math.max(Number(process.env.VOICE_TWIN_TARGET_SECONDS) || 60, minSeconds) };
  }
}

/**
 * Settings (/protect/settings): "Your AI voice match", and the AI Voice Twin's consent, "Record a sample now" and
 * "Revoke & delete". Behind the customer cookie like the rest of /protect (proxy.ts); only public, non-secret values
 * reach the browser.
 */
export default function VoiceTwinSettingsPage() {
  const { minSeconds, targetSeconds } = thresholds();
  return (
    <VoiceTwinSettings
      firstName={process.env.CUSTOMER_FIRST_NAME ?? ""}
      minSeconds={minSeconds}
      targetSeconds={targetSeconds}
      sampleParagraph={VOICE_TWIN_SAMPLE_PARAGRAPH}
    />
  );
}
