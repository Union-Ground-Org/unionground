// @vitest-environment node
// SEC-UG-OPEN-SIGNUP-TENANT-BOUNDARY-20260925
// The original 29 acceptance cases; later protections live in the additional suite.
// Synthetic fixtures only; each ordinary case rolls back. Concurrent
// cases restore gate/counter fixtures and require owned-stack teardown.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  VERIFICATION,
  sha256,
  userScope,
  tag,
  withClient,
  account,
  session,
  as,
  asServiceRole,
  rpc,
  owner,
  expectRefusal,
  createOrg,
  cp,
  unverifiedOrg,
  verifiedOrg,
  member,
  unionOrg,
  setVerified,
  shellCounts,
  limiterRows,
  onboardedPartner,
  createRecord,
  invite,
  activeNetwork,
  publish,
  seedInvitations,
} from './helpers/openSignupOrganization.js';

const live = process.env.RUN_OPEN_SIGNUP_ORGANIZATION_DB_TESTS === '1' ? it : it.skip;


live('1. a confirmed no-factor aal1 account creates exactly the seven shell rows and one ledger row', async () => {
  await withClient(async (c) => {
    const who = await account(c);
    await as(c, who);
    const key = randomUUID();
    const name = `Example Workers Local 1 ${tag()}`;
    const created = await createOrg(c, name, key);
    expect(created).toMatchObject({ status: 'created', idempotent: false });
    expect(created.slug).toMatch(/^u-[0-9a-f]{10}$/);
    expect(created.chapterId).toMatch(/^c-[0-9a-f]{10}$/);
    expect(await shellCounts(c, created.organizationId, who.user)).toEqual({
      organizations: 1, security_policy: 1, chapters: 1, memberships: 1, role_grants: 1,
      chapter_memberships: 1, profiles: 1, ledger: 1,
    });
    const org = (await c.query('select name, slug, status, created_by, self_serve_created_at, verified_at from public.organizations where id=$1', [created.organizationId])).rows[0];
    expect(org).toMatchObject({ name, slug: created.slug, status: 'active', created_by: who.user, verified_at: null });
    expect(org.self_serve_created_at).not.toBeNull();
    expect((await c.query('select require_staff_mfa, updated_by from public.org_security_policy where organization_id=$1', [created.organizationId])).rows[0]).toEqual({ require_staff_mfa: true, updated_by: who.user });
    expect((await c.query('select id, name, slug, is_default, order_index from public.chapters where organization_id=$1', [created.organizationId])).rows[0]).toEqual({
      id: created.chapterId, name, slug: created.chapterId, is_default: true, order_index: 1,
    });
    expect((await c.query('select role, granted_by from public.organization_role_grants where organization_id=$1', [created.organizationId])).rows).toEqual([{ role: 'admin', granted_by: who.user }]);
    expect((await c.query('select chapter_id from public.member_profiles where id=$1', [who.user])).rows[0].chapter_id).toBe(created.chapterId);
    expect((await c.query('select count(*)::int as n from public.dues_member_subjects where organization_id=$1 and user_id=$2', [created.organizationId, who.user])).rows[0].n).toBe(1);
    const ledger = (await c.query('select domain, action, actor_user_id, entity_type, entity_id, idempotency_key, metadata from public.organization_audit_ledger where organization_id=$1', [created.organizationId])).rows;
    expect(ledger).toEqual([{
      domain: 'administration', action: 'create', actor_user_id: who.user, entity_type: 'organization',
      entity_id: created.organizationId, idempotency_key: key,
      metadata: { organizationId: created.organizationId, chapterId: created.chapterId, userId: who.user, status: 'unverified' },
    }]);
    expect(JSON.stringify(ledger)).not.toContain(name);
    expect(JSON.stringify(ledger)).not.toContain(created.slug);
  });
});


live('2. the same key replayed by the same account returns the same ids and writes nothing', async () => {
  await withClient(async (c) => {
    const who = await account(c);
    await as(c, who);
    const key = randomUUID();
    const first = await createOrg(c, `Example Workers Local 1 ${tag()}`, key);
    const before = await shellCounts(c, first.organizationId, who.user);
    const limits = await limiterRows(c, userScope(who.user));
    const replay = await createOrg(c, `Example Workers Local 1 ${tag()}`, key);
    expect(replay).toEqual({ ...first, idempotent: true });
    expect(await shellCounts(c, first.organizationId, who.user)).toEqual(before);
    expect(await limiterRows(c, userScope(who.user))).toEqual(limits);
    expect((await c.query('select count(*)::int as n from public.organizations where created_by=$1', [who.user])).rows[0].n).toBe(1);
  });
});


