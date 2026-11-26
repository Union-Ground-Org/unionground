import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MAX_STROKES, SignaturePad } from "../src/components/SignaturePad.jsx";

function ControlledPad({ disabled = false, onChange = vi.fn(), strokeStatus, capStatus }) {
  const [value, setValue] = useState([]);
  return (
    <SignaturePad
      value={value}
      disabled={disabled}
      label="Draw your signature"
      instructions="Use pointer or keyboard."
      clearLabel="Clear signature"
      emptyStatus="No signature drawn."
      strokeStatus={strokeStatus}
      capStatus={capStatus}
      onChange={(next) => { setValue(next); onChange(next); }}
    />
  );
}

function box(canvas) {
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}),
  });
}

describe("SignaturePad", () => {
  it("normalizes pointer strokes into bounded integer coordinates", () => {
    const changed = vi.fn();
    render(<ControlledPad onChange={changed} />);
    const canvas = screen.getByLabelText("Draw your signature");
    box(canvas);

    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    expect(changed).toHaveBeenLastCalledWith([[{ x: 50, y: 200 }, { x: 1000, y: 1000 }]]);
  });

  it("draws with Space and arrow keys, announces status, and clears", () => {
    const changed = vi.fn();
    render(<ControlledPad onChange={changed} strokeStatus={(count) => `Signature strokes: ${count}`} />);
    const canvas = screen.getByLabelText("Draw your signature");

    fireEvent.keyDown(canvas, { key: " " });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    fireEvent.keyDown(canvas, { key: " " });

    expect(changed).toHaveBeenLastCalledWith([[
      { x: 500, y: 500 }, { x: 525, y: 500 }, { x: 525, y: 525 },
    ]]);
    expect(screen.getByRole("status")).toHaveTextContent("Signature strokes: 1");
    fireEvent.click(screen.getByRole("button", { name: "Clear signature" }));
    expect(changed).toHaveBeenLastCalledWith([]);
    expect(screen.getByRole("status")).toHaveTextContent("No signature drawn.");
  });

  it("is inert and removes keyboard focus when disabled", () => {
    const changed = vi.fn();
    render(<ControlledPad disabled onChange={changed} />);
    const canvas = screen.getByLabelText("Draw your signature");
    expect(canvas).toHaveAttribute("aria-disabled", "true");
    expect(canvas).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(canvas, { key: " " });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    expect(changed).not.toHaveBeenCalled();
  });

  it("uses caller-provided localized stroke status", () => {
    render(<ControlledPad strokeStatus={(count) => `Trazos de firma: ${count}`} />);
    const canvas = screen.getByLabelText("Draw your signature");
    fireEvent.keyDown(canvas, { key: " " });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: " " });
    expect(screen.getByRole("status")).toHaveTextContent("Trazos de firma: 1");
  });

  it("ends an unfinished keyboard stroke when clearing", () => {
    const changed = vi.fn();
    render(<ControlledPad onChange={changed} />);
    const canvas = screen.getByLabelText("Draw your signature");
    fireEvent.keyDown(canvas, { key: " " });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Clear signature" }));
    changed.mockClear();

    fireEvent.keyDown(canvas, { key: " " });
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    fireEvent.keyDown(canvas, { key: " " });

    expect(changed).toHaveBeenLastCalledWith([[
      { x: 500, y: 500 }, { x: 500, y: 525 },
    ]]);
  });

  it("paints stored strokes at display density and ignores malformed empty rows", () => {
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    const getRect = vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 160, bottom: 80, width: 160, height: 80, x: 0, y: 0, toJSON: () => ({}),
    });
    const originalDensity = globalThis.devicePixelRatio;
    Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 2 });

    try {
      render(
        <SignaturePad
          value={[null, [], [{ x: -10, y: 1200 }], [{ x: 0, y: 0 }, { x: 1000, y: 1000 }]]}
          onChange={vi.fn()}
          label="Draw your signature"
          instructions="Use pointer or keyboard."
          clearLabel="Clear signature"
          emptyStatus="No signature drawn."
        />,
      );

      const canvas = screen.getByLabelText("Draw your signature");
      expect(canvas).toHaveAttribute("width", "320");
      expect(canvas).toHaveAttribute("height", "160");
      expect(context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
      expect(context.beginPath).toHaveBeenCalledTimes(2);
      expect(context.moveTo).toHaveBeenNthCalledWith(1, 0, 80);
      expect(context.lineTo).toHaveBeenCalledWith(0.16, 80);
      expect(context.lineTo).toHaveBeenCalledWith(160, 80);
    } finally {
      getContext.mockRestore();
      getRect.mockRestore();
      Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: originalDensity });
    }
  });

  it("finishes a single-point stroke on lost capture and stops after pointer cancellation", () => {
    const changed = vi.fn();
    render(<ControlledPad onChange={changed} />);
    const canvas = screen.getByLabelText("Draw your signature");
    box(canvas);

    fireEvent.pointerDown(canvas, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.lostPointerCapture(canvas, { pointerId: 1 });
    expect(changed).toHaveBeenLastCalledWith([[{ x: 100, y: 200 }, { x: 101, y: 200 }]]);

    fireEvent.pointerDown(canvas, { clientX: 30, clientY: 30, pointerId: 2 });
    fireEvent.pointerCancel(canvas, { pointerId: 2 });
    const callsAfterCancel = changed.mock.calls.length;
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 40, pointerId: 2 });
    expect(changed).toHaveBeenCalledTimes(callsAfterCancel);
  });

  it("draws a pen marker while the canvas is focused and hides it after blur", () => {
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    const getRect = vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 160, bottom: 80, width: 160, height: 80, x: 0, y: 0, toJSON: () => ({}),
    });
    try {
      render(<ControlledPad />);
      const canvas = screen.getByLabelText("Draw your signature");
      expect(context.arc).not.toHaveBeenCalled();

      fireEvent.focus(canvas);
      expect(context.arc).toHaveBeenCalledWith(80, 40, 4, 0, Math.PI * 2);

      fireEvent.keyDown(canvas, { key: "ArrowRight" });
      expect(context.arc).toHaveBeenCalledWith(84, 40, 4, 0, Math.PI * 2);

      context.arc.mockClear();
      fireEvent.blur(canvas);
      expect(context.arc).not.toHaveBeenCalled();
    } finally {
      getContext.mockRestore();
      getRect.mockRestore();
    }
  });

  it("keeps one resize observer for the whole drawing and repaints current strokes and pen on resize", () => {
    const observers = [];
    const OriginalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.observe = vi.fn();
        this.disconnect = vi.fn();
        observers.push(this);
      }
    };
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);

    try {
      const { unmount } = render(<ControlledPad />);
      const canvas = screen.getByLabelText("Draw your signature");
      box(canvas);

      fireEvent.pointerDown(canvas, { clientX: 10, clientY: 20, pointerId: 1 });
      for (let x = 20; x <= 200; x += 20) fireEvent.pointerMove(canvas, { clientX: x, clientY: 50, pointerId: 1 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
      fireEvent.focus(canvas);
      fireEvent.keyDown(canvas, { key: " " });
      fireEvent.keyDown(canvas, { key: "ArrowRight" });
      fireEvent.keyDown(canvas, { key: " " });

      expect(observers).toHaveLength(1);
      expect(observers[0].observe).toHaveBeenCalledTimes(1);
      expect(observers[0].observe).toHaveBeenCalledWith(canvas);
      expect(observers[0].disconnect).not.toHaveBeenCalled();

      context.beginPath.mockClear();
      context.arc.mockClear();
      observers[0].callback([]);
      expect(context.beginPath).toHaveBeenCalledTimes(3);
      expect(context.arc).toHaveBeenCalledTimes(1);

      unmount();
      expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    } finally {
      getContext.mockRestore();
      globalThis.ResizeObserver = OriginalResizeObserver;
    }
  });

  it("starts a fresh keyboard stroke after tabbing away mid-stroke", () => {
    const changed = vi.fn();
    render(<ControlledPad onChange={changed} />);
    const canvas = screen.getByLabelText("Draw your signature");

    fireEvent.keyDown(canvas, { key: " " });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.blur(canvas);
    fireEvent.focus(canvas);
    fireEvent.keyDown(canvas, { key: " " });
    fireEvent.keyDown(canvas, { key: "ArrowDown" });

    expect(changed).toHaveBeenLastCalledWith([
      [{ x: 500, y: 500 }, { x: 525, y: 500 }],
      [{ x: 525, y: 500 }, { x: 525, y: 525 }],
    ]);
  });

  it("announces a cap notice when a stroke cap refuses input and clears it", () => {
    render(
      <ControlledPad
        strokeStatus={(count) => `Signature strokes: ${count}`}
        capStatus="This signature cannot accept any more strokes or points."
      />,
    );
    const canvas = screen.getByLabelText("Draw your signature");
    for (let i = 0; i < MAX_STROKES; i += 1) {
      fireEvent.keyDown(canvas, { key: " " });
      fireEvent.keyDown(canvas, { key: " " });
    }
    expect(screen.getByRole("status")).toHaveTextContent("Signature strokes: 64");
    fireEvent.keyDown(canvas, { key: " " });
    expect(screen.getByRole("status")).toHaveTextContent("This signature cannot accept any more strokes or points.");
    fireEvent.click(screen.getByRole("button", { name: "Clear signature" }));
    expect(screen.getByRole("status")).toHaveTextContent("No signature drawn.");
  });

  it("does not fall back to English stroke copy when strokeStatus is omitted", () => {
    render(<ControlledPad />);
    const canvas = screen.getByLabelText("Draw your signature");
    fireEvent.keyDown(canvas, { key: " " });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: " " });
    expect(screen.getByRole("status")).not.toHaveTextContent(/strokes?/i);
  });
});
