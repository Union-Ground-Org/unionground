import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventDisplayDate, eventIsPast, eventModelLabels, compareEventSchedule } from "../src/lib/eventModel.js";
import { EventsView } from "../src/views/EventsView.jsx";
import { TodayView } from "../src/views/TodayView.jsx";
import { EventAuthoringCard } from "../src/components/EventAuthoringCard.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildIcsCalendar } from "../src/lib/ics.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import AltNowPage from "../src/alt/AltNowPage.jsx";

const winter = {
  id: "nov18", title: "November meeting", startsAt: "2026-11-18T18:00:00Z", endsAt: "2026-11-18T18:45:00Z",
  startsLabel: "Wrong cached label", dateLabel: "Wrong cached date", timeLabel: "3:00 AM",
  location: "Fixture hall", chapterName: "Fixture chapter", rsvpStatus: null, checkedIn: false,
};
const wrap = (node, lang) => <LanguageProvider lang={lang}>{node}</LanguageProvider>;
// The pages under test hide past events by the clock, so the clock is pinned
// to the morning of the fixture day (9:00 AM EST, before the 1:00 PM meeting);
// otherwise the file fails on every run after Nov 18, 2026.
const BEFORE_FIXTURE_EVENTS = new Date("2026-11-18T14:00:00Z");

describe("event labels describe Eastern instants", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: BEFORE_FIXTURE_EVENTS }); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(["en", "es"])("rebuilds preformatted Member, Home and staff cards at render time in %s", (lang) => {
    const member = render(wrap(<EventsView data={{ events: [winter] }} onRsvp={vi.fn()} onCheckIn={vi.fn()} />, lang));
    expect(member.container.textContent).toMatch(/1:00.*EST.*1:45.*EST/);
    expect(member.container.textContent).toMatch(lang === "es" ? /mié.*18 nov/ : /Wed.*Nov 18/);
    expect(member.container.textContent).not.toContain("Wrong cached");
    member.unmount();
    const home = render(wrap(<TodayView data={{ ...fallbackData, events: [winter] }} desktop onPlanAction={vi.fn()} />, lang));
    expect(home.container.textContent).toMatch(/1:00.*EST.*1:45.*EST/);
    expect(home.container.textContent).not.toContain("Wrong cached");
    home.unmount();
    const alternate = render(wrap(<AltNowPage data={{ ...fallbackData, events: [winter] }} />, lang));
    expect(alternate.container.textContent).toMatch(/1:00.*EST.*1:45.*EST/);
    expect(alternate.container.textContent).not.toContain("Wrong cached");
    alternate.unmount();
    const staff = render(wrap(<EventAuthoringCard events={[winter]} api={{}} onNotice={vi.fn()} reload={vi.fn()} />, lang));
    expect(staff.container.textContent).toMatch(/1:00.*EST.*1:45.*EST/);
    expect(staff.container.textContent).not.toContain("Wrong cached");
    expect(staff.container.textContent).toMatch(lang === "es" ? /p\.\s*m\./ : /PM/);
  });

  it.each(["en", "es"])("reformats the existing start-only cached shape and Eastern badge in %s", (lang) => {
    const item = { ...winter, startsAt: "2026-11-19T01:30:00Z", endsAt: null };
    const member = render(wrap(<EventsView data={{ events: [item] }} onRsvp={vi.fn()} onCheckIn={vi.fn()} />, lang));
    expect(member.container.textContent).toMatch(/8:30.*EST/);
    expect(member.container.textContent).toMatch(lang === "es" ? /mié.*18 nov/ : /Wed.*Nov 18/);
    expect(member.container.querySelector(".mevents-date__day")).toHaveTextContent("18");
  });

  it.each(["en", "es"])("keeps summer offsets, a multi-day range, and each DST endpoint's zone in %s", (lang) => {
    const summer = eventModelLabels({ startsAt: "2026-07-15T17:00:00Z", endsAt: "2026-07-17T18:30:00Z" }, lang);
    expect(summer.startsLabel).toMatch(/1:00.*EDT.*17.*2:30.*EDT/);
    expect(summer.startsLabel).toMatch(lang === "es" ? /mié.*15 jul/ : /Wed.*Jul 15/);
    const transition = eventModelLabels({ startsAt: "2026-11-01T05:30:00Z", endsAt: "2026-11-01T06:45:00Z" }, lang);
    expect(transition.timeLabel).toMatch(/1:30.*EDT.*1:45.*EST/);
  });

  it("sorts meetings with the Eastern date badge and keeps date-only entries on their calendar date", () => {
    const late = { id: "late", startsAt: "2026-11-19T01:30:00Z" };
    const deadline = { id: "deadline", eventKind: "deadline", eventDate: "2026-11-18" };
    const next = { id: "next", startsAt: "2026-11-19T15:00:00Z" };
    expect([next, deadline, late].sort(compareEventSchedule).map(x => x.id)).toEqual(["late", "deadline", "next"]);
    expect(eventDisplayDate(late).toISOString()).toBe("2026-11-19T01:30:00.000Z");
    expect(eventModelLabels(late).dateLabel).toBe("Wed, Nov 18");
    expect(eventDisplayDate(deadline).getDate()).toBe(18);
    expect(eventModelLabels(deadline, "es").startsLabel).toMatch(/mié.*18 nov/);
    expect(eventModelLabels(deadline, "es").startsLabel).not.toMatch(/AM|PM|EST|EDT/);
    expect(eventIsPast(deadline, Date.parse("2026-11-19T01:30:00Z"))).toBe(false);
  });

  it("preserves exact timed and all-day ICS endpoints", () => {
    const ics = buildIcsCalendar([winter, { id: "day", eventDate: "2026-11-18", title: "Calendar day" }]);
    expect(ics).toContain("DTSTART:20261118T180000Z");
    expect(ics).toContain("DTEND:20261118T184500Z");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261118");
  });
});
