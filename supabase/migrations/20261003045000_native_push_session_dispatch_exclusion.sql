-- BUG-UG-MOBILE-AUTO-SIGNOUT-LEAVES-ACCOUNT-DATA-20261002
-- Owner October 2, 2026 11:22:18 PM ET, thread c2820a69; dispatch-time
-- exclusion/reauthorization source and tests only. Hosted application separate.
-- This performs no deletion, session mutation, signup or key-policy activation.
-- Hosted Auth on both targets has no timebox or inactivity limit (0/0).
-- The private singleton defaults to no limits. If Auth limits are configured,
-- an authorized operator must keep these seconds values equal to Auth; never
-- invent a stricter delivery timeout from local supabase/config.toml.

begin;

alter table private.notification_controls
  add column native_sessions_timebox_seconds integer not null default 0
    check (native_sessions_timebox_seconds >= 0),
  add column native_sessions_inactivity_seconds integer not null default 0
    check (native_sessions_inactivity_seconds >= 0);
-- Existing private singleton and ACLs: no API role can read or write settings.

create function private.native_push_session_eligible(p_user uuid, p_handle text)
returns boolean language sql stable set search_path = ''
as $function$
  select exists (
    select 1 from auth.sessions session join auth.users member on member.id=session.user_id
    cross join private.notification_controls limits
    left join private.member_mfa_reset_boundaries boundary on boundary.user_id=member.id
    where limits.id and session.user_id=p_user and private.member_session_handle(session.id)=p_handle
      and (session.not_after is null or session.not_after > pg_catalog.statement_timestamp())
      and (limits.native_sessions_timebox_seconds = 0 or session.created_at
        > pg_catalog.statement_timestamp() - limits.native_sessions_timebox_seconds * interval '1 second')
      and (limits.native_sessions_inactivity_seconds = 0 or
        coalesce(session.refreshed_at at time zone 'UTC',session.created_at)
        > pg_catalog.statement_timestamp() - limits.native_sessions_inactivity_seconds * interval '1 second')
      and member.deleted_at is null
      and coalesce(member.banned_until,'-infinity'::timestamptz) < pg_catalog.statement_timestamp()
      and session.created_at > coalesce(boundary.invalid_before,'-infinity'::timestamptz)
      and not exists(select 1 from private.member_mfa_recovery_locks recovery where recovery.user_id=member.id)
      and not exists(select 1 from private.member_session_revocations revoked
        where revoked.user_id=member.id and revoked.session_handle=p_handle)
  );
$function$;
revoke all on function private.native_push_session_eligible(uuid,text) from public,anon,authenticated,service_role;

