// The Home "Chapter activity" feed. This merges the
// deep dated history the snapshot already carries — chapter broadcasts, held
// events, closed ballots — into one newest-first stream. Home initially shows
// twenty rows and reveals the archive on request. Pure derivation over `data`, no fetching:
// the seed (and a live snapshot) already hold years of rows; the feed's job
// is only to surface them.
export const HOME_FEED_PAGE = 20;

// Home is personal chapter context, not the regional event directory. Keep
// the member's chapter plus events explicitly published across every agency.
// Rows without chapter metadata stay visible for old fixtures and additive
// pre-migration payloads; the authorization boundary still lives in RLS.
export function homeRelevantEvents(data) {
  const events = data?.events ?? [];
  const memberChapterId = data?.member?.chapterId;
  if (!memberChapterId) return events;
  return events.filter((event) => (
    !event.chapterId
    || event.chapterId === memberChapterId
    || event.isPublicAcrossAgencies === true
  ));
}

// A date-only event or deadline carries eventDate (a civil YYYY-MM-DD) and a
// null startsAt, by the database schedule constraint. Its chronology key is
// local noon of that calendar day: Date.parse("YYYY-MM-DD") is UTC midnight,
// which shows as the previous day in every negative offset. Anything that is
// not a real calendar date has no key and stays out of the feed.
function civilDayAt(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return Number.NaN;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(year, month - 1, day, 12, 0, 0, 0);
  const real = at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day;
  return real ? at.getTime() : Number.NaN;
}

export function buildHomeFeed(data) {
  const items = [];
  for (const row of data?.broadcasts ?? []) {
    const at = Date.parse(row.publishedAt);
    if (!Number.isFinite(at)) continue;
    items.push({ kind: "broadcast", id: `feed-bc-${row.id}`, title: row.title, body: row.body, at });
  }
  // Only HELD events are history; upcoming ones already live in "This week".
  for (const row of homeRelevantEvents(data)) {
    if (row.isPast !== true) continue;
    const timed = Date.parse(row.startsAt);
    const at = Number.isFinite(timed) ? timed : civilDayAt(row.eventDate);
    if (!Number.isFinite(at)) continue;
    items.push({
      kind: "event",
      id: `feed-evt-${row.id}`,
      title: row.title,
      body: [row.location, row.summary].filter(Boolean).join(" · "),
      attended: Boolean(row.checkedIn),
      at,
    });
  }
  for (const row of data?.planItems ?? []) {
    if (row.kind !== "ballot" || !row.closed) continue;
    const at = Date.parse(row.closesAt);
    if (!Number.isFinite(at)) continue;
    items.push({ kind: "ballot", id: `feed-bal-${row.id}`, title: row.title, votes: row.quorum?.totalVotes ?? null, planItem: row, at });
  }
  return items.sort((a, b) => b.at - a.at);
}


// Home is a current briefing. Event history remains in Events and older
// announcements in Messages; neither is promoted beside the Home guides.
// Broadcasts have publication dates, not expiry metadata: retain the last
// 30 days and never expose a future-dated publication as already current.
export function currentHomeFeed(data, now = Date.now()) {
  const since = now - 30 * 24 * 60 * 60 * 1000;
  return buildHomeFeed(data).filter((item) => (
    item.kind === "broadcast" && item.at >= since && item.at <= now
  ));
}
