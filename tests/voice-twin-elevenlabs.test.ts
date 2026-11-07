import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The API base is read when lib/elevenlabs/client.ts loads: make sure a stray shell variable can't change it.
vi.hoisted(() => {
  delete process.env.ELEVENLABS_API_BASE;
});

import { ElevenLabsError } from "@/lib/elevenlabs/client";
import { createInstantVoiceClone, deleteVoice, isVoiceNotFound, voiceExists, type CreateCloneInput } from "@/lib/voice-twin/elevenlabs";

const API_KEY = "test-key-not-real";

interface Captured {
  url: string;
  init: RequestInit;
}

/** Stub fetch with a queue of responses (or errors); every call is captured. */
function stubFetch(...responses: (Response | Error)[]): Captured[] {
  const calls: Captured[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function headerMap(init: RequestInit): Map<string, string> {
  return new Map(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
}

const wavA = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
const wavB = new Uint8Array([82, 73, 70, 70, 9, 8, 7]);

function cloneInput(overrides: Partial<CreateCloneInput> = {}): CreateCloneInput {
  return {
    name: "AI Voice Twin – Ben (77777777)",
    description: "AI Voice Twin of the consenting Call Guard account holder.",
    labels: { language: "en" },
    files: [
      { filename: "voice-twin-1.wav", bytes: wavA, contentType: "audio/wav" },
      { filename: "voice-twin-2.wav", bytes: wavB, contentType: "audio/wav" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createInstantVoiceClone", () => {
  it("POSTs multipart form data to /v1/voices/add with the API key and no hand-set Content-Type", async () => {
    const calls = stubFetch(json(200, { voice_id: "voice-123", requires_verification: false }));
    const created = await createInstantVoiceClone(API_KEY, cloneInput());

    expect(created).toEqual({ voiceId: "voice-123", requiresVerification: false });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/voices/add");
    expect(init.method).toBe("POST");
    const headers = headerMap(init);
    expect(headers.get("xi-api-key")).toBe(API_KEY);
    expect(headers.has("content-type")).toBe(false);
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends name, one 'files' part per file (filename + audio/wav), remove_background_noise, labels JSON and description", async () => {
    const calls = stubFetch(json(200, { voice_id: "voice-123" }));
    const input = cloneInput();
    await createInstantVoiceClone(API_KEY, input);

    const form = calls[0].init.body as FormData;
    expect(form.get("name")).toBe(input.name);
    expect(form.get("description")).toBe(input.description);
    expect(form.get("remove_background_noise")).toBe("false");
    expect(typeof form.get("labels")).toBe("string");
    expect(JSON.parse(form.get("labels") as string)).toEqual({ language: "en" });

    const files = form.getAll("files");
    expect(files).toHaveLength(2);
    const expected = [
      { name: "voice-twin-1.wav", bytes: wavA },
      { name: "voice-twin-2.wav", bytes: wavB },
    ];
    for (const [i, part] of files.entries()) {
      expect(part).toBeInstanceOf(Blob);
      const file = part as File;
      expect(file.name).toBe(expected[i].name);
      expect(file.type).toBe("audio/wav");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(expected[i].bytes);
    }
  });

  it("sends remove_background_noise 'true' only when asked, and leaves out empty labels and description", async () => {
    const calls = stubFetch(json(200, { voice_id: "voice-123" }));
    await createInstantVoiceClone(API_KEY, cloneInput({ removeBackgroundNoise: true, labels: {}, description: undefined }));
    const form = calls[0].init.body as FormData;
    expect(form.get("remove_background_noise")).toBe("true");
    expect(form.has("labels")).toBe(false);
    expect(form.has("description")).toBe(false);
  });

  it("parses requires_verification", async () => {
    stubFetch(json(200, { voice_id: "voice-xyz", requires_verification: true }));
    await expect(createInstantVoiceClone(API_KEY, cloneInput())).resolves.toEqual({ voiceId: "voice-xyz", requiresVerification: true });
  });

  it("treats a non-boolean requires_verification as false", async () => {
    stubFetch(json(200, { voice_id: "voice-xyz", requires_verification: "yes" }));
    await expect(createInstantVoiceClone(API_KEY, cloneInput())).resolves.toEqual({ voiceId: "voice-xyz", requiresVerification: false });
  });

  it("throws an ElevenLabsError carrying the status on a non-2xx response", async () => {
    stubFetch(json(422, { detail: [{ loc: ["body", "files"], msg: "field required" }] }));
    const error = await createInstantVoiceClone(API_KEY, cloneInput()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElevenLabsError);
    expect((error as ElevenLabsError).status).toBe(422);
    expect((error as ElevenLabsError).message).toContain("422");
    expect((error as ElevenLabsError).message).toContain("field required");
  });

  it("throws on a 401 with a plain-text body", async () => {
    stubFetch(new Response("Unauthorized", { status: 401 }));
    const error = await createInstantVoiceClone(API_KEY, cloneInput()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElevenLabsError);
    expect((error as ElevenLabsError).status).toBe(401);
    expect((error as ElevenLabsError).message).toContain("Unauthorized");
  });

  it("throws when the response has no voice_id", async () => {
    stubFetch(json(200, { status: "ok" }));
    const error = await createInstantVoiceClone(API_KEY, cloneInput()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElevenLabsError);
    expect((error as ElevenLabsError).message).toMatch(/no voice_id/);
  });

  it("throws when voice_id is empty or not a string", async () => {
    stubFetch(json(200, { voice_id: "" }), json(200, { voice_id: 42 }));
    await expect(createInstantVoiceClone(API_KEY, cloneInput())).rejects.toThrow(/no voice_id/);
    await expect(createInstantVoiceClone(API_KEY, cloneInput())).rejects.toThrow(/no voice_id/);
  });

  it("refuses to send without any audio file (no request made)", async () => {
    const calls = stubFetch();
    await expect(createInstantVoiceClone(API_KEY, cloneInput({ files: [] }))).rejects.toThrow(/at least one audio file/);
    expect(calls).toHaveLength(0);
  });
});

describe("deleteVoice", () => {
  it("DELETEs /v1/voices/{id} (URL-encoded) with the API key → 'deleted' on 200", async () => {
    const calls = stubFetch(json(200, { status: "ok" }));
    await expect(deleteVoice(API_KEY, "voice/1 2")).resolves.toBe("deleted");
    expect(calls[0].url).toBe("https://api.elevenlabs.io/v1/voices/voice%2F1%202");
    expect(calls[0].init.method).toBe("DELETE");
    expect(headerMap(calls[0].init).get("xi-api-key")).toBe(API_KEY);
    expect(calls[0].init.body).toBeUndefined();
  });

  it("→ 'not_found' on 404", async () => {
    stubFetch(json(404, { detail: { status: "not_found", message: "Not found" } }));
    await expect(deleteVoice(API_KEY, "gone")).resolves.toBe("not_found");
  });

  it("→ 'not_found' on a 400 whose message says voice_not_found", async () => {
    stubFetch(json(400, { detail: { status: "voice_not_found", message: "voice_not_found" } }));
    await expect(deleteVoice(API_KEY, "gone")).resolves.toBe("not_found");
  });

  it("→ 'not_found' on a 400 'A voice with the voice_id … was not found.'", async () => {
    stubFetch(json(400, { detail: { status: "voice_not_found", message: "A voice with the voice_id gone was not found." } }));
    await expect(deleteVoice(API_KEY, "gone")).resolves.toBe("not_found");
  });

  it("→ 'not_found' on a 400 whose detail status is voice_not_found even when the message words it differently", async () => {
    stubFetch(json(400, { detail: { status: "voice_not_found", message: "A voice with the voice_id gone could not be found." } }));
    await expect(deleteVoice(API_KEY, "gone")).resolves.toBe("not_found");
  });

  it("throws on a 400 that isn't about a missing voice", async () => {
    stubFetch(json(400, { detail: { status: "invalid_request", message: "Something else went wrong" } }));
    await expect(deleteVoice(API_KEY, "v")).rejects.toBeInstanceOf(ElevenLabsError);
  });

  it("throws on 500", async () => {
    stubFetch(json(500, { detail: "Internal Server Error" }));
    const error = await deleteVoice(API_KEY, "v").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElevenLabsError);
    expect((error as ElevenLabsError).status).toBe(500);
  });

  it("throws on 401 (a wrong key must not look like a deleted voice)", async () => {
    stubFetch(json(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }));
    await expect(deleteVoice(API_KEY, "v")).rejects.toBeInstanceOf(ElevenLabsError);
  });

  it("throws when the network fails", async () => {
    stubFetch(new TypeError("fetch failed"));
    await expect(deleteVoice(API_KEY, "v")).rejects.toThrow("fetch failed");
  });
});

describe("voiceExists", () => {
  it("GETs /v1/voices/{id} → true on 200", async () => {
    const calls = stubFetch(json(200, { voice_id: "v", name: "AI Voice Twin" }));
    await expect(voiceExists(API_KEY, "v")).resolves.toBe(true);
    expect(calls[0].url).toBe("https://api.elevenlabs.io/v1/voices/v");
    expect(calls[0].init.method).toBe("GET");
    expect(headerMap(calls[0].init).get("xi-api-key")).toBe(API_KEY);
  });

  it("→ false on 404 and on a 400 voice_not_found", async () => {
    stubFetch(json(404, { detail: "Not Found" }), json(400, { detail: { status: "voice_not_found", message: "voice_not_found" } }));
    await expect(voiceExists(API_KEY, "v")).resolves.toBe(false);
    await expect(voiceExists(API_KEY, "v")).resolves.toBe(false);
  });

  it("→ null when it can't tell (5xx, auth error, network error)", async () => {
    stubFetch(json(503, { detail: "unavailable" }), json(401, { detail: "unauthorised" }), new TypeError("fetch failed"));
    await expect(voiceExists(API_KEY, "v")).resolves.toBeNull();
    await expect(voiceExists(API_KEY, "v")).resolves.toBeNull();
    await expect(voiceExists(API_KEY, "v")).resolves.toBeNull();
  });
});

describe("isVoiceNotFound", () => {
  it("only recognises ElevenLabs errors about a missing voice", () => {
    expect(isVoiceNotFound(new ElevenLabsError("x → 404: Not Found", 404, null))).toBe(true);
    expect(isVoiceNotFound(new ElevenLabsError("x → 400: voice_not_found", 400, null))).toBe(true);
    expect(isVoiceNotFound(new ElevenLabsError("x → 422: Voice does not exist", 422, null))).toBe(true);
    expect(isVoiceNotFound(new ElevenLabsError("x → 400: bad request", 400, null))).toBe(false);
    expect(isVoiceNotFound(new ElevenLabsError("x → 500: not found", 500, null))).toBe(false);
    expect(isVoiceNotFound(new Error("404 not found"))).toBe(false);
    expect(isVoiceNotFound("not found")).toBe(false);
  });

  it("reads the detail status when the message doesn't say it", () => {
    const body = { detail: { status: "voice_not_found", message: "A voice with that id could not be found." } };
    expect(isVoiceNotFound(new ElevenLabsError("x → 400: A voice with that id could not be found.", 400, body))).toBe(true);
    const other = { detail: { status: "quota_exceeded", message: "Quota exceeded" } };
    expect(isVoiceNotFound(new ElevenLabsError("x → 400: Quota exceeded", 400, other))).toBe(false);
  });
});
