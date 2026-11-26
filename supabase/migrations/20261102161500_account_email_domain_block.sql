-- REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102 (#6726)
-- Government and employer email domains can never be a Union Ground account
-- address. The rules are a database copy of config/account-blocked-email-domains.json
-- (tests/account-email-domains.test.js keeps the two equal). A trigger on
-- auth.users refuses an insert on a blocked domain and an update that sets
-- email or email_change to one, whatever path reached Auth: the server routes,
-- a direct PUT /auth/v1/user, SAML just-in-time accounts. An update that leaves
-- an existing address unchanged still passes, so no account already on such a
-- domain is locked out.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.account_blocked_email_domain_rules (
  rule text not null,
  value text not null,
  constraint account_blocked_email_domain_rules_pkey primary key (rule, value),
  constraint account_blocked_email_domain_rules_rule_check
    check (rule in ('top_level', 'country_second_level', 'suffix', 'us_state_level', 'us_locality', 'employer')),
  constraint account_blocked_email_domain_rules_value_check
    check (value ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$'
           and pg_catalog.char_length(value) <= 253)
);

comment on table private.account_blocked_email_domain_rules is
  'Government and employer email domain rules no account address may match. Database copy of config/account-blocked-email-domains.json; read only by private.account_email_block_reason.';

alter table private.account_blocked_email_domain_rules enable row level security;
alter table private.account_blocked_email_domain_rules force row level security;
revoke all on table private.account_blocked_email_domain_rules from public, anon, authenticated, service_role;

-- Seeded from config/account-blocked-email-domains.json. 50 rows.
insert into private.account_blocked_email_domain_rules (rule, value) values
  ('top_level', 'gov'),
  ('top_level', 'mil'),
  ('country_second_level', 'go'),
  ('country_second_level', 'gob'),
  ('country_second_level', 'gouv'),
  ('country_second_level', 'gov'),
  ('country_second_level', 'govt'),
  ('country_second_level', 'gub'),
  ('country_second_level', 'gv'),
  ('country_second_level', 'mil'),
  ('suffix', 'canada.ca'),
  ('suffix', 'europa.eu'),
  ('suffix', 'fed.us'),
  ('suffix', 'gc.ca'),
  ('suffix', 'gnb.ca'),
  ('suffix', 'gouv.qc.ca'),
  ('suffix', 'gov.ab.ca'),
  ('suffix', 'gov.bc.ca'),
  ('suffix', 'gov.mb.ca'),
  ('suffix', 'gov.nl.ca'),
  ('suffix', 'gov.ns.ca'),
  ('suffix', 'gov.nt.ca'),
  ('suffix', 'gov.nu.ca'),
  ('suffix', 'gov.pe.ca'),
  ('suffix', 'gov.scot'),
  ('suffix', 'gov.sk.ca'),
  ('suffix', 'gov.wales'),
  ('suffix', 'gov.yk.ca'),
  ('suffix', 'llyw.cymru'),
  ('suffix', 'mod.uk'),
  ('suffix', 'nhs.net'),
  ('suffix', 'nhs.uk'),
  ('suffix', 'nsn.us'),
  ('suffix', 'ontario.ca'),
  ('suffix', 'parliament.uk'),
  ('suffix', 'police.uk'),
  ('us_state_level', 'cc'),
  ('us_state_level', 'dst'),
  ('us_state_level', 'k12'),
  ('us_state_level', 'lib'),
  ('us_state_level', 'state'),
  ('us_state_level', 'tec'),
  ('us_locality', 'ci'),
  ('us_locality', 'city'),
  ('us_locality', 'cnty'),
  ('us_locality', 'co'),
  ('us_locality', 'county'),
  ('us_locality', 'town'),
  ('us_locality', 'twp'),
  ('us_locality', 'vil');

-- 'government', 'employer' or null. Mirrors accountEmailBlockReason in
-- api/_lib/accountEmailDomains.js: the domain is everything after the last @,
-- lowercased, without trailing dots; a rule domain matches itself and every
-- subdomain.
create function private.account_email_block_reason(p_email text)
returns text language plpgsql stable security definer set search_path = ''
as $function$
declare
  v_domain text := pg_catalog.rtrim(pg_catalog.btrim(coalesce(
    pg_catalog.substring(pg_catalog.lower(p_email), '@([^@]*)$'), '')), '.');
  labels text[];
  n integer;
begin
  if v_domain = '' then
    return null;
  end if;
  labels := pg_catalog.string_to_array(v_domain, '.');
  n := pg_catalog.cardinality(labels);
  if exists (select 1 from private.account_blocked_email_domain_rules r
             where r.rule = 'top_level' and r.value = labels[n]) then
    return 'government';
  end if;
  if n >= 2 and labels[n] ~ '^[a-z]{2}$'
     and exists (select 1 from private.account_blocked_email_domain_rules r
                 where r.rule = 'country_second_level' and r.value = labels[n - 1]) then
    return 'government';
  end if;
  if exists (select 1 from private.account_blocked_email_domain_rules r
             where r.rule = 'suffix'
               and (v_domain = r.value or pg_catalog.right(v_domain, pg_catalog.char_length(r.value) + 1) = '.' || r.value)) then
    return 'government';
  end if;
  if labels[n] = 'us' and n >= 3 and labels[n - 1] ~ '^[a-z]{2}$' then
    if exists (select 1 from private.account_blocked_email_domain_rules r
               where r.rule = 'us_state_level' and r.value = labels[n - 2]) then
      return 'government';
    end if;
    if n >= 4 and exists (select 1 from private.account_blocked_email_domain_rules r
                          where r.rule = 'us_locality' and r.value = labels[n - 3]) then
      return 'government';
    end if;
  end if;
  if exists (select 1 from private.account_blocked_email_domain_rules r
             where r.rule = 'employer'
               and (v_domain = r.value or pg_catalog.right(v_domain, pg_catalog.char_length(r.value) + 1) = '.' || r.value)) then
    return 'employer';
  end if;
  return null;
end;
$function$;
revoke all on function private.account_email_block_reason(text) from public, anon, authenticated, service_role;
comment on function private.account_email_block_reason(text) is
  'Why an email address may not be an account address: government, employer, or null when it may.';

create function private.guard_account_email_domain()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if private.account_email_block_reason(new.email) is not null then
      raise exception 'account email domain not allowed' using errcode = '22023', hint = 'email-domain-blocked';
    end if;
  elsif (new.email is distinct from old.email and private.account_email_block_reason(new.email) is not null)
     or (new.email_change is distinct from old.email_change
         and private.account_email_block_reason(new.email_change) is not null) then
    raise exception 'account email domain not allowed' using errcode = '22023', hint = 'email-domain-blocked';
  end if;
  return new;
end;
$function$;
revoke all on function private.guard_account_email_domain() from public, anon, authenticated, service_role;
comment on function private.guard_account_email_domain() is
  'Refuses an auth.users insert on a blocked email domain and an update that sets email or email_change to one; an unchanged address passes.';

-- Named to fire before guard_self_serve_account_intake, so a refused signup
-- never takes an intake reservation.
create trigger guard_account_email_domain
before insert or update of email, email_change on auth.users
for each row execute function private.guard_account_email_domain();

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.schema_name = 'auth' and s.table_name = 'users'
       and s.object_name = 'guard_account_email_domain')
   or (s.kind = 'function' and s.schema_name = 'private'
       and pg_catalog.split_part(s.object_name, '(', 1) in ('guard_account_email_domain', 'account_email_block_reason'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;
do $review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review incomplete after the account email domain block';
  end if;
end;
$review$;
notify pgrst, 'reload schema';
commit;
