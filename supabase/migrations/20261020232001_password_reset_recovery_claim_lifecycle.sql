-- BUG-UG-RESET-REFUSES-RECOVERY-CODE-20261018.
-- Bind recovery before GoTrue's admin password update revokes its Auth session.
-- Preparation changes only the claim-bound lock. Push cleanup happens only
-- after password acceptance; definite rejection can release the unspent claim.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function public.prepare_password_reset_recovery(
  p_user_id uuid, p_session_handle text, p_claim_token text, p_cleanup boolean default false
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
declare
  claim_hash text := pg_catalog.encode(extensions.digest(p_claim_token, 'sha256'), 'hex');
  claim_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_session_handle is null or p_session_handle !~ '^[0-9a-f]{64}$'
     or p_claim_token is null or p_claim_token !~ '^[0-9a-f]{64}$' or p_cleanup is null then
    return pg_catalog.jsonb_build_object('prepared', false);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member-sessions:' || p_user_id::text));
  select c.id into claim_id from public.mfa_recovery_codes c
  where c.user_id = p_user_id and c.used_at is null and c.claim_expires_at > pg_catalog.now()
    and c.claim_session_handle = p_session_handle and c.claim_token_hash = claim_hash
  for update;
  if claim_id is null then return pg_catalog.jsonb_build_object('prepared', false); end if;

  if not p_cleanup then
    -- This proof must precede the admin password PUT; that PUT deletes sessions.
    perform 1 from auth.sessions s where s.user_id = p_user_id
      and private.member_session_handle(s.id) = p_session_handle for key share;
    if not found then return pg_catalog.jsonb_build_object('prepared', false); end if;
    insert into private.member_mfa_recovery_locks(user_id, claim_token_hash)
      values (p_user_id, claim_hash) on conflict (user_id) do nothing;
  end if;
  -- Neither another live claim nor a cleanup request may replace the owner.
  if not exists (select 1 from private.member_mfa_recovery_locks l
    where l.user_id = p_user_id and l.claim_token_hash = claim_hash) then
    return pg_catalog.jsonb_build_object('prepared', false);
  end if;

  if p_cleanup then
    -- The original session may now be gone. The installed lock proves that
    -- this exact live claim was prepared while its session still existed.
    insert into private.member_session_closing_barriers(user_id, session_handle, scope)
      select p_user_id, private.member_session_handle(s.id), 'global'
      from auth.sessions s where s.user_id = p_user_id
      on conflict (user_id, session_handle) do update set scope = 'global', closed_at = pg_catalog.now();
    delete from public.member_push_subscriptions where user_id = p_user_id;
    delete from public.member_native_push_installations where user_id = p_user_id;
  end if;
  return pg_catalog.jsonb_build_object('prepared', true, 'serverCleanupComplete', p_cleanup);
end;
end;
$function$;

create function public.cancel_password_reset_recovery(p_user_id uuid, p_session_handle text, p_claim_token text)
returns boolean language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
declare
  claim_hash text := pg_catalog.encode(extensions.digest(p_claim_token, 'sha256'), 'hex');
  claim_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_session_handle is null or p_session_handle !~ '^[0-9a-f]{64}$'
     or p_claim_token is null or p_claim_token !~ '^[0-9a-f]{64}$' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member-sessions:' || p_user_id::text));
  select c.id into claim_id from public.mfa_recovery_codes c
    where c.user_id = p_user_id and c.used_at is null
      and c.claim_session_handle = p_session_handle and c.claim_token_hash = claim_hash
    for update;
  if claim_id is null or exists (select 1 from private.member_mfa_recovery_locks l
    where l.user_id = p_user_id and l.claim_token_hash <> claim_hash) then return false; end if;
  -- Called only before a password update or after its definite rejection.
  -- A stale claim can never clear a newer lock or mark any code consumed.
  delete from private.member_mfa_recovery_locks l
    where l.user_id = p_user_id and l.claim_token_hash = claim_hash;
  update public.mfa_recovery_codes set claimed_at = null, claim_expires_at = null,
    claim_session_handle = null, claim_token_hash = null where id = claim_id;
  return true;
end;
end;
$function$;

revoke all on function public.prepare_password_reset_recovery(uuid,text,text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.cancel_password_reset_recovery(uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.prepare_password_reset_recovery(uuid,text,text,boolean) to service_role;
grant execute on function public.cancel_password_reset_recovery(uuid,text,text) to service_role;
comment on function public.prepare_password_reset_recovery(uuid,text,text,boolean) is
  'Service-only password reset: install the exact live-session claim lock before the admin password update; perform push cleanup only after acceptance, using that lock when the original Auth session is gone.';
comment on function public.cancel_password_reset_recovery(uuid,text,text) is
  'Service-only cancellation before password change or after definite rejection: release only the matching unspent recovery claim and its own lock. Never cancel after an ambiguous password update.';
notify pgrst, 'reload schema';
commit;
