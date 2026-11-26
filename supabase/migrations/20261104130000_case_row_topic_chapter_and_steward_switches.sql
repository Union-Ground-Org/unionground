-- REQ-UG-LIST-ROW-DETAIL-TOGGLE-CHAPTER-AND-STEWARD-20261104 (#7043):
-- #7020 (20261104080000) made case list rows and search hits neutral at the
-- source: they name a case by reference, type and step (private.case_row_line),
-- never by its topic. On Nov 4, 2026 the owner kept that as the default and
-- added two switches: "let the chapter
-- leadership be able to toggle on or off. same for stewards for their
-- individual cases."
--
--   1. Chapter switch. private.chapter_access_policies gains case_row_topic
--      (default off). Only the chapter's access leadership
--      (private.chapter_access_leadership: an organization admin, or the
--      chapter's admin or vp, the roles that already save the chapter access
--      policy) changes it, through public.set_chapter_case_row_topic. When it
--      is on, the case's topic is shown in the rows of every reader the row
--      read already admits. Restricted and identity-private cases keep the
--      neutral line under the chapter switch.
--   2. Steward switch. private.case_row_topic_marks holds one case id per case
--      whose assigned steward turned it on (public.set_case_row_topic). It
--      shows the topic only in rows composed for that case's assigned steward
--      (member_cases.steward_user_id = auth.uid()). Other readers keep the
--      chapter's setting, and the mark carries no user identifier or case text,
--      in the same shape as private.case_identity_privacy. Restricted and
--      identity-private cases stay neutral under either switch.
--
-- Neither switch widens who can read a case: the composers below are pure
-- projections called inside list and search reads whose row filters are
-- unchanged, and public.list_case_row_titles admits only cases that pass
-- private.chapter_case_readable (the member_cases read policy). The composers
-- read the topic themselves from the case id, so no list read names
-- member_cases.title; the member's description, articles and note text are
-- never returned. Each switch change writes one public.member_admin_audit row
-- with the actor. Stored notifications are not rewritten, and case
-- notifications stay on the catalogue copy, which names no case.
--
-- Hosted application: SAMPLE first, then production; after 20261104080000.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
-- pg_catalog alone resolves names exactly as an empty path does.
set local search_path = pg_catalog;

alter table public.member_admin_audit drop constraint member_admin_audit_action_check;
alter table public.member_admin_audit add constraint member_admin_audit_action_check check(action in (
  'grant_role','revoke_role','create_event','update_event','cancel_event','restore_event','delete_event','reset_mfa',
  'claim_reward','grant_reward','revoke_reward','fulfill_reward','set_staff_mfa_policy','set_compass_ai_enabled','set_compass_ai_role_limit','attest_compass_ai_provider',
  'create_campaign','update_campaign_draft','publish_campaign','close_campaign','recover_signin_address','recover_signin_address_failed','review_email_intake',
  'create_chapter','update_chapter','grant_chapter_membership','revoke_chapter_membership','event_checkin_lockout','set_chapter_display_title','self_service_password_reset',
  'committee_updated','access_membership_updated','access_policy_updated','role_capability_updated','role_scope_updated','grievance_identity_visibility_updated',
  'case_row_topic_policy_updated','case_row_topic_updated'
));

alter table private.chapter_access_policies
  add column case_row_topic boolean not null default false;

comment on column private.chapter_access_policies.case_row_topic is
  'When true, case list rows and search hits for this chapter''s cases show the case topic to the readers the row read already admits (#7043). Default false: the neutral type and step line (#7015).';

create table private.case_row_topic_marks (
  -- One mark per case whose assigned steward shows its topic in their own
  -- rows. It carries no user identifier or case text: the steward it applies
  -- to is always the case's current steward_user_id. The writer validates and
  -- locks its live case; no client can create a mark directly.
  case_id uuid primary key
);
alter table private.case_row_topic_marks enable row level security;
alter table private.case_row_topic_marks force row level security;
revoke all on private.case_row_topic_marks from public, anon, authenticated, service_role;
create policy mfa_assurance on private.case_row_topic_marks as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.case_row_topic_marks is
  'Step-up floor on the steward topic marks (#7043). Clients hold no table privilege; the definer RPCs are the only readers and writer.';
-- The only runtime writer locks its live case through lock_case_graph before
-- touching this RPC-only, identifier-only table. Like
-- private.case_identity_privacy it deliberately has no FK.

create function private.case_row_topic_shown(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  -- A restricted member PIN session reads no case row (member_pin_step_up),
  -- so no list read shows it a topic either. Restricted and identity-private
  -- cases stay neutral for everyone, the assigned steward's own switch
  -- included (ruling, gate round 1).
  select not private.member_pin_session_restricted() and coalesce((
    select nullif(pg_catalog.btrim(c.title), '') is not null
      and not c.is_restricted
      and not exists (select 1 from private.case_identity_privacy privacy where privacy.case_id = c.id)
      and (
        coalesce((select policy.case_row_topic from private.chapter_access_policies policy
                  where policy.chapter_id = c.chapter_id), false)
        or (c.steward_user_id = (select auth.uid())
          and exists (select 1 from private.case_row_topic_marks mark where mark.case_id = c.id)))
    from public.member_cases c
    where c.id = p_case_id), false);
$function$;

revoke all on function private.case_row_topic_shown(uuid) from public, anon, authenticated, service_role;

comment on function private.case_row_topic_shown(uuid) is
  'True when a case row composed for the caller may show the case topic: the chapter switch or the caller''s own steward switch (#7043). Never for a restricted or identity-private case, and never for a restricted member PIN session. A projection only; callers filter rows by read access first.';

create function private.case_row_title(p_case_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select case when private.case_row_topic_shown(c.id) then c.title
              else private.case_row_line(c.case_type, c.step) end
  from public.member_cases c
  where c.id = p_case_id;
$function$;

revoke all on function private.case_row_title(uuid) from public, anon, authenticated, service_role;

comment on function private.case_row_title(uuid) is
  'The name a case row carries for the caller: the topic when private.case_row_topic_shown allows it, otherwise the neutral private.case_row_line (#7015, #7043). Never the description, articles or note text.';

create function public.get_chapter_case_row_topic(p_chapter text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then
    raise exception 'chapter leadership required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'chapterId', p_chapter,
    'enabled', coalesce((select policy.case_row_topic from private.chapter_access_policies policy
                         where policy.chapter_id = p_chapter), false),
    'canChange', true);
end;
$function$;

revoke all on function public.get_chapter_case_row_topic(text) from public, anon, authenticated, service_role;
grant execute on function public.get_chapter_case_row_topic(text) to authenticated;

comment on function public.get_chapter_case_row_topic(text) is
  'The chapter''s case-row topic switch for its access leadership (#7043).';

create function public.set_chapter_case_row_topic(p_chapter text, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
begin
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then
    raise exception 'chapter leadership required' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'choose on or off' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || private.current_member_organization()::text, 509));
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then
    raise exception 'chapter leadership required' using errcode = '42501';
  end if;
  insert into private.chapter_access_policies(chapter_id, case_row_topic) values (p_chapter, p_enabled)
  on conflict (chapter_id) do update set case_row_topic = excluded.case_row_topic;
  insert into public.member_admin_audit(actor, action, detail)
  values (auth.uid(), 'case_row_topic_policy_updated',
    pg_catalog.jsonb_build_object('chapterId', p_chapter, 'enabled', p_enabled));
  return pg_catalog.jsonb_build_object('updated', true, 'enabled', p_enabled);
end;
end;
$function$;

revoke all on function public.set_chapter_case_row_topic(text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_chapter_case_row_topic(text, boolean) to authenticated;

comment on function public.set_chapter_case_row_topic(text, boolean) is
  'Chapter access leadership turns case topics in this chapter''s case rows on or off; one member_admin_audit row per change (#7043).';

create function public.get_case_row_topic(p_case uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare target public.member_cases%rowtype;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into target from public.member_cases c
  where c.id = p_case and c.learning_undone_at is null and private.chapter_case_readable(c);
  if not found then
    raise exception 'case unavailable' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'shown', exists (select 1 from private.case_row_topic_marks mark where mark.case_id = p_case),
    'chapterShown', coalesce((select policy.case_row_topic from private.chapter_access_policies policy
                              where policy.chapter_id = target.chapter_id), false),
    'canChange', target.steward_user_id = (select auth.uid()) and public.member_has_role(array['steward']));
end;
$function$;

revoke all on function public.get_case_row_topic(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_case_row_topic(uuid) to authenticated;

comment on function public.get_case_row_topic(uuid) is
  'A readable case''s steward topic switch, the chapter switch, and whether the caller is its assigned steward (#7043).';

create function public.set_case_row_topic(p_case uuid, p_shown boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[p_case]);
declare target public.member_cases%rowtype;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into target from public.member_cases
  where id = p_case and learning_undone_at is null and steward_user_id = (select auth.uid())
  for update;
  if not found or target.steward_user_id is distinct from (select auth.uid())
     or not public.member_has_role(array['steward'])
     or not private.chapter_case_readable(target) then
    raise exception 'assigned steward required' using errcode = '42501';
  end if;
  if p_shown is null then
    raise exception 'choose on or off' using errcode = '22023';
  end if;
  if p_shown then
    insert into private.case_row_topic_marks(case_id) values (p_case) on conflict do nothing;
  else
    delete from private.case_row_topic_marks where case_id = p_case;
  end if;
  insert into public.member_admin_audit(actor, action, detail)
  values (auth.uid(), 'case_row_topic_updated',
    pg_catalog.jsonb_build_object('caseId', p_case, 'chapterId', target.chapter_id, 'shown', p_shown));
  return pg_catalog.jsonb_build_object('updated', true, 'shown', p_shown);
end;
end;
$function$;

revoke all on function public.set_case_row_topic(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_case_row_topic(uuid, boolean) to authenticated;

comment on function public.set_case_row_topic(uuid, boolean) is
  'The assigned steward shows or hides this case''s topic in their own case rows; one member_admin_audit row per change (#7043).';

create function public.list_case_row_titles(p_case_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  -- A restricted member PIN session reads no case row (member_pin_step_up on
  -- member_cases); this definer read states the same gate.
  if (select auth.uid()) is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if coalesce(pg_catalog.cardinality(p_case_ids), 0) > 200 then
    raise exception 'at most 200 cases' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id,
      'title', private.case_row_title(c.id),
      'topicShown', private.case_row_topic_shown(c.id)
    ) order by c.id)
    from public.member_cases c
    where c.id = any(p_case_ids)
      and c.learning_undone_at is null
      and private.chapter_case_readable(c)
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_case_row_titles(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.list_case_row_titles(uuid[]) to authenticated;

comment on function public.list_case_row_titles(uuid[]) is
  'Row names for up to 200 cases the caller can read (private.chapter_case_readable): the topic when a switch allows it, otherwise the neutral line (#7043). Unreadable ids are left out.';

create or replace function public.list_unassigned_chapter_cases()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', open_case.id,
      'reference', open_case.reference,
      'title', private.case_row_title(open_case.id),
      'topicShown', private.case_row_topic_shown(open_case.id),
      'caseType', open_case.case_type,
      'step', open_case.step,
      'deadline', open_case.deadline,
      'filingStatus', open_case.filing_status,
      'createdAt', open_case.created_at,
      'memberName', open_case.full_name
    ) order by open_case.deadline nulls last, open_case.created_at, open_case.id)
    from (
      select c.id, c.reference, c.case_type, c.step, c.deadline,
             c.filing_status, c.created_at, p.full_name
      from public.member_cases c
      join public.member_profiles p on p.id = c.user_id
      where c.status = 'active'
        and c.steward_user_id is null
        and not c.is_restricted
        and c.user_id <> caller
        and private.chapter_case_readable(c)
        and c.organization_id = (select private.current_member_organization())
        and (private.has_organization_role(c.organization_id, array['steward'])
             or private.member_has_chapter_role(c.chapter_id, array['steward'])
             or private.chapter_scoped_role_allows(c.chapter_id,'steward',c.user_id,true))
        and private.chapter_case_intake_role_allows(c.user_id, 'steward')
      order by c.deadline nulls last, c.created_at, c.id
      limit 50
    ) open_case
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.list_share_case_destinations(p_limit integer DEFAULT 100)
 RETURNS TABLE(id uuid, user_id uuid, reference text, title text, status text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();
declare
  v_actor uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit,100),1),100);
begin
  if v_actor is null then return; end if;
  return query
  with actor_scope as materialized (
    select
      -- mfa_assurance, the RESTRICTIVE policy both case tables carry. It ANDs
      -- over every permissive branch, so it gates the whole `visible` CTE.
      (select private.mfa_satisfied()) as mfa_satisfied,
      -- member_cases_select_steward's second conjunct.
      public.member_has_role(array['steward']) as steward_hat,
      -- public.staff_can_see_user(user_id, 'coordinator') as a set of chapters.
      array(select private.staff_visible_chapter_scope('coordinator')) as coordinator_chapters,
      -- private.has_organization_role(organization_id, array['advisor','admin','vp'])
      -- is false unless organization_id is this organization, so the grant test
      -- is a constant and the per-row test is a column comparison.
      (select private.current_mobile_staff_organization()) as staff_organization,
      coalesce((select private.has_organization_role(
        (select private.current_mobile_staff_organization()),
        array['advisor','admin','vp'])), false) as organization_officer,
      -- private.casework_actor_has_active_grant(id), as the set it tests.
      array(
        select g.case_id
        from public.casework_access_grants g
        where g.grantee_user_id = v_actor
          and g.revoked_at is null
      ) as granted_cases
  ),
  staff_visible as (
    select c.id
    from public.member_profiles case_owner
    join (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c on c.user_id = case_owner.id
    where (select s.coordinator_chapters from actor_scope s) <> '{}'::text[]
      and case_owner.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])
      and (
        not c.is_restricted or c.coordinator_user_id = v_actor
        or (c.organization_id is not null
          and c.organization_id = (select s.staff_organization from actor_scope s)
          and (select s.organization_officer from actor_scope s))
        or c.id = any((select s.granted_cases from actor_scope s)::uuid[])
      )
  ), visible_ids as (
    select c.id from (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c where private.chapter_case_readable(c)
    union
    select c.id from (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c where c.user_id = v_actor
    union
    select c.id from (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c
      where c.steward_user_id = v_actor and (select s.steward_hat from actor_scope s)
    union
    select s.id from staff_visible s
  )
  select c.id, c.user_id, c.reference, private.case_row_title(c.id), c.status, c.updated_at
  from visible_ids v join (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c on c.id = v.id
  where (select s.mfa_satisfied from actor_scope s)
  order by c.updated_at desc, c.id
  limit v_limit;
end;
end;
$function$;

create or replace function public.list_steward_case_deadlines()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_build_object(
      'truncated', pg_catalog.count(*) > 100,
      'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'caseId', due.case_id, 'reference', due.reference,
      'title', private.case_row_title(due.case_id), 'topicShown', private.case_row_topic_shown(due.case_id),
      'caseType', due.case_type, 'step', due.step,
      'kind', due.kind, 'label', due.label, 'dueOn', due.due_on,
      'overdue', due.overdue,
      'afterStepDue', due.after_step_due
    ) order by due.due_on, due.reference, due.kind) filter (where due.position <= 100), '[]'::jsonb))
    from (
      select merged.*, pg_catalog.row_number() over (order by merged.due_on, merged.reference, merged.kind) as position
      from (
        -- A clock is overdue once its moment has passed or the sweep has
        -- marked it missed (20261002143000), whatever the calendar day.
        select c.id as case_id, c.reference, c.case_type, c.step, d.kind, d.label,
               (d.due_at at time zone 'America/New_York')::date as due_on,
               (d.due_at < pg_catalog.now() or d.status = 'missed') as overdue,
               false as after_step_due
        from public.member_cases c
        join public.casework_deadlines d on d.case_id = c.id and d.status in ('active', 'extended', 'missed')
        where c.steward_user_id = caller and c.status = 'active'
          and private.casework_staff_can_access(c.id)
        union all
        -- The case's own deadline is a date: overdue from the next Eastern day.
        select c.id, c.reference, c.case_type, c.step, 'case', 'Case deadline', c.deadline,
               c.deadline < (pg_catalog.now() at time zone 'America/New_York')::date,
               exists (
                 select 1 from public.casework_deadlines step
                 where step.case_id = c.id and step.status in ('active', 'extended', 'missed') and step.kind = 'procedure'
                   and (step.due_at at time zone 'America/New_York')::date < c.deadline)
        from public.member_cases c
        where c.steward_user_id = caller and c.status = 'active' and c.deadline is not null
          and private.casework_staff_can_access(c.id)
      ) merged
      order by merged.due_on, merged.reference, merged.kind
      limit 101
    ) due
  ), pg_catalog.jsonb_build_object('truncated', false, 'rows', '[]'::jsonb));
