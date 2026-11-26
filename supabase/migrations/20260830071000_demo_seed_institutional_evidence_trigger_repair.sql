-- Repair the institutional SAMPLE composer after the identity-stamping and
-- shared page-evidence triggers were integrated. Only the canonical weekly-
-- question evidence owns this composition. A bounded transaction-local SAMPLE
-- identity lets the existing chapter-record trigger derive, rather than erase,
-- the already-validated chapter and creator.

create or replace function private.demo_seed_institutional_records_from_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  run record;
  org uuid;
  chapter text;
  creator uuid;
  record_id uuid;
  grant_id uuid;
  i integer;
  record_kind text;
  record_version integer;
  previous_claims text;
begin
  if pg_catalog.pg_trigger_depth() > 1 then return null; end if;
  for run in
    select distinct evidence.lane, evidence.run_id
    from inserted_institutional_evidence evidence
    where evidence.surface = 'memberWeeklyQuestions'
  loop
    if run.lane not in ('presg','uniondemo') then continue; end if;
    org := private.member_stress_uuid(run.run_id::text || case when run.lane = 'presg' then ':presg:organization' else ':ud:organization' end);
    chapter := private.demo_seed_chapter(run.lane, run.run_id, 1);
    creator := private.demo_seed_user(run.lane, run.run_id, 1);
    if not exists (select 1 from public.organizations o where o.id = org)
       or not exists (select 1 from public.chapters c where c.id = chapter and c.organization_id = org)
       or not exists (select 1 from auth.users u where u.id = creator) then
      continue;
    end if;

    previous_claims := pg_catalog.current_setting('request.jwt.claims', true);
    perform pg_catalog.set_config(
      'request.jwt.claims',
      pg_catalog.jsonb_build_object(
        'sub', creator,
        'role', 'service_role',
        'aal', 'aal2'
      )::text,
      true
    );

    for i in 1..18 loop
      record_id := private.member_stress_uuid(run.run_id::text || ':institutional:record:' || i);
      record_kind := case when i % 3 = 0 then 'minutes' when i % 2 = 0 then 'decision' else 'milestone' end;
      record_version := case when i in (3, 8, 15) then 2 else 1 end;
      insert into public.chapter_records (
        id, chapter_id, record_type, title, body, occurred_at, created_by,
        lifecycle_status, visibility, version, published_at, updated_at,
        pinned_at, gap_note, archived_at
      ) values (
        record_id, chapter, record_kind,
        (array[
          'Member orientation program launched', 'Caseload documentation standard adopted',
          'Quarterly chapter meeting', 'Bargaining priorities confirmed',
          'Safety committee formed', 'Labor-management meeting',
          'New steward cohort completed training', 'Scheduling proposal approved',
          'Annual chapter meeting', 'Contract education series opened',
          'Community coalition partnership began', 'Benefits briefing',
          'Workload evidence review completed', 'Member communication standard adopted',
          'Fall chapter meeting', 'Representation coverage expanded',
          'Records retention practice confirmed', 'Winter chapter meeting'
        ])[i],
        (array[
          'The chapter established a recurring welcome session and assigned follow-up owners.',
          'Members approved one shared method for recording workload and short-notice changes.',
          'Members reviewed open work, confirmed decisions, and assigned the next steps.',
          'The chapter adopted member-ranked priorities for the next bargaining cycle.',
          'A member-led committee began a regular hazard review and escalation cadence.',
          'Representatives presented documented scheduling and workload issues to management.'
        ])[1 + ((i - 1) % 6)],
        pg_catalog.now() - ((18 - i) * 62 || ' days')::interval,
        creator, 'published', 'chapter', record_version,
        pg_catalog.now() - ((18 - i) * 62 || ' days')::interval,
        pg_catalog.now() - ((18 - i) * 62 || ' days')::interval,
        case when i in (5, 14, 18) then pg_catalog.now() - ((18 - i) * 62 || ' days')::interval end,
        case when i = 10 then 'Earlier organizing notes are held in a paper archive and are queued for digitization.' end,
        null
      ) on conflict (id) do update set
        chapter_id = excluded.chapter_id, record_type = excluded.record_type,
        title = excluded.title, body = excluded.body, occurred_at = excluded.occurred_at,
        lifecycle_status = excluded.lifecycle_status, visibility = excluded.visibility,
        version = excluded.version, published_at = excluded.published_at,
        updated_at = excluded.updated_at, pinned_at = excluded.pinned_at,
        gap_note = excluded.gap_note, archived_at = null;

      insert into public.chapter_record_versions (
        id, record_id, chapter_id, version, record_type, title, body, occurred_at,
        lifecycle_status, visibility, gap_note, changed_by, created_at
      ) values (
        private.member_stress_uuid(run.run_id::text || ':institutional:record:' || i || ':version:1'),
        record_id, chapter, 1, record_kind,
        (select title from public.chapter_records where id = record_id),
        case when record_version = 2 then 'Initial draft retained for the institutional record.' else (select body from public.chapter_records where id = record_id) end,
        (select occurred_at from public.chapter_records where id = record_id),
        case when record_version = 2 then 'draft' else 'published' end,
        'chapter', (select gap_note from public.chapter_records where id = record_id), creator,
        (select occurred_at from public.chapter_records where id = record_id)
      ) on conflict (record_id, version) do update set body = excluded.body, lifecycle_status = excluded.lifecycle_status;
      if record_version = 2 then
        insert into public.chapter_record_versions (
          id, record_id, chapter_id, version, record_type, title, body, occurred_at,
          lifecycle_status, visibility, gap_note, changed_by, created_at
        ) select
          private.member_stress_uuid(run.run_id::text || ':institutional:record:' || i || ':version:2'),
          r.id, r.chapter_id, 2, r.record_type, r.title, r.body, r.occurred_at,
          'published', r.visibility, r.gap_note, creator, r.updated_at
        from public.chapter_records r where r.id = record_id
        on conflict (record_id, version) do update set body = excluded.body, lifecycle_status = excluded.lifecycle_status;
      end if;

      if record_kind = 'minutes' then
        insert into public.meeting_attendance (record_id, chapter_id, user_id, attendance_status, recorded_by, recorded_at)
        select record_id, chapter, private.demo_seed_user(run.lane, run.run_id, member_index),
          case member_index % 6 when 0 then 'excused' else 'present' end,
          creator, (select occurred_at from public.chapter_records where id = record_id)
        from pg_catalog.generate_series(1, 24) member_index
        where exists (select 1 from auth.users u where u.id = private.demo_seed_user(run.lane, run.run_id, member_index))
        on conflict (record_id, user_id) do update set attendance_status = excluded.attendance_status, recorded_at = excluded.recorded_at;
        insert into public.meeting_minutes_dispatches (
          id, record_id, chapter_id, version, recipient_id, status, delivered_at, created_at
        ) select
          private.member_stress_uuid(run.run_id::text || ':institutional:dispatch:' || i || ':' || member_index),
          record_id, chapter, record_version,
          private.demo_seed_user(run.lane, run.run_id, member_index), 'delivered',
          (select published_at from public.chapter_records where id = record_id),
          (select published_at from public.chapter_records where id = record_id)
        from pg_catalog.generate_series(1, 24) member_index
        where exists (select 1 from auth.users u where u.id = private.demo_seed_user(run.lane, run.run_id, member_index))
        on conflict (record_id, version, recipient_id, channel) do update set status = 'delivered', delivered_at = excluded.delivered_at;
      end if;
    end loop;

    for i in 1..36 loop
      insert into public.chapter_contact_log (
        id, organization_id, chapter_id, subject_user_id, contact_kind, channel,
        purpose, summary, outcome, occurred_at, follow_up_at, created_by, updated_by,
        created_at, updated_at
      ) values (
        private.member_stress_uuid(run.run_id::text || ':institutional:contact:' || i),
        org, chapter,
        case when i % 4 = 0 then null else private.demo_seed_user(run.lane, run.run_id, 2 + (i % 40)) end,
        (array['member','management','community','provider'])[1 + ((i - 1) % 4)],
        (array['phone','email','meeting','in_person','message'])[1 + ((i - 1) % 5)],
        (array['Scheduling follow-up','Workload documentation','Community coordination','Benefits question'])[1 + ((i - 1) % 4)],
        'Recorded the conversation, agreed on a next step, and assigned follow-up where needed.',
        case when i % 3 = 0 then 'Follow-up completed and documented.' else 'Awaiting the agreed follow-up.' end,
        pg_catalog.now() - (i * 26 || ' days')::interval,
        case when i <= 4 then pg_catalog.now() + (i || ' days')::interval end,
        creator, creator,
        pg_catalog.now() - (i * 26 || ' days')::interval,
        pg_catalog.now() - (i * 26 || ' days')::interval
      ) on conflict (id) do update set summary = excluded.summary, outcome = excluded.outcome, follow_up_at = excluded.follow_up_at, archived_at = null;
    end loop;

    insert into public.organization_data_export_runs (
      id, organization_id, requested_by, format, domains, filters, row_count, expires_at, status, created_at
    ) values
      (private.member_stress_uuid(run.run_id::text || ':institutional:export:1'), org, creator, 'csv', array['members','cases','tasks'], '{}'::jsonb, 128, pg_catalog.now() + interval '15 minutes', 'ready', pg_catalog.now() - interval '2 days'),
      (private.member_stress_uuid(run.run_id::text || ':institutional:export:2'), org, creator, 'json', array['minutes','timeline','contacts'], '{}'::jsonb, 54, pg_catalog.now() + interval '15 minutes', 'ready', pg_catalog.now() - interval '9 days')
    on conflict (id) do update set row_count = excluded.row_count, expires_at = excluded.expires_at, status = excluded.status;

    -- Give one current-week question an explicit, already-spent promotion and
    -- leave the featured member's own grant unused so the control is visible.
    select g.id into grant_id
    from public.member_reward_grants g
    where g.organization_id = org and g.user_id = private.demo_seed_user(run.lane, run.run_id, 3)
      and g.item_key = 'priority-wq-slot' and g.status <> 'revoked'
    limit 1;
    if grant_id is null then
      grant_id := private.member_stress_uuid(run.run_id::text || ':institutional:promotion-grant');
      insert into public.member_reward_grants (id, organization_id, user_id, item_key, status, source, reason)
      values (grant_id, org, private.demo_seed_user(run.lane, run.run_id, 3), 'priority-wq-slot', 'granted', 'admin_grant', 'Chapter participation recognition')
      on conflict do nothing;
    end if;
    insert into public.member_weekly_question_promotions (question_id, reward_grant_id, organization_id, chapter_id, user_id)
    select q.id, grant_id, org, chapter, q.user_id
    from public.member_weekly_questions q
    where q.id = private.member_stress_uuid(run.run_id::text || ':voice:weekly:1')
      and q.user_id = private.demo_seed_user(run.lane, run.run_id, 3)
    on conflict (question_id) do nothing;

    perform pg_catalog.set_config(
      'request.jwt.claims', coalesce(previous_claims, ''), true
    );
  end loop;
  return null;
end;
$function$;

revoke all on function private.demo_seed_institutional_records_from_evidence()
  from public, anon, authenticated, service_role;
