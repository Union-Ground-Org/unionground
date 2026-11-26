import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FlowValue } from "../src/components/FlowValue.jsx";
import { StatCard } from "../src/components/Primitives.jsx";

describe("rolling stats with the production number component", () => {
  it("keeps accessible plain text in browsers without animation support and updates to zero", () => {
    const { container, rerender } = render(<FlowValue value="$12.50k" />);
    expect(screen.getByText("$12.50k")).toBeInTheDocument();
    expect(container.querySelector("number-flow-react")).toBeNull();
    rerender(<FlowValue value="$0.00k" />);
    expect(screen.getByText("$0.00k")).toBeInTheDocument();
    expect(container.textContent).toBe("$0.00k");
  });

  it("keeps the stat label, suffix, and nonnumeric empty state", () => {
    const { rerender } = render(<StatCard label="Workload" value={0} suffix="hours" />);
    expect(screen.getByText("Workload")).toBeInTheDocument();
    expect(screen.getByText("hours")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    rerender(<StatCard label="Workload" value="—" suffix="hours" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
