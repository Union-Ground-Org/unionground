import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TodayView, myOpenTasks } from "../src/views/TodayView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// UB-CW-07 — "a member can be handed a task they cannot see".
//
// The defect was never in RLS. chapter_tasks_select_chapter grants SELECT on
// chapter membership alone, with no role and no assignee predicate, and the
// member snapshot already loads the rows. But the only surface that rendered
// them was the staff work board, gated on canUseStaffTools — so a member got a
// `task.assigned` notification reading "Open Tasks to see what is on your
// list" and landed on a view that never mounts. UB-CW-03 settled that the
// board stays staff-only, so the fix is a member surface outside it.
//
// What these pin, and why each one is a way the fix could quietly rot:
//   * the surface renders for a plain member on BOTH desktop and phone. A
//     desktop-only card recreates the identical dead end on the device most
//     members actually use, and no parity test would catch it.
//   * it is read-only. A member holds no write grant on chapter_tasks, so any
//     control here fails at the database; the card must not grow one.
//   * it shows only the member's OWN unfinished work. Widening the filter
//     turns a personal list into a chapter-wide roster leak on the home
//     screen — still legal under RLS, which is exactly why no test but this
//     one would notice.

const MEMBER_ID = fallbackData.member.id;
const noop = () => {};

function renderToday(props = {}, data = fallbackData) {
  return render(
    <LanguageProvider lang="en">
      <TodayView data={data} onPlanAction={noop} {...props} />
    </LanguageProvider>,
  );
}

function task(id, fields = {}) {
  return {
    id,
    chapterId: "wor",
    taskNumber: null,
    title: `Task ${id}`,
    status: "to_do",
    priority: "medium",
    assigneeId: null,
    assigneeIds: [],
    dueDate: null,
    blocked: false,
    ...fields,
  };
}

describe("myOpenTasks", () => {
  it("keeps only unfinished tasks assigned to this member", () => {
    const tasks = [
      task("mine", { assigneeIds: [MEMBER_ID] }),
      task("mine-done", { assigneeIds: [MEMBER_ID], status: "done" }),
      task("someone-else", { assigneeIds: ["99999999-9999-4999-8999-999999999999"] }),
      task("unassigned"),
    ];
    expect(myOpenTasks(tasks, MEMBER_ID).map((row) => row.id)).toEqual(["mine"]);
  });

  it("reads the legacy single assignee as well as the multi-assignee array", () => {
    // Both shapes are live in the data: assigneeIds came with the
    // multi-assignee migration, assigneeId is the original column and is still
    // what the fallback fixtures and older rows carry. Reading only one of them
    // hides real assignments.
    const legacy = [task("legacy", { assigneeId: MEMBER_ID })];
    expect(myOpenTasks(legacy, MEMBER_ID).map((row) => row.id)).toEqual(["legacy"]);
  });

  it("orders by soonest deadline and sinks undated work below it", () => {
    const tasks = [
      task("late", { assigneeIds: [MEMBER_ID], dueDate: "2026-09-01" }),
      task("undated", { assigneeIds: [MEMBER_ID] }),
      task("soon", { assigneeIds: [MEMBER_ID], dueDate: "2026-08-02" }),
    ];
    expect(myOpenTasks(tasks, MEMBER_ID).map((row) => row.id)).toEqual(["soon", "late", "undated"]);
  });

  it("returns nothing rather than everything when the member id is unknown", () => {
    // A null id must not fall through to "no assignee filter" — that would put
    // the whole chapter's board on one member's home screen.
    expect(myOpenTasks([task("a", { assigneeIds: [MEMBER_ID] })], null)).toEqual([]);
    expect(myOpenTasks(null, MEMBER_ID)).toEqual([]);
  });

  it("returns every matching assignment so a UI cap cannot erase real work", () => {
    const many = Array.from({ length: 12 }, (_, i) => task(`t${i}`, { assigneeIds: [MEMBER_ID] }));
    expect(myOpenTasks(many, MEMBER_ID)).toHaveLength(12);
  });
});

