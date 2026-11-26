-- Member engagement completion group (CR-001/002/006/007/008/010/014-
-- 017/019/095/097/098/099).
--
-- This extends the organization-scoped MI1 survey core. It does not replay
-- donor migrations, seed a tenant, create an auth user, or activate an email
-- provider. Client roles receive the minimum table grants; mutations use
-- bounded RPCs that derive organization and actor identity from auth.

set check_function_bodies = on;

-- -------------------------------------------------------------------------
-- Survey operating model
-- -------------------------------------------------------------------------

alter table public.organization_surveys
  add column cadence text not null default 'one_off'
    check (cadence in ('one_off', 'quarterly', 'contextual')),
  add column period_key text,
  add column opens_at timestamptz,
  add column closes_at timestamptz,
  add column owner_user_id uuid references auth.users(id) on delete set null,
  add column operations_state text not null default 'draft'
    check (operations_state in ('draft', 'ready', 'distributing', 'reviewing', 'complete')),
  add column review_due_at timestamptz,
  add constraint organization_surveys_period_key_bounded check (
    period_key is null or (
      pg_catalog.char_length(period_key) between 1 and 40
      and period_key ~ '^[a-zA-Z0-9._:-]+$'
    )
  ),
  add constraint organization_surveys_window_order check (
    opens_at is null or closes_at is null or opens_at < closes_at
  );

create unique index organization_surveys_quarterly_period_once_idx
  on public.organization_surveys (organization_id, period_key)
  where cadence = 'quarterly' and period_key is not null;

create table public.organization_survey_tasks (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  survey_id uuid not null references public.organization_surveys(id) on delete cascade,
  reason text not null check (reason in ('readiness', 'distribution', 'response_review', 'closeout')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'dismissed')),
  assigned_to uuid references auth.users(id) on delete set null,
  due_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (survey_id, reason)
);

create table public.organization_survey_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  survey_id uuid not null references public.organization_surveys(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  state text not null default 'queued' check (state in ('queued', 'leased', 'sent', 'failed', 'engaged', 'suppressed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  engaged_at timestamptz,
  escalation_state text not null default 'none' check (escalation_state in ('none', 'reminder_due', 'escalated', 'resolved')),
  last_error_code text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (survey_id, recipient_user_id),
  constraint organization_survey_deliveries_error_bounded check (
    last_error_code is null or (
      pg_catalog.char_length(last_error_code) between 1 and 80
      and last_error_code ~ '^[a-z0-9._:-]+$'
    )
  )
);

create index organization_survey_deliveries_coverage_idx
  on public.organization_survey_deliveries (organization_id, survey_id, state, updated_at);

create table public.organization_survey_reviews (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  survey_id uuid not null references public.organization_surveys(id) on delete cascade,
  session_id uuid not null references public.organization_survey_sessions(id) on delete cascade,
  state text not null default 'unreviewed' check (state in ('unreviewed', 'assigned', 'follow_up', 'resolved', 'dismissed')),
  assigned_to uuid references auth.users(id) on delete set null,
  disposition text,
  follow_up_due_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (session_id),
  constraint organization_survey_reviews_disposition_bounded check (
    disposition is null or pg_catalog.char_length(disposition) <= 1000
  )
);

-- -------------------------------------------------------------------------
-- Contextual pulse prompts
-- -------------------------------------------------------------------------

create table public.organization_pulse_prompts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  event_key text not null,
  question text not null,
  options jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  cooldown_hours integer not null default 168 check (cooldown_hours between 1 and 8760),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, chapter_id, event_key),
  constraint organization_pulse_prompts_event_key_bounded check (
    pg_catalog.char_length(event_key) between 1 and 80 and event_key ~ '^[a-z0-9._:-]+$'
  ),
  constraint organization_pulse_prompts_question_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(question)) between 1 and 400
  ),
  constraint organization_pulse_prompts_options_array check (
    pg_catalog.jsonb_typeof(options) = 'array'
    and pg_catalog.jsonb_array_length(options) between 2 and 10
  )
);

create table public.organization_pulse_events (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  prompt_id uuid not null references public.organization_pulse_prompts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  context_key text not null,
  state text not null default 'shown' check (state in ('shown', 'dismissed', 'responded')),
  response_value jsonb,
  shown_at timestamptz not null default pg_catalog.now(),
  responded_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now(),
  unique (prompt_id, user_id, context_key),
  constraint organization_pulse_events_context_key_bounded check (
    pg_catalog.char_length(context_key) between 1 and 120
    and context_key ~ '^[a-zA-Z0-9._:-]+$'
  )
);

-- -------------------------------------------------------------------------
-- Meeting live polls and roster
-- -------------------------------------------------------------------------

create table public.organization_live_polls (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  title text not null,
  description text not null default '',
  state text not null default 'draft' check (state in ('draft', 'scheduled', 'open', 'closed', 'cancelled')),
  eligibility text not null default 'organization' check (eligibility in ('organization', 'chapter', 'roster')),
  results_visibility text not null default 'after_close' check (results_visibility in ('live', 'after_close', 'staff_only')),
  scheduled_at timestamptz,
  opens_at timestamptz,
  closes_at timestamptz,
  closed_at timestamptz,
  quorum_target integer check (quorum_target is null or quorum_target > 0),
  vote_count integer not null default 0 check (vote_count >= 0),
  result_cache jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_live_polls_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 240
  ),
  constraint organization_live_polls_description_bounded check (
    pg_catalog.char_length(description) <= 4000
  ),
  constraint organization_live_polls_window_order check (
    opens_at is null or closes_at is null or opens_at < closes_at
  ),
  constraint organization_live_polls_result_cache_array check (
    pg_catalog.jsonb_typeof(result_cache) = 'array'
  )
);

create index organization_live_polls_org_state_idx
  on public.organization_live_polls (organization_id, state, coalesce(opens_at, scheduled_at), id);

create table public.organization_live_poll_options (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  poll_id uuid not null references public.organization_live_polls(id) on delete cascade,
  label text not null,
  sort_index integer not null check (sort_index >= 0),
  unique (poll_id, sort_index),
  constraint organization_live_poll_options_label_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(label)) between 1 and 160
  )
);

create table public.organization_live_poll_votes (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  poll_id uuid not null references public.organization_live_polls(id) on delete cascade,
  option_id uuid not null references public.organization_live_poll_options(id) on delete restrict,
  voter_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (poll_id, voter_user_id)
);

create table public.organization_live_poll_attendance (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  poll_id uuid not null references public.organization_live_polls(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  eligible boolean not null default true,
  rsvp text not null default 'pending' check (rsvp in ('pending', 'yes', 'no', 'maybe')),
  checked_in_at timestamptz,
  check_in_actor uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (poll_id, user_id)
);

-- -------------------------------------------------------------------------
-- Engagement delivery, presence, channel controls, and Compass actions
-- -------------------------------------------------------------------------

create table public.engagement_delivery_outbox (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  delivery_kind text not null check (delivery_kind in ('broadcast', 'survey_invitation', 'survey_reminder')),
  source_kind text not null check (source_kind in ('broadcast', 'survey')),
  source_id text not null,
  locale text not null default 'en' check (locale in ('en', 'es')),
  state text not null default 'queued' check (state in ('queued', 'leased', 'sent', 'failed', 'suppressed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  available_at timestamptz not null default pg_catalog.now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (delivery_kind, source_id, recipient_user_id),
  constraint engagement_delivery_outbox_source_bounded check (
    pg_catalog.char_length(source_id) between 1 and 120
  ),
  constraint engagement_delivery_outbox_error_bounded check (
    last_error_code is null or (
      pg_catalog.char_length(last_error_code) between 1 and 80
      and last_error_code ~ '^[a-z0-9._:-]+$'
    )
  )
);

create index engagement_delivery_outbox_claim_idx
  on public.engagement_delivery_outbox (state, available_at, created_at, id);

create table public.member_presence (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default pg_catalog.now(),
  status text not null default 'online' check (status in ('online', 'away', 'offline')),
  primary key (organization_id, user_id)
);

create index member_presence_recent_idx
  on public.member_presence (organization_id, last_seen_at desc);

create table public.chapter_space_controls (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  space_id uuid primary key references public.chapter_spaces(id) on delete cascade,
  posting_mode text not null default 'members' check (posting_mode in ('members', 'staff_only', 'read_only')),
  slow_mode_seconds integer not null default 0 check (slow_mode_seconds between 0 and 86400),
  approvals_required boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default pg_catalog.now()
);

create table public.chapter_space_preferences (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  space_id uuid not null references public.chapter_spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  muted boolean not null default false,
  notifications text not null default 'all' check (notifications in ('all', 'mentions', 'none')),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (space_id, user_id)
);

create table public.chapter_space_keyword_monitors (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  space_id uuid not null references public.chapter_spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  keyword text not null,
  active boolean not null default true,
  created_at timestamptz not null default pg_catalog.now(),
  unique (space_id, user_id, keyword),
  constraint chapter_space_keyword_monitors_keyword_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(keyword)) between 2 and 80
    and keyword !~ '[[:cntrl:]]'
  )
);

create table public.chapter_space_keyword_hits (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  monitor_id uuid not null references public.chapter_space_keyword_monitors(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  space_id uuid not null references public.chapter_spaces(id) on delete cascade,
  post_id uuid not null references public.chapter_thread_posts(id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  unique (monitor_id, post_id)
);

create table public.compass_message_briefings (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  requested_by uuid not null references auth.users(id) on delete cascade,
  source_kind text not null check (source_kind in ('private', 'channel', 'task')),
  target_id uuid not null,
  summary text not null,
  action_items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  constraint compass_message_briefings_summary_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(summary)) between 1 and 4000
  ),
  constraint compass_message_briefings_actions_array check (
    pg_catalog.jsonb_typeof(action_items) = 'array'
    and pg_catalog.jsonb_array_length(action_items) <= 12
  )
);

create index compass_message_briefings_actor_target_idx
  on public.compass_message_briefings (requested_by, source_kind, target_id, created_at desc);

create table public.compass_workspace_preferences (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  module_order jsonb not null default '["inbox","surveys","tasks","cases"]'::jsonb,
  hidden_modules jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, user_id),
  constraint compass_workspace_preferences_order_array check (
    pg_catalog.jsonb_typeof(module_order) = 'array'
    and pg_catalog.jsonb_array_length(module_order) between 1 and 8
  ),
  constraint compass_workspace_preferences_hidden_array check (
    pg_catalog.jsonb_typeof(hidden_modules) = 'array'
    and pg_catalog.jsonb_array_length(hidden_modules) <= 8
  )
);

