-- DEBT-UG-DUES-STRIPE-TEST-ACCOUNT-HELPER-OMITS-MFA-AND-IDENTITY-20260921:
-- public.read_dues_stripe_account_for_test is the only dues routine that takes
-- an explicit (organization_id, requested_by, selected_hat) triple and
-- authorizes it against a raw role grant. Every sibling on the same request
-- goes through private.dues_require_financial_hat, which also requires a
-- matching private.dues_financial_identity_selections row -- the server-
-- assigned financial identity the dual-grant rule depends on. A member holding
-- both the admin and the vp grant has no auto-provisioned selection, so today
-- this helper would hand a live connected-account id to an identity its own
-- sibling refuses. Re-emit the function with that exists() so it can never
-- authorize more than the get_dues_provider_status call that precedes it.
--
-- private.mfa_satisfied() is deliberately NOT added here. It reads the CALLER's
-- JWT (auth.uid(), session_id, aal), and this routine is service_role-only:
-- under a service-role JWT auth.uid() is null, so the predicate is false for
-- every invocation and the check would refuse the one production caller,
-- api/dues-stripe-connect.js, outright. The MFA term for this request is
-- enforced upstream, in the same request, by get_dues_provider_status ->
-- private.dues_require_financial_hat against the member's own session. A
-- delegated assurance check for p_requested_by has no primitive in this schema
-- and is out of scope for this repair.
--
-- No table, constraint, policy or grant semantics change here; the grants are
-- re-stated at their existing values so the service-only boundary is visible
-- in the file that last defines the routine.

begin;

set local lock_timeout = '5s';

-- 20260831223000 is the only definition of this routine in the tree and
-- 20260907151000 did not wrap it, so its inner source is the sole predecessor
-- this repair may supersede. Fail closed on anything else.
do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.read_dues_stripe_account_for_test(uuid, uuid, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '93ca879324f5e8ed1f2ca87291625ae04f2e35b6b8c1ea1498c7a827c1d1fc92' then
    raise exception 'unreviewed read_dues_stripe_account_for_test predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

create or replace function public.read_dues_stripe_account_for_test(
  p_organization_id uuid,
  p_requested_by uuid,
  p_selected_hat text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  account_id text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_organization_id is null
     or p_requested_by is null
     or p_selected_hat not in ('admin', 'vp') then
    raise exception 'dues Stripe readiness test refused' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    join public.organization_role_grants role_grant
      on role_grant.organization_id = membership.organization_id
     and role_grant.user_id = membership.user_id
     and role_grant.role = p_selected_hat
    where membership.organization_id = p_organization_id
      and membership.user_id = p_requested_by
      and membership.status = 'active'
  ) then
    raise exception 'dues Stripe readiness context unavailable' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from private.dues_financial_identity_selections selection
    where selection.organization_id = p_organization_id
      and selection.user_id = p_requested_by
      and selection.selected_hat = p_selected_hat
  ) then
    raise exception 'dues Stripe readiness financial identity unavailable' using errcode = '42501';
  end if;
  select connection.stripe_account_id into account_id
  from public.dues_provider_connections connection
  where connection.organization_id = p_organization_id
    and connection.state = 'ready';
  if account_id is null or account_id !~ '^[A-Za-z0-9_:-]{3,255}$' then
    raise exception 'dues Stripe readiness account unavailable' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object('accountId', account_id);
end;
$function$;

revoke all on function public.read_dues_stripe_account_for_test(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.read_dues_stripe_account_for_test(uuid, uuid, text) to service_role;

comment on function public.read_dues_stripe_account_for_test(uuid, uuid, text) is
  'Returns the connected account only to the server after an authenticated exact-hat readiness authorization: active membership, the matching organization role grant, and the server-assigned private.dues_financial_identity_selections row for the same (organization, user, hat), so this routine can never authorize more than the get_dues_provider_status call that precedes it on the same request.';

do $ledger$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.read_dues_stripe_account_for_test(uuid, uuid, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'e24b4681feab762e4e581307142a1f808a7dbbc02abadb8813bbf0cbd729db66' then
    raise exception 'read_dues_stripe_account_for_test source hash drifted: %', digest
      using errcode = '55000';
  end if;
end;
$ledger$;

notify pgrst, 'reload schema';

commit;
