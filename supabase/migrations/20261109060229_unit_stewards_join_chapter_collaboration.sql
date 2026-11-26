-- REQ-UG-CHAPTER-STEWARDS-COLLABORATE-ACROSS-UNITS-20261109 (#7665).
-- Owner direction (Nov 9, 2026): every steward will belong to a unit inside a
-- chapter, member personal details stay inside that unit, and all stewards of
-- the chapter still collaborate and stay informed chapter-wide.
--
-- private.member_has_chapter_role deliberately ignores a role that carries a
-- unit or committee scope (20261102005607, live at 20261106221000:602): a
-- scoped grant is never a chapter-wide grant, and the member-data gates rely on
-- that meaning. So a unit-scoped steward fails every chapter staff gate built
-- on it, including gates that hold no member data at all.
--
-- private.member_has_chapter_staff_grant is the same test with one change: a
-- unit scope counts, and a committee scope counts while the committee is in
-- its dates (the rule private.chapter_office_role_present already applies).
-- member_has_chapter_role itself is unchanged.
--
-- The new helper replaces member_has_chapter_role only in gates that hold no
-- member personal details: bargaining workspaces, chapter documents, the
-- learning library, chapter tasks and their undo, task templates, reply
-- templates, chapter-to-chapter handshakes and connections, the member Q&A
-- officer gate (the board is readable chapter-wide), stewards' own workload
-- logs and the Compass bargaining counts. Every definition below is the live
-- one, re-emitted with only that call swapped.
-- update_chapter_document_content and share_chapter_handshake_document also
-- ask private.chapter_document_container_allows: as security definer RPCs
-- they bypass the restrictive container policy, so a staff grant limited to
-- one unit must not reach a document kept in another unit through them.
--
-- Not changed here: unit-container restrictions on documents and records
-- (chapter_documents_container_scope keeps a unit document inside its unit),
-- staff channels and the steward list (actor_has_chapter_staff_role and
-- member_stewards_for_chapter already ignore scopes), and every gate that
-- reads member data or sends to members: records, contacts and their roster,
-- appointments, seniority, access events and notices.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

create function private.member_has_chapter_staff_grant(p_chapter_id text, p_roles text[])
 returns boolean
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
begin
  return (
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
                and not private.chapter_role_scope_expired(rc.user_id, rc.chapter_id, rc.role)
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
                    and not private.chapter_role_scope_expired(rc.user_id, rc.chapter_id, rc.role)
                    and rc.chapter_id = p_chapter_id
                    and m.status = 'active'
                )
              )
          )
        )
      )
  )
  );
end;
$function$;

-- A unit scope never expires. A committee scope lapses outside the
-- committee's dates, so a lapsed committee grant opens no chapter staff gate.
create function private.chapter_role_scope_expired(p_user uuid, p_chapter text, p_role text)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select exists (
    select 1
    from private.chapter_role_scopes scope
    join private.chapter_committees committee
      on committee.id = scope.committee_id and committee.chapter_id = scope.chapter_id
    where scope.user_id = p_user and scope.chapter_id = p_chapter and scope.role = p_role
      and not (committee.starts_on <= current_date and (committee.ends_on is null or committee.ends_on >= current_date))
  );
$function$;

-- The caller's reach into one chapter document container: the exact test of
-- the restrictive chapter_documents_container_scope policy. Security definer
-- RPCs that read or change a document bypass that policy, so they ask this
-- before trusting a staff grant that may be limited to another unit.
create function private.chapter_document_container_allows(p_chapter text, p_unit uuid, p_committee uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select (p_unit is null and p_committee is null)
    or private.member_has_chapter_role(p_chapter, array['steward','coordinator','advisor','admin','vp'])
    or private.chapter_officer_can_for_scope(p_chapter, 'documents', p_unit, p_committee)
    or private.chapter_scope_member_allowed(p_chapter, p_unit, p_committee, (select auth.uid()));
$function$;

revoke all on function private.chapter_document_container_allows(text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.chapter_role_scope_expired(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.member_has_chapter_staff_grant(text, text[]) from public, anon, authenticated, service_role;
grant execute on function private.member_has_chapter_staff_grant(text, text[]) to authenticated;

comment on function private.member_has_chapter_staff_grant(text, text[]) is
  'REQ-UG-CHAPTER-STEWARDS-COLLABORATE-ACROSS-UNITS-20261109: member_has_chapter_role that also admits a unit-scoped or in-date committee-scoped grant. Use only for chapter staff collaboration gates that hold no member personal details; member-data gates stay on member_has_chapter_role plus a per-member check.';

-- private.casework_macro_audience (live definition 20260918201000_casework_macro_audience_predicate.sql:75; 2 call(s) swapped)
create or replace function private.casework_macro_audience(
  p_organization_id uuid,
  p_chapter_id text,
  p_authorship boolean default false
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.has_organization_role(p_organization_id, array['steward','coordinator','advisor','admin','vp'])
    and (p_chapter_id is null
      or private.member_has_chapter_staff_grant(p_chapter_id, array['steward','coordinator','advisor','admin','vp']))
    -- Authorship is the read audience plus one term, never an alternative to
    -- it. coalesce keeps a null argument on the reading side rather than
    -- letting it three-value its way past the conjunct.
    and (not coalesce(p_authorship, false)
      or case when p_chapter_id is null
           then private.has_organization_role(p_organization_id, array['admin','vp'])
           else private.member_has_chapter_staff_grant(p_chapter_id, array['coordinator','admin','vp'])
         end);
$function$;

-- private.chapter_connection_workspace (live definition 20260928221008_unified_connection_handshakes.sql:101; 1 call(s) swapped)
create or replace function private.chapter_connection_workspace(
  p_organization_id uuid,
  p_chapter_id text,
  p_can_publish boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  row_data private.chapter_connection_profiles%rowtype;
  chapter_name text;
  has_row boolean;
  quarter record;
  latest_period text;
  latest_frozen_at timestamptz;
  profile jsonb;
  draft jsonb;
  analysis jsonb;
begin
  select c.name into chapter_name from public.chapters c where c.id = p_chapter_id;
  select * into row_data
  from private.chapter_connection_profiles p
  where p.chapter_id = p_chapter_id and p.organization_id = p_organization_id;
  has_row := found;

  profile := case
    when has_row
      and row_data.publication_status = 'published'
      and row_data.expires_at > pg_catalog.now()
    then private.chapter_connection_profile_projection(row_data, chapter_name)
    else null
  end;

  draft := case when has_row then pg_catalog.jsonb_build_object(
    'kind', row_data.kind,
    'location', pg_catalog.jsonb_build_object(
      'country', row_data.location_country,
      'state', row_data.location_state,
      'metro', row_data.location_metro
    ),
    'sectorKeys', pg_catalog.to_jsonb(row_data.sector_keys),
    'expertiseOffered', pg_catalog.to_jsonb(row_data.expertise_offered),
    'declaredIssueKeys', pg_catalog.to_jsonb(row_data.declared_issue_keys),
    'declaredLocalKey', row_data.declared_local_key,
    'declaredUnionFamilyKey', row_data.declared_union_family_key,
    'shareAnalyzedIssues', row_data.share_analyzed_issues,
    'profileRevision', row_data.profile_revision,
    'publication', pg_catalog.jsonb_build_object(
      'status', row_data.publication_status,
      'version', row_data.publication_version,
      'publishedAt', row_data.published_at,
      'expiresAt', row_data.expires_at,
      'withdrawnAt', row_data.withdrawn_at,
      'expired', row_data.publication_status = 'published' and row_data.expires_at <= pg_catalog.now()
    ),
    'consent', pg_catalog.jsonb_build_object(
      'version', row_data.consent_version,
      'recordedAt', row_data.consent_recorded_at,
      'hat', row_data.consent_hat
    ),
    'updatedAt', row_data.updated_at
  ) else null end;

  select * into quarter from private.chapter_connection_previous_quarter();
  select r.period_key, r.frozen_at into latest_period, latest_frozen_at
  from private.chapter_connection_aggregate_runs r
  where r.chapter_id = p_chapter_id
  order by r.period_key desc
  limit 1;
  analysis := pg_catalog.jsonb_build_object(
    'nextPeriodKey', quarter.period_key,
    'nextPeriodFrozen', exists (
      select 1 from private.chapter_connection_aggregate_runs r
      where r.chapter_id = p_chapter_id and r.period_key = quarter.period_key
    ),
    'latest', case when latest_period is null then null else pg_catalog.jsonb_build_object(
      'periodKey', latest_period,
      'frozenAt', latest_frozen_at,
      'topics', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', a.topic_key, 'band', a.band) order by a.topic_key)
        from private.chapter_connection_issue_aggregates a
        where a.chapter_id = p_chapter_id and a.period_key = latest_period
      ), '[]'::jsonb)
    ) end
  );

  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'chapterId', p_chapter_id,
    'chapterName', chapter_name,
    'profile', profile,
    'draft', draft,
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'name', c.name) order by c.order_index, c.name, c.id)
      from public.chapters c
      where c.organization_id = p_organization_id
    ), '[]'::jsonb),
    'canPublish', coalesce(p_can_publish, false),
    'canRequestHandshake', coalesce(
      p_chapter_id = private.current_member_chapter()
      and private.member_has_chapter_staff_grant(p_chapter_id, array['steward','coordinator','advisor','admin','vp']),
      false
    ),
    'hiddenChapterIds', coalesce((
      select pg_catalog.jsonb_agg(h.hidden_chapter_id order by h.hidden_chapter_id)
      from private.chapter_connection_hides h
      where h.chapter_id = p_chapter_id
    ), '[]'::jsonb),
    'analysis', analysis,
    'taxonomy', pg_catalog.jsonb_build_object(
      'issueKeys', pg_catalog.to_jsonb(private.chapter_connection_issue_keys()),
      'sectorKeys', pg_catalog.to_jsonb(private.chapter_connection_sector_keys()),
      'expertiseKeys', pg_catalog.to_jsonb(private.chapter_connection_expertise_keys()),
      'bands', pg_catalog.jsonb_build_array('some', 'many', 'most'),
      'consentVersion', private.chapter_connection_consent_version(),
      'publicationDays', private.chapter_connection_publication_days()
    )
  );
end;
$function$;

