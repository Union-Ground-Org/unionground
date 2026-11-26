-- REQ-UG-FULL-DEPTH-20260723 PR4b: admin role management + audit.
-- member_roles keeps ZERO client write path (test-pinned since the steward
-- migration): every grant/revoke goes through an admin-gated SECURITY DEFINER
-- RPC that stamps granted_by and writes an audit row. The audit table is
-- admin-readable only and has no client write path either — rows exist only
-- because a definer RPC wrote them.
--
-- Bootstrap note: member_roles is EMPTY on live today. The FIRST admin must be
-- provisioned by service-role SQL out-of-band (there is deliberately no
-- self-serve path to the first admin), after the client bundle for this PR is
-- deployed and browser-verified (the PR4a rollout-order contract).

-- 1. Audit trail. actor/target stay useful after user deletion via the
--    jsonb detail written at action time.
create table public.member_admin_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  actor uuid references auth.users(id) on delete set null,
  action text not null check (action in ('grant_role', 'revoke_role', 'create_event', 'update_event')),
  target_user uuid references auth.users(id) on delete set null,
  detail jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(detail) = 'object' and pg_catalog.length(detail::text) <= 2000),
  created_at timestamptz not null default now()
);

create index member_admin_audit_created_idx on public.member_admin_audit (created_at desc);

alter table public.member_admin_audit enable row level security;

create policy member_admin_audit_select_admin on public.member_admin_audit
  for select to authenticated using (public.member_has_role(array['admin']));

revoke all on public.member_admin_audit from anon, authenticated;
grant select on public.member_admin_audit to authenticated;

-- 2. Grant a staff role. In-body allow-list is defence-in-depth over the
--    member_roles CHECK: a future CHECK widening cannot silently make a new
--    slug grantable here. Optional chapter scope must be a real chapter.
create function public.grant_member_role(p_user_id uuid, p_role text, p_chapter_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  inserted integer;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('steward', 'coordinator', 'advisor', 'admin', 'vp') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  if not exists (select 1 from public.member_profiles where id = p_user_id) then
    raise exception 'unknown member' using errcode = '22023';
  end if;
  if p_chapter_id is not null
     and not exists (select 1 from public.chapters where id = p_chapter_id) then
    raise exception 'unknown chapter' using errcode = '22023';
  end if;

  insert into public.member_roles (user_id, role, granted_by, chapter_id)
  values (p_user_id, p_role, caller, p_chapter_id)
  on conflict (user_id, role) do nothing;
  get diagnostics inserted = row_count;

  -- Audit only effective changes: a conflict no-op (role already held) must
  -- not leave a row the trail would read as a real grant.
  if inserted > 0 then
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'grant_role', p_user_id,
            pg_catalog.jsonb_build_object('role', p_role, 'chapterId', p_chapter_id));
  end if;

  return pg_catalog.jsonb_build_object(
    'userId', p_user_id, 'role', p_role, 'granted', inserted > 0);
end;
$$;

revoke all on function public.grant_member_role(uuid, text, text) from public, anon;
grant execute on function public.grant_member_role(uuid, text, text) to authenticated;

-- 3. Revoke a staff role. The last-admin guard runs under an advisory lock so
--    two admins revoking each other concurrently cannot both pass the count
--    and orphan role management (recoverable only by service-role SQL).
create function public.revoke_member_role(p_user_id uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  removed integer;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('steward', 'coordinator', 'advisor', 'admin', 'vp') then
    raise exception 'unknown role' using errcode = '22023';
  end if;

  if p_role = 'admin' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member_roles:admin'));
    if exists (select 1 from public.member_roles where user_id = p_user_id and role = 'admin')
       and (select pg_catalog.count(*) from public.member_roles where role = 'admin') <= 1 then
      raise exception 'cannot remove the last admin' using errcode = '22023';
    end if;
  end if;

  delete from public.member_roles where user_id = p_user_id and role = p_role;
  get diagnostics removed = row_count;

  -- Audit only effective changes (see grant_member_role).
  if removed > 0 then
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'revoke_role', p_user_id, pg_catalog.jsonb_build_object('role', p_role));
  end if;

  return pg_catalog.jsonb_build_object(
    'userId', p_user_id, 'role', p_role, 'revoked', removed > 0);
end;
$$;

revoke all on function public.revoke_member_role(uuid, text) from public, anon;
grant execute on function public.revoke_member_role(uuid, text) to authenticated;

-- 4. Member search for the grant flow. Name-only (never touches an email
--    column) so it cannot be used as an email-enumeration oracle; short
--    queries are rejected so it cannot be used to page the whole roster.
create function public.admin_search_members(p_query text)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(needle) < 2 then
    raise exception 'query too short' using errcode = '22023';
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(needle, '\', '\\'), '%', '\%'), '_', '\_');

  -- The roles subselect lives OUTSIDE the LIMIT so it runs only for the 20
  -- surviving rows — inside the inner query it would execute once per ilike
  -- match (~100k probes on a broad needle over live data). memberSince is the
  -- disambiguator for same-named members in the grant flow.
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', s.id,
      'fullName', s.full_name,
      'initials', s.initials,
      'memberSince', s.member_since,
      'roles', coalesce((select pg_catalog.jsonb_agg(r.role order by r.role)
                         from public.member_roles r where r.user_id = s.id), '[]'::jsonb))
      order by s.full_name, s.id)
    from (
      select p.id, p.full_name, p.initials, p.member_since
      from public.member_profiles p
      where p.full_name ilike '%' || needle || '%'
      order by p.full_name, p.id
      limit 20
    ) s
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_search_members(text) from public, anon;
grant execute on function public.admin_search_members(text) to authenticated;

-- 5. Audit reader. Names resolve at read time; deleted members fall back to
--    the role/event detail captured at write time.
create function public.get_admin_audit(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  -- GREATEST/LEAST are grammar constructs (like COALESCE), not pg_catalog
  -- functions — schema-qualifying them raises 42883 at runtime under the
  -- empty search_path. Unqualified is the safe form.
  cap integer := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  if caller is null or not public.member_has_role(array['admin']) then
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
      order by m.created_at desc, m.id
      limit cap
    ) s
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_admin_audit(integer) from public, anon;
grant execute on function public.get_admin_audit(integer) to authenticated;
