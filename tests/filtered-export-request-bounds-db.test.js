// @vitest-environment node
//
// SEC-UG-FILTERED-ORGANIZATION-EXPORT-REQUEST-BOUNDS-20260921
// public.request_filtered_organization_export accepts a stable idempotency
// key (a live replay returns the prior receipt and writes nothing) and admits
// at most 30 filtered export requests per organization per rolling hour.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("filtered organization export request bounds over a disposable database", () => {
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
    const org = randomUUID(), otherOrg = randomUUID(), admin = randomUUID(), otherAdmin = randomUUID();
    const chapter = `export-bounds-${org}`, otherChapter = `export-bounds-${otherOrg}`;
    ids = { org, otherOrg, admin, otherAdmin, sessions: { [admin]: randomUUID(), [otherAdmin]: randomUUID() } };
    for (const [orgId, chapterId, userId] of [[org, chapter, admin], [otherOrg, otherChapter, otherAdmin]]) {
      await client.query("insert into auth.users (id, email) values ($1, $2)", [userId, `${userId}@example.invalid`]);
      await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [orgId, chapterId, userId]);
      await client.query("insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values ($1, $1, $1, true, 1, $2)", [chapterId, orgId]);
      await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [orgId, userId]);
      await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [userId, chapterId]);
      await client.query("update public.member_profiles set chapter_id = $1 where id = $2", [chapterId, userId]);
      await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2)", [orgId, userId]);
      await client.query("insert into public.member_roles (user_id, role, chapter_id, granted_by) values ($1, 'admin', $2, $1)", [userId, chapterId]);
      await client.query("insert into public.member_role_chapters (user_id, role, chapter_id, granted_by) values ($1, 'admin', $2, $1)", [userId, chapterId]);
      await client.query("insert into auth.sessions (id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [ids.sessions[userId], userId]);
      await client.query("insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), userId]);
    }
  });
  afterEach(async () => { await client.query("rollback"); });

  async function asUser(userId) {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: ids.sessions[userId] })]);
    await client.query("set local role authenticated");
  }
  async function exportAs(userId, key = null, domains = ["members"], format = "json") {
    await asUser(userId);
    return (await client.query("select public.request_filtered_organization_export($1::text[], $2, null, null, $3) result", [domains, format, key])).rows[0].result;
  }
  async function counts(orgId) {
    await client.query("reset role");
    const { rows } = await client.query(
      `select (select count(*)::int from public.organization_data_export_runs where organization_id = $1) receipts,
              (select count(*)::int from public.organization_audit_events where organization_id = $1 and event_type = 'organization_export_completed') audits`,
      [orgId],
    );
    return rows[0];
  }
  async function seedAudits(orgId, actor, count, age) {
    await client.query("reset role");
    await client.query(
      `insert into public.organization_audit_events (organization_id, event_type, actor_user_id, idempotency_key, metadata, created_at)
       select $1, 'organization_export_completed', $2, extensions.gen_random_uuid(),
         jsonb_build_object('exportType', 'filtered', 'exportFormat', 'json', 'rowCount', 1, 'status', 'completed'), now() - $4::interval
       from generate_series(1, $3)`,
      [orgId, actor, count, age],
    );
  }
  async function expectCode(sql, args, code) {
    await client.query("savepoint refused");
    await expect(client.query(sql, args)).rejects.toMatchObject({ code });
    await client.query("rollback to savepoint refused");
  }

  it("a replay with the same key returns the prior receipt and writes nothing", async () => {
    const key = randomUUID();
    const first = await exportAs(ids.admin, key);
    const replay = await exportAs(ids.admin, key);
    expect(replay.receiptId).toBe(first.receiptId);
    expect(replay.expiresAt).toBe(first.expiresAt);
    expect(replay.rows).toEqual(first.rows);
    expect(await counts(ids.org)).toEqual({ receipts: 1, audits: 1 });
    const fresh = await exportAs(ids.admin, randomUUID());
    expect(fresh.receiptId).not.toBe(first.receiptId);
    const unkeyed = await exportAs(ids.admin);
    expect(unkeyed.receiptId).not.toBe(fresh.receiptId);
    expect(await counts(ids.org)).toEqual({ receipts: 3, audits: 3 });
  });

  it("refuses a key reused for a different request", async () => {
    const key = randomUUID();
    await exportAs(ids.admin, key, ["members"], "json");
    await asUser(ids.admin);
    await expectCode("select public.request_filtered_organization_export(array['members'], 'csv', null, null, $1)", [key], "22023");
    await expectCode("select public.request_filtered_organization_export(array['members','tasks'], 'json', null, null, $1)", [key], "22023");
    expect(await counts(ids.org)).toEqual({ receipts: 1, audits: 1 });
  });

  it("a key is scoped to its requester's organization", async () => {
    const key = randomUUID();
    const first = await exportAs(ids.admin, key);
    const other = await exportAs(ids.otherAdmin, key);
    expect(other.receiptId).not.toBe(first.receiptId);
    expect(await counts(ids.otherOrg)).toEqual({ receipts: 1, audits: 1 });
  });

  it("refuses the 31st request in an hour before any write", async () => {
    await seedAudits(ids.org, ids.admin, 29, "10 minutes");
    await exportAs(ids.admin);
    await asUser(ids.admin);
    await expectCode("select public.request_filtered_organization_export(array['members'], 'json')", [], "54000");
    expect(await counts(ids.org)).toEqual({ receipts: 1, audits: 30 });
  });

  it("counts only this organization's filtered exports in the rolling hour", async () => {
    await seedAudits(ids.org, ids.admin, 30, "61 minutes");
    await seedAudits(ids.otherOrg, ids.otherAdmin, 30, "10 minutes");
    expect((await exportAs(ids.admin)).receiptId).toBeTruthy();
    await asUser(ids.otherAdmin);
    await expectCode("select public.request_filtered_organization_export(array['members'], 'json')", [], "54000");
  });

  it("a live replay is still answered at the bound", async () => {
    const key = randomUUID();
    const first = await exportAs(ids.admin, key);
    await seedAudits(ids.org, ids.admin, 29, "5 minutes");
    expect((await exportAs(ids.admin, key)).receiptId).toBe(first.receiptId);
    await asUser(ids.admin);
    await expectCode("select public.request_filtered_organization_export(array['members'], 'json', null, null, $1)", [randomUUID()], "54000");
  });
});
