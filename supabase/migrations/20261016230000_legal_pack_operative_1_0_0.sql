begin;

-- UB-PUB-04: the operative policy pack, version 1.0.0.
--
-- Owner direction of October 16, 2026, about 6:00 PM ET (retained at
-- the operator runbook
-- 20261016-go-live-before-counsel.md): the legal instruments go live now and
-- counsel reviews them after publication. src/lib/legalInstruments.js moves
-- every instrument to 1.0.0, so the one database authority for a submitted
-- version map moves with it. Nothing else changes: the shape checks, the
-- writers, the residence age rule and the stored rows of earlier versions are
-- untouched, and a row accepting 1.0.0 is held to the state rule that applies
-- from terms of use 0.3.0 (legal_acceptances_age_rule_by_terms_version).
--
-- Order matters on a hosted target: apply this after
-- 20261016170000_app_store_states_age_rule.sql and in the same window as the
-- deploy that publishes 1.0.0. Until it is applied, the website's acceptance
-- prompt shows but cannot record (it stays a dismissable card and never blocks
-- sign-in), and invitation acceptance answers acceptance-unavailable before
-- it creates anything (public.legal_acceptance_pack_ready below).
--
-- The parity regression (tests/legal-acceptance-versions-postgres.test.js)
-- replays this latest definition and refuses a stale pin.

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
  if p_versions <> '{"privacy-policy":"1.0.0","terms-of-use":"1.0.0","accessibility-statement":"1.0.0","ai-disclosure":"1.0.0","retention-schedule":"1.0.0"}'::jsonb then
    raise exception 'legal versions not current' using errcode = '22023';
  end if;
  return p_versions;
end;
$function$;

revoke all on function private.legal_acceptance_versions(jsonb)
  from public, anon, authenticated, service_role;

-- api/accept-invitation.js creates, emails and binds a new identity before it
-- can record the acceptance, so a version map the database would refuse must
-- be caught first. This probe takes the map the deployed site sends: it is
-- true only when the state-scoped writer is installed and this pin accepts
-- exactly that map. A site deployed before this migration is applied gets no
-- such function and refuses with acceptance-unavailable before any side
-- effect; so does a site whose pack differs from the database pin.
create function public.legal_acceptance_pack_ready(p_versions jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.legal_acceptance_versions(p_versions);
  return exists (
    select 1 from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::pg_catalog.regnamespace
      and p.proname = 'record_invitation_legal_acceptance'
      and pg_catalog.oidvectortypes(p.proargtypes) = 'uuid, jsonb, text, boolean'
  );
exception
  when invalid_parameter_value then
    return false;
end;
$function$;

revoke all on function public.legal_acceptance_pack_ready(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.legal_acceptance_pack_ready(jsonb) to service_role;

comment on function public.legal_acceptance_pack_ready(jsonb) is
  'UB-PUB-04: true when the state-scoped acceptance writer is installed and the pinned legal pack equals the submitted version map. Read by api/accept-invitation.js before it claims an invitation. Service role only.';

-- The previous site's probe asked only whether the writer exists. After this
-- pin no earlier pack is accepted, so a site still sending one would create,
-- email and bind an identity and then fail to record. The probe now answers
-- false: that site refuses before any side effect, and this site reads
-- public.legal_acceptance_pack_ready instead.
create or replace function public.legal_acceptance_residence_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select false;
$function$;

revoke all on function public.legal_acceptance_residence_ready() from public, anon, authenticated, service_role;
grant execute on function public.legal_acceptance_residence_ready() to service_role;

comment on function public.legal_acceptance_residence_ready() is
  'UB-PUB-04: retired readiness probe of sites older than the 1.0.0 pack; always false so such a site refuses before it claims an invitation. Current sites read public.legal_acceptance_pack_ready. Service role only.';

notify pgrst, 'reload schema';
commit;
