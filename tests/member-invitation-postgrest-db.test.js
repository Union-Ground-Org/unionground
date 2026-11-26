// @vitest-environment node
// Real Auth/PostgREST regression for #5874. Run against an owned full replay
// with SUPABASE_DB_URL and PRIVATE_FILE_STORAGE_STATUS_FILE; no hosted writes.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { assertDisposableProofUrl, assertDisposableStorageStatus } from '../scripts/run-required-db-proofs.mjs';
import { deskInvitationNames } from '../api/_lib/memberInvitations.js';

const live = process.env.SUPABASE_DB_URL ? it : it.skip;
const tag = () => randomUUID().slice(0, 8).replace(/[0-9]/g, (d) => 'ghijklmnop'[d]);
const address = () => `inviter-${randomUUID()}@example.invalid`;

live('reads invitation names through the direct organization relationship without crossing tenants', async () => {
  const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const status = assertDisposableStorageStatus(
    JSON.parse(readFileSync(process.env.PRIVATE_FILE_STORAGE_STATUS_FILE, 'utf8')), connectionString,
  );
  const c = new pg.Client({ connectionString });
  const fixtures = [0, 1].map(() => ({
    organization: randomUUID(), user: randomUUID(), password: randomUUID(), email: address(),
    chapter: `invitation-names-${randomUUID()}`, name: `Example Invitation ${tag()}`,
    inviter: `Example Inviter ${tag()}`,
  }));
  await c.connect();
  try {
    await c.query("set statement_timeout = '20s'");
    // Auth uses its own transaction and the same lifecycle locks as memberships.
    // Create accounts before opening the SQL fixture transaction.
    for (const f of fixtures) {
      const created = await fetch(`${status.API_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { apikey: status.SERVICE_ROLE_KEY, Authorization: `Bearer ${status.SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: f.email, password: f.password, email_confirm: true,
          app_metadata: { union_ground_provisioning: 'active' } }),
      });
      expect(created.status).toBe(200);
      f.user = (await created.json()).id;
    }
    await c.query('begin');
    for (const f of fixtures) {
      await c.query('insert into public.organizations(id,slug,name) values ($1,$2,$3)',
        [f.organization, `invitation-names-${f.organization}`, f.name]);
      await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$2,$1,'proof',$3,9953)",
        [f.chapter, f.name, f.organization]);
      await c.query('update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1',
        [f.user, f.chapter, f.inviter]);
      await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [f.organization, f.user]);
      await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [f.user, f.chapter]);
    }
    await c.query('commit');
    // Real HTTP connections must see committed fixtures. No fetch or RLS mocks.
    for (const [index, f] of fixtures.entries()) {
      const signedIn = await fetch(`${status.API_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: status.ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: f.email, password: f.password }),
      });
      expect(signedIn.status).toBe(200);
      const token = (await signedIn.json()).access_token;
      expect(await deskInvitationNames(status.API_URL, status.ANON_KEY, token))
        .toEqual({ organization: f.name, inviter: f.inviter, source: 'administrator' });
      const foreign = await fetch(`${status.API_URL}/rest/v1/organizations?select=name&id=eq.${fixtures[1 - index].organization}`, {
        headers: { apikey: status.ANON_KEY, Authorization: `Bearer ${token}` },
      });
      expect(foreign.status).toBe(200);
      expect(await foreign.json()).toEqual([]);
    }
    await expect(deskInvitationNames(status.API_URL, status.ANON_KEY, status.ANON_KEY))
      .rejects.toThrow('invitation-names-unavailable');
  } finally {
    try {
      await c.query('rollback');
      await c.query('delete from auth.users where id = any($1::uuid[])', [fixtures.map(f => f.user)]);
      // Membership creation registers a durable dues subject even without dues.
      await c.query('delete from public.dues_member_subjects where organization_id = any($1::uuid[])', [fixtures.map(f => f.organization)]);
      await c.query('delete from public.chapters where id = any($1::text[])', [fixtures.map(f => f.chapter)]);
      await c.query('delete from public.organizations where id = any($1::uuid[])', [fixtures.map(f => f.organization)]);
    } finally { await c.end(); }
  }
});

