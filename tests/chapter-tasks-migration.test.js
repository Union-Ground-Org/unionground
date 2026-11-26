// @vitest-environment node
//
// 20260727002423 installs the table. Later migrations replace its write
// policies, revoke authenticated DELETE, hide soft-deleted rows, and re-emit
// private.prepare_chapter_task. Origin assertions stay on that file. Active
// assertions walk the migration tail, so a superseded definition cannot keep
// the suite green.
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const ORIGIN = "20260727002423_native_work_coordination";
const originSql = stripComments(loadMigrationSql(ORIGIN)).toLowerCase();
const originPrepare = stripComments(fnBody(loadMigrationSql(ORIGIN), "private.prepare_chapter_task")).toLowerCase();

const STAFF_ROLES = "array['steward', 'coordinator', 'advisor', 'admin', 'vp']";
const RETIRED_POLICIES = [
  "chapter_tasks_insert_chapter",
  "chapter_tasks_update_chapter",
  "chapter_tasks_delete_creator_or_staff",
  "chapter_tasks_delete_staff",
];

function statementAt(sql, index) {
  let depth = 0;
  let i = index;
  while (i < sql.length) {
    if (sql[i] === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (sql[i] === "(") depth += 1;
    else if (sql[i] === ")") depth -= 1;
    else if (sql[i] === ";" && depth === 0) return sql.slice(index, i + 1);
    i += 1;
  }
  throw new Error("unterminated SQL statement");
}

function policyCommand(statement) {
  const match = statement.match(/\bfor\s+(select|insert|update|delete|all)\b/);
  return match ? match[1] : "all";
}

// Last create wins until a later drop. Filename order is apply order.
function liveChapterTaskPolicies() {
  const live = new Map();
  const event = /\b(create|drop)\s+policy\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)\s+on\s+public\.chapter_tasks\b/gi;
  for (const entry of migrationFiles()) {
    const code = stripComments(entry.sql);
    for (const match of code.matchAll(event)) {
      const name = match[2].toLowerCase();
      if (match[1].toLowerCase() === "drop") {
        live.delete(name);
        continue;
      }
      live.set(name, {
        name,
        file: entry.name,
        statement: statementAt(code, match.index).replace(/\s+/g, " ").toLowerCase(),
      });
    }
  }
  return [...live.values()];
}

// Table-level DELETE for public or authenticated. Column grants
// (`grant insert (title, ...)`) do not match, and `all` counts because
// `revoke all` withdraws DELETE. A grant to service_role alone does not.
function authenticatedDeleteGranted() {
  let granted = false;
  const event = /\b(grant|revoke)\s+((?:all|select|insert|update|delete|truncate|references|trigger)(?:\s*,\s*(?:all|select|insert|update|delete|truncate|references|trigger))*)\s+on\s+(?:table\s+)?public\.chapter_tasks\s+(?:to|from)\s+([a-z_,\s]+)/gi;
  for (const entry of migrationFiles()) {
    const code = stripComments(entry.sql);
    for (const match of code.matchAll(event)) {
      const privileges = match[2].toLowerCase().split(",").map((privilege) => privilege.trim());
      const roles = match[3].toLowerCase().split(",").map((role) => role.trim());
      if (!privileges.includes("all") && !privileges.includes("delete")) continue;
      if (!roles.includes("public") && !roles.includes("authenticated")) continue;
      granted = match[1].toLowerCase() === "grant";
    }
  }
  return granted;
}

