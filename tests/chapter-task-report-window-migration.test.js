// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, migrationFiles, stripComments } from "./helpers/migration.js";

const migrations = migrationFiles();
const contract = JSON.parse(
  readFileSync(resolve(process.cwd(), "scripts/db-contract.json"), "utf8"),
);

function latestFunction(signature) {
  const name = signature.slice(0, signature.indexOf("("));
  const migration = [...migrations].reverse().find(({ sql }) => (
    stripComments(sql).toLowerCase().includes(`function ${name.toLowerCase()}`)
  ));
  expect(migration, `missing migration for ${signature}`).toBeTruthy();
  return {
    name: migration.name,
    sql: stripComments(migration.sql),
    body: stripComments(fnBody(migration.sql, name)),
  };
}

describe("chapter_task_report window admits undated work and late finishers", () => {
  const latest = latestFunction("public.chapter_task_report(p_from date, p_to date)");

  it("keeps the latest definition at or after the report-window repair", () => {
    expect(latest.name >= "20260922013000_chapter_task_report_window_repair.sql").toBe(true);
  });

  it("no longer stands the due_date bound alone, and admits undated plus in-window finishers", () => {
    expect(latest.body).not.toMatch(/and\s+t\.due_date\s*>=\s*range_from/);
    expect(latest.body).toContain("t.due_date is null");
    expect(latest.body).toContain("private.eastern_day(t.done_at) between range_from and range_to");
    expect(latest.body).toContain(
      "(t.due_date is null or private.eastern_day(t.done_at) between range_from and range_to or t.due_date >= range_from)",
    );
  });

  it("bounds every completion by the named end date, not only the undated arm", () => {
    expect(latest.body).toContain(
      "(t.done_at is null or private.eastern_day(t.done_at) between range_from and range_to)",
    );
    expect(latest.body).not.toMatch(
      /t\.done_at is null or t\.done_at::date >= range_from/,
    );
    expect(latest.body).not.toMatch(
      /t\.due_date is null and \(t\.done_at is null or t\.done_at::date <= range_to\)/,
    );
  });

  it("reads every day through private.eastern_day, never an inline zone or the session day", () => {
    expect(latest.name >= "20261113122500_eastern_day_helper.sql").toBe(true);
    expect(latest.body).not.toMatch(/at time zone/i);
    for (const column of ["done_at", "created_at", "deleted_at"]) {
      expect(latest.body).toContain(`private.eastern_day(t.${column})`);
    }
    expect(latest.body).toContain("pg_catalog.to_char(private.eastern_day(done_at), 'YYYY-MM')");
  });

  it("counts NULL due_date toward neither done_late nor overdue", () => {
    expect(latest.body).toContain(
      "done_at is not null and due_date is not null and done_on > due_date",
    );
    // #8563: the overdue cut is today's Eastern date, never the session day.
    const overdue = [...latest.body.matchAll(
      /status <> 'done' and due_date is not null and due_date < today/g,
    )];
    expect(latest.body).not.toMatch(/current_date/);
    expect(overdue).toHaveLength(2);
  });

  it("keeps the staff gate, MFA gate, chapter bound, deleted filter and grants", () => {
    expect(latest.body).toContain("if caller is null or not private.mfa_satisfied() then");
    expect(latest.body).toContain(
      "member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])",
    );
    expect(latest.body).toContain("t.chapter_id = caller_chapter");
    expect(latest.body).toContain("t.deleted_at is null");
    expect(latest.body).toContain("if private.chapter_belongs_to_platform(caller_chapter) then");
    expect(latest.sql).toContain(
      "revoke all on function public.chapter_task_report(date, date) from public, anon, authenticated",
    );
    expect(latest.sql).toContain(
      "grant execute on function public.chapter_task_report(date, date) to authenticated",
    );
  });

  it("pins the repaired predicate in the db contract and names the remaining narrowing", () => {
    const entry = contract.functions.find(
      (item) => item.sig === "public.chapter_task_report(p_from date, p_to date)",
    );
    expect(entry.bodyContains).toEqual([
      "if caller is null or not private.mfa_satisfied() then",
      "member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])",
      "t.deleted_at is null",
      "(t.done_at is null or private.eastern_day(t.done_at) between range_from and range_to)",
      "(t.due_date is null or private.eastern_day(t.done_at) between range_from and range_to or t.due_date >= range_from)",
      "today date := private.eastern_day();",
      "range_to := coalesce(p_to, today);",
      "private.chapter_belongs_to_platform(caller_chapter)",
    ]);
    expect(entry.note).toMatch(/open dated task due before a bounded window/i);
    expect(entry.note).toMatch(/was a defect/i);
    expect(entry.note).toMatch(/completions share the report window/i);
    expect(entry.note).not.toMatch(/known quirk \(accepted, pr-b\)/i);
    expect(entry.note).not.toMatch(/shrinks open counts/i);
  });
});
