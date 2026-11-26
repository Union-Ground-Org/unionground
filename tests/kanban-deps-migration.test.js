// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

// Text pins over the kanban phase-2 dependencies migration. A tripwire, not a
// proof: these assert what THIS MIGRATION SAYS, not what the database ends up
// with — current-state truth is verify:db's job.
//
// Why each guard exists:
//
//   * The edge table is the first client-writable graph in the schema, and a
//     graph invites exactly two data bugs: self-edges and cycles. The CHECK
//     kills the first; the prepare trigger's reachability walk kills the
//     second — but only if the walk runs under the per-chapter advisory lock,
//     because two concurrent inserts can each see an acyclic graph and
//     jointly close a loop. The lock ORDER is the guard: lock first, walk
//     second.
//   * chapter_id is the broadcast topic key and the RLS scope, so it must be
//     server truth: stamped by the trigger from the CALLER's chapter after
//     both endpoints are proven live and in that same chapter, and excluded
//     from the insert grant.
//   * Sync rides the same private chapter-tasks:<chapter> topic as the board;
//     the INSERT-only supabase_realtime publication must stay untouched —
//     the strongest guard is the negative one: no `alter publication`.
//   * Edges are immutable link rows: insert and delete only. No UPDATE grant
//     and no UPDATE policy anywhere in the file.
//   * The table postdates the platform-wide mfa_assurance DO loop, so the
//     migration must write its own restrictive policy (chapter_workstreams
//     precedent — a later table silently lacking it is invisible offline).

const sql = loadMigrationSql("kanban_task_dependencies");
const executable = stripComments(sql);
const prepare = fnBody(executable, "private.prepare_chapter_task_dependency()");

describe("edge table shape", () => {
  it("declares the edge with self-edge check, pair uniqueness and cascade endpoints", () => {
    expect(executable).toContain("create table public.chapter_task_dependencies");
    expect(executable).toContain("task_id uuid not null references public.chapter_tasks(id) on delete cascade");
    expect(executable).toContain("depends_on_id uuid not null references public.chapter_tasks(id) on delete cascade");
    expect(executable).toContain("check (task_id <> depends_on_id)");
    expect(executable).toContain("unique (task_id, depends_on_id)");
  });

  it("indexes the reverse direction the blocking list and the cascade walk", () => {
    expect(executable).toContain("create index chapter_task_dependencies_depends_on_idx");
    expect(executable).toContain("on public.chapter_task_dependencies (depends_on_id)");
  });

  it("stamps authorship server-side: DEFAULT auth.uid() plus a grant that excludes it", () => {
    expect(executable).toContain("created_by uuid default auth.uid()");
    expect(executable).toContain("grant insert (task_id, depends_on_id) on public.chapter_task_dependencies to authenticated");
    // The grant names ONLY the edge columns — chapter_id and created_by are
    // server-stamped, and widening the list is a deliberate act.
    expect(executable).not.toMatch(/grant insert \([^)]*chapter_id[^)]*\) on public\.chapter_task_dependencies/);
    expect(executable).not.toMatch(/grant insert \([^)]*created_by[^)]*\) on public\.chapter_task_dependencies/);
  });
});

describe("prepare trigger", () => {
  it("proves both endpoints live and in the caller's chapter before stamping scope", () => {
    expect(prepare).toContain("where t.id = new.task_id and t.deleted_at is null");
    expect(prepare).toContain("where t.id = new.depends_on_id and t.deleted_at is null");
    expect(prepare).toContain("raise exception 'dependency endpoints must be live tasks'");
    expect(prepare).toContain("raise exception 'dependency endpoints must belong to your chapter'");
    expect(prepare).toContain("new.chapter_id := caller_chapter");
    expect(prepare).toContain("new.created_by := caller");
    expect(prepare).toContain("security definer");
    expect(prepare).toContain("set search_path = ''");
  });

  it("takes the per-chapter advisory lock BEFORE the cycle walk", () => {
    const lock = prepare.indexOf("pg_catalog.pg_advisory_xact_lock(");
    const walk = prepare.indexOf("with recursive reach(id) as");
    expect(lock).toBeGreaterThan(-1);
    expect(walk).toBeGreaterThan(-1);
    expect(lock, "a cycle walk outside the lock is the concurrent-insert loop race").toBeLessThan(walk);
    // Keyed on the CHAPTER, so one chapter's edges never serialise another's.
    expect(prepare).toContain("hashtextextended('chapter_task_dependencies:' || caller_chapter, 0)");
  });

  it("rejects the edge exactly when the depended-on task already reaches the depending task", () => {
    // UNION (not UNION ALL) dedupes visited nodes, so the walk terminates
    // even over a graph that somehow already contains a cycle.
    expect(prepare).toMatch(/union\s+select d\.depends_on_id/);
    expect(prepare).not.toMatch(/union all/);
    expect(prepare).toContain("join reach r on d.task_id = r.id");
    expect(prepare).toContain("select 1 from reach where reach.id = new.task_id");
    expect(prepare).toContain("raise exception 'dependency would create a cycle'");
    expect(prepare).toContain("using errcode = '22023'");
  });

  it("is revoked from client roles and attached BEFORE INSERT", () => {
    expect(executable).toContain("revoke all on function private.prepare_chapter_task_dependency() from public, anon, authenticated");
    expect(executable).toMatch(
      /create trigger chapter_task_dependencies_prepare\s+before insert on public\.chapter_task_dependencies\s+for each row execute function private\.prepare_chapter_task_dependency\(\)/,
    );
  });
});

describe("realtime and RLS posture", () => {
  it("broadcasts through the existing chapter-topic function, AFTER the write", () => {
    expect(executable).toMatch(
      /create trigger chapter_task_dependencies_broadcast\s+after insert or update or delete on public\.chapter_task_dependencies\s+for each row execute function private\.broadcast_chapter_task_change\(\)/,
    );
    // Reuse, not redefinition: this migration must not carry its own copy of
    // the broadcast function or touch the publication.
    expect(executable).not.toContain("create or replace function private.broadcast_chapter_task_change");
    expect(executable).not.toMatch(/alter\s+publication/i);
  });

  it("scopes reads to the chapter and writes to the five staff roles", () => {
    expect(executable).toContain("create policy chapter_task_dependencies_select_chapter");
    expect(executable).toContain("create policy chapter_task_dependencies_insert_staff");
    expect(executable).toContain("create policy chapter_task_dependencies_delete_staff");
    expect(executable).toContain("member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
    expect(executable).toContain("p.chapter_id = chapter_task_dependencies.chapter_id");
  });

  it("writes its own restrictive mfa_assurance policy", () => {
    expect(executable).toMatch(
      /create policy mfa_assurance on public\.chapter_task_dependencies\s+as restrictive for all to authenticated/,
    );
    expect(executable).toContain("using ((select private.mfa_satisfied()))");
    expect(executable).toContain("with check ((select private.mfa_satisfied()))");
  });

  it("leaves no UPDATE path: no update grant, no update policy", () => {
    expect(executable).toContain("revoke all on table public.chapter_task_dependencies from public, anon, authenticated");
    expect(executable).not.toMatch(/grant update[^;]*chapter_task_dependencies/i);
    expect(executable).not.toMatch(/create policy [^;]*for update[^;]*chapter_task_dependencies/i);
    expect(executable).not.toMatch(/chapter_task_dependencies[^;]*for update/i);
  });
});
