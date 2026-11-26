// @vitest-environment node
// #9274: retain C300's six real collision fixtures. Full responses are checked
// against their own created rows, never normalized by masking generated ids.
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {assertDisposableProofUrl} from '../scripts/run-required-db-proofs.mjs';
import {coordinationReplayFixture, coordinationReplayNames} from './helpers/coordination-operation-replay.mjs';

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const url = () => assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
async function as(db, f, user, sql, args) {
  await db.query('savepoint c305_call');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)", [f.claims(user)]);
    await db.query('set local role authenticated');
    const response = {ok:true, value:(await db.query(`select ${sql} v`, args)).rows[0].v};
    await db.query('reset role');
    await db.query('release savepoint c305_call');
    return response;
  } catch (error) {
    await db.query('rollback to savepoint c305_call');
    await db.query('release savepoint c305_call');
    return {ok:false, code:error.code, message:error.message, detail:error.detail ?? null, hint:error.hint ?? null};
  }
}
const mismatch = {ok:false,code:'22023',message:'idempotency key reused for a different request',detail:null,hint:null};
async function rowFor(db, c, id) {
  return (await db.query(`select * from ${c.table} where id=$1`, [id])).rows[0];
}
async function foreignState(db, f, c) {
  const tables = [[c.table,c.orgColumn],['public.organization_coordination_records','organization_id'],
    ['public.organization_coordination_events','organization_id'],['public.public_chapter_pages','organization_id'],
    ['private.mi1_w2_operation_receipt_rows','organization_id']];
  const state = {};
  for (const [table,column] of tables) state[table] = (await db.query(`select to_jsonb(t) row from ${table} t where ${column}=$1 order by to_jsonb(t)::text`, [f.O[1]])).rows;
  return state;
}
async function ownPublicState(db, f, c) {
  const tables = [[c.table,c.orgColumn],['public.organization_coordination_events','organization_id'],['public.public_chapter_pages','organization_id']];
  const state = {};
  for (const [table,column] of tables) state[table] = (await db.query(`select to_jsonb(t) row from ${table} t where ${column}=$1 order by to_jsonb(t)::text`, [f.O[0]])).rows;
  return state;
}
async function provenance(db, f, c, response) {
  expect(response.ok, JSON.stringify(response)).toBe(true);
  const id = response.value[c.field], row = await rowFor(db,c,id);
  expect(row, 'returned id must name a row created in the caller scope').toBeTruthy();
  expect(row[c.orgColumn]).toBe(f.O[0]);
  expect(row[c.actorColumn]).toBe(f.A);
  expect(row.idempotency_key).toBe(c.key);
  expect(response.value).toEqual(c.expected(row.id));
  expect((await db.query(`select count(*)::int n from ${c.table} where ${c.orgColumn}=$1 and idempotency_key=$2 and ${c.actorColumn}=$3`, [f.O[0],c.key,f.A])).rows[0].n).toBe(1);
  return row;
}

