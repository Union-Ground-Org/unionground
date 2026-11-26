-- UB-MSG-03: members may open their first direct steward thread. The first
-- message and conversation are one transaction; an empty shell can never be
-- stranded, and concurrent starts serialize on the member identity.

create function public.start_member_conversation(p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''), E' \t\n\r\f\v');
  conversation_id uuid;
  sent jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'message must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  if exists (select 1 from public.member_conversations c where c.user_id = caller) then
    raise exception 'a direct conversation already exists' using errcode = '23505';
  end if;

  insert into public.member_conversations (user_id, title, initials)
  values (caller, 'Chapter steward', 'CS')
  returning id into conversation_id;

  -- Reuse the current sole message writer so trimming, sender derivation,
  -- points minting, and the conversation touch retain one definition.
  sent := public.send_member_message(conversation_id, clean_body);
  return sent || pg_catalog.jsonb_build_object('conversationId', conversation_id);
end;
$$;

revoke all on function public.start_member_conversation(text) from public, anon;
grant execute on function public.start_member_conversation(text) to authenticated;
