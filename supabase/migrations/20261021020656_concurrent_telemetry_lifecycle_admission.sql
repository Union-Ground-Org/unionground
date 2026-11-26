-- PERF-UG-PAGE-VIEW-WRITES-TAKE-GLOBAL-LIFECYCLE-GATE-20261018.
-- Fresh telemetry shares the existing lifecycle-before-case-graph gates.
-- Deletion, retention, ordinary domain writes and all existing ACLs stay intact.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessors$
declare changed text;
begin
  select expected.signature into changed from (values
    ('public.record_workspace_page_view(text,text,uuid)', '9c28f0ccc186a2bce2e18be30bfe076f'),
    ('public.record_failed_login_attempt(text,text,text,text)', '917d7800de8b11a8b350425fe2e6705f'),
    ('public.record_member_pin_failure(text,text,text)', '72797f80cf999c1b6c183ad46d610b33'),
    ('private.lock_case_graph_statement()', '545d7813024a4b6ecbb5cf9b11706866'),
    ('private.lock_case_graph_row_keys()', '0afec45f1a71dd9184170bb2b3f2619b')
  ) expected(signature, source_md5)
  left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(expected.signature)
  where pg_catalog.md5(p.prosrc) is distinct from expected.source_md5 limit 1;
  if changed is not null then
    raise exception 'telemetry admission predecessor changed: %', changed using errcode='55000';
  end if;
end;
$predecessors$;

-- This marker is a granted transaction lock, not a caller-controlled setting.
-- Inspect all three shared locks in one snapshot; an ordinary reader cannot
-- select the new table exceptions merely by holding the two read gates.
create function private.lifecycle_telemetry_admitted()
returns boolean language sql volatile security definer set search_path = ''
as $function$
  select coalesce(pg_catalog.bool_or(l.objsubid=1
      and l.classid=((pg_catalog.hashtextextended('message-lifecycle-global',0)>>32)&4294967295)::oid
      and l.objid=(pg_catalog.hashtextextended('message-lifecycle-global',0)&4294967295)::oid),false)
    and coalesce(pg_catalog.bool_or(l.objsubid=2 and l.classid=509 and l.objid=700),false)
    and coalesce(pg_catalog.bool_or(l.objsubid=1
      and l.classid=((pg_catalog.hashtextextended('lifecycle-telemetry-append',509)>>32)&4294967295)::oid
      and l.objid=(pg_catalog.hashtextextended('lifecycle-telemetry-append',509)&4294967295)::oid),false)
  from pg_catalog.pg_locks l
  where l.pid=pg_catalog.pg_backend_pid() and l.locktype='advisory' and l.granted and l.mode='ShareLock';
$function$;
revoke all on function private.lifecycle_telemetry_admitted() from public, anon, authenticated, service_role;

