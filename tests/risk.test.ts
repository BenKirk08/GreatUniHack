import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildRisk,
  combineScore,
  isStaleRiskWrite,
  keywordFloor,
  matchedKeywords,
  parseRiskToolInput,
  scoringDecision,
} from "@/lib/risk";
import type { CallRisk, ScreeningSegment } from "@/lib/types";

const at = (s: number) => new Date(Date.UTC(2026, 10, 6, 12, 0, s)).toISOString();
const caller = (text: string, s = 0): ScreeningSegment => ({ speaker: "caller", text, at: at(s) });
const customer = (text: string, s = 0): ScreeningSegment => ({ speaker: "customer", text, at: at(s) });

describe("keyword floor", () => {
  it("is zero for an ordinary call", () => {
    expect(keywordFloor([caller("Hi Ben, it's the dental surgery confirming Tuesday at ten."), customer("Lovely, thanks.")])).toBe(0);
  });

  it("adds 20 per distinct phrase the caller says", () => {
    expect(keywordFloor([caller("We need to move your money to a safe account.")])).toBe(40);
    expect(keywordFloor([caller("safe account"), caller("the safe account again")])).toBe(20);
  });

  it("is capped at 60", () => {
    const segs = [caller("This is HMRC. You face arrest. Pay with gift cards, install AnyDesk, and don't tell anyone. Read me the code.")];
    expect(matchedKeywords(segs).length).toBeGreaterThan(3);
    expect(keywordFloor(segs)).toBe(60);
  });

  it("only counts the caller, not the customer", () => {
    expect(keywordFloor([customer("Is this about my HMRC refund? Should I call the courier?")])).toBe(0);
  });

  it("matches speech-to-text spellings", () => {
    expect(matchedKeywords([caller("install any desk please"), caller("this is H M R C"), caller("do not tell anyone"), caller("read me the code on your phone")])).toEqual([
      "don't tell anyone",
      "HMRC",
      "AnyDesk",
      "read me the code",
    ]);
  });
});

describe("score combination and the stale-write guard", () => {
  it("takes max(floor, Claude), clamped", () => {
    expect(combineScore(40, 85)).toBe(85);
    expect(combineScore(60, 12)).toBe(60);
    expect(combineScore(0, null)).toBe(0);
    expect(combineScore(20, 140)).toBe(100);
    expect(combineScore(20, Number.NaN)).toBe(20);
  });

  it("keywords alone can never reach the default threshold", () => {
    const risk = buildRisk([caller("HMRC arrest gift card AnyDesk courier safe account")], null, null);
    expect(risk.score).toBe(60);
    expect(risk.model).toBe("keywords-only");
    expect(risk.reason).toContain("HMRC");
  });

  it("skips a write when the stored score saw more segments", () => {
    expect(isStaleRiskWrite({ segments_scored: 8 }, 6)).toBe(true);
    expect(isStaleRiskWrite({ segments_scored: 8 }, 8)).toBe(false);
    expect(isStaleRiskWrite({ segments_scored: 8 }, 9)).toBe(false);
    expect(isStaleRiskWrite(null, 0)).toBe(false);
  });

  it("normalises Claude's tool input", () => {
    expect(parseRiskToolInput({ risk_score: "87.6", scam_type: "safe_account", tactics: ["urgency", "bogus", "urgency"], reason: " They want  you to move money. " }, "m")).toEqual({
      risk_score: 88,
      scam_type: "safe_account",
      tactics: ["urgency"],
      reason: "They want you to move money.",
      quotes: [],
      model: "m",
    });
    expect(parseRiskToolInput({ risk_score: -5, scam_type: "nonsense", tactics: [], reason: "" }, "m").scam_type).toBe("unknown");
  });

  it("builds the stored risk with the segment count and Claude's view", () => {
    const segs = [caller("Move your money to a safe account", 1), customer("Why?", 2)];
    const risk = buildRisk(
      segs,
      { risk_score: 91, scam_type: "safe_account", tactics: ["urgency"], reason: "They want your savings moved.", quotes: ["move your money to a SAFE ACCOUNT", "Why?"], model: "haiku" },
      null,
      new Date(at(3)),
    );
    expect(risk).toMatchObject({ score: 91, peak: 91, scam_type: "safe_account", segments_scored: 2, keyword_floor: 40, scored_at: at(3), model: "haiku" });
    // Only the caller's words, exactly as transcribed (the customer's "Why?" is dropped).
    expect(risk.quotes).toEqual(["Move your money to a safe account"]);
  });

  it("keeps the alert's quotes when a later scoring finds none, and falls back to caller lines with risk phrases", () => {
    const segs = [caller("This is HMRC. You will be arrested tonight.", 1), customer("What?", 2), caller("Pay with gift cards now.", 3)];
    const previous = buildRisk(segs, { risk_score: 90, scam_type: "hmrc", tactics: [], reason: "r", quotes: ["You will be arrested tonight"], model: "h" }, null);
    expect(previous.quotes).toEqual(["You will be arrested tonight."]);
    // Claude failed (null) or gave nothing usable: the previous quotes stay.
    expect(buildRisk(segs, null, previous).quotes).toEqual(["You will be arrested tonight."]);
    expect(buildRisk(segs, { ...previous, risk_score: 90, quotes: ["made up words"], model: "h" }, previous).quotes).toEqual(["You will be arrested tonight."]);
    // Nothing before either: the caller's own lines with risk phrases, most recent first.
    expect(buildRisk(segs, null, null).quotes).toEqual(["Pay with gift cards now.", "This is HMRC. You will be arrested tonight."]);
  });

  it("asks Claude for the caller's most suspicious quotes", () => {
    expect(parseRiskToolInput({ risk_score: 80, scam_type: "hmrc", tactics: [], reason: "", suspicious_quotes: ["a", "b"] }, "m").quotes).toEqual(["a", "b"]);
  });
});

