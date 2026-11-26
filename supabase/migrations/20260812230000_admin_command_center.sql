-- UB-DESK-03: restore the backed admin command center.
--
-- This migration adds two privacy-minimal readers and two audited chapter
-- mutations, then aligns the legacy member-search/role paths with the live
-- admin role's chapter scope. NULL admin chapter_id remains the explicit
-- organization-wide sentinel. No client receives direct chapter or role DML.

-- Keep the immutable audit vocabulary closed while preserving every action
-- introduced by earlier migrations. The two new actions contain a chapter id
-- and changed field names only, never member data or free-form chapter values.
alter table public.member_admin_audit
  drop constraint if exists member_admin_audit_action_check;
alter table public.member_admin_audit
  add constraint member_admin_audit_action_check
  check (action in (
    'grant_role', 'revoke_role',
    'create_event', 'update_event', 'cancel_event', 'restore_event', 'delete_event',
    'reset_mfa',
    'claim_reward', 'grant_reward', 'revoke_reward', 'fulfill_reward',
    'set_staff_mfa_policy',
    'set_compass_ai_enabled', 'set_compass_ai_role_limit', 'attest_compass_ai_provider',
    'create_campaign', 'update_campaign_draft', 'publish_campaign', 'close_campaign',
    'recover_signin_address', 'recover_signin_address_failed',
    'review_email_intake',
    'create_chapter', 'update_chapter'
  ));

-- Name is optional: an empty needle browses the authorized directory. Paging
-- uses the same deterministic (full_name,id) order returned to the client.
-- The response intentionally contains no contact or workflow data.
create function public.get_admin_member_directory(
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
as $$
declare
  caller uuid := (select auth.uid());
  caller_admin_chapter text;
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
  cap integer := coalesce(p_limit, 25);
  result jsonb;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select r.chapter_id into caller_admin_chapter
  from public.member_roles r
  where r.user_id = caller and r.role = 'admin';

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
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(needle, '\', '\\'), '%', '\%'), '_', '\_');

  with candidates as materialized (
    select p.id, p.full_name, p.initials,
           p.member_since::integer as member_since_year,
           p.chapter_id, c.name as chapter_name,
           coalesce((
             select pg_catalog.jsonb_agg(r.role order by r.role)
             from public.member_roles r where r.user_id = p.id
           ), '[]'::jsonb) as roles
    from public.member_profiles p
    left join public.chapters c on c.id = p.chapter_id
    where (caller_admin_chapter is null or p.chapter_id = caller_admin_chapter)
      and (needle = '' or p.full_name ilike '%' || needle || '%' escape '\')
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
      ) order by s.full_name, s.id) from page s
    ), '[]'::jsonb),
    'nextCursor', case when (select pg_catalog.count(*) from candidates) > cap then (
      select pg_catalog.jsonb_build_object('name', s.full_name, 'id', s.id)
      from page s order by s.full_name desc, s.id desc limit 1
    ) else null end
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_admin_member_directory(text, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.get_admin_member_directory(text, text, uuid, integer) to authenticated;
comment on function public.get_admin_member_directory(text, text, uuid, integer) is
  'Admin-only privacy-minimal member directory. Empty query browses; optional name query and (full_name,id) keyset remain inside the live admin chapter scope.';

-- Current-data organization structure. Counts are aggregates over the live
-- tables, not copied organizational fiction.
create function public.get_admin_org_structure()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_admin_chapter text;
  chapters_json jsonb;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select r.chapter_id into caller_admin_chapter
  from public.member_roles r
  where r.user_id = caller and r.role = 'admin';

  with member_counts as (
    select p.chapter_id, pg_catalog.count(*)::integer as member_count
    from public.member_profiles p group by p.chapter_id
  ), staff_counts as (
    select p.chapter_id,
           pg_catalog.count(distinct r.user_id)::integer as staff_count,
           pg_catalog.jsonb_build_object(
             'steward', (pg_catalog.count(distinct r.user_id) filter (where r.role = 'steward'))::integer,
             'coordinator', (pg_catalog.count(distinct r.user_id) filter (where r.role = 'coordinator'))::integer,
             'advisor', (pg_catalog.count(distinct r.user_id) filter (where r.role = 'advisor'))::integer,
             'admin', (pg_catalog.count(distinct r.user_id) filter (where r.role = 'admin'))::integer,
             'vp', (pg_catalog.count(distinct r.user_id) filter (where r.role = 'vp'))::integer
           ) as role_counts
    from public.member_profiles p
    left join public.member_roles r on r.user_id = p.id
    group by p.chapter_id
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'region', c.region,
    'isDefault', c.is_default,
    'orderIndex', c.order_index,
    'memberCount', coalesce(m.member_count, 0),
    'staffCount', coalesce(s.staff_count, 0),
    'roleCounts', coalesce(s.role_counts, pg_catalog.jsonb_build_object(
      'steward', 0, 'coordinator', 0, 'advisor', 0, 'admin', 0, 'vp', 0
    ))
  ) order by c.order_index, c.name, c.id), '[]'::jsonb)
  into chapters_json
  from public.chapters c
  left join member_counts m on m.chapter_id = c.id
  left join staff_counts s on s.chapter_id = c.id
  where caller_admin_chapter is null or c.id = caller_admin_chapter;

  return pg_catalog.jsonb_build_object(
    'scope', case when caller_admin_chapter is null then 'organization' else 'chapter' end,
    'chapterId', caller_admin_chapter,
    'canCreateChapter', caller_admin_chapter is null,
    'chapters', chapters_json
  );
