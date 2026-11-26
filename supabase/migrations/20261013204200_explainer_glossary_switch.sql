-- REQ-UG-EXPLAINER-CONTENT-20261012
--
-- Build-it-all campaign (explanatory content). features.learn.glossary:
-- the platform switch for the sourced glossary on the Rights page (the terms
-- are content/explainer-content/glossary.json, English and Spanish, every term
-- with its provenance record; docs/conventions/provenance.md). Member-visible
-- so web and native can show or hide the section honestly; off by default.
-- Turning it on is the publication step, the owner's decision as platform
-- editor, so it is platform-wide (organization_editable false): an
-- organization admin sees it read-only and private.write_organization_setting
-- refuses it, and readers ignore any stored organization value. Publication
-- is a reviewed migration that sets default_value to 'true'.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible, organization_editable)
values
  -- New in this campaign; no earlier default. Off until the owner publishes.
  ('features.learn.glossary', 'boolean', 'Glossary',
   'Show members the sourced glossary of labor terms on the Rights page, in English and Spanish, each term with its sources. General information, not legal advice.',
   'false', null, null, null, 2420, 'guidance_onboarding', true, false)
on conflict (key) do nothing;

commit;
