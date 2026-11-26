-- REQ-UG-LEARNING-PERIOD-MEMBERSHIP-ROLES-SETTINGS-20261103 (#6946).
-- Fix forward after 20261104113000; no journal or audit row changes.
-- Undoing a chapter grant takes the chapter back the way
-- revoke_member_chapter_membership does, so it also deletes the person's
-- chapter role rows there (member_role_chapters, then member_roles rows left
-- with no chapter). Re-emitted from the 20261104113000 definition with only
-- that step added; the journal fingerprint still refuses the undo after any
-- later role write in the chapter.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.learning_undo_chapter_membership(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target text := p_entry ->> 'target_id';
  part text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 1);
  member uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 2)::uuid;
  chapter text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 3);
  image jsonb := p_entry -> 'before_image';
  chapter_org uuid;
  org_admin boolean;
  can_assign boolean;
  previous_title text;
  previous_office text;
  replacement_chapter text;
  item jsonb;
begin
  select c.organization_id into chapter_org from public.chapters c where c.id = chapter;
  if p_mode = 'lock' then
    -- The forward paths' lock order: tenant, then member, then the row.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || chapter_org::text, 509));
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-chapter:' || member::text, 0));
    perform 1 from public.member_chapter_memberships m where m.user_id = member and m.chapter_id = chapter for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_membership_state('public.member_chapter_memberships', target);
  elsif p_mode = 'before' then
    return image;
  elsif p_mode = 'check' then
    if chapter_org is null or chapter_org is distinct from private.current_mobile_staff_organization() then
      raise exception 'you can no longer change this membership' using errcode = '42501';
    end if;
    if part = 'm' then
      -- grant_ and revoke_member_chapter_membership's rule.
      org_admin := private.has_organization_role(chapter_org, array['admin']);
      if not org_admin and (chapter is distinct from private.current_member_chapter()
          or not private.member_has_chapter_role(chapter, array['admin'])) then
        raise exception 'you can no longer change this membership' using errcode = '42501';
      end if;
      if image ->> 'status' = 'active' then
        -- Putting a removed chapter back never re-admits someone who has
        -- left the organization since; that takes an invitation.
        if not exists (select 1 from public.organization_memberships om
            where om.organization_id = chapter_org and om.user_id = member and om.status = 'active') then
          raise exception 'active organization membership required' using errcode = '22023';
        end if;
        for item in select value from pg_catalog.jsonb_array_elements(coalesce(image -> 'roles', '[]'::jsonb)) loop
          if (item ->> 'unit_id' is not null or item ->> 'committee_id' is not null)
             and not (org_admin or private.chapter_access_leadership(chapter)) then
            raise exception 'chapter leadership required' using errcode = '42501';
          end if;
          if (item ->> 'unit_id' is not null and not exists (select 1 from private.chapter_units u
                where u.id = (item ->> 'unit_id')::uuid and u.chapter_id = chapter))
             or (item ->> 'committee_id' is not null and not exists (select 1 from private.chapter_committees k
                where k.id = (item ->> 'committee_id')::uuid and k.chapter_id = chapter)) then
            raise exception 'role scope no longer exists' using errcode = '22023';
          end if;
        end loop;
        -- The pin and budget office come back under the rule that let this
        -- person take them away (revoke_member_chapter_membership's, above).
      elsif not exists (select 1 from public.member_chapter_memberships m
                join public.chapters c on c.id = m.chapter_id
                where m.user_id = member and m.chapter_id <> chapter and m.status = 'active' and c.organization_id = chapter_org) then
        -- Taking back someone's only chapter would leave an organization
        -- member with no chapter; that is a removal from the organization,
        -- which only revoke_member_chapter_membership does, and is permanent.
        raise exception 'this is their only chapter; remove them from it instead' using errcode = '22023';
      elsif exists (select 1 from public.organization_role_grants g
                where g.organization_id = chapter_org and g.user_id = member and g.role = 'admin')
            and not exists (select 1 from public.member_chapter_memberships m
                join public.chapters c on c.id = m.chapter_id
                where m.user_id = member and m.chapter_id <> chapter and m.status = 'active' and c.organization_id = chapter_org)
            and (select pg_catalog.count(*) from public.organization_role_grants g
                where g.organization_id = chapter_org and g.role = 'admin') <= 1 then
        raise exception 'cannot remove the last organization admin' using errcode = '22023';
      end if;
      return null;
    end if;
    if not exists (select 1 from public.member_chapter_memberships m
        where m.user_id = member and m.chapter_id = chapter and m.status = 'active') then
      raise exception 'membership not found' using errcode = '22023';
    end if;
    if part = 'p' then
      if member is distinct from caller or not private.mfa_satisfied() then
        raise exception 'authentication required' using errcode = '42501';
      end if;
    elsif part = 't' then
      if not private.mfa_satisfied() or not private.member_invitation_chapter_administrable(chapter) then
        raise exception 'admin role required' using errcode = '42501';
      end if;
    elsif part = 'o' then
      select ctx.can_assign into can_assign
      from private.chapter_budget_context(private.current_member_organization(), chapter) ctx;
      if not coalesce(can_assign, false) or not exists (select 1 from public.organization_memberships om
          where om.user_id = member and om.organization_id = chapter_org and om.status = 'active') then
        raise exception 'chapter admin required' using errcode = '42501';
      end if;
    else
      raise exception 'invalid learning target' using errcode = '22023';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if part = 'm' and image ->> 'status' = 'active' then
    update public.member_chapter_memberships m
    set status = 'active', revoked_at = null, pinned = coalesce((image ->> 'pinned')::boolean, false),
        budget_office = image ->> 'budget_office'
    where m.user_id = member and m.chapter_id = chapter and m.status = 'revoked';
    for item in select value from pg_catalog.jsonb_array_elements(coalesce(image -> 'roles', '[]'::jsonb)) loop
      insert into public.member_roles (user_id, role, granted_by, chapter_id)
      values (member, item ->> 'role', caller, chapter)
      on conflict (user_id, role) do nothing;
      insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
      values (member, item ->> 'role', chapter, caller)
      on conflict (user_id, role, chapter_id) do nothing;
      if item ->> 'unit_id' is not null or item ->> 'committee_id' is not null then
        insert into private.chapter_role_scopes (user_id, chapter_id, role, unit_id, committee_id)
        values (member, chapter, item ->> 'role', (item ->> 'unit_id')::uuid, (item ->> 'committee_id')::uuid)
        on conflict (user_id, chapter_id, role) do update set unit_id = excluded.unit_id, committee_id = excluded.committee_id;
      end if;
    end loop;
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'grant_chapter_membership', member,
      pg_catalog.jsonb_build_object('chapterId', chapter, 'learningUndo', true,
        'roles', (select coalesce(pg_catalog.jsonb_agg(r ->> 'role'), '[]'::jsonb)
                  from pg_catalog.jsonb_array_elements(coalesce(image -> 'roles', '[]'::jsonb)) r)));
    insert into public.organization_audit_events (organization_id, event_type, actor_user_id, idempotency_key, metadata)
    values (chapter_org, 'organization_membership_granted', caller, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('organizationId', chapter_org::text, 'chapterId', chapter, 'userId', member::text,
        'action', 'learning_undo', 'entityId', p_entry ->> 'id'));
  elsif part = 'm' then
    -- Taking a granted chapter back: the same steps as a removal that leaves
    -- the person in the organization. Their selected chapter moves if needed.
    if exists (select 1 from public.member_profiles p where p.id = member and p.chapter_id = chapter) then
      select m.chapter_id into replacement_chapter
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id and c.organization_id = chapter_org
      where m.user_id = member and m.chapter_id <> chapter and m.status = 'active'
      order by m.last_selected_at desc nulls last, m.joined_at, m.chapter_id
      limit 1;
    end if;
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'revoke_chapter_membership', member,
      pg_catalog.jsonb_build_object('chapterId', chapter, 'replacementChapterId', replacement_chapter, 'learningUndo', true));
    update public.member_chapter_memberships m
    set status = 'revoked', revoked_at = pg_catalog.clock_timestamp(), pinned = false
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    -- revoke_member_chapter_membership's role cleanup, unchanged.
    delete from public.member_role_chapters
    where user_id = member and chapter_id = chapter;
    delete from public.member_roles r
    where r.user_id = member and r.chapter_id is not null
      and not exists (
        select 1 from public.member_role_chapters rc
        where rc.user_id = r.user_id and rc.role = r.role
      );
    update public.member_profiles p set chapter_id = replacement_chapter
    where p.id = member and p.chapter_id = chapter;
    insert into public.organization_audit_events (organization_id, event_type, actor_user_id, idempotency_key, metadata)
    values (chapter_org, 'organization_membership_revoked', caller, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('organizationId', chapter_org::text, 'chapterId', chapter, 'userId', member::text,
        'action', 'learning_undo', 'entityId', p_entry ->> 'id'));
  elsif part = 'p' then
    update public.member_chapter_memberships m set pinned = coalesce((image ->> 'pinned')::boolean, false)
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
  elsif part = 't' then
    select m.display_title into previous_title from public.member_chapter_memberships m
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    update public.member_chapter_memberships m set display_title = image ->> 'display_title'
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'set_chapter_display_title', member,
      pg_catalog.jsonb_build_object('chapterId', chapter, 'title', image ->> 'display_title',
        'previousTitle', previous_title, 'learningUndo', true));
  elsif part = 'o' then
    select m.budget_office into previous_office from public.member_chapter_memberships m
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    update public.member_chapter_memberships m set budget_office = image ->> 'budget_office'
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    insert into public.organization_audit_ledger
      (organization_id, domain, event_type, action, actor_user_id, entity_type, entity_id, idempotency_key, metadata)
    values (chapter_org, 'administration', 'chapter_budget_office',
      case when image ->> 'budget_office' is null then 'revoke' else 'grant' end,
      caller, 'membership', member::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('chapterId', chapter, 'fromRole', previous_office, 'toRole', image ->> 'budget_office'));
  end if;
  return null;
end;
end;
$function$;

notify pgrst, 'reload schema';
commit;
