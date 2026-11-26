-- Serialize password-reissue provider work across serverless invocations.
-- Known failures are marked failed by the API and may retry immediately with a
-- fresh operation. An outcome-unknown invocation retains this 15-minute lease
-- so a concurrent request cannot stage and email a competing credential.

set local lock_timeout = '5s';

create or replace function public.begin_member_password_reissue(p_target_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  operation private.member_password_reissues%rowtype;
  live_operation_found boolean := false;
begin
  if caller is null or not private.mfa_satisfied()
     or not private.member_has_chapter_role(chapter, array['admin'])
     or p_target_user is null or p_target_user = caller
     or not exists (
       select 1 from public.member_chapter_memberships m
       where m.user_id = p_target_user and m.chapter_id = chapter and m.status = 'active'
     ) then
    raise exception 'password reissue unavailable' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-password-reissue:' || p_target_user::text, 509));
  select * into operation from private.member_password_reissues
  where target_user = p_target_user and status = 'delivering' for update;
  live_operation_found := found;

  if live_operation_found and operation.chapter_id <> chapter then
    raise exception 'password reissue unavailable' using errcode = '42501';
  end if;

  if live_operation_found
     and operation.updated_at > pg_catalog.clock_timestamp() - interval '15 minutes' then
    raise exception 'password reissue already in progress' using errcode = 'P0001';
  end if;

  if not private.consume_member_signin_recovery_limit(
    'admin:' || caller::text, 'admin-hour', 5, interval '1 hour'
  ) then
    raise exception 'password reissue rate limited' using errcode = 'P0001';
  end if;

  -- A stale operation already consumed the target's daily allowance when it
  -- was created. Taking over that lease must not consume another target slot,
  -- or three provider failures could prevent the required recovery attempt.
  if not live_operation_found and not private.consume_member_signin_recovery_limit(
    'target:' || p_target_user::text, 'target-day', 3, interval '1 day'
  ) then
    raise exception 'password reissue rate limited' using errcode = 'P0001';
  end if;

  if live_operation_found then
    update private.member_password_reissues
    set actor = caller, attempts = least(attempts + 1, 20), updated_at = pg_catalog.clock_timestamp()
    where id = operation.id;
    return pg_catalog.jsonb_build_object('accepted', true, 'operationId', operation.id, 'retry', true);
  end if;

  insert into private.member_password_reissues (actor, target_user, chapter_id)
  values (caller, p_target_user, chapter) returning * into operation;
  return pg_catalog.jsonb_build_object('accepted', true, 'operationId', operation.id, 'retry', false);
end;
$function$;

revoke all on function public.begin_member_password_reissue(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_member_password_reissue(uuid) to authenticated;

comment on function public.begin_member_password_reissue(uuid) is
  'Begins an MFA-gated same-chapter password reissue. A live provider attempt is serialized for 15 minutes; known failures release the target through the audited failed state.';

notify pgrst, 'reload schema';
