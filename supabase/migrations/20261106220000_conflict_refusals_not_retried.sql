-- BUG-UG-STALE-EVENT-SAVE-LOCK-TIMEOUT-20261106 (#7202).
--
-- SQLSTATE 40001 (serialization_failure) tells PostgREST 14 to run the whole
-- transaction again, without limit. A function that raises 40001 to refuse a
-- stale write (the row's version moved, a preview changed) refuses again on
-- every attempt, so the request spins, re-taking the case-graph and
-- message-lifecycle advisory locks thousands of times a second, until one
-- attempt waits past the 3 second message-lifecycle lock timeout and the
-- caller gets HTTP 500 / 55P03 about 30 seconds later. On SAMPLE a stale
-- set_member_event_rsvp_open did exactly that, and
-- the loop outlives the client. 20260929060000 moved the learning-content
-- editors to PT409 for this reason; this does the same for the other
-- 56 functions that refuse with 40001.
--
-- Each function below is its latest migration source, copied verbatim (the
-- file is named above it). The only change is errcode = '40001' ->
-- errcode = 'PT409' on its refusals, which PostgREST
-- answers at once with HTTP 409 and code PT409; message, DETAIL tokens
-- (event_changed, workload_configuration_changed, ...), HINT, signature,
-- owner, grants, settings and comments are unchanged. Clients read PT409 as
-- they read 40001 (isConflictRefusalCode in src/lib/memberApiError.js).
--
-- Kept on 40001, because a retry is the remedy and the condition clears by
-- itself, or because PostgREST cannot reach it:
--   private.lock_message_lifecycle()  a lifecycle reader that cannot yet
--     upgrade to writer while another reader holds the lock; and its
--     read-committed isolation guard.
--   private.lock_case_graph_read(), private.lock_member_message_conversation(uuid)
--     the same read-committed isolation guard (PostgREST runs read committed).
--   public.submit_workload_log(...)  three random receipt-code collisions in
--     a row; a retry draws new codes.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- private.automation_v2_execute(uuid), from 20261003030000_automation_recipe_defaults.sql: 1 refusal
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
 if d.id is null then raise exception 'definition changed' using errcode='PT409'; end if;
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

-- private.learning_undo_case(text, jsonb), from 20261105181500_learning_period_undo_forward_authority.sql: 2 refusals
create or replace function private.learning_undo_case(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target uuid := (p_entry ->> 'target_id')::uuid;
  case_row public.member_cases%rowtype;
  earlier jsonb;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_cases c where c.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_state(target);
  elsif p_mode = 'before' then
    if p_entry ->> 'action_kind' = 'case_create' then return null; end if;
    return private.learning_case_state_from(
      (select v.old_row from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint));
  end if;
  select c.* into case_row from public.member_cases c where c.id = target;
  if p_mode = 'check' then
    -- Today's rule for changing the case: its owner, or staff who can work on it.
    if case_row.id is null or not private.mfa_satisfied() or not (
        (case_row.user_id = caller and private.chapter_case_readable(case_row))
        or private.casework_staff_can_access(case_row.id)
        -- Whoever opened the case at intake may undo that, under the same
        -- intake rule open_member_case applies, assigned or not.
        or (p_entry ->> 'action_kind' = 'case_create' and (
          private.chapter_case_intake_role_allows(case_row.user_id, 'steward')
          or private.chapter_case_intake_role_allows(case_row.user_id, 'coordinator')
          or private.chapter_case_intake_role_allows(case_row.user_id, 'admin')))) then
      raise exception 'you can no longer change this case' using errcode = '42501';
    end if;
    -- A step this edit moved cannot go back by hand once a procedure governs
    -- the case: the procedure's own transition is the only way to move it.
    -- The step is the one the newer undos in this chain leave (projected).
    if p_entry ->> 'action_kind' = 'case_edit'
       and coalesce(p_entry -> 'projected_state' ->> 'step', case_row.step) is distinct from (select v.old_row ->> 'step' from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint)
       and private.casework_resolve_procedure(case_row.organization_id, case_row.chapter_id, case_row.case_type) is not null
       -- A step the caller's own transition moved goes back by the reverse
       -- transition (20261104123000); any other step change still does not.
       and not exists (select 1 from public.casework_step_transitions st
         where st.case_id = target and st.to_step = coalesce(p_entry -> 'projected_state' ->> 'step', case_row.step) and st.transitioned_by = caller
           and st.from_step = (select v.old_row ->> 'step' from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint)) then
      raise exception 'this case now follows a procedure; move its step there' using errcode = '55000';
    end if;
    -- Opening a case is undone only while nobody else has worked on it:
    -- no one else's note, contact, file, outcome, audited action or change
    -- in its history.
    if p_entry ->> 'action_kind' = 'case_create' and (
        exists (select 1 from public.member_case_updates u
          where u.case_id = target and u.learning_undone_at is null and u.author_user_id is distinct from caller)
        or exists (select 1 from public.member_case_files f
          where f.case_id = target and f.removal_requested_at is null and f.uploaded_by is distinct from caller)
        or exists (select 1 from public.member_case_outcomes o where o.case_id = target and o.recorded_by is distinct from caller)
        or exists (select 1 from public.member_case_contacts k where k.case_id = target and k.coordinator_id is distinct from caller)
        or exists (select 1 from public.coordinator_case_audit a where a.case_id = target and a.actor_id is distinct from caller)
        -- A President's review and a steward's identity-privacy decision
        -- leave no case history row, so they are checked here (#7000 r2s2, r2g1).
        or exists (select 1 from public.member_vp_case_reviews r where r.case_id = target and r.reviewed_by is distinct from caller)
        -- An administrator's Action Lab action on the case (#7000 r3s3).
        or exists (select 1 from public.organization_object_action_runs a
          where a.target_kind = 'member_case' and a.target_id = target and a.actor_user_id is distinct from caller)
        or exists (select 1 from public.member_admin_audit a
          where a.action = 'grievance_identity_visibility_updated' and a.detail ->> 'caseId' = target::text
            and a.actor is distinct from caller)
        or exists (select 1 from private.casework_record_versions v
          where v.case_id = target and v.actor is not null and v.actor is distinct from caller)) then
      raise exception 'someone else has changed this since' using errcode = 'PT409';
    end if;
    -- Conversion also changed a staff-managed report. Changing the task or
    -- case alone is insufficient: recheck convert_member_intake_report's
    -- current role and same-chapter readable-profile predicate before any
    -- restoring write. An ordinary creation carries no report image.
    if p_entry -> 'before_image' -> 'intake_report' ->> 'id' is not null
       and (not public.member_has_role(array['steward', 'coordinator'])
         or not exists (
           select 1 from public.member_intake_reports r
           join public.member_profiles p on p.id = caller
           where r.id = (p_entry -> 'before_image' -> 'intake_report' ->> 'id')::uuid
             and p.chapter_id = r.chapter_id)) then
      raise exception 'intake staff role required' using errcode = '42501';
    end if;
    if p_entry ->> 'action_kind' = 'case_create' then
      -- Ordinary staff intake uses open_member_case's current predicate.
      -- Conversion, import and approved forms have their own gates instead;
      -- none acquires an unrelated intake requirement from this handler.
      if p_entry -> 'before_image' -> 'intake_report' ->> 'id' is null
         and not exists (select 1 from public.member_forms f where f.case_id = target)
         and not exists (select 1 from private.learning_action_journal j
           where j.id = (p_entry ->> 'parent_entry_id')::uuid and j.action_kind = 'case_operations_import')
         and case_row.user_id is distinct from caller
         and not (private.chapter_case_intake_role_allows(case_row.user_id, 'steward')
           or private.chapter_case_intake_role_allows(case_row.user_id, 'coordinator')
           or private.chapter_case_intake_role_allows(case_row.user_id, 'admin')) then
        raise exception 'case intake authority required' using errcode = '42501';
      end if;
      -- Freeing an approved form is open_form_as_case's steward-only action,
      -- even when an admin or coordinator could otherwise open a case.
      -- Evaluate the unlinked form the forward writer saw, without changing
      -- its stored row: linked-case readability is not form-opening authority.
      if exists (select 1 from public.member_forms f where f.case_id = target)
         and (not public.member_has_role(array['steward']) or exists (
           select 1 from public.member_forms f where f.case_id = target
             and (f.user_id = caller or not private.member_form_scope_and_identity_allowed(
                 pg_catalog.jsonb_populate_record(f, '{"case_id": null}'::jsonb))
               or not public.staff_can_see_user(f.user_id, 'steward')))) then
        raise exception 'steward role and form scope required' using errcode = '42501';
      end if;
      -- Import children retain the parent's provenance. A broad case role
      -- must not stand in for the import writer's current organization admin.
      if exists (select 1 from private.learning_action_journal j
           where j.id = (p_entry ->> 'parent_entry_id')::uuid and j.action_kind = 'case_operations_import')
         and private.require_member_operations_admin() is distinct from case_row.organization_id then
        raise exception 'admin role required' using errcode = '42501';
      end if;
    end if;
    -- A report the record was converted from must still stand as conversion
    -- left it; anyone's later triage refuses the undo.
    if not private.learning_intake_report_unchanged(p_entry -> 'before_image' -> 'intake_report') then
      raise exception 'someone else has changed this since' using errcode = 'PT409';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if p_entry ->> 'action_kind' = 'case_create' then
    update public.member_cases c set learning_undone_at = pg_catalog.clock_timestamp()
    where c.id = target and c.learning_undone_at is null;
    -- A form the case was opened from can be opened as a case again.
    update public.member_forms f set case_id = null, updated_at = pg_catalog.now() where f.case_id = target;
    -- An intake report converted into the case goes back to how it stood.
    perform private.learning_restore_intake_report(p_entry -> 'before_image' -> 'intake_report');
    return null;
  end if;
  earlier := private.learning_case_state_from(
    (select v.old_row from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint));
  if earlier is null then
    raise exception 'this practice action can no longer be undone' using errcode = '55000';
  end if;
  update public.member_cases c
  set title = earlier ->> 'title', deadline = (earlier ->> 'deadline')::date, case_type = earlier ->> 'case_type',
      articles = earlier ->> 'articles', status = earlier ->> 'status', description = earlier ->> 'description',
      filing_status = earlier ->> 'filing_status', incident_date = (earlier ->> 'incident_date')::date,
      remedy_sought = earlier ->> 'remedy_sought'
  where c.id = target;
  -- The step guard fires only on a real change; a step the edit did not
  -- move is left alone.
  if case_row.step is distinct from earlier ->> 'step' then
    if private.casework_resolve_procedure(case_row.organization_id, case_row.chapter_id, case_row.case_type) is not null then
      perform private.learning_reverse_transition(target, case_row.step, earlier ->> 'step');
    end if;
    update public.member_cases c set step = earlier ->> 'step' where c.id = target;
  end if;
  return null;
end;
end;
$function$;

-- private.learning_undo_case_access(text, jsonb), from 20261104120000_learning_period_case_access_assignment.sql: 3 refusals
create or replace function private.learning_undo_case_access(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target_case uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 1)::uuid;
  grantee uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 2)::uuid;
  image jsonb := p_entry -> 'before_image';
  case_row public.member_cases%rowtype;
  changed public.casework_access_grants%rowtype;
begin
  if p_mode = 'lock' then
    -- Case before grant, as casework_revoke_access takes them.
    perform 1 from public.member_cases c where c.id = target_case for update;
    perform 1 from public.casework_access_grants g
    where g.case_id = target_case and g.grantee_user_id = grantee
    order by g.id for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_access_state(target_case, grantee);
  elsif p_mode = 'before' then
    return pg_catalog.jsonb_build_object('active_grant_id', image -> 'active_grant_id');
  end if;

  select c.* into case_row from public.member_cases c where c.id = target_case;
  if p_mode = 'check' then
    if case_row.id is null or case_row.organization_id is distinct from (p_entry ->> 'organization_id')::uuid
       or not private.mfa_satisfied() or not private.casework_may_manage_case_access(case_row.id) then
      raise exception 'you can no longer change who can see this case' using errcode = '42501';
    end if;
    -- Someone else granted or revoked this access since, even through a path
    -- no learning period journals (and even back to the same state): their
    -- decision stands.
    if exists (
      select 1 from public.casework_audit_events a
      where a.case_id = target_case and a.event_type in ('access_granted', 'access_revoked')
        and a.metadata ->> 'granteeUserId' = grantee::text
        and a.id > coalesce((image ->> 'audit_floor')::bigint, 0)
        and a.actor_user_id is distinct from caller
    ) then
      raise exception 'someone else has changed this since' using errcode = 'PT409';
    end if;
    -- Giving access back is a new grant, made only to someone you could
    -- grant it to today.
    if p_entry ->> 'action_kind' = 'case_access_revoke' then
      perform private.casework_require_case_access_grantee(case_row.id, grantee);
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if p_entry ->> 'action_kind' = 'case_access_grant' then
    update public.casework_access_grants g set revoked_at = pg_catalog.now(), revoked_by = caller
    where g.case_id = target_case and g.grantee_user_id = grantee and g.revoked_at is null
    returning g.* into changed;
    if changed.id is not null then
      insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
      values (changed.organization_id, changed.chapter_id, changed.case_id, caller, 'access_revoked', 'casework_access_grant', changed.id,
        pg_catalog.jsonb_build_object('granteeUserId', changed.grantee_user_id));
    end if;
    -- The grant may be what lets you into a restricted case: an undo that
    -- would leave you unable to reach it (and so unable to lift or undo its
    -- restriction) is refused, as the assignment undo refuses. Undo the
    -- restriction first.
    if private.casework_access_revoke_locks_out(target_case) then
      raise exception 'undoing this would remove your own access to this restricted case' using errcode = '22023', detail = 'casework_restriction_self_lockout';
    end if;
    return null;
  end if;
  -- Someone already gave the access back: nothing is granted twice.
  if exists (select 1 from public.casework_access_grants g
             where g.case_id = target_case and g.grantee_user_id = grantee and g.revoked_at is null) then
    raise exception 'someone else has changed this since' using errcode = 'PT409';
  end if;
  -- The same grant comes back, so the pair's grant rows are exactly as they
  -- were before the revoke and an earlier grant of yours stays undoable. Its
  -- revoke stays in the access audit rows and in the case history.
  update public.casework_access_grants g set revoked_at = null, revoked_by = null
  where g.id = (image ->> 'active_grant_id')::uuid
    and g.case_id = target_case and g.grantee_user_id = grantee and g.revoked_at is not null
  returning g.* into changed;
  if changed.id is null then
    raise exception 'this has changed since your practice action' using errcode = 'PT409';
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (changed.organization_id, changed.chapter_id, changed.case_id, caller, 'access_granted', 'casework_access_grant', changed.id,
    pg_catalog.jsonb_build_object('granteeUserId', changed.grantee_user_id));
  return null;
end;
end;
$function$;

-- private.learning_undo_case_assignment(text, jsonb), from 20261105181500_learning_period_undo_forward_authority.sql: 1 refusal
create or replace function private.learning_undo_case_assignment(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  restored_steward uuid := (p_entry -> 'before_image' ->> 'steward_user_id')::uuid;
  restored_coordinator uuid := (p_entry -> 'before_image' ->> 'coordinator_user_id')::uuid;
  case_row public.member_cases%rowtype;
  restored_row public.member_cases%rowtype;
  case_chapter text;
  steward_label text;
  coordinator_label text;
  actor_label text;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_cases c where c.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_assignment_state(target);
  elsif p_mode = 'before' then
    return pg_catalog.jsonb_build_object(
      'steward_user_id', image -> 'steward_user_id', 'coordinator_user_id', image -> 'coordinator_user_id');
  end if;

  select c.* into case_row from public.member_cases c where c.id = target;
  select p.chapter_id into case_chapter from public.member_profiles p where p.id = case_row.user_id;
  if p_mode = 'check' then
    -- Checks precede every apply. Newer entries in this chain may already
    -- have projected a different assignment; use that state for authority
    -- and unchanged-assignee comparisons, never the still-live assignment.
    case_row := pg_catalog.jsonb_populate_record(case_row,
      coalesce(nullif(p_entry -> 'projected_state', 'null'::jsonb), '{}'::jsonb));
    if case_row.id is null or case_row.organization_id is distinct from (p_entry ->> 'organization_id')::uuid
       or not private.mfa_satisfied() then
      raise exception 'you can no longer change who is assigned to this case' using errcode = '42501';
    end if;
    -- Someone else changed the assignment since, even through a path no
    -- learning period journals: their decision stands.
    if exists (
      select 1 from public.member_case_assignment_audit a
      where a.case_id = target and a.id > coalesce((image ->> 'audit_floor')::bigint, 0)
        and a.actor_id is distinct from caller
    ) then
      raise exception 'someone else has changed this since' using errcode = 'PT409';
    end if;
    if p_entry ->> 'action_kind' = 'case_claim' then
      -- Recheck claim_member_case's current steward authority and scope.
      -- Keeping membership after losing that role is insufficient.
      if not public.member_has_role(array['steward'])
         or case_row.organization_id is distinct from private.current_member_organization()
         or not (private.has_organization_role(case_row.organization_id, array['steward'])
           or private.member_has_chapter_role(case_row.chapter_id, array['steward'])
           or private.chapter_scoped_role_allows(case_row.chapter_id, 'steward', case_row.user_id, true))
         or not private.chapter_case_intake_role_allows(case_row.user_id, 'steward')
         or private.chapter_case_readable(case_row) is not true then
        raise exception 'you can no longer change who is assigned to this case' using errcode = '42501';
      end if;
      return null;
    end if;
    -- Today's rule for assigning this case (assign_member_case) ...
    if not public.member_has_role(array['coordinator', 'admin'])
       or not public.staff_can_see_user(case_row.user_id, 'coordinator')
       or not private.chapter_case_staff_readable(case_row) then
      raise exception 'you can no longer change who is assigned to this case' using errcode = '42501';
    end if;
    -- ... and for each person put back: they must still hold the role in the
    -- case's scope, as assign_member_case requires of anyone it names.
    if restored_steward is not null and restored_steward is distinct from case_row.steward_user_id
       and not exists (
         select 1 from public.member_roles r
         where r.user_id = restored_steward and r.role = 'steward'
           and (r.chapter_id is null or r.chapter_id = case_chapter)
           and private.actor_role_covers_member(r.user_id, case_chapter, r.role, case_row.user_id, true)) then
      raise exception 'the earlier steward can no longer be assigned to this case' using errcode = '42501';
    end if;
    if restored_coordinator is not null and restored_coordinator is distinct from case_row.coordinator_user_id
       and not exists (
         select 1 from public.member_roles r
         where r.user_id = restored_coordinator and r.role = 'coordinator'
           and (r.chapter_id is null or r.chapter_id = case_chapter)
           and private.actor_role_covers_member(r.user_id, case_chapter, r.role, case_row.user_id, true)) then
      raise exception 'the earlier coordinator can no longer be assigned to this case' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  steward_label := case
    when restored_steward is null then null
    when restored_steward = case_row.steward_user_id then case_row.steward_name
    else (select p.full_name from public.member_profiles p where p.id = restored_steward) end;
  coordinator_label := case
    when restored_coordinator is null then null
    when restored_coordinator = case_row.coordinator_user_id then case_row.coordinator_name
    else (select p.full_name from public.member_profiles p where p.id = restored_coordinator) end;
  update public.member_cases set
    steward_user_id = restored_steward, steward_name = steward_label,
    coordinator_user_id = restored_coordinator, coordinator_name = coordinator_label,
    assigned_at = case when restored_steward is null and restored_coordinator is null then null
      else coalesce((image ->> 'assigned_at')::timestamptz, pg_catalog.now()) end
  where id = target returning * into restored_row;
  -- On a restricted case the assignment may be what lets you in: an undo
  -- that would leave you unable to reach it (and so unable to lift or undo
  -- its restriction) is refused, as casework_set_restriction refuses a
  -- restriction that locks you out. Undo the restriction first.
  if restored_row.is_restricted
     and (not private.casework_staff_can_access(target) or private.member_case_row_visible(restored_row) is not true) then
    raise exception 'undoing this would remove your own access to this restricted case' using errcode = '22023', detail = 'casework_restriction_self_lockout';
  end if;
  actor_label := coalesce((select p.full_name from public.member_profiles p where p.id = caller), 'Staff member');
  insert into public.member_case_assignment_audit
    (case_id, actor_id, actor_name, before_assignment, after_assignment)
  values (target, caller, actor_label,
    pg_catalog.jsonb_build_object(
      'stewardUserId', case_row.steward_user_id, 'stewardName', case_row.steward_name,
      'coordinatorUserId', case_row.coordinator_user_id, 'coordinatorName', case_row.coordinator_name),
    pg_catalog.jsonb_build_object(
      'stewardUserId', restored_steward, 'stewardName', steward_label,
      'coordinatorUserId', restored_coordinator, 'coordinatorName', coordinator_label));
  return null;
end;
end;
$function$;

-- private.learning_undo_case_restriction(text, jsonb), from 20261104120000_learning_period_case_access_assignment.sql: 1 refusal
create or replace function private.learning_undo_case_restriction(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  target uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  case_row public.member_cases%rowtype;
  restored_by uuid := (p_entry -> 'before_image' ->> 'restricted_by')::uuid;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_cases c where c.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_restriction_state(target);
  elsif p_mode = 'before' then
    return pg_catalog.jsonb_build_object(
      'is_restricted', image -> 'is_restricted', 'restriction_reason', image -> 'restriction_reason');
  elsif p_mode = 'check' then
    select c.* into case_row from public.member_cases c where c.id = target;
    if case_row.id is null or case_row.organization_id is distinct from (p_entry ->> 'organization_id')::uuid
       or not private.mfa_satisfied() or not private.casework_staff_can_access(target) then
      raise exception 'you can no longer change this case''s restriction' using errcode = '42501';
    end if;
    -- Someone else changed the restriction since, even through a path no
    -- learning period journals (and even back to the same values): their
    -- decision stands.
    if exists (
      select 1 from public.casework_audit_events a
      where a.case_id = target and a.event_type = 'restriction_changed'
        and a.id > coalesce((image ->> 'audit_floor')::bigint, 0)
        and a.actor_user_id is distinct from (select auth.uid())
    ) then
      raise exception 'someone else has changed this since' using errcode = 'PT409';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  -- A restriction put back names who restricted it. When that account is
  -- gone (detached to null, or deleted since the before-image), the person
  -- restoring it now is the attribution.
  if (image ->> 'is_restricted')::boolean
     and (restored_by is null or not exists (select 1 from auth.users u where u.id = restored_by)) then
    restored_by := (select auth.uid());
  end if;
  update public.member_cases set
    is_restricted = (image ->> 'is_restricted')::boolean,
    restriction_reason = image ->> 'restriction_reason',
    restricted_at = case when (image ->> 'is_restricted')::boolean
      then coalesce((image ->> 'restricted_at')::timestamptz, pg_catalog.now()) end,
    restricted_by = case when (image ->> 'is_restricted')::boolean then restored_by end,
    updated_at = pg_catalog.now()
  where id = target returning * into case_row;
  if case_row.is_restricted
     and (not private.casework_staff_can_access(target) or private.member_case_row_visible(case_row) is not true) then
    raise exception 'restricting this case would remove your own access to it' using errcode = '22023', detail = 'casework_restriction_self_lockout';
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (case_row.organization_id, case_row.chapter_id, case_row.id, (select auth.uid()), 'restriction_changed', 'case', case_row.id,
    pg_catalog.jsonb_build_object('restricted', case_row.is_restricted));
  return null;
end;
end;
$function$;

-- private.learning_undo_casework(text, jsonb), from 20261104123000_learning_period_case_workflow.sql: 1 refusal
create or replace function private.learning_undo_casework(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  t text := pg_catalog.substr(p_entry ->> 'target_table', 8);
  target text := p_entry ->> 'target_id';
  v private.casework_record_versions%rowtype;
  v_row jsonb;
begin
  select r.* into v from private.casework_record_versions r where r.id = (p_entry ->> 'before_ref')::bigint;
  v_row := coalesce(v.new_row, v.old_row);
  if p_mode = 'lock' then
    case t
      when 'casework_step_transitions' then perform 1 from public.casework_step_transitions x where x.id::text = target for update;
      when 'casework_deadlines' then perform 1 from public.casework_deadlines x where x.id::text = target for update;
      when 'casework_deadline_extensions' then perform 1 from public.casework_deadline_extensions x where x.id::text = target for update;
      when 'casework_checklists' then perform 1 from public.casework_checklists x where x.id::text = target for update;
      when 'casework_checklist_items' then perform 1 from public.casework_checklist_items x where x.id::text = target for update;
      when 'casework_reminders' then perform 1 from public.casework_reminders x where x.id::text = target for update;
      when 'casework_intake_drafts' then perform 1 from public.casework_intake_drafts x where x.id::text = target for update;
      when 'casework_strength_analyses' then perform 1 from public.casework_strength_analyses x where x.id::text = target for update;
      else null;
    end case;
    return null;
  elsif p_mode = 'state' then
    return private.learning_casework_row_state(t, target);
  elsif p_mode = 'before' then
    return case when v.old_row is null then null else private.learning_casework_stable(t, v.old_row) end;
  elsif p_mode = 'check' then
    if v.id is null or v.record_table is distinct from t or v.record_id is distinct from target then
      raise exception 'this practice action can no longer be undone' using errcode = '55000';
    end if;
    -- Today's rule of the writer that made the change, per table and
    -- operation: a reminder is its owner's while they can still read the
    -- case; a draft is its writer's while they still hold the drafting role
    -- (and the case it names is in scope); an extension request is its
    -- requester's while they may still request one (the case's member or
    -- staff who can work on it); every other workflow change (steps,
    -- deadlines, decisions, checklists, scores) needs staff who can work on
    -- the case today.
    if not private.mfa_satisfied() or not coalesce(case
         when t = 'casework_reminders' then
           (v_row ->> 'owner_user_id')::uuid = caller and private.casework_can_read((v_row ->> 'case_id')::uuid)
         when t = 'casework_intake_drafts' then
           v.actor = caller
           and private.member_has_chapter_role(v_row ->> 'chapter_id', array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
           and (v_row ->> 'case_id' is null or private.casework_scope_matches((v_row ->> 'case_id')::uuid,
             (v_row ->> 'organization_id')::uuid, v_row ->> 'chapter_id'))
         when v.case_id is null then false
         when t = 'casework_deadline_extensions' and v.op = 'INSERT' then
           v.actor = caller and private.casework_can_read(v.case_id)
           and (private.casework_member_owns(v.case_id) or private.casework_staff_can_access(v.case_id))
         else private.casework_staff_can_access(v.case_id)
       end, false) then
      raise exception 'you can no longer change this case' using errcode = '42501';
    end if;
    -- Taking away a deadline someone asked to extend would detach the request.
    if v.op = 'INSERT' and t = 'casework_deadlines'
       and exists (select 1 from public.casework_deadline_extensions e where e.deadline_id::text = target) then
      raise exception 'this has changed since your practice action' using errcode = 'PT409';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if v.op = 'INSERT' then
    if t = 'casework_step_transitions' then
      perform private.learning_reverse_transition((v.new_row ->> 'case_id')::uuid, v.new_row ->> 'to_step', v.new_row ->> 'from_step');
    else
      case t
        when 'casework_deadlines' then delete from public.casework_deadlines x where x.id::text = target;
        when 'casework_deadline_extensions' then delete from public.casework_deadline_extensions x where x.id::text = target;
        when 'casework_checklists' then delete from public.casework_checklists x where x.id::text = target;
        when 'casework_checklist_items' then delete from public.casework_checklist_items x where x.id::text = target;
        when 'casework_reminders' then delete from public.casework_reminders x where x.id::text = target;
        when 'casework_intake_drafts' then delete from public.casework_intake_drafts x where x.id::text = target;
        when 'casework_strength_analyses' then delete from public.casework_strength_analyses x where x.id::text = target;
        else null;
      end case;
    end if;
  elsif v.op = 'UPDATE' then
    case t
        when 'casework_step_transitions' then update public.casework_step_transitions x set (case_id, organization_id, chapter_id, from_step, to_step, outcome, transitioned_by, idempotency_key, created_at, procedure_transaction_id) =
          (select r.case_id, r.organization_id, r.chapter_id, r.from_step, r.to_step, r.outcome, r.transitioned_by, r.idempotency_key, r.created_at, r.procedure_transaction_id from pg_catalog.jsonb_populate_record(null::public.casework_step_transitions, v.old_row) r)
          where x.id::text = target;
        when 'casework_deadlines' then update public.casework_deadlines x set (case_id, organization_id, chapter_id, kind, label, due_at, status, reminder_at, created_by, created_at, updated_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.kind, r.label, r.due_at, r.status, r.reminder_at, r.created_by, r.created_at, r.updated_at from pg_catalog.jsonb_populate_record(null::public.casework_deadlines, v.old_row) r)
          where x.id::text = target;
        when 'casework_deadline_extensions' then update public.casework_deadline_extensions x set (deadline_id, organization_id, requested_by, previous_due_at, requested_due_at, reason, status, decided_by, decided_at, decision_note, idempotency_key, created_at) =
          (select r.deadline_id, r.organization_id, r.requested_by, r.previous_due_at, r.requested_due_at, r.reason, r.status, r.decided_by, r.decided_at, r.decision_note, r.idempotency_key, r.created_at from pg_catalog.jsonb_populate_record(null::public.casework_deadline_extensions, v.old_row) r)
          where x.id::text = target;
        when 'casework_checklists' then update public.casework_checklists x set (case_id, organization_id, chapter_id, template_id, step, title, created_by, created_at, completed_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.template_id, r.step, r.title, r.created_by, r.created_at, r.completed_at from pg_catalog.jsonb_populate_record(null::public.casework_checklists, v.old_row) r)
          where x.id::text = target;
        when 'casework_checklist_items' then update public.casework_checklist_items x set (checklist_id, organization_id, label, position, required, completed_at, completed_by) =
          (select r.checklist_id, r.organization_id, r.label, r.position, r.required, r.completed_at, r.completed_by from pg_catalog.jsonb_populate_record(null::public.casework_checklist_items, v.old_row) r)
          where x.id::text = target;
        when 'casework_reminders' then update public.casework_reminders x set (case_id, organization_id, chapter_id, owner_user_id, title, remind_at, recurrence, status, completed_at, created_at, updated_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.owner_user_id, r.title, r.remind_at, r.recurrence, r.status, r.completed_at, r.created_at, r.updated_at from pg_catalog.jsonb_populate_record(null::public.casework_reminders, v.old_row) r)
          where x.id::text = target;
        when 'casework_intake_drafts' then update public.casework_intake_drafts x set (organization_id, chapter_id, owner_user_id, member_user_id, case_id, payload, revision, created_at, updated_at) =
          (select r.organization_id, r.chapter_id, r.owner_user_id, r.member_user_id, r.case_id, r.payload, r.revision, r.created_at, r.updated_at from pg_catalog.jsonb_populate_record(null::public.casework_intake_drafts, v.old_row) r)
          where x.id::text = target;
        when 'casework_strength_analyses' then update public.casework_strength_analyses x set (case_id, organization_id, chapter_id, analyzed_by, inputs, score, band, recommendations, idempotency_key, created_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.analyzed_by, r.inputs, r.score, r.band, r.recommendations, r.idempotency_key, r.created_at from pg_catalog.jsonb_populate_record(null::public.casework_strength_analyses, v.old_row) r)
          where x.id::text = target;
      else null;
    end case;
  else
    case t
        when 'casework_step_transitions' then insert into public.casework_step_transitions select * from pg_catalog.jsonb_populate_record(null::public.casework_step_transitions, v.old_row);
        when 'casework_deadlines' then insert into public.casework_deadlines select * from pg_catalog.jsonb_populate_record(null::public.casework_deadlines, v.old_row);
        when 'casework_deadline_extensions' then insert into public.casework_deadline_extensions select * from pg_catalog.jsonb_populate_record(null::public.casework_deadline_extensions, v.old_row);
        when 'casework_checklists' then insert into public.casework_checklists select * from pg_catalog.jsonb_populate_record(null::public.casework_checklists, v.old_row);
        when 'casework_checklist_items' then insert into public.casework_checklist_items select * from pg_catalog.jsonb_populate_record(null::public.casework_checklist_items, v.old_row);
        when 'casework_reminders' then insert into public.casework_reminders select * from pg_catalog.jsonb_populate_record(null::public.casework_reminders, v.old_row);
        when 'casework_intake_drafts' then insert into public.casework_intake_drafts select * from pg_catalog.jsonb_populate_record(null::public.casework_intake_drafts, v.old_row);
        when 'casework_strength_analyses' then insert into public.casework_strength_analyses select * from pg_catalog.jsonb_populate_record(null::public.casework_strength_analyses, v.old_row);
      else null;
    end case;
  end if;
  return null;
end;
end;
$function$;

-- private.learning_undo_invitation_revoke(text, jsonb), from 20261106121000_learning_undo_invitation_revoke_recovered_address.sql: 2 refusals
create or replace function private.learning_undo_invitation_revoke(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  invitation_row public.member_invitations%rowtype;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_invitations i where i.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_invitation_state(target);
  elsif p_mode = 'before' then
    return image;
  elsif p_mode = 'check' then
    select i.* into invitation_row from public.member_invitations i where i.id = target;
    if invitation_row.id is null
       or not (private.member_invitation_chapter_administrable(invitation_row.chapter_id)
               or (invitation_row.initial_role is null and invitation_row.kind = 'provision'
                   and private.member_invitation_chapter_presided(invitation_row.chapter_id))) then
      raise exception 'you can no longer manage this invitation' using errcode = '42501';
    end if;
    if invitation_row.learning_revoke_held_at is null
       or (image ->> 'status' = 'pending' and (invitation_row.token_hash is null
           or invitation_row.expires_at <= pg_catalog.clock_timestamp())) then
      raise exception 'this invitation link has expired' using errcode = '55000';
    end if;
    -- Nobody may have become this person since the invitation was sent: no
    -- account owns the address and no invitation to it was accepted or is
    -- being accepted. (A former member's account predates their
    -- reactivation invitation and does not count; any account owning a
    -- provision invitation's address does, however it got the address.)
    if invitation_row.auth_user_id is not null or exists (
      select 1 from auth.users u
      where pg_catalog.lower(u.email) = invitation_row.normalized_email
        and (invitation_row.kind = 'provision' or u.created_at >= invitation_row.created_at)
    ) or exists (
      select 1 from public.member_invitations other
      where other.normalized_email = invitation_row.normalized_email and other.id <> invitation_row.id
        and (other.status = 'accepting' or (other.status = 'accepted' and other.accepted_at >= invitation_row.created_at))
    ) then
      raise exception 'this person has joined since; send a new invitation instead' using errcode = 'PT409';
    end if;
    if image ->> 'status' = 'pending' and exists (
      select 1 from public.member_invitations other
      where other.normalized_email = invitation_row.normalized_email and other.id <> invitation_row.id
        and other.status in ('pending', 'accepting')
    ) then
      raise exception 'a newer invitation to this person is already open' using errcode = 'PT409';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  update public.member_invitations i
  set status = image ->> 'status',
      revoked_at = null,
      failure_code = image ->> 'failure_code',
      -- Only a pending invitation has a working link; any other earlier state
      -- carries no token, exactly as before the revoke.
      token_hash = case when image ->> 'status' = 'pending' then i.token_hash end,
      learning_revoke_held_at = null
  where i.id = target and i.status = 'revoked' and i.learning_revoke_held_at is not null
  returning i.* into invitation_row;
  perform private.audit_member_invitation(
    invitation_row.id, invitation_row.chapter_id, caller, 'invite_restored',
    pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
      'deliveryVersion', invitation_row.delivery_version));
  return null;
end;
end;
$function$;

-- private.learning_undo_message_mark(text, jsonb), from 20261104111500_learning_period_messages_notices_invites_exports.sql: 1 refusal
create or replace function private.learning_undo_message_mark(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target_table text := p_entry ->> 'target_table';
  target uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  creation boolean := p_entry ->> 'action_kind' in ('message_react', 'message_save');
  owner uuid;
begin
  if target_table not in ('public.member_message_reactions', 'public.member_saved_messages') then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if p_mode = 'lock' then
    if target_table = 'public.member_message_reactions' then
      perform 1 from public.member_message_reactions r where r.id = target for update;
    else
      perform 1 from public.member_saved_messages s where s.id = target for update;
    end if;
    return null;
  elsif p_mode = 'state' then
    return private.learning_message_mark_state(target_table, target);
  elsif p_mode = 'before' then
    if creation then return '{"live": false}'::jsonb; end if;
    return image;
  elsif p_mode = 'check' then
    -- Only your own mark, and putting one back needs the message to be one
    -- you can still read, with no equal mark already there.
    if creation then
      owner := (p_entry -> 'projected_state' ->> case when target_table = 'public.member_message_reactions' then 'actor_id' else 'owner_id' end)::uuid;
      if owner is distinct from caller then
        raise exception 'this is no longer yours to change' using errcode = '42501';
      end if;
      return null;
    end if;
    owner := (image ->> case when target_table = 'public.member_message_reactions' then 'actor_id' else 'owner_id' end)::uuid;
    if owner is distinct from caller
       or not private.can_read_message_source(caller, image ->> 'source_kind',
         (image ->> 'private_message_id')::uuid, (image ->> 'channel_post_id')::uuid, (image ->> 'task_message_id')::uuid) then
      raise exception 'this message is no longer available' using errcode = '42501';
    end if;
    if (target_table = 'public.member_message_reactions' and exists (
          select 1 from public.member_message_reactions r
          where r.actor_id = caller and r.source_kind = image ->> 'source_kind' and r.reaction = image ->> 'reaction'
            and coalesce(r.private_message_id, r.channel_post_id, r.task_message_id)
              = coalesce((image ->> 'private_message_id')::uuid, (image ->> 'channel_post_id')::uuid, (image ->> 'task_message_id')::uuid)))
       or (target_table = 'public.member_saved_messages' and exists (
          select 1 from public.member_saved_messages s
          where s.owner_id = caller and s.source_kind = image ->> 'source_kind'
            and coalesce(s.private_message_id, s.channel_post_id, s.task_message_id)
              = coalesce((image ->> 'private_message_id')::uuid, (image ->> 'channel_post_id')::uuid, (image ->> 'task_message_id')::uuid))) then
      raise exception 'this is already back' using errcode = 'PT409';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if creation then
    if target_table = 'public.member_message_reactions' then
      delete from public.member_message_reactions r where r.id = target and r.actor_id = caller;
    else
      delete from public.member_saved_messages s where s.id = target and s.owner_id = caller;
    end if;
  elsif target_table = 'public.member_message_reactions' then
    insert into public.member_message_reactions (id, actor_id, source_kind, private_message_id, channel_post_id, task_message_id, reaction)
    values (target, caller, image ->> 'source_kind', (image ->> 'private_message_id')::uuid,
      (image ->> 'channel_post_id')::uuid, (image ->> 'task_message_id')::uuid, image ->> 'reaction');
  else
    insert into public.member_saved_messages (id, owner_id, source_kind, private_message_id, channel_post_id, task_message_id, saved_at)
    values (target, caller, image ->> 'source_kind', (image ->> 'private_message_id')::uuid,
      (image ->> 'channel_post_id')::uuid, (image ->> 'task_message_id')::uuid, (image ->> 'saved_at')::timestamptz);
  end if;
  return null;
end;
end;
$function$;

-- private.learning_undo_task(text, jsonb), from 20261105181500_learning_period_undo_forward_authority.sql: 2 refusals
create or replace function private.learning_undo_task(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  task_row public.chapter_tasks%rowtype;
  wanted uuid[];
  current_ids uuid[];
  was_live boolean;
  caller_name text;
  recipient uuid;
begin
  if p_mode = 'lock' then
    perform 1 from public.chapter_tasks t where t.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_task_state(target) - 'order_index';
  elsif p_mode = 'before' then
    if p_entry ->> 'action_kind' = 'task_create' then return null; end if;
    return image - 'order_index';
  elsif p_mode = 'check' then
    -- Today's rule for changing a task: staff of the task's own chapter.
    select t.* into task_row
    from public.chapter_tasks t
    join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
    where t.id = target;
    if task_row.id is null or not private.member_has_chapter_role(task_row.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
      raise exception 'you can no longer change this task' using errcode = '42501';
    end if;
    -- Undoing a creation hides the task; refuse when someone else's
    -- check-off work hangs off it, which would be hidden with it.
    if p_entry ->> 'action_kind' = 'task_create' and (
        exists (select 1 from private.task_checkoff_lists l where l.task_id = target and l.created_by is distinct from caller)
        or exists (select 1 from private.task_checkoff_entries e
          where e.task_id = target and e.actioned_by is not null and e.actioned_by is distinct from caller)) then
      raise exception 'someone else has changed this since' using errcode = 'PT409';
    end if;
    -- Conversion also changed a staff-managed report. Changing the task or
    -- case alone is insufficient: recheck convert_member_intake_report's
    -- current role and same-chapter readable-profile predicate before any
    -- restoring write. An ordinary creation carries no report image.
    if p_entry -> 'before_image' -> 'intake_report' ->> 'id' is not null
       and (not public.member_has_role(array['steward', 'coordinator'])
         or not exists (
           select 1 from public.member_intake_reports r
           join public.member_profiles p on p.id = caller
           where r.id = (p_entry -> 'before_image' -> 'intake_report' ->> 'id')::uuid
             and p.chapter_id = r.chapter_id)) then
      raise exception 'intake staff role required' using errcode = '42501';
    end if;
    -- A report the record was converted from must still stand as conversion
    -- left it; anyone's later triage refuses the undo.
    if not private.learning_intake_report_unchanged(p_entry -> 'before_image' -> 'intake_report') then
      raise exception 'someone else has changed this since' using errcode = 'PT409';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  select p.full_name into caller_name from public.member_profiles p where p.id = caller;
  if p_entry ->> 'action_kind' = 'task_create' then
    update public.chapter_tasks t
    set deleted_at = pg_catalog.now(), deleted_by = caller
    where t.id = target and t.deleted_at is null
    returning t.* into task_row;
    -- The task goes away as a deletion does, and its assignee hears so.
    if task_row.assignee_id is not null and task_row.assignee_id <> caller then
      perform private.notify_member(task_row.assignee_id, 'task.deleted',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
    end if;
    -- An intake report converted into the task goes back to how it stood.
    perform private.learning_restore_intake_report(p_entry -> 'before_image' -> 'intake_report');
    return null;
  end if;

  select t.deleted_at is null into was_live from public.chapter_tasks t where t.id = target;

  update public.chapter_tasks t
  set title = image ->> 'title',
      description = image ->> 'description',
      status = image ->> 'status',
      priority = image ->> 'priority',
      workstream = image ->> 'workstream',
      start_date = (image ->> 'start_date')::date,
      due_date = (image ->> 'due_date')::date,
      progress = (image ->> 'progress')::smallint,
      blocked = (image ->> 'blocked')::boolean,
      milestone = (image ->> 'milestone')::boolean,
      task_type = image ->> 'task_type',
      order_index = coalesce((image ->> 'order_index')::integer, t.order_index),
      deleted_at = case when (image ->> 'live')::boolean then null else coalesce(t.deleted_at, pg_catalog.now()) end,
      deleted_by = case when (image ->> 'live')::boolean then null else coalesce(t.deleted_by, caller) end
  where t.id = target
  returning t.* into task_row;

  -- Assignees as they were, in order, the way set_chapter_task_assignees
  -- writes them, and told the way it tells them: the task's own trigger
  -- notifies the primary assignee it gains or loses, and each co-assignee
  -- added or removed hears so here. What was already sent stays sent; each
  -- person's newest notice matches the task again.
  select coalesce(pg_catalog.array_agg(e.id::uuid order by e.position), '{}') into wanted
  from pg_catalog.jsonb_array_elements_text(coalesce(image -> 'assignee_ids', '[]'::jsonb)) with ordinality as e(id, position);
  select coalesce(pg_catalog.array_agg(a.assignee_id order by a.position), '{}') into current_ids
  from public.chapter_task_assignments a where a.task_id = target;
  if wanted is distinct from current_ids then
    delete from public.chapter_task_assignments a where a.task_id = target;
    insert into public.chapter_task_assignments (task_id, chapter_id, assignee_id, position, assigned_by)
    select target, task_row.chapter_id, ids.assignee_id, ids.ordinality - 1, caller
    from pg_catalog.unnest(wanted) with ordinality as ids(assignee_id, ordinality);
  end if;
  if task_row.assignee_id is distinct from wanted[1] then
    perform pg_catalog.set_config('sg.setting_task_assignees', '1', true);
    update public.chapter_tasks t set assignee_id = wanted[1] where t.id = target;
    -- Only this update skips the assignment sync; later writes in the same
    -- undo (or transaction) get it again.
    perform pg_catalog.set_config('sg.setting_task_assignees', '', true);
  end if;
  for recipient in
    select id from pg_catalog.unnest(wanted) id
    where not (id = any(current_ids)) and id is distinct from wanted[1] and id <> caller
  loop
    perform private.notify_member(recipient, 'task.assigned',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end loop;
  for recipient in
    select id from pg_catalog.unnest(current_ids) id
    where not (id = any(wanted)) and id is distinct from task_row.assignee_id and id <> caller
  loop
    perform private.notify_member(recipient, 'task.unassigned',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end loop;
  -- Putting a deleted task back, or taking a restored one away, tells its
  -- assignee the way soft_delete_chapter_task and restore_chapter_task do,
  -- so the last notice they hold matches the task.
  if was_live is distinct from (image ->> 'live')::boolean
     and wanted[1] is not null and wanted[1] <> caller then
    perform private.notify_member(wanted[1],
      case when (image ->> 'live')::boolean then 'task.restored' else 'task.deleted' end,
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end if;
  return null;
end;
end;
$function$;

-- private.stamp_workload_configuration(), from 20261105192000_organization_workload_configuration.sql: 1 refusal
create or replace function private.stamp_workload_configuration()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare org uuid; snapshot jsonb; values_json jsonb; fixed_values jsonb;
begin
  org := private.chapter_units_context();
  if tg_op = 'UPDATE' then
    if new.workload_configuration is distinct from old.workload_configuration then raise exception 'workload snapshot is immutable' using errcode = '22023'; end if;
    if new.workload_configuration is null then return new; end if;
    snapshot := new.workload_configuration;
    values_json := new.workload_values;
    new.sub_details := old.sub_details || new.sub_details;
  else
  -- Pre-tenant compatibility writes remain the original log, with no org
  -- configuration. Configured writes always need a selected membership.
  if org is null then
    if new.sub_details ? 'workloadVersion' then raise exception 'organization membership required' using errcode = '42501'; end if;
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workload-config-' || org::text, 509));
  snapshot := private.workload_configuration_payload(org);
  if coalesce(new.sub_details ->> 'workloadVersion', '0') <> snapshot ->> 'version' then raise exception 'workload configuration changed; reload' using errcode = 'PT409', detail = 'workload_configuration_changed'; end if;
  if new.sub_details ? 'workloadVersion' then
    values_json := new.sub_details -> 'workloadValues';
    new.workload_status := new.sub_details ->> 'workloadStatus';
  else
    values_json := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'priority', new.priority, 'pending', new.pending, 'unread_docs', new.unread_docs, 'todos', new.todos, 'referrals', new.referrals,
      'ce_activities', new.ce_activities, 'assistance_requests', new.assistance_requests, 'aged_cases', new.aged_cases,
      'weeklyAssigned', new.weekly_assigned, 'employment', new.employment, 'ptHours', new.pt_hours,
      'onPlan', new.on_plan, 'otWorked', new.ot_worked, 'otHours', new.ot_hours, 'leaveType', new.leave_type,
      'leaveTiming', new.leave_timing, 'noIntake', new.no_intake, 'halfDay', new.half_day,
      'workedOn', new.sub_details -> 'workedOn', 'hoursWorked', new.sub_details -> 'hoursWorked', 'note', new.note));
    select coalesce(pg_catalog.jsonb_object_agg(e.key, e.value), '{}'::jsonb) into values_json from pg_catalog.jsonb_each(values_json) e
      where exists (select 1 from pg_catalog.jsonb_array_elements(snapshot -> 'definition' -> 'fields') f(value) where f.value ->> 'key' = e.key and (f.value ->> 'visible')::boolean);
    new.workload_status := 'logged';
  end if;
  end if;
  values_json := private.validate_workload_values(snapshot -> 'definition', values_json, new.workload_status, (snapshot ->> 'version')::integer = 0);
  -- One projection covers create/edit and configured transport through the
  -- legacy RPC. It runs after that RPC's legacy normalization, before storage.
  if (snapshot ->> 'version')::integer > 0 or tg_op = 'UPDATE' then
    fixed_values := pg_catalog.jsonb_build_object(
      'priority', values_json -> 'priority', 'pending', values_json -> 'pending',
      'unread_docs', values_json -> 'unread_docs', 'todos', values_json -> 'todos',
      'referrals', values_json -> 'referrals', 'ce_activities', values_json -> 'ce_activities',
      'assistance_requests', values_json -> 'assistance_requests', 'aged_cases', values_json -> 'aged_cases',
      'weekly_assigned', values_json -> 'weeklyAssigned', 'employment', values_json -> 'employment',
      'pt_hours', values_json -> 'ptHours', 'on_plan', values_json -> 'onPlan',
      'ot_worked', values_json -> 'otWorked', 'ot_hours', values_json -> 'otHours',
      'leave_type', values_json -> 'leaveType', 'leave_timing', values_json -> 'leaveTiming',
      'no_intake', values_json -> 'noIntake', 'half_day', values_json -> 'halfDay', 'note', values_json -> 'note');
    if (snapshot ->> 'version')::integer = 0 then
      -- Original hidden measurements keep their stored meaning on legacy edits.
      select coalesce(pg_catalog.jsonb_object_agg(e.key, e.value), '{}'::jsonb) into fixed_values
      from pg_catalog.jsonb_each(fixed_values) e
      where exists (select 1 from pg_catalog.jsonb_array_elements(snapshot -> 'definition' -> 'fields') f(value)
        where (f.value ->> 'visible')::boolean and f.value ->> 'key' = case e.key
          when 'weekly_assigned' then 'weeklyAssigned' when 'pt_hours' then 'ptHours' when 'on_plan' then 'onPlan'
          when 'ot_worked' then 'otWorked' when 'ot_hours' then 'otHours' when 'leave_type' then 'leaveType'
          when 'leave_timing' then 'leaveTiming' when 'no_intake' then 'noIntake' when 'half_day' then 'halfDay' else e.key end);
    end if;
    new := pg_catalog.jsonb_populate_record(new, fixed_values);
  end if;
  new.workload_configuration := snapshot;
  new.workload_values := values_json;
  new.sub_details := new.sub_details || pg_catalog.jsonb_build_object(
    'configuration', snapshot, 'values', values_json, 'status', new.workload_status,
    'workloadVersion', (snapshot ->> 'version')::integer, 'workloadValues', values_json, 'workloadStatus', new.workload_status,
    'workedOn', values_json -> 'workedOn', 'hoursWorked', values_json -> 'hoursWorked');
  return new;
end;
end;
$function$;

-- private.write_organization_setting(text, jsonb, timestamp with time zone, boolean), from 20261104113000_learning_period_membership_roles_settings.sql: 1 refusal
create or replace function private.write_organization_setting(
  p_key text,
  p_value jsonb,
  p_expected_updated_at timestamptz,
  p_check_version boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org_id uuid;
  caller uuid;
  definition public.platform_setting_definitions%rowtype;
  stored public.organization_setting_values%rowtype;
  written public.organization_setting_values%rowtype;
  had_override boolean;
  setting_key_text text;
  before_state jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org_id := private.current_member_organization();
  caller := (select auth.uid());
  if org_id is null or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select * into definition from public.platform_setting_definitions where key = p_key;
  if found and not definition.organization_editable then
    raise exception 'setting is set for the whole platform' using errcode = '42501';
  end if;
  if not found or (p_value is not null and not private.setting_value_valid(
    definition.value_kind, p_value, definition.minimum, definition.maximum, definition.allowed_values
  )) then
    raise exception 'invalid setting value' using errcode = '22023';
  end if;

  select * into stored
  from public.organization_setting_values
  where organization_id = org_id and setting_key = p_key
  for update;
  had_override := found;
  setting_key_text := org_id::text || ':' || p_key;
  before_state := private.learning_membership_state('public.organization_setting_values', setting_key_text);
  if p_check_version and (case when had_override then stored.updated_at else null end) is distinct from p_expected_updated_at then
    raise exception 'setting changed' using errcode = 'PT409';
  end if;

  -- clock_timestamp(), not the transaction start: two changes in one
  -- transaction keep distinct, ordered version tokens and audit times.
  if p_value is null then
    delete from public.organization_setting_values
    where organization_id = org_id and setting_key = p_key;
    insert into public.organization_configuration_audit
      (organization_id, actor_user_id, action, item_key, previous_value, new_value, created_at)
    values (org_id, caller, 'setting_reset', p_key,
      case when had_override then stored.value else definition.default_value end,
      definition.default_value, pg_catalog.clock_timestamp());
    if not private.learning_setting_excluded(p_key) then
      perform private.learning_membership_journal('organization_setting_reset', 'public.organization_setting_values', setting_key_text, before_state);
    end if;
    return pg_catalog.jsonb_build_object('key', p_key, 'value', definition.default_value,
      'overridden', false, 'updatedAt', null, 'updated', true);
  end if;

  insert into public.organization_setting_values (organization_id, setting_key, value, updated_by, updated_at)
  values (org_id, p_key, p_value, caller, pg_catalog.clock_timestamp())
  on conflict (organization_id, setting_key) do update
    set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning * into written;
  insert into public.organization_configuration_audit
    (organization_id, actor_user_id, action, item_key, previous_value, new_value, created_at)
  values (org_id, caller, 'setting_updated', p_key,
    case when had_override then stored.value else definition.default_value end,
    p_value, pg_catalog.clock_timestamp());
  if not private.learning_setting_excluded(p_key) then
    perform private.learning_membership_journal('organization_setting_change', 'public.organization_setting_values', setting_key_text, before_state);
  end if;
  return pg_catalog.jsonb_build_object('key', p_key, 'value', p_value,
    'overridden', true, 'updatedAt', written.updated_at, 'updated', true);
end;
$function$;

-- public.accept_member_qa_answer(uuid, uuid, boolean, timestamp with time zone): 1 refusal. The installed body (pg_get_functiondef), because a later
-- migration rewrote the body 20260826157000_mi1_fable_review_repairs.sql created in place.
CREATE OR REPLACE FUNCTION public.accept_member_qa_answer(p_question_id uuid, p_reply_id uuid, p_accepted boolean, p_expected_updated_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_require_selected_organization();
  question public.member_qa_questions%rowtype;
  reply public.member_qa_replies%rowtype;
  desired boolean := coalesce(p_accepted, false);
  was_accepted boolean;
  next_status text;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  select * into question from public.member_qa_questions
  where id = p_question_id and deleted_at is null for update;
  select * into reply from public.member_qa_replies where id = p_reply_id and deleted_at is null;
  if question.id is null or reply.id is null or question.organization_id is distinct from org
     or reply.organization_id is distinct from org or reply.question_id is distinct from question.id then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_expected_updated_at is null or question.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale question; reload required' using errcode = 'PT409';
  end if;
  if reply.kind is distinct from 'official' then
    raise exception 'only official replies can be accepted' using errcode = '22023';
  end if;
  if question.author_user_id is distinct from (select auth.uid())
     and not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  was_accepted := question.accepted_reply_id is not distinct from reply.id;
  if desired then
    update public.member_qa_replies set accepted = (id = reply.id), updated_at = pg_catalog.now()
    where question_id = question.id and accepted is distinct from (id = reply.id);
    update public.member_qa_questions
    set accepted_reply_id = reply.id, status = 'accepted', updated_at = pg_catalog.now()
    where id = question.id;
    next_status := 'accepted';
  elsif was_accepted then
    update public.member_qa_replies set accepted = false, updated_at = pg_catalog.now()
    where question_id = question.id and accepted;
    next_status := case when exists (
      select 1 from public.member_qa_replies r
      where r.question_id = question.id and r.deleted_at is null and r.kind = 'official'
    ) then 'replied' else 'open' end;
    update public.member_qa_questions
    set accepted_reply_id = null, status = next_status, updated_at = pg_catalog.now()
    where id = question.id;
  else
    next_status := question.status;
  end if;
  if was_accepted is distinct from desired then
    perform private.mi1_write_tenant_audit(
      org, case when desired then 'qa_answer_accepted' else 'qa_answer_unaccepted' end,
      pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', question.chapter_id,
        'questionId', question.id, 'replyId', reply.id, 'status', next_status
      )
    );
  end if;
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
end;
$function$;

-- public.casework_advance_step(uuid, text, text, text, uuid), from 20261106170000_casework_step_deadlines_eastern_day.sql: 1 refusal
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

declare v_case public.member_cases%rowtype; v_transition public.casework_step_transitions%rowtype; v_template public.casework_checklist_templates%rowtype; v_checklist_id uuid; v_procedure uuid; v_current public.casework_procedure_steps%rowtype; v_next public.casework_procedure_steps%rowtype; v_start timestamptz; v_due timestamptz; v_incident text; v_deadline_id uuid;
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
  if v_case.step is distinct from p_expected_step then raise exception 'case step changed' using errcode = 'PT409'; end if;
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
        v_start := v_incident::date::timestamp at time zone 'America/New_York';
      end if;
      v_due := case v_next.deadline_rule->>'kind'
        when 'business_days' then private.casework_add_business_days(v_start, (v_next.deadline_rule->>'count')::integer, v_case.organization_id)
        else (((v_start at time zone 'America/New_York')::date + (v_next.deadline_rule->>'count')::integer) + time '23:59:59') at time zone 'America/New_York' end;
    end if;
  end if;
  insert into public.casework_step_transitions(case_id, organization_id, chapter_id, from_step, to_step, outcome, transitioned_by, idempotency_key, procedure_transaction_id)
  values (v_case.id, v_case.organization_id, v_case.chapter_id, v_case.step, pg_catalog.btrim(p_next_step), pg_catalog.btrim(p_outcome), (select auth.uid()), p_idempotency_key, pg_current_xact_id())
  returning * into v_transition;
  if v_due is not null then
    insert into public.casework_deadlines(case_id, organization_id, chapter_id, kind, label, due_at, created_by)
    values(v_case.id, v_case.organization_id, v_case.chapter_id, 'procedure', v_next.label, v_due, (select auth.uid()))
    returning id into v_deadline_id;
    insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'deadline_created', 'deadline', v_deadline_id,
      pg_catalog.jsonb_build_object('kind', 'procedure', 'dueAt', v_due, 'reminderSet', false));
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
  perform private.learning_casework_journal('casework_step_advance', p_case_id);
  return v_transition;
end;

end;
$function$;

-- public.casework_bulk_update_cases(uuid[], text, text, text, uuid), from 20261104075000_learning_period_case_records.sql: 1 refusal
create or replace function public.casework_bulk_update_cases(
  p_case_ids uuid[],
  p_expected_status text,
  p_next_status text,
  p_next_step text,
  p_idempotency_key uuid
)
returns integer
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare learning_parent uuid; v_count integer; v_org_count integer; v_case record;
begin
  perform private.casework_require_mfa();
  if coalesce(pg_catalog.array_length(p_case_ids, 1), 0) not between 1 and 100 then raise exception 'select 1 to 100 cases' using errcode = '22023'; end if;
  if p_next_status is not null and p_next_status not in ('active','resolved') then raise exception 'invalid status' using errcode = '22023'; end if;
  select pg_catalog.count(*), pg_catalog.count(distinct organization_id) into v_count, v_org_count
  from public.member_cases c where c.id = any(p_case_ids) and private.casework_staff_can_access(c.id);
  if v_count <> pg_catalog.array_length(p_case_ids, 1) or v_org_count <> 1 then raise exception 'case selection is not authorized' using errcode = 'P0002'; end if;
  perform 1 from public.member_cases c where c.id = any(p_case_ids) order by c.id for update;
  if exists (select 1 from public.member_cases c where c.id = any(p_case_ids) and c.status <> p_expected_status) then raise exception 'case status changed' using errcode = 'PT409'; end if;
  update public.member_cases set status = coalesce(p_next_status, status), step = coalesce(nullif(pg_catalog.btrim(p_next_step), ''), step), updated_at = pg_catalog.now() where id = any(p_case_ids);
  for v_case in select id, organization_id, chapter_id from public.member_cases where id = any(p_case_ids) loop
    insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'bulk_updated', 'case', v_case.id, pg_catalog.jsonb_build_object('operationId', p_idempotency_key, 'status', p_next_status, 'step', p_next_step));
  end loop;
  -- One bulk action: a parent entry and one edit per case, undone all or nothing.
  learning_parent := private.learning_journal_append('case_bulk_update', 'public.member_cases',
    'bulk:' || coalesce(p_idempotency_key::text, extensions.gen_random_uuid()::text));
  perform private.learning_case_journal('case_edit', ids.id, learning_parent)
  from pg_catalog.unnest(p_case_ids) as ids(id) order by ids.id;
  return v_count;
end;
end;
$function$;

-- public.casework_save_intake_draft(uuid, text, uuid, uuid, jsonb, integer), from 20261104123000_learning_period_case_workflow.sql: 1 refusal
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
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
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
    if not found then raise exception 'draft changed' using errcode = 'PT409'; end if;
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, p_chapter_id, p_case_id, (select auth.uid()), 'draft_saved', 'intake_draft', v_row.id, pg_catalog.jsonb_build_object('revision', v_row.revision));
  perform private.learning_casework_journal('casework_draft_save', null, true);
  return v_row;
end;
end;
$function$;

-- public.casework_save_procedure(uuid, text, text, text, jsonb, integer), from 20260917133000_casework_procedures_retire_w2.sql: 2 refusals
create or replace function public.casework_save_procedure(p_procedure_id uuid, p_chapter_id text, p_case_type text,
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
    if p_expected_version is distinct from v_version then raise exception 'procedure changed' using errcode = 'PT409'; end if;
    -- Scope changes could silently strand cases under a fallback procedure.
    if exists (select 1 from public.casework_procedures where id = v_id and (chapter_id is distinct from p_chapter_id or case_type is distinct from nullif(btrim(p_case_type), '')))
      then raise exception 'create a new procedure for a different scope' using errcode = '22023'; end if;
  else
    if p_expected_version is not null then raise exception 'unexpected procedure version' using errcode = 'PT409'; end if;
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

-- public.casework_scan_retaliation_patterns(text), from 20260907152000_sensitive_content_lock_order.sql: 1 refusal
create or replace function public.casework_scan_retaliation_patterns(p_chapter_id text)
returns integer language plpgsql security definer set search_path = '' as $$
declare org uuid; ticket private.sensitive_write_tickets%rowtype;
  sources jsonb; g jsonb; report_ids uuid[]; count_out integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  count_out := 0;
  org := private.mi1_require_selected_organization();
  perform private.casework_require_mfa();
  if not exists(select 1 from public.chapters where id = p_chapter_id and organization_id = org)
    or not private.member_has_chapter_role(p_chapter_id, array['coordinator','advisor','admin','vp']) then
    raise exception 'chapter not found' using errcode = '42501';
  end if;
  select * into ticket from private.sensitive_write_tickets
    where id = nullif(current_setting('app.sensitive_ticket',true),'')::uuid
    and actor = (select auth.uid()) and operation = 'casework_scan_retaliation_patterns'
    and arguments->>'p_chapter_id' = p_chapter_id and expires_at > clock_timestamp();
  if ticket.id is null then raise exception 'sensitive-data-trusted-write-required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('sensitive-pattern:' || org::text || p_chapter_id,0));
  perform 1 from public.casework_retaliation_reports r where r.organization_id = org and r.chapter_id = p_chapter_id
    and (r.reporter_user_id = (select auth.uid()) or (r.case_id is null or private.casework_staff_can_access(r.case_id))) for update;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'version',r.encrypted_content->'management_person'->>'dataVersion') order by r.id),'[]'::jsonb)
    into sources from public.casework_retaliation_reports r where r.organization_id = org and r.chapter_id = p_chapter_id
    and (r.reporter_user_id = (select auth.uid()) or (r.case_id is null or private.casework_staff_can_access(r.case_id)))
    and r.status <> 'withdrawn' and r.incident_at >= now() - interval '3 years';
  if sources is distinct from ticket.arguments->'sources' then raise exception 'sensitive-pattern-source-changed' using errcode = 'PT409'; end if;
  for g in select value from jsonb_array_elements(ticket.envelopes->'groups') loop
    select array_agg(value::uuid) into report_ids from jsonb_array_elements_text(g->'reports');
    if cardinality(report_ids) < 2 or (select count(distinct id) from unnest(report_ids) id) <> cardinality(report_ids)
      or exists(select 1 from unnest(report_ids) id where not sources @> jsonb_build_array(jsonb_build_object('id',id)))
      or g->'label'->>'organization' is distinct from org::text
      or g->'label'->>'record' is distinct from g->>'id'
      or g->'label'->>'field' is distinct from 'subject_label'
      or g->'label'->>'purpose' is distinct from 'casework_retaliation_patterns' then
      raise exception 'sensitive-pattern-invalid-group' using errcode = '22023';
    end if;
    -- Retain existing reviewed patterns as history; replace only unreviewed
    -- generated groups whose membership overlaps this fresh detection.
    delete from public.casework_retaliation_patterns p where p.organization_id = org and p.chapter_id = p_chapter_id
      and p.reviewed_at is null and p.encrypted_content <> '{}'::jsonb
      and exists(select 1 from public.casework_retaliation_pattern_reports link where link.pattern_id = p.id and link.report_id = any(report_ids))
      and not exists(select 1 from public.casework_retaliation_pattern_reports link
        where link.pattern_id = p.id
          and not sources @> jsonb_build_array(jsonb_build_object('id',link.report_id)))
      and not exists(select 1 from public.casework_retaliation_pattern_notes n where n.pattern_id = p.id);
    insert into public.casework_retaliation_patterns(id,organization_id,chapter_id,fingerprint,subject_label,report_count,encrypted_content)
      values((g->>'id')::uuid,org,p_chapter_id,g->>'id','[encrypted]',cardinality(report_ids),jsonb_build_object('subject_label',g->'label'));
    insert into public.casework_retaliation_pattern_reports(pattern_id,report_id,organization_id)
      select (g->>'id')::uuid,id,org from unnest(report_ids) id;
    insert into public.casework_audit_events(organization_id,chapter_id,actor_user_id,event_type,entity_type,entity_id,metadata)
      values(org,p_chapter_id,(select auth.uid()),'pattern_detected','retaliation_pattern',(g->>'id')::uuid,jsonb_build_object('reportCount',cardinality(report_ids)));
    count_out := count_out + 1;
  end loop;
  return count_out;
end
$$;

-- public.casework_set_bargaining_status(uuid, text, text): 1 refusal. The installed body (pg_get_functiondef), because a later
-- migration rewrote the body 20260828210000_mi1_casework_suite.sql created in place.
CREATE OR REPLACE FUNCTION public.casework_set_bargaining_status(p_workspace_id uuid, p_expected_status text, p_next_status text)
 RETURNS public.casework_bargaining_workspaces
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_row public.casework_bargaining_workspaces%rowtype;
begin
  perform private.casework_require_mfa();
  if p_next_status not in ('planning','live','paused','tentative_agreement','closed') then raise exception 'invalid session status' using errcode = '22023'; end if;
  select * into strict v_row from public.casework_bargaining_workspaces where id = p_workspace_id for update;
  if not private.member_has_chapter_role(v_row.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  if v_row.status <> p_expected_status then raise exception 'workspace changed' using errcode = 'PT409'; end if;
  update public.casework_bargaining_workspaces set status = p_next_status, updated_at = pg_catalog.now() where id = v_row.id returning * into v_row;
  insert into public.casework_bargaining_events(workspace_id, organization_id, event_type, body, created_by)
  values (v_row.id, v_row.organization_id, 'session_status', p_expected_status || ' → ' || p_next_status, (select auth.uid()));
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_workspace', v_row.id, pg_catalog.jsonb_build_object('fromStatus', p_expected_status, 'toStatus', p_next_status));
  return v_row;
end;
end;
$function$;

-- public.casework_transition_bargaining_proposal(uuid, text, text, timestamp with time zone): 1 refusal. The installed body (pg_get_functiondef), because a later
-- migration rewrote the body 20260828210000_mi1_casework_suite.sql created in place.
CREATE OR REPLACE FUNCTION public.casework_transition_bargaining_proposal(p_proposal_id uuid, p_expected_status text, p_next_status text, p_response_due_at timestamp with time zone)
 RETURNS public.casework_bargaining_proposals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_workspace public.casework_bargaining_workspaces%rowtype; v_row public.casework_bargaining_proposals%rowtype;
begin
  perform private.casework_require_mfa();
  if p_next_status not in ('draft','proposed','countered','tentative','accepted','rejected','withdrawn') then raise exception 'invalid proposal status' using errcode = '22023'; end if;
  select * into strict v_row from public.casework_bargaining_proposals where id = p_proposal_id for update;
  select * into strict v_workspace from public.casework_bargaining_workspaces where id = v_row.workspace_id;
  if not private.member_has_chapter_role(v_workspace.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'proposal not found' using errcode = 'P0002'; end if;
  if v_row.status <> p_expected_status then raise exception 'proposal changed' using errcode = 'PT409'; end if;
  update public.casework_bargaining_proposals set status = p_next_status, response_due_at = p_response_due_at, updated_at = pg_catalog.now() where id = v_row.id returning * into v_row;
  insert into public.casework_bargaining_events(workspace_id, organization_id, proposal_id, event_type, body, created_by)
  values (v_workspace.id, v_workspace.organization_id, v_row.id, 'proposal_status', p_expected_status || ' → ' || p_next_status, (select auth.uid()));
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_workspace.organization_id, v_workspace.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_proposal', v_row.id, pg_catalog.jsonb_build_object('fromStatus', p_expected_status, 'toStatus', p_next_status));
  return v_row;
end;
end;
$function$;

-- public.decide_chapter_financial_request(uuid, text, uuid, integer, text, text), from 20261102014446_chapter_treasurer_financial_duties.sql: 1 refusal
create or replace function public.decide_chapter_financial_request(p_org uuid,p_chapter text,p_id uuid,p_revision integer,p_decision text,p_note text)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare target private.chapter_financial_requests%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  perform private.member_pin_require_full_session();
  perform private.chapter_finance_context(p_org,p_chapter);
  if not private.chapter_finance_can(p_chapter,'finance_records') then raise exception 'financial record access required' using errcode='42501'; end if;
  if p_decision is null or p_decision not in ('approved','declined') or p_note is null or char_length(btrim(p_note)) not between 1 and 2000 then raise exception 'invalid financial decision' using errcode='22023'; end if;
  update private.chapter_financial_requests set status=p_decision,decision_note=p_note,revision=revision+1,decided_at=now()
    where id=p_id and organization_id=p_org and chapter_id=p_chapter and status='pending' and revision=p_revision returning * into target;
  if not found then raise exception 'financial request conflict' using errcode='PT409'; end if;
  insert into public.organization_audit_ledger(organization_id,domain,event_type,action,actor_user_id,entity_type,entity_id,idempotency_key,metadata)
  values(p_org,'administration','chapter_financial_request','update',auth.uid(),'document',target.id::text,extensions.gen_random_uuid(),jsonb_build_object('chapterId',p_chapter,'status',p_decision));
  return to_jsonb(target);
end;
$function$;

-- public.dispatch_dues_reminder_attempt(uuid, integer, integer, text, text), from 20260925620900_dues_reminder_localized_notification.sql: 1 refusal
create or replace function public.dispatch_dues_reminder_attempt(
  p_attempt_id uuid,
  p_expected_attempt_count integer,
  p_lease_epoch integer,
  p_outcome text,
  p_outbound_delivery_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt public.dues_reminder_attempts%rowtype;
  recipient uuid;
  notification uuid;
  delivery_state text;
  delivery_suffix text;
  copy_row private.notification_copy;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  delivery_state := p_outcome;
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome not in ('sent', 'deferred', 'failed', 'blocked')
     or p_outbound_delivery_key is not null then
    raise exception 'invalid dues reminder outcome' using errcode = '22023';
  end if;
  select * into attempt
  from public.dues_reminder_attempts row
  where row.id = p_attempt_id
  for update;
  if not found then
    raise exception 'dues reminder attempt not found' using errcode = '22023';
  end if;
  if attempt.state <> 'leased'
     or attempt.lease_epoch <> p_lease_epoch
     or attempt.attempt_count <> p_expected_attempt_count
     or attempt.lease_expires_at <= pg_catalog.now() then
    raise exception 'stale dues reminder lease' using errcode = 'PT409';
  end if;
  select subject.user_id into recipient
  from public.dues_obligations obligation
  join public.dues_member_subjects subject
    on subject.organization_id = obligation.organization_id
   and subject.id = obligation.member_subject_id
  where obligation.organization_id = attempt.organization_id
    and obligation.id = attempt.obligation_id;

  if p_outcome = 'sent' and recipient is not null then
    delivery_suffix := case when attempt.channel = 'email' then 'email' else 'in-app' end;
    insert into public.dues_notification_deliveries (
      organization_id, reminder_attempt_id, channel, delivery_key, state
    ) values (
      attempt.organization_id, attempt.id, attempt.channel,
      'dues-reminder:' || attempt.id::text || ':' || delivery_suffix,
      'queued'
    ) on conflict (organization_id, reminder_attempt_id, channel) do nothing;
    select delivery.notification_id into notification
    from public.dues_notification_deliveries delivery
    where delivery.organization_id = attempt.organization_id
      and delivery.reminder_attempt_id = attempt.id
      and delivery.channel = attempt.channel
    for update;
    if notification is null then
      select * into copy_row
      from private.notification_copy entry
      where entry.key = 'dues.reminder'
        and entry.lang = coalesce(
          (select profile.language from public.member_profiles profile
            where profile.id = recipient), 'en');
      if copy_row.key is null then
        select * into copy_row
        from private.notification_copy entry
        where entry.key = 'dues.reminder' and entry.lang = 'en';
      end if;
      if copy_row.key is null then
        raise exception 'unknown notification copy key: dues.reminder';
      end if;
      insert into public.member_notifications (user_id, title, body, kind)
      values (
        recipient,
        copy_row.title,
        copy_row.body,
        'dues'
      ) returning id into notification;
      update public.dues_notification_deliveries
      set notification_id = notification,
          state = 'sent',
          updated_at = pg_catalog.now()
      where organization_id = attempt.organization_id
        and reminder_attempt_id = attempt.id
        and channel = attempt.channel;
    end if;
  elsif p_outcome = 'sent' then
    delivery_state := 'blocked';
  end if;
  update public.dues_reminder_attempts
  set state = delivery_state,
      lease_owner = null,
      lease_expires_at = null,
      outcome_code = delivery_state,
      updated_at = pg_catalog.now()
  where id = attempt.id;
  return pg_catalog.jsonb_build_object(
    'id', attempt.id,
    'state', delivery_state,
    'notificationId', notification
  );
end;
$function$;

-- public.execute_organization_automation_run(uuid, text), from 20261104111500_learning_period_messages_notices_invites_exports.sql: 1 refusal
create or replace function public.execute_organization_automation_run(
  p_run_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  run_row public.organization_automation_runs%rowtype;
  definition_row public.organization_automation_definitions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_approver();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  select r.* into run_row from public.organization_automation_runs r
  where r.id = p_run_id and r.organization_id = org and r.mode = 'preview' and r.status = 'previewed'
  for update of r;
  if run_row.id is null then raise exception 'automation preview unavailable' using errcode = '22023'; end if;
  if run_row.learning_practice or run_row.confirmation_phrase is null
     or private.learning_automation_preview_only(org, run_row.definition_id) then
    raise exception 'automations only preview during the learning period' using errcode = '55000';
  end if;
  if run_row.completed_at < pg_catalog.now() - interval '15 minutes' then raise exception 'automation preview expired' using errcode = '22023'; end if;
  if p_confirmation is distinct from run_row.confirmation_phrase then raise exception 'automation run confirmation did not match' using errcode = '22023'; end if;
  if not exists(select 1 from public.organization_automation_settings s where s.organization_id = org and s.enabled) then
    raise exception 'organization automation is paused' using errcode = '22023';
  end if;
  select d.* into definition_row from public.organization_automation_definitions d
  where d.id = run_row.definition_id
    and d.organization_id = org
    and d.version = run_row.definition_version
    and d.status = 'active'
    and d.review_status = 'approved'
    and d.review_version = d.version
  for update of d;
  if definition_row.id is null then raise exception 'automation definition changed or approval is stale; preview again' using errcode = 'PT409'; end if;
  update public.organization_automation_runs
     set mode = 'manual', status = 'in_progress', initiated_by = actor,
         started_at = pg_catalog.now(), completed_at = null, candidates_count = 0,
         effects_skipped = 0, confirmation_phrase = null
   where id = run_row.id;
  return private.cr108_execute_run(run_row.id);
end;
$function$;

-- public.execute_organization_merge_plan(uuid, uuid, uuid, uuid): 1 refusal. The installed body (pg_get_functiondef), because a later
-- migration rewrote the body 20260828232000_mi1_organization_coordination_workflows.sql created in place.
CREATE OR REPLACE FUNCTION public.execute_organization_merge_plan(p_plan_id uuid, p_expected_source_organization_id uuid, p_expected_target_organization_id uuid, p_idempotency_key uuid DEFAULT extensions.gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  plan public.organization_coordination_records%rowtype;
  job public.organization_merge_jobs%rowtype;
  approved_count integer;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['admin','vp']) then
    raise exception 'organization merger role required' using errcode = '42501';
  end if;
  select * into plan from public.organization_coordination_records r
  where r.id = p_plan_id and r.kind = 'merger_plan'
    and r.status = 'active' for update;
  if not found or plan.organization_id <> p_expected_source_organization_id
    or plan.partner_organization_id <> p_expected_target_organization_id
    or organization <> plan.partner_organization_id then
    raise exception 'organization merger plan changed' using errcode = 'PT409';
  end if;
  select pg_catalog.count(*)::integer into approved_count
  from public.organization_merge_match_reviews review
  where review.plan_id = plan.id and review.decision = 'approved';
  if approved_count = 0 then
    raise exception 'approved organization matches required' using errcode = '22023';
  end if;
  insert into public.organization_merge_jobs (
    plan_id, source_organization_id, target_organization_id, status,
    requested_by, executed_by, approved_match_count, started_at, completed_at
  ) values (
    plan.id, plan.organization_id, plan.partner_organization_id, 'completed',
    caller, caller, approved_count, pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ) on conflict (plan_id) do update set plan_id = excluded.plan_id
  returning * into job;
  if job.target_organization_id <> organization then
    raise exception 'organization merger job unavailable' using errcode = '42501';
  end if;
  insert into public.organization_merge_remap_events (
    plan_id, source_organization_id, target_organization_id, object_type,
    source_object_id, target_object_id, executed_by
  )
  select plan.id, plan.organization_id, plan.partner_organization_id,
    'member_identity', review.source_user_id::text, review.target_user_id::text,
    caller
  from public.organization_merge_match_reviews review
  where review.plan_id = plan.id and review.decision = 'approved'
    and not exists (
      select 1 from public.organization_merge_remap_events remap
      where remap.plan_id = plan.id and remap.object_type = 'member_identity'
        and remap.source_object_id = review.source_user_id::text
        and remap.target_object_id = review.target_user_id::text
    );
  update public.organization_coordination_records
  set status = 'executed', updated_at = pg_catalog.clock_timestamp()
  where id = plan.id;
  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, from_status,
    to_status, metadata, idempotency_key
  ) values (
    plan.id, organization, caller, 'merge_mapping_executed', plan.status,
    'executed', pg_catalog.jsonb_build_object(
      'jobId', job.id, 'approvedMatchCount', approved_count
    ), p_idempotency_key
  ) on conflict (idempotency_key) do nothing;
  return pg_catalog.jsonb_build_object(
    'jobId', job.id, 'status', job.status,
    'approvedMatchCount', approved_count
  );
end;
end;
$function$;

-- public.export_member_directory_csv(uuid, text, text), from 20261105030000_learning_period_export_calls.sql: 1 refusal
create or replace function public.export_member_directory_csv(
  p_expected_org uuid,
  p_expected_chapter text,
  p_locale text default 'en'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  export_payload jsonb;
  caller uuid;
  caller_org uuid;
  caller_chapter text;
  org_admin boolean;
  chapter_admin boolean;
  officer boolean;
  basis text;
  spanish boolean;
  total integer;
  lines text;
  header text;
  crlf text;
begin
  -- The audit write joins the case graph: take its lock before anything else.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  caller_org := private.current_member_organization();
  caller_chapter := private.current_member_chapter();
  org_admin := false;
  chapter_admin := false;
  officer := false;
  spanish := p_locale = 'es';
  crlf := pg_catalog.chr(13) || pg_catalog.chr(10);
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then
    raise exception 'MFA required' using errcode = '42501';
  end if;
  if p_locale is null or p_locale not in ('en', 'es') then
    raise exception 'locale out of range' using errcode = '22023';
  end if;
  if caller is null or caller_org is null or caller_chapter is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- The page exports the directory it displayed: a chapter or organization
  -- switched since then (another tab) refuses rather than exporting another
  -- list under the old one.
  if caller_org is distinct from p_expected_org or caller_chapter is distinct from p_expected_chapter then
    raise exception 'directory context changed' using errcode = 'PT409';
  end if;
  -- The internal platform organization stays outside union exports
  -- (AGENTS.md; private.organization_export_dataset, 20261028080000).
  if not private.organization_is_union(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  org_admin := private.has_organization_role(caller_org, array['admin']);
  if not org_admin then
    chapter_admin := private.member_has_chapter_role(caller_chapter, array['admin']);
    if not chapter_admin then
      officer := private.member_directory_officer(caller_org, caller_chapter);
    end if;
  end if;
  if not (org_admin or chapter_admin or officer) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  basis := case
    when org_admin then 'organization_admin'
    when chapter_admin then 'chapter_admin'
    when private.member_has_chapter_role(caller_chapter, array['vp']) then 'president'
    else 'secretary_treasurer'
  end;

  -- The same rows and fields as get_admin_member_directory, without paging.
  with visible as materialized (
    select p.id, p.full_name,
      p.member_since::integer as member_since_year,
      located.chapter_name, located.display_title,
      private.organization_member_roles(
        p.id, caller_org, case when org_admin then null else caller_chapter end
      ) as roles,
      -- Only the fields the member shared with administrators leave this row.
      case when d.details_visibility = 'admins' then d.pronouns end as shared_pronouns,
      case when d.details_visibility = 'admins' then d.job_title end as shared_job_title,
      case when d.details_visibility = 'admins' then d.worksite end as shared_worksite,
      case when d.details_visibility = 'admins' then d.shift end as shared_shift,
      case when d.details_visibility = 'admins' then d.classification end as shared_classification,
      case when d.phone_visibility = 'admins' then d.phone end as shared_phone
    from public.member_profiles p
    join public.organization_memberships om
      on om.user_id = p.id
     and om.organization_id = caller_org
     and om.status = 'active'
    join lateral (
      select c.id as chapter_id, c.name as chapter_name, cm.display_title
      from public.member_chapter_memberships cm
      join public.chapters c
        on c.id = cm.chapter_id
       and c.organization_id = caller_org
      where cm.user_id = p.id
        and cm.status = 'active'
        and (org_admin or c.id = caller_chapter)
      order by (c.id = p.chapter_id) desc, c.order_index, c.id
      limit 1
    ) located on true
    left join public.member_profile_details d on d.user_id = p.id
  )
  select pg_catalog.count(*)::integer,
    pg_catalog.string_agg(pg_catalog.concat_ws(',',
      private.member_directory_csv_cell(v.full_name),
      private.member_directory_csv_cell(v.member_since_year::text),
      private.member_directory_csv_cell(v.chapter_name),
      private.member_directory_csv_cell(v.display_title),
      private.member_directory_csv_cell((
        select pg_catalog.string_agg(case r.role
          when 'steward' then case when spanish then 'Delegado' else 'Steward' end
          when 'coordinator' then case when spanish then 'Coordinador' else 'Coordinator' end
          when 'advisor' then case when spanish then 'Asesor' else 'Advisor' end
          when 'admin' then 'Admin'
          when 'vp' then case when spanish then 'Presidente' else 'President' end
          else r.role end, '; ' order by r.role)
        from pg_catalog.jsonb_array_elements_text(v.roles) as r(role)
      )),
      private.member_directory_csv_cell(v.shared_pronouns),
      private.member_directory_csv_cell(v.shared_job_title),
      private.member_directory_csv_cell(v.shared_worksite),
      private.member_directory_csv_cell(v.shared_shift),
      private.member_directory_csv_cell(v.shared_classification),
      private.member_directory_csv_cell(v.shared_phone)
    ), crlf order by v.full_name, v.id)
  into total, lines
  from visible v;

  -- At most 5,000 rows in one file.
  if total > 5000 then
    raise exception 'export too large' using errcode = '54000';
  end if;

  header := case when spanish
    then 'Nombre completo,Miembro desde,Capítulo,Título de cargo,Funciones del personal,Pronombres,Puesto,Lugar de trabajo,Turno,Clasificación del puesto,Teléfono'
    else 'Full name,Member since,Chapter,Officer title,Staff roles,Pronouns,Job title,Worksite,Shift,Job classification,Phone'
  end;

  insert into public.organization_audit_ledger
    (organization_id, domain, event_type, action, actor_user_id, entity_type, entity_id, idempotency_key, metadata)
  values (caller_org, 'exports', 'member_directory_export', 'export', caller,
    case when org_admin then 'organization' else 'chapter' end,
    case when org_admin then caller_org::text else caller_chapter end,
    extensions.gen_random_uuid(),
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'chapterId', case when org_admin then null else caller_chapter end,
      'count', total,
      'exportType', 'member_directory_csv',
      'role', basis)));

  export_payload := pg_catalog.jsonb_build_object(
    'csv', header || crlf || coalesce(lines || crlf, ''),
    'rowCount', total,
    'scope', case when org_admin then 'organization' else 'chapter' end,
    'chapterId', case when org_admin then null else caller_chapter end
  );
  -- Journal only after the complete, available response has been built.
  perform private.learning_journal_append('member_directory_export_request',
    'private.learning_export_calls', extensions.gen_random_uuid()::text);

  return export_payload;
end;
$function$;

-- public.issue_dues_assessment_batch(text, text, text, text, integer, date, text, text, text): 1 refusal. The installed body (pg_get_functiondef), because a later
-- migration rewrote the body 20260831110100_mi1_dues_ledger_mutations.sql created in place.
CREATE OR REPLACE FUNCTION public.issue_dues_assessment_batch(p_title text, p_description text, p_scope_kind text, p_chapter_id text, p_amount_cents integer, p_due_on date, p_preview_fingerprint text, p_idempotency_key text, p_selected_hat text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.dues_require_financial_hat(p_selected_hat);
  normalized_title text := nullif(pg_catalog.btrim(pg_catalog.normalize(p_title)), '');
  normalized_description text := nullif(pg_catalog.btrim(pg_catalog.normalize(coalesce(p_description, ''))), '');
  existing public.dues_assessment_batches%rowtype;
  created public.dues_assessment_batches%rowtype;
  subject_ids uuid[];
  fingerprint text;
  eligible_count integer;
begin
  perform private.dues_validate_idempotency_key(p_idempotency_key);
  if normalized_title is null or pg_catalog.char_length(normalized_title) > 160
     or (normalized_description is not null and pg_catalog.char_length(normalized_description) > 4000)
     or p_scope_kind not in ('organization', 'chapter')
     or p_amount_cents is null or p_amount_cents <= 0
     or p_due_on is null
     or p_preview_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid dues assessment' using errcode = '22023';
  end if;
  if (p_scope_kind = 'organization' and p_chapter_id is not null)
     or (p_scope_kind = 'chapter' and not exists (
       select 1 from public.chapters chapter
       where chapter.organization_id = org and chapter.id = p_chapter_id
     )) then
    raise exception 'dues chapter scope invalid' using errcode = '22023';
  end if;

  select * into existing
  from public.dues_assessment_batches batch
  where batch.organization_id = org and batch.idempotency_key = p_idempotency_key
  for update;
  if found then
    if existing.title is distinct from normalized_title
       or existing.description is distinct from normalized_description
       or existing.scope_kind is distinct from p_scope_kind
       or existing.chapter_id is distinct from p_chapter_id
       or existing.amount_cents is distinct from p_amount_cents
       or existing.due_on is distinct from p_due_on
       or existing.eligibility_fingerprint is distinct from p_preview_fingerprint then
      raise exception 'dues idempotency payload mismatch' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('id', existing.id, 'issued', true, 'idempotent', true);
  end if;

  -- One MATERIALIZED membership snapshot drives both the fingerprint and the
  -- INSERT fanout. It is never rebuilt in a second visible query.
  with eligible as materialized (
    select subject.id
    from public.dues_member_subjects subject
    join public.organization_memberships membership
      on membership.organization_id = subject.organization_id
     and membership.user_id = subject.user_id
     and membership.status = 'active'
    where subject.organization_id = org
      and (
        p_scope_kind = 'organization'
        or exists (
          select 1
          from public.member_chapter_memberships chapter_membership
          join public.chapters chapter
            on chapter.id = chapter_membership.chapter_id
           and chapter.organization_id = subject.organization_id
          where chapter_membership.user_id = membership.user_id
            and chapter_membership.status = 'active'
            and chapter_membership.chapter_id = p_chapter_id
        )
      )
    order by subject.id
  )
  select coalesce(array_agg(id), array[]::uuid[]) into subject_ids from eligible;
  eligible_count := cardinality(subject_ids);
  if eligible_count = 0 then
    raise exception 'dues assessment has no eligible members' using errcode = '22023';
  end if;
  fingerprint := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'organizationId', org,
      'title', normalized_title,
      'description', normalized_description,
      'scopeKind', p_scope_kind,
      'chapterId', p_chapter_id,
      'memberSubjectIds', pg_catalog.to_jsonb(subject_ids),
      'amountCents', p_amount_cents,
      'dueOn', p_due_on,
      'currency', 'USD',
      'kind', 'assessment',
      'reminderPolicy', 'monthly-overdue-v1'
    )::text, 'UTF8'), 'sha256'), 'hex'
  );
  if fingerprint is distinct from p_preview_fingerprint then
    raise exception 'dues assessment preview changed' using errcode = 'PT409';
  end if;

  insert into public.dues_assessment_batches (
    organization_id, chapter_id, title, description, scope_kind, amount_cents,
    due_on, eligibility_fingerprint, idempotency_key, created_by
  ) values (
    org, p_chapter_id, normalized_title, normalized_description, p_scope_kind, p_amount_cents,
    p_due_on, fingerprint, p_idempotency_key, (select auth.uid())
  ) on conflict (organization_id, idempotency_key) do nothing
  returning * into created;
  if created.id is null then
    select * into existing
    from public.dues_assessment_batches batch
    where batch.organization_id = org and batch.idempotency_key = p_idempotency_key
    for update;
    if existing.id is null
       or existing.title is distinct from normalized_title
       or existing.description is distinct from normalized_description
       or existing.scope_kind is distinct from p_scope_kind
       or existing.chapter_id is distinct from p_chapter_id
       or existing.amount_cents is distinct from p_amount_cents
       or existing.due_on is distinct from p_due_on
       or existing.eligibility_fingerprint is distinct from p_preview_fingerprint then
      raise exception 'dues idempotency payload mismatch' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('id', existing.id, 'issued', true, 'idempotent', true);
  end if;

  insert into public.dues_obligations (
    organization_id, batch_id, member_subject_id, chapter_id, issued_cents, due_on
  )
  select org, created.id, subject_id, p_chapter_id, p_amount_cents, p_due_on
  from unnest(subject_ids) as subject_id;

  insert into public.dues_ledger_events (
    organization_id, obligation_id, event_kind, amount_cents, effective_on,
    reason, idempotency_key, created_by
  )
  select obligation.organization_id, obligation.id, 'assessment', obligation.issued_cents,
    p_due_on, normalized_title, 'dues-assessment:' || created.id::text || ':' || obligation.id::text,
    (select auth.uid())
  from public.dues_obligations obligation
  where obligation.organization_id = org and obligation.batch_id = created.id;

  perform private.mi1_write_tenant_audit(org, 'dues_assessment_issued', pg_catalog.jsonb_build_object(
    'batchId', created.id, 'scopeKind', p_scope_kind, 'eligibleCount', eligible_count, 'amountCents', p_amount_cents
  ));
  return pg_catalog.jsonb_build_object(
    'id', created.id, 'issued', true, 'idempotent', false,
    'eligibleCount', eligible_count, 'totalCents', eligible_count * p_amount_cents
  );
end;
end;
$function$;

-- public.merge_chapter_workstreams(uuid, uuid, integer): 1 refusal. The installed body (pg_get_functiondef), because a later
-- migration rewrote the body 20260728221416_publication_contract_and_workstream_merge.sql created in place.
CREATE OR REPLACE FUNCTION public.merge_chapter_workstreams(p_source_id uuid, p_target_id uuid, p_expected_moving integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  source_row public.chapter_workstreams;
  target_row public.chapter_workstreams;
  moved integer;
  actual_moving integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;

  select w.* into source_row from public.chapter_workstreams w
  where w.id = p_source_id and w.chapter_id = caller_chapter for update;
  select w.* into target_row from public.chapter_workstreams w
  where w.id = p_target_id and w.chapter_id = caller_chapter for update;

  if source_row.id is null or target_row.id is null then
    raise exception 'workstream unavailable' using errcode = '22023';
  end if;
  if source_row.id = target_row.id then
    raise exception 'a workstream cannot be merged into itself' using errcode = '22023';
  end if;

  -- Optimistic concurrency against the preview the coordinator actually read.
  -- Someone else filing three cards between the dialog opening and the button
  -- being pressed should not silently widen an irreversible operation.
  if p_expected_moving is not null then
    select pg_catalog.count(*) into actual_moving
    from public.chapter_tasks t
    where t.chapter_id = caller_chapter and t.workstream = source_row.name and t.deleted_at is null;

    if actual_moving <> p_expected_moving then
      raise exception 'this workstream changed while you were looking at it; review the merge again'
        using errcode = 'PT409';
    end if;
  end if;

  -- Cards first: the target name already exists, so the assert trigger passes
  -- and there is no window where a card names a list row that is gone.
  update public.chapter_tasks
    set workstream = target_row.name
    where chapter_id = caller_chapter and workstream = source_row.name;
  get diagnostics moved = row_count;

  delete from public.chapter_workstreams where id = source_row.id;

  return pg_catalog.jsonb_build_object(
    'targetId', target_row.id,
    'targetName', target_row.name,
    'removedName', source_row.name,
    'movedTasks', moved
  );
end;
end;
end;
$function$;

-- public.mi1_review_automation_definition(uuid, integer, text, text), from 20261104111500_learning_period_messages_notices_invites_exports.sql: 1 refusal
create or replace function public.mi1_review_automation_definition(
  p_definition_id uuid,
  p_expected_version integer,
  p_action text,
  p_note text default null
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
  next_status text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_approver();
  if p_action not in ('approve', 'request_changes')
      or (p_note is not null and (length(p_note) not between 1 and 500 or p_note ~ '[[:cntrl:]]'))
      or (p_action = 'request_changes' and p_note is null) then
    raise exception 'invalid automation review' using errcode = '22023';
  end if;
  next_status := case p_action when 'approve' then 'approved' else 'changes_requested' end;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  update public.organization_automation_definitions d
     set review_status = next_status,
         review_version = d.version,
         reviewed_by = actor,
         reviewed_at = pg_catalog.now(),
         review_note = p_note,
         updated_at = pg_catalog.now()
   where d.id = p_definition_id
     and d.organization_id = org
     and d.version = p_expected_version
     and d.review_status = 'submitted'
   returning d.* into saved;
  if saved.id is null then raise exception 'submitted definition changed' using errcode = 'PT409'; end if;
  insert into public.organization_automation_definition_reviews (
    organization_id, definition_id, definition_version, action, actor_id, note, snapshot_digest
  ) values (org, saved.id, saved.version, next_status, actor, p_note, private.automation_v3_snapshot_digest(saved));
  perform private.learning_journal_append('automation_definition_save', 'public.organization_automation_definitions', saved.id::text);
  perform private.cr108_record_audit(org, 'automation_definition_' || next_status, 'update', 'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('reviewStatus', saved.review_status, 'version', saved.version, 'selfReview', saved.submitted_by = actor), extensions.gen_random_uuid());
  return private.automation_v3_definition_json(saved, actor, org);
end;
$function$;

-- public.mi1_save_automation_definition_v2(jsonb), from 20261104111500_learning_period_messages_notices_invites_exports.sql: 1 refusal
create or replace function public.mi1_save_automation_definition_v2(p_definition jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  saved public.organization_automation_definitions%rowtype;
  definition_id uuid;
  approver boolean;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_author();
  approver := private.automation_v3_actor_is_approver(actor, org);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.automation_v3_require_author() is distinct from org then
    raise exception 'organization changed' using errcode = '42501';
  end if;
  perform private.automation_v2_validate(org, p_definition);
  definition_id := (p_definition->>'id')::uuid;
  if not approver and not ((p_definition->'conditions') ? 'chapterId' or (p_definition->'conditions') ? 'sourceId') then
    raise exception 'staff drafts require visible chapter or source scope' using errcode = '42501';
  end if;

  if definition_id is null then
    if p_definition ? 'expectedVersion' then
      raise exception 'new definition cannot have version' using errcode = '22023';
    end if;
    perform private.automation_definition_creation_admit(org);
    insert into public.organization_automation_definitions (
      organization_id, name, trigger_kind, threshold_days, task_priority,
      cadence, action_kind, schema_version, conditions, action_config,
      created_by, updated_by, review_status, review_version
    ) values (
      org, pg_catalog.btrim(p_definition->>'name'), p_definition->>'triggerKind',
      (p_definition->>'thresholdDays')::smallint, p_definition->>'taskPriority',
      p_definition->>'cadence', p_definition->>'actionKind', 2,
      p_definition->'conditions', p_definition->'actionConfig', actor, actor,
      'draft', null
    ) returning * into saved;
  else
    update public.organization_automation_definitions d
       set name = pg_catalog.btrim(p_definition->>'name'),
           trigger_kind = p_definition->>'triggerKind',
           threshold_days = (p_definition->>'thresholdDays')::smallint,
           task_priority = p_definition->>'taskPriority',
           cadence = p_definition->>'cadence',
           action_kind = p_definition->>'actionKind',
           schema_version = 2,
           conditions = p_definition->'conditions',
           action_config = p_definition->'actionConfig',
           version = d.version + 1,
           updated_by = actor,
           updated_at = pg_catalog.now(),
           review_status = 'draft',
           review_version = null,
           submitted_by = null,
           submitted_at = null,
           reviewed_by = null,
           reviewed_at = null,
           review_note = null
     where d.id = definition_id
       and d.organization_id = org
       and d.version = (p_definition->>'expectedVersion')::integer
       and d.status <> 'archived'
       and (approver or (d.created_by = actor and d.review_status in ('draft', 'changes_requested')))
     returning d.* into saved;
    if saved.id is null then
      raise exception 'definition changed or is not editable' using errcode = 'PT409';
    end if;
  end if;

  perform private.learning_journal_append('automation_definition_save', 'public.organization_automation_definitions', saved.id::text);
  perform private.cr108_record_audit(
    org,
    case when definition_id is null then 'automation_definition_created' else 'automation_definition_updated' end,
    case when definition_id is null then 'create' else 'update' end,
    'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('status', saved.status, 'reviewStatus', saved.review_status, 'version', saved.version),
    extensions.gen_random_uuid()
  );
  return private.automation_v3_definition_json(saved, actor, org);
end;
$function$;

-- public.mi1_submit_automation_definition(uuid, integer), from 20261104111500_learning_period_messages_notices_invites_exports.sql: 1 refusal
create or replace function public.mi1_submit_automation_definition(
  p_definition_id uuid,
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
  approver boolean;
  saved public.organization_automation_definitions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_author();
  approver := private.automation_v3_actor_is_approver(actor, org);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  update public.organization_automation_definitions d
     set review_status = 'submitted',
         review_version = d.version,
         submitted_by = actor,
         submitted_at = pg_catalog.now(),
         reviewed_by = null,
         reviewed_at = null,
         review_note = null,
         updated_at = pg_catalog.now()
   where d.id = p_definition_id
     and d.organization_id = org
     and d.version = p_expected_version
     and d.status <> 'archived'
     and d.review_status in ('draft', 'changes_requested')
     and (approver or d.created_by = actor)
   returning d.* into saved;
  if saved.id is null then raise exception 'definition changed or cannot be submitted' using errcode = 'PT409'; end if;
  insert into public.organization_automation_definition_reviews (
    organization_id, definition_id, definition_version, action, actor_id, snapshot_digest
  ) values (org, saved.id, saved.version, 'submitted', actor, private.automation_v3_snapshot_digest(saved));
  perform private.learning_journal_append('automation_definition_save', 'public.organization_automation_definitions', saved.id::text);
  perform private.cr108_record_audit(org, 'automation_definition_submitted', 'update', 'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('reviewStatus', saved.review_status, 'version', saved.version), extensions.gen_random_uuid());
  return private.automation_v3_definition_json(saved, actor, org);
end;
$function$;

-- public.move_chapter_task(uuid, text, text, uuid, timestamp with time zone), from 20261103183000_learning_period_tasks.sql: 1 refusal
create or replace function public.move_chapter_task(
  p_task_id uuid,
  p_workstream text,
  p_status text,
  p_before_id uuid default null,
  p_expected_updated_at timestamptz default null
)
returns setof public.chapter_tasks
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  moving public.chapter_tasks%rowtype;
  before_task public.chapter_tasks%rowtype;
  previous_index integer;
  next_index integer;
  candidate integer;
  partition_count integer;
  spacing integer;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select t.* into moving
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
  for update of t;

  if moving.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  learning_before := private.learning_task_state(moving.id);
  if p_expected_updated_at is not null and moving.updated_at is distinct from p_expected_updated_at then
    raise exception 'task changed; retry move' using errcode = 'PT409';
  end if;
  if p_workstream is null or btrim(p_workstream) = '' or p_status is null then
    raise exception 'target partition required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('chapter_tasks.move:' || moving.chapter_id, 0));

  if p_before_id is not null then
    select t.* into before_task
    from public.chapter_tasks t
    where t.id = p_before_id
      and t.id <> moving.id
      and t.chapter_id = moving.chapter_id
      and t.deleted_at is null
      and t.workstream = btrim(p_workstream)
      and t.status = p_status
    for update;
    if before_task.id is null then
      raise exception 'before task is outside target partition' using errcode = '22023';
    end if;
    next_index := before_task.order_index;
    select max(t.order_index) into previous_index
    from public.chapter_tasks t
    where t.chapter_id = moving.chapter_id and t.deleted_at is null
      and t.workstream = btrim(p_workstream) and t.status = p_status
      and t.id not in (moving.id, before_task.id)
      and (t.order_index, t.created_at, t.id) < (before_task.order_index, before_task.created_at, before_task.id);
  else
    select max(t.order_index) into previous_index
    from public.chapter_tasks t
    where t.chapter_id = moving.chapter_id and t.deleted_at is null
      and t.workstream = btrim(p_workstream) and t.status = p_status
      and t.id <> moving.id;
    next_index := null;
  end if;

  candidate := case
    when previous_index is null and next_index is null then 1000
    when previous_index is null then greatest(next_index / 2, 0)
    when next_index is null then previous_index + 1000
    else (previous_index + next_index) / 2
  end;

  if candidate between 0 and 1000000
     and (previous_index is null or candidate > previous_index)
     and (next_index is null or candidate < next_index) then
    return query
    update public.chapter_tasks t
       set workstream = btrim(p_workstream), status = p_status, order_index = candidate
     where t.id = moving.id
     returning t.*;
    perform private.learning_task_journal('task_move', moving.id, learning_before);
    return;
  end if;

  select count(*) + 1 into partition_count
  from public.chapter_tasks t
  where t.chapter_id = moving.chapter_id and t.deleted_at is null
    and t.workstream = btrim(p_workstream) and t.status = p_status
    and t.id <> moving.id;
  spacing := greatest(1, floor(1000000.0 / (partition_count + 1))::integer);

  return query
  with existing as (
    select t.id,
           row_number() over (order by t.order_index, t.created_at, t.id)::numeric as sort_position
    from public.chapter_tasks t
    where t.chapter_id = moving.chapter_id and t.deleted_at is null
      and t.workstream = btrim(p_workstream) and t.status = p_status
      and t.id <> moving.id
  ), desired as (
    select e.id, e.sort_position from existing e
    union all
    select moving.id,
           coalesce((select e.sort_position - 0.5 from existing e where e.id = p_before_id), partition_count::numeric + 0.5)
  ), ranked as (
    select d.id, row_number() over (order by d.sort_position, d.id)::integer as rank
    from desired d
  ), changed as (
    update public.chapter_tasks t
       set workstream = btrim(p_workstream),
           status = p_status,
           order_index = ranked.rank * spacing
      from ranked
     where t.id = ranked.id
     returning t.*
  )
  select * from changed;
  perform private.learning_task_journal('task_move', moving.id, learning_before);
end;
end
$$;

-- public.persist_compass_message_briefing(text, uuid, text, jsonb, text), from 20261013040000_compass_source_organization_scope.sql: 1 refusal
create or replace function public.persist_compass_message_briefing(
  p_source_kind text,
  p_target_id uuid,
  p_summary text,
  p_action_items jsonb,
  p_source_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  actor uuid;
  saved public.compass_message_briefings%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org := private.engagement_selected_organization();
  actor := (select auth.uid());
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if not private.engagement_can_read_message_target(p_source_kind, p_target_id)
     or not private.compass_source_in_organization(p_source_kind, p_target_id, org) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_summary, ''))) not between 1 and 4000
     or pg_catalog.jsonb_typeof(p_action_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_action_items) > 12 then
    raise exception 'invalid briefing result' using errcode = '22023';
  end if;
  perform private.lock_message_lifecycle();
  if p_source_revision is null or p_source_revision is distinct from
    (public.get_message_briefing_context(p_source_kind, p_target_id)->>'sourceRevision') then
    raise exception 'message source changed; request a new briefing' using errcode = 'PT409';
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

-- public.publish_platform_announcement(uuid, integer), from 20261029235622_platform_announcements_consumers_and_controls.sql: 2 refusals
create or replace function public.publish_platform_announcement(p_id uuid,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; a private.platform_announcements; predecessor private.platform_announcements;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);org:=private.platform_announcement_context(true);
 select * into a from private.platform_announcements where id=p_id and organization_id=org for update;
 if a.id is null then raise exception 'platform updates unavailable' using errcode='42501'; end if;
 if a.revision is distinct from p_expected_revision or a.state<>'reviewed' or a.expires_at<=clock_timestamp() then raise exception 'platform update revision changed' using errcode='PT409'; end if;
 -- Both the post and its predecessor are revalidated under the graph lock.
 if a.supersedes_id is not null then
  select * into predecessor from private.platform_announcements
   where id=a.supersedes_id and organization_id=org for update;
  if predecessor.id is null or predecessor.state<>'published' or predecessor.expires_at<=clock_timestamp() then
   raise exception 'platform update revision changed' using errcode='PT409';
  end if;
 end if;
 update private.platform_announcements set state='published',published_at=clock_timestamp() where id=a.id;
 if a.supersedes_id is not null then
  update private.platform_announcements set state='withdrawn' where id=a.supersedes_id and organization_id=org and state='published';
  insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision,publisher_assurance)
   select org,auth.uid(),'withdraw',id,revision,'aal2' from private.platform_announcements where id=a.supersedes_id and organization_id=org;
 end if;
 insert into private.platform_announcement_delivery_jobs(organization_id,announcement_id,revision) values(org,a.id,a.revision);
 insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision,publisher_assurance) values(org,auth.uid(),'publish',a.id,a.revision,'aal2');
 return jsonb_build_object('id',a.id,'revision',a.revision,'state','published');
end;
$function$;

-- public.review_platform_announcement(uuid, integer), from 20261029141540_platform_announcements_backend.sql: 1 refusal
create or replace function public.review_platform_announcement(p_id uuid,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; a private.platform_announcements;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);org:=private.platform_announcement_context(true);
 select * into a from private.platform_announcements where id=p_id and organization_id=org for update;
 if a.id is null then raise exception 'platform updates unavailable' using errcode='42501'; end if;
 if a.revision is distinct from p_expected_revision or a.state<>'draft' or a.expires_at<=clock_timestamp() then raise exception 'platform update revision changed' using errcode='PT409'; end if;
 update private.platform_announcements set state='reviewed',reviewed_at=clock_timestamp() where id=a.id;
 insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision,publisher_assurance) values(org,auth.uid(),'review',a.id,a.revision,'aal2');
 return jsonb_build_object('id',a.id,'revision',a.revision,'state','reviewed');
end;
$function$;

-- public.save_chapter_budget(uuid, text, uuid, integer, text, date, date, text, jsonb), from 20261009003000_chapter_officer_budgets.sql: 2 refusals
create or replace function public.save_chapter_budget(p_expected_org uuid, p_expected_chapter text, p_id uuid, p_revision integer, p_title text, p_period_start date, p_period_end date, p_notes text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare ctx record; line jsonb; saved private.chapter_budgets%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then raise exception 'MFA required' using errcode = '42501'; end if;
  select * into ctx from private.chapter_budget_context(p_expected_org, p_expected_chapter);
  if not ctx.can_read then raise exception 'budget office required' using errcode = '42501'; end if;
  if p_title is null or pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 1 and 160
     or p_period_start is null or p_period_end is null or p_period_end < p_period_start
     or p_notes is null or pg_catalog.char_length(p_notes) > 4000
     or p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid budget' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_items) not between 1 and 100 or pg_catalog.octet_length(p_items::text) > 65536 then
    raise exception 'invalid budget items' using errcode = '22023';
  end if;
  for line in select value from pg_catalog.jsonb_array_elements(p_items) loop
    if pg_catalog.jsonb_typeof(line) <> 'object' or line - array['name','planned','actual'] <> '{}'::jsonb
       or not line ?& array['name','planned','actual']
       or pg_catalog.jsonb_typeof(line->'name') <> 'string'
       or pg_catalog.char_length(pg_catalog.btrim(line->>'name')) not between 1 and 160
       or pg_catalog.jsonb_typeof(line->'planned') <> 'number' or pg_catalog.jsonb_typeof(line->'actual') <> 'number' then
      raise exception 'invalid budget item' using errcode = '22023';
    end if;
    if abs((line->>'planned')::numeric) > 9999999999.99 or abs((line->>'actual')::numeric) > 9999999999.99
       or (line->>'planned')::numeric <> round((line->>'planned')::numeric, 2)
       or (line->>'actual')::numeric <> round((line->>'actual')::numeric, 2) then
      raise exception 'invalid budget amount' using errcode = '22023';
    end if;
  end loop;
  if p_id is null then
    if p_revision is distinct from 0 then raise exception 'budget conflict' using errcode = 'PT409'; end if;
    insert into private.chapter_budgets (organization_id, chapter_id, title, period_start, period_end, notes, items)
      values (ctx.organization_id, ctx.chapter_id, pg_catalog.btrim(p_title), p_period_start, p_period_end, p_notes, p_items)
      returning * into saved;
  else
    update private.chapter_budgets set title = pg_catalog.btrim(p_title), period_start = p_period_start,
      period_end = p_period_end, notes = p_notes, items = p_items, revision = revision + 1
      where id = p_id and organization_id = ctx.organization_id and chapter_id = ctx.chapter_id and revision = p_revision
      returning * into saved;
    if not found then raise exception 'budget conflict' using errcode = 'PT409'; end if;
  end if;
  insert into public.organization_audit_ledger
    (organization_id, domain, event_type, action, actor_user_id, entity_type, entity_id, idempotency_key, metadata)
  values (ctx.organization_id, 'administration', 'chapter_budget_saved', case when p_id is null then 'create' else 'update' end,
    (select auth.uid()), 'document', saved.id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('chapterId', ctx.chapter_id));
  return pg_catalog.to_jsonb(saved);
end;
$function$;

-- public.save_chapter_financial_document(uuid, text, uuid, integer, text, text, text, text, uuid), from 20261102014446_chapter_treasurer_financial_duties.sql: 2 refusals
create or replace function public.save_chapter_financial_document(p_org uuid,p_chapter text,p_id uuid,p_revision integer,p_kind text,p_title text,p_body text,p_status text,p_budget uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare target private.chapter_financial_documents%rowtype; snapshot jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  perform private.member_pin_require_full_session();
  perform private.chapter_finance_context(p_org,p_chapter);
  if not private.chapter_finance_can(p_chapter,'finance_documents') then raise exception 'financial document access required' using errcode='42501'; end if;
  if p_status is null or p_status not in ('draft','published','archived') or p_kind is null or p_kind not in ('budget','financial_report','meeting_report','financial_notice')
    or p_title is null or char_length(btrim(p_title)) not between 1 and 160 or p_body is null or char_length(btrim(p_body)) not between 1 and 100000 then raise exception 'invalid financial document' using errcode='22023'; end if;
  if p_id is not null then
    select * into target from private.chapter_financial_documents d where d.id=p_id and d.organization_id=p_org and d.chapter_id=p_chapter for update;
    if not found or target.revision is distinct from p_revision then raise exception 'financial document conflict' using errcode='PT409'; end if;
    -- Editing a published report also changes what members see immediately.
    if (p_status='published' or target.status='published') and not private.chapter_finance_can(p_chapter,'finance_publish') then raise exception 'financial publication access required' using errcode='42501'; end if;
  elsif p_revision is distinct from 0 then raise exception 'financial document conflict' using errcode='PT409';
  end if;
  if p_status='published' and not private.chapter_finance_can(p_chapter,'finance_publish') then raise exception 'financial publication access required' using errcode='42501'; end if;
  -- A budget stays protected when the requested update changes its kind.
  if (p_kind='budget' or target.kind='budget') and not private.chapter_finance_can(p_chapter,'finance_records') then
    raise exception 'financial record access required' using errcode='42501';
  end if;
  if p_kind='budget' then
    select jsonb_build_object('title',b.title,'periodStart',b.period_start,'periodEnd',b.period_end,'notes',b.notes,'items',b.items,'revision',b.revision) into snapshot
      from private.chapter_budgets b where b.id=p_budget and b.organization_id=p_org and b.chapter_id=p_chapter for share;
    if not found then raise exception 'budget unavailable' using errcode='42501'; end if;
  elsif p_budget is not null then raise exception 'budget kind required' using errcode='22023'; end if;
  if p_id is null then
    insert into private.chapter_financial_documents(organization_id,chapter_id,kind,title,body,budget_snapshot,status,published_at)
      values(p_org,p_chapter,p_kind,btrim(p_title),p_body,snapshot,p_status,case when p_status='published' then now() end) returning * into target;
  else
    update private.chapter_financial_documents set kind=p_kind,title=btrim(p_title),body=p_body,budget_snapshot=snapshot,status=p_status,
      revision=revision+1,updated_at=now(),published_at=case when p_status='published' then coalesce(published_at,now()) else published_at end
      where id=p_id returning * into target;
  end if;
  insert into public.organization_audit_ledger(organization_id,domain,event_type,action,actor_user_id,entity_type,entity_id,idempotency_key,metadata)
  values(p_org,'administration','chapter_financial_document',case when p_id is null then 'create' else 'update' end,auth.uid(),'document',target.id::text,extensions.gen_random_uuid(),jsonb_build_object('chapterId',p_chapter,'sourceKind',p_kind,'status',p_status));
  return to_jsonb(target);
end;
$function$;

-- public.save_configured_workload_log(uuid, integer, jsonb, text, uuid), from 20261105192000_organization_workload_configuration.sql: 1 refusal
create or replace function public.save_configured_workload_log(p_entry_id uuid, p_version integer, p_values jsonb, p_status text, p_organization_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare org uuid; snapshot jsonb; entry public.member_workload_logs; result jsonb;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  org := private.chapter_units_context();
  if org is null then raise exception 'organization membership and MFA required' using errcode = '42501'; end if;
  if p_organization_id is distinct from org then raise exception 'workload organization changed; reload' using errcode = '42501', detail = 'workload_configuration_changed'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-workload-' || (select auth.uid())::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workload-config-' || org::text, 509));
  if p_entry_id is null then snapshot := private.workload_configuration_payload(org);
  else
    select * into entry from public.member_workload_logs w where w.id = p_entry_id and w.user_id = (select auth.uid()) and w.workload_configuration ->> 'organizationId' = org::text for update;
    if not found then raise exception 'workload entry unavailable' using errcode = '42501'; end if;
    snapshot := entry.workload_configuration;
  end if;
  if p_version is distinct from (snapshot ->> 'version')::integer then raise exception 'workload configuration changed; reload' using errcode = 'PT409', detail = 'workload_configuration_changed'; end if;
  p_values := private.validate_workload_values(snapshot -> 'definition', p_values, p_status, (snapshot ->> 'version')::integer = 0);
  if p_entry_id is null then
    result := public.submit_workload_log(
      coalesce((p_values ->> 'priority')::integer, 0), coalesce((p_values ->> 'pending')::integer, 0), coalesce((p_values ->> 'unread_docs')::integer, 0), coalesce((p_values ->> 'todos')::integer, 0),
      coalesce((p_values ->> 'referrals')::integer, 0), coalesce((p_values ->> 'ce_activities')::integer, 0), coalesce((p_values ->> 'assistance_requests')::integer, 0), coalesce((p_values ->> 'aged_cases')::integer, 0),
      coalesce((p_values ->> 'weeklyAssigned')::integer, 0), coalesce(p_values ->> 'employment', 'full_time'), coalesce((p_values ->> 'ptHours')::integer, 20),
      coalesce((p_values ->> 'onPlan')::boolean, false), coalesce((p_values ->> 'otWorked')::boolean, false), coalesce((p_values ->> 'otHours')::integer, 0), p_values ->> 'leaveType', p_values ->> 'leaveTiming',
      coalesce((p_values ->> 'noIntake')::boolean, false), coalesce((p_values ->> 'halfDay')::boolean, false), p_values ->> 'note',
      pg_catalog.jsonb_build_object('workloadVersion', p_version, 'workloadValues', p_values, 'workloadStatus', p_status, 'workedOn', p_values -> 'workedOn', 'hoursWorked', p_values -> 'hoursWorked'));
    return result;
  end if;
  update public.member_workload_logs set workload_values = p_values, workload_status = p_status
  where id = p_entry_id;
  return pg_catalog.jsonb_build_object('id', p_entry_id, 'updated', true, 'awardedPoints', 0);
end;
end;
$function$;

-- public.save_member_operational_profile(uuid, integer, jsonb, uuid): 1 refusal. The installed body (pg_get_functiondef), because a later
-- migration rewrote the body 20260830160000_member_operations_completion.sql created in place.
CREATE OR REPLACE FUNCTION public.save_member_operational_profile(p_member_user_id uuid, p_expected_version integer, p_fields jsonb, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.require_member_operations_admin();
  current_version integer;
  result jsonb;
  request_payload jsonb;
  prior jsonb;
  allowed text[] := array['memberNumber','jobTitle','department','workLocation','hireDate','membershipClass','preferredLanguage','administrativeNotes'];
begin
  if p_member_user_id is null or p_idempotency_key is null or pg_catalog.jsonb_typeof(p_fields) <> 'object'
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_fields) key where key <> all(allowed)) then
    raise exception 'invalid member record' using errcode = '22023';
  end if;
  request_payload := pg_catalog.jsonb_build_object(
    'memberUserId', p_member_user_id,
    'expectedVersion', coalesce(p_expected_version, 0),
    'fieldsSha256', pg_catalog.encode(extensions.digest(p_fields::text, 'sha256'), 'hex')
  );
  prior := private.member_operations_replay(
    org, 'save_member_operational_profile', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  if not exists (select 1 from public.organization_memberships membership
    where membership.organization_id = org and membership.user_id = p_member_user_id
      and membership.status = 'active' and membership.revoked_at is null) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select profile.version into current_version from public.organization_member_operational_profiles profile
  where profile.organization_id = org and profile.member_user_id = p_member_user_id for update;
  current_version := coalesce(current_version, 0);
  if current_version <> coalesce(p_expected_version, 0) then
    raise exception 'stale member record' using errcode = 'PT409';
  end if;
  insert into public.organization_member_operational_profiles (
    organization_id, member_user_id, member_number, job_title, department, work_location,
    hire_date, membership_class, preferred_language, administrative_notes, version, updated_by
  ) values (
    org, p_member_user_id,
    nullif(pg_catalog.btrim(p_fields ->> 'memberNumber'), ''),
    nullif(pg_catalog.btrim(p_fields ->> 'jobTitle'), ''),
    nullif(pg_catalog.btrim(p_fields ->> 'department'), ''),
    nullif(pg_catalog.btrim(p_fields ->> 'workLocation'), ''),
    nullif(p_fields ->> 'hireDate', '')::date,
    nullif(pg_catalog.btrim(p_fields ->> 'membershipClass'), ''),
    nullif(p_fields ->> 'preferredLanguage', ''),
    nullif(pg_catalog.btrim(p_fields ->> 'administrativeNotes'), ''),
    current_version + 1, (select auth.uid())
  ) on conflict (organization_id, member_user_id) do update
    set member_number = excluded.member_number, job_title = excluded.job_title,
        department = excluded.department, work_location = excluded.work_location,
        hire_date = excluded.hire_date, membership_class = excluded.membership_class,
        preferred_language = excluded.preferred_language,
        administrative_notes = excluded.administrative_notes,
        version = excluded.version, updated_by = excluded.updated_by, updated_at = pg_catalog.now();
  perform private.mi1_w2_write_audit(org, 'member_profile_updated', pg_catalog.jsonb_build_object(
    'organizationId', org, 'userId', p_member_user_id, 'fields',
    (select coalesce(pg_catalog.jsonb_agg(key order by key), '[]'::jsonb) from pg_catalog.jsonb_object_keys(p_fields) key),
    'version', current_version + 1
  ));
  result := public.get_member_operational_profile(p_member_user_id);
  perform private.member_operations_store_receipt(
    org, 'save_member_operational_profile', p_idempotency_key, request_payload, result
  );
  return result;
end;
end;
$function$;

-- public.save_organization_automation_definition(uuid, text, text, integer, text, text, integer), from 20261104111500_learning_period_messages_notices_invites_exports.sql: 1 refusal
create or replace function public.save_organization_automation_definition(p_definition_id uuid, p_name text, p_trigger_kind text, p_threshold_days integer, p_cadence text, p_task_priority text, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    perform private.automation_definition_creation_admit(org);
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
      raise exception 'automation definition changed; reload before saving' using errcode = 'PT409';
    end if;
  end if;

  perform private.learning_journal_append('automation_definition_save', 'public.organization_automation_definitions', saved.id::text);
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

-- public.save_organization_workload_configuration(jsonb, integer, uuid), from 20261105192000_organization_workload_configuration.sql: 1 refusal
create or replace function public.save_organization_workload_configuration(p_definition jsonb, p_expected_version integer, p_expected_organization_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare org uuid; previous jsonb;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  org := private.chapter_units_context();
  if org is null or not private.has_organization_role(org, array['admin']) then raise exception 'organization admin and MFA required' using errcode = '42501'; end if;
  if p_expected_organization_id is distinct from org then raise exception 'workload organization changed; reload' using errcode = '42501', detail = 'workload_configuration_changed'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workload-config-' || org::text, 509));
  previous := private.workload_configuration_payload(org);
  if p_expected_version is distinct from (previous ->> 'version')::integer then raise exception 'workload configuration changed; reload' using errcode = 'PT409', detail = 'workload_configuration_changed'; end if;
  perform private.validate_workload_definition(p_definition);
  -- Keys cannot disappear or be resurrected: retirement is explicit, and an
  -- old entry can still be edited with the definition it originally used.
  if exists (select 1 from pg_catalog.jsonb_array_elements(previous -> 'definition' -> 'fields') old(value)
    where not exists (select 1 from pg_catalog.jsonb_array_elements(p_definition -> 'fields') next(value)
      where next.value ->> 'key' = old.value ->> 'key' and (not (old.value ->> 'retired')::boolean or (next.value ->> 'retired')::boolean))) then
    raise exception 'retire workload fields instead of removing or reusing them' using errcode = '22023';
  end if;
  insert into private.organization_workload_configuration_versions(organization_id, version, definition)
  values (org, p_expected_version + 1, p_definition);
  insert into public.organization_configuration_audit(organization_id, actor_user_id, action, item_key, previous_value, new_value)
  values (org, (select auth.uid()), 'setting_updated', 'workload.configuration',
    pg_catalog.jsonb_build_object('organizationId', org, 'version', (previous ->> 'version')::integer),
    pg_catalog.jsonb_build_object('organizationId', org, 'version', p_expected_version + 1));
  return public.get_organization_workload_configuration();
end;
end;
$function$;

-- public.save_platform_announcement_draft(uuid, integer, text, text, text, text, timestamp with time zone, uuid), from 20261029141540_platform_announcements_backend.sql: 2 refusals
create or replace function public.save_platform_announcement_draft(p_id uuid,p_expected_revision integer,p_title_en text,p_title_es text,p_body_en text,p_body_es text,p_expires_at timestamptz,p_supersedes_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; a private.platform_announcements;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
 org:=private.platform_announcement_context(true);
 if p_expires_at is null or p_expires_at<=clock_timestamp() then raise exception 'invalid platform update expiry' using errcode='22023'; end if;
 if p_supersedes_id is not null and not exists(select 1 from private.platform_announcements where id=p_supersedes_id and organization_id=org and state='published') then raise exception 'platform updates unavailable' using errcode='42501'; end if;
 if p_id is null then
  if p_expected_revision is distinct from 0 then raise exception 'platform update revision changed' using errcode='PT409'; end if;
  insert into private.platform_announcements(organization_id,title_en,title_es,body_en,body_es,expires_at,supersedes_id)
   values(org,p_title_en,p_title_es,p_body_en,p_body_es,p_expires_at,p_supersedes_id) returning * into a;
 else
  select * into a from private.platform_announcements where id=p_id and organization_id=org for update;
  if a.id is null then raise exception 'platform updates unavailable' using errcode='42501'; end if;
  if a.revision is distinct from p_expected_revision or a.state not in ('draft','reviewed') then raise exception 'platform update revision changed' using errcode='PT409'; end if;
  update private.platform_announcements set revision=revision+1,title_en=p_title_en,title_es=p_title_es,
   body_en=p_body_en,body_es=p_body_es,expires_at=p_expires_at,supersedes_id=p_supersedes_id,state='draft',reviewed_at=null
   where id=a.id returning * into a;
 end if;
 insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision,publisher_assurance) values(org,auth.uid(),'draft',a.id,a.revision,'aal2');
 return jsonb_build_object('id',a.id,'revision',a.revision,'state',a.state);
end;
$function$;

-- public.save_scoped_institutional_record(uuid, text, text, text, timestamp with time zone, text, text, boolean, text, integer, jsonb, uuid, uuid, text, uuid), from 20261102005607_unit_committee_scoped_access.sql: 1 refusal
create or replace function public.save_scoped_institutional_record(
  p_record_id uuid,
  p_record_type text,
  p_title text,
  p_body text,
  p_occurred_at timestamptz,
  p_visibility text default 'chapter',
  p_action text default 'save',
  p_pinned boolean default false,
  p_gap_note text default null,
  p_expected_version integer default null,
  p_attendance jsonb default '[]'::jsonb,
  p_access_unit_id uuid default null,
  p_access_committee_id uuid default null,
  p_expected_chapter text default null,
  p_expected_organization uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare
  ctx record;
  target public.chapter_records%rowtype;
  next_status text;
  next_version integer;
  attendee jsonb;
  recipient record;
  delivered integer := 0;
begin
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:'||private.current_member_organization()::text,509));
  select * into ctx from private.institutional_context(false);
  if (p_expected_chapter is not null and p_expected_chapter is distinct from ctx.chapter_id)
    or (p_expected_organization is not null and p_expected_organization is distinct from ctx.organization_id) then
    raise exception 'chapter context changed' using errcode='42501';
  end if;
  if not private.chapter_record_manageable(ctx.chapter_id,p_access_unit_id,p_access_committee_id)
    or (p_access_unit_id is not null and p_access_committee_id is not null)
    or (p_access_unit_id is not null and not exists(select 1 from private.chapter_units where id=p_access_unit_id and chapter_id=ctx.chapter_id))
    or (p_access_committee_id is not null and not exists(select 1 from private.chapter_committees where id=p_access_committee_id and chapter_id=ctx.chapter_id)) then
    raise exception 'record outside access scope' using errcode='42501';
  end if;
  if p_record_type in ('management_contact','member_contact') and not private.can_read_chapter_contact_record(ctx.chapter_id) then raise exception 'contact access required' using errcode='42501'; end if;
  if p_record_type not in ('minutes','decision','milestone','management_contact','member_contact')
     or p_visibility not in ('chapter','staff')
     or p_action not in ('save','publish','archive')
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title, ''))) not between 1 and 200
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_body, ''))) not between 1 and 20000
     or p_occurred_at is null
     or pg_catalog.char_length(coalesce(p_gap_note, '')) > 1000
     or pg_catalog.jsonb_typeof(coalesce(p_attendance, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_attendance, '[]'::jsonb)) > 1000 then
    raise exception 'invalid institutional record' using errcode = '22023';
  end if;

  next_status := case p_action when 'publish' then 'published' when 'archive' then 'archived' else 'draft' end;
  if p_record_id is null then
    insert into public.chapter_records (
      chapter_id, record_type, title, body, occurred_at, created_by,
      lifecycle_status, visibility, version, published_at, updated_at, pinned_at, gap_note, archived_at, access_unit_id, access_committee_id
    ) values (
      ctx.chapter_id, p_record_type, pg_catalog.btrim(p_title), pg_catalog.btrim(p_body), p_occurred_at, ctx.caller_id,
      next_status, p_visibility, 1,
      case when next_status = 'published' then pg_catalog.now() end,
      pg_catalog.now(), case when p_pinned then pg_catalog.now() end, nullif(pg_catalog.btrim(p_gap_note), ''),
      case when next_status = 'archived' then pg_catalog.now() end, p_access_unit_id, p_access_committee_id
    ) returning * into target;
  else
    select * into target from public.chapter_records r
    where r.id = p_record_id and r.chapter_id = ctx.chapter_id
    for update;
    if target.id is null then raise exception 'record not found' using errcode = 'P0002'; end if;
    if not private.chapter_record_manageable(target.chapter_id,target.access_unit_id,target.access_committee_id)
      or (target.record_type in ('management_contact','member_contact') and not private.can_read_chapter_contact_record(ctx.chapter_id)) then
      raise exception 'record outside access scope' using errcode='42501';
    end if;
    if p_expected_version is null or target.version <> p_expected_version then
      raise exception 'record changed; reload before saving' using errcode = 'PT409';
    end if;
    next_version := target.version + 1;
    update public.chapter_records r set
      access_unit_id=p_access_unit_id, access_committee_id=p_access_committee_id,
      record_type = p_record_type,
      title = pg_catalog.btrim(p_title),
      body = pg_catalog.btrim(p_body),
      occurred_at = p_occurred_at,
      lifecycle_status = next_status,
      visibility = p_visibility,
      version = next_version,
      published_at = case when next_status = 'published' then pg_catalog.now() else r.published_at end,
      updated_at = pg_catalog.now(),
      pinned_at = case when p_pinned then coalesce(r.pinned_at, pg_catalog.now()) end,
      gap_note = nullif(pg_catalog.btrim(p_gap_note), ''),
      archived_at = case when next_status = 'archived' then pg_catalog.now() end
    where r.id = target.id
    returning * into target;
  end if;

  insert into public.chapter_record_versions (
    record_id, chapter_id, version, record_type, title, body, occurred_at,
    lifecycle_status, visibility, gap_note, changed_by
  ) values (
    target.id, target.chapter_id, target.version, target.record_type, target.title, target.body,
    target.occurred_at, target.lifecycle_status, target.visibility, target.gap_note, ctx.caller_id
  );

  delete from public.meeting_attendance where record_id = target.id;
  if target.record_type = 'minutes' then
    for attendee in select value from pg_catalog.jsonb_array_elements(p_attendance)
    loop
      if attendee->>'status' not in ('present','absent','excused','guest') or not exists (
        select 1 from public.member_chapter_memberships cm
        where cm.chapter_id = ctx.chapter_id and cm.user_id = (attendee->>'userId')::uuid and cm.status = 'active'
          and private.chapter_scope_member_allowed(ctx.chapter_id,p_access_unit_id,p_access_committee_id,cm.user_id)
      ) then raise exception 'invalid meeting attendance' using errcode = '22023'; end if;
      insert into public.meeting_attendance (record_id, chapter_id, user_id, attendance_status, recorded_by)
      values (target.id, ctx.chapter_id, (attendee->>'userId')::uuid, attendee->>'status', ctx.caller_id);
    end loop;

    if p_action = 'publish' and target.visibility = 'chapter' then
      for recipient in
        select cm.user_id from public.member_chapter_memberships cm
        join public.organization_memberships om on om.user_id = cm.user_id and om.organization_id = ctx.organization_id and om.status = 'active'
        where cm.chapter_id = ctx.chapter_id and cm.status = 'active'
          and private.chapter_scope_member_allowed(ctx.chapter_id,p_access_unit_id,p_access_committee_id,cm.user_id)
      loop
        begin
          perform private.notify_member(recipient.user_id, 'institutional.minutes.published', pg_catalog.jsonb_build_object('title', target.title), 'general');
          insert into public.meeting_minutes_dispatches (record_id, chapter_id, version, recipient_id, status, delivered_at)
          values (target.id, ctx.chapter_id, target.version, recipient.user_id, 'delivered', pg_catalog.now());
          delivered := delivered + 1;
        exception when others then
          insert into public.meeting_minutes_dispatches (record_id, chapter_id, version, recipient_id, status, error_code)
          values (target.id, ctx.chapter_id, target.version, recipient.user_id, 'failed', 'notification-write-failed');
        end;
      end loop;
    end if;
  end if;

  return pg_catalog.to_jsonb(target) || pg_catalog.jsonb_build_object('delivered', delivered);
end;
end;
$function$;

-- public.save_sealed_form_draft(uuid, integer, boolean, jsonb, text), from 20261028174501_sealed_form_save_version_check.sql: 1 refusal
create or replace function public.save_sealed_form_draft(p_form_id uuid, p_step integer, p_changed boolean,
  p_filled jsonb, p_data_version text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  rec record;
  ticket_arguments jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if nullif(current_setting('app.sensitive_ticket', true), '') is null then
    raise exception 'sensitive-data-trusted-write-required' using errcode = '42501';
  end if;
  select arguments into ticket_arguments from private.sensitive_write_tickets
    where id = nullif(current_setting('app.sensitive_ticket',true),'')::uuid
      and actor = caller and operation = 'save_sealed_form_draft' and expires_at > clock_timestamp();
  perform private.lock_member_form(p_form_id);
  select id, user_id, status, template_key, encrypted_content into rec from public.member_forms where id = p_form_id for update;
  if not found or rec.user_id <> caller or not private.form_template_is_sealed(rec.template_key)
    or rec.status not in ('draft', 'returned') then
    raise exception 'form not found' using errcode = '22023';
  end if;
  if not coalesce(ticket_arguments ? 'p_expected_data_version', false)
    or (ticket_arguments->>'p_expected_data_version') is distinct from (rec.encrypted_content #>> '{answers,dataVersion}') then
    raise exception 'sensitive-data-conflict' using errcode = 'PT409';
  end if;
  if p_changed then
    delete from private.member_form_signatures where form_id = p_form_id;
    update public.member_forms
      set filer_signed_at = null, filer_signature_digest = null, content_digest = null,
        answers = pg_catalog.jsonb_build_object('sealed', true, 'filled', coalesce(p_filled, '[]'::jsonb),
          'dataVersion', p_data_version),
        step = least(greatest(coalesce(p_step, 0), 0), 50), updated_at = now()
      where id = p_form_id and user_id = caller;
  else
    update public.member_forms set step = least(greatest(coalesce(p_step, 0), 0), 50), updated_at = now()
      where id = p_form_id and user_id = caller;
  end if;
  return p_form_id;
end;
end
$$;

-- public.set_chapter_minutes_approval(uuid, integer, boolean), from 20261102005607_unit_committee_scoped_access.sql: 1 refusal
create or replace function public.set_chapter_minutes_approval(p_record_id uuid, p_expected_version integer, p_approved boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  ctx record;
  target public.chapter_records%rowtype;
begin
  select * into ctx from private.institutional_context(true);
  if p_approved is null then raise exception 'approval state required' using errcode = '22023'; end if;
  select * into target from public.chapter_records r
  where r.id = p_record_id and r.chapter_id = ctx.chapter_id
    and r.record_type = 'minutes' and r.archived_at is null
    and private.chapter_record_manageable(r.chapter_id, r.access_unit_id, r.access_committee_id)
  for update;
  if not found then raise exception 'minutes not found' using errcode = 'P0002'; end if;
  -- Approve or withdraw only what the approver was shown: a newer version
  -- refuses, so nobody approves an edit they have not read.
  if p_expected_version is distinct from target.version then
    raise exception 'minutes changed since they were opened' using errcode = 'PT409';
  end if;
  if p_approved and target.lifecycle_status <> 'published' then
    raise exception 'only published minutes can be approved' using errcode = '22023';
  end if;
  update public.chapter_records
  set approved_at = case
        when not p_approved then null
        when target.approved_version is not distinct from target.version then target.approved_at
        else pg_catalog.now() end,
      approved_by = case
        when not p_approved then null
        when target.approved_version is not distinct from target.version then target.approved_by
        else ctx.caller_id end,
      approved_version = case when p_approved then target.version else null end,
      updated_at = pg_catalog.now()
  where id = target.id
  returning * into target;
  return pg_catalog.jsonb_build_object(
    'id', target.id, 'approvedAt', target.approved_at, 'approvedBy', target.approved_by,
    'approvedVersion', target.approved_version, 'version', target.version);
end;
end;
$function$;

-- public.set_member_event_agenda(text, text, integer), from 20261104110000_learning_period_events.sql: 1 refusal
create or replace function public.set_member_event_agenda(p_id text, p_agenda text, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  learning_before jsonb;
  clean text := nullif(pg_catalog.btrim(coalesce(p_agenda, ''), ' ' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9)), '');
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  -- A stale agenda, for example one that waited behind an undo, is refused
  -- instead of reapplying what the undo took back.
  if p_expected_version is not null and ev.version is distinct from p_expected_version then
    raise exception 'this event changed; reload it before saving'
      using errcode = 'PT409', detail = 'event_changed';
  end if;

  if clean is not null and (pg_catalog.char_length(clean) > 4000
     or pg_catalog.translate(clean, pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9), '') ~ '[[:cntrl:]]') then
    raise exception 'invalid agenda' using errcode = '22023';
  end if;

  if clean is distinct from ev.agenda then
    learning_before := private.learning_event_state(p_id);
    update public.member_events set agenda = clean, version = version + 1
    where id = p_id and chapter_id = caller_chapter;
    perform private.learning_event_journal('event_edit', p_id, learning_before);

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.jsonb_build_array('agenda'),
      'isPublic', ev.is_public,
      'isPublicAcrossAgencies', ev.is_public_across_agencies));
  end if;

  return pg_catalog.jsonb_build_object('updated', clean is distinct from ev.agenda, 'agenda', clean,
    'version', (select e.version from public.member_events e where e.id = p_id));
end;
end;
$function$
;

-- public.set_member_event_organizer(text, uuid, integer), from 20261104110000_learning_period_events.sql: 1 refusal
create or replace function public.set_member_event_organizer(p_event_id text, p_organizer_id uuid, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  label text := null;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() or not private.member_can_manage_events() then
    perform private.cw_fail('not_authorized', '42501', 'staff role required', 'staff_grant_required');
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    perform private.cw_fail('not_authorized', '42501', 'staff chapter required');
  end if;
  select e.* into ev from public.member_events e
  where e.id = p_event_id and e.chapter_id = caller_chapter
  for update;
  if not found then
    perform private.cw_fail('source_unavailable', '22023', 'unknown event');
  end if;
  -- A stale organizer choice, for example one that waited behind an undo,
  -- is refused instead of reapplying what the undo took back.
  if p_expected_version is not null and ev.version is distinct from p_expected_version then
    raise exception 'this event changed; reload it before saving'
      using errcode = 'PT409', detail = 'event_changed';
  end if;
  if p_organizer_id is not null and not private.cw_event_candidate_ok(p_organizer_id, ev.id) then
    perform private.cw_fail('invalid_input', '22023', 'organizer must hold a staff grant for this chapter', 'organizer_unavailable');
  end if;

  if ev.organizer_id is distinct from p_organizer_id then
    learning_before := private.learning_event_state(ev.id);
    update public.member_events set organizer_id = p_organizer_id, version = version + 1 where id = ev.id;
    perform private.learning_event_journal('event_edit', ev.id, learning_before);
    -- Consent was given to the organizer shown at the time; a different
    -- organizer (or none) starts from no consent.
    delete from private.member_event_contact_opt_ins where event_id = ev.id;
    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', ev.id, 'chapterId', ev.chapter_id, 'fields', pg_catalog.jsonb_build_array('organizer')));
  end if;

  if p_organizer_id is not null then
    select coalesce(nullif(pg_catalog.btrim(pr.full_name), ''), 'Organizer') into label
    from public.member_profiles pr where pr.id = p_organizer_id;
  end if;
  return pg_catalog.jsonb_build_object(
    'eventId', ev.id,
    'organizer', case when p_organizer_id is null then null
      else pg_catalog.jsonb_build_object('id', p_organizer_id, 'label', label) end,
    'changed', ev.organizer_id is distinct from p_organizer_id,
    'version', (select e.version from public.member_events e where e.id = ev.id));
end;
end;
$function$
;

-- public.set_member_event_rsvp_open(text, boolean, integer), from 20261106120000_event_rsvp_open_expected_version.sql: 1 refusal
create or replace function public.set_member_event_rsvp_open(p_id text, p_open boolean, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if p_open is null then
    raise exception 'rsvp switch is required' using errcode = '22023';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  -- A stale switch, for example one that waited behind an undo, is refused
  -- instead of reapplying what the undo took back.
  if p_expected_version is not null and ev.version is distinct from p_expected_version then
    raise exception 'this event changed; reload it before saving'
      using errcode = 'PT409', detail = 'event_changed';
  end if;

  if ev.rsvp_open is distinct from p_open then
    learning_before := private.learning_event_state(p_id);
    update public.member_events set rsvp_open = p_open, version = version + 1
    where id = p_id and chapter_id = caller_chapter;
    perform private.learning_event_journal('event_edit', p_id, learning_before);

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.jsonb_build_array('rsvp_open'),
      'rsvpOpen', p_open,
      'isPublic', ev.is_public,
      'isPublicAcrossAgencies', ev.is_public_across_agencies));
  end if;

  return pg_catalog.jsonb_build_object('updated', ev.rsvp_open is distinct from p_open, 'rsvpOpen', p_open,
    'version', (select e.version from public.member_events e where e.id = p_id));
end;
end;
$function$;

-- public.set_organization_automation_definition_status(uuid, text, integer), from 20261104111500_learning_period_messages_notices_invites_exports.sql: 1 refusal
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
  learning_before jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_approver();
  if p_status not in ('active', 'paused', 'archived') or p_expected_version is null then
    raise exception 'invalid automation status transition' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  select pg_catalog.jsonb_build_object('status', d.status, 'next_run_at', d.next_run_at) into learning_before
  from public.organization_automation_definitions d where d.id = p_definition_id and d.organization_id = org for update;
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
  if saved.id is null then raise exception 'definition changed, unapproved, or unavailable' using errcode = 'PT409'; end if;
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
  perform private.learning_journal_append('automation_activate', 'public.organization_automation_definitions', saved.id::text, null,
    private.learning_fingerprint(private.learning_automation_state('public.organization_automation_definitions', saved.id::text)), null,
    learning_before);
  perform private.cr108_record_audit(org, 'automation_definition_status_changed', 'update', 'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('status', saved.status, 'reviewStatus', saved.review_status, 'version', saved.version), extensions.gen_random_uuid());
  return pg_catalog.jsonb_build_object('id', saved.id, 'status', saved.status, 'version', saved.version, 'nextRunAt', saved.next_run_at);
end;
$function$;

-- public.set_platform_announcement_follow(boolean, bigint, text), from 20261029235622_platform_announcements_consumers_and_controls.sql: 1 refusal
create or replace function public.set_platform_announcement_follow(p_enabled boolean,p_expected_generation bigint,p_consent_version text)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; platform uuid; f private.platform_organization_follows;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
 if p_enabled is null or p_expected_generation is null or p_expected_generation<0 then raise exception 'invalid platform update control' using errcode='22023'; end if;
 org:=private.platform_announcement_context(false,true,not p_enabled);
 select * into f from private.platform_organization_follows where organization_id=org order by generation desc limit 1 for update;
 if p_expected_generation<>coalesce(f.generation*2-case when f.revoked_at is null then 1 else 0 end,0) then raise exception 'platform update generation changed' using errcode='PT409'; end if;
 if p_enabled then
  if p_consent_version is distinct from 'platform-updates-v1' then raise exception 'invalid platform update consent' using errcode='22023'; end if;
  platform:=private.platform_announcement_platform(false);
  if platform is null then raise exception 'platform updates unavailable' using errcode='42501'; end if;
  if f.organization_id is not null and f.revoked_at is null then return public.get_platform_announcement_follow_settings(); end if;
  insert into private.platform_organization_follows(organization_id,platform_organization_id,generation,consent_version)
   values(org,platform,coalesce(f.generation,0)+1,p_consent_version) returning * into f;
 else
  if f.organization_id is null or f.revoked_at is not null then return public.get_platform_announcement_follow_settings(); end if;
  update private.platform_organization_follows set revoked_at=clock_timestamp()
   where organization_id=org and generation=f.generation;
 end if;
 insert into private.platform_announcement_audit(organization_id,actor_user_id,action,generation)
  values(org,auth.uid(),case when p_enabled then 'follow' else 'revoke' end,f.generation);
 return public.get_platform_announcement_follow_settings();
end;
$function$;

-- public.set_task_checkoff_entry(uuid, text, text, text), from 20261103183000_learning_period_tasks.sql: 1 refusal
create or replace function public.set_task_checkoff_entry(
  p_entry_id uuid,
  p_status text,
  p_note text,
  p_expected_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  learning_before jsonb;
  caller uuid;
  entry private.task_checkoff_entries%rowtype;
  list private.task_checkoff_lists%rowtype;
  scope record;
  is_manager boolean;
  next_note text;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
caller := (select auth.uid());
  -- Line breaks are kept; other control characters are dropped.
  next_note := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_note, ''), '[^[:print:][:space:]]', '', 'g'));
  if not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_entry_id is null or p_status is null or p_status not in ('pending', 'done', 'unreachable', 'follow_up') then
    raise exception 'invalid check-off status' using errcode = '22023';
  end if;
  if pg_catalog.char_length(next_note) > 500 then
    raise exception 'note must be 500 characters or fewer' using errcode = '22023';
  end if;
  select * into entry from private.task_checkoff_entries where id = p_entry_id for update;
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into scope from private.task_checkoff_scope(entry.task_id);
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(scope.organization_id, 'features.tasks.coop_checkoff_lists') then
    raise exception 'member check-off lists are turned off' using errcode = '55000';
  end if;
  select * into list from private.task_checkoff_lists where task_id = entry.task_id for update;
  if p_expected_status is distinct from entry.status then
    raise exception 'checkoff:stale' using errcode = 'PT409';
  end if;
  is_manager := coalesce(list.created_by = caller, false)
    or coalesce(private.has_organization_role(scope.organization_id, array['admin', 'vp']), false);
  if not is_manager then
    if list.status = 'closed' then
      raise exception 'checkoff:list_closed' using errcode = '42501';
    end if;
    if p_status = 'pending' and entry.status <> 'pending' then
      raise exception 'checkoff:reset_requires_manager' using errcode = '42501';
    end if;
    if entry.assigned_steward_id is not null and entry.assigned_steward_id <> caller then
      raise exception 'checkoff:assigned_to_other' using errcode = '42501';
    end if;
    if entry.status in ('done', 'unreachable') then
      raise exception 'checkoff:already_actioned' using errcode = '42501';
    end if;
    if entry.status = 'follow_up' and entry.actioned_by is distinct from caller then
      raise exception 'checkoff:follow_up_owned_by_other' using errcode = '42501';
    end if;
  end if;
  learning_before := private.learning_task_checkoff_state('private.task_checkoff_entries', entry.id::text);
  update private.task_checkoff_entries
  set status = p_status,
      note = next_note,
      actioned_by = case when p_status = 'pending' then null
        when p_status <> entry.status then caller else entry.actioned_by end,
      actioned_at = case when p_status = 'pending' then null
        when p_status <> entry.status then pg_catalog.now() else entry.actioned_at end,
      updated_at = pg_catalog.now()
  where id = entry.id;
  if p_status <> entry.status then
    insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value, to_value)
    values (entry.task_id, scope.chapter_id, caller, 'checkoff_entry_changed', entry.status, p_status);
  end if;
  perform private.learning_checkoff_journal('task_checkoff_entry', 'private.task_checkoff_entries', entry.id::text, learning_before);
  return private.task_checkoff_payload(entry.task_id, scope.organization_id);
end;
$function$;

-- public.undo_my_learning_action(uuid, integer), from 20261105181500_learning_period_undo_forward_authority.sql: 3 refusals
create or replace function public.undo_my_learning_action(p_entry_id uuid, p_expected_version integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid;
  requested private.learning_action_journal%rowtype;
  chain_ids uuid[];
  item record;
  target_key text;
  current_state jsonb;
  projected jsonb := '{}'::jsonb;
  undone integer := 0;
begin
  org := private.current_mobile_staff_organization();
  if caller is null or org is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into requested from private.learning_action_journal j
  where j.id = p_entry_id and j.actor_user_id = caller and j.organization_id = org
  for update;
  if not found then
    raise exception 'learning entry not found' using errcode = 'P0002';
  end if;
  if requested.state = 'undone' then
    return pg_catalog.jsonb_build_object('status', 'already_undone', 'entryId', requested.id, 'version', requested.version);
  end if;
  if requested.state = 'kept' then
    raise exception 'this practice action can no longer be undone' using errcode = '55000';
  end if;
  if p_expected_version is distinct from requested.version then
    raise exception 'learning entry changed' using errcode = 'PT409';
  end if;

  -- The chain: this entry, your later active entries on the same targets,
  -- and every entry of a bulk action any of them belongs to (its parent and
  -- all its children), so a bulk action is never partly reversed. A parent
  -- joins whatever its state, and one no longer active refuses the undo.
  with recursive chain(id) as (
    select requested.id
    union
    select j.id
    from chain c
    join private.learning_action_journal cj on cj.id = c.id
    join private.learning_action_journal j
      on j.organization_id = org and j.period_id = requested.period_id
     and j.actor_user_id = caller
     and ((j.state = 'active'
           and ((j.target_table = cj.target_table and j.target_id = cj.target_id
                 and (j.created_at, j.id) > (cj.created_at, cj.id))
                or j.parent_entry_id = cj.id))
          or j.id = cj.parent_entry_id)
  )
  select pg_catalog.array_agg(chain.id order by chain.id) into chain_ids from chain;
  perform 1 from private.learning_action_journal j where j.id = any(chain_ids) order by j.id for update;

  if exists (
    select 1 from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids) and (j.state <> 'active' or k.disposition not in ('reverse', 'simulate'))
  ) then
    raise exception 'this practice action can no longer be undone' using errcode = '55000';
  end if;
  -- Someone else changed one of these targets after you: undo would take
  -- their work with it. What they sent on it stays sent and does not block.
  if exists (
    select 1
    from private.learning_action_journal c
    join private.learning_action_journal o
      on o.target_table = c.target_table and o.target_id = c.target_id
     and (o.created_at, o.id) > (c.created_at, c.id)
     and o.actor_user_id is distinct from caller and o.state <> 'undone'
    join private.learning_action_kinds ok on ok.action_kind = o.action_kind and ok.disposition <> 'permanent'
    where c.id = any(chain_ids)
  ) then
    raise exception 'someone else has changed this since' using errcode = 'PT409';
  end if;

  for item in
    select distinct j.target_table, j.target_id, k.handler
    from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids) and k.disposition = 'reverse'
    order by j.target_table, j.target_id
  loop
    perform private.learning_dispatch(item.handler, 'lock',
      pg_catalog.jsonb_build_object('target_table', item.target_table, 'target_id', item.target_id));
  end loop;

  -- Every lock is held: only now read the clock.
  if private.learning_period_running(org) is distinct from requested.period_id then
    raise exception 'the learning period has ended' using errcode = '55000';
  end if;

  for item in
    select j.*, k.handler, k.disposition
    from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids)
    order by j.created_at desc, j.id desc
  loop
    if item.disposition = 'reverse' then
      target_key := item.target_table || ':' || item.target_id;
      if projected ? target_key then
        current_state := projected -> target_key;
      else
        current_state := private.learning_dispatch(item.handler, 'state',
          pg_catalog.jsonb_build_object('target_table', item.target_table, 'target_id', item.target_id));
      end if;
      if private.learning_fingerprint(current_state) is distinct from item.after_fingerprint then
        raise exception 'this has changed since your practice action' using errcode = 'PT409';
      end if;
      projected := projected || pg_catalog.jsonb_build_object(target_key,
        coalesce(private.learning_dispatch(item.handler, 'before', pg_catalog.to_jsonb(item)), 'null'::jsonb));
      -- The handler authorizes against the state this entry is validated
      -- against (an edge a later step removed is judged as it stood) and
      -- sees what the newer steps already projected (a task this chain
      -- puts back is judged live).
      perform private.learning_dispatch(item.handler, 'check',
        pg_catalog.to_jsonb(item) || pg_catalog.jsonb_build_object('projected_state', current_state, 'projected', projected,
          'chain_entry_ids', chain_ids));
    end if;
  end loop;

  for item in
    select j.*, k.handler, k.disposition
    from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids)
    order by j.created_at desc, j.id desc
  loop
    if item.disposition = 'reverse' then
      perform private.learning_dispatch(item.handler, 'apply', pg_catalog.to_jsonb(item));
    end if;
    update private.learning_action_journal j
    set state = 'undone', undone_at = pg_catalog.clock_timestamp(), version = j.version + 1
    where j.id = item.id;
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'administration', 'learning_action_undone', 'update', caller,
      'learning_action', item.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('entryId', item.id, 'actionKind', item.action_kind, 'periodId', item.period_id)
    );
    undone := undone + 1;
  end loop;

  return pg_catalog.jsonb_build_object('status', 'undone', 'entryId', requested.id,
    'version', requested.version + 1, 'undoneCount', undone);
end;
end;
$function$;

-- public.update_chapter_task_content(uuid, timestamp with time zone, text, text), from 20261103183000_learning_period_tasks.sql: 1 refusal
create or replace function public.update_chapter_task_content(
  p_task_id uuid,
  p_expected_updated_at timestamptz,
  p_title text default null,
  p_description text default null
)
returns setof public.chapter_tasks
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  current_task public.chapter_tasks%rowtype;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_title is null and p_description is null then
    raise exception 'title or description required' using errcode = '22023';
  end if;

  select t.* into current_task
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
  for update of t;

  if current_task.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  if p_expected_updated_at is null or current_task.updated_at is distinct from p_expected_updated_at then
    raise exception 'task changed; reload before saving'
      using errcode = 'PT409';
  end if;
  learning_before := private.learning_task_state(current_task.id);

  return query
  update public.chapter_tasks t
     set title = coalesce(p_title, t.title),
         description = coalesce(p_description, t.description)
   where t.id = current_task.id
   returning t.*;
  perform private.learning_task_journal('task_edit', current_task.id, learning_before);
end;
end
$$;

-- public.update_chapter_task_fields(uuid, jsonb, timestamp with time zone), from 20261104075000_learning_period_case_records.sql: 1 refusal
create or replace function public.update_chapter_task_fields(p_task_id uuid, p_fields jsonb, p_expected_updated_at timestamptz default null)
returns setof public.chapter_tasks
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  current_task public.chapter_tasks%rowtype;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_fields is null or pg_catalog.jsonb_typeof(p_fields) <> 'object'
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_fields) k(name) where not (k.name = any(array[
       'title', 'description', 'status', 'priority', 'workstream', 'assignee_id', 'start_date', 'due_date',
       'progress', 'blocked', 'milestone', 'order_index', 'task_type']::text[]))) then
    raise exception 'invalid task fields' using errcode = '22023';
  end if;
  select t.* into current_task
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
  for update of t;
  if current_task.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  if p_expected_updated_at is not null and current_task.updated_at is distinct from p_expected_updated_at then
    raise exception 'task changed; reload before saving' using errcode = 'PT409';
  end if;
  learning_before := private.learning_task_state(current_task.id);
  -- assignee_id is written only when it changes the primary: naming it in an
  -- UPDATE fires chapter_tasks_sync_primary_assignment, which resets the
  -- task's assignees to the primary alone and drops every co-assignee, even
  -- when the payload repeats the current primary.
  if p_fields ? 'assignee_id' and (p_fields ->> 'assignee_id')::uuid is distinct from current_task.assignee_id then
    update public.chapter_tasks t
    set title = case when p_fields ? 'title' then p_fields ->> 'title' else t.title end,
        description = case when p_fields ? 'description' then p_fields ->> 'description' else t.description end,
        status = case when p_fields ? 'status' then p_fields ->> 'status' else t.status end,
        priority = case when p_fields ? 'priority' then p_fields ->> 'priority' else t.priority end,
        workstream = case when p_fields ? 'workstream' then p_fields ->> 'workstream' else t.workstream end,
        assignee_id = (p_fields ->> 'assignee_id')::uuid,
        start_date = case when p_fields ? 'start_date' then (p_fields ->> 'start_date')::date else t.start_date end,
        due_date = case when p_fields ? 'due_date' then (p_fields ->> 'due_date')::date else t.due_date end,
        progress = case when p_fields ? 'progress' then (p_fields ->> 'progress')::smallint else t.progress end,
        blocked = case when p_fields ? 'blocked' then (p_fields ->> 'blocked')::boolean else t.blocked end,
        milestone = case when p_fields ? 'milestone' then (p_fields ->> 'milestone')::boolean else t.milestone end,
        order_index = case when p_fields ? 'order_index' then (p_fields ->> 'order_index')::integer else t.order_index end,
        task_type = case when p_fields ? 'task_type' then p_fields ->> 'task_type' else t.task_type end
    where t.id = current_task.id;
  else
    update public.chapter_tasks t
    set title = case when p_fields ? 'title' then p_fields ->> 'title' else t.title end,
        description = case when p_fields ? 'description' then p_fields ->> 'description' else t.description end,
        status = case when p_fields ? 'status' then p_fields ->> 'status' else t.status end,
        priority = case when p_fields ? 'priority' then p_fields ->> 'priority' else t.priority end,
        workstream = case when p_fields ? 'workstream' then p_fields ->> 'workstream' else t.workstream end,
        start_date = case when p_fields ? 'start_date' then (p_fields ->> 'start_date')::date else t.start_date end,
        due_date = case when p_fields ? 'due_date' then (p_fields ->> 'due_date')::date else t.due_date end,
        progress = case when p_fields ? 'progress' then (p_fields ->> 'progress')::smallint else t.progress end,
        blocked = case when p_fields ? 'blocked' then (p_fields ->> 'blocked')::boolean else t.blocked end,
        milestone = case when p_fields ? 'milestone' then (p_fields ->> 'milestone')::boolean else t.milestone end,
        order_index = case when p_fields ? 'order_index' then (p_fields ->> 'order_index')::integer else t.order_index end,
        task_type = case when p_fields ? 'task_type' then p_fields ->> 'task_type' else t.task_type end
    where t.id = current_task.id;
  end if;
  perform private.learning_task_journal('task_edit', current_task.id, learning_before);
  return query select t.* from public.chapter_tasks t where t.id = current_task.id;
