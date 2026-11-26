-- CR-047, CR-048, CR-050, CR-051, CR-052: tenant-safe organization
-- intelligence, Digital Picket Line, and protected participant exports.
-- Version 20260829002000 follows the merged Voice SAMPLE repair migration.
--
-- Donor donor-baseline-20260721 is behavior-only. This
-- migration does not replay the donor's global-readable action tables,
-- organization-specific static charts, real-world payroll data, service-role
-- loaders, project identifiers, credentials, dependencies, or migration
-- history. New organizations remain empty.

set local lock_timeout = '5s';

create unique index if not exists chapters_organization_id_id_key
  on public.chapters (organization_id, id);

create table public.organization_chart_nodes (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text,
  chart_kind text not null check (chart_kind in ('agency', 'union')),
  node_kind text not null check (node_kind in ('organization', 'division', 'chapter', 'team', 'role', 'person')),
  parent_id uuid,
  label text not null,
  subtitle text,
  position_x integer not null default 0 check (position_x between -10000 and 10000),
  position_y integer not null default 0 check (position_y between -10000 and 10000),
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, id),
  foreign key (organization_id, parent_id)
    references public.organization_chart_nodes(organization_id, id) on delete restrict,
  foreign key (organization_id, chapter_id)
    references public.chapters(organization_id, id) on update cascade on delete restrict,
  constraint organization_chart_nodes_label_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(label)) between 1 and 160
    and label !~ '[[:cntrl:]]'
  ),
  constraint organization_chart_nodes_subtitle_bounded check (
    subtitle is null or (
      pg_catalog.char_length(pg_catalog.btrim(subtitle)) between 1 and 240
      and subtitle !~ '[[:cntrl:]]'
    )
  ),
  constraint organization_chart_nodes_not_own_parent check (parent_id is distinct from id)
);

create index organization_chart_nodes_org_kind_sort_idx
  on public.organization_chart_nodes (organization_id, chart_kind, sort_order, label);

create table public.organization_relationships (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  source_user_id uuid not null,
  target_user_id uuid not null,
  relationship_kind text not null check (relationship_kind in (
    'reports_to', 'works_with', 'mentors', 'organizes_with', 'trusted_contact'
  )),
  strength smallint not null default 1 check (strength between 1 and 5),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  foreign key (organization_id, source_user_id)
    references public.organization_memberships(organization_id, user_id) on delete restrict,
  foreign key (organization_id, target_user_id)
    references public.organization_memberships(organization_id, user_id) on delete restrict,
  constraint organization_relationships_distinct_users check (source_user_id <> target_user_id),
  unique (organization_id, source_user_id, target_user_id, relationship_kind)
);

create index organization_relationships_org_source_idx
  on public.organization_relationships (organization_id, source_user_id, updated_at desc);
create index organization_relationships_org_target_idx
  on public.organization_relationships (organization_id, target_user_id, updated_at desc);

create table public.organization_topic_progress (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  member_user_id uuid not null,
  topic_key text not null,
  topic_label text not null,
  progress_state text not null check (progress_state in ('introduced', 'developing', 'ready')),
  progress smallint not null default 0 check (progress between 0 and 100),
  updated_by uuid not null references auth.users(id) on delete restrict,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, member_user_id, topic_key),
  foreign key (organization_id, member_user_id)
    references public.organization_memberships(organization_id, user_id) on delete restrict,
  constraint organization_topic_progress_key_format check (topic_key ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  constraint organization_topic_progress_label_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(topic_label)) between 1 and 160
    and topic_label !~ '[[:cntrl:]]'
  )
);

create index organization_topic_progress_org_updated_idx
  on public.organization_topic_progress (organization_id, updated_at desc);

create table public.organization_timeline_events (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text,
  event_kind text not null check (event_kind in ('leadership_term', 'payroll_snapshot')),
  title text not null,
  detail text,
  effective_on date not null,
  ended_on date,
  amount_cents bigint check (amount_cents is null or amount_cents between 0 and 1000000000000000),
  amount_basis text,
  source_label text,
  source_as_of date,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  foreign key (organization_id, chapter_id)
    references public.chapters(organization_id, id) on update cascade on delete restrict,
  constraint organization_timeline_events_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 180
    and title !~ '[[:cntrl:]]'
  ),
  constraint organization_timeline_events_detail_bounded check (
    detail is null or pg_catalog.char_length(detail) between 1 and 2000
  ),
  constraint organization_timeline_events_date_order check (ended_on is null or ended_on >= effective_on),
  constraint organization_timeline_events_payroll_complete check (
    event_kind <> 'payroll_snapshot'
    or (
      amount_cents is not null
      and amount_basis is not null
      and pg_catalog.char_length(pg_catalog.btrim(amount_basis)) between 1 and 80
      and source_label is not null
      and pg_catalog.char_length(pg_catalog.btrim(source_label)) between 1 and 180
      and source_as_of is not null
    )
  )
);

