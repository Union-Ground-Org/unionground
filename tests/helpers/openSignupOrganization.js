// Shared synthetic fixtures for the required open-signup boundary proofs.
// A disposable loopback URL is checked before every database connection.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect } from 'vitest';
import { assertDisposableProofUrl } from '../../scripts/run-required-db-proofs.mjs';
import { insertSignupCoverageLease, insertSignupRecoveryCheck } from './signupRecovery.js';
export { assertDisposableProofUrl, insertSignupCoverageLease, insertSignupRecoveryCheck };


export const SHELL_EVENT = 'organization_self_created';

export const VERIFICATION = 'organization verification required';

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export const userScope = (userId) => sha256(`open-signup-user:${userId}`);

// Letters only, so a fixture name never trips the phone-length digit rule.
export const tag = () => randomUUID().slice(0, 8).replace(/[0-9]/g, (d) => 'ghijklmnop'[d]);


export const openPeriod = (c, opensAt = 'now()') => c.query(
  `insert into private.open_signup_period(singleton,opens_at) values (true,${opensAt})
   on conflict (singleton) do update set opens_at = excluded.opens_at, updated_at = now()`);


export async function withClient(run, { periodOpen = true } = {}) {
  const c = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    application_name: 'open-signup-organization-rollback-proof',
  });
  await c.connect();
  await c.query("set statement_timeout = '20s'");
  await c.query('begin');
  try {
    await insertSignupRecoveryCheck(c);
    await insertSignupCoverageLease(c);
    if (periodOpen) await openPeriod(c);
    await run(c);
  } finally {
    await c.query('rollback');
    await c.end();
  }
}


// A confirmed account with a live session. `factor` adds a verified TOTP
// factor; the session is aal2 only when asked.
export async function account(c, { confirmed = true, factor = false, aal = 'aal1' } = {}) {
  const user = randomUUID();
  await c.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,$3)', [
    user, `${user}@example.invalid`, confirmed ? new Date() : null,
  ]);
  if (factor) {
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user]);
  }
  return session(c, { user }, aal);
}


export async function session(c, who, aal) {
  const id = randomUUID();
  await c.query('insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,$3,now(),now())', [id, who.user, aal]);
  return { ...who, session: id, aal };
}


export async function as(c, who) {
  await c.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ sub: who.user, session_id: who.session, role: 'authenticated', aal: who.aal }),
  ]);
}


export async function asServiceRole(c) {
  await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: 'service_role' })]);
}


// Runs one statement as `role` inside a savepoint, so a refusal leaves the
// outer transaction usable. Resolves to the first column of the first row.
export async function rpc(c, sql, params = [], role = 'authenticated') {
  await c.query('savepoint rpc_call');
  try {
    await c.query(`set local role ${role}`);
    const result = (await c.query(`select ${sql} as r`, params)).rows[0]?.r;
    await c.query('reset role');
    await c.query('release savepoint rpc_call');
    return result;
  } catch (error) {
    await c.query('rollback to savepoint rpc_call');
    await c.query('release savepoint rpc_call');
    throw error;
  }
}


// An owner statement inside a savepoint.
export async function owner(c, sql, params = []) {
  await c.query('savepoint owner_call');
  try {
    const result = await c.query(sql, params);
    await c.query('release savepoint owner_call');
    return result;
  } catch (error) {
    await c.query('rollback to savepoint owner_call');
    await c.query('release savepoint owner_call');
    throw error;
  }
}


export async function expectRefusal(promise, code, message) {
  const error = await promise.then(() => null, (e) => e);
  expect(error, `expected ${code} ${message ?? ''}`).not.toBeNull();
  expect(error.code).toBe(code);
  if (message) expect(error.message).toBe(message);
  return error;
}


export const createOrg = (c, name, key = randomUUID()) =>
  rpc(c, 'public.create_my_organization($1,$2)', [name, key]);

// Code points by number, so no invisible character sits in this source file.
export const cp = (...points) => String.fromCodePoint(...points);


// "Example Workers Local 1": created through the RPC by a no-factor aal1
// account, then the admin enrolls a factor and signs in at aal2 (staff tools
// need a second factor while require_staff_mfa is true).
export async function unverifiedOrg(c, name = `Example Workers Local 1 ${tag()}`) {
  const creator = await account(c);
  await as(c, creator);
  const created = await createOrg(c, name);
  expect(created.status).toBe('created');
  await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), creator.user]);
  const admin = await session(c, { user: creator.user }, 'aal2');
  return { org: created.organizationId, chapter: created.chapterId, slug: created.slug, name, admin };
}


