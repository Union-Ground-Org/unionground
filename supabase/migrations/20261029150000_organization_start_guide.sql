-- REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029
--
-- Onboarding guide engine port, step 3: guide 1, "Getting the organization
-- started", and the server definitions of the two member guide layers that
-- step 2 put on Main behind switches the server did not define.
--
-- Project decisions (October 29, 2026, "i want it all fully built functional
-- and switched on"): the org-start reads and both member switches are built
-- here and default ON, the same way the five existing guidance switches
-- default ON; organizations can still turn each one off.
--
-- 1. Three member-visible guidance switches, organization editable, default
--    on: features.guidance_onboarding.feature_guides (per-feature guides),
--    .coach_marks (one inline hint per session) and .org_start_guide (this
--    guide). Sort orders 1300 to 1320 sit in the free band the prototype
--    contract reserved (1300-1330).
-- 2. private.organization_start_guide_state: one row per organization with the
--    facts the product had nowhere to keep (the five guide switches reviewed
--    once; the organization's named backup) and the live latch, and
--    private.organization_start_spokespeople for the named spokespeople. Private
--    schema, no table grants: only the functions below read or write them.
--    Both identity references are in the account-lifecycle manifest.
-- 3. public.get_organization_start_guide(): the seven milestones computed on
--    read from the organization's real records (project decision 3.5 sources,
--    confirmed in the repository):
--      structure   chapters.organization_id; the worksite list setting
--                  lists.organizing.worksites (20261008232000)
--      people      organization_role_grants for anyone besides the founding
--                  administrator; member_invitations through chapters with
--                  a recorded delivery (sent_at)
--      onboarding  organization_onboarding_steps.active; switches reviewed
--      content     member_broadcasts (not retracted), member_events (not
--                  cancelled) through chapters, knowledge_collection_items or
--                  approved organization_knowledge_files
--      ballot      standard member_ballots.organization_id (every product ballot is
--                  secret: votes are never linked to a voter, so a saved
--                  ballot draft carries its secrecy)
--      support     organization_hr_directory enabled with a contact named
--      backups     the state row's backup and spokespeople (new here)
--    Visible only to callers holding a role at organization scope with their
--    sign-in requirements met (private.has_organization_role: MFA, second
--    factor when the organization requires it). Anyone else gets
--    {"state":"hidden"} and no organization facts. When all seven hold the
--    organization is latched live once; a fact that later becomes untrue
--    never reopens the guide (project decision 2.4).
-- 4. Writers, each SECURITY DEFINER with an empty search_path:
--    mark_organization_start_switches_reviewed() (administrators: the
--    switches are administrator-only), save_organization_start_contacts()
--    (administrators and organization-wide leadership) and
--    acknowledge_organization_start_celebration() (any org-wide role; the
--    "You're live" card shows once per organization).

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible, organization_editable)
values
  ('features.guidance_onboarding.feature_guides', 'boolean', 'Feature guides',
   'Show a short guide the first time a person opens each part of the app: what they can do there, what never to do, and one real first step.',
   'true', null, null, null, 1300, 'guidance_onboarding', true, true),
  ('features.guidance_onboarding.coach_marks', 'boolean', 'Coach marks',
   'Point out the control for a member''s next onboarding step, at most once per session, never over a dialog or a guide.',
   'true', null, null, null, 1310, 'guidance_onboarding', true, true),
  ('features.guidance_onboarding.org_start_guide', 'boolean', 'Getting the organization started',
   'Show people with an organization-wide role the shared setup guide: seven milestones, each done when the real thing exists.',
   'true', null, null, null, 1320, 'guidance_onboarding', true, true)
on conflict (key) do nothing;

create table private.organization_start_guide_state (
  organization_id uuid primary key references public.organizations(id) on update cascade on delete cascade,
  switches_reviewed_at timestamptz,
  backup_user_id uuid references auth.users(id) on delete set null,
  contacts_saved_at timestamptz,
  live_at timestamptz,
  celebrated_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_start_guide_celebrated_after_live
    check (celebrated_at is null or live_at is not null)
);

-- The organization's named spokespeople (at most ten, enforced by the
-- writer). A deleted account leaves the list with its row.
create table private.organization_start_spokespeople (
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  named_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, user_id)
);

revoke all on table private.organization_start_guide_state from public, anon, authenticated, service_role;
revoke all on table private.organization_start_spokespeople from public, anon, authenticated, service_role;

-- Both tables reference auth.users, so they join the account case graph:
-- every write takes the graph lock, and each row locks its identity keys.
create trigger a00_case_graph_lock before insert or update or delete on private.organization_start_guide_state
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_start_guide_state
for each row execute function private.lock_case_graph_row_keys('{backup_user_id}', '');
create trigger a00_case_graph_lock before insert or update or delete on private.organization_start_spokespeople
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_start_spokespeople
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

