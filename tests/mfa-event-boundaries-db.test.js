// @vitest-environment node
import pg from "pg";
import { expect, it } from "vitest";

const databaseIt = process.env.RUN_MFA_EVENT_BOUNDARY_DB_TESTS === "1" ? it : it.skip;

const ids = {
  admin: "50930000-0000-4000-8000-000000000001",
  target: "50930000-0000-4000-8000-000000000002",
  member: "50930000-0000-4000-8000-000000000003",
  adminSession: "50930000-0000-4000-8000-000000000011",
  targetOldSession: "50930000-0000-4000-8000-000000000012",
  targetFreshSession: "50930000-0000-4000-8000-000000000013",
  memberSession: "50930000-0000-4000-8000-000000000014",
  adminFactor: "50930000-0000-4000-8000-000000000021",
  targetFactor: "50930000-0000-4000-8000-000000000022",
  orgA: "50930000-0000-4000-8000-000000000101",
  orgB: "50930000-0000-4000-8000-000000000102",
};

const events = {
  sameTenant: "security-proof-same-tenant-event",
  foreignTenant: "security-proof-foreign-tenant-event",
};

const resetOutcomes = [
  { label: "logout_success", removesSession: true },
  { label: "logout_http_failure", removesSession: false },
  { label: "logout_timeout", removesSession: false },
];

function claims(userId, sessionId, aal = "aal2") {
  return { sub: userId, session_id: sessionId, role: "authenticated", aal };
}

async function asRole(client, role, jwt = { role }) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(jwt)]);
  await client.query(`set local role ${role}`);
}

