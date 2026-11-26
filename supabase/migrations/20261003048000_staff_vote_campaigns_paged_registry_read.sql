-- BUG-UG-WEB-STAFF-CAMPAIGNS-REGISTRY-UNBOUNDED-READ-20261002
--
-- get_staff_vote_campaigns() (last emitted by
-- 20260924160000_vote_campaign_organization_boundary.sql) returned every
-- ballot and pulse the caller may manage, each with its options, in one read.
-- The registry only ever shows six at a time, and a large organization's read
-- can run into the statement timeout behind the owner's September example 2
-- (the registry showing "No campaigns yet" with zero counts).
--
-- The registry read becomes a bounded keyset page:
--   get_staff_vote_campaigns(p_state, p_limit, p_cursor)
--     p_state   null (all), 'draft', 'open' or 'closed';
--     p_limit   page size, 1..100, default 50;
--     p_cursor  the previous page's nextCursor, null for the first page.
-- Rows keep the registry order (drafts, then open, then closed; latest close
-- first inside each), and the answer adds 'counts' (all, draft, open, closed
-- over every campaign the caller may manage) and 'nextCursor'. The campaign
-- payload, 'canManageUnion', 'chapterId', the staff-role check and the
-- organization boundary (private.can_manage_vote_campaign) are unchanged.
-- The parameterless signature is dropped; calling with no arguments now reads
-- the first page of all campaigns.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function public.get_staff_vote_campaigns();

create function public.get_staff_vote_campaigns(
  p_state text default null,
  p_limit integer default 50,
  p_cursor jsonb default null
)
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
    'chapterId', caller_chapter,
    'counts', counts,
    'nextCursor', case when has_more then next_cursor else null end,
    'state', p_state,
    'limit', page_limit);
end;
$function$;

revoke all on function public.get_staff_vote_campaigns(text, integer, jsonb) from public, anon;
grant execute on function public.get_staff_vote_campaigns(text, integer, jsonb) to authenticated, service_role;

comment on function public.get_staff_vote_campaigns(text, integer, jsonb) is
  'Staff campaign registry, one bounded keyset page (1..100, default 50) of the ballots and pulses the caller may manage: drafts, then open, then closed, latest close first; with counts by state over every manageable campaign and the next page cursor.';

notify pgrst, 'reload schema';

commit;
