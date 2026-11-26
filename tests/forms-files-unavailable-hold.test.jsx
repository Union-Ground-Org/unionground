import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

// The editor holds Submit and
// signing while a stored draft's attachments could not be read
// (filesUnavailable, a review note (1)). Both of FormsView's conditions are pinned:
// canSubmit keeps the button disabled, and submit() refuses on its own when
// its handler is reached directly (a stale render or assistive technology).
const template = { key: "official_test", icon: "📄", titleKey: "Official test form", blurbKey: "Test form", version: 1, steps: [] };
const draft = {
  id: "form-1", templateKey: template.key, templateVersion: 1, status: "draft", step: 0,
  answers: {}, reviewNote: "", files: [], filesUnavailable: true, filerSignedAt: null, filerSignatureDigest: null,
};
// Signed in an earlier visit, so the signature is current and only the hold
// keeps Submit back: this is what pins canSubmit's own condition.
const signedDraft = { ...draft, filerSignedAt: "2026-11-15T09:00:00Z", filerSignatureDigest: "sha256:fixture-signature" };

function drawAndConsent() {
  const canvas = screen.getByLabelText("Draw your signature");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 90, clientY: 40, pointerId: 1 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
  fireEvent.click(screen.getByRole("checkbox", { name: /intend this drawing/ }));
}

// The handler the editor gave the button, called the way a click on an
// enabled button would call it; a disabled button never reaches it. Submit is
// a pending control (record 8435), so this is the onClick its BusyButton was
// given (the fiber's parent), not the wrapper on the DOM node. Asserted to be
// a function first), so a React upgrade that renames
// the private key fails here instead of skipping the check silently.
function reactOnClick(node) {
  const fiber = Object.entries(node).find(([key]) => key.startsWith("__reactFiber"))?.[1];
  expect(fiber).toBeTruthy();
  const owner = typeof fiber.return?.type === "function" ? fiber.return : fiber;
  const handler = owner.memoizedProps?.onClick;
  expect(handler).toBeTypeOf("function");
  return handler;
}

function renderEditor(form, onSubmit, onSignForm) {
  render(
    <LanguageProvider lang="en">
      <FormsView
        data={{ member: { initials: "MM" }, forms: [form], formTemplates: [template], formTemplateVersions: [template], cosignRequests: [] }}
        demo
        onSaveDraft={vi.fn().mockResolvedValue("form-1")} onSubmit={onSubmit} onSignForm={onSignForm}
        onAddFormFile={vi.fn()} onOpenFormFile={vi.fn()} onRemoveFormFile={vi.fn()} onDownloadForm={vi.fn()}
        onShareForm={vi.fn()} canShareForm={() => false} onInviteCosigner={vi.fn()} onRespondCosign={vi.fn()} onWithdrawCosign={vi.fn()}
      />
    </LanguageProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
}

describe("a stored draft whose attachments could not be loaded", () => {
  it("shows why, keeps Submit and Save signature held, and never signs or submits", async () => {
    const onSignForm = vi.fn().mockResolvedValue({ signedAt: "now" });
    const onSubmit = vi.fn().mockResolvedValue({});
    renderEditor(draft, onSubmit, onSignForm);
    const note = screen.getByText(catalogue.en["forms.filing.filesUnavailableHold"]);
    drawAndConsent();
    const save = screen.getByRole("button", { name: "Save signature" });
    const submit = screen.getByRole("button", { name: "Submit for committee review" });
    expect(save).toBeDisabled();
    expect(submit).toBeDisabled();
    // P3-3: both held buttons name their reason.
    expect(save).toHaveAttribute("aria-describedby", note.id);
    expect(submit).toHaveAttribute("aria-describedby", note.id);
    fireEvent.click(save);
    fireEvent.click(submit);
    // submit() refuses on its own, not only through the disabled button.
    await act(async () => { await reactOnClick(submit)(); });
    expect(onSignForm).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("holds Submit even with a signature saved before the read failed", async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    renderEditor(signedDraft, onSubmit, vi.fn());
    const note = screen.getByText(catalogue.en["forms.filing.filesUnavailableHold"]);
    const submit = screen.getByRole("button", { name: "Submit for committee review" });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-describedby", note.id);
    fireEvent.click(submit);
    await act(async () => { await reactOnClick(submit)(); });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// With its files available, Submit stays focusable as a pending
// control while the form is submitted, and the editor's Close reads pending
// with it (Submit and Close share the editor's lock).
describe("an editor submitting a signed draft", () => {
  it("keeps Submit focused while the form submits, with Close held", async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    renderEditor({ ...signedDraft, filesUnavailable: false }, onSubmit, vi.fn());
    const submit = screen.getByRole("button", { name: "Submit for committee review" });
    const close = screen.getByRole("button", { name: /Close/ });
    expect(submit).toBeEnabled();
    await expectHeldWriteFocus(onSubmit, submit, () => {
      fireEvent.click(submit);
      if (onSubmit.mock.calls.length === 1) {
        expect(close).toHaveAttribute("aria-disabled", "true");
        expect(close).toBeEnabled();
      }
    });
    expect(onSubmit).toHaveBeenCalledWith("form-1", expect.objectContaining({ templateKey: "official_test" }));
  });
});
