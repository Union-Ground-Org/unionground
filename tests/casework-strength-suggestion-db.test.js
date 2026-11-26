// @vitest-environment node
//
// REQ-UG-STRENGTH-ANALYZER-AUTO-SCORING-20261001 (CR-020)
//
// The old analyzer (app/dashboard/analyzer/actions.ts) scored contract match
// 40%, evidence 35% and procedural standing 25% with no AI call, and warned
// when the filing deadline was close. casework_suggest_case_strength restores
// that suggestion beside the steward's five hand-rated factors.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const migration = readFileSync(
  new URL("../supabase/migrations/20261002145000_casework_strength_auto_suggest.sql", import.meta.url),
  "utf8",
);

describe("strength suggestion (static)", () => {
  it("registers the switch and the old analyzer limits, cited", () => {
    expect(migration).toMatch(/\('features\.casework\.strength_auto_suggest', 'boolean',[\s\S]*?'true', null, null, null, 1700, 'casework', false\)/);
    for (const [key, value] of [
      ["strength_deadline_warning_days", "5"], ["strength_filing_window_days", "14"], ["strength_evidence_witness", "90"],
      ["strength_evidence_documents", "75"], ["strength_evidence_photos", "65"], ["strength_evidence_none", "30"],
    ]) expect(migration).toMatch(new RegExp(`\\('limits\\.casework\\.${key}', 'integer',[\\s\\S]*?'${value}',`));
    for (const citation of ["actions.ts:118", "actions.ts:117", "actions.ts:45", "feature-flags.ts:60"]) expect(migration).toContain(citation);
  });

  it("stays deterministic and read-only", () => {
    const code = migration.replace(/--[^\n]*/g, "");
    const start = code.indexOf("create function public.casework_suggest_case_strength");
    const body = code.slice(start, code.indexOf("$function$;", start));
    expect(start).toBeGreaterThan(0);
    expect(body).toContain("stable");
    expect(body).not.toMatch(/\b(insert|update|delete)\s+(into\s+|from\s+)?public\./i);
    expect(code).not.toMatch(/compass|openai|anthropic|fireworks|http/i);
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/casework-strength-suggestion-db.test.js");
  });
});

