-- CR-012 / CR-077 / CR-078 / CR-087 / CR-112
--
-- Complete the five remaining partial workflows without copying the donor's
-- Next.js actions or its legacy tenant assumptions. The approved donor commit
-- donor-baseline-20260721 supplied behavior references only:
--
--   app/dashboard/polls/actions.ts
--   app/dashboard/minutes/actions.ts
--   app/dashboard/timeline/actions.ts
--   app/dashboard/contacts/contact-log-client.tsx
--   app/api/export/csv/route.ts and app/api/export/xlsx/route.ts
--
-- Rejected from that baseline: direct table mutations from server actions,
-- single-tenant role inference, legacy credentials/project identifiers,
-- provider-dependent delivery, mutable minute history, and unbounded export
-- payloads. This migration uses the current organization/chapter helpers,
-- staff MFA policy, RLS, in-app notifications, bounded JSON projections, and
-- append-only delivery evidence. It creates no tenant, identity, credential,
-- provider activation, or seed row.

set local lock_timeout = '5s';

-- -------------------------------------------------------------------------
-- Institutional record lifecycle
-- -------------------------------------------------------------------------

alter table public.chapter_records
  add column lifecycle_status text not null default 'published',
  add column visibility text not null default 'chapter',
  add column version integer not null default 1,
  add column published_at timestamptz,
  add column updated_at timestamptz not null default pg_catalog.now(),
  add column pinned_at timestamptz,
  add column gap_note text;

update public.chapter_records
set published_at = coalesce(published_at, created_at)
where lifecycle_status = 'published' and published_at is null;

alter table public.chapter_records
  add constraint chapter_records_lifecycle_status_check
    check (lifecycle_status in ('draft', 'published', 'archived')),
  add constraint chapter_records_visibility_check
    check (visibility in ('chapter', 'staff')),
  add constraint chapter_records_version_check check (version > 0),
  add constraint chapter_records_gap_note_check
    check (gap_note is null or pg_catalog.char_length(gap_note) <= 1000),
  add constraint chapter_records_publication_shape_check
    check (
      (lifecycle_status = 'published' and published_at is not null)
      or lifecycle_status <> 'published'
    );

create index chapter_records_chapter_lifecycle_occurred_idx
  on public.chapter_records
  (chapter_id, lifecycle_status, pinned_at desc nulls last, occurred_at desc, id);

create table public.chapter_record_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  record_id uuid not null references public.chapter_records(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  version integer not null check (version > 0),
  record_type text not null check (record_type in ('minutes', 'decision', 'milestone', 'management_contact', 'member_contact')),
  title text not null check (pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 200),
  body text not null check (pg_catalog.char_length(pg_catalog.btrim(body)) between 1 and 20000),
  occurred_at timestamptz not null,
  lifecycle_status text not null check (lifecycle_status in ('draft', 'published', 'archived')),
  visibility text not null check (visibility in ('chapter', 'staff')),
  gap_note text check (gap_note is null or pg_catalog.char_length(gap_note) <= 1000),
  changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  unique (record_id, version)
);

create index chapter_record_versions_record_created_idx
  on public.chapter_record_versions (record_id, version desc);

