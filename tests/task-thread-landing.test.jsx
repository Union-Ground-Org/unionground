import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";

// REQ-UG-CONNECTED-WORKFLOW-SHORTCUTS-20260928, second wave. The server's
// task-discussion route is /m/messages?taskThread=<uuid>[&message=<id>] (the older
// ?task= stays as an alias). The board's newest-500 window is not proof that a task
// or one of its messages is absent, so a link the loaded data cannot satisfy is
// asked of messagingApi.loadTaskLanding({ taskId, messageId }) -> { task, messages }
// (or nothing when unavailable). What comes back is checked against the reader and
// the link, merged into place, and focused once; a source that is gone or refused
// says so; an answer nobody wants any more changes nothing.

let scrollIntoView;
beforeEach(() => {
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  delete Element.prototype.scrollIntoView;
  window.history.replaceState({}, "", "/m");
});

const tick = (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const refusal = (code) => Object.assign(new Error("refused"), { code });
const bodiesIn = (scope) => [...scope.querySelectorAll("article p")].map((node) => node.textContent);

const COLD_TASK = "3f0c1f6e-7a52-4c3e-9a55-2f1f4f0f7a10";
const COLD_MESSAGE = "8d5b0f4a-1d1c-4e0a-b7a1-6a8f0d5c2b11";

function boardData() {
  return {
    member: { id: "member-1" },
    conversations: [{
      id: "conv-1", counterpartRole: "steward", sender: "Chapter steward", initials: "CS", preview: "A steward note", dateLabel: "Jul 12", unread: 0,
      messages: [{ id: "m-1", sender_kind: "steward", sender_name: "Chapter steward", body: "A steward note", created_at: "2026-07-12T11:00:00.000Z" }],
    }],
    broadcasts: [],
    product: { spaces: [], documents: [] },
    tasks: [{ id: "task-1", title: "Translate member notice", status: "in_progress" }],
    taskMessages: [
      { id: "tm-1", taskId: "task-1", senderId: "member-1", recipientId: "steward-1", body: "Draft is ready", createdAt: "2026-08-12T12:00:00Z" },
      { id: "tm-2", taskId: "task-1", senderId: "steward-1", recipientId: "member-1", body: "Reviewed, thanks", createdAt: "2026-08-12T13:00:00Z" },
    ],
  };
}

// A task the board window never carried.
const coldTask = { id: COLD_TASK, chapterId: "chapter-1", taskNumber: 42, title: "Prepare the overtime packet", status: "in_progress" };
const coldMessage = { id: COLD_MESSAGE, taskId: COLD_TASK, chapterId: "chapter-1", senderId: "steward-1", recipientId: "member-1", body: "Please review the draft before Friday", createdAt: "2026-03-03T15:00:00.000Z" };
const coldAnswer = { task: coldTask, messages: [coldMessage] };
// A message of a task the board does carry, older than the messages it holds.
const olderMessage = { id: "tm-0", taskId: "task-1", senderId: "steward-1", recipientId: "member-1", body: "First contact from the steward", createdAt: "2026-06-01T09:00:00Z" };

function renderMessages({ url, data = boardData(), desktop = true, loadTaskLanding, messagingApi, ...props } = {}) {
  if (url) window.history.replaceState({}, "", url);
  const api = loadTaskLanding ? { ...(messagingApi ?? {}), loadTaskLanding } : messagingApi;
  const handlers = {
    onProfile: vi.fn(), onAssistant: vi.fn(), onSendMessage: vi.fn().mockResolvedValue({}),
    onReadConversation: vi.fn().mockResolvedValue(null), onReadBroadcast: vi.fn(), onOpenTopics: vi.fn(),
    ...props,
  };
  const build = (next = data) => <MessagesView data={next} desktop={desktop} messagingApi={api} {...handlers} />;
  const view = render(build());
  return { ...view, handlers, api, rebuild: build };
}

describe("the task conversation route", () => {
  it("opens a task's conversation from ?taskThread=", async () => {
    renderMessages({ url: "/m/messages?taskThread=task-1" });
    const dialog = await screen.findByRole("dialog", { name: "Translate member notice" });
    expect(bodiesIn(dialog)).toEqual(["Draft is ready", "Reviewed, thanks"]);
  });

  it("lands on the exact message named beside it, once, without asking anyone", async () => {
    const loadTaskLanding = vi.fn();
    renderMessages({ url: "/m/messages?taskThread=task-1&message=tm-1", loadTaskLanding });
    const dialog = await screen.findByRole("dialog", { name: "Translate member notice" });
    await waitFor(() => expect(within(dialog).getByText("Draft is ready").closest("article")).toHaveFocus());
    expect(within(dialog).getByText("Reviewed, thanks").closest("article")).not.toHaveAttribute("tabindex");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    await tick();
    expect(loadTaskLanding).not.toHaveBeenCalled();
  });

  it("still honours the older ?task= alias, and prefers ?taskThread= when both are present", async () => {
    const data = boardData();
    data.tasks.push({ id: "task-2", title: "Book the training room", status: "to_do" });
    data.taskMessages.push({ id: "tm-9", taskId: "task-2", senderId: "steward-1", recipientId: "member-1", body: "The room is booked", createdAt: "2026-08-13T09:00:00Z" });
    const view = renderMessages({ url: "/m/messages?task=task-1", data });
    expect(await screen.findByRole("dialog", { name: "Translate member notice" })).toBeInTheDocument();
    view.unmount();
    window.history.replaceState({}, "", "/m/messages?task=task-1&taskThread=task-2");
    renderMessages({ data });
    expect(await screen.findByRole("dialog", { name: "Book the training room" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Translate member notice" })).toBeNull();
  });

  it("opens no task that the board does not hold when the surface has no loader, and stays silent", async () => {
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}` });
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("A steward note", { selector: ".inbox-row__preview" })).toBeInTheDocument();
  });

  it("does not ask a messaging api that lacks the method", async () => {
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}`, messagingApi: { toggleReaction: vi.fn(), toggleSaved: vi.fn(), remind: vi.fn() } });
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("a task the board window never carried is hydrated, not assumed absent", () => {
  it("opens the task from the loader's answer, focuses the exact message, and asks once", async () => {
    const loadTaskLanding = vi.fn().mockResolvedValue(coldAnswer);
    const view = renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding });
    const dialog = await screen.findByRole("dialog", { name: coldTask.title });
    const article = await waitFor(() => {
      const found = within(dialog).getByText(coldMessage.body).closest("article");
      expect(found).toHaveFocus();
      return found;
    });
    expect(loadTaskLanding).toHaveBeenCalledTimes(1);
    expect(loadTaskLanding).toHaveBeenCalledWith({ taskId: COLD_TASK, messageId: COLD_MESSAGE });
    expect(scrollIntoView.mock.contexts[0]).toBe(article);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    // The board refreshes (same window, still without the task): nothing is asked again.
    view.rerender(view.rebuild());
    view.rerender(view.rebuild(boardData()));
    await tick();
    expect(loadTaskLanding).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: coldTask.title })).toBeInTheDocument();
  });

  it("titles nothing after a message body: the dialog is the task's title, and no inbox row carries the text", async () => {
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding: vi.fn().mockResolvedValue(coldAnswer) });
    const dialog = await screen.findByRole("dialog", { name: coldTask.title });
    expect(within(dialog).getByText(coldMessage.body)).toBeInTheDocument();
    for (const row of document.querySelectorAll(".inbox-row")) expect(row.textContent).not.toContain(coldMessage.body);
    expect(document.title).not.toContain(coldMessage.body);
  });

  it("merges a message older than the loaded ones into its chronological place and keeps the board's own", async () => {
    const loadTaskLanding = vi.fn().mockResolvedValue({ task: { id: "task-1", title: "Translate member notice", status: "in_progress" }, messages: [olderMessage] });
    renderMessages({ url: `/m/messages?taskThread=task-1&message=${olderMessage.id}`, loadTaskLanding });
    const dialog = await screen.findByRole("dialog", { name: "Translate member notice" });
    await waitFor(() => expect(within(dialog).getByText("First contact from the steward").closest("article")).toHaveFocus());
    expect(loadTaskLanding).toHaveBeenCalledWith({ taskId: "task-1", messageId: olderMessage.id });
    expect(bodiesIn(dialog)).toEqual(["First contact from the steward", "Draft is ready", "Reviewed, thanks"]);
  });

  it("opens an unknown task named without a message, from its bounded window, focusing nothing", async () => {
    const loadTaskLanding = vi.fn().mockResolvedValue(coldAnswer);
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}`, loadTaskLanding });
    const dialog = await screen.findByRole("dialog", { name: coldTask.title });
    expect(await within(dialog).findByText(coldMessage.body)).toBeInTheDocument();
    expect(loadTaskLanding).toHaveBeenCalledWith({ taskId: COLD_TASK, messageId: null });
    await tick();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(loadTaskLanding).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a task and message the board already holds", async () => {
    const loadTaskLanding = vi.fn();
    renderMessages({ url: "/m/messages?taskThread=task-1&message=tm-2", loadTaskLanding });
    await screen.findByRole("dialog", { name: "Translate member notice" });
    await tick();
    expect(loadTaskLanding).not.toHaveBeenCalled();
  });

  it("shows the request while it is pending, in a status the reader hears", async () => {
    const pending = deferred();
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding: vi.fn(() => pending.promise) });
    expect(await screen.findByRole("status")).toHaveTextContent("Opening the linked conversation…");
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => pending.resolve(coldAnswer));
    await screen.findByRole("dialog", { name: coldTask.title });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("works on the phone layout too", async () => {
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, desktop: false, loadTaskLanding: vi.fn().mockResolvedValue(coldAnswer) });
    const dialog = await screen.findByRole("dialog", { name: coldTask.title });
    await waitFor(() => expect(within(dialog).getByText(coldMessage.body).closest("article")).toHaveFocus());
  });

  it("hands the hydrated exact record to the common connected control", async () => {
    const seen = [];
    const renderConnectedActions = (kind, record) => { seen.push([kind, record.id, record.taskId]); return <button type="button">Actions</button>; };
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding: vi.fn().mockResolvedValue(coldAnswer), renderConnectedActions, messagingApi: { toggleReaction: vi.fn(), toggleSaved: vi.fn(), remind: vi.fn() } });
    const dialog = await screen.findByRole("dialog", { name: coldTask.title });
    const article = within(dialog).getByText(coldMessage.body).closest("article");
    expect(within(article).getByRole("button", { name: "Actions" })).toBeInTheDocument();
    expect(new Set(seen.map((row) => row.join("|")))).toEqual(new Set([`task_message|${COLD_MESSAGE}|${COLD_TASK}`]));
  });

  it("keeps a closed conversation closed across refreshes", async () => {
    const view = renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding: vi.fn().mockResolvedValue(coldAnswer) });
    const dialog = await screen.findByRole("dialog", { name: coldTask.title });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    view.rerender(view.rebuild(boardData()));
    await tick();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("a link followed while the view is already mounted", () => {
  // The app's navigate() changes the address without remounting a view that is
  // already on screen (a reminder's source link opened from Messages itself), so
  // the view applies an address that changed underneath it, once.
  const follow = (view, url) => {
    window.history.pushState({}, "", url);
    view.rerender(view.rebuild());
  };

  it("opens and hydrates the task conversation an address change names", async () => {
    const loadTaskLanding = vi.fn().mockResolvedValue(coldAnswer);
    const view = renderMessages({ url: "/m/messages", loadTaskLanding });
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
    follow(view, `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`);
    const dialog = await screen.findByRole("dialog", { name: coldTask.title });
    await waitFor(() => expect(within(dialog).getByText(coldMessage.body).closest("article")).toHaveFocus());
    expect(loadTaskLanding).toHaveBeenCalledTimes(1);
    view.rerender(view.rebuild());
    await tick();
    expect(loadTaskLanding).toHaveBeenCalledTimes(1);
  });

  it("replaces the first link with the second, dropping the first one's pending answer", async () => {
    const first = deferred();
    const loadTaskLanding = vi.fn(() => first.promise);
    const view = renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    follow(view, "/m/messages?taskThread=task-1&message=tm-2");
    const dialog = await screen.findByRole("dialog", { name: "Translate member notice" });
    await waitFor(() => expect(within(dialog).getByText("Reviewed, thanks").closest("article")).toHaveFocus());
    await act(async () => first.resolve(coldAnswer));
    await tick();
    expect(screen.getByRole("dialog", { name: "Translate member notice" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: coldTask.title })).toBeNull();
    expect(document.body.textContent).not.toContain(coldMessage.body);
    expect(loadTaskLanding).toHaveBeenCalledTimes(1);
  });

  it("takes a second link without a message over the first one's pending request and its notice", async () => {
    const first = deferred();
    const loadTaskLanding = vi.fn(() => first.promise);
    const view = renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    follow(view, "/m/messages?taskThread=task-1");
    await screen.findByRole("dialog", { name: "Translate member notice" });
    // An open dialog hides the page behind it from role queries, so ask the DOM.
    expect(document.querySelector(".inbox-empty--results")).toBeNull();
    await act(async () => first.resolve(coldAnswer));
    await tick();
    expect(screen.getByRole("dialog", { name: "Translate member notice" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(coldMessage.body);
  });

  it("opens a known conversation from a task link's neighbour, the private-message route", async () => {
    const view = renderMessages({ url: "/m/messages", loadTaskLanding: vi.fn() });
    follow(view, "/m/messages?conversation=conv-1&message=m-1");
    expect(await screen.findByText("A steward note", { selector: "article p" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("A steward note", { selector: "article p" }).closest("article")).toHaveFocus());
  });

  it("does not re-apply an address that has not changed", async () => {
    const view = renderMessages({ url: "/m/messages?taskThread=task-1", loadTaskLanding: vi.fn() });
    const dialog = await screen.findByRole("dialog", { name: "Translate member notice" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    view.rerender(view.rebuild());
    view.rerender(view.rebuild(boardData()));
    await tick();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("a task link that cannot be shown says so", () => {
  const unavailable = "That conversation is no longer available, or you no longer have access to it.";

  it.each([
    ["removed or unauthorized (nothing)", () => Promise.resolve(null)],
    ["refused with 42501", () => Promise.reject(refusal("42501"))],
    ["refused with not_authorized", () => Promise.reject(refusal("not_authorized"))],
    ["gone with source_unavailable", () => Promise.reject(refusal("source_unavailable"))],
    ["an empty answer", () => Promise.resolve({ task: null, messages: [] })],
    ["an answer for another task", () => Promise.resolve({ task: { ...coldTask, id: "task-other" }, messages: [{ ...coldMessage, taskId: "task-other" }] })],
    ["an answer that omits the named message", () => Promise.resolve({ task: coldTask, messages: [] })],
    ["an answer whose named message is not the reader's", () => Promise.resolve({ task: coldTask, messages: [{ ...coldMessage, senderId: "steward-1", recipientId: "someone-else" }] })],
  ])("names a link that is %s, without retry, and keeps the ordinary inbox", async (_label, answer) => {
    const loadTaskLanding = vi.fn(answer);
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(unavailable);
    expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(coldMessage.body);
    expect(screen.getByText("A steward note", { selector: ".inbox-row__preview" })).toBeInTheDocument();
    await tick();
    expect(loadTaskLanding).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await tick();
    expect(loadTaskLanding).toHaveBeenCalledTimes(1);
  });

  it("offers a retry for a failure that says nothing about access, and asks again only when pressed", async () => {
    const loadTaskLanding = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("connection reset"), { code: "08006" }))
      .mockResolvedValueOnce(coldAnswer);
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The linked conversation could not be loaded.");
    expect(alert).not.toHaveTextContent("connection reset");
    expect(screen.queryByRole("dialog")).toBeNull();
    await tick();
    expect(loadTaskLanding).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    const dialog = await screen.findByRole("dialog", { name: coldTask.title });
    await waitFor(() => expect(within(dialog).getByText(coldMessage.body).closest("article")).toHaveFocus());
    expect(loadTaskLanding).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads its states in Spanish", async () => {
    const es = catalogue.es;
    window.history.replaceState({}, "", `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`);
    render(<LanguageProvider lang="es"><MessagesView data={boardData()} desktop messagingApi={{ loadTaskLanding: vi.fn().mockResolvedValue(null) }} onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent(es["linkedSource.unavailable"]);
    expect(screen.getByRole("button", { name: es["linkedMessage.dismiss"] })).toBeInTheDocument();
  });
});

describe("what the loader returns is checked against this reader and this link", () => {
  it("shows only the reader's own messages of the named task, never another person's or another task's", async () => {
    const between = { id: "tm-x", taskId: COLD_TASK, senderId: "steward-1", recipientId: "steward-2", body: "Private between two other people", createdAt: "2026-03-03T14:00:00.000Z" };
    const elsewhere = { id: "tm-y", taskId: "task-other", senderId: "member-1", recipientId: "steward-1", body: "A different task's message", createdAt: "2026-03-03T14:30:00.000Z" };
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding: vi.fn().mockResolvedValue({ task: coldTask, messages: [between, coldMessage, elsewhere] }) });
    const dialog = await screen.findByRole("dialog", { name: coldTask.title });
    await waitFor(() => expect(within(dialog).getByText(coldMessage.body).closest("article")).toHaveFocus());
    expect(bodiesIn(dialog)).toEqual([coldMessage.body]);
    expect(document.body.textContent).not.toContain("Private between two other people");
    expect(document.body.textContent).not.toContain("A different task's message");
  });

  it("does not present a task the answer did not name as the requested one", async () => {
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}`, loadTaskLanding: vi.fn().mockResolvedValue({ task: { ...coldTask, id: "task-other", title: "Somebody else's task" }, messages: [] }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain("Somebody else's task");
  });
});

