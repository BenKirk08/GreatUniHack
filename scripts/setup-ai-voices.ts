/**
 * Check the six AI voices (lib/ai-voices/config.ts) are in the ElevenLabs account's My Voices with their configured
 * IDs, adding any that are only in the public Voice Library. Idempotent.
 *
 *   npm run setup-ai-voices             # check and add
 *   npm run setup-ai-voices -- --check  # read-only
 */
import "./lib/load-env";
import { elevenLabsFetch } from "../lib/elevenlabs/client";
import { serverEnv } from "../lib/env";
import { describeAiVoiceStatus, ensureAiVoices, type ElevenLabsCall } from "./lib/ai-voices";

const CHECK_ONLY = process.argv.includes("--check");

async function main() {
  const env = serverEnv();
  const el: ElevenLabsCall = (path, init) => elevenLabsFetch(env.ELEVENLABS_API_KEY, path, init);
  console.log(`${CHECK_ONLY ? "Checking" : "Setting up"} the six AI voices in ElevenLabs My Voices`);
  const statuses = await ensureAiVoices(el, { checkOnly: CHECK_ONLY });
  for (const s of statuses) console.log(`  ${describeAiVoiceStatus(s)}`);
  const bad = statuses.filter((s) => s.state === "missing" || (!CHECK_ONLY && s.state === "would_add"));
  if (bad.length) {
    console.error(`${bad.length} AI voice(s) are not usable.`);
    process.exit(1);
  }
  const pending = statuses.filter((s) => s.state === "would_add").length;
  console.log(pending ? `${pending} voice(s) would be added (run without --check).` : "All six AI voices resolve in My Voices.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
