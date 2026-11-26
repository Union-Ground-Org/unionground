-- CR-084 guarded Dues SAMPLE history. This migration never applies a seed.
-- It only defines a service-only, reversible operation for the existing
-- fictional SAMPLE lanes. Production is refused before any mutation.

begin;

set local lock_timeout = '5s';

create table private.dues_sample_seed_runs (
  lane text not null check (lane in ('presg', 'uniondemo')),
  run_id uuid not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  featured_subject_id uuid references public.dues_member_subjects(id) on delete set null,
  state text not null check (state in ('applying', 'applied', 'removed')),
  applied_at timestamptz,
  removed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (lane, run_id)
);

create table private.dues_sample_seed_ledger (
  lane text not null,
  run_id uuid not null,
  ordinal integer not null check (ordinal between 1 and 60),
  batch_id uuid not null references public.dues_assessment_batches(id) on delete cascade,
  obligation_id uuid not null references public.dues_obligations(id) on delete cascade,
  assessment_event_id uuid not null references public.dues_ledger_events(id) on delete cascade,
  settlement_event_id uuid references public.dues_ledger_events(id) on delete cascade,
  reminder_attempt_id uuid references public.dues_reminder_attempts(id) on delete cascade,
  primary key (lane, run_id, ordinal),
  unique (batch_id),
  unique (obligation_id),
  foreign key (lane, run_id) references private.dues_sample_seed_runs(lane, run_id) on delete cascade
);

revoke all on private.dues_sample_seed_runs, private.dues_sample_seed_ledger
  from public, anon, authenticated, service_role;

create or replace function private.dues_sample_seed_organization(p_lane text, p_run_id uuid)
returns uuid
language sql
immutable
strict
security definer
set search_path = ''
as $function$
  select private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  )
$function$;

