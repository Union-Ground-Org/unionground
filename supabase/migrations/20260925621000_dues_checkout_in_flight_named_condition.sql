-- UX-UG-DUES-CHECKOUT-IN-FLIGHT-IS-AN-OPAQUE-REFUSAL-20260920: a member
-- who returns from Stripe before the settlement webhook lands still sees an
-- ordinary Pay control, and a second press mints a fresh idempotency key that
-- dues_one_active_checkout_per_obligation refuses with a raw 23505. The API
-- then answers the generic checkout_refused and the member is invited to retry
-- a request that can only fail again.
--
-- Re-emit two functions:
--   * public.create_dues_checkout_reservation raises the named condition
--     'dues checkout in flight' (SQLSTATE 55006, object_in_use) when another
--     reservation for the obligation is in a state the index refuses. The
--     same-key idempotent return, every other refusal and the insert are
--     unchanged, and the case-graph lock 20260907151000 wrapped around the
--     body is kept.
--   * public.get_my_dues_workspace adds checkoutInFlight to each obligation so
--     the member screen can replace Pay with a processing indication.
-- The state list matches the index predicate. No table, index, policy or grant
-- changes.

begin;

set local lock_timeout = '5s';

-- 20260907151000 wrapped the 20260831110200 body in the case-graph lock; that
-- wrapped body is the only one this repair may supersede.
do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.create_dues_checkout_reservation(uuid, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'fc7bd7498105602fa3d136b1b6ec12c107765cba853236b96a39ab59c0c7db1f' then
    raise exception 'unreviewed create_dues_checkout_reservation predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

-- 20260831211500 is the last body of the member workspace read.
do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.get_my_dues_workspace(uuid, integer)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'a53acfa2bc251c70e548d9d9270adadc0ae3f0edae12153cb592c97faf56bb79' then
    raise exception 'unreviewed get_my_dues_workspace predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

create or replace function public.create_dues_checkout_reservation(p_obligation_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare org uuid := private.current_member_organization(); subject uuid; obligation public.dues_obligations%rowtype; connection public.dues_provider_connections%rowtype; balance integer; existing public.dues_checkout_reservations%rowtype; reservation public.dues_checkout_reservations%rowtype;
begin
  if org is null or (select auth.uid()) is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$' then raise exception 'invalid dues checkout' using errcode = '22023'; end if;
  if not private.mfa_satisfied() then raise exception 'dues MFA required' using errcode = '42501'; end if;
  select id into subject from public.dues_member_subjects where organization_id = org and user_id = (select auth.uid());
  select * into obligation from public.dues_obligations where organization_id = org and id = p_obligation_id and member_subject_id = subject for update;
  if obligation.id is null then raise exception 'dues obligation unavailable' using errcode = '42501'; end if;
  select * into existing from public.dues_checkout_reservations where organization_id = org and requested_by = (select auth.uid()) and idempotency_key = p_idempotency_key;
  if existing.id is not null then
    if existing.obligation_id <> p_obligation_id then
      raise exception 'dues idempotency payload mismatch' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('reservationId', existing.id, 'state', existing.state, 'hostedCheckoutUrl', existing.hosted_checkout_url, 'idempotent', true);
  end if;
  -- A fresh key for an obligation that already has a live reservation is the
  -- member returning from Stripe before settlement lands. Name it instead of
  -- letting dues_one_active_checkout_per_obligation answer with a raw 23505.
  if exists (select 1 from public.dues_checkout_reservations active where active.organization_id = org and active.obligation_id = obligation.id and active.state in ('creating', 'open', 'cancel_requested', 'reconciling', 'attention_required')) then raise exception 'dues checkout in flight' using errcode = '55006'; end if;
  select * into connection from public.dues_provider_connections where organization_id = org and state = 'ready' and charges_enabled;
  if connection.organization_id is null then raise exception 'dues provider unset' using errcode = '55000'; end if;
  select obligation.issued_cents - coalesce(sum(case event.event_kind when 'payment' then event.amount_cents when 'waiver' then event.amount_cents when 'credit_adjustment' then event.amount_cents when 'debit_adjustment' then -event.amount_cents else 0 end), 0) into balance from public.dues_ledger_events event where event.organization_id = org and event.obligation_id = obligation.id;
  if balance <= 0 then raise exception 'dues obligation settled' using errcode = '22023'; end if;
  insert into public.dues_checkout_reservations (organization_id, obligation_id, requested_by, idempotency_key, reserved_cents, connected_account_id, receipt_description, success_url, cancel_url, request_hash, provider_idempotency_key, stripe_idempotency_replay_until, expires_at)
  values (org, obligation.id, (select auth.uid()), p_idempotency_key, balance, connection.stripe_account_id, 'Dues payment', 'https://app.example.invalid/m/dues?payment=success', 'https://app.example.invalid/m/dues?payment=cancel', pg_catalog.encode(extensions.digest((org::text || obligation.id::text || balance::text || connection.stripe_account_id)::bytea, 'sha256'), 'hex'), 'dues:' || extensions.gen_random_uuid()::text, now() + interval '24 hours', now() + interval '23 hours') returning * into reservation;
  return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'accountId', reservation.connected_account_id, 'amountCents', reservation.reserved_cents, 'currency', reservation.checkout_currency, 'description', reservation.receipt_description, 'successUrl', reservation.success_url, 'cancelUrl', reservation.cancel_url, 'idempotencyKey', reservation.provider_idempotency_key, 'expiresAt', reservation.expires_at);
end;
end;
$function$;

create or replace function public.get_my_dues_workspace(
  p_after_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
          from calculated where due_on < current_date
        ), 0),
        'collectedCents', coalesce((select sum(paid_cents) from calculated), 0),
        'memberCount', 1,
        'authoritative', pg_catalog.jsonb_build_object(
          'outstandingCents', coalesce((
            select sum(greatest(issued_cents - settled_cents, 0)) from calculated
          ), 0),
          'overdueCents', coalesce((
            select sum(greatest(issued_cents - settled_cents, 0))
            from calculated where due_on < current_date
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
              when due_on < current_date then 'overdue'
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

commit;
