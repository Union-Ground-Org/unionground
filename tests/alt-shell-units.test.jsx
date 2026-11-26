import { expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import AltNowPage from "../src/alt/AltNowPage.jsx";
import AltShell from "../src/alt/AltShell.jsx";
import AltSignedOut from "../src/alt/AltSignedOut.jsx";
import { AltShellContext, useAltShell } from "../src/alt/altShellContext.js";
import { BrandMark, ChapterAvatar, chapterRowLabel, Icon } from "../src/alt/icons.jsx";
import {
  calendarDaysBetween,
  formatClock,
  formatDay,
  formatEasternClock,
  formatNumber,
  formatShortDay,
  relativeTime,
  toDate,
} from "../src/alt/format.js";

// REQ-UG-ALT-SHELL-FOUNDATION-20261015: unit coverage for the
// alternate shell's components rendered directly with props. The whole-App
// journeys live in tests/alt-shell.test.jsx; these pin each branch of the
// chrome, the Now page and the formatting helpers on fixed fixtures.

// The Now page mounts the classic Home's feature cards. Their own behaviour
// has its own tests; here they are stand-ins that expose the callbacks the
// Now page hands them, so those wrappers are exercised too.
vi.mock("../src/features/memberHome/WhatMattersNowCard.jsx", async (importOriginal) => ({
  ...(await importOriginal()),
  WhatMattersNowCard: ({ onOpenCase, onOpenEvents, onOpenStewardDesk }) => (
    <div data-testid="what-matters">
      {onOpenCase ? <button type="button" onClick={() => onOpenCase("case-9")}>wm open case</button> : null}
      {onOpenEvents ? <button type="button" onClick={() => onOpenEvents()}>wm open events</button> : null}
      {onOpenStewardDesk ? <button type="button" onClick={() => onOpenStewardDesk()}>wm open steward desk</button> : null}
    </div>
  ),
}));
vi.mock("../src/features/memberHome/HomeNudgeSlot.jsx", async (importOriginal) => ({
  ...(await importOriginal()),
  HomeNudgeSlot: () => <div data-testid="home-nudges" />,
}));
vi.mock("../src/features/memberHome/HomeTakeover.jsx", async (importOriginal) => ({
  ...(await importOriginal()),
  HomeTakeover: () => <div data-testid="home-takeover" />,
}));
vi.mock("../src/features/learningContent/LearningHomeCard.jsx", async (importOriginal) => ({
  ...(await importOriginal()),
  LearningHomeCard: () => <div data-testid="learning-card" />,
}));
vi.mock("../src/features/orgSetup/SetupTwoStepNotice.jsx", async (importOriginal) => ({
  ...(await importOriginal()),
  SetupTwoStepNotice: () => null,
}));
vi.mock("../src/features/issueIntelligence/IssueSignals.jsx", async (importOriginal) => ({
  ...(await importOriginal()),
  IssueSignalBanner: () => <div data-testid="issue-signals" />,
}));
vi.mock("../src/features/memberHome/WelcomeBack.jsx", async (importOriginal) => ({
  ...(await importOriginal()),
  WelcomeBackScreen: ({ onDismiss, onOpenUpdates, onOpenCase }) => (
    <div data-testid="welcome-back">
      <button type="button" onClick={onDismiss}>wb dismiss</button>
      {onOpenUpdates ? <button type="button" onClick={onOpenUpdates}>wb updates</button> : null}
      {onOpenCase ? <button type="button" onClick={() => onOpenCase("case-7")}>wb case</button> : null}
    </div>
  ),
}));

const inEnglish = (node) => <LanguageProvider lang="en">{node}</LanguageProvider>;

// A message key plus its variables, so assertions read the branch taken.
const fakeT = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

const NOW = new Date(2026, 9, 15, 12, 0, 0); // October 15, 2026, noon local
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (offset) => new Date(NOW.getTime() + offset);

const realMatchMedia = window.matchMedia;

function stubMedia(initial) {
  const listeners = new Set();
  const media = {
    matches: initial,
    media: "(min-width:1081px)",
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  window.matchMedia = vi.fn(() => media);
  return {
    set(matches) {
      media.matches = matches;
      act(() => { for (const listener of listeners) listener(); });
    },
    listeners,
  };
}

afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  document.body.style.overflow = "";
});

describe("format.js", () => {
  it("toDate accepts dates and parseable values and rejects the rest", () => {
    expect(toDate(NOW)).toBe(NOW);
    expect(toDate(new Date("nope"))).toBeNull();
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate("")).toBeNull();
    expect(toDate("not a date")).toBeNull();
    expect(toDate("2026-10-15T12:00:00Z")).toEqual(new Date("2026-10-15T12:00:00Z"));
    expect(toDate(NOW.getTime())).toEqual(NOW);
  });

  it("counts calendar days, not 24-hour spans", () => {
    expect(calendarDaysBetween(new Date(2026, 9, 16, 0, 30), new Date(2026, 9, 15, 23, 30))).toBe(1);
    expect(calendarDaysBetween(NOW, NOW)).toBe(0);
    expect(calendarDaysBetween(new Date(2026, 9, 10), NOW)).toBe(-5);
  });

  it("describes the past at every scale", () => {
    expect(relativeTime(null, fakeT, NOW)).toBe("");
    expect(relativeTime(at(-10_000), fakeT, NOW)).toBe("altShell.justNow");
    expect(relativeTime(at(-5 * MINUTE), fakeT, NOW)).toBe('altShell.minutesAgo:{"count":5}');
    expect(relativeTime(at(-3 * HOUR), fakeT, NOW)).toBe('altShell.hoursAgo:{"count":3}');
    expect(relativeTime(at(-DAY), fakeT, NOW)).toBe("altShell.yesterday");
    expect(relativeTime(at(-4 * DAY), fakeT, NOW)).toBe('altShell.daysAgo:{"count":4}');
    expect(relativeTime(at(-21 * DAY), fakeT, NOW)).toBe('altShell.weeksAgo:{"count":3}');
    expect(relativeTime(at(-120 * DAY), fakeT, NOW)).toBe('altShell.monthsAgo:{"count":3}');
    expect(relativeTime(at(-400 * DAY), fakeT, NOW)).toBe("altShell.overYearAgo");
    // An hour that crosses midnight is "yesterday", not "1 hours ago".
    const earlyMorning = new Date(2026, 9, 15, 0, 30);
    expect(relativeTime(new Date(2026, 9, 14, 23, 0), fakeT, earlyMorning)).toBe("altShell.yesterday");
  });

  it("describes the future at every scale", () => {
    expect(relativeTime(at(10_000), fakeT, NOW)).toBe('altShell.inMinutes:{"count":1}');
    expect(relativeTime(at(20 * MINUTE), fakeT, NOW)).toBe('altShell.inMinutes:{"count":20}');
    expect(relativeTime(at(5 * HOUR), fakeT, NOW)).toBe('altShell.inHours:{"count":5}');
    expect(relativeTime(at(DAY), fakeT, NOW)).toBe("altShell.tomorrow");
    expect(relativeTime(at(6 * DAY), fakeT, NOW)).toBe('altShell.inDays:{"count":6}');
    expect(relativeTime(at(30 * DAY), fakeT, NOW)).toBe('altShell.inWeeks:{"count":4}');
    // Late evening: two hours ahead is already tomorrow.
    const lateEvening = new Date(2026, 9, 15, 23, 0);
    expect(relativeTime(new Date(2026, 9, 16, 1, 0), fakeT, lateEvening)).toBe("altShell.tomorrow");
  });

  it("uses the current time when no reference is given", () => {
    expect(relativeTime(new Date(Date.now() - 1_000), fakeT)).toBe("altShell.justNow");
  });

  it("formats days, clocks and numbers in the member's locale", () => {
    expect(formatDay(NOW, "en")).toBe("October 15");
    expect(formatDay(NOW, "en", { year: true })).toBe("October 15, 2026");
    expect(formatDay("", "en")).toBe("");
    expect(formatShortDay(NOW, "en")).toBe("Oct 15");
    expect(formatShortDay(null, "en")).toBe("");
    expect(formatClock(NOW, "en")).toMatch(/^12:00\sPM$/);
    expect(formatClock("bad", "en")).toBe("");
    expect(formatNumber(1234567, "en")).toBe("1,234,567");
    expect(formatNumber("12", "en")).toBe("12");
    expect(formatNumber("abc", "en")).toBe("");
    expect(formatNumber(Infinity, "en")).toBe("");
  });

  it("pins the side clock to Eastern time whatever the device zone", () => {
    // 16:05 UTC is 12:05 PM EDT on October 15, 2026.
    expect(formatEasternClock("2026-10-15T16:05:00Z", "en")).toMatch(/^12:05\sPM$/);
    // 17:30 UTC in January is 12:30 PM EST.
    expect(formatEasternClock("2026-01-15T17:30:00Z", "en")).toMatch(/^12:30\sPM$/);
    expect(formatEasternClock(null, "en")).toBe("");
  });

  it("falls back to the local clock when the zone cannot be formatted", () => {
    const original = Date.prototype.toLocaleTimeString;
    vi.spyOn(Date.prototype, "toLocaleTimeString").mockImplementation(function (locale, options) {
      if (options?.timeZone) throw new RangeError("no zone data");
      return original.call(this, locale, options);
    });
    expect(formatEasternClock(NOW, "en")).toMatch(/^12:00\sPM$/);
  });
});

