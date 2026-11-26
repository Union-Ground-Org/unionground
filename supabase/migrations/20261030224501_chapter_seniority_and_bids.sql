-- REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030 (#6623).
--
-- Finding 81 of the Oct 29-30 role-play run: a steward preparing a shift bid
-- (a seniority list due Oct 19 for a Nov 2 bid) had nowhere in Steward tools
-- to keep or check a seniority list or track the bid, and the deadline passed.
--
-- The visibility rule, stated once and enforced by every reader below:
--   * a steward or coordinator of a chapter (a chapter-scoped grant, or an
--     organization-wide grant in the chapter's organization) sees and edits
--     that chapter's whole seniority list and its bids;
--   * a member sees only their own entries and their own bids, and may
--     question their own entry; nobody else sees another member's entry.
-- The three tables live in private with row-level security forced and no
-- client grant, so a direct read is denied to everyone; the routines are the
-- only way in, and each applies the rule above with the caller's second
-- factor (and a full, not PIN-restricted, session) required.
--
--   * private.chapter_seniority_entries: member, seniority date,
--     classification, an optional tie-break note, and the member's open
--     question with the staff answer.
--   * private.chapter_bid_windows: what is being bid on, when the window
--     opens and closes, and its status.
--   * private.chapter_bid_entries: who bid for what, and the award.
--
-- Account lifecycle: entries and bids leave with the member (ON DELETE
-- CASCADE) and are exported to that member. Windows hold no person.
--
-- Hosted application: SAMPLE first, then production.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Tables
create table private.chapter_seniority_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  chapter_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  seniority_date date not null,
  classification text
    constraint chapter_seniority_entries_classification_check
    check (classification is null or (pg_catalog.char_length(classification) between 1 and 120 and classification !~ '[[:cntrl:]]')),
  tie_break_note text
    constraint chapter_seniority_entries_tie_break_check
    check (tie_break_note is null or (pg_catalog.char_length(tie_break_note) between 1 and 300 and tie_break_note !~ '[[:cntrl:]]')),
  question_note text
    constraint chapter_seniority_entries_question_check
    check (question_note is null or pg_catalog.char_length(question_note) between 1 and 1000),
  question_status text
    constraint chapter_seniority_entries_question_status_check
    check (question_status is null or question_status in ('open', 'answered')),
  questioned_at timestamptz,
  answer_note text
    constraint chapter_seniority_entries_answer_check
    check (answer_note is null or pg_catalog.char_length(answer_note) between 1 and 1000),
  answered_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  foreign key (organization_id, chapter_id)
    references public.chapters(organization_id, id) on update cascade on delete cascade,
  unique (chapter_id, user_id),
  constraint chapter_seniority_entries_question_shape check (
    (question_status is null and question_note is null and questioned_at is null and answer_note is null and answered_at is null)
    or (question_status = 'open' and question_note is not null and questioned_at is not null and answered_at is null)
    or (question_status = 'answered' and question_note is not null and questioned_at is not null
        and answer_note is not null and answered_at is not null)
  )
);

create index chapter_seniority_entries_order_idx
  on private.chapter_seniority_entries (chapter_id, seniority_date, id);
create index chapter_seniority_entries_user_idx
  on private.chapter_seniority_entries (user_id);

create table private.chapter_bid_windows (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  chapter_id text not null,
  subject text not null
    constraint chapter_bid_windows_subject_check
    check (pg_catalog.char_length(subject) between 3 and 200 and subject = pg_catalog.btrim(subject) and subject !~ '[[:cntrl:]]'),
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  status text not null default 'open'
    constraint chapter_bid_windows_status_check check (status in ('open', 'awarded', 'cancelled')),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  foreign key (organization_id, chapter_id)
    references public.chapters(organization_id, id) on update cascade on delete cascade,
  constraint chapter_bid_windows_order check (closes_at > opens_at)
);

create index chapter_bid_windows_chapter_idx
  on private.chapter_bid_windows (chapter_id, closes_at desc, id);

create table private.chapter_bid_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  window_id uuid not null references private.chapter_bid_windows(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  choice text not null
    constraint chapter_bid_entries_choice_check
    check (pg_catalog.char_length(choice) between 1 and 200 and choice !~ '[[:cntrl:]]'),
  award text
    constraint chapter_bid_entries_award_check
    check (award is null or (pg_catalog.char_length(award) between 1 and 200 and award !~ '[[:cntrl:]]')),
  recorded_at timestamptz not null default pg_catalog.now(),
  awarded_at timestamptz,
  unique (window_id, user_id),
  constraint chapter_bid_entries_award_shape check ((award is null) = (awarded_at is null))
);

create index chapter_bid_entries_user_idx on private.chapter_bid_entries (user_id);

alter table private.chapter_seniority_entries enable row level security;
alter table private.chapter_seniority_entries force row level security;
alter table private.chapter_bid_windows enable row level security;
alter table private.chapter_bid_windows force row level security;
alter table private.chapter_bid_entries enable row level security;
alter table private.chapter_bid_entries force row level security;
revoke all on table private.chapter_seniority_entries from public, anon, authenticated, service_role;
revoke all on table private.chapter_bid_windows from public, anon, authenticated, service_role;
revoke all on table private.chapter_bid_entries from public, anon, authenticated, service_role;

comment on table private.chapter_seniority_entries is
  'REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030: a chapter''s seniority list. Stewards and coordinators of the chapter see and edit the whole list; a member sees and questions only their own entry. No client grant; read and written only through the chapter seniority routines. Deleted with the member.';
comment on table private.chapter_bid_windows is
  'REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030: a chapter''s shift or position bid: what is bid on, when it opens and closes, and its status. Seen only by the chapter''s stewards and coordinators, and by a member for a window they bid in. No client grant.';
comment on table private.chapter_bid_entries is
  'REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030: who bid for what in a bid window, and the award. Seen by the chapter''s stewards and coordinators, and by the bidder for their own bid. No client grant. Deleted with the member.';

create trigger a00_case_graph_lock before insert or update or delete on private.chapter_seniority_entries
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_seniority_entries
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
-- The windows join the case graph through their bids, so they take the same gates.
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_bid_windows
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_bid_windows
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_bid_entries
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_bid_entries
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

-- ---------------------------------------------------------------------------
-- 2. The rule
create function private.seniority_staff_can_manage(p_chapter text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
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
          private.member_has_chapter_role(p_chapter, array['steward', 'coordinator'])
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

revoke all on function private.seniority_staff_can_manage(text) from public, anon, authenticated, service_role;

comment on function private.seniority_staff_can_manage(text) is
  'REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030: the caller is a steward or coordinator of this chapter (chapter-scoped, or organization-wide in the chapter''s organization) with a second factor. The one staff predicate of every chapter seniority and bid routine.';

-- An active member of this chapter of its organization.
create function private.seniority_chapter_member(p_chapter text, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.member_chapter_memberships membership
    join public.chapters chapter on chapter.id = membership.chapter_id
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = chapter.organization_id
     and organization_membership.status = 'active'
    where membership.chapter_id = p_chapter
      and membership.user_id = p_user
      and membership.status = 'active'
  )
$function$;

revoke all on function private.seniority_chapter_member(text, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Staff: the list
create function public.list_chapter_seniority(
  p_chapter_id text,
  p_after_date date default null,
  p_after_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
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

  with page as materialized (
    select e.*, profile.full_name,
      (select pg_catalog.count(*) from private.chapter_seniority_entries earlier
        where earlier.chapter_id = e.chapter_id
          and (earlier.seniority_date, earlier.id) < (e.seniority_date, e.id))::integer + 1 as position
    from private.chapter_seniority_entries e
    left join public.member_profiles profile on profile.id = e.user_id
    where e.chapter_id = p_chapter_id
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
      where q.chapter_id = p_chapter_id and q.question_status = 'open')
  ) into result;
  return result;
end;
end;
$function$;

-- The member picker: up to 25 active members of the chapter whose name
-- matches, for the chapter's own stewards and coordinators only.
create function public.search_chapter_seniority_members(p_chapter_id text, p_query text default '')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
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
        and (needle = '' or pg_catalog.strpos(pg_catalog.lower(coalesce(profile.full_name, '')), needle) > 0)
      order by 2, 1
      limit 25
    ) found
  ), '[]'::jsonb);
