// @vitest-environment node
// SEC-UG-OPEN-SIGNUP-TENANT-BOUNDARY-20260925
// The 16 later verification, discovery, owner-switch and intake-cap cases (30–45).
// Synthetic fixtures only; each ordinary case rolls back. Concurrent
// cases restore gate/counter fixtures and require owned-stack teardown.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import {
  SHELL_EVENT,
  VERIFICATION,
  sha256,
  userScope,
  tag,
  openPeriod,
  withClient,
  account,
  session,
  as,
  asServiceRole,
  rpc,
  owner,
  expectRefusal,
  createOrg,
  unverifiedOrg,
  verifiedOrg,
  limiterRows,
  seedAdmissions,
  onboardedPartner,
  svc,
  platformVerifier,
  claimUnderReview,
  clears,
  claimVerified,
  saveConnectionProfile,
  hideChapter,
  connectionStatus,
  assertDisposableProofUrl,
  insertSignupCoverageLease,
  insertSignupRecoveryCheck,
} from './helpers/openSignupOrganization.js';

const live = process.env.RUN_OPEN_SIGNUP_ORGANIZATION_DB_TESTS === '1' ? it : it.skip;


live('35. a row older than 24 hours frees a daily slot but not a lifetime place', async () => {
  await withClient(async (c) => {
    await seedAdmissions(c, 4); await seedAdmissions(c, 1, '25 hours');
    const who = await account(c); await as(c, who);
    expect((await createOrg(c, `Example Intake ${tag()}`)).status).toBe('created');
    await asServiceRole(c);
    expect(await rpc(c, 'public.open_signup_intake_status()', [], 'service_role')).toMatchObject({ admitted_24h: 5, admitted_total: 6, daily_cap: 5, cohort_cap: 25, cohort: 'public-launch-2026-10', open: false });
  });
});


live('36. the lifetime cohort never resets even when the daily count is zero', async () => {
  await withClient(async (c) => {
    await seedAdmissions(c, 25, '30 days');
    const who = await account(c); await as(c, who);
    expect(await createOrg(c, `Example Intake ${tag()}`)).toEqual({ status: 'unavailable' });
    await asServiceRole(c);
    expect(await rpc(c, 'public.open_signup_intake_status()', [], 'service_role')).toMatchObject({ admitted_24h: 0, admitted_total: 25, open: false });
  });
});


live('37. deleting an admitted organization leaves its permanent admission intact', async () => {
  await withClient(async (c) => {
    // An otherwise unreferenced organization isolates deletion from shell/audit retention.
    const org = randomUUID();
    await c.query("insert into public.organizations(id,slug,name,status) values($1,$2,$2,'active')", [org, `example-${tag()}`]);
    await c.query('insert into private.open_signup_cohort_admissions(organization_id) values($1)', [org]);
    await seedAdmissions(c, 24, '30 days');
    await c.query('delete from public.organizations where id=$1', [org]);
    expect((await c.query('select count(*)::int n from private.open_signup_cohort_admissions where organization_id=$1', [org])).rows[0].n).toBe(1);
    const who = await account(c); await as(c, who);
    expect(await createOrg(c, `Example Intake ${tag()}`)).toEqual({ status: 'unavailable' });
  });
});


live('38. no client can read or mutate admissions; only service_role can read counts', async () => {
  await withClient(async (c) => {
    await seedAdmissions(c, 1);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const table of ['private.open_signup_cohort_admissions', 'private.open_signup_intake_reservations']) {
        for (const privilege of ['select','insert','update','delete','truncate','references','trigger']) {
          expect((await c.query('select has_table_privilege($1,$2,$3) ok', [role, table, privilege])).rows[0].ok).toBe(false);
        }
        await expectRefusal(owner(c, `set local role ${role}; select * from ${table}`), '42501');
      }
      // owner() restores the failed role change through its savepoint.
      if (role !== 'service_role') await expectRefusal(rpc(c, 'public.open_signup_intake_status()', [], role), '42501');
    }
    await asServiceRole(c);
    const status = await rpc(c, 'public.open_signup_intake_status()', [], 'service_role');
    expect(Object.keys(status).sort()).toEqual(['admitted_24h','admitted_total','cohort','cohort_cap','daily_cap','open']);
    expect(status.open).toBe(true);
    await c.query('delete from private.open_signup_period');
    expect((await rpc(c, 'public.open_signup_intake_status()', [], 'service_role')).open).toBe(false);
    for (const sql of ['update private.open_signup_cohort_admissions set admitted_at=now()', 'delete from private.open_signup_cohort_admissions', 'truncate private.open_signup_cohort_admissions']) {
      await expectRefusal(owner(c, sql), '42501', 'signup admissions are append-only');
    }
  });
});


