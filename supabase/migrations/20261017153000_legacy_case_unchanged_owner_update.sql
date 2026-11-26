-- BUG-UG-LEGACY-CASE-UNCHANGED-CHAPTER-UPDATE-20261014
-- Let a legacy case with a chapter already set take an unrelated update.
--
-- private.mi1_bind_case_owner() (20260822020000) refused every UPDATE of a
-- legacy case (organization_id null) whose NEW row had a non-null
-- organization_id or chapter_id, without comparing it to OLD. A legacy case
-- that already carried a chapter_id therefore refused any edit, including the
-- ON DELETE SET NULL update a foreign key makes when a referenced account is
-- deleted (production stop at C8-batch-01, 6:53:58 AM ET October 14).
--
-- The UPDATE branch now refuses only when organization_id or chapter_id
-- actually changes (IS DISTINCT FROM), for legacy and organization-backed
-- cases alike; each keeps its own message. Assigning, replacing or clearing
-- either column on a legacy case still needs an explicit backfill, and
-- organization-backed ownership stays immutable. The INSERT branch, SECURITY
-- DEFINER, the empty search_path, the revoked EXECUTE and the
-- member_cases_bind_organization trigger are unchanged. No row is backfilled.
--
-- This is not the frozen residue-window substitution (20261012010001), whose
-- body and hashes stay as they are. Its relock (20261012010003) preserves an
-- unrecognised case-owner body with a warning rather than reinstating the
-- old one, and its unlock refuses production until a new window is reviewed.

begin;

create or replace function private.mi1_bind_case_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  owner_organization uuid;
  owner_chapter text;
begin
  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id
       or new.chapter_id is distinct from old.chapter_id then
      if old.organization_id is null then
        raise exception 'legacy case ownership requires an explicit backfill' using errcode = '42501';
      end if;
      raise exception 'case organization and chapter are immutable' using errcode = '42501';
    end if;
    return new;
  end if;

  select ch.organization_id, ch.id
  into owner_organization, owner_chapter
  from public.member_profiles p
  join public.chapters ch on ch.id = p.chapter_id
  where p.id = new.user_id;

  if owner_chapter is null then
    raise exception 'case owner requires a current organization chapter' using errcode = '23514';
  end if;
  if owner_organization is null then
    if new.organization_id is not null or new.chapter_id is not null then
      raise exception 'legacy case ownership cannot be supplied by the caller' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.organization_id is not null and new.organization_id is distinct from owner_organization then
    raise exception 'case organization is derived from the member chapter' using errcode = '42501';
  end if;
  if new.chapter_id is not null and new.chapter_id is distinct from owner_chapter then
    raise exception 'case chapter is derived from the member profile' using errcode = '42501';
  end if;

  new.organization_id := owner_organization;
  new.chapter_id := owner_chapter;
  return new;
end;
$function$;

revoke all on function private.mi1_bind_case_owner() from public, anon, authenticated, service_role;

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select surface.kind, surface.schema_name, surface.table_name, surface.object_name, surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
where surface.kind = 'function' and surface.schema_name = 'private'
  and surface.table_name = '' and surface.object_name = 'mi1_bind_case_owner()'
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_legacy_case_owner_lifecycle$
begin
  if not exists (
    select 1 from private.account_lifecycle_trigger_review r
    where r.kind = 'function' and r.schema_name = 'private' and r.table_name = ''
      and r.object_name = 'mi1_bind_case_owner()'
  ) then
    raise exception 'account lifecycle trigger review lost private.mi1_bind_case_owner()';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the legacy case owner repair';
  end if;
end;
$assert_legacy_case_owner_lifecycle$;

commit;