create table public.meeting_attendance (
  record_id uuid not null references public.chapter_records(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  attendance_status text not null check (attendance_status in ('present', 'absent', 'excused', 'guest')),
  recorded_by uuid references auth.users(id) on delete set null,
  recorded_at timestamptz not null default pg_catalog.now(),
  primary key (record_id, user_id)
);

create index meeting_attendance_chapter_record_idx
  on public.meeting_attendance (chapter_id, record_id, attendance_status);

create table public.meeting_minutes_dispatches (
  id uuid primary key default extensions.gen_random_uuid(),
  record_id uuid not null references public.chapter_records(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  version integer not null check (version > 0),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  channel text not null default 'in_app' check (channel = 'in_app'),
  status text not null check (status in ('delivered', 'failed')),
  delivered_at timestamptz,
  error_code text check (error_code is null or error_code ~ '^[a-z0-9-]{1,60}$'),
  created_at timestamptz not null default pg_catalog.now(),
  unique (record_id, version, recipient_id, channel)
);

create index meeting_minutes_dispatches_record_status_idx
  on public.meeting_minutes_dispatches (record_id, version, status, created_at);

-- -------------------------------------------------------------------------
-- Standalone contact ledger
-- -------------------------------------------------------------------------

create table public.chapter_contact_log (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  subject_user_id uuid references auth.users(id) on delete set null,
  contact_kind text not null check (contact_kind in ('member', 'management', 'community', 'provider', 'other')),
  channel text not null check (channel in ('in_person', 'phone', 'email', 'message', 'meeting', 'other')),
  purpose text not null check (pg_catalog.char_length(pg_catalog.btrim(purpose)) between 1 and 160),
  summary text not null check (pg_catalog.char_length(pg_catalog.btrim(summary)) between 1 and 4000),
  outcome text check (outcome is null or pg_catalog.char_length(outcome) <= 1000),
  occurred_at timestamptz not null,
  follow_up_at timestamptz,
  case_id uuid references public.member_cases(id) on delete set null,
  task_id uuid references public.chapter_tasks(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint chapter_contact_log_follow_up_ordered
    check (follow_up_at is null or follow_up_at >= occurred_at)
);

create index chapter_contact_log_org_chapter_occurred_idx
  on public.chapter_contact_log
  (organization_id, chapter_id, occurred_at desc, id)
  where archived_at is null;
create index chapter_contact_log_subject_occurred_idx
  on public.chapter_contact_log (subject_user_id, occurred_at desc)
  where archived_at is null and subject_user_id is not null;
create index chapter_contact_log_case_occurred_idx
  on public.chapter_contact_log (case_id, occurred_at desc)
  where archived_at is null and case_id is not null;

-- -------------------------------------------------------------------------
-- Bounded export audit receipts. Payloads are rebuilt for the authorized
-- caller and are never retained in this table.
-- -------------------------------------------------------------------------

create table public.organization_data_export_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  requested_by uuid not null references auth.users(id) on delete restrict,
  format text not null check (format in ('csv', 'json')),
  domains text[] not null check (
    pg_catalog.cardinality(domains) between 1 and 6
    and domains <@ array['members','cases','tasks','minutes','timeline','contacts']::text[]
  ),
  filters jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(filters) = 'object'
    and pg_catalog.length(filters::text) <= 2000
  ),
  row_count integer not null check (row_count between 0 and 10000),
  status text not null default 'ready' check (status in ('ready', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.now()
);

create index organization_data_export_runs_org_created_idx
  on public.organization_data_export_runs
  (organization_id, created_at desc, id desc);

alter table public.chapter_record_versions enable row level security;
alter table public.meeting_attendance enable row level security;
alter table public.meeting_minutes_dispatches enable row level security;
alter table public.chapter_contact_log enable row level security;
alter table public.organization_data_export_runs enable row level security;

create policy mfa_assurance on public.chapter_record_versions as restrictive
  for all to authenticated using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.meeting_attendance as restrictive
  for all to authenticated using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.meeting_minutes_dispatches as restrictive
  for all to authenticated using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.chapter_contact_log as restrictive
  for all to authenticated using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_data_export_runs as restrictive
  for all to authenticated using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on public.chapter_record_versions from public, anon, authenticated, service_role;
revoke all on public.meeting_attendance from public, anon, authenticated, service_role;
revoke all on public.meeting_minutes_dispatches from public, anon, authenticated, service_role;
revoke all on public.chapter_contact_log from public, anon, authenticated, service_role;
revoke all on public.organization_data_export_runs from public, anon, authenticated, service_role;

-- Chapter records now mutate only through the guarded lifecycle RPC below.
-- SELECT remains policy-controlled. The historical column-scoped grants stay
-- in place for catalog compatibility, while the write policies are removed so
-- direct INSERT/UPDATE still fail RLS and cannot bypass lifecycle state.
drop policy if exists chapter_records_staff_create on public.chapter_records;
drop policy if exists chapter_records_staff_write on public.chapter_records;

-- Existing v1 rows become a truthful immutable baseline. Empty production has
-- none; SAMPLE/live rows retain their original author and timestamps.
insert into public.chapter_record_versions (
  record_id, chapter_id, version, record_type, title, body, occurred_at,
  lifecycle_status, visibility, gap_note, changed_by, created_at
)
select id, chapter_id, version, record_type, title, body, occurred_at,
  lifecycle_status, visibility, gap_note, created_by, created_at
from public.chapter_records
on conflict (record_id, version) do nothing;

-- Members see only published chapter-visible institutional history. Staff get
-- a separate OR policy for drafts, staff-visible rows, and contact records.
drop policy if exists chapter_records_read_chapter on public.chapter_records;
drop policy if exists chapter_records_read_contacts on public.chapter_records;
drop policy if exists chapter_records_read_staff on public.chapter_records;

create policy chapter_records_read_chapter on public.chapter_records
  for select to authenticated
  using (
    private.chapter_record_publication(record_type) = 'chapter_members'
    and lifecycle_status = 'published'
    and visibility = 'chapter'
    and archived_at is null
    and private.can_read_chapter_member_record(chapter_id)
  );

create policy chapter_records_read_staff on public.chapter_records
  for select to authenticated
  using (
    archived_at is null
    and private.can_read_chapter_contact_record(chapter_id)
  );

comment on policy chapter_records_read_chapter on public.chapter_records is
  'Members read only published, chapter-visible minutes, decisions, and milestones in their active chapter and organization.';
comment on policy chapter_records_read_staff on public.chapter_records is
  'MFA-satisfied authorized staff read the complete active institutional record workspace for the selected chapter.';

-- -------------------------------------------------------------------------
-- Explicit weekly-question promotion. A promotion consumes one concrete
-- reward grant once; holding the reward alone no longer silently promotes
-- every question the member submits.
-- -------------------------------------------------------------------------

create table public.member_weekly_question_promotions (
  question_id uuid primary key references public.member_weekly_questions(id) on delete cascade,
  reward_grant_id uuid not null unique references public.member_reward_grants(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  promoted_at timestamptz not null default pg_catalog.now()
);

create index member_weekly_question_promotions_chapter_time_idx
  on public.member_weekly_question_promotions (chapter_id, promoted_at desc, question_id);

alter table public.member_weekly_question_promotions enable row level security;
revoke all on public.member_weekly_question_promotions from public, anon, authenticated, service_role;

create policy mfa_assurance on public.member_weekly_question_promotions as restrictive
  for all to authenticated using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create function public.promote_weekly_question(p_question_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  caller_org uuid := private.current_member_organization();
  current_week date := pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date;
  grant_id uuid;
begin
  if caller is null or caller_chapter is null or caller_org is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform 1
  from public.member_weekly_questions q
  where q.id = p_question_id
    and q.user_id = caller
    and q.chapter_id = caller_chapter
    and q.week_start = current_week
    and q.editorial_state in ('submitted', 'reserved')
  for update;
  if not found then
    raise exception 'only your available question can be promoted' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.member_weekly_question_promotions p
    where p.question_id = p_question_id
  ) then
    return pg_catalog.jsonb_build_object('questionId', p_question_id, 'promoted', false, 'alreadyPromoted', true);
  end if;

  select g.id into grant_id
  from public.member_reward_grants g
  join public.member_reward_items i on i.key = g.item_key and i.active
  where g.organization_id = caller_org
    and g.user_id = caller
    and g.item_key = 'priority-wq-slot'
    and g.status in ('granted','shipped','delivered')
    and not exists (
      select 1 from public.member_weekly_question_promotions used
      where used.reward_grant_id = g.id
    )
  order by g.created_at, g.id
  limit 1
  for update of g;

  if grant_id is null then
    raise exception 'no unused promotion entitlement' using errcode = '22023';
  end if;

  insert into public.member_weekly_question_promotions (
    question_id, reward_grant_id, organization_id, chapter_id, user_id
  ) values (p_question_id, grant_id, caller_org, caller_chapter, caller);

  return pg_catalog.jsonb_build_object(
    'questionId', p_question_id,
    'promoted', true,
    'promotionCredits', 0
  );
end;
$function$;

revoke all on function public.promote_weekly_question(uuid) from public, anon, authenticated, service_role;
grant execute on function public.promote_weekly_question(uuid) to authenticated;

create or replace function public.list_weekly_questions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  caller_org uuid := private.current_member_organization();
  current_week date := pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date;
  promotion_available boolean;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select caller_org is not null and exists (
    select 1
    from public.member_reward_grants g
    join public.member_reward_items i on i.key = g.item_key and i.active
    where g.organization_id = caller_org
      and g.user_id = caller
      and g.item_key = 'priority-wq-slot'
      and g.status in ('granted','shipped','delivered')
      and not exists (
        select 1 from public.member_weekly_question_promotions used
        where used.reward_grant_id = g.id
      )
  ) into promotion_available;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', ranked.id,
      'body', ranked.body,
      'options', ranked.options,
      'editorialState', ranked.editorial_state,
      'submittedByMe', ranked.user_id = caller,
      'boostedByMe', ranked.boosted_by_me,
      'promotedByMe', ranked.user_id = caller and ranked.priority,
      'promotionAvailable', promotion_available,
      'priority', ranked.priority,
      'score', ranked.score,
      'createdAt', ranked.created_at
    ) order by ranked.priority desc, ranked.score desc, ranked.created_at, ranked.id)
    from (
      select q.id, q.user_id, q.body, q.options, q.editorial_state, q.created_at,
        exists (
          select 1 from public.member_weekly_question_promotions p
          where p.question_id = q.id
        ) as priority,
        exists (
          select 1 from public.member_weekly_question_supports mine
          where mine.question_id = q.id and mine.user_id = caller
        ) as boosted_by_me,
        coalesce((
          select pg_catalog.sum(case
            when private.member_reward_effect_enabled(s.user_id, 'wq-boost-2x') then 2 else 1 end)::integer
          from public.member_weekly_question_supports s where s.question_id = q.id
        ), 0) as score
      from public.member_weekly_questions q
      where q.chapter_id = caller_chapter
        and q.week_start = current_week
        and q.editorial_state in ('submitted', 'reserved', 'published')
      order by priority desc, score desc, q.created_at, q.id
      limit 25
    ) ranked
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_weekly_questions() from public, anon, authenticated, service_role;
grant execute on function public.list_weekly_questions() to authenticated;

-- -------------------------------------------------------------------------
-- Institutional records RPCs
-- -------------------------------------------------------------------------

insert into private.notification_copy (key, lang, title, body) values
  ('institutional.minutes.published', 'en', 'Meeting minutes published', '{title} is ready in Chapter record.'),
  ('institutional.minutes.published', 'es', 'Acta de la reunión publicada', '{title} está disponible en Registro del capítulo.')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

create function private.institutional_context(p_require_staff boolean default true)
returns table (organization_id uuid, chapter_id text, caller_id uuid, staff boolean)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  chapter text := private.current_member_chapter();
  caller uuid := (select auth.uid());
  is_staff boolean := public.member_has_role(array['steward','coordinator','advisor','admin','vp']);
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

revoke all on function private.institutional_context(boolean) from public, anon, authenticated, service_role;

create function public.get_institutional_records_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  ctx record;
begin
  select * into ctx from private.institutional_context(false);
  return pg_catalog.jsonb_build_object(
    'canManage', ctx.staff,
    'canExport', private.has_organization_role(ctx.organization_id, array['admin','vp']),
    'records', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) || pg_catalog.jsonb_build_object(
        'versions', case when ctx.staff then coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v) order by v.version desc) from public.chapter_record_versions v where v.record_id = r.id), '[]'::jsonb) else '[]'::jsonb end,
        'attendance', case when ctx.staff then coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId', a.user_id, 'status', a.attendance_status) order by p.full_name) from public.meeting_attendance a join public.member_profiles p on p.id = a.user_id where a.record_id = r.id), '[]'::jsonb) else '[]'::jsonb end,
        'dispatch', case when ctx.staff then coalesce((select pg_catalog.jsonb_build_object('delivered', pg_catalog.count(*) filter (where d.status = 'delivered'), 'failed', pg_catalog.count(*) filter (where d.status = 'failed')) from public.meeting_minutes_dispatches d where d.record_id = r.id and d.version = r.version), pg_catalog.jsonb_build_object('delivered', 0, 'failed', 0)) else pg_catalog.jsonb_build_object('delivered', 0, 'failed', 0) end
      ) order by r.pinned_at desc nulls last, r.occurred_at desc, r.id)
      from public.chapter_records r
      where r.chapter_id = ctx.chapter_id
        and r.archived_at is null
        and (ctx.staff or (r.lifecycle_status = 'published' and r.visibility = 'chapter' and private.chapter_record_publication(r.record_type) = 'chapter_members'))
    ), '[]'::jsonb),
    'contacts', case when ctx.staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(l) || pg_catalog.jsonb_build_object('subjectName', p.full_name) order by l.occurred_at desc, l.id)
      from public.chapter_contact_log l
      left join public.member_profiles p on p.id = l.subject_user_id
      where l.organization_id = ctx.organization_id and l.chapter_id = ctx.chapter_id and l.archived_at is null
    ), '[]'::jsonb) else '[]'::jsonb end,
    'roster', case when ctx.staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId', p.id, 'name', p.full_name) order by p.full_name)
      from public.member_chapter_memberships cm
      join public.member_profiles p on p.id = cm.user_id
      where cm.chapter_id = ctx.chapter_id and cm.status = 'active'
    ), '[]'::jsonb) else '[]'::jsonb end,
    'exportRuns', case when private.has_organization_role(ctx.organization_id, array['admin','vp']) then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.created_at desc)
      from (select * from public.organization_data_export_runs where organization_id = ctx.organization_id order by created_at desc limit 20) e
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$function$;