end;
end;
$function$;

-- public.update_member_event(text, text, timestamp with time zone, text, text, text, boolean, boolean, integer), from 20261104110000_learning_period_events.sql: 1 refusal
create or replace function public.update_member_event(p_id text, p_title text default NULL::text, p_starts_at timestamp with time zone default NULL::timestamp with time zone, p_location text default NULL::text, p_summary text default NULL::text, p_check_in_code text default NULL::text, p_is_public boolean default NULL::boolean, p_is_public_across_agencies boolean default NULL::boolean, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  changed text[];
  m record;
  learning_before jsonb;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  -- A stale edit, for example one that waited behind an undo, is refused
  -- instead of reapplying what the undo took back.
  if p_expected_version is not null and ev.version is distinct from p_expected_version then
    raise exception 'this event changed; reload it before saving'
      using errcode = 'PT409', detail = 'event_changed';
  end if;
  learning_before := private.learning_event_state(p_id);

  if p_title is not null and (pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120 or p_title ~ '[[:cntrl:]]') then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_location is not null and (pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120 or p_location ~ '[[:cntrl:]]') then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is not null and (pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500 or p_summary ~ '[[:cntrl:]]') then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  -- NULL keeps the current code; the empty string removes it.
  if p_check_in_code is not null and p_check_in_code <> '' and p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  changed := pg_catalog.array_remove(array[
    case when p_title is not null and pg_catalog.btrim(p_title) is distinct from ev.title then 'title' end,
    case when p_starts_at is not null and p_starts_at is distinct from ev.starts_at then 'starts_at' end,
    case when p_location is not null and pg_catalog.btrim(p_location) is distinct from ev.location then 'location' end,
    case when p_summary is not null and pg_catalog.btrim(p_summary) is distinct from ev.summary then 'summary' end,
    case when p_check_in_code is not null and nullif(p_check_in_code, '') is distinct from ev.check_in_code then 'check_in_code' end,
    case when p_is_public is not null and p_is_public is distinct from ev.is_public then 'is_public' end,
    case when p_is_public_across_agencies is not null and p_is_public_across_agencies is distinct from ev.is_public_across_agencies then 'is_public_across_agencies' end
  ], null);

  if pg_catalog.cardinality(changed) > 0 then
    update public.member_events set
      title = coalesce(pg_catalog.btrim(p_title), title),
      starts_at = coalesce(p_starts_at, starts_at),
      location = coalesce(pg_catalog.btrim(p_location), location),
      summary = coalesce(pg_catalog.btrim(p_summary), summary),
      check_in_code = case when p_check_in_code is null then check_in_code else nullif(p_check_in_code, '') end,
      is_public = coalesce(p_is_public, is_public),
      is_public_across_agencies = coalesce(p_is_public_across_agencies, is_public_across_agencies),
      version = version + 1
    where id = p_id and chapter_id = caller_chapter;

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.to_jsonb(changed),
      'isPublic', coalesce(p_is_public, ev.is_public),
      'isPublicAcrossAgencies', coalesce(p_is_public_across_agencies, ev.is_public_across_agencies)));

    if 'starts_at' = any(changed) then
      update public.member_events set reminder_notice_sent_at = null
      where id = p_id and chapter_id = caller_chapter;
      begin
        for m in
          select rv.user_id
          from public.member_event_rsvps rv
          join public.member_profiles recipient on recipient.id = rv.user_id
          join public.member_events current_event on current_event.id = rv.event_id
          join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
          join public.chapters publisher_chapter on publisher_chapter.id = current_event.chapter_id
          where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
            and (
              recipient.chapter_id = current_event.chapter_id
              or current_event.is_public_across_agencies
              or (current_event.is_public and publisher_chapter.region is not null
                  and recipient_chapter.region = publisher_chapter.region)
            )
        loop
          perform private.notify_member_event(m.user_id, p_id, 'rescheduled');
        end loop;
      exception
        when others then
          raise warning 'event.rescheduled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
      end;
    end if;
    perform private.learning_event_journal('event_edit', p_id, learning_before);
  end if;

  -- The version a retry or the next edit sends back.
  return pg_catalog.jsonb_build_object('id', p_id, 'updated', pg_catalog.cardinality(changed) > 0,
    'version', (select e.version from public.member_events e where e.id = p_id));
