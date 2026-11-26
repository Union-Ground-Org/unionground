-- BUG-UG-FUNCTIONS-CAST-TIMESTAMPS-TO-THE-UTC-DAY-20261115 (#8876)
--
-- Seventeen functions dated or windowed things on the UTC day. The hosted
-- databases run in UTC and Union Ground counts a person's day in Eastern time,
-- so from 7 PM Eastern (8 PM in daylight time) they placed evening activity
-- on the next day, week, month or quarter. Each now reads the Eastern
-- calendar: private.eastern_day() for today
-- (20261113122500_eastern_day_helper.sql), and at time zone
-- 'America/New_York' for an instant or a day's bounds. Nothing else in any
-- body changes, and grants are unchanged (create or replace keeps them).
--   Automation and casework reminders: the overdue, due-soon and case
--     deadline days of private.automation_v2_candidates; monthly recurrence in
--     private.casework_reminder_next_occurrence, which now counts and steps on
--     the Eastern calendar and wall clock (daily and weekly still step by
--     elapsed time).
--   Chapter connections: the previous quarter of
--     private.chapter_connection_previous_quarter and the period key of
--     public.set_chapter_connection_source_tags, together. The two calendars
--     name a different quarter only on a quarter's last evening: at 10 PM
--     Eastern on 2026-03-31 the UTC day is already April 1, so the UTC
--     calendar called 2026Q1, the quarter still running in Eastern time, the
--     previous one (now 2025Q4). A freeze on such an evening stored that
--     quarter's run in private.chapter_connection_aggregate_runs early, under
--     its own correct key and with UTC bounds. Every stored run keeps UTC
--     bounds (midnight UTC, four or five hours off Eastern). Frozen runs are
--     not recomputed; the pull request gives a read-only count of runs frozen
--     before their quarter ended in Eastern time.
--   Usage digests: the week and 28-day windows, their event bounds and the
--     visit cut-off of private.usage_digest_windows, private.usage_digest_bucket,
--     private.usage_digest_window_publishable and
--     private.generate_analytics_usage_digests. Stored digests are not
--     corrected: the privacy repair reuses a published bucket by its start
--     date and never republishes a window. Windows still start on Mondays, so
--     the switch leaves one five-hour seam (that Sunday evening) and no
--     overlap. A week stored before this migration was counted on UTC bounds,
--     so the monthly privacy check removes a stored week's people on both its
--     Eastern and its UTC bounds; it can only withhold more, never publish
--     more.
--   Weekly questions: the current week of public.submit_weekly_question,
--     public.submit_weekly_poll_question, public.list_weekly_questions,
--     public.boost_weekly_question and public.promote_weekly_question, the only
--     writers and readers of member_weekly_questions.week_start (selection
--     does not read it). A question submitted on a Sunday evening was keyed a
--     week ahead; stored keys are not corrected.
--   Other: the date in private.drive_meeting_folder_name (a filed meeting keeps
--     its reserved folder, keyed by meeting), the steward email draft title and
--     reference in private.route_steward_email_intake, the event date in
--     private.engagement_follow_up_sweep's message, and today in
--     public.record_member_home_return. Copy already sent is not corrected.
-- The other eleven of the record's 28 keep the UTC cast, each for a reason
-- given in the pull request: four compare instants with auth.sessions'
-- UTC-naive refreshed_at, two are machine stamps, two keep the UTC page-view
-- bucket that #8568 part D keeps, and three ask for appointment slots over
-- a day either side, which already contains the Eastern day.
-- A predecessor guard refuses to run unless every live body is the reviewed one.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

do $preflight$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.automation_v2_candidates(uuid,boolean)'::regprocedure)
    is distinct from '6afb8e6ee42262f38f5b37a3f9b2592e' then
    raise exception 'unreviewed predecessor: private.automation_v2_candidates' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.casework_reminder_next_occurrence(timestamp with time zone,text,timestamp with time zone)'::regprocedure)
    is distinct from 'b8bcfab04bedcf8e346aeb7d1ac9e9ac' then
    raise exception 'unreviewed predecessor: private.casework_reminder_next_occurrence' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.chapter_connection_previous_quarter()'::regprocedure)
    is distinct from '68f227c455f199997880857f6b24b7be' then
    raise exception 'unreviewed predecessor: private.chapter_connection_previous_quarter' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.set_chapter_connection_source_tags(text,text,text,uuid,text[])'::regprocedure)
    is distinct from '07e8f53f5867026c9d3b37272cdf4dc0' then
    raise exception 'unreviewed predecessor: public.set_chapter_connection_source_tags' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.usage_digest_windows(text,timestamp with time zone)'::regprocedure)
    is distinct from '601765de54e5bef4590b124b8710408f' then
    raise exception 'unreviewed predecessor: private.usage_digest_windows' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.usage_digest_bucket(uuid,date,date,integer)'::regprocedure)
    is distinct from '885fcf018d55a608c45d8d921defb216' then
    raise exception 'unreviewed predecessor: private.usage_digest_bucket' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.usage_digest_window_publishable(uuid,date,date,integer,text)'::regprocedure)
    is distinct from 'e4f6fe89aed67c15f1fcd6cc95828470' then
    raise exception 'unreviewed predecessor: private.usage_digest_window_publishable' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.generate_analytics_usage_digests(timestamp with time zone,integer,boolean)'::regprocedure)
    is distinct from '9514ef889dd592f5a30b0766a7c6838b' then
    raise exception 'unreviewed predecessor: private.generate_analytics_usage_digests' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.submit_weekly_question(text)'::regprocedure)
    is distinct from '7ac4f1f8637b62950bf76fc3d140dfaa' then
    raise exception 'unreviewed predecessor: public.submit_weekly_question' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.submit_weekly_poll_question(text,jsonb)'::regprocedure)
    is distinct from 'cdde35dbea59f977072279f199ba7e84' then
    raise exception 'unreviewed predecessor: public.submit_weekly_poll_question' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.list_weekly_questions()'::regprocedure)
    is distinct from '08e8633e5a14c3b10fc41e0e9e9a7f9b' then
    raise exception 'unreviewed predecessor: public.list_weekly_questions' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.boost_weekly_question(uuid)'::regprocedure)
    is distinct from '53883bc94a4ab9ac3befca60a3b2f8ec' then
    raise exception 'unreviewed predecessor: public.boost_weekly_question' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.promote_weekly_question(uuid)'::regprocedure)
    is distinct from 'f77c6e4acf25eeb152fe7686da552775' then
    raise exception 'unreviewed predecessor: public.promote_weekly_question' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.drive_meeting_folder_name(text,timestamp with time zone,text)'::regprocedure)
    is distinct from 'dcac884a67a8bdf17600fb337ec20d37' then
    raise exception 'unreviewed predecessor: private.drive_meeting_folder_name' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.route_steward_email_intake(uuid)'::regprocedure)
    is distinct from '3767403d57949aaee568b50167586e0e' then
    raise exception 'unreviewed predecessor: private.route_steward_email_intake' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.engagement_follow_up_sweep(integer)'::regprocedure)
    is distinct from '5d71edff337445dc099170698d9b2fad' then
    raise exception 'unreviewed predecessor: private.engagement_follow_up_sweep' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.record_member_home_return()'::regprocedure)
    is distinct from 'e92569ea78741d86d8ba249f3d3026f6' then
    raise exception 'unreviewed predecessor: public.record_member_home_return' using errcode='55000';
  end if;
end
$preflight$;

-- private.automation_v2_candidates (from 20261003030000_automation_recipe_defaults.sql)
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
   when 'overdue_task' then t.due_date <= (select private.eastern_day())-d.threshold_days
   when 'task_due' then t.due_date between (select private.eastern_day()) and (select private.eastern_day())+d.threshold_days
   when 'blocked_task' then t.blocked
   when 'unassigned_task' then t.assignee_id is null and not exists(select 1 from public.chapter_task_assignments a where a.task_id=t.id)
   when 'stale_task' then t.updated_at <= now()-d.threshold_days*interval '24 hours'
   when 'review_task' then t.status='needs_review' and t.updated_at<=now()-d.threshold_days*interval '24 hours'
   else false end
 union all
 select 'case',c.id::text,c.chapter_id,c.created_at,c.status
 from d join public.member_cases c on c.organization_id=d.organization_id
 where c.chapter_id is not null and c.status='active' and case d.trigger_kind
 when 'case_deadline' then c.deadline <= (select private.eastern_day())+d.threshold_days
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

-- private.casework_reminder_next_occurrence (from 20260924190100_casework_reminder_delivery.sql)
create or replace function private.casework_reminder_next_occurrence(
  p_remind_at timestamptz,
  p_recurrence text,
  p_now timestamptz
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_step interval;
  v_count bigint;
  v_next timestamptz;
  v_local timestamp;
begin
  -- #8876: a monthly reminder counts and steps on the Eastern calendar and
  -- wall clock. On the UTC calendar an evening reminder (from 7 PM Eastern)
  -- belonged to the next day and month, so it recurred a day late.
  v_local := p_remind_at at time zone 'America/New_York';
  if p_recurrence = 'monthly' then
    v_count := greatest(1, (
      (pg_catalog.date_part('year', p_now at time zone 'America/New_York') - pg_catalog.date_part('year', v_local)) * 12
      + pg_catalog.date_part('month', p_now at time zone 'America/New_York') - pg_catalog.date_part('month', v_local)
    )::bigint);
    v_step := interval '1 month';
  elsif p_recurrence in ('daily', 'weekly') then
    v_step := case p_recurrence when 'daily' then interval '1 day' else interval '7 days' end;
    v_count := greatest(1, pg_catalog.floor(
      pg_catalog.date_part('epoch', p_now - p_remind_at) / pg_catalog.date_part('epoch', v_step)
    )::bigint);
  else
    return null;
  end if;
  while v_count > 1 and case when p_recurrence = 'monthly' then (v_local + v_step * (v_count - 1)) at time zone 'America/New_York' else p_remind_at + v_step * (v_count - 1) end > p_now loop
    v_count := v_count - 1;
  end loop;
  v_next := case when p_recurrence = 'monthly' then (v_local + v_step * v_count) at time zone 'America/New_York' else p_remind_at + v_step * v_count end;
  while v_next <= p_now loop
    v_count := v_count + 1;
    v_next := case when p_recurrence = 'monthly' then (v_local + v_step * v_count) at time zone 'America/New_York' else p_remind_at + v_step * v_count end;
  end loop;
  return v_next;
end;
$function$;

-- private.chapter_connection_previous_quarter (from 20260928103000_chapter_connection_suggestions_backend.sql)
create or replace function private.chapter_connection_previous_quarter()
returns table (period_key text, starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = ''
as $function$
  -- #8876: the quarter is the Eastern quarter, so on a quarter's last evening
  -- (from 7 PM Eastern) the quarter still running is not yet the previous one.
  select
    pg_catalog.to_char(q.starts_at at time zone 'America/New_York', 'YYYY"Q"Q') as period_key,
    q.starts_at,
    q.ends_at
  from (
    select
      (pg_catalog.date_trunc('quarter', (select private.eastern_day())::timestamp) - interval '3 months') at time zone 'America/New_York' as starts_at,
      pg_catalog.date_trunc('quarter', (select private.eastern_day())::timestamp) at time zone 'America/New_York' as ends_at
  ) q;
$function$;

-- public.set_chapter_connection_source_tags (from 20260928103100_chapter_connection_review_repairs.sql)
create or replace function public.set_chapter_connection_source_tags(
  p_selected_hat text,
  p_chapter_id text,
  p_source_kind text,
  p_source_id uuid,
  p_topic_keys text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  kind text;
  topics text[];
  contributor uuid;
  occurred_at timestamptz;
  source_chapter text;
  source_status text;
  confirmed integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter, array['advisor', 'admin', 'vp']);

  kind := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source_kind, '')));
  if kind not in ('grievance', 'survey', 'feedback') then
    raise exception 'source kind invalid' using errcode = '22023';
  end if;
  if p_source_id is null then
    raise exception 'source record unavailable' using errcode = '22023';
  end if;
  topics := coalesce(array(
    select pg_catalog.lower(pg_catalog.btrim(key))
    from pg_catalog.unnest(coalesce(p_topic_keys, array[]::text[])) as key
  ), array[]::text[]);
  if pg_catalog.array_position(coalesce(p_topic_keys, array[]::text[]), null) is not null
     or not private.chapter_connection_keys_valid(topics, private.chapter_connection_issue_keys(), 10) then
    raise exception 'topic keys invalid' using errcode = '22023';
  end if;

  if kind = 'grievance' then
    select c.user_id, c.updated_at, c.status into contributor, occurred_at, source_status
    from public.member_cases c
    where c.id = p_source_id
      and c.organization_id = org
      and c.chapter_id = chapter;
    if not found
       or source_status <> 'resolved'
       or not private.casework_can_read(p_source_id)
       or not private.member_case_visible_to_caller(p_source_id) then
      raise exception 'source record unavailable' using errcode = '22023';
    end if;
  elsif kind = 'survey' then
    perform private.engagement_require_staff(org);
    select s.respondent_user_id, s.submitted_at, s.status, v.chapter_id
      into contributor, occurred_at, source_status, source_chapter
    from public.organization_survey_sessions s
    join public.organization_surveys v on v.id = s.survey_id
    where s.id = p_source_id
      and s.organization_id = org;
    if not found
       or source_status <> 'submitted'
       or occurred_at is null
       or not coalesce((
         source_chapter = chapter
         or (source_chapter is null and exists (
           select 1 from public.member_chapter_memberships m
           where m.user_id = contributor and m.chapter_id = chapter and m.status = 'active'
         ))
       ), false) then
      raise exception 'source record unavailable' using errcode = '22023';
    end if;
  else
    perform private.engagement_require_staff(org);
    select e.user_id, e.responded_at, e.state, pr.chapter_id
      into contributor, occurred_at, source_status, source_chapter
    from public.organization_pulse_events e
    join public.organization_pulse_prompts pr on pr.id = e.prompt_id
    where e.id = p_source_id
      and e.organization_id = org;
    if not found
       or source_status <> 'responded'
       or occurred_at is null
       or not coalesce((
         source_chapter = chapter
         or (source_chapter is null and exists (
           select 1 from public.member_chapter_memberships m
           where m.user_id = contributor and m.chapter_id = chapter and m.status = 'active'
         ))
       ), false) then
      raise exception 'source record unavailable' using errcode = '22023';
    end if;
  end if;

  update private.chapter_connection_source_tags t
  set status = 'removed', updated_at = pg_catalog.now()
  where t.source_kind = kind
    and t.source_id = p_source_id
    and t.status = 'confirmed'
    and t.topic_key <> all (topics);

  insert into private.chapter_connection_source_tags as t (
    organization_id, chapter_id, source_kind, case_id, survey_session_id, pulse_event_id,
    topic_key, contributor_user_id, source_occurred_at, status
  )
  select
    org, chapter, kind,
    case when kind = 'grievance' then p_source_id end,
    case when kind = 'survey' then p_source_id end,
    case when kind = 'feedback' then p_source_id end,
    key, contributor, occurred_at, 'confirmed'
  from pg_catalog.unnest(pg_catalog.array_prepend(null::text, topics)) as key
  on conflict (source_kind, source_id, topic_key) do update
    set status = 'confirmed',
        chapter_id = excluded.chapter_id,
        contributor_user_id = excluded.contributor_user_id,
        source_occurred_at = excluded.source_occurred_at,
        updated_at = pg_catalog.now();

  select pg_catalog.count(*)::integer into confirmed
  from private.chapter_connection_source_tags t
  where t.source_kind = kind and t.source_id = p_source_id and t.status = 'confirmed' and t.topic_key is not null;

  perform private.chapter_connection_audit(org, chapter, 'chapter_connection_source_tags_changed',
    pg_catalog.jsonb_build_object(
      'entityType', kind,
      'operation', 'set',
      'count', confirmed
    ));

  return pg_catalog.jsonb_build_object(
    'chapterId', chapter,
    'sourceKind', kind,
    'sourceId', p_source_id,
    'topicKeys', pg_catalog.to_jsonb(topics),
    'occurredAt', occurred_at,
    'periodKey', pg_catalog.to_char(occurred_at at time zone 'America/New_York', 'YYYY"Q"Q')
  );
