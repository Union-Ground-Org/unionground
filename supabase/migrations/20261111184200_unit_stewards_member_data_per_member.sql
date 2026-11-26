-- REQ-UG-UNIT-STEWARDS-MEMBER-DATA-GATES-PER-MEMBER-20261109 (#7687)
-- Scoped staff collaborate without acquiring chapter-wide member-data access.
-- Canonical predecessor definitions retain MFA, lifecycle locks and settings.
-- Untargeted legacy member-contact containers keep their existing broad-staff
-- bar; the structured contact log admits only authorized member subjects.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- pg_get_functiondef qualifies composite return types according to the
-- caller's path. pg_catalog alone matches the hosted receipt's empty-path rendering,
-- retaining an exact whole-definition check (body, security and settings).
set local search_path = pg_catalog;

do $predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.institutional_context(boolean)'))) is distinct from '26e1ad900eb846b90e9489444ed6093d' then
    raise exception 'unreviewed predecessor: private.institutional_context' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.can_read_chapter_contact_record(text)'))) is distinct from 'd55726bd6cce152f5264aca81b22e06f' then
    raise exception 'unreviewed predecessor: private.can_read_chapter_contact_record' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_record_manageable(text, uuid, uuid)'))) is distinct from '53408aebca098c2b3f7057fba942d5ba' then
    raise exception 'unreviewed predecessor: private.chapter_record_manageable' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_records_scope_memo(text)'))) is distinct from 'd8b8bee7d5e0e7895a09f0ea5bc8d3d2' then
    raise exception 'unreviewed predecessor: private.chapter_records_scope_memo' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.create_chapter_task_from_source(text, text)'))) is distinct from 'd99cbfc887a59221270d67c4b6334d7a' then
    raise exception 'unreviewed predecessor: public.create_chapter_task_from_source' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.civic_member_place_counts(text)'))) is distinct from 'a9c97792a24e1c843b4ab3d4a9ce880d' then
    raise exception 'unreviewed predecessor: public.civic_member_place_counts' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.civic_member_officials_for_org(text)'))) is distinct from 'b7fc7a47b32a5b9050381a38d758a091' then
    raise exception 'unreviewed predecessor: public.civic_member_officials_for_org' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.civic_campaign_stats_for_org(text)'))) is distinct from '1b300ea4ed3d629f5f4a4f1806304187' then
    raise exception 'unreviewed predecessor: public.civic_campaign_stats_for_org' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_institutional_records_workspace()'))) is distinct from '238b4677fa02c189cbdcee50c85409e2' then
    raise exception 'unreviewed predecessor: public.get_institutional_records_workspace' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.save_chapter_contact_log(uuid, text, text, text, text, text, timestamp with time zone, timestamp with time zone, uuid, uuid, uuid, boolean)'))) is distinct from '6cbc8dd9d850b360cd3e87beb6ee0485' then
    raise exception 'unreviewed predecessor: public.save_chapter_contact_log' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_minutes_meeting_checkins(uuid)'))) is distinct from '2b66690e82382dcdeb4fa1addb9a6ac0' then
    raise exception 'unreviewed predecessor: public.get_minutes_meeting_checkins' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.save_scoped_institutional_record(uuid, text, text, text, timestamp with time zone, text, text, boolean, text, integer, jsonb, uuid, uuid, text, uuid)'))) is distinct from '0d44bb68cbe2cd4b36cc3f5db185319b' then
    raise exception 'unreviewed predecessor: public.save_scoped_institutional_record' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.cancel_appointment(uuid)'))) is distinct from 'ac853d32f07958e5aff41dd48599e2f6' then
    raise exception 'unreviewed predecessor: public.cancel_appointment' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.reschedule_appointment(uuid, timestamp with time zone)'))) is distinct from '4dd746c6b3be3d8fbb0bcbd0ef92e60c' then
    raise exception 'unreviewed predecessor: public.reschedule_appointment' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.mark_appointment_outcome(uuid, text)'))) is distinct from 'e6de8ca2c07ddabc8c4cf9abc422beca' then
    raise exception 'unreviewed predecessor: public.mark_appointment_outcome' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_appointment_history(uuid, timestamp with time zone, uuid, integer)'))) is distinct from '5b7879680b4785b5472391a5c284eb9c' then
    raise exception 'unreviewed predecessor: public.get_appointment_history' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.set_appointment_note(uuid, text)'))) is distinct from 'efc992de92cbc07144b0bbc93e4f8053' then
    raise exception 'unreviewed predecessor: public.set_appointment_note' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_appointment_notes(uuid[])'))) is distinct from 'eceb9b1eb7c4ab71b8eca60f36ffbf5a' then
    raise exception 'unreviewed predecessor: public.get_appointment_notes' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_steward_appointments_without_place_legacy()'))) is distinct from '8c35e96e7065d1d2a4af906c6c2b40c1' then
    raise exception 'unreviewed predecessor: public.get_steward_appointments_without_place_legacy' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.list_steward_appointments_without_place_legacy(text, timestamp with time zone, uuid, integer)'))) is distinct from '531c793c4d0d3ec46a23020526037c2b' then
    raise exception 'unreviewed predecessor: public.list_steward_appointments_without_place_legacy' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.seniority_staff_can_manage(text)'))) is distinct from '26978fbe3753a05bd78f39b7ec3aafa0' then
    raise exception 'unreviewed predecessor: private.seniority_staff_can_manage' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.list_chapter_seniority(text, date, uuid, integer)'))) is distinct from 'fb56568d36565c64911e0c4c6d0d4638' then
    raise exception 'unreviewed predecessor: public.list_chapter_seniority' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.search_chapter_seniority_members(text, text)'))) is distinct from '08cb9699e3aafc75501085ab21b32984' then
    raise exception 'unreviewed predecessor: public.search_chapter_seniority_members' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.save_chapter_seniority_entry(text, uuid, date, text, text)'))) is distinct from 'c3cf1f4c9450aed9e809efc6f43c6677' then
    raise exception 'unreviewed predecessor: public.save_chapter_seniority_entry' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.delete_chapter_seniority_entry(uuid)'))) is distinct from '69226d348288265a5cce6f84d618a977' then
    raise exception 'unreviewed predecessor: public.delete_chapter_seniority_entry' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.answer_chapter_seniority_question(uuid, text)'))) is distinct from 'b1c118777abb95cddb8bb7e3793f682e' then
    raise exception 'unreviewed predecessor: public.answer_chapter_seniority_question' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.import_chapter_seniority(text, jsonb, boolean)'))) is distinct from '4a8a795bc8889fef1a670360470b2d1c' then
    raise exception 'unreviewed predecessor: public.import_chapter_seniority' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.list_chapter_bid_windows(text, integer, integer)'))) is distinct from 'b8aa6b7ecce240c2cff58fd7e82a05b4' then
    raise exception 'unreviewed predecessor: public.list_chapter_bid_windows' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.record_chapter_bid(uuid, uuid, text)'))) is distinct from '9d6713d5d23e9dc75d4dd08460ee3a5d' then
    raise exception 'unreviewed predecessor: public.record_chapter_bid' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.list_chapter_bid_window_bids(uuid, integer, integer)'))) is distinct from 'fb58555f2aea2781de4196afac7d55d5' then
    raise exception 'unreviewed predecessor: public.list_chapter_bid_window_bids' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.award_chapter_bid(uuid, text)'))) is distinct from '1de462b47e7cd275d0716b22aa990fe5' then
    raise exception 'unreviewed predecessor: public.award_chapter_bid' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.record_member_access_event(uuid, uuid, text, text, text)'))) is distinct from 'adc29082aadd2e954a681924d331b15f' then
    raise exception 'unreviewed predecessor: public.record_member_access_event' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.casework_may_manage_case_access(uuid)'))) is distinct from '9cde5b80e84dbefe0d5c4386a9e8eba2' then
    raise exception 'unreviewed predecessor: private.casework_may_manage_case_access' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.casework_revoke_access(uuid)'))) is distinct from 'eee848dc11c065ab11e7dcd6547c2498' then
    raise exception 'unreviewed predecessor: public.casework_revoke_access' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.casework_history_versions(uuid)'))) is distinct from 'a0b66f6ef4374336f2062e2def169949' then
    raise exception 'unreviewed predecessor: private.casework_history_versions' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.casework_add_management_addendum(uuid, text)'))) is distinct from '7c4d00e97da4945f08abe1c2fc0d2c55' then
    raise exception 'unreviewed predecessor: public.casework_add_management_addendum' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.case_signals_staff_organization(text)'))) is distinct from 'fccd09fa09e82832a5a1577fb7f81238' then
    raise exception 'unreviewed predecessor: private.case_signals_staff_organization' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.issue_digest_staff_organization(text)'))) is distinct from '5e8875129964b943c529540e43ec10ba' then
    raise exception 'unreviewed predecessor: private.issue_digest_staff_organization' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_issue_intelligence_signals(text)'))) is distinct from '5e3693697887d408c3dc5fe2aac398e4' then
    raise exception 'unreviewed predecessor: public.get_issue_intelligence_signals' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.civic_is_org_officer(text)'))) is distinct from 'dfc1c21c1444810eafd588bac352c213' then
    raise exception 'unreviewed predecessor: public.civic_is_org_officer' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.casework_save_intake_draft(uuid, text, uuid, uuid, jsonb, integer)'))) is distinct from '6eeb977a7bdc6d670e07ab1fecdd1e73' then
    raise exception 'unreviewed predecessor: public.casework_save_intake_draft' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.learning_undo_casework(text, jsonb)'))) is distinct from '2410c5024b6052111640519f5ff07ab3' then
    raise exception 'unreviewed predecessor: private.learning_undo_casework' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.account_lifecycle_retained_case_scope_allows(text, text, text)'))) is distinct from '6a032634d6d6dec390c31e440d7c458b' then
    raise exception 'unreviewed predecessor: private.account_lifecycle_retained_case_scope_allows' using errcode='55000';
  end if;
end;
$predecessors$;

-- Preserve the existing policy-expression pins and definition parsing path.
set local search_path = pg_catalog, public, extensions;
do $predecessor_policies$
begin
  if (select pg_catalog.md5(coalesce(p.qual,'') || pg_catalog.chr(10) || coalesce(p.with_check,''))
      from pg_catalog.pg_policies p where p.schemaname='public' and p.tablename='casework_management_entries' and p.policyname='casework_management_entries_staff')
      is distinct from 'd9656c04ae63538ec3973b576b5d1aa7' then
    raise exception 'unreviewed predecessor policy: casework_management_entries.casework_management_entries_staff' using errcode='55000';
  end if;
  if (select pg_catalog.md5(coalesce(p.qual,'') || pg_catalog.chr(10) || coalesce(p.with_check,''))
      from pg_catalog.pg_policies p where p.schemaname='public' and p.tablename='casework_management_entries' and p.policyname='casework_management_entries_insert')
      is distinct from '830b3b0455ac47f5772f06390d74080d' then
    raise exception 'unreviewed predecessor policy: casework_management_entries.casework_management_entries_insert' using errcode='55000';
  end if;
  if (select pg_catalog.md5(coalesce(p.qual,'') || pg_catalog.chr(10) || coalesce(p.with_check,''))
      from pg_catalog.pg_policies p where p.schemaname='public' and p.tablename='casework_management_addenda' and p.policyname='casework_management_addenda_staff')
      is distinct from '72573841d91e35300e1e9e5fcae062b1' then
    raise exception 'unreviewed predecessor policy: casework_management_addenda.casework_management_addenda_staff' using errcode='55000';
  end if;
  if (select pg_catalog.md5(coalesce(p.qual,'') || pg_catalog.chr(10) || coalesce(p.with_check,''))
      from pg_catalog.pg_policies p where p.schemaname='public' and p.tablename='casework_management_addenda' and p.policyname='casework_management_addenda_insert')
      is distinct from '13745ee518cb83f46ae73da8ec43c68f' then
    raise exception 'unreviewed predecessor policy: casework_management_addenda.casework_management_addenda_insert' using errcode='55000';
  end if;
  if (select pg_catalog.md5(coalesce(p.qual,'') || pg_catalog.chr(10) || coalesce(p.with_check,''))
      from pg_catalog.pg_policies p where p.schemaname='public' and p.tablename='casework_retaliation_reports' and p.policyname='casework_retaliation_reports_read')
      is distinct from '2ab592ab3501dd0c6394d17c415f86b1' then
    raise exception 'unreviewed predecessor policy: casework_retaliation_reports.casework_retaliation_reports_read' using errcode='55000';
  end if;
  if (select pg_catalog.md5(coalesce(p.qual,'') || pg_catalog.chr(10) || coalesce(p.with_check,''))
      from pg_catalog.pg_policies p where p.schemaname='public' and p.tablename='casework_intake_drafts' and p.policyname='casework_intake_drafts_owner')
      is distinct from 'db513d7ff96b73e4417969ef316f30d1' then
    raise exception 'unreviewed predecessor policy: casework_intake_drafts.casework_intake_drafts_owner' using errcode='55000';
  end if;
  if (select pg_catalog.md5(coalesce(p.qual,'') || pg_catalog.chr(10) || coalesce(p.with_check,''))
      from pg_catalog.pg_policies p where p.schemaname='public' and p.tablename='chapter_contact_log_versions' and p.policyname='chapter_contact_log_versions_staff_read')
      is distinct from '450624fdb3aded4b23204125338cf796' then
    raise exception 'unreviewed predecessor policy: chapter_contact_log_versions.chapter_contact_log_versions_staff_read' using errcode='55000';
  end if;
  if (select pg_catalog.md5(coalesce(p.qual,'') || pg_catalog.chr(10) || coalesce(p.with_check,''))
      from pg_catalog.pg_policies p where p.schemaname='public' and p.tablename='chapter_records' and p.policyname='chapter_records_select')
      is distinct from '7d35c6202a1af25d6a138befb9cb4390' then
    raise exception 'unreviewed predecessor policy: chapter_records.chapter_records_select' using errcode='55000';
  end if;
  if (select pg_catalog.md5(coalesce(p.qual,'') || pg_catalog.chr(10) || coalesce(p.with_check,''))
      from pg_catalog.pg_policies p where p.schemaname='public' and p.tablename='member_appointments' and p.policyname='member_appointments_select_participant')
      is distinct from 'b764869e3fc7462e043c207d3ff7ce67' then
    raise exception 'unreviewed predecessor policy: member_appointments.member_appointments_select_participant' using errcode='55000';
  end if;
  if (select pg_catalog.md5(coalesce(p.qual,'') || pg_catalog.chr(10) || coalesce(p.with_check,''))
      from pg_catalog.pg_policies p where p.schemaname='public' and p.tablename='member_appointment_events' and p.policyname='member_appointment_events_select_participant')
      is distinct from '3e7f863f562252251ada5f60b3071233' then
    raise exception 'unreviewed predecessor policy: member_appointment_events.member_appointment_events_select_participant' using errcode='55000';
  end if;
end;
$predecessor_policies$;


create function private.chapter_staff_member_allowed(
  p_chapter text, p_target uuid, p_roles text[]
) returns boolean
language sql stable security definer set search_path = ''
as $function$
  select p_target is not null
    and (select private.mfa_satisfied())
    and exists (
      select 1 from pg_catalog.unnest(p_roles) requested(role)
      where (private.member_has_chapter_staff_grant(p_chapter, array[requested.role])
        or private.has_organization_role(
          (select staff_chapter.organization_id from public.chapters staff_chapter where staff_chapter.id = p_chapter),
          array[requested.role]))
        and public.staff_can_see_user(p_target, requested.role)
    );
$function$;
revoke all on function private.chapter_staff_member_allowed(text, uuid, text[])
  from public, anon, authenticated, service_role;
grant execute on function private.chapter_staff_member_allowed(text, uuid, text[]) to authenticated;

create function private.chapter_records_member_allowed(p_chapter text, p_target uuid)
returns boolean
language sql stable security definer set search_path = ''
as $function$
  select p_target is not null and (select private.mfa_satisfied())
    and (
      private.chapter_staff_member_allowed(
        p_chapter, p_target, array['steward','coordinator','advisor','admin','vp'])
      or exists (
        select 1 from private.chapter_role_capabilities capability
        left join private.chapter_role_settings setting
          on setting.chapter_id = p_chapter and setting.role = capability.role
         and setting.capability = capability.capability
        where capability.capability = 'records' and coalesce(setting.enabled, true)
          and private.actor_role_covers_member(
            (select auth.uid()), p_chapter, capability.role, p_target, false)
      )
    );
$function$;
revoke all on function private.chapter_records_member_allowed(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.chapter_records_member_allowed(text, uuid) to authenticated;

create function private.chapter_contact_entry_allowed(
  p_chapter text, p_subject uuid, p_case uuid
) returns boolean
language sql stable security definer set search_path = ''
as $function$
  select (select private.mfa_satisfied())
    and private.can_read_chapter_contact_record(p_chapter)
    and (
      private.member_has_chapter_role(p_chapter, array['steward','coordinator','advisor','admin','vp'])
      or private.has_organization_role(
        (select staff_chapter.organization_id from public.chapters staff_chapter where staff_chapter.id = p_chapter),
        array['steward','coordinator','advisor','admin','vp'])
      or private.chapter_staff_member_allowed(
        p_chapter, p_subject, array['steward','coordinator','advisor','admin','vp'])
    )
    and (p_case is null or private.casework_can_read(p_case));
$function$;
revoke all on function private.chapter_contact_entry_allowed(text, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.chapter_contact_entry_allowed(text, uuid, uuid) to authenticated;

create function private.chapter_seniority_member_allowed(p_chapter text, p_target uuid)
returns boolean
language sql stable security definer set search_path = ''
as $function$
  select p_target is not null
    and private.seniority_staff_can_manage(p_chapter)
    and private.seniority_chapter_member(p_chapter, p_target)
    and (
      private.member_has_chapter_role(p_chapter, array['steward','coordinator'])
      or private.has_organization_role(
        (select private.current_mobile_staff_organization()), array['steward','coordinator'])
      or private.chapter_staff_member_allowed(p_chapter, p_target, array['steward','coordinator'])
    );
$function$;
revoke all on function private.chapter_seniority_member_allowed(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.chapter_seniority_member_allowed(text, uuid) to authenticated;

-- private.institutional_context (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION private.institutional_context(p_require_staff boolean DEFAULT true)
 RETURNS TABLE(organization_id uuid, chapter_id text, caller_id uuid, staff boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.current_member_organization();
  chapter text := private.current_member_chapter();
  caller uuid := (select auth.uid());
  is_staff boolean := (private.member_has_chapter_staff_grant(chapter,array['steward','coordinator','advisor','admin','vp']) or private.chapter_office_role_present(chapter,'records'));
begin
  if caller is null or org is null or chapter is null or not private.mfa_satisfied() then
    raise exception 'organization chapter context required' using errcode = '42501';
  end if;
  if p_require_staff and not is_staff then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  return query select org, chapter, caller, is_staff;
end;
$function$;

-- private.can_read_chapter_contact_record (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION private.can_read_chapter_contact_record(p_chapter_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when (select auth.uid()) is null or p_chapter_id is null then false
    when not (select private.mfa_satisfied()) then false
    else exists (
      select 1
      from public.chapters c
      where c.id = p_chapter_id
        and (
          (
            -- Organization-backed chapter. `is_organization_member` is stated
            -- here rather than inherited from chapters_select_all: this
            -- predicate runs SECURITY DEFINER, so the chapters policy no
            -- longer filters the subquery and the containment has to be its
            -- own. An explicit tenant-wide hat OR an exact chapter role
            -- reads, and both helpers carry the tenant staff-MFA rule.
            c.organization_id is not null
            and c.organization_id = (select private.current_member_organization())
            and (select private.is_organization_member(c.organization_id))
            and (
              (select private.has_organization_role(
                c.organization_id,
                array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
              or (select private.member_has_chapter_staff_grant(
                c.id,
                array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
            )
          )
          or (
            -- Quarantined orphan chapter. Same three requirements, none of
            -- them borrowed: an ACTIVE membership in this exact chapter (was
            -- chapters_select_all), a staff role in it, and the second-factor
            -- rule (was the trailing clause of public.member_has_role, three
            -- helpers away). private.staff_mfa_required() fails closed to
            -- true, so an orphan session with no policy row is gated.
            c.organization_id is null
            and (select private.current_member_organization()) is null
            and exists (
              select 1
              from public.member_chapter_memberships m
              where m.user_id = (select auth.uid())
                and m.chapter_id = c.id
                and m.status = 'active'
            )
            and (select private.member_has_chapter_staff_grant(
              c.id,
              array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
            and (
              not (select private.staff_mfa_required())
              or (select private.has_second_factor((select auth.uid())))
            )
          )
        )
    )
  end;
$function$;

-- private.chapter_record_manageable (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION private.chapter_record_manageable(p_chapter text, p_unit uuid, p_committee uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select private.member_has_chapter_role(p_chapter,array['steward','coordinator','advisor','admin','vp'])
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
          select 1 from private.chapter_role_scopes scope
          left join private.chapter_committees committee on committee.id = scope.committee_id
          where scope.user_id = (select auth.uid()) and scope.chapter_id = p_chapter
            and scope.role=capability.role
            and (
              (p_unit is not null and p_committee is null and scope.unit_id = p_unit)
              or (p_unit is null and p_committee is not null and scope.committee_id = p_committee
                and (committee.starts_on is null or committee.starts_on <= current_date)
                and (committee.ends_on is null or committee.ends_on >= current_date))
            )
        )
      )
    )
    or private.chapter_officer_can_for_scope(p_chapter,'records',p_unit,p_committee);
$function$;

-- private.chapter_records_scope_memo (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION private.chapter_records_scope_memo(p_kind text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case p_kind
    when 'member' then (
      select coalesce(pg_catalog.jsonb_object_agg(d.chapter_id,
        private.can_read_chapter_member_record(d.chapter_id)), '{}'::jsonb)
      from (select distinct r.chapter_id from public.chapter_records r) d
    )
    when 'contact' then (
      select coalesce(pg_catalog.jsonb_object_agg(d.chapter_id,
        private.can_read_chapter_contact_record(d.chapter_id)), '{}'::jsonb)
      from (select distinct r.chapter_id from public.chapter_records r) d
    )
    when 'officer' then (
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.jsonb_build_array(d.chapter_id, d.access_unit_id, d.access_committee_id)::text,
        private.chapter_officer_can_for_scope(d.chapter_id, 'records', d.access_unit_id, d.access_committee_id)), '{}'::jsonb)
      from (select distinct r.chapter_id, r.access_unit_id, r.access_committee_id from public.chapter_records r) d
    )
    when 'manageable' then (
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.jsonb_build_array(d.chapter_id, d.access_unit_id, d.access_committee_id)::text,
        private.chapter_record_manageable(d.chapter_id, d.access_unit_id, d.access_committee_id)), '{}'::jsonb)
      from (select distinct r.chapter_id, r.access_unit_id, r.access_committee_id from public.chapter_records r
            where r.access_unit_id is not null or r.access_committee_id is not null) d
    )
    when 'broad-staff' then (
      select coalesce(pg_catalog.jsonb_object_agg(d.chapter_id,
        (private.member_has_chapter_role(d.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role((select staff_chapter.organization_id from public.chapters staff_chapter where staff_chapter.id = (d.chapter_id)), array['steward','coordinator','advisor','admin','vp']))), '{}'::jsonb)
      from (select distinct r.chapter_id from public.chapter_records r) d
    )
    when 'container' then (
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.jsonb_build_array(d.chapter_id, d.access_unit_id, d.access_committee_id)::text,
        private.chapter_record_manageable(d.chapter_id, d.access_unit_id, d.access_committee_id)
          or private.chapter_scope_member_allowed(d.chapter_id, d.access_unit_id, d.access_committee_id, (select auth.uid()))), '{}'::jsonb)
      from (select distinct r.chapter_id, r.access_unit_id, r.access_committee_id from public.chapter_records r
             where r.access_unit_id is not null or r.access_committee_id is not null) d
    )
    else '{}'::jsonb
  end
$function$;

-- public.create_chapter_task_from_source (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.create_chapter_task_from_source(p_source_kind text, p_source_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  learning_parent uuid;
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_org uuid;
  clean_kind text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source_kind, '')));
  clean_source_id text := pg_catalog.btrim(coalesce(p_source_id, ''));
  source_uuid uuid;
  source_found boolean := false;
  source_is_current boolean := true;
  task_title text;
  attachment_label text;
  record_url text;
  task_workstream text;
  message_owner uuid;
  message_conversation uuid;
  case_row public.member_cases%rowtype;
  task_row public.chapter_tasks%rowtype;
  attachment_row public.chapter_task_attachments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if clean_kind not in ('message', 'broadcast', 'notification', 'survey', 'case')
     or clean_source_id = ''
     or pg_catalog.char_length(clean_source_id) > 200 then
    raise exception 'source unavailable' using errcode = '22023';
  end if;

  if clean_kind in ('message', 'notification', 'case') then
    begin
      source_uuid := clean_source_id::uuid;
      clean_source_id := source_uuid::text;
    exception when invalid_text_representation then
      raise exception 'source unavailable' using errcode = '22023';
    end;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));

  select p.chapter_id, c.organization_id into caller_chapter, caller_org
  from public.member_profiles p
  left join public.chapters c on c.id = p.chapter_id
  where p.id = caller;
  if caller_chapter is null then
    raise exception 'source unavailable' using errcode = '22023';
  end if;
  if not private.member_has_chapter_staff_grant(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  case clean_kind
    when 'message' then
      select m.user_id, m.conversation_id into message_owner, message_conversation
      from public.member_messages m
      where m.id = source_uuid
        and m.learning_removal_held_at is null
        and m.sender_kind = 'member'
        and (
          m.user_id = caller
          or public.staff_can_see_user(m.user_id, 'steward')
        );
      source_found := found;
      task_title := 'Follow up on member message';
      attachment_label := 'Authorized member message';
      record_url := case when message_owner = caller
        then '/m/messages?conversation=' || message_conversation::text
        else '/m/steward?thread=' || message_conversation::text
      end;
    when 'broadcast' then
      select b.retracted_at is null into source_is_current
      from public.member_broadcasts b
      where b.id = clean_source_id
        and b.organization_id is not null
        and caller_org is not null
        and b.organization_id = caller_org
        and private.can_read_member_broadcast(b.id);
      source_found := found;
      task_title := 'Review chapter broadcast';
      attachment_label := 'Authorized chapter broadcast';
      record_url := '/m/messages?broadcast=' || clean_source_id;
    when 'notification' then
      select true into source_found
      from public.member_notifications n
      where n.id = source_uuid
        and n.user_id = caller;
      source_found := found;
      task_title := 'Review notification';
      attachment_label := 'Authorized notification';
      record_url := '/m/messages?notification=' || clean_source_id;
    when 'survey' then
      select s.active into source_is_current
      from public.member_surveys s
      where s.id = clean_source_id
        and s.chapter_id is not null
        and s.chapter_id = caller_chapter;
      source_found := found;
      task_title := 'Follow up on survey';
      attachment_label := 'Authorized survey';
      record_url := '/m/voting?survey=' || clean_source_id;
    when 'case' then
      select c.* into case_row
      from public.member_cases c
      where c.id = source_uuid and private.casework_can_read(c.id)
        and (
          c.user_id = caller
          or (
            c.steward_user_id = caller
            and (private.member_has_chapter_role(caller_chapter, array['steward']) or private.chapter_staff_member_allowed(caller_chapter, c.user_id, array['steward']))
          )
          or public.staff_can_see_user(c.user_id, 'coordinator')
        );
      source_found := found;
      source_is_current := case_row.status = 'active';
      task_title := 'Follow up on grievance';
      attachment_label := 'Authorized grievance';
      record_url := case
        when case_row.user_id = caller then '/m/cases?case=' || clean_source_id
        when case_row.steward_user_id = caller
          and (private.member_has_chapter_role(caller_chapter, array['steward']) or private.chapter_staff_member_allowed(caller_chapter, case_row.user_id, array['steward']))
          then '/m/steward?case=' || clean_source_id
        else '/m/coordinator?case=' || clean_source_id
      end;
  end case;

  if not source_found then
    raise exception 'source unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      caller_chapter || pg_catalog.chr(31) || clean_kind || pg_catalog.chr(31) || clean_source_id,
      0
    )
  );

  select a.* into attachment_row
  from public.chapter_task_attachments a
  where a.chapter_id = caller_chapter
    and a.source_kind = clean_kind
    and a.source_id = clean_source_id;
  if found then
    select t.* into task_row
    from public.chapter_tasks t
    where t.id = attachment_row.task_id;
    return pg_catalog.jsonb_build_object(
      'task', pg_catalog.to_jsonb(task_row),
      'attachment', pg_catalog.to_jsonb(attachment_row),
      'created', false
    );
  end if;

  if not source_is_current then
    raise exception 'source unavailable' using errcode = '22023';
  end if;

  select w.name into task_workstream
  from public.chapter_workstreams w
  where w.chapter_id = caller_chapter
  order by
    (pg_catalog.lower(pg_catalog.btrim(w.name)) = 'general') desc,
    pg_catalog.lower(pg_catalog.btrim(w.name)),
    w.name,
    w.id
  limit 1
  for key share of w;
  if task_workstream is null then
    raise exception 'chapter has no available task workstream' using errcode = '22023';
  end if;

  insert into public.chapter_tasks (
    title, description, status, priority, task_type, workstream,
    assignee_id, start_date, due_date, progress, blocked, milestone, order_index
  ) values (
    task_title, '', 'to_do', 'medium', 'general', task_workstream,
    null, null, null, 0, false, false, 0
  ) returning * into task_row;

  insert into public.chapter_task_attachments (
    task_id, chapter_id, label, record_url, created_by, source_kind, source_id
  ) values (
    task_row.id, caller_chapter, attachment_label, record_url, caller,
    clean_kind, clean_source_id
  ) returning * into attachment_row;

  insert into public.chapter_task_activity (
    task_id, chapter_id, actor_id, action, to_value
  ) values (
    task_row.id, caller_chapter, caller, 'attachment_added', attachment_row.id::text
  );

  learning_parent := private.learning_task_journal('task_create', task_row.id, null);
  perform private.learning_journal_append('task_link_add', 'public.chapter_task_attachments', attachment_row.id::text, learning_parent,
    private.learning_fingerprint(private.learning_task_edge_state('public.chapter_task_attachments', attachment_row.id::text)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(task_row),
    'attachment', pg_catalog.to_jsonb(attachment_row),
    'created', true
  );
end;
end
$function$;

-- public.civic_member_place_counts (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.civic_member_place_counts(p_org text)
 RETURNS TABLE(geoid text, kind text, name text, state text, members bigint, entered_by text, officials bigint, own_jurisdiction_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not (select private.mfa_satisfied()) or not public.civic_is_org_officer(p_org) then
    raise exception 'officers only' using errcode = '42501';
  end if;
  return query
  with visible_members as materialized (
    select member.user_id from private.staff_visible_member_ids('steward') member(user_id)
    union select member.user_id from private.staff_visible_member_ids('coordinator') member(user_id)
    union select member.user_id from private.staff_visible_member_ids('admin') member(user_id)
    union select member.user_id from private.staff_visible_member_ids('vp') member(user_id)
)
  select place.geoid, place.kind, place.name, place.state,
         count(distinct user_place.user_id),
         (select public.civic_org_display_name(entry.org_id)
            from public.civic_local_jurisdictions entry
           where entry.place_geoid = place.geoid and (entry.org_id = p_org or entry.shared)
           order by (entry.org_id = p_org) desc, entry.reviewed_at desc
           limit 1),
         (select count(*)
            from public.civic_local_officials official
            join public.civic_local_jurisdictions entry on entry.id = official.jurisdiction_id
           where entry.place_geoid = place.geoid and official.is_current
             and (entry.org_id = p_org or entry.shared)),
         (select entry.id
            from public.civic_local_jurisdictions entry
           where entry.place_geoid = place.geoid and entry.org_id = p_org)
  from public.civic_user_places user_place
  join public.civic_places place on place.geoid = user_place.geoid
  where user_place.user_id in (select public.civic_org_member_ids(p_org))
    and user_place.user_id in (select user_id from visible_members)
  group by place.geoid, place.kind, place.name, place.state
  -- A place with fewer than three members is left out entirely: returning the
  -- place while hiding its count would still say where one or two members live.
  having count(distinct user_place.user_id) >= 3
  order by count(distinct user_place.user_id) desc, place.name;
end;
$function$;

-- public.civic_member_officials_for_org (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.civic_member_officials_for_org(p_org text)
 RETURNS TABLE(official_key text, full_name text, office text, party text, state text, district_name text, level_rank integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not (select private.mfa_satisfied()) or not public.civic_is_org_officer(p_org) then
    raise exception 'officers only' using errcode = '42501';
  end if;
  return query
  with visible_members as materialized (
    select member.user_id from private.staff_visible_member_ids('steward') member(user_id)
    union select member.user_id from private.staff_visible_member_ids('coordinator') member(user_id)
    union select member.user_id from private.staff_visible_member_ids('admin') member(user_id)
    union select member.user_id from private.staff_visible_member_ids('vp') member(user_id)
), eligible as (
    -- Only officials that at least three of the chapter's members share: a
    -- row's presence must not point at the district of one or two members.
    select k.official_key
    from public.civic_member_officials_keyed k
    where k.user_id in (select public.civic_org_member_ids(p_org))
      and k.user_id in (select user_id from visible_members)
      and k.official_key is not null
    group by k.official_key
    having count(distinct k.user_id) >= 3
  )
  select distinct on (o.official_key)
         o.official_key, o.full_name, o.office, o.party, o.state, o.district_name, o.level_rank
  from public.civic_member_officials_keyed o
  join eligible on eligible.official_key = o.official_key
  where o.user_id in (select public.civic_org_member_ids(p_org))
      and o.user_id in (select user_id from visible_members)
  order by o.official_key, o.resolved_at desc nulls last;
end;
$function$;

-- public.civic_campaign_stats_for_org (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.civic_campaign_stats_for_org(p_org text)
 RETURNS TABLE(campaign_id uuid, messages_sent bigint, messages_drafted bigint, members_participating bigint, officials_contacted bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not (select private.mfa_satisfied()) or not public.civic_is_org_officer(p_org) then
    raise exception 'officers only' using errcode = '42501';
  end if;
  if not private.chapter_belongs_to_union(p_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  return query
    with visible_members as materialized (
    select member.user_id from private.staff_visible_member_ids('steward') member(user_id)
    union select member.user_id from private.staff_visible_member_ids('coordinator') member(user_id)
    union select member.user_id from private.staff_visible_member_ids('admin') member(user_id)
    union select member.user_id from private.staff_visible_member_ids('vp') member(user_id)
)
    select campaign.id,
      pg_catalog.count(message.id) filter (where message.status = 'sent'),
      pg_catalog.count(message.id) filter (where message.status = 'drafted'),
      pg_catalog.count(distinct message.user_id) filter (where message.status = 'sent'),
      pg_catalog.count(distinct message.official_key) filter (where message.status = 'sent')
    from public.civic_campaigns campaign
    left join public.civic_member_messages message
      on message.campaign_id = campaign.id
     and message.user_id in (select user_id from visible_members)
    where campaign.org_id = p_org
    group by campaign.id;
end;
$function$;

-- public.get_institutional_records_workspace (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.get_institutional_records_workspace()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ctx record;
begin
  select * into ctx from private.institutional_context(false);
  return pg_catalog.jsonb_build_object(
    'canManage', ctx.staff,
    'chapterId',ctx.chapter_id,'organizationId',ctx.organization_id,
    'canContacts', private.can_read_chapter_contact_record(ctx.chapter_id),
    'canManageUnscoped', private.chapter_record_manageable(ctx.chapter_id,null,null),
    'recordScopes', case when private.member_pin_session_restricted() then '[]'::jsonb else public.get_chapter_office_access()->'scopes' end,
    'canExport', private.has_organization_role(ctx.organization_id, array['admin','vp']),
    'records', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) || pg_catalog.jsonb_build_object(
        'canManage', private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id),
        'versions', case when private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id) then coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v) order by v.version desc) from public.chapter_record_versions v where v.record_id = r.id and (v.record_type <> 'member_contact' or coalesce((((select private.chapter_records_scope_memo('broad-staff')) ->> v.chapter_id))::boolean, (private.member_has_chapter_role(v.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role((select staff_chapter.organization_id from public.chapters staff_chapter where staff_chapter.id = (v.chapter_id)), array['steward','coordinator','advisor','admin','vp']))))), '[]'::jsonb) else '[]'::jsonb end,
        'attendance', case when private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id) then coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId', a.user_id, 'status', a.attendance_status) order by p.full_name) from public.meeting_attendance a join public.member_profiles p on p.id = a.user_id where a.record_id = r.id and private.chapter_records_member_allowed(r.chapter_id, a.user_id)), '[]'::jsonb) else '[]'::jsonb end,
        'dispatch', case when private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id) then coalesce((select pg_catalog.jsonb_build_object('delivered', pg_catalog.count(*) filter (where d.status = 'delivered'), 'failed', pg_catalog.count(*) filter (where d.status = 'failed')) from public.meeting_minutes_dispatches d where d.record_id = r.id and d.version = r.version), pg_catalog.jsonb_build_object('delivered', 0, 'failed', 0)) else pg_catalog.jsonb_build_object('delivered', 0, 'failed', 0) end
      ) order by r.pinned_at desc nulls last, r.occurred_at desc, r.id)
      from public.chapter_records r
      where r.chapter_id = ctx.chapter_id
        and r.archived_at is null
        and (r.record_type <> 'member_contact' or coalesce((((select private.chapter_records_scope_memo('broad-staff')) ->> r.chapter_id))::boolean, (private.member_has_chapter_role(r.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role((select staff_chapter.organization_id from public.chapters staff_chapter where staff_chapter.id = (r.chapter_id)), array['steward','coordinator','advisor','admin','vp']))))
        and ((r.access_unit_id is null and r.access_committee_id is null) or coalesce((((select private.chapter_records_scope_memo('manageable')) ->> pg_catalog.jsonb_build_array(r.chapter_id, r.access_unit_id, r.access_committee_id)::text))::boolean, private.chapter_record_manageable(r.chapter_id, r.access_unit_id, r.access_committee_id)) or (((r.access_unit_id is null and r.access_committee_id is null) or coalesce((((select private.chapter_records_scope_memo('container')) ->> pg_catalog.jsonb_build_array(r.chapter_id, r.access_unit_id, r.access_committee_id)::text))::boolean, (private.chapter_record_manageable(r.chapter_id, r.access_unit_id, r.access_committee_id) or private.chapter_scope_member_allowed(r.chapter_id, r.access_unit_id, r.access_committee_id, (select auth.uid()))))) and (coalesce((((select private.chapter_records_scope_memo('broad-staff')) ->> r.chapter_id))::boolean, (private.member_has_chapter_role(r.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role((select staff_chapter.organization_id from public.chapters staff_chapter where staff_chapter.id = (r.chapter_id)), array['steward','coordinator','advisor','admin','vp']))) or (private.chapter_record_publication(r.record_type)='chapter_members' and r.lifecycle_status='published' and r.visibility='chapter'))))
        and (private.chapter_record_publication(r.record_type)='chapter_members' or private.can_read_chapter_contact_record(ctx.chapter_id))
        and ((private.chapter_record_publication(r.record_type)='chapter_members' and private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id)) or private.can_read_chapter_contact_record(ctx.chapter_id) or (r.lifecycle_status='published' and r.visibility='chapter' and private.chapter_record_publication(r.record_type)='chapter_members' and private.chapter_scope_member_allowed(r.chapter_id,r.access_unit_id,r.access_committee_id,(select auth.uid()))))
    ), '[]'::jsonb),
    'contacts', case when private.can_read_chapter_contact_record(ctx.chapter_id) then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(l) || pg_catalog.jsonb_build_object('subjectName', p.full_name) order by l.occurred_at desc, l.id)
      from public.chapter_contact_log l
      left join public.member_profiles p on p.id = l.subject_user_id
      where l.organization_id = ctx.organization_id and l.chapter_id = ctx.chapter_id and l.archived_at is null and private.chapter_contact_entry_allowed(l.chapter_id, l.subject_user_id, l.case_id)
    ), '[]'::jsonb) else '[]'::jsonb end,
    'roster', case when ctx.staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId', p.id, 'name', p.full_name) order by p.full_name)
      from public.member_chapter_memberships cm
      join public.member_profiles p on p.id = cm.user_id
      where cm.chapter_id = ctx.chapter_id and cm.status = 'active'
        and private.chapter_records_member_allowed(ctx.chapter_id, cm.user_id)
    ), '[]'::jsonb) else '[]'::jsonb end,
    'exportRuns', case when private.has_organization_role(ctx.organization_id, array['admin','vp']) then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.created_at desc)
      from (select * from public.organization_data_export_runs where organization_id = ctx.organization_id order by created_at desc limit 20) e
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$function$;

