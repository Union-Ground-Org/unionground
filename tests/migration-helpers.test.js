// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

// stripComments is load-bearing for the whole migration-pin suite: every
// "the migration must NOT do X" assertion in ~30 files is only sound if what it
// scans is executable SQL. The copies this helper replaced were wrong in both
// directions — one missed inline trailing comments (so a needle could match
// text that was actually commented out), the others ate `--` inside quoted
// literals (so a needle could fail to match text that was live). Both failure
// modes are pinned here so neither can come back.
describe("stripComments", () => {
  it("removes a whole-line comment", () => {
    expect(stripComments("-- grant insert on t to authenticated;\nselect 1;")).toBe("\nselect 1;");
  });

  it("removes an inline trailing comment", () => {
    // The WL-33 case. A stripper anchored to ^ leaves the tail behind, and the
    // negative pins then read a commented-out grant as a live one.
    expect(stripComments("select 1; -- grant insert on t to authenticated;\n")).toBe("select 1; \n");
  });

  it("keeps a -- that lives inside a single-quoted literal", () => {
    // 'em--dash' is data. Stripping from the hyphens onward truncates the
    // statement and every pin on the rest of the line silently stops matching.
    const sql = "select 'a--b' as label; -- trailing\n";
    expect(stripComments(sql)).toBe("select 'a--b' as label; \n");
  });

  it("does not let an apostrophe inside a comment open a literal", () => {
    // The comment is consumed before the quote is ever seen, so the `--` on the
    // next line is still recognised as a comment.
    expect(stripComments("-- don't do this\nselect 1; -- nor this\n")).toBe("\nselect 1; \n");
  });

  it("removes a block comment, including a nested one", () => {
    // Postgres nests /* */, so a depth-tracking scan is required: stopping at
    // the first */ would leave the outer comment's tail behind as if it were
    // SQL. This is the case that makes the naive fix wrong.
    expect(stripComments("/* header /* nested */ still comment */select 1;")).toBe("select 1;");
    expect(stripComments("select /* inline */ 1;")).toBe("select  1;");
  });

  it("keeps a /* that lives inside a single-quoted literal", () => {
    expect(stripComments("select '/*' as glyph;")).toBe("select '/*' as glyph;");
  });

  it("treats a doubled quote as an escape, not the end of the literal", () => {
    expect(stripComments("select 'it''s -- fine'; -- gone\n")).toBe("select 'it''s -- fine'; \n");
  });
});

describe("loadMigrationSql", () => {
  it("resolves a migration by filename fragment", () => {
    expect(loadMigrationSql("truncate_revoke_client_tables")).toContain("revoke truncate");
  });

  it("refuses a fragment that matches no migration", () => {
    expect(() => loadMigrationSql("no_such_migration_anywhere")).toThrow(/found 0/);
  });

  it("refuses an ambiguous fragment rather than silently pinning the older file", () => {
    expect(() => loadMigrationSql(".sql")).toThrow(/expected exactly one migration/);
  });
});

describe("fnBody", () => {
  const sql = loadMigrationSql("member_events_rsvp_checkin");

  it("returns the whole declaration, terminator included", () => {
    const body = fnBody(sql, "public.rsvp_to_event");
    expect(body).toMatch(/^create (or replace )?function public\.rsvp_to_event\(/);
    expect(body.endsWith("$$;")).toBe(true);
  });

  it("accepts a bare name, a qualified name and a pasted statement alike", () => {
    const bare = fnBody(sql, "rsvp_to_event");
    expect(fnBody(sql, "public.rsvp_to_event")).toBe(bare);
    expect(fnBody(sql, "create function public.rsvp_to_event")).toBe(bare);
  });

  it("says which function is missing instead of returning a slice of the next one", () => {
    expect(() => fnBody(sql, "not_a_function_in_here")).toThrow(/not declared/);
  });

  it.each(["$$", "$function$"])("stops at a %s closing tag with a separate semicolon", (tag) => {
    const first = `create function public.first() returns int language sql as ${tag} select 1 ${tag}\n;`;
    const next = `create function public.second() returns int language sql as ${tag} select 2 ${tag};`;
    expect(fnBody(`${first}\n${next}`, "public.first")).toBe(first);
  });
});

describe("latestFnBody", () => {
  it("returns the last create-or-replace body in apply order", () => {
    // 20260918070000 re-emitted the function and Union Ground's
    // 20261015110000 re-emits it again; the later one is the live body.
    expect(latestFnBody("get_admin_org_structure")).toBe(
      fnBody(
        stripComments(loadMigrationSql("20261015110000_unionground_staff_roster_organizer.sql")),
        "get_admin_org_structure",
      ),
    );
    expect(latestFnBody("get_admin_org_structure")).not.toBe(
      fnBody(
        stripComments(loadMigrationSql("20260918070000_admin_org_structure_single_pass.sql")),
        "get_admin_org_structure",
      ),
    );
  });

  // 20260826155000 declares create_integration_webhook twice: a four-argument
  // form, then a drop and a two-argument replacement. Searching the file from
  // the top returns the dead first declaration, so the pin has to cut at the
  // offset the apply-order scan actually selected.
  it("returns the declaration that survives its own migration", () => {
    const live = latestFnBody("create_integration_webhook");
    expect(live).toContain("create function public.create_integration_webhook(p_url text, p_events text[])");
    expect(live).not.toContain("p_secret_plaintext text");
  });

  it("throws when a later migration drops the function without recreating it", () => {
    expect(() => latestFnBody("grant_member_role")).toThrow(
      /dropped without recreation in 20260917050000_retire_superseded_role_grant_rpcs\.sql/,
    );
  });

  // `drop function if exists public.<name>(...)` puts two tokens between the
  // keyword and the name; reading it as an ordinary reference reported dropped
  // RPCs as installed.
  it("treats drop function if exists as a drop", () => {
    expect(() => latestFnBody("set_my_dues_financial_identity")).toThrow(
      /dropped without recreation in 20260831211500_mi1_dues_review_repairs\.sql/,
    );
  });
});
