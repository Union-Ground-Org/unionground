-- REQ-UG-TENANT-ORG-CHART-BASELINE-20261030
--
-- Every organization keeps its own chart for its own authorized users. The
-- chart tables already hold organization- and chapter-scoped nodes, the union
-- and agency charts as separate kinds, explicit parent links, a vacant flag and
-- source provenance (20260829002000, 20260924170000). What they could not say
-- is whether a seat was ever confirmed, or whether that confirmation is still
-- current. This migration adds that, and nothing else:
--
--   * seat_status: confirmed, unconfirmed (the default, because nothing was
--     ever confirmed for an existing or imported row), unknown, or stale;
--   * seat_status_reviewed_on: the Eastern-time date an administrator last set
--     the status;
--   * a guard that drops a seat back to unconfirmed when its content changes
--     outside the status writer, so an import or an edit never inherits an
--     older confirmation;
--   * set_organization_chart_seat_status, the administrator-only writer;
--   * the two existing read projections, extended with the new fields. Their
--     scoping predicates, hats and grants are unchanged.
--
-- BLANK SYSTEM. No organization, chapter, node, seat or person is created. No
-- reference chart's people or structure is copied here; organizations populate
-- their own charts through the existing authorized import and editor.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.organization_chart_nodes
  add column seat_status text not null default 'unconfirmed',
  add column seat_status_reviewed_on date,
  add constraint organization_chart_nodes_seat_status check (
    seat_status in ('confirmed', 'unconfirmed', 'unknown', 'stale')
  );

comment on column public.organization_chart_nodes.seat_status is
  'Administrator-set seat state: confirmed, unconfirmed (default), unknown or stale. Reset to unconfirmed when the seat''s content changes outside public.set_organization_chart_seat_status.';
comment on column public.organization_chart_nodes.seat_status_reviewed_on is
  'Eastern-time date an administrator last set seat_status. NULL when no administrator has reviewed the seat.';

-- A confirmation is a statement about a date. A year later it is stale, and
-- every client reads the same answer from this one function.
create function private.organization_chart_effective_seat_status(
  p_seat_status text,
  p_reviewed_on date
)
returns text
language sql
stable
set search_path = ''
as $function$
  select case
    when p_seat_status = 'confirmed'
      and (p_reviewed_on is null
        or p_reviewed_on < (pg_catalog.now() at time zone 'America/New_York')::date - 365)
      then 'stale'
    else coalesce(p_seat_status, 'unconfirmed')
  end;
$function$;

revoke all on function private.organization_chart_effective_seat_status(text, date)
  from public, anon, authenticated, service_role;

-- The status writer marks its own row for the length of its statement. Any
-- other change to what a seat says (who holds it, what it is called, where it
-- reports, whether it is vacant, where the information came from) means the
-- earlier confirmation no longer describes it.
create function private.organization_chart_node_seat_status_guard()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if pg_catalog.current_setting('union_ground.chart_seat_review', true) is not distinct from new.id::text then
    return new;
  end if;
  if new.label is distinct from old.label
     or new.subtitle is distinct from old.subtitle
     or new.node_kind is distinct from old.node_kind
     or new.chart_kind is distinct from old.chart_kind
     or new.parent_id is distinct from old.parent_id
     or new.chapter_id is distinct from old.chapter_id
     or new.user_id is distinct from old.user_id
     or new.vacant is distinct from old.vacant
     or new.badge is distinct from old.badge
     or new.role_class is distinct from old.role_class
     or new.chip_label is distinct from old.chip_label
     or new.reports_to_label is distinct from old.reports_to_label
     or new.source_label is distinct from old.source_label
     or new.source_as_of is distinct from old.source_as_of then
    new.seat_status := 'unconfirmed';
    new.seat_status_reviewed_on := null;
  elsif new.seat_status is distinct from old.seat_status
     or new.seat_status_reviewed_on is distinct from old.seat_status_reviewed_on then
    -- Only the status writer sets a status.
    new.seat_status := old.seat_status;
    new.seat_status_reviewed_on := old.seat_status_reviewed_on;
  end if;
  return new;
end;
$function$;

revoke all on function private.organization_chart_node_seat_status_guard()
  from public, anon, authenticated, service_role;

create trigger organization_chart_nodes_seat_status_guard
  before update on public.organization_chart_nodes
  for each row execute function private.organization_chart_node_seat_status_guard();

-- The chart table is on the account-lifecycle trigger surface, which
-- fingerprints the new trigger and its function. Review both, then require a
-- clean inventory.
insert into private.account_lifecycle_trigger_review(kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'public' and table_name = 'organization_chart_nodes'
       and object_name = 'organization_chart_nodes_seat_status_guard')
   or (kind = 'function' and schema_name = 'private' and table_name = ''
       and object_name = 'organization_chart_node_seat_status_guard()')
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;
do $seat_status_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger inventory differs from review after the chart seat status guard';
  end if;
