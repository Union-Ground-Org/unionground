// @vitest-environment node
// Phase 3a DB half (PR A): an existing organization's claims to be a union
// catalog listing, their email confirmation, the verification ladder (domain,
// platform verifier, verified parent union, verified sister chapter), the
// verified state on the Phase 4a placement row, and the public landing read.
// Fictional fixtures only (Example Workers Local 1, Example Council 9, people
// named Fixtureperson, .example domains); the consumer, hosting and family
// domains in case 8 are read from the config files. Every case runs in one
// transaction that rolls back on a disposable local database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';
import { registrableDomain } from '../scripts/union-catalog/privacy-filter.mjs';

const live = process.env.RUN_ORGANIZATION_CLAIM_DB_TESTS === '1' ? it : it.skip;

const BLOCKED_CONFIG = JSON.parse(readFileSync(new URL('../config/catalog-blocked-email-domains.json', import.meta.url), 'utf8'));
const FAMILY_CONFIG = JSON.parse(readFileSync(new URL('../config/catalog-family-domains.json', import.meta.url), 'utf8'));
const CONSUMER_DOMAIN = BLOCKED_CONFIG.consumer[0];
const HOSTING_DOMAIN = BLOCKED_CONFIG.hosting.find((domain) => domain.split('.').length === 2);
const FAMILY_DOMAIN = Object.values(FAMILY_CONFIG.families).flat()[0];

const ATTEST = { version: 'claim-attest/1', officer: true, verifyFirst: true, noPersonalData: true, notEmployer: true };
const VERIFIER = '50900500-0000-4000-8000-000000000001';
const SECOND_VERIFIER = '50900500-0000-4000-8000-000000000002';

live('24. every verifier operation requires the exact live, stepped-up, post-reset session outside recovery', async () => {
  await withClient(async (c) => {
    const operator = await verifier(c);
    const other = await verifier(c, SECOND_VERIFIER);
    const session = verifierSession(operator);
    const calls = [
      ['public.list_organization_claims($1,null,1,$2)', [operator]],
      ['public.get_organization_claim($1,$2,$3)', [operator, randomUUID()]],
      ["public.review_organization_claim($1,$2,'release',null,null,null,null,null,$3,$4)", [randomUUID(), operator, randomUUID()]],
      ["public.revoke_organization_claim($1,$2,'wrong_claimant',null,$3,$4)", [randomUUID(), operator, randomUUID()]],
      ["public.issue_organization_claim_mailback($1,$2,'123456789A',$3,$4)", [randomUUID(), operator, randomUUID()]],
    ];
    const refusesEveryOperation = async (candidate) => {
      for (const [sql, args] of calls) {
        await expectRefusal(svc(c, sql, [...args, candidate]), '42501', 'claim verifier required');
      }
    };
    await refusesEveryOperation(null);
    await refusesEveryOperation(randomUUID());
    await refusesEveryOperation(verifierSession(other));
    await expectRefusal(svc(c, 'public.list_organization_claims($1,null,1)', [operator]), '42501', 'claim verifier required');

    for (const [sql, params] of [
      ["update auth.sessions set aal='aal1' where id=$1", [session]],
      ["update auth.sessions set not_after=now()-interval '1 second' where id=$1", [session]],
      ['delete from auth.sessions where id=$1', [session]],
      ["update auth.mfa_factors set status='unverified' where user_id=$1", [operator]],
      ["insert into private.member_mfa_recovery_locks(user_id,claim_token_hash) values ($1,repeat('0',64))", [operator]],
      ['insert into private.member_mfa_reset_boundaries(user_id,invalid_before) values ($1,now())', [operator]],
    ]) {
      await c.query('savepoint invalid_verifier_session');
      await c.query(sql, params);
      await refusesEveryOperation(session);
      await c.query('rollback to savepoint invalid_verifier_session');
      await c.query('release savepoint invalid_verifier_session');
    }
    expect(await svc(c, 'public.list_organization_claims($1,null,1,$2)', [operator, session]))
      .toEqual({ page: 1, claims: [] });
    await c.query("insert into private.member_mfa_reset_boundaries(user_id,invalid_before) values ($1,now()-interval '1 second')", [operator]);
    expect(await svc(c, 'public.list_organization_claims($1,null,1,$2)', [operator, session]))
      .toEqual({ page: 1, claims: [] });
  });
}, 120_000);

// Catalog keys: olms-900000001 (Example Workers Local 1), olms-900000009
// (Example Council 9), the special fixtures 2..17 and generic entries 20..69
// (Example Workers Local <n> on https://examplelocal<n>.example).
const key = (n) => `olms-${900000000 + n}`;
const domainOf = (n) => (n === 9 ? 'examplecouncil9.example' : `examplelocal${n}.example`);
const ownEmail = (n) => `officer@${domainOf(n)}`;
const K1 = key(1);
const K9 = key(9);
const RETIRED = key(2);
const DUPLICATE = key(3);
const UNKNOWN = key(99);
const SHARED_A = key(11);
const SHARED_B = key(12);
const CONTACT_TARGET = key(13);
const CONTACT_OWNER = key(14);
const STALE = key(15);
const SECONDARY = key(16);
const ELECTION = key(17);
const CONSUMER_EMAIL = `alex.fixtureperson@${CONSUMER_DOMAIN}`;
const NEW_TABLES = ['platform_operators', 'catalog_claim_blocked_domains', 'organization_claims', 'catalog_review_events'];

const hex = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const json = (value) => (value === null || value === undefined ? null : JSON.stringify(value));
const sorted = (values) => [...values].sort();

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

// Calls one function as `role` inside a savepoint, so a refusal leaves the
// outer transaction usable. Resolves to the result or rejects with the error.
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

// A service-role call: the RPCs check auth.jwt() ->> 'role', so the claims
// say service_role for the call and are restored afterwards.
async function svc(c, sql, params) {
  const prior = (await c.query("select coalesce(current_setting('request.jwt.claims', true), '') as v")).rows[0].v;
  await c.query('savepoint svc_call');
  try {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'service_role' })]);
    await c.query('set local role service_role');
    const result = (await c.query(`select ${sql} as r`, params)).rows[0].r;
    await c.query('reset role');
    await c.query("select set_config('request.jwt.claims', $1, true)", [prior]);
    await c.query('release savepoint svc_call');
    return result;
  } catch (error) {
    await c.query('rollback to savepoint svc_call');
    await c.query('release savepoint svc_call');
    throw error;
  }
}

async function expectRefusal(promise, code, message) {
  const error = await promise.then(() => null, (e) => e);
  expect(error, `expected ${code} ${message ?? ''}`).not.toBeNull();
  expect(error.code, error.message).toBe(code);
  if (message) expect(error.message).toBe(message);
  return error;
}

async function owner(c) {
  await c.query('reset role');
  await c.query("select set_config('request.jwt.claims', '', true)");
}

// Fictional catalog rows in the real Phase 2a tables, inserted as the owner.
async function catalog(c) {
  let release = (await c.query("select id from private.catalog_releases where status='active'")).rows[0]?.id;
  if (!release) {
    release = randomUUID();
    await c.query(
      `insert into private.catalog_releases(id,label,status,schema_version,filter_version,source_sha256,artifact_sha256,source_built_at,counts,activated_at)
       values ($1,'20990101-01','active','union-catalog-release/1','privacy-filter/1',repeat('0',64),repeat('0',64),now(),'{}'::jsonb,now())`,
      [release],
    );
  }
  const rows = [
    [K1, 'Example Workers Local 1', 'https://examplelocal1.example', 'official_site', 30, null, null, null],
    [K9, 'Example Council 9', 'https://www.examplecouncil9.example/', 'official_site', 30, null, null, null],
    [RETIRED, 'Example Workers Local 2', 'https://examplelocal2.example', 'official_site', 30, null, randomUUID(), null],
    [DUPLICATE, 'Example Workers Local 3', null, 'official_site', 30, null, null, K1],
    [SHARED_A, 'Example Workers Local 11', 'https://sharedlocals.example/eleven', 'official_site', 30, null, null, null],
    [SHARED_B, 'Example Workers Local 12', 'https://www.sharedlocals.example/twelve', 'official_site', 30, null, null, null],
    [CONTACT_TARGET, 'Example Workers Local 13', 'https://examplelocal13.example', 'official_site', 30, null, null, null],
    [CONTACT_OWNER, 'Example Workers Local 14', 'https://examplelocal14.example', 'official_site', 30, null, null, null],
    [STALE, 'Example Workers Local 15', 'https://examplelocal15.example', 'official_site', 600, null, null, null],
    [SECONDARY, 'Example Workers Local 16', 'https://examplelocal16.example', 'secondary', 30, null, null, null],
    [ELECTION, 'Example Workers Local 17', 'https://examplelocal17.example', 'official_site', 30, 30, null, null],
    // Listings whose site is a subdomain of a wider registrable domain.
    [key(10), 'Example Workers Local 10', 'https://local10.exampledistrict.example', 'official_site', 30, null, null, null],
    [key(18), 'Example Workers Local 18', 'https://local18.examplecity.example', 'official_site', 30, null, null, null],
    [key(19), 'Example Workers Local 19', 'https://local19.examplecounty.example/', 'official_site', 30, null, null, null],
    [key(4), 'Example Workers Local 4', 'https://local4.exampleschools.example', 'official_site', 30, null, null, null],
  ];
  for (let n = 20; n < 70; n += 1) rows.push([key(n), `Example Workers Local ${n}`, `https://${domainOf(n)}`, 'official_site', 30, null, null, null]);
  for (const [catalogKey, name, website, confidence, researchedAgo, electionIn, retired, duplicateOf] of rows) {
    await c.query(
      `insert into private.catalog_organizations
         (catalog_key,name,tier,confidence,website,researched_on,next_election_on,search_text,first_release_id,last_release_id,retired_release_id,duplicate_of,content_sha256)
       values ($1,$2,'local',$3,$4,current_date - $5::int,current_date + $6::int,lower($2),$7,$7,$8,$9,repeat('0',64))`,
      [catalogKey, name, confidence, website, researchedAgo, electionIn, release, retired, duplicateOf],
    );
  }
  // Another listing's role mailbox on examplelocal13.example makes that
  // domain shared; an office phone for Example Workers Local 1.
  await c.query(
    `insert into private.catalog_contacts(contact_key,catalog_key,contact_kind,value,basis,source_url,first_release_id,last_release_id,content_sha256)
     values ($1,$2,'email','office@examplelocal13.example','own_site','https://examplelocal14.example/contact',$5,$5,repeat('0',64)),
            ($3,$4,'phone','555-0100','own_site','https://examplelocal1.example/contact',$5,$5,repeat('0',64))`,
    [`${CONTACT_OWNER}~email-000000000001`, CONTACT_OWNER, `${K1}~phone-000000000001`, K1, release],
  );
  return release;
}

// A public-record hierarchy edge (child under parent), inserted as the owner.
async function edge(c, child, parent, kind = 'parent_body') {
  const release = (await c.query("select id from private.catalog_releases where status='active'")).rows[0].id;
  await c.query(
    `insert into private.catalog_edges(edge_key,child_key,parent_key,edge_kind,certainty,source_url,first_release_id,last_release_id,content_sha256)
     values ($1,$2,$3,$4,'confirmed','https://examplecouncil9.example/locals',$5,$5,repeat('0',64))`,
    [`proof-${child}-${parent}-${kind}`, child, parent, kind, release],
  );
}

// One fictional organization with a default chapter and one member (the
// admin, with a verified second factor unless told otherwise). No
// org_security_policy row: staff_mfa_required() then defaults to true.
async function organization(c, { name = 'Example Workers Local 1', admin = true, factor = true, email } = {}) {
  const org = randomUUID();
  const chapter = `proof-${org}`;
  await c.query('insert into public.organizations(id,slug,name) values ($1,$2,$3)', [org, chapter, `${name} ${org.slice(0, 8)}`]);
  await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)", [chapter, org]);
  return { ...(await member(c, { org, chapter }, { role: admin ? 'admin' : null, factor, email })), chapter, slug: chapter };
}

// `aal` defaults to aal2 with a factor; aal1 with a factor is a session that has not stepped up.
async function member(c, { org, chapter }, { role = null, factor = true, aal = factor ? 'aal2' : 'aal1', email } = {}) {
  const user = randomUUID();
  const session = randomUUID();
  await c.query('insert into auth.users(id,email) values ($1,$2)', [user, email ?? `fixtureperson.${user.slice(0, 8)}@members.example`]);
  await c.query('update public.member_profiles set chapter_id=$2 where id=$1', [user, chapter]);
  await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, user]);
  await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [user, chapter]);
  if (role) await c.query('insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,$3)', [org, user, role]);
  if (factor) await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user]);
  await c.query('insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,$3,now(),now())', [session, user, aal]);
  return { org, chapter, user, session, aal };
}

async function as(c, who) {
  await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: who.user, session_id: who.session, role: 'authenticated', aal: who.aal })]);
}

const verifierSession = (id) => id ? id.replace(/^[0-9a-f]{8}/, '50900600') : null;

async function verifier(c, id = VERIFIER) {
  await c.query('insert into auth.users(id,email) values ($1,$2)', [id, `verifier.${id.slice(-4)}@fixture-verifier.example`]);
  await svc(c, 'public.set_platform_operator($1,$2,$3,$4)', [id, true, 'Fixture verifier', randomUUID()]);
  await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
  await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [verifierSession(id), id]);
  return id;
}

const claimant = (email, extra = {}) => ({ name: 'Alex Fixtureperson', title: 'Secretary-Treasurer', email, statement: '', ...extra });

// Every claim is filed by an admin of an existing organization.
async function submit(c, {
  admin, target = null, unlisted = null, email = ownEmail(1), who, attestation = ATTEST, locale = 'en',
  token = hex(), scope = hex(), emailScope = hex(), user, org,
} = {}) {
  const result = await svc(c, 'public.submit_organization_claim($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10)', [
    scope, emailScope, target, json(unlisted), json(who ?? claimant(email)), json(attestation), locale, token,
    user === undefined ? admin?.user ?? null : user, org === undefined ? admin?.org ?? null : org,
  ]);
  return { result, token, scope, emailScope };
}

// Files a claim for `admin` (or a fresh organization's admin) and returns its id.
async function file(c, options = {}) {
  const admin = options.admin ?? await organization(c, { name: options.orgName });
  const submitted = await submit(c, { ...options, admin });
  expect(submitted.result).toEqual({ accepted: true, deliver: true });
  const id = (await c.query('select id from private.organization_claims where confirm_token_hash=$1', [submitted.token])).rows[0].id;
  return { ...submitted, id, admin };
}

const confirm = (c, token, scope = hex()) => svc(c, 'public.confirm_organization_claim($1,$2)', [token, scope]);

async function fileAndConfirm(c, options) {
  const filed = await file(c, options);
  const confirmed = await confirm(c, filed.token);
  return { ...filed, confirmed, row: await claimRow(c, filed.id) };
}

