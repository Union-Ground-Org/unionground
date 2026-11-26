-- REQ-UG-PER-UNIT-SETTINGS-20261109 (#7667).
-- Built on #7663 (steward unit foundation). A unit starts from its chapter's
-- settings and overrides only what the chapter delegates: workload categories,
-- forms shown, task templates shown, and narrowing officer capabilities.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.chapter_unit_setting_defaults (
  chapter_id text primary key references public.chapters(id) on update cascade on delete cascade,
  defaults jsonb not null default '{}'::jsonb check(jsonb_typeof(defaults)='object'),
  allowed jsonb not null default '{}'::jsonb check(jsonb_typeof(allowed)='object'),
  version integer not null default 1 check(version>0)
);
-- The overrides follow their unit: a unit moved to another chapter carries
-- them, and the new chapter's delegation decides which still apply.
create table private.unit_setting_overrides (
  unit_id uuid primary key,
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  overrides jsonb not null default '{}'::jsonb check(jsonb_typeof(overrides)='object'),
  version integer not null default 1 check(version>0),
  constraint unit_setting_overrides_unit_fkey foreign key(unit_id,chapter_id)
    references private.chapter_units(id,chapter_id) on update cascade on delete cascade
);
create table private.unit_setting_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  unit_id uuid,
  unit_name text,
  actor_id uuid references auth.users(id) on delete set null,
  before_value jsonb not null,
  after_value jsonb not null,
  created_at timestamptz not null default now()
);
create index unit_setting_audit_chapter on private.unit_setting_audit(chapter_id,created_at desc,id);
insert into private.account_lifecycle_manifest(schema_name,table_name,user_column,delete_disposition,export_disposition,export_inventory_basis,exclusion_reason,note) values
 ('private','unit_setting_audit','actor_id','pseudonymize','excluded_with_reason','auth_user_fk','Chapter-owned settings audit, not personal content.','The steward or leader who made a change becomes null on account deletion; the change itself stays in the audit.');
alter table private.chapter_unit_setting_defaults enable row level security;
alter table private.chapter_unit_setting_defaults force row level security;
alter table private.unit_setting_overrides enable row level security;
alter table private.unit_setting_overrides force row level security;
alter table private.unit_setting_audit enable row level security;
alter table private.unit_setting_audit force row level security;
revoke all on private.chapter_unit_setting_defaults,private.unit_setting_overrides,private.unit_setting_audit from public,anon,authenticated,service_role;
-- Chapter, organization and account FKs place these tables in the account
-- case graph: each takes the graph gate first and locks its row keys.
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_unit_setting_defaults
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_unit_setting_defaults
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger a00_case_graph_lock before insert or update or delete on private.unit_setting_overrides
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.unit_setting_overrides
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger a00_case_graph_lock before insert or update or delete on private.unit_setting_audit
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.unit_setting_audit
for each row execute function private.lock_case_graph_row_keys('{actor_id}', '');

-- The release calendar switch (docs/contracts/staged-feature-releases.md),
-- held from its creation with no date. While held every unit read answers as
-- for a chapter with no units, no unit setting is shown or saved, and the
-- shared triggers behave as before this migration. Stored rows are kept.
insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible, organization_editable, release_at)
values
  ('features.governance.per_unit_settings', 'boolean', 'Per-unit settings',
   'Platform-wide. Carries the release time of per-unit settings: until then every unit works under its chapter''s settings and no unit settings are shown or saved. Organizations cannot change it.',
   'true', null, null, null, 50, 'governance', false, false, 'infinity');

create function private.unit_settings_released(p_org uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select p_org is not null and private.organization_feature_enabled(p_org,'features.governance.per_unit_settings') is true;
$$;
revoke all on function private.unit_settings_released(uuid) from public,anon,authenticated,service_role;

-- The hold alone, read without the member's profile, so a held feature adds
-- no read to the paths it shares with every form, task and workload save.
create function private.unit_settings_held()
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.platform_setting_definitions d
    where d.key='features.governance.per_unit_settings' and d.release_at > pg_catalog.now());
$$;
revoke all on function private.unit_settings_held() from public,anon,authenticated,service_role;

create function private.chapter_unit_settings_released(p_chapter text)
returns boolean language sql stable security definer set search_path='' as $$
  select private.unit_settings_released((select c.organization_id from public.chapters c where c.id=p_chapter));
$$;
revoke all on function private.chapter_unit_settings_released(text) from public,anon,authenticated,service_role;

-- Whether a unit's delegated settings leave one officer capability on. Only
-- the narrowing is read here; the caller still checks the chapter's own
-- setting. Held, a unit narrows nothing.
create function private.unit_capability_enabled(p_chapter text,p_unit uuid,p_role text,p_capability text)
returns boolean language sql stable security definer set search_path='' as $$
  select p_unit is null or not private.chapter_unit_settings_released(p_chapter) or not exists(
    select 1 from private.unit_setting_overrides o
      join private.chapter_unit_setting_defaults d on d.chapter_id=o.chapter_id
      where o.unit_id=p_unit and o.chapter_id=p_chapter and d.allowed->'capabilities'='true'::jsonb
        and o.overrides->'capabilities'->(p_role||':'||p_capability)='false'::jsonb);
$$;
revoke all on function private.unit_capability_enabled(text,uuid,text,text) from public,anon,authenticated,service_role;

-- Whether an actor whose route to a unit is an assignment to that unit may use
-- one capability there. Chapter-wide holders, leadership and an actor with no
-- assignment to the unit are not narrowed; held, nothing is. An assignment
-- counts only when its own role holds the capability: the role carries it,
-- the chapter's setting leaves it on and the unit's switch leaves it on, so a
-- second role (secretary, records, ...) never restores what the first lost
-- (gate stage 188 r5s1, r6s1).
create function private.unit_staff_capability_allows(p_chapter text,p_unit uuid,p_capability text)
returns boolean language sql stable security definer set search_path='' as $$
  select p_unit is null or private.unit_settings_held()
    or not exists(select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s
      where s.unit_id=p_unit and not s.legacy_chapter_coverage)
    or exists(select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s
      join private.chapter_role_capabilities cap on cap.role=s.role and cap.capability=p_capability
      left join private.chapter_role_settings setting on setting.chapter_id=p_chapter
        and setting.role=cap.role and setting.capability=cap.capability
      where s.unit_id=p_unit and not s.legacy_chapter_coverage and coalesce(setting.enabled,true)
        and private.unit_capability_enabled(p_chapter,p_unit,s.role,p_capability))
    or private.member_has_chapter_role(p_chapter,array['coordinator','advisor','admin','vp'])
    or exists(select 1 from public.member_role_chapters r
      join public.member_chapter_memberships m on m.user_id=r.user_id and m.chapter_id=r.chapter_id and m.status='active'
      where r.user_id=(select auth.uid()) and r.chapter_id=p_chapter and r.role='steward'
        and not exists(select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s
          where s.role='steward' and not s.legacy_chapter_coverage));
$$;
revoke all on function private.unit_staff_capability_allows(text,uuid,text) from public,anon,authenticated,service_role;
-- The document policies call it directly, as the caller.
grant execute on function private.unit_staff_capability_allows(text,uuid,text) to authenticated;

-- The same for a decision about one member: an actor whose units are its only
-- route to that member needs the capability on in a unit that covers them.
-- Each covering unit or committee assignment counts only when its own role
-- holds the capability there, as above (gate stage 188 r5s1, r6s1).
create function private.unit_staff_member_capability_allows(p_chapter text,p_target uuid,p_capability text)
returns boolean language sql stable security definer set search_path='' as $$
  select private.unit_settings_held()
    or not exists(select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s
      where s.unit_id is not null and not s.legacy_chapter_coverage)
    or exists(select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s
      join private.chapter_role_capabilities cap on cap.role=s.role and cap.capability=p_capability
      left join private.chapter_role_settings setting on setting.chapter_id=p_chapter
        and setting.role=cap.role and setting.capability=cap.capability
      where s.unit_id is not null and not s.legacy_chapter_coverage and coalesce(setting.enabled,true)
        and private.chapter_unit_has_member(s.unit_id,p_chapter,p_target)
        and private.unit_capability_enabled(p_chapter,s.unit_id,s.role,p_capability))
    or exists(select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s
      join private.chapter_role_capabilities cap on cap.role=s.role and cap.capability=p_capability
      left join private.chapter_role_settings setting on setting.chapter_id=p_chapter
        and setting.role=cap.role and setting.capability=cap.capability
      join private.chapter_committees committee on committee.id=s.committee_id and committee.chapter_id=p_chapter
      join private.chapter_committee_members cm on cm.committee_id=committee.id and cm.chapter_id=committee.chapter_id
      where s.unit_id is null and cm.user_id=p_target and coalesce(setting.enabled,true)
        and committee.starts_on<=current_date and (committee.ends_on is null or committee.ends_on>=current_date)) -- utc-day: the committee window every other reader of it uses; #8568 moves them to the Eastern day helper together
    or private.member_has_chapter_role(p_chapter,array['coordinator','advisor','admin','vp'])
    or exists(select 1 from public.member_role_chapters r
      join public.member_chapter_memberships m on m.user_id=r.user_id and m.chapter_id=r.chapter_id and m.status='active'
      where r.user_id=(select auth.uid()) and r.chapter_id=p_chapter and r.role='steward'
        and not exists(select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s
          where s.role='steward' and not s.legacy_chapter_coverage));
$$;
revoke all on function private.unit_staff_member_capability_allows(text,uuid,text) from public,anon,authenticated,service_role;

create function private.unit_setting_lead(p_chapter text)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((auth.uid() is not null and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and exists(select 1 from public.chapters c where c.id=p_chapter
      and c.organization_id=private.current_member_organization()
      and (private.has_organization_role(c.organization_id,array['admin'])
        or private.member_has_chapter_role(c.id,array['vp'])))),false);
