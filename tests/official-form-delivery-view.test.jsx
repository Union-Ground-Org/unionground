import { confirmEvidenceUpload } from "./helpers/confirm-evidence-upload.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";

const template = { key: "official_test", icon: "📄", titleKey: "Official test form", blurbKey: "Test form", version: 1, steps: [] };
const draft = {
  id: "form-1", templateKey: template.key, templateVersion: 1, status: "draft", step: 0,
  answers: {}, reviewNote: "", files: [], filerSignedAt: null, filerSignatureDigest: null,
};

function renderView({ lang = "en", forms = [draft], formTemplate = template, props = {} } = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <FormsView
        data={{ member: { initials: "MM" }, forms, formTemplates: [formTemplate], formTemplateVersions: [formTemplate], cosignRequests: [] }}
        demo
        desktop={props.desktop || false}
        onSaveDraft={props.onSaveDraft || vi.fn().mockResolvedValue("form-1")}
        onSubmit={props.onSubmit || vi.fn().mockResolvedValue({})}
        onSignForm={props.onSignForm || vi.fn().mockResolvedValue({ signedAt: "now" })}
        onAddFormFile={props.onAddFormFile || vi.fn()}
        onOpenFormFile={props.onOpenFormFile || vi.fn()}
        onRemoveFormFile={props.onRemoveFormFile || vi.fn()}
        onDownloadForm={props.onDownloadForm || vi.fn()}
        onShareForm={props.onShareForm || vi.fn()}
        canShareForm={props.canShareForm || (() => false)}
        onInviteCosigner={vi.fn()}
        onRespondCosign={vi.fn()}
        onWithdrawCosign={vi.fn()}
      />
    </LanguageProvider>,
  );
}

function drawAndConsent() {
  const canvas = screen.getByLabelText("Draw your signature");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 90, clientY: 40, pointerId: 1 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
  fireEvent.click(screen.getByRole("checkbox", { name: /intend this drawing/ }));
}

