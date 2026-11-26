-- Exact-head review repairs: keep the cron job-health projection inside its
-- table contract and keep accepted-answer follow-ups inside the audit metadata
-- allowlist. This migration is append-only because both definitions shipped in
-- earlier MI1 migrations and must remain replayable as historical records.

alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in (
    'integration-webhooks-dispatch-tick',
    'notifications-dispatch-tick',
    'notifications-expiry-sweep',
    'deadline-notices-tick',
    'ballot-notices-tick',
    'event-notices-tick',
    'appointment-reminders-tick',
    'member-messaging-dispatch',
    'workload-reminders-tick',
    'ballot-choices-mix',
    'ballot-choices-mix-recent',
    'task-files-reconcile-tick',
    'task-maintenance-daily'
  ));

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
      'status', 'open', 'reasonCode', 'member_follow_up'
    ));
  end if;
  perform private.mi1_write_tenant_audit(org, 'qa_follow_up_replied', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id,
    'questionId', question.id, 'replyId', created, 'kind', 'follow_up'
  ));
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
$function$;

revoke all on function public.reply_member_qa_follow_up(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.reply_member_qa_follow_up(uuid, text, uuid) to authenticated;

notify pgrst, 'reload schema';
