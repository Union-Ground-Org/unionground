// BUG-UG-CASEWORK-DEADLINE-REMINDER-AT-NEVER-FIRES-20261001: the Deadline
// center shows whether a reminder was sent, and staff record the outcome the
// sweep cannot know (met, waived) or reopen a deadline, through the server.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CaseworkOperationsPanel } from "../src/components/CaseworkOperationsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { setCaseworkDeadlineStatus } from "../src/lib/caseworkApi.js";

const scope = { id: "case-1", organization_id: "org-1", chapter_id: "ch-1", step: "Intake", status: "active", is_restricted: false };

function caseData(deadlines) {
  return {
    scope, strength: [], deadlines, checklists: [], transitions: [], alerts: [],
    management: [], retaliation: [], links: [], reminders: [],
  };
}

function deadline(overrides) {
  return {
    id: "deadline-1", kind: "response", label: "Step 2 response", due_at: "2026-10-05T17:00:00Z", status: "active",
    reminder_at: "2026-10-04T13:00:00Z", reminder_sent_at: null, extensions: [], ...overrides,
  };
}

function renderPanel(lang, deadlines, extra = {}) {
  const api = {
    loadCaseworkCase: vi.fn().mockResolvedValue(caseData(deadlines)),
    setDeadlineStatus: vi.fn().mockResolvedValue({}),
    ...extra,
  };
  render(<LanguageProvider lang={lang}><CaseworkOperationsPanel caseId="case-1" api={api} /></LanguageProvider>);
  return api;
}

async function deadlineCenter(name) {
  return (await screen.findByRole("heading", { name })).closest("article");
}

describe("deadline center outcome controls", () => {
  it("marks an open deadline met or waived and shows a scheduled reminder", async () => {
    const api = renderPanel("en", [deadline({})]);
    const center = await deadlineCenter("Deadline center");
    expect(within(center).getByText(/^Reminder /, { selector: "small" })).toBeTruthy();
    expect(within(center).queryByRole("button", { name: "Reopen" })).toBeNull();
    fireEvent.click(within(center).getByRole("button", { name: "Mark met" }));
    await waitFor(() => expect(api.setDeadlineStatus).toHaveBeenCalledWith("deadline-1", "met"));
    fireEvent.click(within(center).getByRole("button", { name: "Waive" }));
    await waitFor(() => expect(api.setDeadlineStatus).toHaveBeenCalledWith("deadline-1", "waived"));
  });

  it("lets staff answer a sweep-marked missed deadline and says the reminder was sent, in Spanish", async () => {
    const api = renderPanel("es", [deadline({ status: "missed", reminder_disposition: "sent", reminder_sent_at: "2026-10-04T13:00:30Z" })]);
    const center = await deadlineCenter("Centro de plazos");
    expect(within(center).getByText(/^Recordatorio enviado /, { selector: "small" })).toBeTruthy();
    expect(within(center).getByText(/Incumplido/)).toBeTruthy();
    fireEvent.click(within(center).getByRole("button", { name: "Marcar cumplido" }));
    await waitFor(() => expect(api.setDeadlineStatus).toHaveBeenCalledWith("deadline-1", "met"));
    expect(within(center).getByRole("button", { name: "Reabrir" })).toBeTruthy();
  });

  it("never says sent when the sweep sent nothing, and says why, in English and Spanish", async () => {
    const cases = [
      ["expired", "en", "Deadline center", /^Reminder .* not sent: it was out of date when it came due$/],
      ["suppressed", "en", "Deadline center", /^Reminder .* not sent: deadline reminders were switched off$/],
      ["no_recipient", "es", "Centro de plazos", /^Recordatorio .* no enviado: nadie de la lista podía abrir este caso$/],
    ];
    for (const [disposition, lang, heading, text] of cases) {
      const { unmount } = render(<LanguageProvider lang={lang}><CaseworkOperationsPanel caseId="case-1" api={{
        loadCaseworkCase: vi.fn().mockResolvedValue(caseData([deadline({ reminder_disposition: disposition })])),
        setDeadlineStatus: vi.fn().mockResolvedValue({}),
      }} /></LanguageProvider>);
      const center = await deadlineCenter(heading);
      expect(within(center).getByText(text, { selector: "small" })).toBeTruthy();
      expect(within(center).queryByText(/Reminder sent|Recordatorio enviado/)).toBeNull();
      unmount();
    }
  });

  it("offers only Reopen on a met deadline and no reminder line without a reminder", async () => {
    renderPanel("en", [deadline({ status: "met", reminder_at: null })]);
    const center = await deadlineCenter("Deadline center");
    expect(within(center).getByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(within(center).queryByRole("button", { name: "Mark met" })).toBeNull();
    expect(within(center).queryByText(/^Reminder /, { selector: "small" })).toBeNull();
  });

  it("calls the definer routine with the deadline and status", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { id: "deadline-1", status: "waived" }, error: null }) };
    expect(await setCaseworkDeadlineStatus(client, "deadline-1", "waived")).toEqual({ id: "deadline-1", status: "waived" });
    expect(client.rpc).toHaveBeenCalledWith("casework_set_deadline_status", { p_deadline_id: "deadline-1", p_status: "waived" });
  });
});