-- private.cw_reminder_json (live definition 20261003033000_remind_here_and_steward_email_routing.sql:573; 1 call(s) swapped)
create or replace function private.cw_reminder_json(p_row public.member_message_reminders, p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  api_kind text := private.cw_reminder_api_kind(p_row.source_kind);
  source_id text := private.cw_reminder_source_id(p_row);
  src jsonb;
  -- Exact tenant membership: no active chapter+organization membership, no source.
  available boolean;
  route text := null;
  channel_name text := null;
begin
  if p_row.source_kind = 'space' then
    -- A here reminder's source is its channel, re-authorized for the owner.
    select s.name into channel_name
    from public.chapter_spaces s
    where s.id::text = source_id
      and private.remind_here_staff_reads_space(p_actor, s.id);
    available := channel_name is not null and private.current_member_organization() is not null;
    return pg_catalog.jsonb_build_object(
      'id', p_row.id,
      'kind', api_kind,
      'audience', 'here',
      'sourceId', case when available then source_id end,
      'remindAt', p_row.remind_at,
      'note', p_row.note,
      'status', p_row.status,
      'snoozeCount', p_row.snooze_count,
      'completedAt', p_row.completed_at,
      'createdAt', p_row.created_at,
      'updatedAt', coalesce(p_row.updated_at, p_row.created_at),
      'available', available,
      'sourceState', case when available then 'available' else 'unavailable' end,
      'href', null,
      'title', case when available then channel_name end);
  end if;
  src := private.cw_resolve_source(p_actor, api_kind, source_id);
  available := coalesce((src ->> 'ok')::boolean, false)
    and private.current_member_organization() is not null;
  if available then
    route := src ->> 'href';
    if api_kind = 'task'
       and not private.member_has_chapter_staff_grant(
         src ->> 'chapterId', array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
      route := null;
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'id', p_row.id,
    'kind', api_kind,
    'sourceId', case when available then source_id end,
    'remindAt', p_row.remind_at,
    'note', p_row.note,
    'status', case p_row.status when 'pending' then 'scheduled' else p_row.status end,
    'snoozeCount', p_row.snooze_count,
    'completedAt', p_row.completed_at,
    'createdAt', p_row.created_at,
    'updatedAt', coalesce(p_row.updated_at, p_row.created_at),
    'available', available,
    'sourceState', case when available then src ->> 'state' else 'unavailable' end,
    'href', route,
    'title', case when available and api_kind in ('task', 'event') then src ->> 'title' end);
end;
$function$;

-- private.cw_task_recipients (live definition 20261001020000_connected_workflow_shortcuts.sql:687; 1 call(s) swapped)
create or replace function private.cw_task_recipients(p_actor uuid, p_task uuid)
returns table (rid uuid, rlabel text, rvia text, rtarget uuid)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  task_row public.chapter_tasks%rowtype;
  actor_chapter text;
  counterpart uuid;
  steward_ready boolean;
begin
  select tk.* into task_row from public.chapter_tasks tk where tk.id = p_task and tk.deleted_at is null;
  if not found then return; end if;
  select p.chapter_id into actor_chapter from public.member_profiles p where p.id = p_actor;
  if actor_chapter is null or actor_chapter is distinct from task_row.chapter_id then return; end if;
  -- Only the task's own people (creator, assignee) or chapter staff may enumerate
  -- its audience; a member who merely reads the board is offered no one.
  if not (
    p_actor = task_row.created_by
    or exists (select 1 from public.chapter_task_assignments a
               where a.task_id = task_row.id and a.assignee_id = p_actor)
    or private.member_has_chapter_staff_grant(
         task_row.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
  ) then
    return;
  end if;
  counterpart := case
    when p_actor = task_row.assignee_id then task_row.created_by
    when p_actor = task_row.created_by then task_row.assignee_id end;
  steward_ready := coalesce(public.member_has_role(array['steward']), false);
  return query
  select e.uid, e.label, pick.via, pick.target_id
  from (
    select pr.id as uid,
           coalesce(nullif(pg_catalog.btrim(pr.full_name), ''), 'Member') as label
    from (
      select task_row.created_by as uid
      union
      select a.assignee_id from public.chapter_task_assignments a where a.task_id = task_row.id
    ) part
    join public.member_profiles pr on pr.id = part.uid and pr.chapter_id = task_row.chapter_id
    where part.uid is not null and part.uid <> p_actor
  ) e
  cross join lateral (
    select v.via, v.target_id
    from (
      select 1 as prio, 'task_thread'::text as via, task_row.id as target_id
        where e.uid = counterpart
      union all
      -- peer: the exact authorization public.send_reward_peer_message applies is
      -- membership of an EXISTING member_peer_conversations row. Such a row is
      -- created only from an accepted contact request, and the product has no
      -- revoke/unfriend path (accepted consent is durable by design, 20260812233000),
      -- so existence of the row IS the current-contact predicate. We advertise
      -- exactly that, no looser and no stricter.
      select 2, 'peer', c.id
        from public.member_peer_conversations c
        where (c.user_low = p_actor and c.user_high = e.uid) or (c.user_low = e.uid and c.user_high = p_actor)
      union all
      select 3, 'steward_reply', cv.id
        from public.member_conversations cv
        where steward_ready and cv.user_id = e.uid
          and private.can_actor_send_private_message(p_actor, cv.id, 'steward')
      union all
      select 4, 'steward_start', null::uuid
        where exists (
          select 1 from private.member_roster_stewards_for_chapter(actor_chapter) rs
          where rs.steward_id = e.uid)
    ) v
    order by v.prio, v.target_id
    limit 1
  ) pick;
end;
$function$;

-- private.learning_undo_task (live definition 20261106220000_conflict_refusals_not_retried.sql:940; 1 call(s) swapped)
create or replace function private.learning_undo_task(p_mode text, p_entry jsonb)
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
  target uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  task_row public.chapter_tasks%rowtype;
  wanted uuid[];
  current_ids uuid[];
  was_live boolean;
  caller_name text;
  recipient uuid;
begin
  if p_mode = 'lock' then
    perform 1 from public.chapter_tasks t where t.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_task_state(target) - 'order_index';
  elsif p_mode = 'before' then
    if p_entry ->> 'action_kind' = 'task_create' then return null; end if;
    return image - 'order_index';
  elsif p_mode = 'check' then
    -- Today's rule for changing a task: staff of the task's own chapter.
    select t.* into task_row
    from public.chapter_tasks t
    join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
    where t.id = target;
    if task_row.id is null or not private.member_has_chapter_staff_grant(task_row.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
      raise exception 'you can no longer change this task' using errcode = '42501';
    end if;
    -- Undoing a creation hides the task; refuse when someone else's
    -- check-off work hangs off it, which would be hidden with it.
    if p_entry ->> 'action_kind' = 'task_create' and (
        exists (select 1 from private.task_checkoff_lists l where l.task_id = target and l.created_by is distinct from caller)
        or exists (select 1 from private.task_checkoff_entries e
          where e.task_id = target and e.actioned_by is not null and e.actioned_by is distinct from caller)) then
      raise exception 'someone else has changed this since' using errcode = 'PT409';
    end if;
    -- Conversion also changed a staff-managed report. Changing the task or
    -- case alone is insufficient: recheck convert_member_intake_report's
    -- current role and same-chapter readable-profile predicate before any
    -- restoring write. An ordinary creation carries no report image.
    if p_entry -> 'before_image' -> 'intake_report' ->> 'id' is not null
       and (not public.member_has_role(array['steward', 'coordinator'])
         or not exists (
           select 1 from public.member_intake_reports r
           join public.member_profiles p on p.id = caller
           where r.id = (p_entry -> 'before_image' -> 'intake_report' ->> 'id')::uuid
             and p.chapter_id = r.chapter_id)) then
      raise exception 'intake staff role required' using errcode = '42501';
    end if;
    -- A report the record was converted from must still stand as conversion
    -- left it; anyone's later triage refuses the undo.
    if not private.learning_intake_report_unchanged(p_entry -> 'before_image' -> 'intake_report') then
      raise exception 'someone else has changed this since' using errcode = 'PT409';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  select p.full_name into caller_name from public.member_profiles p where p.id = caller;
  if p_entry ->> 'action_kind' = 'task_create' then
    update public.chapter_tasks t
    set deleted_at = pg_catalog.now(), deleted_by = caller
    where t.id = target and t.deleted_at is null
    returning t.* into task_row;
    -- The task goes away as a deletion does, and its assignee hears so.
    if task_row.assignee_id is not null and task_row.assignee_id <> caller then
      perform private.notify_member(task_row.assignee_id, 'task.deleted',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
    end if;
    -- An intake report converted into the task goes back to how it stood.
    perform private.learning_restore_intake_report(p_entry -> 'before_image' -> 'intake_report');
    return null;
  end if;

  select t.deleted_at is null into was_live from public.chapter_tasks t where t.id = target;

  update public.chapter_tasks t
  set title = image ->> 'title',
      description = image ->> 'description',
      status = image ->> 'status',
      priority = image ->> 'priority',
      workstream = image ->> 'workstream',
      start_date = (image ->> 'start_date')::date,
      due_date = (image ->> 'due_date')::date,
      progress = (image ->> 'progress')::smallint,
      blocked = (image ->> 'blocked')::boolean,
      milestone = (image ->> 'milestone')::boolean,
      task_type = image ->> 'task_type',
      order_index = coalesce((image ->> 'order_index')::integer, t.order_index),
      deleted_at = case when (image ->> 'live')::boolean then null else coalesce(t.deleted_at, pg_catalog.now()) end,
      deleted_by = case when (image ->> 'live')::boolean then null else coalesce(t.deleted_by, caller) end
  where t.id = target
  returning t.* into task_row;

  -- Assignees as they were, in order, the way set_chapter_task_assignees
  -- writes them, and told the way it tells them: the task's own trigger
  -- notifies the primary assignee it gains or loses, and each co-assignee
  -- added or removed hears so here. What was already sent stays sent; each
  -- person's newest notice matches the task again.
  select coalesce(pg_catalog.array_agg(e.id::uuid order by e.position), '{}') into wanted
  from pg_catalog.jsonb_array_elements_text(coalesce(image -> 'assignee_ids', '[]'::jsonb)) with ordinality as e(id, position);
  select coalesce(pg_catalog.array_agg(a.assignee_id order by a.position), '{}') into current_ids
  from public.chapter_task_assignments a where a.task_id = target;
  if wanted is distinct from current_ids then
    delete from public.chapter_task_assignments a where a.task_id = target;
    insert into public.chapter_task_assignments (task_id, chapter_id, assignee_id, position, assigned_by)
    select target, task_row.chapter_id, ids.assignee_id, ids.ordinality - 1, caller
    from pg_catalog.unnest(wanted) with ordinality as ids(assignee_id, ordinality);
  end if;
  if task_row.assignee_id is distinct from wanted[1] then
    perform pg_catalog.set_config('sg.setting_task_assignees', '1', true);
    update public.chapter_tasks t set assignee_id = wanted[1] where t.id = target;
    -- Only this update skips the assignment sync; later writes in the same
    -- undo (or transaction) get it again.
    perform pg_catalog.set_config('sg.setting_task_assignees', '', true);
  end if;
  for recipient in
    select id from pg_catalog.unnest(wanted) id
    where not (id = any(current_ids)) and id is distinct from wanted[1] and id <> caller
  loop
    perform private.notify_member(recipient, 'task.assigned',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end loop;
  for recipient in
    select id from pg_catalog.unnest(current_ids) id
    where not (id = any(wanted)) and id is distinct from task_row.assignee_id and id <> caller
  loop
    perform private.notify_member(recipient, 'task.unassigned',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end loop;
  -- Putting a deleted task back, or taking a restored one away, tells its
  -- assignee the way soft_delete_chapter_task and restore_chapter_task do,
  -- so the last notice they hold matches the task.
  if was_live is distinct from (image ->> 'live')::boolean
     and wanted[1] is not null and wanted[1] <> caller then
    perform private.notify_member(wanted[1],
      case when (image ->> 'live')::boolean then 'task.restored' else 'task.deleted' end,
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end if;
  return null;
end;
end;
$function$;

-- private.learning_undo_task_edge (live definition 20261104075000_learning_period_case_records.sql:260; 1 call(s) swapped)
create or replace function private.learning_undo_task_edge(p_mode text, p_entry jsonb)
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
  target_table text := p_entry ->> 'target_table';
  target text := p_entry ->> 'target_id';
  image jsonb := p_entry -> 'before_image';
  adding boolean := p_entry ->> 'action_kind' in ('task_link_add', 'task_dependency_add', 'task_subtask_add', 'task_watch');
  state jsonb;
  task uuid;
  other uuid;
begin
  if p_mode = 'lock' then
    if target_table = 'public.chapter_task_attachments' then perform 1 from public.chapter_task_attachments a where a.id::text = target for update;
    elsif target_table = 'public.chapter_task_dependencies' then perform 1 from public.chapter_task_dependencies d where d.id::text = target for update;
    elsif target_table = 'public.chapter_task_subtasks' then perform 1 from public.chapter_task_subtasks s where s.id::text = target for update;
    else perform 1 from public.chapter_task_watchers w where w.task_id::text || ':' || w.user_id::text = target for update;
    end if;
    return null;
  elsif p_mode = 'state' then
    return private.learning_task_edge_state(target_table, target);
  elsif p_mode = 'before' then
    return case when adding then '{"live": false}'::jsonb else image end;
  end if;

  -- An added edge is judged as it stood after the add: in check mode the
  -- engine passes that projected state, since a later removal in the same
  -- chain has already taken the row away.
  state := case when adding then coalesce(
      case when p_mode = 'check' then nullif(p_entry -> 'projected_state', 'null'::jsonb) end,
      private.learning_task_edge_state(target_table, target))
    else image end;
  task := coalesce(state ->> 'task_id', state ->> 'parent_task_id')::uuid;
  if p_mode = 'check' then
    -- Each end is judged as this undo leaves it: a task a newer step in the
    -- chain puts back is live, one it takes away is not.
    other := case when not adding then coalesce(state ->> 'depends_on_id', state ->> 'subtask_id')::uuid end;
    if not exists (
        select 1 from public.chapter_tasks t join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
        where t.id = task
          and case when p_entry -> 'projected' ? ('public.chapter_tasks:' || t.id::text)
            then coalesce((p_entry -> 'projected' -> ('public.chapter_tasks:' || t.id::text) ->> 'live')::boolean, false)
            else t.deleted_at is null end)
      or (target_table = 'public.chapter_task_watchers' and (state ->> 'user_id')::uuid is distinct from caller)
      or (target_table <> 'public.chapter_task_watchers' and not private.member_has_chapter_staff_grant(
        (select t.chapter_id from public.chapter_tasks t where t.id = task), array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
      -- Putting a dependency or subtask link back needs its other end live,
      -- as the edge triggers require; refuse here instead of failing there.
      or (other is not null and not exists (
        select 1 from public.chapter_tasks t
        where t.id = other
          and case when p_entry -> 'projected' ? ('public.chapter_tasks:' || t.id::text)
            then coalesce((p_entry -> 'projected' -> ('public.chapter_tasks:' || t.id::text) ->> 'live')::boolean, false)
            else t.deleted_at is null end)) then
      raise exception 'you can no longer change this task' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if adding then
    if target_table = 'public.chapter_task_attachments' then
      delete from public.chapter_task_attachments a where a.id::text = target;
      insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value)
      select t.id, t.chapter_id, caller, 'attachment_removed', target from public.chapter_tasks t where t.id = task;
    elsif target_table = 'public.chapter_task_dependencies' then
      delete from public.chapter_task_dependencies d where d.id::text = target;
    elsif target_table = 'public.chapter_task_subtasks' then
      delete from public.chapter_task_subtasks s where s.id::text = target;
    else
      delete from public.chapter_task_watchers w where w.task_id::text || ':' || w.user_id::text = target;
    end if;
  elsif target_table = 'public.chapter_task_attachments' then
    insert into public.chapter_task_attachments (id, task_id, chapter_id, label, record_url, created_by, source_kind, source_id)
    select target::uuid, t.id, t.chapter_id, image ->> 'label', image ->> 'record_url', (image ->> 'created_by')::uuid,
      image ->> 'source_kind', image ->> 'source_id'
    from public.chapter_tasks t where t.id = task;
    insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, to_value)
    select t.id, t.chapter_id, caller, 'attachment_added', target from public.chapter_tasks t where t.id = task;
  elsif target_table = 'public.chapter_task_dependencies' then
    insert into public.chapter_task_dependencies (id, task_id, depends_on_id, created_by)
    values (target::uuid, task, (image ->> 'depends_on_id')::uuid, (image ->> 'created_by')::uuid);
  elsif target_table = 'public.chapter_task_subtasks' then
    insert into public.chapter_task_subtasks (id, parent_task_id, subtask_id, created_by)
    values (target::uuid, task, (image ->> 'subtask_id')::uuid, (image ->> 'created_by')::uuid);
  else
    insert into public.chapter_task_watchers (task_id, user_id) values (task, caller);
  end if;
  return null;
end;
end;
$function$;

-- private.mi1_qa_is_officer (live definition 20260822020000_mi1_w1_feature_persistence.sql:793; 1 call(s) swapped)
create or replace function private.mi1_qa_is_officer(p_organization_id uuid, p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.has_organization_role(
      p_organization_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
    or private.member_has_chapter_staff_grant(
      p_chapter_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
$function$;

-- public.casework_add_bargaining_event (live definition 20260828210000_mi1_casework_suite.sql:1272; 1 call(s) swapped)
create or replace function public.casework_add_bargaining_event(
  p_workspace_id uuid, p_event_type text, p_body text, p_pulse text
)
returns public.casework_bargaining_events
language plpgsql security definer set search_path = '' as $function$
declare v_workspace public.casework_bargaining_workspaces%rowtype; v_row public.casework_bargaining_events%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_workspace from public.casework_bargaining_workspaces where id = p_workspace_id for share;
  if not private.member_has_chapter_staff_grant(v_workspace.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  insert into public.casework_bargaining_events(workspace_id, organization_id, event_type, body, pulse, created_by)
  values (v_workspace.id, v_workspace.organization_id, p_event_type, pg_catalog.btrim(p_body), p_pulse, (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_workspace.organization_id, v_workspace.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_event', v_row.id, pg_catalog.jsonb_build_object('eventType', p_event_type, 'pulse', p_pulse));
  return v_row;
end;
$function$;

-- public.casework_add_bargaining_proposal (live definition 20260828210000_mi1_casework_suite.sql:1230; 1 call(s) swapped)
create or replace function public.casework_add_bargaining_proposal(
  p_workspace_id uuid, p_side text, p_title text, p_body text, p_response_due_at timestamptz
)
returns public.casework_bargaining_proposals
language plpgsql security definer set search_path = '' as $function$
declare v_workspace public.casework_bargaining_workspaces%rowtype; v_row public.casework_bargaining_proposals%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_workspace from public.casework_bargaining_workspaces where id = p_workspace_id for share;
  if not private.member_has_chapter_staff_grant(v_workspace.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  insert into public.casework_bargaining_proposals(workspace_id, organization_id, side, title, body, response_due_at, created_by)
  values (v_workspace.id, v_workspace.organization_id, p_side, pg_catalog.btrim(p_title), pg_catalog.btrim(p_body), p_response_due_at, (select auth.uid())) returning * into v_row;
  insert into public.casework_bargaining_events(workspace_id, organization_id, proposal_id, event_type, body, created_by)
  values (v_workspace.id, v_workspace.organization_id, v_row.id, 'proposal_status', 'Proposal created as draft', (select auth.uid()));
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_workspace.organization_id, v_workspace.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_proposal', v_row.id, pg_catalog.jsonb_build_object('status', v_row.status));
  return v_row;
end;
$function$;

-- public.casework_create_bargaining_workspace (live definition 20260828210000_mi1_casework_suite.sql:1214; 1 call(s) swapped)
create or replace function public.casework_create_bargaining_workspace(p_chapter_id text, p_title text, p_starts_at timestamptz)
returns public.casework_bargaining_workspaces
language plpgsql security definer set search_path = '' as $function$
declare v_org uuid; v_row public.casework_bargaining_workspaces%rowtype;
begin
  perform private.casework_require_mfa();
  select c.organization_id into strict v_org from public.chapters c where c.id = p_chapter_id;
  if not private.member_has_chapter_staff_grant(p_chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  insert into public.casework_bargaining_workspaces(organization_id, chapter_id, title, starts_at, created_by)
  values (v_org, p_chapter_id, pg_catalog.btrim(p_title), p_starts_at, (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, p_chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_workspace', v_row.id, pg_catalog.jsonb_build_object('status', v_row.status));
  return v_row;
end;
$function$;

-- public.casework_set_bargaining_status (live definition 20261106220000_conflict_refusals_not_retried.sql:1610; 1 call(s) swapped)
create or replace function public.casework_set_bargaining_status(p_workspace_id uuid, p_expected_status text, p_next_status text)
 RETURNS public.casework_bargaining_workspaces
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_row public.casework_bargaining_workspaces%rowtype;
begin
  perform private.casework_require_mfa();
  if p_next_status not in ('planning','live','paused','tentative_agreement','closed') then raise exception 'invalid session status' using errcode = '22023'; end if;
  select * into strict v_row from public.casework_bargaining_workspaces where id = p_workspace_id for update;
  if not private.member_has_chapter_staff_grant(v_row.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  if v_row.status <> p_expected_status then raise exception 'workspace changed' using errcode = 'PT409'; end if;
  update public.casework_bargaining_workspaces set status = p_next_status, updated_at = pg_catalog.now() where id = v_row.id returning * into v_row;
  insert into public.casework_bargaining_events(workspace_id, organization_id, event_type, body, created_by)
  values (v_row.id, v_row.organization_id, 'session_status', p_expected_status || ' → ' || p_next_status, (select auth.uid()));
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_workspace', v_row.id, pg_catalog.jsonb_build_object('fromStatus', p_expected_status, 'toStatus', p_next_status));
  return v_row;
end;
end;
$function$;

-- public.casework_transition_bargaining_proposal (live definition 20261106220000_conflict_refusals_not_retried.sql:1638; 1 call(s) swapped)
create or replace function public.casework_transition_bargaining_proposal(p_proposal_id uuid, p_expected_status text, p_next_status text, p_response_due_at timestamp with time zone)
 RETURNS public.casework_bargaining_proposals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_workspace public.casework_bargaining_workspaces%rowtype; v_row public.casework_bargaining_proposals%rowtype;
begin
  perform private.casework_require_mfa();
  if p_next_status not in ('draft','proposed','countered','tentative','accepted','rejected','withdrawn') then raise exception 'invalid proposal status' using errcode = '22023'; end if;
  select * into strict v_row from public.casework_bargaining_proposals where id = p_proposal_id for update;
  select * into strict v_workspace from public.casework_bargaining_workspaces where id = v_row.workspace_id;
  if not private.member_has_chapter_staff_grant(v_workspace.chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'proposal not found' using errcode = 'P0002'; end if;
  if v_row.status <> p_expected_status then raise exception 'proposal changed' using errcode = 'PT409'; end if;
  update public.casework_bargaining_proposals set status = p_next_status, response_due_at = p_response_due_at, updated_at = pg_catalog.now() where id = v_row.id returning * into v_row;
  insert into public.casework_bargaining_events(workspace_id, organization_id, proposal_id, event_type, body, created_by)
  values (v_workspace.id, v_workspace.organization_id, v_row.id, 'proposal_status', p_expected_status || ' → ' || p_next_status, (select auth.uid()));
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_workspace.organization_id, v_workspace.chapter_id, (select auth.uid()), 'bargaining_changed', 'bargaining_proposal', v_row.id, pg_catalog.jsonb_build_object('fromStatus', p_expected_status, 'toStatus', p_next_status));
  return v_row;
end;
end;
$function$;

-- public.close_chapter_handshake (live definition 20260821012000_mobile_ship_complete_workflows.sql:457; 1 call(s) swapped)
create or replace function public.close_chapter_handshake(
  p_handshake_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  item public.chapter_handshakes%rowtype;
  previous_status text;
  prior_event public.chapter_handshake_events%rowtype;
begin
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  select * into item from public.chapter_handshakes where id = p_handshake_id for update;
  if caller is null or not found
     or (chapter is distinct from item.chapter_id and chapter is distinct from item.receiving_chapter_id)
     or not private.member_has_chapter_staff_grant(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'request unavailable' using errcode = '42501';
  end if;
  select * into prior_event from public.chapter_handshake_events
  where idempotency_key = p_idempotency_key;
  if found then
    if prior_event.handshake_id <> item.id or prior_event.actor <> caller
       or prior_event.transition <> 'closed' then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(item);
  end if;
  if item.status not in ('requested','accepted','active') then
    raise exception 'request cannot be closed' using errcode = '22023';
  end if;
  previous_status := item.status;
  update public.chapter_handshakes set status = 'closed' where id = item.id returning * into item;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (item.id, p_idempotency_key, caller, chapter, 'closed', previous_status, 'closed');
  perform private.notify_handshake_staff(
    case when chapter = item.chapter_id then item.receiving_chapter_id else item.chapter_id end,
    'Partnership request closed', 'The other participating chapter closed this request.');
  return pg_catalog.to_jsonb(item);
end;
$function$;

-- public.countersign_chapter_handshake (live definition 20260821012000_mobile_ship_complete_workflows.sql:411; 1 call(s) swapped)
create or replace function public.countersign_chapter_handshake(
  p_handshake_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  item public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
begin
  if caller is null or chapter is null
     or not private.member_has_chapter_staff_grant(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  select * into item from public.chapter_handshakes where id = p_handshake_id for update;
  if not found or item.chapter_id <> chapter then raise exception 'request unavailable' using errcode = '42501'; end if;
  select * into prior_event from public.chapter_handshake_events
  where idempotency_key = p_idempotency_key;
  if found then
    if prior_event.handshake_id <> item.id or prior_event.actor <> caller
       or prior_event.transition <> 'activated' then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(item);
  end if;
  if item.status <> 'accepted' or item.receiver_signed_by is null then
    raise exception 'receiving signature required' using errcode = '22023';
  end if;
  update public.chapter_handshakes
  set requester_signed_by = caller, requester_signed_at = pg_catalog.clock_timestamp(), status = 'active'
  where id = item.id returning * into item;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (item.id, p_idempotency_key, caller, chapter, 'activated', 'accepted', 'active');
  perform private.notify_handshake_staff(item.receiving_chapter_id, 'Partnership request activated',
    'Both chapters countersigned. Only the approved data scope is now available.');
  return pg_catalog.to_jsonb(item);
end;
$function$;

-- public.create_connected_workflow_task (live definition 20261103183000_learning_period_tasks.sql:1299; 1 call(s) swapped)
create or replace function public.create_connected_workflow_task(
  p_kind text,
  p_id text,
  p_chapter_id text default null,
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  learning_parent uuid;
  caller uuid := (select auth.uid());
  caller_chapter text;
  src jsonb;
  src_id text;
  storage_kind text;
  task_title text;
  attachment_label text;
  task_workstream text;
  task_row public.chapter_tasks%rowtype;
  attachment_row public.chapter_task_attachments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_kind is null or p_kind not in ('private_message', 'channel_post', 'event', 'task_message') then
    perform private.cw_fail('capability_unavailable', '22023', 'task creation is not offered for this source', 'not_offered');
  end if;

  -- Same serialization the chapter switcher uses, so the caller's chapter is
  -- authorized and used under one lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));
  select p.chapter_id into caller_chapter from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
  end if;
  if not private.member_has_chapter_staff_grant(
       caller_chapter, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    perform private.cw_fail('not_authorized', '42501', 'staff role required', 'staff_grant_required');
  end if;

  src := private.cw_resolve_source(caller, p_kind, p_id);
  if not coalesce((src ->> 'ok')::boolean, false) then
    perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
  end if;
  if not private.cw_scope_matches(src, p_chapter_id, p_organization_id) then
    perform private.cw_fail('scope_changed', '22023', 'source scope changed');
  end if;
  -- A task is created in the caller's CURRENT chapter for a source of that same
  -- chapter. A stale reference (the caller switched chapter after opening it)
  -- never lands work in a different chapter than the source belongs to.
  if src ->> 'chapterId' is distinct from caller_chapter then
    perform private.cw_fail('scope_changed', '22023', 'source is not in your current chapter', 'chapter_mismatch');
  end if;
  if p_kind = 'task_message' then
    -- The message already belongs to a task. Open that task (never create a
    -- second one) for staff of this chapter, under the ordinary task read predicate.
    select t.* into task_row from public.chapter_tasks t
    where t.id = (src ->> 'taskId')::uuid and t.deleted_at is null;
    if not found or not private.cw_task_readable(caller, task_row.id) then
      perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
    end if;
    return pg_catalog.jsonb_build_object(
      'created', false,
      'task', pg_catalog.to_jsonb(task_row),
      'attachment', null,
      'taskKey', pg_catalog.lower(task_row.chapter_id) || '-' || task_row.task_number::text,
      'href', '/m/tasks?task=' || task_row.id::text);
  end if;
  src_id := src ->> 'id';
  storage_kind := case p_kind when 'private_message' then 'message' else p_kind end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      caller_chapter || pg_catalog.chr(31) || storage_kind || pg_catalog.chr(31) || src_id, 0));

  select a.* into attachment_row
  from public.chapter_task_attachments a
  where a.chapter_id = caller_chapter and a.source_kind = storage_kind and a.source_id = src_id;
  if found then
    select t.* into task_row from public.chapter_tasks t
    where t.id = attachment_row.task_id and t.deleted_at is null;
    if not found then
      perform private.cw_fail('capability_unavailable', '22023', 'linked task was deleted', 'linked_task_deleted');
    end if;
    return pg_catalog.jsonb_build_object(
      'created', false,
      'task', pg_catalog.to_jsonb(task_row),
      'attachment', pg_catalog.to_jsonb(attachment_row),
      'taskKey', pg_catalog.lower(task_row.chapter_id) || '-' || task_row.task_number::text,
      'href', '/m/tasks?task=' || task_row.id::text);
  end if;

  if src ->> 'state' = 'removed' then
    perform private.cw_fail('source_unavailable', '22023', 'source unavailable', 'source_removed');
  end if;

  task_title := case p_kind
    when 'private_message' then case when src ->> 'senderKind' = 'member' then 'Follow up on member message' else 'Follow up on message' end
    when 'channel_post' then 'Follow up on channel post'
    else 'Follow up on event' end;
  attachment_label := case p_kind
    when 'private_message' then case when src ->> 'senderKind' = 'member' then 'Authorized member message' else 'Authorized message' end
    when 'channel_post' then 'Authorized channel post'
    else 'Authorized event' end;

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
    perform private.cw_fail('capability_unavailable', '22023', 'chapter has no available task workstream', 'no_workstream');
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
    task_row.id, caller_chapter, attachment_label, src ->> 'href', caller, storage_kind, src_id
  ) returning * into attachment_row;

  insert into public.chapter_task_activity (
    task_id, chapter_id, actor_id, action, to_value
  ) values (
    task_row.id, caller_chapter, caller, 'attachment_added', attachment_row.id::text
  );

  learning_parent := private.learning_task_journal('task_create', task_row.id, null);
  perform private.learning_journal_append('task_link_add', 'public.chapter_task_attachments', attachment_row.id::text, learning_parent,
    private.learning_fingerprint(private.learning_task_edge_state('public.chapter_task_attachments', attachment_row.id::text)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object(
    'created', true,
    'task', pg_catalog.to_jsonb(task_row),
    'attachment', pg_catalog.to_jsonb(attachment_row),
    'taskKey', pg_catalog.lower(task_row.chapter_id) || '-' || task_row.task_number::text,
    'href', '/m/tasks?task=' || task_row.id::text);
end;
end;
$function$;

-- public.get_compass_staff_data_context (live definition 20261102005607_unit_committee_scoped_access.sql:2990; 4 call(s) swapped)
create or replace function public.get_compass_staff_data_context(p_topics text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  caller uuid;
  org uuid;
  chapter text;
  topics text[];
  data jsonb;
  part jsonb;
  tally jsonb;
  snapshot jsonb;
  snapshot_read boolean;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  -- The Compass organization: the quota organization the dispatch gate binds.
  org := private.member_organization_for(caller);
  chapter := private.current_member_chapter();
  if org is null
     or not (
       private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
       or private.actor_has_chapter_staff_role(caller, chapter)
     ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if private.organization_is_platform(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.ai_assistant.enabled')
     or not private.organization_feature_enabled(org, 'features.ai_assistant.staff_data_answers') then
    raise exception 'staff data answers are turned off' using errcode = '55000';
  end if;
  data := '{}'::jsonb;
  snapshot_read := false;

  select coalesce(pg_catalog.array_agg(distinct topic order by topic), array[]::text[]) into topics
  from pg_catalog.unnest(coalesce(p_topics, array[]::text[])) topic;
  if pg_catalog.cardinality(topics) not between 1 and 5
     or not topics <@ array['caseload', 'outcomes', 'membership', 'health', 'bargaining'] then
    raise exception 'topics invalid' using errcode = '22023';
  end if;

  if 'caseload' = any(topics) then
    begin
      select pg_catalog.jsonb_build_object(
        'openByStep', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'step', s.step, 'cases', s.case_count) order by s.case_count desc, s.step), '[]'::jsonb)
          from public.casework_dashboard_open_cases_by_step() s),
        'overdue', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'kind', o.kind, 'deadlines', o.deadline_count, 'cases', o.case_count,
            'oldestDaysOverdue', pg_catalog.floor(extract(epoch from (pg_catalog.now() - o.oldest_due_at)) / 86400.0)::integer
          ) order by o.kind), '[]'::jsonb)
          from public.casework_dashboard_overdue_deadlines() o),
        'dueSoon', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'daysOut', d.days_out, 'deadlines', d.deadline_count, 'cases', d.case_count) order by d.days_out), '[]'::jsonb)
          from public.casework_dashboard_deadlines_due_soon() d),
        'medianDaysPerStep', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'step', m.step, 'medianDays', m.median_days, 'transitions', m.transition_count) order by m.step), '[]'::jsonb)
          from public.casework_dashboard_median_days_per_step() m)
      ) into part;
    exception when insufficient_privilege then
      part := pg_catalog.jsonb_build_object('unavailable', true);
    end;
    data := data || pg_catalog.jsonb_build_object('caseload', part);
  end if;

  if 'outcomes' = any(topics) then
    begin
      part := public.get_coordinator_kpis();
      part := pg_catalog.jsonb_build_object(
        'openCases', part -> 'openCases', 'resolved', part -> 'resolved',
        'resolutionRate', part -> 'resolutionRate', 'inArbitration', part -> 'inArbitration',
        'byStep', part -> 'byStep', 'byArticle', part -> 'byArticle');
      -- Recorded outcomes under get_coordinator_kpis' own two bounds (tenant:
      -- the caller's organization and chapter, or a case the caller holds an
      -- active grant for while staff_can_see_user admits them (20261022171901,
      -- #5748); visibility:
      -- private.casework_staff_can_access per case), reached only after that
      -- coordinator-only call succeeded. The bucket is the closed outcome
      -- vocabulary, never the summary.
      select coalesce(pg_catalog.jsonb_object_agg(counted.outcome, counted.total), '{}'::jsonb) into tally
      from (
        select outcome_row.outcome, pg_catalog.count(*) as total
        from public.member_case_outcomes outcome_row
        join (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) case_row on case_row.id = outcome_row.case_id
        where (
            (case_row.organization_id = org and case_row.chapter_id = chapter)
            or (
              case_row.id in (
                select g.case_id
                from public.casework_access_grants g
                where g.grantee_user_id = (select auth.uid())
                  and g.revoked_at is null
              )
              and public.staff_can_see_user(case_row.user_id, 'coordinator')
            )
          )
          and private.casework_staff_can_read(case_row.id)
          and not private.organization_is_platform(case_row.organization_id)
        group by outcome_row.outcome
      ) counted;
      part := part || pg_catalog.jsonb_build_object('byOutcome', tally);
    exception when insufficient_privilege then
      part := pg_catalog.jsonb_build_object('unavailable', true);
    end;
    data := data || pg_catalog.jsonb_build_object('outcomes', part);
  end if;

  if 'membership' = any(topics) or 'health' = any(topics) then
    begin
      snapshot := public.get_organization_analytics_snapshot();
      snapshot_read := (snapshot ->> 'organizationId')::uuid is not distinct from org;
    exception when others then
      snapshot_read := false;
    end;
  end if;

  if 'membership' = any(topics) then
    data := data || pg_catalog.jsonb_build_object('membership', case when snapshot_read then
      pg_catalog.jsonb_build_object(
        'privacyThreshold', snapshot -> 'privacyThreshold',
        'chapters', snapshot -> 'chapters',
        'usageWindows', snapshot -> 'usageWindows')
      else pg_catalog.jsonb_build_object('unavailable', true) end);
  end if;

  if 'health' = any(topics) then
    begin
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'chapterId', item ->> 'chapterId', 'label', item ->> 'chapterName',
          'memberCount', item -> 'memberCount', 'score', item -> 'score',
          'drivers', item -> 'drivers',
          'trend', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'measuredOn', point ->> 'measuredOn', 'score', point -> 'score')), '[]'::jsonb)
            from pg_catalog.jsonb_array_elements(coalesce(item -> 'trend', '[]'::jsonb)) point)
        )), '[]'::jsonb) into part
      from pg_catalog.jsonb_array_elements(coalesce(public.get_chapter_health_portfolio(), '[]'::jsonb)) item
      join public.chapters chapter on chapter.id = item ->> 'chapterId' and chapter.organization_id = org;
    exception when insufficient_privilege then
      part := null;
    end;
    data := data || pg_catalog.jsonb_build_object('health', pg_catalog.jsonb_build_object(
      'privacyThreshold', case when snapshot_read then snapshot -> 'privacyThreshold' else null end,
      'chapters', coalesce(part, '[]'::jsonb),
      'series', case when snapshot_read then snapshot -> 'series' else '[]'::jsonb end,
      'chapterLabels', case when snapshot_read then (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', chapter_row ->> 'id', 'label', chapter_row ->> 'label')), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(coalesce(snapshot -> 'chapters', '[]'::jsonb)) chapter_row
      ) else '[]'::jsonb end,
      'engagementCounts', case when snapshot_read then snapshot -> 'engagementCounts' else '[]'::jsonb end,
      'unavailable', part is null and not snapshot_read));
  end if;

  if 'bargaining' = any(topics) then
    -- Status counts over the workspaces the caller could read: the
    -- casework_bargaining_*_staff policy predicate (chapter staff of the
    -- workspace's chapter), applied explicitly. Titles and bodies are never read.
    select pg_catalog.jsonb_build_object(
      'workspacesByStatus', coalesce((
        select pg_catalog.jsonb_object_agg(counted.status, counted.total)
        from (
          select workspace.status, pg_catalog.count(*) as total
          from public.casework_bargaining_workspaces workspace
          where workspace.organization_id = org
            and private.member_has_chapter_staff_grant(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          group by workspace.status
        ) counted), '{}'::jsonb),
      'proposalsBySideAndStatus', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'side', counted.side, 'status', counted.status, 'proposals', counted.total)
          order by counted.side, counted.status)
        from (
          select proposal.side, proposal.status, pg_catalog.count(*) as total
          from public.casework_bargaining_proposals proposal
          join public.casework_bargaining_workspaces workspace
            on workspace.id = proposal.workspace_id and workspace.organization_id = proposal.organization_id
          where proposal.organization_id = org
            and private.member_has_chapter_staff_grant(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          group by proposal.side, proposal.status
        ) counted), '[]'::jsonb),
      'responsesDueWithin7Days', (
        select pg_catalog.count(*)
        from public.casework_bargaining_proposals proposal
        join public.casework_bargaining_workspaces workspace
          on workspace.id = proposal.workspace_id and workspace.organization_id = proposal.organization_id
        where proposal.organization_id = org
          and private.member_has_chapter_staff_grant(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          and proposal.status in ('proposed', 'countered')
          and proposal.response_due_at >= pg_catalog.now()
          and proposal.response_due_at < pg_catalog.now() + interval '7 days'),
      'responsesOverdue', (
        select pg_catalog.count(*)
        from public.casework_bargaining_proposals proposal
        join public.casework_bargaining_workspaces workspace
          on workspace.id = proposal.workspace_id and workspace.organization_id = proposal.organization_id
        where proposal.organization_id = org
          and private.member_has_chapter_staff_grant(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          and proposal.status in ('proposed', 'countered')
          and proposal.response_due_at < pg_catalog.now())
    ) into part;
    data := data || pg_catalog.jsonb_build_object('bargaining', part);
  end if;

  return pg_catalog.jsonb_build_object('organization_id', org, 'topics', pg_catalog.to_jsonb(topics), 'data', data);
end;
end;
$function$
;

-- public.get_connected_workflow_context (live definition 20261104110000_learning_period_events.sql:2425; 2 call(s) swapped)
create or replace function public.get_connected_workflow_context(p_kind text, p_id text, p_chapter_id text default NULL::text, p_organization_id uuid default NULL::uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  src jsonb;
  src_state text;
  caller_chapter text;
  is_staff boolean;
  storage_kind text;
  attach public.chapter_task_attachments%rowtype;
  linked_task public.chapter_tasks%rowtype;
  linked jsonb := null;
  can_remind boolean := false;
  can_task boolean := false;
  can_message boolean := false;
  reason_remind text := null;
  reason_task text := null;
  reason_message text := null;
  discussion text := null;
  route text;
  links jsonb := '[]'::jsonb;
  link_row record;
  link_src jsonb;
  ev public.member_events%rowtype;
  organizer jsonb := null;
  opt_in boolean := false;
  can_manage boolean := false;
  can_opt boolean := false;
  contact_role text := null;
  starts jsonb := null;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_kind is null or p_kind not in ('private_message', 'channel_post', 'task_message', 'task', 'event') then
    perform private.cw_fail('invalid_input', '22023', 'invalid reference', 'kind');
  end if;
  -- Exact tenant membership: an active chapter AND organization membership.
  if private.current_member_organization() is null then
    return private.cw_unavailable_context('source_unavailable', p_kind);
  end if;

  src := private.cw_resolve_source(caller, p_kind, p_id);
  if not coalesce((src ->> 'ok')::boolean, false) then
    return private.cw_unavailable_context('source_unavailable', p_kind);
  end if;
  if not private.cw_scope_matches(src, p_chapter_id, p_organization_id) then
    return private.cw_unavailable_context('scope_changed', p_kind);
  end if;
  src_state := src ->> 'state';

  caller_chapter := private.current_member_chapter();
  is_staff := caller_chapter is not null and private.member_has_chapter_staff_grant(
    caller_chapter, array['steward', 'coordinator', 'advisor', 'admin', 'vp']);

  storage_kind := case p_kind
    when 'private_message' then 'private' when 'channel_post' then 'channel'
    when 'task_message' then 'task' when 'task' then 'task_item' else 'event' end;

  -- Reminder
  if src_state = 'removed' then reason_remind := 'source_removed';
  elsif src_state = 'cancelled' then reason_remind := 'event_cancelled';
  elsif private.cw_active_reminder_count(caller, storage_kind, src ->> 'id') >= 20 then reason_remind := 'limit_reached';
  else can_remind := true; end if;

  -- Linked task (staff only) and creation
  if p_kind = 'task_message' then
    -- A task message already belongs to a task: offer that task (never a new
    -- one) to staff of the caller's current chapter, under the ordinary task
    -- read predicate.
    if not is_staff then
      reason_task := 'staff_grant_required';
    elsif src ->> 'chapterId' is distinct from caller_chapter then
      reason_task := 'chapter_mismatch';
    else
      select t.* into linked_task from public.chapter_tasks t
      where t.id = (src ->> 'taskId')::uuid and t.deleted_at is null
        and private.cw_task_readable(caller, t.id);
      if found then
        linked := pg_catalog.to_jsonb(linked_task) || pg_catalog.jsonb_build_object(
          'taskKey', pg_catalog.lower(linked_task.chapter_id) || '-' || linked_task.task_number::text,
          'href', '/m/tasks?task=' || linked_task.id::text);
        can_task := true;
      else
        reason_task := 'source_removed';
      end if;
    end if;
  elsif p_kind not in ('private_message', 'channel_post', 'event') then
    reason_task := 'not_offered';
  elsif not is_staff then
    reason_task := 'staff_grant_required';
  elsif src ->> 'chapterId' is distinct from caller_chapter then
    -- Work is created in the caller's current chapter for a source of that chapter.
    reason_task := 'chapter_mismatch';
  else
    select a.* into attach
    from public.chapter_task_attachments a
    where a.chapter_id = caller_chapter
      and a.source_kind = case p_kind when 'private_message' then 'message' else p_kind end
      and a.source_id = src ->> 'id';
    if found then
      select t.* into linked_task from public.chapter_tasks t where t.id = attach.task_id and t.deleted_at is null;
      if found then
        linked := pg_catalog.to_jsonb(linked_task) || pg_catalog.jsonb_build_object(
          'taskKey', pg_catalog.lower(linked_task.chapter_id) || '-' || linked_task.task_number::text,
          'href', '/m/tasks?task=' || linked_task.id::text);
        can_task := true;
      else
        reason_task := 'linked_task_deleted';
      end if;
    elsif src_state = 'removed' then
      reason_task := 'source_removed';
    else
      can_task := true;
    end if;
  end if;

  -- Message audience (tasks: existing boundaries; events: organizer/participant thread)
  if p_kind not in ('task', 'event') then
    reason_message := 'not_offered';
  elsif exists (select 1 from private.cw_recipients(caller, src)) then
    can_message := true;
  elsif p_kind = 'event' then
    reason_message := case
      when src_state = 'cancelled' then 'event_cancelled'
      when not exists (select 1 from public.member_events e where e.id = src ->> 'id' and e.organizer_id is not null) then 'organizer_required'
      when exists (select 1 from private.member_event_contact_opt_ins o
                   join public.member_events e on e.id = o.event_id and e.organizer_id = o.organizer_id
                   where o.event_id = src ->> 'id' and o.user_id = caller) then 'organizer_not_reachable'
      else 'no_authorized_audience' end;
  else
    reason_message := 'no_authorized_audience';
  end if;

  -- Event organizer / consent
  if p_kind = 'event' then
    select e.* into ev from public.member_events e where e.id = src ->> 'id';
    if ev.organizer_id is not null and private.cw_event_organizer_ok(ev.organizer_id, ev.id) then
      select pg_catalog.jsonb_build_object(
        'id', pr.id, 'label', coalesce(nullif(pg_catalog.btrim(pr.full_name), ''), 'Organizer'))
      into organizer from public.member_profiles pr where pr.id = ev.organizer_id;
    end if;
    opt_in := exists (
      select 1 from private.member_event_contact_opt_ins o
      where o.event_id = ev.id and o.user_id = caller and o.organizer_id = ev.organizer_id);
    can_manage := private.member_can_manage_events() and ev.chapter_id = caller_chapter;
    can_opt := opt_in or (
      ev.cancelled_at is null and organizer is not null and ev.organizer_id <> caller
      and exists (select 1 from public.member_event_rsvps r
                  where r.event_id = ev.id and r.user_id = caller and r.status = 'going'));
    contact_role := case
      when ev.organizer_id = caller and private.cw_event_organizer_ok(caller, ev.id) then 'organizer'
      when opt_in then 'participant' end;
    -- Discussion is offered only for a thread the caller may read right now:
    -- a participant's own history (the event is still readable, checked above),
    -- or the current, authorized organizer with a consenting participant. Each
    -- link is confirmed against the canonical private-message read predicate.
    if exists (select 1 from private.member_event_contact_links l
               where l.event_id = ev.id and l.participant_id = caller
                 and private.can_read_message_source(caller, 'private', l.message_id, null, null))
       or (ev.organizer_id = caller
           and private.cw_event_organizer_ok(caller, ev.id)
           and exists (select 1 from private.member_event_contact_links l
                       where l.event_id = ev.id and l.organizer_id = caller
                         and private.cw_event_contact_ready(l.participant_id, ev.id)
                         and private.can_read_message_source(caller, 'private', l.message_id, null, null))) then
      discussion := '/m/events?event=' || ev.id || '&discussion=1';
    end if;
    starts := pg_catalog.jsonb_build_object('basis', 'instant', 'startsAt', ev.starts_at, 'eventZone', null);
  end if;

  -- Task: the caller's own task thread and the sources the task was created from
  if p_kind in ('task', 'task_message') then
    if p_kind = 'task_message' then
      discussion := src ->> 'href';
    elsif exists (
      select 1 from public.chapter_task_messages m
      where m.task_id = (src ->> 'id')::uuid and caller in (m.sender_id, m.recipient_id)) then
      discussion := '/m/messages?taskThread=' || (src ->> 'id');
    end if;
  end if;
  if p_kind = 'task' then
    for link_row in
      select a.source_kind, a.source_id
      from public.chapter_task_attachments a
      where a.task_id = (src ->> 'id')::uuid
        and a.chapter_id = src ->> 'chapterId'
        and a.source_kind in ('message', 'channel_post', 'event')
      order by a.created_at, a.id
      limit 20
    loop
      link_src := private.cw_resolve_source(caller,
        case link_row.source_kind when 'message' then 'private_message' else link_row.source_kind end,
        link_row.source_id);
      if coalesce((link_src ->> 'ok')::boolean, false) then
        links := links || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'reference', pg_catalog.jsonb_build_object(
            'kind', link_src ->> 'kind', 'id', link_src ->> 'id',
            'organizationId', link_src -> 'organizationId', 'chapterId', link_src -> 'chapterId'),
          'label', case link_src ->> 'kind'
            when 'private_message' then 'Linked message'
            when 'channel_post' then 'Linked channel post'
            else 'Linked event' end));
      end if;
    end loop;
  end if;

  route := src ->> 'href';
  if p_kind = 'task' and not private.member_has_chapter_staff_grant(
       src ->> 'chapterId', array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    route := null;
  end if;

  return pg_catalog.jsonb_build_object(
    'available', true, 'reason', null, 'kind', p_kind, 'id', src ->> 'id',
    'organizationId', src -> 'organizationId', 'chapterId', src -> 'chapterId',
    'state', src_state, 'href', route,
    'canMessage', can_message, 'canRemind', can_remind, 'canCreateTask', can_task,
    'reasons', pg_catalog.jsonb_build_object(
      'message', reason_message, 'remind', reason_remind, 'task', reason_task),
    'linkedTask', linked, 'discussionHref', discussion, 'sourceLinks', links,
    'timezone', starts, 'cancelled', src_state = 'cancelled',
    'organizer', organizer, 'contactOptIn', opt_in,
    'canManageOrganizer', can_manage,
    -- The version an organizer change sends back; event staff only.
    'eventVersion', case when can_manage then ev.version end, 'canContactOptIn', can_opt, 'contactRole', contact_role);
end;
$function$
;

-- public.get_learning_policy (live definition 20260928233000_governed_learning_content.sql:191; 1 call(s) swapped)
create or replace function public.get_learning_policy(p_chapter_id text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid; p private.learning_policies; o private.learning_policies; c private.learning_policies; hidden boolean; boundary timestamptz; staff boolean;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode='42501'; end if;
  org:=private.learning_context(p_chapter_id);
  select * into p from private.learning_policies where scope_key='platform';
  select * into o from private.learning_policies where scope_key='organization:'||org::text;
  select * into c from private.learning_policies where scope_key='chapter:'||p_chapter_id;
  select h.hidden into hidden from private.learning_home_preferences h where user_id=(select auth.uid()) and organization_id=org;
  staff:=private.has_organization_role(org,array['admin','vp','advisor','coordinator','steward']) or private.member_has_chapter_staff_grant(p_chapter_id,array['admin','vp','advisor','coordinator','steward']);
  -- Scheduled activation/expiration and audience authorization change the cache token.
  -- It never requires fetching bodies for disabled modules.
  select max(b.at) into boundary from private.learning_content r
    cross join lateral (values(r.starts_at),(r.ends_at)) b(at)
    where r.status in ('published','scheduled') and b.at<=now()
      and (r.scope='platform' or (r.organization_id=org and (r.scope='organization' or r.chapter_id=p_chapter_id)));
  return jsonb_build_object('organizationId',org,'chapterId',p_chapter_id,
    'quotesEnabled',p.quotes_enabled and coalesce(o.quotes_enabled,true) and coalesce(c.quotes_enabled,true),
    'lessonsEnabled',p.lessons_enabled and coalesce(o.lessons_enabled,true) and coalesce(c.lessons_enabled,true),
    'homeHidden',coalesce(hidden,false),'canManage',private.learning_can_manage('chapter',org,p_chapter_id),
    'isPlatformOwner',private.learning_platform_owner(),'version',concat_ws(':',p.revision,coalesce(o.revision,0),coalesce(c.revision,0),coalesce(hidden,false),boundary,staff));
end; $$;

-- public.get_steward_workload_intelligence (live definition 20261106215000_workload_hidden_categories_keep_counting.sql:153; 1 call(s) swapped)
create or replace function public.get_steward_workload_intelligence(p_weeks integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  weeks integer := greatest(2, least(coalesce(p_weeks, 12), 52));
  eligible_points integer := 0;
  trends jsonb := '[]'::jsonb;
  balancing jsonb;
  reason text;
begin
  if caller is null or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'available', false, 'reason', 'chapter_unavailable', 'eligibleWeeks', 0,
      'categories', '[]'::jsonb, 'rebalancing', pg_catalog.jsonb_build_object('stewards', '[]'::jsonb, 'suggestions', '[]'::jsonb));
  end if;
  if not private.member_has_chapter_staff_grant(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  if private.chapter_belongs_to_platform(caller_chapter) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  balancing := private.workload_rebalancing(caller_chapter);

  with latest_weekly as materialized (
    select distinct on (pg_catalog.date_trunc('week', w.created_at), w.user_id)
      pg_catalog.date_trunc('week', w.created_at)::date as week_start, w.user_id,
      w.priority, w.pending, w.unread_docs, w.todos, w.referrals,
      w.ce_activities, w.assistance_requests, w.aged_cases
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and pg_catalog.num_nulls(w.priority, w.pending, w.unread_docs, w.todos, w.referrals, w.ce_activities, w.assistance_requests, w.aged_cases) < 8
      and (w.employment is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'employment' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.ot_hours is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'otHours' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.workload_configuration is null or w.workload_configuration ->> 'organizationId' = (select c.organization_id::text from public.chapters c where c.id = caller_chapter))
      and w.created_at >= pg_catalog.date_trunc('week', pg_catalog.now()) - pg_catalog.make_interval(weeks => weeks)
    order by pg_catalog.date_trunc('week', w.created_at), w.user_id, w.created_at desc
  ), eligible_weeks as materialized (
    select week_start
    from latest_weekly
    group by week_start
    having pg_catalog.count(distinct user_id) >= 25
  )
  select pg_catalog.count(*) into eligible_points from eligible_weeks;

  if eligible_points >= 2 then
    with latest_weekly as materialized (
      select distinct on (pg_catalog.date_trunc('week', w.created_at), w.user_id)
        pg_catalog.date_trunc('week', w.created_at)::date as week_start, w.user_id,
        w.priority, w.pending, w.unread_docs, w.todos, w.referrals,
        w.ce_activities, w.assistance_requests, w.aged_cases
      from public.member_workload_logs w
      join public.member_profiles p on p.id = w.user_id
      where p.chapter_id = caller_chapter
      and pg_catalog.num_nulls(w.priority, w.pending, w.unread_docs, w.todos, w.referrals, w.ce_activities, w.assistance_requests, w.aged_cases) < 8
      and (w.employment is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'employment' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.ot_hours is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'otHours' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.workload_configuration is null or w.workload_configuration ->> 'organizationId' = (select c.organization_id::text from public.chapters c where c.id = caller_chapter))
        and w.created_at >= pg_catalog.date_trunc('week', pg_catalog.now()) - pg_catalog.make_interval(weeks => weeks)
      order by pg_catalog.date_trunc('week', w.created_at), w.user_id, w.created_at desc
    ), eligible as (
      select week_start from latest_weekly group by week_start
      having pg_catalog.count(distinct user_id) >= 25
    ), weekly_categories as (
      -- least() ignores NULL, so unknown values are removed before the cap.
      select l.week_start, v.key, v.ord, pg_catalog.avg(least(v.value, 150))::numeric as value
      from latest_weekly l join eligible e using (week_start)
      cross join lateral (values
        ('priority', 1, l.priority), ('pending', 2, l.pending),
        ('unread_docs', 3, l.unread_docs), ('todos', 4, l.todos),
        ('referrals', 5, l.referrals), ('ce_activities', 6, l.ce_activities),
        ('assistance_requests', 7, l.assistance_requests), ('aged_cases', 8, l.aged_cases)
      ) v(key, ord, value)
      where v.value is not null
      group by l.week_start, v.key, v.ord
      having pg_catalog.count(*) >= 25
    ), regression as (
      select key, ord, pg_catalog.count(*)::integer as points,
        pg_catalog.regr_slope(value, extract(epoch from week_start) / 604800.0)::numeric as slope,
        (pg_catalog.array_agg(value order by week_start desc))[1] as latest
      from weekly_categories group by key, ord
      having pg_catalog.count(*) >= 2
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'key', key, 'points', points,
      'slope', pg_catalog.round(slope, 2),
      'latest', pg_catalog.round(latest, 1),
      'forecast4Weeks', pg_catalog.round(greatest(latest + slope * 4, 0), 1)) order by ord)
    into trends from regression;
    -- Weeks can each clear the floor while no single category has two
    -- publishable weekly points; that is still too few weeks for a trend.
    if trends is null then reason := 'insufficient_weeks'; end if;
  else
    reason := case when eligible_points = 0 then 'anonymity_floor' else 'insufficient_weeks' end;
  end if;

  return pg_catalog.jsonb_build_object(
    'available', reason is null,
    'reason', reason,
    'eligibleWeeks', eligible_points,
    'categories', coalesce(trends, '[]'::jsonb),
    'rebalancing', balancing,
    'generatedAt', pg_catalog.now());
end;
$function$;

-- public.list_chapter_task_template_reviewers (live definition 20260901162845_sample_staff_rpc_tenant_authorization.sql:177; 1 call(s) swapped)
create or replace function public.list_chapter_task_template_reviewers()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  payload jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select caller_profile.chapter_id
    into caller_chapter
  from public.member_profiles caller_profile
  where caller_profile.id = caller;

  if caller_chapter is null or not private.member_has_chapter_staff_grant(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'chapter staff role required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object('id', eligible.id, 'fullName', eligible.full_name)
    order by pg_catalog.lower(eligible.full_name), eligible.id
  ), '[]'::jsonb)
    into payload
  from (
    select reviewer_profile.id, reviewer_profile.full_name
    from public.member_profiles reviewer_profile
    where reviewer_profile.chapter_id = caller_chapter
      and private.actor_has_chapter_staff_role(reviewer_profile.id, caller_chapter)
  ) eligible;

  return payload;
end;
$function$;

-- public.list_chapter_task_templates (live definition 20260901162845_sample_staff_rpc_tenant_authorization.sql:95; 1 call(s) swapped)
create or replace function public.list_chapter_task_templates()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  payload jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select caller_profile.chapter_id
    into caller_chapter
  from public.member_profiles caller_profile
  where caller_profile.id = caller;

  if caller_chapter is null or not private.member_has_chapter_staff_grant(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'chapter staff role required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'key', c.template_key,
      'label', pg_catalog.jsonb_build_object('en', c.label_en, 'es', c.label_es),
      'description', pg_catalog.jsonb_build_object('en', c.description_en, 'es', c.description_es),
      'defaultStatus', c.default_status,
      'defaultPriority', c.default_priority,
      'fields', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'key', f.field_key,
          'kind', f.field_kind,
          'required', f.required,
          'label', pg_catalog.jsonb_build_object('en', f.label_en, 'es', f.label_es),
          'help', pg_catalog.jsonb_build_object('en', f.help_en, 'es', f.help_es),
          'options', f.option_keys
        ) order by f.position)
        from private.chapter_task_template_fields f
        where f.template_key = c.template_key
      ), '[]'::jsonb),
      'flow', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'key', s.step_key,
          'label', pg_catalog.jsonb_build_object('en', s.label_en, 'es', s.label_es),
          'predecessorKeys', s.predecessor_keys,
          'recommendedStatus', s.recommended_status,
          'terminal', s.terminal
        ) order by s.position)
        from private.chapter_task_template_flow_steps s
        where s.template_key = c.template_key
      ), '[]'::jsonb),
      'checklist', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'label', pg_catalog.jsonb_build_object('en', item.label_en, 'es', item.label_es)
        ) order by item.position)
        from private.chapter_task_template_checklist_items item
        where item.template_key = c.template_key
      ), '[]'::jsonb)
    ) order by c.sort_order
  ), '[]'::jsonb) into payload
  from private.chapter_task_template_catalog c
  where c.active;

  return payload;
