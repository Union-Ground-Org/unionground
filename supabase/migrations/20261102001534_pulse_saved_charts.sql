-- #6692: one portable spec per chart. Figures are never persisted or sent in
-- messages; each viewer re-runs the current authorization and privacy checks.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.pulse_saved_charts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 100 and title !~ '[[:cntrl:]<>]'),
  scope text not null default 'personal' check (scope in ('personal','chapter','organization')),
  spec jsonb not null check (pg_catalog.jsonb_typeof(spec) = 'object' and pg_catalog.octet_length(spec::text) <= 2048),
  pinned boolean not null default false,
  home boolean not null default false check (not home or pinned),
  deleted_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);
create index pulse_saved_charts_owner_idx on private.pulse_saved_charts(owner_id, organization_id, updated_at desc);
create index pulse_saved_charts_chapter_idx on private.pulse_saved_charts(chapter_id);
alter table private.pulse_saved_charts enable row level security;
alter table private.pulse_saved_charts force row level security;
revoke all on private.pulse_saved_charts from public, anon, authenticated, service_role;
create trigger a00_case_graph_lock before insert or update or delete on private.pulse_saved_charts
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.pulse_saved_charts
for each row execute function private.lock_case_graph_row_keys('{owner_id}', '');

create function private.pulse_chart_context(p_hat text)
returns uuid language plpgsql stable security definer set search_path = '' as $function$
declare org uuid; staff jsonb;
begin
  if auth.uid() is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.member_pin_require_full_session();
  org := private.current_member_organization();
  if org is null or not private.is_organization_member(org) or not private.organization_is_union(org) then
    raise exception 'chart unavailable' using errcode = '42501';
  end if;
  if p_hat = 'member' then return org; end if;
  staff := public.get_my_mobile_staff_scope();
  if p_hat is null or p_hat not in ('steward','coordinator','advisor','vp','president','secretary','admin','treasurer')
    or coalesce((staff->>'staffAuthorized')::boolean, false) is not true
    or staff->>'organizationId' is distinct from org::text
    or not (coalesce(staff->'roles','[]'::jsonb) ? p_hat or coalesce(staff->'chapterRoles','[]'::jsonb) ? p_hat) then
    raise exception 'chart unavailable' using errcode = '42501';
  end if;
  return org;
end;
$function$;

