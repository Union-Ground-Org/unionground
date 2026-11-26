-- MI1 CR-053..CR-067: workflow-specific organization coordination controls.
-- Sequenced after the coordination foundation on the current Main history.
--
-- Donor baseline: donor-baseline-20260721.
-- Port/adapt only. This migration keeps the current organization boundary,
-- derives tenant scope server-side, links authorized documents instead of
-- copying them, and inserts no organization, user, or sample rows.

set local lock_timeout = '5s';

create table public.organization_network_directory_profiles (
  organization_id uuid primary key
    references public.organizations(id) on update cascade on delete restrict,
  display_name text not null,
  summary text not null default '',
  visibility text not null default 'private'
    check (visibility in ('private', 'partners', 'directory')),
  contact_mode text not null default 'disabled'
    check (contact_mode in ('disabled', 'coordinator_routed')),
  parent_organization_id uuid
    references public.organizations(id) on update cascade on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_network_directory_name_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(display_name)) between 2 and 120
  ),
  constraint organization_network_directory_summary_bounded check (
    pg_catalog.char_length(summary) <= 1000
  ),
  constraint organization_network_directory_parent_distinct check (
    parent_organization_id is null or parent_organization_id <> organization_id
  )
);

create index organization_network_directory_parent_idx
  on public.organization_network_directory_profiles
  (parent_organization_id, visibility, updated_at desc)
  where parent_organization_id is not null;
create index organization_network_directory_visibility_idx
  on public.organization_network_directory_profiles
  (visibility, display_name, organization_id);
create index organization_network_directory_updater_idx
  on public.organization_network_directory_profiles (updated_by, updated_at desc)
  where updated_by is not null;

create table public.organization_network_permission_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  network_record_id uuid not null
    references public.organization_coordination_records(id) on delete cascade,
  grantor_organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  grantee_organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  capability text not null check (capability in (
    'directory_contact', 'message', 'resource_request', 'resource_share',
    'oversight', 'coalition_campaign'
  )),
  status text not null default 'active' check (status in ('active', 'revoked')),
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default pg_catalog.now(),
  revoked_at timestamptz,
  constraint organization_network_permission_distinct_orgs check (
    grantor_organization_id <> grantee_organization_id
  ),
  constraint organization_network_permission_revocation_complete check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  ),
  unique (network_record_id, grantor_organization_id, grantee_organization_id, capability)
);

create index organization_network_permission_grantee_idx
  on public.organization_network_permission_grants
  (grantee_organization_id, status, capability, network_record_id);
create index organization_network_permission_grantor_idx
  on public.organization_network_permission_grants
  (grantor_organization_id, status, capability, network_record_id);
create index organization_network_permission_actor_idx
  on public.organization_network_permission_grants (granted_by, granted_at desc)
  where granted_by is not null;

create table public.organization_network_access_events (
  id uuid primary key default extensions.gen_random_uuid(),
  actor_organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  subject_organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in (
    'directory_viewed', 'contact_requested', 'message_sent', 'resource_requested',
    'resource_shared', 'oversight_viewed', 'permission_changed'
  )),
  outcome text not null check (outcome in ('allowed', 'denied')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  constraint organization_network_access_metadata_object check (
    pg_catalog.jsonb_typeof(metadata) = 'object'
  ),
  constraint organization_network_access_metadata_bounded check (
    pg_catalog.octet_length(metadata::text) <= 1000
  )
);

create index organization_network_access_actor_idx
  on public.organization_network_access_events
  (actor_organization_id, created_at desc, id desc);
create index organization_network_access_subject_idx
  on public.organization_network_access_events
  (subject_organization_id, created_at desc, id desc);
create index organization_network_access_user_idx
  on public.organization_network_access_events
  (actor_user_id, created_at desc) where actor_user_id is not null;

create table public.organization_mission_badges (
  id uuid primary key default extensions.gen_random_uuid(),
  mission_id uuid not null
    references public.organization_coordination_records(id) on delete cascade,
  organization_id uuid not null,
  user_id uuid not null,
  privacy_alias text not null,
  badge_key text not null check (badge_key in ('bronze', 'silver', 'gold')),
  awarded_at timestamptz not null default pg_catalog.now(),
  foreign key (organization_id, user_id)
    references public.organization_memberships(organization_id, user_id)
    on delete cascade,
  unique (mission_id, organization_id, user_id, badge_key)
);

create index organization_mission_badges_mission_idx
  on public.organization_mission_badges
  (mission_id, awarded_at desc, badge_key);
create index organization_mission_badges_user_idx
  on public.organization_mission_badges
  (organization_id, user_id, awarded_at desc);

