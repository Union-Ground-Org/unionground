-- Finish CR-018 delivery after the shared persistence layer landed.
-- Keep author identifiers private while giving clients the ownership bit they
-- need to expose acceptance and moderation controls correctly.

create or replace function private.mi1_qa_project_question(p_question_id uuid, p_actor uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', q.id,
    'organizationId', q.organization_id,
    'chapterId', q.chapter_id,
    'title', q.title,
    'body', q.body,
    'status', q.status,
    'authoredByMe', q.author_user_id = p_actor,
    'acceptedReplyId', q.accepted_reply_id,
    'upvoteCount', q.upvote_count,
    'votedByMe', exists (
      select 1 from public.member_qa_votes v
      where v.question_id = q.id and v.user_id = p_actor
    ),
    'authorDisplayName', private.mi1_qa_display_name(q.author_user_id),
    'createdAt', q.created_at,
    'updatedAt', q.updated_at,
    'deletedAt', q.deleted_at,
    'replyCount', (
      select pg_catalog.count(*) from public.member_qa_replies r
      where r.question_id = q.id and r.deleted_at is null
    ),
    'officialReplyCount', (
      select pg_catalog.count(*) from public.member_qa_replies r
      where r.question_id = q.id and r.deleted_at is null and r.kind = 'official'
    ),
    'replies', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id,
        'questionId', r.question_id,
        'kind', r.kind,
        'body', r.body,
        'authoredByMe', r.author_user_id = p_actor,
        'accepted', r.accepted,
        'upvoteCount', r.upvote_count,
        'votedByMe', exists (
          select 1 from public.member_qa_votes v
          where v.reply_id = r.id and v.user_id = p_actor
        ),
        'authorDisplayName', private.mi1_qa_display_name(r.author_user_id),
        'createdAt', r.created_at,
        'updatedAt', r.updated_at,
        'deletedAt', r.deleted_at
      ) order by r.created_at, r.id)
      from (
        select limited.*
        from public.member_qa_replies limited
        where limited.question_id = q.id
          and limited.deleted_at is null
        order by limited.created_at, limited.id
        limit 100
      ) r
    ), '[]'::jsonb)
  )
  from public.member_qa_questions q
  where q.id = p_question_id
$function$;

revoke all on function private.mi1_qa_project_question(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.accept_member_qa_answer(p_question_id uuid, p_reply_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  question public.member_qa_questions%rowtype;
  reply public.member_qa_replies%rowtype;
  next_status text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into question from public.member_qa_questions where id = p_question_id and deleted_at is null;
  select * into reply from public.member_qa_replies where id = p_reply_id and deleted_at is null;
  if question.id is null
     or reply.id is null
     or question.organization_id is distinct from org
     or reply.organization_id is distinct from org
     or reply.question_id is distinct from question.id then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if reply.kind is distinct from 'official' then
    raise exception 'only official replies can be accepted' using errcode = '22023';
  end if;
  if question.author_user_id is distinct from (select auth.uid())
     and not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if question.accepted_reply_id is not distinct from reply.id then
    update public.member_qa_replies
    set accepted = false, updated_at = pg_catalog.now()
    where question_id = question.id and accepted;
    next_status := case when exists (
      select 1 from public.member_qa_replies r
      where r.question_id = question.id and r.deleted_at is null
    ) then 'replied' else 'open' end;
    update public.member_qa_questions
    set accepted_reply_id = null, status = next_status, updated_at = pg_catalog.now()
    where id = question.id;
    perform private.mi1_write_tenant_audit(org, 'qa_answer_unaccepted', pg_catalog.jsonb_build_object(
      'organizationId', org, 'chapterId', question.chapter_id,
      'questionId', question.id, 'replyId', reply.id, 'status', next_status
    ));
  else
    update public.member_qa_replies
    set accepted = (id = reply.id), updated_at = pg_catalog.now()
    where question_id = question.id;
    update public.member_qa_questions
    set accepted_reply_id = reply.id, status = 'accepted', updated_at = pg_catalog.now()
    where id = question.id;
    perform private.mi1_write_tenant_audit(org, 'qa_answer_accepted', pg_catalog.jsonb_build_object(
      'organizationId', org, 'chapterId', question.chapter_id,
      'questionId', question.id, 'replyId', reply.id, 'status', 'accepted'
    ));
  end if;

  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
$function$;

revoke all on function public.accept_member_qa_answer(uuid, uuid) from public, anon;
grant execute on function public.accept_member_qa_answer(uuid, uuid) to authenticated;
