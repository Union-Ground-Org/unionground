-- INTEGRATIONS of the owner-authorized "restore everything" campaign
-- (owner request 2026-10-01; defaults per decision D2: the old app's effective
-- production default, each with a visible admin switch).
--
--   REQ-UG-GOOGLE-WALLET-PASS-20261001
--     Save the membership card to Google Wallet when the operator has set the
--     Google Wallet issuer and service account. The pass text comes from this
--     server read, never from the browser.
--   REQ-UG-ORG-CALENDAR-PUSH-SYNC-20261001 (CR-090)
--     An organization administrator connects the organization's own Google
--     account (OAuth, calendar.events scope). A scheduled job copies chapter
--     events to the chosen calendar and keeps the copies updated, moved or
--     removed. Activation ships unset.
--   REQ-UG-DRIVE-PER-CASE-FOLDERS-20261001 (CR-075)
--     When Google Drive is connected, staff may file uploads into a folder per
--     case or per meeting. Case access is the casework rule; restricted cases
--     never get a Drive folder. Nothing is copied out of product storage.
--   REQ-UG-COOP-CHECKOFF-LISTS-20261001
--     A member check-off list attached to an ordinary Standard Task: the roster
--     is split across stewards by hand, evenly, at random, or shared. Access is
--     the task board's own chapter staff rule; no task-level ACL is added.
--
-- Every new table is private (no client grant, forced RLS). Clients reach the
-- features only through the SECURITY DEFINER functions below, which check MFA,
-- tenant scope, role and the organization switch on every call.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Switches (visible on the admin "Feature switches & limits" page)
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- Old app/api/wallet/google/route.ts (2026-07-18) and lib/wallet/flags.ts had
  -- no organization flag: the button appeared whenever the operator's Google
  -- Wallet secrets were present. No old flag, so the default is on; the
  -- operator credentials still gate it.
  ('features.integrations.google_wallet_pass', 'boolean', 'Save to Google Wallet on the membership card',
   'Members can save their membership card to Google Wallet. It works only after the operator sets the Google Wallet credentials; until then members see nothing.',
   'true'::jsonb, null, null, null, 1900, 'integrations', false),
  -- Old google_calendar_sync_enabled: seeded false by 0024/0037, then set true
  -- by 0141_enable_all_feature_flags.sql (lines 7-8), so production ran with it on.
  ('features.integrations.org_calendar_push', 'boolean', 'Copy chapter events to the organization calendar',
   'Copies chapter events to the Google calendar an administrator connected and keeps the copies up to date. Nothing happens until a Google account is connected.',
   'true'::jsonb, null, null, null, 1901, 'integrations', false),
  -- New safety limit with no old equivalent: the old app pushed one event at a
  -- time when staff clicked. Automatic copies start with public events only.
  ('limits.integrations.org_calendar_push_scope', 'text', 'Which events go to the organization calendar',
   'public_events copies only events marked public. all_events also copies chapter-only events to everyone who can see that Google calendar.',
   '"public_events"'::jsonb, null, null, array['public_events', 'all_events']::text[], 1902, 'integrations', false),
  -- Old lib/google/drive.ts createGrievanceFolder (lines 96-104) and
  -- getOrCreateMeetingFolder (lines 118-125) filed per case and per meeting
  -- whenever Google was configured, with no flag. Default on.
  ('features.integrations.drive_case_meeting_folders', 'boolean', 'File Drive uploads into case and meeting folders',
   'When Google Drive is connected, staff can file uploads into a folder per case or per meeting. Restricted cases never get a Drive folder.',
   'true'::jsonb, null, null, null, 1903, 'integrations', false),
  -- Old supabase/migrations/0570_steward_coop_member_assignment_tasks.sql
  -- (lines 420-430) seeded steward_coop_tasks_enabled = false and no later
  -- migration turned it on. Default off.
  ('features.tasks.coop_checkoff_lists', 'boolean', 'Member check-off lists on tasks',
   'Staff can attach a member check-off list to a task and split the roster across stewards by hand, evenly, at random, or as one shared list.',
   'false'::jsonb, null, null, null, 1904, 'general', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Google Wallet pass (REQ-UG-GOOGLE-WALLET-PASS-20261001)
-- ---------------------------------------------------------------------------

-- The signed pass carries organization, chapter and member names read here for
-- the caller's own selected, active membership. The API signs; it never takes
-- pass text from the browser.
create function public.get_my_membership_wallet_pass()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid;
  chapter text;
  org_name text;
  chapter_name text;
  member_name text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  org := private.current_member_organization();
  chapter := private.current_member_chapter();
  select o.name, c.name, p.full_name
    into org_name, chapter_name, member_name
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id and c.organization_id = org
  join public.organizations o on o.id = c.organization_id and o.status = 'active'
  join public.member_chapter_memberships cm
    on cm.user_id = p.id and cm.chapter_id = c.id and cm.status = 'active'
  join public.organization_memberships om
    on om.user_id = p.id and om.organization_id = o.id and om.status = 'active'
  where p.id = caller and p.chapter_id = chapter;
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'enabled', private.organization_feature_enabled(org, 'features.integrations.google_wallet_pass'),
    'organizationId', org,
    'chapterId', chapter,
    'organizationName', org_name,
    'chapterName', chapter_name,
    'memberName', member_name
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Organization calendar push (REQ-UG-ORG-CALENDAR-PUSH-SYNC-20261001)
-- ---------------------------------------------------------------------------

-- Ten-minute PKCE state for the organization administrator's Connect click.
-- requested_by is deliberately not an auth.users reference: the row lives for
-- minutes and the completing function re-checks that the person is still an
-- active administrator or VP of the organization.
create table private.organization_calendar_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  requested_by uuid not null,
  code_verifier text not null check (pg_catalog.char_length(code_verifier) between 43 and 128),
  redirect_uri text not null check (pg_catalog.char_length(redirect_uri) between 12 and 500),
  expires_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.now()
);

create index organization_calendar_oauth_states_expiry_idx
  on private.organization_calendar_oauth_states (expires_at);

-- One organization-owned Google connection. The refresh token lives in Vault;
-- this row holds only the reference.
create table private.organization_calendar_push_connections (
  organization_id uuid primary key references public.organizations(id) on update cascade on delete cascade,
  status text not null default 'connected'
    constraint organization_calendar_push_connections_status_check
    check (status in ('connected', 'error', 'revoked')),
  credential_ref uuid,
  account_email text check (account_email is null or pg_catalog.char_length(account_email) <= 320),
  calendar_id text not null default 'primary'
    constraint organization_calendar_push_connections_calendar_check
    check (calendar_id ~ '^[A-Za-z0-9._@#+-]{1,255}$'),
  scopes text not null default '' check (pg_catalog.char_length(scopes) <= 2000),
  connected_at timestamptz,
  last_run_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,60}$'),
  pushed_total integer not null default 0 check (pushed_total >= 0),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_calendar_push_connections_credential_check
    check (status = 'revoked' or credential_ref is not null)
);

