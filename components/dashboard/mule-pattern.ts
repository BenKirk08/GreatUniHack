// Client copy of the mule-pattern rule (lib/mule.ts imports the server Supabase client, so it can't be bundled).
export function fitsMulePatternClient(a: { distinct_payers_48h: number; total_in_48h_pence: number }): boolean {
  return a.distinct_payers_48h > 3 && a.total_in_48h_pence >= 200_000 && a.total_in_48h_pence <= 600_000;
}
