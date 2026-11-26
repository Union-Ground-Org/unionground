-- B04: authorized counts cover the complete thread, independent of client windows.
-- Read-only RPCs; rollback withdraws these grants and drops the two functions.
begin;
set local lock_timeout = '5s';

create function public.get_member_message_reply_counts(p_source_kind text, p_message_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare caller uuid := (select auth.uid()); message_id uuid; result jsonb := '{}'::jsonb; total bigint;
begin
  perform private.lock_message_lifecycle();
  if caller is null or private.mfa_satisfied() is not true
     or p_source_kind is null or p_source_kind not in ('private', 'channel')
     or p_message_ids is null or pg_catalog.cardinality(p_message_ids) > 200 then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  foreach message_id in array p_message_ids loop
    if private.can_read_message_source(caller, p_source_kind,
        case when p_source_kind = 'private' then message_id end,
        case when p_source_kind = 'channel' then message_id end, null) is not true then
      raise exception 'message unavailable' using errcode = '42501';
    end if;
    if p_source_kind = 'private' then
      select count(*) into total from public.member_messages m
      join public.member_messages parent on parent.id = message_id
      where m.parent_message_id = parent.id and m.conversation_id = parent.conversation_id;
    else
      select count(*) into total from public.chapter_thread_posts p
      join public.chapter_thread_posts parent on parent.id = message_id
      where p.parent_post_id = parent.id and p.thread_id = parent.thread_id and p.deleted_at is null;
    end if;
    result := result || pg_catalog.jsonb_build_object(message_id::text, total);
  end loop;
  return result;
end;
$function$;
revoke all on function public.get_member_message_reply_counts(text, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_member_message_reply_counts(text, uuid[]) to authenticated;

create function public.get_member_message_replies(p_source_kind text, p_parent_id uuid, p_target_id uuid,
  p_after_at timestamptz default null, p_after_id uuid default null, p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare caller uuid := (select auth.uid()); parent jsonb; page jsonb; total bigint; target uuid;
begin
  perform private.lock_message_lifecycle();
  if caller is null or private.mfa_satisfied() is not true
     or p_source_kind is null or p_source_kind not in ('private', 'channel')
     or p_target_id is null or p_limit is null or p_limit not between 1 and 100
     or (p_after_at is null) is distinct from (p_after_id is null)
     or private.can_read_message_source(caller, p_source_kind,
       case when p_source_kind = 'private' then p_parent_id end,
       case when p_source_kind = 'channel' then p_parent_id end, null) is not true then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  if p_source_kind = 'private' then
    select m.conversation_id into target from public.member_messages m where m.id = p_parent_id;
  else
    select t.space_id into target from public.chapter_thread_posts p
      join public.chapter_threads t on t.id = p.thread_id where p.id = p_parent_id;
  end if;
  if target is distinct from p_target_id then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  if p_source_kind = 'private' then
    select pg_catalog.jsonb_build_object('id', m.id, 'body', m.body, 'created_at', m.created_at,
      'author_name', m.sender_name, 'parent_id', m.parent_message_id, 'edited_at', m.edited_at,
      'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason)
      into parent from public.member_messages m where m.id = p_parent_id;
    select coalesce(pg_catalog.jsonb_agg(row.value order by row.created_at, row.id), '[]'::jsonb) into page from (
      select m.id, m.created_at, pg_catalog.jsonb_build_object('id', m.id, 'body', m.body,
        'created_at', m.created_at, 'author_name', m.sender_name, 'parent_id', m.parent_message_id,
        'edited_at', m.edited_at, 'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason) value
      from public.member_messages m where m.parent_message_id = p_parent_id and m.conversation_id = target
        and (p_after_at is null or (m.created_at, m.id) > (p_after_at, p_after_id))
      order by m.created_at, m.id limit p_limit + 1
    ) row;
  else
    select pg_catalog.jsonb_build_object('id', p.id, 'body', p.body, 'created_at', p.created_at,
      'author_name', p.author_name, 'parent_id', p.parent_post_id)
      into parent from public.chapter_thread_posts p where p.id = p_parent_id;
    select coalesce(pg_catalog.jsonb_agg(row.value order by row.created_at, row.id), '[]'::jsonb) into page from (
      select p.id, p.created_at, pg_catalog.jsonb_build_object('id', p.id, 'body', p.body,
        'created_at', p.created_at, 'author_name', p.author_name, 'parent_id', p.parent_post_id) value
      from public.chapter_thread_posts p join public.chapter_thread_posts root on root.id = p_parent_id
      where p.parent_post_id = root.id and p.thread_id = root.thread_id and p.deleted_at is null
        and (p_after_at is null or (p.created_at, p.id) > (p_after_at, p_after_id))
      order by p.created_at, p.id limit p_limit + 1
    ) row;
  end if;
  total := (public.get_member_message_reply_counts(p_source_kind, array[p_parent_id])->>p_parent_id::text)::bigint;
  return pg_catalog.jsonb_build_object('parent', parent, 'replies',
    case when pg_catalog.jsonb_array_length(page) > p_limit then page - p_limit else page end,
    'count', total, 'hasMore', pg_catalog.jsonb_array_length(page) > p_limit);
end;
$function$;
revoke all on function public.get_member_message_replies(text, uuid, uuid, timestamptz, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.get_member_message_replies(text, uuid, uuid, timestamptz, uuid, integer) to authenticated;

notify pgrst, 'reload schema';
commit;
