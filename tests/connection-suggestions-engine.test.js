import { describe, expect, it, vi } from "vitest";
import {
  CONNECTION_WEIGHT_KEYS,
  DEFAULT_CONNECTION_SETTINGS,
} from "../src/features/connectionSuggestions/contract.js";
import {
  collectPublishedProfiles,
  normalizeConnectionSettings,
  normalizePublishedProfile,
  rankConnections,
  scoreConnection,
} from "../src/features/connectionSuggestions/engine.js";
import {
  aggregateConfirmedConnectionSignals,
  proposeConnectionIssueTags,
} from "../src/features/connectionSuggestions/signals.js";

const now = "2026-09-27T12:00:00.000Z";
const weights = (overrides = {}) => Object.fromEntries(CONNECTION_WEIGHT_KEYS.map((key) => [key, overrides[key] ?? 0]));
const profile = (id, overrides = {}) => ({
  id, kind: "chapter", displayName: `Fictional ${id}`, discoverable: true,
  location: { country: "US", state: "MA", metro: "Boston" },
  sectorKeys: ["healthcare"],
  issuePriorities: [{ key: "staffing", strength: 1 }],
  expertiseOffered: ["staffing"],
  assistanceNeeds: [{ key: "staffing", strength: 1 }],
  localKey: "fictional-local-a", unionFamilyKey: "fictional-union-a",
  publishedAt: "2026-09-01T12:00:00.000Z", profileRevision: 1,
  ...overrides,
});
const source = profile("source", { discoverable: false });
const ranked = (candidates, settings = {}, overrides = {}) => rankConnections({ source, candidates, settings, now, ...overrides });

