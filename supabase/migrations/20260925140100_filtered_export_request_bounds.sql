-- SEC-UG-FILTERED-ORGANIZATION-EXPORT-REQUEST-BOUNDS-20260921
--
-- public.request_filtered_organization_export (live body 20260924030100)
-- admitted every call as a new export: no stable idempotency key and no
-- per-organization request bound. This migration:
--
-- 1. Adds p_idempotency_key uuid default null (the old four-argument
--    signature is dropped so named and positional callers resolve to one
--    function). A replay by the same caller with the same key while its
--    receipt is live returns that receiptId and expiry, writes no second
--    receipt and no second audit event, and is not counted by the bound. The
--    same key with a different format, domain set or date filter is refused
--    with 22023. The key is stored on organization_data_export_runs and is
--    unique per (organization, requester).
-- 2. Enforces 30 filtered export requests per organization per rolling hour,
--    counted from the durable organization_export_completed audit events
--    (receipts expire after 15 minutes, audit events do not). A request over
--    the bound is refused with 54000 before the export query or any write. A
--    per-organization transaction advisory lock serializes the count.
--
-- Authorization, domain cleaning, the 10000-row bound, the receipt purge, the
-- audit metadata and the case-graph entry statement are unchanged.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.organization_data_export_runs
  add column idempotency_key uuid;

create unique index organization_data_export_runs_idempotency_idx
  on public.organization_data_export_runs (organization_id, requested_by, idempotency_key)
  where idempotency_key is not null;

drop function public.request_filtered_organization_export(text[], text, timestamp with time zone, timestamp with time zone);

