import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { StewardView } from "../src/views/StewardView.jsx";

// REQ-UG-CONNECTED-WORKFLOW-SHORTCUTS-20260928. A task or reminder made from
// one exact message has to be able to come back to that message, not only to its
// conversation: `?conversation=<id>&message=<id>` in Messages and
// `?thread=<id>&message=<id>` on the steward desk. The named message is focused
// (and scrolled to) once; anything the reader does by hand ends the instruction.

let scrollIntoView;
beforeEach(() => {
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  delete Element.prototype.scrollIntoView;
  window.history.replaceState({}, "", "/m");
});

const articleOf = (text) => screen.getByText(text, { selector: "article p" }).closest("article");

function messagesData() {
  return {
    member: { id: "member-1" },
    conversations: [
      {
        id: "conv-1", counterpartRole: "steward", sender: "Chapter steward", initials: "CS", preview: "Second note", dateLabel: "Jul 12", unread: 0,
        messages: [
          { id: "m-old", sender_kind: "member", sender_name: "Member", body: "First note", created_at: "2026-07-12T09:00:00.000Z" },
          { id: "m-steward", sender_kind: "steward", sender_name: "Chapter steward", body: "Noted, thanks", created_at: "2026-07-12T10:00:00.000Z" },
          { id: "m-new", sender_kind: "member", sender_name: "Member", body: "Second note", created_at: "2026-07-12T11:00:00.000Z" },
        ],
      },
      {
        id: "conv-2", counterpartRole: "steward", sender: "Other steward", initials: "OS", preview: "Other thread", dateLabel: "Jul 11", unread: 0,
        messages: [{ id: "m-other", sender_kind: "member", sender_name: "Member", body: "Other thread", created_at: "2026-07-11T09:00:00.000Z" }],
      },
    ],
    broadcasts: [],
    product: { spaces: [], documents: [] },
  };
}

function renderMessages({ url, data = messagesData(), desktop = true, ...props } = {}) {
  if (url) window.history.replaceState({}, "", url);
  const handlers = {
    onProfile: vi.fn(), onAssistant: vi.fn(), onSendMessage: vi.fn().mockResolvedValue({}),
    onReadConversation: vi.fn().mockResolvedValue(null), onReadBroadcast: vi.fn(), onOpenTopics: vi.fn(),
    ...props,
  };
  return { ...render(<MessagesView data={data} desktop={desktop} {...handlers} />), handlers };
}