create table public.compass_workspace_actions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  action_kind text not null check (action_kind = 'create_task'),
  source_kind text not null check (source_kind in ('message', 'broadcast', 'notification', 'survey', 'case')),
  source_id text not null,
  title text not null,
  state text not null default 'proposed' check (state in ('proposed', 'confirmed', 'rejected', 'failed')),
  result_task_id uuid references public.chapter_tasks(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  decided_at timestamptz,
  constraint compass_workspace_actions_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 200
  ),
  constraint compass_workspace_actions_source_bounded check (
    pg_catalog.char_length(source_id) between 1 and 120
  )
);

-- -------------------------------------------------------------------------
-- RLS and grants
-- -------------------------------------------------------------------------

alter table public.organization_survey_tasks enable row level security;
alter table public.organization_survey_deliveries enable row level security;
alter table public.organization_survey_reviews enable row level security;
alter table public.organization_pulse_prompts enable row level security;
alter table public.organization_pulse_events enable row level security;
alter table public.organization_live_polls enable row level security;
alter table public.organization_live_poll_options enable row level security;
alter table public.organization_live_poll_votes enable row level security;
alter table public.organization_live_poll_attendance enable row level security;
alter table public.engagement_delivery_outbox enable row level security;
alter table public.member_presence enable row level security;
alter table public.chapter_space_controls enable row level security;
alter table public.chapter_space_preferences enable row level security;
alter table public.chapter_space_keyword_monitors enable row level security;
alter table public.chapter_space_keyword_hits enable row level security;
alter table public.compass_message_briefings enable row level security;
alter table public.compass_workspace_preferences enable row level security;
alter table public.compass_workspace_actions enable row level security;

-- Every browser-visible table added after the platform-wide MFA sweep must
-- carry the same restrictive policy itself. Permissive tenant policies below
-- can only narrow access further; they can never bypass step-up.
do $mfa$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'organization_survey_tasks',
    'organization_survey_deliveries',
    'organization_survey_reviews',
    'organization_pulse_prompts',
    'organization_pulse_events',
    'organization_live_polls',
    'organization_live_poll_options',
    'organization_live_poll_votes',
    'organization_live_poll_attendance',
    'engagement_delivery_outbox',
    'member_presence',
    'chapter_space_controls',
    'chapter_space_preferences',
    'chapter_space_keyword_monitors',
    'chapter_space_keyword_hits',
    'compass_message_briefings',
    'compass_workspace_preferences',
    'compass_workspace_actions'
  ] loop
    execute pg_catalog.format(
      'create policy mfa_assurance on public.%I as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()))',
      relation_name
    );
  end loop;
end;
$mfa$;

revoke all on table
  public.organization_survey_tasks,
  public.organization_survey_deliveries,
  public.organization_survey_reviews,
  public.organization_pulse_prompts,
  public.organization_pulse_events,
  public.organization_live_polls,
  public.organization_live_poll_options,
  public.organization_live_poll_votes,
  public.organization_live_poll_attendance,
  public.engagement_delivery_outbox,
  public.member_presence,
  public.chapter_space_controls,
  public.chapter_space_preferences,
  public.chapter_space_keyword_monitors,
  public.chapter_space_keyword_hits,
  public.compass_message_briefings,
  public.compass_workspace_preferences,
  public.compass_workspace_actions
from public, anon, authenticated;

grant all on table
  public.organization_survey_tasks,
  public.organization_survey_deliveries,
  public.organization_survey_reviews,
  public.organization_pulse_prompts,
  public.organization_pulse_events,
  public.organization_live_polls,
  public.organization_live_poll_options,
  public.organization_live_poll_votes,
  public.organization_live_poll_attendance,
  public.engagement_delivery_outbox,
  public.member_presence,
  public.chapter_space_controls,
  public.chapter_space_preferences,
  public.chapter_space_keyword_monitors,
  public.chapter_space_keyword_hits,
  public.compass_message_briefings,
  public.compass_workspace_preferences,
  public.compass_workspace_actions
to service_role;

grant select on public.organization_live_polls, public.organization_live_poll_options to authenticated;
grant select on public.organization_pulse_prompts to authenticated;
grant select on public.member_presence to authenticated;
grant select on public.chapter_space_controls, public.chapter_space_preferences to authenticated;
grant select on public.chapter_space_keyword_monitors, public.chapter_space_keyword_hits to authenticated;
grant select on public.compass_message_briefings, public.compass_workspace_preferences to authenticated;
grant select on public.compass_workspace_actions to authenticated;

create policy organization_live_polls_member_read on public.organization_live_polls
for select to authenticated
using (
  private.is_organization_member(organization_id)
  and (chapter_id is null or chapter_id = private.current_member_chapter())
  and (
    private.has_organization_role(organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    or results_visibility = 'live'
    or (results_visibility = 'after_close' and state = 'closed')
  )
);

create policy organization_live_poll_options_member_read on public.organization_live_poll_options
for select to authenticated
using (
  exists (
    select 1 from public.organization_live_polls p
    where p.id = poll_id
      and p.organization_id = organization_id
      and private.is_organization_member(p.organization_id)
      and (p.chapter_id is null or p.chapter_id = private.current_member_chapter())
  )
);

create policy organization_pulse_prompts_member_read on public.organization_pulse_prompts
for select to authenticated
using (
  active
  and private.is_organization_member(organization_id)
  and (chapter_id is null or chapter_id = private.current_member_chapter())
);

create policy member_presence_scoped_read on public.member_presence
for select to authenticated
using (
  user_id = (select auth.uid())
  or private.has_organization_role(organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
);

create policy chapter_space_controls_authorized_read on public.chapter_space_controls
for select to authenticated
using (
  exists (
    select 1 from public.chapter_spaces s
    where s.id = space_id and private.can_read_chapter_space(s)
  )
);

create policy chapter_space_preferences_own_read on public.chapter_space_preferences
for select to authenticated
using (user_id = (select auth.uid()));

create policy chapter_space_keyword_monitors_own_read on public.chapter_space_keyword_monitors
for select to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.chapter_spaces s
    where s.id = space_id and private.can_read_chapter_space(s)
  )
);

create policy chapter_space_keyword_hits_own_read on public.chapter_space_keyword_hits
for select to authenticated
using (user_id = (select auth.uid()));

create policy compass_message_briefings_own_read on public.compass_message_briefings
for select to authenticated
using (requested_by = (select auth.uid()) and private.is_organization_member(organization_id));

create policy compass_workspace_preferences_own_read on public.compass_workspace_preferences
for select to authenticated
using (user_id = (select auth.uid()) and private.is_organization_member(organization_id));

create policy compass_workspace_actions_own_read on public.compass_workspace_actions
for select to authenticated
using (actor_user_id = (select auth.uid()) and private.is_organization_member(organization_id));

-- Postgres Changes publishes only the safe poll projection. Vote rows remain
-- private; the tally trigger updates vote_count/result_cache on the poll row.
do $publication$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_catalog.pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'organization_live_polls'
     ) then
    alter publication supabase_realtime add table public.organization_live_polls;
  end if;
end;
$publication$;

-- -------------------------------------------------------------------------
-- Shared authorization helpers
-- -------------------------------------------------------------------------

create function private.engagement_selected_organization()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select private.mi1_w2_selected_organization()
$function$;

