// @vitest-environment node
// BUG-UG-CHAPTER-NOTICE-PUBLISH-NOT-EXACTLY-ONCE-20261119 (#9220):
// a notice sent again after a lost reply must reach members once. Both
// publishers take the client's operation key and answer a repeat of it with
// the notice they already published.
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {loadMigrationSql} from './helpers/migration.js';
import {sourceTransactionProblem} from '../scripts/hosted-migration-apply-runner.mjs';
import {assertDisposableProofUrl} from '../scripts/run-required-db-proofs.mjs';

const sql = loadMigrationSql('notice_publish_idempotency_key');
const definition = (name) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  return sql.slice(start, sql.indexOf('$function$;', start) + '$function$'.length);
};

describe('notice publish operation key migration', () => {
  it('passes the hosted transaction guard and pins both predecessors to the contract', () => {
    expect(sourceTransactionProblem(sql)).toBeNull();
    expect(sql).toContain("is distinct from '161a4cadb20a73994b8076a6915bccc0'");
    expect(sql).toContain("is distinct from 'c86ec936469cae9cdda7d0bac3bf11f3'");
    expect(sql).toContain('drop function public.publish_member_broadcast(text, text, text, text);');
    expect(sql).toContain('drop function public.publish_chapter_office_notice(text, text, text, text, uuid, uuid);');
  });

  it('records each new definition in the database contract and drops the old signature there', () => {
    const contract = JSON.parse(readFileSync(new URL('../scripts/db-contract.json', import.meta.url), 'utf8'));
    for (const [name, sig, exec] of [
      ['publish_member_broadcast', 'public.publish_member_broadcast(p_title text, p_body text, p_locale text, p_audience_scope text, p_idempotency_key uuid)', 'authenticated,service_role'],
      ['publish_chapter_office_notice', 'public.publish_chapter_office_notice(p_chapter text, p_title text, p_body text, p_locale text, p_unit uuid, p_committee uuid, p_idempotency_key uuid)', 'authenticated'],
    ]) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry, name).toBeTruthy();
      expect(entry.exec).toBe(exec);
      expect(entry.bodyMd5).toBe(createHash('md5').update(definition(name) + '\n').digest('hex'));
    }
    const absent = contract.functionsAbsent.map((row) => row.sig);
    expect(absent).toContain('public.publish_member_broadcast(text, text, text, text)');
    expect(absent).toContain('public.publish_chapter_office_notice(text, text, text, text, uuid, uuid)');
  });

  it('answers a repeat after the per-sender lock and before the daily limit, and keeps the lifecycle lock first', () => {
    for (const name of ['publish_member_broadcast', 'publish_chapter_office_notice']) {
      const body = definition(name);
      expect(body).toContain('p_idempotency_key uuid DEFAULT NULL::uuid)');
      const lifecycle = body.indexOf('perform private.lock_case_graph(');
      const sender = body.indexOf("'member-broadcast-publish:' || caller::text");
      const replay = body.indexOf("private.member_operations_replay(publisher_org, 'publish_notice', p_idempotency_key, request_payload)");
      const limit = body.indexOf('if recent >= 5 then');
      const receipt = body.indexOf("private.member_operations_store_receipt(publisher_org, 'publish_notice', p_idempotency_key, request_payload, published)");
      expect(lifecycle, name).toBeGreaterThanOrEqual(0);
      expect(lifecycle, name).toBeLessThan(body.indexOf('declare'));
      expect(sender, name).toBeGreaterThan(lifecycle);
      expect(replay, name).toBeGreaterThan(sender);
      expect(limit, name).toBeGreaterThan(replay);
      expect(receipt, name).toBeGreaterThan(body.indexOf('insert into public.member_broadcasts'));
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

async function seed(db, f) {
  await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Harbor Fictional Notice Keys '||$1::text)", [f.org]);
  await db.query('insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9981)', [f.chapter, f.org]);
  for (const name of ['admin', 'other']) {
    const id = randomUUID(), session = randomUUID();
    f.people[name] = {id, session};
    await db.query('insert into auth.users(id,email) values($1,$2)', [id, id + '@example.invalid']);
    await db.query('update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1', [id, f.chapter, 'Fictional ' + name]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [f.org, id]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, f.chapter]);
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2)", [id, f.chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2)", [id, f.chapter]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [f.org, id]);
  }
}

async function actAs(db, person) {
  await db.query('reset role');
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub: person.id, session_id: person.session, role: 'authenticated', aal: 'aal2'})]);
  await db.query('set local role authenticated');
}

