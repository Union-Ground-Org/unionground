-- Connected automation v2. No definitions, tenants, provider activations or cron
-- changes are seeded. Existing v1 definitions and execution remain supported.
begin;
set local lock_timeout = '5s';

alter table public.organization_automation_definitions
  add column schema_version smallint not null default 1 check (schema_version in (1,2)),
  add column conditions jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object'),
  add column action_config jsonb not null default '{}'::jsonb check (jsonb_typeof(action_config) = 'object'),
  drop constraint organization_automation_definitions_trigger_kind_check,
  drop constraint organization_automation_definitions_action_kind_check,
  add constraint organization_automation_definitions_trigger_kind_check check (trigger_kind in (
    'overdue_task','case_deadline','unassigned_case','task_due','blocked_task',
    'unassigned_task','stale_task','review_task','casework_deadline',
    'incomplete_case_checklist','appointment_upcoming','appointment_followup',
    'event_upcoming','event_followup')),
  add constraint organization_automation_definitions_action_kind_check check (action_kind in (
    'create_standard_task','assign_task','raise_task_priority','notify_in_app'));

alter table public.organization_automation_effects
  alter column source_id type text using source_id::text,
  drop constraint organization_automation_effects_source_kind_check,
  drop constraint organization_automation_effects_task_title_check,
  drop constraint organization_automation_effects_task_id_key,
  add constraint organization_automation_effects_source_kind_check check (source_kind in (
    'task','case','casework_deadline','checklist','appointment','event')),
  add constraint organization_automation_effects_task_title_check check (task_title in (
    'Review overdue work','Prepare for a case deadline','Assign case ownership','Review connected work')),
  add column action_kind text not null default 'create_standard_task' check (action_kind in (
    'create_standard_task','assign_task','raise_task_priority','notify_in_app')),
  add column notification_id uuid references public.member_notifications(id) on delete set null,
  add column before_value jsonb,
  add column after_value jsonb,
  add column rollback_target jsonb,
  add column mutation_xid xid8,
  add column reason_code text check (reason_code in ('human_modified','irreversible','source_unavailable','action_failed','permission_lost'));
create unique index organization_automation_effects_created_task_idx
  on public.organization_automation_effects(task_id) where action_kind = 'create_standard_task';
alter table public.organization_automation_effects drop constraint organization_automation_effects_state_complete,
 drop constraint organization_automation_effects_status_check,
 add constraint organization_automation_effects_status_check check (status in ('pending','created','rolled_back','failed')),
 add constraint organization_automation_effects_state_complete check (
 (status='pending' and (task_id is null or action_kind in ('assign_task','raise_task_priority')) and rolled_back_at is null and rolled_back_by is null)
 or (status='created' and rolled_back_at is null and rolled_back_by is null)
 or (status='rolled_back' and rolled_back_at is not null)
 or (status='failed' and task_id is null and notification_id is null and rolled_back_at is null and rolled_back_by is null));
alter table public.organization_automation_runs
 add column definition_snapshot jsonb,
 add column deduplicated_count integer not null default 0 check (deduplicated_count>=0),
 add column cap_limited_count integer not null default 0 check (cap_limited_count>=0);

CREATE OR REPLACE FUNCTION private.enqueue_notification_deliveries()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  prefs jsonb;
  pref_value jsonb;
  outbound_on boolean;
  recent_hour integer;
  recent_day integer;
  recent_week integer := 0;
  org_today integer;
  limit_reason text;
  transactional_receipt boolean := new.kind = 'workload' and new.workload_event = 'receipt';
  max_per_recipient_hour constant integer := 12;
  max_per_recipient_day constant integer := 50;
  max_per_recipient_week constant integer := 5;
  max_org_day constant integer := 20000;
begin
  -- Only a receipt created/locked by this very transaction can suppress task
  -- transport. A caller-set GUC alone, an old receipt, or another backend's
  -- pending receipt grants nothing. In-app notifications and audit still run.
  if new.kind='tasks' and exists(
    select 1 from public.organization_automation_effects e
    join public.organization_automation_runs r on r.id=e.run_id and r.organization_id=e.organization_id and r.status='in_progress'
    join public.organization_automation_definitions d on d.id=e.definition_id and d.schema_version=2
    where e.id::text=current_setting('app.automation_task_receipt',true)
    and e.status='pending' and e.mutation_xid=pg_current_xact_id()
    and e.action_kind in ('create_standard_task','assign_task','raise_task_priority')
    and (d.version=r.definition_version or e.rollback_target is not null)
  ) then return new; end if;
  if new.kind not in (
    'deadlines', 'cases', 'forms', 'votes', 'events', 'tasks',
    'appointments', 'workload', 'dues'
  ) then
    return new;
  end if;
  if exists (
    select 1 from private.member_stress_ledger l
    where l.user_id = new.user_id
  ) then
    return new;
  end if;
  begin
    select controls.outbound_enabled into outbound_on
    from private.notification_controls controls where controls.id;
    if not coalesce(outbound_on, false) then return new; end if;
    select p.notification_prefs into prefs
    from public.member_profiles p where p.id = new.user_id;
    pref_value := prefs -> new.kind;
    if pref_value = 'false'::jsonb then return new; end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member_notification_rate:' || new.user_id::text, 0)
    );
    select pg_catalog.count(*) into recent_hour
    from public.member_notification_deliveries d
    where d.user_id = new.user_id
      and d.created_at > pg_catalog.now() - interval '1 hour';
    select pg_catalog.count(*) into recent_day
    from public.member_notification_deliveries d
    where d.user_id = new.user_id
      and d.created_at > pg_catalog.now() - interval '24 hours';
    if new.kind not in ('deadlines', 'cases') and not transactional_receipt then
      select pg_catalog.count(*) into recent_week
      from public.member_notification_deliveries d
      join public.member_notifications n2 on n2.id = d.notification_id
      where d.user_id = new.user_id
        and d.channel = 'email'
        and d.status <> 'skipped'
        and d.created_at > pg_catalog.now() - interval '7 days'
        and n2.kind not in ('deadlines', 'cases')
        and not (
          n2.kind = 'workload' and n2.workload_event = 'receipt'
        );
    end if;
    select coalesce(pg_catalog.sum(c.enqueued), 0) into org_today
    from private.notification_outbound_counters c where c.day = current_date;
    if recent_hour >= max_per_recipient_hour then
      limit_reason := 'rate limited: recipient hour';
    elsif recent_day >= max_per_recipient_day then
      limit_reason := 'rate limited: recipient day';
    elsif new.kind not in ('deadlines', 'cases') and not transactional_receipt
      and recent_week >= max_per_recipient_week then
      limit_reason := 'rate limited: weekly nudge cap';
    elsif org_today >= max_org_day then
      limit_reason := 'rate limited: org day';
    end if;
    if limit_reason is not null then
      insert into public.member_notification_deliveries (
        notification_id, user_id, channel, status, last_error
      ) values (
        new.id, new.user_id, 'email', 'skipped', limit_reason
      ) on conflict (notification_id, channel) do nothing;
      return new;
    end if;
    insert into private.notification_outbound_counters (day, shard, enqueued)
    values (current_date, (pg_catalog.pg_backend_pid() % 16)::smallint, 1)
    on conflict (day, shard) do update
      set enqueued = private.notification_outbound_counters.enqueued + 1;
    insert into public.member_notification_deliveries (
      notification_id, user_id, channel
    ) values (
      new.id, new.user_id, 'email'
    ) on conflict (notification_id, channel) do nothing;
    insert into public.member_notification_deliveries (
      notification_id, user_id, channel
    )
    select new.id, new.user_id, 'push'
    where exists (
      select 1 from public.member_push_subscriptions s
      where s.user_id = new.user_id
    )
    on conflict (notification_id, channel) do nothing;
  exception
    when query_canceled then
      raise warning 'enqueue_notification_deliveries cancelled for notification %', new.id;
    when others then
      raise warning 'enqueue_notification_deliveries failed for notification %: % (%)',
        new.id, sqlerrm, sqlstate;
  end;
  return new;
end;
end;
$function$;

create function private.automation_v2_operator(p_actor uuid,p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.organizations o
 join public.organization_memberships m on m.organization_id=o.id and m.user_id=p_actor and m.status='active'
 join public.organization_role_grants g on g.organization_id=m.organization_id and g.user_id=m.user_id
 where o.id=p_org and o.status='active' and g.role in ('admin','vp')
 and (not private.staff_mfa_required(o.id) or private.has_second_factor(p_actor)));