revoke all on function public.get_institutional_records_workspace() from public, anon, authenticated, service_role;
grant execute on function public.get_institutional_records_workspace() to authenticated;

create function public.save_institutional_record(
  p_record_id uuid,
  p_record_type text,
  p_title text,
  p_body text,
  p_occurred_at timestamptz,
  p_visibility text default 'chapter',
  p_action text default 'save',
  p_pinned boolean default false,
  p_gap_note text default null,
  p_expected_version integer default null,
  p_attendance jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
  select * into ctx from private.institutional_context(true);
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
      lifecycle_status, visibility, version, published_at, updated_at, pinned_at, gap_note, archived_at
    ) values (
      ctx.chapter_id, p_record_type, pg_catalog.btrim(p_title), pg_catalog.btrim(p_body), p_occurred_at, ctx.caller_id,
      next_status, p_visibility, 1,
      case when next_status = 'published' then pg_catalog.now() end,
      pg_catalog.now(), case when p_pinned then pg_catalog.now() end, nullif(pg_catalog.btrim(p_gap_note), ''),
      case when next_status = 'archived' then pg_catalog.now() end
    ) returning * into target;
  else
    select * into target from public.chapter_records r
    where r.id = p_record_id and r.chapter_id = ctx.chapter_id
    for update;
    if target.id is null then raise exception 'record not found' using errcode = 'P0002'; end if;
    if p_expected_version is null or target.version <> p_expected_version then
      raise exception 'record changed; reload before saving' using errcode = '40001';
    end if;
    next_version := target.version + 1;
    update public.chapter_records r set
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

  delete from public.meeting_attendance where record_id = target.id;
  if target.record_type = 'minutes' then
    for attendee in select value from pg_catalog.jsonb_array_elements(p_attendance)
    loop
      if attendee->>'status' not in ('present','absent','excused','guest') or not exists (
        select 1 from public.member_chapter_memberships cm
        where cm.chapter_id = ctx.chapter_id and cm.user_id = (attendee->>'userId')::uuid and cm.status = 'active'
      ) then raise exception 'invalid meeting attendance' using errcode = '22023'; end if;
      insert into public.meeting_attendance (record_id, chapter_id, user_id, attendance_status, recorded_by)
      values (target.id, ctx.chapter_id, (attendee->>'userId')::uuid, attendee->>'status', ctx.caller_id);
    end loop;

    if p_action = 'publish' and target.visibility = 'chapter' then
      for recipient in
        select cm.user_id from public.member_chapter_memberships cm
        join public.organization_memberships om on om.user_id = cm.user_id and om.organization_id = ctx.organization_id and om.status = 'active'
        where cm.chapter_id = ctx.chapter_id and cm.status = 'active'
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
$function$;

