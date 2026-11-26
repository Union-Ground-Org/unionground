-- REQ-UG-AUTOMATION-RECIPE-DEFAULTS-20261001 (CR-108)
--
-- Restore-everything campaign, lane L7a (owner request 2026-10-01: "I WANT
-- EVERYTHING BACK";: a restored feature starts in the old
-- app's effective production default, behind a visible admin switch).
--
-- Old behavior (de7df4b57c^):
--   * lib/crm/automation-recipes.ts:47-54 AUTOMATION_RECIPE_DEFAULTS shipped
--     every recipe enabled, and app/api/cron/automation-recipes/route.ts ran
--     them daily (vercel.ts '0 8 * * *', 4 AM Eastern). Its kill switch
--     automation_recipes_enabled was seeded 'true'
--     (supabase/migrations/0577_automation_safety.sql:96-104) and read with
--     getBoolean(settings, 'automation_recipes_enabled', true)
--     (lib/crm/load-command-center.ts:215). The windows were
--     dashboard_lookahead_days 7 and crm_stale_contact_days 14
--     (load-command-center.ts:201-202).
--   * The four recipes this record names: escalate overdue tasks, alert on
--     deadline risk, assign unowned cases, and follow up when a member with an
--     active case has no recorded contact inside the window
--     (lib/crm/workflow-queues.ts:496-548 buildStaleContactItems).
--   * Alert routing (supabase/migrations/0529_alert_routing_rules.sql,
--     lib/notifications/alert-routing.ts): when a recipe created a task, the
--     first enabled rule for the event kind (branch rules before global ones,
--     then sort order, priority filter) sent an in-app notice to the assignee,
--     the branch stewards, the branch admins or the grievance coordinators.
--     Three global rules were seeded enabled (0529:105-139).
--
-- Today (before this migration): the CR-108 engine (20260829023000,
-- 20260910045839, 20260911070000) is opt-in with no default definition, has
-- no stale-contact trigger and no routing.
--
-- What this migration restores, inside the existing engine:
--
--   1. Default recipes. organization_automation_definitions gains recipe_key
--      and explicit provenance. An admin's explicit master-switch enable
--      offers four system-provenance, inactive drafts while
--      features.automation.default_recipes is on (default ON per the old
--      citations). Each draft must be submitted, approved and activated by
--      an approver before it runs. Migration and scheduler never seed. An
--      archived default recipe is never re-created. Seeding never turns on
--      the master switch for an organization without a settings row.
--
--   2. Scheduled authority always comes from the activating approver. An
--      untouched system draft has no authority and cannot run. If that
--      approver's account is deleted or no longer authorized, execution
--      fails closed until a current approver reactivates it. The default
--      recipes switch also gates each run. Manual previews and runs retain
--      their existing actor checks.
--
--   3. stale_member_contact trigger. One source per member: the member's
--      oldest active case, once the case is older than the window and the
--      organization has recorded no case contact (member_case_contacts), no
--      contact-log entry (chapter_contact_log) and no conversation contact
--      note (member_contact_notes) for that member inside the window. The
--      task stays the engine's generic 'Review connected work' card; no
--      member name or case detail is copied (the old card named the member,
--      which the current task-card rule forbids).
--      Ownership: this lane owns the automation trigger; read-side queue
--      signals belong to.
--
--   4. Alert routing. public.organization_automation_routing_rules holds an
--      organization's rules (chapter rules before organization rules, then
--      sort order and name; optional task-priority filter). When an
--      automation creates a follow-up task, the first matching enabled rule
--      notifies, in-app only, the source owner (task assignees, or the case
--      steward and otherwise its coordinator), the chapter stewards, the
--      chapter admins/presidents, or the coordinators. A recipient must be an
--      active member of the organization with a staff role in the source's
--      chapter and, for a case source, must be able to open that case
--      (private.automation_v2_case_visible); everyone else is skipped. At
--      most 20 recipients per task. Routing never fails the effect. The
--      three old global rules are seeded per organization with the default
--      recipes (old 'urgent'/'high' priorities map to the current 'high').
--      Switch features.automation.alert_routing (default ON: the old rules
--      were seeded enabled). Approvers manage rules through
--      mi1_save_automation_routing_rule / mi1_delete_automation_routing_rule;
--      every automation author can read them.
--
-- Boundaries kept: tenant isolation (every row is organization-scoped and
-- every RPC derives the organization from the selected session), MFA on every
-- public RPC, the restricted-case boundary, the existing per-run effect cap
-- and rollback window, and the review lifecycle for edited definitions.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Six engine functions are re-declared below from their installed bodies
-- (20260910045839, 20260925630300, 20260925630600). Refuse any other
-- predecessor. Each keeps its case-graph lock where it had one.
do $predecessor$
declare
  r record;
  source text;
  digest text;
begin
  for r in select * from (values
    ('private.automation_v2_candidates(uuid, boolean)', 'f4ca552fa8a3ad3e9a2e363c85bd984ddf70ed82b25a0f7a44d2977cfeee87d9'),
    ('private.automation_v2_validate(uuid, jsonb)', '7ead374b8cf5a87a41cae3bc4e2961bcb9ed2d431af36429c654aca21e25a544'),
    ('private.automation_v2_execute(uuid)', '379a274ebd9757263d162840830b7cea8b5809c39491ece7e03c913b94cf382f'),
    ('private.run_due_organization_automations(integer)', '5a1c26c07206d946ccd315cb293687ef324543bfc2a2d6700abf75a6bd1dbf31'),
    ('private.automation_v3_definition_json(public.organization_automation_definitions, uuid, uuid, boolean)', 'a006e88fc03b6ae9b29041bb34781d662b1eec1cc13e981c5842c99723af1db8'),
    ('public.mi1_get_automation_workspace()', '8b0cf56b8459fa720c909861ce20888ef8ceec266597e63e1c04d6b78c22d606')
  ) reviewed(signature, source_sha256) loop
    select p.prosrc into strict source
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(r.signature);
    digest := pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
      'hex'
    );
    if digest is distinct from r.source_sha256 then
      raise exception 'unreviewed % predecessor: %', r.signature, digest
        using errcode = '55000';
    end if;
  end loop;
end;
$predecessor$;