create table public.organization_merge_match_reviews (
  id uuid primary key default extensions.gen_random_uuid(),
  plan_id uuid not null references public.organization_coordination_records(id) on delete cascade,
  source_user_id uuid not null references auth.users(id) on delete restrict,
  target_user_id uuid not null references auth.users(id) on delete restrict,
  decision text not null check (decision in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  constraint organization_merge_match_review_complete check (
    (decision = 'pending' and reviewed_by is null and reviewed_at is null)
    or (decision in ('approved', 'rejected') and reviewed_by is not null and reviewed_at is not null)
  ),
  unique (plan_id, source_user_id, target_user_id)
);

create index organization_merge_match_plan_idx
  on public.organization_merge_match_reviews (plan_id, decision, created_at, id);
create index organization_merge_match_source_idx
  on public.organization_merge_match_reviews (source_user_id, plan_id);
create index organization_merge_match_target_idx
  on public.organization_merge_match_reviews (target_user_id, plan_id);
create index organization_merge_match_reviewer_idx
  on public.organization_merge_match_reviews (reviewed_by, reviewed_at desc)
  where reviewed_by is not null;

create table public.organization_merge_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  plan_id uuid not null unique references public.organization_coordination_records(id) on delete restrict,
  source_organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  target_organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  requested_by uuid references auth.users(id) on delete set null,
  executed_by uuid references auth.users(id) on delete set null,
  approved_match_count integer not null default 0 check (approved_match_count >= 0),
  error_code text,
  requested_at timestamptz not null default pg_catalog.now(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint organization_merge_jobs_distinct_orgs check (
    source_organization_id <> target_organization_id
  )
);

create index organization_merge_jobs_target_idx
  on public.organization_merge_jobs (target_organization_id, status, requested_at desc);
create index organization_merge_jobs_source_idx
  on public.organization_merge_jobs (source_organization_id, status, requested_at desc);
create index organization_merge_jobs_requester_idx
  on public.organization_merge_jobs (requested_by, requested_at desc)
  where requested_by is not null;
create index organization_merge_jobs_executor_idx
  on public.organization_merge_jobs (executed_by, completed_at desc)
  where executed_by is not null;

create table public.organization_coordination_page_attachments (
  id uuid primary key default extensions.gen_random_uuid(),
  page_id uuid not null references public.organization_coordination_records(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_document_id uuid not null references public.chapter_documents(id) on delete restrict,
  label text not null,
  attached_by uuid references auth.users(id) on delete set null,
  attached_at timestamptz not null default pg_catalog.now(),
  constraint organization_coordination_page_attachment_label_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(label)) between 2 and 160
  ),
  unique (page_id, chapter_document_id)
);

create index organization_coordination_page_attachment_page_idx
  on public.organization_coordination_page_attachments (page_id, attached_at, id);
create index organization_coordination_page_attachment_document_idx
  on public.organization_coordination_page_attachments (chapter_document_id, page_id);
create index organization_coordination_page_attachment_org_idx
  on public.organization_coordination_page_attachments
  (organization_id, attached_at desc, id desc);
create index organization_coordination_page_attachment_actor_idx
  on public.organization_coordination_page_attachments (attached_by, attached_at desc)
  where attached_by is not null;

alter table public.organization_network_directory_profiles enable row level security;
alter table public.organization_network_permission_grants enable row level security;
alter table public.organization_network_access_events enable row level security;
alter table public.organization_mission_badges enable row level security;
alter table public.organization_merge_match_reviews enable row level security;
alter table public.organization_merge_jobs enable row level security;
alter table public.organization_coordination_page_attachments enable row level security;

