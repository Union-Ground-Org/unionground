-- BUG-UG-ORG-START-GUIDE-COUNTS-FOUNDER-RECORDS-20261102 (#6795).
--
-- The organization start guide credited a brand-new founder with work not
-- yet done, and so disagreed with the admin launch checklist
-- (src/features/orgSetup/AdminLaunchChecklist.jsx):
--   * "invitationsSent" counted every sent invitation in the organization,
--     including the founder's own founder invitation, so a new organization
--     showed "1 invitation sent". It now leaves out kind 'founder', as the
--     checklist does.
--   * "chapters" was done with one chapter, which the founder's starting
--     chapter already is, so "Set up your structure" showed Done while the
--     checklist's structure step showed Not done. It is now done once a
--     chapter exists besides the starting one (more than one), the
--     checklist's rule. The count stays the number of chapters.
-- Nothing else in private.organization_start_milestones changes: signature,
-- security definer, search_path, every other check and the revoke are as in
-- 20261030201200. An organization already latched live stays live.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

-- Pin the predecessor (20261030201200) so a concurrent change is not lost.
do $assert_organization_start_milestones$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = 'private.organization_start_milestones(uuid)'::pg_catalog.regprocedure)
      <> 'a020a1e55ac67ff8fcff5cacda1a2a79' then
    raise exception 'Unreviewed organization start milestones predecessor: integrate current Main before changing the founder counts';
  end if;
end;
$assert_organization_start_milestones$;

create or replace function private.organization_start_milestones(p_organization_id uuid)
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
  -- Worksites named in the profile suggestion list, plus the units and
  -- worksites set up inside chapters on the Organization page.
  worksites_n := coalesce(pg_catalog.cardinality(
    private.organization_setting_text_list(org, 'lists.organizing.worksites')), 0)
    + (select pg_catalog.count(*)::integer from private.chapter_units u where u.organization_id = org);

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
  -- The founder's own invitation (kind founder) opened the organization; it
  -- is not the administrator inviting anyone.
  select pg_catalog.count(*)::integer into invitations_n
  from public.member_invitations i
  join public.chapters c on c.id = i.chapter_id
  where c.organization_id = org and i.sent_at is not null
    and i.kind is distinct from 'founder';

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
      -- The starting chapter comes with the organization; structure needs a
      -- chapter added besides it, as on the admin launch checklist.
      pg_catalog.jsonb_build_object('id', 'chapters', 'done', chapters_n > 1, 'count', chapters_n, 'adminOnly', true),
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

commit;
