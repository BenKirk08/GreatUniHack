-- Granny Agent: core schema (4 tables)

create table if not exists public.calls (
  id              uuid primary key default gen_random_uuid(),
  conversation_id text not null unique,
  caller_masked   text,                       -- last 3 digits only, e.g. "•••928"
  direction       text not null default 'inbound' check (direction in ('inbound', 'outbound')),
  status          text not null default 'live' check (status in ('live', 'ended')),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  transcript      jsonb not null default '[]'::jsonb,
  intel           jsonb,
  intel_turns     integer not null default 0, -- transcript turn count the stored intel was built from
  mule_match      jsonb,
  updated_at      timestamptz not null default now()
);

create index if not exists calls_started_at_idx on public.calls (started_at desc);

create table if not exists public.reports (
  id              uuid primary key default gen_random_uuid(),
  call_id         uuid not null unique references public.calls (id) on delete cascade,
  status          text not null default 'draft' check (status in ('draft', 'sent')),
  body            jsonb not null,
  sent_at         timestamptz,
  approved_by     text,                       -- null when auto-sent
  email_id        text,                       -- Resend email id, for delivery checks
  send_claimed_at timestamptz,                -- short-lived lock so a report is never emailed twice
  created_at      timestamptz not null default now()
);

create table if not exists public.bank_accounts (
  id                  uuid primary key default gen_random_uuid(),
  holder_name         text not null,
  sort_code           text not null check (sort_code ~ '^\d{2}-\d{2}-\d{2}$'),
  account_number      text not null check (account_number ~ '^\d{8}$'),
  status              text not null default 'active' check (status in ('active', 'frozen')),
  payments_in_48h     integer not null default 0,
  distinct_payers_48h integer not null default 0,
  total_in_48h_pence  bigint not null default 0,
  frozen_at           timestamptz,
  unique (sort_code, account_number)
);

create table if not exists public.settings (
  id         integer primary key default 1 check (id = 1),  -- single row
  auto_send  boolean not null,
  updated_at timestamptz not null default now()
);

-- keep calls.updated_at fresh
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists calls_touch_updated_at on public.calls;
create trigger calls_touch_updated_at before update on public.calls
  for each row execute function public.touch_updated_at();
