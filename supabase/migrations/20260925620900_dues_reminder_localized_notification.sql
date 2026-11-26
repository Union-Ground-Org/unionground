-- I18N-UG-DISPATCH-DUES-REMINDER-ATTEMPT-WRITES-HARD-CODED-ENGLISH-DUES-20260921
--
-- public.dispatch_dues_reminder_attempt (20260831211500) rendered the member's
-- in-app dues reminder from two English literals. A member whose
-- member_profiles.language is 'es' therefore read English in the Activity feed
-- while the outbound email for the same notification was rendered in Spanish by
-- api/notifications-dispatch.js. That is exactly the gap the notify_member
-- helper comment (20260728221106) names: a string that was never in a catalogue
-- cannot be compared by the i18n parity test.
--
-- The repair puts the copy where every other typed notification keeps it --
-- private.notification_copy, one row per language -- and resolves it here with
-- the same rule private.notify_member uses: the recipient's language, falling
-- back to English, raising when the key is absent.
--
-- The insert itself stays in this function rather than moving to
-- private.notify_member: that helper returns void, and the dues delivery row
-- (public.dues_notification_deliveries.notification_id) and this RPC's
-- 'notificationId' result both need the id of the row that was just written.
-- The copy is no longer decided here; only the write is.
--
-- The copy pair keeps the shoulder-test rule of every other row in the
-- catalogue: no amount, no due date, no chapter -- only that an account update
-- is waiting in Dues.
--
-- Two properties of the deployed function are preserved deliberately:
--   * the case-graph transaction entry. 20260907151000 wrapped this definer in
--     an outer block whose first statement takes private.lock_case_graph, and
--     scripts/account-case-graph-inventory.mjs requires that gate of anything
--     writing a graph relation. Re-emitting the body without it would silently
--     drop the gate, so the call is written into the source here and every
--     declaration that had an initializer now assigns after it.
--   * the service_role-only reach: CREATE OR REPLACE keeps the existing ACL,
--     and the revoke/grant pair below restates it unchanged.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 20260907151000 wrapped the 20260831211500 body in the case-graph lock; that
-- wrapped body is the only one this repair may supersede.
do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.dispatch_dues_reminder_attempt(uuid, integer, integer, text, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'd66d88deb778b6433a28c642fb2a77ccf5095ae38525b4bfab74e648c6578e53' then
    raise exception 'unreviewed dispatch_dues_reminder_attempt predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

insert into private.notification_copy (key, lang, title, body) values
  ('dues.reminder', 'en', 'Account update',
   'An account update needs your attention. Open Dues to review it.'),
  ('dues.reminder', 'es', 'Novedad en tu cuenta',
   'Una novedad de tu cuenta requiere tu atención. Abre Cuotas para revisarla.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

create or replace function public.dispatch_dues_reminder_attempt(
  p_attempt_id uuid,
  p_expected_attempt_count integer,
  p_lease_epoch integer,
  p_outcome text,
  p_outbound_delivery_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt public.dues_reminder_attempts%rowtype;
  recipient uuid;
  notification uuid;
  delivery_state text;
  delivery_suffix text;
  copy_row private.notification_copy;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  delivery_state := p_outcome;
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome not in ('sent', 'deferred', 'failed', 'blocked')
     or p_outbound_delivery_key is not null then
    raise exception 'invalid dues reminder outcome' using errcode = '22023';
  end if;
  select * into attempt
  from public.dues_reminder_attempts row
  where row.id = p_attempt_id
  for update;
  if not found then
    raise exception 'dues reminder attempt not found' using errcode = '22023';
  end if;
  if attempt.state <> 'leased'
     or attempt.lease_epoch <> p_lease_epoch
     or attempt.attempt_count <> p_expected_attempt_count
     or attempt.lease_expires_at <= pg_catalog.now() then
    raise exception 'stale dues reminder lease' using errcode = '40001';
  end if;
  select subject.user_id into recipient
  from public.dues_obligations obligation
  join public.dues_member_subjects subject
    on subject.organization_id = obligation.organization_id
   and subject.id = obligation.member_subject_id
  where obligation.organization_id = attempt.organization_id
    and obligation.id = attempt.obligation_id;

  if p_outcome = 'sent' and recipient is not null then
    delivery_suffix := case when attempt.channel = 'email' then 'email' else 'in-app' end;
    insert into public.dues_notification_deliveries (
      organization_id, reminder_attempt_id, channel, delivery_key, state
    ) values (
      attempt.organization_id, attempt.id, attempt.channel,
      'dues-reminder:' || attempt.id::text || ':' || delivery_suffix,
      'queued'
    ) on conflict (organization_id, reminder_attempt_id, channel) do nothing;
    select delivery.notification_id into notification
    from public.dues_notification_deliveries delivery
    where delivery.organization_id = attempt.organization_id
      and delivery.reminder_attempt_id = attempt.id
      and delivery.channel = attempt.channel
    for update;
    if notification is null then
      select * into copy_row
      from private.notification_copy entry
      where entry.key = 'dues.reminder'
        and entry.lang = coalesce(
          (select profile.language from public.member_profiles profile
            where profile.id = recipient), 'en');
      if copy_row.key is null then
        select * into copy_row
        from private.notification_copy entry
        where entry.key = 'dues.reminder' and entry.lang = 'en';
      end if;
      if copy_row.key is null then
        raise exception 'unknown notification copy key: dues.reminder';
      end if;
      insert into public.member_notifications (user_id, title, body, kind)
      values (
        recipient,
        copy_row.title,
        copy_row.body,
        'dues'
      ) returning id into notification;
      update public.dues_notification_deliveries
      set notification_id = notification,
          state = 'sent',
          updated_at = pg_catalog.now()
      where organization_id = attempt.organization_id
        and reminder_attempt_id = attempt.id
        and channel = attempt.channel;
    end if;
  elsif p_outcome = 'sent' then
    delivery_state := 'blocked';
  end if;
  update public.dues_reminder_attempts
  set state = delivery_state,
      lease_owner = null,
      lease_expires_at = null,
      outcome_code = delivery_state,
      updated_at = pg_catalog.now()
  where id = attempt.id;
  return pg_catalog.jsonb_build_object(
    'id', attempt.id,
    'state', delivery_state,
    'notificationId', notification
  );
end;
$function$;

revoke all on function public.dispatch_dues_reminder_attempt(
  uuid, integer, integer, text, text
) from public, anon, authenticated;
grant execute on function public.dispatch_dues_reminder_attempt(
  uuid, integer, integer, text, text
) to service_role;

comment on function public.dispatch_dues_reminder_attempt(uuid, integer, integer, text, text) is
  'Service-role dues reminder outcome writer: renders the member''s in-app reminder from the private.notification_copy dues.reminder pair in the recipient''s language, falling back to English, and returns the notification id the delivery row records.';

notify pgrst, 'reload schema';

commit;