live('39. full intake rejects a self-service Auth insert atomically while invitations still provision', async () => {
  await withClient(async (c) => {
    await seedAdmissions(c, 5);
    const id = randomUUID();
    await expectRefusal(owner(c, `insert into auth.users(id,email,raw_app_meta_data) values($1,$2,'{"union_ground_signup":"self_serve"}')`, [id, `${id}@example.invalid`]), '55000', 'signup unavailable');
    expect((await c.query('select count(*)::int n from auth.users where id=$1', [id])).rows[0].n).toBe(0);
    const verified = await verifiedOrg(c);
    await as(c, verified.admin);
    const secret = randomUUID(); const email = `${randomUUID()}@example.invalid`;
    const invitation = await rpc(c, "public.create_member_invitation($1,'Example Invitee',$2,null,'en',$3)", [email, verified.chapter, sha256(secret)]);
    expect(invitation.invitationId).toBeTruthy();
    await asServiceRole(c);
    const claim = await rpc(c, 'public.claim_member_invitation($1)', [sha256(secret)], 'service_role');
    expect(claim.available).toBe(true);
    const row = (await c.query('select * from public.member_invitations where id=$1', [invitation.invitationId])).rows[0];
    const invited = randomUUID();
    await c.query(`insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data,raw_app_meta_data,banned_until)
      values($1,$2,now(),$3,'{"union_ground_provisioning":"pending"}',now()+interval '100 years')`,
    [invited, email, JSON.stringify({ full_name: row.full_name, first_name: row.first_name, initials: row.initials, chapter_id: row.chapter_id, union_base_invitation_id: row.id })]);
    await rpc(c, 'public.finalize_member_invitation($1,$2)', [row.id, invited], 'service_role');
    await c.query(`update auth.users set raw_app_meta_data='{"union_ground_provisioning":"active"}',banned_until=null where id=$1`, [invited]);
    await rpc(c, 'public.complete_member_invitation_activation($1,$2)', [row.id, invited], 'service_role');
    expect((await c.query('select count(*)::int n from public.organization_memberships where user_id=$1 and organization_id=$2', [invited, verified.org])).rows[0].n).toBe(1);
    expect((await c.query('select count(*)::int n from private.open_signup_cohort_admissions')).rows[0].n).toBe(5);
  });
});


live('30. a platform verifier approving the self-created organization\'s claim lifts the boundary', async () => {
  await withClient(async (c) => {
    const shell = await unverifiedOrg(c);
    const directory = () => rpc(c, 'public.upsert_organization_network_profile($1,$2,$3,$4,$5)', [shell.name, '', 'directory', 'disabled', null]);
    // Walled off before the claim is decided.
    expect(await clears(c, shell.org)).toBe(false);
    await as(c, shell.admin);
    await expectRefusal(directory(), '42501', VERIFICATION);
    const operator = await platformVerifier(c);
    const claim = await claimUnderReview(c, shell);
    expect(await svc(c, 'public.review_organization_claim($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
      claim, operator.user, 'approve', 'written_authorization', null, null, null, null, randomUUID(), operator.session,
    ])).toMatchObject({ claimId: claim, status: 'approved' });
    // The claim's verified mark alone lifts the boundary: verified_at on the
    // organization stays null.
    expect(await claimVerified(c, shell.org)).toBe(true);
    expect((await c.query('select verified_at from public.organizations where id = $1', [shell.org])).rows[0].verified_at).toBeNull();
    expect(await clears(c, shell.org)).toBe(true);
    await as(c, shell.admin);
    expect(await directory()).toMatchObject({ saved: true, visibility: 'directory' });
  });
});