create function private.organization_network_has_permission(
  p_first_organization_id uuid,
  p_second_organization_id uuid,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_first_organization_id is not null
    and p_second_organization_id is not null
    and exists (
      select 1
      from public.organization_network_permission_grants g
      join public.organization_coordination_records r
        on r.id = g.network_record_id
      where g.status = 'active'
        and g.capability = p_capability
        and r.kind = 'network_link'
        and r.status = 'active'
        and (
          (g.grantor_organization_id = p_first_organization_id
            and g.grantee_organization_id = p_second_organization_id)
          or (g.grantor_organization_id = p_second_organization_id
            and g.grantee_organization_id = p_first_organization_id)
        )
    );
$function$;

create function private.organization_network_can_discover(p_subject_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_subject_organization_id is not null
    and private.current_member_organization() is not null
    and (
      p_subject_organization_id = (select private.current_member_organization())
      or exists (
        select 1
        from public.organization_network_directory_profiles p
        where p.organization_id = p_subject_organization_id
          and p.visibility = 'directory'
      )
      or private.organization_network_has_permission(
        (select private.current_member_organization()),
        p_subject_organization_id,
        'directory_contact'
      )
    );
$function$;

create function private.validate_organization_coordination_record_shape()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  parent_item public.organization_coordination_records%rowtype;
  steward_id uuid;
begin
  if new.parent_id is not null then
    select * into parent_item
    from public.organization_coordination_records r
    where r.id = new.parent_id;
    if not found then
      raise exception 'coordination parent unavailable' using errcode = '23503';
    end if;
  end if;

  if new.kind = 'mission_objective' and (
    new.parent_id is null or parent_item.kind <> 'mission'
  ) then
    raise exception 'mission objective requires a mission parent' using errcode = '23514';
  elsif new.kind in ('network_conversation', 'network_request') and (
    new.parent_id is null or parent_item.kind <> 'network_link'
      or parent_item.status <> 'active'
  ) then
    raise exception 'network work requires an active network link' using errcode = '23514';
  elsif new.kind = 'coalition_campaign' and (
    new.parent_id is null or parent_item.kind <> 'coalition'
      or parent_item.status <> 'active'
  ) then
    raise exception 'coalition campaign requires an active coalition' using errcode = '23514';
  elsif new.kind = 'coalition_work_item' and (
    new.parent_id is null or parent_item.kind <> 'coalition_campaign'
  ) then
    raise exception 'coalition work requires a campaign parent' using errcode = '23514';
  elsif new.kind = 'mobilization_cohort' and (
    new.parent_id is null or parent_item.kind <> 'mobilization_campaign'
  ) then
    raise exception 'mobilization cohort requires a campaign parent' using errcode = '23514';
  elsif new.kind = 'microsite_page' and new.parent_id is not null
    and parent_item.kind <> 'microsite_page' then
    raise exception 'microsite parent must be another page' using errcode = '23514';
  end if;

  if new.kind in ('network_conversation', 'network_request') then
    if not private.organization_network_has_permission(
      parent_item.organization_id,
      parent_item.partner_organization_id,
      case when new.kind = 'network_conversation' then 'message' else 'resource_request' end
    ) then
      raise exception 'organization network permission required' using errcode = '42501';
    end if;
  end if;

  if new.kind in ('coverage_schedule', 'coverage_override', 'committee')
    and new.chapter_id is null then
    raise exception 'chapter required for this coordination record' using errcode = '23514';
  end if;

  if new.kind = 'microsite_page' and (
    coalesce(new.config ->> 'sectionSlug', '') !~ '^[a-z0-9][a-z0-9-]{0,63}$'
    or coalesce(new.config ->> 'pageSlug', '') !~ '^[a-z0-9][a-z0-9-]{0,63}$'
  ) then
    raise exception 'microsite slugs unavailable' using errcode = '23514';
  end if;

  if new.kind = 'network_export_schedule' and (
    not (new.config ?& array['cadence', 'format', 'deliveryMode', 'nextRunAt'])
    or coalesce(new.config ->> 'cadence', '') not in ('daily', 'weekly', 'monthly')
    or coalesce(new.config ->> 'format', '') not in ('csv', 'json')
    or coalesce(new.config ->> 'deliveryMode', '') not in (
      'internal_download', 'email_unset', 'sftp_unset'
    )
  ) then
    raise exception 'export schedule configuration unavailable' using errcode = '23514';
  end if;

  if new.kind in ('coverage_schedule', 'coverage_override') then
    if not (new.config ? 'stewardUserId') then
      raise exception 'active coverage steward required' using errcode = '23514';
    end if;
    begin
      steward_id := nullif(new.config ->> 'stewardUserId', '')::uuid;
    exception when invalid_text_representation then
      steward_id := null;
    end;
    if steward_id is null or not exists (
      select 1 from public.organization_memberships m
      where m.organization_id = new.organization_id
        and m.user_id = steward_id and m.status = 'active'
    ) then
      raise exception 'active coverage steward required' using errcode = '23514';
    end if;
    if new.kind = 'coverage_schedule' and (
      not (new.config ?& array['dayOfWeek', 'startMinute', 'endMinute', 'timezone'])
      or coalesce((new.config ->> 'dayOfWeek')::integer, -1) not between 0 and 6
      or coalesce((new.config ->> 'startMinute')::integer, -1) not between 0 and 1439
      or coalesce((new.config ->> 'endMinute')::integer, -1) not between 1 and 1440
      or (new.config ->> 'startMinute')::integer >= (new.config ->> 'endMinute')::integer
    ) then
      raise exception 'coverage schedule window unavailable' using errcode = '23514';
    end if;
    if new.kind = 'coverage_override' and (
      not (new.config ?& array['startsAt', 'endsAt', 'available'])
      or (new.config ->> 'startsAt')::timestamptz >= (new.config ->> 'endsAt')::timestamptz
    ) then
      raise exception 'coverage override window unavailable' using errcode = '23514';
    end if;
  end if;

  return new;
exception when invalid_text_representation or datetime_field_overflow then
  raise exception 'coordination identifier unavailable' using errcode = '23514';
end;
$function$;

create trigger validate_organization_coordination_record_shape
before insert or update of kind, parent_id, chapter_id, config, status
on public.organization_coordination_records
for each row execute function private.validate_organization_coordination_record_shape();

create function private.validate_organization_coordination_resource_permission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.organization_network_has_permission(
    new.from_organization_id,
    new.to_organization_id,
    case when new.resource_kind = 'share' then 'resource_share' else 'resource_request' end
  ) then
    raise exception 'organization resource permission required' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create trigger validate_organization_coordination_resource_permission
before insert on public.organization_coordination_resources
for each row execute function private.validate_organization_coordination_resource_permission();

create function private.award_organization_mission_badges()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  badge record;
begin
  if new.points <= old.points then return new; end if;
  for badge in
    select * from (values ('bronze'::text, 25), ('silver'::text, 100), ('gold'::text, 250)) threshold(badge_key, points)
  loop
    if new.points >= badge.points then
      insert into public.organization_mission_badges (
        mission_id, organization_id, user_id, privacy_alias, badge_key
      ) values (
        new.record_id, new.organization_id, new.user_id, new.privacy_alias,
        badge.badge_key
      ) on conflict do nothing;
    end if;
  end loop;
  return new;
end;
$function$;

create trigger award_organization_mission_badges
after update of points on public.organization_coordination_user_participants
for each row execute function private.award_organization_mission_badges();

revoke all on function private.organization_network_has_permission(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.organization_network_can_discover(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_organization_coordination_record_shape()
  from public, anon, authenticated, service_role;
revoke all on function private.validate_organization_coordination_resource_permission()
  from public, anon, authenticated, service_role;
revoke all on function private.award_organization_mission_badges()
  from public, anon, authenticated, service_role;

create policy organization_network_directory_read
  on public.organization_network_directory_profiles for select to authenticated
  using (private.organization_network_can_discover(organization_id));
create policy organization_network_permission_read
  on public.organization_network_permission_grants for select to authenticated
  using (
    private.organization_coordination_is_staff(
      (select private.current_member_organization())
    )
    and (grantor_organization_id = (select private.current_member_organization())
      or grantee_organization_id = (select private.current_member_organization()))
  );
create policy organization_network_access_read
  on public.organization_network_access_events for select to authenticated
  using (
    private.organization_coordination_is_staff(
      (select private.current_member_organization())
    )
    and (actor_organization_id = (select private.current_member_organization())
      or subject_organization_id = (select private.current_member_organization()))
  );
create policy organization_mission_badges_read
  on public.organization_mission_badges for select to authenticated
  using (
    private.organization_coordination_can_read(mission_id)
    and (user_id = (select auth.uid())
      or private.organization_coordination_is_staff(organization_id))
  );
create policy organization_merge_match_read
  on public.organization_merge_match_reviews for select to authenticated
  using (
    private.organization_coordination_can_read(plan_id)
    and private.has_organization_role(
      (select private.current_member_organization()), array['admin','vp']
    )
  );
create policy organization_merge_jobs_read
  on public.organization_merge_jobs for select to authenticated
  using (
    private.has_organization_role(
      (select private.current_member_organization()), array['admin','vp']
    )
    and (source_organization_id = (select private.current_member_organization())
      or target_organization_id = (select private.current_member_organization()))
  );
create policy organization_coordination_page_attachments_read
  on public.organization_coordination_page_attachments for select to authenticated
  using (private.organization_coordination_can_read(page_id));

do $block$
declare table_name text;
begin
  foreach table_name in array array[
    'organization_network_directory_profiles',
    'organization_network_permission_grants',
    'organization_network_access_events',
    'organization_mission_badges',
    'organization_merge_match_reviews',
    'organization_merge_jobs',
    'organization_coordination_page_attachments'
  ] loop
    execute pg_catalog.format(
      'create policy mfa_assurance on public.%I as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()))',
      table_name
    );
    execute pg_catalog.format(
      'revoke all on public.%I from public, anon, authenticated', table_name
    );
    execute pg_catalog.format(
      'grant select on public.%I to authenticated', table_name
    );
  end loop;
end;
$block$;

create function public.upsert_organization_network_profile(
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
    select 1 from public.organizations o
    where o.id = p_parent_organization_id and o.status = 'active'
  ) then
    raise exception 'parent organization unavailable' using errcode = '22023';
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
    'visibility', p_visibility, 'contactMode', p_contact_mode
  );
end;
$function$;

create function public.set_organization_network_permission(
  p_network_record_id uuid,
  p_grantee_organization_id uuid,
  p_capability text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  network_item public.organization_coordination_records%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['coordinator','admin','vp']) then
    raise exception 'organization network role required' using errcode = '42501';
  end if;
  select * into network_item
  from public.organization_coordination_records r
  where r.id = p_network_record_id and r.kind = 'network_link'
    and r.status = 'active';
  if not found or not private.organization_coordination_can_read(network_item.id)
    or p_grantee_organization_id = organization
    or not exists (
      select 1
      from public.organization_coordination_organization_participants p
      where p.record_id = network_item.id
        and p.organization_id = organization and p.status = 'active'
    )
    or not exists (
      select 1
      from public.organization_coordination_organization_participants p
      where p.record_id = network_item.id
        and p.organization_id = p_grantee_organization_id and p.status = 'active'
    ) then
    raise exception 'active organization network unavailable' using errcode = '22023';
  end if;
  insert into public.organization_network_permission_grants (
    network_record_id, grantor_organization_id, grantee_organization_id,
    capability, status, granted_by, revoked_at
  ) values (
    network_item.id, organization, p_grantee_organization_id, p_capability,
    case when p_enabled then 'active' else 'revoked' end, caller,
    case when p_enabled then null else pg_catalog.clock_timestamp() end
  ) on conflict (
    network_record_id, grantor_organization_id, grantee_organization_id, capability
  ) do update set
    status = excluded.status,
    granted_by = caller,
    granted_at = pg_catalog.clock_timestamp(),
    revoked_at = excluded.revoked_at;
  insert into public.organization_network_access_events (
    actor_organization_id, subject_organization_id, actor_user_id,
    action, outcome, metadata
  ) values (
    organization, p_grantee_organization_id, caller, 'permission_changed',
    'allowed', pg_catalog.jsonb_build_object(
      'capability', p_capability, 'enabled', p_enabled,
      'networkRecordId', p_network_record_id
    )
  );
  return pg_catalog.jsonb_build_object(
    'saved', true, 'capability', p_capability, 'enabled', p_enabled
  );
end;
$function$;

create function public.invite_organization_coordination_participant(
  p_record_id uuid,
  p_organization_id uuid,
  p_role text default 'member',
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
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['coordinator','admin','vp']) then
    raise exception 'organization invitation role required' using errcode = '42501';
  end if;
  select * into item from public.organization_coordination_records r
  where r.id = p_record_id and r.kind in ('coalition', 'coalition_campaign')
    and r.status = 'active';
  if not found or not private.organization_coordination_can_read(item.id)
    or p_organization_id = organization
    or p_role not in ('member', 'observer', 'approver')
    or not exists (
      select 1 from public.organizations o
      where o.id = p_organization_id and o.status = 'active'
    ) then
    raise exception 'coalition participant unavailable' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_coordination_organization_participants p
    where p.record_id = item.id and p.organization_id = organization
      and p.status = 'active' and p.role in ('owner', 'approver')
  ) then
    raise exception 'coalition invitation authority required' using errcode = '42501';
  end if;
  insert into public.organization_coordination_organization_participants (
    record_id, organization_id, role, status, invited_by
  ) values (item.id, p_organization_id, p_role, 'invited', caller)
  on conflict (record_id, organization_id) do update
    set role = excluded.role, status = 'invited', invited_by = caller,
        responded_by = null, updated_at = pg_catalog.clock_timestamp();
  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, to_status,
    metadata, idempotency_key
  ) values (
    item.id, organization, caller, 'organization_invited', 'invited',
    pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id, 'role', p_role
    ), p_idempotency_key
  ) on conflict (idempotency_key) do nothing;
  return pg_catalog.jsonb_build_object(
    'invited', true, 'recordId', item.id,
    'organizationId', p_organization_id
  );
