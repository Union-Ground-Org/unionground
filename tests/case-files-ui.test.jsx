import { confirmEvidenceUpload } from "./helpers/confirm-evidence-upload.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CasesView, buildCasePacket } from "../src/views/CasesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MemberApiError } from "../src/lib/memberApi.js";
import { catalogue } from "../src/lib/i18n.js";

const caseRow = {
  id: "case-1", reference: "GR-509", title: "Schedule grievance", type: "Scheduling",
  articles: "Article 8", status: "active", step: "Step 2", deadline: "Aug 20",
  // Unassigned, so the member's edit form is offered (#7980).
  deadlineValue: "2026-08-20", overdue: false,
  updates: [{ id: "u1", body: "Filed with HR", created_at: "2026-08-01T12:00:00Z" }],
  files: [{ id: "f1", filename: "schedule.pdf", mimeType: "application/pdf", sizeBytes: 4, createdAt: "2026-08-02T12:00:00Z" }],
};

// jsdom has no object URL implementation, and the vault now mints one for
// every open: the view receives bytes, not a link, so that a signed URL can
// never outlive a quarantine.
beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:case-file");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
// vi.restoreAllMocks() does not undo a direct `global.fetch =` assignment.
// Put the suite's own fetch back after every case, including a failed expect.
const originalFetch = global.fetch;

function restoreDirectFetch() {
  if (originalFetch === undefined) delete global.fetch;
  else global.fetch = originalFetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreDirectFetch();
});

const fileBytes = () => new Blob([new Uint8Array([9, 9, 9, 9])]);

function renderCases(overrides = {}) {
  const props = {
    data: { cases: [caseRow] },
    onCreateCase: vi.fn(), onUpdateCase: vi.fn(), onAddCaseUpdate: vi.fn(),
    onAddCaseFile: vi.fn().mockResolvedValue({}),
    onRemoveCaseFile: vi.fn().mockResolvedValue({}),
    onOpenCaseFile: vi.fn().mockResolvedValue(fileBytes()),
    onRecheckCaseFile: vi.fn().mockResolvedValue({ status: "clean" }),
    ...overrides,
  };
  render(<LanguageProvider lang="en"><CasesView {...props} /></LanguageProvider>);
  fireEvent.click(screen.getByRole("button", { name: /Schedule grievance/ }));
  return props;
}