$$;

-- Actor-explicit intersection with member_cases SELECT and casework staff RLS.
-- Operators already satisfy the restricted-case admin/VP exception, but that
-- exception does not replace the separate coordinator/assignment visibility gate.
create function private.automation_v2_case_visible(p_actor uuid,p_org uuid,p_case uuid)
returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.member_cases c
 join public.member_profiles subject on subject.id=c.user_id
 join public.chapters ch on ch.id=subject.chapter_id and ch.organization_id=p_org
 where c.id=p_case and c.organization_id=p_org
 and (c.user_id=p_actor or
   (c.steward_user_id=p_actor and exists(select 1 from public.member_role_chapters g where g.user_id=p_actor and g.chapter_id=c.chapter_id and g.role='steward')) or
   exists(select 1 from public.organization_role_grants g where g.user_id=p_actor and g.organization_id=p_org and g.role='coordinator') or
   exists(select 1 from public.member_role_chapters g join public.member_chapter_memberships m on m.user_id=g.user_id and m.chapter_id=g.chapter_id and m.status='active' where g.user_id=p_actor and g.chapter_id=subject.chapter_id and g.role='coordinator')));
$$;
revoke all on function private.automation_v2_case_visible(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function private.automation_v2_source_visible(p_actor uuid,p_org uuid,p_kind text,p_id text)
returns boolean language sql stable security definer set search_path = '' as $$
 select private.automation_v2_operator(p_actor,p_org) and exists (
 select 1 from (
 select t.id::text id,t.chapter_id,'task'::text kind from public.chapter_tasks t where t.deleted_at is null
 union all select c.id::text,c.chapter_id,'case' from public.member_cases c where c.organization_id=p_org
 and private.automation_v2_case_visible(p_actor,p_org,c.id)
 union all select d.id::text,d.chapter_id,'casework_deadline' from public.casework_deadlines d where d.organization_id=p_org
 and private.automation_v2_case_visible(p_actor,p_org,d.case_id)
 union all select c.id::text,c.chapter_id,'checklist' from public.casework_checklists c where c.organization_id=p_org
 and private.automation_v2_case_visible(p_actor,p_org,c.case_id)
 union all select a.id::text,a.chapter_id,'appointment' from public.member_appointments a
 where exists(select 1 from public.organization_memberships m where m.organization_id=p_org and m.user_id=a.user_id and m.status='active')
 and exists(select 1 from public.organization_memberships m where m.organization_id=p_org and m.user_id=a.steward_id and m.status='active')
 -- Match the selected-chapter supervisor route, not broad organization staff.
 and exists(select 1 from public.member_profiles p where p.id=p_actor and p.chapter_id=a.chapter_id)
 and (a.user_id=p_actor or (a.steward_id=p_actor and exists(select 1 from public.member_role_chapters g where g.user_id=p_actor and g.chapter_id=a.chapter_id and g.role='steward')) or
   exists(select 1 from public.organization_role_grants g where g.organization_id=p_org and g.user_id=p_actor and g.role in ('coordinator','advisor','admin')) or
   exists(select 1 from public.member_role_chapters g where g.user_id=p_actor and g.chapter_id=a.chapter_id and g.role in ('coordinator','advisor','admin')))
 union all select e.id,e.chapter_id,'event' from public.member_events e
 ) s join public.chapters ch on ch.id=s.chapter_id
 where s.kind=p_kind and s.id=p_id and ch.organization_id=p_org
 and private.actor_has_chapter_staff_role(p_actor,ch.id));
$$;

-- An authenticated policy predicate derives its actor and organization from the
-- live session. It cannot be used to probe another actor's visibility.
create function private.automation_v2_reference_visible(p_organization_id uuid,p_reference jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare org uuid:=private.cr108_require_operator(); kind text; source_id text;
begin
 if org is distinct from p_organization_id then return false; end if;
 source_id:=coalesce(p_reference#>>'{conditions,sourceId}',p_reference->>'sourceId');
 if source_id is null then return true; end if;
 kind:=p_reference->>'sourceKind';
 if p_reference ? 'triggerKind' then
 kind:=case when p_reference->>'triggerKind' in ('case_deadline','unassigned_case','casework_deadline','incomplete_case_checklist') then 'case'
 when p_reference->>'triggerKind' like 'appointment_%' then 'appointment'
 when p_reference->>'triggerKind' like 'event_%' then 'event' else 'task' end;
 end if;
 return private.automation_v2_source_visible(auth.uid(),org,kind,source_id);
end; $$;
revoke all on function private.automation_v2_reference_visible(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.automation_v2_reference_visible(uuid,jsonb) to authenticated;

-- RPC redaction must not be bypassable through the existing read-only table API.
-- Invisible references hide the complete raw row; governed RPCs can still return
-- a useful redacted definition or independently authorized run/effect projection.
create policy automation_definition_source_visibility on public.organization_automation_definitions
 as restrictive for select to authenticated using (
 private.automation_v2_reference_visible(organization_id,jsonb_build_object('triggerKind',trigger_kind,'conditions',conditions)));
comment on policy automation_definition_source_visibility on public.organization_automation_definitions is
 'Prevent raw definition reads from disclosing a deleted or unauthorized saved source reference; operator and MFA policies remain mandatory.';
create policy automation_run_source_visibility on public.organization_automation_runs
 as restrictive for select to authenticated using (
 private.automation_v2_reference_visible(organization_id,definition_snapshot));
comment on policy automation_run_source_visibility on public.organization_automation_runs is
 'Protect immutable snapshot source references on raw reads; governed run RPCs may return a redacted snapshot without rewriting audit provenance.';
create policy automation_effect_reference_visibility on public.organization_automation_effects
 as restrictive for select to authenticated using (
 private.automation_v2_reference_visible(organization_id,jsonb_build_object('sourceKind',source_kind,'sourceId',source_id))
 and private.automation_v2_reference_visible(organization_id,jsonb_build_object('sourceKind','task','sourceId',task_id))
 and (notification_id is null or exists(select 1 from public.member_notifications n where n.id=notification_id and n.user_id=(select auth.uid()))));
comment on policy automation_effect_reference_visibility on public.organization_automation_effects is
 'Require independent source and outcome visibility before returning a raw effect row; governed RPCs retain useful independently redacted projections.';

create function private.automation_v2_candidates(p_definition_id uuid,p_deduplicate boolean default true)
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
 when 'unassigned_case' then c.steward_user_id is null and c.coordinator_user_id is null else false end
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
 where private.automation_v2_source_visible(coalesce(auth.uid(),d.updated_by),d.organization_id,r.kind,r.id)
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

create function private.automation_v2_validate(p_org uuid,p_spec jsonb) returns void
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
 or tr not in ('overdue_task','case_deadline','unassigned_case','task_due','blocked_task','unassigned_task','stale_task','review_task','casework_deadline','incomplete_case_checklist','appointment_upcoming','appointment_followup','event_upcoming','event_followup')
 or ac not in ('create_standard_task','assign_task','raise_task_priority','notify_in_app') then
 raise exception 'invalid automation capability contract' using errcode='22023'; end if;
 if p_spec ? 'id' and (jsonb_typeof(p_spec->'id') is distinct from 'string' or p_spec->>'id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then raise exception 'invalid definition id' using errcode='22023'; end if;
 if p_spec ? 'expectedVersion' and (not p_spec ? 'id' or jsonb_typeof(p_spec->'expectedVersion') is distinct from 'number' or p_spec->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$') then raise exception 'invalid definition version' using errcode='22023'; end if;
 if p_spec ? 'id' and not p_spec ? 'expectedVersion' then raise exception 'definition version required' using errcode='22023'; end if;
 if exists(select 1 from jsonb_each(cfg) x where jsonb_typeof(x.value) is distinct from 'string') then raise exception 'invalid action value type' using errcode='22023'; end if;
 sk:=case when tr in ('case_deadline','unassigned_case') then 'case' when tr='casework_deadline' then 'casework_deadline'
 when tr='incomplete_case_checklist' then 'checklist' when tr like 'appointment_%' then 'appointment' when tr like 'event_%' then 'event' else 'task' end;
 if tr in ('unassigned_case','blocked_task','unassigned_task','incomplete_case_checklist') and (p_spec->>'thresholdDays')::integer<>0 then raise exception 'threshold not supported' using errcode='22023'; end if;
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

create function public.mi1_save_automation_definition_v2(p_definition jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare org uuid:=private.cr108_require_operator(); saved public.organization_automation_definitions%rowtype; definition_id uuid;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:'||org::text,0));
 if private.cr108_require_operator() is distinct from org then raise exception 'organization changed' using errcode='42501'; end if;
 perform private.automation_v2_validate(org,p_definition);
 definition_id:=(p_definition->>'id')::uuid;
 if definition_id is null then
 if p_definition ? 'expectedVersion' then raise exception 'new definition cannot have version' using errcode='22023'; end if;
 insert into public.organization_automation_definitions(organization_id,name,trigger_kind,threshold_days,task_priority,cadence,action_kind,schema_version,conditions,action_config,created_by,updated_by)
 values(org,btrim(p_definition->>'name'),p_definition->>'triggerKind',(p_definition->>'thresholdDays')::smallint,p_definition->>'taskPriority',p_definition->>'cadence',p_definition->>'actionKind',2,p_definition->'conditions',p_definition->'actionConfig',auth.uid(),auth.uid()) returning * into saved;
 else
 update public.organization_automation_definitions d set name=btrim(p_definition->>'name'),trigger_kind=p_definition->>'triggerKind',threshold_days=(p_definition->>'thresholdDays')::smallint,
 task_priority=p_definition->>'taskPriority',cadence=p_definition->>'cadence',action_kind=p_definition->>'actionKind',schema_version=2,conditions=p_definition->'conditions',action_config=p_definition->'actionConfig',version=d.version+1,updated_by=auth.uid(),updated_at=now()
 where d.id=definition_id and d.organization_id=org and d.version=(p_definition->>'expectedVersion')::integer and d.status<>'archived' returning * into saved;
 if saved.id is null then raise exception 'definition changed' using errcode='40001'; end if;
 end if;
 perform private.cr108_record_audit(org,case when definition_id is null then 'automation_definition_created' else 'automation_definition_updated' end,case when definition_id is null then 'create' else 'update' end,'automation_definition',saved.id::text,auth.uid(),jsonb_build_object('status',saved.status,'cadence',saved.cadence),extensions.gen_random_uuid());
 return jsonb_build_object('id',saved.id,'name',saved.name,'schemaVersion',2,'triggerKind',saved.trigger_kind,'thresholdDays',saved.threshold_days,'taskPriority',saved.task_priority,'cadence',saved.cadence,'status',saved.status,'version',saved.version,'actionKind',saved.action_kind,'conditions',saved.conditions,'actionConfig',saved.action_config);
end;
end;
$$;

create function private.automation_v2_execute(p_run_id uuid) returns jsonb
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
 if not private.automation_v2_operator(coalesce(r.initiated_by,d.updated_by),r.organization_id) then raise exception 'operator unavailable' using errcode='42501'; end if;
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

create or replace function private.cr108_candidate_count(
  p_organization_id uuid,
  p_definition_id uuid,
  p_trigger_kind text,
  p_threshold_days integer
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  total bigint := 0;
begin
  if exists(select 1 from public.organization_automation_definitions where id=p_definition_id and organization_id=p_organization_id and schema_version=2) then
    return (select count(*)::integer from private.automation_v2_candidates(p_definition_id));
  end if;
  case p_trigger_kind
    when 'overdue_task' then
      select pg_catalog.count(*) into total
      from public.chapter_tasks t
      join public.chapters ch on ch.id = t.chapter_id
      where ch.organization_id = p_organization_id
        and t.deleted_at is null
        and t.status <> 'done'
        and t.due_date is not null
        and t.due_date <= current_date - p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'task'
            and e.source_id = t.id::text
            and e.status in ('pending', 'created')
        );
    when 'case_deadline' then
      select pg_catalog.count(*) into total
      from public.member_cases c
      where c.organization_id = p_organization_id
        and c.chapter_id is not null
        and c.status = 'active'
        and c.deadline is not null
        and c.deadline <= current_date + p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        );
    when 'unassigned_case' then
      select pg_catalog.count(*) into total
      from public.member_cases c
      where c.organization_id = p_organization_id
        and c.chapter_id is not null
        and c.status = 'active'
        and c.steward_user_id is null
        and c.coordinator_user_id is null
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        );
    else
      raise exception 'unsupported automation trigger' using errcode = '22023';
  end case;
  return total::integer;
end;
$function$;


create or replace function private.cr108_candidate_sources(
  p_organization_id uuid,
  p_definition_id uuid,
  p_trigger_kind text,
  p_threshold_days integer,
  p_limit integer
)
returns table(source_kind text, source_id uuid, chapter_id text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_limit not between 1 and 50 then
    raise exception 'automation effect limit out of range' using errcode = '22023';
  end if;
  case p_trigger_kind
    when 'overdue_task' then
      return query
      select 'task'::text, t.id, t.chapter_id
      from public.chapter_tasks t
      join public.chapters ch on ch.id = t.chapter_id
      where ch.organization_id = p_organization_id
        and t.deleted_at is null
        and t.status <> 'done'
        and t.due_date is not null
        and t.due_date <= current_date - p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'task'
            and e.source_id = t.id::text
            and e.status in ('pending', 'created')
        )
      order by t.due_date, t.created_at, t.id
      limit p_limit;
    when 'case_deadline' then
      return query
      select 'case'::text, c.id, c.chapter_id
      from public.member_cases c
      where c.organization_id = p_organization_id
        and c.chapter_id is not null
        and c.status = 'active'
        and c.deadline is not null
        and c.deadline <= current_date + p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        )
      order by c.deadline, c.created_at, c.id
      limit p_limit;
    when 'unassigned_case' then
      return query
      select 'case'::text, c.id, c.chapter_id
      from public.member_cases c
      where c.organization_id = p_organization_id
        and c.chapter_id is not null
        and c.status = 'active'
        and c.steward_user_id is null
        and c.coordinator_user_id is null
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        )
      order by c.created_at, c.id
      limit p_limit;
    else
      raise exception 'unsupported automation trigger' using errcode = '22023';
  end case;
end;
$function$;

-- Preserve the full pre-existing task preparation contract.

create or replace function private.prepare_chapter_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_name text;
  resolved_assignee_name text;
  previous_assignee uuid;
  automation_insert boolean := false;
  automation_update boolean := false;
  automation_effect public.organization_automation_effects%rowtype;
  automation_run public.organization_automation_runs%rowtype;
  automation_definition public.organization_automation_definitions%rowtype;
  expected_title text;
begin
  -- ON DELETE SET NULL updates are nested trigger writes. They may still see
  -- stale ambient JWT claims for the identity being deleted, so trigger depth
  -- participates in the gate. Match only the exact FK-detach shape: no
  -- business field may change and identities only stay unchanged or become
  -- NULL. This runs before user-edit normalization, notification, and audit.
  if (caller is null or pg_catalog.pg_trigger_depth() > 1)
     and tg_op = 'UPDATE'
     and (pg_catalog.to_jsonb(new) - array[
       'created_by', 'updated_by', 'assignee_id', 'assignee_name', 'deleted_by'
     ]::text[]) = (pg_catalog.to_jsonb(old) - array[
       'created_by', 'updated_by', 'assignee_id', 'assignee_name', 'deleted_by'
     ]::text[])
     and (new.created_by is null or new.created_by is not distinct from old.created_by)
     and (new.updated_by is null or new.updated_by is not distinct from old.updated_by)
     and (new.assignee_id is null or new.assignee_id is not distinct from old.assignee_id)
     and (new.deleted_by is null or new.deleted_by is not distinct from old.deleted_by)
     and (
       new.created_by is distinct from old.created_by
       or new.updated_by is distinct from old.updated_by
       or new.assignee_id is distinct from old.assignee_id
       or new.deleted_by is distinct from old.deleted_by
     ) then
    if new.assignee_id is null and new.assignee_id is distinct from old.assignee_id then
      new.assignee_name := '';
    else
      new.assignee_name := old.assignee_name;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    select e.* into automation_effect
    from public.organization_automation_effects e
    where e.planned_task_id = new.id
      and e.status = 'pending'
    for update of e;

    if found then
      select r.* into strict automation_run
      from public.organization_automation_runs r
      where r.id = automation_effect.run_id
        and r.organization_id = automation_effect.organization_id
        and r.definition_id = automation_effect.definition_id
        and r.status = 'in_progress';

      select d.* into strict automation_definition
      from public.organization_automation_definitions d
      where d.id = automation_effect.definition_id
        and d.organization_id = automation_effect.organization_id
        and d.version = automation_run.definition_version
        and d.action_kind = 'create_standard_task';

      if not exists (
        select 1 from public.chapters ch
        where ch.id = automation_effect.chapter_id
          and ch.organization_id = automation_effect.organization_id
      ) then
        raise exception 'automation effect chapter is outside the organization'
          using errcode = '42501';
      end if;

      automation_insert := true;
      caller := automation_run.initiated_by;
      caller_chapter := automation_effect.chapter_id;
      caller_name := 'Automation';
      expected_title := case automation_definition.trigger_kind
        when 'overdue_task' then 'Review overdue work'
        when 'case_deadline' then 'Prepare for a case deadline'
        when 'unassigned_case' then 'Assign case ownership'
        else 'Review connected work'
      end;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    select e.* into automation_effect from public.organization_automation_effects e
    join public.organization_automation_runs r on r.id=e.run_id and r.organization_id=e.organization_id and r.status='in_progress'
    join public.organization_automation_definitions d on d.id=e.definition_id and (d.version=r.definition_version or e.rollback_target is not null) and d.schema_version=2
    where e.task_id=new.id and e.status='pending' and e.action_kind in ('assign_task','raise_task_priority')
    and e.source_kind='task' and e.source_id=new.id::text and e.chapter_id=new.chapter_id
    and (to_jsonb(new)-array['assignee_id','priority'])=(to_jsonb(old)-array['assignee_id','priority'])
    and case e.action_kind when 'assign_task' then new.assignee_id::text is not distinct from coalesce(e.rollback_target,e.after_value)->>'assigneeId' and new.priority=old.priority
    else new.priority=coalesce(e.rollback_target,e.after_value)->>'priority' and new.assignee_id is not distinct from old.assignee_id end
    for update of e;
    if found then
      select d.* into strict automation_definition from public.organization_automation_definitions d where d.id=automation_effect.definition_id;
      if not private.automation_v2_operator(coalesce(caller,automation_definition.updated_by),automation_effect.organization_id) then
        raise exception 'automation authority unavailable' using errcode='42501';
      end if;
      caller:=coalesce(caller,automation_definition.updated_by);
      caller_chapter:=automation_effect.chapter_id;
      caller_name:='Automation';
      automation_update:=true;
    end if;
  end if;

  if caller is null and not automation_insert and not automation_update then
    raise exception 'authentication required';
  end if;

  if not automation_insert and not automation_update then
    select p.chapter_id, p.full_name
      into caller_chapter, caller_name
    from public.member_profiles p
    where p.id = caller;
  end if;

  if caller_chapter is null then
    raise exception 'member chapter required';
  end if;

  new.title := pg_catalog.btrim(new.title);
  new.description := pg_catalog.btrim(new.description);
  new.workstream := pg_catalog.btrim(new.workstream);

  if automation_insert and (
    new.title is distinct from expected_title
    or new.description <> ''
    or new.chapter_id is distinct from caller_chapter
    or new.status <> 'to_do'
    or new.priority is distinct from automation_definition.task_priority
    or new.workstream <> 'General'
    or new.assignee_id is not null
    or new.start_date is not null
    or new.due_date is not null
    or new.progress <> 0
    or new.blocked
    or new.milestone
    or new.task_type <> 'general'
  ) then
    raise exception 'automation task shape rejected' using errcode = '23514';
  end if;

  if new.assignee_id is null then
    new.assignee_name := '';
  elsif tg_op = 'INSERT'
     or new.assignee_id is distinct from old.assignee_id then
    select p.full_name
      into resolved_assignee_name
    from public.member_profiles p
    where p.id = new.assignee_id
      and p.chapter_id = caller_chapter;

    if resolved_assignee_name is null then
      raise exception 'assignee must be a member of your chapter'
        using errcode = '22023';
    end if;
    new.assignee_name := pg_catalog.btrim(resolved_assignee_name);
  elsif coalesce(pg_catalog.current_setting('sg.refresh_names', true), '') = '1' then
    new.assignee_name := pg_catalog.btrim(new.assignee_name);
  else
    new.assignee_name := old.assignee_name;
  end if;

  if tg_op = 'INSERT' then
    new.chapter_id := caller_chapter;
    new.created_by := caller;
    new.created_at := pg_catalog.now();
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('chapter_tasks.task_number:' || caller_chapter, 0));

    insert into private.chapter_task_number_counters (chapter_id, last_number)
    select caller_chapter, coalesce(pg_catalog.max(t.task_number), 0)
    from public.chapter_tasks t
    where t.chapter_id = caller_chapter
    on conflict (chapter_id) do nothing;

    update private.chapter_task_number_counters c
       set last_number = c.last_number + 1
     where c.chapter_id = caller_chapter
     returning c.last_number into new.task_number;
  elsif new.chapter_id is distinct from old.chapter_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.task_number is distinct from old.task_number then
    raise exception 'task ownership fields are immutable';
  end if;

  new.updated_by := caller;
  new.updated_at := pg_catalog.now();

  if new.status = 'done' then
    new.progress := 100;
    new.done_at := case when tg_op = 'UPDATE' then coalesce(old.done_at, pg_catalog.now()) else pg_catalog.now() end;
  else
    if tg_op = 'UPDATE' and old.done_at is not null
       and new.progress = 100 and old.progress = 100 then
      new.progress := 99;
    end if;
    new.done_at := null;
  end if;

  -- Preserve normal in-app assignment notices; the transaction-bound receipt
  -- guard in enqueue_notification_deliveries suppresses only external transport.
  previous_assignee := case when tg_op = 'UPDATE' then old.assignee_id else null end;
  if new.assignee_id is distinct from previous_assignee then
    if new.assignee_id is not null and new.assignee_id <> caller then
      perform private.notify_member(
        new.assignee_id, 'task.assigned',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
    end if;
    if previous_assignee is not null and previous_assignee <> caller then
      perform private.notify_member(
        previous_assignee, 'task.unassigned',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
    end if;
  end if;
  return new;
end;
end;
$function$;


create or replace function private.cr108_execute_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  run_row public.organization_automation_runs%rowtype;
  definition_row public.organization_automation_definitions%rowtype;
  effect_limit integer := 20;
  candidate record;
  candidate_total integer := 0;
  created_count integer := 0;
  skipped_count integer := 0;
  failed_count integer := 0;
  effect_id uuid;
  inserted_effect uuid;
  created_task_id uuid;
  task_title text;
  final_status text;
  final_failure text;
begin
  if exists(select 1 from public.organization_automation_runs r join public.organization_automation_definitions d on d.id=r.definition_id where r.id=p_run_id and d.schema_version=2) then
    return private.automation_v2_execute(p_run_id);
  end if;
  select r.* into strict run_row
  from public.organization_automation_runs r
  where r.id = p_run_id
  for update of r;

  if run_row.status <> 'in_progress' then
    raise exception 'automation run is not executable' using errcode = '22023';
  end if;

  select d.* into strict definition_row
  from public.organization_automation_definitions d
  where d.id = run_row.definition_id
    and d.organization_id = run_row.organization_id
    and d.version = run_row.definition_version
  for update of d;

  select s.max_effects_per_run into effect_limit
  from public.organization_automation_settings s
  where s.organization_id = run_row.organization_id
    and s.enabled;

  if effect_limit is null then
    update public.organization_automation_runs
       set status = 'failed', failure_code = 'disabled',
           completed_at = pg_catalog.now()
     where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'failed', 'failureCode', 'disabled');
  end if;

  candidate_total := private.cr108_candidate_count(
    run_row.organization_id, definition_row.id,
    definition_row.trigger_kind, definition_row.threshold_days
  );

  task_title := case definition_row.trigger_kind
    when 'overdue_task' then 'Review overdue work'
    when 'case_deadline' then 'Prepare for a case deadline'
    when 'unassigned_case' then 'Assign case ownership'
  end;

  for candidate in
    select * from private.cr108_candidate_sources(
      run_row.organization_id, definition_row.id,
      definition_row.trigger_kind, definition_row.threshold_days,
      effect_limit
    )
  loop
    begin
      effect_id := extensions.gen_random_uuid();
      created_task_id := extensions.gen_random_uuid();
      inserted_effect := null;

      insert into public.organization_automation_effects (
        id, organization_id, run_id, definition_id, source_kind, source_id,
        chapter_id, planned_task_id, task_title, task_priority, status
      ) values (
        effect_id, run_row.organization_id, run_row.id, definition_row.id,
        candidate.source_kind, candidate.source_id, candidate.chapter_id,
        created_task_id, task_title, definition_row.task_priority, 'pending'
      )
      on conflict (organization_id, definition_id, source_kind, source_id)
        where status in ('pending', 'created')
      do nothing
      returning id into inserted_effect;

      if inserted_effect is null then
        skipped_count := skipped_count + 1;
        continue;
      end if;

      insert into public.chapter_tasks (
        id, chapter_id, title, description, status, priority, workstream,
        assignee_id, assignee_name, start_date, due_date, progress, blocked,
        milestone, order_index, task_type
      ) values (
        created_task_id, candidate.chapter_id, task_title, '', 'to_do',
        definition_row.task_priority, 'General', null, '', null, null, 0,
        false, false, 0, 'general'
      );

      update public.organization_automation_effects
         set task_id = created_task_id, status = 'created'
       where id = inserted_effect;
      created_count := created_count + 1;
    exception when others then
      failed_count := failed_count + 1;
    end;
  end loop;

  final_status := case
    when candidate_total = 0 then 'no_op'
    when created_count = 0 and failed_count > 0 then 'failed'
    when failed_count > 0 then 'partial'
    else 'succeeded'
  end;
  final_failure := case when failed_count > 0 then 'effect_write_failed' else null end;

  update public.organization_automation_runs
     set status = final_status,
         candidates_count = candidate_total,
         effects_created = created_count,
         effects_skipped = skipped_count + greatest(candidate_total - effect_limit, 0),
         effects_failed = failed_count,
         failure_code = final_failure,
         completed_at = pg_catalog.now(),
         rollback_until = case when created_count > 0 then pg_catalog.now() + interval '7 days' else null end
   where id = run_row.id;

  update public.organization_automation_definitions
     set last_run_at = pg_catalog.now(),
         next_run_at = case when run_row.mode = 'scheduled'
           then private.cr108_next_run(cadence, pg_catalog.now())
           else next_run_at end,
         updated_at = case when run_row.mode = 'scheduled' then pg_catalog.now() else updated_at end
   where id = definition_row.id;

  perform private.cr108_record_audit(
    run_row.organization_id,
    'automation_run_completed',
    'create',
    'automation_run',
    run_row.id::text,
    run_row.initiated_by,
    pg_catalog.jsonb_build_object(
      'runId', run_row.id,
      'status', final_status,
      'count', created_count,
      'cadence', definition_row.cadence,
      'reasonCode', final_failure
    ),
    extensions.gen_random_uuid()
  );

  return pg_catalog.jsonb_build_object(
    'id', run_row.id,
    'status', final_status,
    'candidatesCount', candidate_total,
    'effectsCreated', created_count,
    'effectsSkipped', skipped_count + greatest(candidate_total - effect_limit, 0),
    'effectsFailed', failed_count,
    'rollbackUntil', case when created_count > 0 then pg_catalog.now() + interval '7 days' else null end
  );
end;
end;
$function$;


create or replace function public.save_organization_automation_definition(
  p_definition_id uuid,
  p_name text,
  p_trigger_kind text,
  p_threshold_days integer,
  p_cadence text,
  p_task_priority text,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  saved public.organization_automation_definitions%rowtype;
  audit_id uuid := extensions.gen_random_uuid();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.cr108_require_operator() is distinct from org then
    raise exception 'organization scope changed' using errcode = '42501';
  end if;

  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_name, ''))) not between 3 and 80
     or p_name ~ '[[:cntrl:]]' then
    raise exception 'automation name must be 3 to 80 visible characters' using errcode = '22023';
  end if;
  if p_trigger_kind not in ('overdue_task', 'case_deadline', 'unassigned_case')
     or p_cadence not in ('hourly', 'daily', 'weekly')
     or p_task_priority not in ('low', 'medium', 'high')
     or p_threshold_days not between 0 and 90
     or (p_trigger_kind = 'unassigned_case' and p_threshold_days <> 0) then
    raise exception 'invalid automation definition' using errcode = '22023';
  end if;

  if exists(select 1 from public.organization_automation_definitions where id=p_definition_id and organization_id=org and schema_version=2) then
    raise exception 'v2 definition requires v2 editor' using errcode='22023';
  end if;
  if p_definition_id is null then
    if p_expected_version is not null then
      raise exception 'new automation definition cannot have a version' using errcode = '22023';
    end if;
    insert into public.organization_automation_definitions (
      organization_id, name, trigger_kind, threshold_days, task_priority,
      cadence, created_by, updated_by
    ) values (
      org, pg_catalog.btrim(p_name), p_trigger_kind, p_threshold_days,
      p_task_priority, p_cadence, actor, actor
    ) returning * into saved;
  else
    if p_expected_version is null then
      raise exception 'expected automation version required' using errcode = '22023';
    end if;
    update public.organization_automation_definitions d
       set name = pg_catalog.btrim(p_name),
           trigger_kind = p_trigger_kind,
           threshold_days = p_threshold_days,
           task_priority = p_task_priority,
           cadence = p_cadence,
           version = d.version + 1,
           updated_by = actor,
           updated_at = pg_catalog.now()
     where d.id = p_definition_id
       and d.organization_id = org
       and d.version = p_expected_version
       and d.status <> 'archived'
     returning d.* into saved;
    if saved.id is null then
      raise exception 'automation definition changed; reload before saving' using errcode = '40001';
    end if;
  end if;

  perform private.cr108_record_audit(
    org,
    case when p_definition_id is null then 'automation_definition_created' else 'automation_definition_updated' end,
    case when p_definition_id is null then 'create' else 'update' end,
    'automation_definition',
    saved.id::text,
    actor,
    pg_catalog.jsonb_build_object('status', saved.status, 'cadence', saved.cadence),
    audit_id
  );

  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'name', saved.name, 'triggerKind', saved.trigger_kind,
    'thresholdDays', saved.threshold_days, 'taskPriority', saved.task_priority,
    'cadence', saved.cadence, 'status', saved.status, 'version', saved.version
  );
