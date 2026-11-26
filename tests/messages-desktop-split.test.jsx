import { expectReadyRetryAfterThrowAtOnce } from "./helpers/busyWriteFocus.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesView, briefingFailureKey, localDateTimeInputValue } from "../src/views/MessagesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { engagementApi } from "../src/features/engagement/api.js";
import { MemberApiError } from "../src/lib/memberApi.js";
import { catalogue } from "../src/lib/i18n.js";
import { chooseReminder } from "./helpers/reminderPicker.js";

// Desktop Messages split (owner direction, 2026-07-31): on the desktop shell
// the opened item reads in a pane beside the list — list column, threads
// area, detail pane — while the phone keeps its modal flow. These tests pin
// the surface swap and the composer's failure contract at component level.

function makeData() {
  return {
    member: { id: "member-1" },
    conversations: [{
      id: "conv-1",
      counterpartRole: "steward",
      sender: "Chapter steward",
      initials: "CS",
      preview: "Now the employer owes a written Step 2 answer.",
      dateLabel: "Jul 12",
      unread: 1,
      messages: [{
        id: "m1",
        sender_kind: "steward",
        sender_name: "Chapter steward",
        body: "Now the employer owes a written Step 2 answer.",
        created_at: "2026-07-12T10:00:00.000Z",
        read_at: null,
      }],
    }],
    broadcasts: [{
      id: "b-1",
      title: "July chapter meeting",
      sender: "Harborview Care United",
      body: "Thursday 6pm at the hall.",
      unread: true,
      publishedAt: "2026-07-10T18:00:00.000Z",
    }],
    product: {
      spaces: [{ id: "s1", threads: [{ id: "th1", title: "Parking changes", kind: "topic", status: "open", posts: [] }] }],
      documents: [{ id: "doc-1", title: "Overtime policy", document_type: "policy", status: "published" }],
    },
  };
}

function renderView(overrides = {}) {
  const handlers = {
    onProfile: vi.fn(),
    onAssistant: vi.fn(),
    onSendMessage: vi.fn().mockResolvedValue({}),
    onReadConversation: vi.fn().mockResolvedValue(null),
    onReadBroadcast: vi.fn().mockResolvedValue(null),
    onOpenTopics: vi.fn(),
    onOpenCases: vi.fn(),
    onOpenRights: vi.fn(),
    ...overrides,
  };
  render(<MessagesView data={makeData()} desktop {...handlers} />);
  return handlers;
}

