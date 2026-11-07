-- Northgate Call Guard: every call to the Twilio number rings through to the customer while it is screened live.
-- The call row is created by the Twilio voice webhook (keyed by twilio_call_sid). An ElevenLabs conversation only
-- exists once Northgate takes the call over, so conversation_id becomes nullable (still unique).

alter table public.calls alter column conversation_id drop not null;

alter table public.calls add column if not exists twilio_call_sid      text unique;
-- [{speaker: 'caller' | 'customer', text, at, seq}], kept sorted by time (Twilio only orders within a track)
alter table public.calls add column if not exists screening_transcript jsonb not null default '[]'::jsonb;
-- {score, peak, scam_type, tactics, reason, segments_scored, scored_at, threshold_crossed_at, threshold_crossed_score}
alter table public.calls add column if not exists risk                 jsonb;
alter table public.calls add column if not exists handoff_status       text not null default 'none';
alter table public.calls add column if not exists handoff_by           text;          -- 'customer' or 'analyst:<name>'
alter table public.calls add column if not exists handoff_at           timestamptz;
alter table public.calls add column if not exists handoff_error        text;
alter table public.calls add column if not exists persona              text;
-- Bookkeeping for the offer/decline rules and the live-intel throttle.
alter table public.calls add column if not exists offered_at           timestamptz;
alter table public.calls add column if not exists declined_score       integer;      -- risk score when the customer said "I know this caller"
alter table public.calls add column if not exists intel_claimed_at     timestamptz;  -- live processIntel runs at most every 20 s

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'calls_handoff_status_check') then
    alter table public.calls add constraint calls_handoff_status_check
      check (handoff_status in ('none', 'offered', 'declined', 'requested', 'connected', 'failed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calls_handoff_by_check') then
    alter table public.calls add constraint calls_handoff_by_check
      check (handoff_by is null or handoff_by = 'customer' or handoff_by like 'analyst:_%');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calls_persona_check') then
    alter table public.calls add constraint calls_persona_check
      check (persona is null or persona in ('margaret', 'derek', 'priya', 'keith'));
  end if;
end;
$$;

-- The persona transcript (calls.transcript) now comes from one of four personas: rename the old 'margaret' role.
update public.calls c
set transcript = (
  select coalesce(jsonb_agg(case when e->>'role' = 'margaret' then jsonb_set(e, '{role}', '"agent"') else e end order by ord), '[]'::jsonb)
  from jsonb_array_elements(c.transcript) with ordinality as t(e, ord)
)
where c.transcript @> '[{"role": "margaret"}]';

/* ---------- push subscriptions (the customer's /protect devices) ---------- */

create table if not exists public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  endpoint        text not null unique,
  keys            jsonb not null,               -- {p256dh, auth}
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_success_at timestamptz
);

-- No anon/authenticated access at all: RLS on with no policies, and no grants. Only the service role touches it.
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to service_role;

/* ---------- screening: append one final transcription segment atomically ---------- */

-- Appends the segment, keeps the list sorted by time, and ignores Twilio retries (same speaker + sequence id).
-- Segments that arrive once a takeover is under way are dropped (that audio is the persona, not the customer).
-- Returns the updated row, or nothing when the segment was ignored.
create or replace function public.append_screening_segment(p_call_sid text, p_segment jsonb)
returns setof public.calls
language sql volatile security invoker set search_path = public as $$
  update public.calls c
  set screening_transcript = (
    select coalesce(jsonb_agg(e order by (e->>'at')::timestamptz, coalesce((e->>'seq')::bigint, 0)), '[]'::jsonb)
    from jsonb_array_elements(c.screening_transcript || jsonb_build_array(p_segment)) e
  )
  where c.twilio_call_sid = p_call_sid
    and c.handoff_status not in ('requested', 'connected')
    and not exists (
      select 1 from jsonb_array_elements(c.screening_transcript) x
      where x->>'speaker' = p_segment->>'speaker' and x->>'seq' = p_segment->>'seq'
    )
  returning c.*;
$$;

/* ---------- screening: save a risk score, keep the peak, and offer the takeover ---------- */

-- Stale-write guard: skipped when the stored segments_scored is higher (a slower scorer finished after a newer one).
-- The peak only ever rises. The first time the peak reaches the threshold on a live call whose handoff_status is
-- 'none', the status becomes 'offered' (exactly one caller sees offered = true, so the push is sent once).
-- After a decline, the call is offered again only when the score is 15+ points above the score at decline.
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
    elsif c.handoff_status = 'declined' and v_score >= coalesce(c.declined_score, 0) + 15 then
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

/* ---------- the customer says "I know this caller" ---------- */

create or replace function public.decline_offer(p_call_id uuid)
returns setof public.calls
language sql volatile security invoker set search_path = public as $$
  update public.calls
  set handoff_status = 'declined',
      declined_score = coalesce((risk->>'score')::integer, 0)
  where id = p_call_id and handoff_status = 'offered'
  returning *;
$$;

/* ---------- takeover: link the persona's ElevenLabs conversation to the call ---------- */

-- Called by record_details (mid-call) and the post-call webhook, both of which carry northgate_call_id (= calls.id).
-- conversation_id is set once; the persona transcript is only replaced by one at least as long; notes are merged.
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
  returning c.*;
$$;

revoke execute on function public.append_screening_segment(text, jsonb) from public, anon, authenticated;
revoke execute on function public.record_risk_score(uuid, jsonb, integer) from public, anon, authenticated;
revoke execute on function public.decline_offer(uuid) from public, anon, authenticated;
revoke execute on function public.link_persona_snapshot(uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.append_screening_segment(text, jsonb) to service_role;
grant execute on function public.record_risk_score(uuid, jsonb, integer) to service_role;
grant execute on function public.decline_offer(uuid) to service_role;
grant execute on function public.link_persona_snapshot(uuid, text, jsonb, jsonb) to service_role;

create index if not exists calls_live_idx on public.calls (status, started_at desc);
