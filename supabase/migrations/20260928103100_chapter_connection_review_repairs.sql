-- REQ-UG-CONNECTION-SUGGESTIONS-20260927: integration review repairs.
-- Preserves reviewed empty sources, one source chapter throughout traversal,
-- strict complementary cohorts, and publication currency on every dependency.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- A NULL topic is the private durable reviewed-source marker. It has no public
-- taxonomy meaning. NULLS NOT DISTINCT keeps exactly one marker per source.
alter table private.chapter_connection_source_tags alter column topic_key drop not null;
alter table private.chapter_connection_source_tags drop constraint chapter_connection_source_tags_source_topic_key;
alter table private.chapter_connection_source_tags add constraint chapter_connection_source_tags_source_topic_key unique nulls not distinct (source_kind, source_id, topic_key);
comment on column private.chapter_connection_source_tags.topic_key is 'NULL marks an explicitly reviewed source even when no issue topics were confirmed. Included only in the distinct-contributor denominator, never in a published topic.';


create or replace function private.chapter_connection_identity(
  p_chapter_id text,
  p_declared_local_key text,
  p_declared_union_family_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  verified record;
  family text;
begin
  select u.olms_file_number, u.affiliation into verified
  from public.chapter_union_org_bindings b
  join public.union_orgs u on u.id = b.union_org_id
  where b.chapter_id = p_chapter_id
    and b.status = 'verified';
  if found then
    family := nullif(pg_catalog.left(pg_catalog.btrim(
      pg_catalog.regexp_replace(pg_catalog.lower(coalesce(verified.affiliation, '')), '[^a-z0-9]+', '-', 'g'),
      '-'), 40), '');
    if family in ('unaff', 'unaffiliated', 'independent', 'none') then family := null; end if;
    return pg_catalog.jsonb_build_object(
      'localKey', 'olms-' || verified.olms_file_number::text,
      'localKeySource', 'verified',
      'unionFamilyKey', family,
      'unionFamilyKeySource', case when family is null then null else 'verified' end
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'localKey', p_declared_local_key,
    'localKeySource', case when p_declared_local_key is null then null else 'declared' end,
    'unionFamilyKey', case when p_declared_union_family_key in ('unaff','unaffiliated','independent','none') then null else p_declared_union_family_key end,
    'unionFamilyKeySource', case when p_declared_union_family_key is null then null else 'declared' end
  );
end;
$function$;

create or replace function public.set_chapter_connection_source_tags(
  p_selected_hat text,
  p_chapter_id text,
  p_source_kind text,
  p_source_id uuid,
  p_topic_keys text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  kind text;
  topics text[];
  contributor uuid;
  occurred_at timestamptz;
  source_chapter text;
  source_status text;
  confirmed integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter, array['advisor', 'admin', 'vp']);

  kind := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source_kind, '')));
  if kind not in ('grievance', 'survey', 'feedback') then
    raise exception 'source kind invalid' using errcode = '22023';
  end if;
  if p_source_id is null then
    raise exception 'source record unavailable' using errcode = '22023';
  end if;
  topics := coalesce(array(
    select pg_catalog.lower(pg_catalog.btrim(key))
    from pg_catalog.unnest(coalesce(p_topic_keys, array[]::text[])) as key
  ), array[]::text[]);
  if pg_catalog.array_position(coalesce(p_topic_keys, array[]::text[]), null) is not null
     or not private.chapter_connection_keys_valid(topics, private.chapter_connection_issue_keys(), 10) then
    raise exception 'topic keys invalid' using errcode = '22023';
  end if;

  if kind = 'grievance' then
    select c.user_id, c.updated_at, c.status into contributor, occurred_at, source_status
    from public.member_cases c
    where c.id = p_source_id
      and c.organization_id = org
      and c.chapter_id = chapter;
    if not found
       or source_status <> 'resolved'
       or not private.casework_can_read(p_source_id)
       or not private.member_case_visible_to_caller(p_source_id) then
      raise exception 'source record unavailable' using errcode = '22023';
    end if;
  elsif kind = 'survey' then
    perform private.engagement_require_staff(org);
    select s.respondent_user_id, s.submitted_at, s.status, v.chapter_id
      into contributor, occurred_at, source_status, source_chapter
    from public.organization_survey_sessions s
    join public.organization_surveys v on v.id = s.survey_id
    where s.id = p_source_id
      and s.organization_id = org;
    if not found
       or source_status <> 'submitted'
       or occurred_at is null
       or not coalesce((
         source_chapter = chapter
         or (source_chapter is null and exists (
           select 1 from public.member_chapter_memberships m
           where m.user_id = contributor and m.chapter_id = chapter and m.status = 'active'
         ))
       ), false) then
      raise exception 'source record unavailable' using errcode = '22023';
    end if;
  else
    perform private.engagement_require_staff(org);
    select e.user_id, e.responded_at, e.state, pr.chapter_id
      into contributor, occurred_at, source_status, source_chapter
    from public.organization_pulse_events e
    join public.organization_pulse_prompts pr on pr.id = e.prompt_id
    where e.id = p_source_id
      and e.organization_id = org;
    if not found
       or source_status <> 'responded'
       or occurred_at is null
       or not coalesce((
         source_chapter = chapter
         or (source_chapter is null and exists (
           select 1 from public.member_chapter_memberships m
           where m.user_id = contributor and m.chapter_id = chapter and m.status = 'active'
         ))
       ), false) then
      raise exception 'source record unavailable' using errcode = '22023';
    end if;
  end if;

  update private.chapter_connection_source_tags t
  set status = 'removed', updated_at = pg_catalog.now()
  where t.source_kind = kind
    and t.source_id = p_source_id
    and t.status = 'confirmed'
    and t.topic_key <> all (topics);

  insert into private.chapter_connection_source_tags as t (
    organization_id, chapter_id, source_kind, case_id, survey_session_id, pulse_event_id,
    topic_key, contributor_user_id, source_occurred_at, status
  )
  select
    org, chapter, kind,
    case when kind = 'grievance' then p_source_id end,
    case when kind = 'survey' then p_source_id end,
    case when kind = 'feedback' then p_source_id end,
    key, contributor, occurred_at, 'confirmed'
  from pg_catalog.unnest(pg_catalog.array_prepend(null::text, topics)) as key
  on conflict (source_kind, source_id, topic_key) do update
    set status = 'confirmed',
        chapter_id = excluded.chapter_id,
        contributor_user_id = excluded.contributor_user_id,
        source_occurred_at = excluded.source_occurred_at,
        updated_at = pg_catalog.now();

  select pg_catalog.count(*)::integer into confirmed
  from private.chapter_connection_source_tags t
  where t.source_kind = kind and t.source_id = p_source_id and t.status = 'confirmed' and t.topic_key is not null;

  perform private.chapter_connection_audit(org, chapter, 'chapter_connection_source_tags_changed',
    pg_catalog.jsonb_build_object(
      'entityType', kind,
      'operation', 'set',
      'count', confirmed
    ));

  return pg_catalog.jsonb_build_object(
    'chapterId', chapter,
    'sourceKind', kind,
    'sourceId', p_source_id,
    'topicKeys', pg_catalog.to_jsonb(topics),
    'occurredAt', occurred_at,
    'periodKey', pg_catalog.to_char(occurred_at at time zone 'UTC', 'YYYY"Q"Q')
  );
