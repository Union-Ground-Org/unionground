-- REQ-UG-REACTIVATION-WELCOME-BACK-20261001
--
-- Restore-everything campaign,. The old app greeted a member
-- whose PREVIOUS session was more than 21 days ago with a calm, single
-- welcome-back screen and one picked next step instead of the full dashboard
-- (de7df4b57c^:lib/dashboard/disengagement.ts DISENGAGEMENT_THRESHOLD_DAYS = 21,
-- components/home/reactivation-hero.tsx, components/home/lib/reactivation-cta.ts,
-- app/dashboard/page.tsx:81-87). The current product has no such screen.
--
-- PRIVACY CHOICE (documented per the lane brief):
--   * The old check read the member's two newest page_views rows. The current
--     product deliberately stores no per-user page views
--     (organization_page_views is aggregated), and this migration does NOT add
--     one.
--   * auth.users.last_sign_in_at is not sufficient: a phone or browser stays
--     signed in through refresh tokens for months, so the last sign-in says
--     nothing about the last visit.
--   * Instead the server keeps exactly ONE value per account:
--     private.member_home_return_marks.last_active_on, a calendar DATE (no
--     time of day, no page, no organization, no device, no history). When Home
--     opens, public.record_member_home_return() reads the previous date,
--     overwrites it with today, and answers only whether today is a welcome
--     back. Repeated opens on the same day write nothing.
--   * The row is private-schema, RLS-forced, has no client grant, is readable
--     only through that RPC, is never shown to staff or included in any
--     roster or analytics, and is deleted with the account (manifest below).
--   * With the switch off nothing is read or written.
--
-- Switch and limit:
--   features.home.reactivation_welcome_back (member-visible) default ON: the
--     old dashboard ran the check for every non-staff member with no setting
--     in front of it (app/dashboard/page.tsx:81 `getDisengagementCheck` and
--:86 `if (!isStaff && isDisengaged)`).
--   limits.home.reactivation_after_days default 21
--     (lib/dashboard/disengagement.ts:6 DISENGAGEMENT_THRESHOLD_DAYS = 21),
--     bounded 7..365.

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.home.reactivation_welcome_back', 'boolean', 'Welcome-back screen after time away',
   'Greet a member returning after a long absence with one calm welcome-back screen and a single suggested next step before the full Home.',
   'true'::jsonb, null, null, null, 1330, 'home', true),
  ('limits.home.reactivation_after_days', 'integer', 'Welcome back after this many days away',
   'Days since a member last opened Home before the welcome-back screen is shown.',
   '21'::jsonb, 7, 365, null, 1331, 'home', false)
on conflict (key) do nothing;

create table private.member_home_return_marks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_active_on date not null
);

comment on table private.member_home_return_marks is
  'REQ-UG-REACTIVATION-WELCOME-BACK-20261001: one last-active DATE per account, used only to decide whether member Home opens with the welcome-back screen. No time, page, organization or history. Written and read only by public.record_member_home_return().';

alter table private.member_home_return_marks enable row level security;
alter table private.member_home_return_marks force row level security;
revoke all on table private.member_home_return_marks from public, anon, authenticated, service_role;

create trigger a00_case_graph_lock before insert or update or delete on private.member_home_return_marks
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_home_return_marks
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition, export_inventory_basis, exclusion_reason, note)
values
  ('private', 'member_home_return_marks', 'user_id', 'cascade', 'excluded_with_reason', 'auth_user_fk',
   'One last-active calendar date used only to choose the Home welcome-back view; contains no member-authored content.',
   'Removed with the account.');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private' and table_name = 'member_home_return_marks'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

do $assert_member_home_return_marks_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after member home return marks';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after member home return marks';
  end if;
end;
$assert_member_home_return_marks_lifecycle$;

-- Home calls this once per app session. It answers whether this visit is a
-- welcome back and records today's date in the same statement, so the
-- previous date is captured before it is overwritten.
create function public.record_member_home_return()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  declare
    caller uuid := (select auth.uid());
    org uuid;
    after_days integer;
    today date := (pg_catalog.now() at time zone 'UTC')::date;
    previous date;
  begin
    if caller is null or not private.mfa_satisfied() then
      raise exception 'authentication required' using errcode = '42501';
    end if;
    org := private.current_member_organization();
    if org is null or not private.is_organization_member(org) then
      raise exception 'active organization membership required' using errcode = '42501';
    end if;

    if not private.organization_feature_enabled(org, 'features.home.reactivation_welcome_back') then
      return pg_catalog.jsonb_build_object('enabled', false, 'welcomeBack', false);
    end if;
    after_days := private.organization_limit(org, 'limits.home.reactivation_after_days');

    select m.last_active_on into previous
    from private.member_home_return_marks m
    where m.user_id = caller
    for update;

    if previous is null then
      insert into private.member_home_return_marks (user_id, last_active_on)
      values (caller, today)
      on conflict (user_id) do update set last_active_on = excluded.last_active_on;
    elsif previous < today then
      update private.member_home_return_marks
        set last_active_on = today
        where user_id = caller;
    end if;

    -- Old rule: the previous session is MORE than the threshold ago.
    return pg_catalog.jsonb_build_object(
      'enabled', true,
      'welcomeBack', previous is not null and previous < today - after_days,
      'afterDays', after_days
    );
  end;
end;
$function$;

revoke all on function public.record_member_home_return() from public, anon, authenticated, service_role;
grant execute on function public.record_member_home_return() to authenticated;

comment on function public.record_member_home_return() is
  'REQ-UG-REACTIVATION-WELCOME-BACK-20261001: MFA-guarded; records the caller''s last-active date (one row per account) and reports whether this Home visit follows an absence longer than limits.home.reactivation_after_days. Does nothing when features.home.reactivation_welcome_back is off.';

notify pgrst, 'reload schema';

commit;
