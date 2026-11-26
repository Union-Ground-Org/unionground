-- Versioned migration, dependent on earlier versions in this delivery.
--
-- REQ-UG-MEMBER-ORG-STRUCTURE-VIEW-20260922. This file depends on the
-- person-node identity column public.organization_chart_nodes.user_id, created
-- by 20260924170000_organization_structure_import.sql
-- (REQ-UG-ORG-CHART-LOVABLE-DATA-LAYOUT-IMPORT-20260922). The
-- import migration owns these columns and tables.
--
-- Order: 20260924170000_organization_structure_import (creates user_id) ->
-- 20260924170100_appointment_organization_boundary ->
-- 20260924170200_member_steward_roster_and_contact -> this file.

begin;

set local lock_timeout = '5s';

-- The member's read-only projection of both chart kinds.
--
-- It is a SEPARATE function from get_organization_intelligence_snapshot, which
-- is untouched and still refuses the member hat. Three scoping rules the staff
-- snapshot does not have:
--
--   * chapter as well as organization, so a sibling chapter's people never
--     enter the projection;
--   * reports_to only, as an allow-list inside this function -- the table also
--     carries works_with, mentors, organizes_with and trusted_contact, none of
--     which is org-chart structure and none of which a member may read here;
--   * an edge appears only when BOTH participants resolve, through
--     organization_chart_nodes.user_id, to admitted nodes of the SAME chart.
--     An agency person who is not an application member, or a node in another
--     chapter, omits the edge. Participants are never matched by display text.
--
-- user_id itself is never projected. Edges leave as node-id pairs, so the
-- client cannot re-derive who a node is.
create function public.get_member_organization_structure()
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
              'sourceAsOf', n.source_as_of
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

-- DELIBERATELY NOT PROJECTED in v1, and each for a stated reason:
--
--   * organization_chart_node_contacts -- the import lane marks
--     contact_visibility = 'members' rows as member-safe, but "may
--     employer-domain addresses be published to members" is an OPEN OWNER
--     DECISION on the import record. Publishing an address on an open owner
--     decision is not a default this lane may take. When it is decided, the
--     projection adds them with confirmation_state carried through, because
--     hiding an unconfirmed marker presents a stale contact as verified.
--   * organization_timeline_events payroll_snapshot rows -- staff-visible only
--     in v1 by the import lane's own constraint. This function reads no
--     timeline events at all, so there is no path for one to reach a member.
--   * node notes, metrics and cross-references -- organization content this
--     record's acceptance does not name. A later record may add them under the
--     same organization and chapter scoping; cross-references would need the
--     boundary copy the import contract requires.

revoke all on function public.get_member_organization_structure() from public, anon;
grant execute on function public.get_member_organization_structure() to authenticated;

comment on function public.get_member_organization_structure() is
  'Member-safe read-only organization chart. Scoped to the caller''s own organization AND '
  'chapter, reports_to edges only, participants resolved through organization_chart_nodes.user_id '
  'to nodes of the same chart. Never projects user_id. get_organization_intelligence_snapshot is '
  'unchanged and still excludes the member hat.';

commit;