create index organization_timeline_events_org_effective_idx
  on public.organization_timeline_events (organization_id, effective_on desc, id desc);

create table public.digital_actions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text,
  action_kind text not null check (action_kind in ('petition', 'rally', 'picket', 'meeting', 'other')),
  title text not null,
  summary text not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'closed', 'cancelled')),
  target_count integer not null default 100 check (target_count between 1 and 1000000),
  starts_at timestamptz,
  ends_at timestamptz,
  published_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, id),
  foreign key (organization_id, chapter_id)
    references public.chapters(organization_id, id) on update cascade on delete restrict,
  constraint digital_actions_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 3 and 180
    and title !~ '[[:cntrl:]]'
  ),
  constraint digital_actions_summary_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(summary)) between 3 and 2000
  ),
  constraint digital_actions_date_order check (ends_at is null or starts_at is null or ends_at >= starts_at),
  constraint digital_actions_publish_complete check (
    (status = 'draft' and published_at is null)
    or (status <> 'draft' and published_at is not null)
  )
);

create index digital_actions_org_status_start_idx
  on public.digital_actions (organization_id, status, starts_at desc nulls last, created_at desc);

create table public.digital_action_participants (
  organization_id uuid not null,
  action_id uuid not null,
  user_id uuid not null,
  participation_kind text not null check (participation_kind in ('signature', 'attendee', 'volunteer')),
  joined_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (action_id, user_id),
  foreign key (organization_id, action_id)
    references public.digital_actions(organization_id, id) on delete cascade,
  foreign key (organization_id, user_id)
    references public.organization_memberships(organization_id, user_id) on delete cascade
);

create index digital_action_participants_org_action_kind_idx
  on public.digital_action_participants (organization_id, action_id, participation_kind, joined_at);

create table public.digital_action_exports (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  action_id uuid not null,
  participation_kind text not null check (participation_kind in ('signature', 'attendee', 'volunteer')),
  row_count integer not null check (row_count between 0 and 10000),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  foreign key (organization_id, action_id)
    references public.digital_actions(organization_id, id) on delete restrict,
  constraint digital_action_exports_expiry check (
    expires_at > created_at and expires_at <= created_at + interval '24 hours 1 minute'
  )
);

create index digital_action_exports_org_created_idx
  on public.digital_action_exports (organization_id, created_at desc);

create table public.organization_intelligence_audit_events (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  event_type text not null check (event_type in (
    'chart_node_saved', 'relationship_saved', 'topic_progress_saved',
    'timeline_event_saved', 'digital_action_saved',
    'digital_action_participation_joined', 'digital_action_participation_withdrawn',
    'digital_action_export_requested'
  )),
  entity_kind text not null check (entity_kind in (
    'chart_node', 'relationship', 'topic_progress', 'timeline_event',
    'digital_action', 'digital_action_participation', 'digital_action_export'
  )),
  entity_id text not null check (pg_catalog.char_length(entity_id) between 1 and 160),
  actor_user_id uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  constraint organization_intelligence_audit_metadata_object check (pg_catalog.jsonb_typeof(metadata) = 'object'),
  constraint organization_intelligence_audit_metadata_bounded check (pg_catalog.octet_length(metadata::text) <= 1024),
  constraint organization_intelligence_audit_metadata_keys check (
    metadata - array[
      'chartKind', 'nodeKind', 'relationshipKind', 'topicKey', 'progressState',
      'eventKind', 'actionKind', 'status', 'participationKind', 'rowCount',
      'expiresAt', 'chapterId'
    ] = '{}'::jsonb
  )
);

create index organization_intelligence_audit_org_created_idx
  on public.organization_intelligence_audit_events (organization_id, created_at desc, id desc);

alter table public.organization_chart_nodes enable row level security;
alter table public.organization_relationships enable row level security;
alter table public.organization_topic_progress enable row level security;
alter table public.organization_timeline_events enable row level security;
alter table public.digital_actions enable row level security;
alter table public.digital_action_participants enable row level security;
alter table public.digital_action_exports enable row level security;
alter table public.organization_intelligence_audit_events enable row level security;

