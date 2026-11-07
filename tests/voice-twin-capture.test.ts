import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCallStream, TwilioError } from "@/lib/twilio";
import {
  bridgeStreamUrl,
  shortSid,
  startVictimCapture,
  STREAM_TOKEN_TTL_SECONDS,
  streamToken,
  verifyStreamToken,
  type CaptureDeps,
  type StreamTokenPayload,
} from "@/lib/voice-twin/capture";
import { MemoryVoiceTwin } from "@/lib/voice-twin/memory-store";

const SECRET = "tool-secret-0123456789abcdef";
const CALL_ID = "11111111-1111-4111-8111-111111111111";
const PARENT = `CA${"a".repeat(32)}`;
const CHILD = `CA${"b".repeat(32)}`;
const STREAM_SID = `MZ${"c".repeat(32)}`;
const BRIDGE_URL = "https://quiet-otter.ngrok-free.app";

type StartStream = CaptureDeps["startStream"];

/** A consenting, collecting twin, a live screened call, a bridge that just checked in. */
function world(setup: (m: MemoryVoiceTwin) => void = (m) => m.withConsent()) {
  const m = new MemoryVoiceTwin();
  setup(m);
  m.addCall({ id: CALL_ID, twilio_call_sid: PARENT });
  void m.store.heartbeatBridge({ id: "laptop-8787", publicUrl: BRIDGE_URL });
  const startStream = vi.fn<StartStream>(async () => ({ sid: STREAM_SID }));
  const deps: CaptureDeps = { store: m.store, startStream, secret: () => SECRET, now: () => m.clock };
  return { m, deps, startStream };
}

const input = { parentCallSid: PARENT, childCallSid: CHILD };

describe("startVictimCapture: the consent gate", () => {
  it("never touches Twilio for an account holder with no twin (never consented)", async () => {
    const { deps, startStream } = world(() => undefined);
    expect(await startVictimCapture(input, deps)).toEqual({ started: false, reason: "no_consent" });
    expect(startStream).not.toHaveBeenCalled();
  });

  it("never touches Twilio when the twin exists without consent, even with a live call and a running bridge", async () => {
    const { m, deps, startStream } = world((w) => void w.store.ensureTwin());
    expect(m.twin?.voice_twin_consent).toBe(false);
    expect(await startVictimCapture(input, deps)).toEqual({ started: false, reason: "no_consent" });
    expect(startStream).not.toHaveBeenCalled();
  });

  it("never touches Twilio after consent was revoked", async () => {
    const { m, deps, startStream } = world();
    await m.store.revoke({ by: "Ben", userAgent: null });
    expect(await startVictimCapture(input, deps)).toEqual({ started: false, reason: "no_consent" });
    expect(startStream).not.toHaveBeenCalled();
  });

  it("never touches Twilio for a consent with no recorded time (nothing to bind the stream token to)", async () => {
    const { deps, startStream } = world((m) => m.withConsent({ consent_given_at: null }));
    expect(await startVictimCapture(input, deps)).toEqual({ started: false, reason: "no_consent" });
    expect(startStream).not.toHaveBeenCalled();
  });
});

