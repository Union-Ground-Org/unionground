-- UB-SET-05: self-scoped session inventory. Raw auth session ids, IPs and
-- user-agent strings never cross the RPC boundary; the latter is reduced to
-- coarse, non-unique labels inside Postgres.

create function public.list_my_sessions()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  current_session text := (select auth.jwt() ->> 'session_id');
  payload jsonb;
begin
  if caller is null then
    raise exception 'member session required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'deviceLabel', case
      when coalesce(s.user_agent, '') ~* 'iphone|ipad|ipod' then 'apple_mobile'
      when coalesce(s.user_agent, '') ~* 'android' then 'android_mobile'
      when coalesce(s.user_agent, '') ~* 'windows' then 'windows_computer'
      when coalesce(s.user_agent, '') ~* 'macintosh|mac os' then 'apple_computer'
      when coalesce(s.user_agent, '') ~* 'linux' then 'linux_computer'
      else 'signed_in_device'
    end,
    'browserLabel', case
      when coalesce(s.user_agent, '') ~* 'edg/' then 'edge'
      when coalesce(s.user_agent, '') ~* 'firefox/' then 'firefox'
      when coalesce(s.user_agent, '') ~* 'chrome/|crios/' then 'chrome'
      when coalesce(s.user_agent, '') ~* 'safari/' then 'safari'
      else 'browser'
    end,
    'current', s.id::text = current_session,
    'createdAt', s.created_at,
    'lastActiveAt', coalesce(s.updated_at, s.created_at)
  ) order by (s.id::text = current_session) desc, coalesce(s.updated_at, s.created_at) desc), '[]'::jsonb)
  into payload
  from auth.sessions s
  where s.user_id = caller;

  return payload;
end;
$$;

revoke all on function public.list_my_sessions() from public, anon;
grant execute on function public.list_my_sessions() to authenticated;
