// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

// Text pins over the kanban phase-1 migration (task numbers + realtime board
// sync). A tripwire, not a proof: these assert what THIS MIGRATION SAYS, not
// what the database ends up with — current-state truth is verify:db's job.
//
// Why each guard exists:
//
//   * The backfill/NOT NULL order and the unique index are the difference
//     between a migration that applies once and one that works on every stack:
//     SET NOT NULL before the backfill fails on any chapter with existing
//     tasks, and without the (chapter_id, task_number) unique index a reused
//     number would be a silent data bug instead of a loud 23505.
//   * prepare_chapter_task() has been rewritten five times and each rewrite
//     must carry the FULL prior body forward — the classic regression here is
//     a rewrite that adds its own feature and drops someone else's branch. So
//     alongside the two new pins (advisory lock before the max()+1 read, and
//     task_number joining the immutable-fields exception) this file re-pins
//     the survivors: the sg.refresh_names name-refresh branch, the
//     assignee_name revert on direct writes, and the 'tasks'-topic notify
//     calls. Those survivor branches are asserted on the introducing body
//     (20260801170000) and on the newest migration that declares the function,
//     so a later rewrite cannot drop one while this file still reads only the
//     introducer. The lock ORDER matters, not just its presence: max()+1 read
//     before the lock is exactly the duplicate-number race the lock exists to
//     close.
//   * The broadcast trigger function must never let a realtime outage fail
//     the board write it narrates — the exception handler must warn, never
//     re-raise. A `raise exception` creeping into that body turns "live sync
//     is down" into "nobody can move a card".
//   * The realtime.messages policy must be created inside a DO block that
//     checks the table exists first (a local stack whose realtime schema
//     predates broadcast authorization has no such table, and the migration
//     must not fail there), and its USING clause must derive the topic from
//     the SUBSCRIBER's own profile — deriving it from anything the client
//     names would let a member subscribe to another chapter's board.
//   * The INSERT-only supabase_realtime publication contract (pinned by
//     20260728221416) is the reason this feature rides broadcast at all. The
//     strongest regression guard is therefore negative: this migration must
//     contain NO `alter publication` statement, and the contract-check
//     function it leans on must still assert insert-only.

const sql = loadMigrationSql("kanban_task_numbers_and_realtime");
const executable = stripComments(sql);
// Bodies are cut from the STRIPPED text: the migration's header comment
// mentions both function names (the ROLLBACK recipe), and fnBody over the raw
// file anchors on that mention instead of the declaration.
const prepare = fnBody(executable, "private.prepare_chapter_task()");
const broadcast = fnBody(executable, "private.broadcast_chapter_task_change()");

// `prepare_chapter_task_dependency` and the other suffixed helpers must not
// count: the declaration is the exact function name followed by '('.
const PREPARE_CHAPTER_TASK_DECLARATION =
  /create\s+(or\s+replace\s+)?function\s+private\.prepare_chapter_task\s*\(/i;
const prepareDeclarations = migrationFiles().filter((entry) =>
  PREPARE_CHAPTER_TASK_DECLARATION.test(stripComments(entry.sql)),
);
const introducingPrepareMigration = "20260801170000_kanban_task_numbers_and_realtime.sql";
const newestPrepareMigration = prepareDeclarations.at(-1);
if (!newestPrepareMigration) {
  throw new Error("private.prepare_chapter_task() is not declared in any migration");
}
const livePrepare = fnBody(stripComments(newestPrepareMigration.sql), "private.prepare_chapter_task()");

// Body branches each rewrite has to keep. The introducing migration also
// revokes execute beside the function; later CREATE OR REPLACE bodies,
// including the current newest, do not repeat that statement.
const PREPARE_SURVIVOR_BRANCHES = [
  "current_setting('sg.refresh_names', true)",
  "new.assignee_name := old.assignee_name",
  "'task.assigned'",
  "'task.unassigned'",
  "new.progress := 100",
  "new.progress := 99",
  "new.chapter_id := caller_chapter",
  "security definer",
  "set search_path = ''",
];

describe("task number storage", () => {
  it("backfills existing rows BEFORE the SET NOT NULL", () => {
    const addColumn = executable.indexOf("add column if not exists task_number integer");
    const backfill = executable.indexOf("set task_number = numbered.rn");
    const notNull = executable.indexOf("alter column task_number set not null");
    expect(addColumn).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(-1);
    expect(notNull).toBeGreaterThan(-1);
    expect(addColumn).toBeLessThan(backfill);
    expect(backfill, "SET NOT NULL before the backfill fails on any chapter with tasks").toBeLessThan(notNull);
  });

  it("numbers deterministically within each chapter and only fills nulls", () => {
    // Re-run safety: `where t.task_number is null` makes the backfill
    // idempotent, and the id tiebreak keeps the numbering stable when two
    // tasks share a created_at.
    expect(executable).toContain("row_number() over (partition by t.chapter_id order by t.created_at, t.id)");
    expect(executable).toContain("and t.task_number is null");
  });

  it("makes number reuse loud with a per-chapter unique index", () => {
    expect(executable).toContain("create unique index if not exists chapter_tasks_chapter_number_key");
    expect(executable).toContain("on public.chapter_tasks (chapter_id, task_number)");
  });
});

describe("prepare_chapter_task rewrite", () => {
  it("takes the per-chapter advisory lock BEFORE reading max()+1, inside the INSERT branch", () => {
    const insertBranch = prepare.indexOf("if tg_op = 'INSERT' then");
    const lock = prepare.indexOf("pg_catalog.pg_advisory_xact_lock(");
    const allocate = prepare.indexOf("select coalesce(pg_catalog.max(t.task_number), 0) + 1");
    expect(insertBranch).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(-1);
    expect(allocate).toBeGreaterThan(-1);
    expect(insertBranch).toBeLessThan(lock);
    expect(lock, "max()+1 read before the lock is the duplicate-number race").toBeLessThan(allocate);
    // Keyed on the CHAPTER, so one chapter's inserts never serialise another's.
    expect(prepare).toContain("hashtextextended('chapter_tasks.task_number:' || caller_chapter, 0)");
    expect(prepare).toContain("into new.task_number");
    expect(prepare).toContain("where t.chapter_id = caller_chapter");
  });

  it("adds task_number to the immutable-fields exception on UPDATE", () => {
    expect(prepare).toContain("new.task_number is distinct from old.task_number");
    expect(prepare).toContain("raise exception 'task ownership fields are immutable'");
    // The prior immutable trio still guarded — task_number JOINED the check,
    // it did not replace anything.
    expect(prepare).toContain("new.chapter_id is distinct from old.chapter_id");
    expect(prepare).toContain("new.created_by is distinct from old.created_by");
    expect(prepare).toContain("new.created_at is distinct from old.created_at");
  });

  it("pins the survivor branches to the introducing migration and the newest declaration", () => {
    expect(prepareDeclarations.map((entry) => entry.name)).toContain(introducingPrepareMigration);
    // migrationFiles() is filename-sorted, so the last declaration is the one
    // a later apply actually installs, and a newer rewrite moves the pin with it.
    expect(newestPrepareMigration.name > introducingPrepareMigration).toBe(true);
  });

  it.each([
    [introducingPrepareMigration, prepare],
    [newestPrepareMigration.name, livePrepare],
  ])("%s carries every prior branch of the prepare_chapter_task body forward", (migrationName, body) => {
    for (const needle of PREPARE_SURVIVOR_BRANCHES) {
      expect(body, `${migrationName} dropped ${needle}`).toContain(needle);
    }
    // Both bodies emit exactly two notify_member calls on the 'tasks' topic
    // (assigned and unassigned).
    expect(body.match(/, 'tasks'\)/g)?.length).toBe(2);
    if (migrationName === introducingPrepareMigration) {
      expect(executable).toContain("revoke all on function private.prepare_chapter_task() from public, anon, authenticated");
    }
  });
});