end;
$function$;

-- private.usage_digest_windows (from 20261010130000_ai_usage_digest.sql)
create or replace function private.usage_digest_windows(p_period text, p_now timestamptz)
returns table (bucket_start date, bucket_end date)
language sql
immutable
security definer
set search_path = ''
as $function$
  select w.bucket_start, w.bucket_end
  from (
    select
      case when p_period = 'weekly'
        then (pg_catalog.date_trunc('week', (p_now at time zone 'America/New_York'))::date - (offsets.n * 7))
        else (private.usage_digest_block_start((p_now at time zone 'America/New_York')::date) - (offsets.n * 28))
      end as bucket_start,
      case when p_period = 'weekly'
        then (pg_catalog.date_trunc('week', (p_now at time zone 'America/New_York'))::date - ((offsets.n - 1) * 7) - 1)
        else (private.usage_digest_block_start((p_now at time zone 'America/New_York')::date) - ((offsets.n - 1) * 28) - 1)
      end as bucket_end
    from pg_catalog.generate_series(case when p_period = 'weekly' then 4 else 2 end, 1, -1) as offsets(n)
    where p_period in ('weekly', 'monthly')
  ) w
$function$;

-- private.usage_digest_bucket (from 20261010200000_ai_usage_digest_privacy_repair.sql)
create or replace function private.usage_digest_bucket(
  p_organization_id uuid,
  p_start date,
  p_end date,
  p_floor integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  floor_size integer := greatest(25, coalesce(p_floor, 25));
  actors bigint;
  checkins bigint;
  checkin_people bigint;
begin
  select pg_catalog.count(distinct e.user_id) into actors
  from public.organization_engagement_events e
  where e.organization_id = p_organization_id and e.event_type = 'page_view'
    and e.occurred_at >= (p_start::timestamp at time zone 'America/New_York') and e.occurred_at < ((p_end + 1)::timestamp at time zone 'America/New_York');

  select pg_catalog.count(*), pg_catalog.count(distinct e.user_id) into checkins, checkin_people
  from public.organization_engagement_events e
  where e.organization_id = p_organization_id and e.event_type = 'meeting_check_in'
    and e.occurred_at >= (p_start::timestamp at time zone 'America/New_York') and e.occurred_at < ((p_end + 1)::timestamp at time zone 'America/New_York');

  if actors < floor_size then
    return private.usage_digest_withheld_bucket(p_start, p_end, floor_size);
  end if;

  return pg_catalog.jsonb_build_object(
    'start', p_start, 'end', p_end, 'suppressed', false, 'minCohort', floor_size,
    'actors', private.usage_digest_floored(actors),
    'checkins', case when checkin_people >= floor_size then private.usage_digest_floored(checkins) end
  );
end;
$function$;

-- private.usage_digest_window_publishable (from 20261010200000_ai_usage_digest_privacy_repair.sql)
create or replace function private.usage_digest_window_publishable(
  p_organization_id uuid,
  p_start date,
  p_end date,
  p_floor integer,
  p_event_type text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  with weeks as (
    select (p_start + (span.n * 7)) as week_start, (p_start + (span.n * 7) + 6) as week_end
    from pg_catalog.generate_series(0, ((p_end - p_start + 1) / 7) - 1) as span(n)
  ), counted as (
    select weeks.week_start, weeks.week_end, (
      select pg_catalog.count(distinct e.user_id)
      from public.organization_engagement_events e
      where e.organization_id = p_organization_id and e.event_type = p_event_type
        and e.occurred_at >= (weeks.week_start::timestamp at time zone 'America/New_York')
        and e.occurred_at < ((weeks.week_end + 1)::timestamp at time zone 'America/New_York')
    ) as people, exists (
      select 1
      from private.analytics_usage_digests d
      cross join lateral pg_catalog.jsonb_array_elements(d.buckets) b
      where d.organization_id = p_organization_id
        and (b.value ->> 'start')::date = weeks.week_start
        and (b.value ->> 'end')::date = weeks.week_end
        and (b.value ->> 'suppressed')::boolean is false
    ) as stored
    from weeks
  ), publishable_weeks as (
    select counted.week_start, counted.week_end, counted.stored
    from counted
    where (counted.people >= 25 or counted.stored)
      and not (counted.week_start = p_start and counted.week_end = p_end)
  )
  -- Remove people, not just their events: someone in a publishable week is
  -- already in that week's figure.
  select p_event_type in ('page_view', 'meeting_check_in') and (
    select pg_catalog.count(distinct e.user_id)
    from public.organization_engagement_events e
    where e.organization_id = p_organization_id and e.event_type = p_event_type
      and e.occurred_at >= (p_start::timestamp at time zone 'America/New_York')
      and e.occurred_at < ((p_end + 1)::timestamp at time zone 'America/New_York')
      and not exists (
        select 1
        from public.organization_engagement_events p
        join publishable_weeks w
          on (p.occurred_at >= (w.week_start::timestamp at time zone 'America/New_York')
              and p.occurred_at < ((w.week_end + 1)::timestamp at time zone 'America/New_York'))
          -- legacy-utc-bounds: a stored week may have been published before
          -- #8876 on UTC bounds. Its people are removed on those bounds too, so
          -- a month that mixes the two never counts a published person toward
          -- its remainder (gate round 1 of #9031, r2s1). This only removes
          -- people, so it can withhold a figure and never publishes more.
          or (w.stored
              and p.occurred_at >= (w.week_start::timestamp at time zone 'UTC')
              and p.occurred_at < ((w.week_end + 1)::timestamp at time zone 'UTC'))
        where p.organization_id = p_organization_id and p.event_type = p_event_type
          and p.user_id = e.user_id
      )
  ) >= greatest(25, coalesce(p_floor, 25))
$function$;

-- private.generate_analytics_usage_digests (from 20261028080000_platform_organization_boundary.sql)
create or replace function private.generate_analytics_usage_digests(
  p_now timestamptz default pg_catalog.now(),
  p_limit integer default 200,
  p_force boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  local_now timestamp := coalesce(p_now, pg_catalog.now()) at time zone 'America/New_York';
  org record;
  period text;
  window_row record;
  first_start date;
  last_end date;
  buckets jsonb;
  deltas jsonb;
  bucket jsonb;
  floor_size integer;
  inserted integer := 0;
  added integer;
  org_inserted integer;
  has_data boolean;
begin
  if not coalesce(p_force, false) and pg_catalog.date_part('hour', local_now) < 9 then
    return 0;
  end if;
  delete from private.analytics_usage_digests d
  where not exists (select 1 from public.organizations o where o.id = d.organization_id);
  delete from private.analytics_usage_digest_visits v
  where v.window_start < ((coalesce(p_now, pg_catalog.now()) at time zone 'America/New_York')::date - 112)
     or not exists (select 1 from public.organizations o where o.id = v.organization_id);

  for org in
    select o.id
    from public.organizations o
    where o.status = 'active' and o.kind = 'union'
      and private.organization_feature_enabled(o.id, 'features.analytics.ai_usage_digest')
      and not exists (
        select 1 from private.analytics_usage_digest_visits v
        where v.organization_id = o.id
          and v.period = 'weekly'
          and v.window_start = (select min(w.bucket_start) from private.usage_digest_windows('weekly', p_now) w)
      )
    order by o.id
    limit greatest(1, least(coalesce(p_limit, 200), 1000))
  loop
    begin
    org_inserted := 0;
    floor_size := greatest(25, coalesce(private.organization_limit(org.id, 'limits.analytics.ai_usage_digest_min_cohort'), 25),
      coalesce(private.organization_limit(org.id, 'limits.analytics.anonymity_floor'), 25));
    foreach period in array array['weekly', 'monthly'] loop
      buckets := '[]'::jsonb;
      deltas := '[]'::jsonb;
      first_start := null;
      last_end := null;
      for window_row in select w.bucket_start, w.bucket_end from private.usage_digest_windows(period, p_now) w order by w.bucket_start loop
        -- An interval stored by an earlier release keeps its first figures
        -- and suppression decision: a recount after account deletion or a
        -- floor change would differ from the published one by exactly what
        -- left the interval, and the difference would be subtractable.
        select b.value into bucket
        from private.analytics_usage_digests d
        cross join lateral pg_catalog.jsonb_array_elements(d.buckets) b
        where d.organization_id = org.id
          and (b.value ->> 'start')::date = window_row.bucket_start
          and (b.value ->> 'end')::date = window_row.bucket_end
        order by d.generated_at, d.id
        limit 1;
        -- Stored under a lower floor than today's: keep it dark rather than
        -- recount it.
        if bucket is not null and coalesce((bucket ->> 'minCohort')::integer, 0) < floor_size then
          bucket := private.usage_digest_withheld_bucket(window_row.bucket_start, window_row.bucket_end, floor_size);
        end if;
        if bucket is null then
          bucket := private.usage_digest_bucket(org.id, window_row.bucket_start, window_row.bucket_end, floor_size);
          -- A bucket that passed its own floors still withholds a figure when
          -- the people it adds beyond its separately publishable inner weeks
          -- are under the floor (project decision Q40 = A; F1 for check-ins).
          if (bucket ->> 'suppressed')::boolean is false
            and not private.usage_digest_window_publishable(org.id, window_row.bucket_start, window_row.bucket_end, floor_size, 'page_view') then
            bucket := private.usage_digest_withheld_bucket(window_row.bucket_start, window_row.bucket_end, floor_size);
          elsif bucket ->> 'checkins' is not null
            and not private.usage_digest_window_publishable(org.id, window_row.bucket_start, window_row.bucket_end, floor_size, 'meeting_check_in') then
            bucket := bucket || pg_catalog.jsonb_build_object('checkins', null);
          end if;
        end if;
        buckets := buckets || pg_catalog.jsonb_build_array(bucket);
        first_start := coalesce(first_start, window_row.bucket_start);
        last_end := window_row.bucket_end;
      end loop;
      insert into private.analytics_usage_digest_visits (organization_id, period, window_start)
      values (org.id, period, first_start)
      on conflict on constraint analytics_usage_digest_visits_pkey do nothing;
      -- The last two buckets are the comparison the old digest reported
      -- (de7df4b57c^:lib/analytics/usage-digest.ts deltas). A withheld figure
      -- on either side reports direction 'unknown' and no figures.
      if pg_catalog.jsonb_array_length(buckets) >= 2 then
        deltas := (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'metric', metric.name,
            'current', current_bucket.value -> metric.name,
            'previous', previous_bucket.value -> metric.name,
            'direction', private.usage_digest_direction(
              (current_bucket.value ->> metric.name)::integer,
              (previous_bucket.value ->> metric.name)::integer)
          ) order by metric.ordinality), '[]'::jsonb)
          from pg_catalog.unnest(array['actors', 'checkins']) with ordinality as metric(name, ordinality)
          cross join lateral (select buckets -> (pg_catalog.jsonb_array_length(buckets) - 1) as value) current_bucket
          cross join lateral (select buckets -> (pg_catalog.jsonb_array_length(buckets) - 2) as value) previous_bucket
        );
      end if;
      has_data := exists (
        select 1 from pg_catalog.jsonb_array_elements(buckets) element
        where (element.value ->> 'suppressed')::boolean is false
          and (element.value ->> 'actors')::integer > 0
      );
      insert into private.analytics_usage_digests (
        organization_id, period, window_start, window_end, buckets, deltas, has_data, ai_status
      ) values (
        org.id, period, first_start, last_end, buckets, deltas,
        has_data,
        case when has_data and private.organization_feature_enabled(org.id, 'features.analytics.ai_usage_digest_wording')
          then 'available' else 'not_requested' end
      )
      on conflict on constraint analytics_usage_digests_one_per_window do nothing;
      get diagnostics added = row_count;
      org_inserted := org_inserted + added;
    end loop;
    inserted := inserted + org_inserted;
    exception when others then
      -- Do not expose SQL error details or hold later organizations behind a
      -- repeatedly failing first row. Retry this organization next window.
      insert into private.analytics_usage_digest_visits (organization_id, period, window_start)
      select org.id, 'weekly', min(w.bucket_start) from private.usage_digest_windows('weekly', p_now) w
      on conflict on constraint analytics_usage_digest_visits_pkey do nothing;
      raise warning 'usage digest organization skipped (SQLSTATE %)', sqlstate;
    end;
  end loop;
  return inserted;
end;
$function$;

-- public.submit_weekly_question (from 20260812160000_reward_economy_effects.sql)
create or replace function public.submit_weekly_question(p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  current_week date := pg_catalog.date_trunc('week', private.eastern_day()::timestamp)::date;
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  question_id uuid;
  inserted boolean := false;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 10 and 280 then
    raise exception 'question must be 10 to 280 characters' using errcode = '22023';
  end if;

  insert into public.member_weekly_questions (chapter_id, user_id, week_start, body)
  values (caller_chapter, caller, current_week, clean_body)
  on conflict (user_id, week_start) do nothing
  returning id into question_id;
  inserted := question_id is not null;
  if not inserted then
    select q.id into question_id from public.member_weekly_questions q
    where q.user_id = caller and q.week_start = current_week;
  end if;

  return pg_catalog.jsonb_build_object('id', question_id, 'created', inserted);
end;
end;
$$;

-- public.submit_weekly_poll_question (from 20260828220000_mi1_voice_survey_completion.sql)
create or replace function public.submit_weekly_poll_question(p_body text, p_options jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  current_week date := pg_catalog.date_trunc('week', private.eastern_day()::timestamp)::date;
  clean_body text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_body, ''), '[[:cntrl:]]', ' ', 'g'));
  option_item jsonb;
  option_value text;
  option_values text[] := array[]::text[];
  clean_options jsonb := '[]'::jsonb;
  question_id uuid;
  inserted boolean := false;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 10 and 280
     or pg_catalog.jsonb_typeof(p_options) <> 'array'
     or pg_catalog.jsonb_array_length(p_options) not between 2 and 8 then
    raise exception 'question and 2 to 8 answer options are required' using errcode = '22023';
  end if;
  for option_item in select value from pg_catalog.jsonb_array_elements(p_options)
  loop
    option_value := case when pg_catalog.jsonb_typeof(option_item) = 'string' then option_item #>> '{}' else null end;
    option_value := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(option_value, ''), '[[:cntrl:]]', ' ', 'g'));
    if pg_catalog.char_length(option_value) not between 1 and 120 then
      raise exception 'answer options must be plain text up to 120 characters' using errcode = '22023';
    end if;
    if option_value = any(option_values) then
      raise exception 'answer options must be unique' using errcode = '22023';
    end if;
    option_values := pg_catalog.array_append(option_values, option_value);
    clean_options := clean_options || pg_catalog.jsonb_build_array(option_value);
  end loop;

  insert into public.member_weekly_questions (chapter_id, user_id, week_start, body, options)
  values (caller_chapter, caller, current_week, clean_body, clean_options)
  on conflict (user_id, week_start) do nothing
  returning id into question_id;
  inserted := question_id is not null;
  if not inserted then
    select q.id into question_id
    from public.member_weekly_questions q
    where q.user_id = caller and q.week_start = current_week
    for update;
    update public.member_weekly_questions
    set body = clean_body, options = clean_options, updated_at = pg_catalog.now()
    where id = question_id and editorial_state = 'submitted';
    if not found then
      raise exception 'reserved or published questions cannot be edited' using errcode = '22023';
    end if;
  end if;
  return pg_catalog.jsonb_build_object('id', question_id, 'created', inserted);