describe("when to score", () => {
  const started = at(0);
  const scored = (n: number, s: number): Pick<CallRisk, "segments_scored" | "scored_at"> => ({ segments_scored: n, scored_at: at(s) });

  it("scores after 2 new caller segments", () => {
    const segs = [caller("a", 1), customer("b", 2), caller("c", 3), caller("d", 4)];
    expect(scoringDecision(segs, scored(2, 2), started, Date.parse(at(5))).score).toBe(true);
  });

  it("waits with only one new caller segment inside 10 seconds, and says how long", () => {
    const segs = [caller("a", 1), customer("b", 2), caller("c", 3)];
    const d = scoringDecision(segs, scored(2, 2), started, Date.parse(at(5)));
    expect(d).toMatchObject({ score: false, newSegments: 1, newCallerSegments: 1 });
    expect(d.waitMs).toBe(7000);
  });

  it("scores any new segment once 10 seconds have passed", () => {
    const segs = [caller("a", 1), customer("b", 13)];
    expect(scoringDecision(segs, scored(1, 2), started, Date.parse(at(12))).score).toBe(true);
  });

  it("does nothing without new segments", () => {
    const segs = [caller("a", 1)];
    expect(scoringDecision(segs, scored(1, 1), started, Date.parse(at(100)))).toMatchObject({ score: false, waitMs: 0 });
  });

  it("measures the first score from the call start", () => {
    expect(scoringDecision([caller("hello", 3)], null, started, Date.parse(at(4))).score).toBe(false);
    expect(scoringDecision([caller("hello", 11)], null, started, Date.parse(at(11))).score).toBe(true);
  });
});

/* Integration: the real record_risk_score() / decline_offer() SQL (runs when .env.local is present). */
const hasDb = existsSync(".env.local");
describe.runIf(hasDb)("record_risk_score (Supabase)", () => {
  it("keeps the peak, skips stale writes, offers once, and re-offers only 15+ above the declined score", async () => {
    process.loadEnvFile(".env.local");
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const db = supabaseAdmin();
    const sid = `CAtest${randomBytes(14).toString("hex")}`;
    const { data: row, error } = await db.from("calls").insert({ twilio_call_sid: sid, caller_masked: "•••000", status: "live" }).select("id").single();
    if (error) throw error;
    const id = row.id as string;
    const save = async (score: number, segments: number) => {
      const risk = { score, peak: score, scam_type: "safe_account", tactics: [], reason: "test", segments_scored: segments, scored_at: new Date().toISOString() };
      const { data, error: e } = await db.rpc("record_risk_score", { p_call_id: id, p_risk: risk, p_threshold: 70 });
      if (e) throw e;
      return data as { saved: boolean; offered?: boolean; peak?: number; reason?: string };
    };
    try {
      expect(await save(40, 2)).toMatchObject({ saved: true, offered: false, peak: 40 });
      expect(await save(30, 1)).toMatchObject({ saved: false, reason: "stale" });
      expect(await save(75, 4)).toMatchObject({ saved: true, offered: true, peak: 75 });
      expect(await save(80, 5)).toMatchObject({ saved: true, offered: false, peak: 80 }); // already offered
      expect(await save(50, 6)).toMatchObject({ saved: true, peak: 80 }); // the peak never drops

      const { data: declined } = await db.rpc("decline_offer", { p_call_id: id });
      expect((declined as { handoff_status: string; declined_score: number }[])[0]).toMatchObject({ handoff_status: "declined", declined_score: 50 });
      expect(await save(64, 7)).toMatchObject({ saved: true, offered: false }); // 14 above the declined score
      expect(await save(65, 8)).toMatchObject({ saved: true, offered: false }); // 15 above, but below the threshold
      expect(await save(70, 9)).toMatchObject({ saved: true, offered: true }); // 15+ above and at the threshold

      await db.rpc("decline_offer", { p_call_id: id }); // declined again at 70
      expect(await save(84, 10)).toMatchObject({ saved: true, offered: false }); // 14 above
      expect(await save(85, 11)).toMatchObject({ saved: true, offered: true }); // 15 above

      const { data: final } = await db.from("calls").select("risk, handoff_status").eq("id", id).single();
      expect(final?.handoff_status).toBe("offered");
      expect(final?.risk.peak).toBe(85);
      expect(final?.risk.threshold_crossed_score).toBe(75);
      expect(typeof final?.risk.threshold_crossed_at).toBe("string");
    } finally {
      await db.from("calls").delete().eq("id", id);
    }
  });

  it("appends screening segments in time order and ignores retries", async () => {
    process.loadEnvFile(".env.local");
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const db = supabaseAdmin();
    const sid = `CAtest${randomBytes(14).toString("hex")}`;
    const { data: row, error } = await db.from("calls").insert({ twilio_call_sid: sid, caller_masked: "•••000", status: "live" }).select("id").single();
    if (error) throw error;
    try {
      const append = (segment: ScreeningSegment) => db.rpc("append_screening_segment", { p_call_sid: sid, p_segment: segment });
      await append({ speaker: "customer", text: "second", at: at(2), seq: 3 });
      await append({ speaker: "caller", text: "first", at: at(1), seq: 2 });
      const retry = await append({ speaker: "caller", text: "first", at: at(1), seq: 2 });
      expect(retry.data).toEqual([]);
      const { data } = await db.from("calls").select("screening_transcript").eq("id", row.id).single();
      expect((data?.screening_transcript as ScreeningSegment[]).map((s) => s.text)).toEqual(["first", "second"]);
    } finally {
      await db.from("calls").delete().eq("id", row.id);
    }
  });
});
