import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskFieldNotesView } from "../src/views/TaskFieldNotesView.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick, expectReadyRetryAfterThrowAtOnce } from "./helpers/busyWriteFocus.js";

const copy = {
  "tasks.view.field_notes": "Field notes",
  "tasks.fieldNotesTitle": "Field notes",
  "tasks.fieldNotesPermission": "Everyone authorized for a task can read its field notes. Corrections are added as new notes.",
  "tasks.sampleSessionOnly": "PREVIEW · session-only",
  "tasks.fieldNoteOne": "1 field note",
  "tasks.fieldNoteCount": "{count} field notes",
  "tasks.fieldNotesUnavailable": "Task updates are unavailable. Confirmed notes remain visible; retry before treating this history as complete.",
  "tasks.fieldNotesTruncated": "Only the newest 2,000 field notes are loaded. Older notes may be omitted.",
  "tasks.fieldNotesEmpty": "No field notes yet.",
  "tasks.fieldNotesEmptyTruncated": "No notes for this task are in the newest 2,000. Older notes may exist.",
  "tasks.fieldNotesNoTasks": "No tasks match these filters.",
  "tasks.fieldNotesIndex": "Tasks with field notes",
  "tasks.fieldNotesThread": "Field notes for {task}",
  "tasks.openNamedTask": "Open {task}",
  "tasks.openFieldNotes": "Open task with field notes for {task}",
  "tasks.openTask": "Open task",
  "tasks.newFieldNote": "New note",
  "tasks.fieldNotePlaceholder": "Add a field note…",
  "tasks.addFieldNote": "Add note",
  "tasks.addingFieldNote": "Adding…",
  "tasks.fieldNoteAdded": "Field note added.",
  "tasks.fieldNoteFailed": "The field note was not added. Try again.",
  "tasks.fieldNoteMentions": "Notify chapter members",
  "tasks.fieldNoteMentionsMore": "Show {count} more",
  "tasks.chapterMember": "Chapter member",
  "tasks.you": "You",
  "tasks.new": "New task",
  "tasks.status.to_do": "To do",
  "tasks.status.in_progress": "In progress",
  "tasks.status.done": "Done",
  // REQ-UG-FIELD-NOTES-AI-PACKET-20261001
  "fieldNotes.packet.open": "Draft a packet",
  "fieldNotes.packet.title": "Draft packet from field notes",
  "fieldNotes.packet.intro": "Pick the notes to use.",
  "fieldNotes.packet.selectLabel": "Use this note",
  "fieldNotes.packet.selected": "{count} of {limit} notes selected",
  "fieldNotes.packet.limitReached": "Your organization allows {limit} notes in one packet.",
  "fieldNotes.packet.submit": "Draft the packet",
  "fieldNotes.packet.working": "Drafting…",
  "fieldNotes.packet.cancel": "Close",
  "fieldNotes.packet.draftLabel": "Draft for review",
  "fieldNotes.packet.summary": "Summary",
  "fieldNotes.packet.plainLanguage": "In plain language",
  "fieldNotes.packet.checklist": "Bring this",
  "fieldNotes.packet.questions": "Questions to ask",
  "fieldNotes.packet.sources": "Sources used",
  "fieldNotes.packet.noSources": "No sources backed this draft.",
  "fieldNotes.packet.needNotes": "Choose at least one field note.",
  "fieldNotes.packet.feature_disabled": "Your organization has turned off draft packets from field notes.",
  "fieldNotes.packet.failed": "The packet could not be drafted right now. Try again shortly.",
};
function t(key, vars = {}) {
  return String(copy[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
}
const task = (id, taskNumber, title, status = "to_do") => ({
  id, taskNumber, title, status, workstream: "General",
});
const comment = (id, taskId, createdAt, body, chapterId = "chapter-1") => ({
  id, taskId, chapterId, authorId: "member-2", mentionedUserIds: [], createdAt, body,
});
const baseTasks = [
  task("task-a", 1, "First task"),
  task("task-b", 2, "Second task", "in_progress"),
  task("task-done", 3, "Done task", "done"),
];
const assignees = [
  { id: "member-1", fullName: "Current Member" },
  { id: "member-2", fullName: "Maria Santos" },
  { id: "member-3", fullName: "Priya Shah" },
];

function setup(overrides = {}) {
  const props = {
    tasks: baseTasks,
    comments: [],
    commentsUnavailable: false,
    commentsTruncated: false,
    assignees,
    memberId: "member-1",
    chapterId: "chapter-1",
    doneVisible: false,
    demo: false,
    lang: "en",
    t,
    onOpen: vi.fn(),
    onCreate: vi.fn(),
    onAddComment: vi.fn(async () => ({ id: "created" })),
    ...overrides,
  };
  return { ...render(<TaskFieldNotesView {...props} />), props };
}

function deferredComment() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function queuedAnimationFrames() {
  const callbacks = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => callbacks.push(callback));
  return () => callbacks.splice(0).forEach((callback) => callback(performance.now()));
}

describe("Green desktop Field notes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("indexes every visible task and inner-joins comments by task and chapter", () => {
    const rendered = setup({
      comments: [
        comment("new", "task-b", "2026-08-17T14:00:00Z", "Newest"),
        comment("old", "task-a", "2026-08-17T12:00:00Z", "Older"),
        comment("cross", "task-a", "2026-08-17T15:00:00Z", "Cross chapter", "chapter-2"),
        comment("orphan", "missing", "2026-08-17T16:00:00Z", "Orphan"),
        comment("done", "task-done", "2026-08-17T17:00:00Z", "Done note"),
      ],
    });
    const index = within(rendered.container).getByRole("list", { name: "Tasks with field notes" });
    expect(within(index).getAllByRole("button").map((button) => button.textContent)).toEqual([
      expect.stringContaining("Second task"),
      expect.stringContaining("First task"),
    ]);
    expect(rendered.container).not.toHaveTextContent("Cross chapter");
    expect(rendered.container).not.toHaveTextContent("Orphan");
    expect(rendered.container).not.toHaveTextContent("Done task");

    fireEvent.click(within(index).getByRole("button", { name: /First task/ }));
    expect(rendered.container).toHaveTextContent("Older");
    expect(rendered.container).not.toHaveTextContent("Cross chapter");
  });

  it("keeps selection by id and restores Done without destabilizing it", () => {
    const rendered = setup();
    fireEvent.click(within(rendered.container).getByRole("button", { name: /Second task/ }));
    rendered.rerender(<TaskFieldNotesView {...rendered.props} doneVisible />);
    const index = within(rendered.container).getByRole("list", { name: "Tasks with field notes" });
    expect(within(index).getByRole("button", { name: /Second task/ })).toHaveAttribute("aria-current", "true");
    expect(within(index).getByRole("button", { name: /Done task/ })).toBeInTheDocument();
  });

  it("sorts detail chronologically by timestamp then id and renders hostile text as text", () => {
    const createdAt = "2026-08-17T12:00:00Z";
    const rendered = setup({
      tasks: [baseTasks[0]],
      comments: [
        comment("z", "task-a", createdAt, "<img src=x onerror=alert(1)>"),
        comment("a", "task-a", createdAt, "First equal-time note"),
      ],
    });
    const thread = within(rendered.container).getByRole("feed", { name: "Field notes for First task" });
    expect(within(thread).getAllByRole("article").map((node) => node.querySelector("p").textContent))
      .toEqual(["First equal-time note", "<img src=x onerror=alert(1)>"]);
    expect(rendered.container.querySelector("img")).toBeNull();
  });

  it("keeps the accessible field-note label alongside the placeholder", () => {
    const rendered = setup({ tasks: [baseTasks[0]] });
    const composer = within(rendered.container).getByLabelText("Add a field note…");
    expect(composer.tagName).toBe("TEXTAREA");
    expect(composer).toHaveAttribute("placeholder", "Add a field note…");
  });

  it("submits trimmed text and deduplicated mentions, then clears on authoritative success", async () => {
    const rendered = setup({ tasks: [baseTasks[0]] });
    fireEvent.click(within(rendered.container).getByRole("button", { name: "New note" }));
    const composer = within(rendered.container).getByPlaceholderText("Add a field note…");
    expect(composer).toHaveFocus();
    fireEvent.change(composer, { target: { value: "  Durable update  " } });
    fireEvent.click(within(rendered.container).getByRole("button", { name: "@Maria Santos" }));
    fireEvent.click(within(rendered.container).getByRole("button", { name: "@Maria Santos" }));
    fireEvent.click(within(rendered.container).getByRole("button", { name: "@Maria Santos" }));
    fireEvent.submit(composer.closest("form"));
    await waitFor(() => expect(rendered.props.onAddComment)
      .toHaveBeenCalledWith("task-a", "Durable update", ["member-2"]));
    await waitFor(() => expect(composer).toHaveValue(""));
    expect(within(rendered.container).getByRole("status")).toHaveTextContent("Field note added.");
    expect(composer).toHaveFocus();
  });

  it("deduplicates people, limits the initial mention list, and can notify a revealed person", async () => {
    const people = Array.from({ length: 15 }, (_, index) => ({ id: `person-${index}`, fullName: `Person${String(index).padStart(2, "0")} Example` }));
    const rendered = setup({ assignees: [...people.slice().reverse(), ...people, assignees[0]], tasks: [baseTasks[0]] });
    const view = within(rendered.container);
    expect(view.getAllByRole("button", { name: /^@/ }).map((button) => button.textContent))
      .toEqual(people.slice(0, 12).map((person) => `@${person.fullName}`));
    fireEvent.click(view.getByRole("button", { name: "Show 3 more" }));
    expect(view.getAllByRole("button", { name: /^@/ })).toHaveLength(15);
    expect(view.queryByRole("button", { name: /Show .* more/ })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "@Person14 Example" }));
    const composer = view.getByRole("textbox");
    fireEvent.change(composer, { target: { value: "Notify the selected person" } });
    fireEvent.submit(composer.closest("form"));
    await waitFor(() => expect(rendered.props.onAddComment).toHaveBeenCalledWith("task-a", "Notify the selected person", ["person-14"]));
  });

  it("retains the task-keyed draft and mentions on rejection", async () => {
    const onAddComment = vi.fn(async () => { throw new Error("refused"); });
    const rendered = setup({ onAddComment });
    const composer = within(rendered.container).getByPlaceholderText("Add a field note…");
    fireEvent.change(composer, { target: { value: "Retry me" } });
    fireEvent.click(within(rendered.container).getByRole("button", { name: "@Priya Shah" }));
    fireEvent.submit(composer.closest("form"));
    expect(await within(rendered.container).findByRole("alert")).toHaveTextContent("not added");
    expect(composer).toHaveValue("Retry me");
    expect(within(rendered.container).getByRole("button", { name: "@Priya Shah" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(composer).toHaveFocus());

    fireEvent.click(within(rendered.container).getByRole("button", { name: /Second task/ }));
    expect(within(rendered.container).getByPlaceholderText("Add a field note…")).toHaveValue("");
    fireEvent.click(within(rendered.container).getByRole("button", { name: /First task/ }));
    expect(within(rendered.container).getByPlaceholderText("Add a field note…")).toHaveValue("Retry me");
  });

  it.each(["success", "rejection"])("restores focus after the enabled commit on deferred %s even when a frame runs first", async (outcome) => {
    const pending = deferredComment();
    const flushFrames = queuedAnimationFrames();
    const rendered = setup({ onAddComment: vi.fn(() => pending.promise) });
    const composer = within(rendered.container).getByRole("textbox");
    const focusWhileDisabled = [];
    const nativeFocus = composer.focus.bind(composer);
    vi.spyOn(composer, "focus").mockImplementation(() => {
      focusWhileDisabled.push(composer.disabled);
      nativeFocus();
    });
    fireEvent.change(composer, { target: { value: "  Keep the exact draft  " } });
    fireEvent.click(within(rendered.container).getByRole("button", { name: "@Priya Shah" }));
    fireEvent.submit(composer.closest("form"));
    expect(composer).toHaveAttribute("aria-disabled", "true");

    await act(async () => {
      if (outcome === "success") pending.resolve({ id: "created" });
      else pending.reject(new Error("refused"));
      await Promise.resolve();
      // Promise settlement has queued React state, but this act scope has not
      // committed it. An animation frame is allowed to run at this boundary.
      expect(composer).toHaveAttribute("aria-disabled", "true");
      flushFrames();
    });

    expect(composer).toBeEnabled();
    expect(composer).toHaveFocus();
    expect(focusWhileDisabled).toEqual([false]);
    expect(rendered.props.onAddComment).toHaveBeenCalledWith("task-a", "Keep the exact draft", ["member-3"]);
    expect(composer).toHaveValue(outcome === "success" ? "" : "  Keep the exact draft  ");
    expect(within(rendered.container).getByRole("button", { name: "@Priya Shah" }))
      .toHaveAttribute("aria-pressed", outcome === "success" ? "false" : "true");
    expect(within(rendered.container).getByRole(outcome === "success" ? "status" : "alert"))
      .toHaveTextContent(outcome === "success" ? "Field note added." : "The field note was not added. Try again.");

    const other = within(rendered.container).getByRole("button", { name: "New note" });
    other.focus();
    rendered.rerender(<TaskFieldNotesView {...rendered.props} commentsTruncated />);
    flushFrames();
    expect(other).toHaveFocus();
    expect(focusWhileDisabled).toEqual([false]);
  });

  it.each(["success", "rejection"])("restores focus once for each immediate %s", async (outcome) => {
    const flushFrames = queuedAnimationFrames();
    const onAddComment = vi.fn(async () => {
      if (outcome === "rejection") throw new Error("refused");
      return { id: "created" };
    });
    const rendered = setup({ onAddComment });
    const composer = within(rendered.container).getByRole("textbox");
    const focus = vi.spyOn(composer, "focus");
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      fireEvent.change(composer, { target: { value: `Draft ${attempt}` } });
      within(rendered.container).getByRole("button", { name: "Add note" }).focus();
      await act(async () => {
        fireEvent.submit(composer.closest("form"));
        await Promise.resolve();
      });
      flushFrames();
      expect(composer).toBeEnabled();
      expect(composer).toHaveFocus();
      expect(focus).toHaveBeenCalledTimes(attempt);
      expect(composer).toHaveValue(outcome === "success" ? "" : `Draft ${attempt}`);
      expect(within(rendered.container).getByRole(outcome === "success" ? "status" : "alert"))
        .toHaveTextContent(outcome === "success" ? "Field note added." : "not added");
    }
    expect(onAddComment).toHaveBeenCalledTimes(2);
  });

  it("restores focus on synchronous rejection when busy=true/false share one enabled commit", () => {
    const flushFrames = queuedAnimationFrames();
    const rendered = setup({ onAddComment: vi.fn(() => { throw new Error("refused synchronously"); }) });
    const composer = within(rendered.container).getByRole("textbox");
    const focus = vi.spyOn(composer, "focus");
    const observer = new MutationObserver(() => {});
    observer.observe(composer, { attributes: true, attributeFilter: ["disabled"] });
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        fireEvent.change(composer, { target: { value: `Retry ${attempt}` } });
        within(rendered.container).getByRole("button", { name: "Add note" }).focus();
        fireEvent.submit(composer.closest("form"));
        flushFrames();
        expect(observer.takeRecords()).toEqual([]);
        expect(composer).toBeEnabled();
        expect(composer).toHaveFocus();
        expect(focus).toHaveBeenCalledTimes(attempt);
        expect(composer).toHaveValue(`Retry ${attempt}`);
        expect(within(rendered.container).getByRole("alert")).toHaveTextContent("not added");
      }
    } finally {
      observer.disconnect();
    }
  });

  it.each([
    ["task", false], ["task", true],
    ["same task", false],
    ["member", false], ["member", true],
    ["chapter", false], ["chapter", true],
    ["removed task", false],
  ])("cancels settlement focus on %s change (return to original: %s)", async (context, returnToOriginal) => {
    const pending = deferredComment();
    const flushFrames = queuedAnimationFrames();
    const rendered = setup({ onAddComment: vi.fn(() => pending.promise) });
    const composer = within(rendered.container).getByRole("textbox");
    fireEvent.change(composer, { target: { value: "Original task draft" } });
    fireEvent.click(within(rendered.container).getByRole("button", { name: "@Priya Shah" }));
    fireEvent.submit(composer.closest("form"));
    expect(composer).toHaveAttribute("aria-disabled", "true");
    const index = within(rendered.container).getByRole("list", { name: "Tasks with field notes" });

    if (context === "same task") {
      fireEvent.click(within(index).getByRole("button", { name: /First task/ }));
    } else if (context === "task") {
      fireEvent.click(within(index).getByRole("button", { name: /Second task/ }));
      expect(composer).toHaveValue("");
      if (returnToOriginal) fireEvent.click(within(index).getByRole("button", { name: /First task/ }));
    } else {
      const changed = context === "member" ? { memberId: "member-2" }
        : context === "chapter" ? { chapterId: "chapter-2" } : { tasks: [] };
      rendered.rerender(<TaskFieldNotesView {...rendered.props} {...changed} />);
      if (returnToOriginal) rendered.rerender(<TaskFieldNotesView {...rendered.props} />);
    }

    await act(async () => pending.reject(new Error("refused")));
    flushFrames();
    expect(document.body).toHaveFocus();
    expect(rendered.props.onAddComment).toHaveBeenCalledWith("task-a", "Original task draft", ["member-3"]);
    if (context === "task" || context === "same task") {
      if (context === "task" && !returnToOriginal) expect(composer).toHaveValue("");
      fireEvent.click(within(index).getByRole("button", { name: /First task/ }));
      expect(composer).toHaveValue("Original task draft");
      expect(within(rendered.container).getByRole("button", { name: "@Priya Shah" })).toHaveAttribute("aria-pressed", "true");
    }
  });

  it.each(["inside", "mention", "outside", "outside then body", "outside before submit", "outside before submit then body"])("preserves deliberate focus %s the composer", async (destination) => {
    const pending = deferredComment();
    const flushFrames = queuedAnimationFrames();
    const rendered = setup({ onAddComment: vi.fn(() => pending.promise) });
    const outside = render(<button type="button">Other workspace</button>).getByRole("button", { name: "Other workspace" });
    const other = destination === "inside" || destination === "mention"
      ? within(rendered.container).getByRole("button", { name: destination === "mention" ? "@Priya Shah" : "New note" }) : outside;
    const composer = within(rendered.container).getByRole("textbox");
    const focus = vi.spyOn(composer, "focus");
    fireEvent.change(composer, { target: { value: "Retry me" } });
    if (destination.startsWith("outside before submit")) other.focus();
    fireEvent.submit(composer.closest("form"));
    expect(composer).toHaveAttribute("aria-disabled", "true");
    other.focus();
    if (destination.endsWith("then body")) other.blur();

    await act(async () => pending.reject(new Error("refused")));
    flushFrames();
    expect(destination.endsWith("then body") ? document.body : other).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(composer).toBeEnabled();
    expect(composer).toHaveValue("Retry me");
    expect(within(rendered.container).getByRole("alert")).toHaveTextContent("not added");
  });

  it.each(["success", "rejection"])("cancels pending %s focus when the view unmounts", async (outcome) => {
    const pending = deferredComment();
    const flushFrames = queuedAnimationFrames();
    const rendered = setup({ onAddComment: vi.fn(() => pending.promise) });
    const composer = within(rendered.container).getByRole("textbox");
    const focus = vi.spyOn(composer, "focus");
    fireEvent.change(composer, { target: { value: "Pending note" } });
    fireEvent.submit(composer.closest("form"));
    rendered.unmount();
    const nextView = setup();
    const nextControl = within(nextView.container).getByRole("button", { name: "New note" });
    nextControl.focus();

    await act(async () => {
      if (outcome === "success") pending.resolve({ id: "created" });
      else pending.reject(new Error("refused"));
    });
    flushFrames();
    expect(composer.isConnected).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(nextControl).toHaveFocus();
    expect(within(nextView.container).getByRole("textbox")).toHaveValue("");
  });

  it("renders unavailable and truncated truths independently without false emptiness", () => {
    const rendered = setup({
      tasks: [baseTasks[0]],
      commentsUnavailable: true,
      commentsTruncated: true,
    });
    expect(within(rendered.container).getByRole("alert")).toHaveTextContent("Task updates are unavailable");
    expect(rendered.container).toHaveTextContent("Only the newest 2,000 field notes are loaded");
    expect(rendered.container).toHaveTextContent("No notes for this task are in the newest 2,000");
    expect(rendered.container).not.toHaveTextContent("No field notes yet.");
  });

  it("labels demo at surface scope and keeps empty task/create and open actions honest", () => {
    const rendered = setup({ tasks: [baseTasks[0]], demo: true });
    expect(rendered.container).toHaveTextContent("PREVIEW · session-only");
    fireEvent.click(within(rendered.container).getByRole("button", { name: "Open task with field notes for First task" }));
    expect(rendered.props.onOpen).toHaveBeenCalledWith(baseTasks[0]);

    rendered.rerender(<TaskFieldNotesView {...rendered.props} tasks={[]} />);
    fireEvent.click(within(rendered.container).getByRole("button", { name: "New task" }));
    expect(rendered.props.onCreate).toHaveBeenCalledTimes(1);
  });

  // REQ-UG-FIELD-NOTES-AI-PACKET-20261001
  it("offers the packet control only with the switch on, caps the selection and shows the draft for review", async () => {
    const comments = [
      comment("note-1", "task-a", "2026-10-01T10:00:00.000Z", "First note"),
      comment("note-2", "task-a", "2026-10-02T10:00:00.000Z", "Second note"),
      comment("note-3", "task-a", "2026-10-03T10:00:00.000Z", "Third note"),
    ];
    const off = setup({ comments });
    expect(within(off.container).queryByRole("button", { name: "Draft a packet" })).toBeNull();
    off.unmount();

    const draft = vi.fn(async () => ({
      packet: {
        headline: "Night shift staffing",
        summary: "Members report short staffing.",
        plainLanguage: "Bring your notes.",
        checklist: ["Your schedule"],
        questions: ["How will coverage be set?"],
        citations: [{ marker: "S2", title: "Grievance steps" }],
      },
      sources: [
        { marker: "S1", id: "kb:1", title: "Grievance steps", ref: "Article 11" },
        { marker: "S2", id: "kb:2", title: "Grievance steps", ref: "Article 12" },
      ],
    }));
    const rendered = setup({ comments, packet: { noteLimit: 2, draft } });
    const open = within(rendered.container).getByRole("button", { name: "Draft a packet" });
    fireEvent.click(open);
    const panel = within(rendered.container).getByRole("form", { name: "Draft packet from field notes" });
    const boxes = within(panel).getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    // The organization's limit is two, so the third note cannot be added.
    expect(boxes[2].disabled).toBe(true);
    expect(within(panel).getByText("2 of 2 notes selected")).toBeTruthy();

    await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "Draft the packet" })); });
    expect(draft).toHaveBeenCalledWith("task-a", ["note-1", "note-2"]);
    const review = await waitFor(() => within(rendered.container).getByLabelText("Draft for review"));
    expect(within(review).getByText("Night shift staffing")).toBeTruthy();
    expect(within(review).getByText("Grievance steps · Article 12")).toBeTruthy();
    expect(within(review).queryByText("Grievance steps · Article 11")).toBeNull();

    fireEvent.click(within(rendered.container).getByRole("button", { name: "Close" }));
    expect(within(rendered.container).queryByLabelText("Draft for review")).toBeNull();
  });

  it("shows the server's refusal copy and never drafts without a selection", async () => {
    const comments = [comment("note-1", "task-a", "2026-10-01T10:00:00.000Z", "First note")];
    const draft = vi.fn(async () => { throw Object.assign(new Error("off"), { code: "feature_disabled" }); });
    const rendered = setup({ comments, packet: { noteLimit: 4, draft } });
    fireEvent.click(within(rendered.container).getByRole("button", { name: "Draft a packet" }));
    const panel = within(rendered.container).getByRole("form", { name: "Draft packet from field notes" });
    expect(within(panel).getByRole("button", { name: "Draft the packet" }).disabled).toBe(true);

    fireEvent.click(within(panel).getAllByRole("checkbox")[0]);
    await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "Draft the packet" })); });
    expect(await waitFor(() => within(panel).getByRole("alert"))).toHaveProperty(
      "textContent",
      "Your organization has turned off draft packets from field notes.",
    );
  });

  it.each(["task", "member", "chapter", "switch"].flatMap((context) => ["success", "rejection"].map((outcome) => [context, outcome])))("discards a pending packet after a %s change and stale %s, including return to the original context", async (context, outcome) => {
    const pending = deferredComment();
    const draft = vi.fn(() => pending.promise);
    const rendered = setup({
      comments: [
        comment("note-1", "task-a", "2026-10-02T10:00:00.000Z", "First note"),
        comment("note-2", "task-b", "2026-10-01T10:00:00.000Z", "Second note"),
      ],
      packet: { noteLimit: 4, draft },
    });
    const view = within(rendered.container);
    fireEvent.click(view.getByRole("button", { name: "Draft a packet" }));
    const panel = view.getByRole("form", { name: "Draft packet from field notes" });
    fireEvent.click(within(panel).getByRole("checkbox"));
    fireEvent.submit(panel);
    expect(draft).toHaveBeenCalledWith("task-a", ["note-1"]);

    if (context === "task") {
      const index = view.getByRole("list", { name: "Tasks with field notes" });
      fireEvent.click(within(index).getByRole("button", { name: /Second task/ }));
      fireEvent.click(view.getByRole("button", { name: "Draft a packet" }));
      expect(view.queryByLabelText("Draft for review")).toBeNull();
      fireEvent.click(within(index).getByRole("button", { name: /First task/ }));
    } else {
      const changed = context === "member" ? { memberId: "member-2" }
        : context === "chapter" ? { chapterId: "chapter-2" } : { packet: null };
      rendered.rerender(<TaskFieldNotesView {...rendered.props} {...changed} />);
      rendered.rerender(<TaskFieldNotesView {...rendered.props} />);
    }
    fireEvent.click(view.getByRole("button", { name: "Draft a packet" }));
    const freshPanel = view.getByRole("form", { name: "Draft packet from field notes" });
    expect(view.queryByLabelText("Draft for review")).toBeNull();
    fireEvent.click(within(freshPanel).getByRole("checkbox"));
    const fresh = deferredComment();
    draft.mockImplementationOnce(() => fresh.promise);
    fireEvent.submit(freshPanel);
    expect(draft).toHaveBeenCalledTimes(2);
    await act(async () => {
      if (outcome === "success") pending.resolve({ packet: { headline: "Stale packet", checklist: [], questions: [], citations: [] }, sources: [] });
      else pending.reject(new Error("stale refusal"));
    });
    expect(within(freshPanel).getByRole("button", { name: "Drafting…" })).toHaveAttribute("aria-disabled", "true");
    expect(within(freshPanel).queryByRole("alert")).toBeNull();
    await act(async () => fresh.resolve({ packet: { headline: "Current packet", checklist: [], questions: [], citations: [] }, sources: [] }));
    expect(view.getByLabelText("Draft for review")).toHaveTextContent("Current packet");
    expect(rendered.container).not.toHaveTextContent("Stale packet");
  });
});

