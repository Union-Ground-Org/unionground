import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BusyButton, BusyInput, BusySelect, BusyTextarea, BusyFieldset } from "../src/components/BusyControls.jsx";

afterEach(() => { cleanup(); window.history.replaceState({}, "", "/m"); });

it.each([
  [BusyButton, "button"], [BusyInput, "input"], [BusySelect, "select"],
  [BusyTextarea, "textarea"], [BusyFieldset, "fieldset"],
])("retains the owner marker on the forwarded %s host in disabled and pending states", (Control, tag) => {
  const { container, rerender } = render(<Control className="existing task-owned" disabled />);
  expect(container.firstElementChild.tagName.toLowerCase()).toBe(tag);
  expect(container.firstElementChild.className).toBe("existing task-owned");
  expect(container.firstElementChild.children).toHaveLength(0);
  rerender(<Control className="existing task-owned" pending />);
  expect(container.firstElementChild.tagName.toLowerCase()).toBe(tag);
  expect(container.firstElementChild.className).toBe("existing task-owned");
  expect(container.firstElementChild.children).toHaveLength(0);
});
