-- BUG-UG-ORGANIZATION-NAME-WITH-A-LOCAL-NUMBER-AND-A-DATE-REFUSED-AS-A-PHONE-NUMBER-20261118 (#9164)
--
-- Four functions keep phone numbers out of organization names with one
-- expression: drop spaces, brackets, dots, slashes, plus signs, underscores
-- and dashes, then refuse any run of seven or more digits. A local number
-- next to a year or a date joins into one long run, so ordinary names were
-- refused: "Harrow Bay Local 3307 (2026-11-18)" became 330720261118 and
-- "Harrow Bay Local 3307 2026" became 33072026. The founder invitation
-- refused with no reason the operator could read.
--
-- The rule, in plain words. A name holds a phone number when it has seven or
-- more digits in a row once spaces, brackets, dots, slashes, plus signs,
-- underscores and dashes between them are dropped. Two things are read as
-- their own number first and never join the digits beside them:
--   1. A calendar date written with dashes, slashes or dots, either year,
--      month, day (2026-11-18, 2026/11/18) or month, day, year with a two or
--      four digit year (11/18/2026, 11-18-26). The year is 1900 to 2099, the
--      month 1 to 12, the day 1 to 31, and no other digit touches the date
--      directly or across one dash, slash or dot.
--   2. A year from 1900 to 2099 that comes right after a number of four or
--      five digits, after a space or an opening bracket ("Local 3307 2026",
--      "Local 3307 (2026)"), when no other digit group comes before that
--      number or after the year. A three digit number before a year stays
--      joined, because that is the shape of a seven digit phone number
--      ("555 2014"); a comma still separates any two numbers, as before.
-- Everything else is unchanged: "Local 3307 555-201-4477",
-- "(555) 201 4477" and "+1 555 201 4477" are still refused, and so is any
-- run of seven digits that is not a date or such a year.
--
-- The website applies the same rule in src/lib/openSignup.js
-- (organizationNameProblem), and tests/organization-name-phone-rule-db.test.js
-- holds the two to the same answer for every example.
--
-- Restated from their live definitions, each with only its name check
-- changed:
--   public.create_organization_founder_invitation  20261003010000
--   public.create_my_organization                  20261017024400
--   public.submit_organization_claim               20261113123500 (name and city)
--   public.set_organization_catalog_placement      20260930040000
-- The founder invitation also moves the phone check to its own branch, which
-- raises the same 22023 'invalid founder invitation' with the detail
-- 'organization name holds a phone number' that the operator command reads.
-- Its invisible-character class is unchanged; its digit separator class is
-- written with \u escapes like the other three (the same characters).
-- Language, volatility, security mode, search_path, signature, owner, grants
-- and comments do not change (CREATE OR REPLACE keeps grants and comments).
-- A predecessor guard refuses to run unless each live definition is the
-- reviewed one.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

do $predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.create_organization_founder_invitation(text, text, text, text, text, uuid)'))) is distinct from '5812f8560a869a2f8a1c7a23e741fd03' then
    raise exception 'unreviewed predecessor: public.create_organization_founder_invitation' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.create_my_organization(text, uuid)'))) is distinct from 'f6f30a4b7f7cb4aac04665ab9a8574f9' then
    raise exception 'unreviewed predecessor: public.create_my_organization' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.submit_organization_claim(text, text, text, jsonb, jsonb, jsonb, text, text, uuid, uuid)'))) is distinct from 'a33cce427dc8616e0726b7f45913b3a7' then
    raise exception 'unreviewed predecessor: public.submit_organization_claim' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.set_organization_catalog_placement(text, uuid, text, text, text, boolean, uuid)'))) is distinct from 'dd454d355d44d4c6597077212ee61a7f' then
    raise exception 'unreviewed predecessor: public.set_organization_catalog_placement' using errcode = '55000';
  end if;
end;
$predecessor$;

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
  expired_row public.member_invitations%rowtype;
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
  for expired_row in
    update public.member_invitations
    set status = 'expired', token_hash = null, failure_code = null
    where normalized_email = clean_email
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

CREATE OR REPLACE FUNCTION public.create_my_organization(p_name text, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid;
  clean_name text;
  new_slug text;
  new_chapter text;
  org_id uuid;
  user_scope text;
  replay record;
  -- Raising either cap or changing cohort requires a new owner review and reviewed migration.
  daily_cap constant integer := 5;
  cohort_cap constant integer := 25;
  current_cohort constant text := 'public-launch-2026-10';
begin
  caller := (select auth.uid());
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = caller
      and u.email_confirmed_at is not null
      and u.deleted_at is null
      and not coalesce(u.is_anonymous, false)
      and (u.banned_until is null or u.banned_until <= pg_catalog.now())
  ) then
    raise exception 'email confirmation required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.member_profiles p where p.id = caller) then
    raise exception 'account not ready' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- A replay runs before the membership check: the first call made the
  -- caller a member of the new organization.
  select l.event_type, l.actor_user_id, l.organization_id, l.metadata ->> 'chapterId' as chapter_id
    into replay
    from public.organization_audit_ledger l
   where l.idempotency_key = p_idempotency_key;
  if found then
    if replay.event_type = 'organization_self_created' and replay.actor_user_id = caller then
      return pg_catalog.jsonb_build_object(
        'status', 'created',
        'organizationId', replay.organization_id,
        'chapterId', replay.chapter_id,
        'slug', (select o.slug from public.organizations o where o.id = replay.organization_id),
        'idempotent', true);
    end if;
    raise exception 'idempotency key reused' using errcode = '22023';
  end if;

  -- Nothing is created until the owner opens the signup period. Not a
  -- counted outcome: it charges no limit.
  if not private.open_signup_is_open() then
    return pg_catalog.jsonb_build_object('status', 'closed');
  end if;

  if exists (
    select 1 from public.organization_memberships om
    where om.user_id = caller and om.status = 'active'
  ) then
    raise exception 'organization membership exists' using errcode = '22023';
  end if;

  -- The organization name is the only free text at signup; the default
  -- chapter takes the same name and is renamed later in the setup review.
  -- Other organizations can see it, so it follows the rules the Phase 4a
  -- placement applies to an unlisted parent name. Collapse every whitespace
  -- run to one space first, then trim, so a tab or newline at either end
  -- never survives into the stored name.
  clean_name := pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.normalize(coalesce(p_name, ''), 'NFKC'), '[[:space:]]+', ' ', 'g'));
  if pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or clean_name !~ '[[:alnum:]]'
     -- Invisible and format characters (zero-width, bidirectional controls,
     -- variation selectors, fillers) never appear in a name.
     or clean_name ~ '[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]'
     or pg_catalog.strpos(clean_name, '@') > 0
     or pg_catalog.strpos(clean_name, '://') > 0
     or pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(clean_name,
         '(^|[^0-9./-]|[^0-9][./-])((19|20)[0-9]{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])|(0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])[-/.]((19|20)[0-9]{2}|[0-9]{2}))(?![-/.]?[0-9])', '\1|', 'g'),
         '(^|[^0-9[:space:]().+/_\u2010-\u2015\u2212\uFF0D-])([[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]*[0-9]{4,5})([[:space:]]+|[[:space:]]*\()(19|20)[0-9]{2}(?![[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]*[0-9])', '\1\2|', 'g'),
         '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}' then
    raise exception 'invalid organization' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.organizations o
    where o.created_by = caller and o.self_serve_created_at is not null
  ) then
    return pg_catalog.jsonb_build_object('status', 'limit_reached');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('open-signup:platform', 509));
  -- A confirmed founder owns a place already. Exclude only that caller's
  -- unconsumed reservation; unreserved direct RPC callers cannot steal it.
  if (select pg_catalog.count(*) from private.open_signup_cohort_admissions a
      where a.admitted_at > pg_catalog.clock_timestamp() - interval '24 hours')
     + (select pg_catalog.count(*) from private.open_signup_intake_reservations r
        where r.consumed_at is null and r.user_id <> caller
          and r.reserved_at > pg_catalog.clock_timestamp() - interval '24 hours') >= daily_cap
     or (select pg_catalog.count(*) from private.open_signup_cohort_admissions a
      where a.cohort = current_cohort)
     + (select pg_catalog.count(*) from private.open_signup_intake_reservations r
        where r.consumed_at is null and r.user_id <> caller and r.cohort = current_cohort) >= cohort_cap then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;

  -- Capacity refusals charge no user attempt: an older reserved founder
  -- can retry when daily room opens. Other counted outcomes commit a charge.
  user_scope := pg_catalog.encode(
    extensions.digest('open-signup-user:' || caller::text, 'sha256'), 'hex');
  if not private.consume_open_signup_limit_internal(user_scope, 'user-create-day') then
    return pg_catalog.jsonb_build_object('status', 'limit_reached');
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
    insert into public.organizations (slug, name, status, created_by, self_serve_created_at)
    values (new_slug, clean_name, 'active', caller, pg_catalog.now())
    returning id into org_id;

    insert into private.open_signup_cohort_admissions (organization_id, cohort)
    values (org_id, current_cohort);
    update private.open_signup_intake_reservations
      set consumed_at = pg_catalog.clock_timestamp()
      where user_id = caller and consumed_at is null and cohort = current_cohort;

    insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by)
    values (true, org_id, true, caller);

    insert into public.chapters (id, name, region, is_default, order_index, organization_id, slug)
    values (new_chapter, clean_name, null, true, 1, org_id, new_chapter);

    insert into public.organization_memberships (organization_id, user_id, status)
    values (org_id, caller, 'active');

    insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
    values (org_id, caller, 'admin', caller);

    insert into public.member_chapter_memberships (user_id, chapter_id, status, last_selected_at)
    values (caller, new_chapter, 'active', pg_catalog.now())
    on conflict (user_id, chapter_id) do update
      set status = 'active', revoked_at = null, last_selected_at = pg_catalog.now();

    update public.member_profiles
    set chapter_id = new_chapter
    where id = caller;

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org_id, 'administration', 'organization_self_created', 'create', caller,
      'organization', org_id::text, p_idempotency_key,
      pg_catalog.jsonb_build_object(
        'organizationId', org_id::text,
        'chapterId', new_chapter,
        'userId', caller::text,
        'status', 'unverified')
    );
  exception when unique_violation then
    return pg_catalog.jsonb_build_object('status', 'name_unavailable');
  end;

  return pg_catalog.jsonb_build_object(
    'status', 'created',
    'organizationId', org_id,
    'chapterId', new_chapter,
    'slug', new_slug,
    'idempotent', false);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_organization_claim(p_scope_hash text, p_email_scope_hash text, p_catalog_key text, p_unlisted jsonb, p_claimant jsonb, p_attestation jsonb, p_locale text, p_confirm_token_hash text, p_requesting_user_id uuid, p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  moment timestamptz;
  clean_claimant_name text;
  clean_claimant_title text;
  clean_claimant_email text;
  clean_claimant_statement text;
  clean_unlisted_name text;
  clean_unlisted_city text;
  clean_unlisted_state text;
  allowed boolean;
  target_normalized text;
  new_claim_id uuid;
begin
  perform private.lock_case_graph(array[p_requesting_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  moment := clock_timestamp();

  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;
  if p_confirm_token_hash is null or p_confirm_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid confirmation token' using errcode = '22023';
  end if;
  if p_locale is null or p_locale not in ('en', 'es') then
    raise exception 'invalid locale' using errcode = '22023';
  end if;
  if p_attestation is null or p_attestation is distinct from
       '{"version":"claim-attest/1","officer":true,"verifyFirst":true,"noPersonalData":true,"notEmployer":true}'::jsonb then
    raise exception 'attestation required' using errcode = '22023';
  end if;

  -- Exactly one target: a catalog key, or an unlisted organization.
  if pg_catalog.num_nonnulls(p_catalog_key, p_unlisted) <> 1 then
    raise exception 'claim target invalid' using errcode = '22023';
  end if;
  if p_catalog_key is not null and p_catalog_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
    raise exception 'claim target invalid' using errcode = '22023';
  end if;
  if p_unlisted is not null then
    if pg_catalog.jsonb_typeof(p_unlisted) is distinct from 'object'
       or p_unlisted - array['name', 'city', 'state'] <> '{}'::jsonb
       or pg_catalog.jsonb_typeof(p_unlisted -> 'name') is distinct from 'string'
       or (p_unlisted ? 'city' and pg_catalog.jsonb_typeof(p_unlisted -> 'city') not in ('string', 'null'))
       or (p_unlisted ? 'state' and pg_catalog.jsonb_typeof(p_unlisted -> 'state') not in ('string', 'null')) then
      raise exception 'claim target invalid' using errcode = '22023';
    end if;
    clean_unlisted_name := pg_catalog.btrim(p_unlisted ->> 'name');
    clean_unlisted_city := nullif(pg_catalog.btrim(coalesce(p_unlisted ->> 'city', '')), '');
    clean_unlisted_state := nullif(pg_catalog.btrim(coalesce(p_unlisted ->> 'state', '')), '');
    -- The unlisted name is shown to a vouching organization's admins, so it
    -- gets 4a's placement-name filter: no email, link or phone number.
    if pg_catalog.char_length(clean_unlisted_name) not between 3 and 200
       or clean_unlisted_name ~ '[[:cntrl:]]'
       or clean_unlisted_name !~ '[[:alnum:]]'
       or pg_catalog.strpos(clean_unlisted_name, '@') > 0
       or pg_catalog.strpos(clean_unlisted_name, '://') > 0
       or pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(clean_unlisted_name,
           '(^|[^0-9./-]|[^0-9][./-])((19|20)[0-9]{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])|(0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])[-/.]((19|20)[0-9]{2}|[0-9]{2}))(?![-/.]?[0-9])', '\1|', 'g'),
           '(^|[^0-9[:space:]().+/_\u2010-\u2015\u2212\uFF0D-])([[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]*[0-9]{4,5})([[:space:]]+|[[:space:]]*\()(19|20)[0-9]{2}(?![[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]*[0-9])', '\1\2|', 'g'),
           '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}'
       or (clean_unlisted_city is not null and (pg_catalog.char_length(clean_unlisted_city) > 120 or clean_unlisted_city ~ '[[:cntrl:]]'
           or pg_catalog.strpos(clean_unlisted_city, '@') > 0
           or pg_catalog.strpos(clean_unlisted_city, '://') > 0
           or pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(clean_unlisted_city,
               '(^|[^0-9./-]|[^0-9][./-])((19|20)[0-9]{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])|(0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])[-/.]((19|20)[0-9]{2}|[0-9]{2}))(?![-/.]?[0-9])', '\1|', 'g'),
               '(^|[^0-9[:space:]().+/_\u2010-\u2015\u2212\uFF0D-])([[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]*[0-9]{4,5})([[:space:]]+|[[:space:]]*\()(19|20)[0-9]{2}(?![[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]*[0-9])', '\1\2|', 'g'),
               '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}'))
       or (clean_unlisted_state is not null and clean_unlisted_state !~ '^[A-Z]{2}$') then
      raise exception 'claim target invalid' using errcode = '22023';
    end if;
  end if;

  -- The claimant: exactly name, title, email and statement, all strings.
  if pg_catalog.jsonb_typeof(p_claimant) is distinct from 'object'
     or (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(p_claimant) as k)
          is distinct from array['email', 'name', 'statement', 'title']
     or pg_catalog.jsonb_typeof(p_claimant -> 'name') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'title') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'email') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'statement') <> 'string' then
    raise exception 'claimant invalid' using errcode = '22023';
  end if;
  clean_claimant_name := pg_catalog.btrim(p_claimant ->> 'name');
  clean_claimant_title := pg_catalog.btrim(p_claimant ->> 'title');
  clean_claimant_email := pg_catalog.btrim(p_claimant ->> 'email');
  clean_claimant_statement := nullif(pg_catalog.btrim(p_claimant ->> 'statement'), '');
  if pg_catalog.char_length(clean_claimant_name) not between 2 and 120 or clean_claimant_name ~ '[[:cntrl:]]'
     or pg_catalog.char_length(clean_claimant_title) not between 1 and 120 or clean_claimant_title ~ '[[:cntrl:]]'
     or pg_catalog.char_length(clean_claimant_email) not between 3 and 254
     or clean_claimant_email <> pg_catalog.lower(clean_claimant_email)
     or clean_claimant_email !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'
     or pg_catalog.char_length(coalesce(clean_claimant_statement, '')) > 1000 then
    raise exception 'claimant invalid' using errcode = '22023';
  end if;

  -- The requesting admin of an existing organization (organizations are
  -- created at signup, never by a claim).
  if p_requesting_user_id is null or p_organization_id is null then
    raise exception 'claim requester invalid' using errcode = '22023';
  end if;
  if not exists (
       select 1 from public.organizations as o
        where o.id = p_organization_id and o.status = 'active' and o.kind = 'union')
     or not exists (
       select 1 from public.organization_memberships as m
        where m.organization_id = p_organization_id
          and m.user_id = p_requesting_user_id
          and m.status = 'active')
     or not exists (
       select 1 from public.organization_role_grants as g
        where g.organization_id = p_organization_id
          and g.user_id = p_requesting_user_id
          and g.role = 'admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Limits, then silent refusals. Every refusal answers exactly like success.
  allowed := private.consume_public_interest_submission_limit(
    p_scope_hash, 'claim-network-hour', 5, interval '1 hour');
  if allowed then
    allowed := private.consume_public_interest_submission_limit(
      p_email_scope_hash, 'claim-email-day', 3, interval '1 day');
  end if;
  if allowed then
    allowed := private.consume_public_interest_submission_limit(
      pg_catalog.encode(extensions.digest('organization-claim-org:' || p_organization_id::text, 'sha256'), 'hex'),
      'claim-org-day', 3, interval '1 day');
  end if;

  if allowed then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-target:' || coalesce(p_catalog_key, 'unlisted'), 509));
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-org:' || p_organization_id::text, 509));

    target_normalized := coalesce(p_catalog_key, 'unlisted:' || pg_catalog.lower(clean_unlisted_name));

    -- A claim whose confirmation deadline has passed is lapsed even before the
    -- daily sweep runs: expire it here, exactly as the sweep would, so it never
    -- blocks this organization or this listing.
    with lapsed as (
      update private.organization_claims as c
         set status = 'expired',
             confirm_token_hash = null,
             closed_at = pg_catalog.now(),
             updated_at = pg_catalog.now()
       where c.status = 'awaiting_email'
         and c.confirm_expires_at <= pg_catalog.now()
         and (c.organization_id = p_organization_id
              or coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized)
      returning c.id, c.organization_id, c.catalog_key
    )
    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    )
    select 'claim_expired', 'system', null, 'claim', lapsed.id, lapsed.organization_id,
           pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
             'catalogKey', lapsed.catalog_key, 'fromStatus', 'awaiting_email', 'toStatus', 'expired')),
           extensions.gen_random_uuid()
      from lapsed;

    if p_catalog_key is not null and not exists (
         select 1 from private.catalog_organizations as o
          where o.catalog_key = p_catalog_key
            and o.retired_release_id is null
            and o.duplicate_of is null
            and (private.catalog_registry_identity_visible(o.union_org_id)
              or private.organization_owns_fictional_registry(p_organization_id, o.union_org_id))) then
      allowed := false;
    elsif (select pg_catalog.count(*)
             from private.organization_claims as c
            where coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized
              and c.status in ('awaiting_email', 'under_review', 'held')) >= 20 then
      allowed := false;
    elsif exists (
         select 1 from private.organization_claims as c
          where c.claimant_email_scope = p_email_scope_hash
            and coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized
            and c.status in ('awaiting_email', 'under_review', 'held')) then
      allowed := false;
    elsif exists (
         select 1 from private.organization_claims as c
          where c.organization_id = p_organization_id
            and c.status in ('awaiting_email', 'under_review', 'held')) then
      allowed := false;
    elsif private.organization_is_verified(p_organization_id) then
      allowed := false;
    elsif exists (
         select 1 from private.public_interest_suppressions as suppression
          where suppression.suppression_scope_hash = private.public_interest_suppression_scope(clean_claimant_email)) then
      allowed := false;
    end if;
  end if;

  if allowed then
    insert into private.organization_claims (
      catalog_key, unlisted_name, unlisted_city, unlisted_state,
      organization_id, claimant_user_id,
      claimant_name, claimant_title, claimant_email, statement, claimant_email_scope,
      locale, attestation_version, attested_at, confirm_token_hash, confirm_expires_at, status
    ) values (
      p_catalog_key, clean_unlisted_name, clean_unlisted_city, clean_unlisted_state,
      p_organization_id, p_requesting_user_id,
      clean_claimant_name, clean_claimant_title, clean_claimant_email, clean_claimant_statement, p_email_scope_hash,
      p_locale, 'claim-attest/1', pg_catalog.now(), p_confirm_token_hash, pg_catalog.now() + interval '24 hours',
      'awaiting_email'
    )
    returning id into new_claim_id;

    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    ) values (
      'claim_submitted', 'organization_admin',
      p_requesting_user_id, 'claim', new_claim_id, p_organization_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'catalogKey', p_catalog_key, 'toStatus', 'awaiting_email')),
      extensions.gen_random_uuid()
    );

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      p_organization_id, 'administration', 'organization_catalog_verification_requested', 'create',
      p_requesting_user_id, 'organization', p_organization_id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', p_organization_id,
        'entityType', 'catalog_organization',
        'entityId', coalesce(p_catalog_key, 'unlisted'),
        'toStatus', 'awaiting_email'
      )
    );
  end if;

  with picked as materialized (
    select candidate.ctid as row_key
    from private.public_interest_submission_limits as candidate
    where candidate.window_started_at < moment - interval '2 days'
      and candidate.scope_hash not in (p_scope_hash, p_email_scope_hash)
    order by candidate.window_started_at
    limit 200
    for update skip locked
  )
  delete from private.public_interest_submission_limits as stale
  where stale.ctid in (select picked.row_key from picked);

  return pg_catalog.jsonb_build_object('accepted', true, 'deliver', allowed);
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_organization_catalog_placement(p_selected_hat text, p_expected_organization_id uuid, p_parent_catalog_key text, p_unlisted_parent_name text, p_unlisted_parent_state text, p_identity_unlisted boolean, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid;
  parent_key text;
  parent_name text;
  parent_state text;
  identity_only boolean;
  parent jsonb;
  prior_status text;
  prior_identity_unlisted boolean;
  prior_identity_key text;
  prior_parent_key text;
  prior_claim_id uuid;
  prior_verifier_kind text;
  withdraw boolean;
  replay record;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is distinct from 'admin'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- A replay is the same key, organization and operation: a key first spent
  -- on a clear is not a replay of a set.
  select l.organization_id, l.event_type, l.metadata ->> 'reasonCode' as reason_code into replay
    from public.organization_audit_ledger as l
   where l.idempotency_key = p_idempotency_key;
  if found then
    if replay.organization_id is distinct from org
       or replay.event_type is distinct from 'organization_catalog_placement_changed'
       or replay.reason_code is not distinct from 'cleared' then
      raise exception 'idempotency key reused' using errcode = '22023';
    end if;
    return private.organization_catalog_placement_state(org);
  end if;

  parent_key := nullif(pg_catalog.btrim(p_parent_catalog_key), '');
  parent_name := nullif(pg_catalog.btrim(p_unlisted_parent_name), '');
  parent_state := nullif(pg_catalog.btrim(p_unlisted_parent_state), '');
  identity_only := coalesce(p_identity_unlisted, false);

  if parent_key is not null and parent_name is not null then
    raise exception 'placement parent ambiguous' using errcode = '22023';
  end if;
  if parent_state is not null and parent_name is null then
    raise exception 'placement state needs name' using errcode = '22023';
  end if;
  select p.verification_status, p.identity_unlisted, p.identity_catalog_key
    into prior_status, prior_identity_unlisted, prior_identity_key
    from private.organization_catalog_placements as p
   where p.organization_id = org;
  -- A parent-union or sister vouch pins the parent: changing the parent key
  -- withdraws that verification (reason parent_changed). Domain and platform
  -- verifications do not rest on the parent and are kept.
  select p.parent_catalog_key, p.verified_claim_id, c.verifier_kind
    into prior_parent_key, prior_claim_id, prior_verifier_kind
    from private.organization_catalog_placements as p
    left join private.organization_claims as c on c.id = p.verified_claim_id
   where p.organization_id = org;
  withdraw := coalesce(prior_status = 'verified'
    and prior_verifier_kind in ('parent_organization', 'sibling_organization')
    and parent_key is distinct from prior_parent_key, false);
  if parent_key is null and parent_name is null and not identity_only
     and (prior_identity_key is null or withdraw) then
    raise exception 'placement empty' using errcode = '22023';
  end if;
  if parent_name is not null and (
       pg_catalog.char_length(parent_name) not between 3 and 200
       or parent_name ~ '[[:cntrl:]]'
       or parent_name !~ '[[:alnum:]]'
       or pg_catalog.strpos(parent_name, '@') > 0
       or pg_catalog.strpos(parent_name, '://') > 0
       or pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(parent_name,
           '(^|[^0-9./-]|[^0-9][./-])((19|20)[0-9]{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])|(0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])[-/.]((19|20)[0-9]{2}|[0-9]{2}))(?![-/.]?[0-9])', '\1|', 'g'),
           '(^|[^0-9[:space:]().+/_\u2010-\u2015\u2212\uFF0D-])([[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]*[0-9]{4,5})([[:space:]]+|[[:space:]]*\()(19|20)[0-9]{2}(?![[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]*[0-9])', '\1\2|', 'g'),
           '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}') then
    raise exception 'placement name invalid' using errcode = '22023';
  end if;
  if parent_state is not null and parent_state !~ '^[A-Z]{2}$' then
    raise exception 'placement state invalid' using errcode = '22023';
  end if;
  if parent_key is not null then
    if parent_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
      raise exception 'placement target unavailable' using errcode = '22023';
    end if;
    parent := private.organization_catalog_parent(parent_key);
    if not coalesce((parent ->> 'active')::boolean, false) then
      raise exception 'placement target unavailable' using errcode = '22023';
    end if;
  end if;

  if (select pg_catalog.count(*)
        from public.organization_audit_ledger as l
       where l.organization_id = org
         and l.event_type = 'organization_catalog_placement_changed'
         and l.occurred_at > pg_catalog.now() - interval '24 hours') >= 10 then
    raise exception 'placement change limit' using errcode = '22023';
  end if;

  if withdraw then
    perform private.organization_claim_withdraw(
      prior_claim_id, 'parent_changed', 'organization_admin', (select auth.uid()),
      extensions.gen_random_uuid(), null);
    select p.verification_status, p.identity_unlisted, p.identity_catalog_key
      into prior_status, prior_identity_unlisted, prior_identity_key
      from private.organization_catalog_placements as p
     where p.organization_id = org;
  end if;

  if prior_status = 'verified' and identity_only is distinct from prior_identity_unlisted then
    raise exception 'placement verified' using errcode = '22023';
  end if;

  -- An existing row is updated in place: an INSERT's proposed row is checked
  -- against the CHECKs before ON CONFLICT, so a verified identity-only row
  -- dropping its parent would fail organization_catalog_placements_something_placed.
  if prior_status is not null then
    update private.organization_catalog_placements
       set parent_catalog_key = parent_key,
           unlisted_parent_name = parent_name,
           unlisted_parent_state = parent_state,
           identity_unlisted = identity_only,
           updated_at = pg_catalog.now()
     where organization_id = org;
  else
    insert into private.organization_catalog_placements as p (
      organization_id, parent_catalog_key, unlisted_parent_name, unlisted_parent_state,
      identity_unlisted, verification_status, placed_at, updated_at
    ) values (
      org, parent_key, parent_name, parent_state, identity_only, 'self_reported',
      pg_catalog.now(), pg_catalog.now()
    )
    on conflict (organization_id) do update
      set parent_catalog_key = excluded.parent_catalog_key,
          unlisted_parent_name = excluded.unlisted_parent_name,
          unlisted_parent_state = excluded.unlisted_parent_state,
          identity_unlisted = excluded.identity_unlisted,
          updated_at = pg_catalog.now();
  end if;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'administration', 'organization_catalog_placement_changed', 'update',
    (select auth.uid()), 'organization', org::text, p_idempotency_key,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'entityType', case when parent_key is not null then 'catalog_organization' else 'unlisted' end,
      'entityId', parent_key,
      'fromStatus', coalesce(prior_status, 'unset'),
      'toStatus', coalesce(prior_status, 'self_reported'),
      'reasonCode', case when parent_key is not null or parent_name is not null then 'parent_set'
                         when identity_only then 'identity_unlisted'
                         else 'parent_cleared' end
    ))
  );

  return private.organization_catalog_placement_state(org);
end;
$function$;

notify pgrst, 'reload schema';

commit;
