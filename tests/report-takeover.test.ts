import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderReportEmail } from "@/lib/email";
import { takeoverLabel, takeoverShortLabel, takeoverSummary, voiceTwinDetail } from "@/lib/persona-meta";
import { buildProtectionTimeline, buildTakeoverSummary, generateReport } from "@/lib/report";
import { transcriptToText } from "@/lib/transcript";
import type { CallRow, ReportBody } from "@/lib/types";

/* ---------- module fakes for generateReport (no Supabase, no Claude) ---------- */

const fake = vi.hoisted(() => ({
  call: null as unknown,
  saved: null as unknown,
  toolCall: null as { system: string; user: string } | null,
}));

vi.mock("@/lib/anthropic", () => ({
  claudeModel: () => "test-model",
  forcedToolCall: vi.fn(async (params: { system: string; user: string }) => {
    fake.toolCall = params;
    return {
      title: "Safe-account scam",
      summary: "The caller asked for savings to be moved.",
      timeline: [{ time: "00:10", event: "Asked for a transfer" }],
      mule_findings_detail: "",
      evidence_quotes: [],
      recommended_actions: { freeze_account: "Alert the receiving bank.", contact_affected_payers: "n/a", other: [], report_fraud_ready: "What happened: …" },
    };
  }),
}));

