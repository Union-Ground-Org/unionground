-- Make the thirteen staff-only organizing entry points visible to the MFA
-- contract audit. Their private lifecycle/bargaining helpers already enforce
-- MFA; retain those stricter role, session and locking checks as well.
-- Preserve the case-graph lock as the first operation of each writer. Exact
-- predecessor hashes refuse applying this edit to an unreviewed definition.
begin;
set local lock_timeout = '5s';
-- Written out as literal definitions (each from its source migration with
-- this edit applied), so the function inventory can read every body; the
-- predecessor check below refuses an unreviewed definition as before.
do $predecessors$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_union_lifecycle_workspace()'::regprocedure) is distinct from '9fc36f008f57585363b50b6190ad0965' then
    raise exception 'unreviewed predecessor: %', 'public.get_union_lifecycle_workspace()';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.transition_organizing_campaign(uuid, integer, text, uuid, text)'::regprocedure) is distinct from '23a8431779e9645e6199619185292bcb' then
    raise exception 'unreviewed predecessor: %', 'public.transition_organizing_campaign(uuid, integer, text, uuid, text)';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.set_organizing_campaign_status(uuid, integer, text, uuid, text, text)'::regprocedure) is distinct from '639e59d97a09c28979ba7f545ffbbbd9' then
    raise exception 'unreviewed predecessor: %', 'public.set_organizing_campaign_status(uuid, integer, text, uuid, text, text)';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.record_resistance_incident(uuid, text, text, text, text, uuid, text, date, timestamp with time zone, boolean)'::regprocedure) is distinct from '5305cb86dff2c359c2381edfad5e5d6f' then
    raise exception 'unreviewed predecessor: %', 'public.record_resistance_incident(uuid, text, text, text, text, uuid, text, date, timestamp with time zone, boolean)';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.open_organizing_bargaining_cycle(uuid, integer, text, uuid, date, text, timestamp with time zone)'::regprocedure) is distinct from '3a3e1c43092e19a40ed3e70a32a679df' then
    raise exception 'unreviewed predecessor: %', 'public.open_organizing_bargaining_cycle(uuid, integer, text, uuid, date, text, timestamp with time zone)';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.transition_organizing_bargaining_cycle(uuid, integer, integer, text, uuid, date, text, text, timestamp with time zone)'::regprocedure) is distinct from '56211076c48630befd877ae2cc275aab' then
    raise exception 'unreviewed predecessor: %', 'public.transition_organizing_bargaining_cycle(uuid, integer, integer, text, uuid, date, text, text, timestamp with time zone)';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.create_organizing_bargaining_proposal(uuid, integer, text, text, text, uuid, text, uuid[], text, uuid, integer, text, text, text)'::regprocedure) is distinct from 'e977e6dffc507eeab96498de060d8ff6' then
    raise exception 'unreviewed predecessor: %', 'public.create_organizing_bargaining_proposal(uuid, integer, text, text, text, uuid, text, uuid[], text, uuid, integer, text, text, text)';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.transition_organizing_bargaining_proposal(uuid, integer, integer, text, uuid, date, text)'::regprocedure) is distinct from '5580f145dd5c3511d2be64999fed9ed8' then
    raise exception 'unreviewed predecessor: %', 'public.transition_organizing_bargaining_proposal(uuid, integer, integer, text, uuid, date, text)';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.schedule_organizing_bargaining_session(uuid, integer, timestamp with time zone, uuid, text, text)'::regprocedure) is distinct from '2295d3b524544231fe634d594b07b4cb' then
    raise exception 'unreviewed predecessor: %', 'public.schedule_organizing_bargaining_session(uuid, integer, timestamp with time zone, uuid, text, text)';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.record_organizing_first_contract(uuid, integer, integer, uuid, text, date, uuid, text, text, text, integer, integer, date, date)'::regprocedure) is distinct from 'a439663ce22f95d62a559bda1bc9ec18' then
    raise exception 'unreviewed predecessor: %', 'public.record_organizing_first_contract(uuid, integer, integer, uuid, text, date, uuid, text, text, text, integer, integer, date, date)';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.record_organizing_bargaining_session_outcome(uuid, integer, integer, text, uuid, timestamp with time zone, text, text, text)'::regprocedure) is distinct from '54fb424d37b57e258c3886ce9cde35ec' then
    raise exception 'unreviewed predecessor: %', 'public.record_organizing_bargaining_session_outcome(uuid, integer, integer, text, uuid, timestamp with time zone, text, text, text)';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.record_organizing_ratification(uuid, integer, integer, uuid, text, text, date, text, text, text, text, text, text, integer, integer, integer, integer, integer, integer, integer, integer, integer, text, text, uuid)'::regprocedure) is distinct from '511e4767b82a4d04d2c787ea2ff87f8e' then
    raise exception 'unreviewed predecessor: %', 'public.record_organizing_ratification(uuid, integer, integer, uuid, text, text, date, text, text, text, text, text, text, integer, integer, integer, integer, integer, integer, integer, integer, integer, text, text, uuid)';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.correct_organizing_ratification(uuid, integer, integer, text, text, text, text, uuid)'::regprocedure) is distinct from 'cc45b8e3c0c58f3f97abbbce15188e96' then
    raise exception 'unreviewed predecessor: %', 'public.correct_organizing_ratification(uuid, integer, integer, text, text, text, text, uuid)';
  end if;
end;
$predecessors$;

-- public.get_union_lifecycle_workspace: its definition from 20261014001000_unionground_union_lifecycle.sql with this migration's edit.
create or replace function public.get_union_lifecycle_workspace()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  scope_chapter text := private.lifecycle_scope_chapter(array['organizer', 'coordinator', 'advisor', 'vp']);
  resistance_details boolean;
  chapter_wide boolean;
  aggregate_view boolean;
  chapter_name text;
  member_total integer;
  workspace jsonb;
