import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AutomationGuidedBuilder } from "../src/features/automation/AutomationGuidedBuilder.jsx";
import { AUTOMATION_ACTION_METADATA, AUTOMATION_TRIGGER_METADATA } from "../src/features/automation/capabilities.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const organizationId = "50900000-0000-4000-8000-000000000108";
const chapterId = "chapter-a";
const personId = "50900000-0000-4000-8000-000000000111";
// A non-approver author: a steward with MFA satisfied and no approval role.
const session = {
  authenticated: true, selectedOrganizationId: organizationId, mfaSatisfied: true,
  role: "steward", selectedHat: "steward", organizationRoles: ["steward"],
  membershipStatus: "active", organizationStatus: "active", canApprove: false,
};
const capabilities = {
  schemaVersion: 2, triggers: AUTOMATION_TRIGGER_METADATA.map((item) => item.id),
  actions: AUTOMATION_ACTION_METADATA.map((item) => item.id),
  cadences: ["hourly", "daily", "weekly"], maxThresholdDays: 90,
};
const scopeOptions = () => ({
  ok: true,
  data: {
    chapters: { rows: [{ id: chapterId, label: "Chapter one" }], total: 1, page: 1, pageSize: 6 },
    assignees: { rows: [{ id: personId, label: "Eligible staff" }], total: 1, page: 1, pageSize: 6 },
    recipients: { rows: [{ id: personId, label: "Eligible staff" }], total: 1, page: 1, pageSize: 6 },
  },
});

function Harness({ actionKind = "create_standard_task", lang = "en", triggerKind = "overdue_task", onSave }) {
  const [draft, setDraft] = useState({
    schemaVersion: 2, name: "", triggerKind, thresholdDays: "1",
    cadence: "daily", taskPriority: "medium", conditions: {}, actionKind, actionConfig: {},
  });
  // Stable identity: the builder refetches scope whenever `api` changes.
  const [stableApi] = useState(() => ({ getScopeOptions: vi.fn().mockImplementation(scopeOptions) }));
  return <LanguageProvider lang={lang}>
    <AutomationGuidedBuilder draft={draft} setDraft={setDraft} capabilities={capabilities}
      api={stableApi} session={session} busy={false} onSave={() => onSave(draft)} onCancel={() => {}} />
  </LanguageProvider>;
}

async function finishBuilder({ personField }) {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Steward weekly sweep" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const chapter = await screen.findByLabelText("Campaign / task board");
  await waitFor(() => expect(chapter).not.toBeDisabled());
  // The steward's one authorized chapter is offered as a real option.
  expect(within(chapter).getByRole("option", { name: "Chapter one" })).toBeInTheDocument();
  fireEvent.change(chapter, { target: { value: chapterId } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  if (personField) {
    const field = await screen.findByLabelText(personField);
    await waitFor(() => expect(field).not.toBeDisabled());
    fireEvent.change(field, { target: { value: personField === "Raise priority to" ? "high" : personId } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
}

describe("guided builder scope for a non-approver author", () => {
  it.each([
    ["create_standard_task", null],
    ["assign_task", "Assign to"],
    ["raise_task_priority", "Raise priority to"],
    ["notify_in_app", "Notify in the app"],
  ])("saves a %s draft scoped to the author's only authorized chapter", async (actionKind, personField) => {
    const onSave = vi.fn();
    render(<Harness actionKind={actionKind} onSave={onSave} />);
    await finishBuilder({ personField });
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved.conditions).toEqual({ chapterId });
    expect(saved).toMatchObject({ actionKind, triggerKind: "overdue_task", schemaVersion: 2 });
  });

  it("asks the scope picker with the non-approver session, not an approval role", async () => {
    const onSave = vi.fn();
    const getScopeOptions = vi.fn().mockImplementation(scopeOptions);
    const stableApi = { getScopeOptions };
    function ScopedHarness() {
      const [draft, setDraft] = useState({
        schemaVersion: 2, name: "", triggerKind: "overdue_task", thresholdDays: "1",
        cadence: "daily", taskPriority: "medium", conditions: {}, actionKind: "create_standard_task", actionConfig: {},
      });
      return <LanguageProvider lang="en">
        <AutomationGuidedBuilder draft={draft} setDraft={setDraft} capabilities={capabilities}
          api={stableApi} session={session} busy={false} onSave={() => onSave(draft)} onCancel={() => {}} />
      </LanguageProvider>;
    }
    render(<ScopedHarness />);
    await finishBuilder({ personField: null });
    expect(onSave).toHaveBeenCalledTimes(1);
    for (const call of getScopeOptions.mock.calls) expect(call[0]).toBe(session);
  });
});

describe("the guided builder day window", () => {
  const copies = [
    ["en", "Name", "Continue", "Day threshold", "Enter a whole number of days from 0 to 90."],
    ["es", "Nombre", "Continuar", "Umbral de días", "Ingresa un número entero de días entre 0 y 90."],
  ];

  it.each(copies)("states the range and explains out-of-range and fractional days in %s",
    async (lang, name, next, threshold, rule) => {
      const onSave = vi.fn();
      render(<Harness lang={lang} onSave={onSave} />);
      fireEvent.change(screen.getByLabelText(name), { target: { value: "Weekly sweep" } });
      fireEvent.click(screen.getByRole("button", { name: next }));
      const days = screen.getByRole("spinbutton", { name: threshold });
      expect(days).toHaveAccessibleDescription(expect.stringContaining(rule));
      expect(days).not.toHaveAttribute("aria-invalid");
      for (const value of ["91", "1.5"]) {
        fireEvent.change(days, { target: { value } });
        fireEvent.click(screen.getByRole("button", { name: next }));
        expect(screen.getByRole("alert")).toHaveTextContent(rule);
        expect(days).toHaveAttribute("aria-invalid", "true");
        expect(days).toHaveFocus();
        expect(days.value).toBe(value);
        expect(onSave).not.toHaveBeenCalled();
      }
      fireEvent.change(days, { target: { value: "90" } });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(days).not.toHaveAttribute("aria-invalid");
      fireEvent.click(screen.getByRole("button", { name: next }));
      await waitFor(() => expect(days).not.toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: next }));
      fireEvent.click(screen.getByRole("button", { name: next }));
      expect(onSave).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: lang === "en" ? "Save draft" : "Guardar borrador" }));
      expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ thresholdDays: "90" }));
    },
  );

  it("names the contact follow-up minimum and keeps zero at the field for correction", () => {
    render(<Harness triggerKind="stale_member_contact" onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Follow up on cases" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const days = screen.getByRole("spinbutton", { name: "Day threshold" });
    const rule = "Enter a whole number of days from 1 to 90.";
    expect(days).toHaveAccessibleDescription(expect.stringContaining(rule));
    fireEvent.change(days, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(days).toHaveValue(0);
    expect(screen.getByRole("alert")).toHaveTextContent(rule);
  });

  it("explains why the window is disabled for a trigger without one", () => {
    render(<Harness triggerKind="blocked_task" onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Follow blocked work" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const days = screen.getByRole("spinbutton", { name: "Day threshold" });
    expect(days).toBeDisabled();
    expect(days).toHaveAccessibleDescription("This trigger does not use a day window.");
  });
});