create function private.engagement_require_staff(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(
    p_organization_id,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
end;
$function$;

create function private.engagement_user_in_organization(p_organization_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = p_user_id
      and m.status = 'active'
      and m.revoked_at is null
  )
$function$;

create function private.engagement_can_read_message_target(p_source_kind text, p_target_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case p_source_kind
    when 'private' then exists (
      select 1 from public.member_conversations conversation
      where conversation.id = p_target_id
        and (
          conversation.user_id = (select auth.uid())
          or public.staff_can_see_user(conversation.user_id, 'steward')
        )
    )
    when 'channel' then exists (
      select 1
      from public.chapter_threads thread
      join public.chapter_spaces space on space.id = thread.space_id
      where thread.id = p_target_id and private.can_read_chapter_space(space)
    )
    when 'task' then exists (
      select 1 from public.chapter_task_messages message
      where message.task_id = p_target_id
        and ((select auth.uid()) = message.sender_id or (select auth.uid()) = message.recipient_id)
        and message.chapter_id = private.current_member_chapter()
    )
    else false
  end
$function$;

revoke all on function private.engagement_selected_organization() from public, anon, authenticated, service_role;
revoke all on function private.engagement_require_staff(uuid) from public, anon, authenticated, service_role;
revoke all on function private.engagement_user_in_organization(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.engagement_can_read_message_target(text, uuid) from public, anon, authenticated, service_role;

-- -------------------------------------------------------------------------
-- Survey ownership, distribution, review, quarterly gate, and reports
-- -------------------------------------------------------------------------

create function public.configure_organization_survey_operations(
  p_survey_id uuid,
  p_operations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  survey public.organization_surveys%rowtype;
  next_owner uuid := nullif(p_operations ->> 'ownerUserId', '')::uuid;
  next_cadence text := coalesce(nullif(p_operations ->> 'cadence', ''), 'one_off');
  next_period text := nullif(pg_catalog.btrim(coalesce(p_operations ->> 'periodKey', '')), '');
  next_state text := coalesce(nullif(p_operations ->> 'operationsState', ''), 'draft');
begin
  perform private.engagement_require_staff(org);
  select * into survey
  from public.organization_surveys
  where id = p_survey_id and organization_id = org
  for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if next_cadence not in ('one_off', 'quarterly', 'contextual') then
    raise exception 'invalid cadence' using errcode = '22023';
  end if;
  if next_state not in ('draft', 'ready', 'distributing', 'reviewing', 'complete') then
    raise exception 'invalid operations state' using errcode = '22023';
  end if;
  if next_cadence = 'quarterly' and next_period is null then
    raise exception 'quarterly surveys require a period key' using errcode = '22023';
  end if;
  if next_owner is not null and not private.engagement_user_in_organization(org, next_owner) then
    raise exception 'owner is not an active organization member' using errcode = '42501';
  end if;
  update public.organization_surveys
  set cadence = next_cadence,
      period_key = next_period,
      opens_at = nullif(p_operations ->> 'opensAt', '')::timestamptz,
      closes_at = nullif(p_operations ->> 'closesAt', '')::timestamptz,
      owner_user_id = next_owner,
      operations_state = next_state,
      review_due_at = nullif(p_operations ->> 'reviewDueAt', '')::timestamptz,
      updated_at = pg_catalog.now()
  where id = survey.id;
  insert into public.organization_survey_tasks (
    organization_id, survey_id, reason, status, assigned_to, due_at, created_by
  )
  values (
    org, survey.id, 'readiness',
    case when next_state in ('ready', 'distributing', 'reviewing', 'complete') then 'done' else 'open' end,
    next_owner, nullif(p_operations ->> 'readinessDueAt', '')::timestamptz, (select auth.uid())
  )
  on conflict (survey_id, reason) do update
    set status = excluded.status,
        assigned_to = excluded.assigned_to,
        due_at = excluded.due_at,
        updated_at = pg_catalog.now();
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', survey.id,
    'status', next_state,
    'reasonCode', 'operations_configured',
    'fieldsChanged', pg_catalog.jsonb_build_array('cadence', 'periodKey', 'owner', 'window', 'reviewDueAt')
  ));
  return private.mi1_w2_project_survey(survey.id) || pg_catalog.jsonb_build_object(
    'cadence', next_cadence,
    'periodKey', next_period,
    'operationsState', next_state,
    'ownerUserId', next_owner
  );
end;
$function$;

create function public.prepare_organization_survey_distribution(
  p_survey_id uuid,
  p_recipient_user_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  survey public.organization_surveys%rowtype;
  queued integer := 0;
begin
  perform private.engagement_require_staff(org);
  select * into survey
  from public.organization_surveys
  where id = p_survey_id and organization_id = org
  for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if survey.status <> 'open' then
    raise exception 'survey must be open before distribution' using errcode = '55000';
  end if;

  with eligible as (
    select distinct membership.user_id
    from public.organization_memberships membership
    left join public.member_profiles profile on profile.id = membership.user_id
    where membership.organization_id = org
      and membership.status = 'active'
      and membership.revoked_at is null
      and (p_recipient_user_ids is null or membership.user_id = any(p_recipient_user_ids))
      and (survey.chapter_id is null or profile.chapter_id = survey.chapter_id)
  ), inserted as (
    insert into public.organization_survey_deliveries (
      organization_id, survey_id, recipient_user_id
    )
    select org, survey.id, eligible.user_id
    from eligible
    on conflict (survey_id, recipient_user_id) do nothing
    returning recipient_user_id
  )
  insert into public.engagement_delivery_outbox (
    organization_id, recipient_user_id, delivery_kind, source_kind, source_id
  )
  select org, inserted.recipient_user_id, 'survey_invitation', 'survey', survey.id::text
  from inserted
  on conflict (delivery_kind, source_id, recipient_user_id) do nothing;

  get diagnostics queued = row_count;
  update public.organization_surveys
  set operations_state = 'distributing', updated_at = pg_catalog.now()
  where id = survey.id;
  insert into public.organization_survey_tasks (
    organization_id, survey_id, reason, status, assigned_to, created_by
  ) values (
    org, survey.id, 'distribution', 'in_progress', survey.owner_user_id, (select auth.uid())
  )
  on conflict (survey_id, reason) do update
    set status = 'in_progress', assigned_to = excluded.assigned_to, updated_at = pg_catalog.now();
  perform private.mi1_w2_write_audit(org, 'survey_published', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', survey.id,
    'status', 'distributing',
    'count', queued,
    'reasonCode', 'distribution_prepared'
  ));
  return pg_catalog.jsonb_build_object('surveyId', survey.id, 'queued', queued);
end;
$function$;

create function public.queue_organization_survey_reminders(p_survey_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  queued integer;
begin
  perform private.engagement_require_staff(org);
  if not exists (
    select 1 from public.organization_surveys s
    where s.id = p_survey_id and s.organization_id = org and s.status = 'open'
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  with candidates as (
    select d.recipient_user_id
    from public.organization_survey_deliveries d
    where d.organization_id = org
      and d.survey_id = p_survey_id
      and d.state in ('queued', 'sent', 'failed')
      and d.engaged_at is null
  ), inserted as (
    insert into public.engagement_delivery_outbox (
      organization_id, recipient_user_id, delivery_kind, source_kind, source_id
    )
    select org, candidates.recipient_user_id, 'survey_reminder', 'survey', p_survey_id::text
    from candidates
    on conflict (delivery_kind, source_id, recipient_user_id) do update
      set state = case
            when public.engagement_delivery_outbox.state = 'sent' then public.engagement_delivery_outbox.state
            else 'queued'
          end,
          available_at = case
            when public.engagement_delivery_outbox.state = 'sent' then public.engagement_delivery_outbox.available_at
            else pg_catalog.now()
          end,
          updated_at = pg_catalog.now()
      where public.engagement_delivery_outbox.state <> 'sent'
    returning recipient_user_id
  )
  select pg_catalog.count(*)::integer into queued from inserted;
  update public.organization_survey_deliveries
  set escalation_state = 'reminder_due', updated_at = pg_catalog.now()
  where organization_id = org and survey_id = p_survey_id and engaged_at is null;
  return pg_catalog.jsonb_build_object('surveyId', p_survey_id, 'queued', coalesce(queued, 0));
end;
$function$;

create function private.on_organization_survey_submitted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status = 'submitted' and old.status is distinct from new.status then
    insert into public.organization_survey_reviews (
      organization_id, survey_id, session_id
    ) values (new.organization_id, new.survey_id, new.id)
    on conflict (session_id) do nothing;
    update public.organization_survey_deliveries
    set state = 'engaged', engaged_at = coalesce(engaged_at, pg_catalog.now()),
        escalation_state = 'resolved', updated_at = pg_catalog.now()
    where survey_id = new.survey_id and recipient_user_id = new.respondent_user_id;
  end if;
  return new;
end;
$function$;

create trigger organization_survey_sessions_engagement_completion
after update of status on public.organization_survey_sessions
for each row execute function private.on_organization_survey_submitted();

revoke all on function private.on_organization_survey_submitted() from public, anon, authenticated, service_role;

create function public.update_organization_survey_task(
  p_task_id uuid,
  p_status text,
  p_assigned_to uuid default null,
  p_due_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  task public.organization_survey_tasks%rowtype;
begin
  perform private.engagement_require_staff(org);
  if p_status not in ('open', 'in_progress', 'done', 'dismissed') then
    raise exception 'invalid task status' using errcode = '22023';
  end if;
  if p_assigned_to is not null and not private.engagement_user_in_organization(org, p_assigned_to) then
    raise exception 'assignee is not an active organization member' using errcode = '42501';
  end if;
  update public.organization_survey_tasks
  set status = p_status, assigned_to = p_assigned_to, due_at = p_due_at,
      updated_at = pg_catalog.now()
  where id = p_task_id and organization_id = org
  returning * into task;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', task.survey_id,
    'status', task.status,
    'reasonCode', task.reason,
    'fieldsChanged', pg_catalog.jsonb_build_array('assignment', 'status', 'dueAt')
  ));
  return pg_catalog.jsonb_build_object(
    'id', task.id, 'surveyId', task.survey_id, 'reason', task.reason,
    'status', task.status, 'assignedTo', task.assigned_to, 'dueAt', task.due_at
  );
end;
$function$;

create function public.update_organization_survey_review(
  p_review_id uuid,
  p_state text,
  p_assigned_to uuid default null,
  p_disposition text default null,
  p_follow_up_due_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  review public.organization_survey_reviews%rowtype;
begin
  perform private.engagement_require_staff(org);
  if p_state not in ('unreviewed', 'assigned', 'follow_up', 'resolved', 'dismissed') then
    raise exception 'invalid review state' using errcode = '22023';
  end if;
  if p_assigned_to is not null and not private.engagement_user_in_organization(org, p_assigned_to) then
    raise exception 'reviewer is not an active organization member' using errcode = '42501';
  end if;
  update public.organization_survey_reviews
  set state = p_state,
      assigned_to = p_assigned_to,
      disposition = nullif(pg_catalog.btrim(coalesce(p_disposition, '')), ''),
      follow_up_due_at = p_follow_up_due_at,
      updated_at = pg_catalog.now()
  where id = p_review_id and organization_id = org
  returning * into review;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', review.survey_id,
    'sessionId', review.session_id,
    'status', review.state,
    'reasonCode', 'response_review_updated',
    'fieldsChanged', pg_catalog.jsonb_build_array('assignment', 'state', 'disposition', 'followUpDueAt')
  ));
  return pg_catalog.jsonb_build_object(
    'id', review.id, 'surveyId', review.survey_id, 'sessionId', review.session_id,
    'state', review.state, 'assignedTo', review.assigned_to,
    'disposition', review.disposition, 'followUpDueAt', review.follow_up_due_at
  );
end;
$function$;

create function public.get_organization_survey_review_detail(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
begin
  perform private.engagement_require_staff(org);
  if not exists (
    select 1 from public.organization_survey_sessions session
    where session.id = p_session_id and session.organization_id = org
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  return pg_catalog.jsonb_build_object(
    'sessionId', p_session_id,
    'answers', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'questionId', answer.question_id,
        'label', question.label,
        'type', question.question_type,
        'value', answer.value
      ) order by question.sort_index)
      from public.organization_survey_answers answer
      join public.organization_survey_questions question on question.id = answer.question_id
      where answer.session_id = p_session_id and answer.organization_id = org
    ), '[]'::jsonb)
  );
end;
$function$;

create function public.get_quarterly_survey_gate()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  current_period text := pg_catalog.to_char(current_date, 'YYYY')
    || '-Q' || pg_catalog.date_part('quarter', current_date)::integer;
  survey public.organization_surveys%rowtype;
  session_status text;
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  select * into survey
  from public.organization_surveys s
  where s.organization_id = org
    and s.cadence = 'quarterly'
    and s.period_key = current_period
    and s.status in ('open', 'closed')
  order by case when s.status = 'open' then 0 else 1 end, s.updated_at desc
  limit 1;
  if not found then
    return pg_catalog.jsonb_build_object(
      'periodKey', current_period, 'surveyId', null, 'required', false,
      'completed', false, 'unlocked', true
    );
  end if;
  select session.status into session_status
  from public.organization_survey_sessions session
  where session.organization_id = org
    and session.survey_id = survey.id
    and session.respondent_user_id = actor;
  return pg_catalog.jsonb_build_object(
    'periodKey', current_period,
    'surveyId', survey.id,
    'title', survey.title,
    'required', survey.status = 'open',
    'completed', coalesce(session_status = 'submitted', false),
    'unlocked', survey.status <> 'open' or coalesce(session_status = 'submitted', false),
    'status', coalesce(session_status, 'not_started'),
    'closesAt', survey.closes_at
  );
end;
$function$;

create function public.get_organization_survey_report(p_survey_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  survey public.organization_surveys%rowtype;
  responses integer;
begin
  perform private.engagement_require_staff(org);
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select pg_catalog.count(*)::integer into responses
  from public.organization_survey_sessions session
  where session.organization_id = org and session.survey_id = survey.id and session.status = 'submitted';
  if responses < survey.privacy_min_responses then
    return pg_catalog.jsonb_build_object(
      'surveyId', survey.id,
      'responseCount', responses,
      'privacyMinResponses', survey.privacy_min_responses,
      'available', false,
      'questions', '[]'::jsonb
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'surveyId', survey.id,
    'title', survey.title,
    'responseCount', responses,
    'privacyMinResponses', survey.privacy_min_responses,
    'available', true,
    'questions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', question.id,
        'label', question.label,
        'type', question.question_type,
        'answered', (
          select pg_catalog.count(*)
          from public.organization_survey_answers answer
          join public.organization_survey_sessions session on session.id = answer.session_id
          where answer.question_id = question.id and session.status = 'submitted'
        ),
        'distribution', case
          when question.question_type in ('radio', 'dropdown', 'yes_no', 'scale', 'rating') then (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', bucket.value, 'count', bucket.count) order by bucket.value), '[]'::jsonb)
            from (
              select answer.value, pg_catalog.count(*)::integer as count
              from public.organization_survey_answers answer
              join public.organization_survey_sessions session on session.id = answer.session_id
              where answer.question_id = question.id and session.status = 'submitted'
              group by answer.value
            ) bucket
          )
          else '[]'::jsonb
        end
      ) order by question.sort_index)
      from public.organization_survey_questions question
      where question.survey_id = survey.id and question.organization_id = org
    ), '[]'::jsonb)
  );