begin
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;
  if caller is null or scope_chapter is null then
    raise exception 'lifecycle staff role required' using errcode = '42501';
  end if;

  chapter_wide := exists (
    select 1 from public.member_role_chapters r
    where r.user_id = caller
      and r.chapter_id = scope_chapter
      and r.role = 'coordinator'
  );
  aggregate_view := exists (
    select 1 from public.member_role_chapters r
    where r.user_id = caller
      and r.chapter_id = scope_chapter
      and r.role in ('advisor', 'vp')
  ) and not chapter_wide and not exists (
    select 1 from public.member_role_chapters r
    where r.user_id = caller
      and r.chapter_id = scope_chapter
      and r.role = 'organizer'
  );
  resistance_details := chapter_wide or exists (
    select 1
    from public.organizing_campaign_assignments a
    where a.chapter_id = scope_chapter
      and a.user_id = caller
      and a.status = 'active'
      and a.assignment_role in ('lead_organizer', 'organizer', 'legal_reviewer')
  );
  select c.name into chapter_name from public.chapters c where c.id = scope_chapter;
  select pg_catalog.count(distinct p.user_id)::integer into member_total
  from public.member_membership_periods p
  where p.chapter_id = scope_chapter
    and p.status = 'active'
    and p.left_on is null
    and p.verified_at is not null;

  workspace := pg_catalog.jsonb_build_object(
    'mode', 'live',
    'generatedAt', now(),
    'chapter', pg_catalog.jsonb_build_object('id', scope_chapter, 'name', chapter_name),
    'methodology', pg_catalog.jsonb_build_object(
      'label', 'Role-scoped lifecycle records',
      'detail', 'Campaign and worksite summaries omit worker identity, contact details, support position, evidence content, and private legal narratives.',
      'suppressionMinimum', 5
    ),
    'access', pg_catalog.jsonb_build_object(
      'canCreateCampaign', exists (
        select 1 from public.member_role_chapters r
        where r.user_id = caller
          and r.chapter_id = scope_chapter
          and r.role in ('organizer', 'coordinator')
      ),
      'resistanceDetails', resistance_details,
      'resistanceCampaignIds', coalesce((
        select pg_catalog.jsonb_agg(c.id)
        from public.organizing_campaigns c
        where c.chapter_id = scope_chapter
          and (
            chapter_wide
            or exists (
              select 1
              from public.organizing_campaign_assignments a
              where a.campaign_id = c.id
                and a.user_id = caller
                and a.status = 'active'
                and a.assignment_role in ('lead_organizer', 'organizer', 'legal_reviewer')
            )
          )
      ), '[]'::jsonb),
      'chapterWideOperations', chapter_wide,
      'aggregateOnly', aggregate_view
    ),
    'campaigns', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'employerName', e.display_name,
        'worksiteName', w.name,
        'proposedUnit', c.proposed_unit,
        'ownerName', case when private.lifecycle_can_operate_campaign(c.id) then coalesce(owner.full_name, 'Assigned team') else 'Assigned team' end,
        'canOperate', private.lifecycle_can_operate_campaign(c.id),
        'stage', c.stage,
        'status', c.status,
        'revision', c.revision,
        'closedAt', c.closed_at,
        'stageStartedAt', c.stage_started_at,
        'targetDate', c.target_date,
        'nextAction', case when private.lifecycle_can_operate_campaign(c.id) then c.next_action else null end,
        'nextActionDue', case when private.lifecycle_can_operate_campaign(c.id) then c.next_action_due_at else null end,
        'eligibleEstimate', case
          when private.lifecycle_can_operate_campaign(c.id)
           and c.eligible_estimate >= 5
           and coverage.committee_count >= 5
           and coverage.contacted_count - coverage.committee_count >= 5
           and c.eligible_estimate - coverage.contacted_count >= 5
           and (
             c.eligible_estimate - coverage.work_area_eligible_count = 0
             or c.eligible_estimate - coverage.work_area_eligible_count >= 5
           )
           and not coverage.has_suppressed_area
          then c.eligible_estimate
          else null
        end,
        'contactedCount', case
          when private.lifecycle_can_operate_campaign(c.id)
           and c.eligible_estimate >= 5
           and coverage.committee_count >= 5
           and coverage.contacted_count - coverage.committee_count >= 5
           and c.eligible_estimate - coverage.contacted_count >= 5
           and (
             c.eligible_estimate - coverage.work_area_eligible_count = 0
             or c.eligible_estimate - coverage.work_area_eligible_count >= 5
           )
           and not coverage.has_suppressed_area
          then coverage.contacted_count
          else null
        end,
        'committeeCount', case
          when private.lifecycle_can_operate_campaign(c.id)
           and c.eligible_estimate >= 5
           and coverage.committee_count >= 5
           and coverage.contacted_count - coverage.committee_count >= 5
           and c.eligible_estimate - coverage.contacted_count >= 5
           and (
             c.eligible_estimate - coverage.work_area_eligible_count = 0
             or c.eligible_estimate - coverage.work_area_eligible_count >= 5
           )
           and not coverage.has_suppressed_area
          then coverage.committee_count
          else null
        end,
        'cardsSigned', null,
        'route', case
          when c.representation_path = 'election' then
            pg_catalog.jsonb_build_array('lead','committee','cards','petition','election','certification','bargaining','first_contract','established')
          when c.representation_path = 'voluntary_recognition' then
            pg_catalog.jsonb_build_array('lead','committee','cards','recognition','certification','bargaining','first_contract','established')
          else
            pg_catalog.jsonb_build_array('lead','committee','cards')
        end,
        'verifiedStages', coalesce((
          select pg_catalog.jsonb_agg(s.to_stage order by s.occurred_at)
          from public.organizing_stage_events s where s.campaign_id = c.id
        ), pg_catalog.jsonb_build_array(c.stage)),
        'outcome', c.outcome,
        'outcomeReason', case when private.lifecycle_can_operate_campaign(c.id) then c.outcome_reason else null end
      ) order by c.next_action_due_at nulls last, c.created_at desc)
      from public.organizing_campaigns c
      join public.union_employers e on e.id = c.employer_id
      join public.union_worksites w on w.id = c.primary_worksite_id
      left join public.member_profiles owner
        on owner.id = c.owner_id and owner.chapter_id = c.chapter_id
      left join lateral (
        select
          coalesce(pg_catalog.sum(a.eligible_estimate), 0)::integer as work_area_eligible_count,
          coalesce(pg_catalog.sum(a.contacted_count), 0)::integer as contacted_count,
          coalesce(pg_catalog.sum(a.committee_count), 0)::integer as committee_count,
          coalesce(pg_catalog.bool_or(
            coalesce(a.eligible_estimate, 0) < 5
            or a.committee_count < 5
            or a.contacted_count - a.committee_count < 5
            or a.eligible_estimate - a.contacted_count < 5
          ), true) as has_suppressed_area
        from public.organizing_work_areas a
        where a.campaign_id = c.id
      ) coverage on true
      where c.chapter_id = scope_chapter
        and (
          chapter_wide
          or exists (
            select 1
            from public.organizing_campaign_assignments a
            where a.campaign_id = c.id
              and a.user_id = caller
              and a.status = 'active'
              and a.assignment_role in ('lead_organizer', 'organizer', 'coordinator', 'legal_reviewer', 'viewer')
          )
        )
    ), '[]'::jsonb),
    'workAreas', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id,
        'campaignId', a.campaign_id,
        'name', a.name,
        'shift', a.shift,
        'eligibleEstimate', case
          when coalesce(a.eligible_estimate, 0) >= 5
           and a.committee_count >= 5
           and a.contacted_count - a.committee_count >= 5
           and a.eligible_estimate - a.contacted_count >= 5
          then a.eligible_estimate
          else null
        end,
        'contactedCount', case
          when coalesce(a.eligible_estimate, 0) >= 5
           and a.committee_count >= 5
           and a.contacted_count - a.committee_count >= 5
           and a.eligible_estimate - a.contacted_count >= 5
          then a.contacted_count
          else null
        end,
        'committeeCount', case
          when coalesce(a.eligible_estimate, 0) >= 5
           and a.committee_count >= 5
           and a.contacted_count - a.committee_count >= 5
           and a.eligible_estimate - a.contacted_count >= 5
          then a.committee_count
          else null
        end,
        'issueThemes', case
          when coalesce(a.eligible_estimate, 0) >= 5
           and a.committee_count >= 5
           and a.contacted_count - a.committee_count >= 5
           and a.eligible_estimate - a.contacted_count >= 5
          then to_jsonb(a.issue_themes)
          else '[]'::jsonb
        end
      ) order by a.name, a.shift)
      from public.organizing_work_areas a
      where a.chapter_id = scope_chapter
        and (
          chapter_wide
          or exists (
            select 1
            from public.organizing_campaign_assignments assignment
            where assignment.campaign_id = a.campaign_id
              and assignment.user_id = caller
              and assignment.status = 'active'
              and assignment.assignment_role in ('lead_organizer', 'organizer', 'coordinator', 'viewer')
          )
        )
    ), '[]'::jsonb),
    'resistanceEvents', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', i.id,
        'campaignId', i.campaign_id,
        'category', i.category,
        'severity', i.severity,
        'occurredOn', i.occurred_on,
        'reportedOn', i.reported_on,
        'title', i.title,
        'summary', i.factual_summary,
        'sourceType', i.source_kind,
        'legalReviewStatus', i.legal_review_status,
        'agency', i.agency,
        'chargeNumber', i.charge_number,
        'chargeStatus', i.charge_status,
        'nextDeadline', i.next_deadline_at,
        'ownerName', coalesce(owner.full_name, 'Assigned team'),
        'evidenceCount', i.evidence_count,
        'resolution', i.resolution
      ) order by i.next_deadline_at nulls last, i.reported_on desc)
      from public.organizing_resistance_incidents i
      left join public.member_profiles owner
        on owner.id = i.owner_id and owner.chapter_id = i.chapter_id
      where i.chapter_id = scope_chapter
        and (
          chapter_wide
          or exists (
            select 1
            from public.organizing_campaign_assignments a
            where a.campaign_id = i.campaign_id
              and a.user_id = caller
              and a.status = 'active'
              and a.assignment_role in ('lead_organizer', 'organizer', 'legal_reviewer')
          )
        )
    ), '[]'::jsonb),
    'bargaining', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', b.id,
        'campaignId', b.campaign_id,
        'status', b.phase,
        'bargainingStartedOn', b.bargaining_started_on,
        'firstContractTargetOn', b.target_first_contract_on,
        'firstContractSignedOn', b.first_contract_signed_on,
        'surveyReturnRate', null,
        'surveyReturnAvailability', 'Not shown without a verified denominator and suppression check.',
        'proposals', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', p.id,
            'topic', p.topic,
            'title', p.title,
            'side', p.side,
            'status', p.status,
            'version', p.version,
            'presentedOn', p.presented_on
          ) order by p.created_at)
          from public.organizing_bargaining_proposals p where p.cycle_id = b.id
        ), '[]'::jsonb),
        'sessions', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', s.id,
            'startsAt', s.starts_at,
            'location', s.location,
            'status', s.status,
            'summary', coalesce(s.member_update, s.agenda, '')
          ) order by s.starts_at desc)
          from public.organizing_bargaining_sessions s where s.cycle_id = b.id
        ), '[]'::jsonb)
      ) order by b.created_at desc)
      from public.organizing_bargaining_cycles b
      where b.chapter_id = scope_chapter
        and (
          chapter_wide
          or exists (
            select 1
            from public.organizing_campaign_assignments a
            where a.campaign_id = b.campaign_id
              and a.user_id = caller
              and a.status = 'active'
              and a.assignment_role in ('lead_organizer', 'organizer', 'coordinator', 'viewer')
          )
        )
    ), '[]'::jsonb),
    'engagement', pg_catalog.jsonb_build_object(
      'asOf', current_date,
      'source', 'Verified membership periods and participation events',
      'method', 'Thirty- and ninety-day metrics require exact verified membership dates and full observation windows.',
      'coverage', 'Live records only',
      'suppressionMinimum', 25,
      'memberCount', case when member_total >= 25 then member_total else null end,
      'availability', 'Metrics remain unavailable until verified cohorts mature and pass suppression.',
      'onboarding30', null,
      'onboarding90', null,
      'membershipRetention12Month', null,
      'engagementRetention12Month', null,
      'ladder', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('stage','learn','count',null),
        pg_catalog.jsonb_build_object('stage','attend','count',null),
        pg_catalog.jsonb_build_object('stage','volunteer','count',null),
        pg_catalog.jsonb_build_object('stage','organize','count',null),
        pg_catalog.jsonb_build_object('stage','lead','count',null)
      ),
      'safeRewardKinds', pg_catalog.jsonb_build_array('Training completion','Orientation completion','Verified peer outreach','Committee commitment','Completed voluntary commitment'),
      'excludedRewardKinds', pg_catalog.jsonb_build_array('Case or grievance','Form or co-signature','Retaliation or ULP report','Evidence upload','Steward request','Private message','Workload log','Vote or survey','RSVP or generic attendance','Check-in or scan','Support position','Card or signature','Outcome or remedy')
    ),
    'coalitions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', h.id,
        'name', p.name,
        'organizationType', p.organization_type,
        'sharedInterest', h.shared_interest,
        'bridgeLead', coalesce(lead.full_name, 'Not assigned'),
        'status', h.status,
        'governance', h.governance_summary,
        'commitments', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', c.id,
            'title', c.title,
            'ownerOrg', c.owner_side,
            'dueOn', c.due_on,
            'status', c.status,
            'outcome', c.outcome
          ) order by c.due_on nulls last)
          from public.coalition_commitments c where c.handshake_id = h.id
        ), '[]'::jsonb)
      ) order by p.name)
      from public.coalition_handshakes h
      join public.coalition_partners p on p.id = h.partner_id
      left join public.member_profiles lead
        on lead.id = h.bridge_lead_id and lead.chapter_id = h.chapter_id
      where h.chapter_id = scope_chapter
    ), '[]'::jsonb),
    'impact', pg_catalog.jsonb_build_object(
      'period', (extract(year from current_date)::integer - 9)::text || '–' || extract(year from current_date)::integer::text,
      'asOf', current_date,
      'source', 'Recorded campaign openings and verified membership periods',
      'method', 'Calendar-year openings below five and verified person cohorts below twenty-five are suppressed; complementary totals are hidden.',
      'suppressionMinimum', 5,
      'summary', pg_catalog.jsonb_build_object(
        'campaigns', (
          select case
            when pg_catalog.count(*) >= 5
             and not exists (
               select 1
               from pg_catalog.generate_series(
                 extract(year from current_date)::integer - 9,
                 extract(year from current_date)::integer
               ) hidden_year(year)
               where (
                 select pg_catalog.count(*)
                 from public.organizing_campaigns hidden_campaign
                 where hidden_campaign.chapter_id = scope_chapter
                   and extract(year from hidden_campaign.created_at)::integer = hidden_year.year
               ) between 1 and 4
             )
            then pg_catalog.count(*)
            else null
          end
          from public.organizing_campaigns
          where chapter_id = scope_chapter
            and created_at >= date_trunc('year', current_date) - interval '9 years'
            and created_at < date_trunc('year', current_date) + interval '1 year'
        ),
        'certified', null,
        'firstContracts', null
      ),
      'years', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'year', y.year,
          'campaigns', case when y.campaigns >= 5 then y.campaigns else null end,
          'certified', null,
          'firstContracts', null,
          'outcomeSuppressed', y.campaigns < 5,
          'joined', case when y.joined >= 25 then y.joined else null end,
          'left', case when y.left_count >= 25 then y.left_count else null end
        ) order by y.year)
        from (
          select years.year,
            (select pg_catalog.count(*)::integer from public.organizing_campaigns c where c.chapter_id = scope_chapter and extract(year from c.created_at)::integer = years.year) campaigns,
            (select pg_catalog.count(distinct m.user_id)::integer from public.member_membership_periods m where m.chapter_id = scope_chapter and m.verified_at is not null and m.joined_on is not null and extract(year from m.joined_on)::integer = years.year) joined,
            (select pg_catalog.count(distinct m.user_id)::integer from public.member_membership_periods m where m.chapter_id = scope_chapter and m.verified_at is not null and m.left_on is not null and extract(year from m.left_on)::integer = years.year) left_count
          from pg_catalog.generate_series(
            extract(year from current_date)::integer - 9,
            extract(year from current_date)::integer
          ) years(year)
        ) y
      ), '[]'::jsonb),
      'availability', 'Outcome conversion and duration metrics remain unavailable until audited cohorts pass primary and complementary suppression.',
      'funnel', '[]'::jsonb,
      'medianDays', '[]'::jsonb
    )
  );

  -- Advisor/VP access is aggregate-only. Remove every record-shaped projection
  -- (including coalition names, named bridge leads, governance text, owner
  -- details, and commitment registers) before returning the workspace.
  if aggregate_view then
    workspace := workspace || pg_catalog.jsonb_build_object(
      'campaigns', '[]'::jsonb,
      'worksites', '[]'::jsonb,
      'workAreas', '[]'::jsonb,
      'resistanceEvents', '[]'::jsonb,
      'bargaining', '[]'::jsonb,
      'coalitions', '[]'::jsonb
    );
  end if;

  return workspace;
end;
$$;

