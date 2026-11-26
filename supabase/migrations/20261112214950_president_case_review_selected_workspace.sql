-- SEC-UG-PRESIDENT-CASE-REVIEW-USES-STALE-LEGACY-CHAPTER-20261111 (#8311).
--
-- public.member_roles keeps one legacy row per person and role, naming the
-- first chapter granted. The revoke paths deleted it only when the role was
-- gone from every chapter, so it went stale, and several SECURITY DEFINER
-- functions still read it as a source of authority:
--   * mark_vp_case_reviewed / list_vp_case_reviews took their chapter from it,
--     so a President removed from one chapter could still mark that chapter's
--     overdue cases reviewed (audit A2, section 2.3, suspect 3.1);
--   * intake owners, case-note mentions and the steward helpers tested "is
--     staff" on it with no chapter, or read "no chapter" as "every chapter"
--     (suspects 3.3, 3.4, 3.6).
-- The review functions now use the selected workspace, and marking matches
-- it against the case's stored chapter; the readers use
-- private.chapter_staff_roles (current chapter roles and organization grants,
-- active chapter and organization memberships only); and the revoke paths,
-- the learning period's take-back of a chapter and its undo of a chapter role
-- repoint or drop a legacy row whose chapter no longer holds the role. A retained steward row
-- with no chapter keeps its earlier organization-wide reach in
-- private.member_stewards_for_chapter (suspect 3.6 waits on the record's
-- operator read). Bodies below are the installed definitions with only those
-- lines changed.

begin;

create or replace function private.chapter_staff_roles(p_user_id uuid, p_chapter_id text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $function$
  -- Chapter roles count only while the person is also an active, unrevoked
  -- member of the chapter's organization (a chapter with no organization has
  -- none to check), as private.member_stewards_for_chapter required before.
  with tenant_member as (
    select 1
    from public.chapters c
    where c.id = p_chapter_id
      and (c.organization_id is null or exists (
        select 1 from public.organization_memberships om
        where om.organization_id = c.organization_id
          and om.user_id = p_user_id
          and om.status = 'active'
          and om.revoked_at is null))
  )
  select coalesce(array_agg(distinct scoped.role order by scoped.role), array[]::text[])
  from (
    select rc.role
    from public.member_role_chapters rc
    join public.member_chapter_memberships cm
      on cm.user_id = rc.user_id
     and cm.chapter_id = rc.chapter_id
     and cm.status = 'active'
    where rc.user_id = p_user_id
      and rc.chapter_id = p_chapter_id
      and exists (select 1 from tenant_member)
    union
    -- A legacy role row counts only for its own chapter, while the person is
    -- an active member there (never "no chapter" or another chapter).
    select r.role
    from public.member_roles r
    join public.member_chapter_memberships cm
      on cm.user_id = r.user_id
     and cm.chapter_id = r.chapter_id
     and cm.status = 'active'
    where r.user_id = p_user_id
      and r.chapter_id = p_chapter_id
      and exists (select 1 from tenant_member)
    union
    select g.role
    from public.organization_role_grants g
    join public.organization_memberships om
      on om.organization_id = g.organization_id
     and om.user_id = g.user_id
     and om.status = 'active'
     and om.revoked_at is null
    join public.chapters c
      on c.id = p_chapter_id
     and c.organization_id = g.organization_id
    join public.organizations o
      on o.id = g.organization_id
     and o.status = 'active'
    where g.user_id = p_user_id
  ) scoped
$function$;

revoke all on function private.chapter_staff_roles(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function private.reconcile_legacy_member_roles(
  p_user_id uuid, p_role text default null, p_organization_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
  update public.member_roles r
  set chapter_id = (
    select min(rc.chapter_id) from public.member_role_chapters rc
    where rc.user_id = r.user_id and rc.role = r.role
  )
  where r.user_id = p_user_id and r.chapter_id is not null
    and not exists (
      select 1 from public.member_role_chapters rc
      where rc.user_id = r.user_id and rc.role = r.role and rc.chapter_id = r.chapter_id
    )
    and exists (
      select 1 from public.member_role_chapters rc
      where rc.user_id = r.user_id and rc.role = r.role
    );
  -- The drop keeps each caller's original scope: one role, or one
  -- organization's chapters.
  delete from public.member_roles r
  where r.user_id = p_user_id and r.chapter_id is not null
    and (p_role is null or r.role = p_role)
    and (p_organization_id is null or exists (
      select 1 from public.chapters c
      where c.id = r.chapter_id and c.organization_id = p_organization_id
    ))
    and not exists (
      select 1 from public.member_role_chapters rc
      where rc.user_id = r.user_id and rc.role = r.role
    );
end;
$function$;

revoke all on function private.reconcile_legacy_member_roles(uuid, text, uuid)
  from public, anon, authenticated, service_role;

-- Repair rows that are already stale.
update public.member_roles r
set chapter_id = (
  select min(rc.chapter_id) from public.member_role_chapters rc
  where rc.user_id = r.user_id and rc.role = r.role
)
where r.chapter_id is not null
  and not exists (
    select 1 from public.member_role_chapters rc
    where rc.user_id = r.user_id and rc.role = r.role and rc.chapter_id = r.chapter_id
  )
  and exists (
    select 1 from public.member_role_chapters rc
    where rc.user_id = r.user_id and rc.role = r.role
  );

CREATE OR REPLACE FUNCTION private.member_stewards_for_chapter(p_chapter text)
 RETURNS TABLE(steward_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- #8311: stewards of this chapter now, not a legacy role row naming another
  -- chapter.
  select candidate.user_id
  from (
    select rc.user_id from public.member_role_chapters rc
    where rc.chapter_id = p_chapter and rc.role = 'steward'
    union
    select r.user_id from public.member_roles r
    where r.chapter_id = p_chapter and r.role = 'steward'
    union
    select g.user_id from public.organization_role_grants g
    join public.chapters c on c.id = p_chapter and c.organization_id = g.organization_id
    where g.role = 'steward'
  ) candidate
  where 'steward' = any(private.chapter_staff_roles(candidate.user_id, p_chapter))
  union
  -- A retained pre-guard steward row with no chapter keeps the reach
  -- 20260924170100 gave it (every chapter of an organization where the person
  -- is an active member), which the appointment and steward-contact proofs
  -- pin. Whether any such row remains is the record's operator read.
  select r.user_id
  from public.member_roles r
  join public.chapters c on c.id = p_chapter
  join public.organization_memberships membership
    on membership.organization_id = c.organization_id
   and membership.user_id = r.user_id
   and membership.status = 'active'
   and membership.revoked_at is null
  where r.role = 'steward'
    and r.chapter_id is null
$function$;

CREATE OR REPLACE FUNCTION private.notify_stewards_of_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  req_chapter text;
  r record;
begin
  begin
    select p.chapter_id into req_chapter
    from public.member_profiles p where p.id = new.user_id;

    for r in
      -- #8311: the request's chapter stewards, not legacy role rows.
      select steward.steward_id as user_id
      from private.member_stewards_for_chapter(req_chapter) steward
      where steward.steward_id <> new.user_id
    loop
      perform private.notify_member(r.user_id, 'steward.request.new', '{}'::jsonb, 'cases');
    end loop;
  exception
    when query_canceled then
      raise warning 'notify_stewards_of_request cancelled for request %', new.id;
    when others then
      raise warning 'notify_stewards_of_request failed for request %: % (%)',
        new.id, sqlerrm, sqlstate;
  end;

  return new;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.scim_revoke_organization_membership(p_organization_id uuid, p_user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
declare
  chapter_row record;
  replacement_chapter text;
  revoked_chapters integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || p_organization_id::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || p_user_id::text, 0));

  if not exists (
    select 1 from public.organization_memberships om
    where om.organization_id = p_organization_id and om.user_id = p_user_id
  ) then
    -- An unlinked address in another tenant grants no authority over its sessions.
    return 'not_member';
  end if;

  if exists (select 1 from public.organization_memberships m
       where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'active')
     and exists (
       select 1 from public.organization_role_grants g
       where g.organization_id = p_organization_id and g.user_id = p_user_id and g.role = 'admin'
     )
     and (
       select pg_catalog.count(*) from public.organization_role_grants g
       join public.organization_memberships m on m.organization_id = g.organization_id and m.user_id = g.user_id and m.status = 'active'
       where g.organization_id = p_organization_id and g.role = 'admin'
     ) <= 1 then
    return 'last_organization_admin';
  end if;

  for chapter_row in
    select m.chapter_id
    from public.member_chapter_memberships m
    join public.chapters c on c.id = m.chapter_id
    where m.user_id = p_user_id and m.status = 'active' and c.organization_id = p_organization_id
    order by m.chapter_id
  loop
    revoked_chapters := revoked_chapters + 1;
    update public.member_chapter_memberships
    set status = 'revoked', revoked_at = pg_catalog.clock_timestamp(), pinned = false
    where user_id = p_user_id and chapter_id = chapter_row.chapter_id and status = 'active';
    delete from public.member_role_chapters
    where user_id = p_user_id and chapter_id = chapter_row.chapter_id;
  end loop;

  -- #8311: drop or repoint a legacy role row whose chapter lost the role.
  perform private.reconcile_legacy_member_roles(p_user_id, null, p_organization_id);

  delete from public.organization_role_grants
  where organization_id = p_organization_id and user_id = p_user_id;
  delete from public.member_roles r
  where r.user_id = p_user_id and r.chapter_id is null
    and not exists (select 1 from public.organization_role_grants g
      join public.organization_memberships m on m.organization_id = g.organization_id and m.user_id = g.user_id and m.status = 'active'
      where g.user_id = r.user_id and g.role = r.role);

  -- Auth's own statement trigger takes its bookkeeping lock after the graph gate.
  delete from auth.sessions where user_id = p_user_id;
  delete from private.member_pin_sessions where user_id = p_user_id;

  update public.organization_memberships
  set status = 'revoked', revoked_at = pg_catalog.clock_timestamp()
  where organization_id = p_organization_id and user_id = p_user_id and status = 'active';

  if exists (
    select 1 from public.member_profiles p
    join public.chapters c on c.id = p.chapter_id
    where p.id = p_user_id and c.organization_id = p_organization_id
  ) then
    select m.chapter_id into replacement_chapter
    from public.member_chapter_memberships m
    where m.user_id = p_user_id and m.status = 'active'
    order by m.last_selected_at desc nulls last, m.joined_at, m.chapter_id
    limit 1;
    update public.member_profiles set chapter_id = replacement_chapter where id = p_user_id;
  end if;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    p_organization_id, 'membership', 'membership.scim_deprovisioned', 'revoke', null,
    'membership', p_user_id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('organizationId', p_organization_id, 'userId', p_user_id,
      'status', 'revoked', 'reasonCode', 'scim_deprovision', 'count', revoked_chapters)
  );
  return 'revoked';
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_member_chapter_membership(p_user_id uuid, p_chapter_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target_org uuid;
  org_admin boolean;
  replacement_chapter text;
  membership_key text := 'm:' || p_user_id::text || ':' || p_chapter_id;
  before_state jsonb;
  leaves_organization boolean;
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

  before_state := private.learning_membership_state('public.member_chapter_memberships', membership_key);
  leaves_organization := not exists (
    select 1
    from public.member_chapter_memberships m
    join public.chapters c on c.id = m.chapter_id
    where m.user_id = p_user_id
      and m.chapter_id <> p_chapter_id
      and m.status = 'active'
      and c.organization_id = target_org
  );

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

  if leaves_organization and pg_catalog.char_length(membership_key) <= 128 then
    perform private.learning_journal_append('chapter_membership_revoke_final', 'public.member_chapter_memberships', membership_key);
  end if;

  update public.member_chapter_memberships
  set status = 'revoked', revoked_at = pg_catalog.clock_timestamp(), pinned = false
  where user_id = p_user_id and chapter_id = p_chapter_id and status = 'active';

  delete from public.member_role_chapters
  where user_id = p_user_id and chapter_id = p_chapter_id;
  -- #8311: drop or repoint a legacy role row whose chapter lost the role.
  perform private.reconcile_legacy_member_roles(p_user_id);

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
  if not leaves_organization then
    perform private.learning_membership_journal('chapter_membership_revoke', 'public.member_chapter_memberships', membership_key, before_state);
  end if;
  return pg_catalog.jsonb_build_object('userId', p_user_id, 'chapterId', p_chapter_id, 'active', false);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_member_chapter_role(p_user_id uuid, p_chapter_id text, p_role text, p_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid(),p_user_id],array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target_org uuid;
  org_admin boolean;
  role_key text := p_user_id::text || ':' || p_role || ':' || p_chapter_id;
  before_state jsonb;
begin
  if caller is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'admin', 'vp', 'secretary', 'records', 'treasurer') then
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
  if not org_admin and not (private.member_has_chapter_role(p_chapter_id, array['admin']) or (p_role in ('secretary','records','treasurer') and private.member_has_chapter_role(p_chapter_id,array['vp']))) then
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
  if not org_admin and not (private.member_has_chapter_role(p_chapter_id, array['admin']) or (p_role in ('secretary','records','treasurer') and private.member_has_chapter_role(p_chapter_id,array['vp']))) then
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
  before_state := private.learning_membership_state('public.member_role_chapters', role_key);

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
    -- #8311: drop or repoint a legacy role row whose chapter lost the role.
    perform private.reconcile_legacy_member_roles(p_user_id, p_role);
  end if;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, case when coalesce(p_enabled, false) then 'grant_role' else 'revoke_role' end,
    p_user_id, pg_catalog.jsonb_build_object('role', p_role, 'chapterId', p_chapter_id));
  if coalesce(pg_catalog.current_setting('sg.learning_role_scope_writer', true), '') <> '1' then
    if coalesce(p_enabled, false) then
      perform private.learning_membership_journal('chapter_role_grant', 'public.member_role_chapters', role_key, before_state);
    else
      perform private.learning_membership_journal('chapter_role_revoke', 'public.member_role_chapters', role_key, before_state);
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'userId', p_user_id, 'chapterId', p_chapter_id, 'role', p_role,
    'enabled', coalesce(p_enabled, false));
