-- CR-079 through CR-083: emergency rights, accommodations, HR contact,
-- post-provisioning onboarding, and mentorship.
--
-- Donor donor-baseline-20260721 was screened for
-- behavior only. This migration does not reuse donor credentials, project
-- identifiers, dependencies, tenant assumptions, service-role shortcuts,
-- seed identities, or migration history. Production remains valid with zero
-- organizations and no account is assigned fictional onboarding work.

set local lock_timeout = '5s';

create table public.member_emergency_checklists (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  scenario text not null check (scenario in ('disciplinary_meeting', 'pre_discipline_response', 'unsafe_work')),
  status text not null default 'draft' check (status in ('draft', 'alerted', 'resolved')),
  completed_steps smallint[] not null default '{}',
  notes text not null default '',
  alerted_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, member_user_id, scenario),
  constraint member_emergency_checklists_steps_bounded check (
    pg_catalog.cardinality(completed_steps) <= 16
    and completed_steps <@ array[0, 1, 2, 3]::smallint[]
  ),
  constraint member_emergency_checklists_notes_bounded check (
    pg_catalog.char_length(notes) <= 4000
    and pg_catalog.regexp_replace(notes, E'[\n\r\t]', '', 'g') !~ '[[:cntrl:]]'
  ),
  constraint member_emergency_checklists_lifecycle check (
    (status = 'draft' and resolved_at is null)
    or (status = 'alerted' and alerted_at is not null and resolved_at is null)
    or (status = 'resolved' and resolved_at is not null)
  )
);

create table public.member_accommodation_requests (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  request_type text not null check (request_type in ('schedule', 'equipment', 'workspace', 'leave', 'communication', 'remote_work', 'other')),
  description text not null,
  status text not null default 'submitted' check (status in ('submitted', 'under_review', 'approved', 'denied', 'withdrawn')),
  staff_note text not null default '',
  submitted_at timestamptz not null default pg_catalog.now(),
  resolved_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint member_accommodation_requests_description_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(description)) between 1 and 4000
    and pg_catalog.regexp_replace(description, E'[\n\r\t]', '', 'g') !~ '[[:cntrl:]]'
  ),
  constraint member_accommodation_requests_staff_note_bounded check (
    pg_catalog.char_length(staff_note) <= 2000
    and pg_catalog.regexp_replace(staff_note, E'[\n\r\t]', '', 'g') !~ '[[:cntrl:]]'
  ),
  constraint member_accommodation_requests_resolution_complete check (
    (status in ('submitted', 'under_review') and resolved_at is null)
    or (status in ('approved', 'denied', 'withdrawn') and resolved_at is not null)
  )
);

create table public.organization_hr_directory (
  organization_id uuid primary key references public.organizations(id) on update cascade on delete restrict,
  name text not null default '',
  title text not null default '',
  department text not null default '',
  email text not null default '',
  phone text not null default '',
  hours text not null default '',
  notes text not null default '',
  enabled boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_hr_directory_fields_bounded check (
    pg_catalog.char_length(name) <= 160
    and pg_catalog.char_length(title) <= 160
    and pg_catalog.char_length(department) <= 160
    and pg_catalog.char_length(email) <= 320
    and pg_catalog.char_length(phone) <= 80
    and pg_catalog.char_length(hours) <= 500
    and pg_catalog.char_length(notes) <= 2000
  ),
  constraint organization_hr_directory_email_shape check (
    email = '' or email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  )
);

create table public.member_hr_contacts (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  channel text not null check (channel in ('email', 'phone', 'meeting', 'letter', 'portal', 'other')),
  purpose text not null,
  disposition text not null check (disposition in ('planned', 'attempted', 'reached', 'follow_up_due', 'resolved')),
  note text not null default '',
  occurred_at timestamptz not null,
  follow_up_on date,
  created_at timestamptz not null default pg_catalog.now(),
  constraint member_hr_contacts_purpose_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(purpose)) between 1 and 240
    and purpose !~ '[[:cntrl:]]'
  ),
  constraint member_hr_contacts_note_bounded check (
    pg_catalog.char_length(note) <= 4000
    and pg_catalog.regexp_replace(note, E'[\n\r\t]', '', 'g') !~ '[[:cntrl:]]'
  ),
  constraint member_hr_contacts_followup_complete check (
    disposition <> 'follow_up_due' or follow_up_on is not null
  )
);

create table public.organization_onboarding_steps (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  title text not null,
  description text not null default '',
  position integer not null default 0 check (position between 0 and 1000),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, position),
  constraint organization_onboarding_steps_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 160 and title !~ '[[:cntrl:]]'
  ),
  constraint organization_onboarding_steps_description_bounded check (
    pg_catalog.char_length(description) <= 2000
    and pg_catalog.regexp_replace(description, E'[\n\r\t]', '', 'g') !~ '[[:cntrl:]]'
  )
);

create table public.member_onboarding_plans (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'completed')),
  completed_step_ids uuid[] not null default '{}',
  assigned_by uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, member_user_id),
  constraint member_onboarding_plans_completed_steps_bounded check (
    pg_catalog.cardinality(completed_step_ids) <= 100
  ),
  constraint member_onboarding_plans_lifecycle check (
    (status = 'not_started' and started_at is null and completed_at is null)
    or (status = 'in_progress' and started_at is not null and completed_at is null)
    or (status = 'completed' and started_at is not null and completed_at is not null)
  )
);

create table public.member_mentorship_pairs (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  mentor_user_id uuid not null references auth.users(id) on delete cascade,
  mentee_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  started_on date not null default current_date,
  ended_on date,
  outcome text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint member_mentorship_pairs_people_distinct check (mentor_user_id <> mentee_user_id),
  constraint member_mentorship_pairs_outcome_bounded check (
    pg_catalog.char_length(outcome) <= 2000
    and pg_catalog.regexp_replace(outcome, E'[\n\r\t]', '', 'g') !~ '[[:cntrl:]]'
  ),
  constraint member_mentorship_pairs_lifecycle check (
    (status = 'active' and ended_on is null)
    or (status in ('completed', 'cancelled') and ended_on is not null)
  )
);

create unique index member_mentorship_pairs_one_active_idx
  on public.member_mentorship_pairs (organization_id, mentor_user_id, mentee_user_id)
  where status = 'active';

create table public.member_mentorship_notes (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  pair_id uuid not null references public.member_mentorship_pairs(id) on delete cascade,
  author_user_id uuid references auth.users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint member_mentorship_notes_body_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(body)) between 1 and 4000
    and pg_catalog.regexp_replace(body, E'[\n\r\t]', '', 'g') !~ '[[:cntrl:]]'
  )
);

create table public.member_mentorship_goals (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  pair_id uuid not null references public.member_mentorship_pairs(id) on delete cascade,
  title text not null,
  completed boolean not null default false,
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint member_mentorship_goals_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 200 and title !~ '[[:cntrl:]]'
  ),
  constraint member_mentorship_goals_completion_complete check (
    (completed and completed_at is not null) or (not completed and completed_at is null)
  )
);

create table public.member_support_events (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  member_user_id uuid references auth.users(id) on delete set null,
  entity_type text not null check (entity_type in ('emergency_checklist', 'accommodation_request', 'hr_contact', 'hr_directory', 'onboarding_step', 'onboarding_plan', 'mentorship_pair', 'mentorship_note', 'mentorship_goal')),
  entity_id uuid not null,
  event_type text not null check (event_type in ('saved', 'alerted', 'created', 'transitioned', 'withdrawn', 'configured', 'started', 'step_completed', 'note_added', 'goal_saved')),
  occurred_at timestamptz not null default pg_catalog.now()
);

