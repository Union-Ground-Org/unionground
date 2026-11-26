-- BUG-UG-PULSE-CHART-MEETING-LABELS-ARE-IDS-20261102 (#6744).
--
-- A meeting_turnout chart broken down by meeting plotted member_events.id as
-- each bar's label, so the graphic, its accessibility label and the table
-- under it showed internal event ids. The meeting arm now also carries a
-- display label, the meeting's Eastern start and its title
-- ('2026-10-14 18:00 · Chapter meeting'), which sorts chronologically. Cells
-- and meeting bars are still keyed by the event id, so the distinct-person
-- floor and the whole-cube withholding test each meeting exactly as before,
-- and two meetings with the same title never merge into one bar. Every other
-- measure and breakdown is unchanged.
-- Signature, owner, security definer and grants are unchanged (revoked from
-- every client role in 20261102001534).

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

-- Pin the predecessor so a concurrent change to the chart cube is not lost.
do $assert_pulse_chart_values$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = 'private.pulse_chart_values(jsonb,text,text)'::pg_catalog.regprocedure)
      <> '5610a851230ae3639dae602f10d89b5e' then
    raise exception 'Unreviewed pulse_chart_values predecessor: integrate current Main before relabelling meetings';
  end if;
end;
$assert_pulse_chart_values$;

