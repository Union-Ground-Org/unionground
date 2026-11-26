import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdministrativeEvidencePanel } from "../src/components/AdministrativeEvidencePanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { formatGroupMoment } from "../src/lib/i18n/zonedDates.js";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { expectRefusedEveryWay } from "./helpers/blockedPress.js";

const DESK = {
  fieldNoteBlocks: [
    { id: "block-1", issueKey: "staffing", sourceTitle: "Listening session", sourceType: "interview", provenance: "Recorded with consent", annotation: "Confirm the date", packetState: "draft", body: "Overnight vacancies remain open." },
    { id: "block-2", issueKey: "Safety Review", sourceTitle: "Inspection log", sourceType: "document", provenance: "Authorized inspection record", annotation: "", packetState: "included", body: "The inspection identified a damaged guard." },
  ],
  packets: [
    { id: "packet-1", issueKey: "staffing", title: "Staffing packet", body: "Assembled staffing evidence", status: "draft" },
    { id: "packet-2", issueKey: "safety", title: "Safety packet", body: "Assembled safety evidence", status: "review_ready" },
  ],
  actions: [
    { targetKind: "field_note_block", actionKey: "include", label: "Include field note" },
    { targetKind: "field_note_block", actionKey: "exclude", label: "Exclude field note" },
    { targetKind: "field_note_packet", actionKey: "mark_review_ready", label: "Mark packet review ready" },
    { targetKind: "member_case", actionKey: "case_record_review", label: "Record issue review" },
  ],
  actionTargets: [{ targetKind: "member_case", id: "case-1", label: "UG-001 · Schedule case" }],
  history: [
    { id: "run-1", actionKey: "mark_review_ready", targetKind: "field_note_packet", targetId: "packet-2", targetLabel: "Safety packet", note: "Reviewed", previousState: { status: "draft" }, resultingState: { status: "review_ready" }, actorLabel: "Sam Admin", createdAt: "2026-08-30T12:30:00Z" },
    { id: "run-2", actionKey: "include", targetKind: "field_note_block", targetId: "block-1", targetLabel: "staffing · Listening session", note: "", previousState: { packetState: "draft" }, resultingState: { packetState: "included" }, actorLabel: "Alex Admin", createdAt: "2026-08-30T12:00:00Z" },
  ],
  hasNext: { notes: true, actions: true },
};

function makeApi(overrides = {}) {
  return {
    loadAdministrativeEvidence: vi.fn().mockResolvedValue(DESK),
    addFieldNoteEvidence: vi.fn().mockResolvedValue({ created: true }),
    draftFieldNotePacket: vi.fn().mockResolvedValue({ created: true }),
    executeAdministrativeObjectAction: vi.fn().mockResolvedValue({ created: true }),
    ...overrides,
  };
}

function renderPanel(api, lang = "en") {
  return render(<LanguageProvider lang={lang}><AdministrativeEvidencePanel api={api} /></LanguageProvider>);
}

// Testing Library collapses the non-breaking spaces ICU puts in "a. m."; match that.
// Since #9530 the stamp names its group's zone and carries no seconds.
function stampText(lang, iso) {
  return formatGroupMoment(iso, lang).replace(/\s+/g, " ");
}

