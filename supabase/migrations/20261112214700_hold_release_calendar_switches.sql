-- REQ-UG-HOLD-RELEASE-CALENDAR-SWITCHES-20261112 (#8579).
--
-- Owner direction, November 12, 2026, about 10:36 PM ET: every feature on the
-- weekly release calendar is off and invisible now, and is released later on
-- its date (docs/contracts/staged-feature-releases.md). The dates are not set
-- yet, so each switch is held with no date (infinity); a later data-only
-- migration sets each release time, one release at a time.
--
-- Held: every calendar feature that has a boolean organization switch, and
-- each add-on that has no use while its parent is held (the two Neuro Map
-- add-ons, the attention surfaces, the weekly digest summary). Neuro Map, the
-- default automation recipes and the single sign-on control are on today and
-- go off with this hold.
--
-- Left out on purpose: features.security.member_pin_restricted_sessions. It is
-- a safety restriction that defaults on, and a held switch reads off, which
-- would lift the restriction from any PIN session that is still live. With
-- features.security.member_pin_signin held no new PIN session starts.
--
-- Stored organization values are kept, untouched. The Apple and Google buttons
-- stay held by 20261112162500. The guard refuses a database where any of these
-- definition rows is missing or is not a boolean, so this hold can never be
-- recorded as applied while it holds less than the list.
--
-- Two held features had surfaces the organization switch did not hide, so
-- this migration also makes them follow the hold (a release time later than
-- now()), and only the hold: an organization that turned a released switch off
-- keeps today's behavior.
--
-- * Default automation recipes. While features.automation.default_recipes is
--   held, the automation workspace leaves out its defaultRecipes block, a
--   definition made from a default recipe (recipe_key set) is not visible to
--   any reader that uses private.automation_v3_definition_visible (workspace,
--   list, detail, preview, opportunities, run filter), and its runs are left
--   out of the workspace and the run list and refused by the run detail, as an
--   unknown run is. The rows stay stored and come back on release.
-- * Single sign-on setup. While features.security.sso is held,
--   public.get_sso_control() answers only {organizationId, released: false}
--   (no connection, domains or setup data), and every setup write
--   (save_sso_connection, add_sso_domain, remove_sso_domain,
--   begin_sso_admin_action, all through private.sso_admin_organization(true))
--   is refused. Released, get_sso_control adds released: true and nothing else
--   changes. The web Integrations page reads that answer to leave the tab out
--   and send a link to it to the first tab.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $hold$
declare
  held integer;
begin
  update public.platform_setting_definitions
  set release_at = 'infinity'
  where key in (
      'features.ai_assistant.field_notes_packet',
      'features.attention.dashboard',
      'features.attention.guided_portal',
      'features.attention.member_surfaces',
      'features.attention.navigation',
      'features.automation.default_recipes',
      'features.civic.watchlist',
      'features.engagement_voice.bargaining_survey_template',
      'features.intelligence.neuro_map',
      'features.intelligence.neuro_map_auto_progress',
      'features.intelligence.neuro_map_derived_graph',
      'features.intelligence.weekly_digest',
      'features.intelligence.weekly_digest_ai',
      'features.member_invitations.enabled',
      'features.security.member_pin_signin',
      'features.security.sso',
      'features.tasks.coop_checkoff_lists'
    )
    and value_kind = 'boolean';
  get diagnostics held = row_count;
  if held <> 17 then
    raise exception 'expected to hold 17 release calendar switches, held %', held using errcode = '55000';
  end if;
end;
$hold$;

-- Default automation recipes follow the hold (copied from
-- 20260924181000:55, 20261003030000:1148 and 20260924230200:45-89 with only the
-- hold added).
create or replace function private.automation_v3_definition_visible(
  d public.organization_automation_definitions,
  p_actor uuid,
  p_org uuid,
  p_approver boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select d.organization_id = p_org
    and (
      coalesce(p_approver, false)
      or d.created_by = p_actor
      or (
        d.review_status in ('submitted', 'changes_requested', 'approved')
        and (
          not (d.conditions ? 'chapterId')
          or private.actor_has_chapter_staff_role(p_actor, d.conditions->>'chapterId')
        )
      )
    )
    and (d.recipe_key is null or not exists (select 1 from public.platform_setting_definitions h where h.key = 'features.automation.default_recipes' and h.release_at > pg_catalog.now()));
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
  recipes_held boolean := exists (select 1 from public.platform_setting_definitions h where h.key = 'features.automation.default_recipes' and h.release_at > pg_catalog.now());
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
      and not (recipes_held and exists (
        select 1 from public.organization_automation_definitions hd
        where hd.id = r.definition_id and hd.recipe_key is not null))
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
      'triggers', pg_catalog.to_jsonb(array['overdue_task','case_deadline','unassigned_case','task_due','blocked_task','unassigned_task','stale_task','review_task','casework_deadline','incomplete_case_checklist','appointment_upcoming','appointment_followup','event_upcoming','event_followup','stale_member_contact']),
      'actions', pg_catalog.to_jsonb(array['create_standard_task','assign_task','raise_task_priority','notify_in_app']),
      'cadences', pg_catalog.to_jsonb(array['hourly','daily','weekly']),
      'maxThresholdDays', 90
    ),
    'definitions', definitions,
    'runs', runs
  ) || case when recipes_held then '{}'::jsonb else pg_catalog.jsonb_build_object(
    'defaultRecipes', pg_catalog.jsonb_build_object(
      'enabled', private.organization_feature_enabled(org, 'features.automation.default_recipes'),
      'alertRoutingEnabled', private.organization_feature_enabled(org, 'features.automation.alert_routing')
    )
  ) end;
