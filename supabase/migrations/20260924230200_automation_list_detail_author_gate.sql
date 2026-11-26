-- UX-UG-V3-OPENED-AUTOMATION-AUTHORING-TO-STEWARDS-COORDINATORS-ADVISORS-BUT-LEFT-THE-SIX-20260921
--
-- Shared automation v3 (20260911070000) opened authoring to stewards,
-- coordinators and advisors through private.automation_v3_require_author(),
-- and mi1_get_automation_workspace already returns those authors the
-- definitions they may see and the runs they started. The four paged list and
-- detail reads from connected automation v2 (20260910045839) still entered
-- through the admin/vp operator gate, so the Automations, detail and Runs tabs
-- refused every non-approver author.
--
-- Re-emit the four reads behind the author gate and filter their rows exactly
-- as the workspace does:
--   definitions: private.automation_v3_definition_visible(d, actor, org),
--                projected through private.automation_v3_definition_json so the
--                review state and capability flags reach the detail page;
--   runs:        approver, or initiated_by = actor.
-- An approver (admin/vp author) still sees every definition and every run in
-- the organization. Filters, page guards, ordering, effect redaction and the
-- run snapshot redaction are unchanged. The v2 definition read helper is not
-- used here because it re-enters the operator gate.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.mi1_get_automation_definitions(p_page integer default 1,p_page_size integer default 20,p_search text default '',p_status text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid()); org uuid:=private.automation_v3_require_author(); result jsonb; total integer;
begin
 perform private.automation_v2_page_guard(p_page,p_page_size);
 if p_search is null or length(p_search)>80 or (p_status is not null and p_status not in ('draft','active','paused','archived')) then raise exception 'invalid definition filter' using errcode='22023'; end if;
 select count(*) into total from public.organization_automation_definitions d where d.organization_id=org and private.automation_v3_definition_visible(d,actor,org) and (p_status is null or d.status=p_status) and position(lower(p_search) in lower(d.name))>0;
 select coalesce(jsonb_agg(x.item order by x.created_at,x.id),'[]'::jsonb) into result from (select d.id,d.created_at,private.automation_v3_definition_json(d,actor,org) item from public.organization_automation_definitions d where d.organization_id=org and private.automation_v3_definition_visible(d,actor,org) and (p_status is null or d.status=p_status) and position(lower(p_search) in lower(d.name))>0 order by d.created_at,d.id limit p_page_size offset (p_page-1)*p_page_size) x;
 return jsonb_build_object('organizationId',org,'rows',result,'total',total,'page',p_page,'pageSize',p_page_size);
end; $$;

create or replace function public.mi1_get_automation_definition(p_definition_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid()); org uuid:=private.automation_v3_require_author(); d public.organization_automation_definitions%rowtype;
begin select * into d from public.organization_automation_definitions where id=p_definition_id and organization_id=org;
 if d.id is null or not coalesce(private.automation_v3_definition_visible(d,actor,org),false) then raise exception 'definition unavailable' using errcode='42501'; end if;
 return jsonb_build_object('organizationId',org,'definition',private.automation_v3_definition_json(d,actor,org)); end; $$;

create or replace function public.mi1_get_automation_runs(p_page integer default 1,p_page_size integer default 20,p_definition_id uuid default null,p_status text default null,p_from timestamptz default null,p_to timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid()); org uuid:=private.automation_v3_require_author(); approver boolean:=private.automation_v3_actor_is_approver(actor,org); result jsonb; total integer;
begin
 perform private.automation_v2_page_guard(p_page,p_page_size);
 if (p_status is not null and p_status not in ('previewed','in_progress','no_op','succeeded','partial','failed','rolled_back','rollback_partial')) or p_from>p_to then raise exception 'invalid run filter' using errcode='22023'; end if;
 if p_definition_id is not null and not exists(select 1 from public.organization_automation_definitions d where d.id=p_definition_id and d.organization_id=org and private.automation_v3_definition_visible(d,actor,org)) then raise exception 'definition unavailable' using errcode='42501'; end if;
 select count(*) into total from public.organization_automation_runs r where r.organization_id=org and (approver or r.initiated_by=actor) and (p_definition_id is null or r.definition_id=p_definition_id) and (p_status is null or r.status=p_status) and (p_from is null or r.started_at>=p_from) and (p_to is null or r.started_at<=p_to);
 select coalesce(jsonb_agg(x.item order by x.created_at desc,x.id desc),'[]'::jsonb) into result from (
 select r.id,r.created_at,private.automation_v2_run_json(r)||jsonb_build_object('definitionName',d.name) item
 from public.organization_automation_runs r join public.organization_automation_definitions d on d.id=r.definition_id and d.organization_id=r.organization_id
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

revoke all on function public.mi1_get_automation_definitions(integer,integer,text,text),public.mi1_get_automation_definition(uuid),public.mi1_get_automation_runs(integer,integer,uuid,text,timestamptz,timestamptz),public.mi1_get_automation_run(uuid,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.mi1_get_automation_definitions(integer,integer,text,text),public.mi1_get_automation_definition(uuid),public.mi1_get_automation_runs(integer,integer,uuid,text,timestamptz,timestamptz),public.mi1_get_automation_run(uuid,integer,integer) to authenticated;

commit;
