-- REQ-UG-ISSUE-INTELLIGENCE-SIGNALS-20261001
--
-- Restores the old app's issue-thread engine (de7df4b57c^:lib/issue-threads/
-- engine.ts, families.ts, load-evidence.ts, load-signals.ts) against the data
-- the product has today. Two families are detected per organization (tenant):
--
--   contract_rights_confusion                 repeated contract / rights questions
--   retaliation_protected_activity_pressure   pressure after protected activity
--
-- Evidence families and the old activation rules (engine.ts:12-73) are kept:
--   contract rights: Q&A >= 2 matching posts; messages >= 3 matching inbound
--     member messages from >= 2 members; cases >= 1 matching case; polls >= 1
--     matching weekly-question submission or pulse response; reviewed issue
--     themes (frozen chapter connection aggregates). Active at >= 2 families;
--     confidence emerging 2, active 3, strong >= 4.
--   retaliation: retaliation reports >= 1 and Know-your-rights emergency
--     checklists >= 1 are the direct signals (one is required); messages >= 2
--     from >= 1 member; cases >= 1; Q&A >= 1; reviewed themes. Active at >= 2
--     families including a direct one.
--
-- Adaptations to the current architecture (the old code was single-tenant and
-- read with a service-role client):
--   * Every source is read inside the caller's organization only. Themes never
--     leave the tenant (the "Chapter connection matching contract").
--   * Privacy floor, enforced here and nowhere else: a family is shown only when
--     the distinct people behind its active evidence reach
--     limits.intelligence.issue_signal_min_segment, never below 15 (old
--     issue_intelligence_min_segment_size, 0259_issue_intelligence_weekly_digest.sql:54).
--   * Cases contribute their category (case_type) and cited contract articles,
--     never titles or narratives. Restricted cases are excluded.
--   * Messages: inbound member messages and conversation titles that the
--     tenant's own chapter staff can already read. Redacted rows carry no text
--     (Message body lifecycle contract) and are skipped. No text, count or
--     identity leaves this file: callers receive families, a confidence band
--     and a trend only.
--   * Page views are aggregated daily path counts with no identity today, so
--     the old "guidance views" family has no source and is not used.
--
-- Switch defaults are the old app's effective production defaults:
--   features.intelligence.issue_signals = true
--     (old issue_thread_enabled, 0282_issue_thread_master_flag.sql:5-11, upserted 'true')
--   features.intelligence.issue_signals_contract_rights_family = true
--     (old issue_intelligence_contract_rights_family_enabled, 0259:56)
--   features.intelligence.issue_signals_retaliation_family = false
--     (old issue_thread_retaliation_enabled, 0257_issue_thread_retaliation_flag.sql:2)
--   limits.intelligence.issue_signal_min_segment = 15, minimum 15 (0259:54)

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.intelligence.issue_signals', 'boolean', 'Issue intelligence signals',
   'Spot repeated contract-rights confusion or retaliation pressure across Q&A, messages, cases and polls, and show banners, guidance and poll drafts.',
   'true', null, null, null, 10, 'intelligence', true),
  ('features.intelligence.issue_signals_contract_rights_family', 'boolean', 'Contract-rights confusion signal',
   'Include the contract and rights confusion pattern in issue intelligence.',
   'true', null, null, null, 20, 'intelligence', true),
  ('features.intelligence.issue_signals_retaliation_family', 'boolean', 'Retaliation pressure signal',
   'Include the retaliation and protected-activity pressure pattern in issue intelligence.',
   'false', null, null, null, 30, 'intelligence', true),
  ('limits.intelligence.issue_signal_min_segment', 'integer', 'Issue signal privacy floor',
   'Fewest different people behind a pattern before any issue signal appears. It can be raised, never set below 15.',
   '15', 15, 500, null, 40, 'intelligence', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Keyword matchers (old contract-rights-keywords.ts / retaliation-keywords.ts)
-- ---------------------------------------------------------------------------
-- Word-start anchored stems so "bright" no longer reads as "right". Spanish
-- stems are added because member copy on the web is bilingual.

create function private.issue_signal_contract_rights_text(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.lower(pg_catalog.left(coalesce(p_text, ''), 12000)) ~ (
      '\m(contract|article|section|clause|right|protect|disciplin|corrective|progressive|overtime'
      || '|leave|sick|vacation|schedul|assignment|reassign|transfer|representation|due process'
      || '|step [123]\M|grievance procedure|just cause'
      || '|contrato|art[ií]culo|cl[aá]usula|derecho|protecci[oó]n|horas extra|permiso|vacaciones'
      || '|horario|traslado|representaci[oó]n|causa justa)'
    ),
    false
  )
$function$;

create function private.issue_signal_retaliation_text(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.lower(pg_catalog.left(coalesce(p_text, ''), 12000)) ~ (
      '\m(retaliat|harass|intimidat|surveillance|protected activity|union activity|steward request'
      || '|asked for (representation|a steward)|after filing a grievance|after reporting'
      || '|discipline after|targeted after'
      || '|represalia|acoso|intimidaci[oó]n|vigilancia|actividad sindical)'
    ),
    false
  )
$function$;

-- ---------------------------------------------------------------------------
-- 2. Evidence and signal computation (internal; never exposed directly)
-- ---------------------------------------------------------------------------
-- Returns, for one family and one organization, the old engine's verdict plus
-- the internal numbers the privacy floor and the weekly digest need. Only
-- SECURITY DEFINER callers in this lane read it; it is not granted to anyone.

create function private.issue_intelligence_family_signal(
  p_organization_id uuid,
  p_family text,
  p_as_of timestamptz default pg_catalog.now(),
  p_window_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  window_end timestamptz := coalesce(p_as_of, pg_catalog.now());
  window_days integer := coalesce(p_window_days, 30);
  window_start timestamptz;
  prior_start timestamptz;
  retaliation boolean;
  qa_count integer := 0; qa_prior integer := 0;
  message_count integer := 0; message_senders integer := 0; message_prior integer := 0;
  case_count integer := 0; case_prior integer := 0;
  poll_count integer := 0; poll_prior integer := 0;
  report_count integer := 0; report_prior integer := 0;
  checklist_count integer := 0; checklist_prior integer := 0;
  reviewed_theme boolean := false;
  people_by_evidence jsonb := '{}'::jsonb;
  families text[] := array[]::text[];
  direct boolean := false;
  contributors integer := 0;
  confidence text := null;
  active boolean := false;
  current_total integer;
  prior_total integer;
  trend text;
begin
  if p_organization_id is null or p_family not in ('contract_rights_confusion', 'retaliation_protected_activity_pressure') then
    raise exception 'invalid issue intelligence family' using errcode = '22023';
  end if;
  if window_days not between 1 and 90 then
    raise exception 'invalid issue intelligence window' using errcode = '22023';
  end if;
  -- The old engine looked back 30 days (load-evidence.ts:7); the old weekly
  -- digest used the completed week. Trend compares the same-length window
  -- immediately before.
  window_start := window_end - pg_catalog.make_interval(days => window_days);
  prior_start := window_end - pg_catalog.make_interval(days => window_days * 2);
  retaliation := p_family = 'retaliation_protected_activity_pressure';

  -- Every evidence row is (evidence, person, occurred_at) inside this tenant,
  -- over the current and the prior window (for the trend).
  with evidence(evidence, person, occurred_at) as (
    -- Q&A: the organization's own forum questions (titles and bodies are
    -- already readable by every member of the organization).
    select 'qa', q.author_user_id, q.created_at
    from public.member_qa_questions q
    where q.organization_id = p_organization_id
      and q.deleted_at is null
      and q.created_at >= prior_start and q.created_at <= window_end
      and case when retaliation
        then private.issue_signal_retaliation_text(q.title || ' ' || q.body)
        else private.issue_signal_contract_rights_text(q.title || ' ' || q.body) end
    union all
    -- Messages: inbound member messages and their conversation title, stamped
    -- with the conversation's organization when it was created. Redacted
    -- rows have no text and are skipped.
    select 'messages', m.user_id, m.created_at
    from public.member_messages m
    join public.member_conversations c on c.id = m.conversation_id
      and c.organization_id = p_organization_id
    join public.organization_memberships om
      on om.organization_id = p_organization_id and om.user_id = c.user_id and om.status = 'active'
    where m.sender_kind = 'member'
      and m.redacted_at is null
      and m.created_at >= prior_start and m.created_at <= window_end
      and case when retaliation
        then private.issue_signal_retaliation_text(c.title || ' ' || m.body)
        else private.issue_signal_contract_rights_text(c.title || ' ' || m.body) end
    union all
    -- Cases: category and cited contract articles only; never titles or
    -- narratives; restricted cases never count.
    select 'cases', mc.user_id, mc.created_at
    from public.member_cases mc
    where mc.organization_id = p_organization_id
      and not mc.is_restricted
      and mc.created_at >= prior_start and mc.created_at <= window_end
      and case when retaliation
        then private.issue_signal_retaliation_text(mc.case_type)
        else private.issue_signal_contract_rights_text(mc.case_type)
          or pg_catalog.btrim(coalesce(mc.articles, '')) <> '' end
    union all
    -- Polls (contract rights): member weekly-question submissions ...
    select 'polls', w.user_id, w.created_at
    from public.member_weekly_questions w
    join public.chapters ch on ch.id = w.chapter_id and ch.organization_id = p_organization_id
    where not retaliation
      and w.created_at >= prior_start and w.created_at <= window_end
      and private.issue_signal_contract_rights_text(w.body)
    union all
    -- ... and contextual pulse responses to a staff-written contract prompt.
    select 'polls', e.user_id, e.responded_at
    from public.organization_pulse_events e
    join public.organization_pulse_prompts pr on pr.id = e.prompt_id and pr.organization_id = p_organization_id
    where not retaliation
      and e.organization_id = p_organization_id
      and e.state = 'responded'
      and e.responded_at >= prior_start and e.responded_at <= window_end
      and private.issue_signal_contract_rights_text(pr.question)
    union all
    -- Retaliation reports (old retaliation_flags): submitted, not withdrawn.
    select 'retaliation_reports', r.reporter_user_id, r.created_at
    from public.casework_retaliation_reports r
    where retaliation
      and r.organization_id = p_organization_id
      and r.status <> 'withdrawn'
      and r.created_at >= prior_start and r.created_at <= window_end
    union all
    -- Know-your-rights emergency checklists (old kyr family) for discipline
    -- scenarios, the current equivalent of the old harassment checklist.
    select 'kyr', k.member_user_id, k.updated_at
    from public.member_emergency_checklists k
    where retaliation
      and k.organization_id = p_organization_id
      and k.scenario in ('disciplinary_meeting', 'pre_discipline_response')
      and k.updated_at >= prior_start and k.updated_at <= window_end
  )
  select
    pg_catalog.count(*) filter (where e.evidence = 'qa' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'qa' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'messages' and e.occurred_at >= window_start),
    pg_catalog.count(distinct e.person) filter (where e.evidence = 'messages' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'messages' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'cases' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'cases' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'polls' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'polls' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'retaliation_reports' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'retaliation_reports' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'kyr' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'kyr' and e.occurred_at < window_start),
    -- People per evidence family in the current window, used only to apply
    -- the privacy floor below; never returned to any caller.
    pg_catalog.jsonb_build_object(
      'qa', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'qa' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'messages', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'messages' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'cases', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'cases' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'polls', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'polls' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'retaliation_reports', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'retaliation_reports' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'kyr', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'kyr' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb)
    )
  into qa_count, qa_prior, message_count, message_senders, message_prior, case_count, case_prior,
    poll_count, poll_prior, report_count, report_prior, checklist_count, checklist_prior, people_by_evidence
  from evidence e;

  -- Reviewed issue themes: the organization's own frozen, privacy-banded
  -- connection aggregates from roughly the last two quarters. They carry no
  -- people and never count toward the privacy floor.
  select exists (
    select 1
    from private.chapter_connection_issue_aggregates a
    join private.chapter_connection_aggregate_runs run
      on run.chapter_id = a.chapter_id and run.period_key = a.period_key
    where run.organization_id = p_organization_id
      and run.period_ends_at >= window_end - interval '200 days'
      and run.period_ends_at <= window_end
      and a.band in ('many', 'most')
      and a.topic_key = any (case when retaliation
        then array['discrimination']
        else array['contract-enforcement', 'discipline'] end)
  ) into reviewed_theme;

  if retaliation then
    if report_count >= 1 then families := families || 'retaliation_reports'::text; direct := true; end if;
    if checklist_count >= 1 then families := families || 'kyr'::text; direct := true; end if;
    if message_count >= 2 and message_senders >= 1 then families := families || 'messages'::text; end if;
    if case_count >= 1 then families := families || 'cases'::text; end if;
    if qa_count >= 1 then families := families || 'qa'::text; end if;
    if reviewed_theme then families := families || 'reviewed_themes'::text; end if;
    active := direct and pg_catalog.cardinality(families) >= 2;
  else
    if qa_count >= 2 then families := families || 'qa'::text; end if;
    if message_count >= 3 and message_senders >= 2 then families := families || 'messages'::text; end if;
    if case_count >= 1 then families := families || 'cases'::text; end if;
    if poll_count >= 1 then families := families || 'polls'::text; end if;
    if reviewed_theme then families := families || 'reviewed_themes'::text; end if;
    active := pg_catalog.cardinality(families) >= 2;
  end if;

  if active then
    confidence := case
      when pg_catalog.cardinality(families) >= 4 then 'strong'
      when pg_catalog.cardinality(families) >= 3 then 'active'
      else 'emerging' end;
  end if;

  -- Distinct people behind the evidence families that made this one active.
  select pg_catalog.count(distinct person.value)
  into contributors
  from pg_catalog.jsonb_each(people_by_evidence) by_family
  cross join lateral pg_catalog.jsonb_array_elements_text(by_family.value) person
  where by_family.key = any (families);

  current_total := qa_count + message_count + case_count + poll_count + report_count + checklist_count;
  prior_total := qa_prior + message_prior + case_prior + poll_prior + report_prior + checklist_prior;
  trend := case
    when current_total >= prior_total + 2 and current_total * 4 >= prior_total * 5 then 'rising'
    when prior_total >= current_total + 2 and current_total * 4 <= prior_total * 3 then 'declining'
    else 'stable' end;

  return pg_catalog.jsonb_build_object(
    'family', p_family,
    'threadKey', case when retaliation then 'retaliation-protected-activity-pressure' else 'contract-rights-confusion' end,
    'active', active,
    'confidence', confidence,
    'evidenceFamilies', pg_catalog.to_jsonb(families),
    'trend', trend,
    'contributors', contributors,
    'windowStart', window_start,
    'windowEnd', window_end,
    'windowDays', window_days,
    'evidence', pg_catalog.jsonb_build_object(
      'qa', qa_count, 'messages', message_count, 'messageSenders', message_senders,
      'cases', case_count, 'polls', poll_count, 'retaliationReports', report_count,
      'kyr', checklist_count, 'reviewedThemes', reviewed_theme
    )
  );