end;
$function$;

create function public.respond_organization_coordination_participant(
  p_record_id uuid,
  p_accept boolean,
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
  participant public.organization_coordination_organization_participants%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['coordinator','admin','vp']) then
    raise exception 'organization invitation role required' using errcode = '42501';
  end if;
  select * into participant
  from public.organization_coordination_organization_participants p
  where p.record_id = p_record_id and p.organization_id = organization
    and p.status = 'invited' for update;
  if not found then
    raise exception 'coordination invitation unavailable' using errcode = '22023';
  end if;
  update public.organization_coordination_organization_participants
  set status = case when p_accept then 'active' else 'declined' end,
      responded_by = caller, updated_at = pg_catalog.clock_timestamp()
  where id = participant.id;
  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, to_status,
    metadata, idempotency_key
  ) values (
    p_record_id, organization, caller,
    case when p_accept then 'organization_joined' else 'organization_declined' end,
    case when p_accept then 'active' else 'declined' end,
    pg_catalog.jsonb_build_object('role', participant.role), p_idempotency_key
  ) on conflict (idempotency_key) do nothing;
  return pg_catalog.jsonb_build_object(
    'accepted', p_accept, 'recordId', p_record_id
  );
end;
$function$;

create function public.respond_organization_coordination_resource(
  p_resource_id uuid,
  p_accept boolean,
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
  resource public.organization_coordination_resources%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'organization resource role required' using errcode = '42501';
  end if;
  select * into resource
  from public.organization_coordination_resources x
  where x.id = p_resource_id and x.to_organization_id = organization
    and x.status in ('requested', 'available') for update;
  if not found then
    raise exception 'organization resource unavailable' using errcode = '22023';
  end if;
  update public.organization_coordination_resources
  set status = case when p_accept then 'accepted' else 'declined' end,
      updated_at = pg_catalog.clock_timestamp()
  where id = resource.id;
  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, to_status,
    metadata, idempotency_key
  ) values (
    resource.record_id, organization, caller,
    case when p_accept then 'resource_accepted' else 'resource_declined' end,
    case when p_accept then 'accepted' else 'declined' end,
    pg_catalog.jsonb_build_object('resourceId', resource.id), p_idempotency_key
  ) on conflict (idempotency_key) do nothing;
  return pg_catalog.jsonb_build_object(
    'accepted', p_accept, 'resourceId', resource.id
  );