-- Which Google event mirrors which chapter event. event_id is deliberately not
-- a foreign key: when an event is deleted this row is how the scheduled job
-- knows which Google copy to remove.
create table private.organization_calendar_event_pushes (
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  event_id text not null check (pg_catalog.char_length(event_id) between 1 and 200),
  google_event_id text check (google_event_id is null
    or (google_event_id ~ '^[A-Za-z0-9_-]+$' and pg_catalog.char_length(google_event_id) <= 1024)),
  calendar_id text check (calendar_id is null or calendar_id ~ '^[A-Za-z0-9._@#+-]{1,255}$'),
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{32}$'),
  pushed_at timestamptz,
  failure_count integer not null default 0 check (failure_count between 0 and 1000000),
  last_failed_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,60}$'),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, event_id),
  constraint organization_calendar_event_pushes_copy_check
    check ((google_event_id is null) = (calendar_id is null))
);

alter table private.organization_calendar_oauth_states enable row level security;
alter table private.organization_calendar_oauth_states force row level security;
alter table private.organization_calendar_push_connections enable row level security;
alter table private.organization_calendar_push_connections force row level security;
alter table private.organization_calendar_event_pushes enable row level security;
alter table private.organization_calendar_event_pushes force row level security;
revoke all on table private.organization_calendar_oauth_states from public, anon, authenticated, service_role;
revoke all on table private.organization_calendar_push_connections from public, anon, authenticated, service_role;
revoke all on table private.organization_calendar_event_pushes from public, anon, authenticated, service_role;

-- The organization foreign keys put these tables in the account case graph:
-- they take the same statement gate and (empty) row-key gate as every other
-- graph relation, and their writers lock the graph first.
create trigger a00_case_graph_lock before insert or update or delete on private.organization_calendar_oauth_states
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_calendar_oauth_states
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger a00_case_graph_lock before insert or update or delete on private.organization_calendar_push_connections
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_calendar_push_connections
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger a00_case_graph_lock before insert or update or delete on private.organization_calendar_event_pushes
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_calendar_event_pushes
for each row execute function private.lock_case_graph_row_keys('', '');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private'
  and table_name in ('organization_calendar_oauth_states', 'organization_calendar_push_connections', 'organization_calendar_event_pushes')
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

comment on table private.organization_calendar_oauth_states is
  'Short-lived PKCE state for an organization administrator connecting the organization calendar (REQ-UG-ORG-CALENDAR-PUSH-SYNC-20261001). No client grant.';
comment on table private.organization_calendar_push_connections is
  'The organization-owned Google calendar connection used to copy chapter events. Refresh token in Vault; no client grant.';
comment on table private.organization_calendar_event_pushes is
  'Google event id and content hash of each chapter event copied to the organization calendar. No client grant.';

create function private.organization_calendar_push_status_payload(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'enabled', private.organization_feature_enabled(p_organization_id, 'features.integrations.org_calendar_push'),
    'scope', private.organization_setting_text(p_organization_id, 'limits.integrations.org_calendar_push_scope'),
    'connection', (
      select pg_catalog.jsonb_build_object(
        'status', c.status,
        'accountEmail', c.account_email,
        'calendarId', c.calendar_id,
        'connectedAt', c.connected_at,
        'lastRunAt', c.last_run_at,
        'lastErrorCode', c.last_error_code,
        'pushedTotal', c.pushed_total
      )
      from private.organization_calendar_push_connections c
      where c.organization_id = p_organization_id and c.status <> 'revoked'
    ),
    'copiedEvents', (
      select pg_catalog.count(*) from private.organization_calendar_event_pushes p
      where p.organization_id = p_organization_id and p.google_event_id is not null
    ),
    'failingEvents', (
      select pg_catalog.count(*) from private.organization_calendar_event_pushes p
      where p.organization_id = p_organization_id and p.failure_count > 0
    )
  );
$function$;

create function public.get_organization_calendar_push_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return private.organization_calendar_push_status_payload(org);
end;
$function$;

create function public.begin_organization_calendar_oauth(
  p_state_hash text,
  p_code_verifier text,
  p_redirect_uri text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  actor uuid;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_integration_admin();
  actor := (select auth.uid());
  if not private.mfa_satisfied()
     or coalesce(p_state_hash, '') !~ '^[0-9a-f]{64}$'
     or pg_catalog.char_length(coalesce(p_code_verifier, '')) not between 43 and 128
     or coalesce(p_redirect_uri, '') !~ '^https://[^[:space:][:cntrl:]]+$'
     or pg_catalog.char_length(p_redirect_uri) > 500
     or p_expires_at is null
     or p_expires_at <= pg_catalog.now()
     or p_expires_at > pg_catalog.now() + interval '15 minutes' then
    raise exception 'invalid oauth request' using errcode = '22023';
  end if;
  delete from private.organization_calendar_oauth_states where expires_at <= pg_catalog.now();
  insert into private.organization_calendar_oauth_states (
    state_hash, organization_id, requested_by, code_verifier, redirect_uri, expires_at
  ) values (p_state_hash, org, actor, p_code_verifier, p_redirect_uri, p_expires_at);
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'google_calendar_push', 'status', 'oauth_started'
  ));
  return pg_catalog.jsonb_build_object('organizationId', org, 'status', 'requested');
end;
$function$;

create function public.claim_organization_calendar_oauth_state(p_state text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  state private.organization_calendar_oauth_states%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if (select auth.role()) is distinct from 'service_role' or p_state is null
     or pg_catalog.char_length(p_state) > 200 then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from private.organization_calendar_oauth_states source
  where source.state_hash = pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_state, 'UTF8'), 'sha256'), 'hex'
  ) and source.expires_at > pg_catalog.now()
  returning * into state;
  if not found then
    raise exception 'invalid oauth state' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', state.organization_id,
    'userId', state.requested_by,
    'codeVerifier', state.code_verifier,
    'redirectUri', state.redirect_uri
  );
end;
$function$;

create function public.complete_organization_calendar_oauth(
  p_organization_id uuid,
  p_user_id uuid,
  p_refresh_token text,
  p_scopes text,
  p_account_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  secret_id uuid;
  old_ref uuid;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if (select auth.role()) is distinct from 'service_role'
     or p_organization_id is null or p_user_id is null
     or pg_catalog.char_length(coalesce(p_refresh_token, '')) not between 20 and 4096
     or pg_catalog.char_length(coalesce(p_scopes, '')) > 2000
     or pg_catalog.strpos(coalesce(p_scopes, ''), 'https://www.googleapis.com/auth/calendar.events') = 0
     or pg_catalog.char_length(coalesce(p_account_email, '')) > 320 then
    raise exception 'invalid oauth completion' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    join public.organizations organization
      on organization.id = membership.organization_id and organization.status = 'active'
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = p_user_id and membership.status = 'active'
      and role.role in ('admin', 'vp')
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select c.credential_ref into old_ref
  from private.organization_calendar_push_connections c
  where c.organization_id = p_organization_id
  for update;
  secret_id := vault.create_secret(
    p_refresh_token,
    'organization-calendar-' || p_organization_id::text || '-' || extensions.gen_random_uuid()::text,
    'Organization-owned Google Calendar OAuth refresh token (event copies)'
  );
  insert into private.organization_calendar_push_connections (
    organization_id, status, credential_ref, account_email, scopes, connected_at, last_error_code, updated_at
  ) values (
    p_organization_id, 'connected', secret_id,
    nullif(pg_catalog.btrim(coalesce(p_account_email, '')), ''), p_scopes, pg_catalog.now(), null, pg_catalog.now()
  )
  on conflict (organization_id) do update
    set status = 'connected',
        credential_ref = excluded.credential_ref,
        account_email = excluded.account_email,
        scopes = excluded.scopes,
        connected_at = excluded.connected_at,
        last_error_code = null,
        updated_at = pg_catalog.now();
  if old_ref is not null and old_ref is distinct from secret_id then
    delete from vault.secrets where id = old_ref;
  end if;
  perform private.mi1_write_tenant_audit(p_organization_id, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id, 'provider', 'google_calendar_push', 'status', 'connected',
    'userId', p_user_id
  ));
  return pg_catalog.jsonb_build_object('status', 'connected', 'provider', 'google_calendar_push');