for (const name of coordinationReplayNames) live(`${name} operation scope`, () => {
  let db, f, c;
  beforeEach(async () => {
    db = new pg.Client({connectionString:url(),ssl:false}); await db.connect(); await db.query('begin');
    f = await coordinationReplayFixture(db); c = await f.prepare(name);
  });
  afterEach(async () => { if (db) { await db.query('rollback'); await db.end(); } });
  const call = (sql=c.sql, args=c.args, user=f.A) => as(db,f,user,sql,args);

  it('creates an own row for an unknown key and returns exactly that response on replay', async () => {
    const first = await call(); await provenance(db,f,c,first);
    const receipt = (await db.query('select request_payload from private.mi1_w2_operation_receipt_rows where organization_id=$1 and actor_user_id=$2 and operation=$3 and idempotency_key=$4',[f.O[0],f.A,name,c.key])).rows[0];
    expect(receipt.request_payload).toEqual({actor:f.A,requestHash:expect.stringMatching(/^[a-f0-9]{64}$/)});
    const before = await ownPublicState(db,f,c);
    expect(await call()).toEqual(first);
    expect(await ownPublicState(db,f,c)).toEqual(before);
  });

  it('treats a foreign-occupied key as unknown, preserving every foreign row and own provenance', async () => {
    const foreign = await f.seed(c.table,c.foreign), before = await foreignState(db,f,c);
    const first = await call(), own = await provenance(db,f,c,first);
    expect(own.id).not.toBe(foreign.id);
    expect(await foreignState(db,f,c)).toEqual(before);
    // A/B/A: add and remove the foreign collision around the same valid own
    // operation. Entire responses, including the unmasked id, must be equal.
    await db.query('savepoint remove_foreign');
    await db.query('set local session_replication_role=replica');
    await db.query(`delete from ${c.table} where id=$1`, [foreign.id]);
    await db.query('set local session_replication_role=origin');
    expect(await call()).toEqual(first);
    await db.query('rollback to savepoint remove_foreign'); await db.query('release savepoint remove_foreign');
    expect(await call()).toEqual(first);
    expect(await foreignState(db,f,c)).toEqual(before);
    const events = (await db.query("select metadata from public.organization_coordination_events where organization_id=$1", [f.O[0]])).rows;
    for (const event of events) expect(JSON.stringify(event)).not.toContain(foreign.id);
  });

  it('adopts a valid legacy own row without repeating its audit or page write, then binds actor and payload', async () => {
    const first = await call(); await provenance(db,f,c,first);
    await db.query('delete from private.mi1_w2_operation_receipt_rows where organization_id=$1 and operation=$2 and idempotency_key=$3', [f.O[0],name,c.key]);
    const before = await ownPublicState(db,f,c);
    expect(await call()).toEqual(first);
    expect(await ownPublicState(db,f,c)).toEqual(before);
    expect(await call(c.changed)).toEqual(mismatch);

    expect(await ownPublicState(db,f,c)).toEqual(before);
  });

  it('keeps the same operation key independent for another authorized actor', async () => {
    const mine = await call(); await provenance(db,f,c,mine);
    const other = await call(c.sql,c.args,f.U[4]);
    expect(other.ok,JSON.stringify(other)).toBe(true);
    expect(other.value[c.field]).not.toBe(mine.value[c.field]);
    const row = await rowFor(db,c,other.value[c.field]);
    expect(row[c.orgColumn]).toBe(f.O[0]); expect(row[c.actorColumn]).toBe(f.U[4]);
    expect(other.value).toEqual({...c.expected(row.id),...(name === 'take_over_public_chapter_page' ? {ownerId:f.U[4]} : {})});
    expect(await call(c.sql,c.args,f.U[4])).toEqual(other);
  });

  if (name === 'share_organization_coordination_resource') it('revalidates the live resource grant before returning a receipt', async () => {
    const first = await call(); await provenance(db,f,c,first);
    await db.query("update public.organization_network_permission_grants set status='revoked', revoked_at=pg_catalog.now() where grantor_organization_id=$1", [f.O[0]]);
    expect(await call()).toEqual({ok:false,code:'42501',message:'organization resource permission required',detail:null,hint:null});
  });

  if (name === 'propose_organization_coalition_decision') {
    it.each([[1,2],[3,5]])('review repair: adopts a legacy default threshold after participation grows from %s to %s', async (initial,total) => {
      const addParticipant = async () => {
        const id = randomUUID();
        await f.seed('public.organizations',{id,slug:'c305-participant-'+id,name:'Fictional C305 participant '+id});
        await f.seed('public.organization_coordination_organization_participants',{record_id:c.args[0],organization_id:id,role:'partner',status:'active'});
      };
      for (let i=1;i<initial;i++) await addParticipant();
      const sql = c.sql.replace("'authorize_work',1,", "'authorize_work',null,");
      const first = await call(sql);
      expect(first.ok,JSON.stringify(first)).toBe(true);
      expect(first.value.requiredApprovals).toBe(Math.floor(initial/2)+1);
      await db.query('delete from private.mi1_w2_operation_receipt_rows where organization_id=$1 and operation=$2 and idempotency_key=$3',[f.O[0],name,c.key]);
      for (let i=initial;i<total;i++) await addParticipant();
      const before = await ownPublicState(db,f,c);
      const adopted = {ok:true,value:{...first.value,eligibleOrganizations:total}};
      expect(await call(sql)).toEqual(adopted);
      expect(await call(sql)).toEqual(adopted);
      expect(await ownPublicState(db,f,c)).toEqual(before);
      expect(await call(sql.replace("'Fictional decision'", "'Changed decision'"))).toEqual(mismatch);
      // A fresh operation still uses today's majority, not the legacy value.
      const args = [...c.args]; args[2] = randomUUID();
      const fresh = await call(sql,args);
      expect(fresh.ok,JSON.stringify(fresh)).toBe(true);
      expect(fresh.value).toEqual({...first.value,decisionId:expect.any(String),requiredApprovals:Math.floor(total/2)+1,eligibleOrganizations:total});
      expect(fresh.value.decisionId).not.toBe(first.value.decisionId);
    });

    it('review repair: a legacy explicit threshold still binds the request', async () => {
      expect((await call()).ok).toBe(true);
      await db.query('delete from private.mi1_w2_operation_receipt_rows where organization_id=$1 and operation=$2 and idempotency_key=$3',[f.O[0],name,c.key]);
      await f.seed('public.organization_coordination_organization_participants',{record_id:c.args[0],organization_id:f.O[1],role:'partner',status:'active'});
      expect(await call(c.sql.replace("'authorize_work',1,", "'authorize_work',2,"))).toEqual(mismatch);
    });
  }

  if (name === 'run_organization_coordination_export') {
    const setExportSwitch = enabled => db.query("insert into public.organization_setting_values(organization_id,setting_key,value) values($1,'features.automation.scheduled_dataset_exports',$2::jsonb) on conflict (organization_id,setting_key) do update set value=excluded.value",[f.O[0],JSON.stringify(enabled)]);
    const setDataset = dataset => db.query('update public.organization_coordination_records set config=$2::jsonb where id=$1',[c.args[0],JSON.stringify({cadence:'daily',format:'json',deliveryMode:'internal_download',nextRunAt:'2099-01-01T00:00:00Z',dataset})]);
    for (const legacy of [false,true]) {
      for (const permission of ['role','switch','allowed']) it(`review repair: ${legacy ? 'legacy' : 'receipt'} export rechecks stored dataset (${permission})`, async () => {
        await setExportSwitch(true); await setDataset('members_directory');
        const first = await call();
        expect(first.ok,JSON.stringify(first)).toBe(true);
        const row = await rowFor(db,c,first.value.runId);
        expect(first.value).toEqual({runId:row.id,status:'ready',dataset:'members_directory',rowCount:row.row_count,deliveryMode:'internal_download'});
        if (legacy) await db.query('delete from private.mi1_w2_operation_receipt_rows where organization_id=$1 and operation=$2 and idempotency_key=$3',[f.O[0],name,c.key]);
        await setDataset('coordination_records');
        if (permission === 'role') await db.query("delete from public.organization_role_grants where organization_id=$1 and user_id=$2 and role in ('admin','vp')",[f.O[0],f.A]);
        if (permission === 'switch') await setExportSwitch(false);
        const before = await ownPublicState(db,f,c);
        const receipts = (await db.query('select * from private.mi1_w2_operation_receipt_rows where organization_id=$1',[f.O[0]])).rows;
        const expected = permission === 'allowed' ? first : {ok:false,code:'42501',message:permission === 'role' ? 'organization export role required' : 'scheduled dataset exports are turned off for this organization',detail:null,hint:null};
        expect(await call()).toEqual(expected);
        expect(await ownPublicState(db,f,c)).toEqual(before);
        if (permission !== 'allowed') expect((await db.query('select * from private.mi1_w2_operation_receipt_rows where organization_id=$1',[f.O[0]])).rows).toEqual(receipts);
        if (permission === 'role') await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')",[f.O[0],f.A]);
        if (permission === 'switch') await setExportSwitch(true);
        expect(await call()).toEqual(first);
      });
    }
  }

  it('refuses a valid different target using the same key', async () => {
    const first = await call(); await provenance(db,f,c,first);
    const args = [...c.args];
    if (name === 'take_over_public_chapter_page') {
      const page = (await db.query("select * from public.public_chapter_pages where organization_id=$1", [f.O[0]])).rows[0];
      delete page.id; page.slug = 'other-page'; await f.seed('public.public_chapter_pages',page);
      const other = c.sql.replace("'own-page'", "'other-page'");
      expect(await call(other)).toEqual(mismatch);
    } else {
      const original = (await db.query('select * from public.organization_coordination_records where id=$1', [args[0]])).rows[0];
      original.id = randomUUID(); original.idempotency_key = randomUUID();
      await f.seed('public.organization_coordination_records',original); args[0] = original.id;
      if (name === 'propose_organization_coalition_decision') {
        await f.seed('public.organization_coordination_organization_participants',{record_id:original.id,organization_id:f.O[0],role:'owner',status:'active'});
        const work = await f.rec(f.O[0],f.A,'coalition_work_item',{parent_id:original.id}); args[1] = work.id;
      }
      expect(await call(c.sql,args)).toEqual(mismatch);
    }
  });
});

