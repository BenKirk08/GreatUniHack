import { describe, expect, it } from "vitest";
import { escapeHtml, renderReportEmail } from "@/lib/email";
import { buildIntel, cleanToolFields } from "@/lib/intel";
import { verbatimScammerQuotes } from "@/lib/transcript";
import type { ReportBody, TranscriptTurn } from "@/lib/types";

const transcript: TranscriptTurn[] = [
  { role: "agent", message: "Hello? Margaret speaking...", time_in_call_secs: 0 },
  { role: "scammer", message: "This is the Northgate fraud team. Your account has been compromised, you must act now.", time_in_call_secs: 4 },
  { role: "agent", message: "Oh dear, hold on, writing that down.", time_in_call_secs: 9 },
  { role: "scammer", message: "Move it to the safe account: sort code 99-50-17, account 41873026, name Daniel Price.", time_in_call_secs: 15 },
];

describe("verbatimScammerQuotes", () => {
  it("keeps quotes the scammer actually said, ignoring case/punctuation", () => {
    const quotes = verbatimScammerQuotes(
      ['"your account has been compromised"', "Oh dear, hold on", "I am definitely a real bank", "You must act now!"],
      transcript,
    );
    expect(quotes).toEqual(["your account has been compromised", "You must act now!"]);
  });

  it("caps at the maximum", () => {
    const many = Array.from({ length: 8 }, () => "you must act now");
    expect(verbatimScammerQuotes(many, transcript)).toHaveLength(1); // deduped
  });
});

describe("cleanToolFields", () => {
  it("keeps known non-empty fields only", () => {
    expect(
      cleanToolFields({ payee_name: " Daniel Price ", sort_code: "", amount: 2500, nonsense: "x", account_number: null }),
    ).toEqual({ payee_name: "Daniel Price", amount: "2500" });
  });
});

describe("buildIntel", () => {
  const now = new Date("2026-11-05T12:00:00Z");

  it("validates Claude's output and normalises payment details", () => {
    const intel = buildIntel(
      {
        impersonated_org: "Northgate Bank fraud team",
        scam_type: "safe_account",
        tactics: ["urgency", "authority", "made_up_tactic", "urgency"],
        payee: { name: "Daniel Price", sort_code: "995017", account_number: "4187 3026" },
        amount_gbp: "2,500",
        callback_numbers: ["020 7946 0000"],
        key_quotes: ["you must act now", "not in transcript"],
        risk_score: 130,
        summary: "Caller posed as the bank. They asked for a transfer. Third sentence dropped.",
      },
      transcript,
      {},
      "test-model",
      now,
    );
    expect(intel.scam_type).toBe("safe_account");
    expect(intel.tactics).toEqual(["urgency", "authority"]);
    expect(intel.payee).toEqual({ name: "Daniel Price", sort_code: "99-50-17", account_number: "41873026" });
    expect(intel.amount_gbp).toBe(2500);
    expect(intel.key_quotes).toEqual(["you must act now"]);
    expect(intel.risk_score).toBe(100);
    expect(intel.summary).toBe("Caller posed as the bank. They asked for a transfer.");
    expect(intel.updated_at).toBe(now.toISOString());
  });

  it("fills gaps from Margaret's record_details fields", () => {
    const intel = buildIntel(
      {
        impersonated_org: null,
        scam_type: "not-a-type",
        tactics: [],
        payee: { name: null, sort_code: null, account_number: null },
        amount_gbp: null,
        callback_numbers: [],
        key_quotes: [],
        risk_score: 40,
        summary: "Early in the call.",
      },
      transcript,
      {
        claimed_organisation: "HMRC",
        payee_name: "Jordan Hale",
        sort_code: "99 50 42",
        account_number: "63019458",
        amount: "£3,000",
        callback_number: "+447700900999",
        caller_name: "Officer Smith",
      },
      "test-model",
      now,
    );
    expect(intel.scam_type).toBe("unknown");
    expect(intel.impersonated_org).toBe("HMRC");
    expect(intel.payee).toEqual({ name: "Jordan Hale", sort_code: "99-50-42", account_number: "63019458" });
    expect(intel.amount_gbp).toBe(3000);
    expect(intel.callback_numbers).toEqual(["+447700900999"]);
    expect(intel.caller_name).toBe("Officer Smith");
    expect(intel.agent_reported.payee_name).toBe("Jordan Hale");
  });
});

