import { installRetiredSeedUpgradeFixture } from './helpers/retired-seed-upgrade-fixture.mjs';
// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const path = name => new URL(`../supabase/migrations/${name}`, import.meta.url);
const read = name => readFileSync(path(name), 'utf8');
const sqlBody = sql => sql.replace(/^([\s\S]*?\n)begin;\n/i, '$1').replace(/\ncommit;\s*$/i, '\n');
const unlock = sqlBody(read('20261012010001_production_residue_seed_lanes_unlock.sql'));
const relock = sqlBody(read('20261012010002_production_residue_seed_lanes_relock.sql'));
const f1Path = path('20261012010000_production_residue_window_unlock.sql');
const live = process.env.REQUIRE_DB_REPAIR_PROOFS === '1' ? describe : describe.skip;
const integrated = process.env.REQUIRE_DB_REPAIR_PROOFS === '1' && existsSync(f1Path) ? describe : describe.skip;
const manifest = JSON.parse(readFileSync(new URL('../config/production-residue-seed-lanes-sources.json', import.meta.url), 'utf8'));
const signatures = manifest.functions.map(entry => entry.signature);
const productionRef = 'productionprojectref';
const unionRun = '109141a8-bb29-4b02-af4f-f00ff45ba2ea';
const stressRun = '6aae4c0b-856d-4fa9-a26c-ce21a1179f8d';
const confirmation = 'disposable-residue-window-proof';
const sha = text => createHash('sha256').update(text).digest('hex');

// F2 pins production's pre-repair case-owner body; the chain now carries the
// repair (BUG-UG-LEGACY-CASE-UNCHANGED-CHAPTER-UPDATE-20261014), so F4's
// captured definition is presented first. Ported from Union Ground's residue
// window rehearsal, which Union Ground does not carry.
const CASE_OWNER_SIGNATURE = 'private.mi1_bind_case_owner()';
const CASE_OWNER_PRODUCTION_SHA256 = 'a0ca1edb107a57c44c488f3de3218a3d6c186314531e94283f46b8e3ab2e0933';
const CASE_OWNER_REPAIRED_SHA256 = 'abd0334cc03635dcb0c7c709aee68b8f736f83c72fd39744c73a9341255cddcf';
// The later repair of the same trigger (20261113142500) refuses an owner whose
// chapter has no organization. Either repaired body is replaced by
// production's before anything is captured.
const CASE_OWNER_CHAPTER_REQUIRED_SHA256 = 'c098a76fc1e89508e8afeddc9eefa004b356431a71ea869216a79b0992b100f2';
const CASE_OWNER_REPAIRED_SHA256S = new Set([CASE_OWNER_REPAIRED_SHA256, CASE_OWNER_CHAPTER_REQUIRED_SHA256]);
const caseOwnerDefinition = async client => (await client.query(
  'select pg_catalog.pg_get_functiondef($1::regprocedure) definition', [CASE_OWNER_SIGNATURE])).rows[0].definition;
async function presentPreRepairCaseOwner(client) {
  const hash = sha(await caseOwnerDefinition(client));
  if (hash === CASE_OWNER_PRODUCTION_SHA256) return;
  if (!CASE_OWNER_REPAIRED_SHA256S.has(hash)) throw new Error(`${CASE_OWNER_SIGNATURE} is neither the production body nor the repaired body`);
  const captured = read('20261012010003_production_residue_window_relock.sql')
    .match(/CREATE OR REPLACE FUNCTION private\.mi1_bind_case_owner\(\)[\s\S]*?\$function\$\n[\s\S]*?\$function\$\n/)?.[0];
  if (!captured || sha(captured) !== CASE_OWNER_PRODUCTION_SHA256) throw new Error("F4's captured case-owner definition is not production's");
  await client.query(captured);
  if (sha(await caseOwnerDefinition(client)) !== CASE_OWNER_PRODUCTION_SHA256) throw new Error('case-owner production body alignment failed');
}

async function inRollback(operation) {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    application_name: 'production-residue-seed-lanes-proof' });
  await client.connect();
  await client.query('begin');
  // F2 pins production's pre-repair case-owner body; Main now carries the
  // repair (BUG-UG-LEGACY-CASE-UNCHANGED-CHAPTER-UPDATE-20261014).
  try { await installRetiredSeedUpgradeFixture(client); await presentPreRepairCaseOwner(client); await operation(client); }
  finally { await client.query('rollback').catch(() => {}); await client.end(); }
}
async function catalogue(client) {
  return (await client.query(`select wanted.signature,
    pg_get_functiondef(p.oid) definition, p.prosrc source, p.proacl, p.proowner, p.proconfig
    from unnest($1::text[]) wanted(signature)
    join pg_proc p on p.oid=wanted.signature::regprocedure order by 1`, [signatures])).rows;
}
async function refused(client, sql, parameters, message) {
  await client.query('savepoint refused');
  await expect(client.query(sql, parameters)).rejects.toThrow(message);
  await client.query('rollback to savepoint refused');
}
async function service(client) {
  await client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true), set_config('request.jwt.claim.role','service_role',true)");
}