create or replace function public.claim_notification_deliveries(p_channel text, p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Preserve the installed case-graph wrapper before any defaults or row locks.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  cap integer := greatest(1, least(coalesce(p_limit, 200), 500));
  max_subscriptions constant integer := 10;
  max_native_installations constant integer := 10;
  outbound_on boolean;
  claimed jsonb;
begin
  if p_channel is null or p_channel not in ('email', 'push', 'sms') then
    raise exception 'unknown channel' using errcode = '22023';
  end if;
  select c.outbound_enabled into outbound_on from private.notification_controls c where c.id;
  if not coalesce(outbound_on, false) then return '[]'::jsonb; end if;

  with candidates as (
    select d.id from public.member_notification_deliveries d
    join public.member_notifications n on n.id = d.notification_id
    where d.channel = p_channel and d.attempts < 6
      and d.created_at >= pg_catalog.now() - interval '48 hours'
      and ((d.status = 'pending' and d.next_attempt_at <= pg_catalog.now())
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes'))
      and ((n.kind = 'workload' and n.workload_event = 'receipt')
        or not private.member_focus_blocks(d.user_id, n.kind))
    order by d.next_attempt_at limit cap for update of d skip locked
  ), flipped as (
    update public.member_notification_deliveries d set
      status = 'sending', attempts = d.attempts + 1,
      delivery_lease_epoch = d.delivery_lease_epoch + 1,
      updated_at = pg_catalog.now()
    from candidates c where d.id = c.id
    returning d.id, d.notification_id, d.user_id, d.attempts, d.delivery_lease_epoch
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'deliveryId', f.id, 'kind', n.kind, 'lang', coalesce(pr.language, 'en'),
    'attempt', f.attempts,
    'leaseEpoch', f.delivery_lease_epoch,
    'event', n.workload_event,
    'receiptCode', n.workload_receipt_code,
    'email', case when p_channel = 'email' then u.email end,
    'subscriptions', case when p_channel = 'push' then (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth_key,
        'targetKey', s.target_key))
      from (select s2.endpoint, s2.p256dh, s2.auth_key,
          'web:' || pg_catalog.encode(extensions.digest(s2.endpoint, 'sha256'), 'hex') as target_key
        from public.member_push_subscriptions s2 where s2.user_id = f.user_id
          and not exists (
            select 1 from private.member_notification_push_target_receipts r
            where r.delivery_id = f.id
              and r.target_key = 'web:' || pg_catalog.encode(extensions.digest(s2.endpoint, 'sha256'), 'hex')
          )
        order by s2.last_seen_at desc limit max_subscriptions) s
    ) end,
    'nativeInstallations', case when p_channel = 'push' then (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'installationId', i.installation_id,
        'provider', i.provider,
        'environment', i.environment,
        'token', i.device_token,
        'tokenHash', i.token_hash,
        'sessionHandle', i.session_handle,
        'targetKey', i.target_key))
      from (select i2.installation_id, i2.provider, i2.environment, i2.device_token, i2.token_hash, i2.session_handle,
          'native:' || i2.installation_id::text as target_key
        from public.member_native_push_installations i2 where i2.user_id = f.user_id
          and private.native_push_session_eligible(i2.user_id, i2.session_handle)
          and not exists (
            select 1 from private.member_notification_push_target_receipts r
            where r.delivery_id = f.id
              and r.target_key = 'native:' || i2.installation_id::text
          )
        order by i2.last_seen_at desc limit max_native_installations) i
    ) end)), '[]'::jsonb)
  into claimed from flipped f
  join public.member_notifications n on n.id = f.notification_id
  left join public.member_profiles pr on pr.id = f.user_id
  left join auth.users u on u.id = f.user_id;
  return claimed;
end;
end;
$$;

revoke all on function public.claim_notification_deliveries(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_notification_deliveries(text, integer)
  to service_role;

create function public.authorize_native_push_dispatch(
  p_delivery_id uuid, p_attempt integer, p_lease_epoch bigint,
  p_installation_id uuid, p_provider text, p_environment text,
  p_token_hash text, p_session_handle text
) returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1 from public.member_notification_deliveries delivery
    join public.member_notifications notification on notification.id=delivery.notification_id
      and notification.user_id=delivery.user_id
    join public.member_native_push_installations installation on installation.user_id=delivery.user_id
    join private.notification_controls controls on controls.id and controls.outbound_enabled
    where delivery.id=p_delivery_id and delivery.channel='push' and delivery.status='sending'
      and delivery.attempts=p_attempt and delivery.delivery_lease_epoch=p_lease_epoch
      and delivery.updated_at > pg_catalog.statement_timestamp() - interval '15 minutes'
      and delivery.created_at >= pg_catalog.statement_timestamp() - interval '48 hours'
      and installation.installation_id=p_installation_id and installation.provider=p_provider
      and installation.environment=p_environment and installation.token_hash=p_token_hash
      and installation.session_handle=p_session_handle
      and private.native_push_session_eligible(installation.user_id,installation.session_handle)
      and ((notification.kind='workload' and notification.workload_event='receipt')
        or not private.member_focus_blocks(delivery.user_id,notification.kind))
      and not exists(select 1 from private.member_notification_push_target_receipts receipt
        where receipt.delivery_id=delivery.id and receipt.target_key='native:' || installation.installation_id::text)
  );
$function$;
revoke all on function public.authorize_native_push_dispatch(uuid,integer,bigint,uuid,text,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.authorize_native_push_dispatch(uuid,integer,bigint,uuid,text,text,text,text) to service_role;

commit;
