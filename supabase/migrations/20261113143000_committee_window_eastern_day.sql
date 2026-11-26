-- BUG-UG-FUNCTIONS-AND-DATE-DEFAULTS-READ-THE-UTC-DAY-20261112 (#8568), part A of four:
-- the committee window, read on the Eastern day.
--
-- A committee's starts_on and ends_on are calendar days a person set. Eighteen
-- security-definer readers compared them with current_date, the session's day,
-- and the hosted projects run in UTC: from 7 PM Eastern (8 PM in daylight
-- time) a committee that starts tomorrow already counted as open, and one
-- that ended today no longer did. They decide who reaches a committee's
-- members, notices, records and documents, so they move together, as the
-- utc-day reasons 20261113124000 left in five of them said they would. Each
-- now reads private.eastern_day() (20261113122500_eastern_day_helper.sql),
-- written (select private.eastern_day()) so it is read once per query, not
-- once per row. Nothing else in any body changes; those utc-day comments go.
-- Functions:
--   private.actor_role_covers_member
--   private.chapter_notice_scope_allowed
--   private.chapter_office_role_present
--   private.chapter_officer_can_for_scope
--   private.chapter_record_manageable
--   private.chapter_records_member_allowed
--   private.chapter_role_scope_expired
--   private.chapter_scope_member_allowed
--   private.chapter_scope_recipient_allowed
--   private.chapter_scoped_member_ids
--   private.chapter_scoped_role_allows
--   private.draft_steward_covers_member
--   private.member_scoped_notice_in_audience
--   private.unit_staff_member_capability_allows
--   public.get_broadcast_read_counts
--   public.get_broadcast_read_counts_for
--   public.get_chapter_office_access
--   public.get_organization_analytics_workspace
-- The chapter_committees.starts_on default moves to the Eastern day as well,
-- inline like the member_workload_logs.logged_on and
-- member_case_updates.occurred_on defaults: a column default runs as the
-- inserting role, and private.eastern_day() is executable by no API role.
-- Grants are unchanged (create or replace keeps them). A predecessor guard
-- refuses to run unless every live body is the reviewed one.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

do $preflight$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.actor_role_covers_member(uuid,text,text,uuid,boolean)'::regprocedure)
    is distinct from '81a55f01ab6066e2ec44ea99c520d1f1' then
    raise exception 'unreviewed predecessor: private.actor_role_covers_member' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.chapter_notice_scope_allowed(text,uuid,uuid)'::regprocedure)
    is distinct from 'abc24e7ee3ce5c4e185783fbf9189d77' then
    raise exception 'unreviewed predecessor: private.chapter_notice_scope_allowed' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.chapter_office_role_present(text,text)'::regprocedure)
    is distinct from '10781f1004d4db74a888ad2ffda809f4' then
    raise exception 'unreviewed predecessor: private.chapter_office_role_present' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.chapter_officer_can_for_scope(text,text,uuid,uuid)'::regprocedure)
    is distinct from 'e86299b1c64d16aca01ea9e95df9b9a3' then
    raise exception 'unreviewed predecessor: private.chapter_officer_can_for_scope' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.chapter_record_manageable(text,uuid,uuid)'::regprocedure)
    is distinct from 'de3d69aea46a98430abc4a3d8c3749c4' then
    raise exception 'unreviewed predecessor: private.chapter_record_manageable' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.chapter_records_member_allowed(text,uuid)'::regprocedure)
    is distinct from '041335413b6b1d950ae8272d51738ffa' then
    raise exception 'unreviewed predecessor: private.chapter_records_member_allowed' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.chapter_role_scope_expired(uuid,text,text)'::regprocedure)
    is distinct from '0baf816abe27fe822c26fb6b5d8db234' then
    raise exception 'unreviewed predecessor: private.chapter_role_scope_expired' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.chapter_scope_member_allowed(text,uuid,uuid,uuid)'::regprocedure)
    is distinct from '26c9deac575e860c27835648b90e676a' then
    raise exception 'unreviewed predecessor: private.chapter_scope_member_allowed' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.chapter_scope_recipient_allowed(text,uuid,uuid,uuid)'::regprocedure)
    is distinct from '4acbf2ac3ec926db6af918ad62309c7b' then
    raise exception 'unreviewed predecessor: private.chapter_scope_recipient_allowed' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.chapter_scoped_member_ids(text)'::regprocedure)
    is distinct from '64da2573fb7e3b8168c01c7379fa0970' then
    raise exception 'unreviewed predecessor: private.chapter_scoped_member_ids' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.chapter_scoped_role_allows(text,text,uuid,boolean)'::regprocedure)
    is distinct from '5da174f5f4cc0fbae5072efd485776f0' then
    raise exception 'unreviewed predecessor: private.chapter_scoped_role_allows' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.draft_steward_covers_member(uuid,uuid,text)'::regprocedure)
    is distinct from 'd3ab819b4f9594bf29f330a77421a44b' then
    raise exception 'unreviewed predecessor: private.draft_steward_covers_member' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.member_scoped_notice_in_audience(uuid,public.member_broadcasts)'::regprocedure)
    is distinct from 'a590d2eedb21ad750b1c58bcbd839576' then
    raise exception 'unreviewed predecessor: private.member_scoped_notice_in_audience' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.unit_staff_member_capability_allows(text,uuid,text)'::regprocedure)
    is distinct from 'a22b1ac3895e9f47678af7c104e76ac4' then
    raise exception 'unreviewed predecessor: private.unit_staff_member_capability_allows' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_broadcast_read_counts()'::regprocedure)
    is distinct from 'cc3216f88731d93e4ea27a54390b76c3' then
    raise exception 'unreviewed predecessor: public.get_broadcast_read_counts' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_broadcast_read_counts_for(text[])'::regprocedure)
    is distinct from 'f80923d72ab5cd66a8e8b37467bab7ae' then
    raise exception 'unreviewed predecessor: public.get_broadcast_read_counts_for' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_chapter_office_access()'::regprocedure)
    is distinct from '4b02d38bfe4e341a38b4a31276f58308' then
    raise exception 'unreviewed predecessor: public.get_chapter_office_access' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_organization_analytics_workspace()'::regprocedure)
    is distinct from '21a01592955f981bfa0adfe91e634546' then
    raise exception 'unreviewed predecessor: public.get_organization_analytics_workspace' using errcode='55000';
  end if;
end
$preflight$;

CREATE OR REPLACE FUNCTION private.actor_role_covers_member(p_actor uuid, p_chapter text, p_role text, p_target uuid, p_grievance boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select exists(select 1 from public.chapters c
    join public.organizations organization on organization.id=c.organization_id and organization.status='active'
    join public.organization_memberships actor_org on actor_org.organization_id=c.organization_id and actor_org.user_id=p_actor and actor_org.status='active'
    left join public.organization_memberships target_org on target_org.organization_id=c.organization_id and target_org.user_id=p_target and target_org.status='active'
    left join public.member_chapter_memberships target on target.chapter_id=c.id and target.user_id=p_target and target.status='active'
    where c.id=p_chapter
      and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor(p_actor))
      and (p_target is null or (target_org.user_id is not null and target.user_id is not null)) and (
      exists(select 1 from public.organization_role_grants r where r.organization_id=c.organization_id and r.user_id=p_actor and r.role=p_role and (p_role<>'steward' or private.organization_steward_scope_allows(p_actor,c.id,p_target)))
      or exists(select 1 from public.member_role_chapters r
        join public.member_chapter_memberships actor on actor.user_id=r.user_id and actor.chapter_id=r.chapter_id and actor.status='active'
        left join (select * from private.steward_assignment_scopes(p_actor,null) where not legacy_chapter_coverage) scope on scope.user_id=r.user_id and scope.chapter_id=r.chapter_id and scope.role=r.role
        where r.user_id=p_actor and r.chapter_id=c.id and r.role=p_role and (
          scope.user_id is null
          or private.chapter_unit_has_member(scope.unit_id,c.id,p_target)
          or exists(select 1 from private.chapter_committees committee
            join private.chapter_committee_members m on m.committee_id=committee.id and m.chapter_id=committee.chapter_id
            where committee.id=scope.committee_id and committee.chapter_id=c.id and m.user_id=p_target
              and committee.starts_on<=(select private.eastern_day()) and (committee.ends_on is null or committee.ends_on>=(select private.eastern_day()))
              and (not p_grievance or committee.grievance_access))))))
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.chapter_notice_scope_allowed(p_chapter text, p_unit uuid, p_committee uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select auth.uid()) is not null
    and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and not (p_unit is not null and p_committee is not null)
    and exists (
      select 1 from public.chapters chapter
      where chapter.id=p_chapter
        and chapter.organization_id=private.current_member_organization()
        and private.is_organization_member(chapter.organization_id)
        and (p_unit is null or exists (
          select 1 from private.chapter_units unit
          where unit.id=p_unit and unit.chapter_id=p_chapter))
        and (p_committee is null or exists (
          select 1 from private.chapter_committees committee
          where committee.id=p_committee and committee.chapter_id=p_chapter
            and committee.starts_on<=(select private.eastern_day())
            and (committee.ends_on is null or committee.ends_on>=(select private.eastern_day()))))
        and (
          private.chapter_access_leadership(p_chapter)
          or (
            private.chapter_office_role_present(p_chapter,'notices')
            and exists (
              select 1 from public.member_role_chapters grant_row
              join private.chapter_role_capabilities capability
                on capability.role=grant_row.role and capability.capability='notices'
              left join private.chapter_role_settings setting
                on setting.chapter_id=grant_row.chapter_id and setting.role=grant_row.role
               and setting.capability='notices'
              where grant_row.user_id=(select auth.uid()) and grant_row.chapter_id=p_chapter
                and coalesce(setting.enabled,true)
                -- #7667: in a unit, that unit's delegated notices switch narrows the role.
                and private.unit_capability_enabled(p_chapter,p_unit,grant_row.role,'notices')
                -- a project decision: only steward offices require
                -- a container; an unscoped enabled office keeps Main's reach.
                and (grant_row.role<>'steward' or p_unit is not null or p_committee is not null)
                and (
                  exists (
                    select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) scope
                    where scope.user_id=grant_row.user_id and scope.chapter_id=grant_row.chapter_id
                      and scope.role=grant_row.role
                      and ((p_unit is not null and scope.unit_id=p_unit)
                        or (p_committee is not null and scope.committee_id=p_committee)))
                  or (grant_row.role<>'steward' and not exists (
                    select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) scope
                    where scope.user_id=grant_row.user_id and scope.chapter_id=grant_row.chapter_id
                      and scope.role=grant_row.role))
                )
            )
          )
          -- #7664: an organization steward grant reaches only the unit it is
          -- assigned to in this chapter, under the chapter's steward notices
          -- setting, never the whole chapter or organization.
          or (
            p_unit is not null and p_committee is null
            and private.has_organization_role(chapter.organization_id,array['steward'])
            and exists (
              select 1 from private.organization_steward_unit_assignments assignment
              join private.chapter_role_capabilities capability
                on capability.role=assignment.role and capability.capability='notices'
              left join private.chapter_role_settings setting
                on setting.chapter_id=assignment.chapter_id and setting.role=assignment.role
               and setting.capability='notices'
              where assignment.user_id=(select auth.uid()) and assignment.chapter_id=p_chapter
                and assignment.organization_id=chapter.organization_id and assignment.unit_id=p_unit
                and coalesce(setting.enabled,true)
                and private.unit_capability_enabled(p_chapter,p_unit,assignment.role,'notices')
            )
          )
        )
    );