end;
end;
$function$;

-- public.list_weekly_questions (from 20261002101000_weekly_question_draw_and_live_poll_schedule.sql)
create or replace function public.list_weekly_questions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  caller_org uuid := private.current_member_organization();
  current_week date := pg_catalog.date_trunc('week', private.eastern_day()::timestamp)::date;
  promotion_available boolean;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select caller_org is not null
    and private.organization_feature_enabled(caller_org, 'features.engagement_voice.weekly_question_priority_slot')
    and exists (
    select 1
    from public.member_reward_grants g
    join public.member_reward_items i on i.key = g.item_key and i.active
    where g.organization_id = caller_org
      and g.user_id = caller
      and g.item_key = 'priority-wq-slot'
      and g.status in ('granted','shipped','delivered')
      and not exists (
        select 1 from public.member_weekly_question_promotions used
        where used.reward_grant_id = g.id
      )
  ) into promotion_available;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', ranked.id,
      'body', ranked.body,
      'options', ranked.options,
      'editorialState', ranked.editorial_state,
      'submittedByMe', ranked.user_id = caller,
      'boostedByMe', ranked.boosted_by_me,
      'promotedByMe', ranked.user_id = caller and ranked.priority,
      'promotionAvailable', promotion_available,
      'priority', ranked.priority,
      'score', ranked.score,
      'createdAt', ranked.created_at
    ) order by ranked.priority desc, ranked.score desc, ranked.created_at, ranked.id)
    from (
      select q.id, q.user_id, q.body, q.options, q.editorial_state, q.created_at,
        exists (
          select 1 from public.member_weekly_question_promotions p
          where p.question_id = q.id
        ) as priority,
        exists (
          select 1 from public.member_weekly_question_supports mine
          where mine.question_id = q.id and mine.user_id = caller
        ) as boosted_by_me,
        coalesce((
          select pg_catalog.sum(case
            when private.member_reward_effect_enabled(s.user_id, 'wq-boost-2x') then 2 else 1 end)::integer
          from public.member_weekly_question_supports s where s.question_id = q.id
        ), 0) as score
      from public.member_weekly_questions q
      where q.chapter_id = caller_chapter
        and q.week_start = current_week
        and q.editorial_state in ('submitted', 'reserved', 'published')
      order by priority desc, score desc, q.created_at, q.id
      limit 25
    ) ranked
  ), '[]'::jsonb);
