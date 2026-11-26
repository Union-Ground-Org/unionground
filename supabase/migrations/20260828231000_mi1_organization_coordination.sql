-- MI1 CR-053..CR-067: organization coordination foundation.
-- Sequenced after the casework suite already present on Main.
--
-- Donor baseline: donor-baseline-20260721.
-- Behavior retained: missions, explicit partner grants, cross-organization
-- conversations/resources, governed exports, handshake work, coalitions,
-- merger planning, chapter publishing, coverage, committees, and outreach.
-- Rejected: donor agency-as-tenant assumptions, caller-selected tenant ids,
-- direct table writes, browser service-role clients, legacy project ids,
-- fictional production tenants, and copied protected content in previews.
--
-- Zero organizations is valid. This migration inserts no tenant or user rows.

set local lock_timeout = '5s';

create table public.organization_coordination_records (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  partner_organization_id uuid
    references public.organizations(id) on update cascade on delete restrict,
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  parent_id uuid references public.organization_coordination_records(id) on delete cascade,
  kind text not null check (kind in (
    'mission', 'mission_objective', 'network_link', 'network_conversation',
    'network_request', 'network_export_schedule', 'handshake_workspace_item',
    'coalition', 'coalition_campaign', 'coalition_work_item', 'merger_plan',
    'microsite_page', 'coverage_schedule', 'coverage_override', 'committee',
    'mobilization_campaign', 'mobilization_cohort'
  )),
  title text not null,
  summary text not null default '',
  status text not null default 'draft' check (status in (
    'draft', 'requested', 'invited', 'active', 'paused', 'completed',
    'declined', 'closed', 'pending_operator', 'executed', 'failed'
  )),
  visibility text not null default 'staff' check (visibility in (
    'members', 'staff', 'participants', 'public'
  )),
  config jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null unique,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_coordination_records_distinct_partner check (
    partner_organization_id is null or partner_organization_id <> organization_id
  ),
  constraint organization_coordination_records_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 2 and 160
    and title !~ '[[:cntrl:]]'
  ),
  constraint organization_coordination_records_summary_bounded check (
    pg_catalog.char_length(summary) <= 4000
  ),
  constraint organization_coordination_records_config_object check (
    pg_catalog.jsonb_typeof(config) = 'object'
  ),
  constraint organization_coordination_records_config_bounded check (
    pg_catalog.octet_length(config::text) <= 12000
  )
);

create index organization_coordination_records_org_kind_idx
  on public.organization_coordination_records
  (organization_id, kind, status, updated_at desc, id desc);
create index organization_coordination_records_partner_idx
  on public.organization_coordination_records
  (partner_organization_id, kind, status, updated_at desc, id desc)
  where partner_organization_id is not null;
create index organization_coordination_records_parent_idx
  on public.organization_coordination_records (parent_id, kind, created_at, id)
  where parent_id is not null;
create index organization_coordination_records_creator_idx
  on public.organization_coordination_records (created_by, created_at desc)
  where created_by is not null;
create unique index organization_coordination_microsite_page_key
  on public.organization_coordination_records (
    organization_id, chapter_id,
    (config ->> 'sectionSlug'), (config ->> 'pageSlug')
  ) where kind = 'microsite_page';

