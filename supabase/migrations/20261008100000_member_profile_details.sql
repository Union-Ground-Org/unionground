-- REQ-UG-PROFILE-WORKPLACE-JOB-PHONE-AND-PRONOUNS-20261006.
--
-- A member keeps their own pronouns, job, worksite and phone on the profile
-- page and decides who sees them. These live in their own table, not on
-- member_profiles: stewards and coordinators read whole member_profiles rows
-- for name lookups, so a column there would reach them whatever the member
-- chose.
--
-- Visibility, one choice for job, worksite and pronouns and one for phone:
--   'only_me' (the default, and the meaning of no row) - nobody else reads it;
--   'admins' - the organization and chapter administrators who can open this
--              member in the admin member directory see it there.
-- No other reader exists. The table has no client grant; the two self-scoped
-- RPCs below are its only writer and reader, and the directory reads only
-- the fields the member shared.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The member's own details.
-- ---------------------------------------------------------------------------

create table public.member_profile_details (
  user_id uuid primary key references auth.users(id) on delete cascade,
  pronouns text,
  job_title text,
  worksite text,
  phone text,
  details_visibility text not null default 'only_me',
  phone_visibility text not null default 'only_me',
  updated_at timestamptz not null default pg_catalog.now(),
  constraint member_profile_details_pronouns_bounded check (
    pronouns is null or (pg_catalog.char_length(pronouns) between 1 and 40 and pronouns !~ '[[:cntrl:]]')
  ),
  constraint member_profile_details_job_title_bounded check (
    job_title is null or (pg_catalog.char_length(job_title) between 1 and 120 and job_title !~ '[[:cntrl:]]')
  ),
  constraint member_profile_details_worksite_bounded check (
    worksite is null or (pg_catalog.char_length(worksite) between 1 and 160 and worksite !~ '[[:cntrl:]]')
  ),
  constraint member_profile_details_phone_bounded check (
    phone is null or (pg_catalog.char_length(phone) between 7 and 40 and phone ~ '^[0-9+().\- ]+$')
  ),
  constraint member_profile_details_details_visibility_check
    check (details_visibility in ('only_me', 'admins')),
  constraint member_profile_details_phone_visibility_check
    check (phone_visibility in ('only_me', 'admins'))
);

alter table public.member_profile_details enable row level security;

create policy mfa_assurance on public.member_profile_details
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

-- Self-only read kept as a policy so a later grant can never widen it. There
-- is no client grant at all: the RPCs below are the only reader and writer.
create policy member_profile_details_select_own on public.member_profile_details
  for select to authenticated
  using ((select auth.uid()) = user_id);

comment on policy mfa_assurance on public.member_profile_details is
  'Restrictive MFA floor every RLS table carries: no authenticated read or write of a member''s profile details without an MFA-assured session.';
comment on policy member_profile_details_select_own on public.member_profile_details is
  'Self-only read of a member''s own profile details. Defense in depth: the table has no client grant; set_my_profile_details is the only writer, get_my_profile_details the member''s reader, and get_admin_member_directory reads only what the member shared with administrators.';

revoke all on public.member_profile_details from public, anon, authenticated, service_role;

comment on table public.member_profile_details is
  'A member''s own pronouns, job, worksite and phone, with who may see them (REQ-UG-PROFILE-WORKPLACE-JOB-PHONE-AND-PRONOUNS-20261006). No row means nothing saved and nothing shared. Written only by set_my_profile_details; no client grant.';

create trigger a00_case_graph_lock before insert or update or delete on public.member_profile_details
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.member_profile_details
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

-- ---------------------------------------------------------------------------
-- 2. The member's reader and writer. Neither takes a user id, so no caller
-- can read or write anyone else's details.
-- ---------------------------------------------------------------------------

create function public.get_my_profile_details()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  row_found public.member_profile_details%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into row_found from public.member_profile_details d where d.user_id = caller;
  return pg_catalog.jsonb_build_object(
    'pronouns', row_found.pronouns,
    'jobTitle', row_found.job_title,
    'worksite', row_found.worksite,
    'phone', row_found.phone,
    'detailsVisibility', coalesce(row_found.details_visibility, 'only_me'),
    'phoneVisibility', coalesce(row_found.phone_visibility, 'only_me')
  );
