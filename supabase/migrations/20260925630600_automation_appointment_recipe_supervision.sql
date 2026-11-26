-- UX-UG-PRESIDENT-VP-AUTOMATION-APPROVER-OFFERED-APPOINTMENT-RECIPE-20260921
--
-- A President (vp) is an automation approver, so the Recipes page offered
-- every appointment recipe and the definition page let them activate one. But
-- private.automation_v3_source_visible (20260911070000:231) admits appointment
-- sources only to a coordinator, advisor or admin whose member_profiles
-- chapter is the appointment's chapter. That matches list_chapter_appointments,
-- which refuses vp with 'appointment supervision unavailable'. A scheduled run
-- executes with updated_by (the activating approver) as its authority, so a
-- vp-activated appointment automation matched nothing on every tick. The same
-- held for an admin, coordinator or advisor activating a definition scoped to
-- a chapter other than their home chapter.
--
-- The read exclusion is deliberate and stays as it is: a President does not
-- read another member's appointment context. What changes is that the
-- product no longer offers a path that activates a permanent no-op:
--
--   1. private.automation_v3_appointment_supervisor(actor, org, chapter) is
--      the supervisor arm of automation_v3_source_visible as one predicate.
--      The caller's home chapter must be in the organization (and equal the
--      definition's chapter when the definition names one). The caller must
--      hold coordinator, advisor or admin there through an organization grant
--      or a chapter role, and pass the same chapter staff-role check.
--   2. set_organization_automation_definition_status refuses to activate an
--      appointment_upcoming or appointment_followup definition for an approver
--      who fails that predicate: 42501 'appointment supervision required'.
--      Pausing and archiving are unchanged.
--   3. mi1_get_automation_workspace advertises appointmentSupervision, so the
--      Recipes page disables the appointment recipes for that session with
--      the reason stated, rather than offering a startable draft.
--
-- Both public functions are re-declared from their installed bodies. The
-- digest guard below refuses any other predecessor. The case-graph lock stays
-- first in the status writer, and nothing else in either body changes.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.set_organization_automation_definition_status(uuid, text, integer)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '0489bfc69ad751d2515da41014e6dfb514cf29d689be94238c6e8bfab12adf4f' then
    raise exception 'unreviewed set_organization_automation_definition_status predecessor: %', digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.mi1_get_automation_workspace()'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '39910ef64553434b60365c6d994624f0c93823a3464272bf47c359ccad839158' then
    raise exception 'unreviewed mi1_get_automation_workspace predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

create function private.automation_v3_appointment_supervisor(
  p_actor uuid,
  p_org uuid,
  p_chapter text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_actor is not null and exists (
    select 1
    from public.member_profiles p
    join public.chapters c on c.id = p.chapter_id and c.organization_id = p_org
    where p.id = p_actor
      and (p_chapter is null or p.chapter_id = p_chapter)
      and (
        exists (
          select 1 from public.organization_role_grants g
          where g.organization_id = p_org and g.user_id = p_actor and g.role in ('coordinator', 'advisor', 'admin')
        )
        or exists (
          select 1 from public.member_role_chapters g
          where g.user_id = p_actor and g.chapter_id = c.id and g.role in ('coordinator', 'advisor', 'admin')
        )
      )
      and private.actor_has_chapter_staff_role(p_actor, c.id)
  );
$function$;

revoke all on function private.automation_v3_appointment_supervisor(uuid, uuid, text)
  from public, anon, authenticated, service_role;

comment on function private.automation_v3_appointment_supervisor(uuid, uuid, text) is
  'Whether the actor can supervise appointments in the given chapter (or their home chapter when null): the supervisor arm of automation_v3_source_visible for appointments, matching list_chapter_appointments. Gates activation of appointment automations and the workspace appointmentSupervision flag.';

create or replace function public.set_organization_automation_definition_status(
  p_definition_id uuid,
  p_status text,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  saved public.organization_automation_definitions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_approver();
  if p_status not in ('active', 'paused', 'archived') or p_expected_version is null then
    raise exception 'invalid automation status transition' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  update public.organization_automation_definitions d
     set status = p_status,
         next_run_at = case when p_status = 'active' then pg_catalog.now() else null end,
         updated_by = actor,
         updated_at = pg_catalog.now()
   where d.id = p_definition_id
     and d.organization_id = org
     and d.version = p_expected_version
     and d.status <> 'archived'
     and (p_status <> 'active' or (d.review_status = 'approved' and d.review_version = d.version))
   returning d.* into saved;
  if saved.id is null then raise exception 'definition changed, unapproved, or unavailable' using errcode = '40001'; end if;
  -- Scheduled runs execute with updated_by (the activating approver) as their
  -- authority, and appointment sources are visible only to a coordinator,
  -- advisor or admin whose home chapter holds the appointment. An approver who
  -- cannot supervise those appointments would activate a permanent no-op, so
  -- activation is refused with a named reason instead.
  if saved.status = 'active'
     and saved.trigger_kind in ('appointment_upcoming', 'appointment_followup')
     and not private.automation_v3_appointment_supervisor(actor, org, saved.conditions ->> 'chapterId') then
    raise exception 'appointment supervision required' using errcode = '42501';
  end if;
  perform private.cr108_record_audit(org, 'automation_definition_status_changed', 'update', 'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('status', saved.status, 'reviewStatus', saved.review_status, 'version', saved.version), extensions.gen_random_uuid());
  return pg_catalog.jsonb_build_object('id', saved.id, 'status', saved.status, 'version', saved.version, 'nextRunAt', saved.next_run_at);
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
    'capabilities', pg_catalog.jsonb_build_object(
      'schemaVersion', 2,
      'triggers', pg_catalog.to_jsonb(array['overdue_task','case_deadline','unassigned_case','task_due','blocked_task','unassigned_task','stale_task','review_task','casework_deadline','incomplete_case_checklist','appointment_upcoming','appointment_followup','event_upcoming','event_followup']),
      'actions', pg_catalog.to_jsonb(array['create_standard_task','assign_task','raise_task_priority','notify_in_app']),
      'cadences', pg_catalog.to_jsonb(array['hourly','daily','weekly']),
      'maxThresholdDays', 90
    ),
    'definitions', definitions,
    'runs', runs
  );
end;
$function$;

notify pgrst, 'reload schema';

commit;