end;
$function$;

create function public.get_organization_coordination_shared_document(
  p_resource_id uuid
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
  resource public.organization_coordination_resources%rowtype;
  document public.chapter_documents%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'organization resource role required' using errcode = '42501';
  end if;
  select * into resource
  from public.organization_coordination_resources x
  where x.id = p_resource_id and x.resource_kind = 'share'
    and x.status = 'accepted'
    and organization in (x.from_organization_id, x.to_organization_id);
  if not found or not private.organization_network_has_permission(
    resource.from_organization_id, resource.to_organization_id, 'resource_share'
  ) then
    raise exception 'shared document unavailable' using errcode = '22023';
  end if;
  select * into document
  from public.chapter_documents d where d.id = resource.chapter_document_id;
  if not found then
    raise exception 'shared document unavailable' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object(
    'resourceId', resource.id,
    'documentId', document.id,
    'title', document.title,
    'documentType', document.document_type,
    'summary', document.summary,
    'body', document.body,
    'sourceUrl', document.source_url,
    'version', document.version
  );
end;
$function$;

create function public.assign_organization_coordination_participant(
  p_record_id uuid,
  p_user_id uuid,
  p_role text,
  p_active boolean default true,
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
  alias_value text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'organization assignment role required' using errcode = '42501';
  end if;
  select * into item from public.organization_coordination_records r
  where r.id = p_record_id and r.kind in (
    'mission', 'network_conversation', 'coalition_campaign', 'committee',
    'coverage_schedule', 'mobilization_campaign', 'mobilization_cohort'
  );
  if not found or not private.organization_coordination_can_read(item.id)
    or not exists (
      select 1 from public.organization_memberships m
      where m.organization_id = organization and m.user_id = p_user_id
        and m.status = 'active'
    ) then
    raise exception 'organization participant unavailable' using errcode = '22023';
  end if;
  if p_role not in (
    'participant', 'captain', 'committee_member', 'coverage_steward',
    'conversation_member', 'campaign_lead', 'observer'
  ) then
    raise exception 'participant role unavailable' using errcode = '22023';
  end if;
  alias_value := 'Member ' || pg_catalog.upper(pg_catalog.substr(
    pg_catalog.encode(extensions.digest(p_user_id::text || item.id::text, 'sha256'), 'hex'),
    1, 8
  ));
  insert into public.organization_coordination_user_participants (
    record_id, organization_id, user_id, role, status, privacy_alias
  ) values (
    item.id, organization, p_user_id, p_role,
    case when p_active then 'active' else 'revoked' end, alias_value
  ) on conflict (record_id, organization_id, user_id) do update
    set role = excluded.role, status = excluded.status,
        updated_at = pg_catalog.clock_timestamp();
  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, to_status,
    metadata, idempotency_key
  ) values (
    item.id, organization, caller,
    case when p_active then 'participant_assigned' else 'participant_revoked' end,
    case when p_active then 'active' else 'revoked' end,
    pg_catalog.jsonb_build_object('userId', p_user_id, 'role', p_role),
    p_idempotency_key
  ) on conflict (idempotency_key) do nothing;
  return pg_catalog.jsonb_build_object(
    'saved', true, 'recordId', item.id, 'userId', p_user_id,
    'active', p_active
  );
end;
$function$;

create function public.review_organization_merge_match(
  p_plan_id uuid,
  p_source_user_id uuid,
  p_target_user_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  plan public.organization_coordination_records%rowtype;
  review_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['admin','vp']) then
    raise exception 'organization merger role required' using errcode = '42501';
  end if;
  select * into plan from public.organization_coordination_records r
  where r.id = p_plan_id and r.kind = 'merger_plan'
    and r.status = 'active' and r.partner_organization_id = organization;
  if not found or p_decision not in ('approved', 'rejected')
    or not exists (
      select 1 from public.organization_memberships m
      where m.organization_id = plan.organization_id
        and m.user_id = p_source_user_id and m.status = 'active'
    )
    or not exists (
      select 1 from public.organization_memberships m
      where m.organization_id = plan.partner_organization_id
        and m.user_id = p_target_user_id and m.status = 'active'
    ) then
    raise exception 'organization merger match unavailable' using errcode = '22023';
  end if;
  insert into public.organization_merge_match_reviews (
    plan_id, source_user_id, target_user_id, decision, reviewed_by, reviewed_at
  ) values (
    plan.id, p_source_user_id, p_target_user_id, p_decision, caller,
    pg_catalog.clock_timestamp()
  ) on conflict (plan_id, source_user_id, target_user_id) do update
    set decision = excluded.decision, reviewed_by = caller,
        reviewed_at = pg_catalog.clock_timestamp()
  returning id into review_id;
  return pg_catalog.jsonb_build_object(
    'reviewId', review_id, 'decision', p_decision
  );
end;
$function$;

create function public.execute_organization_merge_plan(
  p_plan_id uuid,
  p_expected_source_organization_id uuid,
  p_expected_target_organization_id uuid,
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
  plan public.organization_coordination_records%rowtype;
  job public.organization_merge_jobs%rowtype;
  approved_count integer;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['admin','vp']) then
    raise exception 'organization merger role required' using errcode = '42501';
  end if;
  select * into plan from public.organization_coordination_records r
  where r.id = p_plan_id and r.kind = 'merger_plan'
    and r.status = 'active' for update;
  if not found or plan.organization_id <> p_expected_source_organization_id
    or plan.partner_organization_id <> p_expected_target_organization_id
    or organization <> plan.partner_organization_id then
    raise exception 'organization merger plan changed' using errcode = '40001';
  end if;
  select pg_catalog.count(*)::integer into approved_count
  from public.organization_merge_match_reviews review
  where review.plan_id = plan.id and review.decision = 'approved';
  if approved_count = 0 then
    raise exception 'approved organization matches required' using errcode = '22023';
  end if;
  insert into public.organization_merge_jobs (
    plan_id, source_organization_id, target_organization_id, status,
    requested_by, executed_by, approved_match_count, started_at, completed_at
  ) values (
    plan.id, plan.organization_id, plan.partner_organization_id, 'completed',
    caller, caller, approved_count, pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ) on conflict (plan_id) do update set plan_id = excluded.plan_id
  returning * into job;
  if job.target_organization_id <> organization then
    raise exception 'organization merger job unavailable' using errcode = '42501';
  end if;
  insert into public.organization_merge_remap_events (
    plan_id, source_organization_id, target_organization_id, object_type,
    source_object_id, target_object_id, executed_by
  )
  select plan.id, plan.organization_id, plan.partner_organization_id,
    'member_identity', review.source_user_id::text, review.target_user_id::text,
    caller
  from public.organization_merge_match_reviews review
  where review.plan_id = plan.id and review.decision = 'approved'
    and not exists (
      select 1 from public.organization_merge_remap_events remap
      where remap.plan_id = plan.id and remap.object_type = 'member_identity'
        and remap.source_object_id = review.source_user_id::text
        and remap.target_object_id = review.target_user_id::text
    );
  update public.organization_coordination_records
  set status = 'executed', updated_at = pg_catalog.clock_timestamp()
  where id = plan.id;
  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, from_status,
    to_status, metadata, idempotency_key
  ) values (
    plan.id, organization, caller, 'merge_mapping_executed', plan.status,
    'executed', pg_catalog.jsonb_build_object(
      'jobId', job.id, 'approvedMatchCount', approved_count
    ), p_idempotency_key
  ) on conflict (idempotency_key) do nothing;
  return pg_catalog.jsonb_build_object(
    'jobId', job.id, 'status', job.status,
    'approvedMatchCount', approved_count
  );
