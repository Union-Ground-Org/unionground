-- BUG-UG-DUES-REMINDER-REQUEUE-UNIQUE-VIOLATION-20260921
--
-- public.queue_dues_reminder (body 20260831110100 under the 20260907151000
-- case-graph wrapper) only arbitrated the request-idempotency index. A second
-- "Send reminder" for the same obligation and channel in the same month
-- carries a new key, so the insert hit the separate
-- (organization_id, obligation_id, policy_window, channel) unique constraint
-- and raised a raw 23505 that the Dues adapter showed as a generic failure.
--
-- One reminder per obligation, channel and month stays the policy. The insert
-- now uses ON CONFLICT DO NOTHING, which covers both unique targets, then:
-- 1. A same-key replay reads its own attempt and keeps the existing payload
--    check and audit event.
-- 2. A new key for an already queued window returns that month's attempt
--    with alreadyQueued: true and writes no audit event.
-- The case-graph lock prologue, authorization, validation and the return shape
-- are unchanged. Grants are preserved by CREATE OR REPLACE.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
    org, p_obligation_id, date_trunc('month', current_date)::date, p_channel, p_idempotency_key, (select auth.uid())
  ) on conflict do nothing
  returning * into attempt;
  if not found then
    select * into attempt from public.dues_reminder_attempts existing
    where existing.organization_id = org and existing.request_idempotency_key = p_idempotency_key;
    if not found then
      select * into strict attempt from public.dues_reminder_attempts existing
      where existing.organization_id = org
        and existing.obligation_id = p_obligation_id
        and existing.policy_window = date_trunc('month', current_date)::date
        and existing.channel = p_channel;
      return pg_catalog.jsonb_build_object('id', attempt.id, 'state', attempt.state, 'alreadyQueued', true);
    end if;
  end if;
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
end;
$function$;

notify pgrst, 'reload schema';

commit;
