-- BUG-UG-TEMPLATE-TASK-CREATION-REFUSES-ORGANIZATION-GRANT-STAFF-20261111,
-- with.
-- Creating a task from a template, and editing a template task's fields, held
-- the caller's staff grant and the reviewer's grant by reading the legacy
-- member_roles table only. Role grants are written as organization grants
-- now, and the staff policy check accepts them, so a steward granted that
-- way passed the policy check and was then refused with 'staff role
-- required', and could not be named as reviewer although the reviewer
-- roster offers them ('reviewer must belong to this chapter').
--
-- Both functions now hold the effective grant the way the task-to-template
-- converter does: an organization grant of the caller's chapter
-- first, then a chapter grant for that chapter, then a legacy role row, each
-- FOR SHARE so a revoke or chapter move cannot race the write. A reviewer is
-- accepted exactly when the roster would offer them, with the reviewer's
-- profile and one effective grant held. The bodies are otherwise the live
-- definitions from 20261103183000_learning_period_tasks.sql, unchanged.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.create_chapter_task_from_template(
  p_template_key text,
  p_title text,
  p_workstream text,
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
  clean_workstream text;
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
  inserted_task public.chapter_tasks%rowtype;
  inserted_detail public.chapter_task_template_details%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- Preserve the organization policy that requires an enrolled, verified
  -- second factor before any staff grant is effective. The scoped row lock
  -- below is still required to keep that effective grant stable through the
  -- write; member_has_role is the policy gate, not a substitute for the lock.
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 160 then
    raise exception 'task title invalid' using errcode = '22023';
  end if;

  -- The held profile and one held effective staff grant, so a revoke or
  -- chapter move cannot race the write. The staff check above accepts an
  -- organization grant of the caller's chapter or a chapter grant, and role
  -- grants are now written as organization grants, so those are held first;
  -- a legacy role row still counts .
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

  select c.* into selected_template
  from private.chapter_task_template_catalog c
  where c.template_key = p_template_key and c.active;
  if selected_template.template_key is null then
    raise exception 'template unavailable' using errcode = '22023';
  end if;

  select w.name into clean_workstream
  from public.chapter_workstreams w
  where w.chapter_id = caller_chapter
    and lower(w.name) = lower(btrim(coalesce(p_workstream, '')))
  order by w.id
  limit 1
  for share of w;
  if clean_workstream is null then
    raise exception 'workstream unavailable' using errcode = '22023';
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

  perform pg_catalog.set_config('sg.creating_template_task', '1', true);
  insert into public.chapter_tasks (
    chapter_id, title, description, status, priority, workstream,
    assignee_name, start_date, due_date, task_type, created_by, updated_by
  ) values (
    caller_chapter, btrim(p_title), checklist_body, selected_template.default_status,
    selected_template.default_priority, clean_workstream, '', task_start, task_due,
    selected_template.template_key, caller, caller
  ) returning * into inserted_task;

  insert into public.chapter_task_template_details (
    task_id, chapter_id, template_key, flow_step,
    scheduled_on, starts_at, ends_at, venue_mode,
    review_kind, reviewer_id, contact_method, follow_up_on,
    record_category, record_source, occurred_on, incident_severity,
    created_by, updated_by
  ) values (
    inserted_task.id, inserted_task.chapter_id, selected_template.template_key, initial_step.step_key,
    scheduled_value, start_value, end_value, venue_value,
    review_value, reviewer_value, contact_value, follow_up_value,
    category_value, source_value, occurred_value, severity_value,
    caller, caller
  ) returning * into inserted_detail;

  perform private.notify_chapter_task_template_change(
    inserted_task.id, caller, selected_template.notification_copy_key
  );

  perform private.learning_task_journal('task_create', inserted_task.id, null);
  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(inserted_task),
    'details', pg_catalog.to_jsonb(inserted_detail)
  );
end;
end
$$;