create index member_emergency_checklists_member_idx
  on public.member_emergency_checklists (organization_id, member_user_id, updated_at desc);
create index member_accommodation_requests_queue_idx
  on public.member_accommodation_requests (organization_id, status, submitted_at desc);
create index member_hr_contacts_member_idx
  on public.member_hr_contacts (organization_id, member_user_id, occurred_at desc);
create index member_onboarding_plans_status_idx
  on public.member_onboarding_plans (organization_id, status, updated_at desc);
create index member_mentorship_pairs_participants_idx
  on public.member_mentorship_pairs (organization_id, mentor_user_id, mentee_user_id, updated_at desc);
create index member_mentorship_notes_pair_idx
  on public.member_mentorship_notes (pair_id, created_at desc);
create index member_mentorship_goals_pair_idx
  on public.member_mentorship_goals (pair_id, created_at);
create index member_support_events_entity_idx
  on public.member_support_events (organization_id, entity_type, entity_id, occurred_at desc);

alter table public.member_emergency_checklists enable row level security;
alter table public.member_accommodation_requests enable row level security;
alter table public.organization_hr_directory enable row level security;
alter table public.member_hr_contacts enable row level security;
alter table public.organization_onboarding_steps enable row level security;
alter table public.member_onboarding_plans enable row level security;
alter table public.member_mentorship_pairs enable row level security;
alter table public.member_mentorship_notes enable row level security;
alter table public.member_mentorship_goals enable row level security;
alter table public.member_support_events enable row level security;

create policy member_emergency_checklists_authorized_read on public.member_emergency_checklists
  for select to authenticated using (
    organization_id = private.current_member_organization()
    and (
      member_user_id = (select auth.uid())
      or (status = 'alerted' and private.has_organization_role(organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
    )
  );
create policy member_accommodation_requests_authorized_read on public.member_accommodation_requests
  for select to authenticated using (
    organization_id = private.current_member_organization()
    and (member_user_id = (select auth.uid()) or private.has_organization_role(organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
  );
create policy organization_hr_directory_member_read on public.organization_hr_directory
  for select to authenticated using (private.is_organization_member(organization_id));
create policy member_hr_contacts_authorized_read on public.member_hr_contacts
  for select to authenticated using (
    organization_id = private.current_member_organization()
    and (member_user_id = (select auth.uid()) or private.has_organization_role(organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
  );
create policy organization_onboarding_steps_member_read on public.organization_onboarding_steps
  for select to authenticated using (private.is_organization_member(organization_id));
create policy member_onboarding_plans_authorized_read on public.member_onboarding_plans
  for select to authenticated using (
    organization_id = private.current_member_organization()
    and (member_user_id = (select auth.uid()) or private.has_organization_role(organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
  );
create policy member_mentorship_pairs_authorized_read on public.member_mentorship_pairs
  for select to authenticated using (
    organization_id = private.current_member_organization()
    and (mentor_user_id = (select auth.uid()) or mentee_user_id = (select auth.uid()) or private.has_organization_role(organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
  );
create policy member_mentorship_notes_authorized_read on public.member_mentorship_notes
  for select to authenticated using (exists (
    select 1 from public.member_mentorship_pairs p
    where p.id = member_mentorship_notes.pair_id
      and p.organization_id = member_mentorship_notes.organization_id
      and (p.mentor_user_id = (select auth.uid()) or p.mentee_user_id = (select auth.uid()) or private.has_organization_role(p.organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
  ));
create policy member_mentorship_goals_authorized_read on public.member_mentorship_goals
  for select to authenticated using (exists (
    select 1 from public.member_mentorship_pairs p
    where p.id = member_mentorship_goals.pair_id
      and p.organization_id = member_mentorship_goals.organization_id
      and (p.mentor_user_id = (select auth.uid()) or p.mentee_user_id = (select auth.uid()) or private.has_organization_role(p.organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
  ));
create policy member_support_events_staff_read on public.member_support_events
  for select to authenticated using (private.has_organization_role(organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']));

do $block$
declare
  table_name text;
begin
  foreach table_name in array array[
    'member_emergency_checklists', 'member_accommodation_requests',
    'organization_hr_directory', 'member_hr_contacts',
    'organization_onboarding_steps', 'member_onboarding_plans',
    'member_mentorship_pairs', 'member_mentorship_notes',
    'member_mentorship_goals', 'member_support_events'
  ] loop
    execute pg_catalog.format(
      'create policy mfa_assurance on public.%I as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()))',
      table_name
    );
  end loop;
end
$block$;

revoke all on public.member_emergency_checklists from public, anon, authenticated, service_role;
revoke all on public.member_accommodation_requests from public, anon, authenticated, service_role;
revoke all on public.organization_hr_directory from public, anon, authenticated, service_role;
revoke all on public.member_hr_contacts from public, anon, authenticated, service_role;
revoke all on public.organization_onboarding_steps from public, anon, authenticated, service_role;
revoke all on public.member_onboarding_plans from public, anon, authenticated, service_role;
revoke all on public.member_mentorship_pairs from public, anon, authenticated, service_role;
revoke all on public.member_mentorship_notes from public, anon, authenticated, service_role;
revoke all on public.member_mentorship_goals from public, anon, authenticated, service_role;
revoke all on public.member_support_events from public, anon, authenticated, service_role;
grant select on public.member_emergency_checklists to authenticated;
grant select on public.member_accommodation_requests to authenticated;
grant select on public.organization_hr_directory to authenticated;
grant select on public.member_hr_contacts to authenticated;
grant select on public.organization_onboarding_steps to authenticated;
grant select on public.member_onboarding_plans to authenticated;
grant select on public.member_mentorship_pairs to authenticated;
grant select on public.member_mentorship_notes to authenticated;
grant select on public.member_mentorship_goals to authenticated;
grant select on public.member_support_events to authenticated;

create function private.member_support_is_staff(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.has_organization_role(
    p_organization_id,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  )
$function$;

create function private.member_support_member_label(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(nullif(pg_catalog.btrim(p.full_name), ''), 'Member')
  from public.member_profiles p
  where p.id = p_user_id
$function$;

create function private.member_support_record_event(
  p_id uuid,
  p_organization_id uuid,
  p_member_user_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_event_type text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is distinct from private.current_member_organization() then
    raise exception 'organization is derived from the session' using errcode = '42501';
  end if;
  insert into public.member_support_events (
    id, organization_id, actor_user_id, member_user_id, entity_type, entity_id, event_type
  ) values (
    p_id, p_organization_id, (select auth.uid()), p_member_user_id, p_entity_type, p_entity_id, p_event_type
  ) on conflict (id) do nothing;
end
$function$;

create function private.member_support_pair_allowed(p_pair_id uuid, p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from public.member_mentorship_pairs p
    where p.id = p_pair_id and p.organization_id = p_organization_id
      and (
        p.mentor_user_id = (select auth.uid())
        or p.mentee_user_id = (select auth.uid())
        or private.member_support_is_staff(p_organization_id)
      )
  )
$function$;

create function public.get_member_support_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.mi1_require_selected_organization();
  staff boolean := private.member_support_is_staff(org);
begin
  return pg_catalog.jsonb_build_object(
    'state', 'ready',
    'organizationId', org,
    'staff', staff,
    'emergencyChecklists', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'memberUserId', c.member_user_id,
        'memberLabel', private.member_support_member_label(c.member_user_id),
        'scenario', c.scenario, 'status', c.status,
        'completedSteps', c.completed_steps, 'notes', c.notes,
        'alertedAt', c.alerted_at, 'resolvedAt', c.resolved_at, 'updatedAt', c.updated_at
      ) order by c.updated_at desc)
      from public.member_emergency_checklists c
      where c.organization_id = org
        and (c.member_user_id = caller or (staff and c.status = 'alerted'))
    ), '[]'::jsonb),
    'accommodations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'memberUserId', a.member_user_id,
        'memberLabel', private.member_support_member_label(a.member_user_id),
        'requestType', a.request_type, 'description', a.description,
        'status', a.status, 'staffNote', a.staff_note,
        'submittedAt', a.submitted_at, 'resolvedAt', a.resolved_at, 'updatedAt', a.updated_at
      ) order by a.submitted_at desc)
      from public.member_accommodation_requests a
      where a.organization_id = org and (a.member_user_id = caller or staff)
    ), '[]'::jsonb),
    'accommodationSummary', pg_catalog.jsonb_build_object(
      'total', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff)),
      'open', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff) and a.status in ('submitted', 'under_review')),
      'approved', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff) and a.status = 'approved'),
      'denied', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff) and a.status = 'denied'),
      'withdrawn', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff) and a.status = 'withdrawn')
    ),
    'hrDirectory', (
      select pg_catalog.jsonb_build_object(
        'id', d.organization_id, 'name', d.name, 'title', d.title,
        'department', d.department, 'email', d.email, 'phone', d.phone,
        'hours', d.hours, 'notes', d.notes, 'enabled', d.enabled
      ) from public.organization_hr_directory d
      where d.organization_id = org and d.enabled
    ),
    'hrContacts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', h.id, 'memberUserId', h.member_user_id,
        'memberLabel', private.member_support_member_label(h.member_user_id),
        'channel', h.channel, 'purpose', h.purpose, 'disposition', h.disposition,
        'note', h.note, 'occurredAt', h.occurred_at,
        'followUpOn', h.follow_up_on, 'createdAt', h.created_at
      ) order by h.occurred_at desc)
      from public.member_hr_contacts h
      where h.organization_id = org and (h.member_user_id = caller or staff)
    ), '[]'::jsonb),
    'onboardingProgram', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id, 'title', s.title, 'description', s.description,
        'position', s.position, 'active', s.active
      ) order by s.position, s.id)
      from public.organization_onboarding_steps s
      where s.organization_id = org and (s.active or staff)
    ), '[]'::jsonb),
    'onboardingPlan', (
      select pg_catalog.jsonb_build_object(
        'id', p.id, 'memberUserId', p.member_user_id, 'status', p.status,
        'completedStepIds', p.completed_step_ids, 'startedAt', p.started_at,
        'completedAt', p.completed_at,
        'assignedByLabel', private.member_support_member_label(p.assigned_by)
      ) from public.member_onboarding_plans p
      where p.organization_id = org and p.member_user_id = caller
    ),
    'onboardingRoster', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id, 'memberUserId', p.member_user_id,
        'memberLabel', private.member_support_member_label(p.member_user_id),
        'status', p.status, 'completedStepIds', p.completed_step_ids,
        'startedAt', p.started_at, 'completedAt', p.completed_at
      ) order by p.updated_at desc)
      from public.member_onboarding_plans p where p.organization_id = org
    ), '[]'::jsonb) else '[]'::jsonb end,
    'mentorshipPairs', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id, 'mentorUserId', p.mentor_user_id, 'menteeUserId', p.mentee_user_id,
        'mentorLabel', private.member_support_member_label(p.mentor_user_id),
        'menteeLabel', private.member_support_member_label(p.mentee_user_id),
        'status', p.status, 'startedOn', p.started_on, 'endedOn', p.ended_on,
        'outcome', p.outcome,
        'goals', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', g.id, 'title', g.title, 'completed', g.completed,
          'completedAt', g.completed_at
        ) order by g.created_at) from public.member_mentorship_goals g where g.pair_id = p.id), '[]'::jsonb),
        'notes', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', n.id, 'authorLabel', private.member_support_member_label(n.author_user_id),
          'body', n.body, 'createdAt', n.created_at
        ) order by n.created_at desc) from public.member_mentorship_notes n where n.pair_id = p.id), '[]'::jsonb)
      ) order by p.updated_at desc)
      from public.member_mentorship_pairs p
      where p.organization_id = org
        and (p.mentor_user_id = caller or p.mentee_user_id = caller or staff)
    ), '[]'::jsonb),
    'mentorshipDirectory', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'userId', m.user_id, 'label', private.member_support_member_label(m.user_id),
        'chapterId', p.chapter_id
      ) order by private.member_support_member_label(m.user_id), m.user_id)
      from public.organization_memberships m
      join public.member_profiles p on p.id = m.user_id
      where m.organization_id = org and m.status = 'active'
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end
$function$;

