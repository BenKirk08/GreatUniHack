"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { CallList } from "@/components/dashboard/call-list";
import { DashboardHeader } from "@/components/dashboard/header";
import { IntelPanel } from "@/components/dashboard/intel-panel";
import { ReportPanel } from "@/components/dashboard/report-panel";
import { RiskPanel } from "@/components/dashboard/risk-panel";
import { TranscriptView } from "@/components/dashboard/transcript";
import { takeoverLabel } from "@/lib/persona-meta";
import { useChangeSignals, type ChangeSignal } from "@/lib/supabase/change-signals";
import type { BankAccountRow, CallRow, ReportRow, SettingsRow, TakeoverKind } from "@/lib/types";
import { VOICE_TWIN_LABEL } from "@/lib/voice-twin/config";

type Connection = "connecting" | "live" | "offline";

/** POST to a dashboard action route; the browser re-sends the Basic auth credentials automatically. */
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** GET a dashboard read route (Basic auth is re-sent by the browser). */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** The tables the dashboard shows, i.e. the ones /api/dashboard/row can re-read. */
const DASHBOARD_TABLES: ReadonlySet<string> = new Set(["calls", "reports", "bank_accounts", "settings"] satisfies ChangeSignal["table"][]);

/**
 * Whether a change signal is for a table the dashboard shows. Others (voice_twins, which signals on every speech_seconds
 * update) are for /protect only: re-reading them here would just 400.
 */
export function isDashboardSignal(signal: Pick<ChangeSignal, "table">): boolean {
  return DASHBOARD_TABLES.has(signal.table);
}

function sortCalls(calls: CallRow[]): CallRow[] {
  return [...calls].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

/** Wall clock for live durations. Starts at 0 so the prerendered shell is deterministic (Cache Components). */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [intervalMs]);
  return now;
}

