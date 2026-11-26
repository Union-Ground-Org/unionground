-- #8927 slice 3: the Casework group of ready-made Chapter Pulse charts.
-- Data rules: the recommended rule of each Casework chart and of decisions A,
-- B and L in the #8927 data-rules draft, decided on
-- Sun Nov 22, 2026.
--
-- Sources, re-read on Main:
-- * Grievance workflow (decision A): a case belongs to it when the
--   organization's configured grievance procedure covers it
--   (private.casework_resolve_procedure, 20260917133000). No procedure covering
--   the chapter is "unavailable", never zero. Generic cases are not grievances.
-- * Recorded intake and verified first resolution: the trigger-captured row
--   history private.casework_record_versions (20260917143000), which lives as
--   long as its case. Intake is the INSERT version of an active case; the first
--   resolution is the earliest active->resolved UPDATE version. A case without
--   that INSERT version (created before the history existed) is left out of
--   every timed measure, and every card says so in a standing line. Neither
--   member_cases.updated_at nor an outcome's recorded_at is used as a clock.
-- * Who may open: chapter case staff only (members never). Rows are filtered
--   BEFORE counting by the Case flow row rule, private.chapter_case_readable
--   (the member_cases RLS policy: unit stewards their unit, identity-private
--   and restricted cases only where that oracle admits them), in the selected
--   chapter of the caller's organization, without learning-undone cases and
--   without the caller's own case.
-- * Overdue: a current structured deadline (active or extended) past due, or
--   one the sweep marked missed, as the steward deadline list counts it
--   (20261102172000); a case's
--   date-only deadline only when it has no structured deadline, and only after
--   its Eastern day has ended.
-- * Not recorded today, so not built: a review-stage mapping ("In review"), an
--   approved category taxonomy or controlled tags (Issue explorer, Cases by
--   frequency, Casework tags).
--
-- Privacy: people (case owners) are counted for privacy, cases for the
-- measure. Owners are grouped by how many cases each contributes to each
-- released figure (private.pulse_contribution_groups), and every such group
-- goes through slice 2's shared,
-- persistent partition (private.pulse_release_safe) with the organization's
-- own floor; a group that fails withholds every figure released with it.
-- Payloads carry counts, rates, mean days and Eastern dates only: no names,
-- identifiers, case types, titles, narratives or deadline labels.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Each chart read names the chapter its screen shows (p_chapter_id) and is
-- refused unless that is still the caller's selected chapter when it runs, so
-- a selection that moves away and back during the reads cannot put another
-- chapter's figures under this chapter's name.
--
-- Who may open the Casework charts: an authenticated, step-up-satisfied member
-- of a union organization holding a case-staff role for the selected chapter,
-- decided by the established oracle private.actor_has_chapter_staff_role: the
-- member_role_chapters grant for that chapter with an active chapter
-- membership, or an organization staff grant, and in either case the staff
-- second factor whenever the organization requires staff MFA (#9476 round 1,
-- r1s2 and r1s3). The row filter below still decides which cases count, so a
-- unit steward counts only their unit.
create function private.pulse_casework_allowed(p_org uuid, p_chapter text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select (select auth.uid()) is not null and p_org is not null and p_chapter is not null
    and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and p_org = private.current_member_organization() and p_chapter = private.current_member_chapter()
    and private.is_organization_member(p_org) and private.organization_is_union(p_org)
    and exists(select 1 from public.chapters ch where ch.id = p_chapter and ch.organization_id = p_org)
    and private.actor_has_chapter_staff_role((select auth.uid()), p_chapter);
$function$;
revoke all on function private.pulse_casework_allowed(uuid,text) from public,anon,authenticated,service_role;

-- Privacy groups for a counted measure (#9476 round 1, r1s1 and r2s1). The
-- input holds one owner id per counted case; the output groups the owners by
-- how many cases each contributes (everyone with exactly one, everyone with
-- exactly two, ...). Every group goes through the persistent partition, so
-- people are indistinguishable there only when they contributed the same
-- number of cases to every released figure. A second case for an owner
-- already counted moves that owner to another group; the partition then
-- refuses the release unless the floor of people moved together, so no
-- difference between two releases can come from fewer people than the floor.
create function private.pulse_contribution_groups(p_entries jsonb)
returns jsonb language sql immutable set search_path = '' as $function$
  select coalesce(pg_catalog.jsonb_agg(level.people order by level.cases), '[]'::jsonb)
  from (
    select contribution.cases, pg_catalog.jsonb_agg(contribution.person order by contribution.person) as people
    from (
      select entry.person, pg_catalog.count(*) as cases
      from pg_catalog.jsonb_array_elements_text(p_entries) as entry(person)
      group by entry.person
    ) contribution
    group by contribution.cases
  ) level;
$function$;
revoke all on function private.pulse_contribution_groups(jsonb) from public,anon,authenticated,service_role;

-- Privacy groups for a released mean (#9476 final, r3s1 and r4s1). The input
-- holds one {person, days} entry per counted case; the output groups owners
-- by their full contribution, the number of cases AND the total days. Owners
-- are then indistinguishable in the partition only when they gave the same
-- count and the same day total to every released mean, so no owner can
-- change the mean (one case swapped for another, or many) unless the floor
-- of owners changed identically.
create function private.pulse_total_groups(p_entries jsonb)
returns jsonb language sql immutable set search_path = '' as $function$
  select coalesce(pg_catalog.jsonb_agg(level.people order by level.cases, level.total), '[]'::jsonb)
  from (
    select contribution.cases, contribution.total, pg_catalog.jsonb_agg(contribution.person order by contribution.person) as people
    from (
      select entry.value->>'person' as person, pg_catalog.count(*) as cases, pg_catalog.sum((entry.value->>'days')::bigint) as total
      from pg_catalog.jsonb_array_elements(p_entries) as entry
      group by entry.value->>'person'
    ) contribution
    group by contribution.cases, contribution.total
  ) level;
$function$;
revoke all on function private.pulse_total_groups(jsonb) from public,anon,authenticated,service_role;

-- A configured grievance procedure covers this chapter (decision A).
create function private.pulse_casework_procedure(p_org uuid, p_chapter text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists(select 1 from public.casework_procedures p where p.organization_id = p_org and p.active
    and (p.chapter_id = p_chapter or p.chapter_id is null));
$function$;
revoke all on function private.pulse_casework_procedure(uuid,text) from public,anon,authenticated,service_role;

-- The readable grievance-workflow cases of the selected chapter, one row per
-- case, permissions applied before any count. Only the owner id and the case
-- id (for the privacy groups, never returned to a client), current state and
-- Eastern dates.
create function private.pulse_casework_rows(p_org uuid, p_chapter text)
returns table(person uuid, is_open boolean, overdue boolean, trusted boolean, intake_on date, resolved_on date, case_id uuid)
language sql stable security definer set search_path = '' as $function$
  select c.user_id,
    c.status = 'active',
    c.status = 'active' and (
      exists(select 1 from public.casework_deadlines d where d.case_id = c.id
        and d.status in ('active','extended','missed') and (d.due_at < pg_catalog.now() or d.status = 'missed'))
      or (c.deadline is not null
        and not exists(select 1 from public.casework_deadlines d where d.case_id = c.id)
        and ((c.deadline + 1)::timestamp at time zone 'America/New_York') <= pg_catalog.now())),  -- fixed-zone: report periods stay on New York's zone until part 5 of #9446 moves them
    intake.recorded_at is not null,
    (intake.recorded_at at time zone 'America/New_York')::date,  -- fixed-zone: report periods stay on New York's zone until part 5 of #9446 moves them
    case when intake.recorded_at is not null then (resolution.resolved_at at time zone 'America/New_York')::date end,  -- fixed-zone: report periods stay on New York's zone until part 5 of #9446 moves them
    c.id
  from public.member_cases c
  left join lateral (
    select v.at as recorded_at from private.casework_record_versions v
    where v.record_table = 'member_cases' and v.record_id = c.id::text and v.op = 'INSERT'
      and v.new_row->>'status' = 'active'
    order by v.id limit 1
  ) intake on true
  left join lateral (
    select pg_catalog.min(v.at) as resolved_at from private.casework_record_versions v
    where v.record_table = 'member_cases' and v.record_id = c.id::text and v.op = 'UPDATE'
      and v.old_row->>'status' = 'active' and v.new_row->>'status' = 'resolved'
  ) resolution on true
  where c.organization_id = p_org and c.chapter_id = p_chapter
    and c.learning_undone_at is null
    and c.user_id is distinct from (select auth.uid())
    and private.casework_resolve_procedure(c.organization_id, c.chapter_id, c.case_type) is not null
    and private.chapter_case_readable(c);
$function$;
revoke all on function private.pulse_casework_rows(uuid,text) from public,anon,authenticated,service_role;

-- 01. Open and overdue grievances: open, overdue and resolved this month (so
-- far, Eastern) released together or withheld together. In review needs a
-- configured review-stage mapping the product does not record: unavailable.
create function public.get_pulse_open_overdue(p_chapter_id text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare
  org uuid := private.current_member_organization();
  chapter text := p_chapter_id;
  month_start date := pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'America/New_York')::date;  -- fixed-zone: report periods stay on New York's zone until part 5 of #9446 moves them
  due jsonb; ontime jsonb; resolved jsonb;
  open_cases bigint; due_cases bigint; resolved_cases bigint;
  safe boolean;
begin
  if not private.mfa_satisfied() or not private.pulse_casework_allowed(org, chapter) then return pg_catalog.jsonb_build_object('state','unavailable'); end if;
  if not private.pulse_casework_procedure(org, chapter) then
    return pg_catalog.jsonb_build_object('state','unavailable','reason','no_grievance_procedure');
  end if;
  select coalesce(pg_catalog.jsonb_agg(r.person::text) filter (where r.is_open and r.overdue), '[]'::jsonb),
    coalesce(pg_catalog.jsonb_agg(r.person::text) filter (where r.is_open and not r.overdue), '[]'::jsonb),
    coalesce(pg_catalog.jsonb_agg(r.person::text) filter (where r.trusted and r.resolved_on >= month_start), '[]'::jsonb),
    pg_catalog.count(*) filter (where r.is_open), pg_catalog.count(*) filter (where r.is_open and r.overdue),
    pg_catalog.count(*) filter (where r.trusted and r.resolved_on >= month_start)
  into due, ontime, resolved, open_cases, due_cases, resolved_cases
  from private.pulse_casework_rows(org, chapter) r;
  safe := private.pulse_release_safe(org, private.pulse_contribution_groups(due) || private.pulse_contribution_groups(ontime) || private.pulse_contribution_groups(resolved));
  return pg_catalog.jsonb_build_object(
    'state', case when not safe then 'withheld' when open_cases = 0 and resolved_cases = 0 then 'no_eligible_records' else 'ready' end,
    'open', case when safe then open_cases end,
    'overdue', case when safe then due_cases end,
    'resolvedThisMonth', case when safe then resolved_cases end,
    'monthStart', month_start,
    'inReview', pg_catalog.jsonb_build_object('state','unavailable','reason','no_review_stage_mapping'));
end;
end;
$function$;
revoke all on function public.get_pulse_open_overdue(text) from public,anon,authenticated,service_role;
grant execute on function public.get_pulse_open_overdue(text) to authenticated;

-- 02. Resolution rate (decision B): for each of the last eight completed
-- Eastern weeks, the cases whose sixtieth calendar day after recorded intake
-- fell in that week, still-open cases included; the share with a verified
-- first resolution on or before that day. Each week's resolved and
-- not-resolved people are checked together; no eight-week total is released.
create function public.get_pulse_resolution_rate(p_chapter_id text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare
  org uuid := private.current_member_organization();
  chapter text := p_chapter_id;
  this_week date := pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'America/New_York')::date;  -- fixed-zone: report periods stay on New York's zone until part 5 of #9446 moves them
  week_start date;
  hit jsonb; miss jsonb; cohort bigint; resolved bigint;
  safe boolean;
  weeks jsonb := '[]'::jsonb; scope jsonb;
begin
  if not private.mfa_satisfied() or not private.pulse_casework_allowed(org, chapter) then return pg_catalog.jsonb_build_object('state','unavailable'); end if;
  if not private.pulse_casework_procedure(org, chapter) then
    return pg_catalog.jsonb_build_object('state','unavailable','reason','no_grievance_procedure');
  end if;
  -- One snapshot of the readable rows for every week (no temporary table).
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)), '[]'::jsonb)
  into scope from private.pulse_casework_rows(org, chapter) r;
  for ago in reverse 8..1 loop
    week_start := this_week - 7 * ago;
    select coalesce(pg_catalog.jsonb_agg(s.person::text) filter (where s.resolved_on is not null and s.resolved_on <= s.intake_on + 60), '[]'::jsonb),
      coalesce(pg_catalog.jsonb_agg(s.person::text) filter (where s.resolved_on is null or s.resolved_on > s.intake_on + 60), '[]'::jsonb),
      pg_catalog.count(*), pg_catalog.count(*) filter (where s.resolved_on is not null and s.resolved_on <= s.intake_on + 60)
    into hit, miss, cohort, resolved
    from pg_catalog.jsonb_to_recordset(scope) as s(person uuid, is_open boolean, overdue boolean, trusted boolean, intake_on date, resolved_on date)
    where s.trusted and s.intake_on + 60 >= week_start and s.intake_on + 60 < week_start + 7;
    if cohort = 0 then safe := true; else safe := private.pulse_release_safe(org, private.pulse_contribution_groups(hit) || private.pulse_contribution_groups(miss)); end if;
    weeks := weeks || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('weekStart', week_start,
      'state', case when not safe then 'withheld' when cohort = 0 then 'no_eligible_records' else 'ready' end,
      'cohort', case when safe and cohort > 0 then cohort end,
      'resolved', case when safe and cohort > 0 then resolved end,
      'percentage', case when safe and cohort > 0 then pg_catalog.round(100.0 * resolved / cohort, 1) end));
  end loop;
  return pg_catalog.jsonb_build_object('state','ready','days',60,'weeks',weeks);
