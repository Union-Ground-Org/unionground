-- SEC-UG-PUBLIC-SITE-CHAPTER-PARENT-DELETE-CASCADES-MICROSITE-20260920
--
-- Chapter parents own the public microsite hierarchy. Deleting one directly
-- cascades through sections, pages, attachments, and takeover evidence without
-- an audited lifecycle command. Keep authenticated deletion for the unrelated
-- win and meeting kinds, prevent a chapter from being retyped to reach that
-- delete path, and reserve chapter cleanup to postgres-owned maintenance.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.public_site_records_preserve_chapter_kind()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if old.kind = 'chapter'
     and new.kind is distinct from old.kind
     and current_user = 'authenticated'
  then
    raise exception using
      errcode = '42501',
      message = 'authenticated chapter kind transition is not allowed';
  end if;
  return new;
end;
$function$;

revoke all on function private.public_site_records_preserve_chapter_kind()
  from public, anon, authenticated, service_role;

comment on function private.public_site_records_preserve_chapter_kind() is
  'Rejects authenticated changes from chapter to win or meeting so the non-chapter DELETE policy cannot be used to cascade away a chapter microsite; invoker context leaves postgres-owned maintenance available.';

drop trigger if exists public_site_records_preserve_chapter_kind
  on public.public_site_records;
create trigger public_site_records_preserve_chapter_kind
before update of kind on public.public_site_records
for each row
execute function private.public_site_records_preserve_chapter_kind();

comment on trigger public_site_records_preserve_chapter_kind on public.public_site_records is
  'Guards the mutable kind boundary before RLS evaluates a later DELETE, preserving chapter hierarchy and takeover evidence while leaving non-chapter records unchanged.';

insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
values
  ('function', 'private', '', 'public_site_records_preserve_chapter_kind()', 'd6dd00b63149dba6f72095ce699143c2'),
  ('trigger', 'public', 'public_site_records', 'public_site_records_preserve_chapter_kind', 'e4beecbc062b3eeb255039ffe3640ea1')
on conflict (kind, schema_name, table_name, object_name) do update
set definition_hash = excluded.definition_hash;

do $assert_account_lifecycle_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the public-site chapter parent guard';
  end if;
end;
$assert_account_lifecycle_trigger_review$;

alter policy public_site_records_staff_delete on public.public_site_records
  to authenticated
  using (
    kind <> 'chapter'
    and organization_id is not null
    and private.has_organization_role(
      organization_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
  );

comment on policy public_site_records_staff_delete on public.public_site_records is
  'Authenticated staff may delete genuine win and meeting records for organizations where they hold an active staff role, but chapter parents are retained and cannot be retyped through authenticated access because deletion would cascade through their microsite hierarchy and takeover evidence; postgres-owned maintenance remains available.';

notify pgrst, 'reload schema';

commit;
