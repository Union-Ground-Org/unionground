-- The function-parity enrichment exercises notification-producing workflows.
-- On a fully migrated hosted project those workflows create typed in-app
-- notifications even though every SAMPLE profile disables outbound topics.
-- The original seed verifier incorrectly treated the typed rows themselves as
-- outbound activity. Preserve every other seed invariant and make the actual
-- egress boundary authoritative: zero notification_delivery rows.

alter function public.presg_demo_verify(uuid, text)
  rename to presg_demo_verify_pre_function_parity;
alter function public.presg_demo_verify_pre_function_parity(uuid, text)
  set schema private;

revoke all on function private.presg_demo_verify_pre_function_parity(uuid, text)
  from public, anon, authenticated;

create function public.presg_demo_verify(p_run_id uuid, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.presg_demo_runs%rowtype;
  result jsonb;
  passed boolean;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'presg demo RPC requires service_role';
  end if;

  select * into run from private.presg_demo_runs where id = p_run_id;
  if not found then raise exception 'unknown presg demo run'; end if;

  result := private.presg_demo_verify_pre_function_parity(p_run_id, p_password);

  passed :=
    (result ->> 'ledger_rows')::bigint = run.member_count
    and (result ->> 'auth_users')::bigint = run.member_count
    and (result ->> 'profiles')::bigint = run.member_count
    and (result ->> 'steward_roles')::bigint = run.committee_count
    and (result ->> 'guarded_prefs')::bigint = run.member_count
    and (result ->> 'outbound_deliveries')::bigint = 0
    and (result ->> 'points_in_current_week')::bigint = 0
    and (result ->> 'cases')::bigint = (result ->> 'cases_distinct_refs')::bigint
    and (result ->> 'password_sample')::bigint = (result ->> 'password_sample_size')::bigint
    and (result ->> 'login_rows')::bigint = run.login_count
    and (result ->> 'conversations')::bigint >= run.member_count
    and (result ->> 'messages')::bigint >= run.member_count * 4
    and (result ->> 'org_events')::bigint >= 60
    and (result ->> 'org_ballots')::bigint = 6
    and (result ->> 'org_broadcasts')::bigint >= 90
    and (result ->> 'org_threads')::bigint >= 100
    and (result ->> 'org_thread_posts')::bigint >= 1500
    and (result ->> 'protected_unchanged')::boolean;

  if passed then
    update private.presg_demo_runs
    set state = 'verified', verified_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = p_run_id;
  end if;

  return result || jsonb_build_object(
    'state', case when passed then 'verified' else run.state end,
    'ok', passed);
end;
$$;

revoke all on function public.presg_demo_verify(uuid, text)
  from public, anon, authenticated;
grant execute on function public.presg_demo_verify(uuid, text) to service_role;

alter function public.uniondemo_verify(uuid, text)
  rename to uniondemo_verify_pre_function_parity;
alter function public.uniondemo_verify_pre_function_parity(uuid, text)
  set schema private;

revoke all on function private.uniondemo_verify_pre_function_parity(uuid, text)
  from public, anon, authenticated;

create function public.uniondemo_verify(p_run_id uuid, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.uniondemo_runs%rowtype;
  result jsonb;
  passed boolean;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'union demo RPC requires service_role';
  end if;

  select * into run from private.uniondemo_runs where id = p_run_id;
  if not found then raise exception 'unknown union demo run'; end if;

  result := private.uniondemo_verify_pre_function_parity(p_run_id, p_password);

  passed :=
    (result ->> 'ledger_rows')::bigint = run.member_count
    and (result ->> 'auth_users')::bigint = run.member_count
    and (result ->> 'profiles')::bigint = run.member_count
    and (result ->> 'chapters')::bigint = 20
    and (result ->> 'steward_roles')::bigint = run.steward_count
    and (result ->> 'officer_roles')::bigint = 61
    and (result ->> 'chapter_mismatches')::bigint = 0
    and (result ->> 'guarded_prefs')::bigint = run.member_count
    and (result ->> 'outbound_deliveries')::bigint = 0
    and (result ->> 'points_in_current_week')::bigint = 0
    and (result ->> 'cases')::bigint = (result ->> 'cases_distinct_refs')::bigint
    and (result ->> 'password_sample')::bigint = (result ->> 'password_sample_size')::bigint
    and (result ->> 'login_rows')::bigint = run.login_count
    and (result ->> 'conversations')::bigint >= run.member_count
    and (result ->> 'messages')::bigint >= run.member_count * 4
    and (result ->> 'org_events')::bigint >= 20 * 60
    and (result ->> 'org_ballots')::bigint = 20 * 9
    and (result ->> 'org_broadcasts')::bigint >= 200
    and (result ->> 'org_threads')::bigint >= 20 * 30
    and (result ->> 'org_thread_posts')::bigint >= 20 * 300
    and (result ->> 'org_tasks')::bigint >= 20 * 40
    and (result ->> 'appointments')::bigint >= run.steward_count
    and (result ->> 'protected_unchanged')::boolean;

  if passed then
    update private.uniondemo_runs
    set state = 'verified', verified_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = p_run_id;
  end if;

  return result || jsonb_build_object(
    'state', case when passed then 'verified' else run.state end,
    'ok', passed);
end;
$$;

revoke all on function public.uniondemo_verify(uuid, text)
  from public, anon, authenticated;
grant execute on function public.uniondemo_verify(uuid, text) to service_role;
