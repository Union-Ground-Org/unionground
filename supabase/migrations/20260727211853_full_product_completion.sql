-- REQ-UG-FULL-PRODUCT-COMPLETION-20260727
--
-- Complete the product surfaces left outside the clean-room rebuild. These
-- tables deliberately share chapter identity and a small number of primitives:
-- spaces hold durable organizing topics, threads hold an issue or decision,
-- posts hold the conversation, and links connect work rather than copying it.

alter table public.member_profiles
  add column dnd_enabled boolean not null default false,
  add column quiet_hours_start time,
  add column quiet_hours_end time,
  add column quiet_hours_timezone text not null default 'America/New_York',
  add column urgent_notifications_enabled boolean not null default true,
  add constraint member_profiles_quiet_hours_complete check (
    (quiet_hours_start is null and quiet_hours_end is null)
    or (quiet_hours_start is not null and quiet_hours_end is not null)
  ),
  add constraint member_profiles_quiet_hours_timezone_bounded
    check (char_length(quiet_hours_timezone) between 1 and 64);

create table public.chapter_spaces (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  name text not null,
  description text not null default '',
  visibility text not null default 'chapter' check (visibility in ('chapter', 'staff', 'private')),
  created_by uuid not null references auth.users(id) on delete restrict,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chapter_spaces_name_bounded check (char_length(btrim(name)) between 1 and 80),
  constraint chapter_spaces_description_bounded check (char_length(description) <= 1000),
  unique (chapter_id, name)
);

create table public.chapter_space_members (
  space_id uuid not null references public.chapter_spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'moderator')),
  notification_level text not null default 'all' check (notification_level in ('all', 'mentions', 'muted')),
  joined_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

