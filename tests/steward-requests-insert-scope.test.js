// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findMigrationName, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS.
// Whether production actually stopped granting table-wide INSERT is answered by
// `npm run verify:db`, which reads the live column_privileges for this table
// against scripts/db-contract.json#columnGrants and hard-fails on any surplus
// grant key it does not already record.
// REQ-UG-STEWARD-REQUEST-INSERT-SCOPE-20260726.

// Every migrations-directory lookup in this file goes through the shared
// helper. The filename and the SQL are resolved by the SAME findMigration, so
// the pair can never disagree: a second file matching this fragment fails the
// NAME lookup on line one rather than silently pinning the older of the two.
// A plain `.find()` here would take the first of N matches and stay green.
const migrationName = findMigrationName("steward_requests_insert_column_scope");
const sql = loadMigrationSql("steward_requests_insert_column_scope");
// Strip BOTH comment forms (the verifier's codeOf discipline): the header
// legitimately quotes the ROLLBACK grant it exists to warn against, and that
// line must never satisfy a positive pin.
const statements = stripComments(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const gaps = contract.knownGaps.surplusClientTableGrants;

// The columns the ONLY client caller writes. Everything else on this table is
// triage state that a member must never be able to set at insert time.
const GRANTED = ["user_id", "lesson_id"];
const DENIED = ["status", "handled_by", "acknowledged_at", "closed_at"];

describe("member_steward_requests INSERT column-scope migration", () => {
  it("is ordered after every migration it depends on", () => {
    expect(migrationName).toMatch(/^\d{14}_steward_requests_insert_column_scope\.sql$/);
    for (const fragment of [
      "fresh_member_workflows", // the table, the table-wide grant, the insert policy
      "steward_roles_triage_and_broadcast_authoring", // handled_by/acknowledged_at/closed_at
      "steward_award_on_acknowledgment", // the AFTER UPDATE trigger the severity call rests on
    ]) {
      // filter, not find: `fresh_member_workflows` names TWO migrations, and
      // "after the first one" is not the claim — this must sort after every
      // file that carries the fragment, or a later dependency slips past it.
      const dependencies = migrationNames().filter((entry) => entry.includes(fragment));
      expect(dependencies, `dependency migration "${fragment}"`).not.toHaveLength(0);
      for (const dependency of dependencies) {
        expect(migrationName.localeCompare(dependency), `${migrationName} must sort after ${dependency}`).toBeGreaterThan(0);
      }
    }
  });

  it("carries the reference tag", () => {
    expect(sql).toContain("REQ-UG-STEWARD-REQUEST-INSERT-SCOPE-20260726");
  });

  it("revokes the table-wide INSERT before granting columns", () => {
    // Order is the whole fix (20260725120000 ~:58): a column grant issued while
    // the platform default's table-level bit still stands is decorative.
    const revokeAt = statements.indexOf("revoke insert on public.member_steward_requests from authenticated;");
    const grantAt = statements.indexOf("grant  insert (user_id, lesson_id) on public.member_steward_requests to authenticated;");
    expect(revokeAt, "table-wide revoke must be present").toBeGreaterThan(-1);
    expect(grantAt, "column-scoped grant must be present").toBeGreaterThan(-1);
    expect(revokeAt).toBeLessThan(grantAt);
  });

  it("grants exactly the columns the client inserts, and no others", () => {
    const granted = [...statements.matchAll(/grant\s+insert\s*\(([^)]*)\)\s+on\s+public\.member_steward_requests/gi)]
      .map((match) => match[1].split(",").map((column) => column.trim()));
    expect(granted).toHaveLength(1);
    expect(granted[0]).toEqual(GRANTED);
    for (const column of DENIED) {
      expect(granted[0], `${column} must not be member-writable at insert time`).not.toContain(column);
    }
  });

  it("stays in lockstep with the only client caller", () => {
    // If requestSteward ever starts posting another column, the grant must
    // widen in the same commit or the member "request a steward" flow 42501s in
    // production. This pin fails on the client edit, not on the outage.
    const memberApi = readFileSync(new URL("../src/lib/memberApi.js", import.meta.url), "utf8");
    const insert = memberApi.match(/from\("member_steward_requests"\)\.insert\(\{([^}]*)\}\)/);
    expect(insert, "requestSteward's insert call must be findable").toBeTruthy();
    const columns = [...insert[1].matchAll(/([a-z_]+)\s*:/g)].map((match) => match[1]);
    expect(columns).toEqual(GRANTED);
    // The insert reads its id back; that read is served by the column-scoped
    // SELECT grant from 20260722001108, which must keep listing id.
    expect(memberApi).toContain('.insert({ user_id: userId, lesson_id: lessonId }).select("id").single()');
    const select = contract.columnGrants.find((entry) => entry.table === "public.member_steward_requests" && entry.privilege === "SELECT");
    expect(select.columns.split(",")).toContain("id");
  });

  it("scopes INSERT and nothing else (scope discipline)", () => {
    const verbs = [...statements.matchAll(/revoke\s+([a-z_,\s]+?)\s+on\s/gi)].map((m) => m[1].replace(/\s+/g, "").toLowerCase());
    expect(new Set(verbs), "every revoke must target exactly the insert privilege").toEqual(new Set(["insert"]));
    const grants = [...statements.matchAll(/grant\s+([a-z_]+)\s*\(/gi)].map((m) => m[1].toLowerCase());
    expect(new Set(grants)).toEqual(new Set(["insert"]));
    expect(statements).not.toMatch(/create (or replace )?function|drop function/i);
    expect(statements).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(statements).not.toMatch(/alter table|create index|create trigger/i);
  });

  it("issues no TABLE-FORM grant — the reversal an offline pin would otherwise miss", () => {
    // Proven necessary by mutation on 2026-07-26. Appending one line to this
    // migration:
    //     grant insert on public.member_steward_requests to authenticated;
    // silently reverts the entire fix -- and every other pin in this file, plus
    // tests/db-contract.test.js, stayed GREEN (23/23). The positive pin above
    // cannot see it: `/grant\s+([a-z_]+)\s*\(/` only matches the COLUMN form,
    // the one with the paren. A table-form grant re-widens exactly the surplus
    // this migration exists to close, and PostgreSQL resolves the wider grant.
    //
    // Control for the same mutation run: DELETING the revoke line IS caught
    // (2 failures), so the blind spot was specific to re-widening, not to
    // removal. That asymmetry is why this pin is phrased as an absence.
    //
    // The live half stays scripts/db-contract.json + `npm run verify:db`, whose
    // has_column_privilege check returns true for table-level grants too and so
    // would also fail -- but that lane SKIPs green while SUPABASE_DB_URL is
    // unset, which it is. Until the secret lands, this pin is the only guard.
    const tableForm = [...statements.matchAll(/grant\s+[a-z_,\s]+?\s+on\s+(?:table\s+)?public\.member_steward_requests/gi)];
    expect(tableForm.map((m) => m[0]), "a table-form grant re-widens what the column grant narrows").toEqual([]);
  });

  it("reloads the PostgREST schema cache", () => {
    expect(statements).toContain("notify pgrst, 'reload schema';");
  });
});

