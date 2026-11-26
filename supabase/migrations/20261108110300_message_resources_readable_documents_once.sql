-- BUG-UG-MESSAGE-RESOURCES-POLICY-CHECKS-EVERY-ROW-20261108 (#7501).
-- The web shell reads public.member_message_resources with no filter on every
-- load and every demo role switch (src/lib/memberApi.js), so
-- member_message_resources_read decides its cost. The policy ran
-- private.current_actor_can_read_message_source for every row in the table,
-- and every call re-planned private.can_read_message_source and the
-- permission functions it calls: 130 ms for 149 rows on a local Tamarack
-- stack, 0.7 to 0.9 s on SAMPLE (141 rows) for 0 to 7 rows returned, and
-- 1.7 s inside a demo role switch.
--
-- The policy now tests a necessary condition first, resolved once per
-- statement: private.caller_published_chapter_document_ids() is the ids of
-- the published documents in the caller's profile chapter. The unchanged
-- per-row checks run only for rows whose document is in that set.
-- private.actor_can_read_document(actor, document), which the policy's
-- second check calls with the caller, is true only for a published document
-- whose chapter is the actor's profile chapter, so every row the policy
-- admitted before is in the set, and the policy admits exactly the rows it
-- admitted before. The per-row checks, the functions and the other policies
-- on the table are untouched.
--
-- The preflight refuses to run unless the predecessor policy and the two
-- document functions are exactly the ones the reviewed migrations installed.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- pg_get_expr qualifies every non-catalog name under this path, exactly as
-- under an empty one (pg_catalog is always searched), so the md5 is stable.
set local search_path = pg_catalog;

do $preflight$
begin
  if (select pg_catalog.md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid)) from pg_catalog.pg_policy p
      where p.polrelid = 'public.member_message_resources'::regclass and p.polname = 'member_message_resources_read'
        and p.polpermissive and p.polcmd = 'r') is distinct from '05a76baa103854514e654195a585498d' then
    raise exception 'unreviewed predecessor: member_message_resources_read' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'private.current_actor_can_read_document(uuid)'::regprocedure)
      is distinct from '37fd975c9625f95447f25725b50ed17e' then
    raise exception 'unreviewed predecessor: private.current_actor_can_read_document' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'private.actor_can_read_document(uuid,uuid)'::regprocedure)
      is distinct from '2e3a804dd021ca6ac10f82063f4bd408' then
    raise exception 'unreviewed predecessor: private.actor_can_read_document' using errcode = '55000';
  end if;
end;
$preflight$;

create function private.caller_published_chapter_document_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.array_agg(document.id), '{}'::uuid[])
  from public.chapter_documents document
  where document.status = 'published'
    and document.chapter_id = (
      select profile.chapter_id
      from public.member_profiles profile
      where profile.id = (select auth.uid()));
$function$;

revoke all on function private.caller_published_chapter_document_ids() from public, anon, authenticated, service_role;
grant execute on function private.caller_published_chapter_document_ids() to authenticated;

comment on function private.caller_published_chapter_document_ids() is
  'The ids of the published documents in the caller''s profile chapter: a necessary condition of private.actor_can_read_document for the caller. member_message_resources_read resolves it once per statement before its per-row checks.';

drop policy member_message_resources_read on public.member_message_resources;
create policy member_message_resources_read on public.member_message_resources
  for select to authenticated using (
    document_id = any ((select private.caller_published_chapter_document_ids())::uuid[])
    and private.current_actor_can_read_message_source('private', message_id, null, null)
    and private.current_actor_can_read_document(document_id)
  );

comment on policy member_message_resources_read on public.member_message_resources is
  'A resource on a private message the caller can read, pointing at a document the caller can read. The caller''s published chapter documents (private.caller_published_chapter_document_ids) resolve once per statement, so the per-row checks run only for rows that can pass them.';

commit;
