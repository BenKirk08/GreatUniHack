import { existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { postCallTranscriptionSchema } from "@/lib/elevenlabs/webhook";
import { combinedTranscript } from "@/lib/transcript";
import { northgateCallIdFrom, recordDetailsSchema } from "@/lib/validation";

describe("northgate_call_id", () => {
  it("accepts our call UUIDs and rejects placeholders and junk", () => {
    const id = randomUUID();
    expect(northgateCallIdFrom(id)).toBe(id);
    expect(northgateCallIdFrom(` ${id} `)).toBe(id);
    for (const bad of ["", "None", "{{northgate_call_id}}", "not-a-call", 42, null, undefined, "1; drop table calls"]) {
      expect(northgateCallIdFrom(bad)).toBeNull();
    }
  });

  it("is carried by record_details", () => {
    const id = randomUUID();
    const body = recordDetailsSchema.parse({ conversation_id: "conv_1", northgate_call_id: id, payee_name: "Daniel Price" });
    expect(northgateCallIdFrom(body.northgate_call_id)).toBe(id);
  });

  it("is read from the post-call webhook's conversation_initiation_client_data.dynamic_variables", () => {
    const id = randomUUID();
    const event = postCallTranscriptionSchema.parse({
      type: "post_call_transcription",
      data: { conversation_id: "conv_1", conversation_initiation_client_data: { dynamic_variables: { northgate_call_id: id, system__caller_id: "+447700900481" } } },
    });
    expect(northgateCallIdFrom(event.data.conversation_initiation_client_data?.dynamic_variables?.northgate_call_id)).toBe(id);
  });
});

describe("combined transcript", () => {
  it("is the screening transcript followed by the persona's, shifted to call time", () => {
    const turns = combinedTranscript({
      started_at: "2026-11-06T12:00:00.000Z",
      handoff_at: "2026-11-06T12:01:00.000Z",
      screening_transcript: [
        { speaker: "caller", text: "Northgate fraud team here.", at: "2026-11-06T12:00:05.000Z" },
        { speaker: "customer", text: "Oh?", at: "2026-11-06T12:00:09.500Z" },
      ],
      transcript: [
        { role: "agent", message: "Hello? Sorry dear, Ben's just handed me the phone.", time_in_call_secs: 0 },
        { role: "scammer", message: "Sort code 99-50-17.", time_in_call_secs: 12 },
      ],
    });
    expect(turns).toEqual([
      { role: "scammer", message: "Northgate fraud team here.", time_in_call_secs: 5 },
      { role: "customer", message: "Oh?", time_in_call_secs: 9.5 },
      { role: "agent", message: "Hello? Sorry dear, Ben's just handed me the phone.", time_in_call_secs: 60 },
      { role: "scammer", message: "Sort code 99-50-17.", time_in_call_secs: 72 },
    ]);
  });
});

/* Integration: linking by northgate_call_id against Supabase (runs when .env.local is present). */
const hasDb = existsSync(".env.local");
describe.runIf(hasDb)("linking by northgate_call_id (Supabase)", () => {
  it("links the persona conversation to the screened call and finds it by either id", async () => {
    process.loadEnvFile(".env.local");
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const { findCallForConversation, linkPersonaSnapshot } = await import("@/lib/pipeline");
    const db = supabaseAdmin();
    const { data: row, error } = await db
      .from("calls")
      .insert({ twilio_call_sid: `CAtest${randomBytes(14).toString("hex")}`, caller_masked: "•••000", status: "live", handoff_status: "connected" })
      .select("id")
      .single();
    if (error) throw error;
    const conversationId = `conv_test_${randomBytes(6).toString("hex")}`;
    try {
      const longer = [
        { role: "agent" as const, message: "Hello?" },
        { role: "scammer" as const, message: "Daniel Price, 99-50-17." },
      ];
      const linked = await linkPersonaSnapshot({ callId: row.id, conversationId, transcript: longer, notes: { payee_name: "Daniel Price" } });
      expect(linked).toMatchObject({ id: row.id, conversation_id: conversationId });
      // A shorter (older) snapshot never replaces a longer one; notes merge; conversation_id is set once.
      const again = await linkPersonaSnapshot({ callId: row.id, conversationId: "conv_other", transcript: longer.slice(0, 1), notes: { sort_code: "995017" } });
      expect(again?.transcript).toHaveLength(2);
      expect(again?.conversation_id).toBe(conversationId);
      expect(again?.agent_notes).toEqual({ payee_name: "Daniel Price", sort_code: "995017" });

      expect((await findCallForConversation(row.id, null))?.id).toBe(row.id);
      expect((await findCallForConversation(null, conversationId))?.id).toBe(row.id);
      expect(await findCallForConversation(randomUUID(), "conv_missing")).toBeNull();
      expect(await linkPersonaSnapshot({ callId: randomUUID(), conversationId: "x", transcript: [] })).toBeNull();
    } finally {
      await db.from("calls").delete().eq("id", row.id);
    }
  });
});
