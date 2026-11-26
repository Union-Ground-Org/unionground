-- Post-apply BEHAVIOURAL probes for the notification delivery plane.
--
-- This file used to do two different jobs. The first -- asserting exact object
-- identity and exact EFFECTIVE privileges out of the catalog -- is now
-- scripts/db-contract.json plus scripts/verify-db-contract.mjs, which does it
-- for the whole schema, on every CI run, against a checked-in expectation:
--
--   npm run verify:db
--
-- What is left here is the job a catalog read cannot do. Whether the enqueue
-- trigger actually fans a notification out, whether it actually respects a
-- member's channel preferences, whether the kill switch actually stops the
-- dispatcher, and whether the claim RPC actually skips locked rows are all
-- questions about behaviour. The only honest way to answer them is to insert
-- real rows, call the real RPCs, and watch -- which is what follows.
--
-- REQUIRED: run this whole file as ONE session inside ONE transaction that
-- ends in ROLLBACK. The behavioural probes insert real
-- member_notifications / member_notification_deliveries rows, flip
-- private.notification_controls.outbound_enabled, and mutate a real member's
-- notification_prefs to drive the trigger and the claim/record RPCs so their
-- actual behaviour can be observed -- not just their definitions. ROLLBACK is
-- not an optional cleanup step here, it is the reason those probes are safe
-- to run against the live database at all. Do not split this file across
-- multiple psql invocations, run it with autocommit-per-statement tooling, or
-- paste fragments of it into a console one at a time -- anything that closes
-- the transaction before the final ROLLBACK persists synthetic data.
--
--   psql "$DATABASE_URL" -f scripts/verify-notification-schema.sql
--   (or paste the ENTIRE file, begin-to-rollback, into the Supabase SQL editor
--   in one execution -- the editor runs a pasted script as a single implicit
--   transaction, which is what this depends on)
--
-- Every row must report PASS. FAIL details are written to be diagnosable
-- without re-deriving the check: they show what was actually observed, not
-- just "expected X".

begin;

-- ============================================================================
-- Scratch tables for this run. Both are dropped automatically at commit, and
-- since this transaction never commits (see header), neither one ever
-- persists a byte.
-- ============================================================================

create temporary table _verify_results (
  check_name text not null,
  passed     boolean not null,
  detail     text
) on commit drop;

-- Carries state between the probe DO blocks. Each DO block is its own
-- PL/pgSQL scope with no shared variables, so anything one probe needs a
-- later probe to see (which member we picked, which notification we inserted)
-- has to round-trip through here instead.
create temporary table _verify_ctx (
  user_id              uuid,
  cases_notification_id uuid
) on commit drop;

-- ============================================================================
-- The catalog and effective-privilege checks that used to stand here (object
-- identity, prosecdef + search_path pins, has_table_privilege /
-- has_column_privilege / has_function_privilege sweeps, policy shapes,
-- constraint validity, index and trigger presence, publication and cron rows)
-- moved to scripts/db-contract.json and scripts/verify-db-contract.mjs. That
-- covers the whole schema rather than the notification plane alone, runs in CI
-- on every push, and diffs against a checked-in expectation instead of
-- restating it inline -- so a check that gets deleted shows up in a diff.
--
--   npm run verify:db
--
-- What could NOT move is below. No catalog read can tell you whether the
-- enqueue trigger actually fans a notification out to the right channels,
-- whether the kill switch actually stops it, or whether the claim RPC actually
-- skips locked rows. Those are answers you only get by doing it and watching.
-- ============================================================================

-- ============================================================================
-- PART 1 -- behavioural probes. These INSERT and UPDATE real rows (a real
-- member_profiles.id, real member_notifications rows, real
-- member_notification_deliveries rows) and call the real dispatcher RPCs, to
-- observe what the trigger and the RPCs actually do rather than what their
-- definitions say they should do. This is only safe because the entire file
-- runs inside the one transaction opened by `begin;` above and ends in
-- `rollback;` below -- see the header comment. Every probe is wrapped in its
-- own exception handler so a probe that cannot complete (an unexpected error,
-- not just an assertion failure) reports FAIL with the error instead of
-- aborting every probe after it.
-- ============================================================================

