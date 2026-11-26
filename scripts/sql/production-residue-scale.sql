-- Future-window addendum. NOT a migration and NOT an authorization to unlock.
-- Apply only after the exact F1/F2 sources below in a separately approved window.
-- F3/F4 restore/drop all changed functions; this adds no object or privilege.
-- Frozen October 14 artifacts remain byte-identical.
-- Run each D3 batch in its own guarded transaction, as the archived stages do.
-- Lock limits cover the whole transaction, including census and prior work;
-- another batch may refuse and roll back all work in that transaction.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';
do $source_guard$
declare r record; actual text;
begin
  for r in select * from (values
    ('private.production_residue_snapshot_accounted(jsonb,jsonb,text)', '6f4b16d8419974fd154ee2e44fafdb2435812f47d9ab8dd014d493ffb38afbe0'),
    ('public.production_residue_status()', '8cc5cd1112699d461b26e503400a2acc36962b821612f1d50171273504d7cc03'),
    ('public.member_stress_remove_batch(uuid,integer,text,text)', 'e376e894b2bab01db67841b12dabd261919a5eab544061b7a767d8b315326b67')
  ) expected(signature, digest) loop
    select pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
      into actual from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(r.signature);
    if actual is distinct from r.digest then
      raise exception 'residue scale addendum source changed or window absent: %', r.signature using errcode = '55000';
    end if;
  end loop;
end;
$source_guard$;

create or replace function private.production_residue_snapshot_accounted(p_stored jsonb, p_current jsonb, p_lane text)
returns boolean language plpgsql stable security definer set search_path = '' as $function$
begin
  if p_lane is null or p_lane not in ('uniondemo', 'member_stress')
    or pg_catalog.jsonb_typeof(p_stored) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_current) is distinct from 'array' then return false; end if;
  -- Materialize each input once. EXCEPT retains exact JSON equality while
  -- hashing the sets instead of rescanning a 30,000-account array per row.
  return (
    with stored as materialized (select value from pg_catalog.jsonb_array_elements(p_stored)),
    current_rows as materialized (select value from pg_catalog.jsonb_array_elements(p_current)),
    allowed as materialized (
      select subject_id id from private.production_residue_ledger where subject_kind = 'account'
      union
      select user_id::text from private.uniondemo_ledger
        where p_lane = 'member_stress' and run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
    ),
    missing as (select value from stored except select value from current_rows),
    added as (select value from current_rows except select value from stored)
    select not exists (select 1 from missing)
      and not exists (select 1 from current_rows where value->>'id' is null)
      and not exists (select 1 from added a where not exists (select 1 from allowed k where k.id = a.value->>'id'))
      and not exists (select 1 from current_rows group by value->>'id' having count(*) > 1)
  );
end;
$function$;

