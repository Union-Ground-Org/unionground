-- REQ-UG-STRENGTH-ANALYZER-AUTO-SCORING-20261001 (CR-020, narrowed)
--
-- Restore-everything campaign,. The pre-clean-room analyzer
-- (de7df4b57c^:app/dashboard/analyzer/actions.ts, lib/grievances/strength-score.ts)
-- was deterministic, with no AI call (strength-score.ts:11-13): it matched the
-- case description against the contract clauses' keywords and summaries
-- (actions.ts:63-75, 140-165), weighted the evidence type (witness statements 90,
-- documents 75, photos 65, none 30; actions.ts:44-49), scored procedural standing
-- against the step-1 filing window (14 days, actions.ts:117, 172-190), warned when
-- the filing deadline was within analyzer_deadline_warning_days (5,
-- actions.ts:118) and combined them 40/35/25 (actions.ts:192-195). The current
-- casework suite only stores five hand-rated factors (casework_score_case,
-- 20260828210000:854).
--
-- public.casework_suggest_case_strength(p_case_id, p_evidence_type) restores the
-- automatic suggestion beside the manual factors, read-only:
--   * description: the case title and articles plus the member's filing form
--     summary, articles and narrative (the current grievance form fields);
--   * clauses: the organization's published public.contract_clauses (the
--     current clause quick reference), keyword + summary match, top match
--     Primary and the next two Supporting;
--   * evidence: the steward's choice, else inferred — witnesses named on the
--     filing form, else uploaded case documents, else photos, else none;
--   * procedure: days since the incident date on the filing form against the
--     organization's filing window; days remaining from the case's own active
--     filing or procedure deadline when one exists;
--   * suggestedInputs map the result onto the 0..5 factors so the steward can
--     accept or override them and save through casework_score_case as before.
-- Nothing is stored and no text from the case is returned.
--
-- Settings (W1-SETTINGS registry, category casework), old defaults:
--   features.casework.strength_auto_suggest       true  analyzer_enabled default-ON
--       (lib/settings/feature-flags.ts:60, 0234_feature_flags_public.sql:15)
--   limits.casework.strength_deadline_warning_days  5   0029_fix_settings_constraints_and_seed.sql:27, actions.ts:118
--   limits.casework.strength_filing_window_days    14   0029_fix_settings_constraints_and_seed.sql:26, actions.ts:117
--   limits.casework.strength_evidence_witness      90   actions.ts:45 (evidence_score_witness)
--   limits.casework.strength_evidence_documents    75   actions.ts:46 (evidence_score_documents)
--   limits.casework.strength_evidence_photos       65   actions.ts:47 (evidence_score_photos)
--   limits.casework.strength_evidence_none         30   actions.ts:48 (evidence_score_none)

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible)
values
  -- Old analyzer_enabled, default-ON kill switch (feature-flags.ts:60, 0234:15).
  ('features.casework.strength_auto_suggest', 'boolean', 'Suggested case strength score',
   'Show an automatic strength suggestion from contract clause matches, evidence and filing timeliness next to the steward''s own rating.',
   'true', null, null, null, 1700, 'casework', false),
  -- Old analyzer_deadline_warning_days 5 (0029:27, actions.ts:118).
  ('limits.casework.strength_deadline_warning_days', 'integer', 'Strength check filing warning (days)',
   'Warn in the strength suggestion when the filing deadline is this many days away or fewer.',
   '5', 1, 60, null, 1710, 'casework', false),
  -- Old step1_filing_deadline_days 14 (0029:26, actions.ts:117).
  ('limits.casework.strength_filing_window_days', 'integer', 'Strength check filing window (days)',
   'Days after the incident used for timeliness when a case has no filing deadline of its own.',
   '14', 1, 365, null, 1720, 'casework', false),
  -- Old evidence_score_witness 90 (actions.ts:45).
  ('limits.casework.strength_evidence_witness', 'integer', 'Evidence weight: witness statements',
   'Evidence score (0-100) the strength suggestion gives a case with witness statements.',
   '90', 0, 100, null, 1730, 'casework', false),
  -- Old evidence_score_documents 75 (actions.ts:46).
  ('limits.casework.strength_evidence_documents', 'integer', 'Evidence weight: documents',
   'Evidence score (0-100) the strength suggestion gives a case with documents.',
   '75', 0, 100, null, 1740, 'casework', false),
  -- Old evidence_score_photos 65 (actions.ts:47).
  ('limits.casework.strength_evidence_photos', 'integer', 'Evidence weight: photos',
   'Evidence score (0-100) the strength suggestion gives a case with photos only.',
   '65', 0, 100, null, 1750, 'casework', false),
  -- Old evidence_score_none 30 (actions.ts:48).
  ('limits.casework.strength_evidence_none', 'integer', 'Evidence weight: no evidence',
   'Evidence score (0-100) the strength suggestion gives a case with no evidence.',
   '30', 0, 100, null, 1760, 'casework', false)