live('3. the same key from another account is refused as reused', async () => {
  await withClient(async (c) => {
    const first = await account(c);
    await as(c, first);
    const key = randomUUID();
    expect((await createOrg(c, `Example Workers Local 1 ${tag()}`, key)).status).toBe('created');
    const second = await account(c);
    await as(c, second);
    await expectRefusal(createOrg(c, `Example Workers Local 1 ${tag()}`, key), '22023', 'idempotency key reused');
    // A key already spent on another ledger event is not a replay either.
    const other = await verifiedOrg(c);
    const foreignKey = randomUUID();
    await c.query(
      `insert into public.organization_audit_ledger(organization_id,domain,event_type,action,actor_user_id,entity_type,entity_id,idempotency_key)
       values ($1,'administration','organization_catalog_placement_changed','update',$2,'organization',$3,$4)`,
      [other.org, second.user, other.org, foreignKey],
    );
    await expectRefusal(createOrg(c, `Example Workers Local 1 ${tag()}`, foreignKey), '22023', 'idempotency key reused');
    expect((await c.query('select count(*)::int as n from public.organizations where created_by=$1', [second.user])).rows[0].n).toBe(0);
  });
});


live('4. a call without a signed-in account is refused', async () => {
  await withClient(async (c) => {
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: 'authenticated' })]);
    await expectRefusal(createOrg(c, `Example Workers Local 1 ${tag()}`), '42501', 'authentication required');
  });
});


live('5. an account with a verified factor needs aal2; the same account at aal2 succeeds', async () => {
  await withClient(async (c) => {
    const low = await account(c, { factor: true, aal: 'aal1' });
    await as(c, low);
    await expectRefusal(createOrg(c, `Example Workers Local 1 ${tag()}`), '42501', 'mfa required');
    // A session row that does not exist is not a live session.
    await as(c, { ...low, session: randomUUID(), aal: 'aal2' });
    await expectRefusal(createOrg(c, `Example Workers Local 1 ${tag()}`), '42501', 'mfa required');
    const high = await session(c, { user: low.user }, 'aal2');
    await as(c, high);
    expect((await createOrg(c, `Example Workers Local 1 ${tag()}`)).status).toBe('created');
  });
});


live('6. an account without a confirmed email is refused', async () => {
  await withClient(async (c) => {
    const who = await account(c, { confirmed: false });
    await as(c, who);
    await expectRefusal(createOrg(c, `Example Workers Local 1 ${tag()}`), '42501', 'email confirmation required');
    // A banned or anonymous account is refused the same way.
    await c.query("update auth.users set email_confirmed_at = now(), banned_until = now() + interval '1 day' where id = $1", [who.user]);
    await expectRefusal(createOrg(c, `Example Workers Local 1 ${tag()}`), '42501', 'email confirmation required');
    await c.query('update auth.users set banned_until = null, is_anonymous = true where id = $1', [who.user]);
    await expectRefusal(createOrg(c, `Example Workers Local 1 ${tag()}`), '42501', 'email confirmation required');
    await c.query('update auth.users set is_anonymous = false where id = $1', [who.user]);
    expect((await createOrg(c, `Example Workers Local 1 ${tag()}`)).status).toBe('created');
    expect(await limiterRows(c, userScope(who.user))).toEqual([{ operation: 'user-create-day', request_count: 1 }]);
  });
});


live('7. an account with an active organization membership is refused and nothing is written', async () => {
  await withClient(async (c) => {
    const existing = await verifiedOrg(c);
    const who = await member(c, { org: existing.org, chapter: existing.chapter, factor: false });
    await as(c, who);
    await expectRefusal(createOrg(c, `Example Workers Local 1 ${tag()}`), '22023', 'organization membership exists');
    expect((await c.query('select count(*)::int as n from public.organizations where created_by=$1', [who.user])).rows[0].n).toBe(0);
    expect((await c.query('select chapter_id from public.member_profiles where id=$1', [who.user])).rows[0].chapter_id).toBe(existing.chapter);
    expect(await limiterRows(c, userScope(who.user))).toEqual([]);
  });
});


live('8. a taken name returns name_unavailable without the name or 23505, and the charge persists', async () => {
  await withClient(async (c) => {
    const suffix = tag();
    await unverifiedOrg(c, `Example Workers Local 1 ${suffix}`);
    const who = await account(c);
    await as(c, who);
    const answer = await createOrg(c, `example  workers LOCAL 1 ${suffix} `);
    expect(answer).toEqual({ status: 'name_unavailable' });
    expect(JSON.stringify(answer)).not.toMatch(/23505|example|workers/i);
    expect((await c.query('select count(*)::int as n from public.organizations where created_by=$1', [who.user])).rows[0].n).toBe(0);
    expect((await c.query('select chapter_id from public.member_profiles where id=$1', [who.user])).rows[0].chapter_id).toBeNull();
    expect(await limiterRows(c, userScope(who.user))).toEqual([{ operation: 'user-create-day', request_count: 1 }]);
    // An operator-provisioned organization's name is taken the same way.
    const other = await verifiedOrg(c);
    expect(await createOrg(c, other.name.toUpperCase())).toEqual({ status: 'name_unavailable' });
    // A tab before or a newline after the taken name is trimmed away, so the
    // name is still taken (a second account; the first spent two of its three).
    const again = await account(c);
    await as(c, again);
    expect(await createOrg(c, `\tExample Workers Local 1 ${suffix}`)).toEqual({ status: 'name_unavailable' });
    expect(await createOrg(c, `Example Workers Local 1 ${suffix}\n`)).toEqual({ status: 'name_unavailable' });
    expect(await createOrg(c, `Example\tWorkers \n Local 1 ${suffix}`)).toEqual({ status: 'name_unavailable' });
  });
});


