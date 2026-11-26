-- REQ-UG-USAGE-BASED-NAVIGATION-20261001
--
-- Restore-everything campaign,. The old app ranked each member's
-- navigation by use (de7df4b57c^:lib/dashboard/nav-usage.ts): the top four
-- destinations of the last 30 days, recency-weighted 4x / 2x / 1x, became a
-- "Primary" group and reordered the bottom navigation
-- (de7df4b57c^:lib/dashboard/view-model.ts:75 and:94). The current product
-- has only the member's manual pinned shortcuts (src/components/PinnedShortcuts.jsx).
--
-- PRIVACY CHOICE: the old ranking read server-side page-view rows
-- (member_nav_weights / page_views). This restoration keeps the ranking ON THE
-- DEVICE ONLY: web counts live in the browser's localStorage and native counts
-- in the phone's secure storage, keyed to the signed-in account and
-- organization, and nothing about a visit is ever sent to the server. No
-- table, column, RPC or per-user log is added. The member can reset the
-- counts from Settings, and web sign-out forgets them.
--
-- The only server object is the organization switch, member-visible so web
-- and native can honour it. With it off, clients stop counting and show the
-- designed order. Default ON: the old app applied the ranking to every member
-- with no setting in front of it (view-model.ts:75 /:94 above).

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.home.usage_based_navigation', 'boolean', 'Most-used navigation',
   'Move each member''s four most-used destinations to the top of the menu, ranked on their own device only. Pinned shortcuts always win.',
   'true'::jsonb, null, null, null, 1320, 'home', true)
on conflict (key) do nothing;

notify pgrst, 'reload schema';

commit;