describe("startVictimCapture: the other gates", () => {
  it.each(["ready", "cloning"] as const)("doesn't capture when the twin is %s (not_needed)", async (state) => {
    const { deps, startStream } = world((m) =>
      m.withConsent({
        state,
        speech_seconds: 45,
        ...(state === "ready" ? { voice_id: "cloned-voice-1", voice_source: "clone", voice_expires_at: "2026-11-07T12:00:00.000Z" } : {}),
      }),
    );
    expect(await startVictimCapture(input, deps)).toEqual({ started: false, reason: "not_needed" });
    expect(startStream).not.toHaveBeenCalled();
  });

  it("still captures for a failed twin (so a retry has more to work with)", async () => {
    const { deps, startStream } = world((m) => m.withConsent({ state: "failed", speech_seconds: 12 }));
    expect((await startVictimCapture(input, deps)).started).toBe(true);
    expect(startStream).toHaveBeenCalledOnce();
  });

  it("doesn't capture for an ended or unknown call (no_call)", async () => {
    const ended = world();
    ended.m.calls.get(CALL_ID)!.status = "ended";
    expect(await startVictimCapture(input, ended.deps)).toEqual({ started: false, reason: "no_call" });
    expect(ended.startStream).not.toHaveBeenCalled();

    const unknown = world();
    expect(await startVictimCapture({ parentCallSid: `CA${"d".repeat(32)}`, childCallSid: CHILD }, unknown.deps)).toEqual({
      started: false,
      reason: "no_call",
    });
    expect(unknown.startStream).not.toHaveBeenCalled();
  });

  it("doesn't capture without a bridge, with a stale one, or with one Twilio can't reach over wss (no_bridge)", async () => {
    const none = world();
    none.m.bridges.clear();
    expect(await startVictimCapture(input, none.deps)).toEqual({ started: false, reason: "no_bridge" });
    expect(none.startStream).not.toHaveBeenCalled();

    const stale = world();
    stale.m.clock += 2 * 60_000; // heartbeat 2 min old
    expect(await startVictimCapture(input, stale.deps)).toEqual({ started: false, reason: "no_bridge" });
    expect(stale.startStream).not.toHaveBeenCalled();

    const plain = world();
    await plain.m.store.heartbeatBridge({ id: "laptop-8787", publicUrl: "http://localhost:8787" });
    expect(await startVictimCapture(input, plain.deps)).toEqual({ started: false, reason: "no_bridge" });
    expect(plain.startStream).not.toHaveBeenCalled();
  });

  it("reports a Twilio failure without throwing", async () => {
    const { deps, startStream } = world();
    startStream.mockRejectedValueOnce(new TwilioError("Twilio POST /…/Streams.json → 400: nope", 400, 21220, null));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await startVictimCapture(input, deps)).toEqual({ started: false, reason: "twilio_error" });
      const logged = error.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain(CHILD);
      expect(logged).toContain("21220");
    } finally {
      error.mockRestore();
    }
  });
});

describe("startVictimCapture: the stream it starts", () => {
  it("streams only the customer's inbound track on the CHILD leg to the bridge's wss /media, with a token for this call", async () => {
    const { m, deps, startStream } = world();
    expect(await startVictimCapture(input, deps)).toEqual({ started: true, streamSid: STREAM_SID });
    expect(startStream).toHaveBeenCalledOnce();
    const [callSid, opts] = startStream.mock.calls[0];
    expect(callSid).toBe(CHILD);
    expect(callSid).not.toBe(PARENT);
    expect(opts.track).toBe("inbound_track");
    expect(opts.name).toBe("voice-twin");
    expect(opts.url).toBe("wss://quiet-otter.ngrok-free.app/media");
    expect(opts.url).toMatch(/^wss:\/\/.*\/media$/);
    expect(Object.keys(opts.parameters)).toEqual(["token"]);

    const payload = verifyStreamToken(opts.parameters.token, SECRET, m.clock);
    expect(payload).toEqual({
      callId: CALL_ID,
      twinId: m.twin!.id,
      childCallSid: CHILD,
      consentAt: m.twin!.consent_given_at,
      exp: Math.floor(m.clock / 1000) + STREAM_TOKEN_TTL_SECONDS,
    });
    expect(STREAM_TOKEN_TTL_SECONDS).toBe(2 * 60 * 60);
    // Within Twilio's custom-parameter size limits.
    expect(opts.parameters.token.length).toBeLessThan(400);
  });

  it("binds the token to the consent it was made under: after a revoke and a new consent, a new stream carries the new time", async () => {
    const { m, deps, startStream } = world();
    const firstConsent = m.twin!.consent_given_at!;
    await startVictimCapture(input, deps);

    await m.store.revoke({ by: "Ben", userAgent: null });
    m.clock += 60_000;
    await m.store.giveConsent({ by: "Ben", userAgent: null, textVersion: "test" });
    await m.store.heartbeatBridge({ id: "laptop-8787", publicUrl: BRIDGE_URL });
    expect(m.twin!.consent_given_at).not.toBe(firstConsent);
    await startVictimCapture(input, deps);

    expect(startStream).toHaveBeenCalledTimes(2);
    const [first, second] = startStream.mock.calls.map(([, opts]) => verifyStreamToken(opts.parameters.token, SECRET, m.clock));
    expect(first?.consentAt).toBe(firstConsent);
    expect(second?.consentAt).toBe(m.twin!.consent_given_at);
    expect(second?.consentAt).not.toBe(first?.consentAt);
  });

  it("converts the bridge's public URL to its wss /media endpoint", () => {
    expect(bridgeStreamUrl("https://quiet-otter.ngrok-free.app")).toBe("wss://quiet-otter.ngrok-free.app/media");
    expect(bridgeStreamUrl("https://quiet-otter.ngrok-free.app/")).toBe("wss://quiet-otter.ngrok-free.app/media");
    expect(bridgeStreamUrl("HTTPS://bridge.example:8443/twin/")).toBe("wss://bridge.example:8443/twin/media");
    expect(bridgeStreamUrl("wss://bridge.example")).toBe("wss://bridge.example/media");
    expect(bridgeStreamUrl("https://bridge.example/?x=1#y")).toBe("wss://bridge.example/media");
    expect(bridgeStreamUrl("http://localhost:8787")).toBeNull();
    expect(bridgeStreamUrl("ws://localhost:8787")).toBeNull();
    expect(bridgeStreamUrl("not a url")).toBeNull();
  });

  it("logs SIDs shortened", () => {
    expect(shortSid(CHILD)).toBe("CA…bbbbbb");
    expect(shortSid(CHILD)).not.toContain(CHILD.slice(2, 20));
  });
});