live('31. a self-created organization whose claim is only under review or held stays walled off', async () => {
  await withClient(async (c) => {
    const shell = await unverifiedOrg(c);
    const verified = await verifiedOrg(c);
    const directory = (name) => rpc(c, 'public.upsert_organization_network_profile($1,$2,$3,$4,$5)', [name, '', 'directory', 'disabled', null]);
    const operator = await platformVerifier(c);
    const claim = await claimUnderReview(c, shell);
    expect(await claimVerified(c, shell.org)).toBe(false);
    expect(await clears(c, shell.org)).toBe(false);
    await as(c, shell.admin);
    await expectRefusal(directory(shell.name), '42501', VERIFICATION);
    expect(await svc(c, 'public.review_organization_claim($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
      claim, operator.user, 'hold', null, 'awaiting_callback', null, null, null, randomUUID(), operator.session,
    ])).toMatchObject({ claimId: claim, status: 'held' });
    expect(await clears(c, shell.org)).toBe(false);
    await as(c, shell.admin);
    await expectRefusal(directory(shell.name), '42501', VERIFICATION);
    // Control: an operator-provisioned organization makes the same write.
    await as(c, verified.admin);
    expect(await directory(verified.name)).toMatchObject({ saved: true, visibility: 'directory' });
  });
});


live('32. the signup period keeps signup closed until the owner opens it', async () => {
  await withClient(async (c) => {
    const creations = async () => Number((await c.query(
      "select count(*) from public.organization_audit_ledger where event_type = $1", [SHELL_EVENT])).rows[0].count);
    const charged = async (userId) => Number((await c.query(
      "select count(*) from private.open_signup_limits where scope_hash = $1", [userScope(userId)])).rows[0].count);
    const consume = (scope) => rpc(c, 'public.consume_open_signup_limit($1,$2)', [scope, 'network-hour'], 'service_role');
    // No client role can read or change the switch.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect((await c.query('select has_table_privilege($1,$2,$3) as ok', [role, 'private.open_signup_period', privilege])).rows[0].ok, `${role} ${privilege}`).toBe(false);
      }
    }
    // Closed as shipped: no row. Nothing is created and nothing is charged.
    expect((await c.query('select count(*)::int as n from private.open_signup_period')).rows[0].n).toBe(0);
    const before = await creations();
    const early = await account(c);
    await as(c, early);
    expect(await createOrg(c, `Example Workers Local 1 ${tag()}`)).toEqual({ status: 'closed' });
    expect(await creations()).toBe(before);
    expect(await charged(early.user)).toBe(0);
    await asServiceRole(c);
    const scope = sha256(`network-${randomUUID()}`);
    await expectRefusal(consume(scope), '55000', 'signup closed');
    expect((await c.query('select count(*)::int as n from private.open_signup_limits where scope_hash = $1', [scope])).rows[0].n).toBe(0);
    // A null or future opening time is still closed.
    await openPeriod(c, 'null');
    await as(c, early);
    expect(await createOrg(c, `Example Workers Local 1 ${tag()}`)).toEqual({ status: 'closed' });
    await openPeriod(c, "now() + interval '1 day'");
    expect(await createOrg(c, `Example Workers Local 1 ${tag()}`)).toEqual({ status: 'closed' });
    await asServiceRole(c);
    await expectRefusal(consume(scope), '55000', 'signup closed');
    // Control: once the period has opened, the same account creates its
    // organization and the route limiter charges.
    await openPeriod(c, "now() - interval '1 minute'");
    const key = randomUUID();
    await as(c, early);
    const created = await createOrg(c, `Example Workers Local 1 ${tag()}`, key);
    expect(created).toMatchObject({ status: 'created', idempotent: false });
    expect(await creations()).toBe(before + 1);
    await asServiceRole(c);
    expect(await consume(scope)).toBe(true);
    // Closing again stops new organizations; a replay of one made while open
    // still answers with its ids.
    await openPeriod(c, 'null');
    await as(c, early);
    expect(await createOrg(c, 'ignored on replay', key)).toMatchObject({
      status: 'created', organizationId: created.organizationId, idempotent: true,
    });
    const late = await account(c);
    await as(c, late);
    expect(await createOrg(c, `Example Workers Local 1 ${tag()}`)).toEqual({ status: 'closed' });
    expect(await creations()).toBe(before + 1);
  }, { periodOpen: false });
});


