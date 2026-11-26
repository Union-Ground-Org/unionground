import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { HOME_FEED_PAGE } from "../src/lib/homeFeed.js";
import { TodayView } from "../src/views/TodayView.jsx";

function activityData() {
  const broadcasts = Array.from({ length: HOME_FEED_PAGE * 2 + 2 }, (_, index) => ({
    id: `feed-broadcast-${index}`,
    title: index === 0 ? "Negotiations update" : `Recent update ${index}`,
    body: "Chapter members received the complete update.",
    publishedAt: new Date(Date.now() - index * 3600000).toISOString(),
  }));
  return {
    ...fallbackData,
    broadcasts,
    events: [
      ...fallbackData.events.filter((event) => event.isPast !== true),
      {
        id: "feed-event",
        title: "Retiree picnic",
        startsAt: "2026-08-19T18:00:00.000Z",
        location: "Chapter hall",
        summary: "Members reconnected.",
        isPast: true,
        checkedIn: true,
      },
    ],
    planItems: [
      ...fallbackData.planItems.filter((item) => item.kind !== "ballot"),
      {
        id: "open-feed-ballot",
        kind: "ballot",
        title: "Open contract ballot",
        meta: "Closes Friday",
        action: "Vote",
        closed: false,
        quorum: { totalVotes: 420, quorumTarget: 800 },
      },
      {
        id: "feed-ballot",
        kind: "ballot",
        title: "Contract vote",
        closed: true,
        closesAt: "2026-08-18T19:00:00.000Z",
        quorum: { totalVotes: 812 },
      },
    ],
  };
}

function installIntersectionObserver() {
  const observers = [];
  class MockIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observe = vi.fn();
      this.disconnect = vi.fn();
      observers.push(this);
    }
  }
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  return observers;
}

function renderToday(data, props = {}) {
  return render(
    <LanguageProvider lang="en">
      <TodayView data={data} desktop onPlanAction={vi.fn()} {...props} />
    </LanguageProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Today chapter activity feed", () => {
  // Union Ground has no member PIN or step-up session, so Home has one
  // session shape; grievance steps are left out, so a case row never shows one.
  it("shows the active issue reference on Home without a grievance step", () => {
    installIntersectionObserver();
    const data = { ...activityData(), cases: [{ id: "private-case", status: "active", reference: "PRIVATE-CASE", title: "Private case title", step: "Private case step", deadline: "Jun 21" }] };
    renderToday(data, { onOpenCases: vi.fn() });
    expect(screen.getAllByText(/PRIVATE-CASE/).length).toBeGreaterThan(0);
    const checkRow = [...document.querySelectorAll(".home-row")].find((row) => row.textContent.includes("PRIVATE-CASE"));
    expect(checkRow).toBeTruthy();
    expect(checkRow.textContent).toContain("PRIVATE-CASE · Jun 21");
    expect(screen.queryByText(/Private case step/)).not.toBeInTheDocument();
  });
  it("shows the chapter steward contact cards", () => {
    installIntersectionObserver();
    const data = { ...activityData(), chapterStewards: [{ id: "steward-proof", name: "Private steward card", roleLabel: "steward", chapterLabel: "Proof chapter" }] };
    renderToday(data);
    expect(screen.getByText("Private steward card")).toBeInTheDocument();
  });
  it("keeps twenty newest rows until Show all is activated, without an auto-grow observer", () => {
    const observers = installIntersectionObserver();
    renderToday(activityData());

    const feed = screen.getByRole("region", { name: "Campaign activity" });
    expect(feed.querySelectorAll(".home-row")).toHaveLength(HOME_FEED_PAGE);
    expect(HOME_FEED_PAGE).toBe(20);
    expect(feed.querySelector(".home-row")).toHaveTextContent("Negotiations update");
    expect(observers).toHaveLength(0);
    const toggle = within(feed).getByRole("button", { name: "Show all (42)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls"))).toContainElement(feed.querySelector(".home-row"));
    toggle.focus();
    fireEvent.click(toggle);
    expect(feed.querySelectorAll(".home-row")).toHaveLength(42);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(feed).queryByText(/whole archive/)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveFocus();
    expect(feed.querySelectorAll(".home-row")).toHaveLength(20);
  });

  it("routes current broadcasts and leaves held events and closed ballots out of Home", () => {
    installIntersectionObserver();
    const onOpenMessages = vi.fn();
    const onOpenEvents = vi.fn();
    const onPlanAction = vi.fn();
    const data = activityData();
    renderToday(data, { onOpenMessages, onOpenEvents, onPlanAction });

    const feed = screen.getByRole("region", { name: "Campaign activity" });
    fireEvent.click(within(feed).getByRole("button", { name: /Negotiations update/ }));
    expect(onOpenMessages).toHaveBeenCalledTimes(1);
    expect(onOpenEvents).not.toHaveBeenCalled();
    expect(within(feed).queryByText("Retiree picnic")).toBeNull();
    expect(within(feed).queryByText("Contract vote")).toBeNull();
    expect(onPlanAction).not.toHaveBeenCalled();

    const openVote = document.querySelector(".home-vote");
    fireEvent.click(within(openVote).getByRole("button", { name: "Cast vote" }));
    fireEvent.click(within(openVote).getByRole("button", { name: "Read summary" }));
    const quickAction = [...document.querySelectorAll(".home-actions .home-action-row__cta")]
      .find((button) => !button.disabled);
    fireEvent.click(quickAction);
    expect(onPlanAction).toHaveBeenCalledWith(expect.objectContaining({ id: "open-feed-ballot" }));
  });

  it("keeps remaining current updates accessible when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    renderToday(activityData());

    const feed = screen.getByRole("region", { name: "Campaign activity" });
    expect(feed.querySelectorAll(".home-row")).toHaveLength(HOME_FEED_PAGE);
    fireEvent.click(within(feed).getByRole("button", { name: "Show all (42)" }));
    expect(feed.querySelectorAll(".home-row")).toHaveLength(42);
  });

  it("omits the section when the snapshot has no dated activity", () => {
    renderToday({ ...fallbackData, broadcasts: [], events: [], planItems: [] });
    expect(screen.queryByRole("region", { name: "Campaign activity" })).not.toBeInTheDocument();
  });
});

