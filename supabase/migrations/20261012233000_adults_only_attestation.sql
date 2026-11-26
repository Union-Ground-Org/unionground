begin;

-- REQ-UG-ADULTS-ONLY-18-PLUS-20261012.
--
-- Monday October 12, 2026, about 7:20 PM ET, retained at
-- 20261012-adults-only-18-plus.md: Union Ground is for adults 18 and over.
-- The rule is in the terms of use, and every account is created behind an
-- "I'm 18 or older" attestation; there is no identity-based age check. It
-- replaces the D-03 B band (13 to 17 through an organization account).
--
-- The attestation rides the D-08 clickwrap record rather than a second store:
-- the same row already holds the person, the organization, the terms version
-- and the time, so one row is the evidence that this person attested to being
-- 18 or older when they accepted that version. Terms of use 0.2.0 carries the
-- rule and is a material change, so an account that accepted 0.1.0 is asked
-- again at its next sign-in, and that acceptance carries the attestation too.
--
-- Rows written before this migration keep adult_attested = false: they record
-- an acceptance of 0.1.0, which asked nothing about age, and nothing is
-- back-filled or manufactured.
alter table private.legal_acceptances
  add column adult_attested boolean not null default false;

comment on column private.legal_acceptances.adult_attested is
  'REQ-UG-ADULTS-ONLY-18-PLUS-20261012: true when the person attested, with this acceptance, that they are 18 or older. Every writer since 20261012233000 refuses an acceptance without it; false only on rows recorded before the adults-only rule.';

alter table private.legal_acceptances
  add constraint legal_acceptances_adult_attested_from_terms_0_2
  check (
    adult_attested
    or pg_catalog.string_to_array(terms_version, '.')::integer[] < array[0, 2, 0]
  );

-- The published pack moves with src/lib/legalInstruments.js: terms of use
-- 0.2.0. The parity regression replays this latest definition and refuses a
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
  if p_versions <> '{"privacy-policy":"0.1.0","terms-of-use":"0.2.0","accessibility-statement":"0.1.0","ai-disclosure":"0.1.0","retention-schedule":"0.1.0"}'::jsonb then
    raise exception 'legal versions not current' using errcode = '22023';
  end if;
  return p_versions;
end;
$function$;

-- Both writers take the attestation as an explicit argument, so no acceptance
-- can be recorded without it. The previous two-argument and one-argument
-- signatures are dropped: a client that still calls them sends a 0.1.0 pack,
-- which the validator above refuses anyway.
drop function public.record_invitation_legal_acceptance(uuid, jsonb);
drop function public.record_legal_acceptance(jsonb);

create function public.record_invitation_legal_acceptance(
  p_invitation_id uuid,
  p_versions jsonb,
  p_adult_attested boolean
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
  subject uuid;
  matches bigint;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_adult_attested is not true then
    raise exception 'adult attestation required' using errcode = '22023';
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
    (user_id, chapter_id, terms_version, instrument_versions, source, adult_attested)
  values (
    subject, invitation_row.chapter_id, versions ->> 'terms-of-use',
    versions, 'invitation', true
  )
  on conflict (user_id, chapter_id, instrument_versions, source) do nothing;
  return pg_catalog.jsonb_build_object('recorded', true);
end;
$function$;

comment on function public.record_invitation_legal_acceptance(uuid, jsonb, boolean) is
  'REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010 and REQ-UG-ADULTS-ONLY-18-PLUS-20261012: records the clickwrap acceptance and the 18-or-older attestation taken at invitation acceptance, for the invitation''s own identity and organization. Service role only; refuses without the attestation; idempotent for the same organization, pack and source.';

create function public.record_legal_acceptance(p_versions jsonb, p_adult_attested boolean)
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
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_adult_attested is not true then
    raise exception 'adult attestation required' using errcode = '22023';
  end if;
  versions := private.legal_acceptance_versions(p_versions);
  -- Serialize with account deletion (see 20261010213000).
  select p.chapter_id into chapter from public.member_profiles p where p.id = caller for key share;
  if chapter is null then
    raise exception 'organization required' using errcode = '22023';
  end if;
  insert into private.legal_acceptances
    (user_id, chapter_id, terms_version, instrument_versions, source, adult_attested)
  values (caller, chapter, versions ->> 'terms-of-use', versions, 'signin', true)
  on conflict (user_id, chapter_id, instrument_versions, source) do nothing;
  return pg_catalog.jsonb_build_object('recorded', true, 'chapterId', chapter);
end;
$function$;

comment on function public.record_legal_acceptance(jsonb, boolean) is
  'REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010 and REQ-UG-ADULTS-ONLY-18-PLUS-20261012: records the caller''s own clickwrap acceptance and 18-or-older attestation after a published material change. Self only; refuses without the attestation; idempotent for the same organization, pack and source.';

revoke all on function public.record_invitation_legal_acceptance(uuid, jsonb, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.record_legal_acceptance(jsonb, boolean)
  from public, anon, authenticated, service_role;

grant execute on function public.record_invitation_legal_acceptance(uuid, jsonb, boolean) to service_role;
grant execute on function public.record_legal_acceptance(jsonb, boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
