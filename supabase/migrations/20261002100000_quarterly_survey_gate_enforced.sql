-- REQ-UG-QUARTERLY-SURVEY-GATE-ENFORCED-20261001 (clean-room parity CR-002,
-- restore-everything VOICE).
--
-- "Give to view": a member who has not completed the current quarter's open
-- survey sees charts, reports and workload dimmed and non-interactive, with a
-- banner that links to the survey. The old app (git ref de7df4b57c^):
--   lib/surveys/quarterly-gate.ts:43-121   soft gate, admin bypass (line 61),
--                                         fails open with no quarterly survey
--                                         configured (66-71) or a stale id (77-86)
--   components/quarterly-gate/*.tsx        dimmed overlay + survey banner
--   app/dashboard/charts/page.tsx:78-113   and app/dashboard/workload/page.tsx:96-108
--
-- public.get_quarterly_survey_gate() already computed `unlocked`, but nothing
-- read it and it disagreed with what a member can actually answer (it ignored
-- the survey's chapter scope and open window). This migration makes the RPC the
-- one server-side authority the web and native gates read:
--   * the organization switch features.engagement_voice.quarterly_survey_gate
--     (read with the settings helper) turns the gate off for the whole
--     organization; the default is ON because the old app had no flag and was
--     active whenever a quarterly survey existed (quarterly-gate.ts:8-11);
--   * organization admins always pass (quarterly-gate.ts:59-63);
--   * the gate only locks while the member can answer the survey: it is open,
--     in its window, and organization-wide or scoped to the member's chapter.
--     Anything else fails open, exactly like the old stale-id guard;
--   * a submitted session for that survey unlocks the pages.
-- The payload keeps every existing key (the member engagement snapshot embeds
-- it) and adds `reason` and `gateEnabled`.
--
-- Boundaries kept: same signature, SECURITY DEFINER, empty search_path, the
-- existing MFA + active-membership refusal, the caller's own organization and
-- session only. No table, grant or policy changes. Production stays empty: the
-- only row written is the platform setting definition.

begin;

set local lock_timeout = '5s';

-- Old default: no flag existed; the gate was live whenever a quarterly survey
-- was configured (de7df4b57c^ lib/surveys/quarterly-gate.ts:8-11, 66-71) => ON.
insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.engagement_voice.quarterly_survey_gate', 'boolean', 'Quarterly survey unlocks stats and workload',
   'Members who have not completed this quarter''s open survey see charts, reports and workload dimmed, with a link to the survey. Admins are exempt.',
   'true', null, null, null, 10, 'engagement_voice', true)
on conflict (key) do nothing;

create or replace function public.get_quarterly_survey_gate()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  actor_chapter text := private.current_member_chapter();
  current_period text := pg_catalog.to_char(current_date, 'YYYY')
    || '-Q' || pg_catalog.date_part('quarter', current_date)::integer;
  gate_enabled boolean;
  is_admin boolean;
  survey public.organization_surveys%rowtype;
  answerable boolean;
  session_status text;
  completed boolean;
  gate_reason text;
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  gate_enabled := private.organization_feature_enabled(org, 'features.engagement_voice.quarterly_survey_gate');
  is_admin := private.has_organization_role(org, array['admin']);

  select * into survey
  from public.organization_surveys s
  where s.organization_id = org
    and s.cadence = 'quarterly'
    and s.period_key = current_period
    and s.status in ('open', 'closed')
  order by case when s.status = 'open' then 0 else 1 end, s.updated_at desc
  limit 1;

  if not found then
    return pg_catalog.jsonb_build_object(
      'periodKey', current_period, 'surveyId', null, 'required', false,
      'completed', false, 'unlocked', true,
      'reason', case when is_admin then 'admin' when not gate_enabled then 'disabled' else 'no_survey' end,
      'gateEnabled', gate_enabled
    );
  end if;

  answerable := survey.status = 'open'
    and (survey.chapter_id is null or survey.chapter_id = actor_chapter)
    and (survey.opens_at is null or survey.opens_at <= pg_catalog.now())
    and (survey.closes_at is null or survey.closes_at > pg_catalog.now());

  select session.status into session_status
  from public.organization_survey_sessions session
  where session.organization_id = org
    and session.survey_id = survey.id
    and session.respondent_user_id = actor;
  completed := coalesce(session_status = 'submitted', false);

  gate_reason := case
    when is_admin then 'admin'
    when not gate_enabled then 'disabled'
    when completed then 'completed'
    when not answerable then 'unavailable'
    else 'incomplete'
  end;

  return pg_catalog.jsonb_build_object(
    'periodKey', current_period,
    'surveyId', survey.id,
    'title', survey.title,
    'required', answerable,
    'completed', completed,
    'unlocked', gate_reason <> 'incomplete',
    'reason', gate_reason,
    'gateEnabled', gate_enabled,
    'status', coalesce(session_status, 'not_started'),
    'closesAt', survey.closes_at
  );
end;
$function$;

comment on function public.get_quarterly_survey_gate() is
  'Quarterly "give to view" gate (CR-002). unlocked=false only when the organization switch features.engagement_voice.quarterly_survey_gate is on, the caller is not an organization admin, and the current quarter''s open, in-window, chapter-visible quarterly survey has no submitted session from the caller. Every other case fails open.';

notify pgrst, 'reload schema';

commit;
