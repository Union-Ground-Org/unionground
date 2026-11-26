// @vitest-environment node
// Phase 4a DB half: organization self-placement (self-reported).
// Synthetic fixtures only (fictional organizations, example.invalid users),
// each case rolled back in a disposable local application database.
//
// The union catalog tables (private.catalog_organizations and
// private.catalog_releases) come from the Phase 2a migration. The placement
// RPCs read them only behind a to_regclass guard, so this proof covers both
// worlds inside the rolled-back transaction: "absent" renames the installed
// catalog tables out of the way (a rename, never a drop, undone by the
// rollback), and "catalog" writes fictional release and organization rows into
// the real tables as the owner.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const live = process.env.RUN_CATALOG_SETUP_PLACEMENT_DB_TESTS === '1' ? it : it.skip;

const EVENT = 'organization_catalog_placement_changed';
const ACTIVE_KEY = 'olms-900000001';
const RETIRED_KEY = 'olms-900000002';
const DUPLICATE_KEY = 'olms-900000003';
const UNKNOWN_KEY = 'olms-900000099';
const UG_KEY = 'ug-examplex01';
const LEDGER_METADATA_KEYS = ['entityId', 'entityType', 'fromStatus', 'reasonCode', 'toStatus'];

async function withClient(run) {
  const c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await c.connect();
  await c.query('begin');
  try {
    await run(c);
  } finally {
    await c.query('rollback');
    await c.end();
  }
}

// One fictional organization with a default chapter and one member. The
// member holds the admin grant and a verified second factor unless told not
// to. No org_security_policy row is written, and staff_mfa_required() then
// defaults to true, which is the shell a new organization gets.
async function organization(c, { name = 'Example Workers Local 1', admin = true, factor = true } = {}) {
  const org = randomUUID(), user = randomUUID(), session = randomUUID();
  const chapter = `proof-${org}`;
  await c.query('insert into public.organizations(id,slug,name) values ($1,$2,$3)', [org, chapter, `${name} ${org.slice(0, 8)}`]);
  await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)", [chapter, org]);
  await c.query('insert into auth.users(id,email) values ($1,$2)', [user, `${user}@example.invalid`]);
  await c.query('update public.member_profiles set chapter_id=$2 where id=$1', [user, chapter]);
  await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, user]);
  await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [user, chapter]);
  if (admin) await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [org, user]);
  if (factor) await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user]);
  await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,$3,now(),now())", [session, user, factor ? 'aal2' : 'aal1']);
  return { org, user, session, aal: factor ? 'aal2' : 'aal1' };
}

async function as(c, who) {
  await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: who.user, session_id: who.session, role: 'authenticated', aal: who.aal })]);
}

// Calls one RPC as `authenticated` inside a savepoint, so a refusal leaves the
// outer transaction usable. Resolves to the jsonb result or rejects with the
// PostgreSQL error.
async function rpc(c, sql, params, role = 'authenticated') {
  await c.query('savepoint rpc_call');
  try {
    await c.query(`set local role ${role}`);
    const result = (await c.query(`select ${sql} as r`, params)).rows[0].r;
    await c.query('reset role');
    await c.query('release savepoint rpc_call');
    return result;
  } catch (error) {
    await c.query('rollback to savepoint rpc_call');
    await c.query('release savepoint rpc_call');
    throw error;
  }
}

const getPlacement = (c, org, hat = 'admin') =>
  rpc(c, 'public.get_organization_catalog_placement($1,$2)', [hat, org]);
const setPlacement = (c, org, { key = null, name = null, state = null, identity = false, idem = randomUUID(), hat = 'admin' } = {}) =>
  rpc(c, 'public.set_organization_catalog_placement($1,$2,$3,$4,$5,$6,$7)', [hat, org, key, name, state, identity, idem]);
const clearPlacement = (c, org, idem = randomUUID(), hat = 'admin') =>
  rpc(c, 'public.clear_organization_catalog_placement($1,$2,$3)', [hat, org, idem]);

async function ledger(c, org) {
  return (await c.query('select action, domain, entity_type, entity_id, actor_user_id, idempotency_key, metadata from public.organization_audit_ledger where organization_id=$1 and event_type=$2 order by idempotency_key', [org, EVENT])).rows;
}

