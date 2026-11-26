-- REQ-UG-COMPASS-ROLE-SUGGESTED-QUESTIONS-20261001 (restore-everything
-- lane L11a, Compass).
--
-- Role-specific suggested questions in the Compass panel that organization
-- admins can edit. The old app (git ref de7df4b57c^):
--   components/claude/suggested-questions.tsx:4-33  DEFAULT_SUGGESTIONS per role
--     (member 6, steward 5, admin 5) and getSuggestedQuestions(): the
--     organization's list when it is non-empty, else the role default.
--   supabase/migrations/0024_tier1_polish.sql:61  claude_suggested_questions
--     seeded '[]' (so production showed the role defaults).
-- One old JSON list applied to every role; here each role list is its own
-- text_list so an admin can edit the member, steward and admin chips
-- separately on the Feature switches & limits page. Coordinators and advisors
-- use the steward list and vice presidents the admin list (the old app had
-- no list for those hats).
--
-- A chip only fills the Compass composer; the person reviews and sends the
-- question, and /api/guide governs it exactly like typed text (same
-- minimization, grounding, organization switch and quotas). There is no
-- server behaviour to enforce beyond that, so these settings are presentation
-- values read through get_member_organization_configuration().switches.
--
-- Defaults: the switch had no old flag (the chips rendered whenever the
-- assistant did) => ON. The lists default to the old role defaults verbatim.
-- Production stays empty: the only rows written are platform definitions.

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- No old flag: suggested-questions.tsx rendered whenever the assistant did => ON.
  ('features.ai_assistant.suggested_questions', 'boolean', 'Compass suggested questions',
   'Show suggested questions in Compass for each role. Each question only fills the box; the person still sends it.',
   'true', null, null, null, 100, 'ai_assistant', true),
  -- de7df4b57c^ components/claude/suggested-questions.tsx:5-12 (member defaults).
  ('lists.ai_assistant.suggested_questions_member', 'text_list', 'Compass questions: members',
   'Suggested questions members see in Compass. Leave the defaults or write your own; at most 8.',
   '["What are my Weingarten rights during a disciplinary meeting?","How do I file a grievance?","What does the contract say about overtime?","How long do I have to respond to a disciplinary notice?","What is a Loudermill hearing and how should I prepare?","How do I find my steward?"]',
   0, 8, null, 110, 'ai_assistant', true),
  -- de7df4b57c^ components/claude/suggested-questions.tsx:13-19 (steward defaults).
  ('lists.ai_assistant.suggested_questions_steward', 'text_list', 'Compass questions: stewards',
   'Suggested questions stewards, coordinators and advisors see in Compass while working as staff. At most 8.',
   '["What''s our grievance win rate?","Show me member stats by unit","What contract articles are most commonly cited?","How is org health trending across departments?","Walk me through the non-selection grievance process"]',
   0, 8, null, 120, 'ai_assistant', true),
  -- de7df4b57c^ components/claude/suggested-questions.tsx:20-26 (admin defaults).
  ('lists.ai_assistant.suggested_questions_admin', 'text_list', 'Compass questions: admins',
   'Suggested questions admins and vice presidents see in Compass while working as staff. At most 8.',
   '["How''s org health trending?","Show me engagement trends for the last 6 months","What are the most cited contract articles in grievances?","How many members are in each unit?","What does the constitution say about elections?"]',
   0, 8, null, 130, 'ai_assistant', true)
on conflict (key) do nothing;

commit;