describe("contract coordination (scripts/db-contract.json)", () => {
  it("shrinks the recorded surplus grant to UPDATE,DELETE", () => {
    const entry = gaps.entries.find((row) => row.table === "member_steward_requests" && row.role === "authenticated");
    expect(entry.privileges).toBe("UPDATE,DELETE");
    expect(entry.note, "a closed gap names the migration that closed it").toContain("20260726030000");
    // The entry shrinks, it does not leave: UPDATE/DELETE are still surplus.
    // (20261104075000 closed member_case_updates: 24 -> 23.)
    expect(gaps.entries).toHaveLength(23);
  });

  it("pins the INSERT column list and the four denied triage columns", () => {
    const entry = contract.columnGrants.find(
      (row) => row.table === "public.member_steward_requests" && row.role === "authenticated" && row.privilege === "INSERT",
    );
    expect(entry, "verify:db only reads columns it is told to read").toBeTruthy();
    expect(entry.columns.split(",")).toEqual(GRANTED);
    expect(entry.denied.sort()).toEqual([...DENIED].sort());
  });

  it("never contracts the table as an exact tableGrants row while it is a recorded gap", () => {
    // The two are mutually exclusive by construction (verify-db-contract.mjs
    // filters gap rows out of the surplus sweep by tableGrants membership); a
    // row in both would silently disable one of the two checks.
    expect(contract.tableGrants.some((row) => row.table === "public.member_steward_requests")).toBe(false);
  });
});
