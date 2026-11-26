import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlaneKpi } from "../src/components/PlaneHeader.jsx";
import { ScreenHeader, StatCard, StateBlock } from "../src/components/Primitives.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { formatCount } from "../src/lib/formatCount.js";

// BUG-UG-DESK-COUNTS-NO-THOUSANDS-SEPARATOR-20261106: desk tiles
// printed "1506" where the rest of the product writes "1,506".
describe("formatCount", () => {
  it("groups whole counts in the viewer's language and leaves everything else alone", () => {
    expect(formatCount(1506, "en")).toBe("1,506");
    expect(formatCount(41, "en")).toBe("41");
    expect(formatCount(12506, "es")).toBe("12.506");
    expect(formatCount(1001, "es")).toBe("1.001");
    expect(formatCount("74%", "en")).toBe("74%");
    expect(formatCount("—", "en")).toBe("—");
    expect(formatCount(36.5, "en")).toBe(36.5);
    expect(formatCount(1506, "not a locale!")).toBe("1506");
    expect(formatCount(1506)).toBe("1,506");
  });

  it("shows desk tile counts with separators", () => {
    render(<LanguageProvider lang="en"><PlaneKpi label="Members covered" value={1506} /></LanguageProvider>);
    expect(screen.getByText("1,506")).toBeInTheDocument();
  });

  it("writes StatCard counts with separators and leaves text values alone", () => {
    render(<LanguageProvider lang="en"><StatCard label="Chapter members" value={1506} /><StatCard label="Turnout" value="71" suffix="%" /></LanguageProvider>);
    expect(screen.getByText("Chapter members").closest("article").querySelector("strong")).toHaveTextContent("1,506");
    expect(screen.getByText("Turnout").closest("article").querySelector("strong")).toHaveTextContent("71%");
  });

  // The other primitives in the same module keep their branches covered.
  it("renders the compact and full screen headers and every state block kind", () => {
    const { container, unmount } = render(<LanguageProvider lang="en">
      <ScreenHeader initials="AS" eyebrow="Member" title="Home" notifications={2} />
      <ScreenHeader initials="AS" eyebrow="Member" title="Compact" compact onAssistant={() => {}} />
      <ScreenHeader initials="AS" eyebrow="Member" title="Bare" compact />
      <StateBlock kind="error" title="Failed" body="Body" safe="Nothing changed" hint="Ask an admin" actionLabel="Retry" onAction={() => {}} headingLevel={3} />
      <StateBlock kind="unavailable" title="Off" links={[{ label: "Open", href: "/a" }, { label: "Help", href: "/b" }]} />
      <StateBlock title="Empty" links={[]} />
    </LanguageProvider>);
    expect(container.querySelectorAll(".screen-header")).toHaveLength(3);
    expect(container.querySelector(".notification-button span")).toHaveTextContent("2");
    expect(container.querySelector("[data-state-block='error'] h3")).toHaveTextContent("Failed");
    expect(container.querySelector("[data-state-block='unavailable']")).toHaveAttribute("role", "status");
    expect(container.querySelector(".state-block__action--primary")).toHaveTextContent("Open");
    expect(container.querySelector("[data-state-block='empty'] .state-block__links")).toBeNull();
    unmount();
  });
});
