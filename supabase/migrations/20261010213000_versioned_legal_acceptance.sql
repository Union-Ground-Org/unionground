begin;

-- REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010.
--
-- of Saturday October 10, 2026, option (a), retained
-- verbatim at /
-- 20261010-owner-data-policy-decisions/statement.md: "versioned clickwrap at
-- invitation acceptance and at first sign-in after a material change,
-- recording version, time, user and organization; until it ships, the pack is
-- not published as operative."
--
-- src/lib/legalInstruments.js is the version source. The private validator
-- below pins its published pack at the database write boundary as well: a
-- direct authenticated RPC must not forge future agreement. A version release
-- must replace that pin in a forward migration with the shared source; the
-- parity regression refuses a release with a stale database pin. The caller
-- still sends the pack it displayed; mismatches are refused, never upgraded.
--
-- One row is one acceptance event. It holds the whole pack the clickwrap
-- showed, because D-14's re-acceptance trigger is a material change to any
-- published instrument, and the headline terms version D-08 names is kept in
-- its own column.

-- Deliberately no auth.users foreign key, on the precedent of
-- private.member_pin_attempt_state and private.member_pin_sessions
-- (20261003040000): the contract-formation record must not be a child of the
-- case graph. An account's rows are removed by the
-- after-delete trigger on public.member_profiles at the end of this file, so
-- deleting an account still removes them.
--
-- A trigger alone does not serialize an insert with a deletion: a writer that
-- read the profile before a deletion committed would insert after the cleanup
-- ran and leave a row for a deleted account. Both writers therefore enter
-- through private.lock_case_graph, the gate every account deletion and case
-- graph writer already takes (acceptances are rare, so the global gate costs
-- nothing), and hold a KEY SHARE lock on the subject's profile from the check
-- through the insert. If the writer goes first, the deletion waits and its
-- trigger then removes the new row; if the deletion goes first, the writer
-- finds no profile and records nothing.
create table private.legal_acceptances (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  chapter_id text not null,
  terms_version text not null,
  instrument_versions jsonb not null,
  source text not null check (source in ('invitation', 'signin')),
  accepted_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint legal_acceptances_terms_version_shape
    check (terms_version ~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$'),
  constraint legal_acceptances_versions_object
    check (jsonb_typeof(instrument_versions) = 'object' and instrument_versions <> '{}'::jsonb),
  -- Retries of the same organization's acceptance keep the original event.
  -- Another organization or acceptance source retains its own event, even
  -- when this person already accepted the same pack elsewhere.
  constraint legal_acceptances_event_once unique (user_id, chapter_id, instrument_versions, source)
);

create index legal_acceptances_user_recent_idx
  on private.legal_acceptances (user_id, accepted_at desc);

comment on table private.legal_acceptances is
  'REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010: one row per recorded clickwrap acceptance, with the person, their organization, the terms version, every instrument version the clickwrap showed, where it was taken and when. No client grant; written and read only by the definer functions below. Deliberately not a child of the account case graph; cleared by the after-delete trigger on public.member_profiles.';

-- Shared published-pack check for both writers. Neither caller chooses which
-- versions exist. This private function can be replaced only by a migration,
-- not by an authenticated or service-role API caller.
create function private.legal_acceptance_versions(p_versions jsonb)
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
  if p_versions <> '{"privacy-policy":"0.1.0","terms-of-use":"0.1.0","accessibility-statement":"0.1.0","ai-disclosure":"0.1.0","retention-schedule":"0.1.0"}'::jsonb then
    raise exception 'legal versions not current' using errcode = '22023';
  end if;
  return p_versions;
end;
$function$;

comment on function private.legal_acceptance_versions(jsonb) is
  'Validates a submitted instrument-version map before it becomes an acceptance row, and returns it unchanged. Raises 22023 on anything else.';

-- Invitation acceptance (api/accept-invitation.js). Service role only: the
-- route holds the invitation secret and the identity it just provisioned, and
-- no client may write an acceptance for someone else. Called after the
-- identity is bound to the invitation and before the invitation is marked
-- accepted, so an accepted invitation always has its acceptance recorded.
--
-- A reactivation invitation binds its identity inside
-- public.accept_former_member_invitation, so the route records the acceptance
-- first and the user is resolved from the invitation's own address using the
-- reactivation function's trimmed-email, deletion and ban predicates: exactly
-- one eligible live identity with that address, or nothing is written.
create function public.record_invitation_legal_acceptance(
  p_invitation_id uuid,
  p_versions jsonb
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
  -- Serialize with account deletion (see the table header): no live profile,
  -- no acceptance row.
  perform 1 from public.member_profiles p where p.id = subject for key share;
  if not found then
    raise exception 'invitation identity unavailable' using errcode = '22023';
  end if;
  insert into private.legal_acceptances
    (user_id, chapter_id, terms_version, instrument_versions, source)
  values (
    subject, invitation_row.chapter_id, versions ->> 'terms-of-use',
    versions, 'invitation'
  )
  on conflict (user_id, chapter_id, instrument_versions, source) do nothing;
  return pg_catalog.jsonb_build_object('recorded', true);
end;
$function$;

comment on function public.record_invitation_legal_acceptance(uuid, jsonb) is
  'REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010: records the clickwrap acceptance taken at invitation acceptance for the invitation''s own identity and organization. Service role only; idempotent for the same organization, pack and source.';

-- The re-acceptance prompt (web and native), taken by the signed-in person
-- for their own account and their own organization. There is no parameter for
-- the subject: auth.uid() is the only person this can ever record.
create function public.record_legal_acceptance(p_versions jsonb)
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
  versions := private.legal_acceptance_versions(p_versions);
  -- Serialize with account deletion (see the table header).
  select p.chapter_id into chapter from public.member_profiles p where p.id = caller for key share;
  if chapter is null then
    raise exception 'organization required' using errcode = '22023';
  end if;
  insert into private.legal_acceptances
    (user_id, chapter_id, terms_version, instrument_versions, source)
  values (caller, chapter, versions ->> 'terms-of-use', versions, 'signin')
  on conflict (user_id, chapter_id, instrument_versions, source) do nothing;
  return pg_catalog.jsonb_build_object('recorded', true, 'chapterId', chapter);
end;
$function$;

comment on function public.record_legal_acceptance(jsonb) is
  'REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010: records the caller''s own clickwrap acceptance after a published material change. Self only, idempotent for the same organization, pack and source.';

-- What the apps read at sign-in to decide whether to prompt: the newest
-- accepted version of each instrument for the caller, and when the newest
-- acceptance was taken. A stable self-only read, so it is safe as a boot read.
create function public.get_my_legal_acceptance_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  versions jsonb;
  accepted timestamptz;
  chapter text;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select p.chapter_id into chapter from public.member_profiles p where p.id = caller;
  select pg_catalog.jsonb_object_agg(latest.key, latest.value), pg_catalog.max(latest.accepted_at)
    into versions, accepted
  from (
    select distinct on (entry.key) entry.key, entry.value, a.accepted_at
    from private.legal_acceptances a,
      pg_catalog.jsonb_each_text(a.instrument_versions) entry
    where a.user_id = caller
    order by entry.key,
      pg_catalog.string_to_array(entry.value, '.')::integer[] desc,
      a.accepted_at desc, a.id desc
  ) latest;
  return pg_catalog.jsonb_build_object(
    'versions', coalesce(versions, '{}'::jsonb),
    'acceptedAt', accepted,
    'chapterId', chapter
  );
end;
$function$;

comment on function public.get_my_legal_acceptance_state() is
  'REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010: the caller''s own accepted instrument versions and the time of their newest acceptance. Self only; the apps show or withhold the re-acceptance prompt from it.';

-- Deleting an account removes its acceptance rows. public.member_profiles is
-- the account's own row in the reviewed case graph, so this fires inside the
-- existing deletion path rather than adding a second one.
create function private.legal_acceptance_clear_for_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  delete from private.legal_acceptances where user_id = old.id;
  return null;
end;
$function$;

create trigger legal_acceptance_clear_for_member
after delete on public.member_profiles
for each row execute function private.legal_acceptance_clear_for_member();

insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger'
    and schema_name = 'public'
    and table_name = 'member_profiles'
    and object_name = 'legal_acceptance_clear_for_member')
  or (kind = 'function'
    and schema_name = 'private'
    and table_name = ''
    and object_name = 'legal_acceptance_clear_for_member()');

alter table private.legal_acceptances enable row level security;
alter table private.legal_acceptances force row level security;
revoke all on table private.legal_acceptances from public, anon, authenticated, service_role;

revoke all on function private.legal_acceptance_versions(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.legal_acceptance_clear_for_member()
  from public, anon, authenticated, service_role;
revoke all on function public.record_invitation_legal_acceptance(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.record_legal_acceptance(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.get_my_legal_acceptance_state()
  from public, anon, authenticated, service_role;

grant execute on function public.record_invitation_legal_acceptance(uuid, jsonb) to service_role;
grant execute on function public.record_legal_acceptance(jsonb) to authenticated;
grant execute on function public.get_my_legal_acceptance_state() to authenticated;

notify pgrst, 'reload schema';
commit;
