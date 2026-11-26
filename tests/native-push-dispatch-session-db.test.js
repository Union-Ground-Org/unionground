// @vitest-environment node
import pg from 'pg';
import { readdirSync } from 'node:fs';
import { helperFirst, proveCaseGraphInventory } from '../scripts/account-case-graph-inventory.mjs';
import { describe, expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';
const live = process.env.REQUIRE_DB_REPAIR_PROOFS === '1' ? describe : describe.skip;
const user='50963003-0000-4000-8000-000000000001';
const session='50963003-0000-4000-8000-000000000002';
const installation='50963003-0000-4000-8000-000000000003';
const notification='50963003-0000-4000-8000-000000000004';
async function rollback(run) {
  const client=new pg.Client({ connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await client.connect(); await client.query('begin');
  try {
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'native-session-proof@example.invalid','{}')",[user]);
    await client.query('insert into auth.sessions(id,user_id,created_at,updated_at,refreshed_at) values($1,$2,now(),now(),now())',[session,user]);
    await client.query(`insert into public.member_native_push_installations(user_id,installation_id,provider,environment,device_token,session_handle)
      values($1,$2,'fcm','production','native-session-proof-token-12345',private.member_session_handle($3))`,[user,installation,session]);
    await client.query('update private.notification_controls set outbound_enabled=true where id');
    await client.query("insert into public.member_notifications(id,user_id,title,body,kind) values($1,$2,'Fictional proof','Fictional proof','events')",[notification,user]);
    const handle=(await client.query('select private.member_session_handle($1) handle',[session])).rows[0].handle;
    await run(client,handle);
  } finally {await client.query('rollback');await client.end();}
}
async function claim(client) {
  const rows=(await client.query("select public.claim_notification_deliveries('push',1) rows")).rows[0].rows;
  const row=rows.find(r=>r.nativeInstallations?.some(i=>i.installationId===installation));
  return {rows,row};
}
async function claimed(client) {
  // Restrict unrelated fixture deliveries without changing their identities.
  await client.query('update public.member_notification_deliveries set next_attempt_at=now()+interval \'1 day\' where user_id<>$1',[user]);
  const result=await claim(client);expect(result.row).toBeDefined();return result.row;
}
async function authorize(client,row,target,changes={}) {
  const args={delivery:row.deliveryId,attempt:row.attempt,epoch:row.leaseEpoch,installation:target.installationId,provider:target.provider,environment:target.environment,hash:target.tokenHash,handle:target.sessionHandle,...changes};
  return (await client.query('select public.authorize_native_push_dispatch($1,$2,$3,$4,$5,$6,$7,$8) allowed',Object.values(args))).rows[0].allowed;
}
live('native dispatch live-session and exact-lease guards',()=>{
  it('keeps the installed graph gate after the dispatch migration follows the reviewed wrapper floor',async()=>rollback(async(client)=>{
    const names=readdirSync(new URL('../supabase/migrations/',import.meta.url))
      .filter(name=>name.endsWith('_native_push_session_dispatch_exclusion.sql'));
    expect(names).toHaveLength(1);
    const version=names[0].split('_')[0];
    expect(version>'20260907151000').toBe(true);
    expect((await client.query('select version from supabase_migrations.schema_migrations where version=$1',[version])).rows).toHaveLength(1);
    const installed=(await client.query("select prosrc source,pg_get_functiondef(oid) definition from pg_proc where oid='public.claim_notification_deliveries(text,integer)'::regprocedure")).rows[0];
    expect(helperFirst(installed.source)).toBe(true);
    await proveCaseGraphInventory(client);
    for (const [gate, error] of [
      ['a00_case_graph_lock', 'Case graph relation closure or BEFORE STATEMENT gate changed'],
      ['z99_case_graph_keys', 'Implicit FK row-key gate changed: private.bot_production_marks'],
    ]) {
      await client.query('savepoint bot_ledger_gate');
      await client.query(`drop trigger ${gate} on private.bot_production_marks`);
      await expect(proveCaseGraphInventory(client)).rejects.toThrow(error);
      await client.query('rollback to savepoint bot_ledger_gate');
      await client.query('release savepoint bot_ledger_gate');
    }
    // A later replacement stripping the wrapper must fail the same installed
    // inventory proof; everything here is inside the disposable rollback.
    const broken=installed.definition.replace('perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);','');
    expect(broken).not.toBe(installed.definition);
    await client.query(broken);
    await expect(proveCaseGraphInventory(client)).rejects.toThrow('public.claim_notification_deliveries');
  }));
  it('rewinds all six legacy-schema deferrals instead of permanently failing the delivery',async()=>rollback(async(client)=>{
    for(let retry=0;retry<6;retry++) {
      await client.query('update public.member_notification_deliveries set next_attempt_at=now() where user_id=$1',[user]);
      const row=await claimed(client);
      await client.query('select public.record_notification_delivery_results($1::jsonb)',[JSON.stringify([{
        deliveryId:row.deliveryId,attempt:row.attempt,leaseEpoch:row.leaseEpoch,
        status:'deferred',error:'native claim schema unavailable',
      }])]);
      expect((await client.query('select status,attempts from public.member_notification_deliveries where id=$1',[row.deliveryId])).rows[0])
        .toEqual({status:'pending',attempts:0});
    }
    await client.query('update public.member_notification_deliveries set next_attempt_at=now() where user_id=$1',[user]);
    const row=await claimed(client);
    expect(await authorize(client,row,row.nativeInstallations[0])).toBe(true);
  }));
  it('excludes a removed Auth session from the native claim without deleting its installation',async()=>rollback(async(client)=>{
    await client.query('delete from auth.sessions where id=$1',[session]);
    await client.query('update public.member_notification_deliveries set next_attempt_at=now()+interval \'1 day\' where user_id<>$1',[user]);
    const {rows}=await claim(client);
    expect(rows.flatMap(r=>r.nativeInstallations??[])).toEqual([]);
    expect((await client.query('select count(*)::integer count from public.member_native_push_installations where user_id=$1',[user])).rows[0].count).toBe(1);
  }));
  it.each([
    ['explicit expiry',"not_after=now()-interval '1 second'"],
    ['inactivity expiry',"created_at=now()-interval '9 hours',refreshed_at=now()-interval '8 hours 1 second'"],
    ['timebox expiry',"created_at=now()-interval '168 hours 1 second'"],
    ['legacy inactive session',"created_at=now()-interval '9 hours',refreshed_at=null"],
  ])('excludes %s at claim and reauthorization',async(_,update)=>rollback(async(client,handle)=>{
    await client.query('update private.notification_controls set native_sessions_timebox_seconds=604800,native_sessions_inactivity_seconds=28800 where id');
    const row=await claimed(client),target=row.nativeInstallations[0];
    expect(await authorize(client,row,target)).toBe(true);
    await client.query(`update auth.sessions set ${update} where id=$1`,[session]);
    expect(await authorize(client,row,target)).toBe(false);
    expect((await client.query('select private.native_push_session_eligible($1,$2) allowed',[user,handle])).rows[0].allowed).toBe(false);
    await client.query("update public.member_notification_deliveries set status='pending',next_attempt_at=now() where id=$1",[row.deliveryId]);
    expect((await claim(client)).rows.flatMap(r=>r.nativeInstallations??[])).toEqual([]);
  }));
  it('keeps an old but live session eligible with default unlimited settings and excludes it once ended',async()=>rollback(async(client,handle)=>{
    expect((await client.query('select native_sessions_timebox_seconds,native_sessions_inactivity_seconds from private.notification_controls where id')).rows[0])
      .toEqual({native_sessions_timebox_seconds:0,native_sessions_inactivity_seconds:0});
    await client.query("update auth.sessions set created_at=now()-interval '365 days',refreshed_at=now()-interval '30 days' where id=$1",[session]);
    const row=await claimed(client),target=row.nativeInstallations[0];
    expect(await authorize(client,row,target)).toBe(true);
    await client.query('delete from auth.sessions where id=$1',[session]);
    expect(await authorize(client,row,target)).toBe(false);
    expect((await client.query('select private.native_push_session_eligible($1,$2) allowed',[user,handle])).rows[0].allowed).toBe(false);
  }));
  it('refuses deletion between claim and provider reauthorization',async()=>rollback(async(client)=>{
    const row=await claimed(client);await client.query('delete from auth.sessions where id=$1',[session]);
    expect(await authorize(client,row,row.nativeInstallations[0])).toBe(false);
  }));
  it('refuses a replacement registration even when its token and installation id stay the same',async()=>rollback(async(client)=>{
    const row=await claimed(client);const replacement='50963003-0000-4000-8000-000000000005';
    await client.query('insert into auth.sessions(id,user_id,created_at,updated_at,refreshed_at) values($1,$2,now(),now(),now())',[replacement,user]);
    await client.query('update public.member_native_push_installations set session_handle=private.member_session_handle($1) where user_id=$2',[replacement,user]);
    expect(await authorize(client,row,row.nativeInstallations[0])).toBe(false);
  }));
  it('requires the exact delivery lease, token, provider, environment and session binding',async()=>rollback(async(client)=>{
    const row=await claimed(client),target=row.nativeInstallations[0];expect(await authorize(client,row,target)).toBe(true);
    for(const changed of [{attempt:row.attempt+1},{epoch:row.leaseEpoch+1},{hash:'a'.repeat(64)},{provider:'apns'},{environment:'sandbox'},{handle:'b'.repeat(64)},{installation:'50963003-0000-4000-8000-000000000009'}])
      expect(await authorize(client,row,target,changed)).toBe(false);
    await client.query('update private.notification_controls set outbound_enabled=false where id');
    expect(await authorize(client,row,target)).toBe(false);
  }));
  it('refuses completed, stale and already-receipted targets',async()=>rollback(async(client)=>{
    const row=await claimed(client),target=row.nativeInstallations[0];
    await client.query("update public.member_notification_deliveries set status='sent' where id=$1",[row.deliveryId]);
    expect(await authorize(client,row,target)).toBe(false);
    await client.query("update public.member_notification_deliveries set status='sending',updated_at=now()-interval '15 minutes 1 second' where id=$1",[row.deliveryId]);
    expect(await authorize(client,row,target)).toBe(false);
    await client.query("update public.member_notification_deliveries set updated_at=now() where id=$1",[row.deliveryId]);
    await client.query('insert into private.member_notification_push_target_receipts(delivery_id,target_key) values($1,$2)',[row.deliveryId,target.targetKey]);
    expect(await authorize(client,row,target)).toBe(false);
  }));
  it('grants only service_role the public reauthorization RPC and no API role the private helper',async()=>rollback(async(client)=>{
    const signature='public.authorize_native_push_dispatch(uuid,integer,bigint,uuid,text,text,text,text)';
    for(const role of ['anon','authenticated','service_role']) {
      expect((await client.query('select has_function_privilege($1,$2,\'execute\') allowed',[role,signature])).rows[0].allowed).toBe(role==='service_role');
      for(const column of ['native_sessions_timebox_seconds','native_sessions_inactivity_seconds'])
        expect((await client.query('select has_column_privilege($1,\'private.notification_controls\',$2,\'update\') allowed',[role,column])).rows[0].allowed).toBe(false);
      expect((await client.query('select has_function_privilege($1,\'private.native_push_session_eligible(uuid,text)\',\'execute\') allowed',[role])).rows[0].allowed).toBe(false);
    }
  }));
});