live('33. G10: an unverified organization keeps its connection profile a draft and cannot hide another chapter', async () => {
  await withClient(async (c) => {
    const shell = await unverifiedOrg(c);
    const listed = await verifiedOrg(c);
    const viewer = await verifiedOrg(c);
    await as(c, shell.admin);
    await saveConnectionProfile(c, shell.chapter, false);
    expect(await connectionStatus(c, shell.chapter)).toBe('draft');
    await expectRefusal(saveConnectionProfile(c, shell.chapter, true), '42501', VERIFICATION);
    expect(await connectionStatus(c, shell.chapter)).toBe('draft');
    // Control: operator-provisioned organizations publish.
    for (const org of [listed, viewer]) {
      await as(c, org.admin);
      await saveConnectionProfile(c, org.chapter, true);
      expect(await connectionStatus(c, org.chapter)).toBe('published');
    }
    // One answer for a published target and an unknown one, and no row.
    await as(c, shell.admin);
    await expectRefusal(hideChapter(c, shell.chapter, listed.chapter), '42501', VERIFICATION);
    await expectRefusal(hideChapter(c, shell.chapter, `missing-${tag()}`), '42501', VERIFICATION);
    expect((await c.query('select count(*)::int as n from private.chapter_connection_hides where organization_id = $1', [shell.org])).rows[0].n).toBe(0);
    // Control: a verified organization hides the same published chapter.
    await as(c, viewer.admin);
    expect(await hideChapter(c, viewer.chapter, listed.chapter)).toBeTruthy();
    expect((await c.query('select count(*)::int as n from private.chapter_connection_hides where chapter_id = $1 and hidden_chapter_id = $2', [viewer.chapter, listed.chapter])).rows[0].n).toBe(1);
    // The boundary trigger refuses direct writes too.
    await c.query("select set_config('request.jwt.claims','',true)");
    await expectRefusal(owner(c,
      `update private.chapter_connection_profiles
          set publication_status = 'published', publication_version = 1, published_at = now(),
              expires_at = now() + interval '180 days', consent_version = 1, consent_recorded_at = now(), consent_hat = 'admin'
        where chapter_id = $1`, [shell.chapter]), '42501', VERIFICATION);
    await expectRefusal(owner(c,
      'insert into private.chapter_connection_hides(chapter_id,hidden_chapter_id,organization_id) values ($1,$2,$3)',
      [shell.chapter, listed.chapter, shell.org]), '42501', VERIFICATION);
  });
});


live('34. R3: an unverified organization lists no other chapter and its connection handshake learns nothing', async () => {
  await withClient(async (c) => {
    const partner = await onboardedPartner(c, 7);
    const shell = await unverifiedOrg(c);
    const verified = await verifiedOrg(c);
    await as(c, partner.admin);
    await saveConnectionProfile(c, partner.chapter, true);
    const list = (chapter) => rpc(c, 'public.list_chapter_connection_profiles($1,$2,$3,$4,$5)', ['admin', null, 500, null, chapter]);
    const connect = (chapter, target) => rpc(c, 'public.request_chapter_connection_handshake($1,$2,$3,$4,$5,$6,$7)',
      ['admin', chapter, target, 'Example exchange', 'Share meeting notes', 'docs_only', randomUUID()]);
    await as(c, shell.admin);
    expect(await list(shell.chapter)).toMatchObject({ rows: [], nextCursor: null, complete: true });
    // One answer whether or not the target is published with a verified
    // binding, and nothing is written.
    const bound = await expectRefusal(connect(shell.chapter, partner.chapter), '22023', 'partner is not onboarded for two-sided requests');
    const missing = await expectRefusal(connect(shell.chapter, `missing-${tag()}`), '22023', 'partner is not onboarded for two-sided requests');
    expect({ code: missing.code, message: missing.message }).toEqual({ code: bound.code, message: bound.message });
    expect((await c.query('select count(*)::int as n from public.chapter_handshakes where chapter_id = $1', [shell.chapter])).rows[0].n).toBe(0);
    // Control: a verified organization lists the partner and reaches it.
    await as(c, verified.admin);
    expect((await list(verified.chapter)).rows.map((row) => row.id)).toContain(partner.chapter);
    expect(await connect(verified.chapter, partner.chapter)).toMatchObject({ chapter_id: verified.chapter, receiving_chapter_id: partner.chapter });
  });
});