end;
end;
$function$
;

-- public.update_member_event_model(text, text, timestamp with time zone, text, text, text, boolean, boolean, jsonb, integer), from 20261104110000_learning_period_events.sql: 1 refusal
create or replace function public.update_member_event_model(p_id text, p_title text default NULL::text, p_starts_at timestamp with time zone default NULL::timestamp with time zone, p_location text default NULL::text, p_summary text default NULL::text, p_check_in_code text default NULL::text, p_is_public boolean default NULL::boolean, p_is_public_across_agencies boolean default NULL::boolean, p_schedule jsonb default NULL::jsonb, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  changed text[];
  m record;
  next_kind text;
  next_start timestamptz;
  next_date date;
  next_end timestamptz;
  next_code text;
  learning_before jsonb;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  -- A stale edit, for example one that waited behind an undo, is refused
  -- instead of reapplying what the undo took back.
  if p_expected_version is not null and ev.version is distinct from p_expected_version then
    raise exception 'this event changed; reload it before saving'
      using errcode = 'PT409', detail = 'event_changed';
  end if;
  learning_before := private.learning_event_state(p_id);

  -- NULL schedule preserves exact stored seconds and an omitted end time.
  -- A present schedule is a full replacement; JSON null clears the end.
  if p_schedule is not null and (pg_catalog.jsonb_typeof(p_schedule) <> 'object'
     or not (p_schedule ?& array['kind', 'startsAt', 'eventDate', 'endsAt'])) then
    raise exception 'invalid event schedule' using errcode = '22023';
  end if;
  next_kind := case when p_schedule is null then ev.event_kind else p_schedule ->> 'kind' end;
  next_start := case when p_schedule is null then coalesce(p_starts_at, ev.starts_at) else (p_schedule ->> 'startsAt')::timestamptz end;
  next_date := case when p_schedule is null then ev.event_date else (p_schedule ->> 'eventDate')::date end;
  next_end := case when p_schedule is null then ev.ends_at else (p_schedule ->> 'endsAt')::timestamptz end;
  next_code := case when p_check_in_code is null then ev.check_in_code else nullif(p_check_in_code, '') end;
  if next_kind is null or next_kind not in ('meeting', 'deadline', 'date_only')
     or (next_kind = 'meeting' and (next_start is null or next_date is not null))
     or (next_kind <> 'meeting' and (next_date is null or next_start is not null or next_end is not null or next_code is not null))
     or (next_end is not null and next_end <= next_start) then
    raise exception 'invalid event schedule' using errcode = '22023';
  end if;
  -- Do not turn attendance already recorded for a meeting into a deadline.
  if next_kind <> 'meeting' and ev.event_kind = 'meeting' and (
    exists (select 1 from public.member_event_rsvps where event_id = p_id)
    or exists (select 1 from public.member_event_checkins where event_id = p_id)
  ) then
    raise exception 'event has attendance; keep its meeting type' using errcode = '22023';
  end if;

  if p_title is not null and (pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120 or p_title ~ '[[:cntrl:]]') then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_location is not null and (pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120 or p_location ~ '[[:cntrl:]]') then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is not null and (pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500 or p_summary ~ '[[:cntrl:]]') then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if nullif(p_check_in_code, '') is not null and p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  changed := pg_catalog.array_remove(array[
    case when p_title is not null and pg_catalog.btrim(p_title) is distinct from ev.title then 'title' end,
    case when next_start is distinct from ev.starts_at then 'starts_at' end,
    case when next_kind is distinct from ev.event_kind then 'event_kind' end,
    case when next_date is distinct from ev.event_date then 'event_date' end,
    case when next_end is distinct from ev.ends_at then 'ends_at' end,
    case when p_location is not null and pg_catalog.btrim(p_location) is distinct from ev.location then 'location' end,
    case when p_summary is not null and pg_catalog.btrim(p_summary) is distinct from ev.summary then 'summary' end,
    case when next_code is distinct from ev.check_in_code then 'check_in_code' end,
    case when p_is_public is not null and p_is_public is distinct from ev.is_public then 'is_public' end,
    case when p_is_public_across_agencies is not null and p_is_public_across_agencies is distinct from ev.is_public_across_agencies then 'is_public_across_agencies' end
  ], null);

  if pg_catalog.cardinality(changed) > 0 then
    update public.member_events set
      title = coalesce(pg_catalog.btrim(p_title), title),
      starts_at = next_start, event_kind = next_kind, event_date = next_date, ends_at = next_end,
      location = coalesce(pg_catalog.btrim(p_location), location),
      summary = coalesce(pg_catalog.btrim(p_summary), summary),
      check_in_code = next_code,
      is_public = coalesce(p_is_public, is_public),
      is_public_across_agencies = coalesce(p_is_public_across_agencies, is_public_across_agencies),
      version = version + 1
    where id = p_id and chapter_id = caller_chapter;

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.to_jsonb(changed),
      'isPublic', coalesce(p_is_public, ev.is_public),
      'isPublicAcrossAgencies', coalesce(p_is_public_across_agencies, ev.is_public_across_agencies)));

    if changed && array['starts_at', 'ends_at', 'event_date', 'event_kind'] then
      delete from private.member_event_checkin_tokens where event_id = p_id and consumed_at is null;
      update public.member_events set reminder_notice_sent_at = null
      where id = p_id and chapter_id = caller_chapter;
      begin
        for m in
          select rv.user_id
          from public.member_event_rsvps rv
          join public.member_profiles recipient on recipient.id = rv.user_id
          join public.member_events current_event on current_event.id = rv.event_id
          join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
          join public.chapters publisher_chapter on publisher_chapter.id = current_event.chapter_id
          where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
            and (
              recipient.chapter_id = current_event.chapter_id
              or current_event.is_public_across_agencies
              or (current_event.is_public and publisher_chapter.region is not null
                  and recipient_chapter.region = publisher_chapter.region)
            )
        loop
          perform private.notify_member_event(m.user_id, p_id, 'rescheduled');
        end loop;
      exception
        when others then
          raise warning 'event.rescheduled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
      end;
    end if;
    perform private.learning_event_journal('event_edit', p_id, learning_before);
  end if;

  -- The version a retry or the next edit sends back.
  return pg_catalog.jsonb_build_object('id', p_id, 'updated', pg_catalog.cardinality(changed) > 0,
    'version', (select e.version from public.member_events e where e.id = p_id));
