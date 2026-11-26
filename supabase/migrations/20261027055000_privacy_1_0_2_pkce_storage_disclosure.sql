begin;

-- DEBT-UG-SUPABASE-JS-2118-PKCE-FLOW-ADOPTION-20261026: publish the
-- nonmaterial PKCE storage disclosure revision without rewriting accepted
-- history. The maintainers sequence hosted SAMPLE/Production application and the web
-- publication; legal_acceptance_pack_ready keeps mismatched packs closed.
-- The predecessor is the terms 1.0.1 validator (20261023174600), which
-- already carries privacy 1.0.1; this keeps terms 1.0.1 and moves only
-- privacy to 1.0.2. Refuse an unexpected predecessor rather than overwrite
-- a newer policy.
do $previous_pack$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('private.legal_acceptance_versions(jsonb)')
      and pg_catalog.md5(p.prosrc) = 'e18049abbfaa54413841aff0761e1059'
      and not p.prosecdef and p.provolatile = 'i'
  ) then
    raise exception 'privacy 1.0.2 requires the reviewed terms 1.0.1 validator' using errcode = '55000';
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
  -- regression pins this database authority to the rendered pack.
  if p_versions <> '{"privacy-policy":"1.0.2","terms-of-use":"1.0.1","accessibility-statement":"1.0.0","ai-disclosure":"1.0.0","retention-schedule":"1.0.0"}'::jsonb then
    raise exception 'legal versions not current' using errcode = '22023';
  end if;
  return p_versions;
end;
$function$;

revoke all on function private.legal_acceptance_versions(jsonb)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