async function placementRow(c, org) {
  return (await c.query('select * from private.organization_catalog_placements where organization_id=$1', [org])).rows[0] ?? null;
}

// Moves any installed union catalog tables out of the way for the rest of the
// transaction, so to_regclass reports them absent.
async function catalogAbsent(c) {
  for (const table of ['catalog_organizations', 'catalog_releases']) {
    if ((await c.query('select pg_catalog.to_regclass($1) is not null as present', [`private.${table}`])).rows[0].present) {
      await c.query(`alter table private.${table} rename to ${table}_proof_hidden`);
    }
  }
  expect((await c.query("select pg_catalog.to_regclass('private.catalog_organizations') as o, pg_catalog.to_regclass('private.catalog_releases') as r")).rows[0]).toEqual({ o: null, r: null });
}

// Fictional rows in the real Phase 2a catalog tables: one active release (the
// installed one if a release is already active), and an active, a retired and
// a duplicate organization, plus an active ug- key. Returns the active release.
async function catalogRows(c) {
  expect((await c.query("select pg_catalog.to_regclass('private.catalog_organizations') is not null as o, pg_catalog.to_regclass('private.catalog_releases') is not null as r")).rows[0]).toEqual({ o: true, r: true });
  let active = (await c.query("select id from private.catalog_releases where status='active'")).rows[0]?.id;
  if (!active) {
    active = randomUUID();
    await c.query(
      `insert into private.catalog_releases(id,label,status,schema_version,filter_version,source_sha256,artifact_sha256,source_built_at,counts,activated_at)
       values ($1,'20990101-01','active','union-catalog-release/1','privacy-filter/1',repeat('0',64),repeat('0',64),now(),'{}'::jsonb,now())`,
      [active],
    );
  }
  const retired = randomUUID();
  await c.query(
    `insert into private.catalog_organizations
       (catalog_key,name,tier,confidence,search_text,first_release_id,last_release_id,retired_release_id,duplicate_of,content_sha256)
     values
       ($1,'Example Workers Local 1','local','unreviewed','example workers local 1',$5,$5,null,null,repeat('0',64)),
       ($2,'Example Retired Council','regional','unreviewed','example retired council',$5,$5,$6,null,repeat('0',64)),
       ($3,'Example Duplicate Local','local','unreviewed','example duplicate local',$5,$5,null,$1,repeat('0',64)),
       ($4,'Sample Transit Council','regional','unreviewed','sample transit council',$5,$5,null,null,repeat('0',64))`,
    [ACTIVE_KEY, RETIRED_KEY, DUPLICATE_KEY, UG_KEY, active, retired],
  );
  return active;
}

async function expectRefusal(promise, code, message) {
  const error = await promise.then(() => null, (e) => e);
  expect(error, `expected ${code} ${message ?? ''}`).not.toBeNull();
  expect(error.code).toBe(code);
  if (message) expect(error.message).toBe(message);
}

live('1. anon cannot execute any of the three placement RPCs', async () => {
  await withClient(async (c) => {
    const org = randomUUID();
    await expectRefusal(rpc(c, 'public.get_organization_catalog_placement($1,$2)', ['admin', org], 'anon'), '42501');
    await expectRefusal(rpc(c, 'public.set_organization_catalog_placement($1,$2,$3,$4,$5,$6,$7)', ['admin', org, ACTIVE_KEY, null, null, false, randomUUID()], 'anon'), '42501');
    await expectRefusal(rpc(c, 'public.clear_organization_catalog_placement($1,$2,$3)', ['admin', org, randomUUID()], 'anon'), '42501');
    for (const sig of [
      'public.get_organization_catalog_placement(text,uuid)',
      'public.set_organization_catalog_placement(text,uuid,text,text,text,boolean,uuid)',
      'public.clear_organization_catalog_placement(text,uuid,uuid)',
    ]) {
      const acl = (await c.query("select has_function_privilege('anon',$1,'execute') anon, has_function_privilege('service_role',$1,'execute') svc, has_function_privilege('authenticated',$1,'execute') auth", [sig])).rows[0];
      expect(acl, sig).toEqual({ anon: false, svc: false, auth: true });
    }
  });
});

