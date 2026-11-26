import { act, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assistant } from "../src/components/FloatingControls.jsx";
import { boxFullyInside, useCompassDesktopFocus } from "../src/lib/compassCoveredFocus.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const originalRect = Element.prototype.getBoundingClientRect;
const originalMatchMedia = window.matchMedia;
const originalResizeObserver = globalThis.ResizeObserver;
const zero = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} };
const panelBox = { left: 1000, top: 0, right: 1440, bottom: 900, width: 440, height: 900, x: 1000, y: 0, toJSON() {} };
const coveredBox = { left: 1100, top: 80, right: 1300, bottom: 120, width: 200, height: 40, x: 1100, y: 80, toJSON() {} };
const partialBox = { left: 900, top: 80, right: 1100, bottom: 120, width: 200, height: 40, x: 900, y: 80, toJSON() {} };
const clearBox = { left: 20, top: 20, right: 80, bottom: 60, width: 60, height: 40, x: 20, y: 20, toJSON() {} };

let coveredMoves = true;

function installRects() {
  Element.prototype.getBoundingClientRect = function rect() {
    if (this.classList?.contains("assistant")) return panelBox;
    if (this.dataset.cover === "full" || this.dataset.cover === "held") return coveredBox;
    if (this.dataset.cover === "partial") return partialBox;
    if (this.dataset.cover === "clear") return clearBox;
    if (this.dataset.cover === "moves") return coveredMoves ? coveredBox : clearBox;
    if (this.dataset.cover === "trap") return document.activeElement === this ? coveredBox : clearBox;
    return zero;
  };
}

function stubMatchMedia(matches) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
}

function Panel({ active = true, disabled = false }) {
  const ref = useRef(null);
  useCompassDesktopFocus(ref, { active });
  return (
    <>
      <button type="button" data-cover="full">Search everything</button>
      <button type="button" data-cover="partial">Next</button>
      <button type="button" data-cover="clear">Home</button>
      <button type="button" data-cover="moves">Read summary</button>
      <button type="button" data-cover="held" ref={(node) => { if (node && !node.hasAttribute("inert")) node.setAttribute("inert", ""); }}>Held</button>
      <section ref={ref} className="assistant" tabIndex={-1}>
        <input className="guide2-input" aria-label="Ask" disabled={disabled || undefined} />
      </section>
    </>
  );
}

beforeEach(() => {
  coveredMoves = true;
  installRects();
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  window.matchMedia = originalMatchMedia;
  globalThis.ResizeObserver = originalResizeObserver;
});

describe("compass covered focus", () => {
  it("treats only a positive box that sits inside the cover as fully covered", () => {
    expect(boxFullyInside(coveredBox, panelBox)).toBe(true);
    expect(boxFullyInside(partialBox, panelBox)).toBe(false);
    expect(boxFullyInside(clearBox, panelBox)).toBe(false);
    expect(boxFullyInside(zero, panelBox)).toBe(false);
    expect(boxFullyInside(coveredBox, zero)).toBe(false);
    expect(boxFullyInside(null, panelBox)).toBe(false);
  });

  it("focuses the question box and drops only fully covered controls from the tab order", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Compass";
    document.body.append(opener);
    opener.focus();
    const view = render(<Panel />);
    const covered = document.querySelector("[data-cover='full']");
    const held = document.querySelector("[data-cover='held']");
    expect(covered).toHaveAttribute("inert");
    expect(document.querySelector("[data-cover='partial']")).not.toHaveAttribute("inert");
    expect(document.querySelector("[data-cover='clear']")).not.toHaveAttribute("inert");
    expect(screen.getByRole("textbox", { name: "Ask" })).toHaveFocus();
    expect(held).toHaveAttribute("inert");

    coveredMoves = false;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.querySelector("[data-cover='moves']")).not.toHaveAttribute("inert");

    view.unmount();
    expect(covered).not.toHaveAttribute("inert");
    expect(held).toHaveAttribute("inert");
    opener.remove();
  });

  it("focuses the panel when the question box is disabled and does nothing while inactive", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const inactive = render(<Panel active={false} />);
    expect(opener).toHaveFocus();
    expect(document.querySelector("[data-cover='full']")).not.toHaveAttribute("inert");
    inactive.unmount();

    globalThis.ResizeObserver = undefined;
    render(<Panel disabled />);
    expect(document.querySelector(".assistant")).toHaveFocus();
    opener.remove();
  });

  it("skips a covered control that receives focus and leaves a dialog above the panel alone", () => {
    const view = render(<Panel />);
    const covered = document.querySelector("[data-cover='full']");
    covered.removeAttribute("inert");
    covered.focus();
    expect(covered).toHaveAttribute("inert");
    expect(covered).not.toHaveFocus();
    expect(document.querySelector("[data-cover='partial']")).toHaveFocus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    const moves = document.querySelector("[data-cover='moves']");
    moves.removeAttribute("inert");
    moves.focus();
    expect(document.querySelector("[data-cover='clear']")).toHaveFocus();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const save = document.createElement("button");
    save.dataset.cover = "full";
    save.textContent = "Modal save";
    dialog.append(save);
    document.body.append(dialog);
    save.focus();
    expect(save).toHaveFocus();
    expect(save).not.toHaveAttribute("inert");
    dialog.remove();
    view.unmount();
  });

  it("inerts a covered control added after the panel opens", async () => {
    const view = render(<Panel />);
    const late = document.createElement("button");
    late.dataset.cover = "full";
    late.textContent = "Late";
    document.body.append(late);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(late).toHaveAttribute("inert");
    late.remove();
    view.unmount();
  });

  it("returns to the question box after the skip limit", () => {
    const traps = Array.from({ length: 81 }, (_, index) => {
      const button = document.createElement("button");
      button.dataset.cover = "trap";
      button.textContent = `Trap ${index}`;
      document.body.append(button);
      return button;
    });
    const view = render(<Panel />);
    traps[0].focus();
    expect(screen.getByRole("textbox", { name: "Ask" })).toHaveFocus();
    for (const button of traps) {
      expect(button).toHaveAttribute("inert");
      button.remove();
    }
    view.unmount();
  });
});

describe("desktop Compass panel focus", () => {
  it("moves focus into the question box and Shift+Tab order stays inside the panel first", async () => {
    stubMatchMedia(true);
    const opener = document.createElement("button");
    opener.setAttribute("aria-label", "Union Ground Guide");
    document.body.append(opener);
    opener.focus();
    const view = render(
      <LanguageProvider lang="en">
        <button type="button" data-cover="full">Search everything</button>
        <Assistant threads={[]} onSend={vi.fn()} onClose={vi.fn()} />
      </LanguageProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Union Ground Guide" });
    expect(dialog).not.toHaveAttribute("aria-modal");
    expect(screen.getByRole("textbox", { name: "Ask Union Ground Guide a question" })).toHaveFocus();
    expect(document.querySelector("[data-cover='full']")).toHaveAttribute("inert");

    const order = [...dialog.querySelectorAll("button, a[href], input, [tabindex='0']")];
    const at = (name) => order.findIndex((element) => element.getAttribute("aria-label") === name || element.classList.contains(name));
    const header = at("Open conversations");
    const conversation = at("assistant-chat");
    const suggestion = order.findIndex((element) => element.closest(".compass-starters"));
    const question = at("Ask Union Ground Guide a question");
    expect(header).toBeGreaterThanOrEqual(0);
    expect(conversation).toBeGreaterThan(header);
    expect(suggestion).toBeGreaterThan(conversation);
    expect(question).toBeGreaterThan(suggestion);

    view.unmount();
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });
});