create table public.chapter_threads (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null references public.chapter_spaces(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  title text not null,
  kind text not null default 'topic' check (kind in ('topic', 'issue', 'decision', 'task', 'case', 'intake')),
  status text not null default 'open' check (status in ('open', 'resolved', 'closed')),
  created_by uuid not null references auth.users(id) on delete restrict,
  task_id uuid references public.chapter_tasks(id) on delete set null,
  case_id uuid references public.member_cases(id) on delete set null,
  pinned_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chapter_threads_title_bounded check (char_length(btrim(title)) between 1 and 160)
);

create table public.chapter_thread_posts (
  id uuid primary key default extensions.gen_random_uuid(),
  thread_id uuid not null references public.chapter_threads(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  author_id uuid not null references auth.users(id) on delete restrict,
  body text not null,
  parent_post_id uuid references public.chapter_thread_posts(id) on delete set null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint chapter_thread_posts_body_bounded check (char_length(btrim(body)) between 1 and 8000)
);

create table public.member_intake_reports (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('workplace_issue', 'app_feedback', 'question', 'safety', 'other')),
  title text not null,
  details text not null,
  status text not null default 'new' check (status in ('new', 'triaged', 'in_progress', 'closed')),
  assigned_to uuid references auth.users(id) on delete set null,
  thread_id uuid references public.chapter_threads(id) on delete set null,
  case_id uuid references public.member_cases(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_intake_reports_title_bounded check (char_length(btrim(title)) between 1 and 160),
  constraint member_intake_reports_details_bounded check (char_length(btrim(details)) between 1 and 10000)
);

create table public.chapter_documents (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  title text not null,
  document_type text not null check (document_type in ('contract', 'policy', 'poms', 'minutes', 'training', 'template', 'other')),
  summary text not null default '',
  body text not null default '',
  source_url text,
  version integer not null default 1 check (version > 0),
  visibility text not null default 'chapter' check (visibility in ('chapter', 'staff')),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by uuid not null references auth.users(id) on delete restrict,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chapter_documents_title_bounded check (char_length(btrim(title)) between 1 and 200),
  constraint chapter_documents_summary_bounded check (char_length(summary) <= 1000),
  constraint chapter_documents_body_bounded check (char_length(body) <= 100000)
);

create table public.chapter_records (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  record_type text not null check (record_type in ('minutes', 'decision', 'milestone', 'management_contact', 'member_contact')),
  title text not null,
  body text not null,
  occurred_at timestamptz not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  thread_id uuid references public.chapter_threads(id) on delete set null,
  task_id uuid references public.chapter_tasks(id) on delete set null,
  case_id uuid references public.member_cases(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint chapter_records_title_bounded check (char_length(btrim(title)) between 1 and 200),
  constraint chapter_records_body_bounded check (char_length(btrim(body)) between 1 and 20000)
);

create table public.chapter_handshakes (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  partner_org_id text not null references public.union_orgs(id) on update cascade on delete restrict,
  title text not null,
  purpose text not null,
  data_scope text not null default 'docs_only' check (data_scope in ('docs_only', 'no_member_data', 'aggregate_only')),
  status text not null default 'draft' check (status in ('draft', 'requested', 'accepted', 'active', 'declined', 'closed')),
  requested_by uuid not null references auth.users(id) on delete restrict,
  countersigned_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz,
  countersigned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chapter_handshakes_title_bounded check (char_length(btrim(title)) between 1 and 160),
  constraint chapter_handshakes_purpose_bounded check (char_length(btrim(purpose)) between 1 and 4000)
);

create table public.chapter_governance_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  requester_id uuid not null references auth.users(id) on delete cascade,
  request_type text not null check (request_type in ('access', 'correction', 'export', 'deletion', 'retention_question')),
  details text not null,
  status text not null default 'submitted' check (status in ('submitted', 'reviewing', 'fulfilled', 'denied', 'cancelled')),
  handled_by uuid references auth.users(id) on delete set null,
  response text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chapter_governance_details_bounded check (char_length(btrim(details)) between 1 and 10000),
  constraint chapter_governance_response_bounded check (response is null or char_length(response) <= 10000)
);

create index chapter_spaces_chapter_updated_idx on public.chapter_spaces (chapter_id, updated_at desc);
create index chapter_threads_space_updated_idx on public.chapter_threads (space_id, updated_at desc);
create index chapter_threads_chapter_status_idx on public.chapter_threads (chapter_id, status, updated_at desc);
create index chapter_thread_posts_thread_created_idx on public.chapter_thread_posts (thread_id, created_at);
create index member_intake_reports_chapter_status_idx on public.member_intake_reports (chapter_id, status, created_at desc);
create index member_intake_reports_reporter_idx on public.member_intake_reports (reporter_id, created_at desc);
create index chapter_documents_chapter_status_idx on public.chapter_documents (chapter_id, status, updated_at desc);
create index chapter_records_chapter_occurred_idx on public.chapter_records (chapter_id, occurred_at desc);
create index chapter_handshakes_chapter_status_idx on public.chapter_handshakes (chapter_id, status, updated_at desc);
create index chapter_governance_requester_idx on public.chapter_governance_requests (requester_id, created_at desc);

create or replace function private.stamp_product_identity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare member_chapter text := private.current_member_chapter();
begin
  if tg_op = 'INSERT' then
    new := jsonb_populate_record(new, jsonb_build_object('chapter_id', member_chapter));
    if tg_table_name = 'chapter_spaces' then
      new := jsonb_populate_record(new, jsonb_build_object('created_by', auth.uid()));
    elsif tg_table_name = 'chapter_threads' then
      select s.chapter_id into member_chapter from public.chapter_spaces s where s.id = new.space_id;
      new := jsonb_populate_record(new, jsonb_build_object('chapter_id', member_chapter, 'created_by', auth.uid()));
    elsif tg_table_name = 'chapter_thread_posts' then
      select t.chapter_id into member_chapter from public.chapter_threads t where t.id = new.thread_id;
      new := jsonb_populate_record(new, jsonb_build_object('chapter_id', member_chapter, 'author_id', auth.uid()));
    elsif tg_table_name = 'member_intake_reports' then
      new := jsonb_populate_record(new, jsonb_build_object('reporter_id', auth.uid()));
    elsif tg_table_name in ('chapter_documents', 'chapter_records') then
      new := jsonb_populate_record(new, jsonb_build_object('created_by', auth.uid()));
    elsif tg_table_name = 'chapter_handshakes' then
      new := jsonb_populate_record(new, jsonb_build_object('requested_by', auth.uid()));
    elsif tg_table_name = 'chapter_governance_requests' then
      new := jsonb_populate_record(new, jsonb_build_object('requester_id', auth.uid()));
    end if;
  else
    new := jsonb_populate_record(new, jsonb_build_object('chapter_id', old.chapter_id));
    if tg_table_name = 'chapter_spaces' then
      new := jsonb_populate_record(new, jsonb_build_object('created_by', old.created_by, 'created_at', old.created_at));
    elsif tg_table_name = 'chapter_threads' then
      new := jsonb_populate_record(new, jsonb_build_object('space_id', old.space_id, 'created_by', old.created_by, 'created_at', old.created_at));
    elsif tg_table_name = 'chapter_thread_posts' then
      new := jsonb_populate_record(new, jsonb_build_object('thread_id', old.thread_id, 'author_id', old.author_id, 'created_at', old.created_at));
    elsif tg_table_name = 'member_intake_reports' then
      new := jsonb_populate_record(new, jsonb_build_object('reporter_id', old.reporter_id, 'created_at', old.created_at));
    elsif tg_table_name in ('chapter_documents', 'chapter_records') then
      new := jsonb_populate_record(new, jsonb_build_object('created_by', old.created_by, 'created_at', old.created_at));
    elsif tg_table_name = 'chapter_handshakes' then
      new := jsonb_populate_record(new, jsonb_build_object('requested_by', old.requested_by, 'created_at', old.created_at));
    elsif tg_table_name = 'chapter_governance_requests' then
      new := jsonb_populate_record(new, jsonb_build_object('requester_id', old.requester_id, 'created_at', old.created_at));
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.stamp_product_identity() from public, anon, authenticated;

do $$
declare table_name text;
begin
  foreach table_name in array array['chapter_spaces','chapter_threads','chapter_thread_posts','member_intake_reports','chapter_documents','chapter_records','chapter_handshakes','chapter_governance_requests']
  loop
    execute format('create trigger stamp_product_identity before insert or update on public.%I for each row execute function private.stamp_product_identity()', table_name);
  end loop;
end
$$;

create or replace function private.apply_member_focus_to_delivery()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  profile public.member_profiles;
  notification_kind text;
  local_time time;
  in_quiet_hours boolean := false;
  urgent boolean := false;
begin
  select p.* into profile from public.member_profiles p where p.id = new.user_id;
  select n.kind into notification_kind from public.member_notifications n where n.id = new.notification_id;
  urgent := notification_kind in ('deadlines', 'cases') and coalesce(profile.urgent_notifications_enabled, true);
  if profile.quiet_hours_start is not null and profile.quiet_hours_end is not null then
    begin
      local_time := (pg_catalog.now() at time zone profile.quiet_hours_timezone)::time;
      in_quiet_hours := case when profile.quiet_hours_start < profile.quiet_hours_end
        then local_time >= profile.quiet_hours_start and local_time < profile.quiet_hours_end
        else local_time >= profile.quiet_hours_start or local_time < profile.quiet_hours_end end;
    exception
      when invalid_parameter_value then
        -- Fail open for delivery if a legacy/corrupt timezone somehow exists.
        -- The profile trigger below prevents new invalid values.
        in_quiet_hours := false;
    end;
  end if;
  if (profile.dnd_enabled or in_quiet_hours) and not urgent then
    new.status := 'skipped';
    new.last_error := case when profile.dnd_enabled then 'suppressed: do not disturb' else 'suppressed: quiet hours' end;
  end if;
  return new;
end;
$$;
revoke all on function private.apply_member_focus_to_delivery() from public, anon, authenticated;
create trigger apply_member_focus_to_delivery before insert on public.member_notification_deliveries
for each row execute function private.apply_member_focus_to_delivery();

create or replace function private.validate_member_focus_timezone()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_timezone_names timezone
    where timezone.name = new.quiet_hours_timezone
  ) then
    raise exception 'Unknown IANA timezone: %', new.quiet_hours_timezone
      using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_member_focus_timezone() from public, anon, authenticated;
create trigger member_profiles_validate_focus_timezone
before insert or update of quiet_hours_timezone on public.member_profiles
for each row execute function private.validate_member_focus_timezone();

alter table public.chapter_spaces enable row level security;
alter table public.chapter_space_members enable row level security;
alter table public.chapter_threads enable row level security;
alter table public.chapter_thread_posts enable row level security;
alter table public.member_intake_reports enable row level security;
alter table public.chapter_documents enable row level security;
alter table public.chapter_records enable row level security;
alter table public.chapter_handshakes enable row level security;
alter table public.chapter_governance_requests enable row level security;

create or replace function private.current_member_chapter()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.chapter_id
  from public.member_profiles p
  where p.id = (select auth.uid())
$$;

revoke all on function private.current_member_chapter() from public, anon;
grant execute on function private.current_member_chapter() to authenticated;

create or replace function private.can_read_chapter_space(p_space public.chapter_spaces)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_space.chapter_id = private.current_member_chapter()
    and (
      p_space.visibility = 'chapter'
      or (p_space.visibility = 'staff' and public.member_has_role(array['steward','coordinator','advisor','admin','vp']))
      or p_space.created_by = (select auth.uid())
      or exists (
        select 1 from public.chapter_space_members sm
        where sm.space_id = p_space.id and sm.user_id = (select auth.uid())
      )
    )
$$;

revoke all on function private.can_read_chapter_space(public.chapter_spaces) from public, anon;
grant execute on function private.can_read_chapter_space(public.chapter_spaces) to authenticated;

create policy chapter_spaces_read on public.chapter_spaces for select to authenticated
  using (private.can_read_chapter_space(chapter_spaces));
create policy chapter_spaces_staff_create on public.chapter_spaces for insert to authenticated
  with check (chapter_id = private.current_member_chapter() and created_by = (select auth.uid()) and public.member_has_role(array['steward','coordinator','advisor','admin']));
create policy chapter_spaces_staff_write on public.chapter_spaces for update to authenticated
  using (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin']))
  with check (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin']));

create policy chapter_space_members_read on public.chapter_space_members for select to authenticated
  using (exists (select 1 from public.chapter_spaces s where s.id = space_id and private.can_read_chapter_space(s)));
create policy chapter_space_members_self_write on public.chapter_space_members for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.chapter_spaces s where s.id = space_id and private.can_read_chapter_space(s)));
create policy chapter_space_members_self_update on public.chapter_space_members for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy chapter_space_members_self_delete on public.chapter_space_members for delete to authenticated
  using (user_id = (select auth.uid()));

create policy chapter_threads_read on public.chapter_threads for select to authenticated
  using (exists (select 1 from public.chapter_spaces s where s.id = space_id and private.can_read_chapter_space(s)));
create policy chapter_threads_create on public.chapter_threads for insert to authenticated
  with check (
    chapter_id = private.current_member_chapter()
    and created_by = (select auth.uid())
    and exists (select 1 from public.chapter_spaces s where s.id = space_id and private.can_read_chapter_space(s))
  );
create policy chapter_threads_update_owner_staff on public.chapter_threads for update to authenticated
  using (created_by = (select auth.uid()) or public.member_has_role(array['steward','coordinator','advisor','admin']))
  with check (chapter_id = private.current_member_chapter());

create policy chapter_thread_posts_read on public.chapter_thread_posts for select to authenticated
  using (exists (
    select 1 from public.chapter_threads t
    join public.chapter_spaces s on s.id = t.space_id
    where t.id = thread_id and private.can_read_chapter_space(s)
  ));
create policy chapter_thread_posts_create on public.chapter_thread_posts for insert to authenticated
  with check (
    chapter_id = private.current_member_chapter()
    and author_id = (select auth.uid())
    and exists (
      select 1 from public.chapter_threads t
      join public.chapter_spaces s on s.id = t.space_id
      where t.id = thread_id and t.status = 'open' and private.can_read_chapter_space(s)
    )
  );
create policy chapter_thread_posts_update_own on public.chapter_thread_posts for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()) and chapter_id = private.current_member_chapter());

