-- BUG-UG-ADMIN-SESSION-REVOKE-ENDPOINT-20261003
--
-- Admin password reissue, admin sign-in address recovery and admin MFA reset
-- each end the member's sessions before changing their credential. They did it
-- by calling POST /auth/v1/admin/users/{id}/logout, which Supabase Auth does
-- not have (its admin user routes are read, update and delete; logout exists
-- only for the caller's own session). Every call answered 404, so all three
-- recoveries failed on production after their authorization succeeded.
--
-- public.end_member_auth_sessions ends every Auth session of one account the
-- way SCIM deprovisioning and the PIN session boundary already do: deleting
-- the auth.sessions rows revokes their refresh tokens, and
-- private.mfa_satisfied() refuses the remaining access tokens because their
-- session row is gone. It also clears the account's PIN session markers.
-- Service role only; the calling routes authorize the admin first.
--
-- Hosted application: SAMPLE first, then production.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function public.end_member_auth_sessions(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'account required' using errcode = '22023';
  end if;
  delete from auth.sessions s where s.user_id = p_user_id;
  delete from private.member_pin_sessions m where m.user_id = p_user_id;
  return pg_catalog.jsonb_build_object('ended', true);
end;
$function$;

revoke all on function public.end_member_auth_sessions(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.end_member_auth_sessions(uuid) to service_role;

comment on function public.end_member_auth_sessions(uuid) is
  'Service-role session revocation for admin password reissue, sign-in address recovery and MFA reset: deletes every auth.sessions row of the account (revoking its refresh tokens; mfa_satisfied refuses the remaining access tokens) and its PIN session markers. Graph gate, then the exclusive Auth bookkeeping lock.';

notify pgrst, 'reload schema';

commit;
