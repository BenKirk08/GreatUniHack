import type { CallRow, ScamType, Tactic } from "@/lib/types";

export const SCAM_TYPE_LABELS: Record<ScamType, string> = {
  bank_impersonation: "Bank impersonation",
  safe_account: "Safe account",
  hmrc: "HMRC",
  courier: "Courier",
  investment: "Investment",
  family_emergency: "Family emergency",
  tech_support: "Tech support",
  other: "Other",
  unknown: "Unknown",
};

export const TACTIC_LABELS: Record<Tactic, string> = {
  urgency: "Urgency",
  secrecy: "Secrecy",
  authority: "Authority",
  fear: "Fear",
  isolation: "Isolation",
  reward: "Reward",
  remote_access: "Remote access",
};

export function formatDuration(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function callDurationSecs(call: Pick<CallRow, "started_at" | "ended_at" | "status">, now: number): number {
  const start = Date.parse(call.started_at);
  const end = call.ended_at ? Date.parse(call.ended_at) : call.status === "live" ? now : start;
  return Math.max(0, (end - start) / 1000);
}

/** "+14452755928" → "+1 (445) 275-5928"; "+447700900123" → "+44 7700 900123". */
export function formatPhoneDisplay(e164: string): string {
  const d = e164.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.startsWith("44") && d.length === 12) return `+44 ${d.slice(2, 6)} ${d.slice(6)}`;
  return e164;
}

export function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Strip spaces, dashes and brackets so "+44 7700 900-123" becomes "+447700900123". */
export function compactPhone(input: string): string {
  return input.replace(/[\s\-().]/g, "");
}

export const E164_REGEX = /^\+[1-9]\d{6,14}$/;