end;
$function$;

-- public.list_learning_content (live definition 20260928233000_governed_learning_content.sql:215; 1 call(s) swapped)
create or replace function public.list_learning_content(p_chapter_id text,p_locale text,p_kind text default null,p_offset integer default 0,p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid; policy jsonb; ids_o uuid[]; ids_c uuid[]; staff boolean; rows jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode='42501'; end if;
  org:=private.learning_context(p_chapter_id);
  if p_locale is null or p_locale not in ('en','es') or (p_kind is not null and p_kind not in ('quote','mini_lesson')) or p_offset is null or p_offset<0 or p_offset>10000 or p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid content query' using errcode='22023'; end if;
  policy:=public.get_learning_policy(p_chapter_id);
  if not (policy->>'quotesEnabled')::boolean and not (policy->>'lessonsEnabled')::boolean then return jsonb_build_object('items','[]'::jsonb,'hasMore',false); end if;
  select selected_ids into ids_o from private.learning_policies where scope_key='organization:'||org::text;
  select selected_ids into ids_c from private.learning_policies where scope_key='chapter:'||p_chapter_id;
  staff:=private.has_organization_role(org,array['admin','vp','advisor','coordinator','steward']) or private.member_has_chapter_staff_grant(p_chapter_id,array['admin','vp','advisor','coordinator','steward']);
  select coalesce(jsonb_agg(page.item),'[]'::jsonb) into rows from (
    select private.learning_projection(r)-'provenance'-'review_note'-'rights_note'-'direction' item from private.learning_content r where
      r.status in ('published','scheduled') and r.starts_at<=now() and (r.ends_at is null or r.ends_at>now())
      and r.payload->>'locale'=p_locale and r.payload->>'locale_state'='reviewed'
      and (p_kind is null or r.payload->>'kind'=p_kind)
      and ((r.payload->>'kind'='quote' and (policy->>'quotesEnabled')::boolean) or (r.payload->>'kind'='mini_lesson' and (policy->>'lessonsEnabled')::boolean))
      and (r.payload->>'audience'='all' or (r.payload->>'audience'='staff' and staff) or (r.payload->>'audience'='members' and not staff))
      and ((r.scope='platform' and ((r.payload->>'is_default')::boolean or r.id=any(ids_o) or r.id=any(ids_c))) or
        (r.organization_id=org and (r.scope='organization' or r.chapter_id=p_chapter_id)))
      and (ids_o is null or r.id=any(ids_o)) and (ids_c is null or r.id=any(ids_c))
    order by (r.payload->>'priority')::integer desc,r.id limit p_limit+1 offset p_offset
  ) page;
  return jsonb_build_object('items',case when jsonb_array_length(rows)>p_limit then rows-p_limit else rows end,'hasMore',jsonb_array_length(rows)>p_limit);
end; $$;

-- public.list_member_qa_officer_queue (live definition 20260826155000_mi1_append_only_review_repairs.sql:178; 1 call(s) swapped)
create or replace function public.list_member_qa_officer_queue(
  p_limit integer default 50,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
     and not private.member_has_chapter_staff_grant(
       private.current_member_chapter(),
       array['steward', 'coordinator', 'advisor', 'admin', 'vp']
     ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if (p_after_created_at is null) <> (p_after_id is null) then
    raise exception 'both officer queue cursor fields are required' using errcode = '22023';
  end if;

  return (
    with limited as (
      select candidate.id, candidate.created_at
      from public.member_qa_questions candidate
      where candidate.organization_id = org
        and candidate.deleted_at is null
        and candidate.status = 'open'
        and private.mi1_qa_is_officer(candidate.organization_id, candidate.chapter_id)
        and (
          p_after_created_at is null
          or candidate.created_at > p_after_created_at
          or (candidate.created_at = p_after_created_at and p_after_id is not null and candidate.id > p_after_id)
        )
      order by candidate.created_at, candidate.id
      limit clamped + 1
    ), page as (
      select limited.id, limited.created_at
      from limited
      order by limited.created_at, limited.id
      limit clamped
    )
    select pg_catalog.jsonb_build_object(
      'questions', coalesce((
        select pg_catalog.jsonb_agg(private.mi1_qa_project_question(page.id, (select auth.uid())) order by page.created_at, page.id)
        from page
      ), '[]'::jsonb),
      'nextAfterCreatedAt', case when (select pg_catalog.count(*) from limited) > clamped
        then (select page.created_at from page order by page.created_at desc, page.id desc limit 1)
        else null end,
      'nextAfterId', case when (select pg_catalog.count(*) from limited) > clamped
        then (select page.id from page order by page.created_at desc, page.id desc limit 1)
        else null end
    )
  );
end;
$function$;

-- public.request_chapter_handshake (live definition 20261027050000_legacy_chapter_handshake_receiving.sql:33; 1 call(s) swapped)
create or replace function public.request_chapter_handshake(p_partner_org_id text, p_title text, p_purpose text, p_data_scope text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  receiving text;
  created public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
  caller_organization uuid;
begin
  if caller is null or chapter is null
     or not private.member_has_chapter_staff_grant(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title,''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose,''))) not between 1 and 4000
     or p_data_scope not in ('docs_only','no_member_data','aggregate_only') then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  -- An unverified self-created organization cannot hand-shake, so it gets
  -- the not-onboarded answer before any registry binding is read: the answer
  -- never depends on whether the partner has a verified binding. A legacy
  -- chapter with no organization keeps its previous behaviour.
  caller_organization := private.current_member_organization();
  if caller_organization is not null
     and not private.organization_clears_signup_boundary(caller_organization) then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;
  select b.chapter_id into receiving
  from public.chapter_union_org_bindings b
  where b.union_org_id = p_partner_org_id and b.status = 'verified'
    and private.catalog_registry_identity_visible(p_partner_org_id)
    and exists (select 1 from public.chapters c where c.id = b.chapter_id
      and (c.organization_id = caller_organization
        or private.organization_visible_in_directory(c.organization_id)
        or (c.organization_id is null and not exists (select 1 from private.bot_production_marks m
          where m.kind = 'chapter' and m.record_id = c.id))));
  if receiving is null or receiving = chapter then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;
  select * into prior_event from public.chapter_handshake_events e
  where e.idempotency_key = p_idempotency_key;
  if found then
    select h.* into created from public.chapter_handshakes h
    where h.id = prior_event.handshake_id;
    if prior_event.transition <> 'requested' or prior_event.actor <> caller
       or created.chapter_id <> chapter or created.receiving_chapter_id <> receiving
       or created.partner_org_id <> p_partner_org_id
       or created.title <> pg_catalog.btrim(p_title)
       or created.purpose <> pg_catalog.btrim(p_purpose)
       or created.data_scope <> p_data_scope then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(created);
  end if;
  insert into public.chapter_handshakes
    (chapter_id, receiving_chapter_id, partner_org_id, title, purpose, data_scope,
     status, requested_by, requested_at)
  values (chapter, receiving, p_partner_org_id, pg_catalog.btrim(p_title),
    pg_catalog.btrim(p_purpose), p_data_scope, 'requested', caller, pg_catalog.clock_timestamp())
  returning * into created;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (created.id, p_idempotency_key, caller, chapter, 'requested', 'draft', 'requested');
  perform private.notify_handshake_staff(receiving, 'Partnership request received',
    'An authorized chapter sent a two-sided partnership request for review.');
  return pg_catalog.to_jsonb(created);
end;
end;
$function$;

-- public.respond_chapter_handshake (live definition 20260821012000_mobile_ship_complete_workflows.sql:351; 1 call(s) swapped)
create or replace function public.respond_chapter_handshake(
  p_handshake_id uuid,
  p_decision text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  item public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
  next_status text;
begin
  if caller is null or chapter is null
     or not private.member_has_chapter_staff_grant(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_decision not in ('accept','decline') or p_idempotency_key is null then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  select * into item from public.chapter_handshakes where id = p_handshake_id for update;
  if not found or item.receiving_chapter_id <> chapter then
    raise exception 'request unavailable' using errcode = '42501';
  end if;
  select * into prior_event from public.chapter_handshake_events
  where idempotency_key = p_idempotency_key;
  if found then
    if prior_event.handshake_id <> item.id or prior_event.actor <> caller
       or prior_event.transition <> (case when p_decision = 'accept' then 'accepted' else 'declined' end) then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(item);
  end if;
  if item.status <> 'requested' then raise exception 'request already resolved' using errcode = '22023'; end if;
  next_status := case when p_decision = 'accept' then 'accepted' else 'declined' end;
  update public.chapter_handshakes
  set status = next_status,
      receiver_signed_by = case when p_decision = 'accept' then caller else null end,
      receiver_signed_at = case when p_decision = 'accept' then pg_catalog.clock_timestamp() else null end,
      countersigned_by = case when p_decision = 'accept' then caller else null end,
      countersigned_at = case when p_decision = 'accept' then pg_catalog.clock_timestamp() else null end
  where id = item.id returning * into item;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (item.id, p_idempotency_key, caller, chapter,
    case when p_decision = 'accept' then 'accepted' else 'declined' end,
    'requested', next_status);
  perform private.notify_handshake_staff(item.chapter_id,
    case when p_decision = 'accept' then 'Partnership request accepted' else 'Partnership request declined' end,
    case when p_decision = 'accept'
      then 'The receiving chapter accepted. An authorized requester must countersign before activation.'
      else 'The receiving chapter declined the request.' end);
  return pg_catalog.to_jsonb(item);
end;
$function$;

-- public.restore_chapter_task (live definition 20261103183000_learning_period_tasks.sql:651; 1 call(s) swapped)
create or replace function public.restore_chapter_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  task_row public.chapter_tasks%rowtype;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));

  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller;
  if caller_chapter is null or not private.member_has_chapter_staff_grant(
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
  learning_before := private.learning_task_state(task_row.id);

  update public.chapter_tasks
    set deleted_at = null, deleted_by = null
    where id = task_row.id;
  perform private.learning_task_journal('task_restore', task_row.id, learning_before);

  if task_row.assignee_id is not null and task_row.assignee_id <> caller then
    perform private.notify_member(task_row.assignee_id, 'task.restored',
      pg_catalog.jsonb_build_object('name',
        coalesce((select p.full_name from public.member_profiles p where p.id = caller), 'Someone')),
      'tasks');
  end if;

  return pg_catalog.jsonb_build_object('id', task_row.id, 'restored', true);
end;
end
$function$;

-- public.share_chapter_handshake_document (live definition 20260821012000_mobile_ship_complete_workflows.sql:504; 1 call(s) swapped, plus the document container check)
create or replace function public.share_chapter_handshake_document(
  p_handshake_id uuid,
  p_document_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  item public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
begin
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  select * into item from public.chapter_handshakes where id = p_handshake_id for update;
  if caller is null or not found or item.status <> 'active' or item.data_scope <> 'docs_only'
     or (chapter is distinct from item.chapter_id and chapter is distinct from item.receiving_chapter_id)
     or not private.member_has_chapter_staff_grant(chapter, array['steward','coordinator','advisor','admin','vp'])
     or not exists (
       select 1 from public.chapter_documents d
       where d.id = p_document_id and d.chapter_id = chapter and d.status = 'published'
         and private.chapter_document_container_allows(d.chapter_id, d.access_unit_id, d.access_committee_id)
     ) then
    raise exception 'document exchange unavailable' using errcode = '42501';
  end if;
  select * into prior_event from public.chapter_handshake_events
  where idempotency_key = p_idempotency_key;
  if found then
    if prior_event.handshake_id <> item.id or prior_event.actor <> caller
       or prior_event.transition <> 'document_shared'
       or prior_event.detail ->> 'documentId' is distinct from p_document_id::text then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('shared', true, 'handshakeId', item.id, 'documentId', p_document_id);
  end if;
  insert into public.chapter_handshake_documents (handshake_id, document_id, shared_by)
  values (item.id, p_document_id, caller) on conflict do nothing;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status,
     detail)
  values (item.id, p_idempotency_key, caller, chapter, 'document_shared', 'active', 'active',
    pg_catalog.jsonb_build_object('documentId', p_document_id));
  return pg_catalog.jsonb_build_object('shared', true, 'handshakeId', item.id, 'documentId', p_document_id);
end;
$function$;

-- public.soft_delete_chapter_task (live definition 20261103183000_learning_period_tasks.sql:591; 1 call(s) swapped)
create or replace function public.soft_delete_chapter_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  task_row public.chapter_tasks%rowtype;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));

  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller;
  if caller_chapter is null or not private.member_has_chapter_staff_grant(
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
  learning_before := private.learning_task_state(task_row.id);

  update public.chapter_tasks
    set deleted_at = pg_catalog.now(), deleted_by = caller
    where id = task_row.id;
  perform private.learning_task_journal('task_delete', task_row.id, learning_before);

  if task_row.assignee_id is not null and task_row.assignee_id <> caller then
    perform private.notify_member(task_row.assignee_id, 'task.deleted',
      pg_catalog.jsonb_build_object('name',
        coalesce((select p.full_name from public.member_profiles p where p.id = caller), 'Someone')),
      'tasks');
  end if;

  return pg_catalog.jsonb_build_object('id', task_row.id, 'deletedAt', pg_catalog.now());
end;
end
$function$;

-- public.update_chapter_document_content (live definition 20261102005607_unit_committee_scoped_access.sql:1480; 1 call(s) swapped, plus the document container check)
create or replace function public.update_chapter_document_content(p_id uuid, p_title text, p_document_type text, p_summary text, p_body text, p_visibility text, p_action text DEFAULT 'save'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare row public.chapter_documents%rowtype; chapter text := private.current_member_chapter();
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then raise exception 'authentication required' using errcode='42501'; end if;
  if p_action not in ('save','republish','archive') then raise exception 'invalid document action' using errcode='22023'; end if;
  if p_document_type not in ('contract','policy','minutes','training','template','other') or p_visibility not in ('chapter','staff') then raise exception 'invalid document fields' using errcode='22023'; end if;
  select d.* into row from public.chapter_documents d where d.id=p_id and d.chapter_id=chapter for update;
  if row.id is null then raise exception 'document unavailable' using errcode='22023'; end if;
  if not ((private.member_has_chapter_staff_grant(chapter,array['steward','coordinator','advisor','admin','vp']) and private.chapter_document_container_allows(chapter,row.access_unit_id,row.access_committee_id)) or private.chapter_officer_can_for_scope(chapter,'documents',row.access_unit_id,row.access_committee_id)) then raise exception 'document outside access scope' using errcode='42501'; end if;
  if p_action='save' and row.status='published' then raise exception 'published document requires a new version or archive' using errcode='55000'; end if;
  update public.chapter_documents d set title=btrim(p_title), document_type=p_document_type, summary=coalesce(p_summary,''), body=coalesce(p_body,''), visibility=p_visibility,
    status=case when p_action='archive' then 'archived' when p_action='republish' then 'published' else d.status end,
    version=case when p_action='republish' then d.version+1 else d.version end,
    published_at=case when p_action='republish' then now() else d.published_at end
  where d.id=p_id and d.chapter_id=chapter returning d.* into row;
  if row.id is null then raise exception 'document unavailable' using errcode='22023'; end if;
  return to_jsonb(row);
end;
end;
end;
$function$;

-- private.chapter_connection_hat_allows (live definition 20260928103000_chapter_connection_suggestions_backend.sql:471; 1 call(s) swapped)
create or replace function private.chapter_connection_hat_allows(
  p_organization_id uuid,
  p_selected_hat text,
  p_chapter_id text,
  p_allowed_hats text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when p_selected_hat is null
      or p_selected_hat <> all (p_allowed_hats)
      or p_organization_id is null
      or not private.mfa_satisfied()
      then false
    when private.has_organization_role(p_organization_id, array[p_selected_hat]) then true
    when p_chapter_id is not null
      and private.chapter_connection_chapter_organization(p_chapter_id) = p_organization_id
      and private.member_has_chapter_staff_grant(p_chapter_id, array[p_selected_hat])
      then true
    else false
  end;
$function$;

-- public.request_chapter_connection_handshake (live definition 20261023050348_bot_organization_directory_visibility.sql:1347; 1 call(s) swapped)
create or replace function public.request_chapter_connection_handshake(
  p_selected_hat text,
  p_chapter_id text,
  p_target_chapter_id text,
  p_title text,
  p_purpose text,
  p_data_scope text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  target text;
  partner text;
  registry_epoch bigint;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter,
    array['steward','coordinator','advisor','admin','vp']);
  if chapter is distinct from private.current_member_chapter()
     or not private.member_has_chapter_staff_grant(chapter, array[p_selected_hat]) then
    raise exception 'select the source chapter before requesting a handshake' using errcode = '42501';
  end if;
  if p_idempotency_key is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title,''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose,''))) not between 1 and 4000
     or p_data_scope is null or p_data_scope not in ('docs_only','no_member_data','aggregate_only') then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  target := nullif(pg_catalog.btrim(coalesce(p_target_chapter_id, '')), '');
  if target is null or target = chapter then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;
  -- An unverified self-created organization cannot hand-shake: it gets the
  -- legacy not-onboarded answer before any published profile or registry
  -- binding is read, so the answer never depends on the target.
  if not private.organization_clears_signup_boundary(org) then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;

  -- Serialize retries before taking the registry lock. The legacy event's
  -- globally unique key remains the durable idempotency authority.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key::text, 509281));
  -- Every eligibility dependency advances this row in the existing registry
  -- triggers. SHARE prevents a withdrawal/hide/rebind/quarantine from
  -- committing between the following fresh read and the legacy request.
  -- Do not take target-row locks: registry writers lock those before epoch.
  select e.epoch into registry_epoch
  from private.chapter_connection_registry_epoch e where e.singleton for share;
  if registry_epoch is null then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;
  select b.union_org_id into partner
  from private.chapter_connection_profiles p
  join public.chapters c on c.id = p.chapter_id and c.organization_id = p.organization_id
  join public.organizations o on o.id = p.organization_id and o.status = 'active'
  join public.chapter_union_org_bindings b on b.chapter_id = p.chapter_id and b.status = 'verified'
  join public.union_orgs u on u.id = b.union_org_id
  where p.chapter_id = target
    and p.publication_status = 'published'
    and (c.organization_id = org or private.organization_visible_in_directory(c.organization_id))
    and private.catalog_registry_identity_visible(u.id)
    and p.expires_at > pg_catalog.clock_timestamp()
    and not exists (
      select 1 from private.chapter_connection_hides h
      where (h.chapter_id = chapter and h.hidden_chapter_id = target)
         or (h.chapter_id = target and h.hidden_chapter_id = chapter)
    );
  if partner is null then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;
  -- union_org_id is UNIQUE in chapter_union_org_bindings. Under the registry
  -- lock the legacy resolver must select this exact receiving chapter.
  return public.request_chapter_handshake(partner, p_title, p_purpose, p_data_scope, p_idempotency_key);
