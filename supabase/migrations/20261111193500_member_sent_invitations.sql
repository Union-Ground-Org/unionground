-- REQ-UG-MEMBER-SENT-INVITATIONS-20261111 (#8171), owner option A.
--
-- A member can invite someone into their own home chapter without an
-- administrator, when the organization's administrator has turned on
-- features.member_invitations.enabled (off by default). The invitation is an
-- ordinary plain-member provision invitation with source 'member': the same
-- one-time link, the same acceptance and password email, the same 15-minute
-- link. Accepting it credits the sending member through #8152's
-- member_referrals path.
--
-- * Who may send: a signed-in, active member of the current organization, into
--   their own home chapter only (there is no chapter argument), whose account
--   is at least 7 days old. No starting access can be granted.
-- * The one-time link's secret never comes from the member. Only the server
--   route calls the creating and delivery functions (service role), with the
--   member id it verified and a secret it made and emails; a member cannot
--   call them, so a member can neither hold a link for an address they do not
--   control nor learn from an answer whether an address has an account.
--   The member's own session step-up is checked by
--   public.member_sent_invitation_session(), which creates nothing.
-- * Limits: per member per day and per 30 days (organization limits, 3 and 10
--   by default), plus the chapter's existing daily invitation limit, all
--   charged before the duplicate and existing-account checks, as on the admin
--   path. An address with an account or a live invitation answers the same
--   accepted, nothing sent.
-- * An administrator sees the source and the sending member in the invitation
--   list, revokes or resends a member-sent invitation with the existing RPCs,
--   and turns the switch off to stop every member-sent invitation.
-- * No new copy of the invitee's address: it lives only in
--   member_invitations.normalized_email, as for every invitation.
-- Open signup (private.open_signup_period) is untouched; GoTrue self-signup
-- stays disabled.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.member_invitations
  drop constraint member_invitations_source_check,
  add constraint member_invitations_source_check check (source in ('adhoc', 'roster', 'member')),
  -- A member-sent invitation only ever provisions a plain member.
  add constraint member_invitations_member_source_plain
    check (source <> 'member' or (kind = 'provision' and initial_role is null));

-- The member limits' counters live beside the administrator ones.
alter table private.member_invitation_admin_limits
  drop constraint member_invitation_admin_limits_operation_check,
  add constraint member_invitation_admin_limits_operation_check check (operation in (
    'create-hour', 'chapter-day', 'resend-hour', 'invitation-resend-hour', 'roster-hour', 'roster-day', 'roster-lookup-hour',
    'member-day', 'member-month'));

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.member_invitations.enabled', 'boolean', 'Members send invitations',
   'Let members invite someone into their own chapter without an administrator. Off: a member''s invitation is a suggestion an administrator approves.',
   'false'::jsonb, null, null, null, 2686, 'security', true),
  ('limits.security.invitation_member_daily', 'integer', 'Invitations per member per day',
   'Maximum invitations one member can send in a day when members send invitations.',
   '3'::jsonb, 1, 10, null, 2684, 'security', false),
  ('limits.security.invitation_member_monthly', 'integer', 'Invitations per member per 30 days',
   'Maximum invitations one member can send in 30 days when members send invitations.',
   '10'::jsonb, 1, 50, null, 2685, 'security', false)
on conflict (key) do nothing;

