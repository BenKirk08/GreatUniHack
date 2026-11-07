-- Let mid-call snapshots record call direction on insert (outbound rows created by /api/calls/outbound keep theirs).
drop function if exists public.upsert_call_snapshot(text, text, jsonb, jsonb);

create or replace function public.upsert_call_snapshot(
  p_conversation_id text,
  p_caller_masked   text,
  p_transcript      jsonb,
  p_notes           jsonb,
  p_direction       text default 'inbound'
) returns setof public.calls
language sql volatile security invoker set search_path = public as $$
  insert into public.calls as c (conversation_id, caller_masked, direction, transcript, agent_notes)
  values (
    p_conversation_id,
    p_caller_masked,
    case when p_direction in ('inbound', 'outbound') then p_direction else 'inbound' end,
    coalesce(p_transcript, '[]'::jsonb),
    coalesce(p_notes, '{}'::jsonb)
  )
  on conflict (conversation_id) do update set
    caller_masked = coalesce(c.caller_masked, excluded.caller_masked),
    transcript    = case
                      when jsonb_array_length(excluded.transcript) >= jsonb_array_length(c.transcript)
                      then excluded.transcript else c.transcript
                    end,
    agent_notes   = c.agent_notes || excluded.agent_notes
  returning c.*;
$$;

revoke execute on function public.upsert_call_snapshot(text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.upsert_call_snapshot(text, text, jsonb, jsonb, text) to service_role;

-- Explicit grants: newer Supabase projects no longer auto-grant public tables to service_role.
grant select, insert, update, delete on public.calls, public.reports, public.bank_accounts, public.settings to service_role;
