-- Required before frozen F3, including after any failed batch. This restores
-- only our exact measured member-stress body; drift refuses overwrite.
-- F4 containment must still run if this step or F3 refuses.
begin;
set local lock_timeout = '3s';
do $restore_scale$
declare actual text;
begin
  select pg_catalog.encode(extensions.digest(pg_catalog.convert_to(prosrc,'UTF8'),'sha256'),'hex')
    into actual from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure('public.member_stress_remove_batch(uuid,integer,text,text)');
  if actual in ('e376e894b2bab01db67841b12dabd261919a5eab544061b7a767d8b315326b67','18a73a3a1635526ae09cbd73236b443f794a105d34e75b37091a2ffba16d2b84') then return; end if;
  if actual is distinct from '383fd8d4251f110c10ffc18d44ed1946c2d384cb77ab8538ba6a032263eedfcf' then
    raise exception 'residue scale restore source changed; refuses overwrite' using errcode='55000';
  end if;
  execute $canonical_scale$
CREATE OR REPLACE FUNCTION public.member_stress_remove_batch(p_run_id uuid, p_batch_count integer, p_target_ref text, p_confirm_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '120s'
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  run private.member_stress_runs%rowtype;
  deleted_count bigint;
  remaining bigint;
begin
  perform private.member_stress_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 5000 then raise exception 'invalid removal batch size'; end if;
  select * into run from private.member_stress_runs where id = p_run_id for update;
  if not found then raise exception 'unknown member stress run'; end if;
  if run.state = 'removed' then return jsonb_build_object('deleted', 0, 'remaining', 0, 'state', 'removed'); end if;
  if run.state <> 'removing' then raise exception 'removal preflight has not passed'; end if;

  with selected as (
    select users.id
    from auth.users users
    join private.member_stress_ledger ledger on ledger.user_id = users.id
    where ledger.run_id = p_run_id
      and lower(users.email) = ledger.email
      and users.raw_app_meta_data ->> 'member_stress_run_id' = p_run_id::text
    order by ledger.ordinal
    limit p_batch_count
  ), deleted as (
    delete from auth.users users using selected where users.id = selected.id returning users.id
  ) select count(*) into deleted_count from deleted;

  select count(*) into remaining from auth.users users
  join private.member_stress_ledger ledger on ledger.user_id = users.id where ledger.run_id = p_run_id;
  if remaining = 0 then
    if run.protected_snapshot <> private.member_stress_protected_snapshot(p_run_id) then
      raise exception 'non-stress user snapshot changed during removal';
    end if;
    -- Synthetic ballot choices carry no user_id, so the auth.users cascade
    -- cannot reach them; sweep them by run id before the run closes.
    delete from public.member_ballot_choices where stress_run_id = p_run_id;
    update private.member_stress_runs set state = 'removed', removed_at = now(), updated_at = now() where id = p_run_id;
  end if;
  return jsonb_build_object('deleted', deleted_count, 'remaining', remaining,
    'state', case when remaining = 0 then 'removed' else 'removing' end);
end;
end;
end;
$function$;
$canonical_scale$;
end;
$restore_scale$;
commit;