describe("chapter connection preferences and public data boundary", () => {
  it("rejects individual source profiles and malformed block lists", () => {
    expect(ranked([profile("one")], {}, { source: profile("person", { kind: "person" }) }).reason).toBe("invalid_source");
    for (const blockedIds of ["one", null, {}, [42]]) expect(() => ranked([profile("one")], {}, { blockedIds })).toThrow(/blocked chapter/);
  });
  it("normalizes padded country codes, Unicode metros and whitespace consistently", () => {
    for (const [a, b] of [["New York", "New\nYork"], ["São Paulo", "Sa\u0303o Paulo"], ["Boston", "Boston\u200b"]]) {
      const result = ranked([profile("one", { location: { country: " US ", state: "MA", metro: b } })], { reach: "same-state", weights: weights({ location: 100 }) }, { source: profile("source", { location: { country: "US", state: "MA", metro: a } }) });
      expect(result.results[0].score).toBe(1);
    }
  });
  it("preserves every zero and rejects malformed supplied weights", () => {
    expect(normalizeConnectionSettings({ weights: weights() }).weights).toEqual(weights());
    expect(normalizeConnectionSettings()).toEqual(DEFAULT_CONNECTION_SETTINGS);
    for (const invalid of [NaN, Infinity, -1, 101, "20", null, true]) {
      expect(() => normalizeConnectionSettings({ weights: { issues: invalid } })).toThrow();
    }
    expect(() => normalizeConnectionSettings({ weights: [] })).toThrow();
    expect(() => normalizeConnectionSettings({ reach: "nearby" })).toThrow();
    expect(() => normalizeConnectionSettings({ diversity: 0.11 })).toThrow();
    expect(() => normalizeConnectionSettings({ freshnessDays: 0 })).toThrow();
  });

  it("requires explicit discoverability and keeps only published profile fields", () => {
    expect(normalizePublishedProfile(profile("one", { discoverable: undefined }))).toBeNull();
    expect(normalizePublishedProfile(profile("one", { kind: "person" }))).toBeNull();
    const normalized = normalizePublishedProfile(profile("one", {
      rawGrievance: "secret source", memberId: "private-person", supportCount: 87,
      location: { country: "us", state: "ma", metro: "BOSTON", homeAddress: "private address" },
      sectorKeys: ["healthcare", "healthcare", "unknown"],
      issuePriorities: [{ key: "staffing", strength: 0.5 }, { key: "staffing", strength: 1 }, { key: "unknown", strength: 1 }],
    }));
    expect(normalized.location).toEqual({ country: "US", state: "MA", metro: "BOSTON" });
    expect(normalized.sectorKeys).toEqual(["healthcare"]);
    expect(normalized.issuePriorities).toEqual([{ key: "staffing", strength: 1 }]);
    expect(JSON.stringify(normalized)).not.toMatch(/secret source|private-person|private address|supportCount/);
  });

  it("retains bounded identity provenance without elevating declared or missing identities", () => {
    const normalized = normalizePublishedProfile(profile("one", { identityProvenance: {
      localKey: "declared", unionFamilyKey: "verified", privateSource: "must disappear",
    } }));
    expect(normalized.identityProvenance).toEqual({ localKey: "declared", unionFamilyKey: "verified" });
    expect(normalizePublishedProfile(profile("one")).identityProvenance).toEqual({ localKey: null, unionFamilyKey: null });
    expect(normalizePublishedProfile(profile("one", { localKey: "bad/key", identityProvenance: {
      localKey: "verified", unionFamilyKey: "unknown",
    } })).identityProvenance).toEqual({ localKey: null, unionFamilyKey: null });
    expect(ranked([profile("one", { identityProvenance: normalized.identityProvenance })]).results[0].identityProvenance)
      .toEqual(normalized.identityProvenance);
  });

  it("does not match self, blocked, unpublished, invalid, or conflicting profiles", () => {
    const result = ranked([
      profile("source"), profile("blocked"), profile("unpublished", { discoverable: false }),
      profile("valid"), profile("valid"), profile("conflict"), profile("conflict", { localKey: "other" }), null,
    ], {}, { blockedIds: new Set(["blocked"]) });
    expect(result.results.map((item) => item.id)).toEqual(["valid"]);
    expect(result.eligibleCount).toBe(1);
    expect(result.scannedCount).toBe(8);
  });

  it("has honest states for zero dials, absent source facts and no published profiles", () => {
    expect(ranked([profile("one")], { weights: weights() })).toMatchObject({ state: "empty", reason: "needs_preferences", results: [] });
    expect(ranked([profile("one")], { weights: weights({ issues: 100 }) }, { source: profile("source", { issuePriorities: [] }) }))
      .toMatchObject({ state: "empty", reason: "insufficient_source_data", results: [] });
    expect(ranked([])).toMatchObject({ state: "empty", reason: "no_eligible_profiles", results: [] });
    expect(rankConnections({ candidates: [profile("one")] })).toMatchObject({ reason: "invalid_source" });
    expect(ranked([profile("unrelated", { sectorKeys: ["education"] })], { weights: weights({ sector: 100 }) }))
      .toMatchObject({ state: "empty", reason: "no_positive_match", eligibleCount: 1, results: [] });
  });
});