do $$
declare
  v_user uuid;
begin
  select id into v_user from public.member_profiles order by id limit 1;
  insert into _verify_ctx (user_id) values (v_user);
exception when others then
  insert into _verify_ctx (user_id) values (null);
  insert into _verify_results (check_name, passed, detail)
  values ('probe setup: pick a real member to test against', false,
          'could not select from public.member_profiles: ' || sqlerrm);
end $$;

-- Probe A: outbound disabled -> a topical kind still enqueues zero deliveries.
do $$
declare
  v_user uuid;
  v_notif_id uuid;
  v_count integer;
begin
  select user_id into v_user from _verify_ctx;
  if v_user is null then
    insert into _verify_results values (
      'probe: outbound_enabled=false blocks enqueue (kind=cases)', false,
      'skipped: no public.member_profiles row was available to test against');
    return;
  end if;

  begin
    update private.notification_controls set outbound_enabled = false where id;

    insert into public.member_notifications (user_id, title, body, kind)
    values (v_user, 'verify-probe A (outbound off)', 'synthetic row, this whole script rolls back', 'cases')
    returning id into v_notif_id;

    select count(*) into v_count from public.member_notification_deliveries where notification_id = v_notif_id;

    insert into _verify_results values (
      'probe: outbound_enabled=false blocks enqueue (kind=cases)',
      v_count = 0,
      v_count::text || ' delivery row(s) enqueued while outbound_enabled=false (expected 0)');
  exception when others then
    insert into _verify_results values (
      'probe: outbound_enabled=false blocks enqueue (kind=cases)', false,
      'probe crashed: ' || sqlerrm || ' (sqlstate=' || sqlstate || ')');
  end;
end $$;

