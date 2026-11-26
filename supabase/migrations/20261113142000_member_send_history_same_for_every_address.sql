-- SEC-UG-MEMBER-SENT-INVITATION-REVEALS-WHETHER-AN-ADDRESS-HAS-AN-ACCOUNT-20261115
-- (#8767), step 2 of 2. Step 1 (#8787, api/admin-invitations.js) answers the
-- member send the same way, at the same time, for every address.
--
-- While an organization's learning period ran, public.create_member_sent_invitation
-- (20261112173000, #8395) journalled an invitation_send entry for the sending
-- member only when the address was new: an address with an account, or with a
-- live invitation, returned before the journal write. The member reads their
-- own journal back with public.list_my_learning_history (action kind and
-- target id), so one send and one read told them whether the address already
-- had an account.
--
-- Now the entry is written the same way for every member send, before that
-- branch: kind invitation_send, target table public.member_invitations, and a
-- fresh random target id that names no row, so neither the presence, the
-- shape nor the target of the entry depends on the address. Same entry rather
-- than none: the learning period lists what a person did during practice that
-- undo cannot take back (an invitation_send is 'permanent'), and asking to
-- send an invitation is such an action for the member whatever the address;
-- the line reads "Sent or resent an invitation", which the member's neutral
-- notice ("if that address can be invited, the invitation is on its way")
-- already allows. Nothing read the entry's link to the invitation row: the
-- history is the actor's own, and no undo, practice marker or close step
-- resolves an invitation_send target.
--
-- Existing rows: an entry written by the old code is itself the signal (it
-- exists only for a send to a new address). Member sends have been held on
-- the release calendar (features.member_invitations.enabled, 'infinity') since
-- 20261112214700, so such entries can only come from the hours between the two
-- Nov 12 migrations. Nothing is deleted here: the owner's standing ruling is to
-- keep as much data as possible. A guard counts the member-path entries
-- (invitation_send entries whose target is a member-sent invitation, source
-- 'member', of the same actor) and refuses the apply if there is any, so
-- nothing is written and the choice goes to the owner.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.create_member_sent_invitation(p_actor uuid, p_email text, p_full_name text, p_locale text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[p_actor], array[]::uuid[]);
declare
  caller uuid := p_actor;
  caller_org uuid;
  home_chapter text;
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_name text := pg_catalog.btrim(coalesce(p_full_name, ''));
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  name_parts text[];
  clean_first text;
  clean_initials text;
  invitation_row public.member_invitations%rowtype;
  expired_row public.member_invitations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  -- The member's organization, exactly as private.current_member_organization()
  -- resolves it for their own session: an active organization, chapter
  -- membership and organization membership on the selected chapter.
  select c.organization_id into caller_org
    from public.member_profiles p
    join public.chapters c on c.id = p.chapter_id
    join public.organizations o on o.id = c.organization_id and o.status = 'active'
    join public.member_chapter_memberships cm on cm.user_id = p.id and cm.chapter_id = c.id and cm.status = 'active'
    join public.organization_memberships om on om.organization_id = c.organization_id and om.user_id = p.id and om.status = 'active'
   where p.id = caller and c.organization_id is not null;
  if caller is null or caller_org is null then
    raise exception 'member invitations not permitted' using errcode = '42501';
  end if;
  -- The home chapter cannot move under this call: the same per-member chapter
  -- lock every chapter change takes.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));
  select p.chapter_id into home_chapter
    from public.member_profiles p
    join public.chapters c on c.id = p.chapter_id
   where p.id = caller and c.organization_id = caller_org;
  if home_chapter is null
     or not exists (
       select 1 from public.organization_memberships m
        where m.user_id = caller and m.organization_id = caller_org and m.status = 'active')
     or not private.organization_feature_enabled(caller_org, 'features.member_invitations.enabled') then
    raise exception 'member invitations not permitted' using errcode = '42501';
  end if;
  -- A brand-new account cannot invite at once, so no chain of fresh accounts
  -- can multiply itself.
  if not exists (
    select 1 from auth.users u
     where u.id = caller and u.created_at <= pg_catalog.clock_timestamp() - interval '7 days') then
    raise exception 'member invitations not permitted' using errcode = '42501';
  end if;

  -- Count before the duplicate and existing-account branches, as the admin
  -- path does, so this is never a free address probe.
  if not private.consume_member_invitation_admin_limit('member:' || caller::text, 'member-day',
       private.organization_limit(caller_org, 'limits.security.invitation_member_daily'), interval '1 day') then
    perform private.member_invitation_limit_refusal('member:' || caller::text, 'member-day',
      'limits.security.invitation_member_daily', interval '1 day');
  end if;
  if not private.consume_member_invitation_admin_limit('member:' || caller::text, 'member-month',
       private.organization_limit(caller_org, 'limits.security.invitation_member_monthly'), interval '30 days') then
    perform private.member_invitation_limit_refusal('member:' || caller::text, 'member-month',
      'limits.security.invitation_member_monthly', interval '30 days');
  end if;
  if not private.consume_member_invitation_admin_limit('chapter:' || home_chapter, 'chapter-day',
       private.organization_limit(caller_org, 'limits.security.invitation_chapter_daily'), interval '1 day') then
    perform private.member_invitation_limit_refusal('chapter:' || home_chapter, 'chapter-day',
      'limits.security.invitation_chapter_daily', interval '1 day');
  end if;

  name_parts := pg_catalog.regexp_split_to_array(clean_name, '[[:space:]]+');
  clean_first := name_parts[1];
  clean_initials := pg_catalog.upper(
    pg_catalog.left(clean_first, 1)
    || case when pg_catalog.array_length(name_parts, 1) > 1
       then pg_catalog.left(name_parts[pg_catalog.array_length(name_parts, 1)], 1)
       else '' end
  );
  -- Every value the insert would store is checked here, against the table's
  -- own constraints (first_name is 1 to 80 characters), before any answer that
  -- depends on the address: an unused address, an existing account and a live
  -- invitation get the same refusal for the same input.
  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or coalesce(pg_catalog.char_length(clean_first), 0) not between 1 and 80
     or coalesce(pg_catalog.char_length(clean_initials), 0) not between 1 and 4
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es') then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;
  -- The founding caps of an organization that has not cleared the signup
  -- boundary (20 invitations in 24 hours, 200 in all), exactly as the
  -- b20_unverified_organization_boundary trigger of 20261103163000 counts
  -- them, checked here with the trigger's own refusal before any answer that
  -- depends on the address. Otherwise an unused address would reach the
  -- trigger and be refused while an existing account or a live invitation is
  -- accepted, so a member at a cap could tell which addresses are in use.
  if not private.organization_clears_signup_boundary(caller_org)
     and ((select pg_catalog.count(*)
             from public.member_invitations i
             join public.chapters c on c.id = i.chapter_id
            where c.organization_id = caller_org
              and i.created_at > pg_catalog.now() - interval '24 hours') >= 20
          or (select pg_catalog.count(*)
                from public.member_invitations i
                join public.chapters c on c.id = i.chapter_id
               where c.organization_id = caller_org) >= 200) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509)
  );

  for expired_row in
    update public.member_invitations
    set status = 'expired', token_hash = null, failure_code = null
    where normalized_email = clean_email
      and status = 'pending'
      and expires_at <= clock_timestamp()
    returning *
  loop
    perform private.audit_member_invitation(
      expired_row.id, expired_row.chapter_id, caller, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', expired_row.chapter_id,
        'deliveryVersion', expired_row.delivery_version)
    );
  end loop;

  -- The sending member's practice history (#8395), written before the branch
  -- on whether the address is in use and the same either way (#8767): the
  -- same kind, and a fresh target id that names no row, so the member's own
  -- history never tells an address with an account from a new one. Only the
  -- route's answer, also the same either way, follows.
  perform private.learning_actor_journal('invitation_send', 'public.member_invitations',
    extensions.gen_random_uuid()::text, caller, caller_org);

  if exists (
    select 1 from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
  ) or exists (
    select 1 from public.member_invitations i
    where i.normalized_email = clean_email and i.status in ('pending', 'accepting')
  ) then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     expires_at, kind, source)
  values
    (clean_email, clean_name, clean_first, clean_initials, home_chapter,
     null, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '15 minutes', 'provision', 'member')
  returning * into invitation_row;
  perform private.audit_member_invitation(
    invitation_row.id, home_chapter, caller, 'invite_requested',
    pg_catalog.jsonb_build_object('chapterId', home_chapter,
      'initialRole', null, 'locale', clean_locale, 'source', 'member',
      'deliveryVersion', invitation_row.delivery_version)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'expiresAt', invitation_row.expires_at
  );
end;
end;
$function$;

do $member_path_entries_guard$
declare
  found_entries integer;
begin
  select pg_catalog.count(*) into found_entries
    from private.learning_action_journal j
    join public.member_invitations i on j.target_id = i.id::text
   where j.action_kind = 'invitation_send'
     and j.target_table = 'public.member_invitations'
     and i.source = 'member'
     and i.invited_by = j.actor_user_id;
  if found_entries <> 0 then
    raise exception 'found % member-sent invitation_send learning history entries written before #8767; nothing was applied, and what happens to them is the owner''s choice', found_entries
      using errcode = '55000';
  end if;
end;
$member_path_entries_guard$;

notify pgrst, 'reload schema';

commit;
