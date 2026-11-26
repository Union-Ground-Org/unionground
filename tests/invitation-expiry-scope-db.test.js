// @vitest-environment node
// #9273: real authenticated RPCs, disposable database only; every case rolls back.
import assert from 'node:assert/strict';
import { randomUUID as uuid, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, afterEach, describe, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';
import { fnBody, loadMigrationSql, stripComments } from './helpers/migration.js';

const unitMigration = loadMigrationSql('20261113115000_stewards_require_unit_with_carry_over');
const predecessorFunctions = [
  fnBody(unitMigration, 'public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text, p_unit_id uuid)'),
  fnBody(unitMigration, 'public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)'),
  fnBody(loadMigrationSql('20261104111500_learning_period_messages_notices_invites_exports'), 'public.create_roster_member_invitation'),
  fnBody(loadMigrationSql('20261104111500_learning_period_messages_notices_invites_exports'), 'public.create_former_member_invitation'),
  fnBody(loadMigrationSql('20261121035000_member_invitations_own_chapter_allowance'), 'public.create_member_sent_invitation'),
  fnBody(loadMigrationSql('20261118200200_organization_name_phone_rule_dates_and_years'), 'public.create_organization_founder_invitation'),
].map(sql => sql.replace(/^create function/i, 'create or replace function'));

describe('system-expiry migration preserves the newest producer definitions', () => {
  const sql=loadMigrationSql('invitation_expiry_system_maintenance');
  for (const predecessor of predecessorFunctions) {
    const signature=predecessor.match(/function\s+(public\.[^(]+\([^)]*\))/i)[1];
    it(`extracts only expiry maintenance from ${signature}`, () => {
      let expected=predecessor;
      if (expected.includes('  for expired_row in\n')) {
        const start=expected.indexOf('  for expired_row in\n');
        const end=expected.indexOf('  end loop;',start)+'  end loop;'.length;
        expected=expected.slice(0,start)+'  perform private.expire_member_invitation_email(clean_email);'+expected.slice(end);
        expected=expected.replace('  expired_row public.member_invitations%rowtype;\n','');
      }
      const code=value=>stripComments(value).replace(/set search_path\s*(?:to|=)/ig,'set search_path to').replace(/\s+/g,' ').trim().toLowerCase();
      assert.equal(code(fnBody(sql,signature)),code(expected));
    });
  }
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live('expired invitations are system maintenance, not a foreign administrator action', () => {
let db;
const sessions = {};
const O = [uuid(), uuid()];
const C = ['c300-pine', 'c300-elm', 'c300-cedar'];
const U = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid()];
const A = U[0], B = U[2], chapterAdmin = U[4], member = U[1];
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const val = async (sql, args = []) => (await q(sql, args))[0];
async function seed(table, data) {
  assert(/^(public|private)\.[a-z_]+$/.test(table));
  const cols = Object.keys(data);
  await q('savepoint fixture_seed');
  await q('set local session_replication_role=replica');
  try { const result = (await q(`insert into ${table}(${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`, Object.values(data)))[0]; await q('set local session_replication_role=origin'); await q('release savepoint fixture_seed'); return result; }
  catch (error) { await q('rollback to savepoint fixture_seed'); throw error; }
}
async function act(user, sql, args = [], inspect = null, keep = false) {
  await q('savepoint rpc');
  let result;
  try {
    const role = user === 'service_role' ? 'service_role' : 'authenticated';
    const claims = role === 'service_role' ? { role } : { sub:user, role, aal:'aal2', session_id:sessions[user] };
    await q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
    await q(`set local role ${role}`);
    result = { ok: true, value: (await q(`select ${sql} as v`, args))[0].v };
    await q('reset role');
    if (inspect) result.effect = await inspect();
    if (keep) await q('release savepoint rpc'); else await q('rollback to savepoint rpc');
  } catch (error) {
    await q('rollback to savepoint rpc');
    result = { ok: false, code: error.code, message: error.message, detail: error.detail ?? null, hint: error.hint ?? null };
  }
  return result;
}
const invitation = (chapter, email, expired) => seed('public.member_invitations', {
  normalized_email: email, full_name: 'Fictional Invitee', first_name: 'Fictional', initials: 'FI', chapter_id: chapter,
  token_hash: randomBytes(32).toString('hex'), invited_by: B, created_at: new Date(Date.now() - 7200000), expires_at: new Date(Date.now() + (expired ? -3600000 : 3600000)),
});
async function fixtures() {
  await q('begin'); await q("set local statement_timeout='30s'");
  for (let i = 0; i < 2; i++) await q('insert into public.organizations(id,slug,name) values($1,$2,$3)', [O[i], `c300-fictional-${i}`, `Fictional C300 ${i}`]);
  for (let i = 0; i < 3; i++) await q('insert into public.chapters(id,slug,name,region,organization_id,order_index) values($1,$1,$2,$3,$4,$5)', [C[i], `Fictional C300 Chapter ${i}`, 'proof', O[i === 2 ? 1 : 0], 9990 + i]);
  for (let i = 0; i < U.length; i++) {
    const chap = i < 2 || i === 4 ? C[0] : i === 5 ? C[1] : C[2];
    const org = i === 2 || i === 3 ? O[1] : O[0];
    await q('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [U[i], `c300-${i}@example.invalid`]);
    await q('update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1', [U[i], chap, `Fictional C300 Person ${i}`]);
    await q("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active') on conflict do nothing", [org, U[i]]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now()) on conflict do nothing", [U[i], chap]);
    sessions[U[i]] = uuid();
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [sessions[U[i]], U[i]]);
    await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [uuid(), U[i]]);
    if (i === 0 || i === 2 || i === 4) {
      await q("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2)", [U[i], chap]);
      await q("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2)", [U[i], chap]);
    }
    if (i === 0 || i === 2) for (const role of ['admin', 'coordinator', 'vp', 'steward', 'advisor']) await q('insert into public.organization_role_grants(user_id,organization_id,role) values($1,$2,$3)', [U[i], org, role]);
  }
  await q("update auth.users set created_at=now()-interval '30 days' where id=$1",[member]);
  await q("update public.platform_setting_definitions set release_at=null where key='features.member_invitations.enabled'");
  await q("insert into public.organization_setting_values(organization_id,setting_key,value) values($1,'features.member_invitations.enabled','true'::jsonb) on conflict(organization_id,setting_key) do update set value=excluded.value",[O[0]]);
}
beforeAll(async () => {
  db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
  await db.connect();
});
afterAll(async () => { await db?.end(); });
beforeEach(fixtures);
afterEach(async () => { await q('rollback'); });

const calls = [
  ['create_member_invitation/7', "public.create_member_invitation($1,'Fictional Invitee',$2,null,'en',$3,null::uuid)"],
  ['create_member_invitation/6', "public.create_member_invitation($1,'Fictional Invitee',$2,null,'en',$3)"],
  ['create_roster_member_invitation', "public.create_roster_member_invitation($1,'Fictional Invitee',$2,'en',$3)"],
  ['create_former_member_invitation', "public.create_former_member_invitation($1,$2,'en',$3)", A],
  ['create_member_sent_invitation', "public.create_member_sent_invitation($2::uuid,$1,'Fictional Invitee','en',$3)", 'service_role'],
];
async function prepareInvitee(name,email) {
  if (name !== 'create_former_member_invitation') return;
  const id=uuid();
  await q('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,email]);
  await q("update public.member_profiles set chapter_id=null,full_name='Fictional Invitee',first_name='Fictional',initials='FI' where id=$1",[id]);
  await q("insert into public.organization_memberships(organization_id,user_id,status,revoked_at) values($1,$2,'revoked',now()-interval '3 days') on conflict(organization_id,user_id) do update set status='revoked',revoked_at=excluded.revoked_at",[O[0],id]);
}
async function foreignSnapshot() {
  return q(`select 'invitation' kind, to_jsonb(i) value from public.member_invitations i where chapter_id=any($1::text[])
    union all select 'audit',to_jsonb(a) from public.member_invitation_audit a where chapter_id=any($1::text[])
    order by kind,value`, [[C[1], C[2]]]);
}
// Deterministic INSERT fixtures, not response masking: the RPC still has to
// insert its own real row. The same generated-row identity and expiry are used
// in each rolled-back world, and the complete response is compared unchanged.
// No authorization, lookup, cleanup, rate-limit or audit code is replaced.
async function deterministicInvitation() {
  const id = uuid();
  await q(`create function pg_temp.c304_insert_fixture() returns trigger language plpgsql as $fixture$
    begin new.id := current_setting('c304.invitation_id')::uuid;
      new.expires_at := current_setting('c304.invitation_expiry')::timestamptz; return new; end $fixture$`);
  await q("select set_config('c304.invitation_id',$1,true),set_config('c304.invitation_expiry',(now()+interval '7 days')::text,true)", [id]);
  await q('create trigger zzz_c304_insert_fixture before insert on public.member_invitations for each row execute function pg_temp.c304_insert_fixture()');
  return id;
}
async function call(sql, email, actor = chapterAdmin) {
  return act(actor, sql, [email, actor === 'service_role' ? member : C[0], 'bc'.repeat(32)], async () => {
    const row = await val("select to_jsonb(i) row from public.member_invitations i where id=current_setting('c304.invitation_id')::uuid");
    return { inserted: row?.row ?? null, foreign: await foreignSnapshot() };
  });
}
for (const [name, sql, actor = chapterAdmin] of calls) {
  for (const chapter of [C[2], C[1]]) for (const expired of [true, false]) {
    it(`${name}: ${expired ? 'expired' : 'live'} collision in ${chapter} preserves replies and attributes only time-expired cleanup to the system`, async () => {
      const email = `${uuid()}@example.invalid`;
      await prepareInvitee(name,email);
      const row = await invitation(chapter, email, expired);
      const id = await deterministicInvitation();
      const before = await foreignSnapshot();
      const present = await call(sql, email, actor);
      assert(present.ok, JSON.stringify(present));
      if (expired) {
        const expiredRow = present.effect.foreign.find(r => r.kind === 'invitation' && r.value.id === row.id).value;
        const originalRow = before.find(r => r.kind === 'invitation' && r.value.id === row.id).value;
        assert.deepEqual(expiredRow, { ...originalRow, status:'expired', token_hash:null, failure_code:null });
        const addedAudits = present.effect.foreign.filter(r => r.kind === 'audit' && !before.some(b => b.kind === 'audit' && b.value.id === r.value.id));
        assert.equal(addedAudits.length,1);
        assert.equal(addedAudits[0].value.actor,null);
        assert.equal(addedAudits[0].value.chapter_id,chapter);
        assert.equal(addedAudits[0].value.action,'invite_expired');
        assert.deepEqual(addedAudits[0].value.detail,{chapterId:chapter,deliveryVersion:row.delivery_version});
      } else assert.deepEqual(present.effect.foreign, before);
      assert.equal(present.value.send, expired);
      if (expired) {
        assert.equal(present.value.invitationId, id);
        assert.equal(present.effect.inserted.id, id);
        assert.equal(present.effect.inserted.chapter_id, C[0]);
        assert.equal(present.effect.inserted.normalized_email, email);
        const inserted = present.effect.inserted;
        assert.deepEqual(present.value, { accepted:true, send:true, invitationId:inserted.id,
          deliveryVersion:inserted.delivery_version, expiresAt:inserted.expires_at,
          ...(name === 'create_roster_member_invitation' ? {source:'roster'} : {}) });
      } else assert.deepEqual(present.value, { accepted: true, send: false });
      await q('delete from public.member_invitations where id=$1', [row.id]);
      const missing = await call(sql, email, actor);
      assert(missing.ok, JSON.stringify(missing));
      if (expired) assert.deepEqual(present.value, missing.value);
      else assert.equal(missing.value.send, true); // global live-address behavior is deliberately retained
    });
  }
  it(`${name}: own expired cleanup and complete response match the newest Main predecessor`, async () => {
    const email = `${uuid()}@example.invalid`;
    await prepareInvitee(name,email);
    const oldRow = await invitation(C[0], email, true);
    const id = await deterministicInvitation();
    const inspect = async () => ({ old: await val('select to_jsonb(i) row from public.member_invitations i where id=$1', [oldRow.id]) });
    const args = [email,actor === 'service_role' ? member : C[0],'bc'.repeat(32)];
    const fixed = await act(actor, sql, args, inspect);
    assert(fixed.ok, JSON.stringify(fixed));
    assert.equal(fixed.value.invitationId, id);
    assert.equal(fixed.effect.old.row.status, 'expired');
    assert.equal(fixed.effect.old.row.token_hash, null);
    await q('savepoint predecessor');
    // Extract exactly the same predecessor definitions used by the migration;
    // test Main's real bodies, not a reimplementation of the expected behavior.
    for (const definition of predecessorFunctions) await q(definition);
    const original = await act(actor, sql, args, inspect);
    assert(original.ok, JSON.stringify(original));
    assert.deepEqual(fixed.value, original.value);
    await q('rollback to savepoint predecessor');
  });
  it(`${name}: existing own account and own live invitation retain exact no-send replies`, async () => {
    await deterministicInvitation();
    const account = await call(sql, 'c300-1@example.invalid',actor);
    assert(account.ok, JSON.stringify(account));
    assert.deepEqual(account.value, { accepted:true, send:false });
    const email = `${uuid()}@example.invalid`;
    await invitation(C[0],email,false);
    const pending = await call(sql,email,actor);
    assert(pending.ok, JSON.stringify(pending));
    assert.deepEqual(pending.value, { accepted:true, send:false });
  });
}
async function deterministicFounder() {
  await deterministicInvitation();
  const organization=uuid();
  await q("select set_config('c304.organization_id',$1,true)",[organization]);
  await q(`create function pg_temp.c304_organization_fixture() returns trigger language plpgsql as $fixture$
    begin new.id := current_setting('c304.organization_id')::uuid; return new; end $fixture$`);
  await q('create trigger zzz_c304_organization_fixture before insert on public.organizations for each row execute function pg_temp.c304_organization_fixture()');
  await fixtureFounderEntropy();
  return organization;
}
async function fixtureFounderEntropy() {
  // Only the founder routine's random slug suffixes are made deterministic
  // in this transaction. The source-preservation cases above compare the
  // actual migration first. Authorization, input validation, writes, audit
  // and return expressions all remain real, and pgcrypto is never changed.
  // This same fixture is applied to both Main and candidate definitions.
  const { definition } = await val("select pg_get_functiondef('public.create_organization_founder_invitation(text,text,text,text,text,uuid)'::regprocedure) definition");
  const expression='extensions.gen_random_bytes(8)';
  assert.equal(definition.split(expression).length-1,4);
  await q(definition.replaceAll(expression,"pg_catalog.decode(pg_catalog.repeat('ab',8),'hex')"));
}
const founderSql="public.create_organization_founder_invitation('Fictional C304 Founder',$1,'Fictional Founder','en',$2,$3)";
async function founderCall(email,key) {
  return act('service_role',founderSql,[email,'bc'.repeat(32),key],async () => ({
    foreign:await foreignSnapshot(),
    inserted:await val("select to_jsonb(i) row from public.member_invitations i where id=current_setting('c304.invitation_id')::uuid"),
    organization:await val("select to_jsonb(o) row from public.organizations o where id=current_setting('c304.organization_id')::uuid"),
  }));
}
for (const chapter of [C[2],C[1]]) for (const expired of [true,false]) {
  it(`create_organization_founder_invitation: ${expired?'expired':'live'} collision in ${chapter} preserves complete founder reply and system audit`,async () => {
    const email=`${uuid()}@example.invalid`,key=uuid();
    const row=await invitation(chapter,email,expired);
    await deterministicFounder();
    const before=await foreignSnapshot();
    const present=await founderCall(email,key);
    assert(present.ok,JSON.stringify(present));
    if (expired) {
      const changed=present.effect.foreign.find(r=>r.kind==='invitation'&&r.value.id===row.id).value;
      assert.deepEqual(changed,{...before.find(r=>r.kind==='invitation'&&r.value.id===row.id).value,status:'expired',token_hash:null,failure_code:null});
      const audit=present.effect.foreign.filter(r=>r.kind==='audit'&&r.value.invitation_id===row.id);
      assert.equal(audit.length,1);
      assert.deepEqual({actor:audit[0].value.actor,chapter:audit[0].value.chapter_id,action:audit[0].value.action,detail:audit[0].value.detail},
        {actor:null,chapter,action:'invite_expired',detail:{chapterId:chapter,deliveryVersion:row.delivery_version}});
      const inserted=present.effect.inserted.row,organization=present.effect.organization.row;
      assert.deepEqual(present.value,{status:'invited',organizationId:organization.id,chapterId:inserted.chapter_id,slug:organization.slug,
        invitationId:inserted.id,deliveryVersion:inserted.delivery_version,expiresAt:inserted.expires_at,send:true,idempotent:false});
    } else {
      assert.deepEqual(present.value,{status:'email_unavailable'});
      assert.deepEqual(present.effect.foreign,before);
    }
    await q('delete from public.member_invitations where id=$1',[row.id]);
    const missing=await founderCall(email,key);
    assert(missing.ok,JSON.stringify(missing));
    if (expired) assert.deepEqual(present.value,missing.value);
    else assert.equal(missing.value.send,true);
    await q('savepoint predecessor');
    for (const definition of predecessorFunctions) await q(definition);
    await fixtureFounderEntropy();
    const original=await founderCall(email,key);
    assert.deepEqual(missing.value,original.value);
    await q('rollback to savepoint predecessor');
  });
}
it('create_organization_founder_invitation: own expired cleanup preserves the full predecessor reply',async () => {
  const email=`${uuid()}@example.invalid`,key=uuid();
  const own=await invitation(C[0],email,true);
  await deterministicFounder();
  const fixed=await founderCall(email,key);
  assert(fixed.ok,JSON.stringify(fixed));
  assert.equal(fixed.value.send,true);
  await q('savepoint predecessor');
  for (const definition of predecessorFunctions) await q(definition);
  await fixtureFounderEntropy();
  const original=await founderCall(email,key);
  assert.deepEqual(fixed.value,original.value);
  await q('rollback to savepoint predecessor');
  assert.equal((await val('select status from public.member_invitations where id=$1',[own.id])).status,'pending'); // the RPC savepoint rolled back
});
it('the system helper is not callable by anon, authenticated or service_role', async () => {
  for (const role of ['anon','authenticated','service_role']) {
    const row = await val("select has_function_privilege($1,'private.expire_member_invitation_email(text)','execute') allowed",[role]);
    assert.equal(row.allowed,false,role);
  }
});
it('system cleanup is repeatable and never changes a live foreign reservation', async () => {
  const email = `${uuid()}@example.invalid`;
  const expired = await invitation(C[2],email,true);
  const live = await invitation(C[1],`${uuid()}@example.invalid`,false);
  const liveBefore = await val('select to_jsonb(i) row from public.member_invitations i where id=$1',[live.id]);
  await q('select private.expire_member_invitation_email($1)',[email]);
  await q('select private.expire_member_invitation_email($1)',[email]);
  await q('select private.expire_member_invitation_email($1)',[live.normalized_email]);
  const audits = await q('select actor,action,detail from public.member_invitation_audit where invitation_id=$1',[expired.id]);
  assert.deepEqual(audits,[{actor:null,action:'invite_expired',detail:{chapterId:C[2],deliveryVersion:expired.delivery_version}}]);
  assert.deepEqual(await val('select to_jsonb(i) row from public.member_invitations i where id=$1',[live.id]),liveBefore);
});
for (const name of ['begin_google_drive_oauth','begin_organization_calendar_oauth']) {
  it(`${name}: paired own/foreign/missing expiry cleanup compares full responses and foreign rows`, async () => {
    const calendar = name.includes('calendar');
    const table = `private.${calendar ? 'organization_calendar' : 'google_drive'}_oauth_states`;
    const foreignExpired = 'de'.repeat(32), foreignLive = 'df'.repeat(32), ownExpired = 'ed'.repeat(32), ownLive = 'ee'.repeat(32);
    for (const [hash,org,user,expired] of [[foreignExpired,O[1],B,true],[foreignLive,O[1],B,false],[ownExpired,O[0],A,true],[ownLive,O[0],A,false]]) {
      await seed(table,{state_hash:hash,organization_id:org,[calendar?'requested_by':'user_id']:user,code_verifier:'v'.repeat(48),redirect_uri:'https://example.invalid/oauth',expires_at:new Date(Date.now()+(expired?-60000:3600000))});
    }
    const snapshot = () => q(`select to_jsonb(s) row from ${table} s where organization_id=$1 order by state_hash`,[O[1]]);
    const before = await snapshot();
    const sql = `public.${name}($1,$2,'https://example.invalid/oauth',now()+interval '5 minutes')`;
    const args = ['ef'.repeat(32),'v'.repeat(48)];
    const inspect = async () => ({ foreign:await snapshot(),own:(await q(`select state_hash from ${table} where organization_id=$1 order by state_hash`,[O[0]])).map(r=>r.state_hash) });
    const present = await act(A,sql,args,inspect);
    assert(present.ok,JSON.stringify(present));
    assert.deepEqual(present.value,{organizationId:O[0],status:'requested'});
    // Reviewed system maintenance: these OAuth tables have no audit writer,
    // and only dead states are removed. No OAuth product function changes.
    assert.deepEqual(present.effect.foreign,before.filter(r => r.row.state_hash !== foreignExpired));
    assert.deepEqual(present.effect.own,[ownLive,args[0]].sort());
    await q(`delete from ${table} where organization_id=$1`,[O[1]]);
    const absent = await act(A,sql,args,inspect);
    assert.deepEqual(present.value,absent.value);
    assert.deepEqual(present.effect.own,absent.effect.own);
    await q('savepoint predecessor');
    for (const definition of predecessorFunctions) await q(definition);
    const original = await act(A,sql,args,inspect);
    assert.deepEqual(absent.value,original.value);
    assert.deepEqual(absent.effect.own,original.effect.own);
    await q('rollback to savepoint predecessor');
  });
}
});
