/**
 * Wire up Northgate Call Guard. Idempotent: safe to re-run.
 *
 *   npx tsx scripts/setup-agent.ts            # apply
 *   npx tsx scripts/setup-agent.ts --check    # read-only: report what would change
 *
 *   0. Preflight: PUBLIC_BASE_URL is https; the Twilio account is upgraded (a trial can't forward calls to a
 *      +44 mobile); ELEVENLABS_AGENT_ID exists.
 *   1. If TWILIO_PHONE_NUMBER is imported into ElevenLabs, delete it there, so ElevenLabs no longer handles its calls.
 *   2. Point the Twilio number at us: VoiceUrl ${PUBLIC_BASE_URL}/api/twilio/voice and StatusCallback
 *      ${PUBLIC_BASE_URL}/api/twilio/status (both POST).
 *   3. Update the agent ELEVENLABS_AGENT_ID (the takeover agent): enable overrides for agent.prompt.prompt,
 *      agent.first_message and tts.voice_id; add a northgate_call_id param to record_details, filled from the dynamic
 *      variable northgate_call_id; switch its audio to μ-law 8000 Hz (required by register-call). The post-call
 *      webhook stays as it is (reused, never recreated while its secret is known).
 *   4. Check Twilio dialing permissions for CUSTOMER_PHONE_NUMBER's country and enable low-risk numbers through the API
 *      if needed; check the six AI voices (lib/ai-voices/config.ts) are in My Voices with their IDs, adding any that
 *      are only in the Voice Library (the same check as `npm run setup-ai-voices`).
 *   The agent's default voice, prompt and first message are the default AI voice's (middle-aged female); every
 *   takeover overrides all three anyway.
 * New env values are written to .env.local and Vercel; redeploy afterwards (`vercel deploy --prod`).
 */
import "./lib/load-env";
import { elevenLabsFetch, ElevenLabsError } from "../lib/elevenlabs/client";
import { requireEnv, serverEnv, type ServerEnv } from "../lib/env";
import { elevenLabsVoiceId } from "../lib/ai-voices/config";
import { buildFirstMessage, buildPersonaPrompt } from "../lib/personas";
import { DEFAULT_AGE_BAND, DEFAULT_GENDER } from "../lib/voice-match";
import { describeAiVoiceStatus, ensureAiVoices } from "./lib/ai-voices";
import { twilioFetch, TwilioError, TWILIO_API, type TwilioCredentials } from "../lib/twilio";
import { upsertVercelEnv, writeLocalEnv } from "./lib/vercel";

const AGENT_TAG = "granny-agent";
const TOOL_NAME = "record_details";
const SECRET_NAME = "granny_agent_tool_secret";
const WEBHOOK_NAME = "Granny Agent post-call";
const CHECK_ONLY = process.argv.includes("--check");
/** The agent's default voice and character: the default AI voice (middle-aged female). */
const DEFAULT_AI_VOICE = `${DEFAULT_AGE_BAND}_${DEFAULT_GENDER}` as const;

const log = (msg: string) => console.log(`  ${msg}`);
const notes: string[] = [];
const failures: string[] = [];

/* ---------------- LLM choice (unchanged from the original setup) ---------------- */

