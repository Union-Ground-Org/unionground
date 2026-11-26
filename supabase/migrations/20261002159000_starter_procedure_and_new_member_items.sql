-- REQ-UG-GRIEVANCE-PROCEDURE-STARTER-TEMPLATE-20261001
-- REQ-UG-NEW-MEMBER-STARTER-ITEMS-20261001
--
-- Restore-everything campaign, STARTER TEMPLATES (
-- items #6 and #7, 2026-10-01). The "Casework W2 case-flow disposition"
-- and "SaaS ship-complete bar" carry the matching amendments
-- (REQ-UG-AGENTS-CONTRACT-AMENDMENTS-D3-20261001).
--
-- 1. STARTER GRIEVANCE PROCEDURE (admin-loaded, never auto-applied).
--    An organization admin explicitly loads an editable starter procedure that
--    carries the earlier app's effective step deadlines into
--    casework_procedures / casework_procedure_steps. Loading goes through
--    public.casework_save_procedure, so it passes exactly the validation and
--    authorization of a manual procedure edit (MFA, organization-wide
--    procedure role, step-shape checks) plus an admin-only gate, the switch
--    below and a refusal when the scope already has an active procedure: it
--    never overwrites. Each load writes a 'procedure_starter_loaded' casework
--    audit event. Nothing is seeded; an organization that never loads it keeps
--    today's blank procedure. This is not a return of the retired W2 layer:
--    no retired table or RPC is touched.
--
--    Old effective values (git show de7df4b57c^:<path>). The old app read
--    every deadline from its settings table; the code fallbacks applied only
--    when a row was missing, and the seeds always created the rows:
--      step1_filing_deadline_days 14 calendar days from the incident
--        supabase/migrations/0022_features_all.sql:445, 0029_fix_settings_constraints_and_seed.sql:26;
--        read by lib/grievances/strength-score.ts:138 and app/dashboard/analyzer/actions.ts:116
--        (days since incident). filing_deadline_days (0003_seed.sql:37 / 0021_seed_real_data.sql:134,
--        21) was displayed but never read by any code path.
--      step1_response_days 30 calendar days from filing
--        0003_seed.sql:38 and 0021_seed_real_data.sql:135 ('30'); read by
--        app/dashboard/grievances/actions.ts:210-223 (addCalendarDays).
--      step2_appeal_days 10 business days ("Step II Appeal (business days)")
--        0003_seed.sql:39, 0021_seed_real_data.sql:136.
--      step2_response_days 30 calendar days
--        0003_seed.sql:40, 0021_seed_real_data.sql:137; read by
--        app/dashboard/grievances/actions.ts:822 into advance_grievance_step
--        (0365_grievance_rpc_role_guards.sql:110-118, current_date + days).
--      step3_appeal_days 30 calendar days
--        0003_seed.sql:41 seeded 10, 0021_seed_real_data.sql:138 set 30 (latest write).
--      step3_response_days 30 calendar days
--        0003_seed.sql:42 seeded 21, 0021_seed_real_data.sql:139 set 30; read by
--        app/dashboard/grievances/actions.ts:823.
--      arbitration_demand_days 30 calendar days
--        0003_seed.sql:43, 0021_seed_real_data.sql:140.
--    Switch features.casework.starter_procedure_template: default ON. The old
--    app had no flag for these deadlines (they were always present), and the
--    switch only offers the explicit load; it applies nothing by itself.
--
-- 2. STARTER ITEMS FOR A NEW MEMBER (switch starts OFF).
--    Old lib/handoffs/member-handoffs.ts (2026-04-25), called from
--    app/dashboard/members/actions.ts:395 when an admin created a member:
--    an onboarding task assigned to the new member and a "New member needs
--    mentorship pair" notice to the creating admin. Production ran with the
--    onboarding half off (0196_reset_member_feature_flags.sql:29), and owner
--    decision D3 accepted "off by default", so
--    features.guidance_onboarding.new_member_starter_items defaults to false.
--    When an admin turns it on and a person joins the organization:
--      * one Standard Task "Get started" in the member's current chapter of
--        that organization, created by and assigned to the member, whose
--        description is a checklist built from the organization's own active
--        onboarding steps (empty when it has none);
--      * one notification through private.notify_member to the person who
--        invited or provisioned them: "Pair <name> with a mentor".
--    Nothing is invented: the name is the member's own profile name and the
--    checklist is the organization's own configuration. Exactly one set per
--    organization membership (organization_memberships.starter_items_issued_at),
--    so a re-join, a second chapter or a retried acceptance never repeats it.
--    handle_new_member is unchanged. Joins are observed in two places:
--      * an accepted invitation (new account or former-member reactivation):
--        the inviter is member_invitations.invited_by, issued only once the
--        account is active, so a failed or rolled-back acceptance leaves
--        nothing behind;
--      * any other activation of an organization membership (operator or
--        SCIM provisioning), checked at commit by a deferred trigger: the
--        adder is the signed-in actor when they are an active member of the
--        organization; a membership with a live invitation is left to the
--        invitation path.
--    A failure here never blocks a join: the items are skipped and the join
--    commits.
--
-- Hosted application: SAMPLE first, then production, in a later window with
-- an owner go-ahead. No production rows are written apart from the platform
-- definitions and notification copy.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Settings registry definitions (W1-SETTINGS contract)
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- No old flag: the old step deadlines were always present (see header).
  ('features.casework.starter_procedure_template', 'boolean', 'Starter grievance procedure',
   'Let organization admins load an editable starter grievance procedure with the earlier default step deadlines. Nothing is applied until an admin loads it.',
   'true', null, null, null, 2400, 'casework', false),
  -- Starts off (old onboarding_enabled was reset off by
  -- 0196_reset_member_feature_flags.sql:29).
  ('features.guidance_onboarding.new_member_starter_items', 'boolean', 'Starter items for new members',
   'When someone joins, create one Get started task for them and ask the person who added them to pair them with a mentor.',
   'false', null, null, null, 2410, 'guidance_onboarding', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Starter grievance procedure
-- ---------------------------------------------------------------------------

alter table public.casework_audit_events
  drop constraint casework_audit_events_event_type_check;
alter table public.casework_audit_events
  add constraint casework_audit_events_event_type_check check (event_type in (
    'strength_scored','deadline_requested','deadline_decided','checklist_created','checklist_item_changed',
    'step_advanced','restriction_changed','access_granted','access_revoked',
    'alert_created','alert_acknowledged','alert_escalated','behavior_logged',
    'retaliation_submitted','retaliation_withdrawn','pattern_detected',
    'draft_saved','bulk_updated','entity_linked','reminder_changed',
    'bargaining_changed','behavior_addendum_added','pattern_reviewed',
    'macro_saved','macro_applied','note_added','note_mentioned','case_assigned',
    'cases_exported','deadline_created','procedure_starter_loaded'
  ));

-- The one definition of the starter steps (English and Spanish labels). Keys
-- and rules are exactly what casework_save_procedure accepts.
create function private.starter_procedure_template(p_locale text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'template', 'grievance-starter-20261001',
    'name', case when p_locale = 'es' then 'Procedimiento de quejas inicial' else 'Starter grievance procedure' end,
    'steps', pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'key', s.key,
      'label', case when p_locale = 'es' then s.label_es else s.label_en end,
      'deadline_rule', pg_catalog.jsonb_build_object('kind', s.kind, 'count', s.count, 'from', s.count_from),
      'requires_checklist', false,
      'terminal', s.terminal,
      'allow_terminal_exit', false
    ) order by s.position)
  )
  from (values
    (0, 'filing', 'File the grievance', 'Presentar la queja', 'calendar_days', 14, 'incident', false),
    (1, 'step_1', 'Step 1: management response', 'Paso 1: respuesta de la gerencia', 'calendar_days', 30, 'step_entry', false),
    (2, 'step_2_appeal', 'Appeal to Step 2', 'Apelación al Paso 2', 'business_days', 10, 'step_entry', false),
    (3, 'step_2', 'Step 2: management response', 'Paso 2: respuesta de la gerencia', 'calendar_days', 30, 'step_entry', false),
    (4, 'step_3_appeal', 'Appeal to Step 3', 'Apelación al Paso 3', 'calendar_days', 30, 'step_entry', false),
    (5, 'step_3', 'Step 3: management response', 'Paso 3: respuesta de la gerencia', 'calendar_days', 30, 'step_entry', false),
    (6, 'arbitration_demand', 'Demand arbitration', 'Solicitar arbitraje', 'calendar_days', 30, 'step_entry', false),
    (7, 'arbitration', 'Arbitration', 'Arbitraje', 'none', 0, 'step_entry', true)
  ) as s(position, key, label_en, label_es, kind, count, count_from, terminal)