create policy member_intake_reports_read on public.member_intake_reports for select to authenticated
  using (reporter_id = (select auth.uid()) or (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','admin'])));
create policy member_intake_reports_create on public.member_intake_reports for insert to authenticated
  with check (reporter_id = (select auth.uid()) and chapter_id = private.current_member_chapter());
create policy member_intake_reports_staff_update on public.member_intake_reports for update to authenticated
  using (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','admin']))
  with check (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','admin']));

create policy chapter_documents_read on public.chapter_documents for select to authenticated
  using (
    chapter_id = private.current_member_chapter()
    and (
      (status = 'published' and (visibility = 'chapter' or public.member_has_role(array['steward','coordinator','advisor','admin','vp'])))
      or public.member_has_role(array['steward','coordinator','advisor','admin'])
    )
  );
create policy chapter_documents_staff_create on public.chapter_documents for insert to authenticated
  with check (chapter_id = private.current_member_chapter() and created_by = (select auth.uid()) and public.member_has_role(array['steward','coordinator','advisor','admin']));
create policy chapter_documents_staff_write on public.chapter_documents for update to authenticated
  using (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin']))
  with check (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin']));

create policy chapter_records_read on public.chapter_records for select to authenticated
  using (chapter_id = private.current_member_chapter());
create policy chapter_records_staff_create on public.chapter_records for insert to authenticated
  with check (chapter_id = private.current_member_chapter() and created_by = (select auth.uid()) and public.member_has_role(array['steward','coordinator','advisor','admin']));
create policy chapter_records_staff_write on public.chapter_records for update to authenticated
  using (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin']))
  with check (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin']));

create policy chapter_handshakes_read on public.chapter_handshakes for select to authenticated
  using (chapter_id = private.current_member_chapter());
create policy chapter_handshakes_staff_create on public.chapter_handshakes for insert to authenticated
  with check (chapter_id = private.current_member_chapter() and requested_by = (select auth.uid()) and public.member_has_role(array['steward','coordinator','advisor','admin','vp']));
create policy chapter_handshakes_staff_write on public.chapter_handshakes for update to authenticated
  using (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin','vp']))
  with check (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin','vp']));

create policy chapter_governance_read on public.chapter_governance_requests for select to authenticated
  using (
    requester_id = (select auth.uid())
    or (chapter_id = private.current_member_chapter() and public.member_has_role(array['admin']))
  );
create policy chapter_governance_create on public.chapter_governance_requests for insert to authenticated
  with check (requester_id = (select auth.uid()) and chapter_id = private.current_member_chapter());
create policy chapter_governance_admin_update on public.chapter_governance_requests for update to authenticated
  using (chapter_id = private.current_member_chapter() and public.member_has_role(array['admin']))
  with check (chapter_id = private.current_member_chapter() and public.member_has_role(array['admin']));

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'chapter_spaces', 'chapter_space_members', 'chapter_threads',
    'chapter_thread_posts', 'member_intake_reports', 'chapter_documents',
    'chapter_records', 'chapter_handshakes', 'chapter_governance_requests'
  ]
  loop
    execute format(
      'create policy mfa_assurance on public.%I as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()))',
      table_name
    );
  end loop;
end
$$;

create trigger chapter_spaces_touch_updated_at
before update on public.chapter_spaces
for each row execute function private.touch_updated_at();

create trigger chapter_threads_touch_updated_at
before update on public.chapter_threads
for each row execute function private.touch_updated_at();

create trigger member_intake_reports_touch_updated_at
before update on public.member_intake_reports
for each row execute function private.touch_updated_at();

create trigger chapter_documents_touch_updated_at
before update on public.chapter_documents
for each row execute function private.touch_updated_at();

create trigger chapter_handshakes_touch_updated_at
before update on public.chapter_handshakes
for each row execute function private.touch_updated_at();

create trigger chapter_governance_requests_touch_updated_at
before update on public.chapter_governance_requests
for each row execute function private.touch_updated_at();

create or replace function private.bump_chapter_thread_on_post()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.chapter_threads
  set updated_at = pg_catalog.now()
  where id = new.thread_id;
  return new;
end;
$$;

revoke all on function private.bump_chapter_thread_on_post() from public, anon, authenticated;
create trigger chapter_thread_posts_bump_thread
after insert or update on public.chapter_thread_posts
for each row execute function private.bump_chapter_thread_on_post();

revoke all on table
  public.chapter_spaces,
  public.chapter_space_members,
  public.chapter_threads,
  public.chapter_thread_posts,
  public.member_intake_reports,
  public.chapter_documents,
  public.chapter_records,
  public.chapter_handshakes,
  public.chapter_governance_requests
from public, anon, authenticated;

grant select on public.chapter_spaces to authenticated;
grant insert (name, description, visibility, archived_at) on public.chapter_spaces to authenticated;
grant update (name, description, visibility, archived_at) on public.chapter_spaces to authenticated;
grant select, delete on public.chapter_space_members to authenticated;
grant insert (space_id, user_id, notification_level) on public.chapter_space_members to authenticated;
grant update (notification_level) on public.chapter_space_members to authenticated;
grant select on public.chapter_threads to authenticated;
grant insert (space_id, title, kind, task_id, case_id, pinned_at, resolved_at) on public.chapter_threads to authenticated;
grant update (title, kind, status, task_id, case_id, pinned_at, resolved_at) on public.chapter_threads to authenticated;
grant select on public.chapter_thread_posts to authenticated;
grant insert (thread_id, body, parent_post_id) on public.chapter_thread_posts to authenticated;
grant update (body, edited_at, deleted_at) on public.chapter_thread_posts to authenticated;
grant select on public.member_intake_reports to authenticated;
grant insert (category, title, details) on public.member_intake_reports to authenticated;
grant update (status, assigned_to, thread_id, case_id) on public.member_intake_reports to authenticated;
grant select on public.chapter_documents to authenticated;
grant insert (title, document_type, summary, body, source_url, version, visibility, status, published_at) on public.chapter_documents to authenticated;
grant update (title, document_type, summary, body, source_url, version, visibility, status, published_at) on public.chapter_documents to authenticated;
grant select on public.chapter_records to authenticated;
grant insert (record_type, title, body, occurred_at, thread_id, task_id, case_id) on public.chapter_records to authenticated;
grant update (record_type, title, body, occurred_at, thread_id, task_id, case_id) on public.chapter_records to authenticated;
grant select on public.chapter_handshakes to authenticated;
grant insert (partner_org_id, title, purpose, data_scope, status, requested_at) on public.chapter_handshakes to authenticated;
grant update (title, purpose, data_scope, status, countersigned_by, requested_at, countersigned_at) on public.chapter_handshakes to authenticated;
grant select on public.chapter_governance_requests to authenticated;
grant insert (request_type, details) on public.chapter_governance_requests to authenticated;
grant update (status, handled_by, response) on public.chapter_governance_requests to authenticated;

grant update (
  dnd_enabled,
  quiet_hours_start,
  quiet_hours_end,
  quiet_hours_timezone,
  urgent_notifications_enabled
) on public.member_profiles to authenticated;

notify pgrst, 'reload schema';