on conflict (key) do nothing;

create function public.casework_suggest_case_strength(p_case_id uuid, p_evidence_type text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_case public.member_cases%rowtype;
  v_answers jsonb;
  v_words text[];
  v_word_count integer;
  v_matches jsonb;
  v_max integer;
  v_contract integer;
  v_evidence_type text;
  v_inferred boolean;
  v_evidence integer;
  v_incident date;
  v_window integer;
  v_warning_days integer;
  v_days_since integer;
  v_procedural integer;
  v_days_remaining integer;
  v_due date;
  v_overall integer;
begin
  perform private.casework_require_mfa();
  if p_case_id is null or not private.casework_staff_can_access(p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  if p_evidence_type is not null and p_evidence_type not in ('witness_statements', 'documents', 'photos', 'none') then
    raise exception 'invalid evidence type' using errcode = '22023';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  if not private.organization_feature_enabled(v_case.organization_id, 'features.casework.strength_auto_suggest') then
    raise exception 'strength suggestion is turned off' using errcode = '55000';
  end if;
  select f.answers into v_answers from public.member_forms f
  where f.case_id = v_case.id and f.user_id = v_case.user_id
  order by f.created_at, f.id limit 1;
  v_answers := coalesce(v_answers, '{}'::jsonb);

  -- Old words(): lower case, drop non-alphanumerics, split, keep >= 3 chars.
  select coalesce(array_agg(w), '{}'::text[]) into v_words
  from pg_catalog.regexp_split_to_table(
    pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.concat_ws(' ',
      v_case.title, v_case.articles, v_answers ->> 'summary', v_answers ->> 'articles', v_answers ->> 'narrative')),
      '[^a-z0-9[:space:]]', '', 'g'),
    '[[:space:]]+') w
  where pg_catalog.char_length(w) >= 3;
  v_word_count := pg_catalog.cardinality(v_words);

  with scored as (
    select c.id, c.article, c.title, c.sort_order,
      (select pg_catalog.count(*)::integer from pg_catalog.unnest(v_words) w
        where pg_catalog.strpos(
          pg_catalog.lower(pg_catalog.array_to_string(c.keywords, ' ') || ' ' || coalesce(c.summary, '')), w) > 0
      ) as match_count
    from public.contract_clauses c
    where c.organization_id = v_case.organization_id and c.status = 'published'
  ), ranked as (
    select s.*, row_number() over (order by s.match_count desc, s.sort_order, s.article, s.id) as position
    from scored s where s.match_count > 0
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id, 'article', r.article, 'title', r.title, 'matchCount', r.match_count,
      'tag', case when r.position = 1 then 'Primary' else 'Supporting' end) order by r.position)
      filter (where r.position <= 3), '[]'::jsonb),
    coalesce(max(r.match_count), 0)
  into v_matches, v_max
  from ranked r;
  v_contract := case when v_max > 0
    then least(100, round(v_max::numeric / greatest(v_word_count, 1) * 100))::integer else 0 end;

  v_inferred := p_evidence_type is null;
  v_evidence_type := coalesce(p_evidence_type, case
    when nullif(pg_catalog.btrim(coalesce(v_answers ->> 'witnesses', '')), '') is not null then 'witness_statements'
    when exists (select 1 from public.member_case_files mf where mf.case_id = v_case.id and mf.removal_id is null
      and mf.mime_type not like 'image/%') then 'documents'
    when exists (select 1 from public.member_case_files mf where mf.case_id = v_case.id and mf.removal_id is null
      and mf.mime_type like 'image/%') then 'photos'
    else 'none' end);
  v_evidence := private.organization_limit(v_case.organization_id, case v_evidence_type
    when 'witness_statements' then 'limits.casework.strength_evidence_witness'
    when 'documents' then 'limits.casework.strength_evidence_documents'
    when 'photos' then 'limits.casework.strength_evidence_photos'
    else 'limits.casework.strength_evidence_none' end);

  v_window := private.organization_limit(v_case.organization_id, 'limits.casework.strength_filing_window_days');
  v_warning_days := private.organization_limit(v_case.organization_id, 'limits.casework.strength_deadline_warning_days');
  if coalesce(v_answers ->> 'incident_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then
    v_incident := (v_answers ->> 'incident_date')::date;
  end if;
  v_procedural := 100;
  if v_incident is not null then
    v_days_since := greatest(0, current_date - v_incident);
    v_procedural := greatest(0, round(100 - v_days_since::numeric / v_window * 100))::integer;
    v_days_remaining := greatest(0, v_window - v_days_since);
  end if;
  select (min(d.due_at) at time zone 'UTC')::date into v_due
  from public.casework_deadlines d
  where d.case_id = v_case.id and d.kind in ('filing', 'procedure') and d.status in ('active', 'extended');
  if v_due is not null then
    v_days_remaining := greatest(0, v_due - current_date);
  end if;

  v_overall := round(v_contract * 0.4 + v_evidence * 0.35 + v_procedural * 0.25)::integer;
  return pg_catalog.jsonb_build_object(
    'overallScore', v_overall,
    'band', case when v_overall < 45 then 'needs_evidence' when v_overall < 75 then 'developing' else 'strong' end,
    'contractScore', v_contract,
    'evidenceScore', v_evidence,
    'proceduralScore', v_procedural,
    'evidenceType', v_evidence_type,
    'evidenceInferred', v_inferred,
    'matchedClauses', v_matches,
    'daysRemaining', v_days_remaining,
    'deadlineWarning', case
      when v_days_remaining is null then null
      when v_days_remaining <= 0 then 'passed'
      when v_days_remaining <= v_warning_days then 'soon' end,
    'warningDays', v_warning_days,
    'suggestedInputs', pg_catalog.jsonb_build_object(
      'contract_support', least(5, round(v_contract / 20.0))::integer,
      'documentation', least(5, round(v_evidence / 20.0))::integer,
      'timeliness', least(5, round(v_procedural / 20.0))::integer,
      'witnesses', case when v_evidence_type = 'witness_statements' then 5 else 0 end));
end;
$function$;

revoke all on function public.casework_suggest_case_strength(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.casework_suggest_case_strength(uuid, text) to authenticated;

comment on function public.casework_suggest_case_strength(uuid, text) is
  'REQ-UG-STRENGTH-ANALYZER-AUTO-SCORING-20261001: deterministic strength suggestion (contract clause match 40%, evidence 35%, procedural 25%) with a filing-deadline warning, for staff who may work the case; read-only, returns no case text. Refused (55000) while features.casework.strength_auto_suggest is off.';

notify pgrst, 'reload schema';

commit;
