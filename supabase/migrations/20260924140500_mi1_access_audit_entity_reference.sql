-- SEC-UG-ACCESS-AUDIT-ENTITY-REFERENCE-20260921
--
-- public.record_member_access_event already stores the bounded entity identifier
-- on the access-event row. Carry that same value into tenant-audit metadata and
-- project it (with the access event's own member/case entity type) from the
-- organization_audit_events branch of the admin ledger so
-- authorized audit history names which record was opened. Reader grants, RLS,
-- and every existing refusal stay unchanged. Sequences after
-- 20260921121500_access_event_uniform_refusal so the later generation keeps that
-- uniform 42501 refusal. The outer block keeps the case-graph entry lock that
-- 20260907151000_account_deletion_finalization_reconciliation installed ahead
-- of the organization initializer.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.record_member_access_event(
  p_expected_organization_id uuid,
  p_subject_user_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  caller uuid := (select auth.uid());
  role text;
  saved public.member_access_events%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(
    org,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_subject_user_id is null or p_subject_user_id is not distinct from caller then
    raise exception 'cannot record self access' using errcode = '22023';
  end if;
  if p_action not in ('viewed_profile', 'viewed_case', 'updated_profile', 'updated_case') then
    raise exception 'invalid action' using errcode = '22023';
  end if;
  if p_entity_type not in ('member', 'case') then
    raise exception 'invalid entity' using errcode = '22023';
  end if;
  if (p_action in ('viewed_profile', 'updated_profile') and p_entity_type <> 'member')
    or (p_action in ('viewed_case', 'updated_case') and p_entity_type <> 'case')
    or (p_entity_id is not null and pg_catalog.char_length(p_entity_id) not between 1 and 80)
    or (p_entity_type = 'case' and p_entity_id is null)
  then
    raise exception 'invalid entity' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = org
      and membership.user_id = p_subject_user_id
      and membership.status = 'active'
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select r.role into role
  from public.organization_role_grants r
  where r.organization_id = org
    and r.user_id = caller
    and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  order by case r.role
    when 'admin' then 1
    when 'vp' then 2
    when 'coordinator' then 3
    when 'advisor' then 4
    when 'steward' then 5
    else 6
  end
  limit 1;
  if role is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.member_access_events (
    organization_id, subject_user_id, actor_user_id, actor_role, action, entity_type, entity_id
  ) values (
    org, p_subject_user_id, caller, role, p_action, p_entity_type, nullif(p_entity_id, '')
  )
  returning * into saved;
  perform private.mi1_write_tenant_audit(org, 'member_access_recorded', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'userId', p_subject_user_id,
    'action', p_action,
    'entityType', p_entity_type,
    'entityId', nullif(p_entity_id, '')
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'id', saved.id, 'organizationId', org);
end;
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
            'entityType', case
              when e.event_type = 'member_access_recorded'
                and e.metadata ->> 'entityType' in ('member', 'case')
                then e.metadata ->> 'entityType'
              else 'organization'
            end,
            'entityId', e.metadata ->> 'entityId',
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

comment on function public.record_member_access_event(uuid, uuid, text, text, text) is
  'Staff record of active members in the selected organization. Tenant-audit metadata carries the same bounded entityId stored on the access-event row. Unauthorized caller and subject refusals share one 42501 outcome; self-access and input validation stay in 22023 and run before the membership check.';

notify pgrst, 'reload schema';

commit;
