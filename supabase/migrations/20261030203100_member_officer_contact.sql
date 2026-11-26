-- REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030 (#6564).
--
-- Members could not write to an officer or administrator: "Who runs this
-- chapter" listed them as text, the private member contact needed the other
-- person's code plus a reward, and the steward conversation is read by the
-- chapter's stewards, not by the President or an administrator. This
-- migration adds one route, on the existing two-person member conversation
-- tables (public.member_peer_*), so only the member and the officer they
-- chose can read it:
--
--   * private.chapter_leadership_people(org, chapter): the people
--     public.get_chapter_leadership() lists (officers with a display title,
--     the chapter's President and administrators, the organization's
--     administrators). The predicate moves here unchanged so the list, the
--     contact check and the contact-sharing check read one definition.
--   * private.member_contactable_officer_ids(): the caller's own chapter's
--     leadership, minus the caller, whose accounts can still sign in. The
--     only people start_officer_conversation will open a conversation with,
--     and what get_chapter_leadership reports as canMessage.
--   * public.start_officer_conversation(officer, body): no contact code and no
--     reward. The officer's published leadership role is the consent the code
--     request asks for, the same way a steward's in-app conversation is always
--     offered. The conversation and its first message are one transaction
--     (the first message goes through public.send_reward_peer_message, so its
--     limits apply and a refused message leaves no empty conversation); an
--     existing conversation of the pair is reused. A new pair counts toward
--     the same three contact requests per 24 hours as the code route, and the
--     accepted request row is marked officer_contact.
--   * public.get_chapter_leadership() also returns canMessage and the email or
--     phone an officer chose to share with members. Shared values are shown
--     only for people with an active membership of the caller's chapter, the
--     same audience as a steward card, so an organization administrator who
--     belongs to another chapter is reachable by message but never publishes
--     a channel to a chapter they are not in.
--   * public.set_my_steward_contact_visibility() lets a listed officer of the
--     caller's own chapter, not only a steward, share an email or phone with
--     members. One row per person (public.steward_contact_preferences); the
--     withdrawal path is unchanged.
--
-- Who may read the steward conversation (public.member_conversations) is
-- unchanged, and the October 5, 2026 ruling stands: a message addressed to
-- the chapter steward is never routed to an administrator or the President.
-- The member chooses the officer route themselves.
--
-- Hosted application: SAMPLE first, then production.

begin;
set local lock_timeout = '5s';

do $predecessors$ begin
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.get_chapter_leadership()'::regprocedure) is distinct from '46d894dde36df7a93c7362d2c8733e69' then
  raise exception 'unreviewed get_chapter_leadership predecessor' using errcode = '55000';
end if;
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.set_my_steward_contact_visibility(boolean,boolean,text,text)'::regprocedure) is distinct from '1709054ee53b19fb565e585e627dca27' then
  raise exception 'unreviewed set_my_steward_contact_visibility predecessor' using errcode = '55000';
end if;
end; $predecessors$;

-- ---------------------------------------------------------------------------
-- 1. The leadership predicate, moved out of get_chapter_leadership unchanged.
create function private.chapter_leadership_people(p_org uuid, p_chapter text)
returns table (
  id uuid,
  full_name text,
  display_title text,
  chapter_president boolean,
  chapter_admin boolean,
  organization_admin boolean,
  chapter_member boolean
)
language sql
stable
security definer
set search_path = ''
as $function$
  select people.id, profile.full_name, people.display_title,
    scoped.chapter_president, scoped.chapter_admin, scoped.organization_admin,
    people.chapter_member
  from (
    select cm.user_id as id, cm.display_title, true as chapter_member
    from public.member_chapter_memberships cm
    join public.organization_memberships om
      on om.user_id = cm.user_id
     and om.organization_id = p_org
     and om.status = 'active'
    where cm.chapter_id = p_chapter
      and cm.status = 'active'
    union
    select g.user_id, null::text, false
    from public.organization_role_grants g
    join public.organization_memberships om
      on om.user_id = g.user_id
     and om.organization_id = g.organization_id
     and om.status = 'active'
    where g.organization_id = p_org
      and g.role = 'admin'
      and not exists (
        select 1 from public.member_chapter_memberships own
        where own.user_id = g.user_id
          and own.chapter_id = p_chapter
          and own.status = 'active'
      )
  ) people
  join public.member_profiles profile on profile.id = people.id
  cross join lateral (
    select
      exists (
        select 1 from public.member_role_chapters rc
        where rc.user_id = people.id
          and rc.chapter_id = p_chapter
          and rc.role = 'vp'
      ) as chapter_president,
      exists (
        select 1 from public.member_role_chapters rc
        where rc.user_id = people.id
          and rc.chapter_id = p_chapter
          and rc.role = 'admin'
      ) as chapter_admin,
      exists (
        select 1 from public.organization_role_grants g
        where g.user_id = people.id
          and g.organization_id = p_org
          and g.role = 'admin'
      ) as organization_admin
  ) scoped
  where people.display_title is not null
     or scoped.chapter_president
     or scoped.chapter_admin
     or scoped.organization_admin
$function$;

revoke all on function private.chapter_leadership_people(uuid, text)
  from public, anon, authenticated, service_role;

comment on function private.chapter_leadership_people(uuid, text) is
  'REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: the chapter''s officers (display titles), President and administrators, plus the organization''s administrators. The one leadership predicate behind get_chapter_leadership, the officer contact route and officer contact sharing. Not a client RPC.';

-- ---------------------------------------------------------------------------
-- 2. Who the caller may write to: their own chapter's leadership, while the
-- caller is an active member of that chapter of their current organization,
-- minus themselves, and only accounts that can still sign in.
create function private.member_contactable_officer_ids()
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
$function$;

revoke all on function private.member_contactable_officer_ids()
  from public, anon, authenticated, service_role;

comment on function private.member_contactable_officer_ids() is
  'REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: the officers and administrators the caller may open a private conversation with (public.start_officer_conversation); get_chapter_leadership reports the same set as canMessage. Not a client RPC.';

-- ---------------------------------------------------------------------------
-- 3. The leadership list, now with canMessage and member-shared contact.
create or replace function public.get_chapter_leadership()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text;
  chapter_label text;
begin
  if caller is null or not private.mfa_satisfied() or caller_org is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  -- The caller's own active membership of a chapter of the selected
  -- organization; a profile pointer alone is not membership.
  select c.name into chapter_label
  from public.chapters c
  join public.member_chapter_memberships cm
    on cm.chapter_id = c.id
   and cm.user_id = caller
   and cm.status = 'active'
  where c.id = caller_chapter
    and c.organization_id = caller_org;
  if chapter_label is null then
    raise exception 'member chapter required' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object(
    'chapterId', caller_chapter,
    'chapterName', chapter_label,
    'people', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', ranked.id,
        'name', ranked.full_name,
        'title', ranked.display_title,
        'president', ranked.chapter_president,
        'administrator', ranked.chapter_admin,
        'organizationAdministrator', ranked.organization_admin,
        'canMessage', exists (
          select 1 from private.member_contactable_officer_ids() as reachable(id)
          where reachable.id = ranked.id
        ),
        -- Only what the officer chose to share with members, and only to the
        -- members of a chapter the officer belongs to (a steward card's
        -- audience).
        'contact', pg_catalog.jsonb_build_object(
          'email', case when ranked.chapter_member and coalesce(pref.share_email, false) then pref.contact_email end,
          'phone', case when ranked.chapter_member and coalesce(pref.share_phone, false) then pref.contact_phone end
        )
      ) order by ranked.rank, ranked.full_name, ranked.id)
      from (
        select leader.id, leader.full_name, leader.display_title,
          leader.chapter_president, leader.chapter_admin, leader.organization_admin,
          leader.chapter_member,
          case
            when leader.chapter_president then 0
            when leader.display_title is not null then 1
            when leader.chapter_admin then 2
            else 3
          end as rank
        from private.chapter_leadership_people(caller_org, caller_chapter) leader
        order by 8, leader.full_name, leader.id
        limit 100
      ) ranked
      left join public.steward_contact_preferences pref on pref.steward_user_id = ranked.id
    ), '[]'::jsonb)
  );
