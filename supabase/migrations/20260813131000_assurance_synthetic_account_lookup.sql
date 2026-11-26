-- SYS-UG-ASSURANCE-RADAR-20260812
--
-- Production assurance used to recover interrupted synthetic runs by paging
-- through every auth.users row and filtering email addresses in Node. That
-- stops being bounded as the member directory grows. Keep ownership selection
-- inside Postgres, persist it in an indexed private ownership registry, and
-- expose only UUID/timestamp cursor data to the service-role runner.

create table if not exists private.assurance_synthetic_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null
);

create index if not exists assurance_synthetic_accounts_stale_idx
  on private.assurance_synthetic_accounts (created_at, user_id);

revoke all on private.assurance_synthetic_accounts
  from public, anon, authenticated, service_role;

-- One deployment-time backfill captures accounts left by an older
-- runner. Runtime recovery never scans auth.users again.
insert into private.assurance_synthetic_accounts (user_id, created_at)
select u.id, u.created_at
from auth.users u
where u.email like 'assurance-browserbase-%@example.test'
   or u.email ~ '^browserbase-[a-f0-9]{16}@example[.]test$'
on conflict (user_id) do update set created_at = excluded.created_at;

create or replace function private.capture_assurance_synthetic_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email like 'assurance-browserbase-%@example.test'
      or new.email ~ '^browserbase-[a-f0-9]{16}@example[.]test$' then
    insert into private.assurance_synthetic_accounts (user_id, created_at)
    values (new.id, new.created_at)
    on conflict (user_id) do update set created_at = excluded.created_at;
  else
    delete from private.assurance_synthetic_accounts where user_id = new.id;
  end if;
  return new;
end
$$;

revoke all on function private.capture_assurance_synthetic_account()
  from public, anon, authenticated, service_role;

drop trigger if exists on_auth_user_assurance_registry on auth.users;
create trigger on_auth_user_assurance_registry
after insert or update of email on auth.users
for each row execute function private.capture_assurance_synthetic_account();

create or replace function public.list_stale_assurance_accounts(
  p_stale_before timestamptz,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  total_count bigint;
  page_rows jsonb;
  candidate_count integer;
  has_more boolean;
  next_cursor jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_stale_before is null then
    raise exception 'stale cutoff required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid assurance recovery page size' using errcode = '22023';
  end if;
  if (p_after_created_at is null) <> (p_after_id is null) then
    raise exception 'incomplete assurance recovery cursor' using errcode = '22023';
  end if;

  select pg_catalog.count(*)
    into total_count
  from private.assurance_synthetic_accounts a
  where a.created_at <= p_stale_before;

  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', candidate.user_id,
          'createdAt', pg_catalog.to_char(
            candidate.created_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        ) order by candidate.created_at, candidate.user_id
      ) filter (where candidate.ordinal <= p_limit),
      '[]'::jsonb
    ),
    pg_catalog.count(*)::integer
    into page_rows, candidate_count
  from (
    select
      a.user_id,
      a.created_at,
      pg_catalog.row_number() over (order by a.created_at, a.user_id) as ordinal
    from private.assurance_synthetic_accounts a
    where a.created_at <= p_stale_before
      and (
        p_after_created_at is null
        or (a.created_at, a.user_id) > (p_after_created_at, p_after_id)
      )
    order by a.created_at, a.user_id
    limit p_limit + 1
  ) candidate;

  has_more := candidate_count > p_limit;
  next_cursor := case
    when has_more then page_rows -> (pg_catalog.jsonb_array_length(page_rows) - 1)
    else null
  end;

  return pg_catalog.jsonb_build_object(
    'accounts', page_rows,
    'pageCount', pg_catalog.jsonb_array_length(page_rows),
    'totalCount', total_count,
    'hasMore', has_more,
    'nextCursor', next_cursor
  );
end
$$;

revoke all on function public.list_stale_assurance_accounts(timestamptz, timestamptz, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_stale_assurance_accounts(timestamptz, timestamptz, uuid, integer)
  to service_role;

comment on function public.list_stale_assurance_accounts(timestamptz, timestamptz, uuid, integer) is
  'Returns a bounded, keyset-paginated service-role view of stale assurance-owned auth identities without enumerating the member directory.';
