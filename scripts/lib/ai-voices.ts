import { AI_VOICE_IDS, ELEVENLABS_AI_VOICE_IDS, type AiVoiceId } from "../../lib/ai-voices/config";
import { ElevenLabsError } from "../../lib/elevenlabs/client";
import { PERSONAS } from "../../lib/persona-meta";
import { voiceDescription } from "../../lib/voice-match";

export type ElevenLabsCall = <T>(
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string | undefined>; timeoutMs?: number },
) => Promise<T>;

export interface AiVoiceStatus {
  voice: AiVoiceId;
  voiceId: string;
  state: "in_my_voices" | "added" | "would_add" | "missing";
  name?: string;
  detail?: string;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ElevenLabsError && (error.status === 404 || (error.status === 400 && /not.?found/i.test(error.message)));
}

/**
 * Make sure every AI voice (lib/ai-voices/config.ts) is in the account's My Voices with exactly its configured ID.
 *  - GET /v1/voices/{id} answers → already in My Voices.
 *  - Otherwise look it up in the public Voice Library (GET /v1/shared-voices?search={id}) and add it with
 *    POST /v1/voices/add/{public_owner_id}/{id} (docs: /docs/api-reference/voices/voice-library/share), then confirm
 *    GET /v1/voices/{id} answers with the SAME ID. ElevenLabs returns the added voice's ID; if it ever differs, that is
 *    reported as a failure (the config would have to change), never written anywhere silently.
 * With checkOnly nothing is added.
 */
export async function ensureAiVoices(el: ElevenLabsCall, opts: { checkOnly: boolean }): Promise<AiVoiceStatus[]> {
  const out: AiVoiceStatus[] = [];
  for (const voice of AI_VOICE_IDS) {
    const voiceId = ELEVENLABS_AI_VOICE_IDS[voice];
    const persona = PERSONAS[voice];
    try {
      const mine = await el<{ voice_id: string; name: string }>(`/v1/voices/${voiceId}`);
      out.push({ voice, voiceId, state: "in_my_voices", name: mine.name });
      continue;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const shared = await el<{ voices: { voice_id: string; public_owner_id: string; name: string }[] }>("/v1/shared-voices", {
      query: { search: voiceId, page_size: "10" },
    });
    const match = shared.voices.find((v) => v.voice_id === voiceId);
    if (!match) {
      out.push({ voice, voiceId, state: "missing", detail: "neither in My Voices nor in the public Voice Library" });
      continue;
    }
    if (opts.checkOnly) {
      out.push({ voice, voiceId, state: "would_add", name: match.name, detail: "in the Voice Library, not yet in My Voices" });
      continue;
    }
    const label = `Call Guard ${voiceDescription({ age_band: persona.ageBand, gender: persona.gender })} – ${match.name}`;
    const added = await el<{ voice_id: string }>(`/v1/voices/add/${match.public_owner_id}/${voiceId}`, {
      method: "POST",
      body: { new_name: label.slice(0, 100) },
    });
    if (added.voice_id && added.voice_id !== voiceId) {
      out.push({ voice, voiceId, state: "missing", detail: `ElevenLabs added it under a different ID (${added.voice_id}), not ${voiceId}` });
      continue;
    }
    const check = await el<{ voice_id: string; name: string }>(`/v1/voices/${voiceId}`);
    out.push({ voice, voiceId, state: "added", name: check.name });
  }
  return out;
}

/** "✔ older female (Joan Whitaker) RILOU7YmBhvwJGDGjNmP: in My Voices as "…"". */
export function describeAiVoiceStatus(s: AiVoiceStatus): string {
  const p = PERSONAS[s.voice];
  const who = `${voiceDescription({ age_band: p.ageBand, gender: p.gender })} (${p.name}) ${s.voiceId}`;
  switch (s.state) {
    case "in_my_voices":
      return `✔ ${who}: in My Voices as "${s.name}"`;
    case "added":
      return `✔ ${who}: added from the Voice Library to My Voices as "${s.name}" (same ID)`;
    case "would_add":
      return `… ${who}: would add "${s.name}" from the Voice Library to My Voices`;
    case "missing":
      return `✘ ${who}: ${s.detail}`;
  }
}
