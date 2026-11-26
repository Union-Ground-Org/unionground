-- REQ-UG-TASKS-WORKSTREAM-ASSIGNEES-DUE-DATES-20261030
--
-- Finding 57 of the October 29-30 role-play run: in a chapter created after
-- 20260728221223, no task could be created. That migration seeded a
-- "General" workstream once, for the chapters that existed then; every task
-- must name one of its chapter's workstreams (private.assert_chapter_workstream,
-- and create_chapter_task_from_template's own check), and nothing gives a
-- newer chapter its first one. Members cannot add workstreams, so their Tasks
-- form offered only "—" and refused every save.
--
-- public.ensure_chapter_default_workstream() gives the caller's chapter the
-- same "General" workstream, only when it has none, and answers with the
-- chapter's list. It is a no-op once any workstream exists, so it can never
-- add a second list entry or undo a staff rename; the merge flow already
-- refuses to remove a chapter's last workstream. No trigger on chapters: a
-- row created there would outlive seed removal, whose chapter delete is
-- restricted by chapter_workstreams.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function public.ensure_chapter_default_workstream()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  caller_chapter text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'chapter required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('chapter_workstreams:default:' || caller_chapter, 509));
  if not exists (select 1 from public.chapter_workstreams w where w.chapter_id = caller_chapter) then
    insert into public.chapter_workstreams (chapter_id, name, created_by)
    values (caller_chapter, 'General', null)
    on conflict (chapter_id, name) do nothing;
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', w.id, 'name', w.name) order by w.name, w.id)
    from public.chapter_workstreams w
    where w.chapter_id = caller_chapter
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.ensure_chapter_default_workstream() from public, anon, authenticated, service_role;
grant execute on function public.ensure_chapter_default_workstream() to authenticated;

comment on function public.ensure_chapter_default_workstream() is
  'Gives the caller''s chapter its first workstream, General, when it has none (chapters created after 20260728221223 had none, so no task could be created), and answers with the chapter''s workstream list. A no-op once any workstream exists.';

notify pgrst, 'reload schema';

commit;
