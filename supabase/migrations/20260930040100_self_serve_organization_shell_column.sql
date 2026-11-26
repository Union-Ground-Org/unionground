-- SEC-UG-OPEN-SIGNUP-TENANT-BOUNDARY-20260925
--
-- Self-created organizations start unverified and walled off: the column
-- addition only.
--
-- The verification state on public.organizations (self_serve_created_at,
-- verified_at and the check that verified_at needs a self-created
-- organization) ships alone in this short transaction, so the ACCESS
-- EXCLUSIVE lock that ALTER TABLE takes on public.organizations is released
-- at this commit and is not held while 20260930040200 runs the account
-- lifecycle trigger scans. The column comments and everything else ship in
-- 20260930040200_self_serve_organization_shell.sql, which applies next.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- Verification state
-- ---------------------------------------------------------------------------

alter table public.organizations
  add column self_serve_created_at timestamptz,
  add column verified_at timestamptz,
  add constraint organizations_verification_state
    check (verified_at is null or self_serve_created_at is not null);

commit;
