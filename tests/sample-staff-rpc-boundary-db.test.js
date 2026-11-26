// @vitest-environment node
import pg from "pg";
import { expect, it } from "vitest";

const databaseIt = process.env.RUN_SAMPLE_STAFF_RPC_BOUNDARY_DB_TESTS === "1" ? it : it.skip;

const ids = {
  staff: "50940000-0000-4000-8000-000000000001",
  member: "50940000-0000-4000-8000-000000000002",
  staffSession: "50940000-0000-4000-8000-000000000011",
  memberSession: "50940000-0000-4000-8000-000000000012",
  organization: "50940000-0000-4000-8000-000000000101",
};

function claims(userId, sessionId) {
  return { sub: userId, session_id: sessionId, role: "authenticated", aal: "aal1" };
}

async function asAuthenticated(client, userId, sessionId) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims(userId, sessionId))]);
  await client.query("set local role authenticated");
}

async function expectDenied(client, label, statement) {
  const savepoint = `sample_staff_${label}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(statement);
    throw new Error(`${label}: expected SQLSTATE 42501`);
  } catch (error) {
    expect(error.code, `${label}: ${error.message}`).toBe("42501");
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

databaseIt("admits an organization-scoped SAMPLE-style Steward and still denies Member", async () => {
  const rawUrl = process.env.SUPABASE_DB_URL;
  expect(rawUrl).toBeTruthy();
  const url = new URL(rawUrl);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);

  const client = new pg.Client({
    connectionString: rawUrl,
    application_name: "sample-staff-rpc-boundary-rollback-proof",
  });
  await client.connect();
  await client.query("begin");
  try {
    await client.query(`
      insert into auth.users (id, email, raw_app_meta_data) values
        ($1, 'sample-rpc-steward@example.invalid', '{"sample":true,"surface":"sample","sample_persona":"steward"}'::jsonb),
        ($2, 'sample-rpc-member@example.invalid', '{"sample":true,"surface":"sample","sample_persona":"member"}'::jsonb)
    `, [ids.staff, ids.member]);
    await client.query(`
      insert into public.organizations (id, slug, name, created_by)
      values ($1, 'sample-rpc-proof', 'Sample RPC Proof Organization', $2)
    `, [ids.organization, ids.staff]);
    await client.query(`
      insert into public.chapters
        (id, name, slug, region, is_default, order_index, organization_id)
      values
        ('sample-rpc-proof-chapter', 'Sample RPC Proof Chapter', 'sample-rpc-proof-chapter',
         'proof-region', false, 9401, $1)
    `, [ids.organization]);
    await client.query(`
      insert into public.organization_memberships (organization_id, user_id, status) values
        ($1, $2, 'active'), ($1, $3, 'active')
    `, [ids.organization, ids.staff, ids.member]);
    await client.query(`
      insert into public.member_chapter_memberships (user_id, chapter_id, status) values
        ($1, 'sample-rpc-proof-chapter', 'active'),
        ($2, 'sample-rpc-proof-chapter', 'active')
    `, [ids.staff, ids.member]);
    await client.query(`
      update public.member_profiles
      set chapter_id = 'sample-rpc-proof-chapter',
          full_name = case when id = $1 then 'Sam Steward Proof' else 'Morgan Member Proof' end
      where id = any($2::uuid[])
    `, [ids.staff, [ids.staff, ids.member]]);
    await client.query(`
      insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
      values ($1, $2, 'steward', $2)
    `, [ids.organization, ids.staff]);
    await client.query(`insert into public.chapters (id,name,slug,order_index,organization_id)
      values ('tamarack-former-role','Tamarack former role','tamarack-former-role',9402,$1)`, [ids.organization]);
    // Mirrors the live SAMPLE transition: the old role row still points at the
    // pre-tenant chapter while the canonical organization grant owns access to
    // the persona's current chapter.
    await client.query(`
      insert into public.member_roles (user_id, role, chapter_id)
      values ($1, 'steward', 'tamarack-former-role')
    `, [ids.staff]);
    await client.query(`
      insert into public.org_security_policy
        (id, organization_id, require_staff_mfa, updated_by)
      values (true, $1, false, $2)
    `, [ids.organization, ids.staff]);
    await client.query(`
      insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
        ($1, $3, now(), now(), 'aal1'),
        ($2, $4, now(), now(), 'aal1')
    `, [ids.staffSession, ids.memberSession, ids.staff, ids.member]);

    await asAuthenticated(client, ids.staff, ids.staffSession);
    const templates = (await client.query(
      "select public.list_chapter_task_templates() as value",
    )).rows[0].value;
    expect(templates.length).toBeGreaterThanOrEqual(5);

    const reviewers = (await client.query(
      "select public.list_chapter_task_template_reviewers() as value",
    )).rows[0].value;
    expect(reviewers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ids.staff, fullName: "Sam Steward Proof" }),
    ]));

    const workload = (await client.query(
      "select public.get_steward_workload_intelligence(12) as value",
    )).rows[0].value;
    expect(workload).toMatchObject({
      available: false,
      reason: "anonymity_floor",
      rebalancing: {
        stewards: [expect.objectContaining({ userId: ids.staff, name: "Sam Steward Proof" })],
        suggestions: [],
      },
    });

    await asAuthenticated(client, ids.member, ids.memberSession);
    await expectDenied(client, "member_templates", "select public.list_chapter_task_templates()");
    await expectDenied(client, "member_reviewers", "select public.list_chapter_task_template_reviewers()");
    await expectDenied(client, "member_workload", "select public.get_steward_workload_intelligence(12)");
  } finally {
    await client.query("rollback");
    await client.end();
  }
});
