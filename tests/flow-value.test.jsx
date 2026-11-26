import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlowValue, splitFlowValue } from "../src/components/FlowValue.jsx";

// Assert the full number formatter contract without substituting our own parser.
vi.mock("@number-flow/react", () => ({
  useIsSupported: () => true,
  default: ({ value, locales, format, prefix, suffix, animated }) => (
    <span data-testid="rolling-value" data-animated={String(animated)}>
      {prefix}{new Intl.NumberFormat(locales, format).format(value)}{suffix}
    </span>
  ),
}));

afterEach(() => vi.unstubAllGlobals());

describe("recovered rolling stat values", () => {
  it.each([
    [0, "en-US"], [0.125, "en-US"], ["38%", "en-US"], ["1,204", "en-US"],
    ["$8.40k", "en-US"], ["3/4", "en-US"], ["3h", "en-US"], ["−3.50 h", "en-US"],
    ["-3.50 h", "en-US"], ["+2.5%", "en-US"], ["007", "en-US"],
    ["1.234,50 €", "de-DE"], ["12,50 %", "es-ES"], ["12\u202f345,50 €", "fr-FR"],
    ["١٢٬٣٤٥٫٥٠", "ar-EG"],
  ])("preserves the exact spelling of %s in %s", (value, locales) => {
    const parts = splitFlowValue(value, locales);
    expect(parts).not.toBeNull();
    render(<FlowValue value={value} locales={locales} />);
    expect(screen.getByTestId("rolling-value").textContent).toBe(String(value));
  });

  it.each(["1,23", "0.123456789012345678901", "9007199254740993", "1e-7", "3\nreports", "—", "", NaN, Infinity])(
    "leaves unsupported or precision-sensitive text unchanged: %s", (value) => {
      expect(splitFlowValue(value)).toBeNull();
      const { container } = render(<FlowValue value={String(value)} />);
      expect(container.textContent).toBe(String(value));
      expect(screen.queryByTestId("rolling-value")).toBeNull();
    },
  );

  it("preserves React content, missing values, and a later zero", () => {
    const { rerender, container } = render(<FlowValue value={<><b>3</b><br />reports</>} />);
    expect(container.querySelector("b")).toHaveTextContent("3");
    expect(container.querySelector("br")).not.toBeNull();
    rerender(<FlowValue value={null} />);
    expect(container.textContent).toBe("");
    rerender(<FlowValue value={0} />);
    expect(screen.getByTestId("rolling-value")).toHaveTextContent("0");
  });

  it("changes motion immediately with the system preference and removes the subscription", () => {
    const listeners = new Set();
    const media = {
      matches: false,
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
    };
    vi.stubGlobal("matchMedia", () => media);
    const { unmount } = render(<FlowValue value="12.50%" />);
    expect(screen.getByTestId("rolling-value")).toHaveAttribute("data-animated", "true");
    act(() => { media.matches = true; listeners.forEach((listener) => listener()); });
    expect(screen.getByTestId("rolling-value")).toHaveAttribute("data-animated", "false");
    expect(screen.getByTestId("rolling-value").textContent).toBe("12.50%");
    act(() => { media.matches = false; listeners.forEach((listener) => listener()); });
    expect(screen.getByTestId("rolling-value")).toHaveAttribute("data-animated", "true");
    unmount();
    expect(listeners.size).toBe(0);
  });
});