const ID = {
  org: "50902218-0000-4000-8000-000000000001",
  otherOrg: "50902218-0000-4000-8000-000000000002",
  steward: "50902218-0000-4000-8000-000000000101",
  member: "50902218-0000-4000-8000-000000000102",
  case: "50902218-0000-4000-8000-000000000301",
};
const SESSION = {
  [ID.steward]: "50902218-0000-4000-8000-000000000201",
  [ID.member]: "50902218-0000-4000-8000-000000000202",
};
const CHAPTER = "strength-suggestion-proof";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("strength suggestion on a disposable database", () => {
  let db;

  async function suggest(userId, evidence = null) {
    await db.query("savepoint as_user");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: SESSION[userId], aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const row = (await db.query("select public.casework_suggest_case_strength($1, $2) result", [ID.case, evidence])).rows[0].result;
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");
      await db.query("release savepoint as_user");
      return row;
    } catch (error) {
      await db.query("rollback to savepoint as_user");
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");
      throw error;
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-strength-suggestion-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    for (const id of [ID.steward, ID.member]) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [id, `strength-${id.slice(-3)}@example.invalid`]);
      await db.query("insert into auth.sessions(id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [SESSION[id], id]);
      await db.query(
        `insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at)
         values (gen_random_uuid(), $1, 'strength-proof-totp', 'totp', 'verified', now(), now())`,
        [id],
      );
    }
    await db.query(
      `insert into public.organizations(id, slug, name, created_by) values
         ($1, 'strength-proof-org', 'Strength proof', $3), ($2, 'strength-proof-other', 'Strength proof other', $3)`,
      [ID.org, ID.otherOrg, ID.steward],
    );
    await db.query(
      "insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9928)",
      [CHAPTER, ID.org],
    );
    for (const id of [ID.steward, ID.member]) {
      await db.query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [ID.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [id, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [id, CHAPTER]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'steward', $2)",
      [ID.org, ID.steward],
    );
    await db.query(
      `insert into public.member_cases(id, user_id, reference, title, case_type, step, status, steward_user_id)
       values ($1, $2, 'STRENGTH-PROOF', 'Written warning without just cause', 'Discipline', 'Intake', 'active', $3)`,
      [ID.case, ID.member, ID.steward],
    );
    await db.query(
      `insert into public.member_forms(user_id, template_key, status, answers, case_id)
       values ($1, 'grievance', 'submitted', jsonb_build_object('summary', 'Written warning', 'incident_date', ((now() at time zone 'America/New_York')::date - 4)::text,
         'witnesses', 'A coworker saw the meeting'), $2)`,
      [ID.member, ID.case],
    );
    const clause = (org, article, title, keywords, summary, status = "published") => db.query(
      `insert into public.contract_clauses(organization_id, article, category, title, summary, keywords, status)
       values ($1, $2, 'Discipline', $3, $4, $5::text[], $6)`,
      [org, article, title, summary, keywords, status],
    );
    await clause(ID.org, "12", "Discipline and discharge", ["discipline", "warning", "just cause"], "No employee shall be disciplined without just cause.");
    await clause(ID.org, "8", "Scheduling", ["schedule", "shift"], "Shifts are posted two weeks ahead.");
    await clause(ID.org, "13", "Retired discipline article", ["warning", "written", "cause"], "Written warning without just cause.", "retired");
    await clause(ID.otherOrg, "1", "Other organization", ["warning", "written", "cause", "without"], "Written warning without just cause.");

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

  it("restores the old 40/35/25 score from this organization's published clauses, witnesses and the incident date", async () => {
    const result = await suggest(ID.steward);
    expect(result).toEqual({
      overallScore: 78,
      band: "strong",
      contractScore: 71,
      evidenceScore: 90,
      proceduralScore: 71,
      evidenceType: "witness_statements",
      evidenceInferred: true,
      matchedClauses: [{ id: expect.any(String), article: "12", title: "Discipline and discharge", matchCount: 5, tag: "Primary" }],
      daysRemaining: 10,
      deadlineWarning: null,
      warningDays: 5,
      suggestedInputs: { contract_support: 4, documentation: 5, timeliness: 4, witnesses: 5 },
    });
    expect(JSON.stringify(result)).not.toContain("coworker");
  });

  it("weighs the steward's evidence choice and the organization's evidence weights", async () => {
    expect(await suggest(ID.steward, "none")).toMatchObject({ evidenceScore: 30, evidenceInferred: false, suggestedInputs: { witnesses: 0, documentation: 2 } });
    await db.query(
      "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1, 'limits.casework.strength_evidence_none', '50'::jsonb)",
      [ID.org],
    );
    expect(await suggest(ID.steward, "none")).toMatchObject({ evidenceScore: 50 });
    await expect(suggest(ID.steward, "rumor")).rejects.toMatchObject({ code: "22023" });
  });

  it("warns from the case's own filing deadline within the warning days, and when it has passed", async () => {
    const deadline = (await db.query(
      `insert into public.casework_deadlines(case_id, organization_id, chapter_id, kind, label, due_at, created_by)
       values ($1, $2, $3, 'filing', 'Step 1 filing', now() + interval '3 days', $4) returning id`,
      [ID.case, ID.org, CHAPTER, ID.steward],
    )).rows[0].id;
    expect(await suggest(ID.steward)).toMatchObject({ daysRemaining: 3, deadlineWarning: "soon" });
    await db.query("update public.casework_deadlines set due_at = now() - interval '2 days' where id = $1", [deadline]);
    expect(await suggest(ID.steward)).toMatchObject({ daysRemaining: 0, deadlineWarning: "passed" });
    // #7198: a procedure clock due at the end of an Eastern day counts that
    // day, not the UTC date four or five hours later.
    await db.query(
      `update public.casework_deadlines
          set due_at = (((now() at time zone 'America/New_York')::date + 3) + time '23:59:59') at time zone 'America/New_York'
        where id = $1`,
      [deadline],
    );
    expect(await suggest(ID.steward)).toMatchObject({ daysRemaining: 3, deadlineWarning: "soon" });
    // Open through the end of its Eastern due day: 0 days and "soon" on the
    // day itself, "passed" only from the next Eastern day.
    const dueEndOf = (offset) => db.query(
      `update public.casework_deadlines
          set due_at = (((now() at time zone 'America/New_York')::date + $2::int) + time '23:59:59') at time zone 'America/New_York'
        where id = $1`,
      [deadline, offset],
    );
    await dueEndOf(0);
    expect(await suggest(ID.steward)).toMatchObject({ daysRemaining: 0, deadlineWarning: "soon" });
    await dueEndOf(-1);
    expect(await suggest(ID.steward)).toMatchObject({ daysRemaining: 0, deadlineWarning: "passed" });
  });

  it("keeps the incident filing window open through its last Eastern day, passed only after it", async () => {
    await db.query("update public.casework_deadlines set status = 'met' where case_id = $1 and status in ('active', 'extended')", [ID.case]);
    const incidentDaysAgo = (days) => db.query(
      `update public.member_forms
          set answers = answers || jsonb_build_object('incident_date', ((now() at time zone 'America/New_York')::date - $2::int)::text)
        where case_id = $1`,
      [ID.case, days],
    );
    await incidentDaysAgo(14);
    expect(await suggest(ID.steward)).toMatchObject({ daysRemaining: 0, deadlineWarning: "soon", proceduralScore: 0 });
    await incidentDaysAgo(15);
    expect(await suggest(ID.steward)).toMatchObject({ daysRemaining: 0, deadlineWarning: "passed" });
    await incidentDaysAgo(4);
  });

  it("refuses members and enforces the organization switch", async () => {
    await expect(suggest(ID.member)).rejects.toMatchObject({ code: "P0002" });
    await db.query(
      "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1, 'features.casework.strength_auto_suggest', 'false'::jsonb)",
      [ID.org],
    );
    await expect(suggest(ID.steward)).rejects.toMatchObject({ code: "55000" });
  });
});