-- public.save_chapter_contact_log (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.save_chapter_contact_log(p_contact_id uuid, p_contact_kind text, p_channel text, p_purpose text, p_summary text, p_outcome text, p_occurred_at timestamp with time zone, p_follow_up_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_subject_user_id uuid DEFAULT NULL::uuid, p_case_id uuid DEFAULT NULL::uuid, p_task_id uuid DEFAULT NULL::uuid, p_archive boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare ctx record; saved public.chapter_contact_log%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into ctx from private.institutional_context(true);
  if not private.can_read_chapter_contact_record(ctx.chapter_id) then raise exception 'contact access required' using errcode='42501'; end if;
  if p_contact_kind not in ('member','management','community','provider','other')
     or p_channel not in ('in_person','phone','email','message','meeting','other')
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose, ''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_summary, ''))) not between 1 and 4000
     or pg_catalog.char_length(coalesce(p_outcome, '')) > 1000
     or p_occurred_at is null or (p_follow_up_at is not null and p_follow_up_at < p_occurred_at) then
    raise exception 'invalid contact log' using errcode = '22023';
  end if;
  if not private.chapter_contact_entry_allowed(ctx.chapter_id, p_subject_user_id, p_case_id) then
    raise exception 'contact access required' using errcode='42501';
  end if;

  if p_subject_user_id is not null and not exists (
    select 1 from public.member_chapter_memberships cm where cm.chapter_id = ctx.chapter_id and cm.user_id = p_subject_user_id and cm.status = 'active'
  ) then raise exception 'contact subject is outside this chapter' using errcode = '42501'; end if;
  if p_case_id is not null and not exists (
    select 1 from public.member_cases c join public.member_profiles p on p.id = c.user_id
    where c.id = p_case_id and p.chapter_id = ctx.chapter_id
  ) then raise exception 'case is outside this chapter' using errcode = '42501'; end if;
  if p_task_id is not null and not exists (
    select 1 from public.chapter_tasks t where t.id = p_task_id and t.chapter_id = ctx.chapter_id
  ) then raise exception 'task is outside this chapter' using errcode = '42501'; end if;

  if p_contact_id is null then
    insert into public.chapter_contact_log (
      organization_id, chapter_id, subject_user_id, contact_kind, channel, purpose, summary,
      outcome, occurred_at, follow_up_at, case_id, task_id, created_by, updated_by, archived_at
    ) values (
      ctx.organization_id, ctx.chapter_id, p_subject_user_id, p_contact_kind, p_channel,
      pg_catalog.btrim(p_purpose), pg_catalog.btrim(p_summary), nullif(pg_catalog.btrim(p_outcome), ''),
      p_occurred_at, p_follow_up_at, p_case_id, p_task_id, ctx.caller_id, ctx.caller_id,
      case when p_archive then pg_catalog.now() end
    ) returning * into saved;
    insert into public.chapter_contact_log_versions (
      contact_id, chapter_id, version, subject_user_id, contact_kind, channel, purpose, summary,
      outcome, occurred_at, follow_up_at, case_id, task_id, archived_at, changed_by, changed_at
    ) values (
      saved.id, saved.chapter_id, 1, saved.subject_user_id, saved.contact_kind, saved.channel,
      saved.purpose, saved.summary, saved.outcome, saved.occurred_at, saved.follow_up_at,
      saved.case_id, saved.task_id, saved.archived_at, ctx.caller_id, pg_catalog.now()
    );
    insert into private.chapter_contact_log_audit (contact_id, actor_id, action, created_at)
    values (saved.id, ctx.caller_id, 'created', pg_catalog.now());
  else
    with pre as (
      select *
      from public.chapter_contact_log l
      where l.id = p_contact_id
        and l.organization_id = ctx.organization_id
        and l.chapter_id = ctx.chapter_id
        and private.chapter_contact_entry_allowed(l.chapter_id, l.subject_user_id, l.case_id)
      for update
    ),
    written as (
      update public.chapter_contact_log l set
        subject_user_id = p_subject_user_id, contact_kind = p_contact_kind, channel = p_channel,
        purpose = pg_catalog.btrim(p_purpose), summary = pg_catalog.btrim(p_summary),
        outcome = nullif(pg_catalog.btrim(p_outcome), ''), occurred_at = p_occurred_at,
        follow_up_at = p_follow_up_at, case_id = p_case_id, task_id = p_task_id,
        updated_by = ctx.caller_id, updated_at = pg_catalog.now(),
        archived_at = case when p_archive then pg_catalog.now() else null end
      from pre
      where l.id = pre.id
      returning l.*
    ),
    versioned as (
      insert into public.chapter_contact_log_versions (
        contact_id, chapter_id, version, subject_user_id, contact_kind, channel, purpose, summary,
        outcome, occurred_at, follow_up_at, case_id, task_id, archived_at, changed_by, changed_at
      )
      select
        pre.id,
        pre.chapter_id,
        (select coalesce(max(v.version), 0) + 1 from public.chapter_contact_log_versions v where v.contact_id = pre.id),
        pre.subject_user_id, pre.contact_kind, pre.channel, pre.purpose, pre.summary, pre.outcome,
        pre.occurred_at, pre.follow_up_at, pre.case_id, pre.task_id, pre.archived_at,
        ctx.caller_id, pg_catalog.now()
      from pre
      returning contact_id
    ),
    audited as (
      insert into private.chapter_contact_log_audit (contact_id, actor_id, action, created_at)
      select
        written.id,
        ctx.caller_id,
        case
          when pre.archived_at is null and written.archived_at is not null then 'archived'
          when pre.archived_at is not null and written.archived_at is null then 'unarchived'
          else 'edited'
        end,
        pg_catalog.now()
      from pre
      cross join written
      returning contact_id
    )
    select written.* into saved
    from written
    left join versioned on true
    left join audited on true;
    if saved.id is null then raise exception 'contact log not found' using errcode = 'P0002'; end if;
  end if;
  return pg_catalog.to_jsonb(saved);
