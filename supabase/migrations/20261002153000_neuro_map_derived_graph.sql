-- REQ-UG-NEURO-MAP-DERIVED-GRAPH-20261001 (CR-048)
--
-- Restores the self-building part of the old Neuro Map
-- (de7df4b57c^:lib/neuro-map/graph.ts and app/m/neuro-map/actions.ts) on top
-- of today's hand-entered organization relationships and topic progress
-- (20260829002000_organization_intelligence_collective_actions.sql:586-695).
-- Manual editing is unchanged; derived rows are computed on read, never
-- stored, and never overwrite a hand-entered row.
--
-- Derived edges (old graph.ts addGrievance): a steward or coordinator handling
-- a member's case "represents" that member; members whose cases share a
-- category or a cited contract article "share an issue" (the old concept
-- nodes, collapsed onto people). Only cases the caller may already open
-- (private.casework_staff_can_access) contribute, so restricted cases and
-- cases outside the caller's casework scope never appear. A shared issue
-- links at most 12 members and the response at most 500 derived edges.
--
-- Automatic topic progress (old actions.ts markNeuroMapTopicProgress):
-- members' own Know-your-rights lesson progress becomes topic readiness.
-- That progress is self-only today (member_rights_progress RLS), so staff see
-- it only as per-lesson counts (introduced / developing / ready) once at
-- least limits.intelligence.neuro_map_topic_min_members members (never fewer
-- than 5) have started the lesson. No member's individual progress is shown.
--
-- Defaults follow the old effective production default: the Neuro Map was
-- default-OFF (de7df4b57c^:lib/settings/feature-flags.ts:42-47
-- neuro_map_enabled), so both switches start off.

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.intelligence.neuro_map_derived_graph', 'boolean', 'Neuro Map derived connections',
   'Add connections the map can derive from casework (who represents whom, members sharing an issue) beside hand-entered relationships.',
   'false', null, null, null, 210, 'intelligence', false),
  ('features.intelligence.neuro_map_auto_progress', 'boolean', 'Neuro Map automatic topic readiness',
   'Show topic readiness built from members'' own Know-your-rights lesson progress, as counts only.',
   'false', null, null, null, 220, 'intelligence', false),
  ('limits.intelligence.neuro_map_topic_min_members', 'integer', 'Topic readiness privacy floor',
   'Fewest members who must have started a lesson before its automatic readiness counts appear. Never below 5.',
   '5', 5, 500, null, 230, 'intelligence', false)
on conflict (key) do nothing;

-- Comma, semicolon or newline separated cited articles become concept keys.
create function private.neuro_map_article_concepts(p_articles text)
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select coalesce(pg_catalog.array_agg(distinct concept), array[]::text[])
  from (
    select pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(part), '\s+', ' ', 'g')) as concept
    from pg_catalog.regexp_split_to_table(pg_catalog.left(coalesce(p_articles, ''), 2000), '[,;\n]+') as part
  ) parts
  where pg_catalog.char_length(concept) between 1 and 80
$function$;

create function public.get_organization_derived_graph(p_selected_hat text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
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
  derived_on := private.organization_feature_enabled(org, 'features.intelligence.neuro_map_derived_graph');
  progress_on := private.organization_feature_enabled(org, 'features.intelligence.neuro_map_auto_progress');
  floor_size := greatest(5, coalesce(private.organization_limit(org, 'limits.intelligence.neuro_map_topic_min_members'), 5));

  if derived_on then
    with visible_cases as (
      select c.id, c.user_id, c.steward_user_id, c.coordinator_user_id, c.case_type, c.articles
      from public.member_cases c
      join public.organization_memberships m
        on m.organization_id = org and m.user_id = c.user_id and m.status = 'active'
      where c.organization_id = org
        and c.status = 'active'
        and private.casework_staff_can_access(c.id)
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
    'derivedEnabled', derived_on,
    'autoProgressEnabled', progress_on,
    'edges', edges,
    'topicReadiness', readiness
  );
end;
$function$;

revoke all on function private.neuro_map_article_concepts(text) from public, anon, authenticated, service_role;
revoke all on function public.get_organization_derived_graph(text) from public, anon, authenticated, service_role;
grant execute on function public.get_organization_derived_graph(text) to authenticated;

comment on function public.get_organization_derived_graph(text) is
  'REQ-UG-NEURO-MAP-DERIVED-GRAPH-20261001: derived Neuro Map connections from cases the caller may open, and automatic topic readiness as privacy-floored counts. Computed on read; manual relationships and topic progress are unchanged.';

notify pgrst, 'reload schema';

commit;
