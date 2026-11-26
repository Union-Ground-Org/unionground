-- BUG-UG-TWO-PERSON-CONVERSATIONS-HAVE-NO-LEAVE-OR-BLOCK-RULE-20261118 (#9189).
--
-- A private two-person conversation (public.member_peer_*) stayed open for
-- writing for good: a person who left the organization or the chapter could
-- still be written to, and neither person could block the other. Ruling (c),
-- both (project decision 2026-11-19 00:13 ET, applied recommendation): a
-- conversation closes for writing when either person leaves the organization,
-- and the chapter for a chapter conversation; either person can block the
-- other.
--
--   * public.member_peer_conversations.scope: 'chapter' (the code request and
--     the officer route) or 'organization' (the cross-chapter route). The
--     backfill marks a conversation 'organization' when any contact request
--     of the pair carries cross_chapter_contact.
--   * private.member_peer_in_scope(user, scope, chapter): the account can sign
--     in (not deleted, not suspended), the organization is active and the
--     person is an active member of it, and for a chapter conversation also an
--     active member of that chapter or an organization administrator. It is
--     read live at every send, so a person who comes back reopens the
--     conversation by themselves.
--   * private.member_peer_blocks: one row per blocker and blocked person, read
--     only by these functions. A block outlives leaving and coming back; it
--     goes with an unblock or with either account.
--   * private.member_peer_conversation_state(conversation, viewer): 'open',
--     'closed' or 'blocked_by_viewer'. The blocked person sees 'closed', the
--     same state, refusal and list omissions as when the other person left.
--   * public.send_reward_peer_message, the one writer of member_peer_messages,
--     refuses unless the state is 'open' (22023 'message unavailable', detail
--     peer_conversation_closed). No row is written, so no notice either.
--   * public.set_peer_conversation_block(conversation, blocked).
--   * The routes that open or reuse a conversation leave out a blocked pair,
--     and re-scope a reused conversation that is closed only by scope, since
--     the route's own fresh check is the new consent. The connected-workflow
--     shortcut offers route peer only for an open conversation; the steward
--     routes are unchanged, so a person blocked by an officer keeps the
--     steward route and every other officer.
--
-- Reading is unchanged: each participant still lists and reads the whole
-- conversation, open or not. This reverses the August 12, 2026 note that
-- accepted consent survives a later chapter move: a chapter conversation now
-- closes for writing when either person's membership of that chapter ends.
-- On its first day the migration closes the conversations where a person has
-- already left; that is intended.
--
-- Hosted application: SAMPLE first, then production.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $predecessors$ begin
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.send_reward_peer_message(uuid,text)'::regprocedure) is distinct from '0216fdad0922eb6f9b60ccc5d79fdb34' then
  raise exception 'unreviewed send_reward_peer_message predecessor' using errcode = '55000';
end if;
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.list_reward_peer_contact()'::regprocedure) is distinct from '64094bcb7661f6d018b6a41d75c206c8' then
  raise exception 'unreviewed list_reward_peer_contact predecessor' using errcode = '55000';
end if;
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.request_reward_peer_contact(text)'::regprocedure) is distinct from '9884e6d32522e791af479ab859ecfacf' then
  raise exception 'unreviewed request_reward_peer_contact predecessor' using errcode = '55000';
end if;
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.respond_reward_peer_contact(uuid,boolean)'::regprocedure) is distinct from 'b171a1f89ea333740a3b53fdd96e864f' then
  raise exception 'unreviewed respond_reward_peer_contact predecessor' using errcode = '55000';
end if;
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.start_officer_conversation(uuid,text)'::regprocedure) is distinct from 'c946962ba41cbdabc8675f4b96eac9eb' then
  raise exception 'unreviewed start_officer_conversation predecessor' using errcode = '55000';
end if;
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'private.member_contactable_officer_ids()'::regprocedure) is distinct from 'b66c3700116ca04855f111d6e99a0a9d' then
  raise exception 'unreviewed member_contactable_officer_ids predecessor' using errcode = '55000';
end if;
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.send_cross_chapter_peer_message(uuid[],text)'::regprocedure) is distinct from 'af3cec76cf7e9d03e80dea4f729657f3' then
  raise exception 'unreviewed send_cross_chapter_peer_message predecessor' using errcode = '55000';
end if;
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'private.cross_chapter_reachable_peers(uuid)'::regprocedure) is distinct from '7eb0dea17d912ca1080788df9c70cb3e' then
  raise exception 'unreviewed cross_chapter_reachable_peers predecessor' using errcode = '55000';
