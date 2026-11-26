begin;

-- REQ-UG-CASEWORK-CONSOLE-51-PROCEDURE-EVERY-PLANE-20260917 — Phase 5,
-- Organization-configurable grievance procedure on every
-- plane, and retirement of the dormant W2 case-flow layer.
--
-- BINDING DISPOSITION (recorded 2026-09-17). The W2 case-flow layer that
-- 20260826151000 installed beside the authoritative casework suite is RETIRED,
-- not deferred. tests/casework-retired-w2-layer.test.js fails if any future
-- migration, client, script or document reintroduces a retired capability.
--
--   case_deadline_changes / case_deadline_audit (W2 deadline change requests)   RETIRED
--   case_checklist_progress (W2 per-case checklist patching)                    RETIRED
--   case_step_transitions (W2 step history; hard-coded step vocabulary)         RETIRED
--   case_generated_work (W2 generated follow-up work)                           RETIRED
--   case_restrictions / case_restriction_access (W2 parallel restriction model) RETIRED
--   case_alerts / case_alert_acknowledgements (W2 alert escalation)             RETIRED
--   case_reminders (W2 reminders)                                               RETIRED
--   advance_case_step, request_case_deadline_change, review_case_deadline_change,
--   patch_case_checklist, acknowledge_case_alert,
--   escalate_unacknowledged_case_alerts, upsert_case_reminder,
--   dispose_case_reminder, get_organization_case_flow_snapshot,
--   set_case_restriction, private.mi1_w2_generate_case_work,
--   private.mi1_w2_normalize_case_step, private.mi1_w2_require_visible_case,
--   private.mi1_w2_append_only                                                  RETIRED
--
-- WHY RETIRE. Every one of these objects duplicated a capability the casework
-- suite (20260828210000) already provides under one authorization model:
-- casework_deadlines + casework_deadline_extensions, casework_checklists,
-- casework_step_transitions, casework_alerts, casework_reminders and the
-- member_cases restriction columns with casework_access_grants. No web, native
-- or SAMPLE surface read the W2 tables, and private.mi1_w2_normalize_case_step
-- hard-coded a five-step grievance vocabulary ('intake', 'filing',
-- 'management_response', 'appeal', 'arbitration') that contradicts the blank
-- system principle: Union Ground ships with no organizations and no procedure;
-- every step, deadline count and holiday is entered by the organization.
-- Two parallel models of the same case record are a liability, not a feature.
--
-- WHAT THIS MIGRATION ADDS INSTEAD. casework_procedures,
-- casework_procedure_steps and organization_holidays (organization-scoped, RLS
-- on, staff read only, RPC-only writes), private.casework_add_business_days,
-- casework_save_procedure / casework_list_procedures /
-- casework_get_case_procedure / casework_set_holidays, and an EXTENSION of
-- casework_advance_step: when a procedure resolves for the case the next step
-- must be the configured successor, the entered step's deadline_rule produces a
-- casework_deadlines row of kind 'procedure', and the (case_type, step)
-- checklist template is instantiated. Cases whose organization has entered no
-- procedure keep today's free-text behaviour exactly. Nothing is seeded.
--
-- WHAT IT WOULD TAKE TO BRING W2 BACK: a new owner decision reversing this
-- disposition plus a complete authorization, account-lifecycle, web/native
-- client and regression contract. Re-creating a table and a grant is not that,
-- and the guard test says so.
--
-- COLLATERAL. private.can_read_restricted_case(uuid, uuid) is kept with its
-- 20260826155000 role boundary unchanged; its retired case_restrictions clause
-- now reads the one authoritative restriction model (member_cases.is_restricted
-- + casework_access_grants). After this migration no policy, function or
-- trigger calls it (its only callers were the retired W2 RPCs); it stays as a
-- revoked private helper pinned by scripts/db-contract.json and exercised by
-- scripts/verify-mi1-w2-feature-persistence.mjs, so a later lane can drop it
-- with its own contract update instead of this retirement widening scope.
-- coordinator_update_case no longer accepts a step change (p_step must be null
-- or unchanged); casework_deadlines gains kind 'procedure'; the two
-- account-lifecycle manifest rows for case_deadline_changes.requested_by and
-- case_step_transitions.actor_user_id, the transitive FK reviews and the
-- trigger reviews of the retired tables are withdrawn here, and a manifest row
-- is added for casework_procedures.created_by.
--
-- ROLLBACK (needs a new owner decision reversing the disposition, not just
-- these statements): restore the ten tables, nine public RPCs and the private
-- helpers from 20260826151000 / 20260826155000 / 20260826156000 /
-- 20260907150000, re-add the manifest rows, then drop the procedure objects.