$function$;

-- Preview for the procedure settings: the steps, whether the organization
-- switch offers them and whether this caller may load them. Readable by the
-- same staff who may read procedure settings.
create function public.get_casework_starter_procedure(p_locale text default 'en')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_org uuid;
begin
  if p_locale is null or p_locale not in ('en', 'es') then
    raise exception 'invalid locale' using errcode = '22023';
  end if;
  v_org := private.casework_procedure_actor(false);
  return private.starter_procedure_template(p_locale) || pg_catalog.jsonb_build_object(
    'available', private.organization_feature_enabled(v_org, 'features.casework.starter_procedure_template'),
    'canLoad', private.has_organization_role(v_org, array['admin'])
  );
end;
$function$;

create function public.load_casework_starter_procedure(p_case_type text default null, p_locale text default 'en')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  v_org uuid;
  v_case_type text;
  v_template jsonb;
  v_procedure jsonb;
begin
  -- The manual-edit gate first (MFA, organization-wide procedure role), then
  -- the admin-only gate for this action.
  v_org := private.casework_procedure_actor(true);
  if not private.has_organization_role(v_org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(v_org, 'features.casework.starter_procedure_template') then
    raise exception 'starter procedure is switched off' using errcode = '55000';
  end if;
  if p_locale is null or p_locale not in ('en', 'es') then
    raise exception 'invalid locale' using errcode = '22023';
  end if;
  v_case_type := nullif(pg_catalog.btrim(coalesce(p_case_type, '')), '');
  if v_case_type is not null and pg_catalog.char_length(v_case_type) > 100 then
    raise exception 'invalid case type' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('casework-procedure:' || v_org::text, 0));
  -- Never overwrite: an organization-wide procedure for this case-type scope
  -- is edited, not replaced.
  if exists (
    select 1 from public.casework_procedures p
    where p.organization_id = v_org and p.active and p.chapter_id is null
      and p.case_type is not distinct from v_case_type
  ) then
    raise exception 'a procedure already exists for this scope' using errcode = '23505';
  end if;
  v_template := private.starter_procedure_template(p_locale);
  v_procedure := public.casework_save_procedure(null, null, v_case_type, v_template ->> 'name', v_template -> 'steps', null);
  insert into public.casework_audit_events (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, null, null, (select auth.uid()), 'procedure_starter_loaded', 'procedure', (v_procedure ->> 'id')::uuid,
    pg_catalog.jsonb_build_object('template', v_template ->> 'template', 'caseType', v_case_type, 'locale', p_locale,
      'steps', pg_catalog.jsonb_array_length(v_template -> 'steps')));
  return v_procedure;
