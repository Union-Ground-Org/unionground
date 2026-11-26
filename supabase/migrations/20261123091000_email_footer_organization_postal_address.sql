-- BUG-UG-LOCAL-PROFILE-IS-READ-BY-NOTHING-AND-EVERY-UNION-SHARES-ONE-FOOTER-ADDRESS-20261122 (#9507).
-- Email footers printed one deployment-wide postal address (ORG_POSTAL_ADDRESS)
-- for every organization. Each organization's own office address is stored in
-- private.organization_local_profiles.office_address, which no sender could
-- read. This restates two service-role functions with one added key each:
--
-- 1. public.claim_notification_deliveries returns 'postalAddress' for an
--    email row: the office address of member_notifications.organization_id
--    (the tenant that produced the notice), or null when the notice has no
--    organization or the organization has no address on file. Push rows get
--    null. Nothing else changes: signature, SECURITY DEFINER, empty
--    search_path, the case-graph wrapper, the focus filter, the lease, the
--    returned keys and EXECUTE (service_role only, kept by CREATE OR REPLACE).
-- 2. public.get_engagement_delivery_payload returns 'postalAddress' for an
--    available message: the office address of the delivery row's
--    organization, or null. Every refusal and suppression is unchanged.
--
-- api/notifications-dispatch.js and api/engagement-email-bridge.js print a
-- present key's value (null or empty: no address line) and fall back to the
-- deployment value only when the key is absent, so mail keeps its line between
-- the code's merge and this apply. The address is the organization's own
-- mailing address, entered by its administrators on the setup card for this
-- purpose; it goes only into that organization's own mail.
--
-- The preflight refuses to run unless both functions are exactly the reviewed
-- installed bodies (20261118200500 and 20261102005607) and the payload's
-- account-lifecycle receipt is current.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- pg_get_functiondef qualifies types the same way under this path as under an
-- empty one (pg_catalog is always searched), so the definition hash is stable.
set local search_path = pg_catalog;

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.claim_notification_deliveries(text, integer)'::regprocedure)) <> 'a1fef4bf19da1c9e846d70d39526bfa0' then
    raise exception 'unreviewed predecessor: public.claim_notification_deliveries' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_engagement_delivery_payload(uuid, uuid)'::regprocedure)) <> '53cb510a994d1835f61b440ad5dd46a3' then
    raise exception 'unreviewed predecessor: public.get_engagement_delivery_payload' using errcode = '55000';
  end if;
  if exists (
    select 1 from private.account_lifecycle_trigger_review
    where kind = 'function' and schema_name in ('public') and table_name = ''
      and object_name in ('claim_notification_deliveries(p_channel text, p_limit integer)',
                          'get_engagement_delivery_payload(p_delivery_id uuid, p_lease_token uuid)')
      and definition_hash not in ('a1fef4bf19da1c9e846d70d39526bfa0', '53cb510a994d1835f61b440ad5dd46a3')
  ) then
    raise exception 'stale trigger receipt: claim_notification_deliveries or get_engagement_delivery_payload' using errcode = '55000';
  end if;
end;
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. The notification claim.
CREATE OR REPLACE FUNCTION public.claim_notification_deliveries(p_channel text, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    where d.channel = p_channel and (d.attempts < 6 or (d.channel = 'email' and d.created_at >= pg_catalog.now() - interval '23 hours'))
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
    'source', case when n.peer_conversation_id is not null then 'peer' end,
    -- #9507: the producing organization's own office address for the email
    -- footer; null when the notice has no organization or none is on file.
    'postalAddress', case when p_channel = 'email' then (
      select lp.office_address from private.organization_local_profiles lp
      where lp.organization_id = n.organization_id) end,
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
$function$;


-- ---------------------------------------------------------------------------
-- 2. The engagement payload.
CREATE OR REPLACE FUNCTION public.get_engagement_delivery_payload(p_delivery_id uuid, p_lease_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  row public.engagement_delivery_outbox%rowtype;
  email text;
  title text;
  body text;
  action_path text;
  category text;
  unsubscribe_token text;
begin
  select * into row from public.engagement_delivery_outbox
  where id = p_delivery_id and state = 'leased' and lease_token = p_lease_token
    and lease_expires_at >= pg_catalog.now();
  if not found then raise exception 'delivery lease not found' using errcode = 'P0002'; end if;
  -- The member may have opted out after this row was queued.
  if private.engagement_email_opted_out(row.recipient_user_id, row.delivery_kind) then
    return pg_catalog.jsonb_build_object('available', false, 'suppressed', true, 'reason', 'recipient_opted_out');
  end if;
  -- The newest Main contract rechecks active membership and the current
  -- broadcast or survey audience at send time. Revoked rows are terminally
  -- suppressed by complete_engagement_delivery.
  if not private.engagement_delivery_recipient_eligible(
    row.organization_id, row.recipient_user_id, row.source_kind, row.source_id
  ) then
    return pg_catalog.jsonb_build_object('available', false, 'suppressed', true, 'reason', 'recipient_access_revoked');
  end if;
  category := private.engagement_email_category(row.delivery_kind);
  unsubscribe_token := private.engagement_email_unsubscribe_token(row.recipient_user_id, category);
  select user_row.email into email from auth.users user_row where user_row.id = row.recipient_user_id;
  if row.source_kind = 'broadcast' then
    select broadcast.title, broadcast.body, '/m/messages?broadcast=' || row.source_id into title, body, action_path
    from public.member_broadcasts broadcast where broadcast.id = row.source_id
      and broadcast.organization_id = row.organization_id and broadcast.retracted_at is null
      and ((broadcast.access_unit_id is null and broadcast.access_committee_id is null) or private.member_scoped_notice_in_audience(row.recipient_user_id,broadcast));
  elsif row.source_kind = 'survey' then
    select survey.title, case row.delivery_kind when 'survey_reminder'
      then 'A survey is still waiting for your response in Union Ground.'
      else 'A survey is ready for you in Union Ground.' end,
      '/m/voice?survey=' || row.source_id into title, body, action_path
    from public.organization_surveys survey where survey.id = row.source_id::uuid
      and survey.organization_id = row.organization_id and survey.status = 'open'
      -- An email queued before the close time is not sent after it.
      and (survey.closes_at is null or survey.closes_at > pg_catalog.now());
  elsif row.source_kind = 'first_signin_welcome' then
    -- Restored first-sign-in welcome (20261003031000): sent only while the
    -- member still belongs to the organization.
    select row.subject_snapshot, row.body_snapshot, row.action_path_snapshot into title, body, action_path
    from public.organization_memberships membership
    where membership.organization_id = row.organization_id
      and membership.user_id = row.recipient_user_id
      and membership.status = 'active' and membership.revoked_at is null;
  else
    select row.subject_snapshot, row.body_snapshot, row.action_path_snapshot into title, body, action_path
    from public.member_welcome_enrollments enrollment
    join public.organization_memberships membership
      on membership.organization_id = enrollment.organization_id
      and membership.user_id = enrollment.member_user_id
    where enrollment.id = pg_catalog.split_part(row.source_id, ':', 1)::uuid
      and enrollment.organization_id = row.organization_id and enrollment.member_user_id = row.recipient_user_id
      and enrollment.state in ('active','completed')
      and membership.status = 'active' and membership.revoked_at is null;
  end if;
  if email is null or title is null or unsubscribe_token is null then
    return pg_catalog.jsonb_build_object('available', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'available', true, 'email', email, 'locale', row.locale,
    'subject', title, 'body', body, 'path', action_path,
    'category', category, 'transactional', false,
    'unsubscribeToken', unsubscribe_token,
    -- #9507: the sending organization's own office address for the footer;
    -- null when it has none on file.
    'postalAddress', (select lp.office_address from private.organization_local_profiles lp
      where lp.organization_id = row.organization_id)
  );
end;
$function$;


-- Grants are unchanged by create or replace. A function the account-lifecycle
-- trigger surface reaches keeps a current receipt; absent receipts stay absent.
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
  from pg_catalog.pg_proc p
 where reviewed.kind = 'function' and reviewed.table_name = ''
   and p.oid in ('public.claim_notification_deliveries(text, integer)'::regprocedure,
                 'public.get_engagement_delivery_payload(uuid, uuid)'::regprocedure)
   and reviewed.schema_name = p.pronamespace::regnamespace::text
   and reviewed.object_name = p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')';

notify pgrst, 'reload schema';

commit;
