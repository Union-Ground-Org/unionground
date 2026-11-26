-- REQ-UG-WORKSITES-SHIFTS-NONMEMBERS-AND-ROSTER-IMPORT-20261006.
-- Owner answer 2=A: member attributes and anonymous worksite reports;
-- no non-member contact table. CSV onboarding uses the existing invitation API.
-- The existing member-owned worksite remains the only profile worksite.
begin;
set local lock_timeout = '5s';

alter table public.member_profile_details
  add column shift text,
  add column classification text,
  add constraint member_profile_details_shift_bounded check (
    shift is null or (pg_catalog.char_length(shift) between 1 and 120 and shift !~ '[[:cntrl:]]')),
  add constraint member_profile_details_classification_bounded check (
    classification is null or (pg_catalog.char_length(classification) between 1 and 120 and classification !~ '[[:cntrl:]]'));

-- Org-managed suggestions, not another copy of member data. Renaming a list
-- entry never rewrites a member's saved choice or changes their visibility.
insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible)
values
  ('lists.organizing.worksites','text_list','Worksites','Worksites members can choose on their profile. One per line.','[]',0,50,null,210,'general',true),
  ('lists.organizing.shifts','text_list','Shifts','Shift names members can choose on their profile. One per line.','[]',0,50,null,211,'general',true),
  ('lists.organizing.classifications','text_list','Classifications','Job classifications members can choose on their profile. One per line.','[]',0,50,null,212,'general',true)
on conflict (key) do nothing;

create or replace function public.get_my_profile_details()
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
    'shift', row_found.shift, 'classification', row_found.classification,
    'workplaceOptions', pg_catalog.jsonb_build_object(
      'worksite', private.organization_setting_text_list(private.current_member_organization(), 'lists.organizing.worksites'),
      'shift', private.organization_setting_text_list(private.current_member_organization(), 'lists.organizing.shifts'),
      'classification', private.organization_setting_text_list(private.current_member_organization(), 'lists.organizing.classifications')),
    'phone', row_found.phone,
    'detailsVisibility', coalesce(row_found.details_visibility, 'only_me'),
    'phoneVisibility', coalesce(row_found.phone_visibility, 'only_me')
  );
end;

end;
$$;

revoke all on function public.get_my_profile_details() from public, anon, authenticated, service_role;
grant execute on function public.get_my_profile_details() to authenticated;

-- Atomic extended save. The six-argument RPC remains for older clients and
-- preserves shift/classification. Neither entry point accepts a member id.
create function public.set_my_profile_details_v2(p_details jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  if auth.uid() is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_details) is distinct from 'object'
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_details) k
       where k not in ('pronouns','jobTitle','worksite','shift','classification','phone','detailsVisibility','phoneVisibility'))
     or exists (select 1 from pg_catalog.jsonb_each(p_details) e
       where pg_catalog.jsonb_typeof(e.value) not in ('string','null')) then
    raise exception 'invalid profile details' using errcode = '22023';
  end if;
  if exists (select 1 from (values (p_details->>'shift'), (p_details->>'classification')) f(value)
    where pg_catalog.char_length(pg_catalog.btrim(f.value)) > 120 or f.value ~ '[[:cntrl:]]') then
    raise exception 'invalid workplace attribute' using errcode = '22023';
  end if;
  perform public.set_my_profile_details(p_details->>'pronouns',p_details->>'jobTitle',p_details->>'worksite',
    p_details->>'phone',p_details->>'detailsVisibility',p_details->>'phoneVisibility');
  update public.member_profile_details
    set shift = nullif(pg_catalog.btrim(p_details->>'shift'), ''),
        classification = nullif(pg_catalog.btrim(p_details->>'classification'), '')
    where user_id = auth.uid();
  return public.get_my_profile_details();