live('production residue seed lane local roundtrip', () => {
  it('restores every definition, ACL, owner and setting exactly', async () => inRollback(async client => {
    const before = await catalogue(client);
    for (const row of before) {
      const entry = manifest.functions.find(entry => entry.signature.replaceAll(' ', '') === row.signature.replaceAll(' ', ''));
      expect(sha(row.definition)).toBe(entry.definition_sha256);
      expect(sha(row.source)).toBe(entry.source_sha256);
    }
    const guardsSql = "select pg_get_functiondef('private.uniondemo_authorize(text,text)'::regprocedure) sample, pg_get_functiondef('private.member_stress_authorize(text,text)'::regprocedure) stress";
    const guardsBefore = (await client.query(guardsSql)).rows[0];
    await client.query(unlock);
    expect(await catalogue(client)).not.toEqual(before);
    await client.query(relock);
    expect(await catalogue(client)).toEqual(before);
    expect((await client.query(guardsSql)).rows[0]).toEqual(guardsBefore);
    expect((await client.query("select to_regprocedure('private.production_residue_actors_owned(uuid,jsonb,boolean)') value")).rows[0].value).toBeNull();
  }));

  it('keeps every temporary helper and retained ownership table closed to client roles', async () => inRollback(async client => {
    await client.query(unlock);
    const { rows } = await client.query(`select bool_and(not has_function_privilege(role, signature, 'execute')) closed
      from unnest(array['anon','authenticated','service_role']) role
      cross join unnest(array['private.production_residue_actors_owned(uuid,jsonb,boolean)',
        'private.production_residue_uniondemo_preflight(text,uuid,text)',
        'private.production_residue_seed_root_known(uuid,text,jsonb)',
        'private.production_residue_root_owned(uuid,text,jsonb,text)',
        'private.production_residue_seed_kept_scope(text,uuid)',
        'private.production_residue_seed_assert_active()']) signature`);
    expect(rows[0].closed).toBe(true);
    const publicGrants = await client.query(`select count(*)::int grants from pg_proc p,
      lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      where p.oid=any($1::regprocedure[]) and acl.grantee=0 and acl.privilege_type='EXECUTE'`,
    [['private.production_residue_actors_owned(uuid,jsonb,boolean)', 'private.production_residue_uniondemo_preflight(text,uuid,text)']]);
    expect(publicGrants.rows[0].grants).toBe(0);
    expect((await client.query(`select bool_and(not has_table_privilege(role,
      'private.production_residue_root_ownership','select,insert,update,delete')) closed
      from unnest(array['anon','authenticated','service_role']) role`)).rows[0].closed).toBe(true);
    await client.query(relock);
    expect((await client.query("select to_regclass('private.production_residue_root_ownership') value")).rows[0].value).toBeNull();
  }));

  it.each(manifest.functions.filter(entry => entry.main_replay_variant_sha256))(
    'production-pinned installation refuses the predecessor LF variant: $signature',
    async entry => inRollback(async client => {
      const { rows: [row] } = await client.query('select pg_get_functiondef($1::regprocedure) definition', [entry.signature]);
      const variant = row.definition.replace('AS $function$\n', 'AS $function$\n\n');
      expect(sha(variant)).toBe(entry.main_replay_variant_sha256);
      await client.query(variant);
      const { rows: [identity] } = await client.query(`select system_identifier::text system_identifier,
        (select oid::text from pg_database where datname=current_database()) database_oid from pg_control_system()`);
      const pinned = unlock.replace('7662742571317219726', identity.system_identifier)
        .replace(/(pinned_database_oid constant oid := )5/, `$1${identity.database_oid}`);
      await refused(client, pinned, [], /source changed; unlock refused/);
      expect((await client.query("select to_regprocedure('private.production_residue_actors_owned(uuid,jsonb,boolean)') value")).rows[0].value).toBeNull();
    }),
  );

  it('non-production admits only the four listed LF variants and refuses a third hash', async () => inRollback(async client => {
    const before = await catalogue(client);
    const variants = [];
    for (const entry of manifest.functions.filter(entry => entry.main_replay_variant_sha256)) {
      const original = before.find(row => row.signature === entry.signature).definition;
      const variant = original.replace('AS $function$\n', 'AS $function$\n\n');
      expect(sha(variant)).toBe(entry.main_replay_variant_sha256);
      variants.push(variant);
      await client.query(variant);
    }
    await client.query(variants[0].replace('AS $function$\n\n', 'AS $function$\n\n\n'));
    await refused(client, unlock, [], /source changed; unlock refused/);
    await client.query(variants[0]);
    await client.query(unlock);
    await client.query(relock);
    expect(await catalogue(client)).toEqual(before);
  }));

  it('refuses source drift before creating a temporary capability', async () => inRollback(async client => {
    const before = await catalogue(client);
    await client.query(before[0].definition.replace('\nend;', '\n-- simulated local drift\nend;'));
    const drifted = await catalogue(client);
    await refused(client, unlock, [], /source changed; unlock refused/);
    expect((await client.query("select to_regprocedure('private.production_residue_actors_owned(uuid,jsonb,boolean)') value")).rows[0].value).toBeNull();
    await refused(client, relock, [], /source changed; relock refuses overwrite/);
    expect(await catalogue(client)).toEqual(drifted);
  }));

  it('can relock an unchanged installation when F2 did not run', async () => inRollback(async client => {
    const before = await catalogue(client);
    await client.query(relock);
    expect(await catalogue(client)).toEqual(before);
  }));

  it('rejects unknown actors and actorless root content', async () => inRollback(async client => {
    await client.query(unlock);
    const id = randomUUID();
    const { rows } = await client.query(`select
      private.production_residue_actors_owned($1, '{}'::jsonb, false) child,
      private.production_residue_actors_owned($1, '{}'::jsonb, true) root,
      private.production_residue_actors_owned($1, jsonb_build_object('created_by',$2::text),true) outsider,
      private.production_residue_actors_owned($1, '{"created_by":"malformed"}'::jsonb,true) malformed`, [unionRun,id]);
    expect(rows[0]).toEqual({ child: true, root: false, outsider: false, malformed: false });
  }));

  it('preserves legacy target refusals outside the production branch without F1', async () => inRollback(async client => {
    await client.query(unlock);
    await service(client);
    for (const lane of ['uniondemo','member_stress']) {
      await refused(client, `select public.${lane}_begin_remove($1,$2,$3)`,
        [randomUUID(),'not-production','disposable-invalid-marker'], /target mismatch/);
    }
  }));

  it('runs the actor preflight without creating or changing any object', async () => inRollback(async client => {
    await client.query('set transaction read only');
    expect((await client.query('show transaction_read_only')).rows[0].transaction_read_only).toBe('on');
    const raw = readFileSync(new URL('./fixtures/retained-seed-actor-preflight.sql', import.meta.url), 'utf8');
    const sql = raw.replace(/begin transaction isolation level repeatable read read only;/i, '').replace(/rollback;\s*$/i, '');
    const results = await client.query(sql);
    const result = results.find(result => result.rows?.length)?.rows[0];
    expect(Object.values(result)[0]).toMatchObject({ state: 'clear', unowned_content: 0, unowned_profiles: 0, foreign_tables: 0 });
  }));
});

