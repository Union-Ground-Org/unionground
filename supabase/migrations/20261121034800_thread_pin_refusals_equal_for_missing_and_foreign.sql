-- SEC-UG-THREAD-PIN-REVEALS-ANOTHER-CHAPTERS-THREAD-20261115 (#8901).
--
-- public.set_chapter_thread_pinned read the thread by id with a row lock
-- before any access check. A missing id was refused P0002 "thread
-- unavailable"; another chapter's or another organization's live thread went
-- on to private.assert_space_manager and was refused 42501 "staff role
-- required" (a caller who is not staff) or 22023 "space unavailable" (staff of
-- another chapter). A caller given that thread's id could tell that it exists,
-- and could wait on its row lock to learn the same.
--
-- The staff role is now checked first, so a caller who is not staff is
-- refused 42501 "staff role required" whatever the id. The thread is then read
-- joined to a live space of the caller's chapter, without a lock: a missing
-- thread and a thread the caller may not manage are refused alike, P0002
-- "thread unavailable". Only then is the row locked, and the same check runs
-- again on the locked row. private.assert_space_manager still runs after it,
-- as before. Nothing else in the body changes; the predecessor body is guarded
-- below. A thread in an archived space of the caller's own chapter is now
-- refused "thread unavailable" too (it was "space unavailable").

begin;

-- The hosted runner applies this file under an empty search_path, where
-- pg_get_functiondef writes the public return types as public.*; the guard's
-- md5 was read with public on the path. The function keeps its own empty
-- search_path.
set local search_path = pg_catalog, public;

-- The re-emitted function must still be the reviewed live body.
do $predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.set_chapter_thread_pinned(uuid, boolean)'))) is distinct from 'e888652ff9e35eb23cdbdb76b5e60ff1' then
    raise exception 'unreviewed predecessor: public.set_chapter_thread_pinned' using errcode = '55000';
  end if;
end;
$predecessors$;

create or replace function public.set_chapter_thread_pinned(p_thread_id uuid, p_pinned boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  target public.chapter_threads%rowtype;
  space public.chapter_spaces%rowtype;
  org uuid;
  pinned_count integer;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_pinned is null then
    raise exception 'pin choice required' using errcode = '22023';
  end if;
  -- #8901: the staff role first, then the thread in a live space of the
  -- caller's chapter, read without a lock, so a missing thread and another
  -- chapter's or organization's thread are refused alike and no other
  -- chapter's row is locked or waited on.
  if not public.member_has_role(array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select t.* into target
  from public.chapter_threads t
  join public.chapter_spaces s on s.id = t.space_id
  where t.id = p_thread_id
    and s.chapter_id = private.current_member_chapter()
    and s.archived_at is null;
  if target.id is null then
    raise exception 'thread unavailable' using errcode = 'P0002';
  end if;
  -- Lock the row, then check again on the locked row.
  select t.* into target
  from public.chapter_threads t
  where t.id = target.id
    and exists (
      select 1 from public.chapter_spaces s
      where s.id = t.space_id
        and s.chapter_id = private.current_member_chapter()
        and s.archived_at is null)
  for update of t;
  if target.id is null then
    raise exception 'thread unavailable' using errcode = 'P0002';
  end if;
  -- Staff of the channel's own chapter only; same gate as space management.
  space := private.assert_space_manager(target.space_id);
  select c.organization_id into org from public.chapters c where c.id = space.chapter_id;
  if not private.organization_feature_enabled(org, 'features.messaging.channel_pinning') then
    perform private.raise_channel_control_disabled('Thread pinning');
  end if;
  if p_pinned and target.pinned_at is null then
    select pg_catalog.count(*)::integer into pinned_count
    from public.chapter_threads t
    where t.space_id = target.space_id and t.pinned_at is not null;
    if pinned_count >= 10 then
      raise exception 'a channel pins at most 10 threads' using errcode = '22023';
    end if;
  end if;
  update public.chapter_threads t
  set pinned_at = case when p_pinned then coalesce(t.pinned_at, pg_catalog.now()) end
  where t.id = target.id
  returning * into target;
  return pg_catalog.jsonb_build_object('threadId', target.id, 'spaceId', target.space_id, 'pinnedAt', target.pinned_at);
end;
end;
$function$;

commit;