create policy mfa_assurance on public.organization_chart_nodes
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_relationships
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_topic_progress
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_timeline_events
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.digital_actions
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.digital_action_participants
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.digital_action_exports
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_intelligence_audit_events
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on public.organization_chart_nodes from public, anon, authenticated, service_role;
revoke all on public.organization_relationships from public, anon, authenticated, service_role;
revoke all on public.organization_topic_progress from public, anon, authenticated, service_role;
revoke all on public.organization_timeline_events from public, anon, authenticated, service_role;
revoke all on public.digital_actions from public, anon, authenticated, service_role;
revoke all on public.digital_action_participants from public, anon, authenticated, service_role;
revoke all on public.digital_action_exports from public, anon, authenticated, service_role;
revoke all on public.organization_intelligence_audit_events from public, anon, authenticated, service_role;

create function private.write_organization_intelligence_audit(
  p_organization_id uuid,
  p_event_type text,
  p_entity_kind text,
  p_entity_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.organization_intelligence_audit_events (
    organization_id, event_type, entity_kind, entity_id, actor_user_id, metadata
  ) values (
    p_organization_id, p_event_type, p_entity_kind, p_entity_id,
    (select auth.uid()), coalesce(p_metadata, '{}'::jsonb)
  );
end;
$function$;

revoke all on function private.write_organization_intelligence_audit(uuid, text, text, text, jsonb)
  from public, anon, authenticated, service_role;

create function public.get_organization_intelligence_snapshot(p_selected_hat text)
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
        'sortOrder', n.sort_order
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

create function public.get_collective_actions(
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
  total_count integer;
  action_rows jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  manager := p_selected_hat in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
    and private.has_organization_role(org, array[p_selected_hat]);
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
    'viewerParticipation', mine.participation_kind
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

create function public.save_organization_chart_node(
  p_selected_hat text,
  p_id uuid,
  p_chart_kind text,
  p_node_kind text,
  p_parent_id uuid,
  p_chapter_id text,
  p_label text,
  p_subtitle text,
  p_position_x integer,
  p_position_y integer,
  p_sort_order integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  caller uuid := (select auth.uid());
  record_id uuid := coalesce(p_id, extensions.gen_random_uuid());
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_selected_hat not in ('advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_chart_kind not in ('agency', 'union')
     or p_node_kind not in ('organization', 'division', 'chapter', 'team', 'role', 'person')
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_label, ''))) not between 1 and 160
     or coalesce(p_position_x, 0) not between -10000 and 10000
     or coalesce(p_position_y, 0) not between -10000 and 10000
     or coalesce(p_sort_order, 0) not between -100000 and 100000 then
    raise exception 'invalid chart node' using errcode = '22023';
  end if;
  if p_chapter_id is not null and not exists (
    select 1 from public.chapters c where c.id = p_chapter_id and c.organization_id = org
  ) then raise exception 'invalid chapter' using errcode = '22023'; end if;
  if p_parent_id is not null and not exists (
    select 1 from public.organization_chart_nodes n
    where n.id = p_parent_id and n.organization_id = org and n.chart_kind = p_chart_kind
  ) then raise exception 'invalid chart parent' using errcode = '22023'; end if;
  if p_id is not null and not exists (
    select 1 from public.organization_chart_nodes n where n.id = p_id and n.organization_id = org
  ) then raise exception 'chart node not found' using errcode = 'P0002'; end if;
  if p_id is not null and exists (
    select 1 from public.organization_chart_nodes child
    where child.organization_id = org
      and child.parent_id = p_id
      and child.chart_kind <> p_chart_kind
  ) then raise exception 'chart kind change rejected while node has children' using errcode = '22023'; end if;
  if p_id is not null and p_parent_id is not null and exists (
    with recursive ancestors as (
      select n.id, n.parent_id from public.organization_chart_nodes n
      where n.id = p_parent_id and n.organization_id = org
      union all
      select n.id, n.parent_id from public.organization_chart_nodes n
      join ancestors a on n.id = a.parent_id
      where n.organization_id = org
    ) select 1 from ancestors where id = p_id
  ) then raise exception 'chart cycle rejected' using errcode = '22023'; end if;

  insert into public.organization_chart_nodes (
    id, organization_id, chapter_id, chart_kind, node_kind, parent_id, label,
    subtitle, position_x, position_y, sort_order, created_by, updated_by
  ) values (
    record_id, org, p_chapter_id, p_chart_kind, p_node_kind, p_parent_id,
    pg_catalog.btrim(p_label), nullif(pg_catalog.btrim(coalesce(p_subtitle, '')), ''),
    coalesce(p_position_x, 0), coalesce(p_position_y, 0), coalesce(p_sort_order, 0), caller, caller
  ) on conflict (id) do update set
    chapter_id = excluded.chapter_id,
    chart_kind = excluded.chart_kind,
    node_kind = excluded.node_kind,
    parent_id = excluded.parent_id,
    label = excluded.label,
    subtitle = excluded.subtitle,
    position_x = excluded.position_x,
    position_y = excluded.position_y,
    sort_order = excluded.sort_order,
    updated_by = caller,
    updated_at = pg_catalog.now()
  where organization_chart_nodes.organization_id = org;
  perform private.write_organization_intelligence_audit(
    org, 'chart_node_saved', 'chart_node', record_id::text,
    pg_catalog.jsonb_build_object('chartKind', p_chart_kind, 'nodeKind', p_node_kind, 'chapterId', p_chapter_id)
  );
  return pg_catalog.jsonb_build_object('id', record_id, 'organizationId', org);
end;
$function$;

create function public.save_organization_relationship(
  p_selected_hat text,
  p_id uuid,
  p_source_user_id uuid,
  p_target_user_id uuid,
  p_relationship_kind text,
  p_strength integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  caller uuid := (select auth.uid());
  record_id uuid := coalesce(p_id, extensions.gen_random_uuid());
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_selected_hat not in ('advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_source_user_id is null or p_target_user_id is null or p_source_user_id = p_target_user_id
     or p_relationship_kind not in ('reports_to', 'works_with', 'mentors', 'organizes_with', 'trusted_contact')
     or coalesce(p_strength, 0) not between 1 and 5 then
    raise exception 'invalid relationship' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = org and m.user_id = p_source_user_id and m.status = 'active'
  ) or not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = org and m.user_id = p_target_user_id and m.status = 'active'
  ) then raise exception 'relationship member out of scope' using errcode = '42501'; end if;
  if p_id is not null and not exists (
    select 1 from public.organization_relationships r where r.id = p_id and r.organization_id = org
  ) then raise exception 'relationship not found' using errcode = 'P0002'; end if;
  insert into public.organization_relationships (
    id, organization_id, source_user_id, target_user_id, relationship_kind,
    strength, created_by, updated_by
  ) values (
    record_id, org, p_source_user_id, p_target_user_id, p_relationship_kind,
    p_strength, caller, caller
  ) on conflict (id) do update set
    source_user_id = excluded.source_user_id,
    target_user_id = excluded.target_user_id,
    relationship_kind = excluded.relationship_kind,
    strength = excluded.strength,
    updated_by = caller,
    updated_at = pg_catalog.now()
  where organization_relationships.organization_id = org;
  perform private.write_organization_intelligence_audit(
    org, 'relationship_saved', 'relationship', record_id::text,
    pg_catalog.jsonb_build_object('relationshipKind', p_relationship_kind)
  );
  return pg_catalog.jsonb_build_object('id', record_id, 'organizationId', org);
end;
$function$;

create function public.save_organization_topic_progress(
  p_selected_hat text,
  p_member_user_id uuid,
  p_topic_key text,
  p_topic_label text,
  p_progress_state text,
  p_progress integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_selected_hat not in ('advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_topic_key !~ '^[a-z0-9][a-z0-9_-]{0,79}$'
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_topic_label, ''))) not between 1 and 160
     or p_progress_state not in ('introduced', 'developing', 'ready')
     or coalesce(p_progress, -1) not between 0 and 100 then
    raise exception 'invalid topic progress' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = org and m.user_id = p_member_user_id and m.status = 'active'
  ) then raise exception 'topic member out of scope' using errcode = '42501'; end if;
  insert into public.organization_topic_progress (
    organization_id, member_user_id, topic_key, topic_label, progress_state,
    progress, updated_by
  ) values (
    org, p_member_user_id, p_topic_key, pg_catalog.btrim(p_topic_label),
    p_progress_state, p_progress, (select auth.uid())
  ) on conflict (organization_id, member_user_id, topic_key) do update set
    topic_label = excluded.topic_label,
    progress_state = excluded.progress_state,
    progress = excluded.progress,
    updated_by = (select auth.uid()),
    updated_at = pg_catalog.now();
  perform private.write_organization_intelligence_audit(
    org, 'topic_progress_saved', 'topic_progress', p_member_user_id::text || ':' || p_topic_key,
    pg_catalog.jsonb_build_object('topicKey', p_topic_key, 'progressState', p_progress_state)
  );
  return pg_catalog.jsonb_build_object('memberId', p_member_user_id, 'topicKey', p_topic_key, 'organizationId', org);