describe("chapter connection scoring", () => {
  it("never inflates sparse candidates through candidate-specific normalization", () => {
    const result = ranked([
      profile("sparse", { sectorKeys: [] }),
      profile("complete"),
      profile("different", { sectorKeys: ["education"] }),
    ], { weights: weights({ sector: 50, issues: 50 }) });
    const sparse = result.results.find((item) => item.id === "sparse");
    const different = result.results.find((item) => item.id === "different");
    expect(result.results[0]).toMatchObject({ id: "complete", score: 1, coverage: 1 });
    expect(sparse).toMatchObject({ score: 0.5, coverage: 0.5, missingDimensions: ["sector"] });
    expect(different).toMatchObject({ score: 0.5, coverage: 1, missingDimensions: [] });
    expect(sparse.contributions.find((item) => item.dimension === "sector").similarity).toBeNull();
    expect(different.contributions.find((item) => item.dimension === "sector").similarity).toBe(0);
  });

  it("disables missing source dimensions globally and reports which were unavailable", () => {
    const result = ranked([profile("one")], { weights: weights({ sector: 50, issues: 50 }) }, {
      source: { ...source, sectorKeys: [] },
    });
    expect(result.disabledDimensions).toEqual(["sector"]);
    expect(result.effectiveWeights.sector).toBe(0);
    expect(result.results[0].score).toBe(1);
  });

  it("makes issue similarity symmetric and expertise coverage directional", () => {
    const first = profile("first", {
      issuePriorities: [{ key: "pay", strength: 1 }, { key: "safety", strength: 0.5 }],
      assistanceNeeds: [{ key: "pay", strength: 1 }], expertiseOffered: ["pay", "safety"],
    });
    const second = profile("second", {
      issuePriorities: [{ key: "pay", strength: 0.5 }],
      assistanceNeeds: [{ key: "pay", strength: 1 }, { key: "safety", strength: 1 }], expertiseOffered: ["safety"],
    });
    const issueScore = (a, b) => scoreConnection({ source: a, candidate: b, settings: { weights: weights({ issues: 100 }) } }).score;
    expect(issueScore(first, second)).toBeCloseTo(1 / 3);
    expect(issueScore(first, second)).toBe(issueScore(second, first));
    const expertiseScore = (a, b) => scoreConnection({ source: a, candidate: b, settings: { weights: weights({ expertise: 100 }) } }).score;
    expect(expertiseScore(first, second)).toBe(0);
    expect(expertiseScore(second, first)).toBe(1);
  });

  it("keeps a zero dial inactive in both ranking and diversity", () => {
    const candidates = [profile("one"), profile("two"), profile("three", { sectorKeys: ["education"] })];
    const settings = { weights: weights({ sector: 100 }), diversity: 0.1 };
    const before = ranked(candidates, settings).results;
    const changed = candidates.map((item, index) => ({
      ...item, location: { country: index ? "CA" : "FR" }, unionFamilyKey: `changed-${index}`,
      localKey: null, issuePriorities: [], expertiseOffered: [],
    }));
    const after = ranked(changed, settings).results;
    expect(after.map(({ id, score, diversityPenalty, reasons }) => ({ id, score, diversityPenalty, reasons })))
      .toEqual(before.map(({ id, score, diversityPenalty, reasons }) => ({ id, score, diversityPenalty, reasons })));
    expect(after.every((item) => item.contributions.length === 1)).toBe(true);
  });

  it("is stable across permutations, duplicates, tie labels and proportional weights", () => {
    const candidates = [profile("z", { displayName: "A" }), profile("a", { displayName: "Z" }), profile("m")];
    const one = ranked(candidates, { weights: weights({ issues: 50, sector: 25 }), diversity: 0.1 });
    const two = ranked([...candidates].reverse().concat(candidates[0]), { weights: weights({ issues: 100, sector: 50 }), diversity: 0.1 });
    expect(one.results).toEqual(two.results.map((item) => ({
      ...item, contributions: item.contributions.map((part) => ({ ...part, weight: part.weight / 2 })),
    })));
    expect(one.results.map((item) => item.id)).toEqual(["a", "m", "z"]);
  });

  it("uses diversity only within its bounded relevance penalty", () => {
    const input = [
      profile("a", { issuePriorities: [{ key: "pay", strength: 1 }] }),
      profile("b", { issuePriorities: [{ key: "pay", strength: 1 }] }),
      profile("c", { issuePriorities: [{ key: "safety", strength: 1 }] }),
    ];
    const thisSource = { ...source, issuePriorities: [{ key: "pay", strength: 1 }, { key: "safety", strength: 1 }] };
    expect(ranked(input, { weights: weights({ issues: 100 }) }, { source: thisSource }).results.map((item) => item.id)).toEqual(["a", "b", "c"]);
    const result = ranked(input, { weights: weights({ issues: 100 }), diversity: 0.1 }, { source: thisSource });
    expect(result.results.map((item) => item.id)).toEqual(["a", "c", "b"]);
    expect(result.results.map((item) => item.diversityPenalty)).toEqual([0, 0, 0.1]);
  });

  it("treats geographic reach as an explicit hard filter even when its dial is zero", () => {
    const candidates = [profile("near"), profile("other-state", { location: { country: "US", state: "NY" } }), profile("abroad", { location: { country: "CA", state: "ON" } }), profile("unknown", { location: {} })];
    const preferences = { weights: weights({ issues: 100 }), reach: "same-state" };
    expect(ranked(candidates, preferences).results.map((item) => item.id)).toEqual(["near"]);
    expect(ranked(candidates, { ...preferences, reach: "same-country" }).results).toHaveLength(2);
    expect(ranked(candidates, { ...preferences, reach: "anywhere" }).results).toHaveLength(4);
    expect(ranked(candidates, preferences, { source: { ...source, location: {} } }).reason).toBe("reach_location_required");
  });

  it("adjusts geographic scale using only published country/state/metro facts", () => {
    const otherMetro = profile("one", { location: { country: "US", state: "MA", metro: "Worcester" } });
    const atScale = (locationScale) => ranked([otherMetro], { weights: weights({ location: 100 }), locationScale }).results[0].score;
    expect(atScale("metro")).toBe(0.5);
    expect(atScale("state")).toBe(1);
    expect(atScale("country")).toBe(1);
    const abroad = profile("abroad", { location: { country: "CA", state: "MA", metro: "Boston" } });
    expect(ranked([abroad], { weights: weights({ location: 100 }) }).reason).toBe("no_positive_match");
    expect(ranked([profile("case", { location: { country: "us", state: "ma", metro: "BOSTON" } })], { weights: weights({ location: 100 }) }).results[0])
      .toMatchObject({ score: 1, location: { metro: "BOSTON" } });
  });

  it("filters freshness on publication metadata with an explicit clock and inclusive boundary", () => {
    const publishedAt = "2026-08-28T12:00:00.000Z";
    const candidates = [profile("boundary", { publishedAt }), profile("stale", { publishedAt: "2026-08-28T11:59:59.999Z" }), profile("missing", { publishedAt: null }), profile("future", { publishedAt: "2026-09-28T12:00:00.000Z" })];
    expect(ranked(candidates, { freshnessDays: 30 }).results.map((item) => item.id)).toEqual(["boundary"]);
    expect(() => rankConnections({ source, candidates, settings: { freshnessDays: 30 } })).toThrow(/explicit current time/);
    const output = ranked([profile("private-time", { privateActivityAt: "2020-01-01", publishedAt })], { freshnessDays: 30 });
    expect(output.results).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain("privateActivityAt");
  });
});