create or replace function private.dues_sample_seed_authorize(
  p_target_ref text,
  p_confirm_token text,
  p_lane text,
  p_run_id uuid,
  p_mode text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'dues SAMPLE seed requires service_role' using errcode = '42501';
  end if;
  if p_target_ref = 'productionprojectref' then
    raise exception 'production project refused' using errcode = '42501';
  end if;
  if p_target_ref <> 'sampledemoprojectref' then
    raise exception 'SAMPLE project required' using errcode = '42501';
  end if;
  if p_lane = 'presg' then
    perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
    if not exists (select 1 from private.presg_demo_runs row where row.id = p_run_id and row.state in ('applied', 'verified')) then
      raise exception 'presg demo run is not applied' using errcode = '42501';
    end if;
  elsif p_lane = 'uniondemo' then
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
    if not exists (select 1 from private.uniondemo_runs row where row.id = p_run_id and row.state in ('applied', 'verified')) then
      raise exception 'union demo run is not applied' using errcode = '42501';
    end if;
  else
    raise exception 'unknown demo lane' using errcode = '22023';
  end if;
  if p_mode not in ('apply', 'verify', 'remove') then
    raise exception 'invalid dues SAMPLE seed mode' using errcode = '22023';
  end if;
  org := private.dues_sample_seed_organization(p_lane, p_run_id);
  if not exists (select 1 from public.organizations organization where organization.id = org and organization.status = 'active') then
    raise exception 'demo organization is missing' using errcode = '42501';
  end if;
  return org;
end;
$function$;

-- The lane seeders predate Dues, but organization deletion must not leave the
-- membership-provisioned Dues subjects behind. The normal lane removal is
-- stopped until this run's Dues obligations are removed, then deletes only
-- that fictional lane organization’s subjects before its existing user/org
-- cleanup proceeds.
create or replace function private.dues_sample_remove_subjects_on_lane_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  lane_name text := case when tg_table_name = 'presg_demo_runs' then 'presg' else 'uniondemo' end;
  org uuid;
begin
  if new.state <> 'removing' or old.state = 'removing' then
    return new;
  end if;
  org := private.dues_sample_seed_organization(lane_name, new.id);
  if exists (
    select 1 from public.dues_obligations obligation
    where obligation.organization_id = org
  ) then
    raise exception 'remove Dues SAMPLE history before normal lane removal' using errcode = '55000';
  end if;
  delete from public.dues_member_subjects subject where subject.organization_id = org;
  return new;
end;
$function$;

drop trigger if exists dues_sample_remove_presg_subjects on private.presg_demo_runs;
create trigger dues_sample_remove_presg_subjects
  before update of state on private.presg_demo_runs
  for each row execute function private.dues_sample_remove_subjects_on_lane_removal();
drop trigger if exists dues_sample_remove_uniondemo_subjects on private.uniondemo_runs;
create trigger dues_sample_remove_uniondemo_subjects
  before update of state on private.uniondemo_runs
  for each row execute function private.dues_sample_remove_subjects_on_lane_removal();

create or replace function private.demo_seed_apply_dues(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.dues_sample_seed_organization(p_lane, p_run_id);
  featured_user uuid;
  subject_id uuid;
  existing private.dues_sample_seed_runs%rowtype;
  ordinal integer;
  batch_id uuid;
  obligation_id uuid;
  assessment_event_id uuid;
  settlement_event_id uuid;
  reminder_id uuid;
  due_date date;
  settlement_kind text;
  settlement_amount integer;
  settlement_method text;
begin
  if p_lane not in ('presg', 'uniondemo') then
    raise exception 'unknown demo lane' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.dues_provider_connections connection
    where connection.organization_id = org and connection.state <> 'unset'
  ) then
    raise exception 'SAMPLE Stripe must remain unset' using errcode = '55000';
  end if;
  featured_user := private.demo_seed_user(p_lane, p_run_id, 1);
  select subject.id into subject_id
  from public.dues_member_subjects subject
  where subject.organization_id = org and subject.user_id = featured_user;
  if subject_id is null then
    raise exception 'Dues subject provisioning incomplete' using errcode = '55000';
  end if;
  select * into existing from private.dues_sample_seed_runs row
  where row.lane = p_lane and row.run_id = p_run_id for update;
  if found and existing.state = 'applied' then
    return private.demo_seed_verify_dues(p_lane, p_run_id);
  end if;
  if found and existing.state = 'removed' then
    raise exception 'removed Dues SAMPLE run cannot be reapplied' using errcode = '55000';
  end if;
  insert into private.dues_sample_seed_runs (lane, run_id, organization_id, featured_subject_id, state, updated_at)
  values (p_lane, p_run_id, org, subject_id, 'applying', now())
  on conflict (lane, run_id) do update set state = 'applying', updated_at = now();

  for ordinal in 1..60 loop
    batch_id := private.member_stress_uuid(p_run_id::text || ':dues:batch:' || ordinal::text);
    obligation_id := private.member_stress_uuid(p_run_id::text || ':dues:obligation:' || ordinal::text);
    assessment_event_id := private.member_stress_uuid(p_run_id::text || ':dues:assessment:' || ordinal::text);
    settlement_event_id := null;
    reminder_id := null;
    -- 50 dated historical obligations at 22-day intervals reach slightly past
    -- three years while the first ten retain a realistic current/future mix.
    due_date := case when ordinal <= 10 then current_date + ordinal else current_date - ((ordinal - 10) * 22) end;
    insert into public.dues_assessment_batches (
      id, organization_id, chapter_id, title, description, scope_kind, amount_cents,
      currency, due_on, eligibility_fingerprint, idempotency_key, created_by, created_at
    ) values (
      batch_id, org, null, 'Monthly membership contribution',
      'A regular contribution supporting member services and chapter work.',
      'organization', 5000, 'USD', due_date,
      pg_catalog.encode(extensions.digest(p_run_id::text || ':dues:fingerprint:' || ordinal::text, 'sha256'), 'hex'),
      'dues-sample-batch:' || p_run_id::text || ':' || ordinal::text,
      null, due_date::timestamptz
    ) on conflict (id) do nothing;
    insert into public.dues_obligations (
      id, organization_id, batch_id, member_subject_id, chapter_id, issued_cents, due_on, created_at
    ) values (
      obligation_id, org, batch_id, subject_id, null, 5000, due_date, due_date::timestamptz
    ) on conflict (id) do nothing;
    insert into public.dues_ledger_events (
      id, organization_id, obligation_id, event_kind, amount_cents, effective_on,
      reason, payment_method, external_reference, receipt_number, idempotency_key, created_by, created_at
    ) values (
      assessment_event_id, org, obligation_id, 'assessment', 5000, due_date,
      'Monthly membership contribution', null, null, null,
      'dues-sample-assessment:' || p_run_id::text || ':' || ordinal::text, null, due_date::timestamptz
    ) on conflict (id) do nothing;

    settlement_kind := case when ordinal % 4 = 0 then 'waiver' when ordinal % 4 in (2, 3) then 'payment' else null end;
    settlement_amount := case when ordinal % 4 = 2 then 2500 else 5000 end;
    settlement_method := case when ordinal % 4 = 2 then 'manual_cash' when ordinal % 4 = 3 then 'manual_check' else null end;
    if settlement_kind is not null then
      settlement_event_id := private.member_stress_uuid(p_run_id::text || ':dues:settlement:' || ordinal::text);
      insert into public.dues_ledger_events (
        id, organization_id, obligation_id, event_kind, amount_cents, effective_on,
        reason, payment_method, external_reference, receipt_number, idempotency_key, created_by, created_at
      ) values (
        settlement_event_id, org, obligation_id, settlement_kind, settlement_amount,
        due_date + 3,
        case when settlement_kind = 'waiver' then 'Approved hardship waiver' else 'Recorded member contribution' end,
        settlement_method, null,
        case when settlement_kind = 'payment' then 'UG-' || extract(year from due_date)::text || '-' || pg_catalog.substr(pg_catalog.replace(p_run_id::text, '-', ''), 1, 8) || '-' || pg_catalog.lpad(ordinal::text, 3, '0') else null end,
        'dues-sample-settlement:' || p_run_id::text || ':' || ordinal::text,
        null, (due_date + 3)::timestamptz
      ) on conflict (id) do nothing;
    end if;
    if ordinal % 4 = 1 and ordinal > 10 then
      reminder_id := private.member_stress_uuid(p_run_id::text || ':dues:reminder:' || ordinal::text);
      insert into public.dues_reminder_attempts (
        id, organization_id, obligation_id, policy_window, channel, state,
        lease_epoch, attempt_count, outcome_code, request_idempotency_key, created_by, created_at, updated_at
      ) values (
        reminder_id, org, obligation_id, due_date, 'in_app', 'sent', 0, 1,
        'sample_seeded', 'dues-sample-reminder:' || p_run_id::text || ':' || ordinal::text,
        null, (due_date + 7)::timestamptz, (due_date + 7)::timestamptz
      ) on conflict (id) do nothing;
    end if;
    insert into private.dues_sample_seed_ledger (
      lane, run_id, ordinal, batch_id, obligation_id, assessment_event_id, settlement_event_id, reminder_attempt_id
    ) values (
      p_lane, p_run_id, ordinal, batch_id, obligation_id, assessment_event_id, settlement_event_id, reminder_id
    ) on conflict (lane, run_id, ordinal) do nothing;
  end loop;

  insert into private.demo_seed_page_contract (surface, page_size, minimum_rows, scope, source)
  values
    ('duesStaffObligations', 25, 50, 'organization', 'supabase/migrations/20260831170400_mi1_dues_settlement_reconciliation.sql'),
    ('duesMemberHistory', 25, 50, 'featured-member', 'supabase/migrations/20260831170400_mi1_dues_settlement_reconciliation.sql')
  on conflict (surface) do update set page_size = excluded.page_size, minimum_rows = excluded.minimum_rows,
    scope = excluded.scope, source = excluded.source;
  insert into private.demo_seed_page_evidence (lane, run_id, surface, actual_rows)
  values (p_lane, p_run_id, 'duesStaffObligations', 60), (p_lane, p_run_id, 'duesMemberHistory', 60)
  on conflict (lane, run_id, surface) do update set actual_rows = excluded.actual_rows, recorded_at = now();
  update private.dues_sample_seed_runs
  set state = 'applied', applied_at = coalesce(applied_at, now()), updated_at = now()
  where lane = p_lane and run_id = p_run_id;
  return private.demo_seed_verify_dues(p_lane, p_run_id);
end;
$function$;

create or replace function private.demo_seed_verify_dues(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded private.dues_sample_seed_runs%rowtype;
  obligation_count integer;
  assessment_count integer;
  receipt_count integer;
  reminder_count integer;
  open_count integer;
  overdue_count integer;
  partial_count integer;
  paid_count integer;
  waived_count integer;
begin
  select * into seeded from private.dues_sample_seed_runs row
  where row.lane = p_lane and row.run_id = p_run_id;
  if not found or seeded.state <> 'applied' then
    raise exception 'Dues SAMPLE seed is not applied' using errcode = '42501';
  end if;
  select count(*) into obligation_count from private.dues_sample_seed_ledger
  where lane = p_lane and run_id = p_run_id;
  select count(*) into assessment_count
  from public.dues_ledger_events event
  join private.dues_sample_seed_ledger ledger on ledger.assessment_event_id = event.id
  where ledger.lane = p_lane and ledger.run_id = p_run_id and event.event_kind = 'assessment';
  select count(*) into receipt_count
  from public.dues_ledger_events event
  join private.dues_sample_seed_ledger ledger on ledger.settlement_event_id = event.id
  where ledger.lane = p_lane and ledger.run_id = p_run_id and event.receipt_number is not null;
  select count(*) into reminder_count from public.dues_reminder_attempts reminder
  join private.dues_sample_seed_ledger ledger on ledger.reminder_attempt_id = reminder.id
  where ledger.lane = p_lane and ledger.run_id = p_run_id and reminder.state = 'sent';
  with state_rows as (
    select obligation.id, obligation.due_on,
      coalesce(sum(event.amount_cents) filter (where event.event_kind = 'payment'), 0) as paid_cents,
      coalesce(sum(event.amount_cents) filter (where event.event_kind = 'waiver'), 0) as waived_cents
    from public.dues_obligations obligation
    join private.dues_sample_seed_ledger ledger on ledger.obligation_id = obligation.id
    left join public.dues_ledger_events event on event.obligation_id = obligation.id
    where ledger.lane = p_lane and ledger.run_id = p_run_id
    group by obligation.id, obligation.due_on
  ), standing as (
    select case
      when waived_cents >= 5000 and paid_cents = 0 then 'waived'
      when paid_cents >= 5000 then 'paid'
      when paid_cents > 0 or waived_cents > 0 then 'partial'
      when due_on < current_date then 'overdue'
      else 'open'
    end as value from state_rows
  )
  select count(*) filter (where value = 'open'), count(*) filter (where value = 'overdue'),
    count(*) filter (where value = 'partial'), count(*) filter (where value = 'paid'),
    count(*) filter (where value = 'waived')
  into open_count, overdue_count, partial_count, paid_count, waived_count
  from standing;
  if obligation_count <> 60 or assessment_count <> 60 or receipt_count <> 30
     or reminder_count <> 12 or open_count <> 3 or overdue_count <> 12
     or partial_count <> 15 or paid_count <> 15 or waived_count <> 15 then
    raise exception 'Dues SAMPLE verification failed' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.dues_provider_connections connection
    where connection.organization_id = seeded.organization_id and connection.state <> 'unset'
  ) or exists (
    select 1 from public.dues_stripe_events event
    join public.dues_checkout_reservations reservation on reservation.id = event.reservation_id
    join private.dues_sample_seed_ledger ledger on ledger.obligation_id = reservation.obligation_id
    where ledger.lane = p_lane and ledger.run_id = p_run_id
  ) then
    raise exception 'SAMPLE Stripe must remain unset' using errcode = '55000';
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'lane', p_lane, 'runId', p_run_id,
    'obligations', obligation_count, 'staffRows', 60, 'memberRows', 60,
    'receipts', receipt_count, 'reminders', reminder_count,
    'standing', pg_catalog.jsonb_build_object('open', open_count, 'overdue', overdue_count, 'partial', partial_count, 'paid', paid_count, 'waived', waived_count),
    'stripeUnset', true
  );