-- public.transition_organizing_campaign: its definition from 20261014007000_unionground_lifecycle_writer_hardening.sql with this migration's edit.
create or replace function public.transition_organizing_campaign(
  p_campaign_id uuid,
  p_expected_revision integer,
  p_next_stage text,
  p_request_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  campaign record;
  receipt record;
  writer_kind text;
  normalized_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  request_fingerprint text;
  allowed boolean := false;
  event_time timestamptz;
  audit_id uuid;
begin
  if caller is null or p_campaign_id is null or p_request_id is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0 then
    raise exception 'campaign revision is required' using errcode = '22023';
  end if;
  if p_next_stage is null or p_next_stage not in (
    'lead', 'committee', 'cards', 'petition', 'election',
    'recognition', 'certification', 'bargaining',
    'first_contract', 'established'
  ) then
    raise exception 'unknown campaign stage' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_note, '')) > 1000 then
    raise exception 'campaign milestone note is too long' using errcode = '22023';
  end if;

  request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.jsonb_build_object(
        'operation', 'campaign.stage_changed',
        'campaignId', p_campaign_id,
        'expectedRevision', p_expected_revision,
        'nextStage', p_next_stage,
        'note', normalized_note
      )::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:mfa-reset:' || caller::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:'
      || caller::text || ':' || p_request_id::text,
      0
    )
  );

  if not private.lifecycle_can_operate_campaign(p_campaign_id) then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = p_campaign_id
  for update;

  if not found then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  writer_kind := private.lock_lifecycle_campaign_writer(campaign.id, campaign.chapter_id);
  if writer_kind is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'campaign.stage_changed'
       or receipt.entity_id <> campaign.id
       or receipt.request_fingerprint is distinct from request_fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', receipt.entity_id,
      'stage', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_revision then
    raise exception 'campaign changed; reload and try again' using errcode = '40001';
  end if;
  if campaign.status <> 'active' then
    raise exception 'campaign is not active' using errcode = '22023';
  end if;

  allowed := case
    when campaign.stage = 'lead' then p_next_stage = 'committee'
    when campaign.stage = 'committee' then p_next_stage = 'cards'
    when campaign.stage = 'cards' then
      (p_next_stage = 'petition' and campaign.representation_path in ('undecided', 'election'))
      or
      (p_next_stage = 'recognition' and campaign.representation_path in ('undecided', 'voluntary_recognition'))
    when campaign.stage = 'petition' then
      campaign.representation_path = 'election' and p_next_stage = 'election'
    when campaign.stage = 'election' then p_next_stage = 'certification'
    when campaign.stage = 'recognition' then
      campaign.representation_path = 'voluntary_recognition' and p_next_stage = 'bargaining'
    when campaign.stage = 'certification' then p_next_stage = 'bargaining'
    -- First-contract entry remains fail-closed until a typed, approved
    -- ratification record can be checked in this transaction.
    when campaign.stage = 'bargaining' then false
    when campaign.stage = 'first_contract' then p_next_stage = 'established'
    else false
  end;
  if not allowed then
    raise exception 'invalid campaign transition' using errcode = '22023';
  end if;

  if p_next_stage = 'bargaining'
     and not exists (
       select 1
       from public.organizing_bargaining_cycles b
       where b.campaign_id = campaign.id
         and b.chapter_id = campaign.chapter_id
         and b.bargaining_started_on is not null
         and b.phase in (
           'at_table', 'mediation', 'fact_finding', 'impasse',
           'tentative_agreement', 'ratification', 'execution', 'complete'
         )
     ) then
    raise exception 'verified bargaining start required' using errcode = '22023';
  end if;
  if p_next_stage = 'established'
     and not exists (
       select 1
       from public.organizing_bargaining_cycles b
       where b.campaign_id = campaign.id
         and b.chapter_id = campaign.chapter_id
         and b.phase = 'complete'
         and b.first_contract_signed_on is not null
     ) then
    raise exception 'signed first contract required' using errcode = '22023';
  end if;

  event_time := pg_catalog.clock_timestamp();

  update public.organizing_campaigns
  set stage = p_next_stage,
      representation_path = case
        when campaign.stage = 'cards' and p_next_stage = 'petition' then 'election'
        when campaign.stage = 'cards' and p_next_stage = 'recognition' then 'voluntary_recognition'
        else representation_path
      end,
      status = case when p_next_stage = 'established' then 'closed' else status end,
      outcome = case when p_next_stage = 'established' then 'established' else outcome end,
      outcome_reason = case when p_next_stage = 'established' then null else outcome_reason end,
      closed_at = case when p_next_stage = 'established' then event_time else closed_at end,
      stage_started_at = event_time,
      revision = revision + 1
  where id = campaign.id;

  insert into public.organizing_stage_events (
    campaign_id,
    chapter_id,
    from_stage,
    to_stage,
    actor_id,
    note,
    occurred_at
  ) values (
    campaign.id,
    campaign.chapter_id,
    campaign.stage,
    p_next_stage,
    caller,
    normalized_note,
    event_time
  );

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    reason,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'campaign.stage_changed',
    'organizing_campaign',
    campaign.id,
    campaign.stage,
    p_next_stage,
    normalized_note,
    p_request_id,
    request_fingerprint,
    campaign.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'stage', p_next_stage,
    'revision', campaign.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.set_organizing_campaign_status: its definition from 20261014007000_unionground_lifecycle_writer_hardening.sql with this migration's edit.
create or replace function public.set_organizing_campaign_status(
  p_campaign_id uuid,
  p_expected_revision integer,
  p_status text,
  p_request_id uuid,
  p_outcome text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  campaign record;
  receipt record;
  writer_kind text;
  normalized_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  request_fingerprint text;
  event_time timestamptz;
  audit_id uuid;
begin
  if caller is null or p_campaign_id is null or p_request_id is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0 then
    raise exception 'campaign revision is required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('active', 'paused', 'closed') then
    raise exception 'unknown campaign status' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_reason, '')) > 1000 then
    raise exception 'campaign status reason is too long' using errcode = '22023';
  end if;
  if p_status = 'closed' then
    if p_outcome is null or p_outcome not in ('withdrawn', 'lost', 'other') then
      raise exception 'closed campaign outcome required' using errcode = '22023';
    end if;
    if normalized_reason is null then
      raise exception 'closed campaign reason required' using errcode = '22023';
    end if;
  elsif p_outcome is not null then
    raise exception 'outcome is only valid when closing' using errcode = '22023';
  end if;

  request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.jsonb_build_object(
        'operation', 'campaign.status_changed',
        'campaignId', p_campaign_id,
        'expectedRevision', p_expected_revision,
        'status', p_status,
        'outcome', p_outcome,
        'reason', normalized_reason
      )::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:mfa-reset:' || caller::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:'
      || caller::text || ':' || p_request_id::text,
      0
    )
  );

  if not private.lifecycle_can_operate_campaign(p_campaign_id) then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = p_campaign_id
  for update;

  if not found then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  writer_kind := private.lock_lifecycle_campaign_writer(campaign.id, campaign.chapter_id);
  if writer_kind is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'campaign.status_changed'
       or receipt.entity_id <> campaign.id
       or receipt.request_fingerprint is distinct from request_fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', receipt.entity_id,
      'status', receipt.to_state,
      'outcome', receipt.safe_metadata ->> 'outcome',
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_revision then
    raise exception 'campaign changed; reload and try again' using errcode = '40001';
  end if;
  if campaign.status = 'closed' then
    raise exception 'closed campaign cannot be changed' using errcode = '22023';
  end if;
  if campaign.status = p_status then
    raise exception 'campaign already has that status' using errcode = '22023';
  end if;
  if not (
    (campaign.status = 'active' and p_status in ('paused', 'closed'))
    or
    (campaign.status = 'paused' and p_status in ('active', 'closed'))
  ) then
    raise exception 'invalid campaign status transition' using errcode = '22023';
  end if;
  if p_status = 'closed' and writer_kind <> 'coordinator' then
    raise exception 'coordinator role required to close a campaign' using errcode = '42501';
  end if;

  event_time := pg_catalog.clock_timestamp();

  update public.organizing_campaigns
  set status = p_status,
      outcome = case when p_status = 'closed' then p_outcome else null end,
      outcome_reason = case when p_status = 'closed' then normalized_reason else null end,
      closed_at = case when p_status = 'closed' then event_time else null end,
      revision = revision + 1
  where id = campaign.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    reason,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'campaign.status_changed',
    'organizing_campaign',
    campaign.id,
    campaign.status,
    p_status,
    normalized_reason,
    pg_catalog.jsonb_build_object(
      'outcome',
      case when p_status = 'closed' then p_outcome else null end
    ),
    p_request_id,
    request_fingerprint,
    campaign.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'status', p_status,
    'outcome', case when p_status = 'closed' then p_outcome else null end,
    'revision', campaign.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.record_resistance_incident: its definition from 20261014007000_unionground_lifecycle_writer_hardening.sql with this migration's edit.
create or replace function public.record_resistance_incident(
  p_campaign_id uuid,
  p_title text,
  p_category text,
  p_severity text,
  p_summary text,
  p_request_id uuid,
  p_source_kind text,
  p_occurred_on date default null,
  p_next_deadline_at timestamptz default null,
  p_consider_legal_review boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  campaign record;
  receipt record;
  writer_kind text;
  normalized_title text := pg_catalog.btrim(coalesce(p_title, ''));
  normalized_summary text := pg_catalog.btrim(coalesce(p_summary, ''));
  request_fingerprint text;
  incident_id uuid;
  incident_reference text;
  legal_review_status text;
  event_time timestamptz;
  audit_id uuid;
begin
  if caller is null or p_campaign_id is null or p_request_id is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if pg_catalog.char_length(normalized_title) not between 3 and 180
     or pg_catalog.char_length(normalized_summary) not between 3 and 4000 then
    raise exception 'incident fields are invalid' using errcode = '22023';
  end if;
  if p_category is null or p_category not in (
    'surveillance', 'interrogation', 'threat', 'captive_audience',
    'retaliation', 'discipline', 'discharge', 'delay',
    'unilateral_change', 'other'
  ) then
    raise exception 'incident category is invalid' using errcode = '22023';
  end if;
  if p_severity is null or p_severity not in ('monitor', 'standard', 'high', 'immediate') then
    raise exception 'incident urgency is invalid' using errcode = '22023';
  end if;
  if p_source_kind is null or p_source_kind not in (
    'worker_report', 'steward_report', 'organizer_note',
    'bargaining_record', 'document', 'other'
  ) then
    raise exception 'incident source is invalid' using errcode = '22023';
  end if;
  if p_occurred_on is not null and p_occurred_on > current_date then
    raise exception 'incident date cannot be in the future' using errcode = '22023';
  end if;
  if p_consider_legal_review is null then
    raise exception 'legal review choice is required' using errcode = '22023';
  end if;

  legal_review_status := case
    when p_consider_legal_review then 'consider_review'
    else 'not_requested'
  end;

  request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.jsonb_build_object(
        'operation', 'resistance.reported',
        'campaignId', p_campaign_id,
        'title', normalized_title,
        'category', p_category,
        'severity', p_severity,
        'summary', normalized_summary,
        'sourceKind', p_source_kind,
        'occurredOn', p_occurred_on,
        'nextDeadlineAt', p_next_deadline_at,
        'considerLegalReview', p_consider_legal_review
      )::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:mfa-reset:' || caller::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:'
      || caller::text || ':' || p_request_id::text,
      0
    )
  );

  if not private.lifecycle_can_operate_campaign(p_campaign_id) then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = p_campaign_id
  for update;

  if not found then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  writer_kind := private.lock_lifecycle_campaign_writer(campaign.id, campaign.chapter_id);
  if writer_kind is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'resistance.reported'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from request_fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'incidentId', receipt.entity_id,
      'reference', receipt.safe_metadata ->> 'reference',
      'status', receipt.to_state,
      'legalReviewStatus', receipt.safe_metadata ->> 'legalReviewStatus',
      'auditEventId', receipt.id
    );
  end if;

  if campaign.status = 'closed' then
    raise exception 'closed campaign cannot receive incident reports' using errcode = '22023';
  end if;

  event_time := pg_catalog.clock_timestamp();
  incident_reference := 'ER-' || pg_catalog.to_char(event_time, 'YYYY') || '-' ||
    pg_catalog.upper(
      pg_catalog.substr(
        pg_catalog.replace(extensions.gen_random_uuid()::text, '-', ''),
        1,
        8
      )
    );

  insert into public.organizing_resistance_incidents (
    campaign_id,
    chapter_id,
    reference,
    title,
    category,
    severity,
    factual_summary,
    occurred_on,
    source_kind,
    legal_review_status,
    next_deadline_at,
    owner_id,
    created_by,
    create_request_id,
    created_at,
    updated_at
  ) values (
    campaign.id,
    campaign.chapter_id,
    incident_reference,
    normalized_title,
    p_category,
    p_severity,
    normalized_summary,
    p_occurred_on,
    p_source_kind,
    legal_review_status,
    p_next_deadline_at,
    caller,
    caller,
    p_request_id,
    event_time,
    event_time
  ) returning id into incident_id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'resistance.reported',
    'resistance_incident',
    incident_id,
    'reported',
    pg_catalog.jsonb_build_object(
      'reference', incident_reference,
      'category', p_category,
      'severity', p_severity,
      'sourceKind', p_source_kind,
      'legalReviewStatus', legal_review_status
    ),
    p_request_id,
    request_fingerprint,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'incidentId', incident_id,
    'reference', incident_reference,
    'status', 'reported',
    'legalReviewStatus', legal_review_status,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.open_organizing_bargaining_cycle: its definition from 20261014008000_unionground_bargaining_writers.sql with this migration's edit.
