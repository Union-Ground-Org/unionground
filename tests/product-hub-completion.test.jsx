import { expectHeldWriteFocus, expectOneWriteFromOneTick, expectReadyRetryAfterThrowAtOnce } from "./helpers/busyWriteFocus.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { catalogue, t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { LegalView } from "../src/views/LegalView.jsx";
import * as deviceParity from "../src/lib/deviceParity.js";
import { applyDeviceParityState, applyDeviceParitySnapshot, deviceParitySnapshot, subscribeDeviceParityChanges } from "../src/lib/deviceParity.js";
import { chooseReminder } from "./helpers/reminderPicker.js";

const thread = {
  id: "thread-1",
  title: "Overtime scheduling",
  kind: "issue",
  status: "open",
  posts: [{ id: "post-1", body: "Initial report", created_at: "2026-07-27T12:00:00Z" }],
};

const product = {
  spaces: [{ id: "space-1", name: "Workplace issues", description: "Ongoing issues", visibility: "chapter", threads: [thread] }],
  documents: [],
  records: [],
  intake: [],
  handshakes: [],
  governance: [],
  partnerOrgs: [],
};

const data = {
  member: { id: "user-1", initials: "MV", fullName: "Member Voice" },
  roles: ["steward"],
  conversations: [],
  broadcasts: [],
  product,
};

const wrap = (node, lang = "en") => render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);

// Create task from thread opens a prefilled draft; the task exists only after
// the draft's own Create task button is pressed.
function createTaskFromThread() {
  fireEvent.click(screen.getByRole("button", { name: "Create task from thread" }));
  fireEvent.click(screen.getByRole("button", { name: "Create task" }));
}

