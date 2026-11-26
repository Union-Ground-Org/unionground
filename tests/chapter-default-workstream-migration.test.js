// @vitest-environment node
// REQ-UG-TASKS-WORKSTREAM-ASSIGNEES-DUE-DATES-20261030: static shape
// of the default-workstream function.
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("20261030214500_chapter_default_workstream");
const code = stripComments(sql);
const body = fnBody(sql, "public.ensure_chapter_default_workstream");

describe("chapter default workstream migration", () => {
  it("runs in one bounded transaction and adds no trigger or table", () => {
    expect(code).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';\s*set local statement_timeout = '60s';/);
    expect(code.trim().endsWith("commit;")).toBe(true);
    expect(code).not.toMatch(/create (table|trigger)/i);
  });

  it("is a definer function gated on a signed-in, two-step session in the caller's own chapter", () => {
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);")).toBeLessThan(body.indexOf("caller := "));
    expect(body).toContain("if caller is null or not private.mfa_satisfied() then");
    expect(body).toContain("caller_chapter := private.current_member_chapter();");
    expect(code).toContain("revoke all on function public.ensure_chapter_default_workstream() from public, anon, authenticated, service_role;");
    expect(code).toContain("grant execute on function public.ensure_chapter_default_workstream() to authenticated;");
  });

  it("adds General only to a chapter with no workstream, serialized per chapter", () => {
    const lock = body.indexOf("pg_catalog.pg_advisory_xact_lock(");
    const guard = body.indexOf("if not exists (select 1 from public.chapter_workstreams w where w.chapter_id = caller_chapter) then");
    const insert = body.indexOf("values (caller_chapter, 'General', null)");
    expect(lock).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(guard);
    expect(body).toContain("on conflict (chapter_id, name) do nothing;");
    expect(body).toContain("where w.chapter_id = caller_chapter");
  });
});
