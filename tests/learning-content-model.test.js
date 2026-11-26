// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as model from "../src/features/learningContent/model.js";
import { learningContentCatalogue } from "../src/lib/i18n/learningContent.js";
import { TIER1_MARKERS, USTED_MARKERS } from "./i18nRegisterMarkers.js";

const {
  LEARNING_EDITABLE_FIELDS, LEARNING_LIMITS, LEARNING_PAGE_SIZE,
  buildLearningItemPayload, codePointLength, emptyLearningDraft, isLearningItemDeliverable, isLearningItemEligible,
  isLearningItemLive, learningDayKey, learningDraftFromItem, learningDraftFromSnapshot, learningErrorKind,
  learningHomeRequest, learningLibraryRequest, learningPayloadBytes, learningPayloadsEqual, learningPublicationIssues,
  learningPublicationState, learningRotationSeed, learningRotationStorageKey, learningSourceRequired, learningTransitionsFor,
  liveLearningCount, nextLearningBoundary, nextLearningIndex, normalizeLearningHistoryPage, normalizeLearningHomeHidden,
  normalizeLearningItem, normalizeLearningPage, normalizeLearningPolicy, normalizeLearningScopePolicy, normalizeLearningWorkspace,
  orderLearningItems, parseLearningInstant, parseLearningRotationState, pickLearningItem, serializeLearningRotationState,
  stableLearningHash, validateLearningItem, validateLearningTransition,
} = model;

