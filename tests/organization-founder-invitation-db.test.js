// @vitest-environment node
// Operator founder invitations (20261003010000_organization_founder_invitations.sql).
//
// Synthetic fixtures only: organization names start "Example Founder Union",
// addresses are @example.invalid. SQL cases roll back; the HTTP delivery case
// removes its committed fixture. Acceptance follows api/accept-invitation.js step by step:
// claim, invitation-owned banned account, finalize, activate, complete.
// Each refusal case carries a control that must still succeed.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { assertDisposableProofUrl, assertDisposableStorageStatus } from '../scripts/run-required-db-proofs.mjs';
import { sendInvitationEmail } from '../api/_lib/memberInvitations.js';

const live = process.env.RUN_ORGANIZATION_FOUNDER_INVITATION_DB_TESTS === '1' ? it : it.skip;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
// Letters only, so a fixture name never trips the phone-length digit rule.
const tag = () => randomUUID().slice(0, 8).replace(/[0-9]/g, (d) => 'ghijklmnop'[d]);
const address = () => `founder-${randomUUID()}@example.invalid`;

async function withClient(run) {
  const c = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    application_name: 'organization-founder-invitation-rollback-proof',
  });
  await c.connect();
  await c.query("set statement_timeout = '20s'");
  await c.query('begin');
  try {
    await run(c);
  } finally {
    await c.query('rollback');
    await c.end();
  }
}

// Runs one statement as `role` inside a savepoint, so a refusal leaves the
// outer transaction usable. Resolves to the first column of the first row.
async function call(c, sql, params = [], role = 'service_role') {
  await c.query('savepoint rpc_call');
  try {
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify(role === 'service_role' ? { role: 'service_role' } : { sub: randomUUID(), role }),
    ]);
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

async function expectRefusal(promise, code, message) {
  const error = await promise.then(() => null, (e) => e);
  expect(error, `expected ${code} ${message ?? ''}`).not.toBeNull();
  expect(error.code).toBe(code);
  if (message) expect(error.message).toBe(message);
}

const invite = (c, { name = `Example Founder Union ${tag()}`, email = address(), fullName = 'Example Founder', locale = 'en', secret = randomUUID(), key = randomUUID() } = {}) =>
  call(c, 'public.create_organization_founder_invitation($1,$2,$3,$4,$5,$6)', [name, email, fullName, locale, sha256(secret), key])
    .then((result) => ({ result, name, email, secret, key }));

// The acceptance endpoint's database steps for a provision-path invitation.
async function accept(c, secret) {
  const claim = await call(c, 'public.claim_member_invitation($1)', [sha256(secret)]);
  expect(claim).toMatchObject({ available: true, recovery: false, kind: 'founder' });
  const invitation = (await c.query('select * from public.member_invitations where id = $1', [claim.invitationId])).rows[0];
  const user = randomUUID();
  await c.query(
    `insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data,raw_app_meta_data,banned_until)
     values ($1,$2,now(),$3,$4,now() + interval '100 years')`,
    [user, invitation.normalized_email,
      JSON.stringify({ full_name: invitation.full_name, first_name: invitation.first_name, initials: invitation.initials,
        chapter_id: invitation.chapter_id, union_base_invitation_id: invitation.id }),
      JSON.stringify({ union_ground_provisioning: 'pending' })],
  );
  await call(c, 'public.finalize_member_invitation($1,$2)', [invitation.id, user]);
  await c.query(
    `update auth.users set raw_app_meta_data = '{"union_ground_provisioning":"active"}', banned_until = null where id = $1`,
    [user],
  );
  await call(c, 'public.complete_member_invitation_activation($1,$2)', [invitation.id, user]);
  return { user, invitation };
}

const adminGrants = async (c, org) => (await c.query(
  "select user_id from public.organization_role_grants where organization_id = $1 and role = 'admin'", [org],
)).rows.map((row) => row.user_id);