end;
end;
$function$
;

-- public.upsert_union_outreach_codes(jsonb), from 20261027183700_union_document_outreach_codes_and_notify_preference.sql: 1 refusal
create or replace function public.upsert_union_outreach_codes(p_codes jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inserted_count integer;
  updated_count integer;
  unchanged_count integer;
  total integer;
  locked_code text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_codes) is distinct from 'array' then
    raise exception 'invalid outreach codes' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_codes) not between 1 and 1000 then
    raise exception 'invalid outreach codes' using errcode = '22023';
  end if;
  -- OR operands have no guaranteed evaluation order, so every array or
  -- object function runs only inside a CASE branch that proved the type.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_codes) as entry(value)
    where case when pg_catalog.jsonb_typeof(entry.value) <> 'object' then true
      when pg_catalog.jsonb_typeof(entry.value -> 'orgs') is distinct from 'array' then true
      else coalesce(entry.value ->> 'code', '') !~ '^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$'
        or coalesce(entry.value ->> 'kind', '') not in ('single', 'shared')
        or coalesce(entry.value ->> 'channel', '') not in ('mail', 'email')
        or pg_catalog.jsonb_array_length(entry.value -> 'orgs') not between 1 and 1000
        or ((entry.value ->> 'kind') = 'single') <> (pg_catalog.jsonb_array_length(entry.value -> 'orgs') = 1)
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(entry.value -> 'orgs') as org(value)
          where case when pg_catalog.jsonb_typeof(org.value) <> 'object' then true
            else coalesce(org.value ->> 'body_id', '') !~ '^[a-z]{2,12}-[A-Za-z0-9]{1,40}$'
              or pg_catalog.jsonb_typeof(coalesce(org.value -> 'display_name', 'null'::jsonb)) not in ('string', 'null')
              or char_length(pg_catalog.btrim(coalesce(org.value ->> 'display_name', 'ok'))) not between 2 and 500
              or coalesce(org.value ->> 'display_name', '') ~ '[[:cntrl:]]'
              or exists (select 1 from pg_catalog.jsonb_object_keys(org.value) as key(name) where key.name not in ('body_id', 'display_name'))
            end
        )
      end
  ) or (
    select pg_catalog.count(distinct entry.value ->> 'code') <> pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_codes) as entry(value)
  ) then
    raise exception 'invalid outreach codes' using errcode = '22023';
  end if;

  for locked_code in
    select entry.value ->> 'code'
    from pg_catalog.jsonb_array_elements(p_codes) as entry(value)
    order by (entry.value ->> 'code') collate "C"
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('private.union_outreach_codes:' || locked_code, 0));
  end loop;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_codes) as entry(value)
    join private.union_outreach_codes as existing on existing.code = entry.value ->> 'code'
    cross join lateral pg_catalog.jsonb_array_elements(existing.orgs) with ordinality as held(value, position)
    where (entry.value -> 'orgs' -> (held.position::integer - 1) ->> 'body_id') is distinct from (held.value ->> 'body_id')
  ) then
    raise exception 'outreach code remapped' using errcode = '22023',
      detail = 'An existing code keeps the body_id at every position it already has; issue a new code instead.';
  end if;

  with incoming as (
    select entry.value ->> 'code' as code, entry.value ->> 'kind' as kind,
      entry.value ->> 'channel' as channel,
      (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'body_id', org.value ->> 'body_id',
            'display_name', nullif(pg_catalog.btrim(coalesce(org.value ->> 'display_name', '')), '')
          ) order by org.ordinality)
        from pg_catalog.jsonb_array_elements(entry.value -> 'orgs') with ordinality as org(value, ordinality)
      ) as orgs
    from pg_catalog.jsonb_array_elements(p_codes) as entry(value)
  ), written as (
    insert into private.union_outreach_codes as existing (code, kind, channel, orgs)
    select incoming.code, incoming.kind, incoming.channel, incoming.orgs from incoming
    on conflict (code) do update set
      kind = excluded.kind, channel = excluded.channel, orgs = excluded.orgs
    where (existing.kind, existing.channel, existing.orgs) is distinct from (excluded.kind, excluded.channel, excluded.orgs)
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(existing.orgs) with ordinality as held(value, position)
        where (excluded.orgs -> (held.position::integer - 1) ->> 'body_id') is distinct from (held.value ->> 'body_id')
      )
    returning (xmax = 0) as fresh
  )
  select
    (select pg_catalog.count(*) filter (where fresh) from written),
    (select pg_catalog.count(*) filter (where not fresh) from written),
    (
      select pg_catalog.count(*)
      from incoming
      join private.union_outreach_codes as stored on stored.code = incoming.code
      where (stored.kind, stored.channel, stored.orgs) is not distinct from (incoming.kind, incoming.channel, incoming.orgs)
    )
  into inserted_count, updated_count, unchanged_count;

  total := pg_catalog.jsonb_array_length(p_codes);
  if inserted_count + updated_count + unchanged_count <> total then
    raise exception 'outreach code changed concurrently' using errcode = 'PT409',
      detail = 'Another import changed one of these codes; nothing was written. Run the import again.';
  end if;
  return pg_catalog.jsonb_build_object(
    'inserted', inserted_count, 'updated', updated_count, 'unchanged', unchanged_count
  );
