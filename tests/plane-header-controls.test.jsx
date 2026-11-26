import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlaneHeader, PlaneKpi } from "../src/components/PlaneHeader.jsx";

describe("staff KPI disclosure controls", () => {
  it("keeps an action reachable without claiming a nonexistent controlled region", () => {
    const open = vi.fn();
    render(<PlaneKpi label="Open cases" value={5} onClick={open} />);
    const action = screen.getByRole("button", { name: "Open cases 5" });
    expect(action).toHaveAttribute("aria-expanded", "false");
    expect(action).not.toHaveAttribute("aria-controls");
    fireEvent.click(action);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("keeps a backed disclosure's visible panel and expanded state together", () => {
    function CaseSummary() {
      const [expanded, setExpanded] = useState(false);
      return <>
        <PlaneKpi label="Open cases" value={5} active={expanded} controls="open-case-list" onClick={() => setExpanded((value) => !value)} />
        <section id="open-case-list" aria-label="Open case list" hidden={!expanded}>Case UG-123</section>
      </>;
    }
    render(<CaseSummary />);
    const action = screen.getByRole("button", { name: "Open cases 5" });
    expect(action).toHaveAttribute("aria-controls", "open-case-list");
    expect(screen.getByText("Case UG-123")).not.toBeVisible();
    fireEvent.click(action);
    expect(action).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "Open case list" })).toBeVisible();
    fireEvent.click(action);
    expect(action).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Case UG-123")).not.toBeVisible();
  });
});

// UB-UG-STAFF-DESK-STAT-CARDS-THREE-TREATMENTS-20261108: the shared
// tile carries the President's "% of quorum" unit beside the number and the
// quorum note under it, so that desk no longer needs the member StatCard.
describe("staff KPI tile", () => {
  it("sets a unit smaller beside the number and a note under it", () => {
    const { container } = render(<PlaneKpi label="Turnout" value={71} suffix="% of quorum" sub="213 of 300 votes needed for quorum" />);
    expect(container.querySelector(".pkpi.pkpi--green")).not.toBeNull();
    expect(screen.getByText("71").closest(".pkpi__value")).toHaveTextContent("71% of quorum");
    expect(screen.getByText("% of quorum")).toHaveClass("pkpi__suffix");
    expect(screen.getByText("213 of 300 votes needed for quorum")).toHaveClass("pkpi__sub");
  });

  it("keeps a plain tile to the label and the grouped number", () => {
    const { container } = render(<PlaneKpi label="Chapter members" value={1506} tone="gold" />);
    expect(container.querySelector(".pkpi--gold .pkpi__value")).toHaveTextContent("1,506");
    expect(container.querySelector(".pkpi__suffix")).toBeNull();
    expect(container.querySelector(".pkpi__sub")).toBeNull();
  });
});

describe("staff plane header", () => {
  it("renders the profile and Compass buttons only when their callbacks are passed", () => {
    const profile = vi.fn();
    const assistant = vi.fn();
    const { rerender } = render(<PlaneHeader title="Leadership overview" sub="Chapter leadership" />);
    expect(screen.getByRole("heading", { name: "Leadership overview" })).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    rerender(<PlaneHeader title="Leadership overview" initials="MI" onProfile={profile} onAssistant={assistant} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    buttons.forEach((button) => fireEvent.click(button));
    expect(profile).toHaveBeenCalledTimes(1);
    expect(assistant).toHaveBeenCalledTimes(1);
  });
});


describe("staff chapter context", () => {
  it.each(["Transportation and Facilities", "Alder Falls Residential", "Service Coordination"])("names %s while the desk is loading and after its counts arrive", (chapterName) => {
    const { container, rerender } = render(<PlaneHeader title="Casework desk" chapterName={chapterName} />);
    expect(container.querySelector(".phead__eyebrow")).toHaveTextContent(chapterName);
    rerender(<PlaneHeader title="Casework desk" chapterName={chapterName} sub="14 open requests · 1,001 members covered" />);
    expect(container.querySelector(".phead__eyebrow")).toHaveTextContent(chapterName);
    expect(container.querySelector(".phead__sub")).toHaveTextContent("14 open requests · 1,001 members covered");
    rerender(<PlaneHeader title="Casework desk" chapterName="A different chapter" sub="No open requests" />);
    expect(container.querySelector(".phead__eyebrow")).toHaveTextContent("A different chapter");
    expect(container).not.toHaveTextContent(chapterName);
  });
});