end;
end;
$function$;

-- public.get_minutes_meeting_checkins (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.get_minutes_meeting_checkins(p_record_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ctx record;
  target public.chapter_records%rowtype;
begin
  select * into ctx from private.institutional_context(true);
  select * into target from public.chapter_records r
  where r.id = p_record_id and r.chapter_id = ctx.chapter_id
    and r.record_type = 'minutes' and r.archived_at is null
    and private.chapter_record_manageable(r.chapter_id, r.access_unit_id, r.access_committee_id);
  if not found then raise exception 'minutes not found' using errcode = 'P0002'; end if;
  return pg_catalog.jsonb_build_object(
    'eventId', target.event_id,
    'checkedIn', coalesce((
      select pg_catalog.jsonb_agg(checkin.user_id order by checkin.user_id)
      from (
        select distinct c.user_id
        from public.member_event_checkins c
        join public.member_events e on e.id = c.event_id and e.chapter_id = ctx.chapter_id
        join public.member_chapter_memberships cm
          on cm.user_id = c.user_id and cm.chapter_id = ctx.chapter_id and cm.status = 'active'
        where target.event_id is not null and c.event_id = target.event_id
          and private.chapter_scope_member_allowed(target.chapter_id, target.access_unit_id, target.access_committee_id, c.user_id)
          and private.chapter_records_member_allowed(ctx.chapter_id, c.user_id)
      ) checkin
    ), '[]'::jsonb)
  );
end;
$function$;

-- public.save_scoped_institutional_record (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.save_scoped_institutional_record(p_record_id uuid, p_record_type text, p_title text, p_body text, p_occurred_at timestamp with time zone, p_visibility text DEFAULT 'chapter'::text, p_action text DEFAULT 'save'::text, p_pinned boolean DEFAULT false, p_gap_note text DEFAULT NULL::text, p_expected_version integer DEFAULT NULL::integer, p_attendance jsonb DEFAULT '[]'::jsonb, p_access_unit_id uuid DEFAULT NULL::uuid, p_access_committee_id uuid DEFAULT NULL::uuid, p_expected_chapter text DEFAULT NULL::text, p_expected_organization uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare
  ctx record;
  target public.chapter_records%rowtype;
  next_status text;
  next_version integer;
  attendee jsonb;
  recipient record;
  delivered integer := 0;
begin
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:'||private.current_member_organization()::text,509));
  select * into ctx from private.institutional_context(false);
  if (p_expected_chapter is not null and p_expected_chapter is distinct from ctx.chapter_id)
    or (p_expected_organization is not null and p_expected_organization is distinct from ctx.organization_id) then
    raise exception 'chapter context changed' using errcode='42501';
  end if;
  if not private.chapter_record_manageable(ctx.chapter_id,p_access_unit_id,p_access_committee_id)
    or (p_access_unit_id is not null and p_access_committee_id is not null)
    or (p_access_unit_id is not null and not exists(select 1 from private.chapter_units where id=p_access_unit_id and chapter_id=ctx.chapter_id))
    or (p_access_committee_id is not null and not exists(select 1 from private.chapter_committees where id=p_access_committee_id and chapter_id=ctx.chapter_id)) then
    raise exception 'record outside access scope' using errcode='42501';
  end if;
  if p_record_type = 'member_contact' and not (private.member_has_chapter_role(ctx.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role((select staff_chapter.organization_id from public.chapters staff_chapter where staff_chapter.id = (ctx.chapter_id)), array['steward','coordinator','advisor','admin','vp'])) then
    raise exception 'contact access required' using errcode='42501';
  end if;
  if p_record_type in ('management_contact','member_contact') and not private.can_read_chapter_contact_record(ctx.chapter_id) then raise exception 'contact access required' using errcode='42501'; end if;
  if p_record_type not in ('minutes','decision','milestone','management_contact','member_contact')
     or p_visibility not in ('chapter','staff')
     or p_action not in ('save','publish','archive')
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title, ''))) not between 1 and 200
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_body, ''))) not between 1 and 20000
     or p_occurred_at is null
     or pg_catalog.char_length(coalesce(p_gap_note, '')) > 1000
     or pg_catalog.jsonb_typeof(coalesce(p_attendance, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_attendance, '[]'::jsonb)) > 1000 then
    raise exception 'invalid institutional record' using errcode = '22023';
  end if;

  next_status := case p_action when 'publish' then 'published' when 'archive' then 'archived' else 'draft' end;
  if p_record_id is null then
    insert into public.chapter_records (
      chapter_id, record_type, title, body, occurred_at, created_by,
      lifecycle_status, visibility, version, published_at, updated_at, pinned_at, gap_note, archived_at, access_unit_id, access_committee_id
    ) values (
      ctx.chapter_id, p_record_type, pg_catalog.btrim(p_title), pg_catalog.btrim(p_body), p_occurred_at, ctx.caller_id,
      next_status, p_visibility, 1,
      case when next_status = 'published' then pg_catalog.now() end,
      pg_catalog.now(), case when p_pinned then pg_catalog.now() end, nullif(pg_catalog.btrim(p_gap_note), ''),
      case when next_status = 'archived' then pg_catalog.now() end, p_access_unit_id, p_access_committee_id
    ) returning * into target;
  else
    select * into target from public.chapter_records r
    where r.id = p_record_id and r.chapter_id = ctx.chapter_id
    for update;
    if target.id is null then raise exception 'record not found' using errcode = 'P0002'; end if;
    if not private.chapter_record_manageable(target.chapter_id,target.access_unit_id,target.access_committee_id)
      or (target.record_type = 'member_contact' and not (private.member_has_chapter_role(ctx.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role((select staff_chapter.organization_id from public.chapters staff_chapter where staff_chapter.id = (ctx.chapter_id)), array['steward','coordinator','advisor','admin','vp'])))
      or (target.record_type in ('management_contact','member_contact') and not private.can_read_chapter_contact_record(ctx.chapter_id)) then
      raise exception 'record outside access scope' using errcode='42501';
    end if;
    if p_expected_version is null or target.version <> p_expected_version then
      raise exception 'record changed; reload before saving' using errcode = 'PT409';
    end if;
    next_version := target.version + 1;
    update public.chapter_records r set
      access_unit_id=p_access_unit_id, access_committee_id=p_access_committee_id,
      record_type = p_record_type,
      title = pg_catalog.btrim(p_title),
      body = pg_catalog.btrim(p_body),
      occurred_at = p_occurred_at,
      lifecycle_status = next_status,
      visibility = p_visibility,
      version = next_version,
      published_at = case when next_status = 'published' then pg_catalog.now() else r.published_at end,
      updated_at = pg_catalog.now(),
      pinned_at = case when p_pinned then coalesce(r.pinned_at, pg_catalog.now()) end,
      gap_note = nullif(pg_catalog.btrim(p_gap_note), ''),
      archived_at = case when next_status = 'archived' then pg_catalog.now() end
    where r.id = target.id
    returning * into target;
  end if;

  insert into public.chapter_record_versions (
    record_id, chapter_id, version, record_type, title, body, occurred_at,
    lifecycle_status, visibility, gap_note, changed_by
  ) values (
    target.id, target.chapter_id, target.version, target.record_type, target.title, target.body,
    target.occurred_at, target.lifecycle_status, target.visibility, target.gap_note, ctx.caller_id
  );

  delete from public.meeting_attendance where record_id = target.id
    and private.chapter_records_member_allowed(ctx.chapter_id, user_id);
  if target.record_type = 'minutes' then
    for attendee in select value from pg_catalog.jsonb_array_elements(p_attendance)
    loop
      if attendee->>'status' not in ('present','absent','excused','guest') or not exists (
        select 1 from public.member_chapter_memberships cm
        where cm.chapter_id = ctx.chapter_id and cm.user_id = (attendee->>'userId')::uuid and cm.status = 'active'
          and private.chapter_scope_member_allowed(ctx.chapter_id,p_access_unit_id,p_access_committee_id,cm.user_id)
          and private.chapter_records_member_allowed(ctx.chapter_id, cm.user_id)
      ) then raise exception 'invalid meeting attendance' using errcode = '22023'; end if;
      insert into public.meeting_attendance (record_id, chapter_id, user_id, attendance_status, recorded_by)
      values (target.id, ctx.chapter_id, (attendee->>'userId')::uuid, attendee->>'status', ctx.caller_id);
    end loop;

    if p_action = 'publish' and target.visibility = 'chapter' then
      for recipient in
        select cm.user_id from public.member_chapter_memberships cm
        join public.organization_memberships om on om.user_id = cm.user_id and om.organization_id = ctx.organization_id and om.status = 'active'
        where cm.chapter_id = ctx.chapter_id and cm.status = 'active'
          and private.chapter_scope_member_allowed(ctx.chapter_id,p_access_unit_id,p_access_committee_id,cm.user_id)
      loop
        begin
          perform private.notify_member(recipient.user_id, 'institutional.minutes.published', pg_catalog.jsonb_build_object('title', target.title), 'general');
          insert into public.meeting_minutes_dispatches (record_id, chapter_id, version, recipient_id, status, delivered_at)
          values (target.id, ctx.chapter_id, target.version, recipient.user_id, 'delivered', pg_catalog.now());
          delivered := delivered + 1;
        exception when others then
          insert into public.meeting_minutes_dispatches (record_id, chapter_id, version, recipient_id, status, error_code)
          values (target.id, ctx.chapter_id, target.version, recipient.user_id, 'failed', 'notification-write-failed');
        end;
      end loop;
    end if;
  end if;

  return pg_catalog.to_jsonb(target) || pg_catalog.jsonb_build_object('delivered', delivered);
end;
end;
$function$;

-- public.cancel_appointment (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.cancel_appointment(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  appt public.member_appointments%rowtype;
  caller_name text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select a.* into appt from public.member_appointments a
  where a.id = p_id and a.status = 'confirmed'
    and (a.user_id = caller or a.steward_id = caller)
  for update;
  if appt.id is null then
    raise exception 'appointment unavailable' using errcode = '22023';
  end if;
  -- The steward arm requires a live steward grant in the appointment chapter.
  if caller <> appt.user_id and not (private.member_has_chapter_role(appt.chapter_id, array['steward']) or private.chapter_staff_member_allowed(appt.chapter_id, appt.user_id, array['steward'])) then
    raise exception 'appointment unavailable' using errcode = '22023';
  end if;
  if appt.ends_at <= now() then
    raise exception 'this appointment already ended' using errcode = '22023';
  end if;

  update public.member_appointments
  set status = 'cancelled', cancelled_by = caller, updated_at = now()
  where id = appt.id;

  insert into public.member_appointment_events (appointment_id, actor, action)
  values (appt.id, caller, 'cancelled');

  select p.full_name into caller_name from public.member_profiles p where p.id = caller;
  if caller = appt.user_id then
    perform private.notify_appointment_steward(appt.steward_id, 'appointment.cancelled.steward',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'A member')), 'appointments');
  else
    perform private.notify_member(appt.user_id, 'appointment.cancelled', '{}'::jsonb, 'appointments');
  end if;

  return pg_catalog.jsonb_build_object('id', appt.id, 'status', 'cancelled');
end;
end;
$function$;

-- public.reschedule_appointment (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.reschedule_appointment(p_id uuid, p_starts_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  appt public.member_appointments%rowtype;
  caller_name text;
  replacement public.member_appointments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_starts_at is null or p_starts_at <= now() or p_starts_at > now() + interval '45 days' then
    raise exception 'appointment start is out of range' using errcode = '22023';
  end if;

  select a.* into appt from public.member_appointments a
  where a.id = p_id and a.status = 'confirmed'
    and (a.user_id = caller or a.steward_id = caller)
  for update;
  if appt.id is null then
    raise exception 'appointment unavailable' using errcode = '22023';
  end if;
  -- Same appointment-chapter live-role demand as cancel.
  if caller <> appt.user_id and not (private.member_has_chapter_role(appt.chapter_id, array['steward']) or private.chapter_staff_member_allowed(appt.chapter_id, appt.user_id, array['steward'])) then
    raise exception 'appointment unavailable' using errcode = '22023';
  end if;
  if appt.starts_at <= now() then
    raise exception 'this appointment already started' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member_appointments:' || appt.steward_id::text, 0));

  -- Cancel FIRST so the old row stops blocking its own window; if the new
  -- instant fails validation the whole transaction unwinds it.
  update public.member_appointments
  set status = 'cancelled', cancelled_by = caller, updated_at = now()
  where id = appt.id;

  if not exists (
    select 1 from private.appointment_slots_for(
      appt.steward_id, appt.duration_minutes,
      (p_starts_at at time zone 'UTC')::date - 1,
      (p_starts_at at time zone 'UTC')::date + 1) f
    where f.slot_start = p_starts_at
  ) then
    raise exception 'that time is no longer available' using errcode = '22023';
  end if;

  begin
    insert into public.member_appointments (
      user_id, steward_id, chapter_id, appointment_type, duration_minutes,
      starts_at, ends_at, status, routed_via, reason_category, rescheduled_from
    ) values (
      appt.user_id, appt.steward_id, appt.chapter_id, appt.appointment_type,
      appt.duration_minutes, p_starts_at,
      p_starts_at + appt.duration_minutes * interval '1 minute', 'confirmed',
      appt.routed_via, appt.reason_category, appt.id
    ) returning * into replacement;
  exception when exclusion_violation then
    raise exception 'that time is no longer available' using errcode = '22023';
  end;

  insert into public.member_appointment_events (appointment_id, actor, action, detail)
  values (appt.id, caller, 'rescheduled',
          pg_catalog.jsonb_build_object('replacementId', replacement.id)),
         (replacement.id, caller, 'booked',
          pg_catalog.jsonb_build_object('rescheduledFrom', appt.id));

  select p.full_name into caller_name from public.member_profiles p where p.id = caller;
  if caller = appt.user_id then
    perform private.notify_appointment_steward(appt.steward_id, 'appointment.rescheduled.steward',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'A member')), 'appointments');
  else
    perform private.notify_member(appt.user_id, 'appointment.rescheduled', '{}'::jsonb, 'appointments');
  end if;

  return pg_catalog.jsonb_build_object(
    'id', replacement.id,
    'startsAt', replacement.starts_at,
    'endsAt', replacement.ends_at,
    'status', replacement.status,
    'rescheduledFrom', appt.id);
end;
end;
$function$;

-- public.mark_appointment_outcome (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.mark_appointment_outcome(p_id uuid, p_outcome text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  appt public.member_appointments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('completed', 'no_show') then
    raise exception 'outcome must be completed or no_show' using errcode = '22023';
  end if;

  select a.* into appt from public.member_appointments a
  where a.id = p_id and a.steward_id = caller and a.status = 'confirmed'
  for update;
  if appt.id is null then
    raise exception 'appointment unavailable' using errcode = '22023';
  end if;
  -- Outcome marking binds to a live steward grant in the appointment chapter.
  if not (private.member_has_chapter_role(appt.chapter_id, array['steward']) or private.chapter_staff_member_allowed(appt.chapter_id, appt.user_id, array['steward'])) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if appt.ends_at > now() then
    raise exception 'the appointment has not ended yet' using errcode = '22023';
  end if;

  update public.member_appointments
  set status = p_outcome, updated_at = now() where id = appt.id;

  insert into public.member_appointment_events (appointment_id, actor, action)
  values (appt.id, caller, p_outcome);

  return pg_catalog.jsonb_build_object('id', appt.id, 'status', p_outcome);
end;
end;
$function$;

-- public.get_appointment_history (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.get_appointment_history(p_appointment_id uuid, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  appointment public.member_appointments%rowtype;
  reason_visible boolean;
  history_items jsonb;
  history_count integer;
  next_before timestamptz;
  next_before_id uuid;
begin
  if caller is null or not private.mfa_satisfied()
     or p_appointment_id is null or p_limit not between 1 and 50
     or ((p_before is null) <> (p_before_id is null)) then
    raise exception 'history unavailable' using errcode = '22023';
  end if;

  select * into appointment
  from public.member_appointments
  where id = p_appointment_id;

  if not found or not (
    appointment.chapter_id = private.current_member_chapter()
    and (
      caller = appointment.user_id
      or (
          caller = appointment.steward_id
          and (private.member_has_chapter_role(appointment.chapter_id, array['steward']) or private.chapter_staff_member_allowed(appointment.chapter_id, appointment.user_id, array['steward']))
      )
      or private.member_has_chapter_role(appointment.chapter_id, array['coordinator','advisor','admin'])
    )
  ) then
    raise exception 'history unavailable' using errcode = '42501';
  end if;

  reason_visible := caller = appointment.user_id
    or (
      caller = appointment.steward_id
      and (private.member_has_chapter_role(appointment.chapter_id, array['steward']) or private.chapter_staff_member_allowed(appointment.chapter_id, appointment.user_id, array['steward']))
    );

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id, 'action', e.action, 'createdAt', e.created_at,
      'actorKind', case when e.actor is null then 'system'
                        when e.actor = appointment.user_id then 'member'
                        when e.actor = appointment.steward_id then 'steward'
                        else 'chapter-staff' end,
      'detail', e.detail - 'calendarReason' - 'busyReason'
    ) order by e.created_at desc, e.id desc), '[]'::jsonb),
    pg_catalog.count(*)::integer,
    pg_catalog.min(e.created_at),
    (pg_catalog.array_agg(e.id order by e.created_at asc, e.id asc))[1]
  into history_items, history_count, next_before, next_before_id
  from (
    select *
    from public.member_appointment_events history
    where history.appointment_id = appointment.id
      and (p_before is null or (history.created_at, history.id) < (p_before, p_before_id))
    order by history.created_at desc, history.id desc
    limit p_limit
  ) e;

  return pg_catalog.jsonb_build_object(
    'appointment', pg_catalog.jsonb_build_object(
      'id', appointment.id, 'startsAt', appointment.starts_at, 'endsAt', appointment.ends_at,
      'status', appointment.status, 'appointmentType', appointment.appointment_type
    ) || case
      when reason_visible then pg_catalog.jsonb_build_object('reasonCategory', appointment.reason_category)
      else '{}'::jsonb
    end,
    'items', history_items,
    'nextBefore', case when history_count = p_limit then next_before else null end,
    'nextBeforeID', case when history_count = p_limit then next_before_id else null end
  );
end;
$function$;

-- public.set_appointment_note (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.set_appointment_note(p_appointment_id uuid, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  clean text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.member_appointments a
    where a.id = p_appointment_id and a.steward_id = caller
      and a.chapter_id = private.current_member_chapter()
      and (private.member_has_chapter_role(a.chapter_id, array['steward']) or private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward']))
  ) then
    raise exception 'appointment not found' using errcode = 'P0002';
  end if;
  if clean is null then
    delete from public.member_appointment_notes where appointment_id = p_appointment_id;
    return pg_catalog.jsonb_build_object('appointmentId', p_appointment_id, 'note', null);
  end if;
  insert into public.member_appointment_notes (appointment_id, steward_id, note)
  values (p_appointment_id, caller, clean)
  on conflict (appointment_id) do update
    set note = excluded.note, steward_id = excluded.steward_id, updated_at = pg_catalog.now();
  return pg_catalog.jsonb_build_object('appointmentId', p_appointment_id, 'note', clean);
end;
end;
$function$;

-- public.get_appointment_notes (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.get_appointment_notes(p_appointment_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_appointment_ids is null or pg_catalog.cardinality(p_appointment_ids) > 200 then
    raise exception 'between 0 and 200 appointments' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'appointmentId', n.appointment_id, 'note', n.note, 'updatedAt', n.updated_at
    ) order by n.appointment_id)
    from public.member_appointment_notes n
    join public.member_appointments a on a.id = n.appointment_id
    where n.appointment_id = any(p_appointment_ids)
      and a.steward_id = caller and n.steward_id = caller
      and a.chapter_id = private.current_member_chapter()
      -- The reader holds the writer's bar: a steward whose Steward grant is
      -- removed stops seeing their notes, though the rows stay theirs.
      and (private.member_has_chapter_role(a.chapter_id, array['steward']) or private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward']))
  ), '[]'::jsonb);
end;
$function$;

-- public.get_steward_appointments_without_place_legacy (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.get_steward_appointments_without_place_legacy()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'schedule', (
      select pg_catalog.jsonb_build_object(
        'timezone', s.timezone,
        'minNoticeMinutes', s.min_notice_minutes,
        'bufferBeforeMinutes', s.buffer_before_minutes,
        'bufferAfterMinutes', s.buffer_after_minutes,
        'maxPerDay', s.max_per_day,
        'accepting', s.accepting)
      from public.member_appointment_schedules s where s.steward_id = caller),
    'windows', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', w.id, 'weekday', w.weekday,
        'startMinute', w.start_minute, 'endMinute', w.end_minute)
        order by w.weekday, w.start_minute)
      from public.member_appointment_windows w where w.steward_id = caller), '[]'::jsonb),
    'blackouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', b.id, 'startDate', b.start_date, 'endDate', b.end_date)
        order by b.start_date)
      from public.member_appointment_blackouts b
      where b.steward_id = caller and b.end_date >= current_date), '[]'::jsonb),
    'connections', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'provider', c.provider, 'status', c.status) order by c.provider)
      from public.member_calendar_connections c where c.steward_id = caller), '[]'::jsonb),
    'upcoming', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id,
        'memberName', coalesce(p.full_name, 'Member'),
        'type', a.appointment_type,
        'durationMinutes', a.duration_minutes,
        'startsAt', a.starts_at,
        'endsAt', a.ends_at,
        'status', a.status,
        'reasonCategory', a.reason_category,
        'routedVia', a.routed_via) order by a.starts_at, a.id)
      from (
        -- ALL still-confirmed rows, including ended-but-unmarked ones:
        -- the desk's completed/no-show buttons unlock on rows
        -- whose end has passed, so an ended row filtered out here would make
        -- outcome marking unreachable in live data. The 30-day floor bounds
        -- the unmarked backlog. One pager page (50): list_steward_appointments
        -- walks the rest, and upcomingTotal below discloses the cut.
        select * from public.member_appointments a0
        where a0.steward_id = caller
      and private.chapter_staff_member_allowed(a0.chapter_id, a0.user_id, array['steward']) and a0.status = 'confirmed'
          and a0.starts_at > now() - interval '30 days'
        order by a0.starts_at, a0.id limit 50
      ) a
      left join public.member_profiles p on p.id = a.user_id), '[]'::jsonb),
    'upcomingTotal', (
      select pg_catalog.count(*) from public.member_appointments a
      where a.steward_id = caller
      and private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward']) and a.status = 'confirmed'
        and a.starts_at > now() - interval '30 days'),
    'recent', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id,
        'memberName', coalesce(p.full_name, 'Member'),
        'type', a.appointment_type,
        'durationMinutes', a.duration_minutes,
        'startsAt', a.starts_at,
        'status', a.status) order by a.starts_at desc, a.id desc)
      from (
        -- Settled rows only; ended-but-unmarked confirmed rows stay in
        -- 'upcoming' where the outcome buttons live. One pager page (20).
        select * from public.member_appointments a0
        where a0.steward_id = caller
      and private.chapter_staff_member_allowed(a0.chapter_id, a0.user_id, array['steward'])
          and a0.status in ('completed', 'no_show', 'cancelled')
          and a0.starts_at > now() - interval '30 days'
        order by a0.starts_at desc, a0.id desc limit 20
      ) a
      left join public.member_profiles p on p.id = a.user_id), '[]'::jsonb),
    'recentTotal', (
      select pg_catalog.count(*) from public.member_appointments a
      where a.steward_id = caller
      and private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward'])
        and a.status in ('completed', 'no_show', 'cancelled')
        and a.starts_at > now() - interval '30 days'),
    'stats', pg_catalog.jsonb_build_object(
      'noShows30d', (
        select pg_catalog.count(*) from public.member_appointments a
        where a.steward_id = caller
      and private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward']) and a.status = 'no_show'
          and a.starts_at > now() - interval '30 days'),
      'completed30d', (
        select pg_catalog.count(*) from public.member_appointments a
        where a.steward_id = caller
      and private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward']) and a.status = 'completed'
          and a.starts_at > now() - interval '30 days')));
