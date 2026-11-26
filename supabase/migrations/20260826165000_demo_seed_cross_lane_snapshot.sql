-- Both SAMPLE lanes are designed to coexist. Protect real rows from mutation,
-- but do not let one synthetic lane invalidate the other's baseline merely by
-- being applied later. Collision preflights and per-run ledgers continue to
-- guard every synthetic identity and owned row.

create or replace function private.presg_demo_protected_snapshot(p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(snapshot) order by snapshot.email, snapshot.id), '[]'::jsonb)
  from (
    select
      users.id,
      pg_catalog.lower(users.email) as email,
      (select pg_catalog.count(*) from public.member_profiles rows where rows.id = users.id) as profiles,
      (select pg_catalog.count(*) from public.member_notifications rows where rows.user_id = users.id) as notifications,
      (select pg_catalog.count(*) from public.member_conversations rows where rows.user_id = users.id) as conversations,
      (select pg_catalog.count(*) from public.member_messages rows where rows.user_id = users.id) as messages,
      (select pg_catalog.count(*) from public.member_cases rows where rows.user_id = users.id) as cases
    from auth.users users
    where not coalesce(users.raw_app_meta_data ?| array[
      'uniondemo_run_id', 'presg_demo_run_id', 'member_stress_run_id'], false)
  ) snapshot;
$$;

revoke all on function private.presg_demo_protected_snapshot(uuid)
  from public, anon, authenticated, service_role;