create or replace function public.open_organizing_bargaining_cycle(
  p_campaign_id uuid,
  p_expected_campaign_revision integer,
  p_title text,
  p_request_id uuid,
  p_target_first_contract_on date default null,
  p_next_action text default null,
  p_next_deadline_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  campaign record;
  receipt record;
  cycle_id uuid;
  fingerprint text;
  audit_id uuid;
  normalized_title text := pg_catalog.btrim(coalesce(p_title, ''));
  normalized_next_action text := nullif(pg_catalog.btrim(coalesce(p_next_action, '')), '');
begin
  if caller is null or p_campaign_id is null or p_request_id is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if p_expected_campaign_revision is null or p_expected_campaign_revision <= 0 then
    raise exception 'campaign revision is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(normalized_title) not between 3 and 160 then
    raise exception 'cycle title is invalid' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_next_action, '')) > 600 then
    raise exception 'next action is too long' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.cycle.opened',
    pg_catalog.jsonb_build_object(
      'campaignId', p_campaign_id,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'title', normalized_title,
      'targetFirstContractOn', p_target_first_contract_on,
      'nextAction', normalized_next_action,
      'nextDeadlineAt', private.bargaining_canonical_instant(p_next_deadline_at)
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select *
  into campaign
  from public.organizing_campaigns
  where id = p_campaign_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.cycle.opened'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision', (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'cycleId', receipt.entity_id,
      'phase', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_campaign_revision then
    raise exception 'campaign changed; reload and try again' using errcode = '40001';
  end if;
  if campaign.status <> 'active'
     or campaign.stage not in ('recognition', 'certification', 'bargaining') then
    raise exception 'campaign is not ready for bargaining' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.organizing_bargaining_cycles c
    where c.campaign_id = campaign.id
  ) then
    raise exception 'bargaining cycle already exists' using errcode = '22023';
  end if;

  insert into public.organizing_bargaining_cycles (
    campaign_id,
    chapter_id,
    title,
    phase,
    target_first_contract_on,
    next_action,
    next_deadline_at,
    lead_id,
    created_by
  ) values (
    campaign.id,
    campaign.chapter_id,
    normalized_title,
    'preparing',
    p_target_first_contract_on,
    normalized_next_action,
    p_next_deadline_at,
    caller,
    caller
  ) returning id into cycle_id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.cycle.opened',
    'bargaining_cycle',
    cycle_id,
    'preparing',
    pg_catalog.jsonb_build_object(
      'campaignRevision',
      campaign.revision
    ),
    p_request_id,
    fingerprint,
    1
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign.revision,
    'cycleId', cycle_id,
    'phase', 'preparing',
    'revision', 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.transition_organizing_bargaining_cycle: its definition from 20261014008000_unionground_bargaining_writers.sql with this migration's edit.
create or replace function public.transition_organizing_bargaining_cycle(
  p_cycle_id uuid,
  p_expected_revision integer,
  p_expected_campaign_revision integer,
  p_next_phase text,
  p_request_id uuid,
  p_effective_on date default null,
  p_reason text default null,
  p_next_action text default null,
  p_next_deadline_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  receipt record;
  fingerprint text;
  allowed boolean;
  campaign_revision integer;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  normalized_next_action text := nullif(pg_catalog.btrim(coalesce(p_next_action, '')), '');
begin
  if caller is null or p_cycle_id is null or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0
     or p_expected_campaign_revision is null
     or p_expected_campaign_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if p_next_phase is null or p_next_phase not in (
    'preparing',
    'proposal_development',
    'at_table',
    'mediation',
    'fact_finding',
    'impasse',
    'tentative_agreement',
    'ratification',
    'execution',
    'complete'
  ) then
    raise exception 'unknown bargaining phase' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_reason, '')) > 1000
     or pg_catalog.char_length(coalesce(normalized_next_action, '')) > 600 then
    raise exception 'cycle text is too long' using errcode = '22023';
  end if;
  if p_effective_on is not null and p_effective_on > current_date then
    raise exception 'bargaining start cannot be in the future' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.cycle.transitioned',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedRevision', p_expected_revision,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'nextPhase', p_next_phase,
      'effectiveOn', p_effective_on,
      'reason', normalized_reason,
      'nextAction', normalized_next_action,
      'nextDeadlineAt', private.bargaining_canonical_instant(p_next_deadline_at)
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.cycle.transitioned'
       or receipt.entity_id <> cycle.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision', (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'cycleId', cycle.id,
      'phase', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_campaign_revision
     or cycle.revision <> p_expected_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = '40001';
  end if;
  if campaign.status <> 'active' then
    raise exception 'campaign is not active' using errcode = '22023';
  end if;

  allowed := case
    when cycle.phase = 'preparing' then
      p_next_phase = 'proposal_development'
    when cycle.phase = 'proposal_development' then
      p_next_phase = 'at_table'
    when cycle.phase = 'at_table' then
      p_next_phase in (
        'mediation',
        'fact_finding',
        'impasse',
        'tentative_agreement'
      )
    when cycle.phase in ('mediation', 'fact_finding', 'impasse') then
      p_next_phase in ('at_table', 'tentative_agreement')
    when cycle.phase = 'tentative_agreement' then
      p_next_phase in ('at_table', 'ratification')
    when cycle.phase = 'ratification' then
      p_next_phase = 'at_table'
    else false
  end;

  if not allowed or p_next_phase in ('execution', 'complete') then
    raise exception 'invalid bargaining phase transition' using errcode = '22023';
  end if;

  if cycle.phase = 'ratification' and p_next_phase = 'at_table' then
    if normalized_reason is null then
      raise exception 'ratification rollback reason is required'
        using errcode = '22023';
    end if;
    if private.lock_bargaining_campaign_writer(
         campaign.id,
         campaign.chapter_id,
         true
       ) is null then
      raise exception 'coordinator role required for ratification rollback'
        using errcode = '42501';
    end if;
    if exists (
         select 1
         from public.organizing_bargaining_ratifications current_result
         where current_result.id = cycle.current_ratification_id
           and current_result.cycle_id = cycle.id
           and current_result.execution_authorized
       )
       or exists (
         select 1
         from public.organizing_first_contracts contract
         where contract.cycle_id = cycle.id
       ) then
      raise exception 'authorized ratification cannot be rolled back'
        using errcode = '22023';
    end if;
  end if;

  if cycle.bargaining_started_on is null
     and p_next_phase = 'at_table'
     and p_effective_on is null then
    raise exception 'verified bargaining start date is required'
      using errcode = '22023';
  end if;

  if p_next_phase in ('tentative_agreement', 'ratification')
     and not exists (
       select 1
       from public.organizing_bargaining_proposals p
       where p.cycle_id = cycle.id
         and p.campaign_id = campaign.id
         and p.chapter_id = campaign.chapter_id
         and p.record_kind = 'agreement_package'
         and p.status = 'tentative_agreement'
         and p.document_sha256 is not null
         and not exists (
           select 1
           from public.organizing_bargaining_proposals child
           where child.parent_proposal_id = p.id
         )
         and not exists (
           select 1
           from pg_catalog.unnest(p.included_proposal_ids) included_id
           left join public.organizing_bargaining_proposals included
             on included.id = included_id
            and included.cycle_id = cycle.id
            and included.campaign_id = campaign.id
            and included.chapter_id = campaign.chapter_id
            and included.record_kind = 'article'
           where included.id is null
              or included.status <> 'accepted'
              or included.presented_on is null
              or included.presented_on > p.presented_on
              or exists (
                select 1
                from public.organizing_bargaining_proposals child
                where child.parent_proposal_id = included.id
              )
         )
         and not exists (
           select 1
           from public.organizing_bargaining_proposals current_article
           where current_article.cycle_id = cycle.id
             and current_article.campaign_id = campaign.id
             and current_article.chapter_id = campaign.chapter_id
             and current_article.record_kind = 'article'
             and current_article.status = 'accepted'
             and not exists (
               select 1
               from public.organizing_bargaining_proposals child
               where child.parent_proposal_id = current_article.id
             )
             and not (current_article.id = any(p.included_proposal_ids))
         )
         and not exists (
           select 1
           from public.organizing_bargaining_proposals unresolved_article
           where unresolved_article.cycle_id = cycle.id
             and unresolved_article.campaign_id = campaign.id
             and unresolved_article.chapter_id = campaign.chapter_id
             and unresolved_article.record_kind = 'article'
             and unresolved_article.status not in (
               'accepted',
               'rejected',
               'withdrawn',
               'superseded'
             )
             and not exists (
               select 1
               from public.organizing_bargaining_proposals child
               where child.parent_proposal_id = unresolved_article.id
             )
         )
     ) then
    raise exception 'current tentative-agreement proposal required'
      using errcode = '22023';
  end if;

  if cycle.bargaining_started_on is null
     and p_next_phase = 'at_table'
     and campaign.stage not in ('recognition', 'certification', 'bargaining') then
    raise exception 'campaign is not ready for bargaining' using errcode = '22023';
  end if;

  update public.organizing_bargaining_cycles
  set phase = p_next_phase,
      bargaining_started_on = case
        when cycle.bargaining_started_on is null and p_next_phase = 'at_table'
          then p_effective_on
        else cycle.bargaining_started_on
      end,
      next_action = normalized_next_action,
      next_deadline_at = p_next_deadline_at,
      revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  campaign_revision := campaign.revision;
  if cycle.bargaining_started_on is null
     and p_next_phase = 'at_table'
     and campaign.stage in ('recognition', 'certification') then
    update public.organizing_campaigns
    set stage = 'bargaining',
        stage_started_at = event_time,
        revision = campaign.revision + 1,
        updated_at = event_time
    where id = campaign.id;

    insert into public.organizing_stage_events (
      campaign_id,
      chapter_id,
      from_stage,
      to_stage,
      actor_id,
      source_kind,
      note,
      occurred_at
    ) values (
      campaign.id,
      campaign.chapter_id,
      campaign.stage,
      'bargaining',
      caller,
      'staff_verified',
      'Verified bargaining start recorded',
      event_time
    );

    campaign_revision := campaign.revision + 1;
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    reason,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.cycle.transitioned',
    'bargaining_cycle',
    cycle.id,
    cycle.phase,
    p_next_phase,
    normalized_reason,
    pg_catalog.jsonb_build_object(
      'campaignRevision',
      campaign_revision
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign_revision,
    'cycleId', cycle.id,
    'phase', p_next_phase,
    'revision', cycle.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.create_organizing_bargaining_proposal: its definition from 20261014008000_unionground_bargaining_writers.sql with this migration's edit.
create or replace function public.create_organizing_bargaining_proposal(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_topic text,
  p_title text,
  p_side text,
  p_request_id uuid,
  p_record_kind text default 'article',
  p_included_proposal_ids uuid[] default '{}'::uuid[],
  p_document_sha256 text default null,
  p_parent_proposal_id uuid default null,
  p_parent_expected_revision integer default null,
  p_relation_kind text default null,
  p_member_summary text default null,
  p_internal_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  parent record;
  receipt record;
  proposal_id uuid;
  proposal_version integer := 1;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_topic text := pg_catalog.btrim(coalesce(p_topic, ''));
  normalized_title text := pg_catalog.btrim(coalesce(p_title, ''));
  normalized_member_summary text := nullif(pg_catalog.btrim(coalesce(p_member_summary, '')), '');
  normalized_internal_notes text := nullif(pg_catalog.btrim(coalesce(p_internal_notes, '')), '');
  normalized_included_ids uuid[] := coalesce(p_included_proposal_ids, '{}'::uuid[]);
  normalized_document_sha text := nullif(
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_document_sha256, ''))),
    ''
  );
