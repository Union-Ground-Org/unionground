import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { noStewardNamed, STEWARD_PRESENCE, stewardPresence } from "../src/lib/stewardConversations.js";

// #9595: the one answer member pages read to whether a steward is named for
// the reader, so the Know your rights card and the pages that follow it cannot
// disagree.
const roster = [{ id: "steward-1", fullName: "Dana Reyes" }, { id: "steward-2", fullName: "Sam Ortiz" }];

describe("whether a steward is named for the reader (#9595)", () => {
  it("is named when someone other than the reader is on the chapter's roster", () => {
    expect(stewardPresence({ stewards: roster, viewerId: "member-1", chapterId: "wor" })).toBe(STEWARD_PRESENCE.named);
    // A fixture or older loader that does not say whether the roster loaded keeps the roster.
    expect(stewardPresence({ stewards: roster, viewerId: "member-1", chapterId: "wor", rosterLoaded: undefined })).toBe("named");
  });

  it("is none with an empty roster, and no-chapter without a chapter", () => {
    expect(stewardPresence({ stewards: roster, viewerId: "member-1", chapterId: null })).toBe(STEWARD_PRESENCE.noChapter);
    expect(stewardPresence({ stewards: [], viewerId: "member-1", chapterId: "wor" })).toBe("none");
  });

  // Sol re-read of dadafe1f, P1: paused stewards exist and can read a request.
  it("is paused, not none, when stewards are listed but none can receive a message", () => {
    expect(stewardPresence({ stewards: roster, viewerId: "member-1", chapterId: "wor", messageAvailable: false })).toBe(STEWARD_PRESENCE.paused);
  });

  it("is only-self when the reader is the chapter's only steward", () => {
    expect(stewardPresence({ stewards: [roster[0]], viewerId: "steward-1", chapterId: "wor" })).toBe(STEWARD_PRESENCE.onlySelf);
  });

  it("names the states with no other steward to reach, and only those", () => {
    expect(["named", "paused", "only-self", "none", "no-chapter", "unknown"].map(noStewardNamed))
      .toEqual([false, false, true, true, true, false]);
  });

  it("is unknown when the roster read failed or was not made, never none", () => {
    expect(stewardPresence({ stewards: [], viewerId: "member-1", chapterId: "wor", rosterLoaded: false })).toBe("unknown");
    // A route-first load that did not plan the roster read has no array.
    expect(stewardPresence({ stewards: undefined, viewerId: "member-1", chapterId: "wor" })).toBe("unknown");
  });

});
