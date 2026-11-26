-- UB-IDN-01 / UB-CON-07: in-product, chapter-scoped account invitations.
--
-- PostgreSQL decides who may invite and owns every lifecycle transition. The
-- serverless boundary supplies a random 256-bit secret to the recipient, but
-- only its SHA-256 digest crosses this boundary. Browser roles receive no
-- direct table privileges and the service role receives only the four narrow
-- functions needed after a recipient presents a valid secret.

create table public.member_invitations (
  id uuid primary key default extensions.gen_random_uuid(),
  normalized_email text not null
    check (
      normalized_email = pg_catalog.lower(pg_catalog.btrim(normalized_email))
      and pg_catalog.char_length(normalized_email) between 3 and 254
      and normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ),
  full_name text not null
    check (pg_catalog.char_length(full_name) between 2 and 120 and full_name !~ '[[:cntrl:]]'),
  first_name text not null
    check (pg_catalog.char_length(first_name) between 1 and 80 and first_name !~ '[[:cntrl:]]'),
  initials text not null check (pg_catalog.char_length(initials) between 1 and 4),
  chapter_id text not null references public.chapters(id) on delete restrict,
  initial_role text check (initial_role is null or initial_role in ('steward', 'coordinator', 'advisor')),
  locale text not null default 'en' check (locale in ('en', 'es')),
  token_hash text check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending'
    check (status in ('pending', 'accepting', 'accepted', 'revoked', 'superseded', 'delivery_failed', 'expired')),
  delivery_version integer not null default 1 check (delivery_version between 1 and 100),
  accept_attempts integer not null default 0 check (accept_attempts between 0 and 3),
  invited_by uuid references auth.users(id) on delete set null,
  auth_user_id uuid references auth.users(id) on delete set null,
  replaces_id uuid references public.member_invitations(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  expires_at timestamptz not null,
  accepting_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz,
  failure_code text check (failure_code is null or failure_code in
    ('provider_unavailable', 'auth_unavailable', 'finalize_failed', 'unsafe_auth_state')),
  constraint member_invitations_state_check check (
    (status = 'pending' and token_hash is not null and auth_user_id is null)
    or (status = 'accepting' and token_hash is not null and accepting_at is not null and auth_user_id is null)
    -- Auth-user deletion must not be blocked by this history row's ON DELETE
    -- SET NULL foreign key. accepted_at is the durable lifecycle fact.
    or (status = 'accepted' and token_hash is null and accepted_at is not null)
    or (status in ('revoked', 'superseded', 'delivery_failed', 'expired') and token_hash is null)
  )
);

create unique index member_invitations_one_live_email_idx
  on public.member_invitations (normalized_email)
  where status in ('pending', 'accepting');
create unique index member_invitations_token_hash_idx
  on public.member_invitations (token_hash)
  where token_hash is not null;
create index member_invitations_chapter_created_idx
  on public.member_invitations (chapter_id, created_at desc, id);
create index member_invitations_replaces_idx
  on public.member_invitations (replaces_id) where replaces_id is not null;
create index member_invitations_auth_user_idx
  on public.member_invitations (auth_user_id) where auth_user_id is not null;

create table public.member_invitation_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  invitation_id uuid not null references public.member_invitations(id) on delete restrict,
  chapter_id text not null references public.chapters(id) on delete restrict,
  actor uuid references auth.users(id) on delete set null,
  action text not null check (action in (
    'invite_requested', 'invite_sent', 'invite_delivery_failed',
    'invite_resent', 'invite_revoked', 'invite_claimed', 'invite_accepted',
    'invite_expired'
  )),
  detail jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(detail) = 'object' and pg_catalog.length(detail::text) <= 1000),
  created_at timestamptz not null default now()
);

create index member_invitation_audit_chapter_created_idx
  on public.member_invitation_audit (chapter_id, created_at desc, id);
create index member_invitation_audit_invitation_idx
  on public.member_invitation_audit (invitation_id, created_at, id);

alter table public.member_invitations enable row level security;
alter table public.member_invitation_audit enable row level security;
create policy mfa_assurance on public.member_invitations
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_invitation_audit
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
revoke all on public.member_invitations from public, anon, authenticated;
revoke all on public.member_invitation_audit from public, anon, authenticated;