describe("case document vault", () => {
  it("provides keyboard-native upload, open, remove and export controls", async () => {
    const props = renderCases();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Documents" })).toBeInTheDocument();
    expect(within(dialog).getByText(catalogue.en["caseNotes.memberDocumentsHelp"].slice(0, 40), { exact: false })).toBeInTheDocument();
    const upload = within(dialog).getByLabelText("Add a document");
    const file = new File(["note"], "note.txt", { type: "text/plain" });
    fireEvent.change(upload, { target: { files: [file] } });
    await confirmEvidenceUpload();
    await waitFor(() => expect(props.onAddCaseFile).toHaveBeenCalledWith("case-1", file, { onPhase: expect.any(Function) }));
    expect(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^Remove(?:: |$)/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Export packet" })).toBeInTheDocument();
  });

  it("keeps selection local until the named document is confirmed for this case", async () => {
    const props = renderCases();
    const file = new File(["Shift changed at noon"], "IMG_0082.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Add a document"), { target: { files: [file] } });
    const name = await screen.findByRole("textbox", { name: /file name|upload name/i });
    expect(props.onAddCaseFile).not.toHaveBeenCalled();
    await waitFor(() => expect(name).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.change(name, { target: { value: "Shift change evidence" } });
    await confirmEvidenceUpload();
    await waitFor(() => expect(props.onAddCaseFile).toHaveBeenCalledWith("case-1", expect.objectContaining({
      name: "Shift change evidence.txt", type: "text/plain", size: file.size,
    }), { onPhase: expect.any(Function) }));
  });

  it("builds a packet with metadata, chronological notes, manifest and attachment bytes", async () => {
    const packet = await buildCasePacket(caseRow, vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])));
    const files = unzipSync(packet);
    expect(Object.keys(files).sort()).toEqual(["case-summary.json", "documents/01-schedule.pdf"]);
    const summary = JSON.parse(strFromU8(files["case-summary.json"]));
    expect(summary).toMatchObject({ reference: "GR-509", deadline: "2026-08-20" });
    // A raw row may still carry a legacy step or articles field; the packet drops both.
    expect(summary).not.toHaveProperty("step");
    expect(summary).not.toHaveProperty("articles");
    expect(summary.notes).toEqual([{ body: "Filed with HR", occurredOn: null, createdAt: "2026-08-01T12:00:00Z" }]);
    expect(summary.documents).toEqual([{ filename: "schedule.pdf", mimeType: "application/pdf", sizeBytes: 4, createdAt: "2026-08-02T12:00:00Z" }]);
    expect([...files["documents/01-schedule.pdf"]]).toEqual([1, 2, 3, 4]);
  });

  // BUG-UG-CASE-NOTE-DATE-MISSING-FROM-EXPORTS-20261102: the date the
  // member gave a note leaves with the packet.
  it("carries each note's occurredOn into the packet", async () => {
    const dated = { ...caseRow, updates: [
      { id: "u1", body: "Called HR", occurred_on: "2026-07-30", created_at: "2026-08-01T12:00:00Z" },
      { id: "u2", body: "Older undated note", created_at: "2026-08-03T12:00:00Z" },
    ] };
    const summary = JSON.parse(strFromU8(unzipSync(await buildCasePacket(dated, vi.fn().mockResolvedValue(new Uint8Array([1]))))["case-summary.json"]));
    expect(summary.notes).toEqual([
      { body: "Called HR", occurredOn: "2026-07-30", createdAt: "2026-08-01T12:00:00Z" },
      { body: "Older undated note", occurredOn: null, createdAt: "2026-08-03T12:00:00Z" },
    ]);
  });

  it("saves status/deadline edits and swallows a rejected save so the form stays open", async () => {
    const onUpdateCase = vi.fn().mockRejectedValueOnce(new Error("nope")).mockResolvedValue({});
    renderCases({ onUpdateCase });
    const dialog = screen.getByRole("dialog");
    // Union Ground issues have no grievance step to edit.
    expect(within(dialog).queryByLabelText("Step")).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Status"), { target: { value: "resolved" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save issue" }));
    await waitFor(() => expect(onUpdateCase).toHaveBeenCalledWith("case-1", { status: "resolved", deadline: "2026-08-20" }));
    // A rejected save is toasted by mutate(); the dialog must not close or throw.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("locks the document picker while another case write is running", async () => {
    let finishSave;
    const onUpdateCase = vi.fn(() => new Promise((resolve) => { finishSave = resolve; }));
    const props = renderCases({ onUpdateCase });
    const dialog = screen.getByRole("dialog");
    const upload = within(dialog).getByLabelText("Add a document");
    expect(upload).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save issue" }));
    await waitFor(() => expect(onUpdateCase).toHaveBeenCalledTimes(1));
    // The upload panel takes the dialog's busy state as its host lock: no
    // document can be attached while the save is still in flight.
    await waitFor(() => expect(within(dialog).getByLabelText("Add a document")).toBeDisabled());
    fireEvent.change(within(dialog).getByLabelText("Add a document"), { target: { files: [new File(["note"], "note.txt", { type: "text/plain" })] } });
    expect(props.onAddCaseFile).not.toHaveBeenCalled();
    finishSave({});
    await waitFor(() => expect(within(dialog).getByLabelText("Add a document")).toBeEnabled());
  });

  it("adds a case note, resets the composer, and ignores a whitespace-only note", async () => {
    const onAddCaseUpdate = vi.fn().mockResolvedValue({});
    renderCases({ onAddCaseUpdate });
    const dialog = screen.getByRole("dialog");
    const textarea = within(dialog).getByPlaceholderText(catalogue.en["caseNotes.memberNotePlaceholder"]);
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add note" }));
    expect(onAddCaseUpdate).not.toHaveBeenCalled();
    fireEvent.change(textarea, { target: { value: "Filed the reply" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(onAddCaseUpdate).toHaveBeenCalledWith("case-1", "Filed the reply", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)));
    await waitFor(() => expect(textarea).toHaveValue(""));
  });

  it("opens a document in a new tab and surfaces an open failure inline", async () => {
    const firstPopup = { location: "", opener: window, close: vi.fn() };
    const secondPopup = { location: "", opener: window, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open")
      .mockReturnValueOnce(firstPopup)
      .mockReturnValueOnce(secondPopup);
    const onOpenCaseFile = vi.fn().mockResolvedValueOnce(fileBytes()).mockRejectedValueOnce(new Error("link expired"));
    renderCases({ onOpenCaseFile });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ }));
    // The tab is opened on the tap, before the bytes are awaited: iOS spends
    // the transient user activation on the first await.
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith("", "_blank"));
    await waitFor(() => expect(firstPopup.location).toBe("blob:case-file"));
    expect(firstPopup.opener).toBeNull();
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    // Second click hits the rejected mock and must surface the real message.
    fireEvent.click(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("link expired");
    expect(secondPopup.opener).toBeNull();
    expect(secondPopup.close).toHaveBeenCalledTimes(1);
  });

  it("shows a checking state while a verdict is pending and nothing is attached yet", async () => {
    let release;
    const onAddCaseFile = vi.fn((_id, _file, { onPhase }) => new Promise((resolve) => {
      onPhase("uploading");
      onPhase("checking");
      release = () => resolve({ id: "f2" });
    }));
    renderCases({ onAddCaseFile });
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Add a document"), {
      target: { files: [new File(["note"], "note.txt", { type: "text/plain" })] },
    });
    await confirmEvidenceUpload();
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Checking this file for safety");
    release();
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Attached"));
  });

  it("states a rejection permanently and offers no retry", async () => {
    const rejected = Object.assign(new Error("Attach case file: refused"), { privateFileCode: "rejected" });
    renderCases({ onAddCaseFile: vi.fn().mockRejectedValue(rejected) });
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Add a document"), {
      target: { files: [new File(["x"], "x.txt", { type: "text/plain" })] },
    });
    await confirmEvidenceUpload();
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("This file was rejected by the safety check and was not attached.");
    // A rejection is a decision about these bytes: no re-check is offered.
    expect(within(dialog).queryByRole("button", { name: /^Re\-check\ this\ file(?:: |$)/ })).toBeNull();
  });

  it("names the inspection ceiling instead of telling the member to just retry", async () => {
    const limited = Object.assign(new Error("Attach case file: too many"), { privateFileCode: "rate-limited" });
    renderCases({ onAddCaseFile: vi.fn().mockRejectedValue(limited) });
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Add a document"), {
      target: { files: [new File(["x"], "x.txt", { type: "text/plain" })] },
    });
    await confirmEvidenceUpload();
    expect(await within(dialog).findByRole("alert"))
      .toHaveTextContent("You have reached the hourly limit of 20 file checks.");
  });

  it("says plainly when this browser cannot convert a HEIC photo", async () => {
    const unsupported = Object.assign(new Error("nope"), { privateFileCode: "unsupported-format" });
    renderCases({ onAddCaseFile: vi.fn().mockRejectedValue(unsupported) });
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Add a document"), {
      target: { files: [new File(["x"], "photo.heic", { type: "image/heic" })] },
    });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Save it as JPEG or PNG");
  });

  it("removes a document from the vault", async () => {
    const onRemoveCaseFile = vi.fn().mockResolvedValue({ deleted: true });
    renderCases({ onRemoveCaseFile });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Remove(?:: |$)/ }));
    await waitFor(() => expect(onRemoveCaseFile).toHaveBeenCalledWith("case-1", caseRow.files[0]));
  });

  it("exports a packet from the authenticated bytes, with no intermediate fetch", async () => {
    global.fetch = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const props = renderCases();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Export packet" }));
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(props.onOpenCaseFile).toHaveBeenCalledWith(caseRow.files[0]);
    // The blob is read directly; there is no URL to re-fetch any more.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("surfaces a packet failure per file and never auto-re-inspects", async () => {
    const stale = Object.assign(new Error("stale"), { privateFileCode: "stale" });
    const props = renderCases({ onOpenCaseFile: vi.fn().mockRejectedValue(stale) });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Export packet" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Could not include schedule.pdf in the packet.");
    // One export over a large case would otherwise spend the whole hourly
    // inspection allowance in a single click.
    expect(props.onRecheckCaseFile).not.toHaveBeenCalled();
  });

  // BUG-UG-WEB-FILE-FAILURES-PAINT-DRIVER-TEXT-20260920: a MemberApiError
  // message is the API label plus the raw driver sentence (English, naming a
  // table), so the alert carries the catalogue sentence instead.
  it("shows catalogue copy for a driver-level attach refusal and never the raw error text", async () => {
    const refusal = new MemberApiError("Attach case file", { message: "permission denied for table member_case_files", code: "42501" });
    renderCases({ onAddCaseFile: vi.fn().mockRejectedValue(refusal) });
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Add a document"), {
      target: { files: [new File(["x"], "x.txt", { type: "text/plain" })] },
    });
    await confirmEvidenceUpload();
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("This file could not be attached right now.");
    expect(alert.textContent).not.toContain("permission denied");
    expect(alert.textContent).not.toContain("Attach case file:");
  });

  it("names the failed packet document without the underlying error text", async () => {
    const refusal = new MemberApiError("Open case file", { message: "canceling statement due to statement timeout" });
    renderCases({ onOpenCaseFile: vi.fn().mockRejectedValue(refusal) });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Export packet" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Could not include schedule.pdf in the packet.");
    expect(alert.textContent).not.toContain("statement timeout");
    expect(alert.textContent).not.toContain("Open case file:");
  });

  it("offers exactly one re-check when a clean verdict has aged out, then reopens", async () => {
    const popup = { location: "", opener: window, close: vi.fn() };
    const secondPopup = { location: "", opener: window, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValueOnce(popup).mockReturnValueOnce(secondPopup);
    const stale = Object.assign(new Error("stale"), { privateFileCode: "stale" });
    const onOpenCaseFile = vi.fn().mockRejectedValueOnce(stale).mockResolvedValueOnce(fileBytes());
    const props = renderCases({ onOpenCaseFile });
    const dialog = screen.getByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ }));
    expect(await within(dialog).findByRole("alert"))
      .toHaveTextContent("This file needs a fresh safety check before it can open.");
    expect(popup.close).toHaveBeenCalledTimes(1);

    const recheck = await within(dialog).findByRole("button", { name: /^Re\-check\ this\ file(?:: |$)/ });
    fireEvent.click(recheck);
    await waitFor(() => expect(props.onRecheckCaseFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: /^Re\-check\ this\ file(?:: |$)/ })).toBeNull());

    fireEvent.click(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ }));
    await waitFor(() => expect(secondPopup.location).toBe("blob:case-file"));
    expect(props.onRecheckCaseFile).toHaveBeenCalledTimes(1);
  });

  it("shows catalogue file-failure copy for an unmapped vault error and keeps view-authored copy", async () => {
    const popup = { location: "", opener: window, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup);
    const onOpenCaseFile = vi.fn().mockRejectedValue(new MemberApiError("Open case file", {
      message: "permission denied for table storage.objects",
    }));
    renderCases({ onOpenCaseFile });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(catalogue.en["cases.fileFailed"]);
    expect(alert.textContent).not.toMatch(/Open case file|permission denied|storage\.objects/);
  });

  it("shows catalogue packet-failure copy when the export itself is refused", async () => {
    URL.createObjectURL.mockImplementation(() => { throw new Error("blob quota exceeded"); });
    renderCases();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Export packet" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(catalogue.en["cases.packetFailed"]);
    expect(alert.textContent).not.toMatch(/blob quota exceeded/);
  });

  it("installs a direct fetch stub that must not survive this case", () => {
    const stub = vi.fn();
    global.fetch = stub;
    expect(global.fetch).toBe(stub);
  });

  it("does not observe a fetch stub left by the previous case", () => {
    expect(global.fetch).toBe(originalFetch);
  });

  it("renders the vault copy in Spanish", () => {
    render(<LanguageProvider lang="es"><CasesView data={{ cases: [caseRow] }} onCreateCase={vi.fn()} onUpdateCase={vi.fn()} onAddCaseUpdate={vi.fn()} onAddCaseFile={vi.fn()} onRemoveCaseFile={vi.fn()} onOpenCaseFile={vi.fn()} onRecheckCaseFile={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Schedule grievance/ }));
    expect(screen.getByRole("heading", { name: "Documentos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exportar expediente" })).toBeInTheDocument();
  });
});
