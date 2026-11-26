-- BUG-UG-ADMIN-PULSE-FORMS-CARD-NEVER-SHOWS-FOR-ADMIN-ONLY-20261110 (#7981).
-- The native Pulse "Forms by recorded state" card counted forms only when the
-- caller's own member_profiles read covered the whole chapter register. That
-- policy has no admin branch, so an account whose only role is admin always
-- read a fragment and the card never showed.
--
-- public.get_admin_chapter_form_states gives an administrator the card's
-- figures without widening any row access: it checks admin authority over the
-- named chapter (organization admin, or admin of that chapter, in the
-- caller's current union organization, with the staff second factor when the
-- organization requires one), counts the latest 100 forms of the chapter's
-- current members by state, and applies the ten-person floor here. When any
-- state has fewer than ten different people the whole result is withheld, so
-- no small count leaves the database. Only states and counts are returned:
-- no name, member id or form answer.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

create function public.get_admin_chapter_form_states(p_chapter_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter_org uuid;
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
  select coalesce(pg_catalog.bool_or(g.people < 10), false),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('status', g.status, 'count', g.forms) order by g.status), '[]'::jsonb)
  into small_state, states
  from grouped g;
  if small_state then
    return pg_catalog.jsonb_build_object('withheld', true, 'states', null);
  end if;
  return pg_catalog.jsonb_build_object('withheld', false, 'states', states);
end;
$function$;
revoke all on function public.get_admin_chapter_form_states(text) from public, anon, authenticated, service_role;
grant execute on function public.get_admin_chapter_form_states(text) to authenticated;
comment on function public.get_admin_chapter_form_states(text) is
  'BUG-UG-ADMIN-PULSE-FORMS-CARD-NEVER-SHOWS-FOR-ADMIN-ONLY-20261110: the admin Pulse Forms card. Latest 100 forms of the chapter''s current members counted by state; withheld whole when any state has fewer than ten different people. States and counts only.';

commit;