-- The member who sent a member-sent invitation: the first row of its resend
-- chain (a resend supersedes the row under the resending administrator, keeps
-- the source and links back through replaces_id). Null for any other source.
create function private.member_sent_invitation_sender(p_invitation_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  with recursive chain as (
    select i.id, i.replaces_id, i.invited_by, i.source, 1 as depth
      from public.member_invitations i
     where i.id = p_invitation_id
    union all
    select i.id, i.replaces_id, i.invited_by, i.source, c.depth + 1
      from public.member_invitations i
      join chain c on i.id = c.replaces_id
     where c.depth < 100
  )
  select c.invited_by from chain c
   where c.replaces_id is null and c.source = 'member'
   limit 1
$fn$;
revoke all on function private.member_sent_invitation_sender(uuid) from public, anon, authenticated, service_role;

-- A limit refusal names the limit and when its window opens again, so the
-- route answers rate-limited with a time rather than a generic failure.
create function private.member_invitation_limit_refusal(p_scope_key text, p_operation text, p_limit_key text, p_window interval)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  opens timestamptz;
begin
  select l.window_started_at + p_window into opens
    from private.member_invitation_admin_limits l
   where l.scope_key = p_scope_key and l.operation = p_operation;
  raise exception 'invitation rate limited' using errcode = 'P0001',
    detail = pg_catalog.jsonb_build_object('limit', p_limit_key,
      'retryAt', coalesce(opens, pg_catalog.clock_timestamp() + p_window))::text;
end
$fn$;
revoke all on function private.member_invitation_limit_refusal(text, text, text, interval) from public, anon, authenticated, service_role;

-- The route's first step, under the member's own session: the step-up the
-- member's suggestion path (submit_member_request) asks for. It returns the
-- caller's id for the route to compare with the identity it verified, and
-- writes nothing.
create function public.member_sent_invitation_session()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return (select auth.uid());
end;
$function$;
revoke all on function public.member_sent_invitation_session() from public, anon, authenticated, service_role;
grant execute on function public.member_sent_invitation_session() to authenticated;

-- Service role only: api/admin-invitations.js (action member-send) passes the
-- member id it verified and the digest of the secret it emails.
create function public.create_member_sent_invitation(p_actor uuid, p_email text, p_full_name text, p_locale text, p_token_hash text)
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

-- Service role only: the route records whether the sending member's own
-- invitation's first email went out, as record_member_invitation_delivery does
-- for an administrator.
create function public.record_member_sent_invitation_delivery(p_actor uuid, p_invitation_id uuid, p_delivery_version integer, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[p_actor], array[]::uuid[]);
declare
  caller uuid := p_actor;
  invitation_row public.member_invitations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' or caller is null then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome not in ('sent', 'failed') then
    raise exception 'invalid delivery outcome' using errcode = '22023';
  end if;
  select * into invitation_row
    from public.member_invitations
   where id = p_invitation_id and source = 'member' and invited_by = caller
     and replaces_id is null and delivery_version = p_delivery_version
  for update;
  if not found or invitation_row.status <> 'pending' then
    return pg_catalog.jsonb_build_object('recorded', false);
  end if;
  if p_outcome = 'sent' then
    update public.member_invitations set sent_at = clock_timestamp() where id = invitation_row.id;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, caller, 'invite_sent',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version, 'source', 'member'));
  else
    update public.member_invitations
       set status = 'delivery_failed', token_hash = null,
           expires_at = clock_timestamp(), failure_code = 'provider_unavailable'
     where id = invitation_row.id;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, caller, 'invite_delivery_failed',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version,
        'failureClass', 'provider_unavailable', 'source', 'member'));
  end if;
  return pg_catalog.jsonb_build_object('recorded', true);