async function seedAccounts(client, lane, count = 2) {
  const run = lane === 'uniondemo' ? unionRun : stressRun;
  const users = (await client.query(`select user_id id,email from private.${lane}_ledger
    where run_id=$1 order by ordinal limit $2`, [run,count])).rows;
  for (const user of users) {
    await client.query('insert into auth.users(id,email,raw_app_meta_data) values($1,$2,$3)',
      [user.id,user.email,JSON.stringify({ [`${lane}_run_id`]: run })]);
  }
  return users.map(user => user.id);
}

async function callBatch(client, lane) {
  return (await client.query(`select public.${lane}_remove_batch($1,1,$2,$3) result`,
    [lane === 'uniondemo' ? unionRun : stressRun,productionRef,confirmation])).rows[0].result;
}

async function retainedFixture(client) {
  const user=randomUUID(), org=randomUUID(), chapter=`proof-kept-${randomUUID()}`;
  await client.query("insert into auth.users(id,email) values($1,'kept@example.invalid')", [user]);
  await client.query("insert into public.organizations(id,name,slug,created_by) values($1,'Kept proof',$2,$3)", [org,org,user]);
  await client.query("insert into public.chapters(id,name,slug,order_index,organization_id) values($1,'Kept chapter',$1,0,$2)", [chapter,org]);
  await client.query(`insert into private.production_residue_ledger(subject_kind,subject_id,cohort,own_domain)
    values('account',$1,'account-kept',true),('organization',$2,'org-kept',true),('chapter',$3,'chapter-kept',true)`, [user,org,chapter]);
  return {user,org,chapter};
}

async function actorPreflight(client) {
  const raw=readFileSync(new URL('./fixtures/retained-seed-actor-preflight.sql', import.meta.url), 'utf8');
  const sql=raw.replace(/begin transaction isolation level repeatable read read only;/i,'').replace(/rollback;\s*$/i,'');
  return Object.values((await client.query(sql)).find(result=>result.rows?.length).rows[0])[0];
}

