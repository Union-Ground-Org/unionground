-- A second deterministic SAMPLE apply rebuilds member_cases before reseeding
-- parity-owned casework. Some casework deletes emit audit rows, so the prior
-- cleanup's early audit delete left fresh composite-FK dependants behind.
-- Keep the foreign key intact and delete only audit rows tied to this run's
-- deterministic case ids, after every audit-producing source row is gone.

create or replace function private.demo_seed_remove_casework(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
#variable_conflict use_variable
declare
  organization_id uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  );
  parity_case_ids uuid[];
begin
  if p_lane not in ('presg', 'uniondemo') then
    raise exception 'unknown demo lane';
  end if;

  select pg_catalog.array_agg(private.member_stress_uuid(
    p_run_id::text || ':parity:case:' || ordinal
  ))
  into parity_case_ids
  from pg_catalog.generate_series(1, 120) as numbered(ordinal);

  delete from public.casework_retaliation_pattern_notes row
  using public.casework_retaliation_patterns pattern
  where row.pattern_id = pattern.id and pattern.organization_id = organization_id;
  delete from public.casework_retaliation_pattern_reports row
  using public.casework_retaliation_patterns pattern
  where row.pattern_id = pattern.id and pattern.organization_id = organization_id;
  delete from public.casework_retaliation_patterns row where row.organization_id = organization_id;
  delete from public.casework_management_addenda row where row.organization_id = organization_id;
  delete from public.casework_alert_acknowledgements row where row.organization_id = organization_id;
  delete from public.casework_deadline_extensions row where row.organization_id = organization_id;
  delete from public.casework_checklist_items row where row.organization_id = organization_id;
  delete from public.casework_entity_links row where row.organization_id = organization_id;
  delete from public.casework_access_grants row where row.organization_id = organization_id;
  delete from public.casework_strength_analyses row where row.organization_id = organization_id;
  delete from public.casework_bargaining_events row where row.organization_id = organization_id;
  delete from public.casework_bargaining_proposals row where row.organization_id = organization_id;
  delete from public.casework_management_entries row where row.organization_id = organization_id;
  delete from public.casework_management_people row where row.organization_id = organization_id;
  delete from public.casework_retaliation_reports row where row.organization_id = organization_id;
  delete from public.casework_intake_drafts row where row.organization_id = organization_id;
  delete from public.casework_reminders row where row.organization_id = organization_id;
  delete from public.casework_step_transitions row where row.organization_id = organization_id;
  delete from public.casework_alerts row where row.organization_id = organization_id;
  delete from public.casework_checklists row where row.organization_id = organization_id;
  delete from public.casework_checklist_templates row where row.organization_id = organization_id;
  delete from public.casework_deadlines row where row.organization_id = organization_id;
  delete from public.casework_bargaining_workspaces row where row.organization_id = organization_id;

  perform pg_catalog.set_config(
    'unionground.demo_seed_casework_scope',
    pg_catalog.jsonb_build_object(
      'lane', p_lane, 'runId', p_run_id, 'organizationId', organization_id
    )::text,
    true
  );
  begin
    update public.member_cases row
    set is_restricted = false,
        restriction_reason = null,
        restricted_at = null,
        restricted_by = null,
        steward_user_id = null,
        steward_name = null,
        assigned_at = null
    where row.organization_id = organization_id
      and row.id = any(parity_case_ids);
  exception when others then
    perform pg_catalog.set_config('unionground.demo_seed_casework_scope', '', true);
    raise;
  end;
  perform pg_catalog.set_config('unionground.demo_seed_casework_scope', '', true);

  delete from public.casework_audit_events row
  where row.organization_id = organization_id
    and (
      row.case_id = any(parity_case_ids)
      or (
        row.metadata ->> 'reasonCode' = 'sample-seed'
        and row.metadata ->> 'runId' = p_run_id::text
      )
    );

  return pg_catalog.jsonb_build_object(
    'removed', true,
    'lane', p_lane,
    'runId', p_run_id
  );
end;
$function$;

create function public.presg_demo_prepare_reapply(
  p_run_id uuid,
  p_password text,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '120s'
as $function$
declare
  run private.presg_demo_runs%rowtype;
  password_hash text;
  refreshed_logins bigint;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.presg_demo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown presg demo run'; end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified') then
    raise exception 'run cannot be prepared in state %', run.state;
  end if;
  if pg_catalog.char_length(coalesce(p_password, '')) < 24 then
    raise exception 'demo password is too short';
  end if;

  password_hash := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
  update private.presg_demo_runs
  set protected_snapshot = private.presg_demo_protected_snapshot(p_run_id),
      updated_at = pg_catalog.now()
  where id = p_run_id;

  update auth.users users
  set encrypted_password = password_hash,
      updated_at = pg_catalog.now()
  from private.presg_demo_ledger ledger
  where ledger.run_id = p_run_id
    and ledger.login_capable
    and users.id = ledger.user_id
    and users.raw_app_meta_data ->> 'presg_demo_run_id' = p_run_id::text;
  get diagnostics refreshed_logins = row_count;

  return pg_catalog.jsonb_build_object(
    'runId', p_run_id,
    'protectedSnapshotRefreshed', true,
    'loginPasswordsRefreshed', refreshed_logins
  );
end;
$function$;

create function public.uniondemo_prepare_reapply(
  p_run_id uuid,
  p_password text,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '120s'
as $function$
declare
  run private.uniondemo_runs%rowtype;
  password_hash text;
  refreshed_logins bigint;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.uniondemo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified') then
    raise exception 'run cannot be prepared in state %', run.state;
  end if;
  if pg_catalog.char_length(coalesce(p_password, '')) < 24 then
    raise exception 'demo password is too short';
  end if;

  password_hash := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
  update private.uniondemo_runs
  set protected_snapshot = private.uniondemo_protected_snapshot(p_run_id),
      updated_at = pg_catalog.now()
  where id = p_run_id;

  update auth.users users
  set encrypted_password = password_hash,
      updated_at = pg_catalog.now()
  from private.uniondemo_ledger ledger
  where ledger.run_id = p_run_id
    and ledger.login_capable
    and users.id = ledger.user_id
    and users.raw_app_meta_data ->> 'uniondemo_run_id' = p_run_id::text;
  get diagnostics refreshed_logins = row_count;

  return pg_catalog.jsonb_build_object(
    'runId', p_run_id,
    'protectedSnapshotRefreshed', true,
    'loginPasswordsRefreshed', refreshed_logins
  );
end;
$function$;

revoke all on function private.demo_seed_remove_casework(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.presg_demo_prepare_reapply(uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.uniondemo_prepare_reapply(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.presg_demo_prepare_reapply(uuid, text, text, text)
  to service_role;
grant execute on function public.uniondemo_prepare_reapply(uuid, text, text, text)
  to service_role;

comment on function private.demo_seed_remove_casework(text, uuid) is
  'Dependency-ordered SAMPLE casework cleanup; trigger-generated audit rows are removed last and only for the deterministic run case ids.';
comment on function public.presg_demo_prepare_reapply(uuid, text, text, text) is
  'Refreshes the operation-scoped protected snapshot and owned login hashes before a deterministic Union Ground reapply.';
comment on function public.uniondemo_prepare_reapply(uuid, text, text, text) is
  'Refreshes the operation-scoped protected snapshot and owned login hashes before a deterministic Union Demo reapply.';
