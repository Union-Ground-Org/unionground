-- REQ-UG-COMPASS-ACTION-OFFERS-20261001 (CR-099) and
-- REQ-UG-COMPASS-CONTEXTUAL-NUDGES-20261001 (restore-everything lane L11a).
--
-- Action offers. The old app (git ref de7df4b57c^):
--   lib/claude/tools/ui-tools.ts:31-104     offer_save_item, offer_pin_home_card
--                                           (everyone) and propose_action
--                                           (staff: create_task, add_case_note,
--                                           send_broadcast) behind an approval card
--   lib/ai-assistant/approved-actions-*.ts  approve -> the canonical server action
--   components/claude/forward-picker-dialog.tsx  copy + open message/task/event
--   supabase/migrations/0273_claude_workspace_offers_flag.sql  seeded 'true',
--   0406_realign_claude_flags_and_enable_workload_tracker.sql:48-52 set it
--   'false' to match the master gate => default OFF.
-- Every offered write is an explicit confirmation in the client and goes
-- through the existing authorized path for that object (chapter_tasks insert
-- under its RLS, public.publish_member_broadcast, member_case_updates insert
-- under its RLS). The one new write is pinning a saved Compass answer to Home:
-- member_guide_messages gains pinned_at, written only by
-- public.set_compass_answer_pinned for the caller's own assistant messages,
-- at most six at a time, while features.ai_assistant.action_offers is on.
--
-- Contextual nudges. Old lib/claude/contextual-nudges.ts (8e554d88fe,
-- 2026-05-03): staff saw overdue cases and active retaliation patterns;
-- members saw a retaliation pattern flagged on their own case; urgent nudges
-- opened the assistant. public.get_compass_nudges() returns counts only:
--   staff  overdue cases in the caller's chapter scope (the
--          casework_dashboard open-case set and overdue rule) and flagged or
--          investigating retaliation patterns under their RLS policy predicate;
--   member the caller's own retaliation reports that are still open
--          (submitted or in review): the existing member-readable signal.
--          's retaliationFlagged summary is not on Main yet; switching
--          to it is a follow-up once it merges.
-- No old flag of its own; the old master gate claude_enabled was 'false' in
-- production (0023:153, 0404, 0406) => default OFF.

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- de7df4b57c^ 0273_claude_workspace_offers_flag.sql seeded 'true'; 0406:48-52 set 'false' (master gate off).
  ('features.ai_assistant.action_offers', 'boolean', 'Compass action offers',
   'Offer to pin a Compass answer to Home, forward it, or (staff) turn it into a task or announcement. Nothing happens until the person confirms.',
   'false', null, null, null, 400, 'ai_assistant', true),
  -- de7df4b57c^ lib/claude/contextual-nudges.ts had no flag; master gate claude_enabled 'false' (0404, 0406).
  ('features.ai_assistant.contextual_nudges', 'boolean', 'Compass attention nudges',
   'Show overdue cases and retaliation patterns (staff) and open retaliation reports (members) in Compass; open it once per session when one is urgent.',
   'false', null, null, null, 410, 'ai_assistant', true)
on conflict (key) do nothing;

alter table public.member_guide_messages
  add column pinned_at timestamptz;

create index member_guide_messages_pinned_idx
  on public.member_guide_messages (user_id, pinned_at desc)
  where pinned_at is not null;

comment on column public.member_guide_messages.pinned_at is
  'REQ-UG-COMPASS-ACTION-OFFERS-20261001: when the owner pinned this Compass answer to Home; written only by public.set_compass_answer_pinned.';

create function public.set_compass_answer_pinned(p_message_id uuid, p_pinned boolean)
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
  message_row public.member_guide_messages%rowtype;
  pinned_count integer;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  org := private.member_organization_for(caller);
  if not private.organization_feature_enabled(org, 'features.ai_assistant.enabled')
     or not private.organization_feature_enabled(org, 'features.ai_assistant.action_offers') then
    raise exception 'action offers are turned off' using errcode = '55000';
  end if;
  if p_pinned is null then
    raise exception 'pinned state required' using errcode = '22023';
  end if;
  select m.* into message_row
  from public.member_guide_messages m
  where m.id = p_message_id and m.user_id = caller and m.role = 'assistant'
  for update;
  if message_row.id is null then
    raise exception 'answer unavailable' using errcode = 'P0002';
  end if;
  if p_pinned and message_row.pinned_at is null then
    select pg_catalog.count(*)::integer into pinned_count
    from public.member_guide_messages m
    where m.user_id = caller and m.pinned_at is not null;
    if pinned_count >= 6 then
      raise exception 'pin limit reached' using errcode = '54000';
    end if;
    update public.member_guide_messages set pinned_at = pg_catalog.now() where id = message_row.id
    returning * into message_row;
  elsif not p_pinned and message_row.pinned_at is not null then
    update public.member_guide_messages set pinned_at = null where id = message_row.id
    returning * into message_row;
  end if;
  return pg_catalog.jsonb_build_object('id', message_row.id, 'pinnedAt', message_row.pinned_at);
