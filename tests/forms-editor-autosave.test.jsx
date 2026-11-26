import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

// L04 — the form editor keeps the answers it will SEND in a ref (answersRef),
// because the debounced autosave and the pre-submit flush both need the latest
// values without a stale closure. That ref used to be written from INSIDE the
// setAnswers updater, which makes the updater impure. Both of the ways this app
// renders punish that: main.jsx wraps the tree in StrictMode (updaters are
// double-invoked) and App switches planes inside a useTransition (renders can
// be discarded) — so the ref could end up holding answers from a render the
// member never saw, and that is exactly what gets persisted.

function renderEditor(onSaveDraft) {
  return render(
    <StrictMode>
      <LanguageProvider lang="en">
        <FormsView
          data={{ member: { initials: "MV" }, forms: [] }}
          onProfile={vi.fn()}
          onAssistant={vi.fn()}
          onSaveDraft={onSaveDraft}
          onSubmit={vi.fn().mockResolvedValue(null)}
          onInviteCosigner={vi.fn()}
          onRespondCosign={vi.fn()}
          onWithdrawCosign={vi.fn()}
        />
      </LanguageProvider>
    </StrictMode>,
  );
}

describe("form editor autosave payload", () => {
  it("resumes the matching saved draft when its template-grid tile is opened", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue("form-saved");
    render(
      <LanguageProvider lang="en">
        <FormsView
          data={{
            member: { initials: "MV" },
            forms: [{
              id: "form-saved",
              templateKey: "grievance",
              status: "draft",
              step: 0,
              answers: { summary: "Saved grievance details", articles: "Article 12" },
              cosigners: [],
            }],
          }}
          onSaveDraft={onSaveDraft}
          onSubmit={vi.fn().mockResolvedValue(null)}
        />
      </LanguageProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Workplace issue reportReport a workplace problem and the remedy you want\./ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled());
    expect(onSaveDraft.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({
      templateKey: "grievance",
      answers: expect.objectContaining({
        summary: "Saved grievance details",
        articles: "Article 12",
      }),
    }));
  });

  it("refuses a blank deep-link editor when the focused row may be outside a truncated list", () => {
    render(
      <LanguageProvider lang="en">
        <FormsView
          data={{ member: { initials: "MV" }, forms: [], formsTruncated: true }}
          focus={{ templateKey: "grievance", formId: "form-not-loaded" }}
          onSaveDraft={vi.fn()}
          onSubmit={vi.fn()}
        />
      </LanguageProvider>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("cannot be opened safely");
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("opens a fresh grid editor when a truncated list contains only an approved form", () => {
    render(
      <LanguageProvider lang="en">
        <FormsView
          data={{
            member: { initials: "MV" },
            formsTruncated: true,
            forms: [{
              id: "approved-service-request",
              templateKey: "service_request",
              status: "approved",
              step: 1,
              answers: { request: "Old completed request" },
              cosigners: [],
            }],
          }}
          onSaveDraft={vi.fn()}
          onSubmit={vi.fn()}
        />
      </LanguageProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Workplace issue reportReport a workplace problem and the remedy you want\./ }));

    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps accepted co-signer consent in front of template-grid resume", () => {
    render(
      <LanguageProvider lang="en">
        <FormsView
          data={{
            member: { initials: "MV" },
            forms: [{
              id: "alliance-saved",
              templateKey: "alliance_grievance",
              status: "draft",
              step: 0,
              answers: { summary: "Saved group grievance" },
              cosigners: [{ id: "cosigner-1", status: "accepted" }],
            }],
          }}
          onSaveDraft={vi.fn()}
          onSubmit={vi.fn()}
        />
      </LanguageProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Group workplace issueRaise an issue that affects a group of coworkers\./ }));
    // The warning title is catalogue copy the wave-2 copy pass may reword, so
    // the test reads it from the catalogue rather than pinning today's words.
    expect(catalogue.en["forms.cosign.editWarnTitle"]).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(catalogue.en["forms.cosign.editWarnTitle"]);
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  // A resumed service request: one step, two required answers, already signed.
  // That is the shortest real path to an enabled Submit button.
  const signedServiceRequest = (step) => ({
    id: "form-service",
    templateKey: "service_request",
    status: "draft",
    step,
    answers: { category: "benefits", description: "Original description" },
    filerSignatureDigest: "digest-abc",
    cosigners: [],
  });

  function renderResumed(form, handlers) {
    return render(
      <LanguageProvider lang="en">
        <FormsView
          data={{ member: { initials: "MV" }, forms: [form] }}
          onSaveDraft={handlers.onSaveDraft}
          onSubmit={handlers.onSubmit || vi.fn().mockResolvedValue(null)}
        />
      </LanguageProvider>,
    );
  }

  it("flushes the pending autosave when the editor closes inside the debounce", async () => {
    // close() cleared the 1.2s debounce timer and returned to the hub without
    // ever firing it, so a correction typed and then closed within 1.2s was
    // never sent anywhere — no save, no error, and the old answers still on
    // the server.
    const onSaveDraft = vi.fn().mockResolvedValue("form-service");
    renderResumed(signedServiceRequest(0), { onSaveDraft });

    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "Corrected description" } });
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));

    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled());
    expect(onSaveDraft.mock.calls.at(-1)[0].answers.description).toBe("Corrected description");
  });

  it("keeps the editor open and says so when the pre-submit save fails", async () => {
    // submit() awaits persist() to flush the latest answers and capture an id,
    // but persist swallowed every failure. The editor then filed the PREVIOUS
    // saved id and closed, and submit_form validates the stored row, not the
    // editor — so the member was told the corrected form was filed while the
    // stale one went to the steward.
    const onSaveDraft = vi.fn().mockRejectedValue(new Error("save_form_draft failed"));
    const onSubmit = vi.fn().mockResolvedValue(null);
    renderResumed(signedServiceRequest(5), { onSaveDraft, onSubmit });

    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    const submitButton = screen.getByRole("button", { name: "Submit for committee review" });
    expect(submitButton).toBeEnabled();
    fireEvent.click(submitButton);

    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled());
    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getAllByRole("alert").map((node) => node.textContent).join(" ")).toMatch(/was not submitted/),
    );
    expect(screen.getByRole("button", { name: "Submit for committee review" })).toBeInTheDocument();
  });

  it("does not file when the pre-submit save was only queued offline", async () => {
    // mutate() puts an offline-shaped save_form_draft failure in the outbox and
    // resolves null. That is queued, not committed: filing now would send the
    // stored row, which still holds the previous answers.
    const onSaveDraft = vi.fn().mockResolvedValue(null);
    const onSubmit = vi.fn().mockResolvedValue(null);
    renderResumed(signedServiceRequest(5), { onSaveDraft, onSubmit });

    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit for committee review" }));

    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getAllByRole("alert").map((node) => node.textContent).join(" ")).toMatch(/was not submitted/),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });


  it("persists every answer typed on the step, under StrictMode", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue("form-x");
    renderEditor(onSaveDraft);

    fireEvent.click(screen.getAllByRole("button", { name: /Workplace issue report/ })[0]);
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "Mandated overtime" } });
    fireEvent.change(screen.getByLabelText(/Date of incident/), { target: { value: "2026-07-14" } });
    // Union Ground issues come before any contract: the report asks for no article.
    expect(screen.queryByLabelText(/Article\(s\) cited/)).not.toBeInTheDocument();

    // Advancing a step flushes synchronously (goToStep -> persist), so this
    // does not depend on the 1.2s autosave debounce.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled());
    const sent = onSaveDraft.mock.calls.at(-1)[0];
    expect(sent.templateKey).toBe("grievance");
    expect(sent.answers.summary).toBe("Mandated overtime");
    expect(sent.answers.incident_date).toBe("2026-07-14");
    expect(sent.answers).not.toHaveProperty("articles");
  });

  // Honest about being a source pin rather than behavioural proof: the failure
  // this guards needs a DISCARDED render to reproduce, which a unit test cannot
  // schedule. What it can do is keep the ref write out of the updater, which is
  // the property that makes the discarded render harmless.
  it("computes the next answers outside the updater, the way goToStep already does", () => {
    const src = readFileSync(resolve(process.cwd(), "src/views/FormsView.jsx"), "utf8");
    const updateAnswer = src.slice(src.indexOf("function updateAnswer"), src.indexOf("function goToStep"));
    // One field or a profile autofill's several fields at once
    // (REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030) share one writer.
    expect(updateAnswer).toContain("updateAnswers({ [key]: value });");
    expect(updateAnswer).toContain("const next = { ...answersRef.current, ...patch };");
    expect(updateAnswer).toContain("answersRef.current = next;");
    expect(updateAnswer).toContain("setAnswers(next);");
    expect(
      updateAnswer,
      "setAnswers must not take an updater here — an updater is what made the answersRef write impure",
    ).not.toMatch(/setAnswers\(\s*\(/);
  });
});