// The note save and the packet draft each keep their control
// focused and pending while they run, refuse a second activation in the same
// tick, and end their lock wherever their busy state ends.
describe("Field notes writes while they run", () => {
  const notes = [
    comment("note-1", "task-a", "2026-10-02T10:00:00.000Z", "First note"),
    comment("note-2", "task-b", "2026-10-01T10:00:00.000Z", "Second note"),
  ];
  const packetResult = { packet: { headline: "Packet", summary: "", plainLanguage: "", checklist: [], questions: [], citations: [] }, sources: [] };
  const openPacket = (view) => {
    fireEvent.click(view.getByRole("button", { name: "Draft a packet" }));
    const panel = view.getByRole("form", { name: "Draft packet from field notes" });
    fireEvent.click(within(panel).getByRole("checkbox"));
    return within(panel).getByRole("button", { name: "Draft the packet" });
  };

  it("keeps Add note focused and the composer pending while the note is saved", async () => {
    const rendered = setup();
    const view = within(rendered.container);
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Night shift is short." } });
    const add = view.getByRole("button", { name: "Add note" });
    await expectHeldWriteFocus(rendered.props.onAddComment, add, () => {
      fireEvent.click(add);
      expect(view.getByRole("textbox")).toHaveAttribute("aria-disabled", "true");
    });
    expect(rendered.props.onAddComment).toHaveBeenCalledOnce();
  });

  it("saves one note when Add note is activated twice in one tick", async () => {
    const rendered = setup();
    const view = within(rendered.container);
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Night shift is short." } });
    const add = view.getByRole("button", { name: "Add note" });
    await expectOneWriteFromOneTick(rendered.props.onAddComment, [() => fireEvent.click(add), () => fireEvent.click(add)]);
  });

  it("saves again from an immediate press after a save that throws at once", async () => {
    const rendered = setup();
    const view = within(rendered.container);
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Retry me" } });
    await expectReadyRetryAfterThrowAtOnce(rendered.props.onAddComment, view.getByRole("button", { name: "Add note" }));
    expect(view.getByRole("textbox")).toHaveValue("Retry me");
  });

  it("keeps Draft the packet focused while the draft runs, and drafts once from one tick", async () => {
    const draft = vi.fn(async () => packetResult);
    const rendered = setup({ comments: notes, packet: { noteLimit: 4, draft } });
    const button = openPacket(within(rendered.container));
    await expectOneWriteFromOneTick(draft, [() => fireEvent.click(button), () => fireEvent.click(button)]);
    await expectHeldWriteFocus(draft, button);
    expect(draft).toHaveBeenCalledTimes(2);
  });

  it("drafts again from an immediate press after a draft that throws at once", async () => {
    const draft = vi.fn(async () => packetResult);
    const rendered = setup({ comments: notes, packet: { noteLimit: 4, draft } });
    await expectReadyRetryAfterThrowAtOnce(draft, openPacket(within(rendered.container)));
  });

  it("drafts for another task at once after the task switch that ended a running draft", async () => {
    const pending = deferredComment();
    const draft = vi.fn(() => pending.promise);
    const rendered = setup({ comments: notes, packet: { noteLimit: 4, draft } });
    const view = within(rendered.container);
    fireEvent.click(openPacket(view));
    expect(draft).toHaveBeenCalledTimes(1);
    const index = view.getByRole("list", { name: "Tasks with field notes" });
    fireEvent.click(within(index).getByRole("button", { name: /Second task/ }));
    // The switch closed the first draft and its busy state; its lock ended too.
    const second = openPacket(view);
    expect(second).not.toHaveAttribute("aria-disabled");
    fireEvent.click(second);
    expect(draft).toHaveBeenCalledTimes(2);
    expect(draft).toHaveBeenLastCalledWith("task-b", ["note-2"]);
    await act(async () => pending.resolve(packetResult));
  });
});

