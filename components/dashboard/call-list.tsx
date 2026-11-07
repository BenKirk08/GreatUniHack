"use client";

import { AlertTriangle, AudioLines, PhoneIncoming, PhoneOutgoing, ShieldAlert, ShieldCheck } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { callDurationSecs, formatClockTime, formatDuration, SCAM_TYPE_LABELS } from "@/lib/format";
import { formatSpeechSeconds, takeoverLabel, takeoverShortLabel } from "@/lib/persona-meta";
import type { CallRow, ReportRow } from "@/lib/types";

/**
 * The takeover under a handed-over call: "AI voice: older female (from settings)", the AI Voice Twin and the speech it
 * used, or a legacy persona's name.
 */
function TakeoverLine({ call }: { call: CallRow }) {
  const twin = call.takeover_kind === "voice_twin";
  if (call.handoff_status === "failed") {
    const tried = twin ? `the ${takeoverShortLabel(call)}` : takeoverLabel(call);
    return (
      <div className="mt-1 flex items-center gap-1 text-xs text-destructive">
        <ShieldAlert className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{tried ? `Handover to ${tried} failed` : "Handover failed"}</span>
      </div>
    );
  }
  if (call.handoff_status !== "connected") return null;
  const label = takeoverLabel(call) || "Northgate persona";
  const speech = twin ? formatSpeechSeconds(call.voice_twin_speech_seconds) : null;
  return (
    <div className={`mt-1 flex items-center gap-1 text-xs ${twin ? "text-violet-300" : "text-sky-300"}`}>
      {twin ? <AudioLines className="size-3 shrink-0" aria-hidden /> : <ShieldCheck className="size-3 shrink-0" aria-hidden />}
      <span className="truncate">{label}</span>
      {speech && <span className="shrink-0 font-mono text-muted-foreground">· {speech} speech</span>}
    </div>
  );
}

export function CallList(props: {
  calls: CallRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  now: number;
  reportsByCall: Record<string, ReportRow>;
}) {
  return (
    <section className="flex min-h-[16rem] flex-col overflow-hidden rounded-xl border border-border bg-card/80 lg:min-h-0">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Calls</h2>
        <span className="text-xs text-muted-foreground">{props.calls.filter((c) => c.status === "live").length} live</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="space-y-1 p-2">
          {props.calls.length === 0 && (
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">No calls yet. Waiting for the phone to ring…</li>
          )}
          {props.calls.map((call) => {
            const live = call.status === "live";
            const selected = call.id === props.selectedId;
            const mule = call.mule_match?.status === "match";
            const report = props.reportsByCall[call.id];
            return (
              <li key={call.id}>
                <button
                  type="button"
                  onClick={() => props.onSelect(call.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected ? "border-primary/60 bg-primary/10" : "border-transparent hover:bg-accent/60"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {live ? (
                      <span className="live-pulse size-2.5 shrink-0 rounded-full bg-destructive" aria-label="Live" />
                    ) : (
                      <span className="size-2.5 shrink-0 rounded-full bg-muted-foreground/40" aria-label="Ended" />
                    )}
                    {call.direction === "outbound" ? (
                      <PhoneOutgoing className="size-3.5 text-muted-foreground" aria-label="Outbound" />
                    ) : (
                      <PhoneIncoming className="size-3.5 text-muted-foreground" aria-label="Inbound" />
                    )}
                    <span className="font-mono text-sm font-medium">{call.caller_masked ?? "unknown"}</span>
                    {call.handoff_status === "offered" && live && (
                      <span className="rounded bg-destructive/20 px-1.5 text-[10px] font-bold text-destructive">ALERT</span>
                    )}
                    {call.handoff_status === "connected" && (
                      <ShieldCheck
                        className="size-3.5 text-sky-300"
                        aria-label={`Taken over by Northgate · ${takeoverLabel(call) || "persona"}`}
                      />
                    )}
                    <span className={`ml-auto font-mono text-xs tabular-nums ${live ? "text-destructive" : "text-muted-foreground"}`}>
                      {formatDuration(callDurationSecs(call, props.now))}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatClockTime(call.started_at)}</span>
                    {(call.intel ?? call.risk) && (
                      <span className="truncate">· {SCAM_TYPE_LABELS[(call.intel ?? call.risk)!.scam_type]}</span>
                    )}
                    {call.risk && <span className="font-mono">· {call.risk.peak}</span>}
                    {mule && (
                      <span className="ml-auto inline-flex items-center gap-1 font-semibold text-destructive">
                        <AlertTriangle className="size-3" /> MULE
                      </span>
                    )}
                    {!mule && report && (
                      <span className={`ml-auto ${report.status === "sent" ? "text-emerald-400" : "text-amber-300"}`}>
                        {report.status === "sent" ? "sent" : "draft"}
                      </span>
                    )}
                  </div>
                  <TakeoverLine call={call} />
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </section>
  );
}