-- Persisted counters make serverless scale-out irrelevant. The accept scope is
-- an HMAC digest made by the endpoint; no raw network address is stored.
create table private.member_invitation_admin_limits (
  scope_key text not null,
  operation text not null check (operation in ('create-hour', 'chapter-day', 'resend-hour', 'invitation-resend-hour')),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (scope_key, operation)
);

create table private.member_invitation_accept_limits (
  scope_hash text primary key check (scope_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0)
);

revoke all on private.member_invitation_admin_limits from public, anon, authenticated;
revoke all on private.member_invitation_accept_limits from public, anon, authenticated;

create function private.audit_member_invitation(
  p_invitation_id uuid,
  p_chapter_id text,
  p_actor uuid,
  p_action text,
  p_detail jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(pg_catalog.jsonb_typeof(p_detail), '') <> 'object' then
    raise exception 'invalid invitation audit detail' using errcode = '22023';
  end if;
  -- Defence in depth: even a future caller of this private helper cannot put
  -- identity secrets or provider material into the append-only trail.
  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_detail) as key_name
    where pg_catalog.lower(key_name) in (
      'email', 'normalizedemail', 'token', 'tokenhash', 'secret',
      'actionlink', 'providerbody'
    )
  ) then
    raise exception 'unsafe invitation audit detail' using errcode = '22023';
  end if;

  insert into public.member_invitation_audit
    (invitation_id, chapter_id, actor, action, detail)
  values (p_invitation_id, p_chapter_id, p_actor, p_action, p_detail);
end;
$$;

revoke all on function private.audit_member_invitation(uuid, text, uuid, text, jsonb)
  from public, anon, authenticated, service_role;

create function private.consume_member_invitation_admin_limit(
  p_scope_key text,
  p_operation text,
  p_limit integer,
  p_window interval
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row private.member_invitation_admin_limits%rowtype;
  moment timestamptz := clock_timestamp();
begin
  if p_scope_key is null or p_operation is null or p_limit < 1 or p_window <= interval '0 seconds' then
    raise exception 'invalid invitation rate limit' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-rate:' || p_scope_key || ':' || p_operation, 509)
  );
  select * into current_row
  from private.member_invitation_admin_limits
  where scope_key = p_scope_key and operation = p_operation
  for update;

  if not found then
    insert into private.member_invitation_admin_limits
      (scope_key, operation, window_started_at, request_count)
    values (p_scope_key, p_operation, moment, 1);
    return true;
  end if;
  if current_row.window_started_at + p_window <= moment then
    update private.member_invitation_admin_limits
    set window_started_at = moment, request_count = 1
    where scope_key = p_scope_key and operation = p_operation;
    return true;
  end if;
  if current_row.request_count >= p_limit then
    return false;
  end if;
  update private.member_invitation_admin_limits
  set request_count = request_count + 1
  where scope_key = p_scope_key and operation = p_operation;
  return true;
end;
$$;

revoke all on function private.consume_member_invitation_admin_limit(text, text, integer, interval)
  from public, anon, authenticated, service_role;

