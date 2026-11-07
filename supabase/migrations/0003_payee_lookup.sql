-- Deterministic payee lookup against Northgate's own accounts (no LLM).
-- Callers pass an already-normalised sort code ("NN-NN-NN") and account number (8 digits).
--   match_type = 'account' : exact sort code + account number match  -> mule match
--   match_type = 'name'    : holder name matches but the account does not -> low-confidence warning only

create or replace function public.normalise_holder_name(n text) returns text
language sql immutable as $$
  select btrim(regexp_replace(
           regexp_replace(lower(coalesce(n, '')), '^\s*(mr|mrs|ms|miss|mx|dr)\.?\s+', ''),
           '[^a-z0-9]+', ' ', 'g'))
$$;

create or replace function public.lookup_payee(p_sort_code text, p_account_number text, p_name text)
returns table (
  match_type          text,
  id                  uuid,
  holder_name         text,
  sort_code           text,
  account_number      text,
  status              text,
  payments_in_48h     integer,
  distinct_payers_48h integer,
  total_in_48h_pence  bigint
)
language sql stable security invoker set search_path = public as $$
  select 'account'::text, b.id, b.holder_name, b.sort_code, b.account_number, b.status,
         b.payments_in_48h, b.distinct_payers_48h, b.total_in_48h_pence
  from public.bank_accounts b
  where p_sort_code is not null and p_account_number is not null
    and b.sort_code = p_sort_code and b.account_number = p_account_number
  union all
  select 'name'::text, b.id, b.holder_name, b.sort_code, b.account_number, b.status,
         b.payments_in_48h, b.distinct_payers_48h, b.total_in_48h_pence
  from public.bank_accounts b
  where nullif(public.normalise_holder_name(p_name), '') is not null
    and public.normalise_holder_name(b.holder_name) = public.normalise_holder_name(p_name)
    and not (b.sort_code = coalesce(p_sort_code, '') and b.account_number = coalesce(p_account_number, ''))
$$;

-- Server-only: the browser never calls this.
revoke execute on function public.lookup_payee(text, text, text) from public, anon, authenticated;
grant execute on function public.lookup_payee(text, text, text) to service_role;