const review = (c, id, operator, decision, { method = null, hold = null, reason = null, note = null, code = null, idem = randomUUID() } = {}) =>
  svc(c, 'public.review_organization_claim($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, operator, decision, method, hold, reason, note, code, idem, verifierSession(operator)]);
const revokeClaim = (c, id, operator, { reason = 'wrong_claimant', note = null, idem = randomUUID() } = {}) =>
  svc(c, 'public.revoke_organization_claim($1,$2,$3,$4,$5,$6)', [id, operator, reason, note, idem, verifierSession(operator)]);
const issueMailback = (c, id, operator, code, idem = randomUUID()) =>
  svc(c, 'public.issue_organization_claim_mailback($1,$2,$3,$4,$5)', [id, operator, code, idem, verifierSession(operator)]);

const getVerification = (c, org, hat = 'admin') => rpc(c, 'public.get_organization_catalog_verification($1,$2)', [hat, org]);
const getPlacement = (c, org, hat = 'admin') => rpc(c, 'public.get_organization_catalog_placement($1,$2)', [hat, org]);
const setPlacement = (c, org, { parent = null, name = null, state = null, identity = false, idem = randomUUID() } = {}) =>
  rpc(c, 'public.set_organization_catalog_placement($1,$2,$3,$4,$5,$6,$7)', ['admin', org, parent, name, state, identity, idem]);
const clearPlacement = (c, org, idem = randomUUID()) => rpc(c, 'public.clear_organization_catalog_placement($1,$2,$3)', ['admin', org, idem]);
const listVouchable = (c, org, hat = 'admin') => rpc(c, 'public.list_vouchable_organization_claims($1,$2)', [hat, org]);
const vouch = (c, org, ids, { idem = randomUUID(), hat = 'admin' } = {}) =>
  rpc(c, 'public.vouch_for_organization_claims($1,$2,$3::uuid[],$4)', [hat, org, ids, idem]);
const publicRead = (c, slug) => rpc(c, 'public.get_organization_public_verification($1)', [slug], 'anon');

// Self-reports a placement through 4a's RPC as the organization's admin.
async function selfReport(c, admin, options) {
  await as(c, admin);
  await setPlacement(c, admin.org, options);
  await owner(c);
}

// A verified organization: its admin's own-domain claim on key(n) approves automatically.
async function verifiedOrganization(c, n, options = {}) {
  const filed = await fileAndConfirm(c, { target: key(n), email: ownEmail(n), ...options });
  expect(filed.row.status).toBe('approved');
  return { ...filed.admin, claimId: filed.id };
}

async function claimRow(c, id) {
  return (await c.query('select * from private.organization_claims where id=$1', [id])).rows[0] ?? null;
}

async function placementRow(c, org) {
  return (await c.query('select * from private.organization_catalog_placements where organization_id=$1', [org])).rows[0] ?? null;
}

async function eventTypes(c, claimId) {
  return (await c.query('select event_type from private.catalog_review_events where claim_id=$1 order by event_type', [claimId])).rows.map((row) => row.event_type);
}

async function ledgerRows(c, org, eventType) {
  return (await c.query('select action, actor_user_id, entity_type, entity_id, metadata from public.organization_audit_ledger where organization_id=$1 and event_type=$2 order by metadata::text', [org, eventType])).rows;
}

async function counts(c) {
  return (await c.query(`select (select count(*)::int from private.organization_claims) claims,
                                (select count(*)::int from private.catalog_review_events) events,
                                (select count(*)::int from public.organization_audit_ledger) ledger,
                                (select count(*)::int from private.organization_catalog_placements) placements`)).rows[0];
}

// A claim row written directly as the owner (retention and lifecycle cases).
async function insertClaim(c, row) {
  const base = {
    claimant_name: 'Alex Fixtureperson', claimant_title: 'Secretary-Treasurer', claimant_email: ownEmail(1), statement: 'Fixture statement',
    claimant_email_scope: hex(), locale: 'en', attestation_version: 'claim-attest/1', attested_at: new Date(),
  };
  const values = { ...base, ...row };
  const columns = Object.keys(values);
  return (await c.query(
    `insert into private.organization_claims (${columns.join(',')}) values (${columns.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
    columns.map((column) => values[column]),
  )).rows[0].id;
}

// The organization-side rows an undo must never touch.
async function organizationState(c, org, user) {
  const q = async (sql) => (await c.query(sql, [org, user])).rows;
  return {
    organization: await q('select id, slug, name, status, created_by from public.organizations where id=$1 and $2::uuid is not null'),
    policy: await q('select organization_id, require_staff_mfa from public.org_security_policy where organization_id=$1 and $2::uuid is not null'),
    chapters: await q('select id, name, is_default from public.chapters where organization_id=$1 and $2::uuid is not null order by id'),
    memberships: await q('select user_id, status from public.organization_memberships where organization_id=$1 and user_id=$2'),
    grants: await q('select user_id, role from public.organization_role_grants where organization_id=$1 and user_id=$2 order by role'),
    profile: await q('select id, chapter_id from public.member_profiles where id=$2 and $1::uuid is not null'),
    account: await q('select id, email from auth.users where id=$2 and $1::uuid is not null'),
  };
}

live('1. anon, authenticated and service_role get 42501 on every verb of the four new tables and the altered placement table', async () => {
  await withClient(async (c) => {
    const updateColumn = { platform_operators: 'granted_note', catalog_claim_blocked_domains: 'list', organization_claims: 'locale', catalog_review_events: 'created_at', organization_catalog_placements: 'updated_at' };
    for (const table of [...NEW_TABLES, 'organization_catalog_placements']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const acl = (await c.query("select has_table_privilege($1,$2,'select,insert,update,delete,truncate,references,trigger') as any", [role, `private.${table}`])).rows[0];
        expect(acl.any, `${role} ${table}`).toBe(false);
        for (const statement of [
          `select * from private.${table}`,
          `insert into private.${table} default values`,
          `update private.${table} set ${updateColumn[table]} = ${updateColumn[table]}`,
          `delete from private.${table}`,
        ]) {
          await c.query('savepoint direct');
          await c.query(`set local role ${role}`);
          const error = await c.query(statement).then(() => null, (e) => e);
          await c.query('rollback to savepoint direct');
          await c.query('release savepoint direct');
          expect(error?.code, `${role}: ${statement}`).toBe('42501');
        }
      }
    }
    for (const table of NEW_TABLES) {
      const rls = (await c.query('select relrowsecurity, relforcerowsecurity from pg_class where oid=$1::regclass', [`private.${table}`])).rows[0];
      expect(rls, table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect((await c.query('select count(*)::int n from pg_policy where polrelid=$1::regclass', [`private.${table}`])).rows[0].n, table).toBe(0);
    }
  });
}, 120_000);

live('2. execute matrix: service-role RPCs, admin RPCs, the anonymous landing read, the isolation predicate, and no provisioning', async () => {
  await withClient(async (c) => {
    const acl = async (sig) => (await c.query(
      `select has_function_privilege('anon',$1,'execute') anon, has_function_privilege('authenticated',$1,'execute') auth,
              has_function_privilege('service_role',$1,'execute') svc,
              exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') public`,
      [sig],
    )).rows[0];
    for (const sig of [
      'public.submit_organization_claim(text,text,text,jsonb,jsonb,jsonb,text,text,uuid,uuid)',
      'public.confirm_organization_claim(text,text)',
      'public.review_organization_claim(uuid,uuid,text,text,text,text,text,text,uuid,uuid)',
      'public.issue_organization_claim_mailback(uuid,uuid,text,uuid,uuid)',
      'public.revoke_organization_claim(uuid,uuid,text,text,uuid,uuid)',
      'public.set_platform_operator(uuid,boolean,text,uuid)',
      'public.list_organization_claims(uuid,text,integer,uuid)',
      'public.get_organization_claim(uuid,uuid,uuid)',
    ]) {
      expect(await acl(sig), sig).toEqual({ anon: false, auth: false, svc: true, public: false });
    }
    for (const sig of [
      'public.get_organization_catalog_verification(text,uuid)', 'public.list_vouchable_organization_claims(text,uuid)',
      'public.vouch_for_organization_claims(text,uuid,uuid[],uuid)', 'public.clear_organization_catalog_placement(text,uuid,uuid)',
      'public.set_organization_catalog_placement(text,uuid,text,text,text,boolean,uuid)', 'public.list_organization_job_health()',
    ]) {
      expect(await acl(sig), sig).toEqual({ anon: false, auth: true, svc: false, public: false });
    }
    expect(await acl('public.get_organization_public_verification(text)')).toMatchObject({ anon: true, public: false });
    expect(await acl('private.organization_is_verified(uuid)')).toEqual({ anon: false, auth: true, svc: false, public: false });
    for (const sig of [
      'private.catalog_url_host(text)', 'private.catalog_registrable_domain(text)', 'private.catalog_claim_domain_signals(uuid)',
      'private.organization_claim_require_operator(uuid,uuid)', 'private.organization_claim_mailback_hmac(uuid,text)',
      'private.organization_claim_hold_contested(text,uuid,text,uuid)', 'private.organization_claim_verify_placement(uuid,text,uuid)',
      'private.organization_claim_withdraw(uuid,text,text,uuid,uuid,text)',
      'private.organization_claim_review_result(uuid,boolean)', 'private.organization_claim_vouch_relationship(uuid,text)',
      'private.purge_organization_claim_personal_data()', 'private.consume_public_interest_submission_limit(text,text,integer,interval)',
      'private.sync_organization_job_runs_from_cron_history()',
    ]) {
      expect(await acl(sig), sig).toEqual({ anon: false, auth: false, svc: false, public: false });
    }
    expect((await c.query("select to_regprocedure('public.provision_catalog_organization(uuid,uuid,uuid,text,uuid)') as p")).rows[0].p).toBeNull();
    // The grants hold at call time too.
    await expectRefusal(rpc(c, 'public.confirm_organization_claim($1,$2)', [hex(), hex()], 'anon'), '42501');
    await expectRefusal(rpc(c, 'public.confirm_organization_claim($1,$2)', [hex(), hex()], 'authenticated'), '42501');
    await expectRefusal(rpc(c, 'public.set_platform_operator($1,$2,$3,$4)', [randomUUID(), true, 'Fixture verifier', randomUUID()], 'authenticated'), '42501');
    await expectRefusal(rpc(c, 'public.get_organization_catalog_verification($1,$2)', ['admin', randomUUID()], 'service_role'), '42501');
    await expectRefusal(rpc(c, 'public.vouch_for_organization_claims($1,$2,$3::uuid[],$4)', ['admin', randomUUID(), [randomUUID()], randomUUID()], 'anon'), '42501');
    await expectRefusal(rpc(c, 'private.organization_is_verified($1)', [randomUUID()], 'anon'), '42501');
    expect(await publicRead(c, 'no-such-organization')).toEqual({ found: false });
    // A service-role grant is not enough without service-role claims.
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: 'authenticated' })]);
    await expectRefusal(rpc(c, 'public.confirm_organization_claim($1,$2)', [hex(), hex()], 'service_role'), '42501', 'service role required');
  });
}, 120_000);

live('3. silent refusals answer {accepted, deliver:false} and write nothing; a valid submit writes one row, one event and one ledger row', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const silent = async (label, options) => {
      const admin = options.admin ?? await organization(c);
      const before = await counts(c);
      const { result } = await submit(c, { ...options, admin });
      expect(result, label).toEqual({ accepted: true, deliver: false });
      expect(await counts(c), label).toEqual(before);
    };
    await silent('unknown key', { target: UNKNOWN, email: ownEmail(20) });
    await silent('retired key', { target: RETIRED, email: 'officer@examplelocal2.example' });
    await silent('duplicate_of key', { target: DUPLICATE, email: ownEmail(1) });
    // Network limit (5 per hour per network scope), exhausted by real submits.
    const network = hex();
    for (let n = 20; n < 25; n += 1) await file(c, { target: key(n), email: ownEmail(n), scope: network });
    await silent('network limit', { target: key(25), email: ownEmail(25), scope: network });
    // Email limit (3 per day per email scope), exhausted by real submits.
    const emailScope = hex();
    for (let n = 25; n < 28; n += 1) await file(c, { target: key(n), email: ownEmail(n), emailScope });
    await silent('email limit', { target: key(28), email: ownEmail(28), emailScope });
    // Organization limit (3 per day per organization), exhausted as the owner.
    const limited = await organization(c);
    await c.query(
      "insert into private.public_interest_submission_limits(scope_hash,operation,window_started_at,request_count) values (encode(extensions.digest('organization-claim-org:' || $1::text, 'sha256'), 'hex'),'claim-org-day',now(),3)",
      [limited.org],
    );
    await silent('organization limit', { admin: limited, target: key(28), email: ownEmail(28) });
    // The 21st open claim on one target.
    await c.query(
      `insert into private.organization_claims
         (catalog_key, claimant_name, claimant_title, claimant_email, claimant_email_scope,
          locale, attestation_version, attested_at, confirm_token_hash, confirm_expires_at)
       select $1, 'Alex Fixtureperson', 'Steward', 'officer' || i || '@examplelocal29.example',
              encode(extensions.digest('scope-' || i || '-' || $2, 'sha256'), 'hex'), 'en', 'claim-attest/1', now(),
              encode(extensions.digest('token-' || i || '-' || $2, 'sha256'), 'hex'), now() + interval '24 hours'
         from generate_series(1, 20) as i`,
      [key(29), randomUUID()],
    );
    await silent('21st open claim', { target: key(29), email: ownEmail(29) });
    // A duplicate open claim for the same email scope and target.
    const duplicateScope = hex();
    await file(c, { target: key(30), email: ownEmail(30), emailScope: duplicateScope });
    await silent('duplicate open claim', { target: key(30), email: ownEmail(30), emailScope: duplicateScope });
    // A second open claim for the same organization.
    const busy = await file(c, { target: key(31), email: ownEmail(31) });
    await silent('second open claim for the organization', { admin: busy.admin, target: key(32), email: ownEmail(32) });
    // An organization that is already verified.
    const verified = await verifiedOrganization(c, 33);
    await silent('already verified organization', { admin: verified, target: key(34), email: ownEmail(34) });
    // A suppressed email address.
    const suppressed = 'suppressed@examplelocal35.example';
    await c.query("insert into private.public_interest_suppressions(suppression_scope_hash,source,locale) values (private.public_interest_suppression_scope($1),'public-landing','en')", [suppressed]);
    await silent('suppressed email', { target: key(35), email: suppressed });

    // A valid submit.
    const admin = await organization(c);
    const before = await counts(c);
    const { id, emailScope: scope } = await file(c, { admin, target: key(36), email: ownEmail(36) });
    const after = await counts(c);
    expect(after).toEqual({ ...before, claims: before.claims + 1, events: before.events + 1, ledger: before.ledger + 1 });
    expect(await claimRow(c, id)).toMatchObject({
      catalog_key: key(36), status: 'awaiting_email', claimant_email: ownEmail(36), claimant_email_scope: scope, attestation_version: 'claim-attest/1',
      organization_id: admin.org, claimant_user_id: admin.user, email_confirmed_at: null, hold_reason: null, auto_approved: false, statement: null,
      verifier_kind: null, vouching_organization_id: null,
    });
    expect((await c.query("select confirm_expires_at - created_at = interval '24 hours' as ok from private.organization_claims where id=$1", [id])).rows[0].ok).toBe(true);
    expect((await c.query('select event_type, actor_kind, actor_user_id, subject_kind, organization_id, metadata from private.catalog_review_events where claim_id=$1', [id])).rows).toEqual([
      { event_type: 'claim_submitted', actor_kind: 'organization_admin', actor_user_id: admin.user, subject_kind: 'claim', organization_id: admin.org, metadata: { catalogKey: key(36), toStatus: 'awaiting_email' } },
    ]);
    expect(await ledgerRows(c, admin.org, 'organization_catalog_verification_requested')).toEqual([{
      action: 'create', actor_user_id: admin.user, entity_type: 'organization', entity_id: admin.org,
      metadata: { organizationId: admin.org, entityType: 'catalog_organization', entityId: key(36), toStatus: 'awaiting_email' },
    }]);
  });
}, 120_000);

live('4. submit bounds raise 22023', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const admin = await organization(c);
    const before = await counts(c);
    const bad = (options, message) => expectRefusal(submit(c, { admin, target: K1, ...options }), '22023', message);
    await bad({ attestation: { ...ATTEST, notEmployer: false } }, 'attestation required');
    await bad({ attestation: { ...ATTEST, version: 'claim-attest/2' } }, 'attestation required');
    await bad({ locale: 'fr' }, 'invalid locale');
    await bad({ token: 'abc123' }, 'invalid confirmation token');
    await bad({ token: hex().toUpperCase() }, 'invalid confirmation token');
    await bad({ unlisted: { name: 'Example Unlisted Workers Guild' } }, 'claim target invalid');
    await bad({ target: null }, 'claim target invalid');
    await bad({ who: claimant(ownEmail(1), { name: `Alex ${'Fixtureperson'.repeat(10)}` }) }, 'claimant invalid');
    await bad({ target: null, unlisted: { name: `Example ${'Unlisted Guild '.repeat(15)}` } }, 'claim target invalid');
    // The unlisted name reaches a vouching organization, so no contact data (review C8).
    await bad({ target: null, unlisted: { name: 'Example Unit fp@mail.unit.example' } }, 'claim target invalid');
    await bad({ target: null, unlisted: { name: 'Example Unit 555-0144' } }, 'claim target invalid');
    await bad({ target: null, unlisted: { name: 'Example Unit https://unit.example' } }, 'claim target invalid');
    await bad({ target: null, unlisted: { name: '...' } }, 'claim target invalid');
    await bad({ target: null, unlisted: { name: 'Example Unit', city: 'Call 555 0145' } }, 'claim target invalid');
    await bad({ user: null }, 'claim requester invalid');
    await bad({ org: null }, 'claim requester invalid');
    expect(await counts(c)).toEqual(before);
  });
}, 120_000);

live('5. submit by a non-admin member, an admin of another organization or an admin of a suspended organization raises 42501', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const admin = await organization(c);
    const plain = await member(c, admin);
    const other = await organization(c, { name: 'Example Council 9' });
    const suspended = await organization(c, { name: 'Example Workers Local 20' });
    await c.query("update public.organizations set status='suspended' where id=$1", [suspended.org]);
    const before = await counts(c);
    await expectRefusal(submit(c, { target: K1, user: plain.user, org: admin.org }), '42501', 'not authorized');
    await expectRefusal(submit(c, { target: K1, user: other.user, org: admin.org }), '42501', 'not authorized');
    await expectRefusal(submit(c, { admin: suspended, target: key(20), email: ownEmail(20) }), '42501', 'not authorized');
    expect(await counts(c)).toEqual(before);
  });
}, 120_000);