describe("assigned-to-you card on member Home", () => {
  for (const [label, props] of [["phone", {}], ["desktop", { desktop: true }]]) {
    it(`renders the member's assigned work on ${label}`, () => {
      const { container } = renderToday(props);
      const card = container.querySelector(".home-mytasks");
      expect(card).not.toBeNull();
      // The fallback member is the assignee of the August chapter-meeting task.
      expect(card.textContent).toContain("Prepare August campaign meeting");
      // …and not of the translation task, which belongs to another member.
      expect(card.textContent).not.toContain("Translate bargaining pulse");
    });

    it(`offers no write control on ${label}`, () => {
      const { container } = renderToday(props);
      const card = container.querySelector(".home-mytasks");
      expect(card.querySelectorAll("button, input, select, textarea, a")).toHaveLength(0);
    });
  }

  it("hides the card entirely when nothing is assigned", () => {
    const data = { ...fallbackData, tasks: [] };
    expect(renderToday({}, data).container.querySelector(".home-mytasks")).toBeNull();
  });

  it("flags blocked work and shows the status and card key", () => {
    const data = {
      ...fallbackData,
      tasks: [task("blocked-one", {
        assigneeIds: [MEMBER_ID], blocked: true, status: "in_progress", taskNumber: 42, dueDate: "2026-08-20",
      })],
    };
    const card = renderToday({}, data).container.querySelector(".home-mytasks");
    expect(card.querySelector(".home-mytask__blocked").textContent).toBe("Blocked");
    expect(card.textContent).toContain("WOR-42");
    expect(card.textContent).toContain("In progress");
  });

  it("says why the member cannot act on the list", () => {
    // The card is deliberately inert; without this line it reads as broken
    // rather than as staff-managed.
    const note = renderToday().container.querySelector(".home-mytasks__note");
    expect(note.textContent).toContain("Campaign staff manage these");
  });

  it("translates, rather than hardcoding English", () => {
    const { container } = render(
      <LanguageProvider lang="es">
        <TodayView data={fallbackData} onPlanAction={noop} />
      </LanguageProvider>,
    );
    const card = container.querySelector(".home-mytasks");
    expect(card.querySelector("h2").textContent).toBe("Asignado a ti");
    expect(card.textContent).not.toContain("Assigned to you");
  });

  for (const [label, props] of [["phone", {}], ["desktop", { desktop: true }]]) {
    it(`truthfully counts and reveals assignment six and beyond on ${label} without exposing another assignee's board work`, () => {
      const mine = Array.from({ length: 7 }, (_, i) => task(`mine-${i + 1}`, {
        assigneeIds: [MEMBER_ID],
        title: `My assignment ${i + 1}`,
        dueDate: `2026-08-${String(i + 1).padStart(2, "0")}`,
      }));
      const data = {
        ...fallbackData,
        tasks: [
          ...mine,
          task("staff-only", {
            assigneeIds: ["99999999-9999-4999-8999-999999999999"],
            title: "Private staff board assignment",
          }),
        ],
      };

      const card = renderToday(props, data).container.querySelector(".home-mytasks");
      expect(card).toHaveTextContent("5 of 7 shown");
      expect(within(card).getByText("My assignment 5")).toBeInTheDocument();
      expect(within(card).queryByText("My assignment 6")).toBeNull();
      expect(card).not.toHaveTextContent("Private staff board assignment");

      const toggle = within(card).getByRole("button", { name: "Show all 7 assignments" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(document.getElementById(toggle.getAttribute("aria-controls"))).toBe(card.querySelector(".home-mytasks__list"));
      fireEvent.click(toggle);

      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(card).toHaveTextContent("7 of 7 shown");
      expect(within(card).getByText("My assignment 6")).toBeInTheDocument();
      expect(within(card).getByText("My assignment 7")).toBeInTheDocument();
      expect(card).not.toHaveTextContent("Private staff board assignment");
      expect(card.querySelectorAll("input, select, textarea, a")).toHaveLength(0);
      expect(card.querySelectorAll("button")).toHaveLength(1);
    });
  }

  it("keeps keyboard focus on the disclosure while expanding and collapsing", () => {
    const data = {
      ...fallbackData,
      tasks: Array.from({ length: 6 }, (_, i) => task(`focus-${i + 1}`, {
        assigneeIds: [MEMBER_ID], title: `Focus assignment ${i + 1}`,
      })),
    };
    const card = renderToday({}, data).container.querySelector(".home-mytasks");
    const showAll = within(card).getByRole("button", { name: "Show all 6 assignments" });
    showAll.focus();
    fireEvent.click(showAll);
    const showFewer = within(card).getByRole("button", { name: "Show fewer assignments" });
    expect(showFewer).toHaveFocus();
    fireEvent.click(showFewer);
    expect(within(card).getByRole("button", { name: "Show all 6 assignments" })).toHaveFocus();
    expect(within(card).queryByText("Focus assignment 6")).toBeNull();
  });

  it("localizes the truthful count and disclosure in Spanish", () => {
    const data = {
      ...fallbackData,
      tasks: Array.from({ length: 6 }, (_, i) => task(`es-${i + 1}`, {
        assigneeIds: [MEMBER_ID], title: `Tarea ${i + 1}`,
      })),
    };
    render(
      <LanguageProvider lang="es">
        <TodayView data={data} onPlanAction={noop} />
      </LanguageProvider>,
    );
    const card = document.querySelector(".home-mytasks");
    expect(card).toHaveTextContent("Se muestran 5 de 6");
    expect(within(card).getByRole("button", { name: "Mostrar las 6 tareas asignadas" })).toBeInTheDocument();
  });
});