describe("an answer that is no longer wanted changes nothing", () => {
  it("drops a late result after the member opened another conversation by hand", async () => {
    const pending = deferred();
    const loadTaskLanding = vi.fn(() => pending.promise);
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding });
    expect(await screen.findByRole("status")).toBeInTheDocument();

    fireEvent.click(screen.getByText("A steward note", { selector: ".inbox-row__preview" }));
    expect(await screen.findByText("A steward note", { selector: "article p" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();

    await act(async () => pending.resolve(coldAnswer));
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(coldMessage.body);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(loadTaskLanding).toHaveBeenCalledTimes(1);
  });

  it("drops a late refusal after a manual open too, without a stale alert", async () => {
    const pending = deferred();
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding: vi.fn(() => pending.promise) });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    fireEvent.click(screen.getByText("A steward note", { selector: ".inbox-row__preview" }));
    await act(async () => pending.reject(refusal("42501")));
    await tick();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("A steward note", { selector: "article p" })).toBeInTheDocument();
  });

  it("drops a late result after the signed-in member changed, and shows the next member nothing of it", async () => {
    const pending = deferred();
    const loadTaskLanding = vi.fn(() => pending.promise);
    const view = renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    const next = boardData();
    next.member = { id: "member-2" };
    view.rerender(view.rebuild(next));
    await act(async () => pending.resolve(coldAnswer));
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.body.textContent).not.toContain(coldMessage.body);
    expect(loadTaskLanding).toHaveBeenCalledTimes(1);
  });

  it("clears what it hydrated for one member when another signs in", async () => {
    const view = renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding: vi.fn().mockResolvedValue(coldAnswer) });
    await screen.findByRole("dialog", { name: coldTask.title });
    const next = boardData();
    next.member = { id: "member-2" };
    view.rerender(view.rebuild(next));
    await tick();
    expect(document.body.textContent).not.toContain(coldMessage.body);
    expect(screen.queryByRole("dialog", { name: coldTask.title })).toBeNull();
  });

  it("drops a late answer once the notice was dismissed", async () => {
    const first = deferred();
    const loadTaskLanding = vi.fn().mockReturnValueOnce(first.promise);
    renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    // The loading status has no dismiss; a failed one does. Make the request fail, then dismiss it.
    await act(async () => first.reject(Object.assign(new Error("offline"), { code: "08006" })));
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    await tick();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(loadTaskLanding).toHaveBeenCalledTimes(1);
  });

  it("does nothing after the view is gone", async () => {
    const pending = deferred();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = renderMessages({ url: `/m/messages?taskThread=${COLD_TASK}&message=${COLD_MESSAGE}`, loadTaskLanding: vi.fn(() => pending.promise) });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    view.unmount();
    await act(async () => pending.resolve(coldAnswer));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
