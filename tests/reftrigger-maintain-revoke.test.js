// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";
import {
  ADMINISTRATIVE_EVIDENCE_RLS_TABLES,
  COMPASS_HYBRID_RLS_TABLES,
  MI1_ACCESS_HISTORY_RLS_TABLES,
  MI1_AUTH_CONFIGURATION_RLS_TABLES,
  MI1_COORDINATION_RLS_TABLES,
  MI1_CLAUSE_QUICKREF_RLS_TABLES,
  MI1_CASEWORK_RLS_TABLES,
  ORGANIZATION_INTELLIGENCE_RLS_TABLES,
  MEMBER_ENGAGEMENT_RLS_TABLES,
  MI1_ORGANIZATION_RLS_TABLES,
  MI1_AUTOMATION_CONTROL_RLS_TABLES,
  KNOWLEDGE_CONVERSION_PROVENANCE_RLS_TABLES,
  MI1_KNOWLEDGE_LIBRARY_RLS_TABLES,
  MI1_PUBLIC_CHAPTER_HIERARCHY_RLS_TABLES,
  MI1_W1_FEATURE_PERSISTENCE_RLS_TABLES,
  MI1_W2_FEATURE_PERSISTENCE_RLS_TABLES,
  RETIRED_W2_CASE_TABLES,
  CASEWORK_PROCEDURE_RLS_TABLES,
  MEMBER_SUPPORT_RLS_TABLES,
  OPTIONAL_PROVIDER_COMPLETION_RLS_TABLES,
} from "./helpers/mi1Contract.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS.
// Current-state truth (which grants production actually has) lives in
// scripts/db-contract.json, checked by `npm run verify:db` — whose privilege
// arrays this same commit widens to REFERENCES/TRIGGER/MAINTAIN, so a regrant
// of any of the three goes red in the verified lane, not here.
// REQ-UG-REFTRIGGER-SWEEP-20260725.

const sql = loadMigrationSql("reftrigger_maintain_revoke");
// Strip BOTH comment forms (the verifier's codeOf discipline): a /* */-wrapped
// statement must not keep a positive pin green while the applied SQL skips it.
// This file's header carries a ROLLBACK recipe full of `grant` statements —
// without stripping, the scope pins below would read that prose as code.
const statements = stripComments(sql);