begin
  if caller is null or p_cycle_id is null or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null or p_expected_cycle_revision <= 0 then
    raise exception 'cycle revision is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(normalized_topic) not between 1 and 120
     or pg_catalog.char_length(normalized_title) not between 3 and 200
     or pg_catalog.char_length(coalesce(normalized_member_summary, '')) > 2000
     or pg_catalog.char_length(coalesce(normalized_internal_notes, '')) > 12000 then
    raise exception 'proposal fields are invalid' using errcode = '22023';
  end if;
  if p_side is null or p_side not in ('union', 'employer', 'joint') then
    raise exception 'proposal side is invalid' using errcode = '22023';
  end if;
  if p_record_kind is null or p_record_kind not in ('article', 'agreement_package')
     or pg_catalog.array_position(normalized_included_ids, null) is not null
     or (
       select pg_catalog.count(*) <> pg_catalog.count(distinct item)
       from pg_catalog.unnest(normalized_included_ids) item
     )
     or (
       p_record_kind = 'article'
       and (
         pg_catalog.cardinality(normalized_included_ids) <> 0
         or normalized_document_sha is not null
       )
     )
     or (
       p_record_kind = 'agreement_package'
       and (
         pg_catalog.cardinality(normalized_included_ids) = 0
         or normalized_document_sha is null
         or normalized_document_sha !~ '^[0-9a-f]{64}$'
       )
     ) then
    raise exception 'proposal record shape is invalid' using errcode = '22023';
  end if;
  if (
    p_parent_proposal_id is null
    and (
      p_parent_expected_revision is not null
      or p_relation_kind is not null
    )
  ) or (
    p_parent_proposal_id is not null
    and (
      p_parent_expected_revision is null
      or p_parent_expected_revision <= 0
      or p_relation_kind is null
      or p_relation_kind not in ('revision', 'counter', 'replacement')
    )
  ) then
    raise exception 'proposal lineage is invalid' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.proposal.created',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'topic', normalized_topic,
      'title', normalized_title,
      'side', p_side,
      'recordKind', p_record_kind,
      'includedProposalIds', normalized_included_ids,
      'documentSha256', normalized_document_sha,
      'parentProposalId', p_parent_proposal_id,
      'parentExpectedRevision', p_parent_expected_revision,
      'relationKind', p_relation_kind,
      'memberSummary', normalized_member_summary,
      'internalNotes', normalized_internal_notes
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  if p_parent_proposal_id is not null then
    select *
    into parent
    from public.organizing_bargaining_proposals
    where id = p_parent_proposal_id
      and cycle_id = cycle.id
      and campaign_id = campaign.id
      and chapter_id = campaign.chapter_id
    for update;

    if not found then
      raise exception 'bargaining cycle not found' using errcode = '22023';
    end if;
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.proposal.created'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'cycleRevision', (receipt.safe_metadata ->> 'cycleRevision')::integer,
      'proposalId', receipt.entity_id,
      'recordKind', receipt.safe_metadata ->> 'recordKind',
      'version', (receipt.safe_metadata ->> 'version')::integer,
      'status', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining cycle changed; reload and try again'
      using errcode = '40001';
  end if;
  if campaign.status <> 'active'
     or cycle.phase in ('ratification', 'execution', 'complete') then
    raise exception 'bargaining cycle is not editable' using errcode = '22023';
  end if;

  if p_record_kind = 'agreement_package'
     and (
       (
         select pg_catalog.count(*) <> pg_catalog.cardinality(normalized_included_ids)
         from public.organizing_bargaining_proposals included
         where included.id = any(normalized_included_ids)
           and included.cycle_id = cycle.id
           and included.campaign_id = campaign.id
           and included.chapter_id = campaign.chapter_id
           and included.record_kind = 'article'
           and included.status = 'accepted'
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = included.id
           )
          )
       or exists (
         select 1
         from public.organizing_bargaining_proposals current_article
         where current_article.cycle_id = cycle.id
           and current_article.campaign_id = campaign.id
           and current_article.chapter_id = campaign.chapter_id
           and current_article.record_kind = 'article'
           and current_article.status = 'accepted'
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = current_article.id
           )
           and not (current_article.id = any(normalized_included_ids))
       )
       or exists (
         select 1
         from public.organizing_bargaining_proposals unresolved_article
         where unresolved_article.cycle_id = cycle.id
           and unresolved_article.campaign_id = campaign.id
           and unresolved_article.chapter_id = campaign.chapter_id
           and unresolved_article.record_kind = 'article'
           and unresolved_article.status not in (
             'accepted',
             'rejected',
             'withdrawn',
             'superseded'
           )
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = unresolved_article.id
           )
       )
     ) then
    raise exception 'agreement package contains an ineligible proposal version'
      using errcode = '22023';
  end if;

  if p_parent_proposal_id is not null then
    if parent.revision <> p_parent_expected_revision then
      raise exception 'proposal changed; reload and try again' using errcode = '40001';
    end if;
    if parent.status in ('rejected', 'withdrawn', 'superseded')
       or (
         parent.status = 'accepted'
         and not (
           parent.record_kind = 'article'
           and p_relation_kind = 'replacement'
           and cycle.phase in (
             'at_table',
             'mediation',
             'fact_finding',
             'impasse'
           )
         )
       )
       or parent.record_kind <> p_record_kind
       or exists (
         select 1
         from public.organizing_bargaining_proposals child
         where child.parent_proposal_id = parent.id
       ) then
      raise exception 'proposal lineage is closed' using errcode = '22023';
    end if;
    proposal_version := parent.version + 1;
  end if;

  insert into public.organizing_bargaining_proposals (
    cycle_id,
    campaign_id,
    chapter_id,
    parent_proposal_id,
    relation_kind,
    record_kind,
    included_proposal_ids,
    document_sha256,
    topic,
    title,
    side,
    status,
    version,
    revision,
    member_summary,
    internal_notes,
    create_request_id,
    created_by,
    created_at,
    updated_at
  ) values (
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    p_parent_proposal_id,
    p_relation_kind,
    p_record_kind,
    normalized_included_ids,
    normalized_document_sha,
    normalized_topic,
    normalized_title,
    p_side,
    'draft',
    proposal_version,
    1,
    normalized_member_summary,
    normalized_internal_notes,
    p_request_id,
    caller,
    event_time,
    event_time
  ) returning id into proposal_id;

  if p_parent_proposal_id is not null then
    update public.organizing_bargaining_proposals
    set status = 'superseded',
        revision = parent.revision + 1,
        updated_at = event_time
    where id = parent.id;
  end if;

  update public.organizing_bargaining_cycles
  set revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.proposal.created',
    'bargaining_proposal',
    proposal_id,
    'draft',
    pg_catalog.jsonb_build_object(
      'cycleRevision',
      cycle.revision + 1,
      'recordKind',
      p_record_kind,
      'version',
      proposal_version
    ),
    p_request_id,
    fingerprint,
    1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'cycleRevision', cycle.revision + 1,
    'proposalId', proposal_id,
    'recordKind', p_record_kind,
    'version', proposal_version,
    'status', 'draft',
    'revision', 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.transition_organizing_bargaining_proposal: its definition from 20261014008000_unionground_bargaining_writers.sql with this migration's edit.
create or replace function public.transition_organizing_bargaining_proposal(
  p_proposal_id uuid,
  p_expected_revision integer,
  p_expected_cycle_revision integer,
  p_next_status text,
  p_request_id uuid,
  p_presented_on date default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  proposal record;
  receipt record;
  fingerprint text;
  allowed boolean;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
begin
  if caller is null or p_proposal_id is null or p_request_id is null then
    raise exception 'proposal not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0
     or p_expected_cycle_revision is null
     or p_expected_cycle_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if p_next_status is null or p_next_status not in (
    'approved',
    'presented',
    'countered',
    'tentative_agreement',
    'accepted',
    'rejected',
    'withdrawn'
  ) then
    raise exception 'unknown proposal status' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_reason, '')) > 2000 then
    raise exception 'proposal reason is too long' using errcode = '22023';
  end if;
  if p_presented_on is not null and p_presented_on > current_date then
    raise exception 'presentation date cannot be in the future' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.proposal.transitioned',
    pg_catalog.jsonb_build_object(
      'proposalId', p_proposal_id,
      'expectedRevision', p_expected_revision,
      'expectedCycleRevision', p_expected_cycle_revision,
      'nextStatus', p_next_status,
      'presentedOn', p_presented_on,
      'reason', normalized_reason
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select p.cycle_id, p.campaign_id, p.chapter_id
  into target
  from public.organizing_bargaining_proposals p
  where p.id = p_proposal_id;

  if not found then
    raise exception 'proposal not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = target.cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into proposal
  from public.organizing_bargaining_proposals
  where id = p_proposal_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'proposal not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.proposal.transitioned'
       or receipt.entity_id <> proposal.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'cycleRevision', (receipt.safe_metadata ->> 'cycleRevision')::integer,
      'proposalId', proposal.id,
      'status', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision
     or proposal.revision <> p_expected_revision then
    raise exception 'proposal changed; reload and try again' using errcode = '40001';
  end if;
  if campaign.status <> 'active'
     or cycle.phase in ('ratification', 'execution', 'complete')
     or exists (
       select 1
       from public.organizing_bargaining_proposals child
       where child.parent_proposal_id = proposal.id
     ) then
    raise exception 'proposal is not editable' using errcode = '22023';
  end if;

  allowed := case
    when proposal.status = 'draft' then
      p_next_status in ('approved', 'withdrawn')
    when proposal.status = 'approved' then
      p_next_status in ('presented', 'withdrawn')
    when proposal.status = 'presented' then
      p_next_status in (
        'countered',
        'tentative_agreement',
        'accepted',
        'rejected',
        'withdrawn'
      )
    when proposal.status = 'countered' then
      p_next_status in (
        'tentative_agreement',
        'accepted',
        'rejected',
        'withdrawn'
      )
    when proposal.status = 'tentative_agreement' then
      p_next_status = 'withdrawn'
    else false
  end;

  if proposal.record_kind = 'agreement_package'
     and p_next_status in ('accepted', 'rejected') then
    allowed := false;
  end if;
  if proposal.record_kind = 'article'
     and p_next_status = 'tentative_agreement' then
    allowed := false;
  end if;

  if not allowed then
    raise exception 'invalid proposal transition' using errcode = '22023';
  end if;
  if p_presented_on is not null
     and p_next_status not in (
       'presented',
       'countered',
       'tentative_agreement',
       'accepted',
       'rejected'
     ) then
    raise exception 'presentation date is not valid for this transition'
      using errcode = '22023';
  end if;
  if p_next_status in (
       'presented',
       'countered',
       'tentative_agreement',
       'accepted',
       'rejected'
     )
     and proposal.presented_on is null
     and p_presented_on is null then
    raise exception 'presentation date is required' using errcode = '22023';
  end if;
  if p_next_status in (
       'presented',
       'countered',
       'tentative_agreement',
       'accepted',
       'rejected'
     )
     and (
       cycle.bargaining_started_on is null
       or cycle.phase not in (
         'at_table',
         'mediation',
         'fact_finding',
         'impasse',
         'tentative_agreement'
       )
       or coalesce(proposal.presented_on, p_presented_on)
          < cycle.bargaining_started_on
     ) then
    raise exception 'formal proposal status requires active bargaining chronology'
      using errcode = '22023';
  end if;
  if p_next_status = 'tentative_agreement'
     and (
       proposal.record_kind <> 'agreement_package'
       or nullif(pg_catalog.btrim(coalesce(proposal.member_summary, '')), '') is null
       or exists (
         select 1
         from pg_catalog.unnest(proposal.included_proposal_ids) included_id
         left join public.organizing_bargaining_proposals included
           on included.id = included_id
          and included.cycle_id = cycle.id
          and included.campaign_id = campaign.id
          and included.chapter_id = campaign.chapter_id
          and included.record_kind = 'article'
         where included.id is null
            or included.status <> 'accepted'
            or included.presented_on is null
            or included.presented_on > coalesce(
              proposal.presented_on,
              p_presented_on
            )
            or exists (
              select 1
              from public.organizing_bargaining_proposals child
              where child.parent_proposal_id = included.id
            )
       )
       or exists (
         select 1
         from public.organizing_bargaining_proposals current_article
         where current_article.cycle_id = cycle.id
           and current_article.campaign_id = campaign.id
           and current_article.chapter_id = campaign.chapter_id
           and current_article.record_kind = 'article'
           and current_article.status = 'accepted'
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = current_article.id
           )
           and not (
             current_article.id = any(proposal.included_proposal_ids)
           )
       )
       or exists (
         select 1
         from public.organizing_bargaining_proposals unresolved_article
         where unresolved_article.cycle_id = cycle.id
           and unresolved_article.campaign_id = campaign.id
           and unresolved_article.chapter_id = campaign.chapter_id
           and unresolved_article.record_kind = 'article'
           and unresolved_article.status not in (
             'accepted',
             'rejected',
             'withdrawn',
             'superseded'
           )
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = unresolved_article.id
           )
       )
     ) then
    raise exception 'tentative agreement requires a whole agreement package and member-safe summary'
      using errcode = '22023';
  end if;

  update public.organizing_bargaining_proposals
  set status = p_next_status,
      presented_on = coalesce(proposal.presented_on, p_presented_on),
      revision = proposal.revision + 1,
      updated_at = event_time
  where id = proposal.id;

  update public.organizing_bargaining_cycles
  set revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.proposal.transitioned',
    'bargaining_proposal',
    proposal.id,
    proposal.status,
    p_next_status,
    pg_catalog.jsonb_build_object(
      'cycleRevision',
      cycle.revision + 1
    ),
    p_request_id,
    fingerprint,
    proposal.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'cycleRevision', cycle.revision + 1,
    'proposalId', proposal.id,
    'status', p_next_status,
    'revision', proposal.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.schedule_organizing_bargaining_session: its definition from 20261014008000_unionground_bargaining_writers.sql with this migration's edit.