// A note save's outcome belongs to the task it was for.
describe("Field note save outcome after a task switch", () => {
  it.each(["success", "failure"])("shows a %s that answers after a switch only beside its own task", async (outcome) => {
    const pending = deferredComment();
    const rendered = setup({ onAddComment: vi.fn(() => pending.promise) });
    const view = within(rendered.container);
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Night shift is short." } });
    fireEvent.click(view.getByRole("button", { name: "Add note" }));
    const index = view.getByRole("list", { name: "Tasks with field notes" });
    fireEvent.click(within(index).getByRole("button", { name: /Second task/ }));
    await act(async () => { if (outcome === "success") pending.resolve({ id: "created" }); else pending.reject(new Error("refused")); });
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByRole("status")).toHaveTextContent("");
    fireEvent.click(within(index).getByRole("button", { name: /First task/ }));
    if (outcome === "success") {
      expect(view.getByRole("status")).toHaveTextContent("Field note added.");
      expect(view.getByRole("textbox")).toHaveValue("");
    } else {
      expect(view.getByRole("alert")).toHaveTextContent("The field note was not added. Try again.");
      expect(view.getByRole("textbox")).toHaveValue("Night shift is short.");
    }
    // Leaving the task drops its message, as before.
    fireEvent.click(within(index).getByRole("button", { name: /Second task/ }));
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByRole("status")).toHaveTextContent("");
  });
});