end;
$function$;

create function public.attach_organization_coordination_page_document(
  p_page_id uuid,
  p_chapter_document_id uuid,
  p_label text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  page public.organization_coordination_records%rowtype;
  attachment_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'chapter publishing role required' using errcode = '42501';
  end if;
  select * into page from public.organization_coordination_records r
  where r.id = p_page_id and r.kind = 'microsite_page'
    and r.organization_id = organization;
  if not found or not exists (
    select 1 from public.chapter_documents d
    where d.id = p_chapter_document_id and d.chapter_id = page.chapter_id
  ) then
    raise exception 'chapter page attachment unavailable' using errcode = '22023';
  end if;
  insert into public.organization_coordination_page_attachments (
    page_id, organization_id, chapter_document_id, label, attached_by
  ) values (
    page.id, organization, p_chapter_document_id, pg_catalog.btrim(p_label), caller
  ) on conflict (page_id, chapter_document_id) do update
    set label = excluded.label, attached_by = caller,
        attached_at = pg_catalog.clock_timestamp()
  returning id into attachment_id;
  return pg_catalog.jsonb_build_object(
    'attachmentId', attachment_id, 'pageId', page.id
  );
end;
$function$;

create function public.take_over_organization_coordination_page(
  p_page_id uuid,
  p_reason text,
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
  page public.organization_coordination_records%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['admin','vp']) then
    raise exception 'chapter takeover role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 4 and 500 then
    raise exception 'takeover reason required' using errcode = '22023';
  end if;
  select * into page from public.organization_coordination_records r
  where r.id = p_page_id and r.kind = 'microsite_page'
    and r.organization_id = organization for update;
  if not found then
    raise exception 'chapter page unavailable' using errcode = '22023';
  end if;
  update public.organization_coordination_records
  set created_by = caller,
      config = config || pg_catalog.jsonb_build_object(
        'takeoverReason', pg_catalog.btrim(p_reason),
        'takenOverAt', pg_catalog.clock_timestamp()
      ),
      updated_at = pg_catalog.clock_timestamp()
  where id = page.id;
  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type,
    metadata, idempotency_key
  ) values (
    page.id, organization, caller, 'page_taken_over',
    pg_catalog.jsonb_build_object(
      'previousOwnerId', page.created_by,
      'reason', pg_catalog.btrim(p_reason)
    ), p_idempotency_key
  ) on conflict (idempotency_key) do nothing;
  return pg_catalog.jsonb_build_object(
    'takenOver', true, 'pageId', page.id, 'ownerId', caller
  );
end;
$function$;

