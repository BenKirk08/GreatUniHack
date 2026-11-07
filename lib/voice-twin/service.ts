import { serverEnv } from "@/lib/env";
import type { VoiceTwinAudioRow, VoiceTwinRow, VoiceTwinVoiceSource } from "@/lib/types";
import {
  VOICE_TWIN_CLONE_TTL_MS,
  VOICE_TWIN_CONSENT_VERSION,
  VOICE_TWIN_STALE_CLONING_SECONDS,
  voiceTwinSettings,
  type VoiceTwinSettings,
} from "@/lib/voice-twin/config";
import {
  createInstantVoiceClone,
  deleteVoice,
  searchPersonalVoices,
  voiceExists,
  type CreateCloneInput,
  type CreatedClone,
  type ListedVoice,
} from "@/lib/voice-twin/elevenlabs";
import { liveVoiceTwinStorage, liveVoiceTwinStore, type AddAudioResult, type VoiceTwinStorage, type VoiceTwinStore } from "@/lib/voice-twin/store";
import { customerTwinView, type CustomerTwinView } from "@/lib/voice-twin/view";
import { mergeWavs, normaliseWavLoudness } from "@/lib/voice-twin/wav";

/**
 * The AI Voice Twin's server logic. Every entry point re-checks consent; nothing is captured, stored or cloned for an
 * account holder whose voice_twin_consent is false (and the database refuses it too: see 0009).
 */

/** The ElevenLabs side, injectable for tests. */
export interface VoiceTwinVoices {
  create(input: CreateCloneInput): Promise<CreatedClone>;
  remove(voiceId: string): Promise<"deleted" | "not_found">;
  /** true / false, or null when it couldn't be checked. */
  exists(voiceId: string): Promise<boolean | null>;
  /** Voices at ElevenLabs whose name/description mention this text (the orphan sweep searches `twin:<id>`). */
  search?(text: string): Promise<ListedVoice[]>;
}

export interface VoiceTwinDeps {
  store: VoiceTwinStore;
  storage: VoiceTwinStorage;
  voices: VoiceTwinVoices;
  settings(): VoiceTwinSettings;
  /** The account holder's first name (CUSTOMER_FIRST_NAME). */
  firstName(): string;
  now(): number;
}

export function liveVoiceTwinDeps(): VoiceTwinDeps {
  return {
    store: liveVoiceTwinStore(),
    storage: liveVoiceTwinStorage(),
    voices: {
      create: (input) => createInstantVoiceClone(serverEnv().ELEVENLABS_API_KEY, input),
      remove: (voiceId) => deleteVoice(serverEnv().ELEVENLABS_API_KEY, voiceId),
      exists: (voiceId) => voiceExists(serverEnv().ELEVENLABS_API_KEY, voiceId),
      search: (text) => searchPersonalVoices(serverEnv().ELEVENLABS_API_KEY, text),
    },
    settings: voiceTwinSettings,
    firstName: () => serverEnv().CUSTOMER_FIRST_NAME,
    now: () => Date.now(),
  };
}

/* ---------- reading ---------- */

export async function getCustomerTwinView(deps: VoiceTwinDeps = liveVoiceTwinDeps()): Promise<CustomerTwinView> {
  const [row, bridge] = await Promise.all([
    deps.store.getTwin(),
    // Only relevant once consented; a lookup failure just reads as "not recording during calls".
    deps.store.getActiveBridge(deps.now()).catch(() => null),
  ]);
  return customerTwinView(row, deps.settings(), deps.now(), { bridgeOnline: Boolean(bridge) });
}

/* ---------- consent ---------- */

/** "Name (account holder, Call Guard Settings)": who consented, as stored with the consent. */
export function consentedByLabel(firstName: string): string {
  return `${firstName.trim() || "Account holder"} (account holder, Call Guard Settings)`;
}

/** Record the account holder's consent (only ever from the Settings screen, after they tick the box). */
export async function giveConsent(input: { userAgent: string | null }, deps: VoiceTwinDeps = liveVoiceTwinDeps()): Promise<VoiceTwinRow> {
  // Without consent the twin holds no audio rows (0009), so anything still in its folder is left over from a revoke whose
  // deletion failed: delete it before new recordings can start, so it can never be mistaken for the new consent's audio.
  const before = await deps.store.getTwin();
  if (before && !before.voice_twin_consent) {
    try {
      const leftovers = await deps.storage.listTwinObjects(before.id);
      if (leftovers.length) await deps.storage.remove(leftovers);
    } catch (error) {
      console.error("voice twin: could not clear leftover recordings before consent", error);
    }
  }
  return deps.store.giveConsent({ by: consentedByLabel(deps.firstName()), userAgent: input.userAgent, textVersion: VOICE_TWIN_CONSENT_VERSION });
}