live('6. confirm with an unknown, reused or 25-hour-old token answers accepted and changes nothing', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const quiet = (result) => {
      expect(result.accepted).toBe(true);
      expect(result.next ?? null).toBeNull();
      expect(result.claimId).toBeUndefined();
      expect(result.email).toBeUndefined();
    };
    let before = await counts(c);
    quiet(await confirm(c, hex()));
    expect(await counts(c)).toEqual(before);

    const reused = await fileAndConfirm(c, { target: key(20), email: CONSUMER_EMAIL });
    expect(reused.row.status).toBe('under_review');
    before = await counts(c);
    quiet(await confirm(c, reused.token));
    expect(await claimRow(c, reused.id)).toEqual(reused.row);
    expect(await counts(c)).toEqual(before);

    const stale = await file(c, { target: key(21), email: ownEmail(21) });
    await c.query("update private.organization_claims set created_at=now()-interval '25 hours', attested_at=now()-interval '25 hours', confirm_expires_at=now()-interval '1 hour' where id=$1", [stale.id]);
    const staleRow = await claimRow(c, stale.id);
    before = await counts(c);
    quiet(await confirm(c, stale.token));
    expect(await claimRow(c, stale.id)).toEqual(staleRow);
    expect(staleRow).toMatchObject({ status: 'awaiting_email', confirm_token_hash: stale.token, email_confirmed_at: null });
    expect(await counts(c)).toEqual(before);

    // Start again follows the authorized read: the still-retained expired
    // row must not hide the replacement form before the daily sweep runs.
    await as(c, stale.admin);
    expect((await getVerification(c, stale.admin.org)).openClaim).toBeNull();
    await owner(c);

    // A claim past its deadline blocks nothing, even before the daily sweep:
    // the same admin files again for the same listing from the same mailbox (round 3, C11).
    const again = await submit(c, { admin: stale.admin, target: key(21), email: ownEmail(21), emailScope: stale.emailScope });
    expect(again.result).toEqual({ accepted: true, deliver: true });
    expect(await claimRow(c, stale.id)).toMatchObject({ status: 'expired', confirm_token_hash: null, personal_data_purged_at: null });
    expect((await claimRow(c, stale.id)).closed_at).not.toBeNull();
    expect(await eventTypes(c, stale.id)).toEqual(['claim_expired', 'claim_submitted']);
    expect((await c.query("select metadata from private.catalog_review_events where claim_id=$1 and event_type='claim_expired'", [stale.id])).rows[0].metadata)
      .toEqual({ catalogKey: key(21), fromStatus: 'awaiting_email', toStatus: 'expired' });
    expect((await c.query("select status from private.organization_claims where confirm_token_hash=$1", [again.token])).rows).toEqual([{ status: 'awaiting_email' }]);
    await as(c, stale.admin);
    expect((await getVerification(c, stale.admin.org)).openClaim).toEqual({ state: 'awaiting_email', catalogKey: key(21) });
  });
}, 120_000);

live('7. domain rung: a unique own-domain claim approves automatically and sets verified_at, leaving the self-reported parent byte-identical', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const admin = await organization(c);
    // Two stewards and one plain member beside the admin.
    await member(c, admin, { role: 'steward' });
    await member(c, admin, { role: 'steward' });
    await member(c, admin);
    await selfReport(c, admin, { parent: K9 });
    const before = await placementRow(c, admin.org);
    expect(before).toMatchObject({ parent_catalog_key: K9, verification_status: 'self_reported', verified_at: null, identity_catalog_key: null });
    const filed = await file(c, { admin, target: K1, email: ownEmail(1) });
    const confirmed = await confirm(c, filed.token);
    expect(confirmed).toEqual({ accepted: true, next: 'notify_approved', claimId: filed.id, email: ownEmail(1), locale: 'en' });
    const claim = await claimRow(c, filed.id);
    expect(claim).toMatchObject({
      status: 'approved', auto_approved: true, verification_method: 'official_domain_email', verifier_kind: 'domain',
      reviewed_by: null, hold_reason: null, organization_id: admin.org, vouching_organization_id: null,
    });
    expect(claim.reviewed_at).not.toBeNull();
    expect(claim.closed_at).not.toBeNull();
    expect(claim.signals).toEqual({
      domainMatch: true, domainReason: null, electionWindow: false, targetVerifiedElsewhere: false, officePhoneAvailable: true,
      competingClaims: 0, stewardCount: 2, memberCount: 4,
    });
    const after = await placementRow(c, admin.org);
    expect(after).toMatchObject({ verification_status: 'verified', identity_catalog_key: K1, verified_claim_id: filed.id });
    expect(after.verified_at).not.toBeNull();
    for (const column of ['parent_catalog_key', 'unlisted_parent_name', 'unlisted_parent_state', 'identity_unlisted', 'placed_at']) {
      expect(after[column], column).toEqual(before[column]);
    }
    expect(await eventTypes(c, filed.id)).toEqual(['claim_auto_approved', 'claim_confirmed', 'claim_submitted', 'placement_verified']);
    expect((await c.query("select actor_kind, actor_user_id, subject_kind, organization_id from private.catalog_review_events where claim_id=$1 and event_type='placement_verified'", [filed.id])).rows)
      .toEqual([{ actor_kind: 'system', actor_user_id: null, subject_kind: 'placement', organization_id: admin.org }]);
    expect(await ledgerRows(c, admin.org, 'organization_catalog_placement_verified')).toEqual([{
      action: 'update', actor_user_id: null, entity_type: 'organization', entity_id: admin.org,
      metadata: { organizationId: admin.org, entityType: 'catalog_organization', entityId: K1, fromStatus: 'self_reported', toStatus: 'verified', reasonCode: 'domain' },
    }]);
    // The rung is recorded on the placement event too (review C9).
    expect((await c.query("select metadata from private.catalog_review_events where claim_id=$1 and event_type='placement_verified'", [filed.id])).rows[0].metadata)
      .toMatchObject({ verifierKind: 'domain' });
    // Only 4a's own set wrote a placement-changed row.
    expect(await ledgerRows(c, admin.org, 'organization_catalog_placement_changed')).toHaveLength(1);
  });
}, 120_000);

live('8. domain negatives land in under_review with domainMatch false and the expected domainReason', async () => {
  await withClient(async (c) => {
    await catalog(c);
    expect(HOSTING_DOMAIN, 'a two-label hosting domain in the config').toBeTruthy();
    const cases = [
      ['consumer domain', { target: key(20), email: CONSUMER_EMAIL }, 'blocked_domain'],
      ['hosting subdomain', { target: key(21), email: `officer@examplelocal21.${HOSTING_DOMAIN}` }, 'blocked_domain'],
      ['family national domain', { target: key(22), email: `officer@${FAMILY_DOMAIN}` }, 'blocked_domain'],
      ['shared-domain pair', { target: SHARED_A, email: 'officer@sharedlocals.example' }, 'domain_shared'],
      ['another listing\'s contact email', { target: CONTACT_TARGET, email: 'officer@examplelocal13.example' }, 'domain_shared'],
      ['lookalike', { target: K1, email: 'officer@examp1elocal1.example' }, 'domain_mismatch'],
      ['stale researched_on', { target: STALE, email: 'officer@examplelocal15.example' }, 'target_stale'],
      ['secondary confidence', { target: SECONDARY, email: 'officer@examplelocal16.example' }, 'target_stale'],
      ['unlisted target', { unlisted: { name: 'Example Unlisted Workers Guild', city: 'Exampleton', state: 'OR' }, email: 'officer@exampleguild.example' }, 'unlisted'],
      ['subdomain site, mail on the wider domain', { target: key(18), email: 'officer@examplecity.example' }, 'subdomain_site'],
      ['subdomain site, mail on another host', { target: key(10), email: 'officer@other.exampledistrict.example' }, 'subdomain_site'],
      // A host that only ends with the site host, with no dot boundary (review C18).
      ['subdomain site, mail on a host that only ends with the site host', { target: key(4), email: 'officer@xlocal4.exampleschools.example' }, 'subdomain_site'],
      // A domain that only ends with the listing's domain (review C22).
      ['suffix lookalike', { target: key(23), email: 'officer@notexamplelocal23.example' }, 'domain_mismatch'],
    ];
    for (const [label, options, reason] of cases) {
      const { confirmed, row, id } = await fileAndConfirm(c, options);
      expect(confirmed.next, label).toBeNull();
      expect(row, label).toMatchObject({ status: 'under_review', hold_reason: null, auto_approved: false, verifier_kind: null });
      expect(row.signals, label).toMatchObject({ domainMatch: false, domainReason: reason });
      expect(await eventTypes(c, id), label).toEqual(['claim_confirmed', 'claim_submitted']);
    }
    // Mail on the subdomain site's own host still approves when unique.
    const own = await fileAndConfirm(c, { target: key(19), email: 'officer@local19.examplecounty.example' });
    expect(own.row).toMatchObject({ status: 'approved', auto_approved: true, verifier_kind: 'domain' });
    expect(own.row.signals).toMatchObject({ domainMatch: true, domainReason: null });
  });
}, 120_000);

live('9. a claim in the election window is held for election_period and never approved', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const { confirmed, row, id, admin } = await fileAndConfirm(c, { target: ELECTION, email: 'officer@examplelocal17.example' });
    expect(confirmed.next).toBeNull();
    expect(row).toMatchObject({ status: 'held', hold_reason: 'election_period', auto_approved: false, verification_method: null, verifier_kind: null });
    expect(row.signals).toMatchObject({ domainMatch: true, electionWindow: true });
    expect(await eventTypes(c, id)).toEqual(['claim_confirmed', 'claim_held', 'claim_submitted']);
    expect(await placementRow(c, admin.org)).toBeNull();
  });
}, 120_000);

live('10. contest: a second confirmed claim holds both, a verified placement is untouched, and a contested approval needs written authorization', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const operator = await verifier(c);
    const first = await fileAndConfirm(c, { target: key(40), email: CONSUMER_EMAIL });
    expect(first.row.status).toBe('under_review');
    const second = await fileAndConfirm(c, { target: key(40), email: ownEmail(40) });
    expect(second.row).toMatchObject({ status: 'held', hold_reason: 'contested', auto_approved: false });
    expect(await claimRow(c, first.id)).toMatchObject({ status: 'held', hold_reason: 'contested' });
    expect((await c.query("select actor_kind, metadata from private.catalog_review_events where claim_id=$1 and event_type='claim_held'", [first.id])).rows)
      .toEqual([{ actor_kind: 'system', metadata: { catalogKey: key(40), fromStatus: 'under_review', toStatus: 'held', holdReason: 'contested' } }]);

    // An existing verified placement is never touched by a later claim.
    const holder = await verifiedOrganization(c, 41);
    const placement = await placementRow(c, holder.org);
    const late = await fileAndConfirm(c, { target: key(41), email: ownEmail(41) });
    expect(late.row).toMatchObject({ status: 'held', hold_reason: 'contested' });
    expect(late.row.signals.targetVerifiedElsewhere).toBe(true);
    expect(await placementRow(c, holder.org)).toEqual(placement);
    expect(await claimRow(c, holder.claimId)).toMatchObject({ status: 'approved' });

    await expectRefusal(review(c, second.id, operator, 'approve', { method: 'published_office_callback' }), '22023', 'contested claim needs written authorization');
    expect(await review(c, second.id, operator, 'approve', { method: 'written_authorization' }))
      .toMatchObject({ claimId: second.id, status: 'approved', holdReason: null, next: 'notify_approved', idempotent: false });
    expect(await claimRow(c, second.id)).toMatchObject({ status: 'approved', verification_method: 'written_authorization', verifier_kind: 'platform_operator', reviewed_by: operator, auto_approved: false });
    expect(await placementRow(c, second.admin.org)).toMatchObject({ verification_status: 'verified', identity_catalog_key: key(40) });
    expect(await claimRow(c, first.id)).toMatchObject({ status: 'held', hold_reason: 'contested' });
  });
}, 120_000);

live('11. review refuses a null, unknown, revoked or capability-less operator and an authenticated caller with 42501', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const { id, row, admin } = await fileAndConfirm(c, { target: key(42), email: CONSUMER_EMAIL });
    const refused = (operator) => expectRefusal(review(c, id, operator, 'hold', { hold: 'awaiting_callback' }), '42501', 'claim verifier required');
    await refused(null);
    await refused(randomUUID());
    // An Auth user with no operator row.
    const plain = randomUUID();
    await c.query('insert into auth.users(id,email) values ($1,$2)', [plain, 'plain.fixtureperson@fixture-verifier.example']);
    await refused(plain);
    // A revoked operator.
    const revoked = await verifier(c, SECOND_VERIFIER);
    await svc(c, 'public.set_platform_operator($1,$2,$3,$4)', [revoked, false, null, randomUUID()]);
    expect((await c.query('select revoked_at is not null as revoked from private.platform_operators where user_id=$1', [revoked])).rows[0].revoked).toBe(true);
    await refused(revoked);
    // A capability-less row cannot exist today; under a widened capability
    // list (as Phase 6 will add) an operator without claim_verification is refused.
    const bare = randomUUID();
    await c.query('insert into auth.users(id,email) values ($1,$2)', [bare, 'bare.fixtureperson@fixture-verifier.example']);
    await c.query('savepoint capability');
    await expectRefusal(c.query("insert into private.platform_operators(user_id,capabilities,granted_note) values ($1,'{}','Fixture verifier')", [bare]), '23514');
    await c.query('rollback to savepoint capability');
    // #9819: widen the constraint the database holds now, never a copied
    // list. A copy went stale when 20261118160000 added intake_review, and
    // re-adding it failed whenever another proof on the same database had
    // committed an intake_review operator.
    const { rows: [held] } = await c.query("select pg_catalog.pg_get_constraintdef(oid) as def from pg_catalog.pg_constraint where conrelid = 'private.platform_operators'::regclass and conname = 'platform_operators_capabilities_check'");
    expect(held, 'platform_operators_capabilities_check exists before the widening probe').toBeDefined();
    // Every single-quoted literal of the definition, whatever follows it, so a
    // capability the pattern does not expect fails here instead of being
    // dropped from the re-added constraint.
    const capabilities = [...held.def.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1]);
    expect(capabilities.length, `capability literals in ${held.def}`).toBeGreaterThan(0);
    for (const capability of capabilities) expect(capability, `capability literal in ${held.def}`).toMatch(/^[A-Za-z0-9_]+$/);
    expect(capabilities).toContain('claim_verification');
    const widened = [...new Set([...capabilities, 'catalog_curation'])].map((capability) => `'${capability}'`).join(',');
    await c.query('alter table private.platform_operators drop constraint platform_operators_capabilities_check');
    await c.query(`alter table private.platform_operators add constraint platform_operators_capabilities_check check (cardinality(capabilities) >= 1 and capabilities <@ array[${widened}]::text[])`);
    await c.query("insert into private.platform_operators(user_id,capabilities,granted_note) values ($1,'{catalog_curation}','Fixture verifier')", [bare]);
    await refused(bare);
    // A banned or deleted operator account never acts (round 3, item 2).
    const banned = await verifier(c, '50900500-0000-4000-8000-000000000004');
    await c.query("update auth.users set banned_until = now() + interval '1 day' where id=$1", [banned]);
    await refused(banned);
    await c.query("update auth.users set banned_until = null, deleted_at = now() where id=$1", [banned]);
    await refused(banned);
    // An authenticated caller cannot execute the verifier RPC at all.
    await as(c, admin);
    await expectRefusal(rpc(c, 'public.review_organization_claim($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, VERIFIER, 'hold', null, 'awaiting_callback', null, null, null, randomUUID()]), '42501');
    await owner(c);
    expect(await claimRow(c, id)).toEqual(row);
  });
}, 120_000);