end;
$function$;

create function public.export_organization_survey_results(p_survey_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  survey public.organization_surveys%rowtype;
begin
  perform private.engagement_require_staff(org);
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  return pg_catalog.jsonb_build_object(
    'surveyId', survey.id,
    'title', survey.title,
    'generatedAt', pg_catalog.now(),
    'questions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', q.id, 'label', q.label, 'type', q.question_type, 'sectionKey', q.section_key
      ) order by q.sort_index)
      from public.organization_survey_questions q
      where q.survey_id = survey.id and q.organization_id = org
    ), '[]'::jsonb),
    'responses', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'responseId', session.id,
        'submittedAt', session.submitted_at,
        'answers', coalesce((
          select pg_catalog.jsonb_object_agg(answer.question_id::text, answer.value)
          from public.organization_survey_answers answer
          where answer.session_id = session.id
        ), '{}'::jsonb)
      ) order by session.submitted_at, session.id)
      from public.organization_survey_sessions session
      where session.organization_id = org
        and session.survey_id = survey.id
        and session.status = 'submitted'
    ), '[]'::jsonb)
  );
end;
$function$;

-- -------------------------------------------------------------------------
-- Contextual pulse RPCs
-- -------------------------------------------------------------------------

create function public.save_organization_pulse_prompt(p_prompt jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  prompt_id uuid := nullif(p_prompt ->> 'id', '')::uuid;
  chapter text := nullif(pg_catalog.btrim(coalesce(p_prompt ->> 'chapterId', '')), '');
  saved public.organization_pulse_prompts%rowtype;
begin
  perform private.engagement_require_staff(org);
  if chapter is not null and not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'chapter is not in the selected organization' using errcode = '42501';
  end if;
  if prompt_id is null then
    insert into public.organization_pulse_prompts (
      organization_id, chapter_id, event_key, question, options, active, cooldown_hours, created_by
    ) values (
      org,
      chapter,
      pg_catalog.lower(pg_catalog.btrim(coalesce(p_prompt ->> 'eventKey', ''))),
      pg_catalog.btrim(coalesce(p_prompt ->> 'question', '')),
      coalesce(p_prompt -> 'options', '[]'::jsonb),
      coalesce((p_prompt ->> 'active')::boolean, true),
      coalesce(nullif(p_prompt ->> 'cooldownHours', '')::integer, 168),
      (select auth.uid())
    ) returning * into saved;
  else
    update public.organization_pulse_prompts
    set chapter_id = chapter,
        event_key = pg_catalog.lower(pg_catalog.btrim(coalesce(p_prompt ->> 'eventKey', ''))),
        question = pg_catalog.btrim(coalesce(p_prompt ->> 'question', '')),
        options = coalesce(p_prompt -> 'options', '[]'::jsonb),
        active = coalesce((p_prompt ->> 'active')::boolean, active),
        cooldown_hours = coalesce(nullif(p_prompt ->> 'cooldownHours', '')::integer, cooldown_hours),
        updated_at = pg_catalog.now()
    where id = prompt_id and organization_id = org
    returning * into saved;
    if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  end if;
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'runId', saved.id,
    'status', case when saved.active then 'active' else 'inactive' end,
    'reasonCode', 'contextual_pulse_prompt_saved'
  ));
  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'chapterId', saved.chapter_id, 'eventKey', saved.event_key,
    'question', saved.question, 'options', saved.options, 'active', saved.active,
    'cooldownHours', saved.cooldown_hours
  );
end;
$function$;

create function public.evaluate_contextual_pulse(
  p_event_key text,
  p_context_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  prompt public.organization_pulse_prompts%rowtype;
  event_row public.organization_pulse_events%rowtype;
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if pg_catalog.lower(pg_catalog.btrim(coalesce(p_event_key, ''))) !~ '^[a-z0-9._:-]{1,80}$'
     or pg_catalog.btrim(coalesce(p_context_key, '')) !~ '^[a-zA-Z0-9._:-]{1,120}$' then
    raise exception 'invalid pulse context' using errcode = '22023';
  end if;
  select candidate.* into prompt
  from public.organization_pulse_prompts candidate
  where candidate.organization_id = org
    and candidate.active
    and candidate.event_key = pg_catalog.lower(pg_catalog.btrim(p_event_key))
    and (candidate.chapter_id is null or candidate.chapter_id = chapter)
    and not exists (
      select 1 from public.organization_pulse_events previous
      where previous.prompt_id = candidate.id
        and previous.user_id = actor
        and previous.updated_at > pg_catalog.now() - pg_catalog.make_interval(hours => candidate.cooldown_hours)
    )
  order by (candidate.chapter_id is not null) desc, candidate.updated_at desc
  limit 1;
  if not found then return null; end if;
  insert into public.organization_pulse_events (
    organization_id, prompt_id, user_id, context_key
  ) values (org, prompt.id, actor, pg_catalog.btrim(p_context_key))
  on conflict (prompt_id, user_id, context_key) do update
    set shown_at = excluded.shown_at, state = 'shown', response_value = null,
        responded_at = null, updated_at = pg_catalog.now()
  returning * into event_row;
  return pg_catalog.jsonb_build_object(
    'eventId', event_row.id,
    'promptId', prompt.id,
    'question', prompt.question,
    'options', prompt.options,
    'contextKey', event_row.context_key
  );
end;
$function$;

create function public.respond_contextual_pulse(
  p_event_id uuid,
  p_response jsonb default null,
  p_dismiss boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  event_row public.organization_pulse_events%rowtype;
  prompt public.organization_pulse_prompts%rowtype;
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  select * into event_row from public.organization_pulse_events
  where id = p_event_id and organization_id = org and user_id = actor
  for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into prompt from public.organization_pulse_prompts where id = event_row.prompt_id;
  if p_dismiss then
    update public.organization_pulse_events
    set state = 'dismissed', response_value = null, responded_at = null, updated_at = pg_catalog.now()
    where id = event_row.id;
  else
    if p_response is null or not exists (
      select 1 from pg_catalog.jsonb_array_elements(prompt.options) option
      where option = p_response
         or option -> 'value' = p_response
         or pg_catalog.to_jsonb(option ->> 'value') = p_response
    ) then raise exception 'response is not a prompt option' using errcode = '22023'; end if;
    update public.organization_pulse_events
    set state = 'responded', response_value = p_response,
        responded_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = event_row.id;
  end if;
  return pg_catalog.jsonb_build_object(
    'eventId', event_row.id,
    'state', case when p_dismiss then 'dismissed' else 'responded' end
  );
end;
$function$;

-- -------------------------------------------------------------------------
-- Live poll lifecycle, realtime tally, RSVP, roster, and check-in
-- -------------------------------------------------------------------------

create function private.recalculate_organization_live_poll(p_poll_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  poll public.organization_live_polls%rowtype;
  tally jsonb;
  total integer;
begin
  select * into poll from public.organization_live_polls where id = p_poll_id for update;
  if not found then return; end if;
  select pg_catalog.count(*)::integer into total
  from public.organization_live_poll_votes vote where vote.poll_id = poll.id;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'optionId', option.id, 'label', option.label, 'votes', coalesce(counts.votes, 0)
  ) order by option.sort_index), '[]'::jsonb)
  into tally
  from public.organization_live_poll_options option
  left join (
    select vote.option_id, pg_catalog.count(*)::integer as votes
    from public.organization_live_poll_votes vote
    where vote.poll_id = poll.id
    group by vote.option_id
  ) counts on counts.option_id = option.id
  where option.poll_id = poll.id;
  update public.organization_live_polls
  set vote_count = total,
      result_cache = case
        when poll.results_visibility = 'live' then tally
        when poll.results_visibility = 'after_close' and poll.state = 'closed' then tally
        else '[]'::jsonb
      end,
      updated_at = pg_catalog.now()
  where id = poll.id;
end;
$function$;

create function private.on_organization_live_poll_vote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.recalculate_organization_live_poll(coalesce(new.poll_id, old.poll_id));
  return coalesce(new, old);
end;
$function$;

create trigger organization_live_poll_votes_recalculate
after insert or update or delete on public.organization_live_poll_votes
for each row execute function private.on_organization_live_poll_vote();

revoke all on function private.recalculate_organization_live_poll(uuid) from public, anon, authenticated, service_role;
revoke all on function private.on_organization_live_poll_vote() from public, anon, authenticated, service_role;

