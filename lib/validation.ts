import { z } from "zod";
import { TOOL_FIELD_KEYS } from "@/lib/types";

export const e164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, "Use international E.164 format, e.g. +447700900123");

const optionalField = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined ? undefined : String(v).slice(0, 1000)));

const toolFieldShape = Object.fromEntries(TOOL_FIELD_KEYS.map((k) => [k, optionalField])) as Record<
  (typeof TOOL_FIELD_KEYS)[number],
  typeof optionalField
>;

/**
 * POST /api/tools/record-details body. The persona fills the optional detail fields; northgate_call_id (our calls.id,
 * passed as a dynamic variable at register-call) and the system dynamic variables are bound in the tool definition.
 * Unknown keys are dropped.
 */
export const recordDetailsSchema = z.object({
  ...toolFieldShape,
  conversation_id: z.string().trim().min(1).max(200),
  northgate_call_id: z.string().trim().max(100).nullish(),
  caller_id: z.string().max(100).nullish(),
  called_number: z.string().max(100).nullish(),
  // system__call_duration_secs: seconds since the call started (number, or a numeric string).
  call_duration_secs: z
    .union([z.number(), z.string()])
    .nullish()
    .transform((v) => {
      const n = typeof v === "string" ? Number(v) : v;
      return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 7200 ? n : undefined;
    }),
  // A JSON string per the docs; accept an object/array too. Capped to keep payloads sane.
  conversation_history: z
    .union([z.string().max(2_000_000), z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .nullish(),
});
export type RecordDetailsBody = z.infer<typeof recordDetailsSchema>;

/** A dynamic variable that should hold our calls.id: a UUID, or null for missing/placeholder values. */
export function northgateCallIdFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = z.uuid().safeParse(value.trim());
  return parsed.success ? parsed.data : null;
}