end;
$function$;
revoke all on function public.set_my_profile_details_v2(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.set_my_profile_details_v2(jsonb) to authenticated;

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
      case when d.details_visibility = 'admins' then d.shift end as shared_shift,
      case when d.details_visibility = 'admins' then d.classification end as shared_classification,
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
          'shift', s.shared_shift, 'classification', s.shared_classification,
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

create or replace function private.account_lifecycle_export_member_profile_details(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'user_id', t.user_id, 'pronouns', t.pronouns, 'job_title', t.job_title, 'worksite', t.worksite,
    'shift', t.shift, 'classification', t.classification, 'phone', t.phone, 'details_visibility', t.details_visibility, 'phone_visibility', t.phone_visibility,
    'updated_at', t.updated_at)), '[]'::jsonb)
  from public.member_profile_details t where t.user_id = p_caller;
$$;

revoke all on function private.account_lifecycle_export_member_profile_details(uuid) from public, anon, authenticated, service_role;

-- A digest is the only retained cohort state: no respondent identities,
-- worksites or answers are copied into this private release ledger. A changed
-- release remains withheld, including after someone restores the old inputs.
create table private.organization_survey_worksite_releases (
  survey_id uuid primary key references public.organization_surveys(id) on delete cascade,
  signature text not null check (signature ~ '^[0-9a-f]{64}$'),
  invalidated boolean not null default false
);
alter table private.organization_survey_worksite_releases enable row level security;
alter table private.organization_survey_worksite_releases force row level security;
revoke all on private.organization_survey_worksite_releases from public, anon, authenticated, service_role;
create trigger a00_case_graph_lock before insert or update or delete on private.organization_survey_worksite_releases
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_survey_worksite_releases
for each row execute function private.lock_case_graph_row_keys('', '');
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private' and table_name = 'organization_survey_worksite_releases'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

