import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormFilingControls } from "../src/components/FormFilingControls.jsx";
import { catalogue } from "../src/lib/i18n.js";

// When the attachments could not be read, the filing
// surface says so plainly and holds signing; it never shows "no supporting
// files" (that would make the member sign an empty attachment list, refused
// as "changed since review"). A real empty list behaves as before.
const filingT = (lang) => (key) => catalogue[lang][`forms.filing.${key}`] || key;

function drawAndConsent(lang) {
  const canvas = screen.getByLabelText(catalogue[lang]["forms.filing.signature"]);
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 80, clientY: 40, pointerId: 1 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
  fireEvent.click(screen.getByRole("checkbox", { name: catalogue[lang]["forms.filing.consent"] }));
}

describe("form attachments that could not be loaded", () => {
  it.each(["en", "es"])("says so and holds signing while editing (%s)", (lang) => {
    const onSaveSignature = vi.fn();
    render(<FormFilingControls t={filingT(lang)} editable files={[]} filesUnavailable onSaveSignature={onSaveSignature} />);
    expect(screen.getByText(catalogue[lang]["forms.filing.filesUnavailableHold"])).toBeInTheDocument();
    expect(screen.queryByText(catalogue[lang]["forms.filing.noFiles"])).toBeNull();
    drawAndConsent(lang);
    const save = screen.getByRole("button", { name: catalogue[lang]["forms.filing.saveSignature"] });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSaveSignature).not.toHaveBeenCalled();
  });

  // The reason stays on screen while the hold
  // lasts, also once an upload put a row in the list, and the held Save
  // signature button points at it.
  it("keeps the reason on screen next to a listed file, and the held button points at it", () => {
    render(<FormFilingControls t={filingT("en")} editable files={[{ id: "file-new", filename: "new.pdf", sizeBytes: 3, confirmedAt: "now" }]} filesUnavailable onSaveSignature={vi.fn()} />);
    const note = screen.getByText(catalogue.en["forms.filing.filesUnavailableHold"]);
    expect(screen.getByText("new.pdf")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: catalogue.en["forms.filing.saveSignature"] });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("aria-describedby", note.id);
  });

  it("says so on an approved form, which has nothing to sign", () => {
    render(<FormFilingControls t={filingT("en")} approved files={[]} filesUnavailable />);
    expect(screen.getByText(catalogue.en["forms.filing.filesUnavailable"])).toBeInTheDocument();
    expect(screen.queryByText(catalogue.en["forms.filing.noFiles"])).toBeNull();
  });

  it("keeps a real empty list as before: no files, and signing allowed", () => {
    const onSaveSignature = vi.fn().mockResolvedValue({ signedAt: "now" });
    render(<FormFilingControls t={filingT("en")} editable files={[]} onSaveSignature={onSaveSignature} />);
    expect(screen.getByText(catalogue.en["forms.filing.noFiles"])).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    drawAndConsent("en");
    expect(screen.getByRole("button", { name: catalogue.en["forms.filing.saveSignature"] })).toBeEnabled();
  });
});