// An outcome its member has not seen yet stays with its
// own task while the member types, saves or opens tasks elsewhere.
describe("Field note save outcome kept through work on other tasks", () => {
  const threeTasks = [...baseTasks, task("task-c", 4, "Third task")];
  it.each(["success", "failure"])("keeps First's %s through typing and a save on Second and a visit to Third", async (outcome) => {
    const pending = deferredComment();
    const onAddComment = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ id: "created-b" });
    const rendered = setup({ tasks: threeTasks, onAddComment });
    const view = within(rendered.container);
    const index = view.getByRole("list", { name: "Tasks with field notes" });
    const open = (name) => fireEvent.click(within(index).getByRole("button", { name }));
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Night shift is short." } });
    fireEvent.click(view.getByRole("button", { name: "Add note" }));
    open(/Second task/);
    await act(async () => { if (outcome === "success") pending.resolve({ id: "created-a" }); else pending.reject(new Error("refused")); });
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Note for B" } });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Add note" })); });
    expect(view.getByRole("status")).toHaveTextContent("Field note added.");
    open(/Third task/);
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByRole("status")).toHaveTextContent("");
    open(/First task/);
    if (outcome === "success") {
      expect(view.getByRole("status")).toHaveTextContent("Field note added.");
      expect(view.getByRole("textbox")).toHaveValue("");
    } else {
      expect(view.getByRole("alert")).toHaveTextContent("The field note was not added. Try again.");
      expect(view.getByRole("textbox")).toHaveValue("Night shift is short.");
    }
    expect(onAddComment.mock.calls.map((call) => [call[0], call[1]])).toEqual([["task-a", "Night shift is short."], ["task-b", "Note for B"]]);
    // Second's own message was dropped when the member left it, as before.
    open(/Second task/);
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByRole("status")).toHaveTextContent("");
  });

  it("keeps the open task's message when its own button is pressed again, and drops it when the member types there", async () => {
    const rendered = setup({ onAddComment: vi.fn().mockRejectedValue(new Error("refused")) });
    const view = within(rendered.container);
    const index = view.getByRole("list", { name: "Tasks with field notes" });
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Night shift is short." } });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Add note" })); });
    expect(view.getByRole("alert")).toHaveTextContent("The field note was not added. Try again.");
    fireEvent.click(within(index).getByRole("button", { name: /First task/ }));
    expect(view.getByRole("alert")).toHaveTextContent("The field note was not added. Try again.");
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Night shift is short, retry." } });
    expect(view.queryByRole("alert")).toBeNull();
  });
});

