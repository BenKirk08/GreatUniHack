import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortable,
  CONSENT_CHANGED_MESSAGE,
  NOT_STORED_MESSAGE,
  NOT_STORED_MIN_SPEECH_SECONDS,
  notKept,
  RecorderAbortedError,
  RecorderError,
  SAMPLE_RATE,
  SampleRecordingSlot,
  startSampleRecording,
  type RecorderEvents,
  type RecorderOptions,
  type RecorderStopReason,
} from "@/lib/voice-twin/recorder";
import type { CustomerTwinView } from "@/lib/voice-twin/view";
import { speechLike } from "./helpers/voice-fixtures";

// ---------- fakes for getUserMedia and Web Audio (just what the recorder touches) ----------

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let pending promise callbacks (and a macrotask) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
  get allStopped() {
    return this.tracks.every((t) => t.stopped);
  }
}

class FakeNode {
  connect<T>(next: T): T {
    return next;
  }
  disconnect() {}
}

interface FakeProcessEvent {
  inputBuffer: { getChannelData(channel: number): Float32Array };
}

class FakeScriptProcessor extends FakeNode {
  onaudioprocess: ((event: FakeProcessEvent) => void) | null = null;
}

class FakeWorkletNode extends FakeNode {
  readonly port = { onmessage: null as unknown, postMessage: vi.fn() };
}

/** Gates the test can hold shut to keep a start-up step pending. */
const gates: { resume: Deferred<void> | null; addModule: Deferred<void> | null } = { resume: null, addModule: null };
let withWorklet = false;
const contexts: FakeAudioContext[] = [];

class FakeAudioContext {
  readonly sampleRate: number;
  readonly destination = new FakeNode();
  readonly processors: FakeScriptProcessor[] = [];
  readonly audioWorklet?: { addModule(url: string): Promise<void> };
  closed = false;
  constructor(opts?: { sampleRate?: number }) {
    this.sampleRate = opts?.sampleRate ?? 48_000;
    if (withWorklet) this.audioWorklet = { addModule: () => gates.addModule?.promise ?? Promise.resolve() };
    contexts.push(this);
  }
  createMediaStreamSource() {
    return new FakeNode();
  }
  resume() {
    return gates.resume?.promise ?? Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
  createScriptProcessor() {
    const node = new FakeScriptProcessor();
    this.processors.push(node);
    return node;
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: { value: 1 } });
  }
}

interface UploadBody {
  seq: number;
  final: boolean;
  consentAt?: string | null;
}

let micRequests: Deferred<FakeStream>[] = [];
let uploads: { seq: number; final: boolean; body: UploadBody; reply: Deferred<Response> }[] = [];
/** When true, uploads answer at once (with `replyTo`); otherwise each waits for the test to resolve its `reply`. */
let autoReply = true;
let replyTo: (body: UploadBody) => Response = () => okReply();

function okReply(): Response {
  return new Response(JSON.stringify({ ok: true, stored: true, speechSeconds: 3, twin: null }), { status: 200 });
}

function jsonReply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status });
}

function twinView(state: CustomerTwinView["state"]): CustomerTwinView {
  return {
    consent: true,
    consentGivenAt: "2026-11-06T12:00:00.000Z",
    consentGivenBy: "Margaret",
    state,
    speechSeconds: 12,
    minSeconds: 30,
    targetSeconds: 60,
    usable: false,
    voiceSource: null,
    voiceCreatedAt: null,
    voiceExpiresAt: null,
    cloneSpeechSeconds: null,
    error: null,
    liveCapture: false,
  };
}