create or replace function public.production_residue_status()
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '60s' as $function$
declare result jsonb; session_counts jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'production removal requires service_role' using errcode = '42501'; end if;
  select coalesce(jsonb_object_agg(cohort, counts), '{}'::jsonb) into result from (
    select l.cohort, jsonb_build_object('ledger', count(*),
      'content_remaining', count(*) filter (where l.cohort = 'org' and l.content_removed_at is null),
      'remaining', count(*) filter (where
        (l.subject_kind = 'account' and exists (select 1 from auth.users u where u.id = (case when l.subject_kind = 'account' and length(l.subject_id) = 36 and l.subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then l.subject_id end)::uuid))
        or (l.subject_kind = 'organization' and exists (select 1 from public.organizations o where o.id = (case when l.subject_kind = 'organization' and length(l.subject_id) = 36 and l.subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then l.subject_id end)::uuid))
        or (l.subject_kind = 'chapter' and exists (select 1 from public.chapters c where c.id = l.subject_id)))) counts
    from private.production_residue_ledger l group by l.cohort
  ) x;
  -- UNION prevents double-counting a uniondemo subject if both ledgers name it.
  -- Session/token tables are each aggregated once, including empty cohorts.
  with cohorts(cohort) as (select unnest(array['uniondemo', 'account-4a', 'account-4b', 'account-kept', 'account-4c', 'account-bootstrap'])),
  subjects as materialized (
    select l.cohort, l.subject_id from private.production_residue_ledger l join cohorts c using (cohort) where l.subject_kind = 'account'
    union
    select 'uniondemo', l.user_id::text from private.uniondemo_ledger l where l.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
  ),
  sessions as (select l.cohort, count(*) n from auth.sessions s join subjects l on l.subject_id = s.user_id::text group by l.cohort),
  tokens as (select l.cohort, count(*) n from auth.refresh_tokens t join subjects l on l.subject_id = t.user_id::text group by l.cohort)
  select jsonb_object_agg(c.cohort, jsonb_build_object('sessions', coalesce(s.n,0), 'tokens', coalesce(t.n,0))) into session_counts
    from cohorts c left join sessions s using(cohort) left join tokens t using(cohort);
  return jsonb_build_object('cohorts', result, 'sessions', session_counts,
    'protected_accounts', (select count(*) from auth.users u
      where not exists (select 1 from private.production_residue_ledger l where l.subject_kind = 'account' and l.subject_id = u.id::text)
        and not exists (select 1 from private.uniondemo_ledger l where l.user_id = u.id)
        and not exists (select 1 from private.member_stress_ledger l where l.user_id = u.id)),
    'protected_organizations', (select count(*) from public.organizations o
      where not exists (select 1 from private.production_residue_ledger l where l.subject_kind = 'organization' and l.subject_id = o.id::text)),
    'accounted_uniondemo', (select private.production_residue_snapshot_accounted(r.protected_snapshot, private.uniondemo_protected_snapshot(r.id), 'uniondemo')
      from private.uniondemo_runs r where r.id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid),
    'accounted_member_stress', (select private.production_residue_snapshot_accounted(r.protected_snapshot, private.member_stress_protected_snapshot(r.id), 'member_stress')
      from private.member_stress_runs r where r.id = '6aae4c0b-856d-4fa9-a26c-ce21a1179f8d'::uuid));
end;
$function$;

-- Keep the proven delete selectors, authorization, locks and kept-data checks.
-- Only production-target calls receive the measured ceiling; never silently
-- clamp a requested batch. A different graph still needs its own rehearsal.
do $batch_bounds$
declare signature text; definition text; marker text;
  admission text := $admission$
  if p_target_ref = 'productionprojectref' then
    if p_batch_count is null or p_batch_count not between 1 and 100 then
      raise exception 'production residue batch exceeds measured 100-account limit' using errcode = '22023';
    end if;
    if pg_catalog.current_setting('max_locks_per_transaction')::integer < 64
      or pg_catalog.current_setting('max_connections')::integer < 60
      or (select count(*) from pg_catalog.pg_locks where pid = pg_catalog.pg_backend_pid()) > 2048 then
      raise exception 'production residue lock budget admission refused' using errcode = '54000';
    end if;
  end if;
  $admission$;
begin
  foreach signature in array array['public.member_stress_remove_batch(uuid,integer,text,text)'] loop
    select pg_catalog.pg_get_functiondef(signature::regprocedure) into definition;
    marker := '  if p_batch_count not between 1 and 5000 then raise exception ''invalid removal batch size''; end if;';
    if (length(definition) - length(replace(definition, marker, ''))) <> length(marker) then
      raise exception 'production residue batch source marker changed' using errcode = '55000';
    end if;
    definition := replace(definition, marker, marker || admission);
    -- Observe the actual transaction's lock footprint before returning success.
    -- Raising aborts the whole call, including Auth deletes and every FK action.
    marker := '    return residue_result;';
    definition := replace(definition, marker, $budget$
    if p_target_ref = 'productionprojectref' and
      (select count(*) from pg_catalog.pg_locks where pid = pg_catalog.pg_backend_pid()) > 4608 then
      raise exception 'production residue measured lock budget exceeded' using errcode = '54000';
    end if;
$budget$ || marker);
    execute definition;
  end loop;
end;
$batch_bounds$;
commit;
