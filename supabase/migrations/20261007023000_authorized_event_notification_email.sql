-- Event title, date and change may reach authorized
-- email recipients. Other email and every push retain their generic copy.
-- No source is guessed for historical notifications.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.member_notification_event_sources (
  notification_id uuid primary key references public.member_notifications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_event_id text not null check (source_event_id ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  source_event_chapter_id text not null,
  source_event_organization_id uuid not null,
  source_event_created_at timestamptz not null,
  source_event_change text not null check (source_event_change in ('created', 'rescheduled', 'cancelled', 'restored', 'reminder')),
  email_projection jsonb check (email_projection is null or pg_catalog.jsonb_typeof(email_projection) = 'object')
);
create index member_notification_event_sources_user_idx on private.member_notification_event_sources(user_id);
revoke all on private.member_notification_event_sources from public, anon, authenticated, service_role;

create trigger a00_case_graph_lock before insert or update or delete on private.member_notification_event_sources
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_notification_event_sources
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, exclusion_reason, note, reviewed_at)
values ('private', 'member_notification_event_sources', 'user_id', 'cascade', 'excluded_with_reason',
  null, 'auth_user_fk', 'Internal notification delivery provenance and minimal authorized retry copy; not an independent member document.',
  'Deleted with the notification or account. Client roles cannot read or alter event email provenance.', date '2026-10-06');

-- Only the two new triggers are reviewed here. Their existing graph-lock
-- functions are unchanged; no other review entry is refreshed.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private' and table_name = 'member_notification_event_sources'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

create function private.notify_member_event(p_user_id uuid, p_event_id text, p_change text)
returns void language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  ev public.member_events%rowtype;
  notification_id uuid;
  organization_id uuid;
  recipient_lang text;
  copy_row private.notification_copy%rowtype;
begin
  if p_user_id is null or p_change is null
    or p_change not in ('created', 'rescheduled', 'cancelled', 'restored', 'reminder') then return; end if;
  select * into ev from public.member_events where id = p_event_id;
  if not found or not private.member_can_access_event_scope_for_user(
      p_user_id, ev.chapter_id, ev.is_public, ev.is_public_across_agencies)
    or exists (select 1 from private.member_stress_ledger where user_id = p_user_id)
    then return; end if;
  select chapter.organization_id into organization_id from public.chapters chapter where chapter.id = ev.chapter_id;
  if organization_id is null then return; end if;
  select case when profile.language = 'es' then 'es' else 'en' end into recipient_lang
    from public.member_profiles profile where profile.id = p_user_id;
  select * into copy_row from private.notification_copy
    where key = 'event.' || p_change and lang = recipient_lang;
  if not found then
    select * into copy_row from private.notification_copy where key = 'event.' || p_change and lang = 'en';
  end if;
  if not found then raise exception 'event notification copy unavailable' using errcode = '55000'; end if;
  -- Same generic in-app copy, stress guard and enqueue trigger as notify_member.
  -- The notification and its private provenance commit together. No public
  -- notification columns or client/realtime projection change.
  insert into public.member_notifications (user_id, title, body, kind, copy_key, source_chapter_id)
  values (p_user_id, copy_row.title, copy_row.body, 'events', copy_row.key, private.current_member_chapter())
  returning id into notification_id;
  insert into private.member_notification_event_sources (notification_id, user_id,
    source_event_id, source_event_chapter_id, source_event_organization_id, source_event_created_at, source_event_change)
  values (notification_id, p_user_id, ev.id, ev.chapter_id, organization_id, ev.created_at, p_change);
end;
end;
$function$;
revoke all on function private.notify_member_event(uuid, text, text) from public, anon, authenticated, service_role;

