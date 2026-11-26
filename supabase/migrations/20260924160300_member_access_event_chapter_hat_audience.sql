-- BUG-UG-ACCESS-LOG-WRITE-NARROWER-THAN-CASE-READ-20260920
--
-- public.record_member_access_event (20260828021500:196-280, wrapped with the
-- case-graph entry lock by 20260907151000) states its staff audience twice and
-- both statements read only public.organization_role_grants: the gate through
-- private.has_organization_role and the actor_role derivation directly. The
-- case reads it accompanies (public.list_coordinator_cases and the
-- member_cases_select_steward policy) gate on public.member_has_role, which
-- also admits a public.member_role_chapters hat held in the caller's selected
-- chapter. A chapter-hat coordinator or steward therefore listed their cases
-- and was refused 42501 on every open.
--
-- Repair. Re-emit the writer from its installed definition with two changes:
--
--   * The gate admits private.has_organization_role(org, ...) (unchanged
--     organization-grant path) OR private.member_has_chapter_role(the caller's
--     selected chapter, ...). For an organization chapter that helper is the
--     organization branch of public.member_has_role restricted to the selected
--     chapter: MFA, the chapter's organization equals the caller's selected
--     organization, active organization and chapter memberships, the
--     organization's staff second-factor policy, and an organization grant or
--     a member_role_chapters row in that chapter. Nothing wider is admitted.
--   * actor_role is the highest of the caller's organization grants in org and
--     member_role_chapters hats in the selected chapter, with the unchanged
--     precedence admin > vp > coordinator > advisor > steward.
--
-- The body starts from the generation 20260924140500_mi1_access_audit_entity_reference
-- installed, so the tenant-audit metadata keeps its entityId, input validation
-- (22023) still runs before the subject membership check, and an unauthorized
-- caller and an unauthorized subject still share one 42501 'not authorized'
-- outcome. The case-graph lock stays the first statement, every other refusal
-- keeps its position, and the no-hat refusal still precedes the subject read. Signature,
-- SECURITY DEFINER, empty search_path and grants are unchanged.

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
  if p_action not in ('viewed_profile', 'viewed_case', 'updated_profile', 'updated_case') then
    raise exception 'invalid action' using errcode = '22023';
  end if;
  if p_entity_type not in ('member', 'case') then
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

revoke all on function public.record_member_access_event(uuid, uuid, text, text, text)
  from public, anon, service_role;
grant execute on function public.record_member_access_event(uuid, uuid, text, text, text)
  to authenticated;

notify pgrst, 'reload schema';

commit;
