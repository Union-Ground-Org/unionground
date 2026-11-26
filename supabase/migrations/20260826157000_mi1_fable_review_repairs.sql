-- Integrity fixes for roles, accounts, and scheduled jobs: claim safety, scheduler truth, and
-- complete operator health projections. Append-only replacement definitions.

create or replace function public.claim_integration_webhook_deliveries(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare result jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.mi1_reap_expired_webhook_final_attempts();
  with candidates as (
    select d.id from public.integration_webhook_deliveries d
    join public.integration_webhooks w on w.id = d.webhook_id and w.organization_id = d.organization_id
    where w.active and w.secret_ref is not null and d.attempt_count < 5 and (
      (d.status in ('queued', 'failed') and coalesce(d.next_attempt_at, d.created_at) <= pg_catalog.now())
      or (d.status = 'sending' and d.lease_expires_at <= pg_catalog.now())
    ) order by coalesce(d.next_attempt_at, d.created_at), d.id
    limit greatest(1, least(coalesce(p_limit, 10), 25)) for update of d skip locked
  ), claimed as (
    update public.integration_webhook_deliveries d
    set status = 'sending', attempt_count = d.attempt_count + 1,
        lease_expires_at = pg_catalog.now() + interval '10 minutes',
        next_attempt_at = null, error_code = null
    from candidates where d.id = candidates.id
    returning d.*
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'deliveryId', d.id, 'attemptCount', d.attempt_count, 'url', w.url,
    'eventName', d.event_name, 'eventId', d.event_id, 'occurredAt', d.created_at,
    'secret', s.decrypted_secret
  ) order by d.created_at, d.id), '[]'::jsonb) into result
  from claimed d join public.integration_webhooks w on w.id = d.webhook_id
  join vault.decrypted_secrets s on s.id = w.secret_ref;
  update public.integration_jobs j set status = 'running', updated_at = pg_catalog.now()
  where exists (
    select 1 from pg_catalog.jsonb_array_elements(result) entry
    join public.integration_webhook_deliveries d on d.id = (entry->>'deliveryId')::uuid
    where j.organization_id = d.organization_id
      and j.idempotency_key = 'delivery:' || d.id::text
  );
  return result;
end;
$function$;

revoke all on function public.claim_integration_webhook_deliveries(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_integration_webhook_deliveries(integer) to service_role;

create or replace function public.list_organization_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'jobName', catalog.job_name, 'organizationId', org,
      'lastRunId', r.run_id, 'lastStatus', r.status,
      'lastStartedAt', r.started_at, 'lastFinishedAt', r.finished_at,
      'durationMs', case when r.finished_at is null then null else
        pg_catalog.floor(pg_catalog.date_part('epoch', r.finished_at - r.started_at) * 1000)::bigint end,
      'failureCode', r.failure_code, 'redactedSummary', r.redacted_summary,
      'acknowledged', a.run_id is not null, 'remediation', a.remediation
    ) order by catalog.job_name)
    from (select unnest(array[
      'integration-webhooks-dispatch-tick',
      'notifications-dispatch-tick', 'notifications-expiry-sweep',
      'deadline-notices-tick', 'ballot-notices-tick', 'event-notices-tick',
      'appointment-reminders-tick', 'member-messaging-dispatch',
      'workload-reminders-tick', 'ballot-choices-mix',
      'ballot-choices-mix-recent', 'task-files-reconcile-tick',
      'task-maintenance-daily'
    ]) as job_name) catalog
    left join lateral (
      select * from public.organization_job_runs run
      where run.job_name = catalog.job_name
        and (run.organization_id is null or run.organization_id = org)
      order by run.started_at desc limit 1
    ) r on true
    left join public.organization_job_acknowledgements a
      on a.organization_id = org and a.job_name = catalog.job_name and a.run_id = r.run_id
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_organization_job_health()
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_job_health() to authenticated;

