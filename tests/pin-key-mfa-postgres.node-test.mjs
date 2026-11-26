import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {keyAssuranceMigrationUrl} from '../scripts/lib/key-assurance-delivery.mjs';
import {latestFnBody} from './helpers/migration.js';
const user='10000000-0000-4000-8000-000000000001';
const session='20000000-0000-4000-8000-000000000002';
// ghcr.io serves this exact digest; the db job is logged in there, while anonymous
// public.ecr.aws pulls hit its data limit on GitHub runners (#5872, run 39888683082).
const image='ghcr.io/supabase/postgres@sha256:28f0e16a019e648089fc1a6d333549a55548f6019c15ae4bd7cd58b989027518';
// Disposable local cluster only: no environment-provided database URL or hosted
// credential is accepted. Caller TMPDIR must point at workstation disk scratch.
test('UV key registry, hook, staff/chart boundaries and revocation on disposable PostgreSQL',async()=>{
 const name=`key-mfa-test-${process.pid}-${randomUUID().slice(0,8)}`;
 let started=false;let db;let stage='container-start';
 try{
  execFileSync('docker',['run','--detach','--rm','--name',name,'--label','net.unionground.test-fixture=key-mfa','--env','POSTGRES_PASSWORD=postgres','--publish','127.0.0.1::5432',image],{stdio:'ignore'});started=true;
  stage='container-port';
  const port=Number(execFileSync('docker',['port',name,'5432/tcp'],{encoding:'utf8'}).trim().split(':').at(-1));
  stage='database-connect';
  let connected=false;
  for(let attempt=0;attempt<90;attempt++){
   db=new pg.Client({host:'127.0.0.1',port,user:'supabase_admin',password:'postgres',database:'postgres',connectionTimeoutMillis:500});
   try{await db.connect();connected=true;break;}catch{await db.end().catch(()=>{});await new Promise(r=>setTimeout(r,500));}
  }
  assert.equal(connected,true,'isolated pinned PostgreSQL starts');
  stage='schema-setup';
  await db.query(`do $$begin
   if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;
   if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;
   if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role;end if;
   if not exists(select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin;end if;
   end$$;
   drop schema if exists auth cascade;drop schema if exists private cascade;
   create schema auth;create schema private;
   grant usage on schema auth,private,public to anon,authenticated,service_role,supabase_auth_admin;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
   create function auth.role() returns text language sql stable as $$select auth.jwt()->>'role'$$;
   create table auth.users(id uuid primary key,deleted_at timestamptz,banned_until timestamptz);
   create table auth.sessions(id uuid primary key,user_id uuid references auth.users,created_at timestamptz default now(),not_after timestamptz,aal text default 'aal1');
   create table auth.mfa_amr_claims(session_id uuid references auth.sessions on delete cascade,authentication_method text);
   create table auth.mfa_factors(user_id uuid,status text,factor_type text);
   create table private.member_mfa_reset_boundaries(user_id uuid,invalid_before timestamptz);
   create table private.member_mfa_recovery_locks(user_id uuid);
   create table public.member_roles(user_id uuid,role text);
   create table private.platform_operators(user_id uuid,revoked_at timestamptz,capabilities text[]);
   create table private.compass_platform_operators(user_id uuid,revoked_at timestamptz);
   grant select on private.platform_operators to postgres;
   grant select on private.compass_platform_operators to postgres;
   create function private.challengeable_factor_types() returns text[] language sql as $$select array['totp']::text[]$$;
   -- Existing dependency names; the delivery replaces both definitions below.
   create function private.mfa_satisfied() returns boolean language sql as $$select false$$;
   create function private.has_second_factor(uuid) returns boolean language sql as $$select false$$;
   insert into auth.users(id) values('${user}');insert into auth.sessions(id,user_id) values('${session}','${user}');
   insert into auth.mfa_amr_claims values('${session}','passkey');insert into public.member_roles values('${user}','admin');
   insert into auth.mfa_factors values('${user}','verified','totp');
   alter schema private owner to postgres;
   grant all on all tables in schema auth to postgres;
   grant select on public.member_roles to postgres;
   grant all on private.member_mfa_reset_boundaries,private.member_mfa_recovery_locks to postgres;
   grant create on schema public to postgres;
   alter function private.challengeable_factor_types() owner to postgres;
   alter function private.mfa_satisfied() owner to postgres;
   alter function private.has_second_factor(uuid) owner to postgres;
   revoke all on function private.mfa_satisfied(),private.has_second_factor(uuid) from public,anon,authenticated,service_role;
   create function private.lock_case_graph(uuid[],uuid[]) returns void language sql as $$select pg_catalog.pg_advisory_xact_lock(509,700)$$;
   create function private.lock_case_graph_statement() returns trigger language plpgsql as $$begin perform private.lock_case_graph(array[]::uuid[],array[]::uuid[]);return null;end$$;
   create function private.lock_case_graph_row_keys() returns trigger language plpgsql as $$begin return coalesce(new,old);end$$;
   create table private.account_lifecycle_manifest(schema_name text,table_name text,user_column text,delete_disposition text,export_disposition text,export_inventory_basis text,exclusion_reason text,note text);
   create table private.account_lifecycle_trigger_review(kind text,schema_name text,table_name text,object_name text,definition_hash text,primary key(kind,schema_name,table_name,object_name));
   create function private.account_lifecycle_trigger_surface() returns table(kind text,schema_name text,table_name text,object_name text,definition_hash text) language sql as $$select 'trigger'::text,'private'::text,'verified_key_sessions'::text,t.tgname::text,md5(pg_get_triggerdef(t.oid)) from pg_trigger t where t.tgrelid=(select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='verified_key_sessions') and not t.tgisinternal
    union all select 'function'::text,'private'::text,''::text,p.proname::text||'('||pg_get_function_arguments(p.oid)||')',md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('has_second_factor','mfa_satisfied','verified_key_session')$$;
   grant all on private.account_lifecycle_manifest,private.account_lifecycle_trigger_review to postgres;
   set role postgres;`);
  const compassSource=readFileSync(new URL('../supabase/migrations/20261001002000_compass_platform_fireworks_failover.sql',import.meta.url),'utf8');
  const compassBaseline=compassSource.match(/create function private\.compass_platform_operator\(\)[\s\S]*?revoke all on function private\.compass_platform_operator\(\) from public, anon, authenticated, service_role;/)?.[0];
  assert.ok(compassBaseline,'existing Compass operator guard is retained from its real migration');
  await db.query(compassBaseline);
  stage='candidate-migration';
  await db.query(readFileSync(keyAssuranceMigrationUrl,'utf8'));
  // Exercise the current predicate as well as the original key delivery: the
  // later member-policy migration deliberately extends its AAL1 refusal.
  await db.query(`create table public.organizations(id uuid,status text);
   create table public.organization_memberships(organization_id uuid,user_id uuid,status text);
   create table public.org_security_policy(require_member_mfa boolean,organization_id uuid);`);
  const memberPolicy=readFileSync(new URL('../supabase/migrations/20261030201100_two_step_and_session_controls.sql',import.meta.url),'utf8');
  await db.query(memberPolicy.slice(memberPolicy.indexOf('create function private.member_mfa_required'),memberPolicy.indexOf('-- Reachable before enrollment')));
  // #7206 (20261106221000) keeps that predicate's exact query and runs it
  // from PL/pgSQL (cached plan); install the live definition it reviewed.
  const livePredicate=readFileSync(new URL('../supabase/migrations/20261106221000_staff_desk_overviews_setwise_access_and_cached_helper_plans.sql',import.meta.url),'utf8');
  const predicateStart=livePredicate.indexOf('CREATE OR REPLACE FUNCTION private.mfa_satisfied()');
  assert.ok(predicateStart>=0,'live mfa_satisfied definition found');
  await db.query(livePredicate.slice(predicateStart,livePredicate.indexOf('\n$function$\n',predicateStart)+'\n$function$\n'.length));
  await db.query(`update private.account_lifecycle_trigger_review r set definition_hash=s.definition_hash
   from private.account_lifecycle_trigger_surface() s where r.kind=s.kind and r.schema_name=s.schema_name
   and r.table_name=s.table_name and r.object_name=s.object_name and s.object_name='mfa_satisfied()';`);
  stage='security-assertions';
  await db.query('reset role');
  assert.equal((await db.query("select count(*)::int n from private.account_lifecycle_trigger_surface() s join private.account_lifecycle_trigger_review r using(kind,schema_name,table_name,object_name,definition_hash) where s.kind='function'")).rows[0].n,3,'changed and new assurance helpers retain exact lifecycle review hashes');
  const contract=JSON.parse(readFileSync(new URL('../scripts/db-contract.json',import.meta.url),'utf8'));
  assert.equal((await db.query("select md5(pg_get_functiondef('private.mfa_satisfied()'::regprocedure)) digest")).rows[0].digest,contract.functions.find(entry=>entry.sig==='private.mfa_satisfied()').bodyMd5,'full installed assurance definition matches reviewed contract');
  assert.equal((await db.query("select md5(pg_get_functiondef('private.compass_platform_operator()'::regprocedure)) digest")).rows[0].digest,contract.functions.find(entry=>entry.sig==='private.compass_platform_operator()').bodyMd5,'installed Compass guard matches reviewed contract');
  // #8057: key assurance is valid, but the platform workspace has no union
  // charts. An empty list must not become a misleading sign-in failure on Home.
  // Install the actual current chart/session helpers on this owned database;
  // roll back its extra fixture schema before the existing key proofs continue.
  await db.query('begin');
  try {
   await db.query(`alter table public.organizations add column kind text default 'union';
    alter table public.org_security_policy add column require_staff_mfa boolean default true, add column id boolean default true;
    create table public.chapters(id text primary key,organization_id uuid);
    create table public.member_profiles(id uuid primary key,chapter_id text);
    create table public.member_chapter_memberships(user_id uuid,chapter_id text,status text);
    create table public.organization_role_grants(organization_id uuid,user_id uuid,role text);
    create table public.member_role_chapters(user_id uuid,chapter_id text,role text);
    create table private.member_pin_sessions(session_id uuid,user_id uuid);
    create table private.pulse_saved_charts(id uuid,owner_id uuid,organization_id uuid,chapter_id text,deleted_at timestamptz,pinned boolean,created_at timestamptz);
    create function private.organization_feature_enabled(uuid,text) returns boolean language sql as $$select true$$;
    -- #8768: the native staff scope reports the organization floors; the helper never answers below 25.
    create function private.organization_limit(uuid,text) returns integer language sql as $$select 25$$;
    create function private.lock_case_graph_read() returns void language sql as $$select pg_advisory_xact_lock_shared(509,700)$$;
    grant all on all tables in schema public,auth,private to postgres;`);
   for (const fn of ['private.current_member_organization','private.current_member_chapter',
    'private.current_mobile_staff_organization','private.is_organization_member',
    'private.organization_is_union','private.organization_is_platform',
    'private.staff_mfa_required(p_organization_id uuid)','private.staff_mfa_required()',
    'public.get_my_mobile_staff_scope','private.member_pin_jwt_session_id',
    'private.member_pin_restriction_applies','private.member_pin_session_restricted',
    'private.member_pin_require_full_session','private.pulse_chart_context','public.list_pulse_charts']) {
    await db.query(latestFnBody(fn));
   }
   const org=randomUUID(), authenticatorSession=randomUUID();
   await db.query("insert into public.organizations(id,status,kind) values($1,'active','union')",[org]);
   await db.query("insert into public.chapters values('chart-proof',$1)",[org]);
   await db.query("insert into public.member_profiles values($1,'chart-proof')",[user]);
   await db.query("insert into public.member_chapter_memberships values($1,'chart-proof','active')",[user]);
   await db.query("insert into public.organization_memberships values($1,$2,'active')",[org,user]);
   await db.query("insert into public.organization_role_grants values($1,$2,'admin')",[org,user]);
   await db.query("insert into auth.sessions(id,user_id,aal) values($1,$2,'aal2')",[authenticatorSession,user]);
   await db.query("insert into auth.mfa_amr_claims values($1,'totp')",[authenticatorSession]);
   await db.query('update private.verified_key_policy set enabled=true');
   await db.query('set local role service_role');
   await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
   await db.query('select public.register_verified_key_session($1,$2,$3,$4,false,false)',[user,session,'a'.repeat(64),'b'.repeat(64)]);
   await db.query('reset role');
   const request=async(claims,hat='admin')=>{
    await db.query('savepoint chart_request');
    try {
     await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
     await db.query('set local role authenticated');
     const value=(await db.query('select public.list_pulse_charts($1) value',[hat])).rows[0].value;
     await db.query('reset role');await db.query('release savepoint chart_request');
     return {value};
    } catch(error) {
     await db.query('rollback to savepoint chart_request');
     return {code:error.code,message:error.message};
    }
   };
   const keyClaims={sub:user,session_id:session,role:'authenticated',aal:'aal2',amr:[{method:'passkey'}],ug_key_uv:true};
   const authenticatorClaims={sub:user,session_id:authenticatorSession,role:'authenticated',aal:'aal2',amr:[{method:'totp'}]};
   for (const kind of ['union','platform']) {
    await db.query('update public.organizations set kind=$1',[kind]);
    if(kind==='platform') await db.query("insert into private.pulse_saved_charts values($1,$2,$3,'chart-proof',null,true,now())",[randomUUID(),user,org]);
    for (const claims of [authenticatorClaims,keyClaims]) {
     await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
     const assurance=(await db.query('select private.mfa_satisfied() mfa,public.get_my_mobile_staff_scope() staff')).rows[0];
     assert.equal(assurance.mfa,true,'both real assurance paths satisfy MFA');
     assert.equal(assurance.staff.staffAuthorized,true,'both sessions retain administrator scope');
     assert.equal(assurance.staff.privacyFloor,25,'the staff scope reports the organization privacy floor (#8768)');
     assert.deepEqual(await request(claims),{value:[]},kind+' workspace lists no charts without an access-verification error');
    }
   }
   await db.query('update public.member_profiles set chapter_id=null where id=$1',[user]);
   assert.deepEqual(await request(keyClaims),{value:[]},'a chapterless platform administrator also has an empty chart list');
   await db.query("update public.member_profiles set chapter_id='chart-proof' where id=$1",[user]);
   assert.equal((await request({...keyClaims,aal:'aal1',ug_key_uv:false})).code,'42501','a key without assurance is still refused');
   await db.query('update private.verified_key_policy set enabled=false');
   assert.equal((await request(keyClaims)).code,'42501','an unconfirmed key claim cannot use the platform empty-list path');
   await db.query('update private.verified_key_policy set enabled=true');
   assert.equal((await request(keyClaims,'unknown')).code,'42501','an invented hat is still refused');
   assert.equal((await request(keyClaims,null)).code,'42501','a missing hat is still refused');
   await db.query('savepoint platform_figures');
   await assert.rejects(db.query("select private.pulse_chart_context('admin')"),{code:'42501'},'platform union analytics remain unavailable');
   await db.query('rollback to savepoint platform_figures');
   await db.query('insert into private.member_pin_sessions values($1,$2)',[session,user]);
   assert.equal((await request(keyClaims)).code,'42501','a restricted session cannot use the platform empty-list path');
   await db.query('delete from private.member_pin_sessions');
   await db.query('delete from public.organization_role_grants');
   assert.equal((await request(keyClaims)).code,'42501','a revoked administrator hat is still refused');
   assert.deepEqual(await request(keyClaims,'member'),{value:[]},'an active platform member has no union charts');
   await db.query("update public.organization_memberships set status='revoked'");
   assert.equal((await request(keyClaims,'member')).code,'42501','revoked platform membership is still refused');
  } finally {
   await db.query('rollback');await db.query('reset role');
  }
  const claims={sub:user,session_id:session,aal:'aal1',role:'authenticated',amr:[{method:'passkey'}]};
  const event=()=>({user_id:user,claims});
  const hook=async()=>{await db.query('set role supabase_auth_admin');try{return (await db.query('select public.verified_key_access_token_hook($1::jsonb) result',[event()])).rows[0].result.claims;}finally{await db.query('reset role');}};
  const register=async(challenge='a'.repeat(64))=>{await db.query('set role service_role');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);try{return await db.query('select public.register_verified_key_session($1,$2,$3,$4,false,false)',[user,session,challenge,'b'.repeat(64)]);}finally{await db.query('reset role');}};
  // Auth bookkeeping holds shared before any exempt Auth tuple. Registration
  // must take graph then wait for exclusive bookkeeping, never lock a session
  // first and invert ordinary Auth cleanup's ordering.
  const blocker=new pg.Client({host:'127.0.0.1',port,user:'supabase_admin',password:'postgres',database:'postgres'});
  const registrar=new pg.Client({host:'127.0.0.1',port,user:'supabase_admin',password:'postgres',database:'postgres'});
  await blocker.connect();await registrar.connect();let pending;
  try {
   await blocker.query('begin;select pg_advisory_xact_lock_shared(509,701)');
   await blocker.query('select 1 from auth.sessions where id=$1 for update',[session]);
   await registrar.query("begin;set local statement_timeout='5s';set local role service_role");
   await registrar.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
   const pid=(await registrar.query('select pg_backend_pid() pid')).rows[0].pid;
   pending=registrar.query('select public.register_verified_key_session($1,$2,$3,$4,false,false)',[user,session,'8'.repeat(64),'9'.repeat(64)]);
   // Attach rejection handling immediately while observing the bounded wait.
   const outcome=pending.then(value=>({value}),error=>({error}));
   let locks=[];
   for(let attempt=0;attempt<60;attempt++) {
    locks=(await db.query("select objid::int key,granted,mode from pg_locks where pid=$1 and locktype='advisory' and classid=509",[pid])).rows;
    if(locks.some(lock=>lock.key===701&&!lock.granted))break;
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   assert.ok(locks.some(lock=>lock.key===700&&lock.granted),'graph gate acquired before waiting for Auth bookkeeping');
   assert.ok(locks.some(lock=>lock.key===701&&!lock.granted&&lock.mode==='ExclusiveLock'),'registration waits before any Auth tuple');
   await blocker.query('rollback');const result=await outcome;if(result.error)throw result.error;
   assert.equal(result.value.rows[0].register_verified_key_session,false,'disabled registration settles after bookkeeping releases');
  } finally {
   await blocker.query('rollback');if(pending)await pending.catch(()=>{});
   await registrar.query('rollback');await blocker.end();await registrar.end();
  }
  assert.equal((await hook()).aal,'aal1','absent registry cannot elevate');
  await db.query('set role supabase_auth_admin');
  await assert.rejects(db.query('select public.verified_key_access_token_hook($1::jsonb)',[{user_id:session,claims}]),/invalid hook subject/,'cross-subject hook input fails closed');
  await assert.rejects(db.query('select public.verified_key_access_token_hook($1::jsonb)',[{user_id:user,claims:{...claims,session_id:null}}]),/invalid hook subject/,'missing session cannot gain assurance');
  await db.query('reset role');
  assert.equal((await register()).rows[0].register_verified_key_session,false,'policy defaults disabled');
  assert.deepEqual((await db.query('select enabled,allow_staff,credential_eligibility from private.verified_key_policy')).rows[0],{enabled:false,allow_staff:true,credential_eligibility:'non_backup'},'owner-selected scope is inert until hosted activation');
  await db.query("update private.verified_key_policy set enabled=true");await register();
  assert.equal((await hook()).aal,'aal2','verified live UV session elevates staff');
  await db.query("update private.verified_key_policy set credential_eligibility='pending_owner_decision'");assert.equal((await hook()).aal,'aal1','no owner choice means no elevation even when enabled');
  await db.query("update private.verified_key_policy set credential_eligibility='attested_hardware'");assert.equal((await hook()).aal,'aal1','unattested hardware label never qualifies');
  await db.query("update private.verified_key_policy set credential_eligibility='non_backup'");assert.equal((await hook()).aal,'aal2','signed non-backup credential can satisfy narrower policy');
  await db.query("update private.verified_key_sessions set backup_eligible=true");assert.equal((await hook()).aal,'aal1','backup-eligible credential denied even before sync');
  await db.query("update private.verified_key_sessions set backed_up=true");assert.equal((await hook()).aal,'aal1','synced credential denied by non-backup policy');
  await assert.rejects(db.query("update private.verified_key_policy set credential_eligibility='any_uv'"),/check constraint/,'unapproved broad UV policy cannot be configured');
  await db.query('update private.verified_key_sessions set backup_eligible=false,backed_up=false');
  for(const [eligible,backedUp] of [[true,false],[true,true]]) {
   const nextSession=randomUUID();
   await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[nextSession,user]);
   await db.query("insert into auth.mfa_amr_claims values($1,'passkey')",[nextSession]);
   await db.query('set role service_role');
   await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);
   const refused=await db.query('select public.register_verified_key_session($1,$2,$3,$4,$5,$6) ok',[user,nextSession,randomUUID().replaceAll('-','').repeat(2),randomUUID().replaceAll('-','').repeat(2),eligible,backedUp]);
   await db.query('reset role');
   assert.equal(refused.rows[0].ok,false,'changed signed backup flags on a later sign-in never reuse earlier eligibility');
   assert.equal((await db.query('select count(*)::int n from private.verified_key_sessions where session_id=$1',[nextSession])).rows[0].n,0,'ineligible assertion leaves no privileged row');
   claims.session_id=nextSession;assert.equal((await hook()).aal,'aal1','backup-eligible sign-in remains on code path');claims.session_id=session;
   await db.query('delete from auth.sessions where id=$1',[nextSession]);
  }
  await assert.rejects(db.query('select private.organization_claim_require_operator($1,$2)',[user,session]),/claim verifier required/,'key alone never grants operator capability');
  await db.query("insert into private.platform_operators values($1,null,array['claim_verification'])",[user]);
  await db.query('select private.organization_claim_require_operator($1,$2)',[user,session]);
  await db.query("update auth.sessions set not_after=now()-interval '1 minute'");assert.equal((await hook()).aal,'aal1','expired key session cannot elevate');
  await db.query('update auth.sessions set not_after=null');
  await db.query('insert into private.member_mfa_reset_boundaries values($1,now())',[user]);assert.equal((await hook()).aal,'aal1','reset boundary invalidates existing key session');
  await db.query('delete from private.member_mfa_reset_boundaries');
  await db.query("update auth.users set banned_until=now()+interval '1 day'");assert.equal((await hook()).aal,'aal1','banned user cannot elevate');await db.query('update auth.users set banned_until=null');
  assert.equal((await db.query('select private.recent_verified_key_session($1,$2) ok',[user,session])).rows[0].ok,true,'fresh key retains deletion recency');
  await db.query("update private.verified_key_sessions set verified_at=now()-interval '11 minutes'");
  assert.equal((await db.query('select private.recent_verified_key_session($1,$2) ok',[user,session])).rows[0].ok,false,'old key cannot authorize deletion');
  assert.equal((await hook()).aal,'aal2','deletion recency does not revoke unrelated valid assurance');
  await db.query('update private.verified_key_sessions set verified_at=now()');
  const elevated=await hook();assert.equal(elevated.ug_key_uv,true);
  await db.query('delete from auth.mfa_factors');
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify(elevated)]);
  assert.equal((await db.query('select private.mfa_satisfied() ok,private.has_second_factor($1) factor',[user])).rows[0].ok,true);
  assert.equal((await db.query('select private.has_second_factor($1) ok',[user])).rows[0].ok,true);
  assert.equal((await db.query('select private.compass_platform_operator() ok')).rows[0].ok,false,'key assurance never grants Compass operator authority');
  await db.query('insert into private.compass_platform_operators values($1,null)',[user]);
  assert.equal((await db.query('select private.compass_platform_operator() ok')).rows[0].ok,true,'explicit Compass operator may satisfy MFA with eligible verified key alone');
  await db.query('update private.compass_platform_operators set revoked_at=now()');
  assert.equal((await db.query('select private.compass_platform_operator() ok')).rows[0].ok,false,'revoked Compass operator authority is independent of valid key assurance');
  await db.query('update private.compass_platform_operators set revoked_at=null');
  await assert.rejects(register(),/unique constraint/,'replayed challenge/assertion cannot register twice');
  for(const role of ['anon','authenticated']){
   await db.query(`set role ${role}`);
   await assert.rejects(db.query('insert into private.verified_key_sessions(session_id,user_id,challenge_sha256,assertion_sha256,backup_eligible,backed_up) values($1,$2,$3,$4,false,false)',[session,user,'c'.repeat(64),'d'.repeat(64)]),/permission denied/);
   await assert.rejects(db.query('select public.register_verified_key_session($1,$2,$3,$4,false,false)',[user,session,'c'.repeat(64),'d'.repeat(64)]),/permission denied/);
   await assert.rejects(db.query('select public.verified_key_access_token_hook($1::jsonb)',[event()]),/permission denied/);
   await db.query('reset role');
  }
  await db.query('update private.verified_key_policy set allow_staff=false');assert.equal((await hook()).aal,'aal1','role policy can deny staff without redesign');
  await db.query('update private.verified_key_policy set allow_staff=true');
  await db.query('insert into private.member_mfa_recovery_locks values($1)',[user]);assert.equal((await hook()).aal,'aal1','recovery lock denies key elevation');await db.query('delete from private.member_mfa_recovery_locks');
  await db.query('delete from private.verified_key_sessions');
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify(elevated)]);
  assert.equal((await db.query('select private.mfa_satisfied() ok')).rows[0].ok,false,'outstanding key JWT loses assurance when row removed');
  assert.equal((await db.query('select private.compass_platform_operator() ok')).rows[0].ok,false,'revoked key evidence cannot authorize Compass with stale AAL2');
  assert.equal((await hook()).aal,'aal1','refresh input after revocation never elevates');
  Object.assign(claims,elevated);assert.equal((await hook()).aal,'aal1','carried custom AAL2 cannot survive row removal');
  claims.amr=[{method:'totp'}];assert.equal((await hook()).aal,'aal2','genuine native TOTP AAL2 remains independent');
  await db.query("insert into auth.mfa_factors values($1,'verified','totp')",[user]);
  await db.query("update auth.sessions set aal='aal2'");
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify(await hook())]);
  assert.equal((await db.query('select private.compass_platform_operator() ok')).rows[0].ok,true,'native TOTP AAL2 still authorizes an explicit active Compass operator');
  await db.query("update auth.sessions set aal='aal1'");
  Object.assign(claims,{aal:'aal1',amr:[{method:'passkey'}]});delete claims.ug_key_uv;
  await assert.rejects(db.query('select private.organization_claim_require_operator($1,$2)',[user,session]),/claim verifier required/,'revoked key cannot access operator data');
  await db.query("update auth.mfa_amr_claims set authentication_method='password'");await assert.rejects(register('e'.repeat(64)),/not authorized/,'password session cannot register');
  await db.query("update auth.mfa_amr_claims set authentication_method='oauth'");await assert.rejects(register('f'.repeat(64)),/not authorized/,'Google session cannot register');
  await db.query("update auth.mfa_amr_claims set authentication_method='passkey'");await register('e'.repeat(64));
  await db.query('set role service_role');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);
  await db.query('select public.revoke_verified_key_session($1,$2)',[user,session]);await db.query('reset role');
  assert.equal((await db.query('select count(*)::int n from auth.sessions')).rows[0].n,0,'revocation deletes Auth refresh session');
  assert.equal((await db.query('select count(*)::int n from private.verified_key_sessions')).rows[0].n,0,'bounded service revocation removes registry evidence');
  assert.equal((await hook()).aal,'aal1','revoked refresh has no key evidence');
  await assert.rejects(register('f'.repeat(64)),/not authorized/,'late registration cannot recreate a deleted Auth session');
 }catch(error){
  // Fixed stage and validated status only; never emit SQL, JWTs or child output.
  const code=/^[0-9A-Z]{5}$/.test(error.code??'')?error.code:'none';
  const exit=Number.isInteger(error.status)?String(error.status):'none';
  console.error(`KEY_MFA_PROOF_FAILURE stage=${stage} code=${code} exit=${exit}`);
  throw error;
 }finally{if(db)await db.end();if(started)execFileSync('docker',['stop',name],{stdio:'ignore'});}
});
