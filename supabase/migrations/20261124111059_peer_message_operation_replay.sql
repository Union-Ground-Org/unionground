-- #9537: keep retry identity on the canonical peer message, with no second
-- copy of its body or new account-lifecycle table.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $guard$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid =
      'public.send_reward_peer_message(uuid,text)'::regprocedure) is distinct from 'a776484340d76ee2e24006fb4868b09b' then
    raise exception 'unreviewed peer message writer predecessor' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid =
      'public.start_officer_conversation(uuid,text)'::regprocedure) is distinct from '65b43fd5b7887ca02d8556418f39df0e' then
    raise exception 'unreviewed officer message writer predecessor' using errcode = '55000';
  end if;
end;
$guard$;

alter table public.member_peer_messages
  add column client_operation_id uuid,
  add column officer_start_created boolean,
  add constraint member_peer_messages_officer_operation_check
    check (officer_start_created is null or client_operation_id is not null);

create unique index member_peer_messages_client_operation_idx
  on public.member_peer_messages (client_operation_id) where client_operation_id is not null;

create function private.write_peer_message(
  p_conversation_id uuid, p_body text, p_operation_id uuid, p_officer_start_created boolean
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
begin
  -- Both participants: a concurrent membership or block change on either
  -- person commits first (this send sees it) or waits for this send.
  perform private.lock_case_graph(array[auth.uid(), (select case when c.user_low = auth.uid() then c.user_high else c.user_low end
    from public.member_peer_conversations c
    where c.id = p_conversation_id and (c.user_low = auth.uid() or c.user_high = auth.uid()))], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11));
  conversation_row public.member_peer_conversations%rowtype;
  conversation_state text;
  saved public.member_peer_messages%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'message unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('peer-message-sender:' || caller::text, 0));

  select c.* into conversation_row
  from public.member_peer_conversations c
  where c.id = p_conversation_id
    and (c.user_low = caller or c.user_high = caller)
  for update;

  if not found then
    raise exception 'message unavailable' using errcode = '22023';
  end if;

  -- Scope the canonical row to the authenticated sender and locked
  -- conversation. Serialize key collisions across senders before deciding
  -- whether a fresh officer send can rewrite a closed conversation.
  if p_operation_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('peer-message-operation:' || p_operation_id::text, 0));

    select m.* into saved
    from public.member_peer_messages m
    where m.client_operation_id = p_operation_id
      and m.sender_id = caller
      and m.conversation_id = conversation_row.id;

    if saved.id is null and exists (
      select 1 from public.member_peer_messages m where m.client_operation_id = p_operation_id
    ) then
      raise exception 'message unavailable' using errcode = '22023';
    end if;
  end if;

  conversation_state := private.member_peer_conversation_state(conversation_row.id, caller);
  if conversation_state is distinct from 'open' then
    if saved.id is null and p_officer_start_created is not null then
      -- The officer wrapper has verified current chapter reachability.
      -- Only a new send can re-scope a conversation closed by a chapter move.
      update public.member_peer_conversations c
      set chapter_id = (select p.chapter_id from public.member_profiles p where p.id = caller),
        scope = 'chapter'
      where c.id = conversation_row.id;
      conversation_state := private.member_peer_conversation_state(conversation_row.id, caller);
    end if;
    if conversation_state is distinct from 'open' then
      raise exception 'message unavailable' using errcode = '22023', detail = 'peer_conversation_closed';
    end if;
  end if;

  if saved.id is not null and (
    saved.body <> clean_body
    or (saved.officer_start_created is null) <> (p_officer_start_created is null)
  ) then
    raise exception 'message unavailable' using errcode = '22023';
  end if;

  if saved.id is null then
    if (select pg_catalog.count(*) from public.member_peer_messages m
        where m.sender_id = caller and m.created_at >= now() - interval '5 minutes') >= 20 then
      raise exception 'message unavailable' using errcode = '22023';
    end if;

    insert into public.member_peer_messages (
      conversation_id, sender_id, body, client_operation_id, officer_start_created
    ) values (
      conversation_row.id, caller, clean_body, p_operation_id,
      case when p_operation_id is not null then p_officer_start_created end
    )
    on conflict (client_operation_id) where client_operation_id is not null do nothing
    returning * into saved;

    if saved.id is null then
      raise exception 'message unavailable' using errcode = '22023';
    end if;

    update public.member_peer_conversations
    set updated_at = saved.created_at
    where id = conversation_row.id;
  end if;

  return pg_catalog.jsonb_build_object(
    'message', pg_catalog.jsonb_build_object(
      'id', saved.id,
      'sentByMe', true,
      'body', saved.body,
      'createdAt', saved.created_at),
    'officerStartCreated', saved.officer_start_created);
end;
end;
$function$;

create function private.write_officer_first_message(
  p_officer_user_id uuid, p_body text, p_operation_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(), p_officer_user_id], array[]::uuid[]);
  -- A restricted PIN session must step up first, as every other member
  -- messaging and profile writer requires.
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11));
  caller_chapter text;
  conversation_id_value uuid;
  request_id_value uuid;
  created boolean := false;
  sent jsonb;
  officer_label jsonb;
