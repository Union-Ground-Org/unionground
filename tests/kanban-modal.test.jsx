import { confirmEvidenceUpload } from "./helpers/confirm-evidence-upload.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { MemberApiError } from "../src/lib/memberApi.js";
import { TaskModal } from "../src/views/TaskModal.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

// TaskModal is the one surface where a member can change every field on a
// card, and it replaced FOUR older components at once (TaskEditor, the
// per-card message dialog, the assignee picker and the status select). That
// makes it the single richest regression target in the kanban rebuild, and the
// bug class I care about here is not "does it render" — it is "does a control
// write the RIGHT patch, ONCE, and refuse to write when it should".
//
// Every write in this component is a single-field patch on purpose: the board
// owns renumbering and undo, and a full-object save from the modal would race
// it and resurrect whatever the board had just changed. So I assert the exact
// patch shape, not just that onUpdate fired. Three guards in particular exist
// because the naive implementation gets them wrong:
//
//   * the quick-pick digits (t0ggles' picker idiom) must NOT fire while the
//     assignee popover's filter field has focus — a member typing "R2" into
//     the filter would otherwise silently reassign the card;
//   * the range input fires change on every step of a drag, so the commit is
//     bound to the END of the gesture (pointerup / keyup / blur) — twenty
//     writes per adjustment is the bug this pins shut;
//   * Escape has TWO meanings here. With a picker open it closes the picker;
//     otherwise it closes the modal. Both branches preventDefault so
//     TasksView's window-level keyboard map (which skips defaultPrevented
//     events) never reads the same press as "exit focus mode" as well.
//
// I render the modal directly rather than through TasksView because the pins
// above are contracts of THIS component's prop surface. The wrapper is
// LanguageProvider only; a tiny harness hands the context's t/lang down as the
// props the component actually declares, so the copy under test is the real
// shipped copy in both locales and never a test-local literal.

// The history popover binds a DYNAMIC catalogue key, t(`kanban.activity.${action}`),
// and lookup() falls through to the key itself when neither locale carries the
// string — so a member sees "kanban.activity.template_flow_changed" rather than
// copy. The vocabulary lives in the database, not in the client, so this reads
// the LAST chapter_task_activity_action_check out of the migrations (they apply
// in filename order, each one dropping and re-adding the constraint) instead of
// mirroring it here: the next action added to the constraint fails this suite
// until both catalogues catch up.
const MIGRATIONS_DIR = resolve(process.cwd(), "supabase/migrations");
const ACTION_CHECK = /chapter_task_activity_action_check\s+check\s*\(\s*action\s+in\s*\(([^)]+)\)/g;

