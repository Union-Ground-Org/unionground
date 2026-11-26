-- BUG-UG-WEB-EVENT-CHECKIN-REFUSALS-ENGLISH-ONLY-20261003
--
-- Event check-in refusals reached members, Spanish speakers included, as raw
-- English server text, because none carried a machine token the client can
-- translate. This adds tokens and changes nothing else:
--   * check_in_to_event's window refusal and request_event_checkin_token's
--     window refusal raise DETAIL checkin_not_open;
--   * check_in_to_event's returned refusal payload (wrong code and lockout,
--     one literal,) gains 'token' checkin_code_invalid,
--     so the two stay indistinguishable.
-- src/lib/rpcErrorText.js maps both tokens to English and Spanish copy, and
-- checkInToEvent copies the payload token into the client error's details.
--
-- Both bodies are the installed definitions read with pg_get_functiondef from
-- a disposable stack at Main, with only those lines changed, behind prosrc
-- predecessor guards. Signatures, owners, security definer, search_path and
-- grants are unchanged by create or replace.
--
-- Hosted application needs the owner's separate go-ahead. Until then an
-- untokenized check-in failure shows the catalogue toast.saveFailed sentence,
-- and checkInToEvent already labels wrong-code payloads checkin_code_invalid.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $predecessors$
declare
  check_in text;
  code_request text;
begin
  select pg_catalog.md5(p.prosrc) into strict check_in
    from pg_catalog.pg_proc p
   where p.oid = 'public.check_in_to_event(text, text)'::regprocedure;
  select pg_catalog.md5(p.prosrc) into strict code_request
    from pg_catalog.pg_proc p
   where p.oid = 'public.request_event_checkin_token(text)'::regprocedure;
  if check_in is distinct from 'd5848b4dcc7309bb82f221fbb5eac585' then
    raise exception 'unreviewed check_in_to_event predecessor: %', check_in
      using errcode = '55000';
  end if;
  if code_request is distinct from '1f4205811559460b7b969fda83461a22' then
    raise exception 'unreviewed request_event_checkin_token predecessor: %', code_request
      using errcode = '55000';
  end if;
end;
$predecessors$;

CREATE OR REPLACE FUNCTION public.check_in_to_event(p_event_id text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  ev record;
  prior_wrong integer;
  prior_locked_until timestamptz;
  now_at timestamptz;
  wrong_count integer;
  checkin_org uuid;
  checkin_limit integer;
  checkin_lock_minutes integer;
  new_checkin integer := 0;
  awarded integer := 0;
  rule_points integer;
  -- One literal for both refusals (: a bound refusal is
  -- indistinguishable from a wrong code). Same SQLSTATE and message the
  -- raised refusal carried, so every surface reports the same failure.
  refusal constant jsonb := pg_catalog.jsonb_build_object(
    'checkedIn', false,
    'refused', true,
    'code', '22023',
    'message', 'invalid check-in code',
    'token', 'checkin_code_invalid'
  );
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select e.id, e.check_in_code, e.starts_at, e.cancelled_at into ev
  from public.member_events e
  where e.id = p_event_id
    and private.member_can_access_event_scope(
      e.chapter_id, e.is_public, e.is_public_across_agencies
    )
  for share;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'event_cancelled';
  end if;

  if now() < ev.starts_at - interval '2 hours' or now() > ev.starts_at + interval '4 hours' then
    raise exception 'check-in is only open around the event start time' using errcode = '22023', detail = 'checkin_not_open';
  end if;

  -- Bound by the event organization's nonzero lock settings.
  select c.organization_id into checkin_org
  from public.member_events e join public.chapters c on c.id = e.chapter_id
  where e.id = p_event_id;
  checkin_limit := private.organization_limit(checkin_org, 'limits.security.event_checkin_wrong_codes');
  checkin_lock_minutes := private.organization_limit(checkin_org, 'limits.security.event_checkin_lock_minutes');
  now_at := private.event_checkin_clock();
  select a.wrong_attempts, a.locked_until into prior_wrong, prior_locked_until
  from private.member_event_checkin_attempts a
  where a.event_id = p_event_id and a.user_id = caller
  for update;
  if prior_locked_until is not null and now_at < prior_locked_until then
    -- Locked out: the correct code is refused too, nothing is counted, and
    -- the caller cannot tell this apart from a wrong code.
    return refusal;
  end if;

  if pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, ''))) <> pg_catalog.upper(ev.check_in_code) then
    -- An expired lockout starts a fresh window; otherwise the window continues.
    wrong_count := case
      when prior_wrong is null or prior_locked_until is not null then 1
      else prior_wrong + 1
    end;
    insert into private.member_event_checkin_attempts (event_id, user_id, wrong_attempts, locked_until, last_attempt_at)
    values (
      p_event_id, caller, wrong_count,
      case when wrong_count >= checkin_limit then now_at + pg_catalog.make_interval(mins => checkin_lock_minutes) end,
      now_at
    )
    on conflict (event_id, user_id) do update
      set wrong_attempts = excluded.wrong_attempts,
          locked_until = excluded.locked_until,
          last_attempt_at = excluded.last_attempt_at;
    if wrong_count >= checkin_limit then
      -- One audit row per lockout naming the event and the caller; no code
      -- value, neither the guess nor the secret, is ever written.
      insert into public.member_admin_audit (actor, action, target_user, detail)
      values (caller, 'event_checkin_lockout', caller, pg_catalog.jsonb_build_object(
        'eventId', p_event_id,
        'wrongAttempts', wrong_count,
        'lockedUntil', now_at + pg_catalog.make_interval(mins => checkin_lock_minutes)
      ));
    end if;
    return refusal;
  end if;

  -- A correct code outside a lockout closes the window.
  delete from private.member_event_checkin_attempts
  where event_id = p_event_id and user_id = caller;

  insert into public.member_event_checkins (event_id, user_id)
  values (p_event_id, caller)
  on conflict (event_id, user_id) do nothing;
  get diagnostics new_checkin = row_count;

  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, 'checkin-' || p_event_id, 'checkin')
  on conflict (user_id, action_key) do nothing;
  get diagnostics awarded = row_count;

  select points into rule_points
  from public.member_point_rules where action_kind = 'checkin';
  return pg_catalog.jsonb_build_object(
    'checkedIn', true,
    'alreadyCheckedIn', new_checkin = 0,
    'awardedPoints', case when awarded = 1 then coalesce(rule_points, 0) else 0 end
  );
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.request_event_checkin_token(p_event_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  ev record;
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bytes bytea;
  plain text := '';
  valid_until timestamptz;
  i integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select e.starts_at, e.cancelled_at into ev
  from public.member_events e
  where e.id = p_event_id
    and private.member_can_access_event_scope(
      e.chapter_id, e.is_public, e.is_public_across_agencies
    )
  for share;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'event_cancelled';
  end if;
  if now() < ev.starts_at - interval '2 hours' or now() > ev.starts_at + interval '4 hours' then
    raise exception 'check-in codes are only available around the event start time' using errcode = '22023', detail = 'checkin_not_open';
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

  return pg_catalog.jsonb_build_object('token', plain, 'expiresAt', valid_until, 'ttlSeconds', 90);
end;
end;
$function$;

commit;
