-- A factor reset must invalidate every access token issued before the reset,
-- even when GoTrue's best-effort logout request fails. Supabase access tokens
-- are locally valid JWTs until expiry; removing the last TOTP factor would
-- otherwise turn the old token into an MFA-satisfied token.
begin;

set local lock_timeout = '5s';

create table private.member_mfa_reset_boundaries (
  user_id uuid primary key references auth.users(id) on delete cascade,
  invalid_before timestamptz not null,
  reset_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);

revoke all on private.member_mfa_reset_boundaries
  from public, anon, authenticated, service_role;

comment on table private.member_mfa_reset_boundaries is
  'Latest administrator MFA-reset boundary per user. Only Auth sessions created after invalid_before may satisfy the application MFA predicate.';

create or replace function private.mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when claims.user_id is null then false
    when coalesce(claims.session_id, '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then false
    when not exists (
      select 1
      from auth.sessions session
      left join private.member_mfa_reset_boundaries boundary
        on boundary.user_id = session.user_id
      where session.id = claims.session_id::uuid
        and session.user_id = claims.user_id
        and session.created_at > coalesce(
          boundary.invalid_before,
          '-infinity'::timestamptz
        )
    ) then false
    when claims.aal = 'aal2' then true
    else not exists (
      select 1
      from auth.mfa_factors factor
      where factor.user_id = claims.user_id
        and factor.status = 'verified'
        and factor.factor_type = 'totp'
    )
  end
  from (
    select
      (select auth.uid()) as user_id,
      (select auth.jwt() ->> 'session_id') as session_id,
      (select auth.jwt() ->> 'aal') as aal
  ) claims;
$function$;

comment on function private.mfa_satisfied() is
  'RLS predicate: requires a live Auth session newer than the latest administrator reset, then accepts AAL2 or no verified TOTP factor.';

create function public.begin_mfa_reset(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  boundary_at timestamptz := pg_catalog.clock_timestamp();
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'target required' using errcode = '22023';
  end if;
  if p_user_id = caller then
    raise exception 'an admin cannot reset their own second factor' using errcode = '42501';
  end if;
  if not exists (select 1 from public.member_profiles where id = p_user_id) then
    raise exception 'unknown member' using errcode = '22023';
  end if;

  insert into private.member_mfa_reset_boundaries (user_id, invalid_before, reset_by)
  values (p_user_id, boundary_at, caller)
  on conflict (user_id) do update
    set invalid_before = greatest(
          private.member_mfa_reset_boundaries.invalid_before,
          excluded.invalid_before
        ),
        reset_by = excluded.reset_by,
        created_at = pg_catalog.clock_timestamp();

  return pg_catalog.jsonb_build_object(
    'userId', p_user_id,
    'authorized', true,
    'staleSessionsBlocked', true
  );
end;
$function$;

revoke all on function public.begin_mfa_reset(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_mfa_reset(uuid) to authenticated;

comment on function public.begin_mfa_reset(uuid) is
  'MFA-gated administrator authorization that records the target reset boundary before any factor deletion. Self-reset remains forbidden.';

notify pgrst, 'reload schema';

commit;
