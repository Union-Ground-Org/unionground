import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ANALYTICS_EXPLORER_PAGE_SIZE } from "../src/features/analytics/index.js";
import { AnalyticsExplorerPanel } from "../src/features/analytics/ui/AnalyticsParityPanels.jsx";

function member(index, overrides = {}) {
  return {
    id: `member-${index}:chapter-a`,
    name: `Member ${String(index).padStart(2, "0")}`,
    chapterId: "chapter-a",
    chapterName: "North Chapter",
    overallScore: 50,
    attention: "steady",
    ...overrides,
  };
}

function workspace(count) {
  return {
    state: "ready",
    chapters: [{ chapterId: "chapter-a", chapterName: "North Chapter" }],
    members: Array.from({ length: count }, (_, index) => member(index + 1)),
  };
}

function bodyRows() {
  const [, body] = screen.getAllByRole("rowgroup");
  return within(body).getAllByRole("row");
}

describe("MI1 analytics Explorer member table paging", () => {
  it("renders one bounded page of members with a pager instead of every filtered row", () => {
    render(<AnalyticsExplorerPanel workspace={workspace(61)} />);
    expect(bodyRows()).toHaveLength(ANALYTICS_EXPLORER_PAGE_SIZE);
    const pager = screen.getByRole("navigation", { name: "Worker pages" });
    expect(within(pager).getByRole("status")).toHaveTextContent("Page 1 of 3");
    expect(within(pager).getByRole("button", { name: "Previous page" })).toBeDisabled();

    fireEvent.click(within(pager).getByRole("button", { name: "Next page" }));
    fireEvent.click(within(pager).getByRole("button", { name: "Next page" }));
    expect(within(pager).getByRole("status")).toHaveTextContent("Page 3 of 3");
    expect(bodyRows()).toHaveLength(11);
    expect(screen.getByRole("button", { name: "Member 61" })).toBeInTheDocument();
    expect(within(pager).getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("returns to the first page when a filter changes and keeps the selected member's detail", () => {
    render(<AnalyticsExplorerPanel workspace={workspace(61)} />);
    fireEvent.click(screen.getByRole("button", { name: "Member 03" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByRole("heading", { name: "Member 03" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Worker pages" })).toHaveTextContent("Page 2 of 3");

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Member" } });
    expect(screen.getByRole("status", { name: "Worker pages" })).toHaveTextContent("Page 1 of 3");
    expect(screen.getByRole("button", { name: "Member 01" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Member 03" })).toBeInTheDocument();
  });

  it("shows no pager when the members fit on one page", () => {
    render(<AnalyticsExplorerPanel workspace={workspace(ANALYTICS_EXPLORER_PAGE_SIZE)} />);
    expect(bodyRows()).toHaveLength(ANALYTICS_EXPLORER_PAGE_SIZE);
    expect(screen.queryByRole("navigation", { name: "Worker pages" })).not.toBeInTheDocument();
  });
});