end;
$$;

revoke all on function public.get_admin_org_structure() from public, anon, authenticated;
grant execute on function public.get_admin_org_structure() to authenticated;
comment on function public.get_admin_org_structure() is
  'Admin-only current organization structure with chapter/member/staff aggregates restricted to the live admin role scope.';

create function public.create_admin_chapter(
  p_id text,
  p_name text,
  p_region text default null,
  p_order_index integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_admin_chapter text;
  clean_id text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_id, '')));
  clean_name text := pg_catalog.btrim(coalesce(p_name, ''));
  clean_region text := nullif(pg_catalog.btrim(coalesce(p_region, '')), '');
  clean_order integer;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select r.chapter_id into caller_admin_chapter
  from public.member_roles r
  where r.user_id = caller and r.role = 'admin'
  for key share;
  if not found then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if caller_admin_chapter is not null then
    raise exception 'organization admin required' using errcode = '42501';
  end if;

  if clean_id !~ '^[a-z0-9][a-z0-9-]{0,31}$'
     or pg_catalog.char_length(clean_name) < 2
     or pg_catalog.char_length(clean_name) > 120
     or clean_name ~ '[[:cntrl:]]'
     or (clean_region is not null and (pg_catalog.char_length(clean_region) > 120 or clean_region ~ '[[:cntrl:]]'))
     or (p_order_index is not null and (p_order_index < 1 or p_order_index > 10000)) then
    raise exception 'invalid chapter' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('chapters:admin'));
  if exists (select 1 from public.chapters c where c.id = clean_id or pg_catalog.lower(c.name) = pg_catalog.lower(clean_name)) then
    raise exception 'chapter already exists' using errcode = '23505';
  end if;
  clean_order := coalesce(p_order_index, (select coalesce(pg_catalog.max(c.order_index), 0) + 1 from public.chapters c));

  insert into public.chapters (id, name, region, is_default, order_index)
  values (clean_id, clean_name, clean_region, false, clean_order);
  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'create_chapter', pg_catalog.jsonb_build_object(
    'chapterId', clean_id, 'fields', pg_catalog.jsonb_build_array('name', 'region', 'orderIndex')));

  return pg_catalog.jsonb_build_object(
    'id', clean_id, 'name', clean_name, 'region', clean_region,
    'isDefault', false, 'orderIndex', clean_order, 'created', true);
