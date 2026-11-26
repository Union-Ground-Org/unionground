-- SEC-UG-MESSAGE-ACTION-WRITE-BOUNDS-20260921
--
-- public.act_on_member_message and public.reply_to_member_message
-- (20260907140000; reply re-emitted by 20260924190200) wrote one
-- organization_audit_ledger 'message.*' row per call with no volume bound, and
-- a retried reply or reminder persisted a second copy. This migration keeps
-- every authorized message behaviour and adds:
--
-- 1. A documented short-window write bound. private.message_action_admit()
--    counts the caller's own privacy-domain 'message.*' audit rows in the
--    last 5 minutes and refuses the call with errcode 54000, before any write,
--    once there are 150. Both RPCs call it after authorization. A
--    per-actor transaction advisory lock serializes the count so concurrent
--    calls cannot both pass at the bound; a partial index keys the lookup.
-- 2. Operation idempotency for replies. A reply whose caller, parent and
--    cleaned body equal one the caller wrote in the last 60 seconds returns
--    that reply instead of inserting and auditing a second copy.
-- 3. Reminder coalescing. public.create_member_message_reminder returns the
--    caller's existing pending reminder on the same message at the same time
--    (marked coalesced) instead of inserting another, and refuses a 21st
--    pending reminder on one message with errcode 54000. act_on_member_message
--    audits neither a coalesced reminder nor an 'unremind' with nothing
--    pending, since neither changes state.
--
-- Each body keeps the installed private.lock_case_graph entry statement
-- (20260907151000 wrapper) ahead of the message-lifecycle lock. Grants are
-- preserved by CREATE OR REPLACE.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create index if not exists organization_audit_ledger_message_actor_idx
  on public.organization_audit_ledger (actor_user_id, occurred_at)
  where domain = 'privacy' and event_type like 'message.%';

create or replace function private.message_action_admit()
returns void
language plpgsql
set search_path = ''
as $function$
declare
  actor uuid;
  recent_writes integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  if actor is null then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('message-action:' || actor::text, 509)
  );
  select count(*)::integer into recent_writes
  from public.organization_audit_ledger l
  where l.actor_user_id = actor
    and l.domain = 'privacy'
    and l.event_type like 'message.%'
    and l.occurred_at > pg_catalog.now() - interval '5 minutes';
  -- 150 message action writes per actor per rolling 5 minutes.
  if recent_writes >= 150 then
    raise exception 'message action limit reached: 150 per 5 minutes' using errcode = '54000';
  end if;
end;
$function$;

revoke all on function private.message_action_admit() from public, anon, authenticated, service_role;