live('12. review transitions: allowed moves succeed, disallowed raise 22023, replays write nothing, approvals write only 3a columns', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const operator = await verifier(c);
    const moving = await fileAndConfirm(c, { target: key(43), email: CONSUMER_EMAIL });
    expect(await review(c, moving.id, operator, 'hold', { hold: 'awaiting_callback' })).toMatchObject({ status: 'held', holdReason: 'awaiting_callback', idempotent: false });
    expect(await review(c, moving.id, operator, 'hold', { hold: 'election_period' })).toMatchObject({ status: 'held', holdReason: 'election_period' });
    expect(await review(c, moving.id, operator, 'release')).toMatchObject({ status: 'under_review', holdReason: null });
    await expectRefusal(review(c, moving.id, operator, 'release'), '22023', 'claim state');
    await expectRefusal(review(c, moving.id, operator, 'hold', { hold: 'on_vacation' }), '22023', 'hold reason invalid');
    await expectRefusal(review(c, moving.id, operator, 'reject', { reason: 'no_reason' }), '22023', 'reason code invalid');
    await expectRefusal(review(c, moving.id, operator, 'approve', { method: 'phone_call' }), '22023', 'verification method invalid');
    await expectRefusal(review(c, moving.id, operator, 'approve', { method: 'sibling_handshake' }), '22023', 'verification method invalid');
    await expectRefusal(review(c, moving.id, operator, 'approve', { method: 'official_domain_email' }), '22023', 'domain not verified');
    await expectRefusal(review(c, moving.id, operator, 'escalate'), '22023', 'decision invalid');
    await review(c, moving.id, operator, 'hold', { hold: 'awaiting_callback' });
    expect(await placementRow(c, moving.admin.org)).toBeNull();
    const approveIdem = randomUUID();
    const approved = await review(c, moving.id, operator, 'approve', { method: 'published_office_callback', note: 'Fixture callback to 555-0100', idem: approveIdem });
    expect(approved).toEqual({ claimId: moving.id, status: 'approved', holdReason: null, next: 'notify_approved', email: CONSUMER_EMAIL, locale: 'en', idempotent: false });
    expect(await claimRow(c, moving.id)).toMatchObject({
      status: 'approved', verification_method: 'published_office_callback', verifier_kind: 'platform_operator', auto_approved: false,
      reviewed_by: operator, review_note: 'Fixture callback to 555-0100', vouching_organization_id: null,
    });
    // An organization with no placement row gets an identity-only row.
    const inserted = await placementRow(c, moving.admin.org);
    expect(inserted).toMatchObject({
      verification_status: 'verified', identity_catalog_key: key(43), verified_claim_id: moving.id, identity_unlisted: false,
      parent_catalog_key: null, unlisted_parent_name: null, unlisted_parent_state: null,
    });
    expect(inserted.verified_at).not.toBeNull();
    expect((await c.query("select actor_kind, actor_user_id from private.catalog_review_events where claim_id=$1 and event_type='placement_verified'", [moving.id])).rows)
      .toEqual([{ actor_kind: 'verifier', actor_user_id: operator }]);
    expect((await ledgerRows(c, moving.admin.org, 'organization_catalog_placement_verified')).map((row) => row.actor_user_id)).toEqual([null]);
    // An idempotent replay returns the first result and writes no event.
    const before = await counts(c);
    expect(await review(c, moving.id, operator, 'approve', { method: 'written_authorization', idem: approveIdem })).toEqual({ ...approved, idempotent: true });
    expect(await counts(c)).toEqual(before);
    expect((await c.query('select count(*)::int n from private.catalog_review_events where idempotency_key=$1', [approveIdem])).rows[0].n).toBe(1);
    // Terminal states refuse every decision.
    for (const [decision, options] of [['approve', { method: 'written_authorization' }], ['reject', { reason: 'not_verified' }], ['hold', { hold: 'contested' }], ['release', {}]]) {
      await expectRefusal(review(c, moving.id, operator, decision, options), '22023', 'claim state');
    }
    const rejected = await fileAndConfirm(c, { target: key(44), email: CONSUMER_EMAIL });
    expect(await review(c, rejected.id, operator, 'reject', { reason: 'not_verified' })).toMatchObject({ status: 'rejected', next: null });
    expect(await claimRow(c, rejected.id)).toMatchObject({ status: 'rejected', reason_code: 'not_verified', reviewed_by: operator, verifier_kind: null });
    await expectRefusal(review(c, rejected.id, operator, 'approve', { method: 'written_authorization' }), '22023', 'claim state');
    const heldThenRejected = await fileAndConfirm(c, { target: key(45), email: CONSUMER_EMAIL });
    await review(c, heldThenRejected.id, operator, 'hold', { hold: 'awaiting_callback' });
    expect(await review(c, heldThenRejected.id, operator, 'reject', { reason: 'claimant_withdrew' })).toMatchObject({ status: 'rejected', holdReason: null });
    // An unconfirmed claim cannot be decided.
    const unconfirmed = await file(c, { target: key(46), email: CONSUMER_EMAIL });
    for (const [decision, options] of [['approve', { method: 'written_authorization' }], ['reject', { reason: 'not_verified' }], ['hold', { hold: 'contested' }], ['release', {}]]) {
      await expectRefusal(review(c, unconfirmed.id, operator, decision, options), '22023', 'claim state');
    }
    // An approved unlisted claim sets identity_unlisted and verified_at.
    const unlisted = await fileAndConfirm(c, { unlisted: { name: 'Example Unlisted Council', state: 'OR' }, email: CONSUMER_EMAIL });
    expect(unlisted.row).toMatchObject({ status: 'under_review', catalog_key: null });
    await review(c, unlisted.id, operator, 'approve', { method: 'written_authorization' });
    const unlistedRow = await placementRow(c, unlisted.admin.org);
    expect(unlistedRow).toMatchObject({ verification_status: 'verified', identity_unlisted: true, identity_catalog_key: null, verified_claim_id: unlisted.id, parent_catalog_key: null });
    expect(unlistedRow.verified_at).not.toBeNull();

    // An organization that is no longer active cannot be approved.
    const inactive = await fileAndConfirm(c, { target: key(38), email: CONSUMER_EMAIL });
    await c.query("update public.organizations set status='suspended' where id=$1", [inactive.admin.org]);
    await expectRefusal(review(c, inactive.id, operator, 'approve', { method: 'written_authorization' }), '22023', 'claim unavailable');
    expect(await claimRow(c, inactive.id)).toMatchObject({ status: 'under_review' });
    // A claim on the listing the organization self-reports as its own parent:
    // no automatic approval, and no manual one either.
    const selfParent = await organization(c, { name: 'Example Workers Local 39 Unit' });
    await selfReport(c, selfParent, { parent: key(39) });
    const loop = await fileAndConfirm(c, { admin: selfParent, target: key(39), email: ownEmail(39) });
    expect(loop.row).toMatchObject({ status: 'under_review', auto_approved: false });
    expect(loop.row.signals.domainMatch).toBe(true);
    await expectRefusal(review(c, loop.id, operator, 'approve', { method: 'written_authorization' }), '22023', 'placement parent is the claimed listing');
    expect(await claimRow(c, loop.id)).toMatchObject({ status: 'under_review', verifier_kind: null });
    expect(await placementRow(c, selfParent.org)).toMatchObject({ parent_catalog_key: key(39), verification_status: 'self_reported', verified_at: null });
    // A key that belongs to another function's event is not a review replay.
    const issueIdem = randomUUID();
    await issueMailback(c, loop.id, operator, 'K7M2P9Q4RX', issueIdem);
    await expectRefusal(review(c, loop.id, operator, 'release', { idem: issueIdem }), '22023', 'idempotency key reused');
    const revokeIdem = randomUUID();
    await revokeClaim(c, moving.id, operator, { idem: revokeIdem });
    await expectRefusal(review(c, moving.id, operator, 'approve', { method: 'written_authorization', idem: revokeIdem }), '22023', 'idempotency key reused');
    // A key is a replay only of the same decision (review C5).
    const holding = await fileAndConfirm(c, { target: key(47), email: CONSUMER_EMAIL });
    const holdIdem = randomUUID();
    await review(c, holding.id, operator, 'hold', { hold: 'awaiting_callback', idem: holdIdem });
    await expectRefusal(review(c, holding.id, operator, 'approve', { method: 'written_authorization', idem: holdIdem }), '22023', 'idempotency key reused');
    expect(await review(c, holding.id, operator, 'hold', { hold: 'awaiting_callback', idem: holdIdem })).toMatchObject({ status: 'held', idempotent: true });
    // ...and an operator revoke never replays a grant's key.
    const extra = '50900500-0000-4000-8000-000000000003';
    await c.query('insert into auth.users(id,email) values ($1,$2)', [extra, 'verifier.0003@fixture-verifier.example']);
    const grantIdem = randomUUID();
    await svc(c, 'public.set_platform_operator($1,$2,$3,$4)', [extra, true, 'Fixture verifier', grantIdem]);
    await expectRefusal(svc(c, 'public.set_platform_operator($1,$2,$3,$4)', [extra, false, null, grantIdem]), '22023', 'idempotency key reused');
    expect((await c.query('select revoked_at from private.platform_operators where user_id=$1', [extra])).rows[0].revoked_at).toBeNull();
    expect(await svc(c, 'public.set_platform_operator($1,$2,$3,$4)', [extra, false, null, randomUUID()])).toMatchObject({ active: false, idempotent: false });
    // A listing the catalog retired or merged cannot be approved (review C6).
    const merged = await fileAndConfirm(c, { target: key(48), email: CONSUMER_EMAIL });
    const retiredLater = await fileAndConfirm(c, { target: key(49), email: CONSUMER_EMAIL });
    await c.query('update private.catalog_organizations set duplicate_of=$2 where catalog_key=$1', [key(48), K1]);
    await c.query('update private.catalog_organizations set retired_release_id=$2 where catalog_key=$1', [key(49), randomUUID()]);
    for (const claim of [merged, retiredLater]) {
      await expectRefusal(review(c, claim.id, operator, 'approve', { method: 'written_authorization' }), '22023', 'claim unavailable');
      expect(await claimRow(c, claim.id)).toMatchObject({ status: 'under_review', verifier_kind: null });
      expect(await placementRow(c, claim.admin.org)).toBeNull();
    }
    expect(await review(c, merged.id, operator, 'reject', { reason: 'not_verified' })).toMatchObject({ status: 'rejected' });
  });
}, 120_000);

live('13. mail-back: only an HMAC is stored, wrong codes count and commit, the fifth voids, the right code approves, and an expired code is refused', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const operator = await verifier(c);
    const code = 'K7M2P9Q4RX';
    const wrong = 'ZZZZZZZZZZ';
    const counted = await fileAndConfirm(c, { target: key(48), email: CONSUMER_EMAIL });
    await expectRefusal(issueMailback(c, counted.id, operator, 'k7m2p9q4rx'), '22023', 'mail-back code invalid');
    expect(await issueMailback(c, counted.id, operator, code)).toMatchObject({ status: 'held', holdReason: 'awaiting_mailback' });
    const issued = await claimRow(c, counted.id);
    expect(issued.mailback_code_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.mailback_code_hmac.toUpperCase()).not.toContain(code);
    expect(issued.mailback_attempts).toBe(0);
    expect((await c.query("select mailback_expires_at - mailback_issued_at = interval '45 days' as ok from private.organization_claims where id=$1", [counted.id])).rows[0].ok).toBe(true);
    await expectRefusal(issueMailback(c, counted.id, operator, code), '22023', 'mail-back code recently issued');
    await expectRefusal(review(c, counted.id, operator, 'approve', { method: 'olms_address_mailback', code: 'bad' }), '22023', 'mail-back code invalid');
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const answer = await review(c, counted.id, operator, 'approve', { method: 'olms_address_mailback', code: wrong });
      expect(answer).toMatchObject({ claimId: counted.id, approved: false, reason: 'mailback_mismatch', attemptsLeft: 5 - attempt });
      // The increment survives the call (a raise would have rolled it back).
      const row = await claimRow(c, counted.id);
      expect(row).toMatchObject({ mailback_attempts: attempt, status: 'held', hold_reason: 'awaiting_mailback' });
      expect(row.mailback_code_hmac === null).toBe(attempt === 5);
    }
    expect((await c.query("select count(*)::int n from private.catalog_review_events where claim_id=$1 and event_type='claim_mailback_failed'", [counted.id])).rows[0].n).toBe(5);
    await expectRefusal(review(c, counted.id, operator, 'approve', { method: 'olms_address_mailback', code }), '22023', 'mail-back code unavailable');

    const right = await fileAndConfirm(c, { target: key(49), email: CONSUMER_EMAIL });
    await issueMailback(c, right.id, operator, code);
    expect(await review(c, right.id, operator, 'approve', { method: 'olms_address_mailback', code })).toMatchObject({ status: 'approved', next: 'notify_approved' });
    expect(await claimRow(c, right.id)).toMatchObject({ status: 'approved', verification_method: 'olms_address_mailback', verifier_kind: 'platform_operator', reviewed_by: operator, mailback_attempts: 0 });

    const expired = await fileAndConfirm(c, { target: key(50), email: CONSUMER_EMAIL });
    await issueMailback(c, expired.id, operator, code);
    await c.query("update private.organization_claims set mailback_issued_at=now()-interval '46 days', mailback_expires_at=now()-interval '1 day' where id=$1", [expired.id]);
    await expectRefusal(review(c, expired.id, operator, 'approve', { method: 'olms_address_mailback', code }), '22023', 'mail-back code unavailable');
    expect(await claimRow(c, expired.id)).toMatchObject({ status: 'held', hold_reason: 'awaiting_mailback' });
  });
}, 120_000);

live('14. one checkmark per entry: a second organization cannot take a verified key, and a self-reported parent never blocks a claim', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const operator = await verifier(c);
    await verifiedOrganization(c, 51);
    const rival = await fileAndConfirm(c, { target: key(51), email: ownEmail(51), orgName: 'Example Council 9' });
    expect(rival.row).toMatchObject({ status: 'held', hold_reason: 'contested' });
    await expectRefusal(review(c, rival.id, operator, 'approve', { method: 'written_authorization' }), '23505', 'catalog identity already verified');
    expect(await placementRow(c, rival.admin.org)).toBeNull();
    expect(await claimRow(c, rival.id)).toMatchObject({ status: 'held', hold_reason: 'contested' });
    await c.query('savepoint checkmark');
    const error = await expectRefusal(c.query("insert into private.organization_catalog_placements(organization_id,identity_catalog_key,verification_status,verified_claim_id,verified_at) values ($1,$2,'verified',$3,now())", [rival.admin.org, key(51), rival.id]), '23505');
    expect(error.constraint).toBe('organization_catalog_placements_identity_catalog_key_idx');
    await c.query('rollback to savepoint checkmark');

    // A 4a self-reported parent on a key is not an identity.
    const retirees = await organization(c, { name: 'Example Workers Local 52 Retirees' });
    await selfReport(c, retirees, { parent: key(52) });
    const claim = await fileAndConfirm(c, { target: key(52), email: ownEmail(52) });
    expect(claim.confirmed.next).toBe('notify_approved');
    expect(claim.row).toMatchObject({ status: 'approved', auto_approved: true, verifier_kind: 'domain' });
    expect(claim.row.signals).toMatchObject({ targetVerifiedElsewhere: false, domainMatch: true });
  });
}, 120_000);

live('15. placement CHECKs hold for direct owner writes', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const admin = await organization(c);
    const { id: claim } = await file(c, { target: K1, email: ownEmail(1) });
    const violates = async (label, columns, values, params, constraint) => {
      await c.query('savepoint shape');
      const error = await c.query(`insert into private.organization_catalog_placements(organization_id,${columns}) values ($1,${values})`, [admin.org, ...params])
        .then(() => null, (e) => e);
      await c.query('rollback to savepoint shape');
      expect(error?.code, label).toBe('23514');
      expect(error.constraint, label).toBe(constraint);
    };
    const shape = 'organization_catalog_placements_verified_shape';
    await violates('verified without verified_at', 'identity_catalog_key,verification_status,verified_claim_id', "$2,'verified',$3", [K1, claim], shape);
    await violates('verified without verified_claim_id', 'identity_catalog_key,verification_status,verified_at', "$2,'verified',now()", [K1], shape);
    await violates('verified_at on a self_reported row', 'identity_unlisted,verification_status,verified_at', "true,'self_reported',now()", [], shape);
    await violates('verified_at and a claim on a self_reported row', 'identity_unlisted,verification_status,verified_claim_id,verified_at', "true,'self_reported',$2,now()", [claim], shape);
    await violates('verified_claim_id without verified_at', 'identity_unlisted,verification_status,verified_claim_id', "true,'self_reported',$2", [claim], shape);
    await violates('catalog identity on a self_reported row', 'identity_catalog_key,verification_status', "$2,'self_reported'", [K1], 'organization_catalog_placements_identity_verified');
    await violates('identity_unlisted with a catalog identity', 'identity_catalog_key,identity_unlisted,verification_status,verified_claim_id,verified_at', "$2,true,'verified',$3,now()", [K1, claim], 'organization_catalog_placements_identity_one');
    await violates('parent equal to identity', 'parent_catalog_key,identity_catalog_key,verification_status,verified_claim_id,verified_at', "$2,$2,'verified',$3,now()", [K1, claim], 'organization_catalog_placements_parent_not_self');
    await violates('pending status', 'identity_unlisted,verification_status', "true,'pending'", [], 'organization_catalog_placements_verification_status_check');
    await c.query("insert into private.organization_catalog_placements(organization_id,identity_catalog_key,verification_status,verified_claim_id,verified_at) values ($1,$2,'verified',$3,now())", [admin.org, K1, claim]);
    expect(await placementRow(c, admin.org)).toMatchObject({ identity_catalog_key: K1, verification_status: 'verified', parent_catalog_key: null, unlisted_parent_name: null, identity_unlisted: false });
  });
}, 120_000);

