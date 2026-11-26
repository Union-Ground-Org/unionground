// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("member_actor_fk_indexes_2");
const statements = stripComments(sql).toLowerCase().replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const indexes = [
  [
    "member_event_checkins_scanned_by_idx",
    "member_event_checkins",
    "scanned_by"
  ],
  [
    "member_forms_artifact_approved_by_idx",
    "member_forms",
    "artifact_approved_by"
  ],
  [
    "member_steward_requests_handled_by_idx",
    "member_steward_requests",
    "handled_by"
  ],
  [
    "member_roles_granted_by_idx",
    "member_roles",
    "granted_by"
  ],
  [
    "member_role_chapters_granted_by_idx",
    "member_role_chapters",
    "granted_by"
  ],
  [
    "member_invitation_audit_actor_idx",
    "member_invitation_audit",
    "actor"
  ]
];

// Union Ground's live-apply evidence package (APPLY.sql, VERIFY.sql and
// their SHA256SUMS) is a 509 operations record and is not carried; the
// migration and the catalog contract are the product surface pinned here.
describe("remaining auth attribution FK lookup indexes", () => {
  it.each(indexes)("keeps %s in the migration and catalog contract", (name, table, column) => {
    expect(statements).toContain(`create index if not exists ${name} on public.${table} (${column});`);
    const entry = contract.indexes.find((row) => row.name === name);
    expect(entry?.table).toBe(table);
    expect(entry?.defContains).toContain(`CREATE INDEX ${name} ON public.${table} USING btree (${column})`);
  });

  it("changes only the six indexes in a single migration transaction", () => {
    const expected = indexes.map(([name, table, column]) => `create index if not exists ${name} on public.${table} (${column});`).join(" ");
    expect(statements).toBe(`begin; set local lock_timeout = '5s'; set local statement_timeout = '120s'; ${expected} commit;`);
    expect(sql).toContain("LIVE APPLY");
    expect(sql).toContain("CONCURRENTLY cannot run inside");
  });
});