live('2. an authenticated member without the admin hat is refused 42501', async () => {
  await withClient(async (c) => {
    await catalogRows(c);
    const member = await organization(c, { admin: false });
    await as(c, member);
    await expectRefusal(getPlacement(c, member.org), '42501');
    await expectRefusal(setPlacement(c, member.org, { key: ACTIVE_KEY }), '42501');
    await expectRefusal(clearPlacement(c, member.org), '42501');
    // An admin grant does not help a caller who names another hat.
    await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [member.org, member.user]);
    await expectRefusal(getPlacement(c, member.org, 'vp'), '42501');
    await expectRefusal(setPlacement(c, member.org, { key: ACTIVE_KEY, hat: 'advisor' }), '42501');
    await expectRefusal(clearPlacement(c, member.org, randomUUID(), 'steward'), '42501');
    expect(await placementRow(c, member.org)).toBeNull();
    expect(await ledger(c, member.org)).toEqual([]);
  });
});

live('3. an admin of an organization that requires staff MFA, with no verified factor, is refused 42501', async () => {
  await withClient(async (c) => {
    await catalogRows(c);
    const admin = await organization(c, { factor: false });
    expect((await c.query('select private.staff_mfa_required($1) as required', [admin.org])).rows[0].required).toBe(true);
    await as(c, admin);
    await expectRefusal(getPlacement(c, admin.org), '42501');
    await expectRefusal(setPlacement(c, admin.org, { key: ACTIVE_KEY }), '42501');
    await expectRefusal(clearPlacement(c, admin.org), '42501');
    expect(await placementRow(c, admin.org)).toBeNull();
    expect(await ledger(c, admin.org)).toEqual([]);
  });
});

live('4. an expected-organization mismatch is refused before anything is read or written', async () => {
  await withClient(async (c) => {
    await catalogRows(c);
    const admin = await organization(c);
    const other = await organization(c, { name: 'Sample Transit Council' });
    await as(c, admin);
    for (const expected of [other.org, randomUUID(), null]) {
      await expectRefusal(getPlacement(c, expected), '42501');
      await expectRefusal(setPlacement(c, expected, { key: ACTIVE_KEY }), '42501');
      await expectRefusal(clearPlacement(c, expected), '42501');
    }
    expect(await placementRow(c, admin.org)).toBeNull();
    expect(await placementRow(c, other.org)).toBeNull();
  });
});

live('5. with no union catalog installed, every parent key gets the uniform refusal and a stored key reads as inactive', async () => {
  await withClient(async (c) => {
    await catalogAbsent(c);
    const admin = await organization(c);
    await as(c, admin);
    for (const key of [ACTIVE_KEY, UG_KEY, UNKNOWN_KEY, 'not-a-catalog-key']) {
      await expectRefusal(setPlacement(c, admin.org, { key }), '22023', 'placement target unavailable');
    }
    expect(await placementRow(c, admin.org)).toBeNull();
    expect(await ledger(c, admin.org)).toEqual([]);
    // Placements that need no catalog still work.
    const unlisted = await setPlacement(c, admin.org, { name: 'Example Regional Council', state: 'OR' });
    expect(unlisted.placement).toMatchObject({ parentCatalogKey: null, parentName: null, parentActive: false, unlistedParentName: 'Example Regional Council', unlistedParentState: 'OR', identityUnlisted: false, verificationStatus: 'self_reported' });
    // A key stored while a catalog was installed reads back with no name and
    // parentActive false once the catalog is gone.
    await c.query('reset role');
    await c.query('update private.organization_catalog_placements set parent_catalog_key=$2, unlisted_parent_name=null, unlisted_parent_state=null where organization_id=$1', [admin.org, ACTIVE_KEY]);
    const read = await getPlacement(c, admin.org);
    expect(read.placement).toMatchObject({ parentCatalogKey: ACTIVE_KEY, parentName: null, parentActive: false });
  });
});

