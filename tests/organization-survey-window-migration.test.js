// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("organization_survey_write_window");
const code = stripComments(sql).toLowerCase();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const body = fnBody(sql, "private.mi1_w2_upsert_survey_session").toLowerCase();

describe("organization survey write-window migration", () => {
  it("replaces private.mi1_w2_upsert_survey_session with the 3-arg signature", () => {
    expect(code).toContain("create or replace function private.mi1_w2_upsert_survey_session(");
    expect(body).toContain("p_survey_id uuid");
    expect(body).toContain("p_answers jsonb");
    expect(body).toContain("p_submit boolean");
  });

  it("carries the 20260907151000 case-graph lock preamble across the replace", () => {
    const lockAt = code.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);");
    expect(lockAt).toBeGreaterThan(code.indexOf("create or replace function private.mi1_w2_upsert_survey_session("));
    expect(lockAt).toBeLessThan(code.indexOf("declare"));
    // The account-lifecycle concurrency proof reads the gate from the raw
    // installed source, so nothing (not even a comment) may precede it.
    expect(sql).toMatch(/as \$function\$\s*begin\s+perform private\.lock_case_graph\(/i);
  });

  it("uses the same null-unbounded opens_at/closes_at window the member snapshot reads", () => {
    expect(body).toContain("survey.opens_at is null or survey.opens_at <= pg_catalog.now()");
    expect(body).toContain("survey.closes_at is null or survey.closes_at > pg_catalog.now()");
  });

  it("refuses outside the window with the same not-found P0002 as a hidden survey", () => {
    expect(body).toContain("raise exception 'not found' using errcode = 'p0002'");
    expect(body.match(/raise exception 'not found'/g)).toEqual([
      "raise exception 'not found'",
    ]);
    expect(body).not.toMatch(/survey window|this survey is closed|not yet open/);
  });

  it("raises the window refusal before any session insert", () => {
    const windowAt = body.indexOf("survey.opens_at is null or survey.opens_at <= pg_catalog.now()");
    const insertAt = body.indexOf("insert into public.organization_survey_sessions");
    expect(windowAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThan(windowAt);
  });

  it("pins the window terms on the db-contract signature", () => {
    const entry = contract.functions.find(
      (fn) => fn.sig === "private.mi1_w2_upsert_survey_session(p_survey_id uuid, p_answers jsonb, p_submit boolean)",
    );
    expect(entry?.bodyContains).toEqual(expect.arrayContaining([
      "survey.opens_at is null or survey.opens_at <= pg_catalog.now()",
      "survey.closes_at is null or survey.closes_at > pg_catalog.now()",
    ]));
  });

  it("re-issues the private execute boundary without rewriting accepted sessions", () => {
    expect(code).toContain("revoke all on function private.mi1_w2_upsert_survey_session(uuid, jsonb, boolean)");
    expect(code).toContain("from public, anon, authenticated, service_role");
    expect(code).not.toContain("close_organization_survey");
    expect(code).not.toMatch(/delete from public\.organization_survey_sessions/);
  });
});