end;
end;
$function$;
revoke all on function public.get_pulse_resolution_rate(text) from public,anon,authenticated,service_role;
grant execute on function public.get_pulse_resolution_rate(text) to authenticated;

-- 15. Days to resolve a grievance (decision L): the mean calendar days from
-- recorded intake to verified first resolution for cases first resolved in
-- each of the last eight completed Eastern weeks; cases open now (including
-- one reopened after that resolution) are not in it. A mean moves with each
-- case's day count, not only with how many cases a person has, so owners are
-- grouped by their case count AND total days (private.pulse_total_groups),
-- and the week's case ids go into the partition as one more group: a week in
-- which fewer than the floor of owners changed their day total, or fewer than
-- the floor of cases changed, is withheld (#9476 final, r3s1 and r4s1). The comparison (earlier four weeks against later four) is released only
-- when all eight weeks are released and nonempty, and states no cause.
create function public.get_pulse_days_to_resolve(p_chapter_id text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare
  org uuid := private.current_member_organization();
  chapter text := p_chapter_id;
  this_week date := pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'America/New_York')::date;  -- fixed-zone: report periods stay on New York's zone until part 5 of #9446 moves them
  week_start date;
  people jsonb; case_ids jsonb; cases bigint; total_days bigint;
  safe boolean; comparable boolean := true;
  early_cases bigint := 0; early_days bigint := 0; late_cases bigint := 0; late_days bigint := 0;
  weeks jsonb := '[]'::jsonb; scope jsonb;
begin
  if not private.mfa_satisfied() or not private.pulse_casework_allowed(org, chapter) then return pg_catalog.jsonb_build_object('state','unavailable'); end if;
  if not private.pulse_casework_procedure(org, chapter) then
    return pg_catalog.jsonb_build_object('state','unavailable','reason','no_grievance_procedure');
  end if;
  -- One snapshot of the readable rows for every week (no temporary table).
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)), '[]'::jsonb)
  into scope from private.pulse_casework_rows(org, chapter) r;
  for ago in reverse 8..1 loop
    week_start := this_week - 7 * ago;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('person', s.person::text, 'days', s.resolved_on - s.intake_on)), '[]'::jsonb),
      coalesce(pg_catalog.jsonb_agg(s.case_id::text), '[]'::jsonb),
      pg_catalog.count(*), coalesce(pg_catalog.sum(s.resolved_on - s.intake_on), 0)
    into people, case_ids, cases, total_days
    from pg_catalog.jsonb_to_recordset(scope) as s(person uuid, is_open boolean, overdue boolean, trusted boolean, intake_on date, resolved_on date, case_id uuid)
    where s.trusted and not s.is_open and s.resolved_on >= week_start and s.resolved_on < week_start + 7;
    if cases = 0 then safe := true;
    else safe := private.pulse_release_safe(org, private.pulse_total_groups(people) || pg_catalog.jsonb_build_array(case_ids)); end if;
    if not safe or cases = 0 then comparable := false;
    elsif ago > 4 then early_cases := early_cases + cases; early_days := early_days + total_days;
    else late_cases := late_cases + cases; late_days := late_days + total_days; end if;
    weeks := weeks || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('weekStart', week_start,
      'state', case when not safe then 'withheld' when cases = 0 then 'no_eligible_records' else 'ready' end,
      'resolved', case when safe and cases > 0 then cases end,
      'meanDays', case when safe and cases > 0 then pg_catalog.round(total_days::numeric / cases, 1) end));
  end loop;
  return pg_catalog.jsonb_build_object('state','ready','weeks',weeks,
    'comparison', case when comparable then pg_catalog.jsonb_build_object(
      'earlierMeanDays', pg_catalog.round(early_days::numeric / early_cases, 1),
      'laterMeanDays', pg_catalog.round(late_days::numeric / late_cases, 1)) end);