create function public.save_organization_live_poll(p_poll jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  poll_id uuid := nullif(p_poll ->> 'id', '')::uuid;
  chapter text := nullif(pg_catalog.btrim(coalesce(p_poll ->> 'chapterId', '')), '');
  options jsonb := coalesce(p_poll -> 'options', '[]'::jsonb);
  saved public.organization_live_polls%rowtype;
begin
  perform private.engagement_require_staff(org);
  if chapter is not null and not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'chapter is not in the selected organization' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(options) <> 'array' or pg_catalog.jsonb_array_length(options) not between 2 and 10 then
    raise exception 'live polls require between 2 and 10 options' using errcode = '22023';
  end if;
  if poll_id is null then
    insert into public.organization_live_polls (
      organization_id, chapter_id, title, description, eligibility,
      results_visibility, scheduled_at, opens_at, closes_at, quorum_target, created_by
    ) values (
      org, chapter, pg_catalog.btrim(coalesce(p_poll ->> 'title', '')),
      pg_catalog.btrim(coalesce(p_poll ->> 'description', '')),
      coalesce(nullif(p_poll ->> 'eligibility', ''), 'organization'),
      coalesce(nullif(p_poll ->> 'resultsVisibility', ''), 'after_close'),
      nullif(p_poll ->> 'scheduledAt', '')::timestamptz,
      nullif(p_poll ->> 'opensAt', '')::timestamptz,
      nullif(p_poll ->> 'closesAt', '')::timestamptz,
      nullif(p_poll ->> 'quorumTarget', '')::integer,
      (select auth.uid())
    ) returning * into saved;
  else
    select * into saved from public.organization_live_polls
    where id = poll_id and organization_id = org for update;
    if not found then raise exception 'not found' using errcode = 'P0002'; end if;
    if saved.state not in ('draft', 'scheduled') then
      raise exception 'an active or closed poll cannot be edited' using errcode = '55000';
    end if;
    update public.organization_live_polls
    set chapter_id = chapter,
        title = pg_catalog.btrim(coalesce(p_poll ->> 'title', '')),
        description = pg_catalog.btrim(coalesce(p_poll ->> 'description', '')),
        eligibility = coalesce(nullif(p_poll ->> 'eligibility', ''), eligibility),
        results_visibility = coalesce(nullif(p_poll ->> 'resultsVisibility', ''), results_visibility),
        scheduled_at = nullif(p_poll ->> 'scheduledAt', '')::timestamptz,
        opens_at = nullif(p_poll ->> 'opensAt', '')::timestamptz,
        closes_at = nullif(p_poll ->> 'closesAt', '')::timestamptz,
        quorum_target = nullif(p_poll ->> 'quorumTarget', '')::integer,
        updated_at = pg_catalog.now()
    where id = saved.id returning * into saved;
    delete from public.organization_live_poll_options option where option.poll_id = saved.id;
  end if;
  insert into public.organization_live_poll_options (
    organization_id, poll_id, label, sort_index
  )
  select org, saved.id,
    pg_catalog.btrim(case when pg_catalog.jsonb_typeof(item.value) = 'string' then item.value #>> '{}' else item.value ->> 'label' end),
    item.ordinality::integer - 1
  from pg_catalog.jsonb_array_elements(options) with ordinality item(value, ordinality);
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'runId', saved.id, 'status', saved.state,
    'reasonCode', 'live_poll_saved', 'count', pg_catalog.jsonb_array_length(options)
  ));
  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'title', saved.title, 'state', saved.state,
    'scheduledAt', saved.scheduled_at, 'opensAt', saved.opens_at,
    'closesAt', saved.closes_at, 'eligibility', saved.eligibility,
    'resultsVisibility', saved.results_visibility
  );
end;
$function$;

create function public.transition_organization_live_poll(
  p_poll_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  poll public.organization_live_polls%rowtype;
  next_state text;
begin
  perform private.engagement_require_staff(org);
  select * into poll from public.organization_live_polls
  where id = p_poll_id and organization_id = org for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  next_state := case p_action
    when 'schedule' then 'scheduled'
    when 'open' then 'open'
    when 'close' then 'closed'
    when 'cancel' then 'cancelled'
    when 'archive' then 'closed'
    else null
  end;
  if next_state is null then raise exception 'invalid poll action' using errcode = '22023'; end if;
  if p_action = 'schedule' and poll.state <> 'draft' then raise exception 'poll is not a draft' using errcode = '55000'; end if;
  if p_action = 'open' and poll.state not in ('draft', 'scheduled') then raise exception 'poll cannot be opened' using errcode = '55000'; end if;
  if p_action in ('close', 'archive') and poll.state <> 'open' then raise exception 'poll is not open' using errcode = '55000'; end if;
  if p_action = 'cancel' and poll.state not in ('draft', 'scheduled', 'open') then raise exception 'poll cannot be cancelled' using errcode = '55000'; end if;
  update public.organization_live_polls
  set state = next_state,
      opens_at = case when p_action = 'open' then coalesce(opens_at, pg_catalog.now()) else opens_at end,
      closed_at = case when next_state in ('closed', 'cancelled') then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
  where id = poll.id returning * into poll;
  perform private.recalculate_organization_live_poll(poll.id);
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'runId', poll.id, 'status', next_state,
    'reasonCode', 'live_poll_' || p_action, 'count', poll.vote_count
  ));
  return pg_catalog.jsonb_build_object(
    'id', poll.id, 'state', next_state, 'opensAt', poll.opens_at,
    'closesAt', poll.closes_at, 'closedAt', poll.closed_at
  );
end;
$function$;

