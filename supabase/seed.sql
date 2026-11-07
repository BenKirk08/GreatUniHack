-- Northgate Bank (fictional) customer accounts. Sort codes in the 99-50-xx range are invented for the demo.
-- Two are money-mule accounts: more than 3 distinct payers and £2k–£6k inbound in the last 48 hours.
-- Everyone else looks normal, including a few deliberate near-misses (one payer sending a lot, or many payers sending little).
-- Re-running refreshes the activity figures but never un-freezes an account (use `npm run db:migrate -- --reset-demo` for that).

insert into public.bank_accounts
  (holder_name, sort_code, account_number, payments_in_48h, distinct_payers_48h, total_in_48h_pence)
values
  -- MULE 1: used by the "safe account" scenario and the judge card
  ('Daniel Price',      '99-50-17', '41873026', 7, 6, 487500),
  -- MULE 2: used by the "grandchild emergency" scenario
  ('Jordan Hale',       '99-50-42', '63019458', 5, 5, 312000),

  ('Sarah Mitchell',    '99-50-03', '20481937', 1, 1, 245000),  -- salary; also a name-only near-miss in the investment scenario
  ('Aisha Rahman',      '99-50-08', '37210584', 2, 1,  18250),
  ('Thomas Whitfield',  '99-50-11', '58302176', 1, 1, 312500),  -- salary: one payer, large amount
  ('Grace O''Connell',  '99-50-11', '71839260', 0, 0,      0),
  ('Michael Osei',      '99-50-23', '29384710', 3, 2,  42000),
  ('Emily Hargreaves',  '99-50-23', '84720193', 1, 1, 198000),
  ('Rajesh Patel',      '99-50-29', '50938172', 2, 2,   8999),
  ('Hannah Brooks',     '99-50-31', '16273849', 4, 3,  61500),
  ('Oliver Bennett',    '99-50-35', '93017264', 1, 1,   5000),
  ('Chloe Davies',      '99-50-38', '40182736', 2, 1, 260000),  -- moved savings in from her own account
  ('William Turner',    '99-50-44', '62839104', 0, 0,      0),
  ('Fatima Begum',      '99-50-47', '75019283', 3, 2,  15500),
  ('George Lawson',     '99-50-51', '31928475', 1, 1, 120000),
  ('Priya Sharma',      '99-50-55', '86473012', 2, 2,  34000),
  ('Callum Reid',       '99-50-58', '47261830', 1, 1,   2500),
  ('Sophie Clarke',     '99-50-62', '58193027', 5, 4,  72000),  -- four flatmates paying rent shares: many payers, small total
  ('Ethan Moore',       '99-50-66', '20938475', 1, 1, 410000),  -- house deposit from a parent
  ('Nadia Kowalski',    '99-50-71', '69102847', 1, 1, 175000)
on conflict (sort_code, account_number) do update set
  holder_name         = excluded.holder_name,
  payments_in_48h     = excluded.payments_in_48h,
  distinct_payers_48h = excluded.distinct_payers_48h,
  total_in_48h_pence  = excluded.total_in_48h_pence;