create function public.recommend_organization_coverage(
  p_chapter_id text,
  p_at timestamptz default pg_catalog.now()
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
  chosen record;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.is_organization_member(organization)
    or not exists (
      select 1 from public.chapters c
      where c.id = p_chapter_id and c.organization_id = organization
    ) then
    raise exception 'chapter coverage unavailable' using errcode = '42501';
  end if;

  select r.id, (r.config ->> 'stewardUserId')::uuid as steward_user_id,
    'override'::text as source
  into chosen
  from public.organization_coordination_records r
  where r.organization_id = organization and r.chapter_id = p_chapter_id
    and r.kind = 'coverage_override' and r.status = 'active'
    and coalesce((r.config ->> 'available')::boolean, true)
    and p_at >= (r.config ->> 'startsAt')::timestamptz
    and p_at < (r.config ->> 'endsAt')::timestamptz
  order by r.updated_at desc, r.id desc limit 1;

  if not found then
    select r.id, (r.config ->> 'stewardUserId')::uuid as steward_user_id,
      'schedule'::text as source
    into chosen
    from public.organization_coordination_records r
    cross join lateral (
      select p_at at time zone coalesce(nullif(r.config ->> 'timezone', ''), 'America/New_York') as local_at
    ) local_time
    where r.organization_id = organization and r.chapter_id = p_chapter_id
      and r.kind = 'coverage_schedule' and r.status = 'active'
      and extract(dow from local_time.local_at)::integer = (r.config ->> 'dayOfWeek')::integer
      and (extract(hour from local_time.local_at)::integer * 60
        + extract(minute from local_time.local_at)::integer)
        between (r.config ->> 'startMinute')::integer
          and ((r.config ->> 'endMinute')::integer - 1)
    order by coalesce((r.config ->> 'priority')::integer, 0) desc,
      r.updated_at desc, r.id desc limit 1;
  end if;

  if chosen.steward_user_id is null then
    return pg_catalog.jsonb_build_object(
      'state', 'uncovered', 'chapterId', p_chapter_id,
      'recommendedUserId', null
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'state', 'covered', 'chapterId', p_chapter_id,
    'recommendedUserId', chosen.steward_user_id,
    'source', chosen.source, 'recordId', chosen.id,
    'contactRoute', 'member_message'
  );
end;
$function$;

create function public.run_due_organization_coordination_exports(
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
  if p_limit not between 1 and 200 then
    raise exception 'export batch limit unavailable' using errcode = '22023';
  end if;
  for schedule in
    select r.* from public.organization_coordination_records r
    where r.kind = 'network_export_schedule' and r.status = 'active'
      and coalesce((r.config ->> 'nextRunAt')::timestamptz, p_now) <= p_now
    order by (r.config ->> 'nextRunAt')::timestamptz nulls first, r.id
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
          or scoped.partner_organization_id = schedule.organization_id),
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

create function public.get_organization_coordination_extensions()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  staff boolean;
  merger_staff boolean;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if organization is null then
    return pg_catalog.jsonb_build_object(
      'state', 'empty', 'organizationId', null,
      'directory', '[]'::jsonb, 'permissions', '[]'::jsonb,
      'invitations', '[]'::jsonb, 'badges', '[]'::jsonb,
      'recentActivity', '[]'::jsonb, 'organizationParticipants', '[]'::jsonb,
      'userParticipants', '[]'::jsonb, 'mergeMatches', '[]'::jsonb,
      'mergeJobs', '[]'::jsonb, 'pageAttachments', '[]'::jsonb,
      'mobilizationProgress', '[]'::jsonb
    );
  end if;
  if not private.is_organization_member(organization) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  staff := private.organization_coordination_is_staff(organization);
  merger_staff := private.has_organization_role(organization, array['admin','vp']);

  insert into public.organization_network_access_events (
    actor_organization_id, subject_organization_id, actor_user_id,
    action, outcome
  )
  select organization, profile.organization_id, caller,
    'directory_viewed', 'allowed'
  from public.organization_network_directory_profiles profile
  where profile.organization_id <> organization
    and private.organization_network_can_discover(profile.organization_id)
  order by profile.organization_id
  limit 100;

  return pg_catalog.jsonb_build_object(
    'state', 'ready', 'organizationId', organization,
    'directory', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', profile.organization_id,
        'displayName', profile.display_name,
        'summary', profile.summary,
        'visibility', profile.visibility,
        'contactMode', profile.contact_mode,
        'parentOrganizationId', profile.parent_organization_id,
        'updatedAt', profile.updated_at
      ) order by profile.display_name, profile.organization_id)
      from public.organization_network_directory_profiles profile
      where private.organization_network_can_discover(profile.organization_id)
    ), '[]'::jsonb),
    'permissions', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', permission.id,
        'networkRecordId', permission.network_record_id,
        'grantorOrganizationId', permission.grantor_organization_id,
        'granteeOrganizationId', permission.grantee_organization_id,
        'capability', permission.capability,
        'status', permission.status,
        'updatedAt', coalesce(permission.revoked_at, permission.granted_at)
      ) order by permission.capability, permission.granted_at desc)
      from public.organization_network_permission_grants permission
      where permission.grantor_organization_id = organization
        or permission.grantee_organization_id = organization
    ), '[]'::jsonb) else '[]'::jsonb end,
    'invitations', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'recordId', participant.record_id,
        'title', item.title,
        'kind', item.kind,
        'role', participant.role,
        'invitedAt', participant.created_at
      ) order by participant.created_at desc, participant.id desc)
      from public.organization_coordination_organization_participants participant
      join public.organization_coordination_records item
        on item.id = participant.record_id
      where participant.organization_id = organization
        and participant.status = 'invited'
    ), '[]'::jsonb) else '[]'::jsonb end,
    'badges', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'missionId', badge.mission_id,
        'alias', badge.privacy_alias,
        'badge', badge.badge_key,
        'awardedAt', badge.awarded_at
      ) order by badge.awarded_at desc, badge.badge_key)
      from public.organization_mission_badges badge
      where private.organization_coordination_can_read(badge.mission_id)
    ), '[]'::jsonb),
    'recentActivity', coalesce((
      select pg_catalog.jsonb_agg(activity.item order by activity.created_at desc)
      from (
        select event.created_at,
          pg_catalog.jsonb_build_object(
            'recordId', event.record_id,
            'type', event.event_type,
            'fromStatus', event.from_status,
            'toStatus', event.to_status,
            'pointsDelta', event.points_delta,
            'createdAt', event.created_at
          ) as item
        from public.organization_coordination_events event
        where private.organization_coordination_can_read(event.record_id)
        order by event.created_at desc, event.id desc limit 100
      ) activity
    ), '[]'::jsonb),
    'organizationParticipants', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'recordId', participant.record_id,
        'organizationId', participant.organization_id,
        'role', participant.role,
        'status', participant.status,
        'updatedAt', participant.updated_at
      ) order by participant.updated_at desc, participant.id desc)
      from public.organization_coordination_organization_participants participant
      where private.organization_coordination_can_read(participant.record_id)
    ), '[]'::jsonb) else '[]'::jsonb end,
    'userParticipants', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'recordId', participant.record_id,
        'alias', participant.privacy_alias,
        'role', participant.role,
        'status', participant.status,
        'points', participant.points,
        'self', participant.user_id = caller
      ) order by participant.updated_at desc, participant.id desc)
      from public.organization_coordination_user_participants participant
      where private.organization_coordination_can_read(participant.record_id)
        and (staff or participant.user_id = caller)
    ), '[]'::jsonb),
    'mergeMatches', case when merger_staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', review.id, 'planId', review.plan_id,
        'sourceUserId', review.source_user_id,
        'targetUserId', review.target_user_id,
        'decision', review.decision, 'reviewedAt', review.reviewed_at
      ) order by review.created_at, review.id)
      from public.organization_merge_match_reviews review
      where private.organization_coordination_can_read(review.plan_id)
    ), '[]'::jsonb) else '[]'::jsonb end,
    'mergeJobs', case when merger_staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', job.id, 'planId', job.plan_id,
        'sourceOrganizationId', job.source_organization_id,
        'targetOrganizationId', job.target_organization_id,
        'status', job.status,
        'approvedMatchCount', job.approved_match_count,
        'requestedAt', job.requested_at,
        'completedAt', job.completed_at
      ) order by job.requested_at desc, job.id desc)
      from public.organization_merge_jobs job
      where job.source_organization_id = organization
        or job.target_organization_id = organization
    ), '[]'::jsonb) else '[]'::jsonb end,
    'pageAttachments', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', attachment.id, 'pageId', attachment.page_id,
        'documentId', attachment.chapter_document_id,
        'label', attachment.label, 'attachedAt', attachment.attached_at
      ) order by attachment.attached_at, attachment.id)
      from public.organization_coordination_page_attachments attachment
      where private.organization_coordination_can_read(attachment.page_id)
    ), '[]'::jsonb),
    'mobilizationProgress', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'campaignId', campaign.id,
        'title', campaign.title,
        'totalOutreach', campaign.total_outreach,
        'reached', campaign.reached,
        'committed', campaign.committed,
        'attended', campaign.attended
      ) order by campaign.title, campaign.id)
      from (
        select record.id, record.title,
          pg_catalog.count(outreach.id)::integer as total_outreach,
          pg_catalog.count(outreach.id) filter (where outreach.disposition = 'reached')::integer as reached,
          pg_catalog.count(outreach.id) filter (where outreach.disposition = 'committed')::integer as committed,
          pg_catalog.count(outreach.id) filter (where outreach.disposition = 'attended')::integer as attended
        from public.organization_coordination_records record
        left join public.organization_coordination_outreach_events outreach
          on outreach.campaign_id = record.id
        where record.organization_id = organization
          and record.kind = 'mobilization_campaign'
        group by record.id, record.title
      ) campaign
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$function$;

