import { describe, expect, it } from "vitest";
import { buildHomeFeed, homeRelevantEvents, HOME_FEED_PAGE } from "../src/lib/homeFeed.js";

// The Home chapter-activity feed contract (owner feedback, 2026-08-25): the
// dated history the snapshot already carries — broadcasts, held events,
// closed ballots — merges into one newest-first stream deep enough that the
// first page is only a fraction of it.

const data = {
  broadcasts: [
    { id: "b1", title: "Weekly update", body: "Notes.", publishedAt: "2026-08-20T14:00:00Z" },
    { id: "b2", title: "Older update", body: "Notes.", publishedAt: "2024-02-01T14:00:00Z" },
    { id: "b3", title: "Unparseable", body: "Notes.", publishedAt: "not a date" },
  ],
  events: [
    { id: "e1", title: "Chapter meeting", startsAt: "2026-08-10T18:00:00Z", location: "Hall", isPast: true, checkedIn: true },
    { id: "e2", title: "Upcoming meeting", startsAt: "2026-09-10T18:00:00Z", location: "Hall", isPast: false },
  ],
  planItems: [
    { id: "p1", kind: "ballot", closed: true, closesAt: "2026-07-01T19:00:00Z", title: "Ratify", quorum: { totalVotes: 812 } },
    { id: "p2", kind: "ballot", closed: false, closesAt: "2026-09-01T19:00:00Z", title: "Open ballot" },
    { id: "p3", kind: "pulse", closed: true, closesAt: "2026-06-01T19:00:00Z", title: "Pulse" },
  ],
};

// BUG-UG-HOME-FEED-DATED-EVENTS-DROPPED-20261020: past date-only events and
// deadlines carry eventDate and a null startsAt; they stay in the history on
// their local calendar day.
describe("buildHomeFeed dated events", () => {
  const dated = (eventKind, over = {}) => ({
    id: eventKind, title: `Past ${eventKind}`, chapterId: "chapter-a", eventKind,
    eventDate: "2026-10-19", startsAt: null, isPast: true, ...over,
  });
  const meeting = { id: "meeting", title: "Past meeting", chapterId: "chapter-a", eventKind: "meeting", eventDate: null, startsAt: "2026-10-19T12:00:00-04:00", isPast: true };

  it("keeps past date_only and deadline rows beside timed meetings", () => {
    const events = [dated("date_only"), dated("deadline"), meeting];
    const ids = buildHomeFeed({ member: { chapterId: "chapter-a" }, events }).map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["feed-evt-date_only", "feed-evt-deadline", "feed-evt-meeting"]));
    expect(ids).toHaveLength(3);
  });

  it.each(["Pacific/Kiritimati", "Pacific/Pago_Pago", "America/New_York", "UTC"])("keeps the event's calendar day in %s", (zone) => {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      const [item] = buildHomeFeed({ events: [dated("date_only", { eventDate: "2026-10-19" })] });
      const shown = new Date(item.at);
      expect([shown.getFullYear(), shown.getMonth() + 1, shown.getDate()]).toEqual([2026, 10, 19]);
    } finally {
      if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
    }
  });

  it("orders dated rows among timed rows by calendar day, newest first", () => {
    const events = [dated("deadline", { id: "d1", eventDate: "2026-10-18" }), dated("date_only", { id: "d2", eventDate: "2026-10-20" }), { ...meeting, id: "m1", startsAt: "2026-10-19T09:00:00Z" }];
    expect(buildHomeFeed({ events }).map((item) => item.id)).toEqual(["feed-evt-d2", "feed-evt-m1", "feed-evt-d1"]);
  });

  it("keeps upcoming, invalid and undated rows and other chapters' rows out", () => {
    const events = [
      dated("date_only", { id: "future", isPast: false }),
      dated("date_only", { id: "bad", eventDate: "2026-02-30" }),
      dated("date_only", { id: "garbled", eventDate: "10/19/2026" }),
      dated("date_only", { id: "none", eventDate: null }),
      dated("date_only", { id: "other", chapterId: "chapter-b" }),
    ];
    expect(buildHomeFeed({ member: { chapterId: "chapter-a" }, events })).toEqual([]);
  });

  it("prefers the instant when a row carries both", () => {
    const [item] = buildHomeFeed({ events: [dated("meeting", { id: "both", startsAt: "2026-10-19T12:00:00Z" })] });
    expect(item.at).toBe(Date.parse("2026-10-19T12:00:00Z"));
  });
});