begin
  if caller is null or not private.mfa_satisfied()
     or private.current_member_organization() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'message must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  -- Same lock order as public.request_reward_peer_contact: caller, then both
  -- profiles in UUID order, then the pair.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('peer-contact-caller:' || caller::text, 0));

  perform p.id
  from public.member_profiles p
  where p.id in (caller, p_officer_user_id)
  order by p.id
  for share;

  -- One refusal for every officer the caller may not reach (not listed, not
  -- in the caller's chapter or organization, the caller themselves, an
  -- account that cannot sign in, or a blocked pair).
  if p_officer_user_id is null or not exists (
    select 1 from private.member_contactable_officer_ids() as reachable(id)
    where reachable.id = p_officer_user_id
  ) then
    raise exception 'officer unavailable' using errcode = '42501', detail = 'officer_unavailable';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'peer-contact-pair:' || least(caller, p_officer_user_id)::text || ':' || greatest(caller, p_officer_user_id)::text, 0));

  select c.id into conversation_id_value
  from public.member_peer_conversations c
  where c.user_low = least(caller, p_officer_user_id)
    and c.user_high = greatest(caller, p_officer_user_id);

  if conversation_id_value is null then
    if (select pg_catalog.count(*) from public.member_peer_contact_requests r
        where r.requester_id = caller and not r.cross_chapter_contact
          and r.created_at >= pg_catalog.now() - interval '24 hours') >= 3 then
      raise exception 'officer contact limit' using errcode = '22023', detail = 'officer_contact_limit';
    end if;

    insert into public.member_peer_contact_requests (
      requester_id, recipient_id, chapter_id, status, responded_at, officer_contact)
    values (caller, p_officer_user_id, caller_chapter, 'accepted', pg_catalog.now(), true)
    returning id into request_id_value;

    insert into public.member_peer_conversations (chapter_id, user_low, user_high, created_from_request)
    values (
      caller_chapter,
      least(caller, p_officer_user_id),
      greatest(caller, p_officer_user_id),
      request_id_value)
    returning id into conversation_id_value;
    created := true;
  end if;

  -- The sole member-conversation writer: trimming, the per-sender limit and
  -- the conversation touch keep one definition. A refusal rolls back the new
  -- conversation with it.
  sent := private.write_peer_message(conversation_id_value, clean_body, p_operation_id, created);
  officer_label := private.member_peer_profile_label(p_officer_user_id);

  return pg_catalog.jsonb_build_object(
    'created', coalesce((sent ->> 'officerStartCreated')::boolean, created),
    'message', sent -> 'message',
    'conversation', pg_catalog.jsonb_build_object(
      'id', conversation_id_value,
      'peerName', officer_label ->> 'name',
      'peerInitials', officer_label ->> 'initials',
      'updatedAt', sent -> 'message' -> 'createdAt'));
end;
end;
$function$;

revoke all on function private.write_peer_message(uuid, text, uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.write_officer_first_message(uuid, text, uuid)
  from public, anon, authenticated, service_role;

-- Keep the existing two-argument signatures for deployed clients and for
-- database callers that already own their own idempotency contract.
create or replace function public.send_reward_peer_message(p_conversation_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(), (select case when c.user_low = auth.uid() then c.user_high else c.user_low end
    from public.member_peer_conversations c
    where c.id = p_conversation_id and (c.user_low = auth.uid() or c.user_high = auth.uid()))], array[]::uuid[]);
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return private.write_peer_message(p_conversation_id, p_body, null, null) - 'officerStartCreated';
end;
$function$;

create or replace function public.start_officer_conversation(p_officer_user_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(), p_officer_user_id], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return private.write_officer_first_message(p_officer_user_id, p_body, null);
end;
$function$;

create function public.send_reward_peer_message(p_conversation_id uuid, p_body text, p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(), (select case when c.user_low = auth.uid() then c.user_high else c.user_low end
    from public.member_peer_conversations c
    where c.id = p_conversation_id and (c.user_low = auth.uid() or c.user_high = auth.uid()))], array[]::uuid[]);
  if p_operation_id is null then
    raise exception 'message unavailable' using errcode = '22023';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return private.write_peer_message(p_conversation_id, p_body, p_operation_id, null) - 'officerStartCreated';
end;
$function$;

create function public.start_officer_conversation(p_officer_user_id uuid, p_body text, p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(), p_officer_user_id], array[]::uuid[]);
  if p_operation_id is null then
    raise exception 'message unavailable' using errcode = '22023';
  end if;
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return private.write_officer_first_message(p_officer_user_id, p_body, p_operation_id);
end;
$function$;

revoke all on function public.send_reward_peer_message(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.send_reward_peer_message(uuid, text, uuid) to authenticated;
revoke all on function public.start_officer_conversation(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.start_officer_conversation(uuid, text, uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
