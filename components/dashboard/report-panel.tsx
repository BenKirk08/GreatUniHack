"use client";

import { CheckCircle2, ClipboardCopy, FileText, Loader2, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime, SCAM_TYPE_LABELS } from "@/lib/format";
import { formatConsentTime, formatSpeechSeconds, personaReportLabel, takeoverSummary } from "@/lib/persona-meta";
import type { CallRow, ReportBody, ReportRow } from "@/lib/types";

/**
 * The report's takeover block. Reports written before the Voice Twin have no body.takeover: work it out from the call
 * (or, without the call, from meta.persona).
 */
function reportTakeover(report: ReportRow, call: CallRow | null): ReportBody["takeover"] {
  const body = report.body;
  if (body.takeover) return body.takeover;
  if (call && call.id === report.call_id) return takeoverSummary(call);
  const persona = body.meta.persona;
  if (!persona) return undefined;
  return { type: "persona", label: personaReportLabel(persona), speech_seconds: null, consent_at: null };
}

/**
 * "Takeover: AI voice: older female (from settings) · as Joan Whitaker", "Takeover: AI Voice Twin (consented) · 42 s of
 * the customer's speech" and, for the twin, its consent reference.
 */
function TakeoverLines({ takeover }: { takeover: NonNullable<ReportBody["takeover"]> }) {
  const twin = takeover.type === "voice_twin";
  const speech = twin ? formatSpeechSeconds(takeover.speech_seconds) : null;
  const consentLocal = twin ? formatConsentTime(takeover.consent_at) : "";
  return (
    <div className="space-y-0.5 text-xs">
      <p>
        <span className="text-muted-foreground">Takeover: </span>
        <span className={twin ? "font-semibold text-violet-300" : "font-semibold"}>{takeover.label}</span>
        {speech && <span className="text-muted-foreground"> · {speech} of the customer&apos;s speech</span>}
        {takeover.ai_voice && <span className="text-muted-foreground"> · as {takeover.ai_voice.name}</span>}
      </p>
      {twin && (
        <p>
          <span className="text-muted-foreground">Consent reference: </span>
          {takeover.consent_at ? (
            <>
              <code className="font-mono">{takeover.consent_at}</code>
              {consentLocal && <span className="text-muted-foreground"> ({consentLocal})</span>}
            </>
          ) : (
            <span className="text-destructive">not recorded</span>
          )}
        </p>
      )}
    </div>
  );
}

/** Why an ended call has no report (so analysts aren't left guessing). */
function noReportReason(call: CallRow, riskThreshold: number): string | null {
  const callerSpoke =
    call.screening_transcript.some((s) => s.speaker === "caller" && s.text.trim()) ||
    call.transcript.some((t) => t.role === "scammer" && t.message.trim());
  if (call.handoff_status !== "connected" && (call.risk?.peak ?? 0) < riskThreshold) {
    return `Risk peaked at ${call.risk?.peak ?? 0}, below the ${riskThreshold} threshold, so there is no report.`;
  }
  if (!callerSpoke) return "This call ended before the caller said anything, so there is no report.";
  return null;
}

