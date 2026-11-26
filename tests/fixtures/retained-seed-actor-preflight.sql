-- Local regression fixture for the retained seed-removal actor guard.
-- Never an authorization to run a production residue operation.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '60s';
set local search_path = '';
-- Before F1 the pin table is absent. Once F1 is installed, require the exact
-- operator-supplied baseline pair before fill or any removal can proceed.
do $kept_pin_preflight$
declare pairs bigint;
begin
  if pg_catalog.to_regclass('private.production_residue_kept_scope') is not null then
    execute 'select count(*) from private.production_residue_kept_scope k
      join public.chapters c on c.id = k.chapter_id and c.organization_id = k.organization_id
      join public.organizations o on o.id = k.organization_id'
      into pairs;
    if pairs <> 1 then
      raise exception 'production residue kept baseline pair is absent or invalid';
    end if;
  end if;
end;
$kept_pin_preflight$;
with candidates as (
  select to_jsonb(row_value) as body, false as require_actor, 'chapter_task_activity'::text as relation_name
  from public.chapter_task_activity row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, false as require_actor, 'chapter_task_comments'::text as relation_name
  from public.chapter_task_comments row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, false as require_actor, 'chapter_task_assignments'::text as relation_name
  from public.chapter_task_assignments row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, false as require_actor, 'chapter_task_subtasks'::text as relation_name
  from public.chapter_task_subtasks row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, false as require_actor, 'chapter_task_attachments'::text as relation_name
  from public.chapter_task_attachments row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, false as require_actor, 'chapter_task_files'::text as relation_name
  from public.chapter_task_files row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, false as require_actor, 'chapter_task_messages'::text as relation_name
  from public.chapter_task_messages row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, false as require_actor, 'chapter_task_watchers'::text as relation_name
  from public.chapter_task_watchers row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, false as require_actor, 'chapter_task_dependencies'::text as relation_name
  from public.chapter_task_dependencies row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, false as require_actor, 'chapter_task_template_details'::text as relation_name
  from public.chapter_task_template_details row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, true as require_actor, 'chapter_tasks'::text as relation_name
  from public.chapter_tasks row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, true as require_actor, 'chapter_thread_posts'::text as relation_name
  from public.chapter_thread_posts row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, true as require_actor, 'chapter_threads'::text as relation_name
  from public.chapter_threads row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, true as require_actor, 'chapter_spaces'::text as relation_name
  from public.chapter_spaces row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, true as require_actor, 'chapter_workstreams'::text as relation_name
  from public.chapter_workstreams row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
  where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  union all
  select to_jsonb(row_value) as body, true as require_actor, 'member_events'::text as relation_name
  from public.member_events row_value
  where row_value.id like 'ud-evt-%'
  union all
  select to_jsonb(row_value) as body, true as require_actor, 'member_ballots'::text as relation_name
  from public.member_ballots row_value
  where row_value.id like 'ud-ballot-%'
  union all
  select to_jsonb(row_value) as body, true as require_actor, 'member_surveys'::text as relation_name
  from public.member_surveys row_value
  where row_value.id like 'ud-pulse-%'
  union all
  select to_jsonb(row_value) as body, true as require_actor, 'member_broadcasts'::text as relation_name
  from public.member_broadcasts row_value
  where row_value.id like 'ud-bc-%'
), checked as (
  select body, require_actor, relation_name,
    exists (
select 1
from private.uniondemo_chapters map
join public.chapters chapter on chapter.id = map.chapter_id
where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  and (map.chapter_id = candidate.body ->> 'chapter_id'
    or (candidate.relation_name = 'member_broadcasts' and map.chapter_index = 1
      and candidate.body ->> 'chapter_id' is null and candidate.body ->> 'organization_id' is null))
  and (chapter.organization_id is null
    or chapter.organization_id = private.member_stress_uuid('109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid::text || ':ud:organization'))
  and (not (candidate.body ? 'organization_id')
    or candidate.body ->> 'organization_id' is not distinct from chapter.organization_id::text)
  and (
    (candidate.relation_name = 'chapter_workstreams'
      and candidate.body ->> 'name' = any(array['Chapter','Communications','Organizing','Grievances','Bargaining','Safety'])
      and candidate.body ->> 'id' = private.member_stress_uuid('109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid::text || ':ch' || map.chapter_index::text || ':ud:ws:' || (candidate.body ->> 'name'))::text)
    or (candidate.relation_name = 'member_ballots' and exists (
      select 1 from pg_catalog.generate_series(1,9) marker(n)
      where candidate.body ->> 'id' = 'ud-ballot-' || pg_catalog.lpad(map.chapter_index::text,2,'0') || '-'
        || case when marker.n = 9 then 'live' else pg_catalog.lpad(marker.n::text,2,'0') end
        and candidate.body ->> 'order_index' = (41000 + map.chapter_index * 20 + marker.n)::text
        and candidate.body ->> 'body' = case when marker.n = 9
          then 'Open vote for ' || map.chapter_name || ': ratify how the chapter spends its action budget this year.'
          else 'Chapter vote for ' || map.chapter_name || ': review the materials in the broadcast archive, then cast your ballot.' end
    ))
    or (candidate.relation_name = 'member_surveys' and exists (
      select 1 from pg_catalog.generate_series(1,9) marker(n)
      where candidate.body ->> 'id' = 'ud-pulse-' || pg_catalog.lpad(map.chapter_index::text,2,'0') || '-'
        || case when marker.n = 9 then 'live' else pg_catalog.lpad(marker.n::text,2,'0') end
        and candidate.body ->> 'order_index' = (42000 + map.chapter_index * 20 + marker.n)::text
        and candidate.body ->> 'body' = case when marker.n = 9
          then 'Your answer shapes the mentoring program the chapter pilots this fall.'
          else 'Two questions, thirty seconds. Chapter results are shared at the next meeting.' end
    ))
    or (candidate.relation_name = 'member_events' and exists (
      select 1 from (
        select 'cm-' || pg_catalog.lpad(n::text,2,'0') suffix, n position,
          'M' || pg_catalog.lpad(n::text,2,'0') code, false is_public,
          'Chapter meeting — ' || pg_catalog.to_char((candidate.body ->> 'starts_at')::timestamptz - interval '18 hours','Mon YYYY') title,
          (array['Chapter hall + Zoom','Union office · Room 2','Program site community room'])[1+(n%3)] location,
          'Officer reports, grievance and bargaining updates, member Q&A.' summary
        from pg_catalog.generate_series(0,47) counter(n)
        union all
        select 'tr-' || pg_catalog.lpad(n::text,2,'0'), 100+n,
          'T' || pg_catalog.lpad(n::text,2,'0'), false,
          'Steward training — ' || pg_catalog.to_char((candidate.body ->> 'starts_at')::timestamptz - interval '17 hours 30 minutes','Mon YYYY'),
          'Union office · Training room',
          'Weingarten rights, Step 1 practice, and casework intake for chapter stewards.'
        from pg_catalog.generate_series(1,16) counter(n)
        union all
        select 'ac-' || n::text, 200+n, 'A' || n::text, true,
          (array['Caseload-relief rally','Contract action day','Community solidarity picnic','Legislative lobby day'])[1+(n%4)]
            || ' — ' || pg_catalog.to_char((candidate.body ->> 'starts_at')::timestamptz - interval '16 hours','Mon YYYY'),
          (array['State House steps','Agency headquarters','City park pavilion'])[1+(n%3)],
          'Chapter turnout event: bring a coworker and wear your chapter shirt.'
        from pg_catalog.generate_series(1,8) counter(n)
        union all
        select 'nx-' || n::text, 299+n, 'N' || n::text, n<>1,
          (array['Chapter meeting','New-steward training','Caseload-relief rally'])[n],
          (array['Chapter hall + Zoom','Union office · Training room','State House steps'])[n],
          (array['Bargaining survey vote and contract update.','Module 3 — Weingarten rights and Step 1 practice.','Statewide action for enforceable caseload caps.'])[n]
        from pg_catalog.generate_series(1,3) counter(n)
      ) expected
      where candidate.body ->> 'id' = 'ud-evt-' || pg_catalog.lpad(map.chapter_index::text,2,'0') || '-' || expected.suffix
        and candidate.body ->> 'order_index' = (map.chapter_index*1000+expected.position)::text
        and candidate.body ->> 'check_in_code' = 'SG-U' || pg_catalog.lpad(map.chapter_index::text,2,'0') || expected.code
        and candidate.body ->> 'is_public' = expected.is_public::text
        and candidate.body ->> 'title' = expected.title
        and candidate.body ->> 'location' = expected.location
        and candidate.body ->> 'summary' = expected.summary
    ))
    or (candidate.relation_name = 'member_broadcasts' and map.chapter_index = 1
      and ((candidate.body ->> 'chapter_id' = map.chapter_id and chapter.organization_id is not null
          and candidate.body ->> 'audience_scope' = 'organization')
        or (candidate.body ->> 'chapter_id' is null and candidate.body ->> 'organization_id' is null
          and chapter.organization_id is null and candidate.body ->> 'audience_scope' is null))
      and exists (
        select 1 from (select
'ud-bc-' || pg_catalog.lpad(n::text, 3, '0'),
      (array['Statewide local', 'Bargaining team', 'Steward council'])[1 + (n % 3)],
      case when n % 14 = 0
        then 'Actualización estatal — semana ' || n::text
        else (array[
          'Bargaining update #' || n::text,
          'Contract enforcement wins this week',
          'Steward office hours schedule',
          'Caseload-relief campaign update',
          'Know your Weingarten rights',
          'Legislative report: what moved',
          'New member welcome and orientation dates',
          'Health & safety walkthrough results',
          'Grievance clinic openings',
          'Member spotlight and chapter wins'
        ])[1 + (n % 10)]
      end,
      case when n % 14 = 0
        then 'Resumen semanal para todos los capítulos: negociaciones, casos y próximos pasos.'
        else (array[
          'The team held the line on caseload caps at this week''s session. Full recap and the next open bargaining date inside.',
          'Three grievances settled at Step 2 this week, including a full back-pay award. Details and what they mean for your worksite.',
          'Weekly steward office hours run at every chapter office and on Zoom. Bring discipline or scheduling questions.',
          'Two more legislators signed on to the caseload-relief bill this week. Here is the whip count and your next call.',
          'If a meeting could lead to discipline, you can ask for a steward before answering. Save this one.',
          'The committee testified at the State House hearing; the recording and written testimony are linked inside.',
          'Orientation runs the first Tuesday of every month at every chapter office. Bring a new coworker.',
          'Walkthrough findings and the fixes management committed to, with deadlines members can hold them to.',
          'Drop-in grievance clinics have open slots this month. A steward will help you prepare a filing.',
          'Wins from every chapter this week, and the members who made them happen.'
        ])[1 + (n % 10)]
      end,
          (40000+n)::text order_marker,
          case when n%14=0 then 'es' else 'en' end locale
          from pg_catalog.generate_series(1,207) counter(n)
        ) expected(id,sender,title,body,order_marker,locale)
        where candidate.body ->> 'id' = expected.id and candidate.body ->> 'sender' = expected.sender
          and candidate.body ->> 'title' = expected.title and candidate.body ->> 'body' = expected.body
          and candidate.body ->> 'order_index' = expected.order_marker and candidate.body ->> 'locale' = expected.locale
      ))
  )
    ) as seed_known,
    exists (select 1 from pg_catalog.jsonb_each_text(body) field
      where field.key = any(array[
      'actor_id', 'assigned_by', 'assignee_id', 'author_id', 'commenter_id',
      'completed_by', 'created_by', 'member_id', 'updated_by', 'uploaded_by',
      'user_id', 'watcher_id', 'organizer_id'
    ]) and field.value is not null) as actor_seen,
    exists (select 1 from pg_catalog.jsonb_each_text(body) field
      where field.key = any(array[
      'actor_id', 'assigned_by', 'assignee_id', 'author_id', 'commenter_id',
      'completed_by', 'created_by', 'member_id', 'updated_by', 'uploaded_by',
      'user_id', 'watcher_id', 'organizer_id'
    ]) and field.value is not null
      and (field.value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or not exists (select 1 from private.uniondemo_ledger ledger
          where ledger.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid and ledger.user_id::text = field.value))) as unowned_actor
  from candidates candidate
), refusals as (
  select (select count(*) from checked where unowned_actor or (require_actor and not actor_seen and not seed_known)) as unowned_content,
    (select count(*) from public.member_profiles row_value
      join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id
      left join private.uniondemo_ledger ledger on ledger.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid and ledger.user_id = row_value.id
      where map.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid and ledger.user_id is null) as unowned_profiles,
    (select count(*) from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where relation.relkind = 'f' and namespace.nspname !~ '^pg_'
        and namespace.nspname <> 'information_schema') as foreign_tables
)
select pg_catalog.jsonb_build_object(
  'state', case when unowned_content + unowned_profiles + foreign_tables = 0 then 'clear' else 'refused' end,
  'unowned_content', unowned_content, 'unowned_profiles', unowned_profiles, 'foreign_tables', foreign_tables)
from refusals;
rollback;
