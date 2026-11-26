// @vitest-environment node
//
// REQ-UG-ALT-CASE-DESK-SERVER-READS-20261030
//
// public.casework_desk_case_details is the alternate shell's case desk read:
// per case the caller may work, the opened date, the closing date and outcome
// of a closed case, the open contract clocks with their label and procedure
// rule, open hearings and the settle/reopen history, without an access record.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const migration = readFileSync(
  new URL("../supabase/migrations/20261031031052_casework_desk_case_details.sql", import.meta.url),
  "utf8",
);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("case desk details (static)", () => {
  const code = migration.replace(/--[^\n]*/g, "");
  const start = code.indexOf("create function public.casework_desk_case_details");
  const body = code.slice(start, code.indexOf("$function$;", start));

  it("is a bounded, read-only definer read that writes no access record", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toContain("stable");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).not.toMatch(/\b(insert\s+into|update\s+public|delete\s+from)\b/i);
    expect(body).not.toMatch(/access_history|record_access/i);
    expect(body).toContain("coalesce(pg_catalog.cardinality(p_case_ids), 0) > 100");
    expect(body.match(/limit 25/g)).toHaveLength(2);
    expect(body).toContain("limit 10");
    expect(migration).toContain("revoke all on function public.casework_desk_case_details(uuid[]) from public, anon, authenticated, service_role;");
    expect(migration).toContain("grant execute on function public.casework_desk_case_details(uuid[]) to authenticated;");
  });

  it("never returns an actor id, and is pinned in the database contract", () => {
    expect(body).not.toMatch(/'actor(Id|UserId)'/);
    const entry = contract.functions.find((row) => row.sig === "public.casework_desk_case_details(p_case_ids uuid[])");
    expect(entry).toMatchObject({ secdef: true, exec: "authenticated" });
    for (const needle of entry.bodyContains) expect(migration).toContain(needle);
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/casework-desk-case-details-db.test.js");
  });
});