create function public.get_event_notification_email(p_delivery_id uuid, p_attempt integer, p_lease_epoch bigint, p_email text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  notice public.member_notifications%rowtype;
  source private.member_notification_event_sources%rowtype;
  ev public.member_events%rowtype;
  recipient_lang text;
  recipient_zone text;
  binding jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  -- Follow the canonical graph-before-row lock order for the private snapshot
  -- update. This also serializes its first presentation with account deletion.
  perform private.lock_case_graph(array[(select user_id from public.member_notification_deliveries
    where id = p_delivery_id)], array[]::uuid[]);
  select notification.* into notice
    from public.member_notification_deliveries delivery
    join public.member_notifications notification on notification.id = delivery.notification_id
      and notification.user_id = delivery.user_id and notification.kind = 'events'
    join public.member_profiles profile on profile.id = delivery.user_id
    join auth.users recipient on recipient.id = delivery.user_id
    join private.notification_controls controls on controls.id and controls.outbound_enabled
    where delivery.id = p_delivery_id and delivery.channel = 'email' and delivery.status = 'sending'
      and p_attempt > 0 and delivery.attempts = p_attempt
      and p_lease_epoch > 0 and delivery.delivery_lease_epoch = p_lease_epoch
      and delivery.updated_at > pg_catalog.statement_timestamp() - interval '15 minutes'
      and delivery.created_at >= pg_catalog.statement_timestamp() - interval '48 hours'
      and recipient.email = p_email and recipient.email_confirmed_at is not null
      and recipient.deleted_at is null
      and (recipient.banned_until is null or recipient.banned_until <= pg_catalog.statement_timestamp())
      and (profile.notification_prefs -> 'events') is distinct from 'false'::jsonb
      and not private.member_focus_blocks(delivery.user_id, 'events');
  if not found then return pg_catalog.jsonb_build_object('status', 'refused'); end if;
  select case when profile.language = 'es' then 'es' else 'en' end, profile.quiet_hours_timezone
    into recipient_lang, recipient_zone
    from public.member_profiles profile where profile.id = notice.user_id;
  binding := pg_catalog.jsonb_build_object('deliveryId', p_delivery_id, 'attempt', p_attempt,
    'leaseEpoch', p_lease_epoch, 'email', p_email, 'lang', recipient_lang);
  select * into source from private.member_notification_event_sources
    where notification_id = notice.id for update;
  if not found then
    return binding || pg_catalog.jsonb_build_object('status', 'generic');
  end if;
  if source.user_id is distinct from notice.user_id
    or notice.copy_key is distinct from 'event.' || source.source_event_change then
    return pg_catalog.jsonb_build_object('status', 'refused');
  end if;
  select event.* into ev from public.member_events event
    join public.chapters chapter on chapter.id = event.chapter_id
    where event.id = source.source_event_id
      and event.created_at = source.source_event_created_at
      and event.chapter_id = source.source_event_chapter_id
      and chapter.organization_id = source.source_event_organization_id
      and private.member_can_access_event_scope_for_user(notice.user_id,
        event.chapter_id, event.is_public, event.is_public_across_agencies)
      and pg_catalog.isfinite(event.starts_at)
      and pg_catalog.char_length(event.title) between 3 and 120
      and event.title !~ '[[:cntrl:]]'
      -- Do not send a superseded cancellation or a live-event notice after cancellation.
      and (event.cancelled_at is not null) = (source.source_event_change = 'cancelled');
  if not found then return pg_catalog.jsonb_build_object('status', 'refused'); end if;
  -- Freeze the first authorized presentation, not live event or preference
  -- values on every retry. The delivery-only provider key must keep its copy
  -- even after an ambiguous acceptance followed by a title/date/locale edit.
  -- Every earlier access, lease, account and cancellation check still runs.
  if source.email_projection is null then
    if recipient_zone is null or not exists (select 1 from pg_catalog.pg_timezone_names
      where name = recipient_zone) then
      return pg_catalog.jsonb_build_object('status', 'refused');
    end if;
    source.email_projection := pg_catalog.jsonb_build_object('title', ev.title,
      'startsAt', ev.starts_at, 'change', source.source_event_change,
      'lang', recipient_lang, 'timeZone', recipient_zone, 'email', p_email);
    update private.member_notification_event_sources set email_projection = source.email_projection
      where notification_id = notice.id and email_projection is null;
  end if;
  -- A newly confirmed address must not reuse another address's provider key.
  if source.email_projection ->> 'email' is distinct from p_email then
    return pg_catalog.jsonb_build_object('status', 'refused');
  end if;
  return binding || source.email_projection || pg_catalog.jsonb_build_object('status', 'authorized');
end;
end;
$function$;
revoke all on function public.get_event_notification_email(uuid, integer, bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.get_event_notification_email(uuid, integer, bigint, text) to service_role;

-- Guard every canonical predecessor before replacing any writer. The five
-- top-level constant definitions below differ from the retained predecessor
-- fixture only at the reviewed notification call; ACLs, ownership and comments
-- stay attached to their existing function OIDs. No dynamic SQL is executed.
do $event_producers$
declare
  producer record;
  source text;
  attributes pg_catalog.pg_proc%rowtype;
begin
  for producer in select * from (values
    ('public.create_member_event(text,text,timestamptz,text,text,text,boolean,boolean)', 'f57598a749a02c54f9b00da80de52237', 'perform private.notify_member(m.id, ''event.created'', ''{}''::jsonb, ''events'');', 'false, false'),
    ('public.update_member_event(text,text,timestamptz,text,text,text,boolean,boolean)', 'b8b98a9fa6f8e9108301be2d023de982', 'perform private.notify_member(m.user_id, ''event.rescheduled'', ''{}''::jsonb, ''events'');', 'NULL::text, NULL::timestamp with time zone, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::boolean'),
    ('public.cancel_member_event(text,text)', 'cc407097044fa9d868dfef1dcf63baae', 'perform private.notify_member(m.user_id, ''event.cancelled'', ''{}''::jsonb, ''events'');', 'NULL::text'),
    ('public.restore_member_event(text)', 'a94597e21b436d1c0917e6fd0019dcba', 'perform private.notify_member(m.user_id, ''event.restored'', ''{}''::jsonb, ''events'');', null),
    ('private.event_notice_sweep()', '047fe6affb2a119a417711573947b354', 'perform private.notify_member(m.user_id, ''event.reminder'', ''{}''::jsonb, ''events'');', null)
  ) reviewed(signature, source_md5, before_call, defaults) loop
    select p.* into strict attributes
      from pg_catalog.pg_proc p where p.oid = producer.signature::regprocedure;
    source := attributes.prosrc;
    if pg_catalog.md5(source) is distinct from producer.source_md5
      or pg_catalog.array_length(pg_catalog.string_to_array(source, producer.before_call), 1) <> 2 then
      raise exception 'unreviewed event notification producer: %', producer.signature using errcode = '55000';
    end if;
    -- Constant CREATE OR REPLACE would otherwise reset altered execution
    -- attributes to defaults. Refuse drift instead of silently normalizing it.
    if attributes.prolang <> (select oid from pg_catalog.pg_language where lanname = 'plpgsql')
      or attributes.prokind <> 'f' or attributes.provolatile <> 'v'
      or attributes.proparallel <> 'u' or attributes.proisstrict
      or not attributes.prosecdef or attributes.proleakproof or attributes.proretset
      or attributes.procost <> 100 or attributes.prorows <> 0
      or attributes.prosupport <> 0::oid
      or attributes.proconfig is distinct from array['search_path=""']::text[]
      or pg_catalog.pg_get_expr(attributes.proargdefaults, 0) is distinct from producer.defaults then
      raise exception 'unreviewed event notification producer attributes: %', producer.signature using errcode = '55000';
    end if;
  end loop;
end;
$event_producers$;

-- Pinned canonical public.create_member_event(text,text,timestamptz,text,text,text,boolean,boolean); one notification-call replacement.
create or replace function public.create_member_event(
  p_id text,
  p_title text,
  p_starts_at timestamptz,
  p_location text,
  p_summary text,
  p_check_in_code text,
  p_is_public boolean default false,
  p_is_public_across_agencies boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if p_is_public is null or p_is_public_across_agencies is null then
    raise exception 'event visibility is required' using errcode = '22023';
  end if;
  if p_id is null or p_id !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid event id' using errcode = '22023';
  end if;
  if p_title is null or pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120 or p_title ~ '[[:cntrl:]]' then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_starts_at is null then
    raise exception 'invalid start time' using errcode = '22023';
  end if;
  if p_location is null or pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120 or p_location ~ '[[:cntrl:]]' then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is null or pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500 or p_summary ~ '[[:cntrl:]]' then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if p_check_in_code is null or p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member_events:order_index:' || caller_chapter, 509));
  if exists (select 1 from public.member_events where id = p_id) then
    raise exception 'event id already exists' using errcode = '22023';
  end if;

  insert into public.member_events (
    id, title, starts_at, location, summary, check_in_code, order_index,
    chapter_id, is_public, is_public_across_agencies)
  values (
    p_id, pg_catalog.btrim(p_title), p_starts_at, pg_catalog.btrim(p_location),
    pg_catalog.btrim(p_summary), p_check_in_code,
    coalesce((select pg_catalog.max(order_index) + 1 from public.member_events where chapter_id = caller_chapter), 1),
    caller_chapter, p_is_public, p_is_public_across_agencies);

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'create_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', pg_catalog.btrim(p_title),
    'chapterId', caller_chapter,
    'isPublic', p_is_public,
    'isPublicAcrossAgencies', p_is_public_across_agencies));

  begin
    for m in
      select recipient.id
      from public.member_profiles recipient
      join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
      join public.chapters publisher_chapter on publisher_chapter.id = caller_chapter
      join public.organization_memberships recipient_membership
        on recipient_membership.user_id = recipient.id
       and recipient_membership.organization_id = publisher_chapter.organization_id
       and recipient_membership.status = 'active'
      where recipient.id <> caller
        and recipient_chapter.organization_id = publisher_chapter.organization_id
        and (
          recipient.chapter_id = caller_chapter
          or p_is_public_across_agencies
          or (p_is_public and publisher_chapter.region is not null
              and recipient_chapter.region = publisher_chapter.region)
        )
    loop
      perform private.notify_member_event(m.id, p_id, 'created');
    end loop;
  exception
    when others then
      raise warning 'event.created notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'created', true);
end;
end;
$$;

-- Pinned canonical public.update_member_event(text,text,timestamptz,text,text,text,boolean,boolean); one notification-call replacement.
create or replace function public.update_member_event(p_id text, p_title text default null, p_starts_at timestamptz default null, p_location text default null, p_summary text default null, p_check_in_code text default null, p_is_public boolean default null, p_is_public_across_agencies boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  changed text[];
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  if p_title is not null and (pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120 or p_title ~ '[[:cntrl:]]') then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_location is not null and (pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120 or p_location ~ '[[:cntrl:]]') then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is not null and (pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500 or p_summary ~ '[[:cntrl:]]') then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if p_check_in_code is not null and p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  changed := pg_catalog.array_remove(array[
    case when p_title is not null and pg_catalog.btrim(p_title) is distinct from ev.title then 'title' end,
    case when p_starts_at is not null and p_starts_at is distinct from ev.starts_at then 'starts_at' end,
    case when p_location is not null and pg_catalog.btrim(p_location) is distinct from ev.location then 'location' end,
    case when p_summary is not null and pg_catalog.btrim(p_summary) is distinct from ev.summary then 'summary' end,
    case when p_check_in_code is not null and p_check_in_code is distinct from ev.check_in_code then 'check_in_code' end,
    case when p_is_public is not null and p_is_public is distinct from ev.is_public then 'is_public' end,
    case when p_is_public_across_agencies is not null and p_is_public_across_agencies is distinct from ev.is_public_across_agencies then 'is_public_across_agencies' end
  ], null);

  if pg_catalog.cardinality(changed) > 0 then
    update public.member_events set
      title = coalesce(pg_catalog.btrim(p_title), title),
      starts_at = coalesce(p_starts_at, starts_at),
      location = coalesce(pg_catalog.btrim(p_location), location),
      summary = coalesce(pg_catalog.btrim(p_summary), summary),
      check_in_code = coalesce(p_check_in_code, check_in_code),
      is_public = coalesce(p_is_public, is_public),
      is_public_across_agencies = coalesce(p_is_public_across_agencies, is_public_across_agencies)
    where id = p_id and chapter_id = caller_chapter;

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.to_jsonb(changed),
      'isPublic', coalesce(p_is_public, ev.is_public),
      'isPublicAcrossAgencies', coalesce(p_is_public_across_agencies, ev.is_public_across_agencies)));

    if 'starts_at' = any(changed) then
      update public.member_events set reminder_notice_sent_at = null
      where id = p_id and chapter_id = caller_chapter;
      begin
        for m in
          select rv.user_id
          from public.member_event_rsvps rv
          join public.member_profiles recipient on recipient.id = rv.user_id
          join public.member_events current_event on current_event.id = rv.event_id
          join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
          join public.chapters publisher_chapter on publisher_chapter.id = current_event.chapter_id
          where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
            and (
              recipient.chapter_id = current_event.chapter_id
              or current_event.is_public_across_agencies
              or (current_event.is_public and publisher_chapter.region is not null
                  and recipient_chapter.region = publisher_chapter.region)
            )
        loop
          perform private.notify_member_event(m.user_id, p_id, 'rescheduled');
        end loop;
      exception
        when others then
          raise warning 'event.rescheduled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
      end;
    end if;
  end if;

  return pg_catalog.jsonb_build_object('id', p_id, 'updated', pg_catalog.cardinality(changed) > 0);