end;
end;
$function$;

revoke all on function public.set_compass_answer_pinned(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_compass_answer_pinned(uuid, boolean) to authenticated;

-- Home reads pins through this call, never through the shared member boot
-- select, so a client that ships before this migration never asks for a
-- column that does not exist yet.
create function public.list_compass_pinned_answers()
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
  pins jsonb;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  org := private.member_organization_for(caller);
  if not private.organization_feature_enabled(org, 'features.ai_assistant.enabled')
     or not private.organization_feature_enabled(org, 'features.ai_assistant.action_offers') then
    return '[]'::jsonb;
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', answer.id, 'threadId', answer.thread_id, 'answer', answer.body,
      'sources', coalesce(answer.sources, '[]'::jsonb), 'pinnedAt', answer.pinned_at,
      'question', (
        select asked.body from public.member_guide_messages asked
        where asked.user_id = caller and asked.thread_id = answer.thread_id
          and asked.role = 'user' and asked.created_at <= answer.created_at
        order by asked.created_at desc limit 1)
    ) order by answer.pinned_at desc), '[]'::jsonb)
  into pins
  from (
    select m.id, m.thread_id, m.body, m.sources, m.pinned_at, m.created_at
    from public.member_guide_messages m
    where m.user_id = caller and m.role = 'assistant' and m.pinned_at is not null
    order by m.pinned_at desc
    limit 6
  ) answer;
  return pins;
end;
end;
$function$;

revoke all on function public.list_compass_pinned_answers() from public, anon, authenticated, service_role;
grant execute on function public.list_compass_pinned_answers() to authenticated;

create function public.get_compass_nudges()
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
  chapter text;
  overdue_cases integer;
  open_patterns integer;
  open_reports integer;
  staff_nudges jsonb;
  member_nudges jsonb;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  org := private.member_organization_for(caller);
  if org is null
     or not private.organization_feature_enabled(org, 'features.ai_assistant.enabled')
     or not private.organization_feature_enabled(org, 'features.ai_assistant.contextual_nudges') then
    return pg_catalog.jsonb_build_object('enabled', false, 'staff', '[]'::jsonb, 'member', '[]'::jsonb);
  end if;
  chapter := private.current_member_chapter();
  staff_nudges := '[]'::jsonb;
  member_nudges := '[]'::jsonb;

  -- The casework dashboard's own open-case scope (organization and chapter,
  -- then private.casework_staff_can_access) and its overdue rule.
  if chapter is not null and private.actor_has_chapter_staff_role(caller, chapter) then
    select pg_catalog.count(distinct deadline.case_id)::integer into overdue_cases
    from public.casework_deadlines deadline
    join private.casework_dashboard_open_cases() visible on visible.case_id = deadline.case_id
    where deadline.status in ('active', 'extended')
      and deadline.due_at < pg_catalog.now();
    if overdue_cases > 0 then
      staff_nudges := staff_nudges || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'id', 'overdue-cases', 'count', overdue_cases, 'urgent', overdue_cases >= 2));
    end if;
  end if;

  -- The casework_retaliation_patterns_staff policy predicate, applied explicitly.
  select pg_catalog.count(*)::integer into open_patterns
  from public.casework_retaliation_patterns pattern
  where pattern.organization_id = org
    and pattern.status in ('flagged', 'investigating')
    and (
      (pattern.chapter_id is not null and private.member_has_chapter_role(pattern.chapter_id, array['coordinator', 'advisor', 'admin', 'vp']))
      or private.has_organization_role(org, array['coordinator', 'advisor', 'admin', 'vp'])
    );
  if open_patterns > 0 then
    staff_nudges := staff_nudges || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'id', 'retaliation-patterns', 'count', open_patterns, 'urgent', true));
  end if;

  -- The member's own open retaliation reports, the rows the
  -- casework_retaliation_reports_read policy already shows the reporter.
  select pg_catalog.count(*)::integer into open_reports
  from public.casework_retaliation_reports report
  where report.organization_id = org
    and report.reporter_user_id = caller
    and report.status in ('submitted', 'in_review');
  if open_reports > 0 then
    member_nudges := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'id', 'retaliation-flag', 'count', open_reports, 'urgent', true));
  end if;

  return pg_catalog.jsonb_build_object('enabled', true, 'staff', staff_nudges, 'member', member_nudges);
end;
end;
$function$;

revoke all on function public.get_compass_nudges() from public, anon, authenticated, service_role;
grant execute on function public.get_compass_nudges() to authenticated;

comment on function public.get_compass_nudges() is
  'REQ-UG-COMPASS-CONTEXTUAL-NUDGES-20261001: switch-gated counts for Compass attention nudges (staff overdue cases and open retaliation patterns in their scope; the caller''s own open retaliation reports). No case identifiers or text.';

notify pgrst, 'reload schema';

commit;
