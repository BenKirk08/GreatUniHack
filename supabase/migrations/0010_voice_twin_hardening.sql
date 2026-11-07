-- AI Voice Twin hardening (from the adversarial review of 0009).
--
-- 1. Only the account holder's own voice: a call's audio is eligible for cloning only when the call was flagged AND
--    the screening transcript shows the customer really talking. Voicemail, carrier announcements and phone call-
--    screening assistants (Siri, Google) answering the customer's leg would otherwise be cloned as the customer.
--    Audio from a call that ends ineligible is discarded, like an unflagged call's.
-- 2. The 24 h deletion can't be deferred forever: a twin call only defers expiry for an hour after its handover, and
--    only if it started after the current voice was made. A call row stuck at 'live' (lost post-call webhook) no longer
--    blocks deletion, and a 'live' call older than 6 hours counts as ended when deciding what audio to keep.
-- 3. Claim token: voice_twin_claim_clone returns the claim's cloning_started_at so finish/fail only apply to the run
--    that made that claim (a superseded run can't complete a newer claim, e.g. after revoke + re-consent).
-- 4. Media bridge heartbeats use the database clock (a laptop clock that is off by minutes no longer matters).
-- 5. voice_twin_retire_voice: expire a twin's voice now (e.g. ElevenLabs says it no longer exists).

/* ---------- 1. the customer really spoke on this call ---------- */

-- At least one customer segment of 3+ words, and no customer segment that sounds like voicemail or a screening assistant.
create or replace function public.call_has_customer_speech(c public.calls) returns boolean
language sql stable set search_path = public as $$
  select exists (
      select 1 from jsonb_array_elements(coalesce(c.screening_transcript, '[]'::jsonb)) s
      where s->>'speaker' = 'customer'
        and coalesce(array_length(regexp_split_to_array(btrim(coalesce(s->>'text', '')), '\s+'), 1), 0) >= 3
    )
    and not exists (
      select 1 from jsonb_array_elements(coalesce(c.screening_transcript, '[]'::jsonb)) s
      where s->>'speaker' = 'customer'
        and coalesce(s->>'text', '') ~* '(leave (a|your) (message|name)|after the (tone|beep)|not available|unavailable|voice ?mail|mailbox|person you (are|have|were) (calling|called|trying)|record your (name|message)|(say|state) your name|who''?s calling|reason for (calling|your call)|screening (service|assistant)|is using a screening|number you have dialled|can(not|''?t) (take|answer) (your|the) call|can''?t come to the phone)'
    );
$$;

-- Call audio is usable for the twin: flagged, and the customer really spoke.
create or replace function public.call_audio_eligible(c public.calls) returns boolean
language sql stable set search_path = public as $$
  select public.call_is_flagged(c) and public.call_has_customer_speech(c);
$$;

-- A call counts as over for audio decisions once ended, or 'live' for more than 6 hours (its end was never recorded).
create or replace function public.call_is_over(c public.calls) returns boolean
language sql stable set search_path = public as $$
  select c.status = 'ended' or c.started_at < now() - interval '6 hours';
$$;

create or replace function public.voice_twin_add_audio(
  p_twin_id     uuid,
  p_source      text,
  p_call_id     uuid,
  p_session_id  text,
  p_seq         integer,
  p_path        text,
  p_mime        text,
  p_sample_rate integer,
  p_seconds     double precision,
  p_bytes       integer
) returns jsonb
language plpgsql volatile security invoker set search_path = public as $$
declare
  t          public.voice_twins%rowtype;
  c          public.calls%rowtype;
  v_inserted uuid;
  v_total    double precision;
begin
  select * into t from public.voice_twins where id = p_twin_id for update;
  if not found then
    return jsonb_build_object('accepted', false, 'reason', 'missing');
  end if;
  if not t.voice_twin_consent then
    return jsonb_build_object('accepted', false, 'reason', 'no_consent');
  end if;
  if t.state not in ('collecting', 'failed') then
    return jsonb_build_object('accepted', false, 'reason', 'not_collecting', 'state', t.state);
  end if;
  if p_source = 'call' then
    if p_call_id is null then
      return jsonb_build_object('accepted', false, 'reason', 'missing_call');
    end if;
    select * into c from public.calls where id = p_call_id;
    if not found then
      return jsonb_build_object('accepted', false, 'reason', 'missing_call');
    end if;
    if public.call_is_over(c) and not public.call_audio_eligible(c) then
      return jsonb_build_object('accepted', false, 'reason', 'call_not_flagged');
    end if;
  end if;

  insert into public.voice_twin_audio (twin_id, source, call_id, session_id, seq, storage_path, mime_type, sample_rate, speech_seconds, bytes)
  values (p_twin_id, p_source, case when p_source = 'call' then p_call_id end, p_session_id, p_seq, p_path, p_mime, p_sample_rate,
          greatest(coalesce(p_seconds, 0), 0), greatest(coalesce(p_bytes, 0), 0))
  on conflict do nothing
  returning id into v_inserted;

  if v_inserted is null then
    return jsonb_build_object('accepted', true, 'duplicate', true, 'speech_seconds', t.speech_seconds, 'state', t.state);
  end if;
  update public.voice_twins
  set speech_seconds = speech_seconds + greatest(coalesce(p_seconds, 0), 0), last_audio_at = now(), updated_at = now()
  where id = p_twin_id
  returning speech_seconds into v_total;
  return jsonb_build_object('accepted', true, 'duplicate', false, 'speech_seconds', v_total, 'state', t.state);
end;
$$;

/* ---------- 1 + 3. claim: eligible audio only, and a claim token ---------- */

create or replace function public.voice_twin_claim_clone(
  p_twin_id       uuid,
  p_min_seconds   double precision,
  p_stale_seconds integer,
  p_allow_failed  boolean
) returns jsonb
language plpgsql volatile security invoker set search_path = public as $$
declare
  t            public.voice_twins%rowtype;
  v_eligible   double precision;
  v_audio      jsonb;
  v_claimed_at timestamptz;
begin
  select * into t from public.voice_twins where id = p_twin_id for update;
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'missing');
  end if;
  if not t.voice_twin_consent then
    return jsonb_build_object('claimed', false, 'reason', 'no_consent');
  end if;
  if not (
    t.state = 'collecting'
    or (t.state = 'failed' and p_allow_failed)
    or (t.state = 'cloning' and t.cloning_started_at < now() - make_interval(secs => p_stale_seconds))
  ) then
    return jsonb_build_object('claimed', false, 'reason', case when t.state = 'cloning' then 'busy' else 'not_collecting' end, 'state', t.state);
  end if;

  select coalesce(sum(a.speech_seconds), 0), coalesce(jsonb_agg(to_jsonb(a) order by a.created_at, a.session_id, a.seq), '[]'::jsonb)
  into v_eligible, v_audio
  from public.voice_twin_audio a
  left join public.calls c on c.id = a.call_id
  where a.twin_id = p_twin_id
    and (a.source = 'sample' or (c.id is not null and public.call_audio_eligible(c)));

  if v_eligible < p_min_seconds then
    return jsonb_build_object('claimed', false, 'reason', 'not_enough_audio', 'eligible_seconds', v_eligible);
  end if;

  -- clock_timestamp(), not now(): a re-claim inside the same transaction must still get a new token.
  v_claimed_at := clock_timestamp();
  update public.voice_twins
  set state = 'cloning', cloning_started_at = v_claimed_at, clone_error = null, updated_at = now()
  where id = p_twin_id;
  return jsonb_build_object('claimed', true, 'eligible_seconds', v_eligible, 'audio', v_audio, 'claimed_at', v_claimed_at);
