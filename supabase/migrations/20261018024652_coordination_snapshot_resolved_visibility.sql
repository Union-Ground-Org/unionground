-- BUG-UG-COORDINATION-SNAPSHOT-OUTRUNS-LOAD-DEADLINE-20261015
-- Resolve the caller and staff status once, then materialize one set of visible
-- records per read. Preserve the existing can_read rules (ownership or ACTIVE
-- organization participation, plus visibility/user participation), including
-- cross-organization conversations. The scalar helper remains unchanged for
-- RLS and write paths. No tenant data, privilege widening or deadline change.
--
-- Union Ground: the snapshot keeps (20261015150000) and
-- returns no 'leaderboards' key; only the visibility resolution is taken.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Internal invoker helper: only the existing definer RPCs may supply resolved
-- context. It is not an RPC or a new grant to authenticated/service_role.
create or replace function private.organization_coordination_visible_records(
  p_organization uuid, p_caller uuid, p_staff boolean
)
returns setof public.organization_coordination_records
language sql
stable
security invoker
set search_path = ''
as $function$
  with scoped_ids as (
    select owned.id
    from public.organization_coordination_records owned
    where owned.organization_id = p_organization
    union
    select participant.record_id
    from public.organization_coordination_organization_participants participant
    where participant.organization_id = p_organization
      and participant.status = 'active'
  )
  select record.*
  from scoped_ids scope
  join public.organization_coordination_records record on record.id = scope.id
  where record.visibility in ('members', 'public')
    or p_staff
    or (
      record.visibility = 'participants'
      and exists (
        select 1
        from public.organization_coordination_user_participants participant
        where participant.record_id = record.id
          and participant.organization_id = p_organization
          and participant.user_id = p_caller
          and participant.status in ('active', 'completed')
      )
    );
$function$;

revoke all on function private.organization_coordination_visible_records(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;

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
      'records', '[]'::jsonb,
      'messages', '[]'::jsonb, 'resources', '[]'::jsonb,
      'exportRuns', '[]'::jsonb, 'outreach', '[]'::jsonb
    );
  end if;
  if not private.is_organization_member(organization) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  staff := private.organization_coordination_is_staff(organization);
  return (
    with visible_records as materialized (
      select * from private.organization_coordination_visible_records(organization, caller, staff)
    )
    select pg_catalog.jsonb_build_object(
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
        from visible_records visible
        order by visible.updated_at desc, visible.id desc
        limit 50
      ) r
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
        join visible_records visible on visible.id = message.conversation_id
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
      join visible_records visible on visible.id = x.record_id
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
  ));
end;
$function$;

revoke all on function public.get_organization_coordination_snapshot()
  from public, anon, authenticated, service_role;
grant execute on function public.get_organization_coordination_snapshot()
  to authenticated;

comment on function public.get_organization_coordination_snapshot() is
  'Tenant-scoped coordination projection whose records include whether the authenticated caller completed each mission objective. It carries no mission leaderboards, participant points or ranking aliases.';

create or replace function public.list_organization_coordination_messages(
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 30
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
  page_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  payload jsonb;
  staff boolean;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.is_organization_member(organization) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  if (p_before_created_at is null) <> (p_before_id is null) then
    raise exception 'complete message cursor required' using errcode = '22023';
  end if;
  staff := private.organization_coordination_is_staff(organization);
  with visible_records as materialized (
    select * from private.organization_coordination_visible_records(organization, caller, staff)
  ), candidates as materialized (
    select message.*
    from public.organization_coordination_messages message
    join visible_records visible on visible.id = message.conversation_id
    where (
        p_before_created_at is null
        or (message.created_at, message.id) < (p_before_created_at, p_before_id)
      )
    order by message.created_at desc, message.id desc
    limit page_limit + 1
  ), page as (
    select * from candidates
    order by created_at desc, id desc
    limit page_limit
  )
  select pg_catalog.jsonb_build_object(
    'messages', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', message.id,
        'conversationId', message.conversation_id,
        'senderOrganizationId', message.sender_organization_id,
        'body', message.body,
        'createdAt', message.created_at
      ) order by message.created_at desc, message.id desc)
      from page message
    ), '[]'::jsonb),
    'nextCursor', case when (select pg_catalog.count(*) from candidates) > page_limit
      then (select pg_catalog.jsonb_build_object(
        'createdAt', message.created_at, 'id', message.id
      ) from page message order by message.created_at, message.id limit 1)
      else null end
  ) into payload;
  return payload;
end;
$function$;

revoke all on function public.list_organization_coordination_messages(timestamptz, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_coordination_messages(timestamptz, uuid, integer)
  to authenticated;

notify pgrst, 'reload schema';
commit;