create function public.save_member_emergency_checklist(
  p_scenario text,
  p_completed_steps integer[],
  p_notes text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.mi1_require_selected_organization(); row_out record;
begin
  if p_scenario not in ('disciplinary_meeting', 'pre_discipline_response', 'unsafe_work')
    or coalesce(pg_catalog.cardinality(p_completed_steps), 0) > 16
    or exists (select 1 from pg_catalog.unnest(coalesce(p_completed_steps, '{}')) step where step not between 0 and 3)
    or pg_catalog.char_length(coalesce(p_notes, '')) > 4000 then
    raise exception 'invalid emergency checklist' using errcode = '22023';
  end if;
  insert into public.member_emergency_checklists (
    organization_id, member_user_id, scenario, completed_steps, notes
  ) values (org, caller, p_scenario, coalesce(p_completed_steps, '{}')::smallint[], coalesce(p_notes, ''))
  on conflict (organization_id, member_user_id, scenario) do update set
    completed_steps = excluded.completed_steps, notes = excluded.notes, updated_at = pg_catalog.now()
  returning id, status, updated_at into row_out;
  perform private.member_support_record_event(p_idempotency_key, org, caller, 'emergency_checklist', row_out.id, 'saved');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'updatedAt', row_out.updated_at);
end
$function$;

