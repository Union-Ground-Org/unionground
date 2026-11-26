-- #9273: expiry is system maintenance, not an act by an unrelated inviter.
-- ruling: retain the global email reservation and lazy expiry. Only
-- already-expired pending rows may change, and their audit actor is NULL.
-- No OAuth changes: deleting time-expired nonces without an audit is already
-- system maintenance. No invitation return value or uniqueness rule changes.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Main f233fc29e86465935c269ce1a00fc6ad4348a668: every restated body must still be the reviewed predecessor.
-- The member-sent predecessor is the body 20261121035000 (#9069) leaves, and the restated body below
-- carries its two member-chapter bucket keys exactly; only #9273's expiry extraction differs from it.
do $invitation_expiry_sources$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.create_member_invitation(text,text,text,text,text,text,uuid)'))
      is distinct from '3c28e9f19c10745321d4e0b3b8984597' then
    raise exception 'unreviewed predecessor: public.create_member_invitation(text,text,text,text,text,text,uuid)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.create_member_invitation(text,text,text,text,text,text)'))
      is distinct from '81de2ba039f12027db32ec738750137f' then
    raise exception 'unreviewed predecessor: public.create_member_invitation(text,text,text,text,text,text)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.create_roster_member_invitation(text,text,text,text,text)'))
      is distinct from 'ec6080e433fbb996a9772324204d893a' then
    raise exception 'unreviewed predecessor: public.create_roster_member_invitation(text,text,text,text,text)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.create_former_member_invitation(text,text,text,text)'))
      is distinct from '5daa8c2586fdaf56f216043a02003861' then
    raise exception 'unreviewed predecessor: public.create_former_member_invitation(text,text,text,text)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.create_member_sent_invitation(uuid,text,text,text,text)'))
      is distinct from '4a6ba256ee35da1c08d16828a68cd507' then
    raise exception 'unreviewed predecessor: public.create_member_sent_invitation(uuid,text,text,text,text)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.create_organization_founder_invitation(text,text,text,text,text,uuid)'))
      is distinct from 'c21331d8135d78857ba1d1bf00586ff6' then
    raise exception 'unreviewed predecessor: public.create_organization_founder_invitation(text,text,text,text,text,uuid)' using errcode = '55000';
  end if;
end;
$invitation_expiry_sources$;

-- Preserve the exact predecessor chain of the unit-aware invitation writer.
-- A later Main-side change must be incorporated before this migration applies.
do $invitation_expiry_predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(
       'public.create_member_invitation(text,text,text,text,text,text,uuid)')))
       is distinct from '0d332d900f42d5028cfdebc6337d9f2f' then
    raise exception 'unreviewed predecessor: public.create_member_invitation'
      using errcode = '55000';
  end if;
end;
$invitation_expiry_predecessor$;

create function private.expire_member_invitation_email(p_normalized_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  expired_row public.member_invitations%rowtype;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  -- Serialize with every existing invitation producer for this email. The
  -- argument selects rows only; neither it nor the caller's identity is
  -- written to the row or to the other chapter's audit.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || p_normalized_email, 509)
  );
  for expired_row in
    update public.member_invitations
    set status = 'expired', token_hash = null, failure_code = null
    where normalized_email = p_normalized_email
      and status = 'pending'
      and expires_at <= pg_catalog.clock_timestamp()
    returning *
  loop
    perform private.audit_member_invitation(
      expired_row.id, expired_row.chapter_id, null, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', expired_row.chapter_id,
        'deliveryVersion', expired_row.delivery_version)
    );
  end loop;
end;
$function$;