live('40. eight concurrent organization calls with four daily places admit exactly four', async () => {
  const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const fixtureName = `signup-intake-concurrency-${randomUUID()}`;
  const setup = new pg.Client({ connectionString: url, application_name: fixtureName }); await setup.connect();
  const clients = []; const ids = []; const admissions = [randomUUID()]; let recoveryId; let coverageId;
  try {
    // This test requires an initially closed, empty disposable intake gate.
    expect((await setup.query('select count(*)::int n from private.open_signup_cohort_admissions')).rows[0].n).toBe(0);
    expect((await setup.query('select count(*)::int n from private.open_signup_period')).rows[0].n).toBe(0);
    await setup.query('begin'); await insertSignupRecoveryCheck(setup); await insertSignupCoverageLease(setup);
    coverageId = (await setup.query('select max(id) id from private.open_signup_operator_coverage')).rows[0].id;
    recoveryId = (await setup.query('select max(id) id from private.open_signup_recovery_checks')).rows[0].id;
    await openPeriod(setup);
    await setup.query('insert into private.open_signup_cohort_admissions(organization_id) values($1)', [admissions[0]]);
    const older = Array.from({ length: 20 }, () => randomUUID()); admissions.push(...older);
    await setup.query("insert into private.open_signup_cohort_admissions(organization_id,admitted_at) select unnest($1::uuid[]),clock_timestamp()-interval '30 days'", [older]);
    const people = [];
    for (let i = 0; i < 8; i += 1) { const who = await account(setup); people.push(who); ids.push(who.user); }
    await setup.query('commit');
    await Promise.all(people.map(async (who) => {
      const c = new pg.Client({ connectionString: url }); clients.push(c); await c.connect();
      await c.query("set statement_timeout='20s'"); await c.query('begin'); await as(c, who);
    }));
    const results = await Promise.all(clients.map(async (c) => {
      const result = await createOrg(c, `Example Concurrent ${tag()}`); await c.query('commit'); return result;
    }));
    expect(results.filter((result) => result.status === 'created')).toHaveLength(4);
    expect(results.filter((result) => result.status === 'unavailable')).toHaveLength(4);
    admissions.push(...results.filter((result) => result.status === 'created').map((result) => result.organizationId));
    expect((await setup.query('select count(*)::int n from private.open_signup_cohort_admissions')).rows[0].n).toBe(25);
    expect((await setup.query("select count(*)::int n from private.open_signup_cohort_admissions where admitted_at > clock_timestamp()-interval '24 hours'")).rows[0].n).toBe(5);
  } finally {
    await Promise.all(clients.map(async (c) => { await c.query('rollback'); await c.end(); }));
    await setup.query('rollback');
    // Fixture disposal only: the superuser temporarily disables the ledger guard
    // to remove this test's exact rows; no application role can do this.
    await setup.query('begin');
    await setup.query('alter table private.open_signup_cohort_admissions disable trigger signup_admissions_append_only');
    await setup.query('delete from private.open_signup_cohort_admissions where organization_id=any($1::uuid[]) or organization_id in (select id from public.organizations where created_by=any($2::uuid[]))', [admissions, ids]);
    await setup.query('alter table private.open_signup_cohort_admissions enable trigger signup_admissions_append_only');
    await setup.query('delete from private.open_signup_period');
    await setup.query('delete from private.open_signup_switch_changes where application_name=$1', [fixtureName]);
    if (recoveryId) await setup.query('delete from private.open_signup_recovery_checks where id=$1', [recoveryId]);
    if (coverageId) {
      await setup.query('set local session_replication_role=replica');
      await setup.query('delete from private.open_signup_operator_coverage where id=$1', [coverageId]);
      await setup.query('set local session_replication_role=origin');
    }
    await setup.query('commit'); await setup.end();
  }
}, 60000);



