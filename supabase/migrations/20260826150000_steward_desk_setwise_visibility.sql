-- SAMPLE steward desk statement timeouts
-- (BUG-UNION-GROUND-SAMPLE-STEWARD-DESK-TIMEOUT-20260826): at seeded scale,
-- list_steward_requests, list_steward_conversations, list_steward_forms, and
-- get_steward_desk_kpis exceed the eight-second statement timeout for a real
-- steward session. Their security-invoker scans pay the non-inlineable
-- staff_can_see_user predicate once per visited row.
--
-- Query-side prefilters cannot repair that plan: RLS still evaluates at the
-- table scan. These five steward SELECT policies instead consume one set-wise mirror
-- of the same organization, legacy-chapter, role, active-membership, and MFA
-- branches. The coordinator sibling on member_profiles moves with them because
-- permissive policy OR evaluation would otherwise keep the scalar coordinator
-- predicate on every steward name-search row. Every RPC body remains unchanged.
--
-- The helper stays in private. Authenticated receives EXECUTE so the stored
-- policies can call it, but the migration adds no schema grant and the helper
-- stays outside PostgREST's exposed RPC schema.

set local lock_timeout = '5s';

create or replace function private.staff_visible_member_ids(p_role text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  with caller as (
    select
      (select auth.uid()) as uid,
      (select private.current_member_organization()) as organization_id
  ),
  visible_chapters as (
    select chapter.id
    from public.chapters chapter
    cross join caller
    where caller.uid is not null
      and p_role is not null
      and (select private.mfa_satisfied())
      and (
        (
          chapter.organization_id is not null
          and chapter.organization_id = caller.organization_id
          and (
            private.has_organization_role(
              chapter.organization_id,
              array[p_role]
            )
            or private.member_has_chapter_role(
              chapter.id,
              array[p_role]
            )
          )
        )
        or (
          chapter.organization_id is null
          and caller.organization_id is null
          and exists (
            select 1
            from public.member_profiles caller_profile
            left join public.chapters caller_chapter
              on caller_chapter.id = caller_profile.chapter_id
            where caller_profile.id = caller.uid
              and (
                caller_chapter.id is null
                or caller_chapter.organization_id is null
              )
          )
          and (
            not (select private.staff_mfa_required())
            or (select private.has_second_factor(caller.uid))
          )
          and exists (
            select 1
            from public.member_roles role_grant
            where role_grant.user_id = caller.uid
              and role_grant.role = p_role
              and (
                role_grant.chapter_id is null
                or exists (
                  select 1
                  from public.member_role_chapters role_chapter
                  join public.member_chapter_memberships membership
                    on membership.user_id = role_chapter.user_id
                   and membership.chapter_id = role_chapter.chapter_id
                  join public.chapters mapped_chapter
                    on mapped_chapter.id = role_chapter.chapter_id
                  where role_chapter.user_id = role_grant.user_id
                    and role_chapter.role = role_grant.role
                    and role_chapter.chapter_id = chapter.id
                    and mapped_chapter.organization_id is null
                    and membership.status = 'active'
                )
              )
          )
        )
      )
  )
  select profile.id
  from public.member_profiles profile
  join visible_chapters
    on visible_chapters.id = profile.chapter_id;
$function$;

revoke all on function private.staff_visible_member_ids(text)
  from public, anon, authenticated, service_role;
grant execute on function private.staff_visible_member_ids(text)
  to authenticated, service_role;

comment on function private.staff_visible_member_ids(text) is
  'Set-wise mirror of staff_can_see_user for stored RLS policy evaluation; '
  'not a client RPC and does not grant private schema usage.';

drop policy member_steward_requests_select_steward
  on public.member_steward_requests;
create policy member_steward_requests_select_steward
  on public.member_steward_requests
  for select
  to authenticated
  using (
    user_id in (
      select private.staff_visible_member_ids('steward')
    )
  );

drop policy member_conversations_select_steward
  on public.member_conversations;
create policy member_conversations_select_steward
  on public.member_conversations
  for select
  to authenticated
  using (
    user_id in (
      select private.staff_visible_member_ids('steward')
    )
  );

drop policy member_messages_select_steward
  on public.member_messages;
create policy member_messages_select_steward
  on public.member_messages
  for select
  to authenticated
  using (
    user_id in (
      select private.staff_visible_member_ids('steward')
    )
  );

-- Search and display-name lookups inside the desk RPCs read member_profiles.
-- Leaving that policy on the scalar predicate would keep filtered desk calls
-- above the statement timeout even after the four primary tables were fixed.
drop policy member_profiles_select_steward
  on public.member_profiles;
create policy member_profiles_select_steward
  on public.member_profiles
  for select
  to authenticated
  using (
    id in (
      select private.staff_visible_member_ids('steward')
    )
  );

drop policy member_profiles_select_coordinator
  on public.member_profiles;
create policy member_profiles_select_coordinator
  on public.member_profiles
  for select
  to authenticated
  using (
    id in (
      select private.staff_visible_member_ids('coordinator')
    )
  );

drop policy member_forms_select_steward
  on public.member_forms;
create policy member_forms_select_steward
  on public.member_forms
  for select
  to authenticated
  using (
    status in ('submitted', 'in_review')
    and user_id in (
      select private.staff_visible_member_ids('steward')
    )
  );

comment on policy member_steward_requests_select_steward
  on public.member_steward_requests is
  'Steward visibility is the set-wise equivalent of staff_can_see_user.';
comment on policy member_conversations_select_steward
  on public.member_conversations is
  'Steward visibility is the set-wise equivalent of staff_can_see_user.';
comment on policy member_messages_select_steward
  on public.member_messages is
  'Steward visibility is the set-wise equivalent of staff_can_see_user.';
comment on policy member_profiles_select_steward
  on public.member_profiles is
  'Steward name lookups use the set-wise equivalent of staff_can_see_user.';
comment on policy member_profiles_select_coordinator
  on public.member_profiles is
  'Coordinator name lookups use the set-wise equivalent of staff_can_see_user.';
comment on policy member_forms_select_steward
  on public.member_forms is
  'Active-review allow-list plus set-wise steward visibility.';