create function public.alert_member_emergency_steward(
  p_scenario text,
  p_completed_steps integer[],
  p_notes text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.mi1_require_selected_organization(); row_out record;
begin
  if p_scenario not in ('disciplinary_meeting', 'pre_discipline_response', 'unsafe_work')
    or coalesce(pg_catalog.cardinality(p_completed_steps), 0) > 16
    or exists (select 1 from pg_catalog.unnest(coalesce(p_completed_steps, '{}')) step where step not between 0 and 3)
    or pg_catalog.char_length(coalesce(p_notes, '')) > 4000 then
    raise exception 'invalid emergency alert' using errcode = '22023';
  end if;
  insert into public.member_emergency_checklists (
    organization_id, member_user_id, scenario, status, completed_steps, notes, alerted_at
  ) values (org, caller, p_scenario, 'alerted', coalesce(p_completed_steps, '{}')::smallint[], coalesce(p_notes, ''), pg_catalog.now())
  on conflict (organization_id, member_user_id, scenario) do update set
    status = 'alerted', completed_steps = excluded.completed_steps, notes = excluded.notes,
    alerted_at = coalesce(public.member_emergency_checklists.alerted_at, pg_catalog.now()),
    resolved_at = null, updated_at = pg_catalog.now()
  returning id, alerted_at into row_out;
  insert into public.member_steward_requests (id, user_id, lesson_id)
  values (p_idempotency_key, caller, null)
  on conflict (id) do nothing;
  perform private.member_support_record_event(p_idempotency_key, org, caller, 'emergency_checklist', row_out.id, 'alerted');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', 'alerted', 'alertedAt', row_out.alerted_at);
end
$function$;

create function public.resolve_member_emergency_checklist(
  p_checklist_id uuid,
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
  row_out record;
begin
  update public.member_emergency_checklists checklist
  set status = 'resolved', resolved_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where checklist.id = p_checklist_id
    and checklist.organization_id = org
    and checklist.status = 'alerted'
    and (checklist.member_user_id = caller or private.member_support_is_staff(org))
  returning checklist.id, checklist.member_user_id, checklist.resolved_at into row_out;
  if row_out.id is null then
    raise exception 'open emergency alert not found in selected organization' using errcode = '22023';
  end if;
  perform private.member_support_record_event(
    p_idempotency_key, org, row_out.member_user_id,
    'emergency_checklist', row_out.id, 'transitioned'
  );
  return pg_catalog.jsonb_build_object(
    'id', row_out.id, 'status', 'resolved', 'resolvedAt', row_out.resolved_at
  );
end
$function$;

create function public.create_member_accommodation_request(
  p_request_type text,
  p_description text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.mi1_require_selected_organization(); row_out record;
begin
  if p_request_type not in ('schedule', 'equipment', 'workspace', 'leave', 'communication', 'remote_work', 'other')
    or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_description, ''))) not between 1 and 4000 then
    raise exception 'invalid accommodation request' using errcode = '22023';
  end if;
  insert into public.member_accommodation_requests (
    id, organization_id, member_user_id, request_type, description
  ) values (p_idempotency_key, org, caller, p_request_type, pg_catalog.btrim(p_description))
  on conflict (id) do nothing;
  select id, status, submitted_at into row_out
  from public.member_accommodation_requests
  where id = p_idempotency_key and organization_id = org and member_user_id = caller;
  if row_out.id is null then raise exception 'idempotency key belongs to another request' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, caller, 'accommodation_request', row_out.id, 'created');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'submittedAt', row_out.submitted_at);
end
$function$;

create function public.transition_member_accommodation_request(
  p_request_id uuid,
  p_status text,
  p_staff_note text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.mi1_require_selected_organization(); staff boolean := private.member_support_is_staff(org); row_out record;
begin
  if p_status not in ('under_review', 'approved', 'denied', 'withdrawn')
    or pg_catalog.char_length(coalesce(p_staff_note, '')) > 2000 then
    raise exception 'invalid accommodation transition' using errcode = '22023';
  end if;
  if p_status = 'withdrawn' then
    update public.member_accommodation_requests set
      status = 'withdrawn', resolved_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = p_request_id and organization_id = org and member_user_id = caller
      and status in ('submitted', 'under_review')
    returning id, member_user_id, status, resolved_at into row_out;
  elsif staff then
    update public.member_accommodation_requests set
      status = p_status, staff_note = coalesce(p_staff_note, ''),
      resolved_at = case when p_status in ('approved', 'denied') then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
    where id = p_request_id and organization_id = org
      and status not in ('withdrawn')
    returning id, member_user_id, status, resolved_at into row_out;
  else
    raise exception 'staff role and MFA required' using errcode = '42501';
  end if;
  if row_out.id is null then raise exception 'request not found or transition refused' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, row_out.member_user_id, 'accommodation_request', row_out.id, case when p_status = 'withdrawn' then 'withdrawn' else 'transitioned' end);
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'resolvedAt', row_out.resolved_at);
end
$function$;

create function public.record_member_hr_contact(
  p_member_user_id uuid,
  p_channel text,
  p_purpose text,
  p_disposition text,
  p_note text,
  p_occurred_at timestamptz,
  p_follow_up_on date,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.mi1_require_selected_organization(); target uuid := coalesce(p_member_user_id, caller); row_out record;
begin
  if target <> caller and not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if not exists (select 1 from public.organization_memberships m where m.organization_id = org and m.user_id = target and m.status = 'active') then raise exception 'member not found' using errcode = '22023'; end if;
  if p_channel not in ('email', 'phone', 'meeting', 'letter', 'portal', 'other')
    or p_disposition not in ('planned', 'attempted', 'reached', 'follow_up_due', 'resolved')
    or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose, ''))) not between 1 and 240
    or pg_catalog.char_length(coalesce(p_note, '')) > 4000
    or (p_disposition = 'follow_up_due' and p_follow_up_on is null) then
    raise exception 'invalid HR contact' using errcode = '22023';
  end if;
  insert into public.member_hr_contacts (
    id, organization_id, member_user_id, actor_user_id, channel, purpose,
    disposition, note, occurred_at, follow_up_on
  ) values (
    p_idempotency_key, org, target, caller, p_channel, pg_catalog.btrim(p_purpose),
    p_disposition, coalesce(p_note, ''), coalesce(p_occurred_at, pg_catalog.now()), p_follow_up_on
  ) on conflict (id) do nothing
  returning id, disposition, occurred_at into row_out;
  if row_out.id is null then
    select id, disposition, occurred_at into row_out from public.member_hr_contacts
    where id = p_idempotency_key and organization_id = org and member_user_id = target;
  end if;
  if row_out.id is null then raise exception 'idempotency key belongs to another contact' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, target, 'hr_contact', row_out.id, 'created');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'disposition', row_out.disposition, 'occurredAt', row_out.occurred_at);
end
$function$;

create function public.save_organization_hr_directory(
  p_name text,
  p_title text,
  p_department text,
  p_email text,
  p_phone text,
  p_hours text,
  p_notes text,
  p_enabled boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.mi1_require_selected_organization(); row_out record;
begin
  if not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if pg_catalog.char_length(coalesce(p_name, '')) > 160
    or pg_catalog.char_length(coalesce(p_title, '')) > 160
    or pg_catalog.char_length(coalesce(p_department, '')) > 160
    or pg_catalog.char_length(coalesce(p_email, '')) > 320
    or (coalesce(p_email, '') <> '' and p_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    or pg_catalog.char_length(coalesce(p_phone, '')) > 80
    or pg_catalog.char_length(coalesce(p_hours, '')) > 500
    or pg_catalog.char_length(coalesce(p_notes, '')) > 2000 then
    raise exception 'invalid HR directory' using errcode = '22023';
  end if;
  insert into public.organization_hr_directory (
    organization_id, name, title, department, email, phone, hours, notes, enabled, updated_by
  ) values (
    org, coalesce(p_name, ''), coalesce(p_title, ''), coalesce(p_department, ''),
    coalesce(p_email, ''), coalesce(p_phone, ''), coalesce(p_hours, ''),
    coalesce(p_notes, ''), coalesce(p_enabled, true), caller
  ) on conflict (organization_id) do update set
    name = excluded.name, title = excluded.title, department = excluded.department,
    email = excluded.email, phone = excluded.phone, hours = excluded.hours,
    notes = excluded.notes, enabled = excluded.enabled, updated_by = caller,
    updated_at = pg_catalog.now()
  returning organization_id, enabled, updated_at into row_out;
  perform private.member_support_record_event(p_idempotency_key, org, null, 'hr_directory', row_out.organization_id, 'configured');
  return pg_catalog.jsonb_build_object('id', row_out.organization_id, 'enabled', row_out.enabled, 'updatedAt', row_out.updated_at);
end
$function$;

create function public.save_organization_onboarding_step(
  p_step_id uuid,
  p_title text,
  p_description text,
  p_position integer,
  p_active boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization(); step_id uuid := coalesce(p_step_id, p_idempotency_key); row_out record;
begin
  if not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title, ''))) not between 1 and 160
    or pg_catalog.char_length(coalesce(p_description, '')) > 2000
    or p_position not between 0 and 1000 then raise exception 'invalid onboarding step' using errcode = '22023'; end if;
  begin
    insert into public.organization_onboarding_steps (
      id, organization_id, title, description, position, active, created_by
    ) values (
      step_id, org, pg_catalog.btrim(p_title), coalesce(p_description, ''), p_position, coalesce(p_active, true), (select auth.uid())
    ) on conflict (id) do update set
      title = excluded.title, description = excluded.description, position = excluded.position,
      active = excluded.active, updated_at = pg_catalog.now()
    where public.organization_onboarding_steps.organization_id = org
    returning id, position, active, updated_at into row_out;
  exception when unique_violation then
    raise exception 'onboarding position already in use' using errcode = '22023';
  end;
  if row_out.id is null then raise exception 'step not found in selected organization' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, null, 'onboarding_step', row_out.id, 'configured');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'position', row_out.position, 'active', row_out.active, 'updatedAt', row_out.updated_at);