function allowedActivityActions() {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
  let latest = null;
  for (const name of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    for (const match of sql.matchAll(ACTION_CHECK)) latest = match[1];
  }
  expect(latest, "no chapter_task_activity_action_check found in supabase/migrations").not.toBeNull();
  return [...latest.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

// Mirrors the trap's own query. The pin is behavioural (Tab wraps at both
// ends), so the test has to know which elements the trap considers focusable.
const FOCUSABLE = "button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

// Deliberately five DIFFERENT numbers: equal counts would let a swapped index
// pass. These are whole-board counts, which is why they do not match the
// fixture's own per-status totals.
const STATUS_COUNTS = { backlog: 5, to_do: 11, in_progress: 3, needs_review: 2, done: 7 };

const WORKSTREAMS = ["Bargaining", "Chapter", "Communications", "Grievances", "Organizing", "Safety"];

const MARIA = "22222222-2222-4222-8222-222222222222";
const PRIYA = "33333333-3333-4333-8333-333333333333";
const JORDAN = "44444444-4444-4444-8444-444444444444";

function Harness(props) {
  const { lang, t } = useLang();
  return <TaskModal {...props} t={t} lang={lang} />;
}

function renderModal({ taskId = "task-demo-3", task: taskPatch = {}, ...overrides } = {}, lang = "en") {
  const data = structuredClone(fallbackData);
  const props = {
    task: { ...data.tasks.find((item) => item.id === taskId), ...taskPatch },
    chapterId: data.member.chapterId,
    assignees: data.taskAssignees,
    documents: data.product.documents,
    workstreamNames: WORKSTREAMS,
    memberId: data.member.id,
    messages: data.taskMessages,
    comments: data.taskComments.filter((item) => item.taskId === taskId),
    attachments: data.taskAttachments.filter((item) => item.taskId === taskId),
    activity: data.taskActivity.filter((item) => item.taskId === taskId),
    creatorName: "Darnell Foster",
    onClose: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onAddComment: vi.fn(async () => ({ id: "task-comment-new" })),
    onSendMessage: vi.fn(async () => ({ id: "task-message-new" })),
    onAddAttachment: vi.fn(async () => ({ id: "task-attachment-new" })),
    onRemoveAttachment: vi.fn(async () => ({ deleted: true })),
    onAssignFocus: false,
    statusCounts: STATUS_COUNTS,
    ...overrides,
  };
  render(<LanguageProvider lang={lang}><Harness {...props} /></LanguageProvider>);
  return props;
}

function statusOptions() {
  return within(screen.getByRole("listbox", { name: "Task status" })).getAllByRole("option");
}

describe("kanban task modal", () => {
  it("opens the TASK STATUS listbox with a colored dot, a count and a quick-pick digit per status", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "In progress" }));

    const options = statusOptions();
    expect(options).toHaveLength(5);
    // Canonical order, not board-grouping order: the picker walks the path a
    // card travels, so digit 1 is always Backlog.
    expect(options.map((option) => option.querySelector(".kan-dot").className)).toEqual([
      "kan-dot kan-dot--backlog",
      "kan-dot kan-dot--to_do",
      "kan-dot kan-dot--in_progress",
      "kan-dot kan-dot--needs_review",
      "kan-dot kan-dot--done",
    ]);
    expect(options.map((option) => option.querySelector(".kan-kbd").textContent)).toEqual(["1", "2", "3", "4", "5"]);
    expect(options.map((option) => option.querySelector("b").textContent)).toEqual(["5", "11", "3", "2", "7"]);
    // The card's own status is the selected option — this is what a screen
    // reader reads back before anything is chosen.
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
  });

  it("renders the status picker without counts when the parent passes none", () => {
    renderModal({ statusCounts: null });
    fireEvent.click(screen.getByRole("button", { name: "In progress" }));
    // A zero beside every status would read as "the board is empty", so the
    // absent prop means absent numbers, not zeroes.
    expect(statusOptions().every((option) => option.querySelector("b") === null)).toBe(true);
  });

  it("selects a status by typing its quick-pick digit", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "In progress" }));
    fireEvent.keyDown(statusOptions()[0], { key: "5" });

    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith({ status: "done" });
    // Choosing also closes the popover: a picker that stayed open would eat
    // the next digit the member types.
    expect(screen.queryByRole("listbox", { name: "Task status" })).not.toBeInTheDocument();
  });

  it("does not re-write the status a card already has", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "In progress" }));
    fireEvent.keyDown(statusOptions()[2], { key: "3" });
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("selects a priority by its quick-pick digit", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Priority High" }));

    const options = within(screen.getByRole("listbox", { name: "Priority" })).getAllByRole("option");
    expect(options.map((option) => option.querySelector(".kan-kbd").textContent)).toEqual(["1", "2", "3"]);
    fireEvent.keyDown(options[0], { key: "3" });
    expect(props.onUpdate).toHaveBeenCalledWith({ priority: "low" });
  });

  it("filters the assignee list, unassigns on digit 0, and commits the chosen id", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Assignee Priya Shah" }));

    const list = document.querySelector(".task-assignee-options");
    // Unassigned first, then the four campaign workers.
    expect(within(list).getAllByRole("option")).toHaveLength(5);
    fireEvent.change(screen.getByLabelText("Filter people"), { target: { value: "maria" } });
    const filtered = within(list).getAllByRole("option");
    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toHaveTextContent("Unassigned");
    expect(filtered[1]).toHaveTextContent("Maria Santos");

    fireEvent.click(filtered[1]);
    expect(props.onUpdate).toHaveBeenCalledWith({ assigneeId: MARIA });
  });

  it("unassigns with digit 0 from the option list", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Assignee Priya Shah" }));
    const list = document.querySelector(".task-assignee-options");
    fireEvent.keyDown(within(list).getAllByRole("option")[1], { key: "0" });
    // null, not "": the column is nullable and an empty string is not a member.
    expect(props.onUpdate).toHaveBeenCalledWith({ assigneeId: null });
  });

  it("keeps multiple assignees selected and appends another member", () => {
    const onSetAssignees = vi.fn();
    renderModal({
      task: { assigneeIds: [PRIYA, MARIA], assigneeId: PRIYA, assigneeName: "Priya Shah" },
      onSetAssignees,
    });
    fireEvent.click(screen.getByRole("button", { name: "Assignee 2 assignees" }));
    const list = screen.getByRole("listbox", { name: "Assignee" });
    expect(within(list).getByRole("option", { name: /Priya Shah/ })).toHaveAttribute("aria-selected", "true");
    expect(within(list).getByRole("option", { name: /Maria Santos/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(list).getByRole("option", { name: /Jordan Lee/ }));
    expect(onSetAssignees).toHaveBeenCalledWith("task-demo-3", [PRIYA, MARIA, JORDAN]);
    expect(screen.getByRole("listbox", { name: "Assignee" })).toBeInTheDocument();
  });

  it("ignores quick-pick digits typed into the picker's own filter field", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Assignee Priya Shah" }));
    const filter = screen.getByLabelText("Filter people");
    // "0" here is a character in a name being typed, not the unassign key.
    fireEvent.keyDown(filter, { key: "0" });
    fireEvent.change(filter, { target: { value: "0" } });

    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox", { name: "Assignee" })).toBeInTheDocument();
  });

  it("moves the card to another workstream from the header pill", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Organizing" }));

    const listbox = screen.getByRole("listbox", { name: "Workstream" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(WORKSTREAMS.length);
    fireEvent.click(within(listbox).getByRole("option", { name: "Grievances" }));
    expect(props.onUpdate).toHaveBeenCalledWith({ workstream: "Grievances" });
  });

  // BUG-UG-TASK-TYPE-CHANGE-OPENS-TEMPLATE-CHOOSER-20261111: picking
  // a specialized type keeps this editor open and explains in place; the
  // template chooser opens only when the person asks for it.
  it("keeps the editor open on a specialized type and offers a template only on request", () => {
    const onUseTemplate = vi.fn();
    const props = renderModal({ onUseTemplate });
    const details = screen.getByText("Task details").closest("details");
    expect(details).toHaveAttribute("open");
    const type = screen.getByRole("combobox", { name: "Type" });
    fireEvent.change(type, { target: { value: "issue_incident" } });
    expect(onUseTemplate).not.toHaveBeenCalled();
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(type).toHaveValue("general");
    expect(screen.getByText(/start from a template.*stays General/i).closest("[role=status]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start from a template" }));
    expect(onUseTemplate).toHaveBeenCalledTimes(1);
    fireEvent.change(type, { target: { value: "general" } });
    expect(screen.queryByRole("button", { name: "Start from a template" })).toBeNull();
  });

  it("explains the type without a template button when templates are unavailable", () => {
    renderModal({ onUseTemplate: null });
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "meeting_event" } });
    expect(screen.getByText(/start from a template.*stays General/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start from a template" })).toBeNull();
  });

  // A11Y-UG-FOCUS-AND-ACCESSIBLE-NAME-GAPS-FROM-REVIEWS-20261117:
  // the note and its button sat inside the Type label, so
  // they grew the combobox's accessible name. The name is the label alone and
  // the note describes it.
  it("names the Type combobox by its label alone and describes it with the note", () => {
    renderModal({ onUseTemplate: vi.fn() });
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "meeting_event" } });
    const type = screen.getByRole("combobox", { name: "Type" });
    expect(type).toHaveAccessibleName("Type");
    expect(type).toHaveAccessibleDescription(/start from a template.*stays General/i);
    expect(type.closest("label")).not.toContainElement(screen.getByRole("button", { name: "Start from a template" }));
    fireEvent.change(type, { target: { value: "general" } });
    expect(type).toHaveAccessibleName("Type");
    expect(type).not.toHaveAttribute("aria-describedby");
  });

  it("names a locked Type combobox by its label alone and describes it with the lock note", () => {
    renderModal({ task: { taskType: "document_request" } });
    const type = screen.getByRole("combobox", { name: "Type" });
    expect(type).toHaveAccessibleName("Type");
    expect(type).toHaveAccessibleDescription("Template type is fixed after creation.");
  });

  // #8211 option A: with the conversion write, picking a type opens that
  // template's fields in place and changes the task's type on submit.
  it("changes a General task's type in place with the template's required fields", async () => {
    const onConvertType = vi.fn().mockResolvedValue({});
    const onUseTemplate = vi.fn();
    renderModal({ templates: fallbackData.taskTemplates, onConvertType, onUseTemplate });
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "meeting_event" } });
    const panel = screen.getByRole("region", { name: "Change this task to Meeting or Event" });
    expect(within(panel).queryByRole("button", { name: "Start from a template" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Change type" }));
    expect(onConvertType).not.toHaveBeenCalled();
    expect(within(panel).getAllByRole("alert").length).toBeGreaterThan(0);
    fireEvent.change(within(panel).getByLabelText("Scheduled date"), { target: { value: "2026-12-01" } });
    fireEvent.change(within(panel).getByLabelText("Venue mode"), { target: { value: "video" } });
    await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "Change type" })); });
    expect(onConvertType).toHaveBeenCalledWith({ templateKey: "meeting_event", fields: expect.objectContaining({ scheduled_on: "2026-12-01", venue_mode: "video" }) });
    expect(onUseTemplate).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Change this task to Meeting or Event" })).toBeNull();
  });

  // Change type stays focusable while the conversion runs.
  it("keeps Change type focused while the type changes, and converts once", async () => {
    const onConvertType = vi.fn().mockResolvedValue({});
    renderModal({ templates: fallbackData.taskTemplates, onConvertType, onUseTemplate: vi.fn() });
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "meeting_event" } });
    const panel = screen.getByRole("region", { name: "Change this task to Meeting or Event" });
    fireEvent.change(within(panel).getByLabelText("Scheduled date"), { target: { value: "2026-12-01" } });
    fireEvent.change(within(panel).getByLabelText("Venue mode"), { target: { value: "video" } });
    await expectHeldWriteFocus(onConvertType, within(panel).getByRole("button", { name: "Change type" }));
    expect(onConvertType).toHaveBeenCalledTimes(1);
  });

  // Gate round 1 (r2s2): the converter accepts a staff reviewer only, so the
  // Reviewer field offers the staff roster, never the chapter-wide one.
  it("offers only staff reviewers when a General task changes to Review or Approval", async () => {
    const onConvertType = vi.fn().mockResolvedValue({});
    const templateReviewers = [
      { id: "55555555-5555-4555-8555-555555555555", fullName: "Sam Okafor" },
      { id: "66666666-6666-4666-8666-666666666666", fullName: "Jordan Patel" },
    ];
    renderModal({ templates: fallbackData.taskTemplates, templateReviewers, onConvertType });
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "review_approval" } });
    const panel = screen.getByRole("region", { name: "Change this task to Review or Approval" });
    const offered = within(within(panel).getByLabelText("Reviewer")).getAllByRole("option").map((option) => option.value).filter(Boolean);
    expect(offered).toEqual(templateReviewers.map((person) => person.id));
    for (const member of fallbackData.taskAssignees) expect(offered).not.toContain(member.id);
    fireEvent.change(within(panel).getByLabelText("Review kind"), { target: { value: "document" } });
    fireEvent.change(within(panel).getByLabelText("Reviewer"), { target: { value: templateReviewers[1].id } });
    await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "Change type" })); });
    expect(onConvertType).toHaveBeenCalledWith({ templateKey: "review_approval", fields: expect.objectContaining({ review_kind: "document", reviewer_id: templateReviewers[1].id }) });
  });

  it("keeps the person's entries and says so when the type change is refused", async () => {
    const onConvertType = vi.fn().mockRejectedValue(new Error("template fields invalid"));
    renderModal({ templates: fallbackData.taskTemplates, onConvertType });
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "issue_incident" } });
    const panel = screen.getByRole("region", { name: "Change this task to Issue or Incident" });
    fireEvent.change(within(panel).getByLabelText("Occurrence date"), { target: { value: "2026-11-02" } });
    fireEvent.change(within(panel).getByLabelText("Operational severity"), { target: { value: "high" } });
    await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "Change type" })); });
    expect(within(panel).getByRole("alert")).toHaveTextContent("The type could not be changed. Your entries are still here.");
    expect(within(panel).getByLabelText("Occurrence date")).toHaveValue("2026-11-02");
    fireEvent.click(within(panel).getByRole("button", { name: "Keep it General" }));
    expect(screen.queryByRole("region", { name: "Change this task to Issue or Incident" })).toBeNull();
  });

  it("keeps specialized fields and flow inside the expanded Task details disclosure", () => {
    const template = fallbackData.taskTemplates.find((item) => item.key === "document_request");
    const templateDetails = fallbackData.taskTemplateDetails.find((item) => item.taskId === "task-demo-2");
    renderModal({
      taskId: "task-demo-2",
      task: { taskType: "document_request" },
      template,
      templateDetails,
      onUpdateTemplateDetails: vi.fn(),
    });
    const taskDetails = screen.getByText("Task details").closest("details");
    expect(screen.getByRole("region", { name: "Document Request" }).closest("details")).toBe(taskDetails);
  });

  it("shows an explicit rollout-safe state when specialized details are unavailable", () => {
    renderModal({
      task: { taskType: "document_request" },
      template: fallbackData.taskTemplates.find((item) => item.key === "document_request"),
      templateDetails: null,
      onUpdateTemplateDetails: vi.fn(),
    });
    expect(screen.getByText("Template details are not available right now.", { selector: '[role="status"]' })).toBeInTheDocument();
  });

  it("commits a trimmed title on blur", () => {
    const props = renderModal();
    const field = screen.getByLabelText("Task title");
    field.focus();
    fireEvent.change(field, { target: { value: "  Outreach calls, second shift  " } });
    fireEvent.blur(field);
    expect(props.onUpdate).toHaveBeenCalledWith({ title: "Outreach calls, second shift" });
  });

  // Gate review of #9042, P1-1: typing into the middle of a full 160-code-point
  // title must not cut its end off and save the shortened title on blur.
  it("keeps a full title whole when a character is inserted before its end", () => {
    const full = `${"a".repeat(159)}X`;
    const props = renderModal({ task: { title: full } });
    const field = screen.getByLabelText("Task title");
    field.focus();
    fireEvent.change(field, { target: { value: `Q${full}` } });
    expect(field).toHaveValue(full);
    fireEvent.change(field, { target: { value: `${"a".repeat(80)}Q${"a".repeat(79)}X` } });
    expect(field).toHaveValue(full);
    // Selecting the first character and typing "YZ" keeps "Y", as maxLength does.
    fireEvent.change(field, { target: { value: `YZ${full.slice(1)}` } });
    expect(field).toHaveValue(`Y${full.slice(1)}`);
    fireEvent.blur(field);
    expect(props.onUpdate).toHaveBeenLastCalledWith({ title: `Y${full.slice(1)}` });
    expect(props.onUpdate).not.toHaveBeenCalledWith({ title: `Q${"a".repeat(159)}` });
    expect(props.onUpdate).not.toHaveBeenCalledWith({ title: `${"a".repeat(80)}Q${"a".repeat(79)}` });
  });

  it("commits the title on Enter instead of inserting a newline", () => {
    const props = renderModal();
    const field = screen.getByLabelText("Task title");
    field.focus();
    fireEvent.change(field, { target: { value: "Renamed by Enter" } });
    // The field is a textarea so long titles WRAP; Enter still means "done".
    // The handler preventDefaults (no newline lands in the value) and blurs
    // itself, which is what commits — nothing here fires the blur for it.
    const notPrevented = fireEvent.keyDown(field, { key: "Enter" });
    expect(notPrevented).toBe(false);
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith({ title: "Renamed by Enter" });
    expect(field).not.toHaveFocus();
  });

  it("restores the stored title instead of saving an empty one", () => {
    const props = renderModal();
    const field = screen.getByLabelText("Task title");
    field.focus();
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.blur(field);
    // A card with no title is unfindable on the board; blanking the field is
    // an accident, so the field snaps back and nothing is written.
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(field).toHaveValue("Coworker outreach calls");
  });

  // #9912 (W6-8 of #9463): the restore used to be silent. The field now says
  // why, and the line goes once the person types again.
  it.each([
    ["en", "Task title", "A task needs a title. The saved title was put back."],
    ["es", "Título de la tarea", "Una tarea necesita un título. Se restauró el título guardado."],
  ])("says a task needs a title when a cleared title is put back (%s)", (lang, label, message) => {
    const props = renderModal({}, lang);
    const field = screen.getByLabelText(label);
    expect(screen.queryByText(message)).toBeNull();
    field.focus();
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(field).toHaveValue("Coworker outreach calls");
    const alert = screen.getByText(message);
    expect(alert).toHaveAttribute("role", "alert");
    expect(field).toHaveAccessibleDescription(message);
    fireEvent.change(field, { target: { value: "Coworker outreach calls, evening" } });
    expect(screen.queryByText(message)).toBeNull();
  });

  it("refuses a due date before the start date and says why", () => {
    const props = renderModal();
    // task-demo-3 starts 2026-08-17. Nothing server-side rejects an inverted
    // pair (they are two independent columns), so this guard is the only one.
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-07-01" } });

    expect(screen.getByRole("alert")).toHaveTextContent("Due date must be on or after the start date.");
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("commits a valid due date and clears the guard", () => {
    const props = renderModal();
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-09-14" } });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith({ dueDate: "2026-09-14" });
  });

  it("commits a cleared due date as null instead of silently reverting it", () => {
    const props = renderModal();
    // task-demo-3 stores 2026-08-28. The column is nullable; the truthy-only
    // patch used to drop the clear on the floor and the stored date quietly
    // came back on the next echo.
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "" } });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith({ dueDate: null });
  });

  it("skips the pair guard on a cleared side but still refuses an inverted pair", () => {
    const props = renderModal();
    // Half a range is legal: clearing the start commits null with no alert.
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(props.onUpdate).toHaveBeenCalledWith({ startDate: null });

    // Re-enter a start AFTER the stored due date (2026-08-28): with both
    // sides set again the inverted pair is refused and nothing more writes.
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-02" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Due date must be on or after the start date.");
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
  });

  it("commits progress on the end of the gesture, not on every step", () => {
    const props = renderModal();
    const range = screen.getByLabelText(/^Progress/);
    expect(screen.getAllByRole("slider")).toHaveLength(1);
    expect(document.querySelector(".kan-progress-control__bar")).toBeNull();
    fireEvent.change(range, { target: { value: "60" } });
    fireEvent.change(range, { target: { value: "70" } });
    // Two steps of a drag so far: a change-bound commit would be two writes.
    expect(props.onUpdate).not.toHaveBeenCalled();

    fireEvent.pointerUp(range);
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith({ progress: 70 });
  });

  it("locks progress at 100 on a done card", () => {
    renderModal({ taskId: "task-demo-7" });
    const range = screen.getByLabelText(/^Progress/);
    // The server forces progress=100 on Done; an editable slider here would
    // show a number the database is about to overwrite.
    expect(range).toBeDisabled();
    expect(range).toHaveValue("100");
  });

  it("toggles the blocked and milestone chips with aria-pressed", () => {
    // task-demo-4 is blocked and is not a milestone: both chips start on a
    // different footing, so a hard-coded pressed state cannot pass.
    const props = renderModal({ taskId: "task-demo-4" });
    const blocked = screen.getByRole("button", { name: "This task is blocked" });
    const milestone = screen.getByRole("button", { name: "Milestone" });
    expect(blocked).toHaveAttribute("aria-pressed", "true");
    expect(milestone).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(blocked);
    expect(props.onUpdate).toHaveBeenCalledWith({ blocked: false });
    fireEvent.click(milestone);
    expect(props.onUpdate).toHaveBeenCalledWith({ milestone: true });
  });

  it("toggles one checklist line and writes back the whole description", () => {
    const props = renderModal();
    // Checklists are parsed out of `description`, never stored separately, so
    // the write is the ENTIRE description with exactly one box flipped and
    // every other character — the member's own writing — carried through.
    expect(screen.getByText("1 of 2 done")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Description/ }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle Call the second shift before Thursday" }));

    expect(props.onUpdate).toHaveBeenCalledWith({
      description: "Reach the coworkers who have not completed the issue survey."
        + "\n- [x] Pull the list of coworkers who have not answered"
        + "\n- [x] Call the second shift before Thursday",
    });
  });

  it("unticks a checked line back to an empty box", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /Description/ }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle Pull the list of coworkers who have not answered" }));
    expect(props.onUpdate).toHaveBeenCalledWith({
      description: "Reach the coworkers who have not completed the issue survey."
        + "\n- [ ] Pull the list of coworkers who have not answered"
        + "\n- [ ] Call the second shift before Thursday",
    });
  });

  it("commits the description editor on blur and shows the checklist hint", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    // The hint is the only place the checklist syntax is taught; without it
    // the feature is undiscoverable.
    expect(screen.getByText('Lines like "- [ ] step" become a checklist')).toBeInTheDocument();

    const field = screen.getByLabelText("Description");
    field.focus();
    fireEvent.change(field, { target: { value: "- [ ] Call the second shift" } });
    fireEvent.blur(field);
    expect(props.onUpdate).toHaveBeenCalledWith({ description: "- [ ] Call the second shift" });
  });

  it("saves the description when focus leaves the page, keeping the editor open", () => {
    // REQ-UG-FIRST-CLICK-AND-DEAD-CONTROLS-20261030: a blur that
    // leaves the document (another window, the companion frame) kept the
    // editor open without saving; the field had no focus left to blur again,
    // so leaving the task afterwards dropped the typed description.
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const field = screen.getByLabelText("Description");
    fireEvent.change(field, { target: { value: "Kept when the window loses focus" } });
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      fireEvent.blur(field, { relatedTarget: null });
    } finally {
      hasFocus.mockRestore();
    }
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith({ description: "Kept when the window loses focus" });
    expect(screen.getByLabelText("Description")).toHaveValue("Kept when the window loses focus");

    // Returning and blurring again with no new typing writes nothing more.
    fireEvent.blur(screen.getByLabelText("Description"));
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
  });

  it("commits the description on Ctrl+Enter without leaving the field", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const field = screen.getByLabelText("Description");
    fireEvent.change(field, { target: { value: "Line one\nLine two" } });
    // Plain Enter can never mean "save" here — the description is the one
    // place a newline is content.
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onUpdate).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(props.onUpdate).toHaveBeenCalledWith({ description: "Line one\nLine two" });
  });

  it("keeps a server-refused description draft open for retry", async () => {
    const refusal = Object.assign(new Error("stale"), { code: "40001" });
    renderModal({ onUpdate: vi.fn(() => Promise.reject(refusal)) });
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const field = screen.getByLabelText("Description");
    fireEvent.change(field, { target: { value: "My unsaved retry draft" } });
    fireEvent.blur(field);
    await waitFor(() => expect(screen.getByLabelText("Description")).toHaveValue("My unsaved retry draft"));
  });

  it("keeps a server-refused title draft and refuses to close", async () => {
    const refusal = Object.assign(new Error("stale"), { code: "40001" });
    const props = renderModal({ onUpdate: vi.fn(() => Promise.reject(refusal)) });
    const field = screen.getByLabelText("Task title");
    fireEvent.change(field, { target: { value: "Retry this title" } });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(field).toHaveValue("Retry this title"));
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("renders board-inherited comments and submits explicit mentions", async () => {
    const props = renderModal({
      taskId: "task-demo-1",
    });

    fireEvent.click(screen.getByRole("button", { name: "Comments" }));

    expect(screen.getByText("Room confirmation is complete. Agenda review is next.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "@Priya Shah" }));

    fireEvent.change(screen.getByPlaceholderText("Add a task-specific update…"), {
      target: { value: "Thanks — flag anything you need." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add comment/ }));
    await waitFor(() => expect(props.onAddComment).toHaveBeenCalledWith("task-demo-1", "Thanks — flag anything you need.", [PRIYA]));
  });

  it("keeps task comments available after reassignment", () => {
    renderModal({
      taskId: "task-demo-1",
      task: { assigneeId: PRIYA, assigneeName: "Priya Shah" },
      memberId: MARIA,
    });
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(screen.getByText("Room confirmation is complete. Agenda review is next.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Add a task-specific update…")).toBeInTheDocument();
  });

  it("orders equal-timestamp comments by ascending id", () => {
    const createdAt = "2026-08-17T12:00:00Z";
    renderModal({
      comments: [
        { id: "comment-z", taskId: "task-demo-1", authorId: MARIA, body: "Zulu update", createdAt },
        { id: "comment-a", taskId: "task-demo-1", authorId: PRIYA, body: "Alpha update", createdAt },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    const bodies = within(screen.getByLabelText("Comments"))
      .getAllByRole("article").map((article) => article.querySelector("p").textContent);
    expect(bodies).toEqual(["Alpha update", "Zulu update"]);
  });

  it("keeps unavailable and truncated comment truth independent", () => {
    renderModal({ comments: [], commentsUnavailable: true, commentsTruncated: true });
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Task updates are unavailable");
    expect(screen.getByText(/newest 2,000 task updates/i)).toBeInTheDocument();
    expect(screen.queryByText("No task updates yet.")).not.toBeInTheDocument();
  });

  it("does not make an absolute empty claim for a truncated thread", () => {
    renderModal({ comments: [], commentsTruncated: true });
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(screen.getByText(/No update for this task is in the newest 2,000/i)).toBeInTheDocument();
    expect(screen.queryByText("No task updates yet.")).not.toBeInTheDocument();
  });

  it("retains the complete empty copy only for an available untruncated thread", () => {
    renderModal({ comments: [] });
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(screen.getByText("No task updates yet.")).toBeInTheDocument();
  });

  it("renders and sends the participant-only task thread separately from chapter comments", async () => {
    const selected = vi.fn();
    const props = renderModal({ taskId: "task-demo-2", renderConnectedMessageActions: (message) => <button onClick={() => selected(message)}>Actions for {message.id}</button> });
    fireEvent.click(screen.getByRole("button", { name: "Private task messages" }));
    expect(screen.getByText("Spanish draft is ready for your review.")).toBeInTheDocument();
    const messageRow = screen.getByText("Spanish draft is ready for your review.").closest("article");
    fireEvent.click(within(messageRow).getByRole("button", { name: /^Actions for / }));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-demo-2", body: "Spanish draft is ready for your review." }));
    fireEvent.change(screen.getByPlaceholderText("Write a message about this task…"), { target: { value: "I will review it now." } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(props.onSendMessage).toHaveBeenCalledWith("task-demo-2", "I will review it now."));
  });

  it("keeps prior private history visible after reassignment but removes the composer", () => {
    renderModal({ taskId: "task-demo-2", memberId: MARIA, task: { assigneeId: PRIYA, assigneeIds: [PRIYA] } });
    fireEvent.click(screen.getByRole("button", { name: "Private task messages" }));
    expect(screen.getByText("Spanish draft is ready for your review.")).toBeInTheDocument();
    expect(screen.getByText("This task was reassigned. Previous messages remain available.")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Write a message about this task…")).not.toBeInTheDocument();
  });

  it("lets an unassigned task receive a comment without first creating an assignee boundary", () => {
    renderModal({ taskId: "task-demo-2", task: { assigneeId: null, assigneeName: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(screen.getByPlaceholderText("Add a task-specific update…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Assign someone to open a conversation" })).not.toBeInTheDocument();
  });

  it("shows authorized record labels only and routes add/remove through link handlers", async () => {
    const props = renderModal({ taskId: "task-demo-1" });
    fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
    expect(screen.getByRole("link", { name: "Authorized meeting record" })).toHaveAttribute("href", "/m/events");
    expect(screen.queryByText("Confirm room, agenda, Zoom host, and member notices.", { selector: ".kan-records *" })).toBeNull();
    fireEvent.click(screen.getByText("Add authorized link"));
    fireEvent.change(screen.getByRole("textbox", { name: "Link label" }), { target: { value: "Board record" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Portal path" }), { target: { value: "/m/hub" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(props.onAddAttachment).toHaveBeenCalledWith("task-demo-1", "Board record", "/m/hub"));
    fireEvent.click(screen.getByRole("button", { name: "Remove Authorized meeting record" }));
    expect(props.onRemoveAttachment).toHaveBeenCalledWith("task-attachment-demo-1");
  });

  it("attaches an existing chapter document without copying its contents", async () => {
    const props = renderModal({ documents: [{ id: "document-1", title: "Chapter policy" }] });
    fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Campaign document" }), { target: { value: "document-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(props.onAddAttachment).toHaveBeenCalledWith(
      "task-demo-3",
      "Chapter policy",
      "/m/organize?document=document-1",
    ));
  });

  it("preserves demo mode in attached document links", async () => {
    window.history.replaceState({}, "", "/m/tasks?demo=1");
    try {
      const props = renderModal({ documents: [{ id: "document-1", title: "Chapter policy" }] });
      fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Campaign document" }), { target: { value: "document-1" } });
      fireEvent.click(screen.getByRole("button", { name: "Attach" }));
      await waitFor(() => expect(props.onAddAttachment).toHaveBeenCalledWith(
        "task-demo-3",
        "Chapter policy",
        "/m/organize?document=document-1&demo=1",
      ));
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("renders immutable activity entries in the history popover", () => {
    renderModal({ taskId: "task-demo-1" });
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByText("Assignee changed")).toBeInTheDocument();
    expect(screen.getByText("Authorized record linked")).toBeInTheDocument();
  });

  it.each([
    ["en", "File attached", "File removed", "History"],
    ["es", "Archivo adjuntado", "Archivo eliminado", "Historial"],
  ])("translates device-file history in %s", (lang, attached, removed, historyLabel) => {
    const activity = [
      { id: "activity-file-add", taskId: "task-demo-3", actorId: MARIA, action: "file_added", createdAt: "2026-08-10T12:00:00Z" },
      { id: "activity-file-remove", taskId: "task-demo-3", actorId: MARIA, action: "file_removed", createdAt: "2026-08-10T12:01:00Z" },
    ];
    renderModal({ activity }, lang);
    fireEvent.click(screen.getByRole("button", { name: historyLabel }));

    expect(screen.getByText(attached)).toBeInTheDocument();
    expect(screen.getByText(removed)).toBeInTheDocument();
    expect(screen.queryByText("kanban.activity.file_added")).not.toBeInTheDocument();
    expect(screen.queryByText("kanban.activity.file_removed")).not.toBeInTheDocument();
  });

  it("carries copy for every activity action the database constraint allows", () => {
    const actions = allowedActivityActions();
    expect(actions).toContain("template_flow_changed");
    for (const action of actions) {
      const key = `kanban.activity.${action}`;
      expect(catalogue.en[key], `English copy missing for ${key}`).toBeTruthy();
      expect(catalogue.es[key], `Spanish copy missing for ${key}`).toBeTruthy();
    }
  });

  it.each([
    ["en", "Template flow changed", "History"],
    ["es", "Flujo de plantilla cambiado", "Historial"],
  ])("translates a template flow-step change in %s", (lang, changed, historyLabel) => {
    const activity = [
      { id: "activity-flow", taskId: "task-demo-3", actorId: MARIA, action: "template_flow_changed", createdAt: "2026-08-13T12:00:00Z" },
    ];
    renderModal({ activity }, lang);
    fireEvent.click(screen.getByRole("button", { name: historyLabel }));

    expect(screen.getByText(changed)).toBeInTheDocument();
    expect(screen.queryByText("kanban.activity.template_flow_changed")).not.toBeInTheDocument();
  });

  it("opens straight into the assignee picker when the parent asks for it", () => {
    renderModal({ onAssignFocus: true });
    expect(screen.getByRole("listbox", { name: "Assignee" })).toBeInTheDocument();
  });

  it("wraps Tab at both ends of the dialog", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    const focusable = [...dialog.querySelectorAll(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(focusable.length).toBeGreaterThan(2);

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    // Without the wrap, focus lands on the dimmed board behind the dialog and
    // the member is editing a card they can no longer see.
    expect(last).toHaveFocus();
  });

  it("gives the dialog its task key as the accessible name and focuses a control on mount", () => {
    renderModal();
    expect(screen.getByRole("dialog", { name: "WOR-3" })).toBeInTheDocument();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("closes an open picker on the first Escape and the modal on the second", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "In progress" }));
    expect(screen.getByRole("listbox", { name: "Task status" })).toBeInTheDocument();

    // preventDefault on BOTH branches: TasksView's window keyboard map skips
    // defaultPrevented events, so one press can never also exit focus mode.
    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(false);
    expect(screen.queryByRole("listbox", { name: "Task status" })).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();

    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(false);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a backdrop mousedown but not on a mousedown inside the dialog", () => {
    const props = renderModal();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector(".kan-modal-backdrop"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("flushes a typed title through Escape instead of discarding it", () => {
    const props = renderModal();
    const field = screen.getByLabelText("Task title");
    field.focus();
    fireEvent.change(field, { target: { value: "Renamed then Escaped" } });
    // No blur ever fires here: Escape unmounts the modal, and an unmounting
    // field emits no blur, so the close path itself must run the commit.
    fireEvent.keyDown(window, { key: "Escape" });

    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith({ title: "Renamed then Escaped" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("flushes a dirty title AND description as ONE patch, not two racing writes", () => {
    // Title and description share one server-side CAS token; two same-tick
    // commits made the second always lose (40001) and the description looked
    // unsavable. When both drafts are dirty at close (no blur committed
    // either), the flush must combine them into a single write.
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Described together" } });
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Renamed together" } });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith({ title: "Renamed together", description: "Described together" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("commits the draft when the description section collapses mid-edit", () => {
    // Collapsing unmounts the focused textarea without a blur — the toggle
    // itself must commit or the typed text silently vanishes.
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Typed, then collapsed" } });
    fireEvent.click(screen.getByRole("button", { name: /Description/ }));

    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith({ description: "Typed, then collapsed" });
  });

  it("offers a visible Add description action on a card without one", () => {
    const props = renderModal({ task: { description: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add description" }));
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("shows honest byte and megabyte sizes and omits unavailable file sizes", () => {
    renderModal({
      files: [
        { id: "small", taskId: "task-demo-3", filename: "small.txt", sizeBytes: 512 },
        { id: "large", taskId: "task-demo-3", filename: "large.pdf", sizeBytes: 1572864 },
        { id: "unknown", taskId: "task-demo-3", filename: "unknown.txt", sizeBytes: 0 },
      ],
      onOpenFile: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: /Attachments/ }));
    expect(screen.getByRole("button", { name: /small.txt/ })).toHaveTextContent("512 B");
    expect(screen.getByRole("button", { name: /large.pdf/ })).toHaveTextContent("1.5 MB");
    expect(screen.getByRole("button", { name: "unknown.txt" })).not.toHaveTextContent("0 B");
  });

  it("lists device files, opens on tap, and wires attach and remove", async () => {
    const fileRow = { id: "file-1", taskId: "task-demo-3", filename: "grievance-notes.pdf", mimeType: "application/pdf", sizeBytes: 24576, bucketId: "chapter-task-files", objectName: "wor/task-demo-3/file-1/grievance-notes.pdf" };
    const popup = { location: "", opener: window, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);
    const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:task-file");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const props = renderModal({
      files: [fileRow],
      onAddFile: vi.fn(async () => fileRow),
      onRemoveFile: vi.fn(async () => ({ deleted: true })),
      onOpenFile: vi.fn(async () => new Blob(["pdf"])),
    });
    fireEvent.click(screen.getByRole("button", { name: /Attachments/ }));

    const open = screen.getByRole("button", { name: /^grievance-notes\.pdf/ });
    expect(open.textContent).toContain("24 KB");
    fireEvent.click(open);
    // The tab is opened on the tap, before the bytes are awaited: iOS spends
    // the transient user activation on the first await.
    expect(openSpy).toHaveBeenCalledWith("", "_blank");
    expect(props.onOpenFile).toHaveBeenCalledWith(fileRow);
    await waitFor(() => expect(popup.location).toBe("blob:task-file"));
    expect(popup.opener).toBeNull();
    expect(objectUrl).toHaveBeenCalledWith(expect.any(Blob));

    fireEvent.click(screen.getByRole("button", { name: "Remove grievance-notes.pdf" }));
    await waitFor(() => expect(props.onRemoveFile).toHaveBeenCalledWith(expect.objectContaining({ id: "file-1" })));

    // The picker is a real file input: attach flows through its change event.
    const input = screen.getByLabelText("Attach a file");
    const file = new File(["x"], "photo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await confirmEvidenceUpload();
    await waitFor(() => expect(props.onAddFile).toHaveBeenCalledWith(file, { onPhase: expect.any(Function) }));
    openSpy.mockRestore();
    objectUrl.mockRestore();
    URL.revokeObjectURL.mockRestore?.();
  });

  it("shows a checking state, states a rejection permanently, and offers one re-check for a stale verdict", async () => {
    const fileRow = { id: "file-1", taskId: "task-demo-3", filename: "grievance-notes.pdf", mimeType: "application/pdf", sizeBytes: 24576 };
    const popup = { location: "", opener: window, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:task-file");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const stale = Object.assign(new Error("stale"), { privateFileCode: "stale" });
    const rejected = Object.assign(new Error("refused"), { privateFileCode: "rejected" });
    let release;
    const props = renderModal({
      files: [fileRow],
      onAddFile: vi.fn((_file, { onPhase }) => new Promise((_resolve, reject) => {
        onPhase("checking");
        release = () => reject(rejected);
      })),
      onRemoveFile: vi.fn(),
      onOpenFile: vi.fn().mockRejectedValueOnce(stale).mockResolvedValueOnce(new Blob(["pdf"])),
      onRecheckFile: vi.fn().mockResolvedValue({ status: "clean" }),
    });
    fireEvent.click(screen.getByRole("button", { name: /Attachments/ }));

    // Checking: bytes are up, the verdict is not in, nothing is attached yet.
    fireEvent.change(screen.getByLabelText("Attach a file"), {
      target: { files: [new File(["x"], "photo.png", { type: "image/png" })] },
    });
    await confirmEvidenceUpload();
    expect(await screen.findByText("Checking this file for safety…")).toHaveAttribute("role", "status");
    release();
    expect(await screen.findByRole("alert"))
      .toHaveTextContent("This file was rejected by the safety check and was not attached.");

    // Stale: the read is refused, and exactly one re-check is offered.
    fireEvent.click(screen.getByRole("button", { name: /^grievance-notes\.pdf/ }));
    await waitFor(() => expect(popup.close).toHaveBeenCalled());
    expect(await screen.findByText("This file needs a fresh safety check before it can open.")).toHaveAttribute("role", "alert");
    fireEvent.click(screen.getByRole("button", { name: /^Re\-check\ this\ file(?:: |$)/ }));
    await waitFor(() => expect(props.onRecheckFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Re\-check\ this\ file(?:: |$)/ })).toBeNull());
    openSpy.mockRestore();
    URL.createObjectURL.mockRestore?.();
    URL.revokeObjectURL.mockRestore?.();
  });

  // The four refusal classes below are not decoration. `rejected` is a
  // permanent decision about these bytes and is the one class that must never
  // read as retryable; `rate-limited` is a decision about the actor and says
  // so with the actual ceiling; `pending-check` means the verdict never
  // arrived, so nothing was attached; `unsupported-format` is the HEIC refusal
  // (E2) and has to tell a member what to do instead. A single generic
  // "couldn't update" for all four is the regression this pins shut.
  it("names each safety-check refusal class and keeps unknown errors private", async () => {
    const refusal = (code, message) => Object.assign(new Error(message), { privateFileCode: code });
    const props = renderModal({
      files: [],
      onAddFile: vi.fn()
        .mockRejectedValueOnce(refusal("rate-limited", "429"))
        .mockRejectedValueOnce(refusal("pending-check", "503"))
        .mockRejectedValueOnce(refusal("unsupported-format", "heic"))
        .mockRejectedValueOnce(new Error("The network dropped")),
    });
    fireEvent.click(screen.getByRole("button", { name: /Attachments/ }));
    const attach = async () => {
      fireEvent.change(screen.getByLabelText("Attach a file"), {
        target: { files: [new File(["x"], "photo.png", { type: "image/png" })] },
      });
      await confirmEvidenceUpload();
    };
    const expectAlert = async (text) => {
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text));
    };

    await attach();
    await expectAlert("You have reached the hourly limit of 20 file checks. Try again later.");
    await attach();
    await expectAlert("The safety check did not finish, so this file was not attached. Try again.");
    await attach();
    await expectAlert("This browser cannot convert that photo. Save it as JPEG or PNG, then attach it.");
    await attach();
    // Unknown failures use safe copy without exposing transport or driver text.
    await expectAlert("This file could not be attached right now.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("The network dropped");
    expect(props.onAddFile).toHaveBeenCalledTimes(4);
    // None of the four is a rejection, so the checking banner is cleared and
    // the permanent "rejected" state is never entered.
    expect(screen.queryByText("Checking this file for safety…")).toBeNull();
  });

  it("shows catalogue copy for a driver-level attach refusal and never the raw error text", async () => {
    const props = renderModal({
      files: [],
      onAddFile: vi.fn().mockRejectedValue(new MemberApiError("Attach file", {
        message: "permission denied for table chapter_task_files",
        code: "42501",
      })),
    });
    fireEvent.click(screen.getByRole("button", { name: /Attachments/ }));
    fireEvent.change(screen.getByLabelText("Attach a file"), {
      target: { files: [new File(["x"], "photo.png", { type: "image/png" })] },
    });
    await confirmEvidenceUpload();
    const alert = await screen.findByRole("alert");
    // BUG-UG-WEB-FILE-FAILURES-PAINT-DRIVER-TEXT-20260920: a MemberApiError
    // message is the API label plus the raw driver sentence, so the alert must
    // carry the translated catalogue sentence instead — never the driver text
    // (which names an internal table) nor the "Attach file:" label prefix.
    expect(alert).toHaveTextContent("This file could not be attached right now.");
    expect(alert.textContent).not.toContain("permission denied");
    expect(alert.textContent).not.toContain("Attach file:");
    await waitFor(() => expect(props.onAddFile).toHaveBeenCalledTimes(1));
  });

  it("says so when the browser blocks the tab instead of silently doing nothing", async () => {
    const fileRow = { id: "file-1", taskId: "task-demo-3", filename: "grievance-notes.pdf", mimeType: "application/pdf", sizeBytes: 24576 };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const props = renderModal({ files: [fileRow], onOpenFile: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /Attachments/ }));
    fireEvent.click(screen.getByRole("button", { name: /^grievance-notes\.pdf/ }));
    expect(await screen.findByRole("alert"))
      .toHaveTextContent("Allow pop-ups for this site to open the document.");
    // The bytes are never requested: a read that cannot be shown would only
    // spend inspection quota.
    expect(props.onOpenFile).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("closes the placeholder tab when an authenticated read yields nothing", async () => {
    const fileRow = { id: "file-1", taskId: "task-demo-3", filename: "grievance-notes.pdf", mimeType: "application/pdf", sizeBytes: 24576 };
    const popup = { location: "", opener: window, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);
    const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:task-file");
    renderModal({ files: [fileRow], onOpenFile: vi.fn(async () => null) });
    fireEvent.click(screen.getByRole("button", { name: /Attachments/ }));
    fireEvent.click(screen.getByRole("button", { name: /^grievance-notes\.pdf/ }));
    await waitFor(() => expect(popup.close).toHaveBeenCalledTimes(1));
    // An empty tab left open pointing nowhere is worse than no tab, and there
    // is nothing to mint an object URL from.
    expect(objectUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    openSpy.mockRestore();
    objectUrl.mockRestore();
  });

  it("routes a non-stale open failure to the refusal copy, not to a re-check", async () => {
    const fileRow = { id: "file-1", taskId: "task-demo-3", filename: "grievance-notes.pdf", mimeType: "application/pdf", sizeBytes: 24576 };
    const popup = { location: "", opener: window, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);
    const props = renderModal({
      files: [fileRow],
      onOpenFile: vi.fn().mockRejectedValue(Object.assign(new Error("429"), { privateFileCode: "rate-limited" })),
      onRecheckFile: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: /Attachments/ }));
    fireEvent.click(screen.getByRole("button", { name: /^grievance-notes\.pdf/ }));
    expect(await screen.findByRole("alert"))
      .toHaveTextContent("You have reached the hourly limit of 20 file checks. Try again later.");
    expect(popup.close).toHaveBeenCalledTimes(1);
    // Only a stale verdict earns the re-check button: offering it here would
    // spend another inspection against a ceiling the member has already hit.
    expect(screen.queryByRole("button", { name: /^Re\-check\ this\ file(?:: |$)/ })).toBeNull();
    expect(props.onRecheckFile).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("keeps the re-check affordance through a transient failure and retires it on a rejection", async () => {
    const fileRow = { id: "file-1", taskId: "task-demo-3", filename: "grievance-notes.pdf", mimeType: "application/pdf", sizeBytes: 24576 };
    const popup = { location: "", opener: window, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);
    const stale = Object.assign(new Error("stale"), { privateFileCode: "stale" });
    const props = renderModal({
      files: [fileRow],
      onOpenFile: vi.fn().mockRejectedValue(stale),
      onRecheckFile: vi.fn()
        .mockRejectedValueOnce(new Error("scanner unreachable"))
        .mockRejectedValueOnce(Object.assign(new Error("blocked"), { privateFileCode: "rejected" })),
    });
    fireEvent.click(screen.getByRole("button", { name: /Attachments/ }));
    fireEvent.click(screen.getByRole("button", { name: /^grievance-notes\.pdf/ }));
    const recheck = await screen.findByRole("button", { name: /^Re\-check\ this\ file(?:: |$)/ });

    // A re-check that could not decide leaves the file exactly where it was —
    // still openable in principle, so the button has to still be there.
    fireEvent.click(recheck);
    await waitFor(() => expect(props.onRecheckFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("alert"))
      .toHaveTextContent("The safety check did not finish. Try again in a moment."));
    expect(screen.getByRole("button", { name: /^Re\-check\ this\ file(?:: |$)/ })).toBeInTheDocument();

    // A rejection is a decision about these bytes: the affordance goes away
    // rather than inviting a member to re-check the same file forever.
    fireEvent.click(screen.getByRole("button", { name: /^Re\-check\ this\ file(?:: |$)/ }));
    await waitFor(() => expect(props.onRecheckFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("alert"))
      .toHaveTextContent("This file was rejected by the safety check and was not attached."));
    expect(screen.queryByRole("button", { name: /^Re\-check\ this\ file(?:: |$)/ })).toBeNull();
    openSpy.mockRestore();
  });

  it("reports a failed removal inline instead of dropping the row from the list", async () => {
    const fileRow = { id: "file-1", taskId: "task-demo-3", filename: "grievance-notes.pdf", mimeType: "application/pdf", sizeBytes: 24576 };
    const props = renderModal({
      files: [fileRow],
      onOpenFile: vi.fn(),
      onRemoveFile: vi.fn().mockRejectedValue(new Error("The tombstone was refused")),
    });
    fireEvent.click(screen.getByRole("button", { name: /Attachments/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove grievance-notes.pdf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The tombstone was refused");
    await waitFor(() => expect(props.onRemoveFile).toHaveBeenCalledTimes(1));
    // G5: removal is a tombstone the service reconciler acts on, so a failure
    // must leave the file visible rather than pretend it is gone.
    expect(screen.getByRole("button", { name: /^grievance-notes\.pdf/ })).toBeInTheDocument();
  });

  it("refuses an oversized file locally with named copy", async () => {
    const props = renderModal({ onAddFile: vi.fn(), onRemoveFile: vi.fn(), onOpenFile: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /Attachments/ }));
    const input = screen.getByLabelText("Attach a file");
    const big = new File(["x"], "huge.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText(/This file is larger than 10 MiB/)).toBeInTheDocument();
    expect(props.onAddFile).not.toHaveBeenCalled();
  });

  it("flushes an edited description through a backdrop close", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Typed, never blurred" } });
    fireEvent.mouseDown(document.querySelector(".kan-modal-backdrop"));

    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith({ description: "Typed, never blurred" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("flushes drafts once even when the close button's own blur already committed", () => {
    const props = renderModal();
    const field = screen.getByLabelText("Task title");
    field.focus();
    fireEvent.change(field, { target: { value: "Saved by blur, closed by button" } });
    // In a real browser the mousedown on the close button blurs the field
    // BEFORE the click lands, so the blur commit and the close-path flush see
    // the same dirty draft; the sent-guard makes the second pass a no-op
    // instead of a duplicate write.
    fireEvent.blur(field);
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));

    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith({ title: "Saved by blur, closed by button" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the whole modal in Spanish", () => {
    renderModal({}, "es");
    expect(screen.getByRole("button", { name: "En progreso" })).toBeInTheDocument();
    expect(screen.getByLabelText("Título de la tarea")).toHaveValue("Coworker outreach calls");
    expect(screen.getByText("Descripción")).toBeInTheDocument();
    expect(screen.getByText("Comentarios")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "En progreso" }));
    expect(within(screen.getByRole("listbox", { name: "Estado de la tarea" })).getAllByRole("option")[4])
      .toHaveTextContent("Terminada");
  });
});

describe("task modal writes keep focus while they run (#8435)", () => {
  it("keeps Add comment focused while the comment is saved, and saves it once", async () => {
    const props = renderModal({ taskId: "task-demo-1" });
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    fireEvent.change(screen.getByPlaceholderText("Add a task-specific update…"), { target: { value: "Room is booked." } });
    await expectHeldWriteFocus(props.onAddComment, screen.getByRole("button", { name: /Add comment/ }));
    await waitFor(() => expect(props.onAddComment).toHaveBeenCalledTimes(1));
  });

  it("keeps Send message focused while the private message is sent, and sends it once", async () => {
    const props = renderModal({ taskId: "task-demo-2" });
    fireEvent.click(screen.getByRole("button", { name: "Private task messages" }));
    fireEvent.change(screen.getByPlaceholderText("Write a message about this task…"), { target: { value: "On it." } });
    await expectHeldWriteFocus(props.onSendMessage, screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(props.onSendMessage).toHaveBeenCalledWith("task-demo-2", "On it."));
    expect(props.onSendMessage).toHaveBeenCalledTimes(1);
  });
});
