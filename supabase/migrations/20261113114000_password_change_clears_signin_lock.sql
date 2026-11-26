-- BUG-UG-FAILED-SIGNIN-LOCK-SURVIVES-COMPLETED-RESET-20261112
-- Five wrong passwords for one address spend two hourly buckets: the app
-- route's per-address bucket (password-signin-email, keyed by the normalized
-- address) and the Auth hook's per-account bucket (password-hook-account,
-- keyed by the account id). Both refuse the right password until the window
-- from the first failure ends, so anyone who knows an address could keep its
-- owner out, and the owner's own completed reset did not help.
--
-- A changed password ends that lock for its own account only: the failures it
-- counted were guesses at a password that no longer exists. Only the two rows
-- of that account and address go; the network buckets and every other
-- account stay as they are. Requesting or beginning a reset changes no
-- password, so it lifts nothing, and wrong attempts after the change open a
-- fresh window under the same limits.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function private.clear_password_signin_lock_after_password_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  key_secret bytea;
  bucket record;
begin
  -- A throttle problem must never block the password change itself, so any
  -- error here leaves the lock to expire on its own and lets the update stand.
  begin
    select k.secret into key_secret from private.auth_attempt_throttle_key k where k.id;
    if key_secret is null then
      return null;
    end if;
    -- The same digests and advisory locks the attempt counter takes, so a
    -- concurrent attempt for this account either lands before the delete or
    -- opens the next window after it.
    for bucket in
      select b.scope, pg_catalog.encode(extensions.hmac(pg_catalog.convert_to(
          b.scope || ':' || b.subject, 'UTF8'), key_secret, 'sha256'), 'hex') as key_hash
      from (values
        (1, 'password-signin-email', pg_catalog.lower(pg_catalog.btrim(new.email))),
        (2, 'password-hook-account', pg_catalog.lower(new.id::text))
      ) as b(ordinal, scope, subject)
      where b.subject is not null and b.subject <> ''
      order by b.ordinal
    loop
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'auth-attempt-throttle:' || bucket.scope || ':' || bucket.key_hash, 509));
      delete from private.auth_attempt_throttle t
      where t.scope = bucket.scope and t.key_hash = bucket.key_hash;
    end loop;
  exception when others then
    return null;
  end;
  return null;
end;
$function$;

revoke all on function private.clear_password_signin_lock_after_password_change()
  from public, anon, authenticated, service_role;

comment on function private.clear_password_signin_lock_after_password_change() is
  'BUG-UG-FAILED-SIGNIN-LOCK-SURVIVES-COMPLETED-RESET-20261112: after an account''s password changes, deletes only that address''s password-signin-email bucket and that account''s password-hook-account bucket in private.auth_attempt_throttle. Network buckets and other accounts are untouched.';

create trigger password_change_clears_signin_lock
  after update of encrypted_password on auth.users
  for each row
  when (old.encrypted_password is distinct from new.encrypted_password
    and new.encrypted_password is not null and new.encrypted_password <> '')
  execute function private.clear_password_signin_lock_after_password_change();

-- Reviewed trigger surface (account lifecycle inventory): the new trigger
-- and the function it runs. Recorded after both exist.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'auth' and table_name = 'users'
        and object_name = 'password_change_clears_signin_lock')
   or (kind = 'function' and schema_name = 'private'
       and object_name = 'clear_password_signin_lock_after_password_change()')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_password_change_lock_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the password-change lock trigger: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
end;
$assert_password_change_lock_lifecycle$;

commit;
