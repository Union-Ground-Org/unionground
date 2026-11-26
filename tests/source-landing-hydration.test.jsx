import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { StewardView } from "../src/views/StewardView.jsx";

// REQ-UG-CONNECTED-WORKFLOW-SHORTCUTS-20260928. A link can name a private
// message the loaded windows do not hold: a conversation the inbox never carried,
// a thread on a later page of the steward queue, or a message older than what a
// thread has paged in. When the surface offers loadSourceLanding the exact source
// is hydrated (once), merged into what is visible and focused; a source that is
// removed, refused or unreadable says so visibly; a stale answer changes nothing.

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
const articleOf = (text, scope = screen) => scope.getByText(text, { selector: "article p" }).closest("article");
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const refusal = (code) => Object.assign(new Error("refused"), { code });
const UNAVAILABLE = "That message is no longer available, or you no longer have access to it.";
const FAILED = "The linked message could not be loaded.";
// The steward desk raises unrelated alerts of its own when an api double omits a
// panel's methods (appointments, casework), so the landing notice is found by its text.
const noticeWith = async (text) => (await screen.findByText(text)).closest('[role="alert"]');

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function messagesData() {
  return {
    member: { id: "member-1" },
    conversations: [
      {
        id: "conv-1", counterpartRole: "steward", sender: "Chapter steward", initials: "CS", preview: "Second note", dateLabel: "Jul 12", unread: 0,
        messages: [
          { id: "m-old", sender_kind: "member", sender_name: "Member", body: "First note", created_at: "2026-07-12T09:00:00.000Z" },
          { id: "m-new", sender_kind: "steward", sender_name: "Chapter steward", body: "Second note", created_at: "2026-07-12T11:00:00.000Z" },
        ],
      },
      {
        id: "conv-2", counterpartRole: "steward", sender: "Other steward", initials: "OS", preview: "Other thread", dateLabel: "Jul 11", unread: 0,
        messages: [{ id: "m-other", sender_kind: "member", sender_name: "Member", body: "Other thread", created_at: "2026-07-11T09:00:00.000Z" }],
      },
    ],
    broadcasts: [],
    product: { spaces: [], documents: [] },
    tasks: [],
    taskMessages: [],
  };
}

const ancient = { id: "m-ancient", conversation_id: "conv-1", sender_kind: "member", sender_name: "Member", body: "Very first note", created_at: "2026-01-02T09:00:00.000Z", reactions: [], saved: false, reminder: null, resource: null };
const coldConversation = {
  id: "conv-cold", counterpartRole: "steward", stewardUserId: null, sender: "Cold steward", initials: "CO", preview: "", dateLabel: "", unread: 0, scheduled: [],
  messages: [{ id: "m-cold", conversation_id: "conv-cold", sender_kind: "member", sender_name: "Member", body: "Cold link note", created_at: "2026-03-02T09:00:00.000Z", reactions: [], saved: false, reminder: null, resource: null }],
};

function renderMessages({ url, data = messagesData(), desktop = true, loadSourceLanding, messagingApi, ...props } = {}) {
  if (url) window.history.replaceState({}, "", url);
  const api = loadSourceLanding ? { ...(messagingApi ?? {}), loadSourceLanding } : messagingApi;
  const handlers = {
    onProfile: vi.fn(), onAssistant: vi.fn(), onSendMessage: vi.fn().mockResolvedValue({}),
    onReadConversation: vi.fn().mockResolvedValue(null), onReadBroadcast: vi.fn(), onOpenTopics: vi.fn(),
    ...props,
  };
  const build = (next = data) => <MessagesView data={next} desktop={desktop} messagingApi={api} {...handlers} />;
  const view = render(build());
  return { ...view, handlers, api, rebuild: build };
}