-- Acceptance is a compare-and-set transition. A detail loaded before a new
-- reply or follow-up may not overwrite the newer state.
drop function if exists public.accept_member_qa_answer(uuid, uuid, boolean);
create function public.accept_member_qa_answer(
  p_question_id uuid,
  p_reply_id uuid,
  p_accepted boolean,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
    raise exception 'stale question; reload required' using errcode = '40001';
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
$function$;

revoke all on function public.accept_member_qa_answer(uuid, uuid, boolean, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.accept_member_qa_answer(uuid, uuid, boolean, timestamptz) to authenticated;

-- Serialize replies with acceptance and with idempotent retries on the parent
-- question. This makes a repeated key return the existing projection instead
-- of racing the unique constraint, and ensures a follow-up cannot silently
-- erase an accepted-answer transition.
create or replace function public.reply_member_qa_official(
  p_question_id uuid,
  p_body text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  question public.member_qa_questions%rowtype;
  existing uuid;
  created uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into question from public.member_qa_questions
  where id = p_question_id and deleted_at is null for update;
  if not found or question.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is not null then
    select id into existing from public.member_qa_replies
    where organization_id = org and idempotency_key = p_idempotency_key;
    if existing is not null then
      return private.mi1_qa_project_question(question.id, (select auth.uid()));
    end if;
  end if;
  insert into public.member_qa_replies (
    organization_id, question_id, author_user_id, kind, body, idempotency_key
  ) values (
    org, question.id, (select auth.uid()), 'official', pg_catalog.btrim(p_body), p_idempotency_key
  ) returning id into created;
  update public.member_qa_questions
  set status = case when status = 'accepted' then status else 'replied' end,
      updated_at = pg_catalog.now()
  where id = question.id;
  perform private.mi1_write_tenant_audit(org, 'qa_official_replied', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id,
    'questionId', question.id, 'replyId', created, 'kind', 'official'
  ));
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
$function$;

create or replace function public.reply_member_qa_follow_up(
  p_question_id uuid,
  p_body text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  question public.member_qa_questions%rowtype;
  existing uuid;
  created uuid;
  previous_accepted_reply_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into question from public.member_qa_questions
  where id = p_question_id and deleted_at is null for update;
  if not found
     or question.organization_id is distinct from org
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if question.author_user_id is distinct from (select auth.uid()) then
    raise exception 'only the question author can add a follow-up' using errcode = '42501';
  end if;
  if p_idempotency_key is not null then
    select id into existing from public.member_qa_replies
    where organization_id = org and idempotency_key = p_idempotency_key;
    if existing is not null then
      return private.mi1_qa_project_question(question.id, (select auth.uid()));
    end if;
  end if;
  previous_accepted_reply_id := question.accepted_reply_id;
  insert into public.member_qa_replies (
    organization_id, question_id, author_user_id, kind, body, idempotency_key
  ) values (
    org, question.id, (select auth.uid()), 'follow_up', pg_catalog.btrim(p_body), p_idempotency_key
  ) returning id into created;
  update public.member_qa_replies
  set accepted = false, updated_at = pg_catalog.now()
  where question_id = question.id and accepted;
  update public.member_qa_questions
  set status = 'open', accepted_reply_id = null, updated_at = pg_catalog.now()
  where id = question.id;
  if previous_accepted_reply_id is not null then
    perform private.mi1_write_tenant_audit(org, 'qa_answer_unaccepted', pg_catalog.jsonb_build_object(
      'organizationId', org, 'chapterId', question.chapter_id,
      'questionId', question.id, 'replyId', previous_accepted_reply_id,
      'status', 'open', 'reason', 'member_follow_up'
    ));
  end if;
  perform private.mi1_write_tenant_audit(org, 'qa_follow_up_replied', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id,
    'questionId', question.id, 'replyId', created, 'kind', 'follow_up'
  ));
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
$function$;

revoke all on function public.reply_member_qa_official(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.reply_member_qa_official(uuid, text, uuid) to authenticated;
revoke all on function public.reply_member_qa_follow_up(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.reply_member_qa_follow_up(uuid, text, uuid) to authenticated;

-- pg_cron uses several nonterminal states while pg_net-backed commands are
-- connecting or sending. Only its terminal `failed` state is a failure.
do $jobs$
begin
  if pg_catalog.to_regnamespace('cron') is null then return; end if;
  execute $ddl$
    create or replace function private.sync_organization_job_runs_from_cron_history()
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare changed_count integer;
    begin
      insert into public.organization_job_runs (
        organization_id, job_name, run_id, status, started_at, finished_at,
        failure_code, redacted_summary
      )
      select null, j.jobname, 'cron:' || d.runid::text,
        case d.status when 'succeeded' then 'completed' when 'failed' then 'failed' else 'in_progress' end,
        coalesce(d.start_time, pg_catalog.now()), d.end_time,
        case when d.status = 'failed' then 'cron_failed' end,
        case when d.status = 'failed' then 'Scheduled command failed.' end
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where j.jobname in (
        'integration-webhooks-dispatch-tick',
        'notifications-dispatch-tick', 'notifications-expiry-sweep',
        'deadline-notices-tick', 'ballot-notices-tick', 'event-notices-tick',
        'appointment-reminders-tick', 'member-messaging-dispatch',
        'workload-reminders-tick', 'ballot-choices-mix',
        'ballot-choices-mix-recent', 'task-files-reconcile-tick',
        'task-maintenance-daily'
      ) and d.start_time >= pg_catalog.now() - interval '14 days'
      on conflict (job_name, run_id, organization_id) do update
        set status = excluded.status, finished_at = excluded.finished_at,
            failure_code = excluded.failure_code,
            redacted_summary = excluded.redacted_summary;
      get diagnostics changed_count = row_count;
      return changed_count;
    end;
    $function$
  $ddl$;
  revoke all on function private.sync_organization_job_runs_from_cron_history()
    from public, anon, authenticated, service_role;
end;
$jobs$;

notify pgrst, 'reload schema';
