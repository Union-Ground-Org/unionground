-- Restrictive MFA floor for steward_contact_preferences.
--
-- The mfa_assurance restrictive policy is applied to every RLS table by a DO
-- loop at migration time, so a table created by a later migration silently
-- lacks it. 20260924170200 created steward_contact_preferences after that loop
-- and never added the policy; the verify:db catalog sweep reports it. This adds
-- the same restrictive floor the org-structure tables carry. The table still
-- has no client grant; the policy keeps the self-only read policy MFA-gated if
-- a grant is ever added.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create policy mfa_assurance on public.steward_contact_preferences
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.steward_contact_preferences is
  'Restrictive MFA floor for every authenticated session; direct grants are revoked, so a steward''s contact visibility reaches a caller only through a security-definer RPC.';

commit;
