-- Cover every foreign key introduced by the CR-084 Dues delivery. These
-- indexes bound parent updates/deletes and relationship lookups as customers
-- onboard. They create no tenants, providers, obligations, payments, or seed
-- rows. SAMPLE-only relations are guarded so this exact migration remains
-- data-neutral when applied to production.

set local lock_timeout = '5s';

create index if not exists dues_checkout_recovery_audit_org_idx
  on private.dues_checkout_recovery_audit (organization_id);
create index if not exists dues_checkout_recovery_audit_reservation_idx
  on private.dues_checkout_recovery_audit (reservation_id);

create index if not exists dues_financial_identity_selected_by_idx
  on private.dues_financial_identity_selections (selected_by);
create index if not exists dues_financial_identity_user_idx
  on private.dues_financial_identity_selections (user_id);

create index if not exists dues_stripe_oauth_states_org_idx
  on private.dues_stripe_oauth_states (organization_id);
create index if not exists dues_stripe_oauth_states_requester_idx
  on private.dues_stripe_oauth_states (requested_by);

create index if not exists dues_assessment_batches_creator_idx
  on public.dues_assessment_batches (created_by);
create index if not exists dues_assessment_batches_chapter_fk_idx
  on public.dues_assessment_batches (organization_id, chapter_id);

create index if not exists dues_checkout_reservations_requester_idx
  on public.dues_checkout_reservations (requested_by);
create index if not exists dues_checkout_reservations_obligation_fk_idx
  on public.dues_checkout_reservations (organization_id, obligation_id);
create index if not exists dues_ledger_events_creator_idx
  on public.dues_ledger_events (created_by);

create index if not exists dues_notification_deliveries_notification_idx
  on public.dues_notification_deliveries (notification_id);
create index if not exists dues_notification_deliveries_attempt_idx
  on public.dues_notification_deliveries (reminder_attempt_id);

create index if not exists dues_obligations_chapter_fk_idx
  on public.dues_obligations (organization_id, chapter_id);
create index if not exists dues_reminder_attempts_creator_idx
  on public.dues_reminder_attempts (created_by);
create index if not exists dues_stripe_events_reservation_idx
  on public.dues_stripe_events (reservation_id);

-- Keep the SAMPLE-only indexes fail-closed on production, including databases
-- that still carry historical demo tables. The helper is also called by the
-- binding trigger below so a fresh SAMPLE database that installs its required
-- out-of-band identity after migrations cannot permanently miss these indexes.
create or replace function private.ensure_dues_sample_seed_covering_indexes()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  is_sample_installation boolean := false;
begin
  -- Table presence alone is not an environment identity: historical SAMPLE
  -- schema objects can exist on production while their mutation entrypoints
  -- remain disabled. Require the out-of-band SAMPLE binding to match this
  -- exact Postgres cluster and database before creating any SAMPLE-only index.
  if pg_catalog.to_regclass('private.demo_seed_installation_bindings') is not null then
    select exists (
      select 1
      from private.demo_seed_installation_bindings as binding
      cross join pg_catalog.pg_control_system() as control
      join pg_catalog.pg_database as database
        on database.datname = pg_catalog.current_database()
      where binding.project_ref = 'sampledemoprojectref'
        and binding.system_identifier = control.system_identifier::numeric
        and binding.database_oid = database.oid
    )
    into is_sample_installation;
  end if;

  if not is_sample_installation then
    return;
  end if;

  perform pg_catalog.set_config('lock_timeout', '5s', true);

  if pg_catalog.to_regclass('private.dues_sample_seed_ledger') is not null then
    execute 'create index if not exists dues_sample_seed_ledger_assessment_event_idx
      on private.dues_sample_seed_ledger (assessment_event_id)';
    execute 'create index if not exists dues_sample_seed_ledger_settlement_event_idx
      on private.dues_sample_seed_ledger (settlement_event_id)';
    execute 'create index if not exists dues_sample_seed_ledger_reminder_attempt_idx
      on private.dues_sample_seed_ledger (reminder_attempt_id)';
  end if;

  if pg_catalog.to_regclass('private.dues_sample_seed_runs') is not null then
    execute 'create index if not exists dues_sample_seed_runs_subject_idx
      on private.dues_sample_seed_runs (featured_subject_id)';
    execute 'create index if not exists dues_sample_seed_runs_org_idx
      on private.dues_sample_seed_runs (organization_id)';
  end if;
end
$function$;

revoke all on function private.ensure_dues_sample_seed_covering_indexes()
  from public, anon, authenticated, service_role;

comment on function private.ensure_dues_sample_seed_covering_indexes() is
  'Creates Dues seed-table covering indexes only after this database is bound to the isolated SAMPLE project.';

create or replace function private.on_demo_seed_binding_ensure_dues_indexes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $trigger$
begin
  perform private.ensure_dues_sample_seed_covering_indexes();
  return new;
end
$trigger$;

revoke all on function private.on_demo_seed_binding_ensure_dues_indexes()
  from public, anon, authenticated, service_role;

drop trigger if exists demo_seed_binding_ensure_dues_indexes
  on private.demo_seed_installation_bindings;

create trigger demo_seed_binding_ensure_dues_indexes
after insert or update of system_identifier, database_oid
on private.demo_seed_installation_bindings
for each row
execute function private.on_demo_seed_binding_ensure_dues_indexes();

-- Cover an already-bound SAMPLE installation during this migration. Production
-- returns without creating any SAMPLE-only index because it has no live binding.
do $bootstrap_sample_indexes$
begin
  perform private.ensure_dues_sample_seed_covering_indexes();
end
$bootstrap_sample_indexes$;