end;
$function$;

create function public.save_organization_timeline_event(
  p_selected_hat text,
  p_id uuid,
  p_chapter_id text,
  p_event_kind text,
  p_title text,
  p_detail text,
  p_effective_on date,
  p_ended_on date,
  p_amount_cents bigint,
  p_amount_basis text,
  p_source_label text,
  p_source_as_of date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  caller uuid := (select auth.uid());
  record_id uuid := coalesce(p_id, extensions.gen_random_uuid());
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_selected_hat not in ('advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_event_kind not in ('leadership_term', 'payroll_snapshot')
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title, ''))) not between 1 and 180
     or p_effective_on is null or (p_ended_on is not null and p_ended_on < p_effective_on)
     or (p_amount_cents is not null and p_amount_cents not between 0 and 1000000000000000) then
    raise exception 'invalid timeline event' using errcode = '22023';
  end if;
  if p_event_kind = 'payroll_snapshot' and (
    p_amount_cents is null
    or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_amount_basis, ''))) not between 1 and 80
    or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_source_label, ''))) not between 1 and 180
    or p_source_as_of is null
  ) then raise exception 'payroll source is required' using errcode = '22023'; end if;
  if p_chapter_id is not null and not exists (
    select 1 from public.chapters c where c.id = p_chapter_id and c.organization_id = org
  ) then raise exception 'invalid chapter' using errcode = '22023'; end if;
  if p_id is not null and not exists (
    select 1 from public.organization_timeline_events e where e.id = p_id and e.organization_id = org
  ) then raise exception 'timeline event not found' using errcode = 'P0002'; end if;
  insert into public.organization_timeline_events (
    id, organization_id, chapter_id, event_kind, title, detail, effective_on,
    ended_on, amount_cents, amount_basis, source_label, source_as_of,
    created_by, updated_by
  ) values (
    record_id, org, p_chapter_id, p_event_kind, pg_catalog.btrim(p_title),
    nullif(pg_catalog.btrim(coalesce(p_detail, '')), ''), p_effective_on, p_ended_on,
    p_amount_cents, nullif(pg_catalog.btrim(coalesce(p_amount_basis, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_source_label, '')), ''), p_source_as_of,
    caller, caller
  ) on conflict (id) do update set
    chapter_id = excluded.chapter_id,
    event_kind = excluded.event_kind,
    title = excluded.title,
    detail = excluded.detail,
    effective_on = excluded.effective_on,
    ended_on = excluded.ended_on,
    amount_cents = excluded.amount_cents,
    amount_basis = excluded.amount_basis,
    source_label = excluded.source_label,
    source_as_of = excluded.source_as_of,
    updated_by = caller,
    updated_at = pg_catalog.now()
  where organization_timeline_events.organization_id = org;
  perform private.write_organization_intelligence_audit(
    org, 'timeline_event_saved', 'timeline_event', record_id::text,
    pg_catalog.jsonb_build_object('eventKind', p_event_kind, 'chapterId', p_chapter_id)
  );
  return pg_catalog.jsonb_build_object('id', record_id, 'organizationId', org);
