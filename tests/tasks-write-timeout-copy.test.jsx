import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { MemberApiError } from "../src/lib/memberApi.js";
import { TasksView } from "../src/views/TasksView.jsx";
import { TaskModal } from "../src/views/TaskModal.jsx";

const busy = {
  en: "Union Ground is busy right now, so that did not finish. Try again in a moment.",
  es: "Union Ground está ocupado en este momento, así que eso no terminó. Inténtalo de nuevo en un momento.",
};
const refusal = (code = "57014") => new MemberApiError("Update task", {
  code, message: "canceling statement due to statement timeout", details: null,
});
const sourceTask = fallbackData.tasks.find(task => task.id === "task-demo-3");
const assignee = fallbackData.taskAssignees.find(person => person.id !== sourceTask.assigneeId);

function renderTasks(overrides = {}, lang = "en") {
  const data = structuredClone(fallbackData);
  data.tasks = [structuredClone(sourceTask)];
  const props = {
    data, onProfile: vi.fn(), onAssistant: vi.fn(),
    onUpdateTask: vi.fn(async (_id, fields) => ({ ...sourceTask, ...fields })),
    onCreateTask: vi.fn(async fields => ({ ...sourceTask, ...fields, id: "created-task" })),
    ...overrides,
  };
  const view = render(<LanguageProvider lang={lang}><TasksView {...props} /></LanguageProvider>);
  fireEvent.click(screen.getByRole("button", { name: sourceTask.title }));
  return { ...props, remoteTask(patch) {
    props.data = { ...props.data, tasks: [{ ...sourceTask, ...patch }] };
    view.rerender(<LanguageProvider lang={lang}><TasksView {...props} /></LanguageProvider>);
  } };
}

function ModalHarness(props) {
  const { t, lang } = useLang();
  return <TaskModal task={sourceTask} chapterId={fallbackData.member.chapterId}
    assignees={fallbackData.taskAssignees} workstreamNames={[sourceTask.workstream]}
    memberId={fallbackData.member.id} onClose={vi.fn()} t={t} lang={lang} {...props} />;
}

function openAssignees() {
  fireEvent.click(screen.getByRole("button", { name: /^Assignee / }));
  return screen.getByRole("option", { name: new RegExp(assignee.fullName) });
}

function editContent(field, value, blur = true) {
  if (field === "description" && !screen.queryByLabelText("Description")) {
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
  }
  const input = screen.getByLabelText(field === "title" ? "Task title" : "Description");
  fireEvent.change(input, { target: { value } });
  if (blur) fireEvent.blur(input, { relatedTarget: screen.getByLabelText("Task title") });
}

const editorAlert = () => within(screen.getByRole("dialog")).getByRole("alert");