// An operator-provisioned organization (self_serve_created_at null), with an
// admin at aal2.
export async function verifiedOrg(c, name = `Example Transit Local 2 ${tag()}`) {
  const org = randomUUID();
  const chapter = `etl2-${org.slice(0, 8)}`;
  await c.query("insert into public.organizations(id,slug,name,status) values ($1,$2,$3,'active')", [org, chapter, name]);
  await c.query('insert into public.org_security_policy(id,organization_id,require_staff_mfa) values (true,$1,true)', [org]);
  await c.query("insert into public.chapters(id,name,slug,region,is_default,organization_id,order_index) values ($1,$1,$1,null,true,$2,1)", [chapter, org]);
  const admin = await member(c, { org, chapter, role: 'admin' });
  return { org, chapter, name, admin };
}


export async function member(c, { org, chapter, role = null, factor = true }) {
  const who = await account(c, { factor, aal: factor ? 'aal2' : 'aal1' });
  await c.query('update public.member_profiles set chapter_id=$2 where id=$1', [who.user, chapter]);
  await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, who.user]);
  await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,last_selected_at) values ($1,$2,'active',now()) on conflict do nothing", [who.user, chapter]);
  if (role) await c.query('insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,$3)', [org, who.user, role]);
  return who;
}


export async function unionOrg(c, n) {
  const id = `olms-9000000${String(n).padStart(2, '0')}`;
  await c.query(
    `insert into public.union_orgs(id,olms_file_number,name,level,enrichment_status,atlas_manifest_sha)
     values ($1,$2,$3,'local','no_web_presence',repeat('0',64)) on conflict (id) do nothing`,
    [id, 900000000 + n, `Example Registry Local ${n}`],
  );
  return id;
}


export const setVerified = (c, org, verified) =>
  c.query('update public.organizations set verified_at = $2 where id = $1', [org, verified ? new Date() : null]);


export async function shellCounts(c, org, user) {
  return (await c.query(
    `select (select count(*)::int from public.organizations where id = $1) as organizations,
            (select count(*)::int from public.org_security_policy where organization_id = $1) as security_policy,
            (select count(*)::int from public.chapters where organization_id = $1) as chapters,
            (select count(*)::int from public.organization_memberships where organization_id = $1) as memberships,
            (select count(*)::int from public.organization_role_grants where organization_id = $1) as role_grants,
            (select count(*)::int from public.member_chapter_memberships m join public.chapters ch on ch.id = m.chapter_id where ch.organization_id = $1) as chapter_memberships,
            (select count(*)::int from public.member_profiles p join public.chapters ch on ch.id = p.chapter_id where ch.organization_id = $1 and p.id = $2) as profiles,
            (select count(*)::int from public.organization_audit_ledger where organization_id = $1 and event_type = '${SHELL_EVENT}') as ledger`,
    [org, user],
  )).rows[0];
}


export async function limiterRows(c, scope) {
  return (await c.query('select operation, request_count from private.open_signup_limits where scope_hash = $1 order by operation', [scope])).rows;
}


// Admission rows are seeded only by the disposable owner, never by a client.
export async function seedAdmissions(c, count, age = '1 hour') {
  return c.query(`insert into private.open_signup_cohort_admissions(organization_id, admitted_at)
    select extensions.gen_random_uuid(), clock_timestamp() - $2::interval from generate_series(1,$1)`, [count, age]);
}


export async function onboardedPartner(c, n) {
  const partner = await verifiedOrg(c);
  const key = await unionOrg(c, n);
  await c.query("insert into public.chapter_union_org_bindings(chapter_id,union_org_id,status,verified_at) values ($1,$2,'verified',now())", [partner.chapter, key]);
  return { ...partner, key };
}


export const createRecord = (c, kind, partner = null) =>
  rpc(c, 'public.create_organization_coordination_record($1,$2,$3,$4,$5,$6,$7,$8,$9)', [kind, `Example ${kind}`, '', 'staff', partner, null, null, {}, randomUUID()]);


export const invite = (c, record, org) =>
  rpc(c, 'public.invite_organization_coordination_participant($1,$2,$3,$4)', [record, org, 'member', randomUUID()]);


