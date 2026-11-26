begin;

-- REQ-UG-APP-STORE-STATES-AGE-RULE-20261016.
--
-- Project decision of Friday October 16, 2026, about 12:50 PM ET, retained at
-- the operator runbook
-- 20261016-adults-only-app-store-states.md: Union Ground is adults-only (18
-- and over) only for a person in one of the app-store age-law states (Texas,
-- California, Alabama, Utah, Louisiana). Everywhere else the D-03 B band of
-- October 10 applies again: not directed to children under 13, and a person
-- 13 to 17 only through an account their organization authorized and where
-- law permits. The product learns the state by asking at invitation
-- acceptance, at re-acceptance and at open signup; the answer is recorded
-- with the attestation. This narrows 20261012233000 (adults-only everywhere).
--
-- Additive on purpose: it depends only on 20261010213000 and 20261012233000,
-- sorts after every merged migration, and adds two columns, a region check, a
-- re-scoped pair constraint, the 0.3.0 pin, a readiness probe and the two
-- writers' new signatures. Nothing is back-filled: rows recorded before it
-- keep a null residence_state, and terms of use 0.3.0 is material, so every
-- existing account answers the question at its next acceptance.
alter table private.legal_acceptances
  add column residence_state text,
  add column band_attested boolean not null default false;

comment on column private.legal_acceptances.residence_state is
  'REQ-UG-APP-STORE-STATES-AGE-RULE-20261016: the US state, district or territory (USPS code) the person said they live in when they accepted, or outside-us. Self-reported; it selects which age attestation the acceptance carries. Null only on rows recorded before terms of use 0.3.0.';
comment on column private.legal_acceptances.band_attested is
  'REQ-UG-APP-STORE-STATES-AGE-RULE-20261016: true when the person, outside the app-store age-law states, attested to the D-03 B band (13 or older, and if under 18 the account is authorized by their organization).';

-- The list mirrors src/lib/residenceRegions.js RESIDENCE_REGIONS.
alter table private.legal_acceptances
  add constraint legal_acceptances_residence_state_listed
  check (
    residence_state is null
    or residence_state = any (array[
      'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
      'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
      'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
      'VT','VA','WA','WV','WI','WY','AS','GU','MP','PR','VI','outside-us'
    ]::text[])
  );

-- The pair rule is keyed to the terms version the row accepted, so a row
-- keeps the meaning of the text it agreed to: 0.1.x asked nothing about age,
-- 0.2.x required the 18-or-older attestation everywhere, and from 0.3.0 the
-- recorded state selects exactly one attestation. A later change to the
-- state list is a material terms change and adds its own arm here.
alter table private.legal_acceptances
  drop constraint legal_acceptances_adult_attested_from_terms_0_2;

alter table private.legal_acceptances
  add constraint legal_acceptances_age_rule_by_terms_version
  check (
    case
      when pg_catalog.string_to_array(terms_version, '.')::integer[] < array[0, 2, 0] then true
      when pg_catalog.string_to_array(terms_version, '.')::integer[] < array[0, 3, 0] then adult_attested
      else residence_state is not null and (
        (residence_state = any (array['TX','CA','AL','UT','LA']::text[])
          and adult_attested and not band_attested)
        or (residence_state <> all (array['TX','CA','AL','UT','LA']::text[])
          and band_attested and not adult_attested)
      )
    end
  );