end;
end;
$function$;

create function public.save_chapter_seniority_entry(
  p_chapter_id text,
  p_user_id uuid,
  p_seniority_date date,
  p_classification text default null,
  p_tie_break_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(), p_user_id], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  entry_id uuid;
begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
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

create function public.delete_chapter_seniority_entry(p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(), (select e.user_id from private.chapter_seniority_entries e where e.id = p_entry_id)], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  target private.chapter_seniority_entries%rowtype;
begin
  select * into target from private.chapter_seniority_entries e where e.id = p_entry_id;
  if not found or not private.seniority_staff_can_manage(target.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from private.chapter_seniority_entries e where e.id = target.id;
  return pg_catalog.jsonb_build_object('deleted', true);
end;
end;
$function$;

-- Preview (p_apply false) or apply a file of rows: [{email, seniorityDate,
-- classification, tieBreakNote}]. Rows match active members of the chapter by
-- sign-in email only; the preview names each row's member and outcome and
-- writes nothing. Applying writes the matched rows and reports the rest.
create function public.import_chapter_seniority(p_chapter_id text, p_rows jsonb, p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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

  with source as (
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

create function public.answer_chapter_seniority_question(p_entry_id uuid, p_answer text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(), (select e.user_id from private.chapter_seniority_entries e where e.id = p_entry_id)], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  target private.chapter_seniority_entries%rowtype;
  clean text := nullif(pg_catalog.btrim(coalesce(p_answer, '')), '');
begin
  select * into target from private.chapter_seniority_entries e where e.id = p_entry_id;
  if not found or not private.seniority_staff_can_manage(target.chapter_id) then
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

-- ---------------------------------------------------------------------------
-- 4. Staff: bids
create function public.list_chapter_bid_windows(p_chapter_id text, p_limit integer default 20, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  cap integer := greatest(1, least(coalesce(p_limit, 20), 50));
  skip integer := greatest(0, least(coalesce(p_offset, 0), 10000));
  total integer;
  result jsonb;
begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
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
      'bidCount', (select pg_catalog.count(*)::integer from private.chapter_bid_entries counted where counted.window_id = w.id),
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
          where x.window_id = w.id
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

-- Open bid windows closing within the next 30 days, soonest first: the bid
-- deadlines the steward desk lists beside the steward's other dated work.
create function public.list_chapter_bid_deadlines(p_chapter_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', w.id, 'subject', w.subject, 'opensAt', w.opens_at, 'closesAt', w.closes_at, 'status', w.status
    ) order by w.closes_at, w.id)
    from (
      select * from private.chapter_bid_windows due
      where due.chapter_id = p_chapter_id
        and due.status = 'open'
        and due.closes_at >= pg_catalog.now()
        and due.closes_at <= pg_catalog.now() + interval '30 days'
      order by due.closes_at, due.id
      limit 20
    ) w
  ), '[]'::jsonb);
end;
end;
$function$;

create function public.save_chapter_bid_window(
  p_id uuid,
  p_chapter_id text,
  p_subject text,
  p_opens_at timestamptz,
  p_closes_at timestamptz,
  p_status text default 'open'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  window_id uuid;
  clean_subject text := pg_catalog.btrim(coalesce(p_subject, ''));
begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_subject) not between 3 and 200
     or p_opens_at is null or p_closes_at is null or p_closes_at <= p_opens_at
     or coalesce(p_status, '') not in ('open', 'awarded', 'cancelled') then
    raise exception 'invalid bid window' using errcode = '22023', detail = 'bid_window_invalid';
  end if;

  if p_id is null then
    insert into private.chapter_bid_windows (organization_id, chapter_id, subject, opens_at, closes_at, status)
    select chapter.organization_id, chapter.id, clean_subject, p_opens_at, p_closes_at, p_status
    from public.chapters chapter where chapter.id = p_chapter_id
    returning id into window_id;
  else
    update private.chapter_bid_windows w
    set subject = clean_subject, opens_at = p_opens_at, closes_at = p_closes_at, status = p_status, updated_at = pg_catalog.now()
    where w.id = p_id and w.chapter_id = p_chapter_id
    returning w.id into window_id;
    if window_id is null then
      raise exception 'not found' using errcode = 'P0002';
    end if;
  end if;
  return pg_catalog.jsonb_build_object('id', window_id);
end;
end;
$function$;

create function public.record_chapter_bid(p_window_id uuid, p_user_id uuid, p_choice text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(), p_user_id], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  target private.chapter_bid_windows%rowtype;
  clean text := pg_catalog.btrim(coalesce(p_choice, ''));
  bid_id uuid;
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
  if p_user_id is null or not private.seniority_chapter_member(target.chapter_id, p_user_id) then
    raise exception 'member of this chapter required' using errcode = '22023', detail = 'seniority_member_required';
  end if;
  if pg_catalog.char_length(clean) not between 1 and 200 then
    raise exception 'choice must be between 1 and 200 characters' using errcode = '22023';
  end if;

  insert into private.chapter_bid_entries as b (window_id, user_id, choice)
  values (target.id, p_user_id, clean)
  on conflict (window_id, user_id) do update set choice = excluded.choice, recorded_at = pg_catalog.now()
  returning b.id into bid_id;
  return pg_catalog.jsonb_build_object('id', bid_id);
end;
end;
$function$;

-- Records (or clears, with a null award) what a bid was awarded.
create function public.award_chapter_bid(p_bid_id uuid, p_award text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
  if bid.id is null or target.id is null or not private.seniority_staff_can_manage(target.chapter_id) then
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

-- ---------------------------------------------------------------------------
-- 5. A member: their own entries and bids, and a question on their entry
create function public.get_my_seniority()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
begin
  if caller is null or not private.mfa_satisfied() or org is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'entries', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id,
        'chapterId', e.chapter_id,
        'chapterName', chapter.name,
        'seniorityDate', e.seniority_date,
        'classification', e.classification,
        'tieBreakNote', e.tie_break_note,
        'question', case when e.question_status is null then null else pg_catalog.jsonb_build_object(
          'status', e.question_status, 'note', e.question_note, 'askedAt', e.questioned_at,
          'answer', e.answer_note, 'answeredAt', e.answered_at) end
      ) order by chapter.name, e.id)
      from private.chapter_seniority_entries e
      join public.chapters chapter on chapter.id = e.chapter_id
      where e.user_id = caller and e.organization_id = org
    ), '[]'::jsonb),
    'bids', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', b.id,
        'subject', w.subject,
        'closesAt', w.closes_at,
        'status', w.status,
        'choice', b.choice,
        'award', b.award
      ) order by w.closes_at desc, b.id)
      from (select * from private.chapter_bid_entries mine where mine.user_id = caller order by mine.recorded_at desc limit 50) b
      join private.chapter_bid_windows w on w.id = b.window_id and w.organization_id = org
    ), '[]'::jsonb)
  );