describe("Messages lands on the exact message a link names", () => {
  it("focuses and scrolls to an older message, and only that one", async () => {
    renderMessages({ url: "/m/messages?conversation=conv-1&message=m-old" });
    const older = await waitFor(() => {
      const article = articleOf("First note");
      expect(article).toHaveFocus();
      return article;
    });
    expect(older).toHaveAttribute("tabindex", "-1");
    expect(articleOf("Second note")).not.toHaveAttribute("tabindex");
    expect(articleOf("Noted, thanks")).not.toHaveAttribute("tabindex");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(older);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("does the same for a search hit that names a message", async () => {
    renderMessages({ focus: { conversationId: "conv-1", messageId: "m-steward" } });
    await waitFor(() => expect(articleOf("Noted, thanks")).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("lands once: a later refresh of the thread does not pull the reader back", async () => {
    const data = messagesData();
    const view = renderMessages({ url: "/m/messages?conversation=conv-1&message=m-old", data });
    await waitFor(() => expect(articleOf("First note")).toHaveFocus());
    const composer = screen.getByLabelText("Write a message…");
    composer.focus();
    expect(composer).toHaveFocus();

    const refreshed = messagesData();
    refreshed.conversations[0].messages = [
      ...refreshed.conversations[0].messages,
      { id: "m-later", sender_kind: "steward", sender_name: "Chapter steward", body: "One more thing", created_at: "2026-07-12T12:00:00.000Z" },
    ];
    await act(async () => view.rerender(<MessagesView data={refreshed} desktop {...view.handlers} />));
    expect(await screen.findByText("One more thing", { selector: "article p" })).toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(composer).toHaveFocus();
  });

  it("opens the conversation and leaves everything alone when the message is not in it", async () => {
    renderMessages({ url: "/m/messages?conversation=conv-1&message=m-missing" });
    await screen.findByRole("region", { name: "Message detail" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(scrollIntoView).not.toHaveBeenCalled();
    for (const article of document.querySelectorAll("article")) expect(article).not.toHaveAttribute("tabindex");
  });

  it("names no message for a conversation the member cannot see", async () => {
    renderMessages({ url: "/m/messages?conversation=conv-unknown&message=m-old" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByRole("region", { name: "Message detail" })).toBeInTheDocument();
    expect(screen.queryByText("First note", { selector: "article p" })).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("ends the instruction when the reader opens anything by hand", async () => {
    renderMessages({ url: "/m/messages?conversation=conv-1&message=m-old" });
    await waitFor(() => expect(articleOf("First note")).toHaveFocus());
    fireEvent.click(screen.getByText("Other thread", { selector: ".inbox-row__preview" }));
    expect(await screen.findByText("Other thread", { selector: "article p" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Second note", { selector: ".inbox-row__preview" }));
    await screen.findByText("First note", { selector: "article p" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(articleOf("First note")).not.toHaveAttribute("tabindex");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("keeps the focus on the message in the phone dialog, whose heading also asks for it", async () => {
    renderMessages({ url: "/m/messages?conversation=conv-1&message=m-old", desktop: false });
    const dialog = await screen.findByRole("dialog", { name: "Chapter steward" });
    await waitFor(() => expect(within(dialog).getByText("First note", { selector: "article p" }).closest("article")).toHaveFocus());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(within(dialog).getByText("First note", { selector: "article p" }).closest("article")).toHaveFocus();
  });
});

function stewardDesk() {
  return {
    queue: [],
    threads: [
      {
        id: "conv-1", memberName: "Renata Cole", memberInitials: "RC", preview: "Newest from Renata", updatedAt: "2026-07-21T09:00:00Z", awaitingReply: true,
        messages: [
          { id: "m-old", sender_kind: "member", sender_name: "Renata Cole", body: "Earliest from Renata", created_at: "2026-07-21T08:00:00Z" },
          { id: "m-new", sender_kind: "member", sender_name: "Renata Cole", body: "Newest from Renata", created_at: "2026-07-21T09:00:00Z" },
        ],
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

function renderDesk(api, url) {
  if (url) window.history.replaceState({}, "", url);
  return render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} />);
}

describe("the steward desk lands on the exact message a link names", () => {
  it("focuses the named older message inside the linked thread", async () => {
    renderDesk(stewardApi(), "/m/steward?thread=conv-1&message=m-old");
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    const older = await waitFor(() => {
      const article = within(dialog).getByText("Earliest from Renata").closest("article");
      expect(article).toHaveFocus();
      return article;
    });
    expect(older).toHaveAttribute("tabindex", "-1");
    expect(within(dialog).getByText("Newest from Renata").closest("article")).not.toHaveAttribute("tabindex");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(older);
  });

  it("waits for the thread's messages to load, then lands once", async () => {
    let deliver;
    const api = stewardApi({
      loadThreadMessages: vi.fn(() => new Promise((resolve) => { deliver = resolve; })),
    });
    renderDesk(api, "/m/steward?thread=conv-1&message=m-old");
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    // The thread load is requested in an effect after the dialog mounts; under
    // an instrumented or loaded runner it can trail the dialog query, so wait
    // for the request before releasing its response.
    await waitFor(() => expect(api.loadThreadMessages).toHaveBeenCalled());
    expect(scrollIntoView).not.toHaveBeenCalled();
    await act(async () => deliver({
      messages: stewardDesk().threads[0].messages, earlierCursor: null, total: 2,
    }));
    await waitFor(() => expect(within(dialog).getByText("Earliest from Renata").closest("article")).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("opens the thread and leaves it alone when the message is older than what loaded", async () => {
    const api = stewardApi({
      loadThreadMessages: vi.fn().mockResolvedValue({ messages: [stewardDesk().threads[0].messages[1]], earlierCursor: "c1", total: 2 }),
    });
    renderDesk(api, "/m/steward?thread=conv-1&message=m-old");
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    await within(dialog).findByText("Newest from Renata");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(scrollIntoView).not.toHaveBeenCalled();
    for (const article of dialog.querySelectorAll("article")) expect(article).not.toHaveAttribute("tabindex");
  });

  it("ends the instruction when the steward opens a thread by hand", async () => {
    renderDesk(stewardApi(), "/m/steward?thread=conv-1&message=m-old");
    const first = await screen.findByRole("dialog", { name: "Renata Cole" });
    await waitFor(() => expect(within(first).getByText("Earliest from Renata").closest("article")).toHaveFocus());
    fireEvent.click(within(first).getByRole("button", { name: "Close" }));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());

    fireEvent.click(screen.getByText("Devon asks about a shift").closest("button"));
    const other = await screen.findByRole("dialog", { name: "Devon Pratt" });
    fireEvent.click(within(other).getByRole("button", { name: "Close" }));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());

    fireEvent.click(screen.getByText("Newest from Renata").closest("button"));
    const again = await screen.findByRole("dialog", { name: "Renata Cole" });
    await within(again).findByText("Earliest from Renata");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(within(again).getByText("Earliest from Renata").closest("article")).not.toHaveAttribute("tabindex");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
