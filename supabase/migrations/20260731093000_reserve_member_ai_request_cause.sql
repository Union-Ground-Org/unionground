-- Atomic 429 attribution for Compass. reserve_member_ai_request answers both
-- caps with the same null, so api/guide.js had to re-count the member's rows
-- after the fact and absorb the TOCTOU race with a guard band (the 18-19
-- generic zone). This v2 names the denied cap inside the same advisory-locked
-- transaction that counted, so the attribution can never disagree with the
-- decision it explains.
--
-- The uuid-returning reserve_member_ai_request(uuid) stays deployed on
-- purpose: api/guide.js falls back to it when v2 is missing (code deployed
-- before this migration lands), trading 429 copy precision for availability.

create function public.reserve_member_ai_request_v2(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation_id uuid;
  recent_user_count integer;
  recent_global_count integer;
begin
  if p_user_id is null then
    return pg_catalog.jsonb_build_object('id', null, 'cause', null);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-ai-global', 509)
  );

  delete from public.member_ai_requests
  where created_at < now() - interval '2 hours';

  -- The member's own cap is checked FIRST, unlike the original's org-first
  -- order: when both caps are exhausted at once the member hears about the
  -- one they can act on, and a member sitting at their own 20 learns nothing
  -- about chapter-wide load. The allow/deny outcome is identical either way.
  select count(*)
    into recent_user_count
    from public.member_ai_requests
    where user_id = p_user_id
      and created_at >= now() - interval '1 hour';

  if recent_user_count >= 20 then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'member');
  end if;

  select count(*)
    into recent_global_count
    from public.member_ai_requests
    where created_at >= now() - interval '1 hour';

  if recent_global_count >= 200 then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'org');
  end if;

  insert into public.member_ai_requests (user_id)
  values (p_user_id)
  returning id into reservation_id;

  return pg_catalog.jsonb_build_object('id', reservation_id, 'cause', null);
end;
$$;

revoke all on function public.reserve_member_ai_request_v2(uuid) from public, anon, authenticated;
grant execute on function public.reserve_member_ai_request_v2(uuid) to service_role;
