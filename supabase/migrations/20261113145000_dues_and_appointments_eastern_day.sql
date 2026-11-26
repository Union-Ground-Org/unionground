-- BUG-UG-FUNCTIONS-AND-DATE-DEFAULTS-READ-THE-UTC-DAY-20261112 (#8568), part C of four:
-- dues and appointments, read on the Eastern day.
--
-- These readers compare a calendar day (a dues obligation's due date, a
-- ledger event's effective date, a reminder's month, a steward's blackout
-- span, a member's requested booking dates) with current_date, the session's
-- day, and the hosted projects run in UTC: from 7 PM Eastern (8 PM in
-- daylight time) dues due today counted as overdue, a payment or credit was
-- dated and numbered tomorrow, an evening reminder near a month's end fell in
-- the next month's window, and a steward could not save a blackout that ends
-- today. Each now reads private.eastern_day()
-- (20261113122500_eastern_day_helper.sql), written
-- (select private.eastern_day()) so it is read once per query, not once per
-- row. get_appointment_slots keeps its one day of slack for a device date
-- west of Eastern. Nothing else in any body changes. Functions:
--   private.dues_settle_stripe_checkout
--   public.apply_dues_credit_event
--   public.get_dues_workspace
--   public.get_my_dues_workspace
--   public.queue_dues_reminder
--   public.add_appointment_blackout
--   public.get_appointment_slots
--   public.get_steward_appointments_without_place_legacy
-- Grants are unchanged (create or replace keeps them). A predecessor guard
-- refuses to run unless every live body is the reviewed one.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

do $preflight$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.dues_settle_stripe_checkout(uuid,text,text,text,integer,text,text,uuid,uuid)'::regprocedure)
    is distinct from 'af253f227cc2ad140d939898c6520458' then
    raise exception 'unreviewed predecessor: private.dues_settle_stripe_checkout' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.apply_dues_credit_event(uuid,text,integer,text,text,text)'::regprocedure)
    is distinct from '81312d2ee23632c6b75542fd46163832' then
    raise exception 'unreviewed predecessor: public.apply_dues_credit_event' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_dues_workspace(text,text,date,uuid,integer,text)'::regprocedure)
    is distinct from '80a54446b4089b201d23a928647b5e21' then
    raise exception 'unreviewed predecessor: public.get_dues_workspace' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_my_dues_workspace(uuid,integer)'::regprocedure)
    is distinct from 'f2dba1968b7c44af1de505ce2e53ff79' then
    raise exception 'unreviewed predecessor: public.get_my_dues_workspace' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.queue_dues_reminder(uuid,text,text,text)'::regprocedure)
    is distinct from 'e1c74d48ef3c64853ecbdaf312897284' then
    raise exception 'unreviewed predecessor: public.queue_dues_reminder' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.add_appointment_blackout(date,date)'::regprocedure)
    is distinct from 'ad83fddef389479e12ca1722da50f8bf' then
    raise exception 'unreviewed predecessor: public.add_appointment_blackout' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_appointment_slots(text,integer,date,date,uuid)'::regprocedure)
    is distinct from '5990790475809603fcd6dae1e9c75f8d' then
    raise exception 'unreviewed predecessor: public.get_appointment_slots' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_steward_appointments_without_place_legacy()'::regprocedure)
    is distinct from '54d4b61268fbdee4945fdff2f5d03346' then
    raise exception 'unreviewed predecessor: public.get_steward_appointments_without_place_legacy' using errcode='55000';
  end if;
end
$preflight$;

CREATE OR REPLACE FUNCTION private.dues_settle_stripe_checkout(p_reservation_id uuid, p_stripe_session_id text, p_payment_intent text, p_payment_status text, p_amount_total integer, p_currency text, p_connected_account_id text, p_client_reference_id uuid, p_metadata_reservation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  reservation public.dues_checkout_reservations%rowtype;
  obligation public.dues_obligations%rowtype;
  existing public.dues_ledger_events%rowtype;
  receipt text;
  balance integer;
  reference text := 'stripe-session:' || p_stripe_session_id;
begin
  if p_stripe_session_id !~ '^[A-Za-z0-9_:-]{3,255}$'
     or p_connected_account_id !~ '^[A-Za-z0-9_:-]{3,255}$'
     or (p_payment_intent is not null and p_payment_intent !~ '^[A-Za-z0-9_:-]{3,255}$')
     or p_payment_status <> 'paid'
     or p_amount_total is null or p_amount_total <= 0
     or p_currency <> 'usd'
     or p_client_reference_id is distinct from p_reservation_id
     or p_metadata_reservation_id is distinct from p_reservation_id then
    raise exception 'invalid Stripe settlement' using errcode = '22023';
  end if;
  select * into reservation
  from public.dues_checkout_reservations row
  where row.id = p_reservation_id
  for update;
  if not found
     or reservation.stripe_session_id is distinct from p_stripe_session_id
     or reservation.connected_account_id is distinct from p_connected_account_id
     or reservation.reserved_cents is distinct from p_amount_total
     or reservation.checkout_currency is distinct from p_currency then
    raise exception 'dues checkout settlement unavailable' using errcode = '42501';
  end if;
  select * into existing
  from public.dues_ledger_events event
  where event.organization_id = reservation.organization_id
    and event.external_reference = reference
  for update;
  if found then
    if existing.obligation_id <> reservation.obligation_id
       or existing.event_kind <> 'payment'
       or existing.payment_method <> 'stripe'
       or existing.amount_cents <> reservation.reserved_cents then
      raise exception 'dues Stripe settlement conflict' using errcode = '22023';
    end if;
    update public.dues_checkout_reservations
    set state = 'settled', reconcile_lease_owner = null,
        reconcile_lease_expires_at = null, reconcile_lease_kind = null,
        definitive_failure_class = null, updated_at = now()
    where id = reservation.id;
    return pg_catalog.jsonb_build_object(
      'reservationId', reservation.id,
      'receiptNumber', existing.receipt_number,
      'idempotent', true
    );
  end if;
  select * into obligation
  from public.dues_obligations row
  where row.organization_id = reservation.organization_id
    and row.id = reservation.obligation_id
  for update;
  if not found then
    raise exception 'dues obligation unavailable' using errcode = '42501';
  end if;
  balance := private.dues_balance_cents(
    reservation.organization_id, reservation.obligation_id
  );
  if balance <> reservation.reserved_cents then
    raise exception 'dues checkout balance changed' using errcode = '55000';
  end if;
  receipt := private.dues_receipt_number(reservation.organization_id, (select private.eastern_day()));
  insert into public.dues_ledger_events (
    organization_id, obligation_id, event_kind, amount_cents, effective_on,
    reason, payment_method, external_reference, receipt_number,
    idempotency_key, created_by
  ) values (
    reservation.organization_id, reservation.obligation_id, 'payment',
    reservation.reserved_cents, (select private.eastern_day()), 'Stripe Checkout settlement',
    'stripe', reference, receipt,
    'dues-stripe-session:' || p_stripe_session_id, null
  ) returning * into existing;
  update public.dues_checkout_reservations
  set state = 'settled', reconcile_lease_owner = null,
      reconcile_lease_expires_at = null, reconcile_lease_kind = null,
      definitive_failure_class = null, updated_at = now()
  where id = reservation.id;
  return pg_catalog.jsonb_build_object(
    'reservationId', reservation.id,
    'receiptNumber', receipt,
    'idempotent', false
  );
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.apply_dues_credit_event(p_obligation_id uuid, p_event_kind text, p_amount_cents integer, p_reason text, p_idempotency_key text, p_selected_hat text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
       or existing.effective_on <> (select private.eastern_day())
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
    org, obligation.id, p_event_kind, p_amount_cents, (select private.eastern_day()),
    pg_catalog.btrim(p_reason), p_idempotency_key, (select auth.uid())
  ) returning * into existing;
  perform private.mi1_write_tenant_audit(org, 'dues_credit_event_applied', pg_catalog.jsonb_build_object(
    'obligationId', obligation.id, 'eventKind', p_event_kind, 'amountCents', p_amount_cents
  ));
  return pg_catalog.jsonb_build_object('id', existing.id, 'idempotent', false);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_dues_workspace(p_query text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_due_on date DEFAULT NULL::date, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 25, p_selected_hat text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.dues_require_financial_hat(p_selected_hat);
  query_value text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
  limit_value integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if query_value is not null and pg_catalog.char_length(query_value) > 120 then
    raise exception 'dues search too long' using errcode = '22023';
  end if;
  if p_status is not null
     and p_status not in ('open', 'partial', 'overdue', 'paid', 'waived') then
    raise exception 'invalid dues status' using errcode = '22023';
  end if;
  return (
    with calculated as (
      select obligation.*, batch.title as assessment_title, subject.user_id,
        coalesce(profile.full_name, 'Member') as member_label,
        coalesce((
          select sum(case event.event_kind
            when 'payment' then event.amount_cents
            when 'waiver' then event.amount_cents
            when 'credit_adjustment' then event.amount_cents
            when 'debit_adjustment' then -event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as settled_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'payment')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as paid_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'waiver')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as waived_cents,
        coalesce((
          select sum(case event.event_kind
            when 'credit_adjustment' then -event.amount_cents
            when 'debit_adjustment' then event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as adjustment_cents
      from public.dues_obligations obligation
      join public.dues_assessment_batches batch
        on batch.organization_id = obligation.organization_id
       and batch.id = obligation.batch_id
      join public.dues_member_subjects subject
        on subject.organization_id = obligation.organization_id
       and subject.id = obligation.member_subject_id
      left join public.member_profiles profile on profile.id = subject.user_id
      where obligation.organization_id = org
    ), classified as (
      select *, case
        when issued_cents - settled_cents <= 0
          and waived_cents > 0 and paid_cents = 0 then 'waived'
        when issued_cents - settled_cents <= 0 then 'paid'
        when paid_cents > 0 or waived_cents > 0
          or adjustment_cents < 0 then 'partial'
        when due_on < (select private.eastern_day()) then 'overdue'
        else 'open'
      end as standing
      from calculated
    ), filtered as (
      select * from classified
      where (p_due_on is null or due_on = p_due_on)
        and (p_status is null or standing = p_status)
        and (query_value is null
          or member_label ilike '%' || query_value || '%' escape '\'
          or assessment_title ilike '%' || query_value || '%' escape '\')
    ), page as (
      select * from filtered
      where p_after_id is null or id > p_after_id
      order by id
      limit limit_value + 1
    ), visible as (
      select * from page order by id limit limit_value
    )
    select pg_catalog.jsonb_build_object(
      'state', 'ready',
      'staff', true,
      'summary', pg_catalog.jsonb_build_object(
        'outstandingCents', coalesce((
          select sum(greatest(issued_cents - settled_cents, 0)) from classified
        ), 0),
        'overdueCents', coalesce((
          select sum(greatest(issued_cents - settled_cents, 0))
          from classified where due_on < (select private.eastern_day())
        ), 0),
        'collectedCents', coalesce((select sum(paid_cents) from classified), 0),
        'memberCount', (select count(distinct member_subject_id) from classified)
      ),
      'obligations', pg_catalog.jsonb_build_object(
        'items', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', id,
            'memberSubjectId', member_subject_id,
            'memberLabel', member_label,
            'assessmentTitle', assessment_title,
            'issuedCents', issued_cents,
            'settledCents', settled_cents,
            'balanceCents', greatest(issued_cents - settled_cents, 0),
            'dueOn', due_on,
            'standing', standing,
            'chapterId', chapter_id
          ) order by id) from visible
        ), '[]'::jsonb),
        'nextCursor', case
          when (select count(*) from page) > limit_value
          then (select id from visible order by id desc limit 1)
          else null
        end
      ),
      'chapters', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', chapter.id, 'name', chapter.name
        ) order by chapter.name)
        from public.chapters chapter
        where chapter.organization_id = org
      ), '[]'::jsonb),
      'provider', private.dues_provider_projection(org)
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_dues_workspace(p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.current_member_organization();
  member_subject uuid;
  limit_value integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if org is null or (select auth.uid()) is null then
    raise exception 'dues authorization required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'dues MFA required' using errcode = '42501';
  end if;
  select subject.id into member_subject
  from public.dues_member_subjects subject
  where subject.organization_id = org
    and subject.user_id = (select auth.uid());
  if member_subject is null then
    raise exception 'dues subject provisioning incomplete' using errcode = '55000';
  end if;
  return (
    with calculated as (
      select obligation.*, batch.title as assessment_title,
        coalesce((
          select sum(case event.event_kind
            when 'payment' then event.amount_cents
            when 'waiver' then event.amount_cents
            when 'credit_adjustment' then event.amount_cents
            when 'debit_adjustment' then -event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as settled_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'payment')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as paid_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'waiver')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as waived_cents,
        coalesce((
          select sum(case event.event_kind
            when 'credit_adjustment' then -event.amount_cents
            when 'debit_adjustment' then event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as adjustment_cents
      from public.dues_obligations obligation
      join public.dues_assessment_batches batch
        on batch.organization_id = obligation.organization_id
       and batch.id = obligation.batch_id
      where obligation.organization_id = org
        and obligation.member_subject_id = member_subject
    ), page as (
      select * from calculated
      where p_after_id is null or id > p_after_id
      order by id
      limit limit_value + 1
    ), visible as (
      select * from page order by id limit limit_value
    )
    select pg_catalog.jsonb_build_object(
      'state', 'ready',
      'staff', false,
      'summary', pg_catalog.jsonb_build_object(
        'outstandingCents', coalesce((
          select sum(greatest(issued_cents - settled_cents, 0)) from calculated
        ), 0),
        'overdueCents', coalesce((
          select sum(greatest(issued_cents - settled_cents, 0))
          from calculated where due_on < (select private.eastern_day())
        ), 0),
        'collectedCents', coalesce((select sum(paid_cents) from calculated), 0),
        'memberCount', 1,
        'authoritative', pg_catalog.jsonb_build_object(
          'outstandingCents', coalesce((
            select sum(greatest(issued_cents - settled_cents, 0)) from calculated
          ), 0),
          'overdueCents', coalesce((
            select sum(greatest(issued_cents - settled_cents, 0))
            from calculated where due_on < (select private.eastern_day())
          ), 0),
          'nextDueOn', (
            select min(due_on) from calculated
            where issued_cents - settled_cents > 0
          )
        )
      ),
      'obligations', pg_catalog.jsonb_build_object(
        'items', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', id,
            'assessmentTitle', assessment_title,
            'issuedCents', issued_cents,
            'settledCents', settled_cents,
            'balanceCents', greatest(issued_cents - settled_cents, 0),
            'dueOn', due_on,
            'checkoutInFlight', exists (
              select 1 from public.dues_checkout_reservations reservation
              where reservation.organization_id = org
                and reservation.obligation_id = visible.id
                and reservation.state in ('creating', 'open', 'cancel_requested', 'reconciling', 'attention_required')
            ),
            'standing', case
              when issued_cents - settled_cents <= 0
                and waived_cents > 0 and paid_cents = 0 then 'waived'
              when issued_cents - settled_cents <= 0 then 'paid'
              when paid_cents > 0 or waived_cents > 0
                or adjustment_cents < 0 then 'partial'
              when due_on < (select private.eastern_day()) then 'overdue'
              else 'open'
            end,
            'events', coalesce((
              select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'id', event.id,
                'kind', event.event_kind,
                'amountCents', event.amount_cents,
                'effectiveOn', event.effective_on,
                'receiptNumber', event.receipt_number,
                'paymentMethod', event.payment_method
              ) order by event.effective_on desc, event.id desc)
              from public.dues_ledger_events event
              where event.organization_id = org
                and event.obligation_id = visible.id
            ), '[]'::jsonb)
          ) order by id) from visible
        ), '[]'::jsonb),
        'nextCursor', case
          when (select count(*) from page) > limit_value
          then (select id from visible order by id desc limit 1)
          else null
        end
      ),
      'chapters', '[]'::jsonb,
      'provider', private.dues_provider_projection(org)
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.queue_dues_reminder(p_obligation_id uuid, p_channel text, p_idempotency_key text, p_selected_hat text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
    org, p_obligation_id, date_trunc('month', (select private.eastern_day()))::date, p_channel, p_idempotency_key, (select auth.uid())
  ) on conflict do nothing
  returning * into attempt;
  if not found then
    select * into attempt from public.dues_reminder_attempts existing
    where existing.organization_id = org and existing.request_idempotency_key = p_idempotency_key;
    if not found then
      select * into strict attempt from public.dues_reminder_attempts existing
      where existing.organization_id = org
        and existing.obligation_id = p_obligation_id
        and existing.policy_window = date_trunc('month', (select private.eastern_day()))::date
        and existing.channel = p_channel;
      return pg_catalog.jsonb_build_object('id', attempt.id, 'state', attempt.state, 'alreadyQueued', true);
    end if;
  end if;
  if attempt.obligation_id <> p_obligation_id
     or attempt.channel <> p_channel
     or attempt.policy_window <> date_trunc('month', (select private.eastern_day()))::date then
    raise exception 'dues idempotency payload mismatch' using errcode = '22023';
  end if;
  perform private.mi1_write_tenant_audit(org, 'dues_reminder_queued', pg_catalog.jsonb_build_object(
    'obligationId', p_obligation_id, 'channel', p_channel, 'attemptId', attempt.id
  ));
  return pg_catalog.jsonb_build_object('id', attempt.id, 'state', attempt.state);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.add_appointment_blackout(p_start_date date, p_end_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  saved public.member_appointment_blackouts%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date
     or p_end_date < (select private.eastern_day()) or p_end_date - p_start_date > 370 then
    raise exception 'blackout dates are out of range' using errcode = '22023';
  end if;
  if (select pg_catalog.count(*) from public.member_appointment_blackouts b
      where b.steward_id = caller and b.end_date >= (select private.eastern_day())) >= 60 then
    raise exception 'too many blackout spans' using errcode = '22023';
  end if;

  insert into public.member_appointment_blackouts (steward_id, start_date, end_date)
  values (caller, p_start_date, p_end_date)
  returning * into saved;

  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'startDate', saved.start_date, 'endDate', saved.end_date);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_appointment_slots(p_type text, p_duration integer, p_from date, p_to date, p_steward uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.assert_appointment_shape(p_type, p_duration);
  -- One day of slack under "today": the client sends the
  -- member's DEVICE-local date, and late each evening west of Eastern that
  -- date is still a day behind the Eastern date (#8568). The min-notice filter inside the
  -- slot engine still refuses any instant in the past, so the slack cannot
  -- surface a bookable past slot.
  if p_from is null or p_to is null or p_from < (select private.eastern_day()) - 1
     or p_to < p_from or p_to > p_from + 31 then
    raise exception 'date span must start today or later and cover at most 31 days'
      using errcode = '22023';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '22023';
  end if;

  if p_steward is not null and not exists (
    select 1 from private.appointment_stewards_for_chapter(caller_chapter) e
    where e.steward_id = p_steward
  ) then
    raise exception 'steward unavailable' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object('slots', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'startsAt', s.slot_start,
      'stewardCount', s.steward_count) order by s.slot_start)
    from (
      select f.slot_start, pg_catalog.count(distinct e.steward_id) as steward_count
      from private.appointment_stewards_for_chapter(caller_chapter) e
      cross join lateral private.appointment_slots_for(e.steward_id, p_duration, p_from, p_to) f
      where (p_steward is null or e.steward_id = p_steward)
        -- A member's own live bookings block the grid too: the member-side
        -- exclusion constraint would refuse the insert anyway, so the UI must
        -- not offer an instant the server is certain to bounce.
        and not exists (
          select 1 from public.member_appointments own
          where own.user_id = caller and own.status = 'confirmed'
            and tstzrange(own.starts_at, own.ends_at)
                && tstzrange(f.slot_start, f.slot_end))
      group by f.slot_start
      order by f.slot_start
      limit 750
    ) s
  ), '[]'::jsonb));
end
$function$;

CREATE OR REPLACE FUNCTION public.get_steward_appointments_without_place_legacy()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'schedule', (
      select pg_catalog.jsonb_build_object(
        'timezone', s.timezone,
        'minNoticeMinutes', s.min_notice_minutes,
        'bufferBeforeMinutes', s.buffer_before_minutes,
        'bufferAfterMinutes', s.buffer_after_minutes,
        'maxPerDay', s.max_per_day,
        'accepting', s.accepting)
      from public.member_appointment_schedules s where s.steward_id = caller),
    'windows', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', w.id, 'weekday', w.weekday,
        'startMinute', w.start_minute, 'endMinute', w.end_minute)
        order by w.weekday, w.start_minute)
      from public.member_appointment_windows w where w.steward_id = caller), '[]'::jsonb),
    'blackouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', b.id, 'startDate', b.start_date, 'endDate', b.end_date)
        order by b.start_date)
      from public.member_appointment_blackouts b
      where b.steward_id = caller and b.end_date >= (select private.eastern_day())), '[]'::jsonb),
    'connections', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'provider', c.provider, 'status', c.status) order by c.provider)
      from public.member_calendar_connections c where c.steward_id = caller), '[]'::jsonb),
    'upcoming', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id,
        'memberName', coalesce(p.full_name, 'Member'),
        'type', a.appointment_type,
        'durationMinutes', a.duration_minutes,
        'startsAt', a.starts_at,
        'endsAt', a.ends_at,
        'status', a.status,
        'reasonCategory', a.reason_category,
        'routedVia', a.routed_via) order by a.starts_at, a.id)
      from (
        -- ALL still-confirmed rows, including ended-but-unmarked ones:
        -- the desk's completed/no-show buttons unlock on rows
        -- whose end has passed, so an ended row filtered out here would make
        -- outcome marking unreachable in live data. The 30-day floor bounds
        -- the unmarked backlog. One pager page (50): list_steward_appointments
        -- walks the rest, and upcomingTotal below discloses the cut.
        select * from public.member_appointments a0
        where a0.steward_id = caller
      and private.chapter_staff_member_allowed(a0.chapter_id, a0.user_id, array['steward']) and a0.status = 'confirmed'
          and a0.starts_at > now() - interval '30 days'
        order by a0.starts_at, a0.id limit 50
      ) a
      left join public.member_profiles p on p.id = a.user_id), '[]'::jsonb),
    'upcomingTotal', (
      select pg_catalog.count(*) from public.member_appointments a
      where a.steward_id = caller
      and private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward']) and a.status = 'confirmed'
        and a.starts_at > now() - interval '30 days'),
    'recent', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id,
        'memberName', coalesce(p.full_name, 'Member'),
        'type', a.appointment_type,
        'durationMinutes', a.duration_minutes,
        'startsAt', a.starts_at,
        'status', a.status) order by a.starts_at desc, a.id desc)
      from (
        -- Settled rows only; ended-but-unmarked confirmed rows stay in
        -- 'upcoming' where the outcome buttons live. One pager page (20).
        select * from public.member_appointments a0
        where a0.steward_id = caller
      and private.chapter_staff_member_allowed(a0.chapter_id, a0.user_id, array['steward'])
          and a0.status in ('completed', 'no_show', 'cancelled')
          and a0.starts_at > now() - interval '30 days'
        order by a0.starts_at desc, a0.id desc limit 20
      ) a
      left join public.member_profiles p on p.id = a.user_id), '[]'::jsonb),
    'recentTotal', (
      select pg_catalog.count(*) from public.member_appointments a
      where a.steward_id = caller
      and private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward'])
        and a.status in ('completed', 'no_show', 'cancelled')
        and a.starts_at > now() - interval '30 days'),
    'stats', pg_catalog.jsonb_build_object(
      'noShows30d', (
        select pg_catalog.count(*) from public.member_appointments a
        where a.steward_id = caller
      and private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward']) and a.status = 'no_show'
          and a.starts_at > now() - interval '30 days'),
      'completed30d', (
        select pg_catalog.count(*) from public.member_appointments a
        where a.steward_id = caller
      and private.chapter_staff_member_allowed(a.chapter_id, a.user_id, array['steward']) and a.status = 'completed'
          and a.starts_at > now() - interval '30 days')));
end
$function$;

-- The account-lifecycle trigger review follows every changed function that a
-- lifecycle trigger reaches, and the Eastern-day helper they now call.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select surface.kind,surface.schema_name,surface.table_name,surface.object_name,surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
join (values
    ('private','dues_settle_stripe_checkout'),
    ('public','apply_dues_credit_event'),
    ('public','get_dues_workspace'),
    ('public','get_my_dues_workspace'),
    ('public','queue_dues_reminder'),
    ('public','add_appointment_blackout'),
    ('public','get_appointment_slots'),
    ('public','get_steward_appointments_without_place_legacy'),
    ('private','eastern_day')
) changed(schema_name,function_name)
  on changed.schema_name=surface.schema_name
 and changed.function_name=pg_catalog.split_part(surface.object_name,'(',1)
where surface.kind='function'
on conflict(kind,schema_name,table_name,object_name)
do update set definition_hash=excluded.definition_hash;

commit;
