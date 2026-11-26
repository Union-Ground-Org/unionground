-- Append-only repair for MI1 function changes that were previously proposed by
-- editing migrations already applied on Main. Existing and fresh databases must
-- receive the same definitions through this new migration.

set local lock_timeout = '5s';

create index if not exists organization_audit_events_org_created_idx
  on public.organization_audit_events (organization_id, created_at desc, id desc);

create or replace function public.get_my_chapter_memberships()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'chapterId', c.id,
      'name', c.name,
      'region', c.region,
      'selected', c.id = p.chapter_id,
      'pinned', m.pinned,
      'lastSelectedAt', m.last_selected_at,
      'joinedAt', m.joined_at,
      'organizationId', c.organization_id,
      'roles', coalesce((
        select pg_catalog.jsonb_agg(scoped_role.role order by scoped_role.role)
        from (
          select rc.role
          from public.member_role_chapters rc
          where rc.user_id = m.user_id and rc.chapter_id = m.chapter_id
          union
          select g.role
          from public.organization_role_grants g
          where g.user_id = m.user_id
            and c.organization_id is not null
            and g.organization_id = c.organization_id
          union
          select r.role
          from public.member_roles r
          where r.user_id = m.user_id
            and r.chapter_id is null
            and c.organization_id is null
        ) scoped_role
      ), '[]'::jsonb),
      'organizationRoles', coalesce((
        select pg_catalog.jsonb_agg(g.role order by g.role)
        from public.organization_role_grants g
        where g.user_id = m.user_id
          and c.organization_id is not null
          and g.organization_id = c.organization_id
      ), '[]'::jsonb),
      'chapterRoles', coalesce((
        select pg_catalog.jsonb_agg(rc.role order by rc.role)
        from public.member_role_chapters rc
        where rc.user_id = m.user_id and rc.chapter_id = m.chapter_id
      ), '[]'::jsonb)
    ) order by m.pinned desc, m.last_selected_at desc nulls last, c.name
  ), '[]'::jsonb)
  from public.member_profiles p
  join public.member_chapter_memberships m
    on m.user_id = p.id and m.status = 'active'
  join public.chapters c on c.id = m.chapter_id
  where p.id = (select auth.uid())
    and private.mfa_satisfied()
    and (
      (
        c.organization_id is not null
        and exists (
          select 1
          from public.organization_memberships om
          join public.organizations o
            on o.id = om.organization_id
           and o.status = 'active'
          where om.user_id = p.id
            and om.organization_id = c.organization_id
            and om.status = 'active'
        )
        and (
          private.current_member_organization() is null
          or c.organization_id = private.current_member_organization()
        )
      )
      or (
        c.organization_id is null
        and private.current_member_organization() is null
        and not exists (
          select 1
          from public.organization_memberships om
          join public.organizations o
            on o.id = om.organization_id
           and o.status = 'active'
          where om.user_id = p.id
            and om.status = 'active'
        )
      )
    );
$function$;

