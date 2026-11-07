-- Mid-call snapshots can carry the real call start (now - system__call_duration_secs), so the live duration
-- on the dashboard counts from when the call began rather than from Margaret's first record_details call.
drop function if exists public.upsert_call_snapshot(text, text, jsonb, jsonb, text);

create or replace function public.upsert_call_snapshot(
  p_conversation_id text,
  p_caller_masked   text,
  p_transcript      jsonb,
  p_notes           jsonb,
  p_direction       text default 'inbound',
  p_started_at      timestamptz default null
) returns setof public.calls
language sql volatile security invoker set search_path = public as $$
  insert into public.calls as c (conversation_id, caller_masked, direction, transcript, agent_notes, started_at)
  values (
    p_conversation_id,
    p_caller_masked,
    case when p_direction in ('inbound', 'outbound') then p_direction else 'inbound' end,
    coalesce(p_transcript, '[]'::jsonb),
    coalesce(p_notes, '{}'::jsonb),
    coalesce(p_started_at, now())
  )
  on conflict (conversation_id) do update set
    caller_masked = coalesce(c.caller_masked, excluded.caller_masked),
    transcript    = case
                      when jsonb_array_length(excluded.transcript) >= jsonb_array_length(c.transcript)
                      then excluded.transcript else c.transcript
                    end,
    agent_notes   = c.agent_notes || excluded.agent_notes,
    started_at    = case when p_started_at is not null then least(c.started_at, p_started_at) else c.started_at end
  returning c.*;
$$;

revoke execute on function public.upsert_call_snapshot(text, text, jsonb, jsonb, text, timestamptz) from public, anon, authenticated;
grant execute on function public.upsert_call_snapshot(text, text, jsonb, jsonb, text, timestamptz) to service_role;
