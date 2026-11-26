-- MI1 CR-053..CR-067: exact-head authorization and completion hardening.
-- Sequenced after the complete coordination workflow on current Main.
--
-- This migration closes the review findings found before delivery: invited
-- organizations are not readers, cross-organization conversations retain
-- their live permission gate, mission points are server-derived and awarded
-- once, coalition work cannot bypass quorum, directory parentage requires an
-- accepted oversight grant, message history is pageable, and a ready internal
-- export has a real tenant-scoped payload.

set local lock_timeout = '5s';

create unique index organization_coordination_objective_completion_once_idx
  on public.organization_coordination_events (record_id, actor_user_id, event_type)
  where event_type = 'complete_objective' and actor_user_id is not null;

create or replace function private.organization_coordination_can_read(p_record_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.organization_coordination_records record
    where record.id = p_record_id
      and (
        record.organization_id = (select private.current_member_organization())
        or exists (
          select 1
          from public.organization_coordination_organization_participants participant
          where participant.record_id = record.id
            and participant.organization_id = (select private.current_member_organization())
            and participant.status = 'active'
        )
      )
      and (
        record.visibility in ('members', 'public')
        or private.organization_coordination_is_staff(
          (select private.current_member_organization())
        )
        or (
          record.visibility = 'participants'
          and exists (
            select 1
            from public.organization_coordination_user_participants participant
            where participant.record_id = record.id
              and participant.organization_id = (select private.current_member_organization())
              and participant.user_id = (select auth.uid())
              and participant.status in ('active', 'completed')
          )
        )
      )
  );
$function$;

create function private.validate_organization_coordination_visibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.partner_organization_id is not null
    and new.visibility in ('members', 'public') then
    raise exception 'cross-organization visibility must stay participant scoped'
      using errcode = '23514';
  end if;
  if new.kind = 'network_conversation' and new.visibility <> 'participants' then
    raise exception 'network conversations require participant visibility'
      using errcode = '23514';
  end if;
  if new.kind in (
    'network_export_schedule', 'handshake_workspace_item', 'merger_plan',
    'coverage_schedule', 'coverage_override', 'mobilization_campaign',
    'mobilization_cohort'
  ) and new.visibility <> 'staff' then
    raise exception 'staff workflow visibility required' using errcode = '23514';
  end if;
  if new.kind in ('coalition', 'coalition_campaign', 'coalition_work_item')
    and new.visibility not in ('staff', 'participants') then
    raise exception 'coalition visibility must stay staff or participant scoped'
      using errcode = '23514';
  end if;
  if new.kind = 'microsite_page' and new.visibility not in ('staff', 'public') then
    raise exception 'microsite visibility unavailable' using errcode = '23514';
  end if;
  if new.kind = 'mission_objective' then
    begin
      if coalesce((new.config ->> 'points')::integer, 0) not between 1 and 1000 then
        raise exception 'mission objective points unavailable' using errcode = '23514';
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'mission objective points unavailable' using errcode = '23514';
    end;
  end if;
  return new;
end;
$function$;

create trigger validate_organization_coordination_visibility
before insert or update of kind, partner_organization_id, visibility, config
on public.organization_coordination_records
for each row execute function private.validate_organization_coordination_visibility();

