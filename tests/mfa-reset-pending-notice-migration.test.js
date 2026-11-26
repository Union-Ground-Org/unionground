// @vitest-environment node
//
// BUG-UG-MFA-RESET-PARTIAL-NO-MEMBER-NOTICE-20260917 — offline pins for
// 20260918090000. The live catalogue is tests/mfa-reset-pending-notice-db.test.js;
// these pins run without a database and are anchored on the LATEST declaration
// of each authority, so a future migration that re-emits one without its guard
// fails here rather than in the proof lane nobody runs locally.
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const migrations = migrationFiles();
const sql = stripComments(loadMigrationSql("20260918090000_mfa_reset_pending_member_notice"));

function latestFunction(signature) {
  const migration = [...migrations].reverse().find(({ sql: text }) => (
    stripComments(text).toLowerCase().includes(`function ${signature.toLowerCase()}`)
  ));
  expect(migration, `missing migration for ${signature}`).toBeTruthy();
  return stripComments(fnBody(migration.sql, signature));
}

const queue = () => latestFunction("public.queue_member_mfa_reset_notice(p_user_id uuid)");
const drain = () => latestFunction("public.drain_member_mfa_reset_notice(p_user_id uuid)");

describe("the owed member notice is durable", () => {
  it("records the debt on the reset boundary rather than in a new table", () => {
    // Break caught: a pending-notice table would carry its own auth.users
    // foreign keys, case-graph triggers and lifecycle manifest dispositions;
    // the reset boundary already IS the row that records the reset.
    expect(sql).toContain("alter table private.member_mfa_reset_boundaries");
    expect(sql).toContain("add column notice_owed_at timestamptz");
    expect(sql).toContain("add column notice_sent_at timestamptz");
    expect(sql).not.toMatch(/create\s+table/i);
    expect(sql).not.toMatch(/references\s+auth\.users/i);
  });

  it("marks the notice owed for the reset instant, and sends nothing", () => {
    // Break caught: stamping the mark with the CURRENT time instead of the
    // reset's own instant would move the anchor past a notice that already
    // landed, and the drain's guard would then write a second one.
    const body = queue();
    expect(body).toContain("select b.invalid_before, b.notice_sent_at into owed_at, sent_at");
    expect(body).toContain("set notice_owed_at = owed_at");
    expect(body).not.toContain("insert into public.member_notifications");
    // Bound to a reset this caller began: no debt can be minted for a member
    // nobody reset.
    expect(body).toContain("and b.reset_by = caller");
    expect(body).toContain("for update");
  });

  it("delivers at most one notice per reset, anchored on the reset and not on the audit row", () => {
    // Break caught: dropping the existence check writes a second notice for a
    // reset public.notify_member_mfa_reset already told the member about;
    // anchoring on the audit row would reinstate the fifteen-minute window the
    // record exists to escape.
    const body = drain();
    expect(body).toContain("n.created_at >= owed_at");
    expect(body).toContain("'Two-step sign-in was reset by an administrator'");
    expect(body).toContain("'Un administrador restableció la verificación en dos pasos'");
    expect(body).not.toContain("member_admin_audit");
    expect(body).toContain("sent_at is not null and sent_at >= owed_at");
    expect(body).toContain("set notice_sent_at = pg_catalog.clock_timestamp()");
    expect(body.indexOf("n.created_at >= owed_at"))
      .toBeLessThan(body.indexOf("insert into public.member_notifications"));
  });

  it("gates both authorities exactly like the reset authorities they extend", () => {
    // Break caught: a definer RPC reachable by authenticated that does not
    // force MFA, scope to the caller's organization, or refuse a self-target
    // becomes an administrator's cross-tenant notice injector.
    for (const body of [queue(), drain()]) {
      expect(body).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[])");
      expect(body).toContain("public.member_has_role(array['admin'])");
      expect(body).toContain("p_user_id is null or p_user_id = caller");
      expect(body).toContain("c.organization_id = private.current_member_organization()");
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      // Flat 42501 everywhere, so neither RPC is a membership oracle.
      expect([...body.matchAll(/errcode = '(\w+)'/g)].map((match) => match[1]))
        .toEqual(Array(body.match(/errcode = '\w+'/g).length).fill("42501"));
    }
    // The graph gate comes first, before any declaration initializer.
    for (const body of [queue(), drain()]) {
      expect(body.indexOf("private.lock_case_graph"))
        .toBeLessThan(body.indexOf("public.member_has_role"));
    }
  });

  it("revokes both authorities from everyone and re-grants only authenticated", () => {
    for (const name of ["public.queue_member_mfa_reset_notice(uuid)", "public.drain_member_mfa_reset_notice(uuid)"]) {
      expect(sql).toContain(`revoke all on function ${name}\n  from public, anon, authenticated, service_role;`);
      expect(sql).toContain(`grant execute on function ${name} to authenticated;`);
    }
    expect(sql).toContain("notify pgrst, 'reload schema';");
  });

  it("the latest begin_mfa_reset body contains the chapter-scope helper", () => {
    const body = latestFunction("public.begin_mfa_reset(p_user_id uuid)");
    expect(body).toContain("private.has_organization_role(c.organization_id, array['admin'])");
    expect(body).toContain("private.member_has_chapter_role(m.chapter_id, array['admin'])");
    expect(body).toContain("from public.member_chapter_memberships m");
    expect(body).toContain("m.status = 'active'");
    expect(body).toContain("c.organization_id = private.current_member_organization()");
    expect(body).not.toContain("private.member_has_chapter_role(p.chapter_id, array['admin'])");
  });

  it("re-declares nothing the two parent migrations installed", () => {
    // Break caught: reproducing begin_mfa_reset or record_mfa_reset to add the
    // mark means reproducing their installed case-graph wrapper preamble — the
    // trap that made PR #2114's proof collide with PR #2106's.
    for (const name of ["begin_mfa_reset", "record_mfa_reset", "notify_member_mfa_reset", "authorize_mfa_reset"]) {
      expect(sql).not.toMatch(new RegExp(`function\\s+public\\.${name}\\s*\\(`, "i"));
    }
  });
});