end;
end;
$function$;

create function private.automation_v2_definition_json(d public.organization_automation_definitions) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('id',d.id,'name',d.name,'schemaVersion',d.schema_version,'triggerKind',d.trigger_kind,'thresholdDays',d.threshold_days,'taskPriority',d.task_priority,'actionKind',d.action_kind,'conditions',d.conditions,'actionConfig',d.action_config,'cadence',d.cadence,'status',d.status,'version',d.version,'nextRunAt',d.next_run_at,'lastRunAt',d.last_run_at,'createdAt',d.created_at,'updatedAt',d.updated_at);
$$;

create function private.automation_v2_definition_read(d public.organization_automation_definitions) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb:=private.automation_v2_definition_json(d);
begin
 if not private.automation_v2_reference_visible(d.organization_id,result) then
 result:=jsonb_set(result,'{conditions}',(result->'conditions')-'sourceId')||jsonb_build_object('sourceFilterAvailable',false);
 end if;
 return result;
end; $$;
revoke all on function private.automation_v2_definition_read(public.organization_automation_definitions) from public,anon,authenticated,service_role;

create function private.automation_v2_run_json(r public.organization_automation_runs) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('id',r.id,'definitionId',r.definition_id,'definitionVersion',r.definition_version,'mode',r.mode,'status',r.status,'candidatesCount',r.candidates_count,'deduplicatedCount',r.deduplicated_count,'capLimitedCount',r.cap_limited_count,'effectsCreated',r.effects_created,'effectsSkipped',r.effects_skipped,'effectsFailed',r.effects_failed,'effectsRolledBack',r.effects_rolled_back,'rollbackSkipped',r.rollback_skipped,'confirmationPhrase',r.confirmation_phrase,'failureCode',r.failure_code,'startedAt',r.started_at,'completedAt',r.completed_at,'rollbackUntil',r.rollback_until,'rolledBackAt',r.rolled_back_at,'rollbackEligible',r.status in ('succeeded','partial') and r.effects_created>r.effects_rolled_back and r.rollback_until>now(),'rollbackPhrase','ROLL BACK '||upper(left(r.id::text,8)));
$$;