live('9. invalid organization names are refused before any charge; the default chapter takes the cleaned name', async () => {
  await withClient(async (c) => {
    const who = await account(c);
    await as(c, who);
    for (const name of [
      'E', 'E'.repeat(121), `Example${cp(7)}Local`, 'Example @ Local', 'Example https://local',
      'Example Local 555 12-34', 'Example (555) 123 4567', 'Example Local 555/123_4567',
      // Punctuation only: no letter or digit.
      '--', '- . - ( )',
      // Invisible and format characters: zero-width space, a bidirectional
      // override, a byte-order mark, a soft hyphen.
      `Example${cp(0x200b)}Workers Local`, `Example ${cp(0x202e)}Workers Local`,
      `${cp(0xfeff)}Example Workers Local`, `Example Wor${cp(0xad)}kers Local`,
    ]) {
      await expectRefusal(createOrg(c, name), '22023', 'invalid organization');
    }
    expect(await limiterRows(c, userScope(who.user))).toEqual([]);
    // Accented and non-Latin letters are ordinary letters. Whitespace runs
    // collapse and the ends are trimmed; the default chapter takes the name.
    const suffix = tag();
    const created = await createOrg(c, `\tSindicato  de Tr${cp(0xe1)}nsito ${cp(0xd1)}and${cp(0xfa)} ${cp(0x4e2d)}\n ${suffix}\n`);
    expect(created.status).toBe('created');
    const stored = `Sindicato de Tr${cp(0xe1)}nsito ${cp(0xd1)}and${cp(0xfa)} ${cp(0x4e2d)} ${suffix}`;
    expect((await c.query('select name from public.organizations where id=$1', [created.organizationId])).rows[0].name).toBe(stored);
    expect((await c.query('select name from public.chapters where id=$1', [created.chapterId])).rows[0].name).toBe(stored);
  });
});


live('10. one self-created organization per account for life, even after its membership is revoked', async () => {
  await withClient(async (c) => {
    const who = await account(c);
    await as(c, who);
    const first = await createOrg(c, `Example Workers Local 1 ${tag()}`);
    expect(first.status).toBe('created');
    await c.query("update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2", [first.organizationId, who.user]);
    expect(await createOrg(c, `Example Workers Local 1 ${tag()}`)).toEqual({ status: 'limit_reached' });
    expect((await c.query('select count(*)::int as n from public.organizations where created_by=$1', [who.user])).rows[0].n).toBe(1);
  });
});


live('11. the fourth attempt in 24 hours returns limit_reached', async () => {
  await withClient(async (c) => {
    const taken = await verifiedOrg(c);
    const who = await account(c);
    await as(c, who);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await createOrg(c, taken.name)).toEqual({ status: 'name_unavailable' });
    }
    expect(await createOrg(c, `Example Workers Local 1 ${tag()}`)).toEqual({ status: 'limit_reached' });
    expect(await limiterRows(c, userScope(who.user))).toEqual([{ operation: 'user-create-day', request_count: 3 }]);
    // The window resets after 24 hours.
    await c.query("update private.open_signup_limits set window_started_at = now() - interval '25 hours' where scope_hash = $1", [userScope(who.user)]);
    expect((await createOrg(c, `Example Workers Local 1 ${tag()}`)).status).toBe('created');
  });
});


live('12. admits five organizations and refuses the sixth without creating shell rows', async () => {
  await withClient(async (c) => {
    const admitted = [];
    for (let i = 0; i < 5; i += 1) {
      const who = await account(c); await as(c, who);
      const key = randomUUID(); const created = await createOrg(c, `Example Intake ${tag()}`, key);
      expect(created.status).toBe('created'); admitted.push(created.organizationId);
      // A replay at capacity still succeeds without adding an admission.
      if (i === 4) expect(await createOrg(c, `Example Intake ${tag()}`, key)).toMatchObject({ organizationId: created.organizationId, idempotent: true });
    }
    const who = await account(c); await as(c, who);
    const before = (await c.query('select count(*) from public.organizations')).rows[0].count;
    expect(await createOrg(c, `Example Intake ${tag()}`)).toEqual({ status: 'unavailable' });
    expect((await c.query('select count(*) from public.organizations')).rows[0].count).toBe(before);
    expect((await c.query('select count(*)::int as n from private.open_signup_cohort_admissions where organization_id=any($1::uuid[])', [admitted])).rows[0].n).toBe(5);
  });
});