-- 'adult' for the five app-store age-law states, 'band' for every other
-- listed region, null for anything unlisted. The writers below derive the
-- attestation from this and the recorded state, never from the client.
create function private.residence_age_rule(p_residence_state text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_residence_state = any (array['TX','CA','AL','UT','LA']::text[]) then 'adult'
    when p_residence_state = any (array[
      'AK','AZ','AR','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
      'IA','KS','KY','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
      'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN',
      'VT','VA','WA','WV','WI','WY','AS','GU','MP','PR','VI','outside-us'
    ]::text[]) then 'band'
    else null
  end;
$function$;

revoke all on function private.residence_age_rule(text) from public, anon, authenticated, service_role;

comment on function private.residence_age_rule(text) is
  'REQ-UG-APP-STORE-STATES-AGE-RULE-20261016: adult for TX, CA, AL, UT and LA; band for every other listed region; null otherwise.';

-- The published pack moves with src/lib/legalInstruments.js: terms of use
-- 0.3.0. The parity regression replays this latest definition and refuses a
-- stale pin.
create or replace function private.legal_acceptance_versions(p_versions jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  entry record;
begin
  if p_versions is null
    or pg_catalog.jsonb_typeof(p_versions) <> 'object'
    or p_versions = '{}'::jsonb
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_versions)) > 32
  then
    raise exception 'legal versions required' using errcode = '22023';
  end if;
  for entry in select key, value from pg_catalog.jsonb_each_text(p_versions) loop
    if entry.key !~ '^[a-z][a-z0-9-]{1,62}$'
      or entry.value !~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$'
    then
      raise exception 'legal versions malformed' using errcode = '22023';
    end if;
  end loop;
  if p_versions ->> 'terms-of-use' is null then
    raise exception 'terms version required' using errcode = '22023';
  end if;
  -- published-legal-versions: generated from currentLegalVersions(); the
  -- regression test pins this database authority to the rendered pack.
  if p_versions <> '{"privacy-policy":"0.1.0","terms-of-use":"0.3.0","accessibility-statement":"0.1.0","ai-disclosure":"0.1.0","retention-schedule":"0.1.0"}'::jsonb then
    raise exception 'legal versions not current' using errcode = '22023';
  end if;
  return p_versions;
end;
$function$;

-- Both writers take the state and the person's answer to the attestation the
-- page showed for it. The previous attestation-only signatures are dropped:
-- a client that still calls them sends a 0.2.0 pack, which the validator
-- above refuses anyway.
drop function public.record_invitation_legal_acceptance(uuid, jsonb, boolean);
drop function public.record_legal_acceptance(jsonb, boolean);

create function public.record_invitation_legal_acceptance(
  p_invitation_id uuid,
  p_versions jsonb,
  p_residence_state text,
  p_age_attested boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  invitation_row public.member_invitations%rowtype;
  versions jsonb;
  age_rule text;
  subject uuid;
  matches bigint;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  age_rule := private.residence_age_rule(p_residence_state);
  if age_rule is null then
    raise exception 'residence state required' using errcode = '22023';
  end if;
  if p_age_attested is not true then
    raise exception 'age attestation required' using errcode = '22023';
  end if;
  versions := private.legal_acceptance_versions(p_versions);
  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id and status in ('accepting', 'accepted');
  if not found then
    raise exception 'invitation unavailable' using errcode = '22023';
  end if;
  subject := invitation_row.auth_user_id;
  if subject is null then
    -- Exactly one live identity with that address, or nothing is recorded: an
    -- ambiguous address must never bind an acceptance to the wrong person.
    select pg_catalog.count(*) into matches
    from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = invitation_row.normalized_email
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= pg_catalog.clock_timestamp());
    if matches <> 1 then
      raise exception 'invitation identity unavailable' using errcode = '22023';
    end if;
    select u.id into subject
    from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = invitation_row.normalized_email
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= pg_catalog.clock_timestamp());
  end if;
  -- Serialize with account deletion (see 20261010213000): no live profile, no
  -- acceptance row.
  perform 1 from public.member_profiles p where p.id = subject for key share;
  if not found then
    raise exception 'invitation identity unavailable' using errcode = '22023';
  end if;
  insert into private.legal_acceptances
    (user_id, chapter_id, terms_version, instrument_versions, source,
     residence_state, adult_attested, band_attested)
  values (
    subject, invitation_row.chapter_id, versions ->> 'terms-of-use',
    versions, 'invitation',
    p_residence_state, age_rule = 'adult', age_rule = 'band'
  )
  -- A retry of the same pack keeps the original event, but the latest stated
  -- residence and the attestation it selects replace an earlier answer, so a
  -- retry after a lost response never reports a state it did not record.
  on conflict (user_id, chapter_id, instrument_versions, source) do update
    set residence_state = excluded.residence_state,
        adult_attested = excluded.adult_attested,
        band_attested = excluded.band_attested
    where private.legal_acceptances.residence_state is distinct from excluded.residence_state;
  return pg_catalog.jsonb_build_object('recorded', true);