describe("administrative evidence panel", () => {
  it.each([
    ["en", "Draft packet", "Issue key", "Packet title", "Include evidence for an issue before drafting a packet.", "Choose an issue for the packet.", "Enter a title for the packet."],
    ["es", "Crear borrador", "Clave del asunto", "Título del paquete", "Incluya evidencia de un asunto antes de crear un borrador.", "Elija un asunto para el paquete.", "Escriba un título para el paquete."],
  ])("explains blocked packet drafts in %s", async (lang, label, issue, title, noEvidence, noIssue, noTitle) => {
    const current = { ...DESK, fieldNoteBlocks: [], actionTargets: [] };
    const api = makeApi({ loadAdministrativeEvidence: vi.fn().mockResolvedValue(current) });
    const acted = () => api.draftFieldNotePacket.mock.calls.length > 0;
    const view = renderPanel(api, lang);
    let button = await screen.findByRole("button", { name: label });
    expect(button).toHaveAccessibleDescription(noEvidence);
    expect(button.nextElementSibling).toBeVisible();
    expectRefusedEveryWay(button, noEvidence, acted);
    view.unmount();
    current.fieldNoteBlocks = DESK.fieldNoteBlocks;
    renderPanel(api, lang);
    button = await screen.findByRole("button", { name: label });
    expect(button).toHaveAccessibleDescription(noIssue);
    expectRefusedEveryWay(button, noIssue, acted);
    fireEvent.change(within(button.form).getByLabelText(issue), { target: { value: "Safety Review" } });
    fireEvent.change(screen.getByLabelText(title), { target: { value: "   " } });
    expect(button).toHaveAccessibleDescription(noTitle);
    expectRefusedEveryWay(button, noTitle, acted);
    fireEvent.change(screen.getByLabelText(title), { target: { value: "Draft packet title" } });
    fireEvent.click(button);
    await waitFor(() => expect(api.draftFieldNotePacket).toHaveBeenCalledExactlyOnceWith("Safety Review", "Draft packet title"));

    const es = lang === "es";
    fireEvent.click(screen.getByRole("button", { name: es ? "Laboratorio de acciones" : "Action Lab" }));
    const execute = screen.getByRole("button", { name: es ? "Aplicar acción" : "Apply action" });
    const actionSelect = screen.getByLabelText(es ? "Acción" : "Action");
    const executed = () => api.executeAdministrativeObjectAction.mock.calls.length > 0;
    const missingAction = es ? "Elija una acción para aplicar." : "Choose an action to apply.";
    expect(execute).toHaveAccessibleDescription(missingAction);
    expectRefusedEveryWay(execute, missingAction, executed);
    fireEvent.change(actionSelect, { target: { value: "include" } });
    const missingTarget = es ? "Elija un elemento para esta acción." : "Choose a target for this action.";
    expect(execute).toHaveAccessibleDescription(missingTarget);
    expectRefusedEveryWay(execute, missingTarget, executed);
    fireEvent.change(actionSelect, { target: { value: "case_record_review" } });
    const noTarget = es ? "No hay elementos disponibles para esta acción en este momento." : "Nothing is eligible for this action right now.";
    expect(execute).toHaveAccessibleDescription(noTarget);
    expectRefusedEveryWay(execute, noTarget, executed);
  });

  it("shows the placeholder when a refresh removes the selected packet issue", async () => {
    const [staffing, safety] = DESK.fieldNoteBlocks;
    const api = makeApi({
      loadAdministrativeEvidence: vi.fn()
        .mockResolvedValueOnce({ ...DESK, fieldNoteBlocks: [{ ...staffing, packetState: "included" }, safety] })
        .mockResolvedValue({ ...DESK, fieldNoteBlocks: [{ ...staffing, packetState: "excluded" }, safety] }),
    });
    renderPanel(api);
    const button = await screen.findByRole("button", { name: "Draft packet" });
    const form = within(button.form);
    const issue = form.getByLabelText("Issue key");
    const title = form.getByLabelText("Packet title");
    fireEvent.change(issue, { target: { value: staffing.issueKey } });
    fireEvent.change(title, { target: { value: "Keep this draft" } });
    expect(button).not.toHaveAttribute("aria-disabled");

    const row = screen.getByText("staffing · Listening session").closest(".xus-row");
    fireEvent.click(within(row).getByRole("button", { name: "Exclude" }));
    await waitFor(() => expect(form.queryByRole("option", { name: staffing.issueKey })).not.toBeInTheDocument());
    expect(form.getAllByRole("option").map((option) => option.value)).toEqual(["", safety.issueKey]);
    expect(issue).toHaveValue("");
    expect(issue).toHaveDisplayValue("Issue key");
    expect(title).toHaveValue("Keep this draft");
    expect(button).toHaveAccessibleDescription("Choose an issue for the packet.");
    fireEvent.submit(button.form);
    expect(api.draftFieldNotePacket).not.toHaveBeenCalled();

    fireEvent.change(issue, { target: { value: safety.issueKey } });
    fireEvent.click(button);
    await waitFor(() => expect(api.draftFieldNotePacket).toHaveBeenCalledExactlyOnceWith(safety.issueKey, "Keep this draft"));
  });
  it("preserves an unsent draft when language changes rebuild the same scope's adapter", async () => {
    const firstApi = makeApi();
    const nextApi = makeApi();
    const view = render(<LanguageProvider lang="en"><AdministrativeEvidencePanel api={firstApi} scopeKey="member-a:org-a:chapter-a" /></LanguageProvider>);
    await screen.findByText("staffing · Listening session");
    fireEvent.change(screen.getByLabelText("Source title"), { target: { value: "Unsent field notes" } });
    fireEvent.change(screen.getByLabelText("Evidence text"), { target: { value: "Private draft retained in its original scope" } });
    view.rerender(<LanguageProvider lang="es"><AdministrativeEvidencePanel api={nextApi} scopeKey="member-a:org-a:chapter-a" /></LanguageProvider>);
    await waitFor(() => expect(nextApi.loadAdministrativeEvidence).toHaveBeenCalledWith(0));
    expect(screen.getByLabelText("Título de la fuente")).toHaveValue("Unsent field notes");
    expect(screen.getByLabelText("Texto de evidencia")).toHaveValue("Private draft retained in its original scope");
    expect(firstApi.addFieldNoteEvidence).not.toHaveBeenCalled();
    expect(nextApi.addFieldNoteEvidence).not.toHaveBeenCalled();
  });

  it("keeps a pending write failure and its draft through a same-scope language change", async () => {
    let refuse;
    const firstApi = makeApi({ addFieldNoteEvidence: vi.fn(() => new Promise((resolve, reject) => { refuse = reject; })) });
    const nextApi = makeApi();
    const view = render(<LanguageProvider lang="en"><AdministrativeEvidencePanel api={firstApi} scopeKey="same-scope" /></LanguageProvider>);
    await screen.findByLabelText("Source title");
    fireEvent.change(screen.getByLabelText("Source title"), { target: { value: "Unsent title" } });
    fireEvent.change(screen.getByLabelText("Source provenance"), { target: { value: "Authorized draft" } });
    fireEvent.change(screen.getAllByLabelText("Issue key")[0], { target: { value: "staffing" } });
    fireEvent.change(screen.getByLabelText("Evidence text"), { target: { value: "Unsent evidence" } });
    fireEvent.submit(screen.getByRole("button", { name: "Add Field Notes evidence" }).closest("form"));
    view.rerender(<LanguageProvider lang="es"><AdministrativeEvidencePanel api={nextApi} scopeKey="same-scope" /></LanguageProvider>);
    await waitFor(() => expect(nextApi.loadAdministrativeEvidence).toHaveBeenCalled());
    await act(async () => refuse(new Error("write refused")));
    expect(await screen.findByText(/operation failed|operación falló/)).toBeVisible();
    expect(screen.getByLabelText("Título de la fuente")).toHaveValue("Unsent title");
    expect(screen.getByLabelText("Texto de evidencia")).toHaveValue("Unsent evidence");
  });

  it("clears the private draft on an explicit scope change even when the adapter is reused", async () => {
    const api = makeApi();
    const view = render(<LanguageProvider lang="en"><AdministrativeEvidencePanel api={api} scopeKey="member-a:org-a:chapter-a" /></LanguageProvider>);
    await screen.findByText("staffing · Listening session");
    fireEvent.change(screen.getByLabelText("Source title"), { target: { value: "Old scope draft" } });
    view.rerender(<LanguageProvider lang="en"><AdministrativeEvidencePanel api={api} scopeKey="member-a:org-a:chapter-b" /></LanguageProvider>);
    expect(screen.queryByDisplayValue("Old scope draft")).not.toBeInTheDocument();
    expect(screen.queryByText("Overnight vacancies remain open.")).not.toBeInTheDocument();
    await screen.findByText("staffing · Listening session");
    expect(screen.getByLabelText("Source title")).toHaveValue("");
  });

  it("immediately removes the previous scope's evidence and draft before a replacement read", async () => {
    const allowed = makeApi();
    let refuse;
    const denied = makeApi({ loadAdministrativeEvidence: vi.fn(() => new Promise((resolve, reject) => { refuse = reject; })) });
    const view = renderPanel(allowed);
    await screen.findByText("staffing · Listening session");
    fireEvent.change(screen.getByLabelText("Source title"), { target: { value: "Private draft" } });
    view.rerender(<LanguageProvider lang="en"><AdministrativeEvidencePanel api={denied} /></LanguageProvider>);
    expect(screen.queryByText("Overnight vacancies remain open.")).not.toBeInTheDocument();
    expect(screen.queryByText("Assembled staffing evidence")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Private draft")).not.toBeInTheDocument();
    await waitFor(() => expect(denied.loadAdministrativeEvidence).toHaveBeenCalledWith(0));
    await act(async () => refuse({ code: "42501", status: 403 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Evidence operations are unavailable");
    expect(screen.queryByRole("button", { name: "Add Field Notes evidence" })).not.toBeInTheDocument();
    expect(screen.queryByText("Overnight vacancies remain open.")).not.toBeInTheDocument();
  });

  it.each([{ status: 401 }, { status: 403 }, { code: "42501" }])("clears cached evidence after a same-scope read refusal %j", async (refusal) => {
    const api = makeApi({ loadAdministrativeEvidence: vi.fn().mockResolvedValueOnce(DESK).mockRejectedValueOnce(refusal) });
    renderPanel(api);
    const row = (await screen.findByText("staffing · Listening session")).closest(".xus-row");
    fireEvent.click(within(row).getByRole("button", { name: "Include" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Overnight vacancies remain open.")).not.toBeInTheDocument();
    expect(screen.queryByText("Assembled staffing evidence")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Action Lab" }));
    expect(screen.queryByText("Sam Admin")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "UG-001 · Schedule case" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply action" })).not.toBeInTheDocument();
  });

  it("retires an old scope's pending mutation without reloading or replacing the new desk", async () => {
    let finish;
    const oldApi = makeApi({ executeAdministrativeObjectAction: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
    const nextApi = makeApi({ loadAdministrativeEvidence: vi.fn().mockResolvedValue({ ...DESK, fieldNoteBlocks: [], packets: [] }) });
    const view = renderPanel(oldApi);
    const row = (await screen.findByText("staffing · Listening session")).closest(".xus-row");
    fireEvent.click(within(row).getByRole("button", { name: "Include" }));
    view.rerender(<LanguageProvider lang="en"><AdministrativeEvidencePanel api={nextApi} /></LanguageProvider>);
    await screen.findByText("No Field Notes evidence yet.");
    await act(async () => finish({ created: true }));
    expect(oldApi.loadAdministrativeEvidence).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Overnight vacancies remain open.")).not.toBeInTheDocument();
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
  });

  it.each(["saved", "failed"])("ignores a retired %s mutation's pending refresh", async (outcome) => {
    let finishRefresh;
    const oldApi = makeApi({
      loadAdministrativeEvidence: vi.fn().mockResolvedValueOnce(DESK).mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; })),
      executeAdministrativeObjectAction: outcome === "saved" ? vi.fn().mockResolvedValue({ created: true }) : vi.fn().mockRejectedValue(new Error("write refused")),
    });
    const nextApi = makeApi({ loadAdministrativeEvidence: vi.fn().mockResolvedValue({ ...DESK, fieldNoteBlocks: [], packets: [] }) });
    const view = renderPanel(oldApi);
    const row = (await screen.findByText("staffing · Listening session")).closest(".xus-row");
    fireEvent.click(within(row).getByRole("button", { name: "Include" }));
    await waitFor(() => expect(oldApi.loadAdministrativeEvidence).toHaveBeenCalledTimes(2));
    view.rerender(<LanguageProvider lang="en"><AdministrativeEvidencePanel api={nextApi} /></LanguageProvider>);
    await screen.findByText("No Field Notes evidence yet.");
    await act(async () => finishRefresh(DESK));
    expect(screen.queryByText("Overnight vacancies remain open.")).not.toBeInTheDocument();
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
    expect(screen.queryByText("The operation failed. Nothing was reported as saved.")).not.toBeInTheDocument();
    expect(nextApi.loadAdministrativeEvidence).toHaveBeenCalledTimes(1);
  });

  it("ignores a rejected mutation from a retired scope", async () => {
    let rejectMutation;
    const oldApi = makeApi({ executeAdministrativeObjectAction: vi.fn(() => new Promise((resolve, reject) => { rejectMutation = reject; })) });
    const nextApi = makeApi({ loadAdministrativeEvidence: vi.fn().mockResolvedValue({ ...DESK, fieldNoteBlocks: [], packets: [] }) });
    const view = renderPanel(oldApi);
    const row = (await screen.findByText("staffing · Listening session")).closest(".xus-row");
    fireEvent.click(within(row).getByRole("button", { name: "Include" }));
    view.rerender(<LanguageProvider lang="en"><AdministrativeEvidencePanel api={nextApi} /></LanguageProvider>);
    await screen.findByText("No Field Notes evidence yet.");
    await act(async () => rejectMutation(new Error("late refusal")));
    expect(oldApi.loadAdministrativeEvidence).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(nextApi.loadAdministrativeEvidence).toHaveBeenCalledTimes(1);
  });

  it("ignores a rejected read from a retired scope", async () => {
    let rejectRead;
    const oldApi = makeApi({ loadAdministrativeEvidence: vi.fn(() => new Promise((resolve, reject) => { rejectRead = reject; })) });
    const nextApi = makeApi();
    const view = renderPanel(oldApi);
    await waitFor(() => expect(oldApi.loadAdministrativeEvidence).toHaveBeenCalledTimes(1));
    view.rerender(<LanguageProvider lang="en"><AdministrativeEvidencePanel api={nextApi} /></LanguageProvider>);
    await screen.findByText("staffing · Listening session");
    await act(async () => rejectRead({ status: 403 }));
    expect(screen.getByText("Overnight vacancies remain open.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("operates Field Notes and Action Lab through the bounded API", async () => {
    const api = makeApi();
    renderPanel(api);
    const panel = await screen.findByRole("article");
    expect(await within(panel).findByText(/Recorded with consent/)).toBeInTheDocument();
    expect(within(panel).getByText(/Confirm the date/)).toBeInTheDocument();
    expect(within(panel).getByText("Assembled staffing evidence")).toBeInTheDocument();
    expect(api.loadAdministrativeEvidence).toHaveBeenCalledWith(0);

    const noteForm = within(panel).getByRole("button", { name: "Add Field Notes evidence" }).closest("form");
    fireEvent.change(within(noteForm).getByLabelText("Source title"), { target: { value: "Night-shift interview" } });
    fireEvent.change(within(noteForm).getByLabelText("Source type"), { target: { value: "observation" } });
    fireEvent.change(within(noteForm).getByLabelText("Source provenance"), { target: { value: "Authorized steward notes" } });
    fireEvent.change(within(noteForm).getByLabelText("Issue key"), { target: { value: "staffing" } });
    fireEvent.change(within(noteForm).getByLabelText("Evidence text"), { target: { value: "Two vacancies observed." } });
    fireEvent.change(within(noteForm).getByLabelText("Explanation (optional)"), { target: { value: "Needs confirmation" } });
    fireEvent.submit(noteForm);
    await waitFor(() => expect(api.addFieldNoteEvidence).toHaveBeenCalledWith({ sourceTitle: "Night-shift interview", sourceType: "observation", provenance: "Authorized steward notes", issueKey: "staffing", body: "Two vacancies observed.", annotation: "Needs confirmation" }));

    const staffingRow = within(panel).getByText("staffing · Listening session").closest(".xus-row");
    fireEvent.click(within(staffingRow).getByRole("button", { name: "Include" }));
    await waitFor(() => expect(api.executeAdministrativeObjectAction).toHaveBeenCalledWith({ targetKind: "field_note_block", targetId: "block-1", actionKey: "include" }));
    fireEvent.click(within(staffingRow).getByRole("button", { name: "Exclude" }));
    await waitFor(() => expect(api.executeAdministrativeObjectAction).toHaveBeenCalledWith({ targetKind: "field_note_block", targetId: "block-1", actionKey: "exclude" }));

    const packetForm = within(panel).getByRole("button", { name: "Draft packet" }).closest("form");
    expect(within(packetForm).queryByRole("option", { name: "staffing" })).not.toBeInTheDocument();
    fireEvent.change(within(packetForm).getByLabelText("Issue key"), { target: { value: "Safety Review" } });
    fireEvent.change(within(packetForm).getByLabelText("Packet title"), { target: { value: "Staffing follow-up" } });
    fireEvent.submit(packetForm);
    await waitFor(() => expect(api.draftFieldNotePacket).toHaveBeenCalledWith("Safety Review", "Staffing follow-up"));
    fireEvent.click(within(panel).getAllByRole("button", { name: "Mark review ready" })[0]);
    await waitFor(() => expect(api.executeAdministrativeObjectAction).toHaveBeenCalledWith({ targetKind: "field_note_packet", targetId: "packet-1", actionKey: "mark_review_ready" }));

    fireEvent.click(within(panel).getByRole("button", { name: "Action Lab" }));
    const actionForm = within(panel).getByRole("button", { name: "Apply action" }).closest("form");
    const actionSelect = within(actionForm).getByLabelText("Action");
    const targetSelect = within(actionForm).getByLabelText("Applies to");
    fireEvent.change(actionSelect, { target: { value: "include" } });
    await waitFor(() => expect(targetSelect).toHaveValue(""));
    expect(within(actionForm).getByRole("button", { name: "Apply action" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(targetSelect, { target: { value: "block-1" } });
    fireEvent.change(actionSelect, { target: { value: "mark_review_ready" } });
    await waitFor(() => expect(targetSelect).toHaveValue(""));
    fireEvent.change(targetSelect, { target: { value: "packet-1" } });
    fireEvent.change(within(actionForm).getByLabelText("Note (optional)"), { target: { value: "Packet checked" } });
    fireEvent.submit(actionForm);
    await waitFor(() => expect(api.executeAdministrativeObjectAction).toHaveBeenCalledWith({ actionKey: "mark_review_ready", targetKind: "field_note_packet", targetId: "packet-1", note: "Packet checked" }));
    expect(within(actionForm).queryByRole("option", { name: "Safety packet" })).not.toBeInTheDocument();
    fireEvent.change(actionSelect, { target: { value: "case_record_review" } });
    await waitFor(() => expect(targetSelect).toHaveValue(""));
    fireEvent.change(targetSelect, { target: { value: "case-1" } });
    expect(within(panel).getByText("Before: Status: Draft")).toBeInTheDocument();
    expect(within(panel).getByText("After: Status: Review ready")).toBeInTheDocument();
    expect(within(panel).getByText("Evidence packet · Safety packet")).toBeInTheDocument();
    expect(within(panel).getByText("Done by: Sam Admin")).toBeInTheDocument();
    expect(within(panel).getByText("Reviewed")).toBeInTheDocument();
    expect(within(panel).getByText(`Recorded: ${stampText("en", "2026-08-30T12:30:00Z")}`)).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.loadAdministrativeEvidence).toHaveBeenCalledWith(1));
    fireEvent.click(within(panel).getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(api.loadAdministrativeEvidence).toHaveBeenLastCalledWith(0));
    expect(within(panel).getByText("Saved.")).toBeInTheDocument();
  });

  // REQ-UG-POMS-FUNCTION-REMOVAL-20261003: the owner removed the POMS
  // function, so the workspace opens on Field Notes and offers two tabs only.
  it("offers only Field Notes and Action Lab, opening on Field Notes", async () => {
    renderPanel(makeApi());
    const panel = await screen.findByRole("article");
    await within(panel).findByText(/Recorded with consent/);
    const tabs = within(within(panel).getByRole("group", { name: "Evidence operations" })).getAllByRole("button");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Field Notes", "Action Lab"]);
    expect(tabs[0]).toHaveAttribute("aria-pressed", "true");
    expect(panel.textContent).not.toMatch(/poms|ingest/i);
    expect(within(panel).queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("distinguishes load and write failures from empty Spanish states", async () => {
    const api = makeApi({
      loadAdministrativeEvidence: vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ fieldNoteBlocks: [], packets: [], actions: [], history: [], hasNext: {} }),
      addFieldNoteEvidence: vi.fn().mockRejectedValue(new Error("write failed")),
    });
    renderPanel(api, "es");
    expect(await screen.findByRole("alert")).toHaveTextContent("Las operaciones de evidencia no están disponibles");
    fireEvent.click(screen.getByRole("button", { name: "Intentar de nuevo" }));
    expect(await screen.findByText("Aún no hay evidencia de Notas de campo.")).toBeInTheDocument();
    expect(screen.getByText("Aún no hay paquetes de evidencia.")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Entrevista" })).toHaveValue("interview");
    expect(screen.getByRole("option", { name: "Observación" })).toHaveValue("observation");
    const noteForm = screen.getByRole("button", { name: "Agregar evidencia de Notas de campo" }).closest("form");
    fireEvent.change(within(noteForm).getByLabelText("Título de la fuente"), { target: { value: "Entrevista nocturna" } });
    fireEvent.change(within(noteForm).getByLabelText("Procedencia de la fuente"), { target: { value: "Notas autorizadas" } });
    fireEvent.change(within(noteForm).getByLabelText("Clave del asunto"), { target: { value: "personal" } });
    fireEvent.change(within(noteForm).getByLabelText("Texto de evidencia"), { target: { value: "Dos vacantes." } });
    fireEvent.submit(noteForm);
    expect(await screen.findByRole("alert")).toHaveTextContent("La operación falló");
    fireEvent.click(screen.getByRole("button", { name: "Laboratorio de acciones" }));
    expect(screen.getByText("Aún no se han registrado acciones.")).toBeInTheDocument();
  });

  it("reports a committed write honestly when only the refresh fails", async () => {
    const api = makeApi({
      loadAdministrativeEvidence: vi.fn().mockResolvedValueOnce(DESK).mockRejectedValueOnce(new Error("refresh failed")),
    });
    renderPanel(api);
    const row = (await screen.findByText("staffing · Listening session")).closest(".xus-row");
    fireEvent.click(within(row).getByRole("button", { name: "Include" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved, but the refreshed view is unavailable"));
    expect(api.executeAdministrativeObjectAction).toHaveBeenCalledTimes(1);
  });

  it("localizes workflow state values in rows and audit history", async () => {
    renderPanel(makeApi(), "es");
    expect(await screen.findByText("Entrevista · Borrador")).toBeInTheDocument();
    expect(screen.getByText("safety · Listo para revisión")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Laboratorio de acciones" }));
    expect(await screen.findByText("Antes: Estado: Borrador")).toBeInTheDocument();
    expect(screen.getByText("Después: Estado: Listo para revisión")).toBeInTheDocument();
    expect(screen.getByText("Paquete de evidencia · Safety packet")).toBeInTheDocument();
  });

  // UX-UG-EVIDENCE-ACTION-LAB-SPEAKS-ENGINEER-20261125 (#9975, A-21
  // of #9529): the header, form and history read "reusable object actions",
  // "Target object", "Execute action", "Execution history", "Actor" and
  // "Executed". Fictional desk only.
  it.each([
    ["en", { tab: "Action Lab", sub: /apply actions to evidence, packets, cases, tasks and members\. Actions applied here are logged\./, action: "Action", target: "Applies to", note: "Note (optional)",
      button: "Apply action", history: "Action history", doneBy: /^Done by: /, recorded: /^Recorded: /,
      banned: /Target object|Execut|Reusable action|object actions|\bActor\b/ }],
    ["es", { tab: "Laboratorio de acciones", sub: /aplique acciones a evidencia, paquetes, casos, tareas y miembros\. Las acciones aplicadas aquí quedan registradas\./, action: "Acción", target: "Se aplica a", note: "Nota (opcional)",
      button: "Aplicar acción", history: "Historial de acciones", doneBy: /^Hecho por: /, recorded: /^Registrado: /,
      banned: /Objeto de destino|[Ee]jecu|Acción reutilizable|acciones reutilizables|Responsable/ }],
  ])("names the Action Lab form and history in plain words (%s)", async (lang, expected) => {
    const { container } = renderPanel(makeApi(), lang);
    expect(await screen.findByText(expected.sub)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: expected.tab }));
    expect(await screen.findByLabelText(expected.action)).toBeInTheDocument();
    expect(screen.getByLabelText(expected.target)).toBeInTheDocument();
    expect(screen.getByLabelText(expected.note)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: expected.button })).toBeInTheDocument();
    expect(screen.getByText(expected.history)).toBeInTheDocument();
    expect(screen.getAllByText(expected.doneBy).length).toBeGreaterThan(0);
    expect(screen.getAllByText(expected.recorded).length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(expected.banned);
  });

  // UX-UG-EVIDENCE-HISTORY-RAW-STAMPS-AND-JSON-STATES-20260920
  it("renders audit stamps, states, and target kinds as localized words, not machine text", async () => {
    const history = [
      { id: "run-case", actionKey: "case_record_review", targetKind: "member_case", targetId: "case-1", targetLabel: "UG-001", note: "", previousState: { status: "draft" }, resultingState: { status: "draft", reviewRecorded: true }, actorLabel: "Sam Admin", createdAt: "2026-08-30T12:30:00Z" },
      { id: "run-block", actionKey: "exclude", targetKind: "field_note_block", targetId: "block-1", targetLabel: "staffing · Listening session", note: "", previousState: { packetState: "included" }, resultingState: { packetState: "excluded", blocked: false }, actorLabel: "Sam Admin", createdAt: "2026-08-30T13:00:00Z" },
      { id: "run-unknown", actionKey: "future_action", targetKind: "future_kind", targetId: "x-1", targetLabel: "Later object", note: "", previousState: {}, resultingState: { status: "draft", detail: { reviewRecorded: null } }, actorLabel: "Sam Admin", createdAt: "2026-08-30T14:00:00Z" },
    ];
    renderPanel(makeApi({ loadAdministrativeEvidence: vi.fn().mockResolvedValue({ ...DESK, history }) }), "es");
    fireEvent.click(await screen.findByRole("button", { name: "Laboratorio de acciones" }));
    expect(await screen.findByText("Asunto de trabajador/a · UG-001")).toBeInTheDocument();
    expect(screen.getByText("Después: Estado: Borrador · Revisión registrada: Sí")).toBeInTheDocument();
    expect(screen.getByText("Antes: Estado del paquete: Incluido")).toBeInTheDocument();
    expect(screen.getByText("Después: Estado del paquete: Excluido · Bloqueado: No")).toBeInTheDocument();
    expect(screen.getByText("Después: Estado: Borrador · detail: Revisión registrada: Ninguno")).toBeInTheDocument();
    expect(screen.getByText("future_kind · Later object")).toBeInTheDocument();
    expect(screen.getByText("Antes: Ninguno")).toBeInTheDocument();
    expect(screen.getByText(`Registrado: ${stampText("es", "2026-08-30T12:30:00Z")}`)).toBeInTheDocument();
    for (const row of document.querySelectorAll(".xus-row")) {
      expect(row.textContent).not.toMatch(/[{}"]/);
      expect(row.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(row.textContent).not.toMatch(/\b(member_case|field_note_block)\b/);
    }
  });

  it("disables direct no-ops and removes ineligible Action Lab targets", async () => {
    const included = { ...DESK, fieldNoteBlocks: [{ ...DESK.fieldNoteBlocks[0], packetState: "included" }] };
    renderPanel(makeApi({ loadAdministrativeEvidence: vi.fn().mockResolvedValue(included) }));
    const noteRow = (await screen.findByText("staffing · Listening session")).closest(".xus-row");
    expect(within(noteRow).getByRole("button", { name: "Include" })).toBeDisabled();
    expect(within(noteRow).getByRole("button", { name: "Exclude" })).toBeEnabled();
    const reviewReady = screen.getByText("Safety packet").closest(".xus-row");
    expect(within(reviewReady).getByRole("button", { name: "Mark review ready" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Action Lab" }));
    const actionSelect = await screen.findByLabelText("Action");
    fireEvent.change(actionSelect, { target: { value: "include" } });
    expect(screen.queryByRole("option", { name: "staffing · Listening session" })).not.toBeInTheDocument();
    fireEvent.change(actionSelect, { target: { value: "exclude" } });
    expect(screen.getByRole("option", { name: "staffing · Listening session" })).toBeInTheDocument();
  });

  it("keeps focus and the workspace through a page change and a mutation", async () => {
    // Waits for a browser to move focus to body off a disabled control, then
    // proves the panel restores it, so the focus fixup stays on here.
    enableFocusFixup();
    const pageTwo = { ...DESK, fieldNoteBlocks: [{ ...DESK.fieldNoteBlocks[0], id: "block-3", sourceTitle: "Page two source" }], hasNext: { notes: false } };
    // Hold each response until its pending state has been checked. A fixed
    // 100 ms response can finish before a loaded worker observes aria-busy.
    const initialLoad = Promise.withResolvers();
    const nextPageLoad = Promise.withResolvers();
    const previousPageLoad = Promise.withResolvers();
    const mutation = Promise.withResolvers();
    const mutationRefresh = Promise.withResolvers();
    const api = makeApi({
      loadAdministrativeEvidence: vi.fn()
        .mockReturnValueOnce(initialLoad.promise)
        .mockReturnValueOnce(nextPageLoad.promise)
        .mockReturnValueOnce(previousPageLoad.promise)
        .mockReturnValueOnce(mutationRefresh.promise),
      executeAdministrativeObjectAction: vi.fn().mockReturnValue(mutation.promise),
    });
    renderPanel(api);
    // First mount with no desk yet: the loading sentence renders.
    expect(screen.getByText("Loading evidence operations…")).toBeInTheDocument();
    await waitFor(() => expect(api.loadAdministrativeEvidence).toHaveBeenCalledWith(0));
    await act(async () => initialLoad.resolve(DESK));
    const panel = await screen.findByRole("article");
    expect(await within(panel).findByText(/Recorded with consent/)).toBeInTheDocument();
    expect(screen.queryByText("Loading evidence operations…")).not.toBeInTheDocument();
    const workspace = document.querySelector(".xus-admin-evidence__workspace");

    fireEvent.click(within(panel).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.loadAdministrativeEvidence).toHaveBeenLastCalledWith(1), { timeout: 3000 });
    await waitFor(() => expect(workspace).toHaveAttribute("aria-busy", "true"));
    // The workspace stays mounted and readable; the loading sentence never replaces it.
    expect(workspace).toBeInTheDocument();
    expect(within(workspace).getByText("staffing · Listening session")).toBeInTheDocument();
    expect(screen.queryByText("Loading evidence operations…")).not.toBeInTheDocument();
    await act(async () => nextPageLoad.resolve(pageTwo));
    await waitFor(() => expect(workspace).toHaveAttribute("aria-busy", "false"), { timeout: 3000 });
    expect(within(panel).getAllByText("staffing · Page two source").length).toBeGreaterThan(0);

    fireEvent.click(within(panel).getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(api.loadAdministrativeEvidence).toHaveBeenLastCalledWith(0), { timeout: 3000 });
    expect(workspace).toHaveAttribute("aria-busy", "true");
    expect(within(workspace).getByText("staffing · Page two source")).toBeInTheDocument();
    await act(async () => previousPageLoad.resolve(DESK));
    await waitFor(() => expect(within(panel).getAllByText("staffing · Listening session").length).toBeGreaterThan(0), { timeout: 3000 });
    await waitFor(() => expect(workspace).toHaveAttribute("aria-busy", "false"), { timeout: 3000 });
    const includeButton = within(within(panel).getByText("staffing · Listening session").closest(".xus-row")).getByRole("button", { name: "Include" });
    includeButton.focus();
    fireEvent.click(includeButton);
    await waitFor(() => expect(api.executeAdministrativeObjectAction).toHaveBeenCalledWith({ targetKind: "field_note_block", targetId: "block-1", actionKey: "include" }));
    // The workspace is a pending region, not inert, and the
    // pressed button stays enabled, pending and focused through jsdom's timed
    // focus fixup, so focus never drops to the page.
    expect(workspace).not.toHaveAttribute("inert");
    expect(workspace).toHaveAttribute("aria-disabled", "true");
    expect(includeButton).toBeEnabled();
    expect(includeButton).toHaveAttribute("aria-disabled", "true");
    await act(async () => { await afterRenderingUpdate(); });
    expect(includeButton).toHaveFocus();
    fireEvent.click(includeButton);
    expect(api.executeAdministrativeObjectAction).toHaveBeenCalledTimes(1);
    await act(async () => mutation.resolve({ created: true }));
    expect(api.loadAdministrativeEvidence).toHaveBeenCalledTimes(4);
    expect(workspace).toHaveAttribute("aria-busy", "true");
    expect(workspace).toHaveAttribute("aria-disabled", "true");
    expect(includeButton).toHaveFocus();
    await act(async () => mutationRefresh.resolve(DESK));
    await waitFor(() => expect(workspace).toHaveAttribute("aria-busy", "false"), { timeout: 3000 });
    expect(workspace).not.toHaveAttribute("aria-disabled");
    expect(document.querySelector(".xus-admin-evidence__workspace")).toBe(workspace);
    expect(includeButton).toHaveFocus();
  });

  it("ignores superseded load responses", async () => {
    let resolveSlow;
    const slowResponse = new Promise((resolve) => { resolveSlow = resolve; });
    const slowApi = makeApi({
      loadAdministrativeEvidence: vi.fn().mockImplementation(() => slowResponse),
    });
    const fastApi = makeApi({
      loadAdministrativeEvidence: vi.fn().mockResolvedValue({ ...DESK, packets: [{ ...DESK.packets[0], title: "Fast packet" }] }),
    });
    const { rerender } = renderPanel(slowApi);
    await waitFor(() => expect(slowApi.loadAdministrativeEvidence).toHaveBeenCalledWith(0));
    rerender(<LanguageProvider lang="en"><AdministrativeEvidencePanel api={fastApi} /></LanguageProvider>);
    expect((await screen.findAllByText("Fast packet")).length).toBeGreaterThan(0);
    resolveSlow({ ...DESK, packets: [{ ...DESK.packets[0], title: "Slow packet" }] });
    await waitFor(() => {
      expect(screen.getAllByText("Fast packet").length).toBeGreaterThan(0);
      expect(screen.queryByText("Slow packet")).not.toBeInTheDocument();
    });
  });
});

// Every evidence write shares one lock and keeps its control
// focused and pending while it runs.
describe("administrative evidence panel while a write runs", () => {
  const rowButton = (title, name) => within(screen.getByText(title).closest(".xus-row")).getByRole("button", { name });

  it("sends one write when two rows' Include and Exclude are pressed in the same tick", async () => {
    const api = makeApi();
    renderPanel(api);
    await screen.findByText("staffing · Listening session");
    const include = rowButton("staffing · Listening session", "Include");
    const exclude = rowButton("Safety Review · Inspection log", "Exclude");
    await expectOneWriteFromOneTick(api.executeAdministrativeObjectAction, [() => fireEvent.click(include), () => fireEvent.click(exclude)]);
    await waitFor(() => expect(exclude).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(exclude);
    await waitFor(() => expect(api.executeAdministrativeObjectAction).toHaveBeenCalledTimes(2));
  });

  it("keeps Mark review ready focused and pending while the packet write runs", async () => {
    const api = makeApi();
    renderPanel(api);
    await screen.findByText("Staffing packet");
    const ready = within(screen.getByText("Staffing packet").closest(".xus-row")).getByRole("button", { name: "Mark review ready" });
    await expectHeldWriteFocus(api.executeAdministrativeObjectAction, ready);
    expect(api.executeAdministrativeObjectAction).toHaveBeenCalledOnce();
  });

  it("keeps Add Field Notes evidence focused while the evidence is saved, with Next pending", async () => {
    const api = makeApi();
    renderPanel(api);
    await screen.findByText("staffing · Listening session");
    const add = screen.getByRole("button", { name: "Add Field Notes evidence" });
    const noteForm = add.closest("form");
    for (const [label, value] of [["Source title", "Interview notes"], ["Source provenance", "Signed consent"], ["Issue key", "staffing"], ["Evidence text", "Night shift is short."]]) {
      fireEvent.change(within(noteForm).getByLabelText(label), { target: { value } });
    }
    await expectHeldWriteFocus(api.addFieldNoteEvidence, add, () => {
      fireEvent.click(add);
      const next = screen.getByRole("button", { name: "Next" });
      expect(next).toBeEnabled();
      expect(next).toHaveAttribute("aria-disabled", "true");
    });
    expect(api.addFieldNoteEvidence).toHaveBeenCalledOnce();
  });
});
