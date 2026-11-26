drop policy if exists member_ai_requests_insert_own on public.member_ai_requests;
drop policy if exists member_ai_requests_select_own on public.member_ai_requests;

revoke select, insert on public.member_ai_requests from authenticated;
grant select, delete on public.member_ai_requests to service_role;
revoke insert, update on public.member_guide_threads from authenticated;
revoke insert on public.member_guide_messages from authenticated;

create index if not exists member_ai_requests_created_idx
  on public.member_ai_requests(created_at desc);

drop function if exists public.reserve_member_ai_request();

create function public.reserve_member_ai_request(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation_id uuid;
  recent_user_count integer;
  recent_global_count integer;
begin
  if p_user_id is null then
    return null;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-ai-global', 509)
  );

  delete from public.member_ai_requests
  where created_at < now() - interval '2 hours';

  select count(*)
    into recent_global_count
    from public.member_ai_requests
    where created_at >= now() - interval '1 hour';

  if recent_global_count >= 200 then
    return null;
  end if;

  select count(*)
    into recent_user_count
    from public.member_ai_requests
    where user_id = p_user_id
      and created_at >= now() - interval '1 hour';

  if recent_user_count >= 20 then
    return null;
  end if;

  insert into public.member_ai_requests (user_id)
  values (p_user_id)
  returning id into reservation_id;

  return reservation_id;
end;
$$;

create function public.release_member_ai_request(p_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if p_request_id is null then
    return false;
  end if;

  delete from public.member_ai_requests
  where id = p_request_id;

  get diagnostics deleted_count = row_count;
  return deleted_count = 1;
end;
$$;

create function public.get_member_guide_context()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  portal_context jsonb;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select pg_catalog.jsonb_build_object(
    'openCases', (
      select count(*)
      from public.member_cases
      where user_id = caller
        and status = 'active'
    ),
    'activePlanKinds', (
      select coalesce(pg_catalog.jsonb_agg(kind order by sort_order), '[]'::jsonb)
      from (
        select 'ballot'::text as kind, 1 as sort_order
        where exists (select 1 from public.member_ballots where active)
        union all
        select 'pulse'::text, 2
        where exists (select 1 from public.member_surveys where active)
        union all
        select 'lesson'::text, 3
        where exists (select 1 from public.member_rights_lessons)
      ) as plan_kinds
    ),
    'rightsLessons', (
      select coalesce(pg_catalog.jsonb_agg(label order by order_index), '[]'::jsonb)
      from (
        select label, order_index
        from public.member_rights_lessons
        order by order_index
        limit 12
      ) as lessons
    )
  ) into portal_context;

  return portal_context;
end;
$$;

create function public.save_member_guide_exchange(
  p_thread_id uuid,
  p_question text,
  p_answer text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  active_thread_id uuid := p_thread_id;
  clean_question text := pg_catalog.btrim(coalesce(p_question, ''));
  clean_answer text := pg_catalog.btrim(coalesce(p_answer, ''));
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if pg_catalog.char_length(clean_question) not between 1 and 1200 then
    raise exception 'question must be between 1 and 1200 characters' using errcode = '22023';
  end if;

  if pg_catalog.char_length(clean_answer) not between 1 and 4000 then
    raise exception 'answer must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  if active_thread_id is null then
    insert into public.member_guide_threads (user_id, title)
    values (caller, pg_catalog.left(clean_question, 120))
    returning id into active_thread_id;
  else
    perform 1
    from public.member_guide_threads
    where id = active_thread_id
      and user_id = caller
    for update;

    if not found then
      raise exception 'guide conversation not found' using errcode = '22023';
    end if;
  end if;

  insert into public.member_guide_messages (thread_id, user_id, role, body)
  values
    (active_thread_id, caller, 'user', clean_question),
    (active_thread_id, caller, 'assistant', clean_answer);

  update public.member_guide_threads
  set updated_at = now()
  where id = active_thread_id
    and user_id = caller;

  return active_thread_id;
end;
$$;

revoke all on function public.reserve_member_ai_request(uuid) from public, anon, authenticated;
revoke all on function public.release_member_ai_request(uuid) from public, anon, authenticated;
revoke all on function public.get_member_guide_context() from public, anon;
revoke all on function public.save_member_guide_exchange(uuid, text, text) from public, anon;

grant execute on function public.reserve_member_ai_request(uuid) to service_role;
grant execute on function public.release_member_ai_request(uuid) to service_role;
grant execute on function public.get_member_guide_context() to authenticated;
grant execute on function public.save_member_guide_exchange(uuid, text, text) to authenticated;
