-- SEC-UG-ROW-KEY-TRIGGER-BRACE-ARGUMENTS-TAKE-NO-IDENTITY-LOCK-20261028 (#6356).
-- 315 row-key gates pass catalogue foreign-key column lists such as '{user_id}'.
-- The helper split them on commas and looked up the JSON field "{user_id}", so
-- they took only the statement-level graph lock and no identity or case lock.
-- Repair (a): the helper decodes the braced form, taking the first column of
-- each braced list (the column that references the parent's id), and bounds
-- row-key acquisitions to 256 per transaction. Trigger definitions, the graph
-- lock, the telemetry and audit exceptions and every ACL stay unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessors$
begin
  if pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('private.lock_case_graph_row_keys()')))
      is distinct from 'f4c74f9b2d6a88565e5fcc7251b14437' then
    raise exception 'row-key helper predecessor changed: private.lock_case_graph_row_keys()' using errcode = '55000';
  end if;
end;
$predecessors$;

CREATE OR REPLACE FUNCTION private.lock_case_graph_row_keys()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare auth_ids uuid[]; case_ids uuid[]; row_data jsonb; column_name text; key_count integer; locks_taken text;
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
    -- An argument lists bare columns ('user_id') or catalogue foreign-key
    -- column lists ('{created_by},{case_id,organization_id,chapter_id}'). A
    -- braced list names the column that references the parent's id first.
    for column_name in select coalesce(m[1], m[2]) from pg_catalog.regexp_matches(
        coalesce(tg_argv[0], ''), '\{([^,{}]+)[^{}]*\}|([^,{}]+)', 'g') m loop
      auth_ids := pg_catalog.array_append(auth_ids, (row_data ->> column_name)::uuid);
    end loop;
    for column_name in select coalesce(m[1], m[2]) from pg_catalog.regexp_matches(
        coalesce(tg_argv[1], ''), '\{([^,{}]+)[^{}]*\}|([^,{}]+)', 'g') m loop
      case_ids := pg_catalog.array_append(case_ids, (row_data ->> column_name)::uuid);
    end loop;
  end loop;
  auth_ids := array(select distinct id from pg_catalog.unnest(auth_ids) id where id is not null);
  case_ids := array(select distinct id from pg_catalog.unnest(case_ids) id where id is not null);
  key_count := pg_catalog.cardinality(auth_ids) + pg_catalog.cardinality(case_ids);
  -- At most 256 row-key acquisitions per transaction. Every key is taken under
  -- the exclusive (509, 700) graph lock held above until commit, so past the
  -- budget a bulk statement stays serialized and only stops adding lock-table
  -- entries. A malformed or negative counter spends the budget.
  locks_taken := coalesce(pg_catalog.current_setting('private.case_graph_row_key_locks', true), '');
  if locks_taken = '' then locks_taken := '0'; end if;
  if key_count > 0 and locks_taken ~ '^[0-9]{1,6}$' and locks_taken::integer + key_count <= 256 then
    perform private.lock_case_graph(auth_ids, case_ids);
    perform pg_catalog.set_config('private.case_graph_row_key_locks', (locks_taken::integer + key_count)::text, true);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

-- Refresh only this function's reviewed hash; trigger definitions are unchanged.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface()
where kind='function' and table_name='' and schema_name='private'
  and pg_catalog.split_part(object_name,'(',1)='lock_case_graph_row_keys'
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