create function private.automation_v2_page_guard(p_page integer,p_page_size integer) returns void
language plpgsql immutable set search_path = '' as $$ begin
 if p_page is null or p_page not between 1 and 10000 or p_page_size is null or p_page_size not between 1 and 50 then
 raise exception 'invalid page bounds' using errcode='22023'; end if; end; $$;

create function public.mi1_get_automation_definitions(p_page integer default 1,p_page_size integer default 20,p_search text default '',p_status text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid:=private.cr108_require_operator(); result jsonb; total integer;
begin
 perform private.automation_v2_page_guard(p_page,p_page_size);
 if p_search is null or length(p_search)>80 or (p_status is not null and p_status not in ('draft','active','paused','archived')) then raise exception 'invalid definition filter' using errcode='22023'; end if;
 select count(*) into total from public.organization_automation_definitions d where d.organization_id=org and (p_status is null or d.status=p_status) and position(lower(p_search) in lower(d.name))>0;
 select coalesce(jsonb_agg(x.item order by x.created_at,x.id),'[]'::jsonb) into result from (select d.id,d.created_at,private.automation_v2_definition_read(d) item from public.organization_automation_definitions d where d.organization_id=org and (p_status is null or d.status=p_status) and position(lower(p_search) in lower(d.name))>0 order by d.created_at,d.id limit p_page_size offset (p_page-1)*p_page_size) x;
 return jsonb_build_object('organizationId',org,'rows',result,'total',total,'page',p_page,'pageSize',p_page_size);
end; $$;

create function public.mi1_get_automation_definition(p_definition_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid:=private.cr108_require_operator(); d public.organization_automation_definitions%rowtype;
begin select * into d from public.organization_automation_definitions where id=p_definition_id and organization_id=org;
 if d.id is null then raise exception 'definition unavailable' using errcode='42501'; end if;
 return jsonb_build_object('organizationId',org,'definition',private.automation_v2_definition_read(d)); end; $$;

create function public.mi1_get_automation_runs(p_page integer default 1,p_page_size integer default 20,p_definition_id uuid default null,p_status text default null,p_from timestamptz default null,p_to timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid:=private.cr108_require_operator(); result jsonb; total integer;
begin
 perform private.automation_v2_page_guard(p_page,p_page_size);
 if (p_status is not null and p_status not in ('previewed','in_progress','no_op','succeeded','partial','failed','rolled_back','rollback_partial')) or p_from>p_to then raise exception 'invalid run filter' using errcode='22023'; end if;
 if p_definition_id is not null and not exists(select 1 from public.organization_automation_definitions where id=p_definition_id and organization_id=org) then raise exception 'definition unavailable' using errcode='42501'; end if;
 select count(*) into total from public.organization_automation_runs r where r.organization_id=org and (p_definition_id is null or r.definition_id=p_definition_id) and (p_status is null or r.status=p_status) and (p_from is null or r.started_at>=p_from) and (p_to is null or r.started_at<=p_to);
 select coalesce(jsonb_agg(x.item order by x.created_at desc,x.id desc),'[]'::jsonb) into result from (
 select r.id,r.created_at,private.automation_v2_run_json(r)||jsonb_build_object('definitionName',d.name) item
 from public.organization_automation_runs r join public.organization_automation_definitions d on d.id=r.definition_id and d.organization_id=r.organization_id
 where r.organization_id=org and (p_definition_id is null or r.definition_id=p_definition_id) and (p_status is null or r.status=p_status) and (p_from is null or r.started_at>=p_from) and (p_to is null or r.started_at<=p_to)
 order by r.created_at desc,r.id desc limit p_page_size offset (p_page-1)*p_page_size) x;
 return jsonb_build_object('organizationId',org,'rows',result,'total',total,'page',p_page,'pageSize',p_page_size); end; $$;

create function public.mi1_get_automation_run(p_run_id uuid,p_page integer default 1,p_page_size integer default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid:=private.cr108_require_operator(); r public.organization_automation_runs%rowtype; result jsonb; total integer; snapshot jsonb; source_kind text;
begin
 perform private.automation_v2_page_guard(p_page,p_page_size);
 select * into r from public.organization_automation_runs where id=p_run_id and organization_id=org;
 if r.id is null then raise exception 'run unavailable' using errcode='42501'; end if;
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

create function public.mi1_get_automation_scope_options(p_source text,p_chapter_id text default null,p_search text default '',p_page integer default 1,p_page_size integer default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid:=private.cr108_require_operator(); chapters jsonb; people jsonb; chapter_total integer; people_total integer;
begin
 perform private.automation_v2_page_guard(p_page,p_page_size);
 if p_source is null or p_source not in ('task','case','appointment','event') or p_search is null or length(p_search)>80 then raise exception 'invalid scope filter' using errcode='22023'; end if;
 if p_chapter_id is not null and not exists(select 1 from public.chapters where id=p_chapter_id and organization_id=org and private.actor_has_chapter_staff_role(auth.uid(),id)) then raise exception 'chapter unavailable' using errcode='42501'; end if;
 select count(*) into chapter_total from public.chapters where organization_id=org and private.actor_has_chapter_staff_role(auth.uid(),id) and position(lower(p_search) in lower(name))>0;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'label',x.name) order by x.name,x.id),'[]'::jsonb) into chapters from (select id,name from public.chapters where organization_id=org and private.actor_has_chapter_staff_role(auth.uid(),id) and position(lower(p_search) in lower(name))>0 order by name,id limit p_page_size offset (p_page-1)*p_page_size) x;
 select count(*) into people_total from public.member_profiles p join public.chapters ch on ch.id=p.chapter_id
 join public.organization_memberships m on m.user_id=p.id and m.organization_id=ch.organization_id and m.status='active'
 where ch.organization_id=org and (p_chapter_id is null or ch.id=p_chapter_id) and private.actor_has_chapter_staff_role(p.id,ch.id) and position(lower(p_search) in lower(p.full_name))>0;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'label',x.full_name) order by x.full_name,x.id),'[]'::jsonb) into people from (
 select p.id,p.full_name from public.member_profiles p join public.chapters ch on ch.id=p.chapter_id
 join public.organization_memberships m on m.user_id=p.id and m.organization_id=ch.organization_id and m.status='active'
 where ch.organization_id=org and (p_chapter_id is null or ch.id=p_chapter_id) and private.actor_has_chapter_staff_role(p.id,ch.id) and position(lower(p_search) in lower(p.full_name))>0
 order by p.full_name,p.id limit p_page_size offset (p_page-1)*p_page_size) x;
 return jsonb_build_object('organizationId',org,'chapters',jsonb_build_object('rows',chapters,'total',chapter_total,'page',p_page,'pageSize',p_page_size),'assignees',jsonb_build_object('rows',people,'total',people_total,'page',p_page,'pageSize',p_page_size),'recipients',jsonb_build_object('rows',people,'total',people_total,'page',p_page,'pageSize',p_page_size)); end; $$;

