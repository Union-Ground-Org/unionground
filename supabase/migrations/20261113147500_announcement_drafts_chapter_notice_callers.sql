-- BUG-UG-ANNOUNCEMENT-DRAFTS-SERVER-STILL-ADMITS-STEWARDS-WITHOUT-CHAPTER-NOTICES-20261115 (#8940)
--
-- Chapter announcement drafts are chapter-wide notices waiting to be sent.
-- Since #7664 no steward may send a
-- chapter-wide notice: private.chapter_notice_scope_allowed(chapter, null,
-- null) is false for every steward who is not chapter leadership. A project
-- decision of Nov 15, 2026 (#8932) holds that
-- such stewards do not get the drafts either; the chapter office panel and,
-- with #8932, the steward desk and Messages already hide them. The server
-- still admitted a steward with the #7663 carry-over mark through
-- private.member_has_chapter_role, so they could list the drafts, dismiss one
-- for every officer, or mark one published.
--
-- public.list_announcement_drafts() and public.resolve_announcement_draft(uuid,
-- text) are restated from 20261102005607 (md5-pinned below) with ONLY their
-- admission check changed: member_has_chapter_role(chapter, steward/admin/vp)
-- becomes chapter_notice_scope_allowed(chapter, null, null), alongside the
-- unchanged chapter_officer_can(chapter, 'notices'). Security mode,
-- search_path, the refusal text, the result shape and the grants (kept by
-- CREATE OR REPLACE) are unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

do $predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.list_announcement_drafts()'))) is distinct from 'cd8e452c658bddd5067df67a2675a7fe' then
    raise exception 'unreviewed predecessor: public.list_announcement_drafts' using errcode = '55000';
  end if;
  if exists (select 1 from private.account_lifecycle_trigger_review where kind = 'function' and schema_name = 'public'
      and pg_catalog.split_part(object_name, '(', 1) = 'list_announcement_drafts' and definition_hash <> 'cd8e452c658bddd5067df67a2675a7fe') then
    raise exception 'stale trigger receipt: public.list_announcement_drafts' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.resolve_announcement_draft(uuid, text)'))) is distinct from '0d2e033f29550ccc8b3a4bb69bf7902d' then
    raise exception 'unreviewed predecessor: public.resolve_announcement_draft' using errcode = '55000';
  end if;
  if exists (select 1 from private.account_lifecycle_trigger_review where kind = 'function' and schema_name = 'public'
      and pg_catalog.split_part(object_name, '(', 1) = 'resolve_announcement_draft' and definition_hash <> '0d2e033f29550ccc8b3a4bb69bf7902d') then
    raise exception 'stale trigger receipt: public.resolve_announcement_draft' using errcode = '55000';
  end if;
end;
$predecessor$;

create or replace function public.list_announcement_drafts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  rows jsonb;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  org := private.current_member_organization();
  chapter := private.current_member_chapter();
  if org is null or chapter is null or not (private.chapter_notice_scope_allowed(chapter, null, null) or private.chapter_officer_can(chapter,'notices')) then
    raise exception 'chapter steward role required' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', f.id, 'title', f.title, 'body', f.body, 'eventId', f.source_id, 'createdAt', f.created_at
    ) order by f.created_at desc, f.id), '[]'::jsonb)
    into rows
  from (
    select f.* from private.engagement_follow_ups f
    join public.member_events e on e.id = f.source_id and e.chapter_id = f.chapter_id and e.cancelled_at is null
    where f.organization_id = org and f.chapter_id = chapter
      and f.kind = 'announcement_draft' and f.state = 'draft'
    order by f.created_at desc, f.id
    limit 20
  ) f;
  return pg_catalog.jsonb_build_object('organizationId', org, 'drafts', rows);
end;
$function$;

create or replace function public.resolve_announcement_draft(p_draft_id uuid, p_state text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  actor uuid := (select auth.uid());
  org uuid;
  chapter text;
  resolved uuid;
begin
  if actor is null or not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if p_state is null or p_state not in ('published', 'dismissed') then
    raise exception 'invalid draft state' using errcode = '22023';
  end if;
  org := private.current_member_organization();
  chapter := private.current_member_chapter();
  if org is null or chapter is null or not (private.chapter_notice_scope_allowed(chapter, null, null) or private.chapter_officer_can(chapter,'notices')) then
    raise exception 'chapter steward role required' using errcode = '42501';
  end if;
  update private.engagement_follow_ups f
     set state = p_state, resolved_at = pg_catalog.now()
   where f.id = p_draft_id and f.organization_id = org and f.chapter_id = chapter
     and f.kind = 'announcement_draft' and f.state = 'draft'
  returning f.id into resolved;
  if resolved is null then
    raise exception 'draft unavailable' using errcode = '22023';
  end if;
  perform private.cr108_record_audit(
    org, 'announcement_draft_resolved', 'update', 'broadcast', resolved::text, actor,
    pg_catalog.jsonb_build_object('status', p_state), extensions.gen_random_uuid()
  );
  return pg_catalog.jsonb_build_object('organizationId', org, 'id', resolved, 'state', p_state);
end;
end;
$function$;

-- Reviewed call-graph change (account lifecycle inventory): the two restated
-- functions keep their receipts, refreshed to the new definitions.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and schema_name = 'public'
  and pg_catalog.split_part(object_name, '(', 1) in ('list_announcement_drafts', 'resolve_announcement_draft')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

notify pgrst, 'reload schema';

commit;