$$;
revoke all on function private.unit_setting_lead(text) from public,anon,authenticated,service_role;

create function private.unit_setting_member(p_chapter text,p_unit uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((auth.uid() is not null and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and exists(select 1 from public.chapters c
      join public.member_chapter_memberships m on m.chapter_id=c.id and m.user_id=auth.uid() and m.status='active'
      where c.id=p_chapter and c.organization_id=private.current_member_organization()
        and (p_unit is null or private.chapter_unit_has_member(p_unit,c.id,auth.uid())))),false);
$$;
revoke all on function private.unit_setting_member(text,uuid) from public,anon,authenticated,service_role;

-- A unit's stewards are the holders of its steward assignment (#7663), from
-- either assignment source; unit membership is not required. A migration-only
-- carry-over mark is old chapter coverage, not a chosen unit, so it edits nothing.
create function private.unit_setting_editor(p_chapter text,p_unit uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((exists(select 1 from private.chapter_units u where u.id=p_unit and u.chapter_id=p_chapter)
    and (private.unit_setting_lead(p_chapter) or (
      not private.member_pin_session_restricted()
      and ((private.member_has_chapter_staff_grant(p_chapter,array['steward'])
          and exists(select 1 from private.steward_assignment_scopes(auth.uid(),p_chapter) s where s.chapter_id=p_chapter
            and s.user_id=auth.uid() and s.role='steward' and s.unit_id=p_unit and not s.legacy_chapter_coverage))
        -- An organization-backed assignment carries its own grant and needs
        -- no chapter membership (gate stage 184 r4s3).
        or (auth.uid() is not null and private.mfa_satisfied()
          and exists(select 1 from private.organization_steward_unit_assignments a
            join public.organization_role_grants g on g.organization_id=a.organization_id and g.user_id=a.user_id and g.role='steward'
            join public.organization_memberships om on om.organization_id=a.organization_id and om.user_id=a.user_id and om.status='active'
            where a.user_id=auth.uid() and a.chapter_id=p_chapter and a.unit_id=p_unit and not a.legacy_chapter_coverage
              and a.organization_id=private.current_member_organization())))))),false);
$$;
revoke all on function private.unit_setting_editor(text,uuid) from public,anon,authenticated,service_role;

create function private.resolve_settings_unit(p_chapter text,p_unit uuid)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare units uuid[];
begin
  -- Held: no unit applies and none can be chosen.
  if not private.chapter_unit_settings_released(p_chapter) then
    if p_unit is not null then raise exception 'unit membership changed' using errcode='42501'; end if;
    return null;
  end if;
  if p_unit is not null then
    if not private.unit_setting_member(p_chapter,p_unit) then raise exception 'unit membership changed' using errcode='42501'; end if;
    return p_unit;
  end if;
  -- No active membership in the chapter means no unit: the chapter's settings apply.
  if not private.unit_setting_member(p_chapter,null) then return null; end if;
  select array_agg(u.id) into units from private.chapter_units u
    where u.chapter_id=p_chapter and private.chapter_unit_has_member(u.id,u.chapter_id,auth.uid());
  if coalesce(cardinality(units),0)>1 then raise exception 'choose the unit for this work' using errcode='22023',detail='unit_choice_required'; end if;
  return units[1];
end;
$$;
revoke all on function private.resolve_settings_unit(text,uuid) from public,anon,authenticated,service_role;

create function private.unit_settings_base(p_chapter text)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'workload',coalesce((select jsonb_agg(jsonb_build_object('key',f.value->>'key','label',f.value->>'label',
      'visible',(f.value->>'visible')::boolean) order by f.ordinality)
      from jsonb_array_elements(private.workload_configuration_payload(c.organization_id)->'definition'->'fields') with ordinality f(value,ordinality)
      where f.value->>'kind'='category'),'[]'::jsonb),
    'forms',coalesce((select jsonb_agg(t.key order by t.key) from (
      select distinct on(key) key,active from public.form_templates
      where is_platform_seed or organization_id=c.organization_id
      order by key,(organization_id is not null) desc,version desc) t where t.active),'[]'::jsonb),
    'templates',coalesce((select jsonb_agg(t.template_key order by t.template_key)
      from private.chapter_task_template_catalog t where t.active),'[]'::jsonb),
    'capabilities',coalesce((select jsonb_object_agg(cap.role||':'||cap.capability,coalesce(s.enabled,true))
      from private.chapter_role_capabilities cap left join private.chapter_role_settings s
        on s.chapter_id=c.id and s.role=cap.role and s.capability=cap.capability),'{}'::jsonb))
  from public.chapters c where c.id=p_chapter;
$$;
revoke all on function private.unit_settings_base(text) from public,anon,authenticated,service_role;

create function private.effective_unit_settings(p_chapter text,p_unit uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare base jsonb; defaults_row private.chapter_unit_setting_defaults; unit_row private.unit_setting_overrides;
  chapter_value jsonb; result jsonb; key text;
begin
  base:=private.unit_settings_base(p_chapter);
  if base is null then raise exception 'chapter unavailable' using errcode='42501'; end if;
  -- Held: the chapter's own settings, whatever is stored.
  if not private.chapter_unit_settings_released(p_chapter) then return base; end if;
  select * into defaults_row from private.chapter_unit_setting_defaults where chapter_id=p_chapter;
  chapter_value:=base||coalesce(defaults_row.defaults,'{}'::jsonb);
  -- The established chapter role setting remains the canonical upper bound.
  chapter_value:=jsonb_set(chapter_value,'{capabilities}',base->'capabilities');
  result:=chapter_value;
  if p_unit is not null then
    if not exists(select 1 from private.chapter_units where id=p_unit and chapter_id=p_chapter) then raise exception 'unit unavailable' using errcode='42501'; end if;
    select * into unit_row from private.unit_setting_overrides where unit_id=p_unit and chapter_id=p_chapter;
    for key in select jsonb_object_keys(coalesce(unit_row.overrides,'{}'::jsonb)) loop
      if defaults_row.allowed->key='true'::jsonb then result:=jsonb_set(result,array[key],unit_row.overrides->key); end if;
    end loop;
  end if;
  -- Never resurrect an inactive/deleted form or template after its chapter changes.
  for key in select unnest(array['forms','templates']) loop
    result:=jsonb_set(result,array[key],coalesce((select jsonb_agg(v.value order by v.ordinality)
      from jsonb_array_elements(result->key) with ordinality v(value,ordinality)
      where (base->key) @> jsonb_build_array(v.value)
        and (chapter_value->key) @> jsonb_build_array(v.value)),'[]'::jsonb));
  end loop;
  result:=jsonb_set(result,'{capabilities}',coalesce((select jsonb_object_agg(e.key,
    e.value='true'::jsonb and coalesce((result->'capabilities'->>e.key)::boolean,true))
    from jsonb_each(base->'capabilities') e),'{}'::jsonb));
  return result;
end;
$$;
revoke all on function private.effective_unit_settings(text,uuid) from public,anon,authenticated,service_role;

create function private.unit_workload_configuration(p_org uuid,p_chapter text,p_unit uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb:=private.workload_configuration_payload(p_org); settings jsonb; fields jsonb;
begin
  if p_chapter is null then
    return result||jsonb_build_object('actorId',auth.uid(),'chapterId',null,'unitId',null,'unitName',null,
      'settingsRevision','unit-settings:'||md5('organization'||result::text));
  end if;
  settings:=private.effective_unit_settings(p_chapter,p_unit);
  -- Untouched categories keep the organization's exact definition.
  if settings->'workload' is distinct from private.unit_settings_base(p_chapter)->'workload' then
    select jsonb_agg(case when f.value->>'kind'='category' and chosen.value is not null then
        f.value||jsonb_build_object('label',chosen.value->>'label','visible',(chosen.value->>'visible')::boolean and not (f.value->>'retired')::boolean,
          'required',(f.value->>'required')::boolean and (chosen.value->>'visible')::boolean)
      else f.value end order by case when f.value->>'kind'='category' then coalesce(chosen.ordinality,f.ordinality) else 1000+f.ordinality end)
      into fields from jsonb_array_elements(result->'definition'->'fields') with ordinality f(value,ordinality)
      left join lateral (select v.value,v.ordinality from jsonb_array_elements(settings->'workload') with ordinality v(value,ordinality)
        where v.value->>'key'=f.value->>'key') chosen on true;
    result:=jsonb_set(result,'{definition,fields}',fields);
  end if;
  return result||jsonb_build_object('actorId',auth.uid(),'chapterId',p_chapter,'unitId',p_unit,
    'unitName',(select name from private.chapter_units where id=p_unit and chapter_id=p_chapter),
    'settingsRevision','unit-settings:'||md5(coalesce(p_unit::text,'chapter')||p_chapter||result::text||settings::text));
end;
$$;
revoke all on function private.unit_workload_configuration(uuid,text,uuid) from public,anon,authenticated,service_role;

create function private.validate_unit_settings(p_value jsonb,p_base jsonb)
returns void language plpgsql stable set search_path='' as $$
declare key text; value jsonb; item jsonb;
begin
  if jsonb_typeof(p_value) is distinct from 'object' or octet_length(p_value::text)>16000 then raise exception 'invalid settings' using errcode='22023'; end if;
  for key,value in select * from jsonb_each(p_value) loop
    if key not in ('workload','forms','templates','capabilities') then raise exception 'unknown unit setting' using errcode='22023'; end if;
    if key='capabilities' then
      if jsonb_typeof(value)<>'object' then raise exception 'invalid capabilities' using errcode='22023'; end if;
      for item in select jsonb_build_object('key',e.key,'value',e.value) from jsonb_each(value) e loop
        if not (p_base->key ? (item->>'key')) or jsonb_typeof(item->'value')<>'boolean'
          or (item->'value'='true'::jsonb and p_base->key->(item->>'key')<>'true'::jsonb)
          then raise exception 'capability exceeds chapter permission' using errcode='42501'; end if;
      end loop;
    elsif key='workload' then
      if jsonb_typeof(value)<>'array' or jsonb_array_length(value)<>jsonb_array_length(p_base->key)
        or not exists(select 1 from jsonb_array_elements(value) v where v->'visible'='true'::jsonb)
        or (select count(distinct v->>'key') from jsonb_array_elements(value) v)<>jsonb_array_length(value)
        then raise exception 'invalid workload categories' using errcode='22023'; end if;
      for item in select * from jsonb_array_elements(value) loop
        if jsonb_typeof(item)<>'object' or item - array['key','label','visible']<>'{}'::jsonb
          or not exists(select 1 from jsonb_array_elements(p_base->key) b where b->>'key'=item->>'key')
          or jsonb_typeof(item->'visible') is distinct from 'boolean'
          or jsonb_typeof(item->'label') is distinct from 'string'
          or char_length(btrim(item->>'label')) not between 1 and 80 or item->>'label' ~ '[<>[:cntrl:]]'
          then raise exception 'invalid workload category' using errcode='22023'; end if;
      end loop;
    else
      if jsonb_typeof(value)<>'array' or jsonb_array_length(value)>200
        or (select count(distinct v.value) from jsonb_array_elements(value) v)<>jsonb_array_length(value)
        then raise exception 'invalid choices' using errcode='22023'; end if;
      for item in select * from jsonb_array_elements(value) loop
        if jsonb_typeof(item)<>'string' or not (p_base->key @> jsonb_build_array(item)) then raise exception 'choice exceeds chapter settings' using errcode='42501'; end if;
      end loop;
    end if;
  end loop;
end;
$$;
revoke all on function private.validate_unit_settings(jsonb,jsonb) from public,anon,authenticated,service_role;

-- A bounded picker is navigation, never an ordered choice of authority.
create function private.unit_settings_choices(p_chapter text,p_editor boolean,p_offset integer)
returns jsonb language sql stable security definer set search_path='' as $$
  with visible as materialized (
    select u.id,u.name from private.chapter_units u where u.chapter_id=p_chapter
      and case when p_editor then private.unit_setting_editor(p_chapter,u.id)
        else private.unit_setting_member(p_chapter,u.id) end
  ), page as (select * from visible order by name,id limit 30 offset greatest(0,p_offset))
  select jsonb_build_object('units',coalesce((select jsonb_agg(to_jsonb(p) order by p.name,p.id) from page p),'[]'::jsonb),
    'unitCount',(select count(*) from visible),
    'nextUnitOffset',case when (select count(*) from visible)>greatest(0,p_offset)+30 then greatest(0,p_offset)+30 end);
$$;
revoke all on function private.unit_settings_choices(text,boolean,integer) from public,anon,authenticated,service_role;

create function public.get_my_unit_settings(p_unit uuid default null,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare chapter text:=private.current_member_chapter(); org uuid:=private.current_member_organization(); units jsonb; selected uuid; effective jsonb;
begin
  if auth.uid() is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode='42501'; end if;
  -- Held: the clients draw nothing and keep the chapter workflow.
  if not private.unit_settings_released(org) then return jsonb_build_object('released',false); end if;
  if chapter is null then raise exception 'chapter required' using errcode='42501'; end if;
  units:=private.unit_settings_choices(chapter,false,p_offset);
  if p_unit is not null or (units->>'unitCount')::integer<=1 then
    selected:=private.resolve_settings_unit(chapter,p_unit);
    effective:=private.effective_unit_settings(chapter,selected)||jsonb_build_object('configuration',private.unit_workload_configuration(org,chapter,selected));
  end if;
  return jsonb_build_object('released',true,'actorId',auth.uid(),'chapterId',chapter,'organizationId',org,'units',units->'units','unitCount',units->'unitCount','nextUnitOffset',units->'nextUnitOffset','unitId',selected,
    'unitName',(select name from private.chapter_units where id=selected and chapter_id=chapter),
    'needsChoice',effective is null,'effective',effective,
    'canManage',private.unit_setting_lead(chapter) or exists(select 1 from private.steward_assignment_scopes(auth.uid(),chapter) s
      where s.chapter_id=chapter and s.user_id=auth.uid() and s.role='steward' and private.unit_setting_editor(chapter,s.unit_id)));
end;
$$;
revoke all on function public.get_my_unit_settings(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.get_my_unit_settings(uuid,integer) to authenticated;

create function public.get_unit_settings_workspace(p_chapter text,p_unit uuid default null,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare policy private.chapter_unit_setting_defaults; unit_row private.unit_setting_overrides; units jsonb;
begin
  if auth.uid() is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode='42501'; end if;
  if not private.chapter_unit_settings_released(p_chapter) then raise exception 'unit editor required' using errcode='42501'; end if;
  if not private.unit_setting_lead(p_chapter) and not exists(select 1 from private.chapter_units u
    where u.chapter_id=p_chapter and private.unit_setting_editor(p_chapter,u.id)) then raise exception 'unit editor required' using errcode='42501'; end if;
  if p_unit is not null and not private.unit_setting_editor(p_chapter,p_unit) then raise exception 'unit editor required' using errcode='42501'; end if;
  select * into policy from private.chapter_unit_setting_defaults where chapter_id=p_chapter;
  select * into unit_row from private.unit_setting_overrides where unit_id=p_unit and chapter_id=p_chapter;
  units:=private.unit_settings_choices(p_chapter,true,p_offset);
  return jsonb_build_object('actorId',auth.uid(),'chapterId',p_chapter,'units',units->'units','unitCount',units->'unitCount','nextUnitOffset',units->'nextUnitOffset','unitId',p_unit,
    'unitName',(select name from private.chapter_units where id=p_unit and chapter_id=p_chapter),'canSetChapter',private.unit_setting_lead(p_chapter),
    'allowed',coalesce(policy.allowed,'{}'::jsonb),'defaults',private.effective_unit_settings(p_chapter,null),
    'organizationDefaults',private.unit_settings_base(p_chapter),'chapterOverrides',coalesce(policy.defaults,'{}'::jsonb),
    'effective',private.effective_unit_settings(p_chapter,p_unit),'overrides',coalesce(unit_row.overrides,'{}'::jsonb),
    'chapterVersion',coalesce(policy.version,0),'unitVersion',coalesce(unit_row.version,0),
    'formChoices',coalesce((select jsonb_agg(jsonb_build_object('key',f.key,'labelEn',f.label_en,'labelEs',f.label_es) order by f.key)
      from (select distinct on(key) key,label_en,label_es,active from public.form_templates
        where is_platform_seed or organization_id=private.current_member_organization()
        order by key,(organization_id is not null) desc,version desc) f where f.active),'[]'::jsonb),
    'templateChoices',coalesce((select jsonb_agg(jsonb_build_object('key',t.template_key,'labelEn',t.label_en,'labelEs',t.label_es) order by t.template_key)
      from private.chapter_task_template_catalog t where t.active),'[]'::jsonb),
    'audit',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id) from (
      select actor_id,unit_id,unit_name,before_value,after_value,created_at,id from private.unit_setting_audit
      where chapter_id=p_chapter and (private.unit_setting_lead(p_chapter) or unit_id=p_unit)
      order by created_at desc,id limit 25) a),'[]'::jsonb));
end;
$$;
revoke all on function public.get_unit_settings_workspace(text,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.get_unit_settings_workspace(text,uuid,integer) to authenticated;

create function public.save_chapter_unit_settings(p_chapter text,p_defaults jsonb,p_allowed jsonb,p_expected_version integer,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old_row private.chapter_unit_setting_defaults; org uuid;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if auth.uid() is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('unit-settings:'||p_chapter,509));
  if p_actor is distinct from auth.uid() or not private.unit_setting_lead(p_chapter) or not private.chapter_unit_settings_released(p_chapter)
    then raise exception 'chapter lead or organization admin required' using errcode='42501'; end if;
  select organization_id into org from public.chapters where id=p_chapter;
  select * into old_row from private.chapter_unit_setting_defaults where chapter_id=p_chapter for update;
  if p_expected_version is distinct from coalesce(old_row.version,0) then raise exception 'settings changed; reload' using errcode='PT409'; end if;
  if jsonb_typeof(p_allowed) is distinct from 'object' or exists(select 1 from jsonb_each(p_allowed) e
    where e.key not in ('workload','forms','templates','capabilities') or jsonb_typeof(e.value)<>'boolean')
    then raise exception 'invalid delegation policy' using errcode='22023'; end if;
  -- Capability values already have their established chapter editor. This
  -- policy delegates only narrowing them for a unit, never a new grant.
  if p_defaults ? 'capabilities' then raise exception 'use the chapter capability editor' using errcode='22023'; end if;
  perform private.validate_unit_settings(p_defaults,private.unit_settings_base(p_chapter));
  if coalesce(old_row.defaults,'{}'::jsonb)=p_defaults and coalesce(old_row.allowed,'{}'::jsonb)=p_allowed then return public.get_unit_settings_workspace(p_chapter,null); end if;
  insert into private.chapter_unit_setting_defaults(chapter_id,defaults,allowed,version)
    values(p_chapter,p_defaults,p_allowed,coalesce(old_row.version,0)+1)
    on conflict(chapter_id) do update set defaults=excluded.defaults,allowed=excluded.allowed,version=excluded.version;
  insert into private.unit_setting_audit(organization_id,chapter_id,actor_id,before_value,after_value)
    values(org,p_chapter,auth.uid(),jsonb_build_object('defaults',old_row.defaults,'allowed',old_row.allowed),
      jsonb_build_object('defaults',p_defaults,'allowed',p_allowed));
  return public.get_unit_settings_workspace(p_chapter,null);
end;
$$;
revoke all on function public.save_chapter_unit_settings(text,jsonb,jsonb,integer,uuid) from public,anon,authenticated,service_role;
grant execute on function public.save_chapter_unit_settings(text,jsonb,jsonb,integer,uuid) to authenticated;

create function public.save_unit_settings(p_chapter text,p_unit uuid,p_overrides jsonb,p_expected_version integer,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old_row private.unit_setting_overrides; policy jsonb; org uuid; key text;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if auth.uid() is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('unit-settings:'||p_chapter,509));
  if p_actor is distinct from auth.uid() or not private.unit_setting_editor(p_chapter,p_unit) or not private.chapter_unit_settings_released(p_chapter)
    then raise exception 'steward of this unit required' using errcode='42501'; end if;
  select organization_id into org from public.chapters where id=p_chapter;
  select allowed into policy from private.chapter_unit_setting_defaults where chapter_id=p_chapter;
  select * into old_row from private.unit_setting_overrides where unit_id=p_unit and chapter_id=p_chapter for update;
  if p_expected_version is distinct from coalesce(old_row.version,0) then raise exception 'settings changed; reload' using errcode='PT409'; end if;
  perform private.validate_unit_settings(p_overrides,private.effective_unit_settings(p_chapter,null));
  for key in select jsonb_object_keys(p_overrides) loop
    if coalesce(policy->key,'false'::jsonb)<>'true'::jsonb then raise exception 'chapter has not delegated this setting' using errcode='42501'; end if;
  end loop;
  if coalesce(old_row.overrides,'{}'::jsonb)=p_overrides then return public.get_unit_settings_workspace(p_chapter,p_unit); end if;
  insert into private.unit_setting_overrides(unit_id,chapter_id,overrides,version)
    values(p_unit,p_chapter,p_overrides,coalesce(old_row.version,0)+1)
    on conflict(unit_id) do update set overrides=excluded.overrides,version=excluded.version;
  insert into private.unit_setting_audit(organization_id,chapter_id,unit_id,unit_name,actor_id,before_value,after_value)
    values(org,p_chapter,p_unit,(select name from private.chapter_units where id=p_unit and chapter_id=p_chapter),auth.uid(),coalesce(old_row.overrides,'{}'::jsonb),p_overrides);
  return public.get_unit_settings_workspace(p_chapter,p_unit);
end;
$$;
revoke all on function public.save_unit_settings(text,uuid,jsonb,integer,uuid) from public,anon,authenticated,service_role;
grant execute on function public.save_unit_settings(text,uuid,jsonb,integer,uuid) to authenticated;

-- Selection is request-local data, not authority. Every consumer below
-- resolves it against live memberships again; no JWT or device preference
-- can create a membership or widen a grant.
create function private.settings_request_unit()
returns uuid language sql stable set search_path='' as $$
  select nullif(current_setting('unionground.settings_unit',true),'')::uuid;
$$;
revoke all on function private.settings_request_unit() from public,anon,authenticated,service_role;

create function private.unit_settings_scope(p_scope jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare chapter text; selected uuid; requested uuid;
begin
  -- Held: nothing is stamped, and a stamp from an earlier release is kept.
  -- Checked before anything reads the member's profile.
  if private.unit_settings_held() then
    return case when p_scope ? 'chapterId' then p_scope else '{}'::jsonb end;
  end if;
  if not private.unit_settings_released(private.current_member_organization()) then
    return case when p_scope ? 'chapterId' then p_scope else '{}'::jsonb end;
  end if;
  chapter:=private.current_member_chapter();
  requested:=private.settings_request_unit();
  if p_scope ? 'chapterId' then
    if p_scope->>'chapterId' is distinct from chapter then raise exception 'chapter changed' using errcode='42501'; end if;
    selected:=nullif(p_scope->>'unitId','')::uuid;
    if requested is not null and requested is distinct from selected then raise exception 'work belongs to another unit' using errcode='PT409',detail='form_unit_conflict'; end if;
    if selected is not null and not private.unit_setting_member(chapter,selected) then raise exception 'unit membership changed' using errcode='42501'; end if;
  else
    -- No current chapter: no chapter or unit settings apply to this work.
    if chapter is null then return '{}'::jsonb; end if;
    selected:=private.resolve_settings_unit(chapter,requested);
  end if;
  if p_scope ? 'chapterId' then return p_scope; end if;
  return jsonb_build_object('chapterId',chapter,'unitId',selected,
    'unitName',(select name from private.chapter_units where id=selected and chapter_id=chapter));
end;
$$;
revoke all on function private.unit_settings_scope(jsonb) from public,anon,authenticated,service_role;

alter table public.member_forms add column settings_scope jsonb not null default '{}'::jsonb check(jsonb_typeof(settings_scope)='object');
alter table public.member_workload_logs add column settings_scope jsonb not null default '{}'::jsonb check(jsonb_typeof(settings_scope)='object');
alter table public.chapter_tasks add column settings_scope jsonb not null default '{}'::jsonb check(jsonb_typeof(settings_scope)='object');

create function private.stamp_unit_form_settings()
returns trigger language plpgsql security definer set search_path='' as $$
declare scope jsonb; settings jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if auth.uid() is null then return new; end if;
  if tg_op='UPDATE' and old.settings_scope<>'{}'::jsonb and new.settings_scope is distinct from old.settings_scope then
    raise exception 'unit scope is immutable' using errcode='22023';
  end if;
  -- Staff review keeps its existing authorization. For a bound unit it must
  -- also be the actual target unit, never another unit held by its member.
  if auth.uid() is distinct from new.user_id then
    if new.settings_scope ? 'unitId' and nullif(new.settings_scope->>'unitId','') is not null
      and not private.chapter_record_manageable(new.settings_scope->>'chapterId',(new.settings_scope->>'unitId')::uuid,null)
      then raise exception 'target unit access required' using errcode='42501'; end if;
    return new;
  end if;
  scope:=private.unit_settings_scope(case when tg_op='UPDATE' then old.settings_scope else '{}'::jsonb end);
  if scope ? 'chapterId' then
    settings:=private.effective_unit_settings(scope->>'chapterId',nullif(scope->>'unitId','')::uuid);
    if tg_op='INSERT' and not (settings->'forms' @> jsonb_build_array(new.template_key)) then raise exception 'form hidden for this unit' using errcode='42501'; end if;
  end if;
  new.settings_scope:=scope;
  return new;
end;
$$;
revoke all on function private.stamp_unit_form_settings() from public,anon,authenticated,service_role;
create trigger a01_unit_form_settings before insert or update on public.member_forms for each row execute function private.stamp_unit_form_settings();

-- A caller never labels a task itself. create_unit_task_from_template asks for
-- the stamp; its unit is resolved against live membership here.
create function private.stamp_unit_task_settings()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and old.settings_scope<>'{}'::jsonb and new.settings_scope is distinct from old.settings_scope then raise exception 'unit scope is immutable' using errcode='22023'; end if;
  if tg_op='INSERT' and auth.uid() is not null then
    new.settings_scope:=case when current_setting('unionground.settings_template_task',true)='1'
      then private.unit_settings_scope('{}'::jsonb) else '{}'::jsonb end;
  end if;
  return new;
end;
$$;
revoke all on function private.stamp_unit_task_settings() from public,anon,authenticated,service_role;
create trigger a01_unit_task_settings before insert or update on public.chapter_tasks for each row execute function private.stamp_unit_task_settings();

create function private.require_unit_workflow_context(p_actor uuid,p_chapter text,p_organization uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if p_actor is distinct from auth.uid() or p_chapter is distinct from private.current_member_chapter()
    or p_organization is distinct from private.current_member_organization()
    then raise exception 'work context changed; reload' using errcode='42501'; end if;
end;
$$;
revoke all on function private.require_unit_workflow_context(uuid,text,uuid) from public,anon,authenticated,service_role;

create function public.save_unit_form_draft(p_template_key text,p_answers jsonb,p_step integer,p_unit uuid,p_actor uuid,p_chapter text,p_organization uuid,p_expected_form_id uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid; previous text;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if auth.uid() is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode='42501'; end if;
  previous:=current_setting('unionground.settings_unit',true);
  perform private.require_unit_workflow_context(p_actor,p_chapter,p_organization);
  perform private.resolve_settings_unit(private.current_member_chapter(),p_unit);
  perform set_config('unionground.settings_unit',coalesce(p_unit::text,''),true);
  result:=public.save_form_draft(p_template_key,p_answers,p_step,p_expected_form_id);
  perform set_config('unionground.settings_unit',coalesce(previous,''),true);
  return result;
end;
$$;
revoke all on function public.save_unit_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.save_unit_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid) to authenticated;

create function public.prepare_unit_sealed_form(p_template_key text,p_unit uuid,p_actor uuid,p_chapter text,p_organization uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; previous text;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if auth.uid() is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode='42501'; end if;
  previous:=current_setting('unionground.settings_unit',true);
  perform private.require_unit_workflow_context(p_actor,p_chapter,p_organization);
  perform private.resolve_settings_unit(private.current_member_chapter(),p_unit);
  perform set_config('unionground.settings_unit',coalesce(p_unit::text,''),true);
  result:=public.prepare_sealed_form(p_template_key);
  perform set_config('unionground.settings_unit',coalesce(previous,''),true);
  return result;
end;
$$;
revoke all on function public.prepare_unit_sealed_form(text,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_unit_sealed_form(text,uuid,uuid,text,uuid) to authenticated;

create function public.save_unit_workload_log(p_entry_id uuid,p_version integer,p_values jsonb,p_status text,p_organization_id uuid,p_unit uuid,p_settings_revision text,p_actor uuid,p_chapter text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; previous text; selected uuid; snapshot jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if auth.uid() is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode='42501'; end if;
  previous:=current_setting('unionground.settings_unit',true);
  perform private.require_unit_workflow_context(p_actor,p_chapter,p_organization_id);
  selected:=private.resolve_settings_unit(private.current_member_chapter(),p_unit);
  snapshot:=private.unit_workload_configuration(private.current_member_organization(),private.current_member_chapter(),selected);
  if p_entry_id is null and p_settings_revision is distinct from snapshot->>'settingsRevision' then raise exception 'settings changed; reload' using errcode='PT409',detail='workload_configuration_changed'; end if;
  perform set_config('unionground.settings_unit',coalesce(selected::text,''),true);
  result:=public.save_configured_workload_log(p_entry_id,p_version,p_values,p_status,p_organization_id);
  perform set_config('unionground.settings_unit',coalesce(previous,''),true);
  return result;
end;
$$;
revoke all on function public.save_unit_workload_log(uuid,integer,jsonb,text,uuid,uuid,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.save_unit_workload_log(uuid,integer,jsonb,text,uuid,uuid,text,uuid,text) to authenticated;

create function public.create_unit_task_from_template(p_template_key text,p_title text,p_workstream text,p_fields jsonb,p_unit uuid,p_actor uuid,p_chapter text,p_organization uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; previous text; previous_template text;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if auth.uid() is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode='42501'; end if;
  previous:=current_setting('unionground.settings_unit',true);
  previous_template:=current_setting('unionground.settings_template_task',true);
  perform private.require_unit_workflow_context(p_actor,p_chapter,p_organization);
  perform private.resolve_settings_unit(private.current_member_chapter(),p_unit);
  perform set_config('unionground.settings_unit',coalesce(p_unit::text,''),true);
  perform set_config('unionground.settings_template_task','1',true);
  result:=public.create_chapter_task_from_template(p_template_key,p_title,p_workstream,p_fields);
  result:=jsonb_set(result,'{task}',(select to_jsonb(t) from public.chapter_tasks t where t.id=(result->'task'->>'id')::uuid));
  perform set_config('unionground.settings_template_task',coalesce(previous_template,''),true);
  perform set_config('unionground.settings_unit',coalesce(previous,''),true);
  return result;
end;
$$;
revoke all on function public.create_unit_task_from_template(text,text,text,jsonb,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.create_unit_task_from_template(text,text,text,jsonb,uuid,uuid,text,uuid) to authenticated;

-- BEGIN REVIEWED CONSUMERS
-- Reviewed predecessor from 20261106220000_conflict_refusals_not_retried.sql; preserve every existing guard.
do $guard$ begin
  if (select md5(prosrc) from pg_proc where oid='private.stamp_workload_configuration()'::regprocedure) is distinct from '65b601a60f22b74ba4f0a59f4905c880' then
    raise exception 'unreviewed private.stamp_workload_configuration predecessor' using errcode='55000';
  end if;
end $guard$;
create or replace function private.stamp_workload_configuration()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare org uuid; snapshot jsonb; values_json jsonb; fixed_values jsonb; unit_chapter text; unit_id uuid; unit_settings jsonb; unit_fields jsonb;
begin
  org := private.chapter_units_context();
  if org is not null and auth.uid() is not null then
    if tg_op='UPDATE' and old.settings_scope<>'{}'::jsonb and new.settings_scope is distinct from old.settings_scope then
      raise exception 'unit scope is immutable' using errcode='22023';
    end if;
    new.settings_scope:=private.unit_settings_scope(case when tg_op='UPDATE' then old.settings_scope else '{}'::jsonb end);
  end if;
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
  -- The unit's snapshot, built exactly as the member's own settings read
  -- builds what they were shown, from helpers the member_forms trigger
  -- reaches as well. Held, the organization's, as before this migration.
  unit_chapter := private.current_member_chapter();
  unit_id := nullif(new.settings_scope->>'unitId','')::uuid;
  snapshot := private.workload_configuration_payload(org);
  if not private.unit_settings_released(org) then
    null;
  elsif unit_chapter is null then
    snapshot := snapshot||jsonb_build_object('actorId',auth.uid(),'chapterId',null,'unitId',null,'unitName',null,
      'settingsRevision','unit-settings:'||md5('organization'||snapshot::text));
  else
    unit_settings := private.effective_unit_settings(unit_chapter,unit_id);
    if unit_settings->'workload' is distinct from private.unit_settings_base(unit_chapter)->'workload' then
      select jsonb_agg(case when f.value->>'kind'='category' and chosen.value is not null then
          f.value||jsonb_build_object('label',chosen.value->>'label','visible',(chosen.value->>'visible')::boolean and not (f.value->>'retired')::boolean,
            'required',(f.value->>'required')::boolean and (chosen.value->>'visible')::boolean)
        else f.value end order by case when f.value->>'kind'='category' then coalesce(chosen.ordinality,f.ordinality) else 1000+f.ordinality end)
        into unit_fields from jsonb_array_elements(snapshot->'definition'->'fields') with ordinality f(value,ordinality)
        left join lateral (select v.value,v.ordinality from jsonb_array_elements(unit_settings->'workload') with ordinality v(value,ordinality)
          where v.value->>'key'=f.value->>'key') chosen on true;
      snapshot := jsonb_set(snapshot,'{definition,fields}',unit_fields);
    end if;
    snapshot := snapshot||jsonb_build_object('actorId',auth.uid(),'chapterId',unit_chapter,'unitId',unit_id,
      'unitName',(select name from private.chapter_units where id=unit_id and chapter_id=unit_chapter),
      'settingsRevision','unit-settings:'||md5(coalesce(unit_id::text,'chapter')||unit_chapter||snapshot::text||unit_settings::text));
  end if;
  if coalesce(new.sub_details ->> 'workloadVersion', '0') <> snapshot ->> 'version' then raise exception 'workload configuration changed; reload' using errcode = 'PT409', detail = 'workload_configuration_changed'; end if;
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

-- The snapshot a new workload entry is validated against: the one the
-- workload trigger stores for this member's unit. Held, the organization's.
create function private.member_workload_snapshot(p_org uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select case when private.unit_settings_released(p_org)
    then private.unit_workload_configuration(p_org,private.current_member_chapter(),
      nullif(private.unit_settings_scope('{}'::jsonb)->>'unitId','')::uuid)
    else private.workload_configuration_payload(p_org) end;
$$;
revoke all on function private.member_workload_snapshot(uuid) from public,anon,authenticated,service_role;

-- Reviewed predecessor from 20261106220000_conflict_refusals_not_retried.sql; preserve every existing guard.
do $guard$ begin
  if (select md5(prosrc) from pg_proc where oid='public.save_configured_workload_log(uuid,integer,jsonb,text,uuid)'::regprocedure) is distinct from '614b30cf0827d5635a2e165c9c2bd085' then
    raise exception 'unreviewed public.save_configured_workload_log predecessor' using errcode='55000';
  end if;
end $guard$;
create or replace function public.save_configured_workload_log(p_entry_id uuid, p_version integer, p_values jsonb, p_status text, p_organization_id uuid)
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
  -- A new entry is checked against what its unit shows; an edit keeps the
  -- snapshot stored with the entry.
  if p_entry_id is null then snapshot := private.member_workload_snapshot(org);
  else
    select * into entry from public.member_workload_logs w where w.id = p_entry_id and w.user_id = (select auth.uid()) and w.workload_configuration ->> 'organizationId' = org::text for update;
    if not found then raise exception 'workload entry unavailable' using errcode = '42501'; end if;
    snapshot := entry.workload_configuration;
  end if;
  if p_version is distinct from (snapshot ->> 'version')::integer then raise exception 'workload configuration changed; reload' using errcode = 'PT409', detail = 'workload_configuration_changed'; end if;
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

-- Reviewed predecessor from 20261028174500_sealed_fmla_form_answers.sql; preserve every existing guard.
do $guard$ begin
  if (select md5(prosrc) from pg_proc where oid='public.prepare_sealed_form(text)'::regprocedure) is distinct from '1fa2bd3610d70d838e18ad855bbd7f0a' then
    raise exception 'unreviewed public.prepare_sealed_form predecessor' using errcode='55000';
  end if;
end $guard$;
create or replace function public.prepare_sealed_form(p_template_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  existing record;
  tpl record;
  org uuid;
  created uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.form_template_is_sealed(p_template_key) then
    raise exception 'invalid template' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-form-' || caller::text || '-' || p_template_key, 509));
  select id, organization_id, encrypted_content, settings_scope into existing from public.member_forms
    where user_id = caller and template_key = p_template_key and status in ('draft', 'returned')
    order by updated_at desc limit 1;
  if found then
    -- A draft from before units binds to the unit chosen now, under the form
    -- lock, so the separate sealed write that follows finds its unit.
    if existing.settings_scope = '{}'::jsonb and not private.unit_settings_held() then
      update public.member_forms f set settings_scope = private.unit_settings_scope('{}'::jsonb)
        where f.id = existing.id and f.settings_scope = '{}'::jsonb;
    else
      perform private.unit_settings_scope(existing.settings_scope);
    end if;
    if existing.organization_id is null then
      raise exception 'sensitive-data-backfill-required' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('formId', existing.id, 'organizationId', existing.organization_id,
      'envelope', existing.encrypted_content->'answers');
  end if;
  org := private.current_member_organization();
  if org is null then raise exception 'organization required' using errcode = '22023'; end if;
  -- Same precedence as save_form_draft and the registry: the organization's
  -- own template before a platform seed, then the highest version (#5827 r7s1).
  select version, active into tpl from public.form_templates
    where key = p_template_key and (is_platform_seed or organization_id = org)
    order by (organization_id is not null) desc, version desc limit 1;
  if not found then raise exception 'invalid template' using errcode = '22023'; end if;
  if not tpl.active then
    raise exception 'this form is no longer accepting new submissions' using errcode = '22023';
  end if;
  insert into public.member_forms (user_id, template_key, template_version, answers, step, organization_id)
    values (caller, p_template_key, tpl.version, '{}'::jsonb, 0, org)
    returning id into created;
  return pg_catalog.jsonb_build_object('formId', created, 'organizationId', org, 'envelope', null);
end;
end
$$;

-- Both the new wrapper and a cached client's old template RPC insert here.
-- A refusal rolls back the whole task/checklist creation, not just its label.
create function private.check_unit_task_template()
returns trigger language plpgsql security definer set search_path='' as $$
declare task public.chapter_tasks; scope jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if auth.uid() is null or not private.chapter_unit_settings_released(new.chapter_id) then return new; end if;
  select * into task from public.chapter_tasks where id=new.task_id;
  if tg_op='UPDATE' then
    -- A unit-bound task's details change only for its unit: its creator while
    -- still a member there, anyone else through that exact unit's access.
    if nullif(task.settings_scope->>'unitId','') is not null then
      if auth.uid() is distinct from old.created_by then
        if not private.chapter_record_manageable(task.chapter_id,(task.settings_scope->>'unitId')::uuid,null)
          then raise exception 'target unit access required' using errcode='42501'; end if;
      else
        perform private.unit_settings_scope(task.settings_scope);
      end if;
    end if;
    return new;
  end if;
  -- Validation only: the task row's unit was stamped when it was inserted.
  if task.settings_scope ? 'chapterId' then scope:=private.unit_settings_scope(task.settings_scope);
  elsif private.unit_setting_member(new.chapter_id,null) then scope:=private.unit_settings_scope('{}'::jsonb);
  else scope:=jsonb_build_object('chapterId',new.chapter_id,'unitId',null);
  end if;
  if scope->>'chapterId' is distinct from new.chapter_id then raise exception 'chapter changed' using errcode='42501'; end if;
  if not (private.effective_unit_settings(new.chapter_id,nullif(scope->>'unitId','')::uuid)->'templates'
    @> jsonb_build_array(new.template_key)) then raise exception 'template hidden for this unit' using errcode='42501'; end if;
  return new;
end;
$$;
revoke all on function private.check_unit_task_template() from public,anon,authenticated,service_role;
create trigger a01_unit_template_settings before insert or update on public.chapter_task_template_details
  for each row execute function private.check_unit_task_template();

-- Preserve the reviewed scoped-capability predecessor before narrowing it.
do $guard$ begin
  if (select md5(prosrc) from pg_proc where oid='private.chapter_officer_can_for_scope(text,text,uuid,uuid)'::regprocedure) is distinct from '9946e2407699bc7f7681b8b5140b3ad6' then
    raise exception 'unreviewed scoped-capability predecessor' using errcode='55000';
  end if;
end $guard$;
create or replace function private.chapter_officer_can_for_scope(p_chapter text,p_capability text,p_unit uuid,p_committee uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(((p_unit is null or (p_committee is null
      and exists(select 1 from private.chapter_units u where u.id=p_unit and u.chapter_id=p_chapter)))
    and (
      (private.chapter_officer_can(p_chapter,p_capability) and (
        p_unit is null or private.has_organization_role(private.current_member_organization(),array['admin'])
        or private.member_has_chapter_role(p_chapter,array['admin','vp'])
        or exists(select 1 from private.chapter_role_capabilities cap
          join public.member_role_chapters r on r.role=cap.role and r.chapter_id=p_chapter and r.user_id=auth.uid()
          where cap.capability=p_capability
            and private.effective_unit_settings(p_chapter,p_unit)->'capabilities'->(cap.role||':'||p_capability)='true'::jsonb
            and not exists(select 1 from private.steward_assignment_scopes(auth.uid(),p_chapter) s where s.user_id=r.user_id and s.chapter_id=r.chapter_id and s.role=r.role))))
      or (private.chapter_office_role_present(p_chapter,p_capability)
        and exists(select 1 from private.chapter_role_scopes scope
          join private.chapter_role_capabilities cap on cap.role=scope.role and cap.capability=p_capability
          left join private.chapter_role_settings setting on setting.chapter_id=scope.chapter_id and setting.role=cap.role and setting.capability=cap.capability
          where scope.user_id=auth.uid() and scope.chapter_id=p_chapter and coalesce(setting.enabled,true)
            and ((p_unit is not null and scope.unit_id=p_unit
              and private.effective_unit_settings(p_chapter,p_unit)->'capabilities'->(cap.role||':'||p_capability)='true'::jsonb)
              or (p_committee is not null and p_unit is null and scope.committee_id=p_committee and exists(
                select 1 from private.chapter_committees c where c.id=p_committee and c.chapter_id=p_chapter
                  and c.starts_on<=current_date and (c.ends_on is null or c.ends_on>=current_date)))))))),false); -- utc-day: the committee window every other reader of it uses; #8568 moves them to the Eastern day helper together
$$;
revoke all on function private.chapter_officer_can_for_scope(text,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.chapter_officer_can_for_scope(text,text,uuid,uuid) to authenticated;

-- A unit's delegated records switch narrows every scoped records decision,
-- not only the office-role one above: the assigned-role branch of
-- chapter_record_manageable (newest body 20261113115000) and the capability
-- branch of chapter_records_member_allowed (20261111184200). Chapter-wide
-- roles keep their grant, as they do against the chapter setting.
do $guard$ begin
  if (select md5(prosrc) from pg_proc where oid='private.chapter_record_manageable(text,uuid,uuid)'::regprocedure) is distinct from 'ce5bbbea606714f28ac1eb981fb625b0' then
    raise exception 'unreviewed private.chapter_record_manageable predecessor' using errcode='55000';
  end if;
  if (select md5(prosrc) from pg_proc where oid='private.chapter_records_member_allowed(text,uuid)'::regprocedure) is distinct from 'e7042d210284924e8063de90e8bf2a34' then
    raise exception 'unreviewed private.chapter_records_member_allowed predecessor' using errcode='55000';
  end if;
end $guard$;
CREATE OR REPLACE FUNCTION private.chapter_record_manageable(p_chapter text, p_unit uuid, p_committee uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (private.member_has_chapter_role(p_chapter,array['steward','coordinator','advisor','admin','vp'])
      and private.unit_staff_capability_allows(p_chapter,p_unit,'records'))
    or exists (
      select 1 from private.chapter_role_capabilities capability
      left join private.chapter_role_settings setting on setting.chapter_id=p_chapter
        and setting.role=capability.role and setting.capability=capability.capability
      where capability.capability='records'
        and capability.role=any(array['steward','coordinator','advisor','admin','vp'])
        and coalesce(setting.enabled,true)
        and private.member_has_chapter_staff_grant(p_chapter,array[capability.role])
      and (
        (p_unit is null and p_committee is null)
        or exists (
          select 1 from (select * from private.steward_assignment_scopes((select auth.uid()),null) where not legacy_chapter_coverage) scope
          left join private.chapter_committees committee on committee.id = scope.committee_id
          where scope.user_id = (select auth.uid()) and scope.chapter_id = p_chapter
            and scope.role=capability.role
            and (
              (p_unit is not null and p_committee is null and scope.unit_id = p_unit
                and private.unit_capability_enabled(p_chapter,p_unit,capability.role,'records'))
              or (p_unit is null and p_committee is not null and scope.committee_id = p_committee
                and (committee.starts_on is null or committee.starts_on <= current_date) -- utc-day: the committee window every other reader of it uses; #8568 moves them to the Eastern day helper together
                and (committee.ends_on is null or committee.ends_on >= current_date)) -- utc-day: the committee window every other reader of it uses; #8568 moves them to the Eastern day helper together
            )
        )
      )
    )
    or private.chapter_officer_can_for_scope(p_chapter,'records',p_unit,p_committee);
$function$;

create or replace function private.chapter_records_member_allowed(p_chapter text, p_target uuid)
returns boolean
language sql stable security definer set search_path = ''
as $function$
  select p_target is not null and (select private.mfa_satisfied())
    and (
      (private.chapter_staff_member_allowed(
        p_chapter, p_target, array['steward','coordinator','advisor','admin','vp'])
        and private.unit_staff_member_capability_allows(p_chapter, p_target, 'records'))
      or exists (
        select 1 from private.chapter_role_capabilities capability
        left join private.chapter_role_settings setting
          on setting.chapter_id = p_chapter and setting.role = capability.role
         and setting.capability = capability.capability
        where capability.capability = 'records' and coalesce(setting.enabled, true)
          and private.actor_role_covers_member(
            (select auth.uid()), p_chapter, capability.role, p_target, false)
          -- Coverage that comes only through units whose settings turn
          -- records off for this role does not count (#7667).
          and (not exists (select 1 from private.steward_assignment_scopes((select auth.uid()), p_chapter) scope
                where scope.role = capability.role and scope.unit_id is not null and not scope.legacy_chapter_coverage
                  and not private.unit_capability_enabled(p_chapter, scope.unit_id, capability.role, 'records'))
            or exists (select 1 from private.steward_assignment_scopes((select auth.uid()), p_chapter) scope
                where scope.role = capability.role and not scope.legacy_chapter_coverage
                  and ((scope.unit_id is null and exists (select 1 from private.chapter_committees committee
                      join private.chapter_committee_members m on m.committee_id = committee.id and m.chapter_id = committee.chapter_id
                      where committee.id = scope.committee_id and committee.chapter_id = p_chapter and m.user_id = p_target
                        and committee.starts_on <= current_date and (committee.ends_on is null or committee.ends_on >= current_date))) -- utc-day: the committee window every other reader of it uses; #8568 moves them to the Eastern day helper together
                    or (scope.unit_id is not null and private.chapter_unit_has_member(scope.unit_id, p_chapter, p_target)
                      and private.unit_capability_enabled(p_chapter, scope.unit_id, capability.role, 'records')))))
      )
    );
$function$;

-- #8713's notice-scope decision (newest body 20261113121000) reads only the
-- chapter's notices setting; a unit's delegated switch narrows it as it does
-- every other scoped officer decision (gate stage 153 ruling, Nov 14, 2026).
do $guard$ begin
  if (select md5(prosrc) from pg_proc where oid='private.chapter_notice_scope_allowed(text,uuid,uuid)'::regprocedure) is distinct from '2042ad13ac71caff73c6443c8aa99b28' then
    raise exception 'unreviewed private.chapter_notice_scope_allowed predecessor' using errcode='55000';
  end if;
end $guard$;
CREATE OR REPLACE FUNCTION private.chapter_notice_scope_allowed(p_chapter text, p_unit uuid, p_committee uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select auth.uid()) is not null
    and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and not (p_unit is not null and p_committee is not null)
    and exists (
      select 1 from public.chapters chapter
      where chapter.id=p_chapter
        and chapter.organization_id=private.current_member_organization()
        and private.is_organization_member(chapter.organization_id)
        and (p_unit is null or exists (
          select 1 from private.chapter_units unit
          where unit.id=p_unit and unit.chapter_id=p_chapter))
        and (p_committee is null or exists (
          select 1 from private.chapter_committees committee
          where committee.id=p_committee and committee.chapter_id=p_chapter
            and committee.starts_on<=current_date -- utc-day: the committee window every other reader of it uses; #8568 moves them to the Eastern day helper together
            and (committee.ends_on is null or committee.ends_on>=current_date))) -- utc-day: the committee window every other reader of it uses; #8568 moves them to the Eastern day helper together
        and (
          private.chapter_access_leadership(p_chapter)
          or (
            private.chapter_office_role_present(p_chapter,'notices')
            and exists (
              select 1 from public.member_role_chapters grant_row
              join private.chapter_role_capabilities capability
                on capability.role=grant_row.role and capability.capability='notices'
              left join private.chapter_role_settings setting
                on setting.chapter_id=grant_row.chapter_id and setting.role=grant_row.role
               and setting.capability='notices'
              where grant_row.user_id=(select auth.uid()) and grant_row.chapter_id=p_chapter
                and coalesce(setting.enabled,true)
                -- #7667: in a unit, that unit's delegated notices switch narrows the role.
                and private.unit_capability_enabled(p_chapter,p_unit,grant_row.role,'notices')
                -- a project decision: only steward offices require
                -- a container; an unscoped enabled office keeps Main's reach.
                and (grant_row.role<>'steward' or p_unit is not null or p_committee is not null)
                and (
                  exists (
                    select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) scope
                    where scope.user_id=grant_row.user_id and scope.chapter_id=grant_row.chapter_id
                      and scope.role=grant_row.role
                      and ((p_unit is not null and scope.unit_id=p_unit)
                        or (p_committee is not null and scope.committee_id=p_committee)))
                  or (grant_row.role<>'steward' and not exists (
                    select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) scope
                    where scope.user_id=grant_row.user_id and scope.chapter_id=grant_row.chapter_id
                      and scope.role=grant_row.role))
                )
            )
          )
          -- #7664: an organization steward grant reaches only the unit it is
          -- assigned to in this chapter, under the chapter's steward notices
          -- setting, never the whole chapter or organization.
          or (
            p_unit is not null and p_committee is null
            and private.has_organization_role(chapter.organization_id,array['steward'])
            and exists (
              select 1 from private.organization_steward_unit_assignments assignment
              join private.chapter_role_capabilities capability
                on capability.role=assignment.role and capability.capability='notices'
              left join private.chapter_role_settings setting
                on setting.chapter_id=assignment.chapter_id and setting.role=assignment.role
               and setting.capability='notices'
              where assignment.user_id=(select auth.uid()) and assignment.chapter_id=p_chapter
                and assignment.organization_id=chapter.organization_id and assignment.unit_id=p_unit
                and coalesce(setting.enabled,true)
                and private.unit_capability_enabled(p_chapter,p_unit,assignment.role,'notices')
            )
          )
        )
    );
$function$;
revoke all on function private.chapter_notice_scope_allowed(text,uuid,uuid) from public,anon,authenticated,service_role;

-- Document writes: a unit's delegated documents switch narrows a steward whose
-- route to the unit is an assignment there (gate stage 184 r3s1). Ordinary
-- member reads and chapter-wide grants are unchanged. Newest bodies:
-- update_chapter_document_content and both policies from
-- 20261109060229_unit_stewards_join_chapter_collaboration.sql.
do $guard$ begin
  if (select md5(prosrc) from pg_proc where oid='public.update_chapter_document_content(uuid,text,text,text,text,text,text)'::regprocedure) is distinct from '5c64118acef8a1b6b6e2cb2a825a98c7' then
    raise exception 'unreviewed public.update_chapter_document_content predecessor' using errcode='55000';
  end if;
  if (select with_check from pg_catalog.pg_policies where schemaname='public' and tablename='chapter_documents' and policyname='chapter_documents_staff_create') is distinct from '(((chapter_id = private.current_member_chapter()) AND (created_by = ( SELECT auth.uid() AS uid)) AND private.member_has_chapter_staff_grant(chapter_id, ARRAY[''steward''::text, ''coordinator''::text, ''advisor''::text, ''admin''::text, ''vp''::text])) OR ((chapter_id = private.current_member_chapter()) AND (created_by = ( SELECT auth.uid() AS uid)) AND private.chapter_officer_can_for_scope(chapter_id, ''documents''::text, access_unit_id, access_committee_id)))' then
    raise exception 'unreviewed chapter_documents_staff_create predecessor' using errcode='55000';
  end if;
  if (select qual from pg_catalog.pg_policies where schemaname='public' and tablename='chapter_documents' and policyname='chapter_documents_staff_write') is distinct from '(((chapter_id = private.current_member_chapter()) AND private.member_has_chapter_staff_grant(chapter_id, ARRAY[''steward''::text, ''coordinator''::text, ''advisor''::text, ''admin''::text, ''vp''::text])) OR ((chapter_id = private.current_member_chapter()) AND private.chapter_officer_can_for_scope(chapter_id, ''documents''::text, access_unit_id, access_committee_id)))'
    or (select with_check from pg_catalog.pg_policies where schemaname='public' and tablename='chapter_documents' and policyname='chapter_documents_staff_write') is distinct from '(((chapter_id = private.current_member_chapter()) AND private.member_has_chapter_staff_grant(chapter_id, ARRAY[''steward''::text, ''coordinator''::text, ''advisor''::text, ''admin''::text, ''vp''::text])) OR ((chapter_id = private.current_member_chapter()) AND private.chapter_officer_can_for_scope(chapter_id, ''documents''::text, access_unit_id, access_committee_id)))' then
    raise exception 'unreviewed chapter_documents_staff_write predecessor' using errcode='55000';
  end if;
end $guard$;
create or replace function public.update_chapter_document_content(p_id uuid, p_title text, p_document_type text, p_summary text, p_body text, p_visibility text, p_action text DEFAULT 'save'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare row public.chapter_documents%rowtype; chapter text := private.current_member_chapter();
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then raise exception 'authentication required' using errcode='42501'; end if;
  if p_action not in ('save','republish','archive') then raise exception 'invalid document action' using errcode='22023'; end if;
  if p_document_type not in ('contract','policy','minutes','training','template','other') or p_visibility not in ('chapter','staff') then raise exception 'invalid document fields' using errcode='22023'; end if;
  select d.* into row from public.chapter_documents d where d.id=p_id and d.chapter_id=chapter for update;
  if row.id is null then raise exception 'document unavailable' using errcode='22023'; end if;
  if not ((private.member_has_chapter_staff_grant(chapter,array['steward','coordinator','advisor','admin','vp']) and private.chapter_document_container_allows(chapter,row.access_unit_id,row.access_committee_id) and private.unit_staff_capability_allows(chapter,row.access_unit_id,'documents')) or private.chapter_officer_can_for_scope(chapter,'documents',row.access_unit_id,row.access_committee_id)) then raise exception 'document outside access scope' using errcode='42501'; end if;
  if p_action='save' and row.status='published' then raise exception 'published document requires a new version or archive' using errcode='55000'; end if;
  update public.chapter_documents d set title=btrim(p_title), document_type=p_document_type, summary=coalesce(p_summary,''), body=coalesce(p_body,''), visibility=p_visibility,
    status=case when p_action='archive' then 'archived' when p_action='republish' then 'published' else d.status end,
    version=case when p_action='republish' then d.version+1 else d.version end,
    published_at=case when p_action='republish' then now() else d.published_at end
  where d.id=p_id and d.chapter_id=chapter returning d.* into row;
  if row.id is null then raise exception 'document unavailable' using errcode='22023'; end if;
  return to_jsonb(row);
end;
end;
end;
$function$;

alter policy chapter_documents_staff_create on public.chapter_documents with check ((((chapter_id = private.current_member_chapter()) AND (created_by = ( SELECT auth.uid() AS uid)) AND private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND private.unit_staff_capability_allows(chapter_id, access_unit_id, 'documents'::text)) OR ((chapter_id = private.current_member_chapter()) AND (created_by = ( SELECT auth.uid() AS uid)) AND private.chapter_officer_can_for_scope(chapter_id, 'documents'::text, access_unit_id, access_committee_id))));
alter policy chapter_documents_staff_write on public.chapter_documents using ((((chapter_id = private.current_member_chapter()) AND private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND private.unit_staff_capability_allows(chapter_id, access_unit_id, 'documents'::text)) OR ((chapter_id = private.current_member_chapter()) AND private.chapter_officer_can_for_scope(chapter_id, 'documents'::text, access_unit_id, access_committee_id)))) with check ((((chapter_id = private.current_member_chapter()) AND private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND private.unit_staff_capability_allows(chapter_id, access_unit_id, 'documents'::text)) OR ((chapter_id = private.current_member_chapter()) AND private.chapter_officer_can_for_scope(chapter_id, 'documents'::text, access_unit_id, access_committee_id))));

-- The same documents switch on the remaining unit-document staff paths: the
-- staff arms of the read policy (staff-visibility and draft documents; the
-- member arms are unchanged) and sharing a document into a handshake.
-- Newest definitions: chapter_documents_read from
-- 20261109060229_unit_stewards_join_chapter_collaboration.sql, the share from
-- 20261109102053_seven_graph_writers_restore_lock_gate.sql.
do $guard$ begin
  -- Policy text is rendered under the session's search path: under ours the
  -- public tables it reads print qualified, so the qualifier is dropped before
  -- comparing with the text the contract read with public on the path.
  if (select md5(prosrc) from pg_proc where oid='public.share_chapter_handshake_document(uuid,uuid,uuid)'::regprocedure) is distinct from '318bb122d7c6c88400f8be6b7b68b30f' then
    raise exception 'unreviewed public.share_chapter_handshake_document predecessor' using errcode='55000';
  end if;
  if (select pg_catalog.replace(qual,'public.','') from pg_catalog.pg_policies where schemaname='public' and tablename='chapter_documents' and policyname='chapter_documents_read') is distinct from '(((chapter_id = private.current_member_chapter()) AND (((status = ''published''::text) AND ((visibility = ''chapter''::text) OR private.member_has_chapter_staff_grant(chapter_id, ARRAY[''steward''::text, ''coordinator''::text, ''advisor''::text, ''admin''::text, ''vp''::text]))) OR private.member_has_chapter_staff_grant(chapter_id, ARRAY[''steward''::text, ''coordinator''::text, ''advisor''::text, ''admin''::text, ''vp''::text]))) OR ((status = ''published''::text) AND private.member_has_chapter_staff_grant(private.current_member_chapter(), ARRAY[''steward''::text, ''coordinator''::text, ''advisor''::text, ''admin''::text, ''vp''::text]) AND (EXISTS ( SELECT 1
   FROM (chapter_handshake_documents hd
     JOIN chapter_handshakes h ON ((h.id = hd.handshake_id)))
  WHERE ((hd.document_id = chapter_documents.id) AND (h.status = ''active''::text) AND ((private.current_member_chapter() = h.chapter_id) OR (private.current_member_chapter() = h.receiving_chapter_id)))))) OR ((chapter_id = private.current_member_chapter()) AND private.chapter_officer_can_for_scope(chapter_id, ''documents''::text, access_unit_id, access_committee_id)))' then
    raise exception 'unreviewed chapter_documents_read predecessor' using errcode='55000';
  end if;
end $guard$;
create or replace function public.share_chapter_handshake_document(
  p_handshake_id uuid,
  p_document_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  item public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
begin
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  select * into item from public.chapter_handshakes where id = p_handshake_id for update;
  if caller is null or not found or item.status <> 'active' or item.data_scope <> 'docs_only'
     or (chapter is distinct from item.chapter_id and chapter is distinct from item.receiving_chapter_id)
     or not private.member_has_chapter_staff_grant(chapter, array['steward','coordinator','advisor','admin','vp'])
     or not exists (
       select 1 from public.chapter_documents d
       where d.id = p_document_id and d.chapter_id = chapter and d.status = 'published'
         and private.chapter_document_container_allows(d.chapter_id, d.access_unit_id, d.access_committee_id)
         and private.unit_staff_capability_allows(d.chapter_id, d.access_unit_id, 'documents')
     ) then
    raise exception 'document exchange unavailable' using errcode = '42501';
  end if;
  select * into prior_event from public.chapter_handshake_events
  where idempotency_key = p_idempotency_key;
  if found then
    if prior_event.handshake_id <> item.id or prior_event.actor <> caller
       or prior_event.transition <> 'document_shared'
       or prior_event.detail ->> 'documentId' is distinct from p_document_id::text then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('shared', true, 'handshakeId', item.id, 'documentId', p_document_id);
  end if;
  insert into public.chapter_handshake_documents (handshake_id, document_id, shared_by)
  values (item.id, p_document_id, caller) on conflict do nothing;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status,
     detail)
  values (item.id, p_idempotency_key, caller, chapter, 'document_shared', 'active', 'active',
    pg_catalog.jsonb_build_object('documentId', p_document_id));
  return pg_catalog.jsonb_build_object('shared', true, 'handshakeId', item.id, 'documentId', p_document_id);
end;
end;
$function$;

alter policy chapter_documents_read on public.chapter_documents using ((((chapter_id = private.current_member_chapter()) AND (((status = 'published'::text) AND ((visibility = 'chapter'::text) OR (private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND private.unit_staff_capability_allows(chapter_id, access_unit_id, 'documents'::text)))) OR (private.member_has_chapter_staff_grant(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND private.unit_staff_capability_allows(chapter_id, access_unit_id, 'documents'::text)))) OR ((status = 'published'::text) AND private.member_has_chapter_staff_grant(private.current_member_chapter(), ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND (EXISTS ( SELECT 1
   FROM (public.chapter_handshake_documents hd
     JOIN public.chapter_handshakes h ON ((h.id = hd.handshake_id)))
  WHERE ((hd.document_id = chapter_documents.id) AND (h.status = 'active'::text) AND ((private.current_member_chapter() = h.chapter_id) OR (private.current_member_chapter() = h.receiving_chapter_id))))) AND ((chapter_id IS DISTINCT FROM private.current_member_chapter()) OR private.unit_staff_capability_allows(chapter_id, access_unit_id, 'documents'::text))) OR ((chapter_id = private.current_member_chapter()) AND private.chapter_officer_can_for_scope(chapter_id, 'documents'::text, access_unit_id, access_committee_id))));
comment on policy chapter_documents_read on public.chapter_documents is 'Staff-visibility and draft chapter documents for chapter staff; chapter_documents_container_scope still keeps a unit or committee document inside its container. #7665: a unit-scoped or in-date committee-scoped staff grant counts through private.member_has_chapter_staff_grant. #7667: a unit''s delegated documents switch narrows a grant whose route to that unit is an assignment there, on the handshake branch too when the reader is in the document''s own chapter (gate stage 188 r5s2); a receiving chapter keeps its handshake read; members keep the published chapter documents.';

comment on policy chapter_documents_staff_create on public.chapter_documents is 'Chapter staff create chapter documents; container scope still applies. #7665: a unit-scoped or in-date committee-scoped staff grant counts through private.member_has_chapter_staff_grant. #7667: a unit''s delegated documents switch narrows a grant whose route to that unit is an assignment there.';
comment on policy chapter_documents_staff_write on public.chapter_documents is 'Chapter staff edit chapter documents; container scope still applies. #7665: a unit-scoped or in-date committee-scoped staff grant counts through private.member_has_chapter_staff_grant. #7667: a unit''s delegated documents switch narrows a grant whose route to that unit is an assignment there.';
create policy mfa_assurance on private.chapter_unit_setting_defaults as restrictive for all to authenticated
  using(private.mfa_satisfied()) with check(private.mfa_satisfied());
create policy mfa_assurance on private.unit_setting_overrides as restrictive for all to authenticated
  using(private.mfa_satisfied()) with check(private.mfa_satisfied());
create policy mfa_assurance on private.unit_setting_audit as restrictive for all to authenticated
  using(private.mfa_satisfied()) with check(private.mfa_satisfied());
comment on policy mfa_assurance on private.chapter_unit_setting_defaults is 'RPC-only settings; no permissive client policy or direct table grant.';
comment on policy mfa_assurance on private.unit_setting_overrides is 'RPC-only settings; no permissive client policy or direct table grant.';
comment on policy mfa_assurance on private.unit_setting_audit is 'RPC-only audit trail; no permissive client policy or direct table grant.';
grant select(settings_scope) on public.member_forms,public.member_workload_logs,public.chapter_tasks to authenticated;
comment on column public.member_forms.settings_scope is 'The chosen unit for this piece of work; empty only on historical rows until their first authorized save.';
comment on column public.member_workload_logs.settings_scope is 'The unit of the immutable configuration snapshot; personal history lists every authorized row with this label.';
comment on column public.chapter_tasks.settings_scope is 'Template-workflow unit; does not grant access or replace existing task authorization.';
-- Only the functions/triggers deliberately reviewed in this migration.
-- Record their changed lifecycle call graph; never bless an unrelated surface.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select s.kind,s.schema_name,s.table_name,s.object_name,s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind='function' and (
  (s.schema_name='private' and split_part(s.object_name,'(',1) in ('unit_setting_lead','unit_setting_member','unit_setting_editor','resolve_settings_unit','unit_settings_base','effective_unit_settings','validate_unit_settings','unit_settings_choices','settings_request_unit','unit_settings_scope','stamp_unit_form_settings','stamp_unit_task_settings','require_unit_workflow_context','stamp_workload_configuration','check_unit_task_template','chapter_officer_can_for_scope','unit_settings_released','unit_settings_held','unit_staff_capability_allows','unit_staff_member_capability_allows','chapter_unit_settings_released','unit_capability_enabled','chapter_record_manageable','chapter_notice_scope_allowed','chapter_records_member_allowed',
    -- Unchanged helpers the unit triggers above now reach through unit access checks.
    'organization_feature_enabled','organization_setting_effective','member_has_chapter_staff_grant','chapter_office_role_present','chapter_role_scope_expired','chapter_officer_can','steward_assignment_scopes'))
  or (s.schema_name='public' and split_part(s.object_name,'(',1) in ('prepare_sealed_form','save_configured_workload_log','save_unit_workload_log','prepare_unit_sealed_form','save_unit_form_draft','create_unit_task_from_template'))))
  or (s.kind='trigger' and s.schema_name='public' and s.object_name in ('a01_unit_form_settings','a01_unit_task_settings','a01_unit_template_settings'))
  or (s.kind='trigger' and s.schema_name='private' and s.table_name in ('chapter_unit_setting_defaults','unit_setting_overrides','unit_setting_audit'))
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;

notify pgrst,'reload schema';
commit;
