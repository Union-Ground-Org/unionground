import { expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CasesView } from "../src/views/CasesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

const item = { id: "case-1", reference: "GRV-1", title: "Schedule case", type: "Scheduling", articles: "", status: "active", step: "Intake", deadlineValue: "2026-11-20", updates: [], files: [] };
const copy = {
  en: { save: "Save issue", saving: "Saving…", saved: "Saved", confirmation: "Issue saved.", step: "Step", deadline: "Deadline", status: "Status" },
  es: { save: "Guardar asunto", saving: "Guardando…", saved: "Guardado", confirmation: "Asunto guardado.", step: "Paso", deadline: "Plazo", status: "Estado" },
};

afterEach(() => { window.history.replaceState({}, "", "/"); });

function openCase(lang, onUpdateCase) {
  const props = { data: { cases: [item] }, onUpdateCase, focus: { caseId: item.id, nonce: 1 } };
  const view = render(<LanguageProvider lang={lang}><CasesView {...props} /></LanguageProvider>);
  return { ...view, dialog: within(screen.getByRole("dialog", { name: item.title })), props };
}

describe.each(["en", "es"])("member case save feedback (%s)", (lang) => {
  // A worker's issue carries no grievance step in this edition, so status and
  // deadline are the two editable fields.
  it.each(["deadline", "status"])("confirms success until the next %s edit", async (field) => {
    const onUpdateCase = vi.fn().mockResolvedValue(undefined);
    const { dialog } = openCase(lang, onUpdateCase);
    fireEvent.click(dialog.getByRole("button", { name: copy[lang].save }));
    expect(await dialog.findByRole("status")).toHaveTextContent(copy[lang].confirmation);
    expect(dialog.getByRole("button", { name: copy[lang].saved })).toBeInTheDocument();
    expect(onUpdateCase).toHaveBeenCalledExactlyOnceWith(item.id, { status: "active", deadline: "2026-11-20" });
    fireEvent.change(dialog.getByLabelText(copy[lang][field]), { target: { value: { step: "Investigation", deadline: "2026-11-25", status: "resolved" }[field] } });
    expect(dialog.queryByRole("status")).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: copy[lang].save })).toBeEnabled();
  });

  it("keeps the existing error and draft on failure and confirms a successful retry", async () => {
    const onUpdateCase = vi.fn().mockRejectedValueOnce(new Error("private driver error")).mockResolvedValue(undefined);
    const { dialog } = openCase(lang, onUpdateCase);
    fireEvent.change(dialog.getByLabelText(copy[lang].deadline), { target: { value: "2026-11-25" } });
    fireEvent.click(dialog.getByRole("button", { name: copy[lang].save }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(catalogue[lang]["toast.saveFailed"]);
    expect(dialog.queryByText("private driver error")).not.toBeInTheDocument();
    expect(dialog.getByLabelText(copy[lang].deadline)).toHaveValue("2026-11-25");
    expect(dialog.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: copy[lang].save }));
    expect(await dialog.findByRole("status")).toHaveTextContent(copy[lang].confirmation);
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not mark an edit made during a pending save as saved", async () => {
    let resolveSave;
    const onUpdateCase = vi.fn(() => new Promise((resolve) => { resolveSave = resolve; }));
    const { dialog } = openCase(lang, onUpdateCase);
    fireEvent.click(dialog.getByRole("button", { name: copy[lang].save }));
    expect((dialog.getByRole("button", { name: copy[lang].saving })).closest('[aria-disabled="true"]')).not.toBeNull();
    await expectPendingFocus(dialog.getByRole("button", { name: copy[lang].saving }));
    fireEvent.change(dialog.getByLabelText(copy[lang].deadline), { target: { value: "2026-11-26" } });
    await act(async () => resolveSave());
    expect(dialog.queryByRole("status")).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: copy[lang].save })).toBeEnabled();
  });
});