live('6. set with an active parent key writes one self_reported row and one allow-listed ledger row', async () => {
  await withClient(async (c) => {
    await catalogRows(c);
    const admin = await organization(c);
    await as(c, admin);
    expect(await getPlacement(c, admin.org)).toEqual({ placement: null });
    const idem = randomUUID();
    const result = await setPlacement(c, admin.org, { key: ACTIVE_KEY, idem });
    expect(result.placement).toMatchObject({
      parentCatalogKey: ACTIVE_KEY, parentName: 'Example Workers Local 1', parentActive: true,
      unlistedParentName: null, unlistedParentState: null, identityUnlisted: false, verificationStatus: 'self_reported',
    });
    expect(Object.keys(result.placement).sort()).toEqual(['identityUnlisted', 'parentActive', 'parentCatalogKey', 'parentName', 'unlistedParentName', 'unlistedParentState', 'updatedAt', 'verificationStatus']);
    expect(await getPlacement(c, admin.org)).toEqual(result);
    await c.query('reset role');
    expect(await placementRow(c, admin.org)).toMatchObject({ parent_catalog_key: ACTIVE_KEY, verification_status: 'self_reported', identity_unlisted: false });
    const rows = await ledger(c, admin.org);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'update', domain: 'administration', entity_type: 'organization', entity_id: admin.org, actor_user_id: admin.user, idempotency_key: idem });
    expect(rows[0].metadata).toEqual({ entityType: 'catalog_organization', entityId: ACTIVE_KEY, fromStatus: 'unset', toStatus: 'self_reported', reasonCode: 'parent_set' });
    // An unlisted parent and "the catalog does not list us" never put the
    // free-text name or state into audit metadata.
    const unlistedIdem = randomUUID(), identityIdem = randomUUID();
    await setPlacement(c, admin.org, { name: 'Example Regional Council', state: 'WA', identity: true, idem: unlistedIdem });
    await setPlacement(c, admin.org, { identity: true, idem: identityIdem });
    const all = await ledger(c, admin.org);
    expect(all).toHaveLength(3);
    for (const row of all) {
      expect(Object.keys(row.metadata).every((key) => LEDGER_METADATA_KEYS.includes(key)), JSON.stringify(row.metadata)).toBe(true);
      expect(JSON.stringify(row.metadata)).not.toMatch(/Example Regional Council|"WA"/);
    }
    // Rows written in one transaction share occurred_at, so find them by key.
    const byKey = (key) => all.find((row) => row.idempotency_key === key).metadata;
    expect(byKey(unlistedIdem)).toEqual({ entityType: 'unlisted', fromStatus: 'self_reported', toStatus: 'self_reported', reasonCode: 'parent_set' });
    expect(byKey(identityIdem)).toEqual({ entityType: 'unlisted', fromStatus: 'self_reported', toStatus: 'self_reported', reasonCode: 'identity_unlisted' });
    expect(await placementRow(c, admin.org)).toMatchObject({ parent_catalog_key: null, unlisted_parent_name: null, unlisted_parent_state: null, identity_unlisted: true });
    // A change refreshes updated_at and keeps placed_at; one transaction has
    // one now(), so the row is backdated first.
    await c.query("update private.organization_catalog_placements set placed_at=now()-interval '1 day', updated_at=now()-interval '1 day' where organization_id=$1", [admin.org]);
    await setPlacement(c, admin.org, { key: ACTIVE_KEY });
    await c.query('reset role');
    expect((await c.query('select updated_at=now() as u, placed_at<now() as p from private.organization_catalog_placements where organization_id=$1', [admin.org])).rows[0]).toEqual({ u: true, p: true });
  });
});