revoke all on function public.save_institutional_record(uuid,text,text,text,timestamptz,text,text,boolean,text,integer,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_institutional_record(uuid,text,text,text,timestamptz,text,text,boolean,text,integer,jsonb) to authenticated;

create function public.save_chapter_contact_log(
  p_contact_id uuid,
  p_contact_kind text,
  p_channel text,
  p_purpose text,
  p_summary text,
  p_outcome text,
  p_occurred_at timestamptz,
  p_follow_up_at timestamptz default null,
  p_subject_user_id uuid default null,
  p_case_id uuid default null,
  p_task_id uuid default null,
  p_archive boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare ctx record; saved public.chapter_contact_log%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into ctx from private.institutional_context(true);
  if p_contact_kind not in ('member','management','community','provider','other')
     or p_channel not in ('in_person','phone','email','message','meeting','other')
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose, ''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_summary, ''))) not between 1 and 4000
     or pg_catalog.char_length(coalesce(p_outcome, '')) > 1000
     or p_occurred_at is null or (p_follow_up_at is not null and p_follow_up_at < p_occurred_at) then
    raise exception 'invalid contact log' using errcode = '22023';
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
  else
    update public.chapter_contact_log l set
      subject_user_id = p_subject_user_id, contact_kind = p_contact_kind, channel = p_channel,
      purpose = pg_catalog.btrim(p_purpose), summary = pg_catalog.btrim(p_summary),
      outcome = nullif(pg_catalog.btrim(p_outcome), ''), occurred_at = p_occurred_at,
      follow_up_at = p_follow_up_at, case_id = p_case_id, task_id = p_task_id,
      updated_by = ctx.caller_id, updated_at = pg_catalog.now(),
      archived_at = case when p_archive then pg_catalog.now() else null end
    where l.id = p_contact_id and l.organization_id = ctx.organization_id and l.chapter_id = ctx.chapter_id
    returning * into saved;
    if saved.id is null then raise exception 'contact log not found' using errcode = 'P0002'; end if;
  end if;
  return pg_catalog.to_jsonb(saved);