export interface RevokeResult {
  /** Audio objects deleted from Storage. */
  audioDeleted: number;
  /** What happened to the ElevenLabs voice. 'fallback_kept': the twin used VOICE_TWIN_FALLBACK_VOICE_ID (made by hand). */
  voice: "deleted" | "not_found" | "none" | "fallback_kept" | "failed";
  /** Plain-language problem, if the voice or some audio couldn't be deleted yet (housekeeping retries). */
  problem: string | null;
}

/**
 * Revoke & delete: consent off, every stored recording deleted (the audio table's paths plus a sweep of the twin's
 * folder), and the app-made ElevenLabs voice deleted through the API (queued and retried if the API call fails).
 */
export async function revokeAndDelete(
  input: { userAgent: string | null },
  deps: VoiceTwinDeps = liveVoiceTwinDeps(),
  opts: { sweepOrphans?: boolean } = {},
): Promise<RevokeResult> {
  const { previous, paths } = await deps.store.revoke({ by: consentedByLabel(deps.firstName()), userAgent: input.userAgent });
  let problem: string | null = null;
  let audioDeleted = 0;
  if (previous) {
    try {
      const swept = await deps.storage.listTwinObjects(previous.id);
      const all = [...new Set([...paths, ...swept])];
      if (all.length) await deps.storage.remove(all);
      audioDeleted = all.length;
    } catch (error) {
      console.error("voice twin revoke: deleting audio failed", error);
      problem = "Some recordings couldn't be deleted yet. They will be deleted automatically shortly.";
    }
  }

  let voice: RevokeResult["voice"] = "none";
  if (previous?.voice_id && previous.voice_source === "fallback") {
    voice = "fallback_kept";
  } else if (previous?.voice_id) {
    const outcome = await deleteQueuedVoice(previous.voice_id, deps);
    voice = outcome === "failed" ? "failed" : outcome;
    if (outcome === "failed") problem = "Your AI Voice Twin couldn't be deleted at ElevenLabs yet. We'll keep trying automatically.";
  }
  // A clone that was mid-creation is deleted by its own run when it finds the claim gone; any clone of this twin that
  // was never recorded (a killed or timed-out run) is found by its twin tag and deleted here.
  // (The revoke route passes sweepOrphans: false and runs sweepAfterRevoke in after(), so the customer doesn't wait on
  // an ElevenLabs search.)
  if (previous && opts.sweepOrphans !== false) await sweepAfterRevoke(previous.id, previous.voice_id, deps);
  return { audioDeleted, voice, problem };
}

/** Delete this twin's orphaned clones after a revoke, skipping the voice the revoke itself handled. Never throws. */
export async function sweepAfterRevoke(twinId: string, revokedVoiceId: string | null, deps: VoiceTwinDeps = liveVoiceTwinDeps()): Promise<number> {
  return sweepOrphanVoices(twinId, null, deps, [revokedVoiceId]).catch((e) => {
    console.error("voice twin revoke: orphan sweep failed", e);
    return 0;
  });
}

/* ---------- audio ---------- */

/** Storage path of one chunk: <twin>/<source>/<session>/<seq>.wav */
export function audioPath(twinId: string, source: "call" | "sample", sessionId: string, seq: number): string {
  const session = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "session";
  return `${twinId}/${source}/${session}/${String(seq).padStart(5, "0")}.wav`;
}

export interface StoreChunkInput {
  source: "call" | "sample";
  callId: string | null;
  sessionId: string;
  seq: number;
  /** A complete PCM16 WAV file. */
  wav: Uint8Array;
  sampleRate: number;
  /** Clean speech in this chunk (counted by the VAD). */
  speechSeconds: number;
  /**
   * Call audio: the consent_given_at the stream was started under (from its stream token). The chunk is refused if
   * the account holder has revoked or re-consented since, so audio captured under one consent is never stored under
   * the next.
   */
  consentAt?: string | null;
}