$function$;

CREATE OR REPLACE FUNCTION private.chapter_office_role_present(p_chapter text, p_capability text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select private.chapter_officer_can(p_chapter,p_capability) or (
    (select auth.uid()) is not null and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and exists(select 1 from public.chapters c
      join public.member_chapter_memberships m on m.chapter_id=c.id and m.user_id=(select auth.uid()) and m.status='active'
      join public.organization_memberships om on om.organization_id=c.organization_id and om.user_id=m.user_id and om.status='active'
      join public.member_role_chapters r on r.user_id=m.user_id and r.chapter_id=m.chapter_id
      join private.chapter_role_scopes scope on scope.user_id=r.user_id and scope.chapter_id=r.chapter_id and scope.role=r.role
      left join private.chapter_committees committee on committee.id=scope.committee_id and committee.chapter_id=scope.chapter_id
      join private.chapter_role_capabilities cap on cap.role=r.role and cap.capability=p_capability
      left join private.chapter_role_settings setting on setting.chapter_id=c.id and setting.role=r.role and setting.capability=cap.capability
      where c.id=p_chapter and c.organization_id=private.current_member_organization()
        and coalesce(setting.enabled,true)
        and (scope.unit_id is not null or (committee.starts_on<=(select private.eastern_day()) and (committee.ends_on is null or committee.ends_on>=(select private.eastern_day()))))
        and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor((select auth.uid())))));
$function$;