end;
end;
$$;

-- Pinned canonical public.cancel_member_event(text,text); one notification-call replacement.
create or replace function public.cancel_member_event(p_id text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  clean_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if clean_reason is not null
     and (pg_catalog.char_length(clean_reason) > 300 or clean_reason ~ '[[:cntrl:]]') then
    raise exception 'invalid cancellation reason' using errcode = '22023';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', true, 'changed', false);
  end if;

  update public.member_events
  set cancelled_at = now(), cancelled_reason = clean_reason
  where id = p_id and chapter_id = caller_chapter;

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'cancel_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
    'reason', coalesce(clean_reason, '')));

  begin
    for m in
      select rv.user_id from public.member_event_rsvps rv
      where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
    loop
      perform private.notify_member_event(m.user_id, p_id, 'cancelled');
    end loop;
  exception
    when others then
      raise warning 'event.cancelled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', true, 'changed', true);
end;
end;
$$;

-- Pinned canonical private.event_notice_sweep(); one notification-call replacement.
create or replace function private.event_notice_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  r record;
  m record;
begin
  for r in
    select e.id from public.member_events e
    where e.reminder_notice_sent_at is null
      and e.starts_at > now()
      and e.starts_at <= now() + interval '24 hours'
    for update skip locked
  loop
    update public.member_events set reminder_notice_sent_at = now() where id = r.id;
    for m in
      select rv.user_id
      from public.member_event_rsvps rv
      join public.member_profiles recipient on recipient.id = rv.user_id
      join public.member_events e on e.id = rv.event_id
      join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
      join public.chapters publisher_chapter on publisher_chapter.id = e.chapter_id
      where rv.event_id = r.id and rv.status = 'going'
        and (
          recipient.chapter_id = e.chapter_id
          or e.is_public_across_agencies
          or (e.is_public and publisher_chapter.region is not null
              and recipient_chapter.region = publisher_chapter.region)
        )
    loop
      perform private.notify_member_event(m.user_id, r.id, 'reminder');
    end loop;
  end loop;
  -- REQ-UG-EVENT-AND-POLL-FOLLOW-UPS-20261001 (20261003032000): event
  -- draft announcements and closed-poll follow-ups ride this tick. A fault
  -- there never undoes the reminders above.
  begin
    perform private.engagement_follow_up_sweep(100);
  exception
    when query_canceled then
      raise;
    when others then
      raise warning 'engagement_follow_up_sweep failed: % (%)', sqlerrm, sqlstate;
  end;
end;
end;
$function$;

-- Pinned canonical restore_member_event(text); one notification-call replacement.
create or replace function public.restore_member_event(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;
  if ev.cancelled_at is null then
    return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', false, 'changed', false);
  end if;

  update public.member_events
  set cancelled_at = null, cancelled_reason = null
  where id = p_id and chapter_id = caller_chapter;

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'restore_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter));

  begin
    for m in
      select rv.user_id from public.member_event_rsvps rv
      where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
    loop
      perform private.notify_member_event(m.user_id, p_id, 'restored');
    end loop;
  exception
    when others then
      raise warning 'event.restored notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', false, 'changed', true);
end;
end;
$$;

commit;
