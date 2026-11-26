import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormFilingControls } from "../src/components/FormFilingControls.jsx";
import { catalogue } from "../src/lib/i18n.js";

// While the attachments could not be read, Save
// signature is held twice: the button is disabled, and saveSignature() itself
// returns before any write (src/components/FormFilingControls.jsx). The
// disabled button is tested in tests/form-files-unavailable.test.jsx; this file
// pins the handler's own check, which is what still holds when a click reaches
// the handler (a click that lands in the same moment the hold arrives).
const filingT = (key) => catalogue.en[`forms.filing.${key}`] || key;

function drawAndConsent() {
  const canvas = screen.getByLabelText(catalogue.en["forms.filing.signature"]);
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 80, clientY: 40, pointerId: 1 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
  fireEvent.click(screen.getByRole("checkbox", { name: catalogue.en["forms.filing.consent"] }));
}

// The click handler the component passed for this button. A disabled button
// never reaches it, so the test calls it as a click on an enabled button would.
// Save signature is a BusyButton (record 8435), whose own click wrapper refuses
// while the button is held before the handler runs; the handler's check is what
// this file pins, so read the onClick prop BusyButton received (the button's
// fiber's parent), not the wrapper on the DOM node. A plain host button has no
// component parent and keeps its own prop. Asserted to be a function first, so
// a React upgrade that renames the private key fails here instead of skipping
// the check.
function reactOnClick(node) {
  const fiber = Object.entries(node).find(([key]) => key.startsWith("__reactFiber"))?.[1];
  expect(fiber).toBeTruthy();
  const owner = typeof fiber.return?.type === "function" ? fiber.return : fiber;
  const handler = owner.memoizedProps?.onClick;
  expect(handler).toBeTypeOf("function");
  return handler;
}

const saveButton = () => screen.getByRole("button", { name: catalogue.en["forms.filing.saveSignature"] });

describe("Save signature while the attachments could not be read", () => {
  it("writes nothing when the handler is reached during the hold", async () => {
    const onSaveSignature = vi.fn().mockResolvedValue({ signedAt: "now" });
    const props = { t: filingT, editable: true, files: [], onSaveSignature };
    const { rerender } = render(<FormFilingControls {...props} />);
    drawAndConsent();
    expect(saveButton()).toBeEnabled();

    rerender(<FormFilingControls {...props} filesUnavailable />);
    expect(saveButton()).toBeDisabled();
    await act(async () => { await reactOnClick(saveButton())(); });

    expect(onSaveSignature).not.toHaveBeenCalled();
    expect(screen.queryByText(catalogue.en["forms.filing.savingSignature"])).toBeNull();
    expect(screen.queryByText(catalogue.en["forms.filing.signatureSaved"])).toBeNull();
  });

  it("saves through the same handler once the hold is gone", async () => {
    const onSaveSignature = vi.fn().mockResolvedValue({ signedAt: "now" });
    const props = { t: filingT, editable: true, files: [], onSaveSignature };
    const { rerender } = render(<FormFilingControls {...props} filesUnavailable />);
    drawAndConsent();
    rerender(<FormFilingControls {...props} />);
    await act(async () => { await reactOnClick(saveButton())(); });

    expect(onSaveSignature).toHaveBeenCalledTimes(1);
    expect(onSaveSignature).toHaveBeenCalledWith(expect.any(Array), true, []);
  });
});
