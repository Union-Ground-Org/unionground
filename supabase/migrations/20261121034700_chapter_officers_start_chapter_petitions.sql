-- BUG-UG-CHAPTER-PRESIDENT-CANNOT-START-A-PETITION-20261118 (#9166).
-- public.save_digital_action accepted only organization-wide grants
-- (private.has_organization_role), so a President, Admin, Coordinator, Advisor
-- or Steward granted for one chapter could not start, edit, publish or close a
-- petition (or any collective action) for that chapter, while votes, surveys,
-- notices, meetings and tasks accept the chapter grant.
--
-- Chapter grants now follow the votes rule (private.can_manage_vote_scope and
-- private.can_read_vote_campaign):
--   * save_digital_action: when the selected hat has no organization-wide
--     grant, a grant for the caller's selected chapter
--     (private.member_has_chapter_role, which drops a steward limited to a
--     unit, #8941) writes an action of that chapter only. An edit under it
--     needs the stored action to be in that chapter already; advisor, admin
--     and vp edit any action of the chapter, steward and coordinator their
--     own. Organization-wide and other-chapter actions stay refused.
--   * get_collective_actions: a chapter manager sees its chapter's drafts and
--     viewerCanEdit under the same rule; the response adds manageScope
--     ('organization' | 'chapter' | null) and manageChapterId so clients gate
--     on the server. A chapter-tagged action is listed only for members whose
--     selected chapter is that chapter, and for anyone who already joined it
--     (they still see their participation and can withdraw).
--   * toggle_digital_action_participation: joining a chapter-tagged action
--     needs that selected chapter, and withdrawing from one needs the
--     caller's own participation row; otherwise it is refused like an
--     unknown id, before any status or count.
--   * One definition, private.digital_action_join_allowed, decides the join,
--     the read reach and the per-action viewerCanJoin; get_collective_actions
--     also returns authoringHats (the hats that really manage actions here).
-- Organization managers wearing a manager hat, and organization-wide actions
-- (chapter_id null), keep today's behaviour exactly. The participant export
-- and the goal breakdown stay organization-only.
--
-- ASSUMPTION TO READ BEFORE THE APPLY: the website and phone clients have
-- only ever saved organization-wide actions (both send p_chapter_id null), so
-- the read narrowing is expected to touch only the SAMPLE demo seed's
-- chapter-tagged actions. This rests on client code, not on a database read.
-- The database lane's before-read counts
--   select pg_catalog.count(*) from public.digital_actions where chapter_id is not null;
-- on SAMPLE and on Production. A non-zero Production count stops the apply
-- for a project decision.
--
-- Each function is re-emitted from its live definition (save_digital_action
-- from 20260925110600, the other two from 20261028080000) with only the
-- role and reach lines changed; security definer, search_path, the case-graph
-- lock prologue, grants and the reviewed lifecycle rows are kept.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog, public, extensions;

do $predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.save_digital_action(text,uuid,text,text,text,text,text,integer,timestamp with time zone,timestamp with time zone)'))) is distinct from 'fdcdb1f972ff114e326241ef4e3e49b8' then
    raise exception 'unreviewed predecessor: public.save_digital_action' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_collective_actions(text,integer,integer)'))) is distinct from 'eec66cf10efc4cede56b7cfa86243b84' then
    raise exception 'unreviewed predecessor: public.get_collective_actions' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.toggle_digital_action_participation(uuid,text,boolean)'))) is distinct from 'ad2910bc0d84a113a8a0689e45e19b97' then
    raise exception 'unreviewed predecessor: public.toggle_digital_action_participation' using errcode = '55000';
  end if;
end;
$predecessors$;

-- One definition of who may join, and read, a collective action outside the
-- managers' view: an organization-wide action (chapter null) is for every
-- member of the organization; a chapter-tagged action only for members whose
-- selected chapter is that chapter (the private.can_read_vote_campaign rule).
create function private.digital_action_join_allowed(p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_chapter_id is null
    or coalesce(p_chapter_id = private.current_member_chapter(), false);
$function$;

revoke all on function private.digital_action_join_allowed(text) from public, anon, authenticated, service_role;
comment on function private.digital_action_join_allowed(text) is
  '#9166: an organization-wide action (chapter null) is joinable by every member of the organization; a chapter-tagged action only by members whose selected chapter is that chapter. Used by get_collective_actions (reach and viewerCanJoin) and toggle_digital_action_participation. No client execute.';

create or replace function public.save_digital_action(
  p_selected_hat text,
  p_id uuid,
  p_chapter_id text,
  p_action_kind text,
  p_title text,
  p_summary text,
  p_status text,
  p_target_count integer,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  org uuid := private.mi1_require_selected_organization();
  caller uuid := (select auth.uid());
  record_id uuid := coalesce(p_id, extensions.gen_random_uuid());
  published timestamptz;
  existing_creator uuid;
  existing_chapter text;
  organization_grant boolean;
  chapter_grant boolean;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  organization_grant := coalesce(private.has_organization_role(org, array[p_selected_hat]), false);
  -- #9166: a hat granted for the caller's selected chapter (the votes rule,
  -- private.can_manage_vote_scope) writes only actions of that chapter. An
  -- organization-wide grant keeps every right it had.
  chapter_grant := not organization_grant
    and coalesce(p_chapter_id = private.current_member_chapter(), false)
    and coalesce(private.member_has_chapter_role(p_chapter_id, array[p_selected_hat]), false);
  if p_selected_hat not in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
     or not (organization_grant or chapter_grant) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_action_kind not in ('petition', 'rally', 'picket', 'meeting', 'other')
     or p_status not in ('draft', 'published', 'closed', 'cancelled')
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title, ''))) not between 3 and 180
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_summary, ''))) not between 3 and 2000
     or coalesce(p_target_count, 0) not between 1 and 1000000
     or (p_ends_at is not null and p_starts_at is not null and p_ends_at < p_starts_at) then
    raise exception 'invalid digital action' using errcode = '22023';
  end if;
  if p_chapter_id is not null and not exists (
    select 1 from public.chapters c where c.id = p_chapter_id and c.organization_id = org
  ) then raise exception 'invalid chapter' using errcode = '22023'; end if;
  if p_id is not null then
    select a.created_by, a.chapter_id into existing_creator, existing_chapter
    from public.digital_actions a
    where a.id = p_id and a.organization_id = org
    for update;
    if not found then
      raise exception 'digital action not found' using errcode = 'P0002';
    end if;
    -- #9166: a chapter grant edits only an action already in that chapter,
    -- never an organization-wide one or another chapter's.
    if chapter_grant and existing_chapter is distinct from p_chapter_id then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    -- Object-level rule for an update: the caller wrote this action, or the
    -- selected hat is an organization officer hat (advisor/admin/vp, the
    -- ORGANIZATION_INTELLIGENCE_WRITE_HATS). A steward or coordinator hat
    -- edits only its own actions.
    if p_selected_hat not in ('advisor', 'admin', 'vp')
       and existing_creator is distinct from caller then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;
  select a.published_at into published from public.digital_actions a
  where a.id = record_id and a.organization_id = org;
  if p_status = 'draft' then published := null;
  elsif published is null then published := pg_catalog.now(); end if;
  insert into public.digital_actions (
    id, organization_id, chapter_id, action_kind, title, summary, status,
    target_count, starts_at, ends_at, published_at, created_by, updated_by
  ) values (
    record_id, org, p_chapter_id, p_action_kind, pg_catalog.btrim(p_title),
    pg_catalog.btrim(p_summary), p_status, p_target_count, p_starts_at,
    p_ends_at, published, caller, caller
  ) on conflict (id) do update set
    chapter_id = excluded.chapter_id,
    action_kind = excluded.action_kind,
    title = excluded.title,
    summary = excluded.summary,
    status = excluded.status,
    target_count = excluded.target_count,
    starts_at = excluded.starts_at,
    ends_at = excluded.ends_at,
    published_at = excluded.published_at,
    updated_by = caller,
    updated_at = pg_catalog.now()
  where digital_actions.organization_id = org;
  perform private.write_organization_intelligence_audit(
    org, 'digital_action_saved', 'digital_action', record_id::text,
    pg_catalog.jsonb_build_object('actionKind', p_action_kind, 'status', p_status, 'chapterId', p_chapter_id)
  );
  return pg_catalog.jsonb_build_object('id', record_id, 'organizationId', org, 'status', p_status);
