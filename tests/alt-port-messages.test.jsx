import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { altShellCatalogue } from "../src/lib/i18n/altShell.js";
import { t } from "../src/lib/i18n.js";

// REQ-UG-ALT-PORT-MESSAGES-20261030: the alternate shell's Messages
// is the prototype's three panes (list, thread, details) on the same inbox
// state and server actions as the classic view.

const conversation = {
  id: "conversation-1",
  sender: "Chapter Steward",
  initials: "CS",
  preview: "About the overtime list",
  dateLabel: "Now",
  unread: 2,
  messages: [
    { id: "m1", conversation_id: "conversation-1", sender_kind: "steward", sender_name: "Dana Ruiz", body: "About the overtime list", created_at: "2026-10-29T14:00:00Z", reactions: [], saved: false },
  ],
};
const broadcast = { id: "b1", title: "Contract ratified", body: "The vote passed.", sender: "Chapter office", publishedAt: "2026-10-28T15:00:00Z", locale: "en", unread: true };

function show({ lang = "en", ...props } = {}) {
  const handlers = {
    onSendMessage: vi.fn().mockResolvedValue({}),
    onReadConversation: vi.fn().mockResolvedValue(null),
    onReadBroadcast: vi.fn().mockResolvedValue(null),
    onOpenTopics: vi.fn(),
    onOpenHome: vi.fn(),
    ...props,
  };
  render(
    <LanguageProvider lang={lang}>
      <MessagesView
        alt
        desktop
        data={{ member: { id: "member-1" }, conversations: [conversation], broadcasts: [broadcast], product: { spaces: [], documents: [] } }}
        {...handlers}
      />
    </LanguageProvider>,
  );
  return handlers;
}

