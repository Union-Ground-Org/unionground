-- Migration 20260828230000: MI1 CR-040 through CR-044 self-only report card, organization health,
-- explorer, reusable chart layouts, and chapter charts.
--
-- Donor donor-baseline-20260721 was screened for
-- behavior only. This migration does not reuse its tenant assumptions,
-- credentials, project identifiers, authorization shortcuts, seed data, or
-- migration history. Production remains valid with zero organizations.

set local lock_timeout = '5s';

create table public.organization_analytics_layouts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('personal', 'chapter', 'organization')),
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  name text not null,
  spec jsonb not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_analytics_layouts_name_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(name)) between 1 and 80
    and name !~ '[[:cntrl:]]'
  ),
  constraint organization_analytics_layouts_spec_object check (
    pg_catalog.jsonb_typeof(spec) = 'object'
    and pg_catalog.octet_length(spec::text) <= 2048
  ),
  constraint organization_analytics_layouts_chapter_scope check (
    (scope = 'chapter' and chapter_id is not null)
    or (scope <> 'chapter' and chapter_id is null)
  )
);

create index organization_analytics_layouts_visible_idx
  on public.organization_analytics_layouts (organization_id, scope, chapter_id, updated_at desc);
create index organization_analytics_layouts_owner_idx
  on public.organization_analytics_layouts (owner_user_id, updated_at desc);

comment on table public.organization_analytics_layouts is
  'Reusable analytics presentation definitions only. Specs reference protected server datasets and never store member rows.';

create table public.organization_analytics_layout_events (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  layout_id uuid not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('created', 'updated', 'deleted')),
  scope text not null check (scope in ('personal', 'chapter', 'organization')),
  chapter_id text,
  occurred_at timestamptz not null default pg_catalog.now()
);

comment on table public.organization_analytics_layout_events is
  'Append-only, content-free history for analytics layout mutations.';

create table private.organization_analytics_idempotency_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null,
  operation text not null check (operation in ('save_layout', 'delete_layout')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb not null check (
    pg_catalog.jsonb_typeof(response) = 'object'
    and pg_catalog.octet_length(response::text) <= 4096
  ),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (user_id, idempotency_key)
);

alter table public.organization_analytics_layouts enable row level security;
alter table public.organization_analytics_layout_events enable row level security;

