-- SEC-UG-CASEWORK-REFUSALS-REVEAL-ANOTHER-ORGANIZATIONS-ROW-20261115 (#8795).
--
-- public.casework_acknowledge_alert, casework_add_management_addendum,
-- casework_request_deadline_extension and casework_review_retaliation_pattern
-- each read their row by id with a strict single-row read before checking the
-- caller's access. A missing id raised P0002 "query returned no rows"; another
-- organization's live row raised P0002 "alert / entry / deadline / pattern not
-- found". A caller given another organization's id could tell that it exists.
--
-- Each now reads the row without a lock, refuses a missing row and a row the
-- caller may not reach with the same SQLSTATE and message, and only then takes
-- the row lock it took before and checks again on the locked row. Taking no
-- lock first also means a caller cannot wait on another organization's locked
-- row to learn that it exists. Nothing else in the four bodies changes; the
-- predecessor bodies are guarded below.
--
-- It also delivers BUG record #8784: a case can no longer be stored without a
-- chapter. private.mi1_bind_case_owner() left a new case's chapter_id null
-- when its owner's chapter had no organization; that insert is now refused
-- with the existing "case owner requires a current organization chapter"
-- (23514), and public.member_cases carries a CHECK that chapter_id is present
-- and not blank, added NOT VALID and then validated (SAMPLE and Production
-- held no case with a null or blank chapter in the read-only count of Nov 15,
-- 2026, 4:29 AM ET). No row is written.

begin;

-- The hosted runner applies this file under an empty search_path, where
-- pg_get_functiondef writes the public return types as public.*; the guards'
-- md5 values were read with public on the path. Each function keeps its own
-- empty search_path.
set local search_path = pg_catalog, public;

-- Each re-emitted function must still be the reviewed live body.
do $predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.casework_acknowledge_alert(uuid, text)'))) is distinct from '3e7c674f08bea12adf48d3a438992495' then
    raise exception 'unreviewed predecessor: public.casework_acknowledge_alert' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.casework_add_management_addendum(uuid, text)'))) is distinct from 'a628a9080d9842d601da0c9468d46821' then
    raise exception 'unreviewed predecessor: public.casework_add_management_addendum' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.casework_request_deadline_extension(uuid, timestamp with time zone, text, uuid)'))) is distinct from '5ef4350d3d03b66af2e30ad3f6834f0f' then
    raise exception 'unreviewed predecessor: public.casework_request_deadline_extension' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.casework_review_retaliation_pattern(uuid, text, text, text)'))) is distinct from 'f4ccfc64a9d9a7a0b428d66c60ac0895' then
    raise exception 'unreviewed predecessor: public.casework_review_retaliation_pattern' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.mi1_bind_case_owner()'))) is distinct from '4d720b17b00b8c0d2ef6887bb253f5f5' then
    raise exception 'unreviewed predecessor: private.mi1_bind_case_owner' using errcode = '55000';
  end if;
end;
$predecessors$;

CREATE OR REPLACE FUNCTION public.casework_acknowledge_alert(p_alert_id uuid, p_note text DEFAULT NULL::text)
 RETURNS public.casework_alerts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_alert public.casework_alerts%rowtype;
begin
  perform private.casework_require_mfa();
  -- A missing id and another organization's alert get the same refusal, and
  -- no lock is taken on a row the caller may not see (#8795).
  select * into v_alert from public.casework_alerts where id = p_alert_id;
  if not found or not private.casework_staff_can_access(v_alert.case_id) then raise exception 'alert not found' using errcode = 'P0002'; end if;
  select * into v_alert from public.casework_alerts where id = p_alert_id for update;
  if not found or not private.casework_staff_can_access(v_alert.case_id) then raise exception 'alert not found' using errcode = 'P0002'; end if;
  insert into public.casework_alert_acknowledgements(alert_id, organization_id, acknowledged_by, note)
  values (v_alert.id, v_alert.organization_id, (select auth.uid()), nullif(pg_catalog.btrim(p_note), '')) on conflict (alert_id, acknowledged_by) do nothing;
  if v_alert.status = 'open' then update public.casework_alerts set status = 'acknowledged' where id = v_alert.id returning * into v_alert; end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_alert.organization_id, v_alert.chapter_id, v_alert.case_id, (select auth.uid()), 'alert_acknowledged', 'alert', v_alert.id);
  return v_alert;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_add_management_addendum(p_entry_id uuid, p_body text)
 RETURNS public.casework_management_addenda
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_entry public.casework_management_entries%rowtype; v_row public.casework_management_addenda%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  -- A missing id and another organization's entry get the same refusal, and
  -- no lock is taken on a row the caller may not see (#8795).
  select * into v_entry from public.casework_management_entries where id = p_entry_id;
  if not found or not private.member_has_chapter_staff_grant(v_entry.chapter_id, array['steward','coordinator','advisor','admin','vp']) or (case when v_entry.case_id is not null then not private.casework_staff_can_access(v_entry.case_id) else not coalesce(private.account_lifecycle_retained_case_scope_allows('management_entry', v_entry.id::text, v_entry.chapter_id), true) end) then raise exception 'entry not found' using errcode = 'P0002'; end if;
  select * into v_entry from public.casework_management_entries where id = p_entry_id for share;
  if not found or not private.member_has_chapter_staff_grant(v_entry.chapter_id, array['steward','coordinator','advisor','admin','vp']) or (case when v_entry.case_id is not null then not private.casework_staff_can_access(v_entry.case_id) else not coalesce(private.account_lifecycle_retained_case_scope_allows('management_entry', v_entry.id::text, v_entry.chapter_id), true) end) then raise exception 'entry not found' using errcode = 'P0002'; end if;
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

CREATE OR REPLACE FUNCTION public.casework_request_deadline_extension(p_deadline_id uuid, p_requested_due_at timestamp with time zone, p_reason text, p_idempotency_key uuid)
 RETURNS public.casework_deadline_extensions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_deadline public.casework_deadlines%rowtype; v_row public.casework_deadline_extensions%rowtype;
begin
  perform private.casework_require_mfa();
  -- A missing id and another organization's deadline get the same refusal,
  -- and no lock is taken on a row the caller may not see (#8795).
  select * into v_deadline from public.casework_deadlines where id = p_deadline_id;
  if not found or not private.casework_can_read(v_deadline.case_id) or not (private.casework_member_owns(v_deadline.case_id) or private.casework_staff_can_access(v_deadline.case_id)) then raise exception 'deadline not found' using errcode = 'P0002'; end if;
  select * into v_deadline from public.casework_deadlines where id = p_deadline_id for share;
  if not found or not private.casework_can_read(v_deadline.case_id) or not (private.casework_member_owns(v_deadline.case_id) or private.casework_staff_can_access(v_deadline.case_id)) then raise exception 'deadline not found' using errcode = 'P0002'; end if;
  if p_requested_due_at <= v_deadline.due_at or pg_catalog.char_length(pg_catalog.btrim(p_reason)) not between 8 and 2000 then raise exception 'invalid extension request' using errcode = '22023'; end if;
  insert into public.casework_deadline_extensions(deadline_id, organization_id, requested_by, previous_due_at, requested_due_at, reason, idempotency_key)
  values (v_deadline.id, v_deadline.organization_id, (select auth.uid()), v_deadline.due_at, p_requested_due_at, pg_catalog.btrim(p_reason), p_idempotency_key)
  on conflict (organization_id, requested_by, idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_deadline.organization_id, v_deadline.chapter_id, v_deadline.case_id, (select auth.uid()), 'deadline_requested', 'deadline_extension', v_row.id, pg_catalog.jsonb_build_object('deadlineId', v_deadline.id));
  perform private.learning_casework_journal('casework_extension_request', v_deadline.case_id);
  return v_row;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_review_retaliation_pattern(p_pattern_id uuid, p_status text, p_disposition text, p_note text)
 RETURNS public.casework_retaliation_patterns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_row public.casework_retaliation_patterns%rowtype; v_note_id uuid;
begin
  perform private.casework_require_mfa();
  if p_status not in ('flagged','investigating','substantiated','dismissed') then raise exception 'invalid pattern status' using errcode = '22023'; end if;
  -- A missing id and another organization's pattern get the same refusal,
  -- and no lock is taken on a row the caller may not see (#8795).
  select * into v_row from public.casework_retaliation_patterns where id = p_pattern_id;
  if not found or not ((v_row.chapter_id is not null and private.member_has_chapter_role(v_row.chapter_id, array['coordinator','advisor','admin','vp'])) or private.has_organization_role(v_row.organization_id, array['coordinator','advisor','admin','vp'])) then raise exception 'pattern not found' using errcode = 'P0002'; end if;
  select * into v_row from public.casework_retaliation_patterns where id = p_pattern_id for update;
  if not found or not ((v_row.chapter_id is not null and private.member_has_chapter_role(v_row.chapter_id, array['coordinator','advisor','admin','vp'])) or private.has_organization_role(v_row.organization_id, array['coordinator','advisor','admin','vp'])) then raise exception 'pattern not found' using errcode = 'P0002'; end if;
  update public.casework_retaliation_patterns set status = p_status, disposition = nullif(pg_catalog.btrim(p_disposition), ''), reviewed_by = (select auth.uid()), reviewed_at = pg_catalog.now() where id = v_row.id returning * into v_row;
  if nullif(pg_catalog.btrim(p_note), '') is not null then
    insert into public.casework_retaliation_pattern_notes(pattern_id, organization_id, body, created_by) values (v_row.id, v_row.organization_id, pg_catalog.btrim(p_note), (select auth.uid()))
    returning id into v_note_id;
    -- REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103: kept.
    perform private.learning_journal_append('retaliation_pattern_note', 'public.casework_retaliation_pattern_notes', v_note_id::text);
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, (select auth.uid()), 'pattern_reviewed', 'retaliation_pattern', v_row.id, pg_catalog.jsonb_build_object('status', p_status));
  return v_row;
end;
end;
$function$;

revoke all on function public.casework_acknowledge_alert(uuid, text) from public, anon;
revoke all on function public.casework_add_management_addendum(uuid, text) from public, anon;
revoke all on function public.casework_request_deadline_extension(uuid, timestamp with time zone, text, uuid) from public, anon;
revoke all on function public.casework_review_retaliation_pattern(uuid, text, text, text) from public, anon;
grant execute on function public.casework_acknowledge_alert(uuid, text) to authenticated;
grant execute on function public.casework_add_management_addendum(uuid, text) to authenticated;
grant execute on function public.casework_request_deadline_extension(uuid, timestamp with time zone, text, uuid) to authenticated;
grant execute on function public.casework_review_retaliation_pattern(uuid, text, text, text) to authenticated;

-- #8784: a case owner's chapter must belong to an organization; a case is
-- never stored without a chapter. The UPDATE branch is unchanged.
create or replace function private.mi1_bind_case_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  owner_organization uuid;
  owner_chapter text;
begin
  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id
       or new.chapter_id is distinct from old.chapter_id then
      if old.organization_id is null then
        raise exception 'legacy case ownership requires an explicit backfill' using errcode = '42501';
      end if;
      raise exception 'case organization and chapter are immutable' using errcode = '42501';
    end if;
    return new;
  end if;

  select ch.organization_id, ch.id
  into owner_organization, owner_chapter
  from public.member_profiles p
  join public.chapters ch on ch.id = p.chapter_id
  where p.id = new.user_id;

  if owner_chapter is null or owner_organization is null then
    raise exception 'case owner requires a current organization chapter' using errcode = '23514';
  end if;
  if new.organization_id is not null and new.organization_id is distinct from owner_organization then
    raise exception 'case organization is derived from the member chapter' using errcode = '42501';
  end if;
  if new.chapter_id is not null and new.chapter_id is distinct from owner_chapter then
    raise exception 'case chapter is derived from the member profile' using errcode = '42501';
  end if;

  new.organization_id := owner_organization;
  new.chapter_id := owner_chapter;
  return new;
end;
$function$;

revoke all on function private.mi1_bind_case_owner() from public, anon, authenticated, service_role;

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select surface.kind, surface.schema_name, surface.table_name, surface.object_name, surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
where surface.kind = 'function' and surface.schema_name = 'private'
  and surface.table_name = '' and surface.object_name = 'mi1_bind_case_owner()'
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_case_owner_lifecycle$
begin
  if not exists (
    select 1 from private.account_lifecycle_trigger_review r
    where r.kind = 'function' and r.schema_name = 'private' and r.table_name = ''
      and r.object_name = 'mi1_bind_case_owner()'
      and r.definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef('private.mi1_bind_case_owner()'::pg_catalog.regprocedure))
  ) then
    raise exception 'account lifecycle trigger review lost private.mi1_bind_case_owner()';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the case chapter repair';
  end if;
end;
$assert_case_owner_lifecycle$;

-- Every case names a chapter. NOT VALID first, so the scan runs as its own
-- step under a share update exclusive lock rather than with the add.
alter table public.member_cases
  add constraint member_cases_chapter_present
  check (chapter_id is not null and pg_catalog.btrim(chapter_id) <> '') not valid;
alter table public.member_cases validate constraint member_cases_chapter_present;

commit;
