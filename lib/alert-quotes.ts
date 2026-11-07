import { RISK_KEYWORDS } from "@/lib/risk-keywords";
import type { ScreeningSegment } from "@/lib/types";

/**
 * The quotes on the customer's scam alert: the most suspicious things the CALLER has said, word for word. Claude picks
 * them while scoring the call (lib/risk.ts); this module only lets through text that is really in one of the caller's
 * own lines, and returns it exactly as transcribed. Pure and client-safe.
 */

/** At most this many quotes are shown. */
export const MAX_ALERT_QUOTES = 2;
/** Quotes shorter than this (letters and digits) say nothing; longer than this don't fit the alert. */
const MIN_QUOTE_CHARS = 8;
const MAX_QUOTE_CHARS = 220;

/** Letters and digits only, lower case, with the index in `text` each kept character came from. */
function squashWithMap(text: string): { squashed: string; map: number[] } {
  let squashed = "";
  const map: number[] = [];
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (/[\p{L}\p{N}£]/u.test(ch)) {
      squashed += ch;
      map.push(i);
    }
  }
  return { squashed, map };
}

const WORD_CHAR = /[\p{L}\p{N}£'’]/u;
const CLOSING = /[?!.…%)\]]/;

/**
 * Where `quote` appears in `line` (ignoring case, punctuation and spacing), as the exact span of `line`: from the
 * start of the first matched word to the end of the last, plus closing punctuation directly after it. Null if it
 * isn't there.
 */
export function findVerbatim(quote: string, line: string): string | null {
  const q = squashWithMap(quote).squashed;
  if (q.length < MIN_QUOTE_CHARS) return null;
  const { squashed, map } = squashWithMap(line);
  const at = squashed.indexOf(q);
  if (at < 0) return null;
  // Widen to whole words (a quote never starts or ends mid-word), then take closing punctuation right after it.
  let start = map[at];
  while (start > 0 && WORD_CHAR.test(line[start - 1])) start--;
  let end = map[at + q.length - 1] + 1;
  while (end < line.length && WORD_CHAR.test(line[end])) end++;
  while (end < line.length && CLOSING.test(line[end])) end++;
  return line.slice(start, end).trim();
}

/** The caller's non-empty lines (the customer's lines are never quoted). */
function callerLines(segments: readonly Pick<ScreeningSegment, "speaker" | "text">[]): string[] {
  return segments
    .filter((s) => s.speaker === "caller")
    .map((s) => (s.text ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Up to `max` (2) of `candidates` that appear verbatim in a single caller line, returned exactly as the caller's line
 * has them, deduplicated, in the order given. Anything else (the customer's words, text spanning two lines,
 * paraphrases, non-strings) is dropped.
 */
export function selectScammerQuotes(
  candidates: readonly unknown[],
  segments: readonly Pick<ScreeningSegment, "speaker" | "text">[],
  max = MAX_ALERT_QUOTES,
): string[] {
  const lines = callerLines(segments);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    if (out.length >= max) break;
    if (typeof raw !== "string") continue;
    const candidate = raw.trim().replace(/^["'“‘]+|["'”’]+$/g, "");
    let found: string | null = null;
    for (const line of lines) {
      found = findVerbatim(candidate, line);
      if (found) break;
    }
    if (!found || found.length > MAX_QUOTE_CHARS) continue;
    const key = squashWithMap(found).squashed;
    if ([...seen].some((s) => s.includes(key) || key.includes(s))) continue;
    seen.add(key);
    out.push(found);
  }
  return out;
}

/**
 * When Claude gave no usable quotes (yet): the caller's own lines that contain a risk phrase ("safe account",
 * "HMRC"…), most recent first, if they are short enough to show whole.
 */
export function keywordQuotes(segments: readonly Pick<ScreeningSegment, "speaker" | "text">[], max = MAX_ALERT_QUOTES): string[] {
  const lines = callerLines(segments).filter((l) => l.length <= MAX_QUOTE_CHARS && RISK_KEYWORDS.some((k) => k.pattern.test(l)));
  return selectScammerQuotes([...lines].reverse(), segments, max);
}

/**
 * The quotes to store with a new score: Claude's verified picks; else the previous score's quotes (so a failed or
 * empty scoring never blanks the alert); else caller lines with risk phrases.
 */
export function alertQuotes(
  candidates: readonly unknown[] | null | undefined,
  segments: readonly Pick<ScreeningSegment, "speaker" | "text">[],
  previous: readonly string[] | null | undefined,
): string[] {
  const picked = selectScammerQuotes(candidates ?? [], segments);
  if (picked.length) return picked;
  const kept = selectScammerQuotes(previous ?? [], segments);
  if (kept.length) return kept;
  return keywordQuotes(segments);
}
