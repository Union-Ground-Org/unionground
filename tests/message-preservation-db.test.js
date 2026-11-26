// @vitest-environment node
// Retain legacy fixture grants without new memberships.
import { legacyStewardFixtureWrite } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripComments } from './helpers/migration.js';
import { reviewedPreGateRead } from '../scripts/account-case-graph-inventory.mjs';
import pg from 'pg';
import { expect, it } from 'vitest';
const retiredSeeds = JSON.parse(readFileSync('config/retired-pre-bot-seeds.json', 'utf8')).functions;
const signatureIdentity = value => value.replace(/\b(?:in\s+)?p_\w+\s+/g, '').replace(/\s/g, '');
const retiredIdentities = new Set(retiredSeeds.map(signatureIdentity));
const live = process.env.RUN_MESSAGE_PRESERVATION_DB_TESTS === '1' ? it : it.skip;
async function connect() {
  const url = new URL(process.env.SUPABASE_DB_URL);
  expect(['localhost', '127.0.0.1']).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  await c.query("set statement_timeout = '10s'");
  return c;
}
async function fixture(c) {
  const f = { user: randomUUID(), conversation: randomUUID(), message: randomUUID(), draft: randomUUID(), sent: randomUUID(), session: randomUUID() };
  await c.query("insert into auth.users(id,email) values ($1,$2)", [f.user, `${f.user}@example.invalid`]);
  f.org=randomUUID(); f.chapter=`proof-${f.org}`;
  await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)",[f.org,f.chapter]);
  await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)",[f.chapter,f.org]);
  await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [f.user,f.chapter]);
  await c.query("insert into public.member_conversations(id,user_id,organization_id,title) values ($1,$2,$3,'Preservation proof')", [f.conversation,f.user,f.org]);
  await c.query("insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body,created_at) values ($1,$2,$3,'member','Proof','delivered evidence',now()-interval '4 years')", [f.message,f.conversation,f.user]);
  await c.query("insert into public.member_scheduled_messages(id,conversation_id,actor_id,recipient_id,sender_kind,body,scheduled_for,created_at) values ($1,$2,$3,$3,'member','draft evidence',now()+interval '1 day',now()-interval '4 years')", [f.draft,f.conversation,f.user]);
  await c.query("insert into public.member_scheduled_messages(id,conversation_id,actor_id,recipient_id,sender_kind,body,scheduled_for,status,dispatched_at,sent_message_id) values ($1,$2,$3,$3,'member','delivered evidence',now(),'sent',now(),$4)",[f.sent,f.conversation,f.user,f.message]);
  return f;
}
// 20261006030000 refuses (and the dispatcher fails) a member message nobody
// could read. Tests whose sends must succeed add an organization-wide steward
// who can: a home chapter in the organization, active memberships and the
// staff second factor, as the read policy requires.
async function reader(c,f) {
  const id=randomUUID();
  await c.query("insert into auth.users(id,email) values ($1,$2)",[id,`${id}@example.invalid`]);
  await c.query("update public.member_profiles set chapter_id=$2 where id=$1",[id,f.chapter]);
  await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')",[f.org,id]);
  await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')",[id,f.chapter]);
  await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values (gen_random_uuid(),$1,'totp','verified',now(),now())",[id]);
  await legacyStewardFixtureWrite(c,"insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'steward')",[f.org,id]);
  return id;
}
async function hold(c,f) {
  await c.query("insert into public.member_message_legal_holds(conversation_id,organization_id,reason_code) values ($1,$2,'litigation')",[f.conversation,f.org]);
}
async function admin(c,f) {
  await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing",[f.org,f.user]);
  await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing",[f.user,f.chapter]);
  await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",[randomUUID(),f.user]);
  await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')",[f.org,f.user]);
  await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())",[f.session,f.user]);
  await c.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:f.user,role:'authenticated',aal:'aal2',session_id:f.session})]);
}
live('account deletion detaches held evidence and destroys unheld bodies through the disposition workers', async () => {
  const c=await connect(); await c.query('begin');
  try {
    const f=await fixture(c); await hold(c,f);
    await c.query('delete from auth.users where id=$1',[f.user]);
    expect((await c.query('select id from auth.users where id=$1',[f.user])).rowCount).toBe(0);
    expect((await c.query('select body,user_id,sender_name from public.member_messages where id=$1',[f.message])).rows).toEqual([{body:'delivered evidence',user_id:null,sender_name:'Deleted account'}]);
    expect((await c.query('select body,actor_id,recipient_id from public.member_scheduled_messages where id=$1',[f.draft])).rows).toEqual([{body:'draft evidence',actor_id:null,recipient_id:null}]);
    expect((await c.query('select body from public.member_scheduled_messages where id=$1',[f.sent])).rows).toEqual([{body:'delivered evidence'}]);
    expect((await c.query('select user_id from public.member_conversations where id=$1',[f.conversation])).rows).toEqual([{user_id:null}]);
    expect((await c.query('select released_at from public.member_message_legal_holds where conversation_id=$1',[f.conversation])).rows).toEqual([{released_at:null}]);
    await c.query('savepoint refuse');
    await expect(c.query('delete from public.member_conversations where id=$1',[f.conversation])).rejects.toMatchObject({code:'42501'});
    await c.query('rollback to refuse');
    for (const table of ['member_messages','member_scheduled_messages']) {
      await expect(c.query(`delete from public.${table} where conversation_id=$1`,[f.conversation])).rejects.toMatchObject({code:'42501'});
      await c.query('rollback to refuse');
    }
    await c.query('update public.member_message_legal_holds set released_at=now() where conversation_id=$1',[f.conversation]);
    expect((await c.query("select private.retention_eligible_count($1,'member_message_bodies',1095) as n",[f.org])).rows[0].n).toBe(2);
    // A trigger observes the worker-produced tombstone before the cascade.
    await c.query(`create temporary table removed_bodies(reason text, body text);
      create function pg_temp.observe_redaction() returns trigger language plpgsql as $$ begin
      insert into removed_bodies values(new.redaction_reason,new.body); return new; end $$;
      create trigger proof_redaction after update of body on public.member_messages for each row execute function pg_temp.observe_redaction()`);
    const unheld=await fixture(c);
    await c.query('delete from auth.users where id=$1',[unheld.user]);
    expect((await c.query('select * from removed_bodies')).rows).toContainEqual({reason:'account_closed',body:''});
  } finally { await c.query('rollback'); await c.end(); }
});
live('server retention catalogue returns the message policy and supports preview and authorization', async () => {
  const c=await connect(); await c.query('begin');
  try {
    const f=await fixture(c); await admin(c,f);
    const engine=(await c.query('select public.get_organization_retention_engine() as value')).rows[0].value;
    expect(engine.policies.find(p=>p.dataClass==='member_message_bodies')).toMatchObject({minimumDays:365,maximumDays:2555,defaultDays:1095,retentionDays:1095,executionEnabled:false});
    await c.query("select public.upsert_organization_retention_policy('member_message_bodies',1095,true,'ENABLE member_message_bodies')");
    const preview=(await c.query("select public.preview_organization_retention_run('member_message_bodies') as value")).rows[0].value;
    expect(preview.eligibleCount).toBeGreaterThanOrEqual(2);
    const authorized=(await c.query("select public.authorize_organization_retention_run($1,'AUTHORIZE member_message_bodies') as value",[preview.id])).rows[0].value;
    expect(authorized.status).toBe('authorized');
  } finally { await c.query('rollback'); await c.end(); }
});
for (const kind of ['delivered','draft','retention']) live(`hold placement serializes with ${kind} destruction across two connections`, async () => {
  const a=await connect(), b=await connect(); let f;
  try {
    f=await fixture(a);
    if (kind === 'delivered') {
      await b.query('begin isolation level repeatable read');
      await expect(b.query("select private.redact_member_message_row($1,'sender_removed',null)",[f.message])).rejects.toMatchObject({code:'40001'});
      await b.query('rollback');
    }
    if(kind==='retention') {
      await admin(a,f);
      await a.query("select public.upsert_organization_retention_policy('member_message_bodies',1095,true,'ENABLE member_message_bodies')");
      f.run=(await a.query("select public.preview_organization_retention_run('member_message_bodies') as v")).rows[0].v.id;
      await a.query("select public.authorize_organization_retention_run($1,'AUTHORIZE member_message_bodies')",[f.run]);
    }
    await a.query('begin'); await hold(a,f);
    // The hold is still uncommitted. The destructive session must wait on the
    // conversation lock, then see the committed hold using a fresh snapshot.
    const pid=(await b.query('select pg_backend_pid() as pid')).rows[0].pid;
    const sql=kind==='delivered' ? "select private.redact_member_message_row($1,'sender_removed',null)" : kind==='draft' ? 'select private.redact_member_scheduled_message_row($1)' : 'select private.perform_organization_retention_run($1) as v';
    const pending=b.query(sql,[kind==='delivered'?f.message:kind==='draft'?f.draft:f.run]).then(value=>({value}),error=>({error}));
    let waiting=false;
    for(let i=0;i<100;i++) {
      const row=(await a.query('select wait_event from pg_stat_activity where pid=$1',[pid])).rows[0];
      if(row?.wait_event==='advisory') { waiting=true; break; }
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await a.query('commit');
    const result=await pending;
    expect(waiting,'destruction must wait behind uncommitted preservation').toBe(true);
    if(kind==='retention') expect(result.value.rows[0].v).toMatchObject({status:'completed',deletedCount:0}); // selection happens after the gate
    else expect(result.error).toMatchObject({code:'42501'});
    expect((await a.query('select body from public.member_messages where id=$1',[f.message])).rows[0].body).toBe('delivered evidence');
    expect((await a.query('select body from public.member_scheduled_messages where id=$1',[f.draft])).rows[0].body).toBe('draft evidence');
  } finally {
    await a.query('rollback');
    if(f) {
      await a.query('delete from public.member_message_legal_holds where conversation_id=$1',[f.conversation]);
      await a.query('delete from public.organization_retention_runs where id=$1',[f.run ?? null]);
      await a.query('select private.redact_member_scheduled_message_row($1)',[f.draft]);
      await a.query('delete from public.member_scheduled_messages where id=$1',[f.draft]);
      // The retention fixture's append-only ledger survives until the owned
      // disposable stack is removed; never disable its guard just to clean up.
      if (kind !== 'retention') {
      await a.query("update public.organizations set status='suspended' where id=$1",[f.org]);
      await a.query('delete from auth.users where id=$1',[f.user]);
      await a.query('delete from public.chapters where id=$1',[f.chapter]);
      await a.query('delete from public.organizations where id=$1',[f.org]);
      }
    }
    await a.end(); await b.end();
  }
});

for (const reason of ['sender_removed', 'retention_expired']) live(`stored and in-flight briefings follow ${reason} with preservation precedence`, async () => {
  const c = await connect(); await c.query('begin');
  try {
    const f = await fixture(c); await admin(c, f);
    await c.query('set local role authenticated');
    const context = (await c.query("select public.get_message_briefing_context('private',$1) as v", [f.conversation])).rows[0].v;
    await c.query('reset role');
    // Simulate a saved derivative from a previously completed model request.
    await c.query("insert into public.compass_message_briefings(organization_id,requested_by,source_kind,target_id,summary,action_items) values ($1,$2,'private',$3,'delivered evidence','[\"review delivered evidence\"]')", [f.org,f.user,f.conversation]);
    await c.query("insert into public.compass_workspace_actions(organization_id,actor_user_id,action_kind,source_kind,source_id,title) values ($1,$2,'create_task','message',$3,'review delivered evidence')",[f.org,f.user,f.message]);
    await hold(c, f); await c.query('savepoint held');
    await expect(c.query('select private.redact_member_message_row($1,$2,null)',[f.message,reason])).rejects.toMatchObject({code:'42501'});
    await c.query('rollback to held');
    expect((await c.query('select summary from public.compass_message_briefings where target_id=$1',[f.conversation])).rowCount).toBe(1);
    await c.query('update public.member_message_legal_holds set released_at=now() where conversation_id=$1',[f.conversation]);
    if (reason === 'retention_expired') {
      await c.query("select public.upsert_organization_retention_policy('member_message_bodies',1095,true,'ENABLE member_message_bodies')");
      const run=(await c.query("select public.preview_organization_retention_run('member_message_bodies') as v")).rows[0].v.id;
      await c.query("select public.authorize_organization_retention_run($1,'AUTHORIZE member_message_bodies')",[run]);
      expect((await c.query('select private.perform_organization_retention_run($1) as v',[run])).rows[0].v.status).toBe('completed');
    } else await c.query('select private.redact_member_message_row($1,$2,null)',[f.message,reason]);
    expect((await c.query('select summary,action_items from public.compass_message_briefings where target_id=$1',[f.conversation])).rows).toEqual([]);
    expect((await c.query("select title from public.compass_workspace_actions where source_id=$1",[f.message])).rows).toEqual([{title:'Follow up on member message'}]);
    await c.query('set local role authenticated');
    await c.query('savepoint stale');
    await expect(c.query("select public.persist_compass_message_briefing('private',$1,'delivered evidence','[]',$2)",[f.conversation,context.sourceRevision])).rejects.toMatchObject({code:'PT409'});
    await c.query('rollback to stale');
    const fresh=(await c.query("select public.get_message_briefing_context('private',$1) as v",[f.conversation])).rows[0].v;
    await c.query("select public.persist_compass_message_briefing('private',$1,'Message removed','[]',$2)",[f.conversation,fresh.sourceRevision]);
    expect((await c.query('select summary from public.compass_message_briefings where target_id=$1',[f.conversation])).rows).toEqual([{summary:'Message removed'}]);
  } finally { await c.query('rollback'); await c.end(); }
});

async function waitForAdvisory(observer, connection) {
  const pid = (await connection.query('select pg_backend_pid() as pid')).rows[0].pid;
  return async () => {
    for (let i=0;i<150;i++) {
      if ((await observer.query('select wait_event from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event === 'advisory') return true;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    return false;
  };
}
live('account deletion and retention serialize across opposite chronological conversation order', async () => {
  const a=await connect(),b=await connect();
  try {
    const f=await fixture(a), administrator=await fixture(a);
    await a.query('update public.member_profiles set chapter_id=$2 where id=$1',[administrator.user,f.chapter]);
    administrator.org=f.org; administrator.chapter=f.chapter; await admin(a,administrator);
    const conversations=[randomUUID(),randomUUID()].sort();
    for (const [i,id] of conversations.entries()) {
      await a.query("insert into public.member_conversations(id,user_id,title) values ($1,$2,'Lock order proof')",[id,f.user]);
      await a.query("insert into public.member_messages(conversation_id,user_id,sender_kind,sender_name,body,created_at) values ($1,$2,'member','Proof','order evidence',now()-make_interval(years=>$3))",[id,f.user,i+5]);
    }
    await a.query("select public.upsert_organization_retention_policy('member_message_bodies',1095,true,'ENABLE member_message_bodies')");
    const run=(await a.query("select public.preview_organization_retention_run('member_message_bodies') as v")).rows[0].v.id;
    await a.query("select public.authorize_organization_retention_run($1,'AUTHORIZE member_message_bodies')",[run]);
    const waiting=await waitForAdvisory(a,b);
    await a.query('begin');
    await a.query('select private.lock_member_message_conversation($1)',[conversations[0]]);
    const pending=b.query('select private.perform_organization_retention_run($1) as v',[run]).then(value=>({value}),error=>({error}));
    expect(await waiting()).toBe(true);
    // Before repair B owns C2 while waiting for C1; deletion now needs C2.
    await a.query('delete from auth.users where id=$1',[f.user]);
    await a.query('commit');
    const result=await pending;
    expect(result.error).toBeUndefined();
    expect(result.value.rows[0].v.status).toBe('completed');
  } finally { await a.query('rollback'); await a.end(); await b.end(); }
});
for (const operation of ['delete','update']) live(`direct ${operation} takes preservation locks before row locks`, async () => {
  const a=await connect(),b=await connect();
  try {
    const f=await fixture(a);
    const waiting=await waitForAdvisory(a,b);
    await a.query('begin');
    await a.query('select private.lock_member_message_conversation($1)',[f.conversation]);
    const sql=operation==='delete' ? 'delete from public.member_messages where id=$1' : "update public.member_messages set body='updated evidence' where id=$1";
    const pending=b.query(sql,[f.message]).then(value=>({value}),error=>({error}));
    expect(await waiting()).toBe(true);
    await a.query("select private.redact_member_message_row($1,'sender_removed',null)",[f.message]);
    await a.query('commit');
    const result=await pending;
    expect(result.error?.code).not.toBe('40P01');
    if(operation==='delete') expect(result.error).toBeUndefined();
    else expect(result.error?.code).toBe('23514'); // tombstones cannot regain text
  } finally { await a.query('rollback'); await a.end(); await b.end(); }
});
live('retired engagement mute and keyword storage RPCs and hit trigger are absent', async () => {
  const c=await connect();
  try {
    for (const table of ['chapter_space_preferences','chapter_space_keyword_monitors','chapter_space_keyword_hits']) {
      expect((await c.query('select to_regclass($1) as v',[`public.${table}`])).rows[0].v).toBeNull();
    }
    for (const signature of ['public.set_chapter_space_preference(uuid,boolean,text)','public.save_chapter_space_keyword_monitor(uuid,text,boolean)','public.mark_chapter_space_keyword_hit_read(uuid)','private.capture_chapter_space_keyword_hits()']) {
      expect((await c.query('select to_regprocedure($1) as v',[signature])).rows[0].v).toBeNull();
    }
    expect((await c.query("select 1 from pg_trigger where tgname='chapter_thread_posts_capture_keyword_hits'")).rowCount).toBe(0);
  } finally { await c.end(); }
});

for (const held of [true, false]) live(`requester deletion retains held derivatives and cascades unheld derivatives: held=${held}`, async () => {
  const c=await connect(); await c.query('begin');
  try {
    const f=await fixture(c), requester=randomUUID();
    await c.query('insert into auth.users(id,email) values ($1,$2)',[requester,`${requester}@example.invalid`]);
    await c.query('update public.member_profiles set chapter_id=$2 where id=$1',[requester,f.chapter]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')",[f.org,requester]);
    await legacyStewardFixtureWrite(c,"insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'steward')",[f.org,requester]);
    await c.query("insert into public.compass_message_briefings(organization_id,requested_by,source_kind,target_id,summary,action_items) values ($1,$2,'private',$3,'Preserved summary','[\"Preserved action item\"]')",[f.org,requester,f.conversation]);
    await c.query("insert into public.compass_workspace_actions(organization_id,actor_user_id,action_kind,source_kind,source_id,title) values ($1,$2,'create_task','message',$3,'Preserved action title')",[f.org,requester,f.message]);
    if (held) await hold(c,f);
    await c.query('delete from auth.users where id=$1',[requester]);
    expect((await c.query('select id from auth.users where id=$1',[requester])).rowCount).toBe(0);
    expect((await c.query('select user_id,body from public.member_messages where id=$1',[f.message])).rows).toEqual([{user_id:f.user,body:'delivered evidence'}]);
    expect((await c.query('select requested_by,summary,action_items from public.compass_message_briefings where target_id=$1',[f.conversation])).rows).toEqual(held ? [{requested_by:null,summary:'Preserved summary',action_items:['Preserved action item']}] : []);
    expect((await c.query('select actor_user_id,title from public.compass_workspace_actions where source_id=$1',[f.message])).rows).toEqual(held ? [{actor_user_id:null,title:'Preserved action title'}] : []);
    if (held) {
      await c.query('savepoint preserved');
      for (const statement of [
        'delete from public.compass_message_briefings where target_id=$1',
        "update public.compass_message_briefings set summary='Changed summary' where target_id=$1",
        'delete from public.compass_workspace_actions where source_id=$1',
        "update public.compass_workspace_actions set title='Changed title' where source_id=$1",
      ]) {
        await expect(c.query(statement,[statement.includes('briefings')?f.conversation:f.message])).rejects.toMatchObject({code:'42501'});
        await c.query('rollback to preserved');
      }
      await c.query('delete from auth.users where id=$1',[f.user]);
      expect((await c.query('select summary from public.compass_message_briefings where target_id=$1',[f.conversation])).rowCount).toBe(1);
      expect((await c.query('select title from public.compass_workspace_actions where source_id=$1',[f.message])).rowCount).toBe(1);
    }
  } finally { await c.query('rollback'); await c.end(); }
});

for (const scheduler of ['dispatch','retention']) for (const first of ['worker','scheduler']) live(`${scheduler} scheduler takes the lifecycle gate before rows: ${first} first`, async () => {
  const a=await connect(), b=await connect(); let pending;
  try {
    const f=await fixture(a);
    let run;
    if (scheduler==='dispatch') await reader(a,f);
    if (scheduler==='dispatch') await a.query("update public.member_scheduled_messages set scheduled_for=now()-interval '1 minute' where id=$1",[f.draft]);
    else {
      await admin(a,f);
      await a.query("select public.upsert_organization_retention_policy('member_message_bodies',1095,true,'ENABLE member_message_bodies')");
      run=(await a.query("select public.preview_organization_retention_run('member_message_bodies') as v")).rows[0].v.id;
      await a.query("select public.authorize_organization_retention_run($1,'AUTHORIZE member_message_bodies')",[run]);
    }
    const waiting=await waitForAdvisory(a,b);
    const scheduledSql=scheduler==='dispatch' ? 'select private.dispatch_due_member_messaging(500) as v' : 'select private.run_due_organization_retention_jobs(100) as v';
    const workerSql=scheduler==='dispatch' ? 'select private.redact_member_scheduled_message_row($1)' : 'select private.perform_organization_retention_run($1) as v';
    const workerId=scheduler==='dispatch'?f.draft:run;
    await a.query('begin');
    if (first==='worker') {
      await a.query('select private.lock_message_lifecycle()');
      pending=b.query(scheduledSql).then(value=>({value}),error=>({error}));
      expect(await waiting(),'scheduler must wait before owning a draft or policy row').toBe(true);
      // This worker needs the very row the old scheduler locked before waiting
      // on the gate. Before repair this real schedule produces a deadlock.
      await a.query(workerSql,[workerId]);
    } else {
      const result=(await a.query(scheduledSql)).rows[0].v;
      if(scheduler==='dispatch') expect(result.sent).toBeGreaterThanOrEqual(1);
      else expect(result.processed).toBeGreaterThanOrEqual(1);
      pending=b.query(scheduler==='dispatch' ? 'delete from auth.users where id=$1' : workerSql,[scheduler==='dispatch'?f.user:workerId]).then(value=>({value}),error=>({error}));
      expect(await waiting()).toBe(true);
    }
    await a.query('commit');
    const result=await pending;
    expect(result.error).toBeUndefined();
    if (scheduler==='dispatch' && first==='worker') expect((await a.query('select body from public.member_scheduled_messages where id=$1',[f.draft])).rows[0].body).toBe('');
    if (scheduler==='retention') expect((await a.query('select body from public.member_messages where id=$1',[f.message])).rows[0].body).toBe('');
  } finally { await a.query('rollback'); if(pending) await pending; await a.end(); await b.end(); }
});

live('detached held identities deny unrelated authenticated tenant reads and mutations', async () => {
  const c=await connect(); await c.query('begin');
  try {
    const held=await fixture(c), other=await fixture(c);
    const briefing=randomUUID(), action=randomUUID();
    await c.query("insert into public.compass_message_briefings(id,organization_id,requested_by,source_kind,target_id,summary,action_items) values ($1,$2,$3,'private',$4,'Preserved summary','[]')",[briefing,held.org,held.user,held.conversation]);
    await c.query("insert into public.compass_workspace_actions(id,organization_id,actor_user_id,action_kind,source_kind,source_id,title) values ($1,$2,$3,'create_task','message',$4,'Preserved action')",[action,held.org,held.user,held.message]);
    await hold(c,held); await c.query('delete from auth.users where id=$1',[held.user]);
    await admin(c,other);
    await legacyStewardFixtureWrite(c,"insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'steward')",[other.org,other.user]);
    await c.query('set local role authenticated');
    for (const [table,id] of [['member_conversations',held.conversation],['member_messages',held.message],['member_scheduled_messages',held.draft],['compass_message_briefings',briefing],['compass_workspace_actions',action]]) {
      expect((await c.query(`select id from public.${table} where id=$1`,[id])).rowCount,table).toBe(0);
    }
    expect((await c.query('select conversation_id from public.member_message_legal_holds where conversation_id=$1',[held.conversation])).rowCount).toBe(0);
    for (const [sql,args] of [
      ['select public.send_member_message($1,$2)',[held.conversation,'Authorization boundary test']],
      ["select public.schedule_member_message($1,'Authorization boundary test',now()+interval '1 day')",[held.conversation]],
      ["select public.send_member_resource($1,$2,'Resource boundary test')",[held.conversation,randomUUID()]],
      ["select public.send_steward_resource($1,$2,'Resource boundary test')",[held.conversation,randomUUID()]],
      ["select public.send_steward_reply($1,'Authorization boundary test')",[held.conversation]],
      ['select public.cancel_scheduled_member_message($1)',[held.draft]],
      ['select public.redact_member_message($1)',[held.message]],
      ["select public.toggle_member_message_reaction('private',$1,'thanks')",[held.message]],
      ["select public.toggle_member_saved_message('private',$1)",[held.message]],
      ["select public.create_member_message_reminder('private',$1,now()+interval '1 day','')",[held.message]],
      ["select public.persist_compass_message_briefing('private',$1,'Unrelated summary','[]','stale')",[held.conversation]],
      ["select public.decide_compass_workspace_action($1,'confirm')",[action]],
      ["select public.get_message_briefing_context('private',$1)",[held.conversation]],
      ["select public.propose_compass_workspace_action('message',$1,'Action request')",[held.message]],
      ["select public.create_chapter_task_from_source('message',$1)",[held.message]],
      ["select public.create_member_contact_note($1,'Contact note',$2)",[held.conversation,held.message]],
      ["select public.place_member_message_legal_hold($1,'litigation')",[held.conversation]],
    ]) {
      await c.query('savepoint denied');
      const result=await c.query(sql,args).then(()=>null,error=>error);
      expect(result,sql).not.toBeNull();
      expect(result?.code,sql).toMatch(/^(22023|42501|P0002|55000)$/);
      await c.query('rollback to denied');
    }
    const exported=(await c.query('select public.get_member_data_export() value')).rows[0].value;
    expect(JSON.stringify(exported)).not.toContain(held.conversation);
    expect(JSON.stringify(exported)).not.toContain(held.message);
    expect((await c.query('select public.release_member_message_legal_hold($1) value',[held.conversation])).rows[0].value).toEqual({released:false});
    await c.query('reset role');
    expect((await c.query('select released_at from public.member_message_legal_holds where conversation_id=$1',[held.conversation])).rows[0].released_at).toBeNull();
  } finally {await c.query('rollback');await c.end();}
});

for (const entry of ['send','schedule','task','steward-resource','member-resource']) for (const first of ['destruction','rpc']) live(`${entry} outer RPC serializes before parent locks: ${first} first`, async () => {
  const a=await connect(),b=await connect();let pending;
  try {
    const f=await fixture(a); await admin(a,f);
    await reader(a,f);
    await b.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:f.user,role:'authenticated',aal:'aal2',session_id:f.session})]);
    let parent=f.conversation, table='member_conversations';
    let sql='select public.send_member_message($1,\'Ordinary message\')', args=[parent];
    if(entry==='schedule') sql="select public.schedule_member_message($1,'Scheduled message',now()+interval '1 day')";
    if(entry==='task') {
      const recipient=await fixture(a);
      await a.query('update public.member_profiles set chapter_id=$2 where id=$1',[recipient.user,f.chapter]);
      parent=randomUUID();table='chapter_tasks';
      await a.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values ($1,'General',$2)",[f.chapter,f.user]);
      await a.query("insert into public.chapter_tasks(id,chapter_id,title,created_by,assignee_id,workstream) values ($1,$2,'Lock ordering',$3,$4,'General')",[parent,f.chapter,f.user,recipient.user]);
      sql="select public.send_chapter_task_message($1,'Task message')";args=[parent];
    }
    if(entry.endsWith('resource')) {
      // Published chapter resource exercises successful sends in both orders.
      const document=randomUUID();
      await a.query("insert into public.chapter_documents(id,chapter_id,title,document_type,visibility,status,created_by) values ($1,$2,'Resource proof','other','chapter','published',$3)",[document,f.chapter,f.user]);
      sql=`select public.send_${entry==='steward-resource'?'steward':'member'}_resource($1,$2,'Resource message')`;args=[parent,document];
      if(entry==='steward-resource') await legacyStewardFixtureWrite(a,"insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'steward') on conflict do nothing",[f.org,f.user]);
    }
    const waiting=await waitForAdvisory(a,b);
    await a.query('begin');await b.query('begin');
    if(first==='destruction') {
      await a.query('select private.lock_message_lifecycle()');
      pending=b.query(sql,args).then(value=>({value}),error=>({error}));
      expect(await waiting()).toBe(true);
      // A NOWAIT probe reproduces row-before-gate acquisition deterministically
      // without depending on the server's choice of deadlock victim.
      await a.query(`select id from public.${table} where id=$1 for update nowait`,[parent]);
      if(entry==='task') await a.query('delete from public.chapter_tasks where id=$1',[parent]);
      else await a.query('select private.dispatch_due_member_messaging(500)');
    } else {
      await a.query('savepoint invoke');
      const result=await a.query(sql,args).then(value=>({value}),error=>({error}));
      expect(result.error).toBeUndefined();
      pending=b.query(entry==='task'?'delete from public.chapter_tasks where id=$1':'delete from auth.users where id=$1',[entry==='task'?parent:f.user]).then(value=>({value}),error=>({error}));
      expect(await waiting()).toBe(true);
    }
    await a.query('commit');const result=await pending;
    expect(result.error?.code).not.toBe('40P01');
    if(result.error) expect(['22023','42501']).toContain(result.error.code);
  } finally {await a.query('rollback');await b.query('rollback');if(pending) await pending;await a.end();await b.end();}
});


live('every reviewed lifecycle RPC enters before initializers and authorization across two connections', async () => {
  const a=await connect(),b=await connect(); let pending;
  try {
    const sql=readFileSync('supabase/migrations/20260907122000_retire_dormant_channel_controls.sql','utf8');
    const ledger=[...sql.matchAll(/\('((?:public|private)\.[a-z0-9_]+\([^']*\))', '[a-f0-9]{32}'\)/g)].map(m=>m[1]);
    // REQ-UG-CASEWORK-CONSOLE-51-PROCEDURE-EVERY-PLANE-20260917 retired the
    // dormant W2 case-flow layer in
    // 20260917133000_casework_procedures_retire_w2.sql. Two entries of this
    // 20260907122000 ledger were W2 RPCs that the retirement drops, so their
    // entry-gate obligation is retired with them rather than weakened: the gate
    // orders a live entry point's lock acquisition, and a function that no
    // longer exists has no entry to order. tests/casework-retired-w2-layer.test.js
    // is the binding disposition and fails if any migration, client, script or
    // the database contract reintroduces either one. The exclusion is proved
    // here against the installed catalogue as well, so it can never silently
    // skip a function that is in fact still installed and ungated.
    const retiredW2Entries=['public.advance_case_step(uuid, text)','public.review_case_deadline_change(uuid, text)'];
    expect(ledger.filter(signature=>retiredW2Entries.includes(signature))).toEqual(retiredW2Entries);
    for(const signature of retiredW2Entries) {
      expect((await a.query('select to_regprocedure($1) as oid',[signature])).rows[0].oid,signature).toBeNull();
    }
    // Retired seed entries have no callable gate; prove their absence explicitly.
    const retiredEntries=ledger.filter(signature=>retiredIdentities.has(signatureIdentity(signature)));
    expect(retiredEntries).toHaveLength(47);
    for (const signature of retiredEntries) {
      expect((await a.query('select to_regprocedure($1) as oid',[signature])).rows[0].oid,signature).toBeNull();
    }
    // REQ-UG-SPANISH-SPACES-AND-POSTS-20261030 (20261030234500) replaced
    // the five-argument space editor with one that also takes the Spanish name
    // and description (scripts/db-contract.json functionsAbsent). The entry-gate
    // obligation moves to the successor, and the old signature is proved absent.
    // The article editor likewise replaces the coordinator update signature;
    // its successor must retain this same two-connection entry-gate proof.
    const replacedEntries=new Map([[
      'public.update_chapter_space_content(uuid, text, text, text, boolean)',
      'public.update_chapter_space_content(uuid, text, text, text, boolean, text, text)',
    ],[
      'public.coordinator_update_case(uuid, text, text, date, text)',
      'public.coordinator_update_case(uuid, text, text, date, text, text)',
    ],[
      // BUG-UG-FORM-APPROVAL-APPROVES-CONTENT-THE-STEWARD-NEVER-SAW-20261114
      // (#8707) adds the steward's reviewed expectation to the approval.
      'public.approve_and_open_case(uuid, text)',
      'public.approve_and_open_case(uuid, text, jsonb)',
    ]]);
    for(const [signature] of replacedEntries) {
      expect(ledger,signature).toContain(signature);
      expect((await a.query('select to_regprocedure($1) as oid',[signature])).rows[0].oid,signature).toBeNull();
    }
    const signatures=ledger.filter(signature=>!retiredW2Entries.includes(signature) && !retiredIdentities.has(signatureIdentity(signature)))
      .map(signature=>replacedEntries.get(signature) ?? signature);
    signatures.push('public.send_member_message(uuid, text)',
      'private.automation_v2_execute(uuid)', 'private.automation_v2_rollback_actions(uuid)');
    expect(signatures.length).toBe(62);
    const helper = (await a.query("select prosrc from pg_proc where oid='private.lock_case_graph(uuid[],uuid[])'::regprocedure")).rows[0].prosrc;
    expect(stripComments(helper).trim()).toMatch(/^declare[\s\S]*?\bbegin\s+perform private\.lock_message_lifecycle\(\);/i);
    const waiting=await waitForAdvisory(a,b);
    for(const signature of signatures) {
      const fn=(await a.query(`select p.prosrc, p.proisstrict, n.nspname||'.'||p.proname name,
        array(select format_type(t,null) from unnest(p.proargtypes::oid[]) t) types
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.oid=to_regprocedure($1)`,[signature])).rows[0];
      expect(stripComments(fn.prosrc).replace(/#variable_conflict use_variable/g,'').trim(),signature)
        .toMatch(/^(?:declare[\s\S]*?\bbegin|begin)\s+perform private\.(?:lock_message_lifecycle\(\)|lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\));/i);
      expect(fn.proisstrict,signature).toBe(false);
      await a.query('begin');await a.query('select private.lock_message_lifecycle()');
      pending=b.query(`select ${fn.name}(${fn.types.map(t=>`null::${t}`).join(',')})`).then(value=>({value}),error=>({error}));
      expect(await waiting(),signature).toBe(true);
      await a.query('commit');
      const result=await pending;
      expect(result.error?.code,signature).not.toBe('40P01');
    }
  } finally {await a.query('rollback');if(pending) await pending;await a.end();await b.end();}
}, 30000);

live('source-pinned outer gate installation refuses an unreviewed function body', async () => {
  const c=await connect();await c.query('begin');
  try {
    const migration=readFileSync('supabase/migrations/20260907122000_retire_dormant_channel_controls.sql','utf8');
    const installer=migration.slice(migration.indexOf('do $entry_gates$'),migration.indexOf('$entry_gates$;')+'$entry_gates$;'.length);
    // Re-installing against wrapped (different) sources must fail rather than
    // blindly rewrite them. This is the same fail-closed boundary as a later
    // migration changing a reviewed body or a combined B05 source mismatch.
    await expect(c.query(installer)).rejects.toThrow(/messaging entry source changed/);
  } finally {await c.query('rollback');await c.end();}
});

for (const consumer of ['conversation-owner', 'message-owner', 'draft-participants', 'briefing-requester', 'action-actor', 'hold-attribution', 'summary-view']) live(`${consumer}: two authenticated clients retain tenant isolation after owner detachment`, async () => {
  const setup=await connect(), owner=await connect(), other=await connect();
  try {
    const held=await fixture(setup), unrelated=await fixture(setup);
    await admin(setup,held); await admin(setup,unrelated);
    await legacyStewardFixtureWrite(setup,"insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'steward')",[unrelated.org,unrelated.user]);
    // Account deletion remains valid when another administrator retains the organization.
    const custodian=await fixture(setup);
    await setup.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')",[held.org,custodian.user]);
    await setup.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')",[held.org,custodian.user]);
    const briefing=randomUUID(), action=randomUUID();
    await setup.query("insert into public.compass_message_briefings(id,organization_id,requested_by,source_kind,target_id,summary,action_items) values ($1,$2,$3,'private',$4,'Held summary','[]')",[briefing,held.org,held.user,held.conversation]);
    await setup.query("insert into public.compass_workspace_actions(id,organization_id,actor_user_id,action_kind,source_kind,source_id,title) values ($1,$2,$3,'create_task','message',$4,'Held action')",[action,held.org,held.user,held.message]);
    await hold(setup,held);
    await setup.query('update public.member_message_legal_holds set placed_by=$2 where conversation_id=$1',[held.conversation,held.user]);
    for(const [client,f] of [[owner,held],[other,unrelated]]) {
      await client.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:f.user,role:'authenticated',aal:'aal2',session_id:f.session})]);
      await client.query('set role authenticated');
    }
    const [table,column,id]=({
      'conversation-owner':['member_conversations','id',held.conversation],
      'message-owner':['member_messages','id',held.message],
      'draft-participants':['member_scheduled_messages','id',held.draft],
      'briefing-requester':['compass_message_briefings','id',briefing],
      'action-actor':['compass_workspace_actions','id',action],
      'hold-attribution':['member_message_legal_holds','conversation_id',held.conversation],
      'summary-view':['member_conversation_summaries','conversation_id',held.conversation],
    })[consumer];
    const read=`select ${column} from public.${table} where ${column}=$1`;
    expect((await owner.query(read,[id])).rowCount).toBe(1);
    expect((await other.query(read,[id])).rowCount).toBe(0);
    await setup.query('delete from auth.users where id=$1',[held.user]);
    expect((await other.query(read,[id])).rowCount).toBe(0);
    expect((await owner.query(read,[id])).rowCount).toBe(0);
    // Privileged evidence inspection is separate from both authenticated readers.
    expect((await setup.query('select body from public.member_messages where id=$1',[held.message])).rows[0].body).toBe('delivered evidence');
    expect((await setup.query('select requested_by from public.compass_message_briefings where id=$1',[briefing])).rows[0].requested_by).toBeNull();
    expect((await setup.query('select actor_user_id from public.compass_workspace_actions where id=$1',[action])).rows[0].actor_user_id).toBeNull();
  } finally {await owner.end();await other.end();await setup.end();}
});

