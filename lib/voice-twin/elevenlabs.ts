import { ELEVENLABS_API_BASE, elevenLabsFetch, ElevenLabsError } from "@/lib/elevenlabs/client";

/**
 * ElevenLabs Instant Voice Cloning for the AI Voice Twin (docs: /docs/api-reference/voices/ivc/create, /voices/delete).
 *   POST   /v1/voices/add          multipart/form-data: name, files (one part per file), remove_background_noise,
 *                                  description, labels (JSON string) → { voice_id, requires_verification }
 *   DELETE /v1/voices/{voice_id}   → { status: "ok" }
 *   GET    /v1/voices/{voice_id}   → the voice (404 when it doesn't exist)
 */

export interface CloneFile {
  filename: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface CreateCloneInput {
  name: string;
  description?: string;
  /** Allowed keys: language, accent, gender, age. */
  labels?: Record<string, string>;
  files: CloneFile[];
  /** The docs warn this can make clean samples worse; off by default. */
  removeBackgroundNoise?: boolean;
  timeoutMs?: number;
}

export interface CreatedClone {
  voiceId: string;
  /** True when the samples matched a protected voice: the voice can't be used until verified. */
  requiresVerification: boolean;
}

/** POST /v1/voices/add (multipart). fetch sets the multipart boundary itself, so Content-Type is not set by hand. */
export async function createInstantVoiceClone(apiKey: string, input: CreateCloneInput): Promise<CreatedClone> {
  if (input.files.length === 0) throw new Error("Instant Voice Cloning needs at least one audio file.");
  const form = new FormData();
  form.append("name", input.name);
  for (const file of input.files) {
    form.append("files", new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.contentType }), file.filename);
  }
  form.append("remove_background_noise", input.removeBackgroundNoise ? "true" : "false");
  if (input.description) form.append("description", input.description);
  if (input.labels && Object.keys(input.labels).length) form.append("labels", JSON.stringify(input.labels));

  const url = new URL("/v1/voices/add", ELEVENLABS_API_BASE);
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(input.timeoutMs ?? 45_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }
  if (!res.ok) {
    throw new ElevenLabsError(`ElevenLabs POST /v1/voices/add → ${res.status}: ${describe(body)}`, res.status, body);
  }
  const parsed = body as { voice_id?: unknown; requires_verification?: unknown } | null;
  if (!parsed || typeof parsed.voice_id !== "string" || !parsed.voice_id) {
    throw new ElevenLabsError("ElevenLabs POST /v1/voices/add returned no voice_id", res.status, body);
  }
  return { voiceId: parsed.voice_id, requiresVerification: parsed.requires_verification === true };
}

/**
 * A 404, or a 400/422 whose message or detail status (e.g. {detail: {status: "voice_not_found"}}) says the voice isn't
 * there: the voice is already gone.
 */
export function isVoiceNotFound(error: unknown): boolean {
  if (!(error instanceof ElevenLabsError)) return false;
  if (error.status === 404) return true;
  if (error.status !== 400 && error.status !== 422) return false;
  return /not[_ ]found|does[_ ]not[_ ]exist/i.test(`${error.message} ${detailStatus(error.body)}`);
}

/** The machine-readable code in ElevenLabs' {detail: {status}} error bodies, or "". */
function detailStatus(body: unknown): string {
  if (!body || typeof body !== "object" || !("detail" in body)) return "";
  const detail = (body as { detail: unknown }).detail;
  return detail && typeof detail === "object" && "status" in detail && typeof detail.status === "string" ? detail.status : "";
}

/** DELETE /v1/voices/{id}. Idempotent: a voice that is already gone counts as deleted. */
export async function deleteVoice(apiKey: string, voiceId: string, timeoutMs = 15_000): Promise<"deleted" | "not_found"> {
  try {
    await elevenLabsFetch(apiKey, `/v1/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE", timeoutMs });
    return "deleted";
  } catch (error) {
    if (isVoiceNotFound(error)) return "not_found";
    throw error;
  }
}

/** GET /v1/voices/{id}: true if it exists, false on 404, null when we couldn't tell (timeout, 5xx). */
export async function voiceExists(apiKey: string, voiceId: string, timeoutMs = 2_500): Promise<boolean | null> {
  try {
    await elevenLabsFetch(apiKey, `/v1/voices/${encodeURIComponent(voiceId)}`, { timeoutMs });
    return true;
  } catch (error) {
    if (isVoiceNotFound(error)) return false;
    return null;
  }
}

function describe(body: unknown): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (Array.isArray(detail)) return detail.map((d) => `${(d as { msg?: string }).msg ?? JSON.stringify(d)}`).join("; ");
    if (detail && typeof detail === "object" && "message" in detail) return String((detail as { message: unknown }).message);
    return JSON.stringify(detail);
  }
  return typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body);
}

export interface ListedVoice {
  voiceId: string;
  name: string | null;
  description: string | null;
  /** Creation time (Unix seconds), when ElevenLabs reports it. */
  createdAtUnix: number | null;
}

/**
 * GET /v2/voices?search=…&voice_type=personal (docs: /docs/api-reference/voices/search; the search covers name,
 * description, labels and category). Used to find AI Voice Twin clones the app made but never recorded (a run that was
 * killed or timed out after ElevenLabs created the voice). Follows next_page_token for up to 5 pages of 100.
 */
export async function searchPersonalVoices(apiKey: string, search: string, timeoutMs = 10_000): Promise<ListedVoice[]> {
  const out: ListedVoice[] = [];
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const body = await elevenLabsFetch<{
      voices?: { voice_id?: unknown; name?: unknown; description?: unknown; created_at_unix?: unknown }[];
      has_more?: boolean;
      next_page_token?: string | null;
    }>(apiKey, "/v2/voices", {
      query: { search, voice_type: "personal", page_size: "100", include_total_count: "false", next_page_token: token },
      timeoutMs,
    });
    for (const v of body.voices ?? []) {
      if (typeof v.voice_id !== "string" || !v.voice_id) continue;
      out.push({
        voiceId: v.voice_id,
        name: typeof v.name === "string" ? v.name : null,
        description: typeof v.description === "string" ? v.description : null,
        createdAtUnix: typeof v.created_at_unix === "number" ? v.created_at_unix : null,
      });
    }
    if (!body.has_more || !body.next_page_token) break;
    token = body.next_page_token;
  }
  return out;
}