create function public.mi1_get_automation_source_context(p_source text,p_source_id text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid:=private.cr108_require_operator(); chapter text;
begin
 if not private.automation_v2_source_visible(auth.uid(),org,p_source,p_source_id) then raise exception 'source unavailable' using errcode='42501'; end if;
 select s.chapter_id into chapter from (
 select id::text id,chapter_id,'task'::text kind from public.chapter_tasks
 union all select id::text,chapter_id,'case' from public.member_cases
 union all select id::text,chapter_id,'appointment' from public.member_appointments
 union all select id,chapter_id,'event' from public.member_events) s where s.id=p_source_id and s.kind=p_source;
 if chapter is null then raise exception 'source unavailable' using errcode='42501'; end if;
 return jsonb_build_object('organizationId',org,'sourceKind',p_source,'sourceId',p_source_id,'chapterId',chapter); end; $$;

create or replace function public.get_organization_automation_control_room()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.cr108_require_operator();
  settings_json jsonb;
  definitions_json jsonb;
  runs_json jsonb;
  scheduler_configured boolean := false;
begin
  select pg_catalog.jsonb_build_object(
    'enabled', s.enabled,
    'maxEffectsPerRun', s.max_effects_per_run,
    'updatedAt', s.updated_at
  ) into settings_json
  from public.organization_automation_settings s
  where s.organization_id = org;

  if settings_json is null then
    settings_json := pg_catalog.jsonb_build_object(
      'enabled', false,
      'maxEffectsPerRun', 20,
      'updatedAt', null
    );
  end if;

  select coalesce(pg_catalog.jsonb_agg(projected.item order by projected.created_at, projected.id), '[]'::jsonb)
  into definitions_json
  from (
    select d.created_at, d.id,
      private.automation_v2_definition_read(d) || pg_catalog.jsonb_build_object(
        'dependencyReady', private.automation_v2_operator(d.updated_by,d.organization_id)
      ) as item
    from public.organization_automation_definitions d
    where d.organization_id = org
      and d.status <> 'archived'
    order by d.created_at,d.id limit 50
  ) projected;

  select coalesce(pg_catalog.jsonb_agg(projected.item order by projected.created_at desc, projected.id desc), '[]'::jsonb)
  into runs_json
  from (
    select r.created_at, r.id, pg_catalog.jsonb_build_object(
      'id', r.id,
      'definitionId', r.definition_id,
      'definitionName', d.name,
      'mode', r.mode,
      'status', r.status,
      'candidatesCount', r.candidates_count,
      'effectsCreated', r.effects_created,
      'effectsSkipped', r.effects_skipped,
      'effectsFailed', r.effects_failed,
      'effectsRolledBack', r.effects_rolled_back,
      'rollbackSkipped', r.rollback_skipped,
      'confirmationPhrase', r.confirmation_phrase,
      'failureCode', r.failure_code,
      'startedAt', r.started_at,
      'completedAt', r.completed_at,
      'rollbackUntil', r.rollback_until,
      'rolledBackAt', r.rolled_back_at,
      'rollbackEligible', (
        r.status in ('succeeded', 'partial')
        and r.effects_created > r.effects_rolled_back
        and r.rollback_until > pg_catalog.now()
      ),
      'rollbackPhrase', 'ROLL BACK ' || pg_catalog.upper(pg_catalog.left(r.id::text, 8))
    ) as item
    from public.organization_automation_runs r
    join public.organization_automation_definitions d
      on d.id = r.definition_id and d.organization_id = r.organization_id
    where r.organization_id = org
    order by r.created_at desc, r.id desc
    limit 50
  ) projected;

  if pg_catalog.to_regclass('cron.job') is not null then
    select exists (
      select 1 from cron.job j
      where j.jobname = 'organization-automation-tick' and j.active
    ) into scheduler_configured;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'settings', settings_json,
    'definitions', definitions_json,
    'runs', runs_json,
    'schedulerConfigured', scheduler_configured,
    'capabilities', jsonb_build_object('schemaVersion',2,'triggers',jsonb_build_array('overdue_task','case_deadline','unassigned_case','task_due','blocked_task','unassigned_task','stale_task','review_task','casework_deadline','incomplete_case_checklist','appointment_upcoming','appointment_followup','event_upcoming','event_followup'),'actions',jsonb_build_array('create_standard_task','assign_task','raise_task_priority','notify_in_app'),'cadences',jsonb_build_array('hourly','daily','weekly'),'maxThresholdDays',90)
  );
