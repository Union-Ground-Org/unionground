import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { STATUS_IDS } from "../src/lib/kanban.js";
import { groupListTasks, KanbanList } from "../src/views/KanbanList.jsx";
import { labelInNameMismatches } from "./helpers/labelInName.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stylesSource = readFileSync(join(root, "src/styles.css"), "utf8").replace(/\r\n/g, "\n");

const MEDIA_MAX_720 = "@media (max-width: 720px)";
const COLLAPSED_PHEAD_SELECTOR = /\.tasks-screen\s*>\s*\.phead\s*\{([^}]*)\}/;
const COLLAPSED_PHEAD_DECLARATIONS = [
  /position:\s*absolute;/,
  /overflow:\s*hidden;/,
  /min-height:\s*0;/,
  /clip-path:\s*inset\(50%\);/,
  /clip:\s*rect\(0 0 0 0\);/,
  /width:\s*1px;/,
  /height:\s*1px;/,
];
// The pre-fix scan: any earlier @media (max-width: 720px) plus a later
// .phead rule anywhere in the file. Kept only to prove a file-scope hoist
// still satisfies it.
const UNBOUNDED_PHEAD_SCAN =
  /@media \(max-width: 720px\)[\s\S]*?\.tasks-screen > \.phead\s*\{[^}]*position:\s*absolute;[^}]*overflow:\s*hidden;[^}]*min-height:\s*0;[^}]*clip-path:\s*inset\(50%\);[^}]*clip:\s*rect\(0 0 0 0\);[^}]*width:\s*1px;[^}]*height:\s*1px;/;

/**
 * The sheet with every comment and quoted string blanked to spaces, same
 * length so index math still lines up. A brace inside `content: "}"` or a
 * commented-out block must not open or close a media body.
 */
function blankCommentsAndStrings(css) {
  const out = css.split("");
  let at = 0;
  while (at < css.length) {
    const ch = css[at];
    let stop = -1;
    if (ch === "/" && css[at + 1] === "*") {
      const end = css.indexOf("*/", at + 2);
      stop = end === -1 ? css.length : end + 2;
    } else if (ch === '"' || ch === "'") {
      let scan = at + 1;
      while (scan < css.length && css[scan] !== ch && css[scan] !== "\n") {
        scan += css[scan] === "\\" ? 2 : 1;
      }
      stop = Math.min(scan + 1, css.length);
    }
    if (stop === -1) {
      at += 1;
      continue;
    }
    for (let i = at; i < stop; i += 1) out[i] = " ";
    at = stop;
  }
  return out.join("");
}

/**
 * Bodies of every `@media (max-width: 720px) { ... }` block, cut at the
 * matching close brace. A later file-scope rule cannot leak into an earlier
 * block the way a `[\s\S]*?` scan from the first opener can. Bodies come from
 * the blanked sheet, so a commented-out rule can neither break the balance nor
 * count as a real declaration.
 */
function mediaMaxWidth720Bodies(css) {
  const scan = blankCommentsAndStrings(css);
  const bodies = [];
  let from = 0;
  while (from < scan.length) {
    const opener = scan.indexOf(MEDIA_MAX_720, from);
    if (opener === -1) break;
    const afterQuery = opener + MEDIA_MAX_720.length;
    const brace = scan.indexOf("{", afterQuery);
    if (brace === -1) break;
    if (/\S/.test(scan.slice(afterQuery, brace))) {
      from = afterQuery;
      continue;
    }
    let depth = 1;
    let at = brace + 1;
    while (at < scan.length && depth > 0) {
      const ch = scan[at];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      at += 1;
    }
    if (depth !== 0) break;
    bodies.push(scan.slice(brace + 1, at - 1));
    from = at;
  }
  return bodies;
}

function collapsedPheadDeclarationsInMedia(css) {
  for (const body of mediaMaxWidth720Bodies(css)) {
    const match = body.match(COLLAPSED_PHEAD_SELECTOR);
    if (!match) continue;
    if (COLLAPSED_PHEAD_DECLARATIONS.every((needle) => needle.test(match[1]))) {
      return match[1];
    }
  }
  return null;
}

function hoistPheadRuleToFileScope(css) {
  const match = css.match(/\.tasks-screen\s*>\s*\.phead\s*\{[^}]*\}/);
  if (!match) return css;
  return `${css.replace(match[0], "")}\n${match[0]}\n`;
}

// Desktop Green List anatomy over the existing Purple engine. The
// desktopWork={false} branch stays DOM-equivalent to the pre-task component
// (tests/kanban-list.test.jsx pins that); everything here exercises only the
// additive desktop variant. Run under TZ=America/New_York.