// These fictional fixtures commit solely to this disposable database so two
// real transactions can see them; teardown removes their owned scopes.
async function cleanup(db, f) {
  await db.query('begin'); await db.query('set local session_replication_role=replica');
  const columns = (await db.query(`select table_schema,table_name,column_name from information_schema.columns
    where table_schema in ('public','private') and udt_name='uuid'
      and column_name in ('organization_id','sender_organization_id','proposing_organization_id','from_organization_id','to_organization_id','grantor_organization_id','grantee_organization_id')
      and exists(select 1 from information_schema.tables t where t.table_schema=columns.table_schema and t.table_name=columns.table_name and t.table_type='BASE TABLE')`)).rows;
  for (const r of columns) await db.query(`delete from "${r.table_schema}"."${r.table_name}" where "${r.column_name}"=any($1::uuid[])`, [f.O]);
  for (const table of ['public.member_roles','public.member_role_chapters','public.member_chapter_memberships','auth.sessions','auth.mfa_factors']) await db.query(`delete from ${table} where user_id=any($1::uuid[])`, [f.U]);
  await db.query('delete from public.member_profiles where id=any($1::uuid[])', [f.U]);
  await db.query('delete from auth.users where id=any($1::uuid[])', [f.U]);
  await db.query('delete from public.organizations where id=any($1::uuid[])', [f.O]);
  await db.query('commit');
}

