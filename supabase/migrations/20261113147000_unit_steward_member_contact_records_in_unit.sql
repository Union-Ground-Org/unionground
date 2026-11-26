-- REQ-UG-UNIT-STEWARDS-MEMBER-CONTACT-RECORDS-IN-THEIR-UNIT-20261115 (#8933)
--
-- Member-contact chapter records (staff-authored notes about named people,
-- SEC-UG-CHAPTER-RECORDS-CONTACT-READ-20260817) were shown and saved only
-- for chapter-wide staff, so a steward limited to a unit since #7663 saw and
-- saved none, not even ones kept in their own unit's container. A member_contact
-- record has no member column; its unit or committee container is the boundary
-- the table has (#7687 reaches records through the same container helper).
--
-- public.get_institutional_records_workspace() and
-- public.save_scoped_institutional_record(...) are restated from 20261113115000
-- (md5-pinned below) with their member_contact gates widened: a
-- member-contact record also passes when it sits in a unit or
-- committee container covered by the same contact-capable staff assignment
-- (private.chapter_member_contact_container_allowed), and a caller
-- may save one into such a container. Records with no container stay with
-- chapter-wide staff. The container read clause, the contact-record check
-- (private.can_read_chapter_contact_record), the staff two-step rule, security
-- mode, search_path, the result shape and the grants (kept by CREATE OR
-- REPLACE) are unchanged.
-- The existing-record lookup filters by the same authority before returning
-- 'record not found', so an inaccessible row and a missing row agree. The
-- direct row-read policy uses the same nonempty-container alternative.
-- Contact versions retain their own container at the moment they are written;
-- later conversions, moves and archive reopening cannot re-scope that history.
-- Earlier versions have no reliable original-container evidence and retain
-- their predecessor's chapter-wide staff gate; never infer it from today's row.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

do $predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_institutional_records_workspace()'))) is distinct from 'e37b1b34d7868ba9990e0b737df64ea5' then
    raise exception 'unreviewed predecessor: public.get_institutional_records_workspace' using errcode = '55000';
  end if;
  if exists (select 1 from private.account_lifecycle_trigger_review where kind = 'function' and schema_name = 'public'
      and pg_catalog.split_part(object_name, '(', 1) = 'get_institutional_records_workspace' and definition_hash <> 'e37b1b34d7868ba9990e0b737df64ea5') then
    raise exception 'stale trigger receipt: public.get_institutional_records_workspace' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.save_scoped_institutional_record(uuid, text, text, text, timestamp with time zone, text, text, boolean, text, integer, jsonb, uuid, uuid, text, uuid)'))) is distinct from '61fe2f3f8186ce2e08bc694f0d557f1a' then
    raise exception 'unreviewed predecessor: public.save_scoped_institutional_record' using errcode = '55000';
  end if;
  if exists (select 1 from private.account_lifecycle_trigger_review where kind = 'function' and schema_name = 'public'
      and pg_catalog.split_part(object_name, '(', 1) = 'save_scoped_institutional_record' and definition_hash <> '61fe2f3f8186ce2e08bc694f0d557f1a') then
    raise exception 'stale trigger receipt: public.save_scoped_institutional_record' using errcode = '55000';
  end if;
end;
$predecessor$;

alter table public.chapter_record_versions
  add column access_unit_id uuid,
  add column access_committee_id uuid,
  add column access_scope_captured boolean not null default false;
-- Snapshot identifiers deliberately have no mutable-container foreign key:
-- deleting or renaming a unit cannot rewrite or broaden a retained snapshot.
-- The versions table's existing revoke-all ACL is unchanged. Only the shared
-- save function writes new captured scopes; historical/service seed writers
-- which cannot attest the original scope retain the conservative false value.
comment on column public.chapter_record_versions.access_scope_captured is
  'True only when the shared save captured this version container atomically; false historical snapshots remain chapter-wide staff only.';

-- r3s1: contact authority and container coverage must come from the same
-- contact-capable staff role. The ordinary records helper also admits office
-- roles (for example Secretary); its separate officer arm must not supply the
-- scope of a staff role held in another unit. Preserve the staff branch's
-- chapter/unit capability settings and committee window.
CREATE FUNCTION private.chapter_member_contact_container_allowed(p_chapter text, p_unit uuid, p_committee uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (p_unit is not null or p_committee is not null)
    and private.can_read_chapter_contact_record(p_chapter)
    and exists (
      select 1 from private.chapter_role_capabilities capability
      left join private.chapter_role_settings setting on setting.chapter_id=p_chapter
        and setting.role=capability.role and setting.capability=capability.capability
      where capability.capability='records'
        and capability.role=any(array['steward','coordinator','advisor','admin','vp'])
        and coalesce(setting.enabled,true)
        and private.member_has_chapter_staff_grant(p_chapter,array[capability.role])
        and exists (
          select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) scope
          where scope.user_id=(select auth.uid()) and scope.chapter_id=p_chapter
            and scope.role=capability.role and not scope.legacy_chapter_coverage
            and (
              (p_unit is not null and p_committee is null and scope.unit_id=p_unit
                and private.unit_capability_enabled(p_chapter,p_unit,capability.role,'records'))
              or (p_unit is null and p_committee is not null and scope.committee_id=p_committee
                and exists (select 1 from private.chapter_committees committee
                  where committee.id=p_committee and committee.chapter_id=p_chapter
                    and (committee.starts_on is null or committee.starts_on<=current_date) -- utc-day: preserve the existing committee window; #8568 migrates these readers together
                    and (committee.ends_on is null or committee.ends_on>=current_date))) -- utc-day: preserve the existing committee window; #8568 migrates these readers together
            )
        )
    );
$function$;
revoke all on function private.chapter_member_contact_container_allowed(text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.chapter_member_contact_container_allowed(text,uuid,uuid) to authenticated;

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
        'versions', case when private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id) then coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v) order by v.version desc) from public.chapter_record_versions v where v.record_id = r.id and (v.record_type <> 'member_contact' or private.can_read_chapter_contact_record(v.chapter_id)) and (v.record_type <> 'member_contact' or coalesce((((select private.chapter_records_scope_memo('broad-staff')) ->> v.chapter_id))::boolean, (private.member_has_chapter_role(v.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.chapter_organization_role_allowed(v.chapter_id, array['steward','coordinator','advisor','admin','vp']))) or (v.access_scope_captured and private.chapter_member_contact_container_allowed(v.chapter_id, v.access_unit_id, v.access_committee_id)))), '[]'::jsonb) else '[]'::jsonb end,
        'attendance', case when private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id) then coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId', a.user_id, 'status', a.attendance_status) order by p.full_name) from public.meeting_attendance a join public.member_profiles p on p.id = a.user_id where a.record_id = r.id and private.chapter_records_member_allowed(r.chapter_id, a.user_id)), '[]'::jsonb) else '[]'::jsonb end,
        'dispatch', case when private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id) then coalesce((select pg_catalog.jsonb_build_object('delivered', pg_catalog.count(*) filter (where d.status = 'delivered'), 'failed', pg_catalog.count(*) filter (where d.status = 'failed')) from public.meeting_minutes_dispatches d where d.record_id = r.id and d.version = r.version), pg_catalog.jsonb_build_object('delivered', 0, 'failed', 0)) else pg_catalog.jsonb_build_object('delivered', 0, 'failed', 0) end
      ) order by r.pinned_at desc nulls last, r.occurred_at desc, r.id)
      from public.chapter_records r
      where r.chapter_id = ctx.chapter_id
        and r.archived_at is null
        and (r.record_type <> 'member_contact' or coalesce((((select private.chapter_records_scope_memo('broad-staff')) ->> r.chapter_id))::boolean, (private.member_has_chapter_role(r.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.chapter_organization_role_allowed(r.chapter_id, array['steward','coordinator','advisor','admin','vp']))) or private.chapter_member_contact_container_allowed(r.chapter_id, r.access_unit_id, r.access_committee_id))
        and ((r.access_unit_id is null and r.access_committee_id is null) or coalesce((((select private.chapter_records_scope_memo('manageable')) ->> pg_catalog.jsonb_build_array(r.chapter_id, r.access_unit_id, r.access_committee_id)::text))::boolean, private.chapter_record_manageable(r.chapter_id, r.access_unit_id, r.access_committee_id)) or (((r.access_unit_id is null and r.access_committee_id is null) or coalesce((((select private.chapter_records_scope_memo('container')) ->> pg_catalog.jsonb_build_array(r.chapter_id, r.access_unit_id, r.access_committee_id)::text))::boolean, (private.chapter_record_manageable(r.chapter_id, r.access_unit_id, r.access_committee_id) or private.chapter_scope_member_allowed(r.chapter_id, r.access_unit_id, r.access_committee_id, (select auth.uid()))))) and (coalesce((((select private.chapter_records_scope_memo('broad-staff')) ->> r.chapter_id))::boolean, (private.member_has_chapter_role(r.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.chapter_organization_role_allowed(r.chapter_id, array['steward','coordinator','advisor','admin','vp']))) or (private.chapter_record_publication(r.record_type)='chapter_members' and r.lifecycle_status='published' and r.visibility='chapter'))))
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
  if p_record_type = 'member_contact' and not (private.member_has_chapter_role(ctx.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.chapter_organization_role_allowed(ctx.chapter_id, array['steward','coordinator','advisor','admin','vp']))
    and not private.chapter_member_contact_container_allowed(ctx.chapter_id, p_access_unit_id, p_access_committee_id) then
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
      and private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id)
      and (r.record_type <> 'member_contact' or private.member_has_chapter_role(r.chapter_id, array['steward','coordinator','advisor','admin','vp'])
        or private.chapter_organization_role_allowed(r.chapter_id, array['steward','coordinator','advisor','admin','vp'])
        or private.chapter_member_contact_container_allowed(r.chapter_id,r.access_unit_id,r.access_committee_id))
      and (r.record_type not in ('management_contact','member_contact') or private.can_read_chapter_contact_record(r.chapter_id))
    for update;
    if target.id is null then raise exception 'record not found' using errcode = 'P0002'; end if;
    if not private.chapter_record_manageable(target.chapter_id,target.access_unit_id,target.access_committee_id)
      or (target.record_type = 'member_contact' and not (private.member_has_chapter_role(ctx.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.chapter_organization_role_allowed(ctx.chapter_id, array['steward','coordinator','advisor','admin','vp']))
      and not private.chapter_member_contact_container_allowed(target.chapter_id, target.access_unit_id, target.access_committee_id))
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
    lifecycle_status, visibility, gap_note, changed_by,
    access_unit_id, access_committee_id, access_scope_captured
  ) values (
    target.id, target.chapter_id, target.version, target.record_type, target.title, target.body,
    target.occurred_at, target.lifecycle_status, target.visibility, target.gap_note, ctx.caller_id,
    target.access_unit_id, target.access_committee_id, true
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

-- Direct row reads use the same member-contact container rule as the workspace.
-- Version rows have only their restrictive MFA policy and no authenticated
-- SELECT grant; they remain available exclusively through the workspace.
do $policy_predecessor$
begin
  if (select pg_catalog.md5(pg_catalog.pg_get_expr(p.polqual,p.polrelid))
      from pg_catalog.pg_policy p where p.polrelid='public.chapter_records'::pg_catalog.regclass
        and p.polname='chapter_records_select') is distinct from '78ad4aac6e7dfb852daacd3e0aff88b2' then
    raise exception 'unreviewed predecessor policy: chapter_records_select' using errcode='55000';
  end if;
end;
$policy_predecessor$;
alter policy chapter_records_select on public.chapter_records using (((((private.chapter_record_publication(record_type) = 'chapter_members'::text) AND (lifecycle_status = 'published'::text) AND (visibility = 'chapter'::text) AND (archived_at IS NULL) AND COALESCE(((( SELECT private.chapter_records_scope_memo('member'::text) AS chapter_records_scope_memo) ->> chapter_id))::boolean, private.can_read_chapter_member_record(chapter_id))) OR ((archived_at IS NULL) AND COALESCE(((( SELECT private.chapter_records_scope_memo('contact'::text) AS chapter_records_scope_memo) ->> chapter_id))::boolean, private.can_read_chapter_contact_record(chapter_id))) OR ((private.chapter_record_publication(record_type) = 'chapter_members'::text) AND COALESCE(((( SELECT private.chapter_records_scope_memo('officer'::text) AS chapter_records_scope_memo) ->> (jsonb_build_array(chapter_id, access_unit_id, access_committee_id))::text))::boolean, private.chapter_officer_can_for_scope(chapter_id, 'records'::text, access_unit_id, access_committee_id)))) AND ((record_type <> 'member_contact'::text) OR COALESCE(((( SELECT private.chapter_records_scope_memo('broad-staff'::text) AS chapter_records_scope_memo) ->> chapter_id))::boolean, (private.member_has_chapter_role(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) OR private.chapter_organization_role_allowed(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR private.chapter_member_contact_container_allowed(chapter_id, access_unit_id, access_committee_id)) AND (((access_unit_id IS NULL) AND (access_committee_id IS NULL)) OR COALESCE(((( SELECT private.chapter_records_scope_memo('manageable'::text) AS chapter_records_scope_memo) ->> (jsonb_build_array(chapter_id, access_unit_id, access_committee_id))::text))::boolean, private.chapter_record_manageable(chapter_id, access_unit_id, access_committee_id)) OR ((((access_unit_id IS NULL) AND (access_committee_id IS NULL)) OR COALESCE(((( SELECT private.chapter_records_scope_memo('container'::text) AS chapter_records_scope_memo) ->> (jsonb_build_array(chapter_id, access_unit_id, access_committee_id))::text))::boolean, (private.chapter_record_manageable(chapter_id, access_unit_id, access_committee_id) OR private.chapter_scope_member_allowed(chapter_id, access_unit_id, access_committee_id, ( SELECT auth.uid() AS uid))))) AND (COALESCE(((( SELECT private.chapter_records_scope_memo('broad-staff'::text) AS chapter_records_scope_memo) ->> chapter_id))::boolean, (private.member_has_chapter_role(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) OR private.chapter_organization_role_allowed(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR ((private.chapter_record_publication(record_type) = 'chapter_members'::text) AND (lifecycle_status = 'published'::text) AND (visibility = 'chapter'::text)))))));
comment on policy chapter_records_select on public.chapter_records is
  'Member-contact records require staff contact access and chapter-wide standing or a contact-capable staff assignment covering the same unit or committee container.';

-- Reviewed call-graph change (account lifecycle inventory): the two restated
-- functions keep their receipts, refreshed to the new definitions.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and (
  (schema_name = 'public' and pg_catalog.split_part(object_name, '(', 1) in ('get_institutional_records_workspace', 'save_scoped_institutional_record'))
  or (schema_name = 'private' and pg_catalog.split_part(object_name, '(', 1) = 'chapter_member_contact_container_allowed')
)
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

notify pgrst, 'reload schema';

commit;