CREATE OR REPLACE FUNCTION private.chapter_officer_can_for_scope(p_chapter text, p_capability text, p_unit uuid, p_committee uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(((p_unit is null or (p_committee is null
      and exists(select 1 from private.chapter_units u where u.id=p_unit and u.chapter_id=p_chapter)))
    and (
      (private.chapter_officer_can(p_chapter,p_capability) and (
        p_unit is null or private.has_organization_role(private.current_member_organization(),array['admin'])
        or private.member_has_chapter_role(p_chapter,array['admin','vp'])
        or exists(select 1 from private.chapter_role_capabilities cap
          join public.member_role_chapters r on r.role=cap.role and r.chapter_id=p_chapter and r.user_id=auth.uid()
          where cap.capability=p_capability
            and private.effective_unit_settings(p_chapter,p_unit)->'capabilities'->(cap.role||':'||p_capability)='true'::jsonb
            and not exists(select 1 from private.steward_assignment_scopes(auth.uid(),p_chapter) s where s.user_id=r.user_id and s.chapter_id=r.chapter_id and s.role=r.role))))
      or (private.chapter_office_role_present(p_chapter,p_capability)
        and exists(select 1 from private.chapter_role_scopes scope
          join private.chapter_role_capabilities cap on cap.role=scope.role and cap.capability=p_capability
          left join private.chapter_role_settings setting on setting.chapter_id=scope.chapter_id and setting.role=cap.role and setting.capability=cap.capability
          where scope.user_id=auth.uid() and scope.chapter_id=p_chapter and coalesce(setting.enabled,true)
            and ((p_unit is not null and scope.unit_id=p_unit
              and private.effective_unit_settings(p_chapter,p_unit)->'capabilities'->(cap.role||':'||p_capability)='true'::jsonb)
              or (p_committee is not null and p_unit is null and scope.committee_id=p_committee and exists(
                select 1 from private.chapter_committees c where c.id=p_committee and c.chapter_id=p_chapter
                  and c.starts_on<=(select private.eastern_day()) and (c.ends_on is null or c.ends_on>=(select private.eastern_day()))))))))),false);
$function$;

CREATE OR REPLACE FUNCTION private.chapter_record_manageable(p_chapter text, p_unit uuid, p_committee uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (private.member_has_chapter_role(p_chapter,array['steward','coordinator','advisor','admin','vp'])
      and private.unit_staff_capability_allows(p_chapter,p_unit,'records'))
    or exists (
      select 1 from private.chapter_role_capabilities capability
      left join private.chapter_role_settings setting on setting.chapter_id=p_chapter
        and setting.role=capability.role and setting.capability=capability.capability
      where capability.capability='records'
        and capability.role=any(array['steward','coordinator','advisor','admin','vp'])
        and coalesce(setting.enabled,true)
        and private.member_has_chapter_staff_grant(p_chapter,array[capability.role])
      and (
        (p_unit is null and p_committee is null)
        or exists (
          select 1 from (select * from private.steward_assignment_scopes((select auth.uid()),null) where not legacy_chapter_coverage) scope
          left join private.chapter_committees committee on committee.id = scope.committee_id
          where scope.user_id = (select auth.uid()) and scope.chapter_id = p_chapter
            and scope.role=capability.role
            and (
              (p_unit is not null and p_committee is null and scope.unit_id = p_unit
                and private.unit_capability_enabled(p_chapter,p_unit,capability.role,'records'))
              or (p_unit is null and p_committee is not null and scope.committee_id = p_committee
                and (committee.starts_on is null or committee.starts_on <= (select private.eastern_day()))
                and (committee.ends_on is null or committee.ends_on >= (select private.eastern_day())))
            )
        )
      )
    )
    or private.chapter_officer_can_for_scope(p_chapter,'records',p_unit,p_committee);
$function$;

CREATE OR REPLACE FUNCTION private.chapter_records_member_allowed(p_chapter text, p_target uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p_target is not null and (select private.mfa_satisfied())
    and (
      (private.chapter_staff_member_allowed(
        p_chapter, p_target, array['steward','coordinator','advisor','admin','vp'])
        and private.unit_staff_member_capability_allows(p_chapter, p_target, 'records'))
      or exists (
        select 1 from private.chapter_role_capabilities capability
        left join private.chapter_role_settings setting
          on setting.chapter_id = p_chapter and setting.role = capability.role
         and setting.capability = capability.capability
        where capability.capability = 'records' and coalesce(setting.enabled, true)
          and private.actor_role_covers_member(
            (select auth.uid()), p_chapter, capability.role, p_target, false)
          -- Coverage that comes only through units whose settings turn
          -- records off for this role does not count (#7667).
          and (not exists (select 1 from private.steward_assignment_scopes((select auth.uid()), p_chapter) scope
                where scope.role = capability.role and scope.unit_id is not null and not scope.legacy_chapter_coverage
                  and not private.unit_capability_enabled(p_chapter, scope.unit_id, capability.role, 'records'))
            or exists (select 1 from private.steward_assignment_scopes((select auth.uid()), p_chapter) scope
                where scope.role = capability.role and not scope.legacy_chapter_coverage
                  and ((scope.unit_id is null and exists (select 1 from private.chapter_committees committee
                      join private.chapter_committee_members m on m.committee_id = committee.id and m.chapter_id = committee.chapter_id
                      where committee.id = scope.committee_id and committee.chapter_id = p_chapter and m.user_id = p_target
                        and committee.starts_on <= (select private.eastern_day()) and (committee.ends_on is null or committee.ends_on >= (select private.eastern_day()))))
                    or (scope.unit_id is not null and private.chapter_unit_has_member(scope.unit_id, p_chapter, p_target)
                      and private.unit_capability_enabled(p_chapter, scope.unit_id, capability.role, 'records')))))
      )
    );
$function$;

CREATE OR REPLACE FUNCTION private.chapter_role_scope_expired(p_user uuid, p_chapter text, p_role text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from private.chapter_role_scopes scope
    join private.chapter_committees committee
      on committee.id = scope.committee_id and committee.chapter_id = scope.chapter_id
    where scope.user_id = p_user and scope.chapter_id = p_chapter and scope.role = p_role
      and not (committee.starts_on <= (select private.eastern_day()) and (committee.ends_on is null or committee.ends_on >= (select private.eastern_day())))
  );
$function$;

CREATE OR REPLACE FUNCTION private.chapter_scope_member_allowed(p_chapter text, p_unit uuid, p_committee uuid, p_member uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists(select 1 from public.member_chapter_memberships member
    join public.chapters c on c.id=member.chapter_id and c.organization_id=private.current_member_organization()
    join public.organization_memberships om on om.organization_id=c.organization_id and om.user_id=member.user_id and om.status='active'
    where member.user_id=p_member and member.chapter_id=p_chapter and member.status='active' and (
      (p_unit is null and p_committee is null)
      or private.chapter_unit_has_member(p_unit,p_chapter,p_member)
      or exists(select 1 from private.chapter_committees committee
        join private.chapter_committee_members m on m.committee_id=committee.id and m.chapter_id=committee.chapter_id
        where committee.id=p_committee and committee.chapter_id=p_chapter and m.user_id=p_member
          and committee.starts_on<=(select private.eastern_day()) and (committee.ends_on is null or committee.ends_on>=(select private.eastern_day())))));
$function$;

CREATE OR REPLACE FUNCTION private.chapter_scope_recipient_allowed(p_chapter text, p_unit uuid, p_committee uuid, p_member uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists(select 1 from public.member_chapter_memberships member
    join public.chapters c on c.id=member.chapter_id
    join public.organizations o on o.id=c.organization_id and o.status='active'
    join public.organization_memberships om on om.organization_id=c.organization_id and om.user_id=member.user_id and om.status='active'
    where member.user_id=p_member and member.chapter_id=p_chapter and member.status='active' and (
      (p_unit is null and p_committee is null)
      or private.chapter_unit_has_member(p_unit,p_chapter,p_member)
      or exists(select 1 from private.chapter_committees committee
        join private.chapter_committee_members m on m.committee_id=committee.id and m.chapter_id=committee.chapter_id
        where committee.id=p_committee and committee.chapter_id=p_chapter and m.user_id=p_member
          and committee.starts_on<=(select private.eastern_day()) and (committee.ends_on is null or committee.ends_on>=(select private.eastern_day())))));
$function$;

CREATE OR REPLACE FUNCTION private.chapter_scoped_member_ids(p_role text)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- Relational equivalent of the enumeration filtered by
  -- chapter_scoped_role_allows(chapter_id,p_role,user_id,false). Keep the
  -- enumeration and qualifying scopes independent: EXISTS may authorize a
  -- candidate through another matching assignment. Caller/scope gates are
  -- evaluated once, with every target-side membership and container gate
  -- retained below. The scalar helper remains the differential-test oracle.
  with caller as materialized (
    select (select auth.uid()) uid,
      (select private.current_member_organization()) organization_id,
      (select private.mfa_satisfied()) mfa_satisfied,
      (select private.member_pin_session_restricted()) pin_restricted
  ), scopes as materialized (
    select scope.* from caller
    cross join lateral private.steward_assignment_scopes(caller.uid,null) scope
    where scope.user_id=caller.uid and scope.role=p_role
  ), eligible_scopes as materialized (
    select scope.*,chapter.organization_id
    from scopes scope
    cross join caller
    join public.chapters chapter on chapter.id=scope.chapter_id
      and chapter.organization_id=caller.organization_id
    join public.organization_memberships actor_org on actor_org.user_id=scope.user_id
      and actor_org.organization_id=chapter.organization_id and actor_org.status='active'
    where caller.uid is not null and caller.mfa_satisfied and not caller.pin_restricted
      and (exists(select 1 from public.member_chapter_memberships actor
        where actor.user_id=scope.user_id and actor.chapter_id=scope.chapter_id and actor.status='active')
        or (p_role='steward' and exists(select 1 from public.organization_role_grants grant_row
          where grant_row.organization_id=chapter.organization_id and grant_row.user_id=scope.user_id
            and grant_row.role='steward')))
      and (not private.staff_mfa_required(chapter.organization_id)
        or (select private.has_second_factor((select auth.uid()))))
  ), covered as (
    -- One pass over the active memberships of the eligible scopes' chapters,
    -- with each scope's coverage tested inline: chapter_unit_has_member's and
    -- the committee arm's exact predicates, without a per-candidate call.
    select membership.user_id,scope.organization_id
    from eligible_scopes scope
    join public.member_chapter_memberships membership on membership.chapter_id=scope.chapter_id and membership.status='active'
    where scope.role=p_role and (scope.legacy_chapter_coverage
      or (scope.unit_id is not null and (
        exists(select 1 from private.chapter_unit_members physical
          where physical.unit_id=scope.unit_id and physical.chapter_id=scope.chapter_id and physical.user_id=membership.user_id)
        or (exists(select 1 from private.chapter_units unit
            where unit.id=scope.unit_id and unit.chapter_id=scope.chapter_id and unit.is_default)
          and not exists(select 1 from private.chapter_unit_members physical
            where physical.user_id=membership.user_id and physical.chapter_id=scope.chapter_id))))
      or (scope.committee_id is not null and exists (
        select 1 from private.chapter_committees committee
        join private.chapter_committee_members member on member.committee_id=committee.id
          and member.chapter_id=committee.chapter_id
        where committee.id=scope.committee_id and committee.chapter_id=scope.chapter_id
          and member.user_id=membership.user_id and committee.starts_on<=(select private.eastern_day())
          and (committee.ends_on is null or committee.ends_on>=(select private.eastern_day())))))
  ), organization_members as (
    select target_org.user_id from public.organization_memberships target_org
    where target_org.organization_id=(select caller.organization_id from caller) and target_org.status='active'
  ), organization_profiles as (
    select target_profile.id from public.member_profiles target_profile
    join public.chapters target_context on target_context.id=target_profile.chapter_id
    where target_context.organization_id=(select caller.organization_id from caller)
  )
  select distinct covered.user_id
  from covered
  where covered.user_id in (select user_id from organization_members)
    and covered.user_id in (select id from organization_profiles);
$function$;

CREATE OR REPLACE FUNCTION private.chapter_scoped_role_allows(p_chapter text, p_role text, p_target uuid, p_grievance boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select auth.uid()) is not null and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and exists (
      select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s
      join public.chapters c on c.id=s.chapter_id and c.organization_id=private.current_member_organization()
      join public.member_profiles target_profile on target_profile.id=p_target
      join public.chapters target_context on target_context.id=target_profile.chapter_id and target_context.organization_id=c.organization_id
      left join public.member_chapter_memberships actor on actor.user_id=s.user_id and actor.chapter_id=s.chapter_id and actor.status='active'
      join public.member_chapter_memberships target on target.user_id=p_target and target.chapter_id=s.chapter_id and target.status='active'
      join public.organization_memberships ao on ao.user_id=s.user_id and ao.organization_id=c.organization_id and ao.status='active'
      join public.organization_memberships mo on mo.user_id=p_target and mo.organization_id=c.organization_id and mo.status='active'
      where s.user_id=(select auth.uid()) and s.chapter_id=p_chapter and s.role=p_role
        and (actor.user_id is not null or (p_role='steward' and exists(select 1 from public.organization_role_grants grant_row where grant_row.organization_id=c.organization_id and grant_row.user_id=s.user_id and grant_row.role='steward')))
        and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor((select auth.uid())))
        and (
          s.legacy_chapter_coverage or (s.unit_id is not null and private.chapter_unit_has_member(s.unit_id,s.chapter_id,p_target))
          or (s.committee_id is not null and exists (
            select 1 from private.chapter_committees cm
            join private.chapter_committee_members member on member.committee_id=cm.id and member.chapter_id=cm.chapter_id
            where cm.id=s.committee_id and cm.chapter_id=s.chapter_id and member.user_id=p_target
              and cm.starts_on<=(select private.eastern_day()) and (cm.ends_on is null or cm.ends_on>=(select private.eastern_day()))
              and (not p_grievance or cm.grievance_access)
          ))
        )
    );
$function$;

CREATE OR REPLACE FUNCTION private.draft_steward_covers_member(p_steward uuid, p_owner uuid, p_chapter text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists(select 1 from public.chapters c
    join public.member_chapter_memberships recipient on recipient.chapter_id=c.id and recipient.user_id=p_steward and recipient.status='active'
    join public.member_chapter_memberships owner_member on owner_member.chapter_id=c.id and owner_member.user_id=p_owner and owner_member.status='active'
    join public.organization_memberships recipient_org on recipient_org.organization_id=c.organization_id and recipient_org.user_id=p_steward and recipient_org.status='active'
    join public.organization_memberships owner_org on owner_org.organization_id=c.organization_id and owner_org.user_id=p_owner and owner_org.status='active'
    where c.id=p_chapter and c.organization_id=private.current_member_organization()
      and (private.organization_steward_scope_allows(p_steward,c.id,p_owner)
        or exists(select 1 from public.member_role_chapters r
          left join (select * from private.steward_assignment_scopes(p_steward,null) where not legacy_chapter_coverage) s on s.user_id=r.user_id and s.chapter_id=r.chapter_id and s.role=r.role
          where r.user_id=p_steward and r.chapter_id=c.id and r.role='steward'
            and (s.user_id is null
              or (s.unit_id is not null and private.chapter_unit_has_member(s.unit_id,c.id,p_owner))
              or (s.committee_id is not null and exists(select 1 from private.chapter_committees committee
                join private.chapter_committee_members m on m.committee_id=committee.id and m.chapter_id=committee.chapter_id
                where committee.id=s.committee_id and committee.starts_on<=(select private.eastern_day()) and (committee.ends_on is null or committee.ends_on>=(select private.eastern_day())) and m.user_id=p_owner))))));
$function$;

CREATE OR REPLACE FUNCTION private.member_scoped_notice_in_audience(p_user uuid, p_notice public.member_broadcasts)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select private.member_notice_in_audience(p_user,p_notice.organization_id,p_notice.chapter_id,p_notice.audience_scope)
    and ((p_notice.access_unit_id is null and p_notice.access_committee_id is null)
      or private.chapter_unit_has_member(p_notice.access_unit_id,p_notice.chapter_id,p_user)
      or exists(select 1 from private.chapter_committees c join private.chapter_committee_members m on m.committee_id=c.id and m.chapter_id=c.chapter_id
        where c.id=p_notice.access_committee_id and c.chapter_id=p_notice.chapter_id and m.user_id=p_user and c.starts_on<=(select private.eastern_day()) and (c.ends_on is null or c.ends_on>=(select private.eastern_day()))));
$function$;

CREATE OR REPLACE FUNCTION private.unit_staff_member_capability_allows(p_chapter text, p_target uuid, p_capability text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select private.unit_settings_held()
    or not exists(select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s
      where s.unit_id is not null and not s.legacy_chapter_coverage)
    or exists(select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s
      join private.chapter_role_capabilities cap on cap.role=s.role and cap.capability=p_capability
      left join private.chapter_role_settings setting on setting.chapter_id=p_chapter
        and setting.role=cap.role and setting.capability=cap.capability
      where s.unit_id is not null and not s.legacy_chapter_coverage and coalesce(setting.enabled,true)
        and private.chapter_unit_has_member(s.unit_id,p_chapter,p_target)
        and private.unit_capability_enabled(p_chapter,s.unit_id,s.role,p_capability))
    or exists(select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s
      join private.chapter_role_capabilities cap on cap.role=s.role and cap.capability=p_capability
      left join private.chapter_role_settings setting on setting.chapter_id=p_chapter
        and setting.role=cap.role and setting.capability=cap.capability
      join private.chapter_committees committee on committee.id=s.committee_id and committee.chapter_id=p_chapter
      join private.chapter_committee_members cm on cm.committee_id=committee.id and cm.chapter_id=committee.chapter_id
      where s.unit_id is null and cm.user_id=p_target and coalesce(setting.enabled,true)
        and committee.starts_on<=(select private.eastern_day()) and (committee.ends_on is null or committee.ends_on>=(select private.eastern_day())))
    or private.member_has_chapter_role(p_chapter,array['coordinator','advisor','admin','vp'])
    or exists(select 1 from public.member_role_chapters r
      join public.member_chapter_memberships m on m.user_id=r.user_id and m.chapter_id=r.chapter_id and m.status='active'
      where r.user_id=(select auth.uid()) and r.chapter_id=p_chapter and r.role='steward'
        and not exists(select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s
          where s.role='steward' and not s.legacy_chapter_coverage));
$function$;

CREATE OR REPLACE FUNCTION public.get_broadcast_read_counts()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  result jsonb;
  publisher_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null
     or not (private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp']) or private.chapter_office_role_present(private.current_member_chapter(),'notices') or exists(select 1 from private.organization_steward_unit_assignments notice_assignment where notice_assignment.user_id=(select auth.uid()) and notice_assignment.chapter_id=private.current_member_chapter() and private.chapter_notice_scope_allowed(private.current_member_chapter(),notice_assignment.unit_id,null))) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if publisher_org is null then
    return '[]'::jsonb;
  end if;

  with candidate as materialized (
    -- Candidates from the selected organization; the audience gate
    -- follows the cached publisher decisions below.
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id, b.created_by
    from public.member_broadcasts b
    where b.organization_id = publisher_org

  ),
  publisher_scope as materialized (
    -- The chapter publisher checks once per chapter, unit and committee.
    select s.chapter_id, s.access_unit_id, s.access_committee_id,
      private.chapter_notice_scope_allowed(s.chapter_id,s.access_unit_id,s.access_committee_id) as allowed
    from (
      select distinct candidate.chapter_id, candidate.access_unit_id, candidate.access_committee_id
      from candidate
      where candidate.audience_scope = 'chapter'
    ) s
  ),
  organization_publisher as materialized (
    select private.has_organization_role(publisher_org,array['admin','vp']) as allowed
  ),
  readable as materialized (
    -- Membership readers and the author with current publisher authority.
    -- The latter may serve a unit without belonging to its member audience.
    -- Both publisher decisions are cached by distinct scope, never per row.
    select b.* from candidate b
    left join publisher_scope s
      on b.audience_scope='chapter' and s.chapter_id=b.chapter_id
     and s.access_unit_id is not distinct from b.access_unit_id
     and s.access_committee_id is not distinct from b.access_committee_id
    cross join organization_publisher o
    where b.id in (select private.visible_member_broadcast_ids())
       or (b.created_by is not null and b.created_by=(select auth.uid())
         and ((b.audience_scope='chapter' and s.allowed)
           or (b.audience_scope='organization' and o.allowed)))
  ),
  recent as materialized (
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id
    from readable b
    left join publisher_scope s
      on b.audience_scope = 'chapter'
     and s.chapter_id = b.chapter_id
     and s.access_unit_id is not distinct from b.access_unit_id
     and s.access_committee_id is not distinct from b.access_committee_id
    cross join organization_publisher o
    where (b.audience_scope = 'chapter' and s.allowed) or (b.audience_scope = 'organization' and o.allowed)
    order by b.published_at desc
    limit 20
  ),
  reads as (
    -- Receipts from readers still in the notice's audience: the predicate of
    -- private.member_scoped_notice_in_audience, counted in one pass.
    select b.id, pg_catalog.count(*) as read_count
    from recent b
    join public.member_broadcast_receipts r on r.broadcast_id = b.id
    where exists (
        select 1
        from public.organization_memberships om
        where om.user_id = r.user_id
          and om.organization_id = publisher_org
          and om.status = 'active'
      )
      and (
        b.audience_scope = 'organization'
        or exists (
          select 1
          from public.member_chapter_memberships m
          where m.user_id = r.user_id
            and m.chapter_id = b.chapter_id
            and m.status = 'active'
        )
      )
      and (
        (b.access_unit_id is null and b.access_committee_id is null)
        or (exists (
          select 1
          from private.chapter_unit_members m
          where m.unit_id = b.access_unit_id
            and m.chapter_id = b.chapter_id
            and m.user_id = r.user_id
        ) or exists(select 1 from private.chapter_units default_unit where default_unit.id=b.access_unit_id and default_unit.chapter_id=b.chapter_id and default_unit.is_default and not exists(select 1 from private.chapter_unit_members physical_unit_member where physical_unit_member.chapter_id=b.chapter_id and physical_unit_member.user_id=r.user_id)))
        or exists (
          select 1
          from private.chapter_committees c
          join private.chapter_committee_members m on m.committee_id = c.id and m.chapter_id = c.chapter_id
          where c.id = b.access_committee_id
            and c.chapter_id = b.chapter_id
            and m.user_id = r.user_id
            and c.starts_on <= (select private.eastern_day())
            and (c.ends_on is null or c.ends_on >= (select private.eastern_day()))
        )
      )
    group by b.id
  )
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', recent.id,
      'readCount', coalesce(reads.read_count, 0)
    ) order by recent.published_at desc
  ), '[]'::jsonb)
  into result
  from recent
  left join reads on reads.id = recent.id;

  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_broadcast_read_counts_for(p_broadcast_ids text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  result jsonb;
  publisher_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null
     or not (private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp']) or private.chapter_office_role_present(private.current_member_chapter(),'notices') or exists(select 1 from private.organization_steward_unit_assignments notice_assignment where notice_assignment.user_id=(select auth.uid()) and notice_assignment.chapter_id=private.current_member_chapter() and private.chapter_notice_scope_allowed(private.current_member_chapter(),notice_assignment.unit_id,null))) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_broadcast_ids is null
     or pg_catalog.cardinality(p_broadcast_ids) < 1
     or pg_catalog.cardinality(p_broadcast_ids) > 100 then
    raise exception 'between 1 and 100 broadcast ids' using errcode = '22023';
  end if;
  if publisher_org is null then
    return '[]'::jsonb;
  end if;

  with candidate as materialized (
    -- Candidates among the requested ids in the selected organization;
    -- the audience gate follows the cached publisher decisions below.
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id, b.created_by
    from public.member_broadcasts b
    where b.id = any(p_broadcast_ids)
      and b.organization_id = publisher_org

  ),
  publisher_scope as materialized (
    -- The chapter publisher checks once per chapter, unit and committee.
    select s.chapter_id, s.access_unit_id, s.access_committee_id,
      private.chapter_notice_scope_allowed(s.chapter_id,s.access_unit_id,s.access_committee_id) as allowed
    from (
      select distinct candidate.chapter_id, candidate.access_unit_id, candidate.access_committee_id
      from candidate
      where candidate.audience_scope = 'chapter'
    ) s
  ),
  organization_publisher as materialized (
    select private.has_organization_role(publisher_org,array['admin','vp']) as allowed
  ),
  readable as materialized (
    -- Membership readers and the author with current publisher authority.
    -- The latter may serve a unit without belonging to its member audience.
    -- Both publisher decisions are cached by distinct scope, never per row.
    select b.* from candidate b
    left join publisher_scope s
      on b.audience_scope='chapter' and s.chapter_id=b.chapter_id
     and s.access_unit_id is not distinct from b.access_unit_id
     and s.access_committee_id is not distinct from b.access_committee_id
    cross join organization_publisher o
    where b.id in (select private.visible_member_broadcast_ids())
       or (b.created_by is not null and b.created_by=(select auth.uid())
         and ((b.audience_scope='chapter' and s.allowed)
           or (b.audience_scope='organization' and o.allowed)))
  ),
  asked as materialized (
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id
    from readable b
    left join publisher_scope s
      on b.audience_scope = 'chapter'
     and s.chapter_id = b.chapter_id
     and s.access_unit_id is not distinct from b.access_unit_id
     and s.access_committee_id is not distinct from b.access_committee_id
    cross join organization_publisher o
    where (b.audience_scope = 'chapter' and s.allowed) or (b.audience_scope = 'organization' and o.allowed)
  ),
  reads as (
    -- Receipts from readers still in the notice's audience: the predicate of
    -- private.member_scoped_notice_in_audience, counted in one pass.
    select b.id, pg_catalog.count(*) as read_count
    from asked b
    join public.member_broadcast_receipts r on r.broadcast_id = b.id
    where exists (
        select 1
        from public.organization_memberships om
        where om.user_id = r.user_id
          and om.organization_id = publisher_org
          and om.status = 'active'
      )
      and (
        b.audience_scope = 'organization'
        or exists (
          select 1
          from public.member_chapter_memberships m
          where m.user_id = r.user_id
            and m.chapter_id = b.chapter_id
            and m.status = 'active'
        )
      )
      and (
        (b.access_unit_id is null and b.access_committee_id is null)
        or (exists (
          select 1
          from private.chapter_unit_members m
          where m.unit_id = b.access_unit_id
            and m.chapter_id = b.chapter_id
            and m.user_id = r.user_id
        ) or exists(select 1 from private.chapter_units default_unit where default_unit.id=b.access_unit_id and default_unit.chapter_id=b.chapter_id and default_unit.is_default and not exists(select 1 from private.chapter_unit_members physical_unit_member where physical_unit_member.chapter_id=b.chapter_id and physical_unit_member.user_id=r.user_id)))
        or exists (
          select 1
          from private.chapter_committees c
          join private.chapter_committee_members m on m.committee_id = c.id and m.chapter_id = c.chapter_id
          where c.id = b.access_committee_id
            and c.chapter_id = b.chapter_id
            and m.user_id = r.user_id
            and c.starts_on <= (select private.eastern_day())
            and (c.ends_on is null or c.ends_on >= (select private.eastern_day()))
        )
      )
    group by b.id
  )
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', b.id,
      'readCount', coalesce(reads.read_count, 0)
    ) order by b.published_at desc
  ), '[]'::jsonb)
  into result
  from asked b
  left join reads on reads.id = b.id;

  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_chapter_office_access()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare chapter text:=private.current_member_chapter();
begin
  if chapter is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then raise exception 'chapter context required' using errcode='42501'; end if;
  return pg_catalog.jsonb_build_object('chapterId',chapter,
    'records',private.chapter_office_role_present(chapter,'records'),
    'documents',private.chapter_office_role_present(chapter,'documents'),
    'notices',(private.chapter_notice_scope_allowed(chapter,null,null) or exists (select 1 from private.steward_assignment_scopes((select auth.uid()),chapter) notice_scope where private.chapter_notice_scope_allowed(chapter,notice_scope.unit_id,notice_scope.committee_id))),
    'unscopedNotices',private.chapter_notice_scope_allowed(chapter,null,null),
    'unscopedRecords',private.chapter_officer_can(chapter,'records'),
    'unscopedDocuments',private.chapter_officer_can(chapter,'documents'),
    'scopes',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role',s.role,'unitId',s.unit_id,'committeeId',s.committee_id,'name',coalesce(u.name,c.name),
      'records',exists(select 1 from private.chapter_role_capabilities cap where cap.role=s.role and cap.capability='records' and not exists(select 1 from private.chapter_role_settings setting where setting.chapter_id=chapter and setting.role=s.role and setting.capability='records' and not setting.enabled)),
      'notices',exists(select 1 from private.chapter_role_capabilities cap where cap.role=s.role and cap.capability='notices' and not exists(select 1 from private.chapter_role_settings setting where setting.chapter_id=chapter and setting.role=s.role and setting.capability='notices' and not setting.enabled)),
      'documents',exists(select 1 from private.chapter_role_capabilities cap where cap.role=s.role and cap.capability='documents' and not exists(select 1 from private.chapter_role_settings setting where setting.chapter_id=chapter and setting.role=s.role and setting.capability='documents' and not setting.enabled))))
      from private.chapter_role_scopes s left join private.chapter_units u on u.id=s.unit_id left join private.chapter_committees c on c.id=s.committee_id
      where s.user_id=(select auth.uid()) and s.chapter_id=chapter
        and (s.committee_id is null or (c.starts_on<=(select private.eastern_day()) and (c.ends_on is null or c.ends_on>=(select private.eastern_day()))))),'[]'::jsonb)
      -- #7664: an organization steward's assigned unit is a notice audience
      -- only; it carries no chapter records or documents office.
      || coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role',a.role,'unitId',a.unit_id,'committeeId',null,'name',u.name,
        'records',false,'notices',private.chapter_notice_scope_allowed(chapter,a.unit_id,null),'documents',false))
      from private.organization_steward_unit_assignments a join private.chapter_units u on u.id=a.unit_id and u.chapter_id=a.chapter_id
      where a.user_id=(select auth.uid()) and a.chapter_id=chapter
        and private.has_organization_role(a.organization_id,array['steward'])),'[]'::jsonb));
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_organization_analytics_workspace()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph_read();
  perform private.member_pin_require_full_session();
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  privacy_threshold integer := private.organization_limit(org, 'limits.analytics.anonymity_floor');
  health_threshold integer := private.organization_limit(org, 'limits.analytics.chapter_health_cohort_floor');
  actor uuid := (select auth.uid());
  may_read_unassigned boolean;
  scoped_actor boolean;
  default_steward_chapters text[];
  org_case_reader boolean;
  staff_chapters text[];
  roster_limited boolean;
  roster_chapters text[];