end;

end;
$function$;

revoke all on function private.starter_procedure_template(text) from public, anon, authenticated, service_role;
revoke all on function public.get_casework_starter_procedure(text), public.load_casework_starter_procedure(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_casework_starter_procedure(text), public.load_casework_starter_procedure(text, text)
  to authenticated;

comment on function public.get_casework_starter_procedure(text) is
  'REQ-UG-GRIEVANCE-PROCEDURE-STARTER-TEMPLATE-20261001: preview of the admin-loaded starter procedure for procedure-settings readers, with the organization switch and whether the caller may load it.';
comment on function public.load_casework_starter_procedure(text, text) is
  'REQ-UG-GRIEVANCE-PROCEDURE-STARTER-TEMPLATE-20261001: organization admin explicitly loads the editable starter procedure through casework_save_procedure; refused when the scope already has a procedure; audited as procedure_starter_loaded.';

-- ---------------------------------------------------------------------------
-- 2. Starter items for a new member
-- ---------------------------------------------------------------------------

alter table public.organization_memberships
  add column starter_items_issued_at timestamptz;
comment on column public.organization_memberships.starter_items_issued_at is
  'REQ-UG-NEW-MEMBER-STARTER-ITEMS-20261001: when the one set of new-member starter items was issued for this membership; null when never issued.';

insert into private.notification_copy (key, lang, title, body) values
  ('member.mentor_pairing', 'en', 'Pair {name} with a mentor',
   '{name} joined {chapter}. Open Member support, then Mentorship, to pair them with a mentor.'),
  ('member.mentor_pairing', 'es', 'Asigna un mentor a {name}',
   '{name} se unió a {chapter}. Abre Apoyo a miembros y luego Mentoría para asignarle un mentor.')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- Issues the one set for (organization, member). p_added_by is a hint from
-- the join path and is re-checked here.
--
-- IMPERSONATION NOTE. chapter_tasks stamps its chapter, creator and number
-- from auth.uid() in private.prepare_chapter_task and refuses an anonymous
-- insert, so this definer sets a transaction-local identity of the MEMBER for
-- the one fixed-shape insert and restores the previous identity right after
-- it (the same technique the SAMPLE seed documents). The member is both the
-- creator and the assignee, exactly as the old app wrote it
-- (lib/handoffs/member-handoffs.ts: assignee_id and created_by = memberId),
-- so the Standard Task path sends no extra "assigned you a task" notice. A
-- failure rolls the identity back with the enclosing subtransaction.
create function private.issue_new_member_starter_items(
  p_organization_id uuid, p_user_id uuid, p_added_by uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  v_chapter text;
  v_chapter_name text;
  v_name text;
  v_lang text;
  v_checklist text;
  v_line text;
  v_workstream text;
  v_claims text;
  v_claim_sub text;
begin
  if p_organization_id is null or p_user_id is null then
    return false;
  end if;
  if not private.organization_feature_enabled(p_organization_id, 'features.guidance_onboarding.new_member_starter_items') then
    return false;
  end if;
  -- Resolve the member's active chapter before claiming issuance. A member
  -- without one can be retried after chapter assignment.
  select nullif(pg_catalog.btrim(p.full_name), ''), case when p.language = 'es' then 'es' else 'en' end, c.id, c.name
  into v_name, v_lang, v_chapter, v_chapter_name
  from public.member_profiles p
  left join public.chapters c on c.id = p.chapter_id and c.organization_id = p_organization_id
    and exists (select 1 from public.member_chapter_memberships m
      where m.user_id = p.id and m.chapter_id = c.id and m.status = 'active')
  where p.id = p_user_id;

  if v_chapter is null then
    return false;
  end if;
  -- Exactly one set per membership, claimed only when a task can be created.
  update public.organization_memberships
  set starter_items_issued_at = pg_catalog.clock_timestamp()
  where organization_id = p_organization_id and user_id = p_user_id
    and status = 'active' and starter_items_issued_at is null;
  if not found then
    return false;
  end if;

    -- The organization's own active onboarding steps become the checklist,
    -- within the task description bound.
    v_checklist := '';
    for v_line in
      select '- [ ] ' || pg_catalog.btrim(s.title) from public.organization_onboarding_steps s
      where s.organization_id = p_organization_id and s.active
      order by s.position, s.id limit 100
    loop
      exit when pg_catalog.char_length(v_checklist) + pg_catalog.char_length(v_line) + 1 > 2000;
      v_checklist := v_checklist || case when v_checklist = '' then '' else pg_catalog.chr(10) end || v_line;
    end loop;
    -- A task must name one of the chapter's workstreams. 'General' is the
    -- column default every chapter was given when workstreams were introduced
    -- (20260728221223); a chapter created since then that has none gets it
    -- here, exactly as that migration did, rather than a task that cannot be
    -- filed.
    select w.name into v_workstream from public.chapter_workstreams w
    where w.chapter_id = v_chapter
    order by (w.name = 'General') desc, w.created_at, w.name
    limit 1;
    if v_workstream is null then
      insert into public.chapter_workstreams (chapter_id, name, created_by)
      values (v_chapter, 'General', null)
      on conflict (chapter_id, name) do nothing;
      v_workstream := 'General';
    end if;
    v_claims := pg_catalog.current_setting('request.jwt.claims', true);
    v_claim_sub := pg_catalog.current_setting('request.jwt.claim.sub', true);
    perform pg_catalog.set_config('request.jwt.claims',
      pg_catalog.jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
    perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
    insert into public.chapter_tasks (
      chapter_id, title, description, status, priority, workstream,
      assignee_id, start_date, due_date, progress, blocked, milestone, order_index, task_type
    ) values (
      v_chapter, case when v_lang = 'es' then 'Primeros pasos' else 'Get started' end,
      v_checklist, 'to_do', 'medium', v_workstream,
      p_user_id, null, null, 0, false, false, 0, 'general'
    );
    perform pg_catalog.set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(v_claim_sub, ''), true);
  -- The mentor prompt goes to the person who added the member, only while
  -- they are still an active member of the same organization.
  if p_added_by is not null and p_added_by <> p_user_id and v_name is not null and exists (
    select 1 from public.organization_memberships om
    where om.organization_id = p_organization_id and om.user_id = p_added_by and om.status = 'active'
  ) then
    perform private.notify_member(p_added_by, 'member.mentor_pairing',
      pg_catalog.jsonb_build_object('name', v_name, 'chapter', coalesce(v_chapter_name, '')), 'general');
  end if;
  return true;
end;

end;
$function$;

-- Invitation path: the invitation reaches 'accepted' only after the account is
-- active (complete_member_invitation_activation) or the former member's
-- membership is re-activated (accept_former_member_invitation).
create function private.new_member_starter_items_on_invitation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  v_org uuid;
begin
  if new.status <> 'accepted' or old.status = 'accepted' or new.auth_user_id is null then
    return null;
  end if;
  select c.organization_id into v_org from public.chapters c where c.id = new.chapter_id;
  begin
    perform private.issue_new_member_starter_items(v_org, new.auth_user_id, new.invited_by);
  exception when others then
    -- Optional starter items must never block a join.
    raise warning 'new member starter items skipped (%)', sqlstate;
  end;
  return null;
end;

end;
$function$;

create trigger new_member_starter_items_on_invitation
  after update of status on public.member_invitations
  for each row when (new.status = 'accepted')
  execute function private.new_member_starter_items_on_invitation();

-- Any other join, checked at commit so the member's chapter membership and
-- any invitation state written later in the same transaction are visible.
create function private.new_member_starter_items_on_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  v_actor uuid;
begin
  if new.status <> 'active' then
    return null;
  end if;
  -- A person joining through an invitation is handled when it is accepted.
  if exists (
    select 1 from public.member_invitations i
    join public.chapters c on c.id = i.chapter_id and c.organization_id = new.organization_id
    join auth.users u on u.id = new.user_id
    where i.status in ('pending', 'accepting')
      and i.normalized_email = pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, '')))
  ) then
    return null;
  end if;
  v_actor := (select auth.uid());
  begin
    perform private.issue_new_member_starter_items(new.organization_id, new.user_id, v_actor);
  exception when others then
    raise warning 'new member starter items skipped (%)', sqlstate;
  end;
  return null;