live('41. two confirmations cannot create two founder accounts for the last place', async () => {
  await withClient(async (c) => {
    await seedAdmissions(c, 4);
    const first = randomUUID(); const rejected = randomUUID();
    await c.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data)
      values($1,$2,now(),'{"union_ground_signup":"self_serve"}')`, [first, `${first}@example.invalid`]);
    await expectRefusal(owner(c, `insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data)
      values($1,$2,now(),'{"union_ground_signup":"self_serve"}')`, [rejected, `${rejected}@example.invalid`]), '55000', 'signup unavailable');
    expect((await c.query('select count(*)::int n from auth.users where id=$1', [rejected])).rows[0].n).toBe(0);
    await asServiceRole(c);
    expect(await rpc(c, 'public.open_signup_intake_status()', [], 'service_role')).toMatchObject({ admitted_24h: 4, admitted_total: 4, open: false });
    const who = await session(c, { user: first }, 'aal1'); await as(c, who);
    const key = randomUUID(); const created = await createOrg(c, `Example Reserved ${tag()}`, key);
    expect(created.status).toBe('created');
    expect(await createOrg(c, `Example Reserved ${tag()}`, key)).toMatchObject({ organizationId: created.organizationId, idempotent: true });
    expect((await c.query('select count(*)::int n from private.open_signup_cohort_admissions')).rows[0].n).toBe(5);
  });
});



live('42. eight concurrent confirmations reserve exactly four accounts and preserve their organization places', async () => {
  const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const fixtureName = `signup-reserve-${randomUUID()}`;
  const setup = new pg.Client({ connectionString: url, application_name: fixtureName }); await setup.connect();
  const candidates = Array.from({ length: 8 }, () => randomUUID());
  const seeded = Array.from({ length: 21 }, () => randomUUID()); const clients = []; let recoveryId; let coverageId;
  try {
    expect((await setup.query('select count(*)::int n from private.open_signup_cohort_admissions')).rows[0].n).toBe(0);
    expect((await setup.query('select count(*)::int n from private.open_signup_period')).rows[0].n).toBe(0);
    await setup.query('begin'); await insertSignupRecoveryCheck(setup); await insertSignupCoverageLease(setup);
    coverageId = (await setup.query('select max(id) id from private.open_signup_operator_coverage')).rows[0].id;
    await openPeriod(setup);
    recoveryId = (await setup.query('select max(id) id from private.open_signup_recovery_checks')).rows[0].id;
    await setup.query("insert into private.open_signup_cohort_admissions(organization_id,admitted_at) select unnest($1::uuid[]),clock_timestamp()-interval '30 days'", [seeded.slice(0,20)]);
    await setup.query('insert into private.open_signup_cohort_admissions(organization_id) values($1)', [seeded[20]]);
    await setup.query('commit');
    await Promise.all(candidates.map(async (user) => {
      const c = new pg.Client({ connectionString: url }); clients.push({ c, user }); await c.connect();
      await c.query("set statement_timeout='20s'");
    }));
    const confirmations = await Promise.all(clients.map(async ({ c, user }) => {
      await c.query('begin');
      try {
        await c.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data)
          values($1,$2,now(),'{"union_ground_signup":"self_serve"}')`, [user, `${user}@example.invalid`]);
        await c.query('commit'); return { c, user };
      } catch (error) {
        await c.query('rollback'); expect(error.code).toBe('55000'); expect(error.message).toBe('signup unavailable'); return null;
      }
    }));
    const accepted = confirmations.filter(Boolean); expect(accepted).toHaveLength(4);
    expect((await setup.query('select count(*)::int n from auth.users where id=any($1::uuid[])', [candidates])).rows[0].n).toBe(4);
    expect((await setup.query('select count(*)::int n from private.open_signup_intake_reservations where user_id=any($1::uuid[]) and consumed_at is null', [candidates])).rows[0].n).toBe(4);
    const founders = [];
    for (const { c, user } of accepted) founders.push({ c, who: await session(setup, { user }, 'aal1') });
    const organizations = await Promise.all(founders.map(async ({ c, who }) => {
      await c.query('begin'); await as(c, who);
      const result = await createOrg(c, `Example Reserved ${tag()}`); await c.query('commit'); return result;
    }));
    expect(organizations.every((result) => result.status === 'created')).toBe(true);
    expect((await setup.query('select count(*)::int n from private.open_signup_cohort_admissions')).rows[0].n).toBe(25);
    expect((await setup.query('select count(*)::int n from private.open_signup_intake_reservations where user_id=any($1::uuid[]) and consumed_at is null', [candidates])).rows[0].n).toBe(0);
  } finally {
    await Promise.all(clients.map(async ({ c }) => { await c.query('rollback'); await c.end(); }));
    await setup.query('rollback'); await setup.query('begin');
    await setup.query('alter table private.open_signup_cohort_admissions disable trigger signup_admissions_append_only');
    await setup.query('delete from private.open_signup_cohort_admissions where organization_id=any($1::uuid[]) or organization_id in (select id from public.organizations where created_by=any($2::uuid[]))', [seeded, candidates]);
    await setup.query('alter table private.open_signup_cohort_admissions enable trigger signup_admissions_append_only');
    await setup.query('delete from private.open_signup_intake_reservations where user_id=any($1::uuid[])', [candidates]);
    await setup.query('delete from private.open_signup_period');
    await setup.query('delete from private.open_signup_switch_changes where application_name=$1', [fixtureName]);
    if (recoveryId) await setup.query('delete from private.open_signup_recovery_checks where id=$1', [recoveryId]);
    if (coverageId) {
      await setup.query('set local session_replication_role=replica');
      await setup.query('delete from private.open_signup_operator_coverage where id=$1', [coverageId]);
      await setup.query('set local session_replication_role=origin');
    }
    await setup.query('commit'); await setup.end();
  }
}, 60000);