end;
$function$;

create function public.set_organization_calendar_push_calendar(p_calendar_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  next_calendar text;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_integration_admin();
  next_calendar := pg_catalog.btrim(coalesce(p_calendar_id, ''));
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if next_calendar !~ '^[A-Za-z0-9._@#+-]{1,255}$' then
    raise exception 'invalid calendar id' using errcode = '22023';
  end if;
  update private.organization_calendar_push_connections
  set calendar_id = next_calendar, updated_at = pg_catalog.now()
  where organization_id = org and status <> 'revoked';
  if not found then
    raise exception 'organization calendar is not connected' using errcode = '55000';
  end if;
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'google_calendar_push', 'status', 'calendar_changed'
  ));
  return private.organization_calendar_push_status_payload(org);
end;
$function$;

-- Disconnect forgets the Union Ground side: the Vault secret and the copy
-- index. Copies already in Google stay there (no token remains to remove
-- them); the operator guide says so.
create function public.disconnect_organization_calendar_push()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  secret_ref uuid;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_integration_admin();
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select c.credential_ref into secret_ref
  from private.organization_calendar_push_connections c
  where c.organization_id = org
  for update;
  update private.organization_calendar_push_connections
  set status = 'revoked', credential_ref = null, account_email = null, scopes = '',
      last_error_code = null, updated_at = pg_catalog.now()
  where organization_id = org;
  delete from private.organization_calendar_event_pushes where organization_id = org;
  if secret_ref is not null then
    delete from vault.secrets where id = secret_ref;
  end if;
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'google_calendar_push', 'status', 'revoked'
  ));
  return private.organization_calendar_push_status_payload(org);
end;
$function$;

create function public.read_organization_calendar_refresh_token(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  connection private.organization_calendar_push_connections%rowtype;
  token text;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into connection
  from private.organization_calendar_push_connections c
  where c.organization_id = p_organization_id
    and c.status in ('connected', 'error') and c.credential_ref is not null;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select secret.decrypted_secret into token
  from vault.decrypted_secrets secret
  where secret.id = connection.credential_ref;
  if token is null then
    raise exception 'credential unavailable' using errcode = '55000';
  end if;
  return pg_catalog.jsonb_build_object('refreshToken', token, 'calendarId', connection.calendar_id);
end;
$function$;

-- The scheduled job's work list. Per organization (switch on, connection
-- usable): remove copies whose event is gone, cancelled, out of scope or on a
-- different calendar; then create or update copies for in-scope events from a
-- day ago to 400 days ahead. A failing event backs off 15 minutes per failure.
create function public.list_organization_calendar_push_work(
  p_organization_limit integer,
  p_operation_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org_limit integer := least(greatest(coalesce(p_organization_limit, 10), 1), 50);
  op_limit integer := least(greatest(coalesce(p_operation_limit, 25), 1), 100);
  result jsonb := '[]'::jsonb;
  connection record;
  push_scope text;
  operations jsonb;
  found_orgs integer := 0;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  for connection in
    select c.organization_id, c.calendar_id
    from private.organization_calendar_push_connections c
    join public.organizations o on o.id = c.organization_id and o.status = 'active'
    where c.credential_ref is not null
      and (c.status = 'connected' or (c.status = 'error' and c.last_error_code is distinct from 'grant_revoked'))
    order by c.last_run_at nulls first, c.organization_id
    limit 500
  loop
    exit when found_orgs >= org_limit;
    continue when not private.organization_feature_enabled(connection.organization_id, 'features.integrations.org_calendar_push');
    push_scope := private.organization_setting_text(connection.organization_id, 'limits.integrations.org_calendar_push_scope');
    with source as (
      select e.id, e.title, e.starts_at, e.location, e.summary,
        pg_catalog.md5(pg_catalog.concat_ws(pg_catalog.chr(31), e.title, e.starts_at::text, e.location, e.summary)) as content_hash
      from public.member_events e
      join public.chapters ch on ch.id = e.chapter_id and ch.organization_id = connection.organization_id
      where e.cancelled_at is null
        and e.starts_at >= pg_catalog.now() - interval '1 day'
        and e.starts_at < pg_catalog.now() + interval '400 days'
        and (push_scope = 'all_events' or e.is_public)
    ),
    pushes as (
      select p.*
      from private.organization_calendar_event_pushes p
      where p.organization_id = connection.organization_id
    ),
    work as (
      select 0 as rank_order, null::timestamptz as starts_at,
        pg_catalog.jsonb_build_object(
          'op', 'delete', 'eventId', p.event_id, 'googleEventId', p.google_event_id,
          'calendarId', p.calendar_id
        ) as item
      from pushes p
      left join source s on s.id = p.event_id
      where p.google_event_id is not null
        and (s.id is null or p.calendar_id is distinct from connection.calendar_id)
        and (p.last_failed_at is null
          or p.last_failed_at < pg_catalog.now() - pg_catalog.make_interval(mins => 15 * least(p.failure_count, 96)))
      union all
      select 1, s.starts_at,
        pg_catalog.jsonb_build_object(
          'op', 'upsert', 'eventId', s.id, 'googleEventId', p.google_event_id,
          'calendarId', connection.calendar_id, 'contentHash', s.content_hash,
          'event', pg_catalog.jsonb_build_object(
            'title', s.title, 'startsAt', s.starts_at, 'location', s.location, 'summary', s.summary
          )
        )
      from source s
      left join pushes p on p.event_id = s.id
      where (p.event_id is null
          or p.google_event_id is null
          or (p.calendar_id = connection.calendar_id and p.content_hash is distinct from s.content_hash))
        and (p.last_failed_at is null
          or p.last_failed_at < pg_catalog.now() - pg_catalog.make_interval(mins => 15 * least(p.failure_count, 96)))
    )
    select coalesce(pg_catalog.jsonb_agg(limited.item order by limited.rank_order, limited.starts_at, limited.item ->> 'eventId'), '[]'::jsonb)
      into operations
    from (
      select w.item, w.rank_order, w.starts_at
      from work w
      order by w.rank_order, w.starts_at nulls first, w.item ->> 'eventId'
      limit op_limit
    ) limited;
    continue when pg_catalog.jsonb_array_length(operations) = 0;
    found_orgs := found_orgs + 1;
    result := result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'organizationId', connection.organization_id,
      'calendarId', connection.calendar_id,
      'operations', operations
    ));
  end loop;
  return result;
end;
$function$;

