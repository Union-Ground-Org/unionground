// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import { offlinePostgres } from './tamarack-postgres-helper.mjs';
import { loadMigrationSql, fnBody } from './helpers/migration.js';

const org = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const admin = '20000000-0000-4000-8000-000000000001';
const member = '20000000-0000-4000-8000-000000000002';
const outsider = '20000000-0000-4000-8000-000000000003';
const RETIRE_MIGRATION = '20261104074500_';
let db;
async function bootstrap() {
  const database = await offlinePostgres({ durable: false }); db = database.client;
  await db.query(`create schema auth; create schema private; create schema extensions;
    create extension pgcrypto with schema extensions;
    create role anon; create role authenticated; create role service_role;
    grant usage on schema auth,private,public to anon,authenticated,service_role;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('proof.user',true),'')::uuid $$;
    create function private.mfa_satisfied() returns boolean language sql stable as $$ select current_setting('proof.mfa',true)='true' $$;
    create function private.staff_mfa_required(uuid) returns boolean language sql stable as $$ select false $$;
    create function private.has_second_factor(uuid) returns boolean language sql stable as $$ select true $$;
    create function private.lock_message_lifecycle() returns void language sql as $$ select $$;
    create table public.organizations(id uuid primary key,status text default 'active');
    create table public.chapters(id text primary key,organization_id uuid references public.organizations(id));
    create table public.member_profiles(id uuid primary key,chapter_id text,full_name text);
    create table public.organization_memberships(organization_id uuid,user_id uuid,status text default 'active',revoked_at timestamptz);
    create table public.member_chapter_memberships(chapter_id text,user_id uuid,status text default 'active');
    create table public.organization_role_grants(organization_id uuid,user_id uuid,role text);
    create table public.member_rights_lessons(id text primary key,steps jsonb);
    create table public.member_rights_progress(lesson_id text references public.member_rights_lessons(id),user_id uuid references auth.users(id),completed_steps int[] not null default '{}',primary key(lesson_id,user_id));
    create table private.account_lifecycle_manifest(schema_name text,table_name text,user_column text,delete_disposition text,export_disposition text,export_inventory_basis text,exclusion_reason text,note text,primary key(schema_name,table_name,user_column));
    create table private.account_lifecycle_trigger_review(kind text,schema_name text,table_name text,object_name text,definition_hash text,primary key(kind,schema_name,table_name,object_name));
    create function private.account_lifecycle_trigger_surface() returns table(kind text,schema_name text,table_name text,object_name text,definition_hash text) language sql as $$ select null::text,null::text,null::text,null::text,null::text where false $$;
  `);
  await db.query(fnBody(loadMigrationSql('20260822010000_'), 'private.current_member_organization'));
  await db.query(`create function private.current_member_chapter() returns text language sql stable as $$ select chapter_id from public.member_profiles where id=auth.uid() $$`);
  await db.query(fnBody(loadMigrationSql('20260902050000_'), 'private.current_mobile_staff_organization'));
  await db.query(fnBody(loadMigrationSql('20260903040000_'), 'private.has_organization_role'));
  const locks = loadMigrationSql('20260907150000_');
  for (const name of ['private.lock_case_graph','private.lock_case_graph_statement','private.lock_case_graph_row_keys']) await db.query(fnBody(locks,name));
  await db.query(loadMigrationSql('20261029235156_'));
  return database;
}
async function seed() {
  await db.query(`rollback;begin;truncate private.free_cosmetic_selections,private.free_cosmetic_awards,public.member_rights_progress;
    delete from public.organization_role_grants;delete from public.member_chapter_memberships;delete from public.organization_memberships;
    delete from public.member_profiles;delete from public.chapters;delete from public.organizations;delete from auth.users;
    insert into auth.users values('${admin}'),('${member}'),('${outsider}');
    insert into public.organizations(id) values('${org}'),('${other}');
    insert into public.chapters values('a','${org}'),('b','${other}');
    insert into public.member_profiles values('${admin}','a','Admin'),('${member}','a','New member'),('${outsider}','b','Other member');
    insert into public.organization_memberships(organization_id,user_id) values('${org}','${admin}'),('${org}','${member}'),('${other}','${outsider}');
    insert into public.member_chapter_memberships(chapter_id,user_id) values('a','${admin}'),('a','${member}'),('b','${outsider}');
    insert into public.organization_role_grants values('${org}','${admin}','admin');
    insert into public.member_rights_lessons values('lesson','["Read","Reflect"]'),('empty','[]') on conflict do nothing;
    select set_config('proof.mfa','true',true);select set_config('proof.user','',true);`);
}
async function as(user, sql, args = [], { role = 'authenticated', mfa = true } = {}) {
  await db.query('savepoint attempt');
  try {
    await db.query("select set_config('proof.user',$1,true),set_config('proof.mfa',$2,true)",[user ?? '',String(mfa)]);
    await db.query(`set local role ${role}`);
    const result = (await db.query(sql,args)).rows;
    await db.query('reset role;release savepoint attempt'); return result;
  } catch (error) { await db.query('rollback to savepoint attempt;release savepoint attempt'); throw error; }
}
const grant = (key = 'golden-mark', target = member, reason = 'Welcome from day one') => as(admin,'select public.grant_free_cosmetic($1,$2,$3,$4) id',[org,target,key,reason]);
const list = (user = member, organization = org, options) => as(user,'select public.get_free_cosmetics($1) w',[organization],options).then((rows) => rows[0].w);
const select = (kind, key, user = member, organization = org) => as(user,'select public.set_free_cosmetic($1,$2,$3)',[organization,kind,key]);
async function progress(steps, { user = member, lesson = 'lesson', mfa = true } = {}) {
  // Existing RLS is outside this migration. Simulate its already-authorized
  // write as the owner while keeping the actual session/trigger inputs.
  return as(user,`insert into public.member_rights_progress values($1,$2,$3)
    on conflict(lesson_id,user_id) do update set completed_steps=excluded.completed_steps`,[lesson,user,steps],{role:'postgres',mfa});
}