create function private.lock_lifecycle_telemetry(p_rate_subject uuid default null, p_retention_email text default null,
  p_failure_method text default 'password', p_failure_subject uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare selected_subject uuid; selected_org uuid; retention_days integer;
  previous_lock_timeout text; exclusive_admission boolean := false;
begin
  -- The exception block is a subtransaction. If retention is needed, roll
  -- back ONLY its provisional shared admission before joining the existing
  -- exclusive writer queue, then resolve again under that exclusive gate.
  -- An enclosing reader keeps its own locks and the existing 40001 upgrade rule.
  loop
    begin
      if exclusive_admission then
        perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
      else
        perform private.lock_case_graph_read();
      end if;
      if p_retention_email is not null then
        -- PIN verification selects the oldest live identity. Password Auth
        -- prefers an ordinary account; passkeys supply the resolved user id.
        -- Never replace a supplied passkey identity with an email sibling.
        select u.id,case when m.user_id is not null then c.organization_id end
        into selected_subject,selected_org
        from auth.users u
        left join public.member_profiles p on p.id=u.id
        left join public.chapters c on c.id=p.chapter_id and c.organization_id is not null
        left join public.organization_memberships m on m.organization_id=c.organization_id
          and m.user_id=p.id and m.status='active'
        where pg_catalog.lower(u.email)=pg_catalog.lower(pg_catalog.btrim(coalesce(p_retention_email,'')))
          and u.deleted_at is null
          and (p_failure_subject is null or u.id=p_failure_subject)
          -- Legacy email-only passkey callers may log an unambiguous live
          -- identity; ambiguity is not permission to select another account.
          and (p_failure_method<>'passkey' or p_failure_subject is not null or
            (select pg_catalog.count(*) from auth.users sibling
             where pg_catalog.lower(sibling.email)=pg_catalog.lower(u.email)
               and sibling.deleted_at is null)=1)
        order by case when p_failure_method='pin' then null else u.is_sso_user end,
          u.created_at,u.id limit 1;
      end if;
      if not exclusive_admission and selected_org is not null then
        select coalesce((v.value #>> '{}')::integer,(d.default_value #>> '{}')::integer)
        into retention_days from public.platform_setting_definitions d
        left join public.organization_setting_values v on v.organization_id=selected_org and v.setting_key=d.key
        where d.key='security.failed_login_retention_days';
        if exists (select 1 from public.organization_failed_login_attempts a
          where a.organization_id=selected_org
            and a.occurred_at<pg_catalog.now()-pg_catalog.make_interval(days=>coalesce(retention_days,90))) then
          raise exception 'telemetry retention needs exclusive admission' using errcode='UG001';
        end if;
      end if;
      if not exclusive_admission then
        perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('lifecycle-telemetry-append',509));
      end if;
      if p_rate_subject is not null then
        -- Only this member's page views serialize. Count-and-insert must remain
        -- atomic across distinct page keys and concurrent sessions of that member.
        previous_lock_timeout := pg_catalog.current_setting('lock_timeout');
        if previous_lock_timeout::interval=interval '0 seconds' or previous_lock_timeout::interval>interval '3 seconds' then
          perform pg_catalog.set_config('lock_timeout','3s',true);
        end if;
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('telemetry-page-rate:'||p_rate_subject::text,509));
        perform pg_catalog.set_config('lock_timeout',previous_lock_timeout,true);
      end if;
      return pg_catalog.jsonb_build_object('subject',selected_subject,'organization',selected_org);
    exception when sqlstate 'UG001' then
      -- The next iteration resolves one current snapshot after the exclusive
      -- gate is held; no identity from the released read interval is reused.
      exclusive_admission := true;
    end;
  end loop;
  -- Make the terminal failure explicit to the compiler's conservative loop
  -- analysis; every successful iteration returns its protected snapshot above.
  raise exception 'telemetry lifecycle admission ended unexpectedly' using errcode='55000';
end;
$function$;
revoke all on function private.lock_lifecycle_telemetry(uuid,text,text,uuid) from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_workspace_page_view(p_page text, p_hat text DEFAULT 'member'::text, p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_lifecycle_telemetry(auth.uid(), null);
declare
  caller uuid := (select auth.uid());
  org uuid := private.engagement_selected_organization();
  moment timestamptz := pg_catalog.now();
  page_key text := pg_catalog.btrim(coalesce(p_page, ''));
  recorded_hat text := 'member';
  minute_key text := pg_catalog.to_char(moment at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI');
  recent integer;
  inserted boolean := false;
begin
  if caller is null or org is null or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if p_organization_id is not null and p_organization_id is distinct from org then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_catalog.char_length(page_key) < 1 or pg_catalog.char_length(page_key) > 100
     or page_key !~ '^/[A-Za-z0-9/_.:-]*$' then
    raise exception 'invalid page key' using errcode = '22023';
  end if;
  if p_hat in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
     and private.has_organization_role(org, array[p_hat]) then
    recorded_hat := p_hat;
  end if;

  select pg_catalog.count(*) into recent
  from public.organization_engagement_events e
  where e.user_id = caller and e.event_type = 'page_view'
    and e.occurred_at >= moment - interval '1 minute';
  if recent >= 30 then
    return pg_catalog.jsonb_build_object('recorded', false, 'refusal', 'rate-limited');
  end if;

  insert into public.organization_engagement_events
    (organization_id, user_id, chapter_id, event_type, source_id, occurred_at)
  values (org, caller, private.current_member_chapter(), 'page_view', page_key || '|' || minute_key, moment)
  on conflict (organization_id, user_id, event_type, source_id) do nothing;
  inserted := found;
  if inserted then
    insert into public.organization_page_views (organization_id, path, hat, day, view_count)
    values (org, page_key, recorded_hat, (moment at time zone 'UTC')::date, 1)
    on conflict (organization_id, path, hat, day) do update
      set view_count = public.organization_page_views.view_count + 1;
  end if;
  return pg_catalog.jsonb_build_object('recorded', inserted);
end;
end;
$function$;


-- Replace the four-argument signature rather than creating an ambiguous
-- PostgREST overload. Its existing calls bind through the optional argument.
drop function public.record_failed_login_attempt(text,text,text,text);
CREATE FUNCTION public.record_failed_login_attempt(p_email text, p_method text, p_source text, p_user_agent text, p_subject uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
declare
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  safe_agent text := pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_user_agent, 'Unknown client')), '[[:cntrl:]]+', ' ', 'g'), 160);
  subject uuid;
  org_id uuid;
  inserted_id uuid;
  retention_days integer := 90;
  admission jsonb;
