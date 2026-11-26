import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_TITLE_MAX, limitTaskTitle } from "../src/lib/taskTitle.js";

// Chapter_tasks_title_bounded counts code points
// after btrim, which removes spaces only. The composers limit the same way.
describe("limitTaskTitle", () => {
  it("uses the bound the database checks", () => {
    const migration = readFileSync(resolve("supabase/migrations/20260727002423_native_work_coordination.sql"), "utf8");
    expect(Number(migration.match(/chapter_tasks_title_bounded\s+check \(char_length\(btrim\(title\)\) between 1 and (\d+)\)/)?.[1])).toBe(TASK_TITLE_MAX);
  });

  it("keeps a title of 160 emoji with surrounding spaces whole", () => {
    const title = `   ${"\u{1F525}".repeat(TASK_TITLE_MAX)}   `;
    expect(title.length).toBeGreaterThan(TASK_TITLE_MAX * 2);
    expect(limitTaskTitle(title)).toBe(title);
  });

  // Gate review of #9042, P1-1: an insertion into a full title must not cut
  // its end off; the box keeps the title it had, as maxLength does.
  it("refuses an insertion before the end of a full title instead of cutting its end", () => {
    const full = `${"a".repeat(TASK_TITLE_MAX - 1)}X`;
    expect(limitTaskTitle(`Q${full}`, full)).toBe(full);
    expect(limitTaskTitle(`${"a".repeat(80)}Q${"a".repeat(79)}X`, full)).toBe(full);
    expect(limitTaskTitle(`${full.slice(0, 10)}\u{1F525}${full.slice(10)}`, full)).toBe(full);
    // A change that stays within the bound is kept, wherever it is.
    expect(limitTaskTitle(`Q${full.slice(1)}`, full)).toBe(`Q${full.slice(1)}`);
  });

  // Gate re-check of #9042, P2: a replacement keeps the part of the typed text
  // that fits, as maxLength does, and the rest of the title.
  it("keeps the fitting start of text that replaces a selection in a full title", () => {
    const full = `${"a".repeat(TASK_TITLE_MAX - 1)}X`;
    expect(limitTaskTitle(`YZ${full.slice(1)}`, full)).toBe(`Y${full.slice(1)}`);
    expect(limitTaskTitle(`${full.slice(0, 50)}\u{1F525}\u{1F30A}${full.slice(51)}`, full)).toBe(`${full.slice(0, 50)}\u{1F525}${full.slice(51)}`);
    expect(limitTaskTitle(`${full.slice(0, 50)}YZW${full.slice(52)}`, full)).toBe(`${full.slice(0, 50)}YZ${full.slice(52)}`);
    // An older title already past the bound is kept when nothing more fits.
    const long = "b".repeat(TASK_TITLE_MAX + 5);
    expect(limitTaskTitle(`Q${long}`, long)).toBe(long);
    expect(limitTaskTitle(undefined, undefined)).toBe("");
    // A paste into an empty box keeps its first TASK_TITLE_MAX code points.
    expect(Array.from(limitTaskTitle("\u{1F525}".repeat(TASK_TITLE_MAX + 40), ""))).toHaveLength(TASK_TITLE_MAX);
  });

  it("cuts only past the bound, by code points, keeping the leading spaces", () => {
    const cut = limitTaskTitle(`  ${"\u{1F525}".repeat(TASK_TITLE_MAX + 5)}`);
    expect(cut.startsWith("  ")).toBe(true);
    expect(Array.from(cut.slice(2))).toHaveLength(TASK_TITLE_MAX);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]$/u);
  });

  it("counts a tab as part of the title, as btrim keeps it", () => {
    expect(limitTaskTitle(`\t${"a".repeat(TASK_TITLE_MAX)}`)).toHaveLength(TASK_TITLE_MAX);
  });

  it("returns empty text for a missing value", () => {
    expect(limitTaskTitle(undefined)).toBe("");
    expect(limitTaskTitle("")).toBe("");
  });

  // One rule for every task title box: none keeps the UTF-16 maxLength.
  it.each(["src/views/KanbanCalendar.jsx", "src/views/KanbanBoard.jsx", "src/views/KanbanList.jsx", "src/views/TaskModal.jsx", "src/views/TaskTemplateDialog.jsx"])("%s limits task titles with limitTaskTitle", (file) => {
    const source = readFileSync(resolve(file), "utf8");
    expect(source).toContain('from "../lib/taskTitle.js"');
    expect(source).toMatch(/limitTaskTitle\(event\.target\.value, (title|createTitle|subtaskTitle)\)/);
    expect(source).not.toMatch(/maxLength=\{160\}/);
  });
});
