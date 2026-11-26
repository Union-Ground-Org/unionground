-- MI1 X-DB organization-scope foundation.
-- Reserved filename: 20260822010000_mi1_organization_scope_foundation.sql
-- Created with `npx supabase migration new mi1_organization_scope_foundation` (CLI 2.109.1)
-- and renamed to the reserved 14-digit prefix. No duplicate prefix exists.
--
-- Product: there is no default organization and none is seeded. Zero
-- organizations is the valid launch state. Existing organization-less
-- chapters and broadcasts are quarantined transitional legacy data: preserved,
-- not backfilled, excluded from new organization-scoped APIs, and blocked
-- from new ownerless writes. Operator disposition is later and explicit.
--
-- Donor SHA donor-baseline-20260721 is behavior-only. This
-- file does not replay, cherry-pick, or copy donor migrations.
--
-- Supabase guidance (CLI 2.109.1, checked 2026-08-21): RLS on every public
-- table; grants and RLS are separate; policies TO roles plus predicates;
-- UPDATE policies set USING and WITH CHECK; SECURITY DEFINER is exceptional,
-- pins search_path to empty, fully qualifies relations, revokes EXECUTE from
-- PUBLIC, and grants only exact roles. This migration does not touch realtime
-- schema or extension pinning.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Tenant primitives
-- ---------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default extensions.gen_random_uuid(),
  slug text not null,
  name text not null,
  status text not null default 'active'
    check (status in ('active', 'suspended', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organizations_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  constraint organizations_name_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(name)) between 2 and 120
    and name !~ '[[:cntrl:]]'
  )
);

create unique index organizations_slug_key on public.organizations (slug);
create unique index organizations_name_key on public.organizations (pg_catalog.lower(name));

comment on table public.organizations is
  'Customer tenant. Empty after reset. No default/seeded organization exists.';

create table public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default pg_catalog.now(),
  revoked_at timestamptz,
  primary key (organization_id, user_id),
  constraint organization_memberships_revocation_complete check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create index organization_memberships_user_idx
  on public.organization_memberships (user_id, status);

comment on table public.organization_memberships is
  'Explicit organization membership. Active membership is required for every organization-backed authorization path.';

create table public.organization_role_grants (
  organization_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')),
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, user_id, role),
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id)
    on delete cascade
);

comment on table public.organization_role_grants is
  'Explicit organization-wide hats. These replace member_roles.chapter_id IS NULL as tenant-wide authority.';

create table public.organization_audit_events (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  event_type text not null check (event_type in (
    'first_organization_bootstrap',
    'organization_membership_granted',
    'organization_membership_revoked',
    'organization_role_granted',
    'organization_role_revoked',
    'staff_mfa_policy_changed'
  )),
  actor_user_id uuid references auth.users(id) on delete set null,
  idempotency_key uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  constraint organization_audit_events_idempotency_key unique (idempotency_key),
  constraint organization_audit_events_metadata_object check (pg_catalog.jsonb_typeof(metadata) = 'object'),
  constraint organization_audit_events_metadata_bounded check (
    pg_catalog.octet_length(metadata::text) <= 2048
  ),
  constraint organization_audit_events_metadata_keys check (
    metadata - array[
      'organizationId', 'chapterId', 'slug', 'name', 'role', 'userId',
      'status', 'requireStaffMfa'
    ] = '{}'::jsonb
  )
);

comment on table public.organization_audit_events is
  'Append-only tenant audit. Bounded allowlisted metadata only; never row images or protected member content.';

-- Expand the historical global singleton into an organization-keyed policy
-- store without rewriting or deleting the existing row. The NULL-organization
-- row is a quarantined compatibility setting for legacy orphan sessions only;
-- every organization gets an independent, fail-closed row.
alter table public.org_security_policy
  add column policy_id uuid default extensions.gen_random_uuid(),
  add column organization_id uuid
    references public.organizations(id) on update cascade on delete restrict;
alter table public.org_security_policy
  alter column policy_id set not null,
  drop constraint org_security_policy_pkey,
  add constraint org_security_policy_pkey primary key (policy_id);
create unique index org_security_policy_organization_key
  on public.org_security_policy (organization_id)
  where organization_id is not null;
create unique index org_security_policy_legacy_singleton_key
  on public.org_security_policy (id)
  where organization_id is null;

comment on column public.org_security_policy.organization_id is
  'Tenant policy key. NULL is the quarantined pre-MI1 singleton and never applies to an organization-backed session.';

-- Historical admin-audit rows predate tenant ownership. Keep them as
-- quarantined NULL-organization evidence, then stamp every new row from the
-- actor's active selected organization so an organization admin never gains a
-- global audit reader merely by satisfying the redefined admin predicate.
alter table public.member_admin_audit
  add column organization_id uuid
    references public.organizations(id) on update cascade on delete restrict;
create index member_admin_audit_organization_created_idx
  on public.member_admin_audit (organization_id, created_at desc, id desc)
  where organization_id is not null;

comment on column public.member_admin_audit.organization_id is
  'Owning tenant derived from the actor at insert time. NULL is quarantined pre-MI1/orphan audit evidence.';

alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.organization_role_grants enable row level security;
alter table public.organization_audit_events enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Chapters: nullable organization_id for quarantined legacy rows
-- ---------------------------------------------------------------------------

alter table public.chapters
  add column organization_id uuid references public.organizations(id) on update cascade on delete restrict,
  add column slug text;

update public.chapters set slug = id where slug is null;
alter table public.chapters alter column slug set not null;
alter table public.chapters
  add constraint chapters_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$');

alter table public.chapters drop constraint if exists chapters_name_key;
drop index if exists public.chapters_one_default_idx;

create unique index chapters_organization_name_idx
  on public.chapters (organization_id, pg_catalog.lower(name))
  where organization_id is not null;
create unique index chapters_organization_slug_idx
  on public.chapters (organization_id, slug)
  where organization_id is not null;
create unique index chapters_organization_default_idx
  on public.chapters (organization_id)
  where is_default and organization_id is not null;

create unique index chapters_orphan_name_idx
  on public.chapters (pg_catalog.lower(name))
  where organization_id is null;
create unique index chapters_orphan_slug_idx
  on public.chapters (slug)
  where organization_id is null;
create unique index chapters_orphan_default_idx
  on public.chapters (is_default)
  where is_default and organization_id is null;

comment on column public.chapters.organization_id is
  'Owning tenant. NULL only for quarantined pre-MI1 legacy chapters; those rows must not be backfilled by application writes.';
comment on column public.chapters.slug is
  'Normalized per-organization slug. Opaque chapters.id remains the globally unique identifier.';

-- ---------------------------------------------------------------------------
-- 3. Broadcasts: organization ownership and explicit audience
-- ---------------------------------------------------------------------------

alter table public.member_broadcasts
  add column organization_id uuid references public.organizations(id) on update cascade on delete restrict,
  add column chapter_id text references public.chapters(id) on update cascade on delete restrict,
  add column audience_scope text;

alter table public.member_broadcasts
  add constraint member_broadcasts_audience_complete check (
    (
      organization_id is null
      and chapter_id is null
      and audience_scope is null
    )
    or (
      organization_id is not null
      and chapter_id is not null
      and audience_scope in ('chapter', 'organization')
    )
  );

create index member_broadcasts_organization_published_idx
  on public.member_broadcasts (organization_id, published_at desc)
  where organization_id is not null;

comment on column public.member_broadcasts.organization_id is
  'Owning tenant derived server-side. NULL marks quarantined pre-MI1 broadcasts that new APIs must not expose.';
comment on column public.member_broadcasts.audience_scope is
  'chapter = same-chapter members in that organization; organization = same organization only. Never global.';

-- ---------------------------------------------------------------------------
-- 4. Helper functions
-- ---------------------------------------------------------------------------

create function private.current_member_organization()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select c.organization_id
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  join public.organizations o
    on o.id = c.organization_id
   and o.status = 'active'
  join public.member_chapter_memberships cm
    on cm.user_id = p.id
   and cm.chapter_id = c.id
   and cm.status = 'active'
  join public.organization_memberships om
    on om.organization_id = c.organization_id
   and om.user_id = p.id
   and om.status = 'active'
  where p.id = (select auth.uid())
    and c.organization_id is not null
$function$;

