-- Mission Impossible 1 casework suite (CR-020 through CR-034).
--
-- Donor SHA donor-baseline-20260721 is behavior-only.
-- This migration is a fresh current-architecture implementation: it does not
-- replay donor migrations, Next.js actions, role-only guards, branch-global
-- alert visibility, compensating deletes, service-role browser paths, legacy
-- tenant identifiers, or fictional organization data.

set local lock_timeout = '5s';

alter table public.member_cases
  add column is_restricted boolean not null default false,
  add column restriction_reason text,
  add column restricted_at timestamptz,
  add column restricted_by uuid references auth.users(id) on delete restrict,
  add constraint member_cases_restriction_reason_bounded check (
    restriction_reason is null
    or pg_catalog.char_length(pg_catalog.btrim(restriction_reason)) between 8 and 500
  ),
  add constraint member_cases_restriction_state_coherent check (
    (not is_restricted and restriction_reason is null and restricted_at is null and restricted_by is null)
    or
    (is_restricted and restriction_reason is not null and restricted_at is not null and restricted_by is not null)
  ),
  add constraint member_cases_casework_scope_key unique (id, organization_id, chapter_id);

create table public.casework_access_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  grantee_user_id uuid not null references auth.users(id) on delete cascade,
  granted_by uuid not null references auth.users(id) on delete restrict,
  reason text not null check (pg_catalog.char_length(pg_catalog.btrim(reason)) between 8 and 500),
  granted_at timestamptz not null default pg_catalog.now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete restrict,
  foreign key (case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete cascade,
  constraint casework_access_grants_revoke_coherent check (
    (revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null)
  )
);
create unique index casework_access_grants_active_unique
  on public.casework_access_grants(case_id, grantee_user_id) where revoked_at is null;

create or replace function private.casework_member_owns(p_case_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1 from public.member_cases c
    where c.id = p_case_id and c.user_id = (select auth.uid())
  );
$function$;

create or replace function private.casework_staff_can_access(p_case_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1
    from public.member_cases c
    where c.id = p_case_id
      and c.organization_id is not null
      and c.chapter_id is not null
      and private.actor_has_chapter_staff_role((select auth.uid()), c.chapter_id)
      and (
        c.steward_user_id = (select auth.uid())
        or c.coordinator_user_id = (select auth.uid())
        or public.staff_can_see_user(c.user_id, 'coordinator')
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
      )
      and (
        not c.is_restricted
        or c.steward_user_id = (select auth.uid())
        or c.coordinator_user_id = (select auth.uid())
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
        or exists (
          select 1 from public.casework_access_grants g
          where g.case_id = c.id
            and g.grantee_user_id = (select auth.uid())
            and g.revoked_at is null
        )
      )
  );
$function$;

create or replace function private.casework_can_read(p_case_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select private.casework_member_owns(p_case_id) or private.casework_staff_can_access(p_case_id);
$function$;

create or replace function private.casework_scope_matches(
  p_case_id uuid,
  p_organization_id uuid,
  p_chapter_id text
)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1 from public.member_cases c
    where c.id = p_case_id
      and c.organization_id = p_organization_id
      and c.chapter_id = p_chapter_id
  );
$function$;