end;

end;
$$;

comment on function public.get_chapter_leadership() is
  'REQ-UG-WHO-RUNS-THIS-CHAPTER-AND-ONE-WORD-FOR-STAFF-20261006, REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: the caller''s own chapter''s officers (display titles), President and administrators, plus the organization''s administrators; name, title, those roles, whether the caller may message them, and the email or phone an officer of the caller''s chapter chose to share with members.';

-- ---------------------------------------------------------------------------
-- 4. A listed officer of the caller's own chapter may share contact details
-- with members, as a steward can.
create function private.caller_is_chapter_leader()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.member_profiles caller_profile
    join public.chapters chapter
      on chapter.id = caller_profile.chapter_id
     and chapter.organization_id = (select private.current_member_organization())
    join public.member_chapter_memberships own
      on own.user_id = caller_profile.id
     and own.chapter_id = chapter.id
     and own.status = 'active'
    cross join lateral private.chapter_leadership_people(chapter.organization_id, chapter.id) leader
    where caller_profile.id = (select auth.uid())
      and leader.id = caller_profile.id
  )
$function$;

revoke all on function private.caller_is_chapter_leader()
  from public, anon, authenticated, service_role;

create or replace function public.set_my_steward_contact_visibility(
  p_share_email boolean,
  p_share_phone boolean,
  p_contact_email text,
  p_contact_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  -- Now that officers publish here too, a restricted PIN session steps up
  -- first (get_my_steward_contact_visibility already requires it).
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  clean_email text := nullif(pg_catalog.btrim(coalesce(p_contact_email, '')), '');
  clean_phone text := nullif(pg_catalog.btrim(coalesce(p_contact_phone, '')), '');
  share_email boolean := coalesce(p_share_email, false);
  share_phone boolean := coalesce(p_share_phone, false);
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if share_email and clean_email is null then
    raise exception 'an email address is required to share email' using errcode = '22023';
  end if;
  if share_phone and clean_phone is null then
    raise exception 'a phone number is required to share phone' using errcode = '22023';
  end if;

  -- Withdrawal outlives eligibility. A caller who can no longer publish (no
  -- current organization, or neither a steward role nor a place on their
  -- chapter's leadership) may still turn both channels off and clear the
  -- stored values on their own existing row. It never creates a row and
  -- never publishes anything.
  if private.current_member_organization() is null
     or not (private.caller_is_steward() or private.caller_is_chapter_leader()) then
    if share_email or share_phone then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    update public.steward_contact_preferences p
    set share_email = false,
        share_phone = false,
        contact_email = clean_email,
        contact_phone = clean_phone,
        updated_at = pg_catalog.now()
    where p.steward_user_id = caller;
    return public.get_my_steward_contact_visibility();
  end if;

  insert into public.steward_contact_preferences as p (
    steward_user_id, share_email, share_phone, contact_email, contact_phone, updated_at
  ) values (caller, share_email, share_phone, clean_email, clean_phone, pg_catalog.now())
  on conflict (steward_user_id) do update set
    share_email = excluded.share_email,
    share_phone = excluded.share_phone,
    contact_email = excluded.contact_email,
    contact_phone = excluded.contact_phone,
    updated_at = excluded.updated_at;

  return public.get_my_steward_contact_visibility();
end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The officer route.
alter table public.member_peer_contact_requests
  add column officer_contact boolean not null default false;

comment on column public.member_peer_contact_requests.officer_contact is
  'REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: true for the accepted row public.start_officer_conversation records when a member opens a conversation with a listed officer of their chapter (no code, no reward).';

create function public.start_officer_conversation(p_officer_user_id uuid, p_body text)
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
        where r.requester_id = caller and r.created_at >= pg_catalog.now() - interval '24 hours') >= 3 then
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

revoke all on function public.start_officer_conversation(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.start_officer_conversation(uuid, text) to authenticated;

comment on function public.start_officer_conversation(uuid, text) is
  'REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: a member opens (or reuses) a private two-person conversation with a listed officer or administrator of their own chapter and sends its first message, without a contact code or reward. Only the two participants can read it.';

notify pgrst, 'reload schema';

commit;
