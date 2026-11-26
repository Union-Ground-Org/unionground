-- REQ-UG-CIVIC-WATCHLIST-CALENDAR-20261012
--
-- Build-it-all campaign (civic watchlist and bargaining calendar).
-- features.civic.watchlist: the platform switch for the sourced civic
-- watchlist and state contract calendar on the Civic page (the content is
-- reference data in data/reference/civic/watchlist-calendar.json, every item
-- and row with its provenance record; docs/conventions/provenance.md).
-- Member-visible so web and native can show or hide the section honestly;
-- off by default. Turning it on is a platform editor's decision, so the key is
-- platform-only (organization_editable false): an organization admin cannot
-- override it, and readers ignore any stored organization value.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible, organization_editable)
values
  -- New in this campaign; no earlier default. Off until a platform editor
  -- turns it on.
  ('features.civic.watchlist', 'boolean', 'Civic watchlist and contract calendar',
   'Show members, on the Civic page, a sourced watchlist of bills, budgets, rates and agency changes, and when each state contract ends. General information, not legal advice.',
   'false', null, null, null, 2430, 'guidance_onboarding', true, false)
on conflict (key) do nothing;

commit;
