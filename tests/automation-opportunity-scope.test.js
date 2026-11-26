// @vitest-environment node
//
// UX-UG-DISCOVER-LABELS-OPPORTUNITY-SCOPE-CHAPTER-NON-APPROVER-ORG-LEVEL-20260921
//
// public.mi1_get_automation_opportunities counted every chapter the caller
// staffs — org-wide for a single public.organization_role_grants row — and then
// labelled the result from private.automation_v3_actor_is_approver. A
// coordinator granted at organization scope therefore read "47 currently match
// · chapter scope" over an org-wide number, while an admin read the same 47 as
// "organization".
//
// The label and the counts now come from one chapter array, so they cannot
// disagree, and the payload names the single counted chapter when there is one.
// The behavioral half of this regression lives in the registered proof runner
// (a disposable database with two chapters, an organization-level advisor and a
// chapter-only steward); the pins below keep the definition, its contract entry
// and that proof from drifting apart.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeAutomationOpportunities } from "../src/features/automation/controlPlane.js";
import { fnBody, migrationFiles } from "./helpers/migration.js";

const DECLARATION = "create or replace function public.mi1_get_automation_opportunities()";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const proofRunner = readFileSync(new URL("../scripts/verify-automation-shared-intelligence-v3-local.mjs", import.meta.url), "utf8");

// The LAST migration that redefines the detector is the one Postgres ends up
// holding; pinning the repair file by name would go green forever even after a
// later migration put the approver-derived label back.
function lastDefinition() {
  // Case-insensitive: a later migration may restate the routine in
  // pg_get_functiondef form (CREATE OR REPLACE FUNCTION ... AS $function$), as #8568 does.
  const entry = migrationFiles().filter((file) => file.sql.toLowerCase().includes(DECLARATION)).at(-1);
  if (!entry) throw new Error(`no migration declares ${DECLARATION}`);
  return { name: entry.name, declaration: fnBody(entry.sql, "public.mi1_get_automation_opportunities") };
}

// pg_proc.prosrc is exactly the dollar-quoted body, which is what the contract
// pins with sourceMd5, so the file can answer for the live routine offline.
function storedSource(declaration) {
  const start = declaration.toLowerCase().indexOf("as $function$") + "as $function$".length;
  return declaration.slice(start, declaration.lastIndexOf("$function$;"));
}

describe("automation opportunity scope follows the counted population", () => {
  it("derives the scope label from the chapters the caller staffs, not from approval", () => {
    const { declaration } = lastDefinition();
    expect(declaration).toContain("private.actor_has_chapter_staff_role(actor, ch.id)");
    expect(declaration).toContain("t.chapter_id = any(counted_chapters)");
    expect(declaration).toMatch(
      /scope_label := case\s+when organization_chapters > 0\s+and pg_catalog\.cardinality\(counted_chapters\) = organization_chapters then 'organization'\s+else 'chapter'\s+end;/,
    );
    expect(declaration).not.toContain("automation_v3_actor_is_approver");
  });

  it("names the single counted chapter and leaves the bounded row projection alone", () => {
    const { declaration } = lastDefinition();
    expect(declaration).toMatch(/scope_chapter := case\s+when pg_catalog\.cardinality\(counted_chapters\) = 1 then counted_chapters\[1\]/);
    expect(declaration).toContain("'scopeChapterId', scope_chapter");
    expect(declaration).toContain("limit 8");
    const projection = declaration.slice(
      declaration.indexOf("pg_catalog.jsonb_agg("),
      declaration.indexOf(") order by candidate_count desc"),
    );
    // The shipped client and the Compass request body both refuse a row
    // carrying any other key, so the chapter identifier stays off the rows.
    expect([...projection.matchAll(/'([A-Za-z]+)',/g)].map((match) => match[1])).toEqual([
      "triggerKind", "candidateCount", "thresholdDays", "scope", "covered",
    ]);
  });

  it("pins the repaired routine in the database contract", () => {
    const { declaration } = lastDefinition();
    const entry = contract.functions.find((row) => row.sig === "public.mi1_get_automation_opportunities()");
    expect(entry.sourceMd5).toBe(createHash("md5").update(storedSource(declaration)).digest("hex"));
    expect(entry.bodyForbids).toContain("private.automation_v3_actor_is_approver");
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "private.actor_has_chapter_staff_role(actor, ch.id)",
      "t.chapter_id = any(counted_chapters)",
    ]));
  });

  it("keeps the disposable-database proof asserting both callers", () => {
    expect(proofRunner).toContain('opportunity.scopeChapterId === "automation-v3-visible"');
    expect(proofRunner).toMatch(
      /asRole\(client, "authenticated", ids\.advisor\);\s+const orgWide = await rpc\("mi1_get_automation_opportunities"\)/,
    );
    expect(proofRunner).toContain('orgWideOverdue?.candidateCount === 2 && orgWideOverdue.scope === "organization" && orgWide.scopeChapterId === null');
  });

  it("carries the counted chapter to the client and refuses an unusable one", () => {
    const payload = (patch = {}) => ({
      capabilityVersion: 2,
      observedAt: "2026-09-22T12:00:00Z",
      scopeChapterId: "chapter-a",
      rows: [{ triggerKind: "overdue_task", candidateCount: 4, thresholdDays: 1, scope: "chapter", covered: false }],
      ...patch,
    });
    expect(normalizeAutomationOpportunities(payload()).scopeChapterId).toBe("chapter-a");
    expect(normalizeAutomationOpportunities(payload({ scopeChapterId: null })).scopeChapterId).toBeNull();
    expect(normalizeAutomationOpportunities(payload({ scopeChapterId: "" }))).toBeNull();
    expect(normalizeAutomationOpportunities(payload({ scopeChapterId: 7 }))).toBeNull();
  });
});
