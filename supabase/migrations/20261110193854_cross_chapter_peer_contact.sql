-- REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109 (#7666).
--
-- A chapter lead could not reach the chapter leads of the organization's
-- other chapters: every two-person conversation (public.member_peer_*) was
-- opened inside one chapter, by a code request or a listed officer of the
-- member's own chapter. Ruling (record comment 6766273827): reuse the
-- two-person conversation model; "several or all" sends the same first
-- message as separate one-to-one conversations, capped per send; no
-- acceptance step between holders of an enabled access level in the same
-- organization; each person can mute it; never across organizations.
--
--   * features.messaging.cross_chapter_peer_roles: the access levels that get
--     cross-chapter contact, an organization setting edited on the existing
--     settings page. Chapter lead ('vp' on a chapter) is on by default;
--     steward is off until an organization administrator adds it.
--   * private.cross_chapter_peer_mutes: one row per person who muted it. A
--     muted person is not listed and no new cross-chapter message reaches
--     them through this route. Conversations already open stay open, as
--     every accepted member conversation does.
--   * public.list_cross_chapter_peers(query, offset, limit): for each enabled
--     level the caller holds in their own chapter, the holders of the same
--     level in the organization's other chapters: name, display title and
--     chapter only, in pages with a name or chapter search, so every one of
--     them can be reached.
--   * public.send_cross_chapter_peer_message(recipients, body): one to twenty
--     listed peers; for each, the pair's conversation is reused or opened
--     (an accepted request row marked cross_chapter_contact) and the message
--     goes through public.send_reward_peer_message, so its limits apply.
--     Any recipient the caller may not reach refuses the whole send, and
--     nothing is written.
--   * public.set_my_cross_chapter_peer_mute(muted).
--   * A role held through an expired or not-yet-started committee scope is not
--     live here (private.chapter_role_scope_expired), as in the staff gates.
--   * New cross-chapter conversations have their own daily allowance and no
--     longer count toward the three a day that public.start_officer_conversation
--     and public.request_reward_peer_contact allow; both are re-emitted with
--     only that count changed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $predecessors$ begin
if (select md5(prosrc) from pg_proc where oid='public.request_reward_peer_contact(text)'::regprocedure) is distinct from 'eba3b3ef3db5e8fffcee45fb2a75379b' then raise exception 'unreviewed request_reward_peer_contact predecessor' using errcode='55000'; end if;
if (select md5(prosrc) from pg_proc where oid='public.start_officer_conversation(uuid,text)'::regprocedure) is distinct from 'ac8debf4585b08ced668a4deef9ff431' then raise exception 'unreviewed start_officer_conversation predecessor' using errcode='55000'; end if;
end; $predecessors$;

-- Union Ground: request_reward_peer_contact below validates 'UG-' codes, so
-- the generator mints 'UG-' (Union Ground) instead of the retired 'PSG-'
-- prefix of 20261014013000. Same HMAC, same secret; only the prefix changes.
create or replace function private.member_peer_contact_code(p_user_id uuid)
returns text
language sql
stable security definer
set search_path = ''
as $function$
  select 'UG-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(
    extensions.hmac(pg_catalog.convert_to(p_user_id::text, 'UTF8'), secret.secret, 'sha256'),
    'hex'), 1, 20))
  from private.member_peer_contact_secret secret
  where secret.id
$function$;
-- The generator is on the reviewed account-lifecycle trigger surface; refresh
-- its fingerprint for the new body.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.kind = 'function' and s.schema_name = 'private' and s.table_name = ''
  and s.object_name = 'member_peer_contact_code(p_user_id uuid)'
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

-- ---------------------------------------------------------------------------
-- 1. The organization setting.
insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.messaging.cross_chapter_peer_roles', 'text_list', 'Cross-chapter contact',
   'Access levels whose holders can message the people with the same access level in the organization''s other chapters, one to one. Chapter lead is on by default; steward is off until an administrator adds it.',
   '["vp"]', 0, 2, array['vp', 'steward'], 90, 'messaging', false)
on conflict (key) do nothing;

create function private.cross_chapter_peer_levels(p_org uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.array_agg(distinct level.role order by level.role), array[]::text[])
  from pg_catalog.unnest(private.organization_setting_text_list(p_org, 'features.messaging.cross_chapter_peer_roles')) as level(role)
  where p_org is not null and level.role in ('vp', 'steward')
$function$;
revoke all on function private.cross_chapter_peer_levels(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The mute.
create table private.cross_chapter_peer_mutes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  muted_at timestamptz not null default pg_catalog.now()
);
alter table private.cross_chapter_peer_mutes enable row level security;
alter table private.cross_chapter_peer_mutes force row level security;
revoke all on table private.cross_chapter_peer_mutes from public, anon, authenticated, service_role;
create trigger a00_case_graph_lock before insert or update or delete on private.cross_chapter_peer_mutes
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.cross_chapter_peer_mutes
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

alter table public.member_peer_contact_requests
  add column cross_chapter_contact boolean not null default false;