end
$function$;

create function public.start_member_onboarding_plan(
  p_member_user_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.mi1_require_selected_organization(); target uuid := coalesce(p_member_user_id, caller); row_out record;
begin
  if target <> caller and not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if not exists (select 1 from public.organization_memberships m where m.organization_id = org and m.user_id = target and m.status = 'active') then raise exception 'member not found' using errcode = '22023'; end if;
  if not exists (select 1 from public.organization_onboarding_steps s where s.organization_id = org and s.active) then raise exception 'onboarding program is not configured' using errcode = '22023'; end if;
  insert into public.member_onboarding_plans (
    id, organization_id, member_user_id, assigned_by
  ) values (p_idempotency_key, org, target, caller)
  on conflict (organization_id, member_user_id) do nothing;
  select id, status, started_at, completed_at into row_out
  from public.member_onboarding_plans where organization_id = org and member_user_id = target;
  perform private.member_support_record_event(p_idempotency_key, org, target, 'onboarding_plan', row_out.id, 'started');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'startedAt', row_out.started_at, 'completedAt', row_out.completed_at);
end
$function$;

create function public.complete_member_onboarding_step(
  p_step_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid()); org uuid := private.mi1_require_selected_organization(); plan record; step_position integer; remaining integer; completed uuid[];
begin
  select * into plan from public.member_onboarding_plans
  where organization_id = org and member_user_id = caller for update;
  if plan.id is null then raise exception 'onboarding plan not found' using errcode = '22023'; end if;
  select s.position into step_position from public.organization_onboarding_steps s
  where s.id = p_step_id and s.organization_id = org and s.active;
  if step_position is null then raise exception 'onboarding step not found' using errcode = '22023'; end if;
  if exists (
    select 1 from public.organization_onboarding_steps earlier
    where earlier.organization_id = org and earlier.active and earlier.position < step_position
      and not (earlier.id = any(plan.completed_step_ids))
  ) then raise exception 'onboarding steps must be completed in order' using errcode = '22023'; end if;
  completed := array(select distinct value from pg_catalog.unnest(plan.completed_step_ids || p_step_id) value);
  select pg_catalog.count(*) into remaining from public.organization_onboarding_steps s
  where s.organization_id = org and s.active and not (s.id = any(completed));
  update public.member_onboarding_plans set
    completed_step_ids = completed,
    status = case when remaining = 0 then 'completed' else 'in_progress' end,
    started_at = coalesce(started_at, pg_catalog.now()),
    completed_at = case when remaining = 0 then coalesce(completed_at, pg_catalog.now()) else null end,
    updated_at = pg_catalog.now()
  where id = plan.id;
  perform private.member_support_record_event(p_idempotency_key, org, caller, 'onboarding_plan', plan.id, 'step_completed');
  return pg_catalog.jsonb_build_object('id', plan.id, 'status', case when remaining = 0 then 'completed' else 'in_progress' end, 'completedStepIds', completed);
end
$function$;

create function public.create_member_mentorship_pair(
  p_mentor_user_id uuid,
  p_mentee_user_id uuid,
  p_started_on date,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization(); row_out record;
begin
  if not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if p_mentor_user_id is null or p_mentee_user_id is null or p_mentor_user_id = p_mentee_user_id then raise exception 'mentor and mentee must be different members' using errcode = '22023'; end if;
  if (select pg_catalog.count(*) from public.organization_memberships m where m.organization_id = org and m.user_id in (p_mentor_user_id, p_mentee_user_id) and m.status = 'active') <> 2 then raise exception 'both participants require active organization membership' using errcode = '22023'; end if;
  insert into public.member_mentorship_pairs (
    id, organization_id, mentor_user_id, mentee_user_id, started_on, created_by
  ) values (p_idempotency_key, org, p_mentor_user_id, p_mentee_user_id, coalesce(p_started_on, current_date), (select auth.uid()))
  on conflict (id) do nothing;
  select id, status, started_on into row_out from public.member_mentorship_pairs
  where id = p_idempotency_key and organization_id = org;
  if row_out.id is null then raise exception 'pair already exists or idempotency key is invalid' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, p_mentee_user_id, 'mentorship_pair', row_out.id, 'created');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'startedOn', row_out.started_on);
exception when unique_violation then
  raise exception 'an active mentorship pair already exists' using errcode = '22023';
end
$function$;

create function public.transition_member_mentorship_pair(
  p_pair_id uuid,
  p_status text,
  p_outcome text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization(); row_out record;
begin
  if not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if p_status not in ('active', 'completed', 'cancelled') or pg_catalog.char_length(coalesce(p_outcome, '')) > 2000 then raise exception 'invalid mentorship transition' using errcode = '22023'; end if;
  update public.member_mentorship_pairs set
    status = p_status, outcome = coalesce(p_outcome, ''),
    ended_on = case when p_status = 'active' then null else current_date end,
    updated_at = pg_catalog.now()
  where id = p_pair_id and organization_id = org
  returning id, mentee_user_id, status, ended_on into row_out;
  if row_out.id is null then raise exception 'mentorship pair not found' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, row_out.mentee_user_id, 'mentorship_pair', row_out.id, 'transitioned');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'endedOn', row_out.ended_on);
end
$function$;

create function public.add_member_mentorship_note(
  p_pair_id uuid,
  p_body text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization(); mentee uuid; row_out record;
begin
  if not private.member_support_pair_allowed(p_pair_id, org) then raise exception 'mentorship access denied' using errcode = '42501'; end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'invalid mentorship note' using errcode = '22023'; end if;
  select mentee_user_id into mentee from public.member_mentorship_pairs where id = p_pair_id and organization_id = org;
  insert into public.member_mentorship_notes (
    id, organization_id, pair_id, author_user_id, body
  ) values (p_idempotency_key, org, p_pair_id, (select auth.uid()), pg_catalog.btrim(p_body))
  on conflict (id) do nothing
  returning id, created_at into row_out;
  if row_out.id is null then select id, created_at into row_out from public.member_mentorship_notes where id = p_idempotency_key and pair_id = p_pair_id; end if;
  if row_out.id is null then raise exception 'idempotency key belongs to another note' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, mentee, 'mentorship_note', row_out.id, 'note_added');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'createdAt', row_out.created_at);
