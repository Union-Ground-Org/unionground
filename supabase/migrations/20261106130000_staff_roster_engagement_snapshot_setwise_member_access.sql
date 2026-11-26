-- BUG-UG-ADMIN-DESK-AND-ENGAGEMENT-STUDIO-STATEMENT-TIMEOUT-AT-SCALE-20261106 (#7170).
-- At about 1,000 accounts public.get_staff_roster (the admin desk) and
-- public.get_staff_engagement_snapshot (the engagement studio's first read)
-- ran past the 30 s statement limit. Both filtered public.member_profiles with
-- the per-row private.chapter_member_readable(id), which calls
-- public.staff_can_see_user once per staff role for every profile in the
-- database, and each call re-resolves the caller's MFA, organization and
-- roles. Only that predicate changes: it becomes its set-wise equivalent, the
-- caller's own row or private.staff_visible_member_ids (the set-wise
-- public.staff_can_see_user) for the same five roles, computed once per
-- statement. Rows, columns, order and refusals are unchanged.
begin;

-- Replace only the exact predecessors 20261102005607 installed.
do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_staff_roster()'::regprocedure)) <> '9789e7d96df9c298d5c24cff85a043b0' then raise exception 'unreviewed predecessor: public.get_staff_roster' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_staff_roster()' and definition_hash<>'9789e7d96df9c298d5c24cff85a043b0') then raise exception 'stale trigger receipt: public.get_staff_roster' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_staff_engagement_snapshot()'::regprocedure)) <> '1fa635fe0d047b408c2d206615355264' then raise exception 'unreviewed predecessor: public.get_staff_engagement_snapshot' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_staff_engagement_snapshot()' and definition_hash<>'1fa635fe0d047b408c2d206615355264') then raise exception 'stale trigger receipt: public.get_staff_engagement_snapshot' using errcode='55000'; end if;
end;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_staff_roster()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_staff_engagement_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.engagement_selected_organization();
  survey_page jsonb;
begin
  perform private.engagement_require_staff(org);
  survey_page := private.staff_engagement_survey_page(org, null, null, 20);
  return pg_catalog.jsonb_build_object(
    'surveys', survey_page -> 'surveys',
    'surveyCounts', survey_page -> 'counts',
    'surveyCursor', survey_page -> 'nextCursor',
    'pulsePrompts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', prompt.id, 'chapterId', prompt.chapter_id,
        'eventKey', prompt.event_key, 'question', prompt.question,
        'options', prompt.options, 'active', prompt.active,
        'cooldownHours', prompt.cooldown_hours,
        'shown', case when private.organization_is_union(prompt.organization_id) then (select pg_catalog.count(*) from public.organization_pulse_events event where event.prompt_id = prompt.id) else null end,
        'responded', case when private.organization_is_union(prompt.organization_id) then (select pg_catalog.count(*) from public.organization_pulse_events event where event.prompt_id = prompt.id and event.state = 'responded') else null end
      ) order by prompt.updated_at desc)
      from public.organization_pulse_prompts prompt where prompt.organization_id = org
    ), '[]'::jsonb),
    'livePolls', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', poll.id, 'title', poll.title, 'description', poll.description,
        'state', poll.state, 'eligibility', poll.eligibility,
        'resultsVisibility', poll.results_visibility,
        'scheduledAt', poll.scheduled_at, 'opensAt', poll.opens_at,
        'closesAt', poll.closes_at, 'closedAt', poll.closed_at,
        'quorumTarget', poll.quorum_target, 'voteCount', case when private.organization_is_union(poll.organization_id) then poll.vote_count else null end,
        'results', case when private.organization_is_union(poll.organization_id) then poll.result_cache else '[]'::jsonb end,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', option.id, 'label', option.label, 'sortIndex', option.sort_index
          ) order by option.sort_index)
          from public.organization_live_poll_options option where option.poll_id = poll.id
        ), '[]'::jsonb),
        'attendance', case when private.organization_is_union(poll.organization_id) then pg_catalog.jsonb_build_object(
          'roster', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.eligible),
          'rsvpYes', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.rsvp = 'yes'),
          'checkedIn', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.checked_in_at is not null)
        ) else null end
      ) order by coalesce(poll.opens_at, poll.scheduled_at, poll.created_at) desc)
      from public.organization_live_polls poll where poll.organization_id = org
    ), '[]'::jsonb),
    'delivery', coalesce((
      select pg_catalog.jsonb_object_agg(summary.state, summary.count)
      from (
        select outbox.state, pg_catalog.count(*)::integer as count
        from public.engagement_delivery_outbox outbox
        where outbox.organization_id = org group by outbox.state
      ) summary
    ), '{}'::jsonb),
    'presence', pg_catalog.jsonb_build_object(
      'online', (select pg_catalog.count(*) from public.member_presence presence where presence.organization_id = org and presence.status = 'online' and presence.last_seen_at >= pg_catalog.now() - interval '2 minutes'),
      'away', (select pg_catalog.count(*) from public.member_presence presence where presence.organization_id = org and presence.last_seen_at >= pg_catalog.now() - interval '15 minutes')
    ),
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', chapter.id, 'name', chapter.name
      ) order by chapter.order_index, chapter.name, chapter.id)
      from public.chapters chapter
      where chapter.organization_id = org
    ), '[]'::jsonb),
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', membership.user_id,
        'name', coalesce(profile.full_name, 'Member'),
        'chapterId', profile.chapter_id
      ) order by coalesce(profile.full_name, ''), membership.user_id)
      from public.organization_memberships membership
      left join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) profile on profile.id = membership.user_id
      where membership.organization_id = org
        and membership.status = 'active' and membership.revoked_at is null
    ), '[]'::jsonb),
    'channels', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'spaceId', space.id, 'name', space.name,
        'chapterId', chapter.id, 'chapterName', chapter.name,
        'postingMode', coalesce(control.posting_mode, 'members'),
        'slowModeSeconds', coalesce(control.slow_mode_seconds, 0),
        'approvalsRequired', coalesce(control.approvals_required, false)
      ) order by chapter.order_index, chapter.name, chapter.id, space.name, space.id)
      from public.chapter_spaces space
      join public.chapters chapter on chapter.id = space.chapter_id and chapter.organization_id = org
      left join public.chapter_space_controls control on control.space_id = space.id
      where space.archived_at is null
    ), '[]'::jsonb)
  );
end;
$function$
;

-- Both functions keep their grants. A function the account-lifecycle trigger
-- surface reaches keeps a current receipt; absent receipts stay absent.
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(
     ('public.' || reviewed.object_name)::regprocedure))
 where reviewed.kind = 'function' and reviewed.schema_name = 'public'
   and reviewed.table_name = ''
   and reviewed.object_name in ('get_staff_roster()', 'get_staff_engagement_snapshot()');

commit;
