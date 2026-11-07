"use client";

import { AudioLines, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { RiskGauge } from "@/components/risk-gauge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatClockTime, SCAM_TYPE_LABELS, TACTIC_LABELS } from "@/lib/format";
import {
  aiVoiceMatchOf,
  handoffByLabel,
  isPersonaId,
  personaCharacterLine,
  takeoverLabel,
  takeoverShortLabel,
  voiceTwinDetail,
} from "@/lib/persona-meta";
import type { CallRow } from "@/lib/types";
import { aiVoiceMatchDetail } from "@/lib/voice-match";
import { VOICE_TWIN_LABEL } from "@/lib/voice-twin/config";

const CLAIMABLE = new Set(["none", "offered", "declined"]);

function HandoffChip({ call }: { call: CallRow }) {
  const twin = call.takeover_kind === "voice_twin";
  const who = takeoverShortLabel(call);
  const map: Record<CallRow["handoff_status"], [string, string]> = {
    none: ["Screening", "bg-muted text-muted-foreground"],
    offered: ["Customer alerted", "bg-destructive/20 text-destructive"],
    declined: ["Customer: “I know this caller”", "bg-amber-400/15 text-amber-300"],
    requested: [twin ? `Handing over to the ${VOICE_TWIN_LABEL}…` : "Taking over…", "bg-sky-400/15 text-sky-300"],
    connected: [
      `Northgate has the call${who ? ` · ${who}` : ""}`,
      twin ? "bg-violet-400/15 text-violet-300" : "bg-sky-400/15 text-sky-300",
    ],
    failed: [twin ? `${VOICE_TWIN_LABEL} handover failed` : "Handover failed", "bg-destructive/20 text-destructive"],
  };
  const [text, cls] = map[call.handoff_status] ?? map.none;
  return <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{text}</span>;
}

/**
 * Which AI voice took the call and why: "age inferred from the call · gender from settings · high confidence", then
 * "Speaking as Joan Whitaker, 79 (retired school secretary, Harrogate)". Nothing for the twin or legacy personas.
 */
function AiVoiceDetail({ call, className }: { call: CallRow; className?: string }) {
  if (call.takeover_kind === "voice_twin" || !isPersonaId(call.persona)) return null;
  const match = aiVoiceMatchOf(call);
  const why = match ? aiVoiceMatchDetail(match) : "";
  return (
    <p className={className}>
      {why && <span className="block">{why}</span>}
      <span className="block">{personaCharacterLine(call.persona)}</span>
    </p>
  );
}

/**
 * "Taken over by the customer at 21:16:03 · AI voice: older female (from settings)", plus why that voice and who it
 * plays, or the twin's speech and consent reference.
 */
function TakenOverNote({ call }: { call: CallRow }) {
  const twin = call.takeover_kind === "voice_twin";
  const label = takeoverLabel(call);
  const detail = voiceTwinDetail(call);
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
        twin ? "border-violet-400/40 bg-violet-400/10 text-violet-100" : "border-sky-400/40 bg-sky-400/10 text-sky-100"
      }`}
    >
      {twin ? <AudioLines className="size-4 shrink-0" aria-hidden /> : <ShieldCheck className="size-4 shrink-0" aria-hidden />}
      <div className="min-w-0 space-y-0.5">
        <p>
          Taken over by {handoffByLabel(call.handoff_by)} at {formatClockTime(call.handoff_at)}
          {label ? ` · ${label}` : ""}.
        </p>
        {!twin && <AiVoiceDetail call={call} className="text-sky-200/80" />}
        {twin && (
          <p className="text-violet-200/80">
            {detail || "No consent reference recorded"}
            {call.voice_twin_consent_at && (
              <span className="block font-mono text-[10px] text-muted-foreground">Consent reference: {call.voice_twin_consent_at}</span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/** Rendered with key={call.id}, so the dialog never carries over to another call. */
export function RiskPanel(props: {
  call: CallRow | null;
  riskThreshold: number;
  analystName: string;
  onAnalystNameChange: (name: string) => void;
  onTakeover: (callId: string, approvedBy: string) => Promise<void>;
}) {
  const { call } = props;
  const [open, setOpen] = useState(false);
  const name = props.analystName;
  const setName = props.onAnalystNameChange;
  const [sending, setSending] = useState(false);
  const risk = call?.risk ?? null;
  const canTakeOver = Boolean(call && call.status === "live" && CLAIMABLE.has(call.handoff_status));
  // Close the dialog if the call stops being claimable while it's open (someone else took it over, or it ended).
  if (open && !canTakeOver) setOpen(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!call || !name.trim()) return;
    setSending(true);
    try {
      await props.onTakeover(call.id, name.trim());
      setOpen(false);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card/80">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Live risk</h2>
        {call && <HandoffChip call={call} />}
      </div>
      <div className="space-y-3 p-4">
        {!call && <p className="py-4 text-center text-sm text-muted-foreground">No call selected.</p>}
        {call && (
          <>
            <div className="flex items-start gap-3">
              <RiskGauge score={risk?.score ?? null} threshold={props.riskThreshold} />
              <div className="min-w-0 flex-1 space-y-1.5 pt-1">
                <div className="text-sm">
                  {risk ? (
                    <>
                      <span className="font-semibold">{SCAM_TYPE_LABELS[risk.scam_type]}</span>
                      <span className="text-muted-foreground"> · peak {risk.peak}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{call.status === "live" ? "Listening…" : "Not scored"}</span>
                  )}
                </div>
                {risk?.reason && <p className="text-sm leading-snug text-foreground/90">{risk.reason}</p>}
                {risk && risk.tactics.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {risk.tactics.map((t) => (
                      <Badge key={t} variant="outline" className="border-amber-400/40 bg-amber-400/10 text-[10px] text-amber-200">
                        {TACTIC_LABELS[t]}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {call.handoff_status === "connected" && <TakenOverNote call={call} />}
            {call.handoff_status === "failed" && (
              <p className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs">
                <ShieldAlert className="size-4 shrink-0 text-destructive" />
                {call.takeover_kind === "voice_twin"
                  ? `Handover to the ${VOICE_TWIN_LABEL} failed`
                  : `Handover${takeoverLabel(call) ? ` (${takeoverLabel(call)})` : ""} failed`}
                ; the customer is still on the line. {call.handoff_error}
              </p>
            )}

            {canTakeOver && (
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">AI voice matched to the customer automatically</p>
                <Button variant="destructive" onClick={() => setOpen(true)}>
                  <ShieldCheck /> Take over now
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Take over the call from {call?.caller_masked ?? "this caller"}</DialogTitle>
              <DialogDescription>
                The customer&apos;s side of the call will drop and the AI voice will carry on with the caller as the customer. Its age and gender
                are matched to the customer automatically (their setting, else what&apos;s been said on the call, else the default), just as
                when the customer hands over. This is recorded under your name.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="takeover-analyst">Analyst name</Label>
              <Input id="takeover-analyst" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam Patel" autoFocus maxLength={100} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={sending || !name.trim()}>
                {sending ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Take over now
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
