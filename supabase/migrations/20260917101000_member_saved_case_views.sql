-- Per-member case-list views. Definitions contain only presentation state;
-- they never grant case access or carry case identifiers/content.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table public.member_saved_views (
  id uuid primary key default gen_random_uuid(),
  -- Deliberately bare uuid columns. A foreign key to auth.users or to
  -- public.organizations would make this table a case-graph relation, and the
  -- implicit-FK acquisition catalogue would then require
  -- private.lock_case_graph() -- a database-wide pg_advisory_xact_lock(509,700)
  -- -- as the first statement of every writer. See the COMMENT ON TABLE below
  -- and the explicit deletion wiring at the end of this migration.
  user_id uuid not null,
  organization_id uuid not null,
  plane text not null check (plane in ('coordinator', 'steward')),
  name text not null check (pg_catalog.char_length(pg_catalog.btrim(name)) between 1 and 80),
  definition jsonb not null,
  is_default boolean not null default false,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint member_saved_views_definition_size check (pg_catalog.octet_length(definition::text) <= 6000),
  constraint member_saved_views_owner_name_key unique (user_id, organization_id, plane, name)
);

create unique index member_saved_views_one_default_per_plane
  on public.member_saved_views (user_id, organization_id, plane)
  where is_default;

comment on table public.member_saved_views is
  'Per-member case-list presentation state: facet selections and one sort, never a case identifier, case content, or a grant of case access. This is presentation state, not a child record, and it is deliberately outside the case graph -- the same reviewed shape as public.organization_automation_definition_reviews in supabase/migrations/20260911070000_automation_shared_intelligence_v3.sql, which likewise keeps its tenant and identity columns as bare uuids rather than becoming a child record of them. user_id and organization_id therefore carry no foreign key: an auth.users or public.organizations reference would place this table in the implicit-FK acquisition catalogue (scripts/account-case-graph-fks.json), and every writer would then have to take private.lock_case_graph() -- one database-wide pg_advisory_xact_lock(509, 700) -- before saving or deleting a saved view, which is unacceptable on a hot presentation-state path that carries no case data to serialize. This is the first migration since the account-lifecycle manifest to want an auth.users reference, and it declines one for exactly that reason; the rows can never orphan because deletion is wired explicitly instead, by the two AFTER DELETE statement triggers at the end of this migration and recorded in private.account_lifecycle_manifest.';

alter table public.member_saved_views enable row level security;
create policy member_saved_views_owner_only on public.member_saved_views
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
comment on policy member_saved_views_owner_only on public.member_saved_views is
  'Admits only the authenticated owner of a row to their own saved case-list views. A saved view is private presentation state (facet selections and one sort), never a grant of case access, so no coordinator, steward, chapter officer, or administrator role is admitted to another member''s rows. Table privileges stay revoked as well: reads and writes travel through the three security-definer RPCs, which resolve the caller and the active organization from the session.';
revoke all on public.member_saved_views from public, anon, authenticated;

create policy mfa_assurance on public.member_saved_views
as restrictive for all to authenticated
using ((select private.mfa_satisfied()))
with check ((select private.mfa_satisfied()));

comment on policy mfa_assurance on public.member_saved_views is
  'Restrictive MFA boundary carried by every row-level-secured public table; authenticated access stays denied unless the session satisfies the organization assurance policy. Direct table privileges are revoked and every read and write travels through the three security-definer RPCs, so this policy adds the repository-wide floor rather than any new admission.';

create function public.list_member_saved_views(p_plane text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
begin
  -- The three RPCs are SECURITY DEFINER and therefore bypass the table's own
  -- restrictive mfa_assurance policy. Each re-states the assurance floor itself
  -- so a definer path can never admit a session the table would refuse.
  if caller is null or org is null or not (select private.mfa_satisfied())
     or p_plane not in ('coordinator', 'steward') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', view.id,
      'name', view.name,
      'definition', view.definition,
      'isDefault', view.is_default,
      'createdAt', view.created_at,
      'updatedAt', view.updated_at
    ) order by view.is_default desc, view.name asc, view.id asc)
    from public.member_saved_views view
    where view.user_id = caller and view.organization_id = org and view.plane = p_plane
  ), '[]'::jsonb);