end;
$function$;

create function public.save_digital_action(
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
declare
  org uuid := private.mi1_require_selected_organization();
  caller uuid := (select auth.uid());
  record_id uuid := coalesce(p_id, extensions.gen_random_uuid());
  published timestamptz;
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
  if p_id is not null and not exists (
    select 1 from public.digital_actions a where a.id = p_id and a.organization_id = org
  ) then raise exception 'digital action not found' using errcode = 'P0002'; end if;
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
$function$;

create function public.toggle_digital_action_participation(
  p_action_id uuid,
  p_participation_kind text,
  p_joined boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
    'participantCount', participant_count
  );
end;
$function$;

create function public.request_digital_action_participant_export(
  p_selected_hat text,
  p_action_id uuid,
  p_participation_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  action_title text;
  result_rows jsonb;
  result_count integer;
  receipt_id uuid;
  expires timestamptz := pg_catalog.now() + interval '24 hours';
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_selected_hat not in ('coordinator', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_action_id is null or p_participation_kind not in ('signature', 'attendee', 'volunteer') then
    raise exception 'invalid export request' using errcode = '22023';
  end if;
  select a.title into action_title from public.digital_actions a
  where a.id = p_action_id and a.organization_id = org
  for share;
  if not found then raise exception 'digital action not found' using errcode = 'P0002'; end if;
  select pg_catalog.count(*)::integer into result_count
  from public.digital_action_participants p
  where p.organization_id = org and p.action_id = p_action_id
    and p.participation_kind = p_participation_kind;
  if result_count > 10000 then raise exception 'export row limit exceeded' using errcode = '54000'; end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'participationKind', p.participation_kind,
    'memberName', profile.full_name,
    'email', pg_catalog.lower(users.email),
    'chapterName', chapter.name,
    'joinedAt', p.joined_at
  ) order by profile.full_name, p.user_id), '[]'::jsonb) into result_rows
  from public.digital_action_participants p
  join public.member_profiles profile on profile.id = p.user_id
  join auth.users users on users.id = p.user_id
  left join public.chapters chapter
    on chapter.id = profile.chapter_id and chapter.organization_id = org
  where p.organization_id = org and p.action_id = p_action_id
    and p.participation_kind = p_participation_kind;
  delete from public.digital_action_exports receipt
  where receipt.organization_id = org and receipt.expires_at <= pg_catalog.now();
  insert into public.digital_action_exports (
    organization_id, action_id, participation_kind, row_count, created_by, expires_at
  ) values (
    org, p_action_id, p_participation_kind, result_count, (select auth.uid()), expires
  ) returning id into receipt_id;
  perform private.write_organization_intelligence_audit(
    org, 'digital_action_export_requested', 'digital_action_export', receipt_id::text,
    pg_catalog.jsonb_build_object(
      'participationKind', p_participation_kind, 'rowCount', result_count,
      'expiresAt', expires
    )
  );
  return pg_catalog.jsonb_build_object(
    'id', receipt_id, 'organizationId', org, 'actionId', p_action_id,
    'actionTitle', action_title, 'participationKind', p_participation_kind,
    'rowCount', result_count, 'expiresAt', expires, 'rows', result_rows
  );