revoke all on function public.upsert_organization_network_profile(
  text, text, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.set_organization_network_permission(
  uuid, uuid, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.invite_organization_coordination_participant(
  uuid, uuid, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.respond_organization_coordination_participant(
  uuid, boolean, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.respond_organization_coordination_resource(
  uuid, boolean, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.get_organization_coordination_shared_document(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.assign_organization_coordination_participant(
  uuid, uuid, text, boolean, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.review_organization_merge_match(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.execute_organization_merge_plan(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.attach_organization_coordination_page_document(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.take_over_organization_coordination_page(
  uuid, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.recommend_organization_coverage(text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.run_due_organization_coordination_exports(
  timestamptz, integer
) from public, anon, authenticated, service_role;
revoke all on function public.get_organization_coordination_extensions()
  from public, anon, authenticated, service_role;

grant execute on function public.upsert_organization_network_profile(
  text, text, text, text, uuid
) to authenticated;
grant execute on function public.set_organization_network_permission(
  uuid, uuid, text, boolean
) to authenticated;
grant execute on function public.invite_organization_coordination_participant(
  uuid, uuid, text, uuid
) to authenticated;
grant execute on function public.respond_organization_coordination_participant(
  uuid, boolean, uuid
) to authenticated;
grant execute on function public.respond_organization_coordination_resource(
  uuid, boolean, uuid
) to authenticated;
grant execute on function public.get_organization_coordination_shared_document(uuid)
  to authenticated;
grant execute on function public.assign_organization_coordination_participant(
  uuid, uuid, text, boolean, uuid
) to authenticated;
grant execute on function public.review_organization_merge_match(
  uuid, uuid, uuid, text
) to authenticated;
grant execute on function public.execute_organization_merge_plan(
  uuid, uuid, uuid, uuid
) to authenticated;
grant execute on function public.attach_organization_coordination_page_document(
  uuid, uuid, text
) to authenticated;
grant execute on function public.take_over_organization_coordination_page(
  uuid, text, uuid
) to authenticated;
grant execute on function public.recommend_organization_coverage(text, timestamptz)
  to authenticated;
grant execute on function public.run_due_organization_coordination_exports(
  timestamptz, integer
) to service_role;
grant execute on function public.get_organization_coordination_extensions()
  to authenticated;

notify pgrst, 'reload schema';