-- ---------------------------------------------------------------------------
-- 1. Organization switches (Feature switches & limits, category automation)
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- Old default ON: automation_recipes_enabled seeded 'true'
  -- (de7df4b57c^:supabase/migrations/0577_automation_safety.sql:96-104) and
  -- AUTOMATION_RECIPE_DEFAULTS all enabled (lib/crm/automation-recipes.ts:47-54).
  ('features.automation.default_recipes', 'boolean', 'Default automation recipes',
   'Give the organization the four default automation recipes (overdue tasks, deadline risk, unowned cases, quiet member contact) and let them run.',
   'true', null, null, null, 10, 'automation', false),
  -- Old default ON: three enabled global rules seeded by
  -- de7df4b57c^:supabase/migrations/0529_alert_routing_rules.sql:105-139.
  ('features.automation.alert_routing', 'boolean', 'Automation alert routing',
   'When an automation creates a follow-up task, notify the people its routing rule names (in-app only).',
   'true', null, null, null, 20, 'automation', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Schema
-- ---------------------------------------------------------------------------

alter table public.organization_audit_ledger
  drop constraint organization_audit_ledger_entity_type_check;

alter table public.organization_audit_ledger
  add constraint organization_audit_ledger_entity_type_check check (entity_type in (
    'organization', 'chapter', 'membership', 'role_grant', 'member', 'case',
    'message', 'event', 'campaign', 'broadcast', 'invitation', 'export',
    'document', 'reward', 'job_run', 'security_policy', 'audit_event',
    'automation_definition', 'automation_run', 'retention_policy', 'retention_run',
    'message_legal_hold', 'automation_routing_rule'
  ));

alter table public.organization_automation_definitions
  add column recipe_key text,
  add column provenance text not null default 'organization'
    check (provenance in ('organization', 'system')),
  add constraint organization_automation_definitions_recipe_key_check check (
    recipe_key is null or recipe_key in (
      'overdue_task_escalation', 'deadline_risk_alert',
      'unassigned_case_assignment', 'stale_contact_followup'
    )
  ),
  drop constraint organization_automation_definitions_trigger_kind_check,
  add constraint organization_automation_definitions_trigger_kind_check check (trigger_kind in (
    'overdue_task','case_deadline','unassigned_case','task_due','blocked_task',
    'unassigned_task','stale_task','review_task','casework_deadline',
    'incomplete_case_checklist','appointment_upcoming','appointment_followup',
    'event_upcoming','event_followup','stale_member_contact')),
  add constraint organization_automation_definitions_stale_contact_threshold check (
    trigger_kind <> 'stale_member_contact' or threshold_days >= 1
  );

comment on column public.organization_automation_definitions.recipe_key is
  'Restored default recipe identity (REQ-UG-AUTOMATION-RECIPE-DEFAULTS-20261001). One definition per key per organization, archived ones included, so an archived default recipe is never re-created. Null for every custom definition.';

comment on column public.organization_automation_definitions.provenance is
  'Explicit system provenance only for untouched default-recipe drafts. Any human save, submission, review or activation changes it to organization; provenance never grants execution authority.';

create function private.automation_clear_system_provenance_on_human_edit()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.provenance = 'system' and (
    (new.updated_by is not null and new.updated_by is distinct from old.updated_by)
    or (new.submitted_by is not null and new.submitted_by is distinct from old.submitted_by)
    or (new.reviewed_by is not null and new.reviewed_by is distinct from old.reviewed_by)
  ) then
    new.provenance := 'organization';
  end if;
  return new;
end;
$function$;

revoke all on function private.automation_clear_system_provenance_on_human_edit() from public, anon, authenticated, service_role;
create trigger automation_clear_system_provenance_on_human_edit
before update on public.organization_automation_definitions
for each row execute function private.automation_clear_system_provenance_on_human_edit();

-- Archived default recipes keep their key: the index has no status predicate.
create unique index organization_automation_definitions_recipe_key_idx
  on public.organization_automation_definitions (organization_id, recipe_key)
  where recipe_key is not null;

create table public.organization_automation_routing_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  -- Null = every chapter of the organization; a chapter rule wins over an
  -- organization rule for the same event (old branch rules over global ones).
  chapter_id text references public.chapters(id) on update cascade on delete cascade,
  name text not null,
  enabled boolean not null default true,
  event_kind text not null check (event_kind in (
    'overdue_task', 'case_deadline', 'unassigned_case', 'stale_member_contact'
  )),
  -- Null = any task priority; otherwise the created task's priority must be listed.
  match_priorities text[],
  route_to text not null check (route_to in (
    'source_owner', 'chapter_stewards', 'chapter_admins', 'coordinators'
  )),
  sort_order integer not null default 100 check (sort_order between 0 and 1000),
  is_default boolean not null default false,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_automation_routing_rules_name_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(name)) between 3 and 80
    and name !~ '[[:cntrl:]]'
  ),
  constraint organization_automation_routing_rules_priorities check (
    match_priorities is null
    or (
      pg_catalog.cardinality(match_priorities) between 1 and 3
      and match_priorities <@ array['low', 'medium', 'high']::text[]
    )
  )
);

create unique index organization_automation_routing_rules_name_idx
  on public.organization_automation_routing_rules (organization_id, pg_catalog.lower(pg_catalog.btrim(name)));

create index organization_automation_routing_rules_match_idx
  on public.organization_automation_routing_rules (organization_id, event_kind, sort_order)
  where enabled;

create index organization_automation_routing_rules_chapter_idx
  on public.organization_automation_routing_rules (chapter_id)
  where chapter_id is not null;

alter table public.organization_automation_routing_rules enable row level security;
revoke all on table public.organization_automation_routing_rules from public, anon, authenticated, service_role;

create policy mfa_assurance on public.organization_automation_routing_rules
as restrictive for all to authenticated
using ((select private.mfa_satisfied()))
with check ((select private.mfa_satisfied()));

comment on policy mfa_assurance on public.organization_automation_routing_rules is
  'Restrictive MFA boundary. There is no client table grant: automation authors read and approvers write only through the mi1_*_automation_routing_rule RPCs.';

-- The table joins the account case graph through organizations and chapters;
-- it carries the same statement and row gates as its sibling automation
-- tables. It has no auth.users column, so the row gate names no identity.
create trigger a00_case_graph_lock before insert or update or delete on public.organization_automation_routing_rules
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organization_automation_routing_rules
for each row execute function private.lock_case_graph_row_keys('', '');

comment on table public.organization_automation_routing_rules is
  'Restored automation alert routing (old 0529 alert_routing_rules, REQ-UG-AUTOMATION-RECIPE-DEFAULTS-20261001). Organization-scoped; read and written only through SECURITY DEFINER RPCs; resolved by private.automation_route_effect.';

-- ---------------------------------------------------------------------------
-- 3. Default recipe helpers
-- ---------------------------------------------------------------------------

-- System scope for an approved default recipe's scheduled run: the
-- organization's own live chapter tasks and its own non-restricted cases (and
-- their deadlines and checklists). Restricted cases are never in scope.
create function private.automation_recipe_source_in_scope(p_org uuid, p_kind text, p_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_org is not null and case p_kind
    when 'task' then exists (
      select 1 from public.chapter_tasks t
      join public.chapters ch on ch.id = t.chapter_id and ch.organization_id = p_org
      where t.id::text = p_id and t.deleted_at is null)
    when 'case' then exists (
      select 1 from public.member_cases c
      join public.chapters ch on ch.id = c.chapter_id and ch.organization_id = p_org
      where c.id::text = p_id and c.organization_id = p_org and not c.is_restricted)
    when 'casework_deadline' then exists (
      select 1 from public.casework_deadlines x
      join public.member_cases c on c.id = x.case_id and c.organization_id = x.organization_id
      where x.id::text = p_id and x.organization_id = p_org and not c.is_restricted)
    when 'checklist' then exists (
      select 1 from public.casework_checklists x
      join public.member_cases c on c.id = x.case_id and c.organization_id = x.organization_id
      where x.id::text = p_id and x.organization_id = p_org and not c.is_restricted)
    else false
  end;
$function$;

comment on function private.automation_recipe_source_in_scope(uuid, text, text) is
  'Scope of an approved default recipe''s scheduled run: the organization''s own live tasks and non-restricted cases. Execution still requires a live human approver; restricted cases are never in scope.';

-- Seeds the four default recipes and the three old routing rules for one
-- organization, once. Returns the number of recipe definitions created.
create function private.automation_seed_default_recipes(p_org uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  created integer := 0;
begin
  if p_org is null
     or not exists (select 1 from public.organizations o where o.id = p_org and o.status = 'active')
     or not private.organization_feature_enabled(p_org, 'features.automation.default_recipes') then
    return 0;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || p_org::text, 0));
  -- Once per organization: any default recipe row, archived included, means
  -- the organization already received them.
  if exists (
    select 1 from public.organization_automation_definitions d
    where d.organization_id = p_org and d.recipe_key is not null
  ) then
    return 0;
  end if;

  -- Old recipes (lib/crm/automation-recipes.ts RECIPE_CONFIGS) with the old
  -- windows: overdue = past due, lookahead 7 days, stale contact 14 days.
  insert into public.organization_automation_definitions (
    organization_id, name, trigger_kind, threshold_days, task_priority, cadence,
    action_kind, schema_version, conditions, action_config, status,
    review_status, review_version, next_run_at, recipe_key, provenance, created_by, updated_by
  )
  select p_org, recipe.name, recipe.trigger_kind, recipe.threshold_days, recipe.task_priority, 'daily',
         'create_standard_task', 2, '{}'::jsonb, '{}'::jsonb, 'draft',
         'draft', null, null, recipe.recipe_key, 'system', null, null
  from (values
    ('overdue_task_escalation', 'Escalate overdue tasks', 'overdue_task', 1::smallint, 'high'),
    ('deadline_risk_alert', 'Alert on deadline risk', 'case_deadline', 7::smallint, 'high'),
    ('unassigned_case_assignment', 'Assign unowned cases', 'unassigned_case', 0::smallint, 'medium'),
    ('stale_contact_followup', 'Follow up on quiet member contact', 'stale_member_contact', 14::smallint, 'medium')
  ) as recipe(recipe_key, name, trigger_kind, threshold_days, task_priority)
  -- A custom definition that already uses one of these names keeps it; that
  -- recipe is simply not created.
  on conflict do nothing;
  get diagnostics created = row_count;

  insert into public.organization_automation_routing_rules (
    organization_id, chapter_id, name, enabled, event_kind, match_priorities, route_to, sort_order, is_default
  )
  select p_org, null, rule.name, true, rule.event_kind, rule.priorities, rule.route_to, rule.sort_order, true
  from (values
    ('Urgent deadline risk to chapter admins', 'case_deadline', array['high']::text[], 'chapter_admins', 10),
    ('Unowned case to coordinators', 'unassigned_case', null::text[], 'coordinators', 20),
    ('Overdue task escalation to the assignee', 'overdue_task', array['high']::text[], 'source_owner', 30)
  ) as rule(name, event_kind, priorities, route_to, sort_order)
  on conflict do nothing;

  perform private.cr108_record_audit(
    p_org, 'automation_default_recipes_seeded', 'create', 'automation_definition', p_org::text, null,
    pg_catalog.jsonb_build_object('count', created, 'executionEnabled', false),
    extensions.gen_random_uuid()
  );
  return created;