revoke all on function private.expire_member_invitation_email(text)
  from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text, p_unit_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  target_chapter text := pg_catalog.btrim(coalesce(p_chapter_id, ''));
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_name text := pg_catalog.btrim(coalesce(p_full_name, ''));
  clean_role text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_initial_role, ''))), '');
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  name_parts text[];
  clean_first text;
  clean_initials text;
  invitation_row public.member_invitations%rowtype;
  as_admin boolean;
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- An admin may invite into any chapter they administer in the selected
  -- organization. A chapter President may invite only into a chapter they
  -- preside over, and only as a plain member (project decision, October 4,
  -- 2026). The desk gate above already holds the organization-role lock.
  as_admin := private.member_invitation_chapter_administrable(target_chapter);
  if not as_admin and (clean_role is not null
     or not private.member_invitation_chapter_presided(target_chapter)) then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  if clean_role is not null and (coalesce(auth.jwt()->>'aal','')<>'aal2' or not private.has_second_factor(caller)) then raise exception 'two-step sign-in required for starting access' using errcode='42501'; end if;

  if clean_role='steward' and p_unit_id is null then
    raise exception 'steward invitation requires a chapter unit' using errcode='22023';
  end if;
  if p_unit_id is not null and not exists(select 1 from private.chapter_units
      where id=p_unit_id and chapter_id=target_chapter and organization_id=private.current_member_organization()) then
    raise exception 'unit outside invitation chapter' using errcode='42501';
  end if;
  -- Count before duplicate/existing-account branches. Those branches must not
  -- be a free unbounded address-probing endpoint.
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'create-hour', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_admin_hourly'), interval '1 hour'
  ) or not private.consume_member_invitation_admin_limit(
    'chapter:' || target_chapter, 'chapter-day', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_chapter_daily'), interval '1 day'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es')
     or (clean_role is not null and clean_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'vp', 'admin', 'secretary', 'records', 'treasurer')) then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  name_parts := pg_catalog.regexp_split_to_array(clean_name, '[[:space:]]+');
  clean_first := name_parts[1];
  clean_initials := pg_catalog.upper(
    pg_catalog.left(clean_first, 1)
    || case when pg_catalog.array_length(name_parts, 1) > 1
       then pg_catalog.left(name_parts[pg_catalog.array_length(name_parts, 1)], 1)
       else '' end
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509)
  );

  perform private.expire_member_invitation_email(clean_email);

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
     expires_at)
  values
    (clean_email, clean_name, clean_first, clean_initials, target_chapter,
     clean_role, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '15 minutes')
  returning * into invitation_row;
  if p_unit_id is not null then
    insert into private.member_invitation_units(invitation_id,unit_id) values(invitation_row.id,p_unit_id);
  end if;
  perform private.learning_journal_append('invitation_send', 'public.member_invitations', invitation_row.id::text);

  perform private.audit_member_invitation(
    invitation_row.id, target_chapter, caller, 'invite_requested',
    pg_catalog.jsonb_build_object('chapterId', target_chapter,
      'initialRole', clean_role, 'locale', clean_locale,
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

CREATE OR REPLACE FUNCTION public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if not private.mfa_satisfied() then
    raise exception 'two-step verification required' using errcode='42501';
  end if;
  return public.create_member_invitation(p_email,p_full_name,p_chapter_id,p_initial_role,p_locale,p_token_hash,null::uuid);
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_roster_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_locale text, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  target_chapter text := pg_catalog.btrim(coalesce(p_chapter_id, ''));
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_name text := pg_catalog.btrim(coalesce(p_full_name, ''));
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  organization uuid;
  name_parts text[];
  clean_first text;
  clean_initials text;
  invitation_row public.member_invitations%rowtype;
  refused_limit text;
  refused_scope text;
  refused_operation text;
  refused_window interval;
  day_retry timestamptz;
  refused_retry timestamptz;
begin
  -- Roster import is for chapter administrators only; a chapter President keeps
  -- the ad-hoc invitation and its limits.
  if caller is null or not private.member_has_chapter_role(caller_chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if not private.member_invitation_chapter_administrable(target_chapter) then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  -- A malformed request is refused before any lookup or charge, the same way
  -- for every address. Validating after the account probe let an unknown
  -- address raise (rolling back its lookup charge) while an existing one
  -- answered 202, which is free probing.
  name_parts := pg_catalog.regexp_split_to_array(clean_name, '[[:space:]]+');
  clean_first := name_parts[1];
  clean_initials := pg_catalog.upper(
    pg_catalog.left(clean_first, 1)
    || case when pg_catalog.array_length(name_parts, 1) > 1
       then pg_catalog.left(name_parts[pg_catalog.array_length(name_parts, 1)], 1)
       else '' end
  );
  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or pg_catalog.char_length(coalesce(clean_first, '')) not between 1 and 80
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es') then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  -- Every row is charged to the roster lookup throttle before any lookup can
  -- shape the answer, so the endpoint stays bounded for address probing
  -- (count-before-lookup, as in the ad-hoc create). An address that already
  -- has an account or a live invitation is then answered without touching the
  -- sending allowance, so re-sending a roster that lists current members, or
  -- people already invited, never exhausts it (project decision 20261021-2220,
  -- option b). A failed delivery is not a no-op: re-sending it creates a new
  -- invitation and email, and that counts as a send.
  organization := private.current_member_organization();
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'roster-lookup-hour', private.organization_limit(organization, 'limits.security.invitation_roster_lookup_hourly'), interval '1 hour'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001',
      detail = pg_catalog.jsonb_build_object(
        'limit', 'limits.security.invitation_roster_lookup_hourly',
        'retryAt', private.member_invitation_limit_retry_at('admin:' || caller::text, 'roster-lookup-hour', interval '1 hour')
      )::text;
  end if;
  -- Everything after the lookup charge runs in one subtransaction. Only an
  -- unknown address reaches the sending charges, the expiry update and the
  -- insert, so any error there (a constraint, a reused token hash, an audit
  -- write) must not roll the charge back: it is caught here, only this block
  -- is undone, and a refusal is returned with the charge committed for every
  -- address.
  begin
  if exists (
    select 1 from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
  ) or exists (
    select 1 from public.member_invitations i
    where i.normalized_email = clean_email
      and (i.status = 'accepting' or (i.status = 'pending' and i.expires_at > clock_timestamp()))
  ) then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;

  -- The sending charges run in their own subtransaction. A refusal rolls back
  -- only roster-hour and roster-day; the lookup charge above stays committed,
  -- and the refusal is returned as a result (the API answers 429). A RAISE
  -- here would also undo the lookup charge, so once the sending allowance was
  -- spent an unknown address would cost nothing while an existing one cost a
  -- lookup: free probing for accounts.
  begin
    if not private.consume_member_invitation_admin_limit(
      'admin:' || caller::text, 'roster-hour', private.organization_limit(organization, 'limits.security.invitation_roster_admin_hourly'), interval '1 hour'
    ) then
      refused_limit := 'limits.security.invitation_roster_admin_hourly';
      refused_scope := 'admin:' || caller::text;
      refused_operation := 'roster-hour';
      refused_window := interval '1 hour';
    elsif not private.consume_member_invitation_admin_limit(
      'chapter:' || target_chapter, 'roster-day', private.organization_limit(organization, 'limits.security.invitation_roster_chapter_daily'), interval '1 day'
    ) then
      refused_limit := 'limits.security.invitation_roster_chapter_daily';
      refused_scope := 'chapter:' || target_chapter;
      refused_operation := 'roster-day';
      refused_window := interval '1 day';
    end if;
    -- An hourly stop while the chapter's daily window is also spent reports the
    -- later of the two, so the retry time is when sending can actually resume.
    if refused_operation = 'roster-hour' then
      select l.window_started_at + interval '1 day' into day_retry
      from private.member_invitation_admin_limits l
      where l.scope_key = 'chapter:' || target_chapter and l.operation = 'roster-day'
        and l.window_started_at + interval '1 day' > clock_timestamp()
        and l.request_count >= private.organization_limit(organization, 'limits.security.invitation_roster_chapter_daily');
      if day_retry is not null
         and day_retry > private.member_invitation_limit_retry_at(refused_scope, refused_operation, refused_window) then
        refused_limit := 'limits.security.invitation_roster_chapter_daily';
        refused_scope := 'chapter:' || target_chapter;
        refused_operation := 'roster-day';
        refused_window := interval '1 day';
      end if;
    end if;
    if refused_limit is not null then
      refused_retry := private.member_invitation_limit_retry_at(refused_scope, refused_operation, refused_window);
      raise exception 'invitation rate limited' using errcode = 'P0001';
    end if;
  exception when sqlstate 'P0001' then
    if refused_limit is null then
      raise;
    end if;
    return pg_catalog.jsonb_build_object(
      'accepted', false, 'send', false, 'rateLimited', true,
      'limit', refused_limit, 'retryAt', refused_retry);
  end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509)
  );

  perform private.expire_member_invitation_email(clean_email);

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
     expires_at, source)
  values
    (clean_email, clean_name, clean_first, clean_initials, target_chapter,
     null, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '7 days', 'roster')
  returning * into invitation_row;
  perform private.learning_journal_append('invitation_send', 'public.member_invitations', invitation_row.id::text);

  perform private.audit_member_invitation(
    invitation_row.id, target_chapter, caller, 'invite_requested',
    pg_catalog.jsonb_build_object('chapterId', target_chapter,
      'initialRole', null, 'locale', clean_locale, 'source', 'roster',
      'deliveryVersion', invitation_row.delivery_version)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'expiresAt', invitation_row.expires_at,
    'source', 'roster'
  );
  exception when others then
    return pg_catalog.jsonb_build_object('accepted', false, 'send', false, 'unavailable', true);
  end;