create table public.organization_coordination_organization_participants (
  id uuid primary key default extensions.gen_random_uuid(),
  record_id uuid not null references public.organization_coordination_records(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  role text not null check (role in ('owner', 'partner', 'member', 'observer', 'approver')),
  status text not null default 'invited' check (status in ('invited', 'active', 'declined', 'revoked')),
  invited_by uuid references auth.users(id) on delete set null,
  responded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (record_id, organization_id)
);

create index organization_coordination_org_participant_idx
  on public.organization_coordination_organization_participants
  (organization_id, status, updated_at desc, record_id);
create index organization_coordination_org_participant_actor_idx
  on public.organization_coordination_organization_participants
  (invited_by, responded_by) where invited_by is not null or responded_by is not null;

create table public.organization_coordination_user_participants (
  id uuid primary key default extensions.gen_random_uuid(),
  record_id uuid not null references public.organization_coordination_records(id) on delete cascade,
  organization_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in (
    'participant', 'captain', 'committee_member', 'coverage_steward',
    'conversation_member', 'campaign_lead', 'observer'
  )),
  status text not null default 'active' check (status in ('invited', 'active', 'completed', 'declined', 'revoked')),
  points integer not null default 0 check (points between 0 and 1000000),
  privacy_alias text not null,
  config jsonb not null default '{}'::jsonb,
  joined_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id)
    on delete cascade,
  constraint organization_coordination_user_config_object check (
    pg_catalog.jsonb_typeof(config) = 'object'
  ),
  constraint organization_coordination_user_config_bounded check (
    pg_catalog.octet_length(config::text) <= 4000
  ),
  constraint organization_coordination_user_alias_bounded check (
    pg_catalog.char_length(privacy_alias) between 6 and 32
  ),
  unique (record_id, organization_id, user_id)
);

create index organization_coordination_user_participant_idx
  on public.organization_coordination_user_participants
  (organization_id, user_id, status, updated_at desc);
create index organization_coordination_leaderboard_idx
  on public.organization_coordination_user_participants
  (record_id, points desc, privacy_alias)
  where status in ('active', 'completed');

create table public.organization_coordination_events (
  id uuid primary key default extensions.gen_random_uuid(),
  record_id uuid not null references public.organization_coordination_records(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  from_status text,
  to_status text,
  points_delta integer not null default 0 check (points_delta between -100000 and 100000),
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key uuid not null unique,
  created_at timestamptz not null default pg_catalog.now(),
  constraint organization_coordination_events_type_bounded check (
    event_type ~ '^[a-z][a-z0-9_]{1,63}$'
  ),
  constraint organization_coordination_events_metadata_object check (
    pg_catalog.jsonb_typeof(metadata) = 'object'
  ),
  constraint organization_coordination_events_metadata_bounded check (
    pg_catalog.octet_length(metadata::text) <= 4000
  )
);

create index organization_coordination_events_record_idx
  on public.organization_coordination_events (record_id, created_at desc, id desc);
create index organization_coordination_events_org_actor_idx
  on public.organization_coordination_events (organization_id, actor_user_id, created_at desc);

create table public.organization_coordination_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  conversation_id uuid not null references public.organization_coordination_records(id) on delete cascade,
  sender_organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  sender_user_id uuid references auth.users(id) on delete set null,
  body text not null,
  idempotency_key uuid not null unique,
  created_at timestamptz not null default pg_catalog.now(),
  constraint organization_coordination_messages_body_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(body)) between 1 and 4000
  )
);

create index organization_coordination_messages_conversation_idx
  on public.organization_coordination_messages (conversation_id, created_at desc, id desc);
create index organization_coordination_messages_sender_idx
  on public.organization_coordination_messages
  (sender_organization_id, sender_user_id, created_at desc);

create table public.organization_coordination_resources (
  id uuid primary key default extensions.gen_random_uuid(),
  record_id uuid not null references public.organization_coordination_records(id) on delete cascade,
  from_organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  to_organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_document_id uuid references public.chapter_documents(id) on delete restrict,
  resource_kind text not null check (resource_kind in ('request', 'share')),
  title text not null,
  status text not null default 'requested' check (status in ('requested', 'available', 'accepted', 'declined', 'revoked')),
  idempotency_key uuid not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_coordination_resources_distinct_orgs check (
    from_organization_id <> to_organization_id
  ),
  constraint organization_coordination_resources_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 2 and 160
  ),
  constraint organization_coordination_resources_document_for_share check (
    (resource_kind = 'request' and chapter_document_id is null)
    or (resource_kind = 'share' and chapter_document_id is not null)
  )
);

create index organization_coordination_resources_record_idx
  on public.organization_coordination_resources (record_id, status, updated_at desc, id desc);
create index organization_coordination_resources_from_idx
  on public.organization_coordination_resources
  (from_organization_id, created_by, updated_at desc);
create index organization_coordination_resources_to_idx
  on public.organization_coordination_resources
  (to_organization_id, status, updated_at desc);
