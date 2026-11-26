-- Restore the narrow EXECUTE path required by authenticated RLS policies.
-- These helpers remain SECURITY DEFINER with an empty search_path; exposing
-- only the functions referenced directly by policies avoids widening access
-- to their internal member-ownership and MFA primitives.

revoke all on function private.casework_staff_can_access(uuid) from public, anon, service_role;
revoke all on function private.casework_can_read(uuid) from public, anon, service_role;
revoke all on function private.casework_scope_matches(uuid, uuid, text) from public, anon, service_role;

grant execute on function private.casework_staff_can_access(uuid) to authenticated;
grant execute on function private.casework_can_read(uuid) to authenticated;
grant execute on function private.casework_scope_matches(uuid, uuid, text) to authenticated;