end;
$function$;

create or replace function public.mi1_get_automation_runs(p_page integer default 1,p_page_size integer default 20,p_definition_id uuid default null,p_status text default null,p_from timestamptz default null,p_to timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid()); org uuid:=private.automation_v3_require_author(); approver boolean:=private.automation_v3_actor_is_approver(actor,org); result jsonb; total integer;
begin
 perform private.automation_v2_page_guard(p_page,p_page_size);
 if (p_status is not null and p_status not in ('previewed','in_progress','no_op','succeeded','partial','failed','rolled_back','rollback_partial')) or p_from>p_to then raise exception 'invalid run filter' using errcode='22023'; end if;
 if p_definition_id is not null and not exists(select 1 from public.organization_automation_definitions d where d.id=p_definition_id and d.organization_id=org and private.automation_v3_definition_visible(d,actor,org)) then raise exception 'definition unavailable' using errcode='42501'; end if;
 select count(*) into total from public.organization_automation_runs r where r.organization_id=org and (approver or r.initiated_by=actor) and not exists(select 1 from public.organization_automation_definitions hd where hd.id=r.definition_id and hd.recipe_key is not null and exists(select 1 from public.platform_setting_definitions h where h.key='features.automation.default_recipes' and h.release_at>pg_catalog.now())) and (p_definition_id is null or r.definition_id=p_definition_id) and (p_status is null or r.status=p_status) and (p_from is null or r.started_at>=p_from) and (p_to is null or r.started_at<=p_to);
 select coalesce(jsonb_agg(x.item order by x.created_at desc,x.id desc),'[]'::jsonb) into result from (
 select r.id,r.created_at,private.automation_v2_run_json(r)||jsonb_build_object('definitionName',d.name) item
 from public.organization_automation_runs r join public.organization_automation_definitions d on d.id=r.definition_id and d.organization_id=r.organization_id and (d.recipe_key is null or not exists(select 1 from public.platform_setting_definitions h where h.key='features.automation.default_recipes' and h.release_at>pg_catalog.now()))
 where r.organization_id=org and (approver or r.initiated_by=actor) and (p_definition_id is null or r.definition_id=p_definition_id) and (p_status is null or r.status=p_status) and (p_from is null or r.started_at>=p_from) and (p_to is null or r.started_at<=p_to)
 order by r.created_at desc,r.id desc limit p_page_size offset (p_page-1)*p_page_size) x;
 return jsonb_build_object('organizationId',org,'rows',result,'total',total,'page',p_page,'pageSize',p_page_size); end; $$;