end
$function$;

-- public.list_steward_appointments_without_place_legacy (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.list_steward_appointments_without_place_legacy(p_scope text DEFAULT 'upcoming'::text, p_after_starts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, member_name text, appointment_type text, duration_minutes integer, starts_at timestamp with time zone, ends_at timestamp with time zone, status text, reason_category text, routed_via text, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  total bigint;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('upcoming', 'recent') then
    raise exception 'unknown scope' using errcode = '22023';
  end if;
  if (p_after_id is null) <> (p_after_starts is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;

  if p_scope = 'upcoming' then
    -- ALL still-confirmed rows, including ended-but-unmarked ones: the desk's
    -- completed/no-show buttons unlock on rows whose end has passed, and
    -- ascending order puts exactly those rows on page one. The 30-day floor
    -- bounds the unmarked backlog, same window as the blob.
    select count(*) into total
    from public.member_appointments a
    where a.steward_id = caller
      and private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward']) and a.status = 'confirmed'
      and a.starts_at > now() - interval '30 days';

    return query
    select a.id, coalesce(p.full_name, 'Member'), a.appointment_type,
           (a.duration_minutes)::integer, a.starts_at, a.ends_at, a.status,
           a.reason_category, a.routed_via, total
    from public.member_appointments a
    left join public.member_profiles p on p.id = a.user_id
    where a.steward_id = caller
      and private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward']) and a.status = 'confirmed'
      and a.starts_at > now() - interval '30 days'
      and (p_after_id is null or (a.starts_at, a.id) > (p_after_starts, p_after_id))
    order by a.starts_at asc, a.id asc
    limit page_limit;
  else
    -- Settled rows only; ended-but-unmarked confirmed rows stay in
    -- 'upcoming' where the outcome buttons live.
    select count(*) into total
    from public.member_appointments a
    where a.steward_id = caller
      and private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward'])
      and a.status in ('completed', 'no_show', 'cancelled')
      and a.starts_at > now() - interval '30 days';

    return query
    select a.id, coalesce(p.full_name, 'Member'), a.appointment_type,
           (a.duration_minutes)::integer, a.starts_at, a.ends_at, a.status,
           a.reason_category, a.routed_via, total
    from public.member_appointments a
    left join public.member_profiles p on p.id = a.user_id
    where a.steward_id = caller
      and private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward'])
      and a.status in ('completed', 'no_show', 'cancelled')
      and a.starts_at > now() - interval '30 days'
      and (p_after_id is null or (a.starts_at, a.id) < (p_after_starts, p_after_id))
    order by a.starts_at desc, a.id desc
    limit page_limit;
  end if;
end;
$function$;

-- private.seniority_staff_can_manage (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION private.seniority_staff_can_manage(p_chapter text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- The chapter's organization is the caller's selected one, or their single
  -- active organization when no chapter is selected
  -- (private.current_mobile_staff_organization), so organization-wide staff
  -- with no chapter of their own are not shut out.
  select p_chapter is not null
    and (select auth.uid()) is not null
    and (select private.mfa_satisfied())
    and exists (
      select 1
      from public.chapters chapter
      where chapter.id = p_chapter
        and chapter.organization_id is not null
        and chapter.organization_id = (select private.current_mobile_staff_organization())
        and (
          private.member_has_chapter_staff_grant(p_chapter, array['steward', 'coordinator'])
          or (
            exists (
              select 1
              from public.organization_role_grants grant_row
              join public.organization_memberships membership
                on membership.organization_id = grant_row.organization_id
               and membership.user_id = grant_row.user_id
               and membership.status = 'active'
              where grant_row.organization_id = chapter.organization_id
                and grant_row.user_id = (select auth.uid())
                and grant_row.role in ('steward', 'coordinator')
            )
            and (
              not private.staff_mfa_required(chapter.organization_id)
              or private.has_second_factor((select auth.uid()))
            )
          )
        )
    )
$function$;

-- public.list_chapter_seniority (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.list_chapter_seniority(p_chapter_id text, p_after_date date DEFAULT NULL::date, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  cap integer := greatest(1, least(coalesce(p_limit, 50), 200));
  result jsonb;
begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if (p_after_date is null) <> (p_after_id is null) then
    raise exception 'invalid cursor' using errcode = '22023';
  end if;

  with permitted_members as materialized (
    select membership.user_id
    from public.member_chapter_memberships membership
    join public.chapters chapter on chapter.id = membership.chapter_id
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = chapter.organization_id
     and organization_membership.status = 'active'
    where membership.chapter_id = p_chapter_id and membership.status = 'active'
      and private.seniority_staff_can_manage(p_chapter_id)
      and (
        private.member_has_chapter_role(p_chapter_id, array['steward','coordinator'])
        or private.has_organization_role(
          (select private.current_mobile_staff_organization()), array['steward','coordinator'])
      )
    union
    select member.user_id from private.staff_visible_member_ids('steward') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['steward'])
    union
    select member.user_id from private.staff_visible_member_ids('coordinator') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['coordinator'])

    union
    select retained.user_id from private.chapter_seniority_entries retained
    where retained.chapter_id=p_chapter_id
      and private.seniority_staff_can_manage(p_chapter_id)
      and (private.member_has_chapter_role(p_chapter_id,array['steward','coordinator'])
        or private.has_organization_role((select private.current_mobile_staff_organization()),array['steward','coordinator']))
), page as materialized (
    select e.*, profile.full_name,
      (select pg_catalog.count(*) from private.chapter_seniority_entries earlier
        where earlier.chapter_id = e.chapter_id
          and (earlier.seniority_date, earlier.id) < (e.seniority_date, e.id))::integer + 1 as position
    from private.chapter_seniority_entries e
    left join public.member_profiles profile on profile.id = e.user_id
    where e.chapter_id = p_chapter_id
      and e.user_id in (select user_id from permitted_members)
      and (p_after_date is null or (e.seniority_date, e.id) > (p_after_date, p_after_id))
    order by e.seniority_date, e.id
    limit cap + 1
  )
  select pg_catalog.jsonb_build_object(
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id,
        'userId', p.user_id,
        'name', coalesce(nullif(pg_catalog.btrim(coalesce(p.full_name, '')), ''), 'Member'),
        'position', p.position,
        'seniorityDate', p.seniority_date,
        'classification', p.classification,
        'tieBreakNote', p.tie_break_note,
        'question', case when p.question_status is null then null else pg_catalog.jsonb_build_object(
          'status', p.question_status, 'note', p.question_note, 'askedAt', p.questioned_at,
          'answer', p.answer_note, 'answeredAt', p.answered_at) end
      ) order by p.seniority_date, p.id)
      from (select * from page order by seniority_date, id limit cap) p
    ), '[]'::jsonb),
    'nextCursor', case when (select pg_catalog.count(*) from page) > cap then (
      select pg_catalog.jsonb_build_object('afterDate', last_row.seniority_date, 'afterId', last_row.id)
      from (select seniority_date, id from page order by seniority_date, id offset cap - 1 limit 1) last_row
    ) end,
    'openQuestions', (select pg_catalog.count(*)::integer from private.chapter_seniority_entries q
      where q.chapter_id = p_chapter_id and q.question_status = 'open'
        and q.user_id in (select user_id from permitted_members))
  ) into result;
  return result;
end;
end;
$function$;

-- public.search_chapter_seniority_members (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.search_chapter_seniority_members(p_chapter_id text, p_query text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  needle text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, '')));
begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_catalog.char_length(needle) > 80 then
    raise exception 'query too long' using errcode = '22023';
  end if;
  return coalesce((
    with permitted_members as materialized (
    select membership.user_id
    from public.member_chapter_memberships membership
    join public.chapters chapter on chapter.id = membership.chapter_id
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = chapter.organization_id
     and organization_membership.status = 'active'
    where membership.chapter_id = p_chapter_id and membership.status = 'active'
      and private.seniority_staff_can_manage(p_chapter_id)
      and (
        private.member_has_chapter_role(p_chapter_id, array['steward','coordinator'])
        or private.has_organization_role(
          (select private.current_mobile_staff_organization()), array['steward','coordinator'])
      )
    union
    select member.user_id from private.staff_visible_member_ids('steward') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['steward'])
    union
    select member.user_id from private.staff_visible_member_ids('coordinator') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['coordinator'])
)
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', found.user_id, 'name', found.name, 'listed', found.listed) order by found.name, found.user_id)
    from (
      select membership.user_id,
        coalesce(nullif(pg_catalog.btrim(coalesce(profile.full_name, '')), ''), 'Member') as name,
        exists (select 1 from private.chapter_seniority_entries e
          where e.chapter_id = p_chapter_id and e.user_id = membership.user_id) as listed
      from public.member_chapter_memberships membership
      join public.member_profiles profile on profile.id = membership.user_id
      where membership.chapter_id = p_chapter_id
        and membership.status = 'active'
        and private.seniority_chapter_member(p_chapter_id, membership.user_id)
        and membership.user_id in (select user_id from permitted_members)
        and (needle = '' or pg_catalog.strpos(pg_catalog.lower(coalesce(profile.full_name, '')), needle) > 0)
      order by 2, 1
      limit 25
    ) found
  ), '[]'::jsonb);
