-- REQ-UG-NATIVE-MESSAGE-ACTIONS-20260904.
-- Edits are limited to an attributed sender's latest conversation message for
-- fifteen minutes. Historical sender identities are deliberately not inferred.
-- Rollback requires withdrawing the RPC grants first; keep attribution and links.
begin;
set local lock_timeout = '5s';

alter table public.member_messages
  add column sender_id uuid references auth.users(id) on delete set null,
  add column edited_at timestamptz,
  add column parent_message_id uuid references public.member_messages(id) on delete set null;
create index member_messages_parent_idx on public.member_messages(parent_message_id, created_at, id);
create index chapter_thread_posts_parent_idx on public.chapter_thread_posts(parent_post_id, created_at, id);

create function private.stamp_message_action_identity()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if tg_op = 'INSERT' then
    new.sender_id := (select auth.uid());
    new.edited_at := null;
  end if;
  return new;
end;
$function$;
revoke all on function private.stamp_message_action_identity() from public, anon, authenticated, service_role;
create trigger member_messages_stamp_action_identity before insert on public.member_messages
for each row execute function private.stamp_message_action_identity();

create function private.validate_message_reply_parent()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare parent_id uuid; parent_target uuid; target uuid;
begin
  if tg_table_name = 'member_messages' then
    parent_id := new.parent_message_id; target := new.conversation_id;
    if parent_id is null then return new; end if;
    select m.conversation_id into parent_target from public.member_messages m
      where m.id = parent_id and m.redacted_at is null;
  else
    parent_id := new.parent_post_id; target := new.thread_id;
    if parent_id is null then return new; end if;
    select p.thread_id into parent_target from public.chapter_thread_posts p
      where p.id = parent_id and p.deleted_at is null;
  end if;
  if parent_id = new.id or parent_target is null or parent_target is distinct from target then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  return new;
end;
$function$;
revoke all on function private.validate_message_reply_parent() from public, anon, authenticated, service_role;
create trigger member_messages_validate_reply before insert on public.member_messages
for each row execute function private.validate_message_reply_parent();
create trigger chapter_thread_posts_validate_reply before insert on public.chapter_thread_posts
for each row execute function private.validate_message_reply_parent();

create function private.message_action_audit(p_kind text, p_id uuid, p_operation text)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_message_lifecycle();
  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    private.current_member_organization(), 'privacy', 'message.' || p_operation,
    'settings_change', (select auth.uid()), 'message', p_id::text,
    extensions.gen_random_uuid(), pg_catalog.jsonb_build_object('operation', p_operation, 'entityType', p_kind)
  );
end;
$function$;
revoke all on function private.message_action_audit(text, uuid, text) from public, anon, authenticated, service_role;

create function public.get_member_message_actions(p_source_kind text, p_message_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_message_lifecycle();
  declare caller uuid := (select auth.uid()); message public.member_messages%rowtype; editable boolean := false;
  begin
    if caller is null or private.mfa_satisfied() is not true
       or p_source_kind is null or p_source_kind not in ('private', 'channel')
       or private.can_read_message_source(caller, p_source_kind,
         case when p_source_kind = 'private' then p_message_id end,
         case when p_source_kind = 'channel' then p_message_id end, null) is not true then
      raise exception 'message unavailable' using errcode = '42501';
    end if;
    if p_source_kind = 'private' then
      select * into message from public.member_messages where id = p_message_id;
      editable := message.sender_id = caller and message.redacted_at is null
        and message.created_at > pg_catalog.clock_timestamp() - interval '15 minutes'
        and private.member_message_under_legal_hold(message.conversation_id) is false
        and not exists (select 1 from public.member_messages later
          where later.conversation_id = message.conversation_id
            and (later.created_at, later.id) > (message.created_at, message.id));
    end if;
    return pg_catalog.jsonb_build_object(
      'canEdit', coalesce(editable, false),
      'saved', exists (select 1 from public.member_saved_messages s where s.owner_id = caller
        and s.source_kind = p_source_kind and coalesce(s.private_message_id, s.channel_post_id) = p_message_id),
      'reminders', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', r.id, 'remindAt', r.remind_at) order by r.remind_at, r.id)
        from public.member_message_reminders r where r.owner_id = caller and r.status = 'pending'
          and r.source_kind = p_source_kind and coalesce(r.private_message_id, r.channel_post_id) = p_message_id), '[]'::jsonb),
      'reactions', coalesce((select pg_catalog.jsonb_agg(r.reaction order by r.reaction)
        from public.member_message_reactions r where r.actor_id = caller and r.source_kind = p_source_kind
          and coalesce(r.private_message_id, r.channel_post_id) = p_message_id), '[]'::jsonb));
  end;
