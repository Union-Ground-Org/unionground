-- REQ-UG-STEWARD-AMBIENT-HINTS-20261001
--
-- Restore-everything campaign,. The old app showed an ambient
-- knowledge hint on member AND steward home
-- (de7df4b57c^:components/home/ambient-knowledge-hint.tsx, rendered on the
-- steward home at components/home/steward-home-shell.tsx:91-92 from
-- getKnowledgeContent({ placement: 'Steward Pulse Hint', audience: 'Stewards' })
-- in components/home/lib/load-steward-home.ts:306). The member side survives
-- as the governed learning card on Home (LearningHomeCard); the steward side
-- was gone.
--
-- The steward desk overview now shows one compact hint from the same governed
-- learning library (public.list_learning_content), preferring items published
-- for the staff audience. That RPC already decides publication, locale,
-- module switches and audience (a steward reads 'all' and 'staff' items, never
-- 'members'-only ones), so no read path is added and nothing new becomes
-- readable. The only server object is the organization switch, member-visible
-- so the desk can honour it.
--
-- Default ON: the old flag ambient_knowledge_hints_enabled was forced to 'true'
-- for every deployment by de7df4b57c^:supabase/migrations/0480_force_redesign_settings.sql:19.

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.home.steward_ambient_hints', 'boolean', 'Steward ambient hints',
   'Show stewards one short hint from the organization''s published learning library on the steward desk overview.',
   'true'::jsonb, null, null, null, 1350, 'home', true)
on conflict (key) do nothing;

notify pgrst, 'reload schema';

commit;