end;
$$;

revoke all on function public.create_admin_chapter(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.create_admin_chapter(text, text, text, integer) to authenticated;
comment on function public.create_admin_chapter(text, text, text, integer) is
  'Organization-wide admin-only, audited creation of a non-default chapter. No delete or default-transfer companion exists.';

create function public.update_admin_chapter(
  p_chapter_id text,
  p_name text,
  p_region text default null,
  p_order_index integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_admin_chapter text;
  chapter_row record;
  clean_name text := pg_catalog.btrim(coalesce(p_name, ''));
  clean_region text := nullif(pg_catalog.btrim(coalesce(p_region, '')), '');
  clean_order integer := p_order_index;
  changed text[] := '{}'::text[];
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select r.chapter_id into caller_admin_chapter
  from public.member_roles r
  where r.user_id = caller and r.role = 'admin'
  for key share;
  if not found then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if caller_admin_chapter is not null and caller_admin_chapter <> p_chapter_id then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_name) < 2
     or pg_catalog.char_length(clean_name) > 120
     or clean_name ~ '[[:cntrl:]]'
     or (clean_region is not null and (pg_catalog.char_length(clean_region) > 120 or clean_region ~ '[[:cntrl:]]'))
     or clean_order is null or clean_order < 1 or clean_order > 10000 then
    raise exception 'invalid chapter' using errcode = '22023';
  end if;

  select c.* into chapter_row from public.chapters c where c.id = p_chapter_id for update;
  if not found then
    raise exception 'chapter unavailable' using errcode = '22023';
  end if;
  if caller_admin_chapter is not null and (
       clean_region is distinct from chapter_row.region
       or clean_order is distinct from chapter_row.order_index
     ) then
    raise exception 'organization admin required for chapter structure' using errcode = '42501';
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
$$;

revoke all on function public.update_admin_chapter(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.update_admin_chapter(text, text, text, integer) to authenticated;
comment on function public.update_admin_chapter(text, text, text, integer) is
  'Audited chapter metadata update restricted to the live admin scope. Chapter id and default status are immutable.';

-- Legacy role grant, now scope-aware. Scoped admins may grant only members in
-- their chapter and the stored role scope is forced to that chapter.
create or replace function public.grant_member_role(p_user_id uuid, p_role text, p_chapter_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_admin_chapter text;
  target_chapter text;
  effective_chapter text := p_chapter_id;
  inserted integer;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('steward', 'coordinator', 'advisor', 'admin', 'vp') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  select r.chapter_id into caller_admin_chapter from public.member_roles r
  where r.user_id = caller and r.role = 'admin'
  for key share;
  if not found then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into target_chapter from public.member_profiles p where p.id = p_user_id;
  if not found then raise exception 'unknown member' using errcode = '22023'; end if;
  if caller_admin_chapter is not null and target_chapter <> caller_admin_chapter then
    raise exception 'member outside admin scope' using errcode = '42501';
  end if;
  if p_chapter_id is not null and not exists (select 1 from public.chapters c where c.id = p_chapter_id) then
    raise exception 'unknown chapter' using errcode = '22023';
  end if;
  if caller_admin_chapter is not null then
    if p_chapter_id is not null and p_chapter_id <> caller_admin_chapter then
      raise exception 'chapter outside admin scope' using errcode = '42501';
    end if;
    effective_chapter := caller_admin_chapter;
  end if;

  insert into public.member_roles (user_id, role, granted_by, chapter_id)
  values (p_user_id, p_role, caller, effective_chapter)
  on conflict (user_id, role) do nothing;
  get diagnostics inserted = row_count;
  if inserted > 0 then
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'grant_role', p_user_id,
      pg_catalog.jsonb_build_object('role', p_role, 'chapterId', effective_chapter));
  end if;
  return pg_catalog.jsonb_build_object(
    'userId', p_user_id, 'role', p_role, 'chapterId', effective_chapter,
    'granted', inserted > 0);
end;
$$;

-- Legacy revoke, now target- and grant-scope aware. A chapter admin cannot
-- strip an organization-wide or foreign-chapter role from a guessed UUID.
create or replace function public.revoke_member_role(p_user_id uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_admin_chapter text;
  target_chapter text;
  role_row record;
  role_exists boolean := false;
  removed integer;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('steward', 'coordinator', 'advisor', 'admin', 'vp') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  select r.chapter_id into caller_admin_chapter from public.member_roles r
  where r.user_id = caller and r.role = 'admin'
  for key share;
  if not found then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into target_chapter from public.member_profiles p where p.id = p_user_id;
  if not found then raise exception 'unknown member' using errcode = '22023'; end if;
  if caller_admin_chapter is not null and target_chapter <> caller_admin_chapter then
    raise exception 'member outside admin scope' using errcode = '42501';
  end if;

  select r.chapter_id into role_row from public.member_roles r
  where r.user_id = p_user_id and r.role = p_role for update;
  role_exists := found;
  if caller_admin_chapter is not null and role_exists
     and role_row.chapter_id is distinct from caller_admin_chapter then
    raise exception 'role outside admin scope' using errcode = '42501';
  end if;

  if p_role = 'admin' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member_roles:admin'));
    if role_exists and role_row.chapter_id is null
       and (select pg_catalog.count(*) from public.member_roles r
            where r.role = 'admin' and r.chapter_id is null) <= 1 then
      raise exception 'cannot remove the last organization admin' using errcode = '22023';
    end if;
  end if;
  delete from public.member_roles where user_id = p_user_id and role = p_role;
  get diagnostics removed = row_count;
  if removed > 0 then
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'revoke_role', p_user_id,
      pg_catalog.jsonb_build_object('role', p_role, 'chapterId', role_row.chapter_id));
  end if;
  return pg_catalog.jsonb_build_object(
    'userId', p_user_id, 'role', p_role, 'revoked', removed > 0);
end;
$$;

-- Keep the legacy promote search name-only and bounded, but stop a scoped
-- admin from discovering another chapter's member through it.
create or replace function public.admin_search_members(p_query text)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_admin_chapter text;
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select r.chapter_id into caller_admin_chapter from public.member_roles r
  where r.user_id = caller and r.role = 'admin';
  if pg_catalog.char_length(needle) < 2 then
    raise exception 'query too short' using errcode = '22023';
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(needle, '\', '\\'), '%', '\%'), '_', '\_');

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', s.id, 'fullName', s.full_name, 'initials', s.initials,
      'memberSince', s.member_since, 'chapterId', s.chapter_id,
      'chapterName', s.chapter_name,
      'roles', coalesce((select pg_catalog.jsonb_agg(r.role order by r.role)
                         from public.member_roles r where r.user_id = s.id), '[]'::jsonb)
    ) order by s.full_name, s.id)
    from (
      select p.id, p.full_name, p.initials, p.member_since, p.chapter_id, c.name as chapter_name
      from public.member_profiles p
      left join public.chapters c on c.id = p.chapter_id
      where (caller_admin_chapter is null or p.chapter_id = caller_admin_chapter)
        and p.full_name ilike '%' || needle || '%' escape '\'
      order by p.full_name, p.id limit 20
    ) s
  ), '[]'::jsonb);
