import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SourceTaskAction } from "../src/components/SourceTaskAction.jsx";
import { canOfferSourceTask } from "../src/features/messaging/sourceTask.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { StewardView } from "../src/views/StewardView.jsx";
import { chooseReminder } from "./helpers/reminderPicker.js";

// REQ-UG-CONNECTED-WORKFLOW-SHORTCUTS-20260928. A staff task used to hang off
// whichever member message was newest, one button under the whole thread. It now
// belongs to the exact message it is pressed on: every eligible message carries
// its own control, the parent still decides who gets one at all, and a result for
// one message can never appear on another.

const created = { task: { id: "task-1", taskNumber: 7 }, created: true };

function wrap(node, lang = "en") {
  return <LanguageProvider lang={lang}>{node}</LanguageProvider>;
}

function renderAction(props = {}) {
  const onCreate = props.onCreate ?? vi.fn().mockResolvedValue(created);
  const view = render(wrap(<SourceTaskAction sourceKind="message" sourceId="m-1" onCreate={onCreate} {...props} />));
  const again = (next = {}) => view.rerender(wrap(<SourceTaskAction sourceKind="message" sourceId="m-1" onCreate={onCreate} {...props} {...next} />));
  return { ...view, onCreate, again };
}

async function createAndSettle() {
  fireEvent.click(screen.getByRole("button", { name: "Create task" }));
  await screen.findByRole("button", { name: "Open task" });
}

describe("SourceTaskAction source identity", () => {
  // Record 8435, slice 8: Create task keeps focus while it creates, and two
  // presses in one tick create one task.
  it("creates one task when Create task is pressed twice in one tick", async () => {
    const { onCreate } = renderAction({ onOpenTask: vi.fn() });
    const create = screen.getByRole("button", { name: "Create task" });
    await expectOneWriteFromOneTick(onCreate, [() => fireEvent.click(create), () => fireEvent.click(create)]);
    await screen.findByRole("button", { name: "Open task" });
  });

  it("keeps Create task focused while it creates", async () => {
    const { onCreate } = renderAction();
    await expectHeldWriteFocus(onCreate, screen.getByRole("button", { name: "Create task" }));
  });

  it("starts clean when the same control is reused for another source", async () => {
    const view = renderAction({ onOpenTask: vi.fn() });
    await createAndSettle();
    expect(screen.getByRole("status")).toHaveTextContent("Task created");

    view.again({ sourceId: "m-2" });
    expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open task" })).not.toBeInTheDocument();
  });

  it("drops a create that resolves after the control moved to another source", async () => {
    let finish;
    const onCreate = vi.fn(() => new Promise((resolveCreate) => { finish = resolveCreate; }));
    const onOpenTask = vi.fn();
    const view = renderAction({ onCreate, onOpenTask });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(screen.getByRole("button", { name: "Creating task…" })).toHaveAttribute("aria-disabled", "true");

    view.again({ sourceId: "m-2" });
    await act(async () => finish(created));

    expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open task" })).not.toBeInTheDocument();
    expect(onOpenTask).not.toHaveBeenCalled();
    // The other source is not locked by the abandoned request.
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate).toHaveBeenLastCalledWith("message", "m-2");
  });
});

describe("SourceTaskAction leaves creation to the server", () => {
  it("always asks the server, which answers with the existing task instead of a second one", async () => {
    const onCreate = vi.fn()
      .mockResolvedValueOnce({ task: { id: "task-1" }, created: true })
      .mockResolvedValueOnce({ task: { id: "task-1" }, created: false });
    renderAction({ onCreate });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Task created")).toBeInTheDocument();
    // No Open control here, so the button stays: pressing it again must reach the
    // server, not be swallowed by a client-side "already created" flag.
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Existing task ready")).toBeInTheDocument();
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate).toHaveBeenNthCalledWith(2, "message", "m-1");
  });

  it("keeps the busy lock as an extra guard, not the only one", async () => {
    let finish;
    const onCreate = vi.fn(() => new Promise((resolveCreate) => { finish = resolveCreate; }));
    renderAction({ onCreate });
    const button = screen.getByRole("button", { name: "Create task" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onCreate).toHaveBeenCalledTimes(1);
    await act(async () => finish(created));
  });

  it("treats a missing task in the reply as a failed conversion", async () => {
    renderAction({ onCreate: vi.fn().mockResolvedValue(null) });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This source could not be converted");
    expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
  });

  it.each([
    ["a Postgres 42501", { code: "42501" }],
    ["an HTTP 403", { status: 403 }],
  ])("stops offering creation once %s says the role is gone", async (_label, cause) => {
    renderAction({ onCreate: vi.fn().mockRejectedValue(Object.assign(new Error("staff role required"), cause)) });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You no longer have access to create tasks from this source.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/staff role required/)).not.toBeInTheDocument();
  });
});