create index organization_coordination_resources_document_idx
  on public.organization_coordination_resources (chapter_document_id)
  where chapter_document_id is not null;

create table public.organization_coordination_export_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  schedule_id uuid not null references public.organization_coordination_records(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  requested_by uuid references auth.users(id) on delete set null,
  format text not null check (format in ('csv', 'json')),
  delivery_mode text not null default 'internal_download' check (delivery_mode in (
    'internal_download', 'email_unset', 'sftp_unset'
  )),
  status text not null default 'ready' check (status in ('queued', 'running', 'ready', 'failed', 'expired')),
  row_count integer not null default 0 check (row_count >= 0),
  expires_at timestamptz not null default (pg_catalog.now() + interval '24 hours'),
  idempotency_key uuid not null unique,
  created_at timestamptz not null default pg_catalog.now()
);

create index organization_coordination_export_runs_schedule_idx
  on public.organization_coordination_export_runs (schedule_id, created_at desc, id desc);
create index organization_coordination_export_runs_org_actor_idx
  on public.organization_coordination_export_runs
  (organization_id, requested_by, created_at desc);

create table public.organization_coordination_outreach_events (
  id uuid primary key default extensions.gen_random_uuid(),
  campaign_id uuid not null references public.organization_coordination_records(id) on delete cascade,
  organization_id uuid not null,
  target_user_id uuid not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  disposition text not null check (disposition in (
    'not_contacted', 'attempted', 'reached', 'follow_up', 'committed', 'declined', 'attended'
  )),
  note text not null default '',
  idempotency_key uuid not null unique,
  contacted_at timestamptz not null default pg_catalog.now(),
  foreign key (organization_id, target_user_id)
    references public.organization_memberships (organization_id, user_id)
    on delete restrict,
  constraint organization_coordination_outreach_note_bounded check (
    pg_catalog.char_length(note) <= 1000
  )
);

create index organization_coordination_outreach_campaign_idx
  on public.organization_coordination_outreach_events
  (campaign_id, contacted_at desc, id desc);
create index organization_coordination_outreach_target_idx
  on public.organization_coordination_outreach_events
  (organization_id, target_user_id, contacted_at desc);
create index organization_coordination_outreach_actor_idx
  on public.organization_coordination_outreach_events
  (actor_user_id, contacted_at desc) where actor_user_id is not null;

create table public.organization_merge_remap_events (
  id uuid primary key default extensions.gen_random_uuid(),
  plan_id uuid not null references public.organization_coordination_records(id) on delete restrict,
  source_organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  target_organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  object_type text not null,
  source_object_id text not null,
  target_object_id text not null,
  executed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint organization_merge_remap_distinct_orgs check (
    source_organization_id <> target_organization_id
  ),
  constraint organization_merge_remap_object_type_bounded check (
    object_type ~ '^[a-z][a-z0-9_]{1,63}$'
  )
);

create index organization_merge_remap_plan_idx
  on public.organization_merge_remap_events (plan_id, created_at, id);
create index organization_merge_remap_source_idx
  on public.organization_merge_remap_events
  (source_organization_id, created_at, id);
create index organization_merge_remap_target_idx
  on public.organization_merge_remap_events
  (target_organization_id, created_at, id);
create index organization_merge_remap_actor_idx
  on public.organization_merge_remap_events
  (executed_by, created_at) where executed_by is not null;

alter table public.organization_coordination_records enable row level security;
alter table public.organization_coordination_organization_participants enable row level security;
alter table public.organization_coordination_user_participants enable row level security;
alter table public.organization_coordination_events enable row level security;
alter table public.organization_coordination_messages enable row level security;
alter table public.organization_coordination_resources enable row level security;
alter table public.organization_coordination_export_runs enable row level security;
alter table public.organization_coordination_outreach_events enable row level security;
alter table public.organization_merge_remap_events enable row level security;

