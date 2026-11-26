-- CR-084: atomic issuance, manual settlement, and bounded reminder leasing.
-- Financial corrections are append-only. There is intentionally no UPDATE or
-- DELETE against public.dues_ledger_events in this migration.

begin;

set local lock_timeout = '5s';

alter table public.dues_reminder_attempts
  add column if not exists lease_owner uuid,
  add column if not exists request_idempotency_key text,
  add constraint dues_reminder_attempts_request_key_length
    check (request_idempotency_key is null or pg_catalog.char_length(request_idempotency_key) between 16 and 128);
create unique index if not exists dues_reminder_attempts_request_key
  on public.dues_reminder_attempts (organization_id, request_idempotency_key)
  where request_idempotency_key is not null;

create table public.dues_notification_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  reminder_attempt_id uuid not null references public.dues_reminder_attempts(id) on delete cascade,
  channel text not null check (channel in ('in_app', 'email')),
  delivery_key text not null check (delivery_key ~ '^dues-reminder:[0-9a-f-]+:(in-app|email)$'),
  notification_id uuid references public.member_notifications(id) on delete set null,
  state text not null default 'queued' check (state in ('queued', 'sent', 'deferred', 'failed', 'blocked')),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, reminder_attempt_id, channel),
  unique (delivery_key)
);

alter table public.dues_notification_deliveries enable row level security;
revoke all on table public.dues_notification_deliveries from public, anon, authenticated, service_role;

-- The existing notification topic check is deliberately widened in its own
-- migration transaction so a Dues in-app reminder remains an honest category.
alter table public.member_notifications
  drop constraint if exists member_notifications_kind_check;
alter table public.member_notifications
  add constraint member_notifications_kind_check
  check (kind in (
    'general', 'deadlines', 'cases', 'forms', 'votes', 'events', 'tasks',
    'appointments', 'workload', 'dues'
  )) not valid;
alter table public.member_notifications validate constraint member_notifications_kind_check;

create or replace function private.dues_validate_idempotency_key(p_key text)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
begin
  if p_key is null or pg_catalog.char_length(p_key) not between 16 and 128 then
    raise exception 'invalid dues idempotency key' using errcode = '22023';
  end if;
end;
$function$;