end;
$$;

-- Preserve the shared staff reader for non-admin hats, while restricting an
-- admin caller to the same live admin scope used by the write controls.
create or replace function public.get_staff_roster()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_is_admin boolean;
  caller_admin_chapter text;
begin
  if caller is null or not public.member_has_role(array['admin', 'coordinator', 'advisor', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_is_admin := public.member_has_role(array['admin']);
  if caller_is_admin then
    select r.chapter_id into caller_admin_chapter from public.member_roles r
    where r.user_id = caller and r.role = 'admin';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', s.id, 'fullName', s.full_name, 'initials', s.initials,
      'memberSince', s.member_since, 'chapterId', s.chapter_id,
      'chapterName', s.chapter_name, 'roles', s.roles
    ) order by s.full_name, s.id)
    from (
      select p.id, p.full_name, p.initials, p.member_since, p.chapter_id,
             c.name as chapter_name, pg_catalog.jsonb_agg(r.role order by r.role) as roles
      from public.member_roles r
      join public.member_profiles p on p.id = r.user_id
      left join public.chapters c on c.id = p.chapter_id
      where not caller_is_admin or caller_admin_chapter is null or p.chapter_id = caller_admin_chapter
      group by p.id, p.full_name, p.initials, p.member_since, p.chapter_id, c.name
      order by p.full_name, p.id limit 200
    ) s
  ), '[]'::jsonb);