create function private.staff_mfa_required(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when p_organization_id is null then true
    else coalesce((
      select p.require_staff_mfa
      from public.org_security_policy p
      where p.organization_id = p_organization_id
    ), true)
  end;
$function$;

create or replace function private.staff_mfa_required()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when private.current_member_organization() is not null
      then private.staff_mfa_required(private.current_member_organization())
    else coalesce((
      select p.require_staff_mfa
      from public.org_security_policy p
      where p.organization_id is null and p.id
    ), true)
  end;
$function$;

create function private.is_organization_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null or p_organization_id is null then false
    when not (select private.mfa_satisfied()) then false
    when p_organization_id is distinct from (select private.current_member_organization()) then false
    else exists (
      select 1
      from public.organization_memberships m
      where m.organization_id = p_organization_id
        and m.user_id = (select auth.uid())
        and m.status = 'active'
    )
  end;
$function$;

create function private.has_organization_role(p_organization_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null or p_organization_id is null then false
    when not (select private.mfa_satisfied()) then false
    when p_organization_id is distinct from (select private.current_member_organization()) then false
    when not exists (
      select 1
      from public.organization_memberships m
      where m.organization_id = p_organization_id
        and m.user_id = (select auth.uid())
        and m.status = 'active'
    ) then false
    when not exists (
      select 1
      from public.organization_role_grants g
      where g.organization_id = p_organization_id
        and g.user_id = (select auth.uid())
        and g.role = any(p_roles)
    ) then false
    when not (select private.staff_mfa_required(p_organization_id)) then true
    else (select private.has_second_factor((select auth.uid())))
  end;
$function$;

create function private.can_read_member_broadcast(p_broadcast_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null or p_broadcast_id is null then false
    when not (select private.mfa_satisfied()) then false
    else exists (
      select 1
      from public.member_broadcasts b
      where b.id = p_broadcast_id
        and b.organization_id is not null
        and b.organization_id = (select private.current_member_organization())
        and (select private.is_organization_member(b.organization_id))
        and (
          b.audience_scope = 'organization'
          or (
            b.audience_scope = 'chapter'
            and exists (
              select 1
              from public.member_chapter_memberships m
              where m.user_id = (select auth.uid())
                and m.chapter_id = b.chapter_id
                and m.status = 'active'
            )
          )
        )
    )
  end;
$function$;

create function private.assign_member_admin_audit_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  selected_org uuid;
  active_org uuid;
begin
  if new.actor is null then
    if new.organization_id is not null then
      raise exception 'audit organization requires an actor' using errcode = '42501';
    end if;
    return new;
  end if;

  select c.organization_id into selected_org
  from public.member_profiles p
  left join public.chapters c on c.id = p.chapter_id
  where p.id = new.actor;

  if selected_org is null then
    if new.organization_id is not null then
      raise exception 'orphan audit rows cannot name an organization' using errcode = '42501';
    end if;
    new.organization_id := null;
    return new;
  end if;

  select c.organization_id into active_org
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  join public.organizations o
    on o.id = c.organization_id
   and o.status = 'active'
  join public.member_chapter_memberships cm
    on cm.user_id = p.id and cm.chapter_id = c.id and cm.status = 'active'
  join public.organization_memberships om
    on om.user_id = p.id
   and om.organization_id = c.organization_id
   and om.status = 'active'
  where p.id = new.actor
    and c.organization_id = selected_org;

  if active_org is null then
    raise exception 'active audit organization required' using errcode = '42501';
  end if;
  if new.organization_id is not null
     and new.organization_id is distinct from active_org then
    raise exception 'audit organization is derived from actor' using errcode = '42501';
  end if;

  new.organization_id := active_org;
  return new;
end;
$function$;

create function private.enforce_organization_role_grant_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from public.organization_memberships m
    join public.organizations o
      on o.id = m.organization_id
     and o.status = 'active'
    where m.organization_id = new.organization_id
      and m.user_id = new.user_id
      and m.status = 'active'
  ) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create function private.revoke_organization_role_grants_on_membership_revoke()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status = 'revoked' and old.status is distinct from 'revoked' then
    delete from public.organization_role_grants g
    where g.organization_id = new.organization_id
      and g.user_id = new.user_id;
  end if;
  return new;
end;
$function$;

create function private.forbid_organization_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception 'organization audit events are append-only' using errcode = '55000';
end;
$function$;

create function private.forbid_ownerless_chapter_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' and new.organization_id is null then
    raise exception 'ownerless chapter writes are prohibited' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if old.organization_id is not null
       and new.organization_id is distinct from old.organization_id then
      raise exception 'chapter organization is immutable' using errcode = '42501';
    end if;
    if old.organization_id is null and new.organization_id is not null then
      raise exception 'legacy chapter reassignment is operator disposition' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

create function private.forbid_ownerless_broadcast_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' and new.organization_id is null then
    raise exception 'ownerless broadcast writes are prohibited' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if old.organization_id is not null
       and new.organization_id is distinct from old.organization_id then
      raise exception 'broadcast organization is immutable' using errcode = '42501';
    end if;
    if old.organization_id is null and new.organization_id is not null then
      raise exception 'legacy broadcast reassignment is operator disposition' using errcode = '42501';
    end if;
    if new.chapter_id is not null and new.organization_id is not null
       and not exists (
         select 1
         from public.chapters c
         where c.id = new.chapter_id
           and c.organization_id is not distinct from new.organization_id
       ) then
      raise exception 'broadcast chapter is outside organization' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT'
     and new.chapter_id is not null
     and new.organization_id is not null
     and not exists (
       select 1
       from public.chapters c
       where c.id = new.chapter_id
         and c.organization_id is not distinct from new.organization_id
     ) then
    raise exception 'broadcast chapter is outside organization' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create function private.forbid_new_ownerless_member_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.chapter_id is null then
    if new.role in ('admin', 'vp')
       and coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
       and exists (
         select 1
         from auth.users u
         where u.id = new.user_id
           and coalesce(u.raw_app_meta_data, '{}'::jsonb)
             @> '{"sample":true,"surface":"sample"}'::jsonb
       ) then
      return new;
    end if;
    raise exception 'organization-wide hats must use organization_role_grants' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create trigger organization_role_grants_require_active_membership
  before insert or update of organization_id, user_id, role
  on public.organization_role_grants
  for each row execute function private.enforce_organization_role_grant_membership();

create trigger organization_memberships_revoke_grants
  after update on public.organization_memberships
  for each row execute function private.revoke_organization_role_grants_on_membership_revoke();

create trigger organization_audit_events_append_only
  before update or delete on public.organization_audit_events
  for each row execute function private.forbid_organization_audit_mutation();

create trigger chapters_forbid_ownerless_write
  before insert or update on public.chapters
  for each row execute function private.forbid_ownerless_chapter_write();

create trigger member_broadcasts_forbid_ownerless_write
  before insert or update on public.member_broadcasts
  for each row execute function private.forbid_ownerless_broadcast_write();

create trigger member_roles_forbid_new_ownerless
  before insert or update on public.member_roles
  for each row execute function private.forbid_new_ownerless_member_roles();

create trigger member_admin_audit_assign_organization
  before insert on public.member_admin_audit
  for each row execute function private.assign_member_admin_audit_organization();

revoke all on function private.current_member_organization() from public, anon;
grant execute on function private.current_member_organization() to authenticated;

revoke all on function private.staff_mfa_required(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.staff_mfa_required()
  from public, anon, authenticated, service_role;

revoke all on function private.is_organization_member(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.is_organization_member(uuid) to authenticated;

revoke all on function private.has_organization_role(uuid, text[])
  from public, anon, authenticated, service_role;
grant execute on function private.has_organization_role(uuid, text[]) to authenticated;

revoke all on function private.can_read_member_broadcast(text)
  from public, anon, authenticated, service_role;
grant execute on function private.can_read_member_broadcast(text) to authenticated;

revoke all on function private.assign_member_admin_audit_organization()
  from public, anon, authenticated, service_role;

revoke all on function private.enforce_organization_role_grant_membership()
  from public, anon, authenticated, service_role;
revoke all on function private.revoke_organization_role_grants_on_membership_revoke()
  from public, anon, authenticated, service_role;
revoke all on function private.forbid_organization_audit_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.forbid_ownerless_chapter_write()
  from public, anon, authenticated, service_role;
revoke all on function private.forbid_ownerless_broadcast_write()
  from public, anon, authenticated, service_role;
revoke all on function private.forbid_new_ownerless_member_roles()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Authorization helper rewrite
-- ---------------------------------------------------------------------------

create or replace function public.member_has_role(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null then false
    when not (select private.mfa_satisfied()) then false
    when not exists (
      select 1
      from public.member_profiles p
      join public.chapters selected on selected.id = p.chapter_id
      join public.organizations selected_org
        on selected_org.id = selected.organization_id
       and selected_org.status = 'active'
      join public.member_chapter_memberships cm
        on cm.user_id = p.id
       and cm.chapter_id = selected.id
       and cm.status = 'active'
      join public.organization_memberships om
        on om.user_id = p.id
       and om.organization_id = selected.organization_id
       and om.status = 'active'
      where p.id = (select auth.uid())
        and selected.organization_id is not null
        and exists (
          select 1
          from public.member_role_chapters rc
          where rc.user_id = p.id
            and rc.chapter_id = selected.id
            and rc.role = any(p_roles)
        )
    ) and not exists (
      select 1
      from public.member_profiles p
      left join public.chapters selected on selected.id = p.chapter_id
      join public.member_roles r
        on r.user_id = p.id
       and r.role = any(p_roles)
      where p.id = (select auth.uid())
        and (select private.current_member_organization()) is null
        and (selected.id is null or selected.organization_id is null)
        and (
          r.chapter_id is null
          or exists (
            select 1
            from public.member_role_chapters rc
            join public.member_chapter_memberships m
              on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
            join public.chapters mapped on mapped.id = rc.chapter_id
            where rc.user_id = r.user_id
              and rc.role = r.role
              and mapped.organization_id is null
              and m.status = 'active'
              and rc.chapter_id = p.chapter_id
          )
        )
    ) then false
    when not (select private.staff_mfa_required()) then true
    else (select private.has_second_factor((select auth.uid())))
  end;
$function$;

create or replace function public.staff_can_see_user(p_target uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null or p_target is null or p_role is null then false
    when not (select private.mfa_satisfied()) then false
    else exists (
      select 1
      from public.member_profiles target
      join public.chapters target_chapter on target_chapter.id = target.chapter_id
      where target.id = p_target
        and (
          (
            target_chapter.organization_id is not null
            and target_chapter.organization_id = (select private.current_member_organization())
            and (
              private.has_organization_role(target_chapter.organization_id, array[p_role])
              or private.member_has_chapter_role(target_chapter.id, array[p_role])
            )
          )
          or (
            target_chapter.organization_id is null
            and (select private.current_member_organization()) is null
            and exists (
              select 1
              from public.member_profiles caller_profile
              left join public.chapters caller_chapter
                on caller_chapter.id = caller_profile.chapter_id
              where caller_profile.id = (select auth.uid())
                and (caller_chapter.id is null or caller_chapter.organization_id is null)
            )
            and (
              not (select private.staff_mfa_required())
              or (select private.has_second_factor((select auth.uid())))
            )
            and exists (
              select 1
              from public.member_roles r
              where r.user_id = (select auth.uid())
                and r.role = p_role
                and (
                  r.chapter_id is null
                  or exists (
                    select 1
                    from public.member_role_chapters rc
                    join public.member_chapter_memberships m
                      on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
                    join public.chapters mapped on mapped.id = rc.chapter_id
                    where rc.user_id = r.user_id
                      and rc.role = r.role
                      and rc.chapter_id = target.chapter_id
                      and mapped.organization_id is null
                      and m.status = 'active'
                  )
                )
            )
          )
        )
    )
  end;
$function$;

create or replace function private.member_has_chapter_role(
  p_chapter_id text,
  p_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    and (select private.mfa_satisfied())
    and exists (
    select 1
    from public.chapters c
    where c.id = p_chapter_id
      and (
        (
          c.organization_id is not null
          and c.organization_id = (select private.current_member_organization())
          and exists (
            select 1
            from public.organization_memberships om
            where om.user_id = (select auth.uid())
              and om.organization_id = c.organization_id
              and om.status = 'active'
          )
          and exists (
            select 1
            from public.member_chapter_memberships m
            where m.user_id = (select auth.uid())
              and m.chapter_id = c.id
              and m.status = 'active'
          )
          and (
            not private.staff_mfa_required(c.organization_id)
            or private.has_second_factor((select auth.uid()))
          )
          and (
            private.has_organization_role(c.organization_id, p_roles)
            or exists (
              select 1
              from public.member_role_chapters rc
              join public.member_chapter_memberships m
                on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
              where rc.user_id = (select auth.uid())
                and rc.role = any(p_roles)
                and rc.chapter_id = c.id
                and m.status = 'active'
            )
          )
        )
        or (
          c.organization_id is null
          and (select private.current_member_organization()) is null
          and public.member_has_role(p_roles)
          and exists (
            select 1
            from public.member_roles r
            where r.user_id = (select auth.uid())
              and r.role = any(p_roles)
              and (
                r.chapter_id is null
                or exists (
                  select 1
                  from public.member_role_chapters rc
                  join public.member_chapter_memberships m
                    on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
                  where rc.user_id = r.user_id
                    and rc.role = r.role
                    and rc.chapter_id = p_chapter_id
                    and m.status = 'active'
                )
              )
          )
        )
      )
  );
$function$;

-- The public staff-MFA API keeps its established signatures. Tenant identity
-- is always derived from the caller's active selected organization; there is
-- no caller-supplied organization argument to tamper with.
create or replace function public.get_staff_mfa_policy()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  policy_org uuid := private.current_member_organization();
  staff_total integer;
  staff_enrolled integer;
begin
  if caller is null
     or policy_org is null
     or not private.mfa_satisfied()
     or not private.has_organization_role(policy_org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  select pg_catalog.count(*)::integer,
         pg_catalog.count(*) filter (
           where private.has_second_factor(scoped_staff.user_id)
         )::integer
    into staff_total, staff_enrolled
  from (
    select g.user_id
    from public.organization_role_grants g
    join public.organization_memberships om
      on om.organization_id = g.organization_id
     and om.user_id = g.user_id
     and om.status = 'active'
    where g.organization_id = policy_org
    union
    select rc.user_id
    from public.member_role_chapters rc
    join public.chapters c
      on c.id = rc.chapter_id
     and c.organization_id = policy_org
    join public.member_chapter_memberships cm
      on cm.user_id = rc.user_id
     and cm.chapter_id = rc.chapter_id
     and cm.status = 'active'
    join public.organization_memberships om
      on om.organization_id = c.organization_id
     and om.user_id = rc.user_id
     and om.status = 'active'
  ) scoped_staff;

  return pg_catalog.jsonb_build_object(
    'requireStaffMfa', private.staff_mfa_required(policy_org),
    'staffTotal', coalesce(staff_total, 0),
    'staffEnrolled', coalesce(staff_enrolled, 0),
    'callerEnrolled', private.has_second_factor(caller),
    'updatedAt', (
      select p.updated_at
      from public.org_security_policy p
      where p.organization_id = policy_org
    )
  );
end;
$function$;

create or replace function public.set_staff_mfa_policy(p_required boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  policy_org uuid := private.current_member_organization();
  current_value boolean;
begin
  if p_required is null then
    raise exception 'required flag missing' using errcode = '22023';
  end if;
  if caller is null
     or policy_org is null
     or not private.mfa_satisfied()
     or not private.has_organization_role(policy_org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  insert into public.org_security_policy (
    id, organization_id, require_staff_mfa
  ) values (
    true, policy_org, true
  )
  on conflict (organization_id) where organization_id is not null do nothing;

  select p.require_staff_mfa
    into current_value
    from public.org_security_policy p
   where p.organization_id = policy_org
   for update;

  if caller is null
     or policy_org is distinct from private.current_member_organization()
     or not private.mfa_satisfied()
     or not private.has_organization_role(policy_org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_required and not private.has_second_factor(caller) then
    raise exception 'turn on your own two-step sign-in before requiring it of staff'
      using errcode = '42501';
  end if;

  if current_value is distinct from p_required then
    update public.org_security_policy
       set require_staff_mfa = p_required,
           updated_at = pg_catalog.now(),
           updated_by = caller
     where organization_id = policy_org;

    insert into public.organization_audit_events (
      organization_id, event_type, actor_user_id, idempotency_key, metadata
    ) values (
      policy_org,
      'staff_mfa_policy_changed',
      caller,
      extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', policy_org::text,
        'requireStaffMfa', p_required
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'requireStaffMfa', p_required,
    'changed', current_value is distinct from p_required
  );
end;
$function$;

create or replace function public.get_staff_mfa_standing()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  policy_org uuid := private.current_member_organization();
  holds_role boolean;
  enrolled boolean;
  required boolean;
begin
  if caller is null then
    raise exception 'sign in required' using errcode = '42501';
  end if;

  required := case
    when policy_org is null then private.staff_mfa_required()
    else private.staff_mfa_required(policy_org)
  end;
  enrolled := private.has_second_factor(caller);

  if policy_org is not null then
    holds_role := exists (
      select 1
      from public.organization_memberships om
      where om.organization_id = policy_org
        and om.user_id = caller
        and om.status = 'active'
        and (
          exists (
            select 1 from public.organization_role_grants g
            where g.organization_id = policy_org and g.user_id = caller
          )
          or exists (
            select 1
            from public.member_role_chapters rc
            join public.chapters c
              on c.id = rc.chapter_id and c.organization_id = policy_org
            join public.member_chapter_memberships cm
              on cm.user_id = rc.user_id
             and cm.chapter_id = rc.chapter_id
             and cm.status = 'active'
            where rc.user_id = caller
          )
        )
    );
  else
    holds_role := exists (
      select 1
      from public.member_roles r
      join public.member_profiles p on p.id = r.user_id
      left join public.chapters c on c.id = p.chapter_id
      where r.user_id = caller
        and (c.id is null or c.organization_id is null)
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'requireStaffMfa', required,
    'holdsStaffRole', holds_role,
    'enrolled', enrolled,
    'assured', private.mfa_satisfied(),
    'blocked', required and holds_role and not enrolled
  );
end;
$function$;

-- Background dispatch authorizes the stored actor, not auth.uid(). Resolve
-- MFA policy from the target's tenant and require active memberships and an
-- exact tenant/chapter role. This prevents cron/service sessions from falling
-- through the legacy global policy wrapper.
create or replace function public.get_admin_audit(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  audit_org uuid := private.current_member_organization();
  cap integer := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  if caller is null
     or audit_org is null
     or not private.member_has_chapter_role(private.current_member_chapter(), array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s.id,
      'action', s.action,
      'actorName', s.actor_name,
      'targetName', s.target_name,
      'targetId', s.target_user,
      'detail', s.detail,
      'createdAt', s.created_at) order by s.created_at desc, s.id)
    from (
      select m.id, m.action, m.target_user, m.detail, m.created_at,
             coalesce(a.full_name, 'System') as actor_name,
             case when m.target_user is null then null
                  else coalesce(t.full_name, 'Removed member') end as target_name
      from public.member_admin_audit m
      left join public.member_profiles a on a.id = m.actor
      left join public.member_profiles t on t.id = m.target_user
      where m.organization_id is not null
        and m.organization_id = audit_org
      order by m.created_at desc, m.id
      limit cap
    ) s
  ), '[]'::jsonb);
end;
$function$;

alter policy member_admin_audit_select_admin on public.member_admin_audit
  using (
    private.member_has_chapter_role(private.current_member_chapter(), array['admin'])
    and organization_id is not null
    and organization_id = private.current_member_organization()
  );

create or replace function private.staff_actor_can_see_user(
  p_actor uuid,
  p_target uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.member_profiles target
    join public.chapters target_chapter on target_chapter.id = target.chapter_id
    where target.id = p_target
      and (
        (
          target_chapter.organization_id is not null
          and exists (
            select 1
            from public.member_profiles actor_profile
            join public.chapters actor_chapter
              on actor_chapter.id = actor_profile.chapter_id
             and actor_chapter.organization_id = target_chapter.organization_id
            join public.member_chapter_memberships actor_membership
              on actor_membership.user_id = actor_profile.id
             and actor_membership.chapter_id = actor_chapter.id
             and actor_membership.status = 'active'
            where actor_profile.id = p_actor
          )
          and exists (
            select 1
            from public.organizations o
            where o.id = target_chapter.organization_id
              and o.status = 'active'
          )
          and exists (
            select 1
            from public.organization_memberships om
            where om.organization_id = target_chapter.organization_id
              and om.user_id = p_actor
              and om.status = 'active'
          )
          and (
            exists (
              select 1 from public.organization_role_grants g
              where g.organization_id = target_chapter.organization_id
                and g.user_id = p_actor
                and g.role = 'steward'
            )
            or exists (
              select 1
              from public.member_role_chapters rc
              join public.member_chapter_memberships cm
                on cm.user_id = rc.user_id
               and cm.chapter_id = rc.chapter_id
               and cm.status = 'active'
              where rc.user_id = p_actor
                and rc.chapter_id = target_chapter.id
                and rc.role = 'steward'
            )
          )
          and (
            not private.staff_mfa_required(target_chapter.organization_id)
            or private.has_second_factor(p_actor)
          )
        )
        or (
          target_chapter.organization_id is null
          and exists (
            select 1
            from public.member_profiles actor_profile
            left join public.chapters actor_chapter
              on actor_chapter.id = actor_profile.chapter_id
            where actor_profile.id = p_actor
              and (actor_chapter.id is null or actor_chapter.organization_id is null)
          )
          and exists (
            select 1
            from public.member_roles r
            where r.user_id = p_actor
              and r.role = 'steward'
              and (r.chapter_id is null or r.chapter_id = target_chapter.id)
          )
          and (
            not private.staff_mfa_required()
            or private.has_second_factor(p_actor)
          )
        )
      )
  );
$function$;

create or replace function private.actor_has_chapter_staff_role(
  p_actor uuid,
  p_chapter text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.chapters c
    where c.id = p_chapter
      and (
        (
          c.organization_id is not null
          and exists (
            select 1
            from public.organizations o
            where o.id = c.organization_id
              and o.status = 'active'
          )
          and exists (
            select 1
            from public.organization_memberships om
            where om.organization_id = c.organization_id
              and om.user_id = p_actor
              and om.status = 'active'
          )
          and (
            exists (
              select 1 from public.organization_role_grants g
              where g.organization_id = c.organization_id
                and g.user_id = p_actor
                and g.role = any(array['steward','coordinator','advisor','admin','vp'])
            )
            or exists (
              select 1
              from public.member_role_chapters rc
              join public.member_chapter_memberships cm
                on cm.user_id = rc.user_id
               and cm.chapter_id = rc.chapter_id
               and cm.status = 'active'
              where rc.user_id = p_actor
                and rc.chapter_id = c.id
                and rc.role = any(array['steward','coordinator','advisor','admin','vp'])
            )
          )
          and (
            not private.staff_mfa_required(c.organization_id)
            or private.has_second_factor(p_actor)
          )
        )
        or (
          c.organization_id is null
          and exists (
            select 1
            from public.member_profiles actor_profile
            left join public.chapters actor_chapter
              on actor_chapter.id = actor_profile.chapter_id
            where actor_profile.id = p_actor
              and (actor_chapter.id is null or actor_chapter.organization_id is null)
          )
          and exists (
            select 1
            from public.member_roles r
            where r.user_id = p_actor
              and r.role = any(array['steward','coordinator','advisor','admin','vp'])
              and (r.chapter_id is null or r.chapter_id = c.id)
          )
          and (
            not private.staff_mfa_required()
            or private.has_second_factor(p_actor)
          )
        )
      )
  );
$function$;

create or replace function public.get_my_chapter_memberships()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'chapterId', c.id,
      'name', c.name,
      'region', c.region,
      'selected', c.id = p.chapter_id,
      'pinned', m.pinned,
      'lastSelectedAt', m.last_selected_at,
      'joinedAt', m.joined_at,
      'organizationId', c.organization_id,
      'roles', coalesce((
        select pg_catalog.jsonb_agg(scoped_role.role order by scoped_role.role)
        from (
          select rc.role
          from public.member_role_chapters rc
          where rc.user_id = m.user_id and rc.chapter_id = m.chapter_id
          union
          select g.role
          from public.organization_role_grants g
          where g.user_id = m.user_id
            and c.organization_id is not null
            and g.organization_id = c.organization_id
          union
          select r.role
          from public.member_roles r
          where r.user_id = m.user_id
            and r.chapter_id is null
            and c.organization_id is null
        ) scoped_role
      ), '[]'::jsonb)
    ) order by m.pinned desc, m.last_selected_at desc nulls last, c.name
  ), '[]'::jsonb)
  from public.member_profiles p
  join public.member_chapter_memberships m
    on m.user_id = p.id and m.status = 'active'
  join public.chapters c on c.id = m.chapter_id
  where p.id = (select auth.uid())
    and private.mfa_satisfied()
    and (
      (
        c.organization_id is not null
        and exists (
          select 1
          from public.organization_memberships om
          join public.organizations o
            on o.id = om.organization_id
           and o.status = 'active'
          where om.user_id = p.id
            and om.organization_id = c.organization_id
            and om.status = 'active'
        )
        and (
          private.current_member_organization() is null
          or c.organization_id = private.current_member_organization()
        )
      )
      or (
        c.organization_id is null
        and private.current_member_organization() is null
        and not exists (
          select 1
          from public.organization_memberships om
          join public.organizations o
            on o.id = om.organization_id
           and o.status = 'active'
          where om.user_id = p.id
            and om.status = 'active'
        )
      )
    );
$function$;

revoke all on function private.member_has_chapter_role(text, text[])
  from public, anon, authenticated, service_role;
grant execute on function private.member_has_chapter_role(text, text[])
  to authenticated;
revoke all on function public.get_my_chapter_memberships() from public, anon;
grant execute on function public.get_my_chapter_memberships() to authenticated;

create or replace function public.switch_my_chapter(p_chapter_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  target public.member_chapter_memberships%rowtype;
  chapter_name text;
  target_org uuid;
  current_org uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_chapter_id is null or p_chapter_id = '' then
    raise exception 'chapter required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));
  select * into target
  from public.member_chapter_memberships m
  where m.user_id = caller and m.chapter_id = p_chapter_id and m.status = 'active'
  for update;
  if not found then
    raise exception 'chapter unavailable' using errcode = '42501';
  end if;

  select c.organization_id, c.name into target_org, chapter_name
  from public.chapters c
  where c.id = target.chapter_id;
  current_org := private.current_member_organization();
  if target_org is not null then
    if not exists (
      select 1
      from public.organization_memberships om
      join public.organizations o
        on o.id = om.organization_id
       and o.status = 'active'
      where om.organization_id = target_org
        and om.user_id = caller
        and om.status = 'active'
    ) then
      raise exception 'chapter unavailable' using errcode = '42501';
    end if;
    if current_org is not null and current_org is distinct from target_org then
      raise exception 'foreign chapter switching denied' using errcode = '42501';
    end if;
  elsif current_org is not null then
    raise exception 'foreign chapter switching denied' using errcode = '42501';
  end if;

  update public.member_profiles set chapter_id = target.chapter_id where id = caller;
  update public.member_chapter_memberships
  set last_selected_at = pg_catalog.clock_timestamp()
  where user_id = caller and chapter_id = target.chapter_id;

  return pg_catalog.jsonb_build_object(
    'chapterId', target.chapter_id,
    'name', chapter_name,
    'organizationId', target_org,
    'roles', coalesce((
      select pg_catalog.jsonb_agg(scoped_role.role order by scoped_role.role)
      from (
        select rc.role
        from public.member_role_chapters rc
        where rc.user_id = caller and rc.chapter_id = target.chapter_id
        union
        select g.role
        from public.organization_role_grants g
        where g.user_id = caller
          and target_org is not null
          and g.organization_id = target_org
      ) scoped_role
    ), '[]'::jsonb)
  );
end;
$function$;

create or replace function public.grant_member_chapter_membership(p_user_id uuid, p_chapter_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  locked_org uuid;
  target_org uuid;
  org_admin boolean;
begin
  if caller is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select c.organization_id into locked_org
  from public.chapters c
  where c.id = p_chapter_id;
  if locked_org is null then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  -- Cheap plausibility check: ordinary members must not be able to queue on
  -- the tenant lock. The identical checks are repeated authoritatively below.
  org_admin := private.has_organization_role(locked_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || locked_org::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || p_user_id::text, 0));

  -- Re-resolve and authorize only after taking the same tenant→member lock
  -- order as revocation. A queued grant cannot reuse stale caller authority.
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is distinct from locked_org then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not exists (select 1 from public.member_profiles p where p.id = p_user_id)
     or not exists (select 1 from public.chapters c where c.id = p_chapter_id) then
    raise exception 'membership target unavailable' using errcode = '22023';
  end if;

  insert into public.organization_memberships (organization_id, user_id, status)
  values (target_org, p_user_id, 'active')
  on conflict (organization_id, user_id) do update
    set status = 'active', revoked_at = null;

  insert into public.member_chapter_memberships (user_id, chapter_id, status)
  values (p_user_id, p_chapter_id, 'active')
  on conflict (user_id, chapter_id) do update
    set status = 'active', revoked_at = null;

  update public.member_profiles
  set chapter_id = p_chapter_id
  where id = p_user_id and chapter_id is null;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, 'grant_chapter_membership', p_user_id,
    pg_catalog.jsonb_build_object('chapterId', p_chapter_id));
  return pg_catalog.jsonb_build_object('userId', p_user_id, 'chapterId', p_chapter_id, 'active', true);
end;
$function$;

create or replace function public.revoke_member_chapter_membership(p_user_id uuid, p_chapter_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  target_org uuid;
  org_admin boolean;
  replacement_chapter text;
begin
  if caller is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is null then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  -- Reject implausible callers before they can queue behind tenant admin work.
  -- Stale-authority races are still closed by the post-lock recheck below.
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || target_org::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || p_user_id::text, 0));

  -- Reauthorize after the shared organization-role lock. A queued expulsion
  -- must not continue with an admin grant that was revoked while it waited.
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  if exists (
       select 1
       from public.organization_role_grants g
       where g.organization_id = target_org
         and g.user_id = p_user_id
         and g.role = 'admin'
     )
     and exists (
       select 1
       from public.member_chapter_memberships m
       where m.user_id = p_user_id
         and m.chapter_id = p_chapter_id
         and m.status = 'active'
     )
     and not exists (
       select 1
       from public.member_chapter_memberships m
       join public.chapters c on c.id = m.chapter_id
       where m.user_id = p_user_id
         and m.chapter_id <> p_chapter_id
         and m.status = 'active'
         and c.organization_id = target_org
     )
     and (
       select pg_catalog.count(*)
       from public.organization_role_grants g
       where g.organization_id = target_org
         and g.role = 'admin'
     ) <= 1 then
    raise exception 'cannot remove the last organization admin' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.member_chapter_memberships m
    where m.user_id = p_user_id
      and m.chapter_id = p_chapter_id
      and m.status = 'active'
  ) then
    raise exception 'membership unavailable' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.member_profiles p
    where p.id = p_user_id and p.chapter_id = p_chapter_id
  ) then
    select m.chapter_id into replacement_chapter
    from public.member_chapter_memberships m
    join public.chapters c
      on c.id = m.chapter_id
     and c.organization_id = target_org
    where m.user_id = p_user_id
      and m.chapter_id <> p_chapter_id
      and m.status = 'active'
    order by m.last_selected_at desc nulls last, m.joined_at, m.chapter_id
    limit 1;
  end if;

  -- Write tenant-attributed evidence while the actor's selected membership is
  -- still intact. This matters when an organization admin revokes their own
  -- final chapter membership.
  insert into public.member_admin_audit (
    actor, action, target_user, detail, organization_id
  ) values (
    caller,
    'revoke_chapter_membership',
    p_user_id,
    pg_catalog.jsonb_build_object(
      'chapterId', p_chapter_id,
      'replacementChapterId', replacement_chapter
    ),
    target_org
  );

  update public.member_chapter_memberships
  set status = 'revoked', revoked_at = pg_catalog.clock_timestamp(), pinned = false
  where user_id = p_user_id and chapter_id = p_chapter_id and status = 'active';

  delete from public.member_role_chapters
  where user_id = p_user_id and chapter_id = p_chapter_id;
  delete from public.member_roles r
  where r.user_id = p_user_id and r.chapter_id is not null
    and not exists (
      select 1 from public.member_role_chapters rc
      where rc.user_id = r.user_id and rc.role = r.role
    );

  if not exists (
    select 1
    from public.member_chapter_memberships m
    join public.chapters c on c.id = m.chapter_id
    where m.user_id = p_user_id
      and m.status = 'active'
      and c.organization_id = target_org
  ) then
    update public.organization_memberships
    set status = 'revoked', revoked_at = pg_catalog.clock_timestamp()
    where organization_id = target_org and user_id = p_user_id and status = 'active';
  end if;

  if exists (
    select 1 from public.member_profiles p
    where p.id = p_user_id and p.chapter_id = p_chapter_id
  ) then
    update public.member_profiles set chapter_id = replacement_chapter where id = p_user_id;
  end if;
  return pg_catalog.jsonb_build_object('userId', p_user_id, 'chapterId', p_chapter_id, 'active', false);
end;
$function$;

create or replace function public.set_member_chapter_role(
  p_user_id uuid,
  p_chapter_id text,
  p_role text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  target_org uuid;
  org_admin boolean;
begin
  if caller is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('steward', 'coordinator', 'advisor', 'admin', 'vp') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is null then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  -- Reject implausible callers without letting them wait on an admin lock.
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || target_org::text, 509));

  -- All authoritative authorization and target-membership checks occur after
  -- the tenant authorization lock. This prevents a queued chapter-admin grant
  -- from restoring authority revoked by the transaction ahead of it.
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.member_chapter_memberships m
    where m.user_id = p_user_id and m.chapter_id = p_chapter_id and m.status = 'active'
  ) then
    raise exception 'active chapter membership required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_memberships om
    where om.user_id = p_user_id and om.organization_id = target_org and om.status = 'active'
  ) then
    raise exception 'active organization membership required' using errcode = '22023';
  end if;

  if coalesce(p_enabled, false) then
    insert into public.member_roles (user_id, role, granted_by, chapter_id)
    values (p_user_id, p_role, caller, p_chapter_id)
    on conflict (user_id, role) do nothing;
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
    values (p_user_id, p_role, p_chapter_id, caller)
    on conflict (user_id, role, chapter_id) do nothing;
  else
    if p_role = 'admin' and p_user_id = caller and p_chapter_id = private.current_member_chapter() then
      raise exception 'an admin cannot remove the active admin role from this session' using errcode = '22023';
    end if;
    delete from public.member_role_chapters
    where user_id = p_user_id and role = p_role and chapter_id = p_chapter_id;
    delete from public.member_roles r
    where r.user_id = p_user_id and r.role = p_role and r.chapter_id is not null
      and not exists (
        select 1 from public.member_role_chapters rc
        where rc.user_id = r.user_id and rc.role = r.role
      );
  end if;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, case when coalesce(p_enabled, false) then 'grant_role' else 'revoke_role' end,
    p_user_id, pg_catalog.jsonb_build_object('role', p_role, 'chapterId', p_chapter_id));
  return pg_catalog.jsonb_build_object(
    'userId', p_user_id, 'chapterId', p_chapter_id, 'role', p_role,
    'enabled', coalesce(p_enabled, false));
