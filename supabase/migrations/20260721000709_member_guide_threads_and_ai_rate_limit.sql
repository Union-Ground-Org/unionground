create table public.member_guide_threads (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.member_guide_messages
  add column thread_id uuid references public.member_guide_threads(id) on delete cascade;

do $$
declare
  owner record;
  new_thread_id uuid;
  first_question text;
begin
  for owner in select distinct user_id from public.member_guide_messages loop
    select left(body, 120)
      into first_question
      from public.member_guide_messages
      where user_id = owner.user_id and role = 'user'
      order by created_at
      limit 1;

    insert into public.member_guide_threads (user_id, title)
    values (owner.user_id, coalesce(nullif(first_question, ''), 'Previous Guide conversation'))
    returning id into new_thread_id;

    update public.member_guide_messages
      set thread_id = new_thread_id
      where user_id = owner.user_id;
  end loop;
end;
$$;

alter table public.member_guide_messages alter column thread_id set not null;

create table public.member_ai_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index member_guide_threads_user_updated_idx on public.member_guide_threads(user_id, updated_at desc);
create index member_guide_messages_thread_created_idx on public.member_guide_messages(thread_id, created_at);
create index member_ai_requests_user_created_idx on public.member_ai_requests(user_id, created_at desc);

create trigger member_guide_threads_touch_updated_at
before update on public.member_guide_threads
for each row execute function private.touch_updated_at();

alter table public.member_guide_threads enable row level security;
alter table public.member_ai_requests enable row level security;

create policy member_guide_threads_select_own
on public.member_guide_threads for select to authenticated
using ((select auth.uid()) = user_id);

create policy member_guide_threads_insert_own
on public.member_guide_threads for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy member_guide_threads_update_own
on public.member_guide_threads for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy member_guide_messages_insert_own on public.member_guide_messages;
create policy member_guide_messages_insert_own
on public.member_guide_messages for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.member_guide_threads thread
    where thread.id = thread_id
      and thread.user_id = (select auth.uid())
  )
);

create policy member_ai_requests_select_own
on public.member_ai_requests for select to authenticated
using ((select auth.uid()) = user_id);

create policy member_ai_requests_insert_own
on public.member_ai_requests for insert to authenticated
with check ((select auth.uid()) = user_id);

create or replace function public.reserve_member_ai_request()
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  recent_count integer;
begin
  if caller is null then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 509));

  select count(*)
    into recent_count
    from public.member_ai_requests
    where user_id = caller
      and created_at >= now() - interval '1 hour';

  if recent_count >= 20 then
    return false;
  end if;

  insert into public.member_ai_requests (user_id) values (caller);
  return true;
end;
$$;

revoke all on public.member_guide_threads, public.member_ai_requests from anon;
grant select, insert, update on public.member_guide_threads to authenticated;
grant select, insert on public.member_ai_requests to authenticated;

revoke all on function public.reserve_member_ai_request() from public, anon;
grant execute on function public.reserve_member_ai_request() to authenticated;
