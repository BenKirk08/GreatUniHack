import { Resend } from "resend";
import { serverEnv } from "@/lib/env";
import { formatPounds } from "@/lib/normalise";
import { formatSpeechSeconds, personaReportLabel } from "@/lib/persona-meta";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ReportBody, ReportRow } from "@/lib/types";

let resendClient: Resend | undefined;
function resend(): Resend {
  resendClient ??= new Resend(serverEnv().RESEND_API_KEY);
  return resendClient;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const label = (s: string) => s.replace(/_/g, " ");

/**
 * The email's "Takeover" and "Consent reference" values (plain text, unescaped). Reports written before the Voice Twin
 * have no body.takeover: they show the persona from meta.persona if there is one, and no takeover row otherwise.
 */
function takeoverLines(body: ReportBody): { takeover: string | null; consent: string | null } {
  const t = body.takeover;
  if (!t) {
    const persona = body.meta.persona;
    if (!persona) return { takeover: null, consent: null };
    return { takeover: personaReportLabel(persona), consent: null };
  }
  if (t.type !== "voice_twin") return { takeover: `${t.label}${t.ai_voice ? ` · as ${t.ai_voice.name}` : ""}`, consent: null };
  const speech = formatSpeechSeconds(t.speech_seconds);
  return { takeover: `${t.label}${speech ? ` · ${speech} of the customer's speech` : ""}`, consent: t.consent_at ?? "not recorded" };
}

export function renderReportEmail(
  body: ReportBody,
  opts: { approvedBy?: string | null; reportId: string; dashboardUrl?: string },
): { subject: string; html: string; text: string } {
  const e = escapeHtml;
  const sentBy = opts.approvedBy ? `Approved by ${opts.approvedBy}` : "Sent automatically";
  const payee = body.payee;
  const muleColour = body.mule_findings.status === "match" ? "#b91c1c" : body.mule_findings.status === "name_only" ? "#b45309" : "#334155";
  const subject = `[Northgate Fraud] ${body.title}${body.mule_findings.status === "match" ? " — SUSPECTED MULE ACCOUNT" : ""}`;
  const takeover = takeoverLines(body);

  const row = (k: string, v: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#64748b;white-space:nowrap;vertical-align:top">${e(k)}</td><td style="padding:4px 0">${v}</td></tr>`;

  const html = `<!doctype html>
<html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a">
<div style="max-width:680px;margin:0 auto;padding:24px">
  <div style="background:#0b1220;color:#e2e8f0;padding:16px 20px;border-radius:10px 10px 0 0">
    <div style="font-weight:700;letter-spacing:.08em">NORTHGATE BANK · FRAUD OPERATIONS</div>
    <div style="font-size:12px;color:#94a3b8">Internal fraud report — Call Guard intelligence. ${e(sentBy)}.</div>
  </div>
  <div style="background:#fff;padding:20px;border-radius:0 0 10px 10px">
    <h1 style="font-size:20px;margin:0 0 8px">${e(body.title)}</h1>
    <p style="margin:0 0 16px;line-height:1.5">${e(body.summary)}</p>
    <div style="border-left:4px solid ${muleColour};background:#f8fafc;padding:10px 14px;margin:0 0 16px">
      <div style="font-weight:700;color:${muleColour}">${
        body.mule_findings.status === "match" ? "SUSPECTED MULE ACCOUNT" : `Northgate account check: ${e(label(body.mule_findings.status))}`
      }</div>
      <div style="font-size:14px;line-height:1.5">${e(body.mule_findings.detail)}</div>
    </div>
    <table style="font-size:14px;border-collapse:collapse;margin-bottom:16px">
      ${row("Scam type", e(label(body.scam_type)))}
      ${row("Impersonating", e(body.meta.impersonated_org ?? "not given"))}
      ${row("Tactics", e(body.tactics.map(label).join(", ") || "none identified"))}
      ${row("Payee", e(payee.name ?? "not given"))}
      ${row("Sort code / account", e(`${payee.sort_code ?? "—"} / ${payee.account_number ?? "—"}`))}
      ${row("Amount requested", e(payee.amount_gbp != null ? formatPounds(payee.amount_gbp) : "not given"))}
      ${row("Risk score", e(body.meta.risk_score ?? "—"))}
      ${takeover.takeover !== null ? row("Takeover", e(takeover.takeover)) : ""}
      ${takeover.consent !== null ? row("Consent reference", `<code>${e(takeover.consent)}</code>`) : ""}
      ${row("Caller", e(`${body.meta.caller_masked ?? "withheld"} (${body.meta.direction})`))}
      ${row("Started", e(`${body.meta.started_at}${body.meta.duration_secs != null ? ` · ${body.meta.duration_secs}s` : ""}`))}
      ${row("Call", `<code>${e(body.meta.call_id ?? "—")}</code>`)}
      ${body.meta.conversation_id ? row("Conversation", `<code>${e(body.meta.conversation_id)}</code>`) : ""}
    </table>
    ${
      (body.protection_timeline ?? []).length
        ? `<h2 style="font-size:16px;margin:16px 0 8px">Protection timeline</h2>
    <table style="font-size:14px;border-collapse:collapse">${(body.protection_timeline ?? []).map((t) => row(t.time, e(t.event))).join("")}</table>`
        : ""
    }
    <h2 style="font-size:16px;margin:16px 0 8px">Timeline</h2>
    <table style="font-size:14px;border-collapse:collapse">${body.timeline
      .map((t) => row(t.time, e(t.event)))
      .join("")}</table>
    <h2 style="font-size:16px;margin:16px 0 8px">Evidence (verbatim)</h2>
    ${body.evidence_quotes.map((q) => `<blockquote style="margin:0 0 8px;padding:6px 12px;border-left:3px solid #cbd5e1;color:#334155">“${e(q)}”</blockquote>`).join("") || "<p>None captured.</p>"}
    <h2 style="font-size:16px;margin:16px 0 8px">Recommended actions</h2>
    <ol style="font-size:14px;line-height:1.5;padding-left:20px">
      <li><strong>Freeze / receiving account:</strong> ${e(body.recommended_actions.freeze_account)}</li>
      <li><strong>Contact affected payers:</strong> ${e(body.recommended_actions.contact_affected_payers)}</li>
      ${body.recommended_actions.other.map((o) => `<li>${e(o)}</li>`).join("")}
    </ol>
    <h2 style="font-size:16px;margin:16px 0 8px">Report Fraud–ready (copy into reportfraud.police.uk)</h2>
    <pre style="white-space:pre-wrap;font-size:13px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px">${e(
      body.recommended_actions.report_fraud_ready,
    )}</pre>
    <p style="font-size:12px;color:#64748b;margin-top:20px">Report ${e(opts.reportId)} · generated ${e(body.meta.generated_at)} by ${e(
      body.meta.model,
    )}. This report was not sent to the police or Report Fraud; an analyst must file it.${
      opts.dashboardUrl ? ` Dashboard: <a href="${e(opts.dashboardUrl)}">${e(opts.dashboardUrl)}</a>` : ""
    }</p>
  </div>
</div></body></html>`;

  const text = [
    `NORTHGATE BANK — FRAUD REPORT (${sentBy})`,
    body.title,
    "",
    body.summary,
    "",
    `Northgate account check: ${body.mule_findings.detail}`,
    `Scam type: ${label(body.scam_type)} | Tactics: ${body.tactics.map(label).join(", ") || "none"}`,
    `Payee: ${payee.name ?? "not given"} ${payee.sort_code ?? ""} ${payee.account_number ?? ""} | Amount: ${
      payee.amount_gbp != null ? formatPounds(payee.amount_gbp) : "not given"
    }`,
    ...(takeover.takeover !== null ? [`Takeover: ${takeover.takeover}`] : []),
    ...(takeover.consent !== null ? [`Consent reference: ${takeover.consent}`] : []),
    "",
    "Protection timeline:",
    ...(body.protection_timeline ?? []).map((t) => `  ${t.time}  ${t.event}`),
    "",
    "Timeline:",
    ...body.timeline.map((t) => `  ${t.time}  ${t.event}`),
    "",
    "Evidence:",
    ...body.evidence_quotes.map((q) => `  "${q}"`),
    "",
    `Freeze: ${body.recommended_actions.freeze_account}`,
    `Contact payers: ${body.recommended_actions.contact_affected_payers}`,
    ...body.recommended_actions.other.map((o) => `- ${o}`),
    "",
    "REPORT FRAUD–READY:",
    body.recommended_actions.report_fraud_ready,
  ].join("\n");

  return { subject, html, text };
}

export class ReportSendConflict extends Error {}

/**
 * Email a report to REPORT_TO_EMAIL (and nowhere else) through Resend, then mark it sent.
 * A short-lived claim plus Resend's idempotency key stop the same report being emailed twice
 * (e.g. auto-send racing an analyst's click, or a webhook retry).
 */
export async function sendReport(reportId: string, approvedBy?: string | null): Promise<ReportRow> {
  const env = serverEnv();
  const db = supabaseAdmin();

  const staleClaim = new Date(Date.now() - 2 * 60_000).toISOString();
  const claim = await db
    .from("reports")
    .update({ send_claimed_at: new Date().toISOString() })
    .eq("id", reportId)
    .eq("status", "draft")
    .or(`send_claimed_at.is.null,send_claimed_at.lt.${staleClaim}`)
    .select("*")
    .maybeSingle<ReportRow>();
  if (claim.error) throw new Error(`sendReport: ${claim.error.message}`);

  if (!claim.data) {
    const current = await db.from("reports").select("*").eq("id", reportId).maybeSingle<ReportRow>();
    if (current.error) throw new Error(`sendReport: ${current.error.message}`);
    if (!current.data) throw new Error(`sendReport: report ${reportId} not found`);
    if (current.data.status === "sent") return current.data; // already sent — idempotent
    throw new ReportSendConflict("This report is already being sent.");
  }

  const report = claim.data;
  try {
    const { subject, html, text } = renderReportEmail(report.body, {
      approvedBy,
      reportId: report.id,
      dashboardUrl: env.PUBLIC_BASE_URL,
    });
    const { data, error } = await resend().emails.send(
      {
        from: `Northgate Fraud Desk <${env.REPORT_FROM_EMAIL}>`,
        to: [env.REPORT_TO_EMAIL],
        subject,
        html,
        text,
        tags: [{ name: "kind", value: "fraud_report" }],
      },
      // Same report + same sender → same key, so a retried send never emails twice. The approver is part of the
      // key because the email body names them (Resend rejects a reused key with a different payload).
      { idempotencyKey: `northgate-report-${report.id}-${(approvedBy?.trim() || "auto").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}` },
    );
    if (error || !data) throw new Error(`Resend: ${error?.message ?? "no response"}`);

    const done = await db
      .from("reports")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        approved_by: approvedBy?.trim() || null,
        email_id: data.id,
        send_claimed_at: null,
      })
      .eq("id", report.id)
      .select("*")
      .single<ReportRow>();
    if (done.error) throw new Error(`sendReport: email ${data.id} sent but status update failed: ${done.error.message}`);
    return done.data;
  } catch (err) {
    await db.from("reports").update({ send_claimed_at: null }).eq("id", report.id).eq("status", "draft");
    throw err;
  }
}
