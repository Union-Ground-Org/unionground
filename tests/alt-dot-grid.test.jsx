import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DotGrid, { attachDotGlow } from "../src/alt/DotGrid.jsx";

// The design's dotted canvas and its pointer glow (ported from the export's
// UG.glow). jsdom has no 2D canvas or ResizeObserver, so these tests supply
// both and drive the animation frames by hand.

function fakeContext() {
  return { clearRect: vi.fn(), setTransform: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillStyle: "", globalAlpha: 1 };
}

function pointer(type, props) {
  const event = new Event(type);
  Object.assign(event, props);
  return event;
}

let frames;
let now;
let ctx;
let observers;

function runFrames(count, step = 16) {
  for (let i = 0; i < count && frames.length; i += 1) {
    now += step;
    const pending = frames.splice(0);
    pending.forEach((callback) => callback(now));
  }
}

function makeHost() {
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 600, configurable: true });
  host.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });
  document.body.append(host);
  return host;
}

beforeEach(() => {
  frames = [];
  now = 1000;
  ctx = fakeContext();
  observers = [];
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.disconnect = vi.fn(); observers.push(this); }
    observe() {}
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  vi.spyOn(performance, "now").mockImplementation(() => now);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.ResizeObserver;
  document.body.innerHTML = "";
});

describe("dot grid", () => {
  it("renders the design's decorative dot canvas", () => {
    const { container, unmount } = render(<DotGrid />);
    const dots = container.querySelector(".ug-dots");
    expect(dots).toBeTruthy();
    expect(dots.getAttribute("aria-hidden")).toBe("true");
    expect(dots.querySelector("canvas.ug-dots-glow")).toBeTruthy();
    unmount();
  });

  it("keeps plain dots where there is no ResizeObserver or no 2D canvas", () => {
    const host = makeHost();
    delete window.ResizeObserver;
    expect(attachDotGlow(host)).toBeTypeOf("function");
    expect(host.querySelector("canvas")).toBeNull();
    window.ResizeObserver = class { observe() {} disconnect() {} };
    HTMLCanvasElement.prototype.getContext.mockReturnValue(null);
    attachDotGlow(host)();
    expect(host.querySelector("canvas")).toBeNull();
    HTMLCanvasElement.prototype.getContext.mockImplementation(() => { throw new Error("no canvas"); });
    attachDotGlow(host)();
    expect(host.querySelector("canvas")).toBeNull();
    expect(attachDotGlow(null)).toBeTypeOf("function");
  });

  it("swells the dots near a mouse pointer, ignores touch, follows scroll and clears on leave", () => {
    const host = makeHost();
    const detach = attachDotGlow(host);
    const canvas = host.querySelector("canvas.ug-dots-glow");
    expect(canvas.width).toBe(800);
    expect(ctx.setTransform).toHaveBeenCalled();

    window.dispatchEvent(pointer("pointermove", { pointerType: "touch", clientX: 100, clientY: 100 }));
    expect(frames).toHaveLength(0);

    window.dispatchEvent(pointer("pointermove", { pointerType: "mouse", clientX: 130, clientY: 130 }));
    runFrames(1);
    expect(ctx.arc).toHaveBeenCalled();
    window.dispatchEvent(pointer("pointermove", { pointerType: "mouse", clientX: 260, clientY: 210 }));
    runFrames(40);
    // The glow centre eases toward the pointer and stops scheduling once it arrives.
    expect(frames).toHaveLength(0);

    window.dispatchEvent(new Event("scroll"));
    runFrames(2);
    // A pointer outside the canvas aims at nothing.
    window.dispatchEvent(pointer("pointermove", { pointerType: "mouse", clientX: 2000, clientY: 2000 }));
    runFrames(3);
    document.documentElement.dispatchEvent(new Event("mouseleave"));
    runFrames(3);
    expect(ctx.clearRect).toHaveBeenCalled();

    // Resizes repaint on the observer callback.
    observers[0].callback();

    detach();
    expect(host.querySelector("canvas")).toBeNull();
    expect(observers[0].disconnect).toHaveBeenCalled();
    ctx.arc.mockClear();
    window.dispatchEvent(pointer("pointermove", { pointerType: "mouse", clientX: 130, clientY: 130 }));
    runFrames(2);
    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it("sends three rings out from a press and lets them fade past their reach", () => {
    const host = makeHost();
    const detach = attachDotGlow(host);
    window.dispatchEvent(pointer("pointerdown", { clientX: 400, clientY: 300 }));
    expect(frames).toHaveLength(1);
    runFrames(10, 100);
    expect(ctx.arc).toHaveBeenCalled();
    // FAR is 520px at .42px/ms, so the last ring (440ms late) ends before 2.5s.
    runFrames(40, 100);
    expect(frames).toHaveLength(0);
    // A press outside the canvas sends nothing.
    window.dispatchEvent(pointer("pointerdown", { clientX: 5000, clientY: 5000 }));
    expect(frames).toHaveLength(0);
    detach();
  });

  it("sends no rings when the visitor asks for reduced motion", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    const host = makeHost();
    const detach = attachDotGlow(host);
    window.dispatchEvent(pointer("pointerdown", { clientX: 400, clientY: 300 }));
    expect(frames).toHaveLength(0);
    detach();
  });
});