end if;
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'private.cw_task_recipients(uuid,uuid)'::regprocedure) is distinct from '905821d01e370042ac45438584950441' then
  raise exception 'unreviewed cw_task_recipients predecessor' using errcode = '55000';
end if;
end; $predecessors$;

-- ---------------------------------------------------------------------------
-- 1. The conversation's scope, and its backfill.
alter table public.member_peer_conversations
  add column scope text not null default 'chapter'
  constraint member_peer_conversations_scope_choice check (scope in ('chapter', 'organization'));
comment on column public.member_peer_conversations.scope is
  'BUG-UG-TWO-PERSON-CONVERSATIONS-HAVE-NO-LEAVE-OR-BLOCK-RULE-20261118 (#9189): chapter (code request, officer route) closes for writing when either person leaves chapter_id or the organization; organization (cross-chapter route) closes only when either person leaves the organization of chapter_id. An organization administrator is in scope of every chapter conversation of that organization.';

update public.member_peer_conversations c
set scope = 'organization'
where exists (
  select 1 from public.member_peer_contact_requests r
  where least(r.requester_id, r.recipient_id) = c.user_low
    and greatest(r.requester_id, r.recipient_id) = c.user_high
    and r.cross_chapter_contact);

-- ---------------------------------------------------------------------------
-- 2. The block.
create table private.member_peer_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (blocker_id, blocked_id),
  constraint member_peer_blocks_not_self check (blocker_id <> blocked_id)
);
create index member_peer_blocks_blocked_idx on private.member_peer_blocks (blocked_id, blocker_id);
alter table private.member_peer_blocks enable row level security;
alter table private.member_peer_blocks force row level security;
revoke all on table private.member_peer_blocks from public, anon, authenticated, service_role;
create trigger a00_case_graph_lock before insert or update or delete on private.member_peer_blocks
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_peer_blocks
for each row execute function private.lock_case_graph_row_keys('{blocked_id},{blocker_id}', '');
comment on table private.member_peer_blocks is
  'BUG-UG-TWO-PERSON-CONVERSATIONS-HAVE-NO-LEAVE-OR-BLOCK-RULE-20261118 (#9189): blocker_id blocked blocked_id. No new two-person message either way and no new conversation through any route while a row exists. Read only by security definer functions; the blocked person is never told.';

-- ---------------------------------------------------------------------------
-- 3. The predicates.

-- Whether p_user may still write in a conversation of p_scope on p_chapter.
-- A chapter that belongs to no organization keeps the chapter test only.
create function private.member_peer_in_scope(p_user uuid, p_scope text, p_chapter text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from auth.users account
    join public.chapters chapter on chapter.id = p_chapter
    left join public.organizations organization on organization.id = chapter.organization_id
    where account.id = p_user
      and account.deleted_at is null
      and coalesce(account.banned_until, '-infinity'::timestamptz) <= pg_catalog.now()
      and case
        when chapter.organization_id is null then
          exists (select 1 from public.member_chapter_memberships own
            where own.user_id = p_user and own.chapter_id = p_chapter and own.status = 'active')
        else
          organization.status = 'active'
          and exists (select 1 from public.organization_memberships om
            where om.organization_id = chapter.organization_id and om.user_id = p_user and om.status = 'active')
          and (p_scope = 'organization'
            or exists (select 1 from public.member_chapter_memberships own
              where own.user_id = p_user and own.chapter_id = p_chapter and own.status = 'active')
            or exists (select 1 from public.organization_role_grants g
              where g.organization_id = chapter.organization_id and g.user_id = p_user and g.role = 'admin'))
      end)
$function$;
revoke all on function private.member_peer_in_scope(uuid, text, text) from public, anon, authenticated, service_role;

-- A block in either direction between two people.
create function private.member_peer_pair_blocked(p_one uuid, p_two uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from private.member_peer_blocks b
    where (b.blocker_id = p_one and b.blocked_id = p_two)
       or (b.blocker_id = p_two and b.blocked_id = p_one))
$function$;
revoke all on function private.member_peer_pair_blocked(uuid, uuid) from public, anon, authenticated, service_role;