describe("exhaustive published-profile traversal", () => {
  it("reranks 10,000 synthetic profiles exactly and reproducibly without a candidate cap", () => {
    const candidates = Array.from({ length: 10000 }, (_, index) => profile(`chapter-${String(index).padStart(5, "0")}`, {
      issuePriorities: [{ key: index % 3 ? "pay" : "safety", strength: 1 }],
    }));
    const settings = { weights: weights({ issues: 100 }), diversity: 0.1 };
    const overrides = { source: { ...source, issuePriorities: [{ key: "pay", strength: 1 }, { key: "safety", strength: 1 }] } };
    const first = ranked(candidates, settings, overrides);
    const second = ranked([...candidates].reverse(), settings, overrides);
    expect(first.eligibleCount).toBe(10000);
    expect(first.results).toEqual(second.results);
    expect(first.results.slice(0, 3).map((item) => item.id)).toEqual(["chapter-00000", "chapter-00001", "chapter-00002"]);
  });

  it("ranks a best match beyond 1,000 candidates after the full stream completes", async () => {
    const records = Array.from({ length: 1205 }, (_, index) => profile(`chapter-${String(index).padStart(4, "0")}`, {
      sectorKeys: index === 1204 ? ["healthcare"] : ["education"],
    }));
    const fetchPage = vi.fn(async ({ afterId, limit }) => {
      const start = afterId ? records.findIndex((item) => item.id === afterId) + 1 : 0;
      const rows = records.slice(start, start + limit);
      const complete = start + rows.length === records.length;
      return { rows, complete, nextCursor: complete ? null : rows.at(-1).id, snapshotToken: "published-revision-1" };
    });
    const result = await collectPublishedProfiles(fetchPage);
    expect(result.profiles).toHaveLength(1205);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(ranked(result.profiles, { weights: weights({ sector: 100 }) }).results[0].id).toBe("chapter-1204");
  });

  it("rejects incomplete, nonadvancing, unordered and revision-changing streams", async () => {
    const cases = [
      [{ rows: [], complete: false, nextCursor: "a", snapshotToken: "one" }],
      [{ rows: [profile("b"), profile("a")], complete: true, nextCursor: null, snapshotToken: "one" }],
      [{ rows: [profile("a")], complete: true, nextCursor: "a", snapshotToken: "one" }],
      [{ rows: [profile("a")], complete: false, nextCursor: "a", snapshotToken: "one" }, { rows: [profile("b")], complete: true, nextCursor: null, snapshotToken: "two" }],
      [{ rows: [profile("a")], complete: false, nextCursor: "a", snapshotToken: "one" }, { rows: [profile("a")], complete: true, nextCursor: null, snapshotToken: "one" }],
    ];
    for (const pages of cases) {
      let page = 0;
      await expect(collectPublishedProfiles(async () => pages[page++])).rejects.toThrow();
    }
  });

  it("propagates aborts and source failures without returning partial results", async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn(async () => {
      controller.abort();
      return { rows: [profile("a")], complete: true, nextCursor: null, snapshotToken: "one" };
    });
    await expect(collectPublishedProfiles(fetchPage, { signal: controller.signal })).rejects.toThrow();
    await expect(collectPublishedProfiles(async () => { throw new Error("reader unavailable"); })).rejects.toThrow("reader unavailable");
  });
});