end;
end;
$function$;

-- public.save_chapter_seniority_entry (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.save_chapter_seniority_entry(p_chapter_id text, p_user_id uuid, p_seniority_date date, p_classification text DEFAULT NULL::text, p_tie_break_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid(), p_user_id], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  entry_id uuid;
begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not (private.chapter_seniority_member_allowed(p_chapter_id, p_user_id)
    or private.member_has_chapter_role(p_chapter_id, array['steward','coordinator'])
    or private.has_organization_role(
      (select private.current_mobile_staff_organization()), array['steward','coordinator'])) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_user_id is null or p_seniority_date is null
     or not private.seniority_chapter_member(p_chapter_id, p_user_id) then
    raise exception 'member of this chapter required' using errcode = '22023', detail = 'seniority_member_required';
  end if;

  insert into private.chapter_seniority_entries as e
    (organization_id, chapter_id, user_id, seniority_date, classification, tie_break_note)
  select chapter.organization_id, chapter.id, p_user_id, p_seniority_date,
    nullif(pg_catalog.btrim(coalesce(p_classification, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_tie_break_note, '')), '')
  from public.chapters chapter where chapter.id = p_chapter_id
  on conflict (chapter_id, user_id) do update set
    seniority_date = excluded.seniority_date,
    classification = excluded.classification,
    tie_break_note = excluded.tie_break_note,
    updated_at = pg_catalog.now()
  returning e.id into entry_id;

  return pg_catalog.jsonb_build_object('id', entry_id);
end;
end;
$function$;

-- public.delete_chapter_seniority_entry (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.delete_chapter_seniority_entry(p_entry_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid(), (select e.user_id from private.chapter_seniority_entries e where e.id = p_entry_id)], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  target private.chapter_seniority_entries%rowtype;
begin
  select * into target from private.chapter_seniority_entries e where e.id = p_entry_id;
  if not found or not private.seniority_staff_can_manage(target.chapter_id)
    or not (private.chapter_seniority_member_allowed(target.chapter_id, target.user_id) or private.member_has_chapter_role(target.chapter_id,array['steward','coordinator']) or private.has_organization_role((select private.current_mobile_staff_organization()),array['steward','coordinator'])) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from private.chapter_seniority_entries e where e.id = target.id;
  return pg_catalog.jsonb_build_object('deleted', true);
end;
end;
$function$;

-- public.answer_chapter_seniority_question (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.answer_chapter_seniority_question(p_entry_id uuid, p_answer text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid(), (select e.user_id from private.chapter_seniority_entries e where e.id = p_entry_id)], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  target private.chapter_seniority_entries%rowtype;
  clean text := nullif(pg_catalog.btrim(coalesce(p_answer, '')), '');
begin
  select * into target from private.chapter_seniority_entries e where e.id = p_entry_id;
  if not found or not private.seniority_staff_can_manage(target.chapter_id)
    or not (private.chapter_seniority_member_allowed(target.chapter_id, target.user_id) or private.member_has_chapter_role(target.chapter_id,array['steward','coordinator']) or private.has_organization_role((select private.current_mobile_staff_organization()),array['steward','coordinator'])) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if target.question_status is distinct from 'open' then
    raise exception 'no open question' using errcode = '22023', detail = 'seniority_no_open_question';
  end if;
  if clean is null or pg_catalog.char_length(clean) > 1000 then
    raise exception 'answer must be between 1 and 1000 characters' using errcode = '22023';
  end if;
  update private.chapter_seniority_entries e
  set question_status = 'answered', answer_note = clean, answered_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where e.id = target.id;
  return pg_catalog.jsonb_build_object('id', target.id, 'status', 'answered');
end;
end;
$function$;

-- public.import_chapter_seniority (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.import_chapter_seniority(p_chapter_id text, p_rows jsonb, p_apply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  result jsonb;
begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' or pg_catalog.jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception 'between 1 and 500 rows are required' using errcode = '22023', detail = 'seniority_import_size';
  end if;

  with permitted_members as materialized (
    select membership.user_id
    from public.member_chapter_memberships membership
    join public.chapters chapter on chapter.id = membership.chapter_id
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = chapter.organization_id
     and organization_membership.status = 'active'
    where membership.chapter_id = p_chapter_id and membership.status = 'active'
      and private.seniority_staff_can_manage(p_chapter_id)
      and (
        private.member_has_chapter_role(p_chapter_id, array['steward','coordinator'])
        or private.has_organization_role(
          (select private.current_mobile_staff_organization()), array['steward','coordinator'])
      )
    union
    select member.user_id from private.staff_visible_member_ids('steward') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['steward'])
    union
    select member.user_id from private.staff_visible_member_ids('coordinator') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['coordinator'])
), source as (
    select item.ordinality::integer as row_number,
      pg_catalog.lower(pg_catalog.btrim(coalesce(item.value ->> 'email', ''))) as email,
      coalesce(item.value ->> 'seniorityDate', '') as raw_date,
      nullif(pg_catalog.left(pg_catalog.btrim(coalesce(item.value ->> 'classification', '')), 120), '') as classification,
      nullif(pg_catalog.left(pg_catalog.btrim(coalesce(item.value ->> 'tieBreakNote', '')), 300), '') as tie_break_note
    from pg_catalog.jsonb_array_elements(p_rows) with ordinality as item(value, ordinality)
  ), shaped as (
    -- Built from the month's first day plus the day number, which never
    -- raises: an impossible day (February 30) rolls into the next month and
    -- fails the round trip below instead of aborting the whole file.
    select source.*,
      case when source.raw_date ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$'
        then pg_catalog.to_date(pg_catalog.substr(source.raw_date, 1, 7) || '-01', 'YYYY-MM-DD')
          + (pg_catalog.substr(source.raw_date, 9, 2)::integer - 1) end as candidate
    from source
  ), dated as (
    select shaped.*,
      case when pg_catalog.to_char(shaped.candidate, 'YYYY-MM-DD') = shaped.raw_date then shaped.candidate end as seniority_date
    from shaped
  ), members as (
    -- Active members of this chapter of its organization, by sign-in email.
    select account.id, pg_catalog.lower(account.email) as email, profile.full_name
    from public.member_chapter_memberships membership
    join public.chapters chapter on chapter.id = membership.chapter_id
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = chapter.organization_id
     and organization_membership.status = 'active'
    join auth.users account on account.id = membership.user_id
    join public.member_profiles profile on profile.id = membership.user_id
    where membership.chapter_id = p_chapter_id
      and membership.status = 'active'
      and account.id in (select user_id from permitted_members)
  ), matched as (
    select dated.*, members.id as user_id, members.full_name as name,
      pg_catalog.row_number() over (partition by members.id order by dated.row_number) as copy
    from dated
    left join members on members.email = dated.email and dated.email <> ''
  ), judged as (
    select matched.*,
      case
        when matched.seniority_date is null then 'invalid_date'
        when matched.user_id is null then 'no_member'
        when matched.copy > 1 then 'duplicate'
        else 'ready'
      end as outcome
    from matched
  ), saved as (
    insert into private.chapter_seniority_entries as e
      (organization_id, chapter_id, user_id, seniority_date, classification, tie_break_note)
    select chapter.organization_id, chapter.id, judged.user_id, judged.seniority_date, judged.classification, judged.tie_break_note
    from judged
    join public.chapters chapter on chapter.id = p_chapter_id
    where coalesce(p_apply, false) and judged.outcome = 'ready'
    on conflict (chapter_id, user_id) do update set
      seniority_date = excluded.seniority_date,
      classification = excluded.classification,
      tie_break_note = excluded.tie_break_note,
      updated_at = pg_catalog.now()
    returning 1
  )
  select pg_catalog.jsonb_build_object(
    'applied', coalesce(p_apply, false),
    'saved', (select pg_catalog.count(*)::integer from saved),
    'rows', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'row', judged.row_number,
      'outcome', judged.outcome,
      'userId', case when judged.outcome in ('ready', 'duplicate') then judged.user_id end,
      'name', case when judged.outcome in ('ready', 'duplicate') then judged.name end,
      'seniorityDate', judged.seniority_date,
      'classification', judged.classification
    ) order by judged.row_number) from judged), '[]'::jsonb)
  ) into result;
  return result;