const deliveryProjection = async (c, id) => (await c.query(
  "select jsonb_build_object('id',id,'status',status,'expiresAt',expires_at,'sentAt',sent_at) as value from public.member_invitations where id=$1", [id],
)).rows[0].value;

live('delivers a founder email using the real service-role organization-name lookup', async () => {
  const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const status = assertDisposableStorageStatus(
    JSON.parse(readFileSync(process.env.PRIVATE_FILE_STORAGE_STATUS_FILE, 'utf8')), connectionString,
  );
  const c = new pg.Client({ connectionString });
  const organizationId = randomUUID(), name = `Example Founder Union ${tag()}`;
  const nativeFetch = globalThis.fetch;
  const delivered = [];
  await c.connect();
  try {
    await c.query("set statement_timeout = '20s'");
    // HTTP uses a different connection: this exact disposable fixture must commit.
    await c.query('insert into public.organizations(id,slug,name) values ($1,$2,$3)',
      [organizationId, `founder-${organizationId}`, name]);
    vi.stubGlobal('fetch', async (input, options) => {
      const url = new URL(String(input));
      if (url.href === 'https://api.resend.com/emails') {
        delivered.push(JSON.parse(options.body));
        return new Response('{"id":"local-mail-receipt"}', { status: 200 });
      }
      if (url.origin !== new URL(status.API_URL).origin) throw new Error('unexpected-external-request');
      return nativeFetch(input, options);
    });
    expect(await sendInvitationEmail({
      resendKey: 'local-proof-only', from: 'local@example.invalid', to: address(), locale: 'en',
      link: 'http://localhost/app/invite#invite=local-proof', invitationId: randomUUID(), deliveryVersion: 1,
      names: { source: 'founder' },
      organizationLookup: { supabaseUrl: status.API_URL, serviceKey: status.SERVICE_ROLE_KEY, organizationId },
    })).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].subject).toContain(name);
    expect(delivered[0].text).toContain(name);
    const unrelatedColumn = await nativeFetch(`${status.API_URL}/rest/v1/organizations?select=status&id=eq.${organizationId}`, {
      headers: { apikey: status.SERVICE_ROLE_KEY, Authorization: `Bearer ${status.SERVICE_ROLE_KEY}` },
    });
    expect(unrelatedColumn.status).toBe(200);
    expect(await unrelatedColumn.json()).toEqual([{ status: 'active' }]);
    const anonymous = await nativeFetch(`${status.API_URL}/rest/v1/organizations?select=name&id=eq.${organizationId}`, {
      headers: { apikey: status.ANON_KEY, Authorization: `Bearer ${status.ANON_KEY}` },
    });
    expect(anonymous.ok).toBe(false);
    expect((await anonymous.json()).code).toBe('42501');
    expect((await c.query("select relrowsecurity from pg_class where oid='public.organizations'::regclass")).rows[0].relrowsecurity).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    try { await c.query('delete from public.organizations where id=$1', [organizationId]); }
    finally { await c.end(); }
  }
});

