insert into public.demo_members (id, first_name, full_name, initials, role_line, since_year, notification_count, demo_visible, order_index)
values ('11111111-1111-4111-8111-111111111111', 'Darnell', 'Darnell Foster', 'DF', 'Member · Lakeside Rehab Services DDS', 2023, 3, true, 0)
on conflict (id) do update set first_name = excluded.first_name, full_name = excluded.full_name, initials = excluded.initials, role_line = excluded.role_line, since_year = excluded.since_year, notification_count = excluded.notification_count, demo_visible = excluded.demo_visible, order_index = excluded.order_index;

insert into public.demo_weekly_summaries (id, done, goal, streak_days, demo_visible, order_index)
values ('current', 3, 5, 0, true, 0)
on conflict (id) do update set done = excluded.done, goal = excluded.goal, streak_days = excluded.streak_days, demo_visible = excluded.demo_visible, order_index = excluded.order_index;

insert into public.demo_week_days (id, label, active, is_today, day_number, demo_visible, order_index) values
  (1, 'M', false, false, null, true, 1),
  (2, 'T', true, false, null, true, 2),
  (3, 'W', false, false, null, true, 3),
  (4, 'T', true, false, null, true, 4),
  (5, 'F', true, false, null, true, 5),
  (6, 'S', false, false, null, true, 6),
  (7, 'S', false, true, '19', true, 7)
on conflict (id) do update set label = excluded.label, active = excluded.active, is_today = excluded.is_today, day_number = excluded.day_number, demo_visible = excluded.demo_visible, order_index = excluded.order_index;

insert into public.demo_plan_items (id, kind, icon, title, meta, action_label, demo_visible, order_index) values
  ('ballot-2026', 'ballot', '🗳', 'Ratify the 2026 Fictional Public Service Chapter 3E024208 action budget priorities', 'Closes Tue, Jul 21 · 7:59 PM', 'Vote', true, 1),
  ('pulse-new-members', 'pulse', '🩺', 'Which support would help newer members most?', '2-min pulse · Closes Jul 24', 'Answer', true, 2),
  ('weingarten', 'lesson', '📚', 'Weingarten · Know Your Rights', 'Use this if management pulls you into a meeting that could lead to discipline.', 'Start', true, 3)
on conflict (id) do update set kind = excluded.kind, icon = excluded.icon, title = excluded.title, meta = excluded.meta, action_label = excluded.action_label, demo_visible = excluded.demo_visible, order_index = excluded.order_index;

insert into public.demo_conversations (id, sender, initials, preview, date_label, unread_count, demo_visible, order_index) values
  ('bfd2c08d-384c-4fd1-85e1-5a746ccd63b7', 'Chapter steward', 'CS', 'Now the employer owes a written Step 2 answer, due at the end of next week.', 'Jul 12', 1, true, 1),
  ('de22135f-f0a9-47ac-a574-13faa786c049', 'Chapter steward', 'CS', 'HI', 'Jun 28', 0, true, 2)
on conflict (id) do update set sender = excluded.sender, initials = excluded.initials, preview = excluded.preview, date_label = excluded.date_label, unread_count = excluded.unread_count, demo_visible = excluded.demo_visible, order_index = excluded.order_index;

insert into public.demo_broadcasts (id, sender, title, body, unread, demo_visible, order_index) values
  ('announcement-1', 'Chapter steward', 'Fictional Public Service Chapter 3E024208 2024Q3 update', 'Chapter update for 2024Q3: members are tracking clear communication, upcoming meetings, and next steps.', true, true, 1),
  ('announcement-2', 'Chapter steward', 'Fictional Public Service Chapter 3E024208 2025Q1 update', 'Chapter update for 2025Q1: members are tracking contract enforcement, upcoming meetings, and next steps.', true, true, 2),
  ('announcement-3', 'Chapter steward', 'Fictional Public Service Chapter 3E024208 2024Q2 update', 'Chapter update for 2024Q2: members are tracking clear communication, upcoming meetings, and next steps.', true, true, 3),
  ('announcement-4', 'Chapter steward', 'Fictional Public Service Chapter 3E024208 2025Q3 update', 'Chapter update for 2025Q3: members are tracking contract enforcement, upcoming meetings, and next steps.', true, true, 4),
  ('announcement-5', 'Chapter steward', 'Fictional Public Service Chapter 3E024208 2026Q1 update', 'Chapter update for 2026Q1: members are tracking contract enforcement, upcoming meetings, and next steps.', true, true, 5),
  ('announcement-6', 'Chapter steward', 'Fictional Public Service Chapter 3E024208 2026Q2 update', 'Chapter update for 2026Q2: members are tracking contract enforcement, upcoming meetings, and next steps.', true, true, 6)
