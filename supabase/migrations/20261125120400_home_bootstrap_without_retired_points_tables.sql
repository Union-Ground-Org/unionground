-- The member Home bootstrap read the retired points economy's tables.
--
-- public.get_member_home_bootstrap is SECURITY INVOKER and still named
-- public.member_point_rules and public.member_reward_tiers, which this edition
-- closed to clients when it retired points (20261014003000). PostgreSQL checks
-- table privileges for every table a query names when it starts, whichever CASE
-- branch runs, so every member's bootstrap call failed with 42501 "permission
-- denied for table member_point_rules". The function is re-created from its
-- latest definition (20261123104000_case_deadline_time_zones.sql) with those two
-- resources answering an empty list; every other read is unchanged.
begin;
set local lock_timeout = '5s';
set local search_path = pg_catalog;

CREATE OR REPLACE FUNCTION public.get_member_home_bootstrap(p_action_log_since timestamp with time zone, p_resources text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.require_member_session();
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
    -- select MEMBER_CASE_COLUMNS ... eq user_id ... order updated_at desc (time_zone: #9446)
    'member_cases', case when 'member_cases' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.updated_at desc), '[]'::jsonb)
      from (select id, user_id, reference, title, deadline, case_type, articles, step, status, created_at, updated_at, steward_name, coordinator_name, time_zone
            from public.member_cases where user_id = caller order by updated_at desc limit 1000) t) end,
    -- select id,case_id,user_id,body,occurred_on,created_at ... eq user_id ... order created_at
    'member_case_updates', case when 'member_case_updates' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.created_at), '[]'::jsonb)
      from (select id, case_id, user_id, body, occurred_on, created_at from public.member_case_updates where user_id = caller order by created_at limit 1000) t) end,
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
    -- Retired with the points economy: no client may read this table.
    'member_point_rules', case when 'member_point_rules' = any(p_resources) then '[]'::jsonb end,
    -- select tier,name,min_points ... order tier
    -- Retired with the points economy: no client may read this table.
    'member_reward_tiers', case when 'member_reward_tiers' = any(p_resources) then '[]'::jsonb end
  );
end;
$function$;

revoke all on function public.get_member_home_bootstrap(timestamptz, text[]) from public, anon, authenticated, service_role;
grant execute on function public.get_member_home_bootstrap(timestamptz, text[]) to authenticated;
commit;