end;
$function$;

create or replace function private.demo_seed_remove_dues(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded private.dues_sample_seed_runs%rowtype;
  deleted_count integer;
begin
  select * into seeded from private.dues_sample_seed_runs row
  where row.lane = p_lane and row.run_id = p_run_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('removed', true, 'idempotent', true);
  end if;
  if seeded.state = 'removed' then
    return pg_catalog.jsonb_build_object('removed', true, 'idempotent', true);
  end if;
  if exists (
    select 1 from public.dues_checkout_reservations reservation
    join private.dues_sample_seed_ledger ledger on ledger.obligation_id = reservation.obligation_id
    where ledger.lane = p_lane and ledger.run_id = p_run_id
      and reservation.state in ('creating', 'open', 'cancel_requested', 'reconciling', 'attention_required')
  ) then
    raise exception 'Dues SAMPLE removal blocked by active checkout' using errcode = '55000';
  end if;
  delete from public.dues_reminder_attempts reminder
  where reminder.id in (
    select private.member_stress_uuid(p_run_id::text || ':dues:reminder:' || series.ordinal::text)
    from pg_catalog.generate_series(1, 60) series(ordinal)
  );
  delete from public.dues_ledger_events event
  where event.id in (
    select private.member_stress_uuid(p_run_id::text || ':dues:assessment:' || series.ordinal::text)
    from pg_catalog.generate_series(1, 60) series(ordinal)
    union all
    select private.member_stress_uuid(p_run_id::text || ':dues:settlement:' || series.ordinal::text)
    from pg_catalog.generate_series(1, 60) series(ordinal)
  );
  delete from public.dues_obligations obligation
  where obligation.id in (
    select private.member_stress_uuid(p_run_id::text || ':dues:obligation:' || series.ordinal::text)
    from pg_catalog.generate_series(1, 60) series(ordinal)
  );
  delete from public.dues_assessment_batches batch
  where batch.id in (
    select private.member_stress_uuid(p_run_id::text || ':dues:batch:' || series.ordinal::text)
    from pg_catalog.generate_series(1, 60) series(ordinal)
  );
  delete from private.demo_seed_page_evidence
  where lane = p_lane and run_id = p_run_id and surface in ('duesStaffObligations', 'duesMemberHistory');
  delete from private.dues_sample_seed_ledger where lane = p_lane and run_id = p_run_id;
  get diagnostics deleted_count = row_count;
  update private.dues_sample_seed_runs
  set state = 'removed', removed_at = now(), updated_at = now()
  where lane = p_lane and run_id = p_run_id;
  return pg_catalog.jsonb_build_object('removed', true, 'rows', deleted_count, 'idempotent', false);
end;
$function$;

create or replace function public.authorize_dues_sample_seed(
  p_target_ref text,
  p_confirm_token text,
  p_lane text,
  p_run_id uuid,
  p_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.dues_sample_seed_authorize(p_target_ref, p_confirm_token, p_lane, p_run_id, p_mode);
  if p_mode = 'apply' then
    return private.demo_seed_apply_dues(p_lane, p_run_id);
  elsif p_mode = 'verify' then
    return private.demo_seed_verify_dues(p_lane, p_run_id);
  end if;
  return private.demo_seed_remove_dues(p_lane, p_run_id);
end;
$function$;

-- Aggregate parity can now name the actual evidence source instead of leaving
-- CR-084 stranded as a schema gate. The lane drivers apply this phase before
-- the aggregate parity rebuild records its catalog snapshot.
update private.demo_seed_function_catalog
set coverage = 'seeded', evidence_key = 'dues-ledger-transparency', gate_relation = null
where function_id = 'CR-084';

revoke all on function private.dues_sample_seed_organization(text, uuid),
  private.dues_sample_seed_authorize(text, text, text, uuid, text),
  private.dues_sample_remove_subjects_on_lane_removal(),
  private.demo_seed_apply_dues(text, uuid),
  private.demo_seed_verify_dues(text, uuid),
  private.demo_seed_remove_dues(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.authorize_dues_sample_seed(text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.authorize_dues_sample_seed(text, text, text, uuid, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