live('16. parent-union rung: a verified parent vouches for its child and for an unlisted organization that self-reports it as parent', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const parent = await verifiedOrganization(c, 9, { orgName: 'Example Council 9' });
    await edge(c, K1, K9, 'parent_body');
    const child = await fileAndConfirm(c, { target: K1, email: CONSUMER_EMAIL });
    expect(child.row.status).toBe('under_review');
    const unlistedAdmin = await organization(c, { name: 'Example Workers Unit' });
    await selfReport(c, unlistedAdmin, { parent: K9 });
    const unlisted = await fileAndConfirm(c, { admin: unlistedAdmin, unlisted: { name: 'Example Unlisted Workers Unit' }, email: CONSUMER_EMAIL });
    expect(unlisted.row.status).toBe('under_review');

    await as(c, parent);
    const listed = await listVouchable(c, parent.org);
    expect(listed.claims.map((item) => `${item.claimId}|${item.relationship}`).sort()).toEqual(sorted([`${child.id}|parent`, `${unlisted.id}|parent`]));
    for (const item of listed.claims) {
      expect(Object.keys(item).sort()).toEqual(['catalogKey', 'claimId', 'confirmedAt', 'organizationName', 'relationship', 'targetName', 'unlisted']);
    }
    expect(listed.claims.find((item) => item.claimId === child.id)).toMatchObject({ catalogKey: K1, targetName: 'Example Workers Local 1', unlisted: false });
    expect(listed.claims.find((item) => item.claimId === unlisted.id)).toMatchObject({ catalogKey: null, targetName: 'Example Unlisted Workers Unit', unlisted: true });

    // A banned admin of the parent, or the parent organization once suspended,
    // neither lists nor vouches (round 3, item 2).
    await owner(c);
    const bannedAdmin = await member(c, parent, { role: 'admin' });
    await c.query("update auth.users set banned_until = now() + interval '1 day' where id=$1", [bannedAdmin.user]);
    const beforeBanned = await counts(c);
    await as(c, bannedAdmin);
    await expectRefusal(listVouchable(c, parent.org), '42501', 'not authorized');
    await expectRefusal(vouch(c, parent.org, [child.id]), '42501', 'not authorized');
    await owner(c);
    await c.query("update public.organizations set status='suspended' where id=$1", [parent.org]);
    await as(c, parent);
    await expectRefusal(listVouchable(c, parent.org), '42501');
    await expectRefusal(vouch(c, parent.org, [child.id]), '42501');
    await owner(c);
    await c.query("update public.organizations set status='active' where id=$1", [parent.org]);
    expect(await counts(c)).toEqual(beforeBanned);
    // With staff MFA required by policy, an admin with no enrolled verified
    // factor is refused even at aal2 (round 3, item 3): the admin gate
    // (has_organization_role) refuses first, and the RPCs' own step-up
    // clause would refuse after it.
    await c.query('insert into public.org_security_policy(organization_id,require_staff_mfa,updated_by) values ($1,true,$2)', [parent.org, parent.user]);
    const noFactorPolicy = await member(c, parent, { role: 'admin', factor: false, aal: 'aal2' });
    await as(c, noFactorPolicy);
    await expectRefusal(listVouchable(c, parent.org), '42501', 'not authorized');
    await expectRefusal(vouch(c, parent.org, [child.id]), '42501', 'not authorized');
    await owner(c);
    expect(await counts(c)).toEqual(beforeBanned);
    await as(c, parent);

    const idem = randomUUID();
    const result = await vouch(c, parent.org, [unlisted.id, child.id], { idem });
    expect(result).toEqual({ approved: sorted([child.id, unlisted.id]), idempotent: false });
    await owner(c);
    for (const id of [child.id, unlisted.id]) {
      expect(await claimRow(c, id)).toMatchObject({
        status: 'approved', verification_method: 'parent_body_confirmation', verifier_kind: 'parent_organization',
        vouching_organization_id: parent.org, reviewed_by: parent.user, auto_approved: false, hold_reason: null,
      });
    }
    expect(await placementRow(c, child.admin.org)).toMatchObject({ verification_status: 'verified', identity_catalog_key: K1, verified_claim_id: child.id });
    expect(await placementRow(c, unlistedAdmin.org)).toMatchObject({ verification_status: 'verified', identity_unlisted: true, parent_catalog_key: K9, verified_claim_id: unlisted.id });
    const vouched = (await c.query("select claim_id, actor_kind, actor_user_id, idempotency_key, metadata from private.catalog_review_events where event_type='claim_vouched' and claim_id = any($1::uuid[])", [[child.id, unlisted.id]])).rows;
    expect(vouched).toHaveLength(2);
    expect(vouched.filter((row) => row.idempotency_key === idem).map((row) => row.claim_id)).toEqual([sorted([child.id, unlisted.id])[0]]);
    for (const row of vouched) {
      expect(row).toMatchObject({ actor_kind: 'organization_admin', actor_user_id: parent.user, metadata: { method: 'parent_body_confirmation', verifierKind: 'parent_organization', relationship: 'parent', toStatus: 'approved' } });
    }
    const parentLedger = await ledgerRows(c, parent.org, 'organization_catalog_claim_vouched');
    expect(parentLedger).toHaveLength(2);
    for (const row of parentLedger) expect(row).toMatchObject({ action: 'update', actor_user_id: parent.user, metadata: { reasonCode: 'parent', toStatus: 'approved' } });
    expect(parentLedger.map((row) => row.metadata.entityId).sort()).toEqual(sorted([K1, 'unlisted']));
    for (const org of [child.admin.org, unlistedAdmin.org]) {
      expect((await ledgerRows(c, org, 'organization_catalog_placement_verified')).map((row) => row.actor_user_id), org).toEqual([null]);
      // The claimant tenant's ledger names the rung (review C9).
      expect((await ledgerRows(c, org, 'organization_catalog_placement_verified')).map((row) => row.metadata.reasonCode), org).toEqual(['parent_organization']);
    }
    // A replay answers the first result and writes nothing; nothing is left to vouch for.
    const before = await counts(c);
    await as(c, parent);
    expect(await vouch(c, parent.org, [unlisted.id, child.id], { idem })).toEqual({ approved: sorted([child.id, unlisted.id]), idempotent: true });
    // The key is bound to the claims it vouched for (review C5).
    await expectRefusal(vouch(c, parent.org, [sorted([child.id, unlisted.id])[1]], { idem }), '22023', 'idempotency key reused');
    await expectRefusal(vouch(c, parent.org, [child.id, unlisted.id, randomUUID()], { idem }), '22023', 'idempotency key reused');
    expect(await listVouchable(c, parent.org)).toEqual({ claims: [] });
    await owner(c);
    expect(await counts(c)).toEqual(before);

    // A listed claim never borrows the claiming organization's self-reported
    // parent: with no public-record edge it is neither listed nor vouchable.
    const borrower = await organization(c, { name: 'Example Workers Local 27' });
    await selfReport(c, borrower, { parent: K9 });
    const noEdge = await fileAndConfirm(c, { admin: borrower, target: key(27), email: CONSUMER_EMAIL });
    expect(noEdge.row.status).toBe('under_review');
    // An organization that self-reports the claimed listing as its own parent.
    await edge(c, key(28), K9, 'parent_body');
    const looped = await organization(c, { name: 'Example Workers Local 28 Unit' });
    await selfReport(c, looped, { parent: key(28) });
    const loop = await fileAndConfirm(c, { admin: looped, target: key(28), email: ownEmail(28) });
    expect(loop.row).toMatchObject({ status: 'under_review', auto_approved: false });
    await as(c, parent);
    // Neither is offered: the list applies the vouch's own refusals.
    expect(await listVouchable(c, parent.org)).toEqual({ claims: [] });
    await owner(c);
    const beforeRefusals = await counts(c);
    await as(c, parent);
    await expectRefusal(vouch(c, parent.org, [noEdge.id]), '22023', 'claim not vouchable');
    await expectRefusal(vouch(c, parent.org, [loop.id]), '22023', 'placement parent is the claimed listing');
    await owner(c);
    expect(await counts(c)).toEqual(beforeRefusals);
    expect(await claimRow(c, loop.id)).toMatchObject({ status: 'under_review', vouching_organization_id: null });

    // An unlisted claim's self-reported parent counts only when it is a
    // public-record parent body: a verified local with no children in the
    // record cannot vouch as anyone's parent.
    const local = await verifiedOrganization(c, 40, { orgName: 'Example Workers Local 40' });
    const pretender = await organization(c, { name: 'Example Workers Unit Forty' });
    await selfReport(c, pretender, { parent: key(40) });
    const pretend = await fileAndConfirm(c, { admin: pretender, unlisted: { name: 'Example Unlisted Unit Forty' }, email: CONSUMER_EMAIL });
    expect(pretend.row.status).toBe('under_review');
    await as(c, local);
    expect(await listVouchable(c, local.org)).toEqual({ claims: [] });
    await owner(c);
    const beforeLocal = await counts(c);
    await as(c, local);
    await expectRefusal(vouch(c, local.org, [pretend.id]), '22023', 'claim not vouchable');
    await owner(c);
    expect(await counts(c)).toEqual(beforeLocal);

    // A vouch pins the parent (round 3, C3). Re-stating the same parent keeps
    // the verification; changing the parent key withdraws it (parent_changed).
    const withdrawn = async (claimId, who) => {
      expect(await claimRow(c, claimId)).toMatchObject({ status: 'revoked', reason_code: 'parent_changed', verifier_kind: 'parent_organization' });
      expect((await c.query('select private.organization_is_verified($1) as v', [who.org])).rows[0].v).toBe(false);
      expect((await c.query("select actor_kind, actor_user_id from private.catalog_review_events where claim_id=$1 and event_type in ('claim_revoked','placement_detached') order by event_type", [claimId])).rows)
        .toEqual([{ actor_kind: 'organization_admin', actor_user_id: who.user }, { actor_kind: 'organization_admin', actor_user_id: who.user }]);
      expect((await ledgerRows(c, who.org, 'organization_catalog_placement_verification_revoked')).map((row) => row.metadata.reasonCode)).toEqual(['parent_changed']);
    };
    await selfReport(c, unlistedAdmin, { parent: K9, identity: true });
    expect(await placementRow(c, unlistedAdmin.org)).toMatchObject({ verification_status: 'verified', verified_claim_id: unlisted.id });
    await selfReport(c, unlistedAdmin, { parent: key(28), identity: true });
    await withdrawn(unlisted.id, unlistedAdmin);
    expect(await placementRow(c, unlistedAdmin.org)).toMatchObject({
      verification_status: 'self_reported', verified_at: null, verified_claim_id: null, identity_unlisted: true, parent_catalog_key: key(28),
    });
    // Clearing the placement withdraws it too.
    await as(c, child.admin);
    expect(await clearPlacement(c, child.admin.org)).toEqual({ placement: null });
    await owner(c);
    await withdrawn(child.id, child.admin);
    expect(await placementRow(c, child.admin.org)).toBeNull();
    // A domain-verified organization keeps its checkmark when it re-parents;
    // the parent stays labelled self-reported.
    await selfReport(c, parent, { parent: key(27) });
    expect(await placementRow(c, parent.org)).toMatchObject({ verification_status: 'verified', identity_catalog_key: K9, parent_catalog_key: key(27) });
    expect(await claimRow(c, parent.claimId)).toMatchObject({ status: 'approved' });
    const landing = await publicRead(c, parent.slug);
    expect(landing.verification.status).toBe('verified');
    expect(landing.placement).toMatchObject({ catalogKey: key(27), selfReported: true });
    // ...and it still cannot clear a verified placement.
    await as(c, parent);
    await expectRefusal(clearPlacement(c, parent.org), '22023', 'placement verified');
    await owner(c);

    // A voucher whose own listing the catalog has merged away no longer
    // vouches (review C6).
    await edge(c, key(41), K9, 'parent_body');
    const orphan = await fileAndConfirm(c, { target: key(41), email: CONSUMER_EMAIL });
    await as(c, parent);
    expect((await listVouchable(c, parent.org)).claims.map((item) => item.claimId)).toEqual([orphan.id]);
    await owner(c);
    await c.query('update private.catalog_organizations set duplicate_of=$2 where catalog_key=$1', [K9, K1]);
    const beforeMerged = await counts(c);
    await as(c, parent);
    expect(await listVouchable(c, parent.org)).toEqual({ claims: [] });
    await expectRefusal(vouch(c, parent.org, [orphan.id]), '42501', 'verified catalog identity required');
    await owner(c);
    expect(await counts(c)).toEqual(beforeMerged);

  });
}, 120_000);

