begin;

-- OPS-UG-POSTHOG-ANALYTICS-ON-MEMBER-PRODUCT-AND-PUBLIC-PAGES-20261027
-- (#6247): publish the material privacy 1.2.0 revision for PostHog product
-- analytics on the member product (a project decision, October 28, 2026: on by
-- default, where the accepted 1.1.0 text excluded authenticated sessions), so
-- every member who accepted 1.1.0 is asked again, without rewriting accepted
-- history. The maintainers sequence hosted SAMPLE/Production application and the web
-- publication; legal_acceptance_pack_ready keeps mismatched packs closed.
-- The predecessor is the Compass training 1.1.0 validator (20261027060200);
-- this keeps terms, AI disclosure and retention at 1.1.0 and moves only
-- privacy to 1.2.0. Refuse an unexpected predecessor rather than overwrite a
-- newer policy.
do $previous_pack$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('private.legal_acceptance_versions(jsonb)')
      and pg_catalog.md5(p.prosrc) = 'f0a11b49096850a1d42ba1976f907379'
      and not p.prosecdef and p.provolatile = 'i'
  ) then
    raise exception 'privacy 1.2.0 requires the reviewed Compass training 1.1.0 validator' using errcode = '55000';
  end if;
end;
$previous_pack$;

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
  if p_versions <> '{"privacy-policy":"1.2.0","terms-of-use":"1.1.0","accessibility-statement":"1.0.0","ai-disclosure":"1.1.0","retention-schedule":"1.1.0"}'::jsonb then
    raise exception 'legal versions not current' using errcode = '22023';
  end if;
  return p_versions;
end;
$function$;

revoke all on function private.legal_acceptance_versions(jsonb)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
