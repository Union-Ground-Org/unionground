// @vitest-environment node
// REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030: an organization's own blank
// HTML forms stay inside that organization. Members read them, administrators
// import and retire them, and a completed form never becomes a template.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const randomUUID = () => globalThis.crypto.randomUUID();
const ids = Object.fromEntries(['admin', 'member', 'otherAdmin', 'outsider', 'orgA', 'orgB',
  'sessionAdmin', 'sessionMember', 'sessionOther', 'sessionOutsider'].map((key) => [key, randomUUID()]));
const prefix = `ofd${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const BLANK = '<!doctype html><html><head><title>Grievance</title></head><body><label for="name">Name</label><input id="name" value=""></body></html>';
const DIGEST = 'a'.repeat(64);

describe.skipIf(!process.env.SUPABASE_DB_URL)('organization HTML form documents on the complete schema', () => {
  let db;
  const query = async (sql, args = []) => (await db.query(sql, args)).rows;
  const session = { admin: 'sessionAdmin', member: 'sessionMember', otherAdmin: 'sessionOther', outsider: 'sessionOutsider' };
  async function actor(name, aal = 'aal2') {
    await query('reset role');
    await query("select set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub','',true)",
      [JSON.stringify({ sub: ids[name], role: 'authenticated', aal, session_id: ids[session[name]] })]);
    await query('set local role authenticated');
  }
  async function accept(name, title = 'Grievance report', html = BLANK) {
    await actor(name);
    return (await query('select public.accept_organization_form_document($1,null,$2,$3,2,true) result', [title, html, DIGEST]))[0].result;
  }
  async function refuses(sql, args = [], code = '22023') {
    await query('savepoint refusal');
    try { await expect(db.query(sql, args)).rejects.toMatchObject({ code }); }
    finally { await query('rollback to savepoint refusal'); }
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: 'organization-form-documents-proof' });
    await db.connect();
    await query('begin');
    await query("set local statement_timeout='30s'");
    for (const name of ['admin', 'member', 'otherAdmin', 'outsider']) {
      await query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',
        [ids[name], `${prefix}-${name}@example.invalid`, { full_name: `Form document proof ${name}` }]);
    }
    await query('insert into public.organizations(id,slug,name,created_by) values($1,$3,$3,$5),($2,$4,$4,$5)',
      [ids.orgA, ids.orgB, `${prefix}-a`, `${prefix}-b`, ids.admin]);
    const placements = [['admin', 'orgA', 'a', true], ['member', 'orgA', 'a', false], ['otherAdmin', 'orgB', 'b', true]];
    for (const [suffix, org] of [['a', 'orgA'], ['b', 'orgB']]) {
      await query("insert into public.chapters(id,name,slug,region,is_default,order_index,organization_id) values($1,$1,$1,'proof',false,9981,$2)",
        [`${prefix}-${suffix}`, ids[org]]);
    }
    for (const [name, org, suffix, isAdmin] of placements) {
      const chapter = `${prefix}-${suffix}`;
      await query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids[org], ids[name]]);
      await query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ids[name], chapter]);
      await query('update public.member_profiles set chapter_id=$2 where id=$1', [ids[name], chapter]);
      if (isAdmin) {
        await query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [ids[org], ids[name]]);
        await query("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing", [ids[name], chapter]);
        await query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing", [ids[name], chapter]);
      }
    }
    for (const name of ['admin', 'member', 'otherAdmin', 'outsider']) {
      await query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [ids[session[name]], ids[name]]);
      await query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Form document proof','totp','verified',now(),now())",
        [randomUUID(), ids[name]]);
    }
  }, 60000);
  afterAll(async () => { if (db) { await db.query('rollback'); await db.end(); } });
  beforeEach(async () => { await query('savepoint test_case'); });
  afterEach(async () => { await query('rollback to savepoint test_case'); });

  it('starts every organization empty and grants no table access', async () => {
    await actor('member');
    expect((await query('select public.list_organization_form_documents() result'))[0].result).toEqual([]);
    await refuses('select count(*) from private.organization_form_documents', [], '42501');
  });

  it('lets an administrator import a blank form that only its own members read', async () => {
    const saved = await accept('admin');
    expect(saved).toMatchObject({ version: 1 });
    expect(saved.documentSha256).toMatch(/^[0-9a-f]{64}$/);
    await actor('member');
    const listed = (await query('select public.list_organization_form_documents() result'))[0].result;
    expect(listed).toEqual([expect.objectContaining({ id: saved.id, title: 'Grievance report', clearedFieldCount: 2, version: 1 })]);
    expect(listed[0]).not.toHaveProperty('html');
    const opened = (await query('select public.get_organization_form_document($1) result', [saved.id]))[0].result;
    expect(opened.html).toBe(BLANK);
    for (const name of ['otherAdmin', 'outsider']) {
      await actor(name);
      expect((await query('select public.list_organization_form_documents() result'))[0].result).toEqual([]);
      await refuses('select public.get_organization_form_document($1)', [saved.id], 'P0002');
      await refuses('select public.retire_organization_form_document($1)', [saved.id], name === 'otherAdmin' ? 'P0002' : '42501');
    }
  });

  it('refuses members, missing attestation and completed forms', async () => {
    await actor('member');
    await refuses('select public.accept_organization_form_document($1,null,$2,null,0,true)', ['Grievance', BLANK], '42501');
    await actor('admin');
    await refuses('select public.accept_organization_form_document($1,null,$2,null,0,false)', ['Grievance', BLANK]);
    await refuses('select public.accept_organization_form_document($1,null,$2,null,0,true)', ['Grievance', '<p>No fields</p>']);
    await refuses('select public.accept_organization_form_document($1,null,$2,null,0,true)',
      ['Grievance', BLANK.replace('<html>', '<html data-ug-form-instance="completed">')]);
    await refuses('select public.accept_organization_form_document($1,null,$2,null,0,true)',
      ['Grievance', BLANK.replace('</body>', '<script type="application/json" id="ug-saved-signatures">{}</script></body>')]);
  });

  it('versions a same-title import and retires the previous one', async () => {
    const first = await accept('admin');
    const second = await accept('admin', 'grievance REPORT');
    expect(second.version).toBe(2);
    await actor('member');
    const listed = (await query('select public.list_organization_form_documents() result'))[0].result;
    expect(listed.map((row) => row.id)).toEqual([second.id]);
    await refuses('select public.get_organization_form_document($1)', [first.id], 'P0002');
    await actor('admin');
    expect((await query('select public.retire_organization_form_document($1) result', [second.id]))[0].result).toEqual({ id: second.id, active: false });
    await actor('member');
    expect((await query('select public.list_organization_form_documents() result'))[0].result).toEqual([]);
  });

  // PR 6599 review r4428121081: with no selected chapter, the reader resolves
  // the same single organization the administrator writers act on.
  it('lets an administrator with no selected chapter read and retire what they imported', async () => {
    await query('update public.member_profiles set chapter_id=null where id=$1', [ids.admin]);
    const saved = await accept('admin');
    expect((await query('select public.list_organization_form_documents() result'))[0].result.map((row) => row.id)).toEqual([saved.id]);
    expect((await query('select public.get_organization_form_document($1) result', [saved.id]))[0].result.html).toBe(BLANK);
    expect((await query('select public.retire_organization_form_document($1) result', [saved.id]))[0].result).toEqual({ id: saved.id, active: false });
    await actor('otherAdmin');
    expect((await query('select public.list_organization_form_documents() result'))[0].result).toEqual([]);
  });

  it('requires MFA for the administrator writers', async () => {
    await actor('admin', 'aal1');
    await refuses('select public.accept_organization_form_document($1,null,$2,null,0,true)', ['Grievance', BLANK], '42501');
  });

  it('shows no forms to a session without two-step sign-in', async () => {
    await actor('admin');
    const saved = (await query('select public.accept_organization_form_document($1,null,$2,null,0,true) result', ['Grievance', BLANK]))[0].result;
    await actor('admin', 'aal1');
    expect((await query('select public.list_organization_form_documents() result'))[0].result).toEqual([]);
    await refuses('select public.get_organization_form_document($1)', [saved.id], 'P0002');
  });
});