export function Dashboard({
  phoneNumber,
  customerFirstName,
  riskThreshold,
}: {
  phoneNumber: string;
  customerFirstName: string;
  riskThreshold: number;
}) {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [reportsByCall, setReportsByCall] = useState<Record<string, ReportRow>>({});
  const [accounts, setAccounts] = useState<Record<string, BankAccountRow>>({});
  const [autoSend, setAutoSendState] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [analystName, setAnalystName] = useState("");
  const now = useNow(1000);
  const selectedRef = useRef<string | null>(null);
  const callsRef = useRef<CallRow[]>([]);
  const reportsRef = useRef<Record<string, ReportRow>>({});
  useEffect(() => {
    selectedRef.current = selectedId;
    callsRef.current = calls;
    reportsRef.current = reportsByCall;
  }, [selectedId, calls, reportsByCall]);

  /** Keep the newer copy of a row: re-reads can finish out of order. */
  const upsertCall = useCallback((row: CallRow) => {
    setCalls((prev) => {
      const existing = prev.find((c) => c.id === row.id);
      if (existing && Date.parse(existing.updated_at) > Date.parse(row.updated_at)) return prev;
      return sortCalls([row, ...prev.filter((c) => c.id !== row.id)]).slice(0, 100);
    });
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const data = await getJson<{ calls: CallRow[]; reports: ReportRow[]; accounts: BankAccountRow[]; settings: SettingsRow | null }>(
        "/api/dashboard/state",
      );
      const loadedCalls = sortCalls(data.calls ?? []);
      setCalls(loadedCalls);
      setReportsByCall(Object.fromEntries((data.reports ?? []).map((x) => [x.call_id, x])));
      setAccounts(Object.fromEntries((data.accounts ?? []).map((x) => [x.id, x])));
      if (data.settings) setAutoSendState(Boolean(data.settings.auto_send));
      setSelectedId((current) => current ?? loadedCalls.find((x) => x.status === "live")?.id ?? loadedCalls[0]?.id ?? null);
    } catch (error) {
      toast.error(`Could not load data: ${(error as Error).message}`);
    }
  }, []);

  /** Re-read one changed row through the authenticated API (signals carry no data), coalescing bursts per row. */
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const refetch = useCallback(
    (signal: ChangeSignal) => {
      if (!isDashboardSignal(signal)) return;
      const key = `${signal.table}:${signal.id}`;
      const timer = pending.current.get(key);
      if (timer) clearTimeout(timer);
      pending.current.set(
        key,
        setTimeout(async () => {
          pending.current.delete(key);
          let row: unknown = null;
          try {
            row = (await getJson<{ row: unknown }>(`/api/dashboard/row?table=${signal.table}&id=${encodeURIComponent(signal.id)}`)).row;
          } catch (error) {
            if ((error as Error).message !== "Not found.") return;
          }
          if (signal.table === "calls") {
            if (!row) {
              setCalls((prev) => prev.filter((c) => c.id !== signal.id));
              return;
            }
            const next = row as CallRow;
            const existing = callsRef.current.find((c) => c.id === next.id);
            upsertCall(next);
            if (!existing && next.status === "live") {
              // Jump to a new live call unless the analyst is already watching another live call.
              const watching = callsRef.current.find((c) => c.id === selectedRef.current);
              if (!watching || watching.status !== "live") setSelectedId(next.id);
              toast.message(`Incoming call ${next.caller_masked ?? ""} · screening`.trim());
            }
            if (existing?.handoff_status !== "offered" && next.handoff_status === "offered" && next.status === "live") {
              toast.error(`Scam alert on ${next.caller_masked ?? "a live call"}: the customer has been offered a handover`);
            }
            if (existing && existing.handoff_status !== "connected" && next.handoff_status === "connected") {
              const who = takeoverLabel(next);
              toast.success(`Northgate took over ${next.caller_masked ?? "the call"}${who ? ` · ${who}` : ""}`);
            }
          } else if (signal.table === "reports") {
            if (!row) {
              setReportsByCall((prev) => Object.fromEntries(Object.entries(prev).filter(([, r]) => r.id !== signal.id)));
              return;
            }
            const next = row as ReportRow;
            const before = reportsRef.current[next.call_id];
            if (before?.status === "draft" && next.status === "sent") {
              toast.success(next.approved_by ? `Report sent (approved by ${next.approved_by})` : "Report auto-sent to the fraud team");
            }
            setReportsByCall((prev) => ({ ...prev, [next.call_id]: next }));
          } else if (signal.table === "bank_accounts" && row) {
            const next = row as BankAccountRow;
            setAccounts((prev) => ({ ...prev, [next.id]: next }));
          } else if (signal.table === "settings" && row) {
            setAutoSendState(Boolean((row as SettingsRow).auto_send));
          }
        }, 150),
      );
    },
    [upsertCall],
  );

  // Realtime: content-free change signals; load everything after (re)subscribing so nothing is missed.
  useChangeSignals({ onSignal: refetch, onSubscribed: () => void loadAll(), onConnection: setConnection });

  const selected = useMemo(() => calls.find((c) => c.id === selectedId) ?? null, [calls, selectedId]);
  const report = selected ? (reportsByCall[selected.id] ?? null) : null;

  const handleToggleAutoSend = async (value: boolean) => {
    const previous = autoSend;
    setAutoSendState(value);
    try {
      const res = await postJson<{ autoSend: boolean }>("/api/settings/auto-send", { autoSend: value });
      setAutoSendState(res.autoSend);
      toast.success(res.autoSend ? "Auto-send on: reports email as soon as a call ends" : "Auto-send off: reports wait for analyst approval");
    } catch (error) {
      setAutoSendState(previous);
      toast.error((error as Error).message);
    }
  };

  const handleTakeover = async (callId: string, approvedBy: string) => {
    // Analysts always hand over to the AI voice, matched automatically; the AI Voice Twin is the customer's own choice.
    const res = await postJson<{ call: CallRow; aiVoiceLabel?: string | null; takeover?: TakeoverKind }>(`/api/calls/${callId}/takeover`, {
      approvedBy,
    });
    if (res.call) upsertCall(res.call);
    const kind = res.takeover ?? res.call?.takeover_kind ?? null;
    const who = kind === "voice_twin" ? `the ${VOICE_TWIN_LABEL}` : res.aiVoiceLabel || (res.call && takeoverLabel(res.call)) || "the AI voice";
    toast.success(`Taken over · ${who} is on the line`);
  };

  const handleFreeze = async (accountId: string) => {
    const res = await postJson<{ account: BankAccountRow }>(`/api/accounts/${accountId}/freeze`, {});
    setAccounts((prev) => ({ ...prev, [res.account.id]: res.account }));
    toast.success(`Account ${res.account.sort_code} ${res.account.account_number} frozen`);
  };

  const handleApprove = async (reportId: string, approvedBy: string) => {
    const res = await postJson<{ report: ReportRow }>(`/api/reports/${reportId}/send`, { approvedBy });
    setReportsByCall((prev) => ({ ...prev, [res.report.call_id]: res.report }));
  };

  return (
    <div className="ops-grid-bg flex min-h-screen flex-col bg-background text-foreground lg:h-dvh lg:min-h-0 lg:overflow-hidden">
      <Toaster theme="dark" richColors position="bottom-right" />
      <DashboardHeader
        phoneNumber={phoneNumber}
        customerFirstName={customerFirstName}
        autoSend={autoSend}
        connection={connection}
        onToggleAutoSend={handleToggleAutoSend}
      />
      <main className="grid flex-1 gap-3 p-3 lg:min-h-0 lg:grid-cols-[18rem_minmax(0,1fr)_24rem] lg:grid-rows-[minmax(0,1fr)_auto]">
        <CallList calls={calls} selectedId={selectedId} onSelect={setSelectedId} now={now} reportsByCall={reportsByCall} />
        <TranscriptView call={selected} now={now} customerFirstName={customerFirstName} />
        <div className="flex min-h-0 flex-col gap-3">
          <RiskPanel
            key={selected?.id ?? "none"}
            call={selected}
            riskThreshold={riskThreshold}
            analystName={analystName}
            onAnalystNameChange={setAnalystName}
            onTakeover={handleTakeover}
          />
          <IntelPanel call={selected} accounts={accounts} onFreeze={handleFreeze} />
        </div>
        <div className="lg:col-span-3 lg:max-h-[36vh] lg:overflow-y-auto lg:rounded-xl">
          <ReportPanel call={selected} report={report} autoSend={autoSend} now={now} riskThreshold={riskThreshold} onApprove={handleApprove} />
        </div>
      </main>
    </div>
  );
}