describe("realtime board sync", () => {
  it("wraps broadcast_changes in an exception handler that warns, never raises", () => {
    expect(broadcast).toContain("perform realtime.broadcast_changes(");
    expect(broadcast).toContain("'chapter-tasks:' || coalesce(new.chapter_id, old.chapter_id)");
    const guard = broadcast.indexOf("exception");
    expect(guard).toBeGreaterThan(broadcast.indexOf("realtime.broadcast_changes"));
    expect(broadcast).toContain("when others then");
    expect(broadcast).toContain("raise warning");
    // A realtime outage must never fail the board write it narrates.
    expect(broadcast).not.toContain("raise exception");
    expect(broadcast).toContain("security definer");
    expect(broadcast).toContain("set search_path = ''");
  });

  it("attaches the AFTER trigger to BOTH board tables", () => {
    expect(executable).toMatch(
      /create trigger chapter_tasks_broadcast\s+after insert or update or delete on public\.chapter_tasks\s+for each row execute function private\.broadcast_chapter_task_change\(\)/,
    );
    expect(executable).toMatch(
      /create trigger chapter_workstreams_broadcast\s+after insert or update or delete on public\.chapter_workstreams\s+for each row execute function private\.broadcast_chapter_task_change\(\)/,
    );
    expect(executable).toContain("revoke all on function private.broadcast_chapter_task_change() from public, anon, authenticated");
  });

  it("guards the realtime.messages policy behind a table-exists check", () => {
    const guard = executable.indexOf("n.nspname = 'realtime' and c.relname = 'messages'");
    const policy = executable.indexOf("create policy chapter_tasks_broadcast_read on realtime.messages");
    expect(guard, "unguarded, the migration fails on a stack without realtime.messages").toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(guard);
  });

  it("derives the readable topic from the SUBSCRIBER's own profile, MFA-gated", () => {
    expect(executable).toContain("for select to authenticated");
    expect(executable).toContain("realtime.messages.extension = 'broadcast'");
    // The subscriber's chapter comes from THEIR profile row — a member cannot
    // name another chapter's topic into range.
    expect(executable).toContain("realtime.topic() = 'chapter-tasks:' || (");
    expect(executable).toContain("from public.member_profiles p");
    expect(executable).toContain("where p.id = (select auth.uid())");
    expect(executable).toContain("(select private.mfa_satisfied())");
  });
});

describe("the publication contract stays untouched", () => {
  it("this migration contains NO alter publication statement", () => {
    // The whole design of the broadcast path is that the INSERT-only
    // supabase_realtime publication is not widened. Checked against
    // comment-stripped SQL so a prose mention can never mask a live statement.
    expect(executable).not.toMatch(/alter\s+publication/i);
  });

  it("publication_contract_check in 20260728221416 still pins insert-only, unchanged", () => {
    const contractSql = loadMigrationSql("publication_contract_and_workstream_merge");
    const check = fnBody(contractSql, "public.publication_contract_check()");
    expect(check).toContain("pub.pubinsert and not pub.pubupdate and not pub.pubdelete and not pub.pubtruncate");
    expect(check).toContain("'insertOnly'");
    expect(check).toContain("where p.pubname = 'supabase_realtime'");
    expect(check).toContain("raise exception 'service role required'");
  });
});