-- All-time, admin-only report: no arbitrary filter lets callers isolate a
-- person by differencing date windows. Unshared/blank worksites are unnamed.
-- The minimum applies to groups, answer cells and their complements. When a
-- group is hidden, suppress a second group; suppress unsafe questions across
-- every worksite so the overall report cannot reconstruct a missing cell.
create function public.get_organization_survey_worksites(p_survey_id uuid)
-- VOLATILE because the first successful release records a digest and a later
-- changed release permanently withholds it. This is an explicit button action,
-- never a passive read-RPC probe or a GET request.
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  org uuid;
  survey public.organization_surveys%rowtype;
  result jsonb;
  current_signature text;
  released private.organization_survey_worksite_releases%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  org := private.engagement_selected_organization();
  if auth.uid() is null or not private.has_organization_role(org, array['admin']) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;
  select * into survey from public.organization_surveys where id=p_survey_id and organization_id=org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  -- Serialize the first publication and comparisons for this survey. The
  -- digest and aggregates below share one statement snapshot, even if another
  -- transaction changes a profile, membership or answer during this request.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('worksite-release:' || survey.id::text, 0));
  select * into released from private.organization_survey_worksite_releases where survey_id=survey.id;
  if released.invalidated then
    return pg_catalog.jsonb_build_object('privacyMinResponses',survey.privacy_min_responses,
      'withheld',true,'releaseChanged',true,'groups','[]'::jsonb);
  end if;
  with sessions as materialized (
    select s.id,
      case when d.details_visibility='admins' then nullif(pg_catalog.btrim(d.worksite), '') end as site
    from public.organization_survey_sessions s
    left join public.member_profile_details d on d.user_id=s.respondent_user_id
      and exists (select 1 from public.organization_memberships m
        where m.user_id=s.respondent_user_id and m.organization_id=org and m.status='active')
      and exists (select 1 from public.member_chapter_memberships m
        join public.chapters c on c.id=m.chapter_id and c.organization_id=org
        where m.user_id=s.respondent_user_id and m.status='active')
    where s.organization_id=org and s.survey_id=survey.id and s.status='submitted'
  ), groups as materialized (
    select site, pg_catalog.count(*)::integer as n from sessions group by site
  ), hidden as (
    select * from groups where site is null or n < survey.privacy_min_responses
  ), visible as materialized (
    select * from groups g where g.site is not null and g.n >= survey.privacy_min_responses
      and (not exists (select 1 from hidden)
        or g.site <> (select g2.site from groups g2 where g2.site is not null
          and g2.n >= survey.privacy_min_responses order by g2.n, g2.site limit 1))
  ), cells as materialized (
    select q.id as question_id, s.site, a.value, pg_catalog.count(*)::integer as n
    from sessions s
    join public.organization_survey_answers a on a.session_id=s.id and a.organization_id=org
    join public.organization_survey_questions q on q.id=a.question_id
      and q.survey_id=survey.id and q.organization_id=org
    where q.question_type in ('radio','dropdown','yes_no','scale','rating')
    group by q.id, s.site, a.value
  ), unsafe as (
    select distinct c.question_id from cells c join groups g on g.site is not distinct from c.site
      where c.n < survey.privacy_min_responses
        or (g.n-c.n > 0 and g.n-c.n < survey.privacy_min_responses)
    union
    select q.id from public.organization_survey_questions q cross join groups g
      where q.survey_id=survey.id and q.organization_id=org
        and g.n - coalesce((select sum(c.n) from cells c where c.question_id=q.id
          and c.site is not distinct from g.site),0) between 1 and survey.privacy_min_responses-1
    union
    -- The largest cell has the smallest complement. If it is nonzero and
    -- small, hide the question everywhere, including sites with zero cells.
    select c.question_id from cells c group by c.question_id, c.value
      having sum(c.n)-max(c.n) between 1 and survey.privacy_min_responses-1
  )
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'minimum',survey.privacy_min_responses,
      'sessions',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(s.id,s.site) order by s.id) from sessions s),
      'answers',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.session_id,a.question_id,a.value) order by a.session_id,a.question_id)
        from public.organization_survey_answers a join sessions s on s.id=a.session_id
        where a.organization_id=org),
      'questions',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(q.id,q.question_type,q.label,q.sort_index) order by q.id)
        from public.organization_survey_questions q where q.survey_id=survey.id and q.organization_id=org)
    )::text, 'UTF8')), 'hex'), pg_catalog.jsonb_build_object(
    'privacyMinResponses',survey.privacy_min_responses,
    'withheld',exists(select 1 from groups g where not exists(select 1 from visible v where v.site=g.site)),
    'groups',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'worksite',v.site,'responseCount',v.n,
      'questions',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id',q.id,'label',q.label,
        'available',not exists(select 1 from unsafe u where u.question_id=q.id),
        'distribution',case when exists(select 1 from unsafe u where u.question_id=q.id) then '[]'::jsonb
          else coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value',c.value,'count',c.n) order by c.value)
            from cells c where c.question_id=q.id and c.site=v.site),'[]'::jsonb) end
      ) order by q.sort_index) from public.organization_survey_questions q
        where q.survey_id=survey.id and q.organization_id=org
          and q.question_type in ('radio','dropdown','yes_no','scale','rating')),'[]'::jsonb)
    ) order by v.site) from visible v),'[]'::jsonb)
  ) into current_signature, result;
  if released.signature is not null and released.signature <> current_signature then
    update private.organization_survey_worksite_releases set invalidated=true where survey_id=survey.id;
    return pg_catalog.jsonb_build_object('privacyMinResponses',survey.privacy_min_responses,
      'withheld',true,'releaseChanged',true,'groups','[]'::jsonb);
  end if;
  -- An entirely suppressed response publishes no cohort counts. It must not
  -- prevent the first useful report after enough responses arrive.
  if released.signature is null and pg_catalog.jsonb_array_length(result->'groups') > 0 then
    insert into private.organization_survey_worksite_releases(survey_id,signature)
      values(survey.id,current_signature);
  end if;
  return result;
end;
$function$;
revoke all on function public.get_organization_survey_worksites(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_organization_survey_worksites(uuid) to authenticated;

update private.account_lifecycle_manifest
set export_columns = export_columns || array['shift','classification']::text[],
    note = note || ' Shift and classification share the member-owned details visibility.', reviewed_at = date '2026-10-08'
where schema_name='public' and table_name='member_profile_details' and user_column='user_id';

notify pgrst, 'reload schema';
commit;