integrated('R2 adversarial regressions on real database mutations', () => {
  it.each(['uniondemo','member_stress'])('%s preserves unrelated shared-proof rows while still refusing new unaccounted users', async lane => inRollback(async client => {
    // Required proofs share a database; earlier files may retain unrelated rows.
    const user=randomUUID(), org=randomUUID();
    await client.query('insert into auth.users(id,email) values($1,$2)',[user,`prior-proof-${user}@example.invalid`]);
    await client.query("insert into public.organizations(id,name,slug) values($1,'Prior proof',$2)",[org,org]);
    const snapshot=async () => (await client.query(`select
      (select to_jsonb(u) from auth.users u where id=$1) account,
      (select to_jsonb(o) from public.organizations o where id=$2) organization`,[user,org])).rows[0];
    const before=await snapshot();
    await integratedFixture(client); await seedRun(client,lane,[],[]);
    await seedAccounts(client,lane);
    await client.query(`update private.${lane}_runs set state='removing' where id=$1`,[lane==='uniondemo'?unionRun:stressRun]);
    const unexpected=randomUUID();
    await client.query('insert into auth.users(id,email) values($1,$2)',[unexpected,`unaccounted-${unexpected}@example.invalid`]);
    await refused(client,`select public.${lane}_remove_batch($1,1,$2,$3)`,
      [lane==='uniondemo'?unionRun:stressRun,productionRef,confirmation],/protected remainder/);
    await client.query('delete from auth.users where id=$1',[unexpected]);
    expect(await callBatch(client,lane)).toMatchObject({deleted:1,remaining:1,state:'removing'});
    expect(await callBatch(client,lane)).toMatchObject({deleted:1,remaining:0,state:'removed'});
    expect(await snapshot()).toEqual(before);
  }));

  it.each(['organization-scoped','historical-ownerless'])('removes all five actorless seed root types with exact %s provenance across batches', async shape => inRollback(async client => {
    await integratedFixture(client); await seedRun(client,'uniondemo',[],[]);
    await seedAccounts(client,'uniondemo');
    const organization=(await client.query("select private.member_stress_uuid($1 || ':ud:organization') id",[unionRun])).rows[0].id;
    const chapter=`ud-actorless-${randomUUID()}`;
    await client.query("insert into public.organizations(id,name,slug) values($1,'Seed provenance',$2)",[organization,organization]);
    await client.query("insert into private.production_residue_ledger(subject_kind,subject_id,cohort,own_domain) values('organization',$1,'org',false)",[organization]);
    // Historical production chapters predate the ownerless-write guard.
    // Reproduce only that historical row shape, then restore the real guard.
    if (shape==='historical-ownerless') await client.query('alter table public.chapters disable trigger chapters_forbid_ownerless_write');
    await client.query("insert into public.chapters(id,name,slug,order_index,organization_id) values($1,'Seed provenance',$1,0,$2)",
      [chapter,shape==='historical-ownerless'?null:organization]);
    if (shape==='historical-ownerless') await client.query('alter table public.chapters enable trigger chapters_forbid_ownerless_write');
    await client.query(`insert into private.uniondemo_chapters(run_id,chapter_index,chapter_id,chapter_name,agency,first_ordinal,member_count,steward_count)
      values($1,1,$2,'Seed provenance','Proof',1,1500,3)`,[unionRun,chapter]);
    const workstream=(await client.query("select private.member_stress_uuid($1 || ':ch1:ud:ws:Chapter') id",[unionRun])).rows[0].id;
    await client.query("insert into public.chapter_workstreams(id,chapter_id,name,created_by) values($1,$2,'Chapter',null)",[workstream,chapter]);
    await client.query(`insert into public.member_ballots(id,title,body,closes_at,active,order_index,chapter_id,campaign_state,created_by)
      values('ud-ballot-01-01','Seed ballot','Chapter vote for Seed provenance: review the materials in the broadcast archive, then cast your ballot.',now(),false,41021,$1,'closed',null)`,[chapter]);
    await client.query(`insert into public.member_surveys(id,title,body,closes_at,active,order_index,chapter_id,campaign_state,created_by)
      values('ud-pulse-01-01','Seed survey','Two questions, thirty seconds. Chapter results are shared at the next meeting.',now(),false,42021,$1,'closed',null)`,[chapter]);
    await client.query(`insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id,is_public,organizer_id)
      values('ud-evt-01-nx-1','Chapter meeting',now(),'Chapter hall + Zoom','Bargaining survey vote and contract update.','SG-U01N1',1300,$1,false,null),
      ('ud-evt-01-cm-00','Chapter meeting — Oct 2026','2026-10-20 18:00+00','Chapter hall + Zoom','Officer reports, grievance and bargaining updates, member Q&A.','SG-U01M00',1000,$1,false,null),
      ('ud-evt-01-tr-01','Steward training — Oct 2026','2026-10-20 17:30+00','Union office · Training room','Weingarten rights, Step 1 practice, and casework intake for chapter stewards.','SG-U01T01',1101,$1,false,null),
      ('ud-evt-01-ac-1','Contract action day — Oct 2026','2026-10-20 16:00+00','Agency headquarters','Chapter turnout event: bring a coworker and wear your chapter shirt.','SG-U01A1',1201,$1,true,null)`,[chapter]);
    if (shape==='historical-ownerless') {
      await client.query('set constraints all immediate');
      await client.query('alter table public.member_broadcasts disable trigger member_broadcasts_forbid_ownerless_write');
    }
    await client.query(`insert into public.member_broadcasts(id,sender,title,body,published_at,order_index,created_by,locale,organization_id,chapter_id,audience_scope)
      values('ud-bc-001','Bargaining team','Contract enforcement wins this week','Three grievances settled at Step 2 this week, including a full back-pay award. Details and what they mean for your worksite.',now(),40001,null,'en',$1,$2,$3),
      ('ud-bc-014','Steward council','Actualización estatal — semana 14','Resumen semanal para todos los capítulos: negociaciones, casos y próximos pasos.',now(),40014,null,'es',$1,$2,$3)`,
    shape==='historical-ownerless'?[null,null,null]:[organization,chapter,'organization']);
    if (shape==='historical-ownerless') {
      // Scoped content has deferred container FKs. Finish those checks before
      // restoring the historical fixture's owner guard with ALTER TABLE.
      await client.query('set constraints all immediate');
      await client.query('alter table public.member_broadcasts enable trigger member_broadcasts_forbid_ownerless_write');
    }
    for (const table of ['chapter_workstreams','member_ballots','member_surveys','member_events','member_broadcasts']) {
      const counts=(await client.query(`select count(*)::int total,
        count(*) filter (where private.production_residue_seed_root_known($1,$2,to_jsonb(row_value)))::int known
        from public.${table} row_value where ${table==='chapter_workstreams'?'chapter_id=$3':"id like $3"}`,
      [unionRun,table,table==='chapter_workstreams'?chapter:{member_ballots:'ud-ballot-%',member_surveys:'ud-pulse-%',member_events:'ud-evt-%',member_broadcasts:'ud-bc-%'}[table]])).rows[0];
      expect(counts.known,table).toBe(counts.total);
    }
    expect((await actorPreflight(client)).state).toBe('clear');
    for (const [table,id] of [['chapter_workstreams',workstream],['member_ballots','ud-ballot-01-01'],['member_surveys','ud-pulse-01-01'],
      ['member_events','ud-evt-01-nx-1'],['member_broadcasts','ud-bc-001']]) {
      expect((await client.query(`select private.production_residue_seed_root_known($1,$2,
        to_jsonb(row_value) || jsonb_build_object('organization_id',$4::text)) known
        from public.${table} row_value where id::text=$3`,[unionRun,table,id,randomUUID()])).rows[0].known).toBe(false);
      await client.query('savepoint seed_marker');
      if (table==='chapter_workstreams') await client.query('update public.chapter_workstreams set name=$1 where id=$2',['Unproven',id]);
      else await client.query(`update public.${table} set order_index=order_index+100000 where id=$1`,[id]);
      expect((await actorPreflight(client)).unowned_content).toBe(1);
      await refused(client,"select private.production_residue_uniondemo_preflight('remove-batch',$1,$2)",[unionRun,productionRef],/unproven actor/);
      await client.query('rollback to savepoint seed_marker');
    }
    for (const [table,id,field] of [['member_events','ud-evt-01-nx-1','summary'],['member_broadcasts','ud-bc-001','body']]) {
      await client.query('savepoint seed_text');
      await client.query(`update public.${table} set ${field}='Unproven content' where id=$1`,[id]);
      expect((await actorPreflight(client)).unowned_content).toBe(1);
      await refused(client,"select private.production_residue_uniondemo_preflight('remove-batch',$1,$2)",[unionRun,productionRef],/unproven actor/);
      await client.query('rollback to savepoint seed_text');
    }
    const foreign=randomUUID();
    await client.query("insert into auth.users(id,email) values($1,'foreign-seed-provenance@example.invalid')",[foreign]);
    await client.query('savepoint foreign_seed_actor');
    await client.query("update public.member_surveys set created_by=$1 where id='ud-pulse-01-01'",[foreign]);
    expect((await actorPreflight(client)).unowned_content).toBe(1);
    await refused(client,"select private.production_residue_uniondemo_preflight('remove-batch',$1,$2)",[unionRun,productionRef],/unproven actor/);
    await client.query('rollback to savepoint foreign_seed_actor');
    for (const [table,id,field] of [['member_events','ud-evt-01-nx-1','organizer_id'],['member_broadcasts','ud-bc-001','created_by']]) {
      await client.query('savepoint foreign_seed_actor');
      await client.query(`update public.${table} set ${field}=$1 where id=$2`,[foreign,id]);
      expect((await actorPreflight(client)).unowned_content).toBe(1);
      await refused(client,"select private.production_residue_uniondemo_preflight('remove-batch',$1,$2)",[unionRun,productionRef],/unproven actor/);
      await client.query('rollback to savepoint foreign_seed_actor');
    }
    await client.query('delete from auth.users where id=$1',[foreign]);
    await client.query('select public.uniondemo_begin_remove($1,$2,$3)',[unionRun,productionRef,confirmation]);
    expect(await callBatch(client,'uniondemo')).toMatchObject({deleted:1,remaining:1,state:'removing'});
    expect((await client.query("select count(*)::int n from public.member_events where id like 'ud-evt-01-%'")).rows[0].n).toBe(4);
    expect((await client.query("select count(*)::int n from public.member_broadcasts where id in ('ud-bc-001','ud-bc-014')")).rows[0].n).toBe(2);
    expect(await callBatch(client,'uniondemo')).toMatchObject({deleted:1,remaining:0,state:'removed'});
    expect((await client.query('select count(*)::int n from public.chapter_workstreams where id=$1',[workstream])).rows[0].n).toBe(0);
    expect((await client.query("select count(*)::int n from public.member_events where id like 'ud-evt-01-%'")).rows[0].n).toBe(0);
    expect((await client.query("select count(*)::int n from public.member_broadcasts where id in ('ud-bc-001','ud-bc-014')")).rows[0].n).toBe(0);
  }));

  it('requires one valid kept pair in the read-only preflight after F1', async () => inRollback(async client => {
    await integratedFixture(client);
    expect((await actorPreflight(client)).state).toBe('clear');
    await client.query('savepoint kept_pin');
    await client.query('delete from private.production_residue_kept_scope');
    await expect(actorPreflight(client)).rejects.toThrow(/kept baseline pair/);
    await client.query('rollback to savepoint kept_pin');
    await client.query('update private.production_residue_kept_scope set chapter_id=$1',[`missing-${randomUUID()}`]);
    await expect(actorPreflight(client)).rejects.toThrow(/kept baseline pair/);
    await client.query('rollback to savepoint kept_pin');
  }));

  it('recognizes owned event organizers, rejects foreign/absent ones, and agrees with read-only preflight', async () => inRollback(async client => {
    await integratedFixture(client); await seedRun(client,'uniondemo',[],[]);
    const [owner]=await seedAccounts(client,'uniondemo');
    const outsider=randomUUID();
    await client.query("insert into auth.users(id,email) values($1,'foreign@example.invalid')",[outsider]);
    const org=randomUUID();
    await client.query("insert into public.organizations(id,name,slug) values($1,'Proof event',$2)",[org,org]);
    await client.query("insert into private.production_residue_ledger(subject_kind,subject_id,cohort,own_domain) values('organization',$1,'org',false)",[org]);
    await client.query("insert into public.chapters(id,name,slug,order_index,organization_id) values('proof-event','Proof event','proof-event',0,$1)",[org]);
    await client.query(`insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,organizer_id,chapter_id)
      values('ud-evt-proof','Event proof',now(),'Proof','Proof','SG-PROOF',-999,$1,'proof-event')`,[owner]);
    expect((await actorPreflight(client)).unowned_content).toBe(0);
    await client.query("select private.production_residue_uniondemo_preflight('remove-batch',$1,$2)",[unionRun,productionRef]);
    await client.query("update public.member_events set organizer_id=$1 where id='ud-evt-proof'",[outsider]);
    expect((await actorPreflight(client)).unowned_content).toBe(1);
    await refused(client,"select private.production_residue_uniondemo_preflight('remove-batch',$1,$2)",[unionRun,productionRef],/unproven actor/);
    await client.query("update public.member_events set organizer_id=null where id='ud-evt-proof'");
    expect((await actorPreflight(client)).unowned_content).toBe(1);
    await refused(client,"select private.production_residue_uniondemo_preflight('remove-batch',$1,$2)",[unionRun,productionRef],/unproven actor/);
  }));

  it('finishes consecutive batches after all five root creators are cleared by Auth cascades', async () => inRollback(async client => {
    await integratedFixture(client); await seedRun(client,'uniondemo',[],[]);
    const [owner]=await seedAccounts(client,'uniondemo');
    const org=randomUUID(), chapter=`ud-proof-${randomUUID()}`, stream=randomUUID();
    await client.query("insert into public.organizations(id,name,slug) values($1,'Proof',$2)",[org,org]);
    await client.query("insert into private.production_residue_ledger(subject_kind,subject_id,cohort,own_domain) values('organization',$1,'org',false)",[org]);
    await client.query("insert into public.chapters(id,name,slug,order_index,organization_id) values($1,'Proof',$1,0,$2)",[chapter,org]);
    await client.query(`insert into private.uniondemo_chapters(run_id,chapter_index,chapter_id,chapter_name,agency,first_ordinal,member_count,steward_count)
      values($1,1,$2,'Proof','Proof',1,1500,3)`,[unionRun,chapter]);
    await client.query('insert into public.chapter_workstreams(id,chapter_id,name,created_by) values($1,$2,\'Proof\',$3)',[stream,chapter,owner]);
    await client.query(`insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,organizer_id,chapter_id)
      values('ud-evt-proof','Proof',now(),'Proof','Proof','SG-PROOF',-999,$1,$2)`,[owner,chapter]);
    for (const [table,prefix] of [['member_ballots','ud-ballot-'],['member_surveys','ud-pulse-']]) {
      await client.query(`insert into public.${table}(id,title,closes_at,order_index,created_by,chapter_id,organization_id,active,campaign_state)
        values($1,'Proof',now()+interval '1 day',-999,$2,$3,$4,false,'draft')`,[`${prefix}proof`,owner,chapter,org]);
    }
    await client.query(`insert into public.member_broadcasts(id,sender,title,body,published_at,order_index,created_by,chapter_id,organization_id,audience_scope)
      values('ud-bc-proof','Proof','Proof','Proof',now(),-999,$1,$2,$3,'chapter')`,[owner,chapter,org]);
    await client.query("update private.uniondemo_runs set state='removing' where id=$1",[unionRun]);
    expect(await callBatch(client,'uniondemo')).toMatchObject({deleted:1,remaining:1,state:'removing'});
    expect((await client.query('select created_by from public.chapter_workstreams where id=$1',[stream])).rows[0].created_by).toBeNull();
    // A remembered owner is not permission to change root content or invent roots.
    await client.query("update public.chapter_workstreams set name='Changed' where id=$1",[stream]);
    await refused(client,'select public.uniondemo_remove_batch($1,1,$2,$3)',[unionRun,productionRef,confirmation],/unproven actor/);
    await client.query("update public.chapter_workstreams set name='Proof' where id=$1",[stream]);
    expect(await callBatch(client,'uniondemo')).toMatchObject({deleted:1,remaining:0,state:'removed'});
    expect((await client.query("select count(*)::int n from public.member_events where id='ud-evt-proof'")).rows[0].n).toBe(0);
  }));

  it.each(['uniondemo','member_stress'])('%s refuses kept grant subjects and grantors without changing rows', async lane => inRollback(async client => {
    await integratedFixture(client); await seedRun(client,lane,[],[]);
    const [candidate]=await seedAccounts(client,lane);
    const kept=await retainedFixture(client);
    await client.query(`update private.${lane}_runs set state='removing' where id=$1`,[lane==='uniondemo'?unionRun:stressRun]);
    for (const subject of [true,false]) {
      await client.query('savepoint grant_case');
      await client.query("insert into public.organization_memberships(organization_id,user_id) values($1,$2)",[kept.org,subject?candidate:kept.user]);
      await client.query(`insert into public.organization_role_grants(organization_id,user_id,role,granted_by)
        values($1,$2,'admin',$3)`,[kept.org,subject?candidate:kept.user,subject?kept.user:candidate]);
      const before=(await client.query('select to_jsonb(g) row from public.organization_role_grants g where organization_id=$1',[kept.org])).rows;
      await refused(client,`select public.${lane}_remove_batch($1,1,$2,$3)`,[lane==='uniondemo'?unionRun:stressRun,productionRef,confirmation],/kept scope/);
      expect((await client.query('select to_jsonb(g) row from public.organization_role_grants g where organization_id=$1',[kept.org])).rows).toEqual(before);
      expect((await client.query('select count(*)::int n from auth.users where id=$1',[candidate])).rows[0].n).toBe(1);
      await client.query('rollback to savepoint grant_case');
      await client.query('savepoint role_case');
      await client.query("insert into public.member_roles(user_id,role,chapter_id,granted_by) values($1,'steward',$2,$3)",[subject?candidate:kept.user,kept.chapter,subject?kept.user:candidate]);
      const roleBefore=(await client.query('select to_jsonb(r) row from public.member_roles r where chapter_id=$1',[kept.chapter])).rows;
      await refused(client,`select public.${lane}_remove_batch($1,1,$2,$3)`,[lane==='uniondemo'?unionRun:stressRun,productionRef,confirmation],/kept scope/);
      expect((await client.query('select to_jsonb(r) row from public.member_roles r where chapter_id=$1',[kept.chapter])).rows).toEqual(roleBefore);
      await client.query('rollback to savepoint role_case');
    }
  }));

  it.each(['uniondemo','member_stress'])('%s rolls back deletion when its window expires inside the batch', async lane => inRollback(async client => {
    await integratedFixture(client); await seedRun(client,lane,[],[]);
    const users=await seedAccounts(client,lane);
    await client.query(`update private.${lane}_runs set state='removing' where id=$1`,[lane==='uniondemo'?unionRun:stressRun]);
    await client.query(`create function pg_temp.expire_seed_window() returns trigger language plpgsql as $$ begin
      update private.production_residue_windows set expires_at=clock_timestamp()-interval '1 second'; return old; end $$;
      create trigger proof_expire_seed_window before delete on auth.users for each row execute function pg_temp.expire_seed_window()`);
    await refused(client,`select public.${lane}_remove_batch($1,1,$2,$3)`,[lane==='uniondemo'?unionRun:stressRun,productionRef,confirmation],/expired during operation/);
    expect((await client.query('select count(*)::int n from auth.users where id=any($1::uuid[])',[users])).rows[0].n).toBe(2);
    expect((await client.query('select expires_at > clock_timestamp() active from private.production_residue_windows')).rows[0].active).toBe(true);
  }));

  it.each(['uniondemo','member_stress'])('%s rolls back begin-remove when the run update crosses expiry', async lane => inRollback(async client => {
    await integratedFixture(client); await seedRun(client,lane,[],[]);
    await client.query(`create function pg_temp.expire_seed_begin() returns trigger language plpgsql as $$ begin
      update private.production_residue_windows set expires_at=clock_timestamp()-interval '1 second'; return new; end $$;
      create trigger proof_expire_seed_begin after update on private.${lane}_runs for each row execute function pg_temp.expire_seed_begin()`);
    await refused(client,`select public.${lane}_begin_remove($1,$2,$3)`,[lane==='uniondemo'?unionRun:stressRun,productionRef,confirmation],/expired during operation/);
    expect((await client.query(`select state from private.${lane}_runs where id=$1`,[lane==='uniondemo'?unionRun:stressRun])).rows[0].state).toBe('verified');
  }));

  it('relocks canonical bytes even after the window disappears', async () => inRollback(async client => {
    const before=await catalogue(client);
    await integratedFixture(client);
    await client.query('delete from private.production_residue_windows');
    await client.query(relock);
    expect(await catalogue(client)).toEqual(before);
    expect((await client.query("select to_regclass('private.production_residue_root_ownership') value")).rows[0].value).toBeNull();
  }));

  it('rolls back a mutating knowledge return expression after expiry', async () => inRollback(async client => {
    await integratedFixture(client); await seedRun(client,'uniondemo',[],[]);
    await client.query(`create temporary table expiry_mutations (n integer);
      create or replace function private.demo_seed_remove_knowledge_library(p_lane text,p_run_id uuid)
      returns jsonb language plpgsql security definer set search_path='' as $$ begin
        insert into pg_temp.expiry_mutations values(1);
        update private.production_residue_windows set expires_at=clock_timestamp()-interval '1 second';
        return '{}'::jsonb; end $$`);
    await refused(client,'select public.remove_mi1_knowledge_sample($1,$2,$3,$4)', ['uniondemo',unionRun,productionRef,confirmation],/expired during operation/);
    expect((await client.query('select count(*)::int n from pg_temp.expiry_mutations')).rows[0].n).toBe(0);
  }));

  it('rolls back parity cleanup if its last mutation crosses expiry', async () => inRollback(async client => {
    await integratedFixture(client); await seedRun(client,'uniondemo',[],[]);
    const signature='private.demo_seed_drop_voice_operations_refresh()';
    const original=(await client.query('select pg_get_functiondef($1::regprocedure) body',[signature])).rows[0].body;
    // Instrument the final mutator; preceding cleanup and the public wrapper
    // execute normally, while the deterministic clock change avoids sleeps.
    const close=original.lastIndexOf('END;');
    const lowerClose=original.lastIndexOf('end;');
    const position=Math.max(close,lowerClose);
    expect(position).toBeGreaterThan(0);
    // Add the deadline change at entry so even an early helper return expires.
    const instrumented=original.replace(/\bbegin\b/i,"begin\n update private.production_residue_windows set expires_at=clock_timestamp()-interval '1 second';");
    await client.query(instrumented);
    await refused(client,'select public.uniondemo_remove_function_parity($1,$2,$3)',[unionRun,productionRef,confirmation],/expired during operation/);
    expect((await client.query('select expires_at > clock_timestamp() active from private.production_residue_windows')).rows[0].active).toBe(true);
  }));
});