end;
$function$;
revoke all on function public.get_member_message_actions(text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_member_message_actions(text, uuid) to authenticated;

create function public.edit_member_message(p_message_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_message_lifecycle();
  declare state jsonb; clean text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11));
  begin
    if (select auth.uid()) is null or private.mfa_satisfied() is not true then
      raise exception 'message unavailable' using errcode = '42501';
    end if;
    state := public.get_member_message_actions('private', p_message_id);
    if (state->>'canEdit')::boolean is not true then
      raise exception 'message unavailable' using errcode = '42501';
    end if;
    if pg_catalog.char_length(clean) not between 1 and 4000 then
      raise exception 'invalid message' using errcode = '22023';
    end if;
    perform 1 from public.member_messages where id = p_message_id for update;
    update public.member_messages set body = clean, edited_at = pg_catalog.clock_timestamp() where id = p_message_id;
    -- Dispatch keeps a second body copy; an edit must replace that copy too.
    update public.member_scheduled_messages set body = clean where sent_message_id = p_message_id;
    perform private.message_action_audit('private', p_message_id, 'edited');
    return (select pg_catalog.to_jsonb(m) from public.member_messages m where m.id = p_message_id);
  end;
end;
$function$;
revoke all on function public.edit_member_message(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.edit_member_message(uuid, text) to authenticated;

create function public.act_on_member_message(p_source_kind text, p_message_id uuid, p_action text, p_value text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_message_lifecycle();
  declare state jsonb; result jsonb; reminder record;
  begin
    if (select auth.uid()) is null or private.mfa_satisfied() is not true then
      raise exception 'message unavailable' using errcode = '42501';
    end if;
    state := public.get_member_message_actions(p_source_kind, p_message_id);
    if p_action = 'react' then
      if p_value is null then raise exception 'invalid reaction' using errcode = '22023'; end if;
      result := public.toggle_member_message_reaction(p_source_kind, p_message_id, p_value);
    elsif p_action = 'save' then
      result := public.toggle_member_saved_message(p_source_kind, p_message_id);
    elsif p_action = 'remind' then
      if p_value is null then raise exception 'invalid reminder' using errcode = '22023'; end if;
      result := public.create_member_message_reminder(p_source_kind, p_message_id, p_value::timestamptz, '');
    elsif p_action = 'unremind' then
      for reminder in select value->>'id' id from pg_catalog.jsonb_array_elements(state->'reminders') loop
        perform public.cancel_member_message_reminder(reminder.id::uuid);
      end loop;
      result := pg_catalog.jsonb_build_object('cancelled', true);
    else
      raise exception 'invalid action' using errcode = '22023';
    end if;
    perform private.message_action_audit(p_source_kind, p_message_id, p_action);
    return pg_catalog.jsonb_build_object('result', result, 'state', public.get_member_message_actions(p_source_kind, p_message_id));
  end;
end;
$function$;
revoke all on function public.act_on_member_message(text, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.act_on_member_message(text, uuid, text, text) to authenticated;

create function public.reply_to_member_message(p_source_kind text, p_message_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
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
      insert into public.member_messages(conversation_id, user_id, sender_kind, sender_name, body, parent_message_id, created_at)
        values(source.conversation_id, source.user_id, kind,
          coalesce((select nullif(full_name, '') from public.member_profiles where id = caller), 'Member'), clean, p_message_id, pg_catalog.clock_timestamp())
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
      insert into public.chapter_thread_posts(thread_id, body, parent_post_id)
        values(post.thread_id, clean, p_message_id) returning id into new_id;
      result := (select pg_catalog.to_jsonb(p) from public.chapter_thread_posts p where p.id = new_id);
    end if;
    perform private.message_action_audit(p_source_kind, new_id, 'replied');
    return result;
  end;
end;
$function$;
revoke all on function public.reply_to_member_message(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.reply_to_member_message(text, uuid, text) to authenticated;

notify pgrst, 'reload schema';
commit;
