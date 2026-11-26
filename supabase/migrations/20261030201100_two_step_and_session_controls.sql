-- #6574: staff two-step stays mandatory; an administrator may also require
-- it for every active member. These are tenant policy, never JWT user metadata.
begin;
alter table public.org_security_policy
  add column require_member_mfa boolean not null default false;

-- Preserve the existing vocabulary and admit the new audited policy flag.
alter table public.organization_audit_events
  drop constraint organization_audit_events_metadata_keys;
alter table public.organization_audit_events
  add constraint organization_audit_events_metadata_keys check (
    metadata - array[
      'organizationId', 'chapterId', 'slug', 'name', 'role', 'userId',
      'status', 'requireStaffMfa', 'requireMemberMfa', 'questionId', 'replyId', 'targetKind',
      'voted', 'kind', 'surface', 'exportFormat', 'rowCount',
      'suppressedCount', 'expiresAt', 'grade', 'stepNumber', 'effectiveOn',
      'action', 'provider', 'host', 'events', 'entityType', 'entityId',
      'fromStatus', 'toStatus', 'fromRole', 'toRole', 'eventType', 'domain',
      'jobName', 'runId', 'remediation', 'outcome', 'count', 'fieldsChanged',
      'reasonCode', 'exportType', 'cadence', 'surveyId', 'sessionId',
      'privacyMinResponses', 'caseId', 'fromStep', 'toStep',
      'previousDeadline', 'newDeadline', 'alertId', 'reminderId',
      'restricted', 'fileId', 'sourceId', 'category', 'library',
      'reviewStatus', 'indexStatus', 'byteSize', 'handoffId', 'fromStewardId',
      'toStewardId', 'clauseId', 'article', 'collectionId', 'visibility',
      'scope', 'itemKind', 'itemId', 'included', 'articleId',
      'restoredRevisionId', 'restoredFromVersion', 'newVersion',
      'accountEmail', 'fields', 'version', 'campaignId', 'batchId',
      'scopeKind', 'eligibleCount', 'amountCents', 'obligationId',
      'receiptNumber', 'eventKind', 'channel', 'attemptId', 'selectedHat',
      'requestedBy', 'reservationId', 'resolution', 'evidenceReference',
      'reason', 'failureClass', 'publishedPreserved',
      'publishedCandidatesStaged', 'publishedRetirementsStaged',
      'staleCandidatesCleared', 'draftsRetired', 'oauthStateFinalized',
      'resumedRecordedExchange', 'spaceId', 'postingMode', 'slowModeSeconds',
      'approvalsRequired', 'taskId', 'reviewId', 'promptId', 'pollId'
    ] = '{}'::jsonb
  );

create function private.member_mfa_required(p_user uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1 from public.organization_memberships membership
    join public.organizations organization on organization.id = membership.organization_id
      and organization.status = 'active'
    join public.org_security_policy policy on policy.organization_id = membership.organization_id
    where membership.user_id = p_user and membership.status = 'active'
      and policy.require_member_mfa
  );
$function$;
revoke all on function private.member_mfa_required(uuid) from public, anon, authenticated, service_role;

-- Reachable before enrollment, but only for the caller's own live Auth session.
-- This explains an RLS refusal without granting access to any member data.
create function public.get_my_mfa_requirement()
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
begin
  perform private.current_member_session_id();
  return pg_catalog.jsonb_build_object(
    'required', private.member_mfa_required((select auth.uid())),
    'enrolled', private.has_second_factor((select auth.uid()))
  );
end;
$function$;
revoke all on function public.get_my_mfa_requirement() from public, anon, authenticated, service_role;
grant execute on function public.get_my_mfa_requirement() to authenticated;