export type StoreChunkResult =
  | { stored: true; duplicate: boolean; speechSeconds: number; twin: VoiceTwinRow }
  | { stored: false; reason: Extract<AddAudioResult, { accepted: false }>["reason"] | "no_twin" };

/**
 * Store one chunk of the account holder's speech. The consent gate runs before anything is written; the database
 * re-checks it (and the state) when the chunk is registered, and the object is deleted again if it refuses.
 */
export async function storeAudioChunk(input: StoreChunkInput, deps: VoiceTwinDeps = liveVoiceTwinDeps()): Promise<StoreChunkResult> {
  let twin = await deps.store.getTwin();
  if (!twin) return { stored: false, reason: "no_twin" };
  if (!twin.voice_twin_consent) return { stored: false, reason: "no_consent" };
  if (input.consentAt !== undefined && input.consentAt !== twin.consent_given_at) return { stored: false, reason: "no_consent" };
  if (twin.state === "ready" && twin.voice_expires_at && Date.parse(twin.voice_expires_at) - deps.now() < 60_000) {
    // The voice is in its final minute (already "expired" for the customer): retire it now so this audio counts.
    const expired = await deps.store.expire(twin.id);
    if (expired.paths.length) await deps.storage.remove(expired.paths).catch((e) => console.error("voice twin: expire cleanup failed", e));
    twin = (await deps.store.getTwin()) ?? twin;
  }
  if (twin.state !== "collecting" && twin.state !== "failed") return { stored: false, reason: "not_collecting" };
  if (input.source === "call" && !input.callId) return { stored: false, reason: "missing_call" };

  const path = audioPath(twin.id, input.source, input.sessionId, input.seq);
  await deps.storage.upload(path, input.wav, "audio/wav");
  let result: AddAudioResult;
  try {
    result = await deps.store.addAudio({
      twinId: twin.id,
      source: input.source,
      callId: input.source === "call" ? input.callId : null,
      sessionId: input.sessionId,
      seq: input.seq,
      path,
      mimeType: "audio/wav",
      sampleRate: input.sampleRate,
      speechSeconds: Math.max(0, input.speechSeconds),
      bytes: input.wav.byteLength,
      consentAt: input.consentAt,
    });
  } catch (error) {
    await deps.storage.remove([path]).catch(() => undefined);
    throw error;
  }
  if (!result.accepted) {
    await deps.storage.remove([path]).catch((e) => console.error(`voice twin: could not delete refused chunk ${path}`, e));
    return { stored: false, reason: result.reason };
  }
  return { stored: true, duplicate: result.duplicate, speechSeconds: result.speechSeconds, twin: { ...twin, speech_seconds: result.speechSeconds } };
}

/** At the end of a call that was never flagged: delete its audio (the consent covers flagged calls only). */
export async function discardUnflaggedCallAudio(callId: string, deps: VoiceTwinDeps = liveVoiceTwinDeps()): Promise<number> {
  const result = await deps.store.discardUnflaggedCallAudio(callId);
  if (result.discarded && result.paths.length) await deps.storage.remove(result.paths);
  return result.discarded ? result.paths.length : 0;
}

/* ---------- cloning ---------- */

export type CloneOutcome =
  | { outcome: "ready"; voiceSource: VoiceTwinVoiceSource; voiceId: string; speechSeconds: number }
  | { outcome: "failed"; error: string }
  | { outcome: "discarded"; reason: string }
  | { outcome: "skipped"; reason: string };

/**
 * Clone in the background as soon as there is enough eligible speech: claim (collecting → cloning, atomic, consent
 * and VOICE_TWIN_MIN_SECONDS checked in SQL), then run. `allowFailed` is the Settings "Try again".
 */
export async function maybeStartClone(opts: { allowFailed?: boolean } = {}, deps: VoiceTwinDeps = liveVoiceTwinDeps()): Promise<CloneOutcome> {
  const twin = await deps.store.getTwin();
  if (!twin || !twin.voice_twin_consent) return { outcome: "skipped", reason: "no_consent" };
  const settings = deps.settings();
  if (twin.state === "collecting" && twin.speech_seconds < settings.minSeconds) return { outcome: "skipped", reason: "not_enough_audio" };
  const claim = await deps.store.claimClone(twin.id, {
    minSeconds: settings.minSeconds,
    staleSeconds: VOICE_TWIN_STALE_CLONING_SECONDS,
    allowFailed: Boolean(opts.allowFailed),
  });
  if (!claim.claimed) return { outcome: "skipped", reason: claim.reason };
  return runClone(twin, claim.audio, claim.eligibleSeconds, claim.claimedAt, deps);
}