end;

end;
$function$;

create constraint trigger new_member_starter_items_on_membership
  after insert or update of status on public.organization_memberships
  deferrable initially deferred
  for each row when (new.status = 'active')
  execute function private.new_member_starter_items_on_membership();

-- A member may gain an active chapter after organization activation. These
-- deferred retries observe both the profile and chapter membership at commit.
create function private.new_member_starter_items_on_chapter_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  v_user uuid;
  v_organization uuid;
begin
  if tg_table_name = 'member_profiles' then
    v_user := new.id;
  else
    v_user := new.user_id;
  end if;
  select c.organization_id into v_organization
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  join public.member_chapter_memberships cm
    on cm.user_id = p.id and cm.chapter_id = c.id and cm.status = 'active'
  where p.id = v_user;
  if v_organization is not null and not exists (
    select 1 from public.member_invitations i
    join public.chapters c on c.id = i.chapter_id and c.organization_id = v_organization
    join auth.users u on u.id = v_user
    where i.status in ('pending', 'accepting')
      and i.normalized_email = pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, '')))
  ) then
    begin
      perform private.issue_new_member_starter_items(v_organization, v_user, (select auth.uid()));
    exception when others then
      raise warning 'new member starter items skipped (%)', sqlstate;
    end;
  end if;
  return null;
