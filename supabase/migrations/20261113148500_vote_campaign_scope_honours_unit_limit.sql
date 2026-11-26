-- SEC-UG-UNIT-STEWARD-OPENS-CHAPTER-WIDE-VOTE-CAMPAIGNS-20261115 (#8941).
-- A steward limited to one unit (#7663) could still save, list, publish, close
-- and delete chapter-wide ballots and pulses: the chapter branch of
-- private.can_manage_vote_scope admitted any legacy public.member_roles row,
-- which every steward grant writes. The legacy row now counts only when the
-- caller holds no unit or committee limit for that role in the chapter, the
-- same limit private.member_has_chapter_role applies (a #7663 carry-over mark
-- keeps chapter coverage). The union branch and every caller are unchanged,
-- except that public.get_staff_vote_campaigns also returns canManageChapter.
-- No unit-audience ballots are added here.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog,public,extensions;

do $predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.can_manage_vote_scope(text)'))) is distinct from 'c639a78817232b6eeb13dc7dadfa2015' then
    raise exception 'unreviewed predecessor: private.can_manage_vote_scope' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_staff_vote_campaigns(text, integer, jsonb)'))) is distinct from 'a7c1ebb592a4a03a1c0f21c922f8db4c' then
    raise exception 'unreviewed predecessor: public.get_staff_vote_campaigns' using errcode='55000';
  end if;
end;
$predecessors$;

CREATE OR REPLACE FUNCTION private.can_manage_vote_scope(p_chapter_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and case
      when p_chapter_id is null then (
        exists (
          select 1 from public.member_roles r
          where r.user_id = (select auth.uid())
            and r.role in ('admin', 'vp')
            and r.chapter_id is null)
        or private.has_organization_role(
          private.current_member_organization(),
          array['admin', 'vp']))
      else p_chapter_id = private.current_member_chapter()
        and (
          exists (
            select 1 from public.member_roles r
            where r.user_id = (select auth.uid())
              and r.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
              and (r.chapter_id is null or r.chapter_id = p_chapter_id)
              -- #8941: a unit or committee limit (#7663) withdraws the legacy
              -- row's chapter-wide reach, as in private.member_has_chapter_role.
              and not exists (
                select 1 from private.steward_assignment_scopes((select auth.uid()), p_chapter_id) scope
                where scope.role = r.role
                  and not scope.legacy_chapter_coverage))
          or private.member_has_chapter_role(
            p_chapter_id,
            array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
    end;
$function$;

revoke all on function private.can_manage_vote_scope(text) from public, anon, authenticated;
comment on function private.can_manage_vote_scope(text) is
  'Staff campaign-scope predicate. Union scope requires an organization-wide admin or vp grant from a legacy public.member_roles row or private.has_organization_role; chapter scope requires the caller''s selected chapter plus private.member_has_chapter_role or a matching legacy member_roles row whose role carries no unit or committee limit in that chapter (#8941: a steward limited to a unit manages no chapter-wide campaign; a #7663 carry-over mark keeps chapter coverage). member_has_role retains MFA. No client execute.';

-- The staff registry says whether the caller may author a chapter-wide
-- campaign, so the web Campaigns page hides New campaign and New officer
-- removal ballot from a steward limited to one unit (record #8950's work,
-- folded into this change). Nothing else in the read changes.
CREATE OR REPLACE FUNCTION public.get_staff_vote_campaigns(p_state text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_cursor jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  can_union boolean;
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  after_rank integer;
  after_closes_at timestamptz;
  after_kind text;
  after_id text;
  page_rows jsonb;
  has_more boolean;
  next_cursor jsonb;
  counts jsonb;
  campaigns jsonb;
begin
  if caller is null
     or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_state is not null and p_state not in ('draft', 'open', 'closed') then
    raise exception 'unknown campaign state' using errcode = '22023';
  end if;
  if p_cursor is not null then
    begin
      after_rank := (p_cursor ->> 'rank')::integer;
      after_closes_at := (p_cursor ->> 'closesAt')::timestamptz;
      after_kind := p_cursor ->> 'kind';
      after_id := p_cursor ->> 'id';
    exception when others then
      raise exception 'invalid campaign cursor' using errcode = '22023';
    end;
    if after_rank is null or after_closes_at is null or after_id is null
       or after_kind is null or after_kind not in ('ballot', 'pulse') then
      raise exception 'invalid campaign cursor' using errcode = '22023';
    end if;
  end if;

  can_union := private.can_manage_vote_scope(null);

  with manageable as (
    select b.id, 'ballot'::text as kind, b.closes_at, b.campaign_state as state
    from public.member_ballots b
    where private.can_manage_vote_campaign(b.organization_id, b.chapter_id)
    union all
    select s.id, 'pulse'::text as kind, s.closes_at, s.campaign_state as state
    from public.member_surveys s
    where private.can_manage_vote_campaign(s.organization_id, s.chapter_id)
  ), ranked as (
    select manageable.*,
      case manageable.state when 'draft' then 0 when 'open' then 1 else 2 end as state_rank
    from manageable
  ), window_rows as (
    select ranked.*,
      pg_catalog.row_number() over (order by ranked.state_rank, ranked.closes_at desc, ranked.kind, ranked.id) as position
    from ranked
    where (p_state is null or ranked.state = p_state)
      and (after_rank is null
        or ranked.state_rank > after_rank
        or (ranked.state_rank = after_rank and (
          ranked.closes_at < after_closes_at
          or (ranked.closes_at = after_closes_at and (ranked.kind, ranked.id) > (after_kind, after_id)))))
    order by ranked.state_rank, ranked.closes_at desc, ranked.kind, ranked.id
    limit page_limit + 1
  )
  select
    (select pg_catalog.jsonb_build_object(
      'all', pg_catalog.count(*),
      'draft', pg_catalog.count(*) filter (where manageable.state = 'draft'),
      'open', pg_catalog.count(*) filter (where manageable.state = 'open'),
      'closed', pg_catalog.count(*) filter (where manageable.state = 'closed'))
     from manageable),
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'kind', window_rows.kind, 'id', window_rows.id, 'position', window_rows.position
      ) order by window_rows.position) filter (where window_rows.position <= page_limit), '[]'::jsonb)
     from window_rows),
    (select pg_catalog.count(*) > page_limit from window_rows),
    (select pg_catalog.jsonb_build_object(
        'rank', window_rows.state_rank, 'closesAt', window_rows.closes_at,
        'kind', window_rows.kind, 'id', window_rows.id)
     from window_rows where window_rows.position = page_limit)
  into counts, page_rows, has_more, next_cursor;

  select coalesce(pg_catalog.jsonb_agg(c.payload order by c.position), '[]'::jsonb)
  into campaigns
  from (
    select page.position,
      pg_catalog.jsonb_build_object(
        'id', b.id, 'kind', 'ballot', 'titleEn', b.title,
        'titleEs', b.title_es, 'bodyEn', b.body, 'bodyEs', b.body_es,
        'scope', case when b.chapter_id is null then 'union' else 'chapter' end,
        'chapterId', b.chapter_id, 'closesAt', b.closes_at,
        'quorumTarget', b.quorum_target, 'state', b.campaign_state,
        'active', b.active, 'publishedAt', b.published_at,
        'closedAt', b.closed_at, 'createdBy', b.created_by,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', o.id, 'labelEn', o.label, 'labelEs', o.label_es,
            'orderIndex', o.order_index) order by o.order_index)
          from public.member_ballot_options o where o.ballot_id = b.id
        ), '[]'::jsonb)) as payload
    from pg_catalog.jsonb_to_recordset(page_rows) as page(kind text, id text, position bigint)
    join public.member_ballots b on page.kind = 'ballot' and b.id = page.id
    union all
    select page.position,
      pg_catalog.jsonb_build_object(
        'id', s.id, 'kind', 'pulse', 'titleEn', s.title,
        'titleEs', s.title_es, 'bodyEn', s.body, 'bodyEs', s.body_es,
        'scope', case when s.chapter_id is null then 'union' else 'chapter' end,
        'chapterId', s.chapter_id, 'closesAt', s.closes_at,
        'quorumTarget', null, 'state', s.campaign_state,
        'active', s.active, 'publishedAt', s.published_at,
        'closedAt', s.closed_at, 'createdBy', s.created_by,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', o.id, 'labelEn', o.label, 'labelEs', o.label_es,
            'orderIndex', o.order_index) order by o.order_index)
          from public.member_survey_options o where o.survey_id = s.id
        ), '[]'::jsonb))
    from pg_catalog.jsonb_to_recordset(page_rows) as page(kind text, id text, position bigint)
    join public.member_surveys s on page.kind = 'pulse' and s.id = page.id
  ) c;

  return pg_catalog.jsonb_build_object(
    'campaigns', campaigns,
    'canManageUnion', can_union,
    -- #8941: false for a steward limited to one unit, so a client offers no
    -- chapter-wide authoring the save would refuse.
    'canManageChapter', caller_chapter is not null and coalesce(private.can_manage_vote_scope(caller_chapter), false),
    'chapterId', caller_chapter,
    'counts', counts,
    'nextCursor', case when has_more then next_cursor else null end,
    'state', p_state,
    'limit', page_limit);
end;
$function$;

-- Preserve the reviewed lifecycle graph after this exact predicate change
-- (a no-op when the predicate is not on the reviewed surface).
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select surface.kind,surface.schema_name,surface.table_name,surface.object_name,surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
where surface.kind='function'
  and surface.schema_name='private'
  and pg_catalog.split_part(surface.object_name,'(',1)='can_manage_vote_scope'
on conflict(kind,schema_name,table_name,object_name)
do update set definition_hash=excluded.definition_hash;

commit;