begin
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if org is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Necessary candidate condition only, never an authorization result.
  -- Deliberately retain roles in ANY tenant/chapter (including inactive or
  -- otherwise unusable grants): false positives still reach the shared final
  -- predicate. All current organization, chapter and legacy role sources are
  -- included. Assignment is checked per case below.
  may_read_unassigned := exists (
    select 1 from public.organization_role_grants g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_role_chapters g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_roles g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  );

  -- Cached ordinary-steward authorization. The enclosing roster query
  -- already proves the target's active chapter and organization memberships.
  -- Scoped actors, private identities and legacy exceptions use the oracle.
  scoped_actor := exists(select 1 from (select * from private.steward_assignment_scopes(actor,null) where not legacy_chapter_coverage) scope where scope.user_id=actor);
  default_steward_chapters := array(
        select ch.id from public.chapters ch
        left join private.chapter_access_policies target_policy on target_policy.chapter_id=ch.id
        where ch.organization_id=org
          and coalesce(target_policy.steward_grievances,true)
          and (not private.staff_mfa_required(ch.organization_id) or private.has_second_factor(actor))
          and (private.chapter_organization_role_allowed(ch.id,array['steward'])
            or private.member_has_chapter_role(ch.id,array['steward'])
            or exists(select 1 from public.member_role_chapters r
              join public.chapters source on source.id=r.chapter_id and source.organization_id=ch.organization_id
              join public.member_chapter_memberships source_member on source_member.chapter_id=r.chapter_id and source_member.user_id=r.user_id and source_member.status='active'
              join private.chapter_access_policies policy on policy.chapter_id=r.chapter_id and policy.steward_breadth='local' and policy.steward_grievances
              where r.user_id=actor and r.role='steward' and private.member_has_chapter_role(r.chapter_id,array['steward'])))
      );

  -- BUG-UG-SAMPLE-ANALYTICS-PANELS-TIME-OUT-20261030: for an
  -- organization advisor, administrator or leader, every per-case clause of
  -- private.casework_staff_can_access except the chapter staff-role test is
  -- already met by that organization role, so the per-case call (about 16 ms
  -- each at Tamarack scale, one per active case) reduces to membership in
  -- the chapters where private.actor_has_chapter_staff_role holds. Both are
  -- read once here, after lock_case_graph_read, with the same helpers and
  -- arguments the shared predicate uses; every other caller keeps the shared
  -- predicate per case.
  -- Scoped access: the shortcut applies only to an unscoped actor and a case
  -- with no identity privacy, where private.case_scope_and_identity_allowed
  -- is already true; every other case keeps the read oracle below.
  org_case_reader := private.has_organization_role(org, array['advisor','admin','vp']);
  -- #8589 rounds 1-2: a caller admitted only by an organization steward
  -- grant sees named members only where an assignment covers them: whole
  -- chapters for steward carry-over and for live, unscoped chapter-level
  -- higher roles; otherwise the unit, default-unit or committee members of
  -- each scoped steward, coordinator or advisor assignment; and themselves.
  roster_limited := not private.has_organization_role(org, array['coordinator','advisor','admin','vp']);
  roster_chapters := array(
    select scope.chapter_id from private.steward_assignment_scopes(actor,null) scope
    where roster_limited and scope.role='steward' and scope.legacy_chapter_coverage
    union
    select grant_row.chapter_id from public.member_role_chapters grant_row
    join public.chapters chapter on chapter.id=grant_row.chapter_id and chapter.organization_id=org
    join public.member_chapter_memberships membership on membership.user_id=grant_row.user_id
      and membership.chapter_id=grant_row.chapter_id and membership.status='active'
    where roster_limited and grant_row.user_id=actor and grant_row.role=any(array['coordinator','advisor','admin','vp'])
      and not exists(select 1 from private.chapter_role_scopes scope
        where scope.user_id=grant_row.user_id and scope.chapter_id=grant_row.chapter_id and scope.role=grant_row.role));
  select coalesce(pg_catalog.array_agg(c.id), array[]::text[]) into staff_chapters
  from public.chapters c
  where c.organization_id = org
    and private.actor_has_chapter_staff_role(actor, c.id);

  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surface', 'analytics_parity_workspace'
  ));

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapterHealthFloor', health_threshold,
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'id', m.user_id::text || ':' || m.chapter_id,
        'name', p.full_name,
        'chapterId', c.id,
        'chapterName', c.name,
        'participationScore', case when privacy.shown then least(100, activity.event_count * 10) end,
        'profileReadiness', case when privacy.shown then
          (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50 end,
        'followThrough', case when privacy.shown then least(100, activity.follow_count * 20) end,
        'overallScore', case when privacy.shown then pg_catalog.round((
          least(100, activity.event_count * 10)
          + ((case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50)
          + least(100, activity.follow_count * 20)
        )::numeric / 3) end,
        'scoreHidden', not privacy.shown,
        'attention', case
          when cases.overdue_cases > 0 then 'urgent'
          when not privacy.shown then null
          when activity.event_count = 0 then 'support'
          when activity.event_count < 5 then 'watch'
          else 'steady'
        end,
        'activeCases', cases.active_cases,
        'overdueCases', cases.overdue_cases,
        'lastActivityAt', case when privacy.shown then activity.last_activity end
      ) order by c.name, p.full_name, m.user_id)
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id and c.organization_id = org
      join public.organization_memberships om
        on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
      join public.member_profiles p on p.id = m.user_id
      -- #6774: a member who hides their Pulse score keeps their row; only the
      -- activity-derived fields are withheld, and their activity is not read.
      cross join lateral (select p.pulse_score_visible or m.user_id = actor as shown) privacy
      cross join lateral (
        select
          pg_catalog.count(*)::integer as event_count,
          pg_catalog.count(*) filter (
            where e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp')
              and e.occurred_at >= generated - interval '90 days'
          )::integer as follow_count,
          pg_catalog.max(e.occurred_at) as last_activity
        from public.organization_engagement_events e
        where privacy.shown
          and e.organization_id = org
          and e.user_id = m.user_id
          -- Preserve train 2a participation semantics: page views are telemetry.
          and e.event_type <> 'page_view'
          and e.occurred_at >= generated - interval '180 days'
      ) activity
      cross join lateral (
        select
          pg_catalog.count(*) filter (where cs.status = 'active')::integer as active_cases,
          pg_catalog.count(*) filter (
            where cs.status = 'active' and cs.deadline < generated::date
          )::integer as overdue_cases
        from public.member_cases cs
        where cs.organization_id = org
          and cs.chapter_id = c.id
          and cs.user_id = m.user_id
          and cs.status = 'active'
          and case
            when org_case_reader and not scoped_actor
              and cs.chapter_id = any(staff_chapters)
              and (may_read_unassigned or cs.steward_user_id=actor or cs.coordinator_user_id=actor
                or cs.chapter_id=any(default_steward_chapters))
              and not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=cs.id)
            then true
            when not scoped_actor and not cs.is_restricted and cs.user_id<>actor
              and cs.chapter_id=any(default_steward_chapters)
              and not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=cs.id)
            then true
            else case when may_read_unassigned or cs.steward_user_id=actor or cs.coordinator_user_id=actor
                or cs.chapter_id=any(default_steward_chapters)
              then private.casework_staff_can_read(cs.id) else false end
          end
      ) cases
      where m.status = 'active'
        and (not roster_limited or m.user_id = actor or m.chapter_id = any(roster_chapters)
          or exists(select 1 from (
              select steward_scope.unit_id,steward_scope.committee_id
              from private.steward_assignment_scopes(actor,m.chapter_id) steward_scope
              where steward_scope.role='steward' and not steward_scope.legacy_chapter_coverage and steward_scope.chapter_id=m.chapter_id
              union all
              select role_scope.unit_id,role_scope.committee_id
              from private.chapter_role_scopes role_scope
              join public.member_role_chapters grant_row on grant_row.user_id=role_scope.user_id
                and grant_row.chapter_id=role_scope.chapter_id and grant_row.role=role_scope.role
              join public.member_chapter_memberships membership on membership.user_id=role_scope.user_id
                and membership.chapter_id=role_scope.chapter_id and membership.status='active'
              where role_scope.user_id=actor and role_scope.chapter_id=m.chapter_id
                and role_scope.role=any(array['coordinator','advisor'])) scope
            where ((scope.unit_id is not null and (
                  exists(select 1 from private.chapter_unit_members physical
                    where physical.unit_id=scope.unit_id and physical.chapter_id=m.chapter_id and physical.user_id=m.user_id)
                  or (exists(select 1 from private.chapter_units unit
                      where unit.id=scope.unit_id and unit.chapter_id=m.chapter_id and unit.is_default)
                    and not exists(select 1 from private.chapter_unit_members physical
                      where physical.user_id=m.user_id and physical.chapter_id=m.chapter_id))))
                or (scope.committee_id is not null and exists(select 1 from private.chapter_committees committee
                  join private.chapter_committee_members member on member.committee_id=committee.id and member.chapter_id=committee.chapter_id
                  where committee.id=scope.committee_id and committee.chapter_id=m.chapter_id and member.user_id=m.user_id
                    and committee.starts_on<=(select private.eastern_day()) and (committee.ends_on is null or committee.ends_on>=(select private.eastern_day())))))))
    ), '[]'::jsonb),
    'chapterHealth', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'chapterId', c.id,
        'chapterName', c.name,
        'memberCount', totals.member_count,
        'protected', totals.member_count < health_threshold
          or (latest.id is not null and latest.member_count < health_threshold),
        'score', case when totals.member_count >= health_threshold and latest.member_count >= health_threshold
          then latest.score else null end,
        'drivers', case when totals.member_count >= health_threshold and latest.member_count >= health_threshold
          then pg_catalog.jsonb_build_object(
            'participation', latest.participation,
            'caseTimeliness', latest.case_timeliness,
            'stewardCapacity', latest.steward_capacity,
            'trainingCoverage', latest.training_coverage,
            'communicationReach', latest.communication_reach,
            'governanceReadiness', latest.governance_readiness
          ) else null end,
        'trend', case when totals.member_count >= health_threshold then coalesce(trend.points, '[]'::jsonb) else '[]'::jsonb end
      ) order by c.name)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*)::integer as member_count
        from public.member_chapter_memberships m
        join public.organization_memberships om
          on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
        where m.chapter_id = c.id and m.status = 'active'
      ) totals
      left join lateral (
        select s.* from public.chapter_health_snapshots s
        where s.chapter_id = c.id order by s.measured_on desc limit 1
      ) latest on true
      left join lateral (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'measuredOn', history.measured_on, 'score', history.score
        ) order by history.measured_on) as points
        from (
          select s.measured_on, s.score
          from public.chapter_health_snapshots s
          where s.chapter_id = c.id and s.member_count >= health_threshold
          order by s.measured_on desc limit 36
        ) history
      ) trend on true
      where c.organization_id = org
    ), '[]'::jsonb),
    'datasets', coalesce((
      select pg_catalog.jsonb_agg(dataset.value order by dataset.sort_key)
      from (
        select 0 as sort_key, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'organization:chapter-health',
          'label', 'Chapter health',
          'description', 'Latest protected chapter health score.',
          'scope', 'organization',
          'chapterId', null,
          'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'label', qualified.name, 'value', qualified.score
          ) order by qualified.name), '[]'::jsonb)
        ) as value
        from (
          select c.name, latest.score
          from public.chapters c
          cross join lateral (
            select pg_catalog.count(*)::integer as member_count
            from public.member_chapter_memberships m
            join public.organization_memberships om
              on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
            where m.chapter_id = c.id and m.status = 'active'
          ) totals
          join lateral (
            select s.score, s.member_count from public.chapter_health_snapshots s
            where s.chapter_id = c.id order by s.measured_on desc limit 1
          ) latest on true
          where c.organization_id = org and totals.member_count >= health_threshold
            and latest.member_count >= health_threshold
        ) qualified
        union all
        select 100 + c.order_index, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'chapter:' || c.id || ':health-trend',
          'label', c.name || ' health trend',
          'description', 'Protected chapter score history.',
          'scope', 'chapter',
          'chapterId', c.id,
          'rows', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'label', s.measured_on::text, 'value', s.score
            ) order by s.measured_on)
            from public.chapter_health_snapshots s
            where s.chapter_id = c.id and s.member_count >= greatest(privacy_threshold, health_threshold)
          ), '[]'::jsonb)
        )
        from public.chapters c
        where c.organization_id = org
          and (select pg_catalog.count(*) from public.member_chapter_memberships m
               join public.organization_memberships om
                 on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
               where m.chapter_id = c.id and m.status = 'active') >= privacy_threshold
      ) dataset
    ), '[]'::jsonb),
    'layouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', l.id,
        'organizationId', l.organization_id,
        'name', l.name,
        'scope', l.scope,
        'chapterId', l.chapter_id,
        'spec', l.spec,
        'canEdit', l.owner_user_id = (select auth.uid())
          or private.has_organization_role(org, array['admin']),
        'updatedAt', l.updated_at
      ) order by l.updated_at desc)
      from public.organization_analytics_layouts l
      where l.organization_id = org
        and (
          (l.scope = 'personal' and l.owner_user_id = (select auth.uid()))
          or l.scope in ('chapter', 'organization')
        )
    ), '[]'::jsonb)
  );