describe("stream tokens", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  const payload: StreamTokenPayload = {
    callId: CALL_ID,
    twinId: "77777777-7777-4777-8777-777777777777",
    childCallSid: CHILD,
    consentAt: "2026-11-06T11:00:00.123456+00:00", // as PostgREST returns a timestamptz
    exp: now / 1000 + 7200,
  };

  /** A correctly signed token over an arbitrary payload (to test what verification does with odd contents). */
  const signRaw = (body: string, secret = SECRET) => {
    const encoded = Buffer.from(body, "utf8").toString("base64url");
    return `${encoded}.${createHmac("sha256", secret).update(`voice-twin-stream/v1.${encoded}`).digest("base64url")}`;
  };

  it("round-trips and has the documented format", () => {
    const token = streamToken(payload, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(token).toBe(signRaw(JSON.stringify(payload)));
    expect(verifyStreamToken(token, SECRET, now)).toEqual(payload);
  });

  it("carries the consent time verbatim", () => {
    expect(verifyStreamToken(streamToken(payload, SECRET), SECRET, now)?.consentAt).toBe("2026-11-06T11:00:00.123456+00:00");
    const iso = { ...payload, consentAt: "2026-11-06T11:00:00.000Z" };
    expect(verifyStreamToken(streamToken(iso, SECRET), SECRET, now)?.consentAt).toBe("2026-11-06T11:00:00.000Z");
  });

  it("rejects a tampered consent time (a token can't be moved onto a newer consent)", () => {
    const [, sig] = streamToken(payload, SECRET).split(".");
    for (const consentAt of ["2026-11-06T12:30:00.000Z", "2026-11-06T11:00:00.123457+00:00", ""]) {
      const forged = Buffer.from(JSON.stringify({ ...payload, consentAt })).toString("base64url");
      expect(verifyStreamToken(`${forged}.${sig}`, SECRET, now)).toBeNull();
    }
    const withoutConsent: Partial<StreamTokenPayload> = { ...payload };
    delete withoutConsent.consentAt;
    const stripped = Buffer.from(JSON.stringify(withoutConsent)).toString("base64url");
    expect(verifyStreamToken(`${stripped}.${sig}`, SECRET, now)).toBeNull();
  });

  it("rejects a tampered payload or signature", () => {
    const token = streamToken(payload, SECRET);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, callId: "22222222-2222-4222-8222-222222222222" })).toString("base64url");
    expect(verifyStreamToken(`${forged}.${sig}`, SECRET, now)).toBeNull();
    const flipped = body.slice(0, 10) + (body[10] === "A" ? "B" : "A") + body.slice(11);
    expect(verifyStreamToken(`${flipped}.${sig}`, SECRET, now)).toBeNull();
    const badSig = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(verifyStreamToken(`${body}.${badSig}`, SECRET, now)).toBeNull();
  });

  it("rejects the wrong secret, and refuses to work without one", () => {
    expect(verifyStreamToken(streamToken(payload, SECRET), "another-secret-0123456789", now)).toBeNull();
    expect(verifyStreamToken(streamToken(payload, SECRET), "", now)).toBeNull();
    expect(verifyStreamToken(streamToken(payload, SECRET), undefined, now)).toBeNull();
    expect(() => streamToken(payload, "")).toThrow();
  });

  it("rejects expired tokens and tokens claiming more than 3 h of life", () => {
    const token = streamToken(payload, SECRET);
    expect(verifyStreamToken(token, SECRET, payload.exp * 1000 - 1)).toEqual(payload);
    expect(verifyStreamToken(token, SECRET, payload.exp * 1000)).toBeNull();
    expect(verifyStreamToken(token, SECRET, payload.exp * 1000 + 60_000)).toBeNull();
    const longLived = streamToken({ ...payload, exp: now / 1000 + 3 * 3600 + 60 }, SECRET);
    expect(verifyStreamToken(longLived, SECRET, now)).toBeNull();
    const threeHours = streamToken({ ...payload, exp: now / 1000 + 3 * 3600 }, SECRET);
    expect(verifyStreamToken(threeHours, SECRET, now)).not.toBeNull();
  });

  it("rejects malformed tokens, even correctly signed ones", () => {
    for (const bad of ["", "abc", "a.b.c", ".", "abc.", ".abc", "a+b/c=.def", "x".repeat(2000), `${streamToken(payload, SECRET)}.x`]) {
      expect(verifyStreamToken(bad, SECRET, now)).toBeNull();
    }
    expect(verifyStreamToken(null, SECRET, now)).toBeNull();
    expect(verifyStreamToken(signRaw("not json"), SECRET, now)).toBeNull();
    expect(verifyStreamToken(signRaw("[1,2]"), SECRET, now)).toBeNull();
    expect(verifyStreamToken(signRaw(JSON.stringify({ ...payload, childCallSid: "CAxyz" })), SECRET, now)).toBeNull();
    expect(verifyStreamToken(signRaw(JSON.stringify({ ...payload, callId: "not-a-uuid" })), SECRET, now)).toBeNull();
    expect(verifyStreamToken(signRaw(JSON.stringify({ ...payload, exp: "soon" })), SECRET, now)).toBeNull();
    expect(verifyStreamToken(signRaw(JSON.stringify({ ...payload, extra: true })), SECRET, now)).toBeNull();
    const noExp: Partial<StreamTokenPayload> = { ...payload };
    delete noExp.exp;
    expect(verifyStreamToken(signRaw(JSON.stringify(noExp)), SECRET, now)).toBeNull();
    // The consent time: required, a timestamp, a string, not absurdly long (even when correctly signed).
    const noConsent: Partial<StreamTokenPayload> = { ...payload };
    delete noConsent.consentAt;
    expect(verifyStreamToken(signRaw(JSON.stringify(noConsent)), SECRET, now)).toBeNull();
    for (const consentAt of ["", "yesterday", 1_762_426_800_000, null, `2026-11-06T11:00:00.000Z${" ".repeat(60)}`]) {
      expect(verifyStreamToken(signRaw(JSON.stringify({ ...payload, consentAt })), SECRET, now)).toBeNull();
    }
  });
});