beforeEach(() => {
  contexts.length = 0;
  micRequests = [];
  uploads = [];
  autoReply = true;
  replyTo = () => okReply();
  withWorklet = false;
  gates.resume = null;
  gates.addModule = null;
  vi.stubGlobal("window", { AudioContext: FakeAudioContext });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () => {
        const request = deferred<FakeStream>();
        micRequests.push(request);
        return request.promise;
      },
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as UploadBody;
      const reply = deferred<Response>();
      uploads.push({ seq: body.seq, final: body.final, body, reply });
      if (autoReply) reply.resolve(replyTo(body));
      return reply.promise;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function recordedEvents() {
  const log = {
    chunks: [] as number[],
    errors: [] as string[],
    ends: [] as RecorderStopReason[],
  };
  const events: RecorderEvents = {
    onChunk: (c) => log.chunks.push(c.seq),
    onError: (m) => log.errors.push(m),
    onEnd: (e) => log.ends.push(e.reason),
  };
  return { log, events };
}

/** Continuous speech-like audio (what the browser VAD counts as speech), fed in 4096-sample blocks. */
function feedSpeech(processor: FakeScriptProcessor, seconds: number) {
  const blocks = Math.ceil((seconds * SAMPLE_RATE) / 4096);
  const signal = speechLike(SAMPLE_RATE, (blocks * 4096) / SAMPLE_RATE, -16, { gaps: false });
  for (let b = 0; b < blocks; b++) {
    const block = signal.slice(b * 4096, (b + 1) * 4096);
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => block } });
  }
}

/** Digital silence, in 4096-sample blocks. */
function feedSilence(processor: FakeScriptProcessor, seconds: number) {
  const blocks = Math.ceil((seconds * SAMPLE_RATE) / 4096);
  for (let b = 0; b < blocks; b++) {
    const block = new Float32Array(4096);
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => block } });
  }
}

/** Start, grant the microphone, and return the recording and its processor. */
async function startRecording(events: RecorderEvents, signal?: AbortSignal, opts: Omit<RecorderOptions, "signal"> = {}) {
  const started = startSampleRecording(events, { ...opts, signal });
  await settle();
  const stream = new FakeStream();
  micRequests[0].resolve(stream);
  const recording = await started;
  const processor = contexts[0].processors[0];
  return { recording, processor, stream };
}

// ---------- abortable() ----------

describe("abortable", () => {
  it("passes the value (or the error) through when the signal never fires", async () => {
    const controller = new AbortController();
    await expect(abortable(Promise.resolve(7), controller.signal)).resolves.toBe(7);
    await expect(abortable(Promise.reject(new Error("boom")), controller.signal)).rejects.toThrow("boom");
    const same = Promise.resolve(1);
    expect(abortable(same, undefined)).toBe(same);
  });

  it("rejects as soon as the signal fires, and hands a late value to dispose", async () => {
    const controller = new AbortController();
    const pending = deferred<string>();
    const dispose = vi.fn();
    const result = abortable(pending.promise, controller.signal, dispose);
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(RecorderAbortedError);
    expect(dispose).not.toHaveBeenCalled();
    pending.resolve("late");
    await settle();
    expect(dispose).toHaveBeenCalledWith("late");
  });

  it("rejects straight away for an already-aborted signal, and swallows a late rejection", async () => {
    const pending = deferred<string>();
    const result = abortable(pending.promise, AbortSignal.abort());
    await expect(result).rejects.toBeInstanceOf(RecorderAbortedError);
    pending.reject(new Error("too late"));
    await settle(); // no unhandled rejection
  });
});

// ---------- aborting while the recorder is still starting ----------

