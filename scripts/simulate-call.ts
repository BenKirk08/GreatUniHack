/**
 * Replay a Call Guard call against the local or deployed API: no phone, no Twilio call, no ElevenLabs call.
 *
 *   npx tsx scripts/simulate-call.ts <scenario> [options]
 *   npx tsx scripts/simulate-call.ts --list
 *
 * What it does (every Twilio request is signed with TWILIO_AUTH_TOKEN, as Twilio would):
 *   1. A fake CallSid (CAsim + 30 hex characters). POSTs the voice webhook to /api/twilio/voice and checks the
 *      screening TwiML comes back within 1 second.
 *   2. POSTs the scenario's screening lines as Real-Time Transcription events (transcription-content, Final=true,
 *      inbound_track = caller, outbound_track = customer) to /api/twilio/transcription.
 *   3. Waits for handoff_status 'offered' and checks what the scam alert shows: opens /protect?k=CUSTOMER_LINK_TOKEN
 *      for the customer cookie and reads /api/protect/state, whose call carries the alert's quotes (at most two, each
 *      verbatim from one of the caller's lines). With --hold-offer N it keeps the alert open N seconds (to look at it
 *      on /protect), then taps as the customer: POSTs /api/protect/takeover with { callId, choice } (or, with
 *      --takeover analyst, the dashboard's "Take over now"). Simulated calls skip register-call and the Twilio
 *      redirect, but the AI voice is still matched (setting, else Claude's inference from the call, else default).
 *      With --choice voice_twin the customer picks their AI Voice Twin: that needs a consented, ready twin (made
 *      beforehand in Settings; this script never creates one). If the API answers 409 twin_unavailable the run says
 *      so and retries once with "Use AI voice", unless --expect-twin is passed (then the run fails there). Once
 *      connected it checks takeover_kind ('voice_twin' with persona null, or 'persona' with an AI voice and its
 *      ai_voice_match: which voice and why), and the expected voice and source if the scenario or flags give them.
 *   4. Replays the persona's (or twin's) side: record_details tool calls carrying northgate_call_id, then a signed
 *      post-call webhook whose conversation_initiation_client_data.dynamic_variables carries northgate_call_id.
 *   5. Sends the signed 'completed' status callback (ignored for taken-over calls: the webhook finishes them).
 *   6. Waits for the report, approves it in approve mode, confirms the email through Resend (GET /emails/:id →
 *      delivered) and checks the scenario's expectations.
 * A benign scenario must never be offered: the run sends its lines, waits for scoring to settle, checks there was
 * no offer, ends the call with the status callback and checks no report is written.
 *
 * Options:
 *   --base-url <url>         API to hit (default PUBLIC_BASE_URL, else http://localhost:3000)
 *   --mode auto|approve      set the auto-send mode for this run (restored afterwards); default: leave as is
 *   --approver <name>        analyst name for approve mode / analyst takeovers (default "Simulation Analyst")
 *   --takeover customer|analyst   who taps the handover (default customer)
 *   --choice ai_voice|voice_twin
 *                            what the customer taps: "Use AI voice" (default) or "Use my Voice Twin" (ignored for
 *                            --takeover analyst, which always uses the AI voice)
 *   --expect-twin            with --choice voice_twin: fail if the AI Voice Twin is unavailable instead of falling
 *                            back to auto
 *   --until offered          stop once the call is offered (the call is then closed without a report)
 *   --hold-offer <secs>      keep the alert open this long before tapping (default 0)
 *   --expect-voice <voice>   fail unless this AI voice takes the call (e.g. older_female; overrides the scenario)
 *   --expect-source <src>    fail unless the voice was chosen this way: setting, inferred or default
 *   --pace <ms>              delay between screening lines (default 1500) and persona turns (default 800)
 *   --no-email-check         skip the Resend delivery check
 *   --timeout <secs>         how long to wait for each stage (default 150)
 */
import "./lib/load-env";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { signElevenLabsPayload } from "../lib/elevenlabs/webhook";
import { requireEnv, serverEnv } from "../lib/env";
import { maskCaller } from "../lib/normalise";
import { supabaseAdmin } from "../lib/supabase/admin";
import { computeTwilioSignature } from "../lib/twilio";
import { isAiVoiceId, type AiVoiceId } from "../lib/ai-voices/config";
import { selectScammerQuotes } from "../lib/alert-quotes";
import { personaCharacterLine } from "../lib/persona-meta";
import { VOICE_MATCH_SOURCES, type CallRow, type ReportRow, type TakeoverChoice, type VoiceMatchSource } from "../lib/types";
import { aiVoiceMatchDetail, aiVoiceSummary } from "../lib/voice-match";
import { VOICE_TWIN_LABEL, VOICE_TWIN_REPORT_LABEL } from "../lib/voice-twin/config";

