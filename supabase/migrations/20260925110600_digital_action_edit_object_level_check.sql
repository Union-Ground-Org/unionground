-- SEC-UG-DIGITAL-ACTION-EDIT-NO-OBJECT-LEVEL-CHECK-20260920
--
-- public.save_digital_action (20260829002000) authorized an UPDATE of an
-- existing digital action from the caller's selected hat alone: any steward,
-- coordinator, advisor, admin or VP hat in the organization could overwrite
-- any action's chapter, kind, title, summary, status, target and dates, and
-- the Collective actions page offered the edit control on every card.
--
-- The update path now carries an object-level rule: the caller created the
-- action, or the selected hat is an organization officer hat (advisor, admin,
-- vp -- the hats the client already records as ORGANIZATION_INTELLIGENCE_WRITE_
-- HATS for organization-wide writes). The existing row is locked while the
-- rule is checked. Creation, participation and export are unchanged.
-- public.get_collective_actions returns viewerCanEdit per action under the same
-- rule so the surface offers the edit control only where the write succeeds.
--
-- save_digital_action keeps the case-graph lock prologue that
-- 20260907151000 wrapped around it. Grants are preserved by CREATE OR REPLACE.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.get_collective_actions(
  p_selected_hat text,
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  caller uuid := (select auth.uid());
  manager boolean;
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
  if coalesce(p_limit, 0) not between 1 and 100
     or coalesce(p_offset, -1) not between 0 and 10000 then
    raise exception 'invalid pagination' using errcode = '22023';
  end if;
  select pg_catalog.count(*)::integer into total_count
  from public.digital_actions a
  where a.organization_id = org and (a.status <> 'draft' or manager);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', a.id, 'chapterId', a.chapter_id, 'kind', a.action_kind,
    'title', a.title, 'summary', a.summary, 'status', a.status,
    'targetCount', a.target_count, 'startsAt', a.starts_at,
    'endsAt', a.ends_at, 'publishedAt', a.published_at,
    'participantCount', counted.value,
    'viewerParticipation', mine.participation_kind,
    'viewerCanEdit', manager and (organization_editor or a.created_by = caller)
  ) order by
    case a.status when 'published' then 0 when 'draft' then 1 when 'closed' then 2 else 3 end,
    a.starts_at desc nulls last, a.created_at desc, a.id), '[]'::jsonb)
  into action_rows
  from (
    select page.* from public.digital_actions page
    where page.organization_id = org and (page.status <> 'draft' or manager)
    order by
      case page.status when 'published' then 0 when 'draft' then 1 when 'closed' then 2 else 3 end,
      page.starts_at desc nulls last, page.created_at desc, page.id
    limit p_limit offset p_offset
  ) a
  cross join lateral (
    select pg_catalog.count(*)::integer as value
    from public.digital_action_participants p
    where p.organization_id = org and p.action_id = a.id
  ) counted
  left join lateral (
    select p.participation_kind
    from public.digital_action_participants p
    where p.organization_id = org and p.action_id = a.id and p.user_id = caller
    limit 1
  ) mine on true;

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
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
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_selected_hat not in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
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
    select a.created_by into existing_creator
    from public.digital_actions a
    where a.id = p_id and a.organization_id = org
    for update;
    if not found then
      raise exception 'digital action not found' using errcode = 'P0002';
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

commit;
