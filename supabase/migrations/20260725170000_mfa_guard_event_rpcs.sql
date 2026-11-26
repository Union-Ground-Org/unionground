-- MFA assurance guard for the event member RPCs (REQ-UG-DEFINER-MFA-AUDIT, batch 1 of 4: events).
--
-- VECTOR
-- SECURITY DEFINER bypasses RLS, so the RESTRICTIVE mfa_assurance policy that
-- covers every RLS table (20260724030000) does nothing for a definer function.
-- 20260724031000 covered the 27 staff RPCs transitively through member_has_role
-- (which carries the term) and 20260724034000 caught two capability RPCs, but the
-- member action RPCs that predate the boundary were never swept as a set. These
-- three mint points / issue a check-in token; an aal1 session belonging to a
-- member who HAS enrolled a TOTP factor can call them today without stepping up.
--
-- FIX
-- Add the same assurance term the guarded siblings (submit_ballot_vote,
-- create_member_case, rotate_calendar_feed_token, ...) already carry:
--   if caller is null or not private.mfa_satisfied() then raise 42501.
-- private.mfa_satisfied() is aal2 OR "no verified TOTP factor", so this is
-- NON-LOCKOUT for members without MFA — it only forces step-up for a member who
-- enrolled TOTP but is still at aal1. Bodies are otherwise VERBATIM from the live
-- definitions (pg_get_functiondef); the only change per function is the guard
-- line plus its comment. Post-apply the before/after definitions are diffed to
-- prove nothing else moved.
--
-- STAGING + COVERAGE
-- This is batch 1 of a 4-batch rollout (events / forms / cosign / capability) so
-- no single merge carries all 13 lockout-capable changes. scripts/db-contract.json
-- gains an mfaCoverage sweep that requires every SECURITY DEFINER function
-- reachable by authenticated to carry the term (directly or via member_has_role)
-- or sit on an exemption list; the 10 not-yet-guarded functions are recorded as
-- PENDING and shrink to zero as the later batches land.

set local lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.check_in_to_event(p_event_id text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  ev record;
  new_checkin integer := 0;
  awarded integer := 0;
  rule_points integer;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): mints a check-in point.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select id, check_in_code, starts_at into ev
  from public.member_events where id = p_event_id;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;

  if now() < ev.starts_at - interval '2 hours' or now() > ev.starts_at + interval '4 hours' then
    raise exception 'check-in is only open around the event start time' using errcode = '22023';
  end if;

  if pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, ''))) <> pg_catalog.upper(ev.check_in_code) then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  insert into public.member_event_checkins (event_id, user_id)
  values (p_event_id, caller)
  on conflict (event_id, user_id) do nothing;
  get diagnostics new_checkin = row_count;

  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, 'checkin-' || p_event_id, 'checkin')
  on conflict (user_id, action_key) do nothing;
  get diagnostics awarded = row_count;

  select points into rule_points from public.member_point_rules where action_kind = 'checkin';
  return pg_catalog.jsonb_build_object(
    'checkedIn', true,
    'alreadyCheckedIn', new_checkin = 0,
    'awardedPoints', case when awarded = 1 then coalesce(rule_points, 0) else 0 end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.request_event_checkin_token(p_event_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  ev_starts timestamptz;
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bytes bytea;
  plain text := '';
  valid_until timestamptz;
  i integer;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): issues a bearer token.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select starts_at into ev_starts from public.member_events where id = p_event_id;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if now() < ev_starts - interval '2 hours' or now() > ev_starts + interval '4 hours' then
    raise exception 'check-in codes are only available around the event start time' using errcode = '22023';
  end if;

  delete from private.member_event_checkin_tokens
  where event_id = p_event_id and user_id = caller and consumed_at is null;

  bytes := extensions.gen_random_bytes(7);
  for i in 0..6 loop
    plain := plain || pg_catalog.substr(alphabet, (pg_catalog.get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  valid_until := now() + interval '90 seconds';

  insert into private.member_event_checkin_tokens (event_id, user_id, token_hash, expires_at)
  values (p_event_id, caller, pg_catalog.encode(extensions.digest(plain, 'sha256'), 'hex'), valid_until);

  return pg_catalog.jsonb_build_object(
    'token', plain,
    'expiresAt', valid_until,
    'ttlSeconds', 90
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.rsvp_to_event(p_event_id text, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  awarded integer := 0;
  rule_points integer;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): mints an rsvp point.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_status not in ('going', 'not_going') then
    raise exception 'invalid rsvp status' using errcode = '22023';
  end if;
  if not exists (select 1 from public.member_events where id = p_event_id) then
    raise exception 'event not found' using errcode = '22023';
  end if;

  insert into public.member_event_rsvps (event_id, user_id, status, updated_at)
  values (p_event_id, caller, p_status, now())
  on conflict (event_id, user_id) do update set status = excluded.status, updated_at = now();

  if p_status = 'going' then
    insert into public.member_action_log (user_id, action_key, action_kind)
    values (caller, 'rsvp-' || p_event_id, 'rsvp')
    on conflict (user_id, action_key) do nothing;
    get diagnostics awarded = row_count;
  end if;

  select points into rule_points from public.member_point_rules where action_kind = 'rsvp';
  return pg_catalog.jsonb_build_object(
    'status', p_status,
    'awardedPoints', case when awarded = 1 then coalesce(rule_points, 0) else 0 end
  );
end;
$function$;
