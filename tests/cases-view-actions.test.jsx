import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { confirmEvidenceUpload } from "./helpers/confirm-evidence-upload.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CasesView } from "../src/views/CasesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MemberApiError } from "../src/lib/memberApi.js";
import { catalogue } from "../src/lib/i18n.js";

const item = {
  id: "case-1",
  reference: "GR-2026-1",
  title: "Schedule grievance",
  type: "Scheduling",
  articles: "Article 7",
  status: "active",
  step: "Investigation",
  deadline: "Aug 20, 2026",
  deadlineValue: "2026-08-20",
  overdue: false,
  // No steward or coordinator: the member's own unassigned case keeps its
  // edit form (an assigned one is read-only, tests/case-save-feedback.test.jsx).
  updates: [{ id: "u1", body: "Intake complete", created_at: "2026-08-01T12:00:00Z" }],
  files: [{ id: "f1", filename: "schedule.pdf", mimeType: "application/pdf", sizeBytes: 1200, createdAt: "2026-08-01T12:00:00Z" }],
};

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("CasesView member actions", () => {
  it("consumes a case URL deep link once instead of reopening it after refreshed data", async () => {
    const props = {
      onCreateCase: vi.fn(),
      onUpdateCase: vi.fn(),
      onAddCaseUpdate: vi.fn(),
      onAddCaseFile: vi.fn(),
      onRemoveCaseFile: vi.fn(),
      onOpenCaseFile: vi.fn(),
    };
    window.history.replaceState({}, "", "/m/cases?case=case-1");
    const { rerender } = render(<CasesView data={{ cases: [item] }} {...props} />);

    const opened = await screen.findByRole("dialog", { name: "Schedule grievance" });
    fireEvent.click(within(opened).getByRole("button", { name: "Close" }));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Schedule grievance" })).not.toBeInTheDocument());

    rerender(<CasesView data={{ cases: [{ ...item, updates: [...item.updates] }] }} {...props} />);

    expect(screen.queryByRole("dialog", { name: "Schedule grievance" })).not.toBeInTheDocument();
  });

  it("consumes a case URL deep link when fresh data first contains the case, then leaves a closed dialog closed", async () => {
    const props = {
      onCreateCase: vi.fn(),
      onUpdateCase: vi.fn(),
      onAddCaseUpdate: vi.fn(),
      onAddCaseFile: vi.fn(),
      onRemoveCaseFile: vi.fn(),
      onOpenCaseFile: vi.fn(),
    };
    window.history.replaceState({}, "", "/m/cases?case=case-1");
    const stale = { ...item, id: "case-0", reference: "GR-2026-0", title: "Older projection case" };
    const { rerender } = render(<CasesView data={{ cases: [stale] }} {...props} />);

    expect(screen.queryByRole("dialog", { name: "Schedule grievance" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("This issue is unavailable or you no longer have access.");

    rerender(<CasesView data={{ cases: [stale, item] }} {...props} />);
    const opened = await screen.findByRole("dialog", { name: "Schedule grievance" });
    expect(screen.queryByText("This issue is unavailable or you no longer have access.")).not.toBeInTheDocument();
    fireEvent.click(within(opened).getByRole("button", { name: "Close" }));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Schedule grievance" })).not.toBeInTheDocument());

    rerender(<CasesView data={{ cases: [stale, { ...item, updates: [...item.updates] }] }} {...props} />);

    expect(screen.queryByRole("dialog", { name: "Schedule grievance" })).not.toBeInTheDocument();
  });

  it("reopens the same case when search focus carries a new nonce", async () => {
    const props = {
      data: { cases: [item] },
      onCreateCase: vi.fn(),
      onUpdateCase: vi.fn(),
      onAddCaseUpdate: vi.fn(),
      onAddCaseFile: vi.fn(),
      onRemoveCaseFile: vi.fn(),
      onOpenCaseFile: vi.fn(),
    };
    const { rerender } = render(
      <CasesView {...props} focus={{ caseId: "case-1", nonce: 1 }} />,
    );

    const opened = await screen.findByRole("dialog", { name: "Schedule grievance" });
    fireEvent.click(within(opened).getByRole("button", { name: "Close" }));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Schedule grievance" })).not.toBeInTheDocument());

    rerender(<CasesView {...props} focus={{ caseId: "case-1", nonce: 2 }} />);

    expect(await screen.findByRole("dialog", { name: "Schedule grievance" })).toBeInTheDocument();
  });

  it("remounts case fields when focus switches from one selected case to another", async () => {
    const second = {
      ...item,
      id: "case-2",
      reference: "GR-2026-2",
      title: "Overtime grievance",
      status: "resolved",
      step: "Mediation",
      deadline: "Sep 15, 2026",
      deadlineValue: "2026-09-15",
      files: [],
      updates: [],
    };
    const props = {
      data: { cases: [item, second] },
      onCreateCase: vi.fn(),
      onUpdateCase: vi.fn(),
      onAddCaseUpdate: vi.fn(),
      onAddCaseFile: vi.fn(),
      onRemoveCaseFile: vi.fn(),
      onOpenCaseFile: vi.fn(),
    };
    const { rerender } = render(
      <CasesView {...props} focus={{ caseId: "case-1", nonce: 1 }} />,
    );
    await screen.findByRole("dialog", { name: "Schedule grievance" });

    rerender(<CasesView {...props} focus={{ caseId: "case-2", nonce: 2 }} />);

    const switched = await screen.findByRole("dialog", { name: "Overtime grievance" });
    expect(within(switched).getByLabelText("Status")).toHaveValue("resolved");
    expect(within(switched).queryByLabelText("Step")).not.toBeInTheDocument();
    expect(within(switched).getByLabelText("Deadline")).toHaveValue("2026-09-15");
  });

  it("keeps case intake unavailable until the member has a chapter", () => {
    const onCreateCase = vi.fn();
    const { rerender } = render(<CasesView
      data={{ member: { id: "member-1" }, cases: [] }}
      caseIntakeAvailable={false}
      onCreateCase={onCreateCase}
    />);

    expect(screen.getByRole("heading", { name: "You are not in a campaign yet" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ New" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start an issue" })).not.toBeInTheDocument();

    rerender(<CasesView
      data={{ member: { id: "member-1" }, cases: [] }}
      desktop
      caseIntakeAvailable={false}
      onCreateCase={onCreateCase}
    />);
    expect(screen.queryByRole("button", { name: "+ Start a new issue" })).not.toBeInTheDocument();
    expect(onCreateCase).not.toHaveBeenCalled();
  });

  it("creates a case and performs the complete case-detail workflow", async () => {
    const onCreateCase = vi.fn().mockResolvedValue({});
    const onUpdateCase = vi.fn().mockResolvedValue({});
    const onAddCaseUpdate = vi.fn().mockResolvedValue({});
    const onAddCaseFile = vi.fn().mockResolvedValue({});
    const onRemoveCaseFile = vi.fn().mockResolvedValue({});
    let openerWhenRequested;
    const popup = { location: "", opener: window, close: vi.fn() };
    const onOpenCaseFile = vi.fn().mockImplementation(() => {
      openerWhenRequested = popup.opener;
      return Promise.resolve(new Blob([new Uint8Array([1, 2, 3])]));
    });
    vi.spyOn(window, "open").mockImplementation(() => popup);
    // No intermediate fetch survives: the packet reads the same authenticated
    // blob the open button gets.
    vi.stubGlobal("fetch", vi.fn());
    const createUrl = vi.fn(() => "blob:case-file");
    const revokeUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeUrl });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<CasesView
      data={{ member: { id: "member-1" }, cases: [item] }}
      onCreateCase={onCreateCase}
      onUpdateCase={onUpdateCase}
      onAddCaseUpdate={onAddCaseUpdate}
      onAddCaseFile={onAddCaseFile}
      onRemoveCaseFile={onRemoveCaseFile}
      onOpenCaseFile={onOpenCaseFile}
    />);

    fireEvent.click(screen.getByRole("button", { name: "+ New" }));
    const intake = screen.getByRole("dialog", { name: "Start a new issue" });
    fireEvent.change(within(intake).getByLabelText("Title"), { target: { value: "Unsafe schedule" } });
    fireEvent.change(within(intake).getByLabelText("Issue type"), { target: { value: "Safety" } });
    fireEvent.change(within(intake).getByLabelText("Deadline"), { target: { value: "2026-08-30" } });
    // Union Ground has no contract yet: intake asks for no contract articles.
    expect(within(intake).queryByLabelText("Contract articles")).not.toBeInTheDocument();
    fireEvent.click(within(intake).getByRole("button", { name: "Create issue" }));
    await waitFor(() => expect(onCreateCase).toHaveBeenCalledWith({
      // The intake form also carries the case details now
      // (REQ-UG-STEWARD-CASEWORK-GAPS-20261030); left blank here.
      title: "Unsafe schedule", deadline: "2026-08-30", caseType: "Safety",
      description: "", incidentDate: "", remedySought: "", filingStatus: "",
    }));

    fireEvent.click(await screen.findByRole("button", { name: /Schedule grievance/ }));
    const dialog = screen.getByRole("dialog", { name: "Schedule grievance" });
    fireEvent.change(within(dialog).getByLabelText("Status"), { target: { value: "resolved" } });
    expect(within(dialog).queryByLabelText("Step")).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Deadline"), { target: { value: "2026-08-31" } });
    await expectHeldWriteFocus(onUpdateCase, within(dialog).getByRole("button", { name: "Save issue" }));
    await waitFor(() => expect(onUpdateCase).toHaveBeenCalledWith("case-1", {
      status: "resolved", deadline: "2026-08-31",
    }));

    fireEvent.change(within(dialog).getByPlaceholderText("Add an issue note…"), { target: { value: "Member contacted" } });
    // The case save holds the dialog busy until it settles.
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Add note" })).toBeEnabled());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Add note" })).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(onAddCaseUpdate).toHaveBeenCalledWith("case-1", "Member contacted", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)));

    const upload = within(dialog).getByLabelText("Add a document");
    const uploadFile = new File(["proof"], "proof.pdf", { type: "application/pdf" });
    await waitFor(() => expect(upload).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.change(upload, { target: { files: [uploadFile] } });
    await confirmEvidenceUpload();
    await waitFor(() => expect(onAddCaseFile).toHaveBeenCalledWith("case-1", uploadFile, { onPhase: expect.any(Function) }));
    // The request being observed does not mean the upload panel has released
    // the host busy lock. Wait for the same usable control a member sees.
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ })).toBeEnabled());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ })).not.toHaveAttribute("aria-disabled", "true"));

    fireEvent.click(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ }));
    // The placeholder tab opens synchronously on the click, before the signed
    // URL resolves, so Safari/iOS keeps the tap's transient user activation.
    await waitFor(() => expect(window.open).toHaveBeenCalledWith("", "_blank"));
    expect(openerWhenRequested).toBeNull();
    expect(popup.opener).toBeNull();
    await waitFor(() => expect(popup.location).toBe("blob:case-file"));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Remove(?:: |$)/ })).toBeEnabled());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Remove(?:: |$)/ })).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(within(dialog).getByRole("button", { name: /^Remove(?:: |$)/ }));
    await waitFor(() => expect(onRemoveCaseFile).toHaveBeenCalledWith("case-1", item.files[0]));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Export packet" })).toBeEnabled());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Export packet" })).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Export packet" }));
    await waitFor(() => expect(revokeUrl).toHaveBeenCalledWith("blob:case-file"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps rejected case and file writes retryable with a visible error", async () => {
    const onCreateCase = vi.fn().mockRejectedValue(new Error("denied"));
    const onAddCaseFile = vi.fn().mockRejectedValue(new Error("Upload unavailable"));
    render(<CasesView
      data={{ member: { id: "member-1" }, cases: [item] }}
      onCreateCase={onCreateCase}
      onUpdateCase={vi.fn()}
      onAddCaseUpdate={vi.fn()}
      onAddCaseFile={onAddCaseFile}
      onRemoveCaseFile={vi.fn()}
      onOpenCaseFile={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "+ New" }));
    const intake = screen.getByRole("dialog", { name: "Start a new issue" });
    fireEvent.change(within(intake).getByLabelText("Title"), { target: { value: "Unsafe schedule" } });
    fireEvent.click(within(intake).getByRole("button", { name: "Create issue" }));
    await waitFor(() => expect(onCreateCase).toHaveBeenCalled());
    expect(screen.getByRole("dialog", { name: "Start a new issue" })).toBeInTheDocument();
    fireEvent.click(within(intake).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.querySelector(".dialog-backdrop")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /Schedule grievance/ }));
    const detail = screen.getByRole("dialog", { name: "Schedule grievance" });
    const file = new File(["proof"], "proof.pdf", { type: "application/pdf" });
    fireEvent.change(within(detail).getByLabelText("Add a document"), { target: { files: [file] } });
    await confirmEvidenceUpload();
    expect(await within(detail).findByRole("alert")).toHaveTextContent("This file could not be attached right now.");
  });

  it("closes the placeholder tab and surfaces the inline error when the signed URL fails", async () => {
    const popup = { location: "", close: vi.fn() };
    vi.spyOn(window, "open").mockImplementation(() => popup);
    const onOpenCaseFile = vi.fn().mockRejectedValue(new Error("Signed URL expired"));
    render(<CasesView
      data={{ member: { id: "member-1" }, cases: [item] }}
      onCreateCase={vi.fn()}
      onUpdateCase={vi.fn()}
      onAddCaseUpdate={vi.fn()}
      onAddCaseFile={vi.fn()}
      onRemoveCaseFile={vi.fn()}
      onOpenCaseFile={onOpenCaseFile}
    />);

    fireEvent.click(screen.getByRole("button", { name: /Schedule grievance/ }));
    const detail = screen.getByRole("dialog", { name: "Schedule grievance" });
    fireEvent.click(within(detail).getByRole("button", { name: /^Open(?:: |$)/ }));

    expect(await within(detail).findByRole("alert")).toHaveTextContent("Signed URL expired");
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(popup.location).toBe("");
  });

  it("surfaces the inline error without calling the API when the browser blocks the popup", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const onOpenCaseFile = vi.fn().mockResolvedValue(new Blob(["%PDF"]));
    render(<CasesView
      data={{ member: { id: "member-1" }, cases: [item] }}
      onCreateCase={vi.fn()}
      onUpdateCase={vi.fn()}
      onAddCaseUpdate={vi.fn()}
      onAddCaseFile={vi.fn()}
      onRemoveCaseFile={vi.fn()}
      onOpenCaseFile={onOpenCaseFile}
    />);

    fireEvent.click(screen.getByRole("button", { name: /Schedule grievance/ }));
    const detail = screen.getByRole("dialog", { name: "Schedule grievance" });
    fireEvent.click(within(detail).getByRole("button", { name: /^Open(?:: |$)/ }));

    expect(await within(detail).findByRole("alert")).toHaveTextContent("Allow pop-ups for this site to open the document.");
    expect(onOpenCaseFile).not.toHaveBeenCalled();
  });

  it("shows catalogue retaliation-failure copy when submit or withdraw is refused", async () => {
    const onNotice = vi.fn();
    const submitError = new MemberApiError("Submit retaliation report", {
      message: "new row violates row-level security policy for table casework_retaliation_reports",
    });
    const withdrawError = new MemberApiError("Withdraw retaliation report", {
      message: "permission denied for table casework_retaliation_reports",
    });
    const api = {
      loadRetaliationReports: vi.fn().mockResolvedValue([
        { id: "report-1", management_person: "A Manager", adverse_action: "Schedule changed", status: "submitted" },
      ]),
      submitRetaliationReport: vi.fn().mockRejectedValue(submitError),
      withdrawRetaliationReport: vi.fn().mockRejectedValue(withdrawError),
    };
    render(
      <LanguageProvider lang="en">
        <CasesView
          data={{ member: { id: "member-1" }, cases: [item] }}
          caseworkApi={api}
          onNotice={onNotice}
          onCreateCase={vi.fn()}
          onUpdateCase={vi.fn()}
          onAddCaseUpdate={vi.fn()}
          onAddCaseFile={vi.fn()}
          onRemoveCaseFile={vi.fn()}
          onOpenCaseFile={vi.fn()}
        />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Schedule grievance/ }));
    const panel = (await screen.findByRole("heading", { name: "Report retaliation" })).closest("section");

    fireEvent.change(await within(panel).findByLabelText("Withdrawal reason"), { target: { value: "I want to revise the report" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(catalogue.en["cases.retaliation.failed"]));
    expect(onNotice.mock.calls.at(-1)[0]).not.toMatch(/Withdraw retaliation report|permission denied|casework_retaliation_reports/);

    fireEvent.change(within(panel).getByLabelText("Management person"), { target: { value: "A supervisor" } });
    fireEvent.change(within(panel).getByLabelText("Incident date and time"), { target: { value: "2026-08-13T10:30" } });
    fireEvent.change(within(panel).getByLabelText("Protected activity"), { target: { value: "Filed a grievance" } });
    fireEvent.change(within(panel).getByLabelText("Adverse action"), { target: { value: "Hours cut without notice" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(api.submitRetaliationReport).toHaveBeenCalled());
    expect(onNotice.mock.calls.at(-1)[0]).toBe(catalogue.en["cases.retaliation.failed"]);
    expect(onNotice.mock.calls.at(-1)[0]).not.toMatch(/Submit retaliation report|row-level security|casework_retaliation_reports/);
  });
});

