-- The bargaining survey switch's stored description uses this edition's word.
--
-- 20261123081000 stored the switch's label and description as the English web
-- catalogue worded them (settings.def.features.engagement_voice.
-- bargaining_survey_template.*), so a screen that falls back to the stored row
-- says the same thing. This edition's catalogue says "workers" where that
-- migration says "members"; the stored description now matches the catalogue.
-- The label, value, default, release hold and every other column stay as they are.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

update public.platform_setting_definitions
   set description = 'Staff can start a bargaining survey from a ready-made draft of common bargaining topics, edit it before publishing, and read its totals once 25 workers answer. Off: not offered.'
 where key = 'features.engagement_voice.bargaining_survey_template';

commit;