async function expectState(client, label, sql, values, expectedState) {
  const savepoint = `proof_${label.replace(/[^a-z0-9]/gi, "_")}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(sql, values);
    throw new Error(`${label}: expected SQLSTATE ${expectedState}`);
  } catch (error) {
    expect(error.code, `${label}: ${error.message}`).toBe(expectedState);
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

databaseIt("enforces the reset logout matrix and tenant-first event access in the real catalog", async () => {
  const rawUrl = process.env.SUPABASE_DB_URL;
  expect(rawUrl).toBeTruthy();
  const url = new URL(rawUrl);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);

  const client = new pg.Client({
    connectionString: rawUrl,
    application_name: "mfa-event-boundaries-rollback-proof",
  });
  await client.connect();
  await client.query("begin");
  try {
    await client.query(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ($1, 'mfa-boundary-admin@example.invalid', '{}'::jsonb),
        ($2, 'mfa-boundary-target@example.invalid', '{}'::jsonb),
        ($3, 'event-boundary-member@example.invalid', '{}'::jsonb)
    `, [ids.admin, ids.target, ids.member]);
    await client.query(`
      insert into public.organizations (id, slug, name, created_by) values
        ($1, 'security-proof-org-a', 'Security Proof Organization A', $3),
        ($2, 'security-proof-org-b', 'Security Proof Organization B', $3)
    `, [ids.orgA, ids.orgB, ids.admin]);
    await client.query(`
      insert into public.chapters
        (id, name, slug, region, is_default, order_index, organization_id)
      values
        ('security-proof-a1', 'Security Proof A1', 'security-proof-a1', 'shared-proof-region', false, 9101, $1),
        ('security-proof-a2', 'Security Proof A2', 'security-proof-a2', 'shared-proof-region', false, 9102, $1),
        ('security-proof-b1', 'Security Proof B1', 'security-proof-b1', 'shared-proof-region', false, 9103, $2)
    `, [ids.orgA, ids.orgB]);
    await client.query(`
      insert into public.organization_memberships (organization_id, user_id, status) values
        ($1, $2, 'active'), ($1, $3, 'active'), ($1, $4, 'active')
    `, [ids.orgA, ids.admin, ids.target, ids.member]);
    await client.query(`
      insert into public.member_chapter_memberships (user_id, chapter_id, status) values
        ($1, 'security-proof-a1', 'active'),
        ($2, 'security-proof-a1', 'active'),
        ($3, 'security-proof-a1', 'active')
    `, [ids.admin, ids.target, ids.member]);
    await client.query(`
      update public.member_profiles
      set chapter_id = 'security-proof-a1'
      where id = any($1::uuid[])
    `, [[ids.admin, ids.target, ids.member]]);
    await client.query(`
      insert into public.member_roles (user_id, role, chapter_id)
      values ($1, 'admin', 'security-proof-a1')
    `, [ids.admin]);
    await client.query(`
      insert into public.member_role_chapters (user_id, role, chapter_id)
      values ($1, 'admin', 'security-proof-a1')
    `, [ids.admin]);
    await client.query(`
      insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
        ($1, $4, now() - interval '1 hour', now(), 'aal2'),
        ($2, $5, now() - interval '1 day', now(), 'aal2'),
        ($3, $6, now() - interval '1 hour', now(), 'aal1')
    `, [
      ids.adminSession, ids.targetOldSession, ids.memberSession,
      ids.admin, ids.target, ids.member,
    ]);
    await client.query(`
      insert into auth.mfa_factors
        (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      values
        ($1, $3, 'admin-proof-totp', 'totp', 'verified', now(), now()),
        ($2, $4, 'target-proof-totp', 'totp', 'verified', now(), now())
    `, [ids.adminFactor, ids.targetFactor, ids.admin, ids.target]);

    // The claims object is deliberately reused for all three provider outcomes:
    // a signed pre-reset access token does not change when GoTrue logout
    // succeeds, returns an HTTP error, or times out.
    const targetOldJwt = claims(ids.target, ids.targetOldSession, "aal1");
    for (const outcome of resetOutcomes) {
      await asRole(client, "postgres");
      await client.query("delete from auth.sessions where id = $1", [ids.targetOldSession]);
      await client.query(`
        insert into auth.sessions (id, user_id, created_at, updated_at, aal)
        values ($1, $2, now() - interval '1 day', now(), 'aal1')
      `, [ids.targetOldSession, ids.target]);
      await client.query("delete from auth.mfa_factors where id = $1", [ids.targetFactor]);
      await client.query(`
        insert into auth.mfa_factors
          (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
        values ($1, $2, 'target-proof-totp', 'totp', 'verified', now(), now())
      `, [ids.targetFactor, ids.target]);

      await asRole(client, "authenticated", claims(ids.admin, ids.adminSession));
      const authorization = (await client.query(
        "select public.begin_mfa_reset($1) as value",
        [ids.target],
      )).rows[0].value;
      expect(authorization, outcome.label).toMatchObject({
        userId: ids.target,
        authorized: true,
        staleSessionsBlocked: true,
      });

      await asRole(client, "postgres");
      await client.query("delete from auth.mfa_factors where id = $1", [ids.targetFactor]);
      if (outcome.removesSession) {
        await client.query("delete from auth.sessions where id = $1", [ids.targetOldSession]);
      }
      const retainedSessions = (await client.query(
        "select count(*)::integer as count from auth.sessions where id = $1",
        [ids.targetOldSession],
      )).rows[0].count;
      expect(retainedSessions, outcome.label).toBe(outcome.removesSession ? 0 : 1);

      await asRole(client, "authenticated", targetOldJwt);
      expect(
        (await client.query("select private.mfa_satisfied() as value")).rows[0].value,
        outcome.label,
      ).toBe(false);
      await expectState(
        client,
        `${outcome.label}_protected_rpc`,
        "select public.rotate_calendar_feed_token()",
        [],
        "42501",
      );
      const visibleOwnProfile = await client.query(
        "select id from public.member_profiles where id = $1",
        [ids.target],
      );
      expect(visibleOwnProfile.rows, `${outcome.label}: RLS must hide the owned row`).toEqual([]);

      await asRole(client, "postgres");
      const mintedTokens = (await client.query(
        "select count(*)::integer as count from public.member_calendar_feed_tokens where user_id = $1",
        [ids.target],
      )).rows[0].count;
      expect(mintedTokens, `${outcome.label}: denied RPC must not mint a token`).toBe(0);
    }

    await asRole(client, "postgres");
    await client.query(`
      insert into auth.sessions (id, user_id, created_at, updated_at, aal)
      select $1, $2, invalid_before + interval '1 second', now(), 'aal1'
      from private.member_mfa_reset_boundaries where user_id = $2
    `, [ids.targetFreshSession, ids.target]);
    await asRole(client, "authenticated", claims(ids.target, ids.targetFreshSession, "aal1"));
    expect((await client.query("select private.mfa_satisfied() as value")).rows[0].value).toBe(true);
    expect((await client.query(
      "select id from public.member_profiles where id = $1",
      [ids.target],
    )).rows).toEqual([{ id: ids.target }]);
    expect((await client.query(
      "select public.rotate_calendar_feed_token() as value",
    )).rows[0].value.token).toMatch(/^[0-9a-f]{48}$/);

    // A fresh session becoming authorized must not rehabilitate the unchanged
    // pre-reset token retained by the failure and timeout paths.
    await asRole(client, "authenticated", targetOldJwt);
    expect((await client.query("select private.mfa_satisfied() as value")).rows[0].value).toBe(false);
    expect((await client.query(
      "select id from public.member_profiles where id = $1",
      [ids.target],
    )).rows).toEqual([]);
    await expectState(
      client,
      "old_token_after_fresh_session_protected_rpc",
      "select public.rotate_calendar_feed_token()",
      [],
      "42501",
    );

    await asRole(client, "postgres");
    await client.query(`
      insert into public.member_events
        (id, title, starts_at, location, summary, check_in_code, order_index,
         chapter_id, is_public, is_public_across_agencies)
      values
        ($1, 'Same tenant event', now(), 'A2', 'Same organization proof', 'SG-A100', 9201,
         'security-proof-a2', true, false),
        ($2, 'Foreign tenant event', now(), 'B1', 'Foreign organization proof', 'SG-B100', 9202,
         'security-proof-b1', true, true)
    `, [events.sameTenant, events.foreignTenant]);
    await client.query(`
      insert into public.member_event_rsvps (event_id, user_id, status)
      values ($1, $2, 'going')
    `, [events.foreignTenant, ids.member]);
    await client.query(`
      insert into public.member_event_checkins (event_id, user_id)
      values ($1, $2)
    `, [events.foreignTenant, ids.member]);
    const feedToken = "security-proof-calendar-token-0000000000000001";
    await client.query(`
      insert into public.member_calendar_feed_tokens (user_id, token_hash, rotated_at)
      values ($1, private.calendar_feed_token_hash($2), now())
    `, [ids.member, feedToken]);

    await asRole(client, "authenticated", claims(ids.member, ids.memberSession, "aal1"));
    const visibleEvents = await client.query(
      "select id from public.member_events where id = any($1::text[]) order by id",
      [[events.sameTenant, events.foreignTenant]],
    );
    expect(visibleEvents.rows).toEqual([{ id: events.sameTenant }]);
    expect((await client.query(
      "select event_id from public.member_event_rsvps where event_id = $1",
      [events.foreignTenant],
    )).rows).toEqual([]);
    expect((await client.query(
      "select event_id from public.member_event_checkins where event_id = $1",
      [events.foreignTenant],
    )).rows).toEqual([]);

    for (const [label, statement, values] of [
      ["foreign_rsvp", "select public.rsvp_to_event($1, 'going')", [events.foreignTenant]],
      ["foreign_checkin", "select public.check_in_to_event($1, 'SG-B100')", [events.foreignTenant]],
      ["foreign_token", "select public.request_event_checkin_token($1)", [events.foreignTenant]],
    ]) await expectState(client, label, statement, values, "22023");

    expect((await client.query(
      "select public.rsvp_to_event($1, 'going') as value",
      [events.sameTenant],
    )).rows[0].value.status).toBe("going");
    expect((await client.query(
      "select public.check_in_to_event($1, 'SG-A100') as value",
      [events.sameTenant],
    )).rows[0].value.checkedIn).toBe(true);
    expect((await client.query(
      "select public.request_event_checkin_token($1) as value",
      [events.sameTenant],
    )).rows[0].value.token).toMatch(/^[0-9A-HJKMNP-TV-Z]{7}$/);

    await asRole(client, "service_role", { role: "service_role" });
    const feed = (await client.query(
      "select public.get_calendar_feed_events($1) as value",
      [feedToken],
    )).rows[0].value;
    expect(feed.valid).toBe(true);
    expect(feed.events.map((event) => event.id)).toEqual([events.sameTenant]);
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