end;
$function$;

-- public.boost_weekly_question (from 20260828220000_mi1_voice_survey_completion.sql)
create or replace function public.boost_weekly_question(p_question_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  current_week date := pg_catalog.date_trunc('week', private.eastern_day()::timestamp)::date;
  inserted boolean := false;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_question_id is null or not exists (
    select 1 from public.member_weekly_questions q
    where q.id = p_question_id
      and q.chapter_id = caller_chapter
      and q.week_start = current_week
      and q.editorial_state in ('submitted', 'reserved')
      and q.user_id <> caller
  ) then
    raise exception 'question unavailable' using errcode = '22023';
  end if;
  insert into public.member_weekly_question_supports (question_id, user_id)
  values (p_question_id, caller)
  on conflict (question_id, user_id) do nothing;
  inserted := found;
  return pg_catalog.jsonb_build_object(
    'questionId', p_question_id,
    'created', inserted,
    'weight', case when private.member_reward_effect_enabled(caller, 'wq-boost-2x') then 2 else 1 end
  );
end;
end;
$function$;

-- public.promote_weekly_question (from 20261002101000_weekly_question_draw_and_live_poll_schedule.sql)
create or replace function public.promote_weekly_question(p_question_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  caller_org uuid := private.current_member_organization();
  current_week date := pg_catalog.date_trunc('week', private.eastern_day()::timestamp)::date;
  grant_id uuid;
begin
  if caller is null or caller_chapter is null or caller_org is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- REQ-UG-WEEKLY-QUESTION-PRIORITY-AND-WEIGHTED-DRAW-20261001: refuse
  -- before a reward is spent when the organization turned the slot off.
  if not private.organization_feature_enabled(caller_org, 'features.engagement_voice.weekly_question_priority_slot') then
    raise exception 'weekly question priority is turned off' using errcode = '55000';
  end if;

  perform 1
  from public.member_weekly_questions q
  where q.id = p_question_id
    and q.user_id = caller
    and q.chapter_id = caller_chapter
    and q.week_start = current_week
    and q.editorial_state in ('submitted', 'reserved')
  for update;
  if not found then
    raise exception 'only your available question can be promoted' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.member_weekly_question_promotions p
    where p.question_id = p_question_id
  ) then
    return pg_catalog.jsonb_build_object('questionId', p_question_id, 'promoted', false, 'alreadyPromoted', true);
  end if;

  select g.id into grant_id
  from public.member_reward_grants g
  join public.member_reward_items i on i.key = g.item_key and i.active
  where g.organization_id = caller_org
    and g.user_id = caller
    and g.item_key = 'priority-wq-slot'
    and g.status in ('granted','shipped','delivered')
    and not exists (
      select 1 from public.member_weekly_question_promotions used
      where used.reward_grant_id = g.id
    )
  order by g.created_at, g.id
  limit 1
  for update of g;

  if grant_id is null then
    raise exception 'no unused promotion entitlement' using errcode = '22023';
  end if;

  insert into public.member_weekly_question_promotions (
    question_id, reward_grant_id, organization_id, chapter_id, user_id
  ) values (p_question_id, grant_id, caller_org, caller_chapter, caller);

  return pg_catalog.jsonb_build_object(
    'questionId', p_question_id,
    'promoted', true,
    'promotionCredits', 0
  );
end;
end;
$function$;

-- private.drive_meeting_folder_name (from 20261003053000_integrations_wallet_calendar_drive_checkoff.sql)
create or replace function private.drive_meeting_folder_name(p_title text, p_starts_at timestamptz, p_event_id text)
returns text
language sql
stable
set search_path = ''
as $function$
  select 'Meeting ' || pg_catalog.to_char(p_starts_at at time zone 'America/New_York', 'YYYY-MM-DD')
    || ' · ' || pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_title, ''), '[[:cntrl:]/\\]+', ' ', 'g')), 80)
    || ' · ' || pg_catalog.left(pg_catalog.md5(coalesce(p_event_id, '')), 6);
