// @vitest-environment node
//
// SEC-UG-CONSTANT-CONTACT-SYNC-REQUEST-BOUNDS-20260921
// public.enqueue_constant_contact_sync returns an organization's queued or
// running sync job instead of queueing another, and admits at most 6
// user-requested syncs per organization per rolling hour.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("Constant Contact sync request bounds over a disposable database", () => {
  let client;
  let ids;
  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
    await client.connect();
  });
  afterAll(async () => { await client?.end(); });

  beforeEach(async () => {
    await client.query("begin");
    ids = { sessions: {} };
    for (const key of ["a", "b"]) {
      const org = randomUUID(), admin = randomUUID(), chapter = `cc-bounds-${org}`;
      ids[key] = { org, admin };
      ids.sessions[admin] = randomUUID();
      await client.query("insert into auth.users (id, email) values ($1, $2)", [admin, `${admin}@example.invalid`]);
      await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [org, chapter, admin]);
      await client.query("insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values ($1, $1, $1, true, 1, $2)", [chapter, org]);
      await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [org, admin]);
      await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [admin, chapter]);
      await client.query("update public.member_profiles set chapter_id = $1 where id = $2", [chapter, admin]);
      await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2)", [org, admin]);
      await client.query("insert into auth.sessions (id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [ids.sessions[admin], admin]);
      await client.query("insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), admin]);
      await client.query(
        "insert into public.organization_integrations (organization_id, provider, status) values ($1, 'constant_contact', 'connected') on conflict (organization_id, provider) do update set status = 'connected'",
        [org],
      );
      await client.query("insert into private.constant_contact_oauth_tokens (organization_id, secret_ref, status, connected_by) values ($1, $2, 'connected', $3)", [org, randomUUID(), admin]);
    }
  });
  afterEach(async () => { await client.query("rollback"); });

  async function enqueueAs(admin) {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin, role: "authenticated", aal: "aal2", session_id: ids.sessions[admin] })]);
    await client.query("set local role authenticated");
    return (await client.query("select public.enqueue_constant_contact_sync(10) result")).rows[0].result;
  }
  async function counts(org) {
    await client.query("reset role");
    return (await client.query(
      `select (select count(*)::int from public.integration_jobs where organization_id = $1 and job_kind = 'constant_contact_sync') jobs,
              (select count(*)::int from public.constant_contact_sync_requests where organization_id = $1) requests`,
      [org],
    )).rows[0];
  }
  async function finishJobs(org) {
    await client.query("reset role");
    await client.query("update public.integration_jobs set status = 'success' where organization_id = $1 and job_kind = 'constant_contact_sync'", [org]);
  }
  async function seedRequests(org, requester, count, age) {
    await client.query("reset role");
    for (let index = 0; index < count; index += 1) {
      const job = randomUUID();
      await client.query(
        "insert into public.integration_jobs (id, organization_id, provider, job_kind, status, idempotency_key) values ($1, $2, 'constant_contact', 'constant_contact_sync', 'success', $3)",
        [job, org, `constant-contact:${job}`],
      );
      await client.query(
        "insert into public.constant_contact_sync_requests (job_id, organization_id, requested_by, limit_count, created_at) values ($1, $2, $3, 10, now() - $4::interval)",
        [job, org, requester, age],
      );
    }
  }
  async function expectRefused(admin, code) {
    await client.query("savepoint refused");
    await expect(enqueueAs(admin)).rejects.toMatchObject({ code });
    await client.query("rollback to savepoint refused");
  }

  it("returns the queued job instead of queueing another", async () => {
    const first = await enqueueAs(ids.a.admin);
    expect(first.status).toBe("queued");
    const again = await enqueueAs(ids.a.admin);
    expect(again).toMatchObject({ ok: true, jobId: first.jobId, status: "queued", deduplicated: true });
    expect(await counts(ids.a.org)).toEqual({ jobs: 1, requests: 1 });
  });

  it("returns a running job too, and queues again once it finishes", async () => {
    const first = await enqueueAs(ids.a.admin);
    await client.query("reset role");
    await client.query("update public.integration_jobs set status = 'running' where id = $1", [first.jobId]);
    expect(await enqueueAs(ids.a.admin)).toMatchObject({ jobId: first.jobId, status: "running", deduplicated: true });
    await finishJobs(ids.a.org);
    const next = await enqueueAs(ids.a.admin);
    expect(next.jobId).not.toBe(first.jobId);
    expect(next.deduplicated).toBeUndefined();
  });

  it("does not deduplicate across organizations", async () => {
    const first = await enqueueAs(ids.a.admin);
    const other = await enqueueAs(ids.b.admin);
    expect(other.jobId).not.toBe(first.jobId);
    expect(other.deduplicated).toBeUndefined();
  });

  it("refuses the 7th user-requested sync in an hour before any write", async () => {
    await seedRequests(ids.a.org, ids.a.admin, 5, "10 minutes");
    await enqueueAs(ids.a.admin);
    await finishJobs(ids.a.org);
    await expectRefused(ids.a.admin, "54000");
    expect(await counts(ids.a.org)).toEqual({ jobs: 6, requests: 6 });
  });

  it("counts only this organization's user requests in the rolling hour", async () => {
    await seedRequests(ids.a.org, ids.a.admin, 6, "61 minutes");
    await seedRequests(ids.a.org, null, 6, "5 minutes");
    await seedRequests(ids.b.org, ids.b.admin, 6, "5 minutes");
    expect((await enqueueAs(ids.a.admin)).status).toBe("queued");
    await expectRefused(ids.b.admin, "54000");
  });
});
