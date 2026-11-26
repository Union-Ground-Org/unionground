// @vitest-environment node
// #8752: organization coordination shares follow a document's unit and that
// unit's documents switch. Every write rolls back with the proof transaction.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadMigrationSql } from './helpers/migration.js';
import { sourceTransactionProblem } from '../scripts/hosted-migration-apply-runner.mjs';
import { activeNetwork, as, expectRefusal, member, rpc, verifiedOrg, withClient } from './helpers/openSignupOrganization.js';

describe('coordination shares unit narrowing migration', () => {
  it('uses the real transaction guard', () => {
    expect(sourceTransactionProblem(loadMigrationSql('coordination_shares_follow_unit_narrowing'))).toBeNull();
  });
});

const live = process.env.SUPABASE_DB_URL ? it : it.skip;
const REFUSED = 'authorized chapter document required';
const UNAVAILABLE = 'shared document unavailable';

// Two verified organizations with an active network that allows document
// shares, two units in the first organization's chapter, and helpers that act
// as a person.
async function exchange(c) {
  // The per-unit settings switch is held on Main; release it inside this
  // rolled-back transaction so the documents switch narrows.
  await c.query("update public.platform_setting_definitions set release_at=null where key='features.governance.per_unit_settings'");
  const a = await verifiedOrg(c);
  const b = await verifiedOrg(c);
  const record = await activeNetwork(c, a, b);
  await as(c, a.admin);
  expect(await rpc(c, 'public.set_organization_network_permission($1,$2,$3,$4)', [record, b.org, 'resource_share', true])).toMatchObject({ saved: true });
  const own = randomUUID(), other = randomUUID();
  await c.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values ($1,$3,$4,'Fictional Team A'),($2,$3,$4,'Fictional Team B')", [own, other, a.org, a.chapter]);
  // Staff-only published documents, written in the admin's session so the
  // product-identity trigger stamps the admin's chapter.
  const document = async (unit) => {
    const id = randomUUID();
    await as(c, a.admin);
    await c.query("insert into public.chapter_documents(id,chapter_id,title,document_type,visibility,status,published_at,created_by,access_unit_id) values ($1,$2,'Fictional staff guide','training','staff','published',now(),$3,$4)", [id, a.chapter, a.admin.user, unit]);
    return id;
  };
  const share = (who, doc) => as(c, who).then(() => rpc(c, 'public.share_organization_coordination_resource($1,$2,$3,$4,$5)', [record, 'share', 'Fictional shared guide', doc, randomUUID()]));
  const read = (who, resource) => as(c, who).then(() => rpc(c, 'public.get_organization_coordination_shared_document($1)', [resource]));
  const accept = (resource) => as(c, b.admin).then(() => rpc(c, 'public.respond_organization_coordination_resource($1,$2,$3)', [resource, true, randomUUID()]));
  return { a, b, own, other, document, share, read, accept };
}

live('shares and reads back a unit document only for staff who reach that unit, under its documents switch', async () => {
  await withClient(async (c) => {
    const { a, b, own, other, document, share, read, accept } = await exchange(c);
    // An organization steward whose chapter assignment is Team A only.
    const steward = await member(c, { org: a.org, chapter: a.chapter, role: 'steward' });
    await c.query('insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values ($1,$2,$3)', [own, a.chapter, steward.user]);
    await as(c, a.admin);
    await rpc(c, 'public.set_member_access_role($1,$2,$3,true,$4,null)', [steward.user, a.chapter, 'steward', own]);
    const ownDoc = await document(own), otherDoc = await document(other), chapterDoc = await document(null);

    // The unit steward shares its own unit's document and chapter-wide ones,
    // never another unit's; an organization admin still shares any of them.
    const ownShare = (await share(steward, ownDoc)).resourceId;
    expect((await share(steward, chapterDoc)).created).toBe(true);
    await expectRefusal(share(steward, otherDoc), '22023', REFUSED);
    const otherShare = (await share(a.admin, otherDoc)).resourceId;
    await accept(ownShare); await accept(otherShare);
    expect((await read(steward, ownShare)).title).toBe('Fictional staff guide');
    await expectRefusal(read(steward, otherShare), '22023', UNAVAILABLE);

    // Team A turns steward:documents off: its steward neither shares nor
    // reads back Team A's document; the admin and the receiving organization
    // keep theirs.
    await as(c, a.admin);
    const chapterVersion = (await rpc(c, 'public.get_unit_settings_workspace($1,$2)', [a.chapter, null])).chapterVersion;
    await rpc(c, 'public.save_chapter_unit_settings($1,$2,$3,$4,$5)', [a.chapter, {}, { workload: true, forms: true, templates: true, capabilities: true }, chapterVersion, a.admin.user]);
    await as(c, steward);
    const unitVersion = (await rpc(c, 'public.get_unit_settings_workspace($1,$2)', [a.chapter, own])).unitVersion;
    await rpc(c, 'public.save_unit_settings($1,$2,$3,$4,$5)', [a.chapter, own, { capabilities: { 'steward:documents': false } }, unitVersion, steward.user]);
    await expectRefusal(share(steward, ownDoc), '22023', REFUSED);
    await expectRefusal(read(steward, ownShare), '22023', UNAVAILABLE);
    expect((await read(a.admin, ownShare)).documentId).toBe(ownDoc);
    expect((await read(b.admin, ownShare)).documentId).toBe(ownDoc);
    expect((await read(b.admin, otherShare)).documentId).toBe(otherDoc);
  });
});

