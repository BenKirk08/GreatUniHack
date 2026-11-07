-- Row level security: the dashboard (anon key) can only read. Server routes use the service role, which bypasses RLS.

alter table public.calls         enable row level security;
alter table public.reports       enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.settings      enable row level security;

drop policy if exists "dashboard read calls" on public.calls;
create policy "dashboard read calls" on public.calls for select to anon, authenticated using (true);

drop policy if exists "dashboard read reports" on public.reports;
create policy "dashboard read reports" on public.reports for select to anon, authenticated using (true);

drop policy if exists "dashboard read bank_accounts" on public.bank_accounts;
create policy "dashboard read bank_accounts" on public.bank_accounts for select to anon, authenticated using (true);

drop policy if exists "dashboard read settings" on public.settings;
create policy "dashboard read settings" on public.settings for select to anon, authenticated using (true);

-- Defence in depth: no write grants for browser roles at all.
revoke insert, update, delete, truncate on public.calls, public.reports, public.bank_accounts, public.settings from anon, authenticated;
grant select on public.calls, public.reports, public.bank_accounts, public.settings to anon, authenticated;

-- Realtime (postgres_changes) for the dashboard.
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['calls', 'reports', 'bank_accounts', 'settings'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
