-- Margaret's record_details notes, merged across the call (latest value per field wins).
alter table public.calls add column if not exists agent_notes jsonb not null default '{}'::jsonb;

-- Atomic upsert for mid-call snapshots from the record_details tool.
-- Tool calls can arrive close together and background work can finish out of order, so:
--   * the transcript is only replaced by one that is at least as long
--   * agent notes are merged, never overwritten wholesale
--   * caller_masked / direction set by the outbound route are kept
--   * status is never touched (a late snapshot can't re-open an ended call)
create or replace function public.upsert_call_snapshot(
  p_conversation_id text,
  p_caller_masked   text,
  p_transcript      jsonb,
  p_notes           jsonb
) returns setof public.calls
language sql volatile security invoker set search_path = public as $$
  insert into public.calls as c (conversation_id, caller_masked, transcript, agent_notes)
  values (p_conversation_id, p_caller_masked, coalesce(p_transcript, '[]'::jsonb), coalesce(p_notes, '{}'::jsonb))
  on conflict (conversation_id) do update set
    caller_masked = coalesce(c.caller_masked, excluded.caller_masked),
    transcript    = case
                      when jsonb_array_length(excluded.transcript) >= jsonb_array_length(c.transcript)
                      then excluded.transcript else c.transcript
                    end,
    agent_notes   = c.agent_notes || excluded.agent_notes
  returning c.*;
$$;

revoke execute on function public.upsert_call_snapshot(text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_call_snapshot(text, text, jsonb, jsonb) to service_role;
