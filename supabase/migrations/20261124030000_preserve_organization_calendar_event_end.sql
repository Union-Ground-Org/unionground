-- #9501: keep explicit chapter event ends in organization Google Calendar copies.
-- Replaces the work planner installed by 20261003053000. Deploy the worker
-- that reads endsAt before applying this migration.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

do $predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure('public.list_organization_calendar_push_work(integer,integer)')
  )) is distinct from '8cab89070851226757cec5c77d162fcf' then
    raise exception 'unreviewed predecessor: public.list_organization_calendar_push_work(integer,integer)' using errcode = '55000';
  end if;
end;
$predecessor$;

-- Adopt already-synced copies without scheduling a Google write. Change only
-- the hash: the adopted end is a baseline, not a claim about the remote copy.
-- An unmatched legacy hash still represents pending work.
select private.lock_case_graph(array[]::uuid[], array[]::uuid[]);

update private.organization_calendar_event_pushes p
set content_hash = pg_catalog.md5(pg_catalog.concat_ws(
  pg_catalog.chr(31), e.title, e.starts_at::text, e.location, e.summary,
  'ends_at=' || extract(epoch from e.ends_at)::text
))
from public.member_events e
join public.chapters ch on ch.id = e.chapter_id
join private.organization_calendar_push_connections c on c.organization_id = ch.organization_id
where p.organization_id = c.organization_id
  and p.event_id = e.id
  and p.google_event_id is not null
  and p.calendar_id = c.calendar_id
  and e.ends_at is not null
  and p.content_hash = pg_catalog.md5(pg_catalog.concat_ws(
    pg_catalog.chr(31), e.title, e.starts_at::text, e.location, e.summary
  ));

create or replace function public.list_organization_calendar_push_work(
  p_organization_limit integer,
  p_operation_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org_limit integer := least(greatest(coalesce(p_organization_limit, 10), 1), 50);
  op_limit integer := least(greatest(coalesce(p_operation_limit, 25), 1), 100);
  result jsonb := '[]'::jsonb;
  connection record;
  push_scope text;
  operations jsonb;
  found_orgs integer := 0;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  for connection in
    select c.organization_id, c.calendar_id
    from private.organization_calendar_push_connections c
    join public.organizations o on o.id = c.organization_id and o.status = 'active'
    where c.credential_ref is not null
      and (c.status = 'connected' or (c.status = 'error' and c.last_error_code is distinct from 'grant_revoked'))
    order by c.last_run_at nulls first, c.organization_id
    limit 500
  loop
    exit when found_orgs >= org_limit;
    continue when not private.organization_feature_enabled(connection.organization_id, 'features.integrations.org_calendar_push');
    push_scope := private.organization_setting_text(connection.organization_id, 'limits.integrations.org_calendar_push_scope');
    with source as (
      select e.id, e.title, e.starts_at, e.ends_at, e.location, e.summary,
        -- concat_ws skips the NULL tag, preserving the old hash for events without an end.
        pg_catalog.md5(pg_catalog.concat_ws(
          pg_catalog.chr(31), e.title, e.starts_at::text, e.location, e.summary,
          'ends_at=' || extract(epoch from e.ends_at)::text
        )) as content_hash
      from public.member_events e
      join public.chapters ch on ch.id = e.chapter_id and ch.organization_id = connection.organization_id
      where e.cancelled_at is null
        and e.starts_at >= pg_catalog.now() - interval '1 day'
        and e.starts_at < pg_catalog.now() + interval '400 days'
        and (push_scope = 'all_events' or e.is_public)
    ),
    pushes as (
      select p.*
      from private.organization_calendar_event_pushes p
      where p.organization_id = connection.organization_id
    ),
    work as (
      select 0 as rank_order, null::timestamptz as starts_at,
        pg_catalog.jsonb_build_object(
          'op', 'delete', 'eventId', p.event_id, 'googleEventId', p.google_event_id,
          'calendarId', p.calendar_id
        ) as item
      from pushes p
      left join source s on s.id = p.event_id
      where p.google_event_id is not null
        and (s.id is null or p.calendar_id is distinct from connection.calendar_id)
        and (p.last_failed_at is null
          or p.last_failed_at < pg_catalog.now() - pg_catalog.make_interval(mins => 15 * least(p.failure_count, 96)))
      union all
      select 1, s.starts_at,
        pg_catalog.jsonb_build_object(
          'op', 'upsert', 'eventId', s.id, 'googleEventId', p.google_event_id,
          'calendarId', connection.calendar_id, 'contentHash', s.content_hash,
          'event', pg_catalog.jsonb_build_object(
            'title', s.title, 'startsAt', s.starts_at, 'endsAt', s.ends_at, 'location', s.location, 'summary', s.summary
          )
        )
      from source s
      left join pushes p on p.event_id = s.id
      where (p.event_id is null
          or p.google_event_id is null
          or (p.calendar_id = connection.calendar_id and p.content_hash is distinct from s.content_hash))
        and (p.last_failed_at is null
          or p.last_failed_at < pg_catalog.now() - pg_catalog.make_interval(mins => 15 * least(p.failure_count, 96)))
    )
    select coalesce(pg_catalog.jsonb_agg(limited.item order by limited.rank_order, limited.starts_at, limited.item ->> 'eventId'), '[]'::jsonb)
      into operations
    from (
      select w.item, w.rank_order, w.starts_at
      from work w
      order by w.rank_order, w.starts_at nulls first, w.item ->> 'eventId'
      limit op_limit
    ) limited;
    continue when pg_catalog.jsonb_array_length(operations) = 0;
    found_orgs := found_orgs + 1;
    result := result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'organizationId', connection.organization_id,
      'calendarId', connection.calendar_id,
      'operations', operations
    ));
  end loop;
  return result;
end;
$function$;

commit;