end;
$$;

-- public.withdraw_platform_announcement(uuid, integer), from 20261029141540_platform_announcements_backend.sql: 1 refusal
create or replace function public.withdraw_platform_announcement(p_id uuid,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; a private.platform_announcements;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);org:=private.platform_announcement_context(true,false,true);
 select * into a from private.platform_announcements where id=p_id and organization_id=org for update;
 if a.id is null then raise exception 'platform updates unavailable' using errcode='42501'; end if;
 if a.revision is distinct from p_expected_revision then raise exception 'platform update revision changed' using errcode='PT409'; end if;
 if a.state<>'withdrawn' then
  update private.platform_announcements set state='withdrawn' where id=a.id;
  insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision,publisher_assurance) values(org,auth.uid(),'withdraw',a.id,a.revision,'aal2');
 end if;
 return jsonb_build_object('id',a.id,'revision',a.revision,'state','withdrawn');
end;
$function$;

-- Union Ground: the same move for this edition's own organizing writers
-- (learning sessions, capacity commitments, recognition, campaigns,
-- bargaining and ratification), which upstream never had. Each writer is
-- re-created from its installed definition (its source migration plus the
-- organizing MFA guard 20261019195958 inserted) with only errcode '40001' ->
-- 'PT409' on its refusals; their lifecycle review rows are then refreshed from
-- the surface.

