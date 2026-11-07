/**
 * Set up the AI Voice Twin. Idempotent: safe to re-run.
 *
 *   npx tsx scripts/setup-voice-twin.ts            # apply
 *   npx tsx scripts/setup-voice-twin.ts --check    # read-only: report what would change
 *
 *   1. Storage: the private "voice-twin" bucket exists (migration 0009 creates it) and is not public.
 *   2. ElevenLabs: the takeover agent ELEVENLABS_AGENT_ID has the overrides the twin handover sends turned on
 *      (Security tab → System prompt, First message, Voice ID = platform_settings.overrides.conversation_config_override
 *      agent.prompt.prompt, agent.first_message, tts.voice_id). setup-agent.ts already enables them; this only PATCHes
 *      if one is off, sending the agent's complete current platform_settings with the overrides merged in.
 *   3. 24 h deletion on the Vercel Hobby plan (Vercel Cron runs at most daily): enable pg_cron + pg_net in Supabase and
 *      schedule `northgate-voice-twin-purge` every 10 minutes, which GETs ${PUBLIC_BASE_URL}/api/cron/voice-twin-purge
 *      (with "Authorization: Bearer $CRON_SECRET" when CRON_SECRET is set). The route only deletes what is already due.
 *   4. Reports the ElevenLabs plan's Instant Voice Cloning permission, voice slots, and the fallback voice.
 */
import "./lib/load-env";
import { Client } from "pg";
import { elevenLabsFetch, ElevenLabsError } from "../lib/elevenlabs/client";
import { requireEnv, serverEnv } from "../lib/env";
import { supabaseAdmin } from "../lib/supabase/admin";
import { VOICE_TWIN_BUCKET } from "../lib/voice-twin/config";

const CHECK_ONLY = process.argv.includes("--check");
const JOB_NAME = "northgate-voice-twin-purge";
const failures: string[] = [];
const log = (s: string) => console.log(s);

async function step1Bucket() {
  const { data, error } = await supabaseAdmin().storage.getBucket(VOICE_TWIN_BUCKET);
  if (error || !data) {
    failures.push(`bucket ${VOICE_TWIN_BUCKET} missing (run npm run db:migrate): ${error?.message ?? "not found"}`);
    return;
  }
  if (data.public) failures.push(`bucket ${VOICE_TWIN_BUCKET} is PUBLIC; it must be private`);
  log(`1. storage bucket ${VOICE_TWIN_BUCKET}: ${data.public ? "PUBLIC ✘" : "private ✔"}`);
}

type Overrides = { conversation_config_override?: { agent?: { first_message?: boolean; prompt?: { prompt?: boolean } }; tts?: { voice_id?: boolean } } };

async function step2AgentOverrides(apiKey: string) {
  const agentId = requireEnv("ELEVENLABS_AGENT_ID");
  const agent = await elevenLabsFetch<{ platform_settings?: Record<string, unknown> & { overrides?: Overrides } }>(apiKey, `/v1/convai/agents/${agentId}`);
  const o = agent.platform_settings?.overrides?.conversation_config_override;
  const checks: [string, boolean][] = [
    ["agent.prompt.prompt", o?.agent?.prompt?.prompt === true],
    ["agent.first_message", o?.agent?.first_message === true],
    ["tts.voice_id", o?.tts?.voice_id === true],
  ];
  for (const [name, ok] of checks) log(`2. override ${name}: ${ok ? "on ✔" : "OFF"}`);
  if (checks.every(([, ok]) => ok)) return;
  if (CHECK_ONLY) {
    log("2. would PATCH the agent to turn the missing overrides on");
    return;
  }
  const current = agent.platform_settings ?? {};
  const overrides = (current.overrides ?? {}) as Record<string, unknown> & Overrides;
  const cco = (overrides.conversation_config_override ?? {}) as Record<string, Record<string, unknown>>;
  await elevenLabsFetch(apiKey, `/v1/convai/agents/${agentId}`, {
    method: "PATCH",
    body: {
      platform_settings: {
        ...current,
        overrides: {
          ...overrides,
          conversation_config_override: {
            ...cco,
            agent: { ...(cco.agent ?? {}), first_message: true, prompt: { ...((cco.agent?.prompt as Record<string, unknown>) ?? {}), prompt: true } },
            tts: { ...(cco.tts ?? {}), voice_id: true },
          },
        },
      },
      version_description: "scripts/setup-voice-twin.ts (overrides for the AI Voice Twin)",
    },
  });
  const after = await elevenLabsFetch<{ platform_settings?: { overrides?: Overrides } }>(apiKey, `/v1/convai/agents/${agentId}`);
  const a = after.platform_settings?.overrides?.conversation_config_override;
  const ok = a?.agent?.prompt?.prompt === true && a?.agent?.first_message === true && a?.tts?.voice_id === true;
  log(`2. agent overrides ${ok ? "turned on ✔" : "still off ✘"}`);
  if (!ok) failures.push("could not turn on the agent overrides");
}

