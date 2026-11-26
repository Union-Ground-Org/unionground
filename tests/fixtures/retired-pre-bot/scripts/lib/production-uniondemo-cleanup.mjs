import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseFunctions } from '../../../../../scripts/account-case-graph-inventory.mjs';
import { cleanupContentInvariant } from '../../../../../scripts/lib/production-cleanup-content-invariant.mjs';

export const PRODUCTION_REF = 'productionprojectref';
export const REMOVAL_RUN = '109141a8-bb29-4b02-af4f-f00ff45ba2ea';
export const REMOVAL_CONFIRMATION = 'REMOVE_PRODUCTION_UNIONDEMO_109141A8_REHEARSAL';
export const REMOVAL_OPERATIONS = Object.freeze(['knowledge-remove', 'parity-remove', 'begin-remove', 'remove-batch']);
const GUARD = 'private.uniondemo_production_removal_authorize';
const ORIGINAL_CALL = 'private.uniondemo_authorize(p_target_ref, p_confirm_token)';
const sourceFileHashes = Object.freeze({
  '20260824233000_uniondemo_org_seed.sql': '7e95cf10a0838ae3570c22a25d20b9a6a43ea26944adff9d0e169111487b22dc',
  '20260826168000_demo_seed_server_identity_guard.sql': '3aeaefb4b7b14f1655990ee6721379ed93f49541badccc0c471a5b13cbf3e2ed',
  '20260829044000_mi1_knowledge_library_sample_activation.sql': 'a54268fb81597bba8421cc93a6b176573d7d52e51fab719826809501e27b63c7',
  '20260830180000_mi1_retention_engine.sql': '5c8f75a09614e7d7ce95aac4a2d121f2ed63d21a35bac868429e4d106fe34554',
});
const definitions = Object.freeze([
  { operation: 'knowledge-remove', name: 'public.remove_mi1_knowledge_sample', signature: 'public.remove_mi1_knowledge_sample(text,uuid,text,text)', args: "'uniondemo'," },
  { operation: 'parity-remove', name: 'public.uniondemo_remove_function_parity', signature: 'public.uniondemo_remove_function_parity(uuid,text,text)', args: '' },
  { operation: 'begin-remove', name: 'public.uniondemo_begin_remove', signature: 'public.uniondemo_begin_remove(uuid,text,text)', args: '' },
  { operation: 'remove-batch', name: 'public.uniondemo_remove_batch', signature: 'public.uniondemo_remove_batch(uuid,integer,text,text)', args: '' },
]);
const digest = value => createHash('sha256').update(value).digest('hex');
const literal = value => `'${String(value).replaceAll("'", "''")}'`;