end;
$function$;

create or replace function public.freeze_chapter_connection_issue_aggregates(
  p_selected_hat text,
  p_chapter_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  quarter record;
  already boolean;
  topic_count integer;
  frozen_at timestamptz;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter, array['advisor', 'admin', 'vp']);

  select * into quarter from private.chapter_connection_previous_quarter();

  select r.frozen_at, r.published_topic_count into frozen_at, topic_count
  from private.chapter_connection_aggregate_runs r
  where r.chapter_id = chapter and r.period_key = quarter.period_key
  for update;
  already := found;

  if not already then
    frozen_at := pg_catalog.now();
    insert into private.chapter_connection_aggregate_runs
      (chapter_id, organization_id, period_key, period_starts_at, period_ends_at, frozen_at, published_topic_count)
    values (chapter, org, quarter.period_key, quarter.starts_at, quarter.ends_at, frozen_at, 0);

    insert into private.chapter_connection_issue_aggregates (chapter_id, period_key, topic_key, band)
    select
      chapter,
      quarter.period_key,
      per_topic.topic_key,
      -- Band by share of the window's contributors: at most a third, at most
      -- two thirds, or more. Integer arithmetic, so a boundary share lands on
      -- the same band the client-side preview assigns it.
      case
        when per_topic.contributors * 3 <= total.contributors then 'some'
        when per_topic.contributors * 3 <= total.contributors * 2 then 'many'
        else 'most'
      end
    from (
      select t.topic_key, pg_catalog.count(distinct t.contributor_user_id) as contributors
      from private.chapter_connection_source_tags t
      where t.chapter_id = chapter
        and t.organization_id = org
        and t.status = 'confirmed'
        and t.topic_key is not null
        and t.source_occurred_at >= quarter.starts_at
        and t.source_occurred_at < quarter.ends_at
      group by t.topic_key
    ) per_topic
    cross join (
      select pg_catalog.count(distinct t.contributor_user_id) as contributors
      from private.chapter_connection_source_tags t
      where t.chapter_id = chapter
        and t.organization_id = org
        and t.status = 'confirmed'
        and t.source_occurred_at >= quarter.starts_at
        and t.source_occurred_at < quarter.ends_at
    ) total
    where per_topic.contributors >= 25
      and total.contributors - per_topic.contributors >= 25;
    get diagnostics topic_count = row_count;

    update private.chapter_connection_aggregate_runs r
    set published_topic_count = topic_count
    where r.chapter_id = chapter and r.period_key = quarter.period_key;

    if exists (
      select 1 from private.chapter_connection_profiles p
      where p.chapter_id = chapter
        and p.publication_status = 'published'
        and p.share_analyzed_issues
    ) then
      perform private.chapter_connection_bump_epoch();
    end if;

    perform private.chapter_connection_audit(org, chapter, 'chapter_connection_aggregates_frozen',
      pg_catalog.jsonb_build_object(
        'entityType', 'aggregate_period',
        'entityId', quarter.period_key,
        'operation', 'freeze',
        'count', topic_count
      ));
  end if;

  return pg_catalog.jsonb_build_object(
    'chapterId', chapter,
    'periodKey', quarter.period_key,
    'periodStartsAt', quarter.starts_at,
    'periodEndsAt', quarter.ends_at,
    'frozenAt', frozen_at,
    'alreadyFrozen', already,
    'topics', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', a.topic_key, 'band', a.band) order by a.topic_key)
      from private.chapter_connection_issue_aggregates a
      where a.chapter_id = chapter and a.period_key = quarter.period_key
    ), '[]'::jsonb)
  );