end;
end;
$function$;
revoke all on function public.save_digital_action(text, uuid, text, text, text, text, text, integer, timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.save_digital_action(text, uuid, text, text, text, text, text, integer, timestamptz, timestamptz) to authenticated;

CREATE OR REPLACE FUNCTION public.get_collective_actions(p_selected_hat text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.mi1_require_selected_organization();
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  manager boolean;
  chapter_manager boolean;
  authoring_hats jsonb;
  organization_editor boolean;
  total_count integer;
  action_rows jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  manager := p_selected_hat in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
    and private.has_organization_role(org, array[p_selected_hat]);
  -- Mirrors public.save_digital_action's object-level rule: an organization
  -- officer hat may edit any action; any other manager hat only its own.
  organization_editor := manager and p_selected_hat in ('advisor', 'admin', 'vp');
  -- #9166: a manager hat granted for the caller's selected chapter manages
  -- that chapter's actions only (the votes rule, private.can_manage_vote_scope).
  -- A chapter-tagged action is read by members of that selected chapter (the
  -- private.can_read_vote_campaign rule) and by anyone who already joined it,
  -- so a participant can still see and withdraw; organization managers and
  -- organization-wide actions are unchanged.
  chapter_manager := not coalesce(manager, false)
    and coalesce(p_selected_hat in ('steward', 'coordinator', 'advisor', 'admin', 'vp'), false)
    and coalesce(private.member_has_chapter_role(caller_chapter, array[p_selected_hat]), false);
  -- #9166: the hats this caller could wear to manage actions here (an
  -- organization-wide grant, or a chapter grant that is not narrowed to a
  -- unit), so an empty page never offers a hat the save would refuse.
  select coalesce(pg_catalog.jsonb_agg(held.hat order by held.ord), '[]'::jsonb) into authoring_hats
  from pg_catalog.unnest(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) with ordinality as held(hat, ord)
  where coalesce(private.has_organization_role(org, array[held.hat]), false)
     or coalesce(private.member_has_chapter_role(caller_chapter, array[held.hat]), false);
  if coalesce(p_limit, 0) not between 1 and 100
     or coalesce(p_offset, -1) not between 0 and 10000 then
    raise exception 'invalid pagination' using errcode = '22023';
  end if;
  select pg_catalog.count(*)::integer into total_count
  from public.digital_actions a
  where a.organization_id = org and (manager or (
    (private.digital_action_join_allowed(a.chapter_id) or exists (
      select 1 from public.digital_action_participants own
      where own.organization_id = org and own.action_id = a.id and own.user_id = caller))
    and (a.status <> 'draft' or (chapter_manager and a.chapter_id = caller_chapter))));

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', a.id, 'chapterId', a.chapter_id, 'kind', a.action_kind,
    'title', a.title, 'summary', a.summary, 'status', a.status,
    'targetCount', a.target_count, 'startsAt', a.starts_at,
    'endsAt', a.ends_at, 'publishedAt', a.published_at,
    'participantCount', case when private.organization_is_union(a.organization_id) then counted.value else null end,
    'viewerParticipation', mine.participation_kind,
    -- #9166: whether this caller may join, by the rule the join itself uses,
    -- so a manager who sees another chapter's action is not offered Join.
    'viewerCanJoin', private.digital_action_join_allowed(a.chapter_id),
    'viewerCanEdit', manager and (organization_editor or a.created_by = caller)
      or (chapter_manager and coalesce(a.chapter_id = caller_chapter, false)
        and (p_selected_hat in ('advisor', 'admin', 'vp') or coalesce(a.created_by = caller, false)))
  ) order by
    case a.status when 'published' then 0 when 'draft' then 1 when 'closed' then 2 else 3 end,
    a.starts_at desc nulls last, a.created_at desc, a.id), '[]'::jsonb)
  into action_rows
  from (
    select page.* from public.digital_actions page
    where page.organization_id = org and (manager or (
      (private.digital_action_join_allowed(page.chapter_id) or exists (
        select 1 from public.digital_action_participants own
        where own.organization_id = org and own.action_id = page.id and own.user_id = caller))
      and (page.status <> 'draft' or (chapter_manager and page.chapter_id = caller_chapter))))
    order by
      case page.status when 'published' then 0 when 'draft' then 1 when 'closed' then 2 else 3 end,
      page.starts_at desc nulls last, page.created_at desc, page.id
    limit p_limit offset p_offset
  ) a
  cross join lateral (
    select pg_catalog.count(*)::integer as value
    from public.digital_action_participants p
    where p.organization_id = org and p.action_id = a.id
      and private.organization_is_union(a.organization_id)
  ) counted
  left join lateral (
    select p.participation_kind
    from public.digital_action_participants p
    where p.organization_id = org and p.action_id = a.id and p.user_id = caller
    limit 1
  ) mine on true;

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'manageScope', case when manager then 'organization' when chapter_manager then 'chapter' else null end,
    'manageChapterId', case when chapter_manager then caller_chapter else null end,
    'authoringHats', authoring_hats,
    'generatedAt', pg_catalog.now(),
    'actions', action_rows,
    'pageSize', p_limit,
    'offset', p_offset,
    'totalCount', total_count,
    'nextOffset', case
      when p_offset + pg_catalog.jsonb_array_length(action_rows) < total_count
      then p_offset + pg_catalog.jsonb_array_length(action_rows)
      else null
    end
  );