$function$;

-- private.route_steward_email_intake (from 20261003033000_remind_here_and_steward_email_routing.sql)
create or replace function private.route_steward_email_intake(p_intake_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  intake public.steward_email_intakes%rowtype;
  org uuid;
  unquoted text;
  scan text;
  tokens text[];
  references_wanted text[];
  want_case boolean;
  want_knowledge boolean;
  sender uuid;
  sender_count integer;
  case_count integer;
  target_case public.member_cases%rowtype;
  new_article uuid;
  new_title text;
  new_ref text;
  hold text := null;
begin
  select * into intake from public.steward_email_intakes where id = p_intake_id for update;
  if not found or intake.status <> 'pending' or intake.auto_routed_at is not null then
    return pg_catalog.jsonb_build_object('routed', false);
  end if;
  select c.organization_id into org from public.chapters c where c.id = intake.chapter_id;
  if org is null then
    return pg_catalog.jsonb_build_object('routed', false);
  end if;
  if not intake.sender_authenticated then
    update public.steward_email_intakes
    set auto_route_hold = 'sender_unverified' where id = intake.id;
    return pg_catalog.jsonb_build_object('routed', false, 'hold', 'sender_unverified');
  end if;

  unquoted := private.steward_email_unquoted_body(intake.body_text);
  scan := intake.subject || pg_catalog.chr(10) || unquoted;
  tokens := private.steward_email_case_tokens(scan);
  want_case := private.organization_feature_enabled(org, 'features.messaging.steward_email_auto_route_cases')
    and pg_catalog.cardinality(tokens) > 0
    and scan ~* '\m(timeline|case\s*note|evidence)\M';
  want_knowledge := private.organization_feature_enabled(org, 'features.messaging.steward_email_auto_route_knowledge')
    and scan ~* '((^|\s)#knowledge\M|\mknowledge\s*(base|article|library)\M)';
  if not want_case and not want_knowledge then
    return pg_catalog.jsonb_build_object('routed', false);
  end if;

  select pg_catalog.count(*)::integer, (pg_catalog.array_agg(u.id))[1] into sender_count, sender
  from auth.users u
  where pg_catalog.lower(u.email) = intake.from_address
    and u.email_confirmed_at is not null
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.now());
  if sender_count <> 1 then
    hold := 'sender_unknown';
  elsif not private.steward_email_sender_reviews_chapter(sender, intake.chapter_id) then
    hold := 'sender_not_steward';
  end if;

  if hold is null and want_case then
    select pg_catalog.array_agg(distinct candidate) into references_wanted
    from (
      select token as candidate from pg_catalog.unnest(tokens) token
      union
      select 'GR-' || token from pg_catalog.unnest(tokens) token
    ) refs;
    select pg_catalog.count(*)::integer into case_count
    from public.member_cases mc
    where mc.chapter_id = intake.chapter_id
      and pg_catalog.upper(mc.reference) = any(references_wanted);
    if case_count = 0 then
      hold := 'case_not_found';
    elsif case_count > 1 then
      hold := 'case_ambiguous';
    else
      select mc.* into target_case
      from public.member_cases mc
      where mc.chapter_id = intake.chapter_id
        and pg_catalog.upper(mc.reference) = any(references_wanted);
      if target_case.organization_id is distinct from org
         or not private.casework_reminder_owner_can_read(sender, target_case.id)
         or target_case.user_id = sender then
        hold := 'case_access';
      end if;
    end if;
  end if;

  if hold is not null then
    update public.steward_email_intakes set auto_route_hold = hold where id = intake.id;
    return pg_catalog.jsonb_build_object('routed', false, 'hold', hold);
  end if;

  if want_case then
    perform private.lock_case_graph(array[sender], array[target_case.id]);
    update public.steward_email_intakes set routed_case_id = target_case.id where id = intake.id;
    insert into public.casework_audit_events (
      organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (
      target_case.organization_id, target_case.chapter_id, target_case.id, sender,
      'entity_linked', 'steward_email', intake.id,
      pg_catalog.jsonb_build_object('source', 'steward_email', 'automatic', true));
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'casework', 'casework.steward_email_attached', 'create', sender,
      'case', target_case.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('sourceKind', 'steward_email', 'sourceId', intake.id::text, 'outcome', 'routed'));
  end if;

  if want_knowledge then
    new_article := extensions.gen_random_uuid();
    new_title := pg_catalog.left(coalesce(nullif(intake.subject, ''),
      'Steward email ' || pg_catalog.to_char(intake.received_at at time zone 'America/New_York', 'YYYY-MM-DD')), 200);
    new_ref := 'Steward email ' || pg_catalog.to_char(intake.received_at at time zone 'America/New_York', 'YYYY-MM-DD');
    -- Always a draft: no verifier, no verification time, status 'draft'.
    -- Staff-typed text with no Storage provenance, so 'authored'.
    insert into public.member_kb_articles (
      id, slug, kind, title, article_ref, body, keywords, order_index,
      chapter_id, status, is_sample, version, created_by, updated_by,
      verified_by, verified_at, updated_at, content_origin
    )
    select
      new_article,
      'chapter-kb-' || pg_catalog.replace(new_article::text, '-', ''),
      'faq', new_title, new_ref,
      coalesce(nullif(unquoted, ''), intake.body_text),
      array['email-intake']::text[],
      coalesce(pg_catalog.max(article.order_index), 0) + 1,
      intake.chapter_id, 'draft', false, 1, sender, sender,
      null, null, pg_catalog.now(), 'authored'
    from public.member_kb_articles article
    where article.chapter_id = intake.chapter_id;
    insert into public.member_kb_article_revisions (
      article_id, chapter_id, version, status, kind, title, article_ref, body,
      keywords, changed_by, verified_by, verified_at, content_origin, knowledge_source_id
    )
    select a.id, a.chapter_id, a.version, a.status, a.kind, a.title, a.article_ref, a.body,
      a.keywords, sender, null, null, a.content_origin, null
    from public.member_kb_articles a where a.id = new_article;
    update public.steward_email_intakes set knowledge_article_id = new_article where id = intake.id;
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'knowledge', 'knowledge.steward_email_draft_created', 'create', sender,
      'document', new_article::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('sourceKind', 'steward_email', 'sourceId', intake.id::text,
        'reviewStatus', 'draft', 'outcome', 'routed'));
  end if;

  update public.steward_email_intakes
  set status = 'accepted', reviewed_at = pg_catalog.now(), auto_routed_at = pg_catalog.now(),
      auto_route_hold = null
  where id = intake.id;
  return pg_catalog.jsonb_build_object('routed', true, 'case', want_case, 'knowledge', want_knowledge);