create function public.record_organization_calendar_push_result(
  p_organization_id uuid,
  p_event_id text,
  p_outcome text,
  p_google_event_id text,
  p_calendar_id text,
  p_content_hash text,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_organization_id is null or coalesce(p_event_id, '') = '' or pg_catalog.char_length(p_event_id) > 200
     or p_outcome not in ('upserted', 'deleted', 'failed') then
    raise exception 'invalid push result' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.organization_calendar_push_connections c
    where c.organization_id = p_organization_id and c.status <> 'revoked'
  ) then
    -- Disconnected while the job ran: keep nothing.
    return;
  end if;
  if p_outcome = 'upserted' then
    if coalesce(p_google_event_id, '') !~ '^[A-Za-z0-9_-]+$' or pg_catalog.char_length(p_google_event_id) > 1024
       or coalesce(p_calendar_id, '') !~ '^[A-Za-z0-9._@#+-]{1,255}$'
       or coalesce(p_content_hash, '') !~ '^[0-9a-f]{32}$' then
      raise exception 'invalid push result' using errcode = '22023';
    end if;
    insert into private.organization_calendar_event_pushes (
      organization_id, event_id, google_event_id, calendar_id, content_hash, pushed_at,
      failure_count, last_failed_at, last_error_code, updated_at
    ) values (
      p_organization_id, p_event_id, p_google_event_id, p_calendar_id, p_content_hash, pg_catalog.now(),
      0, null, null, pg_catalog.now()
    )
    on conflict (organization_id, event_id) do update
      set google_event_id = excluded.google_event_id,
          calendar_id = excluded.calendar_id,
          content_hash = excluded.content_hash,
          pushed_at = excluded.pushed_at,
          failure_count = 0, last_failed_at = null, last_error_code = null,
          updated_at = pg_catalog.now();
    update private.organization_calendar_push_connections
    set pushed_total = least(pushed_total + 1, 2000000000), updated_at = pg_catalog.now()
    where organization_id = p_organization_id;
  elsif p_outcome = 'deleted' then
    delete from private.organization_calendar_event_pushes
    where organization_id = p_organization_id and event_id = p_event_id;
  else
    if coalesce(p_error_code, '') !~ '^[a-z0-9_]{1,60}$' then
      raise exception 'invalid push result' using errcode = '22023';
    end if;
    insert into private.organization_calendar_event_pushes (
      organization_id, event_id, failure_count, last_failed_at, last_error_code, updated_at
    ) values (p_organization_id, p_event_id, 1, pg_catalog.now(), p_error_code, pg_catalog.now())
    on conflict (organization_id, event_id) do update
      set failure_count = least(private.organization_calendar_event_pushes.failure_count + 1, 1000000),
          last_failed_at = pg_catalog.now(),
          last_error_code = excluded.last_error_code,
          updated_at = pg_catalog.now();
  end if;
end;
$function$;

create function public.record_organization_calendar_push_run(
  p_organization_id uuid,
  p_status text,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_organization_id is null or p_status not in ('ok', 'error')
     or (p_status = 'error' and coalesce(p_error_code, '') !~ '^[a-z0-9_]{1,60}$') then
    raise exception 'invalid push run' using errcode = '22023';
  end if;
  update private.organization_calendar_push_connections
  set status = case when p_status = 'ok' then 'connected' else 'error' end,
      last_error_code = case when p_status = 'ok' then null else p_error_code end,
      last_run_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where organization_id = p_organization_id and status <> 'revoked';
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Drive case and meeting folders (REQ-UG-DRIVE-PER-CASE-FOLDERS-20261001)
-- ---------------------------------------------------------------------------

-- Folder names carry the case reference plus a short id suffix (never member
-- names; the old app's "<case number> — <grievant name>" put a member name in
-- the organization's Drive) and the meeting date and title.
create function private.drive_case_folder_name(p_reference text, p_case_id uuid)
returns text
language sql
stable
set search_path = ''
as $function$
  select 'Case ' || pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_reference, ''), '[[:cntrl:]/\\]+', ' ', 'g')), 80)
    || ' · ' || pg_catalog.left(p_case_id::text, 8);
$function$;

create function private.drive_meeting_folder_name(p_title text, p_starts_at timestamptz, p_event_id text)
returns text
language sql
stable
set search_path = ''
as $function$
  select 'Meeting ' || pg_catalog.to_char(p_starts_at at time zone 'UTC', 'YYYY-MM-DD')
    || ' · ' || pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_title, ''), '[[:cntrl:]/\\]+', ' ', 'g')), 80)
    || ' · ' || pg_catalog.left(pg_catalog.md5(coalesce(p_event_id, '')), 6);
$function$;

create function public.list_google_drive_filing_targets()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();
declare
  caller uuid := (select auth.uid());
  org uuid := private.mi1_w2_selected_organization();
begin
  if caller is null or not private.mfa_satisfied()
     or not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_integrations i
    where i.organization_id = org and i.provider = 'google_drive'
      and i.status = 'connected' and i.credential_ref is not null
  ) then
    return pg_catalog.jsonb_build_object('enabled', false, 'connected', false, 'cases', '[]'::jsonb, 'meetings', '[]'::jsonb);
  end if;
  if not private.organization_feature_enabled(org, 'features.integrations.drive_case_meeting_folders') then
    return pg_catalog.jsonb_build_object('enabled', false, 'connected', true, 'cases', '[]'::jsonb, 'meetings', '[]'::jsonb);
  end if;
  return pg_catalog.jsonb_build_object(
    'enabled', true,
    'connected', true,
    'cases', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'reference', c.reference,
        'folderName', private.drive_case_folder_name(c.reference, c.id)
      ) order by c.updated_at desc, c.id)
      from (
        select mc.id, mc.reference, mc.updated_at
        from public.member_cases mc
        where mc.organization_id = org
          and mc.status = 'active'
          and not mc.is_restricted
          and private.casework_staff_can_access(mc.id)
        order by mc.updated_at desc, mc.id
        limit 50
      ) c
    ), '[]'::jsonb),
    'meetings', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id, 'title', e.title, 'startsAt', e.starts_at,
        'folderName', private.drive_meeting_folder_name(e.title, e.starts_at, e.id)
      ) order by e.starts_at desc, e.id)
      from (
        select ev.id, ev.title, ev.starts_at
        from public.member_events ev
        join public.chapters ch on ch.id = ev.chapter_id and ch.organization_id = org
        where ev.cancelled_at is null
          and ev.starts_at >= pg_catalog.now() - interval '90 days'
          and ev.starts_at < pg_catalog.now() + interval '180 days'
          and private.actor_has_chapter_staff_role(caller, ev.chapter_id)
        order by ev.starts_at desc, ev.id
        limit 50
      ) e
    ), '[]'::jsonb)
  );
end;

end;
$function$;