create function public.set_organization_live_poll_roster(
  p_poll_id uuid,
  p_user_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  added integer;
begin
  perform private.engagement_require_staff(org);
  if not exists (
    select 1 from public.organization_live_polls p
    where p.id = p_poll_id and p.organization_id = org and p.state in ('draft', 'scheduled', 'open')
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  if exists (
    select 1 from pg_catalog.unnest(coalesce(p_user_ids, '{}'::uuid[])) actor(user_id)
    where not private.engagement_user_in_organization(org, actor.user_id)
  ) then raise exception 'roster contains a non-member' using errcode = '42501'; end if;
  insert into public.organization_live_poll_attendance (
    organization_id, poll_id, user_id
  )
  select org, p_poll_id, actor.user_id
  from pg_catalog.unnest(coalesce(p_user_ids, '{}'::uuid[])) actor(user_id)
  on conflict (poll_id, user_id) do update set eligible = true, updated_at = pg_catalog.now();
  get diagnostics added = row_count;
  return pg_catalog.jsonb_build_object('pollId', p_poll_id, 'rosterCount', added);
end;
$function$;

create function public.rsvp_organization_live_poll(p_poll_id uuid, p_rsvp text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if p_rsvp not in ('yes', 'no', 'maybe') then raise exception 'invalid rsvp' using errcode = '22023'; end if;
  if not exists (
    select 1 from public.organization_live_polls p
    where p.id = p_poll_id and p.organization_id = org and p.state in ('scheduled', 'open')
      and (p.chapter_id is null or p.chapter_id = private.current_member_chapter())
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  insert into public.organization_live_poll_attendance (
    organization_id, poll_id, user_id, rsvp
  ) values (org, p_poll_id, actor, p_rsvp)
  on conflict (poll_id, user_id) do update set rsvp = excluded.rsvp, updated_at = pg_catalog.now();
  return pg_catalog.jsonb_build_object('pollId', p_poll_id, 'rsvp', p_rsvp);
end;
$function$;

create function public.check_in_organization_live_poll(
  p_poll_id uuid,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  target uuid := coalesce(p_user_id, actor);
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if target <> actor then perform private.engagement_require_staff(org); end if;
  if not private.engagement_user_in_organization(org, target) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.organization_live_polls p
    where p.id = p_poll_id and p.organization_id = org and p.state in ('scheduled', 'open')
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  insert into public.organization_live_poll_attendance (
    organization_id, poll_id, user_id, eligible, rsvp, checked_in_at, check_in_actor
  ) values (org, p_poll_id, target, true, 'yes', pg_catalog.now(), actor)
  on conflict (poll_id, user_id) do update
    set checked_in_at = pg_catalog.now(), check_in_actor = actor,
        rsvp = case when public.organization_live_poll_attendance.rsvp = 'no' then 'yes' else public.organization_live_poll_attendance.rsvp end,
        updated_at = pg_catalog.now();
  return pg_catalog.jsonb_build_object('pollId', p_poll_id, 'userId', target, 'checkedIn', true);
end;
$function$;

create function public.cast_organization_live_poll_vote(
  p_poll_id uuid,
  p_option_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  poll public.organization_live_polls%rowtype;
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  select * into poll from public.organization_live_polls
  where id = p_poll_id and organization_id = org for update;
  if not found or poll.state <> 'open'
     or (poll.closes_at is not null and poll.closes_at <= pg_catalog.now())
     or (poll.chapter_id is not null and poll.chapter_id <> private.current_member_chapter()) then
    raise exception 'poll is not open' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.organization_live_poll_options option
    where option.id = p_option_id and option.poll_id = poll.id and option.organization_id = org
  ) then raise exception 'invalid poll option' using errcode = '22023'; end if;
  if poll.eligibility = 'roster' and not exists (
    select 1 from public.organization_live_poll_attendance attendance
    where attendance.poll_id = poll.id and attendance.user_id = actor
      and attendance.eligible and attendance.checked_in_at is not null
  ) then raise exception 'check-in required' using errcode = '42501'; end if;
  insert into public.organization_live_poll_votes (
    organization_id, poll_id, option_id, voter_user_id
  ) values (org, poll.id, p_option_id, actor)
  on conflict (poll_id, voter_user_id) do update
    set option_id = excluded.option_id, updated_at = pg_catalog.now();
  return pg_catalog.jsonb_build_object('pollId', poll.id, 'voted', true);
end;
$function$;

-- -------------------------------------------------------------------------
-- Broadcast outbox, presence, channel controls, and Compass actions
-- -------------------------------------------------------------------------

create function private.queue_member_broadcast_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.organization_id is null then return new; end if;
  insert into public.engagement_delivery_outbox (
    organization_id, recipient_user_id, delivery_kind, source_kind, source_id, locale
  )
  select new.organization_id, membership.user_id, 'broadcast', 'broadcast', new.id, new.locale
  from public.organization_memberships membership
  left join public.member_profiles profile on profile.id = membership.user_id
  where membership.organization_id = new.organization_id
    and membership.status = 'active'
    and membership.revoked_at is null
    and (new.audience_scope = 'organization' or profile.chapter_id = new.chapter_id)
  on conflict (delivery_kind, source_id, recipient_user_id) do nothing;
  return new;
end;
$function$;

create trigger member_broadcasts_queue_delivery
after insert on public.member_broadcasts
for each row execute function private.queue_member_broadcast_delivery();

revoke all on function private.queue_member_broadcast_delivery() from public, anon, authenticated, service_role;

create function public.claim_engagement_delivery_batch(
  p_lease_token uuid,
  p_limit integer default 25,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claimed jsonb;
begin
  if p_lease_token is null
     or p_limit not between 1 and 100
     or p_lease_seconds not between 30 and 900 then
    raise exception 'invalid delivery lease request' using errcode = '22023';
  end if;
  with candidates as (
    select outbox.id
    from public.engagement_delivery_outbox outbox
    where (
      outbox.state in ('queued', 'failed')
      or (outbox.state = 'leased' and outbox.lease_expires_at < pg_catalog.now())
    )
      and outbox.available_at <= pg_catalog.now()
      and outbox.attempt_count < 20
    order by outbox.available_at, outbox.created_at, outbox.id
    for update skip locked
    limit p_limit
  ), leased as (
    update public.engagement_delivery_outbox outbox
    set state = 'leased', lease_token = p_lease_token,
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
        attempt_count = outbox.attempt_count + 1,
        updated_at = pg_catalog.now()
    from candidates
    where outbox.id = candidates.id
    returning outbox.*
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', leased.id,
    'organizationId', leased.organization_id,
    'recipientUserId', leased.recipient_user_id,
    'deliveryKind', leased.delivery_kind,
    'sourceKind', leased.source_kind,
    'sourceId', leased.source_id,
    'locale', leased.locale,
    'attemptCount', leased.attempt_count
  ) order by leased.created_at, leased.id), '[]'::jsonb)
  into claimed from leased;
  return claimed;
end;
$function$;

create function public.get_engagement_delivery_payload(
  p_delivery_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  row public.engagement_delivery_outbox%rowtype;
  email text;
  title text;
  body text;
begin
  select * into row from public.engagement_delivery_outbox
  where id = p_delivery_id and state = 'leased' and lease_token = p_lease_token
    and lease_expires_at >= pg_catalog.now();
  if not found then raise exception 'delivery lease not found' using errcode = 'P0002'; end if;
  select user_row.email into email from auth.users user_row where user_row.id = row.recipient_user_id;
  if row.source_kind = 'broadcast' then
    select broadcast.title, broadcast.body into title, body
    from public.member_broadcasts broadcast
    where broadcast.id = row.source_id
      and broadcast.organization_id = row.organization_id
      and broadcast.retracted_at is null;
  else
    select survey.title,
      case row.delivery_kind
        when 'survey_reminder' then 'A survey is still waiting for your response in Union Ground.'
        else 'A survey is ready for you in Union Ground.'
      end
    into title, body
    from public.organization_surveys survey
    where survey.id = row.source_id::uuid
      and survey.organization_id = row.organization_id
      and survey.status = 'open';
  end if;
  if email is null or title is null then
    return pg_catalog.jsonb_build_object('available', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'available', true,
    'email', email,
    'locale', row.locale,
    'subject', title,
    'body', body,
    'path', case when row.source_kind = 'survey' then '/m/voice?survey=' || row.source_id else '/m/messages?broadcast=' || row.source_id end
  );
end;
$function$;

create function public.complete_engagement_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_success boolean,
  p_error_code text default null,
  p_retry_after_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  row public.engagement_delivery_outbox%rowtype;
begin
  if not p_success and pg_catalog.lower(pg_catalog.btrim(coalesce(p_error_code, ''))) !~ '^[a-z0-9._:-]{1,80}$' then
    raise exception 'bounded error code required' using errcode = '22023';
  end if;
  if p_retry_after_seconds not between 60 and 86400 then
    raise exception 'invalid retry delay' using errcode = '22023';
  end if;
  update public.engagement_delivery_outbox outbox
  set state = case when p_success then 'sent' else 'failed' end,
      sent_at = case when p_success then pg_catalog.now() else null end,
      last_error_code = case when p_success then null else pg_catalog.lower(pg_catalog.btrim(p_error_code)) end,
      available_at = case when p_success then outbox.available_at else pg_catalog.now() + pg_catalog.make_interval(secs => p_retry_after_seconds) end,
      lease_token = null, lease_expires_at = null, updated_at = pg_catalog.now()
  where id = p_delivery_id and state = 'leased' and lease_token = p_lease_token
  returning * into row;
  if not found then raise exception 'delivery lease not found' using errcode = 'P0002'; end if;
  if row.source_kind = 'survey' then
    update public.organization_survey_deliveries
    set state = case when p_success then 'sent' else 'failed' end,
        attempt_count = row.attempt_count,
        last_attempt_at = pg_catalog.now(),
        sent_at = case when p_success then coalesce(sent_at, pg_catalog.now()) else sent_at end,
        last_error_code = row.last_error_code,
        updated_at = pg_catalog.now()
    where survey_id = row.source_id::uuid and recipient_user_id = row.recipient_user_id;
  end if;
  return pg_catalog.jsonb_build_object('id', row.id, 'state', row.state);
end;
$function$;

revoke all on function public.claim_engagement_delivery_batch(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.get_engagement_delivery_payload(uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_engagement_delivery(uuid, uuid, boolean, text, integer) from public, anon, authenticated;
grant execute on function public.claim_engagement_delivery_batch(uuid, integer, integer) to service_role;
grant execute on function public.get_engagement_delivery_payload(uuid, uuid) to service_role;
grant execute on function public.complete_engagement_delivery(uuid, uuid, boolean, text, integer) to service_role;

create function public.heartbeat_member_presence(p_status text default 'online')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if p_status not in ('online', 'away', 'offline') then raise exception 'invalid presence status' using errcode = '22023'; end if;
  insert into public.member_presence (organization_id, user_id, last_seen_at, status)
  values (org, actor, pg_catalog.now(), p_status)
  on conflict (organization_id, user_id) do update
    set last_seen_at = pg_catalog.now(), status = excluded.status;
  return pg_catalog.jsonb_build_object('status', p_status, 'lastSeenAt', pg_catalog.now());
end;
$function$;

create function public.set_chapter_space_controls(
  p_space_id uuid,
  p_posting_mode text,
  p_slow_mode_seconds integer,
  p_approvals_required boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  space public.chapter_spaces%rowtype;
begin
  perform private.engagement_require_staff(org);
  select * into space from public.chapter_spaces where id = p_space_id;
  if not found or not private.mi1_w2_same_org_chapter(org, space.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_posting_mode not in ('members', 'staff_only', 'read_only')
     or p_slow_mode_seconds not between 0 and 86400 then
    raise exception 'invalid channel controls' using errcode = '22023';
  end if;
  insert into public.chapter_space_controls (
    organization_id, space_id, posting_mode, slow_mode_seconds, approvals_required, updated_by
  ) values (org, space.id, p_posting_mode, p_slow_mode_seconds, coalesce(p_approvals_required, false), (select auth.uid()))
  on conflict (space_id) do update
    set posting_mode = excluded.posting_mode,
        slow_mode_seconds = excluded.slow_mode_seconds,
        approvals_required = excluded.approvals_required,
        updated_by = excluded.updated_by,
        updated_at = pg_catalog.now();
  return pg_catalog.jsonb_build_object(
    'spaceId', space.id, 'postingMode', p_posting_mode,
    'slowModeSeconds', p_slow_mode_seconds,
    'approvalsRequired', coalesce(p_approvals_required, false)
  );
end;
$function$;

create function public.set_chapter_space_preference(
  p_space_id uuid,
  p_muted boolean,
  p_notifications text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if p_notifications not in ('all', 'mentions', 'none') then raise exception 'invalid notification preference' using errcode = '22023'; end if;
  if not exists (
    select 1 from public.chapter_spaces s
    where s.id = p_space_id and private.can_read_chapter_space(s)
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  insert into public.chapter_space_preferences (
    organization_id, space_id, user_id, muted, notifications
  ) values (org, p_space_id, actor, coalesce(p_muted, false), p_notifications)
  on conflict (space_id, user_id) do update
    set muted = excluded.muted, notifications = excluded.notifications, updated_at = pg_catalog.now();
  return pg_catalog.jsonb_build_object(
    'spaceId', p_space_id, 'muted', coalesce(p_muted, false), 'notifications', p_notifications
  );
end;
$function$;

create function public.propose_compass_workspace_action(
  p_source_kind text,
  p_source_id text,
  p_title text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  created public.compass_workspace_actions%rowtype;
begin
  perform private.engagement_require_staff(org);
  if p_source_kind not in ('message', 'broadcast', 'notification', 'survey', 'case') then
    raise exception 'invalid action source' using errcode = '22023';
  end if;
  insert into public.compass_workspace_actions (
    organization_id, actor_user_id, action_kind, source_kind, source_id, title
  ) values (
    org, actor, 'create_task', p_source_kind,
    pg_catalog.btrim(coalesce(p_source_id, '')),
    pg_catalog.btrim(coalesce(p_title, ''))
  ) returning * into created;
  return pg_catalog.jsonb_build_object(
    'id', created.id, 'actionKind', created.action_kind,
    'sourceKind', created.source_kind, 'sourceId', created.source_id,
    'title', created.title, 'state', created.state
  );
end;
$function$;

create function public.decide_compass_workspace_action(
  p_action_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  action_row public.compass_workspace_actions%rowtype;
  task_result jsonb;
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  select * into action_row from public.compass_workspace_actions
  where id = p_action_id and organization_id = org and actor_user_id = actor
  for update;
  if not found or action_row.state <> 'proposed' then
    raise exception 'action is not pending' using errcode = '55000';
  end if;
  if p_decision = 'reject' then
    update public.compass_workspace_actions
    set state = 'rejected', decided_at = pg_catalog.now()
    where id = action_row.id;
    return pg_catalog.jsonb_build_object('id', action_row.id, 'state', 'rejected');
  end if;
  if p_decision <> 'confirm' then raise exception 'invalid action decision' using errcode = '22023'; end if;
  begin
    task_result := public.create_chapter_task_from_source(action_row.source_kind, action_row.source_id);
    update public.compass_workspace_actions
    set state = 'confirmed',
        result_task_id = nullif(task_result #>> '{task,id}', '')::uuid,
        decided_at = pg_catalog.now()
    where id = action_row.id;
  exception when others then
    update public.compass_workspace_actions
    set state = 'failed', decided_at = pg_catalog.now()
    where id = action_row.id;
    return pg_catalog.jsonb_build_object(
      'id', action_row.id, 'state', 'failed', 'taskId', null
    );
  end;
  return pg_catalog.jsonb_build_object(
    'id', action_row.id, 'state', 'confirmed',
    'taskId', task_result #>> '{task,id}', 'task', task_result -> 'task'
  );
end;
$function$;

-- SECURITY INVOKER is deliberate: the three message tables keep their own
-- participant/channel/task RLS. This helper only shapes rows already visible
-- to the caller and caps the context sent to the governed AI endpoint.
create function public.get_message_briefing_context(
  p_source_kind text,
  p_target_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  messages jsonb;
begin
  if p_source_kind = 'private' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', row.id, 'actor', row.sender_kind, 'body', row.body, 'createdAt', row.created_at
    ) order by row.created_at, row.id), '[]'::jsonb)
    into messages
    from (
      select message.id, message.sender_kind, message.body, message.created_at
      from public.member_messages message
      where message.conversation_id = p_target_id
      order by message.created_at desc, message.id desc
      limit 40
    ) row;
  elsif p_source_kind = 'channel' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', row.id, 'actor', row.author_id, 'body', row.body, 'createdAt', row.created_at
    ) order by row.created_at, row.id), '[]'::jsonb)
    into messages
    from (
      select post.id, post.author_id, post.body, post.created_at
      from public.chapter_thread_posts post
      where post.thread_id = p_target_id
      order by post.created_at desc, post.id desc
      limit 40
    ) row;
  elsif p_source_kind = 'task' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', row.id, 'actor', row.sender_id, 'body', row.body, 'createdAt', row.created_at
    ) order by row.created_at, row.id), '[]'::jsonb)
    into messages
    from (
      select message.id, message.sender_id, message.body, message.created_at
      from public.chapter_task_messages message
      where message.task_id = p_target_id
      order by message.created_at desc, message.id desc
      limit 40
    ) row;
  else
    raise exception 'invalid message briefing source' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(messages) = 0 then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object('sourceKind', p_source_kind, 'targetId', p_target_id, 'messages', messages);
end;
$function$;

create function public.save_chapter_space_keyword_monitor(
  p_space_id uuid,
  p_keyword text,
  p_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  clean_keyword text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_keyword, '')));
  saved public.chapter_space_keyword_monitors%rowtype;
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_keyword) not between 2 and 80 or clean_keyword ~ '[[:cntrl:]]' then
    raise exception 'keyword must be between 2 and 80 characters' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.chapter_spaces s
    where s.id = p_space_id and private.can_read_chapter_space(s)
      and private.mi1_w2_same_org_chapter(org, s.chapter_id)
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  insert into public.chapter_space_keyword_monitors (
    organization_id, space_id, user_id, keyword, active
  ) values (org, p_space_id, actor, clean_keyword, coalesce(p_active, true))
  on conflict (space_id, user_id, keyword) do update
    set active = excluded.active
  returning * into saved;
  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'spaceId', saved.space_id,
    'keyword', saved.keyword, 'active', saved.active
  );
end;
$function$;

create function private.capture_chapter_space_keyword_hits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  select c.organization_id into org
  from public.chapters c where c.id = new.chapter_id;
  if org is null then return new; end if;
  insert into public.chapter_space_keyword_hits (
    organization_id, monitor_id, user_id, space_id, post_id
  )
  select org, monitor.id, monitor.user_id, thread.space_id, new.id
  from public.chapter_threads thread
  join public.chapter_space_keyword_monitors monitor on monitor.space_id = thread.space_id
  where thread.id = new.thread_id
    and monitor.organization_id = org
    and monitor.active
    and monitor.user_id <> new.author_id
    and pg_catalog.strpos(pg_catalog.lower(new.body), monitor.keyword) > 0
  on conflict (monitor_id, post_id) do nothing;
  return new;
end;
$function$;

create trigger chapter_thread_posts_capture_keyword_hits
after insert on public.chapter_thread_posts
for each row execute function private.capture_chapter_space_keyword_hits();

revoke all on function private.capture_chapter_space_keyword_hits() from public, anon, authenticated, service_role;

create function public.mark_chapter_space_keyword_hit_read(p_hit_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  changed public.chapter_space_keyword_hits%rowtype;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  update public.chapter_space_keyword_hits
  set read_at = coalesce(read_at, pg_catalog.now())
  where id = p_hit_id and user_id = actor
  returning * into changed;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  return pg_catalog.jsonb_build_object('id', changed.id, 'readAt', changed.read_at);
end;
$function$;

create function public.save_compass_workspace_preferences(
  p_module_order jsonb,
  p_hidden_modules jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  allowed text[] := array['inbox', 'surveys', 'polls', 'tasks', 'cases', 'calendar'];
  saved public.compass_workspace_preferences%rowtype;
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_module_order) <> 'array'
     or pg_catalog.jsonb_array_length(p_module_order) not between 1 and 6
     or pg_catalog.jsonb_typeof(p_hidden_modules) <> 'array'
     or pg_catalog.jsonb_array_length(p_hidden_modules) > 6
     or exists (
       select 1 from pg_catalog.jsonb_array_elements_text(p_module_order) module(value)
       where not module.value = any(allowed)
     )
     or exists (
       select 1 from pg_catalog.jsonb_array_elements_text(p_hidden_modules) module(value)
       where not module.value = any(allowed)
     )
     or (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements_text(p_module_order))
        <> (select pg_catalog.count(distinct module.value) from pg_catalog.jsonb_array_elements_text(p_module_order) module(value)) then
    raise exception 'invalid workspace module selection' using errcode = '22023';
  end if;
  insert into public.compass_workspace_preferences (
    organization_id, user_id, module_order, hidden_modules
  ) values (org, actor, p_module_order, p_hidden_modules)
  on conflict (organization_id, user_id) do update
    set module_order = excluded.module_order,
        hidden_modules = excluded.hidden_modules,
        updated_at = pg_catalog.now()
  returning * into saved;
  return pg_catalog.jsonb_build_object(
    'moduleOrder', saved.module_order,
    'hiddenModules', saved.hidden_modules,
    'updatedAt', saved.updated_at
  );
end;
$function$;

create function public.persist_compass_message_briefing(
  p_source_kind text,
  p_target_id uuid,
  p_summary text,
  p_action_items jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  saved public.compass_message_briefings%rowtype;
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if not private.engagement_can_read_message_target(p_source_kind, p_target_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_summary, ''))) not between 1 and 4000
     or pg_catalog.jsonb_typeof(p_action_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_action_items) > 12 then
    raise exception 'invalid briefing result' using errcode = '22023';
  end if;
  insert into public.compass_message_briefings (
    organization_id, requested_by, source_kind, target_id, summary, action_items
  ) values (
    org, actor, p_source_kind, p_target_id,
    pg_catalog.btrim(p_summary), p_action_items
  ) returning * into saved;
  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'sourceKind', saved.source_kind,
    'targetId', saved.target_id, 'summary', saved.summary,
    'actionItems', saved.action_items, 'createdAt', saved.created_at
  );
end;
$function$;

create function public.get_member_engagement_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  actor_chapter text := private.current_member_chapter();
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'quarterlyGate', public.get_quarterly_survey_gate(),
    'surveys', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', survey.id,
        'title', survey.title,
        'description', survey.description,
        'cadence', survey.cadence,
        'periodKey', survey.period_key,
        'opensAt', survey.opens_at,
        'closesAt', survey.closes_at,
        'session', case when session.id is null then null else pg_catalog.jsonb_build_object(
          'id', session.id, 'status', session.status,
          'updatedAt', session.updated_at, 'submittedAt', session.submitted_at,
          'answers', coalesce((
            select pg_catalog.jsonb_object_agg(answer.question_id::text, answer.value)
            from public.organization_survey_answers answer
            where answer.session_id = session.id and answer.organization_id = org
          ), '{}'::jsonb)
        ) end,
        'questions', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', question.id, 'sortIndex', question.sort_index,
            'type', question.question_type, 'label', question.label,
            'required', question.required, 'options', question.options,
            'sectionKey', question.section_key, 'sectionTitle', question.section_title,
            'branchParentId', question.branch_parent_id, 'branchValue', question.branch_value,
            'scaleMinLabel', question.scale_min_label, 'scaleMaxLabel', question.scale_max_label,
            'maxSelections', question.max_selections
          ) order by question.sort_index)
          from public.organization_survey_questions question
          where question.survey_id = survey.id and question.organization_id = org
        ), '[]'::jsonb)
      ) order by survey.closes_at nulls last, survey.updated_at desc)
      from public.organization_surveys survey
      left join public.organization_survey_sessions session
        on session.survey_id = survey.id and session.respondent_user_id = actor
      where survey.organization_id = org
        and survey.status = 'open'
        and (survey.chapter_id is null or survey.chapter_id = actor_chapter)
        and (survey.opens_at is null or survey.opens_at <= pg_catalog.now())
        and (survey.closes_at is null or survey.closes_at > pg_catalog.now())
    ), '[]'::jsonb),
    'pulsePrompts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', event.id, 'promptId', prompt.id,
        'eventKey', prompt.event_key, 'question', prompt.question,
        'options', prompt.options, 'contextKey', event.context_key,
        'shownAt', event.shown_at
      ) order by event.shown_at desc)
      from public.organization_pulse_events event
      join public.organization_pulse_prompts prompt on prompt.id = event.prompt_id
      where event.organization_id = org and event.user_id = actor and event.state = 'shown'
    ), '[]'::jsonb),
    'livePolls', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', poll.id, 'title', poll.title, 'description', poll.description,
        'state', poll.state, 'eligibility', poll.eligibility,
        'resultsVisibility', poll.results_visibility,
        'scheduledAt', poll.scheduled_at, 'opensAt', poll.opens_at,
        'closesAt', poll.closes_at, 'closedAt', poll.closed_at,
        'quorumTarget', poll.quorum_target, 'voteCount', poll.vote_count,
        'results', case
          when poll.results_visibility = 'live'
            or (poll.results_visibility = 'after_close' and poll.state = 'closed')
            then poll.result_cache else '[]'::jsonb end,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', option.id, 'label', option.label, 'sortIndex', option.sort_index
          ) order by option.sort_index)
          from public.organization_live_poll_options option where option.poll_id = poll.id
        ), '[]'::jsonb),
        'attendance', case when attendance.user_id is null then null else pg_catalog.jsonb_build_object(
          'eligible', attendance.eligible, 'rsvp', attendance.rsvp,
          'checkedInAt', attendance.checked_in_at
        ) end,
        'selectedOptionId', vote.option_id
      ) order by coalesce(poll.opens_at, poll.scheduled_at, poll.created_at) desc)
      from public.organization_live_polls poll
      left join public.organization_live_poll_attendance attendance
        on attendance.poll_id = poll.id and attendance.user_id = actor
      left join public.organization_live_poll_votes vote
        on vote.poll_id = poll.id and vote.voter_user_id = actor
      where poll.organization_id = org
        and poll.state in ('scheduled', 'open', 'closed')
        and (poll.chapter_id is null or poll.chapter_id = actor_chapter)
        and (poll.closed_at is null or poll.closed_at >= pg_catalog.now() - interval '90 days')
    ), '[]'::jsonb),
    'workspace', coalesce((
      select pg_catalog.jsonb_build_object(
        'moduleOrder', preference.module_order,
        'hiddenModules', preference.hidden_modules,
        'updatedAt', preference.updated_at
      )
      from public.compass_workspace_preferences preference
      where preference.organization_id = org and preference.user_id = actor
    ), pg_catalog.jsonb_build_object(
      'moduleOrder', '["inbox","surveys","tasks","cases"]'::jsonb,
      'hiddenModules', '[]'::jsonb
    )),
    'actions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', action.id, 'actionKind', action.action_kind,
        'sourceKind', action.source_kind, 'sourceId', action.source_id,
        'title', action.title, 'state', action.state,
        'resultTaskId', action.result_task_id, 'createdAt', action.created_at
      ) order by action.created_at desc)
      from public.compass_workspace_actions action
      where action.organization_id = org and action.actor_user_id = actor
        and action.state in ('proposed', 'failed')
    ), '[]'::jsonb),
    'keywordHits', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', hit.id, 'spaceId', hit.space_id, 'postId', hit.post_id,
        'keyword', monitor.keyword, 'createdAt', hit.created_at
      ) order by hit.created_at desc)
      from (
        select * from public.chapter_space_keyword_hits candidate
        where candidate.organization_id = org
          and candidate.user_id = actor
          and candidate.read_at is null
        order by candidate.created_at desc
        limit 20
      ) hit
      join public.chapter_space_keyword_monitors monitor on monitor.id = hit.monitor_id
    ), '[]'::jsonb),
    'briefings', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', briefing.id, 'sourceKind', briefing.source_kind,
        'targetId', briefing.target_id, 'summary', briefing.summary,
        'actionItems', briefing.action_items, 'createdAt', briefing.created_at
      ) order by briefing.created_at desc)
      from (
        select * from public.compass_message_briefings saved
        where saved.organization_id = org and saved.requested_by = actor
        order by saved.created_at desc limit 10
      ) briefing
    ), '[]'::jsonb)
  );