live('13. execute grants: anon, authenticated and service_role reach only their own entry points', async () => {
  await withClient(async (c) => {
    const privilege = async (role, sig) => (await c.query('select has_function_privilege($1,$2,$3) as ok', [role, sig, 'EXECUTE'])).rows[0].ok;
    const create = 'public.create_my_organization(text,uuid)';
    const consume = 'public.consume_open_signup_limit(text,text)';
    const available = 'public.open_signup_email_available(text)';
    const internals = [
      'private.consume_open_signup_limit_internal(text,text)',
      'private.enforce_unverified_organization_boundary()',
      'private.open_signup_is_open()',
    ];
    expect(await privilege('anon', create)).toBe(false);
    expect(await privilege('authenticated', create)).toBe(true);
    expect(await privilege('service_role', create)).toBe(false);
    for (const sig of [consume, available]) {
      expect(await privilege('anon', sig)).toBe(false);
      expect(await privilege('authenticated', sig)).toBe(false);
      expect(await privilege('service_role', sig)).toBe(true);
    }
    for (const sig of internals) {
      for (const role of ['anon', 'authenticated', 'service_role']) expect(await privilege(role, sig), `${role} ${sig}`).toBe(false);
    }
    // The boundary predicate is a policy helper: authenticated only.
    expect(await privilege('anon', 'private.organization_clears_signup_boundary(uuid)')).toBe(false);
    expect(await privilege('authenticated', 'private.organization_clears_signup_boundary(uuid)')).toBe(true);
    expect(await privilege('service_role', 'private.organization_clears_signup_boundary(uuid)')).toBe(false);
    await expectRefusal(rpc(c, 'public.create_my_organization($1,$2)', ['Example Workers Local 1', randomUUID()], 'anon'), '42501');
    const who = await account(c);
    await as(c, who);
    await expectRefusal(rpc(c, 'public.consume_open_signup_limit($1,$2)', [sha256('x'), 'network-hour']), '42501');
    await expectRefusal(rpc(c, 'public.open_signup_email_available($1)', [sha256('x')]), '42501');
    await asServiceRole(c);
    expect(await rpc(c, 'public.consume_open_signup_limit($1,$2)', [sha256(`net-${tag()}`), 'network-hour'], 'service_role')).toBe(true);
    expect(await rpc(c, 'public.open_signup_email_available($1)', [sha256(`nobody-${tag()}@example.invalid`)], 'service_role')).toBe(true);
    // The service-role wrappers refuse a caller whose token is not service_role.
    await as(c, who);
    await expectRefusal(rpc(c, 'public.consume_open_signup_limit($1,$2)', [sha256('x'), 'network-hour'], 'service_role'), '42501', 'service role required');
    await expectRefusal(rpc(c, 'public.open_signup_email_available($1)', [sha256('x')], 'service_role'), '42501', 'service role required');
  });
});


live('14. organization_clears_signup_boundary: provisioned true, self-created false until verified, null and unknown false', async () => {
  await withClient(async (c) => {
    const verified = await verifiedOrg(c);
    const shell = await unverifiedOrg(c);
    const check = async (org) => (await c.query('select private.organization_clears_signup_boundary($1) as v', [org])).rows[0].v;
    expect(await check(verified.org)).toBe(true);
    expect(await check(shell.org)).toBe(false);
    await setVerified(c, shell.org, true);
    expect(await check(shell.org)).toBe(true);
    expect(await check(null)).toBe(false);
    expect(await check(randomUUID())).toBe(false);
    // verified_at needs a self-created organization.
    await expectRefusal(owner(c, 'update public.organizations set verified_at = now() where id = $1', [verified.org]), '23514');
  });
});


live('15. G1: an unverified organization cannot request a registry binding; a verified one can', async () => {
  await withClient(async (c) => {
    const key = await unionOrg(c, 1);
    const shell = await unverifiedOrg(c);
    const verified = await verifiedOrg(c);
    await as(c, shell.admin);
    await expectRefusal(rpc(c, 'public.request_chapter_union_org_binding($1)', [key]), '42501', VERIFICATION);
    await as(c, verified.admin);
    expect(await rpc(c, 'public.request_chapter_union_org_binding($1)', [key])).toMatchObject({ requested: true, chapterId: verified.chapter });
    // The owner cannot bind the unverified chapter either.
    await expectRefusal(owner(c, "insert into public.chapter_union_org_bindings(chapter_id,union_org_id,status) values ($1,$2,'requested')", [shell.chapter, await unionOrg(c, 2)]), '42501', VERIFICATION);
  });
});