end
$function$;

create function public.save_member_mentorship_goal(
  p_pair_id uuid,
  p_goal_id uuid,
  p_title text,
  p_completed boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization(); goal_id uuid := coalesce(p_goal_id, p_idempotency_key); mentee uuid; row_out record;
begin
  if not private.member_support_pair_allowed(p_pair_id, org) then raise exception 'mentorship access denied' using errcode = '42501'; end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title, ''))) not between 1 and 200 then raise exception 'invalid mentorship goal' using errcode = '22023'; end if;
  select mentee_user_id into mentee from public.member_mentorship_pairs where id = p_pair_id and organization_id = org;
  insert into public.member_mentorship_goals (
    id, organization_id, pair_id, title, completed, completed_at, created_by
  ) values (
    goal_id, org, p_pair_id, pg_catalog.btrim(p_title), coalesce(p_completed, false),
    case when coalesce(p_completed, false) then pg_catalog.now() else null end,
    (select auth.uid())
  ) on conflict (id) do update set
    title = excluded.title, completed = excluded.completed,
    completed_at = case when excluded.completed then coalesce(public.member_mentorship_goals.completed_at, pg_catalog.now()) else null end,
    updated_at = pg_catalog.now()
  where public.member_mentorship_goals.organization_id = org
    and public.member_mentorship_goals.pair_id = p_pair_id
  returning id, completed, completed_at into row_out;
  if row_out.id is null then raise exception 'goal not found in mentorship pair' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, mentee, 'mentorship_goal', row_out.id, 'goal_saved');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'completed', row_out.completed, 'completedAt', row_out.completed_at);
end
$function$;