set local lock_timeout = '5s';

create table public.casework_procedures (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  case_type text check (case_type is null or char_length(btrim(case_type)) between 1 and 100),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  version integer not null default 1 check (version > 0),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index casework_procedures_active_scope on public.casework_procedures
  (organization_id, chapter_id, case_type) nulls not distinct where active;
create table public.casework_procedure_steps (
  id uuid primary key default extensions.gen_random_uuid(),
  procedure_id uuid not null,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  position integer not null check (position >= 0),
  key text not null check (char_length(btrim(key)) between 1 and 100 and key = btrim(key)),
  label text not null check (char_length(btrim(label)) between 1 and 200),
  deadline_rule jsonb not null,
  requires_checklist boolean not null default false,
  terminal boolean not null default false,
  -- "Or a terminal step when the current step allows it": a step that sets
  -- this flag may also exit directly to any later terminal step (settlement,
  -- withdrawal) instead of only its immediate successor.
  allow_terminal_exit boolean not null default false,
  foreign key (procedure_id, organization_id) references public.casework_procedures(id, organization_id) on delete cascade,
  unique (procedure_id, position), unique (procedure_id, key),
  constraint casework_procedure_deadline_rule check (
    jsonb_typeof(deadline_rule) = 'object'
    and deadline_rule ?& array['kind','count','from']
    and deadline_rule - array['kind','count','from'] = '{}'::jsonb
    and deadline_rule->>'kind' in ('business_days','calendar_days','none')
    and deadline_rule->>'from' in ('step_entry','filing','incident')
    and jsonb_typeof(deadline_rule->'count') = 'number'
    and (deadline_rule->>'count') ~ '^[0-9]+$'
    and (deadline_rule->>'count')::numeric <= 2147483647
    and (deadline_rule->>'kind' <> 'none' or (deadline_rule->>'count')::numeric = 0)
  )
);
create table public.organization_holidays (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  holiday_date date not null,
  label text not null check (char_length(btrim(label)) between 1 and 200),
  unique (organization_id, holiday_date)
);

alter table public.casework_procedures enable row level security;
alter table public.casework_procedure_steps enable row level security;
alter table public.organization_holidays enable row level security;
create policy mfa_assurance on public.casework_procedures as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.casework_procedure_steps as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_holidays as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
revoke all on public.casework_procedures, public.casework_procedure_steps, public.organization_holidays from public, anon, authenticated;
grant select on public.casework_procedures, public.casework_procedure_steps, public.organization_holidays to authenticated;
create policy procedure_staff_read on public.casework_procedures for select to authenticated
  using (organization_id = private.current_member_organization() and private.mfa_satisfied()
    and private.has_organization_role(organization_id, array['steward','coordinator','advisor','admin','vp']));
create policy procedure_steps_staff_read on public.casework_procedure_steps for select to authenticated
  using (exists (select 1 from public.casework_procedures p where p.id = procedure_id and p.organization_id = casework_procedure_steps.organization_id));
create policy holidays_staff_read on public.organization_holidays for select to authenticated
  using (organization_id = private.current_member_organization() and private.mfa_satisfied()
    and private.has_organization_role(organization_id, array['steward','coordinator','advisor','admin','vp']));
comment on policy mfa_assurance on public.casework_procedures is
  'Restrictive MFA assurance: every authenticated read of organization procedure configuration requires a satisfied MFA session, matching the casework suite tables.';
comment on policy mfa_assurance on public.casework_procedure_steps is
  'Restrictive MFA assurance: every authenticated read of configured procedure steps requires a satisfied MFA session, matching the casework suite tables.';
comment on policy mfa_assurance on public.organization_holidays is
  'Restrictive MFA assurance: every authenticated read of the organization holiday calendar requires a satisfied MFA session, matching the casework suite tables.';
comment on policy procedure_staff_read on public.casework_procedures is
  'Admits MFA-satisfied staff (steward, coordinator, advisor, admin, VP) of the selected organization to read its procedure configuration; members read a resolved procedure only through casework_get_case_procedure, and all writes go through casework_save_procedure.';
comment on policy procedure_steps_staff_read on public.casework_procedure_steps is
  'Admits a step row exactly when its parent procedure is readable under procedure_staff_read (same organization, MFA-satisfied staff); writes go through casework_save_procedure only.';
comment on policy holidays_staff_read on public.organization_holidays is
  'Admits MFA-satisfied staff (steward, coordinator, advisor, admin, VP) of the selected organization to read its holiday calendar; the calendar is replaced only through casework_set_holidays.';

-- A single organization lock serializes configuration edits with step entry.
-- Calendar dates use UTC consistently, independent of session TimeZone. UTC is
-- storage arithmetic only; clients format instants in the member's locale.
create function private.casework_add_business_days(p_start timestamptz, p_count integer, p_organization_id uuid)
returns timestamptz language plpgsql stable security definer set search_path = '' as $function$
declare v_date timestamp := p_start at time zone 'UTC'; v_left integer := p_count;
  v_start date; v_extra integer;
begin
  if p_start is null or not isfinite(p_start) or p_count is null or p_count < 0 or p_organization_id is null then
    raise exception 'invalid business-day input' using errcode = '22023';
  end if;
  -- Whole weeks are arithmetic. Each subsequent iteration accounts only for
  -- holidays crossed by the previous extension, never loops once per day.
  while v_left > 0 loop
    v_start := v_date::date;
    if extract(isodow from v_date) >= 6 then
      v_date := v_date + ((8 - extract(isodow from v_date)::integer) * interval '1 day');
      v_left := v_left - 1;
    end if;
    v_date := v_date + ((v_left / 5)::bigint * 7 * interval '1 day');
    v_extra := v_left % 5;
    if extract(isodow from v_date)::integer + v_extra > 5 then v_extra := v_extra + 2; end if;
    v_date := v_date + (v_extra * interval '1 day');
    select count(*)::integer into v_left from public.organization_holidays h
      where h.organization_id = p_organization_id and h.holiday_date > v_start
        and h.holiday_date <= v_date::date and extract(isodow from h.holiday_date) < 6;
  end loop;
  return v_date at time zone 'UTC';
end;
$function$;
create function private.casework_resolve_procedure(p_organization_id uuid, p_chapter_id text, p_case_type text)
returns uuid language sql stable security definer set search_path = '' as $function$
  select p.id from public.casework_procedures p where p.organization_id = p_organization_id and p.active
    and (p.chapter_id = p_chapter_id or p.chapter_id is null)
    and (p.case_type = p_case_type or p.case_type is null)
  order by (p.chapter_id is not null) desc, (p.case_type is not null) desc limit 1;
$function$;
create function private.casework_procedure_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select to_jsonb(p) || jsonb_build_object('steps', coalesce((select jsonb_agg(to_jsonb(s) order by s.position)
    from public.casework_procedure_steps s where s.procedure_id = p.id), '[]'::jsonb))
  from public.casework_procedures p where p.id = p_id;
$function$;
-- The one definition of "which step may come next": the immediate successor
-- by position, plus every later terminal step when the current step allows a
-- terminal exit. A case whose step is not in the procedure (legacy free text)
-- enters at the first configured step; a terminal step offers nothing.
create function private.casework_allowed_next_steps(p_procedure_id uuid, p_current_step text)
returns setof public.casework_procedure_steps language sql stable security definer set search_path = '' as $function$
  with current_step as (
    select * from public.casework_procedure_steps where procedure_id = p_procedure_id and key = p_current_step
  )
  select s.* from public.casework_procedure_steps s
  where s.procedure_id = p_procedure_id
    and not coalesce((select c.terminal from current_step c), false)
    and (
      s.position = (select min(n.position) from public.casework_procedure_steps n
        where n.procedure_id = p_procedure_id and n.position > coalesce((select c.position from current_step c), -1))
      or (coalesce((select c.allow_terminal_exit from current_step c), false) and s.terminal
        and s.position > (select c.position from current_step c))
    )
  order by s.position;
$function$;
create function private.casework_procedure_actor(p_write boolean)
returns uuid language plpgsql stable security definer set search_path = '' as $function$
declare v_org uuid := private.current_member_organization();
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if (select auth.uid()) is null or v_org is null or not private.has_organization_role(v_org,
    case when p_write then array['coordinator','admin','vp'] else array['steward','coordinator','advisor','admin','vp'] end)
  then raise exception 'organization not found' using errcode = '42501'; end if;
  return v_org;
end;
$function$;
create function public.casework_list_procedures()
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare v_org uuid := private.casework_procedure_actor(false);
begin
  return jsonb_build_object('procedures', coalesce((select jsonb_agg(private.casework_procedure_json(p.id) order by p.name, p.id)
    from public.casework_procedures p where p.organization_id = v_org), '[]'::jsonb),
    'holidays', coalesce((select jsonb_agg(to_jsonb(h) order by h.holiday_date) from public.organization_holidays h where h.organization_id = v_org), '[]'::jsonb));
end;
$function$;
create function public.casework_get_case_procedure(p_case_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare v_case public.member_cases%rowtype; v_procedure uuid;
begin
  perform private.casework_require_mfa();
  if (select auth.uid()) is null or not private.casework_can_read(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  v_procedure := private.casework_resolve_procedure(v_case.organization_id, v_case.chapter_id, v_case.case_type);
  if v_procedure is null then return null; end if;
  -- The resolved procedure plus the case's position in it, so every plane
  -- renders the same allowed transition(s) the RPC will accept.
  return private.casework_procedure_json(v_procedure) || jsonb_build_object(
    'case_step', v_case.step,
    'allowed_next_steps', coalesce((select jsonb_agg(s.key order by s.position)
      from private.casework_allowed_next_steps(v_procedure, v_case.step) s), '[]'::jsonb));
end;
$function$;

-- Internal transition capability: the top-level xid survives savepoints; only
-- definer RPCs can insert it, and the guard binds it to the current transaction.
alter table public.casework_step_transitions add column procedure_transaction_id xid8;

create function public.casework_save_procedure(p_procedure_id uuid, p_chapter_id text, p_case_type text,
  p_name text, p_steps jsonb, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_org uuid := private.casework_procedure_actor(true); v_id uuid; v_version integer;
  v_case public.member_cases%rowtype; v_target text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('casework-procedure:' || v_org::text, 0));
  if p_chapter_id is not null and not exists (select 1 from public.chapters where id = p_chapter_id and organization_id = v_org)
    then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 200
    or p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) not between 1 and 100
    then raise exception 'invalid procedure' using errcode = '22023'; end if;
  -- Positions come from array order. Mapping is explicit and unambiguous.
  if exists (select 1 from jsonb_array_elements(p_steps) s where jsonb_typeof(s) <> 'object'
    or (s ? 'migrate_from' and jsonb_typeof(s->'migrate_from') <> 'array'))
    then raise exception 'invalid step mapping' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_steps) s, jsonb_array_elements(s->'migrate_from') m
    where jsonb_typeof(m) <> 'string' or char_length(m #>> '{}') not between 1 and 100)
    or exists (select 1 from jsonb_array_elements(p_steps) s, jsonb_array_elements_text(s->'migrate_from') m group by m having count(*) > 1)
    then raise exception 'ambiguous step mapping' using errcode = '22023'; end if;
  if p_procedure_id is not null then
    select id, version into v_id, v_version from public.casework_procedures where id = p_procedure_id and organization_id = v_org for update;
    if not found then raise exception 'procedure not found' using errcode = 'P0002'; end if;
    if p_expected_version is distinct from v_version then raise exception 'procedure changed' using errcode = '40001'; end if;
    -- Scope changes could silently strand cases under a fallback procedure.
    if exists (select 1 from public.casework_procedures where id = v_id and (chapter_id is distinct from p_chapter_id or case_type is distinct from nullif(btrim(p_case_type), '')))
      then raise exception 'create a new procedure for a different scope' using errcode = '22023'; end if;
  else
    if p_expected_version is not null then raise exception 'unexpected procedure version' using errcode = '40001'; end if;
    insert into public.casework_procedures(organization_id, chapter_id, case_type, name, created_by)
    values(v_org, p_chapter_id, nullif(btrim(p_case_type), ''), btrim(p_name), (select auth.uid())) returning id into v_id;
  end if;
  -- Require migration for a removed key only on cases this procedure resolves.
  -- A new configuration also accepts explicit mappings from legacy free text.
  for v_case in select * from public.member_cases c where c.organization_id = v_org and c.status <> 'resolved'
    and private.casework_resolve_procedure(c.organization_id, c.chapter_id, c.case_type) = v_id order by c.id for update
  loop
    if not exists (select 1 from jsonb_array_elements(p_steps) s where s->>'key' = v_case.step) then
      select s->>'key' into v_target from jsonb_array_elements(p_steps) s where s->'migrate_from' ? v_case.step;
      if v_target is null and p_procedure_id is not null then raise exception 'open case step needs migrate_from' using errcode = '22023'; end if;
      if v_target is not null then
        if not private.casework_staff_can_access(v_case.id) then raise exception 'case migration is not authorized' using errcode = '42501'; end if;
        insert into public.casework_step_transitions(case_id, organization_id, chapter_id, from_step, to_step, outcome, transitioned_by, idempotency_key, procedure_transaction_id)
        values(v_case.id, v_org, v_case.chapter_id, v_case.step, v_target, 'procedure_migration', (select auth.uid()), extensions.gen_random_uuid(), pg_current_xact_id());
        update public.member_cases set step = v_target, updated_at = now() where id = v_case.id;
      end if;
    end if;
  end loop;
  delete from public.casework_procedure_steps where procedure_id = v_id;
  insert into public.casework_procedure_steps(procedure_id, organization_id, position, key, label, deadline_rule, requires_checklist, terminal, allow_terminal_exit)
  select v_id, v_org, (ordinality - 1)::integer, s->>'key', btrim(s->>'label'), s->'deadline_rule',
    coalesce((s->>'requires_checklist')::boolean, false), coalesce((s->>'terminal')::boolean, false),
    coalesce((s->>'allow_terminal_exit')::boolean, false)
  from jsonb_array_elements(p_steps) with ordinality as x(s, ordinality);
  update public.casework_procedures set name = btrim(p_name), version = case when p_procedure_id is null then 1 else version + 1 end,
    updated_at = now() where id = v_id;
  return private.casework_procedure_json(v_id);
end;

end;
$function$;
create function public.casework_set_holidays(p_holidays jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_org uuid := private.casework_procedure_actor(true);
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('casework-procedure:' || v_org::text, 0));
  if p_holidays is null or jsonb_typeof(p_holidays) <> 'array' or jsonb_array_length(p_holidays) > 3660
    then raise exception 'invalid holiday calendar' using errcode = '22023'; end if;
  delete from public.organization_holidays where organization_id = v_org;
  insert into public.organization_holidays(organization_id, holiday_date, label)
  select v_org, (h->>'holiday_date')::date, btrim(h->>'label') from jsonb_array_elements(p_holidays) h;
  return coalesce((select jsonb_agg(to_jsonb(h) order by h.holiday_date) from public.organization_holidays h where h.organization_id = v_org), '[]'::jsonb);
end;

end;
$function$;

alter table public.casework_deadlines drop constraint casework_deadlines_kind_check;
alter table public.casework_deadlines add constraint casework_deadlines_kind_check
  check (kind in ('filing','response','hearing','appeal','follow_up','procedure'));
alter table public.casework_deadlines drop constraint casework_deadlines_label_check;
alter table public.casework_deadlines add constraint casework_deadlines_label_check check (char_length(btrim(label)) between 1 and 200);

create or replace function public.casework_advance_step(
  p_case_id uuid,
  p_expected_step text,
  p_next_step text,
  p_outcome text,
  p_idempotency_key uuid
)
returns public.casework_step_transitions
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_case public.member_cases%rowtype; v_transition public.casework_step_transitions%rowtype; v_template public.casework_checklist_templates%rowtype; v_checklist_id uuid; v_procedure uuid; v_current public.casework_procedure_steps%rowtype; v_next public.casework_procedure_steps%rowtype; v_start timestamptz; v_due timestamptz; v_incident text;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_access(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_next_step is null or p_outcome is null or p_idempotency_key is null then raise exception 'invalid transition' using errcode = '22023'; end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('casework-procedure:' || v_case.organization_id::text, 0));
  select * into strict v_case from public.member_cases where id = p_case_id for update;
  select * into v_transition from public.casework_step_transitions where organization_id = v_case.organization_id and transitioned_by = (select auth.uid()) and idempotency_key = p_idempotency_key;
  if found then
    if v_transition.case_id <> p_case_id or v_transition.from_step is distinct from p_expected_step or v_transition.to_step is distinct from btrim(p_next_step) or v_transition.outcome is distinct from btrim(p_outcome) then raise exception 'idempotency key reused' using errcode = '22023'; end if;
    return v_transition;
  end if;
  if v_case.step is distinct from p_expected_step then raise exception 'case step changed' using errcode = '40001'; end if;
  v_procedure := private.casework_resolve_procedure(v_case.organization_id, v_case.chapter_id, v_case.case_type);
  if v_procedure is null and (char_length(btrim(p_next_step)) not between 2 and 100 or p_next_step = p_expected_step) then raise exception 'invalid next step' using errcode = '22023'; end if;
  if v_procedure is not null then
    select * into v_current from public.casework_procedure_steps where procedure_id = v_procedure and key = v_case.step;
    if v_current.terminal then raise exception 'terminal step cannot advance' using errcode = '22023'; end if;
    select * into v_next from private.casework_allowed_next_steps(v_procedure, v_case.step) s where s.key = btrim(p_next_step);
    if v_next.id is null then raise exception 'invalid procedure successor' using errcode = '22023'; end if;
    if v_current.requires_checklist and (not exists (select 1 from public.casework_checklists c where c.case_id = v_case.id and c.step = v_case.step)
      or exists (select 1 from public.casework_checklists c join public.casework_checklist_items i on i.checklist_id = c.id
        where c.case_id = v_case.id and c.step = v_case.step and i.required and i.completed_at is null))
      then raise exception 'required checklist incomplete' using errcode = '22023'; end if;
    if v_next.deadline_rule->>'kind' <> 'none' then
      v_start := now();
      if v_next.deadline_rule->>'from' = 'filing' then v_start := v_case.created_at; end if;
      if v_next.deadline_rule->>'from' = 'incident' then
        select f.answers->>'incident_date' into v_incident from public.member_forms f
          where f.case_id = v_case.id and f.user_id = v_case.user_id order by f.created_at, f.id limit 1;
        if v_incident is null or v_incident !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'incident date required on case filing' using errcode = '22023'; end if;
        v_start := v_incident::date::timestamp at time zone 'UTC';
      end if;
      v_due := case v_next.deadline_rule->>'kind'
        when 'business_days' then private.casework_add_business_days(v_start, (v_next.deadline_rule->>'count')::integer, v_case.organization_id)
        else ((v_start at time zone 'UTC') + ((v_next.deadline_rule->>'count')::integer * interval '1 day')) at time zone 'UTC' end;
    end if;
  end if;
  insert into public.casework_step_transitions(case_id, organization_id, chapter_id, from_step, to_step, outcome, transitioned_by, idempotency_key, procedure_transaction_id)
  values (v_case.id, v_case.organization_id, v_case.chapter_id, v_case.step, pg_catalog.btrim(p_next_step), pg_catalog.btrim(p_outcome), (select auth.uid()), p_idempotency_key, pg_current_xact_id())
  returning * into v_transition;
  if v_due is not null then
    insert into public.casework_deadlines(case_id, organization_id, chapter_id, kind, label, due_at, created_by)
    values(v_case.id, v_case.organization_id, v_case.chapter_id, 'procedure', v_next.label, v_due, (select auth.uid()));
  end if;
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

end;
$function$;

create or replace function public.coordinator_update_case(
  p_case_id uuid, p_status text, p_step text, p_deadline date, p_reason text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare old_case public.member_cases%rowtype; changed public.member_cases%rowtype; clean_reason text := btrim(coalesce(p_reason,''));
begin
  old_case := private.coordinator_case_for_update(p_case_id);
  if p_status not in ('active','resolved') then raise exception 'invalid status' using errcode = '22023'; end if;
  if p_step is not null and p_step is distinct from old_case.step then raise exception 'step changes go through the procedure transition' using errcode = '22023'; end if;
  if char_length(clean_reason) not between 1 and 1000 then raise exception 'reason must be 1-1000 characters' using errcode = '22023'; end if;
  if old_case.deadline is not null and (p_deadline is null or p_deadline < old_case.deadline) then
    raise exception 'deadline may only be extended' using errcode = '22023';
  end if;
  update public.member_cases set status=p_status, deadline=p_deadline where id=old_case.id returning * into changed;
  insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,before_value,after_value,reason)
  values (old_case.id,old_case.user_id,(select auth.uid()),'case_updated',
    jsonb_build_object('status',old_case.status,'step',old_case.step,'deadline',old_case.deadline),
    jsonb_build_object('status',changed.status,'step',changed.step,'deadline',changed.deadline),clean_reason);
  return jsonb_build_object('id',changed.id,'status',changed.status,'step',changed.step,'deadline',changed.deadline);
end;
end;
$$;

-- Configured steps can only move together with a definer-written transition in
-- this transaction. Client roles cannot insert history or its transaction marker.
-- This covers old member/staff bundles and bulk direct writes too.
create function private.casework_guard_procedure_step()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if new.step is distinct from old.step
    and private.casework_resolve_procedure(old.organization_id, old.chapter_id, old.case_type) is not null
    and not exists (select 1 from public.casework_step_transitions t where t.case_id = old.id
      and t.from_step = old.step and t.to_step = new.step and t.transitioned_by = (select auth.uid())
      and t.procedure_transaction_id = pg_catalog.pg_current_xact_id())
  then raise exception 'step changes go through the procedure transition' using errcode = '42501'; end if;
  return new;
end;
$function$;
create trigger member_cases_procedure_step before update of step on public.member_cases
  for each row execute function private.casework_guard_procedure_step();

-- W2 compatibility visibility helper, retained without callers (see COLLATERAL
-- above). Its role boundary is the 20260826155000 body unchanged (admin/VP
-- counsel, assigned steward, organization or case-chapter coordinator); only
-- the retired case_restrictions / case_restriction_access clause is replaced
-- by the one authoritative restriction model, exactly as
-- private.casework_staff_can_access evaluates it.
create or replace function private.can_read_restricted_case(p_organization_id uuid, p_case_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select (select auth.uid()) is not null
    and p_organization_id is not null
    and p_case_id is not null
    and private.is_organization_member(p_organization_id)
    and exists (
      select 1 from public.member_cases mc
      where mc.id = p_case_id and mc.organization_id = p_organization_id
        and (
          private.has_organization_role(p_organization_id, array['admin', 'vp'])
          or (
            mc.steward_user_id = (select auth.uid())
            and (
              private.has_organization_role(p_organization_id, array['steward'])
              or exists (
                select 1 from public.member_role_chapters rc
                where rc.user_id = (select auth.uid()) and rc.chapter_id = mc.chapter_id
                  and rc.role = 'steward'
              )
            )
          )
          or private.has_organization_role(p_organization_id, array['coordinator'])
          or exists (
            select 1 from public.member_role_chapters rc
            where rc.user_id = (select auth.uid()) and rc.chapter_id = mc.chapter_id
              and rc.role = 'coordinator'
          )
        )
        and (
          not mc.is_restricted
          or mc.steward_user_id = (select auth.uid())
          or mc.coordinator_user_id = (select auth.uid())
          or private.has_organization_role(p_organization_id, array['advisor', 'admin', 'vp'])
          or exists (
            select 1 from public.casework_access_grants g
            where g.case_id = mc.id and g.organization_id = mc.organization_id
              and g.grantee_user_id = (select auth.uid()) and g.revoked_at is null
          )
        )
    )
$function$;
drop function public.advance_case_step(uuid, text);
drop function public.request_case_deadline_change(uuid, text, date, text);
drop function public.review_case_deadline_change(uuid, text);
drop function public.patch_case_checklist(uuid, jsonb);
drop function public.acknowledge_case_alert(uuid);
drop function public.escalate_unacknowledged_case_alerts();
drop function public.upsert_case_reminder(jsonb);
drop function public.dispose_case_reminder(uuid, text);
drop function public.get_organization_case_flow_snapshot();
drop function public.set_case_restriction(uuid, boolean, text, uuid[], uuid);
drop function private.mi1_w2_generate_case_work(uuid, public.member_cases, text);

drop table public.case_deadline_audit;
drop table public.case_deadline_changes;
drop table public.case_checklist_progress;
drop table public.case_step_transitions;
drop table public.case_generated_work;
drop table public.case_restriction_access;
drop table public.case_restrictions;
drop table public.case_alert_acknowledgements;
drop table public.case_alerts;
drop table public.case_reminders;

-- Helpers whose only callers were the retired RPCs and the retired audit trigger.
drop function private.mi1_w2_normalize_case_step(text, text);
drop function private.mi1_w2_require_visible_case(uuid, uuid);
drop function private.mi1_w2_append_only();

-- Withdraw stale deletion/export dispositions, transitive FK reviews and
-- trigger reviews only for the retired objects; leave retained history alone.
delete from private.account_lifecycle_manifest where schema_name = 'public'
  and table_name in ('case_deadline_changes','case_deadline_audit','case_checklist_progress','case_step_transitions',
    'case_generated_work','case_restrictions','case_restriction_access','case_alerts','case_alert_acknowledgements','case_reminders');
delete from private.account_lifecycle_transitive_fk_manifest where schema_name = 'public'
  and table_name in ('case_deadline_changes','case_deadline_audit','case_checklist_progress','case_step_transitions',
    'case_generated_work','case_restrictions','case_restriction_access','case_alerts','case_alert_acknowledgements','case_reminders');
delete from private.account_lifecycle_trigger_review where schema_name = 'public'
  and table_name in ('case_deadline_changes','case_deadline_audit','case_checklist_progress','case_step_transitions',
    'case_generated_work','case_restrictions','case_restriction_access','case_alerts','case_alert_acknowledgements','case_reminders');
delete from private.account_lifecycle_trigger_review where kind = 'function' and schema_name = 'private'
  and table_name = '' and object_name = 'mi1_w2_append_only()';
insert into private.account_lifecycle_manifest(schema_name, table_name, user_column, delete_disposition,
  export_disposition, export_inventory_basis, exclusion_reason, note)
values ('public','casework_procedures','created_by','pseudonymize','excluded_with_reason','auth_user_fk',
  'Organization configuration attribution is shared staff content, not member-owned portable content.',
  'Retain organization configuration and clear creator attribution on account deletion.');

revoke all on function private.casework_add_business_days(timestamptz, integer, uuid),
  private.casework_resolve_procedure(uuid, text, text), private.casework_procedure_json(uuid),
  private.casework_allowed_next_steps(uuid, text),
  private.casework_procedure_actor(boolean), private.casework_guard_procedure_step()
  from public, anon, authenticated, service_role;
revoke all on function public.casework_save_procedure(uuid, text, text, text, jsonb, integer),
  public.casework_list_procedures(), public.casework_get_case_procedure(uuid), public.casework_set_holidays(jsonb),
  public.casework_advance_step(uuid, text, text, text, uuid), public.coordinator_update_case(uuid, text, text, date, text)
  from public, anon, authenticated, service_role;
grant execute on function public.casework_save_procedure(uuid, text, text, text, jsonb, integer),
  public.casework_list_procedures(), public.casework_get_case_procedure(uuid), public.casework_set_holidays(jsonb),
  public.casework_advance_step(uuid, text, text, text, uuid), public.coordinator_update_case(uuid, text, text, date, text)
  to authenticated;

create trigger a00_case_graph_lock before insert or update or delete on public.casework_procedures
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.casework_procedures
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger a00_case_graph_lock before insert or update or delete on public.casework_procedure_steps
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.casework_procedure_steps
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger a00_case_graph_lock before insert or update or delete on public.organization_holidays
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organization_holidays
for each row execute function private.lock_case_graph_row_keys('', '');

-- Exact reviewed additions to the referential-action trigger surface: the six
-- graph-lock triggers on the three procedure tables, the procedure step guard
-- on member_cases and the two functions it reaches. Name-bound, never a blanket
-- acceptance; the count is asserted so a stray object cannot ride along.
do $review$
declare affected integer;
begin
  insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
  select kind, schema_name, table_name, object_name, definition_hash
  from private.account_lifecycle_trigger_surface()
  where (kind = 'trigger' and schema_name = 'public' and (
      (table_name in ('casework_procedures', 'casework_procedure_steps', 'organization_holidays')
        and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys'))
      or (table_name = 'member_cases' and object_name = 'member_cases_procedure_step')))
    or (kind = 'function' and schema_name = 'private' and table_name = '' and object_name in (
      'casework_guard_procedure_step()',
      'casework_resolve_procedure(p_organization_id uuid, p_chapter_id text, p_case_type text)'));
  get diagnostics affected = row_count;
  if affected <> 9 then
    raise exception 'procedure trigger review pinned % rows, expected 9', affected;
  end if;
end;
$review$;

commit;