end;

end;
$$;

revoke all on function public.get_my_profile_details() from public, anon, authenticated, service_role;
grant execute on function public.get_my_profile_details() to authenticated;

create function public.set_my_profile_details(
  p_pronouns text,
  p_job_title text,
  p_worksite text,
  p_phone text,
  p_details_visibility text,
  p_phone_visibility text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  clean_pronouns text := nullif(pg_catalog.btrim(coalesce(p_pronouns, '')), '');
  clean_job_title text := nullif(pg_catalog.btrim(coalesce(p_job_title, '')), '');
  clean_worksite text := nullif(pg_catalog.btrim(coalesce(p_worksite, '')), '');
  clean_phone text := nullif(pg_catalog.btrim(coalesce(p_phone, '')), '');
  details_choice text := coalesce(p_details_visibility, 'only_me');
  phone_choice text := coalesce(p_phone_visibility, 'only_me');
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if details_choice not in ('only_me', 'admins') or phone_choice not in ('only_me', 'admins') then
    raise exception 'invalid visibility' using errcode = '22023';
  end if;
  if (clean_pronouns is not null and (pg_catalog.char_length(clean_pronouns) > 40 or clean_pronouns ~ '[[:cntrl:]]'))
     or (clean_job_title is not null and (pg_catalog.char_length(clean_job_title) > 120 or clean_job_title ~ '[[:cntrl:]]'))
     or (clean_worksite is not null and (pg_catalog.char_length(clean_worksite) > 160 or clean_worksite ~ '[[:cntrl:]]')) then
    raise exception 'invalid profile detail' using errcode = '22023';
  end if;
  if clean_phone is not null
     and (pg_catalog.char_length(clean_phone) not between 7 and 40 or clean_phone !~ '^[0-9+().\- ]+$') then
    raise exception 'invalid phone number' using errcode = '22023';
  end if;

  insert into public.member_profile_details as d (
    user_id, pronouns, job_title, worksite, phone, details_visibility, phone_visibility, updated_at
  ) values (
    caller, clean_pronouns, clean_job_title, clean_worksite, clean_phone, details_choice, phone_choice, pg_catalog.now()
  )
  on conflict (user_id) do update set
    pronouns = excluded.pronouns,
    job_title = excluded.job_title,
    worksite = excluded.worksite,
    phone = excluded.phone,
    details_visibility = excluded.details_visibility,
    phone_visibility = excluded.phone_visibility,
    updated_at = excluded.updated_at;

  return public.get_my_profile_details();
end;
end;
$$;

revoke all on function public.set_my_profile_details(text, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_my_profile_details(text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The admin member directory shows what the member shared with
-- administrators, and nothing they kept to themselves. Re-emitted from
-- 20261004050000 with the left join and the profileDetails key; every other
-- line is unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.get_admin_member_directory(
  p_query text default null,
  p_after_name text default null,
  p_after_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  org_admin boolean := private.has_organization_role(caller_org, array['admin']);
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
  cap integer := coalesce(p_limit, 25);
  result jsonb;
begin
  if caller is null or caller_org is null or caller_chapter is null
     or not (org_admin or private.member_has_chapter_role(caller_chapter, array['admin'])) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if cap < 1 or cap > 50 then
    raise exception 'limit out of range' using errcode = '22023';
  end if;
  if (p_after_name is null and p_after_id is not null)
     or (p_after_name is not null and p_after_id is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;
  if needle <> '' and pg_catalog.char_length(needle) < 2 then
    raise exception 'query too short' using errcode = '22023';
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
    needle, '\', '\\'), '%', '\%'), '_', '\_');

  with candidates as materialized (
    select p.id, p.full_name, p.initials,
      p.member_since::integer as member_since_year,
      located.chapter_id, located.chapter_name, located.display_title,
      private.organization_member_roles(
        p.id, caller_org, case when org_admin then null else caller_chapter end
      ) as roles,
      -- Only the fields the member shared with administrators leave this row.
      case when d.details_visibility = 'admins' then d.pronouns end as shared_pronouns,
      case when d.details_visibility = 'admins' then d.job_title end as shared_job_title,
      case when d.details_visibility = 'admins' then d.worksite end as shared_worksite,
      case when d.phone_visibility = 'admins' then d.phone end as shared_phone
    from public.member_profiles p
    join public.organization_memberships om
      on om.user_id = p.id
     and om.organization_id = caller_org
     and om.status = 'active'
    join lateral (
      select c.id as chapter_id, c.name as chapter_name, cm.display_title
      from public.member_chapter_memberships cm
      join public.chapters c
        on c.id = cm.chapter_id
       and c.organization_id = caller_org
      where cm.user_id = p.id
        and cm.status = 'active'
        and (org_admin or c.id = caller_chapter)
      order by (c.id = p.chapter_id) desc, c.order_index, c.id
      limit 1
    ) located on true
    left join public.member_profile_details d on d.user_id = p.id
    where (needle = '' or p.full_name ilike '%' || needle || '%' escape '\')
      and (p_after_name is null or (p.full_name, p.id) > (p_after_name, p_after_id))
    order by p.full_name, p.id
    limit cap + 1
  ), page as (
    select * from candidates order by full_name, id limit cap
  )
  select pg_catalog.jsonb_build_object(
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'userId', s.id,
        'fullName', s.full_name,
        'initials', s.initials,
        'memberSince', s.member_since_year,
        'chapterId', s.chapter_id,
        'chapterName', s.chapter_name,
        'displayTitle', s.display_title,
        'displayTitleEditable', private.member_invitation_chapter_administrable(s.chapter_id),
        'roles', s.roles,
        'profileDetails', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'pronouns', s.shared_pronouns,
          'jobTitle', s.shared_job_title,
          'worksite', s.shared_worksite,
          'phone', s.shared_phone
        ))
      ) order by s.full_name, s.id)
      from page s
    ), '[]'::jsonb),
    'nextCursor', case when (select pg_catalog.count(*) from candidates) > cap then (
      select pg_catalog.jsonb_build_object('name', s.full_name, 'id', s.id)
      from page s order by s.full_name desc, s.id desc limit 1
    ) else null end
  ) into result;
  return result;
