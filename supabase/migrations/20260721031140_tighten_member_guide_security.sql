revoke all privileges on public.member_ai_requests from authenticated;

drop policy if exists member_ai_requests_service_role_all on public.member_ai_requests;
create policy member_ai_requests_service_role_all
on public.member_ai_requests for all to service_role
using (true)
with check (true);

create or replace function private.save_member_guide_exchange(
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

revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
revoke all on function private.save_member_guide_exchange(uuid, text, text) from public, anon;
grant execute on function private.save_member_guide_exchange(uuid, text, text) to authenticated;

create or replace function public.save_member_guide_exchange(
  p_thread_id uuid,
  p_question text,
  p_answer text
)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  select private.save_member_guide_exchange(p_thread_id, p_question, p_answer);
$$;

revoke all on function public.save_member_guide_exchange(uuid, text, text) from public, anon;
grant execute on function public.save_member_guide_exchange(uuid, text, text) to authenticated;
