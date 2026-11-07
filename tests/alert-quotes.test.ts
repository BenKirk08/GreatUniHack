import { describe, expect, it } from "vitest";
import { alertQuotes, findVerbatim, keywordQuotes, MAX_ALERT_QUOTES, selectScammerQuotes } from "@/lib/alert-quotes";
import type { ScreeningSegment } from "@/lib/types";

const seg = (speaker: "caller" | "customer", text: string): Pick<ScreeningSegment, "speaker" | "text"> => ({ speaker, text });

const CALL = [
  seg("caller", "Good afternoon, this is Mark Davies from the Northgate Bank fraud department."),
  seg("customer", "Oh no. Should I move my savings to a safe account?"),
  seg("caller", "We're going to move your money into a secure safe account in your name while we investigate."),
  seg("customer", "Is that normal?"),
  seg("caller", "It's completely standard. But you mustn't tell anyone at your branch, because a member of staff is involved."),
  seg("caller", "Log into your banking app now while I stay on the line."),
];

describe("selectScammerQuotes", () => {
  it("returns at most two quotes", () => {
    const quotes = selectScammerQuotes(
      ["move your money into a secure safe account", "you mustn't tell anyone at your branch", "Log into your banking app now"],
      CALL,
    );
    expect(MAX_ALERT_QUOTES).toBe(2);
    expect(quotes).toHaveLength(2);
  });

  it("returns the caller's words exactly as transcribed (case, punctuation and whole words), not Claude's spelling", () => {
    expect(selectScammerQuotes(["MOVE YOUR MONEY into a secure safe-account", "you mustnt tell anyone at your branch"], CALL)).toEqual([
      "move your money into a secure safe account",
      "you mustn't tell anyone at your branch",
    ]);
  });

  it("takes quotes from the scammer's lines only, never the customer's", () => {
    // "move my savings to a safe account" and "Is that normal?" were said by the customer.
    expect(selectScammerQuotes(["Should I move my savings to a safe account?", "Is that normal?"], CALL)).toEqual([]);
    const mixed = selectScammerQuotes(["Should I move my savings to a safe account?", "It's completely standard."], CALL);
    expect(mixed).toEqual(["It's completely standard."]);
  });

  it("drops paraphrases, text spanning two lines, and non-strings", () => {
    expect(selectScammerQuotes(["We will transfer your cash to a protected account"], CALL)).toEqual([]);
    expect(selectScammerQuotes(["while we investigate. It's completely standard"], CALL)).toEqual([]);
    expect(selectScammerQuotes([42, null, { q: "x" }, "  "], CALL)).toEqual([]);
  });

  it("drops duplicates and quotes inside an earlier one", () => {
    expect(selectScammerQuotes(["you mustn't tell anyone at your branch", "tell anyone at your branch", "YOU MUSTN'T TELL ANYONE AT YOUR BRANCH"], CALL)).toEqual([
      "you mustn't tell anyone at your branch",
    ]);
  });

  it("returns a verbatim substring of a single caller line every time", () => {
    const callerLines = CALL.filter((s) => s.speaker === "caller").map((s) => s.text);
    for (const quote of selectScammerQuotes(["secure safe account in your name", "stay on the line"], CALL)) {
      expect(callerLines.some((line) => line.includes(quote))).toBe(true);
    }
  });
});

describe("findVerbatim", () => {
  it("widens to whole words and keeps closing punctuation", () => {
    expect(findVerbatim("afe account in your nam", "Move it to a safe account in your name.")).toBe("safe account in your name.");
    expect(findVerbatim("is this £4,800?", "Is this £4800? Yes.")).toBe("Is this £4800?");
  });

  it("ignores very short quotes", () => {
    expect(findVerbatim("Yes", "Yes, it is.")).toBeNull();
  });
});

describe("alertQuotes", () => {
  it("prefers Claude's verified picks, then keeps the last quotes, then falls back to caller lines with risk phrases", () => {
    expect(alertQuotes(["you mustn't tell anyone at your branch"], CALL, ["old quote"])).toEqual(["you mustn't tell anyone at your branch"]);
    expect(alertQuotes(["invented"], CALL, ["Log into your banking app now"])).toEqual(["Log into your banking app now"]);
    expect(alertQuotes(null, CALL, null)).toEqual(keywordQuotes(CALL));
    expect(keywordQuotes(CALL)).toEqual([
      "It's completely standard. But you mustn't tell anyone at your branch, because a member of staff is involved.",
      "We're going to move your money into a secure safe account in your name while we investigate.",
    ]);
    expect(alertQuotes([], [seg("caller", "Hello, lovely weather.")], [])).toEqual([]);
  });
});
