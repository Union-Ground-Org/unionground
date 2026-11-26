-- A steward answering through the per-message Reply action must carry the
-- same 'Chapter steward' pseudonym that send_steward_reply stamps. The
-- original reply_to_member_message (20260907140000) stamped the caller's
-- profile full_name, or 'Member' when empty, on steward rows too. Only the
-- sender_name expression changes; member replies keep the caller's
-- server-owned profile name.
--
-- 20260907151000_account_deletion_finalization_reconciliation wrapped this
-- writer so private.lock_case_graph runs first. The outer block keeps that
-- entry gate ahead of the message-lifecycle lock.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.reply_to_member_message(p_source_kind text, p_message_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
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
revoke all on function public.reply_to_member_message(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.reply_to_member_message(text, uuid, text) to authenticated;

notify pgrst, 'reload schema';
commit;