create or replace function private.casework_require_mfa()
returns void language plpgsql stable security definer set search_path = '' as $function$
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function private.casework_member_owns(uuid) from public, anon, authenticated;
revoke all on function private.casework_staff_can_access(uuid) from public, anon, authenticated;
revoke all on function private.casework_can_read(uuid) from public, anon, authenticated;
revoke all on function private.casework_scope_matches(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.casework_require_mfa() from public, anon, authenticated;

drop policy member_cases_select_coordinator on public.member_cases;
create policy member_cases_select_coordinator on public.member_cases
  for select to authenticated using (
    public.staff_can_see_user(user_id, 'coordinator')
    and (
      not is_restricted
      or coordinator_user_id = (select auth.uid())
      or private.has_organization_role(organization_id, array['advisor','admin','vp'])
      or exists (
        select 1 from public.casework_access_grants g
        where g.case_id = member_cases.id
          and g.grantee_user_id = (select auth.uid())
          and g.revoked_at is null
      )
    )
  );

create or replace function private.guard_casework_restriction_update()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if row(old.is_restricted, old.restriction_reason, old.restricted_at, old.restricted_by)
     is distinct from
     row(new.is_restricted, new.restriction_reason, new.restricted_at, new.restricted_by)
     and not private.casework_staff_can_access(old.id) then
    raise exception 'restricted-case fields require authorized staff' using errcode = '42501';
  end if;
  return new;
end;
$function$;
revoke all on function private.guard_casework_restriction_update() from public, anon, authenticated;
create trigger member_cases_guard_restriction_update
before update of is_restricted, restriction_reason, restricted_at, restricted_by on public.member_cases
for each row execute function private.guard_casework_restriction_update();

create table public.casework_strength_analyses (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  analyzed_by uuid not null references auth.users(id) on delete restrict,
  inputs jsonb not null,
  score integer not null check (score between 0 and 100),
  band text not null check (band in ('needs_evidence','developing','strong')),
  recommendations jsonb not null default '[]'::jsonb check (pg_catalog.jsonb_typeof(recommendations) = 'array'),
  idempotency_key uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete cascade,
  unique (organization_id, analyzed_by, idempotency_key),
  constraint casework_strength_inputs_object check (
    pg_catalog.jsonb_typeof(inputs) = 'object'
    and inputs - array['facts','documentation','timeliness','contract_support','witnesses'] = '{}'::jsonb
  )
);
create index casework_strength_analyses_case_created_idx
  on public.casework_strength_analyses(case_id, created_at desc);

create table public.casework_bargaining_workspaces (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  title text not null check (pg_catalog.char_length(pg_catalog.btrim(title)) between 3 and 200),
  status text not null default 'planning' check (status in ('planning','live','paused','tentative_agreement','closed')),
  starts_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (id, organization_id)
);
create index casework_bargaining_workspaces_scope_idx
  on public.casework_bargaining_workspaces(organization_id, chapter_id, status, updated_at desc);

create table public.casework_bargaining_proposals (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  side text not null check (side in ('union','management','joint')),
  title text not null check (pg_catalog.char_length(pg_catalog.btrim(title)) between 3 and 200),
  body text not null check (pg_catalog.char_length(pg_catalog.btrim(body)) between 8 and 20000),
  status text not null default 'draft' check (status in ('draft','proposed','countered','tentative','accepted','rejected','withdrawn')),
  response_due_at timestamptz,
  position integer not null default 0 check (position >= 0),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  foreign key (workspace_id, organization_id)
    references public.casework_bargaining_workspaces(id, organization_id) on delete cascade,
  unique (id, workspace_id, organization_id)
);
create index casework_bargaining_proposals_workspace_idx
  on public.casework_bargaining_proposals(workspace_id, position, updated_at desc);

create table public.casework_bargaining_events (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  proposal_id uuid,
  event_type text not null check (event_type in ('note','proposal_status','session_status','pulse')),
  body text not null check (pg_catalog.char_length(pg_catalog.btrim(body)) between 1 and 4000),
  pulse text check (pulse is null or pulse in ('steady','watch','urgent')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (workspace_id, organization_id)
    references public.casework_bargaining_workspaces(id, organization_id) on delete cascade,
  foreign key (proposal_id, workspace_id, organization_id)
    references public.casework_bargaining_proposals(id, workspace_id, organization_id) on delete set null (proposal_id)
);
create index casework_bargaining_events_timeline_idx
  on public.casework_bargaining_events(workspace_id, created_at, id);

create table public.casework_deadlines (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  kind text not null check (kind in ('filing','response','hearing','appeal','follow_up')),
  label text not null check (pg_catalog.char_length(pg_catalog.btrim(label)) between 3 and 200),
  due_at timestamptz not null,
  status text not null default 'active' check (status in ('active','met','extended','waived','missed')),
  reminder_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  foreign key (case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete cascade,
  unique (id, organization_id),
  constraint casework_deadline_reminder_precedes check (reminder_at is null or reminder_at < due_at)
);
create index casework_deadlines_due_idx
  on public.casework_deadlines(organization_id, chapter_id, status, due_at);

create table public.casework_deadline_extensions (
  id uuid primary key default extensions.gen_random_uuid(),
  deadline_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  requested_by uuid not null references auth.users(id) on delete restrict,
  previous_due_at timestamptz not null,
  requested_due_at timestamptz not null,
  reason text not null check (pg_catalog.char_length(pg_catalog.btrim(reason)) between 8 and 2000),
  status text not null default 'requested' check (status in ('requested','approved','denied')),
  decided_by uuid references auth.users(id) on delete restrict,
  decided_at timestamptz,
  decision_note text check (decision_note is null or pg_catalog.char_length(pg_catalog.btrim(decision_note)) between 3 and 1000),
  idempotency_key uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (deadline_id, organization_id)
    references public.casework_deadlines(id, organization_id) on delete restrict,
  unique (organization_id, requested_by, idempotency_key),
  constraint casework_deadline_extension_future check (requested_due_at > previous_due_at),
  constraint casework_deadline_extension_decision check (
    (status = 'requested' and decided_by is null and decided_at is null)
    or (status in ('approved','denied') and decided_by is not null and decided_at is not null)
  )
);
create index casework_deadline_extensions_deadline_idx
  on public.casework_deadline_extensions(deadline_id, created_at desc);

create table public.casework_checklist_templates (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  case_type text not null,
  step text not null,
  title text not null check (pg_catalog.char_length(pg_catalog.btrim(title)) between 3 and 200),
  items jsonb not null check (pg_catalog.jsonb_typeof(items) = 'array' and pg_catalog.jsonb_array_length(items) between 1 and 50),
  active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (id, organization_id)
);
create index casework_checklist_templates_scope_idx
  on public.casework_checklist_templates(organization_id, chapter_id, case_type, step) where active;

create table public.casework_checklists (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  template_id uuid,
  step text not null,
  title text not null check (pg_catalog.char_length(pg_catalog.btrim(title)) between 3 and 200),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  foreign key (case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete cascade,
  foreign key (template_id, organization_id)
    references public.casework_checklist_templates(id, organization_id) on delete set null (template_id),
  unique (id, organization_id)
);
create index casework_checklists_case_idx on public.casework_checklists(case_id, created_at);

create table public.casework_checklist_items (
  id uuid primary key default extensions.gen_random_uuid(),
  checklist_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  label text not null check (pg_catalog.char_length(pg_catalog.btrim(label)) between 1 and 300),
  position integer not null check (position between 0 and 49),
  required boolean not null default true,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete restrict,
  foreign key (checklist_id, organization_id)
    references public.casework_checklists(id, organization_id) on delete cascade,
  unique (checklist_id, position),
  constraint casework_checklist_item_completion check (
    (completed_at is null and completed_by is null) or (completed_at is not null and completed_by is not null)
  )
);

create table public.casework_step_transitions (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  from_step text not null,
  to_step text not null,
  outcome text not null check (pg_catalog.char_length(pg_catalog.btrim(outcome)) between 3 and 1000),
  transitioned_by uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete cascade,
  unique (organization_id, transitioned_by, idempotency_key),
  constraint casework_step_changed check (from_step <> to_step)
);
create index casework_step_transitions_case_idx
  on public.casework_step_transitions(case_id, created_at, id);

create table public.casework_alerts (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  kind text not null check (kind in ('deadline','safety','retaliation','legal','stalled','custom')),
  severity text not null check (severity in ('info','warning','critical')),
  message text not null check (pg_catalog.char_length(pg_catalog.btrim(message)) between 3 and 1000),
  status text not null default 'open' check (status in ('open','acknowledged','escalated','resolved')),
  escalation_due_at timestamptz,
  escalated_at timestamptz,
  resolved_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete cascade,
  unique (id, organization_id)
);
create index casework_alerts_queue_idx
  on public.casework_alerts(organization_id, chapter_id, status, severity, escalation_due_at);

create table public.casework_alert_acknowledgements (
  id uuid primary key default extensions.gen_random_uuid(),
  alert_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  acknowledged_by uuid not null references auth.users(id) on delete restrict,
  note text check (note is null or pg_catalog.char_length(pg_catalog.btrim(note)) between 3 and 1000),
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (alert_id, organization_id)
    references public.casework_alerts(id, organization_id) on delete restrict,
  unique (alert_id, acknowledged_by)
);

create table public.casework_management_people (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  display_name text not null check (pg_catalog.char_length(pg_catalog.btrim(display_name)) between 2 and 200),
  title text,
  workplace text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (id, organization_id, chapter_id)
);
create index casework_management_people_scope_idx
  on public.casework_management_people(organization_id, chapter_id, display_name);

create table public.casework_management_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  management_person_id uuid not null,
  case_id uuid,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  occurred_at timestamptz not null,
  category text not null check (category in ('discipline','scheduling','safety','retaliation','bargaining','other')),
  summary text not null check (pg_catalog.char_length(pg_catalog.btrim(summary)) between 8 and 4000),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete restrict,
  foreign key (management_person_id, organization_id, chapter_id)
    references public.casework_management_people(id, organization_id, chapter_id) on delete restrict,
  unique (id, organization_id)
);
create index casework_management_entries_person_idx
  on public.casework_management_entries(management_person_id, occurred_at desc);

create table public.casework_management_addenda (
  id uuid primary key default extensions.gen_random_uuid(),
  entry_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  body text not null check (pg_catalog.char_length(pg_catalog.btrim(body)) between 3 and 4000),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (entry_id, organization_id)
    references public.casework_management_entries(id, organization_id) on delete restrict
);

create table public.casework_retaliation_reports (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  reporter_user_id uuid not null references auth.users(id) on delete restrict,
  case_id uuid,
  incident_at timestamptz not null,
  management_person text not null check (pg_catalog.char_length(pg_catalog.btrim(management_person)) between 2 and 200),
  protected_activity text not null check (pg_catalog.char_length(pg_catalog.btrim(protected_activity)) between 8 and 4000),
  adverse_action text not null check (pg_catalog.char_length(pg_catalog.btrim(adverse_action)) between 8 and 4000),
  requested_support text check (requested_support is null or pg_catalog.char_length(pg_catalog.btrim(requested_support)) between 3 and 2000),
  status text not null default 'submitted' check (status in ('submitted','in_review','withdrawn','closed')),
  withdrawn_at timestamptz,
  withdrawal_reason text,
  idempotency_key uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  foreign key (case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete restrict,
  unique (id, organization_id),
  unique (organization_id, reporter_user_id, idempotency_key),
  constraint casework_retaliation_withdrawal_coherent check (
    (status <> 'withdrawn' and withdrawn_at is null and withdrawal_reason is null)
    or (status = 'withdrawn' and withdrawn_at is not null and pg_catalog.char_length(pg_catalog.btrim(withdrawal_reason)) between 3 and 1000)
  )
);
create index casework_retaliation_reports_queue_idx
  on public.casework_retaliation_reports(organization_id, chapter_id, status, created_at desc);

create table public.casework_retaliation_patterns (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  fingerprint text not null,
  subject_label text not null check (pg_catalog.char_length(pg_catalog.btrim(subject_label)) between 2 and 200),
  report_count integer not null check (report_count >= 2),
  status text not null default 'flagged' check (status in ('flagged','investigating','substantiated','dismissed')),
  disposition text,
  detected_at timestamptz not null default pg_catalog.now(),
  reviewed_by uuid references auth.users(id) on delete restrict,
  reviewed_at timestamptz,
  unique (id, organization_id),
  unique (organization_id, fingerprint)
);

create table public.casework_retaliation_pattern_reports (
  pattern_id uuid not null,
  report_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  primary key (pattern_id, report_id),
  foreign key (pattern_id, organization_id)
    references public.casework_retaliation_patterns(id, organization_id) on delete cascade,
  foreign key (report_id, organization_id)
    references public.casework_retaliation_reports(id, organization_id) on delete restrict
);

create table public.casework_retaliation_pattern_notes (
  id uuid primary key default extensions.gen_random_uuid(),
  pattern_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  body text not null check (pg_catalog.char_length(pg_catalog.btrim(body)) between 3 and 4000),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (pattern_id, organization_id)
    references public.casework_retaliation_patterns(id, organization_id) on delete restrict
);

create table public.casework_intake_drafts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  member_user_id uuid references auth.users(id) on delete set null,
  case_id uuid,
  payload jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(payload) = 'object'),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  foreign key (case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete restrict
);
create index casework_intake_drafts_owner_idx
  on public.casework_intake_drafts(owner_user_id, updated_at desc);

create table public.casework_entity_links (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  source_case_id uuid not null,
  target_case_id uuid,
  target_kind text not null check (target_kind in ('case','management_person','retaliation_report','bargaining_workspace')),
  target_id uuid not null,
  relationship text not null check (pg_catalog.char_length(pg_catalog.btrim(relationship)) between 3 and 200),
  note text check (note is null or pg_catalog.char_length(pg_catalog.btrim(note)) between 3 and 2000),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (source_case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete cascade,
  foreign key (target_case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete cascade,
  constraint casework_entity_link_case_target check (
    (target_kind = 'case' and target_case_id = target_id and target_case_id is not null)
    or (target_kind <> 'case' and target_case_id is null)
  ),
  constraint casework_entity_link_not_self check (source_case_id <> target_case_id)
);
create index casework_entity_links_source_idx on public.casework_entity_links(source_case_id, created_at);

create table public.casework_reminders (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (pg_catalog.char_length(pg_catalog.btrim(title)) between 3 and 200),
  remind_at timestamptz not null,
  recurrence text not null default 'none' check (recurrence in ('none','daily','weekly','monthly')),
  status text not null default 'scheduled' check (status in ('scheduled','snoozed','completed','dismissed')),
  last_fired_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  foreign key (case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete cascade
);
create index casework_reminders_due_idx
  on public.casework_reminders(owner_user_id, status, remind_at);

create table public.casework_audit_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  case_id uuid,
  actor_user_id uuid references auth.users(id) on delete restrict,
  event_type text not null check (event_type in (
    'strength_scored','deadline_requested','deadline_decided','checklist_created','checklist_item_changed',
    'step_advanced','restriction_changed','access_granted','access_revoked',
    'alert_created','alert_acknowledged','alert_escalated','behavior_logged',
    'retaliation_submitted','retaliation_withdrawn','pattern_detected',
    'draft_saved','bulk_updated','entity_linked','reminder_changed',
    'bargaining_changed','behavior_addendum_added','pattern_reviewed'
  )),
  entity_type text not null,
  entity_id uuid not null,
  metadata jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete restrict,
  constraint casework_audit_metadata_bounded check (pg_catalog.pg_column_size(metadata) <= 8192)
);
create index casework_audit_events_scope_idx
  on public.casework_audit_events(organization_id, chapter_id, created_at desc);

-- Every table is deny-by-default. Access is derived from the case or current
-- organization/chapter membership; no caller-supplied tenant key is authority.
alter table public.casework_access_grants enable row level security;
alter table public.casework_strength_analyses enable row level security;
alter table public.casework_bargaining_workspaces enable row level security;
alter table public.casework_bargaining_proposals enable row level security;
alter table public.casework_bargaining_events enable row level security;
alter table public.casework_deadlines enable row level security;
alter table public.casework_deadline_extensions enable row level security;
alter table public.casework_checklist_templates enable row level security;
alter table public.casework_checklists enable row level security;
alter table public.casework_checklist_items enable row level security;
alter table public.casework_step_transitions enable row level security;
alter table public.casework_alerts enable row level security;
alter table public.casework_alert_acknowledgements enable row level security;
alter table public.casework_management_people enable row level security;
alter table public.casework_management_entries enable row level security;
alter table public.casework_management_addenda enable row level security;
alter table public.casework_retaliation_reports enable row level security;
alter table public.casework_retaliation_patterns enable row level security;
alter table public.casework_retaliation_pattern_reports enable row level security;
alter table public.casework_retaliation_pattern_notes enable row level security;
alter table public.casework_intake_drafts enable row level security;
alter table public.casework_entity_links enable row level security;
alter table public.casework_reminders enable row level security;
alter table public.casework_audit_events enable row level security;

do $mfa$
declare v_table text;
begin
  foreach v_table in array array[
    'casework_access_grants', 'casework_strength_analyses',
    'casework_bargaining_workspaces', 'casework_bargaining_proposals', 'casework_bargaining_events',
    'casework_deadlines', 'casework_deadline_extensions',
    'casework_checklist_templates', 'casework_checklists', 'casework_checklist_items',
    'casework_step_transitions', 'casework_alerts', 'casework_alert_acknowledgements',
    'casework_management_people', 'casework_management_entries', 'casework_management_addenda',
    'casework_retaliation_reports', 'casework_retaliation_patterns',
    'casework_retaliation_pattern_reports', 'casework_retaliation_pattern_notes',
    'casework_intake_drafts', 'casework_entity_links', 'casework_reminders', 'casework_audit_events'
  ] loop
    execute pg_catalog.format(
      'create policy mfa_assurance on public.%I as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()))',
      v_table
    );
    execute pg_catalog.format(
      'revoke all on table public.%I from public, anon, authenticated',
      v_table
    );
  end loop;
end;
$mfa$;

create policy casework_access_grants_read on public.casework_access_grants
  for select to authenticated using (
    grantee_user_id = (select auth.uid())
    or exists (
      select 1
      from public.member_cases c
      where c.id = casework_access_grants.case_id
        and c.organization_id = casework_access_grants.organization_id
        and c.chapter_id = casework_access_grants.chapter_id
        and (
          c.steward_user_id = (select auth.uid())
          or c.coordinator_user_id = (select auth.uid())
          or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
        )
    )
  );

create policy casework_strength_read on public.casework_strength_analyses
  for select to authenticated using (private.casework_staff_can_access(case_id));
create policy casework_bargaining_workspaces_staff on public.casework_bargaining_workspaces
  for all to authenticated
  using (private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp']))
  with check (
    private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp'])
    and created_by = (select auth.uid())
  );
create policy casework_bargaining_proposals_staff on public.casework_bargaining_proposals
  for all to authenticated
  using (exists (
    select 1 from public.casework_bargaining_workspaces w
    where w.id = casework_bargaining_proposals.workspace_id
      and w.organization_id = casework_bargaining_proposals.organization_id
      and private.member_has_chapter_role(w.chapter_id, array['steward','coordinator','advisor','admin','vp'])
  ))
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from public.casework_bargaining_workspaces w
      where w.id = casework_bargaining_proposals.workspace_id
        and w.organization_id = casework_bargaining_proposals.organization_id
        and private.member_has_chapter_role(w.chapter_id, array['steward','coordinator','advisor','admin','vp'])
    )
  );
create policy casework_bargaining_events_staff on public.casework_bargaining_events
  for select to authenticated
  using (exists (
    select 1 from public.casework_bargaining_workspaces w
    where w.id = casework_bargaining_events.workspace_id
      and w.organization_id = casework_bargaining_events.organization_id
      and private.member_has_chapter_role(w.chapter_id, array['steward','coordinator','advisor','admin','vp'])
  ));
create policy casework_bargaining_events_insert on public.casework_bargaining_events
  for insert to authenticated with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from public.casework_bargaining_workspaces w
      where w.id = casework_bargaining_events.workspace_id
        and w.organization_id = casework_bargaining_events.organization_id
        and private.member_has_chapter_role(w.chapter_id, array['steward','coordinator','advisor','admin','vp'])
    )
  );

create policy casework_deadlines_read on public.casework_deadlines
  for select to authenticated using (private.casework_can_read(case_id));
create policy casework_deadlines_staff_write on public.casework_deadlines
  for all to authenticated
  using (private.casework_staff_can_access(case_id))
  with check (
    private.casework_staff_can_access(case_id)
    and private.casework_scope_matches(case_id, organization_id, chapter_id)
    and created_by = (select auth.uid())
  );
create policy casework_deadline_extensions_read on public.casework_deadline_extensions
  for select to authenticated using (
    exists (select 1 from public.casework_deadlines d where d.id = casework_deadline_extensions.deadline_id and d.organization_id = casework_deadline_extensions.organization_id and private.casework_can_read(d.case_id))
  );

create policy casework_checklist_templates_staff on public.casework_checklist_templates
  for select to authenticated
  using (private.has_organization_role(organization_id, array['steward','coordinator','advisor','admin','vp']));
create policy casework_checklists_read on public.casework_checklists
  for select to authenticated using (private.casework_can_read(case_id));
create policy casework_checklists_staff on public.casework_checklists
  for insert to authenticated with check (
    private.casework_staff_can_access(case_id)
    and private.casework_scope_matches(case_id, organization_id, chapter_id)
    and created_by = (select auth.uid())
  );
create policy casework_checklist_items_read on public.casework_checklist_items
  for select to authenticated using (
    exists (select 1 from public.casework_checklists c where c.id = casework_checklist_items.checklist_id and c.organization_id = casework_checklist_items.organization_id and private.casework_can_read(c.case_id))
  );
create policy casework_step_transitions_read on public.casework_step_transitions
  for select to authenticated using (private.casework_can_read(case_id));

create policy casework_alerts_read on public.casework_alerts
  for select to authenticated using (private.casework_staff_can_access(case_id));
create policy casework_alerts_create on public.casework_alerts
  for insert to authenticated
  with check (
    private.casework_staff_can_access(case_id)
    and private.casework_scope_matches(case_id, organization_id, chapter_id)
    and created_by = (select auth.uid())
  );
create policy casework_alert_acknowledgements_read on public.casework_alert_acknowledgements
  for select to authenticated using (
    exists (select 1 from public.casework_alerts a where a.id = casework_alert_acknowledgements.alert_id and a.organization_id = casework_alert_acknowledgements.organization_id and private.casework_staff_can_access(a.case_id))
  );

create policy casework_management_people_staff on public.casework_management_people
  for all to authenticated
  using (private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp']))
  with check (
    private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp'])
    and created_by = (select auth.uid())
  );
create policy casework_management_entries_staff on public.casework_management_entries
  for select to authenticated using (
    private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp'])
    and (case_id is null or private.casework_staff_can_access(case_id))
  );
create policy casework_management_entries_insert on public.casework_management_entries
  for insert to authenticated with check (
    private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp'])
    and created_by = (select auth.uid())
    and (case_id is null or private.casework_scope_matches(case_id, organization_id, chapter_id))
  );
create policy casework_management_addenda_staff on public.casework_management_addenda
  for select to authenticated using (
    exists (select 1 from public.casework_management_entries e where e.id = casework_management_addenda.entry_id and e.organization_id = casework_management_addenda.organization_id
      and private.member_has_chapter_role(e.chapter_id, array['steward','coordinator','advisor','admin','vp']))
  );
create policy casework_management_addenda_insert on public.casework_management_addenda
  for insert to authenticated with check (
    created_by = (select auth.uid())
    and exists (select 1 from public.casework_management_entries e where e.id = casework_management_addenda.entry_id and e.organization_id = casework_management_addenda.organization_id
      and private.member_has_chapter_role(e.chapter_id, array['steward','coordinator','advisor','admin','vp']))
  );

create policy casework_retaliation_reports_read on public.casework_retaliation_reports
  for select to authenticated using (
    reporter_user_id = (select auth.uid())
    or (
      private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp'])
      and (case_id is null or private.casework_staff_can_access(case_id))
    )
  );
create policy casework_retaliation_patterns_staff on public.casework_retaliation_patterns
  for all to authenticated
  using ((chapter_id is not null and private.member_has_chapter_role(chapter_id, array['coordinator','advisor','admin','vp'])) or private.has_organization_role(organization_id, array['coordinator','advisor','admin','vp']))
  with check ((chapter_id is not null and private.member_has_chapter_role(chapter_id, array['coordinator','advisor','admin','vp'])) or private.has_organization_role(organization_id, array['coordinator','advisor','admin','vp']));
create policy casework_retaliation_pattern_reports_staff on public.casework_retaliation_pattern_reports
  for all to authenticated
  using (exists (select 1 from public.casework_retaliation_patterns p where p.id = casework_retaliation_pattern_reports.pattern_id and p.organization_id = casework_retaliation_pattern_reports.organization_id and ((p.chapter_id is not null and private.member_has_chapter_role(p.chapter_id, array['coordinator','advisor','admin','vp'])) or private.has_organization_role(p.organization_id, array['coordinator','advisor','admin','vp']))))
  with check (exists (select 1 from public.casework_retaliation_patterns p where p.id = casework_retaliation_pattern_reports.pattern_id and p.organization_id = casework_retaliation_pattern_reports.organization_id and ((p.chapter_id is not null and private.member_has_chapter_role(p.chapter_id, array['coordinator','advisor','admin','vp'])) or private.has_organization_role(p.organization_id, array['coordinator','advisor','admin','vp']))));
create policy casework_retaliation_pattern_notes_staff on public.casework_retaliation_pattern_notes
  for select to authenticated using (exists (select 1 from public.casework_retaliation_patterns p where p.id = casework_retaliation_pattern_notes.pattern_id and p.organization_id = casework_retaliation_pattern_notes.organization_id and ((p.chapter_id is not null and private.member_has_chapter_role(p.chapter_id, array['coordinator','advisor','admin','vp'])) or private.has_organization_role(p.organization_id, array['coordinator','advisor','admin','vp']))));
create policy casework_retaliation_pattern_notes_insert on public.casework_retaliation_pattern_notes
  for insert to authenticated with check (
    created_by = (select auth.uid())
    and exists (select 1 from public.casework_retaliation_patterns p where p.id = casework_retaliation_pattern_notes.pattern_id and p.organization_id = casework_retaliation_pattern_notes.organization_id and ((p.chapter_id is not null and private.member_has_chapter_role(p.chapter_id, array['coordinator','advisor','admin','vp'])) or private.has_organization_role(p.organization_id, array['coordinator','advisor','admin','vp'])))
  );

create policy casework_intake_drafts_owner on public.casework_intake_drafts
  for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    and private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp'])
  );
create policy casework_entity_links_read on public.casework_entity_links
  for select to authenticated using (
    private.casework_staff_can_access(source_case_id)
    and (target_case_id is null or private.casework_staff_can_access(target_case_id))
  );
create policy casework_entity_links_insert on public.casework_entity_links
  for insert to authenticated with check (
    created_by = (select auth.uid())
    and private.casework_staff_can_access(source_case_id)
    and private.casework_scope_matches(source_case_id, organization_id, chapter_id)
    and (target_case_id is null or private.casework_staff_can_access(target_case_id))
  );
create policy casework_reminders_owner on public.casework_reminders
  for all to authenticated
  using (owner_user_id = (select auth.uid()) and private.casework_can_read(case_id))
  with check (
    owner_user_id = (select auth.uid())
    and private.casework_can_read(case_id)
    and private.casework_scope_matches(case_id, organization_id, chapter_id)
  );
create policy casework_audit_events_staff_read on public.casework_audit_events
  for select to authenticated using (
    private.has_organization_role(organization_id, array['coordinator','advisor','admin','vp'])
    or (case_id is not null and private.casework_staff_can_access(case_id))
  );

-- Immutable evidence tables have no UPDATE/DELETE policy or grant.
grant select on public.casework_access_grants to authenticated;
grant select on public.casework_strength_analyses to authenticated;
grant select on public.casework_bargaining_workspaces to authenticated;
grant select on public.casework_bargaining_proposals to authenticated;
grant select on public.casework_bargaining_events to authenticated;
grant select, insert on public.casework_deadlines to authenticated;
grant select on public.casework_deadline_extensions to authenticated;
grant select on public.casework_checklist_templates to authenticated;
grant select, insert on public.casework_checklists to authenticated;
grant select on public.casework_checklist_items to authenticated;
grant select on public.casework_step_transitions to authenticated;
grant select, insert on public.casework_alerts to authenticated;
grant select on public.casework_alert_acknowledgements to authenticated;
grant select on public.casework_management_people to authenticated;
grant select on public.casework_management_entries to authenticated;
grant select on public.casework_management_addenda to authenticated;
grant select on public.casework_retaliation_reports to authenticated;
grant select on public.casework_retaliation_patterns to authenticated;
grant select on public.casework_retaliation_pattern_reports to authenticated;
grant select on public.casework_retaliation_pattern_notes to authenticated;
grant select on public.casework_intake_drafts to authenticated;
grant select on public.casework_entity_links to authenticated;
grant select, insert, update, delete on public.casework_reminders to authenticated;
grant select on public.casework_audit_events to authenticated;

create or replace function public.casework_score_case(
  p_case_id uuid,
  p_inputs jsonb,
  p_idempotency_key uuid
)
returns public.casework_strength_analyses
language plpgsql security definer set search_path = '' as $function$
declare
  v_case public.member_cases%rowtype;
  v_score integer;
  v_row public.casework_strength_analyses%rowtype;
  v_recommendations jsonb := '[]'::jsonb;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_access(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_inputs is null or pg_catalog.jsonb_typeof(p_inputs) <> 'object'
     or p_inputs - array['facts','documentation','timeliness','contract_support','witnesses'] <> '{}'::jsonb then
    raise exception 'invalid scoring inputs' using errcode = '22023';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id for share;
  v_score := 4 * (
    greatest(0, least(5, coalesce((p_inputs->>'facts')::integer, 0)))
    + greatest(0, least(5, coalesce((p_inputs->>'documentation')::integer, 0)))
    + greatest(0, least(5, coalesce((p_inputs->>'timeliness')::integer, 0)))
    + greatest(0, least(5, coalesce((p_inputs->>'contract_support')::integer, 0)))
    + greatest(0, least(5, coalesce((p_inputs->>'witnesses')::integer, 0)))
  );
  if coalesce((p_inputs->>'documentation')::integer, 0) < 3 then v_recommendations := v_recommendations || '["strengthen_documentation"]'::jsonb; end if;
  if coalesce((p_inputs->>'timeliness')::integer, 0) < 3 then v_recommendations := v_recommendations || '["review_deadlines"]'::jsonb; end if;
  if coalesce((p_inputs->>'contract_support')::integer, 0) < 3 then v_recommendations := v_recommendations || '["confirm_contract_support"]'::jsonb; end if;
  insert into public.casework_strength_analyses(case_id, organization_id, chapter_id, analyzed_by, inputs, score, band, recommendations, idempotency_key)
  values (v_case.id, v_case.organization_id, v_case.chapter_id, (select auth.uid()), p_inputs, v_score,
    case when v_score < 45 then 'needs_evidence' when v_score < 75 then 'developing' else 'strong' end,
    v_recommendations, p_idempotency_key)
  on conflict (organization_id, analyzed_by, idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'strength_scored', 'strength_analysis', v_row.id, pg_catalog.jsonb_build_object('score', v_row.score, 'band', v_row.band));
  return v_row;
exception when invalid_text_representation then raise exception 'scoring inputs must be integers' using errcode = '22023';
end;
$function$;

create or replace function public.casework_request_deadline_extension(
  p_deadline_id uuid,
  p_requested_due_at timestamptz,
  p_reason text,
  p_idempotency_key uuid
)
returns public.casework_deadline_extensions
language plpgsql security definer set search_path = '' as $function$
declare v_deadline public.casework_deadlines%rowtype; v_row public.casework_deadline_extensions%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_deadline from public.casework_deadlines where id = p_deadline_id for share;
  if not private.casework_can_read(v_deadline.case_id) then raise exception 'deadline not found' using errcode = 'P0002'; end if;
  if p_requested_due_at <= v_deadline.due_at or pg_catalog.char_length(pg_catalog.btrim(p_reason)) not between 8 and 2000 then raise exception 'invalid extension request' using errcode = '22023'; end if;
  insert into public.casework_deadline_extensions(deadline_id, organization_id, requested_by, previous_due_at, requested_due_at, reason, idempotency_key)
  values (v_deadline.id, v_deadline.organization_id, (select auth.uid()), v_deadline.due_at, p_requested_due_at, pg_catalog.btrim(p_reason), p_idempotency_key)
  on conflict (organization_id, requested_by, idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_deadline.organization_id, v_deadline.chapter_id, v_deadline.case_id, (select auth.uid()), 'deadline_requested', 'deadline_extension', v_row.id, pg_catalog.jsonb_build_object('deadlineId', v_deadline.id));
  return v_row;
end;
$function$;

create or replace function public.casework_decide_deadline_extension(
  p_extension_id uuid,
  p_decision text,
  p_note text default null
)
returns public.casework_deadline_extensions
language plpgsql security definer set search_path = '' as $function$
declare v_extension public.casework_deadline_extensions%rowtype; v_deadline public.casework_deadlines%rowtype;
begin
  perform private.casework_require_mfa();
  if p_decision not in ('approved','denied') then raise exception 'invalid decision' using errcode = '22023'; end if;
  select * into strict v_extension from public.casework_deadline_extensions where id = p_extension_id for update;
  select * into strict v_deadline from public.casework_deadlines where id = v_extension.deadline_id for update;
  if not private.casework_staff_can_access(v_deadline.case_id) then raise exception 'extension not found' using errcode = 'P0002'; end if;
  if v_extension.status <> 'requested' then return v_extension; end if;
  update public.casework_deadline_extensions set status = p_decision, decided_by = (select auth.uid()), decided_at = pg_catalog.now(), decision_note = nullif(pg_catalog.btrim(p_note), '')
  where id = v_extension.id returning * into v_extension;
  if p_decision = 'approved' then
    update public.casework_deadlines set due_at = v_extension.requested_due_at, status = 'extended', updated_at = pg_catalog.now() where id = v_deadline.id;
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_deadline.organization_id, v_deadline.chapter_id, v_deadline.case_id, (select auth.uid()), 'deadline_decided', 'deadline_extension', v_extension.id, pg_catalog.jsonb_build_object('decision', p_decision));
  return v_extension;
end;
$function$;

create or replace function public.casework_advance_step(
  p_case_id uuid,
  p_expected_step text,
  p_next_step text,
  p_outcome text,
  p_idempotency_key uuid
)
returns public.casework_step_transitions
language plpgsql security definer set search_path = '' as $function$
declare v_case public.member_cases%rowtype; v_transition public.casework_step_transitions%rowtype; v_template public.casework_checklist_templates%rowtype; v_checklist_id uuid;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_access(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if pg_catalog.char_length(pg_catalog.btrim(p_next_step)) not between 2 and 100 or p_next_step = p_expected_step then raise exception 'invalid next step' using errcode = '22023'; end if;
  select * into strict v_case from public.member_cases where id = p_case_id for update;
  select * into v_transition from public.casework_step_transitions where organization_id = v_case.organization_id and transitioned_by = (select auth.uid()) and idempotency_key = p_idempotency_key;
  if found then return v_transition; end if;
  if v_case.step <> p_expected_step then raise exception 'case step changed' using errcode = '40001'; end if;
  insert into public.casework_step_transitions(case_id, organization_id, chapter_id, from_step, to_step, outcome, transitioned_by, idempotency_key)
  values (v_case.id, v_case.organization_id, v_case.chapter_id, v_case.step, pg_catalog.btrim(p_next_step), pg_catalog.btrim(p_outcome), (select auth.uid()), p_idempotency_key)
  returning * into v_transition;
  update public.member_cases set step = pg_catalog.btrim(p_next_step), updated_at = pg_catalog.now() where id = v_case.id;
  select * into v_template from public.casework_checklist_templates t
  where t.organization_id = v_case.organization_id and (t.chapter_id is null or t.chapter_id = v_case.chapter_id)
    and t.case_type = v_case.case_type and t.step = pg_catalog.btrim(p_next_step) and t.active
  order by (t.chapter_id is not null) desc, t.updated_at desc limit 1;
  if found then
    insert into public.casework_checklists(case_id, organization_id, chapter_id, template_id, step, title, created_by)
    values (v_case.id, v_case.organization_id, v_case.chapter_id, v_template.id, p_next_step, v_template.title, (select auth.uid())) returning id into v_checklist_id;
    insert into public.casework_checklist_items(checklist_id, organization_id, label, position, required)
    select v_checklist_id, v_case.organization_id, item->>'label', (ordinality - 1)::integer, coalesce((item->>'required')::boolean, true)
    from pg_catalog.jsonb_array_elements(v_template.items) with ordinality as x(item, ordinality);
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'step_advanced', 'step_transition', v_transition.id, pg_catalog.jsonb_build_object('fromStep', v_case.step, 'toStep', p_next_step, 'checklistId', v_checklist_id));
  return v_transition;
end;
$function$;

create or replace function public.casework_acknowledge_alert(p_alert_id uuid, p_note text default null)
returns public.casework_alerts
language plpgsql security definer set search_path = '' as $function$
declare v_alert public.casework_alerts%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_alert from public.casework_alerts where id = p_alert_id for update;
  if not private.casework_staff_can_access(v_alert.case_id) then raise exception 'alert not found' using errcode = 'P0002'; end if;
  insert into public.casework_alert_acknowledgements(alert_id, organization_id, acknowledged_by, note)
  values (v_alert.id, v_alert.organization_id, (select auth.uid()), nullif(pg_catalog.btrim(p_note), '')) on conflict (alert_id, acknowledged_by) do nothing;
  if v_alert.status = 'open' then update public.casework_alerts set status = 'acknowledged' where id = v_alert.id returning * into v_alert; end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_alert.organization_id, v_alert.chapter_id, v_alert.case_id, (select auth.uid()), 'alert_acknowledged', 'alert', v_alert.id);
  return v_alert;
end;
$function$;

create or replace function public.casework_set_restriction(
  p_case_id uuid,
  p_restricted boolean,
  p_reason text
)
returns public.member_cases
language plpgsql security definer set search_path = '' as $function$
declare v_case public.member_cases%rowtype;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_access(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_restricted and pg_catalog.char_length(pg_catalog.btrim(p_reason)) not between 8 and 500 then raise exception 'restriction reason is required' using errcode = '22023'; end if;
  update public.member_cases set
    is_restricted = p_restricted,
    restriction_reason = case when p_restricted then pg_catalog.btrim(p_reason) else null end,
    restricted_at = case when p_restricted then pg_catalog.now() else null end,
    restricted_by = case when p_restricted then (select auth.uid()) else null end,
    updated_at = pg_catalog.now()
  where id = p_case_id returning * into v_case;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'restriction_changed', 'case', v_case.id, pg_catalog.jsonb_build_object('restricted', p_restricted));
  return v_case;
end;
$function$;

create or replace function public.casework_grant_access(p_case_id uuid, p_grantee_user_id uuid)
returns public.casework_access_grants
language plpgsql security definer set search_path = '' as $function$
declare v_case public.member_cases%rowtype; v_row public.casework_access_grants%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_case from public.member_cases where id = p_case_id for share;
  if not private.casework_staff_can_access(v_case.id)
     or not (private.member_has_chapter_role(v_case.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role(v_case.organization_id, array['advisor','admin','vp']))
  then raise exception 'case not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.organization_memberships m where m.organization_id = v_case.organization_id and m.user_id = p_grantee_user_id and m.status = 'active')
     or not private.actor_has_chapter_staff_role(p_grantee_user_id, v_case.chapter_id)
  then raise exception 'grantee is not active chapter staff' using errcode = '22023'; end if;
  select * into v_row from public.casework_access_grants where case_id = v_case.id and grantee_user_id = p_grantee_user_id and revoked_at is null;
  if found then return v_row; end if;
  insert into public.casework_access_grants(case_id, organization_id, chapter_id, grantee_user_id, granted_by)
  values (v_case.id, v_case.organization_id, v_case.chapter_id, p_grantee_user_id, (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'access_granted', 'casework_access_grant', v_row.id, pg_catalog.jsonb_build_object('granteeUserId', p_grantee_user_id));
  return v_row;
end;
$function$;

create or replace function public.casework_revoke_access(p_grant_id uuid)
returns public.casework_access_grants
language plpgsql security definer set search_path = '' as $function$
declare v_row public.casework_access_grants%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_row from public.casework_access_grants where id = p_grant_id for update;
  if not private.casework_staff_can_access(v_row.case_id)
     or not (private.member_has_chapter_role(v_row.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role(v_row.organization_id, array['advisor','admin','vp']))
  then raise exception 'grant not found' using errcode = 'P0002'; end if;
  if v_row.revoked_at is not null then return v_row; end if;
  update public.casework_access_grants set revoked_at = pg_catalog.now(), revoked_by = (select auth.uid()) where id = v_row.id returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()), 'access_revoked', 'casework_access_grant', v_row.id, pg_catalog.jsonb_build_object('granteeUserId', v_row.grantee_user_id));
  return v_row;
end;
$function$;

create or replace function public.casework_save_intake_draft(
  p_draft_id uuid,
  p_chapter_id text,
  p_member_user_id uuid,
  p_case_id uuid,
  p_payload jsonb,
  p_expected_revision integer
)
returns public.casework_intake_drafts
language plpgsql security definer set search_path = '' as $function$
declare v_org uuid; v_row public.casework_intake_drafts%rowtype;
begin
  perform private.casework_require_mfa();
  select c.organization_id into strict v_org from public.chapters c where c.id = p_chapter_id;
  if v_org is null or not private.member_has_chapter_role(p_chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' or pg_catalog.pg_column_size(p_payload) > 32768 then raise exception 'invalid draft payload' using errcode = '22023'; end if;
  if p_case_id is not null and not private.casework_scope_matches(p_case_id, v_org, p_chapter_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_draft_id is null then
    insert into public.casework_intake_drafts(organization_id, chapter_id, owner_user_id, member_user_id, case_id, payload)
    values (v_org, p_chapter_id, (select auth.uid()), p_member_user_id, p_case_id, p_payload) returning * into v_row;
  else
    update public.casework_intake_drafts set member_user_id = p_member_user_id, case_id = p_case_id, payload = p_payload, revision = revision + 1, updated_at = pg_catalog.now()
    where id = p_draft_id and owner_user_id = (select auth.uid()) and revision = p_expected_revision returning * into v_row;
    if not found then raise exception 'draft changed' using errcode = '40001'; end if;
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, p_chapter_id, p_case_id, (select auth.uid()), 'draft_saved', 'intake_draft', v_row.id, pg_catalog.jsonb_build_object('revision', v_row.revision));
  return v_row;
end;
$function$;

create or replace function public.casework_submit_retaliation_report(
  p_case_id uuid,
  p_incident_at timestamptz,
  p_management_person text,
  p_protected_activity text,
  p_adverse_action text,
  p_requested_support text,
  p_idempotency_key uuid
)
returns public.casework_retaliation_reports
language plpgsql security definer set search_path = '' as $function$
declare v_case public.member_cases%rowtype; v_row public.casework_retaliation_reports%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_case from public.member_cases where id = p_case_id and user_id = (select auth.uid()) for share;
  if v_case.organization_id is null or v_case.chapter_id is null then raise exception 'case not found' using errcode = 'P0002'; end if;
  insert into public.casework_retaliation_reports(organization_id, chapter_id, reporter_user_id, case_id, incident_at, management_person, protected_activity, adverse_action, requested_support, idempotency_key)
  values (v_case.organization_id, v_case.chapter_id, (select auth.uid()), v_case.id, p_incident_at, pg_catalog.btrim(p_management_person), pg_catalog.btrim(p_protected_activity), pg_catalog.btrim(p_adverse_action), nullif(pg_catalog.btrim(p_requested_support), ''), p_idempotency_key)
  on conflict (organization_id, reporter_user_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'retaliation_submitted', 'retaliation_report', v_row.id);
  return v_row;
end;
$function$;

create or replace function public.casework_withdraw_retaliation_report(p_report_id uuid, p_reason text)
returns public.casework_retaliation_reports
language plpgsql security definer set search_path = '' as $function$
declare v_row public.casework_retaliation_reports%rowtype;
begin
  perform private.casework_require_mfa();
  update public.casework_retaliation_reports set status = 'withdrawn', withdrawn_at = pg_catalog.now(), withdrawal_reason = pg_catalog.btrim(p_reason), updated_at = pg_catalog.now()
  where id = p_report_id and reporter_user_id = (select auth.uid()) and status = 'submitted' returning * into v_row;
  if not found then raise exception 'report not found or cannot be withdrawn' using errcode = 'P0002'; end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()), 'retaliation_withdrawn', 'retaliation_report', v_row.id);
  return v_row;
end;
$function$;

create or replace function public.casework_bulk_update_cases(
  p_case_ids uuid[],
  p_expected_status text,
  p_next_status text,
  p_next_step text,
  p_idempotency_key uuid
)
returns integer
language plpgsql security definer set search_path = '' as $function$
declare v_count integer; v_org_count integer; v_case record;
begin
  perform private.casework_require_mfa();
  if coalesce(pg_catalog.array_length(p_case_ids, 1), 0) not between 1 and 100 then raise exception 'select 1 to 100 cases' using errcode = '22023'; end if;
  if p_next_status is not null and p_next_status not in ('active','resolved') then raise exception 'invalid status' using errcode = '22023'; end if;
  select pg_catalog.count(*), pg_catalog.count(distinct organization_id) into v_count, v_org_count
  from public.member_cases c where c.id = any(p_case_ids) and private.casework_staff_can_access(c.id);
  if v_count <> pg_catalog.array_length(p_case_ids, 1) or v_org_count <> 1 then raise exception 'case selection is not authorized' using errcode = 'P0002'; end if;
  perform 1 from public.member_cases c where c.id = any(p_case_ids) order by c.id for update;
  if exists (select 1 from public.member_cases c where c.id = any(p_case_ids) and c.status <> p_expected_status) then raise exception 'case status changed' using errcode = '40001'; end if;
  update public.member_cases set status = coalesce(p_next_status, status), step = coalesce(nullif(pg_catalog.btrim(p_next_step), ''), step), updated_at = pg_catalog.now() where id = any(p_case_ids);
  for v_case in select id, organization_id, chapter_id from public.member_cases where id = any(p_case_ids) loop
    insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'bulk_updated', 'case', v_case.id, pg_catalog.jsonb_build_object('operationId', p_idempotency_key, 'status', p_next_status, 'step', p_next_step));
  end loop;
  return v_count;
