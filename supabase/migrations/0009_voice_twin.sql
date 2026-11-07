-- AI Voice Twin. An Instant Voice Clone of the consenting account holder's own voice, built from their side of flagged
-- calls (Twilio Media Stream on the customer's leg only → services/media-bridge) and/or a sample recorded in Settings.
-- It is only ever used inside a flagged-scam handover the customer chooses.
--
-- Rules enforced here, not just in code:
--   * consent gate: a twin without consent holds no voice, no audio and no speech seconds (check constraint), and
--     voice_twin_add_audio / voice_twin_claim_clone refuse to work without consent;
--   * audio from a call is only usable once that call has been flagged as a likely scam; audio from a call that
--     ended unflagged is discarded (the consent covers "flagged calls");
--   * every ElevenLabs voice the app must delete (revoke, 24 h expiry, a clone that finished after a revoke) is
--     queued in voice_twin_voice_deletions until the API confirms it is gone.
-- Service role only, like every table since 0008. voice_twins changes reach /protect as content-free Realtime
-- Broadcast signals on "northgate-ops" (broadcast_row_change), which is how speech_seconds is published live.

create table if not exists public.voice_twins (
  id                   uuid primary key default gen_random_uuid(),
  account_ref          text not null unique,          -- 'customer': the single Call Guard account holder
  voice_twin_consent   boolean not null default false,
  consent_given_at     timestamptz,
  consent_given_by     text,
  consent_text_version text,
  consent_user_agent   text,
  consent_revoked_at   timestamptz,
  state                text not null default 'collecting',
  speech_seconds       double precision not null default 0,
  voice_id             text,
  voice_source         text,
  voice_created_at     timestamptz,
  voice_expires_at     timestamptz,
  clone_speech_seconds double precision,
  clone_error          text,
  cloning_started_at   timestamptz,
  last_audio_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint voice_twins_state_check check (state in ('collecting', 'cloning', 'ready', 'failed')),
  constraint voice_twins_voice_source_check check (voice_source is null or voice_source in ('clone', 'fallback')),
  constraint voice_twins_speech_check check (speech_seconds >= 0),
  constraint voice_twins_ready_has_voice check (state <> 'ready' or (voice_id is not null and voice_source is not null and voice_expires_at is not null)),
  constraint voice_twins_consent_gate check (voice_twin_consent or (voice_id is null and state = 'collecting' and speech_seconds = 0))
);

-- Who consented and when (and every revoke), kept as an audit trail.
create table if not exists public.voice_twin_consent_events (
  id           bigint generated always as identity primary key,
  twin_id      uuid not null references public.voice_twins(id) on delete cascade,
  event        text not null check (event in ('given', 'revoked')),
  at           timestamptz not null default now(),
  by           text,
  user_agent   text,
  text_version text,
  detail       jsonb not null default '{}'::jsonb
);
create index if not exists voice_twin_consent_events_twin_idx on public.voice_twin_consent_events (twin_id, at desc);

-- Raw audio chunks in the private Storage bucket "voice-twin". Deleted once the clone is created, on revoke, and
-- (for calls) when the call ends without being flagged.
create table if not exists public.voice_twin_audio (
  id             uuid primary key default gen_random_uuid(),
  twin_id        uuid not null references public.voice_twins(id) on delete cascade,
  source         text not null check (source in ('call', 'sample')),
  call_id        uuid references public.calls(id) on delete set null,
  session_id     text not null,                       -- Settings recording session, or the Twilio StreamSid
  seq            integer not null check (seq >= 0),
  storage_path   text not null unique,
  mime_type      text not null,
  sample_rate    integer,
  speech_seconds double precision not null check (speech_seconds >= 0),
  bytes          integer not null check (bytes >= 0),
  created_at     timestamptz not null default now(),
  unique (twin_id, session_id, seq)
);
create index if not exists voice_twin_audio_twin_idx on public.voice_twin_audio (twin_id, created_at);
create index if not exists voice_twin_audio_call_idx on public.voice_twin_audio (call_id);

-- ElevenLabs voices waiting to be deleted through the API (retried by housekeeping until confirmed).
create table if not exists public.voice_twin_voice_deletions (
  voice_id    text primary key,
  twin_id     uuid references public.voice_twins(id) on delete set null,
  reason      text not null,                            -- 'revoked' | 'expired' | 'orphan'
  attempts    integer not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  last_try_at timestamptz
);

-- The local media bridge (services/media-bridge) registers its public wss URL here and heartbeats while it runs, so
-- the Vercel app only asks Twilio to stream to a bridge that is actually up (no redeploy when the ngrok URL changes).
create table if not exists public.media_bridges (
  id         text primary key,
  public_url text not null,
  started_at timestamptz not null default now(),
  seen_at    timestamptz not null default now()
);

-- Takeover type on each call: a persona, or the AI Voice Twin (with what it was built from and the consent reference).
alter table public.calls add column if not exists takeover_kind             text;
alter table public.calls add column if not exists voice_twin_speech_seconds double precision;
alter table public.calls add column if not exists voice_twin_consent_at     timestamptz;
alter table public.calls add column if not exists voice_twin_voice_source   text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'calls_takeover_kind_check') then
    alter table public.calls add constraint calls_takeover_kind_check
      check (takeover_kind is null or takeover_kind in ('persona', 'voice_twin'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calls_voice_twin_source_check') then
    alter table public.calls add constraint calls_voice_twin_source_check
      check (voice_twin_voice_source is null or voice_twin_voice_source in ('clone', 'fallback'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calls_voice_twin_consent_check') then
    -- A twin takeover always carries its consent reference.
    alter table public.calls add constraint calls_voice_twin_consent_check
      check (takeover_kind is distinct from 'voice_twin' or voice_twin_consent_at is not null);
  end if;
end;
$$;

update public.calls set takeover_kind = 'persona' where takeover_kind is null and persona is not null and handoff_status = 'connected';

/* ---------- access: service role only ---------- */

alter table public.voice_twins enable row level security;
alter table public.voice_twin_consent_events enable row level security;
alter table public.voice_twin_audio enable row level security;
alter table public.voice_twin_voice_deletions enable row level security;
alter table public.media_bridges enable row level security;
revoke all on public.voice_twins, public.voice_twin_consent_events, public.voice_twin_audio, public.voice_twin_voice_deletions,
  public.media_bridges from public, anon, authenticated;
grant select, insert, update, delete on public.voice_twins, public.voice_twin_consent_events, public.voice_twin_audio,
  public.voice_twin_voice_deletions, public.media_bridges to service_role;

-- Content-free change signals for the twin (progress bar, state changes) on the existing "northgate-ops" topic.
drop trigger if exists voice_twins_broadcast_change on public.voice_twins;
create trigger voice_twins_broadcast_change after insert or update or delete on public.voice_twins
  for each row execute function public.broadcast_row_change();

/* ---------- private Storage bucket ---------- */

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voice-twin', 'voice-twin', false, 10485760, array['audio/wav', 'audio/x-wav'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

/* ---------- functions ---------- */

-- A call counts as flagged once Call Guard offered the takeover (risk reached the threshold) or anyone took it over.
create or replace function public.call_is_flagged(c public.calls) returns boolean
language sql stable set search_path = public as $$
  select c.offered_at is not null
      or coalesce(c.risk ? 'threshold_crossed_at', false)
      or c.handoff_status in ('offered', 'declined', 'requested', 'connected', 'failed');
$$;

-- Register one stored audio chunk and add its clean-speech seconds. Refused (the caller deletes the object) without
-- consent, once the twin is cloning/ready, or for a call that already ended unflagged. Idempotent per (session, seq).
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
    if c.status = 'ended' and not public.call_is_flagged(c) then
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

-- Claim the clone: collecting (or failed, on an explicit retry, or a stale 'cloning' claim) → cloning, but only with
-- consent and at least p_min_seconds of eligible speech (Settings samples + flagged calls). Returns the eligible chunks.
create or replace function public.voice_twin_claim_clone(
  p_twin_id       uuid,
  p_min_seconds   double precision,
  p_stale_seconds integer,
  p_allow_failed  boolean
) returns jsonb
language plpgsql volatile security invoker set search_path = public as $$
declare
  t          public.voice_twins%rowtype;
  v_eligible double precision;
  v_audio    jsonb;
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
    and (a.source = 'sample' or (c.id is not null and public.call_is_flagged(c)));

  if v_eligible < p_min_seconds then
    return jsonb_build_object('claimed', false, 'reason', 'not_enough_audio', 'eligible_seconds', v_eligible);
  end if;

  update public.voice_twins
  set state = 'cloning', cloning_started_at = now(), clone_error = null, updated_at = now()
  where id = p_twin_id;
  return jsonb_build_object('claimed', true, 'eligible_seconds', v_eligible, 'audio', v_audio);
end;
$$;

-- Revoke: consent off, every audio row removed (paths returned for Storage deletion), the twin reset, the voice
-- queued for deletion (an app-made clone only: the fallback voice was made by hand in the ElevenLabs dashboard).
create or replace function public.voice_twin_revoke(p_twin_id uuid, p_by text, p_user_agent text)
returns jsonb
language plpgsql volatile security invoker set search_path = public as $$
declare
  t       public.voice_twins%rowtype;
  v_paths jsonb;
begin
  select * into t from public.voice_twins where id = p_twin_id for update;
  if not found then
    return jsonb_build_object('revoked', false, 'reason', 'missing', 'paths', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into v_paths from public.voice_twin_audio where twin_id = p_twin_id;
  delete from public.voice_twin_audio where twin_id = p_twin_id;
  if t.voice_id is not null and t.voice_source = 'clone' then
    insert into public.voice_twin_voice_deletions (voice_id, twin_id, reason) values (t.voice_id, t.id, 'revoked')
    on conflict (voice_id) do nothing;
  end if;
  update public.voice_twins
  set voice_twin_consent = false, consent_revoked_at = now(), state = 'collecting', speech_seconds = 0,
      voice_id = null, voice_source = null, voice_created_at = null, voice_expires_at = null,
      clone_speech_seconds = null, clone_error = null, cloning_started_at = null, updated_at = now()
  where id = p_twin_id;
  insert into public.voice_twin_consent_events (twin_id, event, by, user_agent, detail)
  values (p_twin_id, 'revoked', p_by, p_user_agent,
          jsonb_build_object('had_consent', t.voice_twin_consent, 'voice_id', t.voice_id, 'voice_source', t.voice_source,
                             'audio_chunks', jsonb_array_length(v_paths)));
  return jsonb_build_object('revoked', true, 'previous', to_jsonb(t), 'paths', v_paths);
end;
$$;

-- 24 h after creation the twin's voice is retired: queued for deletion (app-made clones), the twin back to collecting
-- with no audio. Deferred while a call is live on the twin's voice. Returns the paths of any leftover audio.
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
  if exists (select 1 from public.calls where status = 'live' and takeover_kind = 'voice_twin' and handoff_status in ('requested', 'connected')) then
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

-- Discard the audio of a call that ended without being flagged (or whose call row is gone); its seconds come off the
-- twin's total. A flagged call's audio is kept. Returns the Storage paths to delete.
create or replace function public.voice_twin_discard_unflagged_call_audio(p_call_id uuid)
returns jsonb
language plpgsql volatile security invoker set search_path = public as $$
declare
  c       public.calls%rowtype;
  v_paths jsonb;
begin
  select * into c from public.calls where id = p_call_id;
  if found and (c.status = 'live' or public.call_is_flagged(c)) then
    return jsonb_build_object('discarded', false, 'reason', case when c.status = 'live' then 'live' else 'flagged' end, 'paths', '[]'::jsonb);
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

revoke execute on function public.call_is_flagged(public.calls) from public, anon, authenticated;
revoke execute on function public.voice_twin_add_audio(uuid, text, uuid, text, integer, text, text, integer, double precision, integer) from public, anon, authenticated;
revoke execute on function public.voice_twin_claim_clone(uuid, double precision, integer, boolean) from public, anon, authenticated;
revoke execute on function public.voice_twin_revoke(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.voice_twin_expire(uuid) from public, anon, authenticated;
revoke execute on function public.voice_twin_discard_unflagged_call_audio(uuid) from public, anon, authenticated;
grant execute on function public.call_is_flagged(public.calls) to service_role;
grant execute on function public.voice_twin_add_audio(uuid, text, uuid, text, integer, text, text, integer, double precision, integer) to service_role;
grant execute on function public.voice_twin_claim_clone(uuid, double precision, integer, boolean) to service_role;
grant execute on function public.voice_twin_revoke(uuid, text, text) to service_role;
grant execute on function public.voice_twin_expire(uuid) to service_role;
grant execute on function public.voice_twin_discard_unflagged_call_audio(uuid) to service_role;
