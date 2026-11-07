"use client";

import { ArrowLeft, AudioLines, CheckCircle2, Loader2, Mic, PhoneCall, PhoneOff, RotateCcw, ShieldAlert, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { postJson, useNow, viewFor } from "@/components/protect/protect-app";
import { twinStatusWord } from "@/components/protect/voice-twin-card";
import { VoiceMatchSettings } from "@/components/protect/voice-match-settings";
import { VoiceTwinProgress } from "@/components/protect/voice-twin-progress";
import type { CustomerCall } from "@/lib/customer-view";
import { useChangeSignals, type SignalConnection } from "@/lib/supabase/change-signals";
import { VOICE_TWIN_CONSENT_TEXT, VOICE_TWIN_LABEL, VOICE_TWIN_SAMPLE_MAX_SECONDS } from "@/lib/voice-twin/config";
import { LIVE_CAPTURE_TEXT, liveCaptureStatus, twinExpiryLabel, twinProgress, type LiveCaptureStatus } from "@/lib/voice-twin/popup";
import {
  RecorderAbortedError,
  RecorderError,
  SampleRecordingSlot,
  startSampleRecording,
  type RecorderStopReason,
} from "@/lib/voice-twin/recorder";
import { RETRY_IDLE, retryReducer, retryView, twinFailureDetail } from "@/lib/voice-twin/retry-status";
import type { RevokeResult } from "@/lib/voice-twin/service";
import type { CustomerTwinView } from "@/lib/voice-twin/view";

type Busy = "consent" | "revoke" | "retry" | null;
type RecPhase = "idle" | "starting" | "recording" | "sending";
interface RecState {
  phase: RecPhase;
  /** Seconds recorded and seconds of clean speech counted in this browser, for the live counter. */
  elapsed: number;
  speech: number;
  /** The twin's stored speech when recording started (the bar shows baseline + this recording). */
  baseline: number;
}
interface Note {
  tone: "ok" | "error";
  text: string;
}

const IDLE: RecState = { phase: "idle", elapsed: 0, speech: 0, baseline: 0 };

/** "6 November 2026 at 12:00" in the viewer's time zone. */
function formatWhen(iso: string | null): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "an unknown time";
  return new Date(t).toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 0:07 */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function endNote(reason: RecorderStopReason, storedSeconds: number, uploadsFailed: number): Note {
  if (reason === "twin_busy") return { tone: "ok", text: "That's enough of your voice. Your AI Voice Twin is being made now." };
  const unsent = uploadsFailed > 0 ? " Some of it couldn't be sent, so you may want to record a little more." : "";
  if (storedSeconds < 1) {
    return {
      tone: "error",
      text: `We didn't catch any clear speech. Try again somewhere quiet, holding the phone a little closer.${unsent}`,
    };
  }
  const limit = reason === "limit" ? `That's the ${VOICE_TWIN_SAMPLE_MAX_SECONDS}-second limit. ` : "";
  return { tone: "ok", text: `${limit}Thank you: ${Math.floor(storedSeconds)}s of your clear speech was saved.${unsent}` };
}

/**
 * The Settings screen (/protect/settings): "Your AI voice match" (VoiceMatchSettings), then the AI Voice Twin: what it
 * is, the consent box (unticked), then status, live progress, "Record a sample now", "Try again" and "Revoke & delete".
 * Consent is only ever given here.
 */
export function VoiceTwinSettings({
  firstName,
  minSeconds,
  targetSeconds,
  sampleParagraph,
}: {
  firstName: string;
  minSeconds: number;
  targetSeconds: number;
  sampleParagraph: string;
}) {
  const [twin, setTwin] = useState<CustomerTwinView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [alertCall, setAlertCall] = useState<CustomerCall | null>(null);
  const [connection, setConnection] = useState<SignalConnection>("connecting");
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoked, setRevoked] = useState<RevokeResult | null>(null);
  const [retryState, dispatchRetry] = useReducer(retryReducer, RETRY_IDLE);
  const [rec, setRec] = useState<RecState>(IDLE);
  const [recNote, setRecNote] = useState<Note | null>(null);
  /** The sample recording this page owns, from the moment Start is tapped (still starting, recording, or sending). */
  const [slot] = useState(() => new SampleRecordingSlot());
  const storedSeconds = useRef(0);
  const now = useNow(5_000);

  /* ---------- data: the twin (and whether a call needs the customer), live via Realtime change signals ---------- */
  const twinSeq = useRef(0);
  /** voice_twins change signals received so far (tells the retry tracker whether a read is newer than a change). */
  const twinSignals = useRef(0);
  /** Apply a twin snapshot (from a reply that isn't a fresh read), superseding any read still in flight. */
  const applyTwin = useCallback((next: CustomerTwinView) => {
    twinSeq.current++;
    setTwin(next);
    setLoadError(null);
    dispatchRetry({ type: "snapshot", twin: next, signalsAtRead: null });
  }, []);

  const loadTwin = useCallback(async () => {
    const mine = ++twinSeq.current;
    const signalsAtRead = twinSignals.current;
    try {
      const res = await fetch("/api/protect/voice-twin", { credentials: "same-origin", cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { twin?: CustomerTwinView; error?: string };
      if (mine !== twinSeq.current) return;
      if (res.ok && data.twin) {
        setTwin(data.twin);
        setLoadError(null);
        dispatchRetry({ type: "snapshot", twin: data.twin, signalsAtRead });
      } else {
        setLoadError(data.error ?? "Couldn't load your AI Voice Twin. Please try again.");
      }
    } catch {
      if (mine === twinSeq.current) setLoadError("Couldn't reach Northgate. Check your signal and try again.");
    }
  }, []);

  const loadCall = useCallback(async () => {
    try {
      const res = await fetch("/api/protect/state", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { call: CustomerCall | null };
      setAlertCall(data.call);
    } catch {
      // offline: the next signal or poll retries
    }
  }, []);

  useChangeSignals({
    onSignal: (signal) => {
      if (signal.table === "voice_twins") {
        twinSignals.current++;
        void loadTwin();
      } else if (signal.table === "calls") void loadCall();
    },
    onSubscribed: () => {
      void loadTwin();
      void loadCall();
    },
    onConnection: setConnection,
  });

  useEffect(() => {
    const first = setTimeout(() => {
      void loadTwin();
      void loadCall();
    }, 0);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void loadTwin();
        void loadCall();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    const poll = setInterval(onVisible, 20_000);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadTwin, loadCall]);

  // Leaving the page (e.g. the scam-alert banner back to /protect) cancels a recording that is starting or recording,
  // even one still waiting on the microphone permission prompt: the microphone is released as soon as it's granted and
  // nothing more is sent. Next keeps a page it navigates away from in a hidden <Activity> (state kept, effects cleaned
  // up), so the cleanup also resets the page: brought back, it's idle, not stuck "Starting the microphone…" with
  // Revoke & delete disabled. A layout effect's cleanup runs before the page is hidden. A recording the customer
  // already stopped is left to send its final chunk; its onEnd resets the page.
  useLayoutEffect(() => {
    return () => {
      if (slot.leave()) setRec(IDLE);
    };
  }, [slot]);

  /* ---------- actions ---------- */
  /**
   * Cancel the sample recording, whether still starting, recording or sending: the microphone is released and nothing
   * more is uploaded (not even the final chunk). Resolves once an upload already in flight has finished.
   */
  const discardRecording = useCallback(async () => {
    const discarded = slot.discard();
    setRec(IDLE);
    await discarded;
  }, [slot]);

  const giveConsent = async () => {
    if (!ticked) return;
    setBusy("consent");
    setError(null);
    const res = await postJson<{ twin: CustomerTwinView }>("/api/protect/voice-twin/consent", { agree: true });
    setBusy(null);
    if (res.ok && res.data.twin) {
      applyTwin(res.data.twin);
      setTicked(false);
      setRevoked(null);
    } else {
      setError(res.error ?? "Couldn't save your consent. Please try again.");
    }
  };

  const revoke = async () => {
    setBusy("revoke");
    setError(null);
    // The buttons are disabled while a recording runs, but never let one outlive a revoke.
    await discardRecording();
    const res = await postJson<{ twin: CustomerTwinView; result: RevokeResult }>("/api/protect/voice-twin/revoke", {});
    setBusy(null);
    setConfirmRevoke(false);
    if (res.ok && res.data.twin) {
      applyTwin(res.data.twin);
      dispatchRetry({ type: "dismissed" });
      setRevoked(res.data.result ?? null);
      setTicked(false);
      setRecNote(null);
    } else {
      setError(res.error ?? "Couldn't revoke your consent. Please try again.");
    }
  };

  const retry = async () => {
    setBusy("retry");
    setError(null);
    dispatchRetry({ type: "requested", at: Date.now(), signals: twinSignals.current });
    const res = await postJson<{ twin: CustomerTwinView }>("/api/protect/voice-twin/retry", {});
    setBusy(null);
    if (res.ok) {
      // The reply's twin was read before the clone was claimed (that runs after the reply), so it can only be staler
      // than a read a change signal started meanwhile: re-read instead of applying it.
      void loadTwin();
    } else {
      dispatchRetry({ type: "request_failed" });
      setError(res.error ?? "Couldn't try again just now. Please try again in a moment.");
    }
  };

  const startRecording = async () => {
    // Never record without consent: the button only exists after consent, and the server refuses chunks without it.
    if (!twin?.consent || rec.phase !== "idle") return;
    const controller = slot.claim();
    if (!controller) return;
    /** Still this page's recording (not left, discarded by Revoke & delete, or ended). */
    const current = () => slot.owns(controller);
    setRecNote(null);
    setConfirmRevoke(false);
    storedSeconds.current = 0;
    setRec({ phase: "starting", elapsed: 0, speech: 0, baseline: twin.speechSeconds });
    try {
      const started = await startSampleRecording(
        {
          onProgress: (p) => {
            if (current()) setRec((s) => (s.phase === "idle" ? s : { ...s, elapsed: p.elapsedSeconds, speech: p.speechSeconds }));
          },
          onChunk: (chunk) => {
            if (chunk.stored) storedSeconds.current += chunk.speechSeconds;
            if (chunk.twin) applyTwin(chunk.twin);
          },
          onError: (message) => {
            if (current()) setRecNote({ tone: "error", text: message });
          },
          onEnd: ({ reason, uploadsFailed }) => {
            if (!slot.release(controller)) return; // left or discarded: whoever aborted it has already reset the page
            setRec(IDLE);
            if (reason !== "refused" && reason !== "aborted") setRecNote(endNote(reason, storedSeconds.current, uploadsFailed));
            void loadTwin();
          },
        },
        // Every chunk carries the consent it was recorded under: the server refuses it (403) once that has changed.
        { signal: controller.signal, consentAt: twin.consentGivenAt },
      );
      if (!slot.started(controller, started)) return; // cancelled as it finished starting: the recorder discards itself
      setRec((s) => (s.phase === "starting" ? { ...s, phase: "recording" } : s));
    } catch (e) {
      // Still this page's recording (e.g. the abort didn't come from leaving or Revoke): reset, so it isn't left stuck.
      if (!slot.release(controller)) return; // left or discarded: whoever did that has already reset the page
      setRec(IDLE);
      if (e instanceof RecorderAbortedError) return; // cancelled: nothing to tell the customer
      setRecNote({ tone: "error", text: e instanceof RecorderError ? e.message : "We couldn't start the microphone. Please try again." });
    }
  };

  const stopRecording = async () => {
    // From here, leaving the page no longer cancels it: the final chunk the customer asked to save still goes.
    const stopping = slot.stop();
    if (!stopping) return;
    setRec((s) => ({ ...s, phase: "sending" }));
    await stopping;
  };

  /* ---------- render ---------- */
  const min = twin?.minSeconds ?? minSeconds;
  const target = twin?.targetSeconds ?? targetSeconds;
  const callNeedsYou = viewFor(alertCall, now) === "offered";
  const recordingActive = rec.phase === "recording" || rec.phase === "sending";
  /** The microphone is starting, recording or still sending: Revoke & delete waits for it. */
  const recorderBusy = rec.phase !== "idle";
  const { retrying, failedAgain } = retryView(retryState, twin?.state, now);
  /** The reason the clone failed, without the heading it repeats or its pointer to Settings (this page). */
  const failedDetail = twin?.state === "failed" ? twinFailureDetail(twin.error) : null;
  const canRecord = Boolean(twin?.consent && !twin.usable && (twin.state === "collecting" || twin.state === "failed"));
  /** Whether calls are adding to the twin right now (null when that doesn't apply: ready, or being made). */
  const capture = liveCaptureStatus(twin);
  // While recording, the bar moves with this browser's own count; the server's (re-counted) total takes over after.
  const shownSpeech = twin ? (recordingActive ? Math.max(twin.speechSeconds, rec.baseline + rec.speech) : twin.speechSeconds) : 0;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))]">
      <header className="flex items-center justify-between">
        <Link href="/protect" className="-ml-2 flex items-center gap-1.5 rounded-lg px-2 py-2 text-sm font-semibold text-primary">
          <ArrowLeft className="size-4" aria-hidden />
          Call Guard
        </Link>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={`size-2 rounded-full ${connection === "live" ? "bg-emerald-400" : connection === "connecting" ? "bg-amber-400" : "bg-destructive"}`} />
          {connection === "live" ? "Live" : connection === "connecting" ? "Connecting…" : "Offline"}
        </span>
      </header>

      {callNeedsYou && (
        <Link
          href="/protect"
          role="alert"
          className="flex items-center gap-3 rounded-2xl bg-[oklch(0.48_0.2_25)] p-4 font-bold text-white shadow-lg active:scale-[0.99]"
        >
          <ShieldAlert className="size-7 shrink-0" aria-hidden />
          <span>A call looks like a scam right now. Tap to go back to the alert.</span>
        </Link>
      )}

      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Settings</h1>
        {firstName && <p className="text-sm text-muted-foreground">for {firstName}</p>}
      </div>

      <VoiceMatchSettings />

      <h2 className="flex items-center gap-2 pt-2 text-xl font-semibold">
        <AudioLines className="size-6 text-primary" aria-hidden />
        {VOICE_TWIN_LABEL}
      </h2>

      {revoked && <RevokedSummary result={revoked} />}

      {error && (
        <p role="alert" className="rounded-lg border border-destructive/60 bg-destructive/15 p-3 text-sm">
          {error}
        </p>
      )}

      {!twin ? (
        loadError ? (
          <section className="space-y-3 rounded-2xl border border-border bg-card/60 p-4">
            <p role="alert" className="text-sm">
              {loadError}
            </p>
            <button type="button" onClick={() => void loadTwin()} className="rounded-xl bg-muted px-4 py-2.5 text-sm font-semibold">
              Try again
            </button>
          </section>
        ) : (
          <Loader2 className="mx-auto mt-10 size-8 animate-spin text-muted-foreground" aria-label="Loading" />
        )
      ) : !twin.consent ? (
        <section className="space-y-4 rounded-2xl border border-border bg-card/60 p-4">
          <h3 className="text-lg font-semibold">What is an AI Voice Twin?</h3>
          <Explanation minSeconds={min} />
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void giveConsent();
            }}
          >
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-background/60 p-4">
              <input
                type="checkbox"
                checked={ticked}
                onChange={(e) => setTicked(e.target.checked)}
                className="mt-0.5 size-6 shrink-0 cursor-pointer accent-primary"
              />
              <span className="text-sm font-medium leading-snug">{VOICE_TWIN_CONSENT_TEXT}</span>
            </label>
            <button
              type="submit"
              disabled={!ticked || busy !== null}
              aria-busy={busy === "consent"}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy === "consent" && <Loader2 className="size-5 animate-spin" aria-hidden />}
              {busy === "consent" ? "Saving…" : "Give consent"}
            </button>
            <p className="text-xs text-muted-foreground">Nothing is recorded until you give consent. You can revoke it here at any time.</p>
          </form>
        </section>
      ) : (
        <>
          <section className="space-y-3 rounded-2xl border border-border bg-card/60 p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold">Your {VOICE_TWIN_LABEL}</h3>
              <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">{twinStatusWord(twin)}</span>
            </div>

            {twin.usable ? (
              <>
                <p className="text-sm">
                  Ready until <strong>{twinExpiryLabel(twin.voiceExpiresAt, now) || "later today"}</strong>, then it&apos;s deleted automatically.
                  {twin.cloneSpeechSeconds != null && ` Made from ${Math.floor(twin.cloneSpeechSeconds)}s of your voice.`}
                </p>
                {twin.voiceSource === "fallback" && (
                  <p className="rounded-lg bg-amber-400/15 p-3 text-xs leading-relaxed">
                    Making a fresh copy of your voice didn&apos;t work, so your AI Voice Twin is using your backup copy (the one made in
                    the ElevenLabs dashboard). The app never deletes that backup copy: delete it in ElevenLabs if you no longer want it.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  If a call is flagged as a likely scam, tap Use my Voice Twin in the alert.
                </p>
              </>
            ) : twin.state === "failed" ? (
              <>
                {failedAgain ? (
                  <div role="alert" className="space-y-1 rounded-lg border border-destructive/60 bg-destructive/15 p-3 text-sm">
                    <p className="font-semibold">We still couldn&apos;t make your AI Voice Twin.</p>
                    {failedDetail && <p>{failedDetail}</p>}
                    <p className="text-xs text-muted-foreground">
                      Your recordings are kept. Recording a little more of your voice below can help before you try again.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1 text-sm">
                    <p>We couldn&apos;t make your AI Voice Twin this time.</p>
                    {failedDetail && <p>{failedDetail}</p>}
                    <p className="text-xs text-muted-foreground">Your recordings are kept so you can try again.</p>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void retry()}
                  disabled={busy !== null || retrying || recordingActive}
                  aria-busy={busy === "retry" || retrying}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {busy === "retry" || retrying ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <RotateCcw className="size-5" aria-hidden />}
                  {busy === "retry" || retrying ? "Trying again…" : "Try again"}
                </button>
              </>
            ) : (
              <>
                <VoiceTwinProgress
                  progress={twinProgress({ speechSeconds: shownSpeech, minSeconds: min, targetSeconds: target })}
                  status={twin.state === "ready" ? "collecting" : twin.state}
                />
                <p className="text-xs text-muted-foreground">
                  {twin.state === "cloning"
                    ? "This usually takes under a minute."
                    : shownSpeech >= min
                      ? "That's enough of your voice. Your AI Voice Twin will be made shortly."
                      : `It's made automatically once there are ${min}s of your clear speech, from flagged calls or a sample below.`}
                </p>
              </>
            )}

            {capture && <LiveCaptureLine status={capture} />}

            <p className="border-t border-border pt-3 text-xs text-muted-foreground">
              Consent given by {twin.consentGivenBy ?? "the account holder"} on {formatWhen(twin.consentGivenAt)}.
            </p>
          </section>

          {(canRecord || recordingActive) && (
            <section className="space-y-3 rounded-2xl border border-border bg-card/60 p-4">
              <h3 className="flex items-center gap-2 font-semibold">
                <Mic className="size-5 text-primary" aria-hidden />
                Record a sample now
              </h3>
              <p className="text-sm text-muted-foreground">
                Optional, to get your AI Voice Twin sooner. Somewhere quiet, read this aloud in your normal voice. It stops by itself after{" "}
                {VOICE_TWIN_SAMPLE_MAX_SECONDS} seconds, and only your clear speech is kept.
              </p>
              <blockquote className="rounded-xl border-l-4 border-primary bg-muted/60 p-4 text-base leading-relaxed">{sampleParagraph}</blockquote>

              {recordingActive ? (
                <>
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-destructive/15 px-3 py-3">
                    <span className="flex items-center gap-2 font-semibold">
                      <span className="live-pulse size-2.5 rounded-full bg-destructive" aria-hidden />
                      <span role="timer" className="tabular-nums">
                        {clock(rec.elapsed)} / {clock(VOICE_TWIN_SAMPLE_MAX_SECONDS)}
                      </span>
                    </span>
                    <span className="text-sm tabular-nums">{Math.floor(rec.speech)}s of clear speech</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void stopRecording()}
                    disabled={rec.phase === "sending"}
                    aria-busy={rec.phase === "sending"}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-destructive px-4 py-3.5 font-semibold text-white disabled:opacity-60"
                  >
                    {rec.phase === "sending" ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Square className="size-5 fill-current" aria-hidden />}
                    {rec.phase === "sending" ? "Saving your recording…" : "Stop"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => void startRecording()}
                  disabled={rec.phase === "starting" || busy !== null || retrying}
                  aria-busy={rec.phase === "starting"}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {rec.phase === "starting" ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Mic className="size-5" aria-hidden />}
                  {rec.phase === "starting" ? "Starting the microphone…" : "Start recording"}
                </button>
              )}
              {recNote && (
                <p
                  role={recNote.tone === "error" ? "alert" : "status"}
                  className={`rounded-lg p-3 text-sm ${recNote.tone === "error" ? "border border-destructive/60 bg-destructive/15" : "bg-emerald-500/10"}`}
                >
                  {recNote.text}
                </p>
              )}
            </section>
          )}

          <details className="rounded-2xl border border-border bg-card/60 p-4">
            <summary className="cursor-pointer font-semibold">How your AI Voice Twin works</summary>
            <div className="mt-3 space-y-3">
              <Explanation minSeconds={min} />
              <p className="text-xs text-muted-foreground">You agreed to: &ldquo;{VOICE_TWIN_CONSENT_TEXT}&rdquo;.</p>
            </div>
          </details>

          <section className="space-y-3 rounded-2xl border border-destructive/40 p-4">
            <h3 className="flex items-center gap-2 font-semibold">
              <Trash2 className="size-5 text-destructive" aria-hidden />
              Revoke &amp; delete
            </h3>
            <p className="text-sm text-muted-foreground">
              Turns AI Voice Twin off, deletes all your recordings and deletes your AI Voice Twin at ElevenLabs straight away.
            </p>
            {!confirmRevoke ? (
              <button
                type="button"
                onClick={() => setConfirmRevoke(true)}
                disabled={busy !== null || recorderBusy}
                className="w-full rounded-xl border-2 border-destructive px-4 py-3 font-semibold text-destructive disabled:opacity-60"
              >
                Revoke &amp; delete
              </button>
            ) : (
              <div className="space-y-3 rounded-xl bg-destructive/10 p-3">
                <p className="text-sm font-semibold">Delete your recordings and your AI Voice Twin now? This can&apos;t be undone.</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => void revoke()}
                    disabled={busy !== null || recorderBusy}
                    aria-busy={busy === "revoke"}
                    className="flex items-center justify-center gap-2 rounded-xl bg-destructive px-3 py-3 font-semibold text-white disabled:opacity-60"
                  >
                    {busy === "revoke" && <Loader2 className="size-4 animate-spin" aria-hidden />}
                    {busy === "revoke" ? "Deleting…" : "Yes, delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRevoke(false)}
                    disabled={busy !== null}
                    className="rounded-xl bg-muted px-3 py-3 font-semibold disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {recorderBusy && <p className="text-xs text-muted-foreground">You can do this once the recording above has stopped and been saved.</p>}
          </section>
        </>
      )}
    </main>
  );
}

/**
 * "Recording during calls": whether flagged calls are adding the customer's voice to their twin right now. It needs the
 * Call Guard recording service (the media bridge); without it only "Record a sample now" adds speech. Follows the twin
 * reads (change signals, the 20 s poll and focus), so it changes on its own when the service starts or stops.
 */
function LiveCaptureLine({ status }: { status: LiveCaptureStatus }) {
  const on = status === "on";
  const Icon = on ? PhoneCall : PhoneOff;
  return (
    <div aria-live="polite" className={`flex items-start gap-2.5 rounded-lg p-3 text-sm leading-snug ${on ? "bg-emerald-500/10" : "bg-amber-400/15"}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${on ? "text-emerald-400" : "text-amber-400"}`} aria-hidden />
      <p>
        <span className="block font-semibold">Recording during calls</span>
        {LIVE_CAPTURE_TEXT[status].settings}
      </p>
    </div>
  );
}

/** What the AI Voice Twin is and how the voice is handled, shown before the consent box (and later under "How it works"). */
function Explanation({ minSeconds }: { minSeconds: number }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      <p>
        Your <strong>AI Voice Twin</strong> is an AI copy of your own voice. If Call Guard flags a call as a likely scam, you can choose to hand it to
        your AI Voice Twin instead of Northgate&apos;s AI voice. It talks to the caller as you, in your voice, and keeps them busy.
      </p>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <strong>Only your side of the call is recorded</strong>, never the caller&apos;s.
        </li>
        <li>
          Recording starts when a screened call begins. When the call ends, its recording is deleted unless Call Guard flagged it as a likely scam.
        </li>
        <li>
          When there are at least {minSeconds} seconds of your clear speech, Northgate makes an AI copy of your voice with ElevenLabs Instant Voice
          Cloning.
        </li>
        <li>The raw recordings are deleted as soon as the copy is made.</li>
        <li>The copy is deleted automatically 24 hours after it&apos;s made, and straight away if you tap Revoke &amp; delete.</li>
        <li>
          It&apos;s only ever used if you tap &ldquo;Use my Voice Twin&rdquo; in a scam alert. It&apos;s labelled AI Voice Twin everywhere,
          including in reports.
        </li>
        <li>It never agrees to payments or gives your real details.</li>
      </ul>
    </div>
  );
}