comment on column public.member_peer_contact_requests.cross_chapter_contact is
  'REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109: true for the accepted row public.send_cross_chapter_peer_message records when it opens a conversation between holders of the same enabled access level in two chapters of one organization (no code, no acceptance step).';

-- ---------------------------------------------------------------------------
-- 3. Who holds an enabled level, and whom the caller may reach.

-- Holders of p_role on a chapter of p_org whose access is live: the level is
-- enabled for the organization, no expired or not-yet-started committee scope
-- holds it (a unit scope and an unscoped grant stay live), the person is an
-- active member of the organization and of that chapter, the account can sign
-- in, and staff two-step holds where the organization requires it (a second
-- factor, or for anyone but the caller their own live verified-key session).
create function private.cross_chapter_peer_holders(p_org uuid, p_role text)
returns table(user_id uuid, chapter_id text, chapter_name text)
language sql
stable
security definer
set search_path = ''
as $function$
  select rc.user_id, chapter.id, chapter.name
  from public.member_role_chapters rc
  join public.chapters chapter on chapter.id = rc.chapter_id and chapter.organization_id = p_org
  join public.organizations organization on organization.id = p_org and organization.status = 'active'
  join public.organization_memberships om
    on om.user_id = rc.user_id and om.organization_id = p_org and om.status = 'active'
  join public.member_chapter_memberships cm
    on cm.user_id = rc.user_id and cm.chapter_id = chapter.id and cm.status = 'active'
  join auth.users account on account.id = rc.user_id
  where rc.role = p_role
    and p_role = any(private.cross_chapter_peer_levels(p_org))
    and not private.chapter_role_scope_expired(rc.user_id, chapter.id, rc.role)
    and account.deleted_at is null
    and coalesce(account.banned_until, '-infinity'::timestamptz) <= pg_catalog.now()
    and not exists (select 1 from private.member_mfa_recovery_locks recovery where recovery.user_id = rc.user_id)
    and (not private.staff_mfa_required(p_org) or private.has_second_factor(rc.user_id)
      -- As in private.member_peer_staff_eligible: the caller's key assurance
      -- must belong to the current JWT (has_second_factor checks that), and
      -- anyone else may count only their own live verified-key session.
      or (rc.user_id is distinct from (select auth.uid())
        and exists (select 1 from private.verified_key_sessions key_session
          where key_session.user_id = rc.user_id
            and private.verified_key_session(rc.user_id, key_session.session_id))))
$function$;
revoke all on function private.cross_chapter_peer_holders(uuid, text) from public, anon, authenticated, service_role;

-- The enabled levels the caller holds on their own (current) chapter.
create function private.cross_chapter_peer_caller_levels(p_caller uuid)
returns table(role text, organization_id uuid, chapter_id text)
language sql
stable
security definer
set search_path = ''
as $function$
  select level.role, chapter.organization_id, chapter.id
  from public.member_profiles profile
  join public.chapters chapter
    on chapter.id = profile.chapter_id
   and chapter.organization_id = (select private.current_member_organization())
  cross join lateral pg_catalog.unnest(private.cross_chapter_peer_levels(chapter.organization_id)) as level(role)
  where profile.id = p_caller
    and exists (
      select 1 from private.cross_chapter_peer_holders(chapter.organization_id, level.role) holder
      where holder.user_id = p_caller and holder.chapter_id = chapter.id)
$function$;
revoke all on function private.cross_chapter_peer_caller_levels(uuid) from public, anon, authenticated, service_role;

-- Holders of the caller's levels on the organization's other chapters, minus
-- the caller and anyone who muted cross-chapter contact.
create function private.cross_chapter_reachable_peers(p_caller uuid)
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
$function$;
revoke all on function private.cross_chapter_reachable_peers(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The list.
create function public.list_cross_chapter_peers(p_query text default null, p_offset integer default 0, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  needle text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, ''))), '');
  page jsonb;
  more boolean;