end;
$function$;

revoke all on function public.get_organization_intelligence_snapshot(text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_collective_actions(text, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.save_organization_chart_node(text, uuid, text, text, uuid, text, text, text, integer, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.save_organization_relationship(text, uuid, uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.save_organization_topic_progress(text, uuid, text, text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.save_organization_timeline_event(text, uuid, text, text, text, text, date, date, bigint, text, text, date)
  from public, anon, authenticated, service_role;
revoke all on function public.save_digital_action(text, uuid, text, text, text, text, text, integer, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.toggle_digital_action_participation(uuid, text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.request_digital_action_participant_export(text, uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.get_organization_intelligence_snapshot(text) to authenticated;
grant execute on function public.get_collective_actions(text, integer, integer) to authenticated;
grant execute on function public.save_organization_chart_node(text, uuid, text, text, uuid, text, text, text, integer, integer, integer) to authenticated;
grant execute on function public.save_organization_relationship(text, uuid, uuid, uuid, text, integer) to authenticated;
grant execute on function public.save_organization_topic_progress(text, uuid, text, text, text, integer) to authenticated;
grant execute on function public.save_organization_timeline_event(text, uuid, text, text, text, text, date, date, bigint, text, text, date) to authenticated;
grant execute on function public.save_digital_action(text, uuid, text, text, text, text, text, integer, timestamptz, timestamptz) to authenticated;
grant execute on function public.toggle_digital_action_participation(uuid, text, boolean) to authenticated;
grant execute on function public.request_digital_action_participant_export(text, uuid, text) to authenticated;

comment on table public.organization_chart_nodes is
  'Tenant-scoped agency/union chart nodes with persisted layout. Direct browser table access is denied.';
comment on table public.organization_relationships is
  'Staff-only explicit relationship graph. Never returned to member hats.';
comment on table public.organization_timeline_events is
  'Organization-provided leadership and aggregate payroll timeline. Empty by default; no donor payroll is seeded.';
comment on table public.digital_action_participants is
  'Private participant identities. Member reads receive only aggregate counts and the caller own state through RPC.';
