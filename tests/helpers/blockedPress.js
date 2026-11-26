// #9468: proof that a button held with a reason (the real BusyButton from
// src/components/BusyControls.jsx) cannot run its action by Enter, Space, the
// form's implicit submit or a repeated press, and that each press announces
// the reason once, as a fresh alert.
import { fireEvent } from "@testing-library/react";
import { expect } from "vitest";

export function expectRefusedEveryWay(button, reason, acted) {
  const reasonNode = () => (button.getAttribute("aria-describedby") || "").split(" ")
    .map((id) => document.getElementById(id)).find((node) => node?.textContent === reason);
  expect(button).toBeEnabled();
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(reasonNode()).toBeTruthy();
  expect(reasonNode()).not.toHaveAttribute("role");
  const presses = [
    () => fireEvent.click(button),
    () => fireEvent.click(button),
    // A browser activates a button on Enter or Space unless keydown is cancelled.
    () => expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(false),
    () => expect(fireEvent.keyDown(button, { key: " " })).toBe(false),
  ];
  let last = null;
  for (const press of presses) {
    press();
    const node = reasonNode();
    expect(node).toHaveAttribute("role", "alert");
    expect(node).not.toBe(last);
    last = node;
  }
  // Implicit submission clicks the default button (refused above); a submit
  // with no submitter must still be refused by the form's own handler, both
  // through requestSubmit() (constraint validation first) and as a submit
  // event that reaches the handler directly.
  if (button.form) {
    button.form.requestSubmit();
    fireEvent.submit(button.form);
  }
  expect(acted()).toBe(false);
}