end;
$function$;

revoke all on function public.get_admin_member_directory(text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_admin_member_directory(text, text, uuid, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Account lifecycle: the row is the member's own; it is exported to them
-- and deleted with the account.
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, export_projection_version, export_domain,
   export_columns, exclusion_reason, note, reviewed_at)
values
  ('public', 'member_profile_details', 'user_id', 'cascade', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.member_profile_details',
   array['user_id','pronouns','job_title','worksite','phone','details_visibility','phone_visibility','updated_at']::text[],
   null,
   'The member''s own pronouns, job, worksite, phone and visibility choices. Exported to that member; deleted with the account.',
   date '2026-10-08');

create function private.account_lifecycle_export_member_profile_details(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'user_id', t.user_id, 'pronouns', t.pronouns, 'job_title', t.job_title, 'worksite', t.worksite,
    'phone', t.phone, 'details_visibility', t.details_visibility, 'phone_visibility', t.phone_visibility,
    'updated_at', t.updated_at)), '[]'::jsonb)
  from public.member_profile_details t where t.user_id = p_caller;
$$;

revoke all on function private.account_lifecycle_export_member_profile_details(uuid) from public, anon, authenticated, service_role;

-- Re-emitted from the installed definition (20261003034000) with one added
-- domain; every other key is unchanged.
create or replace function private.account_lifecycle_export_additional_domains(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_space_notification_settings', private.account_lifecycle_export_chapter_space_notification_settings(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_event_contact_links', private.account_lifecycle_export_member_event_contact_links(p_caller), 'member_event_contact_opt_ins', private.account_lifecycle_export_member_event_contact_opt_ins(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_profile_details', private.account_lifecycle_export_member_profile_details(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller), 'steward_contact_preferences', private.account_lifecycle_export_steward_contact_preferences(p_caller)
  );
$$;

revoke all on function private.account_lifecycle_export_additional_domains(uuid) from public, anon, authenticated, service_role;

-- Reviewed trigger surface: the new table's lock gates.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'public' and table_name = 'member_profile_details'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_member_profile_details_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after member profile details: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after member profile details';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after member profile details';
  end if;
end;
$assert_member_profile_details_lifecycle$;

notify pgrst, 'reload schema';

commit;
