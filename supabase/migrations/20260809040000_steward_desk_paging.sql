-- Steward desk paging (role-map UB-DESK-01): the desk was a single fetch
-- capped at 200 requests / 100 conversations / 600 messages / 20 broadcasts /
-- 100 forms with no search, filter, sort or cursor — a chapter past those caps
-- silently saw only the newest slice, and the KPI tiles were counted off the
-- truncated slice itself. The coordinator plane received server-side keyset
-- paging in the 2026-08-05 completeness wave (list_coordinator_cases); this
-- gives the steward desk the same treatment, plus the search/filter/sort the
-- record requires, with every page carrying the TRUE filtered total so the
-- view can always say "showing N of M" instead of presenting a slice as the
-- whole chapter.
--
-- Shape rules copied from list_coordinator_cases (sol-reviewed twice):
--   * security invoker + set search_path = '' — RLS (staff_can_see_user
--     chapter scoping) stays the single visibility authority; the function
--     adds an explicit steward role gate so a non-steward gets 42501, not an
--     empty page indistinguishable from a quiet chapter.
--   * closed-set filter/sort params raise 22023 on unknown values — a typo'd
--     filter must never degrade to 'all'.
--   * least(greatest(coalesce(p_limit, N), 1), CAP) clamps, mirrored by the
--     JS caller so a full page can never masquerade as a short one.
--   * keyset cursors are (timestamp, id) row comparisons over NOT NULL
--     columns; a half-supplied cursor raises 22023 rather than silently
--     serving page one. member_forms.submitted_at is the one nullable key,
--     so its pager keeps the coordinator's explicit nulls-last branches.
--   * name/initials resolve in the same statement via the RLS-checked
--     member_profiles join — a page is one round-trip, not a page plus a
--     client-side profile fan-out.
--
-- Search matches are case-insensitive substrings with LIKE wildcards escaped,
-- so a member named "100%_Smith" is findable and '%' is never an operator a
-- steward can type. total_count is computed over the filter+search set
-- IGNORING the cursor: it answers "how many match", not "how many remain".

-- Keyset indexes: the row-comparison predicates and their order-bys walk
-- (timestamp, id) pairs, which the existing single-column indexes serve only
-- with a residual sort on ties. The composite forms serve both directions
-- (backward scan covers desc, desc).
create index if not exists member_steward_requests_created_id_idx
  on public.member_steward_requests (created_at, id);
create index if not exists member_conversations_updated_id_idx
  on public.member_conversations (updated_at, id);
create index if not exists member_messages_convo_created_id_idx
  on public.member_messages (conversation_id, created_at, id);
create index if not exists member_broadcasts_published_id_idx
  on public.member_broadcasts (published_at, id);
create index if not exists member_forms_inbox_submitted_id_idx
  on public.member_forms (submitted_at, id) where status in ('submitted', 'in_review');

