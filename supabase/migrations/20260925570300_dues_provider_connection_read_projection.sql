-- SEC-UG-DUES-PROVIDER-CONNECTION-READ-PROJECTION-20260921
--
-- public.get_dues_provider_status is the reviewed read projection for a dues
-- provider connection: it opens with private.dues_require_financial_hat and
-- returns organizationId, state, checkoutAvailable, accountLabel and attention
-- only. The base table also carried a direct client read — `grant select ... to
-- authenticated` plus the organization-wide permissive policy
-- dues_provider_connections_own_select — so the projection's own withholding
-- decided nothing: the row behind it, including the connected account
-- identifier and the payout flags, was readable by any authenticated member of
-- the organization, financial hat or not.
--
-- Nothing reads the base table through the Data API. Every repository read
-- either goes through the projection or runs inside a SECURITY DEFINER routine
-- that owns the table. Remove the direct read and leave the projection as the
-- only path; service_role and the definer routines are unaffected.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

revoke all on public.dues_provider_connections from public, anon, authenticated;

drop policy if exists dues_provider_connections_own_select on public.dues_provider_connections;

notify pgrst, 'reload schema';

commit;