// The two transformations exactly mirror the already reviewed messaging and
// account-lifecycle migrations. Accept only those generations, never an
// operator-supplied function body or arbitrary observed catalog hash.
function messageEntry(source) {
  const inner = source.replaceAll('#variable_conflict use_variable', '');
  return (source.includes('#variable_conflict use_variable') ? '#variable_conflict use_variable\n' : '')
    + '\nbegin\n  perform private.lock_message_lifecycle();\n'
    + inner.replace(/[ \n\r\t;]+$/, '') + ';\nend;\n';
}
function caseEntry(source) {
  const directive = source.match(/^\s*#[^\n]+\n/)?.[0] || '';
  const inner = source.slice(directive.length).replace(/[\n\r\t ]+$/, '');
  return directive + '\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n'
    + inner + (inner.endsWith(';') ? '' : ';') + '\nend;\n';
}

export function reviewedCleanupSources() {
  const functions = [];
  for (const [filename, expected] of Object.entries(sourceFileHashes)) {
    const sql = readFileSync(new URL(`../../../../../supabase/migrations/${filename}`, import.meta.url), 'utf8');
    if (digest(sql) !== expected) throw new Error(`Cleanup source changed: ${filename}`);
    functions.push(...parseFunctions(sql, filename));
  }
  const sources = definitions.map(definition => {
    const original = functions.filter(entry => entry.name === definition.name).at(-1)?.source;
    if (!original || original.split(ORIGINAL_CALL).length !== 2) throw new Error('Ambiguous removal authorization source');
    const current = messageEntry(original);
    return { ...definition, sources: [current, caseEntry(current)], hashes: [digest(current), digest(caseEntry(current))] };
  });
  const guard = functions.filter(entry => entry.name === 'private.uniondemo_authorize').at(-1);
  if (!guard) throw new Error('Missing SAMPLE guard');
  return { functions: sources, sampleGuard: guard.source, sampleGuardHash: digest(guard.source) };
}

export function validateCleanupBinding(binding) {
  const required = ['project_ref', 'system_identifier', 'database_oid', 'authorization_reference', 'backup_reference'];
  if (!binding || Object.keys(binding).sort().join() !== [...required].sort().join()) throw new Error('Exact cleanup binding fields required');
  if (binding.project_ref !== PRODUCTION_REF) throw new Error('Production project mismatch');
  if (typeof binding.system_identifier !== 'string' || !/^[1-9][0-9]{0,19}$/.test(binding.system_identifier)) throw new Error('Invalid installation identity');
  if (!Number.isSafeInteger(binding.database_oid) || binding.database_oid < 1 || binding.database_oid > 4294967295) throw new Error('Invalid database identity');
  for (const key of ['authorization_reference', 'backup_reference']) {
    if (typeof binding[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(binding[key])) throw new Error(`Invalid ${key}`);
  }
  return binding;
}

// Offline SQL renderer. There is deliberately no connection, execute, COMMIT,
// target/run override, or production cleanup mode. The historical snapshot is
// incomplete, so only rollback rehearsals are available in this first kit.
export function buildCleanupRehearsalSql({ binding, operation, batchCount = 1, ...unexpected }) {
  validateCleanupBinding(binding);
  if (Object.keys(unexpected).length) throw new Error('Unknown cleanup option');
  if (!REMOVAL_OPERATIONS.includes(operation)) throw new Error('Unknown removal operation');
  if (!Number.isInteger(batchCount) || batchCount < 1 || batchCount > 2000) throw new Error('Removal batch must be 1–2000');
  if (operation !== 'remove-batch' && batchCount !== 1) throw new Error('Batch count applies only to remove-batch');
  const reviewed = reviewedCleanupSources();
  const contentInvariant = cleanupContentInvariant({ runId: REMOVAL_RUN, operation, batchCount });
  const selected = reviewed.functions.find(entry => entry.operation === operation);
  const pins = reviewed.functions.map(entry => `(${literal(entry.signature)},${literal(entry.operation)},array[${entry.hashes.map(literal).join(',')}])`).join(',\n    ');
  const callArgs = `${selected.args}${literal(REMOVAL_RUN)}::uuid,${operation === 'remove-batch' ? `${batchCount},` : ''}${literal(PRODUCTION_REF)},${literal(REMOVAL_CONFIRMATION)}`;
  return `-- ROLLBACK-ONLY REHEARSAL. Not authorization for production data removal.
-- Authorization reference: ${binding.authorization_reference}
-- Backup reference: ${binding.backup_reference}
begin isolation level read committed;
set local lock_timeout = '5s';
set local statement_timeout = '300s';
set local search_path = '';
set local row_security = off;

do $preflight$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service-role operator context required' using errcode='42501';
  end if;
  if (select system_identifier::numeric from pg_catalog.pg_control_system()) is distinct from ${binding.system_identifier}::numeric
    or (select oid from pg_catalog.pg_database where datname=current_database()) is distinct from ${binding.database_oid}::oid then
    raise exception 'reviewed production installation mismatch' using errcode='55000';
  end if;
  if exists(select 1 from private.demo_seed_installation_bindings) then
    raise exception 'SAMPLE-bound installations are refused' using errcode='55000';
  end if;
  if exists(select 1 from storage.objects) or exists(select 1 from public.organizations) then
    raise exception 'production residue scope changed' using errcode='55000';
  end if;
  if pg_catalog.to_regprocedure('${GUARD}(text,uuid,text,text)') is not null then
    raise exception 'unexpected prior cleanup installation' using errcode='55000';
  end if;
  if not exists(select 1 from pg_proc p where p.oid='private.uniondemo_authorize(text,text)'::regprocedure
    and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=${literal(reviewed.sampleGuardHash)}
    and p.proowner=(select oid from pg_roles where rolname='postgres') and p.prosecdef
    and coalesce(p.proconfig @> array['search_path=""'],false)
    and not has_function_privilege('anon',p.oid,'EXECUTE')
    and not has_function_privilege('authenticated',p.oid,'EXECUTE')
    and not has_function_privilege('service_role',p.oid,'EXECUTE')) then
    raise exception 'SAMPLE guard changed' using errcode='55000';
  end if;
end;
$preflight$;

-- All changes below are local to this transaction; other sessions never see
-- a committed unlocked function. Failure/disconnect rolls back DDL and data.
create temporary table cleanup_rehearsal_originals on commit drop as
  select p.oid, p.prosrc, pg_get_functiondef(p.oid) as definition, p.proacl,
    p.proowner, p.proconfig, p.prosecdef
  from pg_proc p where p.oid = any(array[${reviewed.functions.map(entry => `${literal(entry.signature)}::regprocedure`).join(',')}]);
create temporary table cleanup_rehearsal_sample_guard on commit drop as
  select p.oid,p.prosrc,p.proacl,p.proowner,p.proconfig,p.prosecdef
  from pg_proc p where p.oid='private.uniondemo_authorize(text,text)'::regprocedure;

create function ${GUARD}(p_operation text,p_run_id uuid,p_target_ref text,p_confirm_token text)
returns void language plpgsql security definer set search_path='' as $guard$
begin
  if (select auth.role()) is distinct from 'service_role'
    or p_operation is distinct from ${literal(operation)}
    or p_run_id is distinct from ${literal(REMOVAL_RUN)}::uuid
    or p_target_ref is distinct from ${literal(PRODUCTION_REF)}
    or p_confirm_token is distinct from ${literal(REMOVAL_CONFIRMATION)} then
    raise exception 'production removal scope refused' using errcode='42501';
  end if;
  if (select system_identifier::numeric from pg_catalog.pg_control_system()) is distinct from ${binding.system_identifier}::numeric
    or (select oid from pg_catalog.pg_database where datname=current_database()) is distinct from ${binding.database_oid}::oid then
    raise exception 'production installation changed' using errcode='55000';
  end if;
  perform 1 from private.uniondemo_runs where id=p_run_id for update;
  if not found or not exists(select 1 from private.uniondemo_runs r where r.id=p_run_id
    and r.target_ref=${literal(PRODUCTION_REF)} and r.member_count=30000
    and r.state in ('verified','removing','removed')
    and r.protected_snapshot=private.uniondemo_protected_snapshot(p_run_id)) then
    raise exception 'historical run preflight refused' using errcode='55000';
  end if;
  if (select count(*) from private.uniondemo_ledger where run_id=p_run_id) <> 30000
    or exists(select 1 from auth.users u join private.uniondemo_ledger l on l.user_id=u.id
      where l.run_id=p_run_id and (lower(u.email) is distinct from l.email
        or u.raw_app_meta_data->>'uniondemo_run_id' is distinct from p_run_id::text))
    or exists(select 1 from auth.sessions s join private.uniondemo_ledger l on l.user_id=s.user_id where l.run_id=p_run_id)
    or exists(select 1 from auth.refresh_tokens t join private.uniondemo_ledger l on l.user_id::text=t.user_id::text where l.run_id=p_run_id) then
    raise exception 'ownership or revoked-session preflight refused' using errcode='55000';
  end if;
  -- The reviewed entrypoint acquired its lifecycle gates before invoking us.
  -- Recheck here so a row committed after the outer preflight is not removed.
  perform pg_temp.cleanup_rehearsal_content_preflight();
end;
$guard$;
revoke all on function ${GUARD}(text,uuid,text,text) from public,anon,authenticated,service_role;

do $unlock$
declare pin record; routine record; changed_source text;
begin
  for pin in select * from (values
    ${pins}
  ) allowed(signature,operation,hashes) loop
    select p.* into strict routine from pg_proc p where p.oid=pin.signature::regprocedure;
    if not routine.prosecdef or routine.proowner <> (select oid from pg_roles where rolname='postgres')
      or not coalesce(routine.proconfig @> array['search_path=""'],false)
      or not (encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex')=any(pin.hashes))
      or has_function_privilege('anon',routine.oid,'EXECUTE')
      or has_function_privilege('authenticated',routine.oid,'EXECUTE')
      or not has_function_privilege('service_role',routine.oid,'EXECUTE') then
      raise exception 'removal catalog generation refused' using errcode='55000';
    end if;
    changed_source := replace(routine.prosrc,${literal(ORIGINAL_CALL)},
      '${GUARD}(' || quote_literal(pin.operation) || ',p_run_id,p_target_ref,p_confirm_token)');
    execute replace(pg_get_functiondef(routine.oid),routine.prosrc,changed_source);
  end loop;
end;
$unlock$;

${contentInvariant.before}

-- The only contemplated deletion is this exact existing RPC under its new
-- guard. Its effects are always rolled back by this packet.
select ${selected.name}(${callArgs}) as rehearsal_result;

${contentInvariant.after}

do $relock$
declare original record;
begin
  for original in select * from pg_temp.cleanup_rehearsal_originals loop
    execute original.definition;
    if not exists(select 1 from pg_proc p where p.oid=original.oid
      and p.prosrc=original.prosrc and p.proacl is not distinct from original.proacl
      and p.proowner=original.proowner and p.proconfig is not distinct from original.proconfig
      and p.prosecdef=original.prosecdef) then
      raise exception 'exact removal relock failed' using errcode='55000';
    end if;
  end loop;
  if not exists(select 1 from pg_temp.cleanup_rehearsal_sample_guard saved_guard join pg_proc p on p.oid=saved_guard.oid
    where p.prosrc=saved_guard.prosrc and p.proacl is not distinct from saved_guard.proacl
      and p.proowner=saved_guard.proowner and p.proconfig is not distinct from saved_guard.proconfig
      and p.prosecdef=saved_guard.prosecdef) then
    raise exception 'SAMPLE guard changed during rehearsal' using errcode='55000';
  end if;
end;
$relock$;
drop function ${GUARD}(text,uuid,text,text);
rollback;
`;
}