-- Same gate, rate limit and audit as authorize_google_drive_operation (it is
-- called first, inside this transaction), plus the target's own rule: a case
-- the caller can work under casework access and that is not restricted, or a
-- meeting in a chapter where the caller holds a staff role.
create function public.authorize_google_drive_filing(
  p_action text,
  p_target_kind text,
  p_target_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  base jsonb;
  org uuid;
  folder text;
  restricted boolean;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
caller := (select auth.uid());
  if not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_target_kind is null or p_target_kind not in ('case', 'meeting')
     or coalesce(p_target_id, '') = '' or pg_catalog.char_length(p_target_id) > 200 then
    raise exception 'invalid drive filing target' using errcode = '22023';
  end if;
  base := public.authorize_google_drive_operation(p_action);
  if coalesce((base ->> 'rateLimited')::boolean, false) then
    return base;
  end if;
  org := (base ->> 'organizationId')::uuid;
  if not private.organization_feature_enabled(org, 'features.integrations.drive_case_meeting_folders') then
    raise exception 'drive case and meeting folders are turned off' using errcode = '55000';
  end if;
  if p_target_kind = 'case' then
    if p_target_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid drive filing target' using errcode = '22023';
    end if;
    select private.drive_case_folder_name(c.reference, c.id), c.is_restricted
      into folder, restricted
    from public.member_cases c
    where c.id = p_target_id::uuid
      and c.organization_id = org
      and private.casework_staff_can_access(c.id);
    if not found then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    if restricted then
      raise exception 'restricted case files stay in Union Ground' using errcode = '42501';
    end if;
    return base || pg_catalog.jsonb_build_object(
      'targetKind', 'case', 'targetId', p_target_id, 'groupFolderName', 'Cases', 'folderName', folder
    );
  end if;
  select private.drive_meeting_folder_name(e.title, e.starts_at, e.id)
    into folder
  from public.member_events e
  join public.chapters ch on ch.id = e.chapter_id and ch.organization_id = org
  where e.id = p_target_id
    and private.actor_has_chapter_staff_role(caller, e.chapter_id);
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return base || pg_catalog.jsonb_build_object(
    'targetKind', 'meeting', 'targetId', p_target_id, 'groupFolderName', 'Meetings', 'folderName', folder
  );
end;
$function$;

-- A durable ID reservation survives concurrent workers and process restarts.
-- Only the credential-owning API can access it, after user target authorization.
create table private.google_drive_filing_folders (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  root_folder_id text not null,
  parent_folder_id text not null,
  target_key text not null,
  folder_name text not null,
  folder_id text not null,
  primary key (organization_id, root_folder_id, target_key),
  constraint google_drive_filing_folder_ids_check check (
    root_folder_id ~ '^[A-Za-z0-9_-]+$' and char_length(root_folder_id) <= 256
    and parent_folder_id ~ '^[A-Za-z0-9_-]+$' and char_length(parent_folder_id) <= 256
    and folder_id ~ '^[A-Za-z0-9_-]+$' and char_length(folder_id) <= 256),
  constraint google_drive_filing_folder_name_check check (char_length(folder_name) between 1 and 200),
  constraint google_drive_filing_folder_target_check check (char_length(target_key) between 1 and 208)
);
alter table private.google_drive_filing_folders enable row level security;
alter table private.google_drive_filing_folders force row level security;
revoke all on table private.google_drive_filing_folders from public, anon, authenticated, service_role;
create trigger a00_case_graph_lock before insert or update or delete on private.google_drive_filing_folders
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.google_drive_filing_folders
for each row execute function private.lock_case_graph_row_keys('', '');
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private' and table_name = 'google_drive_filing_folders';

create function public.reserve_google_drive_filing_folder(
  p_organization_id uuid, p_root_folder_id text, p_parent_folder_id text,
  p_target_key text, p_folder_name text, p_proposed_folder_id text default null
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  reserved_id text;
  expected_parent text;
  target_id text;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_root_folder_id is null or p_parent_folder_id is null or p_target_key is null or p_folder_name is null
     or p_root_folder_id !~ '^[A-Za-z0-9_-]+$' or char_length(p_root_folder_id) > 256
     or p_parent_folder_id !~ '^[A-Za-z0-9_-]+$' or char_length(p_parent_folder_id) > 256
     or char_length(p_folder_name) not between 1 and 200
     or (p_proposed_folder_id is not null and (p_proposed_folder_id !~ '^[A-Za-z0-9_-]+$' or char_length(p_proposed_folder_id) > 256)) then
    raise exception 'invalid folder reservation' using errcode = '22023';
  end if;
  if not private.organization_feature_enabled(p_organization_id, 'features.integrations.drive_case_meeting_folders')
     or not exists (select 1 from public.organization_integrations i where i.organization_id = p_organization_id
       and i.provider = 'google_drive' and i.status = 'connected' and i.credential_ref is not null
       and i.default_settings ->> 'rootFolderId' = p_root_folder_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_target_key in ('group:Cases', 'group:Meetings') then
    expected_parent := p_root_folder_id;
  else
    target_id := substring(p_target_key from position(':' in p_target_key) + 1);
    if p_target_key like 'case:%' and target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and exists (select 1 from public.member_cases c where c.id = target_id::uuid
         and c.organization_id = p_organization_id and not c.is_restricted) then
      select f.folder_id into expected_parent from private.google_drive_filing_folders f
      where f.organization_id = p_organization_id and f.root_folder_id = p_root_folder_id and f.target_key = 'group:Cases';
    elsif p_target_key like 'meeting:%' and char_length(target_id) between 1 and 200
       and exists (select 1 from public.member_events e join public.chapters ch on ch.id = e.chapter_id
         where e.id = target_id and ch.organization_id = p_organization_id) then
      select f.folder_id into expected_parent from private.google_drive_filing_folders f
      where f.organization_id = p_organization_id and f.root_folder_id = p_root_folder_id and f.target_key = 'group:Meetings';
    else
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;
  if expected_parent is null or expected_parent is distinct from p_parent_folder_id then
    raise exception 'folder parent mismatch' using errcode = '42501';
  end if;
  select f.folder_id into reserved_id from private.google_drive_filing_folders f
  where f.organization_id = p_organization_id and f.root_folder_id = p_root_folder_id and f.target_key = p_target_key;
  if reserved_id is null and p_proposed_folder_id is not null then
    insert into private.google_drive_filing_folders as f
      (organization_id, root_folder_id, parent_folder_id, target_key, folder_name, folder_id)
    values (p_organization_id, p_root_folder_id, p_parent_folder_id, p_target_key, p_folder_name, p_proposed_folder_id)
    on conflict (organization_id, root_folder_id, target_key) do update set folder_id = f.folder_id
    returning folder_id into reserved_id;
  end if;
  return pg_catalog.jsonb_build_object('folderId', reserved_id);
end;
$function$;
revoke all on function public.reserve_google_drive_filing_folder(uuid, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.reserve_google_drive_filing_folder(uuid, text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Member check-off lists on Standard Tasks (REQ-UG-COOP-CHECKOFF-LISTS-20261001)
-- ---------------------------------------------------------------------------

create table private.task_checkoff_lists (
  task_id uuid primary key references public.chapter_tasks(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  assignment_mode text not null
    constraint task_checkoff_lists_mode_check
    check (assignment_mode in ('manual', 'split_even', 'split_random', 'shared')),
  status text not null default 'open'
    constraint task_checkoff_lists_status_check check (status in ('open', 'closed')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create index task_checkoff_lists_created_by_idx on private.task_checkoff_lists (created_by);

create table private.task_checkoff_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  task_id uuid not null references private.task_checkoff_lists(task_id) on delete cascade,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  assigned_steward_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending'
    constraint task_checkoff_entries_status_check
    check (status in ('pending', 'done', 'unreachable', 'follow_up')),
  note text not null default '' check (pg_catalog.char_length(note) <= 500),
  actioned_by uuid references auth.users(id) on delete set null,
  actioned_at timestamptz,
  position integer not null check (position between 0 and 499),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint task_checkoff_entries_member_key unique (task_id, member_user_id),
  constraint task_checkoff_entries_actioned_check check (status = 'pending' or actioned_at is not null)
);

create index task_checkoff_entries_task_status_idx on private.task_checkoff_entries (task_id, status, position);
create index task_checkoff_entries_member_idx on private.task_checkoff_entries (member_user_id);
create index task_checkoff_entries_steward_idx on private.task_checkoff_entries (assigned_steward_id)
  where assigned_steward_id is not null;
create index task_checkoff_entries_actioned_by_idx on private.task_checkoff_entries (actioned_by)
  where actioned_by is not null;

alter table private.task_checkoff_lists enable row level security;
alter table private.task_checkoff_lists force row level security;
alter table private.task_checkoff_entries enable row level security;
alter table private.task_checkoff_entries force row level security;
revoke all on table private.task_checkoff_lists from public, anon, authenticated, service_role;
revoke all on table private.task_checkoff_entries from public, anon, authenticated, service_role;

comment on table private.task_checkoff_lists is
  'A member check-off list attached to one ordinary chapter task (REQ-UG-COOP-CHECKOFF-LISTS-20261001). Access is the task board''s chapter staff rule; reached only through the task check-off functions.';
comment on table private.task_checkoff_entries is
  'One roster member on a task check-off list: assigned steward (null when shared), outcome and an optional staff note. Reached only through the task check-off functions.';

-- Case-graph serialization with account deletion, as for every auth.users edge.
create trigger a00_case_graph_lock before insert or update or delete on private.task_checkoff_lists
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.task_checkoff_lists
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger a00_case_graph_lock before insert or update or delete on private.task_checkoff_entries
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.task_checkoff_entries
for each row execute function private.lock_case_graph_row_keys('{actioned_by},{assigned_steward_id},{member_user_id}', '');

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition, export_inventory_basis, exclusion_reason, note)
values
  ('private', 'task_checkoff_lists', 'created_by', 'pseudonymize', 'excluded_with_reason', 'auth_user_fk',
   'Staff attribution of a work list on a chapter task; records who set the list up, not content the account authored.',
   'Installed action is ON DELETE SET NULL; the list stays with its chapter task.'),
  ('private', 'task_checkoff_entries', 'member_user_id', 'cascade', 'excluded_with_reason', 'auth_user_fk',
   'A steward outreach row about the member (pending, done, unreachable or follow-up and an optional staff note); it is staff work, not content the member authored.',
   'Removed with the member account.'),
  ('private', 'task_checkoff_entries', 'assigned_steward_id', 'pseudonymize', 'excluded_with_reason', 'auth_user_fk',
   'Records which steward the row was assigned to; an assignment, not content the account authored.',
   'Installed action is ON DELETE SET NULL; the row returns to the shared pool.'),
  ('private', 'task_checkoff_entries', 'actioned_by', 'pseudonymize', 'excluded_with_reason', 'auth_user_fk',
   'Records which steward last set the outcome; staff attribution, not content the account authored.',
   'Installed action is ON DELETE SET NULL; the outcome survives.');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private'
  and table_name in ('task_checkoff_lists', 'task_checkoff_entries')
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

do $assert_task_checkoff_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after task check-off lists';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after task check-off lists';
  end if;
end;
$assert_task_checkoff_lifecycle$;

-- Task audit vocabulary gains the check-off actions (values only: statuses
-- and modes, never member names).
alter table public.chapter_task_activity drop constraint chapter_task_activity_action_check;
alter table public.chapter_task_activity add constraint chapter_task_activity_action_check
  check (action in (
    'created', 'status_changed', 'assignee_changed', 'type_changed',
    'blocked', 'unblocked', 'board_changed', 'deleted', 'restored',
    'attachment_added', 'attachment_removed', 'file_added', 'file_removed',
    'template_flow_changed', 'checkoff_list_created', 'checkoff_list_status_changed',
    'checkoff_entry_changed'
  ));

-- The caller works this task: MFA, the task is on the caller's selected
-- chapter board (cw_task_readable) and the caller holds a staff role there.
-- Returns no row otherwise.
create function private.task_checkoff_scope(p_task_id uuid)
returns table (organization_id uuid, chapter_id text)
language sql
stable
security definer
set search_path = ''
as $function$
  select ch.organization_id, t.chapter_id
  from public.chapter_tasks t
  join public.chapters ch on ch.id = t.chapter_id and ch.organization_id is not null
  where t.id = p_task_id
    and t.deleted_at is null
    and (select auth.uid()) is not null
    and private.mfa_satisfied()
    and private.cw_task_readable((select auth.uid()), t.id)
    and private.actor_has_chapter_staff_role((select auth.uid()), t.chapter_id);
$function$;

create function private.task_checkoff_payload(p_task_id uuid, p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case when l.task_id is null then pg_catalog.jsonb_build_object(
      'enabled', true, 'list', null
    ) else pg_catalog.jsonb_build_object(
      'enabled', true,
      'list', pg_catalog.jsonb_build_object(
        'taskId', l.task_id,
        'mode', l.assignment_mode,
        'status', l.status,
        'createdBy', l.created_by,
        'createdAt', l.created_at,
        'canManage', (coalesce(l.created_by = (select auth.uid()), false)
          or coalesce(private.has_organization_role(p_organization_id, array['admin', 'vp']), false)),
        'entries', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', e.id,
            'memberUserId', e.member_user_id,
            'memberName', coalesce(member.full_name, ''),
            'assignedStewardId', e.assigned_steward_id,
            'assignedStewardName', steward.full_name,
            'status', e.status,
            'note', e.note,
            'actionedBy', e.actioned_by,
            'actionedByName', actor.full_name,
            'actionedAt', e.actioned_at
          ) order by e.position, e.id)
          from private.task_checkoff_entries e
          left join public.member_profiles member on member.id = e.member_user_id
          left join public.member_profiles steward on steward.id = e.assigned_steward_id
          left join public.member_profiles actor on actor.id = e.actioned_by
          where e.task_id = l.task_id
        ), '[]'::jsonb)
      )
    ) end
  from (select p_task_id as task_id) requested
  left join private.task_checkoff_lists l on l.task_id = requested.task_id;
$function$;

create function public.get_task_checkoff_list(p_task_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  scope record;
begin
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into scope from private.task_checkoff_scope(p_task_id);
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(scope.organization_id, 'features.tasks.coop_checkoff_lists') then
    return pg_catalog.jsonb_build_object('enabled', false, 'list', null);
  end if;
  return private.task_checkoff_payload(p_task_id, scope.organization_id);
end;
$function$;

-- Roster for building a list: active members of the task's chapter, and which
-- of them hold a staff role there (the stewards a list can be split across).
create function public.list_task_checkoff_candidates(p_task_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  scope record;
begin
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into scope from private.task_checkoff_scope(p_task_id);
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(scope.organization_id, 'features.tasks.coop_checkoff_lists') then
    raise exception 'member check-off lists are turned off' using errcode = '55000';
  end if;
  return pg_catalog.jsonb_build_object('members', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', roster.user_id, 'name', roster.full_name, 'steward', roster.steward
    ) order by roster.full_name, roster.user_id)
    from (
      select cm.user_id, coalesce(p.full_name, '') as full_name,
        private.actor_has_chapter_staff_role(cm.user_id, scope.chapter_id) as steward
      from public.member_chapter_memberships cm
      join public.organization_memberships om
        on om.user_id = cm.user_id and om.organization_id = scope.organization_id and om.status = 'active'
      left join public.member_profiles p on p.id = cm.user_id
      where cm.chapter_id = scope.chapter_id and cm.status = 'active'
      order by coalesce(p.full_name, ''), cm.user_id
      limit 500
    ) roster
  ), '[]'::jsonb));
end;
$function$;

create function public.create_task_checkoff_list(
  p_task_id uuid,
  p_mode text,
  p_member_ids uuid[],
  p_steward_ids uuid[],
  p_manual jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  scope record;
  members uuid[];
  stewards uuid[];
  steward_count integer;
  bad_id uuid;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
caller := (select auth.uid());
  if not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into scope from private.task_checkoff_scope(p_task_id);
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(scope.organization_id, 'features.tasks.coop_checkoff_lists') then
    raise exception 'member check-off lists are turned off' using errcode = '55000';
  end if;
  if p_mode is null or p_mode not in ('manual', 'split_even', 'split_random', 'shared') then
    raise exception 'invalid check-off mode' using errcode = '22023';
  end if;
  -- First occurrence wins, order kept (the even split is order-preserving).
  select coalesce(pg_catalog.array_agg(item.id order by item.first_at), array[]::uuid[])
    into members
  from (
    select ids.id, pg_catalog.min(ids.ordinality) as first_at
    from pg_catalog.unnest(coalesce(p_member_ids, array[]::uuid[])) with ordinality as ids(id, ordinality)
    where ids.id is not null
    group by ids.id
  ) item;
  select coalesce(pg_catalog.array_agg(item.id order by item.first_at), array[]::uuid[])
    into stewards
  from (
    select ids.id, pg_catalog.min(ids.ordinality) as first_at
    from pg_catalog.unnest(coalesce(p_steward_ids, array[]::uuid[])) with ordinality as ids(id, ordinality)
    where ids.id is not null
    group by ids.id
  ) item;
  if pg_catalog.cardinality(members) not between 1 and 500 then
    raise exception 'pick between 1 and 500 members' using errcode = '22023';
  end if;
  if pg_catalog.cardinality(stewards) > 50 then
    raise exception 'pick at most 50 stewards' using errcode = '22023';
  end if;
  select ids.id into bad_id
  from pg_catalog.unnest(members) as ids(id)
  where not exists (
    select 1
    from public.member_chapter_memberships cm
    join public.organization_memberships om
      on om.user_id = cm.user_id and om.organization_id = scope.organization_id and om.status = 'active'
    where cm.user_id = ids.id and cm.chapter_id = scope.chapter_id and cm.status = 'active'
  )
  limit 1;
  if bad_id is not null then
    raise exception 'one or more members are not active in this chapter' using errcode = '22023';
  end if;
  if p_mode = 'manual' then
    if p_manual is null or pg_catalog.jsonb_typeof(p_manual) <> 'object' then
      raise exception 'every member needs a steward in manual mode' using errcode = '22023';
    end if;
    select pg_catalog.array_agg(distinct (p_manual ->> ids.id::text)::uuid)
      into stewards
    from pg_catalog.unnest(members) as ids(id)
    where coalesce(p_manual ->> ids.id::text, '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    if exists (
      select 1 from pg_catalog.unnest(members) as ids(id)
      where coalesce(p_manual ->> ids.id::text, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      raise exception 'every member needs a steward in manual mode' using errcode = '22023';
    end if;
    stewards := coalesce(stewards, array[]::uuid[]);
  elsif p_mode in ('split_even', 'split_random') then
    if pg_catalog.cardinality(stewards) = 0 then
      raise exception 'pick at least one steward to split the list across' using errcode = '22023';
    end if;
  else
    stewards := array[]::uuid[];
  end if;
  select ids.id into bad_id
  from pg_catalog.unnest(stewards) as ids(id)
  where not private.actor_has_chapter_staff_role(ids.id, scope.chapter_id)
  limit 1;
  if bad_id is not null then
    raise exception 'one or more stewards do not hold a staff role in this chapter' using errcode = '22023';
  end if;

  insert into private.task_checkoff_lists (task_id, organization_id, chapter_id, assignment_mode, created_by)
  values (p_task_id, scope.organization_id, scope.chapter_id, p_mode, caller)
  on conflict (task_id) do nothing;
  if not found then
    raise exception 'this task already has a check-off list' using errcode = '23505';
  end if;

  steward_count := pg_catalog.cardinality(stewards);
  insert into private.task_checkoff_entries (task_id, member_user_id, assigned_steward_id, position)
  select p_task_id, ordered.id,
    case
      when p_mode = 'shared' then null
      when p_mode = 'manual' then (p_manual ->> ordered.id::text)::uuid
      else stewards[((ordered.slot - 1) % steward_count) + 1]
    end,
    ordered.slot - 1
  from (
    select ids.id,
      pg_catalog.row_number() over (
        order by case when p_mode = 'split_random' then pg_catalog.random() else ids.ordinality::double precision end
      )::integer as slot
    from pg_catalog.unnest(members) with ordinality as ids(id, ordinality)
  ) ordered;

  insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value, to_value)
  values (p_task_id, scope.chapter_id, caller, 'checkoff_list_created', null, p_mode);

  return private.task_checkoff_payload(p_task_id, scope.organization_id);
end;
$function$;

-- Mirrors the old evaluateCheckoff()/task_member_assignment_guard (0570):
-- closed lists are read-only except for the list's managers (its creator, an
-- organization admin or VP); only managers reset a row to pending; a row
-- assigned to another steward is off-limits; done/unreachable are final for
-- non-managers; a follow-up belongs to the steward who set it. The expected
-- status refuses a stale double check-off.
create function public.set_task_checkoff_entry(
  p_entry_id uuid,
  p_status text,
  p_note text,
  p_expected_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  entry private.task_checkoff_entries%rowtype;
  list private.task_checkoff_lists%rowtype;
  scope record;
  is_manager boolean;
  next_note text;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
caller := (select auth.uid());
  -- Line breaks are kept; other control characters are dropped.
  next_note := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_note, ''), '[^[:print:][:space:]]', '', 'g'));
  if not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_entry_id is null or p_status is null or p_status not in ('pending', 'done', 'unreachable', 'follow_up') then
    raise exception 'invalid check-off status' using errcode = '22023';
  end if;
  if pg_catalog.char_length(next_note) > 500 then
    raise exception 'note must be 500 characters or fewer' using errcode = '22023';
  end if;
  select * into entry from private.task_checkoff_entries where id = p_entry_id for update;
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into scope from private.task_checkoff_scope(entry.task_id);
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(scope.organization_id, 'features.tasks.coop_checkoff_lists') then
    raise exception 'member check-off lists are turned off' using errcode = '55000';
  end if;
  select * into list from private.task_checkoff_lists where task_id = entry.task_id for update;
  if p_expected_status is distinct from entry.status then
    raise exception 'checkoff:stale' using errcode = '40001';
  end if;
  is_manager := coalesce(list.created_by = caller, false)
    or coalesce(private.has_organization_role(scope.organization_id, array['admin', 'vp']), false);
  if not is_manager then
    if list.status = 'closed' then
      raise exception 'checkoff:list_closed' using errcode = '42501';
    end if;
    if p_status = 'pending' and entry.status <> 'pending' then
      raise exception 'checkoff:reset_requires_manager' using errcode = '42501';
    end if;
    if entry.assigned_steward_id is not null and entry.assigned_steward_id <> caller then
      raise exception 'checkoff:assigned_to_other' using errcode = '42501';
    end if;
    if entry.status in ('done', 'unreachable') then
      raise exception 'checkoff:already_actioned' using errcode = '42501';
    end if;
    if entry.status = 'follow_up' and entry.actioned_by is distinct from caller then
      raise exception 'checkoff:follow_up_owned_by_other' using errcode = '42501';
    end if;
  end if;
  update private.task_checkoff_entries
  set status = p_status,
      note = next_note,
      actioned_by = case when p_status = 'pending' then null
        when p_status <> entry.status then caller else entry.actioned_by end,
      actioned_at = case when p_status = 'pending' then null
        when p_status <> entry.status then pg_catalog.now() else entry.actioned_at end,
      updated_at = pg_catalog.now()
  where id = entry.id;
  if p_status <> entry.status then
    insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value, to_value)
    values (entry.task_id, scope.chapter_id, caller, 'checkoff_entry_changed', entry.status, p_status);
  end if;
  return private.task_checkoff_payload(entry.task_id, scope.organization_id);
