import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageActions } from "../src/components/MessageActions.jsx";
import { SharedMessageActions } from "../src/components/SharedMessageActions.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { StewardView } from "../src/views/StewardView.jsx";

// REQ-UG-CONNECTED-WORKFLOW-SHORTCUTS-20260928, second wave. Each views takes
// an optional renderConnectedActions(kind, record) and puts the controller's
// common connected control for THAT exact row inside the message action group,
// beside (never inside) the row's own buttons. While it is offered the row drops
// its own reminder entry and the per-message task shortcut, so nothing is offered
// twice; a callback that returns nothing for a row leaves that row standalone.

afterEach(() => {
  window.history.replaceState({}, "", "/m");
});

// Stands in for the controller's ConnectedRecordActions: a trigger inside its own
// wrapper, carrying the exact row it was handed.
function ConnectedDouble({ kind, record, onPress }) {
  return (
    <div className="connected-actions" data-kind={kind} data-record={record.id}>
      <button type="button" aria-expanded="false" onClick={() => onPress(kind, record)}>Actions</button>
    </div>
  );
}
function connectedFactory(onPress = vi.fn()) {
  return vi.fn((kind, record) => <ConnectedDouble kind={kind} record={record} onPress={onPress} />);
}
// The callback runs while a row renders, so a re-render asks again: compare the distinct rows it was asked for.
const askedFor = (callback) => [...new Set(callback.mock.calls.map(([kind, record]) => `${kind}:${record.id}`))].sort();

const fallbackApi = (extra = {}) => ({
  toggleReaction: vi.fn(async () => ({ reacted: true })),
  toggleSaved: vi.fn(async () => ({ saved: true })),
  remind: vi.fn(async () => ({ id: "reminder-1" })),
  ...extra,
});

const capabilities = { canEdit: false, saved: false, reminders: [], reactions: [] };
const sharedApi = (state = capabilities) => ({ messageAction: vi.fn(async () => state) });

function group() {
  return screen.getByRole("group", { name: "Message actions" });
}

// ---------------------------------------------------------------------------
// The two message action components
// ---------------------------------------------------------------------------