end;
$function$;

create function public.set_member_organization_role(
  p_user_id uuid,
  p_role text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  locked_org uuid := private.current_member_organization();
  target_org uuid;
  changed integer := 0;
begin
  if caller is null or locked_org is null then
    raise exception 'organization admin required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('steward', 'coordinator', 'advisor', 'admin', 'vp') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  if not private.has_organization_role(locked_org, array['admin']) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || locked_org::text, 509));

  -- Re-derive and reauthorize under the lock. In particular, a self-regrant
  -- queued behind revocation cannot reuse its pre-lock admin authority.
  target_org := private.current_member_organization();
  if target_org is distinct from locked_org
     or not private.has_organization_role(locked_org, array['admin']) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.organization_memberships om
    where om.organization_id = locked_org
      and om.user_id = p_user_id
      and om.status = 'active'
  ) then
    raise exception 'active organization membership required' using errcode = '22023';
  end if;

  target_org := locked_org;

  if coalesce(p_enabled, false) then
    insert into public.organization_role_grants
      (organization_id, user_id, role, granted_by)
    values (target_org, p_user_id, p_role, caller)
    on conflict (organization_id, user_id, role) do nothing;
    get diagnostics changed = row_count;
  else
    if p_role = 'admin'
       and exists (
         select 1 from public.organization_role_grants g
         where g.organization_id = target_org
           and g.user_id = p_user_id
           and g.role = 'admin'
       )
       and (
         select pg_catalog.count(*)
         from public.organization_role_grants g
         where g.organization_id = target_org and g.role = 'admin'
       ) <= 1 then
      raise exception 'cannot remove the last organization admin' using errcode = '22023';
    end if;

    delete from public.organization_role_grants g
    where g.organization_id = target_org
      and g.user_id = p_user_id
      and g.role = p_role;
    get diagnostics changed = row_count;
  end if;

  if changed > 0 then
    insert into public.organization_audit_events (
      organization_id, event_type, actor_user_id, idempotency_key, metadata
    ) values (
      target_org,
      case when coalesce(p_enabled, false)
        then 'organization_role_granted'
        else 'organization_role_revoked'
      end,
      caller,
      extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', target_org::text,
        'userId', p_user_id::text,
        'role', p_role
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', target_org,
    'userId', p_user_id,
    'role', p_role,
    'enabled', coalesce(p_enabled, false),
    'changed', changed > 0
  );