async function connect(): Promise<Client> {
  const primary = requireEnv("SUPABASE_DB_URL");
  const candidates = [primary, primary.replace(/aws-0-([a-z0-9-]+)\.pooler\.supabase\.com/, "aws-1-$1.pooler.supabase.com")];
  let lastError: unknown;
  for (const connectionString of [...new Set(candidates)]) {
    // Encrypted but not CA-verified, like scripts/migrate.ts (Supabase's pooler chains to Supabase's own root CA).
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** The agent's end-of-call line (said when the 30 min limit hits) is shared by the personas and the AI Voice Twin. */
export const NEUTRAL_END_MESSAGE = "Sorry, I have to go now. Bye.";

/**
 * 2b. Replace a persona-flavoured end-of-call line ("Oh dear, that's someone at the door…") with a neutral one, so the
 * twin never says a granny line in the customer's voice. PATCH merge semantics aren't documented, so the agent's
 * complete current conversation_config is sent back with only that field changed, then the settings every takeover
 * depends on are re-checked.
 */
async function step2bEndMessage(apiKey: string) {
  const agentId = requireEnv("ELEVENLABS_AGENT_ID");
  type Agent = {
    conversation_config: Record<string, unknown> & {
      agent?: Record<string, unknown> & { max_conversation_duration_message?: string; prompt?: { tool_ids?: string[] } };
      tts?: { voice_id?: string; agent_output_audio_format?: string; model_id?: string };
      asr?: { user_input_audio_format?: string };
    };
  };
  const before = await elevenLabsFetch<Agent>(apiKey, `/v1/convai/agents/${agentId}`);
  const current = before.conversation_config.agent?.max_conversation_duration_message;
  if (current === NEUTRAL_END_MESSAGE) {
    log("2b. end-of-call line is neutral ✔");
    return;
  }
  if (CHECK_ONLY) {
    log(`2b. would change the end-of-call line from ${JSON.stringify(current)} to ${JSON.stringify(NEUTRAL_END_MESSAGE)}`);
    return;
  }
  const cc = before.conversation_config;
  // The GET returns the prompt's tools both expanded (`tools`) and by id (`tool_ids`); the PATCH accepts only one.
  const { tools: _expandedTools, ...prompt } = (cc.agent?.prompt ?? {}) as Record<string, unknown> & { tools?: unknown };
  void _expandedTools;
  await elevenLabsFetch(apiKey, `/v1/convai/agents/${agentId}`, {
    method: "PATCH",
    body: {
      conversation_config: { ...cc, agent: { ...(cc.agent ?? {}), prompt, max_conversation_duration_message: NEUTRAL_END_MESSAGE } },
      version_description: "scripts/setup-voice-twin.ts (neutral end-of-call line for the AI Voice Twin)",
    },
  });
  const after = await elevenLabsFetch<Agent>(apiKey, `/v1/convai/agents/${agentId}`);
  const a = after.conversation_config;
  const checks: [string, boolean][] = [
    ["end-of-call line neutral", a.agent?.max_conversation_duration_message === NEUTRAL_END_MESSAGE],
    ["μ-law 8000 Hz output unchanged", a.tts?.agent_output_audio_format === cc.tts?.agent_output_audio_format],
    ["μ-law 8000 Hz input unchanged", a.asr?.user_input_audio_format === cc.asr?.user_input_audio_format],
    ["default voice unchanged", a.tts?.voice_id === cc.tts?.voice_id],
    ["TTS model unchanged", a.tts?.model_id === cc.tts?.model_id],
    ["tools unchanged", JSON.stringify(a.agent?.prompt?.tool_ids ?? []) === JSON.stringify(cc.agent?.prompt?.tool_ids ?? [])],
  ];
  for (const [name, ok] of checks) log(`2b. ${name}: ${ok ? "✔" : "✘"}`);
  for (const [name, ok] of checks) if (!ok) failures.push(`agent after the end-of-call change: ${name}`);
}

async function step3Schedule(baseUrl: string) {
  const client = await connect();
  try {
    const url = `${baseUrl}/api/cron/voice-twin-purge`;
    const secret = process.env.CRON_SECRET?.trim();
    const headers = JSON.stringify(secret ? { Authorization: `Bearer ${secret}` } : {});
    const installed = (await client.query<{ name: string }>("select extname as name from pg_extension where extname in ('pg_cron', 'pg_net')")).rows.map((r) => r.name);
    log(`3. extensions installed: ${installed.join(", ") || "none"}`);
    if (CHECK_ONLY) {
      if (installed.includes("pg_cron")) {
        const jobs = await client.query<{ schedule: string; active: boolean }>("select schedule, active from cron.job where jobname = $1", [JOB_NAME]);
        log(`3. job ${JOB_NAME}: ${jobs.rows[0] ? `${jobs.rows[0].schedule} ${jobs.rows[0].active ? "active ✔" : "inactive"}` : "not scheduled"}`);
      } else {
        log(`3. would enable pg_cron + pg_net and schedule ${JOB_NAME} every 10 minutes → ${url}`);
      }
      return;
    }
    await client.query("create extension if not exists pg_cron with schema pg_catalog");
    await client.query("create extension if not exists pg_net with schema extensions");
    // cron.schedule upserts by job name. The command is built with format() so the URL and headers are quoted safely.
    await client.query(
      `select cron.schedule($1, '*/10 * * * *', format(
         'select net.http_get(url := %L, headers := %L::jsonb, timeout_milliseconds := 30000)', $2::text, $3::text))`,
      [JOB_NAME, url, headers],
    );
    const job = await client.query<{ schedule: string; active: boolean }>("select schedule, active from cron.job where jobname = $1", [JOB_NAME]);
    log(`3. pg_cron job ${JOB_NAME}: ${job.rows[0]?.schedule} → ${url}${secret ? " (with CRON_SECRET)" : ""} ${job.rows[0]?.active ? "✔" : "✘"}`);
    if (!job.rows[0]?.active) failures.push("the purge job is not active");
  } finally {
    await client.end();
  }
}

async function step4Plan(apiKey: string, fallbackVoiceId: string | undefined) {
  try {
    const s = await elevenLabsFetch<{ tier?: string; can_use_instant_voice_cloning?: boolean; voice_slots_used?: number; voice_limit?: number }>(
      apiKey,
      "/v1/user/subscription",
    );
    log(`4. ElevenLabs plan ${s.tier}: Instant Voice Cloning ${s.can_use_instant_voice_cloning ? "allowed ✔" : "NOT allowed ✘"}; voice slots ${s.voice_slots_used}/${s.voice_limit}`);
    if (s.can_use_instant_voice_cloning === false) {
      console.log("NOTE: this plan can't clone; every twin will use VOICE_TWIN_FALLBACK_VOICE_ID (if set) or fail.");
    }
  } catch (error) {
    log(`4. could not read the ElevenLabs plan: ${(error as Error).message}`);
  }
  if (!fallbackVoiceId) {
    log("4. VOICE_TWIN_FALLBACK_VOICE_ID not set (optional)");
    return;
  }
  try {
    const v = await elevenLabsFetch<{ name: string; category: string }>(apiKey, `/v1/voices/${encodeURIComponent(fallbackVoiceId)}`);
    log(`4. fallback voice "${v.name}" (${v.category}) ✔`);
  } catch (error) {
    failures.push(`VOICE_TWIN_FALLBACK_VOICE_ID ${fallbackVoiceId} not found: ${(error as Error).message}`);
  }
}

async function main() {
  const env = serverEnv();
  const baseUrl = requireEnv("PUBLIC_BASE_URL").replace(/\/$/, "");
  console.log(`${CHECK_ONLY ? "Checking" : "Setting up"} the AI Voice Twin for ${baseUrl}`);
  await step1Bucket();
  await step2AgentOverrides(env.ELEVENLABS_API_KEY);
  await step2bEndMessage(env.ELEVENLABS_API_KEY);
  await step3Schedule(baseUrl);
  await step4Plan(env.ELEVENLABS_API_KEY, env.VOICE_TWIN_FALLBACK_VOICE_ID);
  if (failures.length) {
    for (const f of failures) console.error(`FAIL: ${f}`);
    process.exit(1);
  }
  console.log(CHECK_ONLY ? "Check complete (no changes made)." : "Done.");
}

main().catch((error) => {
  console.error(error instanceof ElevenLabsError ? error.message : error);
  process.exit(1);
});