const ID = {
  org: "50906649-0000-4000-8000-000000000001",
  steward: "50906649-0000-4000-8000-000000000101",
  coordinator: "50906649-0000-4000-8000-000000000102",
  member: "50906649-0000-4000-8000-000000000103",
  stranger: "50906649-0000-4000-8000-000000000104",
  open: "50906649-0000-4000-8000-000000000301",
  closed: "50906649-0000-4000-8000-000000000302",
  foreign: "50906649-0000-4000-8000-000000000303",
  procedure: "50906649-0000-4000-8000-000000000401",
};
const SESSION = {
  [ID.steward]: "50906649-0000-4000-8000-000000000201",
  [ID.coordinator]: "50906649-0000-4000-8000-000000000202",
  [ID.member]: "50906649-0000-4000-8000-000000000203",
  [ID.stranger]: "50906649-0000-4000-8000-000000000204",
};
const CHAPTER = "desk-details-proof";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("case desk details on a disposable database", () => {
  let db;

  async function as(userId, sql, values = [], aal = "aal2") {
    await db.query("savepoint as_user");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: SESSION[userId], aal,
      })]);
      await db.query("set local role authenticated");
      const rows = (await db.query(sql, values)).rows;
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");
      await db.query("release savepoint as_user");
      return rows;
    } catch (error) {
      await db.query("rollback to savepoint as_user");
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");
      throw error;
    }
  }
  const details = async (userId, ids = [ID.open, ID.closed, ID.foreign], aal = "aal2") =>
    (await as(userId, "select public.casework_desk_case_details($1::uuid[]) result", [ids], aal))[0].result;
  const byCase = (rows) => Object.fromEntries(rows.map((row) => [row.caseId, row]));

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-desk-case-details-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    for (const id of [ID.steward, ID.coordinator, ID.member, ID.stranger]) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [id, `desk-${id.slice(-3)}@example.invalid`]);
      await db.query("insert into auth.sessions(id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [SESSION[id], id]);
      await db.query(
        `insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at)
         values (gen_random_uuid(), $1, 'desk-proof-totp', 'totp', 'verified', now(), now())`,
        [id],
      );
    }
    await db.query("insert into public.organizations(id, slug, name, created_by) values ($1, 'desk-details-proof', 'Desk details proof', $2)", [ID.org, ID.steward]);
    await db.query(
      "insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9929)",
      [CHAPTER, ID.org],
    );
    for (const id of [ID.steward, ID.coordinator, ID.member, ID.stranger]) {
      await db.query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [ID.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [id, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [id, CHAPTER]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'steward', $2), ($1, $3, 'coordinator', $3), ($1, $4, 'steward', $4)",
      [ID.org, ID.steward, ID.coordinator, ID.stranger],
    );
    await db.query(
      `insert into public.member_cases(id, user_id, reference, title, case_type, step, status, steward_user_id, steward_name, coordinator_user_id, coordinator_name, created_at)
       values ($1, $4, 'DESK-OPEN', 'Overtime bypass', 'Contract', 'Intake', 'active', $5, 'Sam Steward', $6, 'Cory Coordinator', '2026-09-01T14:00:00Z'),
              ($2, $4, 'DESK-CLOSED', 'Written warning', 'Discipline', 'Intake', 'active', $5, 'Sam Steward', $6, 'Cory Coordinator', '2026-08-01T14:00:00Z'),
              ($3, $4, 'DESK-FOREIGN', 'Not assigned to the steward', 'Contract', 'Intake', 'active', $7, 'Other Steward', null, null, '2026-08-15T14:00:00Z')`,
      [ID.open, ID.closed, ID.foreign, ID.member, ID.steward, ID.coordinator, ID.stranger],
    );
    // A procedure step clock and its transition share one transaction's now().
    await db.query(
      `insert into public.casework_procedures(id, organization_id, chapter_id, case_type, name, created_by)
       values ($1, $2, null, null, 'Desk proof procedure', $3)`,
      [ID.procedure, ID.org, ID.coordinator],
    );
    await db.query(
      `insert into public.casework_procedure_steps(procedure_id, organization_id, position, key, label, deadline_rule)
       values ($1, $2, 0, 'Intake', 'Intake', '{"kind":"none","count":0,"from":"step_entry"}'),
              ($1, $2, 1, 'step-1', 'Step 1 meeting', '{"kind":"business_days","count":10,"from":"step_entry"}')`,
      [ID.procedure, ID.org],
    );
    await db.query(
      `insert into public.casework_step_transitions(case_id, organization_id, chapter_id, from_step, to_step, outcome, transitioned_by, idempotency_key, procedure_transaction_id)
       values ($1, $2, $3, 'Intake', 'step-1', 'moved', $4, gen_random_uuid(), pg_current_xact_id())`,
      [ID.open, ID.org, CHAPTER, ID.steward],
    );
    await db.query(
      `insert into public.casework_deadlines(case_id, organization_id, chapter_id, kind, label, due_at, status, created_by) values
         ($1, $2, $3, 'procedure', 'Step 1 meeting', now() + interval '9 days', 'active', $4),
         ($1, $2, $3, 'response', 'Management answer', now() + interval '3 days', 'active', $4),
         ($1, $2, $3, 'filing', 'Met filing', now() - interval '2 days', 'met', $4),
         ($1, $2, $3, 'hearing', 'Arbitration hearing', now() + interval '30 days', 'active', $4)`,
      [ID.open, ID.org, CHAPTER, ID.steward],
    );
    // Settle, reopen and settle again, each its own versioned status change.
    for (const [status, actor] of [["resolved", ID.coordinator], ["active", ID.steward], ["resolved", ID.coordinator]]) {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor, role: "authenticated" })]);
      await db.query("update public.member_cases set status = $2 where id = $1", [ID.closed, status]);
    }
    await db.query("select set_config('request.jwt.claims', '', true)");
    await db.query(
      `insert into public.member_case_outcomes(case_id, user_id, outcome, summary, recorded_by)
       values ($1, $2, 'settled', 'Warning removed from the file', $3)`,
      [ID.closed, ID.member, ID.coordinator],
    );

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(db);
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("returns opened date, open clocks with their procedure rule, and hearings for the assigned steward", async () => {
    const rows = byCase(await details(ID.steward));
    expect(Object.keys(rows).sort()).toEqual([ID.open, ID.closed].sort());
    const open = rows[ID.open];
    expect(new Date(open.openedAt).toISOString()).toBe("2026-09-01T14:00:00.000Z");
    expect(open.closedAt).toBeNull();
    expect(open.clocks.map((clock) => clock.label)).toEqual(["Management answer", "Step 1 meeting"]);
    expect(open.clocks[1]).toMatchObject({ kind: "procedure", stepLabel: "Step 1 meeting", rule: { kind: "business_days", count: 10, from: "step_entry" } });
    expect(open.clocks[0]).toMatchObject({ kind: "response", rule: null, stepLabel: null });
    expect(open.hearings).toEqual([expect.objectContaining({ label: "Arbitration hearing", status: "active" })]);
  });

  it("shows a step rule only while it is certain: not after the procedure is saved, nor for two transitions in one transaction", async () => {
    const ruleOf = async () => byCase(await details(ID.steward))[ID.open].clocks.find((clock) => clock.kind === "procedure").rule;
    expect(await ruleOf()).toEqual({ kind: "business_days", count: 10, from: "step_entry" });
    await db.query("savepoint rule_probe");
    await db.query("update public.casework_procedures set updated_at = now() + interval '1 minute' where id = $1", [ID.procedure]);
    expect(await ruleOf()).toBeNull();
    await db.query("rollback to savepoint rule_probe");
    await db.query(
      `insert into public.casework_step_transitions(case_id, organization_id, chapter_id, from_step, to_step, outcome, transitioned_by, idempotency_key, procedure_transaction_id)
       values ($1, $2, $3, 'step-1', 'Intake', 'moved again', $4, gen_random_uuid(), pg_current_xact_id())`,
      [ID.open, ID.org, CHAPTER, ID.steward],
    );
    expect(await ruleOf()).toBeNull();
    await db.query("rollback to savepoint rule_probe");
    await db.query("release savepoint rule_probe");
    expect(await ruleOf()).toEqual({ kind: "business_days", count: 10, from: "step_entry" });
  });

  it("dates the last close and lists settle and reopen with who, never an actor id; the outcome follows the outcome policy", async () => {
    const steward = byCase(await details(ID.steward))[ID.closed];
    expect(steward.closedAt).toBe(steward.statusEvents[0].at);
    expect(steward.statusEvents.map((event) => [event.from, event.to, event.actorRole, event.actorName, event.byYou])).toEqual([
      ["active", "resolved", "coordinator", "Cory Coordinator", false],
      ["resolved", "active", "steward", "Sam Steward", true],
      ["active", "resolved", "coordinator", "Cory Coordinator", false],
    ]);
    expect(JSON.stringify(steward)).not.toContain(ID.coordinator);
    // An assigned steward does not read member_case_outcomes today; neither does this read.
    expect(steward.outcome).toBeNull();
    const coordinator = byCase(await details(ID.coordinator))[ID.closed];
    expect(coordinator.outcome).toMatchObject({ outcome: "settled", summary: "Warning removed from the file" });
    expect(coordinator.statusEvents[0].byYou).toBe(true);
  });

  it("leaves out cases the caller cannot work and writes nothing", async () => {
    const before = (await db.query("select count(*)::int n from public.member_access_events")).rows[0].n;
    expect(await details(ID.member)).toEqual([]);
    expect(byCase(await details(ID.stranger))[ID.foreign]).toBeDefined();
    expect(byCase(await details(ID.stranger))[ID.open]).toBeUndefined();
    expect((await db.query("select count(*)::int n from public.member_access_events")).rows[0].n).toBe(before);
  });

  it("refuses without two-step sign-in and past 100 ids", async () => {
    await expect(details(ID.steward, [ID.open], "aal1")).rejects.toMatchObject({ code: "42501" });
    const many = Array.from({ length: 101 }, (_, index) => `50906649-0000-4000-8000-${String(900000000000 + index)}`);
    await expect(details(ID.steward, many)).rejects.toMatchObject({ code: "22023" });
    expect(await details(ID.steward, [])).toEqual([]);
  });
});