live('creates an operator-provisioned organization, its default chapter and one founder invitation, and nothing else', async () => {
  await withClient(async (c) => {
    const { result, name, email, key } = await invite(c, { locale: 'es' });
    expect(result).toMatchObject({ status: 'invited', send: true, idempotent: false, deliveryVersion: 1 });

    const org = (await c.query('select * from public.organizations where id = $1', [result.organizationId])).rows[0];
    expect(org).toMatchObject({ name, status: 'active', created_by: null, self_serve_created_at: null });
    expect(org.slug).toMatch(/^u-[0-9a-f]{10}$/);
    const policy = (await c.query('select require_staff_mfa from public.org_security_policy where organization_id = $1', [org.id])).rows;
    expect(policy).toEqual([{ require_staff_mfa: true }]);
    const chapters = (await c.query('select id, name, is_default from public.chapters where organization_id = $1', [org.id])).rows;
    expect(chapters).toEqual([{ id: result.chapterId, name, is_default: true }]);

    const invitations = (await c.query('select * from public.member_invitations where chapter_id = $1', [result.chapterId])).rows;
    expect(invitations).toHaveLength(1);
    expect(invitations[0]).toMatchObject({
      id: result.invitationId, kind: 'founder', invited_by: null, initial_role: null,
      normalized_email: email, locale: 'es', status: 'pending', delivery_version: 1,
    });
    expect(invitations[0].expires_at.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);

    const ledger = (await c.query('select event_type, actor_user_id, metadata from public.organization_audit_ledger where idempotency_key = $1', [key])).rows;
    expect(ledger).toEqual([{
      event_type: 'organization_founder_invited', actor_user_id: null,
      metadata: { organizationId: org.id, chapterId: result.chapterId, entityType: 'invitation', entityId: result.invitationId, status: 'invited' },
    }]);
    expect(JSON.stringify(ledger)).not.toContain(email);
    const audit = (await c.query('select action, actor from public.member_invitation_audit where invitation_id = $1', [result.invitationId])).rows;
    expect(audit).toEqual([{ action: 'invite_requested', actor: null }]);

    // Nothing exists for a person yet: no membership, no role, no account.
    expect(await adminGrants(c, org.id)).toEqual([]);
    const members = (await c.query('select count(*)::int as n from public.organization_memberships where organization_id = $1', [org.id])).rows[0].n;
    expect(members).toBe(0);
  });
});

live('replays the same key without creating anything, and refuses a key used for another event', async () => {
  await withClient(async (c) => {
    const first = await invite(c);
    const again = await call(c, 'public.create_organization_founder_invitation($1,$2,$3,$4,$5,$6)',
      [first.name, first.email, 'Example Founder', 'en', sha256(first.secret), first.key]);
    expect(again).toMatchObject({ status: 'invited', send: false, idempotent: true,
      organizationId: first.result.organizationId, invitationId: first.result.invitationId });
    const count = (await c.query('select count(*)::int as n from public.organizations where name = $1', [first.name])).rows[0].n;
    expect(count).toBe(1);

    const otherEventKey = randomUUID();
    await c.query(
      `insert into public.organization_audit_ledger(organization_id,domain,event_type,action,entity_type,entity_id,idempotency_key)
       values ($1,'administration','organization_founder_probe','update','organization',$2,$3)`,
      [first.result.organizationId, first.result.organizationId, otherEventKey],
    );
    await expectRefusal(invite(c, { key: otherEventKey }), '22023', 'idempotency key reused');
  });
});

live('answers name_unavailable and email_unavailable without creating anything', async () => {
  await withClient(async (c) => {
    const first = await invite(c);
    const before = (await c.query('select count(*)::int as n from public.organizations')).rows[0].n;

    const sameName = await invite(c, { name: first.name.toUpperCase() });
    expect(sameName.result).toEqual({ status: 'name_unavailable' });

    const liveInvitation = await invite(c, { email: first.email });
    expect(liveInvitation.result).toEqual({ status: 'email_unavailable' });

    const existing = randomUUID();
    const existingEmail = address();
    await c.query('insert into auth.users(id,email) values ($1,$2)', [existing, existingEmail]);
    const accountTaken = await invite(c, { email: existingEmail.toUpperCase() });
    expect(accountTaken.result).toEqual({ status: 'email_unavailable' });

    expect((await c.query('select count(*)::int as n from public.organizations')).rows[0].n).toBe(before);
    // Control: a fresh name and address still work.
    expect((await invite(c)).result.status).toBe('invited');
  });
});