describe("icons.jsx", () => {
  const source = readFileSync("src/alt/icons.jsx", "utf8");
  const names = [...source.matchAll(/^ {2}(\w+): '</gm)].map((match) => match[1]);

  it("draws every icon in the map, and the info icon for an unknown name", () => {
    expect(names.length).toBeGreaterThan(40);
    const { container } = render(<div>{names.map((name) => <Icon key={name} name={name} />)}</div>);
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(names.length);
    for (const svg of svgs) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("class")).toBeNull();
      expect(svg.innerHTML.length).toBeGreaterThan(0);
    }
    const { container: unknown } = render(<Icon name="no-such-icon" className="ug-x" />);
    const { container: info } = render(<Icon name="info" />);
    expect(unknown.querySelector("svg").getAttribute("class")).toBe("ug-x");
    expect(unknown.querySelector("svg").innerHTML).toBe(info.querySelector("svg").innerHTML);
  });

  // This edition draws the product's own mark (src/components/BrandMark.jsx:
  // the official tile when configured, the neutral initial otherwise), at the
  // alternate header's 36 px, never upstream's fixed svg.
  it("draws the product mark at the alternate header's size", () => {
    const { container } = render(<BrandMark />);
    const mark = container.querySelector(".brand-mark");
    expect(mark).not.toBeNull();
    expect(mark.getAttribute("width")).toBe("36");
    expect(mark.getAttribute("height")).toBe("36");
    expect(container.querySelector(".ug-brand-mark")).toBeNull();
  });

  it("renders chapter avatars from the abbreviation, the name or the id", () => {
    const { container } = render(
      <div>
        <ChapterAvatar chapter={null} />
        <ChapterAvatar chapter={{ id: "c1", name: "Chapter One", abbreviation: "wor" }} size="av-sm" />
        <ChapterAvatar chapter={{ id: "c2", name: "Riverside Health Workers United" }} size="av-xs" />
        <ChapterAvatar chapter={{ id: "c3", name: "Tacoma" }} />
        <ChapterAvatar chapter={{ name: "Seattle Central" }} />
        <ChapterAvatar chapter={{ id: "zeta" }} />
        <ChapterAvatar chapter={{}} />
      </div>,
    );
    const avatars = [...container.querySelectorAll(".ug-av")];
    expect(avatars.map((node) => node.textContent)).toEqual(["WOR", "RHW", "TAC", "SC", "ZET", ""]);
    expect(avatars[0].className).toBe("ug-av ug-av-sm");
    expect(avatars[1].className).toBe("ug-av ug-av-xs");
    expect(avatars[2].className).toBe("ug-av");
    // The colour is a stable function of the id.
    const { container: again } = render(<ChapterAvatar chapter={{ id: "c1", name: "Renamed" }} />);
    expect(again.querySelector(".ug-av").getAttribute("style")).toBe(avatars[0].getAttribute("style"));
  });

  // BUG-UG-YOUR-CHAPTERS-ENTRY-REPEATS-INITIALS-AS-LABEL-20261103.
  it("labels a chapter row with its name when the short label only repeats the initials", () => {
    expect(chapterRowLabel({ id: "ug", name: "Union Ground LLC workspace", abbreviation: "UGL" })).toBe("Union Ground LLC workspace");
    expect(chapterRowLabel({ id: "w", name: "Chapter One", abbreviation: "wor" })).toBe("Chapter One");
    expect(chapterRowLabel({ id: "ib", name: "Electrical Workers", abbreviation: "IBEW" })).toBe("IBEW");
    expect(chapterRowLabel({ id: "n", name: "No Short Label" })).toBe("No Short Label");
    expect(chapterRowLabel({ id: "x", abbreviation: "UGL" })).toBe("UGL");
    expect(chapterRowLabel(null)).toBe("");
  });
});