// Outcome messages belong to one member in one
// chapter and to tasks still in the list.
describe("Field note outcome messages across a scope change and a list change", () => {
  const FAILED = "The field note was not added. Try again.";
  async function failOnFirst(rendered) {
    const view = within(rendered.container);
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Night shift is short." } });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Add note" })); });
    expect(view.getByRole("alert")).toHaveTextContent(FAILED);
    return view;
  }
  const rerenderWith = (rendered, changes) => rendered.rerender(<TaskFieldNotesView {...rendered.props} {...changes} />);

  it.each([["member", { memberId: "member-3" }], ["chapter", { chapterId: "chapter-2" }]])("clears every outcome message when the %s changes while the view stays mounted", async (_label, changes) => {
    const rendered = setup({ onAddComment: vi.fn().mockRejectedValue(new Error("refused")) });
    const view = await failOnFirst(rendered);
    rerenderWith(rendered, changes);
    expect(view.queryByRole("alert")).toBeNull();
    rerenderWith(rendered, {});
    expect(view.queryByRole("alert")).toBeNull();
  });

  it("does not show an outcome that answers after the member changed", async () => {
    const pending = deferredComment();
    const rendered = setup({ onAddComment: vi.fn(() => pending.promise) });
    const view = within(rendered.container);
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Night shift is short." } });
    fireEvent.click(view.getByRole("button", { name: "Add note" }));
    rerenderWith(rendered, { memberId: "member-3" });
    await act(async () => pending.reject(new Error("refused")));
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByRole("status")).toHaveTextContent("");
  });

  it("drops a task's unseen outcome when the task leaves the list", async () => {
    const pending = deferredComment();
    const rendered = setup({ onAddComment: vi.fn(() => pending.promise) });
    const view = within(rendered.container);
    const index = () => view.getByRole("list", { name: "Tasks with field notes" });
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Night shift is short." } });
    fireEvent.click(view.getByRole("button", { name: "Add note" }));
    fireEvent.click(within(index()).getByRole("button", { name: /Second task/ }));
    await act(async () => pending.reject(new Error("refused")));
    rerenderWith(rendered, { tasks: baseTasks.filter((item) => item.id !== "task-a") });
    rerenderWith(rendered, {});
    fireEvent.click(within(index()).getByRole("button", { name: /First task/ }));
    expect(view.queryByRole("alert")).toBeNull();
  });
});