live('7. unknown, retired and duplicate keys get the same refusal, and a parent retired later reads as inactive', async () => {
  await withClient(async (c) => {
    const release = await catalogRows(c);
    const admin = await organization(c);
    await as(c, admin);
    const messages = [];
    for (const key of [UNKNOWN_KEY, RETIRED_KEY, DUPLICATE_KEY, 'OLMS-900000001', 'ug-EXAMPLEX01']) {
      const error = await setPlacement(c, admin.org, { key }).then(() => null, (e) => e);
      expect(error?.code, key).toBe('22023');
      messages.push(error.message);
    }
    expect(new Set(messages)).toEqual(new Set(['placement target unavailable']));
    expect(await placementRow(c, admin.org)).toBeNull();
    // The ug- key form is admitted when the row is active.
    expect((await setPlacement(c, admin.org, { key: UG_KEY })).placement).toMatchObject({ parentCatalogKey: UG_KEY, parentName: 'Sample Transit Council', parentActive: true });
    // With no active release, even an active row is unavailable.
    await c.query('reset role');
    await c.query("update private.catalog_releases set status='retired'");
    await expectRefusal(setPlacement(c, admin.org, { key: ACTIVE_KEY }), '22023', 'placement target unavailable');
    expect((await getPlacement(c, admin.org)).placement).toMatchObject({ parentCatalogKey: UG_KEY, parentName: 'Sample Transit Council', parentActive: false });
    await c.query('reset role');
    await c.query("update private.catalog_releases set status='active' where id=$1", [release]);
    // A parent retired after placement keeps its last name and reads inactive.
    await c.query('update private.catalog_organizations set retired_release_id=$2 where catalog_key=$1', [UG_KEY, randomUUID()]);
    expect((await getPlacement(c, admin.org)).placement).toMatchObject({ parentCatalogKey: UG_KEY, parentName: 'Sample Transit Council', parentActive: false });
  });
});

live('8. unlisted names carrying an email, link or phone number are refused, and so are malformed combinations', async () => {
  await withClient(async (c) => {
    await catalogRows(c);
    const admin = await organization(c);
    await as(c, admin);
    for (const name of [
      'Council contact@example.invalid', 'See https://example.invalid/council', 'Call 5550100000', 'Call (555) 010-0000', 'Call 555.010.0000', 'AB', `Tab\there`, 'x'.repeat(201),
      // Names with no letter or digit render blank or as bare punctuation.
      '\u00a0\u00a0\u00a0', '\u200b\u200b\u200b', '\u3000\u3000\u3000', '...',
      // Slashes, underscores, dashes and full-width digits do not hide a phone number.
      'Call 555/010/0000', 'Call 555_010_0000', 'Call 555\u2013010\u20130000', 'Call \uff15\uff15\uff15\uff10\uff11\uff10\uff10\uff10\uff10\uff10',
    ]) {
      await expectRefusal(setPlacement(c, admin.org, { name }), '22023', 'placement name invalid');
    }
    await expectRefusal(setPlacement(c, admin.org, { key: ACTIVE_KEY, name: 'Example Regional Council' }), '22023', 'placement parent ambiguous');
    await expectRefusal(setPlacement(c, admin.org, { state: 'OR' }), '22023', 'placement state needs name');
    await expectRefusal(setPlacement(c, admin.org, {}), '22023', 'placement empty');
    await expectRefusal(setPlacement(c, admin.org, { name: 'Example Regional Council', state: 'Oregon' }), '22023', 'placement state invalid');
    await expectRefusal(setPlacement(c, admin.org, { name: 'Example Regional Council', state: 'or' }), '22023', 'placement state invalid');
    await expectRefusal(setPlacement(c, admin.org, { key: ACTIVE_KEY, idem: null }), '22023', 'idempotency key required');
    await expectRefusal(clearPlacement(c, admin.org, null), '22023', 'idempotency key required');
    expect(await placementRow(c, admin.org)).toBeNull();
    expect(await ledger(c, admin.org)).toEqual([]);
    // A short local number is fine; the trimmed name is stored.
    expect((await setPlacement(c, admin.org, { name: '  Example Workers Local 1234  ' })).placement.unlistedParentName).toBe('Example Workers Local 1234');
    // Two short numbers split by words, and a name in a non-Latin script, are fine.
    expect((await setPlacement(c, admin.org, { name: 'Example Workers Local 1234 District 5678' })).placement.unlistedParentName).toBe('Example Workers Local 1234 District 5678');
    expect((await setPlacement(c, admin.org, { name: '\u6771\u4eac\u5730\u65b9\u8a55\u8b70\u4f1a' })).placement.unlistedParentName).toBe('\u6771\u4eac\u5730\u65b9\u8a55\u8b70\u4f1a');
  });
});