end;
$function$;

revoke all on function public.set_member_organization_role(uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_member_organization_role(uuid, text, boolean)
  to authenticated;
comment on function public.set_member_organization_role(uuid, text, boolean) is
  'Selected-tenant organization-admin role grant/revoke path. Requires active membership, preserves a final organization admin, and writes bounded append-only audit evidence.';

create or replace function public.create_admin_chapter(
  p_id text,
  p_name text,
  p_region text default null,
  p_order_index integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org_id uuid := private.current_member_organization();
  locked_org uuid;
  clean_id text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_id, '')));
  clean_name text := pg_catalog.btrim(coalesce(p_name, ''));
  clean_region text := nullif(pg_catalog.btrim(coalesce(p_region, '')), '');
  clean_order integer;
begin
  if caller is null
     or org_id is null
     or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  if clean_id !~ '^[a-z0-9][a-z0-9-]{0,31}$'
     or pg_catalog.char_length(clean_name) < 2
     or pg_catalog.char_length(clean_name) > 120
     or clean_name ~ '[[:cntrl:]]'
     or (clean_region is not null and (pg_catalog.char_length(clean_region) > 120 or clean_region ~ '[[:cntrl:]]'))
     or (p_order_index is not null and (p_order_index < 1 or p_order_index > 10000)) then
    raise exception 'invalid chapter' using errcode = '22023';
  end if;

  locked_org := org_id;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || locked_org::text, 509));

  -- Re-resolve tenant and authority after the shared organization lock. A
  -- queued create cannot survive an intervening admin revocation or chapter
  -- switch.
  org_id := private.current_member_organization();
  if org_id is distinct from locked_org
     or not private.has_organization_role(locked_org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('chapters:admin'));
  if exists (select 1 from public.chapters c where c.id = clean_id) then
    raise exception 'chapter already exists' using errcode = '23505';
  end if;
  if exists (
    select 1 from public.chapters c
    where c.organization_id = org_id
      and (pg_catalog.lower(c.name) = pg_catalog.lower(clean_name) or c.slug = clean_id)
  ) then
    raise exception 'chapter already exists' using errcode = '23505';
  end if;
  clean_order := coalesce(
    p_order_index,
    (select coalesce(pg_catalog.max(c.order_index), 0) + 1 from public.chapters c where c.organization_id = org_id)
  );

  insert into public.chapters (id, name, region, is_default, order_index, organization_id, slug)
  values (clean_id, clean_name, clean_region, false, clean_order, org_id, clean_id);
  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'create_chapter', pg_catalog.jsonb_build_object(
    'chapterId', clean_id, 'fields', pg_catalog.jsonb_build_array('name', 'region', 'orderIndex')));

  return pg_catalog.jsonb_build_object(
    'id', clean_id, 'name', clean_name, 'region', clean_region,
    'isDefault', false, 'orderIndex', clean_order, 'created', true);
end;
$function$;

create or replace function public.update_admin_chapter(
  p_chapter_id text,
  p_name text,
  p_region text default null,
  p_order_index integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org_id uuid := private.current_member_organization();
  org_admin boolean;
  chapter_row record;
  clean_name text := pg_catalog.btrim(coalesce(p_name, ''));
  clean_region text := nullif(pg_catalog.btrim(coalesce(p_region, '')), '');
  clean_order integer := p_order_index;
  changed text[] := '{}'::text[];
begin
  if caller is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_name) < 2
     or pg_catalog.char_length(clean_name) > 120
     or clean_name ~ '[[:cntrl:]]'
     or (clean_region is not null and (pg_catalog.char_length(clean_region) > 120 or clean_region ~ '[[:cntrl:]]'))
     or clean_order is null or clean_order < 1 or clean_order > 10000 then
    raise exception 'invalid chapter' using errcode = '22023';
  end if;

  select c.* into chapter_row from public.chapters c where c.id = p_chapter_id for update;
  if not found or chapter_row.organization_id is null then
    raise exception 'chapter unavailable' using errcode = '22023';
  end if;
  if org_id is null or chapter_row.organization_id is distinct from org_id then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  org_admin := private.has_organization_role(org_id, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and (
       clean_region is distinct from chapter_row.region
       or clean_order is distinct from chapter_row.order_index
     ) then
    raise exception 'organization admin required for chapter structure' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.chapters c
    where c.organization_id = org_id
      and c.id <> p_chapter_id
      and pg_catalog.lower(c.name) = pg_catalog.lower(clean_name)
  ) then
    raise exception 'chapter already exists' using errcode = '23505';
  end if;
  if clean_name is distinct from chapter_row.name then changed := pg_catalog.array_append(changed, 'name'); end if;
  if clean_region is distinct from chapter_row.region then changed := pg_catalog.array_append(changed, 'region'); end if;
  if clean_order is distinct from chapter_row.order_index then changed := pg_catalog.array_append(changed, 'orderIndex'); end if;

  if pg_catalog.cardinality(changed) > 0 then
    update public.chapters
    set name = clean_name, region = clean_region, order_index = clean_order
    where id = p_chapter_id;
    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_chapter', pg_catalog.jsonb_build_object(
      'chapterId', p_chapter_id, 'fields', pg_catalog.to_jsonb(changed)));
  end if;

  return pg_catalog.jsonb_build_object(
    'id', p_chapter_id, 'name', clean_name, 'region', clean_region,
    'isDefault', chapter_row.is_default, 'orderIndex', clean_order,
    'updated', pg_catalog.cardinality(changed) > 0);
end;
$function$;

create or replace function private.handle_new_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  member_first text := coalesce(nullif(new.raw_user_meta_data ->> 'first_name', ''), 'Member');
  member_full text := coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), 'Member');
  member_initials text := coalesce(nullif(new.raw_user_meta_data ->> 'initials', ''), 'M');
  member_chapter text := nullif(new.raw_user_meta_data ->> 'chapter_id', '');
  invitation_id text := nullif(new.raw_user_meta_data ->> 'union_base_invitation_id', '');
  member_organization uuid;
begin
  if member_chapter is not null
     and not exists (select 1 from public.chapters where id = member_chapter) then
    member_chapter := null;
  end if;
  if member_chapter is not null
     and exists (
       select 1 from public.chapters c
       where c.id = member_chapter and c.organization_id is not null
     ) then
    if invitation_id is null
       or invitation_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or not exists (
         select 1
         from public.member_invitations i
         join public.chapters c on c.id = i.chapter_id
         join public.organizations o
           on o.id = c.organization_id
          and o.status = 'active'
         where i.id = invitation_id::uuid
           and i.status = 'accepting'
           and i.chapter_id = member_chapter
           and i.normalized_email = pg_catalog.lower(new.email)
           and i.token_hash is not null
       ) then
      member_chapter := null;
    else
      select c.organization_id into member_organization
      from public.chapters c
      where c.id = member_chapter;
    end if;
  end if;

  insert into public.member_profiles (id, first_name, full_name, initials, chapter_id)
  values (new.id, member_first, member_full, member_initials, member_chapter);

  if member_organization is not null then
    insert into public.organization_memberships
      (organization_id, user_id, status)
    values (member_organization, new.id, 'active');
  end if;

  if member_chapter is not null then
    insert into public.member_chapter_memberships
      (user_id, chapter_id, status, last_selected_at)
    values (new.id, member_chapter, 'active', pg_catalog.now());
  end if;
  return new;
end;
$function$;

revoke all on function private.handle_new_member() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Policies
-- ---------------------------------------------------------------------------

alter policy chapters_select_all on public.chapters
  using (
    (
      organization_id is not null
      and organization_id = private.current_member_organization()
      and private.is_organization_member(organization_id)
    )
    or (
      organization_id is null
      and private.current_member_organization() is null
      and exists (
        select 1
        from public.member_chapter_memberships m
        where m.user_id = (select auth.uid())
          and m.chapter_id = chapters.id
          and m.status = 'active'
      )
    )
  );

alter policy member_broadcasts_read_authenticated on public.member_broadcasts
  using (private.can_read_member_broadcast(id));

alter policy member_broadcast_receipts_insert_own on public.member_broadcast_receipts
  with check (
    (select auth.uid()) = user_id
    and private.can_read_member_broadcast(broadcast_id)
  );

drop policy if exists chapter_records_read on public.chapter_records;
create policy chapter_records_read_chapter on public.chapter_records
  for select to authenticated
  using (
    record_type in ('minutes', 'decision', 'milestone')
    and chapter_id = private.current_member_chapter()
    and exists (
      select 1
      from public.member_chapter_memberships m
      where m.user_id = (select auth.uid())
        and m.chapter_id = chapter_records.chapter_id
        and m.status = 'active'
    )
    and exists (
      select 1
      from public.chapters c
      where c.id = chapter_records.chapter_id
        and (
          (
            c.organization_id is not null
            and c.organization_id = private.current_member_organization()
            and private.is_organization_member(c.organization_id)
          )
          or (
            c.organization_id is null
            and private.current_member_organization() is null
          )
        )
    )
  );