describe("messages topics", () => {
  it("lists nested space threads and reports the real topic count", () => {
    // Wave 2b: the Topics tab (whose label carried the count) became the
    // always-visible Channels section, so the count is now the rows
    // themselves — one per thread nested under any space, each reporting its
    // real reply count and opening its exact thread.
    const onOpenTopics = vi.fn();
    const safety = {
      id: "thread-2",
      title: "Break room safety",
      kind: "question",
      status: "open",
      posts: [
        { id: "post-a", body: "First", created_at: "2026-07-27T12:00:00Z" },
        { id: "post-b", body: "Second", created_at: "2026-07-27T12:30:00Z" },
      ],
    };
    wrap(<MessagesView
      data={{
        ...data,
        product: {
          ...product,
          spaces: [...product.spaces, { id: "space-2", name: "Safety", description: "", visibility: "chapter", threads: [safety] }],
        },
      }}
      onReadConversation={vi.fn()}
      onReadBroadcast={vi.fn()}
      onSendMessage={vi.fn()}
      onOpenTopics={onOpenTopics}
    />);
    expect(screen.getByRole("button", { name: "Channels" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByRole("button", { name: /^# / })).toHaveLength(2);
    expect(screen.getAllByText("Channels")).toHaveLength(3);
    expect(screen.getByText("Initial report")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    expect(onOpenTopics).toHaveBeenCalledWith("thread-1");
  });
});

describe("product thread workflow", () => {
  it("preserves an organization-wide preview space when staff edit it", async () => {
    const onUpdateSpace = vi.fn().mockResolvedValue({});
    const organizationSpace = {
      ...product.spaces[0],
      name: "Cross-chapter organizing",
      visibility: "organization",
    };
    wrap(<ProductHubView
      data={{ ...data, product: { ...product, spaces: [organizationSpace] } }}
      onUpdateSpace={onUpdateSpace}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("combobox", { name: "Who can see this" })).toHaveValue("organization");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onUpdateSpace).toHaveBeenCalledWith(
      "space-1",
      expect.objectContaining({ visibility: "organization" }),
      false,
    ));
    // A recorded call does not mean the save has resolved. Let its close
    // finish before cleanup mounts another hub sharing the parity dialog.
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Who can see this" })).not.toBeInTheDocument());
  });

  // Union Ground has no points economy, so no perk grants an ordinary
  // member thread creation; staff keep it.
  it("grants no perk-based thread creation to an ordinary member and keeps it for staff", () => {
    const { unmount } = wrap(<ProductHubView
      data={{ ...data, roles: [] }}
      threadCreateAccess
      onCreateThread={vi.fn()}
    />);
    expect(screen.queryByRole("button", { name: "New thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New space" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    unmount();
    wrap(<ProductHubView data={data} onCreateThread={vi.fn()} onCreateSpace={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: "New thread" }).length).toBeGreaterThan(0);
  });

  it("does not infer thread creation from an ordinary member's catalog or claim", () => {
    wrap(<ProductHubView data={{ ...data, roles: [] }} onCreateThread={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "New thread" })).toBeNull();
  });

  // Record 8435, slice 9: the space form's lock ends where its busy state
  // does, so a save that throws at once leaves a ready Save that sends again.
  it("saves the space again from an immediate press after a save that throws at once", async () => {
    const onUpdateSpace = vi.fn();
    wrap(<ProductHubView data={data} onUpdateSpace={onUpdateSpace} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await expectReadyRetryAfterThrowAtOnce(onUpdateSpace, screen.getByRole("button", { name: "Save" }));
  });

  it("posts the reply again from an immediate press after a post that throws at once", async () => {
    const onSendPost = vi.fn();
    wrap(<ProductHubView data={data} onSendPost={onSendPost} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New reply" } });
    const form = screen.getByRole("textbox").closest("form");
    await expectReadyRetryAfterThrowAtOnce(onSendPost, within(form).getByRole("button", { name: "Reply" }));
  });

  it("opens the exact topic selected from Messages", async () => {
    wrap(<ProductHubView
      data={data}
      focus={{ threadId: "thread-1" }}
      onSendPost={vi.fn()}
      onCreateTask={vi.fn()}
      onCreateSpace={vi.fn()}
      onCreateThread={vi.fn()}
    />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Overtime scheduling" })).toBeInTheDocument());
    expect(screen.getByText("Initial report")).toBeInTheDocument();
  });

  it("shows a newly sent reply without closing and reopening the thread", async () => {
    const onSendPost = vi.fn().mockResolvedValue({
      id: "post-2",
      thread_id: "thread-1",
      body: "New reply",
      created_at: "2026-07-27T13:00:00Z",
    });
    wrap(<ProductHubView
      data={data}
      onSendPost={onSendPost}
      onCreateTask={vi.fn()}
      onCreateSpace={vi.fn()}
      onCreateThread={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New reply" } });
    fireEvent.submit(screen.getByRole("textbox").closest("form"));
    await waitFor(() => expect(screen.getByText("New reply")).toBeInTheDocument());
  });

  it("keeps channel reactions, saves, and reminders on the channel source boundary", async () => {
    const messagingApi = {
      toggleReaction: vi.fn().mockResolvedValue({ reacted: true }),
      toggleSaved: vi.fn().mockResolvedValue({ saved: true }),
      remind: vi.fn().mockResolvedValue({ id: "reminder-1" }),
    };
    wrap(<ProductHubView data={data} onSendPost={vi.fn()} messagingApi={messagingApi} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    fireEvent.click(screen.getByRole("button", { name: "React" }));
    fireEvent.click(screen.getByRole("button", { name: "Agreed" }));
    await waitFor(() => expect(messagingApi.toggleReaction).toHaveBeenCalledWith("channel", "post-1", "agreed"));
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const control = screen.getByRole("button", { name: "Save" }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(messagingApi.toggleSaved).toHaveBeenCalledWith("channel", "post-1"));
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const control = screen.getByRole("button", { name: "Saved" }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
    const remindAt = chooseReminder(document.body);
    await waitFor(() => expect(messagingApi.remind).toHaveBeenCalledWith("channel", "post-1", remindAt));
  });

  it("creates an unassigned task with null instead of an invalid empty uuid", async () => {
    const onCreateTask = vi.fn().mockResolvedValue({});
    wrap(<ProductHubView
      data={data}
      onSendPost={vi.fn()}
      onCreateTask={onCreateTask}
      onCreateSpace={vi.fn()}
      onCreateThread={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    createTaskFromThread();
    await waitFor(() => expect(onCreateTask).toHaveBeenCalledWith(expect.objectContaining({ assigneeId: null })));
  });

  it("offers create-task only to staff", () => {
    // Chapter tasks are a staff-only surface and the insert policy behind them
    // is staff-only too, so an ungated button offered every member an action
    // the database would refuse — after they had already opened the thread and
    // pressed it. `roles: []` is an ordinary member.
    wrap(<ProductHubView
      data={{ ...data, roles: [] }}
      onSendPost={vi.fn()}
      onCreateTask={vi.fn()}
      onCreateSpace={vi.fn()}
      onCreateThread={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    expect(screen.queryByRole("button", { name: "Create task from thread" })).not.toBeInTheDocument();
  });

  it("takes the workstream from the chapter's own list", async () => {
    // The prepare trigger case-folds the workstream and asserts it against
    // chapter_workstreams, so a hardcoded "Organizing" is a refused insert for
    // every chapter that renamed or never created that entry.
    const onCreateTask = vi.fn().mockResolvedValue({});
    wrap(<ProductHubView
      data={{ ...data, workstreams: [{ id: "ws-1", name: "Contract campaign" }, { id: "ws-2", name: "Organizing" }] }}
      onSendPost={vi.fn()}
      onCreateTask={onCreateTask}
      onCreateSpace={vi.fn()}
      onCreateThread={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    createTaskFromThread();
    await waitFor(() => expect(onCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ workstream: "Contract campaign" }),
    ));
  });

  it("falls back to Organizing only when the chapter has no workstreams", async () => {
    // The literal survives exactly here, where nothing else can be true. If
    // this stopped being the fallback the previous test would still pass, so
    // the empty case is pinned separately.
    const onCreateTask = vi.fn().mockResolvedValue({});
    wrap(<ProductHubView
      data={{ ...data, workstreams: [] }}
      onSendPost={vi.fn()}
      onCreateTask={onCreateTask}
      onCreateSpace={vi.fn()}
      onCreateThread={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    createTaskFromThread();
    await waitFor(() => expect(onCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ workstream: "Organizing" }),
    ));
  });

  it("creates only one task when the create-task control is clicked twice while in flight", async () => {
    // BUG-UG-WEB-HUB-CREATE-TASK-FROM-THREAD-DOUBLE-CREATES-AND-DATES-IN-UTC-20260920
    let resolveCreate;
    const onCreateTask = vi.fn(() => new Promise((resolve) => { resolveCreate = resolve; }));
    wrap(<ProductHubView
      data={data}
      onSendPost={vi.fn()}
      onCreateTask={onCreateTask}
      onCreateSpace={vi.fn()}
      onCreateThread={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create task from thread" }));
    const create = screen.getByRole("button", { name: "Create task" });
    fireEvent.click(create);
    fireEvent.click(create);
    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Creating task…" })).toHaveAttribute("aria-disabled", "true");
    await act(async () => { resolveCreate({}); });
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const control = screen.getByRole("button", { name: "Create task from thread" }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
    expect(screen.queryByRole("textbox", { name: "Task title" })).not.toBeInTheDocument();
  });

  it("opens a prefilled draft and creates nothing until the person confirms", async () => {
    // BUG-UG-CREATE-TASK-FROM-THREAD-SKIPS-REVIEW-20261006: the control
    // used to create an unassigned task with an invented seven-day deadline at
    // once. Standard Task quick creation is a title with blank dates.
    const onCreateTask = vi.fn().mockResolvedValue({});
    wrap(<ProductHubView
      data={data}
      onSendPost={vi.fn()}
      onCreateTask={onCreateTask}
      onCreateSpace={vi.fn()}
      onCreateThread={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create task from thread" }));
    expect(onCreateTask).not.toHaveBeenCalled();
    const draft = screen.getByRole("form", { name: "New task from this thread" });
    expect(within(draft).getByRole("textbox", { name: "Task title" })).toHaveValue("Overtime scheduling");
    expect(within(draft).getByLabelText("Due date (optional)")).toHaveValue("");

    fireEvent.click(within(draft).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "New task from this thread" })).not.toBeInTheDocument();
    expect(onCreateTask).not.toHaveBeenCalled();

    createTaskFromThread();
    await waitFor(() => expect(onCreateTask).toHaveBeenCalledTimes(1));
    expect(onCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "Overtime scheduling",
      assigneeId: null,
      startDate: null,
      dueDate: null,
      description: expect.stringContaining("thread-1"),
    }));
  });

  it("creates the task with the title and due date the person chose in the draft", async () => {
    const onCreateTask = vi.fn().mockResolvedValue({});
    wrap(<ProductHubView
      data={data}
      onSendPost={vi.fn()}
      onCreateTask={onCreateTask}
      onCreateSpace={vi.fn()}
      onCreateThread={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create task from thread" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), { target: { value: "  Draft overtime rota  " } });
    fireEvent.change(screen.getByLabelText("Due date (optional)"), { target: { value: "2026-10-16" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "Draft overtime rota",
      dueDate: "2026-10-16",
      startDate: null,
    })));
    await waitFor(() => expect(screen.queryByRole("form", { name: "New task from this thread" })).not.toBeInTheDocument());
  });

  it.each(["button", "title"])("keeps the draft and returns focus when a create from the %s fails", async (origin) => {
    let rejectCreate;
    const onCreateTask = vi.fn(() => new Promise((_resolve, reject) => { rejectCreate = reject; }));
    wrap(<ProductHubView
      data={data}
      onSendPost={vi.fn()}
      onCreateTask={onCreateTask}
      onCreateSpace={vi.fn()}
      onCreateThread={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create task from thread" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), { target: { value: "Keep me" } });
    const draft = screen.getByRole("form", { name: "New task from this thread" });
    const title = within(draft).getByRole("textbox", { name: "Task title" });
    const create = within(draft).getByRole("button", { name: "Create task" });
    (origin === "button" ? create : title).focus();
    if (origin === "button") fireEvent.click(create);
    else fireEvent.submit(draft);
    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(title).toHaveAttribute("aria-disabled", "true");
    // Browsers blur disabled controls to the body; jsdom retains their focus.
    // Model focus leaving the draft with the existing dialog heading instead.
    screen.getByRole("heading", { name: "Overtime scheduling" }).focus();
    expect(draft).not.toContainElement(document.activeElement);
    await act(async () => { rejectCreate(new Error("refused")); });
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const control = screen.getByRole("button", { name: "Create task" }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
    expect(title).toHaveValue("Keep me");
    expect(title).toHaveFocus();
    expect(draft).toContainElement(document.activeElement);
    // The shell toast sits behind the thread dialog, so the draft names the
    // failure itself, never with the driver's text.
    expect(within(screen.getByRole("form", { name: "New task from this thread" })).getByRole("alert"))
      .toHaveTextContent("The task was not created. Your entries are still here.");
  });

  it("explains a busy refusal inside the draft in Spanish", async () => {
    const onCreateTask = vi.fn().mockRejectedValue(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
    wrap(<ProductHubView data={data} onSendPost={vi.fn()} onCreateTask={onCreateTask} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} />, "es");
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.createTask"] }));
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.taskDraftCreate"] }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(catalogue.es["error.serviceBusy"]);
    expect(alert).not.toHaveTextContent("statement timeout");
  });

  it("locks the draft fields while the create is in flight", async () => {
    let resolveCreate;
    const onCreateTask = vi.fn(() => new Promise((resolve) => { resolveCreate = resolve; }));
    wrap(<ProductHubView data={data} onSendPost={vi.fn()} onCreateTask={onCreateTask} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    createTaskFromThread();
    expect(screen.getByRole("textbox", { name: "Task title" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Due date (optional)")).toHaveAttribute("aria-disabled", "true");
    await act(async () => { resolveCreate({}); });
  });

  it("moves focus into the draft and back to the control when it closes", async () => {
    wrap(<ProductHubView data={data} onSendPost={vi.fn()} onCreateTask={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create task from thread" }));
    expect(screen.getByRole("textbox", { name: "Task title" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Create task from thread" })).toHaveFocus();
  });

  it.each(["prefill", "edit"])("caps a task title at 160 code points without splitting an emoji on %s", async (mode) => {
    const title = `${"a".repeat(159)}\u{1F44D}`;
    const onCreateTask = vi.fn().mockResolvedValue({});
    const withEmoji = { ...data, product: { ...product, spaces: [{ ...product.spaces[0], threads: [{ ...thread, title: mode === "prefill" ? `${title}extra` : "Overtime scheduling" }] }] } };
    wrap(<ProductHubView data={withEmoji} onSendPost={vi.fn()} onCreateTask={onCreateTask} />);
    fireEvent.click(screen.getByRole("button", { name: mode === "prefill" ? /^a{20}/ : /Overtime scheduling/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create task from thread" }));
    const input = screen.getByRole("textbox", { name: "Task title" });
    if (mode === "edit") {
      fireEvent.change(input, { target: { value: `${title}extra` } });
    }
    expect(input).not.toHaveAttribute("maxlength");
    expect(input).toHaveValue(title);
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onCreateTask).toHaveBeenCalledWith(expect.objectContaining({ title })));
  });

  it("prefills a full 160-character title without splitting an emoji", async () => {
    const title = `${"a".repeat(159)}\u{1F44D}`;
    const onCreateTask = vi.fn().mockResolvedValue({});
    const withEmoji = { ...data, product: { ...product, spaces: [{ ...product.spaces[0], threads: [{ ...thread, title }] }] } };
    wrap(<ProductHubView data={withEmoji} onSendPost={vi.fn()} onCreateTask={onCreateTask} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp("^a{20}") }));
    createTaskFromThread();
    await waitFor(() => expect(onCreateTask).toHaveBeenCalledWith(expect.objectContaining({ title })));
  });
});

describe("intake onward path", () => {
  const intake = {
    id: "intake-1",
    category: "workplace_issue",
    title: "Schedule notice",
    details: "The notice arrived after the shift changed.",
    status: "new",
    assigned_to: null,
    created_at: "2026-08-12T12:00:00Z",
  };

  it("lets intake staff set a status and same-chapter owner", async () => {
    const onTriageIntake = vi.fn().mockResolvedValue({ ...intake, status: "triaged", assigned_to: "staff-2" });
    wrap(<ProductHubView
      data={{ ...data, product: { ...product, intake: [intake] }, intakeOwners: [{ id: "staff-2", fullName: "Second Steward", initials: "SS" }] }}
      onCreateIntake={vi.fn()}
      onTriageIntake={onTriageIntake}
      onConvertIntake={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Be heard" }));
    fireEvent.click(screen.getByRole("button", { name: "Triage report" }));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "triaged" } });
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "staff-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save triage" }));
    await waitFor(() => expect(onTriageIntake).toHaveBeenCalledWith("intake-1", { status: "triaged", assignedTo: "staff-2" }));
  });

  it("converts to a privacy-quiet task without asking for report text", async () => {
    const onConvertIntake = vi.fn().mockResolvedValue({ target: "task", targetId: "task-1" });
    wrap(<ProductHubView
      data={{ ...data, product: { ...product, intake: [intake] }, intakeOwners: [] }}
      onCreateIntake={vi.fn()}
      onTriageIntake={vi.fn()}
      onConvertIntake={onConvertIntake}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Be heard" }));
    fireEvent.click(screen.getByRole("button", { name: "Triage report" }));
    fireEvent.click(screen.getByRole("button", { name: "Convert to task" }));
    await waitFor(() => expect(onConvertIntake).toHaveBeenCalledWith("intake-1", "task", null));
  });

  // Record 8435, slice 9: each lock ends where its busy state does, so a
  // callback that throws at once leaves a ready control whose next press sends.
  it("saves the triage again from an immediate press after a save that throws at once", async () => {
    const onTriageIntake = vi.fn();
    wrap(<ProductHubView data={{ ...data, product: { ...product, intake: [intake] }, intakeOwners: [] }} onCreateIntake={vi.fn()} onTriageIntake={onTriageIntake} onConvertIntake={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Be heard" }));
    fireEvent.click(screen.getByRole("button", { name: "Triage report" }));
    await expectReadyRetryAfterThrowAtOnce(onTriageIntake, screen.getByRole("button", { name: "Save triage" }));
  });

  it("converts again from an immediate press after a conversion that throws at once", async () => {
    const onConvertIntake = vi.fn();
    wrap(<ProductHubView data={{ ...data, product: { ...product, intake: [intake] }, intakeOwners: [] }} onCreateIntake={vi.fn()} onTriageIntake={vi.fn()} onConvertIntake={onConvertIntake} />);
    fireEvent.click(screen.getByRole("button", { name: "Be heard" }));
    fireEvent.click(screen.getByRole("button", { name: "Triage report" }));
    await expectReadyRetryAfterThrowAtOnce(onConvertIntake, screen.getByRole("button", { name: "Convert to task" }));
  });

  it("requires an accessible space when thread conversion is selected", async () => {
    const onConvertIntake = vi.fn().mockResolvedValue({ target: "thread", targetId: "thread-2" });
    wrap(<ProductHubView
      data={{ ...data, product: { ...product, intake: [intake] }, intakeOwners: [] }}
      onCreateIntake={vi.fn()}
      onTriageIntake={vi.fn()}
      onConvertIntake={onConvertIntake}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Be heard" }));
    fireEvent.click(screen.getByRole("button", { name: "Triage report" }));
    fireEvent.click(screen.getByRole("button", { name: "Convert to thread" }));
    await waitFor(() => expect(onConvertIntake).toHaveBeenCalledWith("intake-1", "thread", "space-1"));
  });

  it("does not expose staff triage controls to an ordinary member", () => {
    wrap(<ProductHubView
      data={{ ...data, roles: [], product: { ...product, intake: [intake] } }}
      onCreateIntake={vi.fn()}
      onTriageIntake={vi.fn()}
      onConvertIntake={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Be heard" }));
    expect(screen.queryByRole("button", { name: "Triage report" })).not.toBeInTheDocument();
  });

  it("does not expose case-bearing triage controls to an admin-only caller", () => {
    wrap(<ProductHubView
      data={{ ...data, roles: ["admin"], product: { ...product, intake: [intake] } }}
      onCreateIntake={vi.fn()}
      onTriageIntake={vi.fn()}
      onConvertIntake={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Be heard" }));
    expect(screen.queryByRole("button", { name: "Triage report" })).not.toBeInTheDocument();
  });
});

describe("chapter Compass knowledge", () => {
  const verifiedArticle = {
    id: "kb-1",
    chapterId: "chapter-1",
    kind: "contract",
    title: "Verified overtime source",
    ref: "CBA · Article 9",
    body: "Overtime assignments follow the verified chapter language.",
    keywords: ["overtime", "schedule"],
    status: "published",
    isSample: false,
    version: 2,
    verifiedBy: "staff-1",
    verifiedAt: "2026-08-12T12:00:00Z",
  };

  it.each(["steward", "coordinator", "advisor", "admin", "vp"])(
    "offers the chapter knowledge editor to the %s hat",
    (role) => {
      wrap(<ProductHubView data={{ ...data, roles: [role], product: { ...product, compassKnowledge: [] } }} />);
      fireEvent.click(screen.getByRole("button", { name: "Library" }));
      expect(screen.getByRole("button", { name: "Add Guide source" })).toBeInTheDocument();
    },
  );

  it("keeps the management action away from members and states the empty live condition honestly", () => {
    wrap(<ProductHubView data={{ ...data, roles: [], product: { ...product, compassKnowledge: [] } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(screen.queryByRole("button", { name: "Add Guide source" })).not.toBeInTheDocument();
    expect(screen.getByText("No verified Guide sources are published for this campaign yet.")).toBeInTheDocument();
  });

  it("lets the demo's selected staff hat expose the sample-only editor without forging a database role", () => {
    wrap(<ProductHubView data={{ ...data, roles: [], product: { ...product, compassKnowledge: [] } }} staffAccess preview />);
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(screen.getByRole("button", { name: "Add Guide source" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Guide source" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "published" } });
    expect(screen.getByText(/PREVIEW only: this confirms the publication step for the tour/)).toBeInTheDocument();
  });

  it("requires an explicit verification confirmation before publishing", async () => {
    const onSaveKnowledge = vi.fn().mockResolvedValue({});
    wrap(<ProductHubView
      data={{ ...data, member: { ...data.member, chapterId: "chapter-1" }, product: { ...product, compassKnowledge: [] } }}
      onSaveKnowledge={onSaveKnowledge}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Guide source" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Source type" }), { target: { value: "contract" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Verified overtime source" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Source reference" }), { target: { value: "CBA · Article 9" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Source text" }), { target: { value: "Overtime assignments follow the verified chapter language." } });
    fireEvent.change(screen.getByRole("textbox", { name: "Keywords" }), { target: { value: "overtime, schedule" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "published" } });

    const save = screen.getByRole("button", { name: "Publish verified source" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I verified this source/ }));
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(onSaveKnowledge).toHaveBeenCalledWith({
      articleId: null,
      kind: "contract",
      title: "Verified overtime source",
      articleRef: "CBA · Article 9",
      body: "Overtime assignments follow the verified chapter language.",
      keywords: ["overtime", "schedule"],
      status: "published",
      confirmVerified: true,
      chapterId: "chapter-1",
    }));
  });

  it("opens a revision with the current values and retires it through the bounded action", async () => {
    const onRetireKnowledge = vi.fn().mockResolvedValue({});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    wrap(<ProductHubView
      data={{ ...data, product: { ...product, compassKnowledge: [verifiedArticle] } }}
      onSaveKnowledge={vi.fn().mockResolvedValue({})}
      onRetireKnowledge={onRetireKnowledge}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    fireEvent.click(screen.getByRole("button", { name: /Verified overtime source/ }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Verified overtime source");
    expect(screen.getByRole("textbox", { name: "Keywords" })).toHaveValue("overtime, schedule");
    fireEvent.click(screen.getByRole("button", { name: "Retire source" }));
    await waitFor(() => expect(onRetireKnowledge).toHaveBeenCalledWith("kb-1", "chapter-1"));
    expect(confirm).toHaveBeenCalledWith("Retire this source? Workers will no longer receive it in Guide answers.");
    confirm.mockRestore();
  });
});

describe("member data lifecycle", () => {
  // Record 8435, slice 8: Download my data keeps focus while it exports, and
  // two presses in one tick export once.
  function showLifecycle() {
    const onGenerateDataExport = vi.fn().mockResolvedValue({ downloaded: true });
    wrap(<ProductHubView data={{ ...data, roles: [] }} onCreateGovernance={vi.fn()} onGenerateDataExport={onGenerateDataExport} onDeleteAccount={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Data rights" }));
    return { onGenerateDataExport, download: screen.getByRole("button", { name: "Download my data" }) };
  }
  it("exports once when Download my data is pressed twice in one tick", async () => {
    const { onGenerateDataExport, download } = showLifecycle();
    await expectOneWriteFromOneTick(onGenerateDataExport, [() => fireEvent.click(download), () => fireEvent.click(download)]);
  });
  // Review of slice 8 (F3): the export returns to ready after a success, a
  // refusal and a throw, and sends again each time.
  it("returns Download my data to ready after a success, a refusal and a throw, and exports again", async () => {
    const { onGenerateDataExport, download } = showLifecycle();
    onGenerateDataExport.mockResolvedValueOnce({ downloaded: true }).mockRejectedValueOnce(new Error("refused")).mockImplementationOnce(() => { throw new Error("thrown"); });
    for (let count = 1; count <= 4; count += 1) {
      fireEvent.click(download);
      await waitFor(() => expect(onGenerateDataExport).toHaveBeenCalledTimes(count));
      await waitFor(() => { expect(download).toBeEnabled(); expect(download).not.toHaveAttribute("aria-disabled"); });
    }
  });
  // Review of slice 8 (F2): the lock ends with exporting, so an export that
  // throws at once leaves a ready button whose next press exports.
  it("exports again from an immediate press after an export that throws at once", async () => {
    const { onGenerateDataExport, download } = showLifecycle();
    onGenerateDataExport.mockImplementation(() => { throw new Error("refused at once"); });
    fireEvent.click(download);
    expect(download).not.toHaveAttribute("aria-disabled");
    fireEvent.click(download);
    expect(onGenerateDataExport).toHaveBeenCalledTimes(2);
    await act(async () => {});
  });
  it("keeps Download my data focused while it exports", async () => {
    const { onGenerateDataExport, download } = showLifecycle();
    await expectHeldWriteFocus(onGenerateDataExport, download);
  });

  it("generates an immediate export and keeps export/deletion out of the human request form", async () => {
    const onGenerateDataExport = vi.fn().mockResolvedValue({ downloaded: true });
    wrap(<ProductHubView
      data={{ ...data, roles: [] }}
      onCreateGovernance={vi.fn()}
      onGenerateDataExport={onGenerateDataExport}
      onDeleteAccount={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Data rights" }));
    fireEvent.click(screen.getByRole("button", { name: "Download my data" }));
    await waitFor(() => expect(onGenerateDataExport).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "New data request" }));
    const type = screen.getByRole("combobox", { name: "Request type" });
    expect(type).not.toHaveTextContent("Export my data");
    expect(type).not.toHaveTextContent("Delete eligible data");
  });

  it("requires the exact destructive phrase and explains retained chapter records before deletion", async () => {
    const onDeleteAccount = vi.fn().mockResolvedValue({ deleted: true });
    wrap(<ProductHubView
      data={{ ...data, roles: [] }}
      onCreateGovernance={vi.fn()}
      onGenerateDataExport={vi.fn()}
      onDeleteAccount={onDeleteAccount}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Data rights" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    expect(screen.getByText(/Campaign-authored records remain with the campaign/)).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Permanently delete my account" });
    expect(submit).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(screen.getByRole("textbox", { name: /Type DELETE MY ACCOUNT/ }), { target: { value: "DELETE MY ACCOUNT" } });
    expect(submit).not.toHaveAttribute("aria-disabled");
    fireEvent.click(submit);
    await waitFor(() => expect(onDeleteAccount).toHaveBeenCalledWith("DELETE MY ACCOUNT"));
  });

  it("treats a deletion timeout as unknown and directs the member to verify by signing in", async () => {
    const onDeleteAccount = vi.fn().mockRejectedValue(Object.assign(new Error("account-delete-indeterminate"), {
      code: "account-delete-indeterminate",
      indeterminate: true,
    }));
    const onDeleteIndeterminateClose = vi.fn();
    wrap(<ProductHubView
      data={{ ...data, roles: [] }}
      onCreateGovernance={vi.fn()}
      onGenerateDataExport={vi.fn()}
      onDeleteAccount={onDeleteAccount}
      onDeleteIndeterminateClose={onDeleteIndeterminateClose}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Data rights" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Type DELETE MY ACCOUNT/ }), {
      target: { value: "DELETE MY ACCOUNT" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete my account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Do not submit again");
    expect(screen.getByRole("alert")).toHaveTextContent("attempt to sign in again");
    const submit = screen.getByRole("button", { name: "Permanently delete my account" });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(onDeleteAccount).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onDeleteIndeterminateClose).toHaveBeenCalledTimes(1));
  });

  it("keeps deletion guidance mounted while the irreversible request is pending", async () => {
    const onDeleteAccount = vi.fn(() => new Promise(() => {}));
    wrap(<ProductHubView
      data={{ ...data, roles: [] }}
      onCreateGovernance={vi.fn()}
      onGenerateDataExport={vi.fn()}
      onDeleteAccount={onDeleteAccount}
      onDeleteIndeterminateClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Data rights" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Type DELETE MY ACCOUNT/ }), {
      target: { value: "DELETE MY ACCOUNT" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete my account" }));
    const pendingButton = await screen.findByRole("button", { name: "Deleting account…" });
    // Unavailable while the irreversible request runs, but still focusable (record 8435).
    expect(pendingButton).toHaveAttribute("aria-disabled", "true");
    expect(pendingButton.closest("form")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Deleting account…");

    const dialog = screen.getByRole("dialog", { name: "Permanently delete your account" });
    const layer = dialog.closest(".sg-detail-layer");
    await waitFor(() => expect(layer).toHaveAttribute("data-state", "open"));
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => { await Promise.resolve(); });
    expect(layer).toHaveAttribute("data-state", "open");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await act(async () => { await Promise.resolve(); });
    expect(layer).toHaveAttribute("data-state", "open");
    fireEvent.mouseDown(layer);
    await act(async () => { await Promise.resolve(); });
    expect(layer).toHaveAttribute("data-state", "open");
    expect(onDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it("keeps the indeterminate retry lock mounted when safe sign-out fails", async () => {
    const onDeleteAccount = vi.fn().mockRejectedValue(Object.assign(new Error("account-delete-indeterminate"), {
      code: "account-delete-indeterminate",
      indeterminate: true,
    }));
    const onDeleteIndeterminateClose = vi.fn()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValueOnce(undefined);
    wrap(<ProductHubView
      data={{ ...data, roles: [] }}
      onCreateGovernance={vi.fn()}
      onGenerateDataExport={vi.fn()}
      onDeleteAccount={onDeleteAccount}
      onDeleteIndeterminateClose={onDeleteIndeterminateClose}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Data rights" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Type DELETE MY ACCOUNT/ }), {
      target: { value: "DELETE MY ACCOUNT" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete my account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Do not submit again");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onDeleteIndeterminateClose).toHaveBeenCalledTimes(1));
    const dialog = screen.getByRole("dialog", { name: "Permanently delete your account" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Couldn't complete sign-out safely. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Permanently delete my account" })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onDeleteIndeterminateClose).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Permanently delete your account" })).not.toBeInTheDocument());
  });

  it.each([
    {
      lang: "en",
      tab: "Data rights",
      open: "Delete my account",
      confirmation: /Type DELETE MY ACCOUNT/,
      submit: "Permanently delete my account",
      expected: "We couldn't confirm a recent two-step verification",
      forbidden: "The account was not deleted",
    },
    {
      lang: "es",
      tab: "Derechos de datos",
      open: "Eliminar mi cuenta",
      confirmation: /Escribe DELETE MY ACCOUNT/,
      submit: "Eliminar mi cuenta permanentemente",
      expected: "No pudimos confirmar una verificación reciente en dos pasos",
      forbidden: "La cuenta no se eliminó",
    },
  ])("does not assert deletion failed when authorization is not permitted in $lang", async ({
    lang,
    tab,
    open,
    confirmation,
    submit,
    expected,
    forbidden,
  }) => {
    const onDeleteAccount = vi.fn().mockRejectedValue(Object.assign(new Error("not-permitted"), {
      code: "not-permitted",
    }));
    wrap(<ProductHubView
      data={{ ...data, roles: [] }}
      onCreateGovernance={vi.fn()}
      onGenerateDataExport={vi.fn()}
      onDeleteAccount={onDeleteAccount}
    />, lang);

    fireEvent.click(screen.getByRole("button", { name: tab }));
    fireEvent.click(screen.getByRole("button", { name: open }));
    fireEvent.change(screen.getByRole("textbox", { name: confirmation }), {
      target: { value: "DELETE MY ACCOUNT" },
    });
    fireEvent.click(screen.getByRole("button", { name: submit }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(expected);
    expect(alert).toHaveTextContent(lang === "es" ? "vuelve a iniciarla con tu código de dos pasos" : "sign in again with your two-step code");
    expect(alert).not.toHaveTextContent(forbidden);
  });

  it("links the public retention schedule and renders the lifecycle actions in Spanish", () => {
    wrap(<ProductHubView
      data={{ ...data, roles: [] }}
      onCreateGovernance={vi.fn()}
      onGenerateDataExport={vi.fn()}
      onDeleteAccount={vi.fn()}
    />, "es");
    fireEvent.click(screen.getByRole("button", { name: "Derechos de datos" }));
    expect(screen.getByRole("button", { name: "Descargar mis datos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eliminar mi cuenta" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Calendario de retención" })).toHaveAttribute("href", "/retention");
  });
});

describe("pending deletion replacement protection", () => {
  // BUG-UG-ACCOUNT-DELETION-DIALOG-REPLACEMENT-20260814: the dialog's own
  // dismissal paths are guarded by beforeClose, but the parent can still
  // replace the dialog VALUE from above — focused-thread and document
  // deep-link effects refire on product object-identity refreshes, and the
  // hub.dialog device-parity consumer applies external values. While an
  // irreversible deletion request is unresolved, every one of those paths
  // must be refused, and a refused replacement must never surface later.
  const fixtureDocument = {
    id: "doc-guide-1",
    title: "Fictional grievance guide",
    document_type: "policy",
    status: "published",
    version: 1,
    summary: "Deterministic fixture document.",
    body: "Fixture body used only by this suite.",
    visibility: "chapter",
  };

  function deferredDelete() {
    const settlers = {};
    const onDeleteAccount = vi.fn(() => new Promise((resolve, reject) => {
      settlers.resolve = resolve;
      settlers.reject = reject;
    }));
    return { onDeleteAccount, settlers };
  }

  function hubProps(onDeleteAccount, extra = {}) {
    return {
      data: { ...data, roles: [] },
      onCreateGovernance: vi.fn(),
      onGenerateDataExport: vi.fn(),
      onSendPost: vi.fn(),
      onDeleteAccount,
      onDeleteIndeterminateClose: vi.fn(),
      ...extra,
    };
  }

  function renderHub(props) {
    const view = render(<LanguageProvider lang="en"><ProductHubView {...props} /></LanguageProvider>);
    return (nextProps) => view.rerender(<LanguageProvider lang="en"><ProductHubView {...nextProps} /></LanguageProvider>);
  }

  async function startPendingDeletion() {
    fireEvent.click(screen.getByRole("button", { name: "Data rights" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Type DELETE MY ACCOUNT/ }), {
      target: { value: "DELETE MY ACCOUNT" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete my account" }));
    await screen.findByRole("button", { name: "Deleting account…" });
  }

  function deletionDialog() {
    return screen.getByRole("dialog", { name: "Permanently delete your account" });
  }

  const refreshedProduct = (base = product) => JSON.parse(JSON.stringify(base));

  it("does not let a focused-thread object refresh replace the pending deletion dialog", async () => {
    const { onDeleteAccount } = deferredDelete();
    const props = hubProps(onDeleteAccount, { focus: { threadId: "thread-1" } });
    const rerenderHub = renderHub(props);

    // The deep link applies once, up front, and the member leaves it. Wait
    // for the exit transition to fully unmount the surface so the deletion
    // flow starts from a settled dialog state.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Overtime scheduling" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.querySelector(".sg-detail-layer")).toBeNull());

    await startPendingDeletion();
    // A background refresh delivers the same catalog with new object
    // identities, which refires the focused-thread effect.
    rerenderHub({ ...props, data: { ...props.data, product: refreshedProduct() } });
    await act(async () => { await Promise.resolve(); });

    expect(deletionDialog()).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Overtime scheduling" })).not.toBeInTheDocument();
    expect(onDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it("does not let a document deep link replace the pending deletion dialog after an object refresh", async () => {
    window.history.pushState({}, "", "/?document=doc-guide-1");
    try {
      const { onDeleteAccount } = deferredDelete();
      const props = hubProps(onDeleteAccount, {
        data: { ...data, roles: [], product: { ...product, documents: [] } },
      });
      const rerenderHub = renderHub(props);

      await startPendingDeletion();
      // An object refresh now carries the deep-linked document for the first
      // time, so the document effect finds a match while deletion is pending.
      rerenderHub({ ...props, data: { ...data, roles: [], product: { ...product, documents: [fixtureDocument] } } });
      await act(async () => { await Promise.resolve(); });

      expect(deletionDialog()).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Fictional grievance guide" })).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("refuses hub.dialog device-parity application while deletion is pending", async () => {
    const { onDeleteAccount } = deferredDelete();
    renderHub(hubProps(onDeleteAccount));
    await startPendingDeletion();

    act(() => {
      applyDeviceParityState("hub.dialog", { type: "documentDetail", document: fixtureDocument });
    });

    expect(deletionDialog()).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Fictional grievance guide" })).not.toBeInTheDocument();
    // The refused value must not linger in the parity store, where a
    // late-mounting consumer could resurrect it after deletion resolves.
    expect(deviceParitySnapshot()).toContainEqual({
      key: "hub.dialog",
      value: expect.objectContaining({ type: "deleteAccount" }),
    });
  });

  it("keeps Escape, close, and backdrop protections intact around replacement attempts", async () => {
    const { onDeleteAccount } = deferredDelete();
    renderHub(hubProps(onDeleteAccount));
    await startPendingDeletion();

    const dialog = deletionDialog();
    const layer = dialog.closest(".sg-detail-layer");
    await waitFor(() => expect(layer).toHaveAttribute("data-state", "open"));

    act(() => {
      applyDeviceParityState("hub.dialog", { type: "documentDetail", document: fixtureDocument });
    });
    expect(deletionDialog()).toBe(dialog);
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => { await Promise.resolve(); });
    expect(layer).toHaveAttribute("data-state", "open");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await act(async () => { await Promise.resolve(); });
    expect(layer).toHaveAttribute("data-state", "open");

    fireEvent.mouseDown(layer);
    await act(async () => { await Promise.resolve(); });
    expect(layer).toHaveAttribute("data-state", "open");
    expect(onDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it("keeps an indeterminate outcome rendered and retry blocked through replacement attempts", async () => {
    const { onDeleteAccount, settlers } = deferredDelete();
    const props = hubProps(onDeleteAccount);
    const rerenderHub = renderHub(props);
    await startPendingDeletion();

    act(() => {
      applyDeviceParityState("hub.dialog", { type: "documentDetail", document: fixtureDocument });
    });
    await act(async () => {
      settlers.reject(Object.assign(new Error("account-delete-indeterminate"), {
        code: "account-delete-indeterminate",
        indeterminate: true,
      }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Do not submit again");
    expect(screen.getByRole("button", { name: "Permanently delete my account" })).toBeDisabled();

    // The outcome is still unresolved, so replacement stays refused.
    act(() => {
      applyDeviceParityState("hub.dialog", { type: "documentDetail", document: fixtureDocument });
    });
    rerenderHub({ ...props, data: { ...props.data, product: refreshedProduct() } });
    await act(async () => { await Promise.resolve(); });

    expect(deletionDialog()).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Do not submit again");
    expect(screen.getByRole("button", { name: "Permanently delete my account" })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "Fictional grievance guide" })).not.toBeInTheDocument();
    expect(onDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it("keeps a definitive failure visible and dismissible without surfacing dropped replacements", async () => {
    const { onDeleteAccount, settlers } = deferredDelete();
    renderHub(hubProps(onDeleteAccount));
    await startPendingDeletion();

    act(() => {
      applyDeviceParityState("hub.dialog", { type: "documentDetail", document: fixtureDocument });
    });
    await act(async () => {
      settlers.reject(new Error("delete-failed"));
      await Promise.resolve();
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The account was not deleted");
    // The replacement dropped during the protected interval must not surface
    // now that the request has resolved.
    expect(screen.queryByRole("heading", { name: "Fictional grievance guide" })).not.toBeInTheDocument();
    const dialog = deletionDialog();
    expect(within(dialog).getByRole("button", { name: "Permanently delete my account" })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Permanently delete your account" })).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Fictional grievance guide" })).not.toBeInTheDocument();
  });

  it("closes normally on confirmed success and never surfaces replacements dropped during the interval", async () => {
    const { onDeleteAccount, settlers } = deferredDelete();
    renderHub(hubProps(onDeleteAccount));
    await startPendingDeletion();

    act(() => {
      applyDeviceParityState("hub.dialog", { type: "documentDetail", document: fixtureDocument });
    });
    expect(deletionDialog()).toBeInTheDocument();
    await act(async () => {
      settlers.resolve({ deleted: true });
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Permanently delete your account" })).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Fictional grievance guide" })).not.toBeInTheDocument();
    expect(deviceParitySnapshot()).toContainEqual({ key: "hub.dialog", value: null });
  });

  it("arms the lock synchronously at submit, before any effect flush", async () => {
    // A parity message can already be queued behind the submit click. If the
    // lock armed only in a passive effect, an apply delivered before the
    // effect flush would unmount the dialog with the request in flight — so
    // the replacement here fires from INSIDE onDelete, synchronously within
    // the submit handler itself.
    const onDeleteAccount = vi.fn(() => {
      applyDeviceParityState("hub.dialog", { type: "documentDetail", document: fixtureDocument });
      return new Promise(() => {});
    });
    renderHub(hubProps(onDeleteAccount));

    fireEvent.click(screen.getByRole("button", { name: "Data rights" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Type DELETE MY ACCOUNT/ }), {
      target: { value: "DELETE MY ACCOUNT" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete my account" }));

    await screen.findByRole("button", { name: "Deleting account…" });
    expect(deletionDialog()).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Fictional grievance guide" })).not.toBeInTheDocument();
  });

  it("treats a new search nonce for the same thread as a fresh intent outside the protected interval", async () => {
    const { onDeleteAccount } = deferredDelete();
    const props = hubProps(onDeleteAccount, { focus: { threadId: "thread-1", nonce: 1 } });
    const rerenderHub = renderHub(props);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Overtime scheduling" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.querySelector(".sg-detail-layer")).toBeNull());

    // A refresh alone is the same intent: the dismissed dialog stays closed.
    rerenderHub({ ...props, data: { ...props.data, product: refreshedProduct() } });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("heading", { name: "Overtime scheduling" })).not.toBeInTheDocument();

    // Re-picking the same result mints a new nonce: a fresh intent reopens it.
    rerenderHub({ ...props, focus: { threadId: "thread-1", nonce: 2 } });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Overtime scheduling" })).toBeInTheDocument());
  });

  it("publishes the session destructive hold while the request is unresolved", async () => {
    // BUG-UG-ACCOUNT-DELETION-SESSION-SCOPE-20260814: the unresolved
    // interval must be visible beyond this tree — the App nav guard and the
    // paired pane's mirrored dialog both consult session.destructiveHold.
    const changes = [];
    const stop = subscribeDeviceParityChanges((detail) => changes.push(detail));
    try {
      const { onDeleteAccount, settlers } = deferredDelete();
      renderHub(hubProps(onDeleteAccount));
      await startPendingDeletion();

      expect(changes).toContainEqual({ key: "session.destructiveHold", value: true });
      expect(deviceParity.deviceParityValue("session.destructiveHold")).toBe(true);

      await act(async () => {
        settlers.reject(new Error("delete-failed"));
        await Promise.resolve();
      });
      await screen.findByRole("alert");
      expect(deviceParity.deviceParityValue("session.destructiveHold")).toBe(false);
    } finally {
      stop();
    }
  });

  it("refuses a peer clear while this tree still owns the unresolved hold", async () => {
    // Two panes can submit before the first bridge message arrives. The
    // server serializes deletion, but the pane that receives the definitive
    // deletion-in-progress refusal must not clear the other pane's live hold.
    const changes = [];
    const stop = subscribeDeviceParityChanges((detail) => changes.push(detail));
    try {
      const { onDeleteAccount, settlers } = deferredDelete();
      renderHub(hubProps(onDeleteAccount));
      await startPendingDeletion();

      changes.length = 0;
      let applied;
      act(() => {
        applied = applyDeviceParityState("session.destructiveHold", false);
      });
      expect(applied).toBe(false);
      expect(deviceParity.deviceParityValue("session.destructiveHold")).toBe(true);
      expect(changes).toEqual([{ key: "session.destructiveHold", value: true }]);
      expect(deletionDialog()).toBeInTheDocument();

      await act(async () => {
        settlers.reject(new Error("delete-failed"));
        await Promise.resolve();
      });
      await screen.findByRole("alert");
      expect(deviceParity.deviceParityValue("session.destructiveHold")).toBe(false);
    } finally {
      stop();
    }
  });

  it("disarms the confirmation while the session hold is active elsewhere", async () => {
    const onDeleteAccount = vi.fn();
    renderHub(hubProps(onDeleteAccount));
    act(() => {
      applyDeviceParityState("session.destructiveHold", true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Data rights" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Type DELETE MY ACCOUNT/ }), {
      target: { value: "DELETE MY ACCOUNT" },
    });
    const submit = screen.getByRole("button", { name: "Permanently delete my account" });
    expect(submit).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("already in progress for this session");
    fireEvent.submit(submit.closest("form"));
    expect(onDeleteAccount).not.toHaveBeenCalled();

    act(() => {
      applyDeviceParityState("session.destructiveHold", false);
    });
    expect(screen.getByRole("button", { name: "Permanently delete my account" })).toBeEnabled();
  });

  it("echoes one reconciling change when a foreign apply is refused, and never for an equivalent value", async () => {
    const changes = [];
    const stop = subscribeDeviceParityChanges((detail) => changes.push(detail));
    try {
      const { onDeleteAccount } = deferredDelete();
      renderHub(hubProps(onDeleteAccount));
      await startPendingDeletion();

      changes.length = 0;
      let applied;
      act(() => {
        applied = applyDeviceParityState("hub.dialog", { type: "documentDetail", document: fixtureDocument });
      });
      // The refusal is honest to the caller and broadcast to the bridge so
      // the peer pane converges back onto the protected dialog.
      expect(applied).toBe(false);
      expect(changes).toContainEqual({ key: "hub.dialog", value: expect.objectContaining({ type: "deleteAccount" }) });

      // A structurally equivalent value (the both-panes-locked shape) is
      // refused silently — echoing it back would ping-pong forever.
      changes.length = 0;
      act(() => {
        applyDeviceParityState("hub.dialog", { type: "deleteAccount" });
      });
      expect(changes.filter((change) => change.key === "hub.dialog")).toHaveLength(0);
      expect(deletionDialog()).toBeInTheDocument();

      // Malformed/cyclic bridge data cannot be structurally compared. Treat
      // it as different and reconcile once instead of letting serialization
      // failure hide the surviving protected value.
      const cyclicDialog = { type: "documentDetail" };
      cyclicDialog.self = cyclicDialog;
      changes.length = 0;
      act(() => {
        applied = applyDeviceParityState("hub.dialog", cyclicDialog);
      });
      expect(applied).toBe(false);
      expect(changes.filter((change) => change.key === "hub.dialog")).toHaveLength(1);
      expect(changes[0]).toEqual({ key: "hub.dialog", value: expect.objectContaining({ type: "deleteAccount" }) });
    } finally {
      stop();
    }
  });

  it("counts refused snapshot entries as not applied", async () => {
    const { onDeleteAccount, settlers } = deferredDelete();
    renderHub(hubProps(onDeleteAccount));
    await startPendingDeletion();

    let applied;
    act(() => {
      applied = applyDeviceParitySnapshot([
        { key: "hub.dialog", value: { type: "documentDetail", document: fixtureDocument } },
      ]);
    });
    expect(applied).toBe(0);
    expect(deletionDialog()).toBeInTheDocument();

    // After a definitive failure resolves the interval, the same handshake
    // entry applies and counts honestly.
    await act(async () => {
      settlers.reject(new Error("delete-failed"));
      await Promise.resolve();
    });
    await screen.findByRole("alert");
    act(() => {
      applied = applyDeviceParitySnapshot([
        { key: "hub.dialog", value: { type: "documentDetail", document: fixtureDocument } },
      ]);
    });
    expect(applied).toBe(1);
    expect(await screen.findByRole("heading", { name: "Fictional grievance guide" })).toBeInTheDocument();
  });

  it("keeps ordinary navigation and parity application working outside the protected interval", async () => {
    window.history.pushState({}, "", "/?document=doc-guide-1");
    try {
      const { onDeleteAccount } = deferredDelete();
      const props = hubProps(onDeleteAccount, {
        data: { ...data, roles: [], product: { ...product, documents: [fixtureDocument] } },
      });
      renderHub(props);

      // The document deep link still applies on arrival. Each close waits for
      // the exit transition to fully unmount the surface, because replacing a
      // closing dialog with the same dialog type would ride the old
      // instance's exit and never reopen.
      await waitFor(() => expect(screen.getByRole("heading", { name: "Fictional grievance guide" })).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(document.querySelector(".sg-detail-layer")).toBeNull());

      // Parity application still drives the dialog normally.
      act(() => {
        applyDeviceParityState("hub.dialog", { type: "documentDetail", document: fixtureDocument });
      });
      expect(await screen.findByRole("heading", { name: "Fictional grievance guide" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(document.querySelector(".sg-detail-layer")).toBeNull());

      // An idle deletion dialog — nothing submitted, nothing pending — is not
      // a protected surface; ordinary replacement still wins.
      fireEvent.click(screen.getByRole("button", { name: "Data rights" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
      expect(screen.getByRole("dialog", { name: "Permanently delete your account" })).toBeInTheDocument();
      act(() => {
        applyDeviceParityState("hub.dialog", { type: "documentDetail", document: fixtureDocument });
      });
      expect(await screen.findByRole("heading", { name: "Fictional grievance guide" })).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Permanently delete your account" })).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });
});

describe("hub dialog enum options and list rows follow the catalogue", () => {
  // UX-UG-WEB-HUB-DIALOG-OPTIONS-AND-LIST-ENUMS-ENGLISH-ONLY-20260920:
  // the six create/edit dialogs used to ship literal English <option> text
  // while list rows echoed raw enum values. Same maps drive both surfaces.
  function renderStaffHub(productOverrides = {}, lang = "es") {
    return wrap(
      <ProductHubView
        data={{
          ...data,
          product: {
            ...product,
            partnerOrgs: [{ id: "org-1", name: "Local 100", city: "Boston", state: "MA" }],
            ...productOverrides,
          },
        }}
        onCreateSpace={vi.fn()}
        onCreateThread={vi.fn()}
        onCreateIntake={vi.fn()}
        onCreateDocument={vi.fn()}
        onCreateRecord={vi.fn()}
        onCreateHandshake={vi.fn()}
      />,
      lang,
    );
  }

  function optionSnapshot(name) {
    const select = screen.getByRole("combobox", { name });
    return [...select.options].map((option) => ({ value: option.value, label: option.textContent }));
  }

  function expectCatalogueOptions(name, entries) {
    const snapshot = optionSnapshot(name);
    expect(snapshot.map((row) => row.value)).toEqual(entries.map(([value]) => value));
    expect(snapshot.map((row) => row.label)).toEqual(entries.map(([, key]) => catalogue.es[key]));
    for (const option of snapshot) {
      expect(option.label).not.toMatch(/^hub\./);
      expect(option.label).not.toMatch(/^records\./);
    }
    for (const [, key] of entries) {
      if (catalogue.en[key] !== catalogue.es[key]) {
        expect(snapshot.map((row) => row.label)).not.toContain(catalogue.en[key]);
      }
    }
  }

  it("SpaceDialog options are Spanish with unchanged values", () => {
    renderStaffHub();
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.newSpace"] }));
    expectCatalogueOptions(catalogue.es["hub.visibility"], [
      ["chapter", "hub.visibility.chapter"],
      ["staff", "hub.visibility.staff"],
      ["private", "hub.visibility.private"],
    ]);
  });

  it("ThreadDialog options are Spanish with unchanged values", () => {
    renderStaffHub();
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.newThread"] }));
    expectCatalogueOptions(catalogue.es["hub.kind"], [
      ["topic", "hub.kind.topic"],
      ["issue", "hub.kind.issue"],
      ["decision", "hub.kind.decision"],
    ]);
  });

  it("IntakeDialog options are Spanish with unchanged values", () => {
    renderStaffHub();
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.tab.voice"] }));
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.report"] }));
    expectCatalogueOptions(catalogue.es["hub.category"], [
      ["workplace_issue", "hub.category.workplace_issue"],
      ["safety", "hub.category.safety"],
      ["question", "hub.category.question"],
      ["app_feedback", "hub.category.app_feedback"],
      ["other", "hub.category.other"],
    ]);
  });

  it("DocumentDialog options are Spanish with unchanged values", () => {
    renderStaffHub();
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.tab.library"] }));
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.newDocument"] }));
    expectCatalogueOptions(catalogue.es["hub.documentType"], [
      ["contract", "hub.documentType.contract"],
      ["policy", "hub.documentType.policy"],
      ["minutes", "hub.documentType.minutes"],
      ["training", "hub.documentType.training"],
      ["template", "hub.documentType.template"],
      ["other", "hub.documentType.other"],
    ]);
  });

  it("RecordDialog options are Spanish with unchanged values and share records.type keys", () => {
    renderStaffHub();
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.tab.record"] }));
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.newRecord"] }));
    expectCatalogueOptions(catalogue.es["hub.recordType"], [
      ["minutes", "records.type.minutes"],
      ["decision", "records.type.decision"],
      ["milestone", "records.type.milestone"],
      ["management_contact", "records.type.management_contact"],
      ["member_contact", "records.type.member_contact"],
    ]);
  });

  it("HandshakeDialog placeholder and data-scope options are Spanish with unchanged values", () => {
    renderStaffHub();
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.tab.partners"] }));
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.newHandshake"] }));
    const partner = optionSnapshot(catalogue.es["hub.partner"]);
    expect(partner[0]).toEqual({ value: "", label: catalogue.es["hub.selectOrganization"] });
    expect(partner[0].label).not.toBe(catalogue.en["hub.selectOrganization"]);
    expectCatalogueOptions(catalogue.es["hub.dataScope"], [
      ["docs_only", "hub.dataScope.docs_only"],
      ["no_member_data", "hub.dataScope.no_member_data"],
      ["aggregate_only", "hub.dataScope.aggregate_only"],
    ]);
  });

  it("list rows show the same localized names the dialogs use", () => {
    renderStaffHub({
      intake: [{
        id: "intake-row",
        category: "workplace_issue",
        title: "Schedule notice",
        details: "The notice arrived after the shift changed.",
        status: "new",
        created_at: "2026-08-12T12:00:00Z",
      }],
      documents: [{
        id: "doc-row",
        title: "CBA booklet",
        document_type: "contract",
        version: 1,
        status: "published",
        summary: "Published contract excerpt.",
      }],
      records: [{
        id: "record-row",
        title: "April meeting",
        record_type: "minutes",
        occurred_at: "2026-04-10T18:00:00Z",
        body: "Members approved the calendar.",
      }],
      handshakes: [{
        id: "handshake-row",
        title: "Neighbor local",
        purpose: "Share training documents.",
        status: "requested",
        data_scope: "docs_only",
        partner_org_id: "org-1",
        union_orgs: { name: "Local 100" },
      }],
    });

    expect(screen.getByText(catalogue.es["hub.visibility.chapter"])).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${catalogue.es["hub.kind.issue"]} ·`))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.tab.voice"] }));
    expect(screen.getByText(new RegExp(`${catalogue.es["hub.category.workplace_issue"]} ·`))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.tab.library"] }));
    expect(screen.getByText(catalogue.es["hub.documentType.contract"])).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.tab.record"] }));
    expect(screen.getByText(catalogue.es["records.type.minutes"])).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.tab.partners"] }));
    expect(screen.getByText(new RegExp(`Local 100 · ${catalogue.es["hub.dataScope.docs_only"]}`))).toBeInTheDocument();
  });

  it("an unrecognized enum value shows the raw value and never a printed key", () => {
    renderStaffHub({
      spaces: [{
        id: "space-unknown",
        name: "Unknown space",
        description: "",
        visibility: "mystery_scope",
        threads: [{
          id: "thread-unknown",
          title: "Unknown kind thread",
          kind: "not_a_kind",
          status: "open",
          posts: [],
        }],
      }],
      intake: [{
        id: "intake-unknown",
        category: "brand_new_cat",
        title: "Odd report",
        details: "Unmapped category from the server.",
        status: "new",
        created_at: "2026-08-12T12:00:00Z",
      }],
    });

    expect(screen.getByText("mystery_scope")).toBeInTheDocument();
    expect(screen.getByText(/not_a_kind ·/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bhub\./);
    expect(document.body.textContent).not.toMatch(/\brecords\./);

    fireEvent.click(screen.getByRole("button", { name: catalogue.es["hub.tab.voice"] }));
    expect(screen.getByText(/brand_new_cat ·/)).toBeInTheDocument();
    expect(screen.queryByText(/^hub\./)).toBeNull();
  });
});

describe("public legal pages", () => {
  // Union Ground publishes no mailbox yet, so the contact block says so in the page language.
  it("renders Spanish privacy content and localized navigation", () => {
    wrap(<LegalView page="privacy" />, "es");
    expect(screen.getByRole("heading", { name: "Privacidad" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Qué guarda esta vista previa" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Información legal" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "En esta página" }).querySelector('a[href="#legal-contact"]')).toHaveTextContent("Contacta a Union Ground");
    expect(screen.getAllByText(/Todavía no se publica ninguna dirección\./).length).toBeGreaterThan(0);
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it("routes terms help to the no-published-address notice rather than a mailbox", () => {
    wrap(<LegalView page="terms" />);
    expect(screen.getAllByText(/No address is published yet\./).length).toBeGreaterThan(0);
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it("publishes the account retention schedule bilingually", () => {
    const { unmount } = wrap(<LegalView page="retention" />);
    expect(screen.getByRole("heading", { name: "Data retention schedule" })).toBeInTheDocument();
    // The page's own legal navigation, in main; the site's shared header and
    // footer link About too.
    expect(within(screen.getByRole("main")).getByRole("link", { name: "About" })).toHaveAttribute("href", "/about");
    expect(screen.getByText(/No campaign records are stored on a server in this preview\./i)).toBeInTheDocument();
    expect(screen.getByText(/Preferences and tour state stay in this browser's storage/i)).toBeInTheDocument();
    unmount();
    wrap(<LegalView page="retention" />, "es");
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Quiénes somos" })).toHaveAttribute("href", "/about");
    expect(screen.getByRole("heading", { name: "Calendario de retención de datos" })).toBeInTheDocument();
    expect(screen.getByText(/En esta vista previa no se guardan registros de campaña en ningún servidor\./i)).toBeInTheDocument();
  });
});

const DRIVER_RLS = new Error('new row violates row-level security policy for table "chapter_spaces"');

async function expectCatalogueAlert(lang, key) {
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(t(lang, key));
  expect(alert.textContent).not.toMatch(/row-level security|chapter_spaces/i);
}

describe("hub mutation dialogs never paint driver error text", () => {
  it.each(["en", "es"])("shows catalogue save copy and a catalogue busy label in %s", async (lang) => {
    let rejectSave;
    const onUpdateSpace = vi.fn(() => new Promise((_, reject) => { rejectSave = reject; }));
    wrap(<ProductHubView data={data} onUpdateSpace={onUpdateSpace} />, lang);

    fireEvent.click(screen.getByRole("button", { name: t(lang, "hub.edit") }));
    fireEvent.click(screen.getByRole("button", { name: t(lang, "hub.save") }));

    const busy = await screen.findByRole("button", { name: t(lang, "dialogs.saving") });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toHaveTextContent(t(lang, "dialogs.saving"));
    if (lang === "es") expect(screen.queryByText("Saving…")).not.toBeInTheDocument();

    await act(async () => { rejectSave(DRIVER_RLS); });
    await expectCatalogueAlert(lang, "hub.saveFailed");
    expect(onUpdateSpace).toHaveBeenCalled();
  });

  it("keeps a tokenised refusal as its own translated sentence under es", async () => {
    const onUpdateSpace = vi.fn().mockRejectedValue(Object.assign(new Error("Update space: cancelled"), { details: "scan_code_used" }));
    wrap(<ProductHubView data={data} onUpdateSpace={onUpdateSpace} />, "es");
    fireEvent.click(screen.getByRole("button", { name: t("es", "hub.edit") }));
    fireEvent.click(screen.getByRole("button", { name: t("es", "hub.save") }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("es", "rpcError.scan_code_used"));
    expect(alert).not.toHaveTextContent(t("es", "hub.saveFailed"));
    expect(alert.textContent).not.toMatch(/row-level security|chapter_spaces|cancelled/i);
  });

  it("shows catalogue copy when archive is refused under es", async () => {
    const onUpdateSpace = vi.fn().mockRejectedValue(DRIVER_RLS);
    wrap(<ProductHubView data={data} onUpdateSpace={onUpdateSpace} />, "es");
    fireEvent.click(screen.getByRole("button", { name: t("es", "hub.edit") }));
    fireEvent.click(screen.getByRole("button", { name: t("es", "hub.archive") }));
    fireEvent.click(screen.getByRole("button", { name: t("es", "hub.confirmArchive") }));
    await expectCatalogueAlert("es", "hub.saveFailed");
  });

  it("shows catalogue copy when a private-space member list is refused under es", async () => {
    const privateSpace = { ...product.spaces[0], visibility: "private", name: "Bargaining team" };
    wrap(<ProductHubView
      data={{ ...data, product: { ...product, spaces: [privateSpace] } }}
      onListSpaceMembers={vi.fn().mockRejectedValue(DRIVER_RLS)}
    />, "es");
    fireEvent.click(screen.getByRole("button", { name: t("es", "hub.manageMembers") }));
    await expectCatalogueAlert("es", "hub.membersError");
  });

  it("shows catalogue copy when intake triage is refused under es", async () => {
    const intake = {
      id: "intake-1",
      category: "workplace_issue",
      title: "Schedule notice",
      details: "The notice arrived after the shift changed.",
      status: "new",
      assigned_to: null,
      created_at: "2026-08-12T12:00:00Z",
    };
    wrap(<ProductHubView
      data={{ ...data, product: { ...product, intake: [intake] }, intakeOwners: [] }}
      onCreateIntake={vi.fn()}
      onTriageIntake={vi.fn().mockRejectedValue(DRIVER_RLS)}
      onConvertIntake={vi.fn()}
    />, "es");
    fireEvent.click(screen.getByRole("button", { name: t("es", "hub.tab.voice") }));
    fireEvent.click(screen.getByRole("button", { name: t("es", "hub.intake.triage") }));
    fireEvent.click(screen.getByRole("button", { name: t("es", "hub.intake.saveTriage") }));
    await expectCatalogueAlert("es", "hub.intake.error");
  });

  it("shows catalogue copy when a Compass source save is refused under es", async () => {
    wrap(<ProductHubView
      data={{ ...data, member: { ...data.member, chapterId: "chapter-1" }, product: { ...product, compassKnowledge: [] } }}
      onSaveKnowledge={vi.fn().mockRejectedValue(DRIVER_RLS)}
    />, "es");
    fireEvent.click(screen.getByRole("button", { name: t("es", "hub.tab.library") }));
    fireEvent.click(screen.getByRole("button", { name: t("es", "hub.knowledge.add") }));
    fireEvent.change(screen.getByRole("textbox", { name: t("es", "hub.titleField") }), { target: { value: "Overtime source" } });
    fireEvent.change(screen.getByRole("textbox", { name: t("es", "hub.knowledge.ref") }), { target: { value: "CBA · Article 9" } });
    fireEvent.change(screen.getByRole("textbox", { name: t("es", "hub.knowledge.body") }), { target: { value: "Verified chapter language." } });
    fireEvent.click(screen.getByRole("button", { name: t("es", "hub.knowledge.saveDraft") }));
    await expectCatalogueAlert("es", "hub.knowledge.saveFailed");
  });
});

// UX-UG-WEB-HANDSHAKE-RECEIVING-CHAPTER-SEES-SENDER-WAITING-LINE-20260920:
// PartnersPanel printed the sender's "waiting for the partner to countersign"
// line on every requested handshake, including for the receiving chapter that
// liveHandshakeActions hands Accept and Decline to. The line is now read from
// the same side test as the buttons.
describe("chapter handshake turn", () => {
  const requested = {
    id: "handshake-1",
    title: "Regional data sharing",
    status: "requested",
    chapter_id: "chapter-1",
    receiving_chapter_id: "chapter-2",
    partner_org_id: "org-2",
    data_scope: "aggregate",
    purpose: "A fictional handshake states its scope and its purpose.",
  };
  const asChapter = (chapterId) => ({
    ...data,
    member: { ...data.member, chapterId },
    product: { ...product, handshakes: [requested] },
  });
  // Record 8435, slice 9: one status write runs at a time, so every status
  // button reads pending while one runs, and the lock ends where busy does.
  it("shows every handshake's buttons pending while one status write runs, then sends the next", async () => {
    let finish;
    const onUpdateHandshake = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const second = { ...requested, id: "handshake-2", title: "Shared training calendar" };
    wrap(<ProductHubView data={{ ...asChapter("chapter-2"), product: { ...product, handshakes: [requested, second] } }} onUpdateHandshake={onUpdateHandshake} />);
    fireEvent.click(screen.getByRole("button", { name: "Partners" }));
    const [firstAccept, secondAccept] = screen.getAllByRole("button", { name: "Accept" });
    fireEvent.click(firstAccept);
    expect(secondAccept).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(secondAccept);
    expect(onUpdateHandshake).toHaveBeenCalledTimes(1);
    await act(async () => { finish({}); });
    await waitFor(() => expect(secondAccept).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(secondAccept);
    expect(onUpdateHandshake).toHaveBeenCalledTimes(2);
    await act(async () => { finish({}); });
  });

  it("sends a status again from an immediate press after a write that throws at once", async () => {
    const onUpdateHandshake = vi.fn();
    wrap(<ProductHubView data={asChapter("chapter-2")} onUpdateHandshake={onUpdateHandshake} />);
    fireEvent.click(screen.getByRole("button", { name: "Partners" }));
    await expectReadyRetryAfterThrowAtOnce(onUpdateHandshake, screen.getByRole("button", { name: "Accept" }));
  });

  const openPartners = (chapterId, lang = "en") => {
    const view = wrap(<ProductHubView data={asChapter(chapterId)} onUpdateHandshake={vi.fn()} />, lang);
    fireEvent.click(screen.getByRole("button", { name: lang === "es" ? "Alianzas" : "Partners" }));
    return view;
  };

  it("tells the receiving chapter the countersignature is its own, beside its buttons", () => {
    const { unmount } = openPartners("chapter-2");
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
    expect(screen.getByText("Received — the partner is waiting for your countersignature.")).toBeInTheDocument();
    expect(screen.queryByText("Sent — waiting for the partner to countersign.")).not.toBeInTheDocument();
    unmount();
    openPartners("chapter-2", "es");
    expect(screen.getByText("Recibido: el aliado espera tu contrafirma.")).toBeInTheDocument();
    expect(screen.queryByText("Enviado: esperando la contrafirma del aliado.")).not.toBeInTheDocument();
  });

  it("keeps the waiting line for the sending chapter, which has nothing to press", () => {
    openPartners("chapter-1");
    expect(screen.getByText("Sent — waiting for the partner to countersign.")).toBeInTheDocument();
    expect(screen.queryByText("Received — the partner is waiting for your countersignature.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeInTheDocument();
  });

  // REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031
  it("lists catalogue offices not yet on Union Ground beside the handshakes", async () => {
    const rpc = vi.fn(async (name) => ({ data: name === "list_partner_offices_not_on_platform"
      ? { matchedOn: "state", rows: [{ unionOrgId: "office-1", name: "Riverside Transit Workers", state: "IL", notOnPlatform: true, sameState: true, sharedSectors: 0, openOffer: null, invitationPending: false }] }
      : { offers: [], invitations: [], openLimit: 10, pendingInvitationLimit: 5 }, error: null }));
    const actor = { userId: "user-1", organizationId: "org-1", chapterId: "chapter-1", selectedHat: "steward" };
    const { unmount } = wrap(<ProductHubView data={asChapter("chapter-1")} onUpdateHandshake={vi.fn()} connectionClient={{ rpc }} connectionActor={actor} />);
    fireEvent.click(screen.getByRole("button", { name: "Partners" }));
    expect(await screen.findByText("Riverside Transit Workers")).toBeInTheDocument();
    expect(screen.getByText("Not yet on Union Ground")).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("list_partner_offices_not_on_platform", { p_selected_hat: "steward", p_chapter_id: "chapter-1", p_query: null, p_limit: 25, p_offset: 0 });
    unmount();
    const preview = wrap(<ProductHubView data={asChapter("chapter-1")} onUpdateHandshake={vi.fn()} connectionActor={actor} connectionPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Partners" }));
    expect(screen.getByText("Preview only: no office is listed or contacted.")).toBeInTheDocument();
    preview.unmount();
    wrap(<ProductHubView data={asChapter("chapter-1")} onUpdateHandshake={vi.fn()} connectionActor={{ ...actor, chapterId: null }} connectionClient={{ rpc }} />);
    fireEvent.click(screen.getByRole("button", { name: "Partners" }));
    expect(screen.queryByText("Offices not yet on Union Ground")).not.toBeInTheDocument();
  });

  it("keeps the sender's line in a preview fixture, where no chapter owns the row", () => {
    wrap(<ProductHubView data={asChapter("chapter-2")} onUpdateHandshake={vi.fn()} preview />);
    fireEvent.click(screen.getByRole("button", { name: "Partners" }));
    expect(screen.getByText("Sent — waiting for the partner to countersign.")).toBeInTheDocument();
    expect(screen.queryByText("Received — the partner is waiting for your countersignature.")).not.toBeInTheDocument();
  });
});

describe("hub writes keep focus while they run (record 8435)", () => {
  it("keeps the space dialog's Save focused while the space is saved, and saves it once", async () => {
    const onUpdateSpace = vi.fn(async () => ({}));
    wrap(<ProductHubView data={data} onUpdateSpace={onUpdateSpace} />);
    fireEvent.click(screen.getByRole("button", { name: t("en", "hub.edit") }));
    await expectHeldWriteFocus(onUpdateSpace, screen.getByRole("button", { name: t("en", "hub.save") }));
    expect(onUpdateSpace).toHaveBeenCalledTimes(1);
  });

  it("keeps Permanently delete focused while the deletion runs, and sends it once", async () => {
    const onDeleteAccount = vi.fn(async () => ({}));
    wrap(<ProductHubView data={{ ...data, roles: [] }} onCreateGovernance={vi.fn()} onGenerateDataExport={vi.fn()} onDeleteAccount={onDeleteAccount} onDeleteIndeterminateClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Data rights" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Type DELETE MY ACCOUNT/ }), { target: { value: "DELETE MY ACCOUNT" } });
    await expectHeldWriteFocus(onDeleteAccount, screen.getByRole("button", { name: "Permanently delete my account" }));
    expect(onDeleteAccount).toHaveBeenCalledTimes(1);
  });
});
