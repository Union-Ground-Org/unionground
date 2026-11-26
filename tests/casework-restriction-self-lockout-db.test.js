// @vitest-environment node
//
// BUG-UG-WEB-CASE-RESTRICT-LOCKS-OUT-COORDINATOR-20261003
//
// An unassigned chapter coordinator reaches a case through the coordinator hat,
// could restrict it, and then lost it at once: the restricted branch of
// private.casework_staff_can_access admits only the assigned staff, an
// organization advisor, admin or vp, and active grantees, so she could not
// lift her own restriction. public.casework_set_restriction now refuses a
// restriction that would remove the caller's own access (22023 with the
// translated token casework_restriction_self_lockout) and writes nothing.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { TRANSLATED_RPC_TOKENS } from "../src/lib/rpcErrorText.js";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const RESTRICT = "public.casework_set_restriction(p_case_id uuid, p_restricted boolean, p_reason text)";
const TOKEN = "casework_restriction_self_lockout";
const sql = stripComments(loadMigrationSql("casework_restriction_self_lockout"));

describe("casework restriction self-lockout contract", () => {
  it("re-checks the caller's own access after restricting and refuses a lock-out", () => {
    expect(findMigrationName("casework_restriction_self_lockout") > findMigrationName("20260907151000_account_deletion_finalization_reconciliation")).toBe(true);
    expect(sql).toContain("'public.casework_set_restriction(uuid, boolean, text)'::regprocedure");
    expect(sql).toContain("create or replace function public.casework_set_restriction(p_case_id uuid, p_restricted boolean, p_reason text)");
    expect(sql).toContain("if p_restricted and (not private.casework_staff_can_access(p_case_id) or private.member_case_row_visible(v_case) is not true)");
    expect(sql).toContain(`using errcode = '22023', detail = '${TOKEN}'`);
    // The refusal comes before the audit row, so a refused restriction leaves
    // no restriction_changed event.
    expect(sql.indexOf(`detail = '${TOKEN}'`)).toBeLessThan(sql.indexOf("'restriction_changed'"));
    expect(sql).toContain("perform private.lock_case_graph(");
    expect(sql).toContain("perform private.lock_message_lifecycle();");
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?function\s+private\.casework_staff_can_access/);
    expect(TRANSLATED_RPC_TOKENS.has(TOKEN)).toBe(true);
  });

  it("pins the refusal in the database contract", () => {
    const entry = contract.functions.find((fn) => fn.sig === RESTRICT);
    expect(entry.exec).toBe("authenticated");
    expect(entry.bodyContains).toEqual(expect.arrayContaining([`detail = '${TOKEN}'`, "private.member_case_row_visible(v_case)", "'restriction_changed'"]));
    expect(entry.bodyMd5).toMatch(/^[0-9a-f]{32}$/);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("restricting a case without locking yourself out (disposable database)", () => {
  let client;
  const id = Object.fromEntries([
    "member", "assigned", "colleague", "memberSession", "assignedSession", "colleagueSession", "org", "caseId",
  ].map((key) => [key, randomUUID()]));
  const chapter = `case-lockout-${id.org}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const attempt = async (text, params = []) => {
    await client.query("savepoint lockout_attempt");
    try {
      const result = await client.query(text, params);
      await client.query("release savepoint lockout_attempt");
      return { ok: true, rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint lockout_attempt");
      return { ok: false, code: error.code, detail: error.detail, message: error.message };
    }
  };

  const asOwner = async (text, params = []) => {
    await client.query("reset role");
    return (await client.query(text, params)).rows;
  };

  const restrict = (restricted, reason = "Sensitive witness statements") => attempt(
    "select (c).is_restricted from public.casework_set_restriction($1, $2, $3) c", [id.caseId, restricted, reason],
  );

  const caseState = async () => (await asOwner(
    "select is_restricted, restriction_reason, restricted_by from public.member_cases where id = $1", [id.caseId],
  ))[0];

  const restrictionAudits = async () => (await asOwner(
    "select count(*)::int as n from public.casework_audit_events where case_id = $1 and event_type = 'restriction_changed'", [id.caseId],
  ))[0].n;

  const canOpen = async (actor, session) => {
    await act(actor, session);
    const visible = (await client.query("select count(*)::int as n from public.member_cases where id = $1", [id.caseId])).rows[0].n;
    const staff = (await client.query("select private.casework_staff_can_access($1) as ok", [id.caseId])).rows[0].ok;
    return { visible, staff };
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-restriction-self-lockout-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.member, id.memberSession, "Lockout Proof Member"],
      [id.assigned, id.assignedSession, "Lockout Proof Assigned Coordinator"],
      [id.colleague, id.colleagueSession, "Lockout Proof Chapter Coordinator"],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic lockout factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `case-lockout-${id.org}`, id.assigned]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9905)", [chapter, id.org]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user, , name] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, chapter, name]);
    }
    for (const user of [id.assigned, id.colleague]) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$3)", [id.org, user, id.assigned]);
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2) on conflict do nothing", [user, chapter]);
    }
    // The case is assigned to one coordinator; the colleague is a chapter
    // coordinator who reaches it only through the coordinator hat.
    await client.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,coordinator_user_id)
       values($1,$2,'CASE-LOCKOUT','CASE-LOCKOUT','other',$3,$4,$5)`,
      [id.caseId, id.member, id.org, chapter, id.assigned],
    );
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("refuses an unassigned chapter coordinator's restriction before it locks her out, and writes nothing", async () => {
    expect(await canOpen(id.colleague, id.colleagueSession)).toEqual({ visible: 1, staff: true });
    await act(id.colleague, id.colleagueSession);
    expect(await restrict(true)).toMatchObject({ ok: false, code: "22023", detail: TOKEN });
    expect(await caseState()).toEqual({ is_restricted: false, restriction_reason: null, restricted_by: null });
    expect(await restrictionAudits()).toBe(0);
    // She can still open the case.
    expect(await canOpen(id.colleague, id.colleagueSession)).toEqual({ visible: 1, staff: true });
  });

  it("lets an unassigned coordinator who keeps access through a grant restrict the case and lift it again", async () => {
    await asOwner(
      "insert into public.casework_access_grants(case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason) values($1,$2,$3,$4,$5,'Covering the assigned coordinator this week')",
      [id.caseId, id.org, chapter, id.colleague, id.assigned],
    );
    await act(id.colleague, id.colleagueSession);
    expect(await restrict(true)).toMatchObject({ ok: true, rows: [{ is_restricted: true }] });
    expect(await canOpen(id.colleague, id.colleagueSession)).toEqual({ visible: 1, staff: true });
    await act(id.colleague, id.colleagueSession);
    expect(await restrict(false, "")).toMatchObject({ ok: true, rows: [{ is_restricted: false }] });
    expect(await caseState()).toEqual({ is_restricted: false, restriction_reason: null, restricted_by: null });
    expect(await restrictionAudits()).toBe(2);
    await asOwner("update public.casework_access_grants set revoked_at = now(), revoked_by = $2 where case_id = $1 and revoked_at is null", [id.caseId, id.assigned]);
  });

  it("keeps the assigned coordinator's restrict-and-lift unchanged, and the restriction still hides the case from the colleague", async () => {
    await act(id.assigned, id.assignedSession);
    expect(await restrict(true)).toMatchObject({ ok: true, rows: [{ is_restricted: true }] });
    expect(await caseState()).toMatchObject({ is_restricted: true, restriction_reason: "Sensitive witness statements", restricted_by: id.assigned });
    expect(await canOpen(id.colleague, id.colleagueSession)).toEqual({ visible: 0, staff: false });
    expect(await canOpen(id.assigned, id.assignedSession)).toEqual({ visible: 1, staff: true });
    await act(id.assigned, id.assignedSession);
    expect(await restrict(false, "")).toMatchObject({ ok: true, rows: [{ is_restricted: false }] });
    expect(await canOpen(id.colleague, id.colleagueSession)).toEqual({ visible: 1, staff: true });
  });

  it("refuses a restriction that a stale steward assignment would pass but the read policies would hide", async () => {
    // The colleague is recorded as the case's steward but holds only the
    // coordinator role: casework_staff_can_access accepts the stored steward
    // assignment, while member_case_row_visible (the read policies) requires
    // the steward role, so restricting would drop the case from her board.
    await asOwner("update public.member_cases set steward_user_id = $2 where id = $1", [id.caseId, id.colleague]);
    await act(id.colleague, id.colleagueSession);
    expect(await restrict(true)).toMatchObject({ ok: false, code: "22023", detail: TOKEN });
    expect(await caseState()).toEqual({ is_restricted: false, restriction_reason: null, restricted_by: null });
    expect(await canOpen(id.colleague, id.colleagueSession)).toEqual({ visible: 1, staff: true });
    // With no coordinator on the case, the read predicate is NULL rather than
    // false; the guard must still refuse.
    await asOwner("update public.member_cases set coordinator_user_id = null where id = $1", [id.caseId]);
    await act(id.colleague, id.colleagueSession);
    expect(await restrict(true)).toMatchObject({ ok: false, code: "22023", detail: TOKEN });
    expect(await caseState()).toEqual({ is_restricted: false, restriction_reason: null, restricted_by: null });
    expect(await canOpen(id.colleague, id.colleagueSession)).toEqual({ visible: 1, staff: true });
    await asOwner("update public.member_cases set steward_user_id = null, coordinator_user_id = $2 where id = $1", [id.caseId, id.assigned]);
  });

  it("still asks for a restriction reason first", async () => {
    await act(id.assigned, id.assignedSession);
    const refused = await restrict(true, "short");
    expect(refused).toMatchObject({ ok: false, code: "22023" });
    expect(refused.detail).not.toBe(TOKEN);
  });
});