live('16. G2: an unverified organization cannot start a handshake or be named as the receiving chapter', async () => {
  await withClient(async (c) => {
    const partner = await onboardedPartner(c, 3);
    const shell = await unverifiedOrg(c);
    const verified = await verifiedOrg(c);
    const request = (key) => rpc(c, 'public.request_chapter_handshake($1,$2,$3,$4,$5)', [key, 'Example exchange', 'Share meeting notes', 'docs_only', randomUUID()]);
    const unbound = await unionOrg(c, 6);
    const writes = async () => (await c.query(
      `select (select count(*)::int from public.chapter_handshakes where chapter_id = $1) as handshakes,
              (select count(*)::int from public.chapter_handshake_events where actor_chapter_id = $1) as events`,
      [shell.chapter])).rows[0];
    // The unverified organization's staff get one answer whether or not the
    // catalog id has a verified binding, and nothing is written.
    await as(c, shell.admin);
    const bound = await expectRefusal(request(partner.key), '22023', 'partner is not onboarded for two-sided requests');
    const none = await expectRefusal(request(unbound), '22023', 'partner is not onboarded for two-sided requests');
    expect({ code: none.code, message: none.message }).toEqual({ code: bound.code, message: bound.message });
    expect(await writes()).toEqual({ handshakes: 0, events: 0 });
    // Control: a verified caller still reaches the binding lookup.
    await as(c, verified.admin);
    await expectRefusal(request(unbound), '22023', 'partner is not onboarded for two-sided requests');
    expect(await request(partner.key)).toMatchObject({ chapter_id: verified.chapter, receiving_chapter_id: partner.chapter });
    await c.query("select set_config('request.jwt.claims','',true)");
    // The boundary trigger still refuses a direct write from either side.
    await expectRefusal(owner(c,
      `insert into public.chapter_handshakes(chapter_id,receiving_chapter_id,partner_org_id,title,purpose,data_scope,status)
       values ($1,$2,$3,'Example','Example purpose','docs_only','requested')`,
      [shell.chapter, partner.chapter, partner.key]), '42501', VERIFICATION);
    await expectRefusal(owner(c,
      `insert into public.chapter_handshakes(chapter_id,receiving_chapter_id,partner_org_id,title,purpose,data_scope,status)
       values ($1,$2,$3,'Example','Example purpose','docs_only','requested')`,
      [partner.chapter, shell.chapter, partner.key]), '42501', VERIFICATION);
  });
});


live('17. G3: partnered coordination records need both organizations verified', async () => {
  await withClient(async (c) => {
    const shell = await unverifiedOrg(c);
    const verified = await verifiedOrg(c);
    const second = await verifiedOrg(c);
    // A partner must be one the caller can already see (#8365,
    // an owner decision): the second organization is listed in the
    // network directory.
    await c.query("insert into public.organization_network_directory_profiles(organization_id,display_name,visibility,contact_mode) values ($1,$2,'directory','disabled')", [second.org, second.name]);
    await as(c, shell.admin);
    await expectRefusal(createRecord(c, 'network_link', verified.org), '42501', VERIFICATION);
    // Work inside its own walls is unaffected.
    expect(await createRecord(c, 'mission')).toMatchObject({ kind: 'mission', organizationId: shell.org });
    await as(c, verified.admin);
    // The unverified organization is not discoverable, so naming it reads as
    // naming an organization that does not exist.
    await expectRefusal(createRecord(c, 'network_link', shell.org), '22023', 'partner organization unavailable');
    expect(await createRecord(c, 'network_link', second.org)).toMatchObject({ kind: 'network_link', status: 'requested' });
  });
});


live('18. G4: coalition invitations cannot cross an unverified organization', async () => {
  await withClient(async (c) => {
    const shell = await unverifiedOrg(c);
    const verified = await verifiedOrg(c);
    const second = await verifiedOrg(c);
    await as(c, shell.admin);
    const own = await createRecord(c, 'coalition');
    await expectRefusal(invite(c, own.id, verified.org), '42501', VERIFICATION);
    await as(c, verified.admin);
    const theirs = await createRecord(c, 'coalition');
    await expectRefusal(invite(c, theirs.id, shell.org), '42501', VERIFICATION);
    expect(await invite(c, theirs.id, second.org)).toMatchObject({ invited: true, organizationId: second.org });
  });
});


live('19. G5: network permissions cannot be granted to or from an unverified organization', async () => {
  await withClient(async (c) => {
    const verified = await verifiedOrg(c);
    const shell = await unverifiedOrg(c);
    // The network was set up while the shell counted as verified; later it
    // no longer does.
    await setVerified(c, shell.org, true);
    const record = await activeNetwork(c, verified, shell);
    await as(c, verified.admin);
    expect(await rpc(c, 'public.set_organization_network_permission($1,$2,$3,$4)', [record, shell.org, 'directory_contact', true])).toMatchObject({ saved: true });
    await setVerified(c, shell.org, false);
    await expectRefusal(rpc(c, 'public.set_organization_network_permission($1,$2,$3,$4)', [record, shell.org, 'resource_share', true]), '42501', VERIFICATION);
    await expectRefusal(owner(c,
      `insert into public.organization_network_permission_grants(network_record_id,grantor_organization_id,grantee_organization_id,capability,status)
       values ($1,$2,$3,'oversight','active')`, [record, shell.org, verified.org]), '42501', VERIFICATION);
  });
});


live('20. G6: an unverified organization keeps a private directory profile only', async () => {
  await withClient(async (c) => {
    const shell = await unverifiedOrg(c);
    const verified = await verifiedOrg(c);
    const upsert = (visibility) => rpc(c, 'public.upsert_organization_network_profile($1,$2,$3,$4,$5)', ['Example Workers Local 1', '', visibility, 'disabled', null]);
    await as(c, shell.admin);
    await expectRefusal(upsert('directory'), '42501', VERIFICATION);
    await expectRefusal(upsert('partners'), '42501', VERIFICATION);
    expect(await upsert('private')).toMatchObject({ saved: true, visibility: 'private' });
    await expectRefusal(owner(c, 'update public.organization_network_directory_profiles set parent_organization_id = $2 where organization_id = $1', [shell.org, verified.org]), '42501', VERIFICATION);
    await as(c, verified.admin);
    expect(await upsert('directory')).toMatchObject({ saved: true, visibility: 'directory' });
  });
});