const verifierSrc = readFileSync(new URL("../scripts/verify-db-contract.mjs", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

// The 29 tables that still held REFERENCES+TRIGGER for `authenticated` on
// 2026-07-26, enumerated live from pg_class / has_table_privilege — NOT from
// grep, and NOT from information_schema, which structurally cannot report
// MAINTAIN and so would have missed the 31st (table, role) pair entirely.
const XT_TABLES = [
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

// The full privilege vocabulary both sweeps must know about: `arwdDxtm`.
const VOCAB = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];

describe("REFERENCES/TRIGGER/MAINTAIN revoke migration", () => {
  it("revokes all three from authenticated on all 29 x/t-granting tables", () => {
    for (const table of XT_TABLES) {
      expect(statements).toContain(`revoke references, trigger, maintain on public.${table} from authenticated;`);
    }
  });

  it("revokes the one anon case (member_kb_articles)", () => {
    expect(statements).toContain("revoke references, trigger, maintain on public.member_kb_articles from anon;");
  });

  it("covers member_notifications — the MAINTAIN-only pair information_schema cannot see", () => {
    // 20260723200500 deliberately revoked insert/delete/truncate/references/
    // trigger here and still left MAINTAIN, because the author's list predated
    // PG17. The table therefore holds SELECT,MAINTAIN and is invisible to BOTH
    // sweeps: the surplus gate rejects it (its UPDATE is column-scoped to
    // read_at, and has_table_privilege is table-level), and the tableGrants
    // array did not carry MAINTAIN. It is the reason this migration could not
    // stop at REFERENCES and TRIGGER.
    expect(statements).toContain("revoke references, trigger, maintain on public.member_notifications from authenticated;");
  });

  it("fixes the source: postgres default ACL no longer mints x/t/m for client roles", () => {
    expect(statements).toContain("alter default privileges for role postgres in schema public");
    expect(statements).toContain("revoke references, trigger, maintain on tables from anon, authenticated;");
    expect(statements, "service_role keeps its full default set").not.toMatch(/from[^;]*service_role/i);
  });

  it("revokes exactly references+trigger+maintain and nothing else (scope discipline)", () => {
    // Capture the FULL privilege list of every revoke: 'revoke maintain, delete
    // on ...' must fail, not slip through on its first verb. Every statement
    // carries the identical three-verb list — including the MAINTAIN-only pair,
    // where the two redundant verbs are a Postgres no-op — so this stays a
    // single-element set rather than weakening to an allowed-set of variants.
    const verbs = [...statements.matchAll(/revoke\s+([a-z_,\s]+?)\s+on\s/gi)].map((m) => m[1].replace(/\s+/g, "").toLowerCase());
    expect(verbs.length).toBe(32); // 31 table revokes + the default-ACL revoke
    expect(new Set(verbs), "every revoke must target exactly references+trigger+maintain").toEqual(new Set(["references,trigger,maintain"]));
    expect(statements).not.toMatch(/^\s*grant\s/im);
    expect(statements).not.toMatch(/create (or replace )?function/i);
    expect(statements).not.toMatch(/create policy|drop policy/i);
    expect(statements).not.toMatch(/\btruncate\b/i); // 20260725220000's job, already done
  });

  it("guards the lock and reloads the PostgREST schema cache", () => {
    expect(statements).toContain("set local lock_timeout = '5s';");
    expect(statements).toContain("notify pgrst, 'reload schema';");
  });
});

describe("the verifier's privilege vocabulary stays in lockstep across all three sites", () => {
  // The named rot class: someone widens one sweep and not the other, or widens
  // both arrays and forgets the admission gate — which decides WHICH rows the
  // surplus sweep emits at all, not merely what is reported for the ones it does.

  it("all three table-privilege arrays exist and carry the identical full vocabulary", () => {
    // Anchored on the `) p` alias, NOT on a leading 'SELECT': the trigger-events
    // array elsewhere in the file leads with 'INSERT', so the alias is what
    // discriminates — and a cosmetic reorder of the privilege list must not
    // break extraction. Three sweeps as of 20260726020000: tableGrants, the
    // public surplus sweep, and the vendor-schema sweep. Do NOT dodge this pin
    // by aliasing a new unnest as anything other than `p` — that is exactly the
    // drift it exists to catch.
    const literals = [...verifierSrc.matchAll(/unnest\(array\[([^\]]+)\]\)\s*p\b/g)].map((m) => m[1]);
    expect(literals, "expected the tableGrants, surplus and vendor-schema sweeps").toHaveLength(3);
    for (const literal of literals) {
      const tokens = literal.split(",").map((t) => t.trim().replace(/^'|'$/g, ""));
      expect(new Set(tokens)).toEqual(new Set(VOCAB));
    }
    for (const literal of literals.slice(1)) {
      expect(literal, "the three sweeps must not drift apart").toBe(literals[0]);
    }
  });

  it("the surplus sweep's admission gate names every non-SELECT privilege", () => {
    // Widening the array alone is a half-fix: a table holding only x/t/m and no
    // DML would never enter the result set, so a regrant would stay silent.
    // member_kb_articles was exactly that shape before this migration.
    const gate = verifierSrc.match(/and \(has_table_privilege\(r\.role, c\.oid, '[A-Z]+'\)[\s\S]*?\)\)`\)/);
    expect(gate, "the surplus sweep WHERE gate has moved or rotted").toBeTruthy();
    const gated = [...gate[0].matchAll(/has_table_privilege\(r\.role, c\.oid, '([A-Z]+)'\)/g)].map((m) => m[1]);
    // SELECT is deliberately excluded: admitting it would enrol every readable
    // table in the public schema as a surplus row.
    expect(new Set(gated)).toEqual(new Set(VOCAB.filter((p) => p !== "SELECT")));
  });
});

describe("contract coordination (the revoke leaves every recorded string untouched)", () => {
  // These pins reject re-recorded client privileges and blanket rewrites.
  // The exact organization service-role grant below was outside the revoke.

  it("keeps revoked privileges absent except the pinned organization service-role grant", () => {
    const rows = [
      ...contract.tableGrants.map((e) => [`tableGrants ${e.table}/${e.role}`, e.privileges]),
      ...contract.knownGaps.surplusClientTableGrants.entries.map((e) => [`knownGaps ${e.table}/${e.role}`, e.privileges]),
    ];
    // Check every reviewed grant string below; an empty inventory must fail.
    expect(rows.length).toBeGreaterThan(0);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of ["private.open_signup_recovery_checks", "private.open_signup_operator_coverage", "private.open_signup_coverage_revocations", "private.password_signin_reservations",
        "private.platform_announcement_publishers", "private.platform_organization_follows", "private.platform_announcements",
        "private.platform_announcement_delivery_jobs", "private.organization_platform_announcements", "private.platform_announcement_preferences", "private.platform_announcement_audit",
        "private.chapter_units", "private.organization_local_profiles", "private.member_invitation_units",
        "private.account_blocked_email_domain_rules", "private.organization_workload_categories", "private.organization_learning_periods",
        "private.learning_action_kinds", "private.learning_action_journal", "private.case_row_topic_marks"]) {
        expect(contract.tableGrants).toContainEqual(expect.objectContaining({ table, role, privileges: "" }));
      }
    }
        // private.meeting_minutes_event_notices and organization_knowledge_source_health deny rows (20261003050000)
        // The three organization calendar tables and
        //       task_checkoff_lists / task_checkoff_entries deny rows
    for (const table of MI1_ORGANIZATION_RLS_TABLES) {
      expect(contract.tableGrants).toContainEqual(expect.objectContaining({
        table: `public.${table}`,
        role: "authenticated",
        privileges: "SELECT",
      }));
      expect(contract.tableGrants).toContainEqual(expect.objectContaining({
        table: `public.${table}`,
        role: "anon",
        privileges: "",
      }));
    }
    for (const [label, privileges] of rows) {
      const tokens = new Set(String(privileges || "").split(",").map((t) => t.trim()).filter(Boolean));
      if (label === "tableGrants public.organizations/service_role") {
        expect(tokens).toEqual(new Set(["MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE"]));
        continue;
      }
      for (const bit of ["REFERENCES", "TRIGGER", "MAINTAIN"]) {
        expect(tokens.has(bit), `${label} records ${bit} — 20260726010000 revoked it`).toBe(false);
      }
    }
  });

  it("every recorded privilege token is inside the swept vocabulary", () => {
    // Catches a typo ('INSER', 'REFERNCES') that a presence check cannot see:
    // the verifier compares these strings exactly, so a typo reads as a NEW gap.
    for (const entry of [...contract.tableGrants, ...contract.knownGaps.surplusClientTableGrants.entries]) {
      for (const token of String(entry.privileges || "").split(",").map((t) => t.trim()).filter(Boolean)) {
        expect(VOCAB, `${entry.table}/${entry.role} records unknown privilege "${token}"`).toContain(token);
      }
    }
  });

  it("pins the hardened knowledge grants alongside the earlier SELECT rows", () => {
    // UB-RGT-01 intentionally removes the historical anonymous KB read while
    // preserving authenticated SELECT behind chapter/state RLS. Notifications
    // and push subscriptions remain negative controls for the older sweep.
    const byKey = new Map(contract.tableGrants.map((e) => [`${e.table}|${e.role}`, e.privileges]));
    expect(byKey.get("public.member_kb_articles|authenticated")).toBe("SELECT");
    expect(byKey.get("public.member_kb_articles|anon")).toBe("");
    expect(byKey.get("public.member_notifications|authenticated")).toBe("SELECT");
    // Negative control: a table that never held x/t/m must be untouched by all
    // of this, so a blanket rewrite of the privilege strings goes red here.
    expect(byKey.get("public.member_push_subscriptions|authenticated")).toBe("SELECT,DELETE");
  });

  it("records the second closure in why, without dropping the first migration's stamp", () => {
    const why = contract.knownGaps.surplusClientTableGrants.why;
    expect(why).toContain("20260725220000");
    expect(why).toContain("20260726010000");
    expect(why).toContain("MAINTAIN");
  });
});
