// BUG-UG-ALT-MEMBER-PAGES-COLD-LOAD-MISSING-DATA-20261102 (#6747): a
// cold load of All updates, Events and My chapter reads every source its
// alternate-shell page counts or draws, so a refresh never shows an empty
// feed or a 0 that is only an unloaded read.
import { describe, expect, it } from "vitest";
import { memberResourcesForRoute } from "../src/lib/memberSessionLoader.js";

// src/alt/recordIndex.js recordItems: broadcasts, events, ballots (plan items
// with receipts) and each own case's notes.
const RECORD_FEED = [
  "table:member_broadcasts", "table:member_broadcast_receipts",
  "table:member_events", "table:member_event_rsvps", "table:member_event_checkins",
  "table:member_ballots", "table:member_ballot_receipts",
  "table:member_cases", "table:member_case_updates",
];

describe("alternate-shell member page route plans", () => {
  it.each(["updates", "events"])("a cold %s load reads every record-feed source", (view) => {
    const planned = memberResourcesForRoute(view);
    for (const resource of RECORD_FEED) expect(planned, `${view}: ${resource}`).toContain(resource);
  });

  it("a cold hub load reads the events and the steward roster My chapter counts", () => {
    const planned = memberResourcesForRoute("hub");
    for (const resource of ["table:member_events", "rpc:get_member_chapter_stewards"]) expect(planned).toContain(resource);
  });

  it("is no longer the bare shell set for All updates", () => {
    expect(memberResourcesForRoute("updates").length).toBeGreaterThan(memberResourcesForRoute("no-such-view").length);
  });
});