const app = () => document.querySelector(".ug-msg-app");

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/m/messages");
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("the alternate shell's Messages", () => {
  it.each([false, true])("retains product updates in the announcement filter with alt=%s", async (alt) => {
    const update = { id: "delivery", announcementId: "release", revision: 1, title: "Product release", body: "New product controls", publishedAt: "2026-10-29T10:00:00-04:00", expiresAt: "2099-10-29T10:00:00-04:00" };
    const rpc = vi.fn().mockImplementation(async (_name, args) => args.p_action === "list_my_platform_announcements"
      ? { data: { items: [update], generation: 1, hidden: false }, error: null }
      : { data: null, error: { code: "42501" } });
    show({ alt, announcementContext: {
      session: { user: { id: "member-1" }, access_token: `header.${btoa(JSON.stringify({ session_id: "announcements" }))}.signature` },
      organizationId: "organization", chapterId: "chapter", hat: "member", createClient: () => ({ rpc }),
    } });
    expect(screen.queryByText(update.body)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Announcements/ }));
    expect(await screen.findByText(update.body)).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("platform_announcement_request", expect.objectContaining({ p_organization_id: "organization" }));
    fireEvent.change(screen.getByPlaceholderText("Search people & threads…"), { target: { value: "Product release" } });
    expect(screen.queryByText(update.body)).toBeNull();
  });

  it("draws the prototype's hero and conversation list on the inbox items", () => {
    const handlers = show();
    expect(screen.getByRole("heading", { level: 1, name: "Messages" })).toBeInTheDocument();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    fireEvent.click(within(crumbs).getByRole("link", { name: "Now" }));
    expect(handlers.onOpenHome).toHaveBeenCalled();
    expect(app()).toHaveAttribute("data-view", "list");
    const list = within(screen.getByRole("navigation", { name: "Conversations" }));
    const row = list.getByRole("button", { name: /Chapter Steward/ });
    expect(row).toHaveClass("ug-msg-item", "ug-unread");
    expect(within(row).getByLabelText("2 unread")).toBeInTheDocument();
    expect(list.getByRole("button", { name: /Contract ratified/ })).toBeInTheDocument();
    expect(screen.getByText("Your messages")).toBeInTheDocument();
    // No phone dialog: the thread opens in its pane.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a conversation in the thread pane, marks it read, sends, and goes back to the list", async () => {
    const handlers = show();
    fireEvent.click(screen.getByRole("button", { name: /Chapter Steward/ }));
    await waitFor(() => expect(handlers.onReadConversation).toHaveBeenCalledWith("conversation-1"));
    expect(app()).toHaveAttribute("data-view", "thread");
    expect(screen.getByRole("heading", { level: 2, name: "Chapter Steward" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Chapter Steward/ })).toHaveAttribute("aria-current", "true");
    const box = screen.getByRole("combobox", { name: "Write a message…" });
    fireEvent.change(box, { target: { value: "Thanks", selectionStart: 6 } });
    await act(async () => { fireEvent.submit(box.closest("form")); });
    expect(handlers.onSendMessage).toHaveBeenCalledWith("conversation-1", "Thanks");
    fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
    expect(app()).toHaveAttribute("data-view", "list");
  });

  it("completes an @mention from a keyboard listbox of the thread's people", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Chapter Steward/ }));
    const box = screen.getByRole("combobox", { name: "Write a message…" });
    box.focus();
    fireEvent.change(box, { target: { value: "Hi @", selectionStart: 4 } });
    const listbox = screen.getByRole("listbox", { name: "People to mention" });
    const options = within(listbox).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["CSChapter StewardPrivate conversation", "DRDana Ruiz"]);
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(box).toHaveAttribute("aria-activedescendant", options[0].id);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box).toHaveAttribute("aria-activedescendant", within(screen.getByRole("listbox")).getAllByRole("option")[1].id);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(box).toHaveValue("Hi @Dana Ruiz "));
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(box, { target: { value: "Hi @Dana Ruiz and @ch", selectionStart: 21 } });
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(box, { target: { value: "no mention", selectionStart: 10 } });
    expect(screen.queryByRole("listbox")).toBeNull();
  });



  it("offers a staff hat a task from the conversation's latest message", () => {
    const onCreateTaskFromSource = vi.fn().mockResolvedValue({ task: { id: "t1" } });
    show({ onCreateTaskFromSource, staffAccess: true });
    fireEvent.click(screen.getByRole("button", { name: /Chapter Steward/ }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const info = within(screen.getByRole("complementary", { name: "About this conversation" }));
    expect(info.getAllByRole("button").map((button) => button.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/task/i)]));
  });
});

