"use client";

import { AlertTriangle, Loader2, Lock, Snowflake } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fitsMulePatternClient } from "@/components/dashboard/mule-pattern";
import { SCAM_TYPE_LABELS, TACTIC_LABELS } from "@/lib/format";
import { formatPence, formatPounds } from "@/lib/normalise";
import type { BankAccountRow, CallRow } from "@/lib/types";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  );
}

export function IntelPanel(props: {
  call: CallRow | null;
  accounts: Record<string, BankAccountRow>;
  onFreeze: (accountId: string) => Promise<void>;
}) {
  const [freezing, setFreezing] = useState(false);
  const intel = props.call?.intel ?? null;
  const mule = props.call?.mule_match ?? null;
  const live = props.call?.status === "live";

  const freeze = async (id: string) => {
    setFreezing(true);
    try {
      await props.onFreeze(id);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setFreezing(false);
    }
  };

  return (
    <section className="flex min-h-[20rem] flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card/80 lg:min-h-0">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Intelligence</h2>
        {live && intel && <span className="text-[11px] text-muted-foreground">updates live</span>}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {!props.call && <p className="py-10 text-center text-sm text-muted-foreground">No call selected.</p>}
        {props.call && !intel && (
          <p className="flex items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
            {live && <Loader2 className="size-4 animate-spin" />}
            {live ? "Building intelligence from the call…" : "No intelligence was extracted."}
          </p>
        )}

        {mule?.status === "match" &&
          (() => {
            const account = props.accounts[mule.account.id] ?? { ...mule.account, frozen_at: null };
            const frozen = account.status === "frozen";
            return (
              <div className={`rounded-lg border-2 p-3 ${frozen ? "border-sky-400/60 bg-sky-400/10" : "border-destructive bg-destructive/15"}`}>
                <div className={`flex items-center gap-2 font-bold tracking-wide ${frozen ? "text-sky-300" : "text-destructive"}`}>
                  <AlertTriangle className="size-5" />
                  SUSPECTED MULE ACCOUNT
                </div>
                <div className="mt-2 text-sm">
                  <div className="font-semibold">{account.holder_name}</div>
                  <div className="font-mono">
                    {account.sort_code} · {account.account_number}
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded bg-background/40 p-2">
                    <div className="font-mono text-xl font-bold">{account.distinct_payers_48h}</div>
                    <div className="text-[11px] text-muted-foreground">distinct payers (48h)</div>
                  </div>
                  <div className="rounded bg-background/40 p-2">
                    <div className="font-mono text-xl font-bold">{formatPence(account.total_in_48h_pence)}</div>
                    <div className="text-[11px] text-muted-foreground">paid in (48h)</div>
                  </div>
                </div>
                {!fitsMulePatternClient(account) && (
                  <p className="mt-2 text-xs text-muted-foreground">Activity alone doesn&apos;t fit the mule pattern, but a scammer named this account.</p>
                )}
                {frozen ? (
                  <div className="mt-3 flex items-center gap-2 text-sm font-semibold text-sky-300">
                    <Lock className="size-4" /> FROZEN
                  </div>
                ) : (
                  <Button className="mt-3 w-full" variant="destructive" disabled={freezing} onClick={() => freeze(account.id)}>
                    {freezing ? <Loader2 className="animate-spin" /> : <Snowflake />} Freeze account
                  </Button>
                )}
              </div>
            );
          })()}

        {mule?.status === "name_only" && (
          <div className="rounded-lg border border-amber-400/50 bg-amber-400/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-semibold text-amber-300">
              <AlertTriangle className="size-4" /> Low-confidence name match
            </div>
            <p className="mt-1 text-amber-100/90">{mule.warning}</p>
          </div>
        )}

        {intel && (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-3">
                <Field label="Scam type">
                  <span className="text-base font-semibold">{SCAM_TYPE_LABELS[intel.scam_type]}</span>
                </Field>
                <Field label="Claims to be">{intel.impersonated_org ?? <span className="text-muted-foreground">not given yet</span>}</Field>
                {intel.caller_name && <Field label="Caller name">{intel.caller_name}</Field>}
              </div>
              <div className="text-right text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Intel risk
                <div className="font-mono text-lg font-bold text-foreground">{intel.risk_score}</div>
              </div>
            </div>

            <Field label="Tactics">
              <div className="mt-1 flex flex-wrap gap-1.5">
                {intel.tactics.length === 0 && <span className="text-muted-foreground">none spotted yet</span>}
                {intel.tactics.map((t) => (
                  <Badge key={t} variant="outline" className="border-amber-400/40 bg-amber-400/10 text-amber-200">
                    {TACTIC_LABELS[t]}
                  </Badge>
                ))}
              </div>
            </Field>

            <div className="rounded-lg border border-border bg-background/40 p-3">
              <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Payee</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <Field label="Name">{intel.payee.name ?? "—"}</Field>
                <Field label="Amount">{intel.amount_gbp != null ? formatPounds(intel.amount_gbp) : "—"}</Field>
                <Field label="Sort code">
                  <span className="font-mono">{intel.payee.sort_code ?? "—"}</span>
                </Field>
                <Field label="Account">
                  <span className="font-mono">{intel.payee.account_number ?? "—"}</span>
                </Field>
              </div>
              {mule?.status === "no_match" && (
                <p className="mt-2 text-xs text-muted-foreground">Not a Northgate account — held at another bank.</p>
              )}
            </div>

            {intel.callback_numbers.length > 0 && (
              <Field label="Callback numbers">
                <span className="font-mono">{intel.callback_numbers.join(", ")}</span>
              </Field>
            )}

            {intel.summary && <Field label="Summary">{intel.summary}</Field>}

            {intel.key_quotes.length > 0 && (
              <Field label="Key quotes">
                <ul className="mt-1 space-y-1.5">
                  {intel.key_quotes.map((q, i) => (
                    <li key={i} className="border-l-2 border-rose-400/50 pl-2 text-rose-100/90 italic">
                      “{q}”
                    </li>
                  ))}
                </ul>
              </Field>
            )}
          </>
        )}
      </div>
    </section>
  );
}
