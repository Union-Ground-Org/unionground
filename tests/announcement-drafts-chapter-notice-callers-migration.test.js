// @vitest-environment node
// BUG-UG-ANNOUNCEMENT-DRAFTS-SERVER-STILL-ADMITS-STEWARDS-WITHOUT-CHAPTER-NOTICES-20261115 (#8940).
//
// The two drafts functions are restated from 20261102005607 with only their
// admission check changed: a caller must be able to send to the whole chapter
// (chapter_notice_scope_allowed(chapter, null, null)) or hold the notices
// office. The live refusals and admissions are proven in
// tests/event-poll-follow-ups-gc-escalation-db.test.js.
import { describe, expect, it } from "vitest";
import { fnBody, latestFnBody, loadMigrationSql, migrationNames } from "./helpers/migration.js";

const REPAIR = "20261113147500_announcement_drafts_chapter_notice_callers";
const PREDECESSOR = "20261102005607_unit_committee_scoped_access";
const OLD = "not (private.member_has_chapter_role(chapter, array['steward', 'admin', 'vp']) or private.chapter_officer_can(chapter,'notices'))";
const NEW = "not (private.chapter_notice_scope_allowed(chapter, null, null) or private.chapter_officer_can(chapter,'notices'))";
const FUNCTIONS = [
  ["public.list_announcement_drafts", "()", "cd8e452c658bddd5067df67a2675a7fe"],
  ["public.resolve_announcement_draft", "(uuid, text)", "0d2e033f29550ccc8b3a4bb69bf7902d"],
];

describe("announcement drafts admit only chapter-wide notice senders", () => {
  const repair = loadMigrationSql(REPAIR);

  it("applies after the predecessor it restates", () => {
    const names = migrationNames();
    expect(names.indexOf(`${REPAIR}.sql`)).toBeGreaterThan(names.indexOf(`${PREDECESSOR}.sql`));
  });

  it.each(FUNCTIONS)("restates %s with only the admission check changed", (name) => {
    const before = fnBody(loadMigrationSql(PREDECESSOR), name);
    const after = fnBody(repair, name);
    expect(before).toContain(OLD);
    expect(after).toBe(before.replace(OLD, NEW));
    expect(latestFnBody(name)).toBe(after);
  });

  it.each(FUNCTIONS)("md5-guards the reviewed predecessor of %s and its receipt", (name, signature, md5) => {
    expect(repair).toContain(`pg_catalog.to_regprocedure('${name}${signature}'))) is distinct from '${md5}'`);
    expect(repair).toContain(`raise exception 'unreviewed predecessor: ${name}'`);
    expect(repair).toContain(`raise exception 'stale trigger receipt: ${name}'`);
  });

  it("refreshes only the two lifecycle receipts and changes no grant", () => {
    expect(repair).toContain("pg_catalog.split_part(object_name, '(', 1) in ('list_announcement_drafts', 'resolve_announcement_draft')");
    expect(repair).not.toMatch(/\b(grant|revoke)\b\s/i);
    expect(repair.trimEnd()).toMatch(/commit;$/);
  });
});
