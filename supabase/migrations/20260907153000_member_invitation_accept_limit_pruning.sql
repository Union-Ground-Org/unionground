begin;

-- SEC-UG-INVITATION-RATE-LIMIT-IPV6-BUCKET-20260907: the acceptance
-- limiter is invoked before invitation-token validation, so expired opaque
-- network buckets need bounded in-band maintenance. The indexed, non-waiting
-- prune also retires rows written with the pre-prefix IPv4 key format once
-- their fixed window closes.
create index member_invitation_accept_limits_window_idx
  on private.member_invitation_accept_limits (window_started_at);

create or replace function public.consume_member_invitation_accept_limit(p_scope_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_row private.member_invitation_accept_limits%rowtype;
  moment timestamptz := clock_timestamp();
  cap constant integer := 20;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-accept-rate:' || p_scope_hash, 509)
  );

  -- At most one transaction takes prune row locks, and the maintenance mutex
  -- never waits. The scope lock comes first so lookup and maintenance share a
  -- single acyclic lock order across concurrent acceptance requests.
  if pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-accept-prune', 509)
  ) then
    delete from private.member_invitation_accept_limits as stale
    where stale.ctid in (
      select candidate.ctid
      from private.member_invitation_accept_limits as candidate
      where candidate.window_started_at <= moment - interval '15 minutes'
      order by candidate.window_started_at, candidate.scope_hash
      limit 200
      for update skip locked
    );
  end if;

  select * into current_row
  from private.member_invitation_accept_limits
  where scope_hash = p_scope_hash
  for update;

  if not found then
    insert into private.member_invitation_accept_limits
      (scope_hash, window_started_at, request_count)
    values (p_scope_hash, moment, 1);
    return pg_catalog.jsonb_build_object('allowed', true, 'remaining', cap - 1);
  end if;
  if current_row.window_started_at + interval '15 minutes' <= moment then
    update private.member_invitation_accept_limits
    set window_started_at = moment, request_count = 1
    where scope_hash = p_scope_hash;
    return pg_catalog.jsonb_build_object('allowed', true, 'remaining', cap - 1);
  end if;
  if current_row.request_count >= cap then
    return pg_catalog.jsonb_build_object('allowed', false, 'remaining', 0);
  end if;
  update private.member_invitation_accept_limits
  set request_count = request_count + 1
  where scope_hash = p_scope_hash;
  return pg_catalog.jsonb_build_object(
    'allowed', true, 'remaining', cap - current_row.request_count - 1
  );
end;
$$;

revoke all on function public.consume_member_invitation_accept_limit(text)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_member_invitation_accept_limit(text)
  to service_role;

comment on function public.consume_member_invitation_accept_limit(text) is
  'Service-only fixed-window invitation acceptance throttle with keyed opaque buckets and bounded closed-window pruning.';

commit;
