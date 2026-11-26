create table public.demo_members (
  id uuid primary key,
  first_name text not null,
  full_name text not null,
  initials text not null check (char_length(initials) between 1 and 4),
  role_line text not null,
  since_year integer not null check (since_year between 1900 and 2200),
  notification_count integer not null default 0 check (notification_count >= 0),
  demo_visible boolean not null default false,
  order_index integer not null default 0
);

create table public.demo_weekly_summaries (
  id text primary key,
  done integer not null check (done >= 0),
  goal integer not null check (goal > 0 and done <= goal),
  streak_days integer not null default 0 check (streak_days >= 0),
  demo_visible boolean not null default false,
  order_index integer not null default 0
);

create table public.demo_week_days (
  id smallint primary key,
  label text not null,
  active boolean not null default false,
  is_today boolean not null default false,
  day_number text,
  demo_visible boolean not null default false,
  order_index integer not null
);

create table public.demo_plan_items (
  id text primary key,
  kind text not null check (kind in ('ballot', 'pulse', 'lesson')),
  icon text not null,
  title text not null,
  meta text not null,
  action_label text not null,
  demo_visible boolean not null default false,
  order_index integer not null
);

create table public.demo_conversations (
  id uuid primary key,
  sender text not null,
  initials text not null,
  preview text not null,
  date_label text not null,
  unread_count integer not null default 0 check (unread_count >= 0),
  demo_visible boolean not null default false,
  order_index integer not null
);

create table public.demo_broadcasts (
  id text primary key,
  sender text not null,
  title text not null,
  body text not null,
  unread boolean not null default true,
  demo_visible boolean not null default false,
  order_index integer not null
);

create table public.demo_cases (
  id text primary key,
  reference text not null,
  title text not null,
  deadline_label text not null,
  case_type text not null,
  articles text not null,
  step text not null,
  status text not null check (status in ('active', 'resolved')),
  overdue boolean not null default false,
  demo_visible boolean not null default false,
  order_index integer not null
);

create table public.demo_metrics (
  id text primary key,
  cases_handled integer not null check (cases_handled >= 0),
  tasks_done integer not null check (tasks_done >= 0),
  open_cases integer not null check (open_cases >= 0),
  resolved_cases integer not null check (resolved_cases >= 0),
  case_types jsonb not null check (jsonb_typeof(case_types) = 'array'),
  weeks jsonb not null check (jsonb_typeof(weeks) = 'array'),
  demo_visible boolean not null default false,
  order_index integer not null default 0
);

create table public.demo_rights_lessons (
  id text primary key,
  selected_lesson text not null,
  lesson_labels jsonb not null check (jsonb_typeof(lesson_labels) = 'array'),
  eyebrow text not null,
  title text not null,
  description text not null,
  steps jsonb not null check (jsonb_typeof(steps) = 'array'),
  script text not null,
  demo_visible boolean not null default false,
  order_index integer not null default 0
);

alter table public.demo_members enable row level security;
alter table public.demo_weekly_summaries enable row level security;
alter table public.demo_week_days enable row level security;
alter table public.demo_plan_items enable row level security;
alter table public.demo_conversations enable row level security;
alter table public.demo_broadcasts enable row level security;
alter table public.demo_cases enable row level security;
alter table public.demo_metrics enable row level security;
alter table public.demo_rights_lessons enable row level security;

grant usage on schema public to anon, authenticated;
grant select on table
  public.demo_members,
  public.demo_weekly_summaries,
  public.demo_week_days,
  public.demo_plan_items,
  public.demo_conversations,
  public.demo_broadcasts,
  public.demo_cases,
  public.demo_metrics,
  public.demo_rights_lessons
to anon, authenticated;

create policy "demo members are readable" on public.demo_members for select to anon, authenticated using (demo_visible);
create policy "demo weekly summaries are readable" on public.demo_weekly_summaries for select to anon, authenticated using (demo_visible);
create policy "demo week days are readable" on public.demo_week_days for select to anon, authenticated using (demo_visible);
create policy "demo plan items are readable" on public.demo_plan_items for select to anon, authenticated using (demo_visible);
create policy "demo conversations are readable" on public.demo_conversations for select to anon, authenticated using (demo_visible);
create policy "demo broadcasts are readable" on public.demo_broadcasts for select to anon, authenticated using (demo_visible);
create policy "demo cases are readable" on public.demo_cases for select to anon, authenticated using (demo_visible);
create policy "demo metrics are readable" on public.demo_metrics for select to anon, authenticated using (demo_visible);
create policy "demo rights lessons are readable" on public.demo_rights_lessons for select to anon, authenticated using (demo_visible);

comment on schema public is 'Exposed demo API. Every table uses RLS and explicit grants.';
