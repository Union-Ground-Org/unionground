begin;
set local lock_timeout = '5s';

-- In-repository row auditing; no audit extension or time-based expiry.
-- Case-scoped versions disappear with their case. Organization-only records
-- remain private and follow organization deletion. Actor attribution detaches.
create table private.casework_record_versions (
  id bigint generated always as identity primary key,
  case_id uuid references public.member_cases(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  chapter_id text,
  record_table text not null,
  record_id text not null,
  op text not null check (op in ('INSERT','UPDATE','DELETE')),
  old_row jsonb,
  new_row jsonb,
  actor uuid references auth.users(id) on delete set null,
  at timestamptz not null default clock_timestamp()
);
create index casework_record_versions_case_at_idx
  on private.casework_record_versions(case_id, at desc, id desc);
create index casework_record_versions_record_idx
  on private.casework_record_versions(record_table, record_id, id desc);
alter table private.casework_record_versions enable row level security;
revoke all on private.casework_record_versions from public, anon, authenticated, service_role;
revoke all on sequence private.casework_record_versions_id_seq from public, anon, authenticated, service_role;

-- Join the established account/case locking protocol, including FK actions.
create trigger a00_case_graph_lock before insert or update or delete on private.casework_record_versions
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.casework_record_versions
for each row execute function private.lock_case_graph_row_keys('{actor}', '{case_id}');

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_inventory_basis, exclusion_reason, note)
values ('private', 'casework_record_versions', 'actor', 'pseudonymize',
  'excluded_with_reason', 'auth_user_fk',
  'Private historical snapshots can contain other people and staff-only case material; actor attribution is not ownership.',
  'Actor detaches on account deletion; case-owned versions cascade with the case.');
insert into private.account_lifecycle_transitive_fk_manifest
  (parent_schema_name, parent_table_name, schema_name, table_name, constraint_name,
   delete_disposition, review_reason)
values
  ('public', 'member_cases', 'private', 'casework_record_versions',
   'casework_record_versions_case_id_fkey', 'cascade', 'Versions live exactly as long as their case.');