-- Account lifecycle (AGENTS.md account-lifecycle contract): both identity
-- references are organization setup facts, not member-authored content.
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition, export_projection,
   export_inventory_basis, export_projection_version, export_domain, export_columns, exclusion_reason, note, reviewed_at)
values
  ('private', 'organization_start_guide_state', 'backup_user_id', 'pseudonymize', 'excluded_with_reason', null,
   'auth_user_fk', null, null, null,
   'An organization setup choice made by its administrators (who covers when leadership is away); the named person authored nothing here.',
   'Installed action is ON DELETE SET NULL; the organization keeps its live latch and simply has no backup named.', date '2026-10-29'),
  ('private', 'organization_start_spokespeople', 'user_id', 'cascade', 'excluded_with_reason', null,
   'auth_user_fk', null, null, null,
   'An organization setup choice made by its administrators or leadership (who speaks for the organization); the named person authored nothing here.',
   'Installed action is ON DELETE CASCADE; the person leaves the spokespeople list with the account.', date '2026-10-29');

comment on table private.organization_start_guide_state is
  'REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029: per-organization facts of the org-start guide the product had nowhere else (switches reviewed, backup named) and its live latch. Read and written only through the org-start guide functions.';
comment on table private.organization_start_spokespeople is
  'REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029: the spokespeople an organization named on its org-start guide (milestone 7). Written only by save_organization_start_contacts.';

-- The organization's org-wide roles, the caller's included. The caller must
-- already be an org-scope grantee; the helper adds no authority.
create function private.organization_start_people(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(person order by person->>'name', person->>'userId'), '[]'::jsonb)
  from (
    select pg_catalog.jsonb_build_object(
      'userId', role_grant.user_id,
      'name', private.member_support_member_label(role_grant.user_id),
      'roles', pg_catalog.jsonb_agg(role_grant.role order by pg_catalog.array_position(array['admin','vp','coordinator','advisor','steward'], role_grant.role))
    ) person
    from public.organization_role_grants role_grant
    join public.organization_memberships membership
      on membership.organization_id = role_grant.organization_id
     and membership.user_id = role_grant.user_id
     and membership.status = 'active'
    where role_grant.organization_id = p_organization_id
    group by role_grant.user_id
    order by role_grant.user_id
    limit 50
  ) people;
$function$;

revoke all on function private.organization_start_people(uuid) from public, anon, authenticated, service_role;

