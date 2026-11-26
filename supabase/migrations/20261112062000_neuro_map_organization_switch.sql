-- REQ-UG-NEURO-MAP-ORGANIZATION-SWITCH-20261112 (#8437).
--
-- The Neuro Map (the relationships tab of the organization map) had no
-- organization switch, only its two add-ons did
-- (20261002153000_neuro_map_derived_graph.sql). A feature needs a switch
-- before it can be turned off for an organization or held for a dated
-- release, so this adds one and makes the server honour it:
--
--   * features.intelligence.neuro_map: boolean, category intelligence,
--     default on, organization-editable, member-visible (the web and native
--     apps read it to hide the tab), sorted just before the two add-ons.
--   * public.get_organization_intelligence_snapshot: with the switch off the
--     snapshot carries no relationship members, relationships or topic
--     progress; charts and timeline are unchanged.
--   * public.get_organization_derived_graph: with the switch off the derived
--     connections and automatic topic readiness add-ons read as off whatever
--     their stored values, so no derived edge or readiness count is returned.
--
-- Default on, so nothing changes for any organization today. Holding the
-- switch for a release date is a later data-only migration
-- (REQ-UG-PLATFORM-RELEASE-HOLD-ON-ORGANIZATION-SWITCHES-20261112).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_derived_graph(text)'::regprocedure)) <> '6c9e5e69e429ef7c21d093b58f1ee142' then
    raise exception 'unreviewed predecessor: public.get_organization_derived_graph(text)' using errcode = '55000';
  end if;
  if exists (
    select 1 from private.account_lifecycle_trigger_review
    where kind = 'function' and schema_name = 'public' and table_name = ''
      and object_name = 'get_organization_derived_graph(p_selected_hat text)'
      and definition_hash <> '6c9e5e69e429ef7c21d093b58f1ee142'
  ) then
    raise exception 'stale trigger receipt: public.get_organization_derived_graph(text)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_organization_intelligence_snapshot(text)'::regprocedure) <> '68423817af866a3f92fb20ff569cefb9' then
    raise exception 'unreviewed predecessor: public.get_organization_intelligence_snapshot(text)' using errcode = '55000';
  end if;