create function private.pulse_chart_readable(p_owner uuid, p_org uuid, p_chapter text, p_scope text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select auth.uid() is not null and private.mfa_satisfied()
    and private.current_member_organization() = p_org and private.is_organization_member(p_org)
    and exists (select 1 from public.chapters c where c.id = p_chapter and c.organization_id = p_org)
    and (p_owner = auth.uid() or (p_scope = 'chapter' and exists (
      select 1 from public.member_chapter_memberships m where m.user_id = auth.uid()
        and m.chapter_id = p_chapter and m.status = 'active'))
      or (p_scope = 'organization' and coalesce((public.get_my_mobile_staff_scope()->>'staffAuthorized')::boolean,false)));
$function$;
create policy pulse_chart_read on private.pulse_saved_charts for select to authenticated
using (private.pulse_chart_readable(owner_id, organization_id, chapter_id, scope));
create policy pulse_chart_insert on private.pulse_saved_charts for insert to authenticated
with check (owner_id = (select auth.uid()) and organization_id = private.current_member_organization());
create policy pulse_chart_update on private.pulse_saved_charts for update to authenticated
using (owner_id = (select auth.uid()) and organization_id = private.current_member_organization())
with check (owner_id = (select auth.uid()) and organization_id = private.current_member_organization());
create policy pulse_chart_delete on private.pulse_saved_charts for delete to authenticated
using (owner_id = (select auth.uid()) and organization_id = private.current_member_organization());
create policy mfa_assurance on private.pulse_saved_charts as restrictive for all to authenticated
using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy pulse_chart_read on private.pulse_saved_charts is 'Personal specs stay with their owner; shared chapter specs require an active chapter membership, and organization specs require staff authorization in the selected organization. Figures always pass the separate viewer-authorized read.';
comment on policy pulse_chart_insert on private.pulse_saved_charts is 'Only the owner in the selected organization may create a spec. Client table grants remain revoked; RPCs validate scope, exact chapter, known spec fields and role.';
comment on policy pulse_chart_update on private.pulse_saved_charts is 'Only the owner in the selected organization may change their specs or pins. Client table grants remain revoked; writers validate scope, exact chapter, known spec fields and role before every mutation.';
comment on policy pulse_chart_delete on private.pulse_saved_charts is 'Only the owner in the selected organization may remove their specs. Client table grants remain revoked; the remove RPC enforces owner and full-session checks.';
comment on policy mfa_assurance on private.pulse_saved_charts is 'Restrictive session assurance for every client operation, in addition to each RPC full-session and membership check.';

-- Reject unknown fields, arbitrary dates, SQL-like expressions and identity
-- selectors. Narrowing uses a registered unit id and a canonical case type.
create function private.pulse_chart_spec(p_spec jsonb, p_hat text, p_chapter text)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare org uuid; measure text; unit_id uuid;
begin
  org := private.pulse_chart_context(p_hat);
  if pg_catalog.jsonb_typeof(p_spec) is distinct from 'object'
    or p_spec->'version' is distinct from '1'::jsonb
    or (p_spec - array['version','measure','breakdown','period','form','unitID','caseType','level']) <> '{}'::jsonb
    or not (p_spec ?& array['measure','breakdown','period','form']) then
    raise exception 'invalid chart specification' using errcode = '22023';
  end if;
  measure := p_spec->>'measure';
  if measure is null or measure not in ('my_actions','published_actions','meeting_turnout','visible_cases')
    or p_spec->>'form' is null or p_spec->>'form' not in ('bars','line','stack','meter','table')
    or p_spec->>'period' is null or p_spec->>'period' not in ('3m','6m','12m')
    or p_spec->>'breakdown' is null or p_spec->>'breakdown' not in ('month','meeting','unit') then
    raise exception 'invalid chart specification' using errcode = '22023';
  end if;
  if measure = 'visible_cases' and p_hat = 'member' then
    raise exception 'chart unavailable' using errcode = '42501';
  end if;
  if p_spec ? 'level' and (p_spec->>'level' is null or p_spec->>'level' not in ('chapter','local')) then
    raise exception 'invalid chart specification' using errcode = '22023';
  end if;
  if p_spec->>'level' = 'local' and (p_hat = 'member' or not private.has_organization_role(org,array[p_hat])) then
    raise exception 'local chart unavailable' using errcode = '42501';
  end if;
  if (p_spec->>'breakdown' = 'unit' or p_spec ? 'unitID') and p_hat <> 'admin' then
    raise exception 'unit chart unavailable' using errcode = '42501';
  end if;
  if (p_spec->>'breakdown' = 'meeting' and measure <> 'meeting_turnout')
    or (measure = 'my_actions' and (p_spec->>'breakdown' <> 'month' or p_spec ? 'unitID' or p_spec ? 'caseType' or p_spec->>'level' = 'local'))
    or (p_spec ? 'caseType' and (measure <> 'visible_cases' or p_spec->>'caseType' is null
      or p_spec->>'caseType' not in ('Discipline','Scheduling','Telework','Safety','Pay','Other'))) then
    raise exception 'invalid chart specification' using errcode = '22023';
  end if;
  if not exists (select 1 from public.chapters c where c.id = p_chapter and c.organization_id = org)
    or not (exists (select 1 from public.member_chapter_memberships m
      where m.user_id = auth.uid() and m.chapter_id = p_chapter and m.status = 'active')
      or (p_hat <> 'member' and private.has_organization_role(org,array[p_hat]))) then
    raise exception 'chart unavailable' using errcode = '42501';
  end if;
  if p_spec ? 'unitID' then
    begin unit_id := (p_spec->>'unitID')::uuid;
    exception when invalid_text_representation then raise exception 'invalid chart specification' using errcode = '22023'; end;
    if unit_id is null or not exists (select 1 from private.chapter_units u
      where u.id = unit_id and u.organization_id = org and (u.chapter_id = p_chapter or p_spec->>'level' = 'local')) then
      raise exception 'chart unavailable' using errcode = '42501';
    end if;
  end if;
  return case when unit_id is null then p_spec else p_spec || pg_catalog.jsonb_build_object('unitID',unit_id::text) end;
end;
$function$;

-- Canonical twelve-month cells are tested BEFORE narrowing, rolling-up or
-- selecting 3/6 months. Withholding the whole cube prevents a small cell being
-- recovered by subtracting a filtered chart from its unfiltered neighbour.
-- Staff case cells use the central case helper (including leadership toggles,
-- restrictions and scoped grants); no alternate membership permission exists.
create function private.pulse_chart_values(p_spec jsonb, p_hat text, p_chapter text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  org uuid; spec jsonb; measure text; privacy_floor integer; rows jsonb; safe boolean;
  first_month timestamptz; selected_month timestamptz; explanation text; local_level boolean;
begin
  perform private.lock_case_graph_read();
  org := private.pulse_chart_context(p_hat);
  spec := private.pulse_chart_spec(p_spec, p_hat, p_chapter);
  measure := spec->>'measure';
  local_level := coalesce(spec->>'level','chapter') = 'local';
  if measure <> 'my_actions' and private.quarterly_survey_gate_locks_caller() then
    return pg_catalog.jsonb_build_object('locked',true,'rows','[]'::jsonb,'countedFrom','Complete the quarterly survey to see aggregate figures.','privacyFloor',10);
  end if;
  privacy_floor := greatest(10, coalesce(private.organization_limit(org,'limits.analytics.anonymity_floor'),25));
  first_month := (pg_catalog.date_trunc('month',pg_catalog.now() at time zone 'America/New_York') - interval '11 months') at time zone 'America/New_York';
  selected_month := (pg_catalog.date_trunc('month',pg_catalog.now() at time zone 'America/New_York')
    - case spec->>'period' when '3m' then interval '2 months' when '6m' then interval '5 months' else interval '11 months' end) at time zone 'America/New_York';
  explanation := case measure
    when 'my_actions' then 'Your recorded collective-action sign-ups, grouped by Eastern calendar month. Other people and product analytics are excluded.'
    when 'published_actions' then 'Recorded sign-ups to published collective actions for this chapter. Private drafts, cancelled actions and product analytics are excluded.'
    when 'meeting_turnout' then 'Recorded check-ins at non-cancelled chapter meetings that have started. RSVPs and unrecorded attendance are excluded.'
    else 'Recorded cases in this chapter that your current staff role may read. Restricted or hidden cases outside that scope are excluded. Counts describe filings, not outcomes.' end;
  if local_level then explanation := pg_catalog.replace(explanation,'this chapter','your local');
    explanation := pg_catalog.replace(explanation,'chapter meetings','authorized meetings in your local'); end if;
  if spec ? 'unitID' then explanation := 'Unit: ' || (select u.name || ' · ' || c.name
    from private.chapter_units u join public.chapters c on c.id = u.chapter_id and c.organization_id = org
    where u.organization_id = org and u.id = (spec->>'unitID')::uuid) || '. ' || explanation; end if;
  if spec ? 'caseType' then explanation := 'Case type: ' || (spec->>'caseType') || '. ' || explanation; end if;
  if spec ? 'unitID' or spec->>'breakdown' = 'unit' then
    explanation := explanation || ' Units use current workplace details shared with administrators; private or unmatched details remain unassigned.';
  end if;
  with source as materialized (
    select p.user_id, p.joined_at as at, ''::text as meeting, ''::text as kind, a.chapter_id as chapter
    from public.digital_action_participants p join public.digital_actions a on a.id = p.action_id and a.organization_id = p.organization_id
    where measure in ('my_actions','published_actions') and p.organization_id = org and p.joined_at >= first_month and p.joined_at <= pg_catalog.now()
      and (case when measure = 'my_actions' then p.user_id = auth.uid()
        else (a.chapter_id = p_chapter or local_level) and a.status in ('published','closed') end)
    union all
    select ch.user_id, e.starts_at, e.id, ''::text, e.chapter_id
    from public.member_event_checkins ch join public.member_events e on e.id = ch.event_id
    join public.chapters event_chapter on event_chapter.id = e.chapter_id
    where measure = 'meeting_turnout' and event_chapter.organization_id = org and (e.chapter_id = p_chapter or local_level)
      and e.event_kind = 'meeting' and e.cancelled_at is null and e.starts_at >= first_month and e.starts_at <= pg_catalog.now()
      and private.member_can_access_event_scope(e.chapter_id,e.is_public,e.is_public_across_agencies)
    union all
    select c.user_id, c.created_at, ''::text, case when c.case_type in ('Discipline','Scheduling','Telework','Safety','Pay') then c.case_type else 'Other' end, c.chapter_id
    from public.member_cases c
    where measure = 'visible_cases' and c.organization_id = org and (c.chapter_id = p_chapter or local_level)
      and c.created_at >= first_month and c.created_at <= pg_catalog.now() and private.casework_staff_can_access(c.id)
      and (p_hat <> 'steward' or c.user_id in (select private.staff_visible_member_ids('steward')))
  ), attributed as materialized (
    select s.*, pg_catalog.date_trunc('month',s.at at time zone 'America/New_York') as month,
      coalesce(u.id::text,'unassigned') as unit,
      coalesce(u.name,'Unassigned unit') || case when local_level then ' · ' || coalesce(chapter.name,'Organization-wide') else '' end as unit_name
    from source s
    left join public.member_profile_details d on d.user_id = s.user_id and d.details_visibility = 'admins' and p_hat = 'admin'
    left join private.chapter_units u on u.organization_id = org and u.chapter_id = s.chapter and u.name = d.worksite
    left join public.chapters chapter on chapter.id = s.chapter and chapter.organization_id = org
  ), cells as (
    select month, meeting, kind, unit, chapter, pg_catalog.count(distinct user_id) as people
    from attributed group by month, meeting, kind, unit, chapter
  ), selected as (
    select case spec->>'breakdown' when 'unit' then a.unit_name when 'meeting' then a.meeting else pg_catalog.to_char(a.month,'YYYY-MM') end as label,
      pg_catalog.count(*)::integer as value
    from attributed a where a.at >= selected_month
      and (not (spec ? 'unitID') or a.unit = spec->>'unitID') and (not (spec ? 'caseType') or a.kind = spec->>'caseType')
    group by 1
  ), plotted as (
    select label,value from selected where spec->>'breakdown' <> 'month'
    union all
    select pg_catalog.to_char(m.month,'YYYY-MM'),coalesce(s.value,0)
    from pg_catalog.generate_series(
      pg_catalog.date_trunc('month',selected_month at time zone 'America/New_York'),
      pg_catalog.date_trunc('month',pg_catalog.now() at time zone 'America/New_York'),interval '1 month') m(month)
    left join selected s on s.label = pg_catalog.to_char(m.month,'YYYY-MM')
    where spec->>'breakdown' = 'month'
  )
  select coalesce((select pg_catalog.bool_and(people >= privacy_floor) from cells),true),
    coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('label',label,'value',value) order by label) from plotted),'[]'::jsonb)
    into safe, rows;
  return pg_catalog.jsonb_build_object('rows',case when safe or measure = 'my_actions' then rows else '[]'::jsonb end,
    'withheld',not safe and measure <> 'my_actions','privacyFloor',privacy_floor,'person',measure = 'my_actions',
    'countedFrom',explanation,'period',spec->>'period','form',spec->>'form');