end;
end;
$function$;
revoke all on function public.get_pulse_days_to_resolve(text) from public,anon,authenticated,service_role;
grant execute on function public.get_pulse_days_to_resolve(text) to authenticated;

-- 14. Casework: cases opened (recorded intake) and first resolved in each of
-- the last eight completed Eastern weeks, checked together per week; and the
-- current status of the cases opened in those eight weeks, released only when
-- every week is released (its total equals the weeks' sum, so a withheld week
-- could otherwise be subtracted out). Tags need an approved broad taxonomy the
-- product does not record: unavailable.
create function public.get_pulse_casework(p_chapter_id text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare
  org uuid := private.current_member_organization();
  chapter text := p_chapter_id;
  this_week date := pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'America/New_York')::date;  -- fixed-zone: report periods stay on New York's zone until part 5 of #9446 moves them
  week_start date;
  opened_people jsonb; resolved_people jsonb; opened bigint; resolved bigint;
  active_people jsonb; closed_people jsonb; active_cases bigint; closed_cases bigint;
  safe boolean; every_week boolean := true; status_safe boolean;
  weeks jsonb := '[]'::jsonb; scope jsonb;
begin
  if not private.mfa_satisfied() or not private.pulse_casework_allowed(org, chapter) then return pg_catalog.jsonb_build_object('state','unavailable'); end if;
  if not private.pulse_casework_procedure(org, chapter) then
    return pg_catalog.jsonb_build_object('state','unavailable','reason','no_grievance_procedure');
  end if;
  -- One snapshot of the readable rows for every week (no temporary table).
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)), '[]'::jsonb)
  into scope from private.pulse_casework_rows(org, chapter) r;
  for ago in reverse 8..1 loop
    week_start := this_week - 7 * ago;
    select coalesce(pg_catalog.jsonb_agg(s.person::text) filter (where s.intake_on >= week_start and s.intake_on < week_start + 7), '[]'::jsonb),
      coalesce(pg_catalog.jsonb_agg(s.person::text) filter (where s.resolved_on >= week_start and s.resolved_on < week_start + 7), '[]'::jsonb),
      pg_catalog.count(*) filter (where s.intake_on >= week_start and s.intake_on < week_start + 7),
      pg_catalog.count(*) filter (where s.resolved_on >= week_start and s.resolved_on < week_start + 7)
    into opened_people, resolved_people, opened, resolved
    from pg_catalog.jsonb_to_recordset(scope) as s(person uuid, is_open boolean, overdue boolean, trusted boolean, intake_on date, resolved_on date) where s.trusted;
    safe := private.pulse_release_safe(org, private.pulse_contribution_groups(opened_people) || private.pulse_contribution_groups(resolved_people));
    every_week := every_week and safe;
    weeks := weeks || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('weekStart', week_start,
      'state', case when safe then 'ready' else 'withheld' end,
      'opened', case when safe then opened end, 'resolved', case when safe then resolved end));
  end loop;
  select coalesce(pg_catalog.jsonb_agg(s.person::text) filter (where s.is_open), '[]'::jsonb),
    coalesce(pg_catalog.jsonb_agg(s.person::text) filter (where not s.is_open), '[]'::jsonb),
    pg_catalog.count(*) filter (where s.is_open), pg_catalog.count(*) filter (where not s.is_open)
  into active_people, closed_people, active_cases, closed_cases
  from pg_catalog.jsonb_to_recordset(scope) as s(person uuid, is_open boolean, overdue boolean, trusted boolean, intake_on date, resolved_on date)
  where s.trusted and s.intake_on >= this_week - 56 and s.intake_on < this_week;
  status_safe := false;
  if every_week then status_safe := private.pulse_release_safe(org, private.pulse_contribution_groups(active_people) || private.pulse_contribution_groups(closed_people)); end if;
  return pg_catalog.jsonb_build_object('state','ready','weeks',weeks,
    'status', pg_catalog.jsonb_build_object(
      'state', case when not status_safe then 'withheld' when active_cases + closed_cases = 0 then 'no_eligible_records' else 'ready' end,
      'cohortStart', this_week - 56,
      'open', case when status_safe then active_cases end,
      'resolved', case when status_safe then closed_cases end),
    'tags', pg_catalog.jsonb_build_object('state','unavailable','reason','no_approved_taxonomy'));