end;
$$;

/* ---------- 2. bounded expiry deferral; stale live calls don't keep audio ---------- */

create or replace function public.voice_twin_expire(p_twin_id uuid)
returns jsonb
language plpgsql volatile security invoker set search_path = public as $$
declare
  t       public.voice_twins%rowtype;
  v_paths jsonb;
begin
  select * into t from public.voice_twins where id = p_twin_id for update;
  if not found or t.state <> 'ready' or t.voice_expires_at > now() then
    return jsonb_build_object('expired', false, 'reason', 'not_due', 'paths', '[]'::jsonb);
  end if;
  -- Don't pull the voice from under a call that is using it right now, but never for long: only a twin handover made
  -- in the last hour, on this voice (after it was created), defers the deletion.
  if exists (
    select 1 from public.calls
    where status = 'live'
      and takeover_kind = 'voice_twin'
      and handoff_status in ('requested', 'connected')
      and coalesce(handoff_at, handoff_requested_at) > greatest(now() - interval '1 hour', coalesce(t.voice_created_at, now() - interval '1 hour'))
  ) then
    return jsonb_build_object('expired', false, 'reason', 'in_use', 'paths', '[]'::jsonb);
  end if;
  if t.voice_source = 'clone' then
    insert into public.voice_twin_voice_deletions (voice_id, twin_id, reason) values (t.voice_id, t.id, 'expired')
    on conflict (voice_id) do nothing;
  end if;
  select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into v_paths from public.voice_twin_audio where twin_id = p_twin_id;
  delete from public.voice_twin_audio where twin_id = p_twin_id;
  update public.voice_twins
  set state = 'collecting', speech_seconds = 0, voice_id = null, voice_source = null, voice_created_at = null,
      voice_expires_at = null, clone_speech_seconds = null, clone_error = null, cloning_started_at = null, updated_at = now()
  where id = p_twin_id;
  return jsonb_build_object('expired', true, 'previous', to_jsonb(t), 'paths', v_paths);
