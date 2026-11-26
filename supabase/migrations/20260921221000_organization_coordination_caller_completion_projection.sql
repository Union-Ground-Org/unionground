-- Persist each caller's mission-objective completion state across snapshot and
-- paginated coordination reads. The existing partial unique index on
-- (record_id, actor_user_id, event_type) makes the correlated lookup bounded.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.get_organization_coordination_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  staff boolean;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if organization is null then
    return pg_catalog.jsonb_build_object(
      'state', 'empty', 'organizationId', null, 'staff', false,
      'records', '[]'::jsonb, 'leaderboards', '[]'::jsonb,
      'messages', '[]'::jsonb, 'resources', '[]'::jsonb,
      'exportRuns', '[]'::jsonb, 'outreach', '[]'::jsonb
    );
  end if;
  if not private.is_organization_member(organization) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  staff := private.organization_coordination_is_staff(organization);
  return pg_catalog.jsonb_build_object(
    'state', 'ready',
    'organizationId', organization,
    'staff', staff,
    'records', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'title', r.title, 'summary', r.summary,
        'status', r.status, 'visibility', r.visibility,
        'organizationId', r.organization_id,
        'partnerOrganizationId', r.partner_organization_id,
        'chapterId', r.chapter_id, 'parentId', r.parent_id,
        'config', case when staff or r.visibility <> 'staff' then r.config else '{}'::jsonb end,
        'completedByCaller', exists (
          select 1
          from public.organization_coordination_events event
          where event.record_id = r.id
            and event.actor_user_id = caller
            and event.event_type = 'complete_objective'
        ),
        'createdAt', r.created_at, 'updatedAt', r.updated_at
      ) order by r.updated_at desc, r.id desc)
      from (
        select visible.*
        from public.organization_coordination_records visible
        where private.organization_coordination_can_read(visible.id)
        order by visible.updated_at desc, visible.id desc
        limit 50
      ) r
    ), '[]'::jsonb),
    'leaderboards', coalesce((
      select pg_catalog.jsonb_agg(board.payload order by board.title)
      from (
        select r.title, pg_catalog.jsonb_build_object(
          'missionId', r.id, 'title', r.title,
          'rows', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'alias', ranked.privacy_alias, 'points', ranked.points,
              'status', ranked.status
            ) order by ranked.points desc, ranked.privacy_alias)
            from (
              select p.privacy_alias, p.points, p.status
              from public.organization_coordination_user_participants p
              where p.record_id = r.id and p.status in ('active', 'completed')
              order by p.points desc, p.privacy_alias limit 100
            ) ranked
          ), '[]'::jsonb)
        ) payload
        from public.organization_coordination_records r
        where r.kind = 'mission' and r.status in ('active', 'completed')
          and private.organization_coordination_can_read(r.id)
      ) board
    ), '[]'::jsonb),
    'messages', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'conversationId', m.conversation_id,
        'senderOrganizationId', m.sender_organization_id,
        'body', m.body, 'createdAt', m.created_at
      ) order by m.created_at desc, m.id desc)
      from (
        select message.*
        from public.organization_coordination_messages message
        where private.organization_coordination_can_read(message.conversation_id)
        order by message.created_at desc, message.id desc
        limit 30
      ) m
    ), '[]'::jsonb),
    'resources', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', x.id, 'recordId', x.record_id, 'kind', x.resource_kind,
        'title', x.title, 'status', x.status,
        'fromOrganizationId', x.from_organization_id,
        'toOrganizationId', x.to_organization_id,
        'documentId', x.chapter_document_id, 'updatedAt', x.updated_at
      ) order by x.updated_at desc, x.id desc)
      from public.organization_coordination_resources x
      where private.organization_coordination_can_read(x.record_id)
    ), '[]'::jsonb),
    'exportRuns', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id, 'scheduleId', e.schedule_id, 'format', e.format,
        'deliveryMode', e.delivery_mode, 'status', e.status,
        'rowCount', e.row_count, 'expiresAt', e.expires_at,
        'createdAt', e.created_at
      ) order by e.created_at desc, e.id desc)
      from public.organization_coordination_export_runs e
      where e.organization_id = organization
    ), '[]'::jsonb) else '[]'::jsonb end,
    'outreach', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', o.id, 'campaignId', o.campaign_id,
        'targetUserId', o.target_user_id, 'disposition', o.disposition,
        'note', o.note, 'contactedAt', o.contacted_at
      ) order by o.contacted_at desc, o.id desc)
      from public.organization_coordination_outreach_events o
      where o.organization_id = organization
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$function$;

create or replace function public.list_organization_coordination_records(
  p_before_updated_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  staff boolean;
  payload jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
     or not private.is_organization_member(organization) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  if (p_before_updated_at is null) <> (p_before_id is null) then
    raise exception 'complete coordination cursor required' using errcode = '22023';
  end if;
  staff := private.organization_coordination_is_staff(organization);

  with candidates as materialized (
    select record.*
    from public.organization_coordination_records record
    where private.organization_coordination_can_read(record.id)
      and (
        p_before_updated_at is null
        or (record.updated_at, record.id) < (p_before_updated_at, p_before_id)
      )
    order by record.updated_at desc, record.id desc
    limit page_limit + 1
  ), page as (
    select * from candidates
    order by updated_at desc, id desc
    limit page_limit
  )
  select pg_catalog.jsonb_build_object(
    'records', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', record.id, 'kind', record.kind,
        'title', record.title, 'summary', record.summary,
        'status', record.status, 'visibility', record.visibility,
        'organizationId', record.organization_id,
        'partnerOrganizationId', record.partner_organization_id,
        'chapterId', record.chapter_id, 'parentId', record.parent_id,
        'config', case when staff or record.visibility <> 'staff'
          then record.config else '{}'::jsonb end,
        'completedByCaller', exists (
          select 1
          from public.organization_coordination_events event
          where event.record_id = record.id
            and event.actor_user_id = caller
            and event.event_type = 'complete_objective'
        ),
        'createdAt', record.created_at, 'updatedAt', record.updated_at
      ) order by record.updated_at desc, record.id desc)
      from page record
    ), '[]'::jsonb),
    'nextCursor', case when (select pg_catalog.count(*) from candidates) > page_limit
      then (select pg_catalog.jsonb_build_object(
        'updatedAt', record.updated_at, 'id', record.id
      ) from page record order by record.updated_at, record.id limit 1)
      else null end
  ) into payload;

  return payload;
end;
$function$;

revoke all on function public.get_organization_coordination_snapshot()
  from public, anon, authenticated, service_role;
revoke all on function public.list_organization_coordination_records(
  timestamptz, uuid, integer
) from public, anon, authenticated, service_role;

grant execute on function public.get_organization_coordination_snapshot()
  to authenticated;
grant execute on function public.list_organization_coordination_records(
  timestamptz, uuid, integer
) to authenticated;

comment on function public.get_organization_coordination_snapshot() is
  'Tenant-scoped coordination projection whose records include whether the authenticated caller completed each mission objective.';
comment on function public.list_organization_coordination_records(timestamptz, uuid, integer) is
  'Keyset-paged tenant-scoped coordination records including the authenticated caller mission-objective completion state.';

notify pgrst, 'reload schema';

commit;
