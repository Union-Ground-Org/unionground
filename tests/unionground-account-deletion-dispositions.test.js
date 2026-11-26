// @vitest-environment node
// Offline pins for the Union Ground in the
// database: D1 account-deletion dispositions, D2 Organizer role counts, and
// the sibling-dispatch neutralization. The live behaviour is proven by
// tests/unionground-account-lifecycle-db.test.js,
// tests/unionground-staff-roster-db.test.js and
// tests/unionground-sibling-dispatch-db.test.js.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const raw = loadMigrationSql("20261014014000_unionground_account_deletion_dispositions.sql");
const sql = stripComments(raw);
const verifier = readFileSync(new URL("../scripts/verify-account-lifecycle-manifest-local.mjs", import.meta.url), "utf8");

const manifestBlock = sql.slice(sql.indexOf("insert into private.account_lifecycle_manifest"), sql.indexOf("insert into private.account_lifecycle_transitive_fk_manifest"));
const rows = [...manifestBlock.matchAll(/\('(public|private)', '([a-z_]+)', '([a-z_]+)', '(cascade|pseudonymize)', '(included|excluded_with_reason)'/g)]
  .map(([, schema, table, column, disposition, exported]) => ({ key: `${schema}.${table}.${column}`, table, column, disposition, exported }));

const CASCADE = [
  "public.member_membership_periods.user_id", "public.member_onboarding_steps.user_id",
  "public.member_participation_events.user_id", "public.member_participation_completions.user_id",
  "public.member_learning_assignments.user_id", "public.member_capacity_commitments.user_id",
  "public.member_recognition_events.user_id", "private.member_recognition_week_totals.user_id",
  "public.organizing_campaign_assignments.user_id",
];
// Already ON DELETE SET NULL in 20261014001000; reviewed, not altered.
const ALREADY_SET_NULL = [
  "public.organizing_campaigns.next_action_owner_id", "public.organizing_workers.assigned_to",
  "public.organizing_resistance_incidents.owner_id", "public.organizing_bargaining_cycles.lead_id",
  "public.coalition_handshakes.bridge_lead_id", "public.member_membership_periods.verified_by",
  "public.member_onboarding_steps.verified_by",
];

describe("Union Ground account-deletion dispositions (D1)", () => {
  it("reviews all 44 lifecycle auth.users keys exactly once", () => {
    expect(rows).toHaveLength(44);
    expect(new Set(rows.map((row) => row.key)).size).toBe(44);
    expect(rows.filter((row) => row.disposition === "cascade").map((row) => row.key).sort()).toEqual([...CASCADE].sort());
    expect(rows.filter((row) => row.disposition === "pseudonymize")).toHaveLength(35);
  });

  it("detaches every pseudonymized column with ON DELETE SET NULL and never cascades shared campaign records", () => {
    for (const row of rows.filter((entry) => entry.disposition === "pseudonymize")) {
      if (ALREADY_SET_NULL.includes(row.key)) continue;
      expect(sql, row.key).toMatch(new RegExp(`add constraint [a-z_]+ foreign key \\(${row.column}\\) references auth\\.users\\(id\\) on delete set null;`));
      expect(sql, row.key).toContain(`alter table public.${row.table} drop constraint`);
    }
    const lifecycle = loadMigrationSql("20261014001000_unionground_union_lifecycle.sql");
    for (const key of ALREADY_SET_NULL) {
      const column = key.split(".").pop();
      expect(lifecycle, key).toMatch(new RegExp(`${column} uuid references auth\\.users\\(id\\) on delete set null`));
    }
    expect(sql).not.toMatch(/references auth\.users\(id\) on delete cascade/);
  });

  it("exports only the worker's own records, through the verifier's independently pinned safe columns", () => {
    const included = rows.filter((row) => row.exported === "included");
    expect(included.map((row) => row.key).sort()).toEqual(CASCADE.filter((key) => !key.endsWith("week_totals.user_id") && !key.includes("campaign_assignments")).sort());
    for (const row of included) {
      expect(verifier, row.key).toContain(`["${row.key}", [`);
      expect(sql).toContain(`'additionalDomains.${row.table}'`);
      expect(sql).toContain(`create function private.account_lifecycle_export_${row.table}(p_caller uuid)`);
      expect(fnBody(sql, `private.account_lifecycle_export_${row.table}(p_caller uuid)`)).toContain("where t.user_id = p_caller");
      expect(fnBody(sql, "private.account_lifecycle_export_additional_domains(p_caller uuid)"))
        .toContain(`'${row.table}', private.account_lifecycle_export_${row.table}(p_caller)`);
    }
    for (const helper of included.map((row) => fnBody(sql, `private.account_lifecycle_export_${row.table}(p_caller uuid)`))) {
      for (const identity of ["verified_by", "assigned_by", "offered_by", "request_id", "source_id"]) {
        expect(helper).not.toContain(`'${identity}'`);
      }
    }
    expect(verifier).toContain("const EXPECTED_TRANSITIVE_RESTRICTIVE_FK_REVIEWS = 29;");
    expect(verifier).not.toContain("unmanaged until the owner decides");
  });

  it("reviews the twelve restrictive keys below auth.users", () => {
    const block = sql.slice(sql.indexOf("insert into private.account_lifecycle_transitive_fk_manifest"), sql.indexOf("create function private.account_lifecycle_export_member_membership_periods"));
    const reviews = [...block.matchAll(/'(member_[a-z_]+_fkey)',\s+'(cascade|pseudonymize)'/g)].map(([, name, disposition]) => [name, disposition]);
    expect(reviews).toHaveLength(12);
    expect(reviews.filter(([, disposition]) => disposition === "pseudonymize")).toHaveLength(8);
    for (const [name, disposition] of reviews) {
      expect(sql, name).toMatch(new RegExp(`add constraint ${name}\\s+foreign key[^;]+${disposition === "cascade" ? "on delete cascade" : "on delete set null \\([a-z_]+\\)"};`));
    }
    expect(sql).toMatch(/member_participation_events_canonical_completion_fkey[^;]+on update cascade on delete cascade;/);
  });

  it("lets each append-only guard admit only the nested FK detachment and keep its refusal", () => {
    for (const [name, column, refusal] of [
      ["private.prevent_lifecycle_audit_change()", "actor_id", "lifecycle audit is append-only"],
      ["private.prevent_canonical_participation_update()", "verified_by", "verified participation is immutable"],
      ["private.prevent_bargaining_evidence_change()", "actor_column", "bargaining evidence is append-only"],
      ["private.preserve_bargaining_proposal_snapshot()", "created_by", "proposal version content is immutable"],
      ["private.guard_participation_source_verifier()", "verified_by", "participation verifier attribution cannot be detached"],
    ]) {
      const body = fnBody(sql, name);
      expect(body, name).toContain("private.account_lifecycle_is_nested_auth_detachment(");
      expect(body, name).toContain(column);
      expect(body, name).toContain(`raise exception '${refusal}'`);
    }
    expect(fnBody(sql, "private.guard_participation_source_verifier()")).toContain("raise exception 'completed participation requires a verifier' using errcode = '23514'");
    for (const table of ["member_learning_assignments", "member_capacity_commitments"]) {
      expect(sql).toContain(`create trigger ${table}_guard_verifier\n  before insert or update on public.${table}`);
    }
    for (const reviewed of ["'prevent_lifecycle_audit_change()'", "'prevent_canonical_participation_update()'", "'prevent_bargaining_evidence_change()'",
      "'preserve_bargaining_proposal_snapshot()'", "'guard_participation_source_verifier()'", "'member_learning_assignments_guard_verifier'", "'member_capacity_commitments_guard_verifier'"]) {
      expect(sql).toContain(reviewed);
    }
    expect(sql).toContain("if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then");
    expect(sql).toContain("if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then");
  });

  it("describes Union Ground users as workers forming a union, never as union members", () => {
    expect(raw).not.toMatch(/union members?\b|members? of (?:a|the) union/i);
  });
});

describe("Organizer role counts (D2)", () => {
  const roster = stripComments(loadMigrationSql("20261015110000_unionground_staff_roster_organizer.sql"));
  it("counts Organizers beside the other staff hats and keeps the admin gate", () => {
    const body = fnBody(roster, "public.get_admin_org_structure()");
    expect(body).toContain("mr.role = 'organizer') as organizer_count");
    expect(body).toContain("'organizer', cc.organizer_count");
    for (const role of ["steward", "coordinator", "advisor", "admin", "vp"]) expect(body).toContain(`'${role}', cc.${role}_count`);
    expect(body).toContain("private.member_has_chapter_role(caller_chapter, array['admin'])");
    expect(roster).toContain("grant execute on function public.get_admin_org_structure()\n  to authenticated;");
  });
});