end;
$function$;

-- policy casework_bargaining_events_insert on public.casework_bargaining_events (live definition 20260828210000_mi1_casework_suite.sql:684; 1 call(s) swapped)
drop policy casework_bargaining_events_insert on public.casework_bargaining_events;
create policy casework_bargaining_events_insert on public.casework_bargaining_events
  for insert to authenticated with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from public.casework_bargaining_workspaces w
      where w.id = casework_bargaining_events.workspace_id
        and w.organization_id = casework_bargaining_events.organization_id
        and private.member_has_chapter_staff_grant(w.chapter_id, array['steward','coordinator','advisor','admin','vp'])
    )
  );

-- policy casework_bargaining_events_staff on public.casework_bargaining_events (live definition 20260828210000_mi1_casework_suite.sql:676; 1 call(s) swapped)
drop policy casework_bargaining_events_staff on public.casework_bargaining_events;
create policy casework_bargaining_events_staff on public.casework_bargaining_events
  for select to authenticated
  using (exists (
    select 1 from public.casework_bargaining_workspaces w
    where w.id = casework_bargaining_events.workspace_id
      and w.organization_id = casework_bargaining_events.organization_id
      and private.member_has_chapter_staff_grant(w.chapter_id, array['steward','coordinator','advisor','admin','vp'])
  ));

