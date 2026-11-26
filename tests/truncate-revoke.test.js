// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS.
// Current-state truth (which grants production actually has) lives in
// scripts/db-contract.json, checked by `npm run verify:db` — its surplus sweep
// hard-fails on any grant key not recorded there, so a TRUNCATE regrant would
// go red in the verified lane, not here. REQ-UG-TRUNCATE-REVOKE-20260725.

const sql = loadMigrationSql("truncate_revoke_client_tables");
// Strip BOTH comment forms (the verifier's codeOf discipline): a /* */-wrapped
// statement must not keep a positive pin green while the applied SQL skips it.
const statements = stripComments(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const gaps = contract.knownGaps.surplusClientTableGrants;

// The 29 tables that still granted TRUNCATE to authenticated on 2026-07-25,
// enumerated live from information_schema.role_table_grants (not from grep).
const TABLES = [
  "demo_broadcasts", "demo_cases", "demo_conversations", "demo_members",
  "demo_metrics", "demo_plan_items", "demo_rights_lessons", "demo_week_days",
  "demo_weekly_summaries", "member_action_log", "member_ballot_options",
  "member_ballot_votes", "member_ballots", "member_broadcast_receipts",
  "member_broadcasts", "member_case_updates", "member_cases",
  "member_conversations", "member_guide_messages", "member_guide_threads",
  "member_kb_articles", "member_messages", "member_profiles",
  "member_rights_lessons", "member_rights_progress", "member_steward_requests",
  "member_survey_options", "member_survey_responses", "member_surveys",
];

describe("TRUNCATE revoke migration", () => {
  it("revokes TRUNCATE from authenticated on all 29 granting tables", () => {
    for (const table of TABLES) {
      expect(statements).toContain(`revoke truncate on public.${table} from authenticated;`);
    }
  });

  it("revokes the one anon TRUNCATE (member_kb_articles)", () => {
    expect(statements).toContain("revoke truncate on public.member_kb_articles from anon;");
  });

  it("fixes the source: postgres default ACL no longer mints TRUNCATE for client roles", () => {
    expect(statements).toContain("alter default privileges for role postgres in schema public");
    expect(statements).toContain("revoke truncate on tables from anon, authenticated;");
    expect(statements, "service_role keeps its full default set").not.toMatch(/from[^;]*service_role/i);
  });

  it("revokes TRUNCATE and nothing else (scope discipline)", () => {
    // Capture the FULL privilege list of every revoke ('revoke truncate, delete
    // on ...' must fail, not slip through on its first word).
    const verbs = [...statements.matchAll(/revoke\s+([a-z_,\s]+?)\s+on\s/gi)].map((m) => m[1].replace(/\s+/g, "").toLowerCase());
    expect(verbs.length).toBeGreaterThan(0);
    expect(new Set(verbs), "every revoke must target exactly the truncate privilege").toEqual(new Set(["truncate"]));
    expect(statements).not.toMatch(/^\s*grant\s/im);
    expect(statements).not.toMatch(/create (or replace )?function/i);
    expect(statements).not.toMatch(/create policy|drop policy/i);
  });

  it("reloads the PostgREST schema cache", () => {
    expect(statements).toContain("notify pgrst, 'reload schema';");
  });
});

describe("contract coordination (knownGaps.surplusClientTableGrants)", () => {
  it("no recorded surplus string carries TRUNCATE any more", () => {
    for (const entry of gaps.entries) {
      expect(entry.privileges, `${entry.table}/${entry.role}`).not.toContain("TRUNCATE");
    }
  });

  it("member_kb_articles left the gap list — SELECT-only rows leave the surplus sweep — and moved under tableGrants", () => {
    expect(gaps.entries.some((entry) => entry.table === "member_kb_articles")).toBe(false);
    // The gap rows were the only privilege record for this table; coverage
    // moves to the exact tableGrants assertion instead of vanishing. UB-RGT-01
    // removes the historical stock-default anon SELECT residue completely.
    const kb = contract.tableGrants.filter((entry) => entry.table === "public.member_kb_articles");
    expect(kb.map((entry) => `${entry.role}:${entry.privileges}`).sort()).toEqual(["anon:", "authenticated:SELECT"]);
    expect(kb.find((entry) => entry.role === "anon").note).toContain("removes the historical stock-default anon SELECT residue");
  });

  it("keeps exactly the 23 remaining DML entries and records each closure in why", () => {
    // 20261104075000 closed member_case_updates (24 -> 23).
    expect(gaps.entries).toHaveLength(23);
    expect(gaps.why).toContain("20261104075000");
    expect(gaps.why).toContain("20260725220000");
    expect(gaps.why).toContain("UB-VOTE-01");
    const byKey = new Map(gaps.entries.map((entry) => [`${entry.table}|${entry.role}`, entry.privileges]));
    // INSERT left this list when 20260726030000 column-scoped it to the two
    // columns the client actually writes; the exact scope (and the four denied
    // columns) is pinned in tests/steward-requests-insert-scope.test.js.
    expect(byKey.get("member_steward_requests|authenticated")).toBe("UPDATE,DELETE");
    expect(byKey.get("member_steward_requests|authenticated")).not.toContain("INSERT");
    expect(byKey.get("member_ballot_votes|authenticated")).toBe("SELECT,DELETE");
    expect(byKey.get("demo_members|authenticated")).toBe("SELECT,INSERT,UPDATE,DELETE");
    for (const table of ["member_ballots", "member_ballot_options", "member_surveys", "member_survey_options"]) {
      expect(byKey.has(`${table}|authenticated`)).toBe(false);
      const expected = table.endsWith("_options") ? "SELECT" : "";
      expect(contract.tableGrants.find((entry) => entry.table === `public.${table}` && entry.role === "authenticated")?.privileges).toBe(expected);
    }
  });
});