end;
end;
$function$;
revoke all on function public.record_member_sent_invitation_delivery(uuid, uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.record_member_sent_invitation_delivery(uuid, uuid, integer, text) to service_role;

-- Accepting a member-sent invitation credits the member who sent it, in the
-- same transaction that marks it accepted, through #8152's member_referrals
-- path: one referral per person, never oneself, same organization, active
-- sender. A code typed at acceptance then records nothing (the person is
-- already referred), so the sender keeps the credit. A check-in the new member
-- made before the acceptance completed is reconciled at once.
create function private.record_member_sent_invitation_referral()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_sender uuid;
  v_organization uuid;
begin
  perform private.lock_case_graph(array[new.auth_user_id], array[]::uuid[]);
  if new.source <> 'member' or new.status <> 'accepted' or new.auth_user_id is null
     or old.status = 'accepted' then
    return null;
  end if;
  v_sender := private.member_sent_invitation_sender(new.id);
  select c.organization_id into v_organization from public.chapters c where c.id = new.chapter_id;
  if v_sender is null or v_organization is null or v_sender = new.auth_user_id
     or not exists (
       select 1 from public.organization_memberships m
        where m.user_id = v_sender and m.organization_id = v_organization and m.status = 'active') then
    return null;
  end if;
  insert into private.member_referrals (referrer_user_id, referred_user_id, organization_id, code)
  values (v_sender, new.auth_user_id, v_organization, private.member_referral_code(v_sender))
  on conflict on constraint member_referrals_referred_once do nothing;
  -- The acceptance route makes the account usable before it marks the
  -- invitation accepted, so the new member may already have checked in; that
  -- check-in found no referral to activate. Reconcile it here, the same way
  -- the typed-code recorder of 20261111112506 does.
  if found and exists (
    select 1 from public.member_point_events e
     where e.user_id = new.auth_user_id and e.action_kind = 'checkin') then
    perform private.award_member_referral(new.auth_user_id);
  end if;
  return null;
end
$fn$;
revoke all on function private.record_member_sent_invitation_referral() from public, anon, authenticated, service_role;
create trigger member_sent_invitation_referral after update of status on public.member_invitations
for each row when (new.source = 'member' and new.status = 'accepted')
execute function private.record_member_sent_invitation_referral();

-- The invitation list also says who sent each invitation. Re-emitted from
-- 20261103005000 with two added fields; the caller gate, chapter scope, cap
-- and every other field are unchanged.
create or replace function public.get_member_invitations(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  cap integer := greatest(1, least(coalesce(p_limit, 50), 100));
  chapter_name text;
  caller_org uuid;
  administrable text[];
  presided text[];
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id, c.name, c.organization_id into caller_chapter, chapter_name, caller_org
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  where p.id = caller;
  if caller_chapter is null or caller_org is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  -- Chapters the caller administers (every invitation, any starting access)
  -- and, separately, chapters the caller presides over without administering
  -- them (plain-member invitations only).
  select coalesce(pg_catalog.array_agg(c.id order by c.order_index, c.name, c.id), array[]::text[])
    into administrable
  from public.chapters c
  where c.organization_id = caller_org
    and private.member_invitation_chapter_administrable(c.id);
  select coalesce(pg_catalog.array_agg(c.id order by c.order_index, c.name, c.id), array[]::text[])
    into presided
  from public.chapters c
  where c.organization_id = caller_org
    and not (c.id = any(administrable))
    and private.member_invitation_chapter_presided(c.id);

  return pg_catalog.jsonb_build_object(
    'chapter', pg_catalog.jsonb_build_object('id', caller_chapter, 'name', chapter_name),
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'name', c.name,
          'grantsAccess', c.id = any(administrable))
        order by c.order_index, c.name, c.id)
      from public.chapters c
      where c.id = any(administrable) or c.id = any(presided)
    ), '[]'::jsonb),
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id,
        'kind', s.kind,
        'normalizedEmail', s.normalized_email,
        'fullName', s.full_name,
        'chapterId', s.chapter_id,
        'chapterName', s.chapter_name,
        'initialRole', s.initial_role,
        'locale', s.locale,
        'status', case when s.status = 'pending' and s.expires_at <= clock_timestamp()
                  then 'expired' else s.status end,
        'deliveryVersion', s.delivery_version,
        'expiresAt', s.expires_at,
        'createdAt', s.created_at,
        'acceptedAt', s.accepted_at,
        'revokedAt', s.revoked_at,
        -- #8171: who sent it. A member-sent invitation names its member, even
        -- after an administrator resent it.
        'source', s.source,
        'sentByMemberName', case when s.source = 'member' then (
          select p.full_name from public.member_profiles p
          where p.id = private.member_sent_invitation_sender(s.id)) end
      ) order by s.created_at desc, s.id)
      -- The cap applies per chapter to history, as it did when the desk saw one
      -- chapter; actionable rows are never pushed out by it.
      from pg_catalog.unnest(administrable || presided) as a(chapter_id)
      cross join lateral (
        select i.*, c.name as chapter_name
        from public.member_invitations i
        join public.chapters c on c.id = i.chapter_id
        where i.chapter_id = a.chapter_id and i.status <> 'superseded'
          and (a.chapter_id = any(administrable)
               or (i.initial_role is null and i.kind = 'provision'))
          -- Newest history up to the cap, plus every invitation still
          -- actionable (live, accepting or failed delivery): a roster import
          -- keeps hundreds live for 7 days, and each must stay revocable.
          and (i.id in (
                 select newest.id from public.member_invitations newest
                 where newest.chapter_id = a.chapter_id and newest.status <> 'superseded'
                   and (a.chapter_id = any(administrable)
                        or (newest.initial_role is null and newest.kind = 'provision'))
                 order by newest.created_at desc, newest.id
                 limit cap)
               or i.status in ('accepting', 'delivery_failed')
               or (i.status = 'pending' and i.expires_at > clock_timestamp()))
        order by i.created_at desc, i.id
      ) s
    ), '[]'::jsonb)
  );
end;
end;
$function$;

revoke all on function public.get_member_invitations(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_member_invitations(integer)
  to authenticated;

-- Account lifecycle: the acceptance trigger writes only member_referrals rows
-- whose two account columns cascade (20261111112506).
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.schema_name = 'public'
  and s.table_name = 'member_invitations' and s.object_name = 'member_sent_invitation_referral')
  or (s.kind = 'function' and s.schema_name = 'private'
  and s.object_name in ('record_member_sent_invitation_referral()', 'member_sent_invitation_sender(p_invitation_id uuid)',
    'member_referral_code(p_user_id uuid)', 'award_member_referral(p_referred uuid)'))
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $assert_member_sent_invitation_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after member-sent invitations';
  end if;
end
$assert_member_sent_invitation_review$;

notify pgrst, 'reload schema';

commit;