// A late answer is shown only in the member-and-chapter
// activation it started in, and only while its task is listed.
describe("Field note late answers after the list or the member changed and came back", () => {
  const FAILED = "The field note was not added. Try again.";
  const rerenderWith = (rendered, changes) => rendered.rerender(<TaskFieldNotesView {...rendered.props} {...changes} />);
  async function nextPressOnFirst(view, onAddComment) {
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Next note" } });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Add note" })); });
    expect(view.getByRole("status")).toHaveTextContent("Field note added.");
    expect(onAddComment.mock.calls.map((call) => [call[0], call[1]])).toEqual([["task-a", "Night shift is short."], ["task-a", "Next note"]]);
  }

  it("does not bring back an outcome that answers while its task is out of the list", async () => {
    const pending = deferredComment();
    const onAddComment = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ id: "created" });
    const rendered = setup({ onAddComment });
    const view = within(rendered.container);
    const index = () => view.getByRole("list", { name: "Tasks with field notes" });
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Night shift is short." } });
    fireEvent.click(view.getByRole("button", { name: "Add note" }));
    fireEvent.click(within(index()).getByRole("button", { name: /Second task/ }));
    rerenderWith(rendered, { tasks: baseTasks.filter((item) => item.id !== "task-a") });
    await act(async () => pending.reject(new Error("refused")));
    rerenderWith(rendered, {});
    fireEvent.click(within(index()).getByRole("button", { name: /First task/ }));
    expect(view.queryByRole("alert")).toBeNull();
    await nextPressOnFirst(view, onAddComment);
  });

  it("does not show an earlier answer after the member changes and changes back", async () => {
    const pending = deferredComment();
    const onAddComment = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ id: "created" });
    const rendered = setup({ onAddComment });
    const view = within(rendered.container);
    fireEvent.change(view.getByRole("textbox"), { target: { value: "Night shift is short." } });
    fireEvent.click(view.getByRole("button", { name: "Add note" }));
    rerenderWith(rendered, { memberId: "member-3" });
    rerenderWith(rendered, {});
    await act(async () => pending.reject(new Error("refused")));
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByText(FAILED)).toBeNull();
    await nextPressOnFirst(view, onAddComment);
  });
});