live('installed messaging writer, caller, FK-parent and trigger-host closure enters the gate', async () => {
  const c=await connect();
  try {
    const functions=(await c.query(`select p.oid, n.nspname||'.'||p.proname name,
      p.prorettype::regtype::text result, p.prosrc source from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private') and p.prokind='f'`)).rows;
    for(const f of functions) f.source=stripComments(f.source).toLowerCase();
    const fks=(await c.query(`select cn.nspname||'.'||child.relname child,
      pn.nspname||'.'||parent.relname parent from pg_constraint fk
      join pg_class child on child.oid=fk.conrelid join pg_namespace cn on cn.oid=child.relnamespace
      join pg_class parent on parent.oid=fk.confrelid join pg_namespace pn on pn.oid=parent.relnamespace
      where fk.contype='f'`)).rows;
    const triggers=(await c.query(`select n.nspname||'.'||r.relname relation,
      t.tgname name, t.tgfoid function_oid, t.tgtype::integer flags,
      pg_catalog.array_to_json(coalesce((select pg_catalog.array_agg(a.attname order by binding.ordinality)
        from pg_catalog.unnest(t.tgattr::smallint[]) with ordinality binding(attnum, ordinality)
        join pg_catalog.pg_attribute a on a.attrelid=t.tgrelid and a.attnum=binding.attnum), array[]::name[])) attributes
      from pg_trigger t
      join pg_class r on r.oid=t.tgrelid join pg_namespace n on n.oid=r.relnamespace
      where not t.tgisinternal and t.tgenabled in ('O','A')`)).rows;
    const roots=new Set(['member_conversations','member_messages','member_scheduled_messages',
      'member_message_legal_holds','compass_message_briefings','compass_workspace_actions',
      'chapter_thread_posts','chapter_task_messages','member_saved_messages',
      'member_message_reminders','member_message_reactions','member_message_resources'].map(t=>`public.${t}`));
    const writers=new Set();
    const literal=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    let size=-1;
    while(size!==roots.size+writers.size) {
      size=roots.size+writers.size;
      for(const fk of fks) if(roots.has(fk.child)) roots.add(fk.parent);
      const names=functions.filter(f=>writers.has(f.oid)).map(f=>f.name);
      for(const f of functions) if([...roots].some(t=>new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from)\\s+${literal(t)}\\b`).test(f.source))
        ||names.some(n=>new RegExp(`\\b${literal(n)}\\s*\\(`).test(f.source))) writers.add(f.oid);
      for(const t of triggers) if(writers.has(t.function_oid)) roots.add(t.relation);
    }
    const gate=functions.find(f=>f.name==='private.lock_message_lifecycle_statement').oid;
    for(const relation of roots) expect(triggers.some(t=>t.relation===relation&&t.function_oid===gate
      &&(t.flags&1)===0&&(t.flags&2)===2&&(t.flags&28)===28),relation).toBe(true);
    expect(triggers.find(t=>t.relation==='auth.users'&&t.name==='message_lifecycle_statement')?.attributes).toEqual([
      'id','instance_id','aud','role','email','phone','deleted_at','banned_until','is_sso_user',
      'is_anonymous','raw_user_meta_data','email_change','phone_change',
    ]);
    const entries=functions.filter(f=>writers.has(f.oid)&&f.result!=='trigger');
    // 114 before REQ-UG-CASEWORK-CONSOLE-51-PROCEDURE-EVERY-PLANE-20260917.
    // Re-derived against this same closure on an installed Main catalogue and
    // on the candidate: the retirement in
    // 20260917133000_casework_procedures_retire_w2.sql drops exactly the two
    // W2 entry points public.advance_case_step and
    // public.review_case_deadline_change, the configurable procedure adds
    // exactly one, public.casework_save_procedure (it migrates open cases, so
    // it reaches public.member_cases), and the root closure is unchanged at 27.
    // 114 - 2 + 1 = 113. Lane 5.6 (case macros, bulk edit/export and
    // @mentions on case notes) then adds exactly one more writer entry point:
    // 113 + 1 = 114. The org-chart delivery then adds exactly two:
    // public.import_organization_structure (20260924170000) and
    // public.start_member_steward_conversation (20260924170200): 114 + 2 = 116.
    // The organization-admin re-invitation (20260927100000) adds exactly one:
    // public.accept_former_member_invitation re-activates the former member's
    // organization membership and profile rows, which are FK parents of the
    // messaging roots: 116 + 1 = 117. The connected workflow shortcuts
    // (20260929090000) add exactly five: public.create_connected_workflow_task
    // (chapter_tasks is an FK parent of chapter_task_messages),
    // public.save_connected_workflow_reminder and
    // public.act_on_connected_workflow_reminder and
    // private.dispatch_due_workflow_reminders (member_message_reminders), and
    // public.send_connected_workflow_message (it calls the existing message
    // writers). Each opens with the case-graph gate, whose first act is the
    // message-lifecycle lock: 117 + 5 = 122.
    // Open signup adds create_my_organization, retaining all connected-workflow writers.
    // The engagement email one-click unsubscribe (20261002021000,
    // SEC-UG-ENGAGEMENT-EMAIL-OPT-OUT-UNSUBSCRIBE-20261001) adds exactly
    // one: public.apply_engagement_email_unsubscribe updates the member's own
    // member_profiles row, an FK parent of the messaging roots, and opens with
    // the case-graph gate: 123 + 1 = 124. /remind here (20261003033000,
    // REQ-UG-REMIND-HERE-20261001) adds exactly two that write
    // member_message_reminders, public.create_channel_here_reminder and
    // private.dispatch_due_here_reminders; each opens with the case-graph gate
    // and then the message-lifecycle lock: 124 + 2 = 126.
    // The restore-everything starter templates (20261002159000) add two
    // writers: public.load_casework_starter_procedure (it saves through
    // casework_save_procedure) and private.issue_new_member_starter_items (it
    // files the member's Get started Standard Task in chapter_tasks): 123 + 2.
    // Its join triggers make public.member_invitations and
    // public.organization_memberships trigger hosts of that writer, so both
    // join the gated roots (27 + 2 = 29) and the nine invitation RPCs that
    // write member_invitations become entry points; every one already opens
    // Invitation and deferred membership writers total 136 on repaired Main.
    // Here reminders add two, channel pinning one and SCIM nine: 148.
    // Founder invitation creation/delivery/resend add three: 151.
    // The officer display-title setter (20261004050000,
    // BUG-UG-INVITE-STARTING-ACCESS-NO-OFFICER-TITLES-20261003) updates
    // member_chapter_memberships, a gated trigger host, and opens with the
    // case-graph gate: 152.
    // Case title rename (20261009000500) updates member_cases and appends a
    // casework audit event, opening with the case-graph gate: 153.
    // Explicit budget-office assignment (20261009003000) adds one membership
    // writer, retaining the case-graph gate first: 153 + 1 = 154.
    // Retirement removes 47 pre-bot seed writers from the prior 154-entry closure.
    // The live graph still derives and checks every remaining writer and root.
    // Directory containment connects the bot ledger, founder audit and its
    // automation caller to this graph, bringing the closure to 152 entries.
    // The roster invitation create (20261022171700,
    // UX-UG-ROSTER-IMPORT-TAKES-DAYS-20261018) writes member_invitations,
    // a gated root, and opens with the case-graph gate: 152 + 1 = 153.
    // Member requests (20261030235900,
    // REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030) add
    // public.approve_member_request_invitation, which calls
    // public.create_member_invitation and opens with the case-graph gate:
    // 153 + 1 = 154.
    // The steward case intake (20261030204500,
    // REQ-UG-STEWARD-CASEWORK-GAPS-20261030) adds two member_cases
    // writers, public.open_member_case and public.claim_member_case; each opens
    // with the case-graph gate and then the message-lifecycle lock: 154 + 2 = 156.
    // Personal reminders (20261030234501,
    // REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030) add
    // public.save_personal_reminder and public.cancel_personal_reminder, which
    // write member_message_reminders and open with the case-graph gate: 156 + 2 = 158.
    // The member directory export (20261031020000,
    // REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030) appends its
    // organization_audit_ledger row, a gated root, and opens with the
    // case-graph gate: 158 + 1 = 159.
    // Standing handshake offers (20261101224749,
    // REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031)
    // add three that call private.chapter_connection_audit, an existing writer:
    // public.create_chapter_handshake_offer, public.withdraw_chapter_handshake_offer
    // and public.request_partner_founder_invitation, each opening with the
    // case-graph gate: 159 + 3 = 162.
    // Saved-chart sharing (20261102001534) adds public.share_pulse_chart: 162 + 1 = 163.
    // Every newly reached writer must retain its first-lock entry below.
    // The unit/committee parent graph adds its unit and committee writers.
    // Re-derived from installed functions and FKs; every entry still has the
    // first-lock and retired-seed checks below. 162 on Main, plus saved charts
    // (20261102001534) one, plus #6682's four, plus #6688's three.
    // Operator-verified bindings (20261102152429,
    // SEC-UG-TENANT-SELF-VERIFIED-UNION-OFFICE-BINDINGS-20261101) add
    // public.reopen_chapter_union_org_binding: 170 + 1 = 171.
    // The learning period engine (20261103163000,
    // REQ-UG-LEARNING-PERIOD-ENGINE-20261103) appends organization_audit_ledger
    // rows from six writers, each opening with the case-graph gate:
    // public.start_organization_learning_period, public.end_organization_learning_period_early,
    // public.undo_my_learning_action, public.run_learning_period_end_job,
    // private.close_learning_period and private.finish_learning_period: 171 + 6 = 177.
    // The task row under learning (20261103183000,
    // REQ-UG-LEARNING-PERIOD-TASKS-20261103) adds four gated writers of
    // chapter_tasks: public.create_chapter_task and public.update_chapter_task_fields
    // (replacing the direct client writes), private.learning_undo_task and the
    // private.learning_dispatch that reaches it: 177 + 4 = 181.
    // Case records under learning (20261104075000,
    // REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103) add two gated writers
    // of member_cases: public.update_my_member_case (replacing the member's direct
    // case update) and private.learning_undo_case: 181 + 2 = 183.
    // The onboarding reminder (20261104090000,
    // REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104) appends an
    // organization_audit_ledger row from one gated writer,
    // public.send_member_onboarding_reminder: 183 + 1 = 184.
    // Messages, notices, invitations and exports under learning
    // (20261104111500, REQ-UG-LEARNING-PERIOD-MESSAGES-NOTICES-INVITES-EXPORTS-20261103)
    // add six gated handlers (private.learning_undo_message_removal,
    // _scheduled_message, _message_mark, _message_reminder, _invitation_revoke and
    // _automation), the close step's private.learning_finish_held_messages and
    // private.learning_finish_held_message_removal, and the dispatcher and close
    // step the earlier slices left, now under their own names
    // (private.learning_dispatch_before_messages and
    // private.close_learning_period_before_messages): 184 + 10 = 194.
    // Membership, roles and settings under learning (20261104113000,
    // REQ-UG-LEARNING-PERIOD-MEMBERSHIP-ROLES-SETTINGS-20261103) add three
    // gated writers of member_profiles: public.update_my_member_profile (the web
    // client's own profile and settings save), private.learning_undo_own_profile
    // and private.learning_undo_chapter_membership, each opening with the
    // case-graph gate, and the installed dispatcher it renames and hands off
    // to, private.learning_dispatch_before_membership, which still reaches the
    // task, case, event and message handlers: 194 + 4 = 198.
    // Case access and assignment under learning (20261104120000,
    // REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103) add the
    // assignment and restriction undo handlers private.learning_undo_case_assignment
    // and private.learning_undo_case_restriction, gated writers of member_cases,
    // and private.learning_dispatch_before_case_access, the dispatcher it found
    // installed and hands off to: 198 + 3 = 201.
    // The case workflow slice (20261104123000) hands the undo dispatch off: the
    // dispatcher it found moves to private.learning_dispatch_before_case_workflow,
    // which still reaches every earlier slice's handlers: 201 + 1 = 202.
    // The own-preference tables slice (20261105182000) hands it off again: the
    // dispatcher it found moves to private.learning_dispatch_before_preferences,
    // which still reaches every earlier slice's handlers: 202 + 1 = 203.
    // The minute adapter reaches the existing messaging writers: 203 + 1.
    // The unit-aware invitation overload reaches
    // the same messaging closure and carries the existing case-graph gate.
    // The local-wide request (#7671) adds public.submit_local_wide_organization_claim,
    // which files through public.submit_organization_claim (it appends an
    // organization_audit_ledger row) and opens with the case-graph gate: 204 + 1.
    // Member-sent invitations (#8171) add public.create_member_sent_invitation
    // and public.record_member_sent_invitation_delivery, service-role invitation
    // writers that open with the case-graph gate like the other invitation
    // writers before them: 205 + 2. The task type conversion (#8211) adds
    // public.convert_chapter_task_to_template, which opens with the case-graph
    // gate too: 207 + 1. The unit-aware invitation overload of #7663 reaches the
    // same messaging closure and carries the case-graph gate: 208 + 1. The chapter
    // notice glow (#8627) adds public.set_chapter_notice_glow, a writer of
    // public.chapters (a trigger host) that opens with the case-graph gate: 209 + 1.
    // Per-unit settings (#7667) add public.create_unit_task_from_template, which
    // creates through public.create_chapter_task_from_template and opens with
    // the case-graph gate: 210 + 1.
    // #9160: create_intake_founder_invitation reaches the unchanged founder
    // writer; confirm_public_interest_stop now revokes its invitation chain,
    // and confirm_public_interest_unsubscribe calls that stop. All three enter
    // the same case-graph gate before graph writes. The operator-verified
    // stop now revokes the chain too: 211 + 4 = 215. Exact-source admissions
    // below retain the reviewed token/rate bookkeeping before those gates.
    // #9273 adds one graph-gated system-expiry helper: 215 + 1.
    // Group time zones (#9446, part 3) add public.set_group_time_zone, a writer
    // of public.chapters (a trigger host) that opens with the case-graph gate: 216 + 1.
    expect(entries.length).toBe(217);
    expect(entries.map(f => f.name)).toEqual(expect.arrayContaining([
      'public.create_intake_founder_invitation', 'public.confirm_public_interest_stop',
      'public.confirm_public_interest_unsubscribe', 'public.stop_public_interest',
    ]));
    expect(entries.some(entry => retiredSeeds.some(signature => signature.split('(')[0] === entry.name))).toBe(false);
    expect(entries.map(f => f.name)).toEqual(expect.arrayContaining([
      'private.automation_v2_execute', 'private.automation_v2_rollback_actions',
      'public.casework_save_procedure', 'public.import_organization_structure',
      'public.start_member_steward_conversation', 'public.accept_former_member_invitation',
      'public.create_roster_member_invitation', 'public.approve_member_request_invitation',
      'private.expire_member_invitation_email',
      'public.create_connected_workflow_task', 'public.save_connected_workflow_reminder',
      'public.start_organization_learning_period', 'public.undo_my_learning_action', 'public.run_learning_period_end_job',
      'public.create_chapter_task', 'public.update_chapter_task_fields', 'private.learning_undo_task', 'private.learning_dispatch', 'private.learning_dispatch_before_case_workflow', 'private.learning_dispatch_before_preferences',
      'public.update_my_member_case', 'private.learning_undo_case',
      'private.learning_undo_case_assignment', 'private.learning_undo_case_restriction', 'private.learning_dispatch_before_case_access',
      'public.act_on_connected_workflow_reminder', 'public.send_connected_workflow_message',
      'private.dispatch_due_workflow_reminders',
      'private.run_minute_cron_task',
      'public.create_my_organization',
      'public.apply_engagement_email_unsubscribe',
      'public.create_channel_here_reminder', 'private.dispatch_due_here_reminders',
      'public.load_casework_starter_procedure', 'private.issue_new_member_starter_items',
      'public.complete_member_invitation_activation', 'public.create_member_invitation',
      'public.create_organization_founder_invitation', 'public.record_organization_founder_invitation_delivery',
      'public.resend_organization_founder_invitation',
      'public.create_member_sent_invitation', 'public.record_member_sent_invitation_delivery',
      'public.set_chapter_thread_pinned',
      'public.set_member_chapter_display_title', 'public.set_chapter_budget_office',
      'public.casework_rename_case',
      'private.bot_production_mark_row', 'public.bot_production_mark',
      'public.open_member_case', 'public.claim_member_case',
      'public.save_personal_reminder', 'public.cancel_personal_reminder',
      'public.export_member_directory_csv',
      'public.share_pulse_chart',
      'public.save_chapter_financial_document', 'public.submit_chapter_financial_request',
      'public.decide_chapter_financial_request',
      'public.reopen_chapter_union_org_binding',
    ]));
    expect(entries.map(f => f.name)).toEqual(expect.not.arrayContaining([
      'public.advance_case_step', 'public.review_case_deadline_change',
    ]));
    // These six historical seed hosts no longer reach a messaging writer.
    expect([...roots]).toEqual(expect.not.arrayContaining([
      'private.demo_seed_function_catalog', 'private.demo_seed_function_evidence',
      'private.demo_seed_page_contract', 'private.demo_seed_page_evidence',
      'private.presg_demo_runs', 'private.uniondemo_runs',
    ]));
    // Unit/committee container parents are now reachable through scoped
    // records and must carry the same message-lifecycle statement gate.
    expect(roots.size).toBe(29);
    expect([...roots]).toEqual(expect.arrayContaining([
      'private.bot_production_marks', 'public.organization_audit_ledger',
      'public.organization_automation_settings',
      'private.chapter_units', 'private.chapter_committees',
    ]));
    expect(functions.find(f=>f.name==='private.lock_case_graph').source.trim())
      .toMatch(/^declare[\s\S]*?\bbegin\s+perform private\.lock_message_lifecycle\(\);/);
    // These exact-source admissions retain their reviewed pre-gate work and
    // delegate/acquire before graph writes. #9160 preserves the stop's token
    // lock before the graph gate and the unsubscribe adapter's delegation;
    // an eager adapter wrapper would invert that order against a direct stop.
    // Every other entry still opens with the gate.
    for(const f of entries) {
      if (['private.run_minute_cron_task', 'public.confirm_public_interest_stop',
        'public.confirm_public_interest_unsubscribe', 'public.stop_public_interest'].includes(f.name)) {
        const raw = (await c.query('select prosrc from pg_proc where oid=$1', [f.oid])).rows[0].prosrc;
        expect(reviewedPreGateRead({ name: f.name, source: raw })).toBe(true);
        continue;
      }
      expect(f.source.replace(/#variable_conflict use_variable/g,'').trim(),f.name)
        .toMatch(/^(?:declare[\s\S]*?\bbegin|begin)\s+perform private\.(?:lock_message_lifecycle\(\)|lock_case_graph\([^;]*\));/);
    }
  } finally {await c.end();}
});
