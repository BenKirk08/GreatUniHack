"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";

let client: SupabaseClient | undefined;

/**
 * Anon-key client used only for Realtime Broadcast change signals. The anon role can't read any table (0008):
 * pages load their data through authenticated API routes.
 */
export function supabaseBrowser(): SupabaseClient {
  if (client) return client;
  const env = publicEnv();
  client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
