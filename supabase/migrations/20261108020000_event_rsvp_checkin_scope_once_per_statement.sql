-- BUG-UG-EVENT-RSVP-CHECKIN-POLICY-SCOPE-PER-EVENT-20261108 .
-- public.get_member_home_bootstrap is security invoker, so its member_event_rsvps
-- and member_event_checkins reads (where user_id = caller) run under
-- member_event_rsvps_select_own and member_event_checkins_select_own. Each
-- policy's EXISTS over public.member_events called
-- private.member_can_access_event_scope once per row, and each call re-planned
-- and ran _for_user's join of the caller's profile, chapter, organization and
-- both memberships (about 1.3 ms a call on a local Tamarack stack: 120 calls,
-- 174 ms, for the demo steward's bootstrap). On SAMPLE (1,002 accounts, 265
-- events) those two reads were 0.6 to 1.6 s of a 0.9 to 1.7 s bootstrap for
-- every staff hat, and the web shell waits on that bootstrap when an account
-- opens the app and on every demo role switch.
--
-- The caller's side now resolves once per statement:
--   private.member_event_caller_scope() lists the chapters in which
--   private.member_can_access_event_scope(chapter, is_public,
--   is_public_across_agencies) is true for the caller, for each flag
--   combination that can widen it: neither flag ('own'), is_public only
--   ('public') and is_public_across_agencies only ('across'). It calls the
--   same private.member_can_access_event_scope_for_user with the caller's id
--   (exactly what the wrapper does), for the chapters of the caller's profile
--   organization only: _for_user is false for every other chapter, since it
--   requires the event chapter's organization to equal the profile chapter's.
--   The policies call it as an uncorrelated scalar subquery, an InitPlan.
--   private.member_event_scope_allows(scope, chapter, is_public, across) is
--   the membership test against that value. _for_user's result is the OR of
--   three branches, and for a given chapter each branch is true or false
--   regardless of the flags, except for the one flag that enables it:
--     f(c, p, a) = f(c, false, false)
--               or (coalesce(a, false) and f(c, false, true))
--               or (coalesce(p, false) and f(c, true, false))
--   so the policies admit exactly the rows they admitted before.
-- private.member_can_access_event_scope and _for_user, the member_events
-- policy and the RSVP and check-in RPCs are untouched.
--
-- The preflight refuses to run unless both predecessor policies and both scope
-- functions are exactly the ones 20260901153739 installed.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- pg_get_expr qualifies every non-catalog name under this path, exactly as
-- under an empty one (pg_catalog is always searched), so the md5 is stable.
set local search_path = pg_catalog;

do $preflight$
begin
  if (select pg_catalog.md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid)) from pg_catalog.pg_policy p
      where p.polrelid = 'public.member_event_rsvps'::regclass and p.polname = 'member_event_rsvps_select_own'
        and p.polpermissive and p.polcmd = 'r') is distinct from '1482a5c01133d4bcfcb9c4f56c8b247d' then
    raise exception 'unreviewed predecessor: member_event_rsvps_select_own' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid)) from pg_catalog.pg_policy p
      where p.polrelid = 'public.member_event_checkins'::regclass and p.polname = 'member_event_checkins_select_own'
        and p.polpermissive and p.polcmd = 'r') is distinct from '8b84cd233c9595398e4f6269be87c3ec' then
    raise exception 'unreviewed predecessor: member_event_checkins_select_own' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'private.member_can_access_event_scope_for_user(uuid,text,boolean,boolean)'::regprocedure)
      is distinct from 'a938fb267f1bdedb6d97186f2490bcf7' then
    raise exception 'unreviewed predecessor: private.member_can_access_event_scope_for_user' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'private.member_can_access_event_scope(text,boolean,boolean)'::regprocedure)
      is distinct from '3a92f1aa5afad0709f4b825e1f2a83a8' then
    raise exception 'unreviewed predecessor: private.member_can_access_event_scope' using errcode = '55000';
  end if;
end;
$preflight$;

create function private.member_event_caller_scope()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'own', coalesce(pg_catalog.jsonb_agg(c.id) filter (
      where private.member_can_access_event_scope_for_user(caller.id, c.id, false, false)), '[]'::jsonb),
    'public', coalesce(pg_catalog.jsonb_agg(c.id) filter (
      where private.member_can_access_event_scope_for_user(caller.id, c.id, true, false)), '[]'::jsonb),
    'across', coalesce(pg_catalog.jsonb_agg(c.id) filter (
      where private.member_can_access_event_scope_for_user(caller.id, c.id, false, true)), '[]'::jsonb))
  from (select (select auth.uid()) as id) caller
  join public.chapters c
    on c.organization_id = (
      select member_chapter.organization_id
      from public.member_profiles profile
      join public.chapters member_chapter on member_chapter.id = profile.chapter_id
      where profile.id = caller.id);
$function$;

revoke all on function private.member_event_caller_scope() from public, anon, authenticated, service_role;
grant execute on function private.member_event_caller_scope() to authenticated;

comment on function private.member_event_caller_scope() is
  'The chapters in which private.member_can_access_event_scope is true for the caller with neither visibility flag (own), with is_public only (public) and with is_public_across_agencies only (across), over the chapters of the caller''s profile organization. The RSVP and check-in read policies call it once per statement as an InitPlan.';

create function private.member_event_scope_allows(
  p_scope jsonb,
  p_chapter_id text,
  p_is_public boolean,
  p_is_public_across_agencies boolean
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    p_chapter_id is not null
    and (
      (p_scope operator(pg_catalog.->) 'own') operator(pg_catalog.?) p_chapter_id
      or (coalesce(p_is_public_across_agencies, false)
        and (p_scope operator(pg_catalog.->) 'across') operator(pg_catalog.?) p_chapter_id)
      or (coalesce(p_is_public, false)
        and (p_scope operator(pg_catalog.->) 'public') operator(pg_catalog.?) p_chapter_id)
    ),
    false);
$function$;

revoke all on function private.member_event_scope_allows(jsonb, text, boolean, boolean) from public, anon, authenticated, service_role;
grant execute on function private.member_event_scope_allows(jsonb, text, boolean, boolean) to authenticated;

comment on function private.member_event_scope_allows(jsonb, text, boolean, boolean) is
  'private.member_can_access_event_scope(chapter, is_public, is_public_across_agencies) read from the precomputed private.member_event_caller_scope() value.';

drop policy member_event_rsvps_select_own on public.member_event_rsvps;
create policy member_event_rsvps_select_own on public.member_event_rsvps
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.member_events event
      where event.id = member_event_rsvps.event_id
        and private.member_event_scope_allows(
          (select private.member_event_caller_scope()),
          event.chapter_id,
          event.is_public,
          event.is_public_across_agencies
        )
    )
  );

drop policy member_event_checkins_select_own on public.member_event_checkins;
create policy member_event_checkins_select_own on public.member_event_checkins
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.member_events event
      where event.id = member_event_checkins.event_id
        and private.member_event_scope_allows(
          (select private.member_event_caller_scope()),
          event.chapter_id,
          event.is_public,
          event.is_public_across_agencies
        )
    )
  );

comment on policy member_event_rsvps_select_own on public.member_event_rsvps is
  'Own RSVP rows for events the caller can read and whose scope private.member_can_access_event_scope admits; the caller''s scope resolves once per statement (private.member_event_caller_scope), not once per event.';
comment on policy member_event_checkins_select_own on public.member_event_checkins is
  'Own check-in rows for events the caller can read and whose scope private.member_can_access_event_scope admits; the caller''s scope resolves once per statement (private.member_event_caller_scope), not once per event.';

commit;
