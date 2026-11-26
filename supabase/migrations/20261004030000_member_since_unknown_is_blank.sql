-- BUG-UG-MEMBER-SINCE-WRONG-FOR-NEW-ACCOUNTS-20261003
--
-- "Member since" is the year a person joined their union. Creating an account
-- does not tell us that year: 20261003066000 replaced the constant 2023 with
-- the current year, which is the year the account was created, so a member who
-- joined years ago and is invited today still shows the wrong year. New
-- profiles now start with no value, shown as blank, until the member enters
-- their join year on their member card (the existing self-edit; there is no
-- admin editor for this column).
--
-- Existing rows are not changed. A stored year, including 2023, may be a real
-- join year; only the member, or a separately authorized data decision, can
-- say otherwise.
--
-- Hosted application: SAMPLE first, then production.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.member_profiles
  alter column member_since drop default,
  alter column member_since drop not null;

comment on column public.member_profiles.member_since is
  'Year the member joined their union, as the member entered it on their member card; null when unknown. Not the year the account was created.';

commit;
