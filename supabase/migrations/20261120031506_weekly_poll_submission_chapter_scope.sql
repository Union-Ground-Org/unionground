-- #9279: a weekly submission belongs to the current chapter after a move.
-- Restates the newest 20261117121800 bodies, preserving case-graph locking,
-- Eastern week boundaries, validation, MFA and editorial protections.
-- Existing questions stay in their original chapter, with all content intact.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

-- Refuse an unreviewed intervening restatement rather than overwrite it.
do $preflight$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.submit_weekly_question(text)'))
    is distinct from 'ab1ff8c79b4e8b9679ab915a073e4322' then
    raise exception 'unreviewed predecessor: public.submit_weekly_question' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.submit_weekly_poll_question(text,jsonb)'))
    is distinct from 'c084ae31d35a914df1209d1629472a64' then
    raise exception 'unreviewed predecessor: public.submit_weekly_poll_question' using errcode = '55000';
  end if;
end;
$preflight$;

alter table public.member_weekly_questions
  drop constraint member_weekly_questions_user_id_week_start_key,
  add constraint member_weekly_questions_user_chapter_week_key
    unique (user_id, chapter_id, week_start);

create or replace function public.submit_weekly_poll_question(p_body text, p_options jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  current_week date := pg_catalog.date_trunc('week', private.eastern_day()::timestamp)::date;
  clean_body text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_body, ''), '[[:cntrl:]]', ' ', 'g'));
  option_item jsonb;
  option_value text;
  option_values text[] := array[]::text[];
  clean_options jsonb := '[]'::jsonb;
  question_id uuid;
  inserted boolean := false;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 10 and 280
     or pg_catalog.jsonb_typeof(p_options) <> 'array'
     or pg_catalog.jsonb_array_length(p_options) not between 2 and 8 then
    raise exception 'question and 2 to 8 answer options are required' using errcode = '22023';
  end if;
  for option_item in select value from pg_catalog.jsonb_array_elements(p_options)
  loop
    option_value := case when pg_catalog.jsonb_typeof(option_item) = 'string' then option_item #>> '{}' else null end;
    option_value := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(option_value, ''), '[[:cntrl:]]', ' ', 'g'));
    if pg_catalog.char_length(option_value) not between 1 and 120 then
      raise exception 'answer options must be plain text up to 120 characters' using errcode = '22023';
    end if;
    if option_value = any(option_values) then
      raise exception 'answer options must be unique' using errcode = '22023';
    end if;
    option_values := pg_catalog.array_append(option_values, option_value);
    clean_options := clean_options || pg_catalog.jsonb_build_array(option_value);
  end loop;

  insert into public.member_weekly_questions (chapter_id, user_id, week_start, body, options)
  values (caller_chapter, caller, current_week, clean_body, clean_options)
  on conflict (user_id, chapter_id, week_start) do nothing
  returning id into question_id;
  inserted := question_id is not null;
  if not inserted then
    select q.id into question_id
    from public.member_weekly_questions q
    where q.user_id = caller and q.chapter_id = caller_chapter and q.week_start = current_week
    for update;
    update public.member_weekly_questions
    set body = clean_body, options = clean_options, updated_at = pg_catalog.now()
    where id = question_id and chapter_id = caller_chapter and editorial_state = 'submitted';
    if not found then
      raise exception 'reserved or published questions cannot be edited' using errcode = '22023';
    end if;
  end if;
  return pg_catalog.jsonb_build_object('id', question_id, 'created', inserted);
end;
end;
$function$;

-- Keep the client-revoked legacy body compatible with the new unique key.
create or replace function public.submit_weekly_question(p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  current_week date := pg_catalog.date_trunc('week', private.eastern_day()::timestamp)::date;
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  question_id uuid;
  inserted boolean := false;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 10 and 280 then
    raise exception 'question must be 10 to 280 characters' using errcode = '22023';
  end if;

  insert into public.member_weekly_questions (chapter_id, user_id, week_start, body)
  values (caller_chapter, caller, current_week, clean_body)
  on conflict (user_id, chapter_id, week_start) do nothing
  returning id into question_id;
  inserted := question_id is not null;
  if not inserted then
    select q.id into question_id from public.member_weekly_questions q
    where q.user_id = caller and q.chapter_id = caller_chapter and q.week_start = current_week;
  end if;

  return pg_catalog.jsonb_build_object('id', question_id, 'created', inserted);
end;
end;
$$;

revoke all on function public.submit_weekly_question(text) from public, anon, authenticated, service_role;

commit;