live('keeps chapter-wide shares for an organization steward with carry-over coverage who also holds a narrowed unit office (gate stage 195 r1s1, r2s1)', async () => {
  await withClient(async (c) => {
    const { a, own, other, document, share, read, accept } = await exchange(c);
    const steward = await member(c, { org: a.org, chapter: a.chapter, role: 'steward' });
    // Fixture only: an organization-backed carry-over assignment, as the
    // 20261113115000 migration left existing organization stewards (new ones
    // are refused by its trigger).
    await c.query('set local session_replication_role = replica');
    await c.query("insert into private.organization_steward_unit_assignments(organization_id,user_id,role,chapter_id,unit_id,legacy_chapter_coverage) values ($1,$2,'steward',$3,$4,true)", [a.org, steward.user, a.chapter, other]);
    await c.query('set local session_replication_role = origin');
    // The same person is Secretary for Team A, and the chapter turns
    // secretary:documents off.
    await as(c, a.admin);
    await rpc(c, 'public.set_member_access_role($1,$2,$3,true,$4,null)', [steward.user, a.chapter, 'secretary', own]);
    await rpc(c, 'public.set_chapter_role_capability($1,$2,$3,$4)', [a.chapter, 'secretary', 'documents', false]);
    const ownDoc = await document(own), otherDoc = await document(other);
    const ownShare = (await share(steward, ownDoc)).resourceId;
    expect((await share(steward, otherDoc)).created).toBe(true);
    await accept(ownShare);
    expect((await read(steward, ownShare)).documentId).toBe(ownDoc);
    // A steward assigned to Team A alone is still refused once Team A's
    // steward documents switch is off.
    const unitSteward = await member(c, { org: a.org, chapter: a.chapter, role: 'steward' });
    await as(c, a.admin);
    await rpc(c, 'public.set_member_access_role($1,$2,$3,true,$4,null)', [unitSteward.user, a.chapter, 'steward', own]);
    const chapterVersion = (await rpc(c, 'public.get_unit_settings_workspace($1,$2)', [a.chapter, null])).chapterVersion;
    await rpc(c, 'public.save_chapter_unit_settings($1,$2,$3,$4,$5)', [a.chapter, {}, { workload: true, forms: true, templates: true, capabilities: true }, chapterVersion, a.admin.user]);
    const unitVersion = (await rpc(c, 'public.get_unit_settings_workspace($1,$2)', [a.chapter, own])).unitVersion;
    await rpc(c, 'public.save_unit_settings($1,$2,$3,$4,$5)', [a.chapter, own, { capabilities: { 'steward:documents': false } }, unitVersion, a.admin.user]);
    await expectRefusal(share(unitSteward, ownDoc), '22023', REFUSED);
    await expectRefusal(read(unitSteward, ownShare), '22023', UNAVAILABLE);
    // Carry-over coverage is chapter coverage: the unit switch does not narrow it.
    expect((await share(steward, ownDoc)).created).toBe(true);
  });
});