end;
$function$;
revoke all on function public.get_collective_actions(text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.get_collective_actions(text, integer, integer) to authenticated;

create or replace function public.toggle_digital_action_participation(
  p_action_id uuid,
  p_participation_kind text,
  p_joined boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_require_selected_organization();
  caller uuid := (select auth.uid());
  action_row public.digital_actions%rowtype;
  participant_count integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_action_id is null or p_participation_kind not in ('signature', 'attendee', 'volunteer') or p_joined is null then
    raise exception 'invalid participation request' using errcode = '22023';
  end if;
  select a.* into action_row from public.digital_actions a
  where a.id = p_action_id and a.organization_id = org for update;
  if not found then raise exception 'digital action not found' using errcode = 'P0002'; end if;
  -- #9166: an action this caller may not join (another chapter's) answers
  -- like an unknown id, before any status or count, unless the caller is
  -- withdrawing a participation they already hold.
  if not private.digital_action_join_allowed(action_row.chapter_id)
     and (p_joined or not exists (
       select 1 from public.digital_action_participants own
       where own.organization_id = org and own.action_id = p_action_id and own.user_id = caller)) then
    raise exception 'digital action not found' using errcode = 'P0002';
  end if;
  if action_row.status <> 'published'
     or (action_row.starts_at is not null and action_row.starts_at > pg_catalog.now())
     or (action_row.ends_at is not null and action_row.ends_at < pg_catalog.now()) then
    raise exception 'digital action is not accepting participation' using errcode = '55000';
  end if;
  if p_joined then
    insert into public.digital_action_participants (
      organization_id, action_id, user_id, participation_kind
    ) values (org, p_action_id, caller, p_participation_kind)
    on conflict (action_id, user_id) do update set
      participation_kind = excluded.participation_kind,
      updated_at = pg_catalog.now();
  else
    delete from public.digital_action_participants p
    where p.organization_id = org and p.action_id = p_action_id and p.user_id = caller;
  end if;
  perform private.write_organization_intelligence_audit(
    org,
    case when p_joined then 'digital_action_participation_joined' else 'digital_action_participation_withdrawn' end,
    'digital_action_participation', p_action_id::text || ':' || caller::text,
    pg_catalog.jsonb_build_object('participationKind', p_participation_kind)
  );
  select pg_catalog.count(*)::integer into participant_count
  from public.digital_action_participants p
  where p.organization_id = org and p.action_id = p_action_id;
  return pg_catalog.jsonb_build_object(
    'actionId', p_action_id, 'organizationId', org, 'joined', p_joined,
    'participationKind', case when p_joined then p_participation_kind else null end,
    'participantCount', case when private.organization_is_union(org) then participant_count else null end
  );
end;
end;
$function$;
revoke all on function public.toggle_digital_action_participation(uuid, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.toggle_digital_action_participation(uuid, text, boolean) to authenticated;

-- Keep the reviewed lifecycle graph current for these exact re-emissions
-- (a no-op for a function that is not on the reviewed surface).
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select surface.kind, surface.schema_name, surface.table_name, surface.object_name, surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
where surface.kind = 'function'
  and surface.schema_name in ('public', 'private')
  and pg_catalog.split_part(surface.object_name, '(', 1) in ('save_digital_action', 'get_collective_actions', 'toggle_digital_action_participation', 'digital_action_join_allowed')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

notify pgrst, 'reload schema';
commit;