describe("official form member delivery", () => {
  it.each([
    ["en", "Returned", "0% complete"],
    ["es", "Devuelto", "0% completo"],
  ])("shows review feedback and the next field in place of returned-form progress (%s)", (lang, returned, progress) => {
    const formTemplate = {
      ...template,
      steps: [{ fields: [{ key: "detail", labelKey: "Fictional detail", required: true }] }],
    };
    const reviewNote = "Review the fictional detail.";
    renderView({
      lang,
      formTemplate,
      forms: [draft, { ...draft, id: "returned-form", status: "returned", reviewNote }],
    });
    const row = screen.getByText(`${returned} — Official test form`).closest(".mforms-draft");
    expect(row).toHaveTextContent(reviewNote);
    expect(row).toHaveTextContent("Fictional detail");
    expect(row).not.toHaveTextContent(progress);
    expect(screen.getByText(progress, { exact: false })).toBeVisible();
  });

  it("uses an h2 for the filing controls in the desktop page hierarchy", () => {
    renderView({ forms: [{ ...draft, status: "approved" }], props: { desktop: true } });
    expect(screen.getByRole("heading", { name: "Official filing copy", level: 2 })).toBeInTheDocument();
  });

  it("requires and saves a current filer signature before submit", async () => {
    const onSignForm = vi.fn().mockResolvedValue({ signedAt: "now" });
    const onSubmit = vi.fn().mockResolvedValue({});
    renderView({ props: { onSignForm, onSubmit } });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    expect(screen.getByRole("button", { name: "Submit for committee review" })).toBeDisabled();

    drawAndConsent();
    fireEvent.click(screen.getByRole("button", { name: "Save signature" }));
    await waitFor(() => expect(onSignForm).toHaveBeenCalledWith("form-1", expect.any(Array), true,
      { templateKey: template.key, answers: {}, dataVersion: null, attachmentIds: [] }));
    const submit = screen.getByRole("button", { name: "Submit for committee review" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("form-1", { templateKey: template.key, answers: {}, dataVersion: null, attachmentIds: [] }));
  });

  it("invalidates the locally saved signature after an attachment changes", async () => {
    const onSignForm = vi.fn().mockResolvedValue({ signedAt: "now" });
    const onAddFormFile = vi.fn().mockResolvedValue({ id: "file-2", filename: "proof.txt", sizeBytes: 1 });
    renderView({ props: { onSignForm, onAddFormFile } });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    drawAndConsent();
    fireEvent.click(screen.getByRole("button", { name: "Save signature" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit for committee review" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Attach supporting file"), { target: { files: [new File(["x"], "proof.txt", { type: "text/plain" })] } });
    await confirmEvidenceUpload();
    await waitFor(() => expect(onAddFormFile).toHaveBeenCalledWith("form-1", expect.any(File), { onPhase: expect.any(Function) }));
    expect(screen.getByRole("button", { name: "Submit for committee review" })).toBeDisabled();
    expect(screen.getByText(/save your signature again/i)).toBeInTheDocument();
  });

  it("shows bilingual approved download controls without claiming transmission", () => {
    renderView({ lang: "es", forms: [{ ...draft, status: "approved", filerSignedAt: "now", filerSignatureDigest: "sig", artifactDigest: "artifact", files: [] }] });
    expect(screen.getByText("Copia oficial de presentación")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Descargar copia de presentación" })).toBeInTheDocument();
    expect(screen.queryByText(/enviad[oa] al empleador/i)).toBeNull();
  });
});

// r3s2 (gate stage 138 on #8700): another session saved the form between the
// reviewed save and the signature. The database signs nothing and refuses; the
// parent re-reads the forms, and the editor shows the stored answers for a
// fresh review before the member signs again.
describe("a signature refused because the form changed since review", () => {
  const reviewTemplate = {
    key: "official_review", icon: "📄", titleKey: "Official review form", blurbKey: "Test form", version: 1,
    steps: [{ titleKey: "Details", fields: [{ key: "summary", type: "text", labelKey: "Summary", required: true, maxLength: 200 }] }],
  };
  const reviewed = { ...draft, templateKey: reviewTemplate.key, step: 1, answers: { summary: "Overtime skipped on Tuesday" } };
  const stored = { ...reviewed, answers: { summary: "Overtime skipped on Wednesday" } };
  const view = (lang, forms, handlers) => (
    <LanguageProvider lang={lang}>
      <FormsView
        data={{ member: { initials: "MM" }, forms, formTemplates: [reviewTemplate], formTemplateVersions: [reviewTemplate], cosignRequests: [] }}
        demo
        onSaveDraft={handlers.onSaveDraft}
        onSubmit={vi.fn()}
        onSignForm={handlers.onSignForm}
        onAddFormFile={vi.fn()}
        onOpenFormFile={vi.fn()}
        onRemoveFormFile={vi.fn()}
        onInviteCosigner={vi.fn()}
        onRespondCosign={vi.fn()}
        onWithdrawCosign={vi.fn()}
      />
    </LanguageProvider>
  );
  beforeEach(() => clearDeviceParityState());

  it.each([
    ["en", { resume: "Resume draft", consent: /intend this drawing/, save: "Save signature", submit: "Submit for committee review", alert: /changed somewhere else after you reviewed it, so it was not signed/ }],
    ["es", { resume: "Continuar borrador", consent: /Quiero que este dibujo sea mi firma/, save: "Guardar firma", submit: "Enviar para revisión del comité", alert: /se cambió en otro lugar después de que lo revisaste, así que no se firmó/ }],
  ])("shows the stored answers and signs nothing (%s)", async (lang, labels) => {
    const handlers = { onSaveDraft: vi.fn().mockResolvedValue("form-1"), onSignForm: vi.fn() };
    let rerender;
    handlers.onSignForm
      .mockImplementationOnce(async () => {
        // The parent re-reads the forms before the refusal reaches the editor.
        rerender(view(lang, [stored], handlers));
        throw Object.assign(new Error("form changed since review"), { code: "PT409", details: "form_changed_since_review" });
      })
      .mockResolvedValueOnce({ signedAt: "now" });
    ({ rerender } = render(view(lang, [reviewed], handlers)));
    fireEvent.click(screen.getByRole("button", { name: labels.resume }));
    expect(screen.getByText("Overtime skipped on Tuesday")).toBeInTheDocument();

    const canvas = screen.getByLabelText(lang === "en" ? "Draw your signature" : "Dibuja tu firma");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 90, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getByRole("checkbox", { name: labels.consent }));
    fireEvent.click(screen.getByRole("button", { name: labels.save }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(labels.alert));
    expect(handlers.onSignForm).toHaveBeenCalledWith("form-1", expect.any(Array), true,
      { templateKey: reviewTemplate.key, answers: { summary: "Overtime skipped on Tuesday" }, dataVersion: null, attachmentIds: [] });
    await waitFor(() => expect(screen.getByText("Overtime skipped on Wednesday")).toBeInTheDocument());
    expect(screen.queryByText("Overtime skipped on Tuesday")).toBeNull();
    expect(screen.getByRole("button", { name: labels.submit })).toBeDisabled();

    // Signing again names the stored answers the member now sees.
    fireEvent.click(screen.getByRole("button", { name: labels.save }));
    await waitFor(() => expect(handlers.onSignForm).toHaveBeenCalledTimes(2));
    expect(handlers.onSignForm.mock.calls[1][3].answers).toEqual({ summary: "Overtime skipped on Wednesday" });
    await waitFor(() => expect(screen.getByRole("button", { name: labels.submit })).toBeEnabled());
  });

  // #8704 round 1: the attachments shown, and so the manifest the signature
  // names, come from the parent's latest read of the form, not the snapshot
  // the editor opened with.
  const draw = () => {
    const canvas = screen.getByLabelText("Draw your signature");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 90, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getByRole("checkbox", { name: /intend this drawing/ }));
  };
  const letter = { id: "file-9", filename: "letter.pdf", sizeBytes: 3, scanCurrent: true };

  it("adopts an attachment another session confirmed when a signature is refused, and the next signature names it", async () => {
    const handlers = { onSaveDraft: vi.fn().mockResolvedValue("form-1"), onSignForm: vi.fn() };
    let rerender;
    handlers.onSignForm
      .mockImplementationOnce(async () => {
        rerender(view("en", [{ ...reviewed, files: [letter] }], handlers));
        throw Object.assign(new Error("form changed since review"), { code: "PT409", details: "form_changed_since_review" });
      })
      .mockResolvedValueOnce({ signedAt: "now" });
    ({ rerender } = render(view("en", [reviewed], handlers)));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    draw();
    fireEvent.click(screen.getByRole("button", { name: "Save signature" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/changed somewhere else/));
    expect(handlers.onSignForm.mock.calls[0][3].attachmentIds).toEqual([]);
    expect(await screen.findByText("letter.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save signature" }));
    await waitFor(() => expect(handlers.onSignForm).toHaveBeenCalledTimes(2));
    expect(handlers.onSignForm.mock.calls[1][3].attachmentIds).toEqual(["file-9"]);
  });

  it("keeps an attachment this tab confirmed through Back and Review, so the signature names it", async () => {
    const handlers = { onSaveDraft: vi.fn().mockResolvedValue("form-1"), onSignForm: vi.fn().mockResolvedValue({ signedAt: "now" }) };
    const { rerender } = render(view("en", [reviewed], handlers));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    // The parent's re-read after the upload carries the confirmed file.
    rerender(view("en", [{ ...reviewed, files: [letter] }], handlers));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Summary/ }), { target: { value: "Overtime skipped on Thursday" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("letter.pdf")).toBeInTheDocument();
    draw();
    fireEvent.click(screen.getByRole("button", { name: "Save signature" }));
    await waitFor(() => expect(handlers.onSignForm).toHaveBeenCalledTimes(1));
    expect(handlers.onSignForm.mock.calls[0][3]).toMatchObject({ answers: { summary: "Overtime skipped on Thursday" }, attachmentIds: ["file-9"] });
  });

  // #8704 round 1: form_not_editable is final. The rejected save leaves the
  // editor, nothing typed afterwards is sent, and Close reaches the list.
  it.each([
    ["en", "Close form", /already submitted somewhere else/],
    ["es", "Cerrar formulario", /ya se envió desde otro lugar/],
  ])("treats a save refused as no longer editable as final and closes without saving (%s)", async (lang, closeLabel, notice) => {
    const refused = Object.assign(new Error("form no longer editable"), { code: "PT409", details: "form_not_editable" });
    const handlers = { onSaveDraft: vi.fn().mockRejectedValue(refused), onSignForm: vi.fn() };
    render(view(lang, [reviewed], handlers));
    fireEvent.click(screen.getByRole("button", { name: lang === "en" ? "Resume draft" : "Continuar borrador" }));
    fireEvent.click(screen.getByRole("button", { name: lang === "en" ? "Back" : "Atrás" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(notice));
    expect(handlers.onSaveDraft).toHaveBeenCalledTimes(1);
    expect(handlers.onSaveDraft.mock.calls[0][0]).toMatchObject({ formId: "form-1" });
    // Typed after the refusal: kept on screen, never sent.
    fireEvent.change(screen.getByRole("textbox", { name: /Summary/ }), { target: { value: "Typed after the other tab submitted" } });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(closeLabel) }));
    await waitFor(() => expect(screen.queryByRole("button", { name: new RegExp(closeLabel) })).toBeNull());
    expect(handlers.onSaveDraft).toHaveBeenCalledTimes(1);
  });

  it("shows the co-signers' stored status after the re-read, not the opening snapshot", async () => {
    const alliance = { ...reviewTemplate, key: "alliance_grievance" };
    const opened = { ...reviewed, templateKey: "alliance_grievance", cosigners: [{ id: "cs-1", email: "pat@example.invalid", status: "invited" }] };
    const handlers = { onSaveDraft: vi.fn().mockResolvedValue("form-1"), onSignForm: vi.fn() };
    const allianceView = (forms) => (
      <LanguageProvider lang="en">
        <FormsView
          data={{ member: { initials: "MM" }, forms, formTemplates: [alliance], formTemplateVersions: [alliance], cosignRequests: [] }}
          demo
          onSaveDraft={handlers.onSaveDraft}
          onSubmit={vi.fn()}
          onSignForm={handlers.onSignForm}
          onAddFormFile={vi.fn()}
          onOpenFormFile={vi.fn()}
          onRemoveFormFile={vi.fn()}
          onInviteCosigner={vi.fn()}
          onRespondCosign={vi.fn()}
          onWithdrawCosign={vi.fn()}
        />
      </LanguageProvider>
    );
    const { rerender } = render(allianceView([opened]));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    expect(await screen.findByText("Invited")).toBeInTheDocument();
    rerender(allianceView([{ ...opened, cosigners: [{ id: "cs-1", email: "pat@example.invalid", status: "reaffirm_needed" }] }]));
    expect(await screen.findByText("Needs re-affirm")).toBeInTheDocument();
  });

  // #8705: Submit names what the member reviewed. When another session changed
  // or re-signed the form in between, nothing is filed: the stored content is
  // shown for review, a fresh signature is asked for, and nothing is retried.
  it.each([
    ["en", { resume: "Resume draft", submit: "Submit for committee review", alert: /changed somewhere else after you reviewed it, so it was not submitted/ }],
    ["es", { resume: "Continuar borrador", submit: "Enviar para revisión del comité", alert: /se cambió en otro lugar después de que lo revisaste, así que no se envió/ }],
  ])("refuses a submission the form changed under, shows the stored content and does not retry (%s)", async (lang, labels) => {
    const signedDraft = { ...reviewed, filerSignedAt: "2026-11-14T12:00:00Z", filerSignatureDigest: "digest-reviewed", files: [letter] };
    const replaced = { ...signedDraft, answers: { summary: "Replaced on the phone and signed there" }, filerSignatureDigest: "digest-replaced" };
    const handlers = { onSaveDraft: vi.fn().mockResolvedValue("form-1"), onSignForm: vi.fn(), onSubmit: vi.fn() };
    let rerender;
    handlers.onSubmit.mockImplementationOnce(async () => {
      rerender(submitView(lang, [replaced], handlers));
      throw Object.assign(new Error("form changed since review"), { code: "PT409", details: "form_changed_since_review" });
    });
    ({ rerender } = render(submitView(lang, [signedDraft], handlers)));
    fireEvent.click(screen.getByRole("button", { name: labels.resume }));
    const submit = await screen.findByRole("button", { name: labels.submit });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getAllByRole("alert").map((node) => node.textContent).join(" ")).toMatch(labels.alert));
    expect(handlers.onSubmit).toHaveBeenCalledTimes(1);
    expect(handlers.onSubmit).toHaveBeenCalledWith("form-1",
      { templateKey: reviewTemplate.key, answers: { summary: "Overtime skipped on Tuesday" }, dataVersion: null, attachmentIds: ["file-9"] });
    expect(await screen.findByText("Replaced on the phone and signed there")).toBeInTheDocument();
    expect(screen.queryByText("Overtime skipped on Tuesday")).toBeNull();
    // A fresh signature over the stored content is asked for; nothing resubmits.
    expect(screen.getByRole("button", { name: labels.submit })).toBeDisabled();
    expect(handlers.onSubmit).toHaveBeenCalledTimes(1);
  });

  function submitView(lang, forms, handlers) {
    return (
      <LanguageProvider lang={lang}>
        <FormsView
          data={{ member: { initials: "MM" }, forms, formTemplates: [reviewTemplate], formTemplateVersions: [reviewTemplate], cosignRequests: [] }}
          demo
          onSaveDraft={handlers.onSaveDraft}
          onSubmit={handlers.onSubmit}
          onSignForm={handlers.onSignForm}
          onAddFormFile={vi.fn()}
          onOpenFormFile={vi.fn()}
          onRemoveFormFile={vi.fn()}
          onInviteCosigner={vi.fn()}
          onRespondCosign={vi.fn()}
          onWithdrawCosign={vi.fn()}
        />
      </LanguageProvider>
    );
  }

  // #8719: an ordinary save names the write it was based on, by its revision
  // (#9092). When another
  // session saved since, nothing was written: the stored answers replace the
  // ones here, the rejected edit is not resent, and a fresh signature is asked.
  it.each([
    ["en", { resume: "Resume draft", back: "Back", next: "Next", submit: "Submit for committee review", alert: /changed somewhere else, so your latest change here was not saved/ }],
    ["es", { resume: "Continuar borrador", back: "Atrás", next: "Siguiente", submit: "Enviar para revisión del comité", alert: /se cambió en otro lugar, así que tu último cambio aquí no se guardó/ }],
  ])("shows the stored draft when a save is refused as based on older answers, and does not resend it (%s)", async (lang, labels) => {
    const signedDraft = { ...reviewed, revision: 2, filerSignedAt: "2026-11-14T12:00:00Z", filerSignatureDigest: "digest-1" };
    const newer = { ...signedDraft, revision: 3, answers: { summary: "Website added a witness" }, filerSignatureDigest: "digest-website" };
    const handlers = { onSaveDraft: vi.fn(), onSignForm: vi.fn(), onSubmit: vi.fn() };
    let rerender;
    // Back saves the unchanged answers; the save carrying the edit is refused.
    handlers.onSaveDraft.mockResolvedValueOnce({ formId: "form-1", revision: 2 }).mockImplementationOnce(async () => {
      rerender(submitView(lang, [newer], handlers));
      throw Object.assign(new Error("form changed elsewhere"), { code: "PT409", details: "form_saved_elsewhere" });
    }).mockResolvedValue({ formId: "form-1", revision: 4 });
    ({ rerender } = render(submitView(lang, [signedDraft], handlers)));
    fireEvent.click(screen.getByRole("button", { name: labels.resume }));
    fireEvent.click(screen.getByRole("button", { name: labels.back }));
    fireEvent.change(screen.getByRole("textbox", { name: /Summary/ }), { target: { value: "Phone edit" } });
    fireEvent.click(screen.getByRole("button", { name: labels.next }));
    await waitFor(() => expect(screen.getAllByRole("alert").map((node) => node.textContent).join(" ")).toMatch(labels.alert));
    expect(handlers.onSaveDraft).toHaveBeenCalledTimes(2);
    expect(handlers.onSaveDraft.mock.calls[1][0]).toMatchObject({ formId: "form-1", answers: { summary: "Phone edit" }, baseRevision: 2 });
    expect(await screen.findByText("Website added a witness")).toBeInTheDocument();
    expect(screen.queryByText("Phone edit")).toBeNull();
    expect(screen.getByRole("button", { name: labels.submit })).toBeDisabled();
    expect(handlers.onSaveDraft).toHaveBeenCalledTimes(2);
  });
});