live('17. sister-chapter handshake, and vouching refusals that write nothing', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const operator = await verifier(c);
    const sister = await verifiedOrganization(c, 20, { orgName: 'Example Workers Local 20' });
    for (const n of [20, 21, 22, 23, 25, 29, 30, 31, 32, 33]) await edge(c, key(n), K9, 'parent_body');
    await edge(c, key(24), K9, 'regional_body');
    await edge(c, key(28), K9, 'olms_parent');
    // The voucher reaches this shared parent only through olms_parent (review C17).
    await edge(c, key(20), key(36), 'olms_parent');
    await edge(c, key(34), key(36), 'parent_body');
    const target = await fileAndConfirm(c, { target: key(21), email: CONSUMER_EMAIL });
    const viaOlms = await fileAndConfirm(c, { target: key(34), email: CONSUMER_EMAIL });
    const unrelated = await fileAndConfirm(c, { target: key(26), email: CONSUMER_EMAIL });
    const held = await fileAndConfirm(c, { target: key(22), email: CONSUMER_EMAIL });
    await review(c, held.id, operator, 'hold', { hold: 'awaiting_callback' });
    const waiting = await file(c, { target: key(23), email: CONSUMER_EMAIL });
    const regional = await fileAndConfirm(c, { target: key(24), email: CONSUMER_EMAIL });
    const olmsOnly = await fileAndConfirm(c, { target: key(28), email: CONSUMER_EMAIL });
    const valid = await fileAndConfirm(c, { target: key(25), email: CONSUMER_EMAIL });
    // The vouching admin also administers the claiming organization and filed its claim.
    const ownOrg = await organization(c, { name: 'Example Workers Local 29' });
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [ownOrg.org, sister.user]);
    await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [ownOrg.org, sister.user]);
    const selfFiled = await fileAndConfirm(c, { admin: { org: ownOrg.org, user: sister.user }, target: key(29), email: CONSUMER_EMAIL });
    expect(selfFiled.row).toMatchObject({ status: 'under_review', claimant_user_id: sister.user });
    // The vouching admin is a plain member of the claiming organization.
    const memberOf = await fileAndConfirm(c, { target: key(30), email: CONSUMER_EMAIL });
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [memberOf.admin.org, sister.user]);
    // The claiming organization is suspended.
    const suspended = await fileAndConfirm(c, { target: key(33), email: CONSUMER_EMAIL });
    await c.query("update public.organizations set status='suspended' where id=$1", [suspended.admin.org]);

    await as(c, sister);
    const listed = await listVouchable(c, sister.org);
    expect(listed.claims.map((item) => item.claimId).sort()).toEqual(sorted([target.id, valid.id]));
    for (const item of listed.claims) expect(item.relationship).toBe('sibling');
    // A listing in its election window, and a retired listing.
    await owner(c);
    const election = await fileAndConfirm(c, { target: key(31), email: CONSUMER_EMAIL });
    await c.query('update private.catalog_organizations set next_election_on=current_date + 10 where catalog_key=$1', [key(31)]);
    const retired = await fileAndConfirm(c, { target: key(32), email: CONSUMER_EMAIL });
    await c.query('update private.catalog_organizations set retired_release_id=$2 where catalog_key=$1', [key(32), randomUUID()]);
    // The list offers only what a vouch would accept.
    await as(c, sister);
    expect((await listVouchable(c, sister.org)).claims.map((item) => item.claimId).sort()).toEqual(sorted([target.id, valid.id]));
    const refuse = async (label, ids, code = '22023', message = 'claim not vouchable', who = sister) => {
      await owner(c);
      const before = await counts(c);
      await as(c, who);
      await expectRefusal(vouch(c, who.org, ids), code, message);
      await owner(c);
      expect(await counts(c), label).toEqual(before);
    };
    await refuse('unrelated organization', [unrelated.id]);
    await refuse('held claim', [held.id]);
    await refuse('awaiting_email claim', [waiting.id]);
    await refuse('regional_body edge only', [regional.id]);
    await refuse('olms_parent edge only (no shared parent_body)', [olmsOnly.id]);
    await refuse('voucher reaches the shared parent only through olms_parent', [viaOlms.id]);
    await refuse('claim filed by the vouching admin', [selfFiled.id]);
    // The claimant is refused even after leaving the claiming organization (review C16).
    await c.query("update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2", [ownOrg.org, sister.user]);
    await as(c, sister);
    expect((await listVouchable(c, sister.org)).claims.map((item) => item.claimId).sort()).toEqual(sorted([target.id, valid.id]));
    await refuse('claim filed by the vouching admin, who has left the claiming organization', [selfFiled.id]);
    await refuse('claiming organization has the vouching admin as a member', [memberOf.id]);
    await refuse('suspended claiming organization', [suspended.id]);
    await refuse('listing in its election window', [election.id]);
    await refuse('retired listing', [retired.id]);
    await refuse('one valid and one invalid claim', [valid.id, unrelated.id]);
    expect(await claimRow(c, valid.id)).toMatchObject({ status: 'under_review', vouching_organization_id: null });
    // A contested claim the verifier released stays with the verifier while the
    // contest stands: vouch refuses it (review C19) and the list does not offer it (review C20).
    await edge(c, key(35), K9, 'parent_body');
    const contested = await fileAndConfirm(c, { target: key(35), email: CONSUMER_EMAIL });
    const rival = await fileAndConfirm(c, { target: key(35), email: ownEmail(35) });
    expect(rival.row).toMatchObject({ status: 'held', hold_reason: 'contested' });
    await review(c, contested.id, operator, 'release');
    await as(c, sister);
    expect((await listVouchable(c, sister.org)).claims.map((item) => item.claimId).sort()).toEqual(sorted([target.id, valid.id]));
    await refuse('released claim on a still-contested listing', [contested.id]);
    expect(await claimRow(c, contested.id)).toMatchObject({ status: 'under_review', vouching_organization_id: null });
    // Callers who may not vouch.
    const unverified = await organization(c, { name: 'Example Workers Local 27' });
    await as(c, unverified);
    await expectRefusal(vouch(c, unverified.org, [target.id]), '42501', 'verified catalog identity required');
    expect(await listVouchable(c, unverified.org)).toEqual({ claims: [] });
    await owner(c);
    const plain = await member(c, sister);
    await refuse('non-admin', [target.id], '42501', 'not authorized', plain);
    // A banned admin of the sister never vouches or lists (round 3, item 2).
    const bannedSister = await member(c, sister, { role: 'admin' });
    await c.query("update auth.users set banned_until = now() + interval '1 day' where id=$1", [bannedSister.user]);
    await refuse('banned vouching admin', [target.id], '42501', 'not authorized', bannedSister);
    await as(c, bannedSister);
    await expectRefusal(listVouchable(c, sister.org), '42501', 'not authorized');
    await owner(c);
    const notStepped = await member(c, sister, { role: 'admin', aal: 'aal1' });
    await refuse('second factor not presented', [target.id], '42501', 'mfa required', notStepped);
    // With staff MFA switched off, vouching still needs aal2; the enrolled
    // factor is required only where the policy requires staff MFA (round 3, item 3).
    await c.query('insert into public.org_security_policy(organization_id,require_staff_mfa,updated_by) values ($1,false,$2)', [sister.org, sister.user]);
    const noFactorAal1 = await member(c, sister, { role: 'admin', factor: false });
    await refuse('aal1 with no enrolled factor', [target.id], '42501', 'mfa required', noFactorAal1);
    // The list shows other tenants' claims, so it takes the same step-up (review C7).
    await as(c, noFactorAal1);
    await expectRefusal(listVouchable(c, sister.org), '42501', 'mfa required');
    const noFactorAal2 = await member(c, sister, { role: 'admin', factor: false, aal: 'aal2' });
    await as(c, noFactorAal2);
    expect((await listVouchable(c, sister.org)).claims.map((item) => item.claimId)).toContain(target.id);
    await owner(c);

    await as(c, sister);
    expect(await vouch(c, sister.org, [target.id])).toEqual({ approved: [target.id], idempotent: false });
    await owner(c);
    expect(await claimRow(c, target.id)).toMatchObject({
      status: 'approved', verification_method: 'sibling_handshake', verifier_kind: 'sibling_organization',
      vouching_organization_id: sister.org, reviewed_by: sister.user,
    });
    expect(await placementRow(c, target.admin.org)).toMatchObject({ verification_status: 'verified', identity_catalog_key: key(21) });
    expect((await ledgerRows(c, sister.org, 'organization_catalog_claim_vouched')).map((row) => row.metadata.reasonCode)).toEqual(['sibling']);
    // An organization verified by a sister's handshake cannot vouch in turn.
    await as(c, target.admin);
    expect(await listVouchable(c, target.admin.org)).toEqual({ claims: [] });
    await refuse('sibling-verified voucher', [valid.id], '42501', 'verified catalog identity required', target.admin);
  });
}, 120_000);

live('18. undo clears verified_at and keeps the organization and the account', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const operator = await verifier(c);
    const undo = async (claimId, who, { rowDeleted, reason }) => {
      const state = await organizationState(c, who.org, who.user);
      const result = await revokeClaim(c, claimId, operator, { reason });
      expect(result).toMatchObject({ claimId, organizationId: who.org, idempotent: false });
      const claim = await claimRow(c, claimId);
      expect(claim).toMatchObject({ status: 'revoked', reason_code: reason });
      expect(claim.revoked_at).not.toBeNull();
      expect(await organizationState(c, who.org, who.user)).toEqual(state);
      const detached = (await c.query("select actor_kind, actor_user_id, metadata from private.catalog_review_events where claim_id=$1 and event_type in ('claim_revoked','placement_detached') order by event_type", [claimId])).rows;
      expect(detached).toHaveLength(2);
      expect(detached[0]).toMatchObject({ actor_kind: 'verifier', actor_user_id: operator, metadata: { toStatus: 'revoked', reasonCode: reason } });
      expect(detached[1]).toMatchObject({ actor_kind: 'verifier', metadata: { rowDeleted, fromStatus: 'verified', toStatus: rowDeleted ? 'cleared' : 'self_reported' } });
      const ledger = await ledgerRows(c, who.org, 'organization_catalog_placement_verification_revoked');
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ action: 'update', actor_user_id: null, metadata: { fromStatus: 'verified', toStatus: rowDeleted ? 'cleared' : 'self_reported', reasonCode: reason } });
    };

    // (a) the domain-approved claim of case 7.
    const domainAdmin = await organization(c);
    await selfReport(c, domainAdmin, { parent: K9 });
    const domain = await fileAndConfirm(c, { admin: domainAdmin, target: K1, email: ownEmail(1) });
    expect(domain.row.status).toBe('approved');
    const placedAt = (await placementRow(c, domainAdmin.org)).placed_at;
    await undo(domain.id, domainAdmin, { rowDeleted: false, reason: 'wrong_claimant' });
    expect(await placementRow(c, domainAdmin.org)).toMatchObject({
      parent_catalog_key: K9, verified_at: null, verified_claim_id: null, identity_catalog_key: null, verification_status: 'self_reported', identity_unlisted: false, placed_at: placedAt,
    });

    // (b) an operator-approved claim for an organization that had no placement row.
    const bare = await fileAndConfirm(c, { target: key(60), email: CONSUMER_EMAIL });
    await review(c, bare.id, operator, 'approve', { method: 'written_authorization' });
    expect(await placementRow(c, bare.admin.org)).toMatchObject({ identity_catalog_key: key(60), parent_catalog_key: null });
    await undo(bare.id, bare.admin, { rowDeleted: true, reason: 'wrong_organization' });
    expect(await placementRow(c, bare.admin.org)).toBeNull();

    // (c) an unlisted verified row keeps identity_unlisted.
    const unlisted = await fileAndConfirm(c, { unlisted: { name: 'Example Unlisted Council' }, email: CONSUMER_EMAIL });
    await review(c, unlisted.id, operator, 'approve', { method: 'written_authorization' });
    await undo(unlisted.id, unlisted.admin, { rowDeleted: false, reason: 'authority_withdrawn' });
    expect(await placementRow(c, unlisted.admin.org)).toMatchObject({ identity_unlisted: true, verified_at: null, verified_claim_id: null, verification_status: 'self_reported' });

    // (d) a vouched claim can be revoked too.
    const parent = await verifiedOrganization(c, 9, { orgName: 'Example Council 9' });
    await edge(c, key(61), K9, 'olms_parent');
    const child = await fileAndConfirm(c, { target: key(61), email: CONSUMER_EMAIL });
    await as(c, parent);
    await vouch(c, parent.org, [child.id]);
    await owner(c);
    await undo(child.id, child.admin, { rowDeleted: true, reason: 'fraud_suspected' });
    expect(await claimRow(c, child.id)).toMatchObject({ vouching_organization_id: parent.org, verifier_kind: 'parent_organization' });

    // (e) undo of a voucher withdraws what it vouched for, down the tree (review C1).
    await edge(c, key(62), K9, 'olms_parent');
    await edge(c, key(63), key(62), 'olms_parent');
    await edge(c, key(64), key(62), 'olms_parent');
    const middle = await fileAndConfirm(c, { target: key(62), email: CONSUMER_EMAIL });
    await as(c, parent);
    await vouch(c, parent.org, [middle.id]);
    await owner(c);
    const leaf = await fileAndConfirm(c, { target: key(63), email: CONSUMER_EMAIL });
    await as(c, middle.admin);
    await vouch(c, middle.admin.org, [leaf.id]);
    await owner(c);
    const isVerified = async (org) => (await c.query('select private.organization_is_verified($1) as v', [org])).rows[0].v;
    const parentState = await organizationState(c, parent.org, parent.user);
    const cascade = await revokeClaim(c, parent.claimId, operator, { reason: 'fraud_suspected' });
    expect(cascade).toMatchObject({ claimId: parent.claimId, idempotent: false });
    expect(sorted(cascade.dependentClaimIds)).toEqual(sorted([middle.id, leaf.id]));
    for (const [id, who, reason] of [[parent.claimId, parent, 'fraud_suspected'], [middle.id, middle.admin, 'parent_changed'], [leaf.id, leaf.admin, 'parent_changed']]) {
      expect(await claimRow(c, id), id).toMatchObject({ status: 'revoked', reason_code: reason });
      expect(await isVerified(who.org), id).toBe(false);
      expect(await eventTypes(c, id), id).toEqual(expect.arrayContaining(['claim_revoked', 'placement_detached']));
    }
    expect(await organizationState(c, parent.org, parent.user)).toEqual(parentState);
    const listed = await svc(c, 'public.list_organization_claims($1,$2,$3,$4)', [operator, 'revoked', 1, verifierSession(operator)]);
    expect(listed.claims.find((item) => item.claimId === middle.id)).toMatchObject({ vouchingOrganizationId: parent.org });
    // The withdrawn middle organization can no longer vouch for its own children.
    const next = await fileAndConfirm(c, { target: key(64), email: CONSUMER_EMAIL });
    await as(c, middle.admin);
    expect(await listVouchable(c, middle.admin.org)).toEqual({ claims: [] });
    await expectRefusal(vouch(c, middle.admin.org, [next.id]), '42501', 'verified catalog identity required');
    await owner(c);

    // A revoked claim cannot be revoked again.
    await expectRefusal(revokeClaim(c, domain.id, operator), '22023', 'claim state');
    // The freed key takes a new claim, not contested by the revoked one.
    const fresh = await fileAndConfirm(c, { target: K1, email: ownEmail(1) });
    expect(fresh.row).toMatchObject({ status: 'approved', hold_reason: null });
    expect(fresh.row.signals).toMatchObject({ competingClaims: 0, targetVerifiedElsewhere: false });
  });
}, 120_000);

live('19. a self-reported placement never reads as verified; the read\'s guards; the clear guard while verified', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const operator = await verifier(c);
    const parent = await organization(c);
    const identity = await organization(c, { name: 'Example Council 9' });
    const none = await organization(c, { name: 'Example Workers Local 61' });
    await selfReport(c, parent, { parent: K9 });
    await selfReport(c, identity, { identity: true });
    const selfReported = { verification: { status: 'self_reported', identity: null, verifiedAt: null }, openClaim: null };
    for (const [who, placement] of [[parent, 'row'], [identity, 'row'], [none, null]]) {
      await as(c, who);
      expect(await getVerification(c, who.org)).toEqual(selfReported);
      const read = await getPlacement(c, who.org);
      if (placement) expect(read.placement.verificationStatus).toBe('self_reported');
      else expect(read).toEqual({ placement: null });
    }
    // A tenant-issued "verified" chapter binding never feeds the mark.
    await owner(c);
    const unionOrg = `proof-union-${randomUUID().slice(0, 8)}`;
    await c.query("insert into public.union_orgs(id,olms_file_number,name,level,enrichment_status,atlas_manifest_sha) values ($1,900000001,'Example Workers Local 1','local','no_web_presence',repeat('0',64))", [unionOrg]);
    await c.query("insert into public.chapter_union_org_bindings(chapter_id,union_org_id,status,requested_by,verified_by,verified_at) values ($1,$2,'verified',$3,$3,now())", [parent.chapter, unionOrg, parent.user]);
    await as(c, parent);
    expect(await getVerification(c, parent.org)).toEqual(selfReported);
    expect((await getPlacement(c, parent.org)).placement.verificationStatus).toBe('self_reported');
    await owner(c);
    expect((await c.query('select private.organization_is_verified($1) as v', [parent.org])).rows[0].v).toBe(false);

    // Verified: the read shows the identity and 4a's clear is refused until undo.
    const claim = await fileAndConfirm(c, { admin: parent, target: key(61), email: ownEmail(61) });
    expect(claim.row.status).toBe('approved');
    await as(c, parent);
    const verified = await getVerification(c, parent.org);
    expect(verified.verification).toMatchObject({ status: 'verified', identity: { kind: 'catalog', catalogKey: key(61), name: 'Example Workers Local 61' } });
    expect(verified.verification.verifiedAt).not.toBeNull();
    expect(verified.openClaim).toBeNull();
    expect((await getPlacement(c, parent.org)).placement.verificationStatus).toBe('verified');
    await expectRefusal(clearPlacement(c, parent.org), '22023', 'placement verified');
    // A verified row may drop its self-reported parent; an unverified one may not empty itself.
    expect((await setPlacement(c, parent.org, {})).placement).toMatchObject({ parentCatalogKey: null, identityUnlisted: false, verificationStatus: 'verified' });
    await owner(c);
    expect(await placementRow(c, parent.org)).toMatchObject({ parent_catalog_key: null, identity_catalog_key: key(61), verification_status: 'verified' });
    await as(c, none);
    await expectRefusal(setPlacement(c, none.org, {}), '22023', 'placement empty');
    await owner(c);
    await revokeClaim(c, claim.id, operator);
    await as(c, parent);
    expect(await getVerification(c, parent.org)).toEqual(selfReported);
    expect(await clearPlacement(c, parent.org)).toEqual({ placement: null });

    // Guards.
    const plain = await member(c, parent);
    await as(c, plain);
    await expectRefusal(getVerification(c, parent.org), '42501', 'not authorized');
    await as(c, parent);
    await expectRefusal(getVerification(c, identity.org), '42501', 'pay organization scope changed');
    await expectRefusal(getVerification(c, parent.org, 'steward'), '42501', 'not authorized');
    const notStepped = await member(c, parent, { role: 'admin', aal: 'aal1' });
    await as(c, notStepped);
    await expectRefusal(getVerification(c, parent.org), '42501', 'mfa required');
    const noFactor = await member(c, parent, { role: 'admin', factor: false });
    await as(c, noFactor);
    await expectRefusal(getVerification(c, parent.org), '42501');

    // An open claim reads awaiting_email, then in_review, with no hold reason.
    await owner(c);
    const open = await file(c, { admin: identity, target: key(62), email: CONSUMER_EMAIL });
    await as(c, identity);
    expect((await getVerification(c, identity.org)).openClaim).toEqual({ state: 'awaiting_email', catalogKey: key(62) });
    await owner(c);
    await confirm(c, open.token);
    await as(c, identity);
    expect((await getVerification(c, identity.org)).openClaim).toEqual({ state: 'in_review', catalogKey: key(62) });
    await owner(c);
    await review(c, open.id, operator, 'hold', { hold: 'contested' });
    await as(c, identity);
    const held = await getVerification(c, identity.org);
    expect(held.openClaim).toEqual({ state: 'in_review', catalogKey: key(62) });
    expect(JSON.stringify(held)).not.toMatch(/contested|holdReason|Fixtureperson|@/);

    // A verified unlisted organization cannot flip identity_unlisted off (review C21).
    await owner(c);
    const unlistedOrg = await organization(c, { name: 'Example Unlisted Council' });
    await selfReport(c, unlistedOrg, { parent: K9 });
    const unlistedClaim = await fileAndConfirm(c, { admin: unlistedOrg, unlisted: { name: 'Example Unlisted Council' }, email: CONSUMER_EMAIL });
    await review(c, unlistedClaim.id, operator, 'approve', { method: 'written_authorization' });
    await as(c, unlistedOrg);
    await expectRefusal(setPlacement(c, unlistedOrg.org, { parent: K9, identity: false }), '22023', 'placement verified');
    await owner(c);
    expect(await placementRow(c, unlistedOrg.org)).toMatchObject({ verification_status: 'verified', identity_unlisted: true, parent_catalog_key: K9 });
  });
}, 120_000);