create or replace function private.dues_balance_cents(p_organization_id uuid, p_obligation_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $function$
  select obligation.issued_cents - coalesce((
    select sum(case event.event_kind
      when 'payment' then event.amount_cents
      when 'waiver' then event.amount_cents
      when 'credit_adjustment' then event.amount_cents
      when 'debit_adjustment' then -event.amount_cents
      else 0 end)
    from public.dues_ledger_events event
    where event.organization_id = obligation.organization_id
      and event.obligation_id = obligation.id
  ), 0)
  from public.dues_obligations obligation
  where obligation.organization_id = p_organization_id and obligation.id = p_obligation_id
$function$;

create or replace function private.dues_receipt_number(p_organization_id uuid, p_effective_on date)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  effective_year integer := extract(year from p_effective_on);
  receipt_sequence integer;
begin
  insert into public.dues_receipt_counters (organization_id, receipt_year, next_sequence)
  values (p_organization_id, effective_year, 2)
  on conflict (organization_id, receipt_year) do update
    set next_sequence = public.dues_receipt_counters.next_sequence + 1
  returning next_sequence - 1 into receipt_sequence;
  return 'UG-' || effective_year::text || '-' || lpad(receipt_sequence::text, 8, '0');
end;
$function$;

create or replace function public.issue_dues_assessment_batch(
  p_title text,
  p_description text,
  p_scope_kind text,
  p_chapter_id text,
  p_amount_cents integer,
  p_due_on date,
  p_preview_fingerprint text,
  p_idempotency_key text,
  p_selected_hat text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.dues_require_financial_hat(p_selected_hat);
  normalized_title text := nullif(pg_catalog.btrim(pg_catalog.normalize(p_title)), '');
  normalized_description text := nullif(pg_catalog.btrim(pg_catalog.normalize(coalesce(p_description, ''))), '');
  existing public.dues_assessment_batches%rowtype;
  created public.dues_assessment_batches%rowtype;
  subject_ids uuid[];
  fingerprint text;
  eligible_count integer;
begin
  perform private.dues_validate_idempotency_key(p_idempotency_key);
  if normalized_title is null or pg_catalog.char_length(normalized_title) > 160
     or (normalized_description is not null and pg_catalog.char_length(normalized_description) > 4000)
     or p_scope_kind not in ('organization', 'chapter')
     or p_amount_cents is null or p_amount_cents <= 0
     or p_due_on is null
     or p_preview_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid dues assessment' using errcode = '22023';
  end if;
  if (p_scope_kind = 'organization' and p_chapter_id is not null)
     or (p_scope_kind = 'chapter' and not exists (
       select 1 from public.chapters chapter
       where chapter.organization_id = org and chapter.id = p_chapter_id
     )) then
    raise exception 'dues chapter scope invalid' using errcode = '22023';
  end if;

  select * into existing
  from public.dues_assessment_batches batch
  where batch.organization_id = org and batch.idempotency_key = p_idempotency_key
  for update;
  if found then
    if existing.title is distinct from normalized_title
       or existing.description is distinct from normalized_description
       or existing.scope_kind is distinct from p_scope_kind
       or existing.chapter_id is distinct from p_chapter_id
       or existing.amount_cents is distinct from p_amount_cents
       or existing.due_on is distinct from p_due_on
       or existing.eligibility_fingerprint is distinct from p_preview_fingerprint then
      raise exception 'dues idempotency payload mismatch' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('id', existing.id, 'issued', true, 'idempotent', true);
  end if;

  -- One MATERIALIZED membership snapshot drives both the fingerprint and the
  -- INSERT fanout. It is never rebuilt in a second visible query.
  with eligible as materialized (
    select subject.id
    from public.dues_member_subjects subject
    join public.organization_memberships membership
      on membership.organization_id = subject.organization_id
     and membership.user_id = subject.user_id
     and membership.status = 'active'
    where subject.organization_id = org
      and (
        p_scope_kind = 'organization'
        or exists (
          select 1
          from public.member_chapter_memberships chapter_membership
          join public.chapters chapter
            on chapter.id = chapter_membership.chapter_id
           and chapter.organization_id = subject.organization_id
          where chapter_membership.user_id = membership.user_id
            and chapter_membership.status = 'active'
            and chapter_membership.chapter_id = p_chapter_id
        )
      )
    order by subject.id
  )
  select coalesce(array_agg(id), array[]::uuid[]) into subject_ids from eligible;
  eligible_count := cardinality(subject_ids);
  if eligible_count = 0 then
    raise exception 'dues assessment has no eligible members' using errcode = '22023';
  end if;
  fingerprint := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'organizationId', org,
      'title', normalized_title,
      'description', normalized_description,
      'scopeKind', p_scope_kind,
      'chapterId', p_chapter_id,
      'memberSubjectIds', pg_catalog.to_jsonb(subject_ids),
      'amountCents', p_amount_cents,
      'dueOn', p_due_on,
      'currency', 'USD',
      'kind', 'assessment',
      'reminderPolicy', 'monthly-overdue-v1'
    )::text, 'UTF8'), 'sha256'), 'hex'
  );
  if fingerprint is distinct from p_preview_fingerprint then
    raise exception 'dues assessment preview changed' using errcode = '40001';
  end if;

  insert into public.dues_assessment_batches (
    organization_id, chapter_id, title, description, scope_kind, amount_cents,
    due_on, eligibility_fingerprint, idempotency_key, created_by
  ) values (
    org, p_chapter_id, normalized_title, normalized_description, p_scope_kind, p_amount_cents,
    p_due_on, fingerprint, p_idempotency_key, (select auth.uid())
  ) on conflict (organization_id, idempotency_key) do nothing
  returning * into created;
  if created.id is null then
    select * into existing
    from public.dues_assessment_batches batch
    where batch.organization_id = org and batch.idempotency_key = p_idempotency_key
    for update;
    if existing.id is null
       or existing.title is distinct from normalized_title
       or existing.description is distinct from normalized_description
       or existing.scope_kind is distinct from p_scope_kind
       or existing.chapter_id is distinct from p_chapter_id
       or existing.amount_cents is distinct from p_amount_cents
       or existing.due_on is distinct from p_due_on
       or existing.eligibility_fingerprint is distinct from p_preview_fingerprint then
      raise exception 'dues idempotency payload mismatch' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('id', existing.id, 'issued', true, 'idempotent', true);
  end if;

  insert into public.dues_obligations (
    organization_id, batch_id, member_subject_id, chapter_id, issued_cents, due_on
  )
  select org, created.id, subject_id, p_chapter_id, p_amount_cents, p_due_on
  from unnest(subject_ids) as subject_id;

  insert into public.dues_ledger_events (
    organization_id, obligation_id, event_kind, amount_cents, effective_on,
    reason, idempotency_key, created_by
  )
  select obligation.organization_id, obligation.id, 'assessment', obligation.issued_cents,
    p_due_on, normalized_title, 'dues-assessment:' || created.id::text || ':' || obligation.id::text,
    (select auth.uid())
  from public.dues_obligations obligation
  where obligation.organization_id = org and obligation.batch_id = created.id;

  perform private.mi1_write_tenant_audit(org, 'dues_assessment_issued', pg_catalog.jsonb_build_object(
    'batchId', created.id, 'scopeKind', p_scope_kind, 'eligibleCount', eligible_count, 'amountCents', p_amount_cents
  ));
  return pg_catalog.jsonb_build_object(
    'id', created.id, 'issued', true, 'idempotent', false,
    'eligibleCount', eligible_count, 'totalCents', eligible_count * p_amount_cents
  );
