-- SAMPLE-only deterministic evidence for the administration auth surfaces.
--
-- Passkey credentials remain owned by GoTrue and recovery codes are secrets
-- generated only by an authenticated AAL2 member. This repair therefore seeds
-- only non-credential readiness controls, tenant configuration, allowlisted
-- labels, and hashed failed-login operations events. Both demo lanes retain
-- their existing SAMPLE-project, confirmation-token, service-role, and
-- reversible-run boundaries.

set local lock_timeout = '5s';

update private.demo_seed_function_catalog
set coverage = 'seeded',
    evidence_key = case function_id
      when 'CR-100' then 'auth-passkey-enrollment-ready'
      when 'CR-101' then 'auth-recovery-code-enrollment-ready'
      when 'CR-102' then 'auth-tenant-settings'
      when 'CR-103' then 'auth-label-overrides'
      when 'CR-105' then 'auth-failed-login-inbox'
    end,
    gate_relation = null
where function_id in ('CR-100', 'CR-101', 'CR-102', 'CR-103', 'CR-105');

create function private.demo_seed_auth_operations_status(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_organization_id uuid;
  passkey_ready boolean;
  recovery_ready boolean;
  settings_ready boolean;
  labels_ready boolean;
  failed_login_ready boolean;
begin
  if p_lane = 'presg' then
    v_organization_id := private.member_stress_uuid(p_run_id::text || ':presg:organization');
  elsif p_lane = 'uniondemo' then
    v_organization_id := private.member_stress_uuid(p_run_id::text || ':ud:organization');
  else
    raise exception 'unknown demo lane';
  end if;

  select exists (
    select 1 from public.organization_setting_values v
    where v.organization_id = v_organization_id
      and v.setting_key = 'features.passkey_enrollment'
      and v.value = 'true'::jsonb
  ) into passkey_ready;

  select exists (
    select 1 from public.organization_setting_values v
    where v.organization_id = v_organization_id
      and v.setting_key = 'features.mfa_recovery_code_enrollment'
      and v.value = 'true'::jsonb
  ) into recovery_ready;

  select pg_catalog.count(*) = 4 into settings_ready
  from public.organization_setting_values v
  where v.organization_id = v_organization_id
    and (v.setting_key, v.value) in (
      ('features.passkey_enrollment', 'true'::jsonb),
      ('features.mfa_recovery_code_enrollment', 'true'::jsonb),
      ('security.failed_login_retention_days', '90'::jsonb),
      ('security.failed_login_alert_threshold', '3'::jsonb)
    );

  select pg_catalog.count(*) = 2 into labels_ready
  from public.organization_label_overrides o
  where o.organization_id = v_organization_id
    and (o.label_key, o.label_value) in (
      ('nav.myCases', 'Case support'),
      ('staff.chapterWork', 'Chapter work')
    );

  select pg_catalog.count(*) = 6 into failed_login_ready
  from public.organization_failed_login_attempts a
  where a.organization_id = v_organization_id
    and a.id in (
      select private.member_stress_uuid(p_run_id::text || ':auth:failed-login:' || n::text)
      from pg_catalog.generate_series(1, 6) as seeded(n)
    )
    and a.member_user_id is not null
    and a.identity_hash ~ '^[a-f0-9]{64}$';

  return pg_catalog.jsonb_build_object(
    'ok', passkey_ready and recovery_ready and settings_ready and labels_ready and failed_login_ready,
    'CR-100', passkey_ready,
    'CR-101', recovery_ready,
    'CR-102', settings_ready,
    'CR-103', labels_ready,
    'CR-105', failed_login_ready,
    'credentialRowsSeeded', 0,
    'outboundDeliveries', 0
  );
end;
$function$;

create function private.demo_seed_apply_auth_operations(
  p_lane text,
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_organization_id uuid;
  actor_user_id uuid;
  member_user_id uuid;
  member_email text;
  i integer;
  result jsonb;
begin
  if p_lane = 'presg' then
    perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
    if not exists (
      select 1 from private.presg_demo_runs
      where id = p_run_id and state in ('applied', 'verified')
    ) then
      raise exception 'presg demo run must be applied before auth operations data';
    end if;
    v_organization_id := private.member_stress_uuid(p_run_id::text || ':presg:organization');
  elsif p_lane = 'uniondemo' then
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
    if not exists (
      select 1 from private.uniondemo_runs
      where id = p_run_id and state in ('applied', 'verified')
    ) then
      raise exception 'union demo run must be applied before auth operations data';
    end if;
    v_organization_id := private.member_stress_uuid(p_run_id::text || ':ud:organization');
  else
    raise exception 'unknown demo lane';
  end if;

  if not exists (
    select 1 from public.organizations o
    where o.id = v_organization_id and o.status = 'active'
  ) then
    raise exception 'demo organization is missing';
  end if;

  actor_user_id := private.demo_seed_user(p_lane, p_run_id, 1);

  insert into public.organization_setting_values
    (organization_id, setting_key, value, updated_by, updated_at)
  values
    (v_organization_id, 'features.passkey_enrollment', 'true'::jsonb, actor_user_id, pg_catalog.now() - interval '2 days'),
    (v_organization_id, 'features.mfa_recovery_code_enrollment', 'true'::jsonb, actor_user_id, pg_catalog.now() - interval '2 days'),
    (v_organization_id, 'security.failed_login_retention_days', '90'::jsonb, actor_user_id, pg_catalog.now() - interval '2 days'),
    (v_organization_id, 'security.failed_login_alert_threshold', '3'::jsonb, actor_user_id, pg_catalog.now() - interval '2 days')
  on conflict (organization_id, setting_key) do update
    set value = excluded.value,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  insert into public.organization_label_overrides
    (organization_id, label_key, label_value, updated_by, updated_at)
  values
    (v_organization_id, 'nav.myCases', 'Case support', actor_user_id, pg_catalog.now() - interval '36 hours'),
    (v_organization_id, 'staff.chapterWork', 'Chapter work', actor_user_id, pg_catalog.now() - interval '36 hours')
  on conflict (organization_id, label_key) do update
    set label_value = excluded.label_value,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  for i in 1..6 loop
    member_user_id := private.demo_seed_user(p_lane, p_run_id, i + 1);
    select pg_catalog.lower(u.email) into member_email
    from auth.users u where u.id = member_user_id;
    if member_email is null then
      raise exception 'demo auth identity is missing';
    end if;

    insert into public.organization_failed_login_attempts (
      id, organization_id, member_user_id, identity_hash, method, source,
      user_agent, status, disposition_note, reviewed_by, reviewed_at, occurred_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':auth:failed-login:' || i::text),
      v_organization_id,
      member_user_id,
      pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(member_email, 'UTF8'), 'sha256'),
        'hex'
      ),
      case when i % 3 = 0 then 'passkey' else 'password' end,
      'web-sample',
      case when i % 2 = 0 then 'Mozilla/5.0 Safari/605.1.15' else 'Mozilla/5.0 Chrome/128.0.0.0' end,
      case when i <= 4 then 'open' else 'reviewed' end,
      case when i <= 4 then null else 'Confirmed member retry' end,
      case when i <= 4 then null else actor_user_id end,
      case when i <= 4 then null else pg_catalog.now() - ((i - 1)::text || ' hours')::interval end,
      pg_catalog.now() - (i::text || ' hours')::interval
    )
    on conflict (id) do update set
      organization_id = excluded.organization_id,
      member_user_id = excluded.member_user_id,
      identity_hash = excluded.identity_hash,
      method = excluded.method,
      source = excluded.source,
      user_agent = excluded.user_agent,
      status = excluded.status,
      disposition_note = excluded.disposition_note,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      occurred_at = excluded.occurred_at;
  end loop;

  result := private.demo_seed_auth_operations_status(p_lane, p_run_id);
  if not (result ->> 'ok')::boolean then
    raise exception 'auth operations seed contract failed: %', result;
  end if;
  return result;