create or replace function private.mfa_satisfied()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select case
    when claims.user_id is null then false
    when coalesce(claims.session_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then false
    when exists (select 1 from private.member_mfa_recovery_locks recovery where recovery.user_id = claims.user_id) then false
    when not exists (
      select 1 from auth.sessions session
      left join private.member_mfa_reset_boundaries boundary on boundary.user_id = session.user_id
      where session.id = claims.session_id::uuid and session.user_id = claims.user_id
        and session.created_at > coalesce(boundary.invalid_before,'-infinity'::timestamptz)
    ) then false
    when claims.key_uv then claims.aal = 'aal2' and private.verified_key_session(claims.user_id,claims.session_id::uuid)
    when claims.aal = 'aal2' then true
    else not private.member_mfa_required(claims.user_id) and not exists (select 1 from auth.mfa_factors factor where factor.user_id = claims.user_id and factor.status = 'verified' and factor.factor_type = 'totp')
  end from (
    select (select auth.uid()) as user_id, (select auth.jwt()->>'session_id') as session_id,
      (select auth.jwt()->>'aal') as aal, coalesce((select auth.jwt()->'ug_key_uv') = 'true'::jsonb,false) as key_uv
  ) claims;
$function$;

create or replace function public.get_staff_mfa_policy()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  policy_org uuid := private.current_member_organization();
  staff_total integer;
  staff_enrolled integer;
begin
  if caller is null
     or policy_org is null
     or not private.mfa_satisfied()
     or not private.has_organization_role(policy_org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  select pg_catalog.count(*)::integer,
         pg_catalog.count(*) filter (
           where private.has_second_factor(scoped_staff.user_id)
         )::integer
    into staff_total, staff_enrolled
  from (
    select g.user_id
    from public.organization_role_grants g
    join public.organization_memberships om
      on om.organization_id = g.organization_id
     and om.user_id = g.user_id
     and om.status = 'active'
    where g.organization_id = policy_org
    union
    select rc.user_id
    from public.member_role_chapters rc
    join public.chapters c
      on c.id = rc.chapter_id
     and c.organization_id = policy_org
    join public.member_chapter_memberships cm
      on cm.user_id = rc.user_id
     and cm.chapter_id = rc.chapter_id
     and cm.status = 'active'
    join public.organization_memberships om
      on om.organization_id = c.organization_id
     and om.user_id = rc.user_id
     and om.status = 'active'
  ) scoped_staff;

  return pg_catalog.jsonb_build_object(
    'requireStaffMfa', private.staff_mfa_required(policy_org),
    'requireMemberMfa', coalesce((select p.require_member_mfa from public.org_security_policy p where p.organization_id = policy_org), false),
    'staffTotal', coalesce(staff_total, 0),
    'staffEnrolled', coalesce(staff_enrolled, 0),
    'callerEnrolled', private.has_second_factor(caller),
    'updatedAt', (
      select p.updated_at
      from public.org_security_policy p
      where p.organization_id = policy_org
    )
  );
end;
$function$;

create or replace function public.set_staff_mfa_policy(p_required boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  policy_org uuid;
  current_value boolean;
begin
  -- Admit the policy write before evaluating its organization initializer.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  policy_org := private.current_member_organization();
  perform private.member_pin_require_full_session();
  if p_required is false then
    raise exception 'staff two-step cannot be disabled' using errcode = '22023';
  end if;
  if p_required is null then
    raise exception 'required flag missing' using errcode = '22023';
  end if;
  if caller is null
     or policy_org is null
     or not private.mfa_satisfied()
     or not private.has_organization_role(policy_org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  insert into public.org_security_policy (
    id, organization_id, require_staff_mfa
  ) values (
    true, policy_org, true
  )
  on conflict (organization_id) where organization_id is not null do nothing;

  select p.require_staff_mfa
    into current_value
    from public.org_security_policy p
   where p.organization_id = policy_org
   for update;

  if caller is null
     or policy_org is distinct from private.current_member_organization()
     or not private.mfa_satisfied()
     or not private.has_organization_role(policy_org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_required and not private.has_second_factor(caller) then
    raise exception 'turn on your own two-step sign-in before requiring it of staff'
      using errcode = '42501';
  end if;

  if current_value is distinct from p_required then
    update public.org_security_policy
       set require_staff_mfa = p_required,
           updated_at = pg_catalog.now(),
           updated_by = caller
     where organization_id = policy_org;

    insert into public.organization_audit_events (
      organization_id, event_type, actor_user_id, idempotency_key, metadata
    ) values (
      policy_org,
      'staff_mfa_policy_changed',
      caller,
      extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', policy_org::text,
        'requireStaffMfa', p_required
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'requireStaffMfa', p_required,
    'changed', current_value is distinct from p_required
  );
end;
$function$;

create function public.set_member_mfa_policy(p_required boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  caller uuid;
  policy_org uuid;
  current_value boolean;
begin
  -- Policy and audit writes enter the same lifecycle gate as account deletion.
  -- Resolve the organization only after admission, never in an initializer.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  policy_org := private.current_member_organization();
  perform private.member_pin_require_full_session();
  if p_required is null then
    raise exception 'required flag missing' using errcode = '22023';
  end if;
  if caller is null or policy_org is null or not private.mfa_satisfied()
     or not private.has_second_factor(caller)
     or not private.has_organization_role(policy_org, array['admin']) then
    raise exception 'admin with two-step required' using errcode = '42501';
  end if;
  insert into public.org_security_policy(id, organization_id, require_staff_mfa)
    values (true, policy_org, true)
    on conflict (organization_id) where organization_id is not null do nothing;
  select p.require_member_mfa into current_value from public.org_security_policy p
    where p.organization_id = policy_org for update;
  if policy_org is distinct from private.current_member_organization()
     or not private.mfa_satisfied() or not private.has_second_factor(caller)
     or not private.has_organization_role(policy_org, array['admin']) then
    raise exception 'admin with two-step required' using errcode = '42501';
  end if;
  if current_value is distinct from p_required then
    update public.org_security_policy set require_member_mfa = p_required,
      require_staff_mfa = true, updated_at = pg_catalog.now(), updated_by = caller
      where organization_id = policy_org;
    insert into public.organization_audit_events
      (organization_id, event_type, actor_user_id, idempotency_key, metadata)
      values (policy_org, 'staff_mfa_policy_changed', caller, extensions.gen_random_uuid(),
        pg_catalog.jsonb_build_object('organizationId', policy_org::text,
          'requireStaffMfa', true, 'requireMemberMfa', p_required));
  end if;
  return pg_catalog.jsonb_build_object('requireMemberMfa', p_required,
    'changed', current_value is distinct from p_required);
end;
$function$;
revoke all on function public.set_member_mfa_policy(boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_member_mfa_policy(boolean) to authenticated;

-- The MFA predicate participates in the account-lifecycle trigger graph.
-- Review only the definitions deliberately changed or added in this delivery.
insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and table_name = '' and (
  (schema_name = 'private' and object_name in ('mfa_satisfied()', 'member_mfa_required(p_user uuid)'))
  or (schema_name = 'public' and object_name in (
    'get_staff_mfa_policy()', 'set_staff_mfa_policy(p_required boolean)',
    'set_member_mfa_policy(p_required boolean)', 'get_my_mfa_requirement()'))
)
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

notify pgrst, 'reload schema';
commit;
