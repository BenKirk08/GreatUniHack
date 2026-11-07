"use client";

import { ShieldCheck } from "lucide-react";
import { useEffect, useRef } from "react";
import { callDurationSecs, formatClockTime, formatDuration } from "@/lib/format";
import { handoffByLabel, isPersonaId, takeoverLabel, takeoverShortLabel } from "@/lib/persona-meta";
import { formatClock } from "@/lib/transcript";
import type { CallRow } from "@/lib/types";
import { VOICE_TWIN_LABEL } from "@/lib/voice-twin/config";

/** "twin" lines are the AI Voice Twin: the customer's cloned voice, so styled apart from both the customer and personas. */
type Line = { key: string; who: "caller" | "customer" | "persona" | "twin"; label: string; text: string; clock?: string };

const STYLES: Record<Line["who"], { row: string; bubble: string; label: string }> = {
  caller: {
    row: "justify-start",
    bubble: "rounded-tl-sm border-rose-500/30 bg-rose-500/10 text-rose-50",
    label: "text-rose-300",
  },
  customer: {
    row: "justify-end",
    bubble: "rounded-tr-sm border-emerald-400/30 bg-emerald-400/10 text-emerald-50",
    label: "text-emerald-300",
  },
  persona: {
    row: "justify-end",
    bubble: "rounded-tr-sm border-sky-400/30 bg-sky-400/10 text-sky-50",
    label: "text-sky-300",
  },
  twin: {
    row: "justify-end",
    bubble: "rounded-tr-sm border-violet-400/30 bg-violet-400/10 text-violet-50",
    label: "text-violet-300",
  },
};

function Bubble({ line }: { line: Line }) {
  const s = STYLES[line.who];
  return (
    <li className={`flex ${s.row}`}>
      <div className={`max-w-[80%] rounded-2xl border px-3.5 py-2 text-sm leading-relaxed ${s.bubble}`}>
        <div className={`mb-0.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider ${s.label}`}>
          {line.label}
          {line.clock && <span className="font-mono font-normal text-muted-foreground">{line.clock}</span>}
        </div>
        {line.text}
      </div>
    </li>
  );
}

export function TranscriptView({ call, now, customerFirstName }: { call: CallRow | null; now: number; customerFirstName: string }) {
  const endRef = useRef<HTMLDivElement>(null);
  const screening = call?.screening_transcript ?? [];
  const persona = call?.transcript ?? [];
  const twin = call?.takeover_kind === "voice_twin";
  // Agent lines are labelled "AI voice" or "AI Voice Twin" (never the customer's name), or a legacy persona's first name.
  const personaName = (call && takeoverShortLabel(call)) || "Persona";
  // The divider names the twin and the AI voice in full ("AI voice: older female (from settings)"), a legacy persona by
  // first name.
  const aiVoice = Boolean(call && !twin && isPersonaId(call.persona));
  const takeoverName = (call && (twin || aiVoice ? takeoverLabel(call) : takeoverShortLabel(call))) || "persona";
  const startedAt = call ? Date.parse(call.started_at) : 0;

  const screeningLines: Line[] = screening.map((s, i) => ({
    key: `s${i}`,
    who: s.speaker === "caller" ? "caller" : "customer",
    label: s.speaker === "caller" ? "Caller" : customerFirstName || "Customer",
    text: s.text,
    clock: formatClock((Date.parse(s.at) - startedAt) / 1000),
  }));
  // Persona times are relative to the takeover: shift them into call time, like combinedTranscript() does.
  const lastScreeningSecs = screening.length ? (Date.parse(screening[screening.length - 1].at) - startedAt) / 1000 : 0;
  const personaOffset = call?.handoff_at ? Math.max(0, (Date.parse(call.handoff_at) - startedAt) / 1000) : Math.max(0, lastScreeningSecs);
  const personaLines: Line[] = persona.map((t, i) => ({
    key: `p${i}`,
    who: t.role === "scammer" ? "caller" : twin ? "twin" : "persona",
    label: t.role === "scammer" ? "Caller" : personaName,
    text: t.message,
    clock: t.time_in_call_secs !== undefined ? formatClock(t.time_in_call_secs + personaOffset) : undefined,
  }));
  const takenOver = call?.handoff_status === "connected";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [screening.length, persona.length, call?.id, call?.handoff_status]);

  return (
    <section className="flex min-h-[24rem] flex-col overflow-hidden rounded-xl border border-border bg-card/80 lg:min-h-0">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Transcript</h2>
        {call && (
          <>
            <span className="font-mono text-sm">{call.caller_masked ?? "unknown"}</span>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              <span className="text-rose-300">Caller</span> · <span className="text-emerald-300">{customerFirstName || "Customer"}</span> ·{" "}
              {twin ? (
                <span className="text-violet-300">{VOICE_TWIN_LABEL}</span>
              ) : (
                <span className="text-sky-300">{aiVoice || !call.persona ? "AI voice" : "Northgate persona"}</span>
              )}
            </span>
            <span
              className={`ml-auto rounded px-2 py-0.5 text-xs font-semibold ${
                call.status === "live" ? "bg-destructive/20 text-destructive" : "bg-muted text-muted-foreground"
              }`}
            >
              {call.status === "live" ? "LIVE" : "ENDED"} · {formatDuration(callDurationSecs(call, now))}
            </span>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!call && <p className="py-16 text-center text-sm text-muted-foreground">Select a call to see the conversation.</p>}
        {call && screeningLines.length === 0 && personaLines.length === 0 && (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {call.status === "live" ? `Ringing ${customerFirstName || "the customer"}… the screening transcript appears as they talk.` : "No transcript was captured."}
          </p>
        )}
        <ol className="space-y-3">
          {screeningLines.map((line) => (
            <Bubble key={line.key} line={line} />
          ))}
        </ol>
        {(takenOver || personaLines.length > 0) && (
          <div
            className={`my-4 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.14em] ${
              twin ? "text-violet-300" : "text-sky-300"
            }`}
            role="separator"
          >
            <span className={`h-px flex-1 ${twin ? "bg-violet-400/40" : "bg-sky-400/40"}`} />
            <ShieldCheck className="size-4" aria-hidden />
            <span className="text-center">
              Northgate took over · {takeoverName} · by {handoffByLabel(call?.handoff_by)} · {formatClockTime(call?.handoff_at)}
            </span>
            <span className={`h-px flex-1 ${twin ? "bg-violet-400/40" : "bg-sky-400/40"}`} />
          </div>
        )}
        {takenOver && personaLines.length === 0 && call?.status === "live" && (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {twin ? `The ${VOICE_TWIN_LABEL}` : personaName} is talking to the caller. Lines appear as details are written down.
          </p>
        )}
        <ol className="space-y-3">
          {personaLines.map((line) => (
            <Bubble key={line.key} line={line} />
          ))}
        </ol>
        <div ref={endRef} />
      </div>
    </section>
  );
}