end;
$seat_status_trigger_review$;

create function public.set_organization_chart_seat_status(
  p_selected_hat text,
  p_node_id uuid,
  p_seat_status text,
  p_vacant boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  caller uuid;
  reviewed date;
begin
  -- Case-graph gate first: organization_chart_nodes is in the account graph.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  caller := (select auth.uid());
  reviewed := (pg_catalog.now() at time zone 'America/New_York')::date;
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  -- The same hats as save_organization_chart_node: the chart's editors.
  if p_selected_hat not in ('advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_node_id is null or p_vacant is null
     or p_seat_status is null
     or p_seat_status not in ('confirmed', 'unconfirmed', 'unknown', 'stale') then
    raise exception 'invalid seat status' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('union_ground.chart_seat_review', p_node_id::text, true);
  update public.organization_chart_nodes n
     set seat_status = p_seat_status,
         seat_status_reviewed_on = reviewed,
         vacant = p_vacant,
         updated_by = caller,
         updated_at = pg_catalog.now()
   where n.id = p_node_id and n.organization_id = org;
  if not found then
    perform pg_catalog.set_config('union_ground.chart_seat_review', '', true);
    raise exception 'chart node not found' using errcode = 'P0002';
  end if;
  perform pg_catalog.set_config('union_ground.chart_seat_review', '', true);
  perform private.write_organization_intelligence_audit(
    org, 'chart_node_saved', 'chart_node', p_node_id::text,
    pg_catalog.jsonb_build_object('status', p_seat_status)
  );
  return pg_catalog.jsonb_build_object(
    'id', p_node_id, 'organizationId', org, 'seatStatus', p_seat_status,
    'vacant', p_vacant, 'seatStatusReviewedOn', reviewed
  );
end;
$function$;

revoke all on function public.set_organization_chart_seat_status(text, uuid, text, boolean)
  from public, anon, service_role;
grant execute on function public.set_organization_chart_seat_status(text, uuid, text, boolean)
  to authenticated;

comment on function public.set_organization_chart_seat_status(text, uuid, text, boolean) is
  'Administrator-only seat state writer for the caller''s selected organization. MFA, advisor/admin/vp hat, audited as chart_node_saved.';

create or replace function public.get_organization_intelligence_snapshot(p_selected_hat text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_selected_hat not in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', pg_catalog.now(),
    'chartNodes', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', n.id, 'chapterId', n.chapter_id, 'chartKind', n.chart_kind,
        'nodeKind', n.node_kind, 'parentId', n.parent_id, 'label', n.label,
        'subtitle', n.subtitle, 'positionX', n.position_x, 'positionY', n.position_y,
        'sortOrder', n.sort_order,
        -- REQ-UG-TENANT-ORG-CHART-BASELINE-20261030: the stored seat
        -- state the editor changes, and the provenance it was judged against.
        'vacant', n.vacant, 'seatStatus', n.seat_status,
        'seatStatusReviewedOn', n.seat_status_reviewed_on,
        'sourceLabel', n.source_label, 'sourceAsOf', n.source_as_of
      ) order by n.chart_kind, n.sort_order, n.label, n.id)
      from (
        select scoped.*
        from public.organization_chart_nodes scoped
        where scoped.organization_id = org
        order by scoped.chart_kind, scoped.sort_order, scoped.label, scoped.id
        limit 5000
      ) n
    ), '[]'::jsonb),
    'relationshipNodes', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', scoped.user_id, 'label', scoped.full_name, 'chapterId', scoped.chapter_id,
        'roleLabel', p.role_line
      ) order by scoped.full_name, scoped.user_id)
      from (
        select m.user_id, profile.full_name, profile.chapter_id
        from public.organization_memberships m
        join public.member_profiles profile on profile.id = m.user_id
        where m.organization_id = org and m.status = 'active'
        order by profile.full_name, m.user_id
        limit 5000
      ) scoped
      join public.member_profiles p on p.id = scoped.user_id
    ), '[]'::jsonb),
    'relationships', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'sourceId', r.source_user_id, 'targetId', r.target_user_id,
        'kind', r.relationship_kind, 'strength', r.strength
      ) order by r.updated_at desc, r.id)
      from (
        select scoped.*
        from public.organization_relationships scoped
        where scoped.organization_id = org
        order by scoped.updated_at desc, scoped.id
        limit 5000
      ) r
    ), '[]'::jsonb),
    'topicProgress', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'memberId', t.member_user_id, 'topicKey', t.topic_key,
        'topicLabel', t.topic_label, 'state', t.progress_state,
        'progress', t.progress
      ) order by t.topic_label, t.member_user_id)
      from (
        select scoped.*
        from public.organization_topic_progress scoped
        where scoped.organization_id = org
        order by scoped.topic_label, scoped.member_user_id
        limit 5000
      ) t
    ), '[]'::jsonb),
    'timeline', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id, 'chapterId', e.chapter_id, 'kind', e.event_kind,
        'title', e.title, 'detail', e.detail, 'effectiveOn', e.effective_on,
        'endedOn', e.ended_on, 'amountCents', e.amount_cents,
        'amountBasis', e.amount_basis, 'sourceLabel', e.source_label,
        'sourceAsOf', e.source_as_of
      ) order by e.effective_on desc, e.id desc)
      from (
        select scoped.*
        from public.organization_timeline_events scoped
        where scoped.organization_id = org
        order by scoped.effective_on desc, scoped.id desc
        limit 5000
      ) e
    ), '[]'::jsonb)
  );