live('43. an unreserved direct RPC caller cannot steal a confirmed founder cohort place', async () => {
  await withClient(async (c) => {
    await seedAdmissions(c, 24, '30 days');
    const user = randomUUID();
    await c.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data)
      values($1,$2,now(),'{"union_ground_signup":"self_serve"}')`, [user, `${user}@example.invalid`]);
    const unreserved = await account(c); await as(c, unreserved);
    expect(await createOrg(c, `Example Unreserved ${tag()}`)).toEqual({ status: 'unavailable' });
    const who = await session(c, { user }, 'aal1'); await as(c, who);
    expect((await createOrg(c, `Example Reserved ${tag()}`)).status).toBe('created');
    expect((await c.query('select consumed_at is not null consumed from private.open_signup_intake_reservations where user_id=$1', [user])).rows[0].consumed).toBe(true);
    expect((await c.query('select count(*)::int n from private.open_signup_cohort_admissions')).rows[0].n).toBe(25);
  });
});


live('44. an older reservation keeps its cohort place and converts only within the rolling daily cap', async () => {
  await withClient(async (c) => {
    await seedAdmissions(c, 20, '30 days'); await seedAdmissions(c, 4);
    const who = await account(c);
    await c.query("insert into private.open_signup_intake_reservations(user_id,reserved_at) values($1,clock_timestamp()-interval '25 hours')", [who.user]);
    await asServiceRole(c);
    expect(await rpc(c, 'public.open_signup_intake_status()', [], 'service_role')).toMatchObject({ admitted_24h: 4, admitted_total: 24, open: false });
    await as(c, who);
    expect((await createOrg(c, `Example Returning ${tag()}`)).status).toBe('created');
    await asServiceRole(c);
    expect(await rpc(c, 'public.open_signup_intake_status()', [], 'service_role')).toMatchObject({ admitted_24h: 5, admitted_total: 25, open: false });
  });
});


live('45. capacity refusals preserve a returning founder daily attempts until a place opens', async () => {
  await withClient(async (c) => {
    await seedAdmissions(c, 5);
    const who = await account(c);
    await c.query("insert into private.open_signup_intake_reservations(user_id,reserved_at) values($1,clock_timestamp()-interval '25 hours')", [who.user]);
    await as(c, who);
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(await createOrg(c, `Example Waiting ${tag()}`)).toEqual({ status: 'unavailable' });
    }
    expect(await limiterRows(c, userScope(who.user))).toEqual([]);
    // Only this rolled-back owner fixture ages an immutable synthetic admission.
    await c.query('alter table private.open_signup_cohort_admissions disable trigger signup_admissions_append_only');
    await c.query("update private.open_signup_cohort_admissions set admitted_at=clock_timestamp()-interval '25 hours' where id=(select id from private.open_signup_cohort_admissions limit 1)");
    await c.query('alter table private.open_signup_cohort_admissions enable trigger signup_admissions_append_only');
    expect((await createOrg(c, `Example Returning ${tag()}`)).status).toBe('created');
    expect((await limiterRows(c, userScope(who.user)))[0].request_count).toBe(1);
  });
});
