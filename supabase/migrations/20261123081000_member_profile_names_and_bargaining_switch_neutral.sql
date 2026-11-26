-- BUG-UG-FIRST-CUSTOMER-LEFTOVERS-IN-WHAT-EVERY-UNION-GETS-20261122
--
-- Two first-customer leftovers in what every organization gets.
--
-- 1. public.member_profiles.first_name, full_name and initials have carried
--    one fictional person's name and initials as column defaults since the
--    first member workflow migration (20260720191847). Signup
--    (private.handle_new_member) supplies 'Member', 'Member' and 'M', so only
--    an insert that omits the names took the fictional one. The defaults
--    become those same signup values, as role_line's did
--    (20260925620700_member_profiles_role_line_neutral_default.sql): the
--    columns stay not null, and an insert that names only the id still works
--    and reads as a neutral member. Existing rows are left as they are: a
--    seed may set that name on purpose, so a backfill could overwrite a
--    chosen value as well as an inherited one.
--
-- 2. The platform definition of features.engagement_voice.bargaining_survey_template
--    (20261015142500) still describes the bargaining survey as built on one
--    named agreement's articles, for the organizations it covers. The
--    template is now a neutral draft of common bargaining topics, so the
--    stored label and description say that, matching the English web catalogue
--    (settings.def.features.engagement_voice.bargaining_survey_template.*).
--    The switch's value, default, release hold and every other column stay
--    as they are.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.member_profiles
  alter column first_name set default 'Member',
  alter column full_name set default 'Member',
  alter column initials set default 'M';

update public.platform_setting_definitions
   set label = 'Bargaining survey from a built-in template',
       description = 'Staff can start a bargaining survey from a ready-made draft of common bargaining topics, edit it before publishing, and read its totals once 25 members answer. Off: not offered.'
 where key = 'features.engagement_voice.bargaining_survey_template';

commit;
