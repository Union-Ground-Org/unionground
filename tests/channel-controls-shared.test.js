// @vitest-environment node
//
// REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001 — the shared rules both
// clients import: the @here token and keyword whole-word matching (old
// lib/messages/here-mention.ts and keyword-highlight.ts), highlight
// segmentation, the keyword budget, mute lengths, pinned ordering, mention
// bookkeeping and the defensive server-answer normalizer.
import { describe, expect, it } from "vitest";
import {
  CHANNEL_MUTE_DURATIONS,
  UNAVAILABLE_CHANNEL_CONTROLS,
  appendMentionText,
  channelSettingFor,
  containsHereMention,
  findKeywordMatches,
  isChannelControlDisabled,
  isKeywordLimitError,
  isMuteActive,
  keywordListProblem,
  mentionIdsForBody,
  muteUntilFor,
  normalizeChannelControls,
  normalizeKeywords,
  orderThreadsForChannel,
  segmentChannelText,
} from "../src/features/messaging/channelControls.js";

describe("@here detection", () => {
  it.each([
    ["@here meeting now", true],
    ["(@here) quick one", true],
    ["@HERE: shift change", true],
    ["line one\n@here", true],
    ["email team@here.org", false],
    ["@heretic", false],
    ["almost@here", false],
    ["@@here", false],
    ["", false],
  ])("%j -> %s", (body, expected) => {
    expect(containsHereMention(body)).toBe(expected);
  });
});

describe("keyword matching and highlighting", () => {
  it("matches whole words case-insensitively and keeps the member's order", () => {
    expect(findKeywordMatches("Overtime list is up; ask about safety", ["safety", "overtime", "layoff"])).toEqual(["safety", "overtime"]);
    expect(findKeywordMatches("Overtimes are posted", ["overtime"])).toEqual([]);
    expect(findKeywordMatches("ping @jordan today", ["@jordan"])).toEqual(["@jordan"]);
    expect(findKeywordMatches("a+b rules (c)", ["a+b", "(c)"])).toEqual(["a+b", "(c)"]);
  });

  it("segments text without changing it, preferring the longer overlapping keyword", () => {
    const text = "The overtime list and @here crew";
    const segments = segmentChannelText(text, { keywords: ["overtime", "overtime list"], here: true });
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
    expect(segments.filter((segment) => segment.highlight)).toEqual([
      { text: "overtime list", highlight: "keyword" },
      { text: "@here", highlight: "here" },
    ]);
    expect(segmentChannelText("plain", {})).toEqual([{ text: "plain", highlight: null }]);
    expect(segmentChannelText("", { keywords: ["x"] })).toEqual([]);
  });

  it("normalizes and budgets keywords the way the server does", () => {
    expect(normalizeKeywords(["  Overtime ", "overtime", "", "Mandatory OT", 7])).toEqual(["overtime", "mandatory ot"]);
    expect(keywordListProblem(["ok"])).toBeNull();
    expect(keywordListProblem(["x"])).toBe("length");
    expect(keywordListProblem(["a".repeat(49)])).toBe("length");
    expect(keywordListProblem(Array.from({ length: 21 }, (_, index) => `kw${index}`))).toBe("per-channel");
    expect(keywordListProblem(["one", "two"], { elsewhere: 9, limit: 10 })).toBe("limit");
    expect(keywordListProblem(["one"], { elsewhere: 9, limit: 10 })).toBeNull();
  });
});

describe("mute", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  it("is active while muted with no end or an end in the future", () => {
    expect(isMuteActive({ muted: true, mutedUntil: null }, now)).toBe(true);
    expect(isMuteActive({ muted: true, mutedUntil: "2026-10-02T12:30:00Z" }, now)).toBe(true);
    expect(isMuteActive({ muted: true, mutedUntil: "2026-10-02T11:59:00Z" }, now)).toBe(false);
    expect(isMuteActive({ muted: false, mutedUntil: null }, now)).toBe(false);
    expect(isMuteActive(null, now)).toBe(false);
  });

  it("offers fixed lengths and an until-unmuted choice", () => {
    expect(CHANNEL_MUTE_DURATIONS.map((choice) => choice.id)).toEqual(["1h", "8h", "24h", "7d", "forever"]);
    expect(muteUntilFor("8h", now)).toBe("2026-10-02T20:00:00.000Z");
    expect(muteUntilFor("forever", now)).toBeNull();
    expect(() => muteUntilFor("1y", now)).toThrow();
  });
});