describe("SourceTaskAction revalidates when the task is opened", () => {
  const fresh = { id: "task-1", taskNumber: 7, title: "Follow up on member message" };

  it("hands the server-confirmed task, not the cached one, to onOpenTask", async () => {
    const onResolve = vi.fn().mockResolvedValue({ task: fresh });
    const onOpenTask = vi.fn();
    renderAction({ onResolve, onOpenTask });
    await createAndSettle();
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    await waitFor(() => expect(onOpenTask).toHaveBeenCalledTimes(1));
    expect(onResolve).toHaveBeenCalledWith("message", "m-1", created.task);
    expect(onOpenTask).toHaveBeenCalledWith(fresh);
  });

  it("locks the control while it revalidates and resolves once for a double press", async () => {
    let finish;
    const onResolve = vi.fn(() => new Promise((resolveOpen) => { finish = resolveOpen; }));
    const onOpenTask = vi.fn();
    renderAction({ onResolve, onOpenTask });
    await createAndSettle();
    const open = screen.getByRole("button", { name: "Open task" });
    fireEvent.click(open);
    fireEvent.click(open);
    expect(onResolve).toHaveBeenCalledTimes(1);
    // #9914: unavailable while it opens, but still focusable (pending).
    expect(screen.getByRole("button", { name: "Opening task…" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Opening task…" })).toBeEnabled();
    await act(async () => finish({ task: fresh }));
    expect(onOpenTask).toHaveBeenCalledTimes(1);
  });

  it("says so and offers creation again when the link no longer exists", async () => {
    const onOpenTask = vi.fn();
    renderAction({ onResolve: vi.fn().mockResolvedValue(null), onOpenTask });
    await createAndSettle();
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The linked task is no longer available.");
    expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Open task" })).not.toBeInTheDocument();
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("withdraws every control when revalidation finds the role revoked", async () => {
    const onOpenTask = vi.fn();
    renderAction({ onResolve: vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { code: "42501" })), onOpenTask });
    await createAndSettle();
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You no longer have access to create tasks from this source.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("keeps Open available after a transient failure and opens on the retry", async () => {
    const onResolve = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ task: fresh });
    const onOpenTask = vi.fn();
    renderAction({ onResolve, onOpenTask });
    await createAndSettle();
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be opened. Try again.");
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open task" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    await waitFor(() => expect(onOpenTask).toHaveBeenCalledWith(fresh));
    expect(onResolve).toHaveBeenCalledTimes(2);
  });

  it("does not open a task for a source the control has since left", async () => {
    let finish;
    const onResolve = vi.fn(() => new Promise((resolveOpen) => { finish = resolveOpen; }));
    const onOpenTask = vi.fn();
    const view = renderAction({ onResolve, onOpenTask });
    await createAndSettle();
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    view.again({ sourceId: "m-2" });
    await act(async () => finish({ task: fresh }));
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
  });

  it("opens the cached task directly when no controller supplied onResolve", async () => {
    const onOpenTask = vi.fn();
    renderAction({ onOpenTask });
    await createAndSettle();
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    expect(onOpenTask).toHaveBeenCalledWith(created.task);
  });
});

describe("SourceTaskAction awaits the opener", () => {
  // The connected opener is async: it re-reads the task and its source, then
  // navigates, and it rejects for a revoked role or a task that is gone. Whether
  // an onResolve ran first or not, that rejection has to land on this control.
  const fresh = { id: "task-1", taskNumber: 7 };
  const paths = [["without onResolve", false], ["with onResolve", true]];

  async function openWith({ onOpenTask, resolveFirst }) {
    const onResolve = resolveFirst ? vi.fn().mockResolvedValue({ task: fresh }) : undefined;
    const view = renderAction({ onOpenTask, onResolve });
    await createAndSettle();
    return { ...view, onResolve, open: () => fireEvent.click(screen.getByRole("button", { name: "Open task" })) };
  }

  it.each(paths)("never leaves a rejecting opener unhandled %s", async (_label, resolveFirst) => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const onOpenTask = vi.fn().mockRejectedValue(Object.assign(new Error("boom"), { code: "23505" }));
      const { open } = await openWith({ onOpenTask, resolveFirst });
      open();
      expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be opened. Try again.");
      await new Promise((resolveTick) => setTimeout(resolveTick, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it.each(paths)("withdraws every control when the opener reports a revoked role %s", async (_label, resolveFirst) => {
    const onOpenTask = vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { code: "not_authorized" }));
    const { open } = await openWith({ onOpenTask, resolveFirst });
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("You no longer have access to create tasks from this source.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/denied/)).not.toBeInTheDocument();
  });

  it.each(paths)("says the task is gone and offers creation again when the opener finds it missing %s", async (_label, resolveFirst) => {
    const onOpenTask = vi.fn().mockRejectedValue(Object.assign(new Error("gone"), { code: "source_unavailable" }));
    const { open } = await openWith({ onOpenTask, resolveFirst });
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("The linked task is no longer available.");
    expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Open task" })).not.toBeInTheDocument();
  });

  it.each(paths)("treats a synchronous throw like a rejection and lets the retry open %s", async (_label, resolveFirst) => {
    const onOpenTask = vi.fn()
      .mockImplementationOnce(() => { throw new Error("router not ready"); })
      .mockResolvedValueOnce(undefined);
    const { open } = await openWith({ onOpenTask, resolveFirst });
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be opened. Try again.");
    expect(screen.queryByText(/router not ready/)).not.toBeInTheDocument();
    open();
    await waitFor(() => expect(onOpenTask).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it.each(paths)("locks the control while an async opener is in flight %s", async (_label, resolveFirst) => {
    let finish;
    const onOpenTask = vi.fn(() => new Promise((resolveOpen) => { finish = resolveOpen; }));
    const { open } = await openWith({ onOpenTask, resolveFirst });
    open();
    const busy = await screen.findByRole("button", { name: "Opening task…" });
    // #9914: unavailable while it opens, but still focusable (pending).
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toBeEnabled();
    fireEvent.click(busy);
    await act(async () => finish());
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Open task" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hands a plain callback the task inside the click, as before", async () => {
    const onOpenTask = vi.fn();
    const { open } = await openWith({ onOpenTask, resolveFirst: false });
    open();
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask).toHaveBeenCalledWith(created.task);
  });
});

describe("SourceTaskAction markup", () => {
  it("keeps the original classes and strings for existing callers", () => {
    const view = renderAction();
    expect(view.container.querySelector(".dialog-secondary-row .dialog-secondary")).toHaveTextContent("Create task");
    expect(view.container.querySelector(".source-task")).toBeNull();
  });

  it("draws the compact message variant and describes each button without copying text", () => {
    render(wrap(<>
      <time id="sent-1">Jul 12, 9:00 AM</time>
      <SourceTaskAction variant="message" describedBy="sent-1" sourceKind="message" sourceId="m-1" onCreate={vi.fn()} />
    </>));
    const button = screen.getByRole("button", { name: "Create task" });
    expect(button).toHaveClass("source-task__button");
    expect(button.closest(".source-task--message")).not.toBeNull();
    expect(button).toHaveAccessibleDescription("Jul 12, 9:00 AM");
  });

  it("reads its new states in Spanish", async () => {
    const es = catalogue.es;
    renderAction({ onCreate: vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: "42501" })) });
    render(wrap(<SourceTaskAction sourceKind="message" sourceId="m-es" onCreate={vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: "42501" }))} />, "es"));
    fireEvent.click(screen.getByRole("button", { name: es["sourceTask.create"] }));
    expect(await screen.findByRole("alert", {}, { timeout: 2000 })).toHaveTextContent(es["sourceTask.denied"]);
  });
});

describe("canOfferSourceTask", () => {
  it("accepts a delivered, still-present message from either side of the conversation", () => {
    const message = { id: "m1", sender_kind: "member", body: "x" };
    expect(canOfferSourceTask(message)).toBe(true);
    // The connected createTask links both directions of an authorized private message.
    expect(canOfferSourceTask({ ...message, sender_kind: "steward" })).toBe(true);
    expect(canOfferSourceTask({ ...message, sender_kind: "system" })).toBe(false);
    expect(canOfferSourceTask({ ...message, sender_kind: undefined })).toBe(false);
    expect(canOfferSourceTask({ ...message, pending: true })).toBe(false);
    expect(canOfferSourceTask({ ...message, id: "local-resource-1" })).toBe(false);
    expect(canOfferSourceTask({ ...message, redacted_at: "2026-09-06T00:00:00Z" })).toBe(false);
    expect(canOfferSourceTask({ ...message, redactedAt: "2026-09-06T00:00:00Z" })).toBe(false);
    expect(canOfferSourceTask({ ...message, id: "" })).toBe(false);
    expect(canOfferSourceTask(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The private conversation in Messages.
// ---------------------------------------------------------------------------

function messagesData(extraMessages = []) {
  return {
    member: { id: "member-1" },
    conversations: [
      {
        id: "conv-1", counterpartRole: "steward", sender: "Chapter steward", initials: "CS",
        preview: "PRIVATE second note 509", dateLabel: "Jul 12", unread: 0,
        messages: [
          { id: "m-old", sender_kind: "member", sender_name: "Member", body: "PRIVATE first note 509", created_at: "2026-07-12T09:00:00.000Z" },
          { id: "m-steward", sender_kind: "steward", sender_name: "Chapter steward", body: "Noted, thanks", created_at: "2026-07-12T10:00:00.000Z" },
          { id: "m-new", sender_kind: "member", sender_name: "Member", body: "PRIVATE second note 509", created_at: "2026-07-12T11:00:00.000Z" },
          ...extraMessages,
        ],
      },
      {
        id: "conv-2", counterpartRole: "steward", sender: "Other steward", initials: "OS", preview: "Different thread text", dateLabel: "Jul 11", unread: 0,
        messages: [{ id: "m-other", sender_kind: "member", sender_name: "Member", body: "Different thread text", created_at: "2026-07-11T09:00:00.000Z" }],
      },
    ],
    broadcasts: [],
    product: { spaces: [], documents: [] },
  };
}

function renderMessages({ data = messagesData(), desktop = true, ...props } = {}) {
  const handlers = {
    onProfile: vi.fn(), onAssistant: vi.fn(), onSendMessage: vi.fn().mockResolvedValue({}),
    onReadConversation: vi.fn().mockResolvedValue(null), onReadBroadcast: vi.fn(), onOpenTopics: vi.fn(),
    ...props,
  };
  const view = render(<MessagesView data={data} desktop={desktop} {...handlers} />);
  return { ...view, handlers };
}

// The preview line in the inbox list repeats a message's text, so look inside the thread.
const articleOf = (text) => screen.getByText(text, { selector: "article p" }).closest("article");

function openConversation(previewText) {
  fireEvent.click(screen.getByText(previewText, { selector: ".inbox-row__preview" }));
  return screen.getByRole("region", { name: "Message detail" });
}

describe("Messages: task action on each exact message", () => {
  it("puts a control on every delivered message of either side, with no thread-level shortcut", () => {
    const onCreateTaskFromSource = vi.fn();
    renderMessages({ onCreateTaskFromSource, staffAccess: true });
    const pane = openConversation("PRIVATE second note 509");
    const buttons = within(pane).getAllByRole("button", { name: "Create task" });
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.closest("article"))).toBe(true);
    for (const text of ["PRIVATE first note 509", "Noted, thanks", "PRIVATE second note 509"]) {
      expect(within(articleOf(text)).getByRole("button", { name: "Create task" })).toBeInTheDocument();
    }
    expect(onCreateTaskFromSource).not.toHaveBeenCalled();
  });

  it("creates from a steward's message too, by its own id", async () => {
    const onCreateTaskFromSource = vi.fn().mockResolvedValue({ task: { id: "task-steward", taskNumber: 9 }, created: true });
    renderMessages({ onCreateTaskFromSource, staffAccess: true });
    openConversation("PRIVATE second note 509");
    const reply = articleOf("Noted, thanks");
    fireEvent.click(within(reply).getByRole("button", { name: "Create task" }));
    await within(reply).findByRole("status");
    expect(onCreateTaskFromSource).toHaveBeenCalledWith("message", "m-steward");
    expect(JSON.stringify(onCreateTaskFromSource.mock.calls)).not.toMatch(/Noted|thanks/);
  });

  it("creates from the older message that was pressed, never from the newest", async () => {
    const onCreateTaskFromSource = vi.fn().mockResolvedValue({ task: { id: "task-old", taskNumber: 7 }, created: true });
    renderMessages({ onCreateTaskFromSource, staffAccess: true });
    openConversation("PRIVATE second note 509");
    const older = articleOf("PRIVATE first note 509");
    fireEvent.click(within(older).getByRole("button", { name: "Create task" }));
    await within(older).findByRole("status");
    expect(onCreateTaskFromSource).toHaveBeenCalledTimes(1);
    expect(onCreateTaskFromSource).toHaveBeenCalledWith("message", "m-old");
    expect(within(older).getByRole("status")).toHaveTextContent("Task created");
    // The other message did not gain a result and can still be converted.
    expect(within(articleOf("PRIVATE second note 509")).getByRole("button", { name: "Create task" })).toBeEnabled();
    expect(within(articleOf("PRIVATE second note 509")).queryByRole("status")).toBeNull();
  });

  it("copies nothing private into the request or the control", async () => {
    const onCreateTaskFromSource = vi.fn().mockResolvedValue({ task: { id: "task-old", taskNumber: 7 }, created: true });
    renderMessages({ onCreateTaskFromSource, onOpenTask: vi.fn(), staffAccess: true });
    openConversation("PRIVATE second note 509");
    const older = articleOf("PRIVATE first note 509");
    const button = within(older).getByRole("button", { name: "Create task" });
    // Each identical button is told apart by its message's timestamp, not by its text.
    const stamp = document.getElementById(button.getAttribute("aria-describedby"));
    expect(stamp?.tagName).toBe("TIME");
    expect(older.contains(stamp)).toBe(true);
    expect(button).toHaveAccessibleDescription(stamp.textContent);
    fireEvent.click(button);
    await within(older).findByRole("button", { name: "Open task" });
    expect(JSON.stringify(onCreateTaskFromSource.mock.calls)).not.toMatch(/PRIVATE|first note/);
    expect(within(older).getByRole("button", { name: "Open task" }).getAttribute("aria-describedby")).toBe(stamp.id);
    for (const control of older.querySelectorAll(".source-task")) expect(control.textContent).not.toMatch(/PRIVATE|first note/);
  });

  it("opens the task with the exact message and conversation it came from", async () => {
    const onCreateTaskFromSource = vi.fn().mockResolvedValue({ task: { id: "task-old", taskNumber: 7 }, created: true });
    const onOpenTask = vi.fn();
    renderMessages({ onCreateTaskFromSource, onOpenTask, staffAccess: true });
    openConversation("PRIVATE second note 509");
    const older = articleOf("PRIVATE first note 509");
    fireEvent.click(within(older).getByRole("button", { name: "Create task" }));
    fireEvent.click(await within(older).findByRole("button", { name: "Open task" }));
    expect(onOpenTask).toHaveBeenCalledWith({ id: "task-old", taskNumber: 7 }, { sourceKind: "message", sourceId: "m-old", conversationId: "conv-1" });
  });

  it("revalidates through the controller's resolver before opening", async () => {
    const onCreateTaskFromSource = vi.fn().mockResolvedValue({ task: { id: "task-old", taskNumber: 7 }, created: true });
    const onResolveSourceTask = vi.fn().mockResolvedValue({ task: { id: "task-old", taskNumber: 8 } });
    const onOpenTask = vi.fn();
    renderMessages({ onCreateTaskFromSource, onResolveSourceTask, onOpenTask, staffAccess: true });
    openConversation("PRIVATE second note 509");
    const older = articleOf("PRIVATE first note 509");
    fireEvent.click(within(older).getByRole("button", { name: "Create task" }));
    fireEvent.click(await within(older).findByRole("button", { name: "Open task" }));
    await waitFor(() => expect(onOpenTask).toHaveBeenCalledTimes(1));
    expect(onResolveSourceTask).toHaveBeenCalledWith("message", "m-old", { id: "task-old", taskNumber: 7 });
    expect(onOpenTask.mock.calls[0][0]).toEqual({ id: "task-old", taskNumber: 8 });
  });

  it("offers no control to a Member hat, whatever the conversation holds", () => {
    // The parent withholds onCreateTaskFromSource from a Member hat (App passes
    // null unless a staff hat is authorized); the view never grants it itself.
    renderMessages({ onCreateTaskFromSource: null, staffAccess: false });
    const pane = openConversation("PRIVATE second note 509");
    expect(within(pane).queryByRole("button", { name: "Create task" })).toBeNull();
    expect(pane.querySelector(".source-task")).toBeNull();
  });

  it("does not turn a staff-access flag alone into task creation", () => {
    renderMessages({ onCreateTaskFromSource: null, staffAccess: true });
    const pane = openConversation("PRIVATE second note 509");
    expect(within(pane).queryByRole("button", { name: "Create task" })).toBeNull();
  });

  it("skips messages that are pending, client-made or removed", () => {
    const data = messagesData([
      { id: "m-pending", sender_kind: "member", sender_name: "Member", body: "still sending 509", created_at: "2026-07-12T12:00:00.000Z", pending: true },
      { id: "local-resource-1", sender_kind: "member", sender_name: "Member", body: "shared file 509", created_at: "2026-07-12T12:01:00.000Z" },
      { id: "m-gone", sender_kind: "member", sender_name: "Member", body: "", redacted_at: "2026-07-12T12:02:00.000Z", redaction_reason: "sender_removed", created_at: "2026-07-12T12:02:00.000Z" },
    ]);
    renderMessages({ data, onCreateTaskFromSource: vi.fn(), staffAccess: true });
    const pane = openConversation("PRIVATE second note 509");
    expect(within(pane).getAllByRole("button", { name: "Create task" })).toHaveLength(3);
    expect(within(articleOf("still sending 509")).queryByRole("button", { name: "Create task" })).toBeNull();
    expect(within(articleOf("shared file 509")).queryByRole("button", { name: "Create task" })).toBeNull();
  });

  it("keeps a result from a conversation the staff member has since left off every other conversation", async () => {
    let finish;
    const onCreateTaskFromSource = vi.fn(() => new Promise((resolveCreate) => { finish = resolveCreate; }));
    const onOpenTask = vi.fn();
    renderMessages({ onCreateTaskFromSource, onOpenTask, staffAccess: true });
    openConversation("PRIVATE second note 509");
    fireEvent.click(within(articleOf("PRIVATE first note 509")).getByRole("button", { name: "Create task" }));
    expect(onCreateTaskFromSource).toHaveBeenCalledWith("message", "m-old");

    // Navigate to the other conversation while the request is still in flight.
    const pane = openConversation("Different thread text");
    expect(within(pane).getByText("Different thread text", { selector: "article p" })).toBeInTheDocument();
    await act(async () => finish({ task: { id: "task-old", taskNumber: 7 }, created: true }));

    const other = articleOf("Different thread text");
    expect(within(other).getByRole("button", { name: "Create task" })).toBeEnabled();
    expect(within(pane).queryByText("Task created")).toBeNull();
    expect(within(pane).queryByRole("button", { name: "Open task" })).toBeNull();
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("renders the same per-message controls in the phone dialog", () => {
    renderMessages({ desktop: false, onCreateTaskFromSource: vi.fn(), staffAccess: true });
    fireEvent.click(screen.getByText("PRIVATE second note 509", { selector: ".inbox-row__preview" }));
    const dialog = screen.getByRole("dialog", { name: "Chapter steward" });
    expect(within(dialog).getAllByRole("button", { name: "Create task" })).toHaveLength(3);
  });

  it("keeps the broadcast task control, now revalidated by the same resolver", async () => {
    const data = { ...messagesData(), broadcasts: [{ id: "b-1", title: "July meeting", sender: "Harborview Care United", body: "Thursday 6pm", unread: false, publishedAt: "2026-07-10T18:00:00.000Z" }] };
    const onCreateTaskFromSource = vi.fn().mockResolvedValue({ task: { id: "task-b", taskNumber: 3 }, created: true });
    const onResolveSourceTask = vi.fn().mockResolvedValue({ task: { id: "task-b", taskNumber: 3 } });
    renderMessages({ data, onCreateTaskFromSource, onResolveSourceTask, onOpenTask: vi.fn(), staffAccess: true });
    fireEvent.click(screen.getByText("July meeting"));
    const pane = screen.getByRole("region", { name: "Message detail" });
    fireEvent.click(within(pane).getByRole("button", { name: "Create task" }));
    fireEvent.click(await within(pane).findByRole("button", { name: "Open task" }));
    await waitFor(() => expect(onResolveSourceTask).toHaveBeenCalledWith("broadcast", "b-1", { id: "task-b", taskNumber: 3 }));
  });
});

describe("Messages: the reminder belongs to the exact message", () => {
  const remindApi = () => ({
    toggleReaction: vi.fn().mockResolvedValue({ reacted: true }),
    toggleSaved: vi.fn().mockResolvedValue({ saved: true }),
    remind: vi.fn().mockResolvedValue({ id: "reminder-1" }),
  });

  it("sets it on the older message that was chosen (fallback surface)", async () => {
    const messagingApi = remindApi();
    renderMessages({ messagingApi, onNotice: vi.fn() });
    openConversation("PRIVATE second note 509");
    const older = articleOf("PRIVATE first note 509");
    const remindAt = chooseReminder(older);
    await waitFor(() => expect(messagingApi.remind).toHaveBeenCalledWith("private", "m-old", remindAt));
    expect(messagingApi.remind).toHaveBeenCalledTimes(1);
    expect(within(articleOf("PRIVATE second note 509")).getByRole("button", { name: "Remind me…" })).toBeEnabled();
  });

  it("sets it on the older message that was chosen (shared surface)", async () => {
    // The server remembers the reminder: a later state read carries it, as it does live.
    const remembered = new Set();
    const stateFor = (id) => ({ canEdit: false, saved: false, reminders: remembered.has(id) ? [{ id: `r-${id}` }] : [], reactions: [] });
    const messagingApi = {
      ...remindApi(),
      messageAction: vi.fn(async (_kind, id, action) => {
        if (action === "remind") remembered.add(id);
        return action === "state" ? stateFor(id) : { state: stateFor(id), result: { id: `r-${id}` } };
      }),
    };
    renderMessages({ messagingApi, onNotice: vi.fn() });
    openConversation("PRIVATE second note 509");
    const older = articleOf("PRIVATE first note 509");
    await within(older).findByRole("button", { name: "Remind me…" });
    const remindAt = chooseReminder(older);
    await waitFor(() => expect(messagingApi.messageAction).toHaveBeenCalledWith("private", "m-old", "remind", remindAt));
    expect(messagingApi.messageAction.mock.calls.filter(([, , action]) => action === "remind")).toHaveLength(1);
    expect(await within(older).findByRole("button", { name: "Remove reminders" })).toBeInTheDocument();
  });

  it("sits beside the task control on the same exact message", async () => {
    const messagingApi = remindApi();
    const onCreateTaskFromSource = vi.fn().mockResolvedValue({ task: { id: "task-old", taskNumber: 7 }, created: true });
    renderMessages({ messagingApi, onCreateTaskFromSource, staffAccess: true, onNotice: vi.fn() });
    openConversation("PRIVATE second note 509");
    const older = articleOf("PRIVATE first note 509");
    const remindAt = chooseReminder(older);
    fireEvent.click(within(older).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(messagingApi.remind).toHaveBeenCalledWith("private", "m-old", remindAt));
    await waitFor(() => expect(onCreateTaskFromSource).toHaveBeenCalledWith("message", "m-old"));
  });
});

// ---------------------------------------------------------------------------
// The steward's thread.
// ---------------------------------------------------------------------------

function stewardDesk() {
  return {
    queue: [],
    threads: [{
      id: "conv-1", memberName: "Renata Cole", memberInitials: "RC", preview: "PRIVATE latest note 509", updatedAt: "2026-07-21T09:00:00Z", awaitingReply: true,
      messages: [
        { id: "m-old", sender_kind: "member", sender_name: "Renata Cole", body: "PRIVATE earliest note 509", created_at: "2026-07-21T08:00:00Z" },
        { id: "m-reply", sender_kind: "steward", sender_name: "Sam Okafor", body: "Steward reply text", created_at: "2026-07-21T08:30:00Z" },
        { id: "m-new", sender_kind: "member", sender_name: "Renata Cole", body: "PRIVATE latest note 509", created_at: "2026-07-21T09:00:00Z" },
      ],
    }],
    broadcasts: [],
    formsInbox: [],
    kpis: { openRequests: 0, membersCovered: 1, awaitingReply: 1, broadcasts30d: 0 },
  };
}

function stewardApi() {
  return {
    loadDesk: vi.fn().mockResolvedValue(stewardDesk()),
    toggleReaction: vi.fn().mockResolvedValue({ reacted: true }),
    toggleSaved: vi.fn().mockResolvedValue({ saved: true }),
    remind: vi.fn().mockResolvedValue({ id: "reminder-1" }),
    listScheduled: vi.fn().mockResolvedValue([]),
  };
}

async function openStewardThread(props = {}) {
  const api = stewardApi();
  render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} {...props} />);
  fireEvent.click(await screen.findByText("PRIVATE latest note 509"));
  const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
  return { api, dialog };
}

describe("Steward thread: task action on each exact message", () => {
  it("puts a control on each delivered message of either side, and only on messages", async () => {
    const { dialog } = await openStewardThread({ onCreateTaskFromSource: vi.fn() });
    const buttons = within(dialog).getAllByRole("button", { name: "Create task" });
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.closest("article"))).toBe(true);
    expect(within(within(dialog).getByText("Steward reply text").closest("article")).getByRole("button", { name: "Create task" })).toBeInTheDocument();
  });

  it("creates from the older message that was pressed and opens it with its context", async () => {
    const onCreateTaskFromSource = vi.fn().mockResolvedValue({ task: { id: "task-old", taskNumber: 7 }, created: true });
    const onOpenTask = vi.fn();
    const { dialog } = await openStewardThread({ onCreateTaskFromSource, onOpenTask });
    const older = within(dialog).getByText("PRIVATE earliest note 509").closest("article");
    fireEvent.click(within(older).getByRole("button", { name: "Create task" }));
    fireEvent.click(await within(older).findByRole("button", { name: "Open task" }));
    expect(onCreateTaskFromSource).toHaveBeenCalledTimes(1);
    expect(onCreateTaskFromSource).toHaveBeenCalledWith("message", "m-old");
    expect(JSON.stringify(onCreateTaskFromSource.mock.calls)).not.toMatch(/PRIVATE|earliest/);
    expect(onOpenTask).toHaveBeenCalledWith({ id: "task-old", taskNumber: 7 }, { sourceKind: "message", sourceId: "m-old", conversationId: "conv-1" });
  });

  it("offers no control when the desk was handed no task capability", async () => {
    const { dialog } = await openStewardThread({ onCreateTaskFromSource: null });
    expect(within(dialog).queryByRole("button", { name: "Create task" })).toBeNull();
    expect(dialog.querySelector(".source-task")).toBeNull();
  });

  it("drops a result that arrives after the thread was closed", async () => {
    let finish;
    const onCreateTaskFromSource = vi.fn(() => new Promise((resolveCreate) => { finish = resolveCreate; }));
    const onOpenTask = vi.fn();
    const { dialog } = await openStewardThread({ onCreateTaskFromSource, onOpenTask });
    const older = within(dialog).getByText("PRIVATE earliest note 509").closest("article");
    fireEvent.click(within(older).getByRole("button", { name: "Create task" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    // The dialog keeps its exit transition (300 ms) before the desk unmounts it.
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull(), { timeout: 2000 });
    await act(async () => finish({ task: { id: "task-old", taskNumber: 7 }, created: true }));
    expect(document.body.textContent).not.toContain("Task created");
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("sets a reminder on the exact older message, not the newest", async () => {
    const { api, dialog } = await openStewardThread({ onCreateTaskFromSource: vi.fn() });
    const older = within(dialog).getByText("PRIVATE earliest note 509").closest("article");
    const remindAt = chooseReminder(older);
    await waitFor(() => expect(api.remind).toHaveBeenCalledWith("private", "m-old", remindAt));
    expect(api.remind).toHaveBeenCalledTimes(1);
  });
});

describe("no latest-message task shortcut remains", () => {
  it.each(["src/views/MessagesView.jsx", "src/views/StewardView.jsx"])("%s carries no latestMemberMessage and still names the message source", (path) => {
    const source = readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
    expect(source).not.toContain("latestMemberMessage");
    expect(source).toContain('sourceKind="message"');
    expect(source).toContain("canOfferSourceTask(message)");
  });
});