end;
$function$;

create or replace function public.casework_create_checklist_template(
  p_chapter_id text, p_case_type text, p_step text, p_title text, p_items jsonb
)
returns public.casework_checklist_templates
language plpgsql security definer set search_path = '' as $function$
declare v_org uuid; v_row public.casework_checklist_templates%rowtype;
begin
  perform private.casework_require_mfa();
  select c.organization_id into strict v_org from public.chapters c where c.id = p_chapter_id;
  if not private.member_has_chapter_role(p_chapter_id, array['coordinator','advisor','admin','vp']) then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' or pg_catalog.jsonb_array_length(p_items) not between 1 and 50
    or exists (select 1 from pg_catalog.jsonb_array_elements(p_items) item where pg_catalog.jsonb_typeof(item) <> 'object' or pg_catalog.char_length(pg_catalog.btrim(item->>'label')) not between 1 and 300)
  then raise exception 'invalid checklist items' using errcode = '22023'; end if;
  insert into public.casework_checklist_templates(organization_id, chapter_id, case_type, step, title, items, created_by)
  values (v_org, p_chapter_id, pg_catalog.btrim(p_case_type), pg_catalog.btrim(p_step), pg_catalog.btrim(p_title), p_items, (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_org, p_chapter_id, (select auth.uid()), 'checklist_created', 'checklist_template', v_row.id);
  return v_row;
end;
$function$;

create or replace function public.casework_set_checklist_item(p_item_id uuid, p_completed boolean)
returns public.casework_checklist_items
language plpgsql security definer set search_path = '' as $function$
declare v_item public.casework_checklist_items%rowtype; v_checklist public.casework_checklists%rowtype;
begin
  perform private.casework_require_mfa();
  select c.* into strict v_checklist
  from public.casework_checklists c join public.casework_checklist_items i on i.checklist_id = c.id
  where i.id = p_item_id for update of c;
  if not private.casework_staff_can_access(v_checklist.case_id) then raise exception 'checklist item not found' using errcode = 'P0002'; end if;
  update public.casework_checklist_items set
    completed_at = case when p_completed then pg_catalog.now() else null end,
    completed_by = case when p_completed then (select auth.uid()) else null end
  where id = p_item_id returning * into v_item;
  update public.casework_checklists set completed_at = case
    when exists (select 1 from public.casework_checklist_items i where i.checklist_id = v_checklist.id and i.completed_at is null) then null
    else pg_catalog.now()
  end where id = v_checklist.id;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_checklist.organization_id, v_checklist.chapter_id, v_checklist.case_id, (select auth.uid()), 'checklist_item_changed', 'checklist_item', v_item.id, pg_catalog.jsonb_build_object('completed', p_completed));
  return v_item;