end;
$function$;

create function public.get_staff_engagement_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
begin
  perform private.engagement_require_staff(org);
  return pg_catalog.jsonb_build_object(
    'surveys', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', survey.id, 'title', survey.title, 'status', survey.status,
        'cadence', survey.cadence, 'periodKey', survey.period_key,
        'privacyMinResponses', survey.privacy_min_responses,
        'operationsState', survey.operations_state, 'ownerUserId', survey.owner_user_id,
        'opensAt', survey.opens_at, 'closesAt', survey.closes_at,
        'reviewDueAt', survey.review_due_at,
        'coverage', pg_catalog.jsonb_build_object(
          'total', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id),
          'sent', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id and delivery.state in ('sent', 'engaged')),
          'engaged', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id and delivery.state = 'engaged'),
          'failed', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id and delivery.state = 'failed')
        ),
        'tasks', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', task.id, 'reason', task.reason, 'status', task.status,
            'assignedTo', task.assigned_to, 'dueAt', task.due_at
          ) order by task.created_at)
          from public.organization_survey_tasks task where task.survey_id = survey.id
        ), '[]'::jsonb),
        'reviewCounts', coalesce((
          select pg_catalog.jsonb_object_agg(counts.state, counts.count)
          from (
            select review.state, pg_catalog.count(*)::integer as count
            from public.organization_survey_reviews review
            where review.survey_id = survey.id group by review.state
          ) counts
        ), '{}'::jsonb),
        'reviews', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', review.id, 'sessionId', review.session_id,
            'state', review.state, 'assignedTo', review.assigned_to,
            'disposition', review.disposition,
            'followUpDueAt', review.follow_up_due_at,
            'createdAt', review.created_at
          ) order by review.created_at desc)
          from public.organization_survey_reviews review
          where review.survey_id = survey.id
        ), '[]'::jsonb),
        'questions', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', question.id, 'sortIndex', question.sort_index,
            'type', question.question_type, 'label', question.label,
            'required', question.required, 'options', question.options,
            'sectionKey', question.section_key, 'sectionTitle', question.section_title,
            'branchParentId', question.branch_parent_id,
            'branchValue', question.branch_value
          ) order by question.sort_index)
          from public.organization_survey_questions question
          where question.survey_id = survey.id
        ), '[]'::jsonb)
      ) order by survey.updated_at desc)
      from public.organization_surveys survey where survey.organization_id = org
    ), '[]'::jsonb),
    'pulsePrompts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', prompt.id, 'chapterId', prompt.chapter_id,
        'eventKey', prompt.event_key, 'question', prompt.question,
        'options', prompt.options, 'active', prompt.active,
        'cooldownHours', prompt.cooldown_hours,
        'shown', (select pg_catalog.count(*) from public.organization_pulse_events event where event.prompt_id = prompt.id),
        'responded', (select pg_catalog.count(*) from public.organization_pulse_events event where event.prompt_id = prompt.id and event.state = 'responded')
      ) order by prompt.updated_at desc)
      from public.organization_pulse_prompts prompt where prompt.organization_id = org
    ), '[]'::jsonb),
    'livePolls', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', poll.id, 'title', poll.title, 'description', poll.description,
        'state', poll.state, 'eligibility', poll.eligibility,
        'resultsVisibility', poll.results_visibility,
        'scheduledAt', poll.scheduled_at, 'opensAt', poll.opens_at,
        'closesAt', poll.closes_at, 'closedAt', poll.closed_at,
        'quorumTarget', poll.quorum_target, 'voteCount', poll.vote_count,
        'results', poll.result_cache,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', option.id, 'label', option.label, 'sortIndex', option.sort_index
          ) order by option.sort_index)
          from public.organization_live_poll_options option where option.poll_id = poll.id
        ), '[]'::jsonb),
        'attendance', pg_catalog.jsonb_build_object(
          'roster', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.eligible),
          'rsvpYes', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.rsvp = 'yes'),
          'checkedIn', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.checked_in_at is not null)
        )
      ) order by coalesce(poll.opens_at, poll.scheduled_at, poll.created_at) desc)
      from public.organization_live_polls poll where poll.organization_id = org
    ), '[]'::jsonb),
    'delivery', coalesce((
      select pg_catalog.jsonb_object_agg(summary.state, summary.count)
      from (
        select outbox.state, pg_catalog.count(*)::integer as count
        from public.engagement_delivery_outbox outbox
        where outbox.organization_id = org group by outbox.state
      ) summary
    ), '{}'::jsonb),
    'presence', pg_catalog.jsonb_build_object(
      'online', (select pg_catalog.count(*) from public.member_presence presence where presence.organization_id = org and presence.status = 'online' and presence.last_seen_at >= pg_catalog.now() - interval '2 minutes'),
      'away', (select pg_catalog.count(*) from public.member_presence presence where presence.organization_id = org and presence.last_seen_at >= pg_catalog.now() - interval '15 minutes')
    ),
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', membership.user_id,
        'name', coalesce(profile.full_name, 'Member'),
        'chapterId', profile.chapter_id
      ) order by coalesce(profile.full_name, ''), membership.user_id)
      from public.organization_memberships membership
      left join public.member_profiles profile on profile.id = membership.user_id
      where membership.organization_id = org
        and membership.status = 'active' and membership.revoked_at is null
    ), '[]'::jsonb),
    'channels', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'spaceId', space.id, 'name', space.name,
        'postingMode', coalesce(control.posting_mode, 'members'),
        'slowModeSeconds', coalesce(control.slow_mode_seconds, 0),
        'approvalsRequired', coalesce(control.approvals_required, false),
        'monitorCount', (select pg_catalog.count(*) from public.chapter_space_keyword_monitors monitor where monitor.space_id = space.id and monitor.active)
      ) order by space.name, space.id)
      from public.chapter_spaces space
      join public.chapters chapter on chapter.id = space.chapter_id and chapter.organization_id = org
      left join public.chapter_space_controls control on control.space_id = space.id
      where space.archived_at is null
    ), '[]'::jsonb)
  );