-- Rights-request queue: filter all/open/requested/acknowledged/closed, search
-- by member name, sort newest/oldest.
create function public.list_steward_requests(
  p_status text default 'all',
  p_search text default null,
  p_sort text default 'newest',
  p_after_created timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 100
) returns table (
  id uuid,
  user_id uuid,
  lesson_id text,
  status text,
  created_at timestamptz,
  member_name text,
  member_initials text,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  needle text := nullif(trim(coalesce(p_search, '')), '');
  pattern text;
  total bigint;
begin
  if (select auth.uid()) is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_status not in ('all', 'open', 'requested', 'acknowledged', 'closed') then
    raise exception 'unknown status filter' using errcode = '22023';
  end if;
  if p_sort not in ('newest', 'oldest') then
    raise exception 'unknown sort' using errcode = '22023';
  end if;
  if (p_after_id is null) <> (p_after_created is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;
  pattern := case when needle is null then null
    else '%' || replace(replace(replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  select count(*) into total
  from public.member_steward_requests r
  where (p_status = 'all'
      or (p_status = 'open' and r.status <> 'closed')
      or r.status = p_status)
    and (pattern is null or exists (
      select 1 from public.member_profiles pr
      where pr.id = r.user_id and pr.full_name ilike pattern));

  if p_sort = 'newest' then
    return query
    select r.id, r.user_id, r.lesson_id, r.status, r.created_at,
           pr.full_name, pr.initials, total
    from public.member_steward_requests r
    left join public.member_profiles pr on pr.id = r.user_id
    where (p_status = 'all'
        or (p_status = 'open' and r.status <> 'closed')
        or r.status = p_status)
      and (pattern is null or exists (
        select 1 from public.member_profiles p2
        where p2.id = r.user_id and p2.full_name ilike pattern))
      and (p_after_id is null or (r.created_at, r.id) < (p_after_created, p_after_id))
    order by r.created_at desc, r.id desc
    limit page_limit;
  else
    return query
    select r.id, r.user_id, r.lesson_id, r.status, r.created_at,
           pr.full_name, pr.initials, total
    from public.member_steward_requests r
    left join public.member_profiles pr on pr.id = r.user_id
    where (p_status = 'all'
        or (p_status = 'open' and r.status <> 'closed')
        or r.status = p_status)
      and (pattern is null or exists (
        select 1 from public.member_profiles p2
        where p2.id = r.user_id and p2.full_name ilike pattern))
      and (p_after_id is null or (r.created_at, r.id) > (p_after_created, p_after_id))
    order by r.created_at asc, r.id asc
    limit page_limit;
  end if;
end;
$$;

revoke all on function public.list_steward_requests(text, text, text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_steward_requests(text, text, text, timestamptz, uuid, integer) to authenticated, service_role;

-- Conversation list: one row per thread with its latest message riding along
-- (the desk preview no longer needs a 600-row global message fetch that let
-- one busy thread starve every other thread's preview). Filter all/awaiting,
-- search by member name or thread title, recency order.
create function public.list_steward_conversations(
  p_filter text default 'all',
  p_search text default null,
  p_after_updated timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 50
) returns table (
  id uuid,
  user_id uuid,
  title text,
  updated_at timestamptz,
  member_name text,
  member_initials text,
  last_body text,
  last_sender_kind text,
  last_created_at timestamptz,
  message_count bigint,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  needle text := nullif(trim(coalesce(p_search, '')), '');
  pattern text;
  total bigint;
begin
  if (select auth.uid()) is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_filter not in ('all', 'awaiting') then
    raise exception 'unknown thread filter' using errcode = '22023';
  end if;
  if (p_after_id is null) <> (p_after_updated is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;
  pattern := case when needle is null then null
    else '%' || replace(replace(replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  -- "Awaiting reply" is a property of the latest message, so the count has to
  -- evaluate the same latest-message subquery the page does — counting rows
  -- the page would not serve is exactly the KPI drift this wave removes.
  select count(*) into total
  from public.member_conversations c
  where (pattern is null
      or c.title ilike pattern
      or exists (
        select 1 from public.member_profiles pr
        where pr.id = c.user_id and pr.full_name ilike pattern))
    and (p_filter = 'all' or (
      select m.sender_kind from public.member_messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1) = 'member');

  return query
  select c.id, c.user_id, c.title, c.updated_at,
         pr.full_name, pr.initials,
         last.body, last.sender_kind, last.created_at,
         (select count(*) from public.member_messages mc where mc.conversation_id = c.id),
         total
  from public.member_conversations c
  left join public.member_profiles pr on pr.id = c.user_id
  left join lateral (
    select m.body, m.sender_kind, m.created_at
    from public.member_messages m
    where m.conversation_id = c.id
    order by m.created_at desc, m.id desc
    limit 1
  ) last on true
  where (pattern is null
      or c.title ilike pattern
      or exists (
        select 1 from public.member_profiles p2
        where p2.id = c.user_id and p2.full_name ilike pattern))
    and (p_filter = 'all' or last.sender_kind = 'member')
    and (p_after_id is null or (c.updated_at, c.id) < (p_after_updated, p_after_id))
  order by c.updated_at desc, c.id desc
  limit page_limit;
end;
$$;

revoke all on function public.list_steward_conversations(text, text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_steward_conversations(text, text, timestamptz, uuid, integer) to authenticated, service_role;

-- One thread's messages, newest window first, walking backward through
-- history — the dialog reverses to chronological and offers "load earlier".
-- total_count is the thread's true size so a window is always disclosed as
-- one. Sender identity columns stay limited to what the desk already renders
-- (kind + display name); no read_at, no author uuid.
create function public.list_steward_thread_messages(
  p_conversation_id uuid,
  p_before_created timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
) returns table (
  id uuid,
  sender_kind text,
  sender_name text,
  body text,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  total bigint;
begin
  if (select auth.uid()) is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_conversation_id is null then
    raise exception 'conversation required' using errcode = '22023';
  end if;
  if (p_before_id is null) <> (p_before_created is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;

  select count(*) into total
  from public.member_messages m
  where m.conversation_id = p_conversation_id;

  return query
  select m.id, m.sender_kind, m.sender_name, m.body, m.created_at, total
  from public.member_messages m
  where m.conversation_id = p_conversation_id
    and (p_before_id is null or (m.created_at, m.id) < (p_before_created, p_before_id))
  order by m.created_at desc, m.id desc
  limit page_limit;
end;
$$;

revoke all on function public.list_steward_thread_messages(uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_steward_thread_messages(uuid, timestamptz, uuid, integer) to authenticated, service_role;

-- Forms inbox: filter all/submitted/in_review (always inside the reviewable
-- pair — the RLS predicate and this WHERE agree on purpose), search by member
-- name, sort oldest (the inbox default: first-filed, first-reviewed) or
-- newest. submitted_at is nullable in the schema, so this pager keeps the
-- coordinator's explicit nulls-last keyset branches instead of a row
-- comparison that would silently drop a null-keyed row mid-walk.
create function public.list_steward_forms(
  p_status text default 'all',
  p_search text default null,
  p_sort text default 'oldest',
  p_after_submitted timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 50
) returns table (
  id uuid,
  user_id uuid,
  template_key text,
  template_version integer,
  status text,
  answers jsonb,
  step integer,
  submitted_at timestamptz,
  member_name text,
  member_initials text,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  needle text := nullif(trim(coalesce(p_search, '')), '');
  pattern text;
  total bigint;
begin
  if (select auth.uid()) is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_status not in ('all', 'submitted', 'in_review') then
    raise exception 'unknown status filter' using errcode = '22023';
  end if;
  if p_sort not in ('oldest', 'newest') then
    raise exception 'unknown sort' using errcode = '22023';
  end if;
  pattern := case when needle is null then null
    else '%' || replace(replace(replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  select count(*) into total
  from public.member_forms f
  where f.status in ('submitted', 'in_review')
    and (p_status = 'all' or f.status = p_status)
    and (pattern is null or exists (
      select 1 from public.member_profiles pr
      where pr.id = f.user_id and pr.full_name ilike pattern));

  if p_sort = 'oldest' then
    return query
    select f.id, f.user_id, f.template_key, f.template_version, f.status,
           f.answers, (f.step)::integer, f.submitted_at,
           pr.full_name, pr.initials, total
    from public.member_forms f
    left join public.member_profiles pr on pr.id = f.user_id
    where f.status in ('submitted', 'in_review')
      and (p_status = 'all' or f.status = p_status)
      and (pattern is null or exists (
        select 1 from public.member_profiles p2
        where p2.id = f.user_id and p2.full_name ilike pattern))
      and (p_after_id is null
        or (p_after_submitted is not null and (
             f.submitted_at > p_after_submitted
             or (f.submitted_at = p_after_submitted and f.id > p_after_id)
             or f.submitted_at is null))
        or (p_after_submitted is null and f.submitted_at is null and f.id > p_after_id))
    order by f.submitted_at asc nulls last, f.id asc
    limit page_limit;
  else
    return query
    select f.id, f.user_id, f.template_key, f.template_version, f.status,
           f.answers, (f.step)::integer, f.submitted_at,
           pr.full_name, pr.initials, total
    from public.member_forms f
    left join public.member_profiles pr on pr.id = f.user_id
    where f.status in ('submitted', 'in_review')
      and (p_status = 'all' or f.status = p_status)
      and (pattern is null or exists (
        select 1 from public.member_profiles p2
        where p2.id = f.user_id and p2.full_name ilike pattern))
      and (p_after_id is null
        or (p_after_submitted is not null and (
             f.submitted_at < p_after_submitted
             or (f.submitted_at = p_after_submitted and f.id < p_after_id)
             or f.submitted_at is null))
        or (p_after_submitted is null and f.submitted_at is null and f.id < p_after_id))
    order by f.submitted_at desc nulls last, f.id desc
    limit page_limit;
  end if;
end;
$$;

revoke all on function public.list_steward_forms(text, text, text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_steward_forms(text, text, text, timestamptz, uuid, integer) to authenticated, service_role;

-- Broadcast history: the desk's own published feed. Filter all/active/
-- retracted, search title or body, newest first. member_broadcasts.id is TEXT
-- (seeded ids like 'bc-7'), so the cursor id is text and ties break on plain
-- text order — deterministic is all a keyset needs.
create function public.list_steward_broadcasts(
  p_filter text default 'all',
  p_search text default null,
  p_after_published timestamptz default null,
  p_after_id text default null,
  p_limit integer default 20
) returns table (
  id text,
  sender text,
  title text,
  body text,
  published_at timestamptz,
  retracted_at timestamptz,
  locale text,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  needle text := nullif(trim(coalesce(p_search, '')), '');
  pattern text;
  total bigint;
begin
  if (select auth.uid()) is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_filter not in ('all', 'active', 'retracted') then
    raise exception 'unknown broadcast filter' using errcode = '22023';
  end if;
  if (p_after_id is null) <> (p_after_published is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;
  pattern := case when needle is null then null
    else '%' || replace(replace(replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  select count(*) into total
  from public.member_broadcasts b
  where (p_filter = 'all'
      or (p_filter = 'active' and b.retracted_at is null)
      or (p_filter = 'retracted' and b.retracted_at is not null))
    and (pattern is null or b.title ilike pattern or b.body ilike pattern);

  return query
  select b.id, b.sender, b.title, b.body, b.published_at, b.retracted_at,
         b.locale, total
  from public.member_broadcasts b
  where (p_filter = 'all'
      or (p_filter = 'active' and b.retracted_at is null)
      or (p_filter = 'retracted' and b.retracted_at is not null))
    and (pattern is null or b.title ilike pattern or b.body ilike pattern)
    and (p_after_id is null or (b.published_at, b.id) < (p_after_published, p_after_id))
  order by b.published_at desc, b.id desc
  limit page_limit;
end;
$$;

revoke all on function public.list_steward_broadcasts(text, text, timestamptz, text, integer) from public, anon;
grant execute on function public.list_steward_broadcasts(text, text, timestamptz, text, integer) to authenticated, service_role;

-- Desk KPIs, aggregated server-side over the SAME RLS the pages read through.
-- The tiles were previously counted off the capped client slices, so a
-- chapter past a cap under-reported its own open queue on the steward's own
-- desk. members-covered stays with get_steward_chapter_member_count.
create function public.get_steward_desk_kpis()
returns table (
  open_requests bigint,
  awaiting_reply bigint,
  broadcasts_30d bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  return query
  select
    (select count(*) from public.member_steward_requests r where r.status <> 'closed'),
    (select count(*) from public.member_conversations c where (
      select m.sender_kind from public.member_messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1) = 'member'),
    (select count(*) from public.member_broadcasts b
     where b.retracted_at is null
       and b.published_at > now() - interval '30 days');
end;
$$;

revoke all on function public.get_steward_desk_kpis() from public, anon;
grant execute on function public.get_steward_desk_kpis() to authenticated, service_role;