live('9. an idempotent replay returns the current state and writes one ledger row; the same key elsewhere is refused', async () => {
  await withClient(async (c) => {
    await catalogRows(c);
    const admin = await organization(c);
    const other = await organization(c, { name: 'Sample Transit Council' });
    await as(c, admin);
    const idem = randomUUID();
    const first = await setPlacement(c, admin.org, { key: ACTIVE_KEY, idem });
    const replay = await setPlacement(c, admin.org, { key: UG_KEY, idem });
    expect(replay).toEqual(first);
    expect(await ledger(c, admin.org)).toHaveLength(1);
    const clearIdem = randomUUID();
    expect(await clearPlacement(c, admin.org, clearIdem)).toEqual({ placement: null });
    expect(await clearPlacement(c, admin.org, clearIdem)).toEqual({ placement: null });
    expect(await ledger(c, admin.org)).toHaveLength(2);
    // A key spent on one operation is not a replay of the other.
    await expectRefusal(setPlacement(c, admin.org, { key: ACTIVE_KEY, idem: clearIdem }), '22023', 'idempotency key reused');
    expect(await ledger(c, admin.org)).toHaveLength(2);
    await setPlacement(c, admin.org, { key: UG_KEY });
    await expectRefusal(clearPlacement(c, admin.org, idem), '22023', 'idempotency key reused');
    await c.query('reset role');
    expect((await placementRow(c, admin.org)).parent_catalog_key).toBe(UG_KEY);
    expect(await ledger(c, admin.org)).toHaveLength(3);
    await as(c, other);
    await expectRefusal(setPlacement(c, other.org, { key: ACTIVE_KEY, idem }), '22023', 'idempotency key reused');
    await expectRefusal(clearPlacement(c, other.org, idem), '22023', 'idempotency key reused');
    // A key another ledger event already used is refused too.
    await c.query('reset role');
    const foreignIdem = randomUUID();
    await c.query("insert into public.organization_audit_ledger(organization_id,domain,event_type,action,entity_type,entity_id,idempotency_key) values ($1::uuid,'administration','proof_other_event','update','organization',$2::text,$3::uuid)", [other.org, other.org, foreignIdem]);
    await expectRefusal(setPlacement(c, other.org, { key: ACTIVE_KEY, idem: foreignIdem }), '22023', 'idempotency key reused');
    await expectRefusal(clearPlacement(c, other.org, foreignIdem), '22023', 'idempotency key reused');
    expect(await placementRow(c, other.org)).toBeNull();
    expect(await ledger(c, other.org)).toEqual([]);
  });
});

live('10. the eleventh placement change in 24 hours is refused', async () => {
  await withClient(async (c) => {
    await catalogRows(c);
    const admin = await organization(c);
    await as(c, admin);
    for (let n = 0; n < 10; n += 1) {
      await setPlacement(c, admin.org, n % 2 ? { key: ACTIVE_KEY } : { identity: true });
    }
    expect(await ledger(c, admin.org)).toHaveLength(10);
    await expectRefusal(setPlacement(c, admin.org, { key: UG_KEY }), '22023', 'placement change limit');
    await expectRefusal(clearPlacement(c, admin.org), '22023', 'placement change limit');
    expect(await ledger(c, admin.org)).toHaveLength(10);
    await c.query('reset role');
    expect((await placementRow(c, admin.org)).parent_catalog_key).toBe(ACTIVE_KEY);
    // Rows 23 hours old still count, for set and clear.
    await c.query("alter table public.organization_audit_ledger disable trigger user");
    await c.query("update public.organization_audit_ledger set occurred_at=now()-interval '23 hours' where organization_id=$1 and event_type=$2", [admin.org, EVENT]);
    await c.query("alter table public.organization_audit_ledger enable trigger user");
    await expectRefusal(setPlacement(c, admin.org, { key: UG_KEY }), '22023', 'placement change limit');
    await expectRefusal(clearPlacement(c, admin.org), '22023', 'placement change limit');
    // Rows older than 24 hours no longer count, for clear and set.
    await c.query('reset role');
    await c.query("alter table public.organization_audit_ledger disable trigger user");
    await c.query("update public.organization_audit_ledger set occurred_at=now()-interval '25 hours' where organization_id=$1 and event_type=$2", [admin.org, EVENT]);
    await c.query("alter table public.organization_audit_ledger enable trigger user");
    expect(await clearPlacement(c, admin.org)).toEqual({ placement: null });
    expect((await setPlacement(c, admin.org, { key: UG_KEY })).placement.parentCatalogKey).toBe(UG_KEY);
    expect(await ledger(c, admin.org)).toHaveLength(12);
  });
});