const OFFICE = "select public.publish_chapter_office_notice($1,$2,'Polls open at noon in the union hall.','en',null,null,$3) v";
const BROADCAST = "select public.publish_member_broadcast($1,'Polls open at noon in the union hall.','en','chapter',$2) v";

live('notice publishing with an operation key on an owned rollback database', () => {
  let db, f;
  const one = async (query, args = []) => (await db.query(query, args)).rows[0]?.v;
  const rows = async () => {
    await db.query('reset role');
    return Number((await db.query('select count(*) n from public.member_broadcasts where organization_id=$1', [f.org])).rows[0].n);
  };
  const refused = async (query, args) => {
    await db.query('savepoint refused_repeat');
    let error;
    try { await db.query(query, args); } catch (caught) { error = caught; }
    await db.query('rollback to savepoint refused_repeat');
    await db.query('release savepoint refused_repeat');
    return error;
  };
  beforeEach(async () => {
    db = new pg.Client({connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: 'notice-publish-key-proof'});
    await db.connect();
    await db.query('begin');
    const org = randomUUID();
    f = {org, chapter: 'notice-key-' + org, people: {}};
    await seed(db, f);
    await actAs(db, f.people.admin);
  });
  afterEach(async () => { if (db) { await db.query('rollback'); await db.end(); } });

  it('returns the published chapter notice for a repeat of its key and creates one row', async () => {
    const key = randomUUID();
    const first = await one(OFFICE, [f.chapter, 'Contract vote this Thursday', key]);
    await actAs(db, f.people.admin);
    const repeat = await one(OFFICE, [f.chapter, 'Contract vote this Thursday', key]);
    expect(first.broadcastId).toMatch(/^bc-/);
    expect(repeat).toEqual(first);
    expect(await rows()).toBe(1);
  });

  it('returns the published broadcast for a repeat of its key and creates one row', async () => {
    const key = randomUUID();
    const first = await one(BROADCAST, ['Contract vote this Thursday', key]);
    await actAs(db, f.people.admin);
    expect(await one(BROADCAST, ['Contract vote this Thursday', key])).toEqual(first);
    expect(await rows()).toBe(1);
  });

  it('refuses the same key for a different notice and publishes a different key normally', async () => {
    const key = randomUUID();
    const first = await one(OFFICE, [f.chapter, 'Contract vote this Thursday', key]);
    await actAs(db, f.people.admin);
    const error = await refused(OFFICE, [f.chapter, 'Contract vote on Friday', key]);
    expect(error?.code).toBe('22023');
    expect(error?.message).toBe('idempotency key reused for a different request');
    // The chapter-wide broadcast with the same words is the same notice to the
    // same audience, so the key answers it with the notice already published.
    await actAs(db, f.people.admin);
    expect(await one(BROADCAST, ['Contract vote this Thursday', key])).toEqual(first);
    await actAs(db, f.people.admin);
    expect((await refused(BROADCAST, ['Contract vote on Friday', key]))?.code).toBe('22023');
    await actAs(db, f.people.admin);
    await one(OFFICE, [f.chapter, 'Contract vote this Thursday', randomUUID()]);
    expect(await rows()).toBe(2);
  });

  it('still publishes without a key, as a phone build that sends none does', async () => {
    await one("select public.publish_chapter_office_notice($1,'Contract vote this Thursday','Body','en',null,null) v", [f.chapter]);
    await actAs(db, f.people.admin);
    await one("select public.publish_member_broadcast('Contract vote this Thursday','Body','en','chapter') v");
    expect(await rows()).toBe(2);
  });

  it('answers a repeat of the fifth notice of the day instead of refusing it at the daily limit', async () => {
    let last;
    for (let index = 0; index < 5; index += 1) {
      last = {key: randomUUID(), title: `Notice ${index + 1}`};
      last.answer = await one(OFFICE, [f.chapter, last.title, last.key]);
      await actAs(db, f.people.admin);
    }
    expect(await one(OFFICE, [f.chapter, last.title, last.key])).toEqual(last.answer);
    await actAs(db, f.people.admin);
    expect((await refused(OFFICE, [f.chapter, 'Notice 6', randomUUID()]))?.code).toBe('54000');
    expect(await rows()).toBe(5);
  });

  it('dedupes by key, not by time: a repeat after the notice moved 30 minutes back still gets it', async () => {
    const key = randomUUID();
    const first = await one(OFFICE, [f.chapter, 'Contract vote this Thursday', key]);
    await db.query('reset role');
    await db.query("update public.member_broadcasts set published_at = now() - interval '30 minutes' where id=$1", [first.broadcastId]);
    await actAs(db, f.people.admin);
    expect(await one(OFFICE, [f.chapter, 'Contract vote this Thursday', key])).toEqual(first);
    expect(await rows()).toBe(1);
  });

  it('keeps one person\'s key from answering another person\'s notice', async () => {
    const key = randomUUID();
    const mine = await one(OFFICE, [f.chapter, 'Contract vote this Thursday', key]);
    await actAs(db, f.people.other);
    const theirs = await one(OFFICE, [f.chapter, 'Contract vote this Thursday', key]);
    expect(theirs.broadcastId).not.toBe(mine.broadcastId);
    expect(await rows()).toBe(2);
  });
});

