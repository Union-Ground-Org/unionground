-- UX-UG-NEW-MEMBER-ROLE-LINE-LEGACY-TENANT-BRAND-20260921
--
-- public.member_profiles.role_line has carried the single-tenant default
-- 'Member · Care Services' since the first member workflow migration, back
-- when the product served one department. private.handle_new_member() inserts a new
-- profile without role_line, so every account created since organizations
-- landed adopts that literal and the member reads another employer's brand on
-- the Today header (src/views/TodayView.jsx) and the mobile home screen.
--
-- The trigger body is hash-pinned by the account lifecycle manifest and the
-- deletion finalization reconciliation, so the repair is the column default
-- alone: signup now yields a tenant-neutral 'Member'. Existing rows are left
-- as they are — the legacy string is a legitimate role line for Care Services
-- members and is set explicitly by the demo and SAMPLE seeds, so a blanket
-- backfill would overwrite chosen values as well as inherited ones.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.member_profiles
  alter column role_line set default 'Member';

comment on column public.member_profiles.role_line is
  'Free-text role line shown to the member on their own dashboard. The default is tenant-neutral: no organization brand may be assumed for an account that has not chosen one.';

commit;