describe("startCallStream (Twilio REST: Start a Stream)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const creds = { accountSid: `AC${"1".repeat(32)}`, username: `SK${"2".repeat(32)}`, password: "key-secret" };

  it("POSTs Url, Name, Track and numbered custom parameters as a form to /Calls/{sid}/Streams.json", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ sid: STREAM_SID, status: "in-progress", name: "voice-twin" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await startCallStream(creds, CHILD, {
      url: "wss://quiet-otter.ngrok-free.app/media",
      name: "voice-twin",
      track: "inbound_track",
      parameters: { token: "abc.def", note: "a&b=c d" },
      timeoutMs: 1000,
    });
    expect(result).toEqual({ sid: STREAM_SID });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Calls/${CHILD}/Streams.json`);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`);
    const form = new URLSearchParams(String(init?.body));
    expect([...form.entries()]).toEqual([
      ["Url", "wss://quiet-otter.ngrok-free.app/media"],
      ["Name", "voice-twin"],
      ["Track", "inbound_track"],
      ["Parameter1.Name", "token"],
      ["Parameter1.Value", "abc.def"],
      ["Parameter2.Name", "note"],
      ["Parameter2.Value", "a&b=c d"],
    ]);
  });

  it("throws a TwilioError when Twilio refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: 20404, message: "The requested resource was not found" }), { status: 404 })),
    );
    await expect(
      startCallStream(creds, CHILD, { url: "wss://x.example/media", name: "voice-twin", track: "inbound_track", parameters: {} }),
    ).rejects.toBeInstanceOf(TwilioError);
  });
});