create policy organization_analytics_layouts_authorized_read
  on public.organization_analytics_layouts for select to authenticated
  using (
    private.has_organization_role(
      organization_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
    and (
      (scope = 'personal' and owner_user_id = (select auth.uid()))
      or scope = 'organization'
      or (
        scope = 'chapter'
        and exists (
          select 1 from public.chapters c
          where c.id = chapter_id and c.organization_id = organization_id
        )
      )
    )
  );

create policy mfa_assurance
  on public.organization_analytics_layouts as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy mfa_assurance
  on public.organization_analytics_layout_events as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

-- Layout and event writes are RPC-only. The events table intentionally has no
-- permissive client policy, so even tenant administrators cannot rewrite its history.
revoke all on public.organization_analytics_layouts from public, anon, authenticated, service_role;
revoke all on public.organization_analytics_layout_events from public, anon, authenticated, service_role;
revoke all on private.organization_analytics_idempotency_receipts from public, anon, authenticated, service_role;
grant select on public.organization_analytics_layouts to authenticated;

create function private.analytics_layout_spec_valid(p_spec jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_typeof(p_spec) = 'object'
    and p_spec - array['datasetId', 'chartType', 'title'] = '{}'::jsonb
    and p_spec ->> 'chartType' in ('bar', 'stacked_bar', 'line', 'area', 'table')
    and pg_catalog.char_length(p_spec ->> 'datasetId') between 3 and 80
    and (p_spec ->> 'datasetId') ~ '^(organization:[a-z-]+|chapter:[A-Za-z0-9_-]{1,40}:[a-z-]+)$'
    and pg_catalog.char_length(coalesce(p_spec ->> 'title', '')) <= 80
    and coalesce(p_spec ->> 'title', '') !~ '[[:cntrl:]]'
    and pg_catalog.octet_length(p_spec::text) <= 2048,
    false
  )
$function$;

create function public.get_my_analytics_report_card()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  event_count integer := 0;
  participation integer := 0;
  profile_readiness integer := 0;
  follow_through integer := 0;
  last_activity timestamptz;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if org is null then
    return pg_catalog.jsonb_build_object(
      'overall', null, 'generatedAt', pg_catalog.now(), 'signals', '[]'::jsonb
    );
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select pg_catalog.count(*)::integer, pg_catalog.max(e.occurred_at)
    into event_count, last_activity
  from public.organization_engagement_events e
  where e.organization_id = org
    and e.user_id = caller
    and e.occurred_at >= pg_catalog.now() - interval '180 days';

  if event_count = 0 then
    return pg_catalog.jsonb_build_object(
      'overall', null, 'generatedAt', pg_catalog.now(), 'signals', '[]'::jsonb
    );
  end if;

  select
    (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end)
    + (case when exists (
        select 1
        from public.member_chapter_memberships m
        join public.chapters c on c.id = m.chapter_id and c.organization_id = org
        where m.user_id = caller and m.status = 'active' and m.chapter_id = p.chapter_id
      ) then 50 else 0 end)
    into profile_readiness
  from public.member_profiles p
  where p.id = caller;

  participation := least(100, event_count * 10);
  select least(100, pg_catalog.count(*)::integer * 20)
    into follow_through
  from public.organization_engagement_events e
  where e.organization_id = org
    and e.user_id = caller
    and e.occurred_at >= pg_catalog.now() - interval '90 days'
    and e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp');

  return pg_catalog.jsonb_build_object(
    'overall', pg_catalog.round((participation + profile_readiness + follow_through)::numeric / 3),
    'participation', participation,
    'profileReadiness', profile_readiness,
    'followThrough', follow_through,
    'generatedAt', pg_catalog.now(),
    'signals', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('label', 'Protected activities (180 days)', 'value', event_count),
      pg_catalog.jsonb_build_object('label', 'Days since last activity', 'value',
        greatest(0, (current_date - last_activity::date)))
    )
  );
end;
$function$;