// A retry that arrives while the first try's transaction is still open must
// wait for it and then get its notice, not insert a second one. That needs two
// connections, so this fixture is committed and removed afterwards.
live('a repeat that arrives while the first try is still open', () => {
  let first, second, f;
  const url = () => assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  beforeAll(async () => {
    const org = randomUUID();
    f = {org, chapter: 'notice-key-open-' + org, people: {}};
    const setup = new pg.Client({connectionString: url(), application_name: 'notice-publish-key-seed'});
    await setup.connect();
    try { await setup.query('begin'); await seed(setup, f); await setup.query('commit'); } finally { await setup.end(); }
  });
  afterAll(async () => {
    for (const client of [first, second]) await client?.end().catch(() => {});
    const cleanup = new pg.Client({connectionString: url(), application_name: 'notice-publish-key-cleanup'});
    await cleanup.connect();
    try {
      await cleanup.query('begin');
      const users = Object.values(f.people).map((person) => person.id);
      await cleanup.query('delete from private.mi1_w2_operation_receipt_rows where organization_id=$1', [f.org]);
      await cleanup.query("delete from public.engagement_delivery_outbox where source_kind='broadcast' and source_id in (select id from public.member_broadcasts where organization_id=$1)", [f.org]);
      await cleanup.query('delete from public.member_broadcasts where organization_id=$1', [f.org]);
      await cleanup.query('delete from public.organization_role_grants where organization_id=$1', [f.org]);
      await cleanup.query('delete from public.member_role_chapters where chapter_id=$1', [f.chapter]);
      await cleanup.query('delete from public.member_roles where chapter_id=$1', [f.chapter]);
      await cleanup.query('delete from auth.users where id = any($1::uuid[])', [users]);
      await cleanup.query('delete from public.member_chapter_memberships where chapter_id=$1', [f.chapter]);
      await cleanup.query('delete from public.organization_memberships where organization_id=$1', [f.org]);
      await cleanup.query('delete from private.dues_financial_identity_selections where organization_id=$1', [f.org]);
      await cleanup.query('delete from public.dues_member_subjects where organization_id=$1', [f.org]);
      await cleanup.query('delete from public.org_security_policy where organization_id=$1', [f.org]);
      await cleanup.query('delete from public.chapters where id=$1', [f.chapter]);
      await cleanup.query('delete from public.organizations where id=$1', [f.org]);
      await cleanup.query('commit');
    } finally { await cleanup.end(); }
  });

  it('waits behind the open first try, then returns its notice; one row in all', async () => {
    first = new pg.Client({connectionString: url(), application_name: 'notice-publish-key-first'});
    second = new pg.Client({connectionString: url(), application_name: 'notice-publish-key-retry'});
    await first.connect();
    await second.connect();
    const key = randomUUID();
    await first.query('begin');
    await actAs(first, f.people.admin);
    const opened = (await first.query(OFFICE, [f.chapter, 'Contract vote this Thursday', key])).rows[0].v;
    await second.query('begin');
    await second.query("set local lock_timeout = '20s'");
    await actAs(second, f.people.admin);
    const retryPid = (await second.query('select pg_backend_pid() pid')).rows[0].pid;
    const retry = second.query(OFFICE, [f.chapter, 'Contract vote this Thursday', key]);
    retry.catch(() => {});
    const probe = new pg.Client({connectionString: url(), application_name: 'notice-publish-key-probe'});
    await probe.connect();
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        waiting = (await probe.query("select wait_event_type='Lock' w from pg_stat_activity where pid=$1", [retryPid])).rows[0]?.w === true;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally { await probe.end(); }
    expect(waiting).toBe(true);
    await first.query('commit');
    const answered = (await retry).rows[0].v;
    await second.query('commit');
    expect(answered).toEqual(opened);
    await second.query('reset role');
    expect(Number((await second.query('select count(*) n from public.member_broadcasts where organization_id=$1', [f.org])).rows[0].n)).toBe(1);
  }, 60_000);
});
