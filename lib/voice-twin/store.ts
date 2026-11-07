import { supabaseAdmin } from "@/lib/supabase/admin";
import type { CallRow, VoiceTwinAudioRow, VoiceTwinRow, VoiceTwinState, VoiceTwinVoiceSource } from "@/lib/types";
import { MEDIA_BRIDGE_FRESH_MS, VOICE_TWIN_ACCOUNT_REF, VOICE_TWIN_BUCKET } from "@/lib/voice-twin/config";

/* ---------- contracts (implemented live below and in memory by lib/voice-twin/memory-store.ts) ---------- */

export interface AddAudioInput {
  twinId: string;
  source: "call" | "sample";
  /** Required for source 'call'. */
  callId: string | null;
  /** Settings recording session id, or the Twilio StreamSid. */
  sessionId: string;
  seq: number;
  path: string;
  mimeType: string;
  sampleRate: number | null;
  speechSeconds: number;
  bytes: number;
  /** The consent_given_at the audio was recorded under; refused (no_consent) if consent was revoked or given again since. */
  consentAt?: string | null;
}

export type AddAudioResult =
  | { accepted: true; duplicate: boolean; speechSeconds: number; state: VoiceTwinState }
  | { accepted: false; reason: "missing" | "no_consent" | "not_collecting" | "missing_call" | "call_not_flagged"; state?: VoiceTwinState };

export type CloneClaim =
  | {
      claimed: true;
      eligibleSeconds: number;
      audio: VoiceTwinAudioRow[];
      /** The claim token (the claim's cloning_started_at): finish/fail only apply while it still matches. */
      claimedAt: string | null;
    }
  | {
      claimed: false;
      reason: "missing" | "no_consent" | "busy" | "not_collecting" | "not_enough_audio";
      eligibleSeconds?: number;
      state?: VoiceTwinState;
    };

export interface FinishCloneInput {
  /** The claim token from claimClone; when set, only the run that made this claim can finish it. */
  claimedAt?: string | null;
  voiceId: string;
  voiceSource: VoiceTwinVoiceSource;
  speechSeconds: number;
  createdAt: string;
  expiresAt: string;
}

export interface MediaBridge {
  id: string;
  publicUrl: string;
  seenAt: string;
}

/** The call fields the twin logic needs (flagged? live?). */
export type TwinCallFacts = Pick<CallRow, "id" | "status" | "offered_at" | "risk" | "handoff_status" | "twilio_call_sid"> &
  Partial<Pick<CallRow, "screening_transcript" | "started_at">>;

/** Call columns the twin logic reads (eligibility needs the screening transcript and the start time). */
const CALL_FACT_COLUMNS = "id, status, offered_at, risk, handoff_status, twilio_call_sid, screening_transcript, started_at";