end;
$function$;

-- The families an organization has switched on, each with the old engine's
-- verdict after the privacy floor. Shared by the member/staff read and the
-- weekly digest. A family below the floor is reported as not visible.
create function private.issue_intelligence_visible_signals(
  p_organization_id uuid,
  p_as_of timestamptz default pg_catalog.now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  floor_size integer;
  family text;
  signal jsonb;
  result jsonb := '[]'::jsonb;
begin
  if p_organization_id is null then
    raise exception 'organization required' using errcode = '22023';
  end if;
  if not private.organization_feature_enabled(p_organization_id, 'features.intelligence.issue_signals') then
    return result;
  end if;
  floor_size := greatest(15, coalesce(private.organization_limit(p_organization_id, 'limits.intelligence.issue_signal_min_segment'), 15));

  -- Old ISSUE_THREAD_PRIORITY (families.ts:13-16): retaliation first.
  foreach family in array array['retaliation_protected_activity_pressure', 'contract_rights_confusion'] loop
    if family = 'retaliation_protected_activity_pressure'
       and not private.organization_feature_enabled(p_organization_id, 'features.intelligence.issue_signals_retaliation_family') then
      continue;
    end if;
    if family = 'contract_rights_confusion'
       and not private.organization_feature_enabled(p_organization_id, 'features.intelligence.issue_signals_contract_rights_family') then
      continue;
    end if;
    signal := private.issue_intelligence_family_signal(p_organization_id, family, p_as_of);
    if (signal ->> 'active')::boolean and (signal ->> 'contributors')::integer >= floor_size then
      result := result || pg_catalog.jsonb_build_array(signal);
    end if;
  end loop;
  return result;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Member / staff read
-- ---------------------------------------------------------------------------
-- p_selected_hat 'member' returns the member-safe projection (family only,
-- old privacy.ts memberSafeSignal without counts). A staff hat the caller
-- really holds in this organization (organization grant or a chapter role in
-- one of its chapters) adds confidence, evidence families and trend. Counts,
-- people and text never leave the database.

create function public.get_issue_intelligence_signals(p_selected_hat text default 'member')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  hat text := coalesce(nullif(pg_catalog.btrim(coalesce(p_selected_hat, '')), ''), 'member');
  staff boolean := false;
  signals jsonb;
  projected jsonb := '[]'::jsonb;
  item jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  org := private.mi1_require_selected_organization();
  if not private.is_organization_member(org) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  if hat not in ('member', 'steward', 'coordinator', 'admin') then
    raise exception 'invalid hat' using errcode = '22023';
  end if;
  if hat <> 'member' then
    staff := private.has_organization_role(org, array[hat])
      or exists (
        select 1 from public.chapters c
        where c.organization_id = org
          and private.member_has_chapter_role(c.id, array[hat])
      );
    if not staff then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;

  if not private.organization_feature_enabled(org, 'features.intelligence.issue_signals') then
    return pg_catalog.jsonb_build_object('enabled', false, 'viewer', case when staff then 'staff' else 'member' end, 'signals', '[]'::jsonb);
  end if;

  signals := private.issue_intelligence_visible_signals(org, pg_catalog.now());
  for item in select value from pg_catalog.jsonb_array_elements(signals) loop
    if staff then
      projected := projected || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'family', item -> 'family',
        'threadKey', item -> 'threadKey',
        'confidence', item -> 'confidence',
        'evidenceFamilies', item -> 'evidenceFamilies',
        'trend', item -> 'trend'
      ));
    else
      projected := projected || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'family', item -> 'family',
        'threadKey', item -> 'threadKey'
      ));
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'enabled', true,
    'viewer', case when staff then 'staff' else 'member' end,
    'windowDays', 30,
    'signals', projected
  );
end;
$function$;

revoke all on function private.issue_signal_contract_rights_text(text) from public, anon, authenticated, service_role;
revoke all on function private.issue_signal_retaliation_text(text) from public, anon, authenticated, service_role;
revoke all on function private.issue_intelligence_family_signal(uuid, text, timestamptz, integer) from public, anon, authenticated, service_role;
revoke all on function private.issue_intelligence_visible_signals(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.get_issue_intelligence_signals(text) from public, anon, authenticated, service_role;
grant execute on function public.get_issue_intelligence_signals(text) to authenticated;

comment on function public.get_issue_intelligence_signals(text) is
  'REQ-UG-ISSUE-INTELLIGENCE-SIGNALS-20261001: tenant-local issue signals. Member hat: families only. Held staff hat: confidence, evidence families and trend. Privacy floor limits.intelligence.issue_signal_min_segment (never below 15) is enforced server-side.';

notify pgrst, 'reload schema';

commit;
