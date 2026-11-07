/**
 * Check the AI Voice Twin SQL (supabase/migrations/0009_voice_twin.sql) against the real database: the consent gate,
 * voice_twin_add_audio, voice_twin_claim_clone, the conditional finish, voice_twin_expire,
 * voice_twin_discard_unflagged_call_audio, voice_twin_revoke and the access rules.
 *
 *   npx tsx scripts/check-voice-twin-db.ts      # after npm run db:migrate
 *
 * Everything runs inside ONE transaction that is always rolled back (also when every check passes), so the script
 * leaves no data behind. Expected failures run inside SAVEPOINTs. Prints ✔/✘ per check; exits 1 if any check fails.
 */
import "./lib/load-env";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { requireEnv } from "../lib/env";

/** Same as scripts/migrate.ts: SUPABASE_DB_URL, falling back to the aws-1 pooler host. */
async function connect(): Promise<Client> {
  const primary = requireEnv("SUPABASE_DB_URL");
  // The spec's fallback: same string with the aws-1 pooler host.
  const candidates = [primary, primary.replace(/aws-0-([a-z0-9-]+)\.pooler\.supabase\.com/, "aws-1-$1.pooler.supabase.com")];
  let lastError: unknown;
  for (const connectionString of [...new Set(candidates)]) {
    const client = new Client({
      connectionString,
      // Encrypted, but not CA-verified: Supabase's pooler certificate chains to Supabase's own root CA, which is
      // not in Node's trust store. This is a local admin script; download Supabase's CA and pass it as `ca` to verify.
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15_000,
    });
    try {
      await client.connect();
      console.log(`Connected to ${new URL(connectionString).host}`);
      return client;
    } catch (error) {
      lastError = error;
      console.warn(`Could not connect to ${new URL(connectionString).host}: ${(error as Error).message}`);
    }
  }
  throw lastError;
}