// SEC-UG-MFA-RESET-TENANT-SCOPE-20260917 — the cross-tenant half of the
// administrator reset authorities, proven on the real catalog.
//
// Break caught: public.member_has_role(array['admin']) answers for the CALLER's
// own chapters and says nothing about the target, so before 20260917130000
// begin_mfa_reset's target check was a bare existence probe and
// record_mfa_reset had no target check at all. An organization-A administrator
// at aal2 could therefore reach straight past the endpoint over PostgREST and
// (a) write a private.member_mfa_reset_boundaries row for an organization-B
// member with reset_by = adminA, closing that member's sessions, web push and
// native push installations, and (b) stamp a `reset_mfa` member_admin_audit row
// naming the same foreign member. Both refusals below FAILED on Main.
//
// Every case runs as the administrator through the same RPC a browser would
// call, and each refusal is followed by an evidence read: a refusal that still
// wrote a boundary row, a closing barrier or an audit row is not a refusal.
const tenantIds = {
  adminA: "50930001-0000-4000-8000-000000000001",
  memberA: "50930001-0000-4000-8000-000000000002",
  memberB: "50930001-0000-4000-8000-000000000003",
  adminASession: "50930001-0000-4000-8000-000000000011",
  memberBSession: "50930001-0000-4000-8000-000000000012",
  adminAFactor: "50930001-0000-4000-8000-000000000021",
  orgA: "50930001-0000-4000-8000-000000000101",
  orgB: "50930001-0000-4000-8000-000000000102",
};