end;
end;
$function$;

-- public.list_chapter_bid_windows (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.list_chapter_bid_windows(p_chapter_id text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  cap integer := greatest(1, least(coalesce(p_limit, 20), 50));
  skip integer := greatest(0, least(coalesce(p_offset, 0), 10000));
  total integer;
  result jsonb;
  permitted_member_ids uuid[];
begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.array_agg(member.user_id),'{}'::uuid[]) into permitted_member_ids
  from (
    select membership.user_id
    from public.member_chapter_memberships membership
    join public.chapters chapter on chapter.id = membership.chapter_id
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = chapter.organization_id
     and organization_membership.status = 'active'
    where membership.chapter_id = p_chapter_id and membership.status = 'active'
      and private.seniority_staff_can_manage(p_chapter_id)
      and (
        private.member_has_chapter_role(p_chapter_id, array['steward','coordinator'])
        or private.has_organization_role(
          (select private.current_mobile_staff_organization()), array['steward','coordinator'])
      )
    union
    select member.user_id from private.staff_visible_member_ids('steward') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['steward'])
    union
    select member.user_id from private.staff_visible_member_ids('coordinator') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['coordinator'])
) member;

  select pg_catalog.count(*)::integer into total from private.chapter_bid_windows w where w.chapter_id = p_chapter_id;

  select pg_catalog.jsonb_build_object(
    'total', total,
    'nextOffset', case when skip + cap < total then skip + cap end,
    'windows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', w.id,
      'subject', w.subject,
      'opensAt', w.opens_at,
      'closesAt', w.closes_at,
      'status', w.status,
      'bidCount', (select pg_catalog.count(*)::integer from private.chapter_bid_entries counted where counted.window_id = w.id and counted.user_id = any(permitted_member_ids)),
      -- The 500 most senior bids beside each bidder's place on the seniority
      -- list (a bidder with no entry sorts last); bidCount says how many there are.
      'bids', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', b.id,
          'userId', b.user_id,
          'name', coalesce(nullif(pg_catalog.btrim(coalesce(profile.full_name, '')), ''), 'Member'),
          'choice', b.choice,
          'award', b.award,
          'awardedAt', b.awarded_at,
          'seniorityDate', b.seniority_date,
          'classification', b.classification
        ) order by b.seniority_date nulls last, b.entry_id nulls last, b.recorded_at, b.id)
        from (
          select x.*, entry.seniority_date, entry.classification, entry.id as entry_id
          from private.chapter_bid_entries x
          left join private.chapter_seniority_entries entry on entry.chapter_id = w.chapter_id and entry.user_id = x.user_id
          where x.window_id = w.id and x.user_id = any(permitted_member_ids)
          order by entry.seniority_date nulls last, entry.id nulls last, x.recorded_at, x.id
          limit 500
        ) b
        left join public.member_profiles profile on profile.id = b.user_id
      ), '[]'::jsonb)
    ) order by w.closes_at desc, w.id), '[]'::jsonb)
  ) into result
  from (
    select * from private.chapter_bid_windows page
    where page.chapter_id = p_chapter_id
    order by page.closes_at desc, page.id
    limit cap offset skip
  ) w;
  return result;
end;
end;
$function$;