async function runClone(
  twin: VoiceTwinRow,
  audio: VoiceTwinAudioRow[],
  eligibleSeconds: number,
  claimedAt: string | null,
  deps: VoiceTwinDeps,
): Promise<CloneOutcome> {
  const settings = deps.settings();
  const createdAt = new Date(deps.now());
  const expiresAt = new Date(createdAt.getTime() + VOICE_TWIN_CLONE_TTL_MS);
  const speechSeconds = Math.round(eligibleSeconds * 10) / 10;

  let voiceId: string | null = null;
  let failure: string | null = null;
  try {
    const wavs: Uint8Array[] = [];
    for (const chunk of audio) wavs.push(await deps.storage.download(chunk.storage_path));
    const files = mergeWavs(wavs).map((bytes, i) => ({
      filename: `voice-twin-${i + 1}.wav`,
      // Levelled once over the whole merged file (one gain, so its levels stay as consistent as they were recorded;
      // near-silence is left as it is), never chunk by chunk.
      bytes: normaliseWavLoudness(bytes),
      contentType: "audio/wav",
    }));
    if (!files.length) throw new Error("no usable audio");
    const first = deps.firstName().trim() || "Account holder";
    const created = await deps.voices.create({
      name: `AI Voice Twin – ${first} (${twin.id.slice(0, 8)})`.slice(0, 100),
      description:
        `AI Voice Twin of the consenting Call Guard account holder (consent ${twin.consent_given_at ?? "unknown"}). ` +
        `Used only in flagged-scam handovers; deleted automatically 24 h after creation. twin:${twin.id}`,
      labels: { language: "en" },
      files,
      removeBackgroundNoise: false,
    });
    if (created.requiresVerification) {
      await deleteQueuedVoice(created.voiceId, deps, "orphan");
      throw new Error("ElevenLabs asked for voice verification, so the clone can't be used");
    }
    voiceId = created.voiceId;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error(`voice twin ${twin.id}: cloning failed`, error);
  }

  const source: VoiceTwinVoiceSource | null = voiceId ? "clone" : settings.fallbackVoiceId ? "fallback" : null;
  if (!source) {
    await deps.store.failClone(twin.id, failure ?? "unknown error", claimedAt);
    return { outcome: "failed", error: failure ?? "unknown error" };
  }
  const finalVoiceId = voiceId ?? (settings.fallbackVoiceId as string);
  const ready = await deps.store.finishClone(twin.id, {
    claimedAt,
    voiceId: finalVoiceId,
    voiceSource: source,
    speechSeconds,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  if (!ready) {
    // Consent was revoked (or the claim was lost) while we were cloning: the new voice must not survive.
    if (voiceId) await deleteQueuedVoice(voiceId, deps, "orphan");
    return { outcome: "discarded", reason: "the claim was lost (revoked or superseded) while cloning" };
  }
  if (failure) console.warn(`voice twin ${twin.id}: clone failed (${failure}); using VOICE_TWIN_FALLBACK_VOICE_ID`);

  // The raw audio has done its job: delete it (rows and objects, including anything the table doesn't know about).
  try {
    const rows = await deps.store.listAudio(twin.id);
    const swept = await deps.storage.listTwinObjects(twin.id);
    await deps.storage.remove([...new Set([...rows.map((r) => r.storage_path), ...swept])]);
    await deps.store.deleteAudioRows(rows.map((r) => r.id));
  } catch (error) {
    console.error(`voice twin ${twin.id}: could not delete raw audio after cloning (housekeeping retries)`, error);
  }
  return { outcome: "ready", voiceSource: source, voiceId: finalVoiceId, speechSeconds };
}

/* ---------- ElevenLabs voice deletion (queued, retried) ---------- */

async function deleteQueuedVoice(
  voiceId: string,
  deps: VoiceTwinDeps,
  queueReason?: "revoked" | "expired" | "orphan",
): Promise<"deleted" | "not_found" | "failed"> {
  if (voiceId === deps.settings().fallbackVoiceId) {
    // Never delete the hand-made fallback voice, but don't leave it in the queue to be retried forever either.
    await deps.store.voiceDeletionDone(voiceId).catch((e) => console.error("voice twin: could not clear the queue entry", e));
    return "not_found";
  }
  if (queueReason) await deps.store.queueVoiceDeletion(voiceId, null, queueReason).catch((e) => console.error("voice twin: queue failed", e));
  try {
    const outcome = await deps.voices.remove(voiceId);
    await deps.store.voiceDeletionDone(voiceId);
    return outcome;
  } catch (error) {
    console.error(`voice twin: deleting voice ${voiceId} failed`, error);
    await deps.store.voiceDeletionFailed(voiceId, error instanceof Error ? error.message : String(error)).catch(() => undefined);
    return "failed";
  }
}

/* ---------- orphan voices ---------- */

/** The orphan sweep talks to ElevenLabs, so housekeeping runs it at most this often per process (revoke always does). */
const ORPHAN_SWEEP_EVERY_MS = 30 * 60 * 1000;
let lastOrphanSweep = 0;

/**
 * Delete this twin's clones that the app doesn't hold: every voice whose description carries `twin:<id>` (only ever
 * written by runClone) other than the twin's current voice and the hand-made fallback. While a clone run may still be
 * in flight (state 'cloning'), voices younger than the stale-claim window are left alone so its voice isn't deleted
 * before it is recorded. Returns how many were deleted.
 */
export async function sweepOrphanVoices(
  twinId: string,
  twin: VoiceTwinRow | null,
  deps: VoiceTwinDeps,
  skip: (string | null | undefined)[] = [],
): Promise<number> {
  if (!deps.voices.search) return 0;
  const tag = `twin:${twinId}`;
  const keep = new Set([twin?.voice_id, deps.settings().fallbackVoiceId, ...skip].filter((v): v is string => Boolean(v)));
  const youngMs = (VOICE_TWIN_STALE_CLONING_SECONDS + 60) * 1000;
  let deleted = 0;
  for (const v of await deps.voices.search(tag)) {
    if (!v.description?.includes(tag) || keep.has(v.voiceId)) continue;
    const young = v.createdAtUnix === null || deps.now() - v.createdAtUnix * 1000 < youngMs;
    if (twin?.state === "cloning" && young) continue;
    if ((await deleteQueuedVoice(v.voiceId, deps, "orphan")) !== "failed") deleted++;
  }
  return deleted;
}

/* ---------- housekeeping (cron, lazy on reads, and the media bridge's timer) ---------- */

export interface HousekeepingSummary {
  expired: boolean;
  voicesDeleted: number;
  discardedChunks: number;
  clone: CloneOutcome | null;
}

/**
 * Keep the promises the consent screen makes: retire the voice 24 h after creation, retry voice deletions, discard
 * audio from calls that ended unflagged, and start a clone that is due (e.g. a Settings sample whose last chunk never
 * said "final"). Safe to run concurrently and often.
 */
export async function voiceTwinHousekeeping(
  deps: VoiceTwinDeps = liveVoiceTwinDeps(),
  opts: { idleMs?: number; sweepVoices?: boolean } = {},
): Promise<HousekeepingSummary> {
  const summary: HousekeepingSummary = { expired: false, voicesDeleted: 0, discardedChunks: 0, clone: null };
  const twin = await deps.store.getTwin();

  if (twin?.state === "ready" && twin.voice_expires_at && Date.parse(twin.voice_expires_at) - deps.now() < 60_000) {
    const result = await deps.store.expire(twin.id);
    summary.expired = result.expired;
    if (result.paths.length) await deps.storage.remove(result.paths).catch((e) => console.error("voice twin: expire cleanup failed", e));
  }

  for (const pending of await deps.store.pendingVoiceDeletions()) {
    if ((await deleteQueuedVoice(pending.voiceId, deps)) !== "failed") summary.voicesDeleted++;
  }

  for (const callId of await deps.store.callsWithDiscardableAudio()) {
    summary.discardedChunks += await discardUnflaggedCallAudio(callId, deps).catch((e) => {
      console.error(`voice twin: discarding audio of call ${callId} failed`, e);
      return 0;
    });
  }
  const orphans = await deps.store.deleteOrphanCallAudio();
  if (orphans.length) {
    await deps.storage.remove(orphans).catch((e) => console.error("voice twin: orphan cleanup failed", e));
    summary.discardedChunks += orphans.length;
  }

  // A revoked twin holds no audio at all. If deleting it at revoke time failed (the customer was told it would be
  // deleted automatically shortly), the audio rows are already gone, so sweep the twin's folder until it is empty.
  if (twin && !twin.voice_twin_consent && twin.consent_revoked_at) {
    try {
      const leftovers = await deps.storage.listTwinObjects(twin.id);
      // Re-check: if consent was given again in the meantime, these may be new chunks.
      if (leftovers.length && !(await deps.store.getTwin())?.voice_twin_consent) {
        await deps.storage.remove(leftovers);
        summary.discardedChunks += leftovers.length;
      }
    } catch (error) {
      console.error("voice twin: sweeping a revoked twin's audio failed", error);
    }
  }

  // A ready twin needs no raw audio: retry any deletion that failed right after cloning.
  const current = twin ? await deps.store.getTwin() : null;
  if (current?.state === "ready") {
    try {
      const rows = await deps.store.listAudio(current.id);
      const objects = await deps.storage.listTwinObjects(current.id);
      const all = [...new Set([...rows.map((r) => r.storage_path), ...objects])];
      if (all.length) {
        await deps.storage.remove(all);
        await deps.store.deleteAudioRows(rows.map((r) => r.id));
        summary.discardedChunks += all.length;
      }
    } catch (error) {
      console.error("voice twin: deleting leftover raw audio failed", error);
    }
  }

  // Clones ElevenLabs made for this twin that the app never recorded (a run killed or timed out after creating one).
  if (twin && (opts.sweepVoices ?? deps.now() - lastOrphanSweep >= ORPHAN_SWEEP_EVERY_MS)) {
    lastOrphanSweep = deps.now();
    summary.voicesDeleted += await sweepOrphanVoices(twin.id, current ?? twin, deps).catch((e) => {
      console.error("voice twin: orphan voice sweep failed", e);
      return 0;
    });
  }

  const idleMs = opts.idleMs ?? 20_000;
  const fresh = twin ? await deps.store.getTwin() : null;
  if (fresh?.voice_twin_consent) {
    const idle = !fresh.last_audio_at || deps.now() - Date.parse(fresh.last_audio_at) >= idleMs;
    const staleCloning =
      fresh.state === "cloning" && fresh.cloning_started_at && deps.now() - Date.parse(fresh.cloning_started_at) > VOICE_TWIN_STALE_CLONING_SECONDS * 1000;
    if ((fresh.state === "collecting" && idle && fresh.speech_seconds >= deps.settings().minSeconds) || staleCloning) {
      summary.clone = await maybeStartClone({}, deps);
    }
  }
  return summary;
}

/* ---------- takeover ---------- */

export interface TwinTakeover {
  voiceId: string;
  voiceSource: VoiceTwinVoiceSource;
  /** The consent reference stored with the call and shown in the report. */
  consentGivenAt: string;
  /** Seconds of the customer's speech the voice was built from. */
  speechSeconds: number;
}

/**
 * The twin's voice for a handover, or null when it can't be used: no consent, not ready, expired (or about to
 * expire in the next minute), or ElevenLabs says the voice no longer exists.
 */
export async function twinForTakeover(deps: VoiceTwinDeps = liveVoiceTwinDeps()): Promise<TwinTakeover | null> {
  const twin = await deps.store.getTwin();
  if (!twin?.voice_twin_consent || twin.state !== "ready" || !twin.voice_id || !twin.voice_source || !twin.consent_given_at) return null;
  if (!twin.voice_expires_at || Date.parse(twin.voice_expires_at) - deps.now() < 60_000) return null;
  if ((await deps.voices.exists(twin.voice_id)) === false) {
    // The voice is gone at ElevenLabs (e.g. deleted in its dashboard): retire it now so the pop-up, the push and
    // Settings stop offering a twin that can't speak (the row change reaches /protect over Realtime).
    try {
      if (await deps.store.retireVoice(twin.id, twin.voice_id)) {
        const expired = await deps.store.expire(twin.id);
        const leftovers = [...expired.paths, ...(await deps.storage.listTwinObjects(twin.id))];
        if (leftovers.length) await deps.storage.remove([...new Set(leftovers)]);
      }
    } catch (error) {
      console.error("voice twin: could not retire a missing voice", error);
    }
    return null;
  }
  return {
    voiceId: twin.voice_id,
    voiceSource: twin.voice_source,
    consentGivenAt: twin.consent_given_at,
    speechSeconds: Math.round((twin.clone_speech_seconds ?? twin.speech_seconds) * 10) / 10,
  };
}