function revokedVoiceLine(voice: RevokeResult["voice"]): string | null {
  switch (voice) {
    case "deleted":
      return "Your AI Voice Twin was deleted at ElevenLabs.";
    case "not_found":
      return "Your AI Voice Twin was already gone at ElevenLabs.";
    case "none":
      return "No AI Voice Twin had been made yet, so there was nothing to delete at ElevenLabs.";
    case "fallback_kept":
      return "Your AI Voice Twin was using your backup copy made in the ElevenLabs dashboard. The app doesn't delete that one: delete it in ElevenLabs if you want it gone.";
    case "failed":
      return null; // the problem line explains it
  }
}

/** What Revoke & delete removed. */
function RevokedSummary({ result }: { result: RevokeResult }) {
  const voice = revokedVoiceLine(result.voice);
  return (
    <section role="status" className="space-y-2 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm">
      <h3 className="flex items-center gap-2 font-semibold">
        <CheckCircle2 className="size-5 text-emerald-400" aria-hidden />
        Consent revoked
      </h3>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          {result.audioDeleted === 0
            ? "There were no stored recordings to delete."
            : `${result.audioDeleted} stored recording${result.audioDeleted === 1 ? "" : "s"} deleted.`}
        </li>
        {voice && <li>{voice}</li>}
      </ul>
      {result.problem && <p className="font-medium text-amber-300">{result.problem}</p>}
      <p className="text-xs text-muted-foreground">Nothing more will be recorded. You can turn AI Voice Twin on again below if you change your mind.</p>
    </section>
  );
}