end;
$function$;

create function private.demo_seed_remove_auth_operations(p_lane text, p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_organization_id uuid;
begin
  if p_lane = 'presg' then
    v_organization_id := private.member_stress_uuid(p_run_id::text || ':presg:organization');
  elsif p_lane = 'uniondemo' then
    v_organization_id := private.member_stress_uuid(p_run_id::text || ':ud:organization');
  else
    raise exception 'unknown demo lane';
  end if;

  delete from public.organization_failed_login_attempts a
  where a.organization_id = v_organization_id;
  delete from public.organization_configuration_audit a
  where a.organization_id = v_organization_id;
  delete from public.organization_label_overrides o
  where o.organization_id = v_organization_id;
  delete from public.organization_setting_values v
  where v.organization_id = v_organization_id;
end;
$function$;

create or replace function public.presg_demo_seed_function_parity(
  p_run_id uuid, p_target_ref text, p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  auth_result jsonb;
  parity_result jsonb;
begin
  auth_result := private.demo_seed_apply_auth_operations(
    'presg', p_run_id, p_target_ref, p_confirm_token
  );
  parity_result := private.demo_seed_apply_function_parity(
    'presg', p_run_id, p_target_ref, p_confirm_token
  );
  return parity_result || pg_catalog.jsonb_build_object(
    'ok', (parity_result ->> 'ok')::boolean and (auth_result ->> 'ok')::boolean,
    'authOperations', auth_result
  );
end;
$function$;

create or replace function public.uniondemo_seed_function_parity(
  p_run_id uuid, p_target_ref text, p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  auth_result jsonb;
  parity_result jsonb;
begin
  auth_result := private.demo_seed_apply_auth_operations(
    'uniondemo', p_run_id, p_target_ref, p_confirm_token
  );
  parity_result := private.demo_seed_apply_function_parity(
    'uniondemo', p_run_id, p_target_ref, p_confirm_token
  );
  return parity_result || pg_catalog.jsonb_build_object(
    'ok', (parity_result ->> 'ok')::boolean and (auth_result ->> 'ok')::boolean,
    'authOperations', auth_result
  );
end;
$function$;

create or replace function public.presg_demo_function_parity_status(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  auth_result jsonb;
  parity_result jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'service_role required'; end if;
  auth_result := private.demo_seed_auth_operations_status('presg', p_run_id);
  parity_result := private.demo_seed_function_parity_status('presg', p_run_id);
  return parity_result || pg_catalog.jsonb_build_object(
    'ok', (parity_result ->> 'ok')::boolean and (auth_result ->> 'ok')::boolean,
    'authOperations', auth_result
  );
end;
$function$;

create or replace function public.uniondemo_function_parity_status(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  auth_result jsonb;
  parity_result jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'service_role required'; end if;
  auth_result := private.demo_seed_auth_operations_status('uniondemo', p_run_id);
  parity_result := private.demo_seed_function_parity_status('uniondemo', p_run_id);
  return parity_result || pg_catalog.jsonb_build_object(
    'ok', (parity_result ->> 'ok')::boolean and (auth_result ->> 'ok')::boolean,
    'authOperations', auth_result
  );
end;
$function$;

create or replace function public.presg_demo_remove_function_parity(
  p_run_id uuid, p_target_ref text, p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_auth_operations('presg', p_run_id);
  return private.demo_seed_remove_function_parity('presg', p_run_id);
end;
$function$;

create or replace function public.uniondemo_remove_function_parity(
  p_run_id uuid, p_target_ref text, p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_auth_operations('uniondemo', p_run_id);
  return private.demo_seed_remove_function_parity('uniondemo', p_run_id);
end;
$function$;

revoke all on function private.demo_seed_auth_operations_status(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_apply_auth_operations(text, uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_remove_auth_operations(text, uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.presg_demo_seed_function_parity(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.uniondemo_seed_function_parity(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.presg_demo_function_parity_status(uuid)
  from public, anon, authenticated;
revoke all on function public.uniondemo_function_parity_status(uuid)
  from public, anon, authenticated;
revoke all on function public.presg_demo_remove_function_parity(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.uniondemo_remove_function_parity(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.presg_demo_seed_function_parity(uuid, text, text)
  to service_role;
grant execute on function public.uniondemo_seed_function_parity(uuid, text, text)
  to service_role;
grant execute on function public.presg_demo_function_parity_status(uuid)
  to service_role;
grant execute on function public.uniondemo_function_parity_status(uuid)
  to service_role;
grant execute on function public.presg_demo_remove_function_parity(uuid, text, text)
  to service_role;
grant execute on function public.uniondemo_remove_function_parity(uuid, text, text)
  to service_role;
