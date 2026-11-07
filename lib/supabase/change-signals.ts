"use client";

import { useEffect, useRef } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

/** A content-free change signal from the database (see 0008: broadcast_row_change): table, row id, operation. */
export interface ChangeSignal {
  table: "calls" | "reports" | "bank_accounts" | "settings" | "voice_twins";
  id: string;
  op: "INSERT" | "UPDATE" | "DELETE";
}

export type SignalConnection = "connecting" | "live" | "offline";

/**
 * Subscribe to the "northgate-ops" Realtime Broadcast topic. Signals carry no row data: the page re-reads what it
 * needs through its own authenticated API route. `onSubscribed` fires on every (re)subscribe so nothing is missed.
 */
export function useChangeSignals(handlers: {
  onSignal: (signal: ChangeSignal) => void;
  onSubscribed: () => void;
  onConnection: (state: SignalConnection) => void;
}) {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    const db = supabaseBrowser();
    const channel = db
      .channel("northgate-ops", { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "changed" }, (message) => {
        const p = message.payload as Partial<ChangeSignal> | undefined;
        if (p && typeof p.table === "string" && typeof p.id === "string") ref.current.onSignal(p as ChangeSignal);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          ref.current.onConnection("live");
          ref.current.onSubscribed();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          ref.current.onConnection("offline");
        }
      });
    return () => {
      void db.removeChannel(channel);
    };
  }, []);
}
