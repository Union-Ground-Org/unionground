-- BUG-UG-MEMBER-SINCE-WRONG-FOR-NEW-ACCOUNTS-20261003
--
-- public.member_profiles.member_since defaulted to the constant 2023, so every
-- account created by an invitation in 2026 showed "Member since 2023" in the
-- admin recovery search and the member directory (Harrow Bay pilot, October 3).
-- New profiles now default to the current year. The default uses the same
-- year expression as get_vp_overview's "new this year" count
-- (20260924160200_vp_overview_tenant_scope.sql), so an account created on the
-- evening of December 31 is counted in the year it was stamped with. Existing
-- rows are not rewritten: the year an account was created is not the year a
-- person joined their union, and SAMPLE's seeded profiles keep their values.
--
-- Hosted application: SAMPLE first, then production.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.member_profiles
  alter column member_since
  set default (pg_catalog.date_part('year', pg_catalog.now()))::integer;

comment on column public.member_profiles.member_since is
  'Year the member joined, as shown on staff screens. New profiles default to the current year, matching the staff overview''s new-this-year count; an admin can correct it.';

commit;
