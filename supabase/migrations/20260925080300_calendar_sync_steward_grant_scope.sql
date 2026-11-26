-- SEC-UG-CALENDAR-CONNECTION-STEWARD-GRANT-SCOPE-20260920
--
-- public.list_steward_calendar_oauth_tokens is the whole inventory the daily
-- api/calendar-sync.js worker iterates, and it carried no steward-grant,
-- chapter or organization predicate on the connection owner. After a steward
-- grant was revoked, or the chapter or organization membership behind it
-- lapsed, the worker kept refreshing that person's Google/Microsoft token
-- every day and reading 60 days of their personal calendar. The person could
-- not stop it: public.remove_calendar_connection required the steward role
-- that had just gone false.
--
-- 1. private.calendar_steward_grant_active(user) states "holds an active,
--    membership-backed steward grant" for an arbitrary user, and the inventory
--    returns only connections whose owner passes it. A lapsed grant drops the
--    connection from the next sync run; a restored grant brings it back
--    without reconnecting.
-- 2. public.remove_calendar_connection drops the steward-role gate. It still
--    requires an authenticated, MFA-satisfied caller and touches only the
--    caller's own rows, so a former steward can always remove their own
--    connection. The case-graph lock prologue 20260907151000 wrapped around it
--    is kept.
-- Grants on the two public functions are preserved by CREATE OR REPLACE.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function private.calendar_steward_grant_active(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_user_id is not null and (
    -- Organization-level steward grant inside an active membership of an
    -- active organization.
    exists (
      select 1
      from public.organization_role_grants grant_row
      join public.organization_memberships membership
        on membership.organization_id = grant_row.organization_id
       and membership.user_id = grant_row.user_id
       and membership.status = 'active'
      join public.organizations organization
        on organization.id = grant_row.organization_id
       and organization.status = 'active'
      where grant_row.user_id = p_user_id
        and grant_row.role = 'steward'
    )
    -- Chapter-level steward grant inside an active chapter membership; a
    -- chapter that belongs to an organization also needs an active membership
    -- of that active organization.
    or exists (
      select 1
      from public.member_role_chapters chapter_role
      join public.member_chapter_memberships chapter_membership
        on chapter_membership.user_id = chapter_role.user_id
       and chapter_membership.chapter_id = chapter_role.chapter_id
       and chapter_membership.status = 'active'
      join public.chapters chapter on chapter.id = chapter_role.chapter_id
      where chapter_role.user_id = p_user_id
        and chapter_role.role = 'steward'
        and (
          chapter.organization_id is null
          or exists (
            select 1
            from public.organization_memberships membership
            join public.organizations organization
              on organization.id = membership.organization_id
             and organization.status = 'active'
            where membership.organization_id = chapter.organization_id
              and membership.user_id = p_user_id
              and membership.status = 'active'
          )
        )
    )
    -- Legacy unscoped steward role, honoured by public.member_has_role only
    -- for a person with no active organization membership.
    or (
      exists (
        select 1 from public.member_roles legacy_role
        where legacy_role.user_id = p_user_id
          and legacy_role.role = 'steward'
          and legacy_role.chapter_id is null
      )
      and not exists (
        select 1 from public.organization_memberships membership
        where membership.user_id = p_user_id and membership.status = 'active'
      )
    )
  );
$function$;

revoke all on function private.calendar_steward_grant_active(uuid)
  from public, anon, authenticated, service_role;

comment on function private.calendar_steward_grant_active(uuid) is
  'Whether a person still holds an active, membership-backed steward grant anywhere (organization grant, chapter grant, or legacy unscoped role). Gates the calendar sync worker inventory, which runs as service_role and cannot use public.member_has_role.';

create or replace function public.list_steward_calendar_oauth_tokens()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'stewardId', token.steward_id,
      'provider', token.provider,
      'refreshTokenCiphertext', token.refresh_token_ciphertext,
      'scopes', token.scopes,
      'status', connection.status,
      'lastSyncAttemptAt', connection.updated_at
    ) order by connection.updated_at, token.steward_id, token.provider)
    from private.steward_calendar_oauth_tokens token
    join public.member_calendar_connections connection
      on connection.steward_id = token.steward_id
     and connection.provider = token.provider
     and connection.status <> 'revoked'
    -- Only a person who still holds an active, membership-backed steward
    -- grant keeps a connection in the worker inventory.
    where private.calendar_steward_grant_active(token.steward_id)
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.remove_calendar_connection(p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- No steward-role gate: every statement below is bound to the caller's own
  -- rows (steward_id = caller), and a person whose steward grant has lapsed
  -- must still be able to remove the connection they made while it held.
  if p_provider is null or p_provider not in ('google', 'microsoft') then
    raise exception 'provider must be google or microsoft' using errcode = '22023';
  end if;
  delete from public.member_calendar_busy
  where steward_id = caller and provider = p_provider;
  delete from public.member_calendar_import_events
  where steward_id = caller and provider = p_provider;
  delete from public.member_calendar_connections
  where steward_id = caller and provider = p_provider;
  delete from private.steward_calendar_oauth_tokens
  where steward_id = caller and provider = p_provider;
  return pg_catalog.jsonb_build_object('provider', p_provider, 'removed', true);
end;
end;
$function$;

notify pgrst, 'reload schema';

commit;