end;
$$;

-- The MFA card is a roster too. Scoped admins get same-chapter staff plus a
-- same-chapter enrollment count; organization-wide admins keep the org count.
create or replace function public.get_admin_mfa_status()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_admin_chapter text;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select r.chapter_id into caller_admin_chapter from public.member_roles r
  where r.user_id = caller and r.role = 'admin';

  return pg_catalog.jsonb_build_object(
    'staff', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'userId', s.user_id, 'fullName', s.full_name, 'initials', s.initials,
        'roles', s.roles, 'totpVerified', s.totp_verified,
        'verifiedAt', s.verified_at, 'otherFactors', s.other_factors)
        order by s.totp_verified, s.full_name, s.user_id)
      from (
        select r.user_id, p.full_name, p.initials,
          coalesce((select pg_catalog.jsonb_agg(r2.role order by r2.role)
                    from public.member_roles r2 where r2.user_id = r.user_id), '[]'::jsonb) as roles,
          exists (select 1 from auth.mfa_factors f where f.user_id = r.user_id
                  and f.status = 'verified' and f.factor_type = 'totp') as totp_verified,
          (select pg_catalog.min(f.updated_at) from auth.mfa_factors f where f.user_id = r.user_id
           and f.status = 'verified' and f.factor_type = 'totp') as verified_at,
          (select pg_catalog.count(*) from auth.mfa_factors f where f.user_id = r.user_id
           and f.status = 'verified' and f.factor_type <> 'totp')::integer as other_factors
        from (select distinct user_id from public.member_roles) r
        join public.member_profiles p on p.id = r.user_id
        where caller_admin_chapter is null or p.chapter_id = caller_admin_chapter
      ) s
    ), '[]'::jsonb),
    'enrolledMembers', (
      select pg_catalog.count(distinct f.user_id)
      from auth.mfa_factors f
      join public.member_profiles p on p.id = f.user_id
      where f.status = 'verified' and f.factor_type = 'totp'
        and (caller_admin_chapter is null or p.chapter_id = caller_admin_chapter)
    )
  );
end;
$$;

-- Reassert executable grants after replacement; no table write grant widens.
revoke all on function public.grant_member_role(uuid, text, text) from public, anon;
grant execute on function public.grant_member_role(uuid, text, text) to authenticated;
revoke all on function public.revoke_member_role(uuid, text) from public, anon;
grant execute on function public.revoke_member_role(uuid, text) to authenticated;
revoke all on function public.admin_search_members(text) from public, anon;
grant execute on function public.admin_search_members(text) to authenticated;
revoke all on function public.get_staff_roster() from public, anon;
grant execute on function public.get_staff_roster() to authenticated;
revoke all on function public.get_admin_mfa_status() from public, anon;
grant execute on function public.get_admin_mfa_status() to authenticated;