create function public.request_filtered_organization_export(p_domains text[], p_format text default 'csv'::text, p_from timestamp with time zone default null::timestamp with time zone, p_to timestamp with time zone default null::timestamp with time zone, p_idempotency_key uuid default null::uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  ctx record;
  clean_domains text[];
  rows jsonb;
  total integer;
  receipt uuid;
  expires timestamptz := pg_catalog.now() + interval '15 minutes';
  prior public.organization_data_export_runs%rowtype;
  recent_requests integer;
begin
  select * into ctx from private.institutional_context(true);
  if not private.has_organization_role(ctx.organization_id, array['admin','vp']) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  delete from public.organization_data_export_runs
  where organization_id = ctx.organization_id and expires_at <= pg_catalog.now();
  select pg_catalog.array_agg(domain order by domain) into clean_domains
  from (
    select distinct pg_catalog.btrim(value) as domain
    from pg_catalog.unnest(coalesce(p_domains, '{}'::text[])) value
  ) selected
  where domain = any(array['members','cases','tasks','minutes','timeline','contacts']::text[]);
  if p_format not in ('csv','json')
     or pg_catalog.cardinality(clean_domains) not between 1 and 6
     or pg_catalog.cardinality(clean_domains) <> pg_catalog.cardinality(p_domains)
     or (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception 'invalid export request' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('filtered-export:' || ctx.organization_id::text, 509)
  );
  if p_idempotency_key is not null then
    select * into prior from public.organization_data_export_runs r
    where r.organization_id = ctx.organization_id and r.requested_by = ctx.caller_id
      and r.idempotency_key = p_idempotency_key and r.expires_at > pg_catalog.now();
    if prior.id is not null and (
      prior.format <> p_format or prior.domains <> clean_domains
      or prior.filters <> pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('from', p_from, 'to', p_to))
    ) then
      raise exception 'invalid export request' using errcode = '22023';
    end if;
  end if;
  if prior.id is null then
    select pg_catalog.count(*)::integer into recent_requests
    from public.organization_audit_events e
    where e.organization_id = ctx.organization_id
      and e.event_type = 'organization_export_completed'
      and e.metadata->>'exportType' = 'filtered'
      and e.created_at > pg_catalog.now() - interval '1 hour';
    -- 30 filtered export requests per organization per rolling hour.
    if recent_requests >= 30 then
      raise exception 'export request limit reached: 30 per hour' using errcode = '54000';
    end if;
  end if;

  with export_rows as (
    select 'members'::text as domain, p.created_at as occurred_at,
      pg_catalog.jsonb_build_object(
        'memberId', p.id, 'name', p.full_name, 'memberSince', p.member_since,
        'chapterId', membership.chapter_id
      ) as values
    from public.member_profiles p
    join lateral (
      select cm.chapter_id
      from public.member_chapter_memberships cm
      join public.chapters c on c.id = cm.chapter_id
      where cm.user_id = p.id and cm.status = 'active' and c.organization_id = ctx.organization_id
      order by cm.chapter_id
      limit 1
    ) membership on true
    where 'members' = any(clean_domains)
    union all
    select 'cases', c.updated_at,
      pg_catalog.jsonb_build_object(
        'caseId', c.id, 'reference', c.reference, 'title', c.title, 'type', c.case_type,
        'step', c.step, 'status', c.status, 'deadline', c.deadline, 'memberId', c.user_id,
        'chapterId', p.chapter_id
      )
    from public.member_cases c join public.member_profiles p on p.id = c.user_id
    join public.chapters ch on ch.id = p.chapter_id
    where 'cases' = any(clean_domains) and ch.organization_id = ctx.organization_id
    union all
    select 'tasks', t.updated_at,
      pg_catalog.jsonb_build_object(
        'taskId', t.id, 'title', t.title, 'status', t.status, 'priority', t.priority,
        'workstream', t.workstream, 'dueDate', t.due_date, 'progress', t.progress,
        'blocked', t.blocked, 'chapterId', t.chapter_id
      )
    from public.chapter_tasks t join public.chapters ch on ch.id = t.chapter_id
    where 'tasks' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and t.deleted_at is null
    union all
    select 'minutes', r.occurred_at,
      pg_catalog.jsonb_build_object(
        'recordId', r.id, 'title', r.title, 'occurredAt', r.occurred_at,
        'status', r.lifecycle_status, 'visibility', r.visibility, 'version', r.version,
        'chapterId', r.chapter_id
      )
    from public.chapter_records r join public.chapters ch on ch.id = r.chapter_id
    where 'minutes' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and r.record_type = 'minutes' and r.archived_at is null
    union all
    select 'timeline', r.occurred_at,
      pg_catalog.jsonb_build_object(
        'recordId', r.id, 'type', r.record_type, 'title', r.title, 'body', r.body,
        'occurredAt', r.occurred_at, 'status', r.lifecycle_status,
        'visibility', r.visibility, 'version', r.version, 'pinned', r.pinned_at is not null,
        'gapNote', r.gap_note, 'chapterId', r.chapter_id
      )
    from public.chapter_records r join public.chapters ch on ch.id = r.chapter_id
    where 'timeline' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and r.record_type in ('decision','milestone') and r.archived_at is null
    union all
    select 'contacts', l.occurred_at,
      pg_catalog.jsonb_build_object(
        'contactId', l.id, 'kind', l.contact_kind, 'channel', l.channel,
        'purpose', l.purpose, 'summary', l.summary, 'outcome', l.outcome,
        'occurredAt', l.occurred_at, 'followUpAt', l.follow_up_at,
        'subjectMemberId', l.subject_user_id, 'caseId', l.case_id, 'taskId', l.task_id,
        'chapterId', l.chapter_id
      )
    from public.chapter_contact_log l
    where 'contacts' = any(clean_domains) and l.organization_id = ctx.organization_id and l.archived_at is null
  ), bounded as (
    select * from export_rows
    where (p_from is null or occurred_at >= p_from)
      and (p_to is null or occurred_at <= p_to)
    order by occurred_at desc, domain, values::text
    limit 10001
  )
  select pg_catalog.count(*)::integer,
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('domain', domain, 'occurredAt', occurred_at, 'values', values) order by occurred_at desc, domain), '[]'::jsonb)
  into total, rows from bounded;

  if total > 10000 then
    raise exception 'export exceeds 10000 rows; narrow the date range or domains' using errcode = '54000';
  end if;

  if prior.id is not null then
    receipt := prior.id;
    expires := prior.expires_at;
  else
  insert into public.organization_data_export_runs (
    organization_id, requested_by, format, domains, filters, row_count, expires_at, idempotency_key
  ) values (
    ctx.organization_id, ctx.caller_id, p_format, clean_domains,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('from', p_from, 'to', p_to)),
    total, expires, p_idempotency_key
  ) returning id into receipt;

  perform private.mi1_w2_write_audit(
    ctx.organization_id,
    'organization_export_completed',
    pg_catalog.jsonb_build_object(
      'exportType', 'filtered',
      'exportFormat', p_format,
      'rowCount', total,
      'status', 'completed'
    )
  );
  end if;

  return pg_catalog.jsonb_build_object(
    'receiptId', receipt, 'format', p_format, 'domains', clean_domains,
    'rowCount', total, 'expiresAt', expires, 'rows', rows
  );
end;
end;
$function$;

revoke all on function public.request_filtered_organization_export(text[], text, timestamp with time zone, timestamp with time zone, uuid) from public, anon, authenticated, service_role;
grant execute on function public.request_filtered_organization_export(text[], text, timestamp with time zone, timestamp with time zone, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