create or replace function private.pulse_chart_values(p_spec jsonb, p_hat text, p_chapter text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  org uuid; spec jsonb; measure text; privacy_floor integer; rows jsonb; safe boolean;
  first_month timestamptz; selected_month timestamptz; explanation text; local_level boolean;
begin
  perform private.lock_case_graph_read();
  org := private.pulse_chart_context(p_hat);
  spec := private.pulse_chart_spec(p_spec, p_hat, p_chapter);
  measure := spec->>'measure';
  local_level := coalesce(spec->>'level','chapter') = 'local';
  if measure <> 'my_actions' and private.quarterly_survey_gate_locks_caller() then
    return pg_catalog.jsonb_build_object('locked',true,'rows','[]'::jsonb,'countedFrom','Complete the quarterly survey to see aggregate figures.','privacyFloor',10);
  end if;
  privacy_floor := greatest(10, coalesce(private.organization_limit(org,'limits.analytics.anonymity_floor'),25));
  first_month := (pg_catalog.date_trunc('month',pg_catalog.now() at time zone 'America/New_York') - interval '11 months') at time zone 'America/New_York';
  selected_month := (pg_catalog.date_trunc('month',pg_catalog.now() at time zone 'America/New_York')
    - case spec->>'period' when '3m' then interval '2 months' when '6m' then interval '5 months' else interval '11 months' end) at time zone 'America/New_York';
  explanation := case measure
    when 'my_actions' then 'Your recorded collective-action sign-ups, grouped by Eastern calendar month. Other people and product analytics are excluded.'
    when 'published_actions' then 'Recorded sign-ups to published collective actions for this chapter. Private drafts, cancelled actions and product analytics are excluded.'
    when 'meeting_turnout' then 'Recorded check-ins at non-cancelled chapter meetings that have started. RSVPs and unrecorded attendance are excluded.'
    else 'Recorded cases in this chapter that your current staff role may read. Restricted or hidden cases outside that scope are excluded. Counts describe filings, not outcomes.' end;
  if local_level then explanation := pg_catalog.replace(explanation,'this chapter','your local');
    explanation := pg_catalog.replace(explanation,'chapter meetings','authorized meetings in your local'); end if;
  if spec ? 'unitID' then explanation := 'Unit: ' || (select u.name || ' · ' || c.name
    from private.chapter_units u join public.chapters c on c.id = u.chapter_id and c.organization_id = org
    where u.organization_id = org and u.id = (spec->>'unitID')::uuid) || '. ' || explanation; end if;
  if spec ? 'caseType' then explanation := 'Case type: ' || (spec->>'caseType') || '. ' || explanation; end if;
  if spec ? 'unitID' or spec->>'breakdown' = 'unit' then
    explanation := explanation || ' Units use current workplace details shared with administrators; private or unmatched details remain unassigned.';
  end if;
  with source as materialized (
    select p.user_id, p.joined_at as at, ''::text as meeting, ''::text as meeting_label, ''::text as kind, a.chapter_id as chapter
    from public.digital_action_participants p join public.digital_actions a on a.id = p.action_id and a.organization_id = p.organization_id
    where measure in ('my_actions','published_actions') and p.organization_id = org and p.joined_at >= first_month and p.joined_at <= pg_catalog.now()
      and (case when measure = 'my_actions' then p.user_id = auth.uid()
        else (a.chapter_id = p_chapter or local_level) and a.status in ('published','closed') end)
    union all
    select ch.user_id, e.starts_at, e.id,
      pg_catalog.to_char(e.starts_at at time zone 'America/New_York','YYYY-MM-DD HH24:MI') || ' · ' || e.title, ''::text, e.chapter_id
    from public.member_event_checkins ch join public.member_events e on e.id = ch.event_id
    join public.chapters event_chapter on event_chapter.id = e.chapter_id
    where measure = 'meeting_turnout' and event_chapter.organization_id = org and (e.chapter_id = p_chapter or local_level)
      and e.event_kind = 'meeting' and e.cancelled_at is null and e.starts_at >= first_month and e.starts_at <= pg_catalog.now()
      and private.member_can_access_event_scope(e.chapter_id,e.is_public,e.is_public_across_agencies)
    union all
    select c.user_id, c.created_at, ''::text, ''::text, case when c.case_type in ('Discipline','Scheduling','Telework','Safety','Pay') then c.case_type else 'Other' end, c.chapter_id
    from public.member_cases c
    where measure = 'visible_cases' and c.organization_id = org and (c.chapter_id = p_chapter or local_level)
      and c.created_at >= first_month and c.created_at <= pg_catalog.now() and private.casework_staff_can_access(c.id)
      and (p_hat <> 'steward' or c.user_id in (select private.staff_visible_member_ids('steward')))
  ), attributed as materialized (
    select s.*, pg_catalog.date_trunc('month',s.at at time zone 'America/New_York') as month,
      coalesce(u.id::text,'unassigned') as unit,
      coalesce(u.name,'Unassigned unit') || case when local_level then ' · ' || coalesce(chapter.name,'Organization-wide') else '' end as unit_name
    from source s
    left join public.member_profile_details d on d.user_id = s.user_id and d.details_visibility = 'admins' and p_hat = 'admin'
    left join private.chapter_units u on u.organization_id = org and u.chapter_id = s.chapter and u.name = d.worksite
    left join public.chapters chapter on chapter.id = s.chapter and chapter.organization_id = org
  ), cells as (
    select month, meeting, kind, unit, chapter, pg_catalog.count(distinct user_id) as people
    from attributed group by month, meeting, kind, unit, chapter
  ), selected as (
    select case spec->>'breakdown' when 'unit' then a.unit_name when 'meeting' then a.meeting_label else pg_catalog.to_char(a.month,'YYYY-MM') end as label,
      pg_catalog.count(*)::integer as value
    from attributed a where a.at >= selected_month
      and (not (spec ? 'unitID') or a.unit = spec->>'unitID') and (not (spec ? 'caseType') or a.kind = spec->>'caseType')
    group by 1, case when spec->>'breakdown' = 'meeting' then a.meeting end
  ), plotted as (
    select label,value from selected where spec->>'breakdown' <> 'month'
    union all
    select pg_catalog.to_char(m.month,'YYYY-MM'),coalesce(s.value,0)
    from pg_catalog.generate_series(
      pg_catalog.date_trunc('month',selected_month at time zone 'America/New_York'),
      pg_catalog.date_trunc('month',pg_catalog.now() at time zone 'America/New_York'),interval '1 month') m(month)
    left join selected s on s.label = pg_catalog.to_char(m.month,'YYYY-MM')
    where spec->>'breakdown' = 'month'
  )
  select coalesce((select pg_catalog.bool_and(people >= privacy_floor) from cells),true),
    coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('label',label,'value',value) order by label) from plotted),'[]'::jsonb)
    into safe, rows;
  return pg_catalog.jsonb_build_object('rows',case when safe or measure = 'my_actions' then rows else '[]'::jsonb end,
    'withheld',not safe and measure <> 'my_actions','privacyFloor',privacy_floor,'person',measure = 'my_actions',
    'countedFrom',explanation,'period',spec->>'period','form',spec->>'form');
end;
$function$;

revoke all on function private.pulse_chart_values(jsonb,text,text) from public, anon, authenticated, service_role;

commit;