end;
end;
$function$;

create or replace function private.learning_undo_chapter_membership(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target text := p_entry ->> 'target_id';
  part text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 1);
  member uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 2)::uuid;
  chapter text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 3);
  image jsonb := p_entry -> 'before_image';
  chapter_org uuid;
  org_admin boolean;
  can_assign boolean;
  previous_title text;
  previous_office text;
  replacement_chapter text;
  item jsonb;
begin
  select c.organization_id into chapter_org from public.chapters c where c.id = chapter;
  if p_mode = 'lock' then
    -- The forward paths' lock order: tenant, then member, then the row.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || chapter_org::text, 509));
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-chapter:' || member::text, 0));
    perform 1 from public.member_chapter_memberships m where m.user_id = member and m.chapter_id = chapter for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_membership_state('public.member_chapter_memberships', target);
  elsif p_mode = 'before' then
    return image;
  elsif p_mode = 'check' then
    if chapter_org is null or chapter_org is distinct from private.current_mobile_staff_organization() then
      raise exception 'you can no longer change this membership' using errcode = '42501';
    end if;
    if part = 'm' then
      -- grant_ and revoke_member_chapter_membership's rule.
      org_admin := private.has_organization_role(chapter_org, array['admin']);
      if not org_admin and (chapter is distinct from private.current_member_chapter()
          or not private.member_has_chapter_role(chapter, array['admin'])) then
        raise exception 'you can no longer change this membership' using errcode = '42501';
      end if;
      if image ->> 'status' = 'active' then
        -- Putting a removed chapter back never re-admits someone who has
        -- left the organization since; that takes an invitation.
        if not exists (select 1 from public.organization_memberships om
            where om.organization_id = chapter_org and om.user_id = member and om.status = 'active') then
          raise exception 'active organization membership required' using errcode = '22023';
        end if;
        for item in select value from pg_catalog.jsonb_array_elements(coalesce(image -> 'roles', '[]'::jsonb)) loop
          if (item ->> 'unit_id' is not null or item ->> 'committee_id' is not null)
             and not (org_admin or private.chapter_access_leadership(chapter)) then
            raise exception 'chapter leadership required' using errcode = '42501';
          end if;
          if (item ->> 'unit_id' is not null and not exists (select 1 from private.chapter_units u
                where u.id = (item ->> 'unit_id')::uuid and u.chapter_id = chapter))
             or (item ->> 'committee_id' is not null and not exists (select 1 from private.chapter_committees k
                where k.id = (item ->> 'committee_id')::uuid and k.chapter_id = chapter)) then
            raise exception 'role scope no longer exists' using errcode = '22023';
          end if;
        end loop;
        -- The pin and budget office come back under the rule that let this
        -- person take them away (revoke_member_chapter_membership's, above).
      elsif not exists (select 1 from public.member_chapter_memberships m
                join public.chapters c on c.id = m.chapter_id
                where m.user_id = member and m.chapter_id <> chapter and m.status = 'active' and c.organization_id = chapter_org) then
        -- Taking back someone's only chapter would leave an organization
        -- member with no chapter; that is a removal from the organization,
        -- which only revoke_member_chapter_membership does, and is permanent.
        raise exception 'this is their only chapter; remove them from it instead' using errcode = '22023';
      elsif exists (select 1 from public.organization_role_grants g
                where g.organization_id = chapter_org and g.user_id = member and g.role = 'admin')
            and not exists (select 1 from public.member_chapter_memberships m
                join public.chapters c on c.id = m.chapter_id
                where m.user_id = member and m.chapter_id <> chapter and m.status = 'active' and c.organization_id = chapter_org)
            and (select pg_catalog.count(*) from public.organization_role_grants g
                where g.organization_id = chapter_org and g.role = 'admin') <= 1 then
        raise exception 'cannot remove the last organization admin' using errcode = '22023';
      end if;
      return null;
    end if;
    if not exists (select 1 from public.member_chapter_memberships m
        where m.user_id = member and m.chapter_id = chapter and m.status = 'active') then
      raise exception 'membership not found' using errcode = '22023';
    end if;
    if part = 'p' then
      if member is distinct from caller or not private.mfa_satisfied() then
        raise exception 'authentication required' using errcode = '42501';
      end if;
    elsif part = 't' then
      if not private.mfa_satisfied() or not private.member_invitation_chapter_administrable(chapter) then
        raise exception 'admin role required' using errcode = '42501';
      end if;
    elsif part = 'o' then
      select ctx.can_assign into can_assign
      from private.chapter_budget_context(private.current_member_organization(), chapter) ctx;
      if not coalesce(can_assign, false) or not exists (select 1 from public.organization_memberships om
          where om.user_id = member and om.organization_id = chapter_org and om.status = 'active') then
        raise exception 'chapter admin required' using errcode = '42501';
      end if;
    else
      raise exception 'invalid learning target' using errcode = '22023';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if part = 'm' and image ->> 'status' = 'active' then
    update public.member_chapter_memberships m
    set status = 'active', revoked_at = null, pinned = coalesce((image ->> 'pinned')::boolean, false),
        budget_office = image ->> 'budget_office'
    where m.user_id = member and m.chapter_id = chapter and m.status = 'revoked';
    for item in select value from pg_catalog.jsonb_array_elements(coalesce(image -> 'roles', '[]'::jsonb)) loop
      insert into public.member_roles (user_id, role, granted_by, chapter_id)
      values (member, item ->> 'role', caller, chapter)
      on conflict (user_id, role) do nothing;
      insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
      values (member, item ->> 'role', chapter, caller)
      on conflict (user_id, role, chapter_id) do nothing;
      if item ->> 'unit_id' is not null or item ->> 'committee_id' is not null then
        insert into private.chapter_role_scopes (user_id, chapter_id, role, unit_id, committee_id)
        values (member, chapter, item ->> 'role', (item ->> 'unit_id')::uuid, (item ->> 'committee_id')::uuid)
        on conflict (user_id, chapter_id, role) do update set unit_id = excluded.unit_id, committee_id = excluded.committee_id;
      end if;
    end loop;
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'grant_chapter_membership', member,
      pg_catalog.jsonb_build_object('chapterId', chapter, 'learningUndo', true,
        'roles', (select coalesce(pg_catalog.jsonb_agg(r ->> 'role'), '[]'::jsonb)
                  from pg_catalog.jsonb_array_elements(coalesce(image -> 'roles', '[]'::jsonb)) r)));
    insert into public.organization_audit_events (organization_id, event_type, actor_user_id, idempotency_key, metadata)
    values (chapter_org, 'organization_membership_granted', caller, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('organizationId', chapter_org::text, 'chapterId', chapter, 'userId', member::text,
        'action', 'learning_undo', 'entityId', p_entry ->> 'id'));
  elsif part = 'm' then
    -- Taking a granted chapter back: the same steps as a removal that leaves
    -- the person in the organization. Their selected chapter moves if needed.
    if exists (select 1 from public.member_profiles p where p.id = member and p.chapter_id = chapter) then
      select m.chapter_id into replacement_chapter
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id and c.organization_id = chapter_org
      where m.user_id = member and m.chapter_id <> chapter and m.status = 'active'
      order by m.last_selected_at desc nulls last, m.joined_at, m.chapter_id
      limit 1;
    end if;
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'revoke_chapter_membership', member,
      pg_catalog.jsonb_build_object('chapterId', chapter, 'replacementChapterId', replacement_chapter, 'learningUndo', true));
    update public.member_chapter_memberships m
    set status = 'revoked', revoked_at = pg_catalog.clock_timestamp(), pinned = false
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    -- revoke_member_chapter_membership's role cleanup, unchanged.
    delete from public.member_role_chapters
    where user_id = member and chapter_id = chapter;
    -- #8311: drop or repoint a legacy role row whose chapter lost the role.
    perform private.reconcile_legacy_member_roles(member);
    update public.member_profiles p set chapter_id = replacement_chapter
    where p.id = member and p.chapter_id = chapter;
    insert into public.organization_audit_events (organization_id, event_type, actor_user_id, idempotency_key, metadata)
    values (chapter_org, 'organization_membership_revoked', caller, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('organizationId', chapter_org::text, 'chapterId', chapter, 'userId', member::text,
        'action', 'learning_undo', 'entityId', p_entry ->> 'id'));
  elsif part = 'p' then
    update public.member_chapter_memberships m set pinned = coalesce((image ->> 'pinned')::boolean, false)
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
  elsif part = 't' then
    select m.display_title into previous_title from public.member_chapter_memberships m
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    update public.member_chapter_memberships m set display_title = image ->> 'display_title'
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    insert into public.member_admin_audit (actor, action, target_user, detail)
    values (caller, 'set_chapter_display_title', member,
      pg_catalog.jsonb_build_object('chapterId', chapter, 'title', image ->> 'display_title',
        'previousTitle', previous_title, 'learningUndo', true));
  elsif part = 'o' then
    select m.budget_office into previous_office from public.member_chapter_memberships m
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    update public.member_chapter_memberships m set budget_office = image ->> 'budget_office'
    where m.user_id = member and m.chapter_id = chapter and m.status = 'active';
    insert into public.organization_audit_ledger
      (organization_id, domain, event_type, action, actor_user_id, entity_type, entity_id, idempotency_key, metadata)
    values (chapter_org, 'administration', 'chapter_budget_office',
      case when image ->> 'budget_office' is null then 'revoke' else 'grant' end,
      caller, 'membership', member::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('chapterId', chapter, 'fromRole', previous_office, 'toRole', image ->> 'budget_office'));
  end if;
  return null;