end;
end;
$function$;

alter table private.chapter_committees
  alter column starts_on set default ((pg_catalog.now() at time zone 'America/New_York'))::date;

-- The account-lifecycle trigger review follows every changed function that a
-- lifecycle trigger reaches, and the Eastern-day helper they now call.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select surface.kind,surface.schema_name,surface.table_name,surface.object_name,surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
join (values
    ('private','actor_role_covers_member'),
    ('private','chapter_notice_scope_allowed'),
    ('private','chapter_office_role_present'),
    ('private','chapter_officer_can_for_scope'),
    ('private','chapter_record_manageable'),
    ('private','chapter_records_member_allowed'),
    ('private','chapter_role_scope_expired'),
    ('private','chapter_scope_member_allowed'),
    ('private','chapter_scope_recipient_allowed'),
    ('private','chapter_scoped_member_ids'),
    ('private','chapter_scoped_role_allows'),
    ('private','draft_steward_covers_member'),
    ('private','member_scoped_notice_in_audience'),
    ('private','unit_staff_member_capability_allows'),
    ('public','get_broadcast_read_counts'),
    ('public','get_broadcast_read_counts_for'),
    ('public','get_chapter_office_access'),
    ('public','get_organization_analytics_workspace'),
    ('private','eastern_day')
) changed(schema_name,function_name)
  on changed.schema_name=surface.schema_name
 and changed.function_name=pg_catalog.split_part(surface.object_name,'(',1)
where surface.kind='function'
on conflict(kind,schema_name,table_name,object_name)
do update set definition_hash=excluded.definition_hash;

commit;
