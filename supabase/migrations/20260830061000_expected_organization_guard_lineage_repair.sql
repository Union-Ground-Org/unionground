-- Restore the shared expected-organization guard on databases whose applied
-- migration lineage predates the historical pay-scope migration that first
-- introduced it. Later browser RPCs already call this private helper, so a
-- missing definition fails at runtime before their own authorization checks.

create or replace function private.mi1_require_expected_selected_organization(
  p_expected_organization_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if p_expected_organization_id is null
     or p_expected_organization_id is distinct from org then
    -- Preserve the historical wording because the database contract pins the
    -- deployed helper body byte-for-byte even though later domains share it.
    raise exception 'pay organization scope changed' using errcode = '42501';
  end if;

  return org;
end;
$function$;

revoke all on function private.mi1_require_expected_selected_organization(uuid)
from public, anon, authenticated, service_role;