end;
end;
$function$;

create function public.question_my_seniority_entry(p_entry_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  clean text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  entry_id uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if clean is null or pg_catalog.char_length(clean) > 1000 then
    raise exception 'question must be between 1 and 1000 characters' using errcode = '22023';
  end if;
  -- Only the member's own entry; a new question replaces an answered one.
  update private.chapter_seniority_entries e
  set question_status = 'open', question_note = clean, questioned_at = pg_catalog.now(),
      answer_note = null, answered_at = null, updated_at = pg_catalog.now()
  where e.id = p_entry_id and e.user_id = caller
    and e.organization_id = private.current_member_organization()
  returning e.id into entry_id;
  if entry_id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object('id', entry_id, 'status', 'open');
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Grants
revoke all on function public.list_chapter_seniority(text, date, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.search_chapter_seniority_members(text, text) from public, anon, authenticated, service_role;
revoke all on function public.save_chapter_seniority_entry(text, uuid, date, text, text) from public, anon, authenticated, service_role;
revoke all on function public.delete_chapter_seniority_entry(uuid) from public, anon, authenticated, service_role;
revoke all on function public.import_chapter_seniority(text, jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.answer_chapter_seniority_question(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.list_chapter_bid_windows(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.list_chapter_bid_deadlines(text) from public, anon, authenticated, service_role;
revoke all on function public.save_chapter_bid_window(uuid, text, text, timestamptz, timestamptz, text) from public, anon, authenticated, service_role;
revoke all on function public.record_chapter_bid(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.award_chapter_bid(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.get_my_seniority() from public, anon, authenticated, service_role;
revoke all on function public.question_my_seniority_entry(uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.list_chapter_seniority(text, date, uuid, integer) to authenticated;
grant execute on function public.search_chapter_seniority_members(text, text) to authenticated;
grant execute on function public.save_chapter_seniority_entry(text, uuid, date, text, text) to authenticated;
grant execute on function public.delete_chapter_seniority_entry(uuid) to authenticated;
grant execute on function public.import_chapter_seniority(text, jsonb, boolean) to authenticated;
grant execute on function public.answer_chapter_seniority_question(uuid, text) to authenticated;
grant execute on function public.list_chapter_bid_windows(text, integer, integer) to authenticated;
grant execute on function public.list_chapter_bid_deadlines(text) to authenticated;
grant execute on function public.save_chapter_bid_window(uuid, text, text, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.record_chapter_bid(uuid, uuid, text) to authenticated;
grant execute on function public.award_chapter_bid(uuid, text) to authenticated;
grant execute on function public.get_my_seniority() to authenticated;
grant execute on function public.question_my_seniority_entry(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Account lifecycle registration and export
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, export_projection_version, export_domain,
   export_columns, exclusion_reason, note, reviewed_at)
values
  ('private', 'chapter_seniority_entries', 'user_id', 'cascade', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.chapter_seniority_entries',
   array['id','organization_id','chapter_id','user_id','seniority_date','classification','tie_break_note','question_note','question_status','questioned_at','answer_note','answered_at','created_at','updated_at']::text[], null,
   'The member''s own seniority entry and their question about it. Exported to that member; deleted with the account.',
   date '2026-10-30'),
  ('private', 'chapter_bid_entries', 'user_id', 'cascade', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.chapter_bid_entries',
   array['id','window_id','user_id','choice','award','recorded_at','awarded_at']::text[], null,
   'The member''s own bid and its award. Exported to that member; deleted with the account.',
   date '2026-10-30');

create function private.account_lifecycle_export_chapter_seniority_entries(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'organization_id', t.organization_id, 'chapter_id', t.chapter_id, 'user_id', t.user_id,
    'seniority_date', t.seniority_date, 'classification', t.classification, 'tie_break_note', t.tie_break_note,
    'question_note', t.question_note, 'question_status', t.question_status, 'questioned_at', t.questioned_at,
    'answer_note', t.answer_note, 'answered_at', t.answered_at,
    'created_at', t.created_at, 'updated_at', t.updated_at) order by t.created_at, t.id), '[]'::jsonb)
  from private.chapter_seniority_entries t where t.user_id = p_caller;
$$;

revoke all on function private.account_lifecycle_export_chapter_seniority_entries(uuid) from public, anon, authenticated, service_role;

create function private.account_lifecycle_export_chapter_bid_entries(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'window_id', t.window_id, 'user_id', t.user_id, 'choice', t.choice, 'award', t.award,
    'recorded_at', t.recorded_at, 'awarded_at', t.awarded_at) order by t.recorded_at, t.id), '[]'::jsonb)
  from private.chapter_bid_entries t where t.user_id = p_caller;
$$;

revoke all on function private.account_lifecycle_export_chapter_bid_entries(uuid) from public, anon, authenticated, service_role;

-- Re-emitted from the installed definition (20261027060200) with the two
-- chapter seniority domains added; every other key is unchanged.
create or replace function private.account_lifecycle_export_additional_domains(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'chapter_bid_entries', private.account_lifecycle_export_chapter_bid_entries(p_caller), 'chapter_seniority_entries', private.account_lifecycle_export_chapter_seniority_entries(p_caller), 'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_space_notification_settings', private.account_lifecycle_export_chapter_space_notification_settings(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_event_contact_links', private.account_lifecycle_export_member_event_contact_links(p_caller), 'member_event_contact_opt_ins', private.account_lifecycle_export_member_event_contact_opt_ins(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_profile_details', private.account_lifecycle_export_member_profile_details(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller), 'steward_contact_preferences', private.account_lifecycle_export_steward_contact_preferences(p_caller), 'steward_private_reminders', private.account_lifecycle_export_steward_private_reminders(p_caller), 'compass_training_member_consents', private.account_lifecycle_export_compass_training_member_consents(p_caller), 'compass_training_samples', private.account_lifecycle_export_compass_training_samples(p_caller)
  )
  || pg_catalog.jsonb_build_object(
    'member_capacity_commitments', private.account_lifecycle_export_member_capacity_commitments(p_caller), 'member_learning_assignments', private.account_lifecycle_export_member_learning_assignments(p_caller), 'member_membership_periods', private.account_lifecycle_export_member_membership_periods(p_caller), 'member_onboarding_steps', private.account_lifecycle_export_member_onboarding_steps(p_caller), 'member_participation_completions', private.account_lifecycle_export_member_participation_completions(p_caller), 'member_participation_events', private.account_lifecycle_export_member_participation_events(p_caller), 'member_recognition_events', private.account_lifecycle_export_member_recognition_events(p_caller)
  );
$$;

revoke all on function private.account_lifecycle_export_additional_domains(uuid) from public, anon, authenticated, service_role;

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger'
  and schema_name = 'private' and table_name in ('chapter_seniority_entries', 'chapter_bid_windows', 'chapter_bid_entries')
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

do $assert_chapter_seniority_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after chapter seniority';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after chapter seniority';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after chapter seniority';
  end if;
end;
$assert_chapter_seniority_lifecycle$;

notify pgrst, 'reload schema';

commit;
