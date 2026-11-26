-- BUG-UG-START-GUIDE-READ-TAKES-LIFECYCLE-GATE-20261107 (#7366)
--
-- Every staff desk load calls public.get_organization_start_guide(). Its first
-- statement was perform private.lock_case_graph(...), which waits for the
-- global message-lifecycle and (509, 700) advisory locks in exclusive mode
-- under the 3 s lock_timeout the gate forces, and holds them for the rest of
-- the transaction. The function writes only once per organization: the
-- live_at latch in private.organization_start_guide_state. So the desk read
-- failed with 55P03 whenever another gated transaction held the gate past
-- 3 s (the VP desk's "This page didn't load" on SAMPLE at 12:22:40 AM ET on
-- Nov 7, 2026), and while it held the gate it blocked every other gated
-- writer, GoTrue's auth.mfa_factors statements during staff two-step sign-in
-- included (#7299).
--
-- The function now reads before the gate. Every helper it calls only reads,
-- and those reads take no tuple lock. The gate is taken only on the one-time
-- latch path, when the organization is not live yet and every milestone holds.
-- Under the gate the caller's organization-wide role, the state row and the
-- milestones are read again, so the latch decision is made under the gate
-- exactly as before. Same name, signature, return shape, visibility rules,
-- security-definer boundary, search_path and privileges. No table, trigger,
-- index or grant changes.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.get_organization_start_guide()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
  org_name text;
  state_row private.organization_start_guide_state%rowtype;
  milestones jsonb;
  admin_name text;
  is_admin boolean;
  can_name boolean;
begin
  -- Everything up to the latch only reads, and every helper called here only
  -- reads, taking no tuple lock, so the read runs before the lifecycle gate.
  -- Taking the gate on every desk load failed the read at the gate's 3 s
  -- lock_timeout while another transaction held it, and blocked every other
  -- gated writer meanwhile (#7366).
  caller := (select auth.uid());
  org := private.current_mobile_staff_organization();
  if caller is null then
    raise exception 'authenticated session required' using errcode = '42501';
  end if;
  -- Only an org-scope grantee with sign-in requirements met sees the guide
  -- (project decision 2.4: never chapter-only roles). Everyone else learns
  -- nothing about the organization's setup.
  if org is null or not private.has_organization_role(org, array['steward','coordinator','advisor','admin','vp']) then
    return pg_catalog.jsonb_build_object('state', 'hidden');
  end if;
  if not private.organization_feature_enabled(org, 'features.guidance_onboarding.org_start_guide') then
    return pg_catalog.jsonb_build_object('state', 'off', 'organizationId', org);
  end if;

  select o.name into org_name from public.organizations o where o.id = org;
  select * into state_row from private.organization_start_guide_state s where s.organization_id = org;

  if state_row.celebrated_at is not null then
    return pg_catalog.jsonb_build_object('state', 'done', 'organizationId', org, 'organizationName', org_name, 'liveAt', state_row.live_at);
  end if;

  if state_row.live_at is null then
    milestones := private.organization_start_milestones(org);
    if private.organization_start_all_done(milestones) then
      -- The one write: case-graph gate first, like every writer of an
      -- identity-linked table. Under the gate the role, the state row and the
      -- milestones are read again, so the latch is decided as before.
      perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
      if not private.has_organization_role(org, array['steward','coordinator','advisor','admin','vp']) then
        return pg_catalog.jsonb_build_object('state', 'hidden');
      end if;
      select * into state_row from private.organization_start_guide_state s where s.organization_id = org;
      if state_row.celebrated_at is not null then
        return pg_catalog.jsonb_build_object('state', 'done', 'organizationId', org, 'organizationName', org_name, 'liveAt', state_row.live_at);
      end if;
      if state_row.live_at is null then
        milestones := private.organization_start_milestones(org);
        if private.organization_start_all_done(milestones) then
          -- Latch once: from here on the guide is live whatever happens later.
          insert into private.organization_start_guide_state as s (organization_id, live_at, updated_at)
          values (org, pg_catalog.now(), pg_catalog.now())
          on conflict (organization_id) do update
            set live_at = coalesce(s.live_at, excluded.live_at), updated_at = pg_catalog.now()
          returning * into state_row;
        end if;
      end if;
    end if;
  end if;

  if state_row.live_at is not null then
    return pg_catalog.jsonb_build_object('state', 'live', 'organizationId', org, 'organizationName', org_name, 'liveAt', state_row.live_at);
  end if;

  is_admin := private.has_organization_role(org, array['admin']);
  can_name := private.has_organization_role(org, array['admin','vp']);
  select private.member_support_member_label(g.user_id) into admin_name
  from public.organization_role_grants g
  join public.organization_memberships m
    on m.organization_id = g.organization_id and m.user_id = g.user_id and m.status = 'active'
  where g.organization_id = org and g.role = 'admin'
  order by (g.user_id = caller), g.granted_at, g.user_id
  limit 1;

  return pg_catalog.jsonb_build_object(
    'state', 'active',
    'organizationId', org,
    'organizationName', org_name,
    'viewer', pg_catalog.jsonb_build_object('isAdmin', is_admin, 'canNameContacts', can_name),
    'adminName', admin_name,
    'milestones', milestones,
    'people', private.organization_start_people(org),
    'members', case when can_name then private.organization_start_members(org) else '[]'::jsonb end,
    'contacts', pg_catalog.jsonb_build_object(
      'backupUserId', state_row.backup_user_id,
      'spokespersonUserIds', coalesce((
        select pg_catalog.jsonb_agg(sp.user_id order by sp.user_id)
        from private.organization_start_spokespeople sp
        where sp.organization_id = org
      ), '[]'::jsonb)
    )
  );
end;
$function$;

revoke all on function public.get_organization_start_guide() from public, anon, authenticated, service_role;
grant execute on function public.get_organization_start_guide() to authenticated;

notify pgrst, 'reload schema';

commit;