end;
$function$;

create or replace function public.get_member_organization_structure()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  caller_chapter text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if org is null then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'chapterId', caller_chapter,
    'generatedAt', pg_catalog.now(),
    'charts', coalesce((
      select pg_catalog.jsonb_agg(chart order by chart->>'chartKind')
      from (
        select pg_catalog.jsonb_build_object(
          'chartKind', k.chart_kind,
          'nodes', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', n.id,
              'parentId', n.parent_id,
              'chapterId', n.chapter_id,
              'nodeKind', n.node_kind,
              'label', n.label,
              'subtitle', n.subtitle,
              'positionX', n.position_x,
              'positionY', n.position_y,
              'sortOrder', n.sort_order,
              -- Descriptive columns from the import lane (API-CONTRACT.md 1.1).
              -- Organization content, member-safe once the organization
              -- imported it, and scoped by the same predicates as the node.
              'badge', n.badge,
              'roleClass', n.role_class,
              'vacant', n.vacant,
              'reportsToLabel', n.reports_to_label,
              'chipLabel', n.chip_label,
              'sourceLabel', n.source_label,
              'sourceAsOf', n.source_as_of,
              -- REQ-UG-TENANT-ORG-CHART-BASELINE-20261030. The
              -- effective seat state, decided here so every client labels the
              -- same seat the same way: a confirmation older than a year reads
              -- stale, never as current.
              'seatStatus', private.organization_chart_effective_seat_status(
                n.seat_status, n.seat_status_reviewed_on),
              'seatStatusReviewedOn', n.seat_status_reviewed_on,
              'collapsedByDefault', n.collapsed_by_default
            ) order by n.sort_order, n.label, n.id)
            from (
              select scoped.*
              from public.organization_chart_nodes scoped
              where scoped.organization_id = org
                and scoped.chart_kind = k.chart_kind
                -- Organization-level nodes carry no chapter and belong to
                -- everyone in the organization; a node stamped with another
                -- chapter belongs to that chapter and never leaves it.
                and (scoped.chapter_id is null or scoped.chapter_id = caller_chapter)
              order by scoped.sort_order, scoped.label, scoped.id
              limit 5000
            ) n
          ), '[]'::jsonb),
          'edges', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', e.id,
              'sourceId', e.source_node_id,
              'targetId', e.target_node_id,
              'kind', 'reports_to'
            ) order by e.id)
            from (
              select r.id, src.node_id as source_node_id, tgt.node_id as target_node_id
              from public.organization_relationships r
              -- Resolution is all-or-nothing per participant. The lateral
              -- returns a node id only when the participant resolves to
              -- EXACTLY ONE admitted node of this chart, so an ambiguous
              -- person-node mapping omits the edge instead of fanning it out
              -- into several lines the member cannot account for.
              cross join lateral (
                select case when pg_catalog.count(*) = 1 then (pg_catalog.array_agg(n.id))[1] end as node_id
                from public.organization_chart_nodes n
                where n.organization_id = r.organization_id
                  and n.chart_kind = k.chart_kind
                  and n.user_id = r.source_user_id
                  and (n.chapter_id is null or n.chapter_id = caller_chapter)
              ) src
              cross join lateral (
                select case when pg_catalog.count(*) = 1 then (pg_catalog.array_agg(n.id))[1] end as node_id
                from public.organization_chart_nodes n
                where n.organization_id = r.organization_id
                  and n.chart_kind = k.chart_kind
                  and n.user_id = r.target_user_id
                  and (n.chapter_id is null or n.chapter_id = caller_chapter)
              ) tgt
              -- Allow-list, inside the projection. Adding a kind here is a
              -- reviewed schema/flag change, never a client filter.
              where r.organization_id = org
                and r.relationship_kind = 'reports_to'
                and src.node_id is not null
                and tgt.node_id is not null
              order by r.id
              limit 5000
            ) e
          ), '[]'::jsonb)
        ) as chart
        from (values ('agency'), ('union')) as k(chart_kind)
      ) charts
    ), '[]'::jsonb)
  );
end;
$$;

commit;