describe("report email", () => {
  it("escapes scammer-controlled text", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");

    const body: ReportBody = {
      title: "<b>Safe account</b> scam",
      summary: "Summary",
      timeline: [{ time: "00:04", event: "Claimed to be <i>the bank</i>" }],
      scam_type: "safe_account",
      tactics: ["urgency"],
      payee: { name: "Daniel Price", sort_code: "99-50-17", account_number: "41873026", amount_gbp: 2500 },
      protection_timeline: [{ time: "12:00:41", event: "Risk threshold crossed (score 82): <script>x</script>" }],
      mule_findings: { status: "match", detail: "Exact match." },
      evidence_quotes: ["<img src=x onerror=alert(1)>"],
      recommended_actions: {
        freeze_account: "Freeze",
        contact_affected_payers: "Contact",
        other: [],
        report_fraud_ready: "What happened: ...",
      },
      meta: {
        conversation_id: "conv_1",
        caller_masked: "•••123",
        direction: "inbound",
        started_at: "2026-11-05T12:00:00Z",
        ended_at: null,
        duration_secs: null,
        risk_score: 90,
        impersonated_org: "Northgate Bank",
        generated_at: "2026-11-05T12:05:00Z",
        model: "test",
      },
    };
    const { subject, html, text } = renderReportEmail(body, { reportId: "r1", approvedBy: "A. Analyst" });
    expect(subject).toContain("SUSPECTED MULE ACCOUNT");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>Safe account</b>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("Approved by A. Analyst");
    expect(text).toContain("REPORT FRAUD–READY");
    expect(html).toContain("Protection timeline");
    expect(html).not.toContain("<script>x</script>");
    expect(text).toContain("12:00:41  Risk threshold crossed (score 82)");
  });
});

describe("protection timeline", () => {
  it("lists threshold crossed, handover (who and when), persona and call end in time order", async () => {
    const { buildProtectionTimeline } = await import("@/lib/report");
    const timeline = buildProtectionTimeline({
      started_at: "2026-11-06T12:00:00.000Z",
      ended_at: "2026-11-06T12:05:00.000Z",
      risk: {
        score: 60, peak: 91, scam_type: "safe_account", tactics: [], reason: "They want your savings moved.", segments_scored: 9,
        scored_at: "2026-11-06T12:01:00.000Z", threshold_crossed_at: "2026-11-06T12:00:41.000Z", threshold_crossed_score: 82,
      },
      handoff_status: "connected",
      handoff_by: "analyst:Priya Shah",
      handoff_at: "2026-11-06T12:01:10.000Z",
      handoff_error: null,
      persona: "margaret",
    });
    expect(timeline.map((t) => t.event)).toEqual([
      "Call started; screening began",
      "Risk threshold crossed (score 82)",
      "Handed over to Northgate by analyst Priya Shah",
      "Persona: Margaret Ellis (nan)",
      "Call ended (peak risk 91)",
    ]);
    expect(timeline[1].time).toMatch(/^\d\d:\d\d:41$/);
  });

  it("says when there was no handover or it failed", async () => {
    const { buildProtectionTimeline } = await import("@/lib/report");
    const base = { started_at: "2026-11-06T12:00:00.000Z", ended_at: "2026-11-06T12:02:00.000Z", risk: null, handoff_by: "customer", handoff_at: null, persona: null };
    expect(buildProtectionTimeline({ ...base, handoff_status: "failed", handoff_error: "Call is not in-progress" }).map((t) => t.event)).toContain(
      "Handover by the customer failed: Call is not in-progress; the customer stayed on the line",
    );
    expect(buildProtectionTimeline({ ...base, handoff_status: "none", handoff_error: null }).map((t) => t.event)).toContain("Not handed over");
  });
});

describe("firstSentences", () => {
  it("keeps the first two sentences without splitting on decimals or codes", async () => {
    const { firstSentences } = await import("@/lib/intel");
    expect(firstSentences("Caller asked for £4.8k to 99.50.17 today. He gave a callback. Third.", 2)).toBe(
      "Caller asked for £4.8k to 99.50.17 today. He gave a callback.",
    );
    expect(firstSentences("One sentence only", 2)).toBe("One sentence only");
  });
});