export async function activeNetwork(c, a, b) {
  const record = randomUUID();
  await c.query(
    `insert into public.organization_coordination_records(id,organization_id,partner_organization_id,kind,title,summary,status,visibility,config,created_by,idempotency_key)
     values ($1,$2,$3,'network_link','Example network','','active','staff','{}',$4,$5)`,
    [record, a.org, b.org, a.admin.user, randomUUID()],
  );
  await c.query(
    `insert into public.organization_coordination_organization_participants(record_id,organization_id,role,status)
     values ($1,$2,'owner','active'), ($1,$3,'partner','active')
     on conflict (record_id,organization_id) do update set status='active'`,
    [record, a.org, b.org],
  );
  return record;
}


export const publish = (c, chapter) =>
  rpc(c, 'public.upsert_public_chapter_profile($1,$2,$3,$4,$5,$6,$7,$8)', [chapter, 'Example chapter', 'Capítulo de ejemplo', 'Example body', 'Cuerpo de ejemplo', true, null, true]);


export async function seedInvitations(c, chapter, count, age) {
  await c.query(
    `insert into public.member_invitations(normalized_email,full_name,first_name,initials,chapter_id,locale,status,created_at,expires_at,revoked_at)
     select 'seed-' || g || '-' || $1 || '@example.invalid', 'Example Invitee', 'Example', 'EI', $2, 'en', 'revoked', now() - $3::interval, now() - $3::interval + interval '15 minutes', now()
     from generate_series(1, $4) g`,
    [tag(), chapter, age, count],
  );
}


// Phase 3a (20260930040000) claim helpers for cases 30 and 31: a service-role
// call as #3415's own proof makes it (the claims say service_role for the call
// and are restored afterwards), a fixture platform verifier, and an unlisted
// claim filed by the shell's admin and confirmed, which leaves it under review.
export async function svc(c, sql, params = []) {
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


export async function platformVerifier(c) {
  const verifier = await account(c, { factor: true, aal: 'aal2' });
  await svc(c, 'public.set_platform_operator($1,$2,$3,$4)', [verifier.user, true, 'Fixture verifier', randomUUID()]);
  return verifier;
}


export const CLAIM_ATTEST = { version: 'claim-attest/1', officer: true, verifyFirst: true, noPersonalData: true, notEmployer: true };


export async function claimUnderReview(c, shell) {
  const token = sha256(`claim-token-${randomUUID()}`);
  const submitted = await svc(c, 'public.submit_organization_claim($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10)', [
    sha256(`claim-net-${randomUUID()}`), sha256(`claim-email-${randomUUID()}`), null,
    JSON.stringify({ name: `Example Unlisted Council ${tag()}`, state: 'OR' }),
    JSON.stringify({ name: 'Alex Fixtureperson', title: 'Secretary-Treasurer', email: `officer-${tag()}@example.invalid`, statement: '' }),
    JSON.stringify(CLAIM_ATTEST), 'en', token, shell.admin.user, shell.org,
  ]);
  expect(submitted).toEqual({ accepted: true, deliver: true });
  const id = (await c.query('select id from private.organization_claims where confirm_token_hash = $1', [token])).rows[0].id;
  await svc(c, 'public.confirm_organization_claim($1,$2)', [token, sha256(`claim-confirm-${randomUUID()}`)]);
  expect((await c.query('select status from private.organization_claims where id = $1', [id])).rows[0].status).toBe('under_review');
  return id;
}


export const clears = async (c, org) =>
  (await c.query('select private.organization_clears_signup_boundary($1) as v', [org])).rows[0].v;

export const claimVerified = async (c, org) =>
  (await c.query('select private.organization_is_verified($1) as v', [org])).rows[0].v;


// Chapter connection registry (20260928103000 and later): a synthetic profile
// with no analyzed issues shared.
export const CONNECTION_PROFILE = {
  location: { country: 'US', state: 'MA', metro: 'Boston' },
  sectorKeys: ['healthcare'], expertiseOffered: ['staffing'], declaredIssueKeys: ['staffing'], shareAnalyzedIssues: false,
};

export const saveConnectionProfile = (c, chapter, publish) =>
  rpc(c, 'public.save_chapter_connection_profile($1,$2,$3,$4)', ['admin', chapter, CONNECTION_PROFILE, publish]);

export const hideChapter = (c, chapter, target) =>
  rpc(c, 'public.set_chapter_connection_hidden($1,$2,$3,$4)', ['admin', chapter, target, true]);

export const connectionStatus = async (c, chapter) => (await c.query(
  'select publication_status from private.chapter_connection_profiles where chapter_id = $1', [chapter])).rows[0]?.publication_status ?? null;
