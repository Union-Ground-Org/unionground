begin;

-- FIX-UG-FREE-PILOT-TERMS-PARITY-20261022: terms 1.0.1
-- clarifies the existing free invitation-only organization pilot. Nonmaterial:
-- existing acceptance rows remain intact and no re-acceptance is required.
-- New invitation/sign-in acceptances must name the exact displayed revision.
-- The version-aware readiness probe refuses mismatched site/database packs
-- before invitation side effects. The maintainers coordinate the hosted publication
-- window in D1 stamp order; no other validator behavior or grants change.

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
  if p_versions <> '{"privacy-policy":"1.0.1","terms-of-use":"1.0.1","accessibility-statement":"1.0.0","ai-disclosure":"1.0.0","retention-schedule":"1.0.0"}'::jsonb then
    raise exception 'legal versions not current' using errcode = '22023';
  end if;
  return p_versions;
end;
$function$;

revoke all on function private.legal_acceptance_versions(jsonb)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