describe("MessageActions with a connected slot (fallback row)", () => {
  const message = { id: "m1", sender_kind: "member", body: "Hello", reactions: [] };

  it("keeps reply-side actions, drops its own reminder entry, and seats the slot last in the group as a sibling", () => {
    render(<MessageActions sourceKind="private" message={message} actorId="me" api={fallbackApi()} connectedActions={<ConnectedDouble kind="private_message" record={message} onPress={vi.fn()} />} />);
    const actions = group();
    const trigger = within(actions).getByRole("button", { name: "Actions" });
    expect(within(actions).getByRole("button", { name: "React" })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remind me…" })).toBeNull();
    // Not nested in another control, and after every one of the row's own controls.
    expect(trigger.closest("button, select")).toBe(trigger);
    expect(trigger.closest(".inbox-msg-actions__connected").parentElement).toBe(actions);
    expect([...actions.querySelectorAll("button, select")].at(-1)).toBe(trigger);
    expect(screen.getAllByRole("group", { name: "Message actions" })).toHaveLength(1);
  });

  it("a caller can withhold the reminder entry without a slot, and can keep it beside a slot", () => {
    const view = render(<MessageActions sourceKind="private" message={message} actorId="me" api={fallbackApi()} suppressReminder />);
    expect(screen.queryByRole("button", { name: "Remind me…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    view.unmount();
    render(<MessageActions sourceKind="private" message={message} actorId="me" api={fallbackApi()} connectedActions={<span>slot</span>} suppressReminder={false} />);
    expect(screen.getByRole("button", { name: "Remind me…" })).toBeInTheDocument();
    expect(screen.getByText("slot")).toBeInTheDocument();
  });

  it("still lets a reminder that already exists be cancelled", async () => {
    const cancelReminder = vi.fn(async () => ({ cancelled: true }));
    render(<MessageActions sourceKind="private" message={{ ...message, reminder: { id: "r1", remind_at: "2026-09-30T12:00:00.000Z", status: "pending" } }} actorId="me" api={fallbackApi({ cancelReminder })} connectedActions={<span>slot</span>} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel reminder" }));
    await waitFor(() => expect(cancelReminder).toHaveBeenCalledWith("r1"));
    expect(screen.queryByRole("button", { name: "Remind me…" })).toBeNull();
  });

  it("renders only the slot when the row has no messaging api, and nothing at all without a slot", () => {
    const view = render(<MessageActions sourceKind="private" message={message} actorId="me" api={null} connectedActions={<ConnectedDouble kind="private_message" record={message} onPress={vi.fn()} />} />);
    expect(within(group()).getByRole("button", { name: "Actions" })).toBeInTheDocument();
    expect(within(group()).getAllByRole("button")).toHaveLength(1);
    view.unmount();
    const bare = render(<MessageActions sourceKind="private" message={message} actorId="me" api={null} />);
    expect(bare.container).toBeEmptyDOMElement();
  });

  it("changes nothing for a row without a slot", () => {
    render(<MessageActions sourceKind="private" message={message} actorId="me" api={fallbackApi()} />);
    expect(screen.getByRole("button", { name: "Remind me…" })).toBeInTheDocument();
    expect(document.querySelector(".inbox-msg-actions__connected")).toBeNull();
  });
});

describe("SharedMessageActions with a connected slot (server-driven row)", () => {
  const message = { id: "m1", sender_kind: "member", body: "Hello", reactions: [] };
  const slot = <ConnectedDouble kind="private_message" record={message} onPress={vi.fn()} />;

  it("offers the server's choices except its own reminder creation, with the slot last in the same group", async () => {
    render(<SharedMessageActions sourceKind="private" message={message} actorId="me" api={sharedApi()} onNotice={vi.fn()} onMessageChange={vi.fn()} connectedActions={slot} />);
    await screen.findByRole("button", { name: "Reply" });
    const actions = group();
    expect(within(actions).getByRole("button", { name: "Save message" })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "React" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remind me…" })).toBeNull();
    const trigger = within(actions).getByRole("button", { name: "Actions" });
    expect(trigger.closest(".inbox-msg-actions__connected").parentElement).toBe(actions);
    expect([...actions.querySelectorAll("button, select")].at(-1)).toBe(trigger);
  });

  it("shows the slot even while the row's own actions have not loaded", () => {
    const api = { messageAction: vi.fn(() => new Promise(() => {})) };
    render(<SharedMessageActions sourceKind="private" message={message} actorId="me" api={api} onNotice={vi.fn()} onMessageChange={vi.fn()} connectedActions={slot} />);
    expect(within(group()).getByRole("button", { name: "Load message actions" })).toBeInTheDocument();
    expect(within(group()).getByRole("button", { name: "Actions" })).toBeInTheDocument();
  });

  it("keeps removing an existing reminder available", async () => {
    render(<SharedMessageActions sourceKind="private" message={message} actorId="me" api={sharedApi({ ...capabilities, reminders: [{ id: "r1" }] })} onNotice={vi.fn()} onMessageChange={vi.fn()} connectedActions={slot} />);
    expect(await screen.findByRole("button", { name: "Remove reminders" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remind me…" })).toBeNull();
  });

  it("keeps its own reminder entry when told to, and renders no slot for a removed message", async () => {
    render(<SharedMessageActions sourceKind="private" message={message} actorId="me" api={sharedApi()} onNotice={vi.fn()} onMessageChange={vi.fn()} connectedActions={slot} suppressReminder={false} />);
    expect(await screen.findByRole("button", { name: "Remind me…" })).toBeInTheDocument();
    const removed = render(<SharedMessageActions sourceKind="private" message={{ ...message, id: "m2", redacted_at: "2026-09-06T00:00:00Z" }} actorId="me" api={sharedApi()} onNotice={vi.fn()} onMessageChange={vi.fn()} connectedActions={<span>removed-slot</span>} />);
    expect(removed.container).toBeEmptyDOMElement();
  });
});

// ---------------------------------------------------------------------------
// Private conversation in Messages
// ---------------------------------------------------------------------------

function messagesData(extra = []) {
  return {
    member: { id: "member-1" },
    conversations: [{
      id: "conv-1", counterpartRole: "steward", sender: "Chapter steward", initials: "CS", preview: "Second note", dateLabel: "Jul 12", unread: 0,
      messages: [
        { id: "m-old", conversation_id: "conv-1", sender_kind: "member", sender_name: "Member", body: "First note", created_at: "2026-07-12T09:00:00.000Z" },
        { id: "m-steward", conversation_id: "conv-1", sender_kind: "steward", sender_name: "Chapter steward", body: "Noted, thanks", created_at: "2026-07-12T10:00:00.000Z" },
        { id: "m-new", conversation_id: "conv-1", sender_kind: "member", sender_name: "Member", body: "Second note", created_at: "2026-07-12T11:00:00.000Z" },
        ...extra,
      ],
    }],
    broadcasts: [],
    product: { spaces: [], documents: [] },
    tasks: [], taskMessages: [],
  };
}

function renderMessages({ data = messagesData(), ...props } = {}) {
  const handlers = { onProfile: vi.fn(), onAssistant: vi.fn(), onSendMessage: vi.fn().mockResolvedValue({}), onReadConversation: vi.fn().mockResolvedValue(null), onReadBroadcast: vi.fn(), onOpenTopics: vi.fn(), ...props };
  return render(<MessagesView data={data} desktop {...handlers} />);
}
const articleOf = (text) => screen.getByText(text, { selector: "article p" }).closest("article");
function openConversation() {
  fireEvent.click(screen.getByText("Second note", { selector: ".inbox-row__preview" }));
  return screen.getByRole("region", { name: "Message detail" });
}

describe("Messages: the common control on each exact private message", () => {
  it("names each delivered message of either side to the callback, and gives each row its own control", () => {
    const renderConnectedActions = connectedFactory();
    renderMessages({ renderConnectedActions, messagingApi: fallbackApi() });
    const pane = openConversation();
    expect(askedFor(renderConnectedActions)).toEqual(["private_message:m-new", "private_message:m-old", "private_message:m-steward"]);
    expect(within(pane).getAllByRole("button", { name: "Actions" })).toHaveLength(3);
    for (const text of ["First note", "Noted, thanks", "Second note"]) {
      const article = articleOf(text);
      expect(within(article).getAllByRole("button", { name: "Actions" })).toHaveLength(1);
      expect(within(within(article).getByRole("group", { name: "Message actions" })).getByRole("button", { name: "Actions" })).toBeInTheDocument();
    }
  });

  it("hands the exact older row, not the newest, to the control that was pressed", () => {
    const onPress = vi.fn();
    renderMessages({ renderConnectedActions: connectedFactory(onPress), messagingApi: fallbackApi() });
    openConversation();
    fireEvent.click(within(articleOf("First note")).getByRole("button", { name: "Actions" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith("private_message", expect.objectContaining({ id: "m-old", conversation_id: "conv-1", body: "First note" }));
  });

  it("offers no second task or reminder entry beside it, even for a staff hat that was handed task creation", () => {
    renderMessages({ renderConnectedActions: connectedFactory(), messagingApi: fallbackApi(), onCreateTaskFromSource: vi.fn(), staffAccess: true });
    const pane = openConversation();
    expect(within(pane).queryByRole("button", { name: "Create task" })).toBeNull();
    expect(within(pane).queryByRole("button", { name: "Remind me…" })).toBeNull();
    expect(pane.querySelector(".source-task")).toBeNull();
    // The rest of the row's menu is intact.
    expect(within(articleOf("First note")).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(within(articleOf("First note")).getByRole("button", { name: "React" })).toBeInTheDocument();
  });

  it("passes no pending, client-made or removed row to the callback, and gives those rows no control", () => {
    const renderConnectedActions = connectedFactory();
    const data = messagesData([
      { id: "m-pending", conversation_id: "conv-1", sender_kind: "member", sender_name: "Member", body: "still sending", created_at: "2026-07-12T12:00:00.000Z", pending: true },
      { id: "local-resource-1", conversation_id: "conv-1", sender_kind: "member", sender_name: "Member", body: "shared file", created_at: "2026-07-12T12:01:00.000Z" },
      { id: "m-gone", conversation_id: "conv-1", sender_kind: "member", sender_name: "Member", body: "", redacted_at: "2026-07-12T12:02:00.000Z", redaction_reason: "sender_removed", created_at: "2026-07-12T12:02:00.000Z" },
    ]);
    renderMessages({ data, renderConnectedActions, messagingApi: fallbackApi() });
    const pane = openConversation();
    expect(askedFor(renderConnectedActions)).toEqual(["private_message:m-new", "private_message:m-old", "private_message:m-steward"]);
    expect(within(pane).getAllByRole("button", { name: "Actions" })).toHaveLength(3);
    expect(within(articleOf("still sending")).queryByRole("button", { name: "Actions" })).toBeNull();
    expect(within(articleOf("shared file")).queryByRole("button", { name: "Actions" })).toBeNull();
  });

  it("leaves a row on its standalone controls when the callback returns nothing for it", () => {
    const renderConnectedActions = vi.fn((kind, record) => (record.id === "m-steward" ? null : <ConnectedDouble kind={kind} record={record} onPress={vi.fn()} />));
    renderMessages({ renderConnectedActions, messagingApi: fallbackApi(), onCreateTaskFromSource: vi.fn(), staffAccess: true });
    openConversation();
    const steward = articleOf("Noted, thanks");
    expect(within(steward).queryByRole("button", { name: "Actions" })).toBeNull();
    expect(within(steward).getByRole("button", { name: "Remind me…" })).toBeInTheDocument();
    expect(within(steward).getByRole("button", { name: "Create task" })).toBeInTheDocument();
    const older = articleOf("First note");
    expect(within(older).getByRole("button", { name: "Actions" })).toBeInTheDocument();
    expect(within(older).queryByRole("button", { name: "Create task" })).toBeNull();
    expect(within(older).queryByRole("button", { name: "Remind me…" })).toBeNull();
  });

  it("is unchanged without a callback: the standalone reminder and task controls stay", () => {
    renderMessages({ messagingApi: fallbackApi(), onCreateTaskFromSource: vi.fn(), staffAccess: true });
    const pane = openConversation();
    expect(within(pane).getAllByRole("button", { name: "Remind me…" })).toHaveLength(3);
    expect(within(pane).getAllByRole("button", { name: "Create task" })).toHaveLength(3);
    expect(pane.querySelector(".inbox-msg-actions__connected")).toBeNull();
  });

  it("uses the same slot on the server-driven row that production renders", async () => {
    const renderConnectedActions = connectedFactory();
    renderMessages({ renderConnectedActions, messagingApi: { ...fallbackApi(), ...sharedApi() } });
    const pane = openConversation();
    const older = articleOf("First note");
    await within(older).findByRole("button", { name: "Reply" });
    expect(within(older).getByRole("button", { name: "Actions" })).toBeInTheDocument();
    expect(within(pane).queryByRole("button", { name: "Remind me…" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task conversation
// ---------------------------------------------------------------------------

describe("Messages: the common control on each exact task message", () => {
  function taskData() {
    const data = messagesData();
    data.tasks = [{ id: "task-1", title: "Translate member notice", status: "in_progress" }];
    data.taskMessages = [
      { id: "tm-1", taskId: "task-1", senderId: "member-1", recipientId: "steward-1", body: "Draft is ready", createdAt: "2026-08-12T12:00:00Z" },
      { id: "tm-2", taskId: "task-1", senderId: "steward-1", recipientId: "member-1", body: "Reviewed, thanks", createdAt: "2026-08-12T13:00:00Z" },
    ];
    return data;
  }

  it("hands each task message to the callback as a task_message and seats its control in that row's group", async () => {
    const onPress = vi.fn();
    const renderConnectedActions = connectedFactory(onPress);
    window.history.replaceState({}, "", "/m/messages?taskThread=task-1");
    renderMessages({ data: taskData(), renderConnectedActions, messagingApi: fallbackApi() });
    const dialog = await screen.findByRole("dialog", { name: "Translate member notice" });
    expect(askedFor(renderConnectedActions)).toEqual(["task_message:tm-1", "task_message:tm-2"]);
    const first = within(dialog).getByText("Draft is ready").closest("article");
    expect(within(within(first).getByRole("group", { name: "Message actions" })).getByRole("button", { name: "Actions" })).toBeInTheDocument();
    expect(within(first).queryByRole("button", { name: "Remind me…" })).toBeNull();
    fireEvent.click(within(first).getByRole("button", { name: "Actions" }));
    expect(onPress).toHaveBeenCalledWith("task_message", expect.objectContaining({ id: "tm-1", taskId: "task-1" }));
  });

  it("keeps the standalone reminder on a task message when no callback is given", async () => {
    window.history.replaceState({}, "", "/m/messages?taskThread=task-1");
    renderMessages({ data: taskData(), messagingApi: fallbackApi() });
    const dialog = await screen.findByRole("dialog", { name: "Translate member notice" });
    expect(within(dialog).getAllByRole("button", { name: "Remind me…" })).toHaveLength(2);
    expect(dialog.querySelector(".inbox-msg-actions__connected")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Steward thread
// ---------------------------------------------------------------------------

function stewardDesk() {
  return {
    queue: [],
    threads: [{
      id: "conv-1", memberName: "Renata Cole", memberInitials: "RC", preview: "Newest from Renata", updatedAt: "2026-07-21T09:00:00Z", awaitingReply: true,
      messages: [
        { id: "m-old", conversation_id: "conv-1", sender_kind: "member", sender_name: "Renata Cole", body: "Earliest from Renata", created_at: "2026-07-21T08:00:00Z" },
        { id: "m-reply", conversation_id: "conv-1", sender_kind: "steward", sender_name: "Sam Okafor", body: "Steward reply text", created_at: "2026-07-21T08:30:00Z" },
        { id: "m-new", conversation_id: "conv-1", sender_kind: "member", sender_name: "Renata Cole", body: "Newest from Renata", created_at: "2026-07-21T09:00:00Z" },
      ],
    }],
    broadcasts: [], formsInbox: [],
    kpis: { openRequests: 0, membersCovered: 1, awaitingReply: 1, broadcasts30d: 0 },
  };
}
const stewardApi = () => ({ loadDesk: vi.fn(async () => structuredClone(stewardDesk())), ...fallbackApi(), listScheduled: vi.fn().mockResolvedValue([]) });

async function openThread(props = {}) {
  render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={stewardApi()} onNotice={() => {}} {...props} />);
  fireEvent.click(await screen.findByText("Newest from Renata"));
  return screen.findByRole("dialog", { name: "Renata Cole" });
}

describe("the steward thread: the common control on each exact private message", () => {
  it("gives every delivered message of either side its own control, and nothing is offered twice", async () => {
    const onPress = vi.fn();
    const renderConnectedActions = connectedFactory(onPress);
    const dialog = await openThread({ renderConnectedActions, onCreateTaskFromSource: vi.fn(), canCreateMessageEvent: true });
    expect(askedFor(renderConnectedActions)).toEqual(["private_message:m-new", "private_message:m-old", "private_message:m-reply"]);
    expect(within(dialog).getAllByRole("button", { name: "Actions" })).toHaveLength(3);
    expect(within(dialog).queryByRole("button", { name: "Create task" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Remind me…" })).toBeNull();
    // The steward's other per-message shortcut is a different feature and stays.
    expect(within(dialog).getAllByRole("button", { name: "Create meeting" })).toHaveLength(2);
    const older = within(dialog).getByText("Earliest from Renata").closest("article");
    fireEvent.click(within(older).getByRole("button", { name: "Actions" }));
    expect(onPress).toHaveBeenCalledWith("private_message", expect.objectContaining({ id: "m-old", body: "Earliest from Renata" }));
  });

  it("leaves a row standalone when the callback returns nothing for it, and everything standalone without a callback", async () => {
    const renderConnectedActions = vi.fn((kind, record) => (record.id === "m-reply" ? null : <ConnectedDouble kind={kind} record={record} onPress={vi.fn()} />));
    const dialog = await openThread({ renderConnectedActions, onCreateTaskFromSource: vi.fn() });
    const reply = within(dialog).getByText("Steward reply text").closest("article");
    expect(within(reply).getByRole("button", { name: "Remind me…" })).toBeInTheDocument();
    expect(within(reply).getByRole("button", { name: "Create task" })).toBeInTheDocument();
    expect(within(reply).queryByRole("button", { name: "Actions" })).toBeNull();
  });

  it("keeps the standalone controls when no callback is given", async () => {
    const dialog = await openThread({ onCreateTaskFromSource: vi.fn() });
    expect(within(dialog).getAllByRole("button", { name: "Remind me…" })).toHaveLength(3);
    expect(within(dialog).getAllByRole("button", { name: "Create task" })).toHaveLength(3);
    expect(dialog.querySelector(".inbox-msg-actions__connected")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Channel posts in the hub
// ---------------------------------------------------------------------------

const hubThread = {
  id: "thread-1", title: "Overtime scheduling", kind: "issue", status: "open", space_id: "space-1",
  posts: [
    { id: "post-1", thread_id: "thread-1", author_id: "user-2", body: "Initial report", created_at: "2026-07-27T12:00:00Z" },
    { id: "post-2", thread_id: "thread-1", author_id: "user-1", body: "My reply", created_at: "2026-07-27T13:00:00Z" },
  ],
};
const hubData = {
  member: { id: "user-1", initials: "MV", fullName: "Member Voice" },
  roles: ["steward"], conversations: [], broadcasts: [],
  product: { spaces: [{ id: "space-1", name: "Workplace issues", description: "", visibility: "chapter", threads: [hubThread] }], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [] },
};

function renderHub(props = {}) {
  return render(<LanguageProvider lang="en"><ProductHubView data={hubData} onSendPost={vi.fn()} onCreateTask={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} messagingApi={fallbackApi()} {...props} /></LanguageProvider>);
}
async function openHubThread() {
  fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
  return screen.findByRole("dialog", { name: "Overtime scheduling" });
}

describe("the hub: the common control on each exact channel post", () => {
  it("hands each post to the callback as a channel_post and seats its control in that post's group", async () => {
    const onPress = vi.fn();
    const renderConnectedActions = connectedFactory(onPress);
    renderHub({ renderConnectedActions });
    const dialog = await openHubThread();
    expect(askedFor(renderConnectedActions)).toEqual(["channel_post:post-1", "channel_post:post-2"]);
    expect(within(dialog).getAllByRole("button", { name: "Actions" })).toHaveLength(2);
    expect(within(dialog).queryByRole("button", { name: "Remind me…" })).toBeNull();
    const first = within(dialog).getByText("Initial report").closest("article");
    expect(within(within(first).getByRole("group", { name: "Message actions" })).getByRole("button", { name: "Actions" })).toBeInTheDocument();
    fireEvent.click(within(first).getByRole("button", { name: "Actions" }));
    expect(onPress).toHaveBeenCalledWith("channel_post", expect.objectContaining({ id: "post-1", thread_id: "thread-1" }));
  });

  it("leaves a post standalone when the callback returns nothing for it", async () => {
    renderHub({ renderConnectedActions: (kind, record) => (record.id === "post-2" ? null : <ConnectedDouble kind={kind} record={record} onPress={vi.fn()} />) });
    const dialog = await openHubThread();
    const mine = within(dialog).getByText("My reply").closest("article");
    expect(within(mine).getByRole("button", { name: "Remind me…" })).toBeInTheDocument();
    expect(within(mine).queryByRole("button", { name: "Actions" })).toBeNull();
  });

  it("keeps the standalone reminder on every post when no callback is given", async () => {
    renderHub();
    const dialog = await openHubThread();
    expect(within(dialog).getAllByRole("button", { name: "Remind me…" })).toHaveLength(2);
    expect(dialog.querySelector(".inbox-msg-actions__connected")).toBeNull();
  });
});
