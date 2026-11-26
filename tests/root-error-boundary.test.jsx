import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const reported = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/deferredObservability.js", () => ({ captureViewError: reported }));

const { RootErrorBoundary } = await import("../src/components/RootErrorBoundary.jsx");

function Crash({ error }) {
  throw error;
}

// The root boundary main.jsx renders in place of Sentry.ErrorBoundary
// (PERF-UG-FIRST-PAINT-OBSERVABILITY-DEFER-AND-CSS-SPLIT-20261028).
describe("RootErrorBoundary", () => {
  afterEach(() => {
    reported.mockClear();
    vi.restoreAllMocks();
  });

  it("renders the App while nothing has failed", () => {
    render(<RootErrorBoundary fallback={<main role="alert">Crashed</main>}><p>Union Ground</p></RootErrorBoundary>);
    expect(screen.getByText("Union Ground")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(reported).not.toHaveBeenCalled();
  });

  it("shows the crash screen and reports the error through the deferred loader", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new TypeError("Cannot read properties of undefined (reading 'id')");
    render(<RootErrorBoundary fallback={<main role="alert">Crashed</main>}><Crash error={error} /></RootErrorBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("Crashed");
    expect(reported).toHaveBeenCalledTimes(1);
    expect(reported).toHaveBeenCalledWith(error);
  });
});