-- public.create_learning_session: the definition from 20261014002000_unionground_canonical_participation_sources.sql; 1 refusal(s) now PT409.
create or replace function public.create_learning_session(
  p_learning_kind text,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  scope_chapter text;
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  session_id uuid;
  existing public.member_learning_sessions%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  scope_chapter := private.lifecycle_scope_chapter(
    array['steward', 'organizer', 'coordinator', 'admin']
  );
  if scope_chapter is null then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'request id required' using errcode = '22023';
  end if;
  if p_learning_kind is null
     or p_learning_kind not in ('orientation', 'training', 'meeting', 'leadership_training') then
    raise exception 'unknown learning kind' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) not between 3 and 180
     or p_starts_at is null
     or p_ends_at is null
     or p_ends_at <= p_starts_at then
    raise exception 'invalid learning session' using errcode = '22023';
  end if;

  insert into public.member_learning_sessions (
    chapter_id,
    learning_kind,
    title,
    starts_at,
    ends_at,
    created_by,
    request_id
  ) values (
    scope_chapter,
    p_learning_kind,
    clean_title,
    p_starts_at,
    p_ends_at,
    caller,
    p_request_id
  )
  on conflict (created_by, request_id) do nothing
  returning id into session_id;

  if session_id is null then
    select s.* into existing
    from public.member_learning_sessions s
    where s.created_by = caller and s.request_id = p_request_id;
    if existing.id is null then
      raise exception 'learning session outcome not visible; retry transaction'
        using errcode = 'PT409';
    end if;
    if existing.chapter_id <> scope_chapter
       or existing.learning_kind <> p_learning_kind
       or existing.title <> clean_title
       or existing.starts_at <> p_starts_at
       or existing.ends_at <> p_ends_at then
      raise exception 'request id already used for different learning session'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'sessionId', existing.id,
      'status', existing.status
    );
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata
  ) values (
    scope_chapter,
    caller,
    'learning.session_created',
    'member_learning_session',
    session_id,
    'open',
    pg_catalog.jsonb_build_object('learningKind', p_learning_kind)
  );

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'sessionId', session_id,
    'status', 'open'
  );
end;
end;
$$;

-- public.assign_learning_session: the definition from 20261014002000_unionground_canonical_participation_sources.sql; 1 refusal(s) now PT409.
create or replace function public.assign_learning_session(
  p_session_id uuid,
  p_user_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  scope_chapter text;
  learning_session public.member_learning_sessions%rowtype;
  assignment_id uuid;
  existing public.member_learning_assignments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  scope_chapter := private.lifecycle_scope_chapter(
    array['steward', 'organizer', 'coordinator', 'admin']
  );
  if scope_chapter is null then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_session_id is null or p_user_id is null or p_request_id is null then
    raise exception 'session, member, and request id required' using errcode = '22023';
  end if;

  select s.* into learning_session
  from public.member_learning_sessions s
  where s.id = p_session_id
    and s.chapter_id = scope_chapter
  for key share;
  if learning_session.id is null or learning_session.status <> 'open' then
    raise exception 'learning session not available' using errcode = '22023';
  end if;
  -- Chapter belonging is Union Ground's active chapter membership, not the
  -- member's currently selected chapter on member_profiles.
  if not exists (
    select 1 from public.member_chapter_memberships m
    where m.user_id = p_user_id
      and m.chapter_id = scope_chapter
      and m.status = 'active'
  ) then
    raise exception 'member not found' using errcode = '22023';
  end if;

  insert into public.member_learning_assignments (
    session_id,
    user_id,
    chapter_id,
    learning_kind,
    assigned_by,
    request_id
  ) values (
    learning_session.id,
    p_user_id,
    scope_chapter,
    learning_session.learning_kind,
    caller,
    p_request_id
  )
  on conflict do nothing
  returning id into assignment_id;

  if assignment_id is null then
    -- Resolve the idempotency key first. A natural-key collision from a
    -- different request must not be reported as success without consuming the
    -- new request key; otherwise that key can later produce a second outcome.
    select a.* into existing
    from public.member_learning_assignments a
    where a.assigned_by = caller and a.request_id = p_request_id;
    if existing.id is not null then
      if existing.session_id <> learning_session.id
         or existing.user_id <> p_user_id
         or existing.chapter_id <> scope_chapter then
        raise exception 'request id already used for different learning assignment'
          using errcode = '22023';
      end if;
      return pg_catalog.jsonb_build_object(
        'changed', false,
        'assignmentId', existing.id,
        'status', existing.status,
        'revision', existing.revision
      );
    end if;

    if exists (
      select 1
      from public.member_learning_assignments a
      where a.session_id = learning_session.id and a.user_id = p_user_id
    ) then
      raise exception 'learning assignment already exists'
        using errcode = '22023';
    end if;

    raise exception 'learning assignment outcome not visible; retry transaction'
      using errcode = 'PT409';
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata
  ) values (
    scope_chapter,
    caller,
    'learning.assignment_offered',
    'member_learning_assignment',
    assignment_id,
    'offered',
    pg_catalog.jsonb_build_object('learningKind', learning_session.learning_kind)
  );

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'assignmentId', assignment_id,
    'status', 'offered',
    'revision', 1
  );
end;
end;
$$;

-- public.offer_capacity_commitment: the definition from 20261014002000_unionground_canonical_participation_sources.sql; 1 refusal(s) now PT409.
create or replace function public.offer_capacity_commitment(
  p_user_id uuid,
  p_commitment_kind text,
  p_title text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  scope_chapter text;
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  commitment_id uuid;
  existing public.member_capacity_commitments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  scope_chapter := private.lifecycle_scope_chapter(
    array['steward', 'organizer', 'coordinator', 'admin']
  );
  if scope_chapter is null then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_request_id is null then
    raise exception 'member and request id required' using errcode = '22023';
  end if;
  if p_commitment_kind is null
     or p_commitment_kind not in ('peer_outreach', 'committee', 'voluntary') then
    raise exception 'unknown commitment kind' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) not between 3 and 180 then
    raise exception 'invalid commitment title' using errcode = '22023';
  end if;
  -- Chapter belonging is Union Ground's active chapter membership, not the
  -- member's currently selected chapter on member_profiles.
  if not exists (
    select 1 from public.member_chapter_memberships m
    where m.user_id = p_user_id
      and m.chapter_id = scope_chapter
      and m.status = 'active'
  ) then
    raise exception 'member not found' using errcode = '22023';
  end if;

  insert into public.member_capacity_commitments (
    user_id,
    chapter_id,
    commitment_kind,
    title,
    offered_by,
    request_id
  ) values (
    p_user_id,
    scope_chapter,
    p_commitment_kind,
    clean_title,
    caller,
    p_request_id
  )
  on conflict (offered_by, request_id) do nothing
  returning id into commitment_id;

  if commitment_id is null then
    select c.* into existing
    from public.member_capacity_commitments c
    where c.offered_by = caller and c.request_id = p_request_id;
    if existing.id is null then
      raise exception 'commitment outcome not visible; retry transaction'
        using errcode = 'PT409';
    end if;
    if existing.user_id <> p_user_id
       or existing.chapter_id <> scope_chapter
       or existing.commitment_kind <> p_commitment_kind
       or existing.title <> clean_title then
      raise exception 'request id already used for different commitment'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'commitmentId', existing.id,
      'status', existing.status,
      'revision', existing.revision
    );
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata
  ) values (
    scope_chapter,
    caller,
    'capacity.commitment_offered',
    'member_capacity_commitment',
    commitment_id,
    'offered',
    pg_catalog.jsonb_build_object('commitmentKind', p_commitment_kind)
  );

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'commitmentId', commitment_id,
    'status', 'offered',
    'revision', 1
  );
end;
end;
$$;

-- public.start_capacity_commitment: the definition from 20261014002000_unionground_canonical_participation_sources.sql; 2 refusal(s) now PT409.
create or replace function public.start_capacity_commitment(
  p_commitment_id uuid,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  commitment public.member_capacity_commitments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_commitment_id is null or p_expected_revision is null then
    raise exception 'commitment and expected revision required' using errcode = '22023';
  end if;

  select c.* into commitment
  from public.member_capacity_commitments c
  where c.id = p_commitment_id and c.user_id = caller
  for update;
  if commitment.id is null then
    raise exception 'commitment not found' using errcode = '22023';
  end if;
  if commitment.status = 'in_progress' then
    if p_expected_revision not in (commitment.revision, commitment.revision - 1) then
      raise exception 'commitment changed; reload and try again' using errcode = 'PT409';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'commitmentId', commitment.id,
      'status', commitment.status,
      'revision', commitment.revision
    );
  end if;
  if commitment.revision <> p_expected_revision then
    raise exception 'commitment changed; reload and try again' using errcode = 'PT409';
  end if;
  if commitment.status <> 'accepted' then
    raise exception 'accepted commitment required' using errcode = '22023';
  end if;

  update public.member_capacity_commitments
  set status = 'in_progress',
      -- Captured after the row lock. A statement timestamp taken before waiting
      -- can predate a concurrently committed responded_at value.
      started_at = pg_catalog.clock_timestamp(),
      revision = revision + 1
  where id = commitment.id
  returning revision into commitment.revision;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state
  ) values (
    commitment.chapter_id,
    caller,
    'capacity.commitment_started',
    'member_capacity_commitment',
    commitment.id,
    'accepted',
    'in_progress'
  );

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'commitmentId', commitment.id,
    'status', 'in_progress',
    'revision', commitment.revision
  );
end;
end;
$$;

-- public.record_member_recognition: the definition from 20261014003000_unionground_safe_recognition.sql; 1 refusal(s) now PT409.
create or replace function public.record_member_recognition(
  p_participation_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  participation public.member_participation_events%rowtype;
  source_label text;
  existing_id uuid;
  recognition_id uuid;
  audit_id uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'recognition verifier role required' using errcode = '42501';
  end if;

  -- Union Ground's chapter-scoped grant in the caller's selected chapter,
  -- with an active membership there and Union Ground's own role predicate
  -- (organization membership, staff-MFA policy) in agreement.
  select p.chapter_id into caller_chapter
  from public.member_profiles p
  join public.member_chapter_memberships m
    on m.user_id = p.id
   and m.chapter_id = p.chapter_id
   and m.status = 'active'
  where p.id = caller
    and exists (
      select 1
      from public.member_role_chapters r
      where r.user_id = p.id
        and r.chapter_id = p.chapter_id
        and r.role in ('steward', 'organizer', 'coordinator')
    )
    and private.member_has_chapter_role(
      p.chapter_id, array['steward', 'organizer', 'coordinator']
    );
  if caller is null or caller_chapter is null then
    raise exception 'recognition verifier role required' using errcode = '42501';
  end if;
  if p_participation_event_id is null then
    raise exception 'verified participation record required' using errcode = '22023';
  end if;

  select pe.* into participation
  from public.member_participation_events pe
  where pe.id = p_participation_event_id
  for key share;

  if participation.id is null or participation.chapter_id <> caller_chapter then
    raise exception 'verified participation record not found' using errcode = '22023';
  end if;
  if participation.user_id = caller then
    raise exception 'self-recognition is not allowed' using errcode = '22023';
  end if;
  if participation.occurred_at > pg_catalog.statement_timestamp() + interval '5 minutes'
     or participation.occurred_at < pg_catalog.statement_timestamp() - interval '1 year' then
    raise exception 'recognition date is invalid' using errcode = '22023';
  end if;

  if participation.canonical_completion_id is null
     or participation.activity_kind not in (
       'training_complete',
       'orientation_complete',
       'peer_outreach_complete',
       'committee_commitment_complete',
       'commitment_complete'
     )
     or participation.source_kind not in ('learning_assignment', 'capacity_commitment') then
    raise exception 'participation source is not eligible for recognition' using errcode = '22023';
  end if;

  select coalesce(s.title, c.title) into source_label
  from public.member_participation_completions pc
  left join public.member_learning_assignments a
    on a.id = pc.learning_assignment_id
  left join public.member_learning_sessions s
    on s.id = a.session_id
  left join public.member_capacity_commitments c
    on c.id = pc.capacity_commitment_id
  where pc.id = participation.canonical_completion_id;
  if source_label is null then
    raise exception 'canonical participation source not found' using errcode = '23514';
  end if;

  insert into public.member_recognition_events (
    participation_event_id,
    canonical_completion_id,
    user_id,
    chapter_id,
    recognition_kind,
    source_kind,
    source_id,
    source_label,
    occurred_at,
    verified_by
  ) values (
    participation.id,
    participation.canonical_completion_id,
    participation.user_id,
    participation.chapter_id,
    participation.activity_kind,
    participation.source_kind,
    participation.source_id,
    source_label,
    participation.occurred_at,
    caller
  )
  on conflict (participation_event_id) do nothing
  returning id into recognition_id;

  if recognition_id is null then
    select e.id into existing_id
    from public.member_recognition_events e
    where e.participation_event_id = participation.id;
    if existing_id is null then
      raise exception 'recognition outcome not visible; retry transaction'
        using errcode = 'PT409';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'recognitionId', existing_id
    );
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata
  ) values (
    participation.chapter_id,
    caller,
    'participation.recognized',
    'member_recognition',
    recognition_id,
    participation.activity_kind,
    pg_catalog.jsonb_build_object(
      'participationEventId', participation.id,
      'sourceKind', participation.source_kind
    )
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'recognitionId', recognition_id,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.set_organizing_campaign_status: the definition from 20261014007000_unionground_lifecycle_writer_hardening.sql and the organizing MFA guard of 20261019195958; 1 refusal(s) now PT409.
create or replace function public.set_organizing_campaign_status(
  p_campaign_id uuid,
  p_expected_revision integer,
  p_status text,
  p_request_id uuid,
  p_outcome text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  campaign record;
  receipt record;
  writer_kind text;
  normalized_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  request_fingerprint text;
  event_time timestamptz;
  audit_id uuid;
begin
  if caller is null or p_campaign_id is null or p_request_id is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0 then
    raise exception 'campaign revision is required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('active', 'paused', 'closed') then
    raise exception 'unknown campaign status' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_reason, '')) > 1000 then
    raise exception 'campaign status reason is too long' using errcode = '22023';
  end if;
  if p_status = 'closed' then
    if p_outcome is null or p_outcome not in ('withdrawn', 'lost', 'other') then
      raise exception 'closed campaign outcome required' using errcode = '22023';
    end if;
    if normalized_reason is null then
      raise exception 'closed campaign reason required' using errcode = '22023';
    end if;
  elsif p_outcome is not null then
    raise exception 'outcome is only valid when closing' using errcode = '22023';
  end if;

  request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.jsonb_build_object(
        'operation', 'campaign.status_changed',
        'campaignId', p_campaign_id,
        'expectedRevision', p_expected_revision,
        'status', p_status,
        'outcome', p_outcome,
        'reason', normalized_reason
      )::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:mfa-reset:' || caller::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:'
      || caller::text || ':' || p_request_id::text,
      0
    )
  );

  if not private.lifecycle_can_operate_campaign(p_campaign_id) then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = p_campaign_id
  for update;

  if not found then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  writer_kind := private.lock_lifecycle_campaign_writer(campaign.id, campaign.chapter_id);
  if writer_kind is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'campaign.status_changed'
       or receipt.entity_id <> campaign.id
       or receipt.request_fingerprint is distinct from request_fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', receipt.entity_id,
      'status', receipt.to_state,
      'outcome', receipt.safe_metadata ->> 'outcome',
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_revision then
    raise exception 'campaign changed; reload and try again' using errcode = 'PT409';
  end if;
  if campaign.status = 'closed' then
    raise exception 'closed campaign cannot be changed' using errcode = '22023';
  end if;
  if campaign.status = p_status then
    raise exception 'campaign already has that status' using errcode = '22023';
  end if;
  if not (
    (campaign.status = 'active' and p_status in ('paused', 'closed'))
    or
    (campaign.status = 'paused' and p_status in ('active', 'closed'))
  ) then
    raise exception 'invalid campaign status transition' using errcode = '22023';
  end if;
  if p_status = 'closed' and writer_kind <> 'coordinator' then
    raise exception 'coordinator role required to close a campaign' using errcode = '42501';
  end if;

  event_time := pg_catalog.clock_timestamp();

  update public.organizing_campaigns
  set status = p_status,
      outcome = case when p_status = 'closed' then p_outcome else null end,
      outcome_reason = case when p_status = 'closed' then normalized_reason else null end,
      closed_at = case when p_status = 'closed' then event_time else null end,
      revision = revision + 1
  where id = campaign.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    reason,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'campaign.status_changed',
    'organizing_campaign',
    campaign.id,
    campaign.status,
    p_status,
    normalized_reason,
    pg_catalog.jsonb_build_object(
      'outcome',
      case when p_status = 'closed' then p_outcome else null end
    ),
    p_request_id,
    request_fingerprint,
    campaign.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'status', p_status,
    'outcome', case when p_status = 'closed' then p_outcome else null end,
    'revision', campaign.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.transition_organizing_campaign: the definition from 20261014007000_unionground_lifecycle_writer_hardening.sql and the organizing MFA guard of 20261019195958; 1 refusal(s) now PT409.
create or replace function public.transition_organizing_campaign(
  p_campaign_id uuid,
  p_expected_revision integer,
  p_next_stage text,
  p_request_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  campaign record;
  receipt record;
  writer_kind text;
  normalized_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  request_fingerprint text;
  allowed boolean := false;
  event_time timestamptz;
  audit_id uuid;
begin
  if caller is null or p_campaign_id is null or p_request_id is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0 then
    raise exception 'campaign revision is required' using errcode = '22023';
  end if;
  if p_next_stage is null or p_next_stage not in (
    'lead', 'committee', 'cards', 'petition', 'election',
    'recognition', 'certification', 'bargaining',
    'first_contract', 'established'
  ) then
    raise exception 'unknown campaign stage' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_note, '')) > 1000 then
    raise exception 'campaign milestone note is too long' using errcode = '22023';
  end if;

  request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.jsonb_build_object(
        'operation', 'campaign.stage_changed',
        'campaignId', p_campaign_id,
        'expectedRevision', p_expected_revision,
        'nextStage', p_next_stage,
        'note', normalized_note
      )::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:mfa-reset:' || caller::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:'
      || caller::text || ':' || p_request_id::text,
      0
    )
  );

  if not private.lifecycle_can_operate_campaign(p_campaign_id) then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = p_campaign_id
  for update;

  if not found then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  writer_kind := private.lock_lifecycle_campaign_writer(campaign.id, campaign.chapter_id);
  if writer_kind is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'campaign.stage_changed'
       or receipt.entity_id <> campaign.id
       or receipt.request_fingerprint is distinct from request_fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', receipt.entity_id,
      'stage', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_revision then
    raise exception 'campaign changed; reload and try again' using errcode = 'PT409';
  end if;
  if campaign.status <> 'active' then
    raise exception 'campaign is not active' using errcode = '22023';
  end if;

  allowed := case
    when campaign.stage = 'lead' then p_next_stage = 'committee'
    when campaign.stage = 'committee' then p_next_stage = 'cards'
    when campaign.stage = 'cards' then
      (p_next_stage = 'petition' and campaign.representation_path in ('undecided', 'election'))
      or
      (p_next_stage = 'recognition' and campaign.representation_path in ('undecided', 'voluntary_recognition'))
    when campaign.stage = 'petition' then
      campaign.representation_path = 'election' and p_next_stage = 'election'
    when campaign.stage = 'election' then p_next_stage = 'certification'
    when campaign.stage = 'recognition' then
      campaign.representation_path = 'voluntary_recognition' and p_next_stage = 'bargaining'
    when campaign.stage = 'certification' then p_next_stage = 'bargaining'
    -- First-contract entry remains fail-closed until a typed, approved
    -- ratification record can be checked in this transaction.
    when campaign.stage = 'bargaining' then false
    when campaign.stage = 'first_contract' then p_next_stage = 'established'
    else false
  end;
  if not allowed then
    raise exception 'invalid campaign transition' using errcode = '22023';
  end if;

  if p_next_stage = 'bargaining'
     and not exists (
       select 1
       from public.organizing_bargaining_cycles b
       where b.campaign_id = campaign.id
         and b.chapter_id = campaign.chapter_id
         and b.bargaining_started_on is not null
         and b.phase in (
           'at_table', 'mediation', 'fact_finding', 'impasse',
           'tentative_agreement', 'ratification', 'execution', 'complete'
         )
     ) then
    raise exception 'verified bargaining start required' using errcode = '22023';
  end if;
  if p_next_stage = 'established'
     and not exists (
       select 1
       from public.organizing_bargaining_cycles b
       where b.campaign_id = campaign.id
         and b.chapter_id = campaign.chapter_id
         and b.phase = 'complete'
         and b.first_contract_signed_on is not null
     ) then
    raise exception 'signed first contract required' using errcode = '22023';
  end if;

  event_time := pg_catalog.clock_timestamp();

  update public.organizing_campaigns
  set stage = p_next_stage,
      representation_path = case
        when campaign.stage = 'cards' and p_next_stage = 'petition' then 'election'
        when campaign.stage = 'cards' and p_next_stage = 'recognition' then 'voluntary_recognition'
        else representation_path
      end,
      status = case when p_next_stage = 'established' then 'closed' else status end,
      outcome = case when p_next_stage = 'established' then 'established' else outcome end,
      outcome_reason = case when p_next_stage = 'established' then null else outcome_reason end,
      closed_at = case when p_next_stage = 'established' then event_time else closed_at end,
      stage_started_at = event_time,
      revision = revision + 1
  where id = campaign.id;

  insert into public.organizing_stage_events (
    campaign_id,
    chapter_id,
    from_stage,
    to_stage,
    actor_id,
    note,
    occurred_at
  ) values (
    campaign.id,
    campaign.chapter_id,
    campaign.stage,
    p_next_stage,
    caller,
    normalized_note,
    event_time
  );

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    reason,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'campaign.stage_changed',
    'organizing_campaign',
    campaign.id,
    campaign.stage,
    p_next_stage,
    normalized_note,
    p_request_id,
    request_fingerprint,
    campaign.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'stage', p_next_stage,
    'revision', campaign.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.transition_organizing_bargaining_cycle: the definition from 20261014008000_unionground_bargaining_writers.sql and the organizing MFA guard of 20261019195958; 1 refusal(s) now PT409.
create or replace function public.transition_organizing_bargaining_cycle(
  p_cycle_id uuid,
  p_expected_revision integer,
  p_expected_campaign_revision integer,
  p_next_phase text,
  p_request_id uuid,
  p_effective_on date default null,
  p_reason text default null,
  p_next_action text default null,
  p_next_deadline_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  receipt record;
  fingerprint text;
  allowed boolean;
  campaign_revision integer;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  normalized_next_action text := nullif(pg_catalog.btrim(coalesce(p_next_action, '')), '');
begin
  if caller is null or p_cycle_id is null or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0
     or p_expected_campaign_revision is null
     or p_expected_campaign_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if p_next_phase is null or p_next_phase not in (
    'preparing',
    'proposal_development',
    'at_table',
    'mediation',
    'fact_finding',
    'impasse',
    'tentative_agreement',
    'ratification',
    'execution',
    'complete'
  ) then
    raise exception 'unknown bargaining phase' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_reason, '')) > 1000
     or pg_catalog.char_length(coalesce(normalized_next_action, '')) > 600 then
    raise exception 'cycle text is too long' using errcode = '22023';
  end if;
  if p_effective_on is not null and p_effective_on > current_date then
    raise exception 'bargaining start cannot be in the future' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.cycle.transitioned',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedRevision', p_expected_revision,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'nextPhase', p_next_phase,
      'effectiveOn', p_effective_on,
      'reason', normalized_reason,
      'nextAction', normalized_next_action,
      'nextDeadlineAt', private.bargaining_canonical_instant(p_next_deadline_at)
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.cycle.transitioned'
       or receipt.entity_id <> cycle.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision', (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'cycleId', cycle.id,
      'phase', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_campaign_revision
     or cycle.revision <> p_expected_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = 'PT409';
  end if;
  if campaign.status <> 'active' then
    raise exception 'campaign is not active' using errcode = '22023';
  end if;

  allowed := case
    when cycle.phase = 'preparing' then
      p_next_phase = 'proposal_development'
    when cycle.phase = 'proposal_development' then
      p_next_phase = 'at_table'
    when cycle.phase = 'at_table' then
      p_next_phase in (
        'mediation',
        'fact_finding',
        'impasse',
        'tentative_agreement'
      )
    when cycle.phase in ('mediation', 'fact_finding', 'impasse') then
      p_next_phase in ('at_table', 'tentative_agreement')
    when cycle.phase = 'tentative_agreement' then
      p_next_phase in ('at_table', 'ratification')
    when cycle.phase = 'ratification' then
      p_next_phase = 'at_table'
    else false
  end;

  if not allowed or p_next_phase in ('execution', 'complete') then
    raise exception 'invalid bargaining phase transition' using errcode = '22023';
  end if;

  if cycle.phase = 'ratification' and p_next_phase = 'at_table' then
    if normalized_reason is null then
      raise exception 'ratification rollback reason is required'
        using errcode = '22023';
    end if;
    if private.lock_bargaining_campaign_writer(
         campaign.id,
         campaign.chapter_id,
         true
       ) is null then
      raise exception 'coordinator role required for ratification rollback'
        using errcode = '42501';
    end if;
    if exists (
         select 1
         from public.organizing_bargaining_ratifications current_result
         where current_result.id = cycle.current_ratification_id
           and current_result.cycle_id = cycle.id
           and current_result.execution_authorized
       )
       or exists (
         select 1
         from public.organizing_first_contracts contract
         where contract.cycle_id = cycle.id
       ) then
      raise exception 'authorized ratification cannot be rolled back'
        using errcode = '22023';
    end if;
  end if;

  if cycle.bargaining_started_on is null
     and p_next_phase = 'at_table'
     and p_effective_on is null then
    raise exception 'verified bargaining start date is required'
      using errcode = '22023';
  end if;

  if p_next_phase in ('tentative_agreement', 'ratification')
     and not exists (
       select 1
       from public.organizing_bargaining_proposals p
       where p.cycle_id = cycle.id
         and p.campaign_id = campaign.id
         and p.chapter_id = campaign.chapter_id
         and p.record_kind = 'agreement_package'
         and p.status = 'tentative_agreement'
         and p.document_sha256 is not null
         and not exists (
           select 1
           from public.organizing_bargaining_proposals child
           where child.parent_proposal_id = p.id
         )
         and not exists (
           select 1
           from pg_catalog.unnest(p.included_proposal_ids) included_id
           left join public.organizing_bargaining_proposals included
             on included.id = included_id
            and included.cycle_id = cycle.id
            and included.campaign_id = campaign.id
            and included.chapter_id = campaign.chapter_id
            and included.record_kind = 'article'
           where included.id is null
              or included.status <> 'accepted'
              or included.presented_on is null
              or included.presented_on > p.presented_on
              or exists (
                select 1
                from public.organizing_bargaining_proposals child
                where child.parent_proposal_id = included.id
              )
         )
         and not exists (
           select 1
           from public.organizing_bargaining_proposals current_article
           where current_article.cycle_id = cycle.id
             and current_article.campaign_id = campaign.id
             and current_article.chapter_id = campaign.chapter_id
             and current_article.record_kind = 'article'
             and current_article.status = 'accepted'
             and not exists (
               select 1
               from public.organizing_bargaining_proposals child
               where child.parent_proposal_id = current_article.id
             )
             and not (current_article.id = any(p.included_proposal_ids))
         )
         and not exists (
           select 1
           from public.organizing_bargaining_proposals unresolved_article
           where unresolved_article.cycle_id = cycle.id
             and unresolved_article.campaign_id = campaign.id
             and unresolved_article.chapter_id = campaign.chapter_id
             and unresolved_article.record_kind = 'article'
             and unresolved_article.status not in (
               'accepted',
               'rejected',
               'withdrawn',
               'superseded'
             )
             and not exists (
               select 1
               from public.organizing_bargaining_proposals child
               where child.parent_proposal_id = unresolved_article.id
             )
         )
     ) then
    raise exception 'current tentative-agreement proposal required'
      using errcode = '22023';
  end if;

  if cycle.bargaining_started_on is null
     and p_next_phase = 'at_table'
     and campaign.stage not in ('recognition', 'certification', 'bargaining') then
    raise exception 'campaign is not ready for bargaining' using errcode = '22023';
  end if;

  update public.organizing_bargaining_cycles
  set phase = p_next_phase,
      bargaining_started_on = case
        when cycle.bargaining_started_on is null and p_next_phase = 'at_table'
          then p_effective_on
        else cycle.bargaining_started_on
      end,
      next_action = normalized_next_action,
      next_deadline_at = p_next_deadline_at,
      revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  campaign_revision := campaign.revision;
  if cycle.bargaining_started_on is null
     and p_next_phase = 'at_table'
     and campaign.stage in ('recognition', 'certification') then
    update public.organizing_campaigns
    set stage = 'bargaining',
        stage_started_at = event_time,
        revision = campaign.revision + 1,
        updated_at = event_time
    where id = campaign.id;

    insert into public.organizing_stage_events (
      campaign_id,
      chapter_id,
      from_stage,
      to_stage,
      actor_id,
      source_kind,
      note,
      occurred_at
    ) values (
      campaign.id,
      campaign.chapter_id,
      campaign.stage,
      'bargaining',
      caller,
      'staff_verified',
      'Verified bargaining start recorded',
      event_time
    );

    campaign_revision := campaign.revision + 1;
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    reason,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.cycle.transitioned',
    'bargaining_cycle',
    cycle.id,
    cycle.phase,
    p_next_phase,
    normalized_reason,
    pg_catalog.jsonb_build_object(
      'campaignRevision',
      campaign_revision
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign_revision,
    'cycleId', cycle.id,
    'phase', p_next_phase,
    'revision', cycle.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.record_organizing_ratification: the definition from 20261014008000_unionground_bargaining_writers.sql and the organizing MFA guard of 20261019195958; 1 refusal(s) now PT409.
create or replace function public.record_organizing_ratification(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_expected_campaign_revision integer,
  p_agreement_proposal_id uuid,
  p_agreement_sha256 text,
  p_decision_method text,
  p_held_on date,
  p_source_reported_outcome text,
  p_source_kind text,
  p_source_reference text,
  p_source_sha256 text,
  p_rule_summary text,
  p_eligibility_source text,
  p_eligible_count integer,
  p_ballots_cast integer,
  p_approve_count integer,
  p_reject_count integer,
  p_abstain_count integer,
  p_invalid_count integer,
  p_quorum_required_count integer,
  p_threshold_numerator integer,
  p_threshold_denominator integer,
  p_approval_comparator text,
  p_approval_denominator text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  proposal record;
  receipt record;
  ratification_id uuid;
  denominator_count bigint;
  computed_outcome text;
  next_phase text;
  next_campaign_stage text;
  campaign_revision integer;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_agreement_sha text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_agreement_sha256, '')));
  normalized_source_reference text := pg_catalog.btrim(coalesce(p_source_reference, ''));
  normalized_source_sha text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source_sha256, '')));
  normalized_rule_summary text := pg_catalog.btrim(coalesce(p_rule_summary, ''));
  normalized_eligibility_source text := pg_catalog.btrim(coalesce(p_eligibility_source, ''));
