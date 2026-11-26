-- UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107 (#7373)
-- The SAMPLE demo entry (api/demo-session.js) signs every visitor in as one of
-- six shared, fictional Tamarack persona accounts, staff personas at aal2.
-- Hiding the account controls in the app is not enough: the released session
-- can call Auth directly. These triggers refuse, whatever path reached Auth
-- (PUT /auth/v1/user, factor unenroll or enroll, passkey registration, the
-- Admin API), every change to such an account's
-- durable sign-in state:
--   * auth.users: a new email, password or phone, a pending email or phone
--     change, a ban (address recovery and password reissue ban first, so
--     they stop before anything commits), soft deletion, and deletion;
--   * auth.mfa_factors: a new factor, removing a verified factor, and changing
--     a factor's secret, status, type or owner;
--   * auth.webauthn_credentials: registering or removing a passkey;
--   * public.mfa_recovery_code_sets and public.mfa_recovery_codes: generating
--     or claiming a recovery code, so MFA recovery is refused before its
--     service-role preparation can install an account-wide recovery lock.
-- Ordinary sign-in bookkeeping (last_sign_in_at, a factor's
-- last_challenged_at) still passes, so the entry, the bots and their daily
-- workday keep working. auth.identities is deliberately not guarded here: it
-- is an Auth bookkeeping table the reviewed lock-scope design
-- (BUG-UG-AUTH-BOOKKEEPING-CASE-GRAPH-LOCK-20260908) pins to its single
-- shared bookkeeping trigger, and an identity link neither changes the
-- account's email, password or factors nor the demo entry, which signs in by
-- the account's own address. The list is the six entry
-- personas in config/sample-backend.json (tests/demo-session-api.test.js keeps
-- the two equal); the accounts exist only on SAMPLE. An operator holding a
-- database owner session may lift the guard for one transaction with
-- set local union_ground.shared_demo_persona_maintenance = 'on' (for example
-- to re-enroll a persona's authenticator); Auth's own connections never set it.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function private.is_shared_demo_persona_email(p_email text)
returns boolean language sql immutable set search_path = ''
as $function$
  select pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, ''))) = any (array[
    'marcus.greene@loadtest.example.com',
    'dylan.kowalski@loadtest.example.com',
    'tanisha.holloway@loadtest.example.com',
    'naomi.brooks@loadtest.example.com',
    'colleen.moynihan@loadtest.example.com',
    'marisol.ibarra@loadtest.example.com'
  ]::text[]);
$function$;
revoke all on function private.is_shared_demo_persona_email(text) from public, anon, authenticated, service_role;
comment on function private.is_shared_demo_persona_email(text) is
  'Whether an address is one of the six shared SAMPLE demo entry personas (config/sample-backend.json samplePersonas).';

create function private.guard_shared_demo_persona_account()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  v_user uuid;
  v_refused boolean := false;
begin
  if pg_catalog.current_setting('union_ground.shared_demo_persona_maintenance', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_table_name = 'users' then
    if private.is_shared_demo_persona_email(old.email) then
      if tg_op = 'DELETE' then
        v_refused := true;
      else
        v_refused := new.email is distinct from old.email
          or new.encrypted_password is distinct from old.encrypted_password
          or coalesce(new.phone, '') <> coalesce(old.phone, '')
          or coalesce(new.email_change, '') not in ('', coalesce(old.email_change, ''))
          or coalesce(new.phone_change, '') not in ('', coalesce(old.phone_change, ''))
          or new.banned_until is distinct from old.banned_until
          or (new.deleted_at is not null and old.deleted_at is null);
      end if;
    end if;
  else
    v_user := case when tg_op = 'INSERT' then new.user_id else old.user_id end;
    if exists (select 1 from auth.users u
               where u.id = v_user and private.is_shared_demo_persona_email(u.email)) then
      if tg_table_name = 'mfa_factors' then
        v_refused := case tg_op
          when 'INSERT' then true
          when 'DELETE' then old.status::text = 'verified'
          else new.user_id is distinct from old.user_id
            or new.secret is distinct from old.secret
            or new.status is distinct from old.status
            or new.factor_type is distinct from old.factor_type
        end;
      elsif tg_table_name = 'webauthn_credentials' then
        v_refused := tg_op in ('INSERT', 'DELETE') or new.user_id is distinct from old.user_id;
      elsif tg_table_name in ('mfa_recovery_code_sets', 'mfa_recovery_codes') then
        v_refused := tg_op in ('INSERT', 'UPDATE');
      end if;
    end if;
  end if;

  if v_refused then
    raise exception 'shared demo account cannot be changed' using errcode = '42501', hint = 'shared-demo-account';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;
revoke all on function private.guard_shared_demo_persona_account() from public, anon, authenticated, service_role;
comment on function private.guard_shared_demo_persona_account() is
  'Refuses changes to the shared SAMPLE demo personas'' email, password, phone, ban, factors, passkeys, recovery codes and existence; sign-in bookkeeping passes.';

create trigger guard_shared_demo_persona_account
before update or delete on auth.users
for each row execute function private.guard_shared_demo_persona_account();

create trigger guard_shared_demo_persona_account
before insert or update or delete on auth.mfa_factors
for each row execute function private.guard_shared_demo_persona_account();

create trigger guard_shared_demo_persona_account
before insert or update or delete on auth.webauthn_credentials
for each row execute function private.guard_shared_demo_persona_account();

create trigger guard_shared_demo_persona_account
before insert or update on public.mfa_recovery_code_sets
for each row execute function private.guard_shared_demo_persona_account();

create trigger guard_shared_demo_persona_account
before insert or update on public.mfa_recovery_codes
for each row execute function private.guard_shared_demo_persona_account();

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.object_name = 'guard_shared_demo_persona_account'
       and ((s.schema_name = 'auth' and s.table_name in ('users', 'mfa_factors', 'webauthn_credentials'))
         or (s.schema_name = 'public' and s.table_name in ('mfa_recovery_code_sets', 'mfa_recovery_codes'))))
   or (s.kind = 'function' and s.schema_name = 'private'
       and pg_catalog.split_part(s.object_name, '(', 1) in ('guard_shared_demo_persona_account', 'is_shared_demo_persona_email'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;
do $review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review incomplete after the shared demo persona guard';
  end if;
end;
$review$;
notify pgrst, 'reload schema';
commit;
