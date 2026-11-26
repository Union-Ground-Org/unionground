create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.member_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null default 'Darnell',
  full_name text not null default 'Darnell Foster',
  initials text not null default 'DF',
  role_line text not null default 'Member · Care Services',
  member_since integer not null default 2023 check (member_since between 1900 and 2200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.member_notifications (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.member_conversations (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  initials text not null default 'CS',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.member_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  conversation_id uuid not null references public.member_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  sender_kind text not null check (sender_kind in ('member', 'steward')),
  sender_name text not null,
  body text not null check (char_length(body) between 1 and 4000),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.member_broadcasts (
  id text primary key,
  sender text not null,
  title text not null,
  body text not null,
  published_at timestamptz not null,
  order_index integer not null unique
);

create table public.member_broadcast_receipts (
  broadcast_id text not null references public.member_broadcasts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (broadcast_id, user_id)
);

create table public.member_cases (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reference text not null,
  title text not null,
  deadline date,
  case_type text not null,
  articles text not null default '',
  step text not null default 'Intake',
  status text not null default 'active' check (status in ('active', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, reference)
);

create table public.member_case_updates (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null references public.member_cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create table public.member_ballots (
  id text primary key,
  title text not null,
  closes_at timestamptz not null,
  active boolean not null default true,
  order_index integer not null unique
);

create table public.member_ballot_options (
  id text primary key,
  ballot_id text not null references public.member_ballots(id) on delete cascade,
  label text not null,
  order_index integer not null,
  unique (ballot_id, order_index)
);

create table public.member_ballot_votes (
  ballot_id text not null references public.member_ballots(id) on delete cascade,
  option_id text not null references public.member_ballot_options(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  submitted_at timestamptz not null default now(),
  primary key (ballot_id, user_id)
);

create table public.member_surveys (
  id text primary key,
  title text not null,
  closes_at timestamptz not null,
  active boolean not null default true,
  order_index integer not null unique
);

create table public.member_survey_options (
  id text primary key,
  survey_id text not null references public.member_surveys(id) on delete cascade,
  label text not null,
  order_index integer not null,
  unique (survey_id, order_index)
);

create table public.member_survey_responses (
  survey_id text not null references public.member_surveys(id) on delete cascade,
  option_id text not null references public.member_survey_options(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  submitted_at timestamptz not null default now(),
  primary key (survey_id, user_id)
);

create table public.member_rights_lessons (
  id text primary key,
  label text not null unique,
  title text not null,
  description text not null,
  steps jsonb not null check (jsonb_typeof(steps) = 'array'),
  script text not null,
  order_index integer not null unique
);

create table public.member_rights_progress (
  lesson_id text not null references public.member_rights_lessons(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  completed_steps integer[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (lesson_id, user_id)
);

create table public.member_steward_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson_id text references public.member_rights_lessons(id) on delete set null,
  status text not null default 'requested' check (status in ('requested', 'acknowledged', 'closed')),
  created_at timestamptz not null default now()
);

create table public.member_guide_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create table public.member_action_log (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_key text not null,
  action_kind text not null check (action_kind in ('seed', 'vote', 'survey', 'rights', 'case', 'message', 'steward')),
  occurred_at timestamptz not null default now(),
  unique (user_id, action_key)
);

create index member_notifications_user_created_idx on public.member_notifications(user_id, created_at desc);
create index member_conversations_user_updated_idx on public.member_conversations(user_id, updated_at desc);
create index member_messages_conversation_created_idx on public.member_messages(conversation_id, created_at);
create index member_cases_user_status_idx on public.member_cases(user_id, status, updated_at desc);
create index member_case_updates_case_created_idx on public.member_case_updates(case_id, created_at);
create index member_action_log_user_occurred_idx on public.member_action_log(user_id, occurred_at desc);

insert into public.member_broadcasts (id, sender, title, body, published_at, order_index) values
  ('broadcast-2026-q2', 'Chapter steward', 'Fictional Public Service Chapter 3E024208 Q2 update', 'Members are tracking contract enforcement, upcoming meetings, and next steps.', '2026-07-18T14:00:00Z', 1),
  ('broadcast-2026-q1', 'Chapter steward', 'Fictional Public Service Chapter 3E024208 Q1 update', 'Quarterly enforcement results and the next member meeting agenda are ready.', '2026-06-30T14:00:00Z', 2),
  ('broadcast-2025-q3', 'Chapter steward', 'Fictional Public Service Chapter 3E024208 Q3 update', 'Members closed three grievances and approved the fall bargaining priorities.', '2026-06-14T14:00:00Z', 3),
  ('broadcast-2025-q1', 'Chapter steward', 'Fictional Public Service Chapter 3E024208 Q1 update', 'Read the contract enforcement recap and upcoming training dates.', '2026-05-31T14:00:00Z', 4),
  ('broadcast-2024-q3', 'Chapter steward', 'Fictional Public Service Chapter 3E024208 Q3 update', 'Clear communication standards and member office hours are now posted.', '2026-05-16T14:00:00Z', 5),
  ('broadcast-2024-q2', 'Chapter steward', 'Fictional Public Service Chapter 3E024208 Q2 update', 'The chapter approved new communication practices and escalation contacts.', '2026-05-02T14:00:00Z', 6)
on conflict (id) do update set sender = excluded.sender, title = excluded.title, body = excluded.body, published_at = excluded.published_at, order_index = excluded.order_index;

insert into public.member_broadcasts (id, sender, title, body, published_at, order_index)
select
  'broadcast-archive-' || lpad(series::text, 2, '0'),
  'Chapter steward',
  'Member briefing ' || series,
  'Archived chapter briefing with meeting notes, contract reminders, and member follow-up actions.',
  '2026-05-02T14:00:00Z'::timestamptz - (series * interval '14 days'),
  6 + series
from generate_series(1, 14) as series
on conflict (id) do update set sender = excluded.sender, title = excluded.title, body = excluded.body, published_at = excluded.published_at, order_index = excluded.order_index;

insert into public.member_ballots (id, title, closes_at, active, order_index) values
  ('ballot-2026', 'Ratify the 2026 Fictional Public Service Chapter 3E024208 action budget priorities', '2027-07-22T00:00:00Z', true, 1)
on conflict (id) do update set title = excluded.title, closes_at = excluded.closes_at, active = excluded.active, order_index = excluded.order_index;

insert into public.member_ballot_options (id, ballot_id, label, order_index) values
  ('ballot-2026-yes', 'ballot-2026', 'Yes — ratify', 1),
  ('ballot-2026-no', 'ballot-2026', 'No — reject', 2),
  ('ballot-2026-abstain', 'ballot-2026', 'Abstain', 3)
on conflict (id) do update set label = excluded.label, order_index = excluded.order_index;

insert into public.member_surveys (id, title, closes_at, active, order_index) values
  ('pulse-new-members', 'Which support would help newer members most?', '2027-07-25T00:00:00Z', true, 1)
on conflict (id) do update set title = excluded.title, closes_at = excluded.closes_at, active = excluded.active, order_index = excluded.order_index;

insert into public.member_survey_options (id, survey_id, label, order_index) values
  ('pulse-new-members-mentor', 'pulse-new-members', 'A member mentor', 1),
  ('pulse-new-members-rights', 'pulse-new-members', 'More rights training', 2),
  ('pulse-new-members-office-hours', 'pulse-new-members', 'Weekly steward office hours', 3),
  ('pulse-new-members-updates', 'pulse-new-members', 'Shorter chapter updates', 4)
on conflict (id) do update set label = excluded.label, order_index = excluded.order_index;

insert into public.member_rights_lessons (id, label, title, description, steps, script, order_index) values
  ('loudermill', 'Loudermill', 'Before discipline is imposed', 'Use this when a public employer may discipline you without first letting you respond.', '["Ask for the charges and evidence.","Request a meaningful chance to respond.","Ask for union representation before answering."]', 'I am requesting notice of the charges, the evidence being considered, and a meaningful opportunity to respond with union representation.', 1),
  ('weingarten', 'Weingarten', 'Surprise disciplinary meeting', 'Use this if management pulls you into a meeting that could lead to discipline.', '["Ask whether the meeting could lead to discipline.","State that you want union representation before answering.","Do not answer substantive questions until a steward arrives."]', 'If this meeting could in any way lead to my being disciplined or terminated, I respectfully request union representation before answering questions.', 2),
  ('harassment', 'Harassment', 'Document and report harassment', 'Record what happened, preserve evidence, and reach a steward without escalating risk.', '["Write down dates, locations, and exact words.","Save messages and identify witnesses.","Contact a steward and follow the reporting plan."]', 'I am reporting conduct that may violate our workplace protections and request union assistance before any investigatory meeting.', 3),
  ('pip', 'PIP / Accuracy Notice', 'Respond to a performance notice', 'Use this before signing or answering a performance plan or accuracy notice.', '["Ask for a copy and time to review it.","Write that receipt is not agreement.","Contact a steward before submitting a response."]', 'My signature confirms receipt only, not agreement. I request time to review this with my union representative before responding.', 4),
  ('safety', 'Safety', 'Raise an immediate safety concern', 'Document the hazard and request a safe work plan without waiving protected rights.', '["Move away from immediate danger if necessary.","Report the hazard in writing.","Contact a steward and preserve the response."]', 'I am reporting a workplace safety concern and requesting written instructions and union assistance before proceeding.', 5)
on conflict (id) do update set label = excluded.label, title = excluded.title, description = excluded.description, steps = excluded.steps, script = excluded.script, order_index = excluded.order_index;

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger member_profiles_touch_updated_at before update on public.member_profiles for each row execute function private.touch_updated_at();
create trigger member_conversations_touch_updated_at before update on public.member_conversations for each row execute function private.touch_updated_at();
create trigger member_cases_touch_updated_at before update on public.member_cases for each row execute function private.touch_updated_at();

create or replace function private.handle_new_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_one uuid := extensions.gen_random_uuid();
  conversation_two uuid := extensions.gen_random_uuid();
  member_first text := coalesce(nullif(new.raw_user_meta_data ->> 'first_name', ''), 'Darnell');
  member_full text := coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), 'Darnell Foster');
  member_initials text := coalesce(nullif(new.raw_user_meta_data ->> 'initials', ''), 'DF');
begin
  insert into public.member_profiles (id, first_name, full_name, initials)
  values (new.id, member_first, member_full, member_initials);

  insert into public.member_notifications (user_id, title, body, created_at) values
    (new.id, 'Ballot closes soon', 'Cast your vote on the chapter action budget priorities.', now() - interval '1 hour'),
    (new.id, 'Case deadline', 'Your Step 2 response deadline needs attention.', now() - interval '4 hours'),
    (new.id, 'New chapter update', 'The latest fictional chapter broadcast is ready.', now() - interval '1 day');

  insert into public.member_conversations (id, user_id, title, initials, created_at, updated_at) values
    (conversation_one, new.id, 'Chapter steward', 'CS', now() - interval '9 days', now() - interval '8 days'),
    (conversation_two, new.id, 'Chapter steward', 'CS', now() - interval '23 days', now() - interval '22 days');

  insert into public.member_messages (conversation_id, user_id, sender_kind, sender_name, body, read_at, created_at) values
    (conversation_one, new.id, 'steward', 'Chapter steward', 'Now the employer owes a written Step 2 answer, due at the end of next week.', null, now() - interval '8 days'),
    (conversation_two, new.id, 'steward', 'Chapter steward', 'HI', now() - interval '21 days', now() - interval '22 days');

  insert into public.member_cases (user_id, reference, title, deadline, case_type, articles, step, status, created_at, updated_at) values
    (new.id, 'GR-2026-509', 'Step 2 — discipline', current_date - 29, 'Discipline', 'Article 12 — Discipline · Article 3 — Union Rights and Representation', 'Step 2', 'active', now() - interval '40 days', now() - interval '8 days'),
    (new.id, 'GR-2026-312', 'Telework schedule restored', current_date - 128, 'Telework', 'Article 7 — Hours of Work', 'Closed', 'resolved', now() - interval '160 days', now() - interval '120 days'),
    (new.id, 'GR-2025-944', 'Safety equipment issued', current_date - 214, 'Safety', 'Article 16 — Health and Safety', 'Closed', 'resolved', now() - interval '245 days', now() - interval '210 days'),
    (new.id, 'GR-2025-721', 'Scheduling shift corrected', current_date - 284, 'Scheduling', 'Article 7 — Hours of Work', 'Closed', 'resolved', now() - interval '310 days', now() - interval '280 days');

  insert into public.member_rights_progress (lesson_id, user_id, completed_steps)
  values ('weingarten', new.id, array[0]);

  insert into public.member_action_log (user_id, action_key, action_kind, occurred_at) values
    (new.id, 'seed-tuesday', 'seed', date_trunc('week', now()) + interval '1 day 12 hours'),
    (new.id, 'seed-thursday', 'seed', date_trunc('week', now()) + interval '3 days 12 hours'),
    (new.id, 'seed-friday', 'seed', date_trunc('week', now()) + interval '4 days 12 hours');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_member_app on auth.users;
create trigger on_auth_user_created_member_app
after insert on auth.users
for each row execute function private.handle_new_member();

alter table public.member_profiles enable row level security;
alter table public.member_notifications enable row level security;
alter table public.member_conversations enable row level security;
alter table public.member_messages enable row level security;
alter table public.member_broadcasts enable row level security;
alter table public.member_broadcast_receipts enable row level security;
alter table public.member_cases enable row level security;
alter table public.member_case_updates enable row level security;
alter table public.member_ballots enable row level security;
alter table public.member_ballot_options enable row level security;
alter table public.member_ballot_votes enable row level security;
alter table public.member_surveys enable row level security;
alter table public.member_survey_options enable row level security;
alter table public.member_survey_responses enable row level security;
alter table public.member_rights_lessons enable row level security;
alter table public.member_rights_progress enable row level security;
alter table public.member_steward_requests enable row level security;
alter table public.member_guide_messages enable row level security;
alter table public.member_action_log enable row level security;

create policy member_profiles_select_own on public.member_profiles for select to authenticated using ((select auth.uid()) = id);
create policy member_profiles_update_own on public.member_profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy member_notifications_select_own on public.member_notifications for select to authenticated using ((select auth.uid()) = user_id);
create policy member_notifications_update_own on public.member_notifications for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy member_conversations_select_own on public.member_conversations for select to authenticated using ((select auth.uid()) = user_id);
create policy member_conversations_insert_own on public.member_conversations for insert to authenticated with check ((select auth.uid()) = user_id);
create policy member_conversations_update_own on public.member_conversations for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy member_messages_select_own on public.member_messages for select to authenticated using ((select auth.uid()) = user_id and exists (select 1 from public.member_conversations c where c.id = conversation_id and c.user_id = (select auth.uid())));
create policy member_messages_insert_own on public.member_messages for insert to authenticated with check ((select auth.uid()) = user_id and sender_kind = 'member' and exists (select 1 from public.member_conversations c where c.id = conversation_id and c.user_id = (select auth.uid())));
create policy member_messages_update_own on public.member_messages for update to authenticated using ((select auth.uid()) = user_id and exists (select 1 from public.member_conversations c where c.id = conversation_id and c.user_id = (select auth.uid()))) with check ((select auth.uid()) = user_id and exists (select 1 from public.member_conversations c where c.id = conversation_id and c.user_id = (select auth.uid())));
create policy member_broadcasts_read_authenticated on public.member_broadcasts for select to authenticated using (true);
create policy member_broadcast_receipts_select_own on public.member_broadcast_receipts for select to authenticated using ((select auth.uid()) = user_id);
create policy member_broadcast_receipts_insert_own on public.member_broadcast_receipts for insert to authenticated with check ((select auth.uid()) = user_id);
create policy member_broadcast_receipts_update_own on public.member_broadcast_receipts for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy member_cases_select_own on public.member_cases for select to authenticated using ((select auth.uid()) = user_id);
create policy member_cases_insert_own on public.member_cases for insert to authenticated with check ((select auth.uid()) = user_id);
create policy member_cases_update_own on public.member_cases for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy member_case_updates_select_own on public.member_case_updates for select to authenticated using ((select auth.uid()) = user_id and exists (select 1 from public.member_cases c where c.id = case_id and c.user_id = (select auth.uid())));
create policy member_case_updates_insert_own on public.member_case_updates for insert to authenticated with check ((select auth.uid()) = user_id and exists (select 1 from public.member_cases c where c.id = case_id and c.user_id = (select auth.uid())));
create policy member_ballots_read_authenticated on public.member_ballots for select to authenticated using (true);
create policy member_ballot_options_read_authenticated on public.member_ballot_options for select to authenticated using (true);
create policy member_ballot_votes_select_own on public.member_ballot_votes for select to authenticated using ((select auth.uid()) = user_id);
create policy member_ballot_votes_insert_own on public.member_ballot_votes for insert to authenticated with check ((select auth.uid()) = user_id);
create policy member_ballot_votes_update_own on public.member_ballot_votes for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy member_surveys_read_authenticated on public.member_surveys for select to authenticated using (true);
create policy member_survey_options_read_authenticated on public.member_survey_options for select to authenticated using (true);
create policy member_survey_responses_select_own on public.member_survey_responses for select to authenticated using ((select auth.uid()) = user_id);
create policy member_survey_responses_insert_own on public.member_survey_responses for insert to authenticated with check ((select auth.uid()) = user_id);
create policy member_survey_responses_update_own on public.member_survey_responses for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy member_rights_lessons_read_authenticated on public.member_rights_lessons for select to authenticated using (true);
create policy member_rights_progress_select_own on public.member_rights_progress for select to authenticated using ((select auth.uid()) = user_id);
create policy member_rights_progress_insert_own on public.member_rights_progress for insert to authenticated with check ((select auth.uid()) = user_id);
create policy member_rights_progress_update_own on public.member_rights_progress for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy member_steward_requests_select_own on public.member_steward_requests for select to authenticated using ((select auth.uid()) = user_id);
create policy member_steward_requests_insert_own on public.member_steward_requests for insert to authenticated with check ((select auth.uid()) = user_id);
create policy member_guide_messages_select_own on public.member_guide_messages for select to authenticated using ((select auth.uid()) = user_id);
create policy member_guide_messages_insert_own on public.member_guide_messages for insert to authenticated with check ((select auth.uid()) = user_id);
create policy member_action_log_select_own on public.member_action_log for select to authenticated using ((select auth.uid()) = user_id);
create policy member_action_log_insert_own on public.member_action_log for insert to authenticated with check ((select auth.uid()) = user_id);
create policy member_action_log_update_own on public.member_action_log for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select, update on public.member_profiles to authenticated;
grant select, update on public.member_notifications to authenticated;
grant select, insert, update on public.member_conversations to authenticated;
grant select, insert, update (read_at) on public.member_messages to authenticated;
grant select on public.member_broadcasts to authenticated;
grant select, insert, update (read_at) on public.member_broadcast_receipts to authenticated;
grant select, insert, update on public.member_cases to authenticated;
grant select, insert on public.member_case_updates to authenticated;
grant select on public.member_ballots, public.member_ballot_options to authenticated;
grant select, insert, update on public.member_ballot_votes to authenticated;
grant select on public.member_surveys, public.member_survey_options to authenticated;
grant select, insert, update on public.member_survey_responses to authenticated;
grant select on public.member_rights_lessons to authenticated;
grant select, insert, update on public.member_rights_progress to authenticated;
grant select, insert on public.member_steward_requests to authenticated;
grant select, insert on public.member_guide_messages to authenticated;
grant select, insert, update (action_kind, occurred_at) on public.member_action_log to authenticated;

revoke all on function private.touch_updated_at() from public, anon, authenticated;
revoke all on function private.handle_new_member() from public, anon, authenticated;
