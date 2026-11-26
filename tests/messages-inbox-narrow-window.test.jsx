import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { limitMessageGroups } from "../src/lib/messageWorkflow.js";

// BUG-UG-MESSAGES-INBOX-RENDERS-ALL-ITEMS-NARROW-20261106: below the
// desktop split a long inbox rendered every row at once (216 rows, about
// 19,000 px tall). It now shows a page at a time behind the shared pager.

function longInbox(count) {
  return {
    member: { id: "member-long" },
    conversations: [],
    broadcasts: Array.from({ length: count }, (_, index) => ({
      id: `b-${index}`,
      title: `Chapter notice ${String(index + 1).padStart(3, "0")}`,
      sender: "Tamarack Valley chapter",
      body: "Meeting details inside.",
      unread: false,
      publishedAt: new Date(Date.UTC(2026, 9, 1) - index * 3_600_000).toISOString(),
    })),
    product: { spaces: [], documents: [] },
  };
}

function renderInbox(props = {}) {
  return render(<MessagesView data={longInbox(216)} onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} {...props} />);
}

const rows = () => document.querySelectorAll(".inbox-scroll .inbox-row");

describe("Messages inbox below the desktop split", () => {
  beforeEach(() => window.localStorage.clear());

  it("renders one page of a 216-item inbox and adds a page per Show more", () => {
    renderInbox();
    expect(screen.getByText("216 items")).toBeInTheDocument();
    expect(rows()).toHaveLength(20);
    expect(screen.getByText("Showing 1–20 of 216")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(rows()).toHaveLength(40);
    expect(screen.getByText("Chapter notice 040")).toBeInTheDocument();
    expect(screen.queryByText("Chapter notice 041")).not.toBeInTheDocument();
  });

  it("starts over at one page when the filter or search changes, and drops the pager for a short result", () => {
    renderInbox();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(rows()).toHaveLength(40);
    fireEvent.click(screen.getByRole("button", { name: /^Announcements/ }));
    expect(rows()).toHaveLength(20);
    fireEvent.change(screen.getByPlaceholderText("Search people & threads…"), { target: { value: "notice 21" } });
    // 210-216 match: under one page, so no pager.
    expect(rows()).toHaveLength(7);
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("replaces the desktop pane with a bounded page", () => {
    renderInbox({ desktop: true });
    expect(rows()).toHaveLength(20);
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });
});

describe("limitMessageGroups", () => {
  it("keeps display order across groups and drops groups past the limit", () => {
    const groups = [
      { key: "people", items: ["a", "b"] },
      { key: "spaces", items: ["c", "d", "e"] },
      { key: "work", items: ["f"] },
    ];
    expect(limitMessageGroups(groups, 3)).toEqual([
      { key: "people", items: ["a", "b"] },
      { key: "spaces", items: ["c"] },
    ]);
    expect(limitMessageGroups(groups, 10)).toEqual(groups);
    expect(limitMessageGroups(groups, 0)).toEqual([]);
    expect(limitMessageGroups(groups, 3, 2)).toEqual([{ key: "spaces", items: ["c", "d", "e"] }]);
    expect(limitMessageGroups(groups, 2, 4)).toEqual([{ key: "spaces", items: ["e"] }, { key: "work", items: ["f"] }]);
    expect(limitMessageGroups(groups, 2, 99)).toEqual([]);
  });
});