create function private.organization_coordination_is_staff(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_organization_id is not null
    and p_organization_id = (select private.current_member_organization())
    and private.has_organization_role(
      p_organization_id,
      array['steward','coordinator','advisor','admin','vp']
    );
$function$;

create function private.organization_coordination_can_read(p_record_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.organization_coordination_records r
    where r.id = p_record_id
      and (
        (
          r.organization_id = (select private.current_member_organization())
          or r.partner_organization_id = (select private.current_member_organization())
          or exists (
            select 1
            from public.organization_coordination_organization_participants p
            where p.record_id = r.id
              and p.organization_id = (select private.current_member_organization())
              and p.status = 'active'
          )
        )
        and (
          r.visibility in ('members', 'public')
          or private.organization_coordination_is_staff(
            (select private.current_member_organization())
          )
          or (
            r.visibility = 'participants'
            and exists (
              select 1
              from public.organization_coordination_user_participants u
              where u.record_id = r.id
                and u.organization_id = (select private.current_member_organization())
                and u.user_id = (select auth.uid())
                and u.status in ('active', 'completed')
            )
          )
        )
      )
  );
$function$;

revoke all on function private.organization_coordination_is_staff(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.organization_coordination_can_read(uuid)
  from public, anon, authenticated, service_role;

create policy organization_coordination_records_read
  on public.organization_coordination_records for select to authenticated
  using (private.organization_coordination_can_read(id));
create policy organization_coordination_org_participants_read
  on public.organization_coordination_organization_participants for select to authenticated
  using (private.organization_coordination_can_read(record_id));
create policy organization_coordination_user_participants_read
  on public.organization_coordination_user_participants for select to authenticated
  using (
    private.organization_coordination_can_read(record_id)
    and (
      user_id = (select auth.uid())
      or private.organization_coordination_is_staff(organization_id)
    )
  );
create policy organization_coordination_events_read
  on public.organization_coordination_events for select to authenticated
  using (private.organization_coordination_can_read(record_id));
create policy organization_coordination_messages_read
  on public.organization_coordination_messages for select to authenticated
  using (private.organization_coordination_can_read(conversation_id));
create policy organization_coordination_resources_read
  on public.organization_coordination_resources for select to authenticated
  using (private.organization_coordination_can_read(record_id));
create policy organization_coordination_export_runs_read
  on public.organization_coordination_export_runs for select to authenticated
  using (
    organization_id = (select private.current_member_organization())
    and private.organization_coordination_is_staff(organization_id)
  );
create policy organization_coordination_outreach_read
  on public.organization_coordination_outreach_events for select to authenticated
  using (
    organization_id = (select private.current_member_organization())
    and private.organization_coordination_is_staff(organization_id)
  );
create policy organization_merge_remap_read
  on public.organization_merge_remap_events for select to authenticated
  using (
    target_organization_id = (select private.current_member_organization())
    and private.has_organization_role(
      target_organization_id, array['coordinator','admin','vp']
    )
  );

do $block$
declare table_name text;
begin
  foreach table_name in array array[
    'organization_coordination_records',
    'organization_coordination_organization_participants',
    'organization_coordination_user_participants',
    'organization_coordination_events',
    'organization_coordination_messages',
    'organization_coordination_resources',
    'organization_coordination_export_runs',
    'organization_coordination_outreach_events',
    'organization_merge_remap_events'
  ] loop
    execute pg_catalog.format(
      'create policy mfa_assurance on public.%I as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()))',
      table_name
    );
    execute pg_catalog.format(
      'revoke all on public.%I from public, anon, authenticated',
      table_name
    );
    execute pg_catalog.format(
      'grant select on public.%I to authenticated',
      table_name
    );
  end loop;
end;
$block$;

create function public.create_organization_coordination_record(
  p_kind text,
  p_title text,
  p_summary text default '',
  p_visibility text default 'staff',
  p_partner_organization_id uuid default null,
  p_parent_id uuid default null,
  p_chapter_id text default null,
  p_config jsonb default '{}'::jsonb,
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
  created public.organization_coordination_records%rowtype;
  parent_item public.organization_coordination_records%rowtype;
  resolved_partner uuid := p_partner_organization_id;
  handshake_id uuid;
  initial_status text := 'draft';
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
     or not private.organization_coordination_is_staff(organization) then
    raise exception 'organization staff role required' using errcode = '42501';
  end if;
  if p_kind not in (
    'mission', 'mission_objective', 'network_link', 'network_conversation',
    'network_request', 'network_export_schedule', 'handshake_workspace_item',
    'coalition', 'coalition_campaign', 'coalition_work_item', 'merger_plan',
    'microsite_page', 'coverage_schedule', 'coverage_override', 'committee',
    'mobilization_campaign', 'mobilization_cohort'
  ) then
    raise exception 'unsupported coordination record kind' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_config, '{}'::jsonb)) <> 'object'
     or pg_catalog.octet_length(coalesce(p_config, '{}'::jsonb)::text) > 12000 then
    raise exception 'coordination config unavailable' using errcode = '22023';
  end if;
  if p_parent_id is not null then
    select * into parent_item
    from public.organization_coordination_records r
    where r.id = p_parent_id;
    if not found or not private.organization_coordination_can_read(parent_item.id) then
      raise exception 'coordination parent unavailable' using errcode = '22023';
    end if;
    if resolved_partner is null then
      resolved_partner := case
        when parent_item.organization_id = organization then parent_item.partner_organization_id
        else parent_item.organization_id
      end;
    end if;
  end if;
  if resolved_partner is not null and (
    resolved_partner = organization
    or not exists (
      select 1 from public.organizations o
      where o.id = resolved_partner and o.status = 'active'
    )
  ) then
    raise exception 'partner organization unavailable' using errcode = '22023';
  end if;
  if p_chapter_id is not null and not exists (
    select 1 from public.chapters c
    where c.id = p_chapter_id and c.organization_id = organization
  ) then
    raise exception 'chapter unavailable' using errcode = '22023';
  end if;
  if p_kind in ('network_link', 'merger_plan') and resolved_partner is null then
    raise exception 'partner organization required' using errcode = '22023';
  end if;
  if p_kind = 'microsite_page' and p_chapter_id is null then
    raise exception 'chapter required for microsite page' using errcode = '22023';
  end if;
  if p_kind = 'handshake_workspace_item' then
    begin
      handshake_id := nullif(p_config ->> 'handshakeId', '')::uuid;
    exception when invalid_text_representation then
      handshake_id := null;
    end;
    if handshake_id is null or not exists (
      select 1
      from public.chapter_handshakes h
      join public.chapters c on c.id in (h.chapter_id, h.receiving_chapter_id)
      where h.id = handshake_id and h.status = 'active'
        and c.organization_id = organization
    ) then
      raise exception 'active chapter handshake required' using errcode = '22023';
    end if;
  end if;
  if p_kind in ('mission', 'coalition', 'committee', 'mobilization_campaign') then
    initial_status := 'active';
  elsif p_kind in ('network_link', 'merger_plan') then
    initial_status := 'requested';
  elsif p_kind = 'microsite_page' then
    initial_status := 'draft';
  end if;

  insert into public.organization_coordination_records (
    organization_id, partner_organization_id, chapter_id, parent_id, kind,
    title, summary, status, visibility, config, created_by, idempotency_key
  ) values (
    organization, resolved_partner, p_chapter_id, p_parent_id, p_kind,
    pg_catalog.btrim(p_title), coalesce(p_summary, ''), initial_status,
    p_visibility, coalesce(p_config, '{}'::jsonb), caller, p_idempotency_key
  )
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into created;

  if created.organization_id <> organization then
    raise exception 'idempotency key unavailable' using errcode = '42501';
  end if;

  insert into public.organization_coordination_organization_participants (
    record_id, organization_id, role, status, invited_by, responded_by
  ) values (created.id, organization, 'owner', 'active', caller, caller)
  on conflict (record_id, organization_id) do nothing;

  if created.partner_organization_id is not null then
    insert into public.organization_coordination_organization_participants (
      record_id, organization_id, role, status, invited_by
    ) values (created.id, created.partner_organization_id, 'partner', 'invited', caller)
    on conflict (record_id, organization_id) do nothing;
  end if;

  if p_parent_id is not null then
    insert into public.organization_coordination_organization_participants (
      record_id, organization_id, role, status, invited_by, responded_by
    )
    select created.id, participant.organization_id,
      case when participant.organization_id = organization then 'owner' else 'member' end,
      participant.status, caller,
      case when participant.status = 'active' then caller else null end
    from public.organization_coordination_organization_participants participant
    where participant.record_id = p_parent_id
      and participant.status in ('active', 'invited')
    on conflict (record_id, organization_id) do nothing;
  end if;

  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, to_status,
    metadata, idempotency_key
  ) values (
    created.id, organization, caller, 'record_created', created.status,
    pg_catalog.jsonb_build_object('kind', created.kind),
    extensions.gen_random_uuid()
  );

  return pg_catalog.jsonb_build_object(
    'id', created.id, 'kind', created.kind, 'status', created.status,
    'organizationId', created.organization_id
  );