-- What the viewer may do in the conversation: 'open', 'closed', or
-- 'blocked_by_viewer' when the viewer's own block holds it. A block by the
-- other person reads 'closed', exactly as leaving does. Null for a
-- non-participant.
create function private.member_peer_conversation_state(p_conversation uuid, p_viewer uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when exists (select 1 from private.member_peer_blocks b
      where b.blocker_id = p_viewer and b.blocked_id = peer.id) then 'blocked_by_viewer'
    when exists (select 1 from private.member_peer_blocks b
      where b.blocker_id = peer.id and b.blocked_id = p_viewer)
      or not private.member_peer_in_scope(p_viewer, c.scope, c.chapter_id)
      or not private.member_peer_in_scope(peer.id, c.scope, c.chapter_id) then 'closed'
    else 'open'
  end
  from public.member_peer_conversations c
  cross join lateral (select case when c.user_low = p_viewer then c.user_high else c.user_low end as id) peer
  where c.id = p_conversation
    and p_viewer is not null
    and (c.user_low = p_viewer or c.user_high = p_viewer)
$function$;
revoke all on function private.member_peer_conversation_state(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The one writer refuses a conversation that is not open.
create or replace function public.send_reward_peer_message(p_conversation_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
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
  message_id_value uuid;
  created_at_value timestamptz;
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

  -- Closed when either person left (the organization, or the chapter of a
  -- chapter conversation) or either person blocked the other. The blocked
  -- person gets this same refusal (#9189).
  if private.member_peer_conversation_state(conversation_row.id, caller) is distinct from 'open' then
    raise exception 'message unavailable' using errcode = '22023', detail = 'peer_conversation_closed';
  end if;

  if (select pg_catalog.count(*) from public.member_peer_messages m
      where m.sender_id = caller and m.created_at >= now() - interval '5 minutes') >= 20 then
    raise exception 'message unavailable' using errcode = '22023';
  end if;

  insert into public.member_peer_messages (conversation_id, sender_id, body)
  values (conversation_row.id, caller, clean_body)
  returning id, created_at into message_id_value, created_at_value;

  update public.member_peer_conversations
  set updated_at = created_at_value
  where id = conversation_row.id;

  return pg_catalog.jsonb_build_object(
    'message', pg_catalog.jsonb_build_object(
      'id', message_id_value,
      'sentByMe', true,
      'body', clean_body,
      'createdAt', created_at_value));
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. The list carries each conversation's state.
create or replace function public.list_reward_peer_contact()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'available', true,
    'canRequest', private.member_reward_effect_enabled(caller, 'im-anyone')
      or private.member_peer_staff_eligible(caller, private.current_member_chapter()),
    'code', private.member_peer_contact_code(caller),
    'incoming', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', incoming.id,
        'requesterName', incoming.label ->> 'name',
        'requesterInitials', incoming.label ->> 'initials',
        'createdAt', incoming.created_at,
        'expiresAt', incoming.expires_at
      ) order by incoming.created_at desc)
      from (
        select r.id, r.created_at, r.expires_at,
          private.member_peer_profile_label(r.requester_id) as label
        from public.member_peer_contact_requests r
        where r.recipient_id = caller
          and r.status = 'pending'
          and r.expires_at > now()
          and r.chapter_id = private.current_member_chapter()
          and exists (
            select 1 from public.member_profiles p
            where p.id = r.requester_id and p.chapter_id = r.chapter_id
          )
          -- A requester who left, or a blocked pair, is left out alike (#9189).
          and private.member_peer_in_scope(r.requester_id, 'chapter', r.chapter_id)
          and not private.member_peer_pair_blocked(r.requester_id, caller)
        order by r.created_at desc
        limit 20
      ) incoming
    ), '[]'::jsonb),
    -- Pending/declined requests deliberately contain no recipient identity.
    'outgoing', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', outgoing.id,
        'status', outgoing.status,
        'createdAt', outgoing.created_at,
        'expiresAt', outgoing.expires_at
      ) order by outgoing.created_at desc)
      from (
        select r.id,
          case when r.status = 'pending' and r.expires_at <= now() then 'expired' else r.status end as status,
          r.created_at, r.expires_at
        from public.member_peer_contact_requests r
        where r.requester_id = caller
          and r.created_at >= now() - interval '90 days'
        order by r.created_at desc
        limit 20
      ) outgoing
    ), '[]'::jsonb),
    'conversations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', conversation.id,
        'peerName', conversation.label ->> 'name',
        'peerInitials', conversation.label ->> 'initials',
        'updatedAt', conversation.updated_at,
        'state', conversation.state,
        'messages', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', message.id,
            'sentByMe', message.sender_id = caller,
            'body', message.body,
            'createdAt', message.created_at
          ) order by message.created_at, message.id)
          from (
            select m.id, m.sender_id, m.body, m.created_at
            from public.member_peer_messages m
            where m.conversation_id = conversation.id
            order by m.created_at desc, m.id desc
            limit 100
          ) message
        ), '[]'::jsonb)
      ) order by conversation.updated_at desc)
      from (
        select c.id, c.updated_at,
          -- Both participants keep reading the conversation and the minimal
          -- name/initials label whether it is open or closed; state says
          -- whether either may still write (#9189). Pending labels above fail
          -- closed as soon as either profile leaves the request chapter.
          private.member_peer_profile_label(
            case when c.user_low = caller then c.user_high else c.user_low end) as label,
          private.member_peer_conversation_state(c.id, caller) as state
        from public.member_peer_conversations c
        where c.user_low = caller or c.user_high = caller
        order by c.updated_at desc
        limit 50
      ) conversation
    ), '[]'::jsonb)
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. The code request: a blocked pair is refused flatly; a conversation
-- closed only by scope no longer stops a new request.
create or replace function public.request_reward_peer_contact(p_contact_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(), (select k.user_id from public.member_peer_contact_keys k
    where private.mfa_satisfied() and k.code_digest = extensions.digest(pg_catalog.convert_to(
      pg_catalog.upper(pg_catalog.btrim(coalesce(p_contact_code, ''))), 'UTF8'), 'sha256'))], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  normalized_code text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_contact_code, '')));
  target uuid;
  target_chapter text;
  created_id uuid;
  created_at_value timestamptz;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- One caller lock makes the 24-hour limit exact even under two connections.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('peer-contact-caller:' || caller::text, 0));

  -- Every eligibility/code/scope/cooldown refusal is the same response and
  -- performs no write. In particular, an exact-code miss leaves no audit row
  -- containing the submitted plaintext or a derived identifier.
  if normalized_code !~ '^UG-[0-9A-F]{20}$'
     or (not private.member_reward_effect_enabled(caller, 'im-anyone')
       and not private.member_peer_staff_eligible(caller, private.current_member_chapter()))
     or (select pg_catalog.count(*) from public.member_peer_contact_requests r
         where r.requester_id = caller and not r.cross_chapter_contact
           and r.created_at >= now() - interval '24 hours') >= 3 then
    return pg_catalog.jsonb_build_object('requested', false, 'reason', 'contact request unavailable');
  end if;

  select k.user_id into target
  from public.member_peer_contact_keys k
  where k.code_digest = extensions.digest(
    pg_catalog.convert_to(normalized_code, 'UTF8'), 'sha256');

  if target is null or target = caller then
    return pg_catalog.jsonb_build_object('requested', false, 'reason', 'contact request unavailable');
  end if;

  -- Lock both exact profile rows in UUID order before deriving chapter scope.
  -- A concurrent member move/delete therefore completes first (and this call
  -- sees the new scope) or waits until this request decision commits.
  perform p.id
  from public.member_profiles p
  where p.id in (caller, target)
  order by p.id
  for share;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  select p.chapter_id into target_chapter
  from public.member_profiles p where p.id = target;

  if caller_chapter is null or target_chapter is distinct from caller_chapter
     -- Both must still be in that chapter (an active organization and
     -- chapter membership, an account that can sign in), so a request to a
     -- person who left or is suspended is refused exactly as one to a blocked
     -- pair is (#9189 round 1).
     or not private.member_peer_in_scope(caller, 'chapter', caller_chapter)
     or not private.member_peer_in_scope(target, 'chapter', caller_chapter)
     or (not private.member_reward_effect_enabled(caller, 'im-anyone')
       and not (private.member_peer_staff_eligible(caller, caller_chapter)
         and private.member_peer_staff_eligible(target, caller_chapter))) then
    return pg_catalog.jsonb_build_object('requested', false, 'reason', 'contact request unavailable');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'peer-contact-pair:' || least(caller, target)::text || ':' || greatest(caller, target)::text, 0));

  -- A blocked pair, or a conversation either may still write in, refuses; a
  -- conversation closed only because a person left its chapter does not, so
  -- a pair who are both in one chapter again can renew contact (#9189).
  if private.member_peer_pair_blocked(caller, target) or exists (
    select 1 from public.member_peer_conversations c
    where c.user_low = least(caller, target) and c.user_high = greatest(caller, target)
      and private.member_peer_conversation_state(c.id, caller) = 'open'
  ) or exists (
    -- Pair requests are limited to one every 14 days in either direction.
    select 1 from public.member_peer_contact_requests r
    where least(r.requester_id, r.recipient_id) = least(caller, target)
      and greatest(r.requester_id, r.recipient_id) = greatest(caller, target)
      and r.created_at >= now() - interval '14 days'
  ) then
    return pg_catalog.jsonb_build_object('requested', false, 'reason', 'contact request unavailable');
  end if;

  insert into public.member_peer_contact_requests (requester_id, recipient_id, chapter_id, staff_authorized)
  values (caller, target, caller_chapter, not private.member_reward_effect_enabled(caller, 'im-anyone'))
  returning id, created_at into created_id, created_at_value;

  return pg_catalog.jsonb_build_object(
    'requested', true,
    'id', created_id,
    'status', 'pending',
    'createdAt', created_at_value);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Accepting: a blocked pair or a requester who left is refused; accepting
-- into a closed conversation re-scopes it to the request's chapter.
create or replace function public.respond_reward_peer_contact(p_request_id uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(), (select r.requester_id from public.member_peer_contact_requests r
    where private.mfa_satisfied() and r.id = p_request_id and r.recipient_id = auth.uid())], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  request_row public.member_peer_contact_requests%rowtype;
  conversation_id_value uuid;
  peer_label jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select r.* into request_row
  from public.member_peer_contact_requests r
  where r.id = p_request_id
    and r.recipient_id = caller
    and r.status = 'pending'
    and r.expires_at > now()
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('accepted', false, 'reason', 'contact request unavailable');
  end if;

  -- The request row is locked above; lock both participant profiles in the
  -- same deterministic order used by request creation before rechecking their
  -- live chapter membership. Moves/deletes cannot slip between check+accept.
  perform p.id
  from public.member_profiles p
  where p.id in (request_row.requester_id, request_row.recipient_id)
  order by p.id
  for share;

  if request_row.chapter_id is distinct from private.current_member_chapter()
     or request_row.chapter_id is distinct from (
       select p.chapter_id from public.member_profiles p where p.id = request_row.requester_id
     ) then
    return pg_catalog.jsonb_build_object('accepted', false, 'reason', 'contact request unavailable');
  end if;

  -- As the incoming list: a requester who left, or a blocked pair, cannot be
  -- accepted (#9189). A decline stays possible.
  if coalesce(p_accept, false)
     and (not private.member_peer_in_scope(request_row.requester_id, 'chapter', request_row.chapter_id)
       or private.member_peer_pair_blocked(request_row.requester_id, request_row.recipient_id)) then
    return pg_catalog.jsonb_build_object('accepted', false, 'reason', 'contact request unavailable');
  end if;

  -- Only staff exceptions revalidate staff at acceptance. Existing reward
  -- requests keep their prior consent behavior if a reward later expires.
  if coalesce(p_accept, false) and request_row.staff_authorized
     and not (private.member_peer_staff_eligible(request_row.requester_id, request_row.chapter_id)
       and private.member_peer_staff_eligible(request_row.recipient_id, request_row.chapter_id)) then
    return pg_catalog.jsonb_build_object('accepted', false, 'reason', 'contact request unavailable');
  end if;

  if not coalesce(p_accept, false) then
    update public.member_peer_contact_requests
    set status = 'declined', responded_at = now()
    where id = request_row.id;
    return pg_catalog.jsonb_build_object('accepted', false, 'declined', true);
  end if;

  insert into public.member_peer_conversations (
    chapter_id, user_low, user_high, created_from_request)
  values (
    request_row.chapter_id,
    least(request_row.requester_id, request_row.recipient_id),
    greatest(request_row.requester_id, request_row.recipient_id),
    request_row.id)
  on conflict (user_low, user_high) do update
    set updated_at = public.member_peer_conversations.updated_at
  returning id into conversation_id_value;

  -- The pair's older conversation, closed because a person left its chapter,
  -- now belongs to the chapter this fresh consent was given in (#9189).
  update public.member_peer_conversations c
  set chapter_id = request_row.chapter_id, scope = 'chapter'
  where c.id = conversation_id_value
    and private.member_peer_conversation_state(c.id, caller) is distinct from 'open';

  update public.member_peer_contact_requests
  set status = 'accepted', responded_at = now()
  where id = request_row.id;

  peer_label := private.member_peer_profile_label(request_row.requester_id);
  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'conversation', pg_catalog.jsonb_build_object(
      'id', conversation_id_value,
      'peerName', peer_label ->> 'name',
      'peerInitials', peer_label ->> 'initials',
      'updatedAt', now(),
      'state', private.member_peer_conversation_state(conversation_id_value, caller),
      -- Accepting into the pair's older conversation keeps its history on
      -- screen, bounded as in list_reward_peer_contact (#9189 round 1).
      'messages', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', message.id,
          'sentByMe', message.sender_id = caller,
          'body', message.body,
          'createdAt', message.created_at
        ) order by message.created_at, message.id)
        from (
          select m.id, m.sender_id, m.body, m.created_at
          from public.member_peer_messages m
          where m.conversation_id = conversation_id_value
          order by m.created_at desc, m.id desc
          limit 100
        ) message
      ), '[]'::jsonb)));
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 8. The officer route: a blocked pair is not contactable; a reused
-- conversation closed only by scope is re-scoped to the caller's chapter.
create or replace function private.member_contactable_officer_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select leader.id
  from public.member_profiles caller_profile
  join public.chapters chapter
    on chapter.id = caller_profile.chapter_id
   and chapter.organization_id = (select private.current_member_organization())
  join public.member_chapter_memberships own
    on own.user_id = caller_profile.id
   and own.chapter_id = chapter.id
   and own.status = 'active'
  cross join lateral private.chapter_leadership_people(chapter.organization_id, chapter.id) leader
  join auth.users account on account.id = leader.id
  where caller_profile.id = (select auth.uid())
    and (select private.mfa_satisfied())
    and leader.id <> caller_profile.id
    and account.deleted_at is null
    and coalesce(account.banned_until, '-infinity'::timestamptz) <= pg_catalog.now()
    -- A block either way leaves only that officer out (#9189).
    and not private.member_peer_pair_blocked(caller_profile.id, leader.id)
$function$;

create or replace function public.start_officer_conversation(p_officer_user_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
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
  else
    -- The officer is listed for the caller's chapter now, so a reused
    -- conversation closed only because a person left its chapter belongs to
    -- that chapter from here on (#9189). A blocked pair never gets here.
    update public.member_peer_conversations c
    set chapter_id = caller_chapter, scope = 'chapter'
    where c.id = conversation_id_value
      and private.member_peer_conversation_state(c.id, caller) is distinct from 'open';
  end if;

  -- The sole member-conversation writer: trimming, the per-sender limit and
  -- the conversation touch keep one definition. A refusal rolls back the new
  -- conversation with it.
  sent := public.send_reward_peer_message(conversation_id_value, clean_body);
  officer_label := private.member_peer_profile_label(p_officer_user_id);

  return pg_catalog.jsonb_build_object(
    'created', created,
    'message', sent -> 'message',
    'conversation', pg_catalog.jsonb_build_object(
      'id', conversation_id_value,
      'peerName', officer_label ->> 'name',
      'peerInitials', officer_label ->> 'initials',
      'updatedAt', sent -> 'message' -> 'createdAt'));
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 9. The cross-chapter route: a blocked pair is not reachable either way; a
-- reused conversation that is not open becomes an organization conversation.
create or replace function private.cross_chapter_reachable_peers(p_caller uuid)
returns table(user_id uuid, role text, chapter_id text, chapter_name text)
language sql
stable
security definer
set search_path = ''
as $function$
  select holder.user_id, mine.role, holder.chapter_id, holder.chapter_name
  from private.cross_chapter_peer_caller_levels(p_caller) mine
  cross join lateral private.cross_chapter_peer_holders(mine.organization_id, mine.role) holder
  where holder.chapter_id <> mine.chapter_id
    and holder.user_id <> p_caller
    and not exists (select 1 from private.cross_chapter_peer_mutes mute where mute.user_id = holder.user_id)
    -- A block either way leaves that person out, as a mute does (#9189).
    and not private.member_peer_pair_blocked(p_caller, holder.user_id)
$function$;

create or replace function public.send_cross_chapter_peer_message(p_recipient_ids uuid[], p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- At most 21 identity locks: a longer list is refused just below.
  perform private.lock_case_graph(array[auth.uid()] || p_recipient_ids[1:20], array[]::uuid[]);
  if p_recipient_ids is null
     or pg_catalog.cardinality(p_recipient_ids) not between 1 and 20
     or (select pg_catalog.count(distinct id) from pg_catalog.unnest(p_recipient_ids) id where id is not null)
        <> pg_catalog.cardinality(p_recipient_ids) then
    raise exception 'choose between 1 and 20 people' using errcode = '22023', detail = 'cross_chapter_recipients';
  end if;
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11));
  caller_chapter text;
  recipient uuid;
  conversation_id_value uuid;
  request_id_value uuid;
  created_count integer := 0;
  sent jsonb;
  peer_label jsonb;
  results jsonb := '[]'::jsonb;
begin
  if caller is null or not private.mfa_satisfied()
     or private.current_member_organization() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'message must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  -- Same lock order as public.start_officer_conversation: caller, then the
  -- profiles in UUID order, then each pair.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('peer-contact-caller:' || caller::text, 0));

  perform p.id
  from public.member_profiles p
  where p.id = caller or p.id = any(p_recipient_ids)
  order by p.id
  for share;

  -- One refusal for every recipient the caller may not reach: another
  -- organization, a level that is not enabled or that the caller does not
  -- hold, the caller's own chapter, a muted person, a blocked pair or an
  -- account that cannot sign in. Nothing has been written yet.
  if exists (
    select 1 from pg_catalog.unnest(p_recipient_ids) wanted(id)
    where not exists (
      select 1 from private.cross_chapter_reachable_peers(caller) peer where peer.user_id = wanted.id)
  ) then
    raise exception 'peer unavailable' using errcode = '42501', detail = 'cross_chapter_peer_unavailable';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;

  for recipient in select id from pg_catalog.unnest(p_recipient_ids) with ordinality as wanted(id, position) order by position loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'peer-contact-pair:' || least(caller, recipient)::text || ':' || greatest(caller, recipient)::text, 0));

    conversation_id_value := null;
    select c.id into conversation_id_value
    from public.member_peer_conversations c
    where c.user_low = least(caller, recipient)
      and c.user_high = greatest(caller, recipient);

    if conversation_id_value is null then
      insert into public.member_peer_contact_requests (
        requester_id, recipient_id, chapter_id, status, responded_at, cross_chapter_contact)
      values (caller, recipient, caller_chapter, 'accepted', pg_catalog.now(), true)
      returning id into request_id_value;

      insert into public.member_peer_conversations (chapter_id, user_low, user_high, created_from_request, scope)
      values (caller_chapter, least(caller, recipient), greatest(caller, recipient), request_id_value, 'organization')
      returning id into conversation_id_value;
      created_count := created_count + 1;
    else
      -- Both hold an enabled level in this organization now, so a reused
      -- conversation that is not open becomes an organization conversation
      -- (#9189). A blocked pair is not reachable, so never gets here.
      update public.member_peer_conversations c
      set chapter_id = caller_chapter, scope = 'organization'
      where c.id = conversation_id_value
        and private.member_peer_conversation_state(c.id, caller) is distinct from 'open';
    end if;

    -- The sole member-conversation writer: trimming, the per-sender limit
    -- and the conversation touch keep one definition. A refusal rolls the
    -- whole send back.
    sent := public.send_reward_peer_message(conversation_id_value, clean_body);
    peer_label := private.member_peer_profile_label(recipient);
    results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'id', conversation_id_value,
      'peerName', peer_label ->> 'name',
      'peerInitials', peer_label ->> 'initials',
      'updatedAt', sent -> 'message' -> 'createdAt',
      'message', sent -> 'message'));
  end loop;

  -- New cross-chapter conversations are bounded per day, existing ones are
  -- not; counted after the inserts so one send cannot pass the bound.
  if created_count > 0 and (select pg_catalog.count(*) from public.member_peer_contact_requests r
      where r.requester_id = caller and r.cross_chapter_contact
        and r.created_at >= pg_catalog.now() - interval '24 hours') > 60 then
    raise exception 'cross-chapter contact limit' using errcode = '22023', detail = 'cross_chapter_contact_limit';
  end if;

  return pg_catalog.jsonb_build_object('created', created_count, 'conversations', results);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 10. The connected-workflow shortcut offers route peer only while open.
