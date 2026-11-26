create table if not exists public.member_forms (
  id           uuid primary key default extensions.gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  template_key text not null check (template_key in
    ('fmla_self','fmla_family','grievance','alliance_grievance','non_selection','alt_work','service_request')),
  status       text not null default 'draft' check (status in
    ('draft','submitted','in_review','approved','returned')),
  answers      jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(answers) = 'object' and pg_catalog.length(answers::text) <= 20000),
  step         smallint not null default 0 check (step between 0 and 50),
  review_note  text check (review_note is null or pg_catalog.char_length(review_note) <= 4000),
  reviewed_by  uuid,
  reviewed_at  timestamptz,
  submitted_at timestamptz,
  case_id      uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists member_forms_one_active_idx
  on public.member_forms (user_id, template_key) where status in ('draft','returned');
create index if not exists member_forms_user_updated_idx
  on public.member_forms (user_id, updated_at desc);
create index if not exists member_forms_inbox_idx
  on public.member_forms (submitted_at desc) where status in ('submitted','in_review');

alter table public.member_forms enable row level security;

drop policy if exists member_forms_select_own on public.member_forms;
create policy member_forms_select_own on public.member_forms
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.member_forms from anon, authenticated;
grant select on public.member_forms to authenticated;

alter table public.member_action_log drop constraint member_action_log_action_kind_check;
alter table public.member_action_log
  add constraint member_action_log_action_kind_check
  check (action_kind in
    ('seed','vote','survey','rights','case','message','steward','rsvp','checkin','workload','form'));

insert into public.member_point_rules (action_kind, label, points, weekly_cap)
  values ('form', 'File a form', 15, null)
  on conflict (action_kind) do update set label=excluded.label, points=excluded.points, weekly_cap=excluded.weekly_cap;

create or replace function private.award_member_points()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  rule record;
  backed boolean := false;
  awarded_this_week integer;
begin
  if new.action_kind = 'seed' then
    return new;
  end if;
  select points, weekly_cap into rule
  from public.member_point_rules
  where action_kind = new.action_kind and points > 0;
  if not found then
    return new;
  end if;
  if new.action_kind = 'vote' then
    backed := pg_catalog.left(new.action_key, 5) = 'vote-' and exists (
      select 1 from public.member_ballot_votes
      where user_id = new.user_id and ballot_id = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'survey' then
    backed := pg_catalog.left(new.action_key, 7) = 'survey-' and exists (
      select 1 from public.member_survey_responses
      where user_id = new.user_id and survey_id = pg_catalog.substr(new.action_key, 8));
  elsif new.action_kind = 'rights' then
    backed := pg_catalog.left(new.action_key, 7) = 'rights-' and exists (
      select 1 from public.member_rights_progress
      where user_id = new.user_id and lesson_id = pg_catalog.substr(new.action_key, 8)
        and pg_catalog.cardinality(completed_steps) > 0);
  elsif new.action_kind = 'case' then
    backed := pg_catalog.left(new.action_key, 5) = 'case-' and exists (
      select 1 from public.member_cases
      where user_id = new.user_id and reference = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'message' then
    backed := exists (
      select 1 from public.member_conversations
      where user_id = new.user_id
        and id::text = (pg_catalog.regexp_match(new.action_key, '^message-(.*)-[0-9]+$'))[1]);
  elsif new.action_kind = 'steward' then
    backed := exists (
      select 1 from public.member_steward_requests
      where user_id = new.user_id
        and coalesce(lesson_id, '') = coalesce((pg_catalog.regexp_match(new.action_key, '^steward-(.*)-[0-9]+$'))[1], ''));
  elsif new.action_kind = 'rsvp' then
    backed := pg_catalog.left(new.action_key, 5) = 'rsvp-' and exists (
      select 1 from public.member_event_rsvps
      where user_id = new.user_id and event_id = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'checkin' then
    backed := pg_catalog.left(new.action_key, 8) = 'checkin-' and exists (
      select 1 from public.member_event_checkins
      where user_id = new.user_id and event_id = pg_catalog.substr(new.action_key, 9));
  elsif new.action_kind = 'workload' then
    backed := pg_catalog.left(new.action_key, 9) = 'workload-' and exists (
      select 1 from public.member_workload_logs
      where user_id = new.user_id and id::text = pg_catalog.substr(new.action_key, 10));
  elsif new.action_kind = 'form' then
    backed := pg_catalog.left(new.action_key, 5) = 'form-' and exists (
      select 1 from public.member_forms
      where user_id = new.user_id and id::text = pg_catalog.substr(new.action_key, 6)
        and status <> 'draft');
  end if;
  if not backed then
    return new;
  end if;
  if rule.weekly_cap is not null then
    select count(*) into awarded_this_week
    from public.member_point_events
    where user_id = new.user_id and action_kind = new.action_kind
      and occurred_at >= pg_catalog.date_trunc('week', now());
    if awarded_this_week >= rule.weekly_cap then
      return new;
    end if;
  end if;
  insert into public.member_point_events (user_id, action_key, action_kind, points)
  values (new.user_id, new.action_key, new.action_kind, rule.points)
  on conflict (user_id, action_key) do nothing;
  return new;
end;
$function$;

create or replace function public.save_form_draft(p_template_key text, p_answers jsonb, p_step int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  existing uuid;
  clean jsonb := coalesce(p_answers, '{}'::jsonb);
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_template_key not in ('fmla_self','fmla_family','grievance','alliance_grievance','non_selection','alt_work','service_request')
    then raise exception 'invalid template' using errcode='22023'; end if;
  if pg_catalog.jsonb_typeof(clean) <> 'object' or pg_catalog.length(clean::text) > 20000
    then raise exception 'answers too large' using errcode='22023'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-form-'||caller::text||'-'||p_template_key, 509));
  select id into existing from public.member_forms
    where user_id=caller and template_key=p_template_key and status in ('draft','returned')
    order by updated_at desc limit 1;
  if existing is null then
    insert into public.member_forms (user_id, template_key, answers, step)
      values (caller, p_template_key, clean, least(greatest(coalesce(p_step,0),0),50))
      returning id into existing;
  else
    update public.member_forms set answers=clean, step=least(greatest(coalesce(p_step,0),0),50), updated_at=now()
      where id=existing and user_id=caller;
  end if;
  return existing;
end $$;
revoke all on function public.save_form_draft(text,jsonb,int) from public, anon;
grant execute on function public.save_form_draft(text,jsonb,int) to authenticated;

create or replace function public.submit_form(p_form_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  rec record;
  pts integer;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  select id, user_id, status into rec from public.member_forms where id=p_form_id for update;
  if not found or rec.user_id <> caller then raise exception 'form not found' using errcode='22023'; end if;
  if rec.status not in ('draft','returned') then raise exception 'form not submittable' using errcode='22023'; end if;

  update public.member_forms set status='submitted', submitted_at=now(), review_note=null, updated_at=now()
    where id=p_form_id and user_id=caller;
  insert into public.member_action_log (user_id, action_key, action_kind)
    values (caller, 'form-'||p_form_id::text, 'form') on conflict (user_id, action_key) do nothing;
  select points into pts from public.member_point_rules where action_kind='form';
  return pg_catalog.jsonb_build_object('status','submitted','awardedPoints', coalesce(pts,0));
end $$;
revoke all on function public.submit_form(uuid) from public, anon;
grant execute on function public.submit_form(uuid) to authenticated;