describe("buildHomeFeed", () => {
  it("merges broadcasts, held events, and closed ballots newest-first", () => {
    const feed = buildHomeFeed(data);
    expect(feed.map((item) => item.id)).toEqual(["feed-bc-b1", "feed-evt-e1", "feed-bal-p1", "feed-bc-b2"]);
    for (let index = 1; index < feed.length; index += 1) {
      expect(feed[index - 1].at).toBeGreaterThanOrEqual(feed[index].at);
    }
  });

  it("keeps upcoming events, open ballots, and undated rows out of the history", () => {
    const ids = buildHomeFeed(data).map((item) => item.id);
    expect(ids).not.toContain("feed-evt-e2");
    expect(ids).not.toContain("feed-bal-p2");
    expect(ids).not.toContain("feed-bal-p3");
    expect(ids).not.toContain("feed-bc-b3");
  });

  it("carries the row detail each kind renders", () => {
    const feed = buildHomeFeed(data);
    expect(feed.find((item) => item.id === "feed-evt-e1").attended).toBe(true);
    expect(feed.find((item) => item.id === "feed-bal-p1").votes).toBe(812);
    expect(feed.find((item) => item.id === "feed-bal-p1").planItem).toBe(data.planItems[0]);
  });

  it("tolerates an empty snapshot", () => {
    expect(buildHomeFeed({})).toEqual([]);
    expect(buildHomeFeed(null)).toEqual([]);
  });

  it("keeps Home local while retaining explicitly organization-wide events", () => {
    const scoped = {
      member: { chapterId: "home-chapter" },
      events: [
        { id: "local", chapterId: "home-chapter", isPublic: false },
        { id: "regional", chapterId: "neighbor", isPublic: true, isPublicAcrossAgencies: false },
        { id: "organization", chapterId: "neighbor", isPublic: true, isPublicAcrossAgencies: true },
        { id: "legacy", chapterId: null, isPublic: false },
      ],
    };

    expect(homeRelevantEvents(scoped).map((event) => event.id))
      .toEqual(["local", "organization", "legacy"]);
    expect(homeRelevantEvents({ events: scoped.events })).toBe(scoped.events);
  });

  it("pages at a size that leaves the seeded archive many pages deep", async () => {
    const { fallbackData } = await import("./fixtures/retired-pre-bot/src/data/fallback.js");
    const { seedDemoData } = await import("./fixtures/retired-pre-bot/src/data/demoSeed.js");
    const feed = buildHomeFeed(seedDemoData(fallbackData));
    // "At least two pages worth" is the owner's floor; the seed gives many
    // multiples of it so the scroll genuinely keeps going.
    expect(feed.length).toBeGreaterThan(HOME_FEED_PAGE * 10);
  });
});

// W5: the September invitation must not be promoted as current in November.
describe("current Home briefing", () => {
  it("keeps recent announcements while history remains in the full feed", async () => {
    const { currentHomeFeed } = await import("../src/lib/homeFeed.js");
    const now = Date.parse("2026-11-08T17:00:00Z");
    const snapshot = { broadcasts: [
      { id: "training", title: "Steward training — October 3", publishedAt: "2026-09-24T12:00:00Z" },
      { id: "next", title: "Chapter meeting November 23", publishedAt: "2026-11-07T12:00:00Z" },
      { id: "boundary", title: "Current update", publishedAt: "2026-10-09T17:00:00Z" },
      { id: "future", title: "Not published yet", publishedAt: "2026-11-09T12:00:00Z" },
    ], events: [{ id: "held", title: "Past training", startsAt: "2026-11-07T12:00:00Z", isPast: true }] };
    expect(currentHomeFeed(snapshot, now).map(row => row.title)).toEqual(["Chapter meeting November 23", "Current update"]);
    expect(buildHomeFeed(snapshot).some(row => row.title === "Past training")).toBe(true);
    expect(snapshot.broadcasts).toHaveLength(4);
    expect(currentHomeFeed({}, now)).toEqual([]);
  });
});