live('11. clear deletes the row and writes a cleared ledger row; clearing nothing writes nothing', async () => {
  await withClient(async (c) => {
    await catalogRows(c);
    const admin = await organization(c);
    await as(c, admin);
    expect(await clearPlacement(c, admin.org)).toEqual({ placement: null });
    expect(await ledger(c, admin.org)).toEqual([]);
    await setPlacement(c, admin.org, { key: ACTIVE_KEY });
    const idem = randomUUID();
    expect(await clearPlacement(c, admin.org, idem)).toEqual({ placement: null });
    expect(await getPlacement(c, admin.org)).toEqual({ placement: null });
    await c.query('reset role');
    expect(await placementRow(c, admin.org)).toBeNull();
    const rows = await ledger(c, admin.org);
    expect(rows).toHaveLength(2);
    const cleared = rows.find((row) => row.idempotency_key === idem);
    expect(cleared).toMatchObject({ action: 'update', entity_type: 'organization', entity_id: admin.org, actor_user_id: admin.user });
    expect(cleared.metadata).toEqual({ fromStatus: 'self_reported', toStatus: 'cleared', reasonCode: 'cleared' });
  });
});

live('12. authenticated and service_role cannot read or write the placement table directly', async () => {
  await withClient(async (c) => {
    const admin = await organization(c);
    await c.query("insert into private.organization_catalog_placements(organization_id,identity_unlisted) values ($1,true)", [admin.org]);
    await as(c, admin);
    for (const role of ['authenticated', 'service_role', 'anon']) {
      const acl = (await c.query("select has_table_privilege($1,'private.organization_catalog_placements','select,insert,update,delete') as any", [role])).rows[0];
      expect(acl.any, role).toBe(false);
    }
    for (const role of ['authenticated', 'service_role']) {
      await c.query('savepoint direct');
      await c.query(`set local role ${role}`);
      await expect(c.query('select * from private.organization_catalog_placements')).rejects.toMatchObject({ code: '42501' });
      await c.query('rollback to savepoint direct');
      await c.query(`set local role ${role}`);
      await expect(c.query("insert into private.organization_catalog_placements(organization_id,identity_unlisted) values ($1,true)", [randomUUID()])).rejects.toMatchObject({ code: '42501' });
      await c.query('rollback to savepoint direct');
      await c.query('release savepoint direct');
    }
    const rls = (await c.query("select relrowsecurity, relforcerowsecurity from pg_class where oid='private.organization_catalog_placements'::regclass")).rows[0];
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await c.query("select count(*)::int n from pg_policy where polrelid='private.organization_catalog_placements'::regclass")).rows[0].n).toBe(0);
  });
});

