-- PERF-UG-COLD-HOME-BOOTSTRAP-ONE-CALL-20261028
--
-- Authenticated cold Home issued 35 transport operations at concurrency 4
-- before the route could paint (37 through the first realtime SUBSCRIBED
-- reconciliation), measured on Main 58d5d60317 with the deterministic member
-- boot harness. Eighteen of them are plain table reads with exactly one query
-- shape each: the member's own rows and small reference rows. This function
-- returns all eighteen in one call so the client makes one round trip for
-- them instead of eighteen; a later refresh names only the reads it needs in
-- p_resources and pays for those alone. Project decision, October 28, 2026, about 10:27 AM ET:
-- the cold Home request ceiling is no longer a floor, provided the same
-- consumer data still reaches the route.
--
-- Parity, not a new read model: every sub-select carries exactly the columns,
-- filters, order and limits of the PostgREST read it replaces
-- (src/lib/memberApi.js loadMemberApp, registered as query shapes in
-- src/lib/memberHomeBootstrap.js and proved row for row by
-- tests/member-home-bootstrap-db.test.js). The function is SECURITY INVOKER:
-- it runs as the caller, so every row-level security policy and column grant
-- applies exactly as it does to the direct reads, and it adds no visibility.
-- The unbounded reads carry the same 1000-row bound PostgREST applies
-- (supabase/config.toml max_rows). user_id echoes the caller so the client can
-- refuse a payload that is not its own.
--
-- The client keeps every per-resource read: a resource whose query shape or
-- epoch differs, a missing array or a failed call falls back to that
-- resource's own read, so a pre-migration environment degrades to today's
-- fan-out and nothing is dropped.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function public.get_member_home_bootstrap(p_action_log_since timestamptz, p_resources text[])
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_action_log_since is null then
    raise exception 'action log window required' using errcode = '22023';
  end if;
  if p_resources is null or pg_catalog.cardinality(p_resources) = 0 then
    raise exception 'resource list required' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object(
    'user_id', caller,
    -- select * ... eq user_id ... order created_at desc
    'member_notifications', case when 'member_notifications' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
      from (select * from public.member_notifications where user_id = caller order by created_at desc limit 1000) t) end,
    -- select role ... eq user_id
    'member_roles', case when 'member_roles' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role', t.role)), '[]'::jsonb)
      from (select role from public.member_roles where user_id = caller limit 1000) t) end,
    -- select id,name ... order order_index
    'chapters', case when 'chapters' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'name', t.name) order by t.order_index), '[]'::jsonb)
      from (select id, name, order_index from public.chapters order by order_index limit 1000) t) end,
    -- select MEMBER_CASE_COLUMNS ... eq user_id ... order updated_at desc
    'member_cases', case when 'member_cases' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.updated_at desc), '[]'::jsonb)
      from (select id, user_id, reference, title, deadline, case_type, articles, step, status, created_at, updated_at, steward_name, coordinator_name
            from public.member_cases where user_id = caller order by updated_at desc limit 1000) t) end,
    -- select id,case_id,user_id,body,created_at ... eq user_id ... order created_at
    'member_case_updates', case when 'member_case_updates' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.created_at), '[]'::jsonb)
      from (select id, case_id, user_id, body, created_at from public.member_case_updates where user_id = caller order by created_at limit 1000) t) end,
    -- select id,sender,title,body,published_at,locale,audience_scope ... is retracted_at null ... order published_at desc ... limit 50
    'member_broadcasts', case when 'member_broadcasts' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.published_at desc), '[]'::jsonb)
      from (select id, sender, title, body, published_at, locale, audience_scope
            from public.member_broadcasts where retracted_at is null order by published_at desc limit 50) t) end,
    -- select broadcast_id,read_at ... eq user_id
    'member_broadcast_receipts', case when 'member_broadcast_receipts' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select broadcast_id, read_at from public.member_broadcast_receipts where user_id = caller limit 1000) t) end,
    -- select <ballot columns>,member_ballot_options(id,ballot_id,label,label_es,order_index) ... order order_index
    'member_ballots', case when 'member_ballots' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.order_index), '[]'::jsonb)
      from (select b.id, b.title, b.title_es, b.body, b.body_es, b.closes_at, b.active, b.order_index, b.quorum_target, b.chapter_id,
                   b.campaign_state, b.published_at, b.closed_at,
                   (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.order_index), '[]'::jsonb)
                    from (select id, ballot_id, label, label_es, order_index from public.member_ballot_options where ballot_id = b.id) o)
                     as member_ballot_options
            from public.member_ballots b order by b.order_index limit 1000) t) end,
    -- select <survey columns>,member_survey_options(id,survey_id,label,label_es,order_index) ... order order_index
    'member_surveys', case when 'member_surveys' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.order_index), '[]'::jsonb)
      from (select s.id, s.title, s.title_es, s.body, s.body_es, s.closes_at, s.active, s.order_index, s.chapter_id,
                   s.campaign_state, s.published_at, s.closed_at,
                   (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.order_index), '[]'::jsonb)
                    from (select id, survey_id, label, label_es, order_index from public.member_survey_options where survey_id = s.id) o)
                     as member_survey_options
            from public.member_surveys s order by s.order_index limit 1000) t) end,
    -- select survey_id,option_id ... eq user_id
    'member_survey_responses', case when 'member_survey_responses' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select survey_id, option_id from public.member_survey_responses where user_id = caller limit 1000) t) end,
    -- select * ... order order_index
    'member_rights_lessons', case when 'member_rights_lessons' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.order_index), '[]'::jsonb)
      from (select * from public.member_rights_lessons order by order_index limit 1000) t) end,
    -- select lesson_id,completed_steps ... eq user_id
    'member_rights_progress', case when 'member_rights_progress' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select lesson_id, completed_steps from public.member_rights_progress where user_id = caller limit 1000) t) end,
    -- select action_key,action_kind,occurred_at ... eq user_id ... gte occurred_at <since> ... order occurred_at
    'member_action_log', case when 'member_action_log' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.occurred_at), '[]'::jsonb)
      from (select action_key, action_kind, occurred_at from public.member_action_log
            where user_id = caller and occurred_at >= p_action_log_since order by occurred_at limit 1000) t) end,
    -- select ballot_id,receipt_code,issued_at ... eq user_id
    'member_ballot_receipts', case when 'member_ballot_receipts' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select ballot_id, receipt_code, issued_at from public.member_ballot_receipts where user_id = caller limit 1000) t) end,
    -- select event_id,status ... eq user_id
    'member_event_rsvps', case when 'member_event_rsvps' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select event_id, status from public.member_event_rsvps where user_id = caller limit 1000) t) end,
    -- select event_id ... eq user_id
    'member_event_checkins', case when 'member_event_checkins' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select event_id from public.member_event_checkins where user_id = caller limit 1000) t) end,
    -- select action_kind,label,points,weekly_cap ... order points desc
    'member_point_rules', case when 'member_point_rules' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.points desc), '[]'::jsonb)
      from (select action_kind, label, points, weekly_cap from public.member_point_rules order by points desc limit 1000) t) end,
    -- select tier,name,min_points ... order tier
    'member_reward_tiers', case when 'member_reward_tiers' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.tier), '[]'::jsonb)
      from (select tier, name, min_points from public.member_reward_tiers order by tier limit 1000) t) end
  );
end;
$function$;

revoke all on function public.get_member_home_bootstrap(timestamptz, text[]) from public, anon, authenticated, service_role;
grant execute on function public.get_member_home_bootstrap(timestamptz, text[]) to authenticated;

comment on function public.get_member_home_bootstrap(timestamptz, text[]) is
  'PERF-UG-COLD-HOME-BOOTSTRAP-ONE-CALL-20261028: the plain cold-Home table reads the member App names in p_resources, in one call as the caller (security invoker, RLS and column grants unchanged), each array row-equal to the PostgREST read it replaces; user_id echoes the caller.';

commit;