end;
$function$;

create or replace function public.record_dues_manual_payment(
  p_obligation_id uuid,
  p_amount_cents integer,
  p_paid_on date,
  p_payment_method text,
  p_reason text,
  p_external_reference text,
  p_idempotency_key text,
  p_selected_hat text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.dues_require_financial_hat(p_selected_hat);
  obligation public.dues_obligations%rowtype;
  existing public.dues_ledger_events%rowtype;
  balance integer;
  receipt text;
begin
  perform private.dues_validate_idempotency_key(p_idempotency_key);
  if p_amount_cents is null or p_amount_cents <= 0 or p_paid_on is null
     or p_payment_method not in ('manual_cash', 'manual_check', 'manual_other')
     or nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null
     or pg_catalog.char_length(pg_catalog.btrim(p_reason)) > 500 then
    raise exception 'invalid manual dues payment' using errcode = '22023';
  end if;
  select * into existing
  from public.dues_ledger_events event
  where event.organization_id = org and event.idempotency_key = p_idempotency_key
  for update;
  if found then
    if existing.event_kind <> 'payment' or existing.obligation_id <> p_obligation_id
       or existing.amount_cents <> p_amount_cents
       or existing.effective_on <> p_paid_on
       or existing.payment_method <> p_payment_method
       or existing.reason <> pg_catalog.btrim(p_reason)
       or existing.external_reference is distinct from
         nullif(pg_catalog.btrim(coalesce(p_external_reference, '')), '') then
      raise exception 'dues idempotency payload mismatch' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('id', existing.id, 'receiptNumber', existing.receipt_number, 'idempotent', true);
  end if;
  select * into obligation
  from public.dues_obligations row
  where row.organization_id = org and row.id = p_obligation_id
  for update;
  if not found then
    raise exception 'dues obligation not found' using errcode = '42501';
  end if;
  balance := private.dues_balance_cents(org, obligation.id);
  if p_amount_cents > balance then
    raise exception 'dues overpayment rejected' using errcode = '22023';
  end if;
  receipt := private.dues_receipt_number(org, p_paid_on);
  insert into public.dues_ledger_events (
    organization_id, obligation_id, event_kind, amount_cents, effective_on,
    reason, payment_method, external_reference, receipt_number, idempotency_key, created_by
  ) values (
    org, obligation.id, 'payment', p_amount_cents, p_paid_on,
    pg_catalog.btrim(p_reason), p_payment_method, nullif(pg_catalog.btrim(coalesce(p_external_reference, '')), ''),
    receipt, p_idempotency_key, (select auth.uid())
  ) returning * into existing;
  perform private.mi1_write_tenant_audit(org, 'dues_manual_payment_recorded', pg_catalog.jsonb_build_object(
    'obligationId', obligation.id, 'amountCents', p_amount_cents, 'receiptNumber', receipt
  ));
  return pg_catalog.jsonb_build_object('id', existing.id, 'receiptNumber', receipt, 'idempotent', false);
end;
$function$;

create or replace function public.apply_dues_credit_event(
  p_obligation_id uuid,
  p_event_kind text,
  p_amount_cents integer,
  p_reason text,
  p_idempotency_key text,
  p_selected_hat text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.dues_require_financial_hat(p_selected_hat);
  obligation public.dues_obligations%rowtype;
  existing public.dues_ledger_events%rowtype;
  balance integer;
begin
  perform private.dues_validate_idempotency_key(p_idempotency_key);
  if p_event_kind not in ('waiver', 'credit_adjustment', 'debit_adjustment')
     or p_amount_cents is null or p_amount_cents <= 0
     or nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null
     or pg_catalog.char_length(pg_catalog.btrim(p_reason)) > 500 then
    raise exception 'invalid dues credit event' using errcode = '22023';
  end if;
  select * into existing
  from public.dues_ledger_events event
  where event.organization_id = org and event.idempotency_key = p_idempotency_key
  for update;
  if found then
    if existing.event_kind <> p_event_kind or existing.obligation_id <> p_obligation_id
       or existing.amount_cents <> p_amount_cents
       or existing.effective_on <> current_date
       or existing.reason <> pg_catalog.btrim(p_reason) then
      raise exception 'dues idempotency payload mismatch' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('id', existing.id, 'idempotent', true);
  end if;
  select * into obligation
  from public.dues_obligations row
  where row.organization_id = org and row.id = p_obligation_id
  for update;
  if not found then
    raise exception 'dues obligation not found' using errcode = '42501';
  end if;
  balance := private.dues_balance_cents(org, obligation.id);
  if p_event_kind in ('waiver', 'credit_adjustment') and p_amount_cents > balance then
    raise exception 'dues credit exceeds balance' using errcode = '22023';
  end if;
  insert into public.dues_ledger_events (
    organization_id, obligation_id, event_kind, amount_cents, effective_on,
    reason, idempotency_key, created_by
  ) values (
    org, obligation.id, p_event_kind, p_amount_cents, current_date,
    pg_catalog.btrim(p_reason), p_idempotency_key, (select auth.uid())
  ) returning * into existing;
  perform private.mi1_write_tenant_audit(org, 'dues_credit_event_applied', pg_catalog.jsonb_build_object(
    'obligationId', obligation.id, 'eventKind', p_event_kind, 'amountCents', p_amount_cents
  ));
  return pg_catalog.jsonb_build_object('id', existing.id, 'idempotent', false);
end;
$function$;

create or replace function public.queue_dues_reminder(
  p_obligation_id uuid,
  p_channel text,
  p_idempotency_key text,
  p_selected_hat text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.dues_require_financial_hat(p_selected_hat);
  attempt public.dues_reminder_attempts%rowtype;
begin
  perform private.dues_validate_idempotency_key(p_idempotency_key);
  if p_channel not in ('in_app', 'email') then
    raise exception 'invalid dues reminder channel' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.dues_obligations obligation
    where obligation.organization_id = org and obligation.id = p_obligation_id
  ) then
    raise exception 'dues obligation not found' using errcode = '42501';
  end if;
  insert into public.dues_reminder_attempts (
    organization_id, obligation_id, policy_window, channel, request_idempotency_key, created_by
  ) values (
    org, p_obligation_id, date_trunc('month', current_date)::date, p_channel, p_idempotency_key, (select auth.uid())
  ) on conflict (organization_id, request_idempotency_key) where request_idempotency_key is not null
    do update set updated_at = public.dues_reminder_attempts.updated_at
  returning * into attempt;
  if attempt.obligation_id <> p_obligation_id
     or attempt.channel <> p_channel
     or attempt.policy_window <> date_trunc('month', current_date)::date then
    raise exception 'dues idempotency payload mismatch' using errcode = '22023';
  end if;
  perform private.mi1_write_tenant_audit(org, 'dues_reminder_queued', pg_catalog.jsonb_build_object(
    'obligationId', p_obligation_id, 'channel', p_channel, 'attemptId', attempt.id
  ));
  return pg_catalog.jsonb_build_object('id', attempt.id, 'state', attempt.state);
end;
$function$;

create or replace function public.plan_dues_reminder_attempts(p_limit integer, p_today date default current_date)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  inserted_count integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 500 or p_today is null then
    raise exception 'invalid dues reminder planning limit' using errcode = '22023';
  end if;
  with candidates as materialized (
    select obligation.organization_id, obligation.id
    from public.dues_obligations obligation
    where obligation.due_on < p_today
      and private.dues_balance_cents(obligation.organization_id, obligation.id) > 0
    order by obligation.due_on asc, obligation.id asc
    limit p_limit
  ), inserted as (
    insert into public.dues_reminder_attempts (organization_id, obligation_id, policy_window, channel)
    select organization_id, id, date_trunc('month', p_today)::date, 'in_app'
    from candidates
    on conflict (organization_id, obligation_id, policy_window, channel) do nothing
    returning id
  )
  select count(*) into inserted_count from inserted;
  return inserted_count;
end;
$function$;

create or replace function public.claim_dues_reminder_attempts(p_limit integer)
returns table (
  id uuid,
  organization_id uuid,
  obligation_id uuid,
  member_user_id uuid,
  channel text,
  lease_epoch integer,
  attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 25 then
    raise exception 'invalid dues reminder claim limit' using errcode = '22023';
  end if;
  return query
  with candidates as (
    select attempt.id
    from public.dues_reminder_attempts attempt
    where (attempt.state = 'requested' or (attempt.state = 'leased' and attempt.lease_expires_at < pg_catalog.now()))
      and attempt.attempt_count < 25
    order by attempt.created_at asc, attempt.id asc
    for update skip locked
    limit p_limit
  ), leased as (
    update public.dues_reminder_attempts attempt
    set state = 'leased', lease_epoch = attempt.lease_epoch + 1,
        lease_owner = extensions.gen_random_uuid(), lease_expires_at = pg_catalog.now() + interval '2 minutes',
        attempt_count = attempt.attempt_count + 1, updated_at = pg_catalog.now()
    from candidates
    where attempt.id = candidates.id
    returning attempt.*
  )
  select leased.id, leased.organization_id, leased.obligation_id, subject.user_id,
    leased.channel, leased.lease_epoch, leased.attempt_count
  from leased
  join public.dues_obligations obligation
    on obligation.organization_id = leased.organization_id and obligation.id = leased.obligation_id
  join public.dues_member_subjects subject
    on subject.organization_id = obligation.organization_id and subject.id = obligation.member_subject_id;
end;
$function$;

create or replace function public.dispatch_dues_reminder_attempt(
  p_attempt_id uuid,
  p_expected_attempt_count integer,
  p_lease_epoch integer,
  p_outcome text,
  p_outbound_delivery_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt public.dues_reminder_attempts%rowtype;
  recipient uuid;
  notification uuid;
  delivery_state text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome not in ('sent', 'deferred', 'failed', 'blocked') then
    raise exception 'invalid dues reminder outcome' using errcode = '22023';
  end if;
  select * into attempt from public.dues_reminder_attempts row where row.id = p_attempt_id for update;
  if not found then
    raise exception 'dues reminder attempt not found' using errcode = '22023';
  end if;
  if attempt.state <> 'leased' or attempt.lease_epoch <> p_lease_epoch
     or attempt.attempt_count <> p_expected_attempt_count or attempt.lease_expires_at <= pg_catalog.now() then
    raise exception 'stale dues reminder lease' using errcode = '40001';
  end if;
  select subject.user_id into recipient
  from public.dues_obligations obligation
  join public.dues_member_subjects subject
    on subject.organization_id = obligation.organization_id and subject.id = obligation.member_subject_id
  where obligation.organization_id = attempt.organization_id and obligation.id = attempt.obligation_id;
  delivery_state := p_outcome;
  if p_outcome = 'sent' and attempt.channel = 'in_app' and recipient is not null then
    insert into public.dues_notification_deliveries (
      organization_id, reminder_attempt_id, channel, delivery_key, state
    ) values (
      attempt.organization_id, attempt.id, 'in_app', 'dues-reminder:' || attempt.id::text || ':in-app', 'queued'
    ) on conflict (organization_id, reminder_attempt_id, channel) do nothing;
    select delivery.notification_id into notification
    from public.dues_notification_deliveries delivery
    where delivery.organization_id = attempt.organization_id
      and delivery.reminder_attempt_id = attempt.id and delivery.channel = 'in_app'
    for update;
    if notification is null then
      insert into public.member_notifications (user_id, title, body, kind)
      values (recipient, 'Dues reminder', 'You have an outstanding dues balance. Open Dues to review it.', 'dues')
      returning id into notification;
      update public.dues_notification_deliveries
      set notification_id = notification, state = 'sent', updated_at = pg_catalog.now()
      where organization_id = attempt.organization_id and reminder_attempt_id = attempt.id and channel = 'in_app';
    end if;
  elsif attempt.channel = 'email' then
    if p_outbound_delivery_key is null or p_outbound_delivery_key <> 'dues-reminder:' || attempt.id::text || ':email' then
      raise exception 'invalid dues outbound delivery key' using errcode = '22023';
    end if;
    insert into public.dues_notification_deliveries (
      organization_id, reminder_attempt_id, channel, delivery_key, state
    ) values (attempt.organization_id, attempt.id, 'email', p_outbound_delivery_key, delivery_state)
    on conflict (organization_id, reminder_attempt_id, channel) do update
      set state = excluded.state, updated_at = pg_catalog.now();
  end if;
  update public.dues_reminder_attempts
  set state = delivery_state, lease_owner = null, lease_expires_at = null,
      outcome_code = delivery_state, updated_at = pg_catalog.now()
  where id = attempt.id;
  return pg_catalog.jsonb_build_object('id', attempt.id, 'state', delivery_state, 'notificationId', notification);
end;
$function$;

revoke all on function private.dues_validate_idempotency_key(text),
  private.dues_balance_cents(uuid, uuid), private.dues_receipt_number(uuid, date)
  from public, anon, authenticated, service_role;
revoke all on function public.issue_dues_assessment_batch(text, text, text, text, integer, date, text, text, text),
  public.record_dues_manual_payment(uuid, integer, date, text, text, text, text, text),
  public.apply_dues_credit_event(uuid, text, integer, text, text, text),
  public.queue_dues_reminder(uuid, text, text, text)
  from public, anon;
grant execute on function public.issue_dues_assessment_batch(text, text, text, text, integer, date, text, text, text),
  public.record_dues_manual_payment(uuid, integer, date, text, text, text, text, text),
  public.apply_dues_credit_event(uuid, text, integer, text, text, text),
  public.queue_dues_reminder(uuid, text, text, text)
  to authenticated;
revoke all on function public.plan_dues_reminder_attempts(integer, date),
  public.claim_dues_reminder_attempts(integer),
  public.dispatch_dues_reminder_attempt(uuid, integer, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.plan_dues_reminder_attempts(integer, date),
  public.claim_dues_reminder_attempts(integer),
  public.dispatch_dues_reminder_attempt(uuid, integer, integer, text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
