-- OPS-UG-PRODUCTION-RESIDUE-CLEANUP-EXECUTION-20260912
-- Immediate re-lock, including on any stop. Restore captured Main trigger
-- bodies byte for byte. MAIN compares production hashes before the go/no-go,
-- and the attended window compares again before installing F1.
-- Installation pins of the removed guard: productionprojectref, 7662742571317219726, database oid 5.
begin;

do $case_owner_restore_hash$
declare current_sha256 text;
begin
  current_sha256 := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.mi1_bind_case_owner()')), 'UTF8'), 'sha256'), 'hex');
  if current_sha256 is distinct from 'a0ca1edb107a57c44c488f3de3218a3d6c186314531e94283f46b8e3ab2e0933'
    and current_sha256 is distinct from 'af617c6391d5a4476a2f173e8e3e6a7bb97cb249bb31e2f5890bba8e0f615070' then
    -- Preserve an unknown repair, but never let it block emergency containment.
    -- R4's mandatory canonical comparison refuses full restoration afterward.
    raise warning 'production residue case owner source changed; preserved; full restoration failed';
  else
    execute $captured_case_owner$
-- captured Main body SHA-256: a0ca1edb107a57c44c488f3de3218a3d6c186314531e94283f46b8e3ab2e0933
CREATE OR REPLACE FUNCTION private.mi1_bind_case_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  owner_organization uuid;
  owner_chapter text;
begin
  if tg_op = 'UPDATE' then
    if old.organization_id is null then
      if new.organization_id is not null or new.chapter_id is not null then
        raise exception 'legacy case ownership requires an explicit backfill' using errcode = '42501';
      end if;
      return new;
    else
      if new.organization_id is distinct from old.organization_id
         or new.chapter_id is distinct from old.chapter_id then
        raise exception 'case organization and chapter are immutable' using errcode = '42501';
      end if;
      return new;
    end if;
  end if;

  select ch.organization_id, ch.id
  into owner_organization, owner_chapter
  from public.member_profiles p
  join public.chapters ch on ch.id = p.chapter_id
  where p.id = new.user_id;

  if owner_chapter is null then
    raise exception 'case owner requires a current organization chapter' using errcode = '23514';
  end if;
  if owner_organization is null then
    if new.organization_id is not null or new.chapter_id is not null then
      raise exception 'legacy case ownership cannot be supplied by the caller' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.organization_id is not null and new.organization_id is distinct from owner_organization then
    raise exception 'case organization is derived from the member chapter' using errcode = '42501';
  end if;
  if new.chapter_id is not null and new.chapter_id is distinct from owner_chapter then
    raise exception 'case chapter is derived from the member profile' using errcode = '42501';
  end if;

  new.organization_id := owner_organization;
  new.chapter_id := owner_chapter;
  return new;
end;
$function$
$captured_case_owner$;
  end if;
end;
$case_owner_restore_hash$;

-- captured Main body SHA-256: bd18a57d8212da747472de6ee2d63c29e389e03fdf62a1e40f0b6c0e494cdff2
CREATE OR REPLACE FUNCTION private.forbid_organization_audit_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  raise exception 'organization audit events are append-only' using errcode = '55000';
end;
$function$
;

-- captured Main body SHA-256: d4c46a480061b5ed065f5c6ef1f06c6b7a25a535fb783b165e1e472a128d6adc
CREATE OR REPLACE FUNCTION private.mi1_audit_ledger_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE'
     and (select auth.role()) = 'service_role'
     and old.source = 'demo_seed'
     and old.metadata ->> 'reasonCode' = 'sample-seed'
     and old.metadata ->> 'runId' = pg_catalog.current_setting('unionground.demo_seed_remove_run', true) then
    return old;
  end if;
  raise exception 'organization audit ledger is append-only' using errcode = '55000';
end;
$function$
;

drop function public.production_residue_status();
drop function public.production_residue_remove_batch(text, integer, text, text);
drop function public.production_residue_revoke_sessions(text, text, text);
drop function public.production_residue_fill_ledger(text, text);
drop function private.production_residue_check_references(uuid, boolean);
drop function private.production_residue_authorize(text, text, text, text);
drop function private.production_residue_snapshot_accounted(jsonb, jsonb, text);
drop trigger production_residue_stamp_window on private.production_residue_windows;
drop function private.production_residue_stamp_window();
drop table private.production_residue_audit_context;
drop table private.production_residue_kept_scope;
drop table private.production_residue_ledger;
drop table private.production_residue_windows;

commit;
