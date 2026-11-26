// @vitest-environment node
//
// BUG-UG-DUES-REMINDER-REQUEUE-UNIQUE-VIOLATION-20260921
// public.queue_dues_reminder allows one reminder per obligation, channel and
// month. A second request for the same window with a new idempotency key used
// to raise a raw 23505. It now returns that month's attempt (alreadyQueued)
// and writes nothing. A same-key replay and the payload-mismatch refusal are
// unchanged.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("dues reminder requeue in the same window over a disposable database", () => {
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
    const org = randomUUID(), admin = randomUUID(), member = randomUUID(), session = randomUUID();
    const chapter = `dues-requeue-${org}`;
    ids = { org, admin, session, obligations: [randomUUID(), randomUUID()] };
    for (const userId of [admin, member]) {
      await client.query("insert into auth.users (id, email) values ($1, $2)", [userId, `${userId}@example.invalid`]);
    }
    await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [org, chapter, admin]);
    await client.query("insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values ($1, $1, $1, true, 1, $2)", [chapter, org]);
    await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [org, admin]);
    await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [admin, chapter]);
    await client.query("update public.member_profiles set chapter_id = $1 where id = $2", [chapter, admin]);
    // The role grant trigger selects the admin financial identity.
    await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2)", [org, admin]);
    await client.query("insert into auth.sessions (id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [session, admin]);
    await client.query("insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), admin]);
    const batch = randomUUID(), subjects = [randomUUID(), randomUUID()];
    await client.query(
      `insert into public.dues_assessment_batches (id, organization_id, title, scope_kind, amount_cents, due_on, eligibility_fingerprint, idempotency_key, created_by)
       values ($1, $2, 'Dues', 'organization', 2500, current_date - 10, repeat('a', 64), $3, $4)`,
      [batch, org, `batch-${batch}`, admin],
    );
    await client.query("insert into public.dues_member_subjects (id, organization_id, user_id) values ($1, $3, $4), ($2, $3, null)", [...subjects, org, member]);
    await client.query(
      `insert into public.dues_obligations (id, organization_id, batch_id, member_subject_id, issued_cents, due_on)
       values ($1, $3, $4, $5, 2500, current_date - 10), ($2, $3, $4, $6, 2500, current_date - 10)`,
      [...ids.obligations, org, batch, ...subjects],
    );
  });
  afterEach(async () => { await client.query("rollback"); });

  async function queue(obligation, channel, key) {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.admin, role: "authenticated", aal: "aal2", session_id: ids.session })]);
    await client.query("set local role authenticated");
    return (await client.query("select public.queue_dues_reminder($1, $2, $3, 'admin') result", [obligation, channel, key])).rows[0].result;
  }
  async function counts() {
    await client.query("reset role");
    const { rows } = await client.query(
      `select (select count(*)::int from public.dues_reminder_attempts where organization_id = $1) attempts,
              (select count(*)::int from public.organization_audit_events where organization_id = $1 and event_type = 'dues_reminder_queued') audits`,
      [ids.org],
    );
    return rows[0];
  }

  it("answers a second key for the same obligation, channel and month with the queued attempt", async () => {
    const first = await queue(ids.obligations[0], "in_app", `reminder-${randomUUID()}`);
    expect(first.alreadyQueued).toBeUndefined();
    const again = await queue(ids.obligations[0], "in_app", `reminder-${randomUUID()}`);
    expect(again).toEqual({ id: first.id, state: first.state, alreadyQueued: true });
    expect(await counts()).toEqual({ attempts: 1, audits: 1 });
  });

  it("keeps a same-key replay idempotent", async () => {
    const key = `reminder-${randomUUID()}`;
    const first = await queue(ids.obligations[0], "in_app", key);
    const replay = await queue(ids.obligations[0], "in_app", key);
    expect(replay).toEqual({ id: first.id, state: first.state });
    expect((await counts()).attempts).toBe(1);
  });

  it("still queues another channel or another obligation in the same month", async () => {
    const inApp = await queue(ids.obligations[0], "in_app", `reminder-${randomUUID()}`);
    const email = await queue(ids.obligations[0], "email", `reminder-${randomUUID()}`);
    const other = await queue(ids.obligations[1], "in_app", `reminder-${randomUUID()}`);
    expect(new Set([inApp.id, email.id, other.id]).size).toBe(3);
    expect(await counts()).toEqual({ attempts: 3, audits: 3 });
  });

  it("still refuses a key reused for a different obligation", async () => {
    const key = `reminder-${randomUUID()}`;
    await queue(ids.obligations[0], "in_app", key);
    await client.query("savepoint refused");
    await expect(queue(ids.obligations[1], "in_app", key)).rejects.toMatchObject({ code: "22023" });
    await client.query("rollback to savepoint refused");
    expect(await counts()).toEqual({ attempts: 1, audits: 1 });
  });
});