end;
end;
$function$;

create or replace function private.learning_undo_chapter_role(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target text := p_entry ->> 'target_id';
  member uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 1)::uuid;
  role_name text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 2);
  chapter text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 3);
  image jsonb := p_entry -> 'before_image';
  wanted boolean := (p_entry -> 'before_image' ->> 'granted')::boolean;
  wanted_unit uuid := (p_entry -> 'before_image' ->> 'unit_id')::uuid;
  wanted_committee uuid := (p_entry -> 'before_image' ->> 'committee_id')::uuid;
  chapter_org uuid;
  org_admin boolean;
  current_state jsonb;
begin
  select c.organization_id into chapter_org from public.chapters c where c.id = chapter;
  if p_mode = 'lock' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || chapter_org::text, 509));
    return null;
  elsif p_mode = 'state' then
    return private.learning_membership_state('public.member_role_chapters', target);
  elsif p_mode = 'before' then
    return image;
  end if;
  current_state := private.learning_membership_state('public.member_role_chapters', target);
  if p_mode = 'check' then
    org_admin := private.has_organization_role(chapter_org, array['admin']);
    if chapter_org is null or chapter_org is distinct from private.current_mobile_staff_organization()
       or (not org_admin and (chapter is distinct from private.current_member_chapter()
         or not (private.member_has_chapter_role(chapter, array['admin'])
           or (role_name in ('secretary', 'records', 'treasurer') and private.member_has_chapter_role(chapter, array['vp']))))) then
      raise exception 'you can no longer change this role' using errcode = '42501';
    end if;
    -- A scope is set or cleared only by someone who may scope roles today.
    if (wanted_unit is not null or wanted_committee is not null
        or current_state ->> 'unit_id' is not null or current_state ->> 'committee_id' is not null)
       and not (private.has_organization_role(chapter_org, array['admin']) or private.chapter_access_leadership(chapter)) then
      raise exception 'chapter leadership required' using errcode = '42501';
    end if;
    if wanted then
      if not exists (select 1 from public.member_chapter_memberships m
          where m.user_id = member and m.chapter_id = chapter and m.status = 'active')
         or not exists (select 1 from public.organization_memberships om
          where om.user_id = member and om.organization_id = chapter_org and om.status = 'active') then
        raise exception 'active chapter membership required' using errcode = '22023';
      end if;
      if (wanted_unit is not null and not exists (select 1 from private.chapter_units u where u.id = wanted_unit and u.chapter_id = chapter))
         or (wanted_committee is not null and not exists (select 1 from private.chapter_committees k where k.id = wanted_committee and k.chapter_id = chapter)) then
        raise exception 'role scope no longer exists' using errcode = '22023';
      end if;
    elsif role_name = 'admin' and member = caller and chapter = private.current_member_chapter() then
      raise exception 'an admin cannot remove the active admin role from this session' using errcode = '22023';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if wanted then
    insert into public.member_roles (user_id, role, granted_by, chapter_id)
    values (member, role_name, caller, chapter)
    on conflict (user_id, role) do nothing;
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
    values (member, role_name, chapter, caller)
    on conflict (user_id, role, chapter_id) do nothing;
    if wanted_unit is not null or wanted_committee is not null then
      insert into private.chapter_role_scopes (user_id, chapter_id, role, unit_id, committee_id)
      values (member, chapter, role_name, wanted_unit, wanted_committee)
      on conflict (user_id, chapter_id, role) do update set unit_id = excluded.unit_id, committee_id = excluded.committee_id;
    else
      delete from private.chapter_role_scopes s where s.user_id = member and s.chapter_id = chapter and s.role = role_name;
    end if;
  else
    delete from public.member_role_chapters rc
    where rc.user_id = member and rc.role = role_name and rc.chapter_id = chapter;
    -- #8311: repoint a legacy row that named this chapter to one that still
    -- holds the role, or drop it, as the forward revoke does.
    perform private.reconcile_legacy_member_roles(member, role_name);
  end if;
  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller,
    case when wanted is distinct from (current_state ->> 'granted')::boolean
      then case when wanted then 'grant_role' else 'revoke_role' end else 'role_scope_updated' end,
    member,
    pg_catalog.jsonb_build_object('role', role_name, 'chapterId', chapter, 'unitId', wanted_unit,
      'committeeId', wanted_committee, 'learningUndo', true));
  insert into public.organization_audit_events (organization_id, event_type, actor_user_id, idempotency_key, metadata)
  values (chapter_org, case when wanted then 'organization_role_granted' else 'organization_role_revoked' end, caller,
    extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('organizationId', chapter_org::text, 'chapterId', chapter, 'userId', member::text,
      'role', role_name, 'action', 'learning_undo', 'entityId', p_entry ->> 'id'));
  return null;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_vp_case_reviewed(p_case_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  -- #8311: the selected workspace, never the first legacy role row.
  caller_chapter text := private.current_member_chapter();
  caller_org uuid := private.current_member_organization();
  result_row public.member_vp_case_reviews%rowtype;
begin
  if caller is null or not public.member_has_role(array['vp']) or not (select private.mfa_satisfied()) then
    raise exception 'president role with MFA required' using errcode = '42501';
  end if;

  -- The case's own stored chapter, never its owner's selected one, which
  -- the owner can switch after the case was opened.
  if caller_chapter is null or not exists (
    select 1
    from public.member_cases c
    join public.chapters ch on ch.id = c.chapter_id
    where c.id = p_case_id and c.learning_undone_at is null
      and c.chapter_id = caller_chapter
      and c.organization_id is not distinct from caller_org
      and ch.organization_id is not distinct from caller_org
      and c.status = 'active'
      and c.deadline is not null
      and c.deadline < current_date
  ) then
    raise exception 'attention case not found' using errcode = 'P0002';
  end if;

  insert into public.member_vp_case_reviews (chapter_id, case_id, reviewed_by)
  values (caller_chapter, p_case_id, caller)
  on conflict (chapter_id, case_id) do nothing;

  select * into strict result_row
  from public.member_vp_case_reviews r
  where r.chapter_id = caller_chapter and r.case_id = p_case_id;

  return pg_catalog.jsonb_build_object(
    'caseId', result_row.case_id,
    'reviewedAt', result_row.reviewed_at,
    'reviewedBy', result_row.reviewed_by);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_vp_case_reviews()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  -- #8311: the selected workspace, never the first legacy role row.
  caller_chapter text := private.current_member_chapter();
  payload jsonb;
begin
  if caller is null or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role with MFA required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'caseId', v.case_id,
    'reviewedAt', v.reviewed_at,
    'reviewedBy', v.reviewed_by,
    'reviewerName', p.full_name,
    'caseReference', c.reference,
    'caseTitle', private.case_row_title(c.id),
    'topicShown', private.case_row_topic_shown(c.id),
    'caseType', c.case_type,
    'caseStep', c.step
  ) order by v.reviewed_at desc), '[]'::jsonb)
  into payload
  from public.member_vp_case_reviews v
  join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = v.reviewed_by
  join (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c on c.id = v.case_id
  where v.chapter_id = caller_chapter;

  return payload;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_intake_triage_owners()
 RETURNS TABLE(user_id uuid, full_name text, initials text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator']) then
    raise exception 'intake staff role required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where p.id = caller;

  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '42501';
  end if;

  return query
  select p.id, p.full_name, p.initials
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where p.chapter_id = caller_chapter
    and private.chapter_staff_roles(p.id, caller_chapter) && array['steward', 'coordinator']
  order by p.full_name, p.id;
end
$function$;

CREATE OR REPLACE FUNCTION public.triage_member_intake_report(p_report_id uuid, p_status text, p_assigned_to uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  report_row public.member_intake_reports%rowtype;
  updated public.member_intake_reports%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator']) then
    raise exception 'intake staff role required' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('new', 'triaged', 'in_progress', 'closed') then
    raise exception 'invalid intake status' using errcode = '22023';
  end if;

  select r.* into report_row
  from public.member_intake_reports r
  join public.member_profiles caller_profile
    on caller_profile.id = caller
   and caller_profile.chapter_id = r.chapter_id
  where r.id = p_report_id
  for update of r;

  if report_row.id is null then
    raise exception 'intake report unavailable' using errcode = '22023';
  end if;

  if p_assigned_to is not null and not exists (
    select 1
    from public.member_profiles owner_profile
    where owner_profile.id = p_assigned_to
      and owner_profile.chapter_id = report_row.chapter_id
      and private.chapter_staff_roles(owner_profile.id, report_row.chapter_id) && array['steward', 'coordinator']
  ) then
    raise exception 'intake owner must be same-chapter staff' using errcode = '22023';
  end if;

  update public.member_intake_reports r
     set status = p_status,
         assigned_to = p_assigned_to
   where r.id = report_row.id
  returning r.* into updated;

  return pg_catalog.to_jsonb(updated);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.convert_member_intake_report(p_report_id uuid, p_target text, p_space_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  learning_parent uuid;
  learning_report jsonb;
  caller uuid := (select auth.uid());
  report_row public.member_intake_reports%rowtype;
  updated public.member_intake_reports%rowtype;
  target_id uuid;
  attachment_id uuid;
  ref text;
  attempts integer := 0;
  case_type text;
  outcome_owner uuid;
  outcome_owner_name text;
  outcome_owner_is_steward boolean := false;
  outcome_owner_is_coordinator boolean := false;
  task_workstream text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator']) then
    raise exception 'intake staff role required' using errcode = '42501';
  end if;
  if p_target is null or p_target not in ('case', 'task', 'thread') then
    raise exception 'invalid intake conversion target' using errcode = '22023';
  end if;

  select r.* into report_row
  from public.member_intake_reports r
  join (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) caller_profile
    on caller_profile.id = caller
   and caller_profile.chapter_id = r.chapter_id
  where r.id = p_report_id
  for update of r;

  if report_row.id is null then
    raise exception 'intake report unavailable' using errcode = '22023';
  end if;
  -- A retried request is safe. Repeating the same target returns the existing
  -- result; changing targets after conversion is refused.
  if pg_catalog.num_nonnulls(report_row.case_id, report_row.task_id, report_row.thread_id) > 0 then
    target_id := case p_target
      when 'case' then report_row.case_id
      when 'task' then report_row.task_id
      when 'thread' then report_row.thread_id
    end;
    if target_id is null then
      raise exception 'intake report already converted to another target' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'report', pg_catalog.to_jsonb(report_row),
      'target', p_target,
      'targetId', target_id
    );
  end if;
  if report_row.status = 'closed' then
    raise exception 'closed intake reports cannot be converted' using errcode = '22023';
  end if;

  if p_target = 'case' then
    case_type := case report_row.category when 'safety' then 'Safety' else 'Other' end;
    outcome_owner := coalesce(report_row.assigned_to, caller);
    select p.full_name,
           'steward' = any(private.chapter_staff_roles(p.id, report_row.chapter_id)),
           'coordinator' = any(private.chapter_staff_roles(p.id, report_row.chapter_id))
      into outcome_owner_name, outcome_owner_is_steward, outcome_owner_is_coordinator
    from (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p
    where p.id = outcome_owner and p.chapter_id = report_row.chapter_id;
    loop
      attempts := attempts + 1;
      ref := 'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-' || private.member_case_suffix();
      begin
        insert into public.member_cases (
          user_id, reference, title, case_type, articles, step, status,
          steward_user_id, steward_name, coordinator_user_id, coordinator_name, assigned_at
        ) values (
          report_row.reporter_id,
          ref,
          pg_catalog.left('Intake follow-up: ' || report_row.title, 200),
          case_type,
          '',
          'Intake',
          'active',
          case when outcome_owner_is_steward then outcome_owner else null end,
          case when outcome_owner_is_steward then outcome_owner_name else null end,
          case when outcome_owner_is_coordinator then outcome_owner else null end,
          case when outcome_owner_is_coordinator then outcome_owner_name else null end,
          case when outcome_owner_is_steward or outcome_owner_is_coordinator then now() else null end
        ) returning id into target_id;
        exit;
      exception when unique_violation then
        if attempts >= 5 then
          raise exception 'could not allocate a case reference' using errcode = '23505';
        end if;
      end;
    end loop;
  elsif p_target = 'task' then
    -- Standard Task defaults are deliberate. Sensitive report text is not
    -- copied into the card; the attachment is an authorized in-app link whose
    -- destination remains protected by intake RLS.
    -- `General` is preferred while it exists, but workstream rename is a
    -- supported chapter operation. Lock the chosen row so a concurrent rename
    -- cannot invalidate it between selection and the task trigger's check.
    select w.name into task_workstream
    from public.chapter_workstreams w
    where w.chapter_id = report_row.chapter_id
    order by (w.name = 'General') desc, w.name, w.id
    limit 1
    for key share of w;

    if task_workstream is null then
      raise exception 'chapter has no available task workstream' using errcode = '22023';
    end if;

    insert into public.chapter_tasks (
      title, description, status, priority, task_type, workstream,
      assignee_id, start_date, due_date, progress, blocked, milestone, order_index
    ) values (
      'Follow up on intake report', '', 'to_do', 'medium', 'general', task_workstream,
      null, null, null, 0, false, false, 0
    ) returning id into target_id;

    insert into public.chapter_task_attachments (
      task_id, chapter_id, label, record_url, created_by
    ) values (
      target_id,
      report_row.chapter_id,
      'Authorized intake report',
      '/m/organize?intake=' || report_row.id::text,
      caller
    ) returning id into attachment_id;

    insert into public.chapter_task_activity (
      task_id, chapter_id, actor_id, action, to_value
    ) values (
      target_id, report_row.chapter_id, caller, 'attachment_added', attachment_id::text
    );
  else
    if p_space_id is null or not exists (
      select 1
      from public.chapter_spaces s
      where s.id = p_space_id
        and s.chapter_id = report_row.chapter_id
        and s.archived_at is null
        and private.can_read_chapter_space(s)
    ) then
      raise exception 'choose an available same-chapter space' using errcode = '22023';
    end if;

    insert into public.chapter_threads (space_id, title, kind)
    values (p_space_id, 'Intake follow-up', 'intake')
    returning id into target_id;
  end if;

  update public.member_intake_reports r
     set status = 'in_progress',
         assigned_to = coalesce(r.assigned_to, caller),
         case_id = case when p_target = 'case' then target_id else null end,
         task_id = case when p_target = 'task' then target_id else null end,
         thread_id = case when p_target = 'thread' then target_id else null end
   where r.id = report_row.id
  returning r.* into updated;

  -- The created case or task keeps the report as it stood and as conversion
  -- left it, so undoing the creation puts the report back.
  learning_report := pg_catalog.jsonb_build_object('intake_report', pg_catalog.jsonb_build_object('id', report_row.id,
    'before', private.learning_intake_report_fields(report_row), 'after', private.learning_intake_report_fields(updated)));
  if p_target = 'case' then
    perform private.learning_casework_journal('case_intake_convert', target_id, false, learning_report);
  elsif p_target = 'task' then
    learning_parent := private.learning_journal_append('task_create', 'public.chapter_tasks', target_id::text, null,
      private.learning_fingerprint(private.learning_task_state(target_id) - 'order_index'), null, learning_report);
    perform private.learning_journal_append('task_link_add', 'public.chapter_task_attachments', attachment_id::text, learning_parent,
      private.learning_fingerprint(private.learning_task_edge_state('public.chapter_task_attachments', attachment_id::text)), null, '{}'::jsonb);
  end if;
  return pg_catalog.jsonb_build_object(
    'report', pg_catalog.to_jsonb(updated),
    'target', p_target,
    'targetId', target_id
  );
end;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_case_note_mention_candidates(p_case_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_case public.member_cases%rowtype;
  v_chapter text;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_read(p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  -- #8311: the case's own stored chapter, never its owner's selected one.
  v_chapter := v_case.chapter_id;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', eligible.user_id,
      'fullName', eligible.full_name,
      'roles', eligible.roles
    ) order by eligible.full_name, eligible.user_id)
    from (
      select staff.user_id, p.full_name, pg_catalog.to_jsonb(staff.roles) as roles
      from (
        select candidate.user_id,
               array(select held.role from pg_catalog.unnest(private.chapter_staff_roles(candidate.user_id, v_chapter)) held(role)
                     where held.role in ('steward', 'coordinator') order by held.role) as roles
        from (
          select rc.user_id from public.member_role_chapters rc
          where rc.chapter_id = v_chapter and rc.role in ('steward', 'coordinator')
          union
          select r.user_id from public.member_roles r
          where r.chapter_id = v_chapter and r.role in ('steward', 'coordinator')
          union
          select g.user_id from public.organization_role_grants g
          join public.chapters ch on ch.id = v_chapter and ch.organization_id = g.organization_id
          where g.role in ('steward', 'coordinator')
        ) candidate
      ) staff
      join public.member_profiles p on p.id = staff.user_id
      where pg_catalog.cardinality(staff.roles) > 0
      order by p.full_name, staff.user_id
      limit 200
    ) eligible
  ), '[]'::jsonb);
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_add_case_note(p_case_id uuid, p_body text, p_mention_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  v_case public.member_cases%rowtype;
  v_chapter text;
  v_body text;
  v_mentions uuid[];
  v_mention_count integer;
  v_inserted public.member_case_updates%rowtype;
  v_actor text;
  v_recipient uuid;
begin
  -- Case graph gate first, before any declaration initializer, authorization
  -- read or row acquisition: this routine writes member_case_updates and
  -- member_notifications, both of which sit inside the account/case graph.
  perform private.lock_case_graph(array[(select auth.uid())], array[p_case_id]);
  v_body := pg_catalog.btrim(coalesce(p_body, ''));
  v_case := private.coordinator_case_for_update(p_case_id);
  if pg_catalog.char_length(v_body) not between 1 and 4000 then
    raise exception 'note must be 1-4000 characters' using errcode = '22023';
  end if;

  -- Self-mentions are dropped rather than rejected: a coordinator typing their
  -- own name is not an error, it is just not a notification.
  select pg_catalog.array_agg(distinct candidate.id) into v_mentions
  from pg_catalog.unnest(coalesce(p_mention_ids, '{}'::uuid[])) as candidate(id)
  where candidate.id is not null and candidate.id <> (select auth.uid());
  v_mentions := coalesce(v_mentions, '{}'::uuid[]);
  v_mention_count := coalesce(pg_catalog.array_length(v_mentions, 1), 0);
  if v_mention_count > 10 then
    raise exception 'a note mentions at most 10 people' using errcode = '22023';
  end if;

  -- #8311: the case's own stored chapter, never its owner's selected one.
  v_chapter := v_case.chapter_id;
  if exists (
    select 1
    from pg_catalog.unnest(v_mentions) as mention(id)
    where not exists (
      select 1 where private.chapter_staff_roles(mention.id, v_chapter) && array['steward', 'coordinator'])
  ) then
    raise exception 'mentioned person is outside the case chapter' using errcode = '23514';
  end if;

  insert into public.member_case_updates(case_id, user_id, body, mentioned_user_ids)
  values (v_case.id, v_case.user_id, v_body, v_mentions)
  returning * into v_inserted;

  insert into public.coordinator_case_audit(case_id, user_id, actor_id, action, after_value)
  values (v_case.id, v_case.user_id, (select auth.uid()), 'note_added',
    pg_catalog.jsonb_build_object('updateId', v_inserted.id, 'body', v_inserted.body, 'mentionCount', v_mention_count));

  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
    'note_added', 'case_update', v_inserted.id,
    pg_catalog.jsonb_build_object('mentionCount', v_mention_count));

  if v_mention_count > 0 then
    select coalesce(p.full_name, 'A staff member') into v_actor
    from public.member_profiles p where p.id = (select auth.uid());
    foreach v_recipient in array v_mentions loop
      perform private.notify_member(v_recipient, 'case.note.mention',
        pg_catalog.jsonb_build_object('name', coalesce(v_actor, 'A staff member')), 'cases');
    end loop;
    insert into public.casework_audit_events(
      organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
      'note_mentioned', 'case_update', v_inserted.id,
      pg_catalog.jsonb_build_object('mentionCount', v_mention_count));
  end if;

  perform private.learning_journal_append('case_note_add', 'public.member_case_updates', v_inserted.id::text, null,
    private.learning_fingerprint(private.learning_case_note_state(v_inserted.id)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object(
    'id', v_inserted.id, 'caseId', v_inserted.case_id, 'body', v_inserted.body,
    'mentionedUserIds', pg_catalog.to_jsonb(v_mentions), 'createdAt', v_inserted.created_at);
end;
end;
$function$;

-- Account lifecycle: the steward-request trigger now reaches the chapter
-- steward helpers; record their reviewed definitions.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.kind = 'function' and s.schema_name = 'private'
  and s.object_name in ('notify_stewards_of_request()', 'member_stewards_for_chapter(p_chapter text)',
    'chapter_staff_roles(p_user_id uuid, p_chapter_id text)')
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;
do $assert_president_review_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after #8311';
  end if;
end;
$assert_president_review_trigger_review$;

notify pgrst, 'reload schema';

commit;
