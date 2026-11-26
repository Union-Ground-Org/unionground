// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("member_message_case_actor_fk_indexes");
const statements = stripComments(sql).toLowerCase().replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const indexes = [
  ["member_messages_sender_id_idx", "member_messages", "sender_id"],
  ["member_messages_redacted_by_idx", "member_messages", "redacted_by"],
  ["member_cases_restricted_by_idx", "member_cases", "restricted_by"],
];

// Union Ground's live-apply evidence package (APPLY.sql, VERIFY.sql and
// their SHA256SUMS) is a 509 operations record and is not carried; the
// migration and the catalog contract are the product surface pinned here.
describe("auth attribution FK lookup indexes", () => {
  it.each(indexes)("keeps %s in the migration and catalog contract", (name, table, column) => {
    expect(statements).toContain(`create index if not exists ${name} on public.${table} (${column});`);
    const entry = contract.indexes.find((row) => row.name === name);
    expect(entry?.table).toBe(table);
    expect(entry?.defContains).toContain(`CREATE INDEX ${name} ON public.${table} USING btree (${column})`);
  });

  it("changes only the three indexes in a single migration transaction", () => {
    const expected = indexes.map(([name, table, column]) => `create index if not exists ${name} on public.${table} (${column});`).join(" ");
    expect(statements).toBe(`begin; set local lock_timeout = '5s'; set local statement_timeout = '120s'; ${expected} commit;`);
    expect(sql).toContain("LIVE APPLY");
    expect(sql).toContain("CONCURRENTLY cannot run inside");
  });
});