end;
$function$;

create or replace function public.casework_list_ulp_deadlines(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  perform private.casework_require_mfa();
  return coalesce((
    select pg_catalog.jsonb_agg(row_data order by deadline, flag_id)
    from (
      select case when f.safety_deadline >= current_date and f.safety_deadline < f.ulp_deadline
          then f.safety_deadline else f.ulp_deadline end as deadline,
        f.id as flag_id,
        pg_catalog.jsonb_build_object(
          'flagId', f.id,
          'caseId', c.id,
          'reference', c.reference,
          'title', private.case_row_title(c.id),
          'topicShown', private.case_row_topic_shown(c.id),
          'caseType', c.case_type,
          'step', c.step,
          'source', f.source,
          'status', f.status,
          'incidentOn', f.incident_on,
          'ulpDeadline', f.ulp_deadline,
          'daysLeft', f.ulp_deadline - current_date,
          'warningDays', t.warning_days,
          'criticalDays', t.critical_days,
          'protectedActivityCategory', f.protected_activity_category,
          'safetyDeadline', f.safety_deadline,
          'safetyRoute', private.casework_safety_retaliation_route(f.organization_id)) as row_data
      from public.casework_retaliation_flags f
      join public.member_cases c on c.id = f.case_id
      cross join lateral private.casework_ulp_thresholds(f.organization_id) t
      where f.status in ('open', 'confirmed')
        and f.organization_id = org
        and private.casework_staff_can_read(f.case_id)
        and private.organization_feature_enabled(f.organization_id, 'features.casework.ulp_deadline')
      order by case when f.safety_deadline >= current_date and f.safety_deadline < f.ulp_deadline
          then f.safety_deadline else f.ulp_deadline end, f.id
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) rows
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.list_vp_case_reviews()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  payload jsonb;
begin
  if caller is null or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role with MFA required' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller
    and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  order by r.chapter_id
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'caseId', v.case_id,
    'reviewedAt', v.reviewed_at,
    'reviewedBy', v.reviewed_by,
    'reviewerName', p.full_name,
    'caseReference', c.reference,
    'caseTitle', private.case_row_title(c.id),
    'topicShown', private.case_row_topic_shown(c.id),
    'caseType', c.case_type,
    'caseStep', c.step
  ) order by v.reviewed_at desc), '[]'::jsonb)
  into payload
  from public.member_vp_case_reviews v
  join (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p on p.id = v.reviewed_by
  join (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c on c.id = v.case_id
  where v.chapter_id = caller_chapter;

  return payload;
end;
$function$;

-- The search wrapper gains topic_shown, so it is dropped and created again
-- with the same arguments, grants and gate. Its body stays
-- private.search_member_cases, unchanged.
drop function public.search_member_cases(text, integer);

create function public.search_member_cases(p_query text, p_limit integer default 20)
returns table(case_id uuid, reference text, title text, case_type text, articles text, step text, status text, deadline date, updated_at timestamp with time zone, rank real, headline text, headline_source text, topic_shown boolean)
language sql
stable
security definer
set search_path = ''
as $function$
  select hit.case_id, hit.reference, private.case_row_title(hit.case_id),
         hit.case_type, null::text, hit.step, hit.status, hit.deadline, hit.updated_at,
         hit.rank, null::text, hit.headline_source, private.case_row_topic_shown(hit.case_id)
  from private.search_member_cases(p_query, p_limit) with ordinality
    as hit(case_id, reference, title, case_type, articles, step, status, deadline, updated_at, rank, headline, headline_source, position)
  -- The search body already returns nothing without step-up; the wrapper
  -- states the same gate so the definer MFA sweep can see it.
  where (select private.mfa_satisfied())
  order by hit.position;
$function$;

revoke all on function public.search_member_cases(text, integer) from public, anon, service_role;
grant execute on function public.search_member_cases(text, integer) to authenticated;

comment on function public.search_member_cases(text, integer) is
  'Case search hits for the caller: reference, the row name (neutral type and step line unless a chapter or steward switch shows the topic, #7043), status, step, due date, rank and which field matched. Articles and matched text stay in the case record (#7015).';

commit;