end;
$function$;

-- PUBLIC execute is implicit for new functions in Postgres, so close every
-- browser-callable surface explicitly and reopen only the authenticated role.
revoke all on function public.configure_organization_survey_operations(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.prepare_organization_survey_distribution(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.queue_organization_survey_reminders(uuid) from public, anon, authenticated;
revoke all on function public.update_organization_survey_task(uuid, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.update_organization_survey_review(uuid, text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.get_organization_survey_review_detail(uuid) from public, anon, authenticated;
revoke all on function public.get_quarterly_survey_gate() from public, anon, authenticated;
revoke all on function public.get_organization_survey_report(uuid) from public, anon, authenticated;
revoke all on function public.export_organization_survey_results(uuid) from public, anon, authenticated;
revoke all on function public.save_organization_pulse_prompt(jsonb) from public, anon, authenticated;
revoke all on function public.evaluate_contextual_pulse(text, text) from public, anon, authenticated;
revoke all on function public.respond_contextual_pulse(uuid, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.save_organization_live_poll(jsonb) from public, anon, authenticated;
revoke all on function public.transition_organization_live_poll(uuid, text) from public, anon, authenticated;
revoke all on function public.set_organization_live_poll_roster(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.rsvp_organization_live_poll(uuid, text) from public, anon, authenticated;
revoke all on function public.check_in_organization_live_poll(uuid, uuid) from public, anon, authenticated;
revoke all on function public.cast_organization_live_poll_vote(uuid, uuid) from public, anon, authenticated;
revoke all on function public.heartbeat_member_presence(text) from public, anon, authenticated;
revoke all on function public.set_chapter_space_controls(uuid, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.set_chapter_space_preference(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.propose_compass_workspace_action(text, text, text) from public, anon, authenticated;
revoke all on function public.decide_compass_workspace_action(uuid, text) from public, anon, authenticated;
revoke all on function public.get_message_briefing_context(text, uuid) from public, anon, authenticated;
revoke all on function public.save_chapter_space_keyword_monitor(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.mark_chapter_space_keyword_hit_read(uuid) from public, anon, authenticated;
revoke all on function public.save_compass_workspace_preferences(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.persist_compass_message_briefing(text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.get_member_engagement_snapshot() from public, anon, authenticated;
revoke all on function public.get_staff_engagement_snapshot() from public, anon, authenticated;

grant execute on function public.configure_organization_survey_operations(uuid, jsonb) to authenticated;
grant execute on function public.prepare_organization_survey_distribution(uuid, uuid[]) to authenticated;
grant execute on function public.queue_organization_survey_reminders(uuid) to authenticated;
grant execute on function public.update_organization_survey_task(uuid, text, uuid, timestamptz) to authenticated;
grant execute on function public.update_organization_survey_review(uuid, text, uuid, text, timestamptz) to authenticated;
grant execute on function public.get_organization_survey_review_detail(uuid) to authenticated;
grant execute on function public.get_quarterly_survey_gate() to authenticated;
grant execute on function public.get_organization_survey_report(uuid) to authenticated;
grant execute on function public.export_organization_survey_results(uuid) to authenticated;
grant execute on function public.save_organization_pulse_prompt(jsonb) to authenticated;
grant execute on function public.evaluate_contextual_pulse(text, text) to authenticated;
grant execute on function public.respond_contextual_pulse(uuid, jsonb, boolean) to authenticated;
grant execute on function public.save_organization_live_poll(jsonb) to authenticated;
grant execute on function public.transition_organization_live_poll(uuid, text) to authenticated;
grant execute on function public.set_organization_live_poll_roster(uuid, uuid[]) to authenticated;
grant execute on function public.rsvp_organization_live_poll(uuid, text) to authenticated;
grant execute on function public.check_in_organization_live_poll(uuid, uuid) to authenticated;
grant execute on function public.cast_organization_live_poll_vote(uuid, uuid) to authenticated;
grant execute on function public.heartbeat_member_presence(text) to authenticated;
grant execute on function public.set_chapter_space_controls(uuid, text, integer, boolean) to authenticated;
grant execute on function public.set_chapter_space_preference(uuid, boolean, text) to authenticated;
grant execute on function public.propose_compass_workspace_action(text, text, text) to authenticated;
grant execute on function public.decide_compass_workspace_action(uuid, text) to authenticated;
grant execute on function public.get_message_briefing_context(text, uuid) to authenticated;
grant execute on function public.save_chapter_space_keyword_monitor(uuid, text, boolean) to authenticated;
grant execute on function public.mark_chapter_space_keyword_hit_read(uuid) to authenticated;
grant execute on function public.save_compass_workspace_preferences(jsonb, jsonb) to authenticated;
grant execute on function public.persist_compass_message_briefing(text, uuid, text, jsonb) to authenticated;
grant execute on function public.get_member_engagement_snapshot() to authenticated;
grant execute on function public.get_staff_engagement_snapshot() to authenticated;

notify pgrst, 'reload schema';
