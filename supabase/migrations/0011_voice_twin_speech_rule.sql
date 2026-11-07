-- AI Voice Twin, second review fixes.
--
-- 1. call_has_customer_speech (0010) was far too broad: it rejected a whole call if ANY customer line contained
--    ordinary phrases such as "who's calling", "not available" or "voicemail", so most genuine scam calls never counted
--    (and their audio was discarded). Voicemail greetings and phone call-screening assistants speak FIRST, so only the
--    customer's first two lines are checked now, and only for strong markers ("after the tone", "the person you're
--    calling", "call assistant", "voicemail service", …). Curly apostrophes are normalised before matching.
-- 2. voice_twin_add_audio takes the consent the audio was recorded under (p_consent_at, the stream token's or the
--    Settings recording's consent_given_at) and refuses it under the row lock if the account holder has revoked or
--    re-consented since: audio captured under one consent is never stored under the next. Compared as timestamptz.
-- 3. voice_twin_expire also retires a voice in its final minute (the customer view and the takeover already treat it
--    as expired), so audio arriving in that minute isn't refused for a voice that is about to go.

create or replace function public.call_has_customer_speech(c public.calls) returns boolean
language sql stable set search_path = public as $$
  with customer as (
    select translate(coalesce(e->>'text', ''), '’‘', '''''') as text, row_number() over (order by ord) as n
    from jsonb_array_elements(coalesce(c.screening_transcript, '[]'::jsonb)) with ordinality as x(e, ord)
    where e->>'speaker' = 'customer'
  )
  select exists (
      select 1 from customer where coalesce(array_length(regexp_split_to_array(btrim(text), '\s+'), 1), 0) >= 3
    )
    and not exists (
      select 1 from customer
      where n <= 2
        and text ~* '(leave (a|your) (message|name)|after the (tone|beep)|(person|number|subscriber|customer) (you|you''re|you are|you''ve|you have) (calling|called|dialled|dialed|trying)|record your (name|message)|(voice ?mail|mailbox) (service|box|is full)|screening (service|assistant)|call (assistant|screen)|is using a (call )?screening|(cannot|can''t|unable to) (take|answer) (your|the) call|can''t come to the phone|(welcome to|you have reached|you''ve reached) .{0,40}(voice ?mail|mailbox|answer ?phone)|number you have dialled|(say|state|tell me) your name and)'
    );
$$;

drop function if exists public.voice_twin_add_audio(uuid, text, uuid, text, integer, text, text, integer, double precision, integer);

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
  p_bytes       integer,
  p_consent_at  timestamptz default null
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
  -- Recorded under an earlier consent (revoked and given again since): never stored under the new one.
  if p_consent_at is not null and t.consent_given_at is distinct from p_consent_at then
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

create or replace function public.voice_twin_expire(p_twin_id uuid)
returns jsonb
language plpgsql volatile security invoker set search_path = public as $$
declare
  t       public.voice_twins%rowtype;
  v_paths jsonb;
begin
  select * into t from public.voice_twins where id = p_twin_id for update;
  -- Due from one minute before voice_expires_at: that minute is already "expired" for the customer and the takeover.
  if not found or t.state <> 'ready' or t.voice_expires_at > now() + interval '60 seconds' then
    return jsonb_build_object('expired', false, 'reason', 'not_due', 'paths', '[]'::jsonb);
  end if;
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

revoke execute on function public.call_has_customer_speech(public.calls) from public, anon, authenticated;
revoke execute on function public.voice_twin_add_audio(uuid, text, uuid, text, integer, text, text, integer, double precision, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.voice_twin_expire(uuid) from public, anon, authenticated;
grant execute on function public.call_has_customer_speech(public.calls) to service_role;
grant execute on function public.voice_twin_add_audio(uuid, text, uuid, text, integer, text, text, integer, double precision, integer, timestamptz) to service_role;
grant execute on function public.voice_twin_expire(uuid) to service_role;