// A11Y-UG-MODAL-SAVE-FAILURES-ANNOUNCED-20261013: the shell notice a
// refused write raises sits outside the open dialog, where modal isolation
// hides it, so each refusal is announced inside the dialog itself.
describe.each(["en", "es"])("CasesView modal save refusals (%s)", (lang) => {
  const tr = (key) => catalogue[lang][key];
  const refusal = () => new MemberApiError("Save", { message: "new row violates row-level security policy for table cases" });
  const isolated = (element) => element.closest("[inert], [aria-hidden='true']");

  function renderCases(props = {}) {
    render(
      <LanguageProvider lang={lang}>
        <p role="status" data-testid="shell-notice">{tr("toast.saveFailed")}</p>
        <CasesView
          data={{ member: { id: "member-1" }, cases: [item] }}
          onCreateCase={vi.fn()}
          onUpdateCase={vi.fn()}
          onAddCaseUpdate={vi.fn()}
          onAddCaseFile={vi.fn()}
          onRemoveCaseFile={vi.fn()}
          onOpenCaseFile={vi.fn()}
          {...props}
        />
      </LanguageProvider>,
    );
  }

  function expectAnnouncedInside(dialog, alert, text) {
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent(/row-level security/);
    expect(dialog.contains(alert)).toBe(true);
    expect(isolated(alert)).toBeNull();
    expect(isolated(screen.getByTestId("shell-notice"))).not.toBeNull();
  }

  it("case creation refusal announces inside the dialog and preserves the draft", async () => {
    const onCreateCase = vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce({});
    renderCases({ onCreateCase });
    fireEvent.click(screen.getByRole("button", { name: tr("mcases.new") }));
    const intake = screen.getByRole("dialog", { name: tr("cases.startNewCase") });
    fireEvent.change(within(intake).getByLabelText(tr("caseIntake.title")), { target: { value: "Unsafe schedule" } });
    fireEvent.click(within(intake).getByRole("button", { name: tr("cases.createCase") }));
    expectAnnouncedInside(intake, await within(intake).findByRole("alert"), tr("toast.saveFailed"));
    expect(within(intake).getByLabelText(tr("caseIntake.title"))).toHaveValue("Unsafe schedule");

    fireEvent.click(within(intake).getByRole("button", { name: tr("cases.createCase") }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: tr("cases.startNewCase") })).toBeNull());
    expect(onCreateCase).toHaveBeenCalledTimes(2);
  });

  it("case update refusal announces beside the case form, re-announces a repeat and clears on retry", async () => {
    const busyError = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const onUpdateCase = vi.fn().mockRejectedValueOnce(refusal()).mockRejectedValueOnce(busyError).mockResolvedValueOnce({});
    renderCases({ onUpdateCase });
    fireEvent.click(screen.getByRole("button", { name: /Schedule grievance/ }));
    const dialog = screen.getByRole("dialog", { name: "Schedule grievance" });
    const save = within(dialog).getByRole("button", { name: tr("cases.saveCase") });
    fireEvent.click(save);
    const first = await within(dialog).findByRole("alert");
    expectAnnouncedInside(dialog, first, tr("toast.saveFailed"));
    expect(save.closest("form").contains(first)).toBe(true);

    // A second refusal mounts a fresh alert, so a screen reader speaks it again.
    fireEvent.click(save);
    await waitFor(() => expect(onUpdateCase).toHaveBeenCalledTimes(2));
    const second = await within(dialog).findByRole("alert");
    expect(second).not.toBe(first);
    expectAnnouncedInside(dialog, second, tr("error.serviceBusy"));

    fireEvent.click(save);
    await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
    expect(onUpdateCase).toHaveBeenCalledTimes(3);
  });

  it("case note refusal announces beside the composer and retains unsaved text", async () => {
    const onAddCaseUpdate = vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce({});
    renderCases({ onAddCaseUpdate });
    fireEvent.click(screen.getByRole("button", { name: /Schedule grievance/ }));
    const dialog = screen.getByRole("dialog", { name: "Schedule grievance" });
    const note = within(dialog).getByPlaceholderText(tr("caseNotes.memberNotePlaceholder"));
    fireEvent.change(note, { target: { value: "Member contacted" } });
    fireEvent.click(within(dialog).getByRole("button", { name: tr("cases.addNote") }));
    const alert = await within(dialog).findByRole("alert");
    expectAnnouncedInside(dialog, alert, tr("toast.saveFailed"));
    expect(note.closest("form").contains(alert)).toBe(true);
    expect(note).toHaveValue("Member contacted");

    fireEvent.click(within(dialog).getByRole("button", { name: tr("cases.addNote") }));
    await waitFor(() => expect(onAddCaseUpdate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
    expect(onAddCaseUpdate).toHaveBeenLastCalledWith("case-1", "Member contacted", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it("retaliation submit and withdrawal refusals announce within the case dialog", async () => {
    const onNotice = vi.fn();
    const api = {
      loadRetaliationReports: vi.fn().mockResolvedValue([
        { id: "report-1", management_person: "A Manager", adverse_action: "Schedule changed", status: "submitted" },
      ]),
      submitRetaliationReport: vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce({}),
      withdrawRetaliationReport: vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce({}),
    };
    renderCases({ caseworkApi: api, onNotice });
    fireEvent.click(screen.getByRole("button", { name: /Schedule grievance/ }));
    const dialog = screen.getByRole("dialog", { name: "Schedule grievance" });
    const panel = (await within(dialog).findByRole("heading", { name: tr("cases.retaliation.title") })).closest("section");

    fireEvent.change(await within(panel).findByLabelText(tr("cases.retaliation.reason")), { target: { value: "I want to revise the report" } });
    fireEvent.click(within(panel).getByRole("button", { name: tr("cases.retaliation.withdraw") }));
    expectAnnouncedInside(dialog, await within(panel).findByRole("alert"), tr("cases.retaliation.failed"));
    expect(onNotice).toHaveBeenLastCalledWith(tr("cases.retaliation.failed"));

    fireEvent.click(within(panel).getByRole("button", { name: tr("cases.retaliation.withdraw") }));
    await waitFor(() => expect(within(panel).queryByRole("alert")).toBeNull());
    expect(await within(panel).findByText(tr("cases.retaliation.withdrawn"))).toHaveAttribute("role", "status");

    fireEvent.change(within(panel).getByLabelText(tr("cases.retaliation.person")), { target: { value: "A supervisor" } });
    fireEvent.change(within(panel).getByLabelText(tr("cases.retaliation.incident")), { target: { value: "2026-08-13T10:30" } });
    fireEvent.change(within(panel).getByLabelText(tr("cases.retaliation.activity")), { target: { value: "Filed a grievance" } });
    fireEvent.change(within(panel).getByLabelText(tr("cases.retaliation.action")), { target: { value: "Hours cut without notice" } });
    fireEvent.click(within(panel).getByRole("button", { name: tr("cases.retaliation.submit") }));
    expectAnnouncedInside(dialog, await within(panel).findByRole("alert"), tr("cases.retaliation.failed"));
    expect(within(panel).getByLabelText(tr("cases.retaliation.person"))).toHaveValue("A supervisor");

    fireEvent.click(within(panel).getByRole("button", { name: tr("cases.retaliation.submit") }));
    await waitFor(() => expect(within(panel).queryByRole("alert")).toBeNull());
    expect(await within(panel).findByText(tr("cases.retaliation.saved"))).toHaveAttribute("role", "status");
    expect(within(panel).getByLabelText(tr("cases.retaliation.person"))).toHaveValue("");
    expect(onNotice).toHaveBeenLastCalledWith(tr("cases.retaliation.saved"));
  });

  // A11Y-UG-SHOW-REFUSED-RETALIATION-REPORT-S-ERROR-NEXT-SUBMIT-20261013:
  // with a report listed, the old alert was the first child of the panel and
  // scrolled out of view above the form that was used. It now sits inside that
  // form, directly above its button, and only for the form that was refused.
  it("shows a refused retaliation write inside the form that was used, next to its button", async () => {
    const api = {
      loadRetaliationReports: vi.fn().mockResolvedValue([
        { id: "report-1", management_person: "A Manager", adverse_action: "Schedule changed", status: "submitted" },
      ]),
      submitRetaliationReport: vi.fn().mockRejectedValue(refusal()),
      withdrawRetaliationReport: vi.fn().mockRejectedValue(refusal()),
    };
    renderCases({ caseworkApi: api, onNotice: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /Schedule grievance/ }));
    const dialog = screen.getByRole("dialog", { name: "Schedule grievance" });
    const panel = (await within(dialog).findByRole("heading", { name: tr("cases.retaliation.title") })).closest("section");

    const submitButton = () => within(panel).getByRole("button", { name: tr("cases.retaliation.submit") });
    const withdrawButton = () => within(panel).getByRole("button", { name: tr("cases.retaliation.withdraw") });
    fireEvent.change(within(panel).getByLabelText(tr("cases.retaliation.person")), { target: { value: "A supervisor" } });
    fireEvent.change(within(panel).getByLabelText(tr("cases.retaliation.incident")), { target: { value: "2026-08-13T10:30" } });
    fireEvent.change(within(panel).getByLabelText(tr("cases.retaliation.activity")), { target: { value: "Filed a grievance" } });
    fireEvent.change(within(panel).getByLabelText(tr("cases.retaliation.action")), { target: { value: "Hours cut without notice" } });
    fireEvent.click(submitButton());
    const submitAlert = await within(panel).findByRole("alert");
    expect(submitAlert.closest("form")).toBe(submitButton().closest("form"));
    expect(submitAlert.nextElementSibling).toBe(submitButton());
    expect(within(panel).getAllByRole("alert")).toHaveLength(1);

    fireEvent.change(await within(panel).findByLabelText(tr("cases.retaliation.reason")), { target: { value: "I want to revise the report" } });
    fireEvent.click(withdrawButton());
    await waitFor(() => expect(withdrawButton().closest("form").querySelector('[role="alert"]')).not.toBeNull());
    const withdrawAlert = withdrawButton().closest("form").querySelector('[role="alert"]');
    expect(withdrawAlert.nextElementSibling).toBe(withdrawButton());
    expect(submitButton().closest("form").querySelector('[role="alert"]')).toBeNull();
    expect(within(panel).getAllByRole("alert")).toHaveLength(1);
  });
});
