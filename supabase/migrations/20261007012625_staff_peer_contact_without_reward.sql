-- BUG-UG-STAFF-MESSAGES-TO-CHAPTER-STEWARD-UNDELIVERED-20261003
-- Owner October 6: current staff in the same organization and chapter may
-- request contact without a reward; exact codes, consent and permission
-- checks remain. Existing ordinary reward requests and accepted conversations
-- retain their behavior. No directory, role grant or cross-tenant scope.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
do $predecessors$ begin
if (select md5(prosrc) from pg_proc where oid='public.list_reward_peer_contact()'::regprocedure) is distinct from '404cbece34b411a5ce20180db48eae25' then raise exception 'unreviewed list_reward_peer_contact predecessor' using errcode='55000'; end if;
if (select md5(prosrc) from pg_proc where oid='public.request_reward_peer_contact(text)'::regprocedure) is distinct from '5ae7a2a6513f894ef440cedbb0ad209f' then raise exception 'unreviewed request_reward_peer_contact predecessor' using errcode='55000'; end if;
if (select md5(prosrc) from pg_proc where oid='public.respond_reward_peer_contact(uuid,boolean)'::regprocedure) is distinct from '2bd45b9e8bb3b58ca6af717da87e046a' then raise exception 'unreviewed respond_reward_peer_contact predecessor' using errcode='55000'; end if;
end; $predecessors$;

alter table public.member_peer_contact_requests add column staff_authorized boolean not null default false;

create function private.member_peer_staff_eligible(p_user_id uuid, p_chapter_id text)
returns boolean language sql stable security definer set search_path = ''
as $staff$
  select exists (
    select 1 from public.member_profiles profile
    join auth.users account on account.id = profile.id
    join public.chapters chapter on chapter.id = profile.chapter_id
    join public.organizations organization on organization.id = chapter.organization_id and organization.status = 'active'
    join public.organization_memberships om on om.user_id = profile.id and om.organization_id = organization.id and om.status = 'active'
    join public.member_chapter_memberships cm on cm.user_id = profile.id and cm.chapter_id = chapter.id and cm.status = 'active'
    where profile.id = p_user_id and chapter.id = p_chapter_id
      and account.deleted_at is null and coalesce(account.banned_until, '-infinity'::timestamptz) <= now()
      and not exists (select 1 from private.member_mfa_recovery_locks recovery where recovery.user_id = profile.id)
      and (
        exists (select 1 from public.organization_role_grants grant_row where grant_row.user_id = profile.id
          and grant_row.organization_id = organization.id and grant_row.role in ('steward','coordinator','advisor','admin','vp'))
        or exists (select 1 from public.member_role_chapters grant_row where grant_row.user_id = profile.id
          and grant_row.chapter_id = chapter.id and grant_row.role in ('steward','coordinator','advisor','admin','vp'))
      )
      and (not private.staff_mfa_required(organization.id) or private.has_second_factor(profile.id)
        -- The caller's key assurance must belong to the current JWT. A peer
        -- has no caller JWT here, so only that peer may use its own live key.
        or (profile.id is distinct from (select auth.uid())
          and exists (select 1 from private.verified_key_sessions key_session where key_session.user_id = profile.id
            and private.verified_key_session(profile.id, key_session.session_id))))
  );
$staff$;
revoke all on function private.member_peer_staff_eligible(uuid,text) from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_reward_peer_contact()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
          -- Accepted consent survives a later chapter move, so both the
          -- conversation and the minimal name/initials label remain visible
          -- to its two participants. Pending labels above fail closed as soon
          -- as either profile leaves the request chapter.
          private.member_peer_profile_label(
            case when c.user_low = caller then c.user_high else c.user_low end) as label
        from public.member_peer_conversations c
        where c.user_low = caller or c.user_high = caller
        order by c.updated_at desc
        limit 50
      ) conversation
    ), '[]'::jsonb)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.request_reward_peer_contact(p_contact_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
         where r.requester_id = caller and r.created_at >= now() - interval '24 hours') >= 3 then
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
     or (not private.member_reward_effect_enabled(caller, 'im-anyone')
       and not (private.member_peer_staff_eligible(caller, caller_chapter)
         and private.member_peer_staff_eligible(target, caller_chapter))) then
    return pg_catalog.jsonb_build_object('requested', false, 'reason', 'contact request unavailable');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'peer-contact-pair:' || least(caller, target)::text || ':' || greatest(caller, target)::text, 0));

  if exists (
    select 1 from public.member_peer_conversations c
    where c.user_low = least(caller, target) and c.user_high = greatest(caller, target)
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

CREATE OR REPLACE FUNCTION public.respond_reward_peer_contact(p_request_id uuid, p_accept boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      'messages', '[]'::jsonb));
end;
end;
$function$;

commit;
