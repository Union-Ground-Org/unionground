-- REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001 (restore-everything
-- lane L11a, Compass).
--
-- Page-aware quick help and "Ask about this case". The old app (git ref
-- de7df4b57c^):
--   lib/claude/quick-ask.ts:16-82               page/section-aware quick answers;
--                                               the route label is app-provided,
--                                               never member-typed
--   supabase/migrations/0573_quick_ask_scoped_flag.sql:14-26
--                                               quick_ask_scoped_enabled 'false'
--   components/claude/contextual-ai-card.tsx    "Ask about this case" with three
--                                               fixed questions
--   app/m/cases/[id]/page.tsx:292-300           the card on the member case page,
--                                               shown when claude_enabled, which
--                                               was 'false' in production (0023:153,
--                                               0404, 0406)
-- The old card pasted the case number, issue title and timeline text into the
-- chat as "app-provided context" from the browser. Here the browser sends only
-- the case id and one of the three fixed questions. The server re-reads the
-- case through the caller's own authorization with this RPC and keeps it
-- minimal: status, step label, deadline kinds and day offsets, and timeline
-- event types with day offsets. The case title and the member's case notes
-- (the narrative) are included only while the organization switch
-- features.ai_assistant.case_context_includes_narrative is ON (default OFF),
-- and even then they pass the Compass minimizer before any provider sees
-- them. Case help answers are never saved, and the Fireworks failover uses a
-- per-request prompt-cache isolation key for them, so no case content is
-- reusable from provider caching. Nothing here logs case content.
--
-- public.get_compass_case_context(p_case_id) takes the case-graph identity
-- lock first, then requires: signed in with MFA; the Compass organization
-- (private.member_organization_for, the organization the dispatch gate binds);
-- features.ai_assistant.enabled and features.ai_assistant.case_help on (55000
-- otherwise); and a case in that organization that private.casework_can_read
-- admits (the member's own case, or a case the caller may work as staff, the
-- same helper the casework RLS policies use). A missing and an unreadable case
-- are the same flat P0002.
--
-- Defaults: page-aware help OFF (0573), case help OFF (master gate off in old
-- production), narrative OFF (no old flag; the current Compass contract
-- withholds private case narratives, so an organization must opt in).

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- de7df4b57c^ supabase/migrations/0573_quick_ask_scoped_flag.sql:16-17 ('false').
  ('features.ai_assistant.page_aware_help', 'boolean', 'Compass page-aware help',
   'Let people ask Compass about the page they are on. Compass is told only the page name, never what is on the screen.',
   'false', null, null, null, 300, 'ai_assistant', true),
  -- de7df4b57c^ app/m/cases/[id]/page.tsx:292 gated on claude_enabled ('false': 0023:153, 0404, 0406).
  ('features.ai_assistant.case_help', 'boolean', 'Ask Compass about a case',
   'Show "Ask Compass about this case" on case pages. Compass reads the status, step and deadlines the person can already see.',
   'false', null, null, null, 310, 'ai_assistant', true),
  -- No old flag; default OFF keeps private case narratives out of Compass.
  ('features.ai_assistant.case_context_includes_narrative', 'boolean', 'Include case notes in case help',
   'Also give Compass the case title and recent case notes, after privacy screening. Off sends only status, step and deadlines.',
   'false', null, null, null, 320, 'ai_assistant', true)
on conflict (key) do nothing;

create function public.get_compass_case_context(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  caller uuid;
  org uuid;
  include_narrative boolean;
  case_row public.member_cases%rowtype;
  facts jsonb;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  org := private.member_organization_for(caller);
  if org is null
     or not private.organization_feature_enabled(org, 'features.ai_assistant.enabled')
     or not private.organization_feature_enabled(org, 'features.ai_assistant.case_help') then
    raise exception 'case help is turned off' using errcode = '55000';
  end if;
  include_narrative := private.organization_feature_enabled(org, 'features.ai_assistant.case_context_includes_narrative');

  select c.* into case_row
  from public.member_cases c
  where c.id = p_case_id
    and c.organization_id = org
    and private.casework_can_read(c.id);
  if case_row.id is null then
    raise exception 'case unavailable' using errcode = 'P0002';
  end if;

  facts := pg_catalog.jsonb_build_object(
    'status', case_row.status,
    'step', case_row.step,
    'openedDaysAgo', greatest(0, (current_date - (case_row.created_at at time zone 'UTC')::date)),
    'lastChangeDaysAgo', greatest(0, (current_date - (case_row.updated_at at time zone 'UTC')::date)),
    'caseDeadlineInDays', case when case_row.deadline is null then null else (case_row.deadline - current_date) end,
    'deadlines', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'kind', deadline.kind, 'status', deadline.status,
        'dueInDays', pg_catalog.floor(extract(epoch from (deadline.due_at - pg_catalog.now())) / 86400.0)::integer
      ) order by deadline.due_at)
      from (
        select d.kind, d.status, d.due_at
        from public.casework_deadlines d
        where d.case_id = case_row.id and d.status = 'active'
        order by d.due_at, d.id
        limit 10
      ) deadline
    ), '[]'::jsonb),
    'timeline', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('type', event.kind, 'daysAgo', event.days_ago) order by event.at)
      from (
        select kind, at, greatest(0, (current_date - (at at time zone 'UTC')::date)) as days_ago
        from (
          select 'step_advanced'::text as kind, t.created_at as at
          from public.casework_step_transitions t where t.case_id = case_row.id
          union all
          select 'case_note'::text, u.created_at from public.member_case_updates u where u.case_id = case_row.id
          union all
          select 'outcome_recorded'::text, o.updated_at from public.member_case_outcomes o where o.case_id = case_row.id
        ) events
        order by at desc
        limit 12
      ) event
    ), '[]'::jsonb)
  );

  if include_narrative then
    facts := facts || pg_catalog.jsonb_build_object(
      'title', case_row.title,
      'notes', coalesce((
        select pg_catalog.jsonb_agg(note.body order by note.created_at)
        from (
          select u.body, u.created_at from public.member_case_updates u
          where u.case_id = case_row.id
          order by u.created_at desc
          limit 3
        ) note
      ), '[]'::jsonb));
  end if;

  return pg_catalog.jsonb_build_object(
    'organization_id', org,
    'includesNarrative', include_narrative,
    'data', facts
  );
end;
end;
$function$;

revoke all on function public.get_compass_case_context(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_compass_case_context(uuid) to authenticated;

comment on function public.get_compass_case_context(uuid) is
  'REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001: minimized, switch-gated case facts for "Ask Compass about this case", read through private.casework_can_read in the Compass organization. Title and notes only while case_context_includes_narrative is on.';

notify pgrst, 'reload schema';

commit;
