// @vitest-environment node
//
// PERF-UG-ENGAGEMENT-STAFF-GATE-RUNS-THE-WHOLE-SNAPSHOT-20260920
// public.authorize_engagement_staff answers the engagement staff gate that
// api/guide.js (poll_draft, message_briefing) and api/engagement-delivery.js
// (status) need, with the same private.engagement_require_staff predicate as
// public.get_staff_engagement_snapshot. This proof runs it on the applied
// schema: a verified-MFA admin passes, a member and an aal1 admin are refused
// with 42501, anon cannot execute it, and it reads none of the tables the
// snapshot scans (measured with this transaction's own table counters).
// Everything runs in one transaction that is rolled back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the engagement staff gate is the predicate alone", () => {
  let client;
  const ids = { org: randomUUID(), admin: randomUUID(), member: randomUUID(), adminSession: randomUUID(), memberSession: randomUUID() };
  ids.chapter = `staff-gate-${ids.org}`;

  async function as(role, claims, sql) {
    await client.query("savepoint gate");
    try {
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      await client.query(`set local role ${role}`);
      const { rows } = await client.query(sql);
      await client.query("release savepoint gate");
      return { value: rows[0]?.value };
    } catch (error) {
      await client.query("rollback to savepoint gate");
      return { code: error.code, message: error.message };
    } finally {
      await client.query("reset role");
    }
  }

  const admin = (aal = "aal2") => ({ sub: ids.admin, role: "authenticated", aal, session_id: ids.adminSession });
  const member = () => ({ sub: ids.member, role: "authenticated", aal: "aal2", session_id: ids.memberSession });

  async function tableReads() {
    const { rows } = await client.query(
      "select relid::regclass::text as name, coalesce(seq_scan,0) + coalesce(idx_scan,0) as reads from pg_catalog.pg_stat_xact_user_tables where schemaname = 'public'",
    );
    return Object.fromEntries(rows.map((row) => [row.name, Number(row.reads)]));
  }

  function touched(before, after) {
    return Object.keys(after).filter((name) => after[name] > (before[name] ?? 0)).sort();
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "engagement-staff-gate-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [ids.org, ids.chapter]);
    await client.query(
      "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9901)",
      [ids.chapter, ids.org],
    );
    for (const [user, session] of [[ids.admin, ids.adminSession], [ids.member, ids.memberSession]]) {
      await client.query("insert into auth.users(id,email) values ($1,$2)", [user, `${user}@example.invalid`]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, ids.chapter]);
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing",
        [ids.org, user],
      );
      await client.query(
        "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing",
        [user, ids.chapter],
      );
      await client.query(
        "insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",
        [randomUUID(), user],
      );
      await client.query(
        "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())",
        [session, user],
      );
    }
    await client.query(
      "insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin') on conflict do nothing",
      [ids.org, ids.admin],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("lets a verified-MFA admin of the selected organization through", async () => {
    expect(await as("authenticated", admin(), "select public.authorize_engagement_staff() as value")).toEqual({ value: true });
  });

  it("refuses a member without a staff role with the snapshot's own 42501", async () => {
    const gate = await as("authenticated", member(), "select public.authorize_engagement_staff() as value");
    const snapshot = await as("authenticated", member(), "select public.get_staff_engagement_snapshot() as value");
    expect(gate).toEqual({ code: "42501", message: "not authorized" });
    expect(snapshot).toEqual(gate);
  });

  it("refuses an admin without MFA assurance with the snapshot's own 42501", async () => {
    const gate = await as("authenticated", admin("aal1"), "select public.authorize_engagement_staff() as value");
    const snapshot = await as("authenticated", admin("aal1"), "select public.get_staff_engagement_snapshot() as value");
    expect(gate.code).toBe("42501");
    expect(snapshot).toEqual(gate);
  });

  it("is not executable by anon", async () => {
    const gate = await as("anon", { role: "anon" }, "select public.authorize_engagement_staff() as value");
    expect(gate.code).toBe("42501");
    expect(gate.message).toMatch(/permission denied/);
  });

  it("reads none of the tables the staff snapshot scans", async () => {
    const beforeSnapshot = await tableReads();
    expect((await as("authenticated", admin(), "select public.get_staff_engagement_snapshot() as value")).code).toBeUndefined();
    const scanned = touched(beforeSnapshot, await tableReads());
    expect(scanned.length).toBeGreaterThan(0);

    const beforeGate = await tableReads();
    expect(await as("authenticated", admin(), "select public.authorize_engagement_staff() as value")).toEqual({ value: true });
    const gateReads = touched(beforeGate, await tableReads());
    // The snapshot's engagement reads; the gate reads only what the staff
    // predicate needs (membership, role grants, MFA policy).
    const engagement = /survey|poll|pulse|engagement|presence|chapter_spaces/;
    expect(scanned).toEqual(expect.arrayContaining(["organization_surveys", "organization_live_polls", "organization_pulse_prompts", "engagement_delivery_outbox"]));
    expect(gateReads.filter((name) => engagement.test(name))).toEqual([]);
    expect(gateReads.every((name) => scanned.includes(name))).toBe(true);
  });
});
