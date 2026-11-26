// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const migration = loadMigrationSql("20261010152000_uniondemo_upcoming_event_topup.sql");
const code = stripComments(migration);
const body = fnBody(migration, "public.uniondemo_topup_upcoming_events");

describe("union demo upcoming-event top-up", () => {
  it("runs inside one transaction", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("adds exactly one function and seeds nothing by itself", () => {
    expect(code.match(/create or replace function/gu)).toHaveLength(1);
    // The migration body outside the function must not write a row: the rows
    // only ever appear when the guarded function is called.
    const outside = code.replace(body, "");
    expect(outside).not.toMatch(/insert\s+into/u);
  });

  it("is a pinned security definer behind the union demo authorization", () => {
    expect(code).toMatch(/security definer/u);
    expect(code).toMatch(/set search_path = ''/u);
    expect(body).toMatch(/perform private\.uniondemo_authorize\(p_target_ref, p_confirm_token\)/u);
    // The guard runs before the insert, not after it.
    expect(body.indexOf("uniondemo_authorize")).toBeLessThan(body.indexOf("insert into"));
  });

  it("takes the case-graph gate first, as a member_events writer", () => {
    // public.member_events is a reviewed case-graph relation, so this function
    // is a case-graph writer: the gate has to be the first statement, ahead of
    // every declaration initializer and the authorization read, or
    // tests/account-case-graph-lock-inventory.test.js reports it. The
    // declarations therefore live in a nested block.
    expect(body).toMatch(/as \$\$\s*begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);/u);
    expect(body.indexOf("lock_case_graph")).toBeLessThan(body.indexOf("uniondemo_authorize"));
  });

  it("only inserts, and only into member_events", () => {
    expect(body.match(/insert into/gu)).toHaveLength(1);
    expect(body).toMatch(/insert into\s+public\.member_events/u);
    // Statement forms only: the event copy itself says "contract update".
    expect(body).not.toMatch(/\bupdate\s+(public|private)\./u);
    expect(body).not.toMatch(/\bdelete\s+from\b/u);
    expect(body).not.toMatch(/\btruncate\b/u);
    expect(body).toMatch(/on conflict \(id\) do nothing/u);
  });

  it("keeps the ud-evt- prefix the cleanup contract owns, stamped per day", () => {
    expect(body).toMatch(/'ud-evt-' \|\| eligible_chapter\.chapter_id \|\| '-up' \|\| stamp/u);
    expect(body).toMatch(/to_char\(pg_catalog\.now\(\), 'YYYYMMDD'\)/u);
  });

  it("can only reach chapters the union demo seed already mapped", () => {
    expect(body).toMatch(/from private\.uniondemo_chapters m/u);
    expect(body).toMatch(/raise exception 'none of those chapters belong to the union demo organization'/u);
  });

  it("respects the member_events constraints the rows must satisfy", () => {
    // UNIQUE (chapter_id, order_index): the new rows start above the chapter's
    // current maximum instead of at a fixed band.
    expect(body).toMatch(/coalesce\(pg_catalog\.max\(existing\.order_index\), 0\)/u);
    // member_events_schedule_check: a meeting sets starts_at and no event_date.
    expect(body).toMatch(/starts_at,/u);
    expect(body).not.toMatch(/event_date/u);
    // member_events_check_in_code_check: ^SG-[0-9A-Z]{3,12}$.
    expect(body).toMatch(/'SG-' \|\| pg_catalog\.upper\(pg_catalog\.substr\(pg_catalog\.md5\(/u);
  });

  it("gives the demo window three meetings inside the next fortnight", () => {
    const days = [...body.matchAll(/\((\d), '[^']+', (\d+), \d+,/gu)].map((match) => Number(match[2]));
    expect(days).toHaveLength(3);
    for (const day of days) {
      expect(day).toBeGreaterThan(0);
      expect(day).toBeLessThanOrEqual(14);
    }
  });

  it("is executable by service_role alone", () => {
    expect(code).toMatch(/revoke all on function public\.uniondemo_topup_upcoming_events\(text\[\], text, text\)\s*\n?\s*from public, anon, authenticated;/u);
    expect(code).toMatch(/grant execute on function public\.uniondemo_topup_upcoming_events\(text\[\], text, text\)\s*\n?\s*to service_role;/u);
  });
});
