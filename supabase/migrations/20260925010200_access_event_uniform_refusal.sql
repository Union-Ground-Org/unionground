-- SEC-UG-ACCESS-EVENT-AUTHORIZATION-RESPONSES-DISCLOSE-MEMBERSHIP-STATE-DISTINCTIONS-20260921
--
-- public.record_member_access_event still refuses a subject who is not an
-- active organization member. The refusal uses the same message and SQLSTATE
-- as the caller-role check so the two unauthorized outcomes are not
-- distinguishable. Input-validation refusals (self-access, action, entity)
-- stay in class 22023 and run before the membership check. A NULL action or
-- entity type is refused there too: NOT IN yields NULL, which would skip the
-- check and let an active subject reach the not-null insert (23502) while an
-- out-of-organization subject got 42501.
--
-- The body is the generation 20260924160300_member_access_event_chapter_hat_audience
-- installed (case-graph entry lock first, as 20260907151000 wrapped it; the
-- selected-chapter hat audience; the entityId audit key from 20260924140500),
-- with only the two NULL checks added.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.record_member_access_event(
  p_expected_organization_id uuid,
  p_subject_user_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  caller uuid := (select auth.uid());
  selected_chapter text := private.current_member_chapter();
  role text;
  saved public.member_access_events%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not (
    private.has_organization_role(
      org,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
    or (
      selected_chapter is not null
      and exists (
        select 1
        from public.chapters chapter
        where chapter.id = selected_chapter
          and chapter.organization_id = org
      )
      and private.member_has_chapter_role(
        selected_chapter,
        array['steward', 'coordinator', 'advisor', 'admin', 'vp']
      )
    )
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_subject_user_id is null or p_subject_user_id is not distinct from caller then
    raise exception 'cannot record self access' using errcode = '22023';
  end if;
  if p_action is null or p_action not in ('viewed_profile', 'viewed_case', 'updated_profile', 'updated_case') then
    raise exception 'invalid action' using errcode = '22023';
  end if;
  if p_entity_type is null or p_entity_type not in ('member', 'case') then
    raise exception 'invalid entity' using errcode = '22023';
  end if;
  if (p_action in ('viewed_profile', 'updated_profile') and p_entity_type <> 'member')
    or (p_action in ('viewed_case', 'updated_case') and p_entity_type <> 'case')
    or (p_entity_id is not null and pg_catalog.char_length(p_entity_id) not between 1 and 80)
    or (p_entity_type = 'case' and p_entity_id is null)
  then
    raise exception 'invalid entity' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = org
      and membership.user_id = p_subject_user_id
      and membership.status = 'active'
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select hat.role into role
  from (
    select r.role
    from public.organization_role_grants r
    where r.organization_id = org
      and r.user_id = caller
    union
    select rc.role
    from public.member_role_chapters rc
    join public.chapters chapter
      on chapter.id = rc.chapter_id
     and chapter.organization_id = org
    join public.member_chapter_memberships m
      on m.user_id = rc.user_id
     and m.chapter_id = rc.chapter_id
     and m.status = 'active'
    where rc.user_id = caller
      and rc.chapter_id = selected_chapter
  ) hat
  where hat.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  order by case hat.role
    when 'admin' then 1
    when 'vp' then 2
    when 'coordinator' then 3
    when 'advisor' then 4
    when 'steward' then 5
    else 6
  end
  limit 1;
  if role is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.member_access_events (
    organization_id, subject_user_id, actor_user_id, actor_role, action, entity_type, entity_id
  ) values (
    org, p_subject_user_id, caller, role, p_action, p_entity_type, nullif(p_entity_id, '')
  )
  returning * into saved;
  perform private.mi1_write_tenant_audit(org, 'member_access_recorded', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'userId', p_subject_user_id,
    'action', p_action,
    'entityType', p_entity_type,
    'entityId', nullif(p_entity_id, '')
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'id', saved.id, 'organizationId', org);
end;
end;
$function$;

comment on function public.record_member_access_event(uuid, uuid, text, text, text) is
  'Staff record of active members in the selected organization. Enters through private.lock_case_graph. Unauthorized caller and subject refusals share one 42501 outcome; self-access and input validation (including NULL action or entity type) stay in 22023 and run before the membership check.';

revoke all on function public.record_member_access_event(uuid, uuid, text, text, text)
  from public, anon;
revoke execute on function public.record_member_access_event(uuid, uuid, text, text, text)
  from service_role;
grant execute on function public.record_member_access_event(uuid, uuid, text, text, text)
  to authenticated;

notify pgrst, 'reload schema';

commit;