on conflict (id) do update set sender = excluded.sender, title = excluded.title, body = excluded.body, unread = excluded.unread, demo_visible = excluded.demo_visible, order_index = excluded.order_index;

insert into public.demo_cases (id, reference, title, deadline_label, case_type, articles, step, status, overdue, demo_visible, order_index) values
  ('b872b7c3-fdf2-497e-9d91-5b456724a1f0', 'GR-2026-509', 'Step 2 — discipline', 'Jun 21', 'Discipline', 'Article 12 — Discipline · Article 3 — Union Rights and Representation', 'Step 2', 'active', true, true, 1),
  ('resolved-telework', 'GR-2026-312', 'Telework schedule restored', 'Mar 14', 'Telework', 'Article 7 — Hours of Work', 'Closed', 'resolved', false, true, 2),
  ('resolved-safety', 'GR-2025-944', 'Safety equipment issued', 'Dec 18', 'Safety', 'Article 16 — Health and Safety', 'Closed', 'resolved', false, true, 3),
  ('resolved-scheduling', 'GR-2025-721', 'Scheduling shift corrected', 'Oct 9', 'Scheduling', 'Article 7 — Hours of Work', 'Closed', 'resolved', false, true, 4)
on conflict (id) do update set reference = excluded.reference, title = excluded.title, deadline_label = excluded.deadline_label, case_type = excluded.case_type, articles = excluded.articles, step = excluded.step, status = excluded.status, overdue = excluded.overdue, demo_visible = excluded.demo_visible, order_index = excluded.order_index;

insert into public.demo_metrics (id, cases_handled, tasks_done, open_cases, resolved_cases, case_types, weeks, demo_visible, order_index)
values ('current', 4, 0, 1, 3, '[{"label":"Discipline","value":1},{"label":"Telework","value":1},{"label":"Scheduling","value":1},{"label":"Safety","value":1}]'::jsonb, '[0,0,0,0,1,0,0,0,0,0,0,0]'::jsonb, true, 0)
on conflict (id) do update set cases_handled = excluded.cases_handled, tasks_done = excluded.tasks_done, open_cases = excluded.open_cases, resolved_cases = excluded.resolved_cases, case_types = excluded.case_types, weeks = excluded.weeks, demo_visible = excluded.demo_visible, order_index = excluded.order_index;

insert into public.demo_rights_lessons (id, selected_lesson, lesson_labels, eyebrow, title, description, steps, script, demo_visible, order_index)
values ('weingarten', 'Weingarten', '["Loudermill","Weingarten","Harassment","PIP / Accuracy Notice","Safety"]'::jsonb, 'Weingarten · walkthrough', 'Surprise disciplinary meeting', 'Use this if management pulls you into a meeting that could lead to discipline.', '["Ask whether the meeting could lead to discipline.","State that you want union representation before answering.","Do not answer substantive questions until a steward arrives."]'::jsonb, 'If this meeting could in any way lead to my being disciplined or terminated, I respectfully request union representation before answering questions.', true, 0)
on conflict (id) do update set selected_lesson = excluded.selected_lesson, lesson_labels = excluded.lesson_labels, eyebrow = excluded.eyebrow, title = excluded.title, description = excluded.description, steps = excluded.steps, script = excluded.script, demo_visible = excluded.demo_visible, order_index = excluded.order_index;
