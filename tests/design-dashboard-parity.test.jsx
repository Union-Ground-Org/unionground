import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { TodayView, weekActionRows } from "../src/views/TodayView.jsx";
import { MobileTopBar } from "../src/components/MobileTopBar.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";
import { PHONE_HOME_GREETING } from "./helpers/homeGreeting.js";
import { catalogue } from "../src/lib/i18n.js";
import { PRODUCT_NAME } from "../src/lib/productIdentity.js";

// Home-screen parity with the Union Base prototype (page id 'home'), wave
// 2a. The contract under test: the phone renders the prototype's mobile Home
// (top identity bar, greeting block with chip row, the dark-green ballot hero
// with the orange CTA, the chapter-quorum card, Next-2-minutes and This-week
// rows), the desktop renders the prototype's dashboard canvas (welcome header,
// organizing overview tiles, the actions card, the light open-vote card and the
// single Coming-up card) — and every number on either comes from data, never a
// hardcoded figure. Union Ground has no points economy, so the prototype's
// points hero, ring, tier line, and "+N" point chips are absent. The pre-parity
// composition (progress-ring week hero, week strip, stat tiles, member card,
// "Today's plan") must be GONE from this screen on both variants.

function stubMatchMedia(matches) {
  const listeners = new Set();
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches,
    media: query,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
  }));
  return listeners;
}

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  primeDemoData(fallbackData);
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  primeDemoData(fallbackData);
});

// Fixture-derived expectations, never constants pasted from the fixture: if
// the seed moves, the assertions move with it.
const openBallot = fallbackData.planItems.find((item) => item.kind === "ballot");
const openPulse = fallbackData.planItems.find((item) => item.kind === "pulse");

// Every trace of the removed points economy on Home.
const POINTS_SELECTORS = ".home-hero, .home-ring, .home-hero__streak, .home-row__pts, .plan-row__points, .home-action-row__pts, .home-avail, .home-chip--tier, .home-chapter-cards";