// OPS-UG-GOLDEN-HOUR-COSMETIC-CATALOG-RETIRE-20261104: apply the
// retirement on top of data the original RPCs wrote.
describe('retiring the Golden Hour theme cosmetic over existing data, real PostgreSQL', () => {
  let database;
  beforeAll(async () => { database = await bootstrap(); }, 120_000);
  afterAll(async () => { await database?.close(); });
  it('keeps the award in history, clears the stored theme selection and keeps other selections', async () => {
    await seed();
    for (const key of ['golden-hour','golden-mark']) await grant(key);
    await select('theme','golden-hour'); await select('icon','golden-mark');
    expect((await list()).items.map((item) => item.key)).toContain('golden-hour');
    await db.query(loadMigrationSql(RETIRE_MIGRATION));
    await db.query('begin');
    const w = await list();
    expect(w.items.map((item) => item.key)).toEqual(['learning-spark','golden-mark']);
    expect(w.history.map((award) => award.itemKey).sort()).toEqual(['golden-hour','golden-mark']);
    expect(w.history.find((award) => award.itemKey === 'golden-hour')).toMatchObject({userId:member,grantedBy:admin,source:'admin',reason:'Welcome from day one'});
    expect(w.items.find((item) => item.key === 'golden-mark').selected).toBe(true);
    expect((await db.query('select kind,item_key from private.free_cosmetic_selections')).rows).toEqual([{kind:'icon',item_key:'golden-mark'}]);
    expect((await db.query('select key from private.free_cosmetic_catalog where retired_at is not null')).rows).toEqual([{key:'golden-hour'}]);
    await db.query('rollback');
  });
});

// r1s1 on #7016: the migration must take the case-graph gate before any
// catalog lock, the order the RPCs use, or it can deadlock with a request.
describe('retiring the Golden Hour theme cosmetic while a request holds the case-graph gate, real PostgreSQL', () => {
  let database, migrator;
  beforeAll(async () => {
    database = await bootstrap();
    migrator = new pg.Client({ host: db.host, port: db.port, user: db.user, database: db.database });
    await migrator.connect();
  }, 120_000);
  afterAll(async () => { await migrator?.end(); await database?.close(); });
  it('waits for the gate holding no catalog lock, then applies once the request finishes', async () => {
    const sql = loadMigrationSql(RETIRE_MIGRATION);
    expect(sql.indexOf('select private.lock_case_graph(array[]::uuid[], array[]::uuid[]);')).toBeGreaterThan(-1);
    expect(sql.indexOf('select private.lock_case_graph(array[]::uuid[], array[]::uuid[]);')).toBeLessThan(sql.indexOf('alter table'));
    const pid = (await migrator.query('select pg_backend_pid() pid')).rows[0].pid;
    // The request has passed its first statement (the gate) but not yet read the catalog.
    await db.query("rollback;begin;set local lock_timeout='3s';select private.lock_case_graph(array[]::uuid[],array[]::uuid[])");
    const applying = migrator.query(sql).then(() => null, (error) => error);
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
      waiting = (await db.query("select exists(select 1 from pg_locks where pid=$1 and not granted and locktype='advisory') w",[pid])).rows[0].w;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(waiting).toBe(true);
    const held = await db.query(`select mode from pg_locks where pid=$1 and granted
      and relation in ('private.free_cosmetic_catalog'::regclass,'private.free_cosmetic_selections'::regclass)`,[pid]);
    expect(held.rows).toEqual([]);
    // The request now reads the catalog and writes a selection without waiting on the migration.
    expect((await db.query('select count(*)::int n from private.free_cosmetic_catalog')).rows[0].n).toBe(3);
    await db.query('delete from private.free_cosmetic_selections');
    await db.query('commit');
    expect(await applying).toBeNull();
    expect((await db.query('select key from private.free_cosmetic_catalog where retired_at is not null')).rows).toEqual([{key:'golden-hour'}]);
  });
});