describe("Messages hydrates the exact source a link names", () => {
  it("merges a message older than the loaded thread into its place, focuses it, and asks once", async () => {
    const loadSourceLanding = vi.fn().mockResolvedValue({ conversation: null, message: ancient });
    const view = renderMessages({ url: "/m/messages?conversation=conv-1&message=m-ancient", loadSourceLanding });
    const older = await waitFor(() => {
      const article = articleOf("Very first note");
      expect(article).toHaveFocus();
      return article;
    });
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
    expect(loadSourceLanding).toHaveBeenCalledWith({ conversationId: "conv-1", messageId: "m-ancient" });
    expect(scrollIntoView.mock.contexts[0]).toBe(older);
    const order = [...document.querySelectorAll("article p")].map((node) => node.textContent);
    expect(order).toEqual(["Very first note", "First note", "Second note"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    // A later refresh of the same snapshot, and of a fresh one, never asks again.
    view.rerender(view.rebuild());
    view.rerender(view.rebuild(messagesData()));
    await tick();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
  });

  it("opens a conversation the inbox never carried, from the hydrated projection", async () => {
    const loadSourceLanding = vi.fn().mockResolvedValue({ conversation: coldConversation, message: coldConversation.messages[0] });
    renderMessages({ url: "/m/messages?conversation=conv-cold&message=m-cold", loadSourceLanding });
    const pane = await screen.findByRole("region", { name: "Message detail" });
    expect(await within(pane).findByText("Cold steward", { selector: ".inbox-detail__head-name" })).toBeInTheDocument();
    await waitFor(() => expect(articleOf("Cold link note", within(pane))).toHaveFocus());
    expect(loadSourceLanding).toHaveBeenCalledWith({ conversationId: "conv-cold", messageId: "m-cold" });
  });

  it("opens an unknown conversation named without a message, from its bounded window", async () => {
    const loadSourceLanding = vi.fn().mockResolvedValue({ conversation: coldConversation, message: null });
    renderMessages({ url: "/m/messages?conversation=conv-cold", loadSourceLanding });
    const pane = await screen.findByRole("region", { name: "Message detail" });
    expect(await within(pane).findByText("Cold link note", { selector: "article p" })).toBeInTheDocument();
    expect(loadSourceLanding).toHaveBeenCalledWith({ conversationId: "conv-cold", messageId: null });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not ask for a message the loaded thread already holds, nor for a known conversation with no message named", async () => {
    const loadSourceLanding = vi.fn();
    renderMessages({ url: "/m/messages?conversation=conv-1&message=m-old", loadSourceLanding });
    await waitFor(() => expect(articleOf("First note")).toHaveFocus());
    await tick();
    expect(loadSourceLanding).not.toHaveBeenCalled();
  });

  it("shows the request while it is pending, in a status the reader hears", async () => {
    const pending = deferred();
    renderMessages({ url: "/m/messages?conversation=conv-1&message=m-ancient", loadSourceLanding: vi.fn(() => pending.promise) });
    expect(await screen.findByRole("status")).toHaveTextContent("Opening the linked message…");
    await act(async () => pending.resolve({ conversation: null, message: ancient }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("keeps the phone dialog on the hydrated message too", async () => {
    const loadSourceLanding = vi.fn().mockResolvedValue({ conversation: coldConversation, message: coldConversation.messages[0] });
    renderMessages({ url: "/m/messages?conversation=conv-cold&message=m-cold", desktop: false, loadSourceLanding });
    const dialog = await screen.findByRole("dialog", { name: "Cold steward" });
    await waitFor(() => expect(articleOf("Cold link note", within(dialog))).toHaveFocus());
    await tick(40);
    expect(articleOf("Cold link note", within(dialog))).toHaveFocus();
  });
});

describe("a private-message link followed while the view is already mounted", () => {
  it("Messages lands on the conversation an address change names", async () => {
    const loadSourceLanding = vi.fn().mockResolvedValue({ conversation: coldConversation, message: coldConversation.messages[0] });
    const view = renderMessages({ url: "/m/messages", loadSourceLanding });
    await tick();
    expect(loadSourceLanding).not.toHaveBeenCalled();
    window.history.pushState({}, "", "/m/messages?conversation=conv-cold&message=m-cold");
    view.rerender(view.rebuild());
    const pane = await screen.findByRole("region", { name: "Message detail" });
    await waitFor(() => expect(articleOf("Cold link note", within(pane))).toHaveFocus());
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
    view.rerender(view.rebuild());
    await tick();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
  });

  it("Messages lands on a message of a conversation it already holds", async () => {
    const view = renderMessages({ url: "/m/messages" });
    window.history.pushState({}, "", "/m/messages?conversation=conv-1&message=m-old");
    view.rerender(view.rebuild());
    await waitFor(() => expect(articleOf("First note")).toHaveFocus());
  });
});

describe("Messages never restores the text of a hydrated message that was removed", () => {
  const removal = { redacted: true, message: { redacted_at: "2026-09-29T00:00:00.000Z", redaction_reason: "sender_removed" } };
  const actionsApi = () => ({ toggleReaction: vi.fn(), toggleSaved: vi.fn(), remind: vi.fn(), redactMessage: vi.fn().mockResolvedValue(removal) });

  async function removeFrom(article) {
    fireEvent.click(within(article).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(article).getByRole("button", { name: "Confirm removal" }));
  }

  it("keeps a message merged into a loaded thread removed across every refresh of the data", async () => {
    const messagingApi = actionsApi();
    const view = renderMessages({ url: "/m/messages?conversation=conv-1&message=m-ancient", loadSourceLanding: vi.fn().mockResolvedValue({ conversation: null, message: ancient }), messagingApi });
    const older = await waitFor(() => {
      const article = articleOf("Very first note");
      expect(article).toHaveFocus();
      return article;
    });
    await removeFrom(older);
    await waitFor(() => expect(messagingApi.redactMessage).toHaveBeenCalledWith("m-ancient"));
    await waitFor(() => expect(screen.queryByText("Very first note")).toBeNull());
    expect(screen.getByText("The sender removed this message.")).toBeInTheDocument();

    // Every refresh rebuilds the conversations and re-merges the hydrated copy.
    view.rerender(view.rebuild(messagesData()));
    view.rerender(view.rebuild(messagesData()));
    await tick();
    expect(document.body.textContent).not.toContain("Very first note");
    expect(screen.getByText("The sender removed this message.")).toBeInTheDocument();
  });

  it("keeps a wholly hydrated conversation's removed message removed across a refresh too", async () => {
    const messagingApi = actionsApi();
    const view = renderMessages({ url: "/m/messages?conversation=conv-cold&message=m-cold", loadSourceLanding: vi.fn().mockResolvedValue({ conversation: coldConversation, message: coldConversation.messages[0] }), messagingApi });
    const pane = await screen.findByRole("region", { name: "Message detail" });
    const article = await waitFor(() => {
      const found = articleOf("Cold link note", within(pane));
      expect(found).toHaveFocus();
      return found;
    });
    await removeFrom(article);
    await waitFor(() => expect(screen.queryByText("Cold link note")).toBeNull());
    view.rerender(view.rebuild(messagesData()));
    await tick();
    expect(document.body.textContent).not.toContain("Cold link note");
  });
});

describe("Messages says so when the source cannot be shown", () => {
  it.each([
    ["removed or unauthorized (null)", () => Promise.resolve(null)],
    ["refused with 42501", () => Promise.reject(refusal("42501"))],
    ["refused with not_authorized", () => Promise.reject(refusal("not_authorized"))],
    ["gone with source_unavailable", () => Promise.reject(refusal("source_unavailable"))],
    ["an empty answer", () => Promise.resolve({ conversation: null, message: null })],
  ])("names a link that is %s, without retry, and keeps the ordinary inbox", async (_label, answer) => {
    const loadSourceLanding = vi.fn(answer);
    renderMessages({ url: "/m/messages?conversation=conv-cold&message=m-cold", loadSourceLanding });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That message is no longer available, or you no longer have access to it.");
    expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
    // No thread opened for it, and the inbox still lists what the member can read.
    expect(screen.getByText("Other thread", { selector: ".inbox-row__preview" })).toBeInTheDocument();
    expect(document.querySelector(".inbox-detail article")).toBeNull();
    await tick();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await tick();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
  });

  it("offers a retry for a failure that says nothing about access, and asks again only when pressed", async () => {
    const loadSourceLanding = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("connection reset"), { code: "08006" }))
      .mockResolvedValueOnce({ conversation: coldConversation, message: coldConversation.messages[0] });
    renderMessages({ url: "/m/messages?conversation=conv-cold&message=m-cold", loadSourceLanding });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The linked message could not be loaded.");
    expect(alert).not.toHaveTextContent("connection reset");
    await tick();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(articleOf("Cold link note")).toHaveFocus());
    expect(loadSourceLanding).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads its states in Spanish", async () => {
    const es = catalogue.es;
    window.localStorage.setItem("unionground:lang", "es");
    const loadSourceLanding = vi.fn().mockResolvedValue(null);
    const { LanguageProvider } = await import("../src/lib/LanguageContext.jsx");
    window.history.replaceState({}, "", "/m/messages?conversation=conv-cold&message=m-cold");
    render(<LanguageProvider lang="es"><MessagesView data={messagesData()} desktop messagingApi={{ loadSourceLanding }} onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent(es["linkedMessage.unavailable"]);
    expect(screen.getByRole("button", { name: es["linkedMessage.dismiss"] })).toBeInTheDocument();
    window.localStorage.removeItem("unionground:lang");
  });
});

describe("Messages ignores an answer that is no longer wanted", () => {
  it("drops a late result after the member opened another conversation by hand", async () => {
    const pending = deferred();
    const loadSourceLanding = vi.fn(() => pending.promise);
    renderMessages({ url: "/m/messages?conversation=conv-1&message=m-ancient", loadSourceLanding });
    expect(await screen.findByRole("status")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Other thread", { selector: ".inbox-row__preview" }));
    expect(await screen.findByText("Other thread", { selector: "article p" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();

    await act(async () => pending.resolve({ conversation: null, message: ancient }));
    await tick();
    expect(screen.queryByText("Very first note")).toBeNull();
    expect(screen.getByText("Other thread", { selector: "article p" })).toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);

    // The dropped answer was not kept for later: the conversation it named still
    // reads as loaded, with no merged message and no pull to a stale row.
    fireEvent.click(screen.getByText("Second note", { selector: ".inbox-row__preview" }));
    await screen.findByText("First note", { selector: "article p" });
    await tick();
    expect(screen.queryByText("Very first note")).toBeNull();
    expect([...document.querySelectorAll("article p")].map((node) => node.textContent)).toEqual(["First note", "Second note"]);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("drops a late refusal after a manual open too, without a stale alert", async () => {
    const pending = deferred();
    renderMessages({ url: "/m/messages?conversation=conv-cold&message=m-cold", loadSourceLanding: vi.fn(() => pending.promise) });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Other thread", { selector: ".inbox-row__preview" }));
    await act(async () => pending.reject(refusal("42501")));
    await tick();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Other thread", { selector: "article p" })).toBeInTheDocument();
  });

  it("does not reopen a conversation the member closed while it was loading", async () => {
    const pending = deferred();
    renderMessages({ url: "/m/messages?conversation=conv-cold&message=m-cold", desktop: false, loadSourceLanding: vi.fn(() => pending.promise) });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    await act(async () => pending.resolve({ conversation: coldConversation, message: coldConversation.messages[0] }));
    const dialog = await screen.findByRole("dialog", { name: "Cold steward" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await tick();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does nothing after the view is gone", async () => {
    const pending = deferred();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = renderMessages({ url: "/m/messages?conversation=conv-cold&message=m-cold", loadSourceLanding: vi.fn(() => pending.promise) });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    view.unmount();
    await act(async () => pending.resolve({ conversation: coldConversation, message: coldConversation.messages[0] }));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("Messages keeps surfaces without a loader as they were", () => {
  it("leaves an unknown conversation link silent and opens nothing", async () => {
    renderMessages({ url: "/m/messages?conversation=conv-cold&message=m-cold" });
    await tick();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector(".inbox-detail article")).toBeNull();
    expect(screen.getByText("Other thread", { selector: ".inbox-row__preview" })).toBeInTheDocument();
  });

  it("does not call a loader that a messaging api without the method lacks", async () => {
    renderMessages({ url: "/m/messages?conversation=conv-1&message=m-ancient", messagingApi: { toggleReaction: vi.fn(), toggleSaved: vi.fn(), remind: vi.fn() } });
    await tick();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Very first note")).toBeNull();
  });
});

describe("Messages opens a task conversation from ?task=", () => {
  function taskData() {
    const data = messagesData();
    data.tasks = [{ id: "task-1", title: "Translate member notice", status: "in_progress" }];
    data.taskMessages = [
      { id: "tm-1", taskId: "task-1", senderId: "member-1", recipientId: "steward-1", body: "Draft is ready", createdAt: "2026-08-12T12:00:00Z" },
      { id: "tm-2", taskId: "task-1", senderId: "steward-1", recipientId: "member-1", body: "Reviewed, thanks", createdAt: "2026-08-12T13:00:00Z" },
    ];
    return data;
  }

  it("opens that task's conversation", async () => {
    renderMessages({ url: "/m/messages?task=task-1", data: taskData() });
    const dialog = await screen.findByRole("dialog", { name: "Translate member notice" });
    expect(within(dialog).getByText("Draft is ready")).toBeInTheDocument();
  });

  it("lands on a task message when one is named", async () => {
    renderMessages({ url: "/m/messages?task=task-1&message=tm-1", data: taskData() });
    const dialog = await screen.findByRole("dialog", { name: "Translate member notice" });
    await waitFor(() => expect(within(dialog).getByText("Draft is ready").closest("article")).toHaveFocus());
    expect(within(dialog).getByText("Reviewed, thanks").closest("article")).not.toHaveAttribute("tabindex");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("ignores a task this member cannot see", async () => {
    renderMessages({ url: "/m/messages?task=task-unknown", data: taskData() });
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The steward desk
// ---------------------------------------------------------------------------

function stewardDesk() {
  return {
    queue: [],
    threads: [
      {
        id: "conv-1", memberName: "Renata Cole", memberInitials: "RC", preview: "Newest from Renata", updatedAt: "2026-07-21T09:00:00Z", awaitingReply: true,
        messages: [{ id: "m-new", sender_kind: "member", sender_name: "Renata Cole", body: "Newest from Renata", created_at: "2026-07-21T09:00:00Z" }],
      },
      {
        id: "conv-2", memberName: "Devon Pratt", memberInitials: "DP", preview: "Devon asks about a shift", updatedAt: "2026-07-20T09:00:00Z", awaitingReply: false,
        messages: [{ id: "m-devon", sender_kind: "member", sender_name: "Devon Pratt", body: "Devon asks about a shift", created_at: "2026-07-20T09:00:00Z" }],
      },
    ],
    broadcasts: [],
    formsInbox: [],
    kpis: { openRequests: 0, membersCovered: 2, awaitingReply: 1, broadcasts30d: 0 },
  };
}

const oldMessage = { id: "m-old", sender_kind: "member", sender_name: "Renata Cole", body: "Earliest from Renata", created_at: "2026-05-01T08:00:00Z", reactions: [], saved: false, reminder: null, resource: null };
const coldThread = { id: "conv-cold", memberName: "Cold Member", memberInitials: "CM", preview: "", updatedAt: "2026-03-02T09:00:00.000Z", awaitingReply: false, messageCount: 0 };
const coldMessage = { id: "m-cold", sender_kind: "member", sender_name: "Cold Member", body: "Cold desk note", created_at: "2026-03-02T09:00:00Z", reactions: [], saved: false, reminder: null, resource: null };

const openCase = {
  id: "case-a", subjectUserId: "member-a", memberName: "Renata Cole", memberInitials: "RC", reference: "GRV-2026-014", title: "Mandated overtime without notice",
  caseType: "Grievance", articles: "Art. 21 §3", step: "Step 2", status: "active", deadline: "2026-10-15", updatedAt: "2026-09-20T12:00:00Z",
  assignedAt: "2026-09-18T09:00:00Z", coordinatorName: "Dana Ortiz", updates: [], updatesTotal: 0,
};

function stewardApi(extra = {}) {
  return {
    loadDesk: vi.fn(async () => structuredClone(stewardDesk())),
    toggleReaction: vi.fn().mockResolvedValue({ reacted: true }),
    toggleSaved: vi.fn().mockResolvedValue({ saved: true }),
    remind: vi.fn().mockResolvedValue({ id: "reminder-1" }),
    listScheduled: vi.fn().mockResolvedValue([]),
    ...extra,
  };
}

// The pager returns only the newest message and advertises an earlier page.
const windowedPager = () => vi.fn(async (id, opts = {}) => {
  if (id !== "conv-1") return { messages: id === "conv-cold" ? [] : stewardDesk().threads[1].messages, earlierCursor: null, total: id === "conv-cold" ? 5 : 1 };
  return opts.cursor
    ? { messages: [oldMessage], earlierCursor: null, total: 2 }
    : { messages: stewardDesk().threads[0].messages, earlierCursor: "cursor-1", total: 2 };
});

function renderDesk(api, url) {
  if (url) window.history.replaceState({}, "", url);
  return render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} />);
}

describe("the steward desk hydrates the exact source a link names", () => {
  it("opens a thread the queue never loaded, and merges the named message into its history", async () => {
    const loadSourceLanding = vi.fn().mockResolvedValue({ thread: coldThread, message: coldMessage });
    const loadThreadMessages = windowedPager();
    renderDesk(stewardApi({ loadSourceLanding, loadThreadMessages }), "/m/steward?thread=conv-cold&message=m-cold");
    const dialog = await screen.findByRole("dialog", { name: "Cold Member" });
    await waitFor(() => expect(within(dialog).getByText("Cold desk note").closest("article")).toHaveFocus());
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
    expect(loadSourceLanding).toHaveBeenCalledWith({ conversationId: "conv-cold", messageId: "m-cold" });
    expect(loadThreadMessages).toHaveBeenCalledWith("conv-cold");
    await tick();
    // The dialog did not ask again for what the desk already carried.
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
  });

  it("fetches a message older than the newest window of a known thread and keeps the pager's own cursor", async () => {
    const loadSourceLanding = vi.fn().mockResolvedValue({ thread: null, message: oldMessage });
    const loadThreadMessages = windowedPager();
    renderDesk(stewardApi({ loadSourceLanding, loadThreadMessages }), "/m/steward?thread=conv-1&message=m-old");
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    await waitFor(() => expect(within(dialog).getByText("Earliest from Renata").closest("article")).toHaveFocus());
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
    expect(loadSourceLanding).toHaveBeenCalledWith({ conversationId: "conv-1", messageId: "m-old" });
    expect([...dialog.querySelectorAll("article p")].map((node) => node.textContent)).toEqual(["Earliest from Renata", "Newest from Renata"]);

    // "Load earlier" still walks the pager from ITS cursor, and the page that
    // carries the same message does not show it twice.
    fireEvent.click(within(dialog).getByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(loadThreadMessages).toHaveBeenCalledWith("conv-1", { cursor: "cursor-1" }));
    await tick();
    expect([...dialog.querySelectorAll("article p")].map((node) => node.textContent)).toEqual(["Earliest from Renata", "Newest from Renata"]);
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
  });

  it("does not hydrate a thread the desk's first page already carries, nor a message the window already holds", async () => {
    const loadSourceLanding = vi.fn();
    renderDesk(stewardApi({ loadSourceLanding, loadThreadMessages: windowedPager() }), "/m/steward?thread=conv-1&message=m-new");
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    await waitFor(() => expect(within(dialog).getByText("Newest from Renata").closest("article")).toHaveFocus());
    await tick();
    expect(loadSourceLanding).not.toHaveBeenCalled();
  });

  it("does not ask again when the desk reloads behind the dialog", async () => {
    const loadSourceLanding = vi.fn().mockResolvedValue({ thread: coldThread, message: coldMessage });
    const api = stewardApi({
      loadSourceLanding,
      loadThreadMessages: windowedPager(),
      loadDesk: vi.fn(async () => ({ ...structuredClone(stewardDesk()), queue: [{ id: "req-1", memberName: "Renata Cole", memberInitials: "RC", lessonLabel: "", status: "requested", createdAt: "2026-07-20T14:00:00Z" }] })),
      triage: vi.fn().mockResolvedValue({}),
    });
    renderDesk(api, "/m/steward?thread=conv-cold&message=m-cold");
    await screen.findByRole("dialog", { name: "Cold Member" });
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge", hidden: true }));
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));
    await tick();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
  });
});

describe("a steward link followed while the desk is already mounted", () => {
  // As in the app, the handlers and the member object keep their identity across
  // renders, so only the address itself can tell the desk that a link arrived.
  const onNotice = () => {};
  const member = { id: "steward-1", initials: "SO" };
  const data = { member };
  const desk = (api) => <StewardView data={data} api={api} onNotice={onNotice} />;

  it("opens the thread an address change names and hydrates its message", async () => {
    const loadSourceLanding = vi.fn().mockResolvedValue({ thread: coldThread, message: coldMessage });
    const api = stewardApi({ loadSourceLanding, loadThreadMessages: windowedPager() });
    window.history.replaceState({}, "", "/m/steward");
    const view = render(desk(api));
    await screen.findByText("Newest from Renata");
    expect(screen.queryByRole("dialog")).toBeNull();
    window.history.pushState({}, "", "/m/steward?thread=conv-cold&message=m-cold");
    view.rerender(desk(api));
    const dialog = await screen.findByRole("dialog", { name: "Cold Member" });
    await waitFor(() => expect(within(dialog).getByText("Cold desk note").closest("article")).toHaveFocus());
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
    view.rerender(desk(api));
    await tick();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
  });

  it("takes a second link over the first one's pending hydration and its notice", async () => {
    const pending = deferred();
    const loadSourceLanding = vi.fn(() => pending.promise);
    const api = stewardApi({ loadSourceLanding, loadThreadMessages: windowedPager() });
    window.history.replaceState({}, "", "/m/steward?thread=conv-cold&message=m-cold");
    const view = render(desk(api));
    expect(await screen.findByText("Opening the linked message…")).toBeInTheDocument();
    window.history.pushState({}, "", "/m/steward?thread=conv-1&message=m-new");
    view.rerender(desk(api));
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    await waitFor(() => expect(within(dialog).getByText("Newest from Renata").closest("article")).toHaveFocus());
    expect(screen.queryByText("Opening the linked message…")).toBeNull();
    await act(async () => pending.resolve({ thread: coldThread, message: coldMessage }));
    await tick();
    expect(screen.getByRole("dialog", { name: "Renata Cole" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Cold Member" })).toBeNull();
  });

  it("lands on another message of the thread that is already open", async () => {
    const loadSourceLanding = vi.fn().mockResolvedValue({ thread: null, message: oldMessage });
    const api = stewardApi({ loadSourceLanding, loadThreadMessages: windowedPager() });
    window.history.replaceState({}, "", "/m/steward?thread=conv-1&message=m-new");
    const view = render(desk(api));
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    await waitFor(() => expect(within(dialog).getByText("Newest from Renata").closest("article")).toHaveFocus());
    window.history.pushState({}, "", "/m/steward?thread=conv-1&message=m-old");
    view.rerender(desk(api));
    await waitFor(() => expect(within(dialog).getByText("Earliest from Renata").closest("article")).toHaveFocus());
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
    expect(loadSourceLanding).toHaveBeenCalledWith({ conversationId: "conv-1", messageId: "m-old" });
  });
});

describe("the steward desk never restores the text of a hydrated message that was removed", () => {
  it("empties the hydrated copy along with the row on screen", async () => {
    const redactMessage = vi.fn().mockResolvedValue({ redacted: true, message: { redacted_at: "2026-09-29T00:00:00.000Z", redaction_reason: "staff_removed" } });
    const loadSourceLanding = vi.fn().mockResolvedValue({ thread: null, message: oldMessage });
    renderDesk(stewardApi({ loadSourceLanding, loadThreadMessages: windowedPager(), redactMessage }), "/m/steward?thread=conv-1&message=m-old");
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    const older = await waitFor(() => {
      const article = within(dialog).getByText("Earliest from Renata").closest("article");
      expect(article).toHaveFocus();
      return article;
    });
    fireEvent.click(within(older).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(older).getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(redactMessage).toHaveBeenCalledWith("m-old"));
    await waitFor(() => expect(within(dialog).queryByText("Earliest from Renata")).toBeNull());
    await tick();
    expect(document.body.textContent).not.toContain("Earliest from Renata");
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
  });
});

describe("the steward desk says so when the source cannot be shown", () => {
  it.each([
    ["removed or unauthorized (null)", () => Promise.resolve(null)],
    ["refused with 42501", () => Promise.reject(refusal("42501"))],
    ["gone with source_unavailable", () => Promise.reject(refusal("source_unavailable"))],
    ["a thread-less answer", () => Promise.resolve({ thread: null, message: null })],
  ])("names a thread link that is %s and opens nothing", async (_label, answer) => {
    const loadSourceLanding = vi.fn(answer);
    renderDesk(stewardApi({ loadSourceLanding, loadThreadMessages: windowedPager() }), "/m/steward?thread=conv-cold&message=m-cold");
    const alert = await noticeWith(UNAVAILABLE);
    expect(alert).toHaveTextContent(UNAVAILABLE);
    expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The desk itself is still there.
    expect(screen.getByText("Newest from Renata")).toBeInTheDocument();
    await tick();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });

  it("offers a retry for an unexplained failure and opens the thread when it works", async () => {
    const loadSourceLanding = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("gateway timeout"), { code: "57014" }))
      .mockResolvedValueOnce({ thread: coldThread, message: coldMessage });
    renderDesk(stewardApi({ loadSourceLanding, loadThreadMessages: windowedPager() }), "/m/steward?thread=conv-cold&message=m-cold");
    const alert = await noticeWith(FAILED);
    expect(alert).not.toHaveTextContent("gateway timeout");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByRole("dialog", { name: "Cold Member" });
    expect(loadSourceLanding).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it("names an unreadable message inside a thread that opened normally", async () => {
    const loadSourceLanding = vi.fn().mockResolvedValue({ thread: null, message: null });
    renderDesk(stewardApi({ loadSourceLanding, loadThreadMessages: windowedPager() }), "/m/steward?thread=conv-1&message=m-old");
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("That message is no longer available, or you no longer have access to it.");
    expect(within(dialog).getByText("Newest from Renata", { selector: "article p" })).toBeInTheDocument();
    for (const article of dialog.querySelectorAll("article")) expect(article).not.toHaveAttribute("tabindex");
    await tick();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
  });

  it("retries a failed message fetch inside the dialog only when pressed", async () => {
    const loadSourceLanding = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "08006" }))
      .mockResolvedValueOnce({ thread: null, message: oldMessage });
    renderDesk(stewardApi({ loadSourceLanding, loadThreadMessages: windowedPager() }), "/m/steward?thread=conv-1&message=m-old");
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("The linked message could not be loaded.");
    await tick();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(dialog).getByText("Earliest from Renata").closest("article")).toHaveFocus());
    expect(loadSourceLanding).toHaveBeenCalledTimes(2);
  });
});

describe("the steward desk ignores an answer that is no longer wanted", () => {
  it("drops a late thread hydration after the steward opened a thread by hand", async () => {
    const pending = deferred();
    const loadSourceLanding = vi.fn(() => pending.promise);
    renderDesk(stewardApi({ loadSourceLanding, loadThreadMessages: windowedPager() }), "/m/steward?thread=conv-cold&message=m-cold");
    expect(await screen.findByText("Opening the linked message…")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Devon asks about a shift").closest("button"));
    const manual = await screen.findByRole("dialog", { name: "Devon Pratt" });
    expect(screen.queryByText("Opening the linked message…")).toBeNull();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    await act(async () => pending.resolve({ thread: coldThread, message: coldMessage }));
    await tick();
    expect(screen.getByRole("dialog", { name: "Devon Pratt" })).toBe(manual);
    expect(screen.queryByRole("dialog", { name: "Cold Member" })).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
  });

  it("does not open the hydrated thread over a case the steward has since opened", async () => {
    const pending = deferred();
    const loadSourceLanding = vi.fn(() => pending.promise);
    renderDesk(
      stewardApi({ loadSourceLanding, loadThreadMessages: windowedPager(), loadDesk: vi.fn(async () => ({ ...structuredClone(stewardDesk()), caseload: [openCase] })) }),
      "/m/steward?thread=conv-cold&message=m-cold&case=case-a",
    );
    const caseDialog = await screen.findByRole("dialog", { name: /GRV-2026-014/ });
    expect(await screen.findByText("Opening the linked message…")).toBeInTheDocument();
    await act(async () => pending.resolve({ thread: coldThread, message: coldMessage }));
    await tick();
    expect(screen.getByRole("dialog", { name: /GRV-2026-014/ })).toBe(caseDialog);
    expect(screen.queryByRole("dialog", { name: "Cold Member" })).toBeNull();
    expect(screen.queryByText("Opening the linked message…")).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("drops a late refusal after a manual open without leaving a stale alert", async () => {
    const pending = deferred();
    renderDesk(stewardApi({ loadSourceLanding: vi.fn(() => pending.promise), loadThreadMessages: windowedPager() }), "/m/steward?thread=conv-cold&message=m-cold");
    await screen.findByText("Devon asks about a shift");
    fireEvent.click(screen.getByText("Devon asks about a shift").closest("button"));
    await screen.findByRole("dialog", { name: "Devon Pratt" });
    await act(async () => pending.reject(refusal("42501")));
    await tick();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });

  it("drops a late message answer after the thread dialog was closed", async () => {
    const pending = deferred();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    renderDesk(stewardApi({ loadSourceLanding: vi.fn(() => pending.promise), loadThreadMessages: windowedPager() }), "/m/steward?thread=conv-1&message=m-old");
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    await within(dialog).findByRole("status");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await act(async () => pending.resolve({ thread: null, message: oldMessage }));
    await tick();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("leaves a desk without the loader exactly as before", async () => {
    renderDesk(stewardApi({ loadThreadMessages: windowedPager() }), "/m/steward?thread=conv-cold&message=m-cold");
    await screen.findByText("Newest from Renata");
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.queryByText("Opening the linked message…")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The reader the answer was asked as
// ---------------------------------------------------------------------------

describe("a hydrated private message belongs to the reader it was fetched for", () => {
  const asMember = (id) => ({ ...messagesData(), member: { id } });

  it("Messages does not ask again for the previous member's link when the signed-in member changes, and drops the late answer", async () => {
    const pending = deferred();
    const loadSourceLanding = vi.fn(() => pending.promise);
    const view = renderMessages({ url: "/m/messages?conversation=conv-cold&message=m-cold", data: asMember("member-1"), loadSourceLanding });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    view.rerender(view.rebuild(asMember("member-2")));
    await act(async () => pending.resolve({ conversation: coldConversation, message: coldConversation.messages[0] }));
    await tick();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.body.textContent).not.toContain("Cold link note");
    expect(document.querySelector(".inbox-detail article")).toBeNull();
  });

  it("Messages shows the next member nothing it hydrated for the previous one", async () => {
    const loadSourceLanding = vi.fn().mockResolvedValue({ conversation: coldConversation, message: coldConversation.messages[0] });
    const view = renderMessages({ url: "/m/messages?conversation=conv-cold&message=m-cold", data: asMember("member-1"), loadSourceLanding });
    await screen.findByText("Cold link note", { selector: "article p" });
    view.rerender(view.rebuild(asMember("member-2")));
    await tick();
    expect(document.body.textContent).not.toContain("Cold link note");
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
  });

  it("the steward dialog does not ask again for the previous steward's message when the signed-in steward changes, and drops the late answer", async () => {
    const pending = deferred();
    const loadSourceLanding = vi.fn(() => pending.promise);
    const api = stewardApi({ loadSourceLanding, loadThreadMessages: windowedPager() });
    window.history.replaceState({}, "", "/m/steward?thread=conv-1&message=m-old");
    const view = render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    await within(dialog).findByRole("status");
    // A new sign-in brings its own api object.
    view.rerender(<StewardView data={{ member: { id: "steward-2", initials: "SO" } }} api={{ ...api }} onNotice={() => {}} />);
    await act(async () => pending.resolve({ thread: null, message: oldMessage }));
    await tick();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Earliest from Renata");
  });

  it("the steward desk shows the next steward nothing it hydrated for the previous one", async () => {
    const loadSourceLanding = vi.fn().mockResolvedValue({ thread: coldThread, message: coldMessage });
    const api = stewardApi({ loadSourceLanding, loadThreadMessages: windowedPager() });
    window.history.replaceState({}, "", "/m/steward?thread=conv-cold&message=m-cold");
    const view = render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} />);
    await screen.findByRole("dialog", { name: "Cold Member" });
    view.rerender(<StewardView data={{ member: { id: "steward-2", initials: "SO" } }} api={{ ...api }} onNotice={() => {}} />);
    await tick();
    expect(document.body.textContent).not.toContain("Cold desk note");
    expect(screen.queryByRole("dialog", { name: "Cold Member" })).toBeNull();
    expect(loadSourceLanding).toHaveBeenCalledTimes(1);
  });
});
