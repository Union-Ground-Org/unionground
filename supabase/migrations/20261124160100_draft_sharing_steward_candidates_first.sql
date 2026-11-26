-- BUG-UG-DEMO-MEMBER-FORMS-ACCESS-READ-NEVER-ANSWERS-20261124 (#9781):
-- Member Forms shows "Loading access…" under each saved draft for about six
-- seconds on the demo, because each draft's public.list_member_draft_sharing
-- call takes about five.
--
-- The function built its steward list by running
-- private.draft_steward_covers_member on every row of public.member_profiles
-- in the database (1,049 calls on the demo to find 4 stewards; the helper is a
-- security-definer function, so it is never inlined). A person can pass that
-- helper only through one of two rows: an organization steward grant
-- (public.organization_role_grants, role 'steward') in the caller's
-- organization, through private.organization_steward_scope_allows, or a
-- chapter steward role (public.member_role_chapters, role 'steward') in the
-- caller's chapter. The steward list is now built from the people holding one
-- of those rows first, in a materialized step, and the helper runs only on
-- them. The helper, the guard, the order, the limit of 100, the shared flag,
-- the owner, the security setting, the search_path and the grants are
-- unchanged, so every caller gets exactly the list it got before.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

do $predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure('public.list_member_draft_sharing(uuid)')
  )) is distinct from 'b6c0b52abdb46805e1590c000395088a' then
    raise exception 'unreviewed predecessor: public.list_member_draft_sharing(uuid)' using errcode = '55000';
  end if;
end;
$predecessor$;

create or replace function public.list_member_draft_sharing(p_form uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare chapter text;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or private.member_pin_session_restricted()
    or not exists(select 1 from public.member_forms f where f.id=p_form and f.user_id=(select auth.uid()) and f.status in ('draft','returned') and not private.form_template_is_sealed(f.template_key)) then
    raise exception 'own shareable draft required' using errcode='42501';
  end if;
  select chapter_id into chapter from public.member_profiles where id=(select auth.uid());
  -- #9781: only people holding an organization steward grant in the caller's
  -- organization or a steward role in the caller's chapter can pass
  -- private.draft_steward_covers_member, so it runs on them alone.
  return coalesce((
    with steward_candidate as materialized (
      select p.id, p.full_name
      from public.member_profiles p
      where p.id<>(select auth.uid())
        and p.id in (
          select grant_row.user_id from public.organization_role_grants grant_row
          where grant_row.organization_id=private.current_member_organization() and grant_row.role='steward'
          union
          select role_row.user_id from public.member_role_chapters role_row
          where role_row.chapter_id=chapter and role_row.role='steward')
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',person.id,'name',person.full_name,'shared',exists(select 1 from private.member_draft_steward_shares share where share.form_id=p_form and share.steward_id=person.id and share.organization_id=private.current_member_organization() and share.chapter_id=chapter)) order by person.full_name,person.id)
    from (select candidate.id,candidate.full_name from steward_candidate candidate
      where private.draft_steward_covers_member(candidate.id,(select auth.uid()),chapter) order by candidate.full_name,candidate.id limit 100) person),'[]'::jsonb);
end;
$function$;

comment on function public.list_member_draft_sharing(uuid) is
  'The stewards a member may share one own shareable draft with, and whether it is shared with each. #9781 (20261124160100): candidates are the holders of an organization steward grant in the caller''s organization or a steward role in the caller''s chapter, checked by private.draft_steward_covers_member; the list is the one the full profile scan returned.';

commit;