create or replace function public.create_member_message_reminder(p_source_kind text, p_message_id uuid, p_remind_at timestamp with time zone, p_note text default ''::text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  clean_note text := pg_catalog.btrim(coalesce(p_note, ''));
  new_id uuid;
  pending_count integer;
begin
  if caller is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_remind_at <= now() or p_remind_at > now() + interval '1 year' or pg_catalog.char_length(clean_note) > 500 then
    raise exception 'invalid reminder' using errcode = '22023';
  end if;
  if p_source_kind not in ('private','channel','task')
     or not private.can_read_message_source(
       caller, p_source_kind,
       case when p_source_kind = 'private' then p_message_id end,
       case when p_source_kind = 'channel' then p_message_id end,
       case when p_source_kind = 'task' then p_message_id end) then
    raise exception 'message unavailable' using errcode = '22023';
  end if;
  select r.id into new_id
  from public.member_message_reminders r
  where r.owner_id = caller and r.status = 'pending' and r.source_kind = p_source_kind
    and coalesce(r.private_message_id, r.channel_post_id, r.task_message_id) = p_message_id
    and r.remind_at = p_remind_at
  order by r.created_at, r.id
  limit 1;
  if new_id is not null then
    return pg_catalog.jsonb_build_object('id', new_id, 'status', 'pending', 'coalesced', true);
  end if;
  select count(*)::integer into pending_count
  from public.member_message_reminders r
  where r.owner_id = caller and r.status = 'pending' and r.source_kind = p_source_kind
    and coalesce(r.private_message_id, r.channel_post_id, r.task_message_id) = p_message_id;
  if pending_count >= 20 then
    raise exception 'reminder limit reached: 20 pending per message' using errcode = '54000';
  end if;
  insert into public.member_message_reminders(
    owner_id, source_kind, private_message_id, channel_post_id, task_message_id, note, remind_at)
  values (
    caller, p_source_kind,
    case when p_source_kind = 'private' then p_message_id end,
    case when p_source_kind = 'channel' then p_message_id end,
    case when p_source_kind = 'task' then p_message_id end,
    clean_note, p_remind_at)
  returning id into new_id;
  return pg_catalog.jsonb_build_object('id', new_id, 'status', 'pending');
end;
end;
end;
$function$;

create or replace function public.act_on_member_message(p_source_kind text, p_message_id uuid, p_action text, p_value text default null::text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();
  declare state jsonb; result jsonb; reminder record; changed boolean := true;
  begin
    if (select auth.uid()) is null or private.mfa_satisfied() is not true then
      raise exception 'message unavailable' using errcode = '42501';
    end if;
    state := public.get_member_message_actions(p_source_kind, p_message_id);
    perform private.message_action_admit();
    if p_action = 'react' then
      if p_value is null then raise exception 'invalid reaction' using errcode = '22023'; end if;
      result := public.toggle_member_message_reaction(p_source_kind, p_message_id, p_value);
    elsif p_action = 'save' then
      result := public.toggle_member_saved_message(p_source_kind, p_message_id);
    elsif p_action = 'remind' then
      if p_value is null then raise exception 'invalid reminder' using errcode = '22023'; end if;
      result := public.create_member_message_reminder(p_source_kind, p_message_id, p_value::timestamptz, '');
      changed := coalesce((result->>'coalesced')::boolean, false) is not true;
    elsif p_action = 'unremind' then
      changed := pg_catalog.jsonb_array_length(state->'reminders') > 0;
      for reminder in select value->>'id' id from pg_catalog.jsonb_array_elements(state->'reminders') loop
        perform public.cancel_member_message_reminder(reminder.id::uuid);
      end loop;
      result := pg_catalog.jsonb_build_object('cancelled', true);
    else
      raise exception 'invalid action' using errcode = '22023';
    end if;
    if changed then
      perform private.message_action_audit(p_source_kind, p_message_id, p_action);
    end if;
    return pg_catalog.jsonb_build_object('result', result, 'state', public.get_member_message_actions(p_source_kind, p_message_id));
  end;
end;
end;
$function$;

create or replace function public.reply_to_member_message(p_source_kind text, p_message_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
begin
  perform private.lock_message_lifecycle();
  declare caller uuid := (select auth.uid()); clean text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11));
    source public.member_messages%rowtype; post public.chapter_thread_posts%rowtype; result jsonb; new_id uuid; kind text;
  begin
    perform public.get_member_message_actions(p_source_kind, p_message_id);
    if pg_catalog.char_length(clean) not between 1 and 4000 then
      raise exception 'invalid message' using errcode = '22023';
    end if;
    if p_source_kind = 'private' then
      select * into source from public.member_messages where id = p_message_id;
      if private.can_actor_send_private_message(caller, source.conversation_id, 'member') is true then
        kind := 'member';
      elsif private.can_actor_send_private_message(caller, source.conversation_id, 'steward') is true
          and public.member_has_role(array['steward']) is true then kind := 'steward';
      else raise exception 'message unavailable' using errcode = '42501'; end if;
      result := (select pg_catalog.to_jsonb(m) from public.member_messages m
        where m.parent_message_id = p_message_id and m.sender_id = caller and m.body = clean
          and m.redacted_at is null and m.created_at > pg_catalog.clock_timestamp() - interval '60 seconds'
        order by m.created_at desc, m.id desc limit 1);
      if result is not null then return result; end if;
      perform private.message_action_admit();
      insert into public.member_messages(conversation_id, user_id, sender_kind, sender_name, body, parent_message_id, created_at)
        values(source.conversation_id, source.user_id, kind,
          case when kind = 'steward' then 'Chapter steward'
            else coalesce((select nullif(full_name, '') from public.member_profiles where id = caller), 'Member') end,
          clean, p_message_id, pg_catalog.clock_timestamp())
        returning id into new_id;
      update public.member_conversations set updated_at = pg_catalog.now() where id = source.conversation_id;
      result := (select pg_catalog.to_jsonb(m) from public.member_messages m where m.id = new_id);
    else
      select * into post from public.chapter_thread_posts where id = p_message_id;
      if not exists (select 1 from public.chapter_threads t join public.chapter_spaces s on s.id = t.space_id
        where t.id = post.thread_id and t.status = 'open' and private.can_read_chapter_space(s) is true
          and t.chapter_id = private.current_member_chapter()) then
        raise exception 'message unavailable' using errcode = '42501';
      end if;
      result := (select pg_catalog.to_jsonb(p) from public.chapter_thread_posts p
        where p.parent_post_id = p_message_id and p.author_id = caller and p.body = clean
          and p.deleted_at is null and p.created_at > pg_catalog.clock_timestamp() - interval '60 seconds'
        order by p.created_at desc, p.id desc limit 1);
      if result is not null then return result; end if;
      perform private.message_action_admit();
      insert into public.chapter_thread_posts(thread_id, body, parent_post_id)
        values(post.thread_id, clean, p_message_id) returning id into new_id;
      result := (select pg_catalog.to_jsonb(p) from public.chapter_thread_posts p where p.id = new_id);
    end if;
    perform private.message_action_audit(p_source_kind, new_id, 'replied');
    return result;
  end;
end;
end;
$function$;

notify pgrst, 'reload schema';

commit;