create or replace function public.schedule_organizing_bargaining_session(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_starts_at timestamptz,
  p_request_id uuid,
  p_location text default null,
  p_agenda text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  receipt record;
  session_id uuid;
  next_session_number integer;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_location text := nullif(pg_catalog.btrim(coalesce(p_location, '')), '');
  normalized_agenda text := nullif(pg_catalog.btrim(coalesce(p_agenda, '')), '');
begin
  if caller is null or p_cycle_id is null or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null or p_expected_cycle_revision <= 0 then
    raise exception 'cycle revision is required' using errcode = '22023';
  end if;
  if p_starts_at is null then
    raise exception 'session start is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_location, '')) > 240
     or pg_catalog.char_length(coalesce(normalized_agenda, '')) > 12000 then
    raise exception 'session fields are invalid' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.session.scheduled',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'startsAt', private.bargaining_canonical_instant(p_starts_at),
      'location', normalized_location,
      'agenda', normalized_agenda
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.session.scheduled'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'cycleRevision', (receipt.safe_metadata ->> 'cycleRevision')::integer,
      'sessionId', receipt.entity_id,
      'sessionNumber', (receipt.safe_metadata ->> 'sessionNumber')::integer,
      'status', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining cycle changed; reload and try again'
      using errcode = '40001';
  end if;
  if campaign.status <> 'active' or cycle.phase = 'complete' then
    raise exception 'bargaining cycle is not editable' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.max(s.session_number), 0) + 1
  into next_session_number
  from public.organizing_bargaining_sessions s
  where s.cycle_id = cycle.id;

  insert into public.organizing_bargaining_sessions (
    cycle_id,
    campaign_id,
    chapter_id,
    session_number,
    starts_at,
    location,
    status,
    agenda,
    member_update,
    revision,
    create_request_id,
    created_by,
    created_at,
    updated_at
  ) values (
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    next_session_number,
    p_starts_at,
    normalized_location,
    'scheduled',
    normalized_agenda,
    '',
    1,
    p_request_id,
    caller,
    event_time,
    event_time
  ) returning id into session_id;

  update public.organizing_bargaining_cycles
  set revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.session.scheduled',
    'bargaining_session',
    session_id,
    'scheduled',
    pg_catalog.jsonb_build_object(
      'cycleRevision',
      cycle.revision + 1,
      'sessionNumber',
      next_session_number
    ),
    p_request_id,
    fingerprint,
    1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'cycleRevision', cycle.revision + 1,
    'sessionId', session_id,
    'sessionNumber', next_session_number,
    'status', 'scheduled',
    'revision', 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.record_organizing_first_contract: its definition from 20261014008000_unionground_bargaining_writers.sql with this migration's edit.
create or replace function public.record_organizing_first_contract(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_expected_campaign_revision integer,
  p_ratification_id uuid,
  p_agreement_sha256 text,
  p_signed_on date,
  p_request_id uuid,
  p_source_kind text,
  p_source_reference text,
  p_source_sha256 text,
  p_expected_signatory_count integer,
  p_verified_signatory_count integer,
  p_effective_on date default null,
  p_expires_on date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  ratification record;
  receipt record;
  contract_id uuid;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_agreement_sha text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_agreement_sha256, '')));
  normalized_source_reference text := pg_catalog.btrim(coalesce(p_source_reference, ''));
  normalized_source_sha text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source_sha256, '')));
begin
  if caller is null
     or p_cycle_id is null
     or p_ratification_id is null
     or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null or p_expected_cycle_revision <= 0
     or p_expected_campaign_revision is null
     or p_expected_campaign_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if normalized_agreement_sha !~ '^[0-9a-f]{64}$'
     or normalized_source_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence hashes must be lowercase SHA-256 values'
      using errcode = '22023';
  end if;
  if p_signed_on is null or p_signed_on > current_date then
    raise exception 'signature date is invalid' using errcode = '22023';
  end if;
  if p_expires_on is not null
     and (
       p_expires_on < p_signed_on
       or (
         p_effective_on is not null
         and p_expires_on < p_effective_on
       )
     ) then
    raise exception 'expiration cannot precede signature or effective date'
      using errcode = '22023';
  end if;
  if p_source_kind is null
     or p_source_kind not in (
       'executed_contract',
       'signed_memorandum',
       'official_record',
       'other'
     )
     or pg_catalog.char_length(normalized_source_reference) not between 3 and 1000 then
    raise exception 'contract source is invalid' using errcode = '22023';
  end if;
  if p_expected_signatory_count is null
     or p_expected_signatory_count not between 1 and 1000
     or p_verified_signatory_count is null
     or p_verified_signatory_count <> p_expected_signatory_count then
    raise exception 'the source must record every expected signatory'
      using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.first_contract.recorded',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'ratificationId', p_ratification_id,
      'agreementSha256', normalized_agreement_sha,
      'signedOn', p_signed_on,
      'sourceKind', p_source_kind,
      'sourceReference', normalized_source_reference,
      'sourceSha256', normalized_source_sha,
      'expectedSignatoryCount', p_expected_signatory_count,
      'verifiedSignatoryCount', p_verified_signatory_count,
      'effectiveOn', p_effective_on,
      'expiresOn', p_expires_on
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into ratification
  from public.organizing_bargaining_ratifications
  where id = p_ratification_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for share;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       true
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.first_contract.recorded'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision', (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'cycleId', cycle.id,
      'phase', receipt.to_state,
      'revision', receipt.result_revision,
      'contractId', receipt.entity_id,
      'status', receipt.safe_metadata ->> 'status',
      'signedOn', receipt.safe_metadata ->> 'signedOn',
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_campaign_revision
     or cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = '40001';
  end if;
  if campaign.status <> 'active'
     or campaign.stage <> 'first_contract'
     or cycle.phase <> 'execution'
     or cycle.current_ratification_id is distinct from ratification.id
     or cycle.ratification_integrity_hold
     or not ratification.execution_authorized
     or exists (
       select 1
       from public.organizing_bargaining_ratification_corrections correction
       where correction.ratification_id = ratification.id
     )
     or ratification.agreement_sha256 is distinct from normalized_agreement_sha
     or p_signed_on < ratification.held_on
     or exists (
       select 1
       from public.organizing_first_contracts prior
       where prior.cycle_id = cycle.id
     )
     or exists (
       select 1
       from public.organizing_bargaining_sessions pending_session
       where pending_session.cycle_id = cycle.id
         and pending_session.campaign_id = campaign.id
         and pending_session.chapter_id = campaign.chapter_id
         and pending_session.status = 'scheduled'
     ) then
    raise exception 'first-contract record is not eligible'
      using errcode = '22023';
  end if;

  insert into public.organizing_first_contracts (
    cycle_id,
    campaign_id,
    chapter_id,
    ratification_id,
    agreement_proposal_id,
    agreement_sha256,
    ratification_authorized,
    verification_status,
    signed_on,
    effective_on,
    expires_on,
    source_kind,
    source_reference,
    source_sha256,
    expected_signatory_count,
    verified_signatory_count,
    recorded_by,
    create_request_id,
    created_at
  ) values (
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    ratification.id,
    ratification.agreement_proposal_id,
    normalized_agreement_sha,
    true,
    'source_recorded_fully_signed',
    p_signed_on,
    p_effective_on,
    p_expires_on,
    p_source_kind,
    normalized_source_reference,
    normalized_source_sha,
    p_expected_signatory_count,
    p_verified_signatory_count,
    caller,
    p_request_id,
    event_time
  ) returning id into contract_id;

  update public.organizing_bargaining_cycles
  set phase = 'complete',
      first_contract_signed_on = p_signed_on,
      revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.first_contract.recorded',
    'first_contract',
    contract_id,
    cycle.phase,
    'complete',
    pg_catalog.jsonb_build_object(
      'campaignRevision',
      campaign.revision,
      'status',
      'source_recorded_fully_signed',
      'signedOn',
      p_signed_on
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign.revision,
    'cycleId', cycle.id,
    'phase', 'complete',
    'revision', cycle.revision + 1,
    'contractId', contract_id,
    'status', 'source_recorded_fully_signed',
    'signedOn', p_signed_on,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.record_organizing_bargaining_session_outcome: its definition from 20261014008000_unionground_bargaining_writers.sql with this migration's edit.
create or replace function public.record_organizing_bargaining_session_outcome(
  p_session_id uuid,
  p_expected_revision integer,
  p_expected_cycle_revision integer,
  p_status text,
  p_request_id uuid,
  p_ends_at timestamptz default null,
  p_member_update text default null,
  p_internal_minutes text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  session_row record;
  receipt record;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_member_update text := nullif(pg_catalog.btrim(coalesce(p_member_update, '')), '');
  normalized_internal_minutes text := nullif(pg_catalog.btrim(coalesce(p_internal_minutes, '')), '');
  normalized_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
begin
  if caller is null or p_session_id is null or p_request_id is null then
    raise exception 'bargaining session not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0
     or p_expected_cycle_revision is null
     or p_expected_cycle_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('held', 'cancelled') then
    raise exception 'unknown session outcome' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_member_update, '')) > 2000
     or pg_catalog.char_length(coalesce(normalized_internal_minutes, '')) > 20000
     or pg_catalog.char_length(coalesce(normalized_reason, '')) > 2000 then
    raise exception 'session outcome fields are invalid' using errcode = '22023';
  end if;
  if p_status = 'held'
     and (p_ends_at is null or normalized_member_update is null) then
    raise exception 'held session requires an end time and member-safe update'
      using errcode = '22023';
  end if;
  if p_status = 'cancelled'
     and (
       normalized_reason is null
       or p_ends_at is not null
     ) then
    raise exception 'cancelled session fields are invalid'
      using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.session.outcome_recorded',
    pg_catalog.jsonb_build_object(
      'sessionId', p_session_id,
      'expectedRevision', p_expected_revision,
      'expectedCycleRevision', p_expected_cycle_revision,
      'status', p_status,
      'endsAt', private.bargaining_canonical_instant(p_ends_at),
      'memberUpdate', normalized_member_update,
      'internalMinutes', normalized_internal_minutes,
      'reason', normalized_reason
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select s.cycle_id, s.campaign_id, s.chapter_id
  into target
  from public.organizing_bargaining_sessions s
  where s.id = p_session_id;

  if not found then
    raise exception 'bargaining session not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = target.cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into session_row
  from public.organizing_bargaining_sessions
  where id = p_session_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'bargaining session not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.session.outcome_recorded'
       or receipt.entity_id <> session_row.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'cycleRevision', (receipt.safe_metadata ->> 'cycleRevision')::integer,
      'sessionId', session_row.id,
      'status', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision
     or session_row.revision <> p_expected_revision then
    raise exception 'bargaining session changed; reload and try again'
      using errcode = '40001';
  end if;
  if campaign.status <> 'active'
     or cycle.phase = 'complete'
     or session_row.status <> 'scheduled' then
    raise exception 'bargaining session is not editable' using errcode = '22023';
  end if;
  if p_status = 'held'
     and (
       cycle.bargaining_started_on is null
       or cycle.phase in ('preparing', 'proposal_development')
       or session_row.starts_at
          < (cycle.bargaining_started_on::timestamp at time zone 'UTC')
     ) then
    raise exception 'a held session requires a verified bargaining start'
      using errcode = '22023';
  end if;
  if p_ends_at is not null and p_ends_at < session_row.starts_at then
    raise exception 'session end cannot precede its start' using errcode = '22023';
  end if;
  if p_status = 'held'
     and (
       session_row.starts_at > event_time
       or p_ends_at > event_time
     ) then
    raise exception 'a held session cannot be recorded before it ends'
      using errcode = '22023';
  end if;

  update public.organizing_bargaining_sessions
  set status = p_status,
      ends_at = case when p_status = 'held' then p_ends_at else null end,
      member_update = case
        when p_status = 'held' then normalized_member_update
        else ''
      end,
      internal_minutes = normalized_internal_minutes,
      outcome_reason = normalized_reason,
      revision = session_row.revision + 1,
      updated_at = event_time
  where id = session_row.id;

  update public.organizing_bargaining_cycles
  set revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.session.outcome_recorded',
    'bargaining_session',
    session_row.id,
    session_row.status,
    p_status,
    pg_catalog.jsonb_build_object(
      'cycleRevision',
      cycle.revision + 1
    ),
    p_request_id,
    fingerprint,
    session_row.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'cycleRevision', cycle.revision + 1,
    'sessionId', session_row.id,
    'status', p_status,
    'revision', session_row.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.record_organizing_ratification: its definition from 20261014008000_unionground_bargaining_writers.sql with this migration's edit.
create or replace function public.record_organizing_ratification(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_expected_campaign_revision integer,
  p_agreement_proposal_id uuid,
  p_agreement_sha256 text,
  p_decision_method text,
  p_held_on date,
  p_source_reported_outcome text,
  p_source_kind text,
  p_source_reference text,
  p_source_sha256 text,
  p_rule_summary text,
  p_eligibility_source text,
  p_eligible_count integer,
  p_ballots_cast integer,
  p_approve_count integer,
  p_reject_count integer,
  p_abstain_count integer,
  p_invalid_count integer,
  p_quorum_required_count integer,
  p_threshold_numerator integer,
  p_threshold_denominator integer,
  p_approval_comparator text,
  p_approval_denominator text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  proposal record;
  receipt record;
  ratification_id uuid;
  denominator_count bigint;
  computed_outcome text;
  next_phase text;
  next_campaign_stage text;
  campaign_revision integer;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_agreement_sha text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_agreement_sha256, '')));
  normalized_source_reference text := pg_catalog.btrim(coalesce(p_source_reference, ''));
  normalized_source_sha text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source_sha256, '')));
  normalized_rule_summary text := pg_catalog.btrim(coalesce(p_rule_summary, ''));
  normalized_eligibility_source text := pg_catalog.btrim(coalesce(p_eligibility_source, ''));
