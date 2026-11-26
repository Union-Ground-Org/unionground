-- Authorized, auditable password reissue for a provisioned member.
-- Password bytes stay in the server/provider/email boundary and never enter
-- PostgreSQL, client JSON, analytics, or application logs.

set local lock_timeout = '5s';

create table private.member_password_reissues (
  id uuid primary key default extensions.gen_random_uuid(),
  actor uuid not null references auth.users(id) on delete cascade,
  target_user uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  status text not null default 'delivering' check (status in ('delivering','completed','failed')),
  failure_code text check (failure_code is null or failure_code in ('provider_unavailable','auth_unavailable','auth_mismatch')),
  attempts integer not null default 1 check (attempts between 1 and 20),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  constraint member_password_reissues_state_complete check (
    (status = 'delivering' and failure_code is null and completed_at is null)
    or (status = 'completed' and failure_code is null and completed_at is not null)
    or (status = 'failed' and failure_code is not null and completed_at is null)
  )
);

create unique index member_password_reissues_one_live_target_idx
  on private.member_password_reissues (target_user) where status = 'delivering';
create index member_password_reissues_actor_created_idx
  on private.member_password_reissues (actor, created_at desc);
revoke all on private.member_password_reissues from public, anon, authenticated, service_role;

create function public.begin_member_password_reissue(p_target_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  operation private.member_password_reissues%rowtype;
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

  if not private.consume_member_signin_recovery_limit(
    'admin:' || caller::text, 'admin-hour', 5, interval '1 hour'
  ) or not private.consume_member_signin_recovery_limit(
    'target:' || p_target_user::text, 'target-day', 3, interval '1 day'
  ) then
    raise exception 'password reissue rate limited' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-password-reissue:' || p_target_user::text, 509));
  select * into operation from private.member_password_reissues
  where target_user = p_target_user and status = 'delivering' for update;
  if found then
    if operation.chapter_id <> chapter
       or (operation.actor <> caller
           and operation.updated_at > pg_catalog.clock_timestamp() - interval '15 minutes') then
      raise exception 'password reissue unavailable' using errcode = '42501';
    end if;
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

create function public.finalize_member_password_reissue(p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  operation private.member_password_reissues%rowtype;
begin
  select * into operation from private.member_password_reissues where id = p_operation_id for update;
  if caller is null or not private.mfa_satisfied() or not found
     or operation.actor <> caller or operation.status <> 'delivering'
     or private.current_member_chapter() <> operation.chapter_id
     or not private.member_has_chapter_role(operation.chapter_id, array['admin'])
     or not exists (
       select 1 from public.member_chapter_memberships m
       where m.user_id = operation.target_user
         and m.chapter_id = operation.chapter_id
         and m.status = 'active'
     )
     or not exists (
       select 1 from auth.users u
       where u.id = operation.target_user
         and u.raw_app_meta_data ->> 'union_ground_password_reissue_operation_id' = operation.id::text
         and u.raw_app_meta_data ->> 'union_ground_provisioning' = 'active'
         and (u.banned_until is null or u.banned_until <= pg_catalog.clock_timestamp())
     ) then
    raise exception 'password reissue unavailable' using errcode = '42501';
  end if;
  update private.member_password_reissues
  set status = 'completed', completed_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
  where id = operation.id;
  return pg_catalog.jsonb_build_object('completed', true, 'operationId', operation.id);
end;
$function$;

create function public.fail_member_password_reissue(p_operation_id uuid, p_failure_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare caller uuid := (select auth.uid()); operation private.member_password_reissues%rowtype;
begin
  if p_failure_code not in ('provider_unavailable','auth_unavailable','auth_mismatch') then
    raise exception 'invalid failure code' using errcode = '22023';
  end if;
  select * into operation from private.member_password_reissues where id = p_operation_id for update;
  if caller is null or not private.mfa_satisfied() or not found
     or operation.actor <> caller or operation.status <> 'delivering'
     or private.current_member_chapter() <> operation.chapter_id
     or not private.member_has_chapter_role(operation.chapter_id, array['admin']) then
    raise exception 'password reissue unavailable' using errcode = '42501';
  end if;
  update private.member_password_reissues
  set status = 'failed', failure_code = p_failure_code, updated_at = pg_catalog.clock_timestamp()
  where id = operation.id;
  return pg_catalog.jsonb_build_object('completed', false, 'operationId', operation.id);
end;
$function$;

revoke all on function public.begin_member_password_reissue(uuid) from public, anon, authenticated, service_role;
revoke all on function public.finalize_member_password_reissue(uuid) from public, anon, authenticated, service_role;
revoke all on function public.fail_member_password_reissue(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.begin_member_password_reissue(uuid) to authenticated;
grant execute on function public.finalize_member_password_reissue(uuid) to authenticated;
grant execute on function public.fail_member_password_reissue(uuid,text) to authenticated;

comment on table private.member_password_reissues is
  'Admin+MFA same-chapter password reissue ledger. A current same-chapter admin may take over an interrupted delivering operation after its 15-minute lease; only the current operator may finalize or fail it, and target membership is revalidated before completion. Contains no address or password value.';

notify pgrst, 'reload schema';
