-- Union Ground ship-complete identity foundation.
--
-- New accounts are empty, provisioned identities. A person may belong to
-- several chapters, but exactly one authorized chapter is selected on the
-- existing member_profiles.chapter_id projection at a time. Keeping that
-- projection lets every existing chapter-scoped policy continue to fail
-- closed while the new membership rows carry pins, recency, and per-chapter
-- role scope.

set local lock_timeout = '5s';

create table public.member_chapter_memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  status text not null default 'active' check (status in ('active', 'revoked')),
  pinned boolean not null default false,
  last_selected_at timestamptz,
  joined_at timestamptz not null default pg_catalog.now(),
  revoked_at timestamptz,
  primary key (user_id, chapter_id),
  constraint member_chapter_memberships_revocation_complete check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create index member_chapter_memberships_user_recent_idx
  on public.member_chapter_memberships (user_id, last_selected_at desc nulls last, chapter_id)
  where status = 'active';

create table public.member_role_chapters (
  user_id uuid not null,
  role text not null check (role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  granted_at timestamptz not null default pg_catalog.now(),
  granted_by uuid references auth.users(id) on delete set null,
  primary key (user_id, role, chapter_id),
  foreign key (user_id, role) references public.member_roles(user_id, role) on delete cascade,
  foreign key (user_id, chapter_id) references public.member_chapter_memberships(user_id, chapter_id) on delete cascade
);

insert into public.member_chapter_memberships
  (user_id, chapter_id, status, last_selected_at, joined_at)
select p.id, p.chapter_id, 'active', pg_catalog.now(), p.created_at
from public.member_profiles p
where p.chapter_id is not null
on conflict (user_id, chapter_id) do nothing;

insert into public.member_role_chapters
  (user_id, role, chapter_id, granted_at, granted_by)
select r.user_id, r.role, r.chapter_id, r.granted_at, r.granted_by
from public.member_roles r
join public.member_chapter_memberships m
  on m.user_id = r.user_id and m.chapter_id = r.chapter_id
where r.chapter_id is not null
on conflict (user_id, role, chapter_id) do nothing;

alter table public.member_chapter_memberships enable row level security;
alter table public.member_role_chapters enable row level security;

create policy member_chapter_memberships_select_own
  on public.member_chapter_memberships for select to authenticated
  using (user_id = (select auth.uid()));

create policy member_role_chapters_select_own
  on public.member_role_chapters for select to authenticated
  using (user_id = (select auth.uid()));

create policy mfa_assurance on public.member_chapter_memberships
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy mfa_assurance on public.member_role_chapters
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on public.member_chapter_memberships from public, anon, authenticated;
revoke all on public.member_role_chapters from public, anon, authenticated;
grant select on public.member_chapter_memberships to authenticated;
grant select on public.member_role_chapters to authenticated;

-- A legacy NULL role remains organization-wide. Chapter roles are authorized
-- only when their explicit mapping matches the currently selected membership.
create or replace function public.member_has_role(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when not (select private.mfa_satisfied()) then false
    when not exists (
      select 1
      from public.member_roles r
      where r.user_id = (select auth.uid())
        and r.role = any(p_roles)
        and (
          r.chapter_id is null
          or exists (
            select 1
            from public.member_role_chapters rc
            join public.member_profiles p on p.id = rc.user_id
            join public.member_chapter_memberships m
              on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
            where rc.user_id = r.user_id
              and rc.role = r.role
              and rc.chapter_id = p.chapter_id
              and m.status = 'active'
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
  select exists (
    select 1
    from public.member_roles r
    join public.member_profiles target on target.id = p_target
    where r.user_id = (select auth.uid())
      and r.role = p_role
      and (
        r.chapter_id is null
        or exists (
          select 1 from public.member_role_chapters rc
          join public.member_chapter_memberships m
            on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
          where rc.user_id = r.user_id
            and rc.role = r.role
            and rc.chapter_id = target.chapter_id
            and m.status = 'active'
        )
      )
  );
$function$;

create function public.get_my_chapter_memberships()
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
      'roles', coalesce((
        select pg_catalog.jsonb_agg(rc.role order by rc.role)
        from public.member_role_chapters rc
        where rc.user_id = m.user_id and rc.chapter_id = m.chapter_id
      ), '[]'::jsonb)
    ) order by m.pinned desc, m.last_selected_at desc nulls last, c.name
  ), '[]'::jsonb)
  from public.member_profiles p
  join public.member_chapter_memberships m
    on m.user_id = p.id and m.status = 'active'
  join public.chapters c on c.id = m.chapter_id
  where p.id = (select auth.uid()) and private.mfa_satisfied();
$function$;

create function public.switch_my_chapter(p_chapter_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  target public.member_chapter_memberships%rowtype;
  chapter_name text;
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

  update public.member_profiles set chapter_id = target.chapter_id where id = caller;
  update public.member_chapter_memberships
  set last_selected_at = pg_catalog.clock_timestamp()
  where user_id = caller and chapter_id = target.chapter_id;
  select c.name into chapter_name from public.chapters c where c.id = target.chapter_id;

  return pg_catalog.jsonb_build_object(
    'chapterId', target.chapter_id,
    'name', chapter_name,
    'roles', coalesce((
      select pg_catalog.jsonb_agg(rc.role order by rc.role)
      from public.member_role_chapters rc
      where rc.user_id = caller and rc.chapter_id = target.chapter_id
    ), '[]'::jsonb)
  );
end;
$function$;

create function public.set_my_chapter_pin(p_chapter_id text, p_pinned boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  changed integer;
begin
  if caller is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  update public.member_chapter_memberships
  set pinned = coalesce(p_pinned, false)
  where user_id = caller and chapter_id = p_chapter_id and status = 'active';
  get diagnostics changed = row_count;
  if changed = 0 then raise exception 'chapter unavailable' using errcode = '42501'; end if;
  return pg_catalog.jsonb_build_object('chapterId', p_chapter_id, 'pinned', coalesce(p_pinned, false));
end;
$function$;

create function public.grant_member_chapter_membership(p_user_id uuid, p_chapter_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  org_admin boolean;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select exists (
    select 1 from public.member_roles r
    where r.user_id = caller and r.role = 'admin' and r.chapter_id is null
  ) into org_admin;
  if not org_admin and p_chapter_id is distinct from caller_chapter then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not exists (select 1 from public.member_profiles p where p.id = p_user_id)
     or not exists (select 1 from public.chapters c where c.id = p_chapter_id) then
    raise exception 'membership target unavailable' using errcode = '22023';
  end if;

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

create function public.revoke_member_chapter_membership(p_user_id uuid, p_chapter_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  org_admin boolean;
  replacement_chapter text;
  changed integer;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select exists (
    select 1 from public.member_roles r
    where r.user_id = caller and r.role = 'admin' and r.chapter_id is null
  ) into org_admin;
  if not org_admin and p_chapter_id is distinct from caller_chapter then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || p_user_id::text, 0));
  update public.member_chapter_memberships
  set status = 'revoked', revoked_at = pg_catalog.clock_timestamp(), pinned = false
  where user_id = p_user_id and chapter_id = p_chapter_id and status = 'active';
  get diagnostics changed = row_count;
  if changed = 0 then raise exception 'membership unavailable' using errcode = '22023'; end if;

  delete from public.member_role_chapters
  where user_id = p_user_id and chapter_id = p_chapter_id;
  delete from public.member_roles r
  where r.user_id = p_user_id and r.chapter_id is not null
    and not exists (
      select 1 from public.member_role_chapters rc
      where rc.user_id = r.user_id and rc.role = r.role
    );

  if exists (
    select 1 from public.member_profiles p
    where p.id = p_user_id and p.chapter_id = p_chapter_id
  ) then
    select m.chapter_id into replacement_chapter
    from public.member_chapter_memberships m
    where m.user_id = p_user_id and m.status = 'active'
    order by m.last_selected_at desc nulls last, m.joined_at, m.chapter_id
    limit 1;
    update public.member_profiles set chapter_id = replacement_chapter where id = p_user_id;
  end if;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, 'revoke_chapter_membership', p_user_id,
    pg_catalog.jsonb_build_object('chapterId', p_chapter_id, 'replacementChapterId', replacement_chapter));
  return pg_catalog.jsonb_build_object('userId', p_user_id, 'chapterId', p_chapter_id, 'active', false);
end;
$function$;

create function public.set_member_chapter_role(
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
  caller_chapter text := private.current_member_chapter();
  org_admin boolean;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('steward', 'coordinator', 'advisor', 'admin', 'vp') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  select exists (
    select 1 from public.member_roles r
    where r.user_id = caller and r.role = 'admin' and r.chapter_id is null
  ) into org_admin;
  if not org_admin and p_chapter_id is distinct from caller_chapter then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.member_chapter_memberships m
    where m.user_id = p_user_id and m.chapter_id = p_chapter_id and m.status = 'active'
  ) then
    raise exception 'active chapter membership required' using errcode = '22023';
  end if;

  if coalesce(p_enabled, false) then
    insert into public.member_roles (user_id, role, granted_by, chapter_id)
    values (p_user_id, p_role, caller, p_chapter_id)
    on conflict (user_id, role) do nothing;
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
    values (p_user_id, p_role, p_chapter_id, caller)
    on conflict (user_id, role, chapter_id) do nothing;
  else
    if p_role = 'admin' and p_user_id = caller and p_chapter_id = caller_chapter then
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

revoke all on function public.get_my_chapter_memberships() from public, anon;
revoke all on function public.switch_my_chapter(text) from public, anon;
revoke all on function public.set_my_chapter_pin(text, boolean) from public, anon;
grant execute on function public.get_my_chapter_memberships() to authenticated;
grant execute on function public.switch_my_chapter(text) to authenticated;
grant execute on function public.set_my_chapter_pin(text, boolean) to authenticated;
revoke all on function public.grant_member_chapter_membership(uuid, text) from public, anon;
revoke all on function public.revoke_member_chapter_membership(uuid, text) from public, anon;
revoke all on function public.set_member_chapter_role(uuid, text, text, boolean) from public, anon;
grant execute on function public.grant_member_chapter_membership(uuid, text) to authenticated;
grant execute on function public.revoke_member_chapter_membership(uuid, text) to authenticated;
grant execute on function public.set_member_chapter_role(uuid, text, text, boolean) to authenticated;

-- New Auth identities receive only their provisioned profile and the matching
-- chapter membership. No cases, messages, alerts, rights progress, or action
-- rows are invented for a real person.
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
begin
  if member_chapter is not null
     and not exists (select 1 from public.chapters where id = member_chapter) then
    member_chapter := null;
  end if;

  insert into public.member_profiles (id, first_name, full_name, initials, chapter_id)
  values (new.id, member_first, member_full, member_initials, member_chapter);

  if member_chapter is not null then
    insert into public.member_chapter_memberships
      (user_id, chapter_id, status, last_selected_at)
    values (new.id, member_chapter, 'active', pg_catalog.now());
  end if;
  return new;
end;
$function$;

revoke all on function private.handle_new_member() from public, anon, authenticated;

notify pgrst, 'reload schema';
