// @vitest-environment node
//
// SEC-UG-POST-BODY-MUTATION-AUDIT-20260904 — revoke branch.
// The record's acceptance is "post body mutation is denied unless an explicit
// server-side edit contract is active". These pins are the offline half of that:
// the grant is gone, the policy is gone, and a trigger refuses the write from
// every role rather than relying on the grant alone.
import { describe, expect, it } from "vitest";
import { migrationFiles, stripComments } from "./helpers/migration.js";

const migrations = migrationFiles();
const entry = migrations.find((file) => file.name === "20260907120000_chapter_post_body_mutation_revoke.sql");
const sql = stripComments(entry.sql).toLowerCase();
// The header narrative, which stripComments deliberately removes.
const raw = entry.sql.toLowerCase();

describe("chapter post body mutation revoke", () => {
  it("exists and applies after the migration that created the grant", () => {
    expect(entry).toBeTruthy();
    const created = migrations.findIndex((file) => file.name.startsWith("20260727211853_"));
    const revoked = migrations.findIndex((file) => file.name === entry.name);
    expect(revoked).toBeGreaterThan(created);
  });

  it("revokes the table-level UPDATE rather than shrinking the column list", () => {
    // A column-scoped re-grant would leave the surface open to the next column
    // someone adds. The whole verb goes.
    expect(sql).toContain("revoke update on public.chapter_thread_posts from authenticated");
    expect(sql).not.toMatch(/grant\s+update[^;]*on public\.chapter_thread_posts/);
  });

  it("drops the author update policy so no RLS path implies an edit contract", () => {
    expect(sql).toContain("drop policy chapter_thread_posts_update_own on public.chapter_thread_posts");
    expect(sql).not.toContain("create policy chapter_thread_posts_update_own");
  });

  it("refuses the mutation in a trigger, so service_role cannot bypass the grant", () => {
    expect(sql).toContain("create function private.guard_chapter_post_body_mutation()");
    expect(sql).toContain("create trigger chapter_thread_posts_guard_body_mutation");
    expect(sql).toContain("before update on public.chapter_thread_posts");
    expect(sql).toContain("chapter post body mutation is not permitted");
    expect(sql).toContain("errcode = '42501'");
  });

  it("guards the body and both tombstone columns", () => {
    for (const column of ["body", "edited_at", "deleted_at"]) {
      expect(sql, `${column} is not guarded`).toContain(`new.${column} is distinct from old.${column}`);
    }
  });

  it("never refuses referential maintenance", () => {
    // The first revision of this guard also compared the identity columns.
    // PostgreSQL performs a referential ON DELETE SET NULL / ON UPDATE CASCADE
    // as a real UPDATE on the referencing table, and that UPDATE fires ordinary
    // row triggers, so comparing those columns refused:
    //   * member account deletion, for anyone who has ever posted in a chapter
    //     thread (chapter_thread_posts.author_id references auth.users ON
    //     DELETE SET NULL, set that way by 20260812180000 precisely because an
    //     earlier implementation broke this),
    //   * the deletion of any post that has replies (parent_post_id is a
    //     self-FK ON DELETE SET NULL), and
    //   * a chapter-id rename (chapter_id references public.chapters ON UPDATE
    //     CASCADE).
    // This pin is the offline half of that repair;
    // tests/chapter-post-referential-maintenance-db.test.js is the live half.
    const guard = sql.slice(sql.indexOf("create function private.guard_chapter_post_body_mutation()"));
    for (const column of ["author_id", "parent_post_id", "chapter_id", "thread_id", "created_at"]) {
      expect(guard, `${column} must not be compared: a referential action would be refused`)
        .not.toContain(`new.${column} is distinct from old.${column}`);
    }
    // And the reason is written down where the next editor will read it: once
    // in the header narrative, and once in the function comment, which is
    // executable SQL and therefore survives into the live database.
    expect(raw).toContain("references auth.users(id)                   on delete set null");
    expect(raw).toContain("references public.chapter_thread_posts(id)  on delete set null");
    expect(raw).toContain("references public.chapters(id)              on update cascade");
    expect(sql).toContain(
      "author_id, parent_post_id and chapter_id carry referential actions that postgresql performs as row-trigger-firing updates",
    );
  });

  it("keeps posting and reading intact", () => {
    expect(sql).not.toMatch(/revoke\s+select\s+on public\.chapter_thread_posts/);
    expect(sql).not.toMatch(/revoke\s+insert[^;]*on public\.chapter_thread_posts/);
  });

  it("routes the future edit contract through one reviewable switch that is off", () => {
    expect(sql).toContain("create function private.chapter_post_edit_contract_active()");
    expect(sql).toContain("select false");
    expect(sql).toContain("if private.chapter_post_edit_contract_active() then");
    // Executable by nobody: only the trigger, which runs as the table owner.
    expect(sql).toContain("revoke all on function private.chapter_post_edit_contract_active()");
  });

  it("fires ahead of the author-identity stamp", () => {
    // Trigger order is alphabetical within the same timing, so the guard's name
    // has to sort before the stamp's or a rejected write reaches it first.
    expect("chapter_thread_posts_guard_body_mutation" < "chapter_thread_posts_stamp_author").toBe(true);
  });

  it("leaves no later migration quietly restoring the capability", () => {
    const later = migrations.filter((file) => file.name > entry.name);
    for (const file of later) {
      const code = stripComments(file.sql).toLowerCase();
      expect(code, `${file.name} re-grants chapter post updates`)
        .not.toMatch(/grant\s+update[^;]*on public\.chapter_thread_posts/);
      expect(code, `${file.name} drops the mutation guard`)
        .not.toContain("drop trigger chapter_thread_posts_guard_body_mutation");
    }
  });

  it("keeps the client free of dead edited/deleted presentation", () => {
    // The record's other half: edited_at and deleted_at are dead schema. They
    // stay reserved, and no client may start rendering them as if an edit
    // contract existed.
    expect(sql).toContain("reserved for the future edit contract");
  });
});
