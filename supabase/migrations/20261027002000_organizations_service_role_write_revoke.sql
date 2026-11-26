-- BUG-UG-ORGANIZATIONS-HOSTED-SERVICE-ROLE-ACL-DRIFT-20261026
-- Production's public.organizations ACL carries service_role=arwdDxtm from the
-- hosted default ACL (postgres in public: service_role=arwdDxtm), while a fresh
-- replay leaves service_role without INSERT, UPDATE or DELETE (the organization
-- foundation revoked the client roles and never granted service_role a write;
-- 20261023050341 adds only SELECT). No application path writes the table as
-- service_role: creation, status and designation changes run through
-- SECURITY DEFINER RPCs or operator SQL, and the bot removal ledger deletes as
-- the maintenance role. Revoking the three write privileges makes the hosted
-- ACL match the exact fresh contract; the statement is a no-op on a fresh
-- replay and leaves SELECT, REFERENCES, TRIGGER, TRUNCATE and MAINTAIN alone.
-- Evidence: the operator runbook
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
revoke insert, update, delete on table public.organizations from service_role;
commit;