async function integratedFixture(client) {
  await client.query(sqlBody(readFileSync(f1Path, 'utf8')));
  await client.query(unlock);
  await service(client);
  const signature = 'private.production_residue_authorize(text,text,text,text)';
  let body = (await client.query('select pg_get_functiondef($1::regprocedure) body', [signature])).rows[0].body;
  const identity = (await client.query(`select system_identifier::text system_identifier,
    (select oid::text from pg_database where datname=current_database()) database_oid from pg_control_system()`)).rows[0];
  body = body.replace('7662742571317219726', identity.system_identifier)
    .replace(/(pinned_database_oid constant oid := )5/, `$1${identity.database_oid}`)
    .replace('5155e1a3ed12485fe08548293aa3c12c49bf16bf0e0fbce8a4072914d7688a20', sha(confirmation));
  await client.query(body);
  // The F1 suite proves clock/constraint enforcement; this fixture moves only
  // the local clock boundary so this lane's snapshot cases run at any hour.
  const constraints = (await client.query(`select conname from pg_constraint
    where conrelid='private.production_residue_windows'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%America/New_York%'`)).rows;
  for (const { conname } of constraints) await client.query(`alter table private.production_residue_windows drop constraint "${conname.replaceAll('"','""')}"`);
  await client.query('alter table private.production_residue_windows disable trigger user');
  await client.query(`insert into private.production_residue_windows
    (project_ref,system_identifier,database_oid,authorization_reference,backup_reference,opened_at,expires_at)
    values($1,$2,$3,'disposable-proof','disposable-backup',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
  [productionRef,identity.system_identifier,identity.database_oid]);
  await client.query('truncate private.demo_seed_installation_bindings');
  // Earlier shared proofs can retain synthetic Storage metadata. This legacy
  // removal fixture needs an empty Storage environment; the enclosing rollback
  // restores every row afterwards, and the real environment guard stays intact.
  await client.query('truncate storage.objects cascade');
  // Preserve the baseline retained by earlier required-proof files. Only rows
  // present before this case's seed setup are accounted; later outsiders must
  // still fail the real F1 protected-remainder guard.
  await client.query(`insert into private.production_residue_ledger(subject_kind,subject_id,cohort,own_domain)
    select 'account',id::text,'account-kept',true from auth.users
    union all select 'organization',id::text,'org-kept',true from public.organizations`);
  await client.query(`insert into private.production_residue_ledger(subject_kind,subject_id,cohort,own_domain)
    values('account',$1,'account-4a',false)`,[randomUUID()]);
  if ((await client.query("select to_regclass('private.production_residue_kept_scope') present")).rows[0].present) {
    const organization=randomUUID(), chapter=`proof-pin-${randomUUID()}`;
    await client.query("insert into public.organizations(id,name,slug) values($1,'Pinned proof',$2)",[organization,organization]);
    await client.query("insert into public.chapters(id,name,slug,order_index,organization_id) values($1,'Pinned proof',$1,0,$2)",[chapter,organization]);
    await client.query('insert into private.production_residue_kept_scope(organization_id,chapter_id) values($1,$2)',[organization,chapter]);
    await client.query(`insert into private.production_residue_ledger(subject_kind,subject_id,cohort,own_domain)
      values('organization',$1,'org-kept',true),('chapter',$2,'chapter-kept',true)`,[organization,chapter]);
  }
}

async function seedRun(client, lane, stored, current) {
  const id = lane === 'uniondemo' ? unionRun : stressRun;
  const columns = lane === 'uniondemo' ? ',steward_count' : '';
  const values = lane === 'uniondemo' ? ',60' : '';
  await client.query(`insert into private.${lane}_runs
    (id,dataset_version,target_ref,member_count,login_count,config_hash,state,protected_snapshot${columns})
    values($1,'disposable-proof',$2,${lane === 'uniondemo' ? 30000 : 100000},0,repeat('a',64),'verified',$3${values})`,
  [id,productionRef,JSON.stringify(stored)]);
  if (lane === 'uniondemo') {
    await client.query(`insert into private.uniondemo_ledger
      (run_id,ordinal,user_id,email,chapter_index,chapter_id,steward,login_capable)
      select $1,ordinal,md5('residue-proof-'||ordinal)::uuid,
        'residue-proof-'||ordinal||'@example.invalid',1,'disposable-proof',false,false
      from generate_series(1,30000) ordinal`, [id]);
  } else {
    await client.query(`insert into private.member_stress_ledger
      (run_id,ordinal,user_id,email,login_capable)
      select $1,ordinal,md5('residue-stress-proof-'||ordinal)::uuid,
        'residue-stress-proof-'||ordinal||'@example.invalid',false
      from generate_series(1,100000) ordinal`, [id]);
  }
  // Isolate the compared snapshot from its many unrelated table counters.
  // The real F1 subset/identity check and public remover execute unchanged.
  await client.query("select set_config('test.residue_snapshot',$1,true)", [JSON.stringify(current)]);
  await client.query(`create or replace function private.${lane}_protected_snapshot(p_run_id uuid)
    returns jsonb language sql stable security definer set search_path = '' as $fixture$
    select pg_catalog.current_setting('test.residue_snapshot')::jsonb
    $fixture$`);
  return id;
}

// F1 is a sibling delivery. These cases deliberately skip with this explicit
// reason until its migration is available; MAIN runs them again in F6.
integrated('F1-dependent snapshot/route proof (requires the R1 migration; otherwise deferred to F6)', () => {
  it('uniondemo begin-remove accepts four identical stored entries and refuses an unledgered extra', async () => inRollback(async client => {
    await integratedFixture(client);
    const stored = Array.from({ length: 4 }, () => ({ id: randomUUID(), value: 'unchanged' }));
    const extra = { id: randomUUID(), value: 'extra' };
    await client.query(`insert into private.production_residue_ledger(subject_kind,subject_id,cohort,own_domain,filled_at)
      values('account',$1,'account-4a',false,clock_timestamp())`, [extra.id]);
    const check = async current => (await client.query("select private.production_residue_snapshot_accounted($1,$2,'uniondemo') ok", [JSON.stringify(stored),JSON.stringify(current)])).rows[0].ok;
    expect(await check([...stored,extra])).toBe(true);
    expect(await check([...stored,extra,{ id: randomUUID() }])).toBe(false);
    expect((await client.query("select private.production_residue_actors_owned($1,jsonb_build_object('created_by',$2::text),true) owned", [unionRun,extra.id])).rows[0].owned).toBe(false);
    await seedRun(client, 'uniondemo', stored, [...stored,extra]);
    expect((await client.query('select public.uniondemo_begin_remove($1,$2,$3) result', [unionRun,productionRef,confirmation])).rows[0].result)
      .toMatchObject({ state: 'removing', remaining: 0 });
    await refused(client, 'select public.uniondemo_begin_remove($1,$2,$3)', [randomUUID(),productionRef,confirmation], /scope refused/);
    await client.query("select set_config('test.residue_snapshot',$1,true)", [JSON.stringify([...stored,extra,{ id: randomUUID() }])]);
    await refused(client, 'select public.uniondemo_begin_remove($1,$2,$3)', [unionRun,productionRef,confirmation], /snapshot|run refused|ownership.*preflight refused/);
    expect((await client.query('select protected_snapshot from private.uniondemo_runs where id=$1', [unionRun])).rows[0].protected_snapshot).toEqual(stored);
  }));

  it('accepts three stress entries plus both ledgers and refuses changed stored data', async () => inRollback(async client => {
    await integratedFixture(client);
    const stored = Array.from({ length: 3 }, () => ({ id: randomUUID(), value: 'unchanged' }));
    const residue = { id: randomUUID() }, demo = { id: randomUUID() };
    await client.query(`insert into private.production_residue_ledger(subject_kind,subject_id,cohort,own_domain,filled_at)
      values('account',$1,'account-4a',false,clock_timestamp())`, [residue.id]);
    await client.query(`insert into private.uniondemo_runs(id,dataset_version,target_ref,member_count,steward_count,login_count,config_hash,state,protected_snapshot)
      values($1,'disposable-proof',$2,30000,60,0,repeat('a',64),'verified','[]')`, [unionRun,productionRef]);
    await client.query(`insert into private.uniondemo_ledger(run_id,ordinal,user_id,email,chapter_index,chapter_id,steward,login_capable)
      values($1,1,$2,'disposable@example.invalid',1,'disposable-proof',false,false)`, [unionRun,demo.id]);
    const check = async current => (await client.query("select private.production_residue_snapshot_accounted($1,$2,'member_stress') ok", [JSON.stringify(stored),JSON.stringify(current)])).rows[0].ok;
    expect(await check([...stored,residue,demo])).toBe(true);
    expect(await check([{ ...stored[0], value: 'changed' },...stored.slice(1),residue,demo])).toBe(false);
    await seedRun(client, 'member_stress', stored, [...stored,residue,demo]);
    expect((await client.query('select public.member_stress_begin_remove($1,$2,$3) result', [stressRun,productionRef,confirmation])).rows[0].result)
      .toMatchObject({ state: 'removing', remaining: 0 });
    await refused(client, 'select public.member_stress_begin_remove($1,$2,$3)', [randomUUID(),productionRef,confirmation], /scope refused/);
    await client.query("select set_config('test.residue_snapshot',$1,true)", [JSON.stringify([{ ...stored[0], value: 'changed' },...stored.slice(1),residue,demo])]);
    await refused(client, 'select public.member_stress_begin_remove($1,$2,$3)', [stressRun,productionRef,confirmation], /snapshot|run refused/);
    expect((await client.query('select protected_snapshot from private.member_stress_runs where id=$1', [stressRun])).rows[0].protected_snapshot).toEqual(stored);
  }));

  it.each(['uniondemo','member_stress'])('%s batches refuse with no active window', async lane => inRollback(async client => {
    await integratedFixture(client);
    await client.query('delete from private.production_residue_windows');
    await refused(client, `select public.${lane}_remove_batch($1,1,$2,$3)`,
      [lane === 'uniondemo' ? unionRun : stressRun,productionRef,confirmation], /window/);
  }));
});