begin
  if caller is null or not private.mfa_satisfied()
     or private.current_member_organization() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(coalesce(needle, '')) > 80
     or p_offset is null or p_offset not between 0 and 100000
     or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'list page unavailable' using errcode = '22023';
  end if;

  -- Name, display title and chapter only: no contact detail, membership data
  -- or casework travels through this list. Ordered by name, then id. One row
  -- past the page is read only to say whether there is another; rows are
  -- numbered within the page, so at most p_limit are returned.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', person.user_id,
           'name', person.name,
           'title', person.title,
           'chapters', pg_catalog.to_jsonb(person.chapters),
           'levels', pg_catalog.to_jsonb(person.levels)
         ) order by person.name, person.user_id) filter (where person.position <= p_limit), '[]'::jsonb),
         pg_catalog.count(*) > p_limit
    into page, more
  from (
    select fetched.*, pg_catalog.row_number() over (order by fetched.name, fetched.user_id) as position
    from (
      select found.*
      from (
        select peer.user_id,
          private.member_peer_profile_label(peer.user_id) ->> 'name' as name,
          -- Shown beside the name only; access is the level above.
          (pg_catalog.array_agg(nullif(pg_catalog.btrim(membership.display_title), '') order by peer.chapter_name, peer.chapter_id)
            filter (where nullif(pg_catalog.btrim(membership.display_title), '') is not null))[1] as title,
          pg_catalog.array_agg(distinct peer.chapter_name) as chapters,
          pg_catalog.array_agg(distinct peer.role) as levels
        from private.cross_chapter_reachable_peers(caller) peer
        join public.member_chapter_memberships membership
          on membership.user_id = peer.user_id and membership.chapter_id = peer.chapter_id
        group by peer.user_id
      ) found
      where needle is null
         or pg_catalog.strpos(pg_catalog.lower(found.name), needle) > 0
         or exists (select 1 from pg_catalog.unnest(found.chapters) chapter(name) where pg_catalog.strpos(pg_catalog.lower(chapter.name), needle) > 0)
      order by found.name, found.user_id
      offset p_offset
      limit p_limit + 1
    ) fetched
  ) person;

  return pg_catalog.jsonb_build_object(
    'available', exists (select 1 from private.cross_chapter_peer_caller_levels(caller)),
    'levels', coalesce((
      select pg_catalog.jsonb_agg(distinct mine.role)
      from private.cross_chapter_peer_caller_levels(caller) mine), '[]'::jsonb),
    'muted', exists (select 1 from private.cross_chapter_peer_mutes mute where mute.user_id = caller),
    'peers', page,
    'nextOffset', case when more then p_offset + p_limit end
  );
end;
end;
$function$;
revoke all on function public.list_cross_chapter_peers(text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_cross_chapter_peers(text, integer, integer) to authenticated;
comment on function public.list_cross_chapter_peers(text, integer, integer) is
  'REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109: one page (1-100, by name) of the holders of the caller''s enabled access levels (features.messaging.cross_chapter_peer_roles) on the organization''s other chapters, optionally matching a name or chapter; name, display title and chapter only, with the caller''s own mute and the next page''s offset.';

-- ---------------------------------------------------------------------------
-- 5. The send.
create function public.send_cross_chapter_peer_message(p_recipient_ids uuid[], p_body text)
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
  -- hold, the caller's own chapter, a muted person or an account that
  -- cannot sign in. Nothing has been written yet.
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

      insert into public.member_peer_conversations (chapter_id, user_low, user_high, created_from_request)
      values (caller_chapter, least(caller, recipient), greatest(caller, recipient), request_id_value)
      returning id into conversation_id_value;
      created_count := created_count + 1;
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
revoke all on function public.send_cross_chapter_peer_message(uuid[], text) from public, anon, authenticated, service_role;
grant execute on function public.send_cross_chapter_peer_message(uuid[], text) to authenticated;
comment on function public.send_cross_chapter_peer_message(uuid[], text) is
  'REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109: sends one message to 1-20 people public.list_cross_chapter_peers lists, each in its own two-person conversation (reused or opened without a code or acceptance step). Any unreachable recipient refuses the whole send.';

-- ---------------------------------------------------------------------------
-- 6. The mute control.
create function public.set_my_cross_chapter_peer_mute(p_muted boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_muted is null then
    raise exception 'muted flag required' using errcode = '22023';
  end if;
  if p_muted then
    insert into private.cross_chapter_peer_mutes (user_id) values (caller)
    on conflict (user_id) do nothing;
  else
    delete from private.cross_chapter_peer_mutes where user_id = caller;
  end if;
  return pg_catalog.jsonb_build_object('muted', p_muted);
end;
end;
$function$;
revoke all on function public.set_my_cross_chapter_peer_mute(boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_my_cross_chapter_peer_mute(boolean) to authenticated;
comment on function public.set_my_cross_chapter_peer_mute(boolean) is
  'REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109: the caller stops (or resumes) new cross-chapter messages to them and leaves (or rejoins) public.list_cross_chapter_peers. Open conversations are unaffected.';

-- ---------------------------------------------------------------------------
-- 6b. Separate allowances. Cross-chapter conversations are counted on their
-- own (60 new a day, above); the officer route and the code request keep their
-- three a day for everything else. Only the two counts change from the live
-- definitions (20261007012625 and 20261030203100).
create or replace function public.request_reward_peer_contact(p_contact_code text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
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
  -- in the caller's chapter or organization, the caller themselves, or an
  -- account that cannot sign in).
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
-- 7. Account lifecycle.
insert into private.account_lifecycle_manifest(schema_name,table_name,user_column,delete_disposition,export_disposition,export_inventory_basis,exclusion_reason,note) values
 ('private','cross_chapter_peer_mutes','user_id','cascade','excluded_with_reason','auth_user_fk','One contact preference with a time; contains no member-authored content.','Removed with the account.');
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.schema_name = 'private' and s.table_name = 'cross_chapter_peer_mutes'
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;
do $assert_cross_chapter_peer_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after cross-chapter peer contact';
  end if;
end;
$assert_cross_chapter_peer_trigger_review$;

notify pgrst, 'reload schema';

commit;