end;
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. The switch.
insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible, organization_editable)
values
  ('features.intelligence.neuro_map', 'boolean', 'Neuro Map',
   'Show the Neuro Map tab of the organization map: working relationships between members and their topic progress. Off hides it on the web and in the phone apps.',
   'true', null, null, null, 205, 'intelligence', true, true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The snapshot that feeds the Neuro Map tab.
create or replace function public.get_organization_intelligence_snapshot(p_selected_hat text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  neuro_on boolean;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_selected_hat not in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- REQ-UG-NEURO-MAP-ORGANIZATION-SWITCH-20261112: with the Neuro Map
  -- switched off no relationship graph and no topic progress leave the server.
  neuro_on := private.organization_feature_enabled(org, 'features.intelligence.neuro_map') is true;
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', pg_catalog.now(),
    'neuroMapEnabled', neuro_on,
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
        where neuro_on and m.organization_id = org and m.status = 'active'
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
        where neuro_on and scoped.organization_id = org
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
        where neuro_on and scoped.organization_id = org
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

-- ---------------------------------------------------------------------------
-- 3. The derived connections and automatic topic readiness add-ons.
CREATE OR REPLACE FUNCTION public.get_organization_derived_graph(p_selected_hat text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.mi1_require_selected_organization();
  neuro_on boolean;
  derived_on boolean;
  progress_on boolean;
  floor_size integer;
  edges jsonb := '[]'::jsonb;
  readiness jsonb := '[]'::jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  -- Same hats as get_organization_intelligence_snapshot.
  if p_selected_hat not in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- REQ-UG-NEURO-MAP-ORGANIZATION-SWITCH-20261112: with the Neuro Map
  -- switched off the two add-ons read as off, whatever their stored values.
  neuro_on := private.organization_feature_enabled(org, 'features.intelligence.neuro_map') is true;
  derived_on := neuro_on and private.organization_feature_enabled(org, 'features.intelligence.neuro_map_derived_graph') is true;
  progress_on := neuro_on and private.organization_feature_enabled(org, 'features.intelligence.neuro_map_auto_progress') is true;
  floor_size := greatest(5, coalesce(private.organization_limit(org, 'limits.intelligence.neuro_map_topic_min_members'), 5));

  if derived_on then
    with visible_cases as (
      select c.id, c.user_id, c.steward_user_id, c.coordinator_user_id, c.case_type, c.articles
      from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
      join public.organization_memberships m
        on m.organization_id = org and m.user_id = c.user_id and m.status = 'active'
      where c.organization_id = org
        and c.status = 'active'
        and private.casework_staff_can_read(c.id)
    ),
    represents as (
      select staff_id as source_id, vc.user_id as target_id, pg_catalog.count(*)::integer as cases
      from visible_cases vc
      cross join lateral (values (vc.steward_user_id), (vc.coordinator_user_id)) as staff(staff_id)
      join public.organization_memberships sm
        on sm.organization_id = org and sm.user_id = staff.staff_id and sm.status = 'active'
      where staff.staff_id is not null and staff.staff_id <> vc.user_id
      group by staff_id, vc.user_id
    ),
    concepts as (
      select distinct vc.user_id, concept
      from visible_cases vc
      cross join lateral pg_catalog.unnest(
        array[pg_catalog.lower(pg_catalog.btrim(coalesce(vc.case_type, '')))] || private.neuro_map_article_concepts(vc.articles)
      ) as concept
      where concept <> '' and concept <> 'other'
    ),
    bounded_concepts as (
      select concept from concepts group by concept having pg_catalog.count(*) between 2 and 12
    ),
    shares as (
      select least(a.user_id, b.user_id) as source_id, greatest(a.user_id, b.user_id) as target_id,
        pg_catalog.count(distinct a.concept)::integer as shared
      from concepts a
      join concepts b on b.concept = a.concept and a.user_id < b.user_id
      join bounded_concepts bc on bc.concept = a.concept
      group by 1, 2
    ),
    all_edges as (
      select 'represents' as kind, r.source_id, r.target_id, least(5, r.cases) as strength from represents r
      union all
      select 'shares_issue', s.source_id, s.target_id, least(5, s.shared) from shares s
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', 'derived:' || e.kind || ':' || e.source_id || ':' || e.target_id,
      'kind', e.kind, 'sourceId', e.source_id, 'targetId', e.target_id, 'strength', e.strength
    ) order by e.kind, e.strength desc, e.source_id, e.target_id), '[]'::jsonb)
    into edges
    from (select * from all_edges order by kind, strength desc, source_id, target_id limit 500) e;
  end if;

  if progress_on then
    with lesson_progress as (
      select l.id as lesson_id, l.label, l.order_index,
        case
          when pg_catalog.jsonb_array_length(l.steps) > 0
            and pg_catalog.cardinality(p.completed_steps) >= pg_catalog.jsonb_array_length(l.steps) then 'ready'
          when pg_catalog.jsonb_array_length(l.steps) > 0
            and pg_catalog.cardinality(p.completed_steps) * 2 >= pg_catalog.jsonb_array_length(l.steps) then 'developing'
          else 'introduced' end as state
      from public.member_rights_progress p
      join public.member_rights_lessons l on l.id = p.lesson_id
      join public.organization_memberships m
        on m.organization_id = org and m.user_id = p.user_id and m.status = 'active'
    ),
    per_lesson as (
      select lesson_id, label, order_index,
        pg_catalog.count(*)::integer as members,
        pg_catalog.count(*) filter (where state = 'introduced')::integer as introduced,
        pg_catalog.count(*) filter (where state = 'developing')::integer as developing,
        pg_catalog.count(*) filter (where state = 'ready')::integer as ready
      from lesson_progress
      group by lesson_id, label, order_index
      having pg_catalog.count(*) >= floor_size
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'topicKey', 'rights-' || pg_catalog.left(pg_catalog.md5(pl.lesson_id), 12),
      'topicLabel', pl.label,
      'members', pl.members, 'introduced', pl.introduced, 'developing', pl.developing, 'ready', pl.ready
    ) order by pl.order_index, pl.label), '[]'::jsonb)
    into readiness
    from per_lesson pl;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'neuroMapEnabled', neuro_on,
    'derivedEnabled', derived_on,
    'autoProgressEnabled', progress_on,
    'edges', edges,
    'topicReadiness', readiness
  );
end;
$function$
;

-- CREATE OR REPLACE keeps both functions' authenticated-only ACLs.
-- Renew an existing reviewed account-lifecycle receipt; never add a receipt.
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
  from pg_catalog.pg_proc p
 where reviewed.kind = 'function' and reviewed.table_name = ''
   and p.oid in ('public.get_organization_derived_graph(text)'::regprocedure,
                 'public.get_organization_intelligence_snapshot(text)'::regprocedure)
   and reviewed.schema_name = p.pronamespace::regnamespace::text
   and reviewed.object_name = p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')';
commit;