interface LlmInfo {
  llm: string;
  is_checkpoint: boolean;
  available_reasoning_efforts?: string[] | null;
  deprecation_info?: { is_deprecated?: boolean; is_in_warning_period?: boolean; is_in_fallback_period?: boolean; fallback_percentage?: number } | null;
  is_approved_for_workspace?: boolean | null;
}
const HAIKU_ALIAS = /^claude-haiku-(\d+)(?:-(\d+))?$/;
function deprecationTier(m: LlmInfo): 0 | 1 | 2 {
  const d = m.deprecation_info;
  if (d == null) return 0;
  if (d.is_deprecated || d.is_in_warning_period || d.is_in_fallback_period || (d.fallback_percentage ?? 0) > 0) return 2;
  return 1;
}
export function pickNewestHaiku(llms: LlmInfo[]): LlmInfo {
  const candidates = llms
    .filter((m) => !m.is_checkpoint && !m.llm.includes("@") && m.is_approved_for_workspace !== false)
    .map((m) => {
      const match = HAIKU_ALIAS.exec(m.llm);
      return match ? { m, major: Number(match[1]), minor: match[2] ? Number(match[2]) : 0, tier: deprecationTier(m) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null && x.tier < 2);
  for (const tier of [0, 1]) {
    const pool = candidates.filter((c) => c.tier === tier).sort((a, b) => b.major - a.major || b.minor - a.minor);
    if (pool.length) return pool[0].m;
  }
  throw new Error("No non-deprecated claude-haiku-* alias in /v1/convai/llm/list");
}
function isClean(llms: LlmInfo[], id: string): boolean {
  const m = llms.find((x) => x.llm === id);
  return Boolean(m && !m.is_checkpoint && deprecationTier(m) === 0);
}

/* ---------------- helpers ---------------- */

/** Calling-code → ISO country for the dialing-permission check (longest prefix wins). */
const COUNTRY_BY_PREFIX: [string, string][] = [
  ["44", "GB"], ["353", "IE"], ["1", "US"], ["33", "FR"], ["49", "DE"], ["34", "ES"], ["39", "IT"], ["31", "NL"],
  ["32", "BE"], ["41", "CH"], ["43", "AT"], ["45", "DK"], ["46", "SE"], ["47", "NO"], ["351", "PT"], ["61", "AU"],
  ["64", "NZ"], ["91", "IN"], ["65", "SG"], ["852", "HK"], ["81", "JP"], ["27", "ZA"],
];
export function countryForNumber(e164: string): string | null {
  const digits = e164.replace(/^\+/, "");
  const match = COUNTRY_BY_PREFIX.filter(([p]) => digits.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0];
  return match ? match[1] : null;
}

type El = <T>(path: string, init?: Parameters<typeof elevenLabsFetch>[2]) => Promise<T>;

/* ---------------- steps ---------------- */

async function preflight(env: ServerEnv, twilioMain: TwilioCredentials) {
  try {
    const account = await twilioFetch<{ type?: string; status?: string; friendly_name?: string }>(
      twilioMain,
      `${TWILIO_API}/Accounts/${env.TWILIO_ACCOUNT_SID}.json`,
    );
    log(`twilio account: ${account.type ?? "?"} (${account.status ?? "?"})`);
    if (account.type === "Trial") {
      failures.push("The Twilio account is a trial: trials can't <Dial> an unverified or international number. Upgrade it.");
    }
    if (account.status && account.status !== "active") failures.push(`The Twilio account is ${account.status}.`);
  } catch (error) {
    notes.push(`Could not read the Twilio account type (${(error as Error).message}); check it isn't a trial.`);
  }
}

async function step1DeleteFromElevenLabs(el: El, env: ServerEnv) {
  const numbers = await el<{ phone_number: string; phone_number_id: string; provider?: string; label?: string }[]>("/v1/convai/phone-numbers");
  const imported = numbers.filter((n) => n.phone_number === env.TWILIO_PHONE_NUMBER);
  if (imported.length === 0) {
    log(`1. ${env.TWILIO_PHONE_NUMBER} is not imported into ElevenLabs ✔`);
    return;
  }
  for (const n of imported) {
    if (CHECK_ONLY) {
      log(`1. would delete ${n.phone_number} (${n.phone_number_id}, "${n.label ?? ""}") from ElevenLabs`);
      continue;
    }
    await el(`/v1/convai/phone-numbers/${n.phone_number_id}`, { method: "DELETE" });
    log(`1. deleted ${n.phone_number} (${n.phone_number_id}) from ElevenLabs`);
  }
}

interface IncomingNumber {
  sid: string;
  phone_number: string;
  voice_url: string | null;
  voice_method: string | null;
  status_callback: string | null;
  status_callback_method: string | null;
  voice_application_sid: string | null;
  trunk_sid: string | null;
  voice_receive_mode?: string | null;
}

async function step2PointTwilioNumber(env: ServerEnv, twilio: TwilioCredentials, baseUrl: string) {
  const list = await twilioFetch<{ incoming_phone_numbers: IncomingNumber[] }>(
    twilio,
    `${TWILIO_API}/Accounts/${env.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(env.TWILIO_PHONE_NUMBER)}`,
  );
  const number = list.incoming_phone_numbers.find((n) => n.phone_number === env.TWILIO_PHONE_NUMBER);
  if (!number) throw new Error(`${env.TWILIO_PHONE_NUMBER} is not a number on this Twilio account`);
  const want = {
    VoiceUrl: `${baseUrl}/api/twilio/voice`,
    VoiceMethod: "POST",
    StatusCallback: `${baseUrl}/api/twilio/status`,
    StatusCallbackMethod: "POST",
  };
  const current = {
    VoiceUrl: number.voice_url,
    VoiceMethod: number.voice_method,
    StatusCallback: number.status_callback,
    StatusCallbackMethod: number.status_callback_method,
  };
  const differs = (Object.keys(want) as (keyof typeof want)[]).filter((k) => current[k] !== want[k]);
  const form: Record<string, string> = differs.length ? { ...want } : {};
  // A TwiML app or SIP trunk on the number would make Twilio ignore VoiceUrl.
  if (number.voice_application_sid) form.VoiceApplicationSid = "";
  if (number.trunk_sid) form.TrunkSid = "";
  if (number.voice_receive_mode && number.voice_receive_mode !== "voice") form.VoiceReceiveMode = "voice";
  if (Object.keys(form).length === 0) {
    log(`2. ${number.phone_number} → ${want.VoiceUrl} (status ${want.StatusCallback}) ✔`);
    return;
  }
  if (CHECK_ONLY) {
    log(`2. would update ${number.phone_number}: ${Object.keys(form).join(", ")} (now ${current.VoiceUrl})`);
    return;
  }
  const updated = await twilioFetch<IncomingNumber>(
    twilio,
    `${TWILIO_API}/Accounts/${env.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers/${number.sid}.json`,
    { form },
  );
  const ok =
    updated.voice_url === want.VoiceUrl &&
    updated.voice_method === "POST" &&
    updated.status_callback === want.StatusCallback &&
    updated.status_callback_method === "POST" &&
    !updated.voice_application_sid &&
    !updated.trunk_sid;
  log(`2. ${ok ? "✔" : "✘"} ${updated.phone_number} VoiceUrl=${updated.voice_url} StatusCallback=${updated.status_callback}`);
  if (!ok) failures.push("The Twilio number did not take the new VoiceUrl/StatusCallback (check for a TwiML app or trunk on it).");
}

async function step3Agent(el: El, env: ServerEnv, baseUrl: string, newEnv: Record<string, string>) {
  const agentId = requireEnv("ELEVENLABS_AGENT_ID");
  const llmList = await el<{ llms: LlmInfo[] }>("/v1/convai/llm/list");
  const llm = pickNewestHaiku(llmList.llms);
  const reasoningEffort = ["low", "none", "minimal"].find((e) => llm.available_reasoning_efforts?.includes(e));
  const analysisLlm = ["gemini-3.5-flash", llm.llm].find((id) => isClean(llmList.llms, id));
  log(`3. LLM: ${llm.llm}${reasoningEffort ? ` (reasoning_effort ${reasoningEffort})` : ""}`);

  // Tool secret (workspace secret referenced by the tool header).
  const secrets = await el<{ secrets: { secret_id: string; name: string }[] }>("/v1/convai/secrets", { query: { search: SECRET_NAME, page_size: "100" } });
  let secretId = secrets.secrets.find((s) => s.name === SECRET_NAME)?.secret_id;
  if (!CHECK_ONLY) {
    if (secretId) {
      await el(`/v1/convai/secrets/${secretId}`, { method: "PATCH", body: { type: "update", name: SECRET_NAME, value: env.TOOL_SECRET } });
    } else {
      secretId = (await el<{ secret_id: string }>("/v1/convai/secrets", { method: "POST", body: { type: "new", name: SECRET_NAME, value: env.TOOL_SECRET } })).secret_id;
      log(`3. created workspace secret ${SECRET_NAME}`);
    }
  }

  // record_details, now with northgate_call_id bound to the dynamic variable of the same name.
  const optional = (description: string) => ({ type: "string", description });
  const fromVariable = (variable: string) => ({ type: "string", dynamic_variable: variable });
  const toolConfig = {
    type: "webhook",
    name: TOOL_NAME,
    description:
      "Write down any NEW detail the caller has revealed about who they are or where money should go. Call it as soon as you learn something new, filling only the fields you actually heard (leave the rest out). Say something in character first, like 'hold on, writing that down'.",
    response_timeout_secs: 10,
    pre_tool_speech: "force",
    interruption_mode: "allow",
    execution_mode: "immediate",
    tool_error_handling_mode: "hide",
    api_schema: {
      url: `${baseUrl}/api/tools/record-details`,
      method: "POST",
      content_type: "application/json",
      request_headers: { "x-tool-secret": { secret_id: secretId } },
      request_body_schema: {
        type: "object",
        description: "Scam details heard so far in this call",
        required: [],
        properties: {
          claimed_organisation: optional("Organisation the caller claims to represent, e.g. 'Northgate Bank fraud team', 'HMRC', 'the police'"),
          caller_name: optional("Name the caller gave, spelled as they spelled it"),
          reason_given: optional("Why the caller says the money must be moved or the action taken"),
          payee_name: optional("Name on the account the money should go to"),
          sort_code: optional("Sort code of the account money should go to, as six digits, e.g. '995017'"),
          account_number: optional("Account number money should go to, digits only, e.g. '41873026'"),
          amount: optional("Amount of money requested, e.g. '£2,500'"),
          requested_action: optional("What the caller wants done, e.g. 'transfer to a safe account', 'install AnyDesk', 'hand cash to a courier'"),
          callback_number: optional("Phone number the caller gave for calling back, digits only"),
          northgate_call_id: fromVariable("northgate_call_id"),
          conversation_id: fromVariable("system__conversation_id"),
          caller_id: fromVariable("system__caller_id"),
          called_number: fromVariable("system__called_number"),
          conversation_history: fromVariable("system__conversation_history"),
          call_duration_secs: { type: "integer", dynamic_variable: "system__call_duration_secs" },
        },
      },
    },
  };
  let toolId: string | undefined;
  let cursor: string | undefined;
  do {
    const page = await el<{ tools: { id: string; tool_config: { name: string } }[]; has_more: boolean; next_cursor?: string | null }>("/v1/convai/tools", {
      query: { search: TOOL_NAME, types: "webhook", page_size: "100", cursor },
    });
    toolId = page.tools.find((t) => t.tool_config.name === TOOL_NAME)?.id;
    cursor = !toolId && page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);
  if (!CHECK_ONLY) {
    if (toolId) {
      await el(`/v1/convai/tools/${toolId}`, { method: "PATCH", body: { tool_config: toolConfig } });
      log(`3. tool ${TOOL_NAME} (${toolId}) updated with northgate_call_id`);
    } else {
      toolId = (await el<{ id: string }>("/v1/convai/tools", { method: "POST", body: { tool_config: toolConfig } })).id;
      log(`3. tool ${TOOL_NAME} created (${toolId})`);
    }
  }

  // Post-call webhook: keep the existing one (its HMAC secret is only shown at creation).
  const webhookUrl = `${baseUrl}/api/webhooks/elevenlabs`;
  const hooks = await el<{ webhooks: { webhook_id: string; webhook_url: string; is_disabled?: boolean; is_auto_disabled?: boolean }[] }>("/v1/workspace/webhooks", {
    query: { include_usages: "true" },
  });
  let webhookId = hooks.webhooks.find((w) => w.webhook_url === webhookUrl)?.webhook_id;
  if (webhookId && env.ELEVENLABS_WEBHOOK_SECRET) {
    log(`3. post-call webhook ${webhookId} kept as it is`);
    if (!CHECK_ONLY) newEnv.ELEVENLABS_WEBHOOK_SECRET = env.ELEVENLABS_WEBHOOK_SECRET; // repairs a half-finished earlier run
  } else if (!CHECK_ONLY) {
    const created = await el<{ webhook_id: string; webhook_secret: string | null }>("/v1/workspace/webhooks", {
      method: "POST",
      body: { settings: { auth_type: "hmac", name: WEBHOOK_NAME, webhook_url: webhookUrl } },
    });
    if (!created.webhook_secret) throw new Error("ElevenLabs did not return a webhook secret");
    webhookId = created.webhook_id;
    newEnv.ELEVENLABS_WEBHOOK_SECRET = created.webhook_secret;
    writeLocalEnv("ELEVENLABS_WEBHOOK_SECRET", created.webhook_secret);
    // The secret is only shown once: get it onto Vercel before anything else can fail.
    if (process.env.VERCEL_TOKEN) await upsertVercelEnv({ ELEVENLABS_WEBHOOK_SECRET: created.webhook_secret }, { token: process.env.VERCEL_TOKEN });
    await el(`/v1/workspace/webhooks/${webhookId}`, { method: "PATCH", body: { is_disabled: false, name: WEBHOOK_NAME, retry_enabled: true } });
    log(`3. post-call webhook created (${webhookId}); the old secret was missing`);
  }

  // The agent. PATCH merge semantics aren't documented, so send complete objects built from the current config.
  const current = await el<{
    name: string;
    tags?: string[];
    conversation_config: Record<string, unknown> & {
      agent?: { prompt?: Record<string, unknown> & { tool_ids?: string[]; built_in_tools?: Record<string, unknown> } };
      tts?: Record<string, unknown>;
      asr?: Record<string, unknown>;
    };
    platform_settings?: Record<string, unknown> & { overrides?: { conversation_config_override?: Record<string, unknown> } & Record<string, unknown> };
  }>(`/v1/convai/agents/${agentId}`);

  const defaultPrompt = buildPersonaPrompt({ persona: DEFAULT_AI_VOICE, scamType: null, claimedOrg: null, screening: [] });
  const conversationConfig = {
    agent: {
      first_message: buildFirstMessage(DEFAULT_AI_VOICE, null),
      language: "en",
      // Neutral on purpose: the AI Voice Twin shares this agent and would say it in the customer's own voice.
      max_conversation_duration_message: "Sorry, I have to go now. Bye.",
      dynamic_variables: { dynamic_variable_placeholders: { northgate_call_id: "not-a-call" } },
      prompt: {
        prompt: defaultPrompt,
        llm: llm.llm,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        temperature: null,
        max_tokens: -1,
        timezone: "Europe/London",
        tool_ids: [toolId],
        built_in_tools: {
          end_call: {
            type: "system",
            name: "end_call",
            description: "End the call politely if the caller becomes abusive, threatening or sexually explicit, or after you have said goodbye.",
            params: { system_tool_type: "end_call" },
          },
        },
      },
    },
    tts: { ...(current.conversation_config.tts ?? {}), model_id: "eleven_v4_turbo", voice_id: elevenLabsVoiceId(DEFAULT_AI_VOICE), agent_output_audio_format: "ulaw_8000" },
    asr: { ...(current.conversation_config.asr ?? {}), user_input_audio_format: "ulaw_8000" },
    turn: { turn_eagerness: "patient", spelling_patience: "auto" },
    conversation: { max_duration_seconds: 1800 },
  };
  const existingOverride = (current.platform_settings?.overrides?.conversation_config_override ?? {}) as Record<string, Record<string, unknown>>;
  const overrides = {
    ...(current.platform_settings?.overrides ?? {}),
    conversation_config_override: {
      ...existingOverride,
      agent: {
        ...(existingOverride.agent ?? {}),
        first_message: true,
        prompt: { ...((existingOverride.agent?.prompt as Record<string, unknown>) ?? {}), prompt: true },
      },
      tts: { ...(existingOverride.tts ?? {}), voice_id: true },
    },
  };
  const platformSettings = {
    ...(analysisLlm ? { analysis_llm: analysisLlm } : {}),
    workspace_overrides: {
      webhooks: { post_call_webhook_id: webhookId, events: ["transcript", "call_initiation_failure"], transcript_format: "json", exclude_transcript: false },
    },
    overrides,
  };
  if (CHECK_ONLY) {
    log("3. would PATCH the agent (overrides, μ-law audio, record_details with northgate_call_id)");
  } else {
    await el(`/v1/convai/agents/${agentId}`, {
      method: "PATCH",
      body: {
        name: current.name || "Call Guard AI voice",
        tags: [...new Set([...(current.tags ?? []), AGENT_TAG, "call-guard"])],
        conversation_config: conversationConfig,
        platform_settings: platformSettings,
        version_description: "scripts/setup-agent.ts (Call Guard takeover agent)",
      },
    });
    log(`3. agent ${agentId} updated`);
  }

  // Verify.
  const agent = await el<{
    conversation_config: {
      agent: { first_message: string; prompt: { llm: string; tool_ids?: string[]; built_in_tools?: Record<string, unknown> } };
      tts: { voice_id: string; agent_output_audio_format?: string };
      asr: { user_input_audio_format?: string };
    };
    platform_settings?: {
      overrides?: { conversation_config_override?: { agent?: { first_message?: boolean; prompt?: { prompt?: boolean } }; tts?: { voice_id?: boolean } } };
      workspace_overrides?: { webhooks?: { post_call_webhook_id?: string | null } };
    };
  }>(`/v1/convai/agents/${agentId}`);
  const tool = toolId ? await el<{ tool_config: { api_schema?: { request_body_schema?: { properties?: Record<string, { dynamic_variable?: string }> } } } }>(`/v1/convai/tools/${toolId}`) : null;
  const o = agent.platform_settings?.overrides?.conversation_config_override;
  const checks: [string, boolean][] = [
    ["override: agent.prompt.prompt", o?.agent?.prompt?.prompt === true],
    ["override: agent.first_message", o?.agent?.first_message === true],
    ["override: tts.voice_id", o?.tts?.voice_id === true],
    ["μ-law 8000 Hz output", agent.conversation_config.tts.agent_output_audio_format === "ulaw_8000"],
    ["μ-law 8000 Hz input", agent.conversation_config.asr.user_input_audio_format === "ulaw_8000"],
    ["default voice is the default AI voice", agent.conversation_config.tts.voice_id === elevenLabsVoiceId(DEFAULT_AI_VOICE)],
    ["record_details attached", Boolean(toolId && (agent.conversation_config.agent.prompt.tool_ids ?? []).includes(toolId))],
    ["record_details.northgate_call_id ← {{northgate_call_id}}", tool?.tool_config.api_schema?.request_body_schema?.properties?.northgate_call_id?.dynamic_variable === "northgate_call_id"],
    ["end_call enabled", Boolean(agent.conversation_config.agent.prompt.built_in_tools?.end_call)],
    ["post-call webhook unchanged", agent.platform_settings?.workspace_overrides?.webhooks?.post_call_webhook_id === webhookId],
  ];
  for (const [label, ok] of checks) log(`   ${ok ? "✔" : "✘"} ${label}`);
  if (!CHECK_ONLY) for (const [label, ok] of checks) if (!ok) failures.push(`agent check failed: ${label}`);
}

async function step4DialingPermissions(env: ServerEnv, twilio: TwilioCredentials) {
  const iso = countryForNumber(env.CUSTOMER_PHONE_NUMBER);
  if (!iso) {
    notes.push(`Check Twilio Voice geographic permissions for ${env.CUSTOMER_PHONE_NUMBER}'s country by hand (unknown calling code).`);
    return;
  }
  type Country = { low_risk_numbers_enabled: boolean | null; high_risk_special_numbers_enabled: boolean | null; high_risk_tollfraud_numbers_enabled: boolean | null; name: string };
  const url = `https://voice.twilio.com/v1/DialingPermissions/Countries/${iso}`;
  const country = await twilioFetch<Country>(twilio, url);
  if (country.low_risk_numbers_enabled) {
    log(`4. dialing permissions: ${country.name} (${iso}) low-risk numbers enabled ✔`);
    return;
  }
  if (CHECK_ONLY) {
    log(`4. would enable dialing to ${country.name} (${iso}) low-risk numbers`);
    return;
  }
  try {
    const update = [
      {
        iso_code: iso,
        low_risk_numbers_enabled: true,
        high_risk_special_numbers_enabled: Boolean(country.high_risk_special_numbers_enabled),
        high_risk_tollfraud_numbers_enabled: Boolean(country.high_risk_tollfraud_numbers_enabled),
      },
    ];
    await twilioFetch(twilio, "https://voice.twilio.com/v1/DialingPermissions/BulkCountryUpdates", { form: { UpdateRequest: JSON.stringify(update) } });
    const after = await twilioFetch<Country>(twilio, url);
    log(`4. dialing permissions: ${country.name} (${iso}) low-risk ${after.low_risk_numbers_enabled ? "enabled ✔" : "still disabled ✘"}`);
    if (!after.low_risk_numbers_enabled) throw new Error("not enabled after update");
  } catch (error) {
    notes.push(`Enable Twilio Voice geographic permissions for ${country.name} (Console → Voice → Settings → Geo permissions): ${(error as Error).message}`);
  }
}

async function step4Voices(el: El) {
  const statuses = await ensureAiVoices(el, { checkOnly: CHECK_ONLY });
  for (const status of statuses) {
    log(`4. AI voice ${describeAiVoiceStatus(status)}`);
    if (status.state === "missing") failures.push(`AI voice ${status.voice} (${status.voiceId}): ${status.detail}`);
  }
}

async function main() {
  const env = serverEnv();
  const baseUrl = requireEnv("PUBLIC_BASE_URL").replace(/\/$/, "");
  if (!baseUrl.startsWith("https://")) throw new Error("PUBLIC_BASE_URL must be the https production domain");
  const el: El = (path, init) => elevenLabsFetch(env.ELEVENLABS_API_KEY, path, init);
  const twilio: TwilioCredentials = { accountSid: env.TWILIO_ACCOUNT_SID, username: env.TWILIO_API_KEY_SID, password: env.TWILIO_API_KEY_SECRET };
  // Standard API keys can't read the Account resource; the auth token can.
  const twilioMain: TwilioCredentials = { accountSid: env.TWILIO_ACCOUNT_SID, username: env.TWILIO_ACCOUNT_SID, password: env.TWILIO_AUTH_TOKEN };
  const newEnv: Record<string, string> = {};

  console.log(`${CHECK_ONLY ? "Checking" : "Setting up"} Northgate Call Guard for ${baseUrl}`);
  await preflight(env, twilioMain);
  await step1DeleteFromElevenLabs(el, env);
  await step2PointTwilioNumber(env, twilio, baseUrl);
  await step3Agent(el, env, baseUrl, newEnv);
  await step4DialingPermissions(env, twilio);
  await step4Voices(el);

  notes.push(
    "Twilio Real-Time Transcription is covered by Twilio's Predictive and Generative AI/ML Features Addendum. If it isn't accepted yet, accept it in Console → Voice → Settings → Privacy & Security (error 95250 otherwise). This can't be checked through the API.",
  );

  if (Object.keys(newEnv).length && !CHECK_ONLY) {
    const token = process.env.VERCEL_TOKEN;
    if (token) {
      const synced = await upsertVercelEnv(newEnv, { token });
      log(`vercel: set ${synced.join(", ")} — redeploy to apply (vercel deploy --prod)`);
    } else {
      notes.push(`Set ${Object.keys(newEnv).join(", ")} on Vercel by hand (VERCEL_TOKEN not available).`);
    }
  }

  for (const n of notes) console.log(`NOTE: ${n}`);
  if (failures.length) {
    for (const f of failures) console.error(`FAIL: ${f}`);
    process.exit(1);
  }
  console.log(CHECK_ONLY ? "Check complete (no changes made)." : `Done. Calls to ${env.TWILIO_PHONE_NUMBER} now ring ${env.CUSTOMER_PHONE_NUMBER.slice(0, 4)}…${env.CUSTOMER_PHONE_NUMBER.slice(-3)} with Call Guard screening.`);
}

main().catch((error) => {
  console.error(error instanceof TwilioError || error instanceof ElevenLabsError ? error.message : error);
  process.exit(1);
});
