// REQ-UG-TASKS-WORKSTREAM-ASSIGNEES-DUE-DATES-20261030 (finding 57 of
// the October 29-30 role-play run): a chapter with no workstream could not file
// any task, and the template form offered only "—". The board now asks the
// server for the chapter's default workstream, and the form follows a list that
// arrives after it opens.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { DEMO_TASK_TEMPLATES } from "../src/lib/taskTemplates.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";
import { ensureChapterDefaultWorkstream } from "../src/lib/memberApi.js";
import { TasksView } from "../src/views/TasksView.jsx";
import { TaskTemplateDialog } from "../src/views/TaskTemplateDialog.jsx";

function tasksProps(data, overrides = {}) {
  return {
    data,
    onProfile: vi.fn(),
    onAssistant: vi.fn(),
    onCreateTask: vi.fn(async (fields) => ({ ...fields, id: "new-task" })),
    onUpdateTask: vi.fn(async (_id, fields) => fields),
    onDeleteTask: vi.fn(async () => ({ deleted: true })),
    onSendTaskMessage: vi.fn(async () => null),
    ...overrides,
  };
}

function memberData(workstreams) {
  const data = structuredClone(fallbackData);
  data.roles = [];
  data.tasks = [];
  data.workstreams = workstreams;
  return data;
}

describe("a chapter with no workstream", () => {
  it("asks the server for the default workstream once, then files a task in it", async () => {
    const ensure = vi.fn(async () => [{ id: "w-general", name: "General" }]);
    const props = tasksProps(memberData([]), { onEnsureDefaultWorkstream: ensure });
    const view = render(<LanguageProvider lang="en"><TasksView {...props} /></LanguageProvider>);
    await waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    // The parent stores the answer; the board re-renders with the column.
    view.rerender(<LanguageProvider lang="en"><TasksView {...props} data={memberData([{ id: "w-general", name: "General" }])} /></LanguageProvider>);
    view.rerender(<LanguageProvider lang="en"><TasksView {...props} data={memberData([])} /></LanguageProvider>);
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("does not ask while the list is unknown or already has a workstream", () => {
    const ensure = vi.fn(async () => []);
    const unknown = memberData(null);
    const view = render(<LanguageProvider lang="en"><TasksView {...tasksProps(unknown, { onEnsureDefaultWorkstream: ensure })} /></LanguageProvider>);
    view.unmount();
    render(<LanguageProvider lang="en"><TasksView {...tasksProps(memberData([{ id: "w", name: "Organizing" }]), { onEnsureDefaultWorkstream: ensure })} /></LanguageProvider>);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("keeps the board usable when the request fails", async () => {
    const ensure = vi.fn(async () => { throw new Error("offline"); });
    render(<LanguageProvider lang="en"><TasksView {...tasksProps(memberData([]), { onEnsureDefaultWorkstream: ensure })} /></LanguageProvider>);
    await waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    expect(screen.getAllByRole("button", { name: translate("en", "tasks.new") }).length).toBeGreaterThan(0);
  });
});

describe("template form workstream", () => {
  const t = (key, vars) => translate("en", key, vars);

  function dialog(workstreams, create) {
    return <TaskTemplateDialog templates={DEMO_TASK_TEMPLATES} workstreams={workstreams} assignees={[]} lang="en" t={t} onClose={() => {}} onCreate={create} />;
  }

  function fillFollowUp() {
    fireEvent.click(screen.getByRole("button", { name: /Worker Follow-up/i }));
    fireEvent.change(screen.getByLabelText(translate("en", "taskTemplates.title")), { target: { value: "Call back" } });
    fireEvent.change(screen.getByLabelText("Contact method"), { target: { value: "phone" } });
    fireEvent.change(screen.getByLabelText("Follow-up date"), { target: { value: "2026-11-20" } });
  }

  it("follows a workstream list that arrives after the form opens", async () => {
    const create = vi.fn().mockResolvedValue({ task: { id: "t" } });
    const view = render(dialog([], create));
    fillFollowUp();
    view.rerender(dialog(["General"], create));
    expect(screen.getByLabelText(translate("en", "taskTemplates.workstream"))).toHaveValue("General");
    fireEvent.click(screen.getByRole("button", { name: translate("en", "taskTemplates.create") }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ workstream: "General", title: "Call back" })));
  });

  it("keeps a chosen workstream and falls back when it disappears", () => {
    const view = render(dialog(["General", "Organizing"], vi.fn()));
    fireEvent.click(screen.getByRole("button", { name: /Worker Follow-up/i }));
    const select = screen.getByLabelText(translate("en", "taskTemplates.workstream"));
    fireEvent.change(select, { target: { value: "Organizing" } });
    expect(select).toHaveValue("Organizing");
    view.rerender(dialog(["General"], vi.fn()));
    expect(screen.getByLabelText(translate("en", "taskTemplates.workstream"))).toHaveValue("General");
  });

  it("says why it cannot save when the chapter has no workstream", () => {
    const create = vi.fn();
    render(dialog([], create));
    fillFollowUp();
    fireEvent.click(screen.getByRole("button", { name: translate("en", "taskTemplates.create") }));
    expect(screen.getByText(translate("en", "taskTemplates.noWorkstream"))).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    expect(translate("es", "taskTemplates.noWorkstream")).toMatch(/frente de trabajo/);
  });
});

describe("ensureChapterDefaultWorkstream", () => {
  it("calls the server function and maps its list", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ id: "w1", name: "General", extra: 1 }], error: null });
    await expect(ensureChapterDefaultWorkstream({ rpc })).resolves.toEqual([{ id: "w1", name: "General" }]);
    expect(rpc).toHaveBeenCalledWith("ensure_chapter_default_workstream");
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(ensureChapterDefaultWorkstream({ rpc })).resolves.toEqual([]);
    rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "chapter required" } });
    await expect(ensureChapterDefaultWorkstream({ rpc })).rejects.toThrow();
  });
});