function latestPrepareChapterTask() {
  const declaration = /create\s+(?:or\s+replace\s+)?function\s+private\.prepare_chapter_task\s*\(/i;
  const declaring = migrationFiles().filter((entry) => declaration.test(stripComments(entry.sql)));
  expect(declaring.length, "private.prepare_chapter_task must be declared").toBeGreaterThan(0);
  const latest = declaring.at(-1);
  return {
    file: latest.name,
    body: stripComments(fnBody(latest.sql, "private.prepare_chapter_task")).replace(/\s+/g, " ").toLowerCase(),
  };
}

describe("chapter task storage origin migration 20260727002423", () => {
  it("creates one bounded chapter-scoped task record for all four views", () => {
    expect(originSql).toContain("create table public.chapter_tasks");
    expect(originSql).toContain("chapter_id text not null references public.chapters(id)");
    expect(originSql).toContain("check (status in ('backlog', 'in_progress', 'needs_review', 'done'))");
    expect(originSql).toContain("check (priority in ('low', 'medium', 'high'))");
    expect(originSql).toContain("check (due_date >= start_date)");
    expect(originSql).toContain("check (progress between 0 and 100)");
    expect(originSql).toContain("check (char_length(description) <= 2000)");
  });

  it("stamps chapter and audit ownership in the origin prepare_chapter_task", () => {
    expect(originPrepare).toContain("security definer");
    expect(originPrepare).toContain("set search_path = ''");
    expect(originPrepare).toContain("new.chapter_id := caller_chapter");
    expect(originPrepare).toContain("new.created_by := caller");
    expect(originPrepare).toContain("new.updated_by := caller");
    expect(originPrepare).toContain("new.progress := 100");
    expect(originSql).toContain("create trigger chapter_tasks_prepare");
  });

  it("installs chapter-member policies and the restrictive MFA boundary in the origin file", () => {
    for (const policy of [
      "chapter_tasks_select_chapter",
      "chapter_tasks_insert_chapter",
      "chapter_tasks_update_chapter",
      "chapter_tasks_delete_creator_or_staff",
    ]) {
      expect(originSql).toContain(`create policy ${policy} on public.chapter_tasks`);
    }
    expect(originSql).toContain("p.chapter_id = chapter_tasks.chapter_id");
    expect(originSql).toContain("create policy mfa_assurance on public.chapter_tasks");
    expect(originSql).toContain("as restrictive for all to authenticated");
    expect(originSql).toContain("private.mfa_satisfied()");
  });

  it("keeps chapter and audit fields outside the origin browser column grants", () => {
    expect(originSql).toContain("revoke all on table public.chapter_tasks from public, anon, authenticated");
    expect(originSql).toContain("grant select, delete on table public.chapter_tasks to authenticated");
    const grants = originSql.slice(originSql.indexOf("grant insert ("), originSql.indexOf("comment on table public.chapter_tasks"));
    for (const forbidden of ["chapter_id", "created_by", "updated_by", "done_at", "created_at", "updated_at"]) {
      expect(grants).not.toContain(forbidden);
    }
    expect(grants).toContain("milestone");
  });

  it("indexes board order and calendar due dates inside each chapter", () => {
    expect(originSql).toContain("on public.chapter_tasks (chapter_id, status, order_index, created_at)");
    expect(originSql).toContain("on public.chapter_tasks (chapter_id, due_date, status)");
  });
});

describe("chapter task storage active migration tail", () => {
  it("stamps chapter_id, created_by, and updated_by in the latest prepare_chapter_task", () => {
    const latest = latestPrepareChapterTask();
    expect(latest.file > `${ORIGIN}.sql`).toBe(true);
    expect(latest.body).toContain("new.chapter_id := caller_chapter");
    expect(latest.body).toContain("new.created_by := caller");
    expect(latest.body).toContain("new.updated_by := caller");
  });

  it("keeps authenticated inserts and updates on the staff-only policies", () => {
    const policies = liveChapterTaskPolicies();
    const names = policies.map((policy) => policy.name);
    for (const retired of RETIRED_POLICIES) {
      expect(names, retired).not.toContain(retired);
    }

    for (const command of ["insert", "update"]) {
      const active = policies.filter((policy) => policyCommand(policy.statement) === command);
      expect(active.map((policy) => policy.name)).toEqual([`chapter_tasks_${command}_staff`]);
      expect(active[0].statement).toContain(`public.member_has_role(${STAFF_ROLES})`);
      expect(active[0].statement).toContain("p.chapter_id = chapter_tasks.chapter_id");
    }
  });

  it("revokes direct authenticated delete and excludes soft-deleted rows from select", () => {
    expect(authenticatedDeleteGranted()).toBe(false);

    const policies = liveChapterTaskPolicies();
    const deletes = policies.filter((policy) => policyCommand(policy.statement) === "delete");
    expect(deletes).toEqual([]);

    const selects = policies.filter((policy) => policy.name === "chapter_tasks_select_chapter");
    expect(selects).toHaveLength(1);
    expect(policyCommand(selects[0].statement)).toBe("select");
    expect(selects[0].statement).toContain("deleted_at is null");
  });
});