create or replace function public.transition_organization_coordination_record(
  p_record_id uuid,
  p_transition text,
  p_config jsonb default '{}'::jsonb,
  p_points integer default 0,
  p_idempotency_key uuid default extensions.gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  item public.organization_coordination_records%rowtype;
  prior_event public.organization_coordination_events%rowtype;
  next_status text;
  awarded_points integer := 0;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  select * into item
  from public.organization_coordination_records record
  where record.id = p_record_id
  for update;
  if not found or not private.organization_coordination_can_read(item.id) then
    raise exception 'coordination record unavailable' using errcode = '22023';
  end if;

  select * into prior_event
  from public.organization_coordination_events event
  where event.idempotency_key = p_idempotency_key;
  if found then
    if prior_event.record_id <> item.id or prior_event.actor_user_id is distinct from caller then
      raise exception 'idempotency key unavailable' using errcode = '42501';
    end if;
    return pg_catalog.jsonb_build_object(
      'transitioned', false, 'replayed', true,
      'recordId', item.id, 'status', prior_event.to_status
    );
  end if;

  if p_transition = 'complete_objective' then
    if item.kind <> 'mission_objective' or item.status <> 'active'
      or item.parent_id is null then
      raise exception 'active mission objective required' using errcode = '22023';
    end if;
    if exists (
      select 1
      from public.organization_coordination_events event
      where event.record_id = item.id
        and event.actor_user_id = caller
        and event.event_type = 'complete_objective'
    ) then
      return pg_catalog.jsonb_build_object(
        'transitioned', false, 'alreadyCompleted', true,
        'recordId', item.id, 'status', item.status, 'pointsAwarded', 0
      );
    end if;
    begin
      awarded_points := (item.config ->> 'points')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'mission objective points unavailable' using errcode = '23514';
    end;
    if awarded_points not between 1 and 1000 then
      raise exception 'mission objective points unavailable' using errcode = '23514';
    end if;
    if not exists (
      select 1
      from public.organization_coordination_user_participants participant
      where participant.record_id = item.parent_id
        and participant.organization_id = organization
        and participant.user_id = caller
        and participant.status in ('active', 'completed')
    ) then
      raise exception 'mission participation required' using errcode = '42501';
    end if;
    insert into public.organization_coordination_events (
      record_id, organization_id, actor_user_id, event_type, from_status,
      to_status, points_delta, metadata, idempotency_key
    ) values (
      item.id, organization, caller, 'complete_objective', item.status,
      item.status, awarded_points, coalesce(p_config, '{}'::jsonb),
      p_idempotency_key
    );
    update public.organization_coordination_user_participants
    set points = least(points + awarded_points, 1000000),
        updated_at = pg_catalog.clock_timestamp()
    where record_id = item.parent_id
      and organization_id = organization and user_id = caller
      and status in ('active', 'completed');
    return pg_catalog.jsonb_build_object(
      'transitioned', true, 'recordId', item.id, 'status', item.status,
      'pointsAwarded', awarded_points
    );
  end if;

  if not private.organization_coordination_is_staff(organization) then
    raise exception 'organization staff role required' using errcode = '42501';
  end if;
  if item.organization_id <> organization then
    raise exception 'coordination record owner role required' using errcode = '42501';
  end if;
  if item.kind = 'coalition_work_item' then
    raise exception 'coalition decision approval required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_config, '{}'::jsonb)) <> 'object'
    or pg_catalog.octet_length(coalesce(p_config, '{}'::jsonb)::text) > 12000 then
    raise exception 'coordination config unavailable' using errcode = '22023';
  end if;

  next_status := case p_transition
    when 'activate' then 'active'
    when 'pause' then 'paused'
    when 'complete' then 'completed'
    when 'decline' then 'declined'
    when 'close' then 'closed'
    when 'request_operator' then 'pending_operator'
    when 'publish' then 'active'
    else null
  end;
  if next_status is null
    or (p_transition = 'activate' and item.status not in ('draft', 'paused'))
    or (p_transition = 'pause' and item.status <> 'active')
    or (p_transition = 'complete' and item.status not in ('active', 'paused'))
    or (p_transition = 'decline' and item.status not in ('requested', 'invited'))
    or (p_transition = 'close' and item.status not in ('active', 'paused', 'completed', 'declined', 'failed'))
    or (p_transition = 'request_operator' and (item.kind <> 'merger_plan' or item.status not in ('active', 'paused')))
    or (p_transition = 'publish' and (item.kind <> 'microsite_page' or item.status not in ('draft', 'paused'))) then
    raise exception 'coordination transition unavailable' using errcode = '22023';
  end if;

  update public.organization_coordination_records
  set status = next_status,
      config = config || coalesce(p_config, '{}'::jsonb),
      updated_at = pg_catalog.clock_timestamp()
  where id = item.id;
  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, from_status,
    to_status, points_delta, metadata, idempotency_key
  ) values (
    item.id, organization, caller, p_transition, item.status, next_status,
    0, coalesce(p_config, '{}'::jsonb), p_idempotency_key
  );
  return pg_catalog.jsonb_build_object(
    'transitioned', true, 'recordId', item.id, 'status', next_status
  );