live('expires a stale pending invitation for the address first, so the founder invitation still starts', async () => {
  await withClient(async (c) => {
    const first = await invite(c);
    await c.query("update public.member_invitations set expires_at = now() - interval '1 minute' where id = $1", [first.result.invitationId]);
    const second = await invite(c, { email: first.email });
    expect(second.result.status).toBe('invited');
    const stale = (await c.query('select status, token_hash from public.member_invitations where id = $1', [first.result.invitationId])).rows[0];
    expect(stale).toEqual({ status: 'expired', token_hash: null });
    const actions = (await c.query('select action, actor from public.member_invitation_audit where invitation_id = $1', [first.result.invitationId])).rows;
    expect(actions).toEqual(expect.arrayContaining([{ action: 'invite_expired', actor: null }]));
    // Control: a live invitation for the address still refuses.
    expect((await invite(c, { email: first.email })).result).toEqual({ status: 'email_unavailable' });
  });
});

live('refuses malformed input and every client role', async () => {
  await withClient(async (c) => {
    for (const bad of [
      { name: 'x' },
      { name: 'Example 1234567 Union' },
      { name: 'Example Union @ home' },
      { email: 'not-an-address' },
      { fullName: 'x' },
      { locale: 'fr' },
    ]) {
      await expectRefusal(invite(c, bad), '22023', 'invalid founder invitation');
    }
    await expectRefusal(call(c, 'public.create_organization_founder_invitation($1,$2,$3,$4,$5,$6)',
      [`Example Founder Union ${tag()}`, address(), 'Example Founder', 'en', 'abc', randomUUID()]), '22023', 'invalid founder invitation');
    for (const role of ['authenticated', 'anon']) {
      await expectRefusal(call(c, 'public.create_organization_founder_invitation($1,$2,$3,$4,$5,$6)',
        [`Example Founder Union ${tag()}`, address(), 'Example Founder', 'en', sha256('s'), randomUUID()], role), '42501');
      await expectRefusal(call(c, 'public.resend_organization_founder_invitation($1,$2)', [randomUUID(), sha256('s')], role), '42501');
      await expectRefusal(call(c, 'public.record_organization_founder_invitation_delivery($1,1,$2)', [randomUUID(), 'sent'], role), '42501');
    }
    expect((await invite(c)).result.status).toBe('invited');
  });
});

live('acceptance makes the founder an active member and the organization administrator, in the same transaction', async () => {
  await withClient(async (c) => {
    const { result, secret } = await invite(c);
    await call(c, 'public.record_organization_founder_invitation_delivery($1,$2,$3)', [result.invitationId, 1, 'sent']);
    const { user } = await accept(c, secret);

    const invitation = (await c.query('select status, auth_user_id from public.member_invitations where id = $1', [result.invitationId])).rows[0];
    expect(invitation).toEqual({ status: 'accepted', auth_user_id: user });
    expect(await adminGrants(c, result.organizationId)).toEqual([user]);
    const membership = (await c.query(
      "select status from public.organization_memberships where organization_id = $1 and user_id = $2", [result.organizationId, user],
    )).rows;
    expect(membership).toEqual([{ status: 'active' }]);
    const chapter = (await c.query('select chapter_id from public.member_profiles where id = $1', [user])).rows[0].chapter_id;
    expect(chapter).toBe(result.chapterId);
    const granted = (await c.query(
      "select actor_user_id, action, entity_type, metadata from public.organization_audit_ledger where organization_id = $1 and event_type = 'organization_founder_admin_granted'",
      [result.organizationId],
    )).rows;
    expect(granted).toEqual([{ actor_user_id: user, action: 'grant', entity_type: 'role_grant', metadata: {
      organizationId: result.organizationId, chapterId: result.chapterId, userId: user, role: 'admin',
      entityType: 'invitation', entityId: result.invitationId,
    } }]);
  });
});

live('a founder-kind row resent by a chapter admin grants no administrator role on acceptance', async () => {
  await withClient(async (c) => {
    const { result, secret } = await invite(c);
    const admin = randomUUID();
    await c.query('insert into auth.users(id,email) values ($1,$2)', [admin, address()]);
    await c.query('update public.member_invitations set invited_by = $2 where id = $1', [result.invitationId, admin]);
    const { user } = await accept(c, secret);
    expect(await adminGrants(c, result.organizationId)).toEqual([]);
    const membership = (await c.query(
      'select status from public.organization_memberships where organization_id = $1 and user_id = $2', [result.organizationId, user],
    )).rows;
    expect(membership).toEqual([{ status: 'active' }]);
  });
});

