import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkMule, fitsMulePattern, type LookupRow, type PayeeLookup } from "@/lib/mule";
import { normaliseName } from "@/lib/normalise";

/** In-memory stand-in for public.lookup_payee() with the same semantics. */
const ACCOUNTS: Omit<LookupRow, "match_type">[] = [
  {
    id: "mule-1",
    holder_name: "Daniel Price",
    sort_code: "99-50-17",
    account_number: "41873026",
    status: "active",
    payments_in_48h: 7,
    distinct_payers_48h: 6,
    total_in_48h_pence: 487_500,
  },
  {
    id: "normal-1",
    holder_name: "Sarah Mitchell",
    sort_code: "99-50-03",
    account_number: "20481937",
    status: "active",
    payments_in_48h: 1,
    distinct_payers_48h: 1,
    total_in_48h_pence: 245_000,
  },
];

const fakeLookup: PayeeLookup = async (sortCode, accountNumber, name) => {
  const rows: LookupRow[] = [];
  for (const a of ACCOUNTS) {
    if (sortCode && accountNumber && a.sort_code === sortCode && a.account_number === accountNumber) {
      rows.push({ ...a, match_type: "account" });
    } else if (name && normaliseName(a.holder_name) === normaliseName(name)) {
      rows.push({ ...a, match_type: "name" });
    }
  }
  return rows;
};

describe("fitsMulePattern", () => {
  it("needs more than 3 distinct payers and £2k–£6k in", () => {
    expect(fitsMulePattern({ distinct_payers_48h: 6, total_in_48h_pence: 487_500 })).toBe(true);
    expect(fitsMulePattern({ distinct_payers_48h: 3, total_in_48h_pence: 487_500 })).toBe(false);
    expect(fitsMulePattern({ distinct_payers_48h: 4, total_in_48h_pence: 72_000 })).toBe(false);
    expect(fitsMulePattern({ distinct_payers_48h: 5, total_in_48h_pence: 650_000 })).toBe(false);
    expect(fitsMulePattern({ distinct_payers_48h: 4, total_in_48h_pence: 200_000 })).toBe(true);
  });
});

describe("checkMule", () => {
  it("returns null when there is nothing to check", async () => {
    const lookup = vi.fn(fakeLookup);
    expect(await checkMule({}, lookup)).toBeNull();
    expect(await checkMule({ sort_code: "12", account_number: null, name: "  " }, lookup)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("matches on normalised sort code + account number (high confidence)", async () => {
    const result = await checkMule({ name: "D Price", sort_code: "99 50 17", account_number: "4187-3026" }, fakeLookup);
    expect(result?.status).toBe("match");
    if (result?.status !== "match") throw new Error("expected match");
    expect(result.confidence).toBe("high");
    expect(result.account.id).toBe("mule-1");
    expect(result.mule_pattern).toBe(true);
    expect(result.checked).toEqual({ name: "D Price", sort_code: "99-50-17", account_number: "41873026" });
  });

  it("matches spoken digits", async () => {
    const result = await checkMule(
      { sort_code: "nine nine five oh one seven", account_number: "four one eight seven three oh two six" },
      fakeLookup,
    );
    expect(result?.status).toBe("match");
  });

  it("a name-only match is a low-confidence warning, never a mule match", async () => {
    const result = await checkMule({ name: "Sarah Mitchell", sort_code: "30-94-57", account_number: "12345678" }, fakeLookup);
    expect(result?.status).toBe("name_only");
    if (result?.status !== "name_only") throw new Error("expected name_only");
    expect(result.confidence).toBe("low");
    expect(result.candidates.map((c) => c.id)).toEqual(["normal-1"]);
    expect(result.warning).toMatch(/Low confidence/);
  });

  it("a right account number with the wrong sort code is not a match", async () => {
    const result = await checkMule({ sort_code: "99-50-18", account_number: "41873026" }, fakeLookup);
    expect(result?.status).toBe("no_match");
  });

  it("passes only complete, normalised account details to the SQL lookup", async () => {
    const lookup = vi.fn(fakeLookup);
    await checkMule({ name: "Daniel Price", sort_code: "99-50-17", account_number: "123" }, lookup);
    expect(lookup).toHaveBeenCalledWith(null, null, "Daniel Price");
  });
});

/* Integration: the real SQL function against the seeded database (runs when .env.local is present). */
const hasDb = existsSync(".env.local");
describe.runIf(hasDb)("lookup_payee (Supabase)", () => {
  it("finds the seeded mule by exact account and Sarah Mitchell by name only", async () => {
    process.loadEnvFile(".env.local");
    const { supabasePayeeLookup } = await import("@/lib/mule");

    const mule = await checkMule({ name: "Daniel Price", sort_code: "995017", account_number: "41873026" }, supabasePayeeLookup);
    expect(mule?.status).toBe("match");
    if (mule?.status === "match") {
      expect(mule.account.holder_name).toBe("Daniel Price");
      expect(mule.account.distinct_payers_48h).toBeGreaterThan(3);
      expect(mule.mule_pattern).toBe(true);
    }

    const nameOnly = await checkMule({ name: "Mrs Sarah Mitchell", sort_code: "30-94-57", account_number: "12345678" }, supabasePayeeLookup);
    expect(nameOnly?.status).toBe("name_only");

    const none = await checkMule({ name: "Nobody Atall", sort_code: "11-22-33", account_number: "44556677" }, supabasePayeeLookup);
    expect(none?.status).toBe("no_match");
  });
});