end;
end;
$function$;
revoke all on function public.get_pulse_casework(text) from public,anon,authenticated,service_role;
grant execute on function public.get_pulse_casework(text) to authenticated;

-- The ready-made options, restated from 20261121035100 with the Casework group
-- added. Options carry identifiers only; each data read repeats its gate.
create or replace function public.pulse_ready_chart_options()
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph_read();
declare
  org uuid:=private.current_member_organization();
  chapter text:=private.current_member_chapter();
  result jsonb:='[]'::jsonb;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or not private.is_organization_member(org)
    or not exists(select 1 from public.chapters c where c.id=chapter and c.organization_id=org) then return result; end if;
  if private.organization_is_union(org) and (private.chapter_notice_scope_allowed(chapter,null,null)
    or exists(select 1 from private.steward_assignment_scopes((select auth.uid()),chapter) s where private.chapter_notice_scope_allowed(chapter,s.unit_id,s.committee_id))
    or exists(select 1 from private.organization_steward_unit_assignments s where s.user_id=(select auth.uid()) and s.chapter_id=chapter and private.chapter_notice_scope_allowed(chapter,s.unit_id,null))) then
    result:=result||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('key','ready:notice-reach','group','Voice','read','get_pulse_notice_reach'));
  end if;
  if exists(select 1 from public.chapter_spaces s where s.chapter_id=chapter and s.archived_at is null and private.can_read_chapter_space(s)) then
    result:=result||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('key','ready:meeting-night-poll','group','Meetings','read','get_pulse_meeting_poll'));
  end if;
  -- #8927 slice 3: the Casework charts, for chapter case staff only.
  if private.pulse_casework_allowed(org,chapter) then
    result:=result||pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('key','ready:open-overdue','group','Casework','read','get_pulse_open_overdue'),
      pg_catalog.jsonb_build_object('key','ready:resolution-rate','group','Casework','read','get_pulse_resolution_rate'),
      pg_catalog.jsonb_build_object('key','ready:days-to-resolve','group','Casework','read','get_pulse_days_to_resolve'),
      pg_catalog.jsonb_build_object('key','ready:casework','group','Casework','read','get_pulse_casework'));
  end if;
  return result;