create policy chapter_records_read_contacts on public.chapter_records
  for select to authenticated
  using (
    record_type in ('member_contact', 'management_contact')
    and exists (
      select 1
      from public.chapters c
      where c.id = chapter_records.chapter_id
        and (
          (
            c.organization_id is not null
            and c.organization_id = private.current_member_organization()
            and (
              private.has_organization_role(
                c.organization_id,
                array['steward', 'coordinator', 'advisor', 'admin', 'vp']
              )
              or private.member_has_chapter_role(
                c.id,
                array['steward', 'coordinator', 'advisor', 'admin', 'vp']
              )
            )
          )
          or (
            c.organization_id is null
            and private.current_member_organization() is null
            and private.member_has_chapter_role(
              c.id,
              array['steward', 'coordinator', 'advisor', 'admin', 'vp']
            )
          )
        )
    )
  );

alter policy chapter_records_staff_create on public.chapter_records
  with check (
    chapter_id = private.current_member_chapter()
    and created_by = (select auth.uid())
    and private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp'])
    and exists (
      select 1 from public.chapters c
      where c.id = chapter_id
        and c.organization_id is not null
        and c.organization_id = private.current_member_organization()
    )
  );
alter policy chapter_records_staff_write on public.chapter_records
  using (
    chapter_id = private.current_member_chapter()
    and private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp'])
    and exists (
      select 1 from public.chapters c
      where c.id = chapter_id
        and c.organization_id is not null
        and c.organization_id = private.current_member_organization()
    )
  )
  with check (
    chapter_id = private.current_member_chapter()
    and private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp'])
    and exists (
      select 1 from public.chapters c
      where c.id = chapter_id
        and c.organization_id is not null
        and c.organization_id = private.current_member_organization()
    )
  );

create policy organizations_select_member on public.organizations
  for select to authenticated
  using (private.is_organization_member(id));
create policy organization_memberships_select_visible on public.organization_memberships
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.has_organization_role(organization_id, array['admin'])
  );
create policy organization_role_grants_select_visible on public.organization_role_grants
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.has_organization_role(organization_id, array['admin'])
  );
create policy organization_audit_events_select_admin on public.organization_audit_events
  for select to authenticated
  using (private.has_organization_role(organization_id, array['admin']));

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organizations',
    'organization_memberships',
    'organization_role_grants',
    'organization_audit_events'
  ]
  loop
    execute format(
      'create policy mfa_assurance on public.%I as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()))',
      table_name
    );
  end loop;
end
$$;

revoke all on public.organizations from public, anon, authenticated;
revoke all on public.organization_memberships from public, anon, authenticated;
revoke all on public.organization_role_grants from public, anon, authenticated;
revoke all on public.organization_audit_events from public, anon, authenticated;
grant select on public.organizations to authenticated;
grant select on public.organization_memberships to authenticated;
grant select on public.organization_role_grants to authenticated;
grant select on public.organization_audit_events to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Broadcast and source RPCs
-- ---------------------------------------------------------------------------

drop function if exists public.publish_member_broadcast(text, text, text);

create function public.publish_member_broadcast(
  p_title text,
  p_body text,
  p_locale text default 'en',
  p_audience_scope text default 'chapter'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  publisher_org uuid := private.current_member_organization();
  publisher_chapter text := private.current_member_chapter();
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  clean_locale text := coalesce(nullif(pg_catalog.btrim(coalesce(p_locale, '')), ''), 'en');
  clean_scope text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_audience_scope, 'chapter')));
  recent integer;
  new_id text;
  next_index integer;
  attempts integer := 0;
begin
  if caller is null then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if publisher_org is null or publisher_chapter is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.chapters c
    where c.id = publisher_chapter and c.organization_id = publisher_org
  ) then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if clean_scope not in ('chapter', 'organization') then
    raise exception 'audience_scope must be chapter or organization' using errcode = '22023';
  end if;
  if clean_scope = 'organization'
     and not private.has_organization_role(publisher_org, array['steward']) then
    raise exception 'organization-wide steward role required' using errcode = '42501';
  end if;
  if clean_scope = 'chapter'
     and not private.member_has_chapter_role(publisher_chapter, array['steward']) then
    raise exception 'chapter steward role required' using errcode = '42501';
  end if;

  if clean_title = '' or pg_catalog.char_length(clean_title) > 120 then
    raise exception 'title must be between 1 and 120 characters' using errcode = '22023';
  end if;
  if clean_title ~ '[[:cntrl:]]' then
    raise exception 'title contains unsupported control characters' using errcode = '22023';
  end if;
  if clean_body = '' or pg_catalog.char_length(clean_body) > 4000 then
    raise exception 'body must be between 1 and 4000 characters' using errcode = '22023';
  end if;
  if pg_catalog.regexp_replace(clean_body, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'body contains unsupported control characters' using errcode = '22023';
  end if;
  if clean_locale not in ('en', 'es') then
    raise exception 'locale must be en or es' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-broadcast-publish:' || caller::text, 509));

  select count(*) into recent
  from public.member_broadcasts
  where created_by = caller
    and published_at >= now() - interval '24 hours';
  if recent >= 5 then
    raise exception 'broadcast limit reached: 5 per steward per day' using errcode = '54000';
  end if;

  loop
    begin
      new_id := 'bc-' || extensions.gen_random_uuid();
      select coalesce(min(order_index), 1) - 1 into next_index from public.member_broadcasts;
      insert into public.member_broadcasts (
        id, sender, title, body, published_at, order_index, created_by, locale,
        organization_id, chapter_id, audience_scope
      )
      values (
        new_id, 'Chapter steward', clean_title, clean_body, now(), next_index, caller, clean_locale,
        publisher_org, publisher_chapter, clean_scope
      );
      exit;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts >= 3 then
        raise;
      end if;
    end;
  end loop;

  return pg_catalog.jsonb_build_object('broadcastId', new_id);
end;
$function$;

create or replace function public.retract_member_broadcast(p_broadcast_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  publisher_org uuid := private.current_member_organization();
  updated integer;
begin
  if caller is null
     or not private.member_has_chapter_role(private.current_member_chapter(), array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if publisher_org is null then
    raise exception 'organization required' using errcode = '42501';
  end if;

  update public.member_broadcasts
  set retracted_at = now()
  where id = p_broadcast_id
    and created_by = caller
    and retracted_at is null
    and organization_id = publisher_org;
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'broadcast not found, not yours, or already retracted' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object('broadcastId', p_broadcast_id, 'retracted', true);
end;
$function$;

create or replace function public.get_broadcast_read_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
  publisher_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null
     or not private.member_has_chapter_role(private.current_member_chapter(), array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if publisher_org is null then
    return '[]'::jsonb;
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', recent.id,
      'readCount', (select count(*) from public.member_broadcast_receipts reads where reads.broadcast_id = recent.id)
    ) order by recent.published_at desc
  ), '[]'::jsonb)
  into result
  from (
    select b.id, b.published_at
    from public.member_broadcasts b
    where b.organization_id = publisher_org
      and private.can_read_member_broadcast(b.id)
    order by b.published_at desc
    limit 20
  ) recent;

  return result;
end;
$function$;

create or replace function public.get_broadcast_read_counts_for(p_broadcast_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
  publisher_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null
     or not private.member_has_chapter_role(private.current_member_chapter(), array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_broadcast_ids is null
     or pg_catalog.cardinality(p_broadcast_ids) < 1
     or pg_catalog.cardinality(p_broadcast_ids) > 100 then
    raise exception 'between 1 and 100 broadcast ids' using errcode = '22023';
  end if;
  if publisher_org is null then
    return '[]'::jsonb;
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', b.id,
      'readCount', (select count(*) from public.member_broadcast_receipts reads where reads.broadcast_id = b.id)
    ) order by b.published_at desc
  ), '[]'::jsonb)
  into result
  from public.member_broadcasts b
  where b.id = any(p_broadcast_ids)
    and b.organization_id = publisher_org
    and private.can_read_member_broadcast(b.id);

  return result;
end;
$function$;

create or replace function public.soft_delete_chapter_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  task_row public.chapter_tasks%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));

  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller;
  if caller_chapter is null or not private.member_has_chapter_role(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select t.* into task_row
  from public.chapter_tasks t
  where t.id = p_task_id
    and t.chapter_id = caller_chapter
    and t.deleted_at is null
  for update of t;

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  update public.chapter_tasks
    set deleted_at = pg_catalog.now(), deleted_by = caller
    where id = task_row.id;

  if task_row.assignee_id is not null and task_row.assignee_id <> caller then
    perform private.notify_member(task_row.assignee_id, 'task.deleted',
      pg_catalog.jsonb_build_object('name',
        coalesce((select p.full_name from public.member_profiles p where p.id = caller), 'Someone')),
      'tasks');
  end if;

  return pg_catalog.jsonb_build_object('id', task_row.id, 'deletedAt', pg_catalog.now());
end
$function$;

create or replace function public.restore_chapter_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  task_row public.chapter_tasks%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));

  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller;
  if caller_chapter is null or not private.member_has_chapter_role(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select t.* into task_row
  from public.chapter_tasks t
  where t.id = p_task_id
    and t.chapter_id = caller_chapter
    and t.deleted_at is not null
  for update of t;

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  update public.chapter_tasks
    set deleted_at = null, deleted_by = null
    where id = task_row.id;

  if task_row.assignee_id is not null and task_row.assignee_id <> caller then
    perform private.notify_member(task_row.assignee_id, 'task.restored',
      pg_catalog.jsonb_build_object('name',
        coalesce((select p.full_name from public.member_profiles p where p.id = caller), 'Someone')),
      'tasks');
  end if;

  return pg_catalog.jsonb_build_object('id', task_row.id, 'restored', true);
end
$function$;

create or replace function public.create_chapter_task_from_source(
  p_source_kind text,
  p_source_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_org uuid;
  clean_kind text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source_kind, '')));
  clean_source_id text := pg_catalog.btrim(coalesce(p_source_id, ''));
  source_uuid uuid;
  source_found boolean := false;
  source_is_current boolean := true;
  task_title text;
  attachment_label text;
  record_url text;
  task_workstream text;
  message_owner uuid;
  message_conversation uuid;
  case_row public.member_cases%rowtype;
  task_row public.chapter_tasks%rowtype;
  attachment_row public.chapter_task_attachments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if clean_kind not in ('message', 'broadcast', 'notification', 'survey', 'case')
     or clean_source_id = ''
     or pg_catalog.char_length(clean_source_id) > 200 then
    raise exception 'source unavailable' using errcode = '22023';
  end if;

  if clean_kind in ('message', 'notification', 'case') then
    begin
      source_uuid := clean_source_id::uuid;
      clean_source_id := source_uuid::text;
    exception when invalid_text_representation then
      raise exception 'source unavailable' using errcode = '22023';
    end;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));

  select p.chapter_id, c.organization_id into caller_chapter, caller_org
  from public.member_profiles p
  left join public.chapters c on c.id = p.chapter_id
  where p.id = caller;
  if caller_chapter is null then
    raise exception 'source unavailable' using errcode = '22023';
  end if;
  if not private.member_has_chapter_role(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  case clean_kind
    when 'message' then
      select m.user_id, m.conversation_id into message_owner, message_conversation
      from public.member_messages m
      where m.id = source_uuid
        and m.sender_kind = 'member'
        and (
          m.user_id = caller
          or public.staff_can_see_user(m.user_id, 'steward')
        );
      source_found := found;
      task_title := 'Follow up on member message';
      attachment_label := 'Authorized member message';
      record_url := case when message_owner = caller
        then '/m/messages?conversation=' || message_conversation::text
        else '/m/steward?thread=' || message_conversation::text
      end;
    when 'broadcast' then
      select b.retracted_at is null into source_is_current
      from public.member_broadcasts b
      where b.id = clean_source_id
        and b.organization_id is not null
        and caller_org is not null
        and b.organization_id = caller_org
        and private.can_read_member_broadcast(b.id);
      source_found := found;
      task_title := 'Review chapter broadcast';
      attachment_label := 'Authorized chapter broadcast';
      record_url := '/m/messages?broadcast=' || clean_source_id;
    when 'notification' then
      select true into source_found
      from public.member_notifications n
      where n.id = source_uuid
        and n.user_id = caller;
      source_found := found;
      task_title := 'Review notification';
      attachment_label := 'Authorized notification';
      record_url := '/m/messages?notification=' || clean_source_id;
    when 'survey' then
      select s.active into source_is_current
      from public.member_surveys s
      where s.id = clean_source_id
        and s.chapter_id is not null
        and s.chapter_id = caller_chapter;
      source_found := found;
      task_title := 'Follow up on survey';
      attachment_label := 'Authorized survey';
      record_url := '/m/voting?survey=' || clean_source_id;
    when 'case' then
      select c.* into case_row
      from public.member_cases c
      where c.id = source_uuid
        and (
          c.user_id = caller
          or (
            c.steward_user_id = caller
            and private.member_has_chapter_role(caller_chapter, array['steward'])
          )
          or public.staff_can_see_user(c.user_id, 'coordinator')
        );
      source_found := found;
      source_is_current := case_row.status = 'active';
      task_title := 'Follow up on grievance';
      attachment_label := 'Authorized grievance';
      record_url := case
        when case_row.user_id = caller then '/m/cases?case=' || clean_source_id
        when case_row.steward_user_id = caller
          and private.member_has_chapter_role(caller_chapter, array['steward'])
          then '/m/steward?case=' || clean_source_id
        else '/m/coordinator?case=' || clean_source_id
      end;
  end case;

  if not source_found then
    raise exception 'source unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      caller_chapter || pg_catalog.chr(31) || clean_kind || pg_catalog.chr(31) || clean_source_id,
      0
    )
  );

  select a.* into attachment_row
  from public.chapter_task_attachments a
  where a.chapter_id = caller_chapter
    and a.source_kind = clean_kind
    and a.source_id = clean_source_id;
  if found then
    select t.* into task_row
    from public.chapter_tasks t
    where t.id = attachment_row.task_id;
    return pg_catalog.jsonb_build_object(
      'task', pg_catalog.to_jsonb(task_row),
      'attachment', pg_catalog.to_jsonb(attachment_row),
      'created', false
    );
  end if;

  if not source_is_current then
    raise exception 'source unavailable' using errcode = '22023';
  end if;

  select w.name into task_workstream
  from public.chapter_workstreams w
  where w.chapter_id = caller_chapter
  order by
    (pg_catalog.lower(pg_catalog.btrim(w.name)) = 'general') desc,
    pg_catalog.lower(pg_catalog.btrim(w.name)),
    w.name,
    w.id
  limit 1
  for key share of w;
  if task_workstream is null then
    raise exception 'chapter has no available task workstream' using errcode = '22023';
  end if;

  insert into public.chapter_tasks (
    title, description, status, priority, task_type, workstream,
    assignee_id, start_date, due_date, progress, blocked, milestone, order_index
  ) values (
    task_title, '', 'to_do', 'medium', 'general', task_workstream,
    null, null, null, 0, false, false, 0
  ) returning * into task_row;

  insert into public.chapter_task_attachments (
    task_id, chapter_id, label, record_url, created_by, source_kind, source_id
  ) values (
    task_row.id, caller_chapter, attachment_label, record_url, caller,
    clean_kind, clean_source_id
  ) returning * into attachment_row;

  insert into public.chapter_task_activity (
    task_id, chapter_id, actor_id, action, to_value
  ) values (
    task_row.id, caller_chapter, caller, 'attachment_added', attachment_row.id::text
  );

  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(task_row),
    'attachment', pg_catalog.to_jsonb(attachment_row),
    'created', true
  );
