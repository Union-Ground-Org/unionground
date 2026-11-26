-- Repair 20260810184500_admin_governance_closeout with durable tenant-bound
-- identity/status evidence. Keep the installed 20260907151000 case-graph entry
-- lock, MFA/role/chapter checks, grants and return shape. No response or request
-- content enters the ledger.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The actor FK uses ON DELETE SET NULL. Its nested referential-action UPDATE
-- must detach a deleted account without permitting edits to the audit itself.
-- Keep the installed sample-removal exception unchanged.
create or replace function private.mi1_audit_ledger_append_only()
returns trigger
language plpgsql set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE'
     and pg_catalog.pg_trigger_depth() > 1
     and old.actor_user_id is not null
     and new.actor_user_id is null
     and not exists (select 1 from auth.users where id = old.actor_user_id)
     and (pg_catalog.to_jsonb(new) - 'actor_user_id')
         is not distinct from (pg_catalog.to_jsonb(old) - 'actor_user_id') then
    return new;
  end if;
  if tg_op = 'DELETE'
     and (select auth.role()) = 'service_role'
     and old.source = 'demo_seed'
     and old.metadata ->> 'reasonCode' = 'sample-seed'
     and old.metadata ->> 'runId' = pg_catalog.current_setting('unionground.demo_seed_remove_run', true) then
    return old;
  end if;
  raise exception 'organization audit ledger is append-only' using errcode = '55000';
end;
$function$;

-- Bind only this reviewed trigger body; other catalogue drift still refuses.
update private.account_lifecycle_trigger_review
set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(
  'private.mi1_audit_ledger_append_only()'::regprocedure))
where kind = 'function' and schema_name = 'private' and table_name = ''
  and object_name = 'mi1_audit_ledger_append_only()';

do $assert_ledger_actor_review$
begin
  if not exists (
    select 1 from private.account_lifecycle_trigger_review
    where kind = 'function' and schema_name = 'private' and table_name = ''
      and object_name = 'mi1_audit_ledger_append_only()'
      and definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(
        'private.mi1_audit_ledger_append_only()'::regprocedure))
  ) then
    raise exception 'account lifecycle trigger review lost the ledger actor guard';
  end if;
end;
$assert_ledger_actor_review$;

create or replace function public.close_admin_governance_request(
  p_request_id uuid, p_status text, p_response text
) returns jsonb
language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  declare
    caller uuid := (select auth.uid());
    changed public.chapter_governance_requests%rowtype;
  begin
    if caller is null or not private.mfa_satisfied() or not public.member_has_role(array['admin']) then
      raise exception 'admin role required' using errcode = '42501';
    end if;
    if p_status not in ('reviewing', 'fulfilled', 'denied') then
      raise exception 'invalid governance status' using errcode = '22023';
    end if;
    if char_length(btrim(coalesce(p_response, ''))) not between 1 and 10000 then
      raise exception 'response must be between 1 and 10000 characters' using errcode = '22023';
    end if;
    update public.chapter_governance_requests r
       set status = p_status, response = btrim(p_response), handled_by = caller
     where r.id = p_request_id and r.chapter_id = private.current_member_chapter()
     returning r.* into changed;
    if changed.id is null then raise exception 'request unavailable' using errcode = '22023'; end if;

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, occurred_at, idempotency_key, metadata
    )
    select chapter.organization_id, 'administration', 'governance.request_closed',
      'update', caller, 'chapter', changed.chapter_id, changed.updated_at,
      extensions.gen_random_uuid(), pg_catalog.jsonb_build_object(
        'chapterId', changed.chapter_id, 'entityType', 'governance_request',
        'entityId', changed.id, 'status', changed.status
      )
    from public.chapters chapter where chapter.id = changed.chapter_id;
    if not found then
      raise exception 'governance request organization unavailable' using errcode = '42501';
    end if;
    return jsonb_build_object('id', changed.id, 'status', changed.status, 'response', changed.response, 'handledBy', changed.handled_by, 'updatedAt', changed.updated_at);
  end;
end;
$function$;

revoke all on function public.close_admin_governance_request(uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.close_admin_governance_request(uuid,text,text) to authenticated;
commit;