live('20. the SQL registrable domain equals registrableDomain(), and the blocked domains equal the config union', async () => {
  await withClient(async (c) => {
    const hosts = [
      'a.k12.ma.us', 'county.ma.us', 'x.co.uk', 'www.examplelocal1.example', 'mail.examplelocal1.example', 'examplelocal1.example',
      'Examplelocal1.Example.', '192.0.2.10', 'localhost', '', 'x.us', 'a.b.org.au', 'deep.sub.examplecouncil9.example', '::1', 'host:8080',
    ];
    for (const host of hosts) {
      const sql = (await c.query('select private.catalog_registrable_domain($1) as d', [host])).rows[0].d;
      expect(sql, JSON.stringify(host)).toBe(registrableDomain(host));
    }
    const expected = new Map();
    for (const domain of BLOCKED_CONFIG.consumer) if (!expected.has(domain)) expected.set(domain, 'consumer');
    for (const domain of BLOCKED_CONFIG.hosting) if (!expected.has(domain)) expected.set(domain, 'hosting');
    for (const domain of Object.values(FAMILY_CONFIG.families).flat()) if (!expected.has(domain)) expected.set(domain, 'family');
    const rows = (await c.query('select domain, list from private.catalog_claim_blocked_domains')).rows;
    const byDomain = (a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0);
    expect(rows.sort(byDomain)).toEqual([...expected].map(([domain, list]) => ({ domain, list })).sort(byDomain));
  });
}, 120_000);

live('21. retention purges closed claims after 90 days and expired ones after 7, never open claims; the job is monitored', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const now = (await c.query('select now() as n')).rows[0].n;
    const ago = (days) => new Date(now.getTime() - days * 86400000);
    const decided = (days, extra = {}) => ({
      status: 'rejected', reason_code: 'not_verified', review_note: 'Fixture note', email_confirmed_at: ago(days + 1), reviewed_at: ago(days), closed_at: ago(days), ...extra,
    });
    const ids = {
      rejected91: await insertClaim(c, { catalog_key: key(63), ...decided(91) }),
      approved91: await insertClaim(c, {
        catalog_key: key(64), ...decided(91, { status: 'approved', reason_code: null, verification_method: 'olms_address_mailback', verifier_kind: 'platform_operator' }),
        mailback_code_hmac: hex(), mailback_issued_at: ago(120), mailback_expires_at: ago(75), mailback_attempts: 2,
      }),
      rejected89: await insertClaim(c, { catalog_key: key(65), ...decided(89) }),
      expired8: await insertClaim(c, { catalog_key: key(66), status: 'expired', closed_at: ago(8), confirm_expires_at: ago(8) }),
      expired6: await insertClaim(c, { catalog_key: key(67), status: 'expired', closed_at: ago(6), confirm_expires_at: ago(6) }),
      lapsing: await insertClaim(c, { catalog_key: key(68), status: 'awaiting_email', confirm_token_hash: hex(), confirm_expires_at: ago(1), created_at: ago(2) }),
      waiting: await insertClaim(c, { catalog_key: key(69), status: 'awaiting_email', confirm_token_hash: hex(), confirm_expires_at: new Date(now.getTime() + 3600000) }),
      reviewing: await insertClaim(c, { catalog_key: key(20), status: 'under_review', email_confirmed_at: ago(200), created_at: ago(200) }),
      holding: await insertClaim(c, { catalog_key: key(21), status: 'held', hold_reason: 'awaiting_mailback', email_confirmed_at: ago(200), created_at: ago(200), mailback_code_hmac: hex(), mailback_issued_at: ago(150), mailback_expires_at: ago(105) }),
      reviewing89: await insertClaim(c, { catalog_key: key(22), status: 'under_review', email_confirmed_at: ago(89), created_at: ago(89) }),
    };
    const snapshot = {};
    for (const [name, id] of Object.entries(ids)) snapshot[name] = await claimRow(c, id);
    const baseline = (await c.query(`select count(*)::int n from private.organization_claims where personal_data_purged_at is null and not (id = any($1::uuid[]))
      and status in ('approved','rejected','expired','revoked') and closed_at < now() - case when status='expired' then interval '7 days' else interval '90 days' end`, [Object.values(ids)])).rows[0].n;
    const removed = (await c.query('select private.purge_organization_claim_personal_data() as n')).rows[0].n;
    expect(removed).toBe(baseline + 5);
    for (const name of ['rejected91', 'approved91', 'expired8']) {
      const row = await claimRow(c, ids[name]);
      expect(row, name).toMatchObject({
        claimant_name: null, claimant_title: null, claimant_email: null, statement: null, review_note: null,
        mailback_code_hmac: null, mailback_issued_at: null, mailback_expires_at: null,
      });
      expect(row.personal_data_purged_at, name).not.toBeNull();
      for (const kept of ['claimant_email_scope', 'status', 'verification_method', 'verifier_kind', 'reason_code', 'catalog_key', 'organization_id', 'closed_at']) {
        expect(row[kept], `${name}.${kept}`).toEqual(snapshot[name][kept]);
      }
    }
    for (const name of ['rejected89', 'expired6', 'waiting', 'reviewing89']) {
      expect(await claimRow(c, ids[name]), name).toEqual(snapshot[name]);
    }
    // An open claim never decided expires 90 days after submission and its
    // claimant data goes in the same run (round 3, C10 default).
    for (const [name, fromStatus] of [['reviewing', 'under_review'], ['holding', 'held']]) {
      const row = await claimRow(c, ids[name]);
      expect(row, name).toMatchObject({
        status: 'expired', hold_reason: null, claimant_name: null, claimant_title: null, claimant_email: null, statement: null,
        mailback_code_hmac: null, mailback_issued_at: null, mailback_expires_at: null,
      });
      expect(row.closed_at, name).not.toBeNull();
      expect(row.personal_data_purged_at, name).not.toBeNull();
      expect((await c.query("select metadata from private.catalog_review_events where claim_id=$1 and event_type='claim_expired'", [ids[name]])).rows.map((r) => r.metadata), name)
        .toEqual([{ catalogKey: snapshot[name].catalog_key, fromStatus, toStatus: 'expired' }]);
    }
    const lapsed = await claimRow(c, ids.lapsing);
    expect(lapsed).toMatchObject({ status: 'expired', confirm_token_hash: null, personal_data_purged_at: null, claimant_email: ownEmail(1) });
    expect(lapsed.closed_at).not.toBeNull();
    expect(await eventTypes(c, ids.lapsing)).toEqual(['claim_expired']);
    // An undo after the purge keeps no free-text note, which no later sweep would remove (review C2).
    const operator = await verifier(c);
    const late = await revokeClaim(c, ids.approved91, operator, { reason: 'fraud_suspected', note: 'Fixtureperson called 555-0142' });
    expect(late).toMatchObject({ idempotent: false });
    const lateRow = await claimRow(c, ids.approved91);
    expect(lateRow).toMatchObject({ status: 'revoked', review_note: null });
    expect(lateRow.personal_data_purged_at).not.toBeNull();

    // The job name is admitted by the monitoring CHECK and listed by the health read.
    const runId = `proof:${randomUUID()}`;
    await c.query("insert into public.organization_job_runs(organization_id,job_name,run_id,status,started_at) values (null,'organization-claim-retention',$1,'in_progress',now())", [runId]);
    await c.query('savepoint job_name');
    const error = await expectRefusal(c.query("insert into public.organization_job_runs(organization_id,job_name,run_id,status,started_at) values (null,'organization-claim-retention-proof',$1,'in_progress',now())", [`proof:${randomUUID()}`]), '23514');
    expect(error.constraint).toBe('organization_job_runs_job_name_check');
    await c.query('rollback to savepoint job_name');
    const admin = await organization(c);
    await as(c, admin);
    const health = await rpc(c, 'public.list_organization_job_health()', []);
    expect(health.find((job) => job.jobName === 'organization-claim-retention')).toMatchObject({ jobName: 'organization-claim-retention', lastRunId: runId, organizationId: admin.org });
    await owner(c);
    if ((await c.query("select pg_catalog.to_regnamespace('cron') is not null as present")).rows[0].present) {
      expect((await c.query("select schedule, command from cron.job where jobname='organization-claim-retention'")).rows).toEqual([{ schedule: '41 5 * * *', command: 'select private.purge_organization_claim_personal_data();' }]);
    }
  });
}, 120_000);

live('22. lifecycle: deleting a verifier account nulls its attribution; deleting organizations with no ledger rows detaches claims, events and vouchers', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const operator = await verifier(c, SECOND_VERIFIER);
    const held = await fileAndConfirm(c, { target: key(22), email: CONSUMER_EMAIL });
    await review(c, held.id, operator, 'hold', { hold: 'awaiting_callback' });
    const approved = await fileAndConfirm(c, { target: key(23), email: CONSUMER_EMAIL });
    await review(c, approved.id, operator, 'approve', { method: 'published_office_callback' });
    const rejected = await fileAndConfirm(c, { target: key(24), email: CONSUMER_EMAIL });
    await review(c, rejected.id, operator, 'reject', { reason: 'no_response' });
    expect((await c.query('select count(*)::int n from private.catalog_review_events where actor_user_id=$1 or subject_user_id=$1', [operator])).rows[0].n).toBeGreaterThanOrEqual(5);
    await owner(c);
    await c.query('delete from auth.users where id=$1', [operator]);
    expect((await c.query('select count(*)::int n from private.platform_operators where user_id=$1', [operator])).rows[0].n).toBe(0);
    expect((await c.query('select id, status, reviewed_by, verifier_kind from private.organization_claims where id = any($1::uuid[]) order by status', [[approved.id, rejected.id]])).rows).toEqual([
      { id: approved.id, status: 'approved', reviewed_by: null, verifier_kind: 'platform_operator' }, { id: rejected.id, status: 'rejected', reviewed_by: null, verifier_kind: null },
    ]);
    expect((await c.query('select count(*)::int n from private.catalog_review_events where actor_user_id=$1 or subject_user_id=$1', [operator])).rows[0].n).toBe(0);
    expect((await c.query("select count(*)::int n from private.catalog_review_events where actor_kind='verifier' and actor_user_id is null and event_type in ('claim_held','claim_approved','claim_rejected') and claim_id = any($1::uuid[])", [[held.id, approved.id, rejected.id]])).rows[0].n).toBe(3);
    expect((await c.query("select count(*)::int n from private.catalog_review_events where event_type='operator_granted' and subject_user_id is null")).rows[0].n).toBeGreaterThanOrEqual(1);
    for (const fn of ['account_lifecycle_unmanaged_restrictive_fks', 'account_lifecycle_referential_action_trigger_issues']) {
      expect((await c.query(`select * from private.${fn}()`)).rows, fn).toEqual([]);
    }

    // Organizations inserted as the owner with no ledger rows (G5): one with a
    // placement, a claim and an event; one referenced only as a claim's voucher.
    const org = randomUUID();
    const voucher = randomUUID();
    const gone = randomUUID();
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,'Example Workers Local 25 Proof'),($3,$4,'Example Council 9 Proof'),($5,$6,'Example Workers Local 27 Proof')", [org, `proof-${org}`, voucher, `proof-${voucher}`, gone, `proof-${gone}`]);
    const orphaned = await insertClaim(c, {
      catalog_key: key(27), organization_id: gone, claimant_email: ownEmail(27), status: 'approved', verification_method: 'written_authorization', verifier_kind: 'platform_operator',
      email_confirmed_at: new Date(), reviewed_at: new Date(), closed_at: new Date(),
    });
    await c.query('insert into private.organization_catalog_placements(organization_id,identity_unlisted) values ($1,true)', [org]);
    const claim = await insertClaim(c, { catalog_key: key(25), organization_id: org, claimant_email: ownEmail(25), status: 'under_review', email_confirmed_at: new Date() });
    await c.query("insert into private.catalog_review_events(event_type,actor_kind,subject_kind,claim_id,organization_id,idempotency_key) values ('claim_submitted','organization_admin','claim',$1,$2,$3)", [claim, org, randomUUID()]);
    const vouched = await insertClaim(c, {
      catalog_key: key(26), claimant_email: ownEmail(26), status: 'approved', verification_method: 'parent_body_confirmation', verifier_kind: 'parent_organization',
      vouching_organization_id: voucher, email_confirmed_at: new Date(), reviewed_at: new Date(), closed_at: new Date(),
    });
    expect((await c.query('select count(*)::int n from public.organization_audit_ledger where organization_id = any($1::uuid[])', [[org, voucher, gone]])).rows[0].n).toBe(0);
    await c.query('delete from public.organizations where id = any($1::uuid[])', [[org, voucher, gone]]);
    expect(await placementRow(c, org)).toBeNull();
    expect(await claimRow(c, claim)).toMatchObject({ organization_id: null, status: 'under_review' });
    expect((await c.query('select organization_id from private.catalog_review_events where claim_id=$1', [claim])).rows).toEqual([{ organization_id: null }]);
    expect(await claimRow(c, vouched)).toMatchObject({ vouching_organization_id: null, status: 'approved', verifier_kind: 'parent_organization' });
    // An approved claim whose organization is gone no longer contests its listing.
    expect(await claimRow(c, orphaned)).toMatchObject({ organization_id: null, status: 'approved' });
    const fresh = await fileAndConfirm(c, { target: key(27), email: ownEmail(27) });
    expect(fresh.row).toMatchObject({ status: 'approved', hold_reason: null, auto_approved: true });
    expect(fresh.row.signals).toMatchObject({ competingClaims: 0 });
  });
}, 300_000);

live('23. the isolation predicate and the anonymous landing read', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const operator = await verifier(c);
    const isVerified = async (who, org) => {
      await as(c, who);
      const result = await rpc(c, 'private.organization_is_verified($1)', [org]);
      await owner(c);
      return result;
    };
    const catalogParent = await organization(c, { name: 'Example Workers Local 30' });
    const unlistedParent = await organization(c, { name: 'Example Workers Local 31' });
    const bare = await organization(c, { name: 'Example Workers Local 32' });
    const suspended = await organization(c, { name: 'Example Workers Local 33' });
    await c.query("update public.organizations set status='suspended' where id=$1", [suspended.org]);
    await selfReport(c, catalogParent, { parent: K9 });
    await selfReport(c, unlistedParent, { name: 'Example Regional Council', state: 'OR' });
    expect(await isVerified(bare, bare.org)).toBe(false);
    expect(await isVerified(bare, catalogParent.org)).toBe(false);

    const notFound = { found: false };
    expect(await publicRead(c, 'proof-no-such-organization')).toEqual(notFound);
    expect(await publicRead(c, 'Not A Slug!')).toEqual(notFound);
    expect(await publicRead(c, null)).toEqual(notFound);
    expect(await publicRead(c, suspended.slug)).toEqual(notFound);
    const nameOf = async (org) => (await c.query('select name from public.organizations where id=$1', [org])).rows[0].name;
    const assertShape = (read) => {
      expect(Object.keys(read).sort()).toEqual(['found', 'organization', 'placement', 'verification']);
      expect(Object.keys(read.organization).sort()).toEqual(['name', 'slug']);
      expect(Object.keys(read.verification).sort()).toEqual(['identity', 'status', 'verifiedOn']);
      expect(JSON.stringify(read)).not.toMatch(/@|Fixtureperson|userId|email|claimant|verifier|method|member|admin/i);
    };
    const selfReported = await publicRead(c, catalogParent.slug);
    assertShape(selfReported);
    expect(selfReported).toEqual({
      found: true, organization: { name: await nameOf(catalogParent.org), slug: catalogParent.slug },
      verification: { status: 'self_reported', identity: null, verifiedOn: null },
      placement: { kind: 'catalog', catalogKey: K9, name: 'Example Council 9', selfReported: true },
    });
    const unlisted = await publicRead(c, unlistedParent.slug);
    assertShape(unlisted);
    expect(unlisted.placement).toEqual({ kind: 'unlisted', selfReported: true });
    expect(unlisted.verification.status).toBe('self_reported');
    expect(JSON.stringify(unlisted)).not.toContain('Example Regional Council');
    const none = await publicRead(c, bare.slug);
    assertShape(none);
    expect(none.placement).toBeNull();

    // Verified: the predicate turns true and the landing read shows the identity.
    const claim = await fileAndConfirm(c, { admin: catalogParent, target: key(30), email: ownEmail(30) });
    expect(claim.row.status).toBe('approved');
    expect(await isVerified(bare, catalogParent.org)).toBe(true);
    // A suspended or archived organization is never verified, whatever its placement says.
    for (const status of ['suspended', 'archived']) {
      await c.query('update public.organizations set status=$2 where id=$1', [catalogParent.org, status]);
      expect(await isVerified(bare, catalogParent.org), status).toBe(false);
      expect(await publicRead(c, catalogParent.slug), status).toEqual(notFound);
    }
    await c.query("update public.organizations set status='active' where id=$1", [catalogParent.org]);
    expect(await isVerified(bare, catalogParent.org)).toBe(true);
    const verified = await publicRead(c, catalogParent.slug);
    assertShape(verified);
    expect(verified.verification).toMatchObject({ status: 'verified', identity: { kind: 'catalog', catalogKey: key(30), name: 'Example Workers Local 30' } });
    expect(Object.keys(verified.verification.identity).sort()).toEqual(['catalogKey', 'kind', 'name']);
    expect(verified.verification.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The public date is the Eastern date, like the catalog's other public dates (review C15).
    const verifiedAt = (await placementRow(c, catalogParent.org)).verified_at;
    await c.query("update private.organization_catalog_placements set verified_at = timestamptz '2026-09-25 21:30 America/New_York' where organization_id=$1", [catalogParent.org]);
    expect((await publicRead(c, catalogParent.slug)).verification.verifiedOn).toBe('2026-09-25');
    await c.query('update private.organization_catalog_placements set verified_at=$2 where organization_id=$1', [catalogParent.org, verifiedAt]);
    expect(verified.placement).toEqual({ kind: 'catalog', catalogKey: K9, name: 'Example Council 9', selfReported: true });
    // After undo it is false again and the landing read is self-reported.
    await revokeClaim(c, claim.id, operator);
    expect(await isVerified(bare, catalogParent.org)).toBe(false);
    expect((await publicRead(c, catalogParent.slug)).verification).toEqual({ status: 'self_reported', identity: null, verifiedOn: null });
  });
}, 120_000);

