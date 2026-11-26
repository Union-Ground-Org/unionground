-- UB-CW-04: restore authorized source-to-task conversion without copying the
-- source into chapter work. Typed provenance makes retries converge on one
-- inherited-permission Standard Task; the source's own access rules remain
-- authoritative when the RPC is called and when its neutral link is opened.

alter table public.chapter_task_attachments
  add column source_kind text,
  add column source_id text,
  add constraint chapter_task_attachments_source_pair_check
    check (
      (source_kind is null and source_id is null)
      or (
        source_kind in ('message', 'broadcast', 'notification', 'survey', 'case')
        and nullif(pg_catalog.btrim(source_id), '') is not null
      )
    );

create unique index chapter_task_attachments_source_once_idx
  on public.chapter_task_attachments (chapter_id, source_kind, source_id)
  where source_kind is not null;

comment on column public.chapter_task_attachments.source_kind is
  'Opaque typed provenance for an authorized source link; it grants no source access.';
comment on column public.chapter_task_attachments.source_id is
  'Opaque source identifier used only for idempotency and same-origin navigation; source content stays at the source.';
comment on index public.chapter_task_attachments_source_once_idx is
  'One current Standard Task conversion per typed source and chapter.';

create or replace function public.create_chapter_task_from_source(
  p_source_kind text,
  p_source_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
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
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller;
  if caller_chapter is null then
    raise exception 'source unavailable' using errcode = '22023';
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

  -- First prove exact-record access without relying on the broad staff gate.
  -- Mutable current/closed state is checked only after an authorized retry can
  -- find its existing outcome.
  case clean_kind
    when 'message' then
      select m.user_id, m.conversation_id into message_owner, message_conversation
      from public.member_messages m
      where m.id = source_uuid
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
      where b.id = clean_source_id;
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
      where s.id = clean_source_id;
      source_found := found;
      task_title := 'Follow up on survey';
      attachment_label := 'Authorized survey';
      record_url := '/m/voting?survey=' || clean_source_id;
    when 'case' then
      select c.* into case_row
      from public.member_cases c
      where c.id = source_uuid
        and (
          c.user_id = caller
          or (
            c.steward_user_id = caller
            and public.member_has_role(array['steward'])
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
          and public.member_has_role(array['steward'])
          then '/m/steward?case=' || clean_source_id
        else '/m/coordinator?case=' || clean_source_id
      end;
  end case;

  if not source_found then
    raise exception 'source unavailable' using errcode = '22023';
  end if;

  -- Serialize the typed source before checking/inserting. The unique index is
  -- the durable backstop; the transaction lock makes concurrent calls return
  -- the winning row instead of surfacing a uniqueness error.
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

  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(task_row),
    'attachment', pg_catalog.to_jsonb(attachment_row),
    'created', true
  );
end
$$;

revoke all on function public.create_chapter_task_from_source(text, text)
  from public, anon, authenticated;
grant execute on function public.create_chapter_task_from_source(text, text)
  to authenticated;

comment on function public.create_chapter_task_from_source(text, text) is
  'Creates or returns one privacy-quiet Standard Task for an exact source the MFA-authenticated staff caller can already read. The linked source retains its own authorization boundary.';

notify pgrst, 'reload schema';