end;
end;
$function$;

comment on function private.automation_seed_default_recipes(uuid) is
  'REQ-UG-AUTOMATION-RECIPE-DEFAULTS-20261001: after an admin explicitly enables automation, offers four inactive, unapproved system-provenance drafts and the three old routing rules. It never enables the master switch or approves a recipe.';

create function private.offer_automation_default_drafts_on_enable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  -- Only the authenticated approver's explicit master-switch action offers
  -- drafts. Background ticks and the migration never seed an organization.
  if new.enabled and auth.uid() is not null
     and private.automation_v3_require_approver() = new.organization_id then
    perform private.automation_seed_default_recipes(new.organization_id);
  end if;
  return new;
end;
$function$;

revoke all on function private.offer_automation_default_drafts_on_enable() from public, anon, authenticated, service_role;

create trigger offer_automation_default_drafts_on_enable
after insert or update of enabled on public.organization_automation_settings
for each row execute function private.offer_automation_default_drafts_on_enable();

-- ---------------------------------------------------------------------------
-- 4. Alert routing
-- ---------------------------------------------------------------------------

insert into private.notification_copy (key, lang, title, body) values
  ('automation.routed', 'en', 'An automation needs your attention', 'A follow-up task was created for work you are responsible for. Open Tasks to review it.'),
  ('automation.routed', 'es', 'Una automatización necesita tu atención', 'Se creó una tarea de seguimiento para un trabajo a tu cargo. Abre Tareas para revisarla.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

create function private.automation_route_effect(p_effect_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  ef public.organization_automation_effects%rowtype;
  def public.organization_automation_definitions%rowtype;
  rule public.organization_automation_routing_rules%rowtype;
  routed_case uuid;
  recipient uuid;
  sent integer := 0;
begin
  select e.* into ef
  from public.organization_automation_effects e
  where e.id = p_effect_id and e.status = 'created' and e.action_kind = 'create_standard_task';
  if ef.id is null
     or not private.organization_feature_enabled(ef.organization_id, 'features.automation.alert_routing') then
    return 0;
  end if;
  select d.* into def
  from public.organization_automation_definitions d
  where d.id = ef.definition_id and d.organization_id = ef.organization_id;
  if def.id is null
     or def.trigger_kind not in ('overdue_task', 'case_deadline', 'unassigned_case', 'stale_member_contact') then
    return 0;
  end if;

  -- First enabled rule: chapter rules before organization rules, then sort
  -- order and name (old lib/notifications/alert-routing.ts resolveAlertRoute).
  select r.* into rule
  from public.organization_automation_routing_rules r
  where r.organization_id = ef.organization_id
    and r.enabled
    and r.event_kind = def.trigger_kind
    and (r.chapter_id is null or r.chapter_id = ef.chapter_id)
    and (r.match_priorities is null or ef.task_priority = any (r.match_priorities))
  order by (r.chapter_id is null), r.sort_order, pg_catalog.lower(r.name), r.id
  limit 1;
  if rule.id is null then
    return 0;
  end if;

  if ef.source_kind = 'case' then
    routed_case := ef.source_id::uuid;
  end if;

  for recipient in
    select distinct candidate.user_id
    from (
      select t.assignee_id as user_id
      from public.chapter_tasks t
      where rule.route_to = 'source_owner' and ef.source_kind = 'task' and t.id::text = ef.source_id
      union all
      select a.assignee_id
      from public.chapter_task_assignments a
      where rule.route_to = 'source_owner' and ef.source_kind = 'task' and a.task_id::text = ef.source_id
      union all
      select coalesce(c.steward_user_id, c.coordinator_user_id)
      from public.member_cases c
      where rule.route_to = 'source_owner' and c.id = routed_case
      union all
      select g.user_id
      from public.member_role_chapters g
      join public.member_chapter_memberships cm
        on cm.user_id = g.user_id and cm.chapter_id = g.chapter_id and cm.status = 'active'
      where g.chapter_id = ef.chapter_id
        and g.role = any (case rule.route_to
          when 'chapter_stewards' then array['steward']
          when 'chapter_admins' then array['admin', 'vp']
          when 'coordinators' then array['coordinator']
          else array[]::text[] end)
      union all
      select g.user_id
      from public.organization_role_grants g
      where g.organization_id = ef.organization_id
        and g.role = any (case rule.route_to
          when 'chapter_stewards' then array['steward']
          when 'chapter_admins' then array['admin', 'vp']
          when 'coordinators' then array['coordinator']
          else array[]::text[] end)
    ) candidate
    where candidate.user_id is not null
      and exists (
        select 1 from public.organization_memberships m
        where m.organization_id = ef.organization_id and m.user_id = candidate.user_id and m.status = 'active'
      )
      -- Only people who could already open the source are told about it.
      and private.actor_has_chapter_staff_role(candidate.user_id, ef.chapter_id)
      and (routed_case is null or private.automation_v2_case_visible(candidate.user_id, ef.organization_id, routed_case))
    order by candidate.user_id
    limit 20
  loop
    -- In-app only ('general' is outside the external delivery vocabulary),
    -- like the old routed notifications.
    perform private.notify_member(recipient, 'automation.routed', '{}'::jsonb, 'general');
    sent := sent + 1;
  end loop;
  return sent;
end;
end;
$function$;

comment on function private.automation_route_effect(uuid) is
  'Restored alert routing: for a created automation follow-up task, the first matching enabled routing rule sends a generic in-app notice to at most 20 recipients who are active organization members with a staff role in the source chapter and, for a case, can open it. Returns the number notified.';

create function private.automation_routing_rule_json(r public.organization_automation_routing_rules)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', r.id, 'name', r.name, 'eventKind', r.event_kind, 'routeTo', r.route_to,
    'enabled', r.enabled, 'isDefault', r.is_default, 'sortOrder', r.sort_order,
    'priorities', pg_catalog.to_jsonb(r.match_priorities), 'chapterId', r.chapter_id,
    'updatedAt', r.updated_at
  );
$function$;

create function public.mi1_get_automation_routing_rules()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid;
  rules jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  org := private.automation_v3_require_author();
  select coalesce(pg_catalog.jsonb_agg(private.automation_routing_rule_json(r) order by r.sort_order, pg_catalog.lower(r.name), r.id), '[]'::jsonb)
    into rules
  from (
    select * from public.organization_automation_routing_rules r
    where r.organization_id = org
    order by r.sort_order, pg_catalog.lower(r.name), r.id
    limit 50
  ) r;
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'enabled', private.organization_feature_enabled(org, 'features.automation.alert_routing'),
    'canManage', private.automation_v3_actor_is_approver(actor, org),
    'rules', rules
  );
end;
$function$;