end;
$function$;

create function public.save_member_saved_view(
  p_id uuid default null,
  p_plane text default null,
  p_name text default null,
  p_definition jsonb default null,
  p_is_default boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  clean_name text := pg_catalog.btrim(coalesce(p_name, ''));
  saved public.member_saved_views%rowtype;
begin
  if caller is null or org is null or not (select private.mfa_satisfied()) then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_plane not in ('coordinator', 'steward')
     or pg_catalog.char_length(clean_name) not between 1 and 80
     or p_definition is null
     or pg_catalog.jsonb_typeof(p_definition) <> 'object'
     or not (p_definition ?& array['filters', 'sorting'])
     or pg_catalog.jsonb_typeof(p_definition->'filters') <> 'object'
     or pg_catalog.jsonb_typeof(p_definition->'sorting') <> 'array'
     or pg_catalog.jsonb_array_length(p_definition->'sorting') > 1
     or pg_catalog.octet_length(p_definition::text) > 6000
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_definition->'filters') key where key not in ('step','caseType','assignee','deadline','status','chapter'))
     or exists (select 1 from pg_catalog.jsonb_each(p_definition->'filters') pair where pg_catalog.jsonb_typeof(pair.value) <> 'string' or pg_catalog.char_length(pair.value #>> '{}') > 160)
     or exists (select 1 from pg_catalog.jsonb_array_elements(p_definition->'sorting') item where pg_catalog.jsonb_typeof(item) <> 'object' or item->>'id' not in ('member','title','step','deadline','status') or pg_catalog.jsonb_typeof(item->'desc') <> 'boolean') then
    raise exception 'invalid saved view' using errcode = '22023';
  end if;
  -- An existing id must be the caller's own row on the same plane: the upsert
  -- below never rewrites plane, so a mismatched plane would otherwise reset
  -- the wrong plane's default and then trip the one-default index instead
  -- of refusing cleanly.
  if p_id is not null and not exists (
    select 1 from public.member_saved_views where id = p_id and user_id = caller and organization_id = org and plane = p_plane
  ) then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_is_default then
    update public.member_saved_views set is_default = false, updated_at = pg_catalog.now()
    where user_id = caller and organization_id = org and plane = p_plane and (p_id is null or id <> p_id);
  end if;
  insert into public.member_saved_views (id, user_id, organization_id, plane, name, definition, is_default)
  values (coalesce(p_id, gen_random_uuid()), caller, org, p_plane, clean_name, p_definition, p_is_default)
  on conflict (id) do update set name = excluded.name, definition = excluded.definition,
    is_default = excluded.is_default, updated_at = pg_catalog.now()
  returning * into saved;
  return pg_catalog.jsonb_build_object('id', saved.id, 'name', saved.name, 'definition', saved.definition,
    'isDefault', saved.is_default, 'createdAt', saved.created_at, 'updatedAt', saved.updated_at);
end;
$function$;

create function public.delete_member_saved_view(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
begin
  if caller is null or org is null or not (select private.mfa_satisfied()) then raise exception 'not authorized' using errcode = '42501'; end if;
  delete from public.member_saved_views where id = p_id and user_id = caller and organization_id = org;
  if not found then raise exception 'not authorized' using errcode = '42501'; end if;
end;
$function$;

revoke all on function public.list_member_saved_views(text) from public, anon;
revoke all on function public.save_member_saved_view(uuid, text, text, jsonb, boolean) from public, anon;
revoke all on function public.delete_member_saved_view(uuid) from public, anon;
grant execute on function public.list_member_saved_views(text) to authenticated;
grant execute on function public.save_member_saved_view(uuid, text, text, jsonb, boolean) to authenticated;
grant execute on function public.delete_member_saved_view(uuid) to authenticated;

-- Deletion wiring. The table carries no foreign key (see COMMENT ON TABLE), so
-- nothing cascades into it. Both owning identities are swept explicitly, as
-- AFTER DELETE ... FOR EACH STATEMENT triggers over the deleted rows, so a
-- deleted account and a deleted organization can never leave a saved view
-- behind. Neither sweep takes an advisory lock: both run inside the deleting
-- statement's own transaction, which already holds the case-graph gate from the
-- a00_case_graph_lock statement trigger these two relations carry, and
-- public.member_saved_views is not a case-graph relation. The saved-view RPCs
-- take no advisory lock at all, so they can never hold one the deleter wants
-- and there is no lock cycle to order.
create function private.delete_member_saved_views_for_deleted_identities()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  delete from public.member_saved_views
  where user_id in (select id from deleted_identities);
  return null;
end;
$function$;
revoke all on function private.delete_member_saved_views_for_deleted_identities() from public, anon, authenticated, service_role;

create trigger member_saved_views_after_account_delete after delete on auth.users
referencing old table as deleted_identities
for each statement execute function private.delete_member_saved_views_for_deleted_identities();

create function private.delete_member_saved_views_for_deleted_organizations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  delete from public.member_saved_views
  where organization_id in (select id from deleted_organizations);
  return null;
end;
$function$;
revoke all on function private.delete_member_saved_views_for_deleted_organizations() from public, anon, authenticated, service_role;

create trigger member_saved_views_after_organization_delete after delete on public.organizations
referencing old table as deleted_organizations
for each statement execute function private.delete_member_saved_views_for_deleted_organizations();

-- The account-lifecycle contract is recorded in one place for this table too.
-- delete_disposition is 'not_applicable' because there is no referential action
-- to review: private.account_lifecycle_unmanaged_restrictive_fks() only reviews
-- 'cascade' and 'pseudonymize' rows, each of which must be backed by a direct
-- auth.users foreign key. export_inventory_basis stays null for the same reason,
-- so the bidirectional auth_user_fk ownership inventory is untouched.
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, exclusion_reason, note, reviewed_at)
values
  ('public', 'member_saved_views', 'user_id', 'not_applicable', 'excluded_with_reason',
   null, null,
   'Private case-list presentation state -- facet selections and one sort, capped at 6000 bytes -- with no member-authored content, no case identifier and no case content. It is configuration of the member''s own console, not portable member data, so it is excluded from the member data export by review rather than projected into it.',
   'Deliberately outside the case graph, so there is no auth.users or public.organizations foreign key and no referential deletion disposition to enforce. Rows are removed explicitly by the AFTER DELETE statement triggers member_saved_views_after_account_delete on auth.users and member_saved_views_after_organization_delete on public.organizations, both created in supabase/migrations/20260917101000_member_saved_case_views.sql and proven in tests/member-saved-views-db.test.js.',
   current_date);

-- Both triggers and both trigger functions enter the reviewed lifecycle trigger
-- surface, with the definition hashes taken from the surface itself rather than
-- copied in by hand, and the whole review must be complete before this migration
-- may commit.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and (
    (schema_name = 'auth' and table_name = 'users' and object_name = 'member_saved_views_after_account_delete')
    or (schema_name = 'public' and table_name = 'organizations' and object_name = 'member_saved_views_after_organization_delete')))
  or (kind = 'function' and schema_name = 'private' and table_name = '' and object_name in (
    'delete_member_saved_views_for_deleted_identities()',
    'delete_member_saved_views_for_deleted_organizations()'));

do $assert_member_saved_views_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the member saved views migration';
  end if;
end;
$assert_member_saved_views_trigger_review$;

notify pgrst, 'reload schema';
commit;
