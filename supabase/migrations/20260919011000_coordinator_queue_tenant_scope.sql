-- BUG-UG-COORDINATOR-QUEUE-AND-KPI-SCOPE-DIVERGE-20260918
--
-- public.list_coordinator_cases (20260805120000:32-75) is SECURITY INVOKER
-- and bounded only by the member_cases SELECT policies. Those policies admit
-- a sibling chapter's case to an ORGANIZATION-level coordinator
-- (private.actor_has_chapter_staff_role accepts an organization role grant
-- for every chapter in the organization). PR #2171 bounds
-- public.get_coordinator_kpis to the caller's tenant with the same predicates
-- private.casework_dashboard_open_cases uses (20260917142000:110-118), so
-- after that sibling lands one loadCoordinatorDesk call
-- (src/lib/memberApi.js:4104-4112) yields badge 1, queue 2 rows, tile 1.
-- 20260805120000:54-56 said the pair "MUST stay in sync".
--
-- Repair. Re-emit the pager with the SAME tenant bound #2171 copies from
-- private.casework_dashboard_open_cases, applied before the RLS-visible read:
--
--   c.organization_id is not null
--   and c.chapter_id is not null
--   and c.organization_id = (select private.current_member_organization())
--   and c.chapter_id = (select private.current_member_chapter())
--
-- Copied, not paraphrased: a paraphrase is how the badge, the queue and the
-- tile drifted apart. Visibility stays the invoker + RLS path — a restricted
-- case without a grant is already hidden by the member_cases SELECT policies,
-- and this function must not grow a definer-scope audit surface. The tenant
-- predicates are the cheap, index-usable bound that keeps the per-row RLS
-- helper off every other tenant's and chapter's rows.
--
-- Signature, SECURITY INVOKER, STABLE, empty search_path, role gate, focus
-- vocabulary, due window (current_date + 6), arbitration predicate, keyset
-- (deadline nulls last, id), page clamp, revoke and grant are unchanged.

begin;

set local lock_timeout = '5s';

create or replace function public.list_coordinator_cases(
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

  -- Tenant bound copied from private.casework_dashboard_open_cases
  -- (20260917142000) / public.get_coordinator_kpis (PR #2171) and MUST stay
  -- in sync with both. Applied before the remaining focus and keyset
  -- predicates so the RLS-visible read never visits another chapter. Due
  -- window is current_date + 6: seven days inclusive of today.
  return query
  select c.*
  from public.member_cases c
  where c.status = 'active'
    and c.organization_id is not null
    and c.chapter_id is not null
    and c.organization_id = (select private.current_member_organization())
    and c.chapter_id = (select private.current_member_chapter())
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
  'Keyset-paginated active-case pages for the coordinator desk. Tenant-bounded to the caller''s own organization and chapter — the same bound public.get_coordinator_kpis and the PR #2109 dashboard aggregates use — then filtered by invoker RLS so a restricted case without a grant stays hidden. Focus predicates still mirror get_coordinator_kpis exactly so KPI counts, queue rows and tile totals agree once that sibling lands.';

notify pgrst, 'reload schema';

commit;
