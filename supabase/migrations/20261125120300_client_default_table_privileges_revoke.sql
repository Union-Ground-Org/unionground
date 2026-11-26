-- SEC-UG-CLIENT-DEFAULT-TABLE-PRIVILEGES-REVOKE-20261114
--
-- Supabase's stock default privileges give anon and authenticated the full
-- privilege set on every new table in public. 20260725220000 removed TRUNCATE
-- from that default and 20260726010000 removed REFERENCES, TRIGGER and
-- MAINTAIN, so tables created since then are still born with SELECT, INSERT,
-- UPDATE and DELETE for both client roles. Row security holds today (every
-- public table has RLS on, scripts/db-contract.json policyCoverage), but a
-- table created by a later migration, or by a self-hosted operator, without
-- RLS would be readable and writable by anyone with the public key.
--
-- This changes only what FUTURE tables are born with. ALTER DEFAULT
-- PRIVILEGES never touches an existing object, so every table the earlier
-- migrations created keeps exactly the grants it has now, and the table and
-- column grant pins in scripts/db-contract.json are unchanged. From here on a
-- migration that creates a table in public grants the client roles exactly
-- what that table needs, in the same file.
--
-- Scope: tables in schema public created by role postgres (every table this
-- repository's migrations create). service_role keeps its full default set.
-- supabase_admin's own default ACL is outside postgres's reach and governs
-- only platform-created objects. Sequences and functions are not changed here.
--
-- ROLLBACK (restores the previous default, never a table's grants):
--   alter default privileges for role postgres in schema public
--     grant select, insert, update, delete on tables to anon, authenticated;

begin;
set local lock_timeout = '5s';

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated;

notify pgrst, 'reload schema';

commit;
