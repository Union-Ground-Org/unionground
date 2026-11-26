-- BUG-UG-GOV-EMAIL-BLOCK-MISSES-US-LOCALITY-DOMAINS-20261102 (#6788)
-- The government rules of 20261102161500 (#6726) missed the RFC 1480 locality
-- delegations themselves: an address at <place>.<state>.us (riverside.ca.us)
-- passed, because us_state_level needs one of its labels in front of the state
-- and us_locality needs four labels (ci.boston.ma.us). A domain that is exactly
-- <place>.<state>.us, for a us_state label, is now government. A name one level
-- down (acme.riverside.ca.us) is a private delegation and stays allowed unless
-- us_locality already covers it. Rewrites the database copy of
-- config/account-blocked-email-domains.json (tests/account-email-domains.test.js
-- keeps the two equal) and the matcher; the auth.users trigger is unchanged.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table private.account_blocked_email_domain_rules
  drop constraint account_blocked_email_domain_rules_rule_check,
  add constraint account_blocked_email_domain_rules_rule_check
    check (rule in ('top_level', 'country_second_level', 'suffix', 'us_state_level', 'us_locality', 'us_state', 'employer'));

delete from private.account_blocked_email_domain_rules;

-- Seeded from config/account-blocked-email-domains.json. 106 rows.
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
  ('us_locality', 'vil'),
  ('us_state', 'ak'),
  ('us_state', 'al'),
  ('us_state', 'ar'),
  ('us_state', 'as'),
  ('us_state', 'az'),
  ('us_state', 'ca'),
  ('us_state', 'co'),
  ('us_state', 'ct'),
  ('us_state', 'dc'),
  ('us_state', 'de'),
  ('us_state', 'fl'),
  ('us_state', 'ga'),
  ('us_state', 'gu'),
  ('us_state', 'hi'),
  ('us_state', 'ia'),
  ('us_state', 'id'),
  ('us_state', 'il'),
  ('us_state', 'in'),
  ('us_state', 'ks'),
  ('us_state', 'ky'),
  ('us_state', 'la'),
  ('us_state', 'ma'),
  ('us_state', 'md'),
  ('us_state', 'me'),
  ('us_state', 'mi'),
  ('us_state', 'mn'),
  ('us_state', 'mo'),
  ('us_state', 'mp'),
  ('us_state', 'ms'),
  ('us_state', 'mt'),
  ('us_state', 'nc'),
  ('us_state', 'nd'),
  ('us_state', 'ne'),
  ('us_state', 'nh'),
  ('us_state', 'nj'),
  ('us_state', 'nm'),
  ('us_state', 'nv'),
  ('us_state', 'ny'),
  ('us_state', 'oh'),
  ('us_state', 'ok'),
  ('us_state', 'or'),
  ('us_state', 'pa'),
  ('us_state', 'pr'),
  ('us_state', 'ri'),
  ('us_state', 'sc'),
  ('us_state', 'sd'),
  ('us_state', 'tn'),
  ('us_state', 'tx'),
  ('us_state', 'ut'),
  ('us_state', 'va'),
  ('us_state', 'vi'),
  ('us_state', 'vt'),
  ('us_state', 'wa'),
  ('us_state', 'wi'),
  ('us_state', 'wv'),
  ('us_state', 'wy');

create or replace function private.account_email_block_reason(p_email text)
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
    -- <place>.<state>.us itself is the locality's own delegation (riverside.ca.us).
    if n = 3 and exists (select 1 from private.account_blocked_email_domain_rules r
                         where r.rule = 'us_state' and r.value = labels[n - 1]) then
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

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.kind = 'function' and s.schema_name = 'private'
  and pg_catalog.split_part(s.object_name, '(', 1) = 'account_email_block_reason'
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;
do $review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review incomplete after the us locality email domain rule';
  end if;
end;
$review$;
notify pgrst, 'reload schema';
commit;
