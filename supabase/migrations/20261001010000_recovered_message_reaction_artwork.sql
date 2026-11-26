-- The recovered choices are additive; historical rows retain their identities.
-- Current function read from two matching disposable schemas at migration
-- 20260928221008. Only the vocabulary changes; case-graph, lifecycle, MFA,
-- source-authorization, advisory locks, security mode and existing ACL remain.
BEGIN;

alter table public.member_message_reactions
  drop constraint member_message_reactions_reaction_check;
alter table public.member_message_reactions
  add constraint member_message_reactions_reaction_check
  check (reaction in ('like','support','celebrate','solidarity','strength','seen','agreed','care','grievance','victory'));

CREATE OR REPLACE FUNCTION public.toggle_member_message_reaction(p_source_kind text, p_message_id uuid, p_reaction text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  removed integer;
  new_id uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_source_kind not in ('private','channel','task')
     or p_reaction not in ('like','support','celebrate','solidarity','strength','seen','agreed','care','grievance','victory')
     or not private.can_read_message_source(
       caller, p_source_kind,
       case when p_source_kind = 'private' then p_message_id end,
       case when p_source_kind = 'channel' then p_message_id end,
       case when p_source_kind = 'task' then p_message_id end) then
    raise exception 'message unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('message-reaction:' || caller::text || ':' || p_message_id::text || ':' || p_reaction, 509));
  delete from public.member_message_reactions r
  where r.actor_id = caller and r.source_kind = p_source_kind and r.reaction = p_reaction
    and coalesce(r.private_message_id, r.channel_post_id, r.task_message_id) = p_message_id;
  get diagnostics removed = row_count;
  if removed > 0 then
    return pg_catalog.jsonb_build_object('reacted', false);
  end if;

  insert into public.member_message_reactions(
    actor_id, source_kind, private_message_id, channel_post_id, task_message_id, reaction)
  values (
    caller, p_source_kind,
    case when p_source_kind = 'private' then p_message_id end,
    case when p_source_kind = 'channel' then p_message_id end,
    case when p_source_kind = 'task' then p_message_id end,
    p_reaction)
  returning id into new_id;
  return pg_catalog.jsonb_build_object('reacted', true, 'id', new_id);
end;
end;
end;
$function$;

COMMIT;