create function public.get_organization_analytics_workspace()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  privacy_threshold integer := 25;
begin
  if org is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surface', 'analytics_parity_workspace'
  ));

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'id', m.user_id::text || ':' || m.chapter_id,
        'name', p.full_name,
        'chapterId', c.id,
        'chapterName', c.name,
        'participationScore', least(100, activity.event_count * 10),
        'profileReadiness',
          (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50,
        'followThrough', least(100, activity.follow_count * 20),
        'overallScore', pg_catalog.round((
          least(100, activity.event_count * 10)
          + ((case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50)
          + least(100, activity.follow_count * 20)
        )::numeric / 3),
        'attention', case
          when cases.overdue_cases > 0 then 'urgent'
          when activity.event_count = 0 then 'support'
          when activity.event_count < 5 then 'watch'
          else 'steady'
        end,
        'activeCases', cases.active_cases,
        'overdueCases', cases.overdue_cases,
        'lastActivityAt', activity.last_activity
      ) order by c.name, p.full_name, m.user_id)
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id and c.organization_id = org
      join public.organization_memberships om
        on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
      join public.member_profiles p on p.id = m.user_id
      cross join lateral (
        select
          pg_catalog.count(*)::integer as event_count,
          pg_catalog.count(*) filter (
            where e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp')
              and e.occurred_at >= generated - interval '90 days'
          )::integer as follow_count,
          pg_catalog.max(e.occurred_at) as last_activity
        from public.organization_engagement_events e
        where e.organization_id = org
          and e.user_id = m.user_id
          and e.occurred_at >= generated - interval '180 days'
      ) activity
      cross join lateral (
        select
          pg_catalog.count(*) filter (where cs.status = 'active')::integer as active_cases,
          pg_catalog.count(*) filter (
            where cs.status = 'active' and cs.deadline < generated::date
          )::integer as overdue_cases
        from public.member_cases cs
        where cs.organization_id = org
          and cs.chapter_id = c.id
          and cs.user_id = m.user_id
      ) cases
      where m.status = 'active'
    ), '[]'::jsonb),
    'chapterHealth', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'chapterId', c.id,
        'chapterName', c.name,
        'memberCount', totals.member_count,
        'protected', totals.member_count < privacy_threshold,
        'score', case when totals.member_count >= privacy_threshold then latest.score else null end,
        'drivers', case when totals.member_count >= privacy_threshold and latest.id is not null
          then pg_catalog.jsonb_build_object(
            'participation', latest.participation,
            'caseTimeliness', latest.case_timeliness,
            'stewardCapacity', latest.steward_capacity,
            'trainingCoverage', latest.training_coverage,
            'communicationReach', latest.communication_reach,
            'governanceReadiness', latest.governance_readiness
          ) else null end,
        'trend', case when totals.member_count >= privacy_threshold then coalesce(trend.points, '[]'::jsonb) else '[]'::jsonb end
      ) order by c.name)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*)::integer as member_count
        from public.member_chapter_memberships m
        join public.organization_memberships om
          on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
        where m.chapter_id = c.id and m.status = 'active'
      ) totals
      left join lateral (
        select s.* from public.chapter_health_snapshots s
        where s.chapter_id = c.id order by s.measured_on desc limit 1
      ) latest on true
      left join lateral (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'measuredOn', history.measured_on, 'score', history.score
        ) order by history.measured_on) as points
        from (
          select s.measured_on, s.score
          from public.chapter_health_snapshots s
          where s.chapter_id = c.id
          order by s.measured_on desc limit 36
        ) history
      ) trend on true
      where c.organization_id = org
    ), '[]'::jsonb),
    'datasets', coalesce((
      select pg_catalog.jsonb_agg(dataset.value order by dataset.sort_key)
      from (
        select 0 as sort_key, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'organization:chapter-health',
          'label', 'Chapter health',
          'description', 'Latest protected chapter health score.',
          'scope', 'organization',
          'chapterId', null,
          'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'label', qualified.name, 'value', qualified.score
          ) order by qualified.name), '[]'::jsonb)
        ) as value
        from (
          select c.name, latest.score
          from public.chapters c
          cross join lateral (
            select pg_catalog.count(*)::integer as member_count
            from public.member_chapter_memberships m
            join public.organization_memberships om
              on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
            where m.chapter_id = c.id and m.status = 'active'
          ) totals
          join lateral (
            select s.score from public.chapter_health_snapshots s
            where s.chapter_id = c.id order by s.measured_on desc limit 1
          ) latest on true
          where c.organization_id = org and totals.member_count >= privacy_threshold
        ) qualified
        union all
        select 100 + c.order_index, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'chapter:' || c.id || ':health-trend',
          'label', c.name || ' health trend',
          'description', 'Protected chapter score history.',
          'scope', 'chapter',
          'chapterId', c.id,
          'rows', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'label', s.measured_on::text, 'value', s.score
            ) order by s.measured_on)
            from public.chapter_health_snapshots s where s.chapter_id = c.id
          ), '[]'::jsonb)
        )
        from public.chapters c
        where c.organization_id = org
          and (select pg_catalog.count(*) from public.member_chapter_memberships m
               join public.organization_memberships om
                 on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
               where m.chapter_id = c.id and m.status = 'active') >= privacy_threshold
      ) dataset
    ), '[]'::jsonb),
    'layouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', l.id,
        'organizationId', l.organization_id,
        'name', l.name,
        'scope', l.scope,
        'chapterId', l.chapter_id,
        'spec', l.spec,
        'canEdit', l.owner_user_id = (select auth.uid())
          or private.has_organization_role(org, array['admin']),
        'updatedAt', l.updated_at
      ) order by l.updated_at desc)
      from public.organization_analytics_layouts l
      where l.organization_id = org
        and (
          (l.scope = 'personal' and l.owner_user_id = (select auth.uid()))
          or l.scope in ('chapter', 'organization')
        )
    ), '[]'::jsonb)
  );