end
$function$;

revoke all on function public.publish_member_broadcast(text, text, text, text) from public, anon;
grant execute on function public.publish_member_broadcast(text, text, text, text) to authenticated, service_role;
revoke all on function public.create_chapter_task_from_source(text, text)
  from public, anon, authenticated;
grant execute on function public.create_chapter_task_from_source(text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 8. First-organization bootstrap (service-role only)
-- ---------------------------------------------------------------------------

create function public.bootstrap_first_organization(
  p_name text,
  p_slug text,
  p_creator_user_id uuid,
  p_first_chapter_id text,
  p_first_chapter_name text,
  p_first_chapter_slug text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  clean_name text := pg_catalog.btrim(coalesce(p_name, ''));
  clean_slug text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_slug, '')));
  clean_chapter_id text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_first_chapter_id, '')));
  clean_chapter_name text := pg_catalog.btrim(coalesce(p_first_chapter_name, ''));
  clean_chapter_slug text := pg_catalog.lower(pg_catalog.btrim(coalesce(nullif(p_first_chapter_slug, ''), p_first_chapter_id, '')));
  existing jsonb;
  org_id uuid;
  result jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_creator_user_id is null then
    raise exception 'provisioned user required' using errcode = '22023';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if clean_slug !~ '^[a-z0-9][a-z0-9-]{0,63}$'
     or pg_catalog.char_length(clean_name) < 2
     or pg_catalog.char_length(clean_name) > 120
     or clean_name ~ '[[:cntrl:]]' then
    raise exception 'invalid organization' using errcode = '22023';
  end if;
  if clean_chapter_id !~ '^[a-z0-9][a-z0-9-]{0,31}$'
     or clean_chapter_slug !~ '^[a-z0-9][a-z0-9-]{0,63}$'
     or pg_catalog.char_length(clean_chapter_name) < 2
     or pg_catalog.char_length(clean_chapter_name) > 120
     or clean_chapter_name ~ '[[:cntrl:]]' then
    raise exception 'invalid chapter' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_creator_user_id)
     or not exists (select 1 from public.member_profiles p where p.id = p_creator_user_id) then
    raise exception 'provisioned user required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('mi1:bootstrap-first-organization', 509)
  );

  select pg_catalog.jsonb_build_object(
    'organizationId', e.organization_id,
    'chapterId', e.metadata ->> 'chapterId',
    'slug', e.metadata ->> 'slug',
    'name', e.metadata ->> 'name',
    'userId', e.metadata ->> 'userId',
    'idempotent', true
  )
  into existing
  from public.organization_audit_events e
  where e.idempotency_key = p_idempotency_key
    and e.event_type = 'first_organization_bootstrap';
  if found then
    return existing;
  end if;

  if exists (select 1 from public.organizations) then
    raise exception 'organization already exists' using errcode = '23505';
  end if;
  if exists (select 1 from public.chapters c where c.id = clean_chapter_id) then
    raise exception 'chapter already exists' using errcode = '23505';
  end if;

  insert into public.organizations (slug, name, status, created_by)
  values (clean_slug, clean_name, 'active', p_creator_user_id)
  returning id into org_id;

  insert into public.org_security_policy (
    id, organization_id, require_staff_mfa, updated_by
  ) values (
    true, org_id, true, p_creator_user_id
  );

  insert into public.chapters (id, name, region, is_default, order_index, organization_id, slug)
  values (clean_chapter_id, clean_chapter_name, null, true, 1, org_id, clean_chapter_slug);

  insert into public.organization_memberships (organization_id, user_id, status)
  values (org_id, p_creator_user_id, 'active');

  insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
  values (org_id, p_creator_user_id, 'admin', p_creator_user_id);

  insert into public.member_chapter_memberships
    (user_id, chapter_id, status, last_selected_at)
  values (p_creator_user_id, clean_chapter_id, 'active', pg_catalog.now())
  on conflict (user_id, chapter_id) do update
    set status = 'active', revoked_at = null, last_selected_at = pg_catalog.now();

  update public.member_profiles
  set chapter_id = clean_chapter_id
  where id = p_creator_user_id;

  insert into public.organization_audit_events (
    organization_id, event_type, actor_user_id, idempotency_key, metadata
  ) values (
    org_id,
    'first_organization_bootstrap',
    p_creator_user_id,
    p_idempotency_key,
    pg_catalog.jsonb_build_object(
      'organizationId', org_id::text,
      'chapterId', clean_chapter_id,
      'slug', clean_slug,
      'name', clean_name,
      'userId', p_creator_user_id::text
    )
  );

  result := pg_catalog.jsonb_build_object(
    'organizationId', org_id,
    'chapterId', clean_chapter_id,
    'slug', clean_slug,
    'name', clean_name,
    'userId', p_creator_user_id,
    'idempotent', false
  );
  return result;
end;
$function$;