begin
  admission := private.lock_lifecycle_telemetry(null, p_email, p_method, p_subject);
  subject := (admission->>'subject')::uuid;
  org_id := (admission->>'organization')::uuid;
  if (select auth.role()) <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_method not in ('password', 'passkey') or p_source not in ('web-saas', 'web-sample', 'native-ios', 'native-android') then
    raise exception 'invalid login failure metadata' using errcode = '22023';
  end if;
  if subject is null then return null; end if;
  if org_id is null then return null; end if;

  insert into public.organization_failed_login_attempts
    (organization_id, member_user_id, identity_hash, method, source, user_agent)
  values (
    org_id, subject,
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to(normalized_email, 'UTF8'), 'sha256'), 'hex'),
    p_method, p_source, coalesce(nullif(safe_agent, ''), 'Unknown client')
  ) returning id into inserted_id;

  select coalesce((v.value #>> '{}')::integer, (d.default_value #>> '{}')::integer)
  into retention_days
  from public.platform_setting_definitions d
  left join public.organization_setting_values v on v.organization_id = org_id and v.setting_key = d.key
  where d.key = 'security.failed_login_retention_days';
  if exists (select 1 from public.organization_failed_login_attempts where organization_id=org_id and occurred_at<pg_catalog.now() - pg_catalog.make_interval(days => retention_days)) then
  delete from public.organization_failed_login_attempts
  where organization_id = org_id and occurred_at < pg_catalog.now() - pg_catalog.make_interval(days => retention_days);
  end if;
  return inserted_id;
end;
end;
$function$;
revoke all on function public.record_failed_login_attempt(text,text,text,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.record_failed_login_attempt(text,text,text,text,uuid) to service_role;


CREATE OR REPLACE FUNCTION public.record_member_pin_failure(p_email text, p_source text, p_user_agent text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  normalized_email text;
  safe_agent text;
  subject uuid;
  org_id uuid;
  inserted_id uuid;
  retention_days integer;
  admission jsonb;
begin
  admission := private.lock_lifecycle_telemetry(null, p_email, 'pin');
  subject := (admission->>'subject')::uuid;
  org_id := (admission->>'organization')::uuid;
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_source not in ('web-saas', 'web-sample', 'native-ios', 'native-android') then
    raise exception 'invalid login failure metadata' using errcode = '22023';
  end if;
  normalized_email := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  safe_agent := pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_user_agent, 'Unknown client')), '[[:cntrl:]]+', ' ', 'g'), 160);
  if subject is null then
    return null;
  end if;
  if org_id is null then
    return null;
  end if;
  insert into public.organization_failed_login_attempts
    (organization_id, member_user_id, identity_hash, method, source, user_agent)
  values (
    org_id, subject,
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to(normalized_email, 'UTF8'), 'sha256'), 'hex'),
    'pin', p_source, coalesce(nullif(safe_agent, ''), 'Unknown client')
  ) returning id into inserted_id;
  select coalesce((v.value #>> '{}')::integer, (d.default_value #>> '{}')::integer)
  into retention_days
  from public.platform_setting_definitions d
  left join public.organization_setting_values v on v.organization_id = org_id and v.setting_key = d.key
  where d.key = 'security.failed_login_retention_days';
  if exists (select 1 from public.organization_failed_login_attempts where organization_id=org_id and occurred_at<pg_catalog.now() - pg_catalog.make_interval(days => coalesce(retention_days, 90))) then
  delete from public.organization_failed_login_attempts
  where organization_id = org_id
    and occurred_at < pg_catalog.now() - pg_catalog.make_interval(days => coalesce(retention_days, 90));
  end if;
  return inserted_id;
end;
$function$;


CREATE OR REPLACE FUNCTION private.lock_case_graph_statement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'INSERT' and tg_table_schema = 'public'
     and tg_table_name in ('organization_audit_events', 'organization_network_access_events')
     and private.lifecycle_read_admitted() then
    return null;
  end if;
  if tg_table_schema='public' and (
      (tg_op='INSERT' and tg_table_name in ('organization_engagement_events','organization_page_views','organization_failed_login_attempts'))
      or (tg_op='UPDATE' and tg_table_name='organization_page_views'))
      and private.lifecycle_telemetry_admitted() then
    return null;
  end if;
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  return null;
end;
$function$;


CREATE OR REPLACE FUNCTION private.lock_case_graph_row_keys()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare auth_ids uuid[]; case_ids uuid[]; row_data jsonb; column_name text;
begin
  if tg_op = 'INSERT' and tg_table_schema = 'public'
     and tg_table_name in ('organization_audit_events', 'organization_network_access_events')
     and private.lifecycle_read_admitted() then
    return new;
  end if;
  if tg_table_schema='public' and tg_op in ('INSERT','UPDATE')
      and tg_table_name in ('organization_engagement_events','organization_page_views','organization_failed_login_attempts')
      and private.lifecycle_telemetry_admitted() then
    row_data := pg_catalog.to_jsonb(new);
    if tg_op='INSERT' and tg_table_name='organization_engagement_events'
        and row_data->>'event_type'='page_view' and row_data->>'user_id'=auth.uid()::text
        and (row_data->>'occurred_at')::timestamptz=pg_catalog.now() then
      return new;
    elsif tg_op='INSERT' and tg_table_name='organization_failed_login_attempts'
        and (select auth.role())='service_role' and row_data->>'member_user_id' is not null
        and row_data->>'status'='open' and row_data->>'reviewed_by' is null
        and row_data->>'reviewed_at' is null and row_data->>'disposition_note' is null
        and (row_data->>'occurred_at')::timestamptz=pg_catalog.now() then
      return new;
    elsif tg_table_name='organization_page_views' and auth.uid() is not null then
      if tg_op='INSERT' and (row_data->>'view_count')::bigint=1 then return new; end if;
      if tg_op='UPDATE' and (row_data-'view_count') is not distinct from (pg_catalog.to_jsonb(old)-'view_count')
          and (row_data->>'view_count')::bigint=(pg_catalog.to_jsonb(old)->>'view_count')::bigint+1 then return new; end if;
    end if;
  end if;
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  auth_ids := array[]::uuid[];
  case_ids := array[]::uuid[];
  for row_data in select value from pg_catalog.jsonb_array_elements(
    pg_catalog.jsonb_build_array(case when tg_op <> 'INSERT' then pg_catalog.to_jsonb(old) end,
      case when tg_op <> 'DELETE' then pg_catalog.to_jsonb(new) end)) loop
    foreach column_name in array pg_catalog.string_to_array(tg_argv[0], ',') loop
      auth_ids := pg_catalog.array_append(auth_ids, (row_data ->> column_name)::uuid);
    end loop;
    foreach column_name in array pg_catalog.string_to_array(tg_argv[1], ',') loop
      case_ids := pg_catalog.array_append(case_ids, (row_data ->> column_name)::uuid);
    end loop;
  end loop;
  perform private.lock_case_graph(auth_ids, case_ids);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

-- Refresh only changed or newly reachable functions, never trigger definitions
-- or unrelated reviewed implementations. Every other writer stays exclusive.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface()
where kind='function' and table_name='' and (
  (schema_name='private' and pg_catalog.split_part(object_name,'(',1) in
    ('lifecycle_telemetry_admitted','lock_lifecycle_telemetry','lock_case_graph_statement','lock_case_graph_row_keys'))
  or (schema_name='public' and pg_catalog.split_part(object_name,'(',1) in
    ('record_workspace_page_view','record_failed_login_attempt','record_member_pin_failure')))
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;
do $inventory$
begin
  if exists(select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger inventory differs from review';
  end if;
end;
$inventory$;
notify pgrst, 'reload schema';
commit;