describe("AltSignedOut", () => {
  it("offers the way back to the landing page from the brand and the button", () => {
    const onBack = vi.fn();
    render(inEnglish(<AltSignedOut onBackToLanding={onBack}><p>form here</p></AltSignedOut>));
    expect(screen.getByText("form here")).toBeInTheDocument();
    expect(screen.getByText("Workers sign in with the account from their invitation.")).toBeInTheDocument();
    const brand = screen.getByRole("link", { name: "Union Ground" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    brand.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to the site" }));
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it("is a plain link home without a landing handler", () => {
    const { container } = render(inEnglish(<AltSignedOut />));
    expect(screen.queryByRole("button", { name: "Back to the site" })).toBeNull();
    const brand = screen.getByRole("link", { name: "Union Ground" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    brand.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(container.querySelector(".ugalt").getAttribute("data-shell")).toBe("alt");
  });
});

const CHAPTERS = [
  { id: "c1", name: "Chapter One", abbreviation: "ONE", category: "North", memberCount: 120, staffCount: 3 },
  { id: "c2", name: "Riverside Two", memberCount: 40 },
  { id: "c3", name: "Lakeside Three", abbreviation: "LK3", staffCount: 2 },
];

function shellProps(overrides = {}) {
  return {
    active: "today",
    activePath: "/m",
    onNavigate: vi.fn(),
    onSearch: vi.fn(),
    onAsk: vi.fn(),
    onNotifications: vi.fn(),
    notifCount: 3,
    user: { initials: "DS", name: "Dana Steward", onProfile: vi.fn() },
    activeHat: "member",
    hatOptions: [{ key: "member", label: "Worker" }, { key: "steward", label: "Committee desk" }],
    onSwitchHat: vi.fn(),
    chapters: CHAPTERS,
    selectedChapterId: "c1",
    onSelectChapter: vi.fn(),
    badges: { messages: 4 },
    customLinks: [{ key: "local", url: "https://example.org/local", label: "Local website" }],
    ...overrides,
  };
}

function ShellProbe() {
  const shell = useAltShell();
  return (
    <div>
      <p>page body</p>
      {shell?.openRail ? <button type="button" onClick={shell.openRail}>probe open rail</button> : <span>no rail offered</span>}
      <button type="button" onClick={shell.openMenu}>probe open menu</button>
      <button type="button" onClick={shell.closeAll}>probe close all</button>
    </div>
  );
}

function renderShell(overrides = {}, children = <ShellProbe />) {
  const props = shellProps(overrides);
  const view = render(inEnglish(<AltShell {...props}>{children}</AltShell>));
  return { props, ...view, rerenderShell: (next = {}, nextChildren = children) => view.rerender(inEnglish(<AltShell {...props} {...next}>{nextChildren}</AltShell>)) };
}

const side = () => within(document.getElementById("ug-side"));
const sheet = () => within(document.getElementById("ug-msheet"));
const rail = () => document.getElementById("ug-rail");
const footer = () => within(document.getElementById("ug-ftr"));

describe("AltShell on a wide screen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubMedia(true);
  });

  it("navigates from the side nav with plain clicks only", () => {
    const { props } = renderShell();
    expect(screen.getByText("page body")).toBeInTheDocument();
    const messages = side().getByRole("link", { name: /Messages/ });
    expect(within(messages).getByText("4")).toBeInTheDocument();
    fireEvent.click(messages);
    expect(props.onNavigate).toHaveBeenLastCalledWith("messages", "/m/messages", "");
    fireEvent.click(side().getByRole("link", { name: "Worker support" }), { ctrlKey: true });
    expect(props.onNavigate).toHaveBeenCalledTimes(1);
    fireEvent.click(side().getByRole("link", { name: "Worker support" }));
    expect(props.onNavigate).toHaveBeenLastCalledWith("memberSupport", "/m/support", "");
    fireEvent.click(side().getByRole("link", { name: "Union Ground" }));
    expect(props.onNavigate).toHaveBeenLastCalledWith("today", "/m", "");
    expect(side().getByRole("link", { name: "Now" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(side().getByRole("link", { name: /Get alerts/ }));
    expect(props.onNavigate).toHaveBeenLastCalledWith("settings", "/m/settings/notifications", "");
    fireEvent.click(within(document.getElementById("ug-hdr")).getByRole("link", { name: "Union Ground" }));
    expect(props.onNavigate).toHaveBeenLastCalledWith("today", "/m", "");
  });

  it("wires search, notifications, Ask, the profile, hats and custom links", () => {
    const { props } = renderShell();
    fireEvent.click(side().getByRole("button", { name: "Search" }));
    expect(props.onSearch).toHaveBeenCalledTimes(1);
    fireEvent.click(within(document.getElementById("ug-hdr")).getByRole("button", { name: "Search" }));
    expect(props.onSearch).toHaveBeenCalledTimes(2);
    fireEvent.click(side().getByRole("button", { name: "3 unread notifications" }));
    expect(props.onNotifications).toHaveBeenCalledTimes(1);
    fireEvent.click(side().getByRole("button", { name: "Ask the Guide" }));
    expect(props.onAsk).toHaveBeenCalledTimes(1);
    fireEvent.click(side().getByRole("button", { name: /Dana Steward/ }));
    expect(props.user.onProfile).toHaveBeenCalledTimes(1);
    expect(side().getByRole("button", { name: "Worker" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(side().getByRole("button", { name: "Committee desk" }));
    expect(props.onSwitchHat).toHaveBeenCalledWith("steward");
    const custom = side().getByRole("link", { name: "Local website" });
    expect(custom).toHaveAttribute("href", "https://example.org/local");
    expect(custom).toHaveAttribute("target", "_blank");
  });

  it("selects chapters from the side list and the footer", () => {
    const { props } = renderShell();
    const current = side().getByRole("button", { name: "Chapter One" });
    expect(current).toHaveAttribute("aria-current", "page");
    fireEvent.click(side().getByRole("button", { name: "Riverside Two" }));
    expect(props.onSelectChapter).toHaveBeenLastCalledWith(CHAPTERS[1], expect.any(HTMLElement));
    fireEvent.click(footer().getByRole("button", { name: "LK3" }));
    expect(props.onSelectChapter).toHaveBeenLastCalledWith(CHAPTERS[2], expect.any(HTMLElement));
  });

  it("opens the chapter rail, filters it, picks a chapter and closes it every way", () => {
    const { props } = renderShell();
    const switcher = side().getByRole("button", { name: "Switch campaign" });
    expect(switcher).toHaveAttribute("aria-expanded", "false");
    expect(rail()).toHaveAttribute("inert");
    switcher.focus();
    fireEvent.click(switcher);
    expect(switcher).toHaveAttribute("aria-expanded", "true");
    expect(rail()).not.toHaveAttribute("inert");
    expect(rail()).toHaveAttribute("role", "dialog");
    expect(rail().getAttribute("aria-modal")).toBeNull();
    // Wide: the rail is not modal, the page under it stays live.
    expect(document.getElementById("ug-side")).not.toHaveAttribute("inert");
    act(() => { vi.advanceTimersByTime(40); });
    const input = within(rail()).getByRole("searchbox");
    expect(document.activeElement).toBe(input);
    expect(within(rail()).getByText("North · 120 workers · 3 staff")).toBeInTheDocument();
    expect(within(rail()).getByText("Current")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "lk3" } });
    expect(within(rail()).getAllByRole("button", { name: /Lakeside Three/ })).toHaveLength(1);
    expect(within(rail()).getByText("1 campaigns match")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(within(rail()).getByText("No campaigns match “zzz”")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "river" } });
    fireEvent.click(within(rail()).getByRole("button", { name: /Riverside Two/ }));
    expect(props.onSelectChapter).toHaveBeenLastCalledWith(CHAPTERS[1], expect.any(HTMLElement));
    expect(switcher).toHaveAttribute("aria-expanded", "false");

    // The toggle closes it again and returns focus to the opener.
    switcher.focus();
    fireEvent.click(switcher);
    fireEvent.click(switcher);
    expect(switcher).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(switcher);

    // Escape closes it.
    fireEvent.click(switcher);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(switcher).toHaveAttribute("aria-expanded", "false");

    // Its own close control closes it.
    fireEvent.click(switcher);
    fireEvent.click(within(rail()).getByRole("button", { name: "Close campaign switcher" }));
    expect(switcher).toHaveAttribute("aria-expanded", "false");

    // A pointer press inside the rail keeps it; one elsewhere closes it.
    fireEvent.click(switcher);
    fireEvent.pointerDown(within(rail()).getByRole("searchbox"));
    expect(switcher).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(screen.getByText("page body"));
    expect(switcher).toHaveAttribute("aria-expanded", "false");

    // The scrim on a wide screen leaves an open rail alone.
    fireEvent.click(switcher);
    fireEvent.click(document.querySelector(".ug-side-scrim"));
    expect(switcher).toHaveAttribute("aria-expanded", "true");

    // The rail's directory link navigates and closes it.
    fireEvent.click(within(rail()).getByRole("link", { name: /My campaign page/ }));
    expect(props.onNavigate).toHaveBeenLastCalledWith("hub", "/m/organize", "");
    expect(switcher).toHaveAttribute("aria-expanded", "false");

    // The "Change" control in the label opens it too.
    fireEvent.click(side().getByRole("button", { name: "Change" }));
    expect(switcher).toHaveAttribute("aria-expanded", "true");
  });

  it("offers the rail and the menu to the page through the context", () => {
    renderShell();
    const switcher = side().getByRole("button", { name: "Switch campaign" });
    fireEvent.click(screen.getByRole("button", { name: "probe open rail" }));
    expect(switcher).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "probe close all" }));
    expect(switcher).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "probe open menu" }));
    // Desktop already shows the feature directory. Focus it instead of opening
    // a CSS-hidden mobile sheet that would make the visible page inert.
    expect(within(document.getElementById("ug-hdr")).getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(document.querySelector("#ug-side .ug-side-nav a"));
    expect(document.querySelector(".ug-body")).not.toHaveAttribute("inert");
  });

  it("returns focus to the side switcher when the page control that opened the rail is gone", () => {
    function Opener() {
      const shell = useAltShell();
      return <button type="button" onClick={shell.openRail}>page change chapters</button>;
    }
    const { rerenderShell } = renderShell({}, <Opener />);
    const opener = screen.getByRole("button", { name: "page change chapters" });
    opener.focus();
    fireEvent.click(opener);
    rerenderShell({}, <p>replaced</p>);
    fireEvent.keyDown(window, { key: "Escape" });
    const switcher = side().getByRole("button", { name: "Switch campaign" });
    expect(switcher).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(switcher);
  });

  it("closes the drawers when the active page changes and ticks the Eastern clock", () => {
    const { rerenderShell } = renderShell();
    const switcher = side().getByRole("button", { name: "Switch campaign" });
    fireEvent.click(switcher);
    rerenderShell({ active: "messages", activePath: "/m/messages" });
    expect(switcher).toHaveAttribute("aria-expanded", "false");
    expect(side().getByRole("link", { name: /Messages/ })).toHaveAttribute("aria-current", "page");
    const clock = () => document.querySelector("#ug-side .ug-side-tz").textContent;
    const before = clock();
    act(() => { vi.advanceTimersByTime(20 * MINUTE); });
    expect(clock()).not.toBe(before);
    expect(clock()).toMatch(/ET$/);
  });

  it("links the footer to member pages and to the classic shell", () => {
    window.history.replaceState({}, "", "/m/events?demo=1&shell=alt#top");
    const { props } = renderShell();
    fireEvent.click(footer().getByRole("link", { name: "Meetings" }));
    expect(props.onNavigate).toHaveBeenLastCalledWith("events", "/m/events", "");
    fireEvent.click(footer().getByRole("link", { name: "Site guide" }));
    expect(props.onNavigate).toHaveBeenLastCalledWith("siteGuide", "/m/guide", "");
    fireEvent.click(footer().getByRole("link", { name: "My issues" }));
    expect(props.onNavigate).toHaveBeenLastCalledWith("cases", "/m/cases", "");
    expect(footer().getByRole("link", { name: "Switch to the classic site" })).toHaveAttribute("href", "/m/events?demo=1&shell=classic#top");
    expect(footer().getByRole("link", { name: "Verify a vote receipt" })).toHaveAttribute("href", "/verify");
    window.history.replaceState({}, "", "/");
  });

  it("puts the most-used destinations first when usage weights exist", () => {
    renderShell({ navUsageWeights: [{ key: "events", weight: 9 }, { key: "voting", weight: 4 }], notifCount: 0, siteGuide: false, customLinks: [] });
    const nav = document.querySelector("#ug-side nav");
    expect(nav.querySelector(".ug-side-label").textContent).toBe("Most used");
    expect(side().getByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(footer().queryByRole("link", { name: "Site guide" })).toBeNull();
    expect(side().queryByText("Links")).toBeNull();
  });

  it("disables chapter rows while a chapter switch is in flight", async () => {
    // Focus fixup needs real rendering timers; only the shell clock is fixed.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const { props } = renderShell({ chapterBusy: true });
    expect((side().getByRole("button", { name: "Chapter One" })).closest('[aria-disabled="true"]')).not.toBeNull();
    await expectPendingFocus(side().getByRole("button", { name: "Chapter One" }));
    fireEvent.click(side().getByRole("button", { name: "Switch campaign" }));
    for (const button of within(rail()).getAllByRole("button", { name: /Chapter One|Riverside Two|Lakeside Three/ })) {
      expect(button.closest('[aria-disabled="true"]')).not.toBeNull();
      fireEvent.click(button);
    }
    expect(props.onSelectChapter).not.toHaveBeenCalled();
  });

  it("shows the current chapter as a link when there is no selector", () => {
    const { props } = renderShell({ onSelectChapter: null, chapters: [CHAPTERS[0]] });
    expect(screen.getByText("no rail offered")).toBeInTheDocument();
    expect(side().queryByRole("button", { name: "Switch campaign" })).toBeNull();
    fireEvent.click(side().getByRole("link", { name: "Chapter One" }));
    expect(props.onNavigate).toHaveBeenLastCalledWith("hub", "/m/organize", "");
    expect(footer().queryByRole("button", { name: "ONE" })).toBeNull();
  });

  it("renders no chapter rows for zero chapters or an unknown selection without a selector", () => {
    renderShell({ onSelectChapter: null, chapters: [], user: null, onAsk: null, onNotifications: null, onSearch: null, hatOptions: [] });
    expect(document.querySelector("#ug-side .ug-side-chs").children).toHaveLength(0);
    expect(side().queryByRole("button", { name: "Search" })).toBeNull();
    expect(side().queryByRole("button", { name: "Ask the Guide" })).toBeNull();
    expect(side().queryByText("Roles")).toBeNull();
    expect(within(rail()).getByText("No campaigns match “”")).toBeInTheDocument();
  });

  it("offers a single chapter with a selector but no switcher", () => {
    const { props } = renderShell({ chapters: [CHAPTERS[1]], selectedChapterId: "c2" });
    expect(side().queryByRole("button", { name: "Switch campaign" })).toBeNull();
    expect(side().queryByRole("button", { name: "Change" })).toBeNull();
    fireEvent.click(side().getByRole("button", { name: "Riverside Two" }));
    expect(props.onSelectChapter).toHaveBeenCalledWith(CHAPTERS[1], expect.any(HTMLElement));
  });

  // BUG-UG-YOUR-CHAPTERS-ENTRY-REPEATS-INITIALS-AS-LABEL-20261103:
  // a short label equal to the initials falls back to the name; a distinct one stays.
  it("never prints the initials twice in a Your campaigns row", () => {
    const workspace = { id: "ugl", name: "Union Ground LLC workspace", abbreviation: "UGL" };
    const electrical = { id: "ibew", name: "Electrical Workers", abbreviation: "IBEW" };
    const { props } = renderShell({ chapters: [workspace, electrical], selectedChapterId: "ugl" });
    const row = side().getByRole("button", { name: "Union Ground LLC workspace" });
    expect(row).toHaveAttribute("title", "Union Ground LLC workspace");
    expect(row).toHaveAttribute("aria-current", "page");
    expect(row.querySelector(".ug-av").textContent).toBe("UGL");
    expect(row.querySelector(".ug-t").textContent).toBe("Union Ground LLC workspace");
    const distinct = side().getByRole("button", { name: "IBEW" });
    expect(distinct.querySelector(".ug-av").textContent).toBe("IBE");
    expect(distinct.querySelector(".ug-t").textContent).toBe("IBEW");
    fireEvent.click(row);
    expect(props.onSelectChapter).toHaveBeenLastCalledWith(workspace, expect.any(HTMLElement));
    cleanup();
    renderShell({ onSelectChapter: null, chapters: [workspace], selectedChapterId: "ugl" });
    expect(side().getByRole("link", { name: "Union Ground LLC workspace" }).querySelector(".ug-t").textContent).toBe("Union Ground LLC workspace");
  });
});

describe("AltShell with a staff hat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubMedia(true);
  });

  it("offers the way back to Member and the hat's own pages, without member-only chrome", () => {
    const { props } = renderShell({ activeHat: "steward", active: "steward", activePath: "/m/steward" });
    expect(side().getByText("Workspace")).toBeInTheDocument();
    expect(side().queryByRole("button", { name: "Search" })).toBeNull();
    expect(side().queryByRole("link", { name: /Get alerts/ })).toBeNull();
    expect(footer().queryByText("Updates")).toBeNull();
    expect(footer().queryByText("Help")).toBeNull();
    expect(footer().queryByRole("link", { name: "Settings" })).toBeNull();
    const back = side().getAllByRole("button", { name: "Worker" })[0];
    fireEvent.click(back);
    expect(props.onSwitchHat).toHaveBeenCalledWith("member");
    expect(document.querySelector("#ug-side a[aria-current='page']")).not.toBeNull();
  });

  it("omits the Member destination when no hat switch is available", () => {
    const { props } = renderShell({ activeHat: "steward", active: "steward", onSwitchHat: null });
    expect(side().queryByRole("link", { name: "Worker" })).toBeNull();
    expect(side().queryByRole("button", { name: "Worker" })).toBeNull();
    expect(side().getByText("Workspace")).toBeInTheDocument();
    expect(props.onNavigate).not.toHaveBeenCalled();
    expect(side().queryByText("Roles")).toBeNull();
  });
});