-- Probe B: outbound enabled, but kind='general' must never enqueue -- it is
-- in-app-only by design (see 20260723201000's header), so there is no toggle
-- that can turn it into outbound mail.
do $$
declare
  v_user uuid;
  v_notif_id uuid;
  v_count integer;
begin
  select user_id into v_user from _verify_ctx;
  if v_user is null then
    insert into _verify_results values (
      'probe: kind=general never enqueues even with outbound_enabled=true', false,
      'skipped: no public.member_profiles row was available to test against');
    return;
  end if;

  begin
    update private.notification_controls set outbound_enabled = true where id;

    insert into public.member_notifications (user_id, title, body, kind)
    values (v_user, 'verify-probe B (general)', 'synthetic row, this whole script rolls back', 'general')
    returning id into v_notif_id;

    select count(*) into v_count from public.member_notification_deliveries where notification_id = v_notif_id;

    insert into _verify_results values (
      'probe: kind=general never enqueues even with outbound_enabled=true',
      v_count = 0,
      v_count::text || ' delivery row(s) enqueued for kind=general (expected 0)');
  exception when others then
    insert into _verify_results values (
      'probe: kind=general never enqueues even with outbound_enabled=true', false,
      'probe crashed: ' || sqlerrm || ' (sqlstate=' || sqlstate || ')');
  end;
end $$;

-- Probe C: a topical kind, outbound on, pref allowed -> exactly one 'email'
-- delivery, and a 'push' delivery iff the member actually has a subscription.
-- Stashes the notification id in _verify_ctx: probes G and H target this
-- exact row rather than whatever else the queue happens to contain.
do $$
declare
  v_user uuid;
  v_notif_id uuid;
  v_has_push boolean;
  v_email_count integer;
  v_push_count integer;
  v_pass boolean;
begin
  select user_id into v_user from _verify_ctx;
  if v_user is null then
    insert into _verify_results values (
      'probe: kind=cases enqueues exactly one email delivery (+push iff subscribed)', false,
      'skipped: no public.member_profiles row was available to test against');
    return;
  end if;

  begin
    update private.notification_controls set outbound_enabled = true where id;
    update public.member_profiles set notification_prefs = notification_prefs || jsonb_build_object('cases', true) where id = v_user;

    select exists (select 1 from public.member_push_subscriptions where user_id = v_user) into v_has_push;

    insert into public.member_notifications (user_id, title, body, kind)
    values (v_user, 'verify-probe C (cases, should enqueue)', 'synthetic row, this whole script rolls back', 'cases')
    returning id into v_notif_id;

    update _verify_ctx set cases_notification_id = v_notif_id;

    select count(*) into v_email_count from public.member_notification_deliveries where notification_id = v_notif_id and channel = 'email';
    select count(*) into v_push_count  from public.member_notification_deliveries where notification_id = v_notif_id and channel = 'push';

    v_pass := (v_email_count = 1) and (v_push_count = case when v_has_push then 1 else 0 end);

    insert into _verify_results values (
      'probe: kind=cases enqueues exactly one email delivery (+push iff subscribed)',
      v_pass,
      format('email_rows=%s push_rows=%s member_has_push_subscription=%s (expected email=1, push=%s)',
             v_email_count, v_push_count, v_has_push, case when v_has_push then 1 else 0 end));
  exception when others then
    insert into _verify_results values (
      'probe: kind=cases enqueues exactly one email delivery (+push iff subscribed)', false,
      'probe crashed: ' || sqlerrm || ' (sqlstate=' || sqlstate || ')');
  end;
end $$;

-- Probe D: notification_prefs.cases = false (a real JSON boolean) suppresses
-- the topic entirely.
do $$
declare
  v_user uuid;
  v_notif_id uuid;
  v_count integer;
begin
  select user_id into v_user from _verify_ctx;
  if v_user is null then
    insert into _verify_results values (
      'probe: notification_prefs.cases=false suppresses delivery', false,
      'skipped: no public.member_profiles row was available to test against');
    return;
  end if;

  begin
    update private.notification_controls set outbound_enabled = true where id;
    update public.member_profiles set notification_prefs = notification_prefs || jsonb_build_object('cases', false) where id = v_user;

    insert into public.member_notifications (user_id, title, body, kind)
    values (v_user, 'verify-probe D (cases, pref off)', 'synthetic row, this whole script rolls back', 'cases')
    returning id into v_notif_id;

    select count(*) into v_count from public.member_notification_deliveries where notification_id = v_notif_id;

    insert into _verify_results values (
      'probe: notification_prefs.cases=false suppresses delivery',
      v_count = 0,
      v_count::text || ' delivery row(s) enqueued despite cases=false (expected 0)');
  exception when others then
    insert into _verify_results values (
      'probe: notification_prefs.cases=false suppresses delivery', false,
      'probe crashed: ' || sqlerrm || ' (sqlstate=' || sqlstate || ')');
  end;
end $$;

-- Probe E: notification_prefs.cases = "false" (a JSON STRING, not a boolean)
-- must be REJECTED by member_profiles_notification_prefs_boolean. The
-- trigger's own pref read (`pref_value = 'false'::jsonb`) only ever matches
-- the boolean, by design (see 20260723201000 part 5) -- the CHECK is what
-- keeps a member from storing a value that reads as "off" to a human but is
-- silently treated as "on" by the trigger. The expected outcome here is an
-- EXCEPTION, so success is caught, not returned.
do $$
declare
  v_user uuid;
  v_rejected boolean := false;
  v_detail text;
begin
  select user_id into v_user from _verify_ctx;
  if v_user is null then
    insert into _verify_results values (
      'probe: notification_prefs.cases="false" (JSON string) is rejected by the boolean CHECK', false,
      'skipped: no public.member_profiles row was available to test against');
    return;
  end if;

  begin
    begin
      update public.member_profiles
        set notification_prefs = notification_prefs || jsonb_build_object('cases', 'false'::text)
        where id = v_user;
      v_detail := 'write SUCCEEDED -- the boolean CHECK did not reject a JSON string value';
    exception
      when check_violation then
        v_rejected := true;
        v_detail := 'write correctly rejected with check_violation: ' || sqlerrm;
    end;

    insert into _verify_results values (
      'probe: notification_prefs.cases="false" (JSON string) is rejected by the boolean CHECK',
      v_rejected, v_detail);
  exception when others then
    insert into _verify_results values (
      'probe: notification_prefs.cases="false" (JSON string) is rejected by the boolean CHECK', false,
      'probe crashed outside the expected check_violation path: ' || sqlerrm || ' (sqlstate=' || sqlstate || ')');
  end;
end $$;

-- Probe F: recipient hourly cap. The trigger counts DELIVERY rows in the
-- trailing hour, not notifications, and a topical notification can produce 1
-- or 2 delivery rows depending on push subscriptions -- so this tops up one
-- notification at a time and re-checks the actual delivery-row count after
-- each, rather than assuming a fixed number of filler sends reaches 12.
do $$
declare
  v_user uuid;
  v_notif_id uuid;
  v_count integer;
  v_iterations integer := 0;
  v_last_status text;
  v_last_error text;
begin
  select user_id into v_user from _verify_ctx;
  if v_user is null then
    insert into _verify_results values (
      'probe: recipient hourly cap (12) produces a skipped/rate-limited row, not pending', false,
      'skipped: no public.member_profiles row was available to test against');
    return;
  end if;

  begin
    update private.notification_controls set outbound_enabled = true where id;
    update public.member_profiles
      set notification_prefs = notification_prefs || jsonb_build_object('cases', true, 'events', true)
      where id = v_user;

    select count(*) into v_count from public.member_notification_deliveries
      where user_id = v_user and created_at > now() - interval '1 hour';

    while v_count < 12 and v_iterations < 30 loop
      insert into public.member_notifications (user_id, title, body, kind)
      values (v_user, 'verify-probe F filler', 'synthetic row, this whole script rolls back', 'events');

      select count(*) into v_count from public.member_notification_deliveries
        where user_id = v_user and created_at > now() - interval '1 hour';

      v_iterations := v_iterations + 1;
    end loop;

    if v_count < 12 then
      insert into _verify_results values (
        'probe: recipient hourly cap (12) produces a skipped/rate-limited row, not pending', false,
        format('could not reach 12 delivery rows in the trailing hour after %s filler sends (stuck at %s); cap was not exercised',
               v_iterations, v_count));
      return;
    end if;

    insert into public.member_notifications (user_id, title, body, kind)
    values (v_user, 'verify-probe F (should trip the cap)', 'synthetic row, this whole script rolls back', 'events')
    returning id into v_notif_id;

    select status, last_error into v_last_status, v_last_error
      from public.member_notification_deliveries
      where notification_id = v_notif_id
      order by created_at desc limit 1;

    insert into _verify_results values (
      'probe: recipient hourly cap (12) produces a skipped/rate-limited row, not pending',
      v_last_status = 'skipped' and v_last_error ilike '%rate limited%',
      format('after %s filler sends: status=%s last_error=%s (expected status=skipped, last_error containing "rate limited")',
             v_iterations, v_last_status, v_last_error));
  exception when others then
    insert into _verify_results values (
      'probe: recipient hourly cap (12) produces a skipped/rate-limited row, not pending', false,
      'probe crashed: ' || sqlerrm || ' (sqlstate=' || sqlstate || ')');
  end;
end $$;

-- Probe G: claim_notification_deliveries moves probe C's row to 'sending',
-- increments attempts and the monotonic lease epoch, and hands both back for
-- probe H's record call to echo. Claims broadly (a real
-- limit, not filtered to one user), then finds probe C's specific delivery
-- id inside the returned array, because the RPC has no way to scope a claim
-- to one recipient and that is correct production behaviour to test against.
do $$
declare
  v_target_notif uuid;
  v_target_delivery uuid;
  v_claimed jsonb;
  v_claimed_attempt integer;
  v_claimed_lease_epoch bigint;
  v_found boolean;
  v_row_status text;
  v_row_attempts integer;
  v_row_lease_epoch bigint;
  v_pass boolean;
