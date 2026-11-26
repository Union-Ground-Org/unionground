import { caseListOpenerName } from "./helpers/case-list-opener.js";
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileDialog } from "../src/components/Dialogs.jsx";
import { RewardsView } from "../src/views/RewardsView.jsx";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { ActionToast } from "../src/App.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

afterEach(cleanup);
const member = { firstName: "Example", fullName: "Example Member", initials: "EM", roleLine: "Member", sinceYear: 2026 };
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

// The app keeps the current locale until its requested catalogue chunk loads.
// A refusal can arrive during that pending read, before the provider changes.
function PendingLanguage({ chunk, children }) {
  const [lang, setLang] = useState("en");
  useEffect(() => {
    let current = true;
    chunk.then(() => { if (current) setLang("es"); });
    return () => { current = false; };
  }, [chunk]);
  return <LanguageProvider lang={lang}>{children}</LanguageProvider>;
}

describe("stored RPC refusals follow a completed language load", () => {
  it("retranslates a coordinator refusal while retaining a draft with no deadline or documents", async () => {
    const chunk = deferred();
    const desk = structuredClone(fallbackData.coordinatorDesk);
    desk.cases = [{ ...desk.cases[0], deadline: null, files: undefined }];
    const api = {
      loadDesk: vi.fn().mockResolvedValue(desk),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([]),
      openCaseFile: vi.fn(),
      updateCase: vi.fn().mockRejectedValue({ code: "57014", message: "private driver text" }),
    };
    const { container } = render(<PendingLanguage chunk={chunk.promise}><CoordinatorView data={{ member: { initials: "EM" } }} api={api} /></PendingLanguage>);
    fireEvent.click(await screen.findByRole("button", { name: caseListOpenerName(desk.cases[0]) }));
    const detail = within(container.querySelector(".gq-detail"));
    expect(detail.getByText(t("en", "cases.noDocuments"))).toBeInTheDocument();
    expect(detail.getByLabelText(t("en", "coordinator.factDeadline"))).toHaveValue("");
    fireEvent.change(detail.getByLabelText(t("en", "coordinator.changeReason")), { target: { value: "Retained draft" } });
    fireEvent.click(detail.getByRole("button", { name: t("en", "coordinator.saveChanges") }));
    expect(await detail.findByRole("alert")).toHaveTextContent(t("en", "error.serviceBusy"));
    await act(async () => { chunk.resolve(); });
    expect(detail.getByRole("alert")).toHaveTextContent(t("es", "error.serviceBusy"));
    expect(detail.getByRole("alert")).not.toHaveTextContent("private driver text");
    expect(detail.getByLabelText(t("es", "coordinator.changeReason"))).toHaveValue("Retained draft");
    expect(detail.getByRole("button", { name: t("es", "coordinator.saveChanges") })).toBeEnabled();
    expect(api.updateCase).toHaveBeenCalledOnce();
    expect(api.openCaseFile).not.toHaveBeenCalled();
  });

  it("keeps a literal shell notice intact across the language load", async () => {
    const chunk = deferred();
    const literal = "Example {remaining} notice.";
    render(<PendingLanguage chunk={chunk.promise}><ActionToast notice={literal} onDismiss={vi.fn()} /></PendingLanguage>);
    expect(screen.getByRole("status")).toHaveTextContent(literal);
    await act(async () => { chunk.resolve(); });
    expect(screen.getByRole("status")).toHaveTextContent(literal);
  });
  it("retranslates a stored shell refusal key after the pending chunk resolves", async () => {
    const chunk = deferred();
    render(<PendingLanguage chunk={chunk.promise}><ActionToast notice="error.serviceBusy" onDismiss={vi.fn()} /></PendingLanguage>);
    expect(screen.getByRole("status")).toHaveTextContent(t("en", "error.serviceBusy"));
    await act(async () => { chunk.resolve(); });
    expect(screen.getByRole("status")).toHaveTextContent(t("es", "error.serviceBusy"));
  });
  it.each([
    [{ message: "private driver text", code: "42501" }, "toast.saveFailed"],
    [{ details: " scan_code_used ", message: "private driver text" }, "rpcError.scan_code_used"],
    [{ code: "57014", message: "private driver text" }, "error.serviceBusy"],
    [{ name: "TimeoutError", message: "private driver text" }, "error.requestTimedOut"],
  ])("retranslates a profile refusal %j after the pending Spanish chunk resolves", async (error, key) => {
    const chunk = deferred();
    const onClose = vi.fn();
    render(<PendingLanguage chunk={chunk.promise}><ProfileDialog member={member} onClose={onClose} onSave={vi.fn().mockRejectedValue(error)} /></PendingLanguage>);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(t("en", "dialogs.roleLine")), { target: { value: "Retained draft" } });
    fireEvent.submit(within(dialog).getByRole("button", { name: t("en", "dialogs.saveProfile") }).closest("form"));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(t("en", key));
    await act(async () => { chunk.resolve(); });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(t("es", key));
    expect(within(dialog).getByRole("alert")).not.toHaveTextContent("private driver text");
    expect(within(dialog).getByLabelText(t("es", "dialogs.roleLine"))).toHaveValue("Retained draft");
    expect(onClose).not.toHaveBeenCalled();
  });

});