end;
$function$;

create function public.preview_pulse_chart(p_spec jsonb, p_hat text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph_read();
  if not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  return private.pulse_chart_values(p_spec,p_hat,private.current_member_chapter());
end;
$function$;

create function public.save_pulse_chart(p_id uuid, p_title text, p_spec jsonb, p_scope text, p_pinned boolean, p_home boolean, p_hat text)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare org uuid; chapter text; checked jsonb; result uuid;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  org := private.pulse_chart_context(p_hat);
  chapter := private.current_member_chapter();
  checked := private.pulse_chart_spec(p_spec,p_hat,chapter);
  if p_scope is null or p_scope not in ('personal','chapter','organization')
    or (checked->>'measure' = 'my_actions' and p_scope <> 'personal') or (p_scope = 'organization' and p_hat = 'member') then
    raise exception 'chart cannot be shared in that scope' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pulse-charts:' || auth.uid()::text,0));
  delete from private.pulse_saved_charts where owner_id = auth.uid() and organization_id = org
    and deleted_at <= pg_catalog.now() - interval '30 seconds';
  if p_id is null then
    if (select pg_catalog.count(*) from private.pulse_saved_charts where owner_id = auth.uid() and deleted_at is null) >= 30 then
      raise exception 'chart limit reached' using errcode = '22023';
    end if;
    insert into private.pulse_saved_charts(organization_id,chapter_id,owner_id,title,spec,scope,pinned,home)
      values(org,chapter,auth.uid(),pg_catalog.btrim(p_title),checked,p_scope,coalesce(p_pinned,false),coalesce(p_pinned,false) and coalesce(p_home,false)) returning id into result;
  else
    update private.pulse_saved_charts set title = pg_catalog.btrim(p_title),spec = checked,scope = p_scope,
      pinned = coalesce(p_pinned,false), home = coalesce(p_pinned,false) and coalesce(p_home,false), updated_at = pg_catalog.now()
    where id = p_id and owner_id = auth.uid() and organization_id = org and chapter_id = chapter and deleted_at is null returning id into result;
    if result is null then raise exception 'chart unavailable' using errcode = '42501'; end if;
  end if;
  return result;
end;
$function$;

create function public.remove_pulse_chart(p_id uuid, p_undo boolean default false)
returns void language plpgsql security definer set search_path = '' as $function$
declare org uuid;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  org := private.pulse_chart_context('member');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pulse-charts:' || auth.uid()::text,0));
  if p_undo and (select pg_catalog.count(*) from private.pulse_saved_charts where owner_id = auth.uid() and deleted_at is null) >= 30 then
    raise exception 'chart limit reached' using errcode = '22023';
  end if;
  update private.pulse_saved_charts set deleted_at = case when p_undo then null else pg_catalog.now() end,
    updated_at = pg_catalog.now()
  where id = p_id and owner_id = auth.uid() and organization_id = org
    and ((p_undo and deleted_at > pg_catalog.now() - interval '30 seconds') or (not p_undo and deleted_at is null));
  if not found then raise exception 'chart unavailable or undo expired' using errcode = '42501'; end if;
end;
$function$;

create function public.read_pulse_chart(p_id uuid, p_hat text, p_export boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare org uuid; chart private.pulse_saved_charts%rowtype; figures jsonb;
begin
  perform private.lock_case_graph_read();
  if not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  org := private.pulse_chart_context(p_hat);
  select * into chart from private.pulse_saved_charts c where c.id = p_id and c.organization_id = org and c.deleted_at is null
    and private.pulse_chart_readable(c.owner_id,c.organization_id,c.chapter_id,c.scope);
  if not found then raise exception 'chart unavailable' using errcode = '42501'; end if;
  if p_export and (chart.spec->>'measure' = 'my_actions' or chart.scope = 'personal') then
    raise exception 'personal charts cannot be shared' using errcode = '42501';
  end if;
  figures := private.pulse_chart_values(chart.spec,p_hat,chart.chapter_id);
  return pg_catalog.jsonb_build_object('id',chart.id,'title',chart.title,'spec',chart.spec,'scope',chart.scope,
    'pinned',chart.pinned,'home',chart.home,'owned',chart.owner_id = auth.uid(),'figures',figures);
end;
$function$;

create function public.list_pulse_charts(p_hat text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare org uuid; chart record; result jsonb := '[]'::jsonb;
begin
  perform private.lock_case_graph_read();
  if not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  org := private.pulse_chart_context(p_hat);
  for chart in select c.id from private.pulse_saved_charts c where c.owner_id = auth.uid()
    and c.organization_id = org and c.chapter_id = private.current_member_chapter() and c.deleted_at is null
    order by c.pinned desc,c.created_at,c.id limit 30 loop
    begin result := result || pg_catalog.jsonb_build_array(public.read_pulse_chart(chart.id,p_hat));
    exception when insufficient_privilege or invalid_parameter_value then
      -- An old staff spec is unavailable after a role revocation, but remains
      -- removable by its owner; no previously fetched figures are returned.
      result := result || (select pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',c.id,'title',c.title,'spec',c.spec,'scope',c.scope,'pinned',c.pinned,'home',c.home,'owned',true,'unavailable',true)) from private.pulse_saved_charts c where c.id = chart.id);
    end;
  end loop;
  return result;
end;
$function$;

-- Use today's message writers and chapter-space boundary. The marker holds
-- only an opaque chart id; recipients never inherit the sender's authority.
create function public.share_pulse_chart(p_id uuid, p_hat text, p_kind text, p_target uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare chart jsonb; body text; source uuid;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  chart := public.read_pulse_chart(p_id,p_hat,true);
  if chart->>'owned' <> 'true' or chart->'figures'->>'locked' = 'true' then
    raise exception 'chart cannot be shared' using errcode = '42501';
  end if;
  body := '[pulse-chart:' || p_id::text || ']';
  if p_kind = 'chapter' then
    if chart->>'scope' <> 'chapter' or not exists (
      select 1 from public.chapter_threads t join public.chapter_spaces s on s.id = t.space_id
      where t.id = p_target and t.status = 'open' and t.chapter_id = private.current_member_chapter()
        and private.can_read_chapter_space(s) is true) then
      raise exception 'chart destination unavailable' using errcode = '42501';
    end if;
    perform private.message_action_admit();
    insert into public.chapter_thread_posts(thread_id,body) values(p_target,body);
  elsif p_kind = 'message' then
    if private.can_actor_send_private_message(auth.uid(),p_target,'member') then
      perform public.send_member_message(p_target,body);
    else
      select m.id into source from public.member_messages m where m.conversation_id = p_target
        and m.redacted_at is null and private.current_actor_can_read_message_source('private',m.id,null,null)
        order by m.created_at desc,m.id desc limit 1;
      if source is null then raise exception 'chart destination unavailable' using errcode = '42501'; end if;
      perform public.reply_to_member_message('private',source,body);
    end if;
  else raise exception 'invalid destination' using errcode = '22023'; end if;
end;
$function$;

create function public.pulse_chart_options(p_hat text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare org uuid;
begin
  perform private.lock_case_graph_read();
  if not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  org := private.pulse_chart_context(p_hat);
  return pg_catalog.jsonb_build_object('levels',case when p_hat <> 'member' and private.has_organization_role(org,array[p_hat])
      then pg_catalog.jsonb_build_array('chapter','local') else pg_catalog.jsonb_build_array('chapter') end,
    'measures',case when p_hat = 'member'
    then pg_catalog.jsonb_build_array('my_actions','published_actions','meeting_turnout')
    else pg_catalog.jsonb_build_array('my_actions','published_actions','meeting_turnout','visible_cases') end,
    'units',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',u.id,'name',u.name || ' · ' || chapter.name,
        'current',u.chapter_id = private.current_member_chapter()) order by chapter.name,u.name,u.id)
      from private.chapter_units u join public.chapters chapter on chapter.id = u.chapter_id and chapter.organization_id = org
      where p_hat = 'admin' and u.organization_id = org and (u.chapter_id = private.current_member_chapter()
        or private.has_organization_role(org,array['admin']))),'[]'::jsonb));
end;
$function$;

revoke all on function private.pulse_chart_context(text) from public,anon,authenticated,service_role;
revoke all on function private.pulse_chart_readable(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function private.pulse_chart_readable(uuid,uuid,text,text) to authenticated;
revoke all on function private.pulse_chart_spec(jsonb,text,text) from public,anon,authenticated,service_role;
revoke all on function private.pulse_chart_values(jsonb,text,text) from public,anon,authenticated,service_role;
revoke all on function public.preview_pulse_chart(jsonb,text) from public,anon,authenticated,service_role;
revoke all on function public.save_pulse_chart(uuid,text,jsonb,text,boolean,boolean,text) from public,anon,authenticated,service_role;
revoke all on function public.remove_pulse_chart(uuid,boolean) from public,anon,authenticated,service_role;
revoke all on function public.read_pulse_chart(uuid,text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.list_pulse_charts(text) from public,anon,authenticated,service_role;
revoke all on function public.share_pulse_chart(uuid,text,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.pulse_chart_options(text) from public,anon,authenticated,service_role;
grant execute on function public.preview_pulse_chart(jsonb,text), public.save_pulse_chart(uuid,text,jsonb,text,boolean,boolean,text),
  public.remove_pulse_chart(uuid,boolean),public.read_pulse_chart(uuid,text,boolean),public.list_pulse_charts(text),
  public.share_pulse_chart(uuid,text,text,uuid),public.pulse_chart_options(text) to authenticated;

comment on table private.pulse_saved_charts is '#6692: platform-neutral chart specs, scope and owner pins. No figure cache or analytics identifiers. Deleted charts disappear immediately; owners may undo for thirty seconds. Account deletion cascades.';

insert into private.account_lifecycle_manifest
 (schema_name,table_name,user_column,delete_disposition,export_disposition,export_projection,export_inventory_basis,export_projection_version,export_domain,export_columns,exclusion_reason,note,reviewed_at)
values ('private','pulse_saved_charts','owner_id','cascade','included','additional_domains','auth_user_fk',1,'additionalDomains.pulse_saved_charts',
 array['id','owner_id','organization_id','chapter_id','title','spec','scope','pinned','home','deleted_at','created_at','updated_at']::text[],null,
 'Caller-authored chart specs and pin preferences; account deletion cascades. Figures are recomputed and never stored.',date '2026-11-01');

create function private.account_lifecycle_export_pulse_saved_charts(p_caller uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
 'id',c.id,'owner_id',c.owner_id,'organization_id',c.organization_id,'chapter_id',c.chapter_id,'title',c.title,
 'spec',c.spec,'scope',c.scope,'pinned',c.pinned,'home',c.home,'deleted_at',c.deleted_at,'created_at',c.created_at,'updated_at',c.updated_at)
 order by c.created_at,c.id),'[]'::jsonb) from private.pulse_saved_charts c where c.owner_id = p_caller;
$function$;
revoke all on function private.account_lifecycle_export_pulse_saved_charts(uuid) from public,anon,authenticated,service_role;
create or replace function private.account_lifecycle_export_additional_domains(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'pulse_saved_charts', private.account_lifecycle_export_pulse_saved_charts(p_caller), 'chapter_bid_entries', private.account_lifecycle_export_chapter_bid_entries(p_caller), 'chapter_seniority_entries', private.account_lifecycle_export_chapter_seniority_entries(p_caller), 'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_space_notification_settings', private.account_lifecycle_export_chapter_space_notification_settings(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_event_contact_links', private.account_lifecycle_export_member_event_contact_links(p_caller), 'member_event_contact_opt_ins', private.account_lifecycle_export_member_event_contact_opt_ins(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_profile_details', private.account_lifecycle_export_member_profile_details(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller), 'steward_contact_preferences', private.account_lifecycle_export_steward_contact_preferences(p_caller), 'steward_private_reminders', private.account_lifecycle_export_steward_private_reminders(p_caller), 'compass_training_member_consents', private.account_lifecycle_export_compass_training_member_consents(p_caller), 'compass_training_samples', private.account_lifecycle_export_compass_training_samples(p_caller)
  )
  || pg_catalog.jsonb_build_object(
    'member_capacity_commitments', private.account_lifecycle_export_member_capacity_commitments(p_caller), 'member_learning_assignments', private.account_lifecycle_export_member_learning_assignments(p_caller), 'member_membership_periods', private.account_lifecycle_export_member_membership_periods(p_caller), 'member_onboarding_steps', private.account_lifecycle_export_member_onboarding_steps(p_caller), 'member_participation_completions', private.account_lifecycle_export_member_participation_completions(p_caller), 'member_participation_events', private.account_lifecycle_export_member_participation_events(p_caller), 'member_recognition_events', private.account_lifecycle_export_member_recognition_events(p_caller)
  );
$function$;

revoke all on function private.account_lifecycle_export_additional_domains(uuid) from public, anon, authenticated, service_role;


insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
 select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface()
 where schema_name = 'private' and table_name = 'pulse_saved_charts'
 on conflict(kind,schema_name,table_name,object_name) do update set definition_hash = excluded.definition_hash;

-- Privacy 1.3.3: disclose the optional native Pulse chart PNG cache.
-- Nonmaterial functional storage; keep recorded acceptances and every other
-- instrument unchanged. The maintainers sequence this after the 1.3.2 disclosure.
do $pulse_disclosure_pack$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('private.legal_acceptance_versions(jsonb)')
      and pg_catalog.md5(p.prosrc) = 'ec858360f57ce5df346599c03f5cead9'
      and not p.prosecdef and p.provolatile = 'i'
  ) then
    raise exception 'privacy 1.3.3 requires the reviewed privacy 1.3.2 validator' using errcode = '55000';
  end if;
end;
$pulse_disclosure_pack$;

create or replace function private.legal_acceptance_versions(p_versions jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  entry record;
begin
  if p_versions is null
    or pg_catalog.jsonb_typeof(p_versions) <> 'object'
    or p_versions = '{}'::jsonb
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_versions)) > 32
  then
    raise exception 'legal versions required' using errcode = '22023';
  end if;
  for entry in select key, value from pg_catalog.jsonb_each_text(p_versions) loop
    if entry.key !~ '^[a-z][a-z0-9-]{1,62}$'
      or entry.value !~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$'
    then
      raise exception 'legal versions malformed' using errcode = '22023';
    end if;
  end loop;
  if p_versions ->> 'terms-of-use' is null then
    raise exception 'terms version required' using errcode = '22023';
  end if;
  -- published-legal-versions: generated from currentLegalVersions(); the
  -- regression test pins this database authority to the rendered pack.
  if p_versions <> '{"privacy-policy":"1.3.3","terms-of-use":"1.1.0","accessibility-statement":"1.0.0","ai-disclosure":"1.1.0","retention-schedule":"1.1.0"}'::jsonb then
    raise exception 'legal versions not current' using errcode = '22023';
  end if;
  return p_versions;
end;
$function$;

revoke all on function private.legal_acceptance_versions(jsonb)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