describe("startSampleRecording: aborted while starting", () => {
  it("never asks for the microphone when the signal has already fired", async () => {
    await expect(startSampleRecording({}, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(RecorderAbortedError);
    expect(micRequests).toHaveLength(0);
    expect(contexts).toHaveLength(0);
  });

  it("gives up during the permission prompt, closes the context, and stops a microphone granted afterwards", async () => {
    const controller = new AbortController();
    const { log, events } = recordedEvents();
    const started = startSampleRecording(events, { signal: controller.signal });
    await settle();
    expect(micRequests).toHaveLength(1); // the prompt is up

    controller.abort(); // e.g. the customer tapped the scam-alert banner back to /protect
    await expect(started).rejects.toBeInstanceOf(RecorderAbortedError);
    expect(contexts[0].closed).toBe(true);

    const lateStream = new FakeStream();
    micRequests[0].resolve(lateStream); // the customer allows the microphone after leaving
    await settle();
    expect(lateStream.allStopped).toBe(true);
    expect(contexts[0].processors).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect(log.ends).toEqual([]);
  });

  it("releases the microphone when aborted while the context is resuming", async () => {
    gates.resume = deferred<void>();
    const controller = new AbortController();
    const started = startSampleRecording({}, { signal: controller.signal });
    await settle();
    const stream = new FakeStream();
    micRequests[0].resolve(stream);
    await settle();
    expect(stream.allStopped).toBe(false);

    controller.abort();
    await expect(started).rejects.toBeInstanceOf(RecorderAbortedError);
    expect(stream.allStopped).toBe(true);
    expect(contexts[0].closed).toBe(true);
    expect(contexts[0].processors).toHaveLength(0);
    gates.resume.resolve();
    await settle();
    expect(uploads).toHaveLength(0);
  });

  it("releases the microphone when aborted while the worklet module loads, without falling back to a ScriptProcessor", async () => {
    withWorklet = true;
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    gates.addModule = deferred<void>();
    const controller = new AbortController();
    const started = startSampleRecording({}, { signal: controller.signal });
    await settle();
    const stream = new FakeStream();
    micRequests[0].resolve(stream);
    await settle();

    controller.abort();
    await expect(started).rejects.toBeInstanceOf(RecorderAbortedError);
    expect(stream.allStopped).toBe(true);
    expect(contexts[0].closed).toBe(true);
    expect(contexts[0].processors).toHaveLength(0);
    gates.addModule.resolve();
    await settle();
    expect(uploads).toHaveLength(0);
  });

  it("still falls back to a ScriptProcessor when the worklet can't load (no abort)", async () => {
    withWorklet = true;
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    gates.addModule = deferred<void>();
    gates.addModule.promise.catch(() => undefined); // rejected before the recorder gets to it
    gates.addModule.reject(new Error("worklets blocked"));
    const { recording, processor, stream } = await startRecording({});
    expect(processor).toBeInstanceOf(FakeScriptProcessor);
    await recording.stop();
    expect(stream.allStopped).toBe(true);
  });

  it("turns a refused microphone into a customer-facing RecorderError and closes the context", async () => {
    const started = startSampleRecording({}, { signal: new AbortController().signal });
    await settle();
    micRequests[0].reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    await expect(started).rejects.toBeInstanceOf(RecorderError);
    await expect(started).rejects.toThrow(/Microphone access was blocked/);
    expect(contexts[0].closed).toBe(true);
  });
});

// ---------- stopping and aborting a running recording ----------

describe("startSampleRecording: running", () => {
  it("stop() sends the speech so far and then a final chunk (unchanged behaviour)", async () => {
    const { log, events } = recordedEvents();
    const { recording, processor, stream } = await startRecording(events, new AbortController().signal);
    feedSpeech(processor, 3.5);
    await recording.stop("user");
    expect(uploads.map((u) => [u.seq, u.final])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(log.chunks).toEqual([0, 1]);
    expect(log.ends).toEqual(["user"]);
    expect(stream.allStopped).toBe(true);
    expect(contexts[0].closed).toBe(true);
  });

  it("an abort mid-recording releases the microphone and sends nothing more, not even the final chunk", async () => {
    autoReply = false;
    const controller = new AbortController();
    const { log, events } = recordedEvents();
    const { recording, processor, stream } = await startRecording(events, controller.signal);
    feedSpeech(processor, 3.5);
    await settle();
    expect(uploads.map((u) => u.seq)).toEqual([0]); // in flight

    controller.abort();
    expect(stream.allStopped).toBe(true);
    expect(contexts[0].closed).toBe(true);
    feedSpeech(processor, 4); // the processor was detached; nothing is counted or queued
    const done = recording.stop("user"); // resolves once the in-flight upload has finished
    uploads[0].reply.resolve(okReply());
    await done;

    expect(uploads.map((u) => u.seq)).toEqual([0]);
    expect(log.chunks).toEqual([]); // the caller moved on: no reports after the abort
    expect(log.ends).toEqual(["aborted"]);
  });

  it("an abort after stop() drops the final chunk still queued behind an upload in flight", async () => {
    autoReply = false;
    const controller = new AbortController();
    const { log, events } = recordedEvents();
    const { recording, processor } = await startRecording(events, controller.signal);
    feedSpeech(processor, 3.5);
    await settle();
    const done = recording.stop("user"); // queues the final chunk behind seq 0
    controller.abort();
    uploads[0].reply.resolve(okReply());
    await done;
    expect(uploads.map((u) => [u.seq, u.final])).toEqual([[0, false]]);
    expect(log.ends).toEqual(["aborted"]);
  });

  it("an abort after the recording has ended changes nothing", async () => {
    const controller = new AbortController();
    const { log, events } = recordedEvents();
    const { recording, processor } = await startRecording(events, controller.signal);
    feedSpeech(processor, 1);
    await recording.stop("user");
    controller.abort();
    await recording.stop("user");
    expect(uploads.map((u) => u.final)).toEqual([true]);
    expect(log.ends).toEqual(["user"]);
  });
});

// ---------- consent travels with every chunk ----------

describe("startSampleRecording: consentAt", () => {
  it("sends the consent the recording started under with every chunk, the final one included", async () => {
    const consentAt = "2026-11-06T12:00:00.000Z";
    const { recording, processor } = await startRecording({}, new AbortController().signal, { consentAt });
    feedSpeech(processor, 3.5);
    await recording.stop("user");
    expect(uploads.map((u) => [u.seq, u.final, u.body.consentAt])).toEqual([
      [0, false, consentAt],
      [1, true, consentAt],
    ]);
  });

  it("sends a null consentAt as null (not left out), and leaves it out only when the caller gives none", async () => {
    const withNull = await startRecording({}, undefined, { consentAt: null });
    await withNull.recording.stop("user");
    expect(uploads).toHaveLength(1);
    expect("consentAt" in uploads[0].body).toBe(true);
    expect(uploads[0].body.consentAt).toBeNull();

    micRequests = [];
    contexts.length = 0;
    uploads = [];
    const without = await startRecording({});
    await without.recording.stop("user");
    expect("consentAt" in uploads[0].body).toBe(false);
  });

  it("a 403 (consent changed) stops as 'refused' with a clear note, releases the microphone and sends nothing more", async () => {
    replyTo = (body) => (body.seq === 0 ? jsonReply(403, { ok: false, error: "Turn on AI Voice Twin in Settings first." }) : okReply());
    const { log, events } = recordedEvents();
    const { recording, processor, stream } = await startRecording(events, new AbortController().signal, { consentAt: "2026-11-06T12:00:00.000Z" });
    feedSpeech(processor, 3.5);
    await settle();

    expect(log.errors).toEqual([CONSENT_CHANGED_MESSAGE]);
    expect(CONSENT_CHANGED_MESSAGE).toBe("Your consent changed while recording, so this recording wasn't kept.");
    expect(recording.stopped).toBe(true);
    expect(stream.allStopped).toBe(true);
    feedSpeech(processor, 4); // detached: nothing is counted or queued
    await recording.stop("user");
    expect(uploads.map((u) => [u.seq, u.final])).toEqual([[0, false]]); // no more chunks, not even a final one
    expect(log.chunks).toEqual([]);
    expect(log.ends).toEqual(["refused"]);
  });

  it("a 403 that comes back after Stop still ends it as 'refused' and drops the queued final chunk", async () => {
    autoReply = false;
    const { log, events } = recordedEvents();
    const { recording, processor } = await startRecording(events, undefined, { consentAt: "2026-11-06T12:00:00.000Z" });
    feedSpeech(processor, 3.5);
    await settle();
    const done = recording.stop("user"); // the final chunk waits behind seq 0
    uploads[0].reply.resolve(jsonReply(403, { ok: false, error: "Turn on AI Voice Twin in Settings first." }));
    await done;
    expect(uploads.map((u) => [u.seq, u.final])).toEqual([[0, false]]);
    expect(log.errors).toEqual([CONSENT_CHANGED_MESSAGE]);
    expect(log.ends).toEqual(["refused"]);
  });

  it("other refusals (4xx) still show the server's own message", async () => {
    replyTo = () => jsonReply(400, { ok: false, error: "That part of your recording was too long to send." });
    const { log, events } = recordedEvents();
    const { recording, processor } = await startRecording(events);
    feedSpeech(processor, 3.5);
    await settle();
    await recording.stop("user");
    expect(log.errors).toEqual(["That part of your recording was too long to send."]);
    expect(log.ends).toEqual(["refused"]);
    expect(uploads.map((u) => u.seq)).toEqual([0]);
  });
});

// ---------- a chunk the server didn't keep ----------

describe("startSampleRecording: stored: false", () => {
  const notStored = (state: CustomerTwinView["state"] = "collecting", extra: Record<string, unknown> = {}) =>
    jsonReply(200, { ok: true, stored: false, speechSeconds: 0, twin: twinView(state), ...extra });

  it("stops with a clear note when a chunk with speech in it comes back not stored", async () => {
    replyTo = (body) => (body.seq === 0 ? notStored() : okReply());
    const { log, events } = recordedEvents();
    const { recording, processor, stream } = await startRecording(events);
    feedSpeech(processor, 3.5);
    await settle();

    expect(log.chunks).toEqual([0]); // still reported (the page keeps its twin snapshot)
    expect(log.errors).toEqual([NOT_STORED_MESSAGE]);
    expect(stream.allStopped).toBe(true);
    feedSpeech(processor, 4);
    await recording.stop("user");
    expect(uploads.map((u) => [u.seq, u.final])).toEqual([[0, false]]);
    expect(log.ends).toEqual(["refused"]);
  });

  it("carries on when a chunk with next to no speech in it isn't kept (a pause after a sentence)", async () => {
    replyTo = (body) => (body.seq === 1 ? notStored() : okReply());
    const { log, events } = recordedEvents();
    const { recording, processor } = await startRecording(events);
    feedSpeech(processor, 3); // chunk 0: ~3 s of speech
    feedSilence(processor, 3); // chunk 1: only the end of the last word and a pause
    await settle();
    expect(uploads.map((u) => u.seq)).toEqual([0, 1]);
    expect(log.errors).toEqual([]);
    expect(recording.stopped).toBe(false);

    feedSpeech(processor, 3); // chunk 2
    await recording.stop("user");
    expect(uploads.map((u) => [u.seq, u.final])).toEqual([
      [0, false],
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(log.ends).toEqual(["user"]);
  });

  it("trusts the server's reason when it gives one", async () => {
    replyTo = (body) => (body.seq === 0 ? notStored("collecting", { reason: "no_speech" }) : okReply());
    const first = recordedEvents();
    const kept = await startRecording(first.events);
    feedSpeech(kept.processor, 3.5);
    await settle();
    expect(first.log.errors).toEqual([]);
    await kept.recording.stop("user");
    expect(first.log.ends).toEqual(["user"]);

    expect(notKept("no_speech", 3)).toBe(false);
    expect(notKept("not_collecting", 0)).toBe(true);
    expect(notKept(undefined, NOT_STORED_MIN_SPEECH_SECONDS - 0.01)).toBe(false);
    expect(notKept(undefined, NOT_STORED_MIN_SPEECH_SECONDS)).toBe(true);
    expect(notKept("", 0)).toBe(false);
  });

  it("says nothing about a final chunk that isn't kept (the recording is ending anyway)", async () => {
    replyTo = (body) => (body.final ? notStored() : okReply());
    const { log, events } = recordedEvents();
    const { recording, processor } = await startRecording(events);
    feedSpeech(processor, 3.5); // the final chunk carries ~0.5 s of speech
    await recording.stop("user");
    expect(log.errors).toEqual([]);
    expect(log.ends).toEqual(["user"]);
  });

  it("a twin that stopped collecting still ends as 'twin_busy', not as a refusal", async () => {
    replyTo = (body) => (body.seq === 0 ? notStored("cloning") : okReply());
    const { log, events } = recordedEvents();
    const { recording, processor } = await startRecording(events);
    feedSpeech(processor, 3.5);
    await settle();
    await recording.stop("user");
    expect(log.errors).toEqual([]);
    expect(log.ends).toEqual(["twin_busy"]);
  });
});

// ---------- the page's slot: leaving, stopping, revoking ----------

describe("SampleRecordingSlot", () => {
  /** Start a recording the way Settings does: claimed, then handed the controller's signal. */
  function claimAndStart(slot: SampleRecordingSlot, events: RecorderEvents = {}, opts: Omit<RecorderOptions, "signal"> = {}) {
    const controller = slot.claim();
    if (!controller) throw new Error("slot busy");
    const started = startSampleRecording(events, { ...opts, signal: controller.signal });
    return { controller, started };
  }

  async function grantAndStart(slot: SampleRecordingSlot, events: RecorderEvents = {}, opts: Omit<RecorderOptions, "signal"> = {}) {
    const { controller, started } = claimAndStart(slot, events, opts);
    await settle();
    const stream = new FakeStream();
    micRequests[micRequests.length - 1].resolve(stream);
    const recording = await started;
    expect(slot.started(controller, recording)).toBe(true);
    return { controller, recording, stream, processor: contexts[contexts.length - 1].processors[0] };
  }

  it("owns one recording at a time", () => {
    const slot = new SampleRecordingSlot();
    expect(slot.busy).toBe(false);
    const controller = slot.claim();
    expect(controller).not.toBeNull();
    expect(slot.busy).toBe(true);
    expect(slot.claim()).toBeNull();
    expect(slot.release(controller!)).toBe(true);
    expect(slot.busy).toBe(false);
    expect(slot.release(controller!)).toBe(false);
    expect(slot.stop()).toBeNull(); // nothing started
  });

  it("leaving while the microphone is starting cancels it and frees the slot, so the page comes back idle", async () => {
    const slot = new SampleRecordingSlot();
    const { log, events } = recordedEvents();
    const { controller, started } = claimAndStart(slot, events);
    await settle(); // the permission prompt is up

    expect(slot.leave()).toBe(true); // the page resets to idle
    expect(slot.busy).toBe(false);
    expect(slot.owns(controller)).toBe(false);
    await expect(started).rejects.toBeInstanceOf(RecorderAbortedError);
    expect(slot.release(controller)).toBe(false); // the start's catch leaves the (already reset) page alone

    const lateStream = new FakeStream();
    micRequests[0].resolve(lateStream);
    await settle();
    expect(lateStream.allStopped).toBe(true);
    expect(slot.claim()).not.toBeNull(); // not stuck: a new recording can start
    expect(uploads).toHaveLength(0);
    expect(log.ends).toEqual([]);
  });

  it("leaving as the start finishes discards the recording it hands back", async () => {
    const slot = new SampleRecordingSlot();
    const { log, events } = recordedEvents();
    const { controller, started } = claimAndStart(slot, events);
    await settle();
    const stream = new FakeStream();
    micRequests[0].resolve(stream);
    const recording = await started;
    expect(slot.leave()).toBe(true); // left before the page took the recording
    expect(slot.started(controller, recording)).toBe(false);
    expect(stream.allStopped).toBe(true);
    await recording.stop();
    expect(uploads).toHaveLength(0);
    expect(log.ends).toEqual(["aborted"]);
  });

  it("leaving while recording releases the microphone and sends nothing more", async () => {
    autoReply = false;
    const slot = new SampleRecordingSlot();
    const { log, events } = recordedEvents();
    const { controller, recording, stream, processor } = await grantAndStart(slot, events);
    feedSpeech(processor, 3.5);
    await settle();

    expect(slot.leave()).toBe(true);
    expect(stream.allStopped).toBe(true);
    expect(slot.busy).toBe(false);
    uploads[0].reply.resolve(okReply());
    await recording.stop();
    expect(uploads.map((u) => [u.seq, u.final])).toEqual([[0, false]]);
    expect(log.ends).toEqual(["aborted"]);
    expect(slot.release(controller)).toBe(false); // onEnd leaves the page alone
  });

  it("leaving right after Stop still sends the final chunk the customer asked to save", async () => {
    autoReply = false;
    const slot = new SampleRecordingSlot();
    const { log, events } = recordedEvents();
    const { controller, recording, processor } = await grantAndStart(slot, events);
    feedSpeech(processor, 3.5);
    await settle();

    const done = slot.stop();
    expect(done).not.toBeNull();
    expect(recording.stopped).toBe(true);
    expect(slot.leave()).toBe(false); // not cancelled: the page isn't reset, onEnd does that
    expect(slot.owns(controller)).toBe(true);

    uploads[0].reply.resolve(okReply());
    await settle();
    expect(uploads.map((u) => [u.seq, u.final])).toEqual([
      [0, false],
      [1, true],
    ]);
    uploads[1].reply.resolve(okReply());
    await done;
    expect(log.chunks).toEqual([0, 1]);
    expect(log.ends).toEqual(["user"]);
    expect(slot.release(controller)).toBe(true); // onEnd resets the page
    expect(slot.busy).toBe(false);
  });

  it("leaving after the recorder stopped itself at the limit also lets the final chunk go", async () => {
    autoReply = false;
    const slot = new SampleRecordingSlot();
    const { log, events } = recordedEvents();
    const { recording, processor } = await grantAndStart(slot, events, { maxSeconds: 4 });
    feedSpeech(processor, 4.5);
    expect(recording.stopped).toBe(true);
    expect(slot.leave()).toBe(false);

    await settle();
    uploads[0].reply.resolve(okReply());
    await settle();
    uploads[1].reply.resolve(okReply());
    await recording.stop();
    expect(uploads.map((u) => [u.seq, u.final])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(log.ends).toEqual(["limit"]);
  });

  it("Revoke & delete (discard) drops everything, even a recording that is already stopping", async () => {
    autoReply = false;
    const slot = new SampleRecordingSlot();
    const { log, events } = recordedEvents();
    const { controller, processor, stream } = await grantAndStart(slot, events);
    feedSpeech(processor, 3.5);
    await settle();

    void slot.stop(); // the final chunk is queued behind seq 0
    const discarded = slot.discard();
    expect(slot.busy).toBe(false);
    expect(slot.owns(controller)).toBe(false);
    uploads[0].reply.resolve(okReply());
    await discarded; // resolves once the upload in flight has finished
    expect(uploads.map((u) => [u.seq, u.final])).toEqual([[0, false]]);
    expect(stream.allStopped).toBe(true);
    expect(log.ends).toEqual(["aborted"]);
  });

  it("discard while still starting cancels the start; discard with nothing owned is a no-op", async () => {
    const slot = new SampleRecordingSlot();
    await slot.discard();
    const { controller, started } = claimAndStart(slot);
    await settle();
    await slot.discard();
    await expect(started).rejects.toBeInstanceOf(RecorderAbortedError);
    expect(slot.release(controller)).toBe(false);
    expect(slot.busy).toBe(false);
  });

  it("a start that fails while still owned is released, so the page resets and shows the reason", async () => {
    const slot = new SampleRecordingSlot();
    const { controller, started } = claimAndStart(slot);
    await settle();
    micRequests[0].reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    await expect(started).rejects.toBeInstanceOf(RecorderError);
    expect(slot.release(controller)).toBe(true);
    expect(slot.busy).toBe(false);
  });

  it("leaving with nothing owned does nothing", () => {
    expect(new SampleRecordingSlot().leave()).toBe(false);
  });
});
