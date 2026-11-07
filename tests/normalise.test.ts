import { describe, expect, it } from "vitest";
import {
  maskCaller,
  normaliseAccountNumber,
  normaliseName,
  normaliseSortCode,
  parseAmountGbp,
  spokenToDigits,
} from "@/lib/normalise";

describe("normaliseSortCode", () => {
  it.each([
    ["99-50-17", "99-50-17"],
    ["995017", "99-50-17"],
    ["99 50 17", "99-50-17"],
    ["99.50.17", "99-50-17"],
    [" 99–50–17 ", "99-50-17"],
    ["nine nine five oh one seven", "99-50-17"],
    ["double nine, five zero, one seven", "99-50-17"],
    ["99-50-1", null],
    ["99-50-177", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("%s → %s", (input, expected) => {
    expect(normaliseSortCode(input as string | null | undefined)).toBe(expected);
  });
});

describe("normaliseAccountNumber", () => {
  it.each([
    ["41873026", "41873026"],
    ["4187 3026", "41873026"],
    ["41-87-30-26", "41873026"],
    ["four one eight seven three oh two six", "41873026"],
    ["1873026", "01873026"], // 7-digit legacy numbers are zero-padded
    ["418730261", null],
    ["12345", null],
    ["", null],
    [null, null],
  ])("%s → %s", (input, expected) => {
    expect(normaliseAccountNumber(input as string | null)).toBe(expected);
  });
});

describe("spokenToDigits", () => {
  it("handles double/triple and mixed tokens", () => {
    expect(spokenToDigits("triple seven, 2 oh")).toBe("77720");
    expect(spokenToDigits("one-two three")).toBe("123");
  });
});

describe("normaliseName", () => {
  it("drops titles, punctuation and case", () => {
    expect(normaliseName("Mr. Daniel  PRICE")).toBe("daniel price");
    expect(normaliseName("Grace O'Connell")).toBe("grace o connell");
    expect(normaliseName("   ")).toBeNull();
  });
});

describe("maskCaller", () => {
  it("keeps only the last three digits", () => {
    expect(maskCaller("+447700900123")).toBe("•••123");
    expect(maskCaller("+1 (445) 275-5928")).toBe("•••928");
    expect(maskCaller("")).toBe("withheld");
    expect(maskCaller(undefined)).toBe("withheld");
  });
});

describe("parseAmountGbp", () => {
  it("parses common forms", () => {
    expect(parseAmountGbp("£2,500")).toBe(2500);
    expect(parseAmountGbp("4.5k")).toBe(4500);
    expect(parseAmountGbp("3 grand")).toBe(3000);
    expect(parseAmountGbp("about 1200 pounds")).toBe(1200);
    expect(parseAmountGbp("lots")).toBeNull();
  });
});