end;

end;
$function$;

create constraint trigger new_member_starter_items_on_profile_chapter
  after update of chapter_id on public.member_profiles
  deferrable initially deferred
  for each row when (new.chapter_id is distinct from old.chapter_id)
  execute function private.new_member_starter_items_on_chapter_assignment();

create constraint trigger new_member_starter_items_on_chapter_membership
  after insert or update of status on public.member_chapter_memberships
  deferrable initially deferred
  for each row when (new.status = 'active')
  execute function private.new_member_starter_items_on_chapter_assignment();

-- Both join triggers reach a messaging-graph writer (chapter_tasks is an FK
-- parent of chapter_task_messages), so their host tables enter the message
-- lifecycle statement gate like every other trigger host in that closure
-- (tests/message-preservation-db.test.js). The a00 case-graph gate already
-- takes the same lock first; this keeps the closure explicit.
create trigger message_lifecycle_statement before insert or update or delete on public.member_invitations
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before insert or update or delete on public.organization_memberships
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before insert or update or delete on public.member_chapter_memberships
for each statement execute function private.lock_message_lifecycle_statement();

revoke all on function private.issue_new_member_starter_items(uuid, uuid, uuid),
  private.new_member_starter_items_on_invitation(), private.new_member_starter_items_on_membership(),
  private.new_member_starter_items_on_chapter_assignment()
  from public, anon, authenticated, service_role;

