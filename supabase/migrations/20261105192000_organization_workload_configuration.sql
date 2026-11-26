-- REQ-UG-WORKLOAD-ORG-CUSTOMIZATION-20261102 (#6809), web slice.
-- Append-only definitions; latest version is active. Every new entry holds a
-- server-owned snapshot, so retiring/changing fields never rewrites history.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create table private.organization_workload_configuration_versions (
  organization_id uuid not null constraint workload_configuration_versions_org_fkey references public.organizations(id) on update cascade on delete cascade,
  version integer not null check (version > 0),
  definition jsonb not null check (pg_catalog.jsonb_typeof(definition) = 'object' and pg_catalog.octet_length(definition::text) <= 32768),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (organization_id, version)
);
alter table private.organization_workload_configuration_versions enable row level security;
alter table private.organization_workload_configuration_versions force row level security;
revoke all on table private.organization_workload_configuration_versions from public, anon, authenticated, service_role;
create policy mfa_assurance on private.organization_workload_configuration_versions as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.organization_workload_configuration_versions is 'RPC-only configuration history: no client grants or permissive policy. Definers require selected organization membership and MFA; only an organization admin appends versions.';
create trigger a00_case_graph_lock before insert or update or delete on private.organization_workload_configuration_versions
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_workload_configuration_versions
for each row execute function private.lock_case_graph_row_keys('', '');

alter table public.member_workload_logs
  add column workload_configuration jsonb,
  add column workload_values jsonb,
  add column workload_status text;
-- Missing answers in a configured log are unknown. Original defaults and the
-- legacy RPC's normalization remain unchanged for unconfigured submissions.
alter table public.member_workload_logs
  alter column priority drop not null, alter column pending drop not null,
  alter column unread_docs drop not null, alter column todos drop not null,
  alter column referrals drop not null, alter column ce_activities drop not null,
  alter column assistance_requests drop not null, alter column aged_cases drop not null,
  alter column weekly_assigned drop not null, alter column employment drop not null,
  alter column on_plan drop not null, alter column ot_worked drop not null,
  alter column ot_hours drop not null, alter column no_intake drop not null,
  alter column half_day drop not null;
-- The reviewed account export already includes sub_details explicitly.
-- Input stays bounded by the original RPC; only the server adds a snapshot.
alter table public.member_workload_logs drop constraint member_workload_logs_sub_details_check;
alter table public.member_workload_logs add constraint member_workload_logs_sub_details_check
  check (pg_catalog.jsonb_typeof(sub_details) = 'object' and pg_catalog.octet_length(sub_details::text) <= 65536);
comment on column public.member_workload_logs.workload_configuration is 'Server-owned organization/version/definition snapshot. Null on pre-configuration logs; those keep the original fixed-field interpretation. Never replaced on edit.';

create function private.workload_default_definition(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  result jsonb := '{"title":"Workload log","period":"month","statuses":["logged"],"fields":[{"key":"priority","type":"number","label":"workload.cat.priority","kind":"category","required":false,"visible":true,"retired":false,"unit":"count","summary":"sum","options":[]},{"key":"pending","type":"number","label":"workload.cat.pending","kind":"category","required":false,"visible":true,"retired":false,"unit":"count","summary":"sum","options":[]},{"key":"unread_docs","type":"number","label":"workload.cat.unread_docs","kind":"category","required":false,"visible":true,"retired":false,"unit":"count","summary":"sum","options":[]},{"key":"todos","type":"number","label":"workload.cat.todos","kind":"category","required":false,"visible":true,"retired":false,"unit":"count","summary":"sum","options":[]},{"key":"referrals","type":"number","label":"workload.cat.referrals","kind":"category","required":false,"visible":true,"retired":false,"unit":"count","summary":"sum","options":[]},{"key":"ce_activities","type":"number","label":"workload.cat.ce_activities","kind":"category","required":false,"visible":true,"retired":false,"unit":"count","summary":"sum","options":[]},{"key":"assistance_requests","type":"number","label":"workload.cat.assistance_requests","kind":"category","required":false,"visible":true,"retired":false,"unit":"count","summary":"sum","options":[]},{"key":"aged_cases","type":"number","label":"workload.cat.aged_cases","kind":"category","required":false,"visible":true,"retired":false,"unit":"count","summary":"sum","options":[]},{"key":"weeklyAssigned","type":"number","label":"workload.weeklyAssigned","kind":"field","required":false,"visible":true,"retired":false,"unit":"","summary":"none","options":[]},{"key":"employment","type":"select","label":"Employment","kind":"field","required":false,"visible":true,"retired":false,"unit":"","summary":"none","options":["full_time","part_time"]},{"key":"ptHours","type":"number","label":"workload.ptHours","kind":"field","required":false,"visible":true,"retired":false,"unit":"hours","summary":"none","options":[]},{"key":"onPlan","type":"boolean","label":"workload.onPlan","kind":"field","required":false,"visible":true,"retired":false,"unit":"","summary":"none","options":[]},{"key":"otWorked","type":"boolean","label":"workload.otWorked","kind":"field","required":false,"visible":true,"retired":false,"unit":"","summary":"none","options":[]},{"key":"otHours","type":"number","label":"workload.otHours","kind":"field","required":false,"visible":true,"retired":false,"unit":"hours","summary":"none","options":[]},{"key":"leaveType","type":"select","label":"Leave","kind":"field","required":false,"visible":true,"retired":false,"unit":"","summary":"none","options":["sick_leave","annual_leave","lwop","fmla","admin_leave","comp_time"]},{"key":"leaveTiming","type":"select","label":"Leave timing","kind":"field","required":false,"visible":true,"retired":false,"unit":"","summary":"none","options":["planned","unplanned"]},{"key":"noIntake","type":"boolean","label":"workload.noIntake","kind":"field","required":false,"visible":true,"retired":false,"unit":"","summary":"none","options":[]},{"key":"halfDay","type":"boolean","label":"workload.halfDay","kind":"field","required":false,"visible":true,"retired":false,"unit":"","summary":"none","options":[]},{"key":"workedOn","type":"date","label":"workload.workedOn","kind":"field","required":false,"visible":true,"retired":false,"unit":"","summary":"none","options":[]},{"key":"hoursWorked","type":"number","label":"workload.hoursWorked","kind":"field","required":false,"visible":true,"retired":false,"unit":"hours","summary":"sum","options":[]},{"key":"note","type":"text","label":"Note","kind":"field","required":false,"visible":true,"retired":false,"unit":"","summary":"none","options":[]}]}'::jsonb;
  categories jsonb;
  fields jsonb;
begin
  categories := private.organization_workload_categories_payload(p_organization_id) -> 'categories';
  select pg_catalog.jsonb_agg(f.value || pg_catalog.jsonb_build_object(
    'visible', coalesce((c.value ->> 'visible')::boolean, (f.value ->> 'visible')::boolean),
    'label', coalesce(l.label_value, f.value ->> 'label'))
    order by case when f.position <= 8 then c.position else f.position end)
    into fields
  from pg_catalog.jsonb_array_elements(result -> 'fields') with ordinality f(value, position)
  left join pg_catalog.jsonb_array_elements(categories) with ordinality c(value, position) on c.value ->> 'key' = f.value ->> 'key'
  left join public.organization_label_overrides l on l.organization_id = p_organization_id and l.label_key = 'workload.cat.' || (f.value ->> 'key');
  return pg_catalog.jsonb_set(result, '{fields}', fields);
end;
$function$;
revoke all on function private.workload_default_definition(uuid) from public, anon, authenticated, service_role;

create function private.workload_configuration_payload(p_organization_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select pg_catalog.jsonb_build_object('organizationId', p_organization_id,
    'version', coalesce(v.version, 0), 'definition', coalesce(v.definition, private.workload_default_definition(p_organization_id)))
  from (select 1) singleton left join lateral (
    select version, definition from private.organization_workload_configuration_versions
    where organization_id = p_organization_id order by version desc limit 1
  ) v on true;
$function$;
revoke all on function private.workload_configuration_payload(uuid) from public, anon, authenticated, service_role;

create function private.validate_workload_definition(p_definition jsonb)
returns void language plpgsql stable security definer set search_path = '' as $function$
declare
  field jsonb;
  seen text[] := array[]::text[];
  shown integer := 0;
  option_count integer;
begin
  if p_definition is null or pg_catalog.jsonb_typeof(p_definition) <> 'object'
     or pg_catalog.octet_length(p_definition::text) > 32768
     or pg_catalog.jsonb_typeof(p_definition -> 'title') is distinct from 'string'
     or pg_catalog.length(pg_catalog.btrim(p_definition ->> 'title')) not between 1 and 80
     or (p_definition ->> 'title') ~ '[<>[:cntrl:]]'
     or coalesce(p_definition ->> 'period', '') not in ('week', 'month', 'quarter')
     or pg_catalog.jsonb_typeof(p_definition -> 'statuses') is distinct from 'array'
     or pg_catalog.jsonb_typeof(p_definition -> 'fields') is distinct from 'array' then
    raise exception 'invalid workload definition' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_definition -> 'statuses') not between 1 and 12
     or pg_catalog.jsonb_array_length(p_definition -> 'fields') not between 1 and 32
     or exists (select 1 from pg_catalog.jsonb_array_elements(p_definition -> 'statuses') s(value)
        where pg_catalog.jsonb_typeof(s.value) <> 'string' or pg_catalog.length(pg_catalog.btrim(s.value #>> '{}')) not between 1 and 40 or (s.value #>> '{}') ~ '[<>[:cntrl:]]')
     or (select pg_catalog.count(distinct s.value) from pg_catalog.jsonb_array_elements(p_definition -> 'statuses') s(value)) <> pg_catalog.jsonb_array_length(p_definition -> 'statuses') then
    raise exception 'invalid workload fields or statuses' using errcode = '22023';
  end if;
  for field in select value from pg_catalog.jsonb_array_elements(p_definition -> 'fields') loop
    if pg_catalog.jsonb_typeof(field) <> 'object'
       or coalesce(field ->> 'key', '') !~ '^[a-z][a-zA-Z0-9_]{0,39}$' or field ->> 'key' = any(seen)
       or pg_catalog.jsonb_typeof(field -> 'label') is distinct from 'string'
       or pg_catalog.length(pg_catalog.btrim(field ->> 'label')) not between 1 and 80 or (field ->> 'label') ~ '[<>[:cntrl:]]'
       or coalesce(field ->> 'type', '') not in ('number', 'text', 'date', 'boolean', 'select')
       or coalesce(field ->> 'kind', '') not in ('field', 'category')
       or pg_catalog.jsonb_typeof(field -> 'required') is distinct from 'boolean'
       or pg_catalog.jsonb_typeof(field -> 'visible') is distinct from 'boolean'
       or pg_catalog.jsonb_typeof(field -> 'retired') is distinct from 'boolean'
       or pg_catalog.jsonb_typeof(field -> 'unit') is distinct from 'string'
       or pg_catalog.length(field ->> 'unit') > 24 or (field ->> 'unit') ~ '[<>[:cntrl:]]'
       or coalesce(field ->> 'summary', '') not in ('none', 'sum', 'average')
       or pg_catalog.jsonb_typeof(field -> 'options') is distinct from 'array' then
      raise exception 'invalid workload field' using errcode = '22023';
    end if;
    if (field ->> 'kind' = 'category' or field ->> 'summary' <> 'none') and field ->> 'type' <> 'number'
       or (field ->> 'required')::boolean and (not (field ->> 'visible')::boolean or (field ->> 'retired')::boolean) then
      raise exception 'invalid workload field flags' using errcode = '22023';
    end if;
    if field ->> 'type' = 'select' then
      option_count := pg_catalog.jsonb_array_length(field -> 'options');
      if option_count not between 1 and 20
         or (select pg_catalog.count(distinct o.value) from pg_catalog.jsonb_array_elements(field -> 'options') o(value)) <> option_count
         or exists (select 1 from pg_catalog.jsonb_array_elements(field -> 'options') o(value)
           where pg_catalog.jsonb_typeof(o.value) <> 'string' or pg_catalog.length(pg_catalog.btrim(o.value #>> '{}')) not between 1 and 60 or (o.value #>> '{}') ~ '[<>[:cntrl:]]') then
        raise exception 'invalid workload options' using errcode = '22023';
      end if;
    end if;
    -- Reserved original keys keep their storage type and ranges. New keys may
    -- change type between versions; old records always retain their snapshot.
    if exists (select 1 from pg_catalog.jsonb_array_elements(private.workload_default_definition(null) -> 'fields') d(value)
      where d.value ->> 'key' = field ->> 'key' and (
        d.value ->> 'type' <> field ->> 'type' or d.value ->> 'unit' <> field ->> 'unit'
        or (field ->> 'type' = 'select' and exists (
          select 1 from pg_catalog.jsonb_array_elements(field -> 'options') o(value) where not (d.value -> 'options' @> pg_catalog.jsonb_build_array(o.value))
        )))) then
      raise exception 'original workload field type, unit and choices are fixed; add a new field' using errcode = '22023';
    end if;
    seen := seen || (field ->> 'key');
    if (field ->> 'visible')::boolean and not (field ->> 'retired')::boolean then shown := shown + 1; end if;
  end loop;
  if shown = 0 then raise exception 'at least one field must be shown' using errcode = '22023'; end if;
  -- Do not publish a choice whose dependent answer cannot be supplied. Hiding
  -- or retiring both together, and full-time-only employment, remain valid.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_definition -> 'fields') f(value)
    where (f.value ->> 'visible')::boolean and not (f.value ->> 'retired')::boolean
      and (f.value ->> 'key' in ('otWorked', 'leaveType') or (f.value ->> 'key' = 'employment' and f.value -> 'options' ? 'part_time'))
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_definition -> 'fields') d(value)
        where d.value ->> 'key' = case f.value ->> 'key' when 'employment' then 'ptHours' when 'otWorked' then 'otHours' when 'leaveType' then 'leaveTiming' end
          and (d.value ->> 'visible')::boolean and not (d.value ->> 'retired')::boolean)
  ) then raise exception 'workload dependent field must be available' using errcode = '22023'; end if;
end;
$function$;
revoke all on function private.validate_workload_definition(jsonb) from public, anon, authenticated, service_role;

create function private.validate_workload_values(p_definition jsonb, p_values jsonb, p_status text, p_legacy boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  field jsonb;
  value jsonb;
  number_value numeric;
  key text;
begin
  if p_values is null or pg_catalog.jsonb_typeof(p_values) <> 'object' or pg_catalog.octet_length(p_values::text) > (case when p_legacy then 24000 else 3500 end)
     or p_status is null or not (p_definition -> 'statuses' ? p_status) then
    raise exception 'invalid workload values or status' using errcode = '22023';
  end if;
  for key in select pg_catalog.jsonb_object_keys(p_values) loop
    if not exists (select 1 from pg_catalog.jsonb_array_elements(p_definition -> 'fields') f(value)
      where f.value ->> 'key' = key and (f.value ->> 'visible')::boolean and not (f.value ->> 'retired')::boolean) then
      raise exception 'unknown or retired workload field' using errcode = '22023';
    end if;
  end loop;
  -- Validate unknown keys before cleaning optional blanks. Return one canonical
  -- payload for every writer, fixed-column projection, snapshot and export.
  select coalesce(pg_catalog.jsonb_object_agg(e.key, e.value), '{}'::jsonb) into p_values
  from pg_catalog.jsonb_each(p_values) e where e.value <> 'null'::jsonb and e.value <> '""'::jsonb;
  if p_values -> 'otWorked' = 'false'::jsonb and not (p_values ? 'otHours')
     and exists (select 1 from pg_catalog.jsonb_array_elements(p_definition -> 'fields') f(value)
       where f.value ->> 'key' = 'otHours' and (f.value ->> 'visible')::boolean and not (f.value ->> 'retired')::boolean) then
    p_values := p_values || '{"otHours":0}'::jsonb;
  end if;
  if pg_catalog.octet_length(p_values::text) > (case when p_legacy then 24000 else 3500 end) then
    raise exception 'invalid workload values or status' using errcode = '22023';
  end if;
  for field in select f.value from pg_catalog.jsonb_array_elements(p_definition -> 'fields') f(value)
    where (f.value ->> 'visible')::boolean and not (f.value ->> 'retired')::boolean loop
    key := field ->> 'key'; value := p_values -> key;
    if value is null or value = 'null'::jsonb or value = '""'::jsonb then
      if (field ->> 'required')::boolean then raise exception 'required workload field missing' using errcode = '22023'; end if;
      continue;
    end if;
    if field ->> 'type' = 'number' then
      if pg_catalog.jsonb_typeof(value) <> 'number' then raise exception 'invalid workload number' using errcode = '22023'; end if;
      number_value := (value #>> '{}')::numeric;
      if number_value < 0 or number_value > 1000000
         or (key = any(array['priority','pending','unread_docs','todos','referrals','ce_activities','assistance_requests','aged_cases','weeklyAssigned']) and (number_value > 300 or number_value <> pg_catalog.trunc(number_value)))
         or (key = 'ptHours' and (number_value > 80 or number_value <> pg_catalog.trunc(number_value)))
         or (key = 'otHours' and (number_value > 99 or number_value <> pg_catalog.trunc(number_value)))
         or (key = 'hoursWorked' and (number_value > 24 or number_value * 4 <> pg_catalog.trunc(number_value * 4))) then
        raise exception 'workload number out of range' using errcode = '22023';
      end if;
    elsif field ->> 'type' = 'boolean' and pg_catalog.jsonb_typeof(value) <> 'boolean' then
      raise exception 'invalid workload boolean' using errcode = '22023';
    elsif field ->> 'type' = 'text' and (pg_catalog.jsonb_typeof(value) <> 'string' or pg_catalog.length(value #>> '{}') > (case when p_legacy and key = 'note' then 4000 else 500 end)) then
      raise exception 'invalid workload text' using errcode = '22023';
    elsif field ->> 'type' = 'select' and (pg_catalog.jsonb_typeof(value) <> 'string' or not (field -> 'options' ? (value #>> '{}'))) then
      raise exception 'invalid workload selection' using errcode = '22023';
    elsif field ->> 'type' = 'date' then
      if pg_catalog.jsonb_typeof(value) <> 'string' or (value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid workload date' using errcode = '22023'; end if;
      begin
        if ((value #>> '{}')::date)::text <> (value #>> '{}') or (key = 'workedOn' and (value #>> '{}')::date > (pg_catalog.now() at time zone 'America/New_York')::date) then raise exception 'invalid workload date' using errcode = '22023'; end if;
      exception when datetime_field_overflow or invalid_datetime_format then raise exception 'invalid workload date' using errcode = '22023'; end;
    end if;
  end loop;
  if ((p_values ->> 'otWorked')::boolean and coalesce((p_values ->> 'otHours')::numeric, 0) <= 0)
     or ((p_values ->> 'otWorked')::boolean = false and (p_values ->> 'otHours')::numeric > 0)
     or (p_values ->> 'employment' = 'part_time' and p_values ->> 'ptHours' is null)
     or (p_values ->> 'leaveType' is not null and p_values ->> 'leaveTiming' is null) then
    raise exception 'workload dependent answer missing or contradictory' using errcode = '22023';
  end if;
  return p_values;
end;
$function$;
revoke all on function private.validate_workload_values(jsonb, jsonb, text, boolean) from public, anon, authenticated, service_role;

create function public.get_organization_workload_configuration()
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare org uuid; result jsonb; can_edit boolean;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  org := private.chapter_units_context();
  if org is null then raise exception 'organization membership and MFA required' using errcode = '42501'; end if;
  result := private.workload_configuration_payload(org);
  can_edit := private.has_organization_role(org, array['admin']);
  return result || pg_catalog.jsonb_build_object('canEdit', can_edit, 'history', case when can_edit then coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('version', v.version, 'definition', v.definition, 'createdAt', v.created_at) order by v.version desc)
    from (select * from private.organization_workload_configuration_versions where organization_id = org order by version desc limit 50) v
  ), '[]'::jsonb) else '[]'::jsonb end);
end;
$function$;
revoke all on function public.get_organization_workload_configuration() from public, anon, authenticated, service_role;
grant execute on function public.get_organization_workload_configuration() to authenticated;

create function public.save_organization_workload_configuration(p_definition jsonb, p_expected_version integer, p_expected_organization_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare org uuid; previous jsonb;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  org := private.chapter_units_context();
  if org is null or not private.has_organization_role(org, array['admin']) then raise exception 'organization admin and MFA required' using errcode = '42501'; end if;
  if p_expected_organization_id is distinct from org then raise exception 'workload organization changed; reload' using errcode = '42501', detail = 'workload_configuration_changed'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workload-config-' || org::text, 509));
  previous := private.workload_configuration_payload(org);
  if p_expected_version is distinct from (previous ->> 'version')::integer then raise exception 'workload configuration changed; reload' using errcode = '40001', detail = 'workload_configuration_changed'; end if;
  perform private.validate_workload_definition(p_definition);
  -- Keys cannot disappear or be resurrected: retirement is explicit, and an
  -- old entry can still be edited with the definition it originally used.
  if exists (select 1 from pg_catalog.jsonb_array_elements(previous -> 'definition' -> 'fields') old(value)
    where not exists (select 1 from pg_catalog.jsonb_array_elements(p_definition -> 'fields') next(value)
      where next.value ->> 'key' = old.value ->> 'key' and (not (old.value ->> 'retired')::boolean or (next.value ->> 'retired')::boolean))) then
    raise exception 'retire workload fields instead of removing or reusing them' using errcode = '22023';
  end if;
  insert into private.organization_workload_configuration_versions(organization_id, version, definition)
  values (org, p_expected_version + 1, p_definition);
  insert into public.organization_configuration_audit(organization_id, actor_user_id, action, item_key, previous_value, new_value)
  values (org, (select auth.uid()), 'setting_updated', 'workload.configuration',
    pg_catalog.jsonb_build_object('organizationId', org, 'version', (previous ->> 'version')::integer),
    pg_catalog.jsonb_build_object('organizationId', org, 'version', p_expected_version + 1));
  return public.get_organization_workload_configuration();
end;
end;
$function$;
revoke all on function public.save_organization_workload_configuration(jsonb, integer, uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_organization_workload_configuration(jsonb, integer, uuid) to authenticated;

create function private.stamp_workload_configuration()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare org uuid; snapshot jsonb; values_json jsonb; fixed_values jsonb;
begin
  org := private.chapter_units_context();
  if tg_op = 'UPDATE' then
    if new.workload_configuration is distinct from old.workload_configuration then raise exception 'workload snapshot is immutable' using errcode = '22023'; end if;
    if new.workload_configuration is null then return new; end if;
    snapshot := new.workload_configuration;
    values_json := new.workload_values;
    new.sub_details := old.sub_details || new.sub_details;
  else
  -- Pre-tenant compatibility writes remain the original log, with no org
  -- configuration. Configured writes always need a selected membership.
  if org is null then
    if new.sub_details ? 'workloadVersion' then raise exception 'organization membership required' using errcode = '42501'; end if;
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workload-config-' || org::text, 509));
  snapshot := private.workload_configuration_payload(org);
  if coalesce(new.sub_details ->> 'workloadVersion', '0') <> snapshot ->> 'version' then raise exception 'workload configuration changed; reload' using errcode = '40001', detail = 'workload_configuration_changed'; end if;
  if new.sub_details ? 'workloadVersion' then
    values_json := new.sub_details -> 'workloadValues';
    new.workload_status := new.sub_details ->> 'workloadStatus';
  else
    values_json := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'priority', new.priority, 'pending', new.pending, 'unread_docs', new.unread_docs, 'todos', new.todos, 'referrals', new.referrals,
      'ce_activities', new.ce_activities, 'assistance_requests', new.assistance_requests, 'aged_cases', new.aged_cases,
      'weeklyAssigned', new.weekly_assigned, 'employment', new.employment, 'ptHours', new.pt_hours,
      'onPlan', new.on_plan, 'otWorked', new.ot_worked, 'otHours', new.ot_hours, 'leaveType', new.leave_type,
      'leaveTiming', new.leave_timing, 'noIntake', new.no_intake, 'halfDay', new.half_day,
      'workedOn', new.sub_details -> 'workedOn', 'hoursWorked', new.sub_details -> 'hoursWorked', 'note', new.note));
    select coalesce(pg_catalog.jsonb_object_agg(e.key, e.value), '{}'::jsonb) into values_json from pg_catalog.jsonb_each(values_json) e
      where exists (select 1 from pg_catalog.jsonb_array_elements(snapshot -> 'definition' -> 'fields') f(value) where f.value ->> 'key' = e.key and (f.value ->> 'visible')::boolean);
    new.workload_status := 'logged';
  end if;
  end if;
  values_json := private.validate_workload_values(snapshot -> 'definition', values_json, new.workload_status, (snapshot ->> 'version')::integer = 0);
  -- One projection covers create/edit and configured transport through the
  -- legacy RPC. It runs after that RPC's legacy normalization, before storage.
  if (snapshot ->> 'version')::integer > 0 or tg_op = 'UPDATE' then
    fixed_values := pg_catalog.jsonb_build_object(
      'priority', values_json -> 'priority', 'pending', values_json -> 'pending',
      'unread_docs', values_json -> 'unread_docs', 'todos', values_json -> 'todos',
      'referrals', values_json -> 'referrals', 'ce_activities', values_json -> 'ce_activities',
      'assistance_requests', values_json -> 'assistance_requests', 'aged_cases', values_json -> 'aged_cases',
      'weekly_assigned', values_json -> 'weeklyAssigned', 'employment', values_json -> 'employment',
      'pt_hours', values_json -> 'ptHours', 'on_plan', values_json -> 'onPlan',
      'ot_worked', values_json -> 'otWorked', 'ot_hours', values_json -> 'otHours',
      'leave_type', values_json -> 'leaveType', 'leave_timing', values_json -> 'leaveTiming',
      'no_intake', values_json -> 'noIntake', 'half_day', values_json -> 'halfDay', 'note', values_json -> 'note');
    if (snapshot ->> 'version')::integer = 0 then
      -- Original hidden measurements keep their stored meaning on legacy edits.
      select coalesce(pg_catalog.jsonb_object_agg(e.key, e.value), '{}'::jsonb) into fixed_values
      from pg_catalog.jsonb_each(fixed_values) e
      where exists (select 1 from pg_catalog.jsonb_array_elements(snapshot -> 'definition' -> 'fields') f(value)
        where (f.value ->> 'visible')::boolean and f.value ->> 'key' = case e.key
          when 'weekly_assigned' then 'weeklyAssigned' when 'pt_hours' then 'ptHours' when 'on_plan' then 'onPlan'
          when 'ot_worked' then 'otWorked' when 'ot_hours' then 'otHours' when 'leave_type' then 'leaveType'
          when 'leave_timing' then 'leaveTiming' when 'no_intake' then 'noIntake' when 'half_day' then 'halfDay' else e.key end);
    end if;
    new := pg_catalog.jsonb_populate_record(new, fixed_values);
  end if;
  new.workload_configuration := snapshot;
  new.workload_values := values_json;
  new.sub_details := new.sub_details || pg_catalog.jsonb_build_object(
    'configuration', snapshot, 'values', values_json, 'status', new.workload_status,
    'workloadVersion', (snapshot ->> 'version')::integer, 'workloadValues', values_json, 'workloadStatus', new.workload_status,
    'workedOn', values_json -> 'workedOn', 'hoursWorked', values_json -> 'hoursWorked');
  return new;
end;
end;
$function$;
revoke all on function private.stamp_workload_configuration() from public, anon, authenticated, service_role;
create trigger b10_workload_configuration before insert or update on public.member_workload_logs
for each row execute function private.stamp_workload_configuration();

create function public.save_configured_workload_log(p_entry_id uuid, p_version integer, p_values jsonb, p_status text, p_organization_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare org uuid; snapshot jsonb; entry public.member_workload_logs; result jsonb;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  org := private.chapter_units_context();
  if org is null then raise exception 'organization membership and MFA required' using errcode = '42501'; end if;
  if p_organization_id is distinct from org then raise exception 'workload organization changed; reload' using errcode = '42501', detail = 'workload_configuration_changed'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-workload-' || (select auth.uid())::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workload-config-' || org::text, 509));
  if p_entry_id is null then snapshot := private.workload_configuration_payload(org);
  else
    select * into entry from public.member_workload_logs w where w.id = p_entry_id and w.user_id = (select auth.uid()) and w.workload_configuration ->> 'organizationId' = org::text for update;
    if not found then raise exception 'workload entry unavailable' using errcode = '42501'; end if;
    snapshot := entry.workload_configuration;
  end if;
  if p_version is distinct from (snapshot ->> 'version')::integer then raise exception 'workload configuration changed; reload' using errcode = '40001', detail = 'workload_configuration_changed'; end if;
  p_values := private.validate_workload_values(snapshot -> 'definition', p_values, p_status, (snapshot ->> 'version')::integer = 0);
  if p_entry_id is null then
    result := public.submit_workload_log(
      coalesce((p_values ->> 'priority')::integer, 0), coalesce((p_values ->> 'pending')::integer, 0), coalesce((p_values ->> 'unread_docs')::integer, 0), coalesce((p_values ->> 'todos')::integer, 0),
      coalesce((p_values ->> 'referrals')::integer, 0), coalesce((p_values ->> 'ce_activities')::integer, 0), coalesce((p_values ->> 'assistance_requests')::integer, 0), coalesce((p_values ->> 'aged_cases')::integer, 0),
      coalesce((p_values ->> 'weeklyAssigned')::integer, 0), coalesce(p_values ->> 'employment', 'full_time'), coalesce((p_values ->> 'ptHours')::integer, 20),
      coalesce((p_values ->> 'onPlan')::boolean, false), coalesce((p_values ->> 'otWorked')::boolean, false), coalesce((p_values ->> 'otHours')::integer, 0), p_values ->> 'leaveType', p_values ->> 'leaveTiming',
      coalesce((p_values ->> 'noIntake')::boolean, false), coalesce((p_values ->> 'halfDay')::boolean, false), p_values ->> 'note',
      pg_catalog.jsonb_build_object('workloadVersion', p_version, 'workloadValues', p_values, 'workloadStatus', p_status, 'workedOn', p_values -> 'workedOn', 'hoursWorked', p_values -> 'hoursWorked'));
    return result;
  end if;
  update public.member_workload_logs set workload_values = p_values, workload_status = p_status
  where id = p_entry_id;
  return pg_catalog.jsonb_build_object('id', p_entry_id, 'updated', true, 'awardedPoints', 0);
end;
end;
$function$;
revoke all on function public.save_configured_workload_log(uuid, integer, jsonb, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_configured_workload_log(uuid, integer, jsonb, text, uuid) to authenticated;

-- Collective readers use the same complete-measurement cohort before latest/member
-- selection and privacy floors. Missing values never become winsorized zeros.
CREATE OR REPLACE FUNCTION public.get_workload_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  loc_now timestamp := (pg_catalog.now() at time zone 'America/New_York');
  q_start_local timestamp := pg_catalog.date_trunc('quarter', loc_now) - interval '3 months';
  q_end_local timestamp := pg_catalog.date_trunc('quarter', loc_now);
  q_start timestamptz := q_start_local at time zone 'America/New_York';
  q_end timestamptz := q_end_local at time zone 'America/New_York';
  period_label text := pg_catalog.date_part('year', q_start_local)::int::text
    || '-Q' || pg_catalog.date_part('quarter', q_start_local)::int::text;
  n_sub integer;
  k constant integer := 25;
  cats jsonb;
  tiles jsonb;
  band text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- Quarterly "give to view": a locked member gets no workload statistics.
  if private.quarterly_survey_gate_locks_caller() then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'quarterly_survey_gate', 'locked', true,
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;
  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'chapter_unavailable',
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;
  if private.chapter_belongs_to_platform(caller_chapter) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  select pg_catalog.count(*) into n_sub from (
    select distinct on (w.user_id) w.id
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and pg_catalog.num_nulls(w.priority, w.pending, w.unread_docs, w.todos, w.referrals, w.ce_activities, w.assistance_requests, w.aged_cases) = 0
      and (w.employment is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'employment' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.ot_hours is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'otHours' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.workload_configuration is null or w.workload_configuration ->> 'organizationId' = (select c.organization_id::text from public.chapters c where c.id = caller_chapter))
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  ) s;

  if n_sub < k then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'anonymity_floor',
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;
  band := case when n_sub >= 100 then '100+' when n_sub >= 50 then '50-99' else '25-49' end;

  with latest as (
    select distinct on (w.user_id)
      w.priority, w.pending, w.unread_docs, w.todos, w.referrals,
      w.ce_activities, w.assistance_requests, w.aged_cases,
      w.employment, case when w.ot_hours is not null then least(w.ot_hours, 40) end as ot_hours
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and pg_catalog.num_nulls(w.priority, w.pending, w.unread_docs, w.todos, w.referrals, w.ce_activities, w.assistance_requests, w.aged_cases) = 0
      and (w.employment is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'employment' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.ot_hours is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'otHours' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.workload_configuration is null or w.workload_configuration ->> 'organizationId' = (select c.organization_id::text from public.chapters c where c.id = caller_chapter))
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  ), values_by_key as (
    select v.key, v.ord, least(v.value, 150)::numeric as value
    from latest l
    cross join lateral (values
      ('priority', 1, l.priority), ('pending', 2, l.pending),
      ('unread_docs', 3, l.unread_docs), ('todos', 4, l.todos),
      ('referrals', 5, l.referrals), ('ce_activities', 6, l.ce_activities),
      ('assistance_requests', 7, l.assistance_requests), ('aged_cases', 8, l.aged_cases)
    ) v(key, ord, value)
  ), metrics as (
    select key, ord,
      pg_catalog.round(pg_catalog.avg(value)) as avg,
      pg_catalog.percentile_disc(0.5) within group (order by value) as median,
      pg_catalog.percentile_disc(0.9) within group (order by value) as p90
    from values_by_key group by key, ord
  )
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'key', key, 'avg', avg, 'median', median, 'p90', p90) order by ord)
  into cats from metrics;

  with latest as (
    select distinct on (w.user_id) w.employment, case when w.ot_hours is not null then least(w.ot_hours, 40) end as ot_hours
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and pg_catalog.num_nulls(w.priority, w.pending, w.unread_docs, w.todos, w.referrals, w.ce_activities, w.assistance_requests, w.aged_cases) = 0
      and (w.employment is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'employment' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.ot_hours is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'otHours' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.workload_configuration is null or w.workload_configuration ->> 'organizationId' = (select c.organization_id::text from public.chapters c where c.id = caller_chapter))
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  )
  select pg_catalog.jsonb_build_object(
    'pctFullTime', case when pg_catalog.count(employment) >= k then pg_catalog.round(100.0 * pg_catalog.avg((employment = 'full_time')::int) / 10.0) * 10 end,
    'pctPartTime', case when pg_catalog.count(employment) >= k then pg_catalog.round(100.0 * pg_catalog.avg((employment = 'part_time')::int) / 10.0) * 10 end,
    'avgOtHours', case when pg_catalog.count(ot_hours) >= k then pg_catalog.round(pg_catalog.avg(ot_hours)::numeric, 1) end)
  into tiles from latest;

  return pg_catalog.jsonb_build_object(
    'enoughData', true, 'period', period_label, 'generatedAt', pg_catalog.now(),
    'submittersBand', band, 'categories', cats, 'tiles', tiles);
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_steward_workload_intelligence(p_weeks integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  weeks integer := greatest(2, least(coalesce(p_weeks, 12), 52));
  eligible_points integer := 0;
  trends jsonb := '[]'::jsonb;
  balancing jsonb;
  reason text;
begin
  if caller is null or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'available', false, 'reason', 'chapter_unavailable', 'eligibleWeeks', 0,
      'categories', '[]'::jsonb, 'rebalancing', pg_catalog.jsonb_build_object('stewards', '[]'::jsonb, 'suggestions', '[]'::jsonb));
  end if;
  if not private.member_has_chapter_role(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  if private.chapter_belongs_to_platform(caller_chapter) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  balancing := private.workload_rebalancing(caller_chapter);

  with latest_weekly as materialized (
    select distinct on (pg_catalog.date_trunc('week', w.created_at), w.user_id)
      pg_catalog.date_trunc('week', w.created_at)::date as week_start, w.user_id,
      least(w.priority, 150) as priority, least(w.pending, 150) as pending,
      least(w.unread_docs, 150) as unread_docs, least(w.todos, 150) as todos,
      least(w.referrals, 150) as referrals, least(w.ce_activities, 150) as ce_activities,
      least(w.assistance_requests, 150) as assistance_requests,
      least(w.aged_cases, 150) as aged_cases
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and pg_catalog.num_nulls(w.priority, w.pending, w.unread_docs, w.todos, w.referrals, w.ce_activities, w.assistance_requests, w.aged_cases) = 0
      and (w.employment is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'employment' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.ot_hours is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'otHours' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.workload_configuration is null or w.workload_configuration ->> 'organizationId' = (select c.organization_id::text from public.chapters c where c.id = caller_chapter))
      and w.created_at >= pg_catalog.date_trunc('week', pg_catalog.now()) - pg_catalog.make_interval(weeks => weeks)
    order by pg_catalog.date_trunc('week', w.created_at), w.user_id, w.created_at desc
  ), eligible_weeks as materialized (
    select week_start
    from latest_weekly
    group by week_start
    having pg_catalog.count(distinct user_id) >= 25
  )
  select pg_catalog.count(*) into eligible_points from eligible_weeks;

  if eligible_points >= 2 then
    with latest_weekly as materialized (
      select distinct on (pg_catalog.date_trunc('week', w.created_at), w.user_id)
        pg_catalog.date_trunc('week', w.created_at)::date as week_start, w.user_id,
        least(w.priority, 150) as priority, least(w.pending, 150) as pending,
        least(w.unread_docs, 150) as unread_docs, least(w.todos, 150) as todos,
        least(w.referrals, 150) as referrals, least(w.ce_activities, 150) as ce_activities,
        least(w.assistance_requests, 150) as assistance_requests,
        least(w.aged_cases, 150) as aged_cases
      from public.member_workload_logs w
      join public.member_profiles p on p.id = w.user_id
      where p.chapter_id = caller_chapter
      and pg_catalog.num_nulls(w.priority, w.pending, w.unread_docs, w.todos, w.referrals, w.ce_activities, w.assistance_requests, w.aged_cases) = 0
      and (w.employment is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'employment' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.ot_hours is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'otHours' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.workload_configuration is null or w.workload_configuration ->> 'organizationId' = (select c.organization_id::text from public.chapters c where c.id = caller_chapter))
        and w.created_at >= pg_catalog.date_trunc('week', pg_catalog.now()) - pg_catalog.make_interval(weeks => weeks)
      order by pg_catalog.date_trunc('week', w.created_at), w.user_id, w.created_at desc
    ), eligible as (
      select week_start from latest_weekly group by week_start
      having pg_catalog.count(distinct user_id) >= 25
    ), weekly_categories as (
      select l.week_start, v.key, v.ord, pg_catalog.avg(v.value)::numeric as value
      from latest_weekly l join eligible e using (week_start)
      cross join lateral (values
        ('priority', 1, l.priority), ('pending', 2, l.pending),
        ('unread_docs', 3, l.unread_docs), ('todos', 4, l.todos),
        ('referrals', 5, l.referrals), ('ce_activities', 6, l.ce_activities),
        ('assistance_requests', 7, l.assistance_requests), ('aged_cases', 8, l.aged_cases)
      ) v(key, ord, value)
      group by l.week_start, v.key, v.ord
    ), regression as (
      select key, ord, pg_catalog.count(*)::integer as points,
        pg_catalog.regr_slope(value, extract(epoch from week_start) / 604800.0)::numeric as slope,
        (pg_catalog.array_agg(value order by week_start desc))[1] as latest
      from weekly_categories group by key, ord
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'key', key, 'points', points,
      'slope', pg_catalog.round(slope, 2),
      'latest', pg_catalog.round(latest, 1),
      'forecast4Weeks', pg_catalog.round(greatest(latest + slope * 4, 0), 1)) order by ord)
    into trends from regression;
  else
    reason := case when eligible_points = 0 then 'anonymity_floor' else 'insufficient_weeks' end;
  end if;

  return pg_catalog.jsonb_build_object(
    'available', eligible_points >= 2,
    'reason', reason,
    'eligibleWeeks', eligible_points,
    'categories', coalesce(trends, '[]'::jsonb),
    'rebalancing', balancing,
    'generatedAt', pg_catalog.now());
end;
$function$;

-- Own entries still require their original organization to be selected.
alter policy member_workload_logs_select_own on public.member_workload_logs using (
  (select auth.uid()) = user_id and (workload_configuration is null or workload_configuration ->> 'organizationId' = (select private.current_member_organization())::text)
);
comment on policy member_workload_logs_select_own on public.member_workload_logs is 'Only the caller''s own logs, scoped to the selected organization for versioned entries. Legacy entries retain their original owner-only access.';

insert into private.account_lifecycle_trigger_review(kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash from private.account_lifecycle_trigger_surface() s
where s.kind = 'trigger' and ((s.schema_name = 'private' and s.table_name = 'organization_workload_configuration_versions') or (s.schema_name = 'public' and s.table_name = 'member_workload_logs' and s.object_name = 'b10_workload_configuration'))
   or (s.kind = 'function' and s.schema_name = 'private' and s.object_name in (
     'stamp_workload_configuration()',
     'chapter_units_context()',
     'validate_workload_values(p_definition jsonb, p_values jsonb, p_status text, p_legacy boolean)',
     'workload_configuration_payload(p_organization_id uuid)',
     'workload_default_definition(p_organization_id uuid)',
     'organization_workload_categories_payload(p_organization_id uuid)'))
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

-- These six helper bodies are the stamp's complete trigger call closure.
-- Auth/organization cascaded deletes never fire its insert/update-only body;
-- the other five helpers only read or validate, with no lifecycle side effects.
do $assert_workload_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after workload configuration';
  end if;
end;
$assert_workload_trigger_review$;

commit;