describe("desktop Messages split", () => {
  beforeEach(() => window.localStorage.clear());

  it("explains all workflows, defaults to option 2 on skip, and keeps Compass staff-only", () => {
    const phone = render(<MessagesView data={makeData()} onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />);
    expect(screen.getByText("Start with the view that fits your day")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Start with the view that fits your day" })).not.toBeInTheDocument();
    expect(screen.queryByText("Tradeoff:")).not.toBeInTheDocument();
    expect(document.querySelector(".message-workflow-picker--compact")).toBeNull();
    expect(screen.getByRole("button", { name: "Use this workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip and use the default" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show workflow options/ }));
    expect(document.querySelector(".message-workflow-picker--compact")).not.toBeNull();
    expect(screen.queryByText("Tradeoff:")).not.toBeInTheDocument();
    phone.unmount();
    window.localStorage.clear();

    const view = render(<MessagesView data={makeData()} desktop staffAccess onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Start with the view that fits your day" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /People \/ Spaces \/ Work/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: /To-do inbox/ }));
    expect(screen.getByRole("radio", { name: /To-do inbox/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Skip and use the default" }));
    expect(screen.queryByRole("heading", { name: "Start with the view that fits your day" })).not.toBeInTheDocument();
    // The choice is stored under the signed-in member, never under a shared browser-wide key.
    expect(window.localStorage.getItem("unionground:messaging-workflow:v1")).toBeNull();
    expect(window.localStorage.getItem("unionground:messaging-workflow:v1:member-1")).toBe("people-spaces-work");
    const briefing = screen.getByRole("button", { name: /Expand Guide briefing/ });
    expect(briefing).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(briefing);
    expect(screen.getByText("What needs you")).toBeInTheDocument();

    view.unmount();
    render(<MessagesView data={makeData()} desktop onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />);
    expect(screen.queryByText("Compass briefing")).not.toBeInTheDocument();
  });

  it("resets the onboarding draft when the mounted view changes accounts", async () => {
    const handlers = {
      onSendMessage: vi.fn(),
      onReadConversation: vi.fn(),
      onReadBroadcast: vi.fn(),
      onOpenTopics: vi.fn(),
    };
    const firstData = makeData();
    const view = render(<MessagesView data={firstData} desktop {...handlers} />);

    fireEvent.click(screen.getByRole("radio", { name: /To-do inbox/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use this workflow" }));

    const secondData = makeData();
    secondData.member = { id: "member-2" };
    view.rerender(<MessagesView data={secondData} desktop {...handlers} />);

    await screen.findByRole("heading", { name: "Start with the view that fits your day" });
    expect(screen.getByRole("radio", { name: /People \/ Spaces \/ Work/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Use this workflow" }));
    expect(window.localStorage.getItem("unionground:messaging-workflow:v1:member-2")).toBe("people-spaces-work");
  });

  it("hides member steward-request controls for staff and keeps them on a truly empty member inbox", () => {
    const populated = {
      conversations: [],
      broadcasts: [{
        id: "b-1",
        title: "July chapter meeting",
        sender: "Harborview Care United",
        body: "Thursday 6pm at the hall.",
        unread: true,
        publishedAt: "2026-07-10T18:00:00.000Z",
      }],
      product: {
        spaces: [{ id: "s1", threads: [{ id: "th1", title: "Parking changes", kind: "topic", status: "open", posts: [] }] }],
      },
    };
    const staff = render(<MessagesView data={populated} desktop staffAccess onSendMessage={vi.fn()} onStartConversation={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} onOpenCases={vi.fn()} onRequestSteward={vi.fn()} />);
    expect(screen.getByText(/2 items/)).toBeInTheDocument();
    expect(screen.queryByText(/No private threads yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request a committee contact" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("First message to your committee contact")).not.toBeInTheDocument();
    staff.unmount();

    render(<MessagesView data={{ conversations: [], broadcasts: [], product: { spaces: [] } }} desktop onSendMessage={vi.fn()} onStartConversation={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} onOpenCases={vi.fn()} onRequestSteward={vi.fn()} />);
    expect(screen.getByLabelText("First message to your committee contact")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request a committee contact" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to My issues" })).toBeInTheDocument();
  });

  it("opens the steward thread rather than an unrelated first conversation", async () => {
    const data = makeData();
    data.conversations.unshift({ id: "peer-first", sender: "Alex Rivera", initials: "AR", preview: "Checking in", unread: 0, messages: [] });
    const onReadConversation = vi.fn().mockResolvedValue(null);
    render(<MessagesView data={data} desktop onSendMessage={vi.fn()} onReadConversation={onReadConversation} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Message your committee contact" }));
    await waitFor(() => expect(onReadConversation).toHaveBeenCalledWith("conv-1"));
  });

  it("formats scheduling limits in local wall-clock time instead of UTC", () => {
    const instant = new Date(2026, 7, 12, 12, 1, 45);
    expect(localDateTimeInputValue(instant)).toBe("2026-08-12T12:01");
  });

  it("renders list, threads area, and an empty detail pane — no dialog", () => {
    renderView();
    const pane = screen.getByRole("region", { name: "Message detail" });
    expect(within(pane).getByText("Your messages")).toBeInTheDocument();
    expect(within(pane).getByText(/Select a conversation, thread, or announcement/)).toBeInTheDocument();
    // Channels are a first-class filter in the same chronological inbox.
    expect(screen.getByRole("button", { name: "Channels" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("# Parking changes")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the inbox usable when optional initials and timestamps are absent or invalid", () => {
    const data = makeData();
    data.conversations[0].initials = "";
    data.conversations[0].updatedAt = "not-a-date";
    data.broadcasts[0].sender = null;
    render(<MessagesView data={data} desktop onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />);

    expect(screen.getByText("CS", { selector: ".inbox-chip--person" })).toBeInTheDocument();
    expect(screen.getByText("July chapter meeting")).toBeInTheDocument();
  });

  it("keeps a conversation on screen when one message timestamp is unparseable", () => {
    const data = makeData();
    data.conversations[0].messages = [
      {
        id: "m-valid",
        sender_kind: "steward",
        sender_name: "Chapter steward",
        body: "Now the employer owes a written Step 2 answer.",
        created_at: "2026-07-12T10:00:00.000Z",
        read_at: null,
      },
      {
        id: "m-bad",
        sender_kind: "member",
        sender_name: "Member",
        body: "Following up without a usable timestamp.",
        created_at: "not-a-date",
        read_at: null,
      },
    ];
    render(<MessagesView data={data} desktop onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip and use the default" }));
    fireEvent.click(screen.getByText("Now the employer owes a written Step 2 answer.", { selector: ".inbox-row__preview" }));

    const pane = screen.getByRole("region", { name: "Message detail" });
    expect(pane).toBeInTheDocument();
    const validArticle = within(pane).getByText("Now the employer owes a written Step 2 answer.").closest("article");
    const badArticle = within(pane).getByText("Following up without a usable timestamp.").closest("article");
    expect(validArticle.querySelector("time").textContent).not.toBe("");
    expect(badArticle.querySelector("time").textContent).toBe("");
  });

  it("opens a conversation inline in the pane and marks it read", async () => {
    const handlers = renderView();
    fireEvent.click(screen.getByText("Now the employer owes a written Step 2 answer.", { selector: ".inbox-row__preview" }));
    const pane = screen.getByRole("region", { name: "Message detail" });
    // The sender names the pane header; the steward's bubble also carries it,
    // so pin the header element.
    expect(within(pane).getByText("Chapter steward", { selector: ".inbox-detail__head-name" })).toBeInTheDocument();
    expect(within(pane).getByLabelText("Write a message…")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(handlers.onReadConversation).toHaveBeenCalledWith("conv-1"));
  });

  it("wires private-message reactions, saves, reminders, schedules, and document drops", async () => {
    const messagingApi = {
      toggleReaction: vi.fn().mockResolvedValue({ reacted: true, id: "reaction-1" }),
      toggleSaved: vi.fn().mockResolvedValue({ saved: true }),
      remind: vi.fn().mockResolvedValue({ id: "reminder-1" }),
      schedule: vi.fn().mockResolvedValue({ id: "scheduled-1" }),
      sendResource: vi.fn().mockResolvedValue({ messageId: "resource-message-1" }),
    };
    renderView({ messagingApi });
    fireEvent.click(screen.getByText("Now the employer owes a written Step 2 answer.", { selector: ".inbox-row__preview" }));
    const pane = screen.getByRole("region", { name: "Message detail" });

    fireEvent.click(within(pane).getByRole("button", { name: "React" }));
    fireEvent.click(within(pane).getByRole("button", { name: "Care" }));
    await waitFor(() => expect(messagingApi.toggleReaction).toHaveBeenCalledWith("private", "m1", "care"));
    // Every action button is disabled while the previous request settles; a
    // click in that window is dropped (merge group 39486770324).
    await waitFor(() => expect(within(pane).getByRole("button", { name: "Save" })).toBeEnabled());
    fireEvent.click(within(pane).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(messagingApi.toggleSaved).toHaveBeenCalledWith("private", "m1"));
    await waitFor(() => expect(within(pane).getByRole("button", { name: "Remind me…" })).toBeEnabled());
    const remindAt = chooseReminder(pane);
    await waitFor(() => expect(messagingApi.remind).toHaveBeenCalledWith("private", "m1", remindAt));

    fireEvent.change(within(pane).getByLabelText("Write a message…"), { target: { value: "Scheduled follow-up" } });
    fireEvent.change(within(pane).getByLabelText("Schedule for"), { target: { value: "2099-08-12T12:30" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(messagingApi.schedule).toHaveBeenCalledWith("conv-1", "Scheduled follow-up", new Date("2099-08-12T12:30").toISOString()));

    fireEvent.change(within(pane).getByLabelText("Share resource"), { target: { value: "doc-1" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(messagingApi.sendResource).toHaveBeenCalledWith("conv-1", "doc-1", ""));
    expect(within(pane).getByRole("link", { name: /Overtime policy/ })).toHaveAttribute("href", "/m/organize?document=doc-1");
  });

  // BUG-UG-WEB-SHARED-RESOURCE-VANISHES-FROM-THREAD-20261003: a share
  // lived only in the thread's local state, so the next change to the
  // conversation's messages (a read marker) or a remount dropped it. The App now
  // confirms the share into the conversation itself; this harness plays that
  // part through the api it hands the view.
  it("keeps a shared resource in the thread, once, through a read marker", async () => {
    let setOuter;
    function Harness() {
      const [data, setData] = useState(makeData);
      setOuter = setData;
      const messagingApi = {
        sendResource: async (conversationId, documentId) => {
          setData((current) => ({ ...current, conversations: current.conversations.map((item) => item.id !== conversationId ? item : {
            ...item,
            messages: [...item.messages, { id: "resource-message-1", conversation_id: conversationId, sender_kind: "member", sender_name: "Member", body: "Shared resource", created_at: "2026-07-12T11:00:00.000Z", read_at: null, reactions: [], saved: false, resource: { id: "link-1", documentId, title: "Overtime policy", documentType: "policy" } }],
          }) }));
          return { messageId: "resource-message-1", documentId };
        },
      };
      return <MessagesView data={data} desktop messagingApi={messagingApi} onProfile={vi.fn()} onAssistant={vi.fn()} onSendMessage={vi.fn()} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} onOpenCases={vi.fn()} onOpenRights={vi.fn()} />;
    }
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByText("Now the employer owes a written Step 2 answer.", { selector: ".inbox-row__preview" }));
    const pane = screen.getByRole("region", { name: "Message detail" });
    fireEvent.change(within(pane).getByLabelText("Share resource"), { target: { value: "doc-1" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(within(pane).getAllByRole("link", { name: /Overtime policy/ })).toHaveLength(1));
    // The read marker replaces the conversation's messages.
    act(() => setOuter((current) => ({ ...current, conversations: current.conversations.map((item) => ({ ...item, unread: 0, messages: item.messages.map((message) => ({ ...message, read_at: message.read_at || "2026-07-12T12:00:00.000Z" })) })) })));
    expect(within(screen.getByRole("region", { name: "Message detail" })).getAllByRole("link", { name: /Overtime policy/ })).toHaveLength(1);
    unmount();
  });

  it("aggregates saved messages and reminders and navigates only available sources", () => {
    const data = makeData();
    data.savedMessages = [
      { id: "saved-1", sourceKind: "channel", available: true, preview: "", targetId: "server-thread-outside-boot-window" },
      { id: "saved-2", sourceKind: "task", available: false, preview: "", targetId: null },
    ];
    data.messageReminders = [{ id: "reminder-1", sourceKind: "private", available: true, preview: "", targetId: "conv-1", remindAt: "2026-08-13T12:00:00Z" }];
    const onOpenTopics = vi.fn();
    const view = render(<MessagesView data={data} desktop onProfile={vi.fn()} onAssistant={vi.fn()} onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={onOpenTopics} />);
    expect(screen.getByRole("button", { name: "Saved" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Reminders" })).toHaveAttribute("aria-pressed", "false");
    const saved = screen.getByRole("button", { name: /Saved message.*Campaign channel/ });
    const reminder = screen.getByRole("button", { name: /Message reminder.*Private conversation/ });
    expect(within(saved).getByText("Saved message", { selector: "strong" })).toBeVisible();
    expect(within(reminder).getByText("Message reminder", { selector: "strong" })).toBeVisible();
    fireEvent.click(saved);
    expect(onOpenTopics).toHaveBeenCalledWith("server-thread-outside-boot-window");
    expect(screen.getByRole("button", { name: /Message unavailable/ })).toBeDisabled();
    fireEvent.click(reminder);
    expect(within(screen.getByRole("region", { name: "Message detail" })).getByText("Chapter steward", { selector: ".inbox-detail__head-name" })).toBeInTheDocument();

    view.unmount();
    render(<LanguageProvider lang="es"><MessagesView data={data} desktop onProfile={vi.fn()} onAssistant={vi.fn()} onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} /></LanguageProvider>);
    const savedEs = screen.getByRole("button", { name: /Mensaje guardado.*Canal de la campaña/ });
    const reminderEs = screen.getByRole("button", { name: /Recordatorio de mensaje.*Conversación privada/ });
    expect(within(savedEs).getByText("Mensaje guardado", { selector: "strong" })).toBeVisible();
    expect(within(reminderEs).getByText("Recordatorio de mensaje", { selector: "strong" })).toBeVisible();
  });

  it("filters the single inbox without changing source boundaries", () => {
    const data = makeData();
    data.savedMessages = [{ id: "saved-1", sourceKind: "channel", available: true, preview: "Parking reference", targetId: "th1", savedAt: "2026-07-13T10:00:00Z" }];
    const onOpenTopics = vi.fn();
    render(<MessagesView data={data} desktop onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={onOpenTopics} />);
    const toolbar = screen.getByRole("toolbar", { name: "Filter messages" });

    fireEvent.click(within(toolbar).getByRole("button", { name: "Unread" }));
    expect(within(toolbar).getByRole("button", { name: "Unread" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("July chapter meeting")).toBeInTheDocument();
    expect(screen.queryByText("# Parking changes")).not.toBeInTheDocument();

    fireEvent.click(within(toolbar).getByRole("button", { name: "Saved" }));
    expect(screen.getByText("Parking reference")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Parking reference/ }));
    expect(onOpenTopics).toHaveBeenCalledWith("th1");
  });

  it("keeps task-thread actions on the task source boundary", async () => {
    const data = makeData();
    data.tasks = [{ id: "task-1", title: "Translate member notice", status: "in_progress" }];
    data.taskMessages = [{ id: "task-message-1", taskId: "task-1", senderId: "member-1", recipientId: "steward-1", body: "Draft is ready", createdAt: "2026-08-12T12:00:00Z" }];
    const messagingApi = { toggleReaction: vi.fn().mockResolvedValue({ reacted: true }), toggleSaved: vi.fn().mockResolvedValue({ saved: true }), remind: vi.fn().mockResolvedValue({ id: "reminder-1" }) };
    render(<MessagesView data={data} desktop messagingApi={messagingApi} onNotice={vi.fn()} onSendMessage={vi.fn()} onSendTaskMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Translate member notice/ }));
    const dialog = await screen.findByRole("dialog", { name: "Translate member notice" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(messagingApi.toggleSaved).toHaveBeenCalledWith("task", "task-message-1"));
  });

  it("shows one detail at a time: announcement then conversation swap the pane", async () => {
    renderView();
    fireEvent.click(screen.getByText("July chapter meeting"));
    const pane = screen.getByRole("region", { name: "Message detail" });
    expect(await within(pane).findByText("Thursday 6pm at the hall.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Now the employer owes a written Step 2 answer.", { selector: ".inbox-row__preview" }));
    await waitFor(() => expect(within(pane).queryByText("Thursday 6pm at the hall.")).not.toBeInTheDocument());
    expect(within(pane).getByLabelText("Write a message…")).toBeInTheDocument();
  });

  it("keeps a newer draft when an earlier send fails", async () => {
    let rejectSend;
    const onSendMessage = vi.fn(() => new Promise((resolve, reject) => { rejectSend = reject; }));
    renderView({ onSendMessage });
    fireEvent.click(screen.getByText("Now the employer owes a written Step 2 answer.", { selector: ".inbox-row__preview" }));
    const pane = screen.getByRole("region", { name: "Message detail" });
    const composer = within(pane).getByLabelText("Write a message…");
    fireEvent.change(composer, { target: { value: "first draft" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(composer).toHaveValue(""));
    // The member has moved on while the send is in flight.
    fireEvent.change(composer, { target: { value: "newer draft" } });
    rejectSend(new Error("network down"));
    // The failure must NOT clobber the newer draft with the failed body.
    await waitFor(() => expect(within(pane).getByRole("button", { name: "Send" })).toBeEnabled());
    expect(composer).toHaveValue("newer draft");
  });

  it("restores the failed body into an idle composer", async () => {
    let rejectSend;
    const onSendMessage = vi.fn(() => new Promise((resolve, reject) => { rejectSend = reject; }));
    renderView({ onSendMessage });
    fireEvent.click(screen.getByText("Now the employer owes a written Step 2 answer.", { selector: ".inbox-row__preview" }));
    const pane = screen.getByRole("region", { name: "Message detail" });
    const composer = within(pane).getByLabelText("Write a message…");
    fireEvent.change(composer, { target: { value: "lost reply" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(composer).toHaveValue(""));
    rejectSend(new Error("network down"));
    await waitFor(() => expect(composer).toHaveValue("lost reply"));
  });

  // Record 8435, slice 9: a cancel that throws at once leaves a ready
  // control whose next press cancels again.
  it("cancels a scheduled send again from an immediate press after a cancel that throws at once", async () => {
    const data = makeData();
    data.conversations[0].scheduled = [{ id: "sched-1", conversation_id: "conv-1", body: "Send this later tonight", scheduled_for: "2026-09-18T02:00:00.000Z", status: "pending" }];
    const messagingApi = { toggleReaction: vi.fn(), toggleSaved: vi.fn(), remind: vi.fn(), cancelScheduled: vi.fn() };
    render(<MessagesView data={data} desktop messagingApi={messagingApi} onNotice={vi.fn()} onSendMessage={vi.fn()} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />);
    fireEvent.click(screen.getByText("Now the employer owes a written Step 2 answer.", { selector: ".inbox-row__preview" }));
    const pane = screen.getByRole("region", { name: "Message detail" });
    await expectReadyRetryAfterThrowAtOnce(messagingApi.cancelScheduled, within(pane).getByRole("button", { name: "Cancel scheduled send" }));
  });

  it("cancels a pending scheduled send from the conversation pane", async () => {
    const data = makeData();
    data.conversations[0].scheduled = [{
      id: "sched-1",
      conversation_id: "conv-1",
      body: "Send this later tonight",
      scheduled_for: "2026-09-18T02:00:00.000Z",
      status: "pending",
    }];
    const messagingApi = {
      toggleReaction: vi.fn(),
      toggleSaved: vi.fn(),
      remind: vi.fn(),
      cancelScheduled: vi.fn()
        .mockRejectedValueOnce(new Error("Cancel scheduled message: scheduled message unavailable"))
        .mockResolvedValueOnce({ cancelled: true }),
    };
    const onNotice = vi.fn();
    render(<MessagesView data={data} desktop messagingApi={messagingApi} onNotice={onNotice} onSendMessage={vi.fn()} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />);
    fireEvent.click(screen.getByText("Now the employer owes a written Step 2 answer.", { selector: ".inbox-row__preview" }));
    const pane = screen.getByRole("region", { name: "Message detail" });
    expect(within(pane).getByText(/Send this later tonight/)).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole("button", { name: "Cancel scheduled send" }));
    await waitFor(() => expect(messagingApi.cancelScheduled).toHaveBeenCalledWith("sched-1"));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("That message action could not be completed."));
    const scheduledNotices = onNotice.mock.calls.map(([message]) => String(message));
    expect(scheduledNotices.some((message) => message.includes("Cancel scheduled message"))).toBe(false);
    expect(scheduledNotices.some((message) => message.includes("scheduled message unavailable"))).toBe(false);
    expect(within(pane).getByText(/Send this later tonight/)).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole("button", { name: "Cancel scheduled send" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Scheduled send cancelled"));
    expect(within(pane).queryByText(/Send this later tonight/)).not.toBeInTheDocument();
  });

  it("cancels a reminder from the inbox and shows the catalogue sentence on a refusal", async () => {
    const data = makeData();
    data.messageReminders = [{
      id: "reminder-1",
      sourceKind: "private",
      available: true,
      preview: "Follow up on the written answer",
      targetId: "conv-1",
      remindAt: "2026-09-18T14:00:00.000Z",
    }];
    const messagingApi = {
      toggleReaction: vi.fn(),
      toggleSaved: vi.fn(),
      remind: vi.fn(),
      cancelReminder: vi.fn()
        .mockRejectedValueOnce(new Error("Cancel reminder: reminder unavailable"))
        .mockResolvedValueOnce({ cancelled: true }),
    };
    const onNotice = vi.fn();
    render(<MessagesView data={data} desktop messagingApi={messagingApi} onNotice={onNotice} onSendMessage={vi.fn()} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel reminder" }));
    await waitFor(() => expect(messagingApi.cancelReminder).toHaveBeenCalledWith("reminder-1"));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("That message action could not be completed."));
    const reminderNotices = onNotice.mock.calls.map(([message]) => String(message));
    expect(reminderNotices.some((message) => message.includes("Cancel reminder"))).toBe(false);
    expect(reminderNotices.some((message) => message.includes("reminder unavailable"))).toBe(false);
    expect(screen.getByRole("button", { name: "Cancel reminder" })).toBeInTheDocument();
    expect(screen.getByText("Follow up on the written answer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel reminder" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Reminder cancelled"));
    expect(screen.queryByRole("button", { name: "Cancel reminder" })).not.toBeInTheDocument();
  });

  it("keeps the phone's modal flow when the shell is not desktop", async () => {
    const handlers = {
      onProfile: vi.fn(), onAssistant: vi.fn(), onSendMessage: vi.fn(), onReadConversation: vi.fn().mockResolvedValue(null),
      onReadBroadcast: vi.fn(), onOpenTopics: vi.fn(), onOpenCases: vi.fn(), onOpenRights: vi.fn(),
    };
    render(<MessagesView data={makeData()} {...handlers} />);
    expect(screen.queryByRole("region", { name: "Message detail" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Now the employer owes a written Step 2 answer.", { selector: ".inbox-row__preview" }));
    expect(await screen.findByRole("dialog", { name: "Chapter steward" })).toBeInTheDocument();
  });
});

describe("Compass message briefing", () => {
  beforeEach(() => window.localStorage.clear());

  function briefingData() {
    const data = makeData();
    data.conversations[0].messages.push({
      id: "member-source",
      sender_kind: "member",
      sender_name: "Member",
      body: "Please follow up on the written answer.",
      created_at: "2026-07-12T11:00:00.000Z",
      read_at: null,
    });
    return data;
  }

  async function openBriefing(decision) {
    const onNotice = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ briefing: { summary: "The member needs a written response.", actionItems: ["Track the Step 2 response"] } }),
    });
    const propose = vi.spyOn(engagementApi, "proposeAction").mockResolvedValue({ id: "action", title: "Track the Step 2 response", state: "proposed" });
    const decide = vi.spyOn(engagementApi, "decideAction").mockResolvedValue({ id: "action", title: "Track the Step 2 response", state: decision });
    render(<MessagesView
      data={briefingData()}
      desktop
      staffAccess
      engagementSession={{ access_token: "token" }}
      engagementClient={{ rpc: vi.fn() }}
      onNotice={onNotice}
      onSendMessage={vi.fn()}
      onReadConversation={vi.fn()}
      onReadBroadcast={vi.fn()}
      onOpenTopics={vi.fn()}
    />);
    fireEvent.click(screen.getByText("Now the employer owes a written Step 2 answer.", { selector: ".inbox-row__preview" }));
    const pane = screen.getByRole("region", { name: "Message detail" });
    fireEvent.click(within(pane).getByRole("button", { name: "Brief this thread" }));
    expect(await within(pane).findByText("The member needs a written response.")).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole("button", { name: "Prepare linked task" }));
    expect(await within(pane).findByText(/Approve task creation/)).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole("button", { name: decision === "confirmed" ? "Create task" : "Dismiss" }));
    expect(await within(pane).findByText(`Action ${decision}.`)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/guide", expect.objectContaining({
      body: JSON.stringify({ mode: "message_briefing", sourceKind: "private", targetId: "conv-1" }),
    }));
    expect(propose).toHaveBeenCalledWith(expect.anything(), "message", "member-source", "Track the Step 2 response");
    expect(decide).toHaveBeenCalledWith(expect.anything(), "action", decision === "confirmed" ? "confirm" : "reject");
    expect(onNotice).toHaveBeenCalled();
  }

  it("does not expose thread briefing to member-only identities", () => {
    render(<MessagesView
      data={briefingData()}
      desktop
      engagementSession={{ access_token: "token" }}
      onSendMessage={vi.fn()}
      onReadConversation={vi.fn()}
      onReadBroadcast={vi.fn()}
      onOpenTopics={vi.fn()}
    />);
    fireEvent.click(screen.getByText("Now the employer owes a written Step 2 answer.", { selector: ".inbox-row__preview" }));
    const pane = screen.getByRole("region", { name: "Message detail" });
    expect(within(pane).queryByRole("button", { name: "Brief this thread" })).not.toBeInTheDocument();
  });

  it("keeps Compass task creation behind an explicit confirmation", async () => {
    await openBriefing("confirmed");
  });

  it("lets staff dismiss a proposed Compass action", async () => {
    await openBriefing("rejected");
  });
});

// Briefing notices are catalogue copy, never the thrown error's own text
// (UX-UG-MESSAGES-COMPASS-BRIEFING-RAW-ERROR-TEXT-20260920). /api/guide
// answers a refusal with an English sentence AND a machine-readable code, and
// a failed propose call arrives as a MemberApiError carrying an English
// operation label plus the PostgREST refusal. Neither may reach the notice.
describe("Compass briefing failure notices", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  function briefingData() {
    const data = makeData();
    data.conversations[0].messages.push({
      id: "member-source",
      sender_kind: "member",
      sender_name: "Member",
      body: "Please follow up on the written answer.",
      created_at: "2026-07-12T11:00:00.000Z",
      read_at: null,
    });
    return data;
  }

  // The pane is walked by class so the case stays about the notice, not the
  // button copy.
  function openPane(lang, { fetchResponse, propose }) {
    const onNotice = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(fetchResponse);
    vi.spyOn(engagementApi, "proposeAction").mockImplementation(propose);
    render(
      <LanguageProvider lang={lang}>
        <MessagesView
          data={briefingData()}
          desktop
          staffAccess
          engagementSession={{ access_token: "token" }}
          engagementClient={{ rpc: vi.fn() }}
          onNotice={onNotice}
          onSendMessage={vi.fn()}
          onReadConversation={vi.fn()}
          onReadBroadcast={vi.fn()}
          onOpenTopics={vi.fn()}
        />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByText("Now the employer owes a written Step 2 answer.", { selector: ".inbox-row__preview" }));
    return { onNotice, pane: document.querySelector(".inbox-detail") };
  }

  function notices(onNotice) {
    return onNotice.mock.calls.map(([text]) => text);
  }

  it("paints the Spanish rate-limit sentence, not the endpoint's English one", async () => {
    const serverSentence = "Compass is at the shared hourly limit. Try again shortly.";
    const { onNotice, pane } = openPane("es", {
      fetchResponse: { ok: false, status: 429, json: async () => ({ code: "shared_rate_limit", error: serverSentence }) },
      propose: vi.fn(),
    });
    fireEvent.click(pane.querySelector(".inbox-briefing button"));
    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    expect(notices(onNotice)).toEqual([catalogue.es["inbox.compassBriefFailure.sharedLimit"]]);
    expect(notices(onNotice).join(" ")).not.toContain(serverSentence);
  });

  it("names the staff-role refusal in Spanish when the endpoint sends no code", async () => {
    const serverSentence = "A staff role is required to brief a message thread.";
    const { onNotice, pane } = openPane("es", {
      fetchResponse: { ok: false, status: 403, json: async () => ({ error: serverSentence }) },
      propose: vi.fn(),
    });
    fireEvent.click(pane.querySelector(".inbox-briefing button"));
    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    expect(notices(onNotice)).toEqual([catalogue.es["inbox.compassBriefFailure.staffRole"]]);
    expect(notices(onNotice).join(" ")).not.toContain(serverSentence);
  });

  it("never paints the operation label or PostgREST text of a failed task proposal", async () => {
    const refusal = new MemberApiError("Propose Compass action", {
      message: 'new row violates row-level security policy for table "compass_workspace_actions"',
      code: "42501",
    });
    const { onNotice, pane } = openPane("es", {
      fetchResponse: { ok: true, json: async () => ({ briefing: { summary: "The member needs a written response.", actionItems: ["Track the Step 2 response"] } }) },
      propose: vi.fn().mockRejectedValue(refusal),
    });
    fireEvent.click(pane.querySelector(".inbox-briefing button"));
    expect(await within(pane).findByText("The member needs a written response.")).toBeInTheDocument();
    fireEvent.click(pane.querySelector(".inbox-briefing__result button"));
    // The success notice fires first; the failure notice is the one under test.
    await waitFor(() => expect(notices(onNotice).length).toBe(2));
    expect(notices(onNotice).at(-1)).toBe(catalogue.es["inbox.compassTaskPrepareFailed"]);
    const shown = notices(onNotice).join(" ");
    expect(shown).not.toContain("Propose Compass action");
    expect(shown).not.toContain("row-level security");
  });

  it("keeps each refusal class the endpoint codes on its own sentence", () => {
    const classes = [
      ["shared_rate_limit", undefined],
      ["role_rate_limit", undefined],
      ["compass_paused", undefined],
      ["compass_privacy_unavailable", undefined],
      ["governance_unavailable", undefined],
      ["persistence_unavailable", undefined],
      ["session_expired", 401],
      [undefined, 403],
      [undefined, 404],
      [undefined, 400],
    ];
    const sentences = classes.map(([code, status]) => catalogue.en[briefingFailureKey({ code, status, message: "server text" })]);
    expect(sentences.every((sentence) => typeof sentence === "string" && sentence.length > 0)).toBe(true);
    expect(new Set(sentences).size).toBe(sentences.length);
    expect(briefingFailureKey({ code: "something_new", status: 500 })).toBe("inbox.compassBriefFailed");
    expect(catalogue.es[briefingFailureKey({ code: "compass_paused" })]).toBe("Una persona administradora pausó la Guía.");
  });
});

// Bilingual broadcasts: rows flag their language to viewers of the OTHER
// locale, in the viewer's language. Same-language rows carry no chip — the
// flag marks the exception, not the rule.
describe("broadcast language chip", () => {
  function renderWithLang(lang, broadcastOverrides = {}) {
    const data = makeData();
    data.broadcasts = [{ ...data.broadcasts[0], locale: "en", ...broadcastOverrides }];
    render(
      <LanguageProvider lang={lang}>
        <MessagesView
          data={data}
          desktop
          onProfile={vi.fn()}
          onAssistant={vi.fn()}
          onSendMessage={vi.fn().mockResolvedValue({})}
          onReadConversation={vi.fn().mockResolvedValue(null)}
          onReadBroadcast={vi.fn().mockResolvedValue(null)}
          onOpenTopics={vi.fn()}
        />
      </LanguageProvider>,
    );
  }

  it("shows 'En inglés' to a Spanish reader on an English row", () => {
    renderWithLang("es");
    expect(screen.getByText("En inglés")).toBeInTheDocument();
  });

  it("shows 'In Spanish' to an English reader on a Spanish row", () => {
    renderWithLang("en", { locale: "es" });
    expect(screen.getByText("In Spanish")).toBeInTheDocument();
  });

  it("stays silent when the row matches the viewer's language", () => {
    renderWithLang("en");
    expect(screen.queryByText(/In Spanish|In English/)).toBeNull();
  });

  it("tolerates rows without a locale (older data) by showing no chip", () => {
    renderWithLang("es", { locale: undefined });
    expect(screen.queryByText(/En inglés|En español/)).toBeNull();
  });
});
