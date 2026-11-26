-- Founder and SCIM invitation delivery look up the organization display name
-- with the server's service-role token. The organization foundation granted
-- authenticated SELECT but relied on hosted defaults for service_role; a
-- fresh replay has no such default grant. BYPASSRLS does not grant SQL access.
-- Match the existing hosted table-wide SELECT grant. This is idempotent and
-- preserves other hosted grants and all client grants/RLS policies.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

grant select on table public.organizations to service_role;

notify pgrst, 'reload schema';
commit;
