/** Minimal ElevenLabs REST client (plain fetch). Base URL is the default production API. */
export const ELEVENLABS_API_BASE = process.env.ELEVENLABS_API_BASE ?? "https://api.elevenlabs.io";

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

/** ElevenLabs errors are either {detail: {...message}} or FastAPI's {detail: [{loc, msg}]}. */
function describeError(body: unknown): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (Array.isArray(detail)) {
      return detail.map((d) => `${(d as { loc?: unknown[] }).loc?.join(".") ?? ""}: ${(d as { msg?: string }).msg ?? ""}`).join("; ");
    }
    if (detail && typeof detail === "object" && "message" in detail) return String((detail as { message: unknown }).message);
    return JSON.stringify(detail);
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}

export async function elevenLabsFetch<T>(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(path, ELEVENLABS_API_BASE);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      "xi-api-key": apiKey,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }
  if (!res.ok) {
    throw new ElevenLabsError(`ElevenLabs ${init.method ?? "GET"} ${url.pathname} → ${res.status}: ${describeError(body)}`, res.status, body);
  }
  return body as T;
}