begin
  if caller is null
     or p_cycle_id is null
     or p_agreement_proposal_id is null
     or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null or p_expected_cycle_revision <= 0
     or p_expected_campaign_revision is null
     or p_expected_campaign_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if normalized_agreement_sha !~ '^[0-9a-f]{64}$'
     or normalized_source_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence hashes must be lowercase SHA-256 values'
      using errcode = '22023';
  end if;
  if p_held_on is null or p_held_on > current_date then
    raise exception 'ratification date is invalid' using errcode = '22023';
  end if;
  if p_decision_method is null or p_decision_method not in ('vote', 'not_required')
     or p_source_kind is null
     or p_source_kind not in (
       'union_report',
       'independent_tally',
       'meeting_minutes',
       'written_rule',
       'other'
     ) then
    raise exception 'ratification source is invalid' using errcode = '22023';
  end if;
  if pg_catalog.char_length(normalized_source_reference) not between 3 and 1000
     or pg_catalog.char_length(normalized_rule_summary) not between 3 and 2000
     or pg_catalog.char_length(normalized_eligibility_source) not between 3 and 1000 then
    raise exception 'ratification source fields are invalid' using errcode = '22023';
  end if;

  if p_decision_method = 'vote' then
    if p_source_reported_outcome is null
       or p_source_reported_outcome not in ('approved', 'rejected', 'no_quorum')
       or p_eligible_count is null
       or p_eligible_count not between 1 and 10000000
       or p_ballots_cast is null
       or p_ballots_cast not between 0 and p_eligible_count
       or p_approve_count is null
       or p_approve_count < 0
       or p_reject_count is null
       or p_reject_count < 0
       or p_abstain_count is null
       or p_abstain_count < 0
       or p_invalid_count is null
       or p_invalid_count < 0
       or p_approve_count > p_ballots_cast
       or p_reject_count > p_ballots_cast
       or p_abstain_count > p_ballots_cast
       or p_invalid_count > p_ballots_cast
       or p_approve_count::bigint
          + p_reject_count::bigint
          + p_abstain_count::bigint
          + p_invalid_count::bigint
          <> p_ballots_cast::bigint
       or p_quorum_required_count is null
       or p_quorum_required_count not between 0 and p_eligible_count
       or p_threshold_numerator is null
       or p_threshold_denominator is null
       or p_threshold_numerator not between 1 and p_threshold_denominator
       or p_threshold_denominator not between 1 and 10000000
       or p_approval_comparator is null
       or p_approval_comparator not in ('at_least', 'more_than')
       or p_approval_denominator is null
       or p_approval_denominator not in (
         'eligible',
         'ballots_cast',
         'non_abstaining'
       ) then
      raise exception 'ratification aggregate or rule is invalid'
        using errcode = '22023';
    end if;

    denominator_count := case p_approval_denominator
      when 'eligible' then p_eligible_count
      when 'ballots_cast' then p_ballots_cast
      when 'non_abstaining' then p_approve_count + p_reject_count
    end;

    computed_outcome := case
      when p_ballots_cast < p_quorum_required_count then 'no_quorum'
      when denominator_count <= 0 then 'indeterminate'
      when p_approval_comparator = 'at_least'
       and p_approve_count::bigint * p_threshold_denominator::bigint
           >= denominator_count * p_threshold_numerator::bigint
        then 'approved'
      when p_approval_comparator = 'more_than'
       and p_approve_count::bigint * p_threshold_denominator::bigint
           > denominator_count * p_threshold_numerator::bigint
        then 'approved'
      else 'rejected'
    end;

    -- A mismatch never advances the campaign. Staff must reconcile the
    -- external source and the explicitly entered rule.
    if computed_outcome is distinct from p_source_reported_outcome then
      computed_outcome := 'indeterminate';
    end if;
  else
    if p_source_reported_outcome is distinct from 'not_required'
       or p_eligible_count is not null
       or p_ballots_cast is not null
       or p_approve_count is not null
       or p_reject_count is not null
       or p_abstain_count is not null
       or p_invalid_count is not null
       or p_quorum_required_count is not null
       or p_threshold_numerator is not null
       or p_threshold_denominator is not null
       or p_approval_comparator is not null
       or p_approval_denominator is not null then
      raise exception 'not-required record cannot contain a vote tally'
        using errcode = '22023';
    end if;
    computed_outcome := 'not_required';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.ratification.recorded',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'agreementProposalId', p_agreement_proposal_id,
      'agreementSha256', normalized_agreement_sha,
      'decisionMethod', p_decision_method,
      'heldOn', p_held_on,
      'sourceReportedOutcome', p_source_reported_outcome,
      'sourceKind', p_source_kind,
      'sourceReference', normalized_source_reference,
      'sourceSha256', normalized_source_sha,
      'ruleSummary', normalized_rule_summary,
      'eligibilitySource', normalized_eligibility_source,
      'eligibleCount', p_eligible_count,
      'ballotsCast', p_ballots_cast,
      'approveCount', p_approve_count,
      'rejectCount', p_reject_count,
      'abstainCount', p_abstain_count,
      'invalidCount', p_invalid_count,
      'quorumRequiredCount', p_quorum_required_count,
      'thresholdNumerator', p_threshold_numerator,
      'thresholdDenominator', p_threshold_denominator,
      'approvalComparator', p_approval_comparator,
      'approvalDenominator', p_approval_denominator
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into proposal
  from public.organizing_bargaining_proposals
  where id = p_agreement_proposal_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for share;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       true
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.ratification.recorded'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision', (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'campaignStage', receipt.safe_metadata ->> 'campaignStage',
      'cycleId', cycle.id,
      'phase', receipt.safe_metadata ->> 'phase',
      'revision', receipt.result_revision,
      'ratificationId', receipt.entity_id,
      'outcome', receipt.to_state,
      'decisionMethod', receipt.safe_metadata ->> 'decisionMethod',
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_campaign_revision
     or cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = '40001';
  end if;
  if campaign.status <> 'active'
     or campaign.stage <> 'bargaining'
     or cycle.phase not in ('tentative_agreement', 'ratification')
     or proposal.status <> 'tentative_agreement'
     or proposal.record_kind <> 'agreement_package'
     or proposal.document_sha256 is distinct from normalized_agreement_sha
     or cycle.bargaining_started_on is null
     or proposal.presented_on is null
     or p_held_on < cycle.bargaining_started_on
     or p_held_on < proposal.presented_on
     or exists (
       select 1
       from public.organizing_bargaining_proposals child
       where child.parent_proposal_id = proposal.id
     )
     or exists (
       select 1
       from pg_catalog.unnest(proposal.included_proposal_ids) included_id
       left join public.organizing_bargaining_proposals included
         on included.id = included_id
        and included.cycle_id = cycle.id
        and included.record_kind = 'article'
        where included.id is null
           or included.status <> 'accepted'
           or included.presented_on is null
           or included.presented_on > proposal.presented_on
           or included.presented_on > p_held_on
          or exists (
            select 1
            from public.organizing_bargaining_proposals child
            where child.parent_proposal_id = included.id
          )
     )
     or exists (
       select 1
       from public.organizing_bargaining_ratifications current_result
       where current_result.id = cycle.current_ratification_id
         and current_result.cycle_id = cycle.id
         and current_result.campaign_id = campaign.id
         and current_result.chapter_id = campaign.chapter_id
         and (
           current_result.execution_authorized
           or p_held_on < current_result.held_on
         )
     )
     or exists (
       select 1
       from public.organizing_bargaining_proposals current_article
       where current_article.cycle_id = cycle.id
         and current_article.campaign_id = campaign.id
         and current_article.chapter_id = campaign.chapter_id
         and current_article.record_kind = 'article'
         and current_article.status = 'accepted'
         and not exists (
           select 1
           from public.organizing_bargaining_proposals child
           where child.parent_proposal_id = current_article.id
         )
         and not (
           current_article.id = any(proposal.included_proposal_ids)
          )
      )
     or exists (
       select 1
       from public.organizing_bargaining_proposals unresolved_article
       where unresolved_article.cycle_id = cycle.id
         and unresolved_article.campaign_id = campaign.id
         and unresolved_article.chapter_id = campaign.chapter_id
         and unresolved_article.record_kind = 'article'
         and unresolved_article.status not in (
           'accepted',
           'rejected',
           'withdrawn',
           'superseded'
         )
         and not exists (
           select 1
           from public.organizing_bargaining_proposals child
           where child.parent_proposal_id = unresolved_article.id
         )
     )
     or cycle.ratification_integrity_hold then
    raise exception 'ratification record is not eligible' using errcode = '22023';
  end if;

  insert into public.organizing_bargaining_ratifications (
    cycle_id,
    campaign_id,
    chapter_id,
    supersedes_ratification_id,
    agreement_proposal_id,
    agreement_sha256,
    decision_method,
    held_on,
    source_reported_outcome,
    computed_outcome,
    source_kind,
    source_reference,
    source_sha256,
    rule_summary,
    eligibility_source,
    eligible_count,
    ballots_cast,
    approve_count,
    reject_count,
    abstain_count,
    invalid_count,
    quorum_required_count,
    threshold_numerator,
    threshold_denominator,
    approval_comparator,
    approval_denominator,
    recorded_by,
    create_request_id,
    created_at
  ) values (
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    cycle.current_ratification_id,
    proposal.id,
    normalized_agreement_sha,
    p_decision_method,
    p_held_on,
    p_source_reported_outcome,
    computed_outcome,
    p_source_kind,
    normalized_source_reference,
    normalized_source_sha,
    normalized_rule_summary,
    normalized_eligibility_source,
    p_eligible_count,
    p_ballots_cast,
    p_approve_count,
    p_reject_count,
    p_abstain_count,
    p_invalid_count,
    p_quorum_required_count,
    p_threshold_numerator,
    p_threshold_denominator,
    p_approval_comparator,
    p_approval_denominator,
    caller,
    p_request_id,
    event_time
  ) returning id into ratification_id;

  next_phase := case
    when computed_outcome in ('approved', 'not_required') then 'execution'
    when computed_outcome = 'rejected' then 'at_table'
    when computed_outcome = 'no_quorum' then 'ratification'
    else 'ratification'
  end;

  update public.organizing_bargaining_cycles
  set phase = next_phase,
      current_ratification_id = ratification_id,
      ratification_integrity_hold = false,
      revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  campaign_revision := campaign.revision;
  next_campaign_stage := campaign.stage;
  if computed_outcome in ('approved', 'not_required') then
    update public.organizing_campaigns
    set stage = 'first_contract',
        stage_started_at = event_time,
        revision = campaign.revision + 1,
        updated_at = event_time
    where id = campaign.id;

    insert into public.organizing_stage_events (
      campaign_id,
      chapter_id,
      from_stage,
      to_stage,
      actor_id,
      source_kind,
      note,
      occurred_at
    ) values (
      campaign.id,
      campaign.chapter_id,
      campaign.stage,
      'first_contract',
      caller,
      'document_verified',
      'Staff-recorded sourced ratification authorization recorded',
      event_time
    );

    campaign_revision := campaign.revision + 1;
    next_campaign_stage := 'first_contract';
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.ratification.recorded',
    'bargaining_ratification',
    ratification_id,
    null,
    computed_outcome,
    pg_catalog.jsonb_build_object(
      'campaignRevision',
      campaign_revision,
      'campaignStage',
      next_campaign_stage,
      'cycleRevision',
      cycle.revision + 1,
      'phase',
      next_phase,
      'decisionMethod',
      p_decision_method
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign_revision,
    'campaignStage', next_campaign_stage,
    'cycleId', cycle.id,
    'phase', next_phase,
    'revision', cycle.revision + 1,
    'ratificationId', ratification_id,
    'outcome', computed_outcome,
    'decisionMethod', p_decision_method,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- public.correct_organizing_ratification: its definition from 20261014008000_unionground_bargaining_writers.sql with this migration's edit.
create or replace function public.correct_organizing_ratification(
  p_ratification_id uuid,
  p_expected_cycle_revision integer,
  p_expected_campaign_revision integer,
  p_reason_code text,
  p_source_kind text,
  p_source_reference text,
  p_source_sha256 text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not coalesce((select private.mfa_satisfied()), false) then
    raise exception 'organizing staff MFA required' using errcode = '42501';
  end if;

declare
  caller uuid := (select auth.uid());
  target record;
  campaign record;
  cycle record;
  ratification record;
  receipt record;
  correction_id uuid;
  campaign_revision integer;
  contract_exists boolean := false;
  next_phase text;
  next_campaign_stage text;
  agreement_proposal_status text;
  agreement_proposal_revision integer;
  restored_ratification_id uuid;
  restored_ratification_outcome text;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_source_reference text := pg_catalog.btrim(
    coalesce(p_source_reference, '')
  );
  normalized_source_sha text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_source_sha256, ''))
  );
