-- BUG-UG-SHARED-DEMO-ADMIN-LOCKS-OUT-LATER-VISITORS-20261107 (#7386)
-- The SAMPLE demo entry (api/demo-session.js) hands every visitor the same six
-- fictional Tamarack persona accounts, including the Admin persona.
-- 20261107120000 keeps each persona's own sign-in state fixed; it does not stop
-- a visitor in the Admin hat changing who can use the other hats. Gate round 6
-- on #7375 (r6s1): set_member_mfa_policy(true) makes member two-step
-- mandatory, the Member persona cannot enrol (that guard refuses it), and the
-- Member entry stops at the enrolment screen for every later visitor.
--
-- These triggers refuse, when the request comes from a shared persona session
-- (auth.uid() is one of the six), the writes that decide whether a hat can be
-- entered and used at all:
--   * public.org_security_policy: any change to the member or staff two-step
--     policy (set_member_mfa_policy, set_staff_mfa_policy);
--   * public.organization_role_grants, public.member_roles and
--     public.member_role_chapters: granting, revoking or moving a role of a
--     persona account (revoking the Admin persona's own admin role cannot be
--     undone from the demo; a staff role on the Member persona brings the
--     staff two-step requirement it cannot meet);
--   * public.organization_memberships and public.member_chapter_memberships:
--     adding, revoking, removing or moving a persona's membership. Pinning,
--     chapter selection, display title, budget office and unit keys still
--     change, so the hats keep working, and the Admin hat can still add a
--     chapter: create_admin_chapter's membership for its creator in the new,
--     empty chapter is additive and passes (gate r1s1 on #7395);
--   * public.scim_tokens: issuing a SCIM token, whose deprovisioning would
--     revoke a persona's membership through the service role, outside the
--     persona session.
-- Every other account keeps today's behaviour, including staff and bot
-- accounts managed from the Admin hat, and so do requests that carry no
-- persona session (the seed, the service role, operators). Organization
-- content and feature switches stay open to the Admin hat: they are what the
-- demo shows, none of them stops a hat being entered, and the next Admin
-- visitor can change them back. The same operator override as 20261107120000
-- (set local union_ground.shared_demo_persona_maintenance = 'on') lifts the
-- guard for one transaction.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function private.is_shared_demo_persona_user(p_user uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select p_user is not null and exists (
    select 1 from auth.users u
    where u.id = p_user and private.is_shared_demo_persona_email(u.email)
  );
$function$;
revoke all on function private.is_shared_demo_persona_user(uuid) from public, anon, authenticated, service_role;
comment on function private.is_shared_demo_persona_user(uuid) is
  'Whether an account is one of the six shared SAMPLE demo entry personas (by its auth.users address).';

create function private.guard_shared_demo_persona_access()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  v_refused boolean := false;
begin
  if pg_catalog.current_setting('union_ground.shared_demo_persona_maintenance', true) = 'on'
     or not private.is_shared_demo_persona_user((select auth.uid())) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_table_name in ('org_security_policy', 'scim_tokens') then
    v_refused := true;
  elsif tg_op = 'INSERT' then
    v_refused := private.is_shared_demo_persona_user(new.user_id);
    -- Add chapter makes its creator an active member of the chapter it just
    -- made (20261031103908). That additive row is the caller's own,
    -- in a chapter nobody belongs to yet, in an organization the caller
    -- already administers, so it changes no hat's entry; it passes.
    if v_refused and tg_table_name = 'member_chapter_memberships' then
      if new.user_id = (select auth.uid()) and new.status = 'active'
         and not exists (select 1 from public.member_chapter_memberships m where m.chapter_id = new.chapter_id)
         and exists (
           select 1 from public.chapters c
           join public.organization_memberships om
             on om.organization_id = c.organization_id and om.user_id = new.user_id and om.status = 'active'
           join public.organization_role_grants g
             on g.organization_id = c.organization_id and g.user_id = new.user_id and g.role = 'admin'
           where c.id = new.chapter_id
         ) then
        v_refused := false;
      end if;
    end if;
  elsif tg_op = 'DELETE' then
    v_refused := private.is_shared_demo_persona_user(old.user_id);
  elsif private.is_shared_demo_persona_user(old.user_id) or private.is_shared_demo_persona_user(new.user_id) then
    -- Each table's columns are read in its own branch: PL/pgSQL resolves
    -- every field an expression names, so one CASE over both would fail.
    if tg_table_name = 'organization_memberships' then
      v_refused := new.user_id is distinct from old.user_id
        or new.organization_id is distinct from old.organization_id
        or new.status is distinct from old.status;
    elsif tg_table_name = 'member_chapter_memberships' then
      v_refused := new.user_id is distinct from old.user_id
        or new.chapter_id is distinct from old.chapter_id
        or new.status is distinct from old.status;
    else
      v_refused := true;
    end if;
  end if;

  if v_refused then
    raise exception 'shared demo account access cannot be changed' using errcode = '42501', hint = 'shared-demo-account';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;
revoke all on function private.guard_shared_demo_persona_access() from public, anon, authenticated, service_role;
comment on function private.guard_shared_demo_persona_access() is
  'From a shared SAMPLE demo persona session, refuses changes to the organization two-step policy, SCIM token issuance, and any persona''s roles and memberships; pinning and selection pass.';

create trigger guard_shared_demo_persona_access
before insert or update or delete on public.org_security_policy
for each row execute function private.guard_shared_demo_persona_access();

create trigger guard_shared_demo_persona_access
before insert or update or delete on public.organization_role_grants
for each row execute function private.guard_shared_demo_persona_access();

create trigger guard_shared_demo_persona_access
before insert or update or delete on public.member_roles
for each row execute function private.guard_shared_demo_persona_access();

create trigger guard_shared_demo_persona_access
before insert or update or delete on public.member_role_chapters
for each row execute function private.guard_shared_demo_persona_access();

create trigger guard_shared_demo_persona_access
before insert or update or delete on public.organization_memberships
for each row execute function private.guard_shared_demo_persona_access();

create trigger guard_shared_demo_persona_access
before insert or update or delete on public.member_chapter_memberships
for each row execute function private.guard_shared_demo_persona_access();

create trigger guard_shared_demo_persona_access
before insert on public.scim_tokens
for each row execute function private.guard_shared_demo_persona_access();

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.object_name = 'guard_shared_demo_persona_access' and s.schema_name = 'public'
       and s.table_name in ('org_security_policy', 'organization_role_grants', 'member_roles', 'member_role_chapters',
                            'organization_memberships', 'member_chapter_memberships', 'scim_tokens'))
   or (s.kind = 'function' and s.schema_name = 'private'
       and pg_catalog.split_part(s.object_name, '(', 1) in ('guard_shared_demo_persona_access', 'is_shared_demo_persona_user'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;
do $review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review incomplete after the shared demo persona access guard';
  end if;
end;
$review$;
notify pgrst, 'reload schema';
commit;
