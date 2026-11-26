-- REQ-UNION-BASE-COORDINATOR-DATA-COMPLETENESS-20260804: the coordinator desk
-- becomes complete at live scale, replacing the PR #688 truncation disclosures.
--
-- Two structural gaps shipped behind those disclosures:
--   1. A flat 1,000-row update fetch across the loaded page meant a case whose
--      updates all fell past the cap was indistinguishable from one never
--      updated — outreach guidance and urgency ranking misclassified it.
--   2. KPI counts came from the whole chapter (get_coordinator_kpis) while the
--      drilldown lists filtered the 200 nearest-deadline rows client-side,
--      with independently drifted predicates (an 8-day "week"; /arbitr/ where
--      the aggregate matches ~* 'arb').
--
-- The fix makes the server the single source:
--   - list_coordinator_cases serves keyset-paginated case pages under the SAME
--     due-week and arbitration predicates the KPI aggregate counts, so a tile
--     and its drilldown are two reads of one definition.
--   - list_case_latest_updates serves each case its own recent history plus
--     the true per-case total, so an empty updates array finally means
--     "never updated" and a shown history can say how much it omits.
--
-- Both functions are SECURITY INVOKER on purpose: the coordinator RLS widening
-- (member_cases_select_coordinator et al., routed through staff_can_see_user's
-- chapter gate) keeps deciding row visibility, so neither function can ever
-- see more than the coordinator's own direct table reads — the definer-scope
-- audit surface does not grow. The explicit role gate only keeps non-staff
-- callers from using them as a synonym for their self-scoped reads.

-- 1. Keyset case pages. Ordering is (deadline nulls last, id) — served by
--    member_cases_status_deadline_idx, the same hot path the desk's first page
--    already rides. status = 'active' stays load-bearing at live scale: it
--    keeps the per-row RLS definer call off the resolved bulk of the table.
create function public.list_coordinator_cases(
  p_focus text default 'all',
  p_after_deadline date default null,
  p_after_id uuid default null,
  p_limit integer default 200
)
returns setof public.member_cases
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 200), 1), 200);
begin
  if (select auth.uid()) is null or not public.member_has_role(array['coordinator']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;
  if p_focus not in ('all', 'due', 'arbitration') then
    raise exception 'unknown focus' using errcode = '22023';
  end if;

  -- The due window and arbitration predicates are copied from
  -- get_coordinator_kpis and MUST stay in sync with it. Due window is
  -- current_date + 6: seven days inclusive of today.
  return query
  select c.*
  from public.member_cases c
  where c.status = 'active'
    and (p_focus <> 'due' or (c.deadline is not null
      and c.deadline between current_date and current_date + 6))
    and (p_focus <> 'arbitration' or (c.step ~* 'arb' or c.step = 'Step 4'))
    and (
      p_after_id is null
      or (p_after_deadline is not null and (
        c.deadline > p_after_deadline
        or (c.deadline = p_after_deadline and c.id > p_after_id)
        or c.deadline is null))
      or (p_after_deadline is null and c.deadline is null and c.id > p_after_id)
    )
  order by c.deadline asc nulls last, c.id asc
  limit page_limit;
end;
$$;

revoke all on function public.list_coordinator_cases(text, date, uuid, integer) from public, anon;
grant execute on function public.list_coordinator_cases(text, date, uuid, integer) to authenticated, service_role;
comment on function public.list_coordinator_cases(text, date, uuid, integer) is
  'Keyset-paginated active-case pages for the coordinator desk. Focus predicates mirror get_coordinator_kpis exactly so KPI counts and drilldown contents agree; invoker security so the coordinator RLS widening decides visibility.';

-- 2. Per-case recent histories with the true total. The lateral shape rides
--    member_case_updates_case_created_idx (case_id, created_at); the window
--    count makes "empty" honest — total_count 0 is "never updated", while a
--    shown history knows how many older entries it omits.
create function public.list_case_latest_updates(
  p_case_ids uuid[],
  p_per_case integer default 20
)
returns table (case_id uuid, id uuid, body text, created_at timestamptz, total_count bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  per_case integer := least(greatest(coalesce(p_per_case, 20), 1), 100);
begin
  -- Bounded fan-in: the desk page is 200 cases; 500 leaves headroom without
  -- letting a caller turn this into an unbounded scan.
  if coalesce(pg_catalog.cardinality(p_case_ids), 0) > 500 then
    raise exception 'too many case ids' using errcode = '22023';
  end if;

  return query
  select ranked.case_id, ranked.id, ranked.body, ranked.created_at, ranked.total_count
  from (
    select u.case_id, u.id, u.body, u.created_at,
      pg_catalog.row_number() over (partition by u.case_id order by u.created_at desc, u.id desc) as rn,
      pg_catalog.count(*) over (partition by u.case_id) as total_count
    from public.member_case_updates u
    where u.case_id = any(p_case_ids)
  ) ranked
  where ranked.rn <= per_case
  order by ranked.case_id, ranked.created_at, ranked.id;
end;
$$;

revoke all on function public.list_case_latest_updates(uuid[], integer) from public, anon;
grant execute on function public.list_case_latest_updates(uuid[], integer) to authenticated, service_role;
comment on function public.list_case_latest_updates(uuid[], integer) is
  'Recent updates per case (newest kept, returned chronological) plus the true per-case total, replacing the flat 1,000-row fetch whose overflow made histories falsely empty. Invoker security: RLS decides visibility.';

notify pgrst, 'reload schema';