end;
$$;

-- Discard the audio of a call that is over and not eligible (unflagged, or the customer never really spoke), or whose
-- call row is gone; its seconds come off the twin's total. Returns the Storage paths to delete.
create or replace function public.voice_twin_discard_unflagged_call_audio(p_call_id uuid)
returns jsonb
language plpgsql volatile security invoker set search_path = public as $$
declare
  c       public.calls%rowtype;
  v_paths jsonb;
begin
  select * into c from public.calls where id = p_call_id;
  if found and not public.call_is_over(c) then
    return jsonb_build_object('discarded', false, 'reason', 'live', 'paths', '[]'::jsonb);
  end if;
  if found and public.call_audio_eligible(c) then
    return jsonb_build_object('discarded', false, 'reason', 'flagged', 'paths', '[]'::jsonb);
  end if;
  with gone as (
    delete from public.voice_twin_audio where call_id = p_call_id returning twin_id, storage_path, speech_seconds
  ), per_twin as (
    select twin_id, sum(speech_seconds) as s from gone group by twin_id
  ), upd as (
    update public.voice_twins t
    set speech_seconds = greatest(0, t.speech_seconds - p.s), updated_at = now()
    from per_twin p
    where t.id = p.twin_id
    returning t.id
  )
  select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into v_paths from gone;
  return jsonb_build_object('discarded', true, 'paths', v_paths);
end;
$$;

/* ---------- 4. media bridge heartbeat on the database clock ---------- */

create or replace function public.media_bridge_heartbeat(p_id text, p_url text) returns void
language sql volatile security invoker set search_path = public as $$
  insert into public.media_bridges (id, public_url, started_at, seen_at) values (p_id, p_url, now(), now())
  on conflict (id) do update set public_url = excluded.public_url, seen_at = now();
$$;

create or replace function public.active_media_bridge(p_fresh_seconds integer) returns setof public.media_bridges
language sql stable security invoker set search_path = public as $$
  select * from public.media_bridges
  where seen_at > now() - make_interval(secs => p_fresh_seconds)
  order by seen_at desc
  limit 1;
$$;

/* ---------- 5. retire a voice now ---------- */

create or replace function public.voice_twin_retire_voice(p_twin_id uuid, p_voice_id text) returns boolean
language sql volatile security invoker set search_path = public as $$
  with r as (
    update public.voice_twins
    set voice_expires_at = least(voice_expires_at, now()), updated_at = now()
    where id = p_twin_id and voice_id = p_voice_id and state = 'ready'
    returning id
  )
  select exists (select 1 from r);
$$;

revoke execute on function public.call_has_customer_speech(public.calls) from public, anon, authenticated;
revoke execute on function public.call_audio_eligible(public.calls) from public, anon, authenticated;
revoke execute on function public.call_is_over(public.calls) from public, anon, authenticated;
revoke execute on function public.media_bridge_heartbeat(text, text) from public, anon, authenticated;
revoke execute on function public.active_media_bridge(integer) from public, anon, authenticated;
revoke execute on function public.voice_twin_retire_voice(uuid, text) from public, anon, authenticated;
revoke execute on function public.voice_twin_add_audio(uuid, text, uuid, text, integer, text, text, integer, double precision, integer) from public, anon, authenticated;
revoke execute on function public.voice_twin_claim_clone(uuid, double precision, integer, boolean) from public, anon, authenticated;
revoke execute on function public.voice_twin_expire(uuid) from public, anon, authenticated;
revoke execute on function public.voice_twin_discard_unflagged_call_audio(uuid) from public, anon, authenticated;
grant execute on function public.call_has_customer_speech(public.calls) to service_role;
grant execute on function public.call_audio_eligible(public.calls) to service_role;
grant execute on function public.call_is_over(public.calls) to service_role;
grant execute on function public.media_bridge_heartbeat(text, text) to service_role;
grant execute on function public.active_media_bridge(integer) to service_role;
grant execute on function public.voice_twin_retire_voice(uuid, text) to service_role;
grant execute on function public.voice_twin_add_audio(uuid, text, uuid, text, integer, text, text, integer, double precision, integer) to service_role;
grant execute on function public.voice_twin_claim_clone(uuid, double precision, integer, boolean) to service_role;
grant execute on function public.voice_twin_expire(uuid) to service_role;
grant execute on function public.voice_twin_discard_unflagged_call_audio(uuid) to service_role;