end;
end;
$function$;

create or replace function public.create_former_member_invitation(p_email text, p_chapter_id text, p_locale text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  -- The same desk gate as every other invitation write: a chapter admin of the
  -- selected chapter, resolved under the organization-role -> member lock
  -- order. The target chapter must then be one the caller administers in the
  -- selected organization, the same rule the list, delivery record, resend and
  -- revoke RPCs apply, so whoever can issue this invitation can also manage it.
  caller_chapter text := private.require_member_invitation_admin_chapter();
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  target_org uuid;
  locked_org uuid;
  target_user uuid;
  prior_revoked_at timestamptz;
  profile_row public.member_profiles%rowtype;
  invitation_row public.member_invitations%rowtype;
begin
  -- Organization admin only, with the second factor every admin membership
  -- write demands. private.has_organization_role already carries the MFA
  -- step-up; the explicit check keeps the refusal the same when it is absent.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is null or not private.has_organization_role(target_org, array['admin']) then
    raise exception 'organization admin role required' using errcode = '42501';
  end if;
  if caller_chapter is null
     or not private.member_invitation_chapter_administrable(p_chapter_id) then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es') then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  -- Count before the eligibility branches: an ineligible address must not be a
  -- free unbounded probing endpoint. Same persisted buckets as the ordinary
  -- invitation, so one admin's budget is one budget.
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'create-hour', 10, interval '1 hour'
  ) or not private.consume_member_invitation_admin_limit(
    'chapter:' || p_chapter_id, 'chapter-day', 50, interval '1 day'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || target_org::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509)
  );

  -- Re-derive and re-authorize under the tenant lock, as the grant and
  -- set_member_organization_role do: a request that queued behind a role
  -- revocation must not expire or issue invitations with the authority it had
  -- before the lock was granted.
  select c.organization_id into locked_org
  from public.chapters c
  where c.id = p_chapter_id;
  if locked_org is distinct from target_org
     or not private.mfa_satisfied()
     or not private.has_organization_role(target_org, array['admin']) then
    raise exception 'organization admin role required' using errcode = '42501';
  end if;

  perform private.expire_member_invitation_email(clean_email);

  -- Eligibility: exactly one live account owns the address, it has a profile,
  -- its membership in THIS organization is revoked, and it is active in no
  -- organization. Anything else (no account, never a member here, active
  -- here or elsewhere, a live invitation already out) returns the uniform
  -- accepted/no-send outcome and writes nothing.
  select u.id into target_user
  from auth.users u
  where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.clock_timestamp())
  order by u.created_at
  limit 1;
  if target_user is null then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || target_user::text, 0));
  select * into profile_row from public.member_profiles p where p.id = target_user;
  select om.revoked_at into prior_revoked_at
  from public.organization_memberships om
  where om.organization_id = target_org
    and om.user_id = target_user
    and om.status = 'revoked';
  if not found
     or profile_row.id is null
     or exists (
       select 1 from public.organization_memberships other
       where other.user_id = target_user and other.status = 'active'
     )
     or exists (
       select 1 from public.member_invitations i
       where i.normalized_email = clean_email and i.status in ('pending', 'accepting')
     ) then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     expires_at, kind)
  values
    (clean_email, profile_row.full_name, profile_row.first_name, profile_row.initials, p_chapter_id,
     null, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '15 minutes', 'reactivation')
  returning * into invitation_row;
  perform private.learning_journal_append('invitation_send', 'public.member_invitations', invitation_row.id::text);

  perform private.audit_member_invitation(
    invitation_row.id, p_chapter_id, caller, 'reinvite_requested',
    pg_catalog.jsonb_build_object('chapterId', p_chapter_id,
      'organizationId', target_org, 'priorRevokedAt', prior_revoked_at,
      'locale', clean_locale, 'deliveryVersion', invitation_row.delivery_version)
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
  if not private.consume_member_invitation_admin_limit('member-chapter:' || home_chapter, 'chapter-day',
       private.organization_limit(caller_org, 'limits.security.invitation_chapter_daily'), interval '1 day') then
    perform private.member_invitation_limit_refusal('member-chapter:' || home_chapter, 'chapter-day',
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

  perform private.expire_member_invitation_email(clean_email);

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

CREATE OR REPLACE FUNCTION public.create_organization_founder_invitation(p_organization_name text, p_email text, p_full_name text, p_locale text, p_token_hash text, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  clean_name text;
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_full text := pg_catalog.btrim(coalesce(p_full_name, ''));
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  name_parts text[];
  clean_first text;
  clean_initials text;
  new_slug text;
  new_chapter text;
  org_id uuid;
  invitation_row public.member_invitations%rowtype;
  replay record;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select l.event_type, l.organization_id,
         l.metadata ->> 'chapterId' as chapter_id,
         l.metadata ->> 'entityId' as invitation_id
    into replay
    from public.organization_audit_ledger l
   where l.idempotency_key = p_idempotency_key;
  if found then
    if replay.event_type = 'organization_founder_invited' then
      return pg_catalog.jsonb_build_object(
        'status', 'invited',
        'organizationId', replay.organization_id,
        'chapterId', replay.chapter_id,
        'invitationId', replay.invitation_id,
        'send', false,
        'idempotent', true);
    end if;
    raise exception 'idempotency key reused' using errcode = '22023';
  end if;

  -- The same organization-name rules as public.create_my_organization.
  clean_name := pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.normalize(coalesce(p_organization_name, ''), 'NFKC'), '[[:space:]]+', ' ', 'g'));
  if pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or clean_name !~ '[[:alnum:]]'
     or clean_name ~ '[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯︀-️﻿]'
     or pg_catalog.strpos(clean_name, '@') > 0
     or pg_catalog.strpos(clean_name, '://') > 0 then
    raise exception 'invalid founder invitation' using errcode = '22023';
  end if;
  -- #9164: a name holding a phone number is refused with a detail the
  -- operator command reads, so it can say why in plain words.
  if pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(clean_name,
       '(^|[^0-9./-]|[^0-9][./-])((19|20)[0-9]{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])|(0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])[-/.]((19|20)[0-9]{2}|[0-9]{2}))(?![-/.]?[0-9])', '\1|', 'g'),
       '(^|[^0-9[:space:]().+/_\u2010-\u2015\u2212\uFF0D-])([[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]*[0-9]{4,5})([[:space:]]+|[[:space:]]*\()(19|20)[0-9]{2}(?![[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]*[0-9])', '\1\2|', 'g'),
       '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}' then
    raise exception 'invalid founder invitation' using errcode = '22023',
      detail = 'organization name holds a phone number';
  end if;

  -- The same invitee rules as public.create_member_invitation.
  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(clean_full) not between 2 and 120
     or clean_full ~ '[[:cntrl:]]'
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es') then
    raise exception 'invalid founder invitation' using errcode = '22023';
  end if;

  name_parts := pg_catalog.regexp_split_to_array(clean_full, '[[:space:]]+');
  clean_first := name_parts[1];
  clean_initials := pg_catalog.upper(
    pg_catalog.left(clean_first, 1)
    || case when pg_catalog.array_length(name_parts, 1) > 1
       then pg_catalog.left(name_parts[pg_catalog.array_length(name_parts, 1)], 1)
       else '' end
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509));
  -- As in create_member_invitation: a pending invitation past its expiry is
  -- expired first, because member_invitations_one_live_email_idx still
  -- counts it.
  perform private.expire_member_invitation_email(clean_email);

  -- A founder must be new to Union Ground: an existing account or a live
  -- invitation for the address refuses before anything is created.
  if exists (
    select 1 from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
  ) or exists (
    select 1 from public.member_invitations i
    where i.normalized_email = clean_email
      and i.status in ('pending', 'accepting')
  ) then
    return pg_catalog.jsonb_build_object('status', 'email_unavailable');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-name:' || pg_catalog.lower(clean_name), 509));
  if exists (
    select 1 from public.organizations o
    where pg_catalog.lower(o.name) = pg_catalog.lower(clean_name)
  ) then
    return pg_catalog.jsonb_build_object('status', 'name_unavailable');
  end if;

  new_slug := 'u-' || pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(8), 'hex'), 1, 10);
  new_chapter := 'c-' || pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(8), 'hex'), 1, 10);
  if exists (select 1 from public.organizations o where o.slug = new_slug)
     or exists (select 1 from public.chapters c where c.id = new_chapter or c.slug = new_chapter) then
    new_slug := 'u-' || pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(8), 'hex'), 1, 10);
    new_chapter := 'c-' || pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(8), 'hex'), 1, 10);
  end if;

  begin
    insert into public.organizations (slug, name, status, created_by)
    values (new_slug, clean_name, 'active', null)
    returning id into org_id;

    insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by)
    values (true, org_id, true, null);

    insert into public.chapters (id, name, region, is_default, order_index, organization_id, slug)
    values (new_chapter, clean_name, null, true, 1, org_id, new_chapter);
  exception when unique_violation then
    return pg_catalog.jsonb_build_object('status', 'name_unavailable');
  end;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     expires_at, kind)
  values
    (clean_email, clean_full, clean_first, clean_initials, new_chapter,
     null, clean_locale, clean_hash, 'pending', 1, null,
     pg_catalog.clock_timestamp() + interval '15 minutes', 'founder')
  returning * into invitation_row;

  perform private.audit_member_invitation(
    invitation_row.id, new_chapter, null, 'invite_requested',
    pg_catalog.jsonb_build_object('chapterId', new_chapter,
      'kind', 'founder', 'locale', clean_locale,
      'deliveryVersion', invitation_row.delivery_version)
  );

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org_id, 'administration', 'organization_founder_invited', 'create', null,
    'organization', org_id::text, p_idempotency_key,
    pg_catalog.jsonb_build_object(
      'organizationId', org_id::text,
      'chapterId', new_chapter,
      'entityType', 'invitation',
      'entityId', invitation_row.id::text,
      'status', 'invited')
  );

  return pg_catalog.jsonb_build_object(
    'status', 'invited',
    'organizationId', org_id,
    'chapterId', new_chapter,
    'slug', new_slug,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'expiresAt', invitation_row.expires_at,
    'send', true,
    'idempotent', false);
end;
end;
$function$;

commit;
