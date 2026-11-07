-- Six auto-matched AI voices (spec5). The four scam-type personas (margaret, derek, priya, keith) are replaced by one
-- AI voice per age band and gender, matched to the customer: their "Your AI voice match" setting, else inferred from
-- the call, else the default. Old calls keep their legacy persona so their reports still name it.
--
--   calls.persona         also accepts the six AI voices
--   calls.ai_voice_match  which AI voice took (or tried to take) the call and why: {voice, age_band, gender, source,
--                         age_from, gender_from, confidence, inference}; source is setting / inferred / default
--   settings.voice_match_age_band / voice_match_gender   the customer's optional "Your AI voice match"
--
-- Additive only: no data changes. Service role only, like every table since 0008 (new columns inherit the grants).

alter table public.calls drop constraint if exists calls_persona_check;
alter table public.calls add constraint calls_persona_check
  check (persona is null or persona in (
    'margaret', 'derek', 'priya', 'keith',
    'younger_male', 'middle_male', 'older_male', 'younger_female', 'middle_female', 'older_female'));

alter table public.calls add column if not exists ai_voice_match jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'calls_ai_voice_match_check') then
    alter table public.calls add constraint calls_ai_voice_match_check
      check (
        ai_voice_match is null
        or (
          jsonb_typeof(ai_voice_match) = 'object'
          and ai_voice_match->>'voice' in ('younger_male', 'middle_male', 'older_male', 'younger_female', 'middle_female', 'older_female')
          and ai_voice_match->>'source' in ('setting', 'inferred', 'default')
          and ai_voice_match->>'age_band' in ('younger', 'middle', 'older')
          and ai_voice_match->>'gender' in ('male', 'female')
          and ai_voice_match->>'voice' = (ai_voice_match->>'age_band') || '_' || (ai_voice_match->>'gender')
        )
      );
  end if;
  -- The AI voice is a persona takeover: never recorded on an AI Voice Twin takeover.
  if not exists (select 1 from pg_constraint where conname = 'calls_ai_voice_match_kind_check') then
    alter table public.calls add constraint calls_ai_voice_match_kind_check
      check (ai_voice_match is null or takeover_kind is distinct from 'voice_twin');
  end if;
end;
$$;

alter table public.settings add column if not exists voice_match_age_band text;
alter table public.settings add column if not exists voice_match_gender text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'settings_voice_match_age_band_check') then
    alter table public.settings add constraint settings_voice_match_age_band_check
      check (voice_match_age_band is null or voice_match_age_band in ('younger', 'middle', 'older'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'settings_voice_match_gender_check') then
    alter table public.settings add constraint settings_voice_match_gender_check
      check (voice_match_gender is null or voice_match_gender in ('male', 'female'));
  end if;
end;
$$;
