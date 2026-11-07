/** Client-safe: no SDK or env imports, so lib/alert-quotes.ts can use it too. */

/**
 * Phrases that on their own make a call suspicious. Each distinct phrase the CALLER says adds KEYWORD_POINTS to a
 * floor that is capped at KEYWORD_FLOOR_CAP, so keywords alone can never reach the default threshold (70): Claude
 * has to agree. Patterns allow for speech-to-text spellings ("any desk", "H M R C").
 */
export const RISK_KEYWORDS: readonly { label: string; pattern: RegExp }[] = [
  { label: "safe account", pattern: /\bsafe[\s-]+accounts?\b/i },
  { label: "move your money", pattern: /\bmove\s+(?:all\s+(?:of\s+)?)?your\s+(?:money|savings|funds|cash)\b/i },
  { label: "don't tell anyone", pattern: /\b(?:don'?t|do\s+not|mustn'?t|must\s+not)\s+tell\s+anyone\b/i },
  { label: "HMRC", pattern: /\bH\.?\s?M\.?\s?R\.?\s?C\b/i },
  { label: "arrest", pattern: /\barrest(?:ed|ing|s)?\b/i },
  { label: "gift card", pattern: /\bgift[\s-]*cards?\b/i },
  { label: "AnyDesk", pattern: /\bany[\s-]?desk\b/i },
  { label: "courier", pattern: /\bcouriers?\b/i },
  { label: "read me the code", pattern: /\bread\s+(?:me\s+)?(?:out\s+)?the\s+code\b/i },
];