end;
$function$;

revoke all on function public.save_chapter_contact_log(uuid,text,text,text,text,text,timestamptz,timestamptz,uuid,uuid,uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.save_chapter_contact_log(uuid,text,text,text,text,text,timestamptz,timestamptz,uuid,uuid,uuid,boolean) to authenticated;

create function public.request_filtered_organization_export(
  p_domains text[],
  p_format text default 'csv',
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  ctx record;
  clean_domains text[];
  rows jsonb;
  total integer;
  receipt uuid;
  expires timestamptz := pg_catalog.now() + interval '15 minutes';
begin
  select * into ctx from private.institutional_context(true);
  if not private.has_organization_role(ctx.organization_id, array['admin','vp']) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  delete from public.organization_data_export_runs
  where organization_id = ctx.organization_id and expires_at <= pg_catalog.now();
  select pg_catalog.array_agg(domain order by domain) into clean_domains
  from (
    select distinct pg_catalog.btrim(value) as domain
    from pg_catalog.unnest(coalesce(p_domains, '{}'::text[])) value
  ) selected
  where domain = any(array['members','cases','tasks','minutes','timeline','contacts']::text[]);
  if p_format not in ('csv','json')
     or pg_catalog.cardinality(clean_domains) not between 1 and 6
     or pg_catalog.cardinality(clean_domains) <> pg_catalog.cardinality(p_domains)
     or (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception 'invalid export request' using errcode = '22023';
  end if;

  with export_rows as (
    select 'members'::text as domain, p.created_at as occurred_at,
      pg_catalog.jsonb_build_object(
        'memberId', p.id, 'name', p.full_name, 'memberSince', p.member_since,
        'chapterId', membership.chapter_id
      ) as values
    from public.member_profiles p
    join lateral (
      select cm.chapter_id
      from public.member_chapter_memberships cm
      join public.chapters c on c.id = cm.chapter_id
      where cm.user_id = p.id and cm.status = 'active' and c.organization_id = ctx.organization_id
      order by cm.chapter_id
      limit 1
    ) membership on true
    where 'members' = any(clean_domains)
    union all
    select 'cases', c.updated_at,
      pg_catalog.jsonb_build_object(
        'caseId', c.id, 'reference', c.reference, 'title', c.title, 'type', c.case_type,
        'step', c.step, 'status', c.status, 'deadline', c.deadline, 'memberId', c.user_id,
        'chapterId', p.chapter_id
      )
    from public.member_cases c join public.member_profiles p on p.id = c.user_id
    join public.chapters ch on ch.id = p.chapter_id
    where 'cases' = any(clean_domains) and ch.organization_id = ctx.organization_id
    union all
    select 'tasks', t.updated_at,
      pg_catalog.jsonb_build_object(
        'taskId', t.id, 'title', t.title, 'status', t.status, 'priority', t.priority,
        'workstream', t.workstream, 'dueDate', t.due_date, 'progress', t.progress,
        'blocked', t.blocked, 'chapterId', t.chapter_id
      )
    from public.chapter_tasks t join public.chapters ch on ch.id = t.chapter_id
    where 'tasks' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and t.deleted_at is null
    union all
    select 'minutes', r.occurred_at,
      pg_catalog.jsonb_build_object(
        'recordId', r.id, 'title', r.title, 'occurredAt', r.occurred_at,
        'status', r.lifecycle_status, 'visibility', r.visibility, 'version', r.version,
        'chapterId', r.chapter_id
      )
    from public.chapter_records r join public.chapters ch on ch.id = r.chapter_id
    where 'minutes' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and r.record_type = 'minutes' and r.archived_at is null
    union all
    select 'timeline', r.occurred_at,
      pg_catalog.jsonb_build_object(
        'recordId', r.id, 'type', r.record_type, 'title', r.title, 'body', r.body,
        'occurredAt', r.occurred_at, 'status', r.lifecycle_status,
        'visibility', r.visibility, 'version', r.version, 'pinned', r.pinned_at is not null,
        'gapNote', r.gap_note, 'chapterId', r.chapter_id
      )
    from public.chapter_records r join public.chapters ch on ch.id = r.chapter_id
    where 'timeline' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and r.record_type in ('decision','milestone') and r.archived_at is null
    union all
    select 'contacts', l.occurred_at,
      pg_catalog.jsonb_build_object(
        'contactId', l.id, 'kind', l.contact_kind, 'channel', l.channel,
        'purpose', l.purpose, 'summary', l.summary, 'outcome', l.outcome,
        'occurredAt', l.occurred_at, 'followUpAt', l.follow_up_at,
        'subjectMemberId', l.subject_user_id, 'caseId', l.case_id, 'taskId', l.task_id,
        'chapterId', l.chapter_id
      )
    from public.chapter_contact_log l
    where 'contacts' = any(clean_domains) and l.organization_id = ctx.organization_id and l.archived_at is null
  ), bounded as (
    select * from export_rows
    where (p_from is null or occurred_at >= p_from)
      and (p_to is null or occurred_at <= p_to)
    order by occurred_at desc, domain, values::text
    limit 10001
  )
  select pg_catalog.count(*)::integer,
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('domain', domain, 'occurredAt', occurred_at, 'values', values) order by occurred_at desc, domain), '[]'::jsonb)
  into total, rows from bounded;

  if total > 10000 then
    raise exception 'export exceeds 10000 rows; narrow the date range or domains' using errcode = '54000';
  end if;

  insert into public.organization_data_export_runs (
    organization_id, requested_by, format, domains, filters, row_count, expires_at
  ) values (
    ctx.organization_id, ctx.caller_id, p_format, clean_domains,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('from', p_from, 'to', p_to)),
    total, expires
  ) returning id into receipt;

  return pg_catalog.jsonb_build_object(
    'receiptId', receipt, 'format', p_format, 'domains', clean_domains,
    'rowCount', total, 'expiresAt', expires, 'rows', rows
  );
