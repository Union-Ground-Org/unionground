import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { glowFrame, initRowHighlight, rowForTarget } from "../src/lib/rowHighlight.js";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function harness({ hover = true, motion = false } = {}) {
  const makeMedia = (matches) => {
    const listeners = new Set();
    return {
      matches, listeners,
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
      change(value) { this.matches = value; listeners.forEach((fn) => fn()); },
    };
  };
  const pointer = makeMedia(hover);
  const reduced = makeMedia(motion);
  vi.stubGlobal("matchMedia", (query) => query.includes("hover") ? pointer : reduced);
  document.body.innerHTML = '<ul class="home-rows"><li><button>First</button></li><li><button>Second</button></li></ul><button id="outside">Outside</button>';
  const list = document.querySelector("ul");
  const rows = [...list.children];
  const buttons = rows.map((row) => row.querySelector("button"));
  list.getBoundingClientRect = () => ({ top: 100, height: 124 });
  Object.defineProperties(list, { clientTop: { value: 2 }, offsetHeight: { value: 124 } });
  list.scrollTop = 30;
  rows[0].getBoundingClientRect = () => ({ top: 72, height: 60 });
  rows[1].getBoundingClientRect = () => ({ top: 132, height: 60 });
  cleanup = initRowHighlight();
  return { list, rows, buttons, pointer, reduced };
}

describe("recovered sliding row highlight", () => {
  it("keeps nested targets attached to their direct row and accounts for list scrolling and borders", () => {
    const { list, rows, buttons } = harness();
    expect(rowForTarget(list, buttons[1])).toBe(rows[1]);
    expect(rowForTarget(list, document.body)).toBeNull();
    expect(glowFrame(list, rows[1])).toEqual({ top: 60, height: 60 });
  });

  it("moves a decorative pseudo-element without inserting children or changing row interactions", () => {
    const { list, rows, buttons } = harness();
    const click = vi.fn();
    buttons[1].addEventListener("click", click);
    fireEvent.pointerOver(buttons[0]);
    expect(list).toHaveClass("ug-hover-list");
    expect(list.style.getPropertyValue("--ug-row-top")).toBe("0px");
    fireEvent.pointerOver(buttons[1]);
    expect(list.style.getPropertyValue("--ug-row-top")).toBe("60px");
    expect(list.style.getPropertyValue("--ug-row-height")).toBe("60px");
    expect([...list.children]).toEqual(rows);
    expect(list.querySelector("[tabindex], [aria-hidden]")).toBeNull();
    fireEvent.click(buttons[1]);
    expect(click).toHaveBeenCalledOnce();
  });

  it("tracks hover capability and reduced motion changes without a reload", () => {
    const { list, buttons, pointer, reduced } = harness({ hover: false });
    fireEvent.pointerOver(buttons[0]);
    expect(list).not.toHaveClass("ug-hover-list");
    pointer.change(true);
    fireEvent.pointerOver(buttons[0]);
    reduced.change(true);
    expect(list).toHaveClass("ug-row-static");
    reduced.change(false);
    expect(list).not.toHaveClass("ug-row-static");
    pointer.change(false);
    expect(list).not.toHaveClass("ug-hover-list");
    expect(list.style.getPropertyValue("--ug-row-height")).toBe("");
  });

  it("removes obsolete geometry after leaving, scrolling, resizing, or shrinking a list", async () => {
    const { list, buttons, rows } = harness();
    for (const event of [
      () => fireEvent.pointerOut(buttons[0], { relatedTarget: document.querySelector("#outside") }),
      () => fireEvent.scroll(list),
      () => fireEvent.resize(window),
    ]) {
      fireEvent.pointerOver(buttons[0]);
      event();
      expect(list).not.toHaveClass("ug-hover-list");
      expect(list.style.getPropertyValue("--ug-row-top")).toBe("");
    }
    fireEvent.pointerOver(buttons[1]);
    rows[1].remove();
    await Promise.resolve();
    expect(list).not.toHaveClass("ug-hover-list");
    expect(list.style.getPropertyValue("--ug-row-height")).toBe("");
  });

  it("cleans document and media listeners on disposal and tolerates repeated cleanup", () => {
    const { list, buttons, pointer, reduced } = harness();
    fireEvent.pointerOver(buttons[0]);
    cleanup();
    cleanup();
    expect(pointer.listeners.size).toBe(0);
    expect(reduced.listeners.size).toBe(0);
    expect(list).not.toHaveClass("ug-hover-list");
    fireEvent.pointerOver(buttons[1]);
    expect(list).not.toHaveClass("ug-hover-list");
  });
});
