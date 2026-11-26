-- BUG-UG-BID-RECORDS-STALE-AWARD-AND-500-CAP-20261102 (#6778):
--
--   1. public.record_chapter_bid kept a bid's award when a steward changed
--      its choice, so the award could name a superseded choice. A changed
--      choice now clears award and awarded_at in the same write, and the
--      answer says so (awardCleared) for the panel to tell the steward.
--      Recording the same choice again keeps the award.
--   2. public.list_chapter_bid_windows returns the 500 most senior bids of each
--      window. public.list_chapter_bid_window_bids pages one window's bids in
--      the same order with the same fields and the same authority, so every
--      bid can be listed and awarded.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.record_chapter_bid(p_window_id uuid, p_user_id uuid, p_choice text)
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
  prior private.chapter_bid_entries%rowtype;
  cleared boolean := false;
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

  -- The bid as it stands, locked: an award made for another choice no longer
  -- describes this bid.
  select * into prior from private.chapter_bid_entries b
  where b.window_id = target.id and b.user_id = p_user_id
  for update;
  cleared := prior.id is not null and prior.award is not null and prior.choice is distinct from clean;

  insert into private.chapter_bid_entries as b (window_id, user_id, choice)
  values (target.id, p_user_id, clean)
  on conflict (window_id, user_id) do update set
    choice = excluded.choice,
    recorded_at = pg_catalog.now(),
    award = case when b.choice is distinct from excluded.choice then null else b.award end,
    awarded_at = case when b.choice is distinct from excluded.choice then null else b.awarded_at end
  returning b.id into bid_id;
  return pg_catalog.jsonb_build_object('id', bid_id, 'awardCleared', cleared);
end;
end;
$function$;

revoke all on function public.record_chapter_bid(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.record_chapter_bid(uuid, uuid, text) to authenticated;
comment on function public.record_chapter_bid(uuid, uuid, text) is
  'REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030: records or changes a member''s bid in an open window for the chapter''s stewards and coordinators. BUG-UG-BID-RECORDS-STALE-AWARD-AND-500-CAP-20261102: a changed choice clears the bid''s award, and the answer reports awardCleared.';

create function public.list_chapter_bid_window_bids(p_window_id uuid, p_offset integer default 0, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  target private.chapter_bid_windows%rowtype;
  cap integer := greatest(1, least(coalesce(p_limit, 100), 500));
  -- No upper bound on the offset: every bid of a window stays reachable
  -- (gate r2s3). nextOffset is computed only below the total, so it cannot
  -- overflow.
  skip integer := greatest(0, coalesce(p_offset, 0));
  total integer;
  page jsonb;
begin
  select * into target from private.chapter_bid_windows w where w.id = p_window_id;
  if not found or not private.seniority_staff_can_manage(target.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select pg_catalog.count(*)::integer into total from private.chapter_bid_entries counted where counted.window_id = target.id;

  -- The order and fields of list_chapter_bid_windows' first 500, so page
  -- offset 500 continues exactly where that list stops.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', b.id,
      'userId', b.user_id,
      'name', coalesce(nullif(pg_catalog.btrim(coalesce(profile.full_name, '')), ''), 'Member'),
      'choice', b.choice,
      'award', b.award,
      'awardedAt', b.awarded_at,
      'seniorityDate', b.seniority_date,
      'classification', b.classification
    ) order by b.seniority_date nulls last, b.entry_id nulls last, b.recorded_at, b.id), '[]'::jsonb)
  into page
  from (
    select x.*, entry.seniority_date, entry.classification, entry.id as entry_id
    from private.chapter_bid_entries x
    left join private.chapter_seniority_entries entry on entry.chapter_id = target.chapter_id and entry.user_id = x.user_id
    where x.window_id = target.id
    order by entry.seniority_date nulls last, entry.id nulls last, x.recorded_at, x.id
    limit cap offset skip
  ) b
  left join public.member_profiles profile on profile.id = b.user_id;

  return pg_catalog.jsonb_build_object(
    'windowId', target.id,
    'total', total,
    'nextOffset', case when skip::bigint + cap < total then skip + cap end,
    'bids', page
  );
end;
end;
$function$;

revoke all on function public.list_chapter_bid_window_bids(uuid, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_chapter_bid_window_bids(uuid, integer, integer) to authenticated;
comment on function public.list_chapter_bid_window_bids(uuid, integer, integer) is
  'BUG-UG-BID-RECORDS-STALE-AWARD-AND-500-CAP-20261102: one bid window''s bids for the chapter''s stewards and coordinators, paged (at most 500 a page) in seniority order, so bids beyond list_chapter_bid_windows'' first 500 can be listed and awarded.';

commit;