-- public.record_chapter_bid (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.record_chapter_bid(p_window_id uuid, p_user_id uuid, p_choice text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid(), p_user_id], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  target private.chapter_bid_windows%rowtype;
  clean text := pg_catalog.btrim(coalesce(p_choice, ''));
  bid_id uuid;
  prior private.chapter_bid_entries%rowtype;
  cleared boolean := false;
begin
  select * into target from private.chapter_bid_windows w where w.id = p_window_id;
  if not found or not private.seniority_staff_can_manage(target.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Open by status and by the clock: no bid before the window opens or
  -- after it closes, even if nobody has marked it awarded yet.
  if target.status <> 'open' or pg_catalog.now() < target.opens_at or pg_catalog.now() >= target.closes_at then
    raise exception 'bid window is not open' using errcode = '22023', detail = 'bid_window_closed';
  end if;
  if not (private.chapter_seniority_member_allowed(target.chapter_id, p_user_id)
    or private.member_has_chapter_role(target.chapter_id, array['steward','coordinator'])
    or private.has_organization_role(
      (select private.current_mobile_staff_organization()), array['steward','coordinator'])) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_user_id is null or not private.seniority_chapter_member(target.chapter_id, p_user_id) then
    raise exception 'member of this chapter required' using errcode = '22023', detail = 'seniority_member_required';
  end if;
  if pg_catalog.char_length(clean) not between 1 and 200 then
    raise exception 'choice must be between 1 and 200 characters' using errcode = '22023';
  end if;

  -- The bid as it stands, locked: an award made for another choice no longer
  -- describes this bid.
  select * into prior from private.chapter_bid_entries b
  where b.window_id = target.id and b.user_id = p_user_id
  for update;
  cleared := prior.id is not null and prior.award is not null and prior.choice is distinct from clean;

  insert into private.chapter_bid_entries as b (window_id, user_id, choice)
  values (target.id, p_user_id, clean)
  on conflict (window_id, user_id) do update set
    choice = excluded.choice,
    recorded_at = pg_catalog.now(),
    award = case when b.choice is distinct from excluded.choice then null else b.award end,
    awarded_at = case when b.choice is distinct from excluded.choice then null else b.awarded_at end
  returning b.id into bid_id;
  return pg_catalog.jsonb_build_object('id', bid_id, 'awardCleared', cleared);
end;
end;
$function$;

-- public.list_chapter_bid_window_bids (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.list_chapter_bid_window_bids(p_window_id uuid, p_offset integer DEFAULT 0, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  target private.chapter_bid_windows%rowtype;
  cap integer := greatest(1, least(coalesce(p_limit, 100), 500));
  -- No upper bound on the offset: every bid of a window stays reachable
  -- (gate r2s3). nextOffset is computed only below the total, so it cannot
  -- overflow.
  skip integer := greatest(0, coalesce(p_offset, 0));
  total integer;
  page jsonb;
  permitted_member_ids uuid[];
begin
  select * into target from private.chapter_bid_windows w where w.id = p_window_id;
  if not found or not private.seniority_staff_can_manage(target.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.array_agg(member.user_id),'{}'::uuid[]) into permitted_member_ids
  from (
    select membership.user_id
    from public.member_chapter_memberships membership
    join public.chapters chapter on chapter.id = membership.chapter_id
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = chapter.organization_id
     and organization_membership.status = 'active'
    where membership.chapter_id = target.chapter_id and membership.status = 'active'
      and private.seniority_staff_can_manage(target.chapter_id)
      and (
        private.member_has_chapter_role(target.chapter_id, array['steward','coordinator'])
        or private.has_organization_role(
          (select private.current_mobile_staff_organization()), array['steward','coordinator'])
      )
    union
    select member.user_id from private.staff_visible_member_ids('steward') member(user_id)
      where private.member_has_chapter_staff_grant(target.chapter_id, array['steward'])
    union
    select member.user_id from private.staff_visible_member_ids('coordinator') member(user_id)
      where private.member_has_chapter_staff_grant(target.chapter_id, array['coordinator'])
) member;

  select pg_catalog.count(*)::integer into total from private.chapter_bid_entries counted where counted.window_id = target.id and counted.user_id = any(permitted_member_ids);

  -- The order and fields of list_chapter_bid_windows' first 500, so page
  -- offset 500 continues exactly where that list stops.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', b.id,
      'userId', b.user_id,
      'name', coalesce(nullif(pg_catalog.btrim(coalesce(profile.full_name, '')), ''), 'Member'),
      'choice', b.choice,
      'award', b.award,
      'awardedAt', b.awarded_at,
      'seniorityDate', b.seniority_date,
      'classification', b.classification
    ) order by b.seniority_date nulls last, b.entry_id nulls last, b.recorded_at, b.id), '[]'::jsonb)
  into page
  from (
    select x.*, entry.seniority_date, entry.classification, entry.id as entry_id
    from private.chapter_bid_entries x
    left join private.chapter_seniority_entries entry on entry.chapter_id = target.chapter_id and entry.user_id = x.user_id
    where x.window_id = target.id and x.user_id = any(permitted_member_ids)
    order by entry.seniority_date nulls last, entry.id nulls last, x.recorded_at, x.id
    limit cap offset skip
  ) b
  left join public.member_profiles profile on profile.id = b.user_id;

  return pg_catalog.jsonb_build_object(
    'windowId', target.id,
    'total', total,
    'nextOffset', case when skip::bigint + cap < total then skip + cap end,
    'bids', page
  );
end;
end;
$function$;

-- public.award_chapter_bid (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.award_chapter_bid(p_bid_id uuid, p_award text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid(), (select b.user_id from private.chapter_bid_entries b where b.id = p_bid_id)], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  bid private.chapter_bid_entries%rowtype;
  target private.chapter_bid_windows%rowtype;
  clean text := nullif(pg_catalog.btrim(coalesce(p_award, '')), '');
begin
  select * into bid from private.chapter_bid_entries b where b.id = p_bid_id;
  if found then
    select * into target from private.chapter_bid_windows w where w.id = bid.window_id;
  end if;
  -- a project decision: broad staff may only clear an existing
  -- inactive subject's award. Scoped staff retain the member restriction;
  -- assigning or changing an award still requires an active member.
  if bid.id is null or target.id is null or not private.seniority_staff_can_manage(target.chapter_id)
    or not (
      private.chapter_seniority_member_allowed(target.chapter_id, bid.user_id)
      or (
        clean is null and bid.award is not null
        and not private.seniority_chapter_member(target.chapter_id, bid.user_id)
        and (
          private.member_has_chapter_role(target.chapter_id, array['steward','coordinator'])
          or private.has_organization_role(
            (select private.current_mobile_staff_organization()), array['steward','coordinator'])
        )
      )
    ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if target.status = 'cancelled' then
    raise exception 'bid window is cancelled' using errcode = '22023', detail = 'bid_window_closed';
  end if;
  if clean is not null and pg_catalog.char_length(clean) > 200 then
    raise exception 'award must be at most 200 characters' using errcode = '22023';
  end if;
  update private.chapter_bid_entries b
  set award = clean, awarded_at = case when clean is null then null else pg_catalog.now() end
  where b.id = bid.id;
  return pg_catalog.jsonb_build_object('id', bid.id, 'award', clean);
end;
end;
$function$;

-- public.record_member_access_event (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.record_member_access_event(p_expected_organization_id uuid, p_subject_user_id uuid, p_action text, p_entity_type text, p_entity_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  caller uuid := (select auth.uid());
  selected_chapter text := private.current_member_chapter();
  role text;
  saved public.member_access_events%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not (
    private.has_organization_role(
      org,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
    or (
      selected_chapter is not null
      and exists (
        select 1
        from public.chapters chapter
        where chapter.id = selected_chapter
          and chapter.organization_id = org
      )
      and private.member_has_chapter_staff_grant(
        selected_chapter,
        array['steward', 'coordinator', 'advisor', 'admin', 'vp']
      )
    )
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_subject_user_id is null or p_subject_user_id is not distinct from caller then
    raise exception 'cannot record self access' using errcode = '22023';
  end if;
  if p_action is null or p_action not in ('viewed_profile', 'viewed_case', 'updated_profile', 'updated_case') then
    raise exception 'invalid action' using errcode = '22023';
  end if;
  if p_entity_type is null or p_entity_type not in ('member', 'case') then
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
  select hat.role into role
  from (
    select r.role
    from public.organization_role_grants r
    where r.organization_id = org
      and r.user_id = caller
    union
    select rc.role
    from public.member_role_chapters rc
    join public.chapters chapter
      on chapter.id = rc.chapter_id
     and chapter.organization_id = org
    join public.member_chapter_memberships m
      on m.user_id = rc.user_id
     and m.chapter_id = rc.chapter_id
     and m.status = 'active'
    where rc.user_id = caller
      and rc.chapter_id = selected_chapter
  ) hat
  where hat.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
    and public.staff_can_see_user(p_subject_user_id, hat.role)
  order by case hat.role
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

-- private.casework_may_manage_case_access (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION private.casework_may_manage_case_access(p_case_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.member_cases c
    where c.id = p_case_id
      and private.casework_staff_can_access(c.id)
      and (private.member_has_chapter_staff_grant(c.chapter_id, array['steward','coordinator','advisor','admin','vp'])
           or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])));
$function$;

-- public.casework_revoke_access (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.casework_revoke_access(p_grant_id uuid)
 RETURNS casework_access_grants
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_row public.casework_access_grants%rowtype; v_before jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  -- Resolve the parent without a child lock, then acquire case before grant.
  -- Re-read the grant after waiting; the case may have been deleted meanwhile.
  select * into strict v_row from public.casework_access_grants where id = p_grant_id;
  perform 1 from public.member_cases where id = v_row.case_id for update;
  if not found then raise exception 'grant not found' using errcode = 'P0002'; end if;
  select * into strict v_row from public.casework_access_grants where id = p_grant_id for update;
  if not private.casework_staff_can_access(v_row.case_id)
     or not (private.member_has_chapter_staff_grant(v_row.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role(v_row.organization_id, array['advisor','admin','vp']))
  then raise exception 'grant not found' using errcode = 'P0002'; end if;
  if v_row.revoked_at is not null then return v_row; end if;
  v_before := private.learning_case_access_state(v_row.case_id, v_row.grantee_user_id);
  update public.casework_access_grants set revoked_at = pg_catalog.now(), revoked_by = (select auth.uid()) where id = v_row.id returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()), 'access_revoked', 'casework_access_grant', v_row.id, pg_catalog.jsonb_build_object('granteeUserId', v_row.grantee_user_id));
  -- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103.
  if private.learning_case_in_own_organization(v_row.case_id) then
    perform private.learning_journal_append(
      'case_access_revoke', 'public.casework_access_grants', v_row.case_id::text || ':' || v_row.grantee_user_id::text, null,
      private.learning_fingerprint(private.learning_case_access_state(v_row.case_id, v_row.grantee_user_id)), null,
      v_before || pg_catalog.jsonb_build_object('audit_floor', (
        select pg_catalog.max(a.id) from public.casework_audit_events a
        where a.case_id = v_row.case_id and a.event_type in ('access_granted', 'access_revoked')
          and a.metadata ->> 'granteeUserId' = v_row.grantee_user_id::text)));
  end if;
  return v_row;
end;
$function$;

-- private.casework_history_versions (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION private.casework_history_versions(p_case_id uuid)
 RETURNS TABLE(event_id text, kind text, at timestamp with time zone, actor_user_id uuid, details jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select 'version:' || v.id, 'fields'::text, v.at, v.actor,
    pg_catalog.jsonb_build_object('table', v.record_table, 'op', v.op, 'changes', changes.value)
  from private.casework_record_versions v
  cross join lateral (
    select pg_catalog.jsonb_object_agg(k.key, pg_catalog.jsonb_build_object(
      'old', v.old_row -> k.key, 'new', v.new_row -> k.key)) value
    from (select pg_catalog.jsonb_object_keys(coalesce(v.old_row, '{}'::jsonb) || coalesce(v.new_row, '{}'::jsonb)) key) k
    where (v.old_row -> k.key) is distinct from (v.new_row -> k.key)
      and k.key <> all(array['updated_at','encrypted_content','encryption_version','idempotency_key'])
      and (private.casework_staff_can_access(p_case_id)
        or (v.record_table = 'member_cases' and k.key = 'deadline')
        or (v.record_table = 'casework_deadlines' and k.key = any(array['label','kind','due_at','status']))
        or (v.record_table = 'casework_deadline_extensions' and k.key = any(array['previous_due_at','requested_due_at','status','decided_at'])))
  ) changes
  where v.case_id = p_case_id and private.mfa_satisfied()
    and private.casework_can_read(p_case_id) and changes.value is not null
    and (
      v.record_table = any(array['member_cases','casework_deadlines','casework_deadline_extensions'])
      or (private.casework_staff_can_access(p_case_id) and (
        v.record_table = any(array['casework_strength_analyses','casework_checklists','casework_checklist_items',
          'casework_alerts','casework_alert_acknowledgements'])
        or (v.record_table = any(array['casework_management_entries','casework_management_addenda','casework_retaliation_reports'])
          and private.member_has_chapter_staff_grant(v.chapter_id, array['steward','coordinator','advisor','admin','vp']))
        or (v.record_table = any(array['casework_intake_drafts','casework_reminders'])
          and coalesce(v.new_row, v.old_row) ->> 'owner_user_id' = auth.uid()::text
          and (v.record_table <> 'casework_intake_drafts' or (private.member_has_chapter_staff_grant(v.chapter_id, array['steward','coordinator','advisor','admin','vp'])
            and (v.old_row ->> 'member_user_id' is null or private.chapter_staff_member_allowed(v.old_row ->> 'chapter_id', (v.old_row ->> 'member_user_id')::uuid, array['steward','coordinator','advisor','admin','vp']))
            and (v.old_row ->> 'case_id' is null or private.casework_staff_can_access((v.old_row ->> 'case_id')::uuid))
            and (v.new_row ->> 'member_user_id' is null or private.chapter_staff_member_allowed(v.new_row ->> 'chapter_id', (v.new_row ->> 'member_user_id')::uuid, array['steward','coordinator','advisor','admin','vp']))
            and (v.new_row ->> 'case_id' is null or private.casework_staff_can_access((v.new_row ->> 'case_id')::uuid)))))
        or (v.record_table = 'casework_access_grants' and (
          coalesce(v.new_row, v.old_row) ->> 'grantee_user_id' = auth.uid()::text
          or exists (select 1 from public.member_cases c where c.id = p_case_id
            and (c.steward_user_id = auth.uid() or c.coordinator_user_id = auth.uid()
              or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])))))
        or (v.record_table = 'casework_entity_links'
          and (v.old_row ->> 'target_case_id' is null or private.casework_staff_can_access((v.old_row ->> 'target_case_id')::uuid))
          and (v.new_row ->> 'target_case_id' is null or private.casework_staff_can_access((v.new_row ->> 'target_case_id')::uuid)))
      ))
    );
$function$;

-- public.casework_add_management_addendum (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.casework_add_management_addendum(p_entry_id uuid, p_body text)
 RETURNS casework_management_addenda
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_entry public.casework_management_entries%rowtype; v_row public.casework_management_addenda%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  select * into strict v_entry from public.casework_management_entries where id = p_entry_id for share;
  if not private.member_has_chapter_staff_grant(v_entry.chapter_id, array['steward','coordinator','advisor','admin','vp']) or (case when v_entry.case_id is not null then not private.casework_staff_can_access(v_entry.case_id) else not coalesce(private.account_lifecycle_retained_case_scope_allows('management_entry', v_entry.id::text, v_entry.chapter_id), true) end) then raise exception 'entry not found' using errcode = 'P0002'; end if;
  insert into public.casework_management_addenda(entry_id, organization_id, body, created_by)
  values (v_entry.id, v_entry.organization_id, pg_catalog.btrim(p_body), (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_entry.organization_id, v_entry.chapter_id, v_entry.case_id, (select auth.uid()), 'behavior_addendum_added', 'management_addendum', v_row.id);
  -- Audit rows produced after detachment inherit the entry's retained inputs.
  insert into private.account_lifecycle_history_scope(kind, record_id, case_id)
  select 'casework_audit', a.id::text, h.case_id
  from public.casework_audit_events a
  join private.account_lifecycle_history_scope h on h.kind = 'management_entry' and h.record_id = v_entry.id::text
  where a.entity_id = v_row.id and a.entity_type = 'management_addendum'
  on conflict (kind, record_id) do update set case_id = excluded.case_id;
  return v_row;
end;
$function$;

-- private.case_signals_staff_organization (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION private.case_signals_staff_organization(p_selected_hat text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid;
  hat text := coalesce(nullif(pg_catalog.btrim(coalesce(p_selected_hat, '')), ''), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  org := private.mi1_require_selected_organization();
  if hat not in ('steward', 'coordinator', 'admin') then
    raise exception 'staff hat required' using errcode = '42501';
  end if;
  if not (
    private.has_organization_role(org, array[hat])
    or exists (
      select 1 from public.chapters c
      where c.organization_id = org and private.member_has_chapter_staff_grant(c.id, array[hat])
    )
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return org;
end;
$function$;

-- private.issue_digest_staff_organization (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION private.issue_digest_staff_organization(p_selected_hat text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid;
  hat text := coalesce(nullif(pg_catalog.btrim(coalesce(p_selected_hat, '')), ''), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  org := private.mi1_require_selected_organization();
  if hat not in ('steward', 'coordinator', 'admin') then
    raise exception 'staff hat required' using errcode = '42501';
  end if;
  if not (
    private.has_organization_role(org, array[hat])
    or exists (
      select 1 from public.chapters c
      where c.organization_id = org and private.member_has_chapter_staff_grant(c.id, array[hat])
    )
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  return org;
end;
$function$;

-- public.get_issue_intelligence_signals (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.get_issue_intelligence_signals(p_selected_hat text DEFAULT 'member'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid;
  hat text := coalesce(nullif(pg_catalog.btrim(coalesce(p_selected_hat, '')), ''), 'member');
  staff boolean := false;
  signals jsonb;
  projected jsonb := '[]'::jsonb;
  item jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  org := private.mi1_require_selected_organization();
  if not private.is_organization_member(org) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  if hat not in ('member', 'steward', 'coordinator', 'admin') then
    raise exception 'invalid hat' using errcode = '22023';
  end if;
  if hat <> 'member' then
    staff := private.has_organization_role(org, array[hat])
      or exists (
        select 1 from public.chapters c
        where c.organization_id = org
          and private.member_has_chapter_staff_grant(c.id, array[hat])
      );
    if not staff then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;

  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  if not private.organization_feature_enabled(org, 'features.intelligence.issue_signals') then
    return pg_catalog.jsonb_build_object('enabled', false, 'viewer', case when staff then 'staff' else 'member' end, 'signals', '[]'::jsonb);
  end if;

  signals := private.issue_intelligence_visible_signals(org, pg_catalog.now());
  for item in select value from pg_catalog.jsonb_array_elements(signals) loop
    if staff then
      projected := projected || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'family', item -> 'family',
        'threadKey', item -> 'threadKey',
        'confidence', item -> 'confidence',
        'evidenceFamilies', item -> 'evidenceFamilies',
        'trend', item -> 'trend'
      ));
    else
      projected := projected || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'family', item -> 'family',
        'threadKey', item -> 'threadKey'
      ));
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'enabled', true,
    'viewer', case when staff then 'staff' else 'member' end,
    'windowDays', 30,
    'signals', projected
  );
end;
$function$;

-- public.civic_is_org_officer (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.civic_is_org_officer(p_org text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select auth.uid()) is not null
    and p_org is not null
    and (select private.mfa_satisfied())
    -- The host tenant rule (private.current_member_organization): a chapter
    -- counts only while its organization is active and the caller's
    -- organization membership is active. A suspended or archived organization
    -- takes its chapters' civic access with it.
    and exists (
      select 1
      from public.chapters chapter
      join public.organizations organization
        on organization.id = chapter.organization_id
       and organization.status = 'active'
      join public.organization_memberships organization_membership
        on organization_membership.organization_id = organization.id
       and organization_membership.user_id = (select auth.uid())
       and organization_membership.status = 'active'
      where chapter.id = p_org
    )
    and exists (
      select 1
      from public.chapters target_chapter
      where target_chapter.id = p_org
        and (
          (
            target_chapter.organization_id is not null
            and target_chapter.organization_id = (select private.current_member_organization())
            and private.has_organization_role(target_chapter.organization_id,
              array['steward', 'coordinator', 'vp', 'admin']::text[])
          )
          or private.member_has_chapter_staff_grant(target_chapter.id,
            array['steward', 'coordinator', 'vp', 'admin']::text[])
        )
    );
$function$;

-- public.casework_save_intake_draft (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION public.casework_save_intake_draft(p_draft_id uuid, p_chapter_id text, p_member_user_id uuid, p_case_id uuid, p_payload jsonb, p_expected_revision integer)
 RETURNS casework_intake_drafts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare v_org uuid; v_row public.casework_intake_drafts%rowtype;
begin
  perform private.casework_require_mfa();
  select c.organization_id into strict v_org from public.chapters c where c.id = p_chapter_id;
  if v_org is null or not private.member_has_chapter_staff_grant(p_chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  if p_member_user_id is not null and not private.chapter_staff_member_allowed(p_chapter_id, p_member_user_id, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' or pg_catalog.pg_column_size(p_payload) > 32768 then raise exception 'invalid draft payload' using errcode = '22023'; end if;
  if p_case_id is not null and (not private.casework_scope_matches(p_case_id, v_org, p_chapter_id) or not private.casework_staff_can_access(p_case_id)) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_draft_id is null then
    insert into public.casework_intake_drafts(organization_id, chapter_id, owner_user_id, member_user_id, case_id, payload)
    values (v_org, p_chapter_id, (select auth.uid()), p_member_user_id, p_case_id, p_payload) returning * into v_row;
  else
    update public.casework_intake_drafts set member_user_id = p_member_user_id, case_id = p_case_id, payload = p_payload, revision = revision + 1, updated_at = pg_catalog.now()
    where id = p_draft_id and owner_user_id = (select auth.uid()) and revision = p_expected_revision
      and organization_id = v_org and chapter_id = p_chapter_id
      and (member_user_id is null or private.chapter_staff_member_allowed(chapter_id, member_user_id, array['steward','coordinator','advisor','admin','vp']))
      and (case_id is null or private.casework_staff_can_access(case_id)) returning * into v_row;
    if not found then raise exception 'draft changed' using errcode = 'PT409'; end if;
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, p_chapter_id, p_case_id, (select auth.uid()), 'draft_saved', 'intake_draft', v_row.id, pg_catalog.jsonb_build_object('revision', v_row.revision));
  perform private.learning_casework_journal('casework_draft_save', null, true);
  return v_row;
end;
end;
$function$;

-- private.learning_undo_casework (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION private.learning_undo_casework(p_mode text, p_entry jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  t text := pg_catalog.substr(p_entry ->> 'target_table', 8);
  target text := p_entry ->> 'target_id';
  v private.casework_record_versions%rowtype;
  v_row jsonb;
begin
  select r.* into v from private.casework_record_versions r where r.id = (p_entry ->> 'before_ref')::bigint;
  v_row := coalesce(v.new_row, v.old_row);
  if p_mode = 'lock' then
    case t
      when 'casework_step_transitions' then perform 1 from public.casework_step_transitions x where x.id::text = target for update;
      when 'casework_deadlines' then perform 1 from public.casework_deadlines x where x.id::text = target for update;
      when 'casework_deadline_extensions' then perform 1 from public.casework_deadline_extensions x where x.id::text = target for update;
      when 'casework_checklists' then perform 1 from public.casework_checklists x where x.id::text = target for update;
      when 'casework_checklist_items' then perform 1 from public.casework_checklist_items x where x.id::text = target for update;
      when 'casework_reminders' then perform 1 from public.casework_reminders x where x.id::text = target for update;
      when 'casework_intake_drafts' then perform 1 from public.casework_intake_drafts x where x.id::text = target for update;
      when 'casework_strength_analyses' then perform 1 from public.casework_strength_analyses x where x.id::text = target for update;
      else null;
    end case;
    return null;
  elsif p_mode = 'state' then
    return private.learning_casework_row_state(t, target);
  elsif p_mode = 'before' then
    return case when v.old_row is null then null else private.learning_casework_stable(t, v.old_row) end;
  elsif p_mode = 'check' then
    if v.id is null or v.record_table is distinct from t or v.record_id is distinct from target then
      raise exception 'this practice action can no longer be undone' using errcode = '55000';
    end if;
    -- Today's rule of the writer that made the change, per table and
    -- operation: a reminder is its owner's while they can still read the
    -- case; a draft is its writer's while they still hold the drafting role
    -- (and the case it names is in scope); an extension request is its
    -- requester's while they may still request one (the case's member or
    -- staff who can work on it); every other workflow change (steps,
    -- deadlines, decisions, checklists, scores) needs staff who can work on
    -- the case today.
    if not private.mfa_satisfied() or not coalesce(case
         when t = 'casework_reminders' then
           (v_row ->> 'owner_user_id')::uuid = caller and private.casework_can_read((v_row ->> 'case_id')::uuid)
         when t = 'casework_intake_drafts' then
           v.actor = caller
           and private.member_has_chapter_staff_grant(v_row ->> 'chapter_id', array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
           and (v_row ->> 'member_user_id' is null or private.chapter_staff_member_allowed(v_row ->> 'chapter_id', (v_row ->> 'member_user_id')::uuid, array['steward','coordinator','advisor','admin','vp']))
           and (v.old_row ->> 'member_user_id' is null or private.chapter_staff_member_allowed(v.old_row ->> 'chapter_id', (v.old_row ->> 'member_user_id')::uuid, array['steward','coordinator','advisor','admin','vp']))
           and (v_row ->> 'case_id' is null or private.casework_staff_can_access((v_row ->> 'case_id')::uuid))
           and (v.old_row ->> 'case_id' is null or private.casework_staff_can_access((v.old_row ->> 'case_id')::uuid))
           and (v_row ->> 'case_id' is null or private.casework_scope_matches((v_row ->> 'case_id')::uuid,
             (v_row ->> 'organization_id')::uuid, v_row ->> 'chapter_id'))
         when v.case_id is null then false
         when t = 'casework_deadline_extensions' and v.op = 'INSERT' then
           v.actor = caller and private.casework_can_read(v.case_id)
           and (private.casework_member_owns(v.case_id) or private.casework_staff_can_access(v.case_id))
         else private.casework_staff_can_access(v.case_id)
       end, false) then
      raise exception 'you can no longer change this case' using errcode = '42501';
    end if;
    -- Taking away a deadline someone asked to extend would detach the request.
    if v.op = 'INSERT' and t = 'casework_deadlines'
       and exists (select 1 from public.casework_deadline_extensions e where e.deadline_id::text = target) then
      raise exception 'this has changed since your practice action' using errcode = 'PT409';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if v.op = 'INSERT' then
    if t = 'casework_step_transitions' then
      perform private.learning_reverse_transition((v.new_row ->> 'case_id')::uuid, v.new_row ->> 'to_step', v.new_row ->> 'from_step');
    else
      case t
        when 'casework_deadlines' then delete from public.casework_deadlines x where x.id::text = target;
        when 'casework_deadline_extensions' then delete from public.casework_deadline_extensions x where x.id::text = target;
        when 'casework_checklists' then delete from public.casework_checklists x where x.id::text = target;
        when 'casework_checklist_items' then delete from public.casework_checklist_items x where x.id::text = target;
        when 'casework_reminders' then delete from public.casework_reminders x where x.id::text = target;
        when 'casework_intake_drafts' then delete from public.casework_intake_drafts x where x.id::text = target;
        when 'casework_strength_analyses' then delete from public.casework_strength_analyses x where x.id::text = target;
        else null;
      end case;
    end if;
  elsif v.op = 'UPDATE' then
    case t
        when 'casework_step_transitions' then update public.casework_step_transitions x set (case_id, organization_id, chapter_id, from_step, to_step, outcome, transitioned_by, idempotency_key, created_at, procedure_transaction_id) =
          (select r.case_id, r.organization_id, r.chapter_id, r.from_step, r.to_step, r.outcome, r.transitioned_by, r.idempotency_key, r.created_at, r.procedure_transaction_id from pg_catalog.jsonb_populate_record(null::public.casework_step_transitions, v.old_row) r)
          where x.id::text = target;
        when 'casework_deadlines' then update public.casework_deadlines x set (case_id, organization_id, chapter_id, kind, label, due_at, status, reminder_at, created_by, created_at, updated_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.kind, r.label, r.due_at, r.status, r.reminder_at, r.created_by, r.created_at, r.updated_at from pg_catalog.jsonb_populate_record(null::public.casework_deadlines, v.old_row) r)
          where x.id::text = target;
        when 'casework_deadline_extensions' then update public.casework_deadline_extensions x set (deadline_id, organization_id, requested_by, previous_due_at, requested_due_at, reason, status, decided_by, decided_at, decision_note, idempotency_key, created_at) =
          (select r.deadline_id, r.organization_id, r.requested_by, r.previous_due_at, r.requested_due_at, r.reason, r.status, r.decided_by, r.decided_at, r.decision_note, r.idempotency_key, r.created_at from pg_catalog.jsonb_populate_record(null::public.casework_deadline_extensions, v.old_row) r)
          where x.id::text = target;
        when 'casework_checklists' then update public.casework_checklists x set (case_id, organization_id, chapter_id, template_id, step, title, created_by, created_at, completed_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.template_id, r.step, r.title, r.created_by, r.created_at, r.completed_at from pg_catalog.jsonb_populate_record(null::public.casework_checklists, v.old_row) r)
          where x.id::text = target;
        when 'casework_checklist_items' then update public.casework_checklist_items x set (checklist_id, organization_id, label, position, required, completed_at, completed_by) =
          (select r.checklist_id, r.organization_id, r.label, r.position, r.required, r.completed_at, r.completed_by from pg_catalog.jsonb_populate_record(null::public.casework_checklist_items, v.old_row) r)
          where x.id::text = target;
        when 'casework_reminders' then update public.casework_reminders x set (case_id, organization_id, chapter_id, owner_user_id, title, remind_at, recurrence, status, completed_at, created_at, updated_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.owner_user_id, r.title, r.remind_at, r.recurrence, r.status, r.completed_at, r.created_at, r.updated_at from pg_catalog.jsonb_populate_record(null::public.casework_reminders, v.old_row) r)
          where x.id::text = target;
        when 'casework_intake_drafts' then update public.casework_intake_drafts x set (organization_id, chapter_id, owner_user_id, member_user_id, case_id, payload, revision, created_at, updated_at) =
          (select r.organization_id, r.chapter_id, r.owner_user_id, r.member_user_id, r.case_id, r.payload, r.revision, r.created_at, r.updated_at from pg_catalog.jsonb_populate_record(null::public.casework_intake_drafts, v.old_row) r)
          where x.id::text = target;
        when 'casework_strength_analyses' then update public.casework_strength_analyses x set (case_id, organization_id, chapter_id, analyzed_by, inputs, score, band, recommendations, idempotency_key, created_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.analyzed_by, r.inputs, r.score, r.band, r.recommendations, r.idempotency_key, r.created_at from pg_catalog.jsonb_populate_record(null::public.casework_strength_analyses, v.old_row) r)
          where x.id::text = target;
      else null;
    end case;
  else
    case t
        when 'casework_step_transitions' then insert into public.casework_step_transitions select * from pg_catalog.jsonb_populate_record(null::public.casework_step_transitions, v.old_row);
        when 'casework_deadlines' then insert into public.casework_deadlines select * from pg_catalog.jsonb_populate_record(null::public.casework_deadlines, v.old_row);
        when 'casework_deadline_extensions' then insert into public.casework_deadline_extensions select * from pg_catalog.jsonb_populate_record(null::public.casework_deadline_extensions, v.old_row);
        when 'casework_checklists' then insert into public.casework_checklists select * from pg_catalog.jsonb_populate_record(null::public.casework_checklists, v.old_row);
        when 'casework_checklist_items' then insert into public.casework_checklist_items select * from pg_catalog.jsonb_populate_record(null::public.casework_checklist_items, v.old_row);
        when 'casework_reminders' then insert into public.casework_reminders select * from pg_catalog.jsonb_populate_record(null::public.casework_reminders, v.old_row);
        when 'casework_intake_drafts' then insert into public.casework_intake_drafts select * from pg_catalog.jsonb_populate_record(null::public.casework_intake_drafts, v.old_row);
        when 'casework_strength_analyses' then insert into public.casework_strength_analyses select * from pg_catalog.jsonb_populate_record(null::public.casework_strength_analyses, v.old_row);
      else null;
    end case;
  end if;
  return null;
end;
end;
$function$;

-- private.account_lifecycle_retained_case_scope_allows (canonical owned predecessor; #7687)
CREATE OR REPLACE FUNCTION private.account_lifecycle_retained_case_scope_allows(p_kind text, p_record_id text, p_chapter_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(case when p_kind = 'assignment_audit' then
    private.account_lifecycle_staff_can_see_chapter((case when exists(select 1 from public.member_profiles where id=c.owner_id) then (select chapter_id from public.member_profiles where id=c.owner_id) else c.owner_chapter_id end), 'coordinator')
    -- The original policy's EXISTS also invokes member_cases SELECT RLS.
    and (
      c.owner_id = (select auth.uid())
      or (c.steward_user_id = (select auth.uid()) and public.member_has_role(array['steward']))
      or (
        not c.is_restricted
        or c.coordinator_user_id = (select auth.uid())
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
        or exists (select 1 from pg_catalog.jsonb_to_recordset(c.grants) as g(grantee_user_id uuid, revoked_at timestamptz)
          where g.grantee_user_id = (select auth.uid()) and g.revoked_at is null)
      )
    )
  else
    (p_kind = 'deadline_extension' and c.owner_id = (select auth.uid()))
    or (
      c.organization_id is not null
      and c.chapter_id is not null
      and private.actor_has_chapter_staff_role((select auth.uid()), c.chapter_id)
      and (
        c.steward_user_id = (select auth.uid())
        or c.coordinator_user_id = (select auth.uid())
        or private.account_lifecycle_staff_can_see_chapter((case when exists(select 1 from public.member_profiles where id=c.owner_id) then (select chapter_id from public.member_profiles where id=c.owner_id) else c.owner_chapter_id end), 'coordinator')
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
      )
      and (
        not c.is_restricted
        or c.steward_user_id = (select auth.uid())
        or c.coordinator_user_id = (select auth.uid())
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
        or exists (
          select 1 from pg_catalog.jsonb_to_recordset(c.grants) as g(grantee_user_id uuid, revoked_at timestamptz)
          where g.grantee_user_id = (select auth.uid()) and g.revoked_at is null
        )
      )
    )
  end and private.actor_case_scope_and_identity_allowed((select auth.uid()),pg_catalog.jsonb_populate_record(null::public.member_cases,pg_catalog.jsonb_build_object('id',c.case_id,'user_id',c.owner_id,'organization_id',c.organization_id,'chapter_id',c.chapter_id,'steward_user_id',c.steward_user_id,'coordinator_user_id',c.coordinator_user_id,'is_restricted',c.is_restricted))), false)
  from private.account_lifecycle_history_scope h
  join private.account_lifecycle_case_scope c on c.case_id = h.case_id
  where h.kind = p_kind and h.record_id = p_record_id;
$function$;

-- casework_management_entries_staff on public.casework_management_entries (#7687)
alter policy casework_management_entries_staff on public.casework_management_entries
  using ((private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND (((case_id IS NOT NULL) AND private.casework_staff_can_read(case_id)) OR ((case_id IS NULL) AND COALESCE(private.account_lifecycle_retained_case_scope_allows('management_entry'::text, (id)::text, chapter_id), true)))));
comment on policy casework_management_entries_staff on public.casework_management_entries is 'Scoped staff retain the current case or member oracle, MFA and retained-scope restrictions.';

-- casework_management_entries_insert on public.casework_management_entries (#7687)
alter policy casework_management_entries_insert on public.casework_management_entries
  with check (((private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND (created_by = ( SELECT auth.uid() AS uid)) AND ((case_id IS NULL) OR private.casework_scope_matches(case_id, organization_id, chapter_id)))) and (case_id is null or private.casework_staff_can_access(case_id)));
comment on policy casework_management_entries_insert on public.casework_management_entries is 'Scoped staff retain the current case or member oracle, MFA and retained-scope restrictions.';

-- casework_management_addenda_staff on public.casework_management_addenda (#7687)
alter policy casework_management_addenda_staff on public.casework_management_addenda
  using ((EXISTS ( SELECT 1
   from public.casework_management_entries entry
  WHERE ((entry.id = casework_management_addenda.entry_id) AND (entry.organization_id = casework_management_addenda.organization_id) AND private.member_has_chapter_staff_grant(entry.chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND (((entry.case_id IS NOT NULL) AND private.casework_staff_can_read(entry.case_id)) OR ((entry.case_id IS NULL) AND COALESCE(private.account_lifecycle_retained_case_scope_allows('management_entry'::text, (entry.id)::text, entry.chapter_id), true)))))));
comment on policy casework_management_addenda_staff on public.casework_management_addenda is 'Scoped staff retain the current case or member oracle, MFA and retained-scope restrictions.';

-- casework_management_addenda_insert on public.casework_management_addenda (#7687)
alter policy casework_management_addenda_insert on public.casework_management_addenda
  with check (((created_by = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   from public.casework_management_entries e
  WHERE ((e.id = casework_management_addenda.entry_id) AND (e.organization_id = casework_management_addenda.organization_id) AND private.member_has_chapter_staff_grant(e.chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND (case when e.case_id is null then coalesce(private.account_lifecycle_retained_case_scope_allows('management_entry',e.id::text,e.chapter_id),true) else private.casework_staff_can_access(e.case_id) end))))));
comment on policy casework_management_addenda_insert on public.casework_management_addenda is 'Scoped staff retain the current case or member oracle, MFA and retained-scope restrictions.';

-- casework_retaliation_reports_read on public.casework_retaliation_reports (#7687)
alter policy casework_retaliation_reports_read on public.casework_retaliation_reports
  using (((reporter_user_id = ( SELECT auth.uid() AS uid)) OR (private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND (((case_id IS NOT NULL) AND private.casework_staff_can_read(case_id)) OR ((case_id IS NULL) AND COALESCE(private.account_lifecycle_retained_case_scope_allows('retaliation_report'::text, (id)::text, chapter_id), (private.member_has_chapter_role(chapter_id,array['steward','coordinator','advisor','admin','vp']) or private.chapter_staff_member_allowed(chapter_id, reporter_user_id, array['steward','coordinator','advisor','admin','vp']))))))));
comment on policy casework_retaliation_reports_read on public.casework_retaliation_reports is 'Scoped staff retain the current case or member oracle, MFA and retained-scope restrictions.';

-- casework_intake_drafts_owner on public.casework_intake_drafts (#7687)
alter policy casework_intake_drafts_owner on public.casework_intake_drafts
  using ((((owner_user_id = ( SELECT auth.uid() AS uid)) AND private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) and (member_user_id is null or private.chapter_staff_member_allowed(chapter_id, member_user_id, array['steward','coordinator','advisor','admin','vp'])) and (case_id is null or private.casework_staff_can_access(case_id)));
comment on policy casework_intake_drafts_owner on public.casework_intake_drafts is 'Scoped staff retain the current case or member oracle, MFA and retained-scope restrictions.';

-- chapter_contact_log_versions_staff_read on public.chapter_contact_log_versions (#7687)
alter policy chapter_contact_log_versions_staff_read on public.chapter_contact_log_versions
  using (private.chapter_contact_entry_allowed(chapter_id, subject_user_id, case_id));
comment on policy chapter_contact_log_versions_staff_read on public.chapter_contact_log_versions is 'Contact history requires the current member and case scope; a staff grant alone exposes no subject.';

-- chapter_records_select on public.chapter_records (#7687)
alter policy chapter_records_select on public.chapter_records
  using (((((private.chapter_record_publication(record_type) = 'chapter_members'::text) AND (lifecycle_status = 'published'::text) AND (visibility = 'chapter'::text) AND (archived_at IS NULL) AND COALESCE(((( SELECT private.chapter_records_scope_memo('member'::text) AS chapter_records_scope_memo) ->> chapter_id))::boolean, private.can_read_chapter_member_record(chapter_id))) OR ((archived_at IS NULL) AND COALESCE(((( SELECT private.chapter_records_scope_memo('contact'::text) AS chapter_records_scope_memo) ->> chapter_id))::boolean, private.can_read_chapter_contact_record(chapter_id))) OR ((private.chapter_record_publication(record_type) = 'chapter_members'::text) AND COALESCE(((( SELECT private.chapter_records_scope_memo('officer'::text) AS chapter_records_scope_memo) ->> (jsonb_build_array(chapter_id, access_unit_id, access_committee_id))::text))::boolean, private.chapter_officer_can_for_scope(chapter_id, 'records'::text, access_unit_id, access_committee_id))))) and (record_type <> 'member_contact' or coalesce((((select private.chapter_records_scope_memo('broad-staff')) ->> chapter_id))::boolean, (private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role((select staff_chapter.organization_id from public.chapters staff_chapter where staff_chapter.id = (chapter_id)), array['steward','coordinator','advisor','admin','vp'])))) and ((access_unit_id is null and access_committee_id is null) or coalesce((((select private.chapter_records_scope_memo('manageable')) ->> pg_catalog.jsonb_build_array(chapter_id, access_unit_id, access_committee_id)::text))::boolean, private.chapter_record_manageable(chapter_id, access_unit_id, access_committee_id)) or (((access_unit_id is null and access_committee_id is null) or coalesce((((select private.chapter_records_scope_memo('container')) ->> pg_catalog.jsonb_build_array(chapter_id, access_unit_id, access_committee_id)::text))::boolean, (private.chapter_record_manageable(chapter_id, access_unit_id, access_committee_id) or private.chapter_scope_member_allowed(chapter_id, access_unit_id, access_committee_id, (select auth.uid()))))) and (coalesce((((select private.chapter_records_scope_memo('broad-staff')) ->> chapter_id))::boolean, (private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role((select staff_chapter.organization_id from public.chapters staff_chapter where staff_chapter.id = (chapter_id)), array['steward','coordinator','advisor','admin','vp']))) or (private.chapter_record_publication(record_type)='chapter_members' and lifecycle_status='published' and visibility='chapter')))));
comment on policy chapter_records_select on public.chapter_records is 'Private record containers require their matching staff scope; published records retain member access and legacy member contacts retain the chapter-wide privacy bar.';

-- member_appointments_select_participant on public.member_appointments (#7687)
alter policy member_appointments_select_participant on public.member_appointments
  using (
    member_appointments.chapter_id = private.current_member_chapter()
    and (
      (select auth.uid()) = user_id
      or (
        (select auth.uid()) = steward_id
        and (private.member_has_chapter_role(member_appointments.chapter_id, array['steward']) or private.chapter_staff_member_allowed(member_appointments.chapter_id, user_id, array['steward']))
      )
    )
  );
comment on policy member_appointments_select_participant on public.member_appointments is 'Assigned stewards must also have current authority for the appointment member.';

-- member_appointment_events_select_participant on public.member_appointment_events (#7687)
alter policy member_appointment_events_select_participant on public.member_appointment_events
  using (exists (
    select 1
    from public.member_appointments a
    where a.id = appointment_id
      and a.chapter_id = private.current_member_chapter()
      and (
        (select auth.uid()) = a.user_id
        or (
          (select auth.uid()) = a.steward_id
          and (private.member_has_chapter_role(a.chapter_id, array['steward']) or private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward']))
        )
      )
  ));
comment on policy member_appointment_events_select_participant on public.member_appointment_events is 'Appointment history inherits the assigned-steward and current member visibility checks.';

-- Refresh only the explicitly changed, reviewed call-graph surfaces.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select surface.kind,surface.schema_name,surface.table_name,surface.object_name,surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
join (values
    ('private','account_lifecycle_retained_case_scope_allows'),
    ('private','can_read_chapter_contact_record'),
    ('private','case_signals_staff_organization'),
    ('private','casework_history_versions'),
    ('private','casework_may_manage_case_access'),
    ('private','chapter_contact_entry_allowed'),
    ('private','chapter_record_manageable'),
    ('private','chapter_records_member_allowed'),
    ('private','chapter_records_scope_memo'),
    ('private','chapter_seniority_member_allowed'),
    ('private','chapter_staff_member_allowed'),
    ('private','institutional_context'),
    ('private','issue_digest_staff_organization'),
    ('private','learning_undo_casework'),
    ('private','seniority_staff_can_manage'),
    ('public','answer_chapter_seniority_question'),
    ('public','award_chapter_bid'),
    ('public','cancel_appointment'),
    ('public','casework_add_management_addendum'),
    ('public','casework_revoke_access'),
    ('public','casework_save_intake_draft'),
    ('public','civic_campaign_stats_for_org'),
    ('public','civic_is_org_officer'),
    ('public','civic_member_officials_for_org'),
    ('public','civic_member_place_counts'),
    ('public','create_chapter_task_from_source'),
    ('public','delete_chapter_seniority_entry'),
    ('public','get_appointment_history'),
    ('public','get_appointment_notes'),
    ('public','get_institutional_records_workspace'),
    ('public','get_issue_intelligence_signals'),
    ('public','get_minutes_meeting_checkins'),
    ('public','get_steward_appointments_without_place_legacy'),
    ('public','import_chapter_seniority'),
    ('public','list_chapter_bid_window_bids'),
    ('public','list_chapter_bid_windows'),
    ('public','list_chapter_seniority'),
    ('public','list_steward_appointments_without_place_legacy'),
    ('public','mark_appointment_outcome'),
    ('public','record_chapter_bid'),
    ('public','record_member_access_event'),
    ('public','reschedule_appointment'),
    ('public','save_chapter_contact_log'),
    ('public','save_chapter_seniority_entry'),
    ('public','save_scoped_institutional_record'),
    ('public','search_chapter_seniority_members'),
    ('public','set_appointment_note')
) changed(schema_name,function_name)
  on changed.schema_name=surface.schema_name
 and changed.function_name=pg_catalog.split_part(surface.object_name,'(',1)
where surface.kind='function'
on conflict(kind,schema_name,table_name,object_name)
do update set definition_hash=excluded.definition_hash;

commit;