-- policy casework_bargaining_proposals_staff on public.casework_bargaining_proposals (live definition 20260828210000_mi1_casework_suite.sql:659; 2 call(s) swapped)
drop policy casework_bargaining_proposals_staff on public.casework_bargaining_proposals;
create policy casework_bargaining_proposals_staff on public.casework_bargaining_proposals
  for all to authenticated
  using (exists (
    select 1 from public.casework_bargaining_workspaces w
    where w.id = casework_bargaining_proposals.workspace_id
      and w.organization_id = casework_bargaining_proposals.organization_id
      and private.member_has_chapter_staff_grant(w.chapter_id, array['steward','coordinator','advisor','admin','vp'])
  ))
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from public.casework_bargaining_workspaces w
      where w.id = casework_bargaining_proposals.workspace_id
        and w.organization_id = casework_bargaining_proposals.organization_id
        and private.member_has_chapter_staff_grant(w.chapter_id, array['steward','coordinator','advisor','admin','vp'])
    )
  );

-- policy casework_bargaining_workspaces_staff on public.casework_bargaining_workspaces (live definition 20260828210000_mi1_casework_suite.sql:652; 2 call(s) swapped)
drop policy casework_bargaining_workspaces_staff on public.casework_bargaining_workspaces;
create policy casework_bargaining_workspaces_staff on public.casework_bargaining_workspaces
  for all to authenticated
  using (private.member_has_chapter_staff_grant(chapter_id, array['steward','coordinator','advisor','admin','vp']))
  with check (
    private.member_has_chapter_staff_grant(chapter_id, array['steward','coordinator','advisor','admin','vp'])
    and created_by = (select auth.uid())
  );