export function ReportPanel(props: {
  call: CallRow | null;
  report: ReportRow | null;
  autoSend: boolean | null;
  now: number;
  riskThreshold: number;
  onApprove: (reportId: string, approvedBy: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [sending, setSending] = useState(false);
  const { call, report } = props;
  const body = report?.body;
  const takeover = report ? reportTakeover(report, call) : undefined;

  const approve = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!report || !name.trim()) return;
    setSending(true);
    try {
      await props.onApprove(report.id, name.trim());
      setOpen(false);
      toast.success("Report approved and emailed to the fraud team");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  const copyReportFraud = async () => {
    if (!body) return;
    try {
      await navigator.clipboard.writeText(body.recommended_actions.report_fraud_ready);
      toast.success("Copied — paste it into reportfraud.police.uk");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card/80">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
        <FileText className="size-4 text-muted-foreground" />
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Fraud report</h2>

        {report?.status === "sent" && (
          <div className="ml-auto flex -rotate-2 items-center gap-2 rounded-md border-2 border-emerald-400/70 px-3 py-1 font-mono text-sm font-bold tracking-widest text-emerald-300">
            <CheckCircle2 className="size-4" />
            SENT {formatDateTime(report.sent_at)} · {report.approved_by ? report.approved_by : "auto"}
          </div>
        )}
        {report?.status === "draft" && (
          <div className="ml-auto flex items-center gap-3">
            <span className="rounded bg-amber-400/15 px-2 py-0.5 text-xs font-semibold text-amber-300">DRAFT · awaiting approval</span>
            <Button onClick={() => setOpen(true)}>
              <Send /> Approve &amp; Send
            </Button>
          </div>
        )}
      </div>

      <div className="px-4 py-3">
        {!call && <p className="text-sm text-muted-foreground">No call selected.</p>}
        {call && !report && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            {call.status === "live" ? (
              <>
                If the risk reaches {props.riskThreshold} or Northgate takes over, the report is written when the call ends
                {props.autoSend ? " and emailed automatically." : " and held for approval."}
              </>
            ) : noReportReason(call, props.riskThreshold) ? (
              noReportReason(call, props.riskThreshold)
            ) : props.now > 0 && call.ended_at && props.now - Date.parse(call.ended_at) > 3 * 60_000 ? (
              "No report was produced for this call. Check the server logs, then run scripts/regenerate-report.ts with this call id."
            ) : (
              <>
                <Loader2 className="size-4 animate-spin" /> Writing the report…
              </>
            )}
          </p>
        )}

        {body && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-2">
              <h3 className="text-base font-semibold">{body.title}</h3>
              <p className="text-sm leading-relaxed text-foreground/90">{body.summary}</p>
              <p className="text-xs text-muted-foreground">
                {SCAM_TYPE_LABELS[body.scam_type]} · risk {body.meta.risk_score ?? "—"} · Northgate check:{" "}
                <span className={body.mule_findings.status === "match" ? "font-semibold text-destructive" : ""}>
                  {body.mule_findings.status.replace("_", " ")}
                </span>
              </p>
              {takeover && <TakeoverLines takeover={takeover} />}
              {(body.protection_timeline ?? []).length > 0 && (
                <div className="mt-2 rounded-lg border border-sky-400/30 bg-sky-400/5 p-2">
                  <h4 className="mb-1 text-[11px] uppercase tracking-[0.14em] text-sky-300">Protection timeline</h4>
                  <ol className="space-y-0.5 text-xs">
                    {(body.protection_timeline ?? []).map((t, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="w-16 shrink-0 font-mono text-muted-foreground">{t.time}</span>
                        <span>{t.event}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {body.timeline.length > 0 && (
                <ol className="mt-2 space-y-1 text-sm">
                  {body.timeline.map((t, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{t.time}</span>
                      <span>{t.event}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="space-y-2 text-sm">
              <h4 className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Recommended actions</h4>
              <ul className="space-y-1.5">
                <li>
                  <span className="font-semibold">Freeze: </span>
                  {body.recommended_actions.freeze_account}
                </li>
                <li>
                  <span className="font-semibold">Contact payers: </span>
                  {body.recommended_actions.contact_affected_payers}
                </li>
                {body.recommended_actions.other.map((o, i) => (
                  <li key={i}>• {o}</li>
                ))}
              </ul>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Report Fraud–ready</h4>
                <Button size="xs" variant="outline" onClick={copyReportFraud}>
                  <ClipboardCopy /> Copy
                </Button>
              </div>
              <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-background/50 p-2 font-mono text-xs leading-relaxed">
                {body.recommended_actions.report_fraud_ready}
              </pre>
              <p className="text-[11px] text-muted-foreground">
                Emailed only to the fraud team inbox. Never sent to the police automatically — an analyst files it.
              </p>
            </div>
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={approve} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Approve and send report</DialogTitle>
              <DialogDescription>
                The report will be emailed to the Northgate fraud team inbox under your name.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="analyst-name">Analyst name</Label>
              <Input
                id="analyst-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Priya Shah"
                autoFocus
                maxLength={100}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={sending || !name.trim()}>
                {sending ? <Loader2 className="animate-spin" /> : <Send />} Approve &amp; Send
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