end;
end;
$function$;

-- The person's layout options, restated from 20261113148000 with the Casework
-- ready keys added for the selected chapter, so Customize can offer them and a
-- layout may hold them. Identifiers only; never a figures read.
create or replace function private.pulse_layout_options(p_chapter_id text,p_hat text)
returns text[] language plpgsql stable security definer set search_path = '' as $function$
declare org uuid; chart record; keys text[] := array['fixed:actions','fixed:outcomes','fixed:poll'];
begin
  org := private.pulse_layout_context(p_chapter_id,p_hat);
  if p_hat = 'member' then
    keys := keys || array['fixed:week','fixed:meetings'];
  elsif p_hat in ('vp','president') then
    keys := keys || array['fixed:membership','fixed:meetings','fixed:turnout','fixed:reach'];
  elsif p_hat = 'advisor' then keys := keys || array['fixed:health'];
  elsif p_hat = 'coordinator' then keys := keys || array['fixed:workload','fixed:flow','fixed:unassigned'];
  elsif p_hat = 'admin' then keys := keys || array['fixed:access','fixed:attention','fixed:events','fixed:forms'];
  elsif p_hat = 'steward' then
    keys := keys || array['fixed:caseload','fixed:requests','fixed:forms','fixed:unassigned','fixed:workload','fixed:ulp','fixed:quorum'];
  end if;
  -- The existing history read exposes this chapter series only to an active
  -- chapter member or an organization-wide hat, and has no local series.
  if private.member_can_access_event_scope(p_chapter_id,false,false) then
    keys := keys || array['fixed:history-chapter-meeting_checkins'];
  end if;
  -- #8927 slice 3: the Casework ready charts follow the same server gate as
  -- their reads (chapter case staff, selected chapter, union organization).
  if p_hat <> 'member' and private.pulse_casework_allowed(org,p_chapter_id) then
    keys := keys || array['ready:open-overdue','ready:resolution-rate','ready:days-to-resolve','ready:casework'];
  end if;
  for chart in select c.id,c.spec from private.pulse_saved_charts c
    where c.owner_id = auth.uid() and c.organization_id = org and c.chapter_id = p_chapter_id
      and c.deleted_at is null order by c.id limit 30 loop
    begin
      perform private.pulse_chart_spec(chart.spec,p_hat,p_chapter_id);
      keys := pg_catalog.array_append(keys,'saved:' || chart.id::text);
    exception when insufficient_privilege or invalid_parameter_value then
      -- Revoked roles, removed units and unavailable specs withdraw the key.
      null;
    end;
  end loop;
  return keys;
end;
$function$;
commit;