end;
$function$;

drop function public.list_chapter_connection_profiles(text, text, integer, text);
create or replace function public.list_chapter_connection_profiles(
  p_selected_hat text,
  p_after_id text default null,
  p_limit integer default 250,
  p_snapshot_token text default null,
  p_chapter_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  viewer_chapter text;
  cap integer;
  current_epoch bigint;
  token_epoch bigint;
  snapshot_at timestamptz;
  token text;
  scope_hash text;
  after_id text;
  rows_out jsonb;
  fetched integer;
  last_id text;
begin
  org := private.mi1_require_selected_organization();
  viewer_chapter := private.chapter_connection_require_chapter(org, coalesce(nullif(pg_catalog.btrim(p_chapter_id), ''), private.current_member_chapter()));
  perform private.chapter_connection_require_hat(
    org, p_selected_hat, viewer_chapter, array['steward', 'coordinator', 'advisor', 'admin', 'vp']);

  scope_hash := pg_catalog.md5(org::text || ':' || viewer_chapter || ':' || p_selected_hat);

  cap := least(greatest(coalesce(p_limit, 250), 1), 500);
  after_id := nullif(pg_catalog.btrim(coalesce(p_after_id, '')), '');

  select e.epoch into current_epoch from private.chapter_connection_registry_epoch e where e.singleton;
  current_epoch := coalesce(current_epoch, 1);

  if p_snapshot_token is null then
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.now()))::double precision);
  else
    if p_snapshot_token !~ '^[0-9]{1,18}:[0-9]{1,12}:[a-f0-9]{32}$' then
      raise exception 'connection registry snapshot token invalid' using errcode = '22023';
    end if;
    token_epoch := pg_catalog.split_part(p_snapshot_token, ':', 1)::bigint;
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.split_part(p_snapshot_token, ':', 2)::double precision);
    if pg_catalog.split_part(p_snapshot_token, ':', 3) <> scope_hash then
      raise exception 'connection registry snapshot scope changed' using errcode = '22023';
    end if;
    if token_epoch <> current_epoch then
      raise exception 'connection registry snapshot changed' using errcode = '22023';
    end if;
    if snapshot_at > pg_catalog.now() + interval '1 minute'
       or snapshot_at < pg_catalog.now() - interval '1 hour' then
      raise exception 'connection registry snapshot expired' using errcode = '22023';
    end if;
  end if;
  token := current_epoch::text || ':' || pg_catalog.floor(extract(epoch from snapshot_at))::bigint::text || ':' || scope_hash;

  select
    coalesce(pg_catalog.jsonb_agg(page.item order by page.chapter_id collate "C"), '[]'::jsonb),
    pg_catalog.count(*)::integer,
    pg_catalog.max(page.chapter_id collate "C")
  into rows_out, fetched, last_id
  from (
    select
      p.chapter_id,
      private.chapter_connection_profile_projection(p, c.name) as item
    from private.chapter_connection_profiles p
    join public.chapters c on c.id = p.chapter_id and c.organization_id = p.organization_id
    join public.organizations o on o.id = p.organization_id and o.status = 'active'
    where p.publication_status = 'published'
      and p.expires_at > snapshot_at
      and p.chapter_id <> viewer_chapter
      and (after_id is null or p.chapter_id collate "C" > after_id collate "C")
      and not exists (
        select 1 from private.chapter_connection_hides h
        where (h.chapter_id = viewer_chapter and h.hidden_chapter_id = p.chapter_id)
           or (h.chapter_id = p.chapter_id and h.hidden_chapter_id = viewer_chapter)
      )
    order by p.chapter_id collate "C"
    limit cap + 1
  ) page;

  if fetched > cap then
    -- Drop the look-ahead row: the page is the first cap rows in order.
    rows_out := (
      select coalesce(pg_catalog.jsonb_agg(elem.value order by elem.ordinality), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(rows_out) with ordinality as elem
      where elem.ordinality <= cap
    );
    last_id := rows_out -> (cap - 1) ->> 'id';
  end if;

  return pg_catalog.jsonb_build_object(
    'snapshotToken', token,
    'snapshotAt', snapshot_at,
    'rows', rows_out,
    'nextCursor', case when fetched > cap then last_id else null end,
    'complete', fetched <= cap
  );
end;
$function$;
revoke all on function public.list_chapter_connection_profiles(text,text,integer,text,text) from public,anon,authenticated,service_role;
grant execute on function public.list_chapter_connection_profiles(text,text,integer,text,text) to authenticated;

create or replace function public.set_chapter_connection_hidden(
  p_selected_hat text,
  p_chapter_id text,
  p_target_chapter_id text,
  p_hidden boolean
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
  changed integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter, array['advisor', 'admin', 'vp']);
  if p_hidden is null then
    raise exception 'hidden flag required' using errcode = '22023';
  end if;
  target := nullif(pg_catalog.btrim(coalesce(p_target_chapter_id, '')), '');
  if target is null or target = chapter then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;
  if private.chapter_connection_recent_events(org, chapter, 'chapter_connection_hidden_changed') >= 100 then
    raise exception 'hide change limit' using errcode = '22023';
  end if;

  if p_hidden then
    if not exists (
      select 1
      from private.chapter_connection_profiles p
      join public.chapters c on c.id = p.chapter_id and c.organization_id = p.organization_id
      where p.chapter_id = target
        and p.publication_status = 'published'
        and p.expires_at > pg_catalog.now()
    ) then
      raise exception 'target chapter unavailable' using errcode = '22023';
    end if;
    insert into private.chapter_connection_hides (chapter_id, hidden_chapter_id, organization_id)
    values (chapter, target, org)
    on conflict (chapter_id, hidden_chapter_id) do nothing;
    get diagnostics changed = row_count;
  else
    delete from private.chapter_connection_hides h
    where h.chapter_id = chapter and h.hidden_chapter_id = target;
    get diagnostics changed = row_count;
  end if;

  perform private.chapter_connection_audit(org, chapter, 'chapter_connection_hidden_changed',
    pg_catalog.jsonb_build_object(
      'operation', case when p_hidden then 'hide' else 'unhide' end,
      'count', changed
    ));

  return pg_catalog.jsonb_build_object(
    'chapterId', chapter,
    'targetChapterId', target,
    'hidden', p_hidden,
    'changed', changed > 0,
    'hiddenChapterIds', coalesce((
      select pg_catalog.jsonb_agg(h.hidden_chapter_id order by h.hidden_chapter_id)
      from private.chapter_connection_hides h
      where h.chapter_id = chapter
    ), '[]'::jsonb)
  );
end;
$function$;


-- Changing the owning organization permanently withdraws the old publication,
-- including a move away and back. The new owner must publish explicitly.
create function private.chapter_connection_withdraw_reassigned()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  if new.organization_id is distinct from old.organization_id then
    update private.chapter_connection_profiles
    set publication_status = case when publication_version > 0 then 'withdrawn' else 'draft' end,
        published_at = null, expires_at = null, withdrawn_at = pg_catalog.now(),
        profile_revision = profile_revision + 1, updated_at = pg_catalog.now()
    where chapter_id = old.id;
  end if;
  return new;
end;
$function$;
revoke all on function private.chapter_connection_withdraw_reassigned() from public,anon,authenticated,service_role;
create trigger chapter_connection_withdraw_reassigned before update of organization_id on public.chapters
for each row execute function private.chapter_connection_withdraw_reassigned();

-- Every projection/visibility dependency invalidates a paged read. Statement
-- triggers also cover privileged maintenance and cascading deletions. Calls
-- through profile RPCs may advance the epoch twice; it is an opaque version.
create function private.chapter_connection_registry_changed()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform private.chapter_connection_bump_epoch();
  return null;
end;
$function$;
revoke all on function private.chapter_connection_registry_changed() from public,anon,authenticated,service_role;


create trigger chapter_connection_registry_changed after insert or update or delete on public.chapters
for each statement execute function private.chapter_connection_registry_changed();

create trigger chapter_connection_registry_changed after insert or update or delete on public.organizations
for each statement execute function private.chapter_connection_registry_changed();

create trigger chapter_connection_registry_changed after insert or update or delete on public.chapter_union_org_bindings
for each statement execute function private.chapter_connection_registry_changed();

create trigger chapter_connection_registry_changed after insert or update or delete on public.union_orgs
for each statement execute function private.chapter_connection_registry_changed();

create trigger chapter_connection_registry_changed after insert or update or delete on private.chapter_connection_profiles
for each statement execute function private.chapter_connection_registry_changed();

create trigger chapter_connection_registry_changed after insert or update or delete on private.chapter_connection_hides
for each statement execute function private.chapter_connection_registry_changed();


insert into private.account_lifecycle_trigger_review (kind,schema_name,table_name,object_name,definition_hash)
select kind,schema_name,table_name,object_name,definition_hash
from private.account_lifecycle_trigger_surface()
where (kind='trigger' and object_name in ('chapter_connection_registry_changed','chapter_connection_withdraw_reassigned'))
   or (kind='function' and schema_name='private' and object_name in (
     'chapter_connection_registry_changed()', 'chapter_connection_withdraw_reassigned()',
     'chapter_connection_bump_epoch()'
   ));
do $verify$
begin
  if exists(select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'connection registry trigger review incomplete';
  end if;
end;
$verify$;
comment on table private.chapter_connection_issue_aggregates is 'Frozen completed-quarter issue bands. Each topic needs 25 distinct reviewed contributors and at least 25 other distinct reviewed contributors. Reviewed empty-topic sources count only in the denominator. No exact counts are published.';
commit;