revoke all on function public.bootstrap_first_organization(text, text, uuid, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.bootstrap_first_organization(text, text, uuid, text, text, text, uuid)
  to service_role;

comment on function public.bootstrap_first_organization(text, text, uuid, text, text, text, uuid) is
  'Service-role-only first-organization bootstrap. Atomic, idempotent, succeeds only when zero organizations exist, and never creates Auth identities or invented member activity.';

-- ---------------------------------------------------------------------------
-- 9. Account deletion must preserve an active organization administrator
-- ---------------------------------------------------------------------------

-- Tenant audit attribution is immutable evidence, not an ownership edge. A
-- deleted Auth identity must leave its pseudonymous UUID behind unchanged.
alter table public.organization_audit_events
  drop constraint organization_audit_events_actor_user_id_fkey;
alter table public.organization_audit_events
  alter column actor_user_id set not null;

create function private.assert_member_account_deletion_allowed(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  affected_org uuid;
begin
  if p_user_id is null then
    raise exception 'account deletion target required' using errcode = '22023';
  end if;

  -- Lock every active tenant membership, not only tenants where the target is
  -- already an administrator. A grant queued during deletion must serialize
  -- before the authoritative final-admin recheck instead of appearing between
  -- discovery and deletion. UUID ordering gives multi-tenant members one
  -- deterministic order.
  for affected_org in
    select distinct m.organization_id
    from public.organization_memberships m
    join public.organizations o
      on o.id = m.organization_id
     and o.status = 'active'
    where m.user_id = p_user_id
      and m.status = 'active'
    order by m.organization_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('organization-role:' || affected_org::text, 509));
  end loop;

  -- Requery under every affected tenant lock. A concurrent backup-admin
  -- revocation cannot race the final decision made by this helper.
  for affected_org in
    select distinct g.organization_id
    from public.organization_role_grants g
    join public.organization_memberships m
      on m.organization_id = g.organization_id
     and m.user_id = g.user_id
     and m.status = 'active'
    join public.organizations o
      on o.id = g.organization_id
     and o.status = 'active'
    where g.user_id = p_user_id
      and g.role = 'admin'
    order by g.organization_id
  loop
    if not exists (
      select 1
      from public.organization_role_grants backup
      join public.organization_memberships backup_membership
        on backup_membership.organization_id = backup.organization_id
       and backup_membership.user_id = backup.user_id
       and backup_membership.status = 'active'
      where backup.organization_id = affected_org
        and backup.role = 'admin'
        and backup.user_id <> p_user_id
    ) then
      raise exception 'cannot remove the last organization admin' using errcode = '22023';
    end if;
  end loop;
end;
$function$;

create function private.guard_auth_user_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.assert_member_account_deletion_allowed(old.id);
  return old;
end;
$function$;

create function private.guard_member_account_deletion_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.assert_member_account_deletion_allowed(caller);
  return new;
end;
$function$;

create trigger auth_users_preserve_final_organization_admin
  before delete on auth.users
  for each row execute function private.guard_auth_user_deletion();

create trigger member_account_deletions_preserve_final_organization_admin
  before insert on private.member_account_deletions
  for each row execute function private.guard_member_account_deletion_request();

revoke all on function private.assert_member_account_deletion_allowed(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.guard_auth_user_deletion()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_member_account_deletion_request()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. Reward grants are tenant-owned; historical NULL rows stay quarantined
-- ---------------------------------------------------------------------------

alter table public.member_reward_grants
  add column organization_id uuid
    references public.organizations(id) on update cascade on delete restrict;

drop index public.member_reward_grants_live_uniq;
create unique index member_reward_grants_owned_live_uniq
  on public.member_reward_grants (organization_id, user_id, item_key)
  where organization_id is not null and status <> 'revoked';
create unique index member_reward_grants_legacy_live_uniq
  on public.member_reward_grants (user_id, item_key)
  where organization_id is null and status <> 'revoked';
create index member_reward_grants_organization_status_idx
  on public.member_reward_grants (organization_id, status, created_at desc, id)
  where organization_id is not null;

comment on column public.member_reward_grants.organization_id is
  'Owning tenant derived by reward RPCs. NULL is quarantined pre-MI1 history and is never readable or mutable through organization-backed APIs.';

create function private.forbid_ownerless_reward_grant_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' and new.organization_id is null then
    raise exception 'ownerless reward grant writes are prohibited' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if old.organization_id is null then
      raise exception 'legacy reward grants are quarantined' using errcode = '42501';
    end if;
    if new.organization_id is distinct from old.organization_id then
      raise exception 'reward grant organization is immutable' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

create trigger member_reward_grants_forbid_ownerless_write
  before insert or update on public.member_reward_grants
  for each row execute function private.forbid_ownerless_reward_grant_write();

revoke all on function private.forbid_ownerless_reward_grant_write()
  from public, anon, authenticated, service_role;

create function private.can_administer_reward_member(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  with caller_scope as (
    select
      private.current_member_organization() as organization_id,
      private.current_member_chapter() as chapter_id
  )
  select case
    when (select auth.uid()) is null or p_user_id is null then false
    when s.organization_id is null or s.chapter_id is null then false
    when not (
      private.has_organization_role(s.organization_id, array['admin'])
      or private.member_has_chapter_role(s.chapter_id, array['admin'])
    ) then false
    when not exists (
      select 1
      from public.organization_memberships om
      where om.organization_id = s.organization_id
        and om.user_id = p_user_id
        and om.status = 'active'
    ) then false
    when private.has_organization_role(s.organization_id, array['admin']) then
      exists (
        select 1
        from public.member_chapter_memberships cm
        join public.chapters c
          on c.id = cm.chapter_id
         and c.organization_id = s.organization_id
        where cm.user_id = p_user_id
          and cm.status = 'active'
      )
    else exists (
      select 1
      from public.member_chapter_memberships cm
      where cm.user_id = p_user_id
        and cm.chapter_id = s.chapter_id
        and cm.status = 'active'
    )
  end
  from caller_scope s;
$function$;

revoke all on function private.can_administer_reward_member(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.claim_reward_without_shipping_legacy(
  p_item_key text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  item record;
  gid uuid;
begin
  if caller is null or caller_org is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select key, min_tier, fulfillment into item
  from public.member_reward_items
  where key = p_item_key and active;
  if not found then
    raise exception 'reward not found' using errcode = '22023';
  end if;
  if private.member_tier_of(caller) < item.min_tier then
    raise exception 'tier not yet unlocked' using errcode = '22023';
  end if;

  insert into public.member_reward_grants (
    organization_id, user_id, item_key, status, source, note
  ) values (
    caller_org, caller, item.key, 'claimed', 'member_claim',
    nullif(pg_catalog.btrim(coalesce(p_note, '')), '')
  ) returning id into gid;

  insert into public.member_admin_audit (actor, action, target_user, detail, organization_id)
  values (caller, 'claim_reward', caller,
    pg_catalog.jsonb_build_object('item', item.key, 'grantId', gid), caller_org);

  return pg_catalog.jsonb_build_object('grantId', gid, 'status', 'claimed');
exception when unique_violation then
  raise exception 'already claimed' using errcode = '22023';
end;
$function$;

create or replace function public.claim_reward(
  p_item_key text,
  p_note text default null,
  p_shipping_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  fulfillment_kind text;
  clean_address text := nullif(pg_catalog.btrim(coalesce(p_shipping_address, '')), '');
  result jsonb;
begin
  if caller is null or caller_org is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select i.fulfillment into fulfillment_kind
  from public.member_reward_items i
  where i.key = p_item_key and i.active;
  if fulfillment_kind = 'ship'
     and (clean_address is null or pg_catalog.char_length(clean_address) not between 10 and 1000) then
    raise exception 'reward shipping address is required' using errcode = '22023';
  end if;
  if fulfillment_kind <> 'ship' and clean_address is not null then
    raise exception 'shipping address is not used for this reward' using errcode = '22023';
  end if;

  result := public.claim_reward_without_shipping_legacy(p_item_key, p_note);
  if fulfillment_kind = 'ship' then
    update public.member_reward_grants
    set shipping_address = clean_address
    where id = (result ->> 'grantId')::uuid
      and user_id = caller
      and organization_id = caller_org;
  end if;
  return result || pg_catalog.jsonb_build_object('shippingAddress', clean_address);
end;
$function$;

create or replace function public.set_reward_shipping_address(
  p_grant_id uuid,
  p_shipping_address text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  clean_address text := pg_catalog.btrim(coalesce(p_shipping_address, ''));
  g record;
begin
  if caller is null or caller_org is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_address) not between 10 and 1000 then
    raise exception 'reward shipping address is required' using errcode = '22023';
  end if;
  select gr.id, gr.user_id into g
  from public.member_reward_grants gr
  join public.member_reward_items i on i.key = gr.item_key
  where gr.id = p_grant_id
    and gr.organization_id = caller_org
    and gr.user_id = caller
    and i.fulfillment = 'ship'
    and gr.status in ('claimed', 'granted')
  for update of gr;
  if not found then
    raise exception 'reward is not addressable' using errcode = '22023';
  end if;
  update public.member_reward_grants
  set shipping_address = clean_address, updated_at = pg_catalog.now()
  where id = g.id and organization_id = caller_org and user_id = caller;
  return pg_catalog.jsonb_build_object('grantId', g.id, 'shippingAddress', clean_address);
end;
$function$;

create or replace function public.grant_reward(
  p_user_id uuid,
  p_item_key text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  item record;
  gid uuid;
  clean_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
begin
  if caller is null or caller_org is null or not private.mfa_satisfied()
     or not private.can_administer_reward_member(p_user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_reason) not between 1 and 500 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select key, min_tier into item
  from public.member_reward_items
  where key = p_item_key and active;
  if not found then
    raise exception 'reward not found' using errcode = '22023';
  end if;
  if private.member_tier_of(p_user_id) < item.min_tier then
    raise exception 'member has not unlocked this tier' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || caller_org::text, 509));
  if caller_org is distinct from private.current_member_organization()
     or not private.can_administer_reward_member(p_user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  insert into public.member_reward_grants (
    organization_id, user_id, item_key, status, source, granted_by, reason
  ) values (
    caller_org, p_user_id, item.key, 'granted', 'admin_grant', caller, clean_reason
  ) returning id into gid;
  insert into public.member_admin_audit (actor, action, target_user, detail, organization_id)
  values (caller, 'grant_reward', p_user_id,
    pg_catalog.jsonb_build_object('item', item.key, 'grantId', gid, 'reason', clean_reason),
    caller_org);
  return pg_catalog.jsonb_build_object('grantId', gid, 'status', 'granted');
exception when unique_violation then
  raise exception 'member already holds this reward' using errcode = '22023';
end;
$function$;

create or replace function public.revoke_reward(p_grant_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  g record;
  clean_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
begin
  if caller is null or caller_org is null or not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_reason) not between 1 and 500 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select id, user_id, item_key, status into g
  from public.member_reward_grants
  where id = p_grant_id
    and organization_id = caller_org
    and status <> 'revoked';
  if not found or not private.can_administer_reward_member(g.user_id) then
    raise exception 'grant not found' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || caller_org::text, 509));
  if caller_org is distinct from private.current_member_organization() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select id, user_id, item_key, status into g
  from public.member_reward_grants
  where id = p_grant_id
    and organization_id = caller_org
    and status <> 'revoked'
  for update;
  if not found or not private.can_administer_reward_member(g.user_id) then
    raise exception 'grant not found' using errcode = '22023';
  end if;
  update public.member_reward_grants
  set status = 'revoked', revoked_by = caller, revoked_at = pg_catalog.now(),
      revoke_reason = clean_reason, updated_at = pg_catalog.now()
  where id = g.id and organization_id = caller_org;
  insert into public.member_admin_audit (actor, action, target_user, detail, organization_id)
  values (caller, 'revoke_reward', g.user_id,
    pg_catalog.jsonb_build_object('item', g.item_key, 'grantId', g.id, 'reason', clean_reason),
    caller_org);
  return pg_catalog.jsonb_build_object('grantId', g.id, 'status', 'revoked');
end;
$function$;

create or replace function public.fulfill_reward_without_evidence_legacy(p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  g record;
  nxt text;
begin
  if caller is null or caller_org is null or not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select gr.id, gr.user_id, gr.item_key, gr.status, it.fulfillment into g
  from public.member_reward_grants gr
  join public.member_reward_items it on it.key = gr.item_key
  where gr.id = p_grant_id and gr.organization_id = caller_org;
  if not found or not private.can_administer_reward_member(g.user_id) then
    raise exception 'grant not found' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || caller_org::text, 509));
  if caller_org is distinct from private.current_member_organization() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select gr.id, gr.user_id, gr.item_key, gr.status, it.fulfillment into g
  from public.member_reward_grants gr
  join public.member_reward_items it on it.key = gr.item_key
  where gr.id = p_grant_id and gr.organization_id = caller_org
  for update of gr;
  if not found or not private.can_administer_reward_member(g.user_id) then
    raise exception 'grant not found' using errcode = '22023';
  end if;
  nxt := case
    when g.fulfillment = 'ship' and g.status in ('claimed', 'granted') then 'shipped'
    when g.fulfillment = 'ship' and g.status = 'shipped' then 'delivered'
    when g.fulfillment in ('instant', 'event') and g.status in ('claimed', 'granted') then 'delivered'
    else null
  end;
  if nxt is null then
    raise exception 'grant is not advanceable' using errcode = '22023';
  end if;
  update public.member_reward_grants
  set status = nxt, updated_at = pg_catalog.now()
  where id = g.id and organization_id = caller_org;
  insert into public.member_admin_audit (actor, action, target_user, detail, organization_id)
  values (caller, 'fulfill_reward', g.user_id,
    pg_catalog.jsonb_build_object('item', g.item_key, 'grantId', g.id, 'to', nxt), caller_org);
  return pg_catalog.jsonb_build_object('grantId', g.id, 'status', nxt);
end;
$function$;

create or replace function public.fulfill_reward(
  p_grant_id uuid,
  p_carrier text default null,
  p_tracking_number text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller_org uuid := private.current_member_organization();
  g record;
  clean_carrier text := nullif(pg_catalog.btrim(coalesce(p_carrier, '')), '');
  clean_tracking text := nullif(pg_catalog.btrim(coalesce(p_tracking_number, '')), '');
  result jsonb;
begin
  if (select auth.uid()) is null or caller_org is null or not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select gr.id, gr.user_id, gr.status, gr.shipping_address, i.fulfillment into g
  from public.member_reward_grants gr
  join public.member_reward_items i on i.key = gr.item_key
  where gr.id = p_grant_id and gr.organization_id = caller_org;
  if not found or not private.can_administer_reward_member(g.user_id) then
    raise exception 'grant not found' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || caller_org::text, 509));
  if caller_org is distinct from private.current_member_organization() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select gr.id, gr.user_id, gr.status, gr.shipping_address, i.fulfillment into g
  from public.member_reward_grants gr
  join public.member_reward_items i on i.key = gr.item_key
  where gr.id = p_grant_id and gr.organization_id = caller_org
  for update of gr;
  if not found or not private.can_administer_reward_member(g.user_id) then
    raise exception 'grant not found' using errcode = '22023';
  end if;
  if g.fulfillment = 'ship' and g.status in ('claimed', 'granted') then
    if g.shipping_address is null then
      raise exception 'shipping address is required' using errcode = '22023';
    end if;
    if clean_carrier is null or pg_catalog.char_length(clean_carrier) > 100
       or clean_tracking is null or pg_catalog.char_length(clean_tracking) not between 3 and 200 then
      raise exception 'carrier and tracking are required' using errcode = '22023';
    end if;
  elsif clean_carrier is not null or clean_tracking is not null then
    raise exception 'shipping evidence is not accepted for this transition' using errcode = '22023';
  end if;

  result := public.fulfill_reward_without_evidence_legacy(p_grant_id);
  if result ->> 'status' = 'shipped' then
    update public.member_reward_grants
    set shipping_carrier = clean_carrier,
        tracking_number = clean_tracking,
        shipped_at = pg_catalog.now()
    where id = p_grant_id and organization_id = caller_org;
  elsif result ->> 'status' = 'delivered' then
    update public.member_reward_grants
    set delivered_at = pg_catalog.now()
    where id = p_grant_id and organization_id = caller_org;
  end if;
  return result || pg_catalog.jsonb_build_object(
    'shippingCarrier', clean_carrier,
    'trackingNumber', clean_tracking
  );
end;
$function$;

create or replace function public.get_admin_reward_queue_without_shipping_legacy()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  org_admin boolean := private.has_organization_role(caller_org, array['admin']);
begin
  if caller is null or caller_org is null or not private.mfa_satisfied()
     or not (
       org_admin
       or private.member_has_chapter_role(caller_chapter, array['admin'])
     ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', g.id,
      'memberName', coalesce(p.full_name, 'Member'),
      'itemKey', g.item_key,
      'labelEn', it.label_en,
      'labelEs', it.label_es,
      'fulfillment', it.fulfillment,
      'status', g.status,
      'source', g.source,
      'reason', g.reason,
      'note', g.note,
      'createdAt', g.created_at
    ) order by g.created_at desc, g.id)
    from (
      select scoped.*
      from public.member_reward_grants scoped
      where scoped.organization_id = caller_org
        and (
          org_admin
          or exists (
            select 1
            from public.member_chapter_memberships cm
            where cm.user_id = scoped.user_id
              and cm.chapter_id = caller_chapter
              and cm.status = 'active'
          )
        )
      order by scoped.created_at desc, scoped.id
      limit 200
    ) g
    join public.member_reward_items it on it.key = g.item_key
    left join public.member_profiles p on p.id = g.user_id
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.get_admin_reward_queue()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(row.value || pg_catalog.jsonb_build_object(
    'shippingAddress', g.shipping_address,
    'shippingCarrier', g.shipping_carrier,
    'trackingNumber', g.tracking_number,
    'shippedAt', g.shipped_at,
    'deliveredAt', g.delivered_at
  ) order by row.ordinality), '[]'::jsonb)
  from pg_catalog.jsonb_array_elements(public.get_admin_reward_queue_without_shipping_legacy())
    with ordinality row(value, ordinality)
  join public.member_reward_grants g
    on g.id = (row.value ->> 'id')::uuid
   and g.organization_id = private.current_member_organization();
$function$;

create or replace function private.member_reward_effect_enabled(
  p_user_id uuid,
  p_effect_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.member_reward_grants g
    join public.member_reward_items i on i.key = g.item_key
    join public.organization_memberships om
      on om.organization_id = g.organization_id
     and om.user_id = g.user_id
     and om.status = 'active'
    where g.user_id = p_user_id
      and g.organization_id is not null
      and g.organization_id = private.current_member_organization()
      and g.item_key = p_effect_key
      and g.status in ('granted', 'shipped', 'delivered')
      and i.active
  );
$function$;

create or replace function public.get_member_reward_effects()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
begin
  if caller is null or caller_org is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'key', i.key,
      'kind', i.effect_kind,
      'config', i.effect_config,
      'status', g.status
    ) order by i.sort, i.key)
    from public.member_reward_grants g
    join public.member_reward_items i on i.key = g.item_key
    where g.user_id = caller
      and g.organization_id = caller_org
      and g.status in ('granted', 'shipped', 'delivered')
      and i.active
  ), '[]'::jsonb);
end;
$function$;

drop policy member_reward_grants_select_own on public.member_reward_grants;
create policy member_reward_grants_select_own on public.member_reward_grants
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and organization_id is not null
    and organization_id = private.current_member_organization()
    and private.is_organization_member(organization_id)
  );