create or replace function public.update_chapter_task_template_details(
  p_task_id uuid,
  p_fields jsonb,
  p_next_flow_step text,
  p_apply_recommended_status boolean default false
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
  task_row public.chapter_tasks%rowtype;
  detail_row public.chapter_task_template_details%rowtype;
  target_step private.chapter_task_template_flow_steps%rowtype;
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
  changed_flow boolean := false;
  old_flow_step text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller
  for share of p;
  select t.* into task_row
  from public.chapter_tasks t
  join public.chapter_task_template_details d on d.task_id = t.id and d.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
    and t.chapter_id = caller_chapter
  for update of t, d;
  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  -- One held effective staff grant for the task's chapter (the task row is
  -- limited to the caller's chapter above), held in the same order as task
  -- creation from a template: organization grant, chapter grant, legacy row.
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
  if locked_caller_role is null then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select d.* into detail_row
  from public.chapter_task_template_details d
  where d.task_id = task_row.id;
  old_flow_step := detail_row.flow_step;

  scheduled_value := detail_row.scheduled_on;
  start_value := detail_row.starts_at;
  end_value := detail_row.ends_at;
  venue_value := detail_row.venue_mode;
  review_value := detail_row.review_kind;
  reviewer_value := detail_row.reviewer_id;
  contact_value := detail_row.contact_method;
  follow_up_value := detail_row.follow_up_on;
  category_value := detail_row.record_category;
  source_value := detail_row.record_source;
  occurred_value := detail_row.occurred_on;
  severity_value := detail_row.incident_severity;

  if pg_catalog.jsonb_typeof(coalesce(p_fields, 'null'::jsonb)) <> 'object'
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_fields) submitted(field_key)
       where not exists (
         select 1 from private.chapter_task_template_fields f
         where f.template_key = detail_row.template_key and f.field_key = submitted.field_key
       )
     ) then
    raise exception 'template fields invalid' using errcode = '22023';
  end if;

  begin
    if detail_row.template_key = 'meeting_event' then
      if p_fields ? 'scheduled_on' then
        if pg_catalog.jsonb_typeof(p_fields->'scheduled_on') <> 'string'
           or (p_fields->>'scheduled_on') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        scheduled_value := (p_fields->>'scheduled_on')::date;
      end if;
      if p_fields ? 'venue_mode' then
        if pg_catalog.jsonb_typeof(p_fields->'venue_mode') <> 'string'
           or (p_fields->>'venue_mode') not in ('in_person','phone','video','hybrid') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        venue_value := p_fields->>'venue_mode';
      end if;
      if p_fields ? 'starts_at' then
        if p_fields->'starts_at' = 'null'::jsonb or nullif(p_fields->>'starts_at', '') is null then
          start_value := null;
        elsif pg_catalog.jsonb_typeof(p_fields->'starts_at') <> 'string'
              or (p_fields->>'starts_at') !~ '^\d{2}:\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        else
          start_value := (p_fields->>'starts_at')::time;
        end if;
      end if;
      if p_fields ? 'ends_at' then
        if p_fields->'ends_at' = 'null'::jsonb or nullif(p_fields->>'ends_at', '') is null then
          end_value := null;
        elsif pg_catalog.jsonb_typeof(p_fields->'ends_at') <> 'string'
              or (p_fields->>'ends_at') !~ '^\d{2}:\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        else
          end_value := (p_fields->>'ends_at')::time;
        end if;
      end if;
      if end_value is not null and (start_value is null or end_value <= start_value) then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
    elsif detail_row.template_key = 'review_approval' then
      if p_fields ? 'review_kind' then
        if pg_catalog.jsonb_typeof(p_fields->'review_kind') <> 'string'
           or (p_fields->>'review_kind') not in ('document','publication','decision','other') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        review_value := p_fields->>'review_kind';
      end if;
      if p_fields ? 'reviewer_id' then
        if p_fields->'reviewer_id' = 'null'::jsonb or nullif(p_fields->>'reviewer_id', '') is null then
          reviewer_value := null;
        elsif pg_catalog.jsonb_typeof(p_fields->'reviewer_id') <> 'string' then
          raise exception 'template fields invalid' using errcode = '22023';
        else
          reviewer_value := (p_fields->>'reviewer_id')::uuid;
        end if;
        locked_reviewer_role := null;
        if reviewer_value is not null then
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
        end if;
        if reviewer_value is not null and locked_reviewer_role is null then
          raise exception 'reviewer must belong to this chapter' using errcode = '22023';
        end if;
      end if;
    elsif detail_row.template_key = 'member_follow_up' then
      if p_fields ? 'contact_method' then
        if pg_catalog.jsonb_typeof(p_fields->'contact_method') <> 'string'
           or (p_fields->>'contact_method') not in ('phone','email','in_person','message','other') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        contact_value := p_fields->>'contact_method';
      end if;
      if p_fields ? 'follow_up_on' then
        if pg_catalog.jsonb_typeof(p_fields->'follow_up_on') <> 'string'
           or (p_fields->>'follow_up_on') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        follow_up_value := (p_fields->>'follow_up_on')::date;
      end if;
    elsif detail_row.template_key = 'document_request' then
      if p_fields ? 'record_category' then
        if pg_catalog.jsonb_typeof(p_fields->'record_category') <> 'string'
           or (p_fields->>'record_category') not in ('workplace_record','policy','correspondence','other') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        category_value := p_fields->>'record_category';
      end if;
      if p_fields ? 'record_source' then
        if pg_catalog.jsonb_typeof(p_fields->'record_source') <> 'string'
           or (p_fields->>'record_source') not in ('member','employer','union','third_party') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        source_value := p_fields->>'record_source';
      end if;
    elsif detail_row.template_key = 'issue_incident' then
      if p_fields ? 'occurred_on' then
        if pg_catalog.jsonb_typeof(p_fields->'occurred_on') <> 'string'
           or (p_fields->>'occurred_on') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        occurred_value := (p_fields->>'occurred_on')::date;
      end if;
      if p_fields ? 'incident_severity' then
        if pg_catalog.jsonb_typeof(p_fields->'incident_severity') <> 'string'
           or (p_fields->>'incident_severity') not in ('low','medium','high','urgent') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        severity_value := p_fields->>'incident_severity';
      end if;
    end if;
  exception
    when invalid_text_representation or datetime_field_overflow then
      raise exception 'template fields invalid' using errcode = '22023';
  end;

  if p_next_flow_step is not null and p_next_flow_step <> detail_row.flow_step then
    select s.* into target_step
    from private.chapter_task_template_flow_steps s
    where s.template_key = detail_row.template_key and s.step_key = p_next_flow_step;
    if target_step.step_key is null
       or not (target_step.predecessor_keys @> array[detail_row.flow_step]) then
      raise exception 'template flow transition invalid' using errcode = '22023';
    end if;
    changed_flow := true;
  end if;

  update public.chapter_task_template_details set
    flow_step = case when changed_flow then target_step.step_key else detail_row.flow_step end,
    scheduled_on = scheduled_value,
    starts_at = start_value,
    ends_at = end_value,
    venue_mode = venue_value,
    review_kind = review_value,
    reviewer_id = reviewer_value,
    contact_method = contact_value,
    follow_up_on = follow_up_value,
    record_category = category_value,
    record_source = source_value,
    occurred_on = occurred_value,
    incident_severity = severity_value,
    updated_by = caller,
    updated_at = now()
  where task_id = task_row.id
  returning * into detail_row;

  update public.chapter_tasks set
    start_date = case
      when detail_row.template_key = 'meeting_event' then scheduled_value
      when detail_row.template_key = 'issue_incident' then occurred_value
      else null
    end,
    due_date = case
      when detail_row.template_key = 'meeting_event' then scheduled_value
      when detail_row.template_key = 'member_follow_up' then follow_up_value
      else null
    end,
    updated_by = caller
  where id = task_row.id;

  if changed_flow then
    if coalesce(p_apply_recommended_status, false) then
      update public.chapter_tasks
      set status = target_step.recommended_status, updated_by = caller
      where id = task_row.id;
    end if;
  end if;

  if changed_flow then
    insert into public.chapter_task_activity (
      task_id, chapter_id, actor_id, action, from_value, to_value
    ) values (
      task_row.id, task_row.chapter_id, caller, 'template_flow_changed',
      old_flow_step, target_step.step_key
    );
    perform private.notify_chapter_task_template_change(
      task_row.id, caller, 'task.template.flow_changed'
    );
  end if;

  select t.* into task_row from public.chapter_tasks t where t.id = task_row.id;
  -- Recorded, not undoable: the template's own steps are not reversed in this slice.
  perform private.learning_journal_append('task_template_update', 'public.chapter_tasks', task_row.id::text);
  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(task_row),
    'details', pg_catalog.to_jsonb(detail_row)
  );
end;
end
$$;

commit;