live('21. G7: an unverified organization cannot write public site records; legacy rows stay writable', async () => {
  await withClient(async (c) => {
    const shell = await unverifiedOrg(c);
    const verified = await verifiedOrg(c);
    await as(c, shell.admin);
    await expectRefusal(publish(c, shell.chapter), '42501', VERIFICATION);
    await c.query("select set_config('request.jwt.claims','',true)");
    await expectRefusal(owner(c,
      `insert into public.public_site_records(id,kind,title_en,title_es,body_en,body_es,sort_order,is_published,organization_id)
       values ($1,'chapter','Example','Ejemplo','Example body','Cuerpo',1,false,$2)`, [shell.chapter, shell.org]), '42501', VERIFICATION);
    await as(c, verified.admin);
    expect(await publish(c, verified.chapter)).toMatchObject({ saved: true, published: true });
    await c.query("select set_config('request.jwt.claims','',true)");
    const legacy = `legacy-${tag()}`;
    await c.query(
      `insert into public.public_site_records(id,kind,title_en,title_es,body_en,body_es,sort_order,is_published)
       values ($1,'chapter','Example','Ejemplo','Example body','Cuerpo',1,false)`, [legacy]);
    expect((await owner(c, "update public.public_site_records set title_en = 'Example legacy' where id = $1", [legacy])).rowCount).toBe(1);
    // Anonymous public reads never show the unverified organization.
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: 'anon' })]);
    const reads = [
      await rpc(c, 'public.get_public_directory($1)', ['en'], 'anon'),
      await rpc(c, 'public.get_public_site_content($1)', ['en'], 'anon'),
      await rpc(c, 'public.get_public_chapter_microsite($1,$2)', [shell.chapter, 'en'], 'anon').catch((error) => ({ refused: error.code })),
    ];
    const text = JSON.stringify(reads);
    expect(text).not.toContain(shell.name);
    expect(text).not.toContain(shell.chapter);
    expect(text).not.toContain(shell.org);
    expect(text).toContain(verified.chapter);
  });
});


live('22. G8: an unverified organization cannot start a Stripe connection', async () => {
  await withClient(async (c) => {
    const shell = await unverifiedOrg(c);
    const verified = await verifiedOrg(c);
    const save = (org, requester) => rpc(c, 'public.save_dues_stripe_oauth_state($1,$2,$3,$4,$5,$6,$7)', [
      sha256(`state-${randomUUID()}`), org, requester, 'admin', sha256(`browser-${randomUUID()}`),
      'https://demo.example.com/api/dues-stripe-connect', new Date(Date.now() + 5 * 60 * 1000),
    ], 'service_role');
    await asServiceRole(c);
    await expectRefusal(save(shell.org, shell.admin.user), '42501', VERIFICATION);
    await save(verified.org, verified.admin.user);
    expect((await c.query('select count(*)::int as n from private.dues_stripe_oauth_states where organization_id = $1', [verified.org])).rows[0].n).toBe(1);
    await c.query("select set_config('request.jwt.claims','',true)");
    await expectRefusal(owner(c, "insert into public.dues_provider_connections(organization_id,provider,state) values ($1,'stripe_dues','pending')", [shell.org]), '42501', VERIFICATION);
    expect((await owner(c, "insert into public.dues_provider_connections(organization_id,provider,state) values ($1,'stripe_dues','pending')", [verified.org])).rowCount).toBe(1);
  });
});


live('23. G9: an unverified organization is capped at 20 invitations a day and 200 in total', async () => {
  await withClient(async (c) => {
    const shell = await unverifiedOrg(c);
    const verified = await verifiedOrg(c);
    const inviteFrom = (org) => rpc(c, 'public.create_member_invitation($1,$2,$3,$4,$5,$6)', [`invitee-${randomUUID()}@example.invalid`, 'Example Invitee', org.chapter, null, 'en', sha256(randomUUID())]);
    await as(c, shell.admin);
    expect(await inviteFrom(shell)).toMatchObject({ accepted: true });
    await seedInvitations(c, shell.chapter, 19, '1 hour');
    await as(c, shell.admin);
    await expectRefusal(inviteFrom(shell), 'P0001', 'invitation rate limited');
    // Older invitations count only toward the lifetime cap.
    await c.query("update public.member_invitations set created_at = now() - interval '2 days' where chapter_id = $1", [shell.chapter]);
    expect(await inviteFrom(shell)).toMatchObject({ accepted: true });
    await seedInvitations(c, shell.chapter, 179, '3 days');
    await as(c, shell.admin);
    await expectRefusal(inviteFrom(shell), 'P0001', 'invitation rate limited');
    await seedInvitations(c, verified.chapter, 250, '1 hour');
    await as(c, verified.admin);
    expect(await inviteFrom(verified)).toMatchObject({ accepted: true });
  });
});


