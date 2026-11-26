-- (gate finding r4s1 on, record
-- SEC-UG-NATIVE-LEADER-GATES-USE-TEN-WHERE-THE-ORGANIZATION-FLOOR-IS-25-20261115).
--
-- The phone's admin Pulse Forms card shows form counts that
-- public.get_admin_chapter_form_states checked against the organization's
-- anonymity floor. The phone reads that floor from
-- public.get_my_mobile_staff_scope before and after the load and withholds
-- every figure when the two reads differ. Equal reads do not prove which floor
-- the forms count used: a floor changed 30 to 25 to 30 between the reads could
-- let the phone show counts checked only against 25.
--
-- public.get_admin_chapter_form_states now also returns privacyFloor, the
-- floor it applied (private.organization_limit, never below 25), in both the
-- withheld and the shown result. The phone shows the counts only when that
-- floor equals the floor both scope reads reported. Authority checks, the
-- latest-100 window, the withholding rule and the states are unchanged from
-- 20261113135500; only the returned object gains one key.
--
-- No grant, policy or table changes: create or replace keeps the function's
-- EXECUTE grant. public.get_my_mobile_staff_scope is not redefined; it is
-- pinned too, because the phone compares this floor with the one it reports.
--
-- Apply order: after 20261113135500, on which it depends.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

-- Pin the bodies 20261113135500 left in place.
do $assert_admin_form_states_floor_predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_my_mobile_staff_scope()'::pg_catalog.regprocedure))
      <> '06b635a2cb198ac4d1974794bb090851' then
    raise exception 'Unreviewed native staff scope predecessor: integrate current Main before reporting the applied floor';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_admin_chapter_form_states(text)'::pg_catalog.regprocedure))
      <> '5ed98e67ec4c4acaa742d1ee0f1d3406' then
    raise exception 'Unreviewed admin form states predecessor: integrate current Main before reporting the applied floor';
  end if;
end;
$assert_admin_form_states_floor_predecessors$;

create or replace function public.get_admin_chapter_form_states(p_chapter_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter_org uuid;
  privacy_floor integer;
  small_state boolean;
  states jsonb;
begin
  if caller is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select c.organization_id into chapter_org from public.chapters c where c.id = p_chapter_id;
  -- One refusal for a chapter that does not exist, sits in another or the
  -- platform organization, or that the caller does not administer.
  if chapter_org is null
     or chapter_org is distinct from private.current_member_organization()
     or not private.organization_is_union(chapter_org)
     or (private.staff_mfa_required(chapter_org) and not private.has_second_factor(caller))
     or not (private.has_organization_role(chapter_org, array['admin'])
       or private.member_has_chapter_role(p_chapter_id, array['admin'])) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  privacy_floor := private.organization_limit(chapter_org, 'limits.analytics.anonymity_floor');
  with latest as (
    select f.status, f.user_id
    from public.member_forms f
    join public.member_profiles p on p.id = f.user_id
    where p.chapter_id = p_chapter_id
    order by f.updated_at desc, f.id
    limit 100
  ), grouped as (
    select l.status, pg_catalog.count(*)::integer as forms, pg_catalog.count(distinct l.user_id)::integer as people
    from latest l
    group by l.status
  )
  select coalesce(pg_catalog.bool_or(g.people < privacy_floor), false),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('status', g.status, 'count', g.forms) order by g.status), '[]'::jsonb)
  into small_state, states
  from grouped g;
  if small_state or privacy_floor is null then
    return pg_catalog.jsonb_build_object('withheld', true, 'states', null, 'privacyFloor', privacy_floor);
  end if;
  -- The floor this count was checked against, so the phone can confirm it is
  -- the floor its own scope reads reported (ledger 367).
  return pg_catalog.jsonb_build_object('withheld', false, 'states', states, 'privacyFloor', privacy_floor);
end;
$function$;

comment on function public.get_admin_chapter_form_states(text) is
  'SEC-UG-NATIVE-LEADER-GATES-USE-TEN-WHERE-THE-ORGANIZATION-FLOOR-IS-25-20261115: the admin Pulse Forms card. Latest 100 forms of the chapter''s current members counted by state; withheld whole when any state has fewer different people than the organization anonymity floor (never below 25). States, counts and the floor applied (privacyFloor) only.';

commit;
