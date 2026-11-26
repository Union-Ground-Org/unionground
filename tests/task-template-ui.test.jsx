import { useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEMO_TASK_TEMPLATES } from "../src/lib/taskTemplates.js";
import { TaskTemplateDialog, TaskTemplatePanel } from "../src/views/TaskTemplateDialog.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const copy = {
  "taskTemplates.dialogTitle": "Use a task template",
  "taskTemplates.dialogIntro": "Choose a guided task type.",
  "taskTemplates.unavailable": "Task templates are not available right now.",
  "taskTemplates.title": "Task title",
  "taskTemplates.workstream": "Workstream",
  "taskTemplates.safety": "Keep protected details in an authorized linked record.",
  "taskTemplates.checklist": "Starting checklist",
  "taskTemplates.fieldCount": "{count} fields",
  "taskTemplates.startsAt": "Starts at {step}",
  "taskTemplates.create": "Create task",
  "taskTemplates.creating": "Creating…",
  "taskTemplates.cancel": "Cancel",
  "taskTemplates.close": "Close template chooser",
  "taskTemplates.required": "Complete the required fields.",
  "taskTemplates.error": "The task could not be created. Your entries are still here.",
  "taskTemplates.detailsTitle": "Template details",
  "taskTemplates.detailsUnavailable": "Template details are not available right now.",
  "taskTemplates.flowTitle": "Template flow",
  "taskTemplates.currentStep": "Current step: {step}",
  "taskTemplates.nextStep": "Move to {step}",
  "taskTemplates.flowConfirm": "Also move the task from {from} to {to}?",
  "taskTemplates.flowOnly": "Move flow only",
  "taskTemplates.flowAndStatus": "Move flow and status",
  "taskTemplates.flowCancel": "Keep current step",
  "taskTemplates.updating": "Updating…",
  "taskTemplates.noNext": "This flow is complete.",
  "taskTemplates.typeLocked": "Template type is fixed after creation.",
  "taskTemplates.edit": "Edit template fields",
  "taskTemplates.save": "Save template fields",
  "taskTemplates.saving": "Saving…",
  "taskTemplates.editCancel": "Cancel field edits",
  "taskTemplates.fieldsUpdated": "Template fields updated",
  "taskTemplates.updateError": "The template fields could not be updated.",
  "tasks.status.to_do": "To do",
  "tasks.status.needs_review": "Review",
  "tasks.priorityMedium": "Normal",
  "tasks.priorityHigh": "High",
  "taskTemplates.option.phone": "Phone",
  "taskTemplates.option.email": "Email",
  "taskTemplates.option.in_person": "In person",
  "taskTemplates.option.message": "Message",
  "taskTemplates.option.other": "Other",
};

function t(key, values = {}) {
  return Object.entries(values).reduce((value, [name, replacement]) => (
    value.replace(`{${name}}`, replacement)
  ), copy[key] || key);
}

