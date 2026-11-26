import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { MessageWorkflowPicker } from "../src/components/MessageWorkflowPicker.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MESSAGE_WORKFLOW_DEFAULT, MESSAGE_WORKFLOWS } from "../src/lib/messageWorkflow.js";

// The picker declares role="radiogroup" with three role="radio" options, which
// is a promise about the keyboard: one tab stop, and the arrows plus Home/End
// move focus and the checked state together. These pins are written against the
// two surfaces that bind the choice — the Settings picker (compact) and the
// first-run chooser (full) — because a keyboard contract that only holds in one
// form is the failure members actually hit.

const KEYS = MESSAGE_WORKFLOWS.map((workflow) => workflow.key);

function Harness({ compact = false, initial = MESSAGE_WORKFLOW_DEFAULT, onSelect = () => {} }) {
  const [value, setValue] = useState(initial);
  return (
    <LanguageProvider lang="en">
      <MessageWorkflowPicker
        compact={compact}
        value={value}
        onChange={(next) => { onSelect(next); setValue(next); }}
      />
    </LanguageProvider>
  );
}

function options() {
  return screen.getAllByRole("radio");
}

function checkedKey() {
  const checked = options().filter((option) => option.getAttribute("aria-checked") === "true");
  expect(checked).toHaveLength(1);
  return KEYS[options().indexOf(checked[0])];
}

function focusedKey() {
  return KEYS[options().indexOf(document.activeElement)];
}

function press(key) {
  fireEvent.keyDown(document.activeElement, { key });
}

function start(index, props = {}) {
  render(<Harness initial={KEYS[index]} {...props} />);
  options()[index].focus();
}

describe("MessageWorkflowPicker keyboard contract", () => {
  it("moves focus and the choice forward with ArrowDown and ArrowRight, wrapping past the last option", () => {
    start(0);
    press("ArrowDown");
    expect(focusedKey()).toBe(KEYS[1]);
    expect(checkedKey()).toBe(KEYS[1]);

    press("ArrowRight");
    expect(focusedKey()).toBe(KEYS[2]);
    expect(checkedKey()).toBe(KEYS[2]);

    press("ArrowDown");
    expect(focusedKey()).toBe(KEYS[0]);
    expect(checkedKey()).toBe(KEYS[0]);
  });

  it("moves focus and the choice backward with ArrowUp and ArrowLeft, wrapping past the first option", () => {
    start(0);
    press("ArrowUp");
    expect(focusedKey()).toBe(KEYS[2]);
    expect(checkedKey()).toBe(KEYS[2]);

    press("ArrowLeft");
    expect(focusedKey()).toBe(KEYS[1]);
    expect(checkedKey()).toBe(KEYS[1]);
  });

  it("sends Home to the first option and End to the last", () => {
    start(1);
    press("Home");
    expect(focusedKey()).toBe(KEYS[0]);
    expect(checkedKey()).toBe(KEYS[0]);

    press("End");
    expect(focusedKey()).toBe(KEYS[KEYS.length - 1]);
    expect(checkedKey()).toBe(KEYS[KEYS.length - 1]);
  });

  it("keeps the compact Settings picker on the same keyboard contract", () => {
    start(1, { compact: true });
    press("ArrowRight");
    expect(focusedKey()).toBe(KEYS[2]);
    expect(checkedKey()).toBe(KEYS[2]);

    press("Home");
    expect(focusedKey()).toBe(KEYS[0]);
    expect(checkedKey()).toBe(KEYS[0]);
  });

  it("reaches and selects every option with the keyboard alone and reports one checked option", () => {
    const onSelect = vi.fn();
    start(0, { onSelect });
    const reached = [focusedKey()];
    for (let step = 1; step < KEYS.length; step += 1) {
      press("ArrowDown");
      reached.push(focusedKey());
      expect(checkedKey()).toBe(focusedKey());
    }
    expect(reached).toEqual(KEYS);
    expect(onSelect.mock.calls.map(([key]) => key)).toEqual(KEYS.slice(1));
  });

  it("holds the group to a single tab stop on the checked option", () => {
    start(1);
    expect(options().map((option) => option.tabIndex)).toEqual([-1, 0, -1]);

    press("End");
    expect(options().map((option) => option.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("leaves pointer selection and unrelated keys alone", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(options()[2]);
    expect(onSelect).toHaveBeenCalledWith(KEYS[2]);
    expect(checkedKey()).toBe(KEYS[2]);

    options()[2].focus();
    const handled = fireEvent.keyDown(document.activeElement, { key: "a" });
    expect(handled).toBe(true);
    expect(checkedKey()).toBe(KEYS[2]);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
