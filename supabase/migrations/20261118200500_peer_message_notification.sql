-- BUG-UG-PRIVATE-TWO-PERSON-MESSAGES-SEND-NO-NOTIFICATION-20261118 (#9173)
--
-- A private two-person message (public.member_peer_messages) created no
-- notification: the table's only triggers were the case-graph locks and the
-- learning journal, and public.send_reward_peer_message, the one writer,
-- inserts the message and nothing else. public.start_officer_conversation,
-- public.send_cross_chapter_peer_message and the connected-workflow send
-- (private.automation_v2_execute) all reach the table through that function.
-- So an officer whose member wrote to them, or a member whose officer
-- answered, learned of it only by opening Messages.
--
-- Now every two-person message writes one public.member_notifications row of
-- kind 'messages' for the other participant and none for the sender.
--
-- Mechanism: an AFTER INSERT row trigger on public.member_peer_messages, the
-- shape the existing 'messages' notifications already use
-- (chapter_thread_posts_channel_alerts -> private.chapter_post_alerts_after_insert,
-- 20261003034000): the notice is written in the same transaction as the
-- message, inside an exception fence, so notification plumbing can never
-- refuse or roll back a member's message. A trigger rather than a change to
-- public.send_reward_peer_message because (1) it is how the existing message
-- notices are produced, (2) it covers every path that writes the table,
-- including ones added later, without restating the send function, and
-- (3) a row trigger fires exactly once per message row, so a retried send
-- (which writes a second message) gets its own notice and a rolled-back send
-- leaves none.
--
-- The row:
--   * user_id: the participant who is not new.sender_id, read from the
--     conversation; nothing is written when the sender is not one of its two
--     participants (no writer can do that today; the guard keeps it so).
--   * kind 'messages', so the member's existing "messages" topic switch, the
--     hour/day/weekly caps, the outbound switch, the stress-ledger egress
--     guard and quiet hours / Do not disturb (at claim time) apply through
--     private.enqueue_notification_deliveries and
--     public.claim_notification_deliveries exactly as for the channel
--     notices. As for those, the topic switch governs email and push; the
--     in-app row is always written.
--   * title and body from private.notification_copy key 'peer.message' in
--     the recipient's language: fixed text, no message text, no name, no
--     chapter. copy_key = 'peer.message'.
--   * peer_conversation_id (new nullable column): the conversation, so the
--     website and the phone apps open it from the notice. The recipient is a
--     participant and already lists that conversation. ON DELETE CASCADE:
--     when the conversation goes (a participant's account is deleted), its
--     notices go with it rather than pointing at nothing. A check keeps the
--     column to kind 'messages'. authenticated may SELECT it (the app reads
--     notifications with select *); it gains no UPDATE.
--   * source_chapter_id stays NULL: the sender's selected chapter is not
--     disclosed to the recipient (private.notify_member would have written
--     it, which is why the trigger inserts the row itself with notify_member's
--     copy resolution rather than calling it).
--   * organization_id: the organization of the conversation's chapter, the
--     tenant that produced the row (20261003050000: "Retention belongs to the
--     tenant that produced a row, never a member's later selected chapter";
--     private.stamp_retention_member_scope leaves notification producers to
--     supply it). So the organization's member_notifications retention
--     purges these notices and, by cascade, their deliveries. NULL when the
--     chapter has no organization: such a row stays outside organization
--     purges, as every unstamped notice does. A participant who later moved
--     to another organization still gets the conversation's organization:
--     the notice belongs where the conversation was made. RLS stays
--     user_id-only and the claim never returns the column.
--
-- Email and push: api/notifications-dispatch.js picks its copy by kind, and
-- the 'messages' template speaks of a chapter channel mention. The claim now
-- returns 'source' = 'peer' for a row with a peer_conversation_id, and the
-- dispatcher sends such a row the existing generic text ("Something needs
-- your attention" / "Open Union Ground to see what's new.") on both email
-- and push. public.claim_notification_deliveries is restated from its live
-- definition with only that one key added; signature, SECURITY DEFINER,
-- empty search_path, the case-graph wrapper, the focus/quiet-hours filter,
-- the lease and EXECUTE (service_role only, kept by CREATE OR REPLACE) are
-- unchanged, and it still never returns n.title or n.body.
--
-- A predecessor guard refuses to run unless the live claim definition is the
-- reviewed one. The new trigger and trigger function are recorded in the
-- account lifecycle trigger review, and the lifecycle inventories are
-- asserted complete afterwards.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

do $predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.claim_notification_deliveries(text, integer)'))) is distinct from '3db7070d2d24709325daae3e25a7ca1b' then
    raise exception 'unreviewed predecessor: public.claim_notification_deliveries' using errcode = '55000';
  end if;
  if pg_catalog.to_regprocedure('private.peer_message_notify_after_insert()') is not null then
    raise exception 'peer message notification trigger function already exists' using errcode = '55000';
  end if;
end;
$predecessor$;

-- ---------------------------------------------------------------------------
-- 1. Where a notice came from.
alter table public.member_notifications
  add column peer_conversation_id uuid
    references public.member_peer_conversations(id) on delete cascade,
  add constraint member_notifications_peer_conversation_kind
    check (peer_conversation_id is null or kind = 'messages');

create index member_notifications_peer_conversation_idx
  on public.member_notifications (peer_conversation_id)
  where peer_conversation_id is not null;

comment on column public.member_notifications.peer_conversation_id is
  'The two-person conversation (public.member_peer_conversations) a peer.message notice announces; NULL for every other notice. Lets the app open that conversation. Deleted with the conversation.';

grant select (peer_conversation_id) on public.member_notifications to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The notice text: fixed, no message text, no name.
insert into private.notification_copy (key, lang, title, body) values
  ('peer.message', 'en', 'New private message', 'Someone wrote to you in a private conversation. Open Messages to read it.'),
  ('peer.message', 'es', 'Nuevo mensaje privado', 'Alguien te escribió en una conversación privada. Abre Mensajes para leerlo.');

-- ---------------------------------------------------------------------------
-- 3. The trigger. Exception-fenced like private.chapter_post_alerts_after_insert:
-- notification plumbing must never refuse a member's message.
create function private.peer_message_notify_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  recipient uuid;
  source_org uuid;
  recipient_lang text;
  copy_row private.notification_copy;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  begin
    select case
        when c.user_low = new.sender_id then c.user_high
        when c.user_high = new.sender_id then c.user_low
      end,
      ch.organization_id
      into recipient, source_org
    from public.member_peer_conversations c
    left join public.chapters ch on ch.id = c.chapter_id
    where c.id = new.conversation_id;
    if recipient is null or recipient = new.sender_id then
      return new;
    end if;

    select coalesce(p.language, 'en') into recipient_lang
    from public.member_profiles p where p.id = recipient;
    select * into copy_row
    from private.notification_copy c
    where c.key = 'peer.message' and c.lang = coalesce(recipient_lang, 'en');
    if copy_row.key is null then
      select * into copy_row
      from private.notification_copy c
      where c.key = 'peer.message' and c.lang = 'en';
    end if;

    insert into public.member_notifications (user_id, title, body, kind, copy_key, peer_conversation_id, organization_id)
    values (recipient, copy_row.title, copy_row.body, 'messages', 'peer.message', new.conversation_id, source_org);
  exception
    when query_canceled then
      raise warning 'peer message notice cancelled for message %', new.id;
    when others then
      raise warning 'peer message notice failed for message %: % (%)', new.id, sqlerrm, sqlstate;
  end;
  return new;
end;
$function$;

revoke all on function private.peer_message_notify_after_insert() from public, anon, authenticated, service_role;

create trigger member_peer_messages_notify_recipient
after insert on public.member_peer_messages
for each row execute function private.peer_message_notify_after_insert();

-- ---------------------------------------------------------------------------
-- 4. The claim tells the dispatcher a row is a peer message notice, so it is
-- sent the generic text, never the channel-mention text.
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
-- 5. Account lifecycle: the reviewed trigger surface gains the new trigger
-- and its function; nothing else changes.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'public' and table_name = 'member_peer_messages'
        and object_name = 'member_peer_messages_notify_recipient')
   or (kind = 'function' and schema_name = 'private' and table_name = ''
        and object_name = 'peer_message_notify_after_insert()')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_peer_message_notification_lifecycle$
begin
  if (select pg_catalog.count(*) from private.account_lifecycle_trigger_review
      where (kind = 'trigger' and schema_name = 'public' and table_name = 'member_peer_messages'
             and object_name = 'member_peer_messages_notify_recipient')
         or (kind = 'function' and schema_name = 'private' and table_name = ''
             and object_name = 'peer_message_notify_after_insert()')) <> 2 then
    raise exception 'peer message notification trigger review is incomplete';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after peer message notifications: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after peer message notifications';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after peer message notifications';
  end if;
end;
$assert_peer_message_notification_lifecycle$;

notify pgrst, 'reload schema';

commit;