describe("specialized task template UI", () => {
  it("previews every template's server-owned defaults, field count, checklist, and starting step", () => {
    render(
      <TaskTemplateDialog
        templates={DEMO_TASK_TEMPLATES}
        workstreams={["Representation"]}
        lang="en"
        t={t}
        onClose={() => {}}
        onCreate={() => {}}
      />,
    );

    const incident = screen.getByRole("button", { name: /Issue or Incident/i });
    expect(incident).toHaveTextContent("To do");
    expect(incident).toHaveTextContent("High");
    expect(incident).toHaveTextContent("2 fields");
    fireEvent.click(incident);
    expect(screen.getByText("Starts at Triage")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Starting checklist" })).toBeInTheDocument();
  });

  it("shows a truthful empty catalog and restores focus after Escape without writing", () => {
    const create = vi.fn();
    function Host() {
      const triggerRef = useRef(null);
      const [open, setOpen] = useState(false);
      return <>
        <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>Use a template</button>
        {open && <TaskTemplateDialog
          templates={[]}
          workstreams={[]}
          lang="en"
          t={t}
          onClose={() => setOpen(false)}
          onCreate={create}
          returnFocusRef={triggerRef}
        />}
      </>;
    }
    render(<Host />);
    const trigger = screen.getByRole("button", { name: "Use a template" });
    fireEvent.click(trigger);
    expect(screen.getByRole("status")).toHaveTextContent("not available");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(create).not.toHaveBeenCalled();
  });

  it("offers all five templates and submits only constrained snake-case fields", async () => {
    const create = vi.fn().mockResolvedValue({ task: { id: "task-new" } });
    render(
      <TaskTemplateDialog
        templates={DEMO_TASK_TEMPLATES}
        workstreams={["Representation", "Organizing"]}
        assignees={[]}
        lang="en"
        t={t}
        onClose={() => {}}
        onCreate={create}
      />,
    );

    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: /Worker follow-up/i }));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Schedule a check-in" } });
    fireEvent.change(screen.getByLabelText("Workstream"), { target: { value: "Representation" } });
    fireEvent.change(screen.getByLabelText("Contact method"), { target: { value: "phone" } });
    fireEvent.change(screen.getByLabelText("Follow-up date"), { target: { value: "2026-08-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      templateKey: "member_follow_up",
      title: "Schedule a check-in",
      workstream: "Representation",
      fields: { contact_method: "phone", follow_up_on: "2026-08-20" },
    }));
  });

  // The template's task title is a chapter task
  // title, so it follows chapter_tasks_title_bounded (trimmed code points) like
  // the other five task-title boxes, and an edit never cuts existing text off.
  it("limits the task title as the database counts it, keeping existing text", () => {
    render(
      <TaskTemplateDialog
        templates={DEMO_TASK_TEMPLATES}
        workstreams={["Representation", "Organizing"]}
        assignees={[]}
        lang="en"
        t={t}
        onClose={() => {}}
        onCreate={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Worker Follow-up/i }));
    const title = screen.getByLabelText("Task title");
    expect(title).not.toHaveAttribute("maxlength");
    const padded = `  ${"\u{1F525}".repeat(160)}  `;
    fireEvent.change(title, { target: { value: padded } });
    expect(title).toHaveValue(padded);
    const full = `${"a".repeat(159)}X`;
    fireEvent.change(title, { target: { value: full } });
    fireEvent.change(title, { target: { value: `Q${full}` } });
    expect(title).toHaveValue(full);
  });

  it.each([
    ["en", /Review or Approval/i, "Reviewer"],
    ["es", /Revisión o aprobación/i, "Persona revisora"],
  ])("offers reviewer fields only the server-authorized reviewer projection in %s", (lang, templateName, reviewerLabel) => {
    render(
      <TaskTemplateDialog
        templates={DEMO_TASK_TEMPLATES}
        workstreams={["Representation"]}
        assignees={[
          { id: "staff-steward", fullName: "Sam Steward" },
          { id: "staff-vp", fullName: "Vivian VP" },
        ]}
        lang={lang}
        t={t}
        onClose={() => {}}
        onCreate={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: templateName }));
    const reviewer = screen.getByLabelText(reviewerLabel);
    expect(reviewer).toHaveTextContent("Sam Steward");
    expect(reviewer).toHaveTextContent("Vivian VP");
    expect(reviewer).not.toHaveTextContent("Ordinary Member");
  });

  it("retains entered values when creation fails", async () => {
    const create = vi.fn().mockRejectedValue(new Error("offline"));
    render(
      <TaskTemplateDialog
        templates={DEMO_TASK_TEMPLATES}
        workstreams={["Representation"]}
        assignees={[]}
        lang="en"
        t={t}
        onClose={() => {}}
        onCreate={create}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Issue or Incident/i }));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Coordinate the response" } });
    fireEvent.change(screen.getByLabelText("Occurrence date"), { target: { value: "2026-08-12" } });
    fireEvent.change(screen.getByLabelText("Operational severity"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("entries are still here");
    expect(screen.getByLabelText("Task title")).toHaveValue("Coordinate the response");
  });

  // A pending control stays focusable and refuses a second write.
  it("keeps Create task focused while creation runs, and creates once", async () => {
    const create = vi.fn().mockResolvedValue({});
    render(<TaskTemplateDialog templates={DEMO_TASK_TEMPLATES} workstreams={["Representation"]} lang="en" t={t} onClose={() => {}} onCreate={create} />);
    fireEvent.click(screen.getByRole("button", { name: /Worker Follow-up/i }));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Schedule a check-in" } });
    fireEvent.change(screen.getByLabelText("Contact method"), { target: { value: "phone" } });
    fireEvent.change(screen.getByLabelText("Follow-up date"), { target: { value: "2026-08-20" } });
    await expectHeldWriteFocus(create, screen.getByRole("button", { name: "Create task" }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("creates on a corrected submit made right after a refused one", () => {
    const create = vi.fn().mockResolvedValue({});
    render(<TaskTemplateDialog templates={DEMO_TASK_TEMPLATES} workstreams={["Representation"]} lang="en" t={t} onClose={() => {}} onCreate={create} />);
    fireEvent.click(screen.getByRole("button", { name: /Worker Follow-up/i }));
    const title = screen.getByLabelText("Task title");
    fireEvent.change(screen.getByLabelText("Contact method"), { target: { value: "phone" } });
    fireEvent.change(screen.getByLabelText("Follow-up date"), { target: { value: "2026-08-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: "Schedule a check-in" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("locks every chooser control while creation is pending", async () => {
    let resolveCreate;
    const create = vi.fn(() => new Promise((resolve) => { resolveCreate = resolve; }));
    render(
      <TaskTemplateDialog
        templates={DEMO_TASK_TEMPLATES}
        workstreams={["Representation"]}
        lang="en"
        t={t}
        onClose={() => {}}
        onCreate={create}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Worker follow-up/i }));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Schedule a check-in" } });
    fireEvent.change(screen.getByLabelText("Contact method"), { target: { value: "phone" } });
    fireEvent.change(screen.getByLabelText("Follow-up date"), { target: { value: "2026-08-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // Pending, not natively disabled (record 8435): each stays focusable.
    expect(screen.getByLabelText("Task title")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Contact method")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: /Meeting/i })).toHaveAttribute("aria-disabled", "true");
    // ...and refuses input: an edit or a choice made while
    // the create runs changes nothing and sends nothing.
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Changed mid-create" } });
    fireEvent.change(screen.getByLabelText("Contact method"), { target: { value: "email" } });
    fireEvent.click(screen.getByRole("button", { name: /Meeting/i }));
    expect(screen.getByLabelText("Task title")).toHaveValue("Schedule a check-in");
    expect(screen.getByLabelText("Contact method")).toHaveValue("phone");
    expect(screen.getByRole("button", { name: /Meeting/i })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Creating…" }));
    expect(create).toHaveBeenCalledTimes(1);
    resolveCreate({});
  });

  it.each([
    ["Move flow only", false],
    ["Move flow and status", true],
  ])("returns successful %s focus to the persistent flow region after the initiating action unmounts", async (actionName, applyRecommendedStatus) => {
    const update = vi.fn().mockResolvedValue({});
    const template = DEMO_TASK_TEMPLATES.find((item) => item.key === "member_follow_up");
    function Host() {
      const [task, setTask] = useState({ id: "task-1", status: "to_do" });
      const [details, setDetails] = useState({ flowStep: "prepare", contactMethod: "phone", followUpOn: "2026-08-20" });
      return <TaskTemplatePanel
        task={task}
        template={template}
        details={details}
        assignees={[]}
        lang="en"
        t={t}
        onUpdate={async (request) => {
          await update(request);
          setDetails((current) => ({ ...current, flowStep: request.nextFlowStep }));
          if (request.applyRecommendedStatus) setTask((current) => ({ ...current, status: "in_progress" }));
        }}
      />;
    }
    render(<Host />);

    expect(screen.getByRole("list", { name: "Template flow" })).toHaveTextContent("PrepareContactAwait responseResolve");
    expect(screen.getByText("Prepare", { selector: '[aria-current="step"]' })).toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "Move to Contact" });
    fireEvent.click(trigger);
    const confirmation = screen.getByRole("group", { name: /Also move the task/ });
    fireEvent.click(within(confirmation).getByRole("button", { name: actionName }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      taskId: "task-1", fields: {}, nextFlowStep: "contact", applyRecommendedStatus,
    }));
    await waitFor(() => expect(screen.getByText("Current step: Contact")).toBeInTheDocument());
    expect(screen.getByText("Contact", { selector: '[aria-current="step"]' })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move to Await response" })).toBeInTheDocument();
    expect(trigger).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("region", { name: "Template flow" })).toHaveFocus());
  });

  it("keeps the next flow action disabled until the previous update settles", async () => {
    let finishUpdate;
    const pendingUpdate = new Promise((resolve) => { finishUpdate = resolve; });
    const update = vi.fn(() => pendingUpdate);
    const template = DEMO_TASK_TEMPLATES.find((item) => item.key === "member_follow_up");
    function Host() {
      const [details, setDetails] = useState({ flowStep: "prepare", contactMethod: "phone", followUpOn: "2026-08-20" });
      return <TaskTemplatePanel task={{ id: "task-1", status: "to_do" }} template={template} details={details}
        lang="en" t={t} onUpdate={async (request) => {
          setDetails((current) => ({ ...current, flowStep: request.nextFlowStep }));
          await update(request);
        }} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Move to Contact" }));
    fireEvent.click(screen.getByRole("button", { name: "Move flow only" }));
    expect(await screen.findByText("Current step: Contact")).toBeInTheDocument();
    const next = screen.getByRole("button", { name: "Move to Await response" });
    expect(next).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(next);
    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => { finishUpdate(); });
    await waitFor(() => expect(next).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(next);
    fireEvent.click(screen.getByRole("button", { name: "Move flow and status" }));
    expect(await screen.findByText("Current step: Await response")).toBeInTheDocument();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("keeps Save template fields focused while the fields are saved, and saves once", async () => {
    const update = vi.fn().mockResolvedValue({});
    const template = DEMO_TASK_TEMPLATES.find((item) => item.key === "member_follow_up");
    render(<TaskTemplatePanel task={{ id: "task-1", status: "to_do" }} template={template}
      details={{ flowStep: "prepare", contactMethod: "phone", followUpOn: "2026-08-20" }} lang="en" t={t} onUpdate={update} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit template fields" }));
    fireEvent.change(screen.getByLabelText("Contact method"), { target: { value: "email" } });
    await expectHeldWriteFocus(update, screen.getByRole("button", { name: "Save template fields" }));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("keeps Move flow only focused while the flow moves, and moves once", async () => {
    const update = vi.fn().mockResolvedValue({});
    const template = DEMO_TASK_TEMPLATES.find((item) => item.key === "member_follow_up");
    render(<TaskTemplatePanel task={{ id: "task-1", status: "to_do" }} template={template}
      details={{ flowStep: "prepare", contactMethod: "phone", followUpOn: "2026-08-20" }} lang="en" t={t} onUpdate={update} />);
    fireEvent.click(screen.getByRole("button", { name: "Move to Contact" }));
    await expectHeldWriteFocus(update, screen.getByRole("button", { name: "Move flow only" }));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("edits safe structured fields without changing flow or canonical status", async () => {
    const update = vi.fn().mockResolvedValue({});
    const template = DEMO_TASK_TEMPLATES.find((item) => item.key === "member_follow_up");
    render(
      <TaskTemplatePanel
        task={{ id: "task-1", status: "to_do" }}
        template={template}
        details={{ flowStep: "prepare", contactMethod: "phone", followUpOn: "2026-08-20" }}
        lang="en"
        t={t}
        onUpdate={update}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit template fields" }));
    fireEvent.change(screen.getByLabelText("Contact method"), { target: { value: "email" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template fields" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      taskId: "task-1",
      fields: { contact_method: "email", follow_up_on: "2026-08-20" },
      nextFlowStep: null,
      applyRecommendedStatus: false,
    }));
  });

  it("edits Meeting details read with stored time blocks", async () => {
    const update = vi.fn().mockResolvedValue({});
    const template = DEMO_TASK_TEMPLATES.find((item) => item.key === "meeting_event");
    render(
      <TaskTemplatePanel
        task={{ id: "task-1", status: "to_do" }}
        template={template}
        details={{
          flowStep: "planning",
          scheduledOn: "2026-08-20",
          startsAt: "09:00:00",
          endsAt: "10:30:00",
          venueMode: "hybrid",
        }}
        lang="en"
        t={t}
        onUpdate={update}
      />,
    );

    expect(screen.getByText("09:00")).toBeInTheDocument();
    expect(screen.getByText("10:30")).toBeInTheDocument();
    expect(screen.queryByText("09:00:00")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit template fields" }));
    expect(screen.getByLabelText("Start time")).toHaveValue("09:00");
    expect(screen.getByLabelText("End time")).toHaveValue("10:30");
    fireEvent.change(screen.getByLabelText("Venue mode"), { target: { value: "video" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template fields" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({
      taskId: "task-1",
      fields: {
        scheduled_on: "2026-08-20",
        starts_at: "09:00",
        ends_at: "10:30",
        venue_mode: "video",
      },
      nextFlowStep: null,
      applyRecommendedStatus: false,
    }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    {
      key: "review_approval",
      details: { flowStep: "prepare", reviewKind: "document", reviewerId: "11111111-1111-4111-8111-111111111111" },
      fields: [["Reviewer", "reviewer_id", "reviewerId"]],
    },
    {
      key: "meeting_event",
      details: { flowStep: "planning", scheduledOn: "2026-08-20", startsAt: "09:00:00", endsAt: "10:30:00", venueMode: "hybrid" },
      fields: [["Start time", "starts_at", "startsAt"], ["End time", "ends_at", "endsAt"]],
    },
  ])("saves and reloads cleared optional fields in $key", async ({ key, details: initial, fields }) => {
    const update = vi.fn();
    const template = DEMO_TASK_TEMPLATES.find((item) => item.key === key);
    function Host() {
      const [details, setDetails] = useState(initial);
      return <TaskTemplatePanel
        task={{ id: "task-1", status: "to_do" }}
        template={template}
        details={details}
        assignees={[{ id: "11111111-1111-4111-8111-111111111111", fullName: "Sam Steward" }]}
        lang="en"
        t={t}
        onUpdate={async (request) => {
          update(request);
          // The RPC changes a nullable column only when its key is present.
          setDetails((current) => ({ ...current, ...Object.fromEntries(fields
            .filter(([, field]) => Object.hasOwn(request.fields, field))
            .map(([, field, column]) => [column, request.fields[field]])) }));
        }}
      />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Edit template fields" }));
    for (const [label] of fields) {
      expect(screen.getByLabelText(label).value).not.toBe("");
      fireEvent.change(screen.getByLabelText(label), { target: { value: "" } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Save template fields" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0][0].fields).toEqual(expect.objectContaining(
      Object.fromEntries(fields.map(([, field]) => [field, null])),
    ));
    fireEvent.click(await screen.findByRole("button", { name: "Edit template fields" }));
    for (const [label] of fields) expect(screen.getByLabelText(label)).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("returns focus to the initiating flow action after cancel and failure", async () => {
    const update = vi.fn().mockRejectedValue(new Error("offline"));
    const template = DEMO_TASK_TEMPLATES.find((item) => item.key === "member_follow_up");
    render(
      <TaskTemplatePanel
        task={{ id: "task-1", status: "to_do" }}
        template={template}
        details={{ flowStep: "prepare", contactMethod: "phone", followUpOn: "2026-08-20" }}
        lang="en"
        t={t}
        onUpdate={update}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Move to Contact" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Keep current step" }));
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Move flow only" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be updated");
    expect(trigger).toHaveFocus();
  });
});