live('24. R1: an unverified organization discovers no other directory profile; a verified one does', async () => {
  await withClient(async (c) => {
    const listed = await verifiedOrg(c);
    const viewer = await verifiedOrg(c);
    const shell = await unverifiedOrg(c);
    await c.query("insert into public.organization_network_directory_profiles(organization_id,display_name,visibility,contact_mode) values ($1,'Example Transit Local 2','directory','disabled')", [listed.org]);
    await c.query("insert into public.organization_network_directory_profiles(organization_id,display_name,visibility,contact_mode) values ($1,'Example Workers Local 1','private','disabled')", [shell.org]);
    await c.query("insert into public.organization_network_directory_profiles(organization_id,display_name,visibility,contact_mode) values ($1,'Example Viewer Local','private','disabled')", [viewer.org]);
    const directory = async (who) => {
      await as(c, who);
      return (await rpc(c, 'public.get_organization_coordination_extensions()')).directory.map((row) => row.organizationId).sort();
    };
    expect(await directory(shell.admin)).toEqual([shell.org]);
    expect(await directory(viewer.admin)).toEqual([listed.org, viewer.org].sort());
    expect(await directory(listed.admin)).toEqual([listed.org]);
  });
});


live('25. R2: staff of an unverified organization read only their own binding rows', async () => {
  await withClient(async (c) => {
    const partner = await onboardedPartner(c, 4);
    const viewer = await verifiedOrg(c);
    const shell = await unverifiedOrg(c);
    // The shell's binding was written while it counted as verified.
    await setVerified(c, shell.org, true);
    await c.query("insert into public.chapter_union_org_bindings(chapter_id,union_org_id,status) values ($1,$2,'requested')", [shell.chapter, await unionOrg(c, 5)]);
    await setVerified(c, shell.org, false);
    const visible = async (who) => {
      await as(c, who);
      await c.query('savepoint read_bindings');
      await c.query('set local role authenticated');
      const rows = (await c.query('select chapter_id from public.chapter_union_org_bindings where chapter_id = any($1) order by chapter_id', [[partner.chapter, shell.chapter, viewer.chapter]])).rows.map((row) => row.chapter_id);
      await c.query('rollback to savepoint read_bindings');
      await c.query('release savepoint read_bindings');
      return rows;
    };
    expect(await visible(shell.admin)).toEqual([shell.chapter]);
    expect(await visible(viewer.admin)).toEqual([partner.chapter]);
    await setVerified(c, shell.org, true);
    expect(await visible(shell.admin)).toEqual([partner.chapter, shell.chapter].sort());
  });
});


live('26. signup metadata never places a new account in a chapter without a matching invitation', async () => {
  await withClient(async (c) => {
    // This negative auth case needs an ownerless scope even after the legacy
    // seed chapters are retired. Create only this transaction's Tamarack fixture;
    // restore the write trigger before exercising auth, keeping the ID CHECK on.
    const orphan = `tamarack-signup-unclaimed-${tag()}`;
    await c.query('alter table public.chapters disable trigger chapters_forbid_ownerless_write');
    await c.query('insert into public.chapters(id,name,slug,order_index) values ($1,$2,$1,9902)', [orphan, 'Tamarack unclaimed chapter']);
    await c.query('alter table public.chapters enable trigger chapters_forbid_ownerless_write');
    const verified = await verifiedOrg(c);
    const guessed = randomUUID();
    await c.query("insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,jsonb_build_object('chapter_id',$3::text))", [guessed, `${guessed}@example.invalid`, orphan]);
    const guessedOrg = randomUUID();
    await c.query("insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,jsonb_build_object('chapter_id',$3::text))", [guessedOrg, `${guessedOrg}@example.invalid`, verified.chapter]);
    const state = async (user) => (await c.query(
      `select (select chapter_id from public.member_profiles where id = $1) as chapter,
              (select count(*)::int from public.member_chapter_memberships where user_id = $1) as chapters,
              (select count(*)::int from public.organization_memberships where user_id = $1) as organizations`, [user])).rows[0];
    expect(await state(guessed)).toEqual({ chapter: null, chapters: 0, organizations: 0 });
    expect(await state(guessedOrg)).toEqual({ chapter: null, chapters: 0, organizations: 0 });
    // A matching accepting invitation still enrolls the account.
    const invited = randomUUID();
    const invitation = randomUUID();
    await c.query(
      `insert into public.member_invitations(id,normalized_email,full_name,first_name,initials,chapter_id,locale,token_hash,status,accepting_at,expires_at)
       values ($1,$2,'Example Invitee','Example','EI',$3,'en',$4,'accepting',now(),now() + interval '15 minutes')`,
      [invitation, `${invited}@example.invalid`, verified.chapter, sha256(invitation)],
    );
    await c.query(
      "insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,jsonb_build_object('chapter_id',$3::text,'union_base_invitation_id',$4::text))",
      [invited, `${invited}@example.invalid`, verified.chapter, invitation],
    );
    expect(await state(invited)).toEqual({ chapter: verified.chapter, chapters: 1, organizations: 1 });
  });
});