vi.mock("@/lib/supabase/admin", () => {
  /** Just enough of the query builder for generateReport: one call, no report yet, and an upsert that saves the body. */
  const builder = (table: string) => {
    let upserted: { call_id: string; status: string; body: unknown } | null = null;
    const chain = {
      select: () => chain,
      eq: () => chain,
      upsert: (row: { call_id: string; status: string; body: unknown }) => {
        upserted = row;
        return chain;
      },
      maybeSingle: async () => {
        if (table === "reports" && upserted) {
          fake.saved = upserted.body;
          return { data: { id: "report-1", ...upserted, sent_at: null, approved_by: null, email_id: null, send_claimed_at: null, created_at: "" }, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => ({ data: table === "calls" ? fake.call : null, error: null }),
    };
    return chain;
  };
  return { supabaseAdmin: () => ({ from: builder }) };
});

/* ---------- fixtures ---------- */

const CONSENT_AT = "2026-11-06T21:15:03.123456+00:00";

function makeCall(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    conversation_id: "conv_1",
    twilio_call_sid: "CAsim123",
    caller_masked: "•••481",
    direction: "inbound",
    status: "ended",
    started_at: "2026-11-06T21:20:00.000Z",
    ended_at: "2026-11-06T21:25:00.000Z",
    screening_transcript: [
      { speaker: "caller", text: "This is the Northgate fraud team, move your savings now.", at: "2026-11-06T21:20:10.000Z" },
      { speaker: "customer", text: "Oh, really?", at: "2026-11-06T21:20:15.000Z" },
    ],
    risk: {
      score: 88, peak: 91, scam_type: "safe_account", tactics: ["urgency"], reason: "Safe-account script.", segments_scored: 2,
      scored_at: "2026-11-06T21:20:40.000Z", threshold_crossed_at: "2026-11-06T21:20:41.000Z", threshold_crossed_score: 82,
    },
    handoff_status: "connected",
    handoff_by: "customer",
    handoff_at: "2026-11-06T21:21:00.000Z",
    handoff_requested_at: "2026-11-06T21:20:58.000Z",
    handoff_error: null,
    persona: null,
    offered_at: "2026-11-06T21:20:41.000Z",
    declined_score: null,
    transcript: [
      { role: "agent", message: "Sorry, I'm back — where were we?", time_in_call_secs: 0 },
      { role: "scammer", message: "The safe account is sort code 99-50-17.", time_in_call_secs: 5 },
    ],
    intel: null,
    intel_turns: 0,
    intel_claimed_at: null,
    mule_match: null,
    agent_notes: {},
    updated_at: "2026-11-06T21:25:00.000Z",
    takeover_kind: "voice_twin",
    voice_twin_speech_seconds: 42.34,
    voice_twin_consent_at: CONSENT_AT,
    voice_twin_voice_source: "clone",
    ...overrides,
  };
}

const twinCall = () => makeCall();
const personaCall = () =>
  makeCall({ takeover_kind: "persona", persona: "derek", voice_twin_speech_seconds: null, voice_twin_consent_at: null, voice_twin_voice_source: null });

function makeBody(overrides: Partial<ReportBody> = {}): ReportBody {
  return {
    title: "Safe-account scam",
    summary: "Summary",
    timeline: [],
    scam_type: "safe_account",
    tactics: [],
    payee: { name: null, sort_code: null, account_number: null, amount_gbp: null },
    mule_findings: { status: "not_checked", detail: "No check." },
    protection_timeline: [],
    evidence_quotes: [],
    recommended_actions: { freeze_account: "Freeze", contact_affected_payers: "Contact", other: [], report_fraud_ready: "What happened: …" },
    meta: {
      conversation_id: null,
      call_id: "c1",
      persona: null,
      caller_masked: "•••481",
      direction: "inbound",
      started_at: "2026-11-06T21:20:00Z",
      ended_at: null,
      duration_secs: null,
      risk_score: 91,
      impersonated_org: null,
      generated_at: "2026-11-06T21:26:00Z",
      model: "test",
    },
    ...overrides,
  };
}

/* ---------- labels ---------- */

describe("takeoverLabel / takeoverShortLabel", () => {
  it("names the persona, the AI Voice Twin, or nobody", () => {
    expect(takeoverLabel({ takeover_kind: "persona", persona: "derek" })).toBe("Derek Hollis");
    expect(takeoverLabel({ takeover_kind: null, persona: "priya" })).toBe("Priya Shah"); // rows from before the Voice Twin
    expect(takeoverLabel({ takeover_kind: "voice_twin", persona: null })).toBe("AI Voice Twin (consented)");
    expect(takeoverLabel({ takeover_kind: null, persona: null })).toBe("");
    expect(takeoverShortLabel({ takeover_kind: "persona", persona: "keith" })).toBe("Keith");
    expect(takeoverShortLabel({ takeover_kind: "voice_twin", persona: null })).toBe("AI Voice Twin");
    expect(takeoverShortLabel({ persona: null })).toBe("");
  });

  it("formats the twin's speech seconds and consent time, and nothing for a persona", () => {
    expect(voiceTwinDetail(twinCall())).toMatch(/^42 s of the customer's speech · consent \d\d Nov \d\d:\d\d:\d\d$/);
    expect(voiceTwinDetail(makeCall({ voice_twin_voice_source: "fallback" }))).toContain("· fallback voice ·");
    expect(voiceTwinDetail(personaCall())).toBe("");
  });
});

/* ---------- buildTakeoverSummary ---------- */

describe("buildTakeoverSummary", () => {
  it("is 'none' when the call wasn't handed over", () => {
    for (const handoff_status of ["none", "offered", "declined"] as const) {
      expect(buildTakeoverSummary(makeCall({ handoff_status, takeover_kind: null, voice_twin_consent_at: null }))).toEqual({
        type: "none",
        label: "Not handed over",
        speech_seconds: null,
        consent_at: null,
      });
    }
  });

  it("names a persona with their relation", () => {
    expect(buildTakeoverSummary(personaCall())).toEqual({ type: "persona", label: "Derek Hollis (dad)", speech_seconds: null, consent_at: null });
  });

  it("records the AI Voice Twin's speech seconds and the consent reference verbatim", () => {
    expect(buildTakeoverSummary(twinCall())).toEqual({
      type: "voice_twin",
      label: "AI Voice Twin (consented)",
      speech_seconds: 42.3,
      consent_at: CONSENT_AT,
    });
  });

  it("keeps the type a failed handover tried", () => {
    expect(buildTakeoverSummary(makeCall({ handoff_status: "failed", handoff_at: null, handoff_error: "register-call timed out" }))).toEqual({
      type: "voice_twin",
      label: "AI Voice Twin (consented) — handover failed",
      speech_seconds: 42.3,
      consent_at: CONSENT_AT,
    });
    expect(buildTakeoverSummary({ ...personaCall(), handoff_status: "failed", persona: null })).toMatchObject({
      type: "persona",
      label: "Northgate persona — handover failed",
    });
  });

  it("counts a 'requested' twin takeover as handed over when there is evidence it happened, keeping the consent reference", () => {
    const expected = { type: "voice_twin", label: "AI Voice Twin (consented)", speech_seconds: 42.3, consent_at: CONSENT_AT };
    // markConnected's writes failed after the redirect: conversation_id and the twin's lines are the evidence.
    expect(buildTakeoverSummary(makeCall({ handoff_status: "requested", handoff_at: null }))).toEqual(expected);
    // Either one is enough.
    expect(buildTakeoverSummary(makeCall({ handoff_status: "requested", handoff_at: null, conversation_id: null }))).toEqual(expected);
    expect(buildTakeoverSummary(makeCall({ handoff_status: "requested", handoff_at: null, transcript: [] }))).toEqual(expected);
  });

  it("counts a 'requested' persona takeover with evidence as that persona, or 'Northgate persona' if none is recorded", () => {
    const requested = { ...personaCall(), handoff_status: "requested" as const, handoff_at: null };
    expect(buildTakeoverSummary(requested)).toEqual({ type: "persona", label: "Derek Hollis (dad)", speech_seconds: null, consent_at: null });
    expect(buildTakeoverSummary({ ...requested, conversation_id: null })).toMatchObject({ type: "persona", label: "Derek Hollis (dad)" });
    expect(buildTakeoverSummary({ ...requested, persona: null, transcript: [] })).toEqual({
      type: "persona",
      label: "Northgate persona",
      speech_seconds: null,
      consent_at: null,
    });
  });

  it("still says 'Not handed over' for a 'requested' claim with no evidence the takeover happened", () => {
    const none = { type: "none", label: "Not handed over", speech_seconds: null, consent_at: null };
    const callerOnly = [{ role: "scammer" as const, message: "Hello?", time_in_call_secs: 1 }];
    expect(buildTakeoverSummary(makeCall({ handoff_status: "requested", handoff_at: null, conversation_id: null, transcript: [] }))).toEqual(none);
    expect(buildTakeoverSummary(makeCall({ handoff_status: "requested", handoff_at: null, conversation_id: "  ", transcript: callerOnly }))).toEqual(none);
    expect(buildTakeoverSummary({ ...personaCall(), handoff_status: "requested", conversation_id: null, transcript: [] })).toEqual(none);
    // Callers with only the status columns get no evidence.
    expect(takeoverSummary({ handoff_status: "requested", persona: "derek", takeover_kind: "persona" })).toEqual(none);
    // Other statuses ignore the evidence (the base fixture has a conversation_id and agent turns).
    expect(buildTakeoverSummary(makeCall({ handoff_status: "offered" }))).toEqual(none);
  });

  it("treats rows from before the Voice Twin (persona set, no takeover_kind) as persona takeovers", () => {
    const legacy = makeCall({ persona: "margaret", takeover_kind: null, voice_twin_speech_seconds: null, voice_twin_consent_at: null });
    expect(buildTakeoverSummary(legacy)).toEqual({ type: "persona", label: "Margaret Ellis (nan)", speech_seconds: null, consent_at: null });
    // No Voice Twin columns at all (an old row read before 0009).
    const { takeover_kind, voice_twin_speech_seconds, voice_twin_consent_at, voice_twin_voice_source, ...old } = legacy;
    void [takeover_kind, voice_twin_speech_seconds, voice_twin_consent_at, voice_twin_voice_source];
    expect(takeoverSummary(old)).toEqual(buildTakeoverSummary(legacy));
  });
});

/* ---------- protection timeline ---------- */

describe("buildProtectionTimeline with the AI Voice Twin", () => {
  it("adds the twin's takeover event (speech seconds and consent) after the handover, in order", () => {
    expect(buildProtectionTimeline(twinCall()).map((t) => t.event)).toEqual([
      "Call started; screening began",
      "Risk threshold crossed (score 82)",
      "Handed over to Northgate by the customer",
      `Takeover: AI Voice Twin (consented), built from 42 s of the customer's speech; consent given ${CONSENT_AT}`,
      "Call ended (peak risk 91)",
    ]);
  });

  it("never names a persona on a twin call, and says when the fallback voice spoke", () => {
    const events = buildProtectionTimeline(makeCall({ persona: "margaret", voice_twin_voice_source: "fallback" })).map((t) => t.event);
    expect(events.some((e) => e.startsWith("Persona:"))).toBe(false);
    expect(events).toContain(
      `Takeover: AI Voice Twin (consented), using the fallback voice because cloning failed (42 s of the customer's speech collected); consent given ${CONSENT_AT}`,
    );
  });

  it("says when the handover to the twin failed", () => {
    const events = buildProtectionTimeline(makeCall({ handoff_status: "failed", handoff_at: null, handoff_error: "voice no longer exists" })).map(
      (t) => t.event,
    );
    expect(events).toContain("Handover to the AI Voice Twin by the customer failed: voice no longer exists; the customer stayed on the line");
    expect(events.some((e) => e.startsWith("Takeover:"))).toBe(false);
  });

  it("is unchanged for persona takeovers", () => {
    const events = buildProtectionTimeline({ ...personaCall(), handoff_by: "analyst:Sam" }).map((t) => t.event);
    expect(events).toContain("Handed over to Northgate by analyst Sam");
    expect(events).toContain("Persona: Derek Hollis (dad)");
    expect(events.some((e) => e.startsWith("Takeover:"))).toBe(false);
  });

  it("shows a 'requested' twin takeover with evidence as handed over, at the time it was requested", () => {
    const timeline = buildProtectionTimeline(makeCall({ handoff_status: "requested", handoff_at: null, conversation_id: null }));
    expect(timeline.map((t) => t.event)).toEqual([
      "Call started; screening began",
      "Risk threshold crossed (score 82)",
      "Handed over to Northgate by the customer",
      `Takeover: AI Voice Twin (consented), built from 42 s of the customer's speech; consent given ${CONSENT_AT}`,
      "Call ended (peak risk 91)",
    ]);
    expect(timeline[2].time).toMatch(/^\d\d:20:58$/); // handoff_requested_at, as handoff_at was never written
  });

  it("shows a 'requested' persona takeover with evidence as that persona, and one without evidence as not handed over", () => {
    const requested = { ...personaCall(), handoff_status: "requested" as const, handoff_at: null, transcript: [] };
    const events = buildProtectionTimeline(requested).map((t) => t.event);
    expect(events).toContain("Handed over to Northgate by the customer");
    expect(events).toContain("Persona: Derek Hollis (dad)");
    expect(events).not.toContain("Not handed over");

    const noEvidence = buildProtectionTimeline({ ...requested, conversation_id: null }).map((t) => t.event);
    expect(noEvidence).toContain("Not handed over");
    expect(noEvidence.some((e) => e.startsWith("Handed over") || e.startsWith("Persona:"))).toBe(false);
  });
});

/* ---------- report email ---------- */

describe("renderReportEmail takeover rows", () => {
  const twinTakeover = { type: "voice_twin" as const, label: "AI Voice Twin (consented)", speech_seconds: 42.3, consent_at: CONSENT_AT };

  it("shows the twin's takeover with its speech seconds and a consent reference, in HTML and text", () => {
    const { html, text } = renderReportEmail(makeBody({ takeover: twinTakeover }), { reportId: "r1" });
    expect(html).toContain(">Takeover<");
    expect(html).toContain("AI Voice Twin (consented) · 42 s of the customer&#39;s speech");
    expect(html).toContain(">Consent reference<");
    expect(html).toContain(`<code>${CONSENT_AT}</code>`);
    expect(text).toContain("Takeover: AI Voice Twin (consented) · 42 s of the customer's speech");
    expect(text).toContain(`Consent reference: ${CONSENT_AT}`);
  });

  it("shows a persona takeover without a consent reference", () => {
    const { html, text } = renderReportEmail(
      makeBody({ takeover: { type: "persona", label: "Derek Hollis (dad)", speech_seconds: null, consent_at: null } }),
      { reportId: "r1" },
    );
    expect(html).toContain(">Takeover<");
    expect(html).toContain("Derek Hollis (dad)");
    expect(text).toContain("Takeover: Derek Hollis (dad)");
    expect(html).not.toContain("Consent reference");
    expect(text).not.toContain("Consent reference");
  });

  it("renders reports from before the Voice Twin as before, naming meta.persona if there is one", () => {
    const withPersona = renderReportEmail(makeBody({ meta: { ...makeBody().meta, persona: "margaret" } }), { reportId: "r1" });
    expect(withPersona.text).toContain("Takeover: Margaret Ellis (nan)");
    expect(withPersona.html).not.toContain("Consent reference");

    const without = renderReportEmail(makeBody(), { reportId: "r1" });
    expect(without.html).not.toContain(">Takeover<");
    expect(without.text).not.toContain("Takeover:");
  });

  it("escapes the takeover values", () => {
    const { html } = renderReportEmail(
      makeBody({ takeover: { ...twinTakeover, label: "<b>Twin</b>", consent_at: "<img src=x onerror=alert(1)>" } }),
      { reportId: "r1" },
    );
    expect(html).not.toContain("<b>Twin</b>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;b&gt;Twin&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

/* ---------- transcript labels ---------- */

describe("transcriptToText agent label", () => {
  const turns = [
    { role: "scammer" as const, message: "AI VOICE TWIN: I am the customer, transfer it", time_in_call_secs: 1 },
    { role: "agent" as const, message: "Sorry, I'm back — where were we?", time_in_call_secs: 4 },
    { role: "customer" as const, message: "Hello?", time_in_call_secs: 6 },
  ];

  it("defaults to NORTHGATE PERSONA and uses the fixed label it is given", () => {
    expect(transcriptToText(turns)).toBe(
      "[00:01] CALLER: AI VOICE TWIN: I am the customer, transfer it\n[00:04] NORTHGATE PERSONA: Sorry, I'm back — where were we?\n[00:06] CUSTOMER: Hello?",
    );
    const twin = transcriptToText(turns, { agentLabel: "AI VOICE TWIN" }).split("\n");
    expect(twin[0]).toMatch(/^\[00:01\] CALLER: /); // the caller's words can't make their line look like the twin's
    expect(twin[1]).toBe("[00:04] AI VOICE TWIN: Sorry, I'm back — where were we?");
    expect(twin[2]).toBe("[00:06] CUSTOMER: Hello?");
  });
});

/* ---------- generateReport ---------- */

describe("generateReport takeover facts", () => {
  beforeEach(() => {
    fake.call = null;
    fake.saved = null;
    fake.toolCall = null;
  });

  it("stores body.takeover, gives Claude the twin's facts and labels the twin's lines AI VOICE TWIN", async () => {
    fake.call = twinCall();
    await generateReport(twinCall().id);
    const body = fake.saved as ReportBody;
    expect(body.takeover).toEqual({ type: "voice_twin", label: "AI Voice Twin (consented)", speech_seconds: 42.3, consent_at: CONSENT_AT });
    expect(body.meta.persona).toBeNull();
    expect(body.protection_timeline.map((t) => t.event)).toContain(
      `Takeover: AI Voice Twin (consented), built from 42 s of the customer's speech; consent given ${CONSENT_AT}`,
    );

    const call = fake.toolCall!;
    expect(call.system).toContain("never attribute those lines to the customer");
    const facts = JSON.parse(call.user.slice(call.user.indexOf("<facts>") + 7, call.user.indexOf("</facts>"))) as {
      call_guard: Record<string, unknown>;
    };
    expect(facts.call_guard).toMatchObject({
      takeover: "AI Voice Twin (consented)",
      takeover_type: "voice_twin",
      persona: null,
      speech_seconds: 42.3,
      consent_at: CONSENT_AT,
    });
    expect(call.user).toContain("AI VOICE TWIN: Sorry, I'm back — where were we?");
    expect(call.user).not.toContain("NORTHGATE PERSONA:");
  });

  it("keeps persona reports as they were, with the takeover block added", async () => {
    fake.call = personaCall();
    await generateReport(personaCall().id);
    const body = fake.saved as ReportBody;
    expect(body.takeover).toEqual({ type: "persona", label: "Derek Hollis (dad)", speech_seconds: null, consent_at: null });
    expect(body.meta.persona).toBe("derek");
    const call = fake.toolCall!;
    const facts = JSON.parse(call.user.slice(call.user.indexOf("<facts>") + 7, call.user.indexOf("</facts>"))) as {
      call_guard: Record<string, unknown>;
    };
    expect(facts.call_guard).toMatchObject({ takeover: "Derek Hollis (dad)", takeover_type: "persona", persona: "Derek Hollis" });
    expect(facts.call_guard).not.toHaveProperty("consent_at");
    expect(call.user).toContain("NORTHGATE PERSONA: Sorry, I'm back");
  });

  it("reports a 'requested' twin takeover with evidence as the twin: consent reference, handed over, AI VOICE TWIN lines", async () => {
    fake.call = makeCall({ handoff_status: "requested", handoff_at: null, conversation_id: null });
    await generateReport(twinCall().id);
    const body = fake.saved as ReportBody;
    expect(body.takeover).toEqual({ type: "voice_twin", label: "AI Voice Twin (consented)", speech_seconds: 42.3, consent_at: CONSENT_AT });
    expect(body.meta.persona).toBeNull();
    expect(body.protection_timeline.map((t) => t.event)).not.toContain("Not handed over");

    const call = fake.toolCall!;
    const facts = JSON.parse(call.user.slice(call.user.indexOf("<facts>") + 7, call.user.indexOf("</facts>"))) as {
      call_guard: Record<string, unknown>;
    };
    expect(facts.call_guard).toMatchObject({
      handed_over: true,
      handover_by: "the customer",
      takeover: "AI Voice Twin (consented)",
      takeover_type: "voice_twin",
      persona: null,
      consent_at: CONSENT_AT,
    });
    expect(call.user).toContain("AI VOICE TWIN: Sorry, I'm back — where were we?");
    expect(call.user).not.toContain("NORTHGATE PERSONA:");
  });

  it("labels the twin's lines AI VOICE TWIN whenever takeover_kind is voice_twin, whatever handoff_status says", async () => {
    for (const handoff_status of ["failed", "requested", "connected", "none"] as const) {
      fake.call = makeCall({ handoff_status, handoff_at: null, conversation_id: null, voice_twin_consent_at: null });
      await generateReport(twinCall().id);
      expect(fake.toolCall!.user).toContain("AI VOICE TWIN: Sorry, I'm back — where were we?");
      expect(fake.toolCall!.user).not.toContain("NORTHGATE PERSONA:");
    }
  });

  it("reports a 'requested' persona takeover with evidence as that persona, with NORTHGATE PERSONA lines", async () => {
    fake.call = { ...personaCall(), handoff_status: "requested", handoff_at: null };
    await generateReport(personaCall().id);
    const body = fake.saved as ReportBody;
    expect(body.takeover).toEqual({ type: "persona", label: "Derek Hollis (dad)", speech_seconds: null, consent_at: null });
    expect(body.meta.persona).toBe("derek");
    const call = fake.toolCall!;
    const facts = JSON.parse(call.user.slice(call.user.indexOf("<facts>") + 7, call.user.indexOf("</facts>"))) as {
      call_guard: Record<string, unknown>;
    };
    expect(facts.call_guard).toMatchObject({ handed_over: true, takeover: "Derek Hollis (dad)", takeover_type: "persona", persona: "Derek Hollis" });
    expect(call.user).toContain("NORTHGATE PERSONA: Sorry, I'm back");
    expect(call.user).not.toContain("AI VOICE TWIN:");
  });

  it("doesn't call a 'requested' claim with no evidence handed over", async () => {
    fake.call = makeCall({ handoff_status: "requested", handoff_at: null, conversation_id: null, transcript: [] });
    await generateReport(twinCall().id);
    const body = fake.saved as ReportBody;
    expect(body.takeover).toMatchObject({ type: "none", label: "Not handed over" });
    const call = fake.toolCall!;
    const facts = JSON.parse(call.user.slice(call.user.indexOf("<facts>") + 7, call.user.indexOf("</facts>"))) as {
      call_guard: Record<string, unknown>;
    };
    expect(facts.call_guard).toMatchObject({ handed_over: false, handover_by: null, takeover_type: "none" });
  });
});

/* ---------- dashboard change signals ---------- */

describe("isDashboardSignal", () => {
  it("re-reads only the tables the dashboard shows, ignoring voice_twins signals", async () => {
    const { isDashboardSignal } = await import("@/components/dashboard/dashboard");
    for (const table of ["calls", "reports", "bank_accounts", "settings"] as const) expect(isDashboardSignal({ table })).toBe(true);
    expect(isDashboardSignal({ table: "voice_twins" })).toBe(false);
  });
});
