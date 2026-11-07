import { elevenLabsFetch } from "@/lib/elevenlabs/client";

export interface RegisterCallInput {
  agent_id: string;
  from_number: string;
  to_number: string;
  direction: "inbound" | "outbound";
  conversation_initiation_client_data: {
    dynamic_variables: Record<string, string | number | boolean>;
    conversation_config_override: {
      agent: { prompt: { prompt: string }; first_message: string };
      tts: { voice_id: string };
    };
  };
}

/** Pull the TwiML out of register-call's response (documented as TwiML; tolerate a JSON-wrapped string too). */
export function twimlFromRegisterCallResponse(body: unknown): string {
  let twiml: unknown = body;
  if (twiml && typeof twiml === "object" && "twiml" in twiml) twiml = (twiml as { twiml: unknown }).twiml;
  if (typeof twiml !== "string" || !/<Response[\s>]/.test(twiml)) {
    throw new Error(`register-call did not return TwiML (got ${typeof body === "string" ? body.slice(0, 120) : typeof body})`);
  }
  return twiml.trim();
}

/**
 * POST /v1/convai/twilio/register-call: registers a call we handle on our own Twilio number and returns the TwiML
 * that connects it to the agent. Nothing happens to the live call until we apply that TwiML.
 */
export async function registerTwilioCall(apiKey: string, input: RegisterCallInput, timeoutMs = 10_000): Promise<string> {
  const body = await elevenLabsFetch<unknown>(apiKey, "/v1/convai/twilio/register-call", { method: "POST", body: input, timeoutMs });
  return twimlFromRegisterCallResponse(body);
}
