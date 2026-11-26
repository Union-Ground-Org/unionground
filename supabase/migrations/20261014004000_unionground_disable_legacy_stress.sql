-- This schema is intentionally provider-disconnected until a deployment gives
-- it its own Supabase project. The inherited stress RPCs are high-volume
-- service-role mutation capabilities; keeping their old token and project
-- contract live would let an inherited environment seed or delete source-system
-- users. Retain the functions for historical migration compatibility, but make
-- them unreachable to every API role.
--
-- Re-evaluated against the current schema on 2026-10-14 (this file ran at
-- 20260724091653 against an earlier schema). Earlier migrations added more
-- lanes of the same kind, all service_role-only bulk seeders and removers
-- keyed to fixed hosted project refs:
--   * member_stress_enrich_batch / member_stress_enrich_verify (stress lane);
--   * uniondemo_* (a sales-demo organization lane);
--   * presg_demo_* (the retired sales-demo lane);
--   * sensitive_demo_seed_plan (the lane planner).
-- They get the same treatment: kept (earlier migrations and private helpers
-- reference them), unreachable from every API role. Nothing in src/ or api/
-- calls them; the scripts/ seeders that do target other projects and are
-- refused by src/lib/providerContract.js. No function or table is dropped.

-- Session-scoped, not SET LOCAL: the CLI applies each migration file outside an
-- explicit transaction, where SET LOCAL raises WARNING 25P01 and silently does
-- nothing. As written this guard never bounded a single lock wait.
set lock_timeout = '5s';

-- The space before each argument list is deliberate: the repository's tests find
-- "the latest definition" of a function by searching migrations for
-- `function <name>(`, and a revoke written that way would be mistaken for one.

revoke all on function public.member_stress_apply_batch (uuid, integer, integer, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.member_stress_begin (uuid, text, integer, integer, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.member_stress_begin_remove (uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.member_stress_remove_batch (uuid, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.member_stress_status (uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.member_stress_verify (uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.member_stress_enrich_batch (uuid, text, integer, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.member_stress_enrich_verify (uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_apply_batch (uuid, integer, integer, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_begin (uuid, text, integer, integer, integer, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_begin_remove (uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_enrich_batch (uuid, text, integer, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_function_parity_status (uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_prepare_reapply (uuid, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_remove_batch (uuid, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_remove_function_parity (uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_seed_channels (uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_seed_function_parity (uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_seed_org (uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_status (uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_verify (uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.sensitive_demo_seed_plan (text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_apply_batch (uuid, integer, integer, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_begin (uuid, text, integer, integer, integer, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_begin_remove (uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_enrich_batch (uuid, text, integer, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_function_parity_status (uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_prepare_reapply (uuid, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_remove_batch (uuid, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_remove_function_parity (uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_seed_channels (uuid, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_seed_function_parity (uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_seed_org (uuid, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_status (uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_topup_upcoming_events (text[], text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.uniondemo_verify (uuid, text)
  from public, anon, authenticated, service_role;