/* ---------- reporting ---------- */

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, got?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name}${got === undefined ? "" : `\n      got: ${JSON.stringify(got)}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const near = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-9;

/* ---------- the checks ---------- */

type Json = Record<string, unknown>;

const TABLES = ["voice_twins", "voice_twin_audio", "voice_twin_consent_events", "voice_twin_voice_deletions", "media_bridges"];
const FUNCTIONS = [
  "public.call_is_flagged(public.calls)",
  "public.voice_twin_add_audio(uuid, text, uuid, text, integer, text, text, integer, double precision, integer, timestamptz)",
  "public.voice_twin_claim_clone(uuid, double precision, integer, boolean)",
  "public.voice_twin_revoke(uuid, text, text)",
  "public.voice_twin_expire(uuid)",
  "public.voice_twin_discard_unflagged_call_audio(uuid)",
  // 0010
  "public.call_has_customer_speech(public.calls)",
  "public.call_audio_eligible(public.calls)",
  "public.call_is_over(public.calls)",
  "public.media_bridge_heartbeat(text, text)",
  "public.active_media_bridge(integer)",
  "public.voice_twin_retire_voice(uuid, text)",
];

interface TwinRow {
  id: string;
  voice_twin_consent: boolean;
  consent_revoked_at: Date | null;
  state: string;
  speech_seconds: number;
  voice_id: string | null;
  voice_source: string | null;
  voice_expires_at: Date | null;
  clone_speech_seconds: number | null;
  cloning_started_at: Date | null;
  last_audio_at: Date | null;
}

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

async function runChecks(client: Client, suffix: string): Promise<void> {
  const accountRef = `db-check-${suffix}`;
  const q = async <T extends Json>(sql: string, params: unknown[] = []): Promise<T[]> => (await client.query<T>(sql, params)).rows;
  const one = async <T extends Json>(sql: string, params: unknown[] = []): Promise<T | undefined> => (await q<T>(sql, params))[0];

  /** Expect `sql` to fail with a check violation on `constraint`; the savepoint keeps the transaction usable. */
  const expectViolation = async (name: string, sql: string, params: unknown[], constraint: string): Promise<void> => {
    await client.query("savepoint expect_failure");
    try {
      await client.query(sql, params);
      check(name, false, "the statement succeeded");
    } catch (error) {
      const e = error as PgError;
      check(name, e.code === "23514" && e.constraint === constraint, { code: e.code, constraint: e.constraint, message: e.message });
    } finally {
      await client.query("rollback to savepoint expect_failure");
    }
  };

  // Preflight: is 0009 applied?
  section("0009 applied");
  const tableNames = TABLES.map((t) => `public.${t}`);
  const missing = [
    ...(await q<{ name: string }>("select name from unnest($1::text[]) as name where to_regclass(name) is null", [tableNames])),
    ...(await q<{ name: string }>("select name from unnest($1::text[]) as name where to_regprocedure(name) is null", [FUNCTIONS])),
  ].map((m) => m.name);
  check("tables and functions exist", missing.length === 0, missing);
  if (missing.length) throw new Error("0009 isn't applied (run npm run db:migrate first)");

  const twinRow = async (id: string) => (await one<TwinRow & Json>("select * from public.voice_twins where id = $1", [id])) as TwinRow;
  const audioPaths = async (twinId: string) => {
    const rows = await q<{ storage_path: string }>(
      "select storage_path from public.voice_twin_audio where twin_id = $1 order by storage_path",
      [twinId],
    );
    return rows.map((row) => row.storage_path);
  };
  const deletion = (voiceId: string) =>
    one<{ reason: string; twin_id: string | null }>(
      "select reason, twin_id from public.voice_twin_voice_deletions where voice_id = $1",
      [voiceId],
    );

  // 1. A new twin.
  section("voice_twins and the consent gate");
  const inserted = await one<{ id: string }>("insert into public.voice_twins (account_ref) values ($1) returning id", [accountRef]);
  if (!inserted) throw new Error("could not insert the test twin");
  const twinId = inserted.id;
  let twin = await twinRow(twinId);
  check(
    "a new twin starts without consent, collecting, with 0 s",
    !twin.voice_twin_consent && twin.state === "collecting" && twin.speech_seconds === 0,
    twin,
  );

  // 2. The consent gate check constraint.
  await expectViolation(
    "voice_twins_consent_gate rejects consent=false with speech_seconds > 0",
    "update public.voice_twins set speech_seconds = 5 where id = $1",
    [twinId],
    "voice_twins_consent_gate",
  );
  await expectViolation(
    "voice_twins_consent_gate rejects a voice without consent",
    "update public.voice_twins set voice_id = 'db-check-x', voice_source = 'clone' where id = $1",
    [twinId],
    "voice_twins_consent_gate",
  );
  await expectViolation(
    "voice_twins_consent_gate rejects any state but collecting without consent",
    "update public.voice_twins set state = 'failed' where id = $1",
    [twinId],
    "voice_twins_consent_gate",
  );

  const path = (source: "sample" | "call", session: string, seq: number) =>
    `${twinId}/${source}/${session}/${String(seq).padStart(5, "0")}.wav`;
  const sampleSession = `db-check-sample-${suffix}`;
  interface Chunk {
    twin?: string;
    source: "sample" | "call";
    callId: string | null;
    session: string;
    seq: number;
    seconds: number;
  }
  const addAudio = async (a: Chunk) => {
    const sampleRate = a.source === "call" ? 8000 : 16000;
    const row = await one<{ r: Json }>(
      `select public.voice_twin_add_audio($1::uuid, $2::text, $3::uuid, $4::text, $5::integer, $6::text, $7::text, $8::integer,
         $9::double precision, $10::integer) as r`,
      [a.twin ?? twinId, a.source, a.callId, a.session, a.seq, path(a.source, a.session, a.seq), "audio/wav", sampleRate, a.seconds, 1234],
    );
    return row?.r ?? {};
  };
  const claim = async (minSeconds: number, staleSeconds = 180, allowFailed = false) =>
    (
      await one<{ r: Json }>("select public.voice_twin_claim_clone($1::uuid, $2::double precision, $3::integer, $4::boolean) as r", [
        twinId,
        minSeconds,
        staleSeconds,
        allowFailed,
      ])
    )?.r ?? {};

  // 3. No audio and no clone without consent.
  section("voice_twin_add_audio");
  let r = await addAudio({ source: "sample", callId: null, session: sampleSession, seq: 0, seconds: 12 });
  check("refused without consent (no_consent)", r.accepted === false && r.reason === "no_consent", r);
  check("… and nothing was stored", (await audioPaths(twinId)).length === 0 && (await twinRow(twinId)).speech_seconds === 0);
  r = await claim(0, 180, true);
  check("voice_twin_claim_clone refused without consent (no_consent)", r.claimed === false && r.reason === "no_consent", r);
  const unknownTwin = "00000000-0000-4000-8000-000000000000";
  r = await addAudio({ twin: unknownTwin, source: "sample", callId: null, session: sampleSession, seq: 0, seconds: 1 });
  check("refused for an unknown twin (missing)", r.accepted === false && r.reason === "missing", r);

  // 4. Consent.
  const consented = await q(
    `update public.voice_twins
       set voice_twin_consent = true, consent_given_at = now(), consent_given_by = 'db-check', consent_text_version = 'db-check',
           updated_at = now()
     where id = $1 and voice_twin_consent = false returning id`,
    [twinId],
  );
  check("consent can be given (conditional update)", consented.length === 1);
  await expectViolation(
    "voice_twins_ready_has_voice rejects 'ready' without a voice",
    "update public.voice_twins set state = 'ready' where id = $1",
    [twinId],
    "voice_twins_ready_has_voice",
  );

  // 5. A Settings sample, idempotent per (session, seq).
  r = await addAudio({ source: "sample", callId: null, session: sampleSession, seq: 0, seconds: 12 });
  check("a sample is accepted with consent", r.accepted === true && r.duplicate === false && near(r.speech_seconds, 12), r);
  r = await addAudio({ source: "sample", callId: null, session: sampleSession, seq: 0, seconds: 12 });
  check("the same chunk again is a duplicate", r.accepted === true && r.duplicate === true && near(r.speech_seconds, 12), r);
  twin = await twinRow(twinId);
  check("… and its speech isn't counted twice", near(twin.speech_seconds, 12) && (await audioPaths(twinId)).length === 1, twin.speech_seconds);
  check("last_audio_at is set", twin.last_audio_at !== null);

  // 6. Calls: U stays unflagged, F is flagged.
  section("call audio and call_is_flagged");
  const insertCall = async (sid: string, flagged: boolean) => {
    const row = await one<{ id: string }>(
      flagged
        ? `insert into public.calls (twilio_call_sid, status, offered_at, handoff_status, risk, screening_transcript)
           values ($1, 'live', now(), 'offered', jsonb_build_object('threshold_crossed_at', now()),
                   jsonb_build_array(jsonb_build_object('speaker', 'customer', 'text', 'Oh no, what do I need to do?', 'at', now())))
           returning id`
        : `insert into public.calls (twilio_call_sid, status, screening_transcript)
           values ($1, 'live', jsonb_build_array(jsonb_build_object('speaker', 'customer', 'text', 'Hello, who is this please?', 'at', now())))
           returning id`,
      [sid],
    );
    if (!row) throw new Error("could not insert a test call");
    return row.id;
  };
  const callU = await insertCall(`CAdbcheck${suffix}u`, false);
  const callF = await insertCall(`CAdbcheck${suffix}f`, true);
  const streamU = `MZdbcheck${suffix}u`;
  const streamF = `MZdbcheck${suffix}f`;
  const flagged = async (callId: string) =>
    (await one<{ f: boolean | null }>("select public.call_is_flagged(c) as f from public.calls c where c.id = $1", [callId]))?.f;
  check("call_is_flagged: a live call with no offer, risk or handover isn't flagged", (await flagged(callU)) === false);
  check("call_is_flagged: an offered call is flagged", (await flagged(callF)) === true);

  r = await addAudio({ source: "call", callId: callU, session: streamU, seq: 0, seconds: 20 });
  check("call audio is accepted while the unflagged call is live", r.accepted === true && near(r.speech_seconds, 32), r);
  r = await addAudio({ source: "call", callId: callF, session: streamF, seq: 0, seconds: 15 });
  check("call audio is accepted for a flagged call", r.accepted === true && near(r.speech_seconds, 47), r);
  r = await addAudio({ source: "call", callId: null, session: streamU, seq: 99, seconds: 1 });
  check("call audio without a call is refused (missing_call)", r.accepted === false && r.reason === "missing_call", r);

  // 7. Claiming the clone.
  section("voice_twin_claim_clone");
  r = await claim(30);
  check(
    "refused below the minimum (not_enough_audio); a live unflagged call's 20 s are NOT eligible (27 s, not 47 s)",
    r.claimed === false && r.reason === "not_enough_audio" && near(r.eligible_seconds, 27),
    r,
  );
  check("… and the twin is still collecting", (await twinRow(twinId)).state === "collecting");
  r = await claim(25);
  const claimedPaths = Array.isArray(r.audio) ? (r.audio as Json[]).map((a) => a.storage_path).sort() : [];
  check("claims at ≥ the minimum with the eligible seconds", r.claimed === true && near(r.eligible_seconds, 27), {
    ...r,
    audio: claimedPaths,
  });
  const eligiblePaths = [path("sample", sampleSession, 0), path("call", streamF, 0)].sort();
  check(
    "returns the eligible audio: the sample and the flagged call, not the live unflagged call",
    JSON.stringify(claimedPaths) === JSON.stringify(eligiblePaths),
    claimedPaths,
  );
  twin = await twinRow(twinId);
  check("the twin is now cloning with cloning_started_at", twin.state === "cloning" && twin.cloning_started_at !== null, twin.state);
  r = await claim(25);
  check("a second claim is refused while the first is fresh (busy)", r.claimed === false && r.reason === "busy", r);
  r = await addAudio({ source: "sample", callId: null, session: sampleSession, seq: 1, seconds: 5 });
  check("no audio is accepted while cloning (not_collecting)", r.accepted === false && r.reason === "not_collecting", r);
  await client.query("update public.voice_twins set cloning_started_at = now() - interval '10 minutes' where id = $1", [twinId]);
  r = await claim(25, 180);
  check("a stale cloning claim can be claimed again", r.claimed === true, { ...r, audio: undefined });

  // 8. Finish (the conditional update lib/voice-twin/store.ts finishClone makes).
  section("finish, then voice_twin_expire");
  const finish = () =>
    q(
      `update public.voice_twins
         set state = 'ready', voice_id = 'db-check-voice', voice_source = 'clone', voice_created_at = now() - interval '25 hours',
             voice_expires_at = now() - interval '1 hour', clone_speech_seconds = 27, clone_error = null, cloning_started_at = null,
             updated_at = now()
       where id = $1 and state = 'cloning' and voice_twin_consent returning id`,
      [twinId],
    );
  check("the conditional update moves cloning → ready", (await finish()).length === 1);
  check("… and only once (no longer cloning)", (await finish()).length === 0);

  // 9. Expiry (24 h after creation).
  const inUse = await one<{ n: number }>(
    `select count(*)::int as n from public.calls
     where status = 'live' and takeover_kind = 'voice_twin' and handoff_status in ('requested', 'connected')`,
  );
  if (inUse?.n) console.log(`  (note: ${inUse.n} live AI Voice Twin call(s) in the database: voice_twin_expire defers while they last)`);
  r = (await one<{ r: Json }>("select public.voice_twin_expire($1::uuid) as r", [twinId]))?.r ?? {};
  const expiredPaths = Array.isArray(r.paths) ? (r.paths as string[]).sort() : [];
  check("voice_twin_expire retires an expired voice", r.expired === true, r);
  const allPaths = [path("sample", sampleSession, 0), path("call", streamU, 0), path("call", streamF, 0)].sort();
  check("… returning the leftover audio paths (all 3 chunks)", JSON.stringify(expiredPaths) === JSON.stringify(allPaths), expiredPaths);
  const expiredDeletion = await deletion("db-check-voice");
  check(
    "… queues the clone for deletion (reason 'expired')",
    expiredDeletion?.reason === "expired" && expiredDeletion.twin_id === twinId,
    expiredDeletion,
  );
  twin = await twinRow(twinId);
  check(
    "… and resets the twin to collecting with 0 s and no voice (consent kept)",
    twin.state === "collecting" &&
      twin.speech_seconds === 0 &&
      twin.voice_id === null &&
      twin.voice_source === null &&
      twin.voice_expires_at === null &&
      twin.clone_speech_seconds === null &&
      twin.voice_twin_consent,
    twin,
  );
  check("… with no audio rows left", (await audioPaths(twinId)).length === 0);
  r = (await one<{ r: Json }>("select public.voice_twin_expire($1::uuid) as r", [twinId]))?.r ?? {};
  check("a collecting twin isn't expired (not_due)", r.expired === false && r.reason === "not_due", r);

  // 10. Discarding an unflagged call's audio.
  section("voice_twin_discard_unflagged_call_audio");
  r = await addAudio({ source: "call", callId: callU, session: streamU, seq: 1, seconds: 8 });
  check("collecting again: live call audio accepted", r.accepted === true && near(r.speech_seconds, 8), r);
  r = await addAudio({ source: "sample", callId: null, session: sampleSession, seq: 1, seconds: 5 });
  check("collecting again: a sample accepted", r.accepted === true && near(r.speech_seconds, 13), r);
  const discard = async (callId: string) =>
    (await one<{ r: Json }>("select public.voice_twin_discard_unflagged_call_audio($1::uuid) as r", [callId]))?.r ?? {};
  r = await discard(callU);
  check("a live call's audio is not discarded (live)", r.discarded === false && r.reason === "live", r);

  await client.query("update public.calls set status = 'ended', ended_at = now() where id = $1", [callU]);
  check("call_is_flagged: still not flagged once ended", (await flagged(callU)) === false);
  r = await addAudio({ source: "call", callId: callU, session: streamU, seq: 2, seconds: 4 });
  check(
    "call audio is refused once the call ended unflagged (call_not_flagged)",
    r.accepted === false && r.reason === "call_not_flagged",
    r,
  );
  check("… and nothing was stored for it", !(await audioPaths(twinId)).includes(path("call", streamU, 2)));

  r = await discard(callU);
  check(
    "an ended unflagged call's audio is discarded, returning its paths",
    r.discarded === true && JSON.stringify(r.paths) === JSON.stringify([path("call", streamU, 1)]),
    r,
  );
  twin = await twinRow(twinId);
  check("… its rows are gone and its seconds subtracted (13 s → 5 s)", near(twin.speech_seconds, 5), twin.speech_seconds);
  check("… the sample is kept", JSON.stringify(await audioPaths(twinId)) === JSON.stringify([path("sample", sampleSession, 1)]));

  await client.query("update public.calls set status = 'ended', ended_at = now() where id = $1", [callF]);
  r = await addAudio({ source: "call", callId: callF, session: streamF, seq: 1, seconds: 3 });
  check("a flagged call's audio is still accepted after it ended", r.accepted === true && near(r.speech_seconds, 8), r);
  r = await discard(callF);
  check("a flagged call's audio is kept (flagged)", r.discarded === false && r.reason === "flagged", r);
  check("… its row is still there", (await audioPaths(twinId)).includes(path("call", streamF, 1)));

  // 11. Revoke.
  section("voice_twin_revoke");
  const revoke = async () => {
    const row = await one<{ r: Json }>("select public.voice_twin_revoke($1::uuid, $2::text, $3::text) as r", [
      twinId,
      "db-check",
      "db-check-agent",
    ]);
    return row?.r ?? {};
  };

  await client.query("savepoint fallback_revoke");
  await client.query(
    `update public.voice_twins set state = 'ready', voice_id = 'db-check-fallback', voice_source = 'fallback', voice_created_at = now(),
       voice_expires_at = now() + interval '24 hours' where id = $1`,
    [twinId],
  );
  r = await revoke();
  check(
    "revoking a fallback twin doesn't queue the hand-made fallback voice",
    r.revoked === true && (await deletion("db-check-fallback")) === undefined,
    { ...r, previous: undefined },
  );
  await client.query("rollback to savepoint fallback_revoke");

  await client.query(
    `update public.voice_twins set state = 'ready', voice_id = 'db-check-voice-2', voice_source = 'clone', voice_created_at = now(),
       voice_expires_at = now() + interval '24 hours', clone_speech_seconds = 8 where id = $1`,
    [twinId],
  );
  r = await revoke();
  const revokedPaths = Array.isArray(r.paths) ? (r.paths as string[]).sort() : [];
  check("voice_twin_revoke revokes", r.revoked === true, { ...r, previous: undefined });
  const remainingPaths = [path("sample", sampleSession, 1), path("call", streamF, 1)].sort();
  check("… returning every audio path", JSON.stringify(revokedPaths) === JSON.stringify(remainingPaths), revokedPaths);
  twin = await twinRow(twinId);
  check(
    "… and resets everything: no consent, collecting, 0 s, no voice",
    !twin.voice_twin_consent &&
      twin.consent_revoked_at !== null &&
      twin.state === "collecting" &&
      twin.speech_seconds === 0 &&
      twin.voice_id === null &&
      twin.voice_source === null &&
      twin.voice_expires_at === null &&
      twin.clone_speech_seconds === null,
    twin,
  );
  check("… with no audio rows left", (await audioPaths(twinId)).length === 0);
  const revokedDeletion = await deletion("db-check-voice-2");
  check(
    "… and queues the app-made clone for deletion (reason 'revoked')",
    revokedDeletion?.reason === "revoked" && revokedDeletion.twin_id === twinId,
    revokedDeletion,
  );
  const event = await one<{ event: string; by: string | null; user_agent: string | null }>(
    "select event, by, user_agent from public.voice_twin_consent_events where twin_id = $1 order by id desc limit 1",
    [twinId],
  );
  check(
    "… and logs a 'revoked' consent event",
    event?.event === "revoked" && event.by === "db-check" && event.user_agent === "db-check-agent",
    event,
  );
  r = await addAudio({ source: "sample", callId: null, session: sampleSession, seq: 2, seconds: 5 });
  check("no audio is accepted after revoking (no_consent)", r.accepted === false && r.reason === "no_consent", r);

  // 12. 0010 hardening.
  section("0010: only the customer's own voice, claim token, bounded deferral, heartbeats");
  await q("update public.voice_twins set voice_twin_consent = true, consent_given_at = now(), consent_revoked_at = null where id = $1", [twinId]);
  const insertScreenedCall = async (sid: string, customerLine: string) => {
    const row = await one<{ id: string }>(
      `insert into public.calls (twilio_call_sid, status, offered_at, handoff_status, risk, screening_transcript)
       values ($1, 'live', now(), 'offered', jsonb_build_object('threshold_crossed_at', now()),
               jsonb_build_array(jsonb_build_object('speaker', 'customer', 'text', $2::text, 'at', now())))
       returning id`,
      [sid, customerLine],
    );
    if (!row) throw new Error("could not insert a test call");
    return row.id;
  };
  const callVm = await insertScreenedCall(`CAdbcheck${suffix}v`, "The person you have called is not available. Please leave a message after the tone.");
  const callOk = await insertScreenedCall(`CAdbcheck${suffix}k`, "Oh no, what do I need to do?");
  const eligibleCall = async (id: string) =>
    (await one<{ ok: boolean }>("select public.call_audio_eligible(c) as ok from public.calls c where c.id = $1", [id]))?.ok;
  check("call_audio_eligible: a flagged call answered by voicemail is NOT eligible", (await eligibleCall(callVm)) === false);
  check("call_audio_eligible: a flagged call where the customer spoke is eligible", (await eligibleCall(callOk)) === true);
  r = await addAudio({ source: "call", callId: callVm, session: `MZdbcheck${suffix}v`, seq: 0, seconds: 40 });
  check("voicemail-answered call audio is accepted while the call is live", r.accepted === true, r);
  let c10 = await claim(30);
  check("… but never counts toward the clone (not_enough_audio, 0 s eligible)", c10.claimed === false && c10.reason === "not_enough_audio" && near(c10.eligible_seconds, 0), c10);
  await q("update public.calls set status = 'ended', ended_at = now() where id = $1", [callVm]);
  const vmDiscard = (await one<{ r: Json }>("select public.voice_twin_discard_unflagged_call_audio($1::uuid) as r", [callVm]))?.r ?? {};
  check("… and is discarded once that call ends", vmDiscard.discarded === true && (vmDiscard.paths as unknown[]).length === 1, vmDiscard);
  r = await addAudio({ source: "call", callId: callOk, session: `MZdbcheck${suffix}k`, seq: 0, seconds: 35 });
  c10 = await claim(30);
  check("claim returns a claim token (claimed_at)", c10.claimed === true && typeof c10.claimed_at === "string", c10);
  const token1 = c10.claimed_at as string;
  const same = await one<{ same: boolean }>("select cloning_started_at = $2::timestamptz as same from public.voice_twins where id = $1", [twinId, token1]);
  check("… which equals the stored cloning_started_at exactly (finish/fail filter on it)", same?.same === true, same);
  // An abandoned claim: backdate it (inside one transaction now() is frozen, so a fresh claim can't look stale).
  const oldClaim = await one<{ token: string }>(
    "update public.voice_twins set cloning_started_at = cloning_started_at - interval '10 minutes' where id = $1 returning cloning_started_at::text as token",
    [twinId],
  );
  const c10b = await claim(30, 180);
  const now10 = await one<{ same: boolean }>("select cloning_started_at = $2::timestamptz as same from public.voice_twins where id = $1", [twinId, c10b.claimed_at]);
  check(
    "re-claiming a stale claim issues a fresh token, stored as cloning_started_at",
    c10b.claimed === true && typeof c10b.claimed_at === "string" && c10b.claimed_at !== token1 && now10?.same === true,
    c10b,
  );
  const lateFinish = await q(
    "update public.voice_twins set state = 'failed' where id = $1 and state = 'cloning' and cloning_started_at = $2::timestamptz returning id",
    [twinId, oldClaim?.token],
  );
  check("a finish/fail carrying the old token matches nothing", lateFinish.length === 0, lateFinish);

  const makeExpiredReady = (voiceId: string) =>
    q(
      `update public.voice_twins set state = 'ready', voice_id = $2, voice_source = 'clone', voice_created_at = now() - interval '25 hours',
         voice_expires_at = now() - interval '1 hour', clone_speech_seconds = 35, cloning_started_at = null where id = $1`,
      [twinId, voiceId],
    );
  const twinCall = await one<{ id: string }>(
    `insert into public.calls (twilio_call_sid, status, handoff_status, takeover_kind, voice_twin_consent_at, handoff_at)
     values ($1, 'live', 'connected', 'voice_twin', now(), now() - interval '2 hours') returning id`,
    [`CAdbcheck${suffix}t`],
  );
  await makeExpiredReady("db-check-voice-3");
  let ex = (await one<{ r: Json }>("select public.voice_twin_expire($1::uuid) as r", [twinId]))?.r ?? {};
  check("a twin call stuck 'live' for over an hour no longer defers the 24 h deletion", ex.expired === true, ex);
  await makeExpiredReady("db-check-voice-4");
  await q("update public.calls set handoff_at = now() - interval '5 minutes' where id = $1", [twinCall?.id]);
  ex = (await one<{ r: Json }>("select public.voice_twin_expire($1::uuid) as r", [twinId]))?.r ?? {};
  check("a twin call handed over minutes ago still defers it (in_use)", ex.expired === false && ex.reason === "in_use", ex);
  await q("update public.calls set status = 'ended' where id = $1", [twinCall?.id]);

  await q("update public.voice_twins set voice_expires_at = now() + interval '20 hours' where id = $1", [twinId]);
  const retired = await one<{ ok: boolean }>("select public.voice_twin_retire_voice($1::uuid, 'db-check-voice-4') as ok", [twinId]);
  const afterRetire = await twinRow(twinId);
  check("voice_twin_retire_voice expires the voice now", retired?.ok === true && afterRetire.voice_expires_at !== null && afterRetire.voice_expires_at.getTime() <= Date.now() + 5_000, afterRetire.voice_expires_at);
  const notMine = await one<{ ok: boolean }>("select public.voice_twin_retire_voice($1::uuid, 'some-other-voice') as ok", [twinId]);
  check("… only for the twin's own current voice", notMine?.ok === false);

  const bridgeId = `db-check-bridge-${suffix}`;
  await q("select public.media_bridge_heartbeat($1, 'https://db-check.invalid')", [bridgeId]);
  const active = await one<{ id: string }>("select id from public.active_media_bridge(90)");
  check("media_bridge_heartbeat + active_media_bridge use the database clock", active?.id === bridgeId, active);
  await q("update public.media_bridges set seen_at = now() - interval '5 minutes' where id = $1", [bridgeId]);
  const stale = await q<{ id: string }>("select id from public.active_media_bridge(90) where id = $1", [bridgeId]);
  check("… and a bridge silent for 5 minutes is not active", stale.length === 0, stale);

  // 13. 0011: the speech rule only looks at the greeting, and audio is bound to the consent it was recorded under.
  section("0011: speech rule, consent binding, final-minute expiry");
  const speech = async (lines: string[]) =>
    (
      await one<{ ok: boolean }>(
        `select public.call_has_customer_speech(row(c.*)::public.calls) as ok
         from (select (jsonb_populate_record(null::public.calls, jsonb_build_object('screening_transcript',
           (select coalesce(jsonb_agg(jsonb_build_object('speaker', 'customer', 'text', t, 'at', now())), '[]'::jsonb) from unnest($1::text[]) t)))).*) c`,
        [lines],
      )
    )?.ok;
  for (const [lines, expected, why] of [
    [["Hello, who's calling please?", "Oh dear, what do I need to do with my savings?"], true, "an ordinary \"who's calling?\" answer counts"],
    [["Hello?", "I'm not available on Thursday, can it wait?"], true, "\"not available\" in conversation counts"],
    [["Hello who is this", "Sorry what", "I got a voicemail saying my account was frozen."], true, "\"voicemail\" mentioned later counts"],
    [["The person you have called is not available. Please leave a message after the tone."], false, "a carrier voicemail greeting doesn't"],
    [["Hi, the person you’re calling is using a call assistant. Tell me who you are and why you’re calling."], false, "a call-screening assistant (curly apostrophes) doesn't"],
    [["Welcome to the Vodafone voicemail service.", "Hello who is this please"], false, "a voicemail greeting first, then talk, doesn't"],
  ] as [string[], boolean, string][]) {
    check(`call_has_customer_speech: ${why}`, (await speech(lines)) === expected);
  }

  const consentA = (await one<{ at: string }>("select consent_given_at::text as at from public.voice_twins where id = $1", [twinId]))?.at;
  await q("update public.voice_twins set state = 'collecting', speech_seconds = 0, voice_id = null, voice_source = null, voice_created_at = null, voice_expires_at = null, clone_speech_seconds = null, cloning_started_at = null where id = $1", [twinId]);
  const addWithConsent = async (seq: number, consentAt: string | null) =>
    (
      await one<{ r: Json }>(
        `select public.voice_twin_add_audio($1::uuid, 'sample', null, $2::text, $3::integer, $4::text, 'audio/wav', 16000, 5, 100, $5::timestamptz) as r`,
        [twinId, `consent-${suffix}`, seq, path("sample", `consent-${suffix}`, seq), consentAt],
      )
    )?.r ?? {};
  let rc = await addWithConsent(0, consentA ?? null);
  check("add_audio accepts audio recorded under the current consent", rc.accepted === true, rc);
  await q("update public.voice_twins set consent_given_at = now() + interval '1 second' where id = $1", [twinId]);
  rc = await addWithConsent(1, consentA ?? null);
  check("add_audio refuses audio recorded under an earlier consent (no_consent)", rc.accepted === false && rc.reason === "no_consent", rc);
  rc = await addWithConsent(2, null);
  check("… while audio with no consent reference is still judged as before", rc.accepted === true, rc);

  await q(
    `update public.voice_twins set state = 'ready', voice_id = 'db-check-voice-5', voice_source = 'clone', voice_created_at = now() - interval '24 hours',
       voice_expires_at = now() + interval '30 seconds', clone_speech_seconds = 35 where id = $1`,
    [twinId],
  );
  const lastMinute = (await one<{ r: Json }>("select public.voice_twin_expire($1::uuid) as r", [twinId]))?.r ?? {};
  check("voice_twin_expire retires a voice in its final minute", lastMinute.expired === true, lastMinute);

  // 14. Access: service role only.
  section("access");
  const roleRows = await q<{ rolname: string }>("select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')");
  const roles = new Set(roleRows.map((x) => x.rolname));
  check("the Supabase roles exist", roles.size === 3, [...roles]);
  for (const role of ["anon", "authenticated"].filter((x) => roles.has(x))) {
    const select = await one<{ ok: boolean }>("select has_table_privilege($1::name, 'public.voice_twins'::text, 'SELECT'::text) as ok", [role]);
    check(`${role} has no SELECT on voice_twins`, select?.ok === false, select);
    const anyTable = await q<{ t: string }>(
      `select t from unnest($2::text[]) as t
       where has_table_privilege($1::name, 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE'::text)`,
      [role, TABLES],
    );
    check(`${role} has no privileges on any AI Voice Twin table`, anyTable.length === 0, anyTable.map((x) => x.t));
    const anyFunction = await q<{ f: string }>(
      "select f from unnest($2::text[]) as f where has_function_privilege($1::name, f, 'EXECUTE'::text)",
      [role, FUNCTIONS],
    );
    check(`${role} can't execute the AI Voice Twin functions`, anyFunction.length === 0, anyFunction.map((x) => x.f));
  }
  if (roles.has("service_role")) {
    const service = await q<{ name: string }>(
      `select name from unnest($1::text[]) as name
       where not has_table_privilege('service_role'::name, 'public.' || name, 'SELECT, INSERT, UPDATE, DELETE'::text)`,
      [TABLES],
    );
    const serviceFunctions = await q<{ name: string }>(
      "select name from unnest($1::text[]) as name where not has_function_privilege('service_role'::name, name, 'EXECUTE'::text)",
      [FUNCTIONS],
    );
    check("service_role can use every table and function", service.length + serviceFunctions.length === 0, [
      ...service,
      ...serviceFunctions,
    ]);
  }
  const rls = await q<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any($1::text[]) and not c.relrowsecurity`,
    [TABLES],
  );
  check("row level security is on for every AI Voice Twin table", rls.length === 0, rls.map((x) => x.relname));
  const trigger = await one<{ n: number }>(
    `select count(*)::int as n from pg_trigger
     where tgname = 'voice_twins_broadcast_change' and tgrelid = 'public.voice_twins'::regclass and not tgisinternal`,
  );
  check("voice_twins changes are broadcast (voice_twins_broadcast_change trigger)", trigger?.n === 1);
  const bucket = await one<{ public: boolean }>("select public from storage.buckets where id = 'voice-twin'");
  check("the 'voice-twin' Storage bucket exists and is private", bucket?.public === false, bucket);
}

async function main(): Promise<void> {
  const suffix = randomBytes(6).toString("hex");
  console.log("AI Voice Twin database checks (0009 + 0010). Everything runs in one transaction that is rolled back at the end.");
  const client = await connect();
  try {
    await client.query("begin");
    try {
      await runChecks(client, suffix);
    } catch (error) {
      check(`no unexpected errors (${(error as PgError).message ?? String(error)})`, false);
    } finally {
      await client.query("rollback");
    }

    section("cleanup");
    const left = await client.query<{ twins: number; calls: number }>(
      `select (select count(*)::int from public.voice_twins where account_ref = $1) as twins,
              (select count(*)::int from public.calls where twilio_call_sid like $2) as calls`,
      [`db-check-${suffix}`, `CAdbcheck${suffix}%`],
    ).catch(() => null);
    check("rolled back: no test twin or call left behind", left !== null && left.rows[0].twins === 0 && left.rows[0].calls === 0, left?.rows[0]);
  } finally {
    await client.end();
  }

  console.log(`\n${failed ? "✘" : "✔"} ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