-- The organization's active members, the choices for spokespeople (any active
-- member may speak for the organization). Returned only to people who may
-- name them; bounded so the form stays usable.
create function private.organization_start_members(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId', member.user_id, 'name', member.name) order by member.name, member.user_id), '[]'::jsonb)
  from (
    select membership.user_id, private.member_support_member_label(membership.user_id) as name
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.status = 'active'
    order by private.member_support_member_label(membership.user_id), membership.user_id
    limit 200
  ) member;
$function$;

revoke all on function private.organization_start_members(uuid) from public, anon, authenticated, service_role;

-- The seven milestones' facts for one organization, computed now.
create function private.organization_start_milestones(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := p_organization_id;
  state_row private.organization_start_guide_state%rowtype;
  founder uuid;
  chapters_n integer;
  worksites_n integer;
  grants_n integer;
  invitations_n integer;
  steps_n integer;
  announcements_n integer;
  events_n integer;
  knowledge_n integer;
  ballots_n integer;
  support_n integer;
  spokes_n integer;
begin
  select * into state_row from private.organization_start_guide_state s where s.organization_id = org;

  select pg_catalog.count(*)::integer into chapters_n
  from public.chapters c where c.organization_id = org;
  worksites_n := coalesce(pg_catalog.cardinality(
    private.organization_setting_text_list(org, 'lists.organizing.worksites')), 0);

  -- The founding administrator is the earliest admin grant; every other
  -- grant (another person, or another role) is someone brought in.
  select g.user_id into founder
  from public.organization_role_grants g
  where g.organization_id = org and g.role = 'admin'
  order by g.granted_at, g.user_id
  limit 1;
  select pg_catalog.count(*)::integer into grants_n
  from public.organization_role_grants g
  where g.organization_id = org and g.user_id is distinct from founder;
  select pg_catalog.count(*)::integer into invitations_n
  from public.member_invitations i
  join public.chapters c on c.id = i.chapter_id
  where c.organization_id = org and i.sent_at is not null;

  select pg_catalog.count(*)::integer into steps_n
  from public.organization_onboarding_steps s
  where s.organization_id = org and s.active;

  select pg_catalog.count(*)::integer into announcements_n
  from public.member_broadcasts b
  where b.organization_id = org and b.retracted_at is null;
  select pg_catalog.count(*)::integer into events_n
  from public.member_events e
  join public.chapters c on c.id = e.chapter_id
  where c.organization_id = org and e.cancelled_at is null;
  select (
    (select pg_catalog.count(*) from public.knowledge_collection_items k where k.organization_id = org)
    + (select pg_catalog.count(*) from public.organization_knowledge_files f where f.organization_id = org and f.review_status = 'approved')
  )::integer into knowledge_n;

  select pg_catalog.count(*)::integer into ballots_n
  from public.member_ballots b where b.organization_id = org and b.ballot_type = 'standard';

  select pg_catalog.count(*)::integer into support_n
  from public.organization_hr_directory d
  where d.organization_id = org and d.enabled and pg_catalog.btrim(d.name) <> '';

  select pg_catalog.count(*)::integer into spokes_n
  from private.organization_start_spokespeople sp
  where sp.organization_id = org;

  return pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('id', 'structure', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'chapters', 'done', chapters_n > 0, 'count', chapters_n, 'adminOnly', true),
      pg_catalog.jsonb_build_object('id', 'worksites', 'done', worksites_n > 0, 'count', worksites_n, 'adminOnly', true))),
    pg_catalog.jsonb_build_object('id', 'people', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'staffGrants', 'done', grants_n > 0, 'count', grants_n, 'adminOnly', true),
      pg_catalog.jsonb_build_object('id', 'invitationsSent', 'done', invitations_n > 0, 'count', invitations_n, 'adminOnly', true))),
    pg_catalog.jsonb_build_object('id', 'onboarding', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'activeSteps', 'done', steps_n > 0, 'count', steps_n, 'adminOnly', false),
      pg_catalog.jsonb_build_object('id', 'switchesReviewed', 'done', state_row.switches_reviewed_at is not null, 'count', 0, 'adminOnly', true))),
    pg_catalog.jsonb_build_object('id', 'content', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'announcements', 'done', announcements_n > 0, 'count', announcements_n, 'adminOnly', false),
      pg_catalog.jsonb_build_object('id', 'events', 'done', events_n > 0, 'count', events_n, 'adminOnly', false),
      pg_catalog.jsonb_build_object('id', 'knowledgeItems', 'done', knowledge_n > 0, 'count', knowledge_n, 'adminOnly', false))),
    pg_catalog.jsonb_build_object('id', 'ballot', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'ballotDraftWithSecrecy', 'done', ballots_n > 0, 'count', ballots_n, 'adminOnly', false))),
    pg_catalog.jsonb_build_object('id', 'support', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'supportPrograms', 'done', support_n > 0, 'count', support_n, 'adminOnly', false))),
    pg_catalog.jsonb_build_object('id', 'backups', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'backupNamed', 'done', state_row.backup_user_id is not null, 'count', 0, 'adminOnly', false),
      pg_catalog.jsonb_build_object('id', 'spokespeople', 'done', spokes_n > 0, 'count', spokes_n, 'adminOnly', false)))
  );
end;
$function$;

revoke all on function private.organization_start_milestones(uuid) from public, anon, authenticated, service_role;

create function private.organization_start_all_done(p_milestones jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select not exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_milestones) milestone,
         pg_catalog.jsonb_array_elements(milestone->'checks') check_row
    where coalesce((check_row->>'done')::boolean, false) is not true
  );
$function$;

revoke all on function private.organization_start_all_done(jsonb) from public, anon, authenticated, service_role;

create function public.get_organization_start_guide()
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
  -- Case-graph gate first, like every writer of an identity-linked table.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
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
      -- Latch once: from here on the guide is live whatever happens later.
      insert into private.organization_start_guide_state as s (organization_id, live_at, updated_at)
      values (org, pg_catalog.now(), pg_catalog.now())
      on conflict (organization_id) do update
        set live_at = coalesce(s.live_at, excluded.live_at), updated_at = pg_catalog.now()
      returning * into state_row;
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

create function public.mark_organization_start_switches_reviewed()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
begin
  -- Case-graph gate first, like every writer of an identity-linked table.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  org := private.current_mobile_staff_organization();
  if caller is null or org is null or not private.has_organization_role(org, array['admin']) then
    raise exception 'organization administrator and MFA required' using errcode = '42501';
  end if;
  insert into private.organization_start_guide_state as s (organization_id, switches_reviewed_at, updated_at)
  values (org, pg_catalog.now(), pg_catalog.now())
  on conflict (organization_id) do update
    set switches_reviewed_at = coalesce(s.switches_reviewed_at, excluded.switches_reviewed_at),
        updated_at = pg_catalog.now();
  return public.get_organization_start_guide();
