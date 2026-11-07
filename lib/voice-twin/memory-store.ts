import type { VoiceTwinAudioRow, VoiceTwinRow } from "@/lib/types";
import { VOICE_TWIN_ACCOUNT_REF } from "@/lib/voice-twin/config";
import type { VoiceTwinDeps, VoiceTwinVoices } from "@/lib/voice-twin/service";
import { nextTwinState } from "@/lib/voice-twin/state";
import { isCallAudioEligible, isCallOver, type AddAudioResult, type CloneClaim, type MediaBridge, type TwinCallFacts, type VoiceTwinStorage, type VoiceTwinStore } from "@/lib/voice-twin/store";
import type { CreateCloneInput } from "@/lib/voice-twin/elevenlabs";

/**
 * In-memory VoiceTwinStore / VoiceTwinStorage / VoiceTwinVoices with the same semantics as the SQL in 0009 and the
 * state machine in state.ts. Used by the tests (and handy for dry runs); never by the live app.
 */
/** A call row as the twin logic sees it, plus the takeover fields the expiry deferral reads. */
export type MemoryCall = TwinCallFacts & {
  takeover_kind?: string | null;
  handoff_at?: string | null;
  handoff_requested_at?: string | null;
};

export class MemoryVoiceTwin {
  twin: VoiceTwinRow | null = null;
  audio: VoiceTwinAudioRow[] = [];
  objects = new Map<string, Uint8Array>();
  calls = new Map<string, MemoryCall>();
  bridges = new Map<string, MediaBridge>();
  deletionQueue = new Map<string, { voiceId: string; twinId: string | null; attempts: number; reason: string }>();
  consentEvents: { event: "given" | "revoked"; at: string; by: string; userAgent: string | null }[] = [];
  /** ElevenLabs: voices that exist. */
  voices = new Set<string>();
  created: CreateCloneInput[] = [];
  /** What ElevenLabs knows about each voice (for the orphan sweep's search). */
  voiceMeta = new Map<string, { description: string | null; createdAtUnix: number | null }>();
  deleted: string[] = [];
  /** Make the next create() calls fail with this error. */
  createError: Error | null = null;
  requiresVerification = false;
  removeError: Error | null = null;
  clock: number;
  private lastClaimToken: number | null = null;
  private seq = 0;

  constructor(now = Date.parse("2026-11-06T12:00:00.000Z")) {
    this.clock = now;
  }

  private iso(): string {
    return new Date(this.clock).toISOString();
  }