begin
  if caller is null
     or p_ratification_id is null
     or p_request_id is null then
    raise exception 'ratification record not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null
     or p_expected_cycle_revision <= 0
     or p_expected_campaign_revision is null
     or p_expected_campaign_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if p_reason_code is null
     or p_reason_code not in (
       'source_error',
       'tally_error',
       'rule_error',
       'wrong_agreement',
       'duplicate_record',
       'other'
     )
     or p_source_kind is null
     or p_source_kind not in (
       'union_report',
       'independent_tally',
       'meeting_minutes',
       'written_rule',
       'official_record',
       'other'
     )
     or pg_catalog.char_length(normalized_source_reference) not between 3 and 1000
     or normalized_source_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'correction source is invalid' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.ratification.corrected',
    pg_catalog.jsonb_build_object(
      'ratificationId', p_ratification_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'reasonCode', p_reason_code,
      'sourceKind', p_source_kind,
      'sourceReference', normalized_source_reference,
      'sourceSha256', normalized_source_sha
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:mfa-reset:' || caller::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:'
        || caller::text
        || ':'
        || p_request_id::text,
      0
    )
  );

  select
    r.cycle_id,
    r.campaign_id,
    r.chapter_id
  into target
  from public.organizing_bargaining_ratifications r
  where r.id = p_ratification_id;

  if not found then
    raise exception 'ratification record not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = target.cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into ratification
  from public.organizing_bargaining_ratifications
  where id = p_ratification_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for share;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       true
     ) is null then
    raise exception 'ratification record not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.ratification.corrected'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision',
        (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'campaignStage', receipt.safe_metadata ->> 'campaignStage',
      'cycleId', cycle.id,
      'phase', receipt.safe_metadata ->> 'phase',
      'revision', receipt.result_revision,
      'ratificationId',
        (receipt.safe_metadata ->> 'ratificationId')::uuid,
      'correctionId', receipt.entity_id,
      'corrected', true,
      'reasonCode', receipt.safe_metadata ->> 'reasonCode',
      'restoredRatificationId',
        (receipt.safe_metadata ->> 'restoredRatificationId')::uuid,
      'integrityHold',
        (receipt.safe_metadata ->> 'integrityHold')::boolean,
      'auditEventId', receipt.id
    );
  end if;

  contract_exists := exists (
    select 1
    from public.organizing_first_contracts contract
    where contract.cycle_id = cycle.id
      and contract.campaign_id = campaign.id
      and contract.chapter_id = campaign.chapter_id
      and contract.ratification_id = ratification.id
  );

  if campaign.revision <> p_expected_campaign_revision
     or cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = '40001';
  end if;
  if not (
       (
         campaign.status = 'active'
         and campaign.stage in ('bargaining', 'first_contract')
       )
       or (
         campaign.status = 'closed'
         and campaign.stage = 'established'
         and campaign.outcome = 'established'
       )
     )
     or cycle.phase not in ('at_table', 'ratification', 'execution', 'complete')
     or cycle.current_ratification_id is distinct from ratification.id
     or exists (
       select 1
       from public.organizing_bargaining_ratification_corrections prior
       where prior.ratification_id = ratification.id
     )
     or (
       ratification.execution_authorized
       and (
         (
           not contract_exists
           and (
             campaign.stage <> 'first_contract'
             or cycle.phase <> 'execution'
           )
         )
         or (
           contract_exists
           and cycle.phase <> 'complete'
         )
       )
     ) then
    raise exception 'ratification correction is not eligible'
      using errcode = '22023';
  end if;

  set constraints public.organizing_bargaining_corrections_detach_current deferred;

  insert into public.organizing_bargaining_ratification_corrections (
    ratification_id,
    cycle_id,
    campaign_id,
    chapter_id,
    reason_code,
    source_kind,
    source_reference,
    source_sha256,
    corrected_by,
    create_request_id,
    created_at
  ) values (
    ratification.id,
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    p_reason_code,
    p_source_kind,
    normalized_source_reference,
    normalized_source_sha,
    caller,
    p_request_id,
    event_time
  ) returning id into correction_id;

  campaign_revision := campaign.revision;
  if contract_exists then
    next_phase := cycle.phase;
    next_campaign_stage := campaign.stage;
    update public.organizing_bargaining_cycles
    set current_ratification_id = null,
        ratification_integrity_hold = true,
        revision = cycle.revision + 1,
        updated_at = event_time
    where id = cycle.id;
  else
    if p_reason_code = 'duplicate_record'
       and ratification.supersedes_ratification_id is not null then
      select prior.id, prior.computed_outcome
      into restored_ratification_id, restored_ratification_outcome
      from public.organizing_bargaining_ratifications prior
      join public.organizing_bargaining_proposals prior_proposal
        on prior_proposal.id = prior.agreement_proposal_id
       and prior_proposal.cycle_id = prior.cycle_id
       and prior_proposal.campaign_id = prior.campaign_id
       and prior_proposal.chapter_id = prior.chapter_id
       and prior_proposal.document_sha256 = prior.agreement_sha256
      where prior.id = ratification.supersedes_ratification_id
        and prior.cycle_id = cycle.id
        and prior.campaign_id = campaign.id
        and prior.chapter_id = campaign.chapter_id
        and not prior.execution_authorized
        and prior.agreement_proposal_id = ratification.agreement_proposal_id
        and prior.agreement_sha256 = ratification.agreement_sha256
        and prior_proposal.status = 'tentative_agreement'
        and not exists (
          select 1
          from public.organizing_bargaining_proposals child
          where child.parent_proposal_id = prior_proposal.id
        )
        and not exists (
          select 1
          from public.organizing_bargaining_ratification_corrections correction
          where correction.ratification_id = prior.id
        )
      for share;
    end if;

    next_phase := case
      when p_reason_code = 'wrong_agreement' then 'at_table'
      when p_reason_code = 'duplicate_record'
        and restored_ratification_id is not null
        and restored_ratification_outcome = 'rejected' then 'at_table'
      when p_reason_code = 'duplicate_record'
        and restored_ratification_id is not null then 'ratification'
      when ratification.execution_authorized then 'ratification'
      else cycle.phase
    end;
    next_campaign_stage := 'bargaining';
    if p_reason_code = 'wrong_agreement' then
      update public.organizing_bargaining_proposals
      set status = 'withdrawn',
          revision = revision + 1,
          updated_at = event_time
      where id = ratification.agreement_proposal_id
        and cycle_id = cycle.id
        and campaign_id = campaign.id
        and chapter_id = campaign.chapter_id
        and status = 'tentative_agreement'
      returning status, revision
      into agreement_proposal_status, agreement_proposal_revision;

      if not found then
        select proposal.status, proposal.revision
        into agreement_proposal_status, agreement_proposal_revision
        from public.organizing_bargaining_proposals proposal
        where proposal.id = ratification.agreement_proposal_id
          and proposal.cycle_id = cycle.id
          and proposal.campaign_id = campaign.id
          and proposal.chapter_id = campaign.chapter_id;
      end if;
    end if;
    update public.organizing_bargaining_cycles
    set phase = next_phase,
        current_ratification_id = case
          when p_reason_code = 'duplicate_record'
            then restored_ratification_id
          else null
        end,
        ratification_integrity_hold = false,
        revision = cycle.revision + 1,
        updated_at = event_time
    where id = cycle.id;

    if campaign.stage = 'first_contract' then
      update public.organizing_campaigns
      set stage = next_campaign_stage,
          stage_started_at = event_time,
          revision = campaign.revision + 1,
          updated_at = event_time
      where id = campaign.id;

      insert into public.organizing_stage_events (
        campaign_id,
        chapter_id,
        from_stage,
        to_stage,
        actor_id,
        source_kind,
        note,
        occurred_at
      ) values (
        campaign.id,
        campaign.chapter_id,
        campaign.stage,
        next_campaign_stage,
        caller,
        'document_verified',
        'Prior sourced ratification authorization corrected before execution',
        event_time
      );

      campaign_revision := campaign.revision + 1;
    end if;
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.ratification.corrected',
    'bargaining_ratification_correction',
    correction_id,
    ratification.computed_outcome,
    'corrected',
    pg_catalog.jsonb_build_object(
      'campaignRevision', campaign_revision,
      'campaignStage', next_campaign_stage,
      'cycleRevision', cycle.revision + 1,
      'phase', next_phase,
      'ratificationId', ratification.id,
      'reasonCode', p_reason_code,
      'agreementProposalId', ratification.agreement_proposal_id,
      'agreementProposalStatus', agreement_proposal_status,
      'agreementProposalRevision', agreement_proposal_revision,
      'restoredRatificationId', restored_ratification_id,
      'integrityHold', contract_exists
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign_revision,
    'campaignStage', next_campaign_stage,
    'cycleId', cycle.id,
    'phase', next_phase,
    'revision', cycle.revision + 1,
    'ratificationId', ratification.id,
    'correctionId', correction_id,
    'corrected', true,
    'reasonCode', p_reason_code,
    'restoredRatificationId', restored_ratification_id,
    'integrityHold', contract_exists,
    'auditEventId', audit_id
  );
end;
end;
$$;
commit;