end;
$function$;

create function public.save_organization_start_contacts(p_backup_user_id uuid, p_spokesperson_user_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
  spokes uuid[];
begin
  -- Case-graph gate first, like every writer of an identity-linked table.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  org := private.current_mobile_staff_organization();
  if caller is null or org is null or not private.has_organization_role(org, array['admin','vp']) then
    raise exception 'organization administrator or leadership and MFA required' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.array_agg(distinct id order by id), '{}'::uuid[]) into spokes
  from pg_catalog.unnest(coalesce(p_spokesperson_user_ids, '{}'::uuid[])) id
  where id is not null;
  if pg_catalog.cardinality(spokes) > 10 then
    raise exception 'at most ten spokespeople' using errcode = '22023';
  end if;
  -- The backup holds an organization-wide role; a spokesperson is an active
  -- member of this organization. Anyone else is refused, never stored.
  if p_backup_user_id is not null and not exists (
    select 1
    from public.organization_role_grants g
    join public.organization_memberships m
      on m.organization_id = g.organization_id and m.user_id = g.user_id and m.status = 'active'
    where g.organization_id = org and g.user_id = p_backup_user_id
  ) then
    raise exception 'backup must hold an organization-wide role' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(spokes) id
    where not exists (
      select 1 from public.organization_memberships m
      where m.organization_id = org and m.user_id = id and m.status = 'active'
    )
  ) then
    raise exception 'spokespeople must be active members of this organization' using errcode = '22023';
  end if;
  insert into private.organization_start_guide_state as s
    (organization_id, backup_user_id, contacts_saved_at, updated_at)
  values (org, p_backup_user_id, pg_catalog.now(), pg_catalog.now())
  on conflict (organization_id) do update
    set backup_user_id = excluded.backup_user_id,
        contacts_saved_at = excluded.contacts_saved_at,
        updated_at = pg_catalog.now();
  delete from private.organization_start_spokespeople sp
  where sp.organization_id = org and sp.user_id <> all(spokes);
  insert into private.organization_start_spokespeople (organization_id, user_id)
  select org, id from pg_catalog.unnest(spokes) id
  on conflict (organization_id, user_id) do nothing;
  return public.get_organization_start_guide();
end;
$function$;

create function public.acknowledge_organization_start_celebration()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
begin
  -- Case-graph gate first, like every writer of an identity-linked table.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  org := private.current_mobile_staff_organization();
  if caller is null or org is null or not private.has_organization_role(org, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'organization-wide role and MFA required' using errcode = '42501';
  end if;
  update private.organization_start_guide_state s
     set celebrated_at = coalesce(s.celebrated_at, pg_catalog.now()),
         updated_at = pg_catalog.now()
   where s.organization_id = org and s.live_at is not null;
  return public.get_organization_start_guide();
end;
$function$;

revoke all on function public.get_organization_start_guide() from public, anon, authenticated, service_role;
revoke all on function public.mark_organization_start_switches_reviewed() from public, anon, authenticated, service_role;
revoke all on function public.save_organization_start_contacts(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.acknowledge_organization_start_celebration() from public, anon, authenticated, service_role;
grant execute on function public.get_organization_start_guide() to authenticated;
grant execute on function public.mark_organization_start_switches_reviewed() to authenticated;
grant execute on function public.save_organization_start_contacts(uuid, uuid[]) to authenticated;
grant execute on function public.acknowledge_organization_start_celebration() to authenticated;

comment on function public.get_organization_start_guide() is
  'Org-start guide for an organization-wide role holder with MFA met: seven milestones computed from the organization''s records, latched live once all hold (never reopens). Others get {"state":"hidden"}.';
comment on function public.mark_organization_start_switches_reviewed() is
  'Organization administrator records that the five guide switches were reviewed (org-start milestone 3). Idempotent; keeps the first review.';
comment on function public.save_organization_start_contacts(uuid, uuid[]) is
  'Organization administrator or org-wide leadership names the backup (an org-wide role holder) and up to ten spokespeople (active members) for org-start milestone 7.';
comment on function public.acknowledge_organization_start_celebration() is
  'Any org-wide role holder closes the once-per-organization "You''re live" card after the guide is latched live.';

insert into private.account_lifecycle_trigger_review(kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private'
  and table_name in ('organization_start_guide_state', 'organization_start_spokespeople')
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $$ begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the org-start guide';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle manifest is incomplete after the org-start guide';
  end if;
end; $$;

notify pgrst, 'reload schema';

commit;
