"use client";

import { ShieldCheck } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatPhoneDisplay } from "@/lib/format";

function Wordmark() {
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 40 40" className="size-9 shrink-0" aria-hidden>
        <rect x="1" y="1" width="38" height="38" rx="9" className="fill-primary/15 stroke-primary/60" strokeWidth="1.5" />
        <path d="M10 30V16l10-6 10 6v14" className="fill-none stroke-primary" strokeWidth="2.4" strokeLinejoin="round" />
        <path d="M15 30V20h10v10M20 20v10" className="fill-none stroke-primary" strokeWidth="2" />
      </svg>
      <div className="leading-tight">
        <div className="text-lg font-bold tracking-[0.22em]">NORTHGATE</div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Bank · Fraud Operations</div>
      </div>
    </div>
  );
}

export function DashboardHeader(props: {
  phoneNumber: string;
  customerFirstName: string;
  autoSend: boolean | null;
  connection: "connecting" | "live" | "offline";
  onToggleAutoSend: (value: boolean) => void;
}) {
  return (
    <header className="border-b border-border bg-card/70 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3">
        <Wordmark />

        <div className="flex items-center gap-3">
          <ShieldCheck className="size-5 text-primary" aria-hidden />
          <div className="leading-tight">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Call Guard · protected line{props.customerFirstName ? ` · rings ${props.customerFirstName}` : ""}
            </div>
            <div className="font-mono text-2xl font-semibold tabular-nums tracking-wide text-primary">
              {props.phoneNumber ? formatPhoneDisplay(props.phoneNumber) : "—"}
            </div>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-2 text-xs text-muted-foreground" title="Supabase Realtime connection">
            <span
              className={`size-2 rounded-full ${
                props.connection === "live" ? "bg-emerald-400" : props.connection === "connecting" ? "bg-amber-400" : "bg-destructive"
              }`}
            />
            {props.connection === "live" ? "Realtime" : props.connection === "connecting" ? "Connecting…" : "Offline"}
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="auto-send"
              checked={props.autoSend ?? false}
              disabled={props.autoSend === null}
              onCheckedChange={props.onToggleAutoSend}
            />
            <Label htmlFor="auto-send" className="cursor-pointer">
              <span className="font-medium">Auto-send</span>
              <span className="ml-1 text-xs text-muted-foreground">
                {props.autoSend === null ? "" : props.autoSend ? "reports email on hang-up" : "analyst approval"}
              </span>
            </Label>
          </div>
        </div>
      </div>
    </header>
  );
}
