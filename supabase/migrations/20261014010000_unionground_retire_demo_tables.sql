-- Retire the nine public.demo_* tables inherited from an earlier demo API.
--
-- 20260720191847_fresh_member_workflows.sql:360 already ran
-- `revoke all on all tables in schema public from anon`, so anon lost the
-- SELECT grants created at 20260719171218_create_demo_member_app.sql:113-124.
-- What survived is worse than harmless: nine empty-shaped tables still
-- carrying "readable to anon, authenticated" policies, an `authenticated`
-- SELECT grant that was never revoked, and a schema comment describing the
-- database as an "Exposed demo API". Every reader has to re-derive that the
-- exposure is already closed, and README's "Do not add anonymous table
-- grants" invariant reads as violated on the face of the migration.
--
-- Nothing reads them. `grep -rn` for the nine table names and `demo_visible`
-- across the whole tree (excluding node_modules and apps/) matched only their
-- creating migration and supabase/seed.sql, which this change deletes. The
-- shipped demo experience is client-side (src/data/fallback.js), not a
-- database surface.
--
-- Re-evaluated against the current schema on 2026-10-14 (this file ran at
-- 20260725101000 against an earlier schema). The earlier migrations still
-- carry the same nine tables, still empty-shaped and still unread: no file
-- under src/, api/, apps/ or scripts/ queries them (only grant-revoke
-- migrations name them, and scripts/db-contract.json records their residual
-- grants). They are an old demo API, not a product feature, so the drop
-- stands. The private.demo_seed_* ledger tables are a different, live
-- seeding lane and are not touched.

drop table if exists public.demo_members cascade;
drop table if exists public.demo_weekly_summaries cascade;
drop table if exists public.demo_week_days cascade;
drop table if exists public.demo_plan_items cascade;
drop table if exists public.demo_conversations cascade;
drop table if exists public.demo_broadcasts cascade;
drop table if exists public.demo_cases cascade;
drop table if exists public.demo_metrics cascade;
drop table if exists public.demo_rights_lessons cascade;

comment on schema public is
  'Union Ground member portal. Every table uses row level security; clients '
  'reach writes through security-definer RPCs and anon holds no table grants.';

notify pgrst, 'reload schema';