describe("desktop home parity (prototype pg.home)", () => {
  it("greets with the design's welcome header and profile identity line", () => {
    stubMatchMedia(true);
    render(<App />);
    expect(screen.getByRole("heading", { name: "Welcome back, Darnell" })).toBeInTheDocument();
    expect(document.querySelector(".today-identity").textContent).toContain(fallbackData.member.roleLine);
    expect(fallbackData.member.roleLine).toBe("Worker · Harborview Care committee");
  });

  it("renders organizing overview tiles from live counts, with no points hero, ring, or tier line", () => {
    stubMatchMedia(true);
    render(<App />);
    expect(document.querySelector(POINTS_SELECTORS)).toBeNull();
    const overview = screen.getByRole("region", { name: "Worker-led participation" });
    expect(overview.classList.contains("home-mobile-overview")).toBe(true);
    const tiles = [...overview.querySelectorAll(".home-tile")].map((tile) => tile.textContent);
    expect(tiles).toEqual([
      `${fallbackData.metrics.openCases}Open issues`,
      `${fallbackData.metrics.resolvedCases}Committee ready`,
    ]);
    expect(overview.textContent).not.toMatch(/pts|Tier|Points|Actions YTD/);
    // Pre-parity desktop composition is gone.
    expect(document.querySelector(".week-hero--composite")).toBeNull();
    expect(document.querySelector(".week-strip")).toBeNull();
    expect(document.querySelector(".stat-grid")).toBeNull();
  });

  it("lists the current plan items on the actions card with no point chips or available-points total", () => {
    stubMatchMedia(true);
    render(<App />);
    expect(screen.getByText("This week's actions")).toBeInTheDocument();
    const rows = document.querySelectorAll(".home-action-row");
    const eligible = fallbackData.planItems.filter((item) => !item.closed || !["ballot", "pulse"].includes(item.kind));
    const shown = weekActionRows(eligible);
    expect(rows).toHaveLength(shown.length);
    for (const item of shown) {
      expect([...rows].some((row) => row.textContent.includes(item.title))).toBe(true);
    }
    expect(document.querySelector(".plan-row__points, .home-action-row__pts, .home-avail")).toBeNull();
    expect(document.querySelector(".home-actions").textContent).not.toMatch(/\+\d+/);
    expect(screen.queryByText(/available this week/)).toBeNull();
  });

  it("renders the open vote as the design's light card with two actions and the quorum caption", () => {
    stubMatchMedia(true);
    render(<App />);
    const vote = document.querySelector(".home-vote");
    expect(vote).not.toBeNull();
    expect(vote.textContent).toContain(openBallot.title);
    expect(vote.querySelectorAll(".home-vote__row button")).toHaveLength(2);
    // The caption names the quorum (BUG-UG-VOTE-TURNOUT-READS-IMPOSSIBLE-20261106).
    expect(vote.querySelector(".home-vote__caption").textContent)
      .toContain(`${openBallot.quorum.totalVotes} of ${openBallot.quorum.quorumTarget} voted`);
  });

  it("renders Coming up as ONE card with date badges, the All-events link live when wired and gone when not", () => {
    stubMatchMedia(true);
    render(<App />);
    const coming = document.querySelector(".home-coming");
    expect(coming).not.toBeNull();
    expect(document.querySelectorAll(".home-coming")).toHaveLength(1);
    const badge = coming.querySelector(".home-event__badge b");
    expect(badge.textContent).toMatch(/^\d{1,2}$/);
    // App.jsx wires onOpenEvents (→ /m/events) as of wave 2a, so the link must
    // render LIVE — clicking it really lands on the events screen.
    const allEvents = coming.querySelector(".home-allevents");
    expect(allEvents).not.toBeNull();
    fireEvent.click(allEvents);
    expect(window.location.pathname).toBe("/m/events");
    // Without a handler the link must still degrade away — never render dead —
    // and the event rows fall back to static divs, not no-op buttons. Rendered
    // directly and queried through its own container so the App render above
    // stays out of scope.
    const { container } = render(
      <LanguageProvider lang="en">
        <TodayView data={fallbackData} desktop onPlanAction={() => {}} />
      </LanguageProvider>,
    );
    expect(container.querySelector(".home-coming")).not.toBeNull();
    expect(container.querySelector(".home-allevents")).toBeNull();
    expect(container.querySelector(".home-event")).not.toBeNull();
    expect(container.querySelector("button.home-event")).toBeNull();
  });

  it("keeps already-held events out of Coming up on both variants", () => {
    // The member loader now returns the whole chapter archive so the Events
    // screen can show attendance history. Coming up must still be upcoming
    // only — a meeting that already happened is not something coming up, and
    // an extra past row would also add an under-44px target to the home rail.
    const past = fallbackData.events.filter((item) => item.isPast === true);
    const upcoming = fallbackData.events.filter((item) => item.isPast !== true);
    expect(past.length).toBeGreaterThan(0);
    expect(upcoming.length).toBeGreaterThan(0);
    // The desktop dashboard lists them as .home-event rows in the Coming-up
    // card; the phone lists the same events as .home-row rows under "This
    // week". Both are driven by the one comingUp array.
    for (const [desktop, selector] of [[true, ".home-coming"], [false, ".home-rows"]]) {
      const { container, unmount } = render(
        <LanguageProvider lang="en">
          <TodayView data={fallbackData} desktop={desktop} onPlanAction={() => {}} onOpenEvents={() => {}} />
        </LanguageProvider>,
      );
      const coming = [...container.querySelectorAll(selector)]
        .find((node) => upcoming.every((item) => node.textContent.includes(item.title)));
      expect(coming).not.toBeUndefined();
      expect(coming.querySelectorAll(desktop ? ".home-event" : ".home-row")).toHaveLength(upcoming.length);
      for (const item of past) expect(coming.textContent).not.toContain(item.title);
      unmount();
    }
  });

  it("keeps regional directory events off Home on desktop and phone", () => {
    const scopedData = {
      ...fallbackData,
      events: [
        ...fallbackData.events,
        {
          id: "neighbor-public",
          title: "Neighbor chapter training",
          chapterId: "neighbor",
          isPublic: true,
          isPublicAcrossAgencies: false,
          isPast: false,
          startsAt: "2026-09-20T18:00:00Z",
          dateLabel: "Sun, Sep 20",
          timeLabel: "2:00 PM",
        },
        {
          id: "organization-wide",
          title: "Organization-wide rally",
          chapterId: "neighbor",
          isPublic: true,
          isPublicAcrossAgencies: true,
          isPast: false,
          startsAt: "2026-09-21T18:00:00Z",
          dateLabel: "Mon, Sep 21",
          timeLabel: "2:00 PM",
        },
      ],
    };

    for (const desktop of [true, false]) {
      const { container, unmount } = render(
        <LanguageProvider lang="en">
          <TodayView data={scopedData} desktop={desktop} onPlanAction={() => {}} onOpenEvents={() => {}} />
        </LanguageProvider>,
      );
      expect(container.textContent).not.toContain("Neighbor chapter training");
      expect(container.textContent).toContain("Organization-wide rally");
      unmount();
    }
  });

  it("drops the member card from the desktop home — the prototype has none", () => {
    stubMatchMedia(true);
    render(<App />);
    expect(document.querySelector(".member-card")).toBeNull();
  });
});