live('27. an unverified admin cannot pull a verified organization\'s member in or recover their sign-in', async () => {
  await withClient(async (c) => {
    const verified = await verifiedOrg(c);
    const shell = await unverifiedOrg(c);
    // A coordinator of the verified organization with no selected chapter.
    const coordinator = await account(c);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [verified.org, coordinator.user]);
    await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'coordinator')", [verified.org, coordinator.user]);
    await as(c, shell.admin);
    await expectRefusal(rpc(c, 'public.grant_member_chapter_membership($1,$2)', [coordinator.user, shell.chapter]), '22023', 'membership target unavailable');
    await expectRefusal(rpc(c, 'public.begin_member_signin_recovery($1,$2,$3)', [coordinator.user, sha256(`new-${coordinator.user}@example.invalid`), 'lost_inbox']), '42501', 'recovery unavailable');
    expect((await c.query(
      `select (select chapter_id from public.member_profiles where id = $1) as chapter,
              (select count(*)::int from public.organization_memberships where user_id = $1 and organization_id = $2) as rows`,
      [coordinator.user, shell.org])).rows[0]).toEqual({ chapter: null, rows: 0 });
    // Control: the verified organization's own admin can add its member to
    // its chapter and then begin sign-in recovery for them.
    await as(c, verified.admin);
    expect(await rpc(c, 'public.grant_member_chapter_membership($1,$2)', [coordinator.user, verified.chapter]))
      .toMatchObject({ userId: coordinator.user, chapterId: verified.chapter, active: true });
    expect(await rpc(c, 'public.begin_member_signin_recovery($1,$2,$3)', [coordinator.user, sha256(`new-${coordinator.user}@example.invalid`), 'lost_inbox']))
      .toMatchObject({ accepted: true, retry: false });
  });
});


live('28. consume_open_signup_limit: fixed windows, refusals and pruning', async () => {
  await withClient(async (c) => {
    await asServiceRole(c);
    const consume = (scope, operation) => rpc(c, 'public.consume_open_signup_limit($1,$2)', [scope, operation], 'service_role');
    const scope = sha256(`network-${randomUUID()}`);
    const answers = [];
    for (let i = 0; i < 6; i += 1) answers.push(await consume(scope, 'network-hour'));
    expect(answers).toEqual([true, true, true, true, true, false]);
    expect(await consume(scope, 'network-day')).toBe(true);
    await expectRefusal(consume(scope, 'network-week'), '22023', 'invalid signup limit');
    await expectRefusal(consume(null, 'network-hour'), '22023', 'invalid signup limit');
    await expectRefusal(consume('not-a-hash', 'network-hour'), '22023', 'invalid signup limit');
    await expectRefusal(consume(scope.toUpperCase(), 'network-hour'), '22023', 'invalid signup limit');
    await expectRefusal(consume(scope, 'user-create-day'), '22023', 'invalid signup limit');
    const stale = sha256(`stale-${randomUUID()}`);
    await c.query("insert into private.open_signup_limits(scope_hash,operation,window_started_at,request_count) values ($1,'email-day',now() - interval '3 days',2)", [stale]);
    expect(await consume(sha256(`other-${randomUUID()}`), 'email-day')).toBe(true);
    expect((await c.query('select count(*)::int as n from private.open_signup_limits where scope_hash = $1', [stale])).rows[0].n).toBe(0);
    const rows = (await c.query('select scope_hash from private.open_signup_limits')).rows;
    expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.scope_hash))).toBe(true);
  });
});


live('29. open_signup_email_available: taken by an account or a pending invitation, case and space insensitive', async () => {
  await withClient(async (c) => {
    const verified = await verifiedOrg(c);
    const existing = `Existing-${tag()}@Example.invalid`;
    await c.query('insert into auth.users(id,email) values ($1,$2)', [randomUUID(), ` ${existing} `]);
    const pending = `pending-${tag()}@example.invalid`;
    await c.query(
      `insert into public.member_invitations(normalized_email,full_name,first_name,initials,chapter_id,locale,token_hash,status,expires_at)
       values ($1,'Example Invitee','Example','EI',$2,'en',$3,'pending',now() + interval '15 minutes')`,
      [pending, verified.chapter, sha256(pending)],
    );
    const revoked = `revoked-${tag()}@example.invalid`;
    await c.query(
      `insert into public.member_invitations(normalized_email,full_name,first_name,initials,chapter_id,locale,status,expires_at,revoked_at)
       values ($1,'Example Invitee','Example','EI',$2,'en','revoked',now(),now())`,
      [revoked, verified.chapter],
    );
    await asServiceRole(c);
    const available = (email) => rpc(c, 'public.open_signup_email_available($1)', [sha256(email)], 'service_role');
    expect(await available(existing.toLowerCase())).toBe(false);
    expect(await available(pending)).toBe(false);
    expect(await available(revoked)).toBe(true);
    expect(await available(`fresh-${tag()}@example.invalid`)).toBe(true);
    expect(await rpc(c, 'public.open_signup_email_available($1)', [` ${sha256(existing.toLowerCase()).toUpperCase()} `], 'service_role')).toBe(false);
    await expectRefusal(rpc(c, 'public.open_signup_email_available($1)', ['not-a-hash'], 'service_role'), '22023', 'invalid email hash');
  });
});