create or replace function public.list_member_qa_questions(p_query text, p_status text, p_sort text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  chapter text := private.current_member_chapter();
  wanted_status text := nullif(p_status, '');
  wanted_sort text := coalesce(nullif(p_sort, ''), 'newest');
  needle text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if wanted_status is not null and wanted_status not in ('open', 'replied', 'accepted') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if wanted_sort not in ('newest', 'votes', 'unanswered') then
    raise exception 'invalid sort' using errcode = '22023';
  end if;
  if needle is not null and pg_catalog.char_length(needle) > 120 then
    raise exception 'search is too long' using errcode = '22023';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(private.mi1_qa_project_question(q.id, (select auth.uid())) order by
      case when wanted_sort = 'votes' then q.upvote_count else 0 end desc,
      case when wanted_sort = 'unanswered' and q.status = 'open' then 0 else 1 end,
      q.created_at desc, q.id desc)
    from (
      select candidate.id, candidate.upvote_count, candidate.status, candidate.created_at
      from public.member_qa_questions candidate
      where candidate.organization_id = org
        and candidate.deleted_at is null
        and candidate.chapter_id = chapter
        and (wanted_status is null or candidate.status = wanted_status)
        and (
          needle is null
          or pg_catalog.strpos(pg_catalog.lower(candidate.title), pg_catalog.lower(needle)) > 0
          or pg_catalog.strpos(pg_catalog.lower(candidate.body), pg_catalog.lower(needle)) > 0
          or exists (
            select 1 from public.member_qa_replies r
            where r.question_id = candidate.id
              and r.deleted_at is null
              and pg_catalog.strpos(pg_catalog.lower(r.body), pg_catalog.lower(needle)) > 0
          )
        )
      order by
        case when wanted_sort = 'votes' then candidate.upvote_count else 0 end desc,
        case when wanted_sort = 'unanswered' and candidate.status = 'open' then 0 else 1 end,
        candidate.created_at desc, candidate.id desc
      limit 50
    ) q
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.search_member_qa_history(p_query text, p_status text, p_sort text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return public.list_member_qa_questions(p_query, p_status, p_sort);
end;
$function$;

drop function if exists public.list_member_qa_officer_queue();

create function public.list_member_qa_officer_queue(
  p_limit integer default 50,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
     and not private.member_has_chapter_role(
       private.current_member_chapter(),
       array['steward', 'coordinator', 'advisor', 'admin', 'vp']
     ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if (p_after_created_at is null) <> (p_after_id is null) then
    raise exception 'both officer queue cursor fields are required' using errcode = '22023';
  end if;

  return (
    with limited as (
      select candidate.id, candidate.created_at
      from public.member_qa_questions candidate
      where candidate.organization_id = org
        and candidate.deleted_at is null
        and candidate.status = 'open'
        and private.mi1_qa_is_officer(candidate.organization_id, candidate.chapter_id)
        and (
          p_after_created_at is null
          or candidate.created_at > p_after_created_at
          or (candidate.created_at = p_after_created_at and p_after_id is not null and candidate.id > p_after_id)
        )
      order by candidate.created_at, candidate.id
      limit clamped + 1
    ), page as (
      select limited.id, limited.created_at
      from limited
      order by limited.created_at, limited.id
      limit clamped
    )
    select pg_catalog.jsonb_build_object(
      'questions', coalesce((
        select pg_catalog.jsonb_agg(private.mi1_qa_project_question(page.id, (select auth.uid())) order by page.created_at, page.id)
        from page
      ), '[]'::jsonb),
      'nextAfterCreatedAt', case when (select pg_catalog.count(*) from limited) > clamped
        then (select page.created_at from page order by page.created_at desc, page.id desc limit 1)
        else null end,
      'nextAfterId', case when (select pg_catalog.count(*) from limited) > clamped
        then (select page.id from page order by page.created_at desc, page.id desc limit 1)
        else null end
    )
  );
end;
$function$;

create or replace function public.list_organization_audit_ledger(
  p_limit integer,
  p_before timestamptz,
  p_before_id uuid,
  p_domain text,
  p_action text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(item order by occurred_at desc, id desc)
    from (
      select normalized.id, normalized.occurred_at, normalized.item
      from (
        select
          l.id,
          l.occurred_at,
          l.domain,
          l.action,
          pg_catalog.jsonb_build_object(
            'id', l.id,
            'organizationId', l.organization_id,
            'domain', l.domain,
            'eventType', l.event_type,
            'action', l.action,
            'actorUserId', l.actor_user_id,
            'entityType', l.entity_type,
            'entityId', l.entity_id,
            'occurredAt', l.occurred_at,
            'source', l.source,
            'metadata', l.metadata
          ) as item
        from public.organization_audit_ledger l
        where l.organization_id = org
        union all
        select
          e.id,
          e.created_at,
          classified.domain,
          classified.action,
          pg_catalog.jsonb_build_object(
            'id', e.id,
            'organizationId', e.organization_id,
            'domain', classified.domain,
            'eventType', e.event_type,
            'action', classified.action,
            'actorUserId', e.actor_user_id,
            'entityType', 'organization',
            'occurredAt', e.created_at,
            'source', 'organization_audit_events',
            'metadata', e.metadata
          )
        from public.organization_audit_events e
        cross join lateral (values (
          case
            when e.event_type like 'qa_%' then 'knowledge'
            when e.event_type = 'analytics_snapshot_read' then 'data_access'
            when e.event_type = 'analytics_export_requested' then 'exports'
            when e.event_type like 'integration_%' or e.event_type like 'organization_job_%' then 'operations'
            when e.event_type = 'staff_mfa_policy_changed' then 'security'
            when e.event_type like 'organization_membership_%' or e.event_type like 'organization_role_%' then 'membership'
            else 'administration'
          end,
          case
            when e.event_type in ('first_organization_bootstrap', 'qa_question_asked', 'qa_official_replied', 'qa_follow_up_replied') then 'create'
            when e.event_type in ('organization_membership_granted', 'organization_role_granted') then 'grant'
            when e.event_type in ('organization_membership_revoked', 'organization_role_revoked') then 'revoke'
            when e.event_type = 'qa_deleted' then 'delete'
            when e.event_type = 'analytics_snapshot_read' then 'read'
            when e.event_type = 'analytics_export_requested' then 'export'
            when e.event_type = 'organization_job_acknowledged' then 'acknowledge'
            when e.event_type = 'organization_job_retry_requested' then 'retry_requested'
            when e.event_type like 'integration_%' or e.event_type = 'staff_mfa_policy_changed' then 'settings_change'
            else 'update'
          end
        )) as classified(domain, action)
        where e.organization_id = org
        union all
        select
          a.id,
          a.created_at,
          classified.domain,
          classified.action,
          pg_catalog.jsonb_build_object(
            'id', a.id,
            'organizationId', a.organization_id,
            'domain', classified.domain,
            'eventType', case a.action
              when 'grant_role' then 'role.granted'
              when 'revoke_role' then 'role.revoked'
              when 'create_event' then 'event.created'
              when 'update_event' then 'event.updated'
              when 'cancel_event' then 'event.cancelled'
              when 'restore_event' then 'event.restored'
              when 'delete_event' then 'event.deleted'
              when 'reset_mfa' then 'mfa.reset'
              when 'claim_reward' then 'reward.claimed'
              when 'grant_reward' then 'reward.granted'
              when 'revoke_reward' then 'reward.revoked'
              when 'fulfill_reward' then 'reward.fulfilled'
              when 'set_staff_mfa_policy' then 'mfa.policy_changed'
              when 'create_campaign' then 'campaign.created'
              when 'update_campaign_draft' then 'campaign.updated'
              when 'publish_campaign' then 'campaign.published'
              when 'close_campaign' then 'campaign.closed'
              when 'recover_signin_address' then 'signin.recovered'
              when 'recover_signin_address_failed' then 'signin.recovery_failed'
              when 'review_email_intake' then 'email.intake_reviewed'
              when 'create_chapter' then 'chapter.created'
              when 'update_chapter' then 'chapter.updated'
              when 'grant_chapter_membership' then 'membership.granted'
              when 'revoke_chapter_membership' then 'membership.revoked'
              else 'settings.changed'
            end,
            'action', classified.action,
            'actorUserId', a.actor,
            'entityType', case
              when a.action in ('grant_role', 'revoke_role') then 'role_grant'
              when a.action in ('create_event', 'update_event', 'cancel_event', 'restore_event', 'delete_event') then 'event'
              when a.action ~ 'reward' then 'reward'
              when a.action in ('grant_chapter_membership', 'revoke_chapter_membership') then 'membership'
              when a.action in ('create_chapter', 'update_chapter') then 'chapter'
              when a.action ~ '(mfa|signin|sign_in|compass_ai_provider)' then 'security_policy'
              when a.action ~ 'campaign' then 'campaign'
              else 'organization'
            end,
            'entityId', coalesce(a.target_user::text, a.detail->>'eventId', a.detail->>'chapterId', a.organization_id::text),
            'occurredAt', a.created_at,
            'source', 'member_admin_audit',
            'metadata', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
              'organizationId', a.organization_id,
              'chapterId', a.detail->>'chapterId',
              'role', a.detail->>'role',
              'userId', a.target_user,
              'status', a.detail->>'status'
            ))
          )
        from public.member_admin_audit a
        cross join lateral (values (
          case
            when a.action ~ '(event|checkin)' then 'community_events'
            when a.action ~ '(case|form|filing|cosign)' then 'casework'
            when a.action ~ '(message|broadcast|campaign|notification|email)' then 'communications'
            when a.action ~ '(document|record|task_template)' then 'knowledge'
            when a.action ~ '(reward|point|tier)' then 'rewards'
            when a.action ~ '(export)' then 'exports'
            when a.action ~ '(analytics)' then 'data_access'
            when a.action ~ '(mfa|signin|sign_in|signout|account_deletion|security|compass_ai_provider)' then 'security'
            when a.action ~ '(member|role|invitation|chapter_membership)' then 'membership'
            else 'administration'
          end,
          case
            when a.action ~ 'grant' then 'grant'
            when a.action ~ 'revoke' then 'revoke'
            when a.action ~ '(delete|remove|deactivate|cancel|close)' then 'delete'
            when a.action ~ '(create|add|invite)' then 'create'
            when a.action ~ '(send|publish)' then 'send'
            when a.action ~ 'export' then 'export'
            when a.action ~ '(login|signin|sign_in)' then 'login'
            when a.action ~ '(read|list|search|view)' then 'read'
            when a.action ~ 'acknowledge' then 'acknowledge'
            when a.action ~ 'retry' then 'retry_requested'
            else 'settings_change'
          end
        )) as classified(domain, action)
        where a.organization_id = org
      ) normalized
      where (p_domain is null or normalized.domain = p_domain)
        and (p_action is null or normalized.action = p_action)
        and (
          p_before is null
          or (normalized.occurred_at, normalized.id) < (
            p_before,
            coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
          )
        )
      order by normalized.occurred_at desc, normalized.id desc
      limit clamped
    ) projected
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.get_my_chapter_memberships()
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_chapter_memberships() to authenticated;

revoke all on function public.search_member_qa_history(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.search_member_qa_history(text, text, text) to authenticated;

revoke all on function public.list_member_qa_questions(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_member_qa_questions(text, text, text) to authenticated;

revoke all on function public.list_member_qa_officer_queue(integer, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_member_qa_officer_queue(integer, timestamptz, uuid) to authenticated;

revoke all on function public.list_organization_audit_ledger(integer, timestamptz, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_audit_ledger(integer, timestamptz, uuid, text, text)
  to authenticated;

-- A case's tenant is immutable on member_cases. A member's current chapter can
-- change later and must never re-home historical casework.
create or replace function private.mi1_w2_case_organization(p_case_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select mc.organization_id
  from public.member_cases mc
  where mc.id = p_case_id
    and mc.organization_id is not null
$function$;

revoke all on function private.mi1_w2_case_organization(uuid)
  from public, anon, authenticated, service_role;

-- A member follow-up is not an officer answer. Keep unanswered questions in
-- the officer queue, and only consider official answers when unaccepting one.
create or replace function public.reply_member_qa_follow_up(p_question_id uuid, p_body text, p_idempotency_key uuid)
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
  select * into question from public.member_qa_questions where id = p_question_id and deleted_at is null;
  if not found
     or question.organization_id is distinct from org
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  -- A follow-up reopens an accepted question, so only the person who asked it
  -- may perform this transition. Officers answer through the official route.
  if question.author_user_id is distinct from (select auth.uid()) then
    raise exception 'only the question author can add a follow-up' using errcode = '42501';
  end if;
  if p_idempotency_key is not null then
    select id into existing
    from public.member_qa_replies
    where organization_id = org and idempotency_key = p_idempotency_key;
    if existing is not null then
      return private.mi1_qa_project_question(question.id, (select auth.uid()));
    end if;
  end if;
  insert into public.member_qa_replies (
    organization_id, question_id, author_user_id, kind, body, idempotency_key
  ) values (
    org, question.id, (select auth.uid()), 'follow_up', pg_catalog.btrim(p_body), p_idempotency_key
  ) returning id into created;
  update public.member_qa_questions
  set status = 'open', accepted_reply_id = null, updated_at = pg_catalog.now()
  where id = question.id;
  update public.member_qa_replies
  set accepted = false, updated_at = pg_catalog.now()
  where question_id = question.id and accepted;
  perform private.mi1_write_tenant_audit(org, 'qa_follow_up_replied', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id,
    'questionId', question.id, 'replyId', created, 'kind', 'follow_up'
  ));
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
$function$;

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
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  select * into question from public.member_qa_questions where id = p_question_id and deleted_at is null;
  select * into reply from public.member_qa_replies where id = p_reply_id and deleted_at is null;
  if question.id is null or reply.id is null
     or question.organization_id is distinct from org or reply.organization_id is distinct from org
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
    update public.member_qa_replies set accepted = false, updated_at = pg_catalog.now()
    where question_id = question.id and accepted;
    next_status := case when exists (
      select 1 from public.member_qa_replies r
      where r.question_id = question.id and r.deleted_at is null and r.kind = 'official'
    ) then 'replied' else 'open' end;
    update public.member_qa_questions
    set accepted_reply_id = null, status = next_status, updated_at = pg_catalog.now()
    where id = question.id;
    perform private.mi1_write_tenant_audit(org, 'qa_answer_unaccepted', pg_catalog.jsonb_build_object(
      'organizationId', org, 'chapterId', question.chapter_id,
      'questionId', question.id, 'replyId', reply.id, 'status', next_status
    ));
  else
    update public.member_qa_replies set accepted = (id = reply.id), updated_at = pg_catalog.now()
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

revoke all on function public.reply_member_qa_follow_up(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.reply_member_qa_follow_up(uuid, text, uuid) to authenticated;
revoke all on function public.accept_member_qa_answer(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.accept_member_qa_answer(uuid, uuid) to authenticated;

-- Bound both persisted survey JSON and checklist mutation work.
alter table public.organization_survey_questions
  add constraint organization_survey_questions_options_bounded
  check (pg_catalog.pg_column_size(options) <= 65536) not valid;
alter table public.organization_survey_questions
  validate constraint organization_survey_questions_options_bounded;
alter table public.organization_survey_questions
  add constraint organization_survey_questions_text_fields_bounded
  check (
    (section_key is null or pg_catalog.char_length(section_key) <= 200)
    and (section_title is null or pg_catalog.char_length(section_title) <= 200)
    and (branch_value is null or pg_catalog.char_length(branch_value) <= 200)
    and (scale_min_label is null or pg_catalog.char_length(scale_min_label) <= 200)
    and (scale_max_label is null or pg_catalog.char_length(scale_max_label) <= 200)
  ) not valid;
alter table public.organization_survey_questions
  validate constraint organization_survey_questions_text_fields_bounded;
alter table public.organization_survey_answers
  add constraint organization_survey_answers_value_bounded
  check (pg_catalog.pg_column_size(value) <= 65536) not valid;
alter table public.organization_survey_answers
  validate constraint organization_survey_answers_value_bounded;

create or replace function public.patch_case_checklist(p_case_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  found_case public.member_cases%rowtype;
  item jsonb;
  next_item_id text;
  existing_count integer;
  custom_count integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['coordinator', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  found_case := private.mi1_w2_require_visible_case(org, p_case_id);
  if pg_catalog.jsonb_typeof(coalesce(p_patch, '[]'::jsonb)) <> 'array' then
    raise exception 'checklist patch must be an array' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(coalesce(p_patch, '[]'::jsonb)) > 100 then
    raise exception 'checklist patch cap exceeded' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('case-checklist:' || found_case.id::text, 509)
  );
  select pg_catalog.count(*), pg_catalog.count(*) filter (where progress.item_id like 'custom:%')
    into existing_count, custom_count
  from public.case_checklist_progress progress
  where progress.organization_id = org and progress.case_id = found_case.id;
  for item in select value from pg_catalog.jsonb_array_elements(p_patch)
  loop
    next_item_id := pg_catalog.btrim(coalesce(item ->> 'itemId', item ->> 'id', ''));
    if pg_catalog.char_length(next_item_id) not between 1 and 180
       or next_item_id ~ '[[:cntrl:]]' then
      raise exception 'checklist item id invalid' using errcode = '22023';
    end if;
    if pg_catalog.char_length(coalesce(item ->> 'label', '')) > 160 then
      raise exception 'checklist item label too long' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.case_checklist_progress progress
      where progress.organization_id = org and progress.case_id = found_case.id
        and progress.item_id = next_item_id
    ) then
      if existing_count >= 200 then raise exception 'checklist item cap exceeded' using errcode = '22023'; end if;
      existing_count := existing_count + 1;
      if next_item_id like 'custom:%' then
        if custom_count >= 20 then raise exception 'custom checklist cap exceeded' using errcode = '22023'; end if;
        custom_count := custom_count + 1;
      end if;
    end if;
    insert into public.case_checklist_progress (organization_id, case_id, item_id, status, label, updated_by)
    values (org, found_case.id, next_item_id, coalesce(nullif(item ->> 'status', ''), 'current'),
      nullif(item ->> 'label', ''), (select auth.uid()))
    on conflict (organization_id, case_id, item_id) do update
      set status = excluded.status,
          label = coalesce(excluded.label, public.case_checklist_progress.label),
          updated_by = excluded.updated_by, updated_at = pg_catalog.now();
  end loop;
  perform private.mi1_w2_write_audit(org, 'case_checklist_patched', pg_catalog.jsonb_build_object(
    'organizationId', org, 'caseId', found_case.id
  ));
  return pg_catalog.jsonb_build_object('caseId', found_case.id, 'ok', true);
end;
$function$;

revoke all on function public.patch_case_checklist(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.patch_case_checklist(uuid, jsonb) to authenticated;

-- Terminalize abandoned final attempts before either claim path searches for
-- new work. Otherwise a worker crash on attempt five leaves a permanent
-- `sending` row that is no longer eligible for a claim.
create or replace function private.mi1_reap_expired_webhook_final_attempts()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.integration_jobs j
  set status = 'failed', error_code = 'lease_expired_after_max_attempts', updated_at = pg_catalog.now()
  where exists (
    select 1 from public.integration_webhook_deliveries d
    where d.organization_id = j.organization_id
      and j.idempotency_key = 'delivery:' || d.id::text
      and d.status = 'sending' and d.attempt_count >= 5
      and coalesce(d.lease_expires_at, '-infinity'::timestamptz) < pg_catalog.now()
  );
  update public.integration_webhooks w
  set last_delivery_at = pg_catalog.now(), last_delivery_status = 'dead'
  where exists (
    select 1 from public.integration_webhook_deliveries d
    where d.webhook_id = w.id and d.organization_id = w.organization_id
      and d.status = 'sending' and d.attempt_count >= 5
      and coalesce(d.lease_expires_at, '-infinity'::timestamptz) < pg_catalog.now()
  );
  update public.integration_webhook_deliveries d
  set status = 'dead', error_code = 'lease_expired_after_max_attempts',
      lease_expires_at = null, next_attempt_at = null
  where d.status = 'sending' and d.attempt_count >= 5
    and coalesce(d.lease_expires_at, '-infinity'::timestamptz) < pg_catalog.now();
end;
$function$;

create or replace function public.claim_integration_webhook_deliveries(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare claimed jsonb;
begin
  perform private.mi1_reap_expired_webhook_final_attempts();
  with candidates as (
    select d.id
    from public.integration_webhook_deliveries d
    join public.integration_webhooks w on w.id = d.webhook_id and w.organization_id = d.organization_id
    join vault.decrypted_secrets secret on secret.id = w.secret_ref
    where w.active and w.secret_ref is not null
      and (d.status = 'queued'
        or (d.status = 'failed' and coalesce(d.next_attempt_at, '-infinity'::timestamptz) <= pg_catalog.now())
        or (d.status = 'sending' and coalesce(d.lease_expires_at, '-infinity'::timestamptz) < pg_catalog.now()))
      and d.attempt_count < 5
    order by d.created_at
    for update of d skip locked
    limit least(greatest(coalesce(p_limit, 10), 1), 25)
  ), updated as (
    update public.integration_webhook_deliveries d
    set status = 'sending', attempt_count = d.attempt_count + 1,
        lease_expires_at = pg_catalog.now() + interval '5 minutes', next_attempt_at = null
    from candidates c where d.id = c.id returning d.*
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'deliveryId', d.id, 'attemptCount', d.attempt_count, 'url', w.url,
    'eventName', d.event_name, 'eventId', d.event_id, 'occurredAt', d.created_at,
    'secret', s.decrypted_secret
  ) order by d.created_at), '[]'::jsonb) into claimed
  from updated d
  join public.integration_webhooks w on w.id = d.webhook_id
  join vault.decrypted_secrets s on s.id = w.secret_ref;
  update public.integration_jobs j set status = 'running', updated_at = pg_catalog.now()
  where exists (
    select 1
    from pg_catalog.jsonb_array_elements(claimed) entry
    join public.integration_webhook_deliveries d on d.id = (entry->>'deliveryId')::uuid
    where j.organization_id = d.organization_id
      and j.idempotency_key = 'delivery:' || d.id::text
  );
  return claimed;
end;
$function$;

create or replace function public.claim_integration_webhook_delivery(p_delivery_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare claimed jsonb;
begin
  perform private.mi1_reap_expired_webhook_final_attempts();
  with candidate as (
    select d.id
    from public.integration_webhook_deliveries d
    join public.integration_webhooks w on w.id = d.webhook_id and w.organization_id = d.organization_id
    join vault.decrypted_secrets secret on secret.id = w.secret_ref
    where d.id = p_delivery_id and w.active and w.secret_ref is not null
      and (d.status = 'queued'
        or (d.status = 'failed' and coalesce(d.next_attempt_at, '-infinity'::timestamptz) <= pg_catalog.now())
        or (d.status = 'sending' and coalesce(d.lease_expires_at, '-infinity'::timestamptz) < pg_catalog.now()))
      and d.attempt_count < 5
    for update of d skip locked
  ), updated as (
    update public.integration_webhook_deliveries d
    set status = 'sending', attempt_count = d.attempt_count + 1,
        lease_expires_at = pg_catalog.now() + interval '5 minutes', next_attempt_at = null
    from candidate c where d.id = c.id returning d.*
  )
  select pg_catalog.jsonb_build_object(
    'deliveryId', d.id, 'attemptCount', d.attempt_count, 'url', w.url,
    'eventName', d.event_name, 'eventId', d.event_id, 'occurredAt', d.created_at,
    'secret', s.decrypted_secret
  ) into claimed
  from updated d
  join public.integration_webhooks w on w.id = d.webhook_id
  join vault.decrypted_secrets s on s.id = w.secret_ref;
  if claimed is not null then
    update public.integration_jobs j set status = 'running', updated_at = pg_catalog.now()
    from public.integration_webhook_deliveries d
    where d.id = (claimed->>'deliveryId')::uuid
      and j.organization_id = d.organization_id
      and j.idempotency_key = 'delivery:' || d.id::text;
  end if;
  return claimed;
end;
$function$;

revoke all on function private.mi1_reap_expired_webhook_final_attempts()
  from public, anon, authenticated, service_role;
revoke all on function public.claim_integration_webhook_deliveries(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_integration_webhook_deliveries(integer) to service_role;
revoke all on function public.claim_integration_webhook_delivery(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_integration_webhook_delivery(uuid) to service_role;

-- Treat the browser validator as convenience only. The tenant RPC independently
-- bounds and validates the complete event set and refuses ambiguous URL forms.
create or replace function public.create_integration_webhook(
  p_url text,
  p_events text[],
  p_secret_hash text,
  p_secret_plaintext text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  host text;
  webhook_id uuid := extensions.gen_random_uuid();
  secret_id uuid;
  allowed_events constant text[] := array[
    'member.invited', 'member.profile_updated', 'case.opened', 'case.updated',
    'broadcast.published', 'event.checkin', 'appointment.scheduled'
  ];
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_url is null
     or pg_catalog.char_length(p_url) not between 12 and 500
     or p_url is distinct from pg_catalog.btrim(p_url)
     or p_url !~ '^https://'
     or p_url ~ '[[:space:][:cntrl:]]'
     or p_url ~ '^https://[^/]*@'
     or p_url ~* '^https://\['
     or p_url ~ '#'
     or p_url ~* '^https://(localhost|localhost\.localdomain|metadata|metadata\.google\.(internal|com)|kubernetes\.default\.svc)([:/]|$)'
     or p_url ~* '^https://[^/]+\.(local|internal|localhost|lan|home|corp|invalid)([:/]|$)'
     or p_url ~* '^https://(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[789][0-9]|1[01][0-9]|12[0-7])\.)([0-9.]*)([:/]|$)'
     or p_url ~ '^https://[^/]+\.(:[0-9]+)?(/|$)' then
    raise exception 'invalid webhook url' using errcode = '22023';
  end if;
  if p_secret_plaintext is null or p_secret_plaintext !~ '^whsec_[0-9a-f]{48}$'
     or p_secret_hash <> pg_catalog.encode(
       extensions.digest(pg_catalog.convert_to(p_secret_plaintext, 'UTF8'), 'sha256'), 'hex'
     ) then
    raise exception 'invalid webhook secret' using errcode = '22023';
  end if;
  if p_events is null or pg_catalog.cardinality(p_events) not between 1 and 7
     or not p_events <@ allowed_events
     or pg_catalog.cardinality(p_events) <> pg_catalog.cardinality(array(select distinct unnest(p_events))) then
    raise exception 'invalid webhook events' using errcode = '22023';
  end if;
  host := (pg_catalog.regexp_match(p_url, '^https://([^/]+)'))[1];
  secret_id := vault.create_secret(
    p_secret_plaintext, 'mi1-webhook-' || webhook_id::text, 'Organization webhook signing secret'
  );
  insert into public.integration_webhooks (id, organization_id, url, events, secret_hash, secret_ref)
  values (webhook_id, org, p_url, p_events, p_secret_hash, secret_id);
  insert into public.organization_integrations (organization_id, provider, status)
  values (org, 'customer_webhooks', 'configured')
  on conflict (organization_id, provider) do update
    set status = 'configured', updated_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'integration_webhook_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'host', host, 'events', p_events, 'status', 'created'
  ));
  return public.list_integration_webhooks();
end;
$function$;

revoke all on function public.create_integration_webhook(text, text[], text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_integration_webhook(text, text[], text, text) to authenticated;

create or replace function private.mi1_integration_allowed_chapter_override_keys(p_provider text)
returns text[]
language sql
immutable
security definer
set search_path = ''
as $function$
  select case p_provider
    when 'twilio' then array['fromNumber']::text[]
    when 'google_calendar' then array['calendarId']::text[]
    when 'microsoft_calendar' then array['calendarId']::text[]
    when 'constant_contact' then array['listId']::text[]
    when 'cba_ingest' then array['library']::text[]
    else array[]::text[]
  end
$function$;

create or replace function public.set_integration_chapter_controls(
  p_provider text,
  p_enabled boolean,
  p_allowed_chapter_override_keys text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  catalog_keys text[] := private.mi1_integration_allowed_chapter_override_keys(p_provider);
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  -- Retain the established RPC signature while treating the caller-supplied
  -- allowlist as advisory only; the immutable server catalog is authoritative.
  perform pg_catalog.cardinality(coalesce(p_allowed_chapter_override_keys, '{}'::text[]));
  update public.organization_integrations
  set allow_chapter_overrides = coalesce(p_enabled, false) and pg_catalog.cardinality(catalog_keys) > 0,
      allowed_chapter_override_keys = case
        when coalesce(p_enabled, false) then catalog_keys else '{}'::text[] end,
      updated_at = pg_catalog.now()
  where organization_id = org and provider = p_provider and provider <> 'scim';
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', p_provider,
    'status', case when coalesce(p_enabled, false) and pg_catalog.cardinality(catalog_keys) > 0
      then 'chapter_controls_enabled' else 'chapter_controls_disabled' end
  ));
  return public.list_organization_integrations();
end;
$function$;

revoke all on function private.mi1_integration_allowed_chapter_override_keys(text)
  from public, anon, authenticated, service_role;
revoke all on function public.set_integration_chapter_controls(text, boolean, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.set_integration_chapter_controls(text, boolean, text[]) to authenticated;

-- Idempotency is tenant-scoped. A UUID already used by another organization
-- must behave exactly like an unused key for this caller.
alter table public.member_handoffs
  drop constraint member_handoffs_idempotency_key_key;
alter table public.member_handoffs
  add constraint member_handoffs_org_idempotency_key_key
  unique (organization_id, idempotency_key);

create or replace function public.initiate_member_handoff(
  p_member_user_id uuid,
  p_to_steward_id uuid,
  p_note text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := private.current_member_chapter();
  existing public.member_handoffs%rowtype;
  created uuid;
  current_steward uuid;
  hourly integer;
  daily integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.mi1_w2_handoff_can_initiate(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_member_user_id is null or p_to_steward_id is null or p_idempotency_key is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_member_user_id = p_to_steward_id then
    raise exception 'A member cannot be handed off to themselves.' using errcode = '22023';
  end if;
  if chapter is null or not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = org and m.user_id = p_member_user_id and m.status = 'active'
  ) or not exists (
    select 1 from public.member_chapter_memberships cm
    where cm.user_id = p_member_user_id and cm.chapter_id = chapter and cm.status = 'active'
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1
    from public.organization_memberships m
    join public.organization_role_grants g
      on g.organization_id = m.organization_id and g.user_id = m.user_id
    where m.organization_id = org and m.user_id = p_to_steward_id
      and m.status = 'active' and g.role = 'steward'
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  select pg_catalog.count(*) into hourly from public.member_handoffs h
  where h.organization_id = org and h.initiated_by = (select auth.uid())
    and h.created_at >= pg_catalog.now() - interval '1 hour';
  select pg_catalog.count(*) into daily from public.member_handoffs h
  where h.organization_id = org and h.initiated_by = (select auth.uid())
    and h.created_at >= pg_catalog.now() - interval '1 day';
  if hourly >= 20 or daily >= 80 then
    raise exception 'handoff rate limit exceeded' using errcode = '54000';
  end if;
  select * into existing
  from public.member_handoffs
  where organization_id = org and idempotency_key = p_idempotency_key;
  if found then
    if existing.member_user_id is distinct from p_member_user_id
       or existing.to_steward_id is distinct from p_to_steward_id
       or existing.initiated_by is distinct from (select auth.uid())
       or existing.note is distinct from nullif(pg_catalog.btrim(coalesce(p_note, '')), '') then
      raise exception 'That idempotency key already started a different handoff.' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object('id', existing.id, 'status', existing.status, 'kind', 'reuse');
  end if;
  perform 1 from public.member_handoffs
  where organization_id = org and chapter_id = chapter
    and member_user_id = p_member_user_id and status = 'pending';
  if found then raise exception 'This member already has a pending handoff.' using errcode = 'P0001'; end if;
  select r.steward_user_id into current_steward
  from public.member_steward_relationships r
  where r.organization_id = org and r.chapter_id = chapter and r.member_user_id = p_member_user_id;
  insert into public.member_handoffs (
    organization_id, chapter_id, member_user_id, from_steward_id, to_steward_id,
    initiated_by, note, idempotency_key, status
  ) values (
    org, chapter, p_member_user_id, current_steward, p_to_steward_id,
    (select auth.uid()), nullif(pg_catalog.btrim(coalesce(p_note, '')), ''), p_idempotency_key, 'pending'
  ) returning id into created;
  perform private.mi1_w2_write_audit(org, 'member_handoff_initiated', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', chapter, 'userId', p_member_user_id,
    'status', 'pending', 'handoffId', created,
    'fromStewardId', current_steward, 'toStewardId', p_to_steward_id
  ));
  return pg_catalog.jsonb_build_object('id', created, 'status', 'pending', 'kind', 'initiate');
end;
$function$;

revoke all on function public.initiate_member_handoff(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.initiate_member_handoff(uuid, uuid, text, uuid) to authenticated;

-- Keep every integration write path on the immutable provider catalog. The
-- legacy caller parameter remains in the signature for client compatibility.
create or replace function public.upsert_organization_integration(
  p_provider text,
  p_status text,
  p_account_owner text,
  p_allow_chapter_overrides boolean,
  p_allow_chapter_owned_accounts boolean,
  p_allowed_chapter_override_keys text[],
  p_default_settings jsonb,
  p_credential_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  next_status text := coalesce(nullif(p_status, ''), 'unset');
  catalog_keys text[] := private.mi1_integration_allowed_chapter_override_keys(p_provider);
  chapter_overrides boolean := coalesce(p_allow_chapter_overrides, false)
    and pg_catalog.cardinality(catalog_keys) > 0;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  perform pg_catalog.cardinality(coalesce(p_allowed_chapter_override_keys, '{}'::text[]));
  if p_provider = 'scim' then next_status := 'disabled'; end if;
  if p_provider = 'scim' and p_status in ('connected', 'configured', 'requested') then
    raise exception 'SCIM stays disabled until the enterprise-later gate' using errcode = '42501';
  end if;
  insert into public.organization_integrations (
    organization_id, provider, status, account_owner, allow_chapter_overrides,
    allow_chapter_owned_accounts, allowed_chapter_override_keys, default_settings,
    credential_ref
  ) values (
    org, p_provider, next_status, coalesce(nullif(p_account_owner, ''), 'organization'),
    chapter_overrides, coalesce(p_allow_chapter_owned_accounts, false),
    case when chapter_overrides then catalog_keys else '{}'::text[] end,
    coalesce(p_default_settings, '{}'::jsonb), nullif(p_credential_ref, '')
  )
  on conflict (organization_id, provider) do update
    set status = excluded.status,
        account_owner = excluded.account_owner,
        allow_chapter_overrides = excluded.allow_chapter_overrides,
        allow_chapter_owned_accounts = excluded.allow_chapter_owned_accounts,
        allowed_chapter_override_keys = excluded.allowed_chapter_override_keys,
        default_settings = excluded.default_settings,
        credential_ref = excluded.credential_ref,
        updated_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', p_provider, 'status', next_status
  ));
  return public.list_organization_integrations();
end;
$function$;

revoke all on function public.upsert_organization_integration(text, text, text, boolean, boolean, text[], jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.upsert_organization_integration(text, text, text, boolean, boolean, text[], jsonb, text)
  to authenticated;

-- A question is replied only while at least one non-deleted official answer
-- remains. Member follow-ups do not hide it from the officer queue.
create or replace function public.delete_member_qa_reply(p_reply_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  reply public.member_qa_replies%rowtype;
  question public.member_qa_questions%rowtype;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  select * into reply from public.member_qa_replies where id = p_reply_id and deleted_at is null;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into question from public.member_qa_questions where id = reply.question_id;
  if question.organization_id is distinct from org then raise exception 'not found' using errcode = 'P0002'; end if;
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
$function$;

revoke all on function public.delete_member_qa_reply(uuid) from public, anon, authenticated, service_role;
grant execute on function public.delete_member_qa_reply(uuid) to authenticated;

-- Remediation rows must reference a run visible in the organization health
-- desk. Platform-wide runs may receive a tenant-local acknowledgement without
-- mutating the shared run.
create or replace function private.mi1_require_product_job_run(p_org uuid, p_job_name text, p_run_id text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_job_name is null or p_run_id is null or not exists (
    select 1 from public.organization_job_runs r
    where (r.organization_id = p_org or r.organization_id is null)
      and r.job_name = p_job_name and r.run_id = p_run_id
  ) then
    raise exception 'job run not found' using errcode = 'P0002';
  end if;
end;
$function$;

create or replace function public.acknowledge_organization_job_run(p_job_name text, p_run_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['admin']) then raise exception 'not authorized' using errcode = '42501'; end if;
  perform private.mi1_require_product_job_run(org, p_job_name, p_run_id);
  insert into public.organization_job_acknowledgements (
    organization_id, job_name, run_id, acknowledged_by, remediation
  ) values (org, p_job_name, p_run_id, (select auth.uid()), 'acknowledge')
  on conflict (organization_id, job_name, run_id) do update
    set remediation = 'acknowledge', acknowledged_by = excluded.acknowledged_by,
        created_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'organization_job_acknowledged', pg_catalog.jsonb_build_object(
    'organizationId', org, 'jobName', p_job_name, 'runId', p_run_id, 'remediation', 'acknowledge'
  ));
  return public.list_organization_job_health();
end;
$function$;

create or replace function public.request_organization_job_retry(p_job_name text, p_run_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['admin']) then raise exception 'not authorized' using errcode = '42501'; end if;
  perform private.mi1_require_product_job_run(org, p_job_name, p_run_id);
  insert into public.organization_job_acknowledgements (
    organization_id, job_name, run_id, acknowledged_by, remediation
  ) values (org, p_job_name, p_run_id, (select auth.uid()), 'request_retry')
  on conflict (organization_id, job_name, run_id) do update
    set remediation = 'request_retry', acknowledged_by = excluded.acknowledged_by,
        created_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'organization_job_retry_requested', pg_catalog.jsonb_build_object(
    'organizationId', org, 'jobName', p_job_name, 'runId', p_run_id, 'remediation', 'request_retry'
  ));
  return public.list_organization_job_health();
end;
$function$;

revoke all on function private.mi1_require_product_job_run(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.acknowledge_organization_job_run(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.request_organization_job_retry(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.acknowledge_organization_job_run(text, text) to authenticated;
grant execute on function public.request_organization_job_retry(text, text) to authenticated;

-- Pausing or deleting an endpoint terminalizes its queued work and companion
-- integration jobs instead of leaving permanently-running rows.
create or replace function public.set_integration_webhook_active(p_webhook_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  update public.integration_webhooks set active = coalesce(p_active, false)
  where id = p_webhook_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if not coalesce(p_active, false) then
    update public.integration_jobs j
    set status = 'skipped', error_code = 'webhook_paused', updated_at = pg_catalog.now()
    where j.organization_id = org and j.idempotency_key in (
      select 'delivery:' || d.id::text from public.integration_webhook_deliveries d
      where d.organization_id = org and d.webhook_id = p_webhook_id
        and d.status in ('queued', 'failed', 'sending')
    );
    update public.integration_webhook_deliveries
    set status = 'skipped', error_code = 'webhook_paused', lease_expires_at = null, next_attempt_at = null
    where organization_id = org and webhook_id = p_webhook_id
      and status in ('queued', 'failed', 'sending');
  end if;
  perform private.mi1_write_tenant_audit(org, 'integration_webhook_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'status', case when p_active then 'active' else 'inactive' end
  ));
  return public.list_integration_webhooks();
end;
$function$;

create or replace function public.delete_integration_webhook(p_webhook_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  secret_id uuid;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  delete from public.integration_jobs j
  where j.organization_id = org and j.idempotency_key in (
    select 'delivery:' || d.id::text from public.integration_webhook_deliveries d
    where d.organization_id = org and d.webhook_id = p_webhook_id
  );
  delete from public.integration_webhooks
  where id = p_webhook_id and organization_id = org
  returning secret_ref into secret_id;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if secret_id is not null then delete from vault.secrets where id = secret_id; end if;
  if not exists (select 1 from public.integration_webhooks w where w.organization_id = org) then
    update public.organization_integrations set status = 'unset', updated_at = pg_catalog.now()
    where organization_id = org and provider = 'customer_webhooks';
  end if;
  perform private.mi1_write_tenant_audit(org, 'integration_webhook_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'status', 'deleted'
  ));
  return public.list_integration_webhooks();
end;
$function$;

revoke all on function public.set_integration_webhook_active(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_integration_webhook(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.set_integration_webhook_active(uuid, boolean) to authenticated;
grant execute on function public.delete_integration_webhook(uuid) to authenticated;

-- Public RSVP PII has a fixed 90-day lifetime. Purging is internal and the
-- submission function also opportunistically enforces the cap.
create or replace function private.purge_expired_public_event_rsvps()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare removed integer;
begin
  delete from public.public_event_rsvps
  where created_at < pg_catalog.now() - interval '90 days';
  get diagnostics removed = row_count;
  return removed;
end;
$function$;

revoke all on function private.purge_expired_public_event_rsvps()
  from public, anon, authenticated, service_role;

do $schedule$
begin
  if pg_catalog.to_regnamespace('cron') is not null then
    perform cron.schedule(
      'mi1-public-rsvp-retention',
      '17 4 * * *',
      'select private.purge_expired_public_event_rsvps();'
    );
  end if;
exception when unique_violation then null;
end;
$schedule$;

alter table private.public_event_rsvp_limits
  drop constraint public_event_rsvp_limits_operation_check;
alter table private.public_event_rsvp_limits
  add constraint public_event_rsvp_limits_operation_check
  check (operation in ('network-15m', 'email-event-day', 'event-day'));

create or replace function private.consume_public_event_rsvp_limit(
  p_scope_hash text,
  p_operation text,
  p_limit integer,
  p_window interval
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_row private.public_event_rsvp_limits%rowtype;
  moment timestamptz := clock_timestamp();
begin
  if p_scope_hash is null
     or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_operation not in ('network-15m', 'email-event-day', 'event-day')
     or p_limit < 1
     or p_window <= interval '0 seconds' then
    raise exception 'invalid public event rsvp rate limit' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-event-rsvp-rate:' || p_operation || ':' || p_scope_hash,
      509
    )
  );
  select * into current_row
  from private.public_event_rsvp_limits
  where scope_hash = p_scope_hash and operation = p_operation
  for update;
  if not found then
    insert into private.public_event_rsvp_limits
      (scope_hash, operation, window_started_at, request_count)
    values (p_scope_hash, p_operation, moment, 1);
    return true;
  end if;
  if current_row.window_started_at + p_window <= moment then
    update private.public_event_rsvp_limits
    set window_started_at = moment, request_count = 1
    where scope_hash = p_scope_hash and operation = p_operation;
    return true;
  end if;
  if current_row.request_count >= p_limit then return false; end if;
  update private.public_event_rsvp_limits
  set request_count = request_count + 1
  where scope_hash = p_scope_hash and operation = p_operation;
  return true;
end;
$function$;

revoke all on function private.consume_public_event_rsvp_limit(text, text, integer, interval)
  from public, anon, authenticated, service_role;

create or replace function public.submit_public_event_rsvp(
  p_event_id text,
  p_email text,
  p_name text,
  p_locale text,
  p_source text,
  p_website text,
  p_scope_hash text,
  p_email_scope_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  event_org uuid;
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  normalized_name text := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  event_scope_hash text;
  moment timestamptz := clock_timestamp();
  network_allowed boolean;
  event_allowed boolean := false;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  if pg_catalog.char_length(coalesce(p_event_id, '')) not between 1 and 128
     or pg_catalog.char_length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or (normalized_name is not null and pg_catalog.char_length(normalized_name) > 100)
     or p_source is distinct from 'public-event-rsvp'
     or p_locale is null or p_locale not in ('en', 'es') then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  network_allowed := private.consume_public_event_rsvp_limit(
    p_scope_hash, 'network-15m', 20, interval '15 minutes'
  );
  -- Do not spend the global event budget for requests already rejected by the
  -- narrower network gate.
  if network_allowed then
    select r.organization_id into event_org
    from public.public_site_records r
    where r.id = p_event_id and r.is_published and r.kind = 'meeting'
      and r.organization_id is not null;
  end if;
  if network_allowed and event_org is not null then
    event_scope_hash := pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(event_org::text || ':' || p_event_id, 'UTF8'), 'sha256'), 'hex'
    );
    event_allowed := private.consume_public_event_rsvp_limit(
      event_scope_hash, 'event-day', 500, interval '1 day'
    );
  end if;
  if network_allowed and event_allowed
     and private.consume_public_event_rsvp_limit(
       p_email_scope_hash, 'email-event-day', 3, interval '1 day'
     ) then
    insert into public.public_event_rsvps (organization_id, event_id, email, name, locale)
    values (event_org, p_event_id, normalized_email, normalized_name, p_locale)
    on conflict (event_id, email) do nothing;
  end if;
  delete from private.public_event_rsvp_limits as stale
  where stale.ctid in (
    select candidate.ctid from private.public_event_rsvp_limits as candidate
    where candidate.window_started_at < moment - interval '2 days'
      and candidate.scope_hash <> all(pg_catalog.array_remove(
        array[p_scope_hash, p_email_scope_hash, event_scope_hash]::text[], null
      ))
    order by candidate.window_started_at limit 200 for update skip locked
  );
  return pg_catalog.jsonb_build_object('accepted', true);
end;
$function$;

revoke all on function public.submit_public_event_rsvp(text, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_public_event_rsvp(text, text, text, text, text, text, text, text)
  to service_role;

-- The server and clients share one 25-person cohort floor and one 180-day
-- engagement window. Returning a lower floor would make client-side privacy
-- composition impossible to reason about.
create or replace function public.get_organization_analytics_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  period_end timestamptz := pg_catalog.date_trunc('month', generated);
  period_start timestamptz := pg_catalog.date_trunc('month', generated) - interval '6 months';
  privacy_threshold constant integer := 25;
  result jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  result := pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'label', c.name,
        'memberCount', case when member_totals.value >= privacy_threshold
          then (pg_catalog.floor(member_totals.value / 5.0) * 5)::integer else null end,
        'memberCountSuppressed', member_totals.value < privacy_threshold,
        'stewardCount', case when steward_totals.value >= privacy_threshold
          and member_totals.value - steward_totals.value >= privacy_threshold
          then (pg_catalog.floor(steward_totals.value / 5.0) * 5)::integer else null end,
        'stewardCountSuppressed', steward_totals.value < privacy_threshold
          or member_totals.value - steward_totals.value < privacy_threshold
      ) order by c.name, c.id)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*) as value from public.member_chapter_memberships m
        where m.chapter_id = c.id and m.status = 'active'
      ) member_totals
      cross join lateral (
        select pg_catalog.count(distinct rc.user_id) as value
        from public.member_role_chapters rc
        join public.member_chapter_memberships m
          on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id and m.status = 'active'
        where rc.chapter_id = c.id and rc.role = 'steward'
      ) steward_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'cases', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'chapterId', counted.chapter_id, 'status', counted.status,
        'step', counted.step_bucket, 'workplaceKey', counted.case_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.status, counted.case_type, counted.step_bucket)
      from (
        select cs.chapter_id, cs.status,
          case when cs.step in ('Intake', 'intake') then 0 else 2 end as step_bucket,
          cs.case_type, pg_catalog.count(distinct cs.user_id) as person_count
        from public.member_cases cs
        where cs.organization_id = org and cs.chapter_id is not null
          and cs.created_at >= period_start and cs.created_at < period_end
        group by cs.chapter_id, cs.status, step_bucket, cs.case_type
        having pg_catalog.count(distinct cs.user_id) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    -- organization_page_views contains request totals, not distinct people.
    -- It cannot satisfy a person-cohort floor and is therefore not published.
    'usageViews', '[]'::jsonb,
    'usageWindows', (
      select pg_catalog.jsonb_build_object(
        'organizationId', org,
        -- Nested exact windows permit complement differencing. Publish only a
        -- rounded 30-day distinct-person cohort; retain the shape explicitly.
        'dau', null,
        'wau', null,
        'mau', case when windows.mau >= privacy_threshold
          then (pg_catalog.floor(windows.mau / 5.0) * 5)::integer else null end,
        'suppressed', pg_catalog.jsonb_build_object(
          'dau', true,
          'wau', true,
          'mau', windows.mau < privacy_threshold
        )
      ) from (
        select
          pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '30 days') as mau
        from public.organization_engagement_events where organization_id = org
      ) windows
    ),
    'series', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', c.id,
        'openCases', case when case_totals.value >= privacy_threshold and case_totals.minimum_cell >= privacy_threshold
          then (pg_catalog.floor(case_totals.value / 5.0) * 5)::integer else null end,
        'openCasesSuppressed', case_totals.value < privacy_threshold or case_totals.minimum_cell < privacy_threshold,
        'attendanceRate', null, 'engagementMean', null, 'usageViews', null
      ) order by c.id)
      from public.chapters c
      cross join lateral (
        select totals.value, minima.minimum_cell
        from (
          select pg_catalog.count(distinct cs.user_id) as value
          from public.member_cases cs
          where cs.organization_id = org and cs.chapter_id = c.id and cs.status = 'active'
            and cs.created_at >= period_start and cs.created_at < period_end
        ) totals
        cross join (
          select coalesce(pg_catalog.min(cell.cell_people), 0) as minimum_cell
          from (
            select pg_catalog.count(distinct cs.user_id) as cell_people
            from public.member_cases cs
            where cs.organization_id = org and cs.chapter_id = c.id and cs.status = 'active'
              and cs.created_at >= period_start and cs.created_at < period_end
            group by cs.case_type, case when cs.step in ('Intake', 'intake') then 0 else 2 end
          ) cell
        ) minima
      ) case_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'heatmapPoints', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'kind', 'grievance', 'rowKey', counted.chapter_id,
        'colKey', counted.case_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.case_type)
      from (
        with scoped as (
          select cs.user_id, cs.chapter_id, cs.case_type, cs.status,
            case when cs.step in ('Intake', 'intake') then 0 else 2 end as step_bucket
          from public.member_cases cs
          where cs.organization_id = org and cs.chapter_id is not null
            and cs.created_at >= period_start and cs.created_at < period_end
        ), totals as (
          select scoped.chapter_id, scoped.case_type,
            pg_catalog.count(distinct scoped.user_id) as person_count
          from scoped group by scoped.chapter_id, scoped.case_type
        ), minima as (
          select cells.chapter_id, cells.case_type, pg_catalog.min(cells.cell_people) as minimum_cell
          from (
            select scoped.chapter_id, scoped.case_type, scoped.status, scoped.step_bucket,
              pg_catalog.count(distinct scoped.user_id) as cell_people
            from scoped
            group by scoped.chapter_id, scoped.case_type, scoped.status, scoped.step_bucket
          ) cells
          group by cells.chapter_id, cells.case_type
        )
        select totals.chapter_id, totals.case_type, totals.person_count
        from totals join minima using (chapter_id, case_type)
        where totals.person_count >= privacy_threshold and minima.minimum_cell >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementCounts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', counted.chapter_id,
        'eventType', counted.event_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.event_type)
      from (
        select e.chapter_id, e.event_type, pg_catalog.count(distinct e.user_id) as person_count
        from public.organization_engagement_events e
        where e.organization_id = org
          and e.occurred_at >= generated - interval '180 days'
        group by e.chapter_id, e.event_type
        having pg_catalog.count(distinct e.user_id) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementHistogram', pg_catalog.jsonb_build_object(
      'organizationId', org, 'privacyThreshold', privacy_threshold
    ),
    'attendanceEvents', '[]'::jsonb,
    'attendanceCohorts', pg_catalog.jsonb_build_object(
      'organizationId', org, 'firstTime', null, 'repeat', null, 'suppressed', true
    )
  );
  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surface', 'organization_analytics_snapshot'
  ));
  return result;
end;
$function$;

drop function if exists public.request_organization_analytics_export(text);
create function public.request_organization_analytics_export(
  p_format text,
  p_row_count integer,
  p_suppressed_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  created uuid;
  expires timestamptz := pg_catalog.now() + interval '24 hours';
  fmt text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_format, '')));
  rows integer := coalesce(p_row_count, 0);
  suppressed integer := coalesce(p_suppressed_count, 0);
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['coordinator', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if fmt not in ('csv', 'json') or rows not between 0 and 10000
     or suppressed not between 0 and rows then
    raise exception 'invalid export request' using errcode = '22023';
  end if;
  insert into public.organization_analytics_exports (
    organization_id, export_format, expires_at, created_by, row_count, suppressed_count
  ) values (org, fmt, expires, (select auth.uid()), rows, suppressed)
  returning id into created;
  perform private.mi1_write_tenant_audit(org, 'analytics_export_requested', pg_catalog.jsonb_build_object(
    'organizationId', org, 'exportFormat', fmt, 'expiresAt', expires,
    'rowCount', rows, 'suppressedCount', suppressed
  ));
  return pg_catalog.jsonb_build_object(
    'id', created, 'organizationId', org, 'format', fmt, 'expiresAt', expires,
    'rowCount', rows, 'suppressedCount', suppressed
  );
end;
$function$;

revoke all on function public.get_organization_analytics_snapshot()
  from public, anon, authenticated, service_role;
revoke all on function public.request_organization_analytics_export(text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_organization_analytics_snapshot() to authenticated;
grant execute on function public.request_organization_analytics_export(text, integer, integer) to authenticated;

-- Restricted-case visibility follows the case's immutable chapter, never the
-- subject member's mutable profile chapter.
create or replace function private.can_read_restricted_case(p_organization_id uuid, p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    and p_organization_id is not null
    and p_case_id is not null
    and private.is_organization_member(p_organization_id)
    and exists (
      select 1 from public.member_cases mc
      where mc.id = p_case_id and mc.organization_id = p_organization_id
        and (
          private.has_organization_role(p_organization_id, array['admin', 'vp'])
          or (
            mc.steward_user_id = (select auth.uid())
            and (
              private.has_organization_role(p_organization_id, array['steward'])
              or exists (
                select 1 from public.member_role_chapters rc
                where rc.user_id = (select auth.uid()) and rc.chapter_id = mc.chapter_id
                  and rc.role = 'steward'
              )
            )
          )
          or private.has_organization_role(p_organization_id, array['coordinator'])
          or exists (
            select 1 from public.member_role_chapters rc
            where rc.user_id = (select auth.uid()) and rc.chapter_id = mc.chapter_id
              and rc.role = 'coordinator'
          )
        )
        and (
          not exists (
            select 1 from public.case_restrictions r
            where r.organization_id = p_organization_id and r.case_id = mc.id and r.restricted
          )
          or private.has_organization_role(p_organization_id, array['admin', 'vp'])
          or exists (
            select 1 from public.case_restriction_access a
            where a.organization_id = p_organization_id and a.case_id = mc.id
              and a.user_id = (select auth.uid())
          )
        )
    )
$function$;

revoke all on function private.can_read_restricted_case(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Question IDs are server-owned so a caller cannot probe UUID collisions in
-- another survey or tenant.
create or replace function private.mi1_w2_replace_survey_questions(p_org uuid, p_survey uuid, p_questions jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  item jsonb;
  idx integer := 0;
  question_type text;
  label text;
begin
  if pg_catalog.jsonb_typeof(coalesce(p_questions, '[]'::jsonb)) <> 'array' then
    raise exception 'questions must be an array' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(coalesce(p_questions, '[]'::jsonb)) > 200 then
    raise exception 'survey question cap exceeded' using errcode = '22023';
  end if;
  delete from public.organization_survey_questions q
  where q.survey_id = p_survey and q.organization_id = p_org;
  for item in select value from pg_catalog.jsonb_array_elements(coalesce(p_questions, '[]'::jsonb))
  loop
    question_type := coalesce(item ->> 'type', item ->> 'questionType', '');
    if question_type = 'textarea' then question_type := 'paragraph'; end if;
    if question_type = 'slider-10' then question_type := 'scale'; end if;
    if question_type = 'yes/no' then question_type := 'yes_no'; end if;
    if question_type in ('single-select', 'radio-branch') then question_type := 'radio'; end if;
    label := pg_catalog.btrim(coalesce(item ->> 'label', item ->> 'text', ''));
    if label = '' then continue; end if;
    if question_type not in ('text', 'paragraph', 'radio', 'checkbox', 'dropdown', 'scale', 'rating', 'yes_no') then
      raise exception 'unsupported survey question type' using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(item -> 'options') = 'array'
       and pg_catalog.jsonb_array_length(item -> 'options') > 100 then
      raise exception 'survey option cap exceeded' using errcode = '22023';
    end if;
    insert into public.organization_survey_questions (
      id, organization_id, survey_id, sort_index, question_type, label, required,
      options, section_key, section_title, branch_value, scale_min_label, scale_max_label, max_selections
    ) values (
      extensions.gen_random_uuid(), p_org, p_survey, idx, question_type, label,
      coalesce((item ->> 'required')::boolean, false),
      case when pg_catalog.jsonb_typeof(item -> 'options') = 'array' then item -> 'options' else '[]'::jsonb end,
      nullif(item ->> 'sectionKey', ''), nullif(item ->> 'sectionTitle', ''),
      nullif(item ->> 'branchValue', ''), nullif(item ->> 'scaleMinLabel', ''),
      nullif(item ->> 'scaleMaxLabel', ''), nullif(item ->> 'maxSelections', '')::integer
    );
    idx := idx + 1;
  end loop;
end;
$function$;

revoke all on function private.mi1_w2_replace_survey_questions(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.retry_knowledge_ingest_source(p_source_id uuid, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  source public.organization_knowledge_sources%rowtype;
  cached jsonb;
  cached_request jsonb;
  request_payload jsonb := pg_catalog.jsonb_build_object('sourceId', p_source_id);
  result jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'retry_knowledge_ingest_source:' || org::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org
    and receipt.operation = 'retry_knowledge_ingest_source'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  select * into source from public.organization_knowledge_sources
  where id = p_source_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  update public.organization_knowledge_sources
  set health = 'unset_embedding', last_error = null,
      last_ingest_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where id = source.id and organization_id = org;
  update public.organization_knowledge_files
  set index_status = 'skipped_unset', updated_at = pg_catalog.now()
  where id = source.file_id and organization_id = org;
  perform private.mi1_w2_write_audit(org, 'knowledge_source_retried', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', source.file_id, 'sourceId', source.id,
    'indexStatus', 'skipped_unset', 'action', 'retried'
  ));
  result := public.get_knowledge_ingest_source(source.id);
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'retry_knowledge_ingest_source', p_idempotency_key, request_payload, result);
  return result;
end;
$function$;

revoke all on function public.retry_knowledge_ingest_source(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.retry_knowledge_ingest_source(uuid, uuid) to authenticated;

-- Generate webhook signing material inside Postgres/Vault. The browser gets
-- the plaintext once in the RPC response but never sends it in a request body.
drop function if exists public.create_integration_webhook(text, text[], text, text);
create function public.create_integration_webhook(p_url text, p_events text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  host text;
  webhook_id uuid := extensions.gen_random_uuid();
  plaintext text := 'whsec_' || pg_catalog.encode(extensions.gen_random_bytes(24), 'hex');
  secret_hash text;
  secret_id uuid;
  allowed_events constant text[] := array[
    'member.invited', 'member.profile_updated', 'case.opened', 'case.updated',
    'broadcast.published', 'event.checkin', 'appointment.scheduled'
  ];
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_url is null
     or pg_catalog.char_length(p_url) not between 12 and 500
     or p_url is distinct from pg_catalog.btrim(p_url)
     or p_url !~ '^https://' or p_url ~ '[[:space:][:cntrl:]]'
     or p_url ~ '^https://[^/]*@' or p_url ~ '#'
     or p_url ~* '^https://\['
     or p_url ~* '^https://(localhost|localhost\.localdomain|metadata|metadata\.google\.(internal|com)|kubernetes\.default\.svc)([:/]|$)'
     or p_url ~* '^https://[^/]+\.(local|internal|localhost|lan|home|corp|invalid)([:/]|$)'
     or p_url ~* '^https://(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[789][0-9]|1[01][0-9]|12[0-7])\.)([0-9.]*)([:/]|$)'
     or p_url ~ '^https://[^/]+\.(:[0-9]+)?(/|$)' then
    raise exception 'invalid webhook url' using errcode = '22023';
  end if;
  if p_events is null or pg_catalog.cardinality(p_events) not between 1 and 7
     or not p_events <@ allowed_events
     or pg_catalog.cardinality(p_events) <> pg_catalog.cardinality(array(select distinct unnest(p_events))) then
    raise exception 'invalid webhook events' using errcode = '22023';
  end if;
  host := (pg_catalog.regexp_match(p_url, '^https://([^/]+)'))[1];
  secret_hash := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(plaintext, 'UTF8'), 'sha256'), 'hex'
  );
  secret_id := vault.create_secret(
    plaintext, 'mi1-webhook-' || webhook_id::text, 'Organization webhook signing secret'
  );
  insert into public.integration_webhooks (
    id, organization_id, url, events, secret_hash, secret_ref
  ) values (webhook_id, org, p_url, p_events, secret_hash, secret_id);
  insert into public.organization_integrations (organization_id, provider, status)
  values (org, 'customer_webhooks', 'configured')
  on conflict (organization_id, provider) do update
    set status = 'configured', updated_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'integration_webhook_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'host', host, 'events', p_events, 'status', 'created'
  ));
  return pg_catalog.jsonb_build_object('signingSecret', plaintext);
end;
$function$;

revoke all on function public.create_integration_webhook(text, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.create_integration_webhook(text, text[]) to authenticated;