function Harness(props) {
  const { lang, t } = useLang();
  return <KanbanList {...props} lang={lang} t={t} />;
}

function taskRowName(title) {
  return (name) => typeof name === "string" && (name === title || name.startsWith(`${title}, `));
}

function renderDesktopList(overrides = {}, lang = "en") {
  const props = {
    tasks: structuredClone(fallbackData.tasks),
    workstreamNames: ["Bargaining", "Chapter", "Communications", "Grievances", "Organizing", "Safety"],
    chapterId: "wor",
    doneVisible: true,
    onOpenTask: vi.fn(),
    onCycleStatus: vi.fn(),
    onCreateInline: vi.fn(async () => ({ id: "new" })),
    onCreateDefault: vi.fn(),
    depCounts: new Map([["task-demo-1", 2]]),
    subtaskCounts: new Map([["task-demo-1", { done: 0, total: 2 }]]),
    desktopWork: true,
    ...overrides,
  };
  const view = render(<LanguageProvider lang={lang}><Harness {...props} /></LanguageProvider>);
  return { props, view };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("groupListTasks status extension", () => {
  it("seeds every canonical status in order, including empty groups, with stable ids and localized names", () => {
    const groups = groupListTasks(
      fallbackData.tasks.filter((task) => task.status !== "backlog"),
      "status",
      [],
      "Unassigned",
      (status) => `LOC ${status}`,
    );
    expect(groups.map((group) => group.id)).toEqual(STATUS_IDS.map((status) => `status:${status}`));
    expect(groups.map((group) => group.name)).toEqual(STATUS_IDS.map((status) => `LOC ${status}`));
    expect(groups[0].tasks).toEqual([]);
  });

  it("keeps deterministic ids for workstream and assignee groups", () => {
    const workstreamGroups = groupListTasks(fallbackData.tasks, "workstream", ["Chapter"], "Unassigned");
    expect(workstreamGroups.find((group) => group.name === "Chapter").id).toBe("workstream:Chapter");
    const rows = [...fallbackData.tasks, { ...fallbackData.tasks[0], id: "loose", assigneeName: "" }];
    const assigneeGroups = groupListTasks(rows, "assignee", [], "Sin asignar");
    expect(assigneeGroups.find((group) => group.name === "Sin asignar").id).toBe("assignee:unassigned");
    expect(assigneeGroups.find((group) => group.name === "Jordan Lee").id).toBe("assignee:Jordan Lee");
  });

  it("never duplicates a task across status groups", () => {
    const groups = groupListTasks(fallbackData.tasks, "status", [], "Unassigned", (status) => status);
    const ids = groups.flatMap((group) => group.tasks.map((task) => task.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(fallbackData.tasks.length);
  });
});

describe("desktop List anatomy", () => {
  it("defaults to Status groups in canonical order with a three-mode selector", () => {
    renderDesktopList();
    const selector = screen.getByRole("combobox", { name: "Group by" });
    expect([...selector.options].map((option) => option.value)).toEqual(["status", "workstream", "assignee"]);
    expect(selector.value).toBe("status");
    const headings = ["Backlog", "To do", "In progress", "Review", "Done"];
    for (const heading of headings) {
      expect(screen.getByRole("region", { name: heading })).toBeInTheDocument();
    }
    const regionOrder = [...document.querySelectorAll(".kan-list__collapse strong")].map((node) => node.textContent);
    expect(regionOrder).toEqual(headings);
  });

  it("supports all three group modes without duplicating tasks", () => {
    renderDesktopList();
    const selector = screen.getByRole("combobox", { name: "Group by" });
    for (const mode of ["workstream", "assignee", "status"]) {
      fireEvent.change(selector, { target: { value: mode } });
      const titles = screen.getAllByRole("button", { name: taskRowName("Prepare August campaign meeting") });
      expect(titles).toHaveLength(1);
    }
    fireEvent.change(selector, { target: { value: "workstream" } });
    expect(screen.getByRole("region", { name: "Chapter" })).toBeInTheDocument();
    fireEvent.change(selector, { target: { value: "assignee" } });
    expect(screen.getByRole("region", { name: "Jordan Lee" })).toBeInTheDocument();
  });

  it("keeps Done behind the per-group reveal when doneVisible is false", () => {
    renderDesktopList({ doneVisible: false });
    expect(screen.queryByRole("button", { name: taskRowName("Publish bargaining priorities poll") })).not.toBeInTheDocument();
    const doneGroup = screen.getByRole("region", { name: "Done" });
    // Two done rows in the fallback set, and the control has to say so.
    fireEvent.click(within(doneGroup).getByRole("button", { name: "Show done tasks (2)" }));
    expect(screen.getByRole("button", { name: taskRowName("Publish bargaining priorities poll") })).toBeInTheDocument();
  });

  it("opens a title exactly once without any write and cycles through the separate control", () => {
    const { props } = renderDesktopList();
    fireEvent.click(screen.getByRole("button", { name: taskRowName("Prepare August campaign meeting") }));
    expect(props.onOpenTask).toHaveBeenCalledTimes(1);
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-1" }));
    expect(props.onCycleStatus).not.toHaveBeenCalled();
    const backlog = screen.getByRole("region", { name: "Backlog" });
    fireEvent.click(within(backlog).getByRole("button", { name: "Advance to To do" }));
    expect(props.onCycleStatus).toHaveBeenCalledTimes(1);
    expect(props.onCycleStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "task-demo-1" }));
  });

  it("keeps dependency, subtask, assignee, due, key, priority, and milestone signals", () => {
    renderDesktopList();
    const backlog = screen.getByRole("region", { name: "Backlog" });
    expect(within(backlog).getByText("WOR-1")).toBeInTheDocument();
    expect(within(backlog).getByText("2 dependencies")).toBeInTheDocument();
    expect(within(backlog).getByText("0/2 subtasks")).toBeInTheDocument();
    expect(within(backlog).getAllByText("Darnell Foster").length).toBeGreaterThan(0);
    expect(within(backlog).getByTitle("High")).toBeInTheDocument();
    expect(backlog.querySelector(".kan-listrow__due")).toBeInTheDocument();
    expect(within(backlog).getByText(/40%/)).toBeInTheDocument();
  });

  it.each(["en", "es"])("names every %s list row and stage toggle with the words it shows (WCAG 2.5.3)", (lang) => {
    renderDesktopList({}, lang);
    const controls = document.querySelectorAll(".kan-listrow__title, .kan-list__collapse");
    expect(controls.length).toBeGreaterThan(0);
    expect(labelInNameMismatches(controls)).toEqual([]);
  });

  it("exposes priority as accessible text and names the row from its signals", () => {
    renderDesktopList();
    const openButton = screen.getByRole("button", { name: taskRowName("Prepare August campaign meeting") });
    const row = openButton.closest(".kan-listrow");
    const priority = row.querySelector(".kan-pri");
    expect(within(priority).getByText("High")).toBeInTheDocument();
    expect(priority.querySelector("[aria-hidden='true']")).toBeTruthy();
    expect(openButton).toHaveAccessibleName(
      "Prepare August campaign meeting, 40% (Milestone progress), 2 dependencies, 0/2 subtasks",
    );
    expect(within(openButton).getByText("Milestone progress")).toBeInTheDocument();
    expect(within(openButton).getByText("40%")).toBeInTheDocument();
  });

  it("returns keyboard focus to the add control after submitting the composer", async () => {
    const onCreateInline = vi.fn(async () => ({ id: "new" }));
    renderDesktopList({ onCreateInline });
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "workstream" } });
    const chapter = screen.getByRole("region", { name: "Chapter" });
    fireEvent.click(within(chapter).getByRole("button", { name: "New task" }));
    const input = within(chapter).getByPlaceholderText("Task title");
    fireEvent.change(input, { target: { value: "Focus stays put" } });
    fireEvent.submit(input.closest("form"));
    await waitFor(() => {
      expect(onCreateInline).toHaveBeenCalledWith("Chapter", "to_do", "Focus stays put");
    });
    await waitFor(() => {
      expect(within(chapter).getByRole("button", { name: "New task" })).toHaveFocus();
    });
  });

  it("returns keyboard focus to the add control after cancelling the composer", async () => {
    renderDesktopList();
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "workstream" } });
    const chapter = screen.getByRole("region", { name: "Chapter" });
    fireEvent.click(within(chapter).getByRole("button", { name: "New task" }));
    fireEvent.click(within(chapter).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(within(chapter).getByRole("button", { name: "New task" })).toHaveFocus();
    });
  });

  it("keeps the workstream composer's Enter submit, visible Cancel, and busy behavior — with no Escape handler", () => {
    let releaseCreate;
    const onCreateInline = vi.fn(() => new Promise((resolve) => { releaseCreate = resolve; }));
    renderDesktopList({ onCreateInline });
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "workstream" } });
    const chapter = screen.getByRole("region", { name: "Chapter" });
    expect(document.querySelector(".kan-list__toolbar .kan-list__add")).not.toBeInTheDocument();
    fireEvent.click(within(chapter).getByRole("button", { name: "New task" }));
    const input = within(chapter).getByPlaceholderText("Task title");
    fireEvent.change(input, { target: { value: "Escape does nothing" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(within(chapter).getByPlaceholderText("Task title")).toBeInTheDocument();
    expect(within(chapter).getByRole("button", { name: "Cancel" })).toBeVisible();
    fireEvent.submit(input.closest("form"));
    expect(onCreateInline).toHaveBeenCalledWith("Chapter", "to_do", "Escape does nothing");
    expect(within(chapter).getByRole("button", { name: "Add" })).toHaveAttribute("aria-disabled", "true");
    releaseCreate({ id: "new" });
  });

  it("offers a visible New task action through onCreateDefault in Status and Assignee modes", () => {
    const { props } = renderDesktopList();
    const action = screen.getByRole("button", { name: "New task" });
    fireEvent.click(action);
    expect(props.onCreateDefault).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "assignee" } });
    expect(screen.getByRole("button", { name: "New task" })).toBeVisible();
  });

  it("renders honest, actionable empty and filtered-empty states", () => {
    const { props } = renderDesktopList({ tasks: [] });
    const empty = screen.getByText("No tasks to show. Adjust filters or create a task.");
    expect(empty).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(props.onCreateDefault).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "workstream" } });
    expect(screen.getByText("No tasks to show. Adjust filters or create a task.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(props.onCreateDefault).toHaveBeenCalledTimes(2);
  });

  it("classifies desktop urgency with local dates — a NY evening due-today row is never UTC-overdue", () => {
    const priorTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      vi.useFakeTimers();
      // 23:30 local on 2026-07-27 in America/New_York is already 2026-07-28 in
      // UTC, so the legacy toISOString comparison would call this overdue.
      vi.setSystemTime(new Date(2026, 6, 27, 23, 30));
      renderDesktopList();
      const review = screen.getByRole("region", { name: "Review" });
      const dueToday = within(review).getByRole("button", { name: taskRowName("Review chapter newsletter") })
        .closest(".kan-listrow");
      const dueCell = dueToday.querySelector(".kan-listrow__due");
      expect(dueCell.dataset.urgency).toBe("today");
      expect(dueCell.className).not.toContain("kan-listrow__due--overdue");
      const inProgress = screen.getByRole("region", { name: "In progress" });
      const overdueRow = within(inProgress).getByRole("button", { name: taskRowName("Clear issue intake backlog") })
        .closest(".kan-listrow");
      expect(overdueRow.querySelector(".kan-listrow__due").dataset.urgency).toBe("overdue");
    } finally {
      if (priorTz === undefined) delete process.env.TZ;
      else process.env.TZ = priorTz;
    }
  });

  it("fully collapses the retained mobile h1 box while keeping it in the accessibility tree", () => {
    expect(collapsedPheadDeclarationsInMedia(stylesSource)).not.toBeNull();
  });

  it("extracts each max-width 720px block by brace balance, not a forward scan", () => {
    const css = [
      "@media (max-width: 720px) { .early { color: red; } }",
      ".tasks-screen > .phead { position: absolute; overflow: hidden; min-height: 0; clip-path: inset(50%); clip: rect(0 0 0 0); width: 1px; height: 1px; }",
      "@media (max-width: 720px) { .outer { .nested { x: 1; } } }",
    ].join("\n");
    const bodies = mediaMaxWidth720Bodies(css);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain(".early { color: red; }");
    expect(bodies[0]).not.toContain(".tasks-screen > .phead");
    expect(bodies[1]).toContain(".nested { x: 1; }");
    expect(bodies[1]).not.toContain(".tasks-screen > .phead");
    expect(css).toMatch(UNBOUNDED_PHEAD_SCAN);
    expect(collapsedPheadDeclarationsInMedia(css)).toBeNull();
  });

  it("keeps the guarded rule found when a sibling rule or comment holds a stray brace", () => {
    const guarded =
      ".tasks-screen > .phead { position: absolute; overflow: hidden; min-height: 0;"
      + " clip-path: inset(50%); clip: rect(0 0 0 0); width: 1px; height: 1px; }";
    const css = [
      "@media (max-width: 720px) {",
      '  .marker::after { content: "}"; }',
      "  /* the } below is prose, not a block end */",
      `  ${guarded}`,
      "}",
    ].join("\n");
    expect(collapsedPheadDeclarationsInMedia(css)).not.toBeNull();
    expect(mediaMaxWidth720Bodies(css)).toHaveLength(1);
  });

  it("does not accept a commented-out collapse rule as the guarded one", () => {
    const css = [
      "@media (max-width: 720px) {",
      "  /* .tasks-screen > .phead { position: absolute; overflow: hidden; min-height: 0;",
      "     clip-path: inset(50%); clip: rect(0 0 0 0); width: 1px; height: 1px; } */",
      "  .kept { color: red; }",
      "}",
    ].join("\n");
    expect(collapsedPheadDeclarationsInMedia(css)).toBeNull();
  });

  it("fails when the .tasks-screen > .phead rule is hoisted to file scope", () => {
    const scratch = hoistPheadRuleToFileScope(stylesSource);
    expect(scratch).toMatch(UNBOUNDED_PHEAD_SCAN);
    expect(collapsedPheadDeclarationsInMedia(scratch)).toBeNull();
  });

  it("fails when a required collapse declaration is dropped inside the media block", () => {
    const match = stylesSource.match(/\.tasks-screen\s*>\s*\.phead\s*\{[^}]*\}/);
    expect(match).not.toBeNull();
    const withoutClipPath = match[0].replace(/clip-path:\s*inset\(50%\);\s*/, "");
    expect(withoutClipPath).not.toBe(match[0]);
    const scratch = stylesSource.replace(match[0], withoutClipPath);
    expect(collapsedPheadDeclarationsInMedia(scratch)).toBeNull();
    expect(collapsedPheadDeclarationsInMedia(stylesSource)).not.toBeNull();
  });

  it("resets collapse and reveal state when the group mode changes, keyed by stable group ids", () => {
    renderDesktopList();
    const backlog = screen.getByRole("region", { name: "Backlog" });
    const collapseButton = within(backlog).getByRole("button", { name: /Backlog/ });
    expect(collapseButton.getAttribute("aria-controls")).toBe(`task-desktop-list-${encodeURIComponent("status:backlog")}`);
    fireEvent.click(collapseButton);
    expect(collapseButton).toHaveAttribute("aria-expanded", "false");
    const selector = screen.getByRole("combobox", { name: "Group by" });
    fireEvent.change(selector, { target: { value: "workstream" } });
    fireEvent.change(selector, { target: { value: "status" } });
    expect(within(screen.getByRole("region", { name: "Backlog" })).getByRole("button", { name: /Backlog/ }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("keeps collapse and focus stable across a filter change", () => {
    const { props, view } = renderDesktopList();
    const collapseButton = within(screen.getByRole("region", { name: "Backlog" })).getByRole("button", { name: /Backlog/ });
    fireEvent.click(collapseButton);
    collapseButton.focus();
    const filtered = props.tasks.filter((task) => task.id !== "task-demo-2");
    view.rerender(
      <LanguageProvider lang="en"><Harness {...{ ...props, tasks: filtered }} /></LanguageProvider>,
    );
    const survivor = within(screen.getByRole("region", { name: "Backlog" })).getByRole("button", { name: /Backlog/ });
    expect(survivor).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(survivor);
  });

  it("uses identical stable panel ids in Spanish and never nests interactive controls", () => {
    renderDesktopList({}, "es");
    const backlog = screen.getByRole("region", { name: "Pendientes" });
    const collapseButton = within(backlog).getByRole("button", { name: /Pendientes/ });
    expect(collapseButton.getAttribute("aria-controls")).toBe(`task-desktop-list-${encodeURIComponent("status:backlog")}`);
    expect(screen.getByRole("combobox", { name: "Agrupar por" }).value).toBe("status");
    expect(screen.getByRole("region", { name: "Terminada" })).toBeInTheDocument();
    expect(document.querySelectorAll("button button, a button, button a")).toHaveLength(0);
  });
});

describe("inline task creation keeps focus while it saves (#8435)", () => {
  it("keeps Add focused while the inline task is created, and creates it once", async () => {
    const onCreateInline = vi.fn(async () => ({ id: "new" }));
    renderDesktopList({ onCreateInline });
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "workstream" } });
    const chapter = screen.getByRole("region", { name: "Chapter" });
    fireEvent.click(within(chapter).getByRole("button", { name: "New task" }));
    fireEvent.change(within(chapter).getByPlaceholderText("Task title"), { target: { value: "Book the room" } });
    await expectHeldWriteFocus(onCreateInline, within(chapter).getByRole("button", { name: "Add" }));
    expect(onCreateInline).toHaveBeenCalledTimes(1);
  });
});