begin
  select cases_notification_id into v_target_notif from _verify_ctx;
  if v_target_notif is null then
    insert into _verify_results values (
      'probe: claim_notification_deliveries returns a positive monotonic lease epoch', false,
      'skipped: prerequisite probe C did not produce a target notification');
    return;
  end if;

  begin
    select id into v_target_delivery from public.member_notification_deliveries
      where notification_id = v_target_notif and channel = 'email';

    if v_target_delivery is null then
      insert into _verify_results values (
        'probe: claim_notification_deliveries returns a positive monotonic lease epoch', false,
        'skipped: no email delivery row exists for probe C''s notification');
      return;
    end if;

    update private.notification_controls set outbound_enabled = true where id;

    select public.claim_notification_deliveries('email', 500) into v_claimed;

    select (elem.item ->> 'attempt')::integer,
         (elem.item ->> 'leaseEpoch')::bigint,
         true
      into v_claimed_attempt, v_claimed_lease_epoch, v_found
      from jsonb_array_elements(v_claimed) as elem(item)
      where (elem.item ->> 'deliveryId')::uuid = v_target_delivery;

    select status, attempts, delivery_lease_epoch
      into v_row_status, v_row_attempts, v_row_lease_epoch
      from public.member_notification_deliveries where id = v_target_delivery;

    v_pass := coalesce(v_found, false)
          and v_claimed_attempt is not null and v_claimed_attempt > 0
          and v_claimed_lease_epoch is not null and v_claimed_lease_epoch > 0
          and v_row_status = 'sending'
          and v_row_attempts = v_claimed_attempt
          and v_row_lease_epoch = v_claimed_lease_epoch;

    insert into _verify_results values (
      'probe: claim_notification_deliveries returns a positive monotonic lease epoch',
      v_pass,
      format('found_in_claim_response=%s returned_attempt=%s returned_lease_epoch=%s row_status=%s row_attempts=%s row_lease_epoch=%s',
             coalesce(v_found, false), v_claimed_attempt, v_claimed_lease_epoch,
             v_row_status, v_row_attempts, v_row_lease_epoch));
  exception when others then
    insert into _verify_results values (
      'probe: claim_notification_deliveries returns a positive monotonic lease epoch', false,
      'probe crashed: ' || sqlerrm || ' (sqlstate=' || sqlstate || ')');
  end;