create function public.create_member_invitation(
  p_email text,
  p_full_name text,
  p_chapter_id text,
  p_initial_role text,
  p_locale text,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_name text := pg_catalog.btrim(coalesce(p_full_name, ''));
  clean_role text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_initial_role, ''))), '');
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  name_parts text[];
  clean_first text;
  clean_initials text;
  invitation_row public.member_invitations%rowtype;
  expired_row public.member_invitations%rowtype;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null or p_chapter_id is distinct from caller_chapter then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  -- Count before duplicate/existing-account branches. Those branches must not
  -- be a free unbounded address-probing endpoint.
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'create-hour', 10, interval '1 hour'
  ) or not private.consume_member_invitation_admin_limit(
    'chapter:' || caller_chapter, 'chapter-day', 50, interval '1 day'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es')
     or (clean_role is not null and clean_role not in ('steward', 'coordinator', 'advisor')) then
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
     expires_at)
  values
    (clean_email, clean_name, clean_first, clean_initials, caller_chapter,
     clean_role, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '15 minutes')
  returning * into invitation_row;

  perform private.audit_member_invitation(
    invitation_row.id, caller_chapter, caller, 'invite_requested',
    pg_catalog.jsonb_build_object('chapterId', caller_chapter,
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
$$;

revoke all on function public.create_member_invitation(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_member_invitation(text, text, text, text, text, text)
  to authenticated;

create function public.resend_member_invitation(p_invitation_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  old_row public.member_invitations%rowtype;
  new_row public.member_invitations%rowtype;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'resend-hour', 20, interval '1 hour'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  select * into old_row
  from public.member_invitations
  where id = p_invitation_id and chapter_id = caller_chapter
  for update;
  if not found or old_row.status not in ('pending', 'delivery_failed', 'expired') then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;
  if not private.consume_member_invitation_admin_limit(
    'invitation:' || old_row.id::text, 'invitation-resend-hour', 3, interval '1 hour'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  update public.member_invitations
  set status = 'superseded', token_hash = null, failure_code = null
  where id = old_row.id;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     replaces_id, expires_at)
  values
    (old_row.normalized_email, old_row.full_name, old_row.first_name,
     old_row.initials, old_row.chapter_id, old_row.initial_role, old_row.locale,
     clean_hash, 'pending', old_row.delivery_version + 1, caller, old_row.id,
     clock_timestamp() + interval '15 minutes')
  returning * into new_row;

  perform private.audit_member_invitation(
    new_row.id, new_row.chapter_id, caller, 'invite_resent',
    pg_catalog.jsonb_build_object('chapterId', new_row.chapter_id,
      'deliveryVersion', new_row.delivery_version,
      'replacesInvitationId', old_row.id)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', new_row.id,
    'deliveryVersion', new_row.delivery_version,
    'expiresAt', new_row.expires_at,
    'normalizedEmail', new_row.normalized_email,
    'fullName', new_row.full_name,
    'locale', new_row.locale
  );
end;
$$;

revoke all on function public.resend_member_invitation(uuid, text)
  from public, anon, authenticated;
grant execute on function public.resend_member_invitation(uuid, text)
  to authenticated;

create function public.revoke_member_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  invitation_row public.member_invitations%rowtype;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id and chapter_id = caller_chapter
  for update;
  if not found or invitation_row.status not in ('pending', 'delivery_failed', 'expired') then
    return pg_catalog.jsonb_build_object('accepted', true, 'revoked', false);
  end if;

  update public.member_invitations
  set status = 'revoked', token_hash = null, revoked_at = clock_timestamp(),
      failure_code = null
  where id = invitation_row.id;

  perform private.audit_member_invitation(
    invitation_row.id, invitation_row.chapter_id, caller, 'invite_revoked',
    pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
      'deliveryVersion', invitation_row.delivery_version)
  );
  return pg_catalog.jsonb_build_object('accepted', true, 'revoked', true);
end;
$$;

revoke all on function public.revoke_member_invitation(uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_member_invitation(uuid)
  to authenticated;

create function public.record_member_invitation_delivery(
  p_invitation_id uuid,
  p_delivery_version integer,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  invitation_row public.member_invitations%rowtype;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;
  if p_outcome not in ('sent', 'failed') then
    raise exception 'invalid delivery outcome' using errcode = '22023';
  end if;

  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id
    and chapter_id = caller_chapter
    and delivery_version = p_delivery_version
  for update;
  if not found or invitation_row.status <> 'pending' then
    return pg_catalog.jsonb_build_object('recorded', false);
  end if;

  if p_outcome = 'sent' then
    update public.member_invitations
    set sent_at = clock_timestamp()
    where id = invitation_row.id;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, caller, 'invite_sent',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version)
    );
  else
    update public.member_invitations
    set status = 'delivery_failed', token_hash = null,
        expires_at = clock_timestamp(), failure_code = 'provider_unavailable'
    where id = invitation_row.id;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, caller, 'invite_delivery_failed',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version,
        'failureClass', 'provider_unavailable')
    );
  end if;
  return pg_catalog.jsonb_build_object('recorded', true);
end;
$$;

revoke all on function public.record_member_invitation_delivery(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.record_member_invitation_delivery(uuid, integer, text)
  to authenticated;

create function public.get_member_invitations(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  cap integer := greatest(1, least(coalesce(p_limit, 50), 100));
  chapter_name text;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id, c.name into caller_chapter, chapter_name
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  where p.id = caller;
  if caller_chapter is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'chapter', pg_catalog.jsonb_build_object('id', caller_chapter, 'name', chapter_name),
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id,
        'normalizedEmail', s.normalized_email,
        'fullName', s.full_name,
        'chapterId', s.chapter_id,
        'initialRole', s.initial_role,
        'locale', s.locale,
        'status', case when s.status = 'pending' and s.expires_at <= clock_timestamp()
                  then 'expired' else s.status end,
        'deliveryVersion', s.delivery_version,
        'expiresAt', s.expires_at,
        'createdAt', s.created_at
      ) order by s.created_at desc, s.id)
      from (
        select i.*
        from public.member_invitations i
        where i.chapter_id = caller_chapter and i.status <> 'superseded'
        order by i.created_at desc, i.id
        limit cap
      ) s
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_member_invitations(integer)
  from public, anon, authenticated;
grant execute on function public.get_member_invitations(integer)
  to authenticated;

create function public.consume_member_invitation_accept_limit(p_scope_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row private.member_invitation_accept_limits%rowtype;
  moment timestamptz := clock_timestamp();
  cap constant integer := 20;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-accept-rate:' || p_scope_hash, 509)
  );
  select * into current_row
  from private.member_invitation_accept_limits
  where scope_hash = p_scope_hash
  for update;

  if not found then
    insert into private.member_invitation_accept_limits
      (scope_hash, window_started_at, request_count)
    values (p_scope_hash, moment, 1);
    return pg_catalog.jsonb_build_object('allowed', true, 'remaining', cap - 1);
  end if;
  if current_row.window_started_at + interval '15 minutes' <= moment then
    update private.member_invitation_accept_limits
    set window_started_at = moment, request_count = 1
    where scope_hash = p_scope_hash;
    return pg_catalog.jsonb_build_object('allowed', true, 'remaining', cap - 1);
  end if;
  if current_row.request_count >= cap then
    return pg_catalog.jsonb_build_object('allowed', false, 'remaining', 0);
  end if;
  update private.member_invitation_accept_limits
  set request_count = request_count + 1
  where scope_hash = p_scope_hash;
  return pg_catalog.jsonb_build_object(
    'allowed', true, 'remaining', cap - current_row.request_count - 1
  );
end;
$$;

revoke all on function public.consume_member_invitation_accept_limit(text)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_member_invitation_accept_limit(text)
  to service_role;

create function public.claim_member_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  invitation_row public.member_invitations%rowtype;
  recovery boolean := false;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('available', false);
  end if;

  select * into invitation_row
  from public.member_invitations
  where token_hash = clean_hash
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('available', false);
  end if;
  if invitation_row.status = 'pending'
     and invitation_row.expires_at <= clock_timestamp() then
    update public.member_invitations
    set status = 'expired', token_hash = null
    where id = invitation_row.id;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, null, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version)
    );
    return pg_catalog.jsonb_build_object('available', false);
  end if;
  if invitation_row.status = 'accepting' then
    if invitation_row.accepting_at + interval '2 minutes' > clock_timestamp()
       or invitation_row.accept_attempts >= 3 then
      return pg_catalog.jsonb_build_object('available', false);
    end if;
    recovery := true;
  elsif invitation_row.status <> 'pending' then
    return pg_catalog.jsonb_build_object('available', false);
  end if;

  update public.member_invitations
  set status = 'accepting', accepting_at = clock_timestamp(),
      accept_attempts = accept_attempts + 1
  where id = invitation_row.id
  returning * into invitation_row;

  if not recovery then
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, null, 'invite_claimed',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version)
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'available', true,
    'recovery', recovery,
    'invitationId', invitation_row.id,
    'normalizedEmail', invitation_row.normalized_email,
    'fullName', invitation_row.full_name,
    'firstName', invitation_row.first_name,
    'initials', invitation_row.initials,
    'chapterId', invitation_row.chapter_id,
    'initialRole', invitation_row.initial_role,
    'locale', invitation_row.locale
  );