comment on function private.issue_new_member_starter_items(uuid, uuid, uuid) is
  'REQ-UG-NEW-MEMBER-STARTER-ITEMS-20261001: behind features.guidance_onboarding.new_member_starter_items (default off), one Get started Standard Task for the member and one mentor-pairing notification to the adder, once per organization membership.';

-- Account-lifecycle definer review: the two join triggers, their functions and
-- whatever they newly reach (the starter issuer and the settings helpers it
-- reads) are new referential-action surface. Name-bound, never a blanket
-- acceptance, and the review must be complete afterwards.
do $review$
begin
  insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
  select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
  from private.account_lifecycle_trigger_surface() s
  where ((s.kind = 'trigger' and s.schema_name = 'public' and (
        (s.table_name = 'member_invitations' and s.object_name in ('new_member_starter_items_on_invitation', 'message_lifecycle_statement'))
        or (s.table_name = 'organization_memberships' and s.object_name in ('new_member_starter_items_on_membership', 'message_lifecycle_statement'))
        or (s.table_name = 'member_profiles' and s.object_name = 'new_member_starter_items_on_profile_chapter')
        or (s.table_name = 'member_chapter_memberships' and s.object_name in ('new_member_starter_items_on_chapter_membership', 'message_lifecycle_statement'))))
      or (s.kind = 'function' and s.schema_name = 'private' and s.table_name = '' and s.object_name in (
        'new_member_starter_items_on_invitation()',
        'new_member_starter_items_on_membership()',
        'new_member_starter_items_on_chapter_assignment()',
        'issue_new_member_starter_items(p_organization_id uuid, p_user_id uuid, p_added_by uuid)',
        'organization_feature_enabled(p_organization_id uuid, p_key text)',
        'organization_setting_effective(p_organization_id uuid, p_key text, p_kind text)')))
  on conflict (kind, schema_name, table_name, object_name) do update
    set definition_hash = excluded.definition_hash;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the new-member starter items';
  end if;
end;
$review$;

commit;
