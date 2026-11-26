-- Phase 4b follow-up: per-template form point values (design §10 deferred).
--
-- PR1 awarded a flat +15 for every submitted form. This makes the award
-- per-template so high-effort / high-stakes filings earn more: grievance and
-- alliance grievance = 25 (mirrors the existing case=25), non-selection appeals
-- = 20 (mirrors vote=20), FMLA / alt-work = 15 (unchanged default), service
-- request = 10 (mirrors the light survey/steward/workload kinds). Values are a
-- product/gamification decision tunable in ONE place — private.form_points; any
-- unlisted or future template falls back to 15, today's behavior.
--
-- The member_point_rules('form') row is unchanged: it stays the default and
-- still carries the weekly cap (3). Only the award AMOUNT becomes per-template;
-- the cap counts events, so it is unaffected. Every non-form branch of the
-- award trigger is byte-identical to the live definition — award_points
-- defaults to rule.points, so nothing but the form branch changes.

create or replace function private.form_points(p_template_key text)
returns integer language sql immutable set search_path = '' as $$
  select case p_template_key
    when 'grievance'          then 25
    when 'alliance_grievance' then 25
    when 'non_selection'      then 20
    when 'fmla_self'          then 15
    when 'fmla_family'        then 15
    when 'alt_work'           then 15
    when 'service_request'    then 10
    else 15 end;
$$;
revoke all on function private.form_points(text) from public, anon, authenticated;

create or replace function private.award_member_points()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  rule record;
  backed boolean := false;
  awarded_this_week integer;
  award_points integer;
  v_template text;
begin
  if new.action_kind = 'seed' then
    return new;
  end if;
  select points, weekly_cap into rule
  from public.member_point_rules
  where action_kind = new.action_kind and points > 0;
  if not found then
    return new;
  end if;
  -- per-kind default; only the 'form' branch overrides it, per template
  award_points := rule.points;
  if new.action_kind = 'vote' then
    backed := pg_catalog.left(new.action_key, 5) = 'vote-' and exists (
      select 1 from public.member_ballot_votes
      where user_id = new.user_id and ballot_id = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'survey' then
    backed := pg_catalog.left(new.action_key, 7) = 'survey-' and exists (
      select 1 from public.member_survey_responses
      where user_id = new.user_id and survey_id = pg_catalog.substr(new.action_key, 8));
  elsif new.action_kind = 'rights' then
    backed := pg_catalog.left(new.action_key, 7) = 'rights-' and exists (
      select 1 from public.member_rights_progress
      where user_id = new.user_id and lesson_id = pg_catalog.substr(new.action_key, 8)
        and pg_catalog.cardinality(completed_steps) > 0);
  elsif new.action_kind = 'case' then
    backed := pg_catalog.left(new.action_key, 5) = 'case-' and exists (
      select 1 from public.member_cases
      where user_id = new.user_id and reference = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'message' then
    backed := exists (
      select 1 from public.member_conversations
      where user_id = new.user_id
        and id::text = (pg_catalog.regexp_match(new.action_key, '^message-(.*)-[0-9]+$'))[1]);
  elsif new.action_kind = 'steward' then
    backed := exists (
      select 1 from public.member_steward_requests
      where user_id = new.user_id
        and coalesce(lesson_id, '') = coalesce((pg_catalog.regexp_match(new.action_key, '^steward-(.*)-[0-9]+$'))[1], ''));
  elsif new.action_kind = 'rsvp' then
    backed := pg_catalog.left(new.action_key, 5) = 'rsvp-' and exists (
      select 1 from public.member_event_rsvps
      where user_id = new.user_id and event_id = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'checkin' then
    backed := pg_catalog.left(new.action_key, 8) = 'checkin-' and exists (
      select 1 from public.member_event_checkins
      where user_id = new.user_id and event_id = pg_catalog.substr(new.action_key, 9));
  elsif new.action_kind = 'workload' then
    backed := pg_catalog.left(new.action_key, 9) = 'workload-' and exists (
      select 1 from public.member_workload_logs
      where user_id = new.user_id and id::text = pg_catalog.substr(new.action_key, 10));
  elsif new.action_kind = 'form' then
    -- prefix-anchored + backed by a caller-owned, non-draft form; the award
    -- amount is this form's template value rather than the flat rule default.
    if pg_catalog.left(new.action_key, 5) = 'form-' then
      select template_key into v_template from public.member_forms
      where user_id = new.user_id and id::text = pg_catalog.substr(new.action_key, 6)
        and status <> 'draft';
      if found then
        backed := true;
        award_points := private.form_points(v_template);
      end if;
    end if;
  end if;
  if not backed then
    return new;
  end if;
  if rule.weekly_cap is not null then
    select count(*) into awarded_this_week
    from public.member_point_events
    where user_id = new.user_id and action_kind = new.action_kind
      and occurred_at >= pg_catalog.date_trunc('week', now());
    if awarded_this_week >= rule.weekly_cap then
      return new;
    end if;
  end if;
  insert into public.member_point_events (user_id, action_key, action_kind, points)
  values (new.user_id, new.action_key, new.action_kind, award_points)
  on conflict (user_id, action_key) do nothing;
  return new;
end;
$function$;
