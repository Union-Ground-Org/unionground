import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { HOME_FEED_PAGE } from "../src/lib/homeFeed.js";
import { TodayView } from "../src/views/TodayView.jsx";

function renderHome(data, props = {}) {
  return render(
    <LanguageProvider lang="en">
      <TodayView data={data} desktop onPlanAction={vi.fn()} {...props} />
    </LanguageProvider>,
  );
}

function deepFeedData() {
  return {
    ...fallbackData,
    broadcasts: Array.from({ length: HOME_FEED_PAGE + 1 }, (_, index) => ({
      id: `broadcast-${index}`,
      title: `Update ${index}`,
      body: `Chapter detail ${index}`,
      publishedAt: new Date(Date.now() - index * 3600000).toISOString(),
    })),
    events: [{
      id: "held-workshop",
      title: "Held workshop",
      startsAt: "2026-08-27T18:00:00.000Z",
      location: "Chapter hall",
      summary: "Steward practice",
      isPast: true,
      checkedIn: true,
    }],
    planItems: [{
      id: "closed-ballot",
      kind: "ballot",
      closed: true,
      closesAt: "2026-08-28T18:00:00.000Z",
      title: "Closed ballot",
      quorum: { totalVotes: 73 },
    }],
  };
}

describe("Home notice routes", () => {
  it("opens Messages from the expanded current briefing", () => {
    const onOpenMessages = vi.fn();
    const view = renderHome(deepFeedData(), { onOpenMessages });
    const feed = within(screen.getByRole("region", { name: "Campaign activity" }));
    expect(feed.queryByText("Update 20")).toBeNull();
    fireEvent.click(feed.getByRole("button", { name: "Show all (21)" }));
    fireEvent.click(feed.getByRole("button", { name: /Update 20/ }));
    expect(onOpenMessages).toHaveBeenCalledOnce();
    expect(feed.queryByText("Held workshop")).toBeNull();
    expect(feed.queryByText("Closed ballot")).toBeNull();
    expect(view.container.querySelectorAll(".home-feed .home-row")).toHaveLength(21);
  });

  it("leaves a current notice inert without a handler and omits a history-only briefing", () => {
    const data = deepFeedData();
    const inert = renderHome({ ...data, broadcasts: data.broadcasts.slice(0, 1) });
    const feed = within(screen.getByRole("region", { name: "Campaign activity" }));
    expect(feed.getByText("Update 0")).toBeVisible();
    expect(feed.queryByRole("button")).toBeNull();
    inert.unmount();

    renderHome({ ...data, broadcasts: [
      { id: "historic", title: "Historical notice", publishedAt: "2024-01-01T00:00:00Z" },
    ] });
    expect(screen.queryByRole("region", { name: "Campaign activity" })).toBeNull();
  });
});
