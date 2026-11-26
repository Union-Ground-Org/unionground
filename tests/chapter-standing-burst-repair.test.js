// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("20260904053000_chapter_standing_burst_repair.sql");
const executable = stripComments(sql).toLowerCase();
const standing = stripComments(fnBody(sql, "public.get_chapter_standing()"));
const proof = readFileSync("scripts/verify-chapter-standing-burst-local.mjs", "utf8");

describe("chapter-standing burst repair", () => {
  it("reduces the points ledger to one materialized base scan with a quarter-leading covering index", () => {
    expect(executable).toContain("create index member_point_events_occurred_user_cover_idx");
    expect(executable).not.toContain("create index if not exists member_point_events_occurred_user_cover_idx");
    expect(executable).toContain("on public.member_point_events (occurred_at, user_id) include (points)");
    expect(standing).toContain("with member_totals as materialized");
    expect(standing.match(/from public\.member_point_events/g)).toHaveLength(1);
    expect(standing).toContain("count(*) filter (where total > caller_total)");
  });

  it("preserves the MFA, cohort-floor, frozen-window, and non-ordinal privacy contract", () => {
    expect(standing).toContain("security definer");
    expect(standing).toContain("set search_path = ''");
    expect(standing).toContain("private.mfa_satisfied()");
    expect(standing).toContain("k constant integer := 25");
    expect(standing).toContain("if cohort < k then");
    expect(standing).toContain("date_trunc('quarter', now() at time zone 'America/New_York')");
    expect(standing).toContain("'standingBand'");
    expect(standing).toContain("'cohortBand'");
    expect(standing).not.toMatch(/'rank\w*'/i);
    expect(standing).not.toContain("'myTotal'");
    expect(executable).toContain("revoke all on function public.get_chapter_standing() from public, anon");
    expect(executable).toContain("grant execute on function public.get_chapter_standing() to authenticated");
  });

  it("ships a fail-closed loopback-only parity, plan, timeout, and 32-call burst proof", () => {
    expect(proof).toContain("Refusing chapter-standing proof against non-local host");
    expect(proof).toContain("REPRESENTATIVE_MEMBERS = 1_000");
    expect(proof).toContain("REPRESENTATIVE_POINT_EVENTS_PER_MEMBER = 80");
    expect(proof).toContain("BURST_CONCURRENCY = 32");
    expect(proof).toContain("BURST_STATEMENT_TIMEOUT_MS = 750");
    expect(proof).toContain("oldResults");
    expect(proof).toContain("assert.deepEqual(newResults, oldResults");
    expect(proof).toContain("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)");
    expect(proof).toContain("drop database if exists");
  });
});