revoke all on function public.claim_reward_without_shipping_legacy(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.fulfill_reward_without_evidence_legacy(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_admin_reward_queue_without_shipping_legacy()
  from public, anon, authenticated, service_role;
revoke all on function private.member_reward_effect_enabled(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function private.member_reward_effect_enabled(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Invitation administration composes organization and chapter authority
-- ---------------------------------------------------------------------------
create function private.require_member_invitation_admin_chapter()
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  selected_chapter text := private.current_member_chapter();
  selected_org uuid;
  locked_chapter text;
  locked_org uuid;
begin
  select c.organization_id into selected_org
  from public.chapters c
  where c.id = selected_chapter;
  if caller is null
     or selected_chapter is null
     or selected_org is null
     or not private.member_has_chapter_role(selected_chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || selected_org::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));

  select p.chapter_id, c.organization_id into locked_chapter, locked_org
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  where p.id = caller;
  if locked_chapter is distinct from selected_chapter
     or locked_org is distinct from selected_org
     or not private.member_has_chapter_role(locked_chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  return locked_chapter;
end;
$function$;

revoke all on function private.require_member_invitation_admin_chapter()
  from public, anon, authenticated, service_role;

create or replace function public.create_member_invitation(
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
  caller_chapter text := private.require_member_invitation_admin_chapter();
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
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
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

create or replace function public.resend_member_invitation(p_invitation_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_admin_chapter();
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  old_row public.member_invitations%rowtype;
  new_row public.member_invitations%rowtype;
begin
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
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

create or replace function public.revoke_member_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_admin_chapter();
  invitation_row public.member_invitations%rowtype;
begin
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
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

create or replace function public.record_member_invitation_delivery(
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
  caller_chapter text := private.require_member_invitation_admin_chapter();
  invitation_row public.member_invitations%rowtype;
begin
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
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

create or replace function public.get_member_invitations(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_admin_chapter();
  cap integer := greatest(1, least(coalesce(p_limit, 50), 100));
  chapter_name text;
begin
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
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

-- ---------------------------------------------------------------------------
-- 12. Legacy staff readers project roles only inside the selected tenant
-- ---------------------------------------------------------------------------

create function private.organization_member_roles(
  p_user_id uuid,
  p_organization_id uuid,
  p_chapter_id text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(scoped.role order by scoped.role), '[]'::jsonb)
  from (
    select g.role
    from public.organization_role_grants g
    join public.organization_memberships om
      on om.organization_id = g.organization_id
     and om.user_id = g.user_id
     and om.status = 'active'
    where g.user_id = p_user_id
      and g.organization_id = p_organization_id
    union
    select rc.role
    from public.member_role_chapters rc
    join public.chapters c
      on c.id = rc.chapter_id
     and c.organization_id = p_organization_id
    join public.member_chapter_memberships cm
      on cm.user_id = rc.user_id
     and cm.chapter_id = rc.chapter_id
     and cm.status = 'active'
    join public.organization_memberships om
      on om.user_id = rc.user_id
     and om.organization_id = p_organization_id
     and om.status = 'active'
    where rc.user_id = p_user_id
      and (p_chapter_id is null or rc.chapter_id = p_chapter_id)
  ) scoped;
$function$;

revoke all on function private.organization_member_roles(uuid, uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.get_admin_member_directory(
  p_query text default null,
  p_after_name text default null,
  p_after_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  org_admin boolean := private.has_organization_role(caller_org, array['admin']);
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
  cap integer := coalesce(p_limit, 25);
  result jsonb;
begin
  if caller is null or caller_org is null or caller_chapter is null
     or not (org_admin or private.member_has_chapter_role(caller_chapter, array['admin'])) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if cap < 1 or cap > 50 then
    raise exception 'limit out of range' using errcode = '22023';
  end if;
  if (p_after_name is null and p_after_id is not null)
     or (p_after_name is not null and p_after_id is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;
  if needle <> '' and pg_catalog.char_length(needle) < 2 then
    raise exception 'query too short' using errcode = '22023';
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
    needle, '\', '\\'), '%', '\%'), '_', '\_');

  with candidates as materialized (
    select p.id, p.full_name, p.initials,
      p.member_since::integer as member_since_year,
      located.chapter_id, located.chapter_name,
      private.organization_member_roles(
        p.id, caller_org, case when org_admin then null else caller_chapter end
      ) as roles
    from public.member_profiles p
    join public.organization_memberships om
      on om.user_id = p.id
     and om.organization_id = caller_org
     and om.status = 'active'
    join lateral (
      select c.id as chapter_id, c.name as chapter_name
      from public.member_chapter_memberships cm
      join public.chapters c
        on c.id = cm.chapter_id
       and c.organization_id = caller_org
      where cm.user_id = p.id
        and cm.status = 'active'
        and (org_admin or c.id = caller_chapter)
      order by (c.id = p.chapter_id) desc, c.order_index, c.id
      limit 1
    ) located on true
    where (needle = '' or p.full_name ilike '%' || needle || '%' escape '\')
      and (p_after_name is null or (p.full_name, p.id) > (p_after_name, p_after_id))
    order by p.full_name, p.id
    limit cap + 1
  ), page as (
    select * from candidates order by full_name, id limit cap
  )
  select pg_catalog.jsonb_build_object(
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'userId', s.id,
        'fullName', s.full_name,
        'initials', s.initials,
        'memberSince', s.member_since_year,
        'chapterId', s.chapter_id,
        'chapterName', s.chapter_name,
        'roles', s.roles
      ) order by s.full_name, s.id)
      from page s
    ), '[]'::jsonb),
    'nextCursor', case when (select pg_catalog.count(*) from candidates) > cap then (
      select pg_catalog.jsonb_build_object('name', s.full_name, 'id', s.id)
      from page s order by s.full_name desc, s.id desc limit 1
    ) else null end
  ) into result;
  return result;
end;
$function$;

create or replace function public.admin_search_members(p_query text)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  org_admin boolean := private.has_organization_role(caller_org, array['admin']);
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
begin
  if caller is null or caller_org is null or caller_chapter is null
     or not (org_admin or private.member_has_chapter_role(caller_chapter, array['admin'])) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(needle) < 2 then
    raise exception 'query too short' using errcode = '22023';
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
    needle, '\', '\\'), '%', '\%'), '_', '\_');
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', s.id,
      'fullName', s.full_name,
      'initials', s.initials,
      'memberSince', s.member_since,
      'chapterId', s.chapter_id,
      'chapterName', s.chapter_name,
      'roles', s.roles
    ) order by s.full_name, s.id)
    from (
      select p.id, p.full_name, p.initials, p.member_since,
        located.chapter_id, located.chapter_name,
        private.organization_member_roles(
          p.id, caller_org, case when org_admin then null else caller_chapter end
        ) as roles
      from public.member_profiles p
      join public.organization_memberships om
        on om.user_id = p.id
       and om.organization_id = caller_org
       and om.status = 'active'
      join lateral (
        select c.id as chapter_id, c.name as chapter_name
        from public.member_chapter_memberships cm
        join public.chapters c
          on c.id = cm.chapter_id
         and c.organization_id = caller_org
        where cm.user_id = p.id
          and cm.status = 'active'
          and (org_admin or c.id = caller_chapter)
        order by (c.id = p.chapter_id) desc, c.order_index, c.id
        limit 1
      ) located on true
      where p.full_name ilike '%' || needle || '%' escape '\'
      order by p.full_name, p.id
      limit 20
    ) s
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.get_staff_roster()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  caller_org_wide boolean := private.has_organization_role(
    caller_org, array['admin', 'coordinator', 'advisor', 'vp']
  );
begin
  if caller is null or caller_org is null or caller_chapter is null
     or not (
       caller_org_wide
       or private.member_has_chapter_role(
         caller_chapter, array['admin', 'coordinator', 'advisor', 'vp']
       )
     ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', s.id,
      'fullName', s.full_name,
      'initials', s.initials,
      'memberSince', s.member_since,
      'chapterId', s.chapter_id,
      'chapterName', s.chapter_name,
      'roles', s.roles
    ) order by s.full_name, s.id)
    from (
      select p.id, p.full_name, p.initials, p.member_since,
        located.chapter_id, located.chapter_name,
        private.organization_member_roles(
          p.id, caller_org, case when caller_org_wide then null else caller_chapter end
        ) as roles
      from public.member_profiles p
      join public.organization_memberships om
        on om.user_id = p.id
       and om.organization_id = caller_org
       and om.status = 'active'
      join lateral (
        select c.id as chapter_id, c.name as chapter_name
        from public.member_chapter_memberships cm
        join public.chapters c
          on c.id = cm.chapter_id
         and c.organization_id = caller_org
        where cm.user_id = p.id
          and cm.status = 'active'
          and (caller_org_wide or c.id = caller_chapter)
        order by (c.id = p.chapter_id) desc, c.order_index, c.id
        limit 1
      ) located on true
      where private.organization_member_roles(
        p.id, caller_org, case when caller_org_wide then null else caller_chapter end
      ) <> '[]'::jsonb
      order by p.full_name, p.id
      limit 200
    ) s
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.get_admin_org_structure()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  org_admin boolean := private.has_organization_role(caller_org, array['admin']);
  chapters_json jsonb;
begin
  if caller is null or caller_org is null or caller_chapter is null
     or not (org_admin or private.member_has_chapter_role(caller_chapter, array['admin'])) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', scoped.id,
    'name', scoped.name,
    'region', scoped.region,
    'isDefault', scoped.is_default,
    'orderIndex', scoped.order_index,
    'memberCount', scoped.member_count,
    'staffCount', scoped.staff_count,
    'roleCounts', scoped.role_counts
  ) order by scoped.order_index, scoped.name, scoped.id), '[]'::jsonb)
  into chapters_json
  from (
    select c.*,
      (
        select pg_catalog.count(distinct cm.user_id)::integer
        from public.member_chapter_memberships cm
        join public.organization_memberships om
          on om.user_id = cm.user_id
         and om.organization_id = caller_org
         and om.status = 'active'
        where cm.chapter_id = c.id and cm.status = 'active'
      ) as member_count,
      (
        select pg_catalog.count(distinct cm.user_id)::integer
        from public.member_chapter_memberships cm
        join public.organization_memberships om
          on om.user_id = cm.user_id
         and om.organization_id = caller_org
         and om.status = 'active'
        where cm.chapter_id = c.id
          and cm.status = 'active'
          and private.organization_member_roles(cm.user_id, caller_org, c.id) <> '[]'::jsonb
      ) as staff_count,
      pg_catalog.jsonb_build_object(
        'steward', (
          select pg_catalog.count(distinct cm.user_id)::integer
          from public.member_chapter_memberships cm
          where cm.chapter_id = c.id and cm.status = 'active'
            and private.organization_member_roles(cm.user_id, caller_org, c.id) ? 'steward'
        ),
        'coordinator', (
          select pg_catalog.count(distinct cm.user_id)::integer
          from public.member_chapter_memberships cm
          where cm.chapter_id = c.id and cm.status = 'active'
            and private.organization_member_roles(cm.user_id, caller_org, c.id) ? 'coordinator'
        ),
        'advisor', (
          select pg_catalog.count(distinct cm.user_id)::integer
          from public.member_chapter_memberships cm
          where cm.chapter_id = c.id and cm.status = 'active'
            and private.organization_member_roles(cm.user_id, caller_org, c.id) ? 'advisor'
        ),
        'admin', (
          select pg_catalog.count(distinct cm.user_id)::integer
          from public.member_chapter_memberships cm
          where cm.chapter_id = c.id and cm.status = 'active'
            and private.organization_member_roles(cm.user_id, caller_org, c.id) ? 'admin'
        ),
        'vp', (
          select pg_catalog.count(distinct cm.user_id)::integer
          from public.member_chapter_memberships cm
          where cm.chapter_id = c.id and cm.status = 'active'
            and private.organization_member_roles(cm.user_id, caller_org, c.id) ? 'vp'
        )
      ) as role_counts
    from public.chapters c
    where c.organization_id = caller_org
      and (org_admin or c.id = caller_chapter)
  ) scoped;

  return pg_catalog.jsonb_build_object(
    'scope', case when org_admin then 'organization' else 'chapter' end,
    'chapterId', case when org_admin then null else caller_chapter end,
    'canCreateChapter', org_admin,
    'chapters', chapters_json
  );
end;
$function$;

create or replace function public.get_admin_mfa_status()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  org_admin boolean := private.has_organization_role(caller_org, array['admin']);
begin
  if caller is null or caller_org is null or caller_chapter is null
     or not (org_admin or private.member_has_chapter_role(caller_chapter, array['admin'])) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'staff', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'userId', s.user_id,
        'fullName', s.full_name,
        'initials', s.initials,
        'roles', s.roles,
        'totpVerified', s.totp_verified,
        'verifiedAt', s.verified_at,
        'otherFactors', s.other_factors
      ) order by s.totp_verified, s.full_name, s.user_id)
      from (
        select p.id as user_id, p.full_name, p.initials,
          private.organization_member_roles(
            p.id, caller_org, case when org_admin then null else caller_chapter end
          ) as roles,
          exists (
            select 1 from auth.mfa_factors f
            where f.user_id = p.id and f.status = 'verified' and f.factor_type = 'totp'
          ) as totp_verified,
          (
            select pg_catalog.min(f.updated_at) from auth.mfa_factors f
            where f.user_id = p.id and f.status = 'verified' and f.factor_type = 'totp'
          ) as verified_at,
          (
            select pg_catalog.count(*) from auth.mfa_factors f
            where f.user_id = p.id and f.status = 'verified' and f.factor_type <> 'totp'
          )::integer as other_factors
        from public.member_profiles p
        join public.organization_memberships om
          on om.user_id = p.id
         and om.organization_id = caller_org
         and om.status = 'active'
        where exists (
          select 1
          from public.member_chapter_memberships cm
          join public.chapters c
            on c.id = cm.chapter_id and c.organization_id = caller_org
          where cm.user_id = p.id and cm.status = 'active'
            and (org_admin or c.id = caller_chapter)
        )
          and private.organization_member_roles(
            p.id, caller_org, case when org_admin then null else caller_chapter end
          ) <> '[]'::jsonb
      ) s
    ), '[]'::jsonb),
    'enrolledMembers', (
      select pg_catalog.count(distinct f.user_id)
      from auth.mfa_factors f
      join public.organization_memberships om
        on om.user_id = f.user_id
       and om.organization_id = caller_org
       and om.status = 'active'
      where f.status = 'verified' and f.factor_type = 'totp'
        and exists (
          select 1
          from public.member_chapter_memberships cm
          join public.chapters c
            on c.id = cm.chapter_id and c.organization_id = caller_org
          where cm.user_id = f.user_id and cm.status = 'active'
            and (org_admin or c.id = caller_chapter)
        )
    )
  );
end;
$function$;

revoke all on function public.get_admin_member_directory(text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_admin_member_directory(text, text, uuid, integer)
  to authenticated;
revoke all on function public.admin_search_members(text)
  from public, anon, authenticated;
grant execute on function public.admin_search_members(text)
  to authenticated;
revoke all on function public.get_staff_roster()
  from public, anon, authenticated;
grant execute on function public.get_staff_roster()
  to authenticated;
revoke all on function public.get_admin_org_structure()
  from public, anon, authenticated;
grant execute on function public.get_admin_org_structure()
  to authenticated;
revoke all on function public.get_admin_mfa_status()
  from public, anon, authenticated;
grant execute on function public.get_admin_mfa_status()
  to authenticated;


comment on function public.member_has_role(text[]) is
  'Legacy chapter/orphan staff assurance. Organization-wide grants use explicit tenant-aware helpers so deferred NULL-sentinel definers cannot turn a missing chapter-scoped role row into global authority.';

notify pgrst, 'reload schema';