end;
$function$;

create function public.save_organization_analytics_layout(
  p_layout_id uuid,
  p_name text,
  p_scope text,
  p_chapter_id text,
  p_spec jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.mi1_require_selected_organization();
  target_id uuid := coalesce(p_layout_id, extensions.gen_random_uuid());
  request_hash text;
  prior private.organization_analytics_idempotency_receipts%rowtype;
  existing public.organization_analytics_layouts%rowtype;
  result jsonb;
  action_name text := 'created';
begin
  if caller is null or org is null or p_idempotency_key is null then
    raise exception 'authentication, organization, and idempotency key required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_scope not in ('personal', 'chapter', 'organization')
    or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_name, ''))) not between 1 and 80
    or coalesce(p_name, '') ~ '[[:cntrl:]]'
    or not private.analytics_layout_spec_valid(p_spec)
    or (p_scope = 'chapter') is distinct from (p_chapter_id is not null)
  then
    raise exception 'invalid analytics layout' using errcode = '22023';
  end if;
  if p_scope = 'chapter' and not exists (
    select 1 from public.chapters c where c.id = p_chapter_id and c.organization_id = org
  ) then
    raise exception 'chapter is outside selected organization' using errcode = '42501';
  end if;
  if p_scope = 'organization'
    and not private.has_organization_role(org, array['coordinator', 'admin', 'vp'])
  then
    raise exception 'organization sharing requires leadership role' using errcode = '42501';
  end if;
  if (p_spec ->> 'datasetId') = 'organization:chapter-health' then
    null;
  elsif (p_spec ->> 'datasetId') ~ '^chapter:[A-Za-z0-9_-]{1,40}:health-trend$' then
    if not exists (
      select 1
      from public.chapters c
      where c.id = pg_catalog.split_part(p_spec ->> 'datasetId', ':', 2)
        and c.organization_id = org
        and (
          select pg_catalog.count(*)
          from public.member_chapter_memberships m
          join public.organization_memberships om
            on om.organization_id = org
           and om.user_id = m.user_id
           and om.status = 'active'
          where m.chapter_id = c.id and m.status = 'active'
        ) >= 25
    ) then
      raise exception 'analytics dataset is unavailable' using errcode = '22023';
    end if;
  else
    raise exception 'analytics dataset is unavailable' using errcode = '22023';
  end if;
  if p_scope = 'chapter'
    and (p_spec ->> 'datasetId') like 'chapter:%'
    and pg_catalog.split_part(p_spec ->> 'datasetId', ':', 2) is distinct from p_chapter_id
  then
    raise exception 'chapter layout dataset does not match chapter' using errcode = '22023';
  end if;

  request_hash := pg_catalog.encode(extensions.digest(pg_catalog.jsonb_build_object(
    'layoutId', p_layout_id, 'name', pg_catalog.btrim(p_name), 'scope', p_scope,
    'chapterId', p_chapter_id, 'spec', p_spec
  )::text, 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text || p_idempotency_key::text, 0));
  delete from private.organization_analytics_idempotency_receipts r
  where r.user_id = caller
    and r.created_at < pg_catalog.now() - interval '30 days';
  select * into prior from private.organization_analytics_idempotency_receipts r
  where r.user_id = caller and r.idempotency_key = p_idempotency_key;
  if found then
    if prior.operation is distinct from 'save_layout' or prior.request_hash is distinct from request_hash then
      raise exception 'idempotency key reused with different request' using errcode = '22023';
    end if;
    return prior.response;
  end if;

  if p_layout_id is not null then
    select * into existing from public.organization_analytics_layouts l where l.id = p_layout_id for update;
    if found then
      if existing.organization_id is distinct from org
        or (existing.owner_user_id is distinct from caller
          and not private.has_organization_role(org, array['admin']))
      then
        raise exception 'not authorized' using errcode = '42501';
      end if;
      action_name := 'updated';
    end if;
  end if;

  if action_name = 'updated' then
    update public.organization_analytics_layouts l set
      scope = p_scope,
      chapter_id = p_chapter_id,
      name = pg_catalog.btrim(p_name),
      spec = p_spec,
      updated_at = pg_catalog.now()
    where l.id = target_id
      and l.organization_id = org;
  else
    insert into public.organization_analytics_layouts (
      id, organization_id, owner_user_id, scope, chapter_id, name, spec
    ) values (
      target_id, org, caller, p_scope, p_chapter_id, pg_catalog.btrim(p_name), p_spec
    );
  end if;

  insert into public.organization_analytics_layout_events (
    organization_id, layout_id, actor_user_id, action, scope, chapter_id
  ) values (org, target_id, caller, action_name, p_scope, p_chapter_id);

  result := pg_catalog.jsonb_build_object(
    'id', target_id,
    'organizationId', org,
    'name', pg_catalog.btrim(p_name),
    'scope', p_scope,
    'chapterId', p_chapter_id,
    'spec', p_spec,
    'canEdit', true
  );
  insert into private.organization_analytics_idempotency_receipts (
    user_id, idempotency_key, operation, request_hash, response
  ) values (caller, p_idempotency_key, 'save_layout', request_hash, result);
  return result;
