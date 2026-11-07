"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import type { Ref } from "react";
import { VoiceTwinProgress } from "@/components/protect/voice-twin-progress";
import type { TakeoverChoice } from "@/lib/types";
import { alertTwinSection } from "@/lib/voice-twin/popup";
import type { CustomerTwinView } from "@/lib/voice-twin/view";

export const ALERT_TEXT = {
  title: "Suspected scam",
  useTwin: "Use my Voice Twin",
  useAiVoice: "Use AI voice",
  setUpTwin: "Set up Voice Twin",
  dismiss: "I know this caller",
  handingOver: "Handing over…",
  saving: "Saving…",
} as const;

export interface ScamAlertProps {
  /** The caller's two most suspicious lines so far, verbatim (CustomerCall.risk.quotes). */
  quotes: readonly string[];
  twin: CustomerTwinView | null;
  /** What is in flight: a handover (and to whom) or the dismiss. */
  busy: { action: "handover"; choice: TakeoverChoice } | { action: "dismiss" } | null;
  error: string | null;
  onHandOver: (choice: TakeoverChoice) => void;
  onDismiss: () => void;
  titleRef?: Ref<HTMLHeadingElement>;
}

/**
 * The full-screen scam alert on /protect. Top to bottom, and nothing else: the title, the caller's two most suspicious
 * quotes, the AI Voice Twin section (set-up link, progress bar, or "Use my Voice Twin"), one large "Use AI voice"
 * button, and the small "I know this caller" link. The buttons sit at the bottom, in thumb reach, with large tap
 * targets. Each part carries data-alert-part so the order is tested (tests/scam-alert.test.tsx).
 */
export function ScamAlert({ quotes, twin, busy, error, onHandOver, onDismiss, titleRef }: ScamAlertProps) {
  const section = alertTwinSection(twin);
  const disabled = busy !== null;
  const handingOver = (choice: TakeoverChoice) => busy?.action === "handover" && busy.choice === choice;
  return (
    <main
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="alert-title"
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))] text-foreground"
    >
      <h1
        id="alert-title"
        ref={titleRef}
        tabIndex={-1}
        data-alert-part="title"
        className="text-[2.75rem] font-extrabold leading-none tracking-tight text-[oklch(0.68_0.22_25)] outline-none"
      >
        {ALERT_TEXT.title}
      </h1>

      {quotes.length > 0 && (
        <ul className="mt-6 space-y-4">
          {quotes.slice(0, 2).map((quote) => (
            <li key={quote} data-alert-part="quote">
              <blockquote className="border-l-4 border-[oklch(0.68_0.22_25)] pl-4 text-xl font-medium leading-snug">
                &ldquo;{quote}&rdquo;
              </blockquote>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto space-y-4 pt-8">
        <section data-alert-part="twin" aria-label="Your Voice Twin">
          {section.kind === "setup" && (
            <Link href="/protect/settings" className="inline-flex min-h-11 items-center text-base font-medium text-muted-foreground underline underline-offset-4">
              {ALERT_TEXT.setUpTwin}
            </Link>
          )}
          {section.kind === "progress" && <VoiceTwinProgress progress={section.progress} status={section.status} />}
          {section.kind === "ready" && (
            <button
              type="button"
              onClick={() => onHandOver("voice_twin")}
              disabled={disabled}
              aria-busy={handingOver("voice_twin")}
              className="flex min-h-20 w-full items-center justify-center gap-2 rounded-2xl bg-white px-5 text-2xl font-bold text-[oklch(0.25_0.03_265)] shadow-lg active:scale-[0.99] disabled:opacity-60"
            >
              {handingOver("voice_twin") && <Loader2 className="size-6 shrink-0 animate-spin" aria-hidden />}
              {handingOver("voice_twin") ? ALERT_TEXT.handingOver : ALERT_TEXT.useTwin}
            </button>
          )}
        </section>

        <button
          type="button"
          data-alert-part="ai-voice"
          onClick={() => onHandOver("ai_voice")}
          disabled={disabled}
          aria-busy={handingOver("ai_voice")}
          className="flex min-h-24 w-full items-center justify-center gap-2 rounded-2xl bg-[oklch(0.55_0.22_25)] px-5 text-3xl font-bold text-white shadow-lg active:scale-[0.99] disabled:opacity-60"
        >
          {handingOver("ai_voice") && <Loader2 className="size-7 shrink-0 animate-spin" aria-hidden />}
          {handingOver("ai_voice") ? ALERT_TEXT.handingOver : ALERT_TEXT.useAiVoice}
        </button>

        {error && (
          <p role="alert" className="rounded-xl border border-destructive/60 bg-destructive/15 p-3 text-base">
            {error}
          </p>
        )}

        <button
          type="button"
          data-alert-part="dismiss"
          onClick={onDismiss}
          disabled={disabled}
          aria-busy={busy?.action === "dismiss"}
          className="mx-auto flex min-h-12 items-center px-4 text-base text-muted-foreground underline underline-offset-4 disabled:opacity-60"
        >
          {busy?.action === "dismiss" ? ALERT_TEXT.saving : ALERT_TEXT.dismiss}
        </button>
      </div>
    </main>
  );
}