-- policy casework_management_people_staff on public.casework_management_people (live definition 20260828210000_mi1_casework_suite.sql:742; 2 call(s) swapped)
drop policy casework_management_people_staff on public.casework_management_people;
create policy casework_management_people_staff on public.casework_management_people
  for all to authenticated
  using (private.member_has_chapter_staff_grant(chapter_id, array['steward','coordinator','advisor','admin','vp']))
  with check (
    private.member_has_chapter_staff_grant(chapter_id, array['steward','coordinator','advisor','admin','vp'])
    and created_by = (select auth.uid())
  );

-- policy chapter_documents_read on public.chapter_documents (live definition 20261102005607_unit_committee_scoped_access.sql:8048; 3 call(s) swapped)
alter policy chapter_documents_read on public.chapter_documents using (((((chapter_id = private.current_member_chapter()) AND (((status = 'published'::text) AND ((visibility = 'chapter'::text) OR private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR ((status = 'published'::text) AND private.member_has_chapter_staff_grant(private.current_member_chapter(), ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND (EXISTS ( SELECT 1
   FROM (public.chapter_handshake_documents hd
     JOIN public.chapter_handshakes h ON ((h.id = hd.handshake_id)))
  WHERE ((hd.document_id = chapter_documents.id) AND (h.status = 'active'::text) AND ((private.current_member_chapter() = h.chapter_id) OR (private.current_member_chapter() = h.receiving_chapter_id)))))))) OR (((chapter_id = private.current_member_chapter()) AND private.chapter_officer_can_for_scope(chapter_id, 'documents'::text, access_unit_id, access_committee_id))));

-- policy chapter_documents_staff_create on public.chapter_documents (live definition 20261102005607_unit_committee_scoped_access.sql:8046; 1 call(s) swapped)
alter policy chapter_documents_staff_create on public.chapter_documents with check ((((chapter_id = private.current_member_chapter()) AND (created_by = ( SELECT auth.uid() AS uid)) AND private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR (((chapter_id = private.current_member_chapter()) AND (created_by = ( SELECT auth.uid() AS uid)) AND private.chapter_officer_can_for_scope(chapter_id, 'documents'::text, access_unit_id, access_committee_id))));

-- policy chapter_documents_staff_write on public.chapter_documents (live definition 20261102005607_unit_committee_scoped_access.sql:8053; 2 call(s) swapped)
alter policy chapter_documents_staff_write on public.chapter_documents using ((((chapter_id = private.current_member_chapter()) AND private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR (((chapter_id = private.current_member_chapter()) AND private.chapter_officer_can_for_scope(chapter_id, 'documents'::text, access_unit_id, access_committee_id)))) with check ((((chapter_id = private.current_member_chapter()) AND private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR (((chapter_id = private.current_member_chapter()) AND private.chapter_officer_can_for_scope(chapter_id, 'documents'::text, access_unit_id, access_committee_id))));

-- policy chapter_handshake_documents_read_participant on public.chapter_handshake_documents (live definition 20260821012000_mobile_ship_complete_workflows.sql:128; 1 call(s) swapped)
drop policy chapter_handshake_documents_read_participant on public.chapter_handshake_documents;
create policy chapter_handshake_documents_read_participant
  on public.chapter_handshake_documents for select to authenticated
  using (
    private.member_has_chapter_staff_grant(
      private.current_member_chapter(), array['steward','coordinator','advisor','admin','vp'])
    and exists (
      select 1 from public.chapter_handshakes h
      where h.id = handshake_id and h.status = 'active'
        and private.current_member_chapter() in (h.chapter_id, h.receiving_chapter_id)
    )
  );

-- policy chapter_handshake_events_read_participant on public.chapter_handshake_events (live definition 20260821012000_mobile_ship_complete_workflows.sql:117; 1 call(s) swapped)
drop policy chapter_handshake_events_read_participant on public.chapter_handshake_events;
create policy chapter_handshake_events_read_participant
  on public.chapter_handshake_events for select to authenticated
  using (
    private.member_has_chapter_staff_grant(
      private.current_member_chapter(), array['steward','coordinator','advisor','admin','vp'])
    and exists (
      select 1 from public.chapter_handshakes h
      where h.id = handshake_id
        and private.current_member_chapter() in (h.chapter_id, h.receiving_chapter_id)
    )
  );

-- policy chapter_handshakes_read_participant on public.chapter_handshakes (live definition 20260821012000_mobile_ship_complete_workflows.sql:153; 1 call(s) swapped)
drop policy chapter_handshakes_read_participant on public.chapter_handshakes;
create policy chapter_handshakes_read_participant
  on public.chapter_handshakes for select to authenticated
  using (
    private.current_member_chapter() in (chapter_id, receiving_chapter_id)
    and private.member_has_chapter_staff_grant(
      private.current_member_chapter(), array['steward','coordinator','advisor','admin','vp'])
  );

-- policy chapter_union_org_bindings_read_onboarded on public.chapter_union_org_bindings (live definition 20260930040200_self_serve_organization_shell.sql:720; 1 call(s) swapped)
drop policy chapter_union_org_bindings_read_onboarded on public.chapter_union_org_bindings;
create policy chapter_union_org_bindings_read_onboarded
  on public.chapter_union_org_bindings for select to authenticated
  using (
    chapter_id = private.current_member_chapter()
    or (status = 'verified'
      and private.member_has_chapter_staff_grant(
        private.current_member_chapter(), array['steward','coordinator','advisor','admin','vp'])
      and private.organization_clears_signup_boundary(private.current_member_organization()))
  );

comment on policy casework_bargaining_events_insert on public.casework_bargaining_events is 'Chapter staff add bargaining timeline events; no member personal details. #7665: unchanged rule, except that a unit-scoped or in-date committee-scoped staff grant now counts through private.member_has_chapter_staff_grant.';
comment on policy casework_bargaining_events_staff on public.casework_bargaining_events is 'Chapter staff read the bargaining timeline; no member personal details. #7665: unchanged rule, except that a unit-scoped or in-date committee-scoped staff grant now counts through private.member_has_chapter_staff_grant.';
comment on policy casework_bargaining_proposals_staff on public.casework_bargaining_proposals is 'Chapter staff read and write bargaining proposals; no member personal details. #7665: unchanged rule, except that a unit-scoped or in-date committee-scoped staff grant now counts through private.member_has_chapter_staff_grant.';
comment on policy casework_bargaining_workspaces_staff on public.casework_bargaining_workspaces is 'Chapter staff read and write bargaining workspaces; no member personal details. #7665: unchanged rule, except that a unit-scoped or in-date committee-scoped staff grant now counts through private.member_has_chapter_staff_grant.';
comment on policy casework_management_people_staff on public.casework_management_people is 'Chapter staff keep the directory of management-side people (not members). #7665: unchanged rule, except that a unit-scoped or in-date committee-scoped staff grant now counts through private.member_has_chapter_staff_grant.';
comment on policy chapter_documents_read on public.chapter_documents is 'Staff-visibility and draft chapter documents for chapter staff; chapter_documents_container_scope still keeps a unit or committee document inside its container. #7665: unchanged rule, except that a unit-scoped or in-date committee-scoped staff grant now counts through private.member_has_chapter_staff_grant.';
comment on policy chapter_documents_staff_create on public.chapter_documents is 'Chapter staff create chapter documents; container scope still applies. #7665: unchanged rule, except that a unit-scoped or in-date committee-scoped staff grant now counts through private.member_has_chapter_staff_grant.';
comment on policy chapter_documents_staff_write on public.chapter_documents is 'Chapter staff edit chapter documents; container scope still applies. #7665: unchanged rule, except that a unit-scoped or in-date committee-scoped staff grant now counts through private.member_has_chapter_staff_grant.';
comment on policy chapter_handshake_documents_read_participant on public.chapter_handshake_documents is 'Chapter staff of a participating chapter read documents shared in a handshake. #7665: unchanged rule, except that a unit-scoped or in-date committee-scoped staff grant now counts through private.member_has_chapter_staff_grant.';
comment on policy chapter_handshake_events_read_participant on public.chapter_handshake_events is 'Chapter staff of a participating chapter read the handshake timeline. #7665: unchanged rule, except that a unit-scoped or in-date committee-scoped staff grant now counts through private.member_has_chapter_staff_grant.';
comment on policy chapter_handshakes_read_participant on public.chapter_handshakes is 'Chapter staff read their chapter''s handshakes. #7665: unchanged rule, except that a unit-scoped or in-date committee-scoped staff grant now counts through private.member_has_chapter_staff_grant.';
comment on policy chapter_union_org_bindings_read_onboarded on public.chapter_union_org_bindings is 'Chapter staff read verified union-organization bindings of onboarded chapters. #7665: unchanged rule, except that a unit-scoped or in-date committee-scoped staff grant now counts through private.member_has_chapter_staff_grant.';

commit;
