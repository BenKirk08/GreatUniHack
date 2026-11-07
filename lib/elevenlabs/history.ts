import { cleanToolFields } from "@/lib/intel";
import type { ToolFields, TranscriptTurn } from "@/lib/types";
import type { PostCallTranscriptItem } from "@/lib/elevenlabs/webhook";

/** Expressive-mode audio tags ("[laughs]", "[sighs]") that eleven_v4_turbo may put in the persona's text. */
const AUDIO_TAG = /\[(?:[a-z]+(?:\s[a-z]+){0,3})\]\s*/gi;

function cleanMessage(role: TranscriptTurn["role"], message: string): string {
  const text = role === "agent" ? message.replace(AUDIO_TAG, "") : message;
  return text.replace(/\s+/g, " ").trim();
}

/** ElevenLabs roles → ours. "user" is the caller the persona took over from the customer: the scammer. */
function mapRole(role: unknown): TranscriptTurn["role"] | null {
  if (role === "user") return "scammer";
  if (role === "agent") return "agent";
  return null; // "tool" entries and anything unknown are not speech
}

/**
 * Parse `system__conversation_history` as passed to the record_details tool:
 * a JSON string like {"x-elevenlabs-history": true, "entries": [{role, message} | {role, tool_requests} | {role:"tool", tool_results}]}.
 * Also tolerates an already-parsed object or a bare array of entries. Never throws.
 */
export function parseConversationHistory(input: unknown): TranscriptTurn[] {
  let value: unknown = input;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "None" || trimmed === "null") return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  const entries: unknown = Array.isArray(value)
    ? value
    : value && typeof value === "object" && "entries" in value
      ? (value as { entries: unknown }).entries
      : [];
  if (!Array.isArray(entries)) return [];

  const turns: TranscriptTurn[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const role = mapRole(e.role);
    if (!role || typeof e.message !== "string") continue;
    const message = cleanMessage(role, e.message);
    if (!message) continue;
    const t = typeof e.time_in_call_secs === "number" ? e.time_in_call_secs : undefined;
    turns.push(t === undefined ? { role, message } : { role, message, time_in_call_secs: t });
  }
  return turns;
}

/** Final transcript from a post_call_transcription webhook. */
export function transcriptFromPostCall(items: PostCallTranscriptItem[] | null | undefined): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const item of items ?? []) {
    const role = mapRole(item.role);
    if (!role || typeof item.message !== "string") continue;
    const message = cleanMessage(role, item.message);
    if (!message) continue;
    turns.push(
      typeof item.time_in_call_secs === "number"
        ? { role, message, time_in_call_secs: item.time_in_call_secs }
        : { role, message },
    );
  }
  return turns;
}

/** Merge every record_details call's arguments from a post-call transcript (later calls win per field). */
export function toolFieldsFromPostCall(items: PostCallTranscriptItem[] | null | undefined, toolName = "record_details"): ToolFields {
  let merged: ToolFields = {};
  for (const item of items ?? []) {
    for (const call of item.tool_calls ?? []) {
      if (call.tool_name !== toolName || call.params_as_json == null) continue;
      let params: unknown = call.params_as_json;
      if (typeof params === "string") {
        try {
          params = JSON.parse(params);
        } catch {
          continue;
        }
      }
      if (params && typeof params === "object") merged = { ...merged, ...cleanToolFields(params as Record<string, unknown>) };
    }
  }
  return merged;
}

/** Treat ElevenLabs' various "no value" spellings as missing. */
export function presentString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v || v === "None" || v === "null" || v === "undefined" || v.startsWith("{{")) return undefined;
  return v;
}
