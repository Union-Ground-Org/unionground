import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CasesView } from "../src/views/CasesView.jsx";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { TaskModal } from "../src/views/TaskModal.jsx";
import { FormFilingControls } from "../src/components/FormFilingControls.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { caseListOpenerName } from "./helpers/case-list-opener.js";

const files = ["agenda.pdf", "minutes.pdf"].map((filename, index) => ({ id: `tamarack-file-${index}`, filename, sizeBytes: 1024, scanCurrent: false, confirmedAt: "2026-11-08T12:00:00-05:00" }));
const caseRow = { id: "tamarack-case", reference: "TAM-1", title: "Tamarack agenda", status: "active", step: "Review", articles: "", updates: [], files };
const stale = () => Object.assign(new Error("stale"), { privateFileCode: "stale" });
beforeEach(() => { vi.spyOn(window, "open").mockImplementation(() => ({ location: "", opener: null, close: vi.fn() })); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); clearDeviceParityState(); });

describe.each(["en", "es"])("per-file action names in %s", (lang) => {
  const t = (key, vars) => translate(lang, key, vars);
  it("names the filing open, remove and re-check actions for two attachments", () => {
    const filingT = (key, vars) => t(`forms.filing.${key}`, vars);
    render(<FormFilingControls files={files} editable t={filingT} onOpenFile={vi.fn()} onRemoveFile={vi.fn()} onRecheckFile={vi.fn()} />);
    for (const file of files) {
      expect(screen.getByRole("button", { name: filingT("openFile", { name: file.filename }) })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: filingT("removeFile", { name: file.filename }) })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `${filingT("recheck")}: ${file.filename}` })).toBeInTheDocument();
    }
  });
  it("keeps signed read-only filing attachments identifiable for a safety re-check", () => {
    const filingT = (key, vars) => t(`forms.filing.${key}`, vars);
    render(<FormFilingControls files={files} signatureCurrent t={filingT} onRecheckFile={vi.fn()} />);
    expect(screen.getByText(filingT("signedReady"))).toBeInTheDocument();
    for (const file of files) expect(screen.getByRole("button", { name: `${filingT("recheck")}: ${file.filename}` })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Remove|Eliminar/ })).toBeNull();
  });
  it("names each case action and the exact stale file before rechecking", async () => {
    const onOpenCaseFile = vi.fn().mockRejectedValue(stale());
    render(<LanguageProvider lang={lang}><CasesView data={{ cases: [caseRow] }} onOpenCaseFile={onOpenCaseFile} onRemoveCaseFile={vi.fn()} onRecheckCaseFile={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Tamarack agenda/ }));
    const view = within(screen.getByRole("dialog"));
    for (const file of files) {
      expect(view.getByRole("button", { name: `${t("cases.removeDocument")}: ${file.filename}` })).toBeInTheDocument();
      fireEvent.click(view.getByRole("button", { name: `${t("cases.openDocument")}: ${file.filename}` }));
      expect(await view.findByRole("button", { name: `${t("uploads.recheck")}: ${file.filename}` })).toBeInTheDocument();
      expect(onOpenCaseFile).toHaveBeenLastCalledWith(file);
    }
  });
  it.each(["clean", "rejected", "offline"])("keeps file context during a filing re-check ending %s", async (outcome) => {
    let finish, rejectCheck;
    const onRecheckFile = vi.fn(() => new Promise((resolve, reject) => { finish = resolve; rejectCheck = reject; }));
    const filingT = (key, vars) => t(`forms.filing.${key}`, vars);
    render(<FormFilingControls files={files} t={filingT} onRecheckFile={onRecheckFile} />);
    fireEvent.click(screen.getByRole("button", { name: `${filingT("recheck")}: agenda.pdf` }));
    expect(screen.getByRole("button", { name: `${filingT("rechecking")}: agenda.pdf` })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: `${filingT("recheck")}: minutes.pdf` })).toHaveAttribute("aria-disabled", "true");
    expect(onRecheckFile).toHaveBeenCalledWith(files[0]);
    if (outcome === "clean") finish({ status: "clean" });
    else {
      rejectCheck(Object.assign(new Error("scanner"), { privateFileCode: outcome }));
      expect(await screen.findByRole("alert")).toHaveTextContent(filingT(outcome === "rejected" ? "rejected" : "openError"));
    }
    await waitFor(() => expect(screen.getByRole("button", { name: `${filingT("recheck")}: minutes.pdf` })).not.toHaveAttribute("aria-disabled"));
  });
  it("names each coordinator file action", async () => {
    const seed = structuredClone(fallbackData.coordinatorDesk);
    seed.cases = [{ ...seed.cases[0], id: "tamarack-case", title: "Tamarack agenda", memberName: "Alex Rivera", reference: "TAM-1", files }];
    const api = { loadDesk: vi.fn().mockResolvedValue(seed), loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }), openCaseFile: vi.fn().mockRejectedValue(stale()), removeCaseFile: vi.fn(), recheckCaseFile: vi.fn() };
    const { container } = render(<LanguageProvider lang={lang}><CoordinatorView data={{ member: { id: "tamarack-author", initials: "AR" } }} api={api} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: caseListOpenerName(seed.cases[0]) }));
    const view = within(container.querySelector(".gq-detail"));
    for (const file of files) {
      expect(view.getByRole("button", { name: `${t("cases.removeDocument")}: ${file.filename}` })).toBeInTheDocument();
      fireEvent.click(view.getByRole("button", { name: `${t("cases.openDocument")}: ${file.filename}` }));
      expect(await view.findByRole("button", { name: `${t("uploads.recheck")}: ${file.filename}` })).toBeInTheDocument();
    }
  });
  it("names the task re-check action for the file that needs it", async () => {
    const task = { ...fallbackData.tasks[0], id: "tamarack-task", title: "Tamarack agenda" };
    const onOpenFile = vi.fn().mockRejectedValue(stale());
    render(<LanguageProvider lang={lang}><TaskModal task={task} chapterId="tamarack" files={files} t={t} lang={lang} onClose={vi.fn()} onUpdate={vi.fn()} onOpenFile={onOpenFile} onRecheckFile={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Attachments|Archivos adjuntos|Adjuntos/ }));
    for (const file of files) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${file.filename}`) }));
      expect(await screen.findByRole("button", { name: `${t("uploads.recheck")}: ${file.filename}` })).toBeInTheDocument();
      await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(file));
    }
  });
});
