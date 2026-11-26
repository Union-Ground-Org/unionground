-- SEC-UG-ACCOUNT-RECOVERY-NOTICE-AND-RESET-LOCK-GAPS-20261117 (#9036)
--
-- 1. The account-recovery email is durable work.
--    finalize_mfa_recovery_code consumed the recovery code, wrote the audit
--    row and the in-app notice, and the route (api/mfa-recovery.js) emailed
--    the account's own address only after it read finalize's reply. If the
--    finalize committed but its reply was lost, the route answered 502 and
--    never sent the email or raised the private account-mail alert, and the
--    consumed code could not reach that step again. The in-app notice is
--    kind 'general', which the notification queue never emails (#8535 round
--    1, r1s2).
--
--    finalize now also writes one row to private.account_notice_mail in the
--    same transaction that consumes the code. The row names the account, the
--    notice, and the account's address and saved language as they were at
--    that moment, so a later address change cannot redirect it. Before the
--    first send the sender stores the complete provider request on the row
--    (sender, recipient, subject, text and HTML with its postal footer), and
--    every try sends exactly that stored request, so a retry is identical
--    even across a redeploy (the provider refuses a reused key whose message
--    differs). It holds no code, hash or device. The route
--    sends it right after finalize (also when finalize's reply was lost), and
--    the notification dispatcher's five-minute tick sends anything still
--    waiting. Three service-only functions do the work:
--    * claim_account_notice_mail leases due rows for two minutes (one
--      account's rows, or every account's for the sweep), soonest-due first,
--      and returns each with its stored address and language. With
--      p_limit 0 it claims nothing (the sweep's retention-only call);
--    * prepare_account_notice_mail stores the provider request on a leased
--      row once (addressed to the stored address only) and returns the
--      stored request, which the sender then sends unchanged;
--    * complete_account_notice_mail marks a leased row sent, or puts it back
--      with a back-off, only while the row is still on that attempt.
--    Every send of a row carries the same Idempotency-Key, built from the
--    row's random id, so the mail provider delivers it once even when two
--    tries overlap or a result is lost. Rows are tried for 23 hours, inside
--    the provider's 24-hour idempotency window.
--
--    A failed send: the sender puts the row back (complete with p_sent false)
--    and raises the private account-mail alert. The row is due again after a
--    back-off of 5, 10, 20 and 40 minutes, then every hour, and is resent
--    under the same key. Rows are claimed soonest-due first, so rows that keep
--    failing never hold back a newer one. A row whose result was never
--    recorded is due again when its two-minute lease ends. After 23 hours
--    without a send the row is no longer claimed and stays unsent.
--
--    Retention: a row is kept seven days from when it was queued, sent or
--    not, and then the dispatcher's sweep deletes it. The sweep makes that
--    call on every tick, also when no mail provider is configured. Account
--    deletion removes it sooner.
--
-- 2. A password change is never rolled back by throttle-lock contention.
--    private.clear_password_signin_lock_after_password_change (the
--    auth.users trigger from 20261113114000) waits for the throttle's
--    advisory locks with no lock timeout of its own; the migration's
--    lock_timeout held only while the migration ran. A long wait could be
--    cancelled by the request's statement timeout, and QUERY_CANCELED is not
--    caught by WHEN OTHERS, so the account change itself rolled back (#8538
--    round 1, r1s1). The function now carries lock_timeout = 1s, so a held
--    lock raises lock_not_available inside its handler instead: the password
--    change commits, and the throttle row is left to expire with its window,
--    exactly as when the throttle cannot be read. The body is unchanged.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

create table private.account_notice_mail (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  notice text not null check (notice in ('recovery_code_used')),
  email text not null,
  lang text not null check (lang in ('en', 'es')),
  created_at timestamptz not null default pg_catalog.now(),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default pg_catalog.now(),
  request jsonb check (request is null or (pg_catalog.jsonb_typeof(request) = 'object'
    and pg_catalog.pg_column_size(request) <= 65536)),
  sent_at timestamptz
);
create index account_notice_mail_user_id_idx on private.account_notice_mail (user_id);
create index account_notice_mail_waiting_idx on private.account_notice_mail (next_attempt_at, created_at)
  where sent_at is null;
create index account_notice_mail_created_at_idx on private.account_notice_mail (created_at);
alter table private.account_notice_mail enable row level security;
revoke all on table private.account_notice_mail from public, anon, authenticated, service_role;
create trigger a00_case_graph_lock before insert or update or delete on private.account_notice_mail
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.account_notice_mail
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

comment on table private.account_notice_mail is
  'SEC-UG-ACCOUNT-RECOVERY-NOTICE-AND-RESET-LOCK-GAPS-20261117 (#9036): account-security emails owed to an account''s own address, written in the same transaction as the event (a used recovery code). Holds the account, the notice kind, the account address and language as they were when queued (so every try sends the identical message), and delivery state; no code, hash or device. Failed tries back off 5, 10, 20, 40 minutes, then hourly; tried for 23 hours; kept seven days from queueing, then deleted by the dispatcher sweep; removed with the account.';

create function public.claim_account_notice_mail(p_user_id uuid default null, p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  cap integer := greatest(0, least(coalesce(p_limit, 20), 50));
  claimed jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  -- Retention: every row, sent or not, is kept seven days from when it was
  -- queued; the dispatcher's sweep (no account given) then deletes it.
  if p_user_id is null then
    delete from private.account_notice_mail m
    where m.created_at < pg_catalog.now() - interval '7 days';
  end if;
  if cap = 0 then
    return '[]'::jsonb;
  end if;

  with candidates as (
    select m.id
    from private.account_notice_mail m
    where m.sent_at is null
      and m.created_at > pg_catalog.now() - interval '23 hours'
      and m.next_attempt_at <= pg_catalog.now()
      and (p_user_id is null or m.user_id = p_user_id)
    order by m.next_attempt_at, m.created_at, m.id
    limit cap
    for update skip locked
  ), leased as (
    update private.account_notice_mail m
    set attempts = m.attempts + 1,
        next_attempt_at = pg_catalog.now() + interval '2 minutes'
    from candidates c
    where m.id = c.id
    returning m.id, m.notice, m.attempts, m.email, m.lang, m.next_attempt_at, m.created_at
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', l.id,
      'notice', l.notice,
      'attempt', l.attempts,
      'email', l.email,
      'lang', l.lang)
    order by l.created_at, l.id), '[]'::jsonb)
  into claimed
  from leased l;
  return claimed;
end;
end;
$function$;

revoke all on function public.claim_account_notice_mail(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_account_notice_mail(uuid, integer) to service_role;
comment on function public.claim_account_notice_mail(uuid, integer) is
  '#9036: service-only. Leases waiting account-security emails for two minutes (one account''s, or every account''s when p_user_id is null) and returns each with its attempt and the address and language stored when it was queued. Soonest-due first. With p_limit 0 it claims nothing. The sweep call (p_user_id null) first deletes rows queued more than seven days ago.';

create function public.complete_account_notice_mail(p_id uuid, p_attempt integer, p_sent boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  changed integer := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_id is null or p_attempt is null or p_sent is null then
    return false;
  end if;

  update private.account_notice_mail m
  set sent_at = case when p_sent then pg_catalog.now() end,
      next_attempt_at = case when p_sent then m.next_attempt_at
        else pg_catalog.now() + least(interval '1 hour',
          interval '5 minutes' * (1 << least(greatest(m.attempts - 1, 0), 4))) end
  where m.id = p_id
    and m.attempts = p_attempt
    and m.sent_at is null;
  get diagnostics changed = row_count;
  return changed = 1;
end;
end;
$function$;

revoke all on function public.complete_account_notice_mail(uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.complete_account_notice_mail(uuid, integer, boolean) to service_role;
comment on function public.complete_account_notice_mail(uuid, integer, boolean) is
  '#9036: service-only. Marks a leased account-security email sent, or releases it for the next try, only while the row is still on the given attempt.';

create function public.prepare_account_notice_mail(p_id uuid, p_attempt integer, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  stored jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_id is null or p_attempt is null then
    return null;
  end if;

  -- Stored once: the first try's request is the one every try sends. It must
  -- be the five provider fields, addressed to the address stored at queueing.
  update private.account_notice_mail m
  set request = p_request
  where m.id = p_id
    and m.attempts = p_attempt
    and m.sent_at is null
    and m.request is null
    and pg_catalog.jsonb_typeof(p_request) = 'object'
    and (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(p_request) k)
      = array['from', 'html', 'subject', 'text', 'to']
    and p_request -> 'to' = pg_catalog.jsonb_build_array(m.email)
    and pg_catalog.pg_column_size(p_request) <= 65536;

  select m.request into stored
  from private.account_notice_mail m
  where m.id = p_id
    and m.attempts = p_attempt
    and m.sent_at is null;
  return stored;
end;
end;
$function$;

revoke all on function public.prepare_account_notice_mail(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.prepare_account_notice_mail(uuid, integer, jsonb) to service_role;
comment on function public.prepare_account_notice_mail(uuid, integer, jsonb) is
  '#9036: service-only. Stores the complete provider request on a leased account-security email once (the five provider fields, addressed to the stored address) and returns the stored request, so every try sends the identical message; null when the row is not on that attempt or nothing is stored.';

CREATE OR REPLACE FUNCTION public.finalize_mfa_recovery_code(p_user_id uuid, p_claim_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  clean_claim_token text := pg_catalog.btrim(coalesce(p_claim_token, ''));
  expected_claim_hash text;
  recovery_code_id uuid;
  changed integer := 0;
  released integer := 0;
  member_lang text;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or clean_claim_token !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  expected_claim_hash := pg_catalog.encode(
    extensions.digest(clean_claim_token, 'sha256'), 'hex');

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || p_user_id::text));

  select c.id into recovery_code_id
  from public.mfa_recovery_codes c
  where c.user_id = p_user_id
    and c.used_at is null
    and c.claim_expires_at > pg_catalog.now()
    and c.claim_token_hash = expected_claim_hash
  for update;
  if recovery_code_id is null or not exists (
    select 1
    from private.member_mfa_recovery_locks l
    where l.user_id = p_user_id
      and l.claim_token_hash = expected_claim_hash
  ) then
    return false;
  end if;

  update public.mfa_recovery_codes c
  set used_at = pg_catalog.now()
  where c.id = recovery_code_id
    and c.used_at is null;
  get diagnostics changed = row_count;
  if changed <> 1 then
    return false;
  end if;

  delete from private.member_mfa_recovery_locks l
  where l.user_id = p_user_id
    and l.claim_token_hash = expected_claim_hash;
  get diagnostics released = row_count;
  if released <> 1 then
    return false;
  end if;

  -- #8491: a used code leaves one audit row and one notice to the
  -- member. Neither carries the code, its hash, an address or a device.
  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (p_user_id, 'mfa_recovery_code_used', p_user_id, '{}'::jsonb);

  select coalesce(p.language, 'en') into member_lang
  from public.member_profiles p
  where p.id = p_user_id;
  if member_lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (p_user_id, 'Se usó un código de recuperación en tu cuenta',
      'Se usó uno de tus códigos de recuperación: se quitó la verificación en dos pasos de tu cuenta y se cerraron todas tus sesiones. Vuelve a configurarla desde Ajustes. Si no fuiste tú, cambia tu contraseña y contacta a tu oficina local de inmediato.',
      'general');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (p_user_id, 'A recovery code was used on your account',
      'One of your recovery codes was used: two-step sign-in was removed from your account and every session was signed out. Set it up again from Settings. If this was not you, change your password and contact your local office immediately.',
      'general');
  end if;

  -- #9036: the email to the account's own address is owed from the same
  -- commit, so a lost reply to this call cannot lose it. The address and
  -- language are fixed now, so every try sends the identical message.
  insert into private.account_notice_mail (user_id, notice, email, lang)
  select p_user_id, 'recovery_code_used', pg_catalog.btrim(coalesce(u.email, '')),
    case when member_lang = 'es' then 'es' else 'en' end
  from auth.users u
  where u.id = p_user_id;
  return true;
end;
end;
$function$;

alter function private.clear_password_signin_lock_after_password_change() set lock_timeout = '1s';

comment on function private.clear_password_signin_lock_after_password_change() is
  'BUG-UG-FAILED-SIGNIN-LOCK-SURVIVES-COMPLETED-RESET-20261112: after an account''s password changes, deletes only that address''s password-signin-email bucket and that account''s password-hook-account bucket in private.auth_attempt_throttle. Network buckets and other accounts are untouched. #9036: lock_timeout 1s, so a held throttle lock ends in the handler and the password change commits; that bucket then expires with its window.';

-- Account lifecycle: the rows are delivery state for the account's own
-- security email and go with the account.
insert into private.account_lifecycle_manifest(schema_name,table_name,user_column,delete_disposition,export_disposition,export_inventory_basis,exclusion_reason,note) values
 ('private','account_notice_mail','user_id','cascade','excluded_with_reason','auth_user_fk','Delivery state for an account-security email to the account''s own address, with that address and language as queued; no code.','Removed with the account; kept at most seven days.');

-- Reviewed trigger surface (account lifecycle inventory): the new table's
-- triggers and the redefined lock function.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.schema_name = 'private' and s.table_name = 'account_notice_mail')
   or (s.kind = 'function' and s.schema_name = 'private'
       and s.object_name = 'clear_password_signin_lock_after_password_change()')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_account_notice_mail_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the account notice mail table: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
end;
$assert_account_notice_mail_lifecycle$;

notify pgrst, 'reload schema';

commit;