it('shows a range and a dated deadline in Home coming-up rows', () => {
  const data = { ...fallbackData, events: [
    { id: 'meeting', title: 'Timed meeting', startsAt: '2027-01-31T15:00:00Z', endsAt: '2027-01-31T16:30:00Z', chapterId: fallbackData.member.chapterId, isPast: false },
    { id: 'deadline', title: 'Dated deadline', eventKind: 'deadline', eventDate: '2027-02-01', startsAt: null, chapterId: fallbackData.member.chapterId, isPast: false },
  ] };
  const { container } = renderToday(data);
  expect(screen.getByText('Timed meeting').parentElement).toHaveTextContent(' – ');
  expect(container).toHaveTextContent('Deadline');
});


it("does not repeat an expired training invitation beside the Home guides", () => {
  const now = Date.now();
  renderToday({ ...fallbackData, events: [], planItems: [], broadcasts: [
    { id: "old-training", title: "Steward training — October 3", publishedAt: new Date(now - 45 * 86400000).toISOString() },
    { id: "current-meeting", title: "Next chapter meeting", publishedAt: new Date(now - 86400000).toISOString() },
  ] });
  expect(screen.queryByText("Steward training — October 3")).toBeNull();
  expect(screen.getByRole("region", { name: "Campaign activity" })).toHaveTextContent("Next chapter meeting");
});

it("keeps a recent update dated clearly across New Year and supports legacy upcoming event labels", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-01T12:00:00Z"));
  try {
    const { container } = renderToday({ ...fallbackData, planItems: [], events: [
      { id: "legacy", title: "Tamarack chapter meeting", dateLabel: "Jan 5", timeLabel: "2 PM", isPast: false },
      { id: "undated", title: "Tamarack meeting details pending", isPast: false },
    ], broadcasts: [
      { id: "year-end", title: "Year-end chapter update", publishedAt: "2026-12-31T12:00:00Z" },
    ] });
    expect(container.querySelector(".home-feed")).toHaveTextContent("2026");
    expect(container).toHaveTextContent("Tamarack chapter meeting");
    expect(container).toHaveTextContent("Tamarack meeting details pending");
  } finally {
    vi.useRealTimers();
  }
});