/** Database side of the AI Voice Twin. Every write that matters is atomic (an RPC or a conditional update). */
export interface VoiceTwinStore {
  /** The account holder's twin row, if any. */
  getTwin(): Promise<VoiceTwinRow | null>;
  /** The account holder's twin row, created (no consent) if missing. */
  ensureTwin(): Promise<VoiceTwinRow>;
  /** Record consent (idempotent: an existing consent keeps its original time) and log a 'given' event. */
  giveConsent(input: { by: string; userAgent: string | null; textVersion: string }): Promise<VoiceTwinRow>;
  /** voice_twin_revoke: consent off, audio rows removed, twin reset, app-made clone queued for deletion. */
  revoke(input: { by: string; userAgent: string | null }): Promise<{ previous: VoiceTwinRow | null; paths: string[] }>;
  /** voice_twin_add_audio (consent gate, state gate, flagged-call gate, idempotent per session+seq). */
  addAudio(input: AddAudioInput): Promise<AddAudioResult>;
  /** voice_twin_claim_clone. */
  claimClone(twinId: string, opts: { minSeconds: number; staleSeconds: number; allowFailed: boolean }): Promise<CloneClaim>;
  /** cloning → ready, only while still cloning with consent. Null when the claim was lost (revoked, expired claim…). */
  finishClone(twinId: string, input: FinishCloneInput): Promise<VoiceTwinRow | null>;
  /** cloning → failed, only while still cloning. */
  failClone(twinId: string, error: string, claimedAt?: string | null): Promise<VoiceTwinRow | null>;
  /** Expire the twin's voice now (voice_twin_retire_voice), e.g. ElevenLabs no longer has it. */
  retireVoice(twinId: string, voiceId: string): Promise<boolean>;
  listAudio(twinId: string): Promise<VoiceTwinAudioRow[]>;
  deleteAudioRows(ids: string[]): Promise<void>;
  /** voice_twin_expire (24 h): ready → collecting, voice queued for deletion. Deferred while a twin call is live. */
  expire(twinId: string): Promise<{ expired: boolean; reason?: string; previous?: VoiceTwinRow; paths: string[] }>;
  /** voice_twin_discard_unflagged_call_audio. */
  discardUnflaggedCallAudio(callId: string): Promise<{ discarded: boolean; reason?: string; paths: string[] }>;
  /** Ended, unflagged calls that still have twin audio. */
  callsWithDiscardableAudio(): Promise<string[]>;
  /** Call audio whose call row is gone (call_id set null): rows deleted, paths returned. */
  deleteOrphanCallAudio(): Promise<string[]>;
  queueVoiceDeletion(voiceId: string, twinId: string | null, reason: "revoked" | "expired" | "orphan"): Promise<void>;
  pendingVoiceDeletions(): Promise<{ voiceId: string; twinId: string | null; attempts: number }[]>;
  voiceDeletionDone(voiceId: string): Promise<void>;
  voiceDeletionFailed(voiceId: string, error: string): Promise<void>;
  /** A media bridge whose heartbeat is fresh, if any. */
  getActiveBridge(now: number): Promise<MediaBridge | null>;
  /** Register/heartbeat a media bridge (services/media-bridge). */
  heartbeatBridge(bridge: { id: string; publicUrl: string }): Promise<void>;
  removeBridge(id: string): Promise<void>;
  getCall(callId: string): Promise<TwinCallFacts | null>;
  getCallByTwilioSid(callSid: string): Promise<TwinCallFacts | null>;
}

/** Raw audio in the private "voice-twin" bucket. */
export interface VoiceTwinStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  download(path: string): Promise<Uint8Array>;
  /** Remove objects (missing ones are fine). */
  remove(paths: string[]): Promise<void>;
  /** Every object under the twin's folder, recursively (a sweep for anything the audio table doesn't know about). */
  listTwinObjects(twinId: string): Promise<string[]>;
}

/* ---------- live implementation (service role) ---------- */

function rpcObject(data: unknown): Record<string, unknown> {
  return (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
}

function paths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
}

