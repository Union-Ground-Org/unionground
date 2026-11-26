// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

// Origin DDL that later migrations do not repeat. Behavior pins below resolve
// the last definition of each RPC and policy, matching
// tests/event-organization-isolation-repair.test.js, so a superseded body
// cannot keep this file green.
const originSql = loadMigrationSql("20260812170000_chapter_scoped_events.sql");
const migrations = migrationFiles();

function latestFunction(signature) {
  const name = signature.slice(0, signature.indexOf("("));
  const create = new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+${name.replace(/\./g, "\\.")}\\s*\\(`, "i");
  const migration = [...migrations].reverse().find(({ sql }) => create.test(stripComments(sql)));
  expect(migration, `missing migration for ${signature}`).toBeTruthy();
  return stripComments(fnBody(migration.sql, name));
}

function latestPolicy(name) {
  const migration = [...migrations].reverse().find(({ sql }) => (
    stripComments(sql).toLowerCase().includes(`create policy ${name.toLowerCase()}`)
  ));
  expect(migration, `missing migration for policy ${name}`).toBeTruthy();
  const sql = stripComments(migration.sql);
  const start = sql.toLowerCase().lastIndexOf(`create policy ${name.toLowerCase()}`);
  return sql.slice(start, sql.indexOf(";", start) + 1);
}

function latestMigrationSql(needle) {
  const migration = [...migrations].reverse().find(({ sql }) => (
    stripComments(sql).toLowerCase().includes(needle.toLowerCase())
  ));
  expect(migration, `missing migration containing ${needle}`).toBeTruthy();
  return stripComments(migration.sql);
}

const memberEventPrivileges = migrations
  .map(({ sql }) => stripComments(sql))
  .filter((sql) => /on\s+public\.member_events\b/i.test(sql))
  .join("\n");

describe("chapter-scoped events migration", () => {
  it("keeps the historical origin schema for chapter ownership and agency flags", () => {
    expect(originSql).toContain("add column chapter_id text references public.chapters(id) on update cascade on delete restrict");
    expect(originSql).toContain("add column is_public boolean not null default false");
    expect(originSql).toContain("add column is_public_across_agencies boolean not null default false");
    expect(originSql).toContain("set chapter_id = default_chapter, is_public_across_agencies = true");
    expect(originSql).toContain("alter column chapter_id set not null");
    expect(originSql).toContain("unique (chapter_id, order_index)");
    // One-time replacement of the unrestricted read. Later files recreate
    // member_events_select_scoped; they do not repeat this drop.
    expect(originSql).toContain("drop policy member_events_select_all on public.member_events");
  });

  it("reads the live member event policy as tenant-first, chapter, same-agency, and cross-agency", () => {
    // Break caught: the origin policy's `chapter_id = private.current_member_chapter()`
    // predicate is gone. The last policy compares organization, then chapter,
    // with caller context as init plans and the region match as a scalar subquery.
    const policy = latestPolicy("member_events_select_scoped");
    expect(policy).toContain("(select private.current_member_organization()) is not null");
    expect(policy).toContain("event_chapter.organization_id = (select private.current_member_organization())");
    expect(policy).toContain("event_chapter.id = (select private.current_member_chapter())");
    expect(policy).toContain("coalesce(member_events.is_public_across_agencies, false)");
    expect(policy).toContain("coalesce(member_events.is_public, false)");
    expect(policy).toContain("event_chapter.region is not null");
    expect(policy).toMatch(
      /event_chapter\.region = \(\s*select member_chapter\.region\s*from public\.chapters member_chapter/i,
    );
    expect(policy).not.toContain("using (true)");
    expect(policy).not.toContain("private.member_can_access_event_scope(");
    expect(policy.indexOf("event_chapter.organization_id = (select private.current_member_organization())"))
      .toBeLessThan(policy.indexOf("or coalesce(member_events.is_public_across_agencies"));
  });

  it("scopes the live member RSVP and check-in child reads through their parent event", () => {
    for (const name of ["member_event_rsvps_select_own", "member_event_checkins_select_own"]) {
      const policy = latestPolicy(name);
      expect(policy).toContain("(select auth.uid()) = user_id");
      expect(policy).toContain("from public.member_events event");
      // #7499: the caller's scope (private.member_event_caller_scope, built
      // from private.member_can_access_event_scope_for_user) resolves once per
      // statement, and each event is matched against it.
      expect(policy).toMatch(
        /private\.member_event_scope_allows\(\s*\(select private\.member_event_caller_scope\(\)\),\s*event\.chapter_id,\s*event\.is_public,\s*event\.is_public_across_agencies\s*\)/,
      );
    }
    const scope = latestFunction("private.member_event_caller_scope()");
    for (const flags of ["false, false", "true, false", "false, true"]) {
      expect(scope).toContain(`private.member_can_access_event_scope_for_user(caller.id, c.id, ${flags})`);
    }
  });

  it("makes every live member action treat an out-of-scope event as not found", () => {
    for (const signature of [
      "public.rsvp_to_event(p_event_id text, p_status text)",
      "public.check_in_to_event(p_event_id text, p_code text)",
      "public.request_event_checkin_token(p_event_id text)",
    ]) {
      const body = latestFunction(signature);
      expect(body).toContain("private.mfa_satisfied()");
      expect(body).toContain("caller uuid := (select auth.uid())");
      expect(body).toContain("for share");
      expect(body).toMatch(
        /private\.member_can_access_event_scope\(\s*e\.chapter_id,\s*e\.is_public,\s*e\.is_public_across_agencies\s*\)/,
      );
      expect(body).toContain("event not found");
    }
  });

  it("keeps live scanning on the steward's own chapter instead of cross-agency event visibility", () => {
    const body = latestFunction("public.scan_event_checkin(p_event_id text, p_token text)");
    expect(body).toContain("member_has_role(array['steward'])");
    expect(body).toContain("caller uuid := (select auth.uid())");
    expect(body).toContain("for update of e");
    const eventRead = body.slice(
      body.indexOf("from public.member_events e"),
      body.indexOf("for update of e"),
    );
    expect(eventRead).toContain("e.chapter_id = caller_chapter");
    expect(eventRead).not.toMatch(/is_public/);
  });

  it("keeps the live calendar resolver service-only and filters RSVP rows through the token owner's event scope", () => {
    const body = latestFunction("public.get_calendar_feed_events(p_token text)");
    expect(body).toContain("(select auth.role()) <> 'service_role'");
    expect(body).toMatch(
      /private\.member_can_access_event_scope_for_user\(\s*target,\s*e\.chapter_id,\s*e\.is_public,\s*e\.is_public_across_agencies\s*\)/,
    );
    const privileges = latestMigrationSql("grant execute on function public.get_calendar_feed_events");
    expect(privileges).toContain("revoke all on function public.get_calendar_feed_events(text) from public, anon, authenticated");
    expect(privileges).toContain("grant execute on function public.get_calendar_feed_events(text) to service_role");
  });

  it("server-stamps the publisher chapter, scopes order allocation, and audits visibility", () => {
    const body = latestFunction("public.create_member_event(p_id text, p_title text, p_starts_at timestamptz, p_location text, p_summary text, p_check_in_code text, p_is_public boolean default false, p_is_public_across_agencies boolean default false)");
    expect(body).toContain("private.member_can_manage_events()");
    expect(body).toContain("private.current_member_chapter()");
    expect(body).toContain("hashtextextended('member_events:order_index:' || caller_chapter");
    expect(body).toContain("where chapter_id = caller_chapter");
    expect(body).toContain("'isPublic', p_is_public");
    expect(body).toContain("'isPublicAcrossAgencies', p_is_public_across_agencies");
    expect(body).not.toContain("p_chapter_id");
    expect(body).toContain("recipient.chapter_id = caller_chapter");
    expect(body).toContain("recipient_chapter.region = publisher_chapter.region");
    expect(body).toContain("p_is_public_across_agencies");
  });

  it("limits live admin listing and updates to the caller chapter", () => {
    for (const signature of [
      "public.get_admin_events()",
      "public.update_member_event(p_id text, p_title text default null, p_starts_at timestamptz default null, p_location text default null, p_summary text default null, p_check_in_code text default null, p_is_public boolean default null, p_is_public_across_agencies boolean default null)",
    ]) {
      const body = latestFunction(signature);
      expect(body).toContain("private.member_can_manage_events()");
      expect(body).toContain("private.current_member_chapter()");
      expect(body).toContain("caller uuid := (select auth.uid())");
    }
  });

  it("binds live cancel, restore, and delete to the staff caller's current chapter", () => {
    for (const signature of [
      "public.cancel_member_event(p_id text, p_reason text default null)",
      "public.restore_member_event(p_id text)",
      "public.delete_member_event(p_id text)",
    ]) {
      const body = latestFunction(signature);
      expect(body).toContain("private.member_can_manage_events()");
      expect(body).toContain("private.current_member_chapter()");
      expect(body).toContain("caller uuid := (select auth.uid())");
      expect(body).toContain("where id = p_id and chapter_id = caller_chapter");
      expect(body).toContain("for update");
    }
  });

  it("never widens member table writes or exposes the check-in code", () => {
    expect(memberEventPrivileges).toContain("revoke all on public.member_events from anon, authenticated");
    expect(memberEventPrivileges).toContain("grant select (id, title, starts_at, location, summary, order_index, created_at, chapter_id, is_public, is_public_across_agencies) on public.member_events to authenticated");
    expect(memberEventPrivileges).not.toMatch(/grant select \([^)]*check_in_code[^)]*\) on public\.member_events/i);
    expect(memberEventPrivileges).not.toMatch(/grant\s+(insert|update|delete|all)[^;]*on\s+(table\s+)?public\.member_events\s+to\s+authenticated/i);
  });
});