end;
$$;

revoke all on function public.claim_member_invitation(text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_member_invitation(text)
  to service_role;

-- Recovery never mutates Auth. It identifies only an exact, server-labelled
-- un/finalized user so the endpoint can use GoTrue's supported admin DELETE
-- before retrying an expired acceptance lease. No email is returned.
create function public.get_member_invitation_recovery_user(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  invitation_row public.member_invitations%rowtype;
  user_row record;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id and status = 'accepting';
  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;
  select u.id, u.email_confirmed_at into user_row
  from auth.users u
  where u.raw_user_meta_data ->> 'union_base_invitation_id' = invitation_row.id::text
    and pg_catalog.lower(u.email) = invitation_row.normalized_email
  order by u.created_at desc
  limit 1;
  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'found', true,
    'userId', user_row.id,
    'confirmed', user_row.email_confirmed_at is not null
  );
end;
$$;

revoke all on function public.get_member_invitation_recovery_user(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_member_invitation_recovery_user(uuid)
  to service_role;

create function public.finalize_member_invitation(p_invitation_id uuid, p_auth_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation_row public.member_invitations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id and status = 'accepting'
  for update;
  if not found then
    raise exception 'invitation unavailable' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from auth.users u
    where u.id = p_auth_user_id
      and pg_catalog.lower(u.email) = invitation_row.normalized_email
      and u.raw_user_meta_data ->> 'union_base_invitation_id' = invitation_row.id::text
      and u.raw_user_meta_data ->> 'chapter_id' = invitation_row.chapter_id
  ) or not exists (
    select 1
    from public.member_profiles p
    where p.id = p_auth_user_id and p.chapter_id = invitation_row.chapter_id
  ) then
    raise exception 'invitation identity mismatch' using errcode = '22023';
  end if;

  if invitation_row.initial_role is not null then
    insert into public.member_roles
      (user_id, role, chapter_id, granted_by)
    values
      (p_auth_user_id, invitation_row.initial_role,
       invitation_row.chapter_id, invitation_row.invited_by)
    on conflict (user_id, role) do nothing;
  end if;

  update public.member_invitations
  set status = 'accepted', token_hash = null, auth_user_id = p_auth_user_id,
      accepted_at = clock_timestamp(), failure_code = null
  where id = invitation_row.id;

  perform private.audit_member_invitation(
    invitation_row.id, invitation_row.chapter_id, null, 'invite_accepted',
    pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
      'initialRole', invitation_row.initial_role,
      'deliveryVersion', invitation_row.delivery_version)
  );
  return pg_catalog.jsonb_build_object('accepted', true, 'userId', p_auth_user_id);
end;
$$;

revoke all on function public.finalize_member_invitation(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_member_invitation(uuid, uuid)
  to service_role;

create function public.fail_member_invitation_accept(p_invitation_id uuid, p_failure_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation_row public.member_invitations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_failure_code not in ('auth_unavailable', 'finalize_failed', 'unsafe_auth_state') then
    raise exception 'invalid failure class' using errcode = '22023';
  end if;
  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id and status = 'accepting'
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('recorded', false);
  end if;

  update public.member_invitations
  set status = 'delivery_failed', token_hash = null,
      failure_code = p_failure_code, expires_at = clock_timestamp()
  where id = invitation_row.id;
  perform private.audit_member_invitation(
    invitation_row.id, invitation_row.chapter_id, null, 'invite_delivery_failed',
    pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
      'deliveryVersion', invitation_row.delivery_version,
      'failureClass', p_failure_code)
  );
  return pg_catalog.jsonb_build_object('recorded', true);
end;
$$;

revoke all on function public.fail_member_invitation_accept(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.fail_member_invitation_accept(uuid, text)
  to service_role;

comment on table public.member_invitations is
  'Chapter-scoped invitation lifecycle. token_hash is a one-way digest; plaintext invitation secrets never enter PostgreSQL.';
comment on table public.member_invitation_audit is
  'Append-only invitation lifecycle events. Detail excludes email, token material, provider bodies and action links.';
comment on function public.create_member_invitation(text, text, text, text, text, text) is
  'Admin+MFA, same-chapter reservation. Member/no-role is the default; only least-privilege chapter staff roles may be preselected.';
comment on function public.claim_member_invitation(text) is
  'Service-only single-use claim. A row lock serializes acceptance against resend/revoke and a short lease permits safe endpoint recovery.';