end;
$function$;

create function public.join_organization_coordination_record(
  p_record_id uuid,
  p_role text default 'participant',
  p_config jsonb default '{}'::jsonb,
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
     or not private.is_organization_member(organization) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  select * into item from public.organization_coordination_records r
  where r.id = p_record_id and r.status in ('active', 'invited');
  if not found or not private.organization_coordination_can_read(item.id) then
    raise exception 'coordination record unavailable' using errcode = '22023';
  end if;
  if item.kind not in ('mission', 'committee', 'network_conversation', 'coalition_campaign') then
    raise exception 'record does not accept user participation' using errcode = '22023';
  end if;
  if p_role not in (
    'participant', 'captain', 'committee_member', 'coverage_steward',
    'conversation_member', 'campaign_lead', 'observer'
  ) then
    raise exception 'participant role unavailable' using errcode = '22023';
  end if;
  alias_value := 'Member ' || pg_catalog.upper(pg_catalog.substr(
    pg_catalog.encode(extensions.digest(caller::text || item.id::text, 'sha256'), 'hex'),
    1, 8
  ));
  insert into public.organization_coordination_user_participants (
    record_id, organization_id, user_id, role, status, privacy_alias, config
  ) values (
    item.id, organization, caller, p_role, 'active', alias_value,
    coalesce(p_config, '{}'::jsonb)
  )
  on conflict (record_id, organization_id, user_id) do update
    set role = excluded.role, status = 'active', config = excluded.config,
        updated_at = pg_catalog.clock_timestamp();
  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, to_status,
    metadata, idempotency_key
  ) values (
    item.id, organization, caller, 'participant_joined', 'active',
    pg_catalog.jsonb_build_object('role', p_role), p_idempotency_key
  ) on conflict (idempotency_key) do nothing;
  return pg_catalog.jsonb_build_object('joined', true, 'recordId', item.id);
