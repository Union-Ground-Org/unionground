import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { CasesView } from "../src/views/CasesView.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { RightsView } from "../src/views/RightsView.jsx";
import { TodayView } from "../src/views/TodayView.jsx";
import { VoiceView } from "../src/views/VoiceView.jsx";
import { VotingView } from "../src/views/VotingView.jsx";

const noop = vi.fn();

function textFor(Component, props, desktop) {
  const view = render(
    <LanguageProvider lang="en">
      <Component {...props} desktop={desktop} />
    </LanguageProvider>,
  );
  const text = view.container.textContent;
  view.unmount();
  return text;
}

function expectBoth(Component, props, expected) {
  const values = expected.filter(Boolean);
  expect(values.length, "parity comparison had no expected values").toBeGreaterThan(0);
  const phone = textFor(Component, props, false);
  const desktop = textFor(Component, props, true);
  for (const value of values) {
    expect(phone, `phone omitted: ${value}`).toContain(value);
    expect(desktop, `desktop omitted: ${value}`).toContain(value);
  }
}

describe("mobile and desktop page content parity", () => {
  it("fails a parity comparison whose expected list is empty", () => {
    const EmptyView = () => <div />;
    expect(() => expectBoth(EmptyView, {}, [])).toThrow(/parity comparison had no expected values/);
    expect(() => expectBoth(EmptyView, {}, [null, "", undefined, false])).toThrow(/parity comparison had no expected values/);
  });

  it("keeps every Home event and backed overview fact in both layouts", () => {
    expectBoth(TodayView, {
      data: fallbackData,
      onPlanAction: noop,
      onAssistant: noop,
      onRewards: noop,
      onOpenReports: noop,
      onOpenSearch: noop,
      onOpenEvents: noop,
      onOpenWorkload: noop,
      onOpenCases: noop,
    }, [
      // Upcoming only: Home's Coming-up/This-week list is a forward window,
      // and the archive the loader now returns belongs to the Events screen.
      // Past rows are asserted absent from BOTH layouts below, so dropping
      // them can never become a phone-vs-desktop parity hole.
      ...fallbackData.events.filter((event) => event.isPast !== true).map((event) => event.title),
      // Union Ground's organizing overview tiles (no points economy).
      "Open issues",
      "Committee ready",
      "Worker-led participation",
      "View contributions",
      "Log this week's caseload",
      "Ask the Guide anything",
    ]);
    // Neither layout may bring back the removed points economy: no points
    // ring, tier hero, points/streak/tier chips, or "+N" point chips.
    for (const desktop of [false, true]) {
      const view = render(
        <LanguageProvider lang="en">
          <TodayView data={fallbackData} desktop={desktop} onPlanAction={noop} onRewards={noop} onOpenWorkload={noop} />
        </LanguageProvider>,
      );
      expect(view.container.querySelector(".home-ring, .home-hero, .home-row__pts, .plan-row__points, .home-avail, .home-chip--tier")).toBeNull();
      const text = view.container.textContent;
      expect(text).not.toMatch(/\bpts\b/);
      expect(text).not.toContain("Actions YTD");
      expect(text).not.toMatch(/\bTier\b/);
      view.unmount();
    }
    const past = fallbackData.events.filter((event) => event.isPast === true);
    expect(past.length).toBeGreaterThan(0);
    for (const desktop of [false, true]) {
      // Past rows stay out of the forward-looking Coming-up/This-week window.
      // W5: Home is a current briefing in both layouts. Held events remain
      // available on Events rather than returning through Chapter activity.
      const view = render(
        <LanguageProvider lang="en">
          <TodayView data={fallbackData} desktop={desktop} onPlanAction={noop} onOpenEvents={noop} />
        </LanguageProvider>,
      );
      const feed = view.container.querySelector(".home-feed");
      const feedText = feed?.textContent || "";
      feed?.remove();
      const forwardText = view.container.textContent;
      for (const event of past) {
        expect(forwardText, `past event outside the feed: ${event.title}`).not.toContain(event.title);
        expect(feedText).not.toContain(event.title);
      }
      view.unmount();
    }
  });

  it("keeps every open ballot and pulse in both Voting layouts", () => {
    // Closed ballots are asserted separately below: the phone stacks them on
    // the same screen, but desktop parks them behind the Past-votes tab, so a
    // default render legitimately omits them from the desktop text.
    expectBoth(VotingView, {
      data: fallbackData,
      onPlanAction: noop,
      onMessageSteward: noop,
      onSuggestPoll: noop,
    }, fallbackData.planItems
      .filter((item) => (item.kind === "ballot" && !item.closed) || item.kind === "pulse")
      .map((item) => item.title));
  });

  it("keeps every closed ballot reachable in both Voting layouts (Past tab)", () => {
    const closedTitles = fallbackData.planItems
      .filter((item) => item.kind === "ballot" && item.closed)
      .map((item) => item.title);
    expect(closedTitles.length).toBeGreaterThan(0);
    // Both layouts now park closed ballots behind the same routed Past tab:
    // /m/voting/past is a focused page, and the phone advertises it too so the
    // parent is discoverable at 390.
    const phoneView = render(
      <LanguageProvider lang="en">
        <VotingView data={fallbackData} onPlanAction={noop} onMessageSteward={noop} onSuggestPoll={noop} />
      </LanguageProvider>,
    );
    const phonePast = [...phoneView.container.querySelectorAll(".voting-tab")].find((tab) => tab.textContent.includes("Past"));
    expect(phonePast).toBeTruthy();
    fireEvent.click(phonePast);
    const phone = phoneView.container.textContent;
    const desktopView = render(
      <LanguageProvider lang="en">
        <VotingView data={fallbackData} desktop onPlanAction={noop} onMessageSteward={noop} onSuggestPoll={noop} />
      </LanguageProvider>,
    );
    const pastTab = [...desktopView.container.querySelectorAll(".voting-tab")].find((tab) => tab.textContent.includes("Past"));
    fireEvent.click(pastTab);
    const desktop = desktopView.container.textContent;
    for (const title of closedTitles) {
      expect(phone, `phone omitted: ${title}`).toContain(title);
      expect(desktop, `desktop Past tab omitted: ${title}`).toContain(title);
    }
    desktopView.unmount();
    phoneView.unmount();
  });

  // #9569 (site audit B-8): the desktop card's strip shows stages only, so a
  // case note is no longer printed there as a step. Both layouts still show
  // each active case's latest note on the card (the phone's case timeline and
  // the desktop Latest bar), and every note stays one tap away in the case
  // dialog's history.
  it("keeps each active case's latest note in both Cases layouts", () => {
    const activeCases = fallbackData.cases.filter((item) => item.status === "active");
    const titles = fallbackData.cases.map((item) => item.title);
    const timeline = activeCases.map((item) => [...item.updates].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1)?.body);
    const props = {
      data: fallbackData,
      onMessages: noop,
      onCreateCase: noop,
      onUpdateCase: noop,
      onAddCaseUpdate: noop,
    };
    // Titles and timeline notes are compared separately so a populated title
    // list cannot mask an empty active-case timeline (or the reverse).
    expectBoth(CasesView, props, titles);
    expectBoth(CasesView, props, timeline);
  });

  it("keeps every rights guide plus support content in both Learn layouts", () => {
    expectBoth(RightsView, {
      data: fallbackData,
      onAssistant: noop,
      onSaveProgress: noop,
      onRequestSteward: noop,
    }, [
      ...fallbackData.rights.lessonRecords.map((item) => item.title),
      "The contract, searchable",
      "Learning pays",
    ]);
  });

  it("keeps the same recent asks in both Be heard layouts", () => {
    // fallbackData.guideThreads stays empty on purpose: demo Compass appends
    // onto a copy and tests/demo-compass.test.jsx pins the shared fixture.
    // The parity check still needs titles both layouts actually render.
    const recentAsks = [
      {
        id: "parity-ask-1",
        title: "Can I bring a steward to a fact-finding meeting?",
        created_at: "2026-08-12T14:00:00Z",
        updated_at: "2026-08-12T14:00:00Z",
      },
      {
        id: "parity-ask-2",
        title: "How many days do I have after a written warning?",
        created_at: "2026-08-10T15:00:00Z",
        updated_at: "2026-08-10T15:00:00Z",
      },
    ];
    expectBoth(VoiceView, {
      data: fallbackData,
      threads: recentAsks,
      onSuggest: noop,
      onMessageSteward: noop,
      onAssistant: noop,
    }, recentAsks.map((thread) => thread.title));
  });

  it("keeps channels, direct messages and announcements in both Messages layouts", () => {
    const topics = (fallbackData.product?.spaces || []).flatMap((space) => space.threads || []);
    expectBoth(MessagesView, {
      data: fallbackData,
      onSendMessage: noop,
      onReadConversation: noop,
      onReadBroadcast: noop,
      onOpenTopics: noop,
      onOpenCases: noop,
      onOpenRights: noop,
    }, [
      ...topics.map((item) => item.title),
      ...fallbackData.conversations.map((item) => item.sender),
      ...fallbackData.broadcasts.slice(0, 5).map((item) => item.title),
    ]);
  });
});