end;
$function$;

create function public.set_task_checkoff_list_status(p_task_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  scope record;
  list private.task_checkoff_lists%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
caller := (select auth.uid());
  if p_status is null or p_status not in ('open', 'closed') then
    raise exception 'invalid list status' using errcode = '22023';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into scope from private.task_checkoff_scope(p_task_id);
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(scope.organization_id, 'features.tasks.coop_checkoff_lists') then
    raise exception 'member check-off lists are turned off' using errcode = '55000';
  end if;
  select * into list from private.task_checkoff_lists where task_id = p_task_id for update;
  if not found then
    raise exception 'this task has no check-off list' using errcode = '22023';
  end if;
  if not (coalesce(list.created_by = caller, false)
      or coalesce(private.has_organization_role(scope.organization_id, array['admin', 'vp']), false)) then
    raise exception 'checkoff:manager_required' using errcode = '42501';
  end if;
  if list.status <> p_status then
    update private.task_checkoff_lists set status = p_status, updated_at = pg_catalog.now() where task_id = p_task_id;
    insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value, to_value)
    values (p_task_id, scope.chapter_id, caller, 'checkoff_list_status_changed', list.status, p_status);
  end if;
  return private.task_checkoff_payload(p_task_id, scope.organization_id);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------

revoke all on function private.organization_calendar_push_status_payload(uuid) from public, anon, authenticated, service_role;
revoke all on function private.drive_case_folder_name(text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.drive_meeting_folder_name(text, timestamptz, text) from public, anon, authenticated, service_role;
revoke all on function private.task_checkoff_scope(uuid) from public, anon, authenticated, service_role;
revoke all on function private.task_checkoff_payload(uuid, uuid) from public, anon, authenticated, service_role;

revoke all on function public.get_my_membership_wallet_pass() from public, anon, authenticated, service_role;
revoke all on function public.get_organization_calendar_push_status() from public, anon, authenticated, service_role;
revoke all on function public.begin_organization_calendar_oauth(text, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.claim_organization_calendar_oauth_state(text) from public, anon, authenticated, service_role;
revoke all on function public.complete_organization_calendar_oauth(uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.set_organization_calendar_push_calendar(text) from public, anon, authenticated, service_role;
revoke all on function public.disconnect_organization_calendar_push() from public, anon, authenticated, service_role;
revoke all on function public.read_organization_calendar_refresh_token(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_organization_calendar_push_work(integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.record_organization_calendar_push_result(uuid, text, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.record_organization_calendar_push_run(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.list_google_drive_filing_targets() from public, anon, authenticated, service_role;
revoke all on function public.authorize_google_drive_filing(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.get_task_checkoff_list(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_task_checkoff_candidates(uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_task_checkoff_list(uuid, text, uuid[], uuid[], jsonb) from public, anon, authenticated, service_role;
revoke all on function public.set_task_checkoff_entry(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.set_task_checkoff_list_status(uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.get_my_membership_wallet_pass() to authenticated;
grant execute on function public.get_organization_calendar_push_status() to authenticated;
grant execute on function public.begin_organization_calendar_oauth(text, text, text, timestamptz) to authenticated;
grant execute on function public.set_organization_calendar_push_calendar(text) to authenticated;
grant execute on function public.disconnect_organization_calendar_push() to authenticated;
grant execute on function public.claim_organization_calendar_oauth_state(text) to service_role;
grant execute on function public.complete_organization_calendar_oauth(uuid, uuid, text, text, text) to service_role;
grant execute on function public.read_organization_calendar_refresh_token(uuid) to service_role;
grant execute on function public.list_organization_calendar_push_work(integer, integer) to service_role;
grant execute on function public.record_organization_calendar_push_result(uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.record_organization_calendar_push_run(uuid, text, text) to service_role;
grant execute on function public.list_google_drive_filing_targets() to authenticated;
grant execute on function public.authorize_google_drive_filing(text, text, text) to authenticated;
grant execute on function public.get_task_checkoff_list(uuid) to authenticated;
grant execute on function public.list_task_checkoff_candidates(uuid) to authenticated;
grant execute on function public.create_task_checkoff_list(uuid, text, uuid[], uuid[], jsonb) to authenticated;
grant execute on function public.set_task_checkoff_entry(uuid, text, text, text) to authenticated;
grant execute on function public.set_task_checkoff_list_status(uuid, text) to authenticated;

comment on function public.get_my_membership_wallet_pass() is
  'REQ-UG-GOOGLE-WALLET-PASS-20261001: the caller''s own selected active membership names for a Google Wallet pass, plus whether the organization switch allows it. The API signs; pass text never comes from the browser.';
comment on function public.list_organization_calendar_push_work(integer, integer) is
  'REQ-UG-ORG-CALENDAR-PUSH-SYNC-20261001: service-only work list (deletes first, then creates/updates) for organizations whose switch is on and whose connection is usable.';
comment on function public.authorize_google_drive_filing(text, text, text) is
  'REQ-UG-DRIVE-PER-CASE-FOLDERS-20261001: the Drive operation gate plus the target rule (casework access and never a restricted case, or chapter staff for a meeting).';
comment on function public.set_task_checkoff_entry(uuid, text, text, text) is
  'REQ-UG-COOP-CHECKOFF-LISTS-20261001: guarded check-off (old 0570 task_member_assignment_guard rules) with an expected-status token against double check-off.';

notify pgrst, 'reload schema';

commit;