create function private.capture_casework_record_version()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  previous jsonb; following jsonb; row_data jsonb; case_key uuid;
  parent_table text; parent_key text; record_key text; chapter_key text;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  if tg_op <> 'INSERT' then previous := pg_catalog.to_jsonb(old); end if;
  if tg_op <> 'DELETE' then following := pg_catalog.to_jsonb(new); end if;
  if tg_op = 'UPDATE' and previous - 'updated_at' = following - 'updated_at' then
    return null;
  end if;
  row_data := coalesce(following, previous);
  record_key := coalesce(row_data ->> 'id',
    (row_data ->> 'pattern_id') || ':' || (row_data ->> 'report_id'));
  case_key := case when tg_table_name = 'member_cases' then (row_data ->> 'id')::uuid
    else coalesce(row_data ->> 'case_id', row_data ->> 'source_case_id', previous ->> 'case_id')::uuid end;
  chapter_key := row_data ->> 'chapter_id';
  -- Child rows carry no case_id. Resolve each parent with its own constant
  -- statement: dynamic EXECUTE is unanalyzable and the conventions verifier
  -- refuses it, so every lookup below is a fixed relation.
  case tg_table_name
    when 'casework_deadline_extensions' then
      parent_table := 'casework_deadlines'; parent_key := coalesce(row_data ->> 'deadline_id', previous ->> 'deadline_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_deadlines p where p.id = parent_key::uuid;
    when 'casework_checklist_items' then
      parent_table := 'casework_checklists'; parent_key := coalesce(row_data ->> 'checklist_id', previous ->> 'checklist_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_checklists p where p.id = parent_key::uuid;
    when 'casework_alert_acknowledgements' then
      parent_table := 'casework_alerts'; parent_key := coalesce(row_data ->> 'alert_id', previous ->> 'alert_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_alerts p where p.id = parent_key::uuid;
    when 'casework_management_addenda' then
      parent_table := 'casework_management_entries'; parent_key := coalesce(row_data ->> 'entry_id', previous ->> 'entry_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_management_entries p where p.id = parent_key::uuid;
    when 'casework_retaliation_pattern_reports' then
      parent_table := 'casework_retaliation_reports'; parent_key := coalesce(row_data ->> 'report_id', previous ->> 'report_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_retaliation_reports p where p.id = parent_key::uuid;
    else null;
  end case;
  -- During a parent cascade the live parent row can already be gone; the
  -- parent's own last captured version still carries the case.
  if parent_table is not null and case_key is null then
    select v.case_id, v.chapter_id into case_key, chapter_key from private.casework_record_versions v
    where v.record_table = parent_table and v.record_id = parent_key
    order by v.id desc limit 1;
  end if;
  -- Retained children may be detached by a case cascade after its versions
  -- have already disappeared. The existing lifecycle snapshot identifies that
  -- case even for rows which predate this migration.
  if case_key is null then
    select h.case_id into case_key from private.account_lifecycle_history_scope h
    where (h.kind = 'deadline_extension' and tg_table_name = 'casework_deadline_extensions' and h.record_id = record_key)
       or (h.kind = 'management_entry' and h.record_id = case when tg_table_name = 'casework_management_addenda' then parent_key when tg_table_name = 'casework_management_entries' then record_key end)
       or (h.kind = 'retaliation_report' and h.record_id = case when tg_table_name = 'casework_retaliation_pattern_reports' then parent_key when tg_table_name = 'casework_retaliation_reports' then record_key end)
    limit 1;
  end if;
  -- These children always belong to a case. No unscoped snapshot survives a
  -- cascade whose parent and version have both already been removed.
  if case_key is null and tg_table_name = any(array[
    'casework_checklist_items','casework_alert_acknowledgements','casework_deadline_extensions'
  ]) then return null; end if;
  -- Never resurrect versions during the case's own delete/cascade/detachment.
  if case_key is not null and not exists (select 1 from public.member_cases c where c.id = case_key) then
    return null;
  end if;
  if row_data ->> 'organization_id' is not null and not exists (
    select 1 from public.organizations o where o.id = (row_data ->> 'organization_id')::uuid
  ) then return null; end if;
  insert into private.casework_record_versions
    (case_id, organization_id, chapter_id, record_table, record_id, op, old_row, new_row, actor)
  values (case_key, (row_data ->> 'organization_id')::uuid, chapter_key, tg_table_name,
    record_key, tg_op, previous, following, (select u.id from auth.users u where u.id = auth.uid()));
  return null;
end;
$function$;
revoke all on function private.capture_casework_record_version() from public, anon, authenticated, service_role;

create trigger casework_record_version after insert or update or delete on public.member_cases
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_access_grants
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_strength_analyses
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_bargaining_workspaces
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_bargaining_proposals
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_bargaining_events
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_deadlines
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_deadline_extensions
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_checklist_templates
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_checklists
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_checklist_items
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_step_transitions
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_alerts
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_alert_acknowledgements
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_management_people
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_management_entries
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_management_addenda
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_retaliation_reports
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_retaliation_patterns
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_retaliation_pattern_reports
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_retaliation_pattern_notes
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_intake_drafts
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_entity_links
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_reminders
  for each row execute function private.capture_casework_record_version();
create trigger casework_record_version after insert or update or delete on public.casework_audit_events
  for each row execute function private.capture_casework_record_version();

-- This is the only read boundary for private snapshots. No raw snapshot or
-- encrypted envelope is returned. Table-specific restrictions survive deletion.
create function private.casework_history_versions(p_case_id uuid)
returns table (event_id text, kind text, at timestamptz, actor_user_id uuid, details jsonb)
language sql stable security definer set search_path = '' as $function$
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
          and private.member_has_chapter_role(v.chapter_id, array['steward','coordinator','advisor','admin','vp']))
        or (v.record_table = any(array['casework_intake_drafts','casework_reminders'])
          and coalesce(v.new_row, v.old_row) ->> 'owner_user_id' = auth.uid()::text
          and (v.record_table <> 'casework_intake_drafts' or private.member_has_chapter_role(v.chapter_id, array['steward','coordinator','advisor','admin','vp'])))
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
revoke all on function private.casework_history_versions(uuid) from public, anon, authenticated, service_role;
grant execute on function private.casework_history_versions(uuid) to authenticated;

-- SECURITY INVOKER intentionally preserves each source table's current RLS,
-- MFA and column grants (including the narrower coordinator audit policies).
-- A timestamp-only cursor must return the entire final timestamp group to
-- avoid losing rows written in one transaction. p_limit is a target page size.
create function public.casework_case_history(
  p_case_id uuid, p_limit integer default 50, p_before timestamptz default null
)
returns table (
  event_id text, kind text, at timestamptz,
  actor_user_id uuid, actor_name text, actor_role text, details jsonb
)
language sql stable security invoker set search_path = '' as $function$
  with events as (
    -- The note author is readable by anyone the row's own RLS already admits.
    select 'note:' || n.id event_id, 'note'::text kind, n.created_at at, n.user_id actor_user_id,
      pg_catalog.jsonb_build_object('body', n.body) details
    from public.member_case_updates n where n.case_id = p_case_id
    union all
    select 'transition:' || s.id, 'transition', s.created_at, s.transitioned_by,
      pg_catalog.jsonb_build_object('from_step', s.from_step, 'to_step', s.to_step, 'outcome', s.outcome)
    from public.casework_step_transitions s where s.case_id = p_case_id
    union all
    select 'assignment:' || a.id, 'assignment', a.created_at, a.actor_id,
      pg_catalog.jsonb_build_object('before', a.before_assignment, 'after', a.after_assignment)
    from public.member_case_assignment_audit a where a.case_id = p_case_id
      and private.casework_staff_can_access(p_case_id)
    union all
    select 'coordinator:' || a.id, 'coordinator', a.created_at, a.actor_id,
      pg_catalog.jsonb_build_object('action', a.action, 'before', a.before_value, 'after', a.after_value, 'reason', a.reason)
    from public.coordinator_case_audit a where a.case_id = p_case_id
      and private.casework_staff_can_access(p_case_id)
    union all
    select 'audit:' || a.id, 'audit', a.created_at, a.actor_user_id,
      pg_catalog.jsonb_build_object('action', a.event_type, 'metadata', a.metadata)
    from public.casework_audit_events a where a.case_id = p_case_id
      and private.casework_staff_can_access(p_case_id)
    union all
    select * from private.casework_history_versions(p_case_id)
  ), page as (
    select * from events where private.casework_can_read(p_case_id)
      and (p_before is null or events.at < p_before)
    order by events.at desc
    fetch first (greatest(1, least(coalesce(p_limit, 50), 100))) rows with ties
  -- Attribution is resolved under the CALLER's own visibility and nothing
  -- wider. public.member_profiles answers only for the accounts
  -- private.staff_visible_member_ids (the set-wise public.staff_can_see_user)
  -- already exposes, plus the caller's own row; the assignee labels stamped on
  -- public.member_cases are exactly the two staff names a member may already
  -- read on their own case, which is where the case detail's assignee line
  -- comes from. A member therefore names their own steward, their own
  -- coordinator and themselves, and no other staff account. An actor the
  -- caller may not name carries a role label instead: the uuid is never a
  -- display value.
  ), subject as (
    select c.user_id member_user_id, c.steward_user_id, c.steward_name,
      c.coordinator_user_id, c.coordinator_name
    from public.member_cases c where c.id = p_case_id
  )
  select page.event_id, page.kind, page.at, page.actor_user_id,
    nullif(pg_catalog.btrim(coalesce(
      (select p.full_name from public.member_profiles p where p.id = page.actor_user_id),
      (select s.steward_name from subject s where s.steward_user_id = page.actor_user_id),
      (select s.coordinator_name from subject s where s.coordinator_user_id = page.actor_user_id),
      '')), ''),
    case
      when page.actor_user_id is null then null
      when exists (select 1 from subject s where s.steward_user_id = page.actor_user_id) then 'steward'
      when exists (select 1 from subject s where s.coordinator_user_id = page.actor_user_id) then 'coordinator'
      when exists (select 1 from subject s where s.member_user_id = page.actor_user_id) then 'member'
      else 'staff'
    end,
    page.details
  from page order by page.at desc, page.event_id desc;
$function$;
revoke all on function public.casework_case_history(uuid, integer, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.casework_case_history(uuid, integer, timestamptz) to authenticated;

-- Pin only this migration's reviewed trigger surface. Existing lifecycle
-- guards and their hashes remain unchanged.
insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash) values
  ('function', 'private', '', 'capture_casework_record_version()', 'c5546b62a059c672fa235e17f650d45c'),
  ('trigger', 'private', 'casework_record_versions', 'a00_case_graph_lock', '3565b955519acd80e8734d64de8273d7'),
  ('trigger', 'private', 'casework_record_versions', 'z99_case_graph_keys', '971390ed1163fa95736d33e0e7b2537c'),
  ('trigger', 'public', 'casework_access_grants', 'casework_record_version', 'dda7a4ddc9e447fbcc08f8fc59a5f50f'),
  ('trigger', 'public', 'casework_alert_acknowledgements', 'casework_record_version', '77b8a103479f0001e58876f8c14d63b7'),
  ('trigger', 'public', 'casework_alerts', 'casework_record_version', '608bc809231df4978e6077f965daa345'),
  ('trigger', 'public', 'casework_audit_events', 'casework_record_version', '987c648bac8a9f3bcd8c99f06cd15acc'),
  ('trigger', 'public', 'casework_bargaining_events', 'casework_record_version', '986f2dc592e51f2dbd938149ed3deb18'),
  ('trigger', 'public', 'casework_bargaining_proposals', 'casework_record_version', 'dd3c9ae0bf2bcc807c10b87a07619e3c'),
  ('trigger', 'public', 'casework_bargaining_workspaces', 'casework_record_version', 'c57a58ce8bc7b7634b524ff8fdb61964'),
  ('trigger', 'public', 'casework_checklist_items', 'casework_record_version', '6a0f164b60c13a7eecf3009656a63f66'),
  ('trigger', 'public', 'casework_checklist_templates', 'casework_record_version', 'c43deaf0289d50faec2cb77f3df02975'),
  ('trigger', 'public', 'casework_checklists', 'casework_record_version', '26eec090da7be036ccf1e75c859558db'),
  ('trigger', 'public', 'casework_deadline_extensions', 'casework_record_version', '1d18d89a440a73a76688fcb9805b1c1b'),
  ('trigger', 'public', 'casework_deadlines', 'casework_record_version', '90b5e10c4e2e754446109711a20bdc6a'),
  ('trigger', 'public', 'casework_entity_links', 'casework_record_version', '2f78d04b498eb463aaff7a176300fde7'),
  ('trigger', 'public', 'casework_intake_drafts', 'casework_record_version', '21c481bc8c893f34207eb976b2791a1f'),
  ('trigger', 'public', 'casework_management_addenda', 'casework_record_version', '07f36f93906e510ab673afae1d0123df'),
  ('trigger', 'public', 'casework_management_entries', 'casework_record_version', '27cf1a3f9f6179fea93eb5b2f6754b95'),
  ('trigger', 'public', 'casework_management_people', 'casework_record_version', 'f3be7cc69e5c1048a38e10bb3861b4d9'),
  ('trigger', 'public', 'casework_reminders', 'casework_record_version', 'f300987b75ef6371ffbc058fb2d602da'),
  ('trigger', 'public', 'casework_retaliation_pattern_notes', 'casework_record_version', 'd710ab4b6371c919db336f4b2b300116'),
  ('trigger', 'public', 'casework_retaliation_pattern_reports', 'casework_record_version', 'ce7f9db8ebe0cd5f148ce02d91b738c2'),
  ('trigger', 'public', 'casework_retaliation_patterns', 'casework_record_version', '36b3ba98989c90e4494697ba677403cf'),
  ('trigger', 'public', 'casework_retaliation_reports', 'casework_record_version', '71598a56ba4198568289b9d0294ab006'),
  ('trigger', 'public', 'casework_step_transitions', 'casework_record_version', 'd2066a982b107a772db86f3922f56551'),
  ('trigger', 'public', 'casework_strength_analyses', 'casework_record_version', '19032653c576b804850170a47044defd'),
  ('trigger', 'public', 'member_cases', 'casework_record_version', 'a2653e6be60d0314b734ed9bd6682edd');

commit;