live('records delivery only for the current version of a pending operator founder invitation', async () => {
  await withClient(async (c) => {
    const { result } = await invite(c);
    expect(await call(c, 'public.record_organization_founder_invitation_delivery($1,$2,$3)', [result.invitationId, 2, 'sent'])).toEqual({ recorded: false });
    await expectRefusal(call(c, 'public.record_organization_founder_invitation_delivery($1,$2,$3)', [result.invitationId, 1, 'bounced']), '22023', 'invalid delivery outcome');
    expect(await call(c, 'public.record_organization_founder_invitation_delivery($1,$2,$3)', [result.invitationId, 1, 'sent']))
      .toEqual({ recorded: true, invitation: await deliveryProjection(c, result.invitationId) });
    const sent = (await c.query('select status, sent_at from public.member_invitations where id = $1', [result.invitationId])).rows[0];
    expect(sent.status).toBe('pending');
    expect(sent.sent_at).not.toBeNull();

    const failed = await invite(c);
    expect(await call(c, 'public.record_organization_founder_invitation_delivery($1,$2,$3)', [failed.result.invitationId, 1, 'failed']))
      .toEqual({ recorded: true, invitation: await deliveryProjection(c, failed.result.invitationId) });
    const row = (await c.query('select status, token_hash, failure_code from public.member_invitations where id = $1', [failed.result.invitationId])).rows[0];
    expect(row).toEqual({ status: 'delivery_failed', token_hash: null, failure_code: 'provider_unavailable' });

    // A chapter admin's ordinary invitation is out of reach of this twin.
    await c.query("update public.member_invitations set kind = 'provision' where id = $1", [failed.result.invitationId]);
    expect(await call(c, 'public.record_organization_founder_invitation_delivery($1,$2,$3)', [failed.result.invitationId, 1, 'sent'])).toEqual({ recorded: false });
  });
});

live('resends an expired founder invitation as the next version, and refuses once the organization has an administrator', async () => {
  await withClient(async (c) => {
    const { result } = await invite(c);
    await c.query("update public.member_invitations set expires_at = now() - interval '1 minute' where id = $1", [result.invitationId]);
    const secret = randomUUID();
    const resent = await call(c, 'public.resend_organization_founder_invitation($1,$2)', [result.invitationId, sha256(secret)]);
    expect(resent).toMatchObject({ status: 'invited', send: true, deliveryVersion: 2, organizationId: result.organizationId });
    const rows = (await c.query(
      'select id, status, kind, invited_by, replaces_id, token_hash from public.member_invitations where chapter_id = $1 order by delivery_version',
      [result.chapterId],
    )).rows;
    expect(rows.map((r) => [r.status, r.kind, r.invited_by])).toEqual([['superseded', 'founder', null], ['pending', 'founder', null]]);
    expect(rows[0].token_hash).toBeNull();
    expect(rows[1].replaces_id).toBe(result.invitationId);

    const { user } = await accept(c, secret);
    expect(await adminGrants(c, result.organizationId)).toEqual([user]);

    // A stale founder row can't mint a second founder once there is an admin.
    const stale = randomUUID();
    await c.query(
      `insert into public.member_invitations(id,normalized_email,full_name,first_name,initials,chapter_id,locale,status,delivery_version,expires_at,kind)
       values ($1,$2,'Example Second','Example','ES',$3,'en','expired',1,now() - interval '1 minute','founder')`,
      [stale, address(), result.chapterId],
    );
    expect(await call(c, 'public.resend_organization_founder_invitation($1,$2)', [stale, sha256('second')])).toEqual({ status: 'unavailable', send: false });
    expect(await call(c, 'public.resend_organization_founder_invitation($1,$2)', [result.invitationId, sha256('again')])).toEqual({ status: 'unavailable', send: false });
  });
});
