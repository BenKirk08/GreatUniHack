import "../lib/load-env";
import { forcedToolCall, claudeModel } from "../../lib/anthropic";
import { UPDATE_FRAUD_INTEL_TOOL, buildIntel } from "../../lib/intel";
import { transcriptToText } from "../../lib/transcript";
import type { TranscriptTurn } from "../../lib/types";

const transcript: TranscriptTurn[] = [
  { role: "agent", message: "Hello? Margaret speaking... sorry dear, I was just feeding Biscuit. Who's this?", time_in_call_secs: 0 },
  { role: "scammer", message: "Hello Mrs Ellis, this is Mark from the Northgate Bank fraud department. We've detected suspicious payments and your savings are at risk. You need to act right now.", time_in_call_secs: 6 },
  { role: "agent", message: "Oh my goodness. Hold on dear, let me find my pen.", time_in_call_secs: 14 },
  { role: "scammer", message: "Move the money to a safe account. Sort code nine nine, five zero, one seven. Account number four one eight seven three zero two six. Name is Daniel Price. Don't tell anyone at the branch.", time_in_call_secs: 20 },
];
const started = Date.now();
const raw = await forcedToolCall({ system: "Extract fraud intel about the scammer.", tool: UPDATE_FRAUD_INTEL_TOOL, effort: "low", user: `<transcript>\n${transcriptToText(transcript)}\n</transcript>` });
console.log(`model=${claudeModel()} took ${Date.now() - started}ms`);
console.log(JSON.stringify(buildIntel(raw, transcript, {}, claudeModel()), null, 1));