end;
$function$;

create function public.transition_organization_coordination_record(
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
  next_status text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  select * into item from public.organization_coordination_records r
  where r.id = p_record_id for update;
  if not found or not private.organization_coordination_can_read(item.id) then
    raise exception 'coordination record unavailable' using errcode = '22023';
  end if;
  if p_transition = 'complete_objective' and item.kind in ('mission', 'mission_objective') then
    update public.organization_coordination_user_participants
    set points = least(points + greatest(p_points, 0), 1000000),
        status = case when item.kind = 'mission' then 'completed' else status end,
        updated_at = pg_catalog.clock_timestamp()
    where record_id = coalesce(item.parent_id, item.id)
      and organization_id = organization and user_id = caller
      and status in ('active', 'completed');
    if not found then
      raise exception 'mission participation required' using errcode = '42501';
    end if;
    next_status := item.status;
  else
    if not private.organization_coordination_is_staff(organization) then
      raise exception 'organization staff role required' using errcode = '42501';
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
    if next_status is null then
      raise exception 'coordination transition unavailable' using errcode = '22023';
    end if;
    update public.organization_coordination_records
    set status = next_status,
        config = config || coalesce(p_config, '{}'::jsonb),
        updated_at = pg_catalog.clock_timestamp()
    where id = item.id;
  end if;
  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, from_status,
    to_status, points_delta, metadata, idempotency_key
  ) values (
    item.id, organization, caller, p_transition, item.status, next_status,
    case when p_transition = 'complete_objective' then greatest(p_points, 0) else 0 end,
    coalesce(p_config, '{}'::jsonb), p_idempotency_key
  ) on conflict (idempotency_key) do nothing;
  return pg_catalog.jsonb_build_object(
    'transitioned', true, 'recordId', item.id, 'status', next_status
  );
