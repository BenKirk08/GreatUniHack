-- Call Guard hardening (from the adversarial review).
--
-- 1. No browser reads of the data tables. The anon key ships in the client bundles (dashboard and /protect), so
--    "select to anon using (true)" made every call transcript, report and the bank's account table readable by anyone
--    holding it. The dashboard (basic auth) and /protect (customer cookie) now read through authenticated server
--    routes using the service role, and Realtime only carries content-free change signals (table + row id).

drop policy if exists "dashboard read calls" on public.calls;
drop policy if exists "dashboard read reports" on public.reports;
drop policy if exists "dashboard read bank_accounts" on public.bank_accounts;
drop policy if exists "dashboard read settings" on public.settings;
revoke all on public.calls, public.reports, public.bank_accounts, public.settings from anon, authenticated;

-- postgres_changes streamed whole rows; stop publishing these tables.
do $$
declare
  t text;
begin
  foreach t in array array['calls', 'reports', 'bank_accounts', 'settings'] loop
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end;
$$;

-- Change signals over Realtime Broadcast (public topic "northgate-ops"): {table, id, op} only, never row data.
-- A failure to broadcast must never fail the write.
create or replace function public.broadcast_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_id text := case when tg_op = 'DELETE' then to_jsonb(old)->>'id' else to_jsonb(new)->>'id' end;
begin
  begin
    perform realtime.send(
      jsonb_build_object('table', tg_table_name, 'id', v_id, 'op', tg_op),
      'changed',
      'northgate-ops',
      false
    );
  exception when others then
    raise warning 'broadcast_row_change failed: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke execute on function public.broadcast_row_change() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['calls', 'reports', 'bank_accounts', 'settings'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_broadcast_change', t);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.broadcast_row_change()',
      t || '_broadcast_change', t);
  end loop;
end;
$$;

-- 2. Takeover claims carry their own timestamp, so a claim whose serverless function died (left 'requested')
--    can be retried once it is clearly stale (the takeover routes allow 30 s).
alter table public.calls add column if not exists handoff_requested_at timestamptz;

-- 3. Re-offer after a decline only when the score is 15+ above the score at decline AND at or above the threshold.
create or replace function public.record_risk_score(p_call_id uuid, p_risk jsonb, p_threshold integer)
returns jsonb
language plpgsql volatile security invoker set search_path = public as $$
declare
  c          public.calls%rowtype;
  v_score    integer := (p_risk->>'score')::integer;
  v_segments integer := (p_risk->>'segments_scored')::integer;
  v_peak     integer;
  v_offer    boolean := false;
  v_risk     jsonb;
begin
  select * into c from public.calls where id = p_call_id for update;
  if not found then
    return jsonb_build_object('saved', false, 'reason', 'missing');
  end if;
  if coalesce((c.risk->>'segments_scored')::integer, -1) > v_segments then
    return jsonb_build_object('saved', false, 'reason', 'stale', 'peak', (c.risk->>'peak')::integer);
  end if;

  v_peak := greatest(coalesce((c.risk->>'peak')::integer, 0), v_score);
  v_risk := p_risk || jsonb_build_object('peak', v_peak);
  if c.risk ? 'threshold_crossed_at' then
    v_risk := v_risk || jsonb_build_object(
      'threshold_crossed_at', c.risk->'threshold_crossed_at',
      'threshold_crossed_score', c.risk->'threshold_crossed_score');
  elsif v_peak >= p_threshold then
    v_risk := v_risk || jsonb_build_object('threshold_crossed_at', to_jsonb(now()), 'threshold_crossed_score', v_peak);
  end if;

  if c.status = 'live' and v_peak >= p_threshold then
    if c.handoff_status = 'none' then
      v_offer := true;
    elsif c.handoff_status = 'declined' and v_score >= greatest(p_threshold, coalesce(c.declined_score, 0) + 15) then
      v_offer := true;
    end if;
  end if;

  update public.calls
  set risk           = v_risk,
      handoff_status = case when v_offer then 'offered' else handoff_status end,
      offered_at     = case when v_offer then now() else offered_at end
  where id = p_call_id;

  return jsonb_build_object(
    'saved', true,
    'offered', v_offer,
    'peak', v_peak,
    'handoff_status', case when v_offer then 'offered' else c.handoff_status end);
end;
$$;

-- 4. Only calls that were actually handed over can be linked to a persona conversation, so a stray conversation
--    carrying some other call's id can't attach a transcript or notes to it.
create or replace function public.link_persona_snapshot(
  p_call_id         uuid,
  p_conversation_id text,
  p_transcript      jsonb,
  p_notes           jsonb
) returns setof public.calls
language sql volatile security invoker set search_path = public as $$
  update public.calls c
  set conversation_id = coalesce(c.conversation_id, p_conversation_id),
      transcript      = case
                          when jsonb_array_length(coalesce(p_transcript, '[]'::jsonb)) >= jsonb_array_length(c.transcript)
                          then coalesce(p_transcript, '[]'::jsonb) else c.transcript
                        end,
      agent_notes     = c.agent_notes || coalesce(p_notes, '{}'::jsonb)
  where c.id = p_call_id
    and c.handoff_status in ('requested', 'connected', 'failed')
  returning c.*;
$$;

revoke execute on function public.record_risk_score(uuid, jsonb, integer) from public, anon, authenticated;
revoke execute on function public.link_persona_snapshot(uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.record_risk_score(uuid, jsonb, integer) to service_role;
grant execute on function public.link_persona_snapshot(uuid, text, jsonb, jsonb) to service_role;