databaseIt("refuses both administrator MFA-reset authorities across an organization boundary", async () => {
  const rawUrl = process.env.SUPABASE_DB_URL;
  expect(rawUrl).toBeTruthy();
  const url = new URL(rawUrl);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);

  const client = new pg.Client({
    connectionString: rawUrl,
    application_name: "mfa-reset-tenant-scope-rollback-proof",
  });
  await client.connect();
  await client.query("begin");
  try {
    await client.query(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ($1, 'tenant-scope-admin-a@example.invalid', '{}'::jsonb),
        ($2, 'tenant-scope-member-a@example.invalid', '{}'::jsonb),
        ($3, 'tenant-scope-member-b@example.invalid', '{}'::jsonb)
    `, [tenantIds.adminA, tenantIds.memberA, tenantIds.memberB]);
    await client.query(`
      insert into public.organizations (id, slug, name, created_by) values
        ($1, 'tenant-scope-org-a', 'Tenant Scope Organization A', $3),
        ($2, 'tenant-scope-org-b', 'Tenant Scope Organization B', $3)
    `, [tenantIds.orgA, tenantIds.orgB, tenantIds.adminA]);
    await client.query(`
      insert into public.chapters
        (id, name, slug, region, is_default, order_index, organization_id)
      values
        ('tenant-scope-a1', 'Tenant Scope A1', 'tenant-scope-a1', 'tenant-scope-region', false, 9301, $1),
        ('tenant-scope-b1', 'Tenant Scope B1', 'tenant-scope-b1', 'tenant-scope-region', false, 9302, $2)
    `, [tenantIds.orgA, tenantIds.orgB]);
    // The memberships are not decoration: private.current_member_organization()
    // resolves only for a caller with an ACTIVE chapter membership and an
    // ACTIVE organization membership in the chapter's organization.
    await client.query(`
      insert into public.organization_memberships (organization_id, user_id, status) values
        ($1, $3, 'active'), ($1, $4, 'active'), ($2, $5, 'active')
    `, [tenantIds.orgA, tenantIds.orgB, tenantIds.adminA, tenantIds.memberA, tenantIds.memberB]);
    await client.query(`
      insert into public.member_chapter_memberships (user_id, chapter_id, status) values
        ($1, 'tenant-scope-a1', 'active'),
        ($2, 'tenant-scope-a1', 'active'),
        ($3, 'tenant-scope-b1', 'active')
    `, [tenantIds.adminA, tenantIds.memberA, tenantIds.memberB]);
    await client.query(`
      update public.member_profiles set chapter_id = 'tenant-scope-a1' where id = any($1::uuid[])
    `, [[tenantIds.adminA, tenantIds.memberA]]);
    await client.query(`
      update public.member_profiles set chapter_id = 'tenant-scope-b1' where id = $1
    `, [tenantIds.memberB]);
    // Organization A's administrator. The role rows are what member_has_role
    // reads; the aal2 session and verified factor are what mfa_satisfied()
    // needs, so the caller clears every gate that precedes the target check.
    await client.query(`
      insert into public.member_roles (user_id, role, chapter_id) values ($1, 'admin', 'tenant-scope-a1')
    `, [tenantIds.adminA]);
    await client.query(`
      insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, 'admin', 'tenant-scope-a1')
    `, [tenantIds.adminA]);
    await client.query(`
      insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
        ($1, $3, now() - interval '1 hour', now(), 'aal2'),
        ($2, $4, now() - interval '1 hour', now(), 'aal1')
    `, [tenantIds.adminASession, tenantIds.memberBSession, tenantIds.adminA, tenantIds.memberB]);
    await client.query(`
      insert into auth.mfa_factors
        (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      values ($1, $2, 'tenant-scope-admin-totp', 'totp', 'verified', now(), now())
    `, [tenantIds.adminAFactor, tenantIds.adminA]);
    // Session-bound state begin_mfa_reset destroys, so "sessions intact" and
    // "push intact" are readable facts rather than the absence of a fact.
    await client.query(`
      insert into public.member_push_subscriptions (user_id, endpoint, p256dh, auth_key)
      values ($1, 'https://fcm.googleapis.com/tenant-scope-member-b', 'p256dh-b', 'auth-b')
    `, [tenantIds.memberB]);

    const evidence = async () => (await client.query(`
      select
        (select count(*)::integer from private.member_mfa_reset_boundaries where user_id = $1) as boundaries,
        (select count(*)::integer from private.member_session_closing_barriers where user_id = $1) as barriers,
        (select count(*)::integer from auth.sessions where user_id = $1) as sessions,
        (select count(*)::integer from public.member_push_subscriptions where user_id = $1) as push,
        (select count(*)::integer from public.member_admin_audit where target_user = $1) as audit
    `, [tenantIds.memberB])).rows[0];

    expect(await evidence()).toEqual({ boundaries: 0, barriers: 0, sessions: 1, push: 1, audit: 0 });

    await asRole(client, "authenticated", claims(tenantIds.adminA, tenantIds.adminASession));
    // The caller really is an administrator whose organization resolves; the
    // refusals below are therefore about the TARGET and nothing else.
    expect((await client.query(
      "select public.member_has_role(array['admin']) as value",
    )).rows[0].value).toBe(true);
    expect((await client.query(
      "select private.current_member_organization() as value",
    )).rows[0].value).toBe(tenantIds.orgA);

    // 1. The defect itself: the foreign-organization target, through both RPCs.
    await expectState(
      client,
      "foreign_tenant_begin_mfa_reset",
      "select public.begin_mfa_reset($1)",
      [tenantIds.memberB],
      "42501",
    );
    await expectState(
      client,
      "foreign_tenant_record_mfa_reset",
      "select public.record_mfa_reset($1, 0)",
      [tenantIds.memberB],
      "42501",
    );

    // 2. A refusal that left a trace would not be one.
    await asRole(client, "postgres");
    expect(await evidence()).toEqual({ boundaries: 0, barriers: 0, sessions: 1, push: 1, audit: 0 });

    // 3. Self-target stays refused — the line the record must not regress.
    await asRole(client, "authenticated", claims(tenantIds.adminA, tenantIds.adminASession));
    await expectState(
      client,
      "self_target_begin_mfa_reset",
      "select public.begin_mfa_reset($1)",
      [tenantIds.adminA],
      "42501",
    );
    await expectState(
      client,
      "self_target_record_mfa_reset",
      "select public.record_mfa_reset($1, 0)",
      [tenantIds.adminA],
      "42501",
    );

    // 4. The product path still works: a same-organization target is allowed,
    //    and the tenant predicate did not cost the reset its reconciliation.
    expect((await client.query(
      "select public.begin_mfa_reset($1) as value",
      [tenantIds.memberA],
    )).rows[0].value).toMatchObject({
      userId: tenantIds.memberA,
      authorized: true,
      staleSessionsBlocked: true,
      serverCleanupComplete: true,
    });
    expect((await client.query(
      "select public.record_mfa_reset($1, 1) as value",
      [tenantIds.memberA],
    )).rows[0].value).toMatchObject({ userId: tenantIds.memberA, recorded: true });

    await asRole(client, "postgres");
    expect((await client.query(`
      select count(*)::integer as count from private.member_mfa_reset_boundaries
      where user_id = $1 and reset_by = $2
    `, [tenantIds.memberA, tenantIds.adminA])).rows[0].count).toBe(1);
    expect((await client.query(`
      select detail ->> 'factorsRemoved' as factors from public.member_admin_audit
      where target_user = $1 and actor = $2 and action = 'reset_mfa'
    `, [tenantIds.memberA, tenantIds.adminA])).rows).toEqual([{ factors: "1" }]);
  } finally {
    await client.query("rollback");
    await client.end();
  }
});