create function public.mi1_save_automation_routing_rule(p_rule jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  actor uuid := (select auth.uid());
  org uuid;
  rule_id uuid;
  priorities text[];
  chapter text;
  saved public.organization_automation_routing_rules%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  org := private.automation_v3_require_approver();
  if pg_catalog.jsonb_typeof(p_rule) is distinct from 'object'
     or not (p_rule ?& array['name', 'eventKind', 'routeTo', 'enabled'])
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_rule) k
       where k not in ('id', 'name', 'eventKind', 'routeTo', 'enabled', 'priorities', 'chapterId', 'sortOrder')
     )
     or pg_catalog.jsonb_typeof(p_rule->'name') is distinct from 'string'
     or pg_catalog.char_length(pg_catalog.btrim(p_rule->>'name')) not between 3 and 80
     or p_rule->>'name' ~ '[[:cntrl:]]'
     or p_rule->>'eventKind' is null
     or p_rule->>'eventKind' not in ('overdue_task', 'case_deadline', 'unassigned_case', 'stale_member_contact')
     or p_rule->>'routeTo' is null
     or p_rule->>'routeTo' not in ('source_owner', 'chapter_stewards', 'chapter_admins', 'coordinators')
     or pg_catalog.jsonb_typeof(p_rule->'enabled') is distinct from 'boolean'
     or (p_rule ? 'sortOrder' and (pg_catalog.jsonb_typeof(p_rule->'sortOrder') is distinct from 'number'
       or (p_rule->>'sortOrder') !~ '^[0-9]{1,4}$' or (p_rule->>'sortOrder')::integer > 1000))
     or (p_rule ? 'id' and (pg_catalog.jsonb_typeof(p_rule->'id') is distinct from 'string'
       or p_rule->>'id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))
     or (p_rule ? 'chapterId' and pg_catalog.jsonb_typeof(p_rule->'chapterId') not in ('string', 'null')) then
    raise exception 'invalid routing rule' using errcode = '22023';
  end if;
  if p_rule ? 'priorities' and pg_catalog.jsonb_typeof(p_rule->'priorities') <> 'null' then
    if pg_catalog.jsonb_typeof(p_rule->'priorities') <> 'array'
       or exists (select 1 from pg_catalog.jsonb_array_elements(p_rule->'priorities') v where pg_catalog.jsonb_typeof(v) <> 'string') then
      raise exception 'invalid routing rule' using errcode = '22023';
    end if;
    select pg_catalog.array_agg(v order by v) into priorities
    from pg_catalog.jsonb_array_elements_text(p_rule->'priorities') v;
    if pg_catalog.cardinality(priorities) not between 1 and 3
       or not (priorities <@ array['low', 'medium', 'high']::text[])
       or (select pg_catalog.count(distinct v) from pg_catalog.unnest(priorities) v) <> pg_catalog.cardinality(priorities) then
      raise exception 'invalid routing rule' using errcode = '22023';
    end if;
  end if;
  chapter := nullif(p_rule->>'chapterId', '');
  if chapter is not null and not exists (
    select 1 from public.chapters ch where ch.id = chapter and ch.organization_id = org
  ) then
    raise exception 'chapter unavailable' using errcode = '42501';
  end if;
  rule_id := (p_rule->>'id')::uuid;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if rule_id is null then
    if (select pg_catalog.count(*) from public.organization_automation_routing_rules r where r.organization_id = org) >= 50 then
      raise exception 'routing rule limit reached' using errcode = '54000';
    end if;
    insert into public.organization_automation_routing_rules (
      organization_id, chapter_id, name, enabled, event_kind, match_priorities, route_to, sort_order, is_default
    ) values (
      org, chapter, pg_catalog.btrim(p_rule->>'name'), (p_rule->>'enabled')::boolean, p_rule->>'eventKind',
      priorities, p_rule->>'routeTo', coalesce((p_rule->>'sortOrder')::integer, 100), false
    ) returning * into saved;
  else
    update public.organization_automation_routing_rules r
       set chapter_id = chapter,
           name = pg_catalog.btrim(p_rule->>'name'),
           enabled = (p_rule->>'enabled')::boolean,
           event_kind = p_rule->>'eventKind',
           match_priorities = priorities,
           route_to = p_rule->>'routeTo',
           sort_order = coalesce((p_rule->>'sortOrder')::integer, r.sort_order),
           updated_at = pg_catalog.now()
     where r.id = rule_id and r.organization_id = org
     returning * into saved;
    if saved.id is null then
      raise exception 'routing rule unavailable' using errcode = '22023';
    end if;
  end if;
  perform private.cr108_record_audit(
    org, 'automation_routing_rule_saved', case when rule_id is null then 'create' else 'update' end,
    'automation_routing_rule', saved.id::text, actor,
    pg_catalog.jsonb_build_object('status', case when saved.enabled then 'enabled' else 'disabled' end),
    extensions.gen_random_uuid()
  );
  return private.automation_routing_rule_json(saved) || pg_catalog.jsonb_build_object('organizationId', org);
end;
end;
$function$;

create function public.mi1_delete_automation_routing_rule(p_rule_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  actor uuid := (select auth.uid());
  org uuid;
  removed uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  org := private.automation_v3_require_approver();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  delete from public.organization_automation_routing_rules r
   where r.id = p_rule_id and r.organization_id = org
  returning r.id into removed;
  if removed is null then
    raise exception 'routing rule unavailable' using errcode = '22023';
  end if;
  perform private.cr108_record_audit(
    org, 'automation_routing_rule_deleted', 'delete', 'automation_routing_rule', removed::text, actor,
    '{}'::jsonb, extensions.gen_random_uuid()
  );
  return pg_catalog.jsonb_build_object('organizationId', org, 'id', removed, 'deleted', true);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Engine re-declarations (minimal edits, marked 20261003030000)
-- ---------------------------------------------------------------------------

create or replace function private.automation_v2_candidates(p_definition_id uuid,p_deduplicate boolean default true)
returns table(source_kind text,source_id text,chapter_id text,sort_at timestamptz)
language sql stable security definer set search_path = '' as $$
 with d as (select * from public.organization_automation_definitions where id=p_definition_id and schema_version=2),
 raw as (
 select 'task'::text kind,t.id::text id,t.chapter_id,t.updated_at sort_at,t.status
 from d join public.chapter_tasks t on true join public.chapters ch on ch.id=t.chapter_id
 where ch.organization_id=d.organization_id and t.deleted_at is null and t.status<>'done'
 and not exists(select 1 from public.organization_automation_effects e where e.planned_task_id=t.id)
 and case d.trigger_kind
   when 'overdue_task' then t.due_date <= (now() at time zone 'UTC')::date-d.threshold_days
   when 'task_due' then t.due_date between (now() at time zone 'UTC')::date and (now() at time zone 'UTC')::date+d.threshold_days
   when 'blocked_task' then t.blocked
   when 'unassigned_task' then t.assignee_id is null and not exists(select 1 from public.chapter_task_assignments a where a.task_id=t.id)
   when 'stale_task' then t.updated_at <= now()-d.threshold_days*interval '24 hours'
   when 'review_task' then t.status='needs_review' and t.updated_at<=now()-d.threshold_days*interval '24 hours'
   else false end
 union all
 select 'case',c.id::text,c.chapter_id,c.created_at,c.status
 from d join public.member_cases c on c.organization_id=d.organization_id
 where c.chapter_id is not null and c.status='active' and case d.trigger_kind
 when 'case_deadline' then c.deadline <= (now() at time zone 'UTC')::date+d.threshold_days
 when 'unassigned_case' then c.steward_user_id is null and c.coordinator_user_id is null
 -- Restored stale_contact_followup (20261003030000): one source per member,
 -- the member's oldest active case, when the organization recorded no contact
 -- with that member inside the window.
 when 'stale_member_contact' then c.created_at <= now()-d.threshold_days*interval '24 hours'
   and c.id=(select o.id from public.member_cases o where o.organization_id=c.organization_id and o.user_id=c.user_id
     and o.status='active' and o.chapter_id is not null order by o.created_at,o.id limit 1)
   and exists(select 1 from public.organization_memberships m where m.organization_id=c.organization_id and m.user_id=c.user_id and m.status='active')
   and not exists(select 1 from public.member_case_contacts x join public.member_cases xc on xc.id=x.case_id and xc.organization_id=c.organization_id
     where x.user_id=c.user_id and x.contacted_at>now()-d.threshold_days*interval '24 hours')
   and not exists(select 1 from public.chapter_contact_log x where x.organization_id=c.organization_id and x.subject_user_id=c.user_id
     and x.archived_at is null and x.occurred_at>now()-d.threshold_days*interval '24 hours')
   and not exists(select 1 from public.member_contact_notes x join public.chapters xch on xch.id=x.chapter_id and xch.organization_id=c.organization_id
     where x.member_user_id=c.user_id and x.created_at>now()-d.threshold_days*interval '24 hours')
 else false end
 union all
 select 'casework_deadline',x.id::text,x.chapter_id,x.due_at,x.status
 from d join public.casework_deadlines x on x.organization_id=d.organization_id
 join public.member_cases c on c.id=x.case_id and c.organization_id=x.organization_id and c.chapter_id=x.chapter_id
 where d.trigger_kind='casework_deadline' and c.status='active' and x.status in ('active','missed')
 and x.due_at <= now()+d.threshold_days*interval '24 hours'
 and (not d.conditions ? 'deadlineKind' or x.kind=d.conditions->>'deadlineKind')
 union all
 select 'checklist',x.id::text,x.chapter_id,x.created_at,null::text
 from d join public.casework_checklists x on x.organization_id=d.organization_id
 join public.member_cases c on c.id=x.case_id and c.organization_id=x.organization_id and c.chapter_id=x.chapter_id
 where d.trigger_kind='incomplete_case_checklist' and c.status='active' and x.completed_at is null
 and exists(select 1 from public.casework_checklist_items i where i.checklist_id=x.id and i.organization_id=x.organization_id and i.required and i.completed_at is null)
 union all
 select 'appointment',a.id::text,a.chapter_id,a.starts_at,a.status
 from d join public.member_appointments a on true join public.chapters ch on ch.id=a.chapter_id and ch.organization_id=d.organization_id
 where case d.trigger_kind
 when 'appointment_upcoming' then a.status='confirmed' and a.starts_at between now() and now()+d.threshold_days*interval '24 hours'
 when 'appointment_followup' then a.status in ('completed','no_show') and a.ends_at between now()-d.threshold_days*interval '24 hours' and now()
 else false end
 union all
 select 'event',e.id,e.chapter_id,e.starts_at,null::text
 from d join public.member_events e on true join public.chapters ch on ch.id=e.chapter_id and ch.organization_id=d.organization_id
 where e.cancelled_at is null and case d.trigger_kind
 when 'event_upcoming' then e.starts_at between now() and now()+d.threshold_days*interval '24 hours'
 -- Events have a start instant, not a completion state. Follow-up means after
 -- the recorded start; the UI must not claim the event was completed.
 when 'event_followup' then e.starts_at between now()-d.threshold_days*interval '24 hours' and now()
 else false end
 )
 select r.kind,r.id,r.chapter_id,r.sort_at from raw r cross join d
 -- A scheduled, approved default recipe may cover non-restricted work across
 -- its organization. Manual evaluations retain the actor's own visibility.
 -- The executor separately requires d.updated_by to remain a live approver;
 -- source scope alone never grants execution authority.
 where case when auth.uid() is null and d.recipe_key is not null
              and d.status = 'active' and d.review_status = 'approved'
              and d.review_version = d.version
              and private.automation_v2_operator(d.updated_by, d.organization_id)
   then private.automation_recipe_source_in_scope(d.organization_id,r.kind,r.id)
   else private.automation_v2_source_visible(coalesce(auth.uid(),d.updated_by),d.organization_id,r.kind,r.id) end
 and (not d.conditions ? 'chapterId' or r.chapter_id=d.conditions->>'chapterId')
 -- Case-family context always identifies the parent case. Effect provenance
 -- still identifies the actual deadline/checklist that matched the predicate.
 and (not d.conditions ? 'sourceId' or case r.kind
   when 'casework_deadline' then exists(select 1 from public.casework_deadlines x where x.id::text=r.id and x.case_id::text=d.conditions->>'sourceId')
   when 'checklist' then exists(select 1 from public.casework_checklists x where x.id::text=r.id and x.case_id::text=d.conditions->>'sourceId')
   else r.id=d.conditions->>'sourceId' end)
 and (not d.conditions ? 'status' or r.status=d.conditions->>'status')
 and (not d.conditions ? 'priority' or exists(select 1 from public.chapter_tasks t where r.kind='task' and t.id::text=r.id and t.priority=d.conditions->>'priority'))
 and (not d.conditions ? 'assignment' or exists(select 1 from public.chapter_tasks t where r.kind='task' and t.id::text=r.id
   and (t.assignee_id is not null or exists(select 1 from public.chapter_task_assignments a where a.task_id=t.id))=(d.conditions->>'assignment'='assigned')))
 -- Action no-ops never consume the first page of a capped run or starve later
 -- eligible sources. The executor repeats these checks after row locking.
 and (d.action_kind<>'assign_task' or exists(select 1 from public.chapter_tasks t where t.id::text=r.id and r.kind='task' and t.assignee_id is null
   and not exists(select 1 from public.chapter_task_assignments a where a.task_id=t.id)))
 and (d.action_kind<>'raise_task_priority' or exists(select 1 from public.chapter_tasks t where t.id::text=r.id and r.kind='task'
   and array_position(array['low','medium','high'],t.priority)<array_position(array['low','medium','high'],d.action_config->>'priority')))
 and (not p_deduplicate or not exists(select 1 from public.organization_automation_effects e
 where e.organization_id=d.organization_id and e.definition_id=d.id and e.source_kind=r.kind and e.source_id=r.id and e.status in ('pending','created')))
 order by r.sort_at,r.id;
$$;

create or replace function private.automation_v2_validate(p_org uuid,p_spec jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
declare k text; tr text:=p_spec->>'triggerKind'; ac text:=p_spec->>'actionKind';
 co jsonb:=p_spec->'conditions'; cfg jsonb:=p_spec->'actionConfig'; sk text;
begin
 if jsonb_typeof(p_spec) is distinct from 'object' or p_spec->'schemaVersion' is distinct from '2'::jsonb
 or not (p_spec ?& array['name','triggerKind','thresholdDays','cadence','taskPriority','conditions','actionKind','actionConfig'])
 or exists(select 1 from jsonb_object_keys(p_spec) x where x not in ('schemaVersion','id','expectedVersion','name','triggerKind','thresholdDays','cadence','taskPriority','conditions','actionKind','actionConfig'))
 or jsonb_typeof(co) is distinct from 'object' or jsonb_typeof(cfg) is distinct from 'object'
 or jsonb_typeof(p_spec->'name') is distinct from 'string'
 or jsonb_typeof(p_spec->'triggerKind') is distinct from 'string'
 or jsonb_typeof(p_spec->'cadence') is distinct from 'string'
 or jsonb_typeof(p_spec->'taskPriority') is distinct from 'string'
 or jsonb_typeof(p_spec->'actionKind') is distinct from 'string'
 or jsonb_typeof(p_spec->'thresholdDays') is distinct from 'number'
 or (p_spec->>'thresholdDays') !~ '^[0-9]{1,2}$' or (p_spec->>'thresholdDays')::integer >90
 or length(btrim(p_spec->>'name')) not between 3 and 80 or p_spec->>'name' ~ '[[:cntrl:]]'
 or p_spec->>'cadence' not in ('hourly','daily','weekly') or p_spec->>'taskPriority' not in ('low','medium','high')
 or tr not in ('overdue_task','case_deadline','unassigned_case','task_due','blocked_task','unassigned_task','stale_task','review_task','casework_deadline','incomplete_case_checklist','appointment_upcoming','appointment_followup','event_upcoming','event_followup','stale_member_contact')
 or ac not in ('create_standard_task','assign_task','raise_task_priority','notify_in_app') then
 raise exception 'invalid automation capability contract' using errcode='22023'; end if;
 if p_spec ? 'id' and (jsonb_typeof(p_spec->'id') is distinct from 'string' or p_spec->>'id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then raise exception 'invalid definition id' using errcode='22023'; end if;
 if p_spec ? 'expectedVersion' and (not p_spec ? 'id' or jsonb_typeof(p_spec->'expectedVersion') is distinct from 'number' or p_spec->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$') then raise exception 'invalid definition version' using errcode='22023'; end if;
 if p_spec ? 'id' and not p_spec ? 'expectedVersion' then raise exception 'definition version required' using errcode='22023'; end if;
 if exists(select 1 from jsonb_each(cfg) x where jsonb_typeof(x.value) is distinct from 'string') then raise exception 'invalid action value type' using errcode='22023'; end if;
 sk:=case when tr in ('case_deadline','unassigned_case','stale_member_contact') then 'case' when tr='casework_deadline' then 'casework_deadline'
 when tr='incomplete_case_checklist' then 'checklist' when tr like 'appointment_%' then 'appointment' when tr like 'event_%' then 'event' else 'task' end;
 if tr in ('unassigned_case','blocked_task','unassigned_task','incomplete_case_checklist') and (p_spec->>'thresholdDays')::integer<>0 then raise exception 'threshold not supported' using errcode='22023'; end if;
 if tr='stale_member_contact' and (p_spec->>'thresholdDays')::integer<1 then raise exception 'threshold not supported' using errcode='22023'; end if;
 if tr='review_task' and co ? 'status' and co->>'status'<>'needs_review' then raise exception 'review status required' using errcode='22023'; end if;
 if co ? 'sourceId' and ((sk='event' and co->>'sourceId' !~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$') or (sk<>'event' and co->>'sourceId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) then raise exception 'invalid source reference' using errcode='22023'; end if;
 for k in select jsonb_object_keys(co) loop
 if k not in ('chapterId','sourceId','status','deadlineKind','priority','assignment') or jsonb_typeof(co->k)<>'string' or length(co->>k) not between 1 and 200 or co->>k ~ '[[:cntrl:]]' then
 raise exception 'unsupported automation condition' using errcode='22023'; end if; end loop;
 if co ? 'chapterId' and length(co->>'chapterId')>128 then raise exception 'invalid chapter reference' using errcode='22023'; end if;
 if co ? 'priority' and (sk<>'task' or co->>'priority' not in ('low','medium','high')) then raise exception 'invalid task priority condition' using errcode='22023'; end if;
 if co ? 'assignment' and (sk<>'task' or co->>'assignment' not in ('assigned','unassigned') or (tr='unassigned_task' and co->>'assignment'='assigned')) then raise exception 'invalid assignment condition' using errcode='22023'; end if;
 if co ? 'deadlineKind' and (tr<>'casework_deadline' or co->>'deadlineKind' not in ('filing','response','hearing','appeal','follow_up')) then
 raise exception 'unsupported deadline kind' using errcode='22023'; end if;
 if co ? 'status' and not (case sk when 'task' then co->>'status' in ('backlog','to_do','in_progress','needs_review') when 'case' then co->>'status'='active'
 when 'casework_deadline' then co->>'status' in ('active','missed') when 'appointment' then case tr when 'appointment_upcoming' then co->>'status'='confirmed' else co->>'status' in ('completed','no_show') end else false end) then
 raise exception 'unsupported source status' using errcode='22023'; end if;
 if co ? 'chapterId' and not exists(select 1 from public.chapters ch where ch.id=co->>'chapterId' and ch.organization_id=p_org and private.actor_has_chapter_staff_role(auth.uid(),ch.id)) then
 raise exception 'chapter unavailable' using errcode='42501'; end if;
 if co ? 'sourceId' and not private.automation_v2_source_visible(auth.uid(),p_org,case when sk in ('casework_deadline','checklist') then 'case' else sk end,co->>'sourceId') then
 raise exception 'source unavailable' using errcode='42501'; end if;
 if ac in ('assign_task','raise_task_priority') and sk<>'task' then raise exception 'action requires task source' using errcode='22023'; end if;
 if ac='create_standard_task' and cfg<>'{}'::jsonb
 or ac='assign_task' and (not cfg ? 'assigneeId' or cfg-'assigneeId'<>'{}'::jsonb)
 or ac='raise_task_priority' and (not cfg ? 'priority' or cfg-'priority'<>'{}'::jsonb or cfg->>'priority' not in ('medium','high'))
 or ac='notify_in_app' and (not cfg ? 'recipientId' or cfg-'recipientId'<>'{}'::jsonb) then
 raise exception 'invalid action configuration' using errcode='22023'; end if;
 if ac in ('assign_task','notify_in_app') then
 k:=case ac when 'assign_task' then 'assigneeId' else 'recipientId' end;
 if jsonb_typeof(cfg->k)<>'string' or cfg->>k !~ '^[0-9a-fA-F-]{36}$' then raise exception 'invalid recipient' using errcode='22023'; end if;
 if not exists(select 1 from public.member_profiles p join public.chapters ch on ch.id=p.chapter_id
 join public.organization_memberships m on m.user_id=p.id and m.organization_id=ch.organization_id and m.status='active'
 where p.id::text=cfg->>k and ch.organization_id=p_org and private.actor_has_chapter_staff_role(p.id,ch.id)
 and (not co ? 'chapterId' or ch.id=co->>'chapterId')) then raise exception 'recipient unavailable' using errcode='42501'; end if;
 end if;
end;
$$;

create or replace function private.automation_v2_execute(p_run_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare r public.organization_automation_runs%rowtype; d public.organization_automation_definitions%rowtype;
 s public.organization_automation_settings%rowtype; c record; e uuid; tid uuid; nid uuid; recipient uuid;
 t public.chapter_tasks%rowtype; n integer:=0; failed integer:=0; skipped integer:=0; total integer; raw_total integer; final text; title text;
begin
 select * into strict r from public.organization_automation_runs where id=p_run_id for update;
 if r.status<>'in_progress' then raise exception 'run not executable' using errcode='22023'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:'||r.organization_id::text,0));
 select * into d from public.organization_automation_definitions where id=r.definition_id and organization_id=r.organization_id and version=r.definition_version and status='active' for update;
 if d.id is null then raise exception 'definition changed' using errcode='40001'; end if;
 update public.organization_automation_runs set definition_snapshot=coalesce(definition_snapshot,private.automation_v2_definition_json(d)) where id=r.id;
 select * into s from public.organization_automation_settings where organization_id=r.organization_id and enabled for update;
 if s.organization_id is null then raise exception 'automation paused' using errcode='22023'; end if;
 -- Default recipes run only while their switch is on and after approval.
 -- Deleted approvers fail closed until another approver reactivates them.
 if d.recipe_key is not null and not private.organization_feature_enabled(r.organization_id,'features.automation.default_recipes') then
   raise exception 'default recipes are switched off' using errcode='22023'; end if;
 if not private.automation_v2_operator(coalesce(r.initiated_by,d.updated_by),r.organization_id) then
   raise exception 'operator unavailable' using errcode='42501'; end if;
 select count(*) into total from private.automation_v2_candidates(d.id);
 select count(*) into raw_total from private.automation_v2_candidates(d.id,false);
 title:=case d.trigger_kind when 'overdue_task' then 'Review overdue work' when 'case_deadline' then 'Prepare for a case deadline' when 'unassigned_case' then 'Assign case ownership' else 'Review connected work' end;
 for c in select * from private.automation_v2_candidates(d.id) limit s.max_effects_per_run loop
 begin
   -- Lock the source row before re-evaluating it. Scheduler and manual runs
   -- share the tenant lease; human source edits serialize on this row lock.
   case c.source_kind
   when 'task' then perform 1 from public.chapter_tasks where id::text=c.source_id for update;
   when 'case' then perform 1 from public.member_cases where id::text=c.source_id for update;
   when 'casework_deadline' then
     perform 1 from public.member_cases x join public.casework_deadlines y on y.case_id=x.id where y.id::text=c.source_id for update of x;
     perform 1 from public.casework_deadlines where id::text=c.source_id for update;
   when 'checklist' then
     perform 1 from public.member_cases x join public.casework_checklists y on y.case_id=x.id where y.id::text=c.source_id for update of x;
     perform 1 from public.casework_checklists where id::text=c.source_id for update;
     perform 1 from public.casework_checklist_items where checklist_id::text=c.source_id order by id for update;
   when 'appointment' then perform 1 from public.member_appointments where id::text=c.source_id for update;
   when 'event' then perform 1 from public.member_events where id=c.source_id for update;
   end case;
   if not exists(select 1 from private.automation_v2_candidates(d.id) x where x.source_kind=c.source_kind and x.source_id=c.source_id) then skipped:=skipped+1; continue; end if;
   e:=extensions.gen_random_uuid(); tid:=extensions.gen_random_uuid(); nid:=null;
   recipient:=coalesce(d.action_config->>'assigneeId',d.action_config->>'recipientId')::uuid;
   if recipient is not null and not exists(select 1 from public.member_profiles p
      join public.organization_memberships m on m.user_id=p.id and m.organization_id=d.organization_id and m.status='active'
      where p.id=recipient and p.chapter_id=c.chapter_id and private.actor_has_chapter_staff_role(recipient,c.chapter_id)) then
      raise exception 'recipient unavailable' using errcode='42501'; end if;
   if d.action_kind in ('assign_task','raise_task_priority') then
     select * into strict t from public.chapter_tasks where id::text=c.source_id for update;
     if d.action_kind='assign_task' and (t.assignee_id is not null or exists(select 1 from public.chapter_task_assignments a where a.task_id=t.id)) then skipped:=skipped+1; continue; end if;
     if d.action_kind='raise_task_priority' and array_position(array['low','medium','high'],t.priority)>=array_position(array['low','medium','high'],d.action_config->>'priority') then skipped:=skipped+1; continue; end if;
   end if;
   insert into public.organization_automation_effects(id,organization_id,run_id,definition_id,source_kind,source_id,chapter_id,planned_task_id,task_title,task_priority,action_kind,before_value,after_value)
   values(e,r.organization_id,r.id,d.id,c.source_kind,c.source_id,c.chapter_id,tid,title,d.task_priority,d.action_kind,
     case when d.action_kind in ('assign_task','raise_task_priority') then jsonb_build_object('assigneeId',t.assignee_id,'priority',t.priority) end,
     case d.action_kind when 'assign_task' then jsonb_build_object('assigneeId',recipient) when 'raise_task_priority' then jsonb_build_object('priority',d.action_config->>'priority') end)
   on conflict (organization_id,definition_id,source_kind,source_id) where status in ('pending','created') do nothing;
   if not found then skipped:=skipped+1; continue; end if;
   update public.organization_automation_effects set mutation_xid=pg_current_xact_id() where id=e;
   perform set_config('app.automation_task_receipt',e::text,true);
   case d.action_kind
   when 'create_standard_task' then
     -- (20261003030000) The engine's card always uses the 'General'
     -- workstream, which only chapters that existed at 20260728221223 were
     -- given. Ensure it exists so the effect does not fail in a newer chapter.
     insert into public.chapter_workstreams(chapter_id,name,created_by) values(c.chapter_id,'General',null)
     on conflict (chapter_id,name) do nothing;
     insert into public.chapter_tasks(id,chapter_id,title,description,status,priority,workstream,assignee_id,assignee_name,start_date,due_date,progress,blocked,milestone,order_index,task_type)
     values(tid,c.chapter_id,title,'','to_do',d.task_priority,'General',null,'',null,null,0,false,false,0,'general');
   when 'assign_task' then
     tid:=t.id;
     -- The preparation trigger validates this pending receipt before permitting
     -- a scheduled write without ambient user JWT claims.
     update public.organization_automation_effects set task_id=tid where id=e;
     update public.chapter_tasks set assignee_id=recipient where id=tid;
   when 'raise_task_priority' then
     tid:=t.id;
     update public.organization_automation_effects set task_id=tid where id=e;
     update public.chapter_tasks set priority=d.action_config->>'priority' where id=tid;
   when 'notify_in_app' then
     tid:=null;
     -- 'general' is deliberately outside enqueue_notification_deliveries' closed
     -- external delivery vocabulary. Never call the email/SMS/push dispatcher.
     insert into public.member_notifications(user_id,title,body,kind)
     values(recipient,'Automation needs your attention','Review the connected work in Automations.','general') returning id into nid;
   end case;
   perform set_config('app.automation_task_receipt','',true);
   update public.organization_automation_effects set task_id=tid,notification_id=nid,status='created',
     after_value=case when d.action_kind in ('assign_task','raise_task_priority') then after_value||jsonb_build_object(
       'updatedAt',(select updated_at from public.chapter_tasks where id=tid),
       'taskDigest',(select encode(extensions.digest(convert_to(to_jsonb(x)::text,'UTF8'),'sha256'),'hex') from public.chapter_tasks x where x.id=tid),
       'activityCount',(select count(*) from public.chapter_task_activity where task_id=tid)) else after_value end
   where id=e;
   n:=n+1;
   -- Restored alert routing (20261003030000). Best effort: a routing failure
   -- never undoes the follow-up task.
   if d.action_kind='create_standard_task' then
     begin
       perform private.automation_route_effect(e);
     exception when others then
       raise warning 'automation alert routing failed: % (%)', sqlerrm, sqlstate;
     end;
   end if;
 exception when others then
   -- The effect subtransaction rolls back completely. Later previews retry only
   -- these eligible sources; durable successful receipts remain deduplicated.
   failed:=failed+1;
   insert into public.organization_automation_effects(organization_id,run_id,definition_id,source_kind,source_id,chapter_id,planned_task_id,task_title,task_priority,action_kind,status,reason_code)
   values(r.organization_id,r.id,d.id,c.source_kind,c.source_id,c.chapter_id,extensions.gen_random_uuid(),title,d.task_priority,d.action_kind,'failed',case when sqlstate='42501' then 'permission_lost' else 'action_failed' end);
 end;
 end loop;
 final:=case when total=0 or (n=0 and failed=0) then 'no_op' when n=0 and failed>0 then 'failed' when failed>0 or total>s.max_effects_per_run then 'partial' else 'succeeded' end;
 update public.organization_automation_runs set status=final,candidates_count=total,effects_created=n,deduplicated_count=raw_total-total,cap_limited_count=greatest(total-s.max_effects_per_run,0),
 effects_failed=failed,effects_skipped=skipped+greatest(total-s.max_effects_per_run,0),failure_code=case when failed>0 then 'effect_write_failed' end,
 completed_at=now(),rollback_until=case when n>0 then now()+interval '7 days' end where id=r.id;
 update public.organization_automation_definitions set last_run_at=now(),next_run_at=case when r.mode='scheduled' then private.cr108_next_run(cadence,now()) else next_run_at end where id=d.id;
 perform private.cr108_record_audit(r.organization_id,'automation_run_completed','create','automation_run',r.id::text,r.initiated_by,jsonb_build_object('runId',r.id,'status',final,'count',n,'cadence',d.cadence,'reasonCode',case when failed>0 then 'effect_write_failed' end),extensions.gen_random_uuid());
 return jsonb_build_object('id',r.id,'status',final,'candidatesCount',total,'effectsCreated',n,'effectsFailed',failed,'effectsSkipped',skipped+greatest(total-s.max_effects_per_run,0),'deduplicatedCount',raw_total-total,'capLimitedCount',greatest(total-s.max_effects_per_run,0),'rollbackUntil',case when n>0 then now()+interval '7 days' end);
end;
end;
$$;

create or replace function private.run_due_organization_automations(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  candidate_row record;
  definition_row public.organization_automation_definitions%rowtype;
  run_id uuid;
  processed integer;
  succeeded integer;
  failed integer;
begin
  processed := 0;
  succeeded := 0;
  failed := 0;
  if p_limit not between 1 and 50 then raise exception 'scheduled automation limit out of range' using errcode = '22023'; end if;
  for candidate_row in
    select d.id, d.organization_id
    from public.organization_automation_definitions d
    join public.organization_automation_settings s on s.organization_id = d.organization_id and s.enabled
    join public.organizations o on o.id = d.organization_id and o.status = 'active'
    where d.status = 'active'
      and d.review_status = 'approved'
      and d.review_version = d.version
      and d.next_run_at is not null and d.next_run_at <= pg_catalog.now()
      and (d.recipe_key is null or private.organization_feature_enabled(d.organization_id, 'features.automation.default_recipes'))
    order by d.next_run_at, d.organization_id, d.id
    limit p_limit
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || candidate_row.organization_id::text, 0));
    definition_row := null;
    select d.* into definition_row
    from public.organization_automation_definitions d
    join public.organization_automation_settings s on s.organization_id = d.organization_id and s.enabled
    join public.organizations o on o.id = d.organization_id and o.status = 'active'
    where d.id = candidate_row.id
      and d.organization_id = candidate_row.organization_id
      and d.status = 'active'
      and d.review_status = 'approved'
      and d.review_version = d.version
      and d.next_run_at is not null and d.next_run_at <= pg_catalog.now()
    for update of d skip locked;
    if definition_row.id is null then continue; end if;
    processed := processed + 1;
    run_id := extensions.gen_random_uuid();
    insert into public.organization_automation_runs (
      id, organization_id, definition_id, definition_version, mode, status, initiated_by
    ) values (run_id, definition_row.organization_id, definition_row.id, definition_row.version, 'scheduled', 'in_progress', null);
    begin
      perform private.cr108_execute_run(run_id);
      succeeded := succeeded + 1;
    exception when others then
      failed := failed + 1;
      -- A scheduled run has no initiator, so private.automation_v2_execute
      -- takes its authority from the definition's updated_by (the approver who
      -- last activated or edited it) and raises 'operator unavailable' once
      -- that person is no longer an active Admin/President with the required
      -- second factor. Name that cause instead of folding it into
      -- internal_error.
      update public.organization_automation_runs
         set status = 'failed',
             failure_code = case
               when sqlstate = '42501' and sqlerrm = 'operator unavailable' then 'operator_unavailable'
               else 'internal_error'
             end,
             completed_at = pg_catalog.now()
       where id = run_id;
      update public.organization_automation_definitions
         set last_run_at = pg_catalog.now(), next_run_at = private.cr108_next_run(cadence, pg_catalog.now()), updated_at = pg_catalog.now()
       where id = definition_row.id;
    end;
  end loop;
  return pg_catalog.jsonb_build_object('processed', processed, 'succeeded', succeeded, 'failed', failed);
end;
end;
$function$;

create or replace function private.automation_v3_definition_json(
  d public.organization_automation_definitions,
  p_actor uuid,
  p_org uuid,
  p_approver boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb := private.automation_v2_definition_json(d);
  approver boolean := coalesce(p_approver, false);
  source_kind text := case
    when d.trigger_kind in ('case_deadline', 'unassigned_case', 'stale_member_contact') then 'case'
    when d.trigger_kind = 'casework_deadline' then 'case'
    when d.trigger_kind = 'incomplete_case_checklist' then 'case'
    when d.trigger_kind like 'appointment_%' then 'appointment'
    when d.trigger_kind like 'event_%' then 'event'
    else 'task'
  end;
begin
  if d.conditions ? 'sourceId'
     and not private.automation_v3_source_visible(p_actor, p_org, source_kind, d.conditions->>'sourceId') then
    result := pg_catalog.jsonb_set(result, '{conditions}', (result->'conditions') - 'sourceId')
      || pg_catalog.jsonb_build_object('sourceFilterAvailable', false);
  end if;

  -- Every capability flag is an exact boolean. submitted_by and created_by are
  -- nullable (never submitted, or the author account was deleted), and a SQL
  -- NULL here would make the strict client normalizer reject the whole workspace.
  return result || pg_catalog.jsonb_build_object(
    'reviewStatus', d.review_status,
    'reviewVersion', d.review_version,
    'submittedBySelf', coalesce(d.submitted_by = p_actor, false),
    'submittedAt', d.submitted_at,
    'reviewedAt', d.reviewed_at,
    'reviewNote', d.review_note,
    -- An approver may revise a default recipe in any review state; saving
    -- returns it to draft until it is approved again.
    'canEdit', coalesce(d.status <> 'archived' and (approver or d.created_by = p_actor)
      and (d.review_status in ('draft', 'changes_requested') or (approver and d.recipe_key is not null)), false),
    'canSubmit', coalesce(d.status <> 'archived' and (approver or d.created_by = p_actor)
      and d.review_status in ('draft', 'changes_requested'), false),
    'canReview', coalesce(approver and d.review_status = 'submitted', false),
    'canActivate', coalesce(approver
      and d.review_status = 'approved' and d.review_version = d.version, false),
    'canPreview', coalesce(private.automation_v3_definition_visible(d, p_actor, p_org, approver), false),
    'recipeKey', d.recipe_key,
    'scheduledAuthority', case when d.provenance = 'system' then 'pending_approval' else 'approver' end
  ) || case
    -- Approvers only: whether the scheduled authority (updated_by) is still an
    -- active Admin/President operator. false means every scheduled tick fails
    -- with 'operator_unavailable' until an approver activates it again.
    when approver then pg_catalog.jsonb_build_object(
      'dependencyReady', coalesce(private.automation_v2_operator(d.updated_by, p_org), false)
    )
    else '{}'::jsonb
  end;
end;
$function$;

create or replace function public.mi1_get_automation_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.automation_v3_require_author();
  definitions jsonb;
  runs jsonb;
  approver boolean := private.automation_v3_actor_is_approver(actor, org);
begin
  select coalesce(pg_catalog.jsonb_agg(private.automation_v3_definition_json(d, actor, org, approver) order by d.updated_at desc, d.id), '[]'::jsonb)
    into definitions
  from (
    select * from public.organization_automation_definitions d
    where d.organization_id = org
      and private.automation_v3_definition_visible(d, actor, org, approver)
    order by d.updated_at desc, d.id
    limit 100
  ) d;

  select coalesce(pg_catalog.jsonb_agg(
      private.automation_v2_run_json(r) || pg_catalog.jsonb_build_object('definitionName', d.name)
      order by r.created_at desc, r.id desc
    ), '[]'::jsonb)
    into runs
  from (
    select * from public.organization_automation_runs r
    where r.organization_id = org and (approver or r.initiated_by = actor)
    order by r.created_at desc, r.id desc
    limit 50
  ) r
  join public.organization_automation_definitions d on d.id = r.definition_id;

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'access', pg_catalog.jsonb_build_object('canAuthor', true, 'canApprove', approver, 'canOperate', approver),
    'settings', pg_catalog.jsonb_build_object(
      'enabled', coalesce((select s.enabled from public.organization_automation_settings s where s.organization_id = org), false),
      'maxEffectsPerRun', coalesce((select s.max_effects_per_run from public.organization_automation_settings s where s.organization_id = org), 20)
    ),
    'schedulerConfigured', exists(select 1 from cron.job j where j.jobname = 'organization-automation-tick' and j.active),
    'appointmentSupervision', private.automation_v3_appointment_supervisor(actor, org, null),
    'defaultRecipes', pg_catalog.jsonb_build_object(
      'enabled', private.organization_feature_enabled(org, 'features.automation.default_recipes'),
      'alertRoutingEnabled', private.organization_feature_enabled(org, 'features.automation.alert_routing')
    ),
    'capabilities', pg_catalog.jsonb_build_object(
      'schemaVersion', 2,
      'triggers', pg_catalog.to_jsonb(array['overdue_task','case_deadline','unassigned_case','task_due','blocked_task','unassigned_task','stale_task','review_task','casework_deadline','incomplete_case_checklist','appointment_upcoming','appointment_followup','event_upcoming','event_followup','stale_member_contact']),
      'actions', pg_catalog.to_jsonb(array['create_standard_task','assign_task','raise_task_priority','notify_in_app']),
      'cadences', pg_catalog.to_jsonb(array['hourly','daily','weekly']),
      'maxThresholdDays', 90
    ),
    'definitions', definitions,
    'runs', runs
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------

revoke all on function private.automation_recipe_source_in_scope(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.automation_seed_default_recipes(uuid) from public, anon, authenticated, service_role;
revoke all on function private.automation_route_effect(uuid) from public, anon, authenticated, service_role;
revoke all on function private.automation_routing_rule_json(public.organization_automation_routing_rules) from public, anon, authenticated, service_role;
revoke all on function private.automation_v2_candidates(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function private.automation_v2_validate(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.automation_v2_execute(uuid) from public, anon, authenticated, service_role;
revoke all on function private.run_due_organization_automations(integer) from public, anon, authenticated, service_role;
revoke all on function private.automation_v3_definition_json(public.organization_automation_definitions, uuid, uuid, boolean) from public, anon, authenticated, service_role;

revoke all on function public.mi1_get_automation_routing_rules() from public, anon, authenticated, service_role;
revoke all on function public.mi1_save_automation_routing_rule(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.mi1_delete_automation_routing_rule(uuid) from public, anon, authenticated, service_role;
revoke all on function public.mi1_get_automation_workspace() from public, anon, authenticated, service_role;
grant execute on function public.mi1_get_automation_routing_rules() to authenticated;
grant execute on function public.mi1_save_automation_routing_rule(jsonb) to authenticated;
grant execute on function public.mi1_delete_automation_routing_rule(uuid) to authenticated;
grant execute on function public.mi1_get_automation_workspace() to authenticated;

-- Account-lifecycle trigger inventory: the new triggers and the exact helpers
-- added or redefined by this migration can now be reached through a settings
-- change. Review their current definitions without accepting unrelated drift.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'public' and (
    (table_name = 'organization_automation_routing_rules' and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys'))
    or (table_name = 'organization_automation_definitions' and object_name = 'automation_clear_system_provenance_on_human_edit')
    or (table_name = 'organization_automation_settings' and object_name = 'offer_automation_default_drafts_on_enable')
  ))
  or (kind = 'function' and schema_name in ('private', 'public') and pg_catalog.split_part(object_name, '(', 1) = any (array[
    'automation_clear_system_provenance_on_human_edit',
    'automation_recipe_source_in_scope', 'automation_seed_default_recipes',
    'offer_automation_default_drafts_on_enable',
    'automation_route_effect', 'automation_routing_rule_json',
    'mi1_get_automation_routing_rules', 'mi1_save_automation_routing_rule',
    'mi1_delete_automation_routing_rule', 'automation_v2_candidates',
    'automation_v2_validate', 'automation_v2_execute',
    'run_due_organization_automations', 'automation_v3_definition_json',
    'mi1_get_automation_workspace', 'automation_v3_require_approver',
    'automation_v3_require_author', 'automation_v3_actor_is_approver',
    'automation_v3_actor_is_author', 'cr108_record_audit'
  ]))
on conflict (kind, schema_name, table_name, object_name) do update
  set definition_hash = excluded.definition_hash;

do $assert_automation_recipe_defaults_lifecycle$
declare
  unreviewed text;
begin
  select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || ':' || i.trigger_name, ', ' order by i.schema_name, i.table_name, i.trigger_name)
    into unreviewed
  from private.account_lifecycle_referential_action_trigger_issues() i;
  if unreviewed is not null then
    raise exception 'account lifecycle trigger review is incomplete after automation recipe defaults: %', unreviewed;
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after automation recipe defaults';
  end if;
end;
$assert_automation_recipe_defaults_lifecycle$;

-- ---------------------------------------------------------------------------
-- 7. Drafts are offered after an administrator enables automation.
--    Migration and scheduled ticks do not seed.
-- ---------------------------------------------------------------------------

notify pgrst, 'reload schema';

commit;
