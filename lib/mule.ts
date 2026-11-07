import { supabaseAdmin } from "@/lib/supabase/admin";
import { normaliseAccountNumber, normaliseName, normaliseSortCode } from "@/lib/normalise";
import { accountSnapshotSchema, type AccountSnapshot, type CheckedPayee, type MuleMatch } from "@/lib/types";
import { z } from "zod";

export const MULE_PATTERN = {
  minDistinctPayers: 4, // "more than 3"
  minTotalPence: 200_000, // £2,000
  maxTotalPence: 600_000, // £6,000
} as const;

/** The 48-hour activity profile of a money-mule account. */
export function fitsMulePattern(account: Pick<AccountSnapshot, "distinct_payers_48h" | "total_in_48h_pence">): boolean {
  return (
    account.distinct_payers_48h >= MULE_PATTERN.minDistinctPayers &&
    account.total_in_48h_pence >= MULE_PATTERN.minTotalPence &&
    account.total_in_48h_pence <= MULE_PATTERN.maxTotalPence
  );
}

export const lookupRowSchema = accountSnapshotSchema.extend({
  match_type: z.enum(["account", "name"]),
  total_in_48h_pence: z.coerce.number(),
});
export type LookupRow = z.infer<typeof lookupRowSchema>;

/** Runs the deterministic SQL lookup. Injected so the classification logic can be unit-tested. */
export type PayeeLookup = (sortCode: string | null, accountNumber: string | null, name: string | null) => Promise<LookupRow[]>;

export const supabasePayeeLookup: PayeeLookup = async (sortCode, accountNumber, name) => {
  const { data, error } = await supabaseAdmin().rpc("lookup_payee", {
    p_sort_code: sortCode,
    p_account_number: accountNumber,
    p_name: name,
  });
  if (error) throw new Error(`lookup_payee failed: ${error.message}`);
  return z.array(lookupRowSchema).parse(data ?? []);
};

function snapshot(row: LookupRow): AccountSnapshot {
  const { match_type: _matchType, ...account } = row;
  void _matchType;
  return account;
}

/**
 * Check a payee against Northgate's own accounts. No LLM involved:
 *  - sort code + account number are normalised, then must match exactly → "match" (a suspected mule)
 *  - a holder-name match on its own → "name_only", saved as a low-confidence warning
 * Returns null when there is nothing to check.
 */
export async function checkMule(
  payee: { name?: string | null; sort_code?: string | null; account_number?: string | null },
  lookup: PayeeLookup = supabasePayeeLookup,
  now: Date = new Date(),
): Promise<MuleMatch | null> {
  const checked: CheckedPayee = {
    name: payee.name?.trim() || null,
    sort_code: normaliseSortCode(payee.sort_code),
    account_number: normaliseAccountNumber(payee.account_number),
  };
  const hasAccount = Boolean(checked.sort_code && checked.account_number);
  const hasName = Boolean(normaliseName(checked.name));
  if (!hasAccount && !hasName) return null;

  const rows = await lookup(
    hasAccount ? checked.sort_code : null,
    hasAccount ? checked.account_number : null,
    hasName ? checked.name : null,
  );
  const checked_at = now.toISOString();

  // Only an exact sort code + account number match counts as a mule match.
  const exact = rows.find(
    (r) => r.match_type === "account" && r.sort_code === checked.sort_code && r.account_number === checked.account_number,
  );
  if (exact) {
    const account = snapshot(exact);
    return { status: "match", confidence: "high", account, mule_pattern: fitsMulePattern(account), checked, checked_at };
  }

  const byName = rows.filter((r) => r.match_type === "name");
  if (byName.length > 0) {
    const names = byName.map((r) => `${r.holder_name} (${r.sort_code} ${r.account_number})`).join("; ");
    return {
      status: "name_only",
      confidence: "low",
      warning: hasAccount
        ? `Payee name matches Northgate account holder ${names}, but the sort code and account number given do not. Low confidence — names are not unique.`
        : `Payee name matches Northgate account holder ${names}; no complete sort code and account number were given. Low confidence — names are not unique.`,
      candidates: byName.map(snapshot),
      checked,
      checked_at,
    };
  }

  return { status: "no_match", checked, checked_at };
}