export function liveVoiceTwinStore(): VoiceTwinStore {
  const db = supabaseAdmin();
  const twinQuery = () => db.from("voice_twins").select("*").eq("account_ref", VOICE_TWIN_ACCOUNT_REF);

  /** speech_seconds -= seconds (never below 0) as a compare-and-set, so a concurrent voice_twin_add_audio isn't lost. */
  const subtractSpeechSeconds = async (twinId: string, seconds: number): Promise<void> => {
    if (!(seconds > 0)) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await db.from("voice_twins").select("speech_seconds").eq("id", twinId).maybeSingle<{ speech_seconds: number }>();
      if (current.error) throw new Error(current.error.message);
      if (!current.data || current.data.speech_seconds <= 0) return;
      const { data, error } = await db
        .from("voice_twins")
        .update({ speech_seconds: Math.max(0, current.data.speech_seconds - seconds), updated_at: new Date().toISOString() })
        .eq("id", twinId)
        .eq("speech_seconds", current.data.speech_seconds)
        .select("id");
      if (error) throw new Error(error.message);
      if (data?.length) return;
    }
    throw new Error("speech_seconds kept changing");
  };

  const store: VoiceTwinStore = {
    async getTwin() {
      const { data, error } = await twinQuery().maybeSingle<VoiceTwinRow>();
      if (error) throw new Error(`voice twin: could not load: ${error.message}`);
      return data ?? null;
    },

    async ensureTwin() {
      const existing = await store.getTwin();
      if (existing) return existing;
      const { error } = await db
        .from("voice_twins")
        .upsert({ account_ref: VOICE_TWIN_ACCOUNT_REF }, { onConflict: "account_ref", ignoreDuplicates: true });
      if (error) throw new Error(`voice twin: could not create: ${error.message}`);
      const created = await store.getTwin();
      if (!created) throw new Error("voice twin: row missing after create");
      return created;
    },

    async giveConsent(input) {
      const twin = await store.ensureTwin();
      if (twin.voice_twin_consent) return twin;
      const now = new Date().toISOString();
      const { data, error } = await db
        .from("voice_twins")
        .update({
          voice_twin_consent: true,
          consent_given_at: now,
          consent_given_by: input.by,
          consent_text_version: input.textVersion,
          consent_user_agent: input.userAgent?.slice(0, 300) ?? null,
          state: "collecting",
          clone_error: null,
          updated_at: now,
        })
        .eq("id", twin.id)
        .eq("voice_twin_consent", false)
        .select("*")
        .maybeSingle<VoiceTwinRow>();
      if (error) throw new Error(`voice twin: could not save consent: ${error.message}`);
      if (!data) return (await store.getTwin()) ?? twin; // a concurrent consent won
      const { error: logError } = await db.from("voice_twin_consent_events").insert({
        twin_id: twin.id,
        event: "given",
        at: now,
        by: input.by,
        user_agent: input.userAgent?.slice(0, 300) ?? null,
        text_version: input.textVersion,
      });
      if (logError) console.error("voice twin: could not log the consent event", logError.message);
      return data;
    },

    async revoke(input) {
      const twin = await store.getTwin();
      if (!twin) return { previous: null, paths: [] };
      const { data, error } = await db.rpc("voice_twin_revoke", { p_twin_id: twin.id, p_by: input.by, p_user_agent: input.userAgent?.slice(0, 300) ?? null });
      if (error) throw new Error(`voice_twin_revoke failed: ${error.message}`);
      const r = rpcObject(data);
      return { previous: (r.previous as VoiceTwinRow | undefined) ?? twin, paths: paths(r.paths) };
    },

    async addAudio(input) {
      const { data, error } = await db.rpc("voice_twin_add_audio", {
        p_twin_id: input.twinId,
        p_source: input.source,
        p_call_id: input.callId,
        p_session_id: input.sessionId,
        p_seq: input.seq,
        p_path: input.path,
        p_mime: input.mimeType,
        p_sample_rate: input.sampleRate,
        p_seconds: input.speechSeconds,
        p_bytes: input.bytes,
        p_consent_at: input.consentAt ?? null,
      });
      if (error) throw new Error(`voice_twin_add_audio failed: ${error.message}`);
      const r = rpcObject(data);
      if (r.accepted === true) {
        return { accepted: true, duplicate: r.duplicate === true, speechSeconds: Number(r.speech_seconds ?? 0), state: r.state as VoiceTwinState };
      }
      return { accepted: false, reason: (r.reason as Extract<AddAudioResult, { accepted: false }>["reason"]) ?? "missing", state: r.state as VoiceTwinState | undefined };
    },

    async claimClone(twinId, opts) {
      const { data, error } = await db.rpc("voice_twin_claim_clone", {
        p_twin_id: twinId,
        p_min_seconds: opts.minSeconds,
        p_stale_seconds: opts.staleSeconds,
        p_allow_failed: opts.allowFailed,
      });
      if (error) throw new Error(`voice_twin_claim_clone failed: ${error.message}`);
      const r = rpcObject(data);
      if (r.claimed === true) {
        return {
          claimed: true,
          eligibleSeconds: Number(r.eligible_seconds ?? 0),
          audio: (Array.isArray(r.audio) ? r.audio : []) as VoiceTwinAudioRow[],
          claimedAt: typeof r.claimed_at === "string" ? r.claimed_at : null,
        };
      }
      return {
        claimed: false,
        reason: (r.reason as Extract<CloneClaim, { claimed: false }>["reason"]) ?? "missing",
        eligibleSeconds: r.eligible_seconds === undefined ? undefined : Number(r.eligible_seconds),
        state: r.state as VoiceTwinState | undefined,
      };
    },

    async finishClone(twinId, input) {
      let query = db
        .from("voice_twins")
        .update({
          state: "ready",
          voice_id: input.voiceId,
          voice_source: input.voiceSource,
          voice_created_at: input.createdAt,
          voice_expires_at: input.expiresAt,
          clone_speech_seconds: input.speechSeconds,
          clone_error: null,
          cloning_started_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", twinId)
        .eq("state", "cloning")
        .eq("voice_twin_consent", true);
      if (input.claimedAt) query = query.eq("cloning_started_at", input.claimedAt);
      const { data, error } = await query.select("*").maybeSingle<VoiceTwinRow>();
      if (error) throw new Error(`voice twin: could not mark ready: ${error.message}`);
      return data ?? null;
    },

    async failClone(twinId, message, claimedAt) {
      let query = db
        .from("voice_twins")
        .update({ state: "failed", clone_error: message.slice(0, 500), cloning_started_at: null, updated_at: new Date().toISOString() })
        .eq("id", twinId)
        .eq("state", "cloning");
      if (claimedAt) query = query.eq("cloning_started_at", claimedAt);
      const { data, error } = await query.select("*").maybeSingle<VoiceTwinRow>();
      if (error) throw new Error(`voice twin: could not mark failed: ${error.message}`);
      return data ?? null;
    },

    async retireVoice(twinId, voiceId) {
      const { data, error } = await db.rpc("voice_twin_retire_voice", { p_twin_id: twinId, p_voice_id: voiceId });
      if (error) throw new Error(`voice_twin_retire_voice failed: ${error.message}`);
      return data === true;
    },

    async listAudio(twinId) {
      const { data, error } = await db.from("voice_twin_audio").select("*").eq("twin_id", twinId).order("created_at").order("seq");
      if (error) throw new Error(`voice twin: could not list audio: ${error.message}`);
      return (data ?? []) as VoiceTwinAudioRow[];
    },

    async deleteAudioRows(ids) {
      if (!ids.length) return;
      const { error } = await db.from("voice_twin_audio").delete().in("id", ids);
      if (error) throw new Error(`voice twin: could not delete audio rows: ${error.message}`);
    },

    async expire(twinId) {
      const { data, error } = await db.rpc("voice_twin_expire", { p_twin_id: twinId });
      if (error) throw new Error(`voice_twin_expire failed: ${error.message}`);
      const r = rpcObject(data);
      return { expired: r.expired === true, reason: r.reason as string | undefined, previous: r.previous as VoiceTwinRow | undefined, paths: paths(r.paths) };
    },

    async discardUnflaggedCallAudio(callId) {
      const { data, error } = await db.rpc("voice_twin_discard_unflagged_call_audio", { p_call_id: callId });
      if (error) throw new Error(`voice_twin_discard_unflagged_call_audio failed: ${error.message}`);
      const r = rpcObject(data);
      return { discarded: r.discarded === true, reason: r.reason as string | undefined, paths: paths(r.paths) };
    },

    async callsWithDiscardableAudio() {
      const { data, error } = await db.from("voice_twin_audio").select("call_id").eq("source", "call").not("call_id", "is", null).limit(500);
      if (error) throw new Error(`voice twin: could not list call audio: ${error.message}`);
      const ids = [...new Set((data ?? []).map((r: { call_id: string | null }) => r.call_id).filter((v): v is string => Boolean(v)))];
      if (!ids.length) return [];
      const calls = await db.from("calls").select(CALL_FACT_COLUMNS).in("id", ids);
      if (calls.error) throw new Error(`voice twin: could not load calls: ${calls.error.message}`);
      const known = new Map((calls.data ?? []).map((c) => [c.id as string, c as TwinCallFacts]));
      const now = Date.now();
      return ids.filter((id) => {
        const c = known.get(id);
        return !c || (isCallOver(c, now) && !isCallAudioEligible(c));
      });
    },

    async deleteOrphanCallAudio() {
      const { data, error } = await db
        .from("voice_twin_audio")
        .delete()
        .eq("source", "call")
        .is("call_id", null)
        .select("storage_path, twin_id, speech_seconds");
      if (error) throw new Error(`voice twin: could not delete orphan audio: ${error.message}`);
      const rows = (data ?? []) as Pick<VoiceTwinAudioRow, "storage_path" | "twin_id" | "speech_seconds">[];
      // Their seconds come off the twin's total too (as voice_twin_discard_unflagged_call_audio does for a call that
      // ended unflagged), or the progress bar would count speech that no longer exists.
      const perTwin = new Map<string, number>();
      for (const r of rows) perTwin.set(r.twin_id, (perTwin.get(r.twin_id) ?? 0) + Math.max(0, Number(r.speech_seconds) || 0));
      for (const [twinId, seconds] of perTwin) {
        await subtractSpeechSeconds(twinId, seconds).catch((e) => console.error(`voice twin ${twinId}: could not subtract orphaned seconds`, e));
      }
      return rows.map((r) => r.storage_path);
    },

    async queueVoiceDeletion(voiceId, twinId, reason) {
      const { error } = await db
        .from("voice_twin_voice_deletions")
        .upsert({ voice_id: voiceId, twin_id: twinId, reason }, { onConflict: "voice_id", ignoreDuplicates: true });
      if (error) throw new Error(`voice twin: could not queue voice deletion: ${error.message}`);
    },

    async pendingVoiceDeletions() {
      const { data, error } = await db.from("voice_twin_voice_deletions").select("voice_id, twin_id, attempts").order("created_at").limit(20);
      if (error) throw new Error(`voice twin: could not list voice deletions: ${error.message}`);
      return (data ?? []).map((r: { voice_id: string; twin_id: string | null; attempts: number }) => ({ voiceId: r.voice_id, twinId: r.twin_id, attempts: r.attempts }));
    },

    async voiceDeletionDone(voiceId) {
      const { error } = await db.from("voice_twin_voice_deletions").delete().eq("voice_id", voiceId);
      if (error) throw new Error(`voice twin: could not clear voice deletion: ${error.message}`);
    },

    async voiceDeletionFailed(voiceId, message) {
      const { data } = await db.from("voice_twin_voice_deletions").select("attempts").eq("voice_id", voiceId).maybeSingle<{ attempts: number }>();
      await db
        .from("voice_twin_voice_deletions")
        .update({ attempts: (data?.attempts ?? 0) + 1, last_error: message.slice(0, 500), last_try_at: new Date().toISOString() })
        .eq("voice_id", voiceId);
    },

    // Freshness is judged on the database clock (0010), so a bridge laptop whose clock is off doesn't matter.
    async getActiveBridge() {
      const { data, error } = await db.rpc("active_media_bridge", { p_fresh_seconds: Math.round(MEDIA_BRIDGE_FRESH_MS / 1000) });
      if (error) throw new Error(`media bridge lookup failed: ${error.message}`);
      const row = ((Array.isArray(data) ? data : data ? [data] : []) as { id: string; public_url: string; seen_at: string }[])[0];
      return row ? { id: row.id, publicUrl: row.public_url, seenAt: row.seen_at } : null;
    },

    async heartbeatBridge(bridge) {
      const { error } = await db.rpc("media_bridge_heartbeat", { p_id: bridge.id, p_url: bridge.publicUrl });
      if (error) throw new Error(`media bridge heartbeat failed: ${error.message}`);
    },

    async removeBridge(id) {
      await db.from("media_bridges").delete().eq("id", id);
    },

    async getCall(callId) {
      const { data, error } = await db.from("calls").select(CALL_FACT_COLUMNS).eq("id", callId).maybeSingle<TwinCallFacts>();
      if (error) throw new Error(`voice twin: could not load call: ${error.message}`);
      return data ?? null;
    },

    async getCallByTwilioSid(callSid) {
      const { data, error } = await db
        .from("calls")
        .select(CALL_FACT_COLUMNS)
        .eq("twilio_call_sid", callSid)
        .maybeSingle<TwinCallFacts>();
      if (error) throw new Error(`voice twin: could not load call: ${error.message}`);
      return data ?? null;
    },
  };
  return store;
}

/** Mirrors SQL call_is_flagged (0009): offered, threshold crossed, or handed over / declined at some point. */
export function isCallFlagged(call: Pick<CallRow, "offered_at" | "risk" | "handoff_status">): boolean {
  return (
    Boolean(call.offered_at) ||
    Boolean(call.risk?.threshold_crossed_at) ||
    ["offered", "declined", "requested", "connected", "failed"].includes(call.handoff_status)
  );
}

/**
 * Mirrors SQL call_has_customer_speech (0011): the customer said at least one 3+ word line, and their first two lines
 * (where a voicemail greeting or a phone's call-screening assistant would speak) carry no voicemail/screening marker.
 * Curly apostrophes are normalised first. Ordinary phrases a real customer says ("who's calling?", "not available",
 * "I got a voicemail…") are deliberately not markers.
 */
const NOT_THE_CUSTOMER =
  /(leave (a|your) (message|name)|after the (tone|beep)|(person|number|subscriber|customer) (you|you're|you are|you've|you have) (calling|called|dialled|dialed|trying)|record your (name|message)|(voice ?mail|mailbox) (service|box|is full)|screening (service|assistant)|call (assistant|screen)|is using a (call )?screening|(cannot|can't|unable to) (take|answer) (your|the) call|can't come to the phone|(welcome to|you have reached|you've reached) .{0,40}(voice ?mail|mailbox|answer ?phone)|number you have dialled|(say|state|tell me) your name and)/i;

export function hasCustomerSpeech(call: Partial<Pick<CallRow, "screening_transcript">>): boolean {
  const customer = (call.screening_transcript ?? []).filter((s) => s.speaker === "customer").map((s) => (s.text ?? "").replace(/[’‘]/g, "'"));
  return customer.some((t) => t.trim().split(/\s+/).filter(Boolean).length >= 3) && !customer.slice(0, 2).some((t) => NOT_THE_CUSTOMER.test(t));
}

/** Mirrors SQL call_audio_eligible (0010): flagged, and the customer really spoke. */
export function isCallAudioEligible(call: Pick<CallRow, "offered_at" | "risk" | "handoff_status"> & Partial<Pick<CallRow, "screening_transcript">>): boolean {
  return isCallFlagged(call) && hasCustomerSpeech(call);
}

/** Mirrors SQL call_is_over (0010): ended, or 'live' for more than 6 hours (its end was never recorded). */
export function isCallOver(call: Pick<CallRow, "status"> & Partial<Pick<CallRow, "started_at">>, now: number): boolean {
  if (call.status === "ended") return true;
  const started = call.started_at ? Date.parse(call.started_at) : NaN;
  return Number.isFinite(started) && started < now - 6 * 60 * 60 * 1000;
}

export function liveVoiceTwinStorage(): VoiceTwinStorage {
  const bucket = () => supabaseAdmin().storage.from(VOICE_TWIN_BUCKET);
  const storage: VoiceTwinStorage = {
    async upload(path, bytes, contentType) {
      const { error } = await bucket().upload(path, bytes, { contentType, upsert: true, cacheControl: "no-store" });
      if (error) throw new Error(`voice twin: upload ${path} failed: ${error.message}`);
    },
    async download(path) {
      const { data, error } = await bucket().download(path);
      if (error || !data) throw new Error(`voice twin: download ${path} failed: ${error?.message ?? "no data"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    async remove(list) {
      const unique = [...new Set(list.filter(Boolean))];
      for (let i = 0; i < unique.length; i += 100) {
        const { error } = await bucket().remove(unique.slice(i, i + 100));
        if (error) throw new Error(`voice twin: could not delete audio: ${error.message}`);
      }
    },
    async listTwinObjects(twinId) {
      const found: string[] = [];
      const walk = async (prefix: string, depth: number): Promise<void> => {
        if (depth > 4) return;
        for (let offset = 0; ; offset += 100) {
          const { data, error } = await bucket().list(prefix, { limit: 100, offset });
          if (error) throw new Error(`voice twin: could not list ${prefix}: ${error.message}`);
          for (const entry of data ?? []) {
            const full = `${prefix}/${entry.name}`;
            if (entry.id) found.push(full);
            else await walk(full, depth + 1); // a folder
          }
          if (!data || data.length < 100) break;
        }
      };
      await walk(twinId, 0);
      return found;
    },
  };
  return storage;
}