live('coordination concurrent retries', () => {
  it.each(coordinationReplayNames.flatMap(name => [[name,false],[name,true]]))('%s serializes concurrent retries (changed payload: %s)', async (name,changed) => {
    const setup = new pg.Client({connectionString:url(),ssl:false});
    const first = new pg.Client({connectionString:url(),ssl:false}), second = new pg.Client({connectionString:url(),ssl:false});
    let f;
    await setup.connect(); await first.connect(); await second.connect();
    try {
      await setup.query('begin'); f = await coordinationReplayFixture(setup); const c = await f.prepare(name); await setup.query('commit');
      await first.query('begin'); await second.query('begin');
      await second.query("set local statement_timeout='10s'");
      const answer = await as(first,f,f.A,c.sql,c.args);
      expect(answer.ok,JSON.stringify(answer)).toBe(true);
      let completed = false;
      const pending = as(second,f,f.A,changed ? c.changed : c.sql,c.args).then(value => {completed=true; return value;});
      await new Promise(resolve => setTimeout(resolve,100));
      expect(completed).toBe(false);
      await first.query('commit');
      expect(await pending).toEqual(changed ? mismatch : answer);
      await second.query('commit');
      await provenance(setup,f,c,answer);
      if (name === 'propose_organization_coalition_decision') expect((await setup.query("select count(*)::int n from public.organization_coordination_events where organization_id=$1 and event_type='coalition_decision_proposed'", [f.O[0]])).rows[0].n).toBe(1);
    } finally {
      await first.query('rollback'); await second.query('rollback');
      await first.end(); await second.end();
      if (f) await cleanup(setup,f);
      await setup.end();
    }
  });
});