create or replace function public.mi1_get_automation_run(p_run_id uuid,p_page integer default 1,p_page_size integer default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid()); org uuid:=private.automation_v3_require_author(); approver boolean:=private.automation_v3_actor_is_approver(actor,org); r public.organization_automation_runs%rowtype; result jsonb; total integer; snapshot jsonb; source_kind text;
begin
 perform private.automation_v2_page_guard(p_page,p_page_size);
 select * into r from public.organization_automation_runs where id=p_run_id and organization_id=org;
 if r.id is null or not (approver or r.initiated_by is not distinct from actor) then raise exception 'run unavailable' using errcode='42501'; end if;
 if exists(select 1 from public.organization_automation_definitions hd where hd.id=r.definition_id and hd.recipe_key is not null) and exists(select 1 from public.platform_setting_definitions h where h.key='features.automation.default_recipes' and h.release_at>pg_catalog.now()) then raise exception 'run unavailable' using errcode='42501'; end if;
 snapshot:=r.definition_snapshot;
 if snapshot is not null and snapshot->'conditions' ? 'sourceId' then
 source_kind:=case when snapshot->>'triggerKind' in ('case_deadline','unassigned_case','casework_deadline','incomplete_case_checklist') then 'case'
 when snapshot->>'triggerKind' like 'appointment_%' then 'appointment' when snapshot->>'triggerKind' like 'event_%' then 'event' else 'task' end;
 if not private.automation_v2_source_visible(auth.uid(),org,source_kind,snapshot->'conditions'->>'sourceId') then
 snapshot:=jsonb_set(snapshot,'{conditions}',(snapshot->'conditions')-'sourceId')||jsonb_build_object('sourceFilterAvailable',false); end if;
 end if;
 select count(*) into total from public.organization_automation_effects where run_id=r.id and organization_id=org;
 select coalesce(jsonb_agg(x.item order by x.created_at,x.id),'[]'::jsonb) into result from (
 select e.id,e.created_at,jsonb_build_object('id',e.id,'sourceKind',e.source_kind,
 'sourceAvailable',private.automation_v2_source_visible(auth.uid(),org,e.source_kind,e.source_id),
 'sourceId',case when private.automation_v2_source_visible(auth.uid(),org,e.source_kind,e.source_id) then e.source_id end,
 'caseId',case when private.automation_v2_source_visible(auth.uid(),org,e.source_kind,e.source_id) then
 case e.source_kind when 'casework_deadline' then (select case_id from public.casework_deadlines where id::text=e.source_id and organization_id=org)
 when 'checklist' then (select case_id from public.casework_checklists where id::text=e.source_id and organization_id=org) end end,
 'actionKind',e.action_kind,'status',e.status,'reasonCode',e.reason_code,
 'effectAvailable',case when e.task_id is not null then private.automation_v2_source_visible(auth.uid(),org,'task',e.task_id::text)
 when e.notification_id is not null then exists(select 1 from public.member_notifications n where n.id=e.notification_id and n.user_id=auth.uid()) else false end,
 'taskId',case when private.automation_v2_source_visible(auth.uid(),org,'task',e.task_id::text) then e.task_id end,
 'notificationId',case when exists(select 1 from public.member_notifications n where n.id=e.notification_id and n.user_id=auth.uid()) then e.notification_id end,
 'rollbackAvailable',e.status='created' and e.action_kind<>'notify_in_app' and r.rollback_until>now()) item
 from public.organization_automation_effects e where e.run_id=r.id and e.organization_id=org order by e.created_at,e.id limit p_page_size offset (p_page-1)*p_page_size) x;
 return jsonb_build_object('organizationId',org,'run',private.automation_v2_run_json(r)||jsonb_build_object('definitionName',(select name from public.organization_automation_definitions where id=r.definition_id),'definition',snapshot,'definitionSnapshotAvailable',snapshot is not null),
 'effects',jsonb_build_object('rows',result,'total',total,'page',p_page,'pageSize',p_page_size)); end; $$;

revoke all on function private.automation_v3_definition_visible(public.organization_automation_definitions, uuid, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.mi1_get_automation_workspace() from public, anon, authenticated, service_role;
grant execute on function public.mi1_get_automation_workspace() to authenticated;
revoke all on function public.mi1_get_automation_runs(integer,integer,uuid,text,timestamptz,timestamptz),public.mi1_get_automation_run(uuid,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.mi1_get_automation_runs(integer,integer,uuid,text,timestamptz,timestamptz),public.mi1_get_automation_run(uuid,integer,integer) to authenticated;

-- Single sign-on setup follows the hold (copied from 20261003042000:163 and
-- :377 with only the hold added).
create or replace function private.sso_admin_organization(p_write boolean)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  org := private.mi1_require_integration_admin();
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_write and not private.has_organization_role(org, array['admin']) then
    raise exception 'organization admin role required' using errcode = '42501';
  end if;
  if p_write and exists (
    select 1 from public.platform_setting_definitions h
    where h.key = 'features.security.sso' and h.release_at > pg_catalog.now()
  ) then
    raise exception 'sso held for release' using errcode = '42501';
  end if;
  return org;
end;
$function$;

revoke all on function private.sso_admin_organization(boolean) from public, anon, authenticated, service_role;

create or replace function public.get_sso_control()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  org := private.sso_admin_organization(false);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.platform_setting_definitions h
    where h.key = 'features.security.sso' and h.release_at > pg_catalog.now()
  ) then
    return pg_catalog.jsonb_build_object('organizationId', org, 'released', false);
  end if;
  return private.sso_control_json(org) || pg_catalog.jsonb_build_object('released', true);
end;
$function$;

revoke all on function public.get_sso_control() from public, anon, authenticated, service_role;
grant execute on function public.get_sso_control() to authenticated;

commit;