end;
$function$;

create or replace function public.send_organization_coordination_message(
  p_conversation_id uuid,
  p_body text,
  p_idempotency_key uuid default extensions.gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  item public.organization_coordination_records%rowtype;
  network public.organization_coordination_records%rowtype;
  message_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  select * into item
  from public.organization_coordination_records record
  where record.id = p_conversation_id
    and record.kind in ('network_conversation', 'coalition_campaign')
    and record.status = 'active';
  if not found or not private.organization_coordination_can_read(item.id) then
    raise exception 'coordination conversation unavailable' using errcode = '22023';
  end if;
  if item.kind = 'network_conversation' then
    select * into network
    from public.organization_coordination_records record
    where record.id = item.parent_id and record.kind = 'network_link'
      and record.status = 'active';
    if not found or not private.organization_network_has_permission(
      network.organization_id, network.partner_organization_id, 'message'
    ) then
      raise exception 'organization message permission required' using errcode = '42501';
    end if;
  end if;
  if not private.organization_coordination_is_staff(organization)
    and not exists (
      select 1
      from public.organization_coordination_user_participants participant
      where participant.record_id = item.id
        and participant.organization_id = organization
        and participant.user_id = caller and participant.status = 'active'
    ) then
    raise exception 'conversation participation required' using errcode = '42501';
  end if;
  insert into public.organization_coordination_messages (
    conversation_id, sender_organization_id, sender_user_id, body,
    idempotency_key
  ) values (
    item.id, organization, caller, pg_catalog.btrim(p_body), p_idempotency_key
  ) on conflict (idempotency_key) do update
    set idempotency_key = excluded.idempotency_key
  returning id into message_id;
  return pg_catalog.jsonb_build_object('sent', true, 'messageId', message_id);
end;
$function$;

create or replace function public.upsert_organization_network_profile(
  p_display_name text,
  p_summary text default '',
  p_visibility text default 'private',
  p_contact_mode text default 'disabled',
  p_parent_organization_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['coordinator','admin','vp']) then
    raise exception 'organization directory role required' using errcode = '42501';
  end if;
  if p_parent_organization_id is not null and not exists (
    select 1
    from public.organization_network_permission_grants permission
    join public.organization_coordination_records network
      on network.id = permission.network_record_id
    join public.organization_coordination_organization_participants parent_participant
      on parent_participant.record_id = network.id
      and parent_participant.organization_id = p_parent_organization_id
      and parent_participant.status = 'active'
    join public.organization_coordination_organization_participants child_participant
      on child_participant.record_id = network.id
      and child_participant.organization_id = organization
      and child_participant.status = 'active'
    where permission.grantor_organization_id = p_parent_organization_id
      and permission.grantee_organization_id = organization
      and permission.capability = 'oversight'
      and permission.status = 'active'
      and network.kind = 'network_link' and network.status = 'active'
  ) then
    raise exception 'accepted parent oversight grant required' using errcode = '42501';
  end if;
  insert into public.organization_network_directory_profiles (
    organization_id, display_name, summary, visibility, contact_mode,
    parent_organization_id, updated_by
  ) values (
    organization, pg_catalog.btrim(p_display_name), coalesce(p_summary, ''),
    p_visibility, p_contact_mode, p_parent_organization_id, caller
  ) on conflict (organization_id) do update
    set display_name = excluded.display_name,
        summary = excluded.summary,
        visibility = excluded.visibility,
        contact_mode = excluded.contact_mode,
        parent_organization_id = excluded.parent_organization_id,
        updated_by = caller,
        updated_at = pg_catalog.clock_timestamp();
  return pg_catalog.jsonb_build_object(
    'saved', true, 'organizationId', organization,
    'visibility', p_visibility, 'contactMode', p_contact_mode,
    'parentOrganizationId', p_parent_organization_id
  );
end;
$function$;

create function public.list_organization_coordination_messages(
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
  with candidates as materialized (
    select message.*
    from public.organization_coordination_messages message
    where private.organization_coordination_can_read(message.conversation_id)
      and (
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

create function public.list_organization_network_access_events(p_limit integer default 50)
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
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'organization oversight role required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', event.id,
      'actorOrganizationId', event.actor_organization_id,
      'subjectOrganizationId', event.subject_organization_id,
      'action', event.action,
      'outcome', event.outcome,
      'createdAt', event.created_at
    ) order by event.created_at desc, event.id desc)
    from (
      select source.*
      from public.organization_network_access_events source
      where source.actor_organization_id = organization
        or source.subject_organization_id = organization
      order by source.created_at desc, source.id desc
      limit page_limit
    ) event
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.run_organization_coordination_export(
  p_schedule_id uuid,
  p_format text default 'csv',
  p_idempotency_key uuid default extensions.gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  run_id uuid;
  rows_ready integer;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['coordinator','admin','vp']) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  if p_format not in ('csv', 'json') then
    raise exception 'export format unavailable' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_coordination_records record
    where record.id = p_schedule_id and record.organization_id = organization
      and record.kind = 'network_export_schedule' and record.status = 'active'
  ) then
    raise exception 'export schedule unavailable' using errcode = '22023';
  end if;
  select pg_catalog.count(*)::integer into rows_ready
  from public.organization_coordination_records record
  where record.organization_id = organization
    or exists (
      select 1
      from public.organization_coordination_organization_participants participant
      where participant.record_id = record.id
        and participant.organization_id = organization
        and participant.status = 'active'
    );
  insert into public.organization_coordination_export_runs (
    schedule_id, organization_id, requested_by, format, delivery_mode,
    status, row_count, idempotency_key
  ) values (
    p_schedule_id, organization, caller, p_format, 'internal_download',
    'ready', rows_ready, p_idempotency_key
  ) on conflict (idempotency_key) do update
    set idempotency_key = excluded.idempotency_key
  returning id into run_id;
  return pg_catalog.jsonb_build_object(
    'runId', run_id, 'status', 'ready', 'rowCount', rows_ready,
    'deliveryMode', 'internal_download'
  );
end;
$function$;

create or replace function public.run_due_organization_coordination_exports(
  p_now timestamptz default pg_catalog.now(),
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  schedule public.organization_coordination_records%rowtype;
  run_count integer := 0;
  next_at timestamptz;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_limit not between 1 and 200 then
    raise exception 'export batch limit unavailable' using errcode = '22023';
  end if;
  for schedule in
    select record.*
    from public.organization_coordination_records record
    where record.kind = 'network_export_schedule' and record.status = 'active'
      and coalesce((record.config ->> 'nextRunAt')::timestamptz, p_now) <= p_now
    order by (record.config ->> 'nextRunAt')::timestamptz nulls first, record.id
    for update skip locked limit p_limit
  loop
    insert into public.organization_coordination_export_runs (
      schedule_id, organization_id, requested_by, format, delivery_mode,
      status, row_count, idempotency_key
    ) values (
      schedule.id, schedule.organization_id, null,
      schedule.config ->> 'format', schedule.config ->> 'deliveryMode',
      case when schedule.config ->> 'deliveryMode' = 'internal_download'
        then 'ready' else 'queued' end,
      (select pg_catalog.count(*)::integer
       from public.organization_coordination_records scoped
       where scoped.organization_id = schedule.organization_id
         or exists (
           select 1
           from public.organization_coordination_organization_participants participant
           where participant.record_id = scoped.id
             and participant.organization_id = schedule.organization_id
             and participant.status = 'active'
         )),
      extensions.gen_random_uuid()
    );
    next_at := case schedule.config ->> 'cadence'
      when 'daily' then p_now + interval '1 day'
      when 'weekly' then p_now + interval '7 days'
      when 'monthly' then p_now + interval '1 month'
    end;
    update public.organization_coordination_records
    set config = config || pg_catalog.jsonb_build_object(
      'lastRunAt', p_now, 'nextRunAt', next_at
    ), updated_at = pg_catalog.clock_timestamp()
    where id = schedule.id;
    run_count := run_count + 1;
  end loop;
  return pg_catalog.jsonb_build_object('processed', run_count, 'ranAt', p_now);
end;
$function$;

create function private.organization_coordination_csv_cell(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select '"' || pg_catalog.replace(
    case
      when pg_catalog.ltrim(coalesce(p_value, '')) ~ '^[=+@-]'
        then '''' || coalesce(p_value, '')
      else coalesce(p_value, '')
    end,
    '"', '""'
  ) || '"';
$function$;

create function public.get_organization_coordination_export_payload(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  export_run public.organization_coordination_export_runs%rowtype;
  content text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['coordinator','admin','vp']) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  select * into export_run
  from public.organization_coordination_export_runs run
  where run.id = p_run_id and run.organization_id = organization
    and run.delivery_mode = 'internal_download' and run.status = 'ready'
    and run.expires_at > pg_catalog.now();
  if not found then
    raise exception 'ready organization export unavailable' using errcode = '22023';
  end if;

  if export_run.format = 'json' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', record.id,
      'kind', record.kind,
      'title', record.title,
      'status', record.status,
      'visibility', record.visibility,
      'updatedAt', record.updated_at
    ) order by record.updated_at desc, record.id desc), '[]'::jsonb)::text
    into content
    from public.organization_coordination_records record
    where record.organization_id = organization
      or exists (
        select 1
        from public.organization_coordination_organization_participants participant
        where participant.record_id = record.id
          and participant.organization_id = organization
          and participant.status = 'active'
      );
  else
    select 'id,kind,title,status,visibility,updated_at' || E'\n'
      || coalesce(pg_catalog.string_agg(
        private.organization_coordination_csv_cell(record.id::text) || ','
        || private.organization_coordination_csv_cell(record.kind) || ','
        || private.organization_coordination_csv_cell(record.title) || ','
        || private.organization_coordination_csv_cell(record.status) || ','
        || private.organization_coordination_csv_cell(record.visibility) || ','
        || private.organization_coordination_csv_cell(record.updated_at::text),
        E'\n' order by record.updated_at desc, record.id desc
      ), '')
    into content
    from public.organization_coordination_records record
    where record.organization_id = organization
      or exists (
        select 1
        from public.organization_coordination_organization_participants participant
        where participant.record_id = record.id
          and participant.organization_id = organization
          and participant.status = 'active'
      );
  end if;
  return pg_catalog.jsonb_build_object(
    'runId', export_run.id,
    'filename', 'coordination-export-'
      || pg_catalog.to_char(export_run.created_at at time zone 'UTC', 'YYYYMMDDHH24MISS')
      || '.' || export_run.format,
    'mimeType', case when export_run.format = 'json'
      then 'application/json' else 'text/csv' end,
    'content', content,
    'rowCount', export_run.row_count
  );
end;
$function$;

revoke all on function private.validate_organization_coordination_visibility()
  from public, anon, authenticated, service_role;
revoke all on function private.organization_coordination_csv_cell(text)
  from public, anon, authenticated, service_role;
revoke all on function public.list_organization_coordination_messages(
  timestamptz, uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function public.list_organization_network_access_events(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.get_organization_coordination_export_payload(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.list_organization_coordination_messages(
  timestamptz, uuid, integer
) to authenticated;
grant execute on function public.list_organization_network_access_events(integer)
  to authenticated;
grant execute on function public.get_organization_coordination_export_payload(uuid)
  to authenticated;

notify pgrst, 'reload schema';
