-- REQ-UG-SELF-SERVICE-PASSWORD-RESET-20261006
--
-- Owner decision, October 8, 2026: a member resets their own password by a
-- link to the verified email, with two-step enforced on recovery, and staff
-- reissue kept as the fallback. api/password-reset.js needs two database
-- pieces, both reachable only by the service role:
--
-- 1. public.consume_password_reset_attempt: the durable, fixed-window limits
--    on the public reset form (per network and per address), and on
--    authenticator-code attempts per account during recovery. Built on
--    private.auth_attempt_check (20261002015000), the same keyed-HMAC throttle
--    password sign-in uses, in its own scopes so a reset never spends a
--    sign-in budget. The limits never depend on whether an account exists.
-- 2. public.record_self_service_password_reset: the audit row a completed
--    recovery writes into public.member_admin_audit, the trail that already
--    holds the other credential recoveries (reset_mfa, recover_signin_address).
--    The member is both actor and target, as event_checkin_lockout is.

begin;

create function public.consume_password_reset_attempt(p_scope text, p_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_key text := coalesce(p_key, '');
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope = 'network' then
    if v_key !~ '^(ipv4:[0-9]{1,3}(\.[0-9]{1,3}){3}|ipv6:[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}::/64|unknown)$' then
      raise exception 'invalid password reset attempt' using errcode = '22023';
    end if;
    return private.auth_attempt_check('password-reset-network', v_key, 20, interval '1 hour');
  elsif p_scope = 'email' then
    v_key := pg_catalog.lower(pg_catalog.btrim(v_key));
    if pg_catalog.char_length(v_key) not between 3 and 254 or v_key !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
      raise exception 'invalid password reset attempt' using errcode = '22023';
    end if;
    return private.auth_attempt_check('password-reset-email', v_key, 5, interval '1 hour');
  elsif p_scope = 'code' then
    if v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid password reset attempt' using errcode = '22023';
    end if;
    return private.auth_attempt_check('password-reset-code', v_key, 10, interval '1 hour');
  end if;
  raise exception 'invalid password reset attempt' using errcode = '22023';
end;
$function$;

revoke all on function public.consume_password_reset_attempt(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_password_reset_attempt(text, text) to service_role;

comment on function public.consume_password_reset_attempt(text, text) is
  'REQ-UG-SELF-SERVICE-PASSWORD-RESET-20261006: service-only fixed-window limits for self-service password reset: 20 requests per network per hour, 5 per address per hour, 10 authenticator-code attempts per account per hour. Independent of whether an account exists.';

-- Existing audit table has a closed vocabulary; extend it by the one new
-- action without dropping any settled action from 20261004050000.
alter table public.member_admin_audit drop constraint if exists member_admin_audit_action_check;
alter table public.member_admin_audit add constraint member_admin_audit_action_check
  check (action in (
    'grant_role', 'revoke_role',
    'create_event', 'update_event', 'cancel_event', 'restore_event', 'delete_event',
    'reset_mfa',
    'claim_reward', 'grant_reward', 'revoke_reward', 'fulfill_reward',
    'set_staff_mfa_policy',
    'set_compass_ai_enabled', 'set_compass_ai_role_limit', 'attest_compass_ai_provider',
    'create_campaign', 'update_campaign_draft', 'publish_campaign', 'close_campaign',
    'recover_signin_address', 'recover_signin_address_failed',
    'review_email_intake',
    'create_chapter', 'update_chapter',
    'grant_chapter_membership', 'revoke_chapter_membership',
    'event_checkin_lockout',
    'set_chapter_display_title',
    'self_service_password_reset'
  ));

create function public.record_self_service_password_reset(p_user_id uuid, p_enrolled_two_step boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_enrolled_two_step is null then
    raise exception 'invalid password reset audit' using errcode = '22023';
  end if;
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    return false;
  end if;
  -- No credential, address or code is written: only that the member reset
  -- their own password and whether two-step was set up during the recovery.
  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (p_user_id, 'self_service_password_reset', p_user_id,
    pg_catalog.jsonb_build_object('twoStepEnrolled', p_enrolled_two_step));
  return true;
end;
$function$;

revoke all on function public.record_self_service_password_reset(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.record_self_service_password_reset(uuid, boolean) to service_role;

comment on function public.record_self_service_password_reset(uuid, boolean) is
  'REQ-UG-SELF-SERVICE-PASSWORD-RESET-20261006: service-only audit of a completed self-service password reset, written to member_admin_audit with the member as actor and target. Records whether two-step was enrolled during the recovery; never a credential or address.';

commit;
