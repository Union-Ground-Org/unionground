import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { TasksView } from "../src/views/TasksView.jsx";

// Task keys (WOR-3) exist so a card can be PASTED INTO A MESSAGE and land on
// the right screen for whoever opens it. That makes the deep link a data
// contract, not a convenience, and this suite guards the ways it breaks.
//
// The mechanism is deliberately unusual and worth stating, because the obvious
// implementation is wrong here: the link is a QUERY PARAM written with
// history.replaceState, never navigate(). This app's pathname routing carries
// no params at all, and navigate() resets scroll — a member who opened a card
// from halfway down a long board would be thrown back to the top. replaceState
// also lets the write MERGE into whatever search string is already there,
// which is the whole reason the `demo` and `embed` params survive a share-link
// round trip. A naive `location.search = "?task=…"` would silently drop them
// and drop a teammate out of the demo tour the link was sent from.
//
// So the pins are:
//   * a key in the URL at mount opens that card, and the tab title carries the
//     key (the first document.title write in the codebase — it must be scoped
//     to the modal's lifetime, never leaked into the rest of the app);
//   * a key that is NOT on this board announces politely in the live region
//     and opens NOTHING — a stale link must not open the wrong card, and it
//     must not fail silently either;
//   * closing removes ONLY the task param;
//   * unmounting with a card open ALSO consumes the link — companion
//     navigation elsewhere preserves the whole search string, so a stranded
//     ?task= would re-open a stale modal on the next visit to the board —
//     while a key the board never consumed survives for the mount that will
//     read it, and a fresh mount (the reload path) still deep-links;
//   * opening a card writes the key LOWER-CASED, because that is the casing
//     the reader will paste back and matchTaskKey compares case-insensitively
//     from both ends.
//
// No matchMedia stub on purpose: jsdom answers false, which is the phone-width
// contract, and the kanban board scrolls horizontally at every width — the
// deep link must work on the narrow layout a shared link is most often opened
// on.

function renderTasks(search = "", overrides = {}, strict = false) {
  // The URL has to be in place BEFORE mount: the deep-link effect reads
  // window.location.search on its first run, exactly as a cold page load does.
  window.history.replaceState(null, "", `/m/tasks${search}`);
  const props = {
    data: structuredClone(fallbackData),
    onProfile: vi.fn(),
    onAssistant: vi.fn(),
    onCreateTask: vi.fn(async (fields) => ({ ...fields, id: "task-new" })),
    onUpdateTask: vi.fn(async (_id, fields) => fields),
    onDeleteTask: vi.fn(async () => ({ deleted: true })),
    onSendTaskMessage: vi.fn(async () => null),
    ...overrides,
  };
  const content = <LanguageProvider lang="en"><TasksView {...props} /></LanguageProvider>;
  const view = render(strict ? <StrictMode>{content}</StrictMode> : content);
  return { ...props, unmount: view.unmount };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  document.title = "Union Ground";
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
  document.title = "Union Ground";
});