end;
$function$;

create function private.automation_v2_rollback_actions(p_run_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare org uuid:=private.cr108_require_operator(); r public.organization_automation_runs%rowtype;
e public.organization_automation_effects%rowtype; t public.chapter_tasks%rowtype; undone integer:=0; skipped integer:=0; final text;
begin
 select * into strict r from public.organization_automation_runs where id=p_run_id and organization_id=org for update;
 -- Called only after the public confirmation/window guard; repeat eligibility
 -- here so internal callers cannot bypass the action contract.
 if r.status not in ('succeeded','partial') or r.rollback_until<=now() then raise exception 'rollback unavailable' using errcode='22023'; end if;
 update public.organization_automation_runs set status='in_progress' where id=r.id;
 for e in select * from public.organization_automation_effects where run_id=r.id and organization_id=org and status='created' order by created_at,id for update loop
   if e.action_kind='notify_in_app' then
     update public.organization_automation_effects set reason_code='irreversible' where id=e.id;
     skipped:=skipped+1; continue;
   end if;
   select * into t from public.chapter_tasks where id=e.task_id for update;
   if t.id is null or t.deleted_at is not null or not private.automation_v2_source_visible(auth.uid(),org,'task',t.id::text)
   or t.updated_at is distinct from (e.after_value->>'updatedAt')::timestamptz
   or encode(extensions.digest(convert_to(to_jsonb(t)::text,'UTF8'),'sha256'),'hex') is distinct from e.after_value->>'taskDigest'
   or (select count(*) from public.chapter_task_activity where task_id=t.id) is distinct from (e.after_value->>'activityCount')::bigint
   or (e.action_kind='assign_task' and t.assignee_id::text is distinct from e.after_value->>'assigneeId')
   or (e.action_kind='raise_task_priority' and t.priority is distinct from e.after_value->>'priority') then
     update public.organization_automation_effects set reason_code='human_modified' where id=e.id;
     skipped:=skipped+1; continue;
   end if;
   update public.organization_automation_effects set status='pending',rollback_target=before_value,mutation_xid=pg_current_xact_id() where id=e.id;
   perform set_config('app.automation_task_receipt',e.id::text,true);
   if e.action_kind='assign_task' then update public.chapter_tasks set assignee_id=(e.before_value->>'assigneeId')::uuid where id=t.id;
   elsif e.action_kind='raise_task_priority' then update public.chapter_tasks set priority=e.before_value->>'priority' where id=t.id;
   else raise exception 'unsupported rollback action' using errcode='22023'; end if;
   perform set_config('app.automation_task_receipt','',true);
   update public.organization_automation_effects set status='rolled_back',rolled_back_at=now(),rolled_back_by=auth.uid(),rollback_target=null where id=e.id;
   undone:=undone+1;
 end loop;
 final:=case when skipped=0 then 'rolled_back' else 'rollback_partial' end;
 update public.organization_automation_runs set status=final,effects_rolled_back=effects_rolled_back+undone,rollback_skipped=rollback_skipped+skipped,rolled_back_at=now(),rolled_back_by=auth.uid() where id=r.id;
 perform private.cr108_record_audit(org,'automation_run_rolled_back','update','automation_run',r.id::text,auth.uid(),jsonb_build_object('runId',r.id,'status',final,'count',undone,'reasonCode',case when skipped>0 then 'human_modified' end),extensions.gen_random_uuid());
 return jsonb_build_object('id',r.id,'status',final,'effectsRolledBack',undone,'rollbackSkipped',skipped);
end; end;
$$;

create or replace function public.rollback_organization_automation_run(
  p_run_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  run_row public.organization_automation_runs%rowtype;
  effect_row public.organization_automation_effects%rowtype;
  task_row public.chapter_tasks%rowtype;
  rolled_back_count integer := 0;
  skipped_count integer := 0;
  expected_confirmation text;
  final_status text;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.cr108_require_operator() is distinct from org then
    raise exception 'organization scope changed' using errcode = '42501';
  end if;

  select r.* into run_row
  from public.organization_automation_runs r
  where r.id = p_run_id
    and r.organization_id = org
  for update of r;
  if run_row.id is null
     or run_row.status not in ('succeeded', 'partial')
     or run_row.effects_created <= run_row.effects_rolled_back
     or run_row.rollback_until is null
     or run_row.rollback_until <= pg_catalog.now() then
    raise exception 'automation run is not rollback eligible' using errcode = '22023';
  end if;

  expected_confirmation := 'ROLL BACK ' || pg_catalog.upper(pg_catalog.left(run_row.id::text, 8));
  if p_confirmation is distinct from expected_confirmation then
    raise exception 'automation rollback confirmation did not match' using errcode = '22023';
  end if;

  if exists(select 1 from public.organization_automation_effects where run_id=run_row.id and action_kind<>'create_standard_task') then
    return private.automation_v2_rollback_actions(run_row.id);
  end if;
  for effect_row in
    select e.*
    from public.organization_automation_effects e
    where e.organization_id = org
      and e.run_id = run_row.id
      and e.status = 'created'
    order by e.created_at, e.id
    for update of e
  loop
    select t.* into task_row
    from public.chapter_tasks t
    where t.id = effect_row.task_id
    for update of t;

    if task_row.id is null
       or task_row.deleted_at is not null
       or task_row.title is distinct from effect_row.task_title
       or task_row.description <> ''
       or task_row.status <> 'to_do'
       or task_row.priority is distinct from effect_row.task_priority
       or task_row.progress <> 0
       or task_row.assignee_id is not null
       or task_row.start_date is not null
       or task_row.due_date is not null
       or task_row.blocked
       or task_row.milestone
       or task_row.task_type <> 'general'
       or task_row.workstream <> 'General'
       or task_row.updated_at > task_row.created_at + interval '5 seconds'
       or (select pg_catalog.count(*) from public.chapter_task_activity a where a.task_id = task_row.id) <> 1
       or exists (select 1 from public.chapter_task_comments c where c.task_id = task_row.id)
       or exists (select 1 from public.chapter_task_messages m where m.task_id = task_row.id)
       or exists (select 1 from public.chapter_task_attachments a where a.task_id = task_row.id)
       or exists (select 1 from public.chapter_task_files f where f.task_id = task_row.id)
       or exists (select 1 from public.chapter_task_assignments a where a.task_id = task_row.id)
       or exists (select 1 from public.chapter_task_watchers w where w.task_id = task_row.id)
       or exists (
         select 1 from public.chapter_task_dependencies d
         where d.task_id = task_row.id or d.depends_on_id = task_row.id
       )
       or exists (
         select 1 from public.chapter_task_subtasks s
         where s.parent_task_id = task_row.id or s.subtask_id = task_row.id
       )
       or exists (select 1 from public.chapter_task_template_details td where td.task_id = task_row.id) then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    update public.chapter_tasks
       set deleted_at = pg_catalog.now(), deleted_by = actor
     where id = task_row.id;
    update public.organization_automation_effects
       set status = 'rolled_back', rolled_back_at = pg_catalog.now(), rolled_back_by = actor
     where id = effect_row.id;
    rolled_back_count := rolled_back_count + 1;
  end loop;

  final_status := case when skipped_count = 0 then 'rolled_back' else 'rollback_partial' end;
  update public.organization_automation_runs
     set status = final_status,
         effects_rolled_back = effects_rolled_back + rolled_back_count,
         rollback_skipped = rollback_skipped + skipped_count,
         rolled_back_at = pg_catalog.now(),
         rolled_back_by = actor
   where id = run_row.id;

  perform private.cr108_record_audit(
    org, 'automation_run_rolled_back', 'update', 'automation_run',
    run_row.id::text, actor,
    pg_catalog.jsonb_build_object(
      'runId', run_row.id, 'status', final_status,
      'count', rolled_back_count, 'reasonCode', case when skipped_count > 0 then 'human_modified' else null end
    ),
    extensions.gen_random_uuid()
  );

  return pg_catalog.jsonb_build_object(
    'id', run_row.id, 'status', final_status,
    'effectsRolledBack', rolled_back_count, 'rollbackSkipped', skipped_count
  );
end;
end;
$function$;

-- New callable surface is authenticated only. Existing RPC ACLs are preserved
-- by CREATE OR REPLACE; private helpers are never exposed to API roles.
revoke all on function public.mi1_save_automation_definition_v2(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.mi1_save_automation_definition_v2(jsonb) to authenticated;
revoke all on function public.mi1_get_automation_definitions(integer,integer,text,text),public.mi1_get_automation_definition(uuid),public.mi1_get_automation_runs(integer,integer,uuid,text,timestamptz,timestamptz),public.mi1_get_automation_run(uuid,integer,integer),public.mi1_get_automation_scope_options(text,text,text,integer,integer),public.mi1_get_automation_source_context(text,text) from public,anon,authenticated,service_role;
grant execute on function public.mi1_get_automation_definitions(integer,integer,text,text),public.mi1_get_automation_definition(uuid),public.mi1_get_automation_runs(integer,integer,uuid,text,timestamptz,timestamptz),public.mi1_get_automation_run(uuid,integer,integer),public.mi1_get_automation_scope_options(text,text,text,integer,integer),public.mi1_get_automation_source_context(text,text) to authenticated;
revoke all on function private.automation_v2_operator(uuid,uuid),private.automation_v2_source_visible(uuid,uuid,text,text),private.automation_v2_candidates(uuid,boolean),private.automation_v2_validate(uuid,jsonb),private.automation_v2_execute(uuid),private.automation_v2_definition_json(public.organization_automation_definitions),private.automation_v2_run_json(public.organization_automation_runs),private.automation_v2_page_guard(integer,integer),private.automation_v2_rollback_actions(uuid) from public,anon,authenticated,service_role;
create or replace function public.preview_organization_automation_run(p_definition_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  definition_row public.organization_automation_definitions%rowtype;
  run_row public.organization_automation_runs%rowtype;
  candidate_total integer;
  effect_limit integer := 20;
begin
  select d.* into definition_row
  from public.organization_automation_definitions d
  where d.id = p_definition_id
    and d.organization_id = org
    and d.status <> 'archived';
  if definition_row.id is null then
    raise exception 'automation definition unavailable' using errcode = '22023';
  end if;

  select coalesce(s.max_effects_per_run, 20) into effect_limit
  from (select 1) seed
  left join public.organization_automation_settings s
    on s.organization_id = org;

  candidate_total := private.cr108_candidate_count(
    org, definition_row.id, definition_row.trigger_kind, definition_row.threshold_days
  );

  insert into public.organization_automation_runs (
    organization_id, definition_id, definition_version, mode, status,
    candidates_count, effects_skipped, confirmation_phrase, initiated_by,
    completed_at, definition_snapshot
  ) values (
    org, definition_row.id, definition_row.version, 'preview', 'previewed',
    candidate_total, greatest(candidate_total - effect_limit, 0),
    null, actor, pg_catalog.now(), private.automation_v2_definition_json(definition_row)
  ) returning * into run_row;

  run_row.confirmation_phrase := 'RUN ' || pg_catalog.upper(pg_catalog.left(run_row.id::text, 8));
  update public.organization_automation_runs
     set confirmation_phrase = run_row.confirmation_phrase
   where id = run_row.id;

  perform private.cr108_record_audit(
    org, 'automation_run_previewed', 'read', 'automation_run',
    run_row.id::text, actor,
    pg_catalog.jsonb_build_object(
      'runId', run_row.id, 'status', 'previewed',
      'count', candidate_total, 'cadence', definition_row.cadence
    ),
    extensions.gen_random_uuid()
  );

  return pg_catalog.jsonb_build_object(
    'id', run_row.id,
    'definitionId', definition_row.id,
    'definitionName', definition_row.name,
    'mode', 'preview',
    'status', 'previewed',
    'candidatesCount', candidate_total,
    'willCreate', least(candidate_total, effect_limit),
    'effectsSkipped', greatest(candidate_total - effect_limit, 0),
    'confirmationPhrase', run_row.confirmation_phrase,
    'settingsEnabled', coalesce((
      select s.enabled from public.organization_automation_settings s
      where s.organization_id = org
    ), false)
  );
end;
end;
$function$;



-- Exact reviewed additions to the referential-action dependency surface. These
-- are source-bound pins, never a blanket acceptance of the current catalogue.
update private.account_lifecycle_trigger_review set definition_hash='758e6af4274350b85114e660338228b9'
 where kind='function' and schema_name='private' and table_name='' and object_name='enqueue_notification_deliveries()'
 and definition_hash='582cafe475745907bdf0a8b16689355f';
update private.account_lifecycle_trigger_review set definition_hash='75539d3156e2fca79c704d31480ffc09'
 where kind='function' and schema_name='private' and table_name='' and object_name='prepare_chapter_task()'
 and definition_hash='022cd953089db0c8e22aa00cd40cacc4';
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
 values('function','private','','automation_v2_operator(p_actor uuid, p_org uuid)','abda4b1ab51aa93092ba9e3eab8c3c26');
commit;