  private id(prefix: string): string {
    this.seq++;
    return `${prefix}-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }

  /** Test helper: an account holder who already consented. */
  withConsent(overrides: Partial<VoiceTwinRow> = {}): this {
    this.twin = {
      ...this.blankTwin(),
      voice_twin_consent: true,
      consent_given_at: this.iso(),
      consent_given_by: "Ben (account holder, Call Guard Settings)",
      consent_text_version: "test",
      ...overrides,
    };
    return this;
  }

  /**
   * Test helper: a call row (live, unflagged by default). By default the customer said a normal line during screening
   * (pass screening_transcript to model voicemail or a call-screening assistant). `takeover_kind` + handoff drive the
   * expiry deferral; a requested/connected call gets handoff_at = now unless given.
   */
  addCall(call: Partial<MemoryCall> & { id: string }): this {
    const handedOver = call.handoff_status === "requested" || call.handoff_status === "connected";
    this.calls.set(call.id, {
      status: "live",
      offered_at: null,
      risk: null,
      handoff_status: "none",
      twilio_call_sid: `CA${call.id.replace(/-/g, "").slice(0, 32)}`,
      started_at: this.iso(),
      screening_transcript: [{ speaker: "customer", text: "Hello, who is this please?", at: this.iso() }],
      handoff_at: handedOver ? this.iso() : null,
      ...call,
    });
    return this;
  }

  /** Test helper: change fields of an existing call (e.g. end it, flag it). */
  updateCall(callId: string, patch: Partial<MemoryCall>): this {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`no call ${callId}`);
    Object.assign(call, patch);
    return this;
  }

  /** Test helper: delete a call row as the database does (0009: voice_twin_audio.call_id is set null). */
  deleteCall(callId: string): this {
    this.calls.delete(callId);
    for (const a of this.audio) if (a.call_id === callId) a.call_id = null;
    return this;
  }

  /** Remove these chunks' seconds from their twin's total (never below 0), as the SQL does when it drops call audio. */
  private subtractSpeech(gone: VoiceTwinAudioRow[]) {
    const t = this.twin;
    if (!t) return;
    const seconds = gone.filter((a) => a.twin_id === t.id).reduce((s, a) => s + a.speech_seconds, 0);
    if (seconds > 0) Object.assign(t, { speech_seconds: Math.max(0, t.speech_seconds - seconds), updated_at: this.iso() });
  }

  private blankTwin(): VoiceTwinRow {
    return {
      id: "77777777-7777-4777-8777-777777777777",
      account_ref: VOICE_TWIN_ACCOUNT_REF,
      voice_twin_consent: false,
      consent_given_at: null,
      consent_given_by: null,
      consent_text_version: null,
      consent_user_agent: null,
      consent_revoked_at: null,
      state: "collecting",
      speech_seconds: 0,
      voice_id: null,
      voice_source: null,
      voice_created_at: null,
      voice_expires_at: null,
      clone_speech_seconds: null,
      clone_error: null,
      cloning_started_at: null,
      last_audio_at: null,
      created_at: this.iso(),
      updated_at: this.iso(),
    };
  }

  /** The SQL consent-gate check constraint, asserted after every write. */
  private assertInvariants() {
    const t = this.twin;
    if (!t) return;
    if (!t.voice_twin_consent && (t.voice_id !== null || t.state !== "collecting" || t.speech_seconds !== 0)) {
      throw new Error("voice_twins_consent_gate violated");
    }
    if (t.state === "ready" && (!t.voice_id || !t.voice_source || !t.voice_expires_at)) throw new Error("voice_twins_ready_has_voice violated");
  }

  readonly store: VoiceTwinStore = {
    getTwin: async () => (this.twin ? { ...this.twin } : null),
    ensureTwin: async () => {
      this.twin ??= this.blankTwin();
      return { ...this.twin };
    },
    giveConsent: async (input) => {
      const t = (this.twin ??= this.blankTwin());
      if (t.voice_twin_consent) return { ...t };
      Object.assign(t, {
        voice_twin_consent: true,
        consent_given_at: this.iso(),
        consent_given_by: input.by,
        consent_text_version: input.textVersion,
        consent_user_agent: input.userAgent,
        state: "collecting",
        clone_error: null,
        updated_at: this.iso(),
      });
      this.consentEvents.push({ event: "given", at: this.iso(), by: input.by, userAgent: input.userAgent });
      this.assertInvariants();
      return { ...t };
    },
    revoke: async (input) => {
      const t = this.twin;
      if (!t) return { previous: null, paths: [] };
      const previous = { ...t };
      const paths = this.audio.filter((a) => a.twin_id === t.id).map((a) => a.storage_path);
      this.audio = this.audio.filter((a) => a.twin_id !== t.id);
      if (t.voice_id && t.voice_source === "clone") this.queue(t.voice_id, t.id, "revoked");
      Object.assign(t, {
        voice_twin_consent: false,
        consent_revoked_at: this.iso(),
        state: nextTwinState(t.state, { type: "revoked" }),
        speech_seconds: 0,
        voice_id: null,
        voice_source: null,
        voice_created_at: null,
        voice_expires_at: null,
        clone_speech_seconds: null,
        clone_error: null,
        cloning_started_at: null,
        updated_at: this.iso(),
      });
      this.consentEvents.push({ event: "revoked", at: this.iso(), by: input.by, userAgent: input.userAgent });
      this.assertInvariants();
      return { previous, paths };
    },
    addAudio: async (input): Promise<AddAudioResult> => {
      const t = this.twin;
      if (!t || t.id !== input.twinId) return { accepted: false, reason: "missing" };
      if (!t.voice_twin_consent) return { accepted: false, reason: "no_consent" };
      if (input.consentAt && input.consentAt !== t.consent_given_at) return { accepted: false, reason: "no_consent" };
      if (nextTwinState(t.state, { type: "audio_added" }) === null) return { accepted: false, reason: "not_collecting", state: t.state };
      if (input.source === "call") {
        const call = input.callId ? this.calls.get(input.callId) : undefined;
        if (!call) return { accepted: false, reason: "missing_call" };
        if (isCallOver(call, this.clock) && !isCallAudioEligible(call)) return { accepted: false, reason: "call_not_flagged" };
      }
      if (this.audio.some((a) => a.storage_path === input.path || (a.twin_id === t.id && a.session_id === input.sessionId && a.seq === input.seq))) {
        return { accepted: true, duplicate: true, speechSeconds: t.speech_seconds, state: t.state };
      }
      this.audio.push({
        id: this.id("aaaaaaaa"),
        twin_id: t.id,
        source: input.source,
        call_id: input.source === "call" ? input.callId : null,
        session_id: input.sessionId,
        seq: input.seq,
        storage_path: input.path,
        mime_type: input.mimeType,
        sample_rate: input.sampleRate,
        speech_seconds: Math.max(0, input.speechSeconds),
        bytes: input.bytes,
        created_at: this.iso(),
      });
      t.speech_seconds += Math.max(0, input.speechSeconds);
      t.last_audio_at = this.iso();
      return { accepted: true, duplicate: false, speechSeconds: t.speech_seconds, state: t.state };
    },
    claimClone: async (twinId, opts): Promise<CloneClaim> => {
      const t = this.twin;
      if (!t || t.id !== twinId) return { claimed: false, reason: "missing" };
      if (!t.voice_twin_consent) return { claimed: false, reason: "no_consent" };
      const stale = t.state === "cloning" && Boolean(t.cloning_started_at) && Date.parse(t.cloning_started_at!) < this.clock - opts.staleSeconds * 1000;
      if (nextTwinState(t.state, { type: "clone_claimed", retry: opts.allowFailed, stale }) === null) {
        return { claimed: false, reason: t.state === "cloning" ? "busy" : "not_collecting", state: t.state };
      }
      const eligible = this.audio.filter((a) => {
        if (a.twin_id !== t.id) return false;
        if (a.source === "sample") return true;
        const call = a.call_id ? this.calls.get(a.call_id) : undefined;
        return Boolean(call && isCallAudioEligible(call));
      });
      const seconds = eligible.reduce((s, a) => s + a.speech_seconds, 0);
      if (seconds < opts.minSeconds) return { claimed: false, reason: "not_enough_audio", eligibleSeconds: seconds };
      // The claim token: a fresh timestamp per claim (like clock_timestamp() in SQL), never reused.
      let token = this.clock;
      if (this.lastClaimToken !== null && token <= this.lastClaimToken) token = this.lastClaimToken + 1;
      this.lastClaimToken = token;
      const claimedAt = new Date(token).toISOString();
      Object.assign(t, { state: "cloning", cloning_started_at: claimedAt, clone_error: null, updated_at: this.iso() });
      return { claimed: true, eligibleSeconds: seconds, audio: eligible.map((a) => ({ ...a })), claimedAt };
    },
    finishClone: async (twinId, input) => {
      const t = this.twin;
      if (!t || t.id !== twinId || t.state !== "cloning" || !t.voice_twin_consent) return null;
      if (input.claimedAt && t.cloning_started_at !== input.claimedAt) return null;
      const next = nextTwinState(t.state, input.voiceSource === "clone" ? { type: "clone_succeeded" } : { type: "clone_failed", fallback: true });
      Object.assign(t, {
        state: next,
        voice_id: input.voiceId,
        voice_source: input.voiceSource,
        voice_created_at: input.createdAt,
        voice_expires_at: input.expiresAt,
        clone_speech_seconds: input.speechSeconds,
        clone_error: null,
        cloning_started_at: null,
        updated_at: this.iso(),
      });
      this.assertInvariants();
      return { ...t };
    },
    failClone: async (twinId, error, claimedAt) => {
      const t = this.twin;
      if (!t || t.id !== twinId || t.state !== "cloning") return null;
      if (claimedAt && t.cloning_started_at !== claimedAt) return null;
      Object.assign(t, {
        state: nextTwinState(t.state, { type: "clone_failed", fallback: false }),
        clone_error: error.slice(0, 500),
        cloning_started_at: null,
        updated_at: this.iso(),
      });
      return { ...t };
    },
    retireVoice: async (twinId, voiceId) => {
      const t = this.twin;
      if (!t || t.id !== twinId || t.voice_id !== voiceId || t.state !== "ready") return false;
      if (!t.voice_expires_at || Date.parse(t.voice_expires_at) > this.clock) t.voice_expires_at = this.iso();
      return true;
    },
    listAudio: async (twinId) => this.audio.filter((a) => a.twin_id === twinId).map((a) => ({ ...a })),
    deleteAudioRows: async (ids) => {
      this.audio = this.audio.filter((a) => !ids.includes(a.id));
    },
    expire: async (twinId) => {
      const t = this.twin;
      // Due from one minute before voice_expires_at (0011).
      if (!t || t.id !== twinId || t.state !== "ready" || !t.voice_expires_at || Date.parse(t.voice_expires_at) > this.clock + 60_000) {
        return { expired: false, reason: "not_due", paths: [] };
      }
      // Bounded deferral (0010): only a twin handover in the last hour, made after this voice was created.
      const since = Math.max(this.clock - 60 * 60 * 1000, t.voice_created_at ? Date.parse(t.voice_created_at) : this.clock - 60 * 60 * 1000);
      const inUse = [...this.calls.values()].some((c) => {
        const at = c.handoff_at ?? c.handoff_requested_at;
        return c.status === "live" && c.takeover_kind === "voice_twin" && ["requested", "connected"].includes(c.handoff_status) && Boolean(at) && Date.parse(at!) > since;
      });
      if (inUse) {
        return { expired: false, reason: "in_use", paths: [] };
      }
      const previous = { ...t };
      if (t.voice_id && t.voice_source === "clone") this.queue(t.voice_id, t.id, "expired");
      const paths = this.audio.filter((a) => a.twin_id === t.id).map((a) => a.storage_path);
      this.audio = this.audio.filter((a) => a.twin_id !== t.id);
      Object.assign(t, {
        state: nextTwinState(t.state, { type: "expired" }),
        speech_seconds: 0,
        voice_id: null,
        voice_source: null,
        voice_created_at: null,
        voice_expires_at: null,
        clone_speech_seconds: null,
        clone_error: null,
        cloning_started_at: null,
        updated_at: this.iso(),
      });
      return { expired: true, previous, paths };
    },
    discardUnflaggedCallAudio: async (callId) => {
      const call = this.calls.get(callId);
      if (call && !isCallOver(call, this.clock)) return { discarded: false, reason: "live", paths: [] };
      if (call && isCallAudioEligible(call)) return { discarded: false, reason: "flagged", paths: [] };
      const gone = this.audio.filter((a) => a.call_id === callId);
      this.audio = this.audio.filter((a) => a.call_id !== callId);
      this.subtractSpeech(gone);
      return { discarded: true, paths: gone.map((a) => a.storage_path) };
    },
    callsWithDiscardableAudio: async () => {
      const ids = [...new Set(this.audio.filter((a) => a.source === "call" && a.call_id).map((a) => a.call_id as string))];
      return ids.filter((id) => {
        const c = this.calls.get(id);
        return !c || (isCallOver(c, this.clock) && !isCallAudioEligible(c));
      });
    },
    deleteOrphanCallAudio: async () => {
      const orphans = this.audio.filter((a) => a.source === "call" && !a.call_id);
      this.audio = this.audio.filter((a) => !(a.source === "call" && !a.call_id));
      this.subtractSpeech(orphans);
      return orphans.map((a) => a.storage_path);
    },
    queueVoiceDeletion: async (voiceId, twinId, reason) => this.queue(voiceId, twinId, reason),
    pendingVoiceDeletions: async () => [...this.deletionQueue.values()].map(({ voiceId, twinId, attempts }) => ({ voiceId, twinId, attempts })),
    voiceDeletionDone: async (voiceId) => {
      this.deletionQueue.delete(voiceId);
    },
    voiceDeletionFailed: async (voiceId) => {
      const q = this.deletionQueue.get(voiceId);
      if (q) q.attempts++;
    },
    getActiveBridge: async (now) => [...this.bridges.values()].find((b) => now - Date.parse(b.seenAt) < 90_000) ?? null,
    heartbeatBridge: async (bridge) => {
      this.bridges.set(bridge.id, { ...bridge, seenAt: this.iso() });
    },
    removeBridge: async (id) => {
      this.bridges.delete(id);
    },
    getCall: async (callId) => {
      const c = this.calls.get(callId);
      return c ? { ...c } : null;
    },
    getCallByTwilioSid: async (sid) => {
      const c = [...this.calls.values()].find((x) => x.twilio_call_sid === sid);
      return c ? { ...c } : null;
    },
  };

  private queue(voiceId: string, twinId: string | null, reason: string) {
    if (!this.deletionQueue.has(voiceId)) this.deletionQueue.set(voiceId, { voiceId, twinId, attempts: 0, reason });
  }

  readonly storage: VoiceTwinStorage = {
    upload: async (path, bytes) => {
      this.objects.set(path, bytes);
    },
    download: async (path) => {
      const bytes = this.objects.get(path);
      if (!bytes) throw new Error(`no object ${path}`);
      return bytes;
    },
    remove: async (paths) => {
      for (const p of paths) this.objects.delete(p);
    },
    listTwinObjects: async (twinId) => [...this.objects.keys()].filter((k) => k.startsWith(`${twinId}/`)),
  };

  readonly elevenlabs: VoiceTwinVoices = {
    create: async (input) => {
      this.created.push(input);
      if (this.createError) throw this.createError;
      const voiceId = `cloned-voice-${this.created.length}`;
      this.voices.add(voiceId);
      this.voiceMeta.set(voiceId, { description: input.description ?? null, createdAtUnix: Math.floor(this.clock / 1000) });
      return { voiceId, requiresVerification: this.requiresVerification };
    },
    remove: async (voiceId) => {
      if (this.removeError) throw this.removeError;
      this.deleted.push(voiceId);
      return this.voices.delete(voiceId) ? "deleted" : "not_found";
    },
    exists: async (voiceId) => this.voices.has(voiceId),
    search: async (text) =>
      [...this.voices]
        .map((voiceId) => ({ voiceId, name: null, ...(this.voiceMeta.get(voiceId) ?? { description: null, createdAtUnix: null }) }))
        .filter((v) => v.description?.includes(text)),
  };

  /** VoiceTwinDeps over this memory state. */
  deps(settings: Partial<{ minSeconds: number; targetSeconds: number; fallbackVoiceId: string | null }> = {}): VoiceTwinDeps {
    return {
      store: this.store,
      storage: this.storage,
      voices: this.elevenlabs,
      settings: () => ({ minSeconds: 30, targetSeconds: 60, fallbackVoiceId: null, ...settings }),
      firstName: () => "Ben",
      now: () => this.clock,
    };
  }
}
