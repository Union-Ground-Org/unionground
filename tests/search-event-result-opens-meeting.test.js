import { describe, expect, it } from "vitest";
import { buildSearchIndex, searchEntries } from "../src/lib/searchIndex.js";

// UX-UG-STAFF-LINKS-FROM-WRONG-DESK-LAND-ON-HOME-OR-OVERVIEW-20261111
// (#8218, Devon R16): a search result for a meeting opened the general Events
// list instead of the meeting.
describe("a meeting found by search", () => {
  it("opens that meeting's own address, the one Events reads", () => {
    const index = buildSearchIndex({
      events: [{ id: "event 7/1", title: "November chapter meeting", summary: "Agenda and minutes", dateLabel: "Nov 23", location: "Union hall" }],
    });
    const [result] = searchEntries(index, "November chapter").flatMap((group) => group.items);
    expect(result.focus).toEqual({ view: "events", path: "/m/events?event=event%207%2F1" });
  });
});