end;
$function$;

create function public.delete_organization_analytics_layout(
  p_layout_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.mi1_require_selected_organization();
  request_hash text;
  prior private.organization_analytics_idempotency_receipts%rowtype;
  existing public.organization_analytics_layouts%rowtype;
  result jsonb;
begin
  if caller is null or org is null or p_layout_id is null or p_idempotency_key is null then
    raise exception 'authentication, organization, layout, and idempotency key required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  request_hash := pg_catalog.encode(extensions.digest(
    pg_catalog.jsonb_build_object('layoutId', p_layout_id)::text, 'sha256'
  ), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text || p_idempotency_key::text, 0));
  delete from private.organization_analytics_idempotency_receipts r
  where r.user_id = caller
    and r.created_at < pg_catalog.now() - interval '30 days';
  select * into prior from private.organization_analytics_idempotency_receipts r
  where r.user_id = caller and r.idempotency_key = p_idempotency_key;
  if found then
    if prior.operation is distinct from 'delete_layout' or prior.request_hash is distinct from request_hash then
      raise exception 'idempotency key reused with different request' using errcode = '22023';
    end if;
    return prior.response;
  end if;

  select * into existing from public.organization_analytics_layouts l
  where l.id = p_layout_id and l.organization_id = org for update;
  if not found or (
    existing.owner_user_id is distinct from caller
    and not private.has_organization_role(org, array['admin'])
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  delete from public.organization_analytics_layouts l where l.id = p_layout_id;
  insert into public.organization_analytics_layout_events (
    organization_id, layout_id, actor_user_id, action, scope, chapter_id
  ) values (org, p_layout_id, caller, 'deleted', existing.scope, existing.chapter_id);
  result := pg_catalog.jsonb_build_object('id', p_layout_id, 'deleted', true);
  insert into private.organization_analytics_idempotency_receipts (
    user_id, idempotency_key, operation, request_hash, response
  ) values (caller, p_idempotency_key, 'delete_layout', request_hash, result);
  return result;
end;
$function$;

revoke all on function private.analytics_layout_spec_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.get_my_analytics_report_card() from public, anon, authenticated, service_role;
revoke all on function public.get_organization_analytics_workspace() from public, anon, authenticated, service_role;
revoke all on function public.save_organization_analytics_layout(uuid, text, text, text, jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.delete_organization_analytics_layout(uuid, uuid) from public, anon, authenticated, service_role;

grant execute on function public.get_my_analytics_report_card() to authenticated;
grant execute on function public.get_organization_analytics_workspace() to authenticated;
grant execute on function public.save_organization_analytics_layout(uuid, text, text, text, jsonb, uuid) to authenticated;
grant execute on function public.delete_organization_analytics_layout(uuid, uuid) to authenticated;