describe("AltShell on a narrow screen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("opens the menu sheet as a modal and closes it with its button, the scrim and Escape", () => {
    stubMedia(false);
    const { props } = renderShell();
    const menu = within(document.getElementById("ug-hdr")).getByRole("button", { name: "Menu" });
    expect(document.getElementById("ug-msheet")).toHaveAttribute("inert");
    fireEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");
    for (const id of ["ug-side", "ug-hdr", "ug-ftr"]) expect(document.getElementById(id)).toHaveAttribute("inert");
    act(() => { vi.advanceTimersByTime(50); });
    const close = sheet().getByRole("button", { name: "Close menu" });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(document.body.style.overflow).toBe("");

    fireEvent.click(menu);
    fireEvent.click(document.querySelector(".ug-side-scrim"));
    expect(menu).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(menu);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(menu);
    expect(document.getElementById("ug-side")).not.toHaveAttribute("inert");

    // Actions inside the sheet close it.
    fireEvent.click(menu);
    fireEvent.click(sheet().getByRole("link", { name: /Messages/ }));
    expect(props.onNavigate).toHaveBeenLastCalledWith("messages", "/m/messages", "");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    for (const [name, handler] of [["Search", props.onSearch], ["3 unread notifications", props.onNotifications], ["Ask the Guide", props.onAsk]]) {
      fireEvent.click(menu);
      fireEvent.click(sheet().getByRole("button", { name }));
      expect(handler).toHaveBeenCalled();
      expect(menu).toHaveAttribute("aria-expanded", "false");
    }
    fireEvent.click(menu);
    fireEvent.click(sheet().getByRole("button", { name: /Dana Steward/ }));
    expect(menu).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menu);
    fireEvent.click(sheet().getByRole("button", { name: "Committee desk" }));
    expect(props.onSwitchHat).toHaveBeenCalledWith("steward");
    expect(menu).toHaveAttribute("aria-expanded", "false");
  });

  it("stacks the rail over the sheet as a modal and goes back to the menu", () => {
    stubMedia(false);
    const { props } = renderShell();
    const menu = within(document.getElementById("ug-hdr")).getByRole("button", { name: "Menu" });
    fireEvent.click(menu);
    const switcher = sheet().getByRole("button", { name: "Switch campaign" });
    switcher.focus();
    fireEvent.click(switcher);
    expect(rail()).toHaveAttribute("aria-modal", "true");
    expect(document.getElementById("ug-msheet")).toHaveAttribute("inert");
    act(() => { vi.advanceTimersByTime(40); });
    const back = within(rail()).getByRole("button", { name: "Back to menu" });
    expect(document.activeElement).toBe(back);
    // A press outside does not close a modal rail.
    fireEvent.pointerDown(screen.getByText("page body"));
    expect(rail()).toHaveAttribute("role", "dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(rail().getAttribute("role")).toBeNull();
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(switcher);

    fireEvent.click(switcher);
    fireEvent.click(back);
    expect(rail().getAttribute("role")).toBeNull();
    expect(menu).toHaveAttribute("aria-expanded", "true");

    // The scrim on a narrow screen closes both.
    fireEvent.click(switcher);
    fireEvent.click(document.querySelector(".ug-side-scrim"));
    expect(rail().getAttribute("role")).toBeNull();
    expect(menu).toHaveAttribute("aria-expanded", "false");

    // Picking a chapter in the sheet closes it.
    fireEvent.click(menu);
    fireEvent.click(sheet().getByRole("button", { name: "Riverside Two" }));
    expect(props.onSelectChapter).toHaveBeenLastCalledWith(CHAPTERS[1], expect.any(HTMLElement));
    expect(menu).toHaveAttribute("aria-expanded", "false");
  });

  it("drops the sheet when the screen widens and stops listening on unmount", () => {
    const media = stubMedia(false);
    const { unmount } = renderShell();
    const menu = within(document.getElementById("ug-hdr")).getByRole("button", { name: "Menu" });
    fireEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    media.set(true);
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(media.listeners.size).toBe(1);
    unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("renders as narrow when the browser has no matchMedia", () => {
    window.matchMedia = undefined;
    renderShell();
    fireEvent.click(side().getByRole("button", { name: "Switch campaign" }));
    expect(rail()).toHaveAttribute("aria-modal", "true");
  });
});

// The Now page's fixture: a member of chapter c1 with every kind of record.
function nowData(overrides = {}) {
  return {
    member: { id: "m1", organizationId: "org1", chapterId: "c1", chapterName: "Chapter One", roleLine: "Bus driver", sinceYear: 2019 },
    broadcasts: [
      { id: "b1", title: "Contract ratified", body: "Details inside.", sender: "Dana Steward", publishedAt: at(-2 * HOUR).toISOString() },
      { id: "b2", title: "Broken", body: "", sender: "", publishedAt: "not a date" },
      { id: "b3", title: "Older news", body: "", sender: "Lee", publishedAt: at(-5 * DAY).toISOString() },
    ],
    events: [
      { id: "ev-union", title: "Union-wide rally", isPublicAcrossAgencies: true, startsAt: at(3 * DAY).toISOString(), endsAt: at(3 * DAY + 2 * HOUR).toISOString(), eventKind: "meeting", location: "Capitol" },
      { id: "ev-today", chapterId: "c1", chapterName: "Chapter One", title: "Steward huddle", startsAt: at(3 * HOUR).toISOString(), startsLabel: "Today 3 PM", location: "Hall", summary: "Bring notes", rsvpCount: 12 },
      { id: "ev-public", chapterId: "c2", isPublicAcrossAgencies: true, title: "Open forum", eventDate: "2026-10-25" },
      { id: "ev-other", chapterId: "c9", title: "Someone else's meeting", startsAt: at(DAY).toISOString() },
      { id: "ev-past", chapterId: "c1", title: "Last month's meeting", startsAt: at(-2 * DAY).toISOString(), isPast: true },
      { id: "ev-tbd", title: "Date to be set", dateLabel: "Soon", timeLabel: "TBD" },
    ],
    planItems: [
      { id: "p-ballot", kind: "ballot", title: "Strike authorization", meta: "Chapter One", action: "Vote by Friday", closesAt: at(2 * DAY).toISOString(), quorum: { quorumTarget: 10, totalVotes: 4 } },
      { id: "p-receipt", kind: "ballot", title: "Bylaws vote", receiptCode: "RC-123" },
      { id: "p-closed", kind: "ballot", title: "Old ballot", closed: true, closesAt: at(-3 * DAY).toISOString() },
      { id: "p-pulse", kind: "pulse", title: "Pulse survey" },
      { id: "p-answered", kind: "pulse", title: "Answered survey", closed: true, selectedOption: "yes" },
      { id: "p-task", kind: "task", title: "Sign the petition" },
      { id: "p-form", kind: "form", title: "Update your address" },
      { id: "p-lesson", kind: "lesson", title: "Weingarten rights" },
      { id: "p-case", kind: "case", title: "Your grievance" },
      { id: "p-odd", kind: "mystery", title: "Unknown kind" },
    ],
    tasks: [
      { id: "t1", title: "Call members", assigneeId: "m1", taskNumber: 1, dueDate: "2026-10-20" },
      { id: "t2", title: "Fix the board", assigneeIds: ["m1"], taskNumber: 2, blocked: true },
      { id: "t3", title: "Third task", assigneeId: "m1", taskNumber: 3 },
      { id: "t4", title: "Fourth task", assigneeId: "m1", taskNumber: 4 },
      { id: "t5", title: "Fifth task", assigneeId: "m1", taskNumber: 5 },
      { id: "t6", title: "Sixth task", assigneeId: "m1", taskNumber: 6 },
      { id: "t7", title: "Done task", assigneeId: "m1", taskNumber: 7, status: "done" },
    ],
    chapterStewards: [
      { id: "s1", name: "Sam Steward", chapterLabel: "Chapter One", contact: { email: "sam@example.org", phone: "555-0101" } },
      { id: "s2", name: "Pat Steward", contact: { email: " " } },
      { id: "s3", name: "Robin Steward" },
      { id: "s4", name: "Alex Steward" },
      { id: "s5", name: "Jo Steward" },
    ],
    rights: { lessons: ["Weingarten rights", { title: "Overtime rules" }, { id: "lesson-id-only" }] },
    notifications: [
      { id: "n1", title: "Ballot opens", body: "Vote now", created_at: at(-HOUR).toISOString() },
      { id: "n2", title: "No date", body: "Undated" },
      { id: "n3", title: "Already read", body: "Read", read_at: at(-DAY).toISOString() },
    ],
    conversations: [{ id: "cv1", unread: 2 }, { id: "cv2", unread: "x" }],
    cases: [{ id: "case-1", status: "active", reference: "C-1", title: "Overtime" }, { id: "case-2", status: "closed" }],
    metrics: { openCases: 1 },
    rewards: { tierNumber: 1, tierName: "Bronze", totalPoints: 1200 },
    rewardsCatalog: { tiers: [{ tier: 1, minPoints: 0, name: "Bronze" }, { tier: 2, minPoints: 2000, name: "Silver" }] },
    weekly: { done: 2, goal: 5 },
    ...overrides,
  };
}

const NOW_CHAPTERS = [
  { id: "c1", name: "Chapter One", abbreviation: "ONE", memberCount: 1200, staffCount: 4 },
  { id: "c2", name: "Riverside Two" },
  { id: "c3", name: "Lakeside Three", abbreviation: "LK3" },
  { id: "c4", name: "Hill Four" },
  { id: "c5", name: "Valley Five" },
  { id: "c6", name: "Coast Six" },
  { id: "c7", name: "Desert Seven" },
];

function nowHandlers() {
  return {
    onPlanAction: vi.fn(),
    onAssistant: vi.fn(),
    onRewards: vi.fn(),
    onOpenReports: vi.fn(),
    onOpenSearch: vi.fn(),
    onOpenEvents: vi.fn(),
    onOpenWorkload: vi.fn(),
    onOpenCases: vi.fn(),
    onOpenMessages: vi.fn(),
    onContactSteward: vi.fn(),
    onOpenOrgStructure: vi.fn(),
    onNavigate: vi.fn(),
    onSelectChapter: vi.fn(),
  };
}

function renderNow(props = {}, shell = null) {
  const page = <AltNowPage data={nowData()} {...props} />;
  return render(inEnglish(shell ? <AltShellContext.Provider value={shell}>{page}</AltShellContext.Provider> : page));
}

const section = (id) => within(document.getElementById(id).closest("section"));

describe("AltNowPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("leads with the current chapter, the latest update and the Now panel", () => {
    const handlers = nowHandlers();
    renderNow({ ...handlers, chapters: NOW_CHAPTERS, selectedChapterId: "c1" }, { openRail: vi.fn() });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Now at Chapter One");
    expect(screen.getByText("Bus driver · With the campaign since 2019")).toBeInTheDocument();
    const latest = screen.getByRole("button", { name: "Latest update: Contract ratified, 2 hours ago" });
    fireEvent.click(latest);
    expect(handlers.onOpenMessages).toHaveBeenCalledTimes(1);
    expect(within(latest).getByText("DS")).toBeInTheDocument();

    const panel = section("ug-now-h");
    expect(panel.getAllByRole("button", { name: /:/ })).toHaveLength(5);
    const current = panel.getByRole("button", { name: "Chapter One: Next meeting in 3 hours" });
    expect(within(current).getByText("Today")).toBeInTheDocument();
    expect(within(current).getByText("Steward huddle")).toBeInTheDocument();
    fireEvent.click(current);
    expect(handlers.onOpenEvents).toHaveBeenCalledTimes(1);
    const other = panel.getByRole("button", { name: "Riverside Two: Next meeting in 3 days" });
    expect(within(other).getByText("days")).toBeInTheDocument();
    fireEvent.click(other);
    expect(handlers.onSelectChapter).toHaveBeenCalledWith(NOW_CHAPTERS[1], other);
    expect(panel.getByText("Last record update: 2 hours ago.")).toBeInTheDocument();
    fireEvent.click(panel.getByRole("button", { name: "Change campaigns" }));
  });

  it("wires the hero buttons to alerts, updates and the first steward", () => {
    const handlers = nowHandlers();
    renderNow(handlers);
    const hero = within(document.querySelector(".ug-hero"));
    fireEvent.click(hero.getByRole("button", { name: "Get alerts" }));
    expect(handlers.onNavigate).toHaveBeenLastCalledWith("settings", "/m/settings/notifications", "");
    fireEvent.click(hero.getByRole("button", { name: "All updates" }));
    expect(handlers.onOpenMessages).toHaveBeenCalledTimes(1);
    fireEvent.click(hero.getByRole("button", { name: "Talk to your committee member" }));
    expect(handlers.onContactSteward).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });

  it("routes the What matters steward-desk action through onNavigate to the Committee desk", () => {
    // UX-UG-GIVE-HOME-STEWARD-REQUESTS-WAITING-LINE-BUTTON-OPENS-20261013
    const onNavigate = vi.fn();
    const { unmount } = renderNow({ onNavigate });
    fireEvent.click(screen.getByRole("button", { name: "wm open steward desk" }));
    expect(onNavigate).toHaveBeenCalledWith("steward", "/m/steward");
    unmount();
    renderNow({});
    expect(screen.queryByRole("button", { name: "wm open steward desk" })).toBeNull();
  });

  it("falls back to messages for the steward button, or offers none", () => {
    const onOpenMessages = vi.fn();
    const { unmount } = renderNow({ onOpenMessages });
    fireEvent.click(within(document.querySelector(".ug-hero")).getByRole("button", { name: "Talk to your committee member" }));
    expect(onOpenMessages).toHaveBeenCalledTimes(1);
    unmount();
    renderNow({});
    expect(within(document.querySelector(".ug-hero")).queryByRole("button", { name: "Talk to your committee member" })).toBeNull();
    expect(within(document.querySelector(".ug-hero")).queryByRole("button", { name: "All updates" })).toBeNull();
  });

  it("shows cases, support and the quorum strip as tiles, and no tier or points tile", () => {
    const handlers = nowHandlers();
    renderNow(handlers);
    // Union Ground has no points economy: a rewards summary draws no tier tile
    // and no points figure (as on the classic Home).
    expect(screen.queryByRole("button", { name: /Tier \d/ })).toBeNull();
    expect(screen.queryByText(/\d[\d,]* points/)).toBeNull();
    const cases = screen.getByRole("button", { name: /1 open issue/ });
    expect(cases).toHaveTextContent("C-1 Overtime");
    fireEvent.click(cases);
    expect(handlers.onOpenCases).toHaveBeenCalledWith();
    fireEvent.click(screen.getByRole("button", { name: /Worker support.*programs, rights/ }));
    expect(handlers.onNavigate).toHaveBeenLastCalledWith("memberSupport", "/m/support", "");
    const strip = screen.getByRole("button", { name: "Campaign quorum: 4 / 10" });
    expect(strip).toHaveTextContent("4 of 10 votes · 6 more to reach quorum");
    expect(strip.querySelectorAll(".ug-win")).toHaveLength(10);
    fireEvent.click(strip);
    expect(handlers.onPlanAction).toHaveBeenCalledWith(expect.objectContaining({ id: "p-ballot" }));
  });

  it("marks a reached quorum, the top tier and a case count without metrics", () => {
    const data = nowData({
      planItems: [{ id: "q", kind: "ballot", title: "Reached", quorum: { quorumTarget: 5, totalVotes: 8 } }],
      rewards: { tierNumber: 2, tierName: "Silver", totalPoints: 2500 },
      metrics: undefined,
      cases: [{ id: "a", status: "active" }, { id: "b", status: "active" }],
    });
    renderNow({ data });
    expect(screen.getByRole("button", { name: "Campaign quorum: 8 / 5" })).toHaveTextContent("8 of 5 votes · quorum reached");
    expect(screen.queryByRole("button", { name: /Tier 2 · Silver/ })).toBeNull();
    expect(screen.getByRole("button", { name: /2 open issues/ })).toHaveTextContent("2 open issues");
  });

  it("shows the week's goal strip, and no tier tile even with a next tier", () => {
    const data = nowData({
      rewards: { tierNumber: 1, tierName: "Bronze", totalPoints: 10, pointsToGo: 5, nextTierName: "Gold-ish" },
      rewardsCatalog: { tiers: [{ tier: 2, minPoints: 15 }] },
      planItems: [],
      weekly: { done: 2, goal: 5 },
    });
    const onRewards = vi.fn();
    renderNow({ data, onRewards });
    expect(screen.queryByRole("button", { name: /Tier 1 · Bronze/ })).toBeNull();
    expect(screen.queryByText(/Gold-ish/)).toBeNull();
    const strip = screen.getByRole("button", { name: /This week's goal/ });
    expect(strip).toHaveTextContent("2 of 5 actions done");
    fireEvent.click(strip);
    expect(onRewards).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Nothing open")).toBeInTheDocument();
  });

  it("shows neither strip without a quorum ballot or a weekly goal, and no rewards tile without rewards", () => {
    renderNow({ data: nowData({ planItems: [], weekly: null, rewards: null }) });
    expect(screen.queryByRole("button", { name: /This week's goal/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Tier/ })).toBeNull();
    expect(document.querySelector(".ug-strip")).toBeNull();
  });

  it("filters the plan by kind, caps it with a show-all toggle and opens items", () => {
    const handlers = nowHandlers();
    renderNow(handlers);
    const band = section("ug-feed-h");
    const chips = band.getByRole("group", { name: "Take part" });
    expect(within(chips).getAllByRole("button").map((chip) => chip.textContent)).toEqual([
      "All 8", "Vote 2", "Survey 1", "Task 1", "Form 1", "Lesson 1", "Issue 1",
    ]);
    // All: the receipt card and the first six action items. Closed ballots and pulses are outside the cap.
    expect(band.getByText("Receipt RC-123")).toBeInTheDocument();
    expect(band.getByRole("link", { name: "Verify it" })).toHaveAttribute("href", "/verify");
    expect(band.getByRole("button", { name: /Update your address/ })).toBeInTheDocument();
    expect(band.queryByRole("button", { name: /Your grievance/ })).toBeNull();
    const showAll = band.getByRole("button", { name: "Show all 8" });
    fireEvent.click(showAll);
    expect(band.getByRole("button", { name: /Unknown kind/ })).toBeInTheDocument();
    expect(band.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(band.getByRole("button", { name: "Show fewer" }));
    expect(band.getByRole("button", { name: "Show all 8" })).toBeInTheDocument();

    const strike = band.getByRole("button", { name: /Strike authorization/ });
    expect(strike).toHaveTextContent("Vote by Friday");
    expect(strike).toHaveTextContent("in 2 days");
    fireEvent.click(strike);
    expect(handlers.onPlanAction).toHaveBeenCalledWith(expect.objectContaining({ id: "p-ballot" }));
    expect(band.queryByRole("button", { name: /Old ballot/ })).toBeNull();

    fireEvent.click(within(chips).getByRole("button", { name: /^Survey/ }));
    expect(within(chips).getByRole("button", { name: /^Survey/ })).toHaveAttribute("aria-pressed", "true");
    expect(band.queryByText("Receipt RC-123")).toBeNull();
    expect(band.getByRole("button", { name: /Pulse survey/ })).toBeEnabled();
    expect(band.queryByRole("button", { name: /Answered survey/ })).toBeNull();
    for (const kind of ["Task", "Form", "Lesson", "Issue"]) {
      fireEvent.click(within(chips).getByRole("button", { name: new RegExp(`^${kind}`) }));
      expect(band.getAllByRole("button", { name: new RegExp(kind === "Issue" ? "Your grievance" : kind === "Task" ? "Sign the petition" : kind === "Form" ? "Update your address" : "Weingarten") })).toHaveLength(1);
    }
    fireEvent.click(within(chips).getByRole("button", { name: /^Vote/ }));
    expect(band.getByText("Receipt RC-123")).toBeInTheDocument();
    fireEvent.click(within(chips).getByRole("button", { name: /^All/ }));

    fireEvent.click(band.getByRole("button", { name: "Voting · 1" }));
    expect(handlers.onNavigate).toHaveBeenLastCalledWith("voting", "/m/voting", "");
    fireEvent.click(band.getByRole("button", { name: "Be heard" }));
    expect(handlers.onNavigate).toHaveBeenLastCalledWith("voice", "/m/voice", "");
  });

  it("passes the What matters now card its callbacks and mounts the optional cards", () => {
    const handlers = nowHandlers();
    renderNow({
      ...handlers,
      compassPins: <div data-testid="compass-pins" />,
      homeTakeover: { variant: "x" },
      homeNudges: { onAddPasskey: vi.fn() },
      learningContent: { preview: true },
      issueSignals: { items: [] },
    });
    expect(screen.getByTestId("compass-pins")).toBeInTheDocument();
    expect(screen.getByTestId("home-takeover")).toBeInTheDocument();
    expect(screen.getByTestId("home-nudges")).toBeInTheDocument();
    expect(screen.getByTestId("learning-card")).toBeInTheDocument();
    expect(screen.getByTestId("issue-signals")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "wm open case" }));
    expect(handlers.onOpenCases).toHaveBeenCalledWith("case-9");
    fireEvent.click(screen.getByRole("button", { name: "wm open events" }));
    expect(handlers.onOpenEvents).toHaveBeenCalledWith();
  });

  it("lists upcoming events with calendar downloads and the calendar actions", () => {
    const handlers = nowHandlers();
    renderNow(handlers);
    const cal = section("ug-cal-h");
    const titles = cal.getAllByRole("heading", { level: 3 }).map((node) => node.textContent);
    // The prototype's month calendar leads (month heading), then the upcoming cards.
    expect(titles.slice(1)).toEqual(["Coming up", "Steward huddle", "Union-wide rally", "Open forum", "Date to be set"]);
    expect(cal.getByText("12 going")).toBeInTheDocument();
    expect(cal.getByText("Bring notes")).toBeInTheDocument();
    expect(cal.getByRole("heading", { name: "Steward huddle" }).closest(".ug-ev")).toHaveTextContent(/EDT/);
    expect(cal.getByText("Soon · TBD")).toBeInTheDocument();
    // Three dated events get "Add to calendar"; the undated one does not.
    const add = cal.getAllByRole("button", { name: "Add to calendar" });
    expect(add).toHaveLength(3);
    fireEvent.click(add[0]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    fireEvent.click(cal.getByRole("button", { name: "Download all as .ics" }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    const open = cal.getAllByRole("button", { name: /^Open meeting:/ });
    expect(open).toHaveLength(4);
    fireEvent.click(open[0]);
    expect(handlers.onOpenEvents).toHaveBeenCalledWith(expect.objectContaining({ id: "ev-today" }));
    fireEvent.click(cal.getByRole("button", { name: "Open calendar", exact: true }));
    expect(handlers.onOpenEvents).toHaveBeenCalled();
    fireEvent.click(cal.getByRole("button", { name: "My reports" }));
    expect(handlers.onOpenReports).toHaveBeenCalledTimes(1);
  });

  it("says when there are no events, no updates and nothing scheduled", () => {
    const data = nowData({ events: [], broadcasts: [], planItems: [] });
    renderNow({ data, chapters: NOW_CHAPTERS.slice(0, 2), onSelectChapter: vi.fn() });
    expect(screen.getByText("No upcoming meetings")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download all as .ics" })).toBeNull();
    expect(screen.getByRole("status", { name: "Calendar" })).toHaveTextContent("No dated meetings to download");
    expect(screen.queryByRole("button", { name: /Calendar.*Your meetings as a file/ })).not.toBeInTheDocument();
    expect(screen.getAllByText("No updates yet").length).toBeGreaterThan(0);
    const panel = section("ug-now-h");
    expect(panel.getByRole("button", { name: "Chapter One: nothing scheduled" })).toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Riverside Two: Open the campaign to see its meetings" })).toBeInTheDocument();
    expect(panel.getByText("No updates yet")).toBeInTheDocument();
    const cards = section("ug-ch-h");
    expect(cards.getByText("nothing scheduled")).toBeInTheDocument();
    expect(cards.getByText("Open the campaign to see its meetings")).toBeInTheDocument();
  });

  it("counts a next event one day away in the singular", () => {
    const data = nowData({ events: [{ id: "tmr", title: "Tomorrow's meeting", startsAt: at(DAY).toISOString() }] });
    renderNow({ data, chapters: NOW_CHAPTERS.slice(0, 2), selectedChapterId: "c2", onSelectChapter: vi.fn() });
    const panel = section("ug-now-h");
    const row = panel.getByRole("button", { name: "Riverside Two: Next meeting Tomorrow" });
    expect(within(row).getByText("day")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Now at Riverside Two");
  });

  it("opens chapter cards, the directory, the org structure and the rail", () => {
    const handlers = nowHandlers();
    const openRail = vi.fn();
    renderNow({ ...handlers, chapters: NOW_CHAPTERS, selectedChapterId: "c1" }, { openRail });
    const cards = section("ug-ch-h");
    const buttons = cards.getAllByRole("button").filter((node) => node.classList.contains("ug-ch-card"));
    expect(buttons).toHaveLength(6);
    expect(buttons[0]).toHaveTextContent("Current campaign");
    expect(buttons[0]).toHaveTextContent("1,200");
    expect(buttons[0]).toHaveTextContent("Steward huddle");
    expect(buttons[2]).toHaveTextContent("LK3");
    fireEvent.click(buttons[0]);
    expect(handlers.onNavigate).toHaveBeenLastCalledWith("hub", "/m/organize", "");
    fireEvent.click(buttons[1]);
    expect(handlers.onSelectChapter).toHaveBeenCalledWith(NOW_CHAPTERS[1], buttons[1]);
    fireEvent.click(cards.getByRole("button", { name: "My campaign page" }));
    expect(handlers.onNavigate).toHaveBeenLastCalledWith("hub", "/m/organize", "");
    fireEvent.click(cards.getByRole("button", { name: "Org structure" }));
    expect(handlers.onOpenOrgStructure).toHaveBeenCalledTimes(1);
    fireEvent.click(cards.getByRole("button", { name: "Switch campaign" }));
    expect(openRail).toHaveBeenCalledTimes(1);
  });

  it("falls back to the member's own chapter, or to no chapter at all", () => {
    const { unmount } = renderNow({ onNavigate: vi.fn() });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Now at Chapter One");
    const row = section("ug-now-h").getByRole("button", { name: /^Chapter One:/ });
    fireEvent.click(row);
    unmount();
    renderNow({ data: nowData({ member: { id: "m1", chapterId: "c1" }, broadcasts: [] }) });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Now at c1");
    expect(screen.getByText("Last record update: 2 days ago.")).toBeInTheDocument();
    cleanupAndRender({ data: nowData({ member: undefined, events: [], broadcasts: [], tasks: [] }) });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Now at your union");
    expect(section("ug-now-h").queryAllByRole("button")).toHaveLength(0);
  });

  it("lists stewards and tasks with their show-all toggles and contact actions", () => {
    const handlers = nowHandlers();
    renderNow(handlers);
    const help = section("ug-help-h");
    expect(help.getAllByRole("button", { name: /^Contact / })).toHaveLength(4);
    expect(help.getByRole("link", { name: "Email Sam Steward" })).toHaveAttribute("href", "mailto:sam@example.org");
    expect(help.getByRole("link", { name: "Call Sam Steward" })).toHaveAttribute("href", "tel:555-0101");
    fireEvent.click(help.getByRole("button", { name: "Contact Pat Steward" }));
    expect(handlers.onContactSteward).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }));
    fireEvent.click(help.getByRole("button", { name: "Show all 5" }));
    expect(help.getAllByRole("button", { name: /^Contact / })).toHaveLength(5);
    fireEvent.click(help.getByRole("button", { name: "Show fewer" }));

    expect(help.getByText(/Call members/).closest("span")).toHaveTextContent("Call members · C1-1 · Due Oct 20");
    expect(help.getByText(/Fix the board/).closest("span")).toHaveTextContent("Fix the board · C1-2 · Blocked");
    expect(help.queryByText(/Sixth task/)).toBeNull();
    expect(help.queryByText(/Done task/)).toBeNull();
    fireEvent.click(help.getByRole("button", { name: "Show all 6" }));
    expect(help.getByText(/Sixth task/)).toBeInTheDocument();
    fireEvent.click(help.getByRole("button", { name: "Log workload" }));
    expect(handlers.onOpenWorkload).toHaveBeenCalledTimes(1);

    const lessons = ["Weingarten rights", "Overtime rules", "lesson-id-only"];
    for (const name of lessons) fireEvent.click(help.getByRole("button", { name }));
    expect(handlers.onNavigate).toHaveBeenLastCalledWith("rights", "/m/rights", "");
    fireEvent.click(help.getByRole("button", { name: "Find a program" }));
    expect(handlers.onNavigate).toHaveBeenLastCalledWith("memberSupport", "/m/support", "");
    fireEvent.click(help.getByRole("button", { name: "Organizing rights" }));
    fireEvent.click(help.getByRole("button", { name: "Ask the Guide" }));
    expect(handlers.onAssistant).toHaveBeenCalledTimes(1);
  });

  // REQ-UG-STALE-OR-CONTRADICTORY-STATE-AFTER-SAVE-20261030: a
  // steward is never listed as their own steward.
  it("leaves the viewer off their own steward list and says when they are the only one", () => {
    const self = { id: "m1", name: "Odette Fairbanks", chapterLabel: "Chapter One", contact: { conversation: true } };
    const other = { id: "s2", name: "Pete Halvorsen", chapterLabel: "Chapter One", contact: { conversation: true } };
    const { unmount } = renderNow({ data: nowData({ chapterStewards: [self, other] }) });
    expect(section("ug-help-h").queryByText("Odette Fairbanks")).toBeNull();
    expect(section("ug-help-h").getByText("Pete Halvorsen")).toBeInTheDocument();
    unmount();
    renderNow({ data: nowData({ chapterStewards: [self] }) });
    expect(section("ug-help-h").getByText("You're the only committee member listed for your campaign.")).toBeInTheDocument();
    expect(section("ug-help-h").queryByText("No committee member is listed for your campaign yet.")).toBeNull();
  });

  it("says so when there are no stewards, tasks or lessons", () => {
    renderNow({ data: nowData({ chapterStewards: null, tasks: [], rights: {} }) });
    const help = section("ug-help-h");
    expect(help.getByText("No committee member is listed for your campaign yet.")).toBeInTheDocument();
    expect(help.getAllByText("No open items of this type right now.")).toHaveLength(2);
    expect(help.queryByRole("button", { name: "Log workload" })).toBeNull();
    expect(help.queryByRole("button", { name: "Ask the Guide" })).toBeNull();
  });

  it("previews unread notifications and wires the alert channels", () => {
    const handlers = nowHandlers();
    renderNow(handlers);
    const alerts = document.getElementById("ug-alerts-h").closest("section");
    const bots = alerts.querySelectorAll(".ug-bot");
    expect(bots).toHaveLength(2);
    expect(bots[0]).toHaveTextContent("Ballot opens");
    expect(bots[0]).toHaveTextContent("Oct 15");
    expect(bots[1].querySelector(".ug-ft")).toBeNull();
    const view = within(alerts);
    fireEvent.click(view.getByRole("button", { name: "Set up alerts" }));
    for (const name of [/^Email/, /^Text message/, /^Browser/]) fireEvent.click(view.getByRole("button", { name }));
    expect(handlers.onNavigate).toHaveBeenCalledTimes(4);
    expect(handlers.onNavigate).toHaveBeenLastCalledWith("settings", "/m/settings/notifications", "");
    fireEvent.click(view.getByRole("button", { name: /^Calendar/ }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(view.getByRole("link", { name: /Mobile app/ })).toHaveAttribute("href", "/get-app");
  });

  it("links the sources section and the unread messages", () => {
    const handlers = nowHandlers();
    renderNow(handlers);
    const sources = section("ug-src-h");
    // Contract clauses and Dues are left out of Union Ground's sources.
    expect(sources.queryByRole("button", { name: /Contract clauses|Dues/ })).toBeNull();
    fireEvent.click(sources.getByRole("button", { name: "Search" }));
    expect(handlers.onOpenSearch).toHaveBeenCalledTimes(1);
    fireEvent.click(sources.getByRole("button", { name: "2 unread" }));
    expect(handlers.onOpenMessages).toHaveBeenCalledTimes(1);
  });

  it("hides cases, stewards, notification previews and the takeover in a restricted session", () => {
    const handlers = nowHandlers();
    renderNow({ ...handlers, sessionRestricted: true, homeTakeover: { variant: "x" } });
    expect(screen.queryByTestId("home-takeover")).toBeNull();
    // #9465: no case count at all, never "0 open cases".
    expect(screen.queryByRole("button", { name: /\d+ open cases?/ })).toBeNull();
    expect(screen.queryByText(/\b0 open cases?\b/)).toBeNull();
    // Hidden, not "none listed": the roster exists, the session just cannot show it.
    expect(screen.queryByText("No committee member is listed for your campaign yet.")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Your committee members" })).toBeNull();
    const alerts = document.getElementById("ug-alerts-h").closest("section");
    expect(alerts.querySelectorAll(".ug-bot")).toHaveLength(1);
    expect(within(alerts.querySelector(".ug-bot")).getByText("Nothing open")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "2 unread" })).toBeNull();
    expect(section("ug-help-h").queryByRole("button", { name: "Ask the Guide" })).toBeNull();
    // The hero's steward button falls back to messages when stewards are hidden.
    fireEvent.click(within(document.querySelector(".ug-hero")).getByRole("button", { name: "Talk to your committee member" }));
    expect(handlers.onOpenMessages).toHaveBeenCalledTimes(1);
    expect(handlers.onContactSteward).not.toHaveBeenCalled();
  });

  it("renders without callbacks, leaving the controls inert", () => {
    renderNow({ chapters: NOW_CHAPTERS.slice(0, 3), selectedChapterId: "c3" });
    fireEvent.click(screen.getByRole("button", { name: /1 open issue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Campaign quorum: 4 / 10" }));
    fireEvent.click(section("ug-feed-h").getByRole("button", { name: /Strike authorization/ }));
    fireEvent.click(section("ug-now-h").getByRole("button", { name: /^Riverside Two:/ }));
    fireEvent.click(within(document.querySelector(".ug-hero")).getByRole("button", { name: /Latest update/ }));
    fireEvent.click(section("ug-help-h").getByRole("button", { name: "Find a program" }));
    expect(screen.queryByRole("button", { name: "Change campaigns" })).toBeNull();
    expect(section("ug-cal-h").queryByRole("button", { name: "Open calendar" })).toBeNull();
    expect(screen.queryByTestId("learning-card")).toBeNull();
  });

  it("shows the welcome-back screen instead of the page after a long absence", () => {
    window.sessionStorage.setItem("ug-home-return:v2:m1:org1", "welcome");
    const handlers = nowHandlers();
    renderNow({ ...handlers, welcomeBack: { onOpenUpdates: vi.fn(), onOpenRights: vi.fn() } });
    expect(screen.getByTestId("welcome-back")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "wb case" }));
    expect(handlers.onOpenCases).toHaveBeenCalledWith("case-7");
    fireEvent.click(screen.getByRole("button", { name: "wb updates" }));
    expect(handlers.onOpenMessages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "wb dismiss" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Now at Chapter One");
  });

  it("falls back to messages for the welcome-back updates and offers no case link without a handler", () => {
    window.sessionStorage.setItem("ug-home-return:v2:m1:org1", "welcome");
    const onOpenMessages = vi.fn();
    renderNow({ onOpenMessages });
    fireEvent.click(screen.getByRole("button", { name: "wb updates" }));
    expect(onOpenMessages).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "wb case" })).toBeNull();
  });
});

function cleanupAndRender(props) {
  cleanup();
  return renderNow(props);
}
