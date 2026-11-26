-- REQ-UG-STEWARD-CASE-STEP-DEADLINE-AND-TITLE-CONTROLS-20261006
--
-- Stewards could change a case's step and add deadlines (casework_advance_step,
-- casework_create_deadline), and every saved clock reaches the deadlines list
-- (#4067, #4076). Two parts were still missing:
--
--   1. A case title was always the opening words of the member's description,
--      with no rename path. public.casework_rename_case lets any caller who can
--      work the case (private.casework_staff_can_access) set a 1-200 character
--      title and records one case_renamed casework_audit_events row. The audit
--      metadata stays a closed vocabulary (a reason code and the two lengths),
--      as every casework audit row does, so it never carries the member's
--      words or staff-authored text.
--   2. A steward had nowhere to write a pre-filing date before a case existed
--      (owner answer 11=A, October 8, 2026): a private steward reminder, title
--      and date only, visible to its steward only, attachable to a case once
--      one is opened. private.steward_private_reminders has no client grant;
--      four SECURITY DEFINER routines read and write only the caller's own
--      rows in the caller's selected organization. A coordinator, admin or
--      member never reads another person's reminder, and attaching one to a
--      case shares nothing: the link is only shown back to its steward.
--
-- Account lifecycle: the reminder leaves with its steward (ON DELETE CASCADE)
-- and is exported to that steward under additionalDomains; the case link
-- detaches when the case is deleted (ON DELETE SET NULL).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Case rename
-- ---------------------------------------------------------------------------

alter table public.casework_audit_events
  drop constraint casework_audit_events_event_type_check;
alter table public.casework_audit_events
  add constraint casework_audit_events_event_type_check check (event_type in (
    'strength_scored','deadline_requested','deadline_decided','checklist_created','checklist_item_changed',
    'step_advanced','restriction_changed','access_granted','access_revoked',
    'alert_created','alert_acknowledged','alert_escalated','behavior_logged',
    'retaliation_submitted','retaliation_withdrawn','pattern_detected',
    'draft_saved','bulk_updated','entity_linked','reminder_changed',
    'bargaining_changed','behavior_addendum_added','pattern_reviewed',
    'macro_saved','macro_applied','note_added','note_mentioned','case_assigned',
    'cases_exported','deadline_created','procedure_starter_loaded','case_renamed'
  ));

create function public.casework_rename_case(
  p_case_id uuid,
  p_title text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_case public.member_cases%rowtype;
  v_title text;
begin
  -- Case graph gate first: this routine updates public.member_cases and writes
  -- public.casework_audit_events.
  perform private.lock_case_graph(array[auth.uid()], array[p_case_id]);
  perform private.casework_require_mfa();
  v_title := pg_catalog.btrim(coalesce(p_title, ''));
  if pg_catalog.char_length(v_title) not between 1 and 200 or v_title ~ '[[:cntrl:]]' then
    raise exception 'case title must be 1 to 200 characters' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in ('clearer_title', 'member_request', 'correct_error', 'other') then
    raise exception 'unknown rename reason' using errcode = '22023';
  end if;
  select * into v_case from public.member_cases where id = p_case_id for update;
  if not found or not private.casework_staff_can_access(v_case.id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  if v_case.title is distinct from v_title then
    update public.member_cases set title = v_title where id = v_case.id;
    insert into public.casework_audit_events(
      organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (
      v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
      'case_renamed', 'case', v_case.id,
      pg_catalog.jsonb_build_object(
        'reason', p_reason,
        'titleLength', pg_catalog.char_length(v_title),
        'previousTitleLength', pg_catalog.char_length(v_case.title)));
  end if;
  return pg_catalog.jsonb_build_object(
    'caseId', v_case.id, 'title', v_title, 'changed', v_case.title is distinct from v_title);
end;
$function$;

revoke all on function public.casework_rename_case(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.casework_rename_case(uuid, text, text) to authenticated;

comment on function public.casework_rename_case(uuid, text, text) is
  'REQ-UG-STEWARD-CASE-STEP-DEADLINE-AND-TITLE-CONTROLS-20261006: staff who can work a case (private.casework_staff_can_access) set its 1-200 character title. One case_renamed casework_audit_events row per real change, with a closed reason code and lengths only.';

-- ---------------------------------------------------------------------------
-- 2. Private steward reminders
-- ---------------------------------------------------------------------------

create table private.steward_private_reminders (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null
    references auth.users(id) on delete cascade,
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete cascade,
  title text not null
    constraint steward_private_reminders_title_check
    check (pg_catalog.char_length(title) between 1 and 200 and title = pg_catalog.btrim(title)),
  remind_on date not null,
  case_id uuid
    references public.member_cases(id) on delete set null,
  attached_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint steward_private_reminders_attachment_shape check (case_id is null or attached_at is not null)
);

create index steward_private_reminders_owner_idx
  on private.steward_private_reminders (owner_id, organization_id, remind_on, id);
create index steward_private_reminders_case_idx
  on private.steward_private_reminders (case_id) where case_id is not null;

alter table private.steward_private_reminders enable row level security;
alter table private.steward_private_reminders force row level security;
revoke all on table private.steward_private_reminders from public, anon, authenticated, service_role;

comment on table private.steward_private_reminders is
  'Owner answer 11=A (October 8, 2026): a steward''s own dated reminder, title and date only, written before a case exists and optionally attached to a case later. Read and written only by its owner through the steward_*_private_reminder routines in the owner''s selected organization; never shown to coordinators, admins or members. Removed with the owner account; the case link detaches when the case is deleted. No client grant.';

create trigger a00_case_graph_lock before insert or update or delete on private.steward_private_reminders
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.steward_private_reminders
for each row execute function private.lock_case_graph_row_keys('{owner_id}', '{case_id}');

-- The caller's own reminders in the selected organization. A case link is
-- shown only while the caller can still work that case.
create function private.steward_private_reminder_rows()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id,
      'title', r.title,
      'remindOn', r.remind_on,
      'caseId', case when private.casework_staff_can_access(r.case_id) then r.case_id end,
      'caseReference', case when private.casework_staff_can_access(r.case_id) then c.reference end,
      'createdAt', r.created_at)
      order by r.remind_on, r.created_at, r.id), '[]'::jsonb)
  from private.steward_private_reminders r
  left join public.member_cases c on c.id = r.case_id
  where r.owner_id = (select auth.uid())
    and r.organization_id = private.current_member_organization();
$function$;

revoke all on function private.steward_private_reminder_rows() from public, anon, authenticated, service_role;

create function public.steward_list_private_reminders()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.casework_dashboard_require_staff();
  return private.steward_private_reminder_rows();
end;
$function$;

create function public.steward_save_private_reminder(
  p_title text,
  p_remind_on date,
  p_case_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_title text;
  v_org uuid;
  v_count integer;
begin
  perform private.lock_case_graph(array[auth.uid()], case when p_case_id is null then array[]::uuid[] else array[p_case_id] end);
  perform private.casework_dashboard_require_staff();
  v_org := private.current_member_organization();
  v_title := pg_catalog.btrim(coalesce(p_title, ''));
  if pg_catalog.char_length(v_title) not between 1 and 200 or v_title ~ '[[:cntrl:]]' then
    raise exception 'reminder title must be 1 to 200 characters' using errcode = '22023';
  end if;
  if p_remind_on is null or not pg_catalog.isfinite(p_remind_on)
     or p_remind_on not between date '0001-01-01' and date '9999-12-31' then
    raise exception 'reminder date must be between 0001-01-01 and 9999-12-31' using errcode = '22023';
  end if;
  if p_case_id is not null and not exists (
    select 1 from public.member_cases c
    where c.id = p_case_id and c.organization_id = v_org and private.casework_staff_can_access(c.id)
  ) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  select pg_catalog.count(*)::integer into v_count
  from private.steward_private_reminders r
  where r.owner_id = (select auth.uid()) and r.organization_id = v_org;
  if v_count >= 200 then
    raise exception 'a steward keeps at most 200 private reminders' using errcode = '54000';
  end if;
  insert into private.steward_private_reminders (owner_id, organization_id, title, remind_on, case_id, attached_at)
  values ((select auth.uid()), v_org, v_title, p_remind_on, p_case_id,
          case when p_case_id is not null then pg_catalog.now() end);
  return private.steward_private_reminder_rows();
end;
$function$;

create function public.steward_attach_private_reminder(
  p_reminder_id uuid,
  p_case_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], case when p_case_id is null then array[]::uuid[] else array[p_case_id] end);
  perform private.casework_dashboard_require_staff();
  v_org := private.current_member_organization();
  if p_case_id is not null and not exists (
    select 1 from public.member_cases c
    where c.id = p_case_id and c.organization_id = v_org and private.casework_staff_can_access(c.id)
  ) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  update private.steward_private_reminders
  set case_id = p_case_id,
      attached_at = case when p_case_id is not null then pg_catalog.now() end,
      updated_at = pg_catalog.now()
  where id = p_reminder_id and owner_id = (select auth.uid()) and organization_id = v_org;
  if not found then
    raise exception 'reminder not found' using errcode = 'P0002';
  end if;
  return private.steward_private_reminder_rows();
end;
$function$;

create function public.steward_delete_private_reminder(p_reminder_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_dashboard_require_staff();
  delete from private.steward_private_reminders
  where id = p_reminder_id and owner_id = (select auth.uid())
    and organization_id = private.current_member_organization();
  if not found then
    raise exception 'reminder not found' using errcode = 'P0002';
  end if;
  return private.steward_private_reminder_rows();
end;
$function$;

revoke all on function public.steward_list_private_reminders() from public, anon, authenticated, service_role;
revoke all on function public.steward_save_private_reminder(text, date, uuid) from public, anon, authenticated, service_role;
revoke all on function public.steward_attach_private_reminder(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.steward_delete_private_reminder(uuid) from public, anon, authenticated, service_role;
grant execute on function public.steward_list_private_reminders() to authenticated;
grant execute on function public.steward_save_private_reminder(text, date, uuid) to authenticated;
grant execute on function public.steward_attach_private_reminder(uuid, uuid) to authenticated;
grant execute on function public.steward_delete_private_reminder(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Account lifecycle registration and export
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, export_projection_version, export_domain,
   export_columns, exclusion_reason, note, reviewed_at)
values
  ('private', 'steward_private_reminders', 'owner_id', 'cascade', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.steward_private_reminders',
   array['id','owner_id','organization_id','title','remind_on','case_id','attached_at','created_at','updated_at']::text[], null,
   'The steward''s own private reminder (title and date). Exported to that steward; deleted with the account.',
   date '2026-10-08');

create function private.account_lifecycle_export_steward_private_reminders(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'owner_id', t.owner_id, 'organization_id', t.organization_id, 'title', t.title,
    'remind_on', t.remind_on, 'case_id', t.case_id, 'attached_at', t.attached_at,
    'created_at', t.created_at, 'updated_at', t.updated_at) order by t.created_at, t.id), '[]'::jsonb)
  from private.steward_private_reminders t where t.owner_id = p_caller;
$$;

revoke all on function private.account_lifecycle_export_steward_private_reminders(uuid) from public, anon, authenticated, service_role;

-- Re-emitted from the installed definition (20261008100000) with one added
-- steward_private_reminders domain; every other key is unchanged.
create or replace function private.account_lifecycle_export_additional_domains(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_space_notification_settings', private.account_lifecycle_export_chapter_space_notification_settings(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_event_contact_links', private.account_lifecycle_export_member_event_contact_links(p_caller), 'member_event_contact_opt_ins', private.account_lifecycle_export_member_event_contact_opt_ins(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_profile_details', private.account_lifecycle_export_member_profile_details(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller), 'steward_contact_preferences', private.account_lifecycle_export_steward_contact_preferences(p_caller), 'steward_private_reminders', private.account_lifecycle_export_steward_private_reminders(p_caller)
  );
$$;

revoke all on function private.account_lifecycle_export_additional_domains(uuid) from public, anon, authenticated, service_role;

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger'
  and schema_name = 'private' and table_name = 'steward_private_reminders'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

do $assert_steward_private_reminders_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after steward private reminders';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after steward private reminders';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after steward private reminders';
  end if;
end;
$assert_steward_private_reminders_lifecycle$;

notify pgrst, 'reload schema';

commit;
