"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VoiceTwinState } from "@/lib/types";
import type { TwinProgress } from "@/lib/voice-twin/popup";

/**
 * The AI Voice Twin's progress: a bar of the customer's clean speech so far with a marker at the "good quality"
 * target, and "18s / 30s of your voice" underneath. While cloning it says so; when cloning failed it shows
 * `failedText`. Shared by the takeover pop-up (tone "alert": white on red), the main screen and Settings.
 */
export function VoiceTwinProgress({
  progress,
  status,
  tone = "card",
  failedText = "Couldn't be made",
  className,
}: {
  progress: TwinProgress;
  status: VoiceTwinState;
  tone?: "alert" | "card";
  failedText?: string;
  className?: string;
}) {
  const alert = tone === "alert";
  if (status === "cloning") {
    return (
      <span className={cn("flex items-center gap-2 text-sm font-semibold", className)}>
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
        Making your AI Voice Twin…
      </span>
    );
  }
  if (status === "failed") {
    return <span className={cn("block text-sm font-semibold", alert ? "text-white" : "text-destructive", className)}>{failedText}</span>;
  }

  const pct = (f: number) => `${(f * 100).toFixed(2)}%`;
  const whole = Math.floor(progress.speechSeconds);
  return (
    <span className={cn("block w-full space-y-1", className)}>
      <span
        role="progressbar"
        aria-label="Your voice recorded so far"
        aria-valuemin={0}
        aria-valuemax={Math.round(progress.minSeconds)}
        aria-valuenow={Math.min(whole, Math.round(progress.minSeconds))}
        aria-valuetext={progress.progressLabel}
        className="relative block h-3 w-full"
      >
        <span className={cn("block h-full w-full overflow-hidden rounded-full", alert ? "bg-black/35" : "bg-muted")}>
          <span
            className={cn("block h-full rounded-full transition-[width] duration-500", alert ? "bg-white" : "bg-primary")}
            style={{ width: pct(progress.fill) }}
          />
        </span>
        {/* Where the twin can first be made. */}
        <span aria-hidden className={cn("absolute inset-y-0 w-px", alert ? "bg-white/60" : "bg-foreground/40")} style={{ left: pct(progress.minMark) }} />
        {/* The "good quality" target. */}
        <span
          aria-hidden
          className={cn("absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full", alert ? "bg-amber-200" : "bg-amber-400")}
          style={{ left: pct(progress.targetMark) }}
        />
      </span>
      <span className="relative block h-4" aria-hidden>
        {/* Shifted left by the same fraction as the marker, so the label never runs off either edge. */}
        <span
          className={cn("absolute whitespace-nowrap text-[11px] font-medium", alert ? "text-amber-100" : "text-amber-400")}
          style={{ left: pct(progress.targetMark), transform: `translateX(-${pct(progress.targetMark)})` }}
        >
          good quality
        </span>
      </span>
      <span className={cn("block text-sm font-semibold tabular-nums", alert ? "text-white" : "text-foreground")}>{progress.progressLabel}</span>
    </span>
  );
}