end;
$function$;

create function public.respond_organization_coordination_invitation(
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
  item public.organization_coordination_records%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
     or not private.organization_coordination_is_staff(organization) then
    raise exception 'organization staff role required' using errcode = '42501';
  end if;
  select * into item from public.organization_coordination_records r
  where r.id = p_record_id and r.partner_organization_id = organization
    and r.status in ('requested', 'invited') for update;
  if not found then
    raise exception 'coordination invitation unavailable' using errcode = '22023';
  end if;
  update public.organization_coordination_organization_participants
  set status = case when p_accept then 'active' else 'declined' end,
      responded_by = caller, updated_at = pg_catalog.clock_timestamp()
  where record_id = item.id and organization_id = organization;
  update public.organization_coordination_records
  set status = case when p_accept then 'active' else 'declined' end,
      updated_at = pg_catalog.clock_timestamp()
  where id = item.id;
  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, from_status,
    to_status, idempotency_key
  ) values (
    item.id, organization, caller,
    case when p_accept then 'invitation_accepted' else 'invitation_declined' end,
    item.status, case when p_accept then 'active' else 'declined' end,
    p_idempotency_key
  ) on conflict (idempotency_key) do nothing;
  return pg_catalog.jsonb_build_object('accepted', p_accept, 'recordId', item.id);
end;
$function$;

