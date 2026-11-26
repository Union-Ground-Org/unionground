-- REQ-UG-FULL-DEPTH-20260723 PR5: realtime in-app notification feed.
-- Adds member_notifications to the supabase_realtime publication so the app
-- can subscribe to postgres_changes INSERT events. RLS is already enabled with
-- a self-scoped select policy, which Realtime enforces per-subscriber for
-- INSERT and UPDATE.
--
-- DELETE is the exception: Realtime cannot evaluate a row policy against a
-- delete payload, which under the default replica identity is the primary key
-- alone. Any authenticated subscriber would therefore receive the UUID of any
-- deleted notification row, including other members'. It is a bare identifier
-- with no user linkage, but the app has no use for delete or update events at
-- all, so the publication is narrowed to INSERT rather than leaving an
-- unnecessary channel open.
--
-- `publish` is a publication-level parameter — PostgreSQL has no per-table
-- operation list — so this is only safe while member_notifications is the sole
-- member of the publication. The guard below enforces exactly that: if some
-- later feature has already added another table, the narrowing is skipped and
-- the publication is left as it was rather than silently changing that
-- feature's event stream. Verified live 2026-07-23: the publication exists
-- with zero tables.
--
-- To widen it later (e.g. a feature that needs UPDATE events), restore the
-- default with:  alter publication supabase_realtime set (publish = 'insert, update, delete, truncate');
-- `publish` is a publication-level setting, not a per-table one, so
-- member_notifications cannot be added insert-only while the publication also
-- carries UPDATE/DELETE for someone else's table. That matters specifically
-- because Realtime cannot RLS-filter a DELETE payload: a published DELETE
-- broadcasts the deleted row's primary key to subscribers regardless of who
-- owned it.
--
-- So the order is: prove the publication can be insert-only, make it
-- insert-only, and only then add the table. Adding first and discovering
-- afterwards that the flags cannot be narrowed would leave cross-member
-- notification UUIDs broadcasting, and a `raise notice` is not a control — it
-- scrolls past in a migration log and the schema still ships. If the
-- assumption does not hold, this migration must fail and be resolved by a
-- human who can decide what the other table needs.
--
-- Verified against production before writing this: supabase_realtime currently
-- publishes ZERO tables, so the insert-only path is the one that runs.
do $$
declare
  other_tables integer;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;

  select pg_catalog.count(*) into other_tables
  from pg_catalog.pg_publication_tables
  where pubname = 'supabase_realtime'
    and not (schemaname = 'public' and tablename = 'member_notifications');

  if other_tables > 0 then
    raise exception
      'supabase_realtime carries % other table(s); member_notifications cannot be published insert-only without changing them. Resolve deliberately: either move those tables to their own publication or confirm they tolerate insert-only.',
      other_tables;
  end if;

  execute 'alter publication supabase_realtime set (publish = ''insert'')';

  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'member_notifications'
  ) then
    execute 'alter publication supabase_realtime add table public.member_notifications';
  end if;

  -- Belt and braces: refuse to commit a publication that can still emit a
  -- DELETE payload for this table.
  if exists (
    select 1 from pg_catalog.pg_publication
    where pubname = 'supabase_realtime' and (pubdelete or pubupdate or pubtruncate)
  ) then
    raise exception 'supabase_realtime is not insert-only after narrowing; refusing to publish member_notifications';
  end if;
end
$$;
