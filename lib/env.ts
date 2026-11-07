import { z } from "zod";

/** Empty strings in .env files mean "not set yet". */
const optional = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

const required = z.string().trim().min(1);

const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, "must be an E.164 number like +14155550123");

const booleanString = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

/** A positive number of seconds from an env string, with a default when unset. */
const seconds = (fallback: number, max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() ? Number(v.trim()) : undefined), z.number().min(5).max(max).default(fallback));

const serverSchema = z.object({
  ANTHROPIC_API_KEY: required,
  ANTHROPIC_MODEL: required,
  /** A current Claude Haiku model ID, for live risk scoring. */
  ANTHROPIC_FAST_MODEL: required,

  ELEVENLABS_API_KEY: required,
  /**
   * The takeover agent, with per-call overrides for the AI voice (prompt, first message, voice) or the AI Voice Twin.
   * The six AI voices' ElevenLabs IDs are config, not env: lib/ai-voices/config.ts.
   */
  ELEVENLABS_AGENT_ID: optional,
  ELEVENLABS_WEBHOOK_SECRET: optional,

  TWILIO_ACCOUNT_SID: required,
  TWILIO_API_KEY_SID: required,
  TWILIO_API_KEY_SECRET: required,
  /** Validates X-Twilio-Signature (API keys can't). */
  TWILIO_AUTH_TOKEN: required,
  TWILIO_PHONE_NUMBER: e164,

  /** The protected customer's real mobile; every call to TWILIO_PHONE_NUMBER rings through to it. */
  CUSTOMER_PHONE_NUMBER: e164,
  /** The customer's first name (the /protect greeting and the AI Voice Twin's prompt). */
  CUSTOMER_FIRST_NAME: z.string().trim().min(1).max(40),
  /** Secret in the customer's /protect?k=… link. */
  CUSTOMER_LINK_TOKEN: z.string().trim().min(24, "CUSTOMER_LINK_TOKEN must be at least 24 characters"),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: required,
  VAPID_PRIVATE_KEY: required,
  /** Offer a takeover when the peak risk score reaches this (0–100). */
  RISK_THRESHOLD: z.preprocess(
    (v) => (typeof v === "string" && v.trim() ? Number(v.trim()) : undefined),
    z.number().int().min(1).max(100).default(70),
  ),

  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: required,
  SUPABASE_SERVICE_ROLE_KEY: required,
  // Only needed by scripts (migrations); not required at runtime.
  SUPABASE_DB_URL: optional,
  VERCEL_TOKEN: optional,

  RESEND_API_KEY: required,
  REPORT_FROM_EMAIL: required,
  REPORT_TO_EMAIL: z.email(),
  AUTO_SEND_REPORTS: booleanString.default(true),

  TOOL_SECRET: z.string().trim().min(16, "TOOL_SECRET must be at least 16 characters"),
  DASHBOARD_PASSWORD: z.string().trim().min(8, "DASHBOARD_PASSWORD must be at least 8 characters"),

  PUBLIC_BASE_URL: optional.pipe(z.url().optional()),

  /** AI Voice Twin: clean speech needed before cloning is allowed. */
  VOICE_TWIN_MIN_SECONDS: seconds(15, 600),
  /** AI Voice Twin: the "good quality" mark on the progress bar. */
  VOICE_TWIN_TARGET_SECONDS: seconds(60, 900),
  /** AI Voice Twin: a clone of the consenting user made by hand in the ElevenLabs dashboard, used if the API clone fails. */
  VOICE_TWIN_FALLBACK_VOICE_ID: optional,
  /** Only for services/media-bridge running locally behind ngrok. */
  NGROK_AUTHTOKEN: optional,
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

/** Validated server-side environment. Parsed lazily so `next build` never needs secrets at import time. */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment variables:\n${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/** Throws a clear error when an env value that is optional at boot is needed for an operation. */
export function requireEnv<K extends keyof ServerEnv>(key: K): NonNullable<ServerEnv[K]> {
  const value = serverEnv()[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`${String(key)} is not set`);
  }
  return value as NonNullable<ServerEnv[K]>;
}

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: required,
});

export type PublicEnv = z.infer<typeof publicSchema>;

/**
 * Browser-safe environment. Each key is referenced literally so Next.js can inline it into the client bundle.
 */
export function publicEnv(): PublicEnv {
  return publicSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}

/** Test hook: forget the cached env so tests can change process.env. */
export function resetEnvCache() {
  cached = undefined;
}