end;
$function$;

revoke all on function public.request_filtered_organization_export(text[],text,timestamptz,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.request_filtered_organization_export(text[],text,timestamptz,timestamptz) to authenticated;

-- Retire the legacy mutable path. It could change a published row without a
-- new version, expected-version guard, attendance refresh, or dispatch proof.
revoke all on function public.update_chapter_record_content(uuid,text,text,text,timestamptz,boolean)
  from public, anon, authenticated, service_role;

comment on function public.promote_weekly_question(uuid) is
  'Consumes one live priority-wq-slot reward grant to promote the caller own current-week question exactly once.';
comment on function public.save_institutional_record(uuid,text,text,text,timestamptz,text,text,boolean,text,integer,jsonb) is
  'Staff-only, chapter-scoped, optimistic record lifecycle with immutable versions, attendance, publication, and in-app dispatch evidence.';
comment on function public.save_chapter_contact_log(uuid,text,text,text,text,text,timestamptz,timestamptz,uuid,uuid,uuid,boolean) is
  'Staff-only cross-purpose contact ledger mutation with tenant, chapter, subject, case, and task scope checks.';
comment on function public.request_filtered_organization_export(text[],text,timestamptz,timestamptz) is
  'Admin/VP-only tenant export. Returns a bounded ephemeral projection and retains only a 15-minute audit receipt.';

-- -------------------------------------------------------------------------
-- SAMPLE activation. The existing guarded seed wrappers populate their
-- organization and identities before recording page evidence. This trigger
-- composes deterministic institutional history into that already-authorized
-- SAMPLE run; it never fires during migration and production remains empty.
-- -------------------------------------------------------------------------

update private.demo_seed_function_catalog
set coverage = 'seeded',
    evidence_key = case function_id
      when 'CR-012' then 'voice-weekly-promotion'
      when 'CR-077' then 'institutional-minutes-versioning'
      when 'CR-078' then 'institutional-timeline-history'
      when 'CR-087' then 'institutional-contact-ledger'
      when 'CR-112' then 'institutional-filtered-exports'
    end
where function_id in ('CR-012','CR-077','CR-078','CR-087','CR-112');

create function private.demo_seed_institutional_records_from_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  run record;
  org uuid;
  chapter text;
  creator uuid;
  record_id uuid;
  grant_id uuid;
  i integer;
  record_kind text;
  record_version integer;
begin
  if pg_catalog.pg_trigger_depth() > 1 then return null; end if;
  for run in select distinct lane, run_id from inserted_institutional_evidence
  loop
    if run.lane not in ('presg','uniondemo') then continue; end if;
    org := private.member_stress_uuid(run.run_id::text || case when run.lane = 'presg' then ':presg:organization' else ':ud:organization' end);
    chapter := private.demo_seed_chapter(run.lane, run.run_id, 1);
    creator := private.demo_seed_user(run.lane, run.run_id, 1);
    if not exists (select 1 from public.organizations o where o.id = org)
       or not exists (select 1 from public.chapters c where c.id = chapter and c.organization_id = org)
       or not exists (select 1 from auth.users u where u.id = creator) then
      continue;
    end if;

    for i in 1..18 loop
      record_id := private.member_stress_uuid(run.run_id::text || ':institutional:record:' || i);
      record_kind := case when i % 3 = 0 then 'minutes' when i % 2 = 0 then 'decision' else 'milestone' end;
      record_version := case when i in (3, 8, 15) then 2 else 1 end;
      insert into public.chapter_records (
        id, chapter_id, record_type, title, body, occurred_at, created_by,
        lifecycle_status, visibility, version, published_at, updated_at,
        pinned_at, gap_note, archived_at
      ) values (
        record_id, chapter, record_kind,
        (array[
          'Member orientation program launched', 'Caseload documentation standard adopted',
          'Quarterly chapter meeting', 'Bargaining priorities confirmed',
          'Safety committee formed', 'Labor-management meeting',
          'New steward cohort completed training', 'Scheduling proposal approved',
          'Annual chapter meeting', 'Contract education series opened',
          'Community coalition partnership began', 'Benefits briefing',
          'Workload evidence review completed', 'Member communication standard adopted',
          'Fall chapter meeting', 'Representation coverage expanded',
          'Records retention practice confirmed', 'Winter chapter meeting'
        ])[i],
        (array[
          'The chapter established a recurring welcome session and assigned follow-up owners.',
          'Members approved one shared method for recording workload and short-notice changes.',
          'Members reviewed open work, confirmed decisions, and assigned the next steps.',
          'The chapter adopted member-ranked priorities for the next bargaining cycle.',
          'A member-led committee began a regular hazard review and escalation cadence.',
          'Representatives presented documented scheduling and workload issues to management.'
        ])[1 + ((i - 1) % 6)],
        pg_catalog.now() - ((18 - i) * 62 || ' days')::interval,
        creator, 'published', 'chapter', record_version,
        pg_catalog.now() - ((18 - i) * 62 || ' days')::interval,
        pg_catalog.now() - ((18 - i) * 62 || ' days')::interval,
        case when i in (5, 14, 18) then pg_catalog.now() - ((18 - i) * 62 || ' days')::interval end,
        case when i = 10 then 'Earlier organizing notes are held in a paper archive and are queued for digitization.' end,
        null
      ) on conflict (id) do update set
        chapter_id = excluded.chapter_id, record_type = excluded.record_type,
        title = excluded.title, body = excluded.body, occurred_at = excluded.occurred_at,
        lifecycle_status = excluded.lifecycle_status, visibility = excluded.visibility,
        version = excluded.version, published_at = excluded.published_at,
        updated_at = excluded.updated_at, pinned_at = excluded.pinned_at,
        gap_note = excluded.gap_note, archived_at = null;

      insert into public.chapter_record_versions (
        id, record_id, chapter_id, version, record_type, title, body, occurred_at,
        lifecycle_status, visibility, gap_note, changed_by, created_at
      ) values (
        private.member_stress_uuid(run.run_id::text || ':institutional:record:' || i || ':version:1'),
        record_id, chapter, 1, record_kind,
        (select title from public.chapter_records where id = record_id),
        case when record_version = 2 then 'Initial draft retained for the institutional record.' else (select body from public.chapter_records where id = record_id) end,
        (select occurred_at from public.chapter_records where id = record_id),
        case when record_version = 2 then 'draft' else 'published' end,
        'chapter', (select gap_note from public.chapter_records where id = record_id), creator,
        (select occurred_at from public.chapter_records where id = record_id)
      ) on conflict (record_id, version) do update set body = excluded.body, lifecycle_status = excluded.lifecycle_status;
      if record_version = 2 then
        insert into public.chapter_record_versions (
          id, record_id, chapter_id, version, record_type, title, body, occurred_at,
          lifecycle_status, visibility, gap_note, changed_by, created_at
        ) select
          private.member_stress_uuid(run.run_id::text || ':institutional:record:' || i || ':version:2'),
          r.id, r.chapter_id, 2, r.record_type, r.title, r.body, r.occurred_at,
          'published', r.visibility, r.gap_note, creator, r.updated_at
        from public.chapter_records r where r.id = record_id
        on conflict (record_id, version) do update set body = excluded.body, lifecycle_status = excluded.lifecycle_status;
      end if;

      if record_kind = 'minutes' then
        insert into public.meeting_attendance (record_id, chapter_id, user_id, attendance_status, recorded_by, recorded_at)
        select record_id, chapter, private.demo_seed_user(run.lane, run.run_id, member_index),
          case member_index % 6 when 0 then 'excused' else 'present' end,
          creator, (select occurred_at from public.chapter_records where id = record_id)
        from pg_catalog.generate_series(1, 24) member_index
        where exists (select 1 from auth.users u where u.id = private.demo_seed_user(run.lane, run.run_id, member_index))
        on conflict (record_id, user_id) do update set attendance_status = excluded.attendance_status, recorded_at = excluded.recorded_at;
        insert into public.meeting_minutes_dispatches (
          id, record_id, chapter_id, version, recipient_id, status, delivered_at, created_at
        ) select
          private.member_stress_uuid(run.run_id::text || ':institutional:dispatch:' || i || ':' || member_index),
          record_id, chapter, record_version,
          private.demo_seed_user(run.lane, run.run_id, member_index), 'delivered',
          (select published_at from public.chapter_records where id = record_id),
          (select published_at from public.chapter_records where id = record_id)
        from pg_catalog.generate_series(1, 24) member_index
        where exists (select 1 from auth.users u where u.id = private.demo_seed_user(run.lane, run.run_id, member_index))
        on conflict (record_id, version, recipient_id, channel) do update set status = 'delivered', delivered_at = excluded.delivered_at;
      end if;
    end loop;

    for i in 1..36 loop
      insert into public.chapter_contact_log (
        id, organization_id, chapter_id, subject_user_id, contact_kind, channel,
        purpose, summary, outcome, occurred_at, follow_up_at, created_by, updated_by,
        created_at, updated_at
      ) values (
        private.member_stress_uuid(run.run_id::text || ':institutional:contact:' || i),
        org, chapter,
        case when i % 4 = 0 then null else private.demo_seed_user(run.lane, run.run_id, 2 + (i % 40)) end,
        (array['member','management','community','provider'])[1 + ((i - 1) % 4)],
        (array['phone','email','meeting','in_person','message'])[1 + ((i - 1) % 5)],
        (array['Scheduling follow-up','Workload documentation','Community coordination','Benefits question'])[1 + ((i - 1) % 4)],
        'Recorded the conversation, agreed on a next step, and assigned follow-up where needed.',
        case when i % 3 = 0 then 'Follow-up completed and documented.' else 'Awaiting the agreed follow-up.' end,
        pg_catalog.now() - (i * 26 || ' days')::interval,
        case when i <= 4 then pg_catalog.now() + (i || ' days')::interval end,
        creator, creator,
        pg_catalog.now() - (i * 26 || ' days')::interval,
        pg_catalog.now() - (i * 26 || ' days')::interval
      ) on conflict (id) do update set summary = excluded.summary, outcome = excluded.outcome, follow_up_at = excluded.follow_up_at, archived_at = null;
    end loop;

    insert into public.organization_data_export_runs (
      id, organization_id, requested_by, format, domains, filters, row_count, expires_at, status, created_at
    ) values
      (private.member_stress_uuid(run.run_id::text || ':institutional:export:1'), org, creator, 'csv', array['members','cases','tasks'], '{}'::jsonb, 128, pg_catalog.now() + interval '15 minutes', 'ready', pg_catalog.now() - interval '2 days'),
      (private.member_stress_uuid(run.run_id::text || ':institutional:export:2'), org, creator, 'json', array['minutes','timeline','contacts'], '{}'::jsonb, 54, pg_catalog.now() + interval '15 minutes', 'ready', pg_catalog.now() - interval '9 days')
    on conflict (id) do update set row_count = excluded.row_count, expires_at = excluded.expires_at, status = excluded.status;

    -- Give one current-week question an explicit, already-spent promotion and
    -- leave the featured member's own grant unused so the control is visible.
    select g.id into grant_id
    from public.member_reward_grants g
    where g.organization_id = org and g.user_id = private.demo_seed_user(run.lane, run.run_id, 3)
      and g.item_key = 'priority-wq-slot' and g.status <> 'revoked'
    limit 1;
    if grant_id is null then
      grant_id := private.member_stress_uuid(run.run_id::text || ':institutional:promotion-grant');
      insert into public.member_reward_grants (id, organization_id, user_id, item_key, status, source, reason)
      values (grant_id, org, private.demo_seed_user(run.lane, run.run_id, 3), 'priority-wq-slot', 'granted', 'admin_grant', 'Chapter participation recognition')
      on conflict do nothing;
    end if;
    insert into public.member_weekly_question_promotions (question_id, reward_grant_id, organization_id, chapter_id, user_id)
    select q.id, grant_id, org, chapter, q.user_id
    from public.member_weekly_questions q
    where q.id = private.member_stress_uuid(run.run_id::text || ':voice:weekly:1')
      and q.user_id = private.demo_seed_user(run.lane, run.run_id, 3)
    on conflict (question_id) do nothing;
  end loop;
  return null;
end;
$function$;

create trigger demo_seed_institutional_records_from_evidence
after insert on private.demo_seed_page_evidence
referencing new table as inserted_institutional_evidence
for each statement execute function private.demo_seed_institutional_records_from_evidence();

create function private.demo_seed_remove_institutional_records(p_lane text, p_run_id uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare org uuid := private.member_stress_uuid(p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end);
begin
  delete from public.member_weekly_question_promotions where organization_id = org;
  delete from public.organization_data_export_runs where organization_id = org;
  delete from public.chapter_contact_log where organization_id = org;
  delete from public.chapter_records where id in (
    select private.member_stress_uuid(p_run_id::text || ':institutional:record:' || i)
    from pg_catalog.generate_series(1, 18) i
  );
end;
$function$;

revoke all on function private.demo_seed_institutional_records_from_evidence() from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_remove_institutional_records(text,uuid) from public, anon, authenticated, service_role;

create or replace function public.presg_demo_remove_function_parity(p_run_id uuid,p_target_ref text,p_confirm_token text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare operations_result jsonb; voice_result jsonb; base_result jsonb; refresh_removed boolean;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_institutional_records('presg', p_run_id);
  perform private.demo_seed_remove_auth_operations('presg', p_run_id);
  operations_result := private.demo_seed_remove_voice_operations('presg', p_run_id);
  voice_result := private.demo_seed_remove_voice_parity('presg', p_run_id);
  base_result := private.demo_seed_remove_function_parity('presg', p_run_id);
  refresh_removed := private.demo_seed_drop_voice_operations_refresh();
  return base_result || pg_catalog.jsonb_build_object('voiceRefreshRemoved',refresh_removed,'voice',voice_result || pg_catalog.jsonb_build_object('operations',operations_result));
end;
$function$;

create or replace function public.uniondemo_remove_function_parity(p_run_id uuid,p_target_ref text,p_confirm_token text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare operations_result jsonb; voice_result jsonb; base_result jsonb; refresh_removed boolean;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_institutional_records('uniondemo', p_run_id);
  perform private.demo_seed_remove_auth_operations('uniondemo', p_run_id);
  operations_result := private.demo_seed_remove_voice_operations('uniondemo', p_run_id);
  voice_result := private.demo_seed_remove_voice_parity('uniondemo', p_run_id);
  base_result := private.demo_seed_remove_function_parity('uniondemo', p_run_id);
  refresh_removed := private.demo_seed_drop_voice_operations_refresh();
  return base_result || pg_catalog.jsonb_build_object('voiceRefreshRemoved',refresh_removed,'voice',voice_result || pg_catalog.jsonb_build_object('operations',operations_result));
end;
$function$;