begin
  if caller is null
     or p_cycle_id is null
     or p_agreement_proposal_id is null
     or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null or p_expected_cycle_revision <= 0
     or p_expected_campaign_revision is null
     or p_expected_campaign_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if normalized_agreement_sha !~ '^[0-9a-f]{64}$'
     or normalized_source_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence hashes must be lowercase SHA-256 values'
      using errcode = '22023';
  end if;
  if p_held_on is null or p_held_on > current_date then
    raise exception 'ratification date is invalid' using errcode = '22023';
  end if;
  if p_decision_method is null or p_decision_method not in ('vote', 'not_required')
     or p_source_kind is null
     or p_source_kind not in (
       'union_report',
       'independent_tally',
       'meeting_minutes',
       'written_rule',
       'other'
     ) then
    raise exception 'ratification source is invalid' using errcode = '22023';
  end if;
  if pg_catalog.char_length(normalized_source_reference) not between 3 and 1000
     or pg_catalog.char_length(normalized_rule_summary) not between 3 and 2000
     or pg_catalog.char_length(normalized_eligibility_source) not between 3 and 1000 then
    raise exception 'ratification source fields are invalid' using errcode = '22023';
  end if;

  if p_decision_method = 'vote' then
    if p_source_reported_outcome is null
       or p_source_reported_outcome not in ('approved', 'rejected', 'no_quorum')
       or p_eligible_count is null
       or p_eligible_count not between 1 and 10000000
       or p_ballots_cast is null
       or p_ballots_cast not between 0 and p_eligible_count
       or p_approve_count is null
       or p_approve_count < 0
       or p_reject_count is null
       or p_reject_count < 0
       or p_abstain_count is null
       or p_abstain_count < 0
       or p_invalid_count is null
       or p_invalid_count < 0
       or p_approve_count > p_ballots_cast
       or p_reject_count > p_ballots_cast
       or p_abstain_count > p_ballots_cast
       or p_invalid_count > p_ballots_cast
       or p_approve_count::bigint
          + p_reject_count::bigint
          + p_abstain_count::bigint
          + p_invalid_count::bigint
          <> p_ballots_cast::bigint
       or p_quorum_required_count is null
       or p_quorum_required_count not between 0 and p_eligible_count
       or p_threshold_numerator is null
       or p_threshold_denominator is null
       or p_threshold_numerator not between 1 and p_threshold_denominator
       or p_threshold_denominator not between 1 and 10000000
       or p_approval_comparator is null
       or p_approval_comparator not in ('at_least', 'more_than')
       or p_approval_denominator is null
       or p_approval_denominator not in (
         'eligible',
         'ballots_cast',
         'non_abstaining'
       ) then
      raise exception 'ratification aggregate or rule is invalid'
        using errcode = '22023';
    end if;

    denominator_count := case p_approval_denominator
      when 'eligible' then p_eligible_count
      when 'ballots_cast' then p_ballots_cast
      when 'non_abstaining' then p_approve_count + p_reject_count
    end;

    computed_outcome := case
      when p_ballots_cast < p_quorum_required_count then 'no_quorum'
      when denominator_count <= 0 then 'indeterminate'
      when p_approval_comparator = 'at_least'
       and p_approve_count::bigint * p_threshold_denominator::bigint
           >= denominator_count * p_threshold_numerator::bigint
        then 'approved'
      when p_approval_comparator = 'more_than'
       and p_approve_count::bigint * p_threshold_denominator::bigint
           > denominator_count * p_threshold_numerator::bigint
        then 'approved'
      else 'rejected'
    end;

    -- A mismatch never advances the campaign. Staff must reconcile the
    -- external source and the explicitly entered rule.
    if computed_outcome is distinct from p_source_reported_outcome then
      computed_outcome := 'indeterminate';
    end if;
  else
    if p_source_reported_outcome is distinct from 'not_required'
       or p_eligible_count is not null
       or p_ballots_cast is not null
       or p_approve_count is not null
       or p_reject_count is not null
       or p_abstain_count is not null
       or p_invalid_count is not null
       or p_quorum_required_count is not null
       or p_threshold_numerator is not null
       or p_threshold_denominator is not null
       or p_approval_comparator is not null
       or p_approval_denominator is not null then
      raise exception 'not-required record cannot contain a vote tally'
        using errcode = '22023';
    end if;
    computed_outcome := 'not_required';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.ratification.recorded',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'agreementProposalId', p_agreement_proposal_id,
      'agreementSha256', normalized_agreement_sha,
      'decisionMethod', p_decision_method,
      'heldOn', p_held_on,
      'sourceReportedOutcome', p_source_reported_outcome,
      'sourceKind', p_source_kind,
      'sourceReference', normalized_source_reference,
      'sourceSha256', normalized_source_sha,
      'ruleSummary', normalized_rule_summary,
      'eligibilitySource', normalized_eligibility_source,
      'eligibleCount', p_eligible_count,
      'ballotsCast', p_ballots_cast,
      'approveCount', p_approve_count,
      'rejectCount', p_reject_count,
      'abstainCount', p_abstain_count,
      'invalidCount', p_invalid_count,
      'quorumRequiredCount', p_quorum_required_count,
      'thresholdNumerator', p_threshold_numerator,
      'thresholdDenominator', p_threshold_denominator,
      'approvalComparator', p_approval_comparator,
      'approvalDenominator', p_approval_denominator
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into proposal
  from public.organizing_bargaining_proposals
  where id = p_agreement_proposal_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for share;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       true
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.ratification.recorded'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision', (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'campaignStage', receipt.safe_metadata ->> 'campaignStage',
      'cycleId', cycle.id,
      'phase', receipt.safe_metadata ->> 'phase',
      'revision', receipt.result_revision,
      'ratificationId', receipt.entity_id,
      'outcome', receipt.to_state,
      'decisionMethod', receipt.safe_metadata ->> 'decisionMethod',
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_campaign_revision
     or cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = 'PT409';
  end if;
  if campaign.status <> 'active'
     or campaign.stage <> 'bargaining'
     or cycle.phase not in ('tentative_agreement', 'ratification')
     or proposal.status <> 'tentative_agreement'
     or proposal.record_kind <> 'agreement_package'
     or proposal.document_sha256 is distinct from normalized_agreement_sha
     or cycle.bargaining_started_on is null
     or proposal.presented_on is null
     or p_held_on < cycle.bargaining_started_on
     or p_held_on < proposal.presented_on
     or exists (
       select 1
       from public.organizing_bargaining_proposals child
       where child.parent_proposal_id = proposal.id
     )
     or exists (
       select 1
       from pg_catalog.unnest(proposal.included_proposal_ids) included_id
       left join public.organizing_bargaining_proposals included
         on included.id = included_id
        and included.cycle_id = cycle.id
        and included.record_kind = 'article'
        where included.id is null
           or included.status <> 'accepted'
           or included.presented_on is null
           or included.presented_on > proposal.presented_on
           or included.presented_on > p_held_on
          or exists (
            select 1
            from public.organizing_bargaining_proposals child
            where child.parent_proposal_id = included.id
          )
     )
     or exists (
       select 1
       from public.organizing_bargaining_ratifications current_result
       where current_result.id = cycle.current_ratification_id
         and current_result.cycle_id = cycle.id
         and current_result.campaign_id = campaign.id
         and current_result.chapter_id = campaign.chapter_id
         and (
           current_result.execution_authorized
           or p_held_on < current_result.held_on
         )
     )
     or exists (
       select 1
       from public.organizing_bargaining_proposals current_article
       where current_article.cycle_id = cycle.id
         and current_article.campaign_id = campaign.id
         and current_article.chapter_id = campaign.chapter_id
         and current_article.record_kind = 'article'
         and current_article.status = 'accepted'
         and not exists (
           select 1
           from public.organizing_bargaining_proposals child
           where child.parent_proposal_id = current_article.id
         )
         and not (
           current_article.id = any(proposal.included_proposal_ids)
          )
      )
     or exists (
       select 1
       from public.organizing_bargaining_proposals unresolved_article
       where unresolved_article.cycle_id = cycle.id
         and unresolved_article.campaign_id = campaign.id
         and unresolved_article.chapter_id = campaign.chapter_id
         and unresolved_article.record_kind = 'article'
         and unresolved_article.status not in (
           'accepted',
           'rejected',
           'withdrawn',
           'superseded'
         )
         and not exists (
           select 1
           from public.organizing_bargaining_proposals child
           where child.parent_proposal_id = unresolved_article.id
         )
     )
     or cycle.ratification_integrity_hold then
    raise exception 'ratification record is not eligible' using errcode = '22023';
  end if;

  insert into public.organizing_bargaining_ratifications (
    cycle_id,
    campaign_id,
    chapter_id,
    supersedes_ratification_id,
    agreement_proposal_id,
    agreement_sha256,
    decision_method,
    held_on,
    source_reported_outcome,
    computed_outcome,
    source_kind,
    source_reference,
    source_sha256,
    rule_summary,
    eligibility_source,
    eligible_count,
    ballots_cast,
    approve_count,
    reject_count,
    abstain_count,
    invalid_count,
    quorum_required_count,
    threshold_numerator,
    threshold_denominator,
    approval_comparator,
    approval_denominator,
    recorded_by,
    create_request_id,
    created_at
  ) values (
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    cycle.current_ratification_id,
    proposal.id,
    normalized_agreement_sha,
    p_decision_method,
    p_held_on,
    p_source_reported_outcome,
    computed_outcome,
    p_source_kind,
    normalized_source_reference,
    normalized_source_sha,
    normalized_rule_summary,
    normalized_eligibility_source,
    p_eligible_count,
    p_ballots_cast,
    p_approve_count,
    p_reject_count,
    p_abstain_count,
    p_invalid_count,
    p_quorum_required_count,
    p_threshold_numerator,
    p_threshold_denominator,
    p_approval_comparator,
    p_approval_denominator,
    caller,
    p_request_id,
    event_time
  ) returning id into ratification_id;

  next_phase := case
    when computed_outcome in ('approved', 'not_required') then 'execution'
    when computed_outcome = 'rejected' then 'at_table'
    when computed_outcome = 'no_quorum' then 'ratification'
    else 'ratification'
  end;

  update public.organizing_bargaining_cycles
  set phase = next_phase,
      current_ratification_id = ratification_id,
      ratification_integrity_hold = false,
      revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  campaign_revision := campaign.revision;
  next_campaign_stage := campaign.stage;
  if computed_outcome in ('approved', 'not_required') then
    update public.organizing_campaigns
    set stage = 'first_contract',
        stage_started_at = event_time,
        revision = campaign.revision + 1,
        updated_at = event_time
    where id = campaign.id;

    insert into public.organizing_stage_events (
      campaign_id,
      chapter_id,
      from_stage,
      to_stage,
      actor_id,
      source_kind,
      note,
      occurred_at
    ) values (
      campaign.id,
      campaign.chapter_id,
      campaign.stage,
      'first_contract',
      caller,
      'document_verified',
      'Staff-recorded sourced ratification authorization recorded',
      event_time
    );

    campaign_revision := campaign.revision + 1;
    next_campaign_stage := 'first_contract';
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.ratification.recorded',
    'bargaining_ratification',
    ratification_id,
    null,
    computed_outcome,
    pg_catalog.jsonb_build_object(
      'campaignRevision',
      campaign_revision,
      'campaignStage',
      next_campaign_stage,
      'cycleRevision',
      cycle.revision + 1,
      'phase',
      next_phase,
      'decisionMethod',
      p_decision_method
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign_revision,
    'campaignStage', next_campaign_stage,
    'cycleId', cycle.id,
    'phase', next_phase,
    'revision', cycle.revision + 1,
    'ratificationId', ratification_id,
    'outcome', computed_outcome,
    'decisionMethod', p_decision_method,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.correct_organizing_ratification: the definition from 20261014008000_unionground_bargaining_writers.sql and the organizing MFA guard of 20261019195958; 1 refusal(s) now PT409.
create or replace function public.correct_organizing_ratification(
  p_ratification_id uuid,
  p_expected_cycle_revision integer,
  p_expected_campaign_revision integer,
  p_reason_code text,
  p_source_kind text,
  p_source_reference text,
  p_source_sha256 text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  ratification record;
  receipt record;
  correction_id uuid;
  campaign_revision integer;
  contract_exists boolean := false;
  next_phase text;
  next_campaign_stage text;
  agreement_proposal_status text;
  agreement_proposal_revision integer;
  restored_ratification_id uuid;
  restored_ratification_outcome text;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_source_reference text := pg_catalog.btrim(
    coalesce(p_source_reference, '')
  );
  normalized_source_sha text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_source_sha256, ''))
  );
begin
  if caller is null
     or p_ratification_id is null
     or p_request_id is null then
    raise exception 'ratification record not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null
     or p_expected_cycle_revision <= 0
     or p_expected_campaign_revision is null
     or p_expected_campaign_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if p_reason_code is null
     or p_reason_code not in (
       'source_error',
       'tally_error',
       'rule_error',
       'wrong_agreement',
       'duplicate_record',
       'other'
     )
     or p_source_kind is null
     or p_source_kind not in (
       'union_report',
       'independent_tally',
       'meeting_minutes',
       'written_rule',
       'official_record',
       'other'
     )
     or pg_catalog.char_length(normalized_source_reference) not between 3 and 1000
     or normalized_source_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'correction source is invalid' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.ratification.corrected',
    pg_catalog.jsonb_build_object(
      'ratificationId', p_ratification_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'reasonCode', p_reason_code,
      'sourceKind', p_source_kind,
      'sourceReference', normalized_source_reference,
      'sourceSha256', normalized_source_sha
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:mfa-reset:' || caller::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:'
        || caller::text
        || ':'
        || p_request_id::text,
      0
    )
  );

  select
    r.cycle_id,
    r.campaign_id,
    r.chapter_id
  into target
  from public.organizing_bargaining_ratifications r
  where r.id = p_ratification_id;

  if not found then
    raise exception 'ratification record not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = target.cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into ratification
  from public.organizing_bargaining_ratifications
  where id = p_ratification_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for share;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       true
     ) is null then
    raise exception 'ratification record not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.ratification.corrected'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision',
        (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'campaignStage', receipt.safe_metadata ->> 'campaignStage',
      'cycleId', cycle.id,
      'phase', receipt.safe_metadata ->> 'phase',
      'revision', receipt.result_revision,
      'ratificationId',
        (receipt.safe_metadata ->> 'ratificationId')::uuid,
      'correctionId', receipt.entity_id,
      'corrected', true,
      'reasonCode', receipt.safe_metadata ->> 'reasonCode',
      'restoredRatificationId',
        (receipt.safe_metadata ->> 'restoredRatificationId')::uuid,
      'integrityHold',
        (receipt.safe_metadata ->> 'integrityHold')::boolean,
      'auditEventId', receipt.id
    );
  end if;

  contract_exists := exists (
    select 1
    from public.organizing_first_contracts contract
    where contract.cycle_id = cycle.id
      and contract.campaign_id = campaign.id
      and contract.chapter_id = campaign.chapter_id
      and contract.ratification_id = ratification.id
  );

  if campaign.revision <> p_expected_campaign_revision
     or cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = 'PT409';
  end if;
  if not (
       (
         campaign.status = 'active'
         and campaign.stage in ('bargaining', 'first_contract')
       )
       or (
         campaign.status = 'closed'
         and campaign.stage = 'established'
         and campaign.outcome = 'established'
       )
     )
     or cycle.phase not in ('at_table', 'ratification', 'execution', 'complete')
     or cycle.current_ratification_id is distinct from ratification.id
     or exists (
       select 1
       from public.organizing_bargaining_ratification_corrections prior
       where prior.ratification_id = ratification.id
     )
     or (
       ratification.execution_authorized
       and (
         (
           not contract_exists
           and (
             campaign.stage <> 'first_contract'
             or cycle.phase <> 'execution'
           )
         )
         or (
           contract_exists
           and cycle.phase <> 'complete'
         )
       )
     ) then
    raise exception 'ratification correction is not eligible'
      using errcode = '22023';
  end if;

  set constraints public.organizing_bargaining_corrections_detach_current deferred;

  insert into public.organizing_bargaining_ratification_corrections (
    ratification_id,
    cycle_id,
    campaign_id,
    chapter_id,
    reason_code,
    source_kind,
    source_reference,
    source_sha256,
    corrected_by,
    create_request_id,
    created_at
  ) values (
    ratification.id,
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    p_reason_code,
    p_source_kind,
    normalized_source_reference,
    normalized_source_sha,
    caller,
    p_request_id,
    event_time
  ) returning id into correction_id;

  campaign_revision := campaign.revision;
  if contract_exists then
    next_phase := cycle.phase;
    next_campaign_stage := campaign.stage;
    update public.organizing_bargaining_cycles
    set current_ratification_id = null,
        ratification_integrity_hold = true,
        revision = cycle.revision + 1,
        updated_at = event_time
    where id = cycle.id;
  else
    if p_reason_code = 'duplicate_record'
       and ratification.supersedes_ratification_id is not null then
      select prior.id, prior.computed_outcome
      into restored_ratification_id, restored_ratification_outcome
      from public.organizing_bargaining_ratifications prior
      join public.organizing_bargaining_proposals prior_proposal
        on prior_proposal.id = prior.agreement_proposal_id
       and prior_proposal.cycle_id = prior.cycle_id
       and prior_proposal.campaign_id = prior.campaign_id
       and prior_proposal.chapter_id = prior.chapter_id
       and prior_proposal.document_sha256 = prior.agreement_sha256
      where prior.id = ratification.supersedes_ratification_id
        and prior.cycle_id = cycle.id
        and prior.campaign_id = campaign.id
        and prior.chapter_id = campaign.chapter_id
        and not prior.execution_authorized
        and prior.agreement_proposal_id = ratification.agreement_proposal_id
        and prior.agreement_sha256 = ratification.agreement_sha256
        and prior_proposal.status = 'tentative_agreement'
        and not exists (
          select 1
          from public.organizing_bargaining_proposals child
          where child.parent_proposal_id = prior_proposal.id
        )
        and not exists (
          select 1
          from public.organizing_bargaining_ratification_corrections correction
          where correction.ratification_id = prior.id
        )
      for share;
    end if;

    next_phase := case
      when p_reason_code = 'wrong_agreement' then 'at_table'
      when p_reason_code = 'duplicate_record'
        and restored_ratification_id is not null
        and restored_ratification_outcome = 'rejected' then 'at_table'
      when p_reason_code = 'duplicate_record'
        and restored_ratification_id is not null then 'ratification'
      when ratification.execution_authorized then 'ratification'
      else cycle.phase
    end;
    next_campaign_stage := 'bargaining';
    if p_reason_code = 'wrong_agreement' then
      update public.organizing_bargaining_proposals
      set status = 'withdrawn',
          revision = revision + 1,
          updated_at = event_time
      where id = ratification.agreement_proposal_id
        and cycle_id = cycle.id
        and campaign_id = campaign.id
        and chapter_id = campaign.chapter_id
        and status = 'tentative_agreement'
      returning status, revision
      into agreement_proposal_status, agreement_proposal_revision;

      if not found then
        select proposal.status, proposal.revision
        into agreement_proposal_status, agreement_proposal_revision
        from public.organizing_bargaining_proposals proposal
        where proposal.id = ratification.agreement_proposal_id
          and proposal.cycle_id = cycle.id
          and proposal.campaign_id = campaign.id
          and proposal.chapter_id = campaign.chapter_id;
      end if;
    end if;
    update public.organizing_bargaining_cycles
    set phase = next_phase,
        current_ratification_id = case
          when p_reason_code = 'duplicate_record'
            then restored_ratification_id
          else null
        end,
        ratification_integrity_hold = false,
        revision = cycle.revision + 1,
        updated_at = event_time
    where id = cycle.id;

    if campaign.stage = 'first_contract' then
      update public.organizing_campaigns
      set stage = next_campaign_stage,
          stage_started_at = event_time,
          revision = campaign.revision + 1,
          updated_at = event_time
      where id = campaign.id;

      insert into public.organizing_stage_events (
        campaign_id,
        chapter_id,
        from_stage,
        to_stage,
        actor_id,
        source_kind,
        note,
        occurred_at
      ) values (
        campaign.id,
        campaign.chapter_id,
        campaign.stage,
        next_campaign_stage,
        caller,
        'document_verified',
        'Prior sourced ratification authorization corrected before execution',
        event_time
      );

      campaign_revision := campaign.revision + 1;
    end if;
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.ratification.corrected',
    'bargaining_ratification_correction',
    correction_id,
    ratification.computed_outcome,
    'corrected',
    pg_catalog.jsonb_build_object(
      'campaignRevision', campaign_revision,
      'campaignStage', next_campaign_stage,
      'cycleRevision', cycle.revision + 1,
      'phase', next_phase,
      'ratificationId', ratification.id,
      'reasonCode', p_reason_code,
      'agreementProposalId', ratification.agreement_proposal_id,
      'agreementProposalStatus', agreement_proposal_status,
      'agreementProposalRevision', agreement_proposal_revision,
      'restoredRatificationId', restored_ratification_id,
      'integrityHold', contract_exists
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign_revision,
    'campaignStage', next_campaign_stage,
    'cycleId', cycle.id,
    'phase', next_phase,
    'revision', cycle.revision + 1,
    'ratificationId', ratification.id,
    'correctionId', correction_id,
    'corrected', true,
    'reasonCode', p_reason_code,
    'restoredRatificationId', restored_ratification_id,
    'integrityHold', contract_exists,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.open_organizing_bargaining_cycle: the definition from 20261014008000_unionground_bargaining_writers.sql and the organizing MFA guard of 20261019195958; 1 refusal(s) now PT409.
create or replace function public.open_organizing_bargaining_cycle(
  p_campaign_id uuid,
  p_expected_campaign_revision integer,
  p_title text,
  p_request_id uuid,
  p_target_first_contract_on date default null,
  p_next_action text default null,
  p_next_deadline_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  campaign record;
  receipt record;
  cycle_id uuid;
  fingerprint text;
  audit_id uuid;
  normalized_title text := pg_catalog.btrim(coalesce(p_title, ''));
  normalized_next_action text := nullif(pg_catalog.btrim(coalesce(p_next_action, '')), '');
begin
  if caller is null or p_campaign_id is null or p_request_id is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if p_expected_campaign_revision is null or p_expected_campaign_revision <= 0 then
    raise exception 'campaign revision is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(normalized_title) not between 3 and 160 then
    raise exception 'cycle title is invalid' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_next_action, '')) > 600 then
    raise exception 'next action is too long' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.cycle.opened',
    pg_catalog.jsonb_build_object(
      'campaignId', p_campaign_id,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'title', normalized_title,
      'targetFirstContractOn', p_target_first_contract_on,
      'nextAction', normalized_next_action,
      'nextDeadlineAt', private.bargaining_canonical_instant(p_next_deadline_at)
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select *
  into campaign
  from public.organizing_campaigns
  where id = p_campaign_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.cycle.opened'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision', (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'cycleId', receipt.entity_id,
      'phase', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_campaign_revision then
    raise exception 'campaign changed; reload and try again' using errcode = 'PT409';
  end if;
  if campaign.status <> 'active'
     or campaign.stage not in ('recognition', 'certification', 'bargaining') then
    raise exception 'campaign is not ready for bargaining' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.organizing_bargaining_cycles c
    where c.campaign_id = campaign.id
  ) then
    raise exception 'bargaining cycle already exists' using errcode = '22023';
  end if;

  insert into public.organizing_bargaining_cycles (
    campaign_id,
    chapter_id,
    title,
    phase,
    target_first_contract_on,
    next_action,
    next_deadline_at,
    lead_id,
    created_by
  ) values (
    campaign.id,
    campaign.chapter_id,
    normalized_title,
    'preparing',
    p_target_first_contract_on,
    normalized_next_action,
    p_next_deadline_at,
    caller,
    caller
  ) returning id into cycle_id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.cycle.opened',
    'bargaining_cycle',
    cycle_id,
    'preparing',
    pg_catalog.jsonb_build_object(
      'campaignRevision',
      campaign.revision
    ),
    p_request_id,
    fingerprint,
    1
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign.revision,
    'cycleId', cycle_id,
    'phase', 'preparing',
    'revision', 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.record_organizing_first_contract: the definition from 20261014008000_unionground_bargaining_writers.sql and the organizing MFA guard of 20261019195958; 1 refusal(s) now PT409.
create or replace function public.record_organizing_first_contract(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_expected_campaign_revision integer,
  p_ratification_id uuid,
  p_agreement_sha256 text,
  p_signed_on date,
  p_request_id uuid,
  p_source_kind text,
  p_source_reference text,
  p_source_sha256 text,
  p_expected_signatory_count integer,
  p_verified_signatory_count integer,
  p_effective_on date default null,
  p_expires_on date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  ratification record;
  receipt record;
  contract_id uuid;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_agreement_sha text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_agreement_sha256, '')));
  normalized_source_reference text := pg_catalog.btrim(coalesce(p_source_reference, ''));
  normalized_source_sha text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source_sha256, '')));