// BUG-UG-MEMBER-CAN-RESOLVE-OWN-CASE-AND-MOVE-ITS-DEADLINE-20261110:
// a case a steward or coordinator holds is moved by them, so the member reads
// its status and deadline; update_my_member_case refuses the member's edit.
describe.each(["en", "es"])("member case window on an assigned case (%s)", (lang) => {
  const assigned = { ...item, id: "case-2", title: "Overtime case", deadline: lang === "es" ? "27 nov 2026" : "Nov 27, 2026", deadlineValue: "2026-11-27", stewardName: "Juan Nolan", coordinatorName: "Abena Owusu" };
  const tr = (key) => catalogue[lang][key];
  const emptyDetails = vi.fn().mockResolvedValue({ description: null, incidentDate: null, remedySought: null, filingStatus: null });

  async function openAssigned(loadCaseDetails = emptyDetails) {
    const onUpdateCase = vi.fn();
    render(<LanguageProvider lang={lang}><CasesView data={{ cases: [assigned] }} onUpdateCase={onUpdateCase} loadCaseDetails={loadCaseDetails} focus={{ caseId: assigned.id, nonce: 1 }} /></LanguageProvider>);
    const dialog = within(screen.getByRole("dialog", { name: assigned.title }));
    await act(async () => {});
    return { dialog, onUpdateCase };
  }

  it("shows status and deadline as text with no select, date input or save button", async () => {
    const { dialog, onUpdateCase } = await openAssigned();
    expect(dialog.getByText(copy[lang].status)).toBeInTheDocument();
    expect(dialog.getByText(tr("cases.statusActive"))).toBeInTheDocument();
    expect(dialog.getByText(copy[lang].deadline)).toBeInTheDocument();
    expect(dialog.getByText(assigned.deadline)).toBeInTheDocument();
    expect(dialog.getByText(tr("cases.managedByRepresentative"))).toBeInTheDocument();
    expect(dialog.queryByLabelText(copy[lang].status)).not.toBeInTheDocument();
    expect(dialog.queryByLabelText(copy[lang].deadline)).not.toBeInTheDocument();
    expect(dialog.queryByLabelText(copy[lang].step)).not.toBeInTheDocument();
    expect(dialog.queryByRole("combobox")).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: copy[lang].save })).not.toBeInTheDocument();
    expect(onUpdateCase).not.toHaveBeenCalled();
  });

  it("shows no Case details block when all four details are empty", async () => {
    const { dialog } = await openAssigned();
    expect(emptyDetails).toHaveBeenCalledWith(assigned.id);
    expect(dialog.queryByText(tr("caseIntake.detailsTitle"))).not.toBeInTheDocument();
    expect(dialog.queryByText(tr("caseIntake.notRecorded"))).not.toBeInTheDocument();
  });

  it("shows recorded details and marks only the empty ones not recorded", async () => {
    const { dialog } = await openAssigned(vi.fn().mockResolvedValue({ description: "Ordered to stay past the Article 9 cap.", incidentDate: null, remedySought: "Pay for the extra hours", filingStatus: null }));
    expect(await dialog.findByText(tr("caseIntake.detailsTitle"))).toBeInTheDocument();
    expect(dialog.getByText("Ordered to stay past the Article 9 cap.")).toBeInTheDocument();
    expect(dialog.getAllByText(tr("caseIntake.notRecorded"))).toHaveLength(2);
  });
});

// An assignment the member's row carries by account
// only (no stamped name) is read-only too; the server answers for it.
describe.each(["en", "es"])("member case window on an account-only assignment (%s)", (lang) => {
  it("shows read-only status and deadline once the server says the case is managed, and keeps the form when it says not", async () => {
    const tr = (key) => catalogue[lang][key];
    const openWith = async (managed) => {
      const caseworkApi = { getMyCaseManaged: vi.fn().mockResolvedValue(managed) };
      const view = render(<LanguageProvider lang={lang}><CasesView data={{ cases: [item] }} onUpdateCase={vi.fn()} caseworkApi={caseworkApi} focus={{ caseId: item.id, nonce: 1 }} /></LanguageProvider>);
      await act(async () => {});
      expect(caseworkApi.getMyCaseManaged).toHaveBeenCalledWith(item.id);
      return { view, dialog: within(screen.getByRole("dialog", { name: item.title })) };
    };
    const managed = await openWith(true);
    expect(managed.dialog.getByText(tr("cases.managedByRepresentative"))).toBeInTheDocument();
    expect(managed.dialog.queryByRole("button", { name: copy[lang].save })).not.toBeInTheDocument();
    expect(managed.dialog.queryByLabelText(copy[lang].status)).not.toBeInTheDocument();
    managed.view.unmount();
    const open = await openWith(false);
    expect(open.dialog.getByRole("button", { name: copy[lang].save })).toBeInTheDocument();
    expect(open.dialog.getByLabelText(copy[lang].status)).toBeInTheDocument();
  });
});