revoke all on function private.member_support_is_staff(uuid) from public, anon, authenticated;
revoke all on function private.member_support_member_label(uuid) from public, anon, authenticated;
revoke all on function private.member_support_record_event(uuid, uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function private.member_support_pair_allowed(uuid, uuid) from public, anon, authenticated;

revoke all on function public.get_member_support_workspace() from public, anon;
revoke all on function public.save_member_emergency_checklist(text, integer[], text, uuid) from public, anon;
revoke all on function public.alert_member_emergency_steward(text, integer[], text, uuid) from public, anon;
revoke all on function public.resolve_member_emergency_checklist(uuid, uuid) from public, anon;
revoke all on function public.create_member_accommodation_request(text, text, uuid) from public, anon;
revoke all on function public.transition_member_accommodation_request(uuid, text, text, uuid) from public, anon;
revoke all on function public.record_member_hr_contact(uuid, text, text, text, text, timestamptz, date, uuid) from public, anon;
revoke all on function public.save_organization_hr_directory(text, text, text, text, text, text, text, boolean, uuid) from public, anon;
revoke all on function public.save_organization_onboarding_step(uuid, text, text, integer, boolean, uuid) from public, anon;
revoke all on function public.start_member_onboarding_plan(uuid, uuid) from public, anon;
revoke all on function public.complete_member_onboarding_step(uuid, uuid) from public, anon;
revoke all on function public.create_member_mentorship_pair(uuid, uuid, date, uuid) from public, anon;
revoke all on function public.transition_member_mentorship_pair(uuid, text, text, uuid) from public, anon;
revoke all on function public.add_member_mentorship_note(uuid, text, uuid) from public, anon;
revoke all on function public.save_member_mentorship_goal(uuid, uuid, text, boolean, uuid) from public, anon;

grant execute on function public.get_member_support_workspace() to authenticated;
grant execute on function public.save_member_emergency_checklist(text, integer[], text, uuid) to authenticated;
grant execute on function public.alert_member_emergency_steward(text, integer[], text, uuid) to authenticated;
grant execute on function public.resolve_member_emergency_checklist(uuid, uuid) to authenticated;
grant execute on function public.create_member_accommodation_request(text, text, uuid) to authenticated;
grant execute on function public.transition_member_accommodation_request(uuid, text, text, uuid) to authenticated;
grant execute on function public.record_member_hr_contact(uuid, text, text, text, text, timestamptz, date, uuid) to authenticated;
grant execute on function public.save_organization_hr_directory(text, text, text, text, text, text, text, boolean, uuid) to authenticated;
grant execute on function public.save_organization_onboarding_step(uuid, text, text, integer, boolean, uuid) to authenticated;
grant execute on function public.start_member_onboarding_plan(uuid, uuid) to authenticated;
grant execute on function public.complete_member_onboarding_step(uuid, uuid) to authenticated;
grant execute on function public.create_member_mentorship_pair(uuid, uuid, date, uuid) to authenticated;
grant execute on function public.transition_member_mentorship_pair(uuid, text, text, uuid) to authenticated;
grant execute on function public.add_member_mentorship_note(uuid, text, uuid) to authenticated;
grant execute on function public.save_member_mentorship_goal(uuid, uuid, text, boolean, uuid) to authenticated;

-- The schema landed after the deterministic SAMPLE function-parity catalog.
-- Mark these five gaps seeded only together with the reversible evidence hook
-- below. A migration run creates no organization, user, or feature row.
update private.demo_seed_function_catalog catalog
set coverage = 'seeded',
    evidence_key = evidence.evidence_key,
    gate_relation = null
from (values
  ('CR-079', 'emergency-rights-checklists'),
  ('CR-080', 'accommodation-lifecycle'),
  ('CR-081', 'hr-contact-history'),
  ('CR-082', 'new-member-onboarding'),
  ('CR-083', 'mentorship-outcomes')
) as evidence(function_id, evidence_key)
where catalog.function_id = evidence.function_id;

create function private.demo_seed_remove_member_support(p_lane text, p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  );
begin
  if p_lane not in ('presg', 'uniondemo') then raise exception 'unknown demo lane'; end if;
  delete from public.member_support_events where organization_id = org;
  delete from public.member_mentorship_notes where organization_id = org;
  delete from public.member_mentorship_goals where organization_id = org;
  delete from public.member_mentorship_pairs where organization_id = org;
  delete from public.member_onboarding_plans where organization_id = org;
  delete from public.organization_onboarding_steps where organization_id = org;
  delete from public.member_hr_contacts where organization_id = org;
  delete from public.organization_hr_directory where organization_id = org;
  delete from public.member_accommodation_requests where organization_id = org;
  delete from public.member_emergency_checklists where organization_id = org;
end
$function$;

create function private.demo_seed_member_support_status(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  );
  emergency_count bigint;
  accommodation_count bigint;
  hr_contact_count bigint;
  onboarding_step_count bigint;
  onboarding_plan_count bigint;
  mentorship_pair_count bigint;
  mentorship_goal_count bigint;
  mentorship_note_count bigint;
  history_years bigint;
begin
  if p_lane not in ('presg', 'uniondemo') then raise exception 'unknown demo lane'; end if;
  select pg_catalog.count(*) into emergency_count from public.member_emergency_checklists where organization_id = org;
  select pg_catalog.count(*) into accommodation_count from public.member_accommodation_requests where organization_id = org;
  select pg_catalog.count(*) into hr_contact_count from public.member_hr_contacts where organization_id = org;
  select pg_catalog.count(*) into onboarding_step_count from public.organization_onboarding_steps where organization_id = org;
  select pg_catalog.count(*) into onboarding_plan_count from public.member_onboarding_plans where organization_id = org;
  select pg_catalog.count(*) into mentorship_pair_count from public.member_mentorship_pairs where organization_id = org;
  select pg_catalog.count(*) into mentorship_goal_count from public.member_mentorship_goals where organization_id = org;
  select pg_catalog.count(*) into mentorship_note_count from public.member_mentorship_notes where organization_id = org;
  select pg_catalog.count(distinct pg_catalog.date_part('year', occurred_at)) into history_years
  from public.member_support_events where organization_id = org;
  return pg_catalog.jsonb_build_object(
    'ok', emergency_count >= 3 and accommodation_count >= 36 and hr_contact_count >= 36
      and onboarding_step_count >= 4 and onboarding_plan_count >= 30
      and mentorship_pair_count >= 24 and mentorship_goal_count >= 48
      and mentorship_note_count >= 48 and history_years >= 3,
    'emergencyChecklists', emergency_count,
    'accommodationRequests', accommodation_count,
    'hrContacts', hr_contact_count,
    'onboardingSteps', onboarding_step_count,
    'onboardingPlans', onboarding_plan_count,
    'mentorshipPairs', mentorship_pair_count,
    'mentorshipGoals', mentorship_goal_count,
    'mentorshipNotes', mentorship_note_count,
    'historyYears', history_years,
    'outboundDeliveries', 0
  );
end
$function$;

create function private.demo_seed_apply_member_support(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  );
  actor uuid;
  member_id uuid;
  mentor_id uuid;
  pair_id uuid;
  entity_id uuid;
  step_ids uuid[] := array[]::uuid[];
  state text;
  result jsonb;
  lane_member_count integer;
  n integer;
begin
  if p_lane not in ('presg', 'uniondemo') then raise exception 'unknown demo lane'; end if;
  if p_lane = 'presg' and not exists (
    select 1 from private.presg_demo_runs r where r.id = p_run_id and r.state in ('applied', 'verified')
  ) then raise exception 'presg demo run is not applied'; end if;
  if p_lane = 'uniondemo' and not exists (
    select 1 from private.uniondemo_runs r where r.id = p_run_id and r.state in ('applied', 'verified')
  ) then raise exception 'union demo run is not applied'; end if;
  if not exists (select 1 from public.organizations o where o.id = org and o.status = 'active') then
    raise exception 'demo organization is missing';
  end if;
  if p_lane = 'presg' then
    select r.member_count into lane_member_count from private.presg_demo_runs r where r.id = p_run_id;
  else
    select r.member_count into lane_member_count from private.uniondemo_runs r where r.id = p_run_id;
  end if;
  if lane_member_count < 38 then
    raise exception 'member support demo seed requires at least 38 seeded users' using errcode = '22023';
  end if;

  perform private.demo_seed_remove_member_support(p_lane, p_run_id);
  actor := private.demo_seed_user(p_lane, p_run_id, 1);

  insert into public.organization_hr_directory (
    organization_id, name, title, department, email, phone, hours, notes,
    enabled, updated_by, updated_at
  ) values (
    org, 'People Operations', 'Employee relations contact', 'Human Resources',
    'people-operations@example.invalid', '(555) 014-0188', 'Weekdays, 9 AM–5 PM',
    'Use the secure employer portal when a document contains medical or personnel information.',
    true, actor, pg_catalog.now() - interval '12 days'
  );

  for n in 1..4 loop
    entity_id := private.member_stress_uuid(p_run_id::text || ':member-support:onboarding-step:' || n);
    step_ids := pg_catalog.array_append(step_ids, entity_id);
    insert into public.organization_onboarding_steps (
      id, organization_id, title, description, position, active, created_by, created_at, updated_at
    ) values (
      entity_id, org,
      (array['Meet your chapter','Learn core workplace rights','Set communication preferences','Choose a first way to participate'])[n],
      (array[
        'Review the people and channels available when you need help.',
        'Complete the rights introduction and save the scripts you may need.',
        'Choose the contact channels and notification categories that work for you.',
        'Pick one meeting, pulse, or chapter activity that fits your schedule.'
      ])[n],
      n, true, actor, pg_catalog.now() - interval '3 years', pg_catalog.now() - interval '20 days'
    );
  end loop;

  -- The featured member receives all three emergency scenarios. Thirty-six
  -- lifecycle records per recurring program span a rolling three-year history.
  member_id := private.demo_seed_user(p_lane, p_run_id, 2);
  for n in 1..3 loop
    entity_id := private.member_stress_uuid(p_run_id::text || ':member-support:emergency:' || n);
    state := (array['draft','alerted','resolved'])[n];
    insert into public.member_emergency_checklists (
      id, organization_id, member_user_id, scenario, status, completed_steps,
      notes, alerted_at, resolved_at, created_at, updated_at
    ) values (
      entity_id, org, member_id,
      (array['disciplinary_meeting','pre_discipline_response','unsafe_work'])[n], state,
      case when n = 1 then array[0]::smallint[] when n = 2 then array[0,1]::smallint[] else array[0,1,2,3]::smallint[] end,
      case when n = 1 then 'Meeting details are ready to add.' when n = 2 then 'Response deadline and requested records were documented.' else 'Safety follow-up was completed.' end,
      case when n >= 2 then pg_catalog.now() - ((n * 170) || ' days')::interval else null end,
      case when n = 3 then pg_catalog.now() - interval '14 months' else null end,
      pg_catalog.now() - ((n * 180) || ' days')::interval,
      pg_catalog.now() - ((n * 170) || ' days')::interval
    );
  end loop;

  for n in 1..36 loop
    member_id := private.demo_seed_user(p_lane, p_run_id, 2 + n);
    entity_id := private.member_stress_uuid(p_run_id::text || ':member-support:accommodation:' || n);
    state := (array['submitted','under_review','approved','denied','withdrawn'])[1 + (n % 5)];
    insert into public.member_accommodation_requests (
      id, organization_id, member_user_id, request_type, description, status,
      staff_note, submitted_at, resolved_at, updated_at
    ) values (
      entity_id, org, member_id,
      (array['schedule','equipment','workspace','leave','communication','remote_work','other'])[1 + (n % 7)],
      (array[
        'Request for a consistent start-time adjustment during the current schedule cycle.',
        'Request for equipment that supports the essential duties of the position.',
        'Request to review a workspace change and an effective implementation date.',
        'Request to document a leave-related schedule and the return-to-work plan.'
      ])[1 + (n % 4)],
      state,
      case when state in ('approved','denied') then 'Written disposition recorded after the interactive review.' else '' end,
      pg_catalog.now() - ((n * 30) || ' days')::interval,
      case when state in ('approved','denied','withdrawn') then pg_catalog.now() - ((n * 30 - 7) || ' days')::interval else null end,
      pg_catalog.now() - ((n * 30 - 7) || ' days')::interval
    );
    insert into public.member_support_events (
      id, organization_id, actor_user_id, member_user_id, entity_type, entity_id, event_type, occurred_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':member-support:accommodation-event:' || n),
      org, actor, member_id, 'accommodation_request', entity_id,
      case when state = 'withdrawn' then 'withdrawn' when state in ('submitted','under_review') then 'created' else 'transitioned' end,
      pg_catalog.now() - ((n * 30 - 7) || ' days')::interval
    );

    entity_id := private.member_stress_uuid(p_run_id::text || ':member-support:hr-contact:' || n);
    state := (array['planned','attempted','reached','follow_up_due','resolved'])[1 + (n % 5)];
    insert into public.member_hr_contacts (
      id, organization_id, member_user_id, actor_user_id, channel, purpose,
      disposition, note, occurred_at, follow_up_on, created_at
    ) values (
      entity_id, org, member_id, actor,
      (array['email','phone','meeting','letter','portal','other'])[1 + (n % 6)],
      (array['Confirm paperwork receipt','Clarify the response timeline','Document the interactive-process meeting','Record the written disposition'])[1 + (n % 4)],
      state,
      case when state = 'resolved' then 'The response and next step were confirmed in writing.' else 'Contact attempt and current disposition recorded.' end,
      pg_catalog.now() - ((n * 31) || ' days')::interval,
      case when state = 'follow_up_due' then current_date + (n % 14) else null end,
      pg_catalog.now() - ((n * 31) || ' days')::interval
    );
    insert into public.member_support_events (
      id, organization_id, actor_user_id, member_user_id, entity_type, entity_id, event_type, occurred_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':member-support:hr-event:' || n),
      org, actor, member_id, 'hr_contact', entity_id, 'created',
      pg_catalog.now() - ((n * 31) || ' days')::interval
    );
  end loop;

  for n in 1..30 loop
    member_id := private.demo_seed_user(p_lane, p_run_id, 2 + n);
    state := case when n % 5 = 0 then 'in_progress' else 'completed' end;
    entity_id := private.member_stress_uuid(p_run_id::text || ':member-support:onboarding-plan:' || n);
    insert into public.member_onboarding_plans (
      id, organization_id, member_user_id, status, completed_step_ids,
      assigned_by, started_at, completed_at, created_at, updated_at
    ) values (
      entity_id, org, member_id, state,
      case when state = 'completed' then step_ids else step_ids[1:2] end,
      actor,
      pg_catalog.now() - ((36 - n) || ' months')::interval,
      case when state = 'completed' then pg_catalog.now() - ((36 - n) || ' months')::interval + interval '21 days' else null end,
      pg_catalog.now() - ((36 - n) || ' months')::interval,
      case when state = 'completed' then pg_catalog.now() - ((36 - n) || ' months')::interval + interval '21 days' else pg_catalog.now() - interval '4 days' end
    );
    insert into public.member_support_events (
      id, organization_id, actor_user_id, member_user_id, entity_type, entity_id, event_type, occurred_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':member-support:onboarding-event:' || n),
      org, actor, member_id, 'onboarding_plan', entity_id,
      case when state = 'completed' then 'step_completed' else 'started' end,
      pg_catalog.now() - ((36 - n) || ' months')::interval + interval '7 days'
    );
  end loop;

  mentor_id := private.demo_seed_user(p_lane, p_run_id, 1);
  for n in 1..24 loop
    member_id := private.demo_seed_user(p_lane, p_run_id, 2 + n);
    pair_id := private.member_stress_uuid(p_run_id::text || ':member-support:mentorship-pair:' || n);
    state := case when n % 4 = 0 then 'active' when n % 5 = 0 then 'cancelled' else 'completed' end;
    insert into public.member_mentorship_pairs (
      id, organization_id, mentor_user_id, mentee_user_id, status, started_on,
      ended_on, outcome, created_by, created_at, updated_at
    ) values (
      pair_id, org, mentor_id, member_id, state,
      current_date - (n * 45),
      case when state = 'active' then null else current_date - (n * 45) + 60 end,
      case when state = 'completed' then 'The agreed practice goal and follow-up reflection were completed.' when state = 'cancelled' then 'The pairing ended after schedules changed.' else '' end,
      actor, pg_catalog.now() - ((n * 45) || ' days')::interval,
      pg_catalog.now() - ((n * 45 - 30) || ' days')::interval
    );
    insert into public.member_mentorship_goals (
      id, organization_id, pair_id, title, completed, completed_at,
      created_by, created_at, updated_at
    ) values
      (private.member_stress_uuid(p_run_id::text || ':member-support:mentorship-goal:' || n || ':1'), org, pair_id,
       'Shadow a member intake and complete a debrief', true,
       pg_catalog.now() - ((n * 45 - 20) || ' days')::interval, actor,
       pg_catalog.now() - ((n * 45 - 35) || ' days')::interval,
       pg_catalog.now() - ((n * 45 - 20) || ' days')::interval),
      (private.member_stress_uuid(p_run_id::text || ':member-support:mentorship-goal:' || n || ':2'), org, pair_id,
       'Lead a follow-up conversation with feedback', state = 'completed',
       case when state = 'completed' then pg_catalog.now() - ((n * 45 - 5) || ' days')::interval else null end,
       actor, pg_catalog.now() - ((n * 45 - 18) || ' days')::interval,
       pg_catalog.now() - ((n * 45 - 5) || ' days')::interval);
    insert into public.member_mentorship_notes (
      id, organization_id, pair_id, author_user_id, body, created_at
    ) values
      (private.member_stress_uuid(p_run_id::text || ':member-support:mentorship-note:' || n || ':1'), org, pair_id, mentor_id,
       'Reviewed the next practice opportunity and agreed on a debrief question.',
       pg_catalog.now() - ((n * 45 - 28) || ' days')::interval),
      (private.member_stress_uuid(p_run_id::text || ':member-support:mentorship-note:' || n || ':2'), org, pair_id, member_id,
       'Captured what worked, what was difficult, and the next action to practice.',
       pg_catalog.now() - ((n * 45 - 12) || ' days')::interval);
    insert into public.member_support_events (
      id, organization_id, actor_user_id, member_user_id, entity_type, entity_id, event_type, occurred_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':member-support:mentorship-event:' || n),
      org, actor, member_id, 'mentorship_pair', pair_id,
      case when state = 'active' then 'created' else 'transitioned' end,
      pg_catalog.now() - ((n * 45 - 30) || ' days')::interval
    );
  end loop;

  -- Add emergency history events separately because the checklist relation is
  -- intentionally one current row per member and scenario.
  member_id := private.demo_seed_user(p_lane, p_run_id, 2);
  for n in 1..3 loop
    insert into public.member_support_events (
      id, organization_id, actor_user_id, member_user_id, entity_type, entity_id, event_type, occurred_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':member-support:emergency-event:' || n),
      org, member_id, member_id, 'emergency_checklist',
      private.member_stress_uuid(p_run_id::text || ':member-support:emergency:' || n),
      (array['saved','alerted','transitioned'])[n],
      pg_catalog.now() - ((n * 14) || ' months')::interval
    );
  end loop;

  result := private.demo_seed_member_support_status(p_lane, p_run_id);
  if not (result ->> 'ok')::boolean then
    raise exception 'member support seed contract failed: %', result;
  end if;
  return result;
end
$function$;

create function private.demo_seed_sync_member_support_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' and new.function_id = 'CR-079' then
    perform private.demo_seed_apply_member_support(new.lane, new.run_id);
    return new;
  elsif tg_op = 'DELETE' and old.function_id = 'CR-079' then
    perform private.demo_seed_remove_member_support(old.lane, old.run_id);
    return old;
  end if;
  if tg_op = 'INSERT' then return new; end if;
  return old;
end
$function$;

create trigger demo_seed_sync_member_support_evidence
before insert or delete on private.demo_seed_function_evidence
for each row execute function private.demo_seed_sync_member_support_evidence();

revoke all on function private.demo_seed_remove_member_support(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_member_support_status(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_apply_member_support(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_sync_member_support_evidence()
  from public, anon, authenticated, service_role;