describe('free cosmetic grants and milestones, real PostgreSQL', () => {
  let database;
  beforeAll(async () => {
    database = await bootstrap();
    await db.query(loadMigrationSql(RETIRE_MIGRATION));
  }, 120_000);
  afterAll(async () => { await database?.close(); });
  beforeEach(seed);
  it('grants every listed cosmetic on day one without a points or payment table', async () => {
    expect((await list()).history).toEqual([]);
    for (const key of ['learning-spark','golden-mark']) await grant(key);
    const w = await list();
    expect(w.items.every((item) => item.earned)).toBe(true);
    expect(w.history).toHaveLength(2);
    expect(w.history[0]).toMatchObject({userId:member,grantedBy:admin,reason:'Welcome from day one',source:'admin'});
    expect(w.history[0].createdAt).toBeTruthy();
  });
  it('denies member self-grants, cross-organization grants, anonymous calls and insufficient MFA', async () => {
    await expect(as(member,'select public.grant_free_cosmetic($1,$2,$3,$4)',[org,member,'golden-mark','Self'])).rejects.toMatchObject({code:'42501'});
    await expect(grant('golden-mark',outsider)).rejects.toMatchObject({code:'42501'});
    await expect(list(null,org,{role:'anon'})).rejects.toMatchObject({code:'42501'});
    await expect(list(admin,org,{mfa:false})).rejects.toMatchObject({code:'42501'});
    await db.query("update public.organization_role_grants set role='vp'");
    await expect(grant()).rejects.toMatchObject({code:'42501'});
  });
  it('fails closed when the selected organization changes or a membership is revoked', async () => {
    await expect(select('theme',null,member,other)).rejects.toMatchObject({code:'42501'});
    await expect(list(member,other)).rejects.toMatchObject({code:'42501'});
    await db.query('update public.organization_memberships set revoked_at=now() where user_id=$1',[member]);
    await expect(grant()).rejects.toMatchObject({code:'42501'});
    await expect(list()).rejects.toMatchObject({code:'42501'});
  });
  it('does not leak another organization history or recipient list', async () => {
    await grant();
    const w = await list(outsider,other);
    expect(w.history).toEqual([]); expect(w.recipients).toEqual([]); expect(w.canGrant).toBe(false);
    expect((await list(admin)).recipients.map((x) => x.id).sort()).toEqual([admin,member].sort());
    expect((await list()).recipients).toEqual([]);
  });
  it('supports chapterless organization administrators without guessing between multiple organizations', async () => {
    await db.query('update public.member_profiles set chapter_id=null where id=$1',[admin]);
    await db.query('delete from public.member_chapter_memberships where user_id=$1',[admin]);
    expect((await list(admin)).canGrant).toBe(true);
    await grant();expect((await list()).history).toHaveLength(1);
    await progress([0,1],{user:admin});
    expect((await list(admin)).history.some((award)=>award.itemKey==='learning-spark')).toBe(true);
    await db.query('insert into public.organization_memberships(organization_id,user_id) values($1,$2)',[other,admin]);
    await expect(list(admin)).rejects.toMatchObject({code:'42501'});
  });
  it('makes manual retries idempotent and retains the original attribution/reason', async () => {
    const first = (await grant())[0].id;
    expect((await grant('golden-mark',member,'Retry'))[0].id).toBe(first);
    expect((await list()).history).toHaveLength(1);
    expect((await list()).history[0].reason).toBe('Welcome from day one');
  });
  it('recovers from failed grants without recording a partial award', async () => {
    await expect(grant('golden-mark',member,'  ')).rejects.toMatchObject({code:'22023'});
    await expect(grant('unknown')).rejects.toMatchObject({code:'22023'});
    expect((await list()).history).toEqual([]);
    await grant(); expect((await list()).history).toHaveLength(1);
  });
  it('persists apply/remove for all types and refuses unearned or wrong-kind selections', async () => {
    await expect(select('icon','golden-mark')).rejects.toMatchObject({code:'42501'});
    for (const [kind,key] of [['badge','learning-spark'],['icon','golden-mark']]) {
      await grant(key); await select(kind,key);
      expect((await list()).items.find((item) => item.key === key).selected).toBe(true);
      await select(kind,null);
      const item = (await list()).items.find((item) => item.key === key);
      expect(item.earned).toBe(true); expect(item.selected).not.toBe(true);
    }
    await expect(select('theme','learning-spark')).rejects.toMatchObject({code:'42501'});
  });
  it('awards a verified complete checklist once, never for partial, duplicate or out-of-range steps', async () => {
    for (const steps of [[0],[0,0],[-1,0],[0,2],[0,1,2]]) {
      await progress(steps); expect((await list()).history).toEqual([]);
    }
    await progress([1,0]); await progress([0,1]); await progress([]); await progress([0,1]);
    const w = await list(); expect(w.history).toHaveLength(1);
    expect(w.history[0]).toMatchObject({itemKey:'learning-spark',source:'rights_checklist',grantedBy:member});
  });
  it('does not award an empty checklist, unauthenticated seed or insufficient-MFA event', async () => {
    await progress([],{lesson:'empty'}); await progress([0,1],{mfa:false});
    expect((await list()).history).toEqual([]);
    await db.query("select set_config('proof.user','',true)");
    await db.query("insert into public.member_rights_progress values('lesson',$1,'{0,1}') on conflict do nothing",[outsider]);
    expect((await list(outsider,other)).history).toEqual([]);
  });
  it('denies direct storage reads/writes, retains history when the actor is deleted, and removes the recipient data', async () => {
    await grant();
    await expect(as(member,'select * from private.free_cosmetic_awards')).rejects.toMatchObject({code:'42501'});
    await expect(as(admin,"insert into private.free_cosmetic_selections values($1,$2,'icon','golden-mark',now())",[org,member])).rejects.toMatchObject({code:'42501'});
    await db.query('delete from auth.users where id=$1',[admin]);
    expect((await list()).history[0].grantedBy).toBeNull();
    await db.query('delete from auth.users where id=$1',[member]);
    expect((await db.query('select count(*)::int n from private.free_cosmetic_awards')).rows[0].n).toBe(0);
  });
  it('no longer lists Golden Hour and refuses to grant or apply it, even to an earlier recipient', async () => {
    for (const user of [member,admin]) expect((await list(user)).items.map((item) => item.key)).toEqual(['learning-spark','golden-mark']);
    await expect(grant('golden-hour')).rejects.toMatchObject({code:'22023'});
    expect((await list()).history).toEqual([]);
    // An award made before the retirement stays referenced by the catalog row.
    await db.query(`insert into private.free_cosmetic_awards(organization_id,user_id,item_key,granted_by,source,reason)
      values($1,$2,'golden-hour',$3,'admin','Before retirement')`,[org,member,admin]);
    await expect(grant('golden-hour')).rejects.toMatchObject({code:'22023'});
    await expect(grant('golden-hour',admin)).rejects.toMatchObject({code:'22023'});
    await expect(select('theme','golden-hour')).rejects.toMatchObject({code:'42501'});
    expect((await db.query('select count(*)::int n from private.free_cosmetic_awards')).rows[0].n).toBe(1);
    expect((await db.query('select count(*)::int n from private.free_cosmetic_selections')).rows[0].n).toBe(0);
  });
  it('keeps a retired award in the recipient and administrator history', async () => {
    await db.query(`insert into private.free_cosmetic_awards(organization_id,user_id,item_key,granted_by,source,reason)
      values($1,$2,'golden-hour',$3,'admin','Before retirement')`,[org,member,admin]);
    await grant('golden-mark');
    for (const user of [member,admin]) {
      const w = await list(user);
      expect(w.items.some((item) => item.key === 'golden-hour')).toBe(false);
      expect(w.history.map((award) => award.itemKey).sort()).toEqual(['golden-hour','golden-mark']);
      expect(w.history.find((award) => award.itemKey === 'golden-hour')).toMatchObject({userId:member,grantedBy:admin,source:'admin',reason:'Before retirement'});
    }
    expect((await list(outsider,other)).history).toEqual([]);
  });
});
