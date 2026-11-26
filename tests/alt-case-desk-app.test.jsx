import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { tasksBoardHref } from "../src/alt/altShell.js";

// Upstream's alternate shell offered a case desk beside the Tasks views under
// Work; this edition leaves that desk out (grievance steps and deadlines), so
// only the task board entrances are covered here.
describe("explicit task board entrances", () => {
  it("name the Tasks tab under the alternate shell, so they never land on the case board", () => {
    expect(tasksBoardHref({ alt: true })).toBe("/m/tasks?view=tasks");
    expect(tasksBoardHref({ alt: true, demo: true })).toBe("/m/tasks?demo=1&view=tasks");
    expect(tasksBoardHref({ demo: true })).toBe("/m/tasks?demo=1");
    expect(tasksBoardHref()).toBe("/m/tasks");
    const app = readFileSync("src/App.jsx", "utf8");
    // The steward and coordinator desks' "Chapter work" and Messages' "Open task board".
    expect(app).toContain('const openTasksTool = () => navigateStaff("tasks", tasksBoardPath());');
    expect(app).toContain('onOpenTasks={selectedStaffHatAuthorized ? () => navigateStaff("tasks", tasksBoardPath()) : null}');
    expect(app).toContain("return tasksBoardHref({ demo, alt: altShell });");
  });
});