end;
$function$;

create or replace function public.casework_create_bargaining_workspace(p_chapter_id text, p_title text, p_starts_at timestamptz)
returns public.casework_bargaining_workspaces
language plpgsql security definer set search_path = '' as $function$
declare v_org uuid; v_row public.casework_bargaining_workspaces%rowtype;
begin
  perform private.casework_require_mfa();
  select c.organization_id into strict v_org from public.chapters c where c.id = p_chapter_id;
  if not private.member_has_chapter_role(p_chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  insert into public.casework_bargaining_workspaces(organization_id, chapter_id, title, starts_at, created_by)
  values (v_org, p_chapter_id, pg_catalog.btrim(p_title), p_starts_at, (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, p_chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_workspace', v_row.id, pg_catalog.jsonb_build_object('status', v_row.status));
  return v_row;
end;
$function$;

create or replace function public.casework_add_bargaining_proposal(
  p_workspace_id uuid, p_side text, p_title text, p_body text, p_response_due_at timestamptz
)
returns public.casework_bargaining_proposals
language plpgsql security definer set search_path = '' as $function$
declare v_workspace public.casework_bargaining_workspaces%rowtype; v_row public.casework_bargaining_proposals%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_workspace from public.casework_bargaining_workspaces where id = p_workspace_id for share;
  if not private.member_has_chapter_role(v_workspace.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  insert into public.casework_bargaining_proposals(workspace_id, organization_id, side, title, body, response_due_at, created_by)
  values (v_workspace.id, v_workspace.organization_id, p_side, pg_catalog.btrim(p_title), pg_catalog.btrim(p_body), p_response_due_at, (select auth.uid())) returning * into v_row;
  insert into public.casework_bargaining_events(workspace_id, organization_id, proposal_id, event_type, body, created_by)
  values (v_workspace.id, v_workspace.organization_id, v_row.id, 'proposal_status', 'Proposal created as draft', (select auth.uid()));
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_workspace.organization_id, v_workspace.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_proposal', v_row.id, pg_catalog.jsonb_build_object('status', v_row.status));
  return v_row;
end;
$function$;

create or replace function public.casework_transition_bargaining_proposal(
  p_proposal_id uuid, p_expected_status text, p_next_status text, p_response_due_at timestamptz
)
returns public.casework_bargaining_proposals
language plpgsql security definer set search_path = '' as $function$
declare v_workspace public.casework_bargaining_workspaces%rowtype; v_row public.casework_bargaining_proposals%rowtype;
begin
  perform private.casework_require_mfa();
  if p_next_status not in ('draft','proposed','countered','tentative','accepted','rejected','withdrawn') then raise exception 'invalid proposal status' using errcode = '22023'; end if;
  select * into strict v_row from public.casework_bargaining_proposals where id = p_proposal_id for update;
  select * into strict v_workspace from public.casework_bargaining_workspaces where id = v_row.workspace_id;
  if not private.member_has_chapter_role(v_workspace.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'proposal not found' using errcode = 'P0002'; end if;
  if v_row.status <> p_expected_status then raise exception 'proposal changed' using errcode = '40001'; end if;
  update public.casework_bargaining_proposals set status = p_next_status, response_due_at = p_response_due_at, updated_at = pg_catalog.now() where id = v_row.id returning * into v_row;
  insert into public.casework_bargaining_events(workspace_id, organization_id, proposal_id, event_type, body, created_by)
  values (v_workspace.id, v_workspace.organization_id, v_row.id, 'proposal_status', p_expected_status || ' → ' || p_next_status, (select auth.uid()));
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_workspace.organization_id, v_workspace.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_proposal', v_row.id, pg_catalog.jsonb_build_object('fromStatus', p_expected_status, 'toStatus', p_next_status));
  return v_row;
end;
$function$;

create or replace function public.casework_add_bargaining_event(
  p_workspace_id uuid, p_event_type text, p_body text, p_pulse text
)
returns public.casework_bargaining_events
language plpgsql security definer set search_path = '' as $function$
declare v_workspace public.casework_bargaining_workspaces%rowtype; v_row public.casework_bargaining_events%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_workspace from public.casework_bargaining_workspaces where id = p_workspace_id for share;
  if not private.member_has_chapter_role(v_workspace.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  insert into public.casework_bargaining_events(workspace_id, organization_id, event_type, body, pulse, created_by)
  values (v_workspace.id, v_workspace.organization_id, p_event_type, pg_catalog.btrim(p_body), p_pulse, (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_workspace.organization_id, v_workspace.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_event', v_row.id, pg_catalog.jsonb_build_object('eventType', p_event_type, 'pulse', p_pulse));
  return v_row;
end;
$function$;

create or replace function public.casework_set_bargaining_status(p_workspace_id uuid, p_expected_status text, p_next_status text)
returns public.casework_bargaining_workspaces
language plpgsql security definer set search_path = '' as $function$
declare v_row public.casework_bargaining_workspaces%rowtype;
begin
  perform private.casework_require_mfa();
  if p_next_status not in ('planning','live','paused','tentative_agreement','closed') then raise exception 'invalid session status' using errcode = '22023'; end if;
  select * into strict v_row from public.casework_bargaining_workspaces where id = p_workspace_id for update;
  if not private.member_has_chapter_role(v_row.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  if v_row.status <> p_expected_status then raise exception 'workspace changed' using errcode = '40001'; end if;
  update public.casework_bargaining_workspaces set status = p_next_status, updated_at = pg_catalog.now() where id = v_row.id returning * into v_row;
  insert into public.casework_bargaining_events(workspace_id, organization_id, event_type, body, created_by)
  values (v_row.id, v_row.organization_id, 'session_status', p_expected_status || ' → ' || p_next_status, (select auth.uid()));
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_workspace', v_row.id, pg_catalog.jsonb_build_object('fromStatus', p_expected_status, 'toStatus', p_next_status));
  return v_row;
end;
$function$;

create or replace function public.casework_log_management_behavior(
  p_case_id uuid, p_display_name text, p_title text, p_workplace text,
  p_occurred_at timestamptz, p_category text, p_summary text
)
returns public.casework_management_entries
language plpgsql security definer set search_path = '' as $function$
declare v_case public.member_cases%rowtype; v_person public.casework_management_people%rowtype; v_row public.casework_management_entries%rowtype;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_access(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  select * into v_person from public.casework_management_people p where p.organization_id = v_case.organization_id and p.chapter_id = v_case.chapter_id and pg_catalog.lower(pg_catalog.btrim(p.display_name)) = pg_catalog.lower(pg_catalog.btrim(p_display_name)) order by p.created_at limit 1;
  if not found then
    insert into public.casework_management_people(organization_id, chapter_id, display_name, title, workplace, created_by)
    values (v_case.organization_id, v_case.chapter_id, pg_catalog.btrim(p_display_name), nullif(pg_catalog.btrim(p_title), ''), nullif(pg_catalog.btrim(p_workplace), ''), (select auth.uid())) returning * into v_person;
  end if;
  insert into public.casework_management_entries(management_person_id, case_id, organization_id, chapter_id, occurred_at, category, summary, created_by)
  values (v_person.id, v_case.id, v_case.organization_id, v_case.chapter_id, p_occurred_at, p_category, pg_catalog.btrim(p_summary), (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'behavior_logged', 'management_entry', v_row.id);
  return v_row;
end;
$function$;

create or replace function public.casework_add_management_addendum(p_entry_id uuid, p_body text)
returns public.casework_management_addenda
language plpgsql security definer set search_path = '' as $function$
declare v_entry public.casework_management_entries%rowtype; v_row public.casework_management_addenda%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_entry from public.casework_management_entries where id = p_entry_id;
  if not private.member_has_chapter_role(v_entry.chapter_id, array['steward','coordinator','advisor','admin','vp']) or (v_entry.case_id is not null and not private.casework_staff_can_access(v_entry.case_id)) then raise exception 'entry not found' using errcode = 'P0002'; end if;
  insert into public.casework_management_addenda(entry_id, organization_id, body, created_by)
  values (v_entry.id, v_entry.organization_id, pg_catalog.btrim(p_body), (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_entry.organization_id, v_entry.chapter_id, v_entry.case_id, (select auth.uid()), 'behavior_addendum_added', 'management_addendum', v_row.id);
  return v_row;
end;
$function$;

create or replace function public.casework_link_cases(p_source_case_id uuid, p_target_case_id uuid, p_relationship text, p_note text)
returns public.casework_entity_links
language plpgsql security definer set search_path = '' as $function$
declare v_source public.member_cases%rowtype; v_target public.member_cases%rowtype; v_row public.casework_entity_links%rowtype;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_access(p_source_case_id) or not private.casework_staff_can_access(p_target_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  select * into strict v_source from public.member_cases where id = p_source_case_id;
  select * into strict v_target from public.member_cases where id = p_target_case_id;
  if v_source.organization_id <> v_target.organization_id or v_source.chapter_id <> v_target.chapter_id then raise exception 'cases must share a chapter' using errcode = '22023'; end if;
  insert into public.casework_entity_links(organization_id, chapter_id, source_case_id, target_case_id, target_kind, target_id, relationship, note, created_by)
  values (v_source.organization_id, v_source.chapter_id, v_source.id, v_target.id, 'case', v_target.id, pg_catalog.btrim(p_relationship), nullif(pg_catalog.btrim(p_note), ''), (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_source.organization_id, v_source.chapter_id, v_source.id, (select auth.uid()), 'entity_linked', 'entity_link', v_row.id, pg_catalog.jsonb_build_object('targetCaseId', v_target.id));
  return v_row;
end;
$function$;

create or replace function public.casework_set_reminder_status(p_reminder_id uuid, p_action text, p_remind_at timestamptz)
returns public.casework_reminders
language plpgsql security definer set search_path = '' as $function$
declare v_row public.casework_reminders%rowtype;
begin
  perform private.casework_require_mfa();
  if p_action not in ('scheduled','snoozed','completed','dismissed') then raise exception 'invalid reminder action' using errcode = '22023'; end if;
  select * into strict v_row from public.casework_reminders where id = p_reminder_id and owner_user_id = (select auth.uid()) for update;
  if p_action = 'snoozed' and p_remind_at is null then raise exception 'snooze time required' using errcode = '22023'; end if;
  update public.casework_reminders set status = p_action,
    remind_at = case when p_action = 'snoozed' then p_remind_at else remind_at end,
    completed_at = case when p_action in ('completed','dismissed') then pg_catalog.now() else null end,
    updated_at = pg_catalog.now()
  where id = v_row.id returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()), 'reminder_changed', 'reminder', v_row.id, pg_catalog.jsonb_build_object('status', p_action));
  return v_row;
end;
$function$;

create or replace function public.casework_scan_retaliation_patterns(p_chapter_id text)
returns integer
language plpgsql security definer set search_path = '' as $function$
declare v_org uuid; v_group record; v_pattern public.casework_retaliation_patterns%rowtype; v_count integer := 0;
begin
  perform private.casework_require_mfa();
  select c.organization_id into strict v_org from public.chapters c where c.id = p_chapter_id;
  if not private.member_has_chapter_role(p_chapter_id, array['coordinator','advisor','admin','vp']) then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  for v_group in
    select pg_catalog.lower(pg_catalog.btrim(r.management_person)) as person_key, pg_catalog.count(*)::integer as report_count
    from public.casework_retaliation_reports r
    where r.organization_id = v_org and r.chapter_id = p_chapter_id and r.status <> 'withdrawn' and r.incident_at >= pg_catalog.now() - interval '3 years'
    group by pg_catalog.lower(pg_catalog.btrim(r.management_person)) having pg_catalog.count(*) >= 2
  loop
    insert into public.casework_retaliation_patterns(organization_id, chapter_id, fingerprint, subject_label, report_count)
    values (v_org, p_chapter_id, pg_catalog.md5(p_chapter_id || ':' || v_group.person_key), v_group.person_key, v_group.report_count)
    on conflict (organization_id, fingerprint) do update set subject_label = excluded.subject_label, report_count = excluded.report_count, detected_at = pg_catalog.now()
    returning * into v_pattern;
    insert into public.casework_retaliation_pattern_reports(pattern_id, report_id, organization_id)
    select v_pattern.id, r.id, v_org from public.casework_retaliation_reports r
    where r.organization_id = v_org and r.chapter_id = p_chapter_id and r.status <> 'withdrawn'
      and pg_catalog.lower(pg_catalog.btrim(r.management_person)) = v_group.person_key
    on conflict (pattern_id, report_id) do nothing;
    insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (v_org, p_chapter_id, (select auth.uid()), 'pattern_detected', 'retaliation_pattern', v_pattern.id, pg_catalog.jsonb_build_object('reportCount', v_group.report_count));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

create or replace function public.casework_review_retaliation_pattern(p_pattern_id uuid, p_status text, p_disposition text, p_note text)
returns public.casework_retaliation_patterns
language plpgsql security definer set search_path = '' as $function$
declare v_row public.casework_retaliation_patterns%rowtype;
begin
  perform private.casework_require_mfa();
  if p_status not in ('flagged','investigating','substantiated','dismissed') then raise exception 'invalid pattern status' using errcode = '22023'; end if;
  select * into strict v_row from public.casework_retaliation_patterns where id = p_pattern_id for update;
  if not ((v_row.chapter_id is not null and private.member_has_chapter_role(v_row.chapter_id, array['coordinator','advisor','admin','vp'])) or private.has_organization_role(v_row.organization_id, array['coordinator','advisor','admin','vp'])) then raise exception 'pattern not found' using errcode = 'P0002'; end if;
  update public.casework_retaliation_patterns set status = p_status, disposition = nullif(pg_catalog.btrim(p_disposition), ''), reviewed_by = (select auth.uid()), reviewed_at = pg_catalog.now() where id = v_row.id returning * into v_row;
  if nullif(pg_catalog.btrim(p_note), '') is not null then
    insert into public.casework_retaliation_pattern_notes(pattern_id, organization_id, body, created_by) values (v_row.id, v_row.organization_id, pg_catalog.btrim(p_note), (select auth.uid()));
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, (select auth.uid()), 'pattern_reviewed', 'retaliation_pattern', v_row.id, pg_catalog.jsonb_build_object('status', p_status));
  return v_row;
end;
$function$;

create or replace function private.casework_escalate_due_alerts(p_limit integer default 200)
returns integer
language plpgsql security definer set search_path = '' as $function$
declare v_alert public.casework_alerts%rowtype; v_count integer := 0;
begin
  for v_alert in
    select * from public.casework_alerts where status = 'open' and escalation_due_at <= pg_catalog.now()
    order by escalation_due_at, id for update skip locked limit least(greatest(p_limit, 1), 1000)
  loop
    update public.casework_alerts set status = 'escalated', escalated_at = pg_catalog.now() where id = v_alert.id;
    insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
    values (v_alert.organization_id, v_alert.chapter_id, v_alert.case_id, null, 'alert_escalated', 'alert', v_alert.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

revoke all on function public.casework_score_case(uuid, jsonb, uuid) from public, anon;
revoke all on function public.casework_request_deadline_extension(uuid, timestamptz, text, uuid) from public, anon;
revoke all on function public.casework_decide_deadline_extension(uuid, text, text) from public, anon;
revoke all on function public.casework_advance_step(uuid, text, text, text, uuid) from public, anon;
revoke all on function public.casework_acknowledge_alert(uuid, text) from public, anon;
revoke all on function public.casework_set_restriction(uuid, boolean, text) from public, anon;
revoke all on function public.casework_grant_access(uuid, uuid) from public, anon;
revoke all on function public.casework_revoke_access(uuid) from public, anon;
revoke all on function public.casework_save_intake_draft(uuid, text, uuid, uuid, jsonb, integer) from public, anon;
revoke all on function public.casework_submit_retaliation_report(uuid, timestamptz, text, text, text, text, uuid) from public, anon;
revoke all on function public.casework_withdraw_retaliation_report(uuid, text) from public, anon;
revoke all on function public.casework_bulk_update_cases(uuid[], text, text, text, uuid) from public, anon;
revoke all on function public.casework_create_checklist_template(text, text, text, text, jsonb) from public, anon;
revoke all on function public.casework_set_checklist_item(uuid, boolean) from public, anon;
revoke all on function public.casework_create_bargaining_workspace(text, text, timestamptz) from public, anon;
revoke all on function public.casework_add_bargaining_proposal(uuid, text, text, text, timestamptz) from public, anon;
revoke all on function public.casework_transition_bargaining_proposal(uuid, text, text, timestamptz) from public, anon;
revoke all on function public.casework_add_bargaining_event(uuid, text, text, text) from public, anon;
revoke all on function public.casework_set_bargaining_status(uuid, text, text) from public, anon;
revoke all on function public.casework_log_management_behavior(uuid, text, text, text, timestamptz, text, text) from public, anon;
revoke all on function public.casework_add_management_addendum(uuid, text) from public, anon;
revoke all on function public.casework_link_cases(uuid, uuid, text, text) from public, anon;
revoke all on function public.casework_set_reminder_status(uuid, text, timestamptz) from public, anon;
revoke all on function public.casework_scan_retaliation_patterns(text) from public, anon;
revoke all on function public.casework_review_retaliation_pattern(uuid, text, text, text) from public, anon;
revoke all on function private.casework_escalate_due_alerts(integer) from public, anon, authenticated;
grant execute on function public.casework_score_case(uuid, jsonb, uuid) to authenticated;
grant execute on function public.casework_request_deadline_extension(uuid, timestamptz, text, uuid) to authenticated;
grant execute on function public.casework_decide_deadline_extension(uuid, text, text) to authenticated;
grant execute on function public.casework_advance_step(uuid, text, text, text, uuid) to authenticated;
grant execute on function public.casework_acknowledge_alert(uuid, text) to authenticated;
grant execute on function public.casework_set_restriction(uuid, boolean, text) to authenticated;
grant execute on function public.casework_grant_access(uuid, uuid) to authenticated;
grant execute on function public.casework_revoke_access(uuid) to authenticated;
grant execute on function public.casework_save_intake_draft(uuid, text, uuid, uuid, jsonb, integer) to authenticated;
grant execute on function public.casework_submit_retaliation_report(uuid, timestamptz, text, text, text, text, uuid) to authenticated;
grant execute on function public.casework_withdraw_retaliation_report(uuid, text) to authenticated;
grant execute on function public.casework_bulk_update_cases(uuid[], text, text, text, uuid) to authenticated;
grant execute on function public.casework_create_checklist_template(text, text, text, text, jsonb) to authenticated;
grant execute on function public.casework_set_checklist_item(uuid, boolean) to authenticated;
grant execute on function public.casework_create_bargaining_workspace(text, text, timestamptz) to authenticated;
grant execute on function public.casework_add_bargaining_proposal(uuid, text, text, text, timestamptz) to authenticated;
grant execute on function public.casework_transition_bargaining_proposal(uuid, text, text, timestamptz) to authenticated;
grant execute on function public.casework_add_bargaining_event(uuid, text, text, text) to authenticated;
grant execute on function public.casework_set_bargaining_status(uuid, text, text) to authenticated;
grant execute on function public.casework_log_management_behavior(uuid, text, text, text, timestamptz, text, text) to authenticated;
grant execute on function public.casework_add_management_addendum(uuid, text) to authenticated;
grant execute on function public.casework_link_cases(uuid, uuid, text, text) to authenticated;
grant execute on function public.casework_set_reminder_status(uuid, text, timestamptz) to authenticated;
grant execute on function public.casework_scan_retaliation_patterns(text) to authenticated;
grant execute on function public.casework_review_retaliation_pattern(uuid, text, text, text) to authenticated;

-- Database-owned escalation: no external credential or fabricated counsel
-- account is needed. The job moves overdue, unacknowledged alerts into the
-- existing restricted staff queue; authorized counsel/advisor operators see
-- the same RLS-filtered record and immutable audit event.
do $block$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  execute 'create extension if not exists pg_cron';
  perform cron.unschedule(jobid) from cron.job where jobname = 'casework-alert-escalation-tick';
  perform cron.schedule('casework-alert-escalation-tick', '* * * * *', 'select private.casework_escalate_due_alerts(200)');
end;
$block$;

comment on table public.casework_strength_analyses is 'CR-020 immutable, server-scored grievance strength history.';
comment on table public.casework_bargaining_workspaces is 'CR-021/022 bargaining proposal lifecycle and live-session root.';
comment on table public.casework_deadline_extensions is 'CR-023 append-only extension request and decision trail; never compensating-deleted.';
comment on table public.casework_checklists is 'CR-024 case-stage checklist instances.';
comment on function public.casework_advance_step(uuid, text, text, text, uuid) is 'CR-025 atomic optimistic step transition plus generated checklist work.';
comment on table public.casework_access_grants is 'CR-026 participant-aware restricted-case access grants.';
comment on table public.casework_alert_acknowledgements is 'CR-027 immutable acknowledgement evidence.';
comment on table public.casework_management_entries is 'CR-028 immutable behavior observations; corrections are addenda.';
comment on table public.casework_retaliation_reports is 'CR-029 member-owned retaliation intake with explicit withdrawal semantics.';
comment on table public.casework_retaliation_patterns is 'CR-030 staff-only cross-report pattern disposition.';
comment on table public.casework_intake_drafts is 'CR-031 optimistic-concurrency intake autosave.';
comment on function public.casework_bulk_update_cases(uuid[], text, text, text, uuid) is 'CR-032 atomic organization-bounded bulk case maintenance.';
comment on table public.casework_entity_links is 'CR-033 authorization-preserving case graph edges.';
comment on table public.casework_reminders is 'CR-034 case follow-up reminders with recurrence and disposition.';
