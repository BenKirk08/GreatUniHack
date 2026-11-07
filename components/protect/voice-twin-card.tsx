"use client";

import { AudioLines, ChevronRight } from "lucide-react";
import Link from "next/link";
import { VoiceTwinProgress } from "@/components/protect/voice-twin-progress";
import { VOICE_TWIN_LABEL } from "@/lib/voice-twin/config";
import { LIVE_CAPTURE_TEXT, liveCaptureStatus, twinExpiryLabel, twinProgress } from "@/lib/voice-twin/popup";
import type { CustomerTwinView } from "@/lib/voice-twin/view";

/** The AI Voice Twin's status word: Off, Collecting your voice, Making…, Ready or Couldn't be made. */
export function twinStatusWord(twin: CustomerTwinView): string {
  if (!twin.consent) return "Off";
  if (twin.usable) return "Ready";
  switch (twin.state) {
    case "cloning":
      return "Making…";
    case "failed":
      return "Couldn't be made";
    default:
      return "Collecting your voice";
  }
}

/** Main-screen card linking to Settings, with the twin's status (Off / progress / ready until … / failed). */
export function VoiceTwinCard({ twin, now }: { twin: CustomerTwinView | null; now: number }) {
  if (!twin) return null;
  const word = twinStatusWord(twin);
  /** Whether calls are adding to the twin right now: shown under the bar while collecting. */
  const capture = liveCaptureStatus(twin);
  return (
    <Link
      href="/protect/settings"
      className="block space-y-3 rounded-2xl border border-border bg-card/60 p-4 active:scale-[0.99]"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-semibold">
          <AudioLines className="size-5 text-primary" aria-hidden />
          {VOICE_TWIN_LABEL}
        </span>
        <span className="flex items-center gap-1 text-sm text-muted-foreground">
          {word}
          <ChevronRight className="size-4" aria-hidden />
        </span>
      </div>
      {!twin.consent ? (
        <p className="text-xs text-muted-foreground">
          Let an AI copy of your own voice keep scammers talking, only if you choose it. Set it up in Settings.
        </p>
      ) : twin.usable ? (
        <p className="text-sm">
          Ready until {twinExpiryLabel(twin.voiceExpiresAt, now) || "later today"}.
          {twin.voiceSource === "fallback" && <span className="text-muted-foreground"> Using your backup copy of your voice.</span>}
        </p>
      ) : (
        <>
          <VoiceTwinProgress
            progress={twinProgress(twin)}
            status={twin.state === "ready" ? "collecting" : twin.state}
            failedText="Couldn't be made. Open Settings to try again."
          />
          {capture && twin.state === "collecting" && (
            <p className={`text-xs ${capture === "on" ? "text-muted-foreground" : "font-medium text-amber-400"}`}>{LIVE_CAPTURE_TEXT[capture].card}</p>
          )}
        </>
      )}
    </Link>
  );
}
