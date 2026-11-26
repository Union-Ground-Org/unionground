-- SEC-UG-QA-REFUSALS-REVEAL-ANOTHER-CHAPTERS-QUESTION-20261115 .
--
-- public.edit_member_qa_question, delete_member_qa_question,
-- edit_member_qa_reply, delete_member_qa_reply, reply_member_qa_official and
-- accept_member_qa_answer read the question (or the reply and then its
-- question) by id and refused "not found" only when it was missing or in
-- another organization. Another chapter's live question or reply in the same
-- organization passed that test and was refused 42501 "not authorized" by the
-- author or officer check, where a missing id was refused P0002 "not found",
-- so a member, steward, coordinator or president of one chapter could tell
-- that another chapter's question or reply exists (found by the
-- non-interference proof,  batch 12). No field of the row was returned.
--
-- Each not-found test now also refuses a question the caller may not see,
-- with private.mi1_qa_can_see, as public.get_member_qa_question,
-- reply_member_qa_follow_up and toggle_member_qa_vote already do. In
-- accept_member_qa_answer that test runs before the version and reply-kind
-- checks, so another chapter's question is refused "not found" for any
-- version and any reply. The two functions that lock
-- the question row (reply_member_qa_official and accept_member_qa_answer)
-- read and refuse it without a lock first, then take the lock and check
-- again, so a caller never waits on another chapter's held row before the
-- refusal, as  does for handoffs. Who may act is unchanged for
-- every question the caller can see: its author, and its chapter's officers.
-- A question's author who can no longer see its chapter is now refused "not
-- found", as get_member_qa_question already refuses them a read. Nothing
-- else in the six bodies changes. Each body below is the installed body
-- (pg_get_functiondef), which a later migration rewrote in place behind the
-- case-graph gate (perform private.lock_case_graph first), so the gate stays
-- first; the predecessor bodies are guarded below. Signatures, owners and
-- grants are unchanged (create or replace).

begin;

-- Each re-emitted function must still be the reviewed live body.
do $predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.edit_member_qa_question(uuid, text, text)'))) is distinct from '6a7317c44db3477603807535775910eb' then
    raise exception 'unreviewed predecessor: public.edit_member_qa_question' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.delete_member_qa_question(uuid)'))) is distinct from 'ea6560cc6a22e3e7dc38d7eebe36ede7' then
    raise exception 'unreviewed predecessor: public.delete_member_qa_question' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.edit_member_qa_reply(uuid, text)'))) is distinct from 'b0a92c576ba9676e354a2f32f3bd09fe' then
    raise exception 'unreviewed predecessor: public.edit_member_qa_reply' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.delete_member_qa_reply(uuid)'))) is distinct from '7a1b4f98638d2eb895599a6f47b6ffde' then
    raise exception 'unreviewed predecessor: public.delete_member_qa_reply' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.reply_member_qa_official(uuid, text, uuid)'))) is distinct from 'd49e013c3745ed235335a6fdaad92d69' then
    raise exception 'unreviewed predecessor: public.reply_member_qa_official' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.accept_member_qa_answer(uuid, uuid, boolean, timestamp with time zone)'))) is distinct from 'cdf35caf641d34a8adee67cfb8f1a1be' then
    raise exception 'unreviewed predecessor: public.accept_member_qa_answer' using errcode = '55000';
  end if;
end;
$predecessors$;

CREATE OR REPLACE FUNCTION public.edit_member_qa_question(p_question_id uuid, p_title text, p_body text)
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
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into question from public.member_qa_questions where id = p_question_id and deleted_at is null;
  if not found or question.organization_id is distinct from org
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if question.author_user_id is distinct from (select auth.uid())
     and not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.member_qa_questions
  set title = pg_catalog.btrim(p_title), body = pg_catalog.btrim(p_body), updated_at = pg_catalog.now()
  where id = question.id;
  perform private.mi1_write_tenant_audit(org, 'qa_edited', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id, 'questionId', question.id, 'kind', 'question'
  ));
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_member_qa_question(p_question_id uuid)
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
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into question from public.member_qa_questions where id = p_question_id and deleted_at is null;
  if not found or question.organization_id is distinct from org
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if question.author_user_id is distinct from (select auth.uid())
     and not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.member_qa_questions set deleted_at = pg_catalog.now(), updated_at = pg_catalog.now() where id = question.id;
  perform private.mi1_write_tenant_audit(org, 'qa_deleted', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id, 'questionId', question.id, 'kind', 'question'
  ));
  return pg_catalog.jsonb_build_object('deleted', true, 'id', question.id);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.edit_member_qa_reply(p_reply_id uuid, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_require_selected_organization();
  reply public.member_qa_replies%rowtype;
  question public.member_qa_questions%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into reply from public.member_qa_replies where id = p_reply_id and deleted_at is null;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select * into question from public.member_qa_questions where id = reply.question_id;
  if question.organization_id is distinct from org
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if reply.author_user_id is distinct from (select auth.uid())
     and not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.member_qa_replies
  set body = pg_catalog.btrim(p_body), updated_at = pg_catalog.now()
  where id = reply.id;
  perform private.mi1_write_tenant_audit(org, 'qa_edited', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id,
    'questionId', question.id, 'replyId', reply.id, 'kind', 'reply'
  ));
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_member_qa_reply(p_reply_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_require_selected_organization();
  reply public.member_qa_replies%rowtype;
  question public.member_qa_questions%rowtype;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  select * into reply from public.member_qa_replies where id = p_reply_id and deleted_at is null;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into question from public.member_qa_questions where id = reply.question_id;
  if question.organization_id is distinct from org
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if reply.author_user_id is distinct from (select auth.uid())
     and not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.member_qa_replies
  set deleted_at = pg_catalog.now(), accepted = false
  where id = reply.id;
  update public.member_qa_questions
  set accepted_reply_id = case when accepted_reply_id is not distinct from reply.id then null else accepted_reply_id end,
      status = case
        when accepted_reply_id is distinct from reply.id and status = 'accepted' then 'accepted'
        when exists (
          select 1 from public.member_qa_replies r
          where r.question_id = question.id and r.deleted_at is null and r.kind = 'official'
        ) then 'replied' else 'open' end,
      updated_at = pg_catalog.now()
  where id = question.id;
  perform private.mi1_write_tenant_audit(org, 'qa_deleted', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id,
    'questionId', question.id, 'replyId', reply.id, 'kind', 'reply'
  ));
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reply_member_qa_official(p_question_id uuid, p_body text, p_idempotency_key uuid)
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
  existing uuid;
  created uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  -- Refuse a missing or invisible question before taking its row lock, so
  -- another chapter's held row cannot be told apart by a wait.
  select * into question from public.member_qa_questions
  where id = p_question_id and deleted_at is null;
  if not found or question.organization_id is distinct from org
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select * into question from public.member_qa_questions
  where id = p_question_id and deleted_at is null for update;
  if not found or question.organization_id is distinct from org
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
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
end;
$function$;

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
  -- Refuse a missing or invisible question before taking its row lock, so
  -- another chapter's held row cannot be told apart by a wait.
  select * into question from public.member_qa_questions
  where id = p_question_id and deleted_at is null;
  if question.id is null or question.organization_id is distinct from org
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select * into question from public.member_qa_questions
  where id = p_question_id and deleted_at is null for update;
  select * into reply from public.member_qa_replies where id = p_reply_id and deleted_at is null;
  if question.id is null or reply.id is null or question.organization_id is distinct from org
     or reply.organization_id is distinct from org or reply.question_id is distinct from question.id
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
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

commit;
