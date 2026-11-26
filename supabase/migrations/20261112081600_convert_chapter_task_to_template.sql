-- BUG-UG-TASK-TYPE-CHANGE-OPENS-TEMPLATE-CHOOSER-20261111 (#8211),
-- option A of a project decision
-- Picking a specialized Type on an existing General task could not change it:
-- private.guard_chapter_task_template_type refused every type conversion
-- "until an explicit conversion product flow exists". This is that flow.
-- public.convert_chapter_task_to_template turns one live General task into a
-- specialized one, validating the template fields exactly as
-- public.create_chapter_task_from_template does (the block below is the same
-- text) and writing the same detail row, under the same staff and chapter
-- rules. Only General -> specialized is allowed; a specialized type stays
-- fixed. The task keeps its title, workstream, status, priority and
-- assignees; a blank description takes the template checklist, and a date the
-- template derives fills only an empty start or due date. Like the template
-- detail writers it takes the case-graph lock first and is not journalled for
-- learning-period undo: an undo could only restore General, which the guard
-- refuses for a specialized task. The task's own type_changed history row
-- records the change.

begin;

create or replace function private.guard_chapter_task_template_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
     and new.task_type <> 'general'
     and pg_catalog.current_setting('sg.creating_template_task', true) is distinct from '1' then
    raise exception 'specialized tasks require template creation' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and new.task_type is distinct from old.task_type
     and (old.task_type <> 'general' or new.task_type <> 'general') then
    -- Only public.convert_chapter_task_to_template sets this flag, for one
    -- General task, after writing nothing else; specialized -> anything stays
    -- refused.
    if old.task_type = 'general'
       and pg_catalog.current_setting('sg.converting_template_task', true) = '1' then
      return new;
    end if;
    raise exception 'specialized task conversion unavailable' using errcode = '22023';
  end if;
  return new;
end
$$;

revoke all on function private.guard_chapter_task_template_type()
  from public, anon, authenticated, service_role;


create or replace function public.convert_chapter_task_to_template(
  p_task_id uuid,
  p_template_key text,
  p_fields jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  locked_caller_role text;
  locked_reviewer_role text;
  selected_template private.chapter_task_template_catalog%rowtype;
  initial_step private.chapter_task_template_flow_steps%rowtype;
  target_task public.chapter_tasks%rowtype;
  checklist_body text := '';
  scheduled_value date;
  start_value time;
  end_value time;
  venue_value text;
  review_value text;
  reviewer_value uuid;
  contact_value text;
  follow_up_value date;
  category_value text;
  source_value text;
  occurred_value date;
  severity_value text;
  task_start date;
  task_due date;
  converted_task public.chapter_tasks%rowtype;
  inserted_detail public.chapter_task_template_details%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  -- The held profile and one held effective staff grant, so a revoke or
  -- chapter move cannot race the write. member_has_role accepts an
  -- organization grant of the caller's chapter or a chapter grant, and
  -- grantMemberRole writes organization grants only, so those are held first;
  -- a legacy role row still counts (gate round 4, r4s2).
  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller
  for share of p;
  select org_role.role into locked_caller_role
  from public.organization_role_grants org_role
  join public.chapters caller_chapter_row on caller_chapter_row.organization_id = org_role.organization_id
  where caller_chapter_row.id = caller_chapter
    and org_role.user_id = caller
    and org_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
  order by org_role.role
  limit 1
  for share of org_role;
  if locked_caller_role is null then
    select chapter_role.role into locked_caller_role
    from public.member_role_chapters chapter_role
    where chapter_role.user_id = caller
      and chapter_role.chapter_id = caller_chapter
      and chapter_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    order by chapter_role.role
    limit 1
    for share of chapter_role;
  end if;
  if locked_caller_role is null then
    select staff_role.role into locked_caller_role
    from public.member_roles staff_role
    where staff_role.user_id = caller
      and staff_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
      and (staff_role.chapter_id is null or staff_role.chapter_id = caller_chapter)
    order by (staff_role.chapter_id = caller_chapter) desc, staff_role.role
    limit 1
    for share of staff_role;
  end if;
  if caller_chapter is null or locked_caller_role is null then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  -- One live task of the caller's own chapter, held for the conversion.
  select t.* into target_task
  from public.chapter_tasks t
  where t.id = p_task_id
    and t.chapter_id = caller_chapter
    and t.deleted_at is null
  for update of t;
  if target_task.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  if target_task.task_type <> 'general'
     or exists (select 1 from public.chapter_task_template_details d where d.task_id = target_task.id) then
    raise exception 'specialized task conversion unavailable' using errcode = '22023';
  end if;

  select c.* into selected_template
  from private.chapter_task_template_catalog c
  where c.template_key = p_template_key and c.active;
  if selected_template.template_key is null then
    raise exception 'template unavailable' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(coalesce(p_fields, 'null'::jsonb)) <> 'object'
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_fields) submitted(field_key)
       where not exists (
         select 1 from private.chapter_task_template_fields f
         where f.template_key = selected_template.template_key
           and f.field_key = submitted.field_key
       )
     )
     or exists (
       select 1 from private.chapter_task_template_fields f
       where f.template_key = selected_template.template_key and f.required
         and (not p_fields ? f.field_key or nullif(btrim(p_fields ->> f.field_key), '') is null)
     ) then
    raise exception 'template fields invalid' using errcode = '22023';
  end if;

  begin
    if selected_template.template_key = 'meeting_event' then
      if pg_catalog.jsonb_typeof(p_fields->'scheduled_on') <> 'string'
         or (p_fields->>'scheduled_on') !~ '^\d{4}-\d{2}-\d{2}$'
         or pg_catalog.jsonb_typeof(p_fields->'venue_mode') <> 'string' then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      scheduled_value := (p_fields->>'scheduled_on')::date;
      venue_value := p_fields->>'venue_mode';
      if venue_value not in ('in_person','phone','video','hybrid') then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      if nullif(p_fields->>'starts_at', '') is not null then
        if pg_catalog.jsonb_typeof(p_fields->'starts_at') <> 'string'
           or (p_fields->>'starts_at') !~ '^\d{2}:\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        start_value := (p_fields->>'starts_at')::time;
      end if;
      if nullif(p_fields->>'ends_at', '') is not null then
        if pg_catalog.jsonb_typeof(p_fields->'ends_at') <> 'string'
           or (p_fields->>'ends_at') !~ '^\d{2}:\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        end_value := (p_fields->>'ends_at')::time;
      end if;
      if end_value is not null and (start_value is null or end_value <= start_value) then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      task_start := scheduled_value;
      task_due := scheduled_value;
    elsif selected_template.template_key = 'review_approval' then
      review_value := p_fields->>'review_kind';
      if pg_catalog.jsonb_typeof(p_fields->'review_kind') <> 'string'
         or review_value not in ('document','publication','decision','other') then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      if nullif(p_fields->>'reviewer_id', '') is not null then
        if pg_catalog.jsonb_typeof(p_fields->'reviewer_id') <> 'string' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        reviewer_value := (p_fields->>'reviewer_id')::uuid;
        locked_reviewer_role := null;
        -- The reviewer is eligible exactly as the offered reviewer roster
        -- offers it (actor_has_chapter_staff_role), and its profile and one
        -- effective grant are held through the write (gate round 4, r4s2).
        perform 1 from public.member_profiles p
          where p.id = reviewer_value and p.chapter_id = caller_chapter
          for share of p;
        if found and private.actor_has_chapter_staff_role(reviewer_value, caller_chapter) then
          select org_role.role into locked_reviewer_role
            from public.organization_role_grants org_role
            join public.chapters reviewer_chapter on reviewer_chapter.organization_id = org_role.organization_id
            where reviewer_chapter.id = caller_chapter
              and org_role.user_id = reviewer_value
              and org_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
            order by org_role.role
            limit 1
            for share of org_role;
          if locked_reviewer_role is null then
            select chapter_role.role into locked_reviewer_role
              from public.member_role_chapters chapter_role
              where chapter_role.user_id = reviewer_value
                and chapter_role.chapter_id = caller_chapter
                and chapter_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
              order by chapter_role.role
              limit 1
              for share of chapter_role;
          end if;
          if locked_reviewer_role is null then
            select reviewer_role.role into locked_reviewer_role
              from public.member_roles reviewer_role
              where reviewer_role.user_id = reviewer_value
                and reviewer_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
                and (reviewer_role.chapter_id is null or reviewer_role.chapter_id = caller_chapter)
              order by (reviewer_role.chapter_id = caller_chapter) desc, reviewer_role.role
              limit 1
              for share of reviewer_role;
          end if;
        end if;
        if locked_reviewer_role is null then
          raise exception 'reviewer must belong to this chapter' using errcode = '22023';
        end if;
      end if;
    elsif selected_template.template_key = 'member_follow_up' then
      contact_value := p_fields->>'contact_method';
      if pg_catalog.jsonb_typeof(p_fields->'contact_method') <> 'string'
         or contact_value not in ('phone','email','in_person','message','other')
         or pg_catalog.jsonb_typeof(p_fields->'follow_up_on') <> 'string'
         or (p_fields->>'follow_up_on') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      follow_up_value := (p_fields->>'follow_up_on')::date;
      task_due := follow_up_value;
    elsif selected_template.template_key = 'document_request' then
      category_value := p_fields->>'record_category';
      source_value := p_fields->>'record_source';
      if pg_catalog.jsonb_typeof(p_fields->'record_category') <> 'string'
         or category_value not in ('workplace_record','policy','correspondence','other')
         or pg_catalog.jsonb_typeof(p_fields->'record_source') <> 'string'
         or source_value not in ('member','employer','union','third_party') then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
    elsif selected_template.template_key = 'issue_incident' then
      severity_value := p_fields->>'incident_severity';
      if pg_catalog.jsonb_typeof(p_fields->'occurred_on') <> 'string'
         or (p_fields->>'occurred_on') !~ '^\d{4}-\d{2}-\d{2}$'
         or pg_catalog.jsonb_typeof(p_fields->'incident_severity') <> 'string'
         or severity_value not in ('low','medium','high','urgent') then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      occurred_value := (p_fields->>'occurred_on')::date;
      task_start := occurred_value;
    end if;
  exception
    when invalid_text_representation or datetime_field_overflow then
      raise exception 'template fields invalid' using errcode = '22023';
  end;

  select s.* into initial_step
  from private.chapter_task_template_flow_steps s
  where s.template_key = selected_template.template_key
  order by s.position
  limit 1;

  select coalesce(pg_catalog.string_agg('- [ ] ' || item.label_en, pg_catalog.chr(10) order by item.position), '')
    into checklist_body
  from private.chapter_task_template_checklist_items item
  where item.template_key = selected_template.template_key;

  perform pg_catalog.set_config('sg.converting_template_task', '1', true);
  update public.chapter_tasks t
  set task_type = selected_template.template_key,
      description = case when pg_catalog.btrim(coalesce(t.description, '')) = '' then checklist_body else t.description end,
      -- A date the task already has is kept. A missing one is filled from the
      -- template only when it stays ordered against the kept one
      -- (chapter_tasks_dates_ordered); otherwise it stays empty, and the
      -- template's own date is still in its details row.
      start_date = case
        when t.start_date is not null then t.start_date
        when t.due_date is null or task_start <= t.due_date then task_start
      end,
      due_date = case
        when t.due_date is not null then t.due_date
        when t.start_date is null or task_due >= t.start_date then task_due
      end,
      updated_by = caller
  where t.id = target_task.id
  returning t.* into converted_task;
  perform pg_catalog.set_config('sg.converting_template_task', '', true);

  insert into public.chapter_task_template_details (
    task_id, chapter_id, template_key, flow_step,
    scheduled_on, starts_at, ends_at, venue_mode,
    review_kind, reviewer_id, contact_method, follow_up_on,
    record_category, record_source, occurred_on, incident_severity,
    created_by, updated_by
  ) values (
    converted_task.id, converted_task.chapter_id, selected_template.template_key, initial_step.step_key,
    scheduled_value, start_value, end_value, venue_value,
    review_value, reviewer_value, contact_value, follow_up_value,
    category_value, source_value, occurred_value, severity_value,
    caller, caller
  ) returning * into inserted_detail;

  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(converted_task),
    'details', pg_catalog.to_jsonb(inserted_detail)
  );
end;
end
$$;

revoke all on function public.convert_chapter_task_to_template(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.convert_chapter_task_to_template(uuid, text, jsonb)
  to authenticated;
grant execute on function public.convert_chapter_task_to_template(uuid, text, jsonb)
  to service_role;

-- Reviewed trigger surface (account lifecycle inventory): the redefined type
-- guard, the trigger that runs it, and the converter, whose task update the
-- guard sees. Recorded after both functions exist.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'public' and table_name = 'chapter_tasks'
        and object_name = 'chapter_tasks_guard_template_type')
   or (kind = 'function' and schema_name = 'private' and object_name = 'guard_chapter_task_template_type()')
   or (kind = 'function' and schema_name = 'public'
       and object_name = 'convert_chapter_task_to_template(p_task_id uuid, p_template_key text, p_fields jsonb)')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_type_conversion_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the task type guard: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
end;
$assert_type_conversion_lifecycle$;

notify pgrst, 'reload schema';

commit;
