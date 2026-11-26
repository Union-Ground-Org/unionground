-- REQ-UG-SCOPED-ROLES-AND-OFFICER-ACCESS-20261030 (#6560), the case
-- handed over from #6604.
--
-- An organization administrator who created a chapter from the admin desk
-- could not invite anyone into it: invitations follow
-- private.member_invitation_chapter_administrable (20261004010000), which
-- needs the admin role for the target chapter through
-- private.member_has_chapter_role, and that needs an active membership in the
-- chapter. The creator had none.
--
-- public.create_admin_chapter now gives the creator an active membership in
-- the chapter it creates, in the same transaction, and says so in the
-- create_chapter audit row. Nothing about who may invite where changes: the
-- 20261004010000 rule and the three live proofs that pin it stand
-- (invitation-target-chapter-admin, org-admin-reinvite-former-member,
-- member-chapter-display-titles). An organization admin still reaches only
-- chapters they belong to; creating a chapter is how they come to belong.
--
-- The body is 20260822010000's with three additions: the case-graph lock as
-- its first statement (it now writes member_chapter_memberships, as every
-- membership writer does), the membership row, and creatorMembership in the
-- audit detail. Chapters created by the setup import
-- (import_organization_structure) are unchanged: that path creates many at
-- once, and joining all of them is not this record's decision.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.create_admin_chapter(
  p_id text,
  p_name text,
  p_region text default null,
  p_order_index integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org_id uuid := private.current_member_organization();
  locked_org uuid;
  clean_id text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_id, '')));
  clean_name text := pg_catalog.btrim(coalesce(p_name, ''));
  clean_region text := nullif(pg_catalog.btrim(coalesce(p_region, '')), '');
  clean_order integer;
begin
  if caller is null
     or org_id is null
     or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  if clean_id !~ '^[a-z0-9][a-z0-9-]{0,31}$'
     or pg_catalog.char_length(clean_name) < 2
     or pg_catalog.char_length(clean_name) > 120
     or clean_name ~ '[[:cntrl:]]'
     or (clean_region is not null and (pg_catalog.char_length(clean_region) > 120 or clean_region ~ '[[:cntrl:]]'))
     or (p_order_index is not null and (p_order_index < 1 or p_order_index > 10000)) then
    raise exception 'invalid chapter' using errcode = '22023';
  end if;

  locked_org := org_id;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || locked_org::text, 509));

  -- Re-resolve tenant and authority after the shared organization lock. A
  -- queued create cannot survive an intervening admin revocation or chapter
  -- switch.
  org_id := private.current_member_organization();
  if org_id is distinct from locked_org
     or not private.has_organization_role(locked_org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('chapters:admin'));
  if exists (select 1 from public.chapters c where c.id = clean_id) then
    raise exception 'chapter already exists' using errcode = '23505';
  end if;
  if exists (
    select 1 from public.chapters c
    where c.organization_id = org_id
      and (pg_catalog.lower(c.name) = pg_catalog.lower(clean_name) or c.slug = clean_id)
  ) then
    raise exception 'chapter already exists' using errcode = '23505';
  end if;
  clean_order := coalesce(
    p_order_index,
    (select coalesce(pg_catalog.max(c.order_index), 0) + 1 from public.chapters c where c.organization_id = org_id)
  );

  insert into public.chapters (id, name, region, is_default, order_index, organization_id, slug)
  values (clean_id, clean_name, clean_region, false, clean_order, org_id, clean_id);
  -- The creator joins the chapter they made, so they can invite into it and
  -- run it under the 20261004010000 rule.
  insert into public.member_chapter_memberships (user_id, chapter_id, status)
  values (caller, clean_id, 'active')
  on conflict (user_id, chapter_id) do update
    set status = 'active', revoked_at = null;
  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'create_chapter', pg_catalog.jsonb_build_object(
    'chapterId', clean_id, 'fields', pg_catalog.jsonb_build_array('name', 'region', 'orderIndex'),
    'creatorMembership', true));

  return pg_catalog.jsonb_build_object(
    'id', clean_id, 'name', clean_name, 'region', clean_region,
    'isDefault', false, 'orderIndex', clean_order, 'created', true);
end;
end;
$function$;
revoke all on function public.create_admin_chapter(text, text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.create_admin_chapter(text, text, text, integer) to authenticated;

commit;