describe("kanban deep link", () => {
  it("opens the exact task ID returned by a source shortcut", () => {
    const data = structuredClone(fallbackData);
    const id = "a1111111-1111-4111-8111-111111111111";
    data.tasks = data.tasks.map((task) => task.taskNumber === 3 ? { ...task, id } : task);
    renderTasks(`?task=${id}`, { data });
    expect(within(screen.getByRole("dialog", { name: "WOR-3" })).getByLabelText("Task title")).toHaveValue("Coworker outreach calls");
  });
  it("opens the modal on the card named by ?task=wor-3 and titles the tab with the key", () => {
    renderTasks("?task=wor-3");

    // The dialog is labelled by its key line, so the accessible name IS the
    // key a reader would have pasted.
    const dialog = screen.getByRole("dialog", { name: "WOR-3" });
    expect(within(dialog).getByLabelText("Task title")).toHaveValue("Coworker outreach calls");
    expect(document.title).toBe("WOR-3 · Union Ground");
  });

  it("keeps a consumed deep link through Strict Mode's effect rehearsal", () => {
    renderTasks("?demo=1&task=wor-3", {}, true);

    expect(screen.getByRole("dialog", { name: "WOR-3" })).toBeInTheDocument();
    expect(window.location.search).toBe("?demo=1&task=wor-3");
  });

  it("opens a card the current filter would have hidden", () => {
    // Scope defaults to "mine". task-demo-4 belongs to nobody the member is
    // tied to, so it is NOT on the filtered board — and a shared link must
    // still open it, or the link works for the sender and nobody else.
    renderTasks("?task=wor-4");
    expect(screen.queryByRole("button", { name: "Clear issue intake backlog" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "WOR-4" })).toBeInTheDocument();
  });

  it("announces an unknown key politely and opens nothing", async () => {
    renderTasks("?task=wor-999");

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("That task is not on this board"));
    // Opening the nearest card, or the first one, would be worse than nothing:
    // the member would edit a task they never asked for.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.title).toBe("Union Ground");
  });

  it("removes the task param on close and keeps every other param", async () => {
    renderTasks("?demo=1&task=wor-3");
    expect(screen.getByRole("dialog", { name: "WOR-3" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // demo=1 survives: the param is what put the reader in the tour, and a
    // clumsy `?task=` write would have dropped them out of it on close.
    expect(window.location.search).toBe("?demo=1");
    expect(window.location.pathname).toBe("/m/tasks");
    expect(document.title).toBe("Union Ground");
  });

  it("writes the key lower-cased when a card is opened from the board", () => {
    renderTasks("");
    expect(window.location.search).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Coworker outreach calls" }));

    expect(screen.getByRole("dialog", { name: "WOR-3" })).toBeInTheDocument();
    // The card renders WOR-3; the link carries wor-3. Both halves of
    // matchesTaskKey are case-insensitive precisely so this stays true.
    expect(window.location.search).toBe("?task=wor-3");
    expect(document.title).toBe("WOR-3 · Union Ground");
  });

  it("merges the task param into params that are already there", () => {
    renderTasks("?demo=1&embed=phone");
    fireEvent.click(screen.getByRole("button", { name: "Coworker outreach calls" }));
    expect(window.location.search).toBe("?demo=1&embed=phone&task=wor-3");
  });

  it("clears the task param on unmount with a card open and keeps every other param", async () => {
    const { unmount } = renderTasks("?demo=1&embed=phone&task=wor-3");
    expect(screen.getByRole("dialog", { name: "WOR-3" })).toBeInTheDocument();

    unmount();

    // Companion navigation copies the whole search string, so a surviving
    // ?task= here would follow the member to an unrelated view and re-open
    // this modal on their next visit to the board.
    await waitFor(() => expect(window.location.search).toBe("?demo=1&embed=phone"));
    expect(window.location.pathname).toBe("/m/tasks");
  });

  it("still deep-links on a fresh mount after an unmount consumed the key", async () => {
    renderTasks("?task=wor-3").unmount();
    await waitFor(() => expect(window.location.search).toBe(""));

    // A full page reload never runs the unmount cleanup; this fresh mount
    // stands in for it and must consume the key exactly like a cold load.
    renderTasks("?task=wor-3");
    expect(screen.getByRole("dialog", { name: "WOR-3" })).toBeInTheDocument();
    expect(document.title).toBe("WOR-3 · Union Ground");
  });

  it("leaves an unconsumed key alone when the board unmounts before tasks load", async () => {
    const data = structuredClone(fallbackData);
    data.tasks = [];
    const { unmount } = renderTasks("?task=wor-3", { data });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    unmount();
    await Promise.resolve();

    // StrictMode's rehearsal unmount (and any unmount that beats the board
    // load) must not eat a key nobody has read yet.
    expect(window.location.search).toBe("?task=wor-3");
  });
});