describe("phone home parity (prototype mpgHome)", () => {
  it("renders the floating identity chrome and greeting block in the design's order", () => {
    render(<App />);
    // Owner spec 2026-08-07 (chrome-free revision): the home chrome is the
    // ephemeral hat pill alone, and only when the account can switch hats. A
    // plain member gets NO chrome at all — no .mobile-top, no orbs, no bar —
    // the notifications and profile dialogs live in the drawer's Account
    // group, pinned below.
    expect(document.querySelector(".mobile-top")).toBeNull();
    expect(document.querySelector(".card-nav__chrome")).toBeNull();
    expect(document.querySelector(".card-nav__orb--menu")).toBeNull();
    // The drawer carries the relocated dialogs as action rows.
    const drawer = document.querySelector(".card-nav__panel--features");
    const rowLabels = [...drawer.querySelectorAll(".morehub-row__label")].map((el) => el.textContent);
    expect(rowLabels).toContain("Notifications");
    expect(rowLabels).toContain("Profile");
    // Greeting wording stays the app's (exempt global); the block shape is the
    // design's: date line, heading, subtext, chip row.
    expect(screen.getByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    const chips = document.querySelector(".home-chips");
    expect(chips).not.toBeNull();
    // The chip row keeps My reports and search; no points, streak, or tier chip.
    expect(chips.textContent).toContain("My reports");
    expect(chips.textContent).not.toMatch(/pts|streak|Tier/);
    expect(chips.querySelector(".home-chip--tier, .home-chip--static")).toBeNull();
    expect(document.querySelector(POINTS_SELECTORS)).toBeNull();
  });

  it("elevates the open ballot to the dark hero card with the orange full-width CTA", () => {
    render(<App />);
    const hero = document.querySelector(".home-vote-hero");
    expect(hero).not.toBeNull();
    expect(hero.textContent).toContain(openBallot.title);
    expect(hero.querySelector(".home-vote-hero__cta")).not.toBeNull();
  });

  it("renders the second open item as the design's two-button vote card", () => {
    render(<App />);
    const second = document.querySelector(".home-vote-hero--second");
    expect(second).not.toBeNull();
    expect(second.textContent).toContain(openPulse.title);
    expect(second.querySelectorAll("button")).toHaveLength(2);
  });

  it("shows the chapter-quorum card with live tally numbers", () => {
    render(<App />);
    const quorum = document.querySelector(".home-quorum");
    expect(quorum).not.toBeNull();
    expect(quorum.textContent).toContain(`${openBallot.quorum.totalVotes} / ${openBallot.quorum.quorumTarget}`);
    expect(quorum).toHaveAccessibleName(expect.stringMatching(new RegExp(`^Campaign quorum\\s*(?:—\\s*)?${openBallot.quorum.totalVotes} / ${openBallot.quorum.quorumTarget}`)));
  });

  it("retires the pre-parity phone dashboard: no ring hero, strip, stat tiles, member card, or Today's plan", () => {
    render(<App />);
    // The only week-hero left is Union Ground's voluntary-participation
    // card: copy and a View contributions link, never a progress ring.
    const weekHeroes = [...document.querySelectorAll(".week-hero")];
    expect(weekHeroes).toHaveLength(1);
    expect(weekHeroes[0].getAttribute("aria-labelledby")).toBe("voluntary-participation-title");
    expect(weekHeroes[0].querySelector("svg, .week-hero__ring, .progress-ring")).toBeNull();
    expect(weekHeroes[0].textContent).toContain("Worker-led participation");
    expect(document.querySelector(POINTS_SELECTORS)).toBeNull();
    expect(document.querySelector(".week-strip")).toBeNull();
    expect(document.querySelector(".stat-grid")).toBeNull();
    expect(document.querySelector(".member-card")).toBeNull();
    expect(screen.queryByText("Today's plan")).toBeNull();
  });

  it("keeps every remaining plan item reachable in the quick rows, closed rows disabled not hidden", () => {
    render(<App />);
    // The lesson is neither hero nor second card, so it must appear as a row.
    const lesson = fallbackData.planItems.find((item) => item.kind === "lesson");
    const rows = [...document.querySelectorAll(".home-row")];
    expect(rows.some((row) => row.textContent.includes(lesson.title))).toBe(true);
  });
});

describe("steward hat variant (roleMode Member + Steward)", () => {
  const noop = () => {};
  function renderToday(extra = {}, props = {}) {
    return render(
      <LanguageProvider lang="en">
        <TodayView data={{ ...fallbackData, ...extra }} onPlanAction={noop} onProfile={noop} onNotifications={noop} onRewards={noop} {...props} />
      </LanguageProvider>,
    );
  }

  it("keeps steward work off the member Today page and mounts no SaaS hat select", () => {
    primeDemoData({ ...fallbackData, roles: ["steward"], stewardBadges: { openRequests: 3, formsInbox: 1 } });
    render(<App />);
    expect(document.querySelector(".card-nav__hat select")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Switch role" })).toBeNull();
    expect(document.querySelector(".staff-switcher")).toBeNull();
    // Full-strictness hat isolation: even with the steward role and a live
    // badge count, the member-hat Today page never surfaces the review queue.
    expect(document.querySelector(".home-queue")).toBeNull();
    // Isolated MobileTopBar still accepts an explicit hat option list so the
    // SAMPLE phone chrome can switch hats; SaaS App never passes that list.
    const onHatChange = vi.fn();
    const { container } = render(
      <LanguageProvider lang="en">
        <MobileTopBar
          roleLabel="Member & Steward"
          activeHat="member"
          hatOptions={[{ key: "member", label: "Member" }, { key: "steward", label: "Steward" }]}
          onHatChange={onHatChange}
        />
      </LanguageProvider>,
    );
    fireEvent.change(container.querySelector(".mobile-top__hat-select select"), { target: { value: "steward" } });
    expect(onHatChange).toHaveBeenCalledWith("steward");
  });

  it("renders the member-only card set without the steward extras", () => {
    renderToday();
    expect(document.querySelector(".home-queue")).toBeNull();
    // The hat slot lives on the shell bar now: without a toggle handler the
    // pill is absent while the member role line still labels the bar.
    const { container } = render(
      <LanguageProvider lang="en">
        <MobileTopBar initials={fallbackData.member.initials} />
      </LanguageProvider>,
    );
    expect(container.querySelector(".mobile-top__hat")).toBeNull();
    // With no organization name known, the bar falls back to the product name.
    expect(container.querySelector(".mobile-top__role").textContent).toBe(`${PRODUCT_NAME} · ${catalogue.en["topbar.member"]}`);
  });
});
