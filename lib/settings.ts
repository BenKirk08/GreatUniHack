import { serverEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normaliseSetting, type VoiceMatchSetting } from "@/lib/voice-match";

/** Runtime auto-send mode from the settings row (falls back to AUTO_SEND_REPORTS if the row is missing). */
export async function getAutoSend(): Promise<boolean> {
  const { data, error } = await supabaseAdmin().from("settings").select("auto_send").eq("id", 1).maybeSingle();
  if (error) throw new Error(`Could not read settings: ${error.message}`);
  return data ? Boolean(data.auto_send) : serverEnv().AUTO_SEND_REPORTS;
}

export async function setAutoSend(autoSend: boolean): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("settings")
    .upsert({ id: 1, auto_send: autoSend, updated_at: new Date().toISOString() }, { onConflict: "id" })
    .select("auto_send")
    .single();
  if (error) throw new Error(`Could not update settings: ${error.message}`);
  return Boolean(data.auto_send);
}

/** The customer's "Your AI voice match" (settings row; 0012). Either part may be unset; a missing row means unset. */
export async function getVoiceMatchSetting(): Promise<VoiceMatchSetting> {
  const { data, error } = await supabaseAdmin()
    .from("settings")
    .select("voice_match_age_band, voice_match_gender")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`Could not read the AI voice match: ${error.message}`);
  return normaliseSetting({ ageBand: data?.voice_match_age_band, gender: data?.voice_match_gender });
}

/** Save the customer's "Your AI voice match" (null clears a part). Creates the settings row if it is missing. */
export async function setVoiceMatchSetting(setting: VoiceMatchSetting): Promise<VoiceMatchSetting> {
  const db = supabaseAdmin();
  const values = { voice_match_age_band: setting.ageBand, voice_match_gender: setting.gender, updated_at: new Date().toISOString() };
  const { data, error } = await db.from("settings").update(values).eq("id", 1).select("voice_match_age_band, voice_match_gender");
  if (error) throw new Error(`Could not save the AI voice match: ${error.message}`);
  let row = (data ?? [])[0];
  if (!row) {
    const inserted = await db
      .from("settings")
      .upsert({ id: 1, auto_send: serverEnv().AUTO_SEND_REPORTS, ...values }, { onConflict: "id" })
      .select("voice_match_age_band, voice_match_gender")
      .single();
    if (inserted.error) throw new Error(`Could not save the AI voice match: ${inserted.error.message}`);
    row = inserted.data;
  }
  return normaliseSetting({ ageBand: row.voice_match_age_band, gender: row.voice_match_gender });
}