// REQ-UG-RESERVED-LOCAL-WIDE-ORGANIZATION-20261109 (#7671): the
// local-wide organization is requested by a claim on the local's catalog entry
// with a local-wide scope; organizations are still created openly (D2d).
async function fileLocalWide(c, admin, { target, email = CONSUMER_EMAIL, token = hex() } = {}) {
  const result = await svc(c, 'public.submit_local_wide_organization_claim($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)', [
    hex(), hex(), target, json(claimant(email)), json(ATTEST), 'en', token, admin.user, admin.org,
  ]);
  const id = (await c.query('select id from private.organization_claims where confirm_token_hash=$1', [token])).rows[0]?.id ?? null;
  return { result, token, id };
}

live('25. a local-wide request: one chapter until approved, side by side with a second request, official only while approved', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const operator = await verifier(c);
    const addChapter = (org, id) => c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9901)", [id, org]);
    const canAddChapter = async (org) => {
      await c.query('savepoint add_chapter');
      try {
        await addChapter(org, `proof-extra-${randomUUID()}`);
        return true;
      } catch (error) {
        expect(error).toMatchObject({ code: '42501', message: 'local-wide organization not verified', detail: 'local_wide_requested' });
        return false;
      } finally {
        await c.query('rollback to savepoint add_chapter');
        await c.query('release savepoint add_chapter');
      }
    };
    const localWide = async (who) => {
      await as(c, who);
      const read = await getVerification(c, who.org);
      await owner(c);
      return read.localWide ?? null;
    };

    // Filed through the wrapper: the same claim, marked local-wide, never auto-approved by a consumer address.
    const requester = await organization(c, { name: 'Example Workers Local 40' });
    const filed = await fileLocalWide(c, requester, { target: key(40) });
    expect(filed.result).toEqual({ accepted: true, deliver: true });
    expect(await claimRow(c, filed.id)).toMatchObject({ scope: 'local_wide', status: 'awaiting_email', catalog_key: key(40), organization_id: requester.org });
    expect(await localWide(requester)).toBe('requested');
    await confirm(c, filed.token);
    expect(await claimRow(c, filed.id)).toMatchObject({ scope: 'local_wide', status: 'under_review' });

    // One chapter: no further chapter by any writer, nor one moved in from another organization.
    expect(await canAddChapter(requester.org)).toBe(false);
    await as(c, requester);
    await expectRefusal(rpc(c, 'public.create_admin_chapter($1,$2)', [`proof-admin-${randomUUID().slice(0, 8)}`, 'Second chapter']), '42501', 'local-wide organization not verified');
    await owner(c);
    const neighbour = await organization(c, { name: 'Example Workers Local 41' });
    await c.query('savepoint move_chapter');
    // (A chapter's organization is immutable, so none can be moved in either.)
    await expectRefusal(c.query('update public.chapters set organization_id=$1 where id=$2', [requester.org, neighbour.chapter]), '42501', 'chapter organization is immutable');
    await c.query('rollback to savepoint move_chapter');
    await c.query('release savepoint move_chapter');

    // Nor accept another organization's chapter: vouching needs a verified organization.
    await edge(c, key(42), key(40));
    const child = await fileAndConfirm(c, { target: key(42), email: CONSUMER_EMAIL.replace('@', '+42@') });
    await as(c, requester);
    await expectRefusal(vouch(c, requester.org, [child.id]), '42501', 'verified catalog identity required');
    await owner(c);
    // Nor present itself as the local on its landing page.
    expect((await publicRead(c, requester.slug)).verification).toEqual({ status: 'self_reported', identity: null, verifiedOn: null });

    // A second request for the same local stands beside the first; neither overwrites the other.
    const rival = await organization(c, { name: 'Example Workers Local 40 Rival' });
    const second = await fileLocalWide(c, rival, { target: key(40), email: CONSUMER_EMAIL.replace('@', '+rival@') });
    await confirm(c, second.token);
    expect(await claimRow(c, second.id)).toMatchObject({ scope: 'local_wide', status: 'held', hold_reason: 'contested', organization_id: rival.org });
    expect(await claimRow(c, filed.id)).toMatchObject({ scope: 'local_wide', status: 'held', hold_reason: 'contested', organization_id: requester.org });
    const reviewList = await svc(c, 'public.list_organization_claims($1,null,1,$2)', [operator, verifierSession(operator)]);
    expect(reviewList.claims.map((item) => item.claimId ?? item.id)).toEqual(expect.arrayContaining([filed.id, second.id]));

    // Approved: official, chapters allowed, the landing read shows the local.
    await review(c, filed.id, operator, 'approve', { method: 'written_authorization' });
    expect(await claimRow(c, filed.id)).toMatchObject({ scope: 'local_wide', status: 'approved' });
    expect(await localWide(requester)).toBe('official');
    expect(await canAddChapter(requester.org)).toBe(true);
    expect((await publicRead(c, requester.slug)).verification).toMatchObject({ status: 'verified', identity: { catalogKey: key(40) } });
    // The rival's request stays open and restricted.
    expect(await localWide(rival)).toBe('requested');
    expect(await canAddChapter(rival.org)).toBe(false);

    // Undoing verification restores the request's limits.
    await revokeClaim(c, filed.id, operator);
    expect(await localWide(requester)).toBe('requested');
    expect(await canAddChapter(requester.org)).toBe(false);

    // An ordinary claim and an organization with no request keep today's behaviour.
    const ordinary = await file(c, { target: key(43), email: CONSUMER_EMAIL.replace('@', '+43@') });
    expect(await claimRow(c, ordinary.id)).toMatchObject({ scope: 'organization' });
    expect(await localWide(ordinary.admin)).toBeNull();
    expect(await canAddChapter(ordinary.admin.org)).toBe(true);
    expect(await canAddChapter(neighbour.org)).toBe(true);
  });
}, 120_000);

live('26. the local-wide filing wrapper is service-role only and needs a catalog entry and an organization', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const sig = 'public.submit_local_wide_organization_claim(text,text,text,jsonb,jsonb,text,text,uuid,uuid)';
    expect((await c.query(
      `select has_function_privilege('anon',$1,'execute') anon, has_function_privilege('authenticated',$1,'execute') auth,
              has_function_privilege('service_role',$1,'execute') svc`, [sig],
    )).rows[0]).toEqual({ anon: false, auth: false, svc: true });
    for (const fn of ['private.organization_local_wide_requested(uuid)', 'private.organization_local_wide_official(uuid)', 'private.guard_local_wide_requested_chapters()']) {
      expect((await c.query("select has_function_privilege('authenticated',$1,'execute') auth, has_function_privilege('anon',$1,'execute') anon", [fn])).rows[0], fn).toEqual({ auth: false, anon: false });
    }
    const admin = await organization(c, { name: 'Example Workers Local 44' });
    await expectRefusal(svc(c, 'public.submit_local_wide_organization_claim($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)', [hex(), hex(), null, json(claimant(CONSUMER_EMAIL)), json(ATTEST), 'en', hex(), admin.user, admin.org]), '22023');
    await expectRefusal(svc(c, 'public.submit_local_wide_organization_claim($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)', [hex(), hex(), key(44), json(claimant(CONSUMER_EMAIL)), json(ATTEST), 'en', hex(), admin.user, null]), '22023');
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: 'authenticated' })]);
    await expectRefusal(rpc(c, 'public.submit_local_wide_organization_claim($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)', [hex(), hex(), key(44), json(claimant(CONSUMER_EMAIL)), json(ATTEST), 'en', hex(), admin.user, admin.org], 'service_role'), '42501', 'service role required');
    // The schema refuses a local-wide claim with no catalog entry, and an unknown scope.
    await owner(c);
    await c.query('savepoint bad_scope');
    await expectRefusal(insertClaim(c, { unlisted_name: 'Example Unlisted Local', scope: 'local_wide', status: 'expired' }), '23514');
    await c.query('rollback to savepoint bad_scope');
    await expectRefusal(insertClaim(c, { catalog_key: key(44), scope: 'region', status: 'expired' }), '23514');
    await c.query('rollback to savepoint bad_scope');
    await c.query('release savepoint bad_scope');
  });
}, 120_000);

// Early read P1 (addendum of 9:21 AM ET Tue Nov 10): a local-wide request is
// accepted only from an organization holding at most one chapter, refused with
// nothing written otherwise. Early read P2: platform review sees the scope.
live('27. a local-wide request from an organization with more than one chapter is refused, and review shows the scope', async () => {
  await withClient(async (c) => {
    await catalog(c);
    const operator = await verifier(c);
    const crowded = await organization(c, { name: 'Example Workers Local 45' });
    await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9902)", [`proof-second-${randomUUID()}`, crowded.org]);
    const claimsBefore = (await c.query('select count(*)::int n from private.organization_claims')).rows[0].n;
    const token = hex();
    const error = await expectRefusal(svc(c, 'public.submit_local_wide_organization_claim($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)', [
      hex(), hex(), key(45), json(claimant(CONSUMER_EMAIL)), json(ATTEST), 'en', token, crowded.user, crowded.org,
    ]), '42501', 'An organization with more than one chapter cannot request to be the local-wide organization.');
    expect(error.detail).toBe('local_wide_more_than_one_chapter');
    expect((await c.query('select count(*)::int n from private.organization_claims')).rows[0].n).toBe(claimsBefore);
    // Sol final G6-8050-2: someone who does not run the organization learns
    // nothing about its chapters; the refusal is the ordinary one.
    const outsider = await organization(c, { name: 'Example Workers Local 48' });
    const outsiderError = await expectRefusal(svc(c, 'public.submit_local_wide_organization_claim($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)', [
      hex(), hex(), key(45), json(claimant(CONSUMER_EMAIL)), json(ATTEST), 'en', hex(), outsider.user, crowded.org,
    ]), '42501', 'not authorized');
    expect(outsiderError.detail ?? null).not.toBe('local_wide_more_than_one_chapter');
    expect((await c.query('select count(*)::int n from private.organization_claims')).rows[0].n).toBe(claimsBefore);
    // The ordinary claim from the same organization is unchanged.
    const ordinary = await svc(c, 'public.submit_organization_claim($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10)', [
      hex(), hex(), key(45), null, json(claimant(CONSUMER_EMAIL)), json(ATTEST), 'en', hex(), crowded.user, crowded.org,
    ]);
    expect(ordinary).toMatchObject({ accepted: true });

    // One chapter: accepted, and both review reads say which claim is local-wide.
    const single = await organization(c, { name: 'Example Workers Local 46' });
    const filed = await fileLocalWide(c, single, { target: key(46), email: CONSUMER_EMAIL.replace('@', '+46@') });
    expect(filed.result).toEqual({ accepted: true, deliver: true });
    // Sol final G6-8050-1: the admin read names the local a requested
    // organization asked for, so the page can file it again.
    await as(c, single);
    expect(await getVerification(c, single.org)).toMatchObject({ localWide: 'requested', localWideCatalogKey: key(46) });
    await owner(c);
    const listed = await svc(c, 'public.list_organization_claims($1,null,1,$2)', [operator, verifierSession(operator)]);
    const scopes = Object.fromEntries(listed.claims.map((item) => [item.claimId, item.scope]));
    expect(scopes[filed.id]).toBe('local_wide');
    expect(Object.values(scopes).every((scope) => scope === 'local_wide' || scope === 'organization')).toBe(true);
    expect(Object.values(scopes)).toContain('organization');
    const detail = await svc(c, 'public.get_organization_claim($1,$2,$3)', [operator, filed.id, verifierSession(operator)]);
    expect(detail).toMatchObject({ claimId: filed.id, scope: 'local_wide' });
  });
}, 120_000);

// The race: a chapter insert that started before the request, and commits after
// the request began, is counted by the request (the guard locks the
// organization first), so the request is refused instead of showing an
// organization of two chapters as requested. Committed fixtures on two
// connections, removed afterwards.
live('28. a chapter added while a local-wide request is filed is counted, and the request is refused', async () => {
  const connect = async () => {
    const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
    await client.connect();
    return client;
  };
  const [writer, requester, observer] = [await connect(), await connect(), await connect()];
  const org = randomUUID();
  const first = `proof-race-${org}`;
  const second = `proof-race-second-${org}`;
  const admin = randomUUID();
  try {
    await writer.query('insert into public.organizations(id,slug,name) values ($1,$2,$3)', [org, first, `Example Workers Local 47 ${org.slice(0, 8)}`]);
    await writer.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9903)", [first, org]);
    // The requester runs the organization, so the request reaches its count.
    await writer.query('insert into auth.users(id,email) values ($1,$2)', [admin, `fixtureperson.${admin.slice(0, 8)}@members.example`]);
    await writer.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, admin]);
    await writer.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [org, admin]);

    await writer.query('begin');
    await writer.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9904)", [second, org]);
    await requester.query('begin');
    await requester.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: 'service_role' })]);
    const pid = (await requester.query('select pg_backend_pid() pid')).rows[0].pid;
    const filing = requester.query('select public.submit_local_wide_organization_claim($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9) r', [
      hex(), hex(), key(47), json(claimant(CONSUMER_EMAIL)), json(ATTEST), 'en', hex(), admin, org,
    ]).then(() => null, (error) => error);
    for (let tries = 0; tries < 200; tries += 1) {
      if ((await observer.query('select cardinality(pg_blocking_pids($1)) > 0 blocked', [pid])).rows[0].blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await observer.query('select cardinality(pg_blocking_pids($1)) > 0 blocked', [pid])).rows[0].blocked).toBe(true);
    await writer.query('commit');
    const error = await filing;
    expect(error).toMatchObject({ code: '42501', detail: 'local_wide_more_than_one_chapter' });
    await requester.query('rollback');
    expect((await observer.query('select count(*)::int n from private.organization_claims where organization_id=$1', [org])).rows[0].n).toBe(0);
  } finally {
    await writer.query('rollback').catch(() => {});
    await requester.query('rollback').catch(() => {});
    await observer.query('delete from public.organization_role_grants where organization_id=$1', [org]).catch(() => {});
    await observer.query('delete from public.organization_memberships where organization_id=$1', [org]).catch(() => {});
    await observer.query('delete from public.chapters where organization_id=$1', [org]).catch(() => {});
    await observer.query('delete from public.organizations where id=$1', [org]).catch(() => {});
    await observer.query('delete from auth.users where id=$1', [admin]).catch(() => {});
    await Promise.all([writer.end(), requester.end(), observer.end()]);
  }
}, 120_000);
