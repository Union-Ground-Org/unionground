// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("kanban_sol_deferrals");
const code = stripComments(sql).toLowerCase();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("Kanban SOL deferral migration", () => {
  it("allocates task numbers from a durable per-chapter high-water mark", () => {
    const prepare = stripComments(fnBody(sql, "private.prepare_chapter_task"));
    expect(code).toContain("create table private.chapter_task_number_counters");
    expect(prepare).toContain("update private.chapter_task_number_counters c");
    expect(prepare).toContain("returning c.last_number into new.task_number");
    expect(prepare.indexOf("pg_advisory_xact_lock")).toBeLessThan(prepare.indexOf("update private.chapter_task_number_counters"));
    expect(code).toContain("revoke all on table private.chapter_task_number_counters from public, anon, authenticated");
  });

  it("moves and renumbers one target partition in one transactional RPC", () => {
    const move = stripComments(fnBody(sql, "public.move_chapter_task"));
    expect(move).toContain("pg_advisory_xact_lock");
    expect(move).toContain("using errcode = '40001'");
    expect(move).toContain("ranked.rank * spacing");
    expect(move).toContain("floor(1000000.0 / (partition_count + 1))");
    expect(move).not.toMatch(/\bloop\b/);
  });

  it("compare-and-swaps title and description against updated_at", () => {
    const update = stripComments(fnBody(sql, "public.update_chapter_task_content"));
    expect(update).toContain("for update of t");
    expect(update).toContain("current_task.updated_at is distinct from p_expected_updated_at");
    expect(update).toContain("using errcode = '40001'");
  });

  it("spends the 4,000 edge ceiling only on the 500 visible tasks, newest first", () => {
    const read = stripComments(fnBody(sql, "public.list_chapter_task_dependencies"));
    expect(read).toContain("limit 500");
    expect(read).toContain("join visible_tasks task on task.id = d.task_id");
    expect(read).toContain("join visible_tasks dependency on dependency.id = d.depends_on_id");
    expect(read).toContain("order by d.created_at desc, d.id desc");
    expect(read).toContain("least(greatest(coalesce(p_limit, 4000), 0), 4000)");
  });

  it("pins the dependency trigger's exact prosrc, not selected needles only", () => {
    // The live body is the newest definition: 20261113114200 (#8523)
    // re-emits it with the case-graph acquisition block the later case-linked
    // notification entry wrapped around it, before any declaration
    // initializer, and refuses another chapter's endpoint as a missing one.
    const dependencySql = loadMigrationSql("chapter_task_link_refusals_same_for_other_chapters");
    const start = dependencySql.indexOf("CREATE OR REPLACE FUNCTION private.prepare_chapter_task_dependency()");
    const bodyStart = dependencySql.indexOf("AS $function$", start) + "AS $function$".length;
    const bodyEnd = dependencySql.indexOf("$function$;", bodyStart);
    const body = dependencySql.slice(bodyStart, bodyEnd);
    expect(body.startsWith("\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n")).toBe(true);
    const md5 = createHash("md5").update(body).digest("hex");
    const entry = contract.functions.find((item) => item.sig === "private.prepare_chapter_task_dependency()");
    expect(entry.sourceMd5).toBe(md5);
  });
});