end;
end;
$function$;

-- private.engagement_follow_up_sweep (from 20261003032000_event_poll_follow_ups_and_gc_escalation_flags.sql)
create or replace function private.engagement_follow_up_sweep(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  since timestamptz;
  ev record;
  poll record;
  voter uuid;
  voters integer;
  notified integer;
  threshold integer;
  drafts integer := 0;
  polls integer := 0;
  location_line text;
begin
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'invalid follow-up limit' using errcode = '22023';
  end if;
  select s.installed_at into since from private.automation_follow_up_state s where s.singleton;
  if since is null then
    return pg_catalog.jsonb_build_object('drafts', 0, 'polls', 0);
  end if;

  -- New event -> one draft announcement for the event chapter's stewards.
  for ev in
    select e.id, e.title, e.starts_at, e.location, e.chapter_id, ch.organization_id
    from public.member_events e
    join public.chapters ch on ch.id = e.chapter_id
    join public.organizations o on o.id = ch.organization_id and o.status = 'active'
    where e.cancelled_at is null
      and e.created_at >= since
      and e.created_at >= pg_catalog.now() - interval '1 day'
      and e.starts_at > pg_catalog.now()
      and not exists (
        select 1 from private.engagement_follow_ups f
        where f.source_kind = 'event' and f.source_id = e.id and f.kind = 'announcement_draft'
      )
      and private.organization_feature_enabled(ch.organization_id, 'features.automation.event_announcement_drafts')
    order by e.created_at, e.id
    limit p_limit
  loop
    location_line := case when pg_catalog.btrim(coalesce(ev.location, '')) <> ''
      then pg_catalog.chr(10) || 'Location: ' || pg_catalog.btrim(ev.location) else '' end;
    insert into private.engagement_follow_ups (
      organization_id, chapter_id, source_kind, source_id, kind, state, title, body
    ) values (
      ev.organization_id, ev.chapter_id, 'event', ev.id, 'announcement_draft', 'draft',
      pg_catalog.left('Upcoming: ' || pg_catalog.btrim(ev.title), 120),
      -- Old copy (event-handoffs.ts), dated in UTC like the old server.
      pg_catalog.left(pg_catalog.btrim(ev.title) || pg_catalog.chr(10) || pg_catalog.chr(10)
        || 'Date: ' || pg_catalog.to_char(ev.starts_at at time zone 'America/New_York', 'FMDay, FMMonth FMDD')
        || location_line || pg_catalog.chr(10) || pg_catalog.chr(10)
        || 'RSVP in the app under Events.', 4000)
    ) on conflict (source_kind, source_id, kind) do nothing;
    if found then drafts := drafts + 1; end if;
  end loop;

  -- Closed live poll -> results notice to voters, low-participation alert to
  -- its creator.
  for poll in
    select p.id, p.organization_id, p.chapter_id, p.created_by, p.results_visibility
    from public.organization_live_polls p
    join public.organizations o on o.id = p.organization_id and o.status = 'active'
    where p.state = 'closed'
      and p.closed_at >= since
      and p.closed_at >= pg_catalog.now() - interval '7 days'
      and not exists (
        select 1 from private.engagement_follow_ups f
        where f.source_kind = 'live_poll' and f.source_id = p.id::text and f.kind = 'poll_results_notice'
      )
    order by p.closed_at, p.id
    limit p_limit
  loop
    select pg_catalog.count(distinct v.voter_user_id) into voters
    from public.organization_live_poll_votes v
    where v.poll_id = poll.id and v.organization_id = poll.organization_id;

    notified := 0;
    if poll.results_visibility <> 'staff_only'
       and private.organization_feature_enabled(poll.organization_id, 'features.automation.poll_results_notice') then
      for voter in
        select distinct v.voter_user_id
        from public.organization_live_poll_votes v
        join public.organization_memberships m
          on m.organization_id = v.organization_id and m.user_id = v.voter_user_id
         and m.status = 'active' and m.revoked_at is null
        where v.poll_id = poll.id and v.organization_id = poll.organization_id
      loop
        perform private.notify_member(voter, 'poll.results', '{}'::jsonb, 'votes');
        notified := notified + 1;
      end loop;
    end if;
    insert into private.engagement_follow_ups (organization_id, chapter_id, source_kind, source_id, kind, state, recipients)
    values (poll.organization_id, poll.chapter_id, 'live_poll', poll.id::text, 'poll_results_notice',
      case when notified > 0 then 'sent' else 'skipped' end, notified)
    on conflict (source_kind, source_id, kind) do nothing;

    threshold := private.organization_limit(poll.organization_id, 'limits.automation.poll_low_participation_threshold');
    notified := 0;
    if voters < threshold
       and poll.created_by is not null
       and private.organization_feature_enabled(poll.organization_id, 'features.automation.poll_low_participation_alert')
       and exists (
         select 1 from public.organization_memberships m
         where m.organization_id = poll.organization_id and m.user_id = poll.created_by
           and m.status = 'active' and m.revoked_at is null
       )
       and (
         exists (
           select 1 from public.organization_role_grants g
           where g.organization_id = poll.organization_id and g.user_id = poll.created_by
             and g.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
         )
         or exists (
           select 1 from public.member_role_chapters r
           join public.chapters ch on ch.id = r.chapter_id and ch.organization_id = poll.organization_id
           join public.member_chapter_memberships cm
             on cm.user_id = r.user_id and cm.chapter_id = r.chapter_id and cm.status = 'active'
           where r.user_id = poll.created_by
             and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
         )
       ) then
      perform private.notify_member(poll.created_by, 'poll.low_participation', '{}'::jsonb, 'general');
      notified := 1;
    end if;
    insert into private.engagement_follow_ups (organization_id, chapter_id, source_kind, source_id, kind, state, recipients)
    values (poll.organization_id, poll.chapter_id, 'live_poll', poll.id::text, 'poll_low_participation_alert',
      case when notified > 0 then 'sent' else 'skipped' end, notified)
    on conflict (source_kind, source_id, kind) do nothing;
    polls := polls + 1;
  end loop;

  return pg_catalog.jsonb_build_object('drafts', drafts, 'polls', polls);
end;
end;
$function$;

-- public.record_member_home_return (from 20261002133000_member_home_reactivation.sql)
create or replace function public.record_member_home_return()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  declare
    caller uuid := (select auth.uid());
    org uuid;
    after_days integer;
    today date := private.eastern_day();
    previous date;
  begin
    if caller is null or not private.mfa_satisfied() then
      raise exception 'authentication required' using errcode = '42501';
    end if;
    org := private.current_member_organization();
    if org is null or not private.is_organization_member(org) then
      raise exception 'active organization membership required' using errcode = '42501';
    end if;

    if not private.organization_feature_enabled(org, 'features.home.reactivation_welcome_back') then
      return pg_catalog.jsonb_build_object('enabled', false, 'welcomeBack', false);
    end if;
    after_days := private.organization_limit(org, 'limits.home.reactivation_after_days');

    select m.last_active_on into previous
    from private.member_home_return_marks m
    where m.user_id = caller
    for update;

    if previous is null then
      insert into private.member_home_return_marks (user_id, last_active_on)
      values (caller, today)
      on conflict (user_id) do update set last_active_on = excluded.last_active_on;
    elsif previous < today then
      update private.member_home_return_marks
        set last_active_on = today
        where user_id = caller;
    end if;

    -- Old rule: the previous session is MORE than the threshold ago.
    return pg_catalog.jsonb_build_object(
      'enabled', true,
      'welcomeBack', previous is not null and previous < today - after_days,
      'afterDays', after_days
    );
  end;
end;
$function$;

commit;
