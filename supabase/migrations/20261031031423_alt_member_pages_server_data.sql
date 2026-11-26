-- REQ-UG-ALT-MEMBER-PAGES-SERVER-DATA-20261030
--
-- The alternate shell's Statistics page (My reports) draws three union-wide
-- panels the prototype fills with sample rows: wins and actions by month, how
-- grievances end, and a by-chapter table. No member-visible read carried
-- them; get_organization_analytics_snapshot is staff only.
--
-- public.get_member_union_statistics() publishes those aggregates to any
-- active member of a union organization, under the organization's analytics
-- anonymity floor (limits.analytics.anonymity_floor, never below ten):
--
-- 1. Every figure is a count over rows the organization owns: cases
--    (member_cases.organization_id), their recorded outcomes
--    (member_case_outcomes, through the case), sign-ups to the organization's
--    collective actions (digital_action_participants.organization_id, which
--    only the server's participation RPC writes) and active chapter
--    memberships. The member action log is not read: it carries no
--    organization and its rows are the caller's own writes. No row, name or
--    identifier of a person leaves the function, and nothing outside the
--    organization is counted.
-- 2. Each breakdown is all or nothing. Wins by month, actions by month, the
--    outcome breakdown and the chapter table's open-case column are each
--    published only when every non-zero cell counts at least the floor of
--    distinct people; otherwise the whole breakdown is withheld
--    ("withheld": true, no values). Because no withheld cell sits beside
--    published cells of the same breakdown, no total minus its neighbours can
--    recover it. The breakdowns do not overlap either: wins are a subset of
--    the recorded outcomes and no other total of resolved or outcome-bearing
--    cases is published, so a withheld outcome breakdown has no complement in
--    another panel; open cases are counted nowhere else. A chapter's member
--    count is published only at or above the floor; no organization member
--    total is published, so a small chapter's count has no complement.
-- 3. Months and the twelve-month window are Eastern-time calendar months,
--    the current month included.
-- 4. The caller needs an authenticated session with two-step assurance where
--    the organization requires it (private.mfa_satisfied, checked in the
--    body: REQ-UG-DEFINER-MFA-AUDIT) and a full session (a PIN session
--    cannot read case outcomes, as member_case_outcomes' step-up policy
--    says). Anyone else, a member of no organization, or the platform's own
--    organization, gets {"available": false}.
-- 4a. The quarterly "give to view" gate applies here as it does to the other
--    member report reads (20261002135600): a member it locks gets
--    {"available": false, "locked": true, "reason": "quarterly_survey_gate"}
--    and no figures, whatever page or client calls the function.
-- 5. The read takes the shared case-graph read gate first, as the staff
--    analytics snapshot does, so a concurrent account deletion is never
--    counted half-applied.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.get_member_union_statistics()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid;
  privacy_floor integer;
  generated timestamptz := pg_catalog.now();
  first_month timestamp;
  window_start timestamptz;
  months jsonb;
  wins_ok boolean;
  actions_ok boolean;
  outcomes jsonb;
  outcomes_ok boolean;
  chapters jsonb;
  open_ok boolean;
begin
  perform private.lock_case_graph_read();
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.member_pin_require_full_session();
  if private.quarterly_survey_gate_locks_caller() then
    return pg_catalog.jsonb_build_object('available', false, 'locked', true, 'reason', 'quarterly_survey_gate');
  end if;
  org := private.current_member_organization();
  if org is null or not private.is_organization_member(org) or not private.organization_is_union(org) then
    return pg_catalog.jsonb_build_object('available', false);
  end if;
  privacy_floor := greatest(coalesce(private.organization_limit(org, 'limits.analytics.anonymity_floor'), 25), 10);
  first_month := pg_catalog.date_trunc('month', generated at time zone 'America/New_York') - interval '11 months';
  window_start := first_month at time zone 'America/New_York';

  with month_list as (
    select pg_catalog.generate_series(first_month, first_month + interval '11 months', interval '1 month') as month
  ), wins as (
    select pg_catalog.date_trunc('month', o.recorded_at at time zone 'America/New_York') as month,
      pg_catalog.count(*)::integer as value,
      pg_catalog.count(distinct o.user_id)::integer as people
    from public.member_case_outcomes o
    join public.member_cases c on c.id = o.case_id
    where c.organization_id = org
      and o.outcome in ('upheld', 'settled')
      and o.recorded_at >= window_start
    group by 1
  ), actions as (
    select pg_catalog.date_trunc('month', p.joined_at at time zone 'America/New_York') as month,
      pg_catalog.count(*)::integer as value,
      pg_catalog.count(distinct p.user_id)::integer as people
    from public.digital_action_participants p
    where p.organization_id = org
      and p.joined_at >= window_start
    group by 1
  )
  select
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'month', pg_catalog.to_char(l.month, 'YYYY-MM'),
      'wins', coalesce(w.value, 0),
      'actions', coalesce(a.value, 0)
    ) order by l.month),
    pg_catalog.bool_and(coalesce(w.people, 0) = 0 or w.people >= privacy_floor),
    pg_catalog.bool_and(coalesce(a.people, 0) = 0 or a.people >= privacy_floor)
  into months, wins_ok, actions_ok
  from month_list l
  left join wins w on w.month = l.month
  left join actions a on a.month = l.month;

  with kinds(outcome, position) as (
    values ('upheld', 1), ('settled', 2), ('withdrawn', 3), ('denied', 4), ('other', 5)
  ), counted as (
    select o.outcome,
      pg_catalog.count(*)::integer as value,
      pg_catalog.count(distinct o.user_id)::integer as people
    from public.member_case_outcomes o
    join public.member_cases c on c.id = o.case_id
    where c.organization_id = org
      and o.recorded_at >= window_start
    group by o.outcome
  )
  select
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('outcome', k.outcome, 'count', coalesce(n.value, 0)) order by k.position),
    pg_catalog.bool_and(coalesce(n.people, 0) = 0 or n.people >= privacy_floor)
  into outcomes, outcomes_ok
  from kinds k
  left join counted n on n.outcome = k.outcome;

  with chapter_rows as (
    select ch.id, ch.name, ch.order_index,
      (select pg_catalog.count(distinct cm.user_id)::integer
         from public.member_chapter_memberships cm
        where cm.chapter_id = ch.id and cm.status = 'active') as members,
      (select pg_catalog.count(*)::integer from public.member_cases c
        where c.organization_id = org and c.chapter_id = ch.id and c.status = 'active') as open_cases,
      (select pg_catalog.count(distinct c.user_id)::integer from public.member_cases c
        where c.organization_id = org and c.chapter_id = ch.id and c.status = 'active') as open_people
    from public.chapters ch
    where ch.organization_id = org
  )
  select
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id,
      'name', r.name,
      'members', case when r.members >= privacy_floor then r.members else null end,
      'openCases', r.open_cases
    ) order by r.order_index, r.name, r.id),
    coalesce(pg_catalog.bool_and(r.open_people = 0 or r.open_people >= privacy_floor), true)
  into chapters, open_ok
  from chapter_rows r;

  -- A withheld column leaves the chapter rows without it.
  chapters := coalesce((
    select pg_catalog.jsonb_agg(
      case when open_ok then row.value else row.value - 'openCases' end
      order by row.ordinality)
    from pg_catalog.jsonb_array_elements(coalesce(chapters, '[]'::jsonb)) with ordinality as row(value, ordinality)
  ), '[]'::jsonb);

  return pg_catalog.jsonb_build_object(
    'available', true,
    'generatedAt', generated,
    'privacyFloor', privacy_floor,
    'windowStart', pg_catalog.to_char(first_month, 'YYYY-MM'),
    'wins', case when wins_ok
      then pg_catalog.jsonb_build_object('withheld', false, 'months', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('month', m.value ->> 'month', 'count', (m.value ->> 'wins')::integer)) from pg_catalog.jsonb_array_elements(months) m))
      else pg_catalog.jsonb_build_object('withheld', true) end,
    'actions', case when actions_ok
      then pg_catalog.jsonb_build_object('withheld', false, 'months', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('month', m.value ->> 'month', 'count', (m.value ->> 'actions')::integer)) from pg_catalog.jsonb_array_elements(months) m))
      else pg_catalog.jsonb_build_object('withheld', true) end,
    'outcomes', case when outcomes_ok
      then pg_catalog.jsonb_build_object('withheld', false, 'rows', outcomes)
      else pg_catalog.jsonb_build_object('withheld', true) end,
    'chapters', pg_catalog.jsonb_build_object(
      'rows', chapters,
      'openCasesWithheld', not open_ok
    )
  );
end;
$function$;

revoke all on function public.get_member_union_statistics()
  from public, anon, authenticated, service_role;
grant execute on function public.get_member_union_statistics()
  to authenticated;

comment on function public.get_member_union_statistics() is
  'REQ-UG-ALT-MEMBER-PAGES-SERVER-DATA-20261030: union-wide wins and collective-action sign-ups by month, grievance outcomes and the chapter table for any active member of a union organization; each breakdown is withheld whole unless every non-zero cell counts at least the analytics anonymity floor of distinct people.';

commit;