interface ScreeningLine {
  speaker: "caller" | "customer";
  text: string;
}
interface TakeoverTurn {
  role: "caller" | "persona";
  message: string;
  record_details?: Record<string, string>;
}
interface Scenario {
  id: string;
  title: string;
  summary: string;
  benign?: boolean;
  uses_mule: boolean;
  expect?: {
    /** The AI voice that should take the call, and why (only where the call or setting makes it predictable). */
    ai_voice?: AiVoiceId;
    ai_voice_source?: VoiceMatchSource;
    scam_type?: string;
    mule?: "match" | "name_only" | "no_match" | null;
    sort_code?: string;
    account_number?: string;
  };
  caller_number: string;
  screening: ScreeningLine[];
  takeover: TakeoverTurn[];
}

const SCENARIO_DIR = path.join(process.cwd(), "demo", "scenarios");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function listScenarios(): Scenario[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(SCENARIO_DIR, f), "utf8")) as Scenario);
}
function loadScenario(name: string): Scenario {
  const file = name.endsWith(".json") ? path.resolve(name) : path.join(SCENARIO_DIR, `${name}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as Scenario;
}

async function timedFetch(url: string, init: RequestInit): Promise<{ res: Response; ms: number; body: unknown; text: string }> {
  const started = performance.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(40_000) });
  const ms = Math.round(performance.now() - started);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { res, ms, body, text };
}

async function waitFor<T>(what: string, timeoutSecs: number, fn: () => Promise<T | null | undefined>, everyMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutSecs * 1000;
  let dots = 0;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) {
      if (dots) process.stdout.write("\n");
      return v;
    }
    process.stdout.write(dots++ === 0 ? `  waiting for ${what} .` : ".");
    await sleep(everyMs);
  }
  process.stdout.write("\n");
  throw new Error(`Timed out after ${timeoutSecs}s waiting for ${what}`);
}

async function main() {
  if (flag("list") || process.argv.length <= 2) {
    console.log("Scenarios:");
    for (const s of listScenarios()) console.log(`  ${s.id.padEnd(22)} ${s.title}${s.uses_mule ? "  [mule]" : ""}${s.benign ? "  [benign]" : ""}`);
    console.log(
      "\nUsage: npx tsx scripts/simulate-call.ts <scenario> [--base-url URL] [--mode auto|approve] [--takeover customer|analyst] " +
        "[--choice ai_voice|voice_twin] [--expect-twin] [--hold-offer SECS] [--expect-voice VOICE] [--expect-source setting|inferred|default]",
    );
    return;
  }

  const scenario = loadScenario(process.argv[2]);
  const env = serverEnv();
  const baseUrl = (arg("base-url") ?? env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const publicBase = requireEnv("PUBLIC_BASE_URL").replace(/\/$/, ""); // what Twilio signs against
  const mode = arg("mode") as "auto" | "approve" | undefined;
  if (mode && mode !== "auto" && mode !== "approve") throw new Error("--mode must be auto or approve");
  const takeoverBy = (arg("takeover") ?? "customer") as "customer" | "analyst";
  if (takeoverBy !== "customer" && takeoverBy !== "analyst") throw new Error("--takeover must be customer or analyst");
  const rawChoice = arg("choice") ?? "ai_voice";
  if (!["ai_voice", "voice_twin", "auto"].includes(rawChoice)) throw new Error("--choice must be ai_voice or voice_twin");
  const requestedChoice: TakeoverChoice = rawChoice === "voice_twin" ? "voice_twin" : "ai_voice";
  const expectTwin = flag("expect-twin");
  if (expectTwin && requestedChoice !== "voice_twin") throw new Error("--expect-twin needs --choice voice_twin");
  if (takeoverBy === "analyst" && requestedChoice !== "ai_voice") console.log(`  (--choice ${requestedChoice} is ignored for --takeover analyst)`);
  const holdOfferSecs = Math.max(0, Number(arg("hold-offer") ?? 0) || 0);
  const expectVoice = arg("expect-voice") ?? scenario.expect?.ai_voice;
  if (expectVoice !== undefined && !isAiVoiceId(expectVoice)) throw new Error("--expect-voice must be an AI voice, e.g. older_female");
  const expectSource = (arg("expect-source") ?? scenario.expect?.ai_voice_source) as VoiceMatchSource | undefined;
  if (expectSource !== undefined && !(VOICE_MATCH_SOURCES as readonly string[]).includes(expectSource)) {
    throw new Error("--expect-source must be setting, inferred or default");
  }
  const approver = arg("approver") ?? "Simulation Analyst";
  const untilOffered = arg("until") === "offered";
  const screeningPace = Number(arg("pace") ?? 1500);
  const personaPace = Math.min(800, screeningPace);
  const timeoutSecs = Number(arg("timeout") ?? 150);
  const webhookSecret = requireEnv("ELEVENLABS_WEBHOOK_SECRET");
  const basicAuth = `Basic ${Buffer.from(`simulator:${env.DASHBOARD_PASSWORD}`).toString("base64")}`;
  const db = supabaseAdmin();

  const callSid = `CAsim${randomBytes(15).toString("hex")}`;
  const conversationId = `conv_sim_${scenario.id.replace(/[^a-z0-9]/gi, "")}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const callerNumber = scenario.caller_number;
  const failures: string[] = [];

  /** POST a form to a Twilio-facing route, signed like Twilio signs it. */
  const twilioPost = (pathname: string, params: Record<string, string>) => {
    const form = new URLSearchParams(params);
    const signature = computeTwilioSignature(env.TWILIO_AUTH_TOKEN, `${publicBase}${pathname}`, form);
    return timedFetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: form.toString(),
    });
  };
  const loadCall = async () => (await db.from("calls").select("*").eq("twilio_call_sid", callSid).maybeSingle<CallRow>()).data;

  console.log(`\n▶ ${scenario.title}`);
  console.log(`  ${scenario.summary}`);
  console.log(`  API ${baseUrl} · CallSid ${callSid} · caller ${maskCaller(callerNumber)}${scenario.benign ? " · BENIGN" : ""}`);

  let previousAutoSend: boolean | undefined;
  if (mode) {
    const current = await db.from("settings").select("auto_send").eq("id", 1).single();
    previousAutoSend = current.data?.auto_send;
    const r = await timedFetch(`${baseUrl}/api/settings/auto-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicAuth },
      body: JSON.stringify({ autoSend: mode === "auto" }),
    });
    if (!r.res.ok) throw new Error(`Could not set auto-send: ${r.res.status} ${r.text}`);
    console.log(`  auto-send set to ${mode === "auto"} for this run`);
  }

  try {
    /* 1. The incoming call. */
    const base = { AccountSid: env.TWILIO_ACCOUNT_SID, ApiVersion: "2010-04-01", CallSid: callSid };
    const unsigned = await timedFetch(`${baseUrl}/api/twilio/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...base, From: callerNumber, To: env.TWILIO_PHONE_NUMBER }).toString(),
    });
    if (unsigned.res.status !== 403) failures.push(`unsigned voice webhook returned ${unsigned.res.status}, expected 403`);

    const voice = await twilioPost("/api/twilio/voice", {
      ...base,
      CallStatus: "ringing",
      Direction: "inbound",
      From: callerNumber,
      Caller: callerNumber,
      To: env.TWILIO_PHONE_NUMBER,
      Called: env.TWILIO_PHONE_NUMBER,
      FromCountry: "GB",
      ToCountry: "US",
    });
    console.log(`  ☎ voice webhook → ${voice.res.status} in ${voice.ms}ms`);
    if (voice.res.status !== 200) failures.push(`voice webhook returned ${voice.res.status}: ${voice.text.slice(0, 200)}`);
    if (voice.ms > 1000) failures.push(`voice webhook took ${voice.ms}ms (must be < 1000ms)`);
    const transcription = '<Transcription name="screen" track="both_tracks" inboundTrackLabel="caller" outboundTrackLabel="customer" languageCode="en-GB"';
    if (!voice.text.includes(transcription)) failures.push(`TwiML is missing ${transcription.slice(0, 60)}…`);
    // The customer's number, bare or as <Number statusCallback…> (the AI Voice Twin's media stream starts on answer).
    const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dial = new RegExp(
      `<Dial callerId="${escapeRe(callerNumber)}" answerOnBridge="true" timeout="25">(?:<Number [^>]*>)?${escapeRe(env.CUSTOMER_PHONE_NUMBER)}` +
        `(?:</Number>)?</Dial><Hangup/>`,
    );
    if (!dial.test(voice.text)) failures.push(`TwiML is missing <Dial callerId="${callerNumber}" … ${env.CUSTOMER_PHONE_NUMBER} … </Dial><Hangup/>`);
    const created = await waitFor("the call row", 20, loadCall, 500);
    console.log(`  call ${created.id} live · caller ${created.caller_masked} · handoff ${created.handoff_status}`);

    /* 2. Screening: the caller and Ben, transcribed. */
    let seq = 1;
    await twilioPost("/api/twilio/transcription", {
      ...base,
      TranscriptionSid: `GTsim${randomBytes(15).toString("hex")}`,
      TranscriptionEvent: "transcription-started",
      Name: "screen",
      Track: "both_tracks",
      InboundTrackLabel: "caller",
      OutboundTrackLabel: "customer",
      SequenceId: String(seq++),
      Timestamp: new Date().toISOString(),
      LanguageCode: "en-GB",
    });
    for (const line of scenario.screening) {
      const r = await twilioPost("/api/twilio/transcription", {
        ...base,
        TranscriptionSid: `GTsim${callSid.slice(5, 35)}`,
        TranscriptionEvent: "transcription-content",
        LanguageCode: "en-GB",
        Track: line.speaker === "caller" ? "inbound_track" : "outbound_track",
        TranscriptionData: JSON.stringify({ transcript: line.text, confidence: 0.93 }),
        Final: "true",
        SequenceId: String(seq++),
        Timestamp: new Date().toISOString(),
      });
      const live = await loadCall();
      console.log(
        `  ${line.speaker === "caller" ? "Caller  " : "Customer"}: ${line.text}   [${r.res.status} ${r.ms}ms · risk ${live?.risk?.score ?? "—"}/${live?.risk?.peak ?? "—"} · ${live?.handoff_status}]`,
      );
      if (r.res.status !== 204 && r.res.status !== 200) failures.push(`transcription event returned ${r.res.status}`);
      if (r.ms > 2000) failures.push(`transcription event took ${r.ms}ms`);
      await sleep(screeningPace);
    }

    const threshold = env.RISK_THRESHOLD;
    if (scenario.benign) {
      // Let every scoring (including the 10-second rule's trailing check) settle, then make sure nothing was offered.
      await sleep(14_000);
      const settled = (await loadCall())!;
      console.log(`  🔎 risk peak ${settled.risk?.peak ?? 0} (threshold ${threshold}) · ${settled.risk?.reason ?? "no score"} · handoff ${settled.handoff_status}`);
      if (settled.handoff_status !== "none") failures.push(`benign call was ${settled.handoff_status}, expected none`);
      if ((settled.risk?.peak ?? 0) >= threshold) failures.push(`benign call peaked at ${settled.risk?.peak}`);
      if (!settled.risk) failures.push("benign call was never scored");
      const status = await twilioPost("/api/twilio/status", { ...base, CallStatus: "completed", CallDuration: "45", From: callerNumber, To: env.TWILIO_PHONE_NUMBER });
      console.log(`  ⏹ status callback (completed) → ${status.res.status}`);
      const ended = await waitFor("the call to end", timeoutSecs, async () => {
        const c = await loadCall();
        return c?.status === "ended" ? c : null;
      });
      await sleep(8_000);
      const { data: report } = await db.from("reports").select("id").eq("call_id", ended.id).maybeSingle();
      if (report) failures.push("a benign call must not get a report");
      console.log(failures.length ? `\n✘ FAIL ${scenario.id}:\n  - ${failures.join("\n  - ")}` : `\n✔ PASS ${scenario.id}: never offered, ended, no report`);
      if (failures.length) process.exitCode = 1;
      return;
    }

    const offered = await waitFor("the takeover offer", 60, async () => {
      const c = await loadCall();
      return c && ["offered", "connected", "requested"].includes(c.handoff_status) ? c : null;
    });
    console.log(`  🚨 OFFERED · risk ${offered.risk?.score} (peak ${offered.risk?.peak}) · ${offered.risk?.scam_type} · “${offered.risk?.reason}”`);

    /* The scam alert: what /protect reads (the customer's own view of the call), with its quotes. */
    let customerCookie: string | null = null;
    const signIn = async (): Promise<string> => {
      if (customerCookie) return customerCookie;
      const link = await fetch(`${baseUrl}/protect?k=${encodeURIComponent(env.CUSTOMER_LINK_TOKEN)}`, { redirect: "manual" });
      const setCookie = link.headers.get("set-cookie") ?? "";
      const cookie = setCookie.split(";")[0];
      if (link.status !== 303 || !cookie.startsWith("northgate_guard=")) failures.push(`/protect?k=… returned ${link.status} without the customer cookie`);
      if (!/HttpOnly/i.test(setCookie)) failures.push("the customer cookie is not HttpOnly");
      customerCookie = cookie;
      return cookie;
    };
    const alertQuotesNow = async (): Promise<{ quotes: string[]; status: string | null }> => {
      const state = await timedFetch(`${baseUrl}/api/protect/state`, { headers: { Cookie: await signIn() } });
      const body = state.body as { call?: { id: string; handoff_status: string; risk?: { quotes?: string[] } | null } | null } | null;
      if (state.res.status !== 200 || body?.call?.id !== offered.id) return { quotes: [], status: body?.call?.handoff_status ?? null };
      return { quotes: body.call.risk?.quotes ?? [], status: body.call.handoff_status };
    };
    const checkQuotes = (quotes: string[], when: string) => {
      const callerOnly = selectScammerQuotes(quotes, scenario.screening);
      console.log(`  💬 alert quotes (${when}): ${quotes.length ? quotes.map((q) => `“${q}”`).join("  ") : "none"}`);
      if (quotes.length === 0) failures.push(`the scam alert had no quotes (${when})`);
      if (quotes.length > 2) failures.push(`the scam alert had ${quotes.length} quotes, expected at most 2`);
      if (callerOnly.length !== quotes.length) failures.push(`an alert quote isn't verbatim from the caller's lines (${when})`);
    };
    if (takeoverBy === "customer") {
      checkQuotes((await alertQuotesNow()).quotes, "when offered");
      if (holdOfferSecs > 0) {
        console.log(`  ⏸  holding the alert open for ${holdOfferSecs}s (open /protect to see it)`);
        await sleep(holdOfferSecs * 1000);
        const held = await alertQuotesNow();
        if (held.status === "offered") checkQuotes(held.quotes, `after ${holdOfferSecs}s`);
      }
    }

    if (untilOffered) {
      await db.from("calls").update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", offered.id);
      console.log(failures.length ? `\n✘ FAIL ${scenario.id} (until offered):\n  - ${failures.join("\n  - ")}` : `\n✔ PASS ${scenario.id}: offered (call closed without a report)`);
      if (failures.length) process.exitCode = 1;
      return;
    }

    /* 3. The tap. */
    let takeover: Awaited<ReturnType<typeof timedFetch>>;
    /** What actually took the call: the customer's choice, or the AI voice after an unavailable twin (always for analysts). */
    let choice: TakeoverChoice = takeoverBy === "customer" ? requestedChoice : "ai_voice";
    if (takeoverBy === "customer") {
      const denied = await timedFetch(`${baseUrl}/api/protect/takeover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId: offered.id }),
      });
      if (denied.res.status !== 401) failures.push(`takeover without the customer cookie returned ${denied.res.status}, expected 401`);
      const cookie = await signIn();
      const tap = (picked: TakeoverChoice) =>
        timedFetch(`${baseUrl}/api/protect/takeover`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify({ callId: offered.id, choice: picked }),
        });
      takeover = await tap(choice);
      const answer = takeover.body as { outcome?: string; error?: string } | null;
      if (choice === "voice_twin" && takeover.res.status === 409 && answer?.outcome === "twin_unavailable") {
        console.log(`  ⚠ ${VOICE_TWIN_LABEL} unavailable → 409 twin_unavailable: "${answer.error ?? ""}" (nothing was claimed)`);
        if (expectTwin) {
          failures.push(`the ${VOICE_TWIN_LABEL} was unavailable (409 twin_unavailable) and --expect-twin was passed`);
          await db.from("calls").update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", offered.id);
          console.log(`\n✘ FAIL ${scenario.id}:\n  - ${failures.join("\n  - ")}\n  (call closed without a report)`);
          process.exitCode = 1;
          return;
        }
        console.log("  ↻ retrying once with Use AI voice so the run can continue");
        choice = "ai_voice";
        takeover = await tap(choice);
      }
    } else {
      takeover = await timedFetch(`${baseUrl}/api/calls/${offered.id}/takeover`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: basicAuth },
        body: JSON.stringify({ approvedBy: approver }),
      });
    }
    const picked = choice === "voice_twin" ? "Use my Voice Twin" : takeoverBy === "customer" ? "Use AI voice" : "Take over now";
    console.log(`  👆 ${takeoverBy} tapped "${picked}" → ${takeover.res.status} in ${takeover.ms}ms ${takeover.text.slice(0, 160)}`);
    if (takeover.res.status !== 200) failures.push(`takeover returned ${takeover.res.status}: ${takeover.text.slice(0, 200)}`);
    const connected = await waitFor("connected", 30, async () => {
      const c = await loadCall();
      return c?.handoff_status === "connected" || c?.handoff_status === "failed" ? c : null;
    });
    const twinTook = choice === "voice_twin";
    console.log(
      `  🛡  ${connected.handoff_status.toUpperCase()} · takeover_kind ${connected.takeover_kind ?? "—"} · persona ${connected.persona} · ` +
        `by ${connected.handoff_by}`,
    );
    if (connected.handoff_status !== "connected") failures.push(`handoff ${connected.handoff_status}: ${connected.handoff_error}`);
    const answeredKind = (takeover.body as { takeover?: string } | null)?.takeover;
    if (twinTook) {
      if (connected.takeover_kind !== "voice_twin") failures.push(`takeover_kind ${connected.takeover_kind}, expected voice_twin`);
      if (connected.persona !== null) failures.push(`persona ${connected.persona}, expected null for the ${VOICE_TWIN_LABEL}`);
      if (!connected.voice_twin_consent_at) failures.push(`the ${VOICE_TWIN_LABEL} takeover has no consent reference`);
      if (answeredKind !== "voice_twin") failures.push(`the takeover response said takeover ${answeredKind}, expected voice_twin`);
    } else {
      if (connected.takeover_kind !== "persona") failures.push(`takeover_kind ${connected.takeover_kind}, expected persona`);
      if (answeredKind !== "persona") failures.push(`the takeover response said takeover ${answeredKind}, expected persona`);
      const match = connected.ai_voice_match;
      if (!isAiVoiceId(connected.persona)) failures.push(`persona ${connected.persona}, expected one of the six AI voices`);
      if (!match) failures.push("no ai_voice_match recorded: which voice and why");
      else {
        console.log(`  🗣  ${aiVoiceSummary(match)} → ${match.voice}${aiVoiceMatchDetail(match) ? ` · ${aiVoiceMatchDetail(match)}` : ""}`);
        if (isAiVoiceId(connected.persona)) console.log(`     ${personaCharacterLine(connected.persona)}`);
        if (match.voice !== connected.persona) failures.push(`ai_voice_match.voice ${match.voice} but persona ${connected.persona}`);
        if (expectVoice && match.voice !== expectVoice) failures.push(`AI voice ${match.voice} (${match.source}), expected ${expectVoice}`);
        if (expectSource && match.source !== expectSource) failures.push(`AI voice chosen ${match.source}, expected ${expectSource}`);
      }
    }
    // A second tap must not register a second call.
    const again = await timedFetch(`${baseUrl}/api/calls/${offered.id}/takeover`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicAuth },
      body: JSON.stringify({ approvedBy: approver }),
    });
    if (again.res.status !== 409) failures.push(`a second takeover returned ${again.res.status}, expected 409`);

    /* 4. The persona's conversation. */
    const entries: Record<string, unknown>[] = [];
    const transcript: Record<string, unknown>[] = [];
    const personaStarted = Math.floor(Date.now() / 1000);
    let clock = 0;
    let toolCalls = 0;
    const dynamicVariables = {
      northgate_call_id: offered.id,
      system__caller_id: callerNumber,
      system__called_number: env.TWILIO_PHONE_NUMBER,
      system__conversation_id: conversationId,
      system__call_sid: callSid,
    };
    for (const turn of scenario.takeover) {
      const role = turn.role === "persona" ? "agent" : "user";
      entries.push({ role, message: turn.message });
      const item: Record<string, unknown> = { role, message: turn.message, time_in_call_secs: clock, tool_calls: null, tool_results: null };
      console.log(`  [${String(Math.floor(clock / 60)).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}] ${turn.role === "persona" ? (twinTook ? "Twin    " : "AI voice") : "Caller  "}: ${turn.message}`);
      if (turn.record_details) {
        toolCalls++;
        const requestId = `toolu_sim_${toolCalls}`;
        entries.push({ role: "agent", tool_requests: [{ tool_name: "record_details", params_as_json: turn.record_details }] });
        const body = {
          ...turn.record_details,
          northgate_call_id: offered.id,
          conversation_id: conversationId,
          caller_id: callerNumber,
          called_number: env.TWILIO_PHONE_NUMBER,
          conversation_history: JSON.stringify({ "x-elevenlabs-history": true, entries }),
          call_duration_secs: Math.floor(Date.now() / 1000) - personaStarted,
        };
        const r = await timedFetch(`${baseUrl}/api/tools/record-details`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tool-secret": env.TOOL_SECRET },
          body: JSON.stringify(body),
        });
        const ok = r.res.ok && (r.body as { ok?: boolean })?.ok === true;
        console.log(`           ↳ record_details ${JSON.stringify(turn.record_details)} → ${r.res.status} in ${r.ms}ms`);
        if (!ok) failures.push(`record_details #${toolCalls} returned ${r.res.status} ${r.text.slice(0, 200)}`);
        if (r.ms > 2000) failures.push(`record_details #${toolCalls} took ${r.ms}ms (must be < 2000ms)`);
        entries.push({ role: "tool", tool_results: [{ tool_name: "record_details", result_value: r.text }] });
        item.tool_calls = [{ request_id: requestId, tool_name: "record_details", params_as_json: JSON.stringify(body), tool_has_been_called: true, type: "webhook" }];
        item.tool_results = [{ request_id: requestId, tool_name: "record_details", result_value: r.text, is_error: !ok, type: "webhook" }];
      }
      transcript.push(item);
      clock += Math.max(3, Math.round(turn.message.length / 14));
      await sleep(personaPace);
    }
    await sleep(Math.max(2000, personaPace));
    const linked = await loadCall();
    if (linked?.conversation_id !== conversationId) failures.push(`record_details did not link the conversation (conversation_id ${linked?.conversation_id})`);

    /* 5. The post-call webhook, then Twilio's completed callback. */
    const payload = {
      type: "post_call_transcription",
      event_timestamp: Math.floor(Date.now() / 1000),
      data: {
        agent_id: env.ELEVENLABS_AGENT_ID ?? "agent_simulated",
        agent_name: "Margaret",
        conversation_id: conversationId,
        status: "done",
        transcript,
        metadata: {
          start_time_unix_secs: personaStarted,
          call_duration_secs: Math.max(1, Math.floor(Date.now() / 1000) - personaStarted),
          termination_reason: "Call ended by remote party",
          conversation_initiation_source: "twilio",
          phone_call: { type: "twilio", direction: "inbound", external_number: callerNumber, agent_number: env.TWILIO_PHONE_NUMBER, phone_number_id: "", call_sid: callSid, stream_sid: `MZsim${randomBytes(15).toString("hex")}`, call_result: "answered" },
        },
        analysis: { call_successful: "unknown", transcript_summary: "", evaluation_criteria_results: {}, data_collection_results: {} },
        conversation_initiation_client_data: { dynamic_variables: dynamicVariables },
        has_audio: false,
        has_user_audio: false,
        has_response_audio: false,
      },
    };
    const rawBody = JSON.stringify(payload);
    const hook = await timedFetch(`${baseUrl}/api/webhooks/elevenlabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ElevenLabs-Signature": signElevenLabsPayload(rawBody, webhookSecret) },
      body: rawBody,
    });
    console.log(`  ⏹ post-call webhook → ${hook.res.status} in ${hook.ms}ms ${hook.text.slice(0, 120)}`);
    if (hook.res.status !== 200 || (hook.body as { call_id?: string })?.call_id !== offered.id) {
      failures.push(`post-call webhook returned ${hook.res.status} ${hook.text.slice(0, 200)} (expected it linked to ${offered.id})`);
    }
    const bad = await timedFetch(`${baseUrl}/api/webhooks/elevenlabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ElevenLabs-Signature": signElevenLabsPayload(rawBody, "wrong-secret") },
      body: rawBody,
    });
    if (bad.res.status !== 401) failures.push(`badly signed webhook returned ${bad.res.status}, expected 401`);

    const status = await twilioPost("/api/twilio/status", { ...base, CallStatus: "completed", CallDuration: String(60 + clock), From: callerNumber, To: env.TWILIO_PHONE_NUMBER });
    console.log(`  ⏹ status callback (completed) → ${status.res.status}`);
    if (status.res.status !== 204) failures.push(`status callback returned ${status.res.status}`);

    /* 6. Report and email. */
    const call = await waitFor("the call to end", timeoutSecs, async () => {
      const c = await loadCall();
      return c?.status === "ended" ? c : null;
    });
    let report = await waitFor("the report", timeoutSecs, async () => {
      const { data } = await db.from("reports").select("*").eq("call_id", call.id).maybeSingle<ReportRow>();
      return data;
    });
    console.log(`  📝 report ${report.id}: "${report.body.title}" (${report.status})`);

    if (mode === "approve") {
      if (report.status !== "draft") failures.push(`approve mode: expected a draft, got ${report.status}`);
      const r = await timedFetch(`${baseUrl}/api/reports/${report.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: basicAuth },
        body: JSON.stringify({ approvedBy: approver }),
      });
      console.log(`  ✅ approved by "${approver}" → ${r.res.status} in ${r.ms}ms`);
      if (!r.res.ok) failures.push(`approve returned ${r.res.status} ${r.text.slice(0, 200)}`);
    }
    report = await waitFor("the report to be sent", timeoutSecs, async () => {
      const { data } = await db.from("reports").select("*").eq("id", report.id).single<ReportRow>();
      return data?.status === "sent" ? data : null;
    });
    console.log(`  📧 sent ${report.sent_at} · ${report.approved_by ? `approved by ${report.approved_by}` : "auto"} · Resend id ${report.email_id}`);

    let lastEvent: string | undefined;
    if (!flag("no-email-check") && report.email_id) {
      const email = await waitFor(
        "Resend to report delivery",
        timeoutSecs,
        async () => {
          const r = await fetch(`https://api.resend.com/emails/${report.email_id}`, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } });
          if (!r.ok) return null;
          const j = (await r.json()) as { last_event?: string; to?: string[]; subject?: string };
          lastEvent = j.last_event;
          return j.last_event && ["delivered", "bounced", "failed", "complained", "suppressed"].includes(j.last_event) ? j : null;
        },
        3000,
      );
      console.log(`  📬 Resend: last_event=${email.last_event} subject="${email.subject}"`);
      if (email.last_event !== "delivered") failures.push(`Resend last_event is ${email.last_event}, expected delivered`);
    }

    /* Expectations. */
    const { data: finalCall } = await db.from("calls").select("*").eq("id", call.id).single<CallRow>();
    const intel = finalCall?.intel;
    const exp = scenario.expect ?? {};
    console.log(
      `  🔎 intel: ${intel?.scam_type} · payee ${intel?.payee.name ?? "—"} ${intel?.payee.sort_code ?? "—"} ${intel?.payee.account_number ?? "—"} · mule ${
        finalCall?.mule_match?.status ?? "none"
      } · screening ${finalCall?.screening_transcript.length} lines + persona ${finalCall?.transcript.length} turns`,
    );
    for (const t of report.body.protection_timeline ?? []) console.log(`     ${t.time}  ${t.event}`);
    if (exp.scam_type && intel?.scam_type !== exp.scam_type) failures.push(`scam_type ${intel?.scam_type}, expected ${exp.scam_type}`);
    if (exp.sort_code && intel?.payee.sort_code !== exp.sort_code) failures.push(`sort code ${intel?.payee.sort_code}, expected ${exp.sort_code}`);
    if (exp.account_number && intel?.payee.account_number !== exp.account_number) failures.push(`account ${intel?.payee.account_number}, expected ${exp.account_number}`);
    if (exp.mule !== undefined && (finalCall?.mule_match?.status ?? null) !== exp.mule) failures.push(`mule ${finalCall?.mule_match?.status ?? null}, expected ${exp.mule}`);
    if (finalCall?.caller_masked !== maskCaller(callerNumber)) failures.push(`caller_masked ${finalCall?.caller_masked}, expected ${maskCaller(callerNumber)}`);
    if (finalCall?.conversation_id !== conversationId) failures.push(`conversation_id ${finalCall?.conversation_id}, expected ${conversationId}`);
    const events = (report.body.protection_timeline ?? []).map((t) => t.event).join(" | ");
    const needles = ["Risk threshold crossed", "Handed over to Northgate", twinTook ? VOICE_TWIN_REPORT_LABEL : "AI voice:", "Call ended"];
    for (const needle of needles) {
      if (!events.includes(needle)) failures.push(`protection timeline is missing "${needle}"`);
    }
    const reportKind = report.body.takeover?.type;
    const expectedKind = twinTook ? "voice_twin" : "persona";
    if (reportKind && reportKind !== expectedKind) failures.push(`report takeover.type ${reportKind}, expected ${expectedKind}`);
    console.log(`  📄 report takeover: ${report.body.takeover?.label ?? "—"}${report.body.takeover?.ai_voice ? ` · as ${report.body.takeover.ai_voice.name}` : ""}`);
    if (!twinTook && finalCall?.ai_voice_match && report.body.takeover?.label !== aiVoiceSummary(finalCall.ai_voice_match)) {
      failures.push(`report takeover label "${report.body.takeover?.label}", expected "${aiVoiceSummary(finalCall.ai_voice_match)}"`);
    }

    console.log(
      failures.length === 0
        ? `\n✔ PASS ${scenario.id}${mode ? ` (${mode} mode)` : ""} · ${takeoverBy} takeover · ${
            twinTook ? VOICE_TWIN_LABEL : connected.ai_voice_match ? aiVoiceSummary(connected.ai_voice_match) : connected.persona
          }${
            lastEvent ? ` · email ${lastEvent}` : ""
          }`
        : `\n✘ FAIL ${scenario.id}:\n  - ${failures.join("\n  - ")}`,
    );
  } finally {
    if (mode && previousAutoSend !== undefined) {
      await db.from("settings").update({ auto_send: previousAutoSend, updated_at: new Date().toISOString() }).eq("id", 1);
      console.log(`  auto-send restored to ${previousAutoSend}`);
    }
  }
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