describe("task write failure feedback", () => {
  it.each(["title", "description"])("keeps unsent %s typing without overwriting an intervening teammate edit", async field => {
    const props = renderTasks();
    editContent(field, "Still typing", false);
    props.remoteTask({ [field]: "Teammate edit", updatedAt: "2026-10-07T21:01:00.000Z" });
    expect(screen.getByLabelText(field === "title" ? "Task title" : "Description")).toHaveValue("Still typing");
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(editorAlert()).toHaveTextContent("Somebody changed this first"));
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });

  it("adopts a teammate title in a focused but clean field without a phantom close write", async () => {
    const props = renderTasks();
    screen.getByLabelText("Task title").focus();
    props.remoteTask({ title: "Teammate edit", updatedAt: "2026-10-07T21:01:00.000Z" });
    expect(screen.getByLabelText("Task title")).toHaveValue("Teammate edit");
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });

  it.each(["title", "description"])("advances only its own successful %s write before saving queued typing", async field => {
    let resolveB;
    const versionB = "2026-10-07T21:01:00.000Z";
    const onUpdateTask = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveB = resolve; }))
      .mockResolvedValueOnce({ ...sourceTask, [field]: "C", updatedAt: "2026-10-07T21:02:00.000Z" });
    renderTasks({ onUpdateTask });
    editContent(field, "B");
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(1));
    editContent(field, "C");
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
    await act(async () => resolveB({ ...sourceTask, [field]: "B", updatedAt: versionB }));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(2));
    expect(onUpdateTask.mock.calls[1]).toEqual([sourceTask.id, { [field]: "C" }, versionB]);
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onUpdateTask).toHaveBeenCalledTimes(2);
  });

  it.each(["title", "description", "both"])("permits an explicit %s retry while its original content is still authoritative", async field => {
    const fields = field === "both" ? ["title", "description"] : [field];
    const patch = Object.fromEntries(fields.map(key => [key, `Retry ${key}`]));
    const onUpdateTask = vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ ...sourceTask, ...patch });
    renderTasks({ onUpdateTask });
    for (const key of fields) editContent(key, patch[key], false);
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(editorAlert()).toHaveTextContent(busy.en));
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onUpdateTask).toHaveBeenCalledTimes(2);
    expect(onUpdateTask.mock.calls[1]).toEqual([sourceTask.id, patch, sourceTask.updatedAt ?? null]);
  });

  it("adopts a teammate description in an open but untyped editor without a stale close write", async () => {
    const props = renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    props.remoteTask({ description: "Teammate description", updatedAt: "2026-10-07T21:01:00.000Z" });
    expect(screen.getByLabelText("Description")).toHaveValue("Teammate description");
    fireEvent.blur(screen.getByLabelText("Description"), { relatedTarget: screen.getByLabelText("Task title") });
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });

  it("sends a content write queued behind the member's own date write with the token that write produced", async () => {
    let resolveDate;
    const onUpdateTask = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveDate = resolve; }))
      .mockImplementationOnce(async (_id, fields) => ({ ...sourceTask, dueDate: "2026-12-01", ...fields, updatedAt: "2026-10-07T21:05:00.000Z" }));
    const data = { ...structuredClone(fallbackData), tasks: [{ ...sourceTask, updatedAt: "2026-10-07T20:00:00.000Z" }] };
    renderTasks({ data, onUpdateTask });
    fireEvent.click(screen.getByText("Task details", { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-12-01" } });
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(1));
    editContent("title", "Queued title");
    await act(async () => resolveDate({ ...sourceTask, dueDate: "2026-12-01", updatedAt: "2026-10-07T21:00:00.000Z" }));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(2));
    expect(onUpdateTask.mock.calls[1]).toEqual([sourceTask.id, { title: "Queued title" }, "2026-10-07T21:00:00.000Z"]);
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
  });

  it("refuses a queued content write locally when a teammate changed that content first", async () => {
    const versionA = "2026-10-07T20:00:00.000Z";
    let resolveDate;
    const onUpdateTask = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveDate = resolve; }));
    const data = { ...structuredClone(fallbackData), tasks: [{ ...sourceTask, updatedAt: versionA }] };
    const props = renderTasks({ data, onUpdateTask });
    fireEvent.click(screen.getByText("Task details", { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-12-01" } });
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(1));
    editContent("title", "Queued title");
    props.remoteTask({ title: "New teammate title", updatedAt: "2026-10-07T22:00:00.000Z" });
    await act(async () => resolveDate({ ...sourceTask, dueDate: "2026-12-01", updatedAt: "2026-10-07T21:00:00.000Z" }));
    await waitFor(() => expect(editorAlert()).toHaveTextContent("Somebody changed this first"));
    // Neither the stale token nor the teammate's newer one is sent.
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Task title")).toHaveValue("Queued title");
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
  });

  it.each(["title", "description", "both"])("does not resubmit refused %s over a newer teammate edit", async field => {
    const onUpdateTask = vi.fn().mockRejectedValue(refusal());
    const props = renderTasks({ onUpdateTask });
    const fields = field === "both" ? ["title", "description"] : [field];
    for (const key of fields) editContent(key, `Refused ${key}`, false);
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(editorAlert()).toHaveTextContent(busy.en));
    props.remoteTask({ title: "Teammate title", description: "Teammate description", updatedAt: "2026-10-07T21:01:00.000Z" });
    // Retain intentional unsaved text, but never lend it the teammate's token.
    expect(screen.getByLabelText("Task title")).toHaveValue(fields.includes("title") ? "Refused title" : "Teammate title");
    if (field !== "both") editContent(field, `Refused ${field}`);
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(editorAlert()).toHaveTextContent("Somebody changed this first"));
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
  });

  it.each(["title", "description", "both"])("clears only the confirmed %s draft when B fails and C succeeds", async field => {
    let rejectB;
    let resolveC;
    const onUpdateTask = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectB = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveC = resolve; }));
    const props = renderTasks({ onUpdateTask });
    const fields = field === "both" ? ["title", "description"] : [field];
    const submit = value => {
      for (const key of fields) editContent(key, `${value} ${key}`, false);
      if (field === "both") fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
      else fireEvent.blur(screen.getByLabelText(field === "title" ? "Task title" : "Description"), { relatedTarget: screen.getByLabelText("Task title") });
    };
    submit("B");
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(1));
    submit("C");
    await act(async () => rejectB(refusal()));
    // A close waits for an existing flush; after its refusal, explicitly retry C.
    if (field === "both") fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(2));
    await act(async () => resolveC({ ...sourceTask, ...Object.fromEntries(fields.map(key => [key, `C ${key}`])), updatedAt: "2026-10-07T21:01:00.000Z" }));
    // The single-field blur leaves the modal open. A combined close is verified
    // by reopening after its confirmed save.
    if (field === "both") {
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "C title" }));
    }
    props.remoteTask({ title: "D title", description: "D description", updatedAt: "2026-10-07T21:02:00.000Z" });
    expect(screen.getByLabelText("Task title")).toHaveValue("D title");
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onUpdateTask).toHaveBeenCalledTimes(2);
  });

  it("shows the latest deletion or local assignee refusal, including a repeated deletion message", async () => {
    const onDeleteTask = vi.fn().mockRejectedValue(refusal("42501"));
    renderTasks({ onDeleteTask, onSetTaskAssignees: vi.fn().mockRejectedValue(refusal()) });
    for (let attempt = 0; attempt < 2; attempt++) {
      fireEvent.click(openAssignees());
      await waitFor(() => expect(editorAlert()).toHaveTextContent(busy.en));
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove it" }));
      await waitFor(() => expect(editorAlert()).toHaveTextContent("Your role does not allow this change"));
    }
    expect(onDeleteTask).toHaveBeenCalledTimes(2);
  });

  it.each(["en", "es"])("explains a refused rename in %s and keeps the draft", async lang => {
    const onUpdateTask = vi.fn().mockRejectedValue(refusal());
    renderTasks({ onUpdateTask }, lang);
    const field = screen.getByRole("textbox", { name: lang === "en" ? "Task title" : "Título de la tarea" });
    fireEvent.change(field, { target: { value: "Keep this rename for retry" } });
    fireEvent.blur(field);
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(busy[lang]));
    expect(field).toHaveValue("Keep this rename for retry");
    expect(document.body).not.toHaveTextContent("canceling statement");
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
  });

  it("handles a refused date change and restores the stored date", async () => {
    const onUpdateTask = vi.fn().mockRejectedValue(refusal("55P03"));
    renderTasks({ onUpdateTask });
    fireEvent.click(screen.getByText("Task details", { selector: "summary" }));
    const date = screen.getByLabelText("Due date");
    fireEvent.change(date, { target: { value: "2026-12-01" } });
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(busy.en));
    expect(date).toHaveValue(sourceTask.dueDate);
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
  });

  it("handles a refused single-assignee write and retains the prior selection", async () => {
    renderTasks({ onUpdateTask: vi.fn().mockRejectedValue(refusal()) });
    fireEvent.click(openAssignees());
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(busy.en));
    expect(screen.getByRole("button", { name: /^Assignee / })).toHaveTextContent(sourceTask.assigneeName);
  });

  it("handles a refused multi-assignee RPC and permits one explicit retry", async () => {
    let reject;
    const onSetTaskAssignees = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValue({ taskId: sourceTask.id, assigneeIds: [sourceTask.assigneeId, assignee.id] });
    renderTasks({ onSetTaskAssignees });
    const option = openAssignees();
    fireEvent.click(option);
    fireEvent.click(option);
    expect(onSetTaskAssignees).toHaveBeenCalledTimes(1);
    await act(async () => reject(refusal()));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(busy.en);
    expect(option).toHaveAttribute("aria-selected", "false");
    fireEvent.click(option);
    await waitFor(() => expect(onSetTaskAssignees).toHaveBeenCalledTimes(2));
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a description draft on refusal and announces why it failed", async () => {
    render(<LanguageProvider lang="en"><ModalHarness onUpdate={vi.fn().mockRejectedValue(refusal())} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Unsaved description" } });
    fireEvent.blur(screen.getByLabelText("Description"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(busy.en));
    expect(screen.getByLabelText("Description")).toHaveValue("Unsaved description");
  });

  it("keeps unknown driver details out of the local alert", async () => {
    renderTasks({ onUpdateTask: vi.fn().mockRejectedValue(refusal("XX000")) });
    const field = screen.getByLabelText("Task title");
    fireEvent.change(field, { target: { value: "Unsaved title" } });
    fireEvent.blur(field);
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert"))
      .toHaveTextContent("The change did not save. The task was restored."));
    expect(document.body).not.toHaveTextContent("canceling statement");
  });

  it("waits for an in-flight rename when Close follows blur, then keeps a refused draft", async () => {
    let reject;
    const onUpdateTask = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
    renderTasks({ onUpdateTask });
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Keep pending rename" } });
    fireEvent.blur(screen.getByLabelText("Task title"));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    await act(async () => reject(refusal()));
    expect(screen.getByRole("dialog").closest(".kan-modal-backdrop")).not.toHaveAttribute("data-state", "closing");
    expect(screen.getByLabelText("Task title")).toHaveValue("Keep pending rename");
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
  });

  it("still waits for a pending checklist description write before closing", async () => {
    let reject;
    const onUpdateTask = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
    renderTasks({ onUpdateTask });
    fireEvent.click(screen.getByRole("button", { name: /Description/ }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle Call the second shift before Thursday" }));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    await act(async () => reject(refusal()));
    expect(screen.getByRole("dialog").closest(".kan-modal-backdrop")).not.toHaveAttribute("data-state", "closing");
    expect(editorAlert()).toHaveTextContent(busy.en);
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
  });

  it.each(["blur", "Escape"])("advances a description draft opened during a checklist toggle (%s)", async exit => {
    let resolveToggle;
    const onUpdateTask = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveToggle = resolve; }))
      .mockImplementation(async (_id, fields) => ({ ...sourceTask, ...fields, updatedAt: "2026-10-07T21:10:00.000Z" }));
    renderTasks({ onUpdateTask });
    fireEvent.click(screen.getByRole("button", { name: /Description/ }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle Call the second shift before Thursday" }));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(1));
    const toggled = onUpdateTask.mock.calls[0][1].description;
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: `${toggled} note` } });
    await act(async () => resolveToggle({ ...sourceTask, description: toggled, updatedAt: "2026-10-07T21:05:00.000Z" }));
    if (exit === "blur") {
      // The member's own toggle is not a conflict: the typed note saves.
      fireEvent.blur(screen.getByLabelText("Description"), { relatedTarget: screen.getByLabelText("Task title") });
      await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(2));
      expect(onUpdateTask.mock.calls[1][1]).toEqual({ description: `${toggled} note` });
      expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
    } else {
      // Typed back to the saved checklist, Escape dismisses with no write.
      fireEvent.change(screen.getByLabelText("Description"), { target: { value: toggled } });
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(onUpdateTask).toHaveBeenCalledTimes(1);
    }
  });

  it("does not erase an earlier confirmed rename when the next date write fails", async () => {
    const onUpdateTask = vi.fn()
      .mockResolvedValueOnce({ ...sourceTask, title: "Confirmed rename", updatedAt: "2026-10-07T20:00:00.000Z" })
      .mockRejectedValueOnce(refusal());
    renderTasks({ onUpdateTask });
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Confirmed rename" } });
    fireEvent.blur(screen.getByLabelText("Task title"));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Task details", { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-12-01" } });
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(busy.en));
    expect(screen.getByLabelText("Task title")).toHaveValue("Confirmed rename");
  });

  it("keeps newer typing when an older rename is refused", async () => {
    let reject;
    const onUpdateTask = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
    renderTasks({ onUpdateTask });
    const field = screen.getByLabelText("Task title");
    fireEvent.change(field, { target: { value: "First rename" } });
    fireEvent.blur(field);
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(1));
    field.focus();
    fireEvent.change(field, { target: { value: "Newer unsent rename" } });
    await act(async () => reject(refusal()));
    expect(field).toHaveValue("Newer unsent rename");
    expect(onUpdateTask).toHaveBeenCalledTimes(1);
  });

  it("renders confirmed rename and date responses with one call per edit", async () => {
    const props = renderTasks();
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Confirmed title" } });
    fireEvent.blur(screen.getByLabelText("Task title"));
    await waitFor(() => expect(props.onUpdateTask).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Task title")).toHaveValue("Confirmed title");
    expect(props.onUpdateTask.mock.calls[0]).toEqual([sourceTask.id, { title: "Confirmed title" }, sourceTask.updatedAt ?? null]);
    fireEvent.click(screen.getByText("Task details", { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-12-01" } });
    await waitFor(() => expect(props.onUpdateTask).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Due date")).toHaveValue("2026-12-01");
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).not.toBeInTheDocument();
  });
});