end $$;

-- Probe H: record_notification_delivery_results honors the lease predicate
-- (`status = 'sending' and delivery_lease_epoch = v_lease_epoch`). A stale
-- lease epoch must be a silent no-op even when the attempt number matches --
-- that is what makes a delayed pre-deferral result harmless -- and the current
-- epoch must apply. Depends on probe G having claimed the row; reads the lease
-- fields fresh from the row
-- rather than assuming N, so it is correct even if probe G's own assertion
-- failed for an unrelated reason.
do $$
declare
  v_target_notif uuid;
  v_target_delivery uuid;
  v_true_attempt integer;
  v_true_lease_epoch bigint;
  v_stale_lease_epoch bigint;
  v_status_before text;
  v_wrong_result jsonb;
  v_status_after_wrong text;
  v_right_result jsonb;
  v_status_after_right text;
  v_pass boolean;
begin
  select cases_notification_id into v_target_notif from _verify_ctx;
  if v_target_notif is null then
    insert into _verify_results values (
      'probe: record_notification_delivery_results rejects a stale lease epoch with the current attempt', false,
      'skipped: prerequisite probe C did not produce a target notification');
    return;
  end if;

  begin
    select id, attempts, delivery_lease_epoch, status
      into v_target_delivery, v_true_attempt, v_true_lease_epoch, v_status_before
      from public.member_notification_deliveries where notification_id = v_target_notif and channel = 'email';

    if v_target_delivery is null or v_status_before <> 'sending' then
      insert into _verify_results values (
        'probe: record_notification_delivery_results rejects a stale lease epoch with the current attempt', false,
        format('skipped: target row not in "sending" state before this probe (found status=%s) -- probe G must claim it first',
               coalesce(v_status_before, '(row not found)')));
      return;
    end if;

    -- Keep the stale value structurally valid so this probe reaches the lease
    -- predicate instead of being rejected by the malformed-entry guard. The
    -- first real claim yields epoch 1, making subtraction produce forbidden 0.
    v_stale_lease_epoch := v_true_lease_epoch + 7;

    select public.record_notification_delivery_results(
      jsonb_build_array(jsonb_build_object(
        'deliveryId', v_target_delivery,
        'attempt', v_true_attempt,
        'leaseEpoch', v_stale_lease_epoch,
        'status', 'sent'))
    ) into v_wrong_result;

    select status into v_status_after_wrong from public.member_notification_deliveries where id = v_target_delivery;

    select public.record_notification_delivery_results(
      jsonb_build_array(jsonb_build_object(
        'deliveryId', v_target_delivery,
        'attempt', v_true_attempt,
        'leaseEpoch', v_true_lease_epoch,
        'status', 'sent'))
    ) into v_right_result;

    select status into v_status_after_right from public.member_notification_deliveries where id = v_target_delivery;

    v_pass := (v_status_after_wrong = 'sending')
          and (coalesce((v_wrong_result ->> 'ignored')::integer, 0) = 1)
          and (v_status_after_right = 'sent')
          and (coalesce((v_right_result ->> 'applied')::integer, 0) = 1);

    insert into _verify_results values (
      'probe: record_notification_delivery_results rejects a stale lease epoch with the current attempt',
      v_pass,
      format('attempt=%s true_lease_epoch=%s stale_lease_epoch=%s status_after_stale_lease=%s stale_call_result=%s status_after_current_lease=%s current_call_result=%s',
             v_true_attempt, v_true_lease_epoch, v_stale_lease_epoch,
             v_status_after_wrong, v_wrong_result, v_status_after_right, v_right_result));
  exception when others then
    insert into _verify_results values (
      'probe: record_notification_delivery_results rejects a stale lease epoch with the current attempt', false,
      'probe crashed: ' || sqlerrm || ' (sqlstate=' || sqlstate || ')');
  end;