begin
  if caller is null
     or p_cycle_id is null
     or p_ratification_id is null
     or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null or p_expected_cycle_revision <= 0
     or p_expected_campaign_revision is null
     or p_expected_campaign_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if normalized_agreement_sha !~ '^[0-9a-f]{64}$'
     or normalized_source_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence hashes must be lowercase SHA-256 values'
      using errcode = '22023';
  end if;
  if p_signed_on is null or p_signed_on > current_date then
    raise exception 'signature date is invalid' using errcode = '22023';
  end if;
  if p_expires_on is not null
     and (
       p_expires_on < p_signed_on
       or (
         p_effective_on is not null
         and p_expires_on < p_effective_on
       )
     ) then
    raise exception 'expiration cannot precede signature or effective date'
      using errcode = '22023';
  end if;
  if p_source_kind is null
     or p_source_kind not in (
       'executed_contract',
       'signed_memorandum',
       'official_record',
       'other'
     )
     or pg_catalog.char_length(normalized_source_reference) not between 3 and 1000 then
    raise exception 'contract source is invalid' using errcode = '22023';
  end if;
  if p_expected_signatory_count is null
     or p_expected_signatory_count not between 1 and 1000
     or p_verified_signatory_count is null
     or p_verified_signatory_count <> p_expected_signatory_count then
    raise exception 'the source must record every expected signatory'
      using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.first_contract.recorded',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'ratificationId', p_ratification_id,
      'agreementSha256', normalized_agreement_sha,
      'signedOn', p_signed_on,
      'sourceKind', p_source_kind,
      'sourceReference', normalized_source_reference,
      'sourceSha256', normalized_source_sha,
      'expectedSignatoryCount', p_expected_signatory_count,
      'verifiedSignatoryCount', p_verified_signatory_count,
      'effectiveOn', p_effective_on,
      'expiresOn', p_expires_on
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into ratification
  from public.organizing_bargaining_ratifications
  where id = p_ratification_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for share;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       true
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.first_contract.recorded'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision', (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'cycleId', cycle.id,
      'phase', receipt.to_state,
      'revision', receipt.result_revision,
      'contractId', receipt.entity_id,
      'status', receipt.safe_metadata ->> 'status',
      'signedOn', receipt.safe_metadata ->> 'signedOn',
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_campaign_revision
     or cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = 'PT409';
  end if;
  if campaign.status <> 'active'
     or campaign.stage <> 'first_contract'
     or cycle.phase <> 'execution'
     or cycle.current_ratification_id is distinct from ratification.id
     or cycle.ratification_integrity_hold
     or not ratification.execution_authorized
     or exists (
       select 1
       from public.organizing_bargaining_ratification_corrections correction
       where correction.ratification_id = ratification.id
     )
     or ratification.agreement_sha256 is distinct from normalized_agreement_sha
     or p_signed_on < ratification.held_on
     or exists (
       select 1
       from public.organizing_first_contracts prior
       where prior.cycle_id = cycle.id
     )
     or exists (
       select 1
       from public.organizing_bargaining_sessions pending_session
       where pending_session.cycle_id = cycle.id
         and pending_session.campaign_id = campaign.id
         and pending_session.chapter_id = campaign.chapter_id
         and pending_session.status = 'scheduled'
     ) then
    raise exception 'first-contract record is not eligible'
      using errcode = '22023';
  end if;

  insert into public.organizing_first_contracts (
    cycle_id,
    campaign_id,
    chapter_id,
    ratification_id,
    agreement_proposal_id,
    agreement_sha256,
    ratification_authorized,
    verification_status,
    signed_on,
    effective_on,
    expires_on,
    source_kind,
    source_reference,
    source_sha256,
    expected_signatory_count,
    verified_signatory_count,
    recorded_by,
    create_request_id,
    created_at
  ) values (
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    ratification.id,
    ratification.agreement_proposal_id,
    normalized_agreement_sha,
    true,
    'source_recorded_fully_signed',
    p_signed_on,
    p_effective_on,
    p_expires_on,
    p_source_kind,
    normalized_source_reference,
    normalized_source_sha,
    p_expected_signatory_count,
    p_verified_signatory_count,
    caller,
    p_request_id,
    event_time
  ) returning id into contract_id;

  update public.organizing_bargaining_cycles
  set phase = 'complete',
      first_contract_signed_on = p_signed_on,
      revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.first_contract.recorded',
    'first_contract',
    contract_id,
    cycle.phase,
    'complete',
    pg_catalog.jsonb_build_object(
      'campaignRevision',
      campaign.revision,
      'status',
      'source_recorded_fully_signed',
      'signedOn',
      p_signed_on
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign.revision,
    'cycleId', cycle.id,
    'phase', 'complete',
    'revision', cycle.revision + 1,
    'contractId', contract_id,
    'status', 'source_recorded_fully_signed',
    'signedOn', p_signed_on,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.transition_organizing_bargaining_proposal: the definition from 20261014008000_unionground_bargaining_writers.sql and the organizing MFA guard of 20261019195958; 1 refusal(s) now PT409.
create or replace function public.transition_organizing_bargaining_proposal(
  p_proposal_id uuid,
  p_expected_revision integer,
  p_expected_cycle_revision integer,
  p_next_status text,
  p_request_id uuid,
  p_presented_on date default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  proposal record;
  receipt record;
  fingerprint text;
  allowed boolean;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
begin
  if caller is null or p_proposal_id is null or p_request_id is null then
    raise exception 'proposal not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0
     or p_expected_cycle_revision is null
     or p_expected_cycle_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if p_next_status is null or p_next_status not in (
    'approved',
    'presented',
    'countered',
    'tentative_agreement',
    'accepted',
    'rejected',
    'withdrawn'
  ) then
    raise exception 'unknown proposal status' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_reason, '')) > 2000 then
    raise exception 'proposal reason is too long' using errcode = '22023';
  end if;
  if p_presented_on is not null and p_presented_on > current_date then
    raise exception 'presentation date cannot be in the future' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.proposal.transitioned',
    pg_catalog.jsonb_build_object(
      'proposalId', p_proposal_id,
      'expectedRevision', p_expected_revision,
      'expectedCycleRevision', p_expected_cycle_revision,
      'nextStatus', p_next_status,
      'presentedOn', p_presented_on,
      'reason', normalized_reason
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select p.cycle_id, p.campaign_id, p.chapter_id
  into target
  from public.organizing_bargaining_proposals p
  where p.id = p_proposal_id;

  if not found then
    raise exception 'proposal not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = target.cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into proposal
  from public.organizing_bargaining_proposals
  where id = p_proposal_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'proposal not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.proposal.transitioned'
       or receipt.entity_id <> proposal.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'cycleRevision', (receipt.safe_metadata ->> 'cycleRevision')::integer,
      'proposalId', proposal.id,
      'status', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision
     or proposal.revision <> p_expected_revision then
    raise exception 'proposal changed; reload and try again' using errcode = 'PT409';
  end if;
  if campaign.status <> 'active'
     or cycle.phase in ('ratification', 'execution', 'complete')
     or exists (
       select 1
       from public.organizing_bargaining_proposals child
       where child.parent_proposal_id = proposal.id
     ) then
    raise exception 'proposal is not editable' using errcode = '22023';
  end if;

  allowed := case
    when proposal.status = 'draft' then
      p_next_status in ('approved', 'withdrawn')
    when proposal.status = 'approved' then
      p_next_status in ('presented', 'withdrawn')
    when proposal.status = 'presented' then
      p_next_status in (
        'countered',
        'tentative_agreement',
        'accepted',
        'rejected',
        'withdrawn'
      )
    when proposal.status = 'countered' then
      p_next_status in (
        'tentative_agreement',
        'accepted',
        'rejected',
        'withdrawn'
      )
    when proposal.status = 'tentative_agreement' then
      p_next_status = 'withdrawn'
    else false
  end;

  if proposal.record_kind = 'agreement_package'
     and p_next_status in ('accepted', 'rejected') then
    allowed := false;
  end if;
  if proposal.record_kind = 'article'
     and p_next_status = 'tentative_agreement' then
    allowed := false;
  end if;

  if not allowed then
    raise exception 'invalid proposal transition' using errcode = '22023';
  end if;
  if p_presented_on is not null
     and p_next_status not in (
       'presented',
       'countered',
       'tentative_agreement',
       'accepted',
       'rejected'
     ) then
    raise exception 'presentation date is not valid for this transition'
      using errcode = '22023';
  end if;
  if p_next_status in (
       'presented',
       'countered',
       'tentative_agreement',
       'accepted',
       'rejected'
     )
     and proposal.presented_on is null
     and p_presented_on is null then
    raise exception 'presentation date is required' using errcode = '22023';
  end if;
  if p_next_status in (
       'presented',
       'countered',
       'tentative_agreement',
       'accepted',
       'rejected'
     )
     and (
       cycle.bargaining_started_on is null
       or cycle.phase not in (
         'at_table',
         'mediation',
         'fact_finding',
         'impasse',
         'tentative_agreement'
       )
       or coalesce(proposal.presented_on, p_presented_on)
          < cycle.bargaining_started_on
     ) then
    raise exception 'formal proposal status requires active bargaining chronology'
      using errcode = '22023';
  end if;
  if p_next_status = 'tentative_agreement'
     and (
       proposal.record_kind <> 'agreement_package'
       or nullif(pg_catalog.btrim(coalesce(proposal.member_summary, '')), '') is null
       or exists (
         select 1
         from pg_catalog.unnest(proposal.included_proposal_ids) included_id
         left join public.organizing_bargaining_proposals included
           on included.id = included_id
          and included.cycle_id = cycle.id
          and included.campaign_id = campaign.id
          and included.chapter_id = campaign.chapter_id
          and included.record_kind = 'article'
         where included.id is null
            or included.status <> 'accepted'
            or included.presented_on is null
            or included.presented_on > coalesce(
              proposal.presented_on,
              p_presented_on
            )
            or exists (
              select 1
              from public.organizing_bargaining_proposals child
              where child.parent_proposal_id = included.id
            )
       )
       or exists (
         select 1
         from public.organizing_bargaining_proposals current_article
         where current_article.cycle_id = cycle.id
           and current_article.campaign_id = campaign.id
           and current_article.chapter_id = campaign.chapter_id
           and current_article.record_kind = 'article'
           and current_article.status = 'accepted'
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = current_article.id
           )
           and not (
             current_article.id = any(proposal.included_proposal_ids)
           )
       )
       or exists (
         select 1
         from public.organizing_bargaining_proposals unresolved_article
         where unresolved_article.cycle_id = cycle.id
           and unresolved_article.campaign_id = campaign.id
           and unresolved_article.chapter_id = campaign.chapter_id
           and unresolved_article.record_kind = 'article'
           and unresolved_article.status not in (
             'accepted',
             'rejected',
             'withdrawn',
             'superseded'
           )
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = unresolved_article.id
           )
       )
     ) then
    raise exception 'tentative agreement requires a whole agreement package and member-safe summary'
      using errcode = '22023';
  end if;

  update public.organizing_bargaining_proposals
  set status = p_next_status,
      presented_on = coalesce(proposal.presented_on, p_presented_on),
      revision = proposal.revision + 1,
      updated_at = event_time
  where id = proposal.id;

  update public.organizing_bargaining_cycles
  set revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.proposal.transitioned',
    'bargaining_proposal',
    proposal.id,
    proposal.status,
    p_next_status,
    pg_catalog.jsonb_build_object(
      'cycleRevision',
      cycle.revision + 1
    ),
    p_request_id,
    fingerprint,
    proposal.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'cycleRevision', cycle.revision + 1,
    'proposalId', proposal.id,
    'status', p_next_status,
    'revision', proposal.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.resolve_ratification_integrity_hold: the definition from 20261014009000_unionground_ratification_hold_governance.sql; 1 refusal(s) now PT409.
create or replace function public.resolve_ratification_integrity_hold(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_request_id uuid,
  p_resolution_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  receipt record;
  correction record;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_note text := pg_catalog.btrim(coalesce(p_resolution_note, ''));
begin
  -- organizing_bargaining_cycles does not FORCE row level security, so this
  -- definer body bypasses the mfa_assurance policies that protect the sibling
  -- evidence tables. The MFA gate has to be stated here to exist at all.
  if caller is null
     or p_cycle_id is null
     or p_request_id is null
     or not (select private.mfa_satisfied()) then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null
     or p_expected_cycle_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  -- The note is the whole product record of why the hold was lifted, so an
  -- empty one is a rejected request, not a nullable field. 1000 is the
  -- union_lifecycle_audit_events.reason ceiling.
  if pg_catalog.char_length(normalized_note) not between 3 and 1000 then
    raise exception 'resolution note is invalid' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.integrity_hold.resolved',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'resolutionNote', normalized_note
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:mfa-reset:' || caller::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:'
        || caller::text
        || ':'
        || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  -- Campaign before cycle: the sibling bargaining writers take the row locks
  -- in this order, and a resolution that reversed it could deadlock against a
  -- concurrent correction on the same campaign.
  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       true
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.integrity_hold.resolved'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'phase', receipt.safe_metadata ->> 'phase',
      'revision', receipt.result_revision,
      'correctionId', (receipt.safe_metadata ->> 'correctionId')::uuid,
      'integrityHold', false,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = 'PT409';
  end if;

  -- Resolve only the hold the correction workflow can actually create: a
  -- correction whose ratification is the one a recorded first contract was
  -- built on. This is the same linkage the trigger demands before it will let
  -- the flag be raised, so nothing else can reach this exit.
  select correction_row.*
  into correction
  from public.organizing_bargaining_ratification_corrections correction_row
  join public.organizing_first_contracts contract
    on contract.ratification_id = correction_row.ratification_id
   and contract.cycle_id = correction_row.cycle_id
   and contract.campaign_id = correction_row.campaign_id
   and contract.chapter_id = correction_row.chapter_id
  where correction_row.cycle_id = cycle.id
    and correction_row.campaign_id = campaign.id
    and correction_row.chapter_id = campaign.chapter_id
  order by correction_row.created_at desc
  limit 1
  for share of correction_row;

  if not cycle.ratification_integrity_hold or correction.id is null then
    raise exception 'integrity hold resolution is not eligible'
      using errcode = '22023';
  end if;

  -- The audit row is written BEFORE the clear on purpose: the trigger below
  -- reads it back to confirm the marker names a real, append-only resolution
  -- receipt, so the escape hatch cannot be opened by set_config alone.
  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    reason,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.integrity_hold.resolved',
    'bargaining_integrity_hold',
    cycle.id,
    'integrity_hold',
    'resolved',
    normalized_note,
    pg_catalog.jsonb_build_object(
      'campaignRevision', campaign.revision,
      'campaignStage', campaign.stage,
      'cycleRevision', cycle.revision + 1,
      'phase', cycle.phase,
      'correctionId', correction.id,
      'ratificationId', correction.ratification_id
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  -- Transaction-local marker, cleared immediately after the update so the
  -- permission cannot leak to any other statement in the same transaction.
  perform pg_catalog.set_config(
    'unionground.hold_resolution',
    p_request_id::text,
    true
  );

  update public.organizing_bargaining_cycles
  set ratification_integrity_hold = false,
      revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  perform pg_catalog.set_config('unionground.hold_resolution', '', true);

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'phase', cycle.phase,
    'revision', cycle.revision + 1,
    'correctionId', correction.id,
    'ratificationId', correction.ratification_id,
    'integrityHold', false,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.create_organizing_bargaining_proposal: the definition from 20261014008000_unionground_bargaining_writers.sql and the organizing MFA guard of 20261019195958; 2 refusal(s) now PT409.
create or replace function public.create_organizing_bargaining_proposal(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_topic text,
  p_title text,
  p_side text,
  p_request_id uuid,
  p_record_kind text default 'article',
  p_included_proposal_ids uuid[] default '{}'::uuid[],
  p_document_sha256 text default null,
  p_parent_proposal_id uuid default null,
  p_parent_expected_revision integer default null,
  p_relation_kind text default null,
  p_member_summary text default null,
  p_internal_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  parent record;
  receipt record;
  proposal_id uuid;
  proposal_version integer := 1;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_topic text := pg_catalog.btrim(coalesce(p_topic, ''));
  normalized_title text := pg_catalog.btrim(coalesce(p_title, ''));
  normalized_member_summary text := nullif(pg_catalog.btrim(coalesce(p_member_summary, '')), '');
  normalized_internal_notes text := nullif(pg_catalog.btrim(coalesce(p_internal_notes, '')), '');
  normalized_included_ids uuid[] := coalesce(p_included_proposal_ids, '{}'::uuid[]);
  normalized_document_sha text := nullif(
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_document_sha256, ''))),
    ''
  );
begin
  if caller is null or p_cycle_id is null or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null or p_expected_cycle_revision <= 0 then
    raise exception 'cycle revision is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(normalized_topic) not between 1 and 120
     or pg_catalog.char_length(normalized_title) not between 3 and 200
     or pg_catalog.char_length(coalesce(normalized_member_summary, '')) > 2000
     or pg_catalog.char_length(coalesce(normalized_internal_notes, '')) > 12000 then
    raise exception 'proposal fields are invalid' using errcode = '22023';
  end if;
  if p_side is null or p_side not in ('union', 'employer', 'joint') then
    raise exception 'proposal side is invalid' using errcode = '22023';
  end if;
  if p_record_kind is null or p_record_kind not in ('article', 'agreement_package')
     or pg_catalog.array_position(normalized_included_ids, null) is not null
     or (
       select pg_catalog.count(*) <> pg_catalog.count(distinct item)
       from pg_catalog.unnest(normalized_included_ids) item
     )
     or (
       p_record_kind = 'article'
       and (
         pg_catalog.cardinality(normalized_included_ids) <> 0
         or normalized_document_sha is not null
       )
     )
     or (
       p_record_kind = 'agreement_package'
       and (
         pg_catalog.cardinality(normalized_included_ids) = 0
         or normalized_document_sha is null
         or normalized_document_sha !~ '^[0-9a-f]{64}$'
       )
     ) then
    raise exception 'proposal record shape is invalid' using errcode = '22023';
  end if;
  if (
    p_parent_proposal_id is null
    and (
      p_parent_expected_revision is not null
      or p_relation_kind is not null
    )
  ) or (
    p_parent_proposal_id is not null
    and (
      p_parent_expected_revision is null
      or p_parent_expected_revision <= 0
      or p_relation_kind is null
      or p_relation_kind not in ('revision', 'counter', 'replacement')
    )
  ) then
    raise exception 'proposal lineage is invalid' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.proposal.created',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'topic', normalized_topic,
      'title', normalized_title,
      'side', p_side,
      'recordKind', p_record_kind,
      'includedProposalIds', normalized_included_ids,
      'documentSha256', normalized_document_sha,
      'parentProposalId', p_parent_proposal_id,
      'parentExpectedRevision', p_parent_expected_revision,
      'relationKind', p_relation_kind,
      'memberSummary', normalized_member_summary,
      'internalNotes', normalized_internal_notes
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  if p_parent_proposal_id is not null then
    select *
    into parent
    from public.organizing_bargaining_proposals
    where id = p_parent_proposal_id
      and cycle_id = cycle.id
      and campaign_id = campaign.id
      and chapter_id = campaign.chapter_id
    for update;

    if not found then
      raise exception 'bargaining cycle not found' using errcode = '22023';
    end if;
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.proposal.created'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'cycleRevision', (receipt.safe_metadata ->> 'cycleRevision')::integer,
      'proposalId', receipt.entity_id,
      'recordKind', receipt.safe_metadata ->> 'recordKind',
      'version', (receipt.safe_metadata ->> 'version')::integer,
      'status', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining cycle changed; reload and try again'
      using errcode = 'PT409';
  end if;
  if campaign.status <> 'active'
     or cycle.phase in ('ratification', 'execution', 'complete') then
    raise exception 'bargaining cycle is not editable' using errcode = '22023';
  end if;

  if p_record_kind = 'agreement_package'
     and (
       (
         select pg_catalog.count(*) <> pg_catalog.cardinality(normalized_included_ids)
         from public.organizing_bargaining_proposals included
         where included.id = any(normalized_included_ids)
           and included.cycle_id = cycle.id
           and included.campaign_id = campaign.id
           and included.chapter_id = campaign.chapter_id
           and included.record_kind = 'article'
           and included.status = 'accepted'
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = included.id
           )
          )
       or exists (
         select 1
         from public.organizing_bargaining_proposals current_article
         where current_article.cycle_id = cycle.id
           and current_article.campaign_id = campaign.id
           and current_article.chapter_id = campaign.chapter_id
           and current_article.record_kind = 'article'
           and current_article.status = 'accepted'
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = current_article.id
           )
           and not (current_article.id = any(normalized_included_ids))
       )
       or exists (
         select 1
         from public.organizing_bargaining_proposals unresolved_article
         where unresolved_article.cycle_id = cycle.id
           and unresolved_article.campaign_id = campaign.id
           and unresolved_article.chapter_id = campaign.chapter_id
           and unresolved_article.record_kind = 'article'
           and unresolved_article.status not in (
             'accepted',
             'rejected',
             'withdrawn',
             'superseded'
           )
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = unresolved_article.id
           )
       )
     ) then
    raise exception 'agreement package contains an ineligible proposal version'
      using errcode = '22023';
  end if;

  if p_parent_proposal_id is not null then
    if parent.revision <> p_parent_expected_revision then
      raise exception 'proposal changed; reload and try again' using errcode = 'PT409';
    end if;
    if parent.status in ('rejected', 'withdrawn', 'superseded')
       or (
         parent.status = 'accepted'
         and not (
           parent.record_kind = 'article'
           and p_relation_kind = 'replacement'
           and cycle.phase in (
             'at_table',
             'mediation',
             'fact_finding',
             'impasse'
           )
         )
       )
       or parent.record_kind <> p_record_kind
       or exists (
         select 1
         from public.organizing_bargaining_proposals child
         where child.parent_proposal_id = parent.id
       ) then
      raise exception 'proposal lineage is closed' using errcode = '22023';
    end if;
    proposal_version := parent.version + 1;
  end if;

  insert into public.organizing_bargaining_proposals (
    cycle_id,
    campaign_id,
    chapter_id,
    parent_proposal_id,
    relation_kind,
    record_kind,
    included_proposal_ids,
    document_sha256,
    topic,
    title,
    side,
    status,
    version,
    revision,
    member_summary,
    internal_notes,
    create_request_id,
    created_by,
    created_at,
    updated_at
  ) values (
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    p_parent_proposal_id,
    p_relation_kind,
    p_record_kind,
    normalized_included_ids,
    normalized_document_sha,
    normalized_topic,
    normalized_title,
    p_side,
    'draft',
    proposal_version,
    1,
    normalized_member_summary,
    normalized_internal_notes,
    p_request_id,
    caller,
    event_time,
    event_time
  ) returning id into proposal_id;

  if p_parent_proposal_id is not null then
    update public.organizing_bargaining_proposals
    set status = 'superseded',
        revision = parent.revision + 1,
        updated_at = event_time
    where id = parent.id;
  end if;

  update public.organizing_bargaining_cycles
  set revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.proposal.created',
    'bargaining_proposal',
    proposal_id,
    'draft',
    pg_catalog.jsonb_build_object(
      'cycleRevision',
      cycle.revision + 1,
      'recordKind',
      p_record_kind,
      'version',
      proposal_version
    ),
    p_request_id,
    fingerprint,
    1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'cycleRevision', cycle.revision + 1,
    'proposalId', proposal_id,
    'recordKind', p_record_kind,
    'version', proposal_version,
    'status', 'draft',
    'revision', 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.schedule_organizing_bargaining_session: the definition from 20261014008000_unionground_bargaining_writers.sql and the organizing MFA guard of 20261019195958; 1 refusal(s) now PT409.
create or replace function public.schedule_organizing_bargaining_session(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_starts_at timestamptz,
  p_request_id uuid,
  p_location text default null,
  p_agenda text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  receipt record;
  session_id uuid;
  next_session_number integer;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_location text := nullif(pg_catalog.btrim(coalesce(p_location, '')), '');
  normalized_agenda text := nullif(pg_catalog.btrim(coalesce(p_agenda, '')), '');
begin
  if caller is null or p_cycle_id is null or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null or p_expected_cycle_revision <= 0 then
    raise exception 'cycle revision is required' using errcode = '22023';
  end if;
  if p_starts_at is null then
    raise exception 'session start is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_location, '')) > 240
     or pg_catalog.char_length(coalesce(normalized_agenda, '')) > 12000 then
    raise exception 'session fields are invalid' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.session.scheduled',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'startsAt', private.bargaining_canonical_instant(p_starts_at),
      'location', normalized_location,
      'agenda', normalized_agenda
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.session.scheduled'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'cycleRevision', (receipt.safe_metadata ->> 'cycleRevision')::integer,
      'sessionId', receipt.entity_id,
      'sessionNumber', (receipt.safe_metadata ->> 'sessionNumber')::integer,
      'status', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining cycle changed; reload and try again'
      using errcode = 'PT409';
  end if;
  if campaign.status <> 'active' or cycle.phase = 'complete' then
    raise exception 'bargaining cycle is not editable' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.max(s.session_number), 0) + 1
  into next_session_number
  from public.organizing_bargaining_sessions s
  where s.cycle_id = cycle.id;

  insert into public.organizing_bargaining_sessions (
    cycle_id,
    campaign_id,
    chapter_id,
    session_number,
    starts_at,
    location,
    status,
    agenda,
    member_update,
    revision,
    create_request_id,
    created_by,
    created_at,
    updated_at
  ) values (
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    next_session_number,
    p_starts_at,
    normalized_location,
    'scheduled',
    normalized_agenda,
    '',
    1,
    p_request_id,
    caller,
    event_time,
    event_time
  ) returning id into session_id;

  update public.organizing_bargaining_cycles
  set revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.session.scheduled',
    'bargaining_session',
    session_id,
    'scheduled',
    pg_catalog.jsonb_build_object(
      'cycleRevision',
      cycle.revision + 1,
      'sessionNumber',
      next_session_number
    ),
    p_request_id,
    fingerprint,
    1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'cycleRevision', cycle.revision + 1,
    'sessionId', session_id,
    'sessionNumber', next_session_number,
    'status', 'scheduled',
    'revision', 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.record_organizing_bargaining_session_outcome: the definition from 20261014008000_unionground_bargaining_writers.sql and the organizing MFA guard of 20261019195958; 1 refusal(s) now PT409.
create or replace function public.record_organizing_bargaining_session_outcome(
  p_session_id uuid,
  p_expected_revision integer,
  p_expected_cycle_revision integer,
  p_status text,
  p_request_id uuid,
  p_ends_at timestamptz default null,
  p_member_update text default null,
  p_internal_minutes text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  session_row record;
  receipt record;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_member_update text := nullif(pg_catalog.btrim(coalesce(p_member_update, '')), '');
  normalized_internal_minutes text := nullif(pg_catalog.btrim(coalesce(p_internal_minutes, '')), '');
  normalized_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
begin
  if caller is null or p_session_id is null or p_request_id is null then
    raise exception 'bargaining session not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0
     or p_expected_cycle_revision is null
     or p_expected_cycle_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('held', 'cancelled') then
    raise exception 'unknown session outcome' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_member_update, '')) > 2000
     or pg_catalog.char_length(coalesce(normalized_internal_minutes, '')) > 20000
     or pg_catalog.char_length(coalesce(normalized_reason, '')) > 2000 then
    raise exception 'session outcome fields are invalid' using errcode = '22023';
  end if;
  if p_status = 'held'
     and (p_ends_at is null or normalized_member_update is null) then
    raise exception 'held session requires an end time and member-safe update'
      using errcode = '22023';
  end if;
  if p_status = 'cancelled'
     and (
       normalized_reason is null
       or p_ends_at is not null
     ) then
    raise exception 'cancelled session fields are invalid'
      using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.session.outcome_recorded',
    pg_catalog.jsonb_build_object(
      'sessionId', p_session_id,
      'expectedRevision', p_expected_revision,
      'expectedCycleRevision', p_expected_cycle_revision,
      'status', p_status,
      'endsAt', private.bargaining_canonical_instant(p_ends_at),
      'memberUpdate', normalized_member_update,
      'internalMinutes', normalized_internal_minutes,
      'reason', normalized_reason
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select s.cycle_id, s.campaign_id, s.chapter_id
  into target
  from public.organizing_bargaining_sessions s
  where s.id = p_session_id;

  if not found then
    raise exception 'bargaining session not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = target.cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into session_row
  from public.organizing_bargaining_sessions
  where id = p_session_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'bargaining session not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.session.outcome_recorded'
       or receipt.entity_id <> session_row.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'cycleRevision', (receipt.safe_metadata ->> 'cycleRevision')::integer,
      'sessionId', session_row.id,
      'status', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision
     or session_row.revision <> p_expected_revision then
    raise exception 'bargaining session changed; reload and try again'
      using errcode = 'PT409';
  end if;
  if campaign.status <> 'active'
     or cycle.phase = 'complete'
     or session_row.status <> 'scheduled' then
    raise exception 'bargaining session is not editable' using errcode = '22023';
  end if;
  if p_status = 'held'
     and (
       cycle.bargaining_started_on is null
       or cycle.phase in ('preparing', 'proposal_development')
       or session_row.starts_at
          < (cycle.bargaining_started_on::timestamp at time zone 'UTC')
     ) then
    raise exception 'a held session requires a verified bargaining start'
      using errcode = '22023';
  end if;
  if p_ends_at is not null and p_ends_at < session_row.starts_at then
    raise exception 'session end cannot precede its start' using errcode = '22023';
  end if;
  if p_status = 'held'
     and (
       session_row.starts_at > event_time
       or p_ends_at > event_time
     ) then
    raise exception 'a held session cannot be recorded before it ends'
      using errcode = '22023';
  end if;

  update public.organizing_bargaining_sessions
  set status = p_status,
      ends_at = case when p_status = 'held' then p_ends_at else null end,
      member_update = case
        when p_status = 'held' then normalized_member_update
        else ''
      end,
      internal_minutes = normalized_internal_minutes,
      outcome_reason = normalized_reason,
      revision = session_row.revision + 1,
      updated_at = event_time
  where id = session_row.id;

  update public.organizing_bargaining_cycles
  set revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.session.outcome_recorded',
    'bargaining_session',
    session_row.id,
    session_row.status,
    p_status,
    pg_catalog.jsonb_build_object(
      'cycleRevision',
      cycle.revision + 1
    ),
    p_request_id,
    fingerprint,
    session_row.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'cycleRevision', cycle.revision + 1,
    'sessionId', session_row.id,
    'status', p_status,
    'revision', session_row.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

do $union_ground_pt409$
declare
  targets constant text[] := array[
    'public.create_learning_session(text,text,timestamp with time zone,timestamp with time zone,uuid)',
    'public.assign_learning_session(uuid,uuid,uuid)',
    'public.offer_capacity_commitment(uuid,text,text,uuid)',
    'public.start_capacity_commitment(uuid,integer)',
    'public.record_member_recognition(uuid)',
    'public.set_organizing_campaign_status(uuid,integer,text,uuid,text,text)',
    'public.transition_organizing_campaign(uuid,integer,text,uuid,text)',
    'public.transition_organizing_bargaining_cycle(uuid,integer,integer,text,uuid,date,text,text,timestamp with time zone)',
    'public.record_organizing_ratification(uuid,integer,integer,uuid,text,text,date,text,text,text,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,text,text,uuid)',
    'public.correct_organizing_ratification(uuid,integer,integer,text,text,text,text,uuid)',
    'public.open_organizing_bargaining_cycle(uuid,integer,text,uuid,date,text,timestamp with time zone)',
    'public.record_organizing_first_contract(uuid,integer,integer,uuid,text,date,uuid,text,text,text,integer,integer,date,date)',
    'public.transition_organizing_bargaining_proposal(uuid,integer,integer,text,uuid,date,text)',
    'public.resolve_ratification_integrity_hold(uuid,integer,uuid,text)',
    'public.create_organizing_bargaining_proposal(uuid,integer,text,text,text,uuid,text,uuid[],text,uuid,integer,text,text,text)',
    'public.schedule_organizing_bargaining_session(uuid,integer,timestamp with time zone,uuid,text,text)',
    'public.record_organizing_bargaining_session_outcome(uuid,integer,integer,text,uuid,timestamp with time zone,text,text,text)'
  ];
begin
  update private.account_lifecycle_trigger_review r
     set definition_hash = s.definition_hash
    from private.account_lifecycle_trigger_surface() s,
         pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where p.oid in (select pg_catalog.to_regprocedure(t) from pg_catalog.unnest(targets) t)
     and s.kind = 'function' and s.table_name = ''
     and s.schema_name = r.schema_name and s.object_name = r.object_name
     and r.kind = 'function' and r.table_name = ''
     and r.schema_name = n.nspname
     and r.object_name = p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')';
end;
$union_ground_pt409$;

do $verify$
declare
  rewritten text[] := array[
    'private.automation_v2_execute(uuid)',
    'private.learning_undo_case(text, jsonb)',
    'private.learning_undo_case_access(text, jsonb)',
    'private.learning_undo_case_assignment(text, jsonb)',
    'private.learning_undo_case_restriction(text, jsonb)',
    'private.learning_undo_casework(text, jsonb)',
    'private.learning_undo_invitation_revoke(text, jsonb)',
    'private.learning_undo_message_mark(text, jsonb)',
    'private.learning_undo_task(text, jsonb)',
    'private.stamp_workload_configuration()',
    'private.write_organization_setting(text, jsonb, timestamp with time zone, boolean)',
    'public.accept_member_qa_answer(uuid, uuid, boolean, timestamp with time zone)',
    'public.casework_advance_step(uuid, text, text, text, uuid)',
    'public.casework_bulk_update_cases(uuid[], text, text, text, uuid)',
    'public.casework_save_intake_draft(uuid, text, uuid, uuid, jsonb, integer)',
    'public.casework_save_procedure(uuid, text, text, text, jsonb, integer)',
    'public.casework_scan_retaliation_patterns(text)',
    'public.casework_set_bargaining_status(uuid, text, text)',
    'public.casework_transition_bargaining_proposal(uuid, text, text, timestamp with time zone)',
    'public.decide_chapter_financial_request(uuid, text, uuid, integer, text, text)',
    'public.dispatch_dues_reminder_attempt(uuid, integer, integer, text, text)',
    'public.execute_organization_automation_run(uuid, text)',
    'public.execute_organization_merge_plan(uuid, uuid, uuid, uuid)',
    'public.export_member_directory_csv(uuid, text, text)',
    'public.issue_dues_assessment_batch(text, text, text, text, integer, date, text, text, text)',
    'public.merge_chapter_workstreams(uuid, uuid, integer)',
    'public.mi1_review_automation_definition(uuid, integer, text, text)',
    'public.mi1_save_automation_definition_v2(jsonb)',
    'public.mi1_submit_automation_definition(uuid, integer)',
    'public.move_chapter_task(uuid, text, text, uuid, timestamp with time zone)',
    'public.persist_compass_message_briefing(text, uuid, text, jsonb, text)',
    'public.publish_platform_announcement(uuid, integer)',
    'public.review_platform_announcement(uuid, integer)',
    'public.save_chapter_budget(uuid, text, uuid, integer, text, date, date, text, jsonb)',
    'public.save_chapter_financial_document(uuid, text, uuid, integer, text, text, text, text, uuid)',
    'public.save_configured_workload_log(uuid, integer, jsonb, text, uuid)',
    'public.save_member_operational_profile(uuid, integer, jsonb, uuid)',
    'public.save_organization_automation_definition(uuid, text, text, integer, text, text, integer)',
    'public.save_organization_workload_configuration(jsonb, integer, uuid)',
    'public.save_platform_announcement_draft(uuid, integer, text, text, text, text, timestamp with time zone, uuid)',
    'public.save_scoped_institutional_record(uuid, text, text, text, timestamp with time zone, text, text, boolean, text, integer, jsonb, uuid, uuid, text, uuid)',
    'public.save_sealed_form_draft(uuid, integer, boolean, jsonb, text)',
    'public.set_chapter_minutes_approval(uuid, integer, boolean)',
    'public.set_member_event_agenda(text, text, integer)',
    'public.set_member_event_organizer(text, uuid, integer)',
    'public.set_member_event_rsvp_open(text, boolean, integer)',
    'public.set_organization_automation_definition_status(uuid, text, integer)',
    'public.set_platform_announcement_follow(boolean, bigint, text)',
    'public.set_task_checkoff_entry(uuid, text, text, text)',
    'public.undo_my_learning_action(uuid, integer)',
    'public.update_chapter_task_content(uuid, timestamp with time zone, text, text)',
    'public.update_chapter_task_fields(uuid, jsonb, timestamp with time zone)',
    'public.update_member_event(text, text, timestamp with time zone, text, text, text, boolean, boolean, integer)',
    'public.update_member_event_model(text, text, timestamp with time zone, text, text, text, boolean, boolean, jsonb, integer)',
    'public.upsert_union_outreach_codes(jsonb)',
    'public.withdraw_platform_announcement(uuid, integer)'
  ];
  missing text;
  leftover text;
begin
  select pg_catalog.string_agg(sig, ', ') into missing
  from pg_catalog.unnest(rewritten) sig
  where pg_catalog.to_regprocedure(sig) is null
     or (select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(sig))
        !~* $re$errcode\s*=\s*'PT409'$re$;
  if missing is not null then
    raise exception 'conflict refusal not moved to PT409: %', missing;
  end if;

  -- Only the kept functions may still raise 40001.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ') into leftover
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.prosrc ~* $re$errcode\s*=\s*'40001'$re$
    and p.oid not in ('private.lock_case_graph_read()'::pg_catalog.regprocedure,
      'private.lock_member_message_conversation(uuid)'::pg_catalog.regprocedure,
      'private.lock_message_lifecycle()'::pg_catalog.regprocedure)
    and not (n.nspname = 'public' and p.proname = 'submit_workload_log');
  if leftover is not null then
    raise exception 'function still refuses with 40001: %', leftover;
  end if;

  -- Reviewed lifecycle-graph functions carry a definition hash; refresh the
  -- rows of the functions re-created above from the review surface itself,
  -- which hashes under its own empty search_path whatever this session's is,
  -- then re-run the review check.
  update private.account_lifecycle_trigger_review r
     set definition_hash = s.definition_hash
    from private.account_lifecycle_trigger_surface() s,
         pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where p.oid in (select pg_catalog.to_regprocedure(sig) from pg_catalog.unnest(rewritten) sig)
     and s.kind = 'function' and s.table_name = ''
     and s.schema_name = r.schema_name and s.object_name = r.object_name
     and r.kind = 'function' and r.table_name = ''
     and r.schema_name = n.nspname
     and r.object_name = p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')';
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger inventory differs from review';
  end if;
end;
$verify$;

notify pgrst, 'reload schema';
commit;
