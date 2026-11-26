-- REQ-UG-MEMBER-SENT-INVITATIONS-LEARNING-JOURNAL-20261111 (#8395):
-- a member's own sent invitation is journalled as invitation_send, so it is in
-- the sender's learning-period history like an administrator's invitation.
--
-- public.create_member_sent_invitation (20261111193500) runs as the service
-- role for the member api/admin-invitations.js verified (action member-send),
-- so private.learning_journal_append, which takes its actor and organization
-- from the session, would journal nothing. private.learning_actor_journal is
-- the same write for an actor the calling function verified: service role
-- only, metadata-only (permanent) kinds only, the actor's active membership in
-- the named organization, and the same registration, period and close checks
-- as learning_journal_append. No API role may execute it, so nobody new can
-- write the journal.

begin;

create function private.learning_actor_journal(
  p_action_kind text,
  p_target_table text,
  p_target_id text,
  p_actor uuid,
  p_organization_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- Re-entrant: the calling function already holds it for this actor.
  perform private.lock_case_graph(array[p_actor], array[]::uuid[]);
declare
  period uuid;
  kind private.learning_action_kinds%rowtype;
  entry uuid;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_actor is null or p_organization_id is null then return null; end if;
  if not exists (
    select 1 from public.organization_memberships m
     where m.organization_id = p_organization_id and m.user_id = p_actor and m.status = 'active') then
    raise exception 'learning actor is not an active member of the organization' using errcode = '42501';
  end if;
  select * into kind from private.learning_action_kinds k where k.action_kind = p_action_kind;
  if not found then
    raise exception 'unregistered learning action: %', p_action_kind using errcode = '22023';
  end if;
  if kind.disposition = 'excluded' then return null; end if;
  if kind.disposition <> 'permanent' then
    raise exception 'learning action % is not metadata-only', p_action_kind using errcode = '22023';
  end if;
  if kind.target_table is distinct from p_target_table then
    raise exception 'learning action % does not write %', p_action_kind, p_target_table using errcode = '22023';
  end if;
  period := private.learning_period_running(p_organization_id);
  if period is null then return null; end if;
  -- As learning_journal_append: hold the period against a concurrent close,
  -- then read the clock again.
  perform 1 from private.organization_learning_periods p where p.id = period for share;
  if private.learning_period_running(p_organization_id) is distinct from period then return null; end if;
  insert into private.learning_action_journal
    (organization_id, period_id, actor_user_id, action_kind, target_table, target_id, state, kept_at)
  values
    (p_organization_id, period, p_actor, p_action_kind, p_target_table, p_target_id, 'kept', pg_catalog.clock_timestamp())
  returning id into entry;
  return entry;
end;
end;
$function$;
revoke all on function private.learning_actor_journal(text, text, text, uuid, uuid) from public, anon, authenticated, service_role;

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
  -- The sending member's practice history, as an administrator's invitation
  -- is journalled (20261104111500): the member the route verified, in the
  -- organization this function resolved for them.
  perform private.learning_actor_journal('invitation_send', 'public.member_invitations', invitation_row.id::text, caller, caller_org);

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
revoke all on function public.create_member_sent_invitation(uuid, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.create_member_sent_invitation(uuid, text, text, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