end $$;

-- Probe I: the database-side kill switch stops the DISPATCHER too, not just
-- the enqueue trigger -- claim_notification_deliveries must hand back
-- nothing while outbound_enabled=false, independent of anything sitting in
-- the queue. Needs no target user or prerequisite row.
do $$
declare
  v_result jsonb;
begin
  begin
    update private.notification_controls set outbound_enabled = false where id;

    select public.claim_notification_deliveries('email', 10) into v_result;

    insert into _verify_results values (
      'probe: claim_notification_deliveries returns [] when outbound_enabled=false',
      v_result = '[]'::jsonb,
      'returned: ' || coalesce(v_result::text, '(null)'));
  exception when others then
    insert into _verify_results values (
      'probe: claim_notification_deliveries returns [] when outbound_enabled=false', false,
      'probe crashed: ' || sqlerrm || ' (sqlstate=' || sqlstate || ')');
  end;
end $$;

-- ============================================================================
-- PART 2 -- results. Ordered failures-first so a broken run is visible
-- without scrolling; a trailing SUMMARY row gives the failure count and lists
-- every failing check by name so it can be grepped straight out of psql
-- output. `rollback` below is what makes every insert/update above -- schema
-- probe rows, control-plane flips, pref mutations -- vanish; nothing from
-- this script is ever visible to another session.
-- ============================================================================

select
  result,
  check_name,
  passed,
  detail
from (
  select
    case when passed then 'PASS' else 'FAIL' end as result,
    check_name,
    passed,
    detail,
    0 as _rank
  from _verify_results

  union all

  select
    'SUMMARY' as result,
    format('%s of %s checks failed', count(*) filter (where not passed), count(*)) as check_name,
    (count(*) filter (where not passed) = 0) as passed,
    case when count(*) filter (where not passed) = 0
         then 'all checks passed'
         else (select string_agg(check_name, '; ' order by check_name) from _verify_results where not passed)
    end as detail,
    1 as _rank
  from _verify_results
) x
order by _rank, passed, check_name;

rollback;