live('13. the table admits only self_reported and its shape checks hold for a direct owner write', async () => {
  await withClient(async (c) => {
    const admin = await organization(c);
    const attempt = async (sql, params, code) => {
      await c.query('savepoint shape');
      await expect(c.query(sql, params)).rejects.toMatchObject({ code });
      await c.query('rollback to savepoint shape');
    };
    await attempt("insert into private.organization_catalog_placements(organization_id,identity_unlisted,verification_status) values ($1,true,'verified')", [admin.org], '23514');
    await attempt("insert into private.organization_catalog_placements(organization_id,parent_catalog_key,unlisted_parent_name) values ($1,$2,'Example Regional Council')", [admin.org, ACTIVE_KEY], '23514');
    await attempt('insert into private.organization_catalog_placements(organization_id) values ($1)', [admin.org], '23514');
    await attempt("insert into private.organization_catalog_placements(organization_id,parent_catalog_key) values ($1,'olms-abc')", [admin.org], '23514');
    await attempt("insert into private.organization_catalog_placements(organization_id,identity_unlisted,unlisted_parent_state) values ($1,true,'OR')", [admin.org], '23514');
    await attempt("insert into private.organization_catalog_placements(organization_id,unlisted_parent_name) values ($1,'AB')", [admin.org], '23514');
    await attempt('insert into private.organization_catalog_placements(organization_id,unlisted_parent_name) values ($1,$2)', [admin.org, 'Example\tCouncil'], '23514');
    await attempt("insert into private.organization_catalog_placements(organization_id,unlisted_parent_name) values ($1,'...')", [admin.org], '23514');
    await attempt("insert into private.organization_catalog_placements(organization_id,unlisted_parent_name,unlisted_parent_state) values ($1,'Example Regional Council','or')", [admin.org], '23514');
    // The platform boundary rejects an unknown organization before FK checks.
    await attempt('insert into private.organization_catalog_placements(organization_id,identity_unlisted) values ($1,true)', [randomUUID()], '42501');
    // The row goes with its organization; the delete cascade is the only action.
    // 20260930040000 (Phase 3a) adds two NO ACTION keys, to the verified catalog
    // identity and to the approved claim; neither cascades.
    const fk = (await c.query("select conname, confdeltype, confupdtype from pg_constraint where conrelid='private.organization_catalog_placements'::regclass and contype='f' order by conname")).rows;
    expect(fk).toEqual([
      { conname: 'organization_catalog_placements_identity_catalog_key_fkey', confdeltype: 'a', confupdtype: 'a' },
      { conname: 'organization_catalog_placements_organization_id_fkey', confdeltype: 'c', confupdtype: 'c' },
      { conname: 'organization_catalog_placements_verified_claim_id_fkey', confdeltype: 'a', confupdtype: 'a' },
    ]);
  });
});

live('14. the placement functions never touch chapter_union_org_bindings', async () => {
  await withClient(async (c) => {
    const bodies = (await c.query("select p.proname, pg_catalog.pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and p.proname in ('get_organization_catalog_placement','set_organization_catalog_placement','clear_organization_catalog_placement')) or (n.nspname='private' and p.proname in ('organization_catalog_parent','organization_catalog_parent_row','organization_catalog_placement_state')) order by 1")).rows;
    expect(bodies.map((row) => row.proname)).toEqual(['clear_organization_catalog_placement', 'get_organization_catalog_placement', 'organization_catalog_parent', 'organization_catalog_placement_state', 'set_organization_catalog_placement']);
    for (const row of bodies) expect(row.def, row.proname).not.toContain('chapter_union_org_bindings');
    // The catalog read is plpgsql, so plpgsql_check sees both catalog tables.
    await c.query('create extension if not exists plpgsql_check');
    const reads = (await c.query("select d.schema || '.' || d.name as relation from plpgsql_show_dependency_tb('private.organization_catalog_parent(text)'::regprocedure) d where d.type = 'RELATION' order by 1")).rows.map((row) => row.relation);
    expect(reads).toEqual(['private.catalog_organizations', 'private.catalog_releases']);
    expect((await c.query("select count(*)::int n from plpgsql_check_function_tb('private.organization_catalog_parent(text)'::regprocedure)")).rows[0].n).toBe(0);
    const snapshot = async () => (await c.query('select coalesce(md5(string_agg(t::text, \'|\' order by t::text)), \'\') digest, count(*)::int n from public.chapter_union_org_bindings t')).rows[0];
    const before = await snapshot();
    await catalogRows(c);
    const admin = await organization(c);
    await as(c, admin);
    await getPlacement(c, admin.org);
    await setPlacement(c, admin.org, { key: ACTIVE_KEY });
    await setPlacement(c, admin.org, { name: 'Example Regional Council', state: 'OR' });
    await clearPlacement(c, admin.org);
    await c.query('reset role');
    expect(await snapshot()).toEqual(before);
  });
});