const NOW = Date.UTC(2026, 8, 28, 16, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const codes = (issues) => issues.map((issue) => `${issue.field}:${issue.code}${issue.index != null ? `#${issue.index}` : ""}`);

function row(patch = {}) {
  return {
    id: "item-1", scope: "chapter", organization_id: "org-1", chapter_id: "chapter-1",
    kind: "quote", locale: "en", locale_state: "reviewed", audience: "all", status: "published",
    title: "A title", body: "A body", attribution: "", source: "", rights_note: "Ours", review_note: "Checked",
    bullets: [], direction: "", topics: [], tone: "", learning_outcome: "", factual_claims: false,
    priority: 0, is_default: false, starts_at: iso(NOW - 60000), ends_at: null, revision: 3, provenance: {},
    ...patch,
  };
}
const item = (patch) => normalizeLearningItem(row(patch));
const draft = (patch = {}) => ({ ...emptyLearningDraft({ kind: "quote", locale: "en" }), title: "Title", body: "Body", ...patch });

describe("the pure module stays shareable with native", () => {
  it("imports nothing, so Metro can bundle it without React, storage or the web catalogue", () => {
    const source = readFileSync(resolve(process.cwd(), "src/features/learningContent/model.js"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\b(?:window|document|localStorage|sessionStorage)\s*\.|\bfetch\s*\(|\brequire\s*\(/);
  });

  it("declares a type for every runtime export and nothing else", () => {
    const declarations = readFileSync(resolve(process.cwd(), "src/features/learningContent/model.d.ts"), "utf8");
    const declared = [...declarations.matchAll(/^export declare (?:const|function) (\w+)/gm)].map((match) => match[1]).sort();
    expect(declared).toEqual(Object.keys(model).sort());
  });
});

describe("limits mirror the server's learning_payload_valid", () => {
  const migrations = readdirSync(resolve(process.cwd(), "supabase/migrations")).filter((name) => name.endsWith("_governed_learning_content.sql"));
  const sql = migrations.length ? readFileSync(resolve(process.cwd(), "supabase/migrations", migrations.at(-1)), "utf8") : "";

  it("finds the governed learning content migration", () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it("sends exactly the payload keys the server requires", () => {
    const keyList = /p \?& array\[([^\]]+)\]/.exec(sql)?.[1] ?? "";
    const serverKeys = [...keyList.matchAll(/'(\w+)'/g)].map((match) => match[1]).sort();
    expect(serverKeys).toEqual([...LEARNING_EDITABLE_FIELDS].sort());
    const { id: _id, ...payload } = buildLearningItemPayload({ ...draft(), id: "x", scope: "chapter", status: "published", revision: 9, provenance: { a: 1 } });
    expect(Object.keys(payload).sort()).toEqual(serverKeys);
  });

  it("uses the same numbers the SQL enforces", () => {
    expect(sql).toContain("when 'title' then 100");
    expect(sql).toContain("when p->>'kind'='quote' then 500 else 2000");
    expect(sql).toContain("when 'attribution' then 200 when 'tone' then 100 when 'learning_outcome' then 500 else 1000");
    expect(sql).toContain("learning_strings_valid(p->'bullets',5,200)");
    expect(sql).toContain("learning_strings_valid(p->'topics',5,80)");
    expect(Number(/octet_length\(p::text\) > (\d+)/.exec(sql)?.[1])).toBe(LEARNING_LIMITS.payloadBytes);
    expect(sql).toContain("(p->>'priority')::int > 100");
    expect(LEARNING_LIMITS).toMatchObject({
      title: 100, body: { quote: 500, mini_lesson: 2000 }, attribution: 200, tone: 100, learning_outcome: 500,
      source: 1000, rights_note: 1000, review_note: 1000, direction: 1000,
      bulletCount: 5, bullet: 200, topicCount: 5, topic: 80, payloadBytes: 64000, priorityMax: 100,
    });
    expect(LEARNING_PAGE_SIZE).toEqual({ home: 100, learn: 40, workspace: 40, history: 40 });
  });

  it("trims exactly the whitespace the server's learning_trim removes", () => {
    // The set may be spelled as U&'\\0009...' escapes or as chr(9) || ... calls.
    const body = /function private\.learning_trim[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(sql)?.[1] ?? "";
    const escapes = [...body.matchAll(/\\([0-9A-Fa-f]{4})/g)].map((match) => Number.parseInt(match[1], 16));
    const calls = [...body.matchAll(/chr\((\d+)\)/g)].map((match) => Number(match[1]));
    const server = [...new Set([...escapes, ...calls])].sort((a, b) => a - b);
    const client = [];
    for (let point = 0; point <= 0xffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      if (String.fromCharCode(point).trim() === "") client.push(point);
    }
    expect(server.length).toBeGreaterThan(0);
    expect(server).toEqual(client);
  });

  it("requires a source exactly when the SQL publication check does", () => {
    const trim = "(?:btrim|private\\.learning_trim)";
    expect(sql).toMatch(new RegExp(`\\(${trim}\\(r\\.payload->>'attribution'\\)<>'' or \\(r\\.payload->>'factual_claims'\\)::boolean\\) and ${trim}\\(r\\.payload->>'source'\\)=''`));
    expect(learningSourceRequired({ attribution: "", factual_claims: false })).toBe(false);
    expect(learningSourceRequired({ attribution: "  ", factual_claims: false })).toBe(false);
    expect(learningSourceRequired({ attribution: "Someone", factual_claims: false })).toBe(true);
    expect(learningSourceRequired({ attribution: "", factual_claims: true })).toBe(true);
  });
});

describe("code points, not UTF-16 units", () => {
  it("counts astral characters once and combining marks separately", () => {
    expect(codePointLength("😀")).toBe(1);
    expect("😀".length).toBe(2);
    expect(codePointLength("é")).toBe(2);
    expect(codePointLength("👩‍👩‍👧")).toBe(5);
    expect(codePointLength(null)).toBe(0);
  });

  it("accepts 100 emoji in a title (200 UTF-16 units) and refuses 101", () => {
    expect(validateLearningItem(draft({ title: "😀".repeat(100) }))).toEqual([]);
    expect(codes(validateLearningItem(draft({ title: "😀".repeat(101) })))).toEqual(["title:too_long"]);
  });
});

describe("save validation boundaries", () => {
  const limitCases = [
    ["title", 100], ["attribution", 200], ["source", 1000], ["rights_note", 1000], ["review_note", 1000],
    ["direction", 1000], ["tone", 100], ["learning_outcome", 500],
  ];
  it.each(limitCases)("%s accepts %i code points and refuses one more", (field, limit) => {
    expect(validateLearningItem(draft({ [field]: "a".repeat(limit) }))).toEqual([]);
    const issues = validateLearningItem(draft({ [field]: "a".repeat(limit + 1) }));
    expect(issues).toEqual([{ field, code: "too_long", limit }]);
  });

  it("measures after trimming, which is what the payload sends", () => {
    expect(validateLearningItem(draft({ title: `  ${"a".repeat(100)}\n ` }))).toEqual([]);
    expect(buildLearningItemPayload(draft({ title: `  ${"a".repeat(100)}\n ` })).title).toBe("a".repeat(100));
  });

  it("bounds the body by kind: quote 500, mini-lesson 2000", () => {
    expect(validateLearningItem(draft({ body: "b".repeat(500) }))).toEqual([]);
    expect(codes(validateLearningItem(draft({ body: "b".repeat(501) })))).toEqual(["body:too_long"]);
    const lesson = draft({ kind: "mini_lesson", body: "b".repeat(2000) });
    expect(validateLearningItem(lesson)).toEqual([]);
    expect(validateLearningItem({ ...lesson, body: "b".repeat(2001) })).toEqual([{ field: "body", code: "too_long", limit: 2000 }]);
    // Switching a long lesson to a quote is refused, not silently truncated.
    expect(codes(validateLearningItem({ ...lesson, kind: "quote" }))).toEqual(["body:too_long"]);
  });

  it("requires a title and a body that are more than whitespace", () => {
    expect(codes(validateLearningItem(draft({ title: " \n\t", body: "   " })))).toEqual(["title:required", "body:required"]);
  });

  it("allows five non-empty key points and topics within their lengths", () => {
    const ok = draft({ bullets: Array(5).fill("p".repeat(200)), topics: Array(5).fill("t".repeat(80)) });
    expect(validateLearningItem(ok)).toEqual([]);
    expect(codes(validateLearningItem({ ...ok, bullets: Array(6).fill("p") }))).toEqual(["bullets:too_many"]);
    expect(codes(validateLearningItem({ ...ok, topics: Array(6).fill("t") }))).toEqual(["topics:too_many"]);
    expect(codes(validateLearningItem({ ...ok, bullets: ["p", "  ", "p".repeat(201)] }))).toEqual(["bullets:empty_entry#1", "bullets:entry_too_long#2"]);
    expect(codes(validateLearningItem({ ...ok, topics: ["", "t".repeat(81)] }))).toEqual(["topics:empty_entry#0", "topics:entry_too_long#1"]);
  });

  it("takes whole-number priorities from 0 to 100 only", () => {
    for (const priority of [0, 100, "42", " 7 "]) expect(validateLearningItem(draft({ priority })), String(priority)).toEqual([]);
    for (const priority of [-1, 101, 12.5, "", "abc", null, "1e2x"]) {
      expect(codes(validateLearningItem(draft({ priority }))), String(priority)).toEqual(["priority:out_of_range"]);
    }
    expect(buildLearningItemPayload(draft({ priority: "42" })).priority).toBe(42);
  });

  it("refuses unknown enums and a default flag outside the platform scope", () => {
    expect(codes(validateLearningItem(draft({ kind: "essay", locale: "fr", locale_state: "done", audience: "public" }))))
      .toEqual(["kind:invalid", "locale:invalid", "locale_state:invalid", "audience:invalid"]);
    expect(codes(validateLearningItem(draft({ is_default: true }), { scope: "organization" }))).toEqual(["is_default:platform_only"]);
    expect(validateLearningItem(draft({ is_default: true }), { scope: "platform" })).toEqual([]);
  });

  it("keeps even the heaviest valid payload under the server's jsonb byte bound", () => {
    // Control characters print as six-byte \u00XX escapes in jsonb text.
    const heavy = (length) => "\u0001".repeat(length);
    const worst = draft({
      kind: "mini_lesson", title: heavy(100), body: heavy(2000), attribution: heavy(200), source: heavy(1000), rights_note: heavy(1000),
      review_note: heavy(1000), direction: heavy(1000), tone: heavy(100), learning_outcome: heavy(500),
      bullets: Array(5).fill(heavy(200)), topics: Array(5).fill(heavy(80)),
    });
    expect(validateLearningItem(worst)).toEqual([]);
    const { id: _id, ...payload } = buildLearningItemPayload(worst);
    expect(learningPayloadBytes(payload)).toBeGreaterThan(50000);
    expect(learningPayloadBytes(payload)).toBeLessThanOrEqual(LEARNING_LIMITS.payloadBytes);
  });

  it("counts payload bytes the way PostgreSQL prints jsonb", () => {
    const jsonbText = (value) => {
      if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
      if (value && typeof value === "object") return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}: ${jsonbText(entry)}`).join(", ")}}`;
      return JSON.stringify(value);
    };
    for (const sample of [
      draft(),
      draft({ kind: "mini_lesson", bullets: ["uno", "dos", "tres"], topics: ["ñandú"], body: "Line one\n\"quoted\" \\ back 😀" }),
      draft({ topics: [], bullets: ["only"] }),
    ]) {
      const { id: _id, ...payload } = buildLearningItemPayload(sample);
      expect(learningPayloadBytes(payload)).toBe(Buffer.byteLength(jsonbText(payload), "utf8"));
    }
  });
});

describe("publication readiness", () => {
  it("needs a reviewed locale, rights and review notes before publishing", () => {
    const unreviewed = draft({ locale_state: "draft", rights_note: "", review_note: "" });
    expect(validateLearningItem(unreviewed)).toEqual([]);
    expect(codes(validateLearningItem(unreviewed, { mode: "publish" }))).toEqual(["locale_state:not_reviewed", "rights_note:required", "review_note:required"]);
    expect(learningPublicationIssues(item({}))).toEqual([]);
  });

  it("asks attributed quotes and factual lessons for a source, and nothing else", () => {
    const ready = { locale_state: "reviewed", rights_note: "Ours", review_note: "Checked" };
    expect(learningPublicationIssues(draft({ ...ready }))).toEqual([]);
    expect(codes(learningPublicationIssues(draft({ ...ready, attribution: "A speaker" })))).toEqual(["source:required"]);
    const lesson = { ...emptyLearningDraft({ kind: "mini_lesson" }), title: "T", body: "B", ...ready };
    expect(lesson.factual_claims).toBe(true);
    expect(codes(learningPublicationIssues(lesson))).toEqual(["source:required"]);
    expect(learningPublicationIssues({ ...lesson, factual_claims: false })).toEqual([]);
    expect(learningPublicationIssues({ ...lesson, source: "A cited source" })).toEqual([]);
  });

  it("checks publication windows like transition_learning_content", () => {
    expect(validateLearningTransition({ action: "publish", nowMs: NOW })).toEqual([]);
    expect(codes(validateLearningTransition({ action: "publish", startsAt: iso(NOW + 1000), nowMs: NOW }))).toEqual(["starts_at:not_allowed"]);
    expect(codes(validateLearningTransition({ action: "publish", endsAt: iso(NOW), nowMs: NOW }))).toEqual(["ends_at:not_after_start"]);
    expect(validateLearningTransition({ action: "publish", endsAt: iso(NOW + 1), nowMs: NOW })).toEqual([]);
    expect(codes(validateLearningTransition({ action: "schedule", nowMs: NOW }))).toEqual(["starts_at:required"]);
    expect(codes(validateLearningTransition({ action: "schedule", startsAt: iso(NOW), nowMs: NOW }))).toEqual(["starts_at:not_future"]);
    expect(validateLearningTransition({ action: "schedule", startsAt: iso(NOW + 1), nowMs: NOW })).toEqual([]);
    expect(codes(validateLearningTransition({ action: "schedule", startsAt: iso(NOW + 5000), endsAt: iso(NOW + 5000), nowMs: NOW }))).toEqual(["ends_at:not_after_start"]);
    expect(codes(validateLearningTransition({ action: "schedule", startsAt: "2026-10-01T09:00", nowMs: NOW }))).toEqual(["starts_at:invalid_date"]);
    expect(codes(validateLearningTransition({ action: "withdraw", endsAt: iso(NOW + 1), nowMs: NOW }))).toEqual(["starts_at:not_allowed"]);
    expect(validateLearningTransition({ action: "withdraw", nowMs: NOW })).toEqual([]);
    expect(codes(validateLearningTransition({ action: "delete", nowMs: NOW }))).toEqual(["action:invalid"]);
    expect(learningTransitionsFor("draft")).toEqual(["publish", "schedule"]);
    expect(learningTransitionsFor("published")).toEqual(["publish", "schedule", "withdraw"]);
  });
});

describe("payloads and drafts", () => {
  it("never sends ownership, status, dates, revision or provenance", () => {
    const payload = buildLearningItemPayload(learningDraftFromItem(item({ scope: "platform", provenance: { donor: "x" } })));
    expect(Object.keys(payload).sort()).toEqual(["id", ...LEARNING_EDITABLE_FIELDS].sort());
    expect(payload.id).toBe("item-1");
    expect(Object.keys(buildLearningItemPayload(emptyLearningDraft()))).not.toContain("id");
  });

  it("round-trips an item and detects edits", () => {
    const saved = item({ kind: "mini_lesson", bullets: ["one"], topics: ["t"], factual_claims: false, priority: 7 });
    const fromItem = learningDraftFromItem(saved);
    expect(learningPayloadsEqual(fromItem, saved)).toBe(true);
    expect(learningPayloadsEqual({ ...fromItem, title: "Changed" }, saved)).toBe(false);
    expect(learningPayloadsEqual({ ...fromItem, title: ` ${fromItem.title} ` }, saved)).toBe(true);
  });

  it("copies a history snapshot into the editor under the current id", () => {
    const current = item({ id: "item-9", title: "Now" });
    const copied = learningDraftFromSnapshot({ id: "other", title: "Then", body: "Old body", priority: 12, status: "withdrawn" }, current);
    expect(copied).toMatchObject({ id: "item-9", title: "Then", body: "Old body", priority: 12 });
    expect(copied).not.toHaveProperty("status");
  });
});

describe("responses fail closed", () => {
  it("drops malformed items and keeps delivery rows without editorial fields", () => {
    for (const patch of [{ id: "" }, { kind: "essay" }, { locale: "fr" }, { status: "live" }, { scope: "global" }, { audience: "public" },
      { priority: 101 }, { priority: 1.5 }, { revision: 0 }, { starts_at: 5 }]) {
      expect(normalizeLearningItem(row(patch)), JSON.stringify(patch)).toBeNull();
    }
    const { rights_note: _r, review_note: _v, direction: _d, provenance: _p, source: _s, ...delivered } = row();
    const normalized = normalizeLearningItem(delivered);
    expect(normalized).toMatchObject({ rights_note: "", review_note: "", direction: "", source: "", provenance: null });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.bullets)).toBe(true);
  });

  it("dedupes pages and counts what it dropped", () => {
    const page = normalizeLearningPage({ items: [row(), row(), row({ id: "item-2" }), { id: "broken" }], hasMore: "yes" });
    expect(page.items.map((entry) => entry.id)).toEqual(["item-1", "item-2"]);
    expect(page).toMatchObject({ hasMore: false, dropped: 2 });
    expect(normalizeLearningPage({ items: null })).toBeNull();
    expect(normalizeLearningPage(null)).toBeNull();
  });

  it("refuses a policy whose flags are not real booleans", () => {
    const policy = { organizationId: "org-1", chapterId: "chapter-1", quotesEnabled: true, lessonsEnabled: false, homeHidden: false, canManage: false, isPlatformOwner: false, version: "1:0:0:false" };
    expect(normalizeLearningPolicy(policy)).toMatchObject({ quotesEnabled: true, lessonsEnabled: false, version: "1:0:0:false" });
    expect(normalizeLearningPolicy({ ...policy, version: 7 }).version).toBe("7");
    expect(normalizeLearningPolicy({ ...policy, quotesEnabled: "true" })).toBeNull();
    expect(normalizeLearningPolicy({ ...policy, homeHidden: undefined })).toBeNull();
    expect(normalizeLearningPolicy({ ...policy, organizationId: null })).toBeNull();
    // Only a platform owner may have no organization (before any tenant exists).
    expect(normalizeLearningPolicy({ ...policy, organizationId: null, chapterId: null, isPlatformOwner: true }))
      .toMatchObject({ organizationId: null, chapterId: null, isPlatformOwner: true });
    expect(normalizeLearningPolicy({ ...policy, organizationId: 7, isPlatformOwner: true })).toBeNull();
    expect(normalizeLearningPolicy({ ...policy, version: { a: 1 } })).toBeNull();
  });

  it("keeps null (inherit) and [] (none) selections distinct", () => {
    expect(normalizeLearningScopePolicy({ quotes_enabled: true, lessons_enabled: false, selected_ids: null, revision: 4 }))
      .toEqual({ quotesEnabled: true, lessonsEnabled: false, selectedIds: null, revision: 4 });
    expect(normalizeLearningScopePolicy({ quotes_enabled: true, lessons_enabled: true, selected_ids: [] }).selectedIds).toEqual([]);
    expect(normalizeLearningScopePolicy({ quotesEnabled: false, lessonsEnabled: true, selectedIds: ["a", "a", "b"] }).selectedIds).toEqual(["a", "b"]);
    expect(normalizeLearningScopePolicy({ quotes_enabled: true, lessons_enabled: true, selected_ids: [1] })).toBeNull();
    expect(normalizeLearningScopePolicy({ quotes_enabled: "true", lessons_enabled: true })).toBeNull();
    expect(normalizeLearningWorkspace({ items: [row()], hasMore: true, policy: null })).toBeNull();
    expect(normalizeLearningWorkspace({ items: [row()], hasMore: true, policy: { quotes_enabled: true, lessons_enabled: true, selected_ids: null }, canManage: true, isPlatformOwner: false }))
      .toMatchObject({ hasMore: true, canManage: true, isPlatformOwner: false, policy: { selectedIds: null } });
  });

  it("reads history entries and the home flag strictly", () => {
    const page = normalizeLearningHistoryPage({ items: [
      { revision: 2, action: "publish", changed_at: iso(NOW), changed_by: "user-1", snapshot: { title: "T" } },
      { revision: "3", action: "publish", changed_at: iso(NOW) },
    ], hasMore: true });
    expect(page.items).toEqual([{ revision: 2, action: "publish", changedAt: iso(NOW), changedBy: "user-1", snapshot: { title: "T" } }]);
    expect(page).toMatchObject({ hasMore: true, dropped: 1 });
    expect(normalizeLearningHomeHidden({ homeHidden: false })).toBe(false);
    expect(normalizeLearningHomeHidden({ homeHidden: "false" })).toBeNull();
  });
});

describe("instants parse the same on every engine", () => {
  it("reads PostgreSQL timestamptz text, offsets and Z, and refuses zoneless or impossible dates", () => {
    expect(parseLearningInstant("2026-09-28T23:30:00.123456+00:00")).toBe(Date.UTC(2026, 8, 28, 23, 30, 0, 123));
    expect(parseLearningInstant("2026-09-28 23:30:00+00")).toBe(Date.UTC(2026, 8, 28, 23, 30));
    expect(parseLearningInstant("2026-09-28T19:30:00-04:00")).toBe(Date.UTC(2026, 8, 28, 23, 30));
    expect(parseLearningInstant("2026-09-28T23:30Z")).toBe(Date.UTC(2026, 8, 28, 23, 30));
    expect(parseLearningInstant("2026-09-28T23:30:00")).toBeNull();
    expect(parseLearningInstant("2026-02-30T00:00:00Z")).toBeNull();
    expect(parseLearningInstant("tomorrow")).toBeNull();
    expect(parseLearningInstant(NOW)).toBe(NOW);
    expect(parseLearningInstant(new Date(NOW))).toBe(NOW);
  });
});

describe("delivery checks at the exact boundaries", () => {
  it("is live from starts_at inclusive until ends_at exclusive, reviewed and published or scheduled", () => {
    expect(isLearningItemLive(item({ starts_at: iso(NOW) }), NOW)).toBe(true);
    expect(isLearningItemLive(item({ starts_at: iso(NOW + 1) }), NOW)).toBe(false);
    expect(isLearningItemLive(item({ ends_at: iso(NOW) }), NOW)).toBe(false);
    expect(isLearningItemLive(item({ ends_at: iso(NOW + 1) }), NOW)).toBe(true);
    expect(isLearningItemLive(item({ status: "scheduled", starts_at: iso(NOW - 1) }), NOW)).toBe(true);
    expect(isLearningItemLive(item({ status: "draft", starts_at: null }), NOW)).toBe(false);
    expect(isLearningItemLive(item({ status: "withdrawn", starts_at: null }), NOW)).toBe(false);
    expect(isLearningItemLive(item({ locale_state: "draft" }), NOW)).toBe(false);
    expect(isLearningItemLive(item({ starts_at: null }), NOW)).toBe(false);
    expect(isLearningItemLive(item({ ends_at: "not a date" }), NOW)).toBe(false);
    expect(learningPublicationState(item({ starts_at: iso(NOW + 5) }), NOW)).toBe("upcoming");
    expect(learningPublicationState(item({ ends_at: iso(NOW) }), NOW)).toBe("expired");
    expect(learningPublicationState(item({}), NOW)).toBe("live");
    expect(learningPublicationState(item({ status: "withdrawn", starts_at: null }), NOW)).toBe("withdrawn");
  });

  it("never falls back to another language, a disabled kind or another tenant", () => {
    const context = { locale: "es", quotesEnabled: true, lessonsEnabled: false, organizationId: "org-1", chapterId: "chapter-1" };
    expect(isLearningItemEligible(item({ locale: "es" }), context)).toBe(true);
    expect(isLearningItemEligible(item({ locale: "en" }), context)).toBe(false);
    expect(isLearningItemEligible(item({ locale: "es", kind: "mini_lesson" }), context)).toBe(false);
    expect(isLearningItemEligible(item({ locale: "es", scope: "organization", chapter_id: null, organization_id: "org-2" }), context)).toBe(false);
    expect(isLearningItemEligible(item({ locale: "es", chapter_id: "chapter-2" }), context)).toBe(false);
    expect(isLearningItemEligible(item({ locale: "es", scope: "platform", organization_id: null, chapter_id: null }), context)).toBe(true);
    expect(isLearningItemEligible(item({ locale: "es", body: "  " }), context)).toBe(false);
    expect(isLearningItemDeliverable(item({ locale: "es", ends_at: iso(NOW) }), { ...context, nowMs: NOW })).toBe(false);
  });

  it("asks Home for one bounded batch of only the enabled kinds, and nothing when hidden", () => {
    const policy = { quotesEnabled: true, lessonsEnabled: true, homeHidden: false };
    expect(learningHomeRequest(policy)).toEqual({ kind: null, offset: 0, limit: 100 });
    expect(learningHomeRequest({ ...policy, lessonsEnabled: false })).toEqual({ kind: "quote", offset: 0, limit: 100 });
    expect(learningHomeRequest({ ...policy, quotesEnabled: false })).toEqual({ kind: "mini_lesson", offset: 0, limit: 100 });
    expect(learningHomeRequest({ ...policy, quotesEnabled: false, lessonsEnabled: false })).toBeNull();
    expect(learningHomeRequest({ ...policy, homeHidden: true })).toBeNull();
    expect(learningHomeRequest(null)).toBeNull();
    expect(learningLibraryRequest({ lessonsEnabled: true }, 40)).toEqual({ kind: "mini_lesson", offset: 40, limit: 40 });
    expect(learningLibraryRequest({ lessonsEnabled: false }, 0)).toBeNull();
    expect(learningLibraryRequest({ lessonsEnabled: true }, 10040)).toBeNull();
  });

  it("finds the next start or end still ahead", () => {
    const items = [item({ id: "a", ends_at: iso(NOW + 9000) }), item({ id: "b", status: "scheduled", starts_at: iso(NOW + 4000) }), item({ id: "c", ends_at: iso(NOW - 1) })];
    expect(nextLearningBoundary(items, NOW)).toBe(NOW + 4000);
    expect(nextLearningBoundary([item({})], NOW)).toBeNull();
  });
});

describe("daily rotation", () => {
  it("hashes with FNV-1a 32 (standard vectors)", () => {
    expect(stableLearningHash("")).toBe(0x811c9dc5);
    expect(stableLearningHash("a")).toBe(0xe40c292c);
    expect(stableLearningHash("foobar")).toBe(0xbf9cf968);
  });

  it("orders by priority, then the seeded hash, independent of input order and without duplicates", () => {
    const pool = ["a", "b", "c", "d", "e", "f"].map((id) => item({ id }));
    const seed = learningRotationSeed({ day: "2026-09-28", userId: "u", organizationId: "o", chapterId: "c", locale: "en" });
    expect(seed).toBe("2026-09-28|u|o|c|en");
    const ordered = orderLearningItems(pool, seed).map((entry) => entry.id);
    expect(orderLearningItems([...pool].reverse(), seed).map((entry) => entry.id)).toEqual(ordered);
    expect(orderLearningItems([...pool, pool[0]], seed)).toHaveLength(6);
    const boosted = orderLearningItems([...pool, item({ id: "z", priority: 90 })], seed);
    expect(boosted[0].id).toBe("z");
    const days = new Set(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"].map((day) => orderLearningItems(pool, learningRotationSeed({ day, userId: "u", organizationId: "o", chapterId: "c", locale: "en" })).map((entry) => entry.id).join()));
    expect(days.size).toBeGreaterThan(1);
    const otherUser = orderLearningItems(pool, learningRotationSeed({ day: "2026-09-28", userId: "v", organizationId: "o", chapterId: "c", locale: "en" }));
    expect(otherUser.map((entry) => entry.id).sort()).toEqual([...ordered].sort());
  });

  it("keys the local rotation by day, user, organization, chapter and locale", () => {
    expect(learningDayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(learningRotationStorageKey({ userId: "u:1", organizationId: "o", chapterId: "c/1", locale: "es" }))
      .toBe("unionground.learning.rotation.v1:u%3A1:o:c%2F1:es");
    expect(parseLearningRotationState(serializeLearningRotationState("2026-09-28", 3), "2026-09-28")).toBe(3);
    expect(parseLearningRotationState(serializeLearningRotationState("2026-09-27", 3), "2026-09-28")).toBe(0);
    expect(parseLearningRotationState("{broken", "2026-09-28")).toBe(0);
    expect(parseLearningRotationState(JSON.stringify({ day: "2026-09-28", index: -2 }), "2026-09-28")).toBe(0);
  });

  it("skips expired and not-yet-live items at render and on Next, wrapping around", () => {
    const ordered = [
      item({ id: "live-1" }),
      item({ id: "expired", ends_at: iso(NOW) }),
      item({ id: "future", status: "scheduled", starts_at: iso(NOW + 60000) }),
      item({ id: "live-2" }),
    ];
    expect(pickLearningItem(ordered, 1, NOW)).toEqual({ item: ordered[3], index: 3 });
    expect(pickLearningItem(ordered, 7, NOW)?.item.id).toBe("live-2");
    expect(nextLearningIndex(ordered, 0, NOW)).toBe(3);
    expect(nextLearningIndex(ordered, 3, NOW)).toBe(0);
    expect(liveLearningCount(ordered, NOW)).toBe(2);
    expect(nextLearningIndex([ordered[0]], 0, NOW)).toBe(0);
    expect(pickLearningItem([ordered[1], ordered[2]], 0, NOW)).toBeNull();
    // Once the scheduled item starts, it joins the rotation in place.
    expect(liveLearningCount(ordered, NOW + 60000)).toBe(3);
  });
});

describe("error kinds", () => {
  it("maps the server's codes", () => {
    expect(learningErrorKind({ code: "PT409" })).toBe("conflict");
    expect(learningErrorKind({ code: "40001" })).toBe("conflict");
    expect(learningErrorKind({ code: "42501", message: "content unavailable" })).toBe("forbidden");
    expect(learningErrorKind({ code: "22023", message: "invalid publication window" })).toBe("invalid");
    expect(learningErrorKind({ code: "PGRST202" })).toBe("unavailable");
    expect(learningErrorKind(new TypeError("Failed to fetch"))).toBe("network");
    expect(learningErrorKind({ code: "XX000" })).toBe("unknown");
    expect(learningErrorKind(null)).toBe("unknown");
  });
});

describe("the EN/ES chrome", () => {
  it("has the same keys in both languages and non-empty strings", () => {
    const en = Object.keys(learningContentCatalogue.en).sort();
    expect(Object.keys(learningContentCatalogue.es).sort()).toEqual(en);
    for (const key of en) {
      expect(learningContentCatalogue.en[key].trim(), key).not.toBe("");
      expect(learningContentCatalogue.es[key].trim(), key).not.toBe("");
    }
  });

  it("speaks Spanish in the tú register", () => {
    const offenders = Object.entries(learningContentCatalogue.es)
      .filter(([, text]) => TIER1_MARKERS.test(text) || USTED_MARKERS.test(text))
      .map(([key, text]) => `${key}: ${text}`);
    expect(offenders).toEqual([]);
  });
});
