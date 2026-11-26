-- REQ-UG-PUBLIC-SIGNUP-INTAKE-CAP-20261016
-- No switch/evidence changes. This ledger has no foreign key: organization
-- deletion must never return an admission to the initial cohort.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.open_signup_cohort_admissions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null unique,
  admitted_at timestamptz not null default pg_catalog.clock_timestamp(),
  cohort text not null default 'public-launch-2026-10'
);
create index open_signup_cohort_admissions_time on private.open_signup_cohort_admissions (admitted_at);
create index open_signup_cohort_admissions_cohort on private.open_signup_cohort_admissions (cohort);
alter table private.open_signup_cohort_admissions enable row level security;
alter table private.open_signup_cohort_admissions force row level security;
revoke all on private.open_signup_cohort_admissions from public, anon, authenticated, service_role;
comment on table private.open_signup_cohort_admissions is
  'Permanent self-service organization admissions; no organization FK, no client grants. Only create_my_organization appends admissions.';

-- The confirmation transaction reserves capacity before its Auth row commits.
-- No FK: deleting an unfinished account cannot return its cohort place.
-- Lifetime reservations do not expire automatically; owner review is required
-- to release abandoned places. Daily holds age out after 24 hours, and an older
-- founder may need to wait for daily room before converting the held place.
create table private.open_signup_intake_reservations (
  user_id uuid primary key,
  reserved_at timestamptz not null default pg_catalog.clock_timestamp(),
  consumed_at timestamptz,
  cohort text not null default 'public-launch-2026-10'
);
alter table private.open_signup_intake_reservations enable row level security;
alter table private.open_signup_intake_reservations force row level security;
revoke all on private.open_signup_intake_reservations from public, anon, authenticated, service_role;
comment on table private.open_signup_intake_reservations is
  'Private founder places reserved atomically by the Auth insert and consumed by create_my_organization. No automatic lifetime release, no account FK or client grants.';

create function private.refuse_signup_admission_mutation()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  raise exception 'signup admissions are append-only' using errcode = '42501';
end;
$function$;
revoke all on function private.refuse_signup_admission_mutation() from public, anon, authenticated, service_role;
create trigger signup_admissions_append_only
before update or delete or truncate on private.open_signup_cohort_admissions
for each statement execute function private.refuse_signup_admission_mutation();

-- Signup has never opened. Refuse a rollout over pre-existing self-service
-- organizations rather than silently lose their historical admissions.
do $empty_cohort$
begin
  if exists (select 1 from public.organizations where self_serve_created_at is not null) then
    raise exception 'existing self-service organizations require owner-reviewed cohort reconciliation';
  end if;
end;
$empty_cohort$;

create or replace function public.create_my_organization(
  p_name text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
     or pg_catalog.regexp_replace(clean_name, '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}' then
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


create function public.open_signup_intake_status()
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  admitted_24h bigint;
  admitted_total bigint;
  reserved_24h bigint;
  reserved_total bigint;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select pg_catalog.count(*) filter (where a.admitted_at > pg_catalog.clock_timestamp() - interval '24 hours'),
    pg_catalog.count(*) filter (where a.cohort = 'public-launch-2026-10')
    into admitted_24h, admitted_total from private.open_signup_cohort_admissions a;
  select pg_catalog.count(*) filter (where r.reserved_at > pg_catalog.clock_timestamp() - interval '24 hours'),
    pg_catalog.count(*) filter (where r.cohort = 'public-launch-2026-10')
    into reserved_24h, reserved_total from private.open_signup_intake_reservations r where r.consumed_at is null;
  return pg_catalog.jsonb_build_object('admitted_24h', admitted_24h,
    'admitted_total', admitted_total, 'daily_cap', 5, 'cohort_cap', 25,
    'cohort', 'public-launch-2026-10',
    'open', admitted_24h + reserved_24h < 5 and admitted_total + reserved_total < 25 and private.open_signup_is_open());
end;
$function$;
revoke all on function public.open_signup_intake_status() from public, anon, authenticated, service_role;
grant execute on function public.open_signup_intake_status() to service_role;
comment on function public.open_signup_intake_status() is
  'Service-only counts and effective intake availability; includes owner and recovery gates, never identifiers or authority to open signup.';

-- The confirmation API checks capacity before calling Auth. Recheck inside the
-- account insert under the admission lock and reserves a place in the same
-- transaction. A refused confirmation cannot leave an Auth row or reservation.
-- Invitations (without the server-owned self_serve marker) remain unaffected.
create function private.guard_self_serve_account_intake()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if new.raw_app_meta_data ->> 'union_ground_signup' = 'self_serve' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('open-signup:platform', 509));
    if not private.open_signup_is_open()
       or (select pg_catalog.count(*) from private.open_signup_cohort_admissions a
           where a.admitted_at > pg_catalog.clock_timestamp() - interval '24 hours')
          + (select pg_catalog.count(*) from private.open_signup_intake_reservations r
             where r.consumed_at is null and r.reserved_at > pg_catalog.clock_timestamp() - interval '24 hours') >= 5
       or (select pg_catalog.count(*) from private.open_signup_cohort_admissions a
           where a.cohort = 'public-launch-2026-10')
          + (select pg_catalog.count(*) from private.open_signup_intake_reservations r
             where r.consumed_at is null and r.cohort = 'public-launch-2026-10') >= 25 then
      raise exception 'signup unavailable' using errcode = '55000';
    end if;
    insert into private.open_signup_intake_reservations(user_id) values(new.id);
  end if;
  return new;
end;
$function$;
revoke all on function private.guard_self_serve_account_intake() from public, anon, authenticated, service_role;
create trigger guard_self_serve_account_intake
before insert on auth.users for each row execute function private.guard_self_serve_account_intake();

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.object_name in ('guard_self_serve_account_intake', 'signup_admissions_append_only'))
   or (s.kind = 'function' and s.schema_name = 'private'
       and pg_catalog.split_part(s.object_name, '(', 1) in ('guard_self_serve_account_intake',
         'refuse_signup_admission_mutation', 'open_signup_is_open',
         'open_signup_recovery_ready', 'open_signup_launch_evidence_ready',
         'open_signup_coverage_active'))
   -- The conservative name-based graph also reaches the public wrapper.
   or (s.kind = 'function' and s.schema_name = 'public'
       and s.object_name in ('open_signup_recovery_ready()', 'open_signup_coverage_active()'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;
do $review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review incomplete after signup intake caps';
  end if;
end;
$review$;
notify pgrst, 'reload schema';
commit;
