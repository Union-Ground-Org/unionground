-- REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030 (#6642, owner
-- request, Oct 30, 2026).
--
-- A form asks the member whether to fill its workplace fields from what the
-- member already keeps, and only what the member has shared:
--
-- 1. public.member_profile_details.form_autofill: the member's standing
--    answer, 'ask' (the default), 'always' or 'never', changed in Settings.
-- 2. public.get_my_form_autofill(): the caller's own values a form may fill.
--    Job title, worksite (a chapter unit is recorded as the worksite), shift
--    and classification come back only while the member shares their work
--    details with the organization (details_visibility = 'admins'); otherwise
--    they are null, so a form can never fill a detail the member kept to
--    themselves. The chapter is the member's own chapter in the selected
--    organization, and the employer is that organization's own local profile
--    entry. The read takes no user id and returns nobody else's data.
-- 3. public.set_my_form_autofill_preference(p_preference): the member's own
--    answer; it writes nothing else.
-- 4. public.member_forms.profile_autofill: which fields of a form the member
--    accepted from the profile, as { field key: kind }, recorded on their own
--    draft by public.record_form_profile_autofill(p_form_id, p_fields) with
--    the draft's saves and before it is submitted. Only field keys and kinds
--    are kept, never the values a second time.
--
-- Every function is SECURITY DEFINER with an empty search_path, checks
-- two-step sign-in and a full (not PIN) session itself, and the writers take
-- the case-graph gate first, as public.set_my_profile_details does.

begin;
set local lock_timeout = '5s';

alter table public.member_profile_details
  add column form_autofill text not null default 'ask',
  add constraint member_profile_details_form_autofill_check
    check (form_autofill in ('ask', 'always', 'never'));
comment on column public.member_profile_details.form_autofill is
  'REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: whether forms ask (default), always fill or never fill the member''s shared workplace details.';

alter table public.member_forms
  add column profile_autofill jsonb not null default '{}'::jsonb,
  add constraint member_forms_profile_autofill_check check (
    pg_catalog.jsonb_typeof(profile_autofill) = 'object'
    and pg_catalog.pg_column_size(profile_autofill) <= 2048
  );
comment on column public.member_forms.profile_autofill is
  'REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: the workplace fields the member accepted from their profile on this form, { field key: kind } (no values). Written only by public.record_form_profile_autofill.';

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
    'form_autofill', t.form_autofill, 'updated_at', t.updated_at)), '[]'::jsonb)
  from public.member_profile_details t where t.user_id = p_caller;
$$;
revoke all on function private.account_lifecycle_export_member_profile_details(uuid) from public, anon, authenticated, service_role;

update private.account_lifecycle_manifest
set export_columns = export_columns || array['form_autofill']::text[],
    note = note || ' form_autofill is the member''s own ask, always or never answer for filling forms.', reviewed_at = date '2026-10-31'
where schema_name = 'public' and table_name = 'member_profile_details' and user_column = 'user_id';

create function public.get_my_form_autofill()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  org uuid;
  details public.member_profile_details%rowtype;
  shared boolean;
  chapter_name text;
  employer text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.current_member_organization();
  select * into details from public.member_profile_details d where d.user_id = caller;
  shared := coalesce(details.details_visibility, 'only_me') = 'admins';
  select nullif(pg_catalog.btrim(c.name), '') into chapter_name
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id and c.organization_id = org
  where p.id = caller;
  select nullif(pg_catalog.btrim(l.employer), '') into employer
  from private.organization_local_profiles l
  where l.organization_id = org;
  return pg_catalog.jsonb_build_object(
    'preference', coalesce(details.form_autofill, 'ask'),
    'shared', shared,
    'values', pg_catalog.jsonb_build_object(
      'employer', employer,
      'chapter', chapter_name,
      'jobTitle', case when shared then details.job_title end,
      'worksite', case when shared then details.worksite end,
      'shift', case when shared then details.shift end,
      'classification', case when shared then details.classification end
    )
  );
end;

end;
$function$;
revoke all on function public.get_my_form_autofill() from public, anon, authenticated, service_role;
grant execute on function public.get_my_form_autofill() to authenticated;
comment on function public.get_my_form_autofill() is
  'REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: the caller''s own form autofill answer and values: job title, worksite, shift and classification only while shared with the organization (details_visibility = admins), the caller''s chapter in the selected organization and that organization''s employer. Takes no user id.';

create function public.set_my_form_autofill_preference(p_preference text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  if auth.uid() is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_preference is null or p_preference not in ('ask', 'always', 'never') then
    raise exception 'invalid form autofill preference' using errcode = '22023';
  end if;
  insert into public.member_profile_details as d (user_id, form_autofill)
  values (auth.uid(), p_preference)
  on conflict (user_id) do update
    set form_autofill = excluded.form_autofill, updated_at = pg_catalog.now();
  return pg_catalog.jsonb_build_object('preference', p_preference);
end;
$function$;
revoke all on function public.set_my_form_autofill_preference(text) from public, anon, authenticated, service_role;
grant execute on function public.set_my_form_autofill_preference(text) to authenticated;
comment on function public.set_my_form_autofill_preference(text) is
  'REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: sets the caller''s own form autofill answer (ask, always or never) and nothing else.';

create function public.record_form_profile_autofill(p_form_id uuid, p_fields jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  form_row public.member_forms%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  if auth.uid() is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- { field key: kind }: at most one field per kind, a key shaped like a
  -- form answer key, a kind from the closed list.
  if p_form_id is null or p_fields is null or pg_catalog.jsonb_typeof(p_fields) <> 'object'
     or (select pg_catalog.count(*) from pg_catalog.jsonb_each(p_fields)) > 7
     or exists (
       select 1 from pg_catalog.jsonb_each(p_fields) as entry(field_key, kind)
       where entry.field_key !~ '^[A-Za-z0-9_]{1,80}$'
          or pg_catalog.jsonb_typeof(entry.kind) <> 'string'
          or (entry.kind #>> '{}') not in ('employer', 'worksite', 'unit', 'jobTitle', 'shift', 'classification', 'chapter'))
     or (select pg_catalog.count(distinct entry.kind #>> '{}') from pg_catalog.jsonb_each(p_fields) as entry(field_key, kind))
        <> (select pg_catalog.count(*) from pg_catalog.jsonb_each(p_fields)) then
    raise exception 'invalid autofill fields' using errcode = '22023';
  end if;
  select * into form_row from public.member_forms f
  where f.id = p_form_id and f.user_id = auth.uid() and f.status in ('draft', 'returned')
  for update;
  if not found then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  update public.member_forms set profile_autofill = p_fields where id = form_row.id;
  return pg_catalog.jsonb_build_object('formId', form_row.id, 'fields', p_fields);
end;
$function$;
revoke all on function public.record_form_profile_autofill(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.record_form_profile_autofill(uuid, jsonb) to authenticated;
comment on function public.record_form_profile_autofill(uuid, jsonb) is
  'REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: records which workplace fields the caller accepted from their profile on their own draft or returned form, { field key: kind }, at most one field per kind (no values).';

notify pgrst, 'reload schema';

commit;