create or replace function private.cw_task_recipients(p_actor uuid, p_task uuid)
returns table(rid uuid, rlabel text, rvia text, rtarget uuid)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  task_row public.chapter_tasks%rowtype;
  actor_chapter text;
  counterpart uuid;
  steward_ready boolean;
begin
  select tk.* into task_row from public.chapter_tasks tk where tk.id = p_task and tk.deleted_at is null;
  if not found then return; end if;
  select p.chapter_id into actor_chapter from public.member_profiles p where p.id = p_actor;
  if actor_chapter is null or actor_chapter is distinct from task_row.chapter_id then return; end if;
  -- Only the task's own people (creator, assignee) or chapter staff may enumerate
  -- its audience; a member who merely reads the board is offered no one.
  if not (
    p_actor = task_row.created_by
    or exists (select 1 from public.chapter_task_assignments a
               where a.task_id = task_row.id and a.assignee_id = p_actor)
    or private.member_has_chapter_staff_grant(
         task_row.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
  ) then
    return;
  end if;
  counterpart := case
    when p_actor = task_row.assignee_id then task_row.created_by
    when p_actor = task_row.created_by then task_row.assignee_id end;
  steward_ready := coalesce(public.member_has_role(array['steward']), false);
  return query
  select e.uid, e.label, pick.via, pick.target_id
  from (
    select pr.id as uid,
           coalesce(nullif(pg_catalog.btrim(pr.full_name), ''), 'Member') as label
    from (
      select task_row.created_by as uid
      union
      select a.assignee_id from public.chapter_task_assignments a where a.task_id = task_row.id
    ) part
    join public.member_profiles pr on pr.id = part.uid and pr.chapter_id = task_row.chapter_id
    where part.uid is not null and part.uid <> p_actor
  ) e
  cross join lateral (
    select v.via, v.target_id
    from (
      select 1 as prio, 'task_thread'::text as via, task_row.id as target_id
        where e.uid = counterpart
      union all
      -- peer: offered exactly when public.send_reward_peer_message would
      -- accept, the pair's conversation is open for the actor (neither person
      -- left, neither blocked the other; #9189). Otherwise the steward routes
      -- below still apply, so a person blocked by an officer keeps them.
      select 2, 'peer', c.id
        from public.member_peer_conversations c
        where ((c.user_low = p_actor and c.user_high = e.uid) or (c.user_low = e.uid and c.user_high = p_actor))
          and private.member_peer_conversation_state(c.id, p_actor) = 'open'
      union all
      select 3, 'steward_reply', cv.id
        from public.member_conversations cv
        where steward_ready and cv.user_id = e.uid
          and private.can_actor_send_private_message(p_actor, cv.id, 'steward')
      union all
      select 4, 'steward_start', null::uuid
        where exists (
          select 1 from private.member_roster_stewards_for_chapter(actor_chapter) rs
          where rs.steward_id = e.uid)
    ) v
    order by v.prio, v.target_id
    limit 1
  ) pick;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 11. Block and unblock, from inside a conversation.
create function public.set_peer_conversation_block(p_conversation_id uuid, p_blocked boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(), (select case when c.user_low = auth.uid() then c.user_high else c.user_low end
    from public.member_peer_conversations c
    where private.mfa_satisfied() and c.id = p_conversation_id
      and (c.user_low = auth.uid() or c.user_high = auth.uid()))], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  conversation_row public.member_peer_conversations%rowtype;
  peer uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_blocked is null then
    raise exception 'blocked flag required' using errcode = '22023';
  end if;

  -- The lock public.send_reward_peer_message takes, so a send and a block
  -- on one conversation are ordered.
  select c.* into conversation_row
  from public.member_peer_conversations c
  where c.id = p_conversation_id
    and (c.user_low = caller or c.user_high = caller)
  for update;
  if not found then
    raise exception 'message unavailable' using errcode = '22023', detail = 'peer_conversation_unavailable';
  end if;
  peer := case when conversation_row.user_low = caller then conversation_row.user_high else conversation_row.user_low end;

  if p_blocked then
    insert into private.member_peer_blocks (blocker_id, blocked_id) values (caller, peer)
    on conflict (blocker_id, blocked_id) do nothing;
  else
    delete from private.member_peer_blocks where blocker_id = caller and blocked_id = peer;
  end if;

  return pg_catalog.jsonb_build_object(
    'id', conversation_row.id,
    'state', private.member_peer_conversation_state(conversation_row.id, caller));
end;
end;
$function$;
revoke all on function public.set_peer_conversation_block(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_peer_conversation_block(uuid, boolean) to authenticated;
comment on function public.set_peer_conversation_block(uuid, boolean) is
  'BUG-UG-TWO-PERSON-CONVERSATIONS-HAVE-NO-LEAVE-OR-BLOCK-RULE-20261118 (#9189): the caller blocks or unblocks the other participant of one of their own two-person conversations. Returns the caller''s state. A non-participant gets one flat refusal (peer_conversation_unavailable).';

-- ---------------------------------------------------------------------------
-- 12. Account lifecycle: two CASCADE references to auth.users, reviewed.
-- Not exported, as the cross-chapter mute is not (ledger item 511).
insert into private.account_lifecycle_manifest(schema_name,table_name,user_column,delete_disposition,export_disposition,export_inventory_basis,exclusion_reason,note) values
 ('private','member_peer_blocks','blocker_id','cascade','excluded_with_reason','auth_user_fk','One contact preference with a time; contains no member-authored content.','Removed with either account.'),
 ('private','member_peer_blocks','blocked_id','cascade','excluded_with_reason','auth_user_fk','Another person''s contact preference about this person; never shown to them.','Removed with either account.');
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.schema_name = 'private' and s.table_name = 'member_peer_blocks'
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;
do $assert_peer_conversation_block_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after peer conversation blocks: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after peer conversation blocks';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after peer conversation blocks';
  end if;
end;
$assert_peer_conversation_block_lifecycle$;

notify pgrst, 'reload schema';

commit;