end;
$function$;

comment on function public.record_invitation_legal_acceptance(uuid, jsonb, text, boolean) is
  'REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010 and REQ-UG-APP-STORE-STATES-AGE-RULE-20261016: records the clickwrap acceptance, the stated residence and the age attestation that residence selects (18 or older in TX, CA, AL, UT, LA; the D-03 B band elsewhere), for the invitation''s own identity and organization. Service role only; refuses an unlisted state or a missing attestation; one event per organization, pack and source, whose stated residence and attestation follow the latest answer.';

create function public.record_legal_acceptance(
  p_versions jsonb,
  p_residence_state text,
  p_age_attested boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  chapter text;
  versions jsonb;
  age_rule text;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  age_rule := private.residence_age_rule(p_residence_state);
  if age_rule is null then
    raise exception 'residence state required' using errcode = '22023';
  end if;
  if p_age_attested is not true then
    raise exception 'age attestation required' using errcode = '22023';
  end if;
  versions := private.legal_acceptance_versions(p_versions);
  -- Serialize with account deletion (see 20261010213000).
  select p.chapter_id into chapter from public.member_profiles p where p.id = caller for key share;
  if chapter is null then
    raise exception 'organization required' using errcode = '22023';
  end if;
  insert into private.legal_acceptances
    (user_id, chapter_id, terms_version, instrument_versions, source,
     residence_state, adult_attested, band_attested)
  values (
    caller, chapter, versions ->> 'terms-of-use', versions, 'signin',
    p_residence_state, age_rule = 'adult', age_rule = 'band'
  )
  -- A retry of the same pack keeps the original event, but the latest stated
  -- residence and the attestation it selects replace an earlier answer, so a
  -- retry after a lost response never reports a state it did not record.
  on conflict (user_id, chapter_id, instrument_versions, source) do update
    set residence_state = excluded.residence_state,
        adult_attested = excluded.adult_attested,
        band_attested = excluded.band_attested
    where private.legal_acceptances.residence_state is distinct from excluded.residence_state;
  return pg_catalog.jsonb_build_object('recorded', true, 'chapterId', chapter);
end;
$function$;

comment on function public.record_legal_acceptance(jsonb, text, boolean) is
  'REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010 and REQ-UG-APP-STORE-STATES-AGE-RULE-20261016: records the caller''s own clickwrap acceptance, stated residence and the age attestation that residence selects, after a published material change. Self only; refuses an unlisted state or a missing attestation; one event per organization, pack and source, whose stated residence and attestation follow the latest answer.';

revoke all on function public.record_invitation_legal_acceptance(uuid, jsonb, text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.record_legal_acceptance(jsonb, text, boolean)
  from public, anon, authenticated, service_role;

grant execute on function public.record_invitation_legal_acceptance(uuid, jsonb, text, boolean) to service_role;
grant execute on function public.record_legal_acceptance(jsonb, text, boolean) to authenticated;

-- api/accept-invitation.js asks this before it claims an invitation, so a
-- database without this migration fails the request before any identity is
-- created, emailed or bound (the October 13 Production observation was a 502
-- after those side effects).
create function public.legal_acceptance_residence_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::pg_catalog.regnamespace
      and p.proname = 'record_invitation_legal_acceptance'
      and pg_catalog.oidvectortypes(p.proargtypes) = 'uuid, jsonb, text, boolean'
  );
$function$;

revoke all on function public.legal_acceptance_residence_ready() from public, anon, authenticated, service_role;
grant execute on function public.legal_acceptance_residence_ready() to service_role;

comment on function public.legal_acceptance_residence_ready() is
  'REQ-UG-APP-STORE-STATES-AGE-RULE-20261016: true when the state-scoped acceptance writer is installed. Read by api/accept-invitation.js before it claims an invitation. Service role only.';

notify pgrst, 'reload schema';
commit;
