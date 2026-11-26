-- REQ-UG-DESIGN-BACKEND-P2-20260721 (review fix): multi-line steward
-- bodies. Browsers normalize textarea submissions to CRLF, so the control
-- character guard must strip carriage returns alongside newlines and tabs or
-- every multi-paragraph reply and broadcast is rejected. Also regenerates the
-- broadcast id inside the retry loop so a retry can never re-collide on the
-- same key. Bodies are otherwise identical to 20260722001108.

create or replace function public.send_steward_reply(p_conversation_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  convo record;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  if clean_body = '' or pg_catalog.char_length(clean_body) > 4000 then
    raise exception 'reply must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  if pg_catalog.regexp_replace(clean_body, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'reply contains unsupported control characters' using errcode = '22023';
  end if;

  select id, user_id into convo
  from public.member_conversations
  where id = p_conversation_id;

  if not found then
    raise exception 'conversation not found' using errcode = '22023';
  end if;

  insert into public.member_messages (conversation_id, user_id, sender_kind, sender_name, body)
  values (convo.id, convo.user_id, 'steward', 'Chapter steward', clean_body);

  update public.member_conversations set updated_at = now() where id = convo.id;

  return pg_catalog.jsonb_build_object('conversationId', convo.id);
end;
$$;

create or replace function public.publish_member_broadcast(p_title text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  recent integer;
  new_id text;
  next_index integer;
  attempts integer := 0;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  if clean_title = '' or pg_catalog.char_length(clean_title) > 120 then
    raise exception 'title must be between 1 and 120 characters' using errcode = '22023';
  end if;

  if clean_title ~ '[[:cntrl:]]' then
    raise exception 'title contains unsupported control characters' using errcode = '22023';
  end if;

  if clean_body = '' or pg_catalog.char_length(clean_body) > 4000 then
    raise exception 'body must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  if pg_catalog.regexp_replace(clean_body, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'body contains unsupported control characters' using errcode = '22023';
  end if;

  select count(*) into recent
  from public.member_broadcasts
  where created_by = caller
    and published_at >= now() - interval '24 hours';

  if recent >= 5 then
    raise exception 'broadcast limit reached: 5 per steward per day' using errcode = '54000';
  end if;

  loop
    begin
      new_id := 'bc-' || extensions.gen_random_uuid();
      select coalesce(min(order_index), 1) - 1 into next_index from public.member_broadcasts;
      insert into public.member_broadcasts (id, sender, title, body, published_at, order_index, created_by)
      values (new_id, 'Chapter steward', clean_title, clean_body, now(), next_index, caller);
      exit;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts >= 3 then
        raise;
      end if;
    end;
  end loop;

  return pg_catalog.jsonb_build_object('broadcastId', new_id);
end;
$$;
