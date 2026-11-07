/**
 * Deterministic normalisation of UK payment details and phone numbers.
 * Scammers (and speech-to-text) produce things like "forty 12 thirty-four", "40.12.34", "4 0 1 2 3 4".
 */

const WORD_DIGITS: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  nought: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

const MULTIPLIERS: Record<string, number> = { double: 2, triple: 3 };

/** Turn spoken digits ("four oh double seven") into a digit string; non-digit noise is dropped. */
export function spokenToDigits(input: string): string {
  const tokens = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  let out = "";
  let repeat = 1;
  for (const token of tokens) {
    if (token in MULTIPLIERS) {
      repeat = MULTIPLIERS[token];
      continue;
    }
    let digits = "";
    if (/^\d+$/.test(token)) digits = token;
    else if (token in WORD_DIGITS) digits = WORD_DIGITS[token];
    if (digits) {
      out += repeat > 1 && digits.length === 1 ? digits.repeat(repeat) : digits;
    }
    repeat = 1;
  }
  return out;
}

/** UK sort code → "NN-NN-NN", or null if it isn't exactly six digits. */
export function normaliseSortCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = spokenToDigits(input);
  if (digits.length !== 6) return null;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
}

/** UK account number → 8 digits, or null. Seven-digit legacy numbers are left-padded with a zero. */
export function normaliseAccountNumber(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = spokenToDigits(input);
  if (digits.length === 8) return digits;
  if (digits.length === 7) return `0${digits}`;
  return null;
}

/** Holder-name normalisation; mirrors public.normalise_holder_name() in SQL. */
export function normaliseName(input: string | null | undefined): string | null {
  if (!input) return null;
  const out = input
    .toLowerCase()
    .replace(/^\s*(mr|mrs|ms|miss|mx|dr)\.?\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return out || null;
}

/** Mask a phone number to its last three digits, e.g. "+447700900123" → "•••123". */
export function maskCaller(input: string | null | undefined): string {
  const digits = (input ?? "").replace(/\D/g, "");
  if (digits.length < 3) return "withheld";
  return `•••${digits.slice(-3)}`;
}

/** Parse a spoken or written amount ("£2,500", "two and a half thousand" is not supported) into pounds. */
export function parseAmountGbp(input: string | null | undefined): number | null {
  if (!input) return null;
  const match = input.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)\s*(k|thousand|grand)?/i);
  if (!match) return null;
  const value = Number(match[1]) * (match[2] ? 1000 : 1);
  return Number.isFinite(value) ? value : null;
}

export function formatPence(pence: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
}

export function formatPounds(pounds: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 2 }).format(pounds);
}