describe("Codex findings on #6535", () => {
  it("keeps the header and the composer on one recipient when a direct-conversation link arrives over an open peer thread", () => {
    const peerContact = {
      available: true, canRequest: false, code: "UG-0123", incoming: [], outgoing: [],
      conversations: [{ id: "peer-1", peerName: "Alex Rivera", peerInitials: "AR", updatedAt: "2026-10-29T12:00:00Z", messages: [] }],
    };
    const props = {
      alt: true, desktop: true,
      data: { member: { id: "member-1" }, conversations: [conversation], broadcasts: [], product: { spaces: [], documents: [] }, peerContact },
      onSendMessage: vi.fn().mockResolvedValue({}), onReadConversation: vi.fn().mockResolvedValue(null), onReadBroadcast: vi.fn().mockResolvedValue(null),
      onOpenTopics: vi.fn(), peerContactApi: { send: vi.fn().mockResolvedValue({ message: null }) },
    };
    const { rerender } = render(<LanguageProvider lang="en"><MessagesView {...props} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Alex Rivera/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Alex Rivera" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: t("en", "inbox.peerComposer") })).toBeInTheDocument();
    // A direct-conversation link followed inside Messages (search, All reminders).
    rerender(<LanguageProvider lang="en"><MessagesView {...props} focus={{ view: "messages", conversationId: "conversation-1" }} /></LanguageProvider>);
    // Header and composer now both name the steward conversation; the peer is closed.
    expect(screen.getByRole("heading", { level: 2, name: "Chapter Steward" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Alex Rivera" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: t("en", "inbox.peerComposer") })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Write a message…" })).toBeInTheDocument();
  });

  it("keeps light text only on the outgoing bubble's own action row", () => {
    const css = readFileSync("src/alt/styles/messages.css", "utf8");
    expect(css).toMatch(/\.inbox-msg--out \.inbox-msg-actions > :is\(button, select\),\n[^{]*\.message-reaction-picker > button,\n[^{]*\.connected-actions__trigger \{ color: #fff; \}/);
    expect(css).not.toMatch(/\.inbox-msg--out (a|button|\.inbox-resource)\b[^{]*\{[^}]*color: #fff/);
  });
});

describe("every control of the alternate layout", () => {
  const stewardThread = { ...conversation, counterpartRole: "steward", stewardUserId: null };

  it("keeps the details pane open under a modal dialog, moves focus to its close button and closes from it", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Chapter Steward/ }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const close = screen.getByRole("button", { name: "Close details" });
    await waitFor(() => expect(close).toHaveFocus());
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(app()).toHaveClass("ug-info-open");
    modal.remove();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(app()).toHaveClass("ug-info-open");
    fireEvent.click(close);
    expect(app()).not.toHaveClass("ug-info-open");
  });


  it("cancels a message reminder from its list row", async () => {
    const cancelReminder = vi.fn().mockResolvedValue({});
    show({
      messagingApi: { cancelReminder },
      data: {
        member: { id: "member-1" }, conversations: [conversation], broadcasts: [], product: { spaces: [], documents: [] },
        messageReminders: [{ id: "reminder-1", available: true, preview: "Call the steward back", sourceKind: "private", remindAt: "2026-10-30T12:00:00Z", unread: 0 }],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel reminder" }));
    await waitFor(() => expect(cancelReminder).toHaveBeenCalledWith("reminder-1"));
  });

  it("creates a task from the latest message and opens it with its source", async () => {
    const task = { id: "task-1", title: "Follow up" };
    const onCreateTaskFromSource = vi.fn().mockResolvedValue({ task, created: true });
    const onOpenTask = vi.fn().mockResolvedValue(undefined);
    show({ staffAccess: true, onCreateTaskFromSource, onOpenTask });
    fireEvent.click(screen.getByRole("button", { name: /Chapter Steward/ }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const info = within(screen.getByRole("complementary", { name: "About this conversation" }));
    fireEvent.click(info.getByRole("button", { name: /Create task/ }));
    await waitFor(() => expect(onCreateTaskFromSource).toHaveBeenCalledWith("message", "m1"));
    fireEvent.click(await info.findByRole("button", { name: /Open task/ }));
    await waitFor(() => expect(onOpenTask).toHaveBeenCalledWith(task, { sourceKind: "message", sourceId: "m1", conversationId: "conversation-1" }));
  });

  it("picks a mention with the pointer and reopens the list from a click inside the text", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Chapter Steward/ }));
    const box = screen.getByRole("combobox", { name: "Write a message…" });
    fireEvent.change(box, { target: { value: "Hi @Da", selectionStart: 6 } });
    fireEvent.mouseDown(within(screen.getByRole("listbox")).getByRole("option", { name: /Dana Ruiz/ }));
    await waitFor(() => expect(box).toHaveValue("Hi @Dana Ruiz "));
    expect(screen.queryByRole("listbox")).toBeNull();
    box.setSelectionRange(4, 4);
    fireEvent.click(box);
    expect(screen.getByRole("listbox", { name: "People to mention" })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "Tab" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    fireEvent.keyDown(box, { key: "ArrowDown" });
  });

  it("leaves a modified click on the crumb to the browser", () => {
    const handlers = show();
    const now = within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Now" });
    fireEvent.click(now, { ctrlKey: true });
    fireEvent.click(now, { button: 1 });
    expect(handlers.onOpenHome).not.toHaveBeenCalled();
  });
});

describe("read marks and resets that must not stop the inbox", () => {
  it("keeps the thread open when marking a conversation or an announcement read fails", async () => {
    const failing = () => vi.fn().mockRejectedValue(new Error("offline"));
    const handlers = show({ onReadConversation: failing(), onReadBroadcast: failing() });
    fireEvent.click(screen.getByRole("button", { name: /Chapter Steward/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Chapter Steward" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Contract ratified/ }));
    expect(screen.getByRole("log", { name: "Contract ratified" })).toBeInTheDocument();
    await waitFor(() => expect(handlers.onReadBroadcast).toHaveBeenCalledWith("b1"));
  });

  it("opens an announcement from a link or a search result even when marking it read fails", async () => {
    window.history.replaceState({}, "", "/m/messages?broadcast=b1");
    const onReadBroadcast = vi.fn().mockRejectedValue(new Error("offline"));
    const props = {
      alt: true, desktop: true, onOpenTopics: vi.fn(), onSendMessage: vi.fn(), onReadConversation: vi.fn().mockResolvedValue(null), onReadBroadcast,
      data: { member: { id: "member-1" }, conversations: [conversation], broadcasts: [broadcast], product: { spaces: [], documents: [] } },
    };
    const { rerender } = render(<LanguageProvider lang="en"><MessagesView {...props} /></LanguageProvider>);
    expect(await screen.findByRole("log", { name: "Contract ratified" })).toBeInTheDocument();
    window.history.replaceState({}, "", "/m/messages");
    rerender(<LanguageProvider lang="en"><MessagesView {...props} focus={{ view: "messages", broadcastId: "b1" }} /></LanguageProvider>);
    await waitFor(() => expect(onReadBroadcast).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("log", { name: "Contract ratified" })).toBeInTheDocument();
  });

  it("shows every message again from an empty search, and the classic inbox filters as you type", () => {
    show();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search people & threads…" }), { target: { value: "nothing matches this" } });
    fireEvent.click(screen.getByRole("button", { name: t("en", "inbox.showAllMessages") }));
    expect(screen.getByRole("searchbox", { name: "Search people & threads…" })).toHaveValue("");
    cleanup();
    render(
      <LanguageProvider lang="en">
        <MessagesView desktop data={{ member: { id: "member-1" }, conversations: [conversation], broadcasts: [broadcast], product: { spaces: [], documents: [] } }} onSendMessage={vi.fn()} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn().mockResolvedValue(null)} onOpenTopics={vi.fn()} />
      </LanguageProvider>,
    );
    const search = screen.getByRole("textbox", { name: "Search people & threads…" });
    fireEvent.change(search, { target: { value: "ratified" } });
    expect(search).toHaveValue("ratified");
    expect(document.querySelector(".ug-msg-app")).toBeNull();
  });
});

describe("Messages motion and strings", () => {
  it("draws production messages as the design's bubbles, with only the prototype's motion", () => {
    const css = readFileSync("src/alt/styles/messages.css", "utf8");
    expect(css).toMatch(/\.ugalt \.ug-msg-host \.inbox-msg \{[^}]*border-radius: 20px 20px 20px 6px;/);
    // The prototype's bubbles do not animate; its details pane slides (design.css).
    expect(css).not.toMatch(/animation:/);
    expect(css).toMatch(/\.ugalt \.ug-msg-host \.inbox-msg--out \{[^}]*background: var\(--ug-forest\)/);
    expect(readFileSync("src/alt/AltShell.jsx", "utf8")).toContain('import "./styles/messages.css";');
  });
  it("adds every Messages string in English and Spanish", () => {
    const keys = Object.keys(altShellCatalogue.en).filter((key) => key.startsWith("altShell.msg"));
    expect(keys.length).toBeGreaterThan(14);
    for (const key of keys) expect(altShellCatalogue.es[key], key).toBeTruthy();
  });
});