const observation = (subjectId, topicKeys = ["staffing"], overrides = {}) => ({
  organizationId: "fictional-org", chapterId: "fictional-chapter", subjectId,
  sourceKind: "grievance", occurredAt: "2026-05-10T12:00:00.000Z",
  reviewStatus: "confirmed", topicKeys, ...overrides,
});
const aggregate = (observations, overrides = {}) => aggregateConfirmedConnectionSignals({
  organizationId: "fictional-org", chapterId: "fictional-chapter",
  windowStart: "2026-04-01", windowEnd: "2026-07-01", asOf: now, observations, ...overrides,
});
const cohort = (yes, no) => [
  ...Array.from({ length: yes }, (_, index) => observation(`yes-${index}`)),
  ...Array.from({ length: no }, (_, index) => observation(`no-${index}`, [])),
];

describe("reviewed tenant-local issue signals", () => {
  it("rejects ambiguous datetimes and never manufactures a keyword by cutting a word", () => {
    expect(aggregate(cohort(25, 25), { asOf: "2026-06-30T22:00:00" }).state).toBe("invalid_scope_or_window");
    expect(aggregate([...cohort(24, 25), observation("ambiguous", ["staffing"], { occurredAt: "2026-03-31T22:00:00" })]).state).toBe("suppressed");
    expect(aggregate([...cohort(24, 25), observation("explicit", ["staffing"], { occurredAt: "2026-03-31T22:00:00-04:00" })]).state).toBe("ready");
    for (const text of ["a".repeat(9997) + "payment details", "payé", "支付pay款"]) expect(proposeConnectionIssueTags({ sourceKind: "survey", text }).proposals).toEqual([]);
  });
  it("proposes only known topics requiring review and never returns source text", () => {
    const result = proposeConnectionIssueTags({ sourceKind: "feedback", category: "scheduling", text: "PrivateName describes unsafe staffing and overtime." });
    expect(result.proposals.map((item) => item.key)).toEqual(["staffing", "scheduling", "pay", "safety"]);
    expect(result.proposals.every((item) => item.reviewRequired)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PrivateName|unsafe staffing|overtime/);
    expect(proposeConnectionIssueTags({ sourceKind: "person-profile", text: "pay" })).toEqual({ state: "unsupported_source", proposals: [] });
    expect(proposeConnectionIssueTags({ sourceKind: "survey", text: "repair payment" }).proposals).toEqual([]);
  });

  it("requires 25 distinct supporters and 25 distinct non-supporters", () => {
    expect(aggregate(cohort(24, 26))).toMatchObject({ state: "suppressed", issuePriorities: [] });
    expect(aggregate(cohort(26, 24))).toMatchObject({ state: "suppressed", issuePriorities: [] });
    expect(aggregate(cohort(25, 25))).toMatchObject({ state: "ready", issuePriorities: [{ key: "staffing", strength: 0.5 }] });
    expect(aggregate(cohort(50, 0))).toMatchObject({ state: "suppressed", issuePriorities: [] });
  });

  it("uses the organization floor on both sides and refuses values below the hard minimum", () => {
    const configuration = { switches: { "limits.intelligence.connection_issue_floor": 15 } };
    expect(aggregate(cohort(15, 15), { configuration }).state).toBe("ready");
    expect(aggregate(cohort(14, 16), { configuration }).state).toBe("suppressed");
    configuration.switches["limits.intelligence.connection_issue_floor"] = 14;
    expect(aggregate(cohort(15, 15), { configuration }).state).toBe("suppressed");
  });

  it("deduplicates each contributor/topic across all source kinds", () => {
    const inputs = cohort(24, 26);
    const duplicates = Array.from({ length: 60 }, (_, index) => observation("yes-0", ["staffing", "staffing"], { sourceKind: index % 2 ? "survey" : "feedback" }));
    expect(aggregate([...inputs, ...duplicates]).issuePriorities).toEqual([]);
    expect(aggregate([...cohort(25, 25), ...duplicates])).toEqual(aggregate(cohort(25, 25)));
    expect(aggregate(Array.from({ length: 100 }, () => observation("single-person"))).state).toBe("suppressed");
  });

  it("rejects unreviewed text, client counts, foreign scope and unknown contributor identities", () => {
    const valid = cohort(24, 25);
    const unsafe = [
      observation("other-org", ["staffing"], { organizationId: "other" }),
      observation("other-chapter", ["staffing"], { chapterId: "other" }),
      observation("pending", ["staffing"], { reviewStatus: "proposed", rawText: "staffing", count: 1000 }),
      observation(null, ["staffing"]),
      observation("unknown-topic", ["staffing", "unapproved"]),
      observation("unknown-kind", ["staffing"], { sourceKind: "member-profile" }),
      observation("boundary", ["staffing"], { occurredAt: "2026-07-01T00:00:00.000Z" }),
    ];
    expect(aggregate([...valid, ...unsafe])).toMatchObject({ state: "suppressed", issuePriorities: [] });
    const ready = aggregate(cohort(25, 25));
    expect(Object.keys(ready).sort()).toEqual(["issuePriorities", "schema", "state", "taxonomyVersion", "windowEnd", "windowStart"]);
    expect(JSON.stringify(ready)).not.toMatch(/subject|count|sourceKind|rawText|fictional-org/);
  });

  it("permits only completed, fixed, nonoverlapping calendar quarters", () => {
    for (const bounds of [
      { windowStart: "2026-04-02" }, { windowEnd: "2026-06-30" },
      { windowStart: "2026-07-01", windowEnd: "2026-10-01" },
      { windowStart: "2026-02-30" }, { asOf: null },
    ]) expect(aggregate(cohort(25, 25), bounds).state).toBe("invalid_scope_or_window");
    expect(aggregate(cohort(25, 25), { asOf: "2026-07-01T00:00:00.000Z" }).state).toBe("ready");
  });

  it("emits coarse priorities without revealing exact cohort totals", () => {
    expect(aggregate(cohort(25, 75)).issuePriorities).toEqual([{ key: "staffing", strength: 0.25 }]);
    expect(aggregate(cohort(50, 50)).issuePriorities).toEqual([{ key: "staffing", strength: 0.5 }]);
    expect(aggregate(cohort(75, 25)).issuePriorities).toEqual([{ key: "staffing", strength: 0.75 }]);
    expect(aggregate([...cohort(25, 25)].reverse())).toEqual(aggregate(cohort(25, 25)));
  });
});