create function public.send_organization_coordination_message(
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
  message_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  select * into item from public.organization_coordination_records r
  where r.id = p_conversation_id
    and r.kind in ('network_conversation', 'coalition_campaign')
    and r.status = 'active';
  if not found or not private.organization_coordination_can_read(item.id) then
    raise exception 'coordination conversation unavailable' using errcode = '22023';
  end if;
  if not private.organization_coordination_is_staff(organization)
     and not exists (
       select 1 from public.organization_coordination_user_participants p
       where p.record_id = item.id and p.organization_id = organization
         and p.user_id = caller and p.status = 'active'
     ) then
    raise exception 'conversation participation required' using errcode = '42501';
  end if;
  insert into public.organization_coordination_messages (
    conversation_id, sender_organization_id, sender_user_id, body,
    idempotency_key
  ) values (
    item.id, organization, caller, pg_catalog.btrim(p_body), p_idempotency_key
  )
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning id into message_id;
  return pg_catalog.jsonb_build_object('sent', true, 'messageId', message_id);
end;
$function$;

create function public.share_organization_coordination_resource(
  p_record_id uuid,
  p_resource_kind text,
  p_title text,
  p_chapter_document_id uuid default null,
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
  target uuid;
  resource_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
     or not private.organization_coordination_is_staff(organization) then
    raise exception 'organization staff role required' using errcode = '42501';
  end if;
  select * into item from public.organization_coordination_records r
  where r.id = p_record_id and r.status = 'active';
  if not found or not private.organization_coordination_can_read(item.id)
     or item.partner_organization_id is null then
    raise exception 'coordination resource lane unavailable' using errcode = '22023';
  end if;
  target := case when item.organization_id = organization
    then item.partner_organization_id else item.organization_id end;
  if p_resource_kind = 'share' and not exists (
    select 1 from public.chapter_documents d
    join public.chapters c on c.id = d.chapter_id
    where d.id = p_chapter_document_id and c.organization_id = organization
  ) then
    raise exception 'authorized chapter document required' using errcode = '22023';
  end if;
  insert into public.organization_coordination_resources (
    record_id, from_organization_id, to_organization_id, chapter_document_id,
    resource_kind, title, status, idempotency_key, created_by
  ) values (
    item.id, organization, target, p_chapter_document_id, p_resource_kind,
    pg_catalog.btrim(p_title), case when p_resource_kind = 'share' then 'available' else 'requested' end,
    p_idempotency_key, caller
  )
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning id into resource_id;
  return pg_catalog.jsonb_build_object('created', true, 'resourceId', resource_id);
end;
$function$;

create function public.run_organization_coordination_export(
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
    select 1 from public.organization_coordination_records r
    where r.id = p_schedule_id and r.organization_id = organization
      and r.kind = 'network_export_schedule' and r.status = 'active'
  ) then
    raise exception 'export schedule unavailable' using errcode = '22023';
  end if;
  select pg_catalog.count(*)::integer into rows_ready
  from public.organization_coordination_records r
  where r.organization_id = organization or r.partner_organization_id = organization;
  insert into public.organization_coordination_export_runs (
    schedule_id, organization_id, requested_by, format, delivery_mode,
    status, row_count, idempotency_key
  ) values (
    p_schedule_id, organization, caller, p_format, 'internal_download',
    'ready', rows_ready, p_idempotency_key
  )
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning id into run_id;
  return pg_catalog.jsonb_build_object(
    'runId', run_id, 'status', 'ready', 'rowCount', rows_ready,
    'deliveryMode', 'internal_download'
  );
end;
$function$;

create function public.record_organization_coordination_outreach(
  p_campaign_id uuid,
  p_target_user_id uuid,
  p_disposition text,
  p_note text default '',
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
  event_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
     or not private.has_organization_role(organization, array['steward','coordinator','admin','vp']) then
    raise exception 'organization outreach role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_coordination_records r
    where r.id = p_campaign_id and r.organization_id = organization
      and r.kind = 'mobilization_campaign' and r.status in ('active', 'paused')
  ) then
    raise exception 'mobilization campaign unavailable' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = organization and m.user_id = p_target_user_id
      and m.status = 'active'
  ) then
    raise exception 'member unavailable' using errcode = '22023';
  end if;
  insert into public.organization_coordination_outreach_events (
    campaign_id, organization_id, target_user_id, actor_user_id,
    disposition, note, idempotency_key
  ) values (
    p_campaign_id, organization, p_target_user_id, caller,
    p_disposition, coalesce(p_note, ''), p_idempotency_key
  )
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning id into event_id;
  return pg_catalog.jsonb_build_object('recorded', true, 'eventId', event_id);
end;
$function$;

create function public.get_organization_coordination_snapshot()
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

revoke all on function public.create_organization_coordination_record(
  text, text, text, text, uuid, uuid, text, jsonb, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.join_organization_coordination_record(
  uuid, text, jsonb, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.transition_organization_coordination_record(
  uuid, text, jsonb, integer, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.respond_organization_coordination_invitation(
  uuid, boolean, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.send_organization_coordination_message(
  uuid, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.share_organization_coordination_resource(
  uuid, text, text, uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.run_organization_coordination_export(
  uuid, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.record_organization_coordination_outreach(
  uuid, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.get_organization_coordination_snapshot()
  from public, anon, authenticated, service_role;

grant execute on function public.create_organization_coordination_record(
  text, text, text, text, uuid, uuid, text, jsonb, uuid
) to authenticated;
grant execute on function public.join_organization_coordination_record(
  uuid, text, jsonb, uuid
) to authenticated;
grant execute on function public.transition_organization_coordination_record(
  uuid, text, jsonb, integer, uuid
) to authenticated;
grant execute on function public.respond_organization_coordination_invitation(
  uuid, boolean, uuid
) to authenticated;
grant execute on function public.send_organization_coordination_message(
  uuid, text, uuid
) to authenticated;
grant execute on function public.share_organization_coordination_resource(
  uuid, text, text, uuid, uuid
) to authenticated;
grant execute on function public.run_organization_coordination_export(
  uuid, text, uuid
) to authenticated;
grant execute on function public.record_organization_coordination_outreach(
  uuid, uuid, text, text, uuid
) to authenticated;
grant execute on function public.get_organization_coordination_snapshot()
  to authenticated;

notify pgrst, 'reload schema';