describe("pinning and mentions", () => {
  it("puts pinned threads first, most recently pinned on top, only while the switch is on", () => {
    const threads = [
      { id: "a", pinned_at: null },
      { id: "b", pinned_at: "2026-10-01T10:00:00Z" },
      { id: "c", pinned_at: null },
      { id: "d", pinned_at: "2026-10-02T10:00:00Z" },
    ];
    expect(orderThreadsForChannel(threads).map((thread) => thread.id)).toEqual(["d", "b", "a", "c"]);
    expect(orderThreadsForChannel(threads, false).map((thread) => thread.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("inserts @Name text and sends only the people still named in the draft", () => {
    expect(appendMentionText("", { name: "Ana Diaz" })).toBe("@Ana Diaz ");
    expect(appendMentionText("Thanks", { name: "Ana Diaz" })).toBe("Thanks @Ana Diaz ");
    const picked = [{ id: "1", name: "Ana Diaz" }, { id: "2", name: "Bo Kim" }, { id: "1", name: "Ana Diaz" }];
    expect(mentionIdsForBody("@Ana Diaz can you cover?", picked)).toEqual(["1"]);
  });
});

describe("complete picked mention tokens", () => {
  const picked = [{ id: "ana", name: "Ana" }];
  it.each(["@Anabel", "@Ana2", "@Ana_crew", "@Anaé", "word@Ana", "@@Ana"])("does not send Ana for %s", (body) => {
    expect(mentionIdsForBody(body, picked)).toEqual([]);
  });
  it.each(["@Ana", "@Ana, please", "(@Ana)", "Hi @Ana\n"])("sends a complete token in %s", (body) => {
    expect(mentionIdsForBody(body, picked)).toEqual(["ana"]);
  });
  it("escapes names and refuses empty names", () => {
    expect(mentionIdsForBody("@A+B", [{ id: "a", name: "A+B" }, { id: "blank", name: " " }])).toEqual(["a"]);
  });
});

// BUG-UG-CHANNEL-MENTION-PREFIX-RECIPIENT-20261020: a name that
// prefixes a longer picked name must not keep the shorter person on the send
// once only the longer mention is left in the draft.
describe("mention names that prefix another picked name", () => {
  const ana = { id: "ana", name: "Ana" };
  const anaDiaz = { id: "diaz", name: "Ana Diaz" };
  it.each([[[ana, anaDiaz]], [[anaDiaz, ana]]])("drops the deleted short mention and keeps the longer one, whatever the pick order", (picked) => {
    expect(mentionIdsForBody("@Ana Diaz can you cover?", picked)).toEqual(["diaz"]);
    expect(mentionIdsForBody("thanks @Ana Diaz.", picked)).toEqual(["diaz"]);
  });
  it.each([[[ana, anaDiaz]], [[anaDiaz, ana]]])("still sends both when two separate mentions are written, in either order", (picked) => {
    for (const body of ["@Ana and @Ana Diaz", "@Ana Diaz and @Ana", "@Ana, @Ana Diaz.", "@Ana Diaz\n(@Ana)"]) {
      expect([...mentionIdsForBody(body, picked)].sort()).toEqual(["ana", "diaz"]);
    }
  });
  it("keeps a standalone short mention and drops a longer name that is gone", () => {
    expect(mentionIdsForBody("@Ana please", [ana, anaDiaz])).toEqual(["ana"]);
    expect(mentionIdsForBody("@Ana, please", [anaDiaz])).toEqual([]);
  });
  it("does not let the consumed longer token create a boundary for a short name", () => {
    expect(mentionIdsForBody("@Ana Diaz@Ana", [ana, anaDiaz])).toEqual(["diaz"]);
  });
  it("sends every person sharing one written name, and still suppresses duplicate ids", () => {
    const twin = { id: "twin", name: "Ana" };
    expect(mentionIdsForBody("@Ana hi", [ana, twin, ana])).toEqual(["ana", "twin"]);
  });
  it("reads an empty draft, a missing list and unusable picked entries as no mentions", () => {
    expect(mentionIdsForBody(null, null)).toEqual([]);
    expect(mentionIdsForBody(undefined, undefined)).toEqual([]);
    expect(mentionIdsForBody("", [ana])).toEqual([]);
    expect(mentionIdsForBody("@Ana @Bo", [null, undefined, { name: "Ana" }, { id: "", name: "Ana" }, { id: "bo" }, { id: "bo2", name: null }, { id: "bo3", name: "  " }])).toEqual([]);
    expect(mentionIdsForBody("@Ana", [null, { id: "x" }, ana])).toEqual(["ana"]);
  });
  it("applies the mention limit in picked order after reconciliation", () => {
    const limit = 20; // MAX_MENTIONS_PER_POST in channelControls.js
    const people = Array.from({ length: limit + 2 }, (_, index) => ({ id: `p${index}`, name: `Person${index}` }));
    const body = [...people].reverse().map((person) => `@${person.name}`).join(" ");
    expect(mentionIdsForBody(body, people)).toEqual(people.slice(0, limit).map((person) => person.id));
  });
});

describe("server answers", () => {
  it("reads a missing or malformed answer as every control off", () => {
    expect(normalizeChannelControls(null)).toBe(UNAVAILABLE_CHANNEL_CONTROLS);
    const partial = normalizeChannelControls({ available: true, switches: { mentions: true, keywordAlerts: "yes" }, spaces: { s1: { level: "loud", keywords: ["ot", 3] } } });
    expect(partial.switches).toMatchObject({ mentions: true, keywordAlerts: false, channelMute: false });
    expect(channelSettingFor(partial, "s1")).toMatchObject({ level: "mentions", keywords: ["ot"], muted: false });
    expect(channelSettingFor(partial, "missing")).toMatchObject({ spaceId: "missing", level: "mentions" });
  });

  it("recognises the switch-off and keyword-limit refusals", () => {
    expect(isChannelControlDisabled({ code: "42501", details: "feature-disabled" })).toBe(true);
    expect(isChannelControlDisabled({ code: "42501", details: null })).toBe(false);
    expect(isKeywordLimitError({ code: "22023", details: "keyword-limit" })).toBe(true);
  });
});
