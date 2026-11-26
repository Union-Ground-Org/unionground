-- An admin-assisted TOTP reset must invalidate access tokens immediately.
-- Deleting factors alone does the opposite: an already-issued aal1/aal2 token
-- becomes admissible when private.mfa_satisfied() sees no remaining factor.
-- GoTrue session logout revokes refresh tokens, not already-issued access JWTs.
--
-- Reconciled with the current schema on 2026-10-14. The July version of this
-- file (as 20260724094500, extended by 20260724103000) solved this with its
-- own design: private.unionground_member_security_epochs, a
-- private.mfa_satisfied() that rejected tokens by JWT iat, a two-step
-- begin_mfa_reset(uuid, uuid) / complete_mfa_reset(uuid, uuid) command pair,
-- and a narrowed member_admin_audit action list. The shared schema has since
-- built the same protection another way, and the web client and
-- api/admin-mfa-reset.js now follow that flow, so the July design is not
-- created:
--
--   * public.begin_mfa_reset(uuid) (tenant-scoped: caller must be an admin of
--     the target's organization or chapter) writes
--     private.member_mfa_reset_boundaries.invalid_before, never moving it
--     backward, records closing barriers for every live session, releases
--     recovery locks, and removes push installations.
--   * private.mfa_satisfied() refuses any token whose session_id is not a
--     live auth.sessions row created after that boundary. That is stronger
--     than the July iat check: a token issued in the reset second, or for a
--     session already deleted, is refused too.
--
-- Not created, and why:
--   * private.unionground_member_security_epochs and the July
--     private.mfa_satisfied(): replacing the current predicate would drop
--     its session, recovery-lock and passkey checks.
--   * public.begin_mfa_reset(uuid, uuid) and public.complete_mfa_reset(uuid,
--     uuid): no client calls them, and they would keep a second reset entry
--     point alive with the July authorization (member_profiles.chapter_id
--     plus legacy member_roles), outside the shared tenant scope.
--   * The member_admin_audit action list: the July list had six actions and
--     would reject about thirty that the schema writes today.
--   * The existing record_mfa_reset(uuid, integer), authorize_mfa_reset,
--     rotate_calendar_feed_token and upsert_push_subscription are not
--     overwritten.
--
-- Kept from the July design, additively: a reset also revokes the member's
-- calendar feed token. The feed URL is a bearer capability that outlives
-- every session, and the current reset does not touch it. The trigger
-- fires only when invalid_before is written, so the reset-notice
-- bookkeeping updates on the same row do not revoke anything.

create function private.unionground_revoke_capabilities_on_mfa_reset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Union Ground's account case graph gate comes first (20261014012000).
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  delete from public.member_calendar_feed_tokens
  where user_id = new.user_id;
  return new;
end;
$$;

revoke all on function private.unionground_revoke_capabilities_on_mfa_reset()
  from public, anon, authenticated, service_role;

create trigger unionground_mfa_reset_revokes_calendar_feed
  after insert or update of invalid_before on private.member_mfa_reset_boundaries
  for each row execute function private.unionground_revoke_capabilities_on_mfa_reset();

-- Fail the migration, rather than ship a silent gap, if the installed
-- protection is not what this file relies on.
do $$
declare
  predicate text := pg_catalog.pg_get_functiondef('private.mfa_satisfied()'::regprocedure);
begin
  if pg_catalog.to_regclass('private.member_mfa_reset_boundaries') is null
     or pg_catalog.strpos(predicate, 'private.member_mfa_reset_boundaries') = 0
     or pg_catalog.strpos(predicate, 'auth.sessions') = 0
     or pg_catalog.to_regprocedure('public.begin_mfa_reset(uuid)') is null then
    raise exception 'Union Ground MFA reset boundary is missing; Union Ground relies on it';
  end if;
  if pg_catalog.to_regprocedure('public.begin_mfa_reset(uuid, uuid)') is not null
     or pg_catalog.to_regprocedure('public.complete_mfa_reset(uuid, uuid)') is not null
     or pg_catalog.to_regclass('private.unionground_member_security_epochs') is not null then
    raise exception 'a second MFA reset path exists; remove it before applying';
  end if;
end
$$;
