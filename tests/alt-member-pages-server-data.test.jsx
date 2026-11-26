import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AltUpdatesPage, { EVERY_CHAPTER, WHOLE_ORGANIZATION, chapterFilter, filterUpdates, updateChapters, withChapter } from "../src/alt/AltUpdatesPage.jsx";
import AltBargainingPage, { currentSession } from "../src/alt/record/AltBargainingPage.jsx";
import { recordItems } from "../src/alt/recordIndex.js";
import { OUTCOMES, UnionStatistics, loadUnionStatistics, monthLabel } from "../src/alt/takepart/UnionStatistics.jsx";
import { ChapterMembershipSwitch } from "../src/components/ChapterMembershipSwitch.jsx";
import { loadCaseworkBargainingTable } from "../src/lib/caseworkApi.js";
import { altTakePartCatalogue } from "../src/lib/i18n/altTakePart.js";
import { altRecordPagesCatalogue } from "../src/lib/i18n/altRecordPages.js";
import { altShellCatalogue } from "../src/lib/i18n/altShell.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { countMemberActionsThisYear, easternYearStart, loadRecordChapters } from "../src/lib/memberApi.js";
import { buildPayActor } from "../src/lib/mi1PayWiring.js";
import { PayToolsView } from "../src/views/PayToolsView.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { SettingsView } from "../src/views/SettingsView.jsx";

// REQ-UG-ALT-MEMBER-PAGES-SERVER-DATA-20261030: the alternate
// shell's member pages on the server reads that now carry their data: the
// chapter each record names (All updates), the organization's other chapters
// (My chapter), this year's actions (Account), the chapter's bargaining
// sessions (Bargaining) and the union-wide figures under the privacy floor
// (Statistics).

const NOW = new Date("2026-10-30T16:00:00Z");
const ago = (days) => new Date(NOW.getTime() - days * 86_400_000);
const en = (key) => altTakePartCatalogue.en[key];
const es = (key) => altTakePartCatalogue.es[key];
const wrap = (node, lang = "en") => render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("the new strings", () => {
  it("are declared in English and Spanish, in the informal register", () => {
    const keys = {
      altShell: [altShellCatalogue, ["altShell.updatesChapter", "altShell.updatesChapterAll", "altShell.updatesChapterOrg"]],
      altRecordPages: [altRecordPagesCatalogue, ["altRecordPages.chOthersNone", "altRecordPages.chOtherNoRegion", "altRecordPages.bargPillSession", "altRecordPages.bargTableUnavailable", "altRecordPages.bargProposalsMany"]],
      altTakePart: [altTakePartCatalogue, ["altTakePart.statsWithheld", "altTakePart.stats_chaptersWithheld", ...OUTCOMES.map((outcome) => `altTakePart.outcome_${outcome}`)]],
    };
    for (const [catalogue, list] of Object.values(keys)) {
      for (const key of list) {
        expect(catalogue.en[key], key).toBeTruthy();
        expect(catalogue.es[key], key).toBeTruthy();
        expect(catalogue.es[key]).not.toBe(catalogue.en[key]);
        expect(catalogue.es[key]).not.toMatch(/\busted(es)?\b/i);
      }
    }
  });
});

// ── All updates: the chapter filter ────────────────────────────────────────

describe("the record index carries each row's campaign", () => {
  it("keeps an unknown campaign undefined, never the whole organization", () => {
    const [item] = recordItems({ broadcasts: [{ id: "b9", title: "Snapshot row", publishedAt: ago(1).toISOString() }] });
    expect(item.chapterId).toBeUndefined();
  });

  it("reads chapterId from broadcasts, meetings, votes and issues, null when the row names none", () => {
    const items = recordItems({
      broadcasts: [{ id: "b1", title: "Campaign news", publishedAt: ago(1).toISOString(), chapterId: "ch-1" }, { id: "b2", title: "Union news", publishedAt: ago(2).toISOString(), chapterId: null }],
      events: [{ id: "e1", title: "Meeting", startsAt: ago(3).toISOString(), chapterId: "ch-2" }],
      planItems: [{ id: "v1", kind: "ballot", title: "Ratify", closesAt: ago(4).toISOString(), chapterId: "ch-1" }],
      cases: [{ id: "c1", title: "Overtime", chapterId: "ch-2", updates: [{ id: "u1", body: "Filed", created_at: ago(5).toISOString() }] }],
    });
    expect(Object.fromEntries(items.map((item) => [item.id, item.chapterId]))).toEqual({
      "update-b1": "ch-1", "update-b2": null, "event-e1": "ch-2", "vote-v1": "ch-1", "case-c1-u1": "ch-2",
    });
  });
});

const directory = [
  { id: "ch-1", name: "Riverside Campaign", region: "North" },
  { id: "ch-2", name: "Harbor Campaign", region: "" },
  { id: "ch-3", name: "Quiet Campaign", region: "" },
];
const record = (type, id, days, chapterId) => ({ type, id, chapterId, title: `${type} ${id}`, sub: "", at: ago(days), source: {} });
const items = [
  record("update", "a", 1, "ch-1"),
  record("update", "b", 2, null),
  record("event", "c", 3, "ch-2"),
  record("vote", "d", 4, "ch-1"),
  record("case", "e", 5, "ch-unknown"),
];

describe("updateChapters and the campaign filter", () => {
  it("lists only the named places the directory knows, the whole organization last, and nothing for one place", () => {
    expect(updateChapters(items, directory)).toEqual([
      { id: chapterFilter("ch-1"), name: "Riverside Campaign" },
      { id: chapterFilter("ch-2"), name: "Harbor Campaign" },
      { id: WHOLE_ORGANIZATION, name: null },
    ]);
    expect(updateChapters(items, null)).toEqual([]);
    expect(updateChapters([record("update", "x", 1, "ch-1")], directory)).toEqual([]);
    expect(updateChapters([record("update", "x", 1, "ch-1"), record("update", "y", 1, "ch-2")], directory)).toHaveLength(2);
  });

  it("filters by a campaign, by the whole organization, or not at all", () => {
    const ids = (chapter) => filterUpdates(items, { range: "all", chapter }, NOW).map((item) => item.id);
    expect(ids(EVERY_CHAPTER)).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids(chapterFilter("ch-1"))).toEqual(["a", "d"]);
    expect(ids(WHOLE_ORGANIZATION)).toEqual(["b"]);
    expect(ids(chapterFilter("ch-3"))).toEqual([]);
  });

  it("keeps campaigns whose ids are all and org apart from the scope filters", () => {
    // Refs #5710, comment 6539257299: bare "all" and "org" were the sentinels.
    const odd = [{ id: "all", name: "All Trades Campaign" }, { id: "org", name: "Organizers Campaign" }];
    const rows = [record("update", "x", 1, "all"), record("update", "y", 2, "org"), record("update", "z", 3, null)];
    const ids = (chapter) => filterUpdates(rows, { range: "all", chapter }, NOW).map((item) => item.id);
    expect(ids(chapterFilter("all"))).toEqual(["x"]);
    expect(ids(chapterFilter("org"))).toEqual(["y"]);
    expect(ids(WHOLE_ORGANIZATION)).toEqual(["z"]);
    expect(ids(EVERY_CHAPTER)).toEqual(["x", "y", "z"]);
    wrap(<AltUpdatesPage items={rows} chapters={odd} now={NOW} />);
    const places = screen.getByRole("group", { name: "Campaign" });
    fireEvent.click(within(places).getByRole("button", { name: "All Trades Campaign 1" }));
    expect(within(places).getByRole("button", { name: "Every campaign" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Showing 1 of 1")).toBeInTheDocument();
    fireEvent.click(within(places).getByRole("button", { name: "Organizers Campaign 1" }));
    expect(within(places).getByRole("button", { name: "Whole organization 1" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { name: "update y" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "update z" })).toBeNull();
  });

  it("draws counted campaign chips that narrow the cards and the type counts", () => {
    wrap(<AltUpdatesPage items={items} chapters={directory} now={NOW} />);
    const places = screen.getByRole("group", { name: "Campaign" });
    expect(within(places).getByRole("button", { name: "Every campaign" })).toHaveAttribute("aria-pressed", "true");
    expect(within(places).getByRole("button", { name: "Riverside Campaign 2" })).toBeInTheDocument();
    expect(within(places).getByRole("button", { name: "Harbor Campaign 1" })).toBeInTheDocument();
    expect(within(places).getByRole("button", { name: "Whole organization 1" })).toBeInTheDocument();
    expect(within(places).queryByText(/Quiet Chapter/)).toBeNull();
    expect(screen.getByText("Showing 5 of 5")).toBeInTheDocument();
    fireEvent.click(within(places).getByRole("button", { name: "Riverside Campaign 2" }));
    expect(within(places).getByRole("button", { name: "Riverside Campaign 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Showing 2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "update a" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "meeting c" })).toBeNull();
    const types = screen.getByRole("group", { name: "Type" });
    expect(within(types).getByRole("button", { name: /^All 2$/ })).toBeInTheDocument();
    // The type filter and the place counts work together.
    fireEvent.click(within(types).getByRole("button", { name: /^Votes 1$/ }));
    expect(within(places).getByRole("button", { name: "Harbor Campaign 0" })).toBeInTheDocument();
    fireEvent.click(within(places).getByRole("button", { name: "Whole organization 0" }));
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
  });

  it("fills broadcast and issue campaigns from the page's own read, leaving the rest unknown", () => {
    const lookup = { broadcasts: { b1: "ch-1" }, cases: { c1: "ch-2" } };
    const unknown = (type, id) => ({ type, id: `${type}-${id}`, chapterId: undefined, source: { id, audience: type === "update" ? "chapter" : undefined } });
    expect(withChapter(unknown("update", "b1"), lookup).chapterId).toBe("ch-1");
    expect(withChapter(unknown("update", "b2"), lookup).chapterId).toBeUndefined();
    expect(withChapter(unknown("case", "c1"), lookup).chapterId).toBe("ch-2");
    expect(withChapter(unknown("case", "c9"), lookup).chapterId).toBeUndefined();
    expect(withChapter(unknown("update", "b1"), null).chapterId).toBeUndefined();
    expect(withChapter({ ...unknown("vote", "v1"), chapterId: "ch-3" }, lookup).chapterId).toBe("ch-3");
    // A broadcast is placed by its audience: an organization broadcast stores
    // its publisher's chapter, which never makes it a chapter broadcast.
    const broadcast = (id, audience) => ({ type: "update", id: `update-${id}`, chapterId: undefined, source: { id, audience } });
    expect(withChapter(broadcast("b1", "organization"), lookup).chapterId).toBeNull();
    expect(withChapter(broadcast("b1", "chapter"), lookup).chapterId).toBe("ch-1");
    expect(withChapter(broadcast("b1", null), lookup).chapterId).toBeUndefined();
    expect(updateChapters([unknown("update", "x"), record("vote", "v", 1, "ch-1")], directory)).toEqual([]);
    expect(filterUpdates([unknown("update", "x")], { range: "all", chapter: WHOLE_ORGANIZATION }, NOW)).toEqual([]);
  });

  it("reads the worker's broadcast and issue campaigns once the page opens", async () => {
    const calls = [];
    const answer = { member_broadcasts: { data: [{ id: "b1", chapter_id: "ch-2" }, { id: "b2", chapter_id: "ch-1" }], error: null }, member_cases: { data: [{ id: "c1", chapter_id: "ch-1" }], error: null } };
    const client = { from: (table) => {
      const query = { select: (columns) => { calls.push([table, "select", columns]); return query; }, is: () => query, eq: (column, value) => { calls.push([table, "eq", column, value]); return query; }, order: () => query, limit: () => query, then: (resolve, reject) => Promise.resolve(answer[table]).then(resolve, reject) };
      return query;
    } };
    await expect(loadRecordChapters(client, "user-1")).resolves.toEqual({ broadcasts: { b1: "ch-2", b2: "ch-1" }, cases: { c1: "ch-1" } });
    expect(calls).toContainEqual(["member_cases", "eq", "user_id", "user-1"]);
    expect(calls.filter((call) => call[1] === "select").map((call) => call[2])).toEqual(["id,chapter_id", "id,chapter_id"]);
    await expect(loadRecordChapters(client, null)).resolves.toEqual({ broadcasts: { b1: "ch-2", b2: "ch-1" }, cases: {} });
    const pageItems = recordItems({
      // b2 went to the whole organization from a Riverside publisher.
      broadcasts: [{ id: "b1", title: "Harbor news", publishedAt: ago(1).toISOString(), audience: "chapter" }, { id: "b2", title: "Union news", publishedAt: ago(2).toISOString(), audience: "organization" }],
      cases: [{ id: "c1", title: "My issue", updates: [{ id: "u1", body: "Filed", created_at: ago(3).toISOString() }] }],
    });
    wrap(<AltUpdatesPage items={pageItems} chapters={directory} client={client} memberId="user-1" now={NOW} />);
    const places = await screen.findByRole("group", { name: "Campaign" });
    expect(within(places).getByRole("button", { name: "Harbor Campaign 1" })).toBeInTheDocument();
    expect(within(places).getByRole("button", { name: "Riverside Campaign 1" })).toBeInTheDocument();
    fireEvent.click(within(places).getByRole("button", { name: "Whole organization 1" }));
    expect(screen.getByRole("heading", { name: "Union news" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Harbor news" })).toBeNull();
  });

});

// ── My chapter: the other chapters ─────────────────────────────────────────

const memberships = [{ id: "ch-1", name: "Riverside Campaign" }];
function hub(data) {
  wrap(<ProductHubView
    alt
    data={{ member: { id: "user-1", chapterId: "ch-1", chapterName: "Riverside Campaign", chapterMemberships: [{ chapterId: "ch-1", name: "Riverside Campaign" }] }, roles: [], events: [], chapterStewards: [], conversations: [], broadcasts: [], product: { spaces: [], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [] }, ...data }}
    onOpenHome={vi.fn()}
    onCreateSpace={vi.fn()}
    onCreateThread={vi.fn()}
    onSendPost={vi.fn()}
    chapterSwitch={<ChapterMembershipSwitch chapters={memberships} selectedId="ch-1" onSelect={vi.fn()} />}
  />);
}

describe("the alternate shell's campaign directory", () => {
  it("lists the organization's other campaigns by name and region, opening nothing", () => {
    hub({ chapterDirectory: directory });
    const others = screen.getByRole("region", { name: "Other campaigns" });
    expect(within(others).getByText("Harbor Campaign")).toBeInTheDocument();
    expect(within(others).getByText("Quiet Campaign")).toBeInTheDocument();
    expect(within(others).queryByText("Riverside Campaign")).toBeNull();
    expect(within(others).getAllByText("Campaign in your organization")).toHaveLength(2);
    expect(within(others).queryByRole("button")).toBeNull();
  });

  it("says when the organization has no other campaign", () => {
    hub({ chapterDirectory: [directory[0]] });
    const others = screen.getByRole("region", { name: "Other campaigns" });
    expect(within(others).getByText("Your organization has no other campaigns on Union Ground.")).toBeInTheDocument();
  });
});

// ── Account: actions this year ─────────────────────────────────────────────

function countingClient(result) {
  const gte = vi.fn(async () => result);
  const select = vi.fn(() => ({ gte }));
  const from = vi.fn(() => ({ select }));
  return { from, select, gte };
}

describe("this year's actions", () => {
  it("starts the year at Eastern midnight on January 1", () => {
    expect(easternYearStart(new Date("2026-10-30T16:00:00Z"))).toBe("2026-01-01T00:00:00-05:00");
    // 03:00 UTC on January 1 is still December 31 in New York.
    expect(easternYearStart(new Date("2027-01-01T03:00:00Z"))).toBe("2026-01-01T00:00:00-05:00");
  });

  it("counts the worker's point meetings since then and surfaces a failed read", async () => {
    const client = countingClient({ count: 7, error: null });
    await expect(countMemberActionsThisYear(client, NOW)).resolves.toBe(7);
    expect(client.from).toHaveBeenCalledWith("member_point_events");
    expect(client.select).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(client.gte).toHaveBeenCalledWith("occurred_at", "2026-01-01T00:00:00-05:00");
    await expect(countMemberActionsThisYear(countingClient({ count: null, error: null }), NOW)).resolves.toBe(0);
    await expect(countMemberActionsThisYear(countingClient({ count: null, error: { message: "denied", code: "42501" } }), NOW)).rejects.toThrow(/Actions this year/);
  });

  const settingsData = (rewards) => ({
    member: { initials: "TM", fullName: "Test Worker", firstName: "Test", chapterId: "c1", chapterName: "North Campaign", notificationPrefs: {} },
    roles: [],
    organizationConfiguration: null,
    rewards,
    events: [],
    forms: [],
  });
  const settingsClient = (counter) => ({
    ...counter,
    rpc: vi.fn(async () => ({ data: null, error: { message: "off" } })),
    auth: { updateUser: vi.fn(), mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: [], totp: [] }, error: null }) } },
  });

  it("fills the Account figure from the count when the rewards summary has none", async () => {
    const counter = countingClient({ count: 9, error: null });
    wrap(<SettingsView alt data={settingsData({ totalPoints: 10, tierNumber: 1, tierName: "Worker", nextTierName: "Builder", pointsToGo: 90, weekStreak: 0, actionsYtd: null })} lang="en" authClient={settingsClient(counter)} onLanguage={vi.fn()} />);
    const figures = screen.getByRole("region", { name: "At a glance" });
    await waitFor(() => expect(within(figures).getByText("Actions this year").closest(".ug-kpi")).toHaveTextContent("9"));
    expect(counter.from).toHaveBeenCalledTimes(1);
  });

  it("keeps the summary's own count and reads nothing more", () => {
    const counter = countingClient({ count: 9, error: null });
    wrap(<SettingsView alt data={settingsData({ totalPoints: 10, tierNumber: 1, tierName: "Worker", nextTierName: "Builder", pointsToGo: 90, weekStreak: 0, actionsYtd: 4 })} lang="en" authClient={settingsClient(counter)} onLanguage={vi.fn()} />);
    const figures = screen.getByRole("region", { name: "At a glance" });
    expect(within(figures).getByText("Actions this year").closest(".ug-kpi")).toHaveTextContent("4");
    expect(counter.from).not.toHaveBeenCalled();
  });

  it("keeps the dash when the count cannot be read", async () => {
    const counter = countingClient({ count: null, error: { message: "denied" } });
    wrap(<SettingsView alt data={settingsData(undefined)} lang="en" authClient={settingsClient(counter)} onLanguage={vi.fn()} />);
    await waitFor(() => expect(counter.gte).toHaveBeenCalled());
    const figures = screen.getByRole("region", { name: "At a glance" });
    expect(within(figures).getByText("Actions this year").closest(".ug-kpi")).toHaveTextContent("—");
  });
});

// ── Bargaining: the chapter's sessions ─────────────────────────────────────

const sessions = [
  {
    id: "w-live", title: "2027 successor contract", status: "live", starts_at: "2026-09-01T14:00:00Z", created_at: "2026-08-20T14:00:00Z",
    proposals: [
      { id: "p1", title: "Wage scale", side: "union", status: "countered", response_due_at: "2026-11-10T12:00:00Z" },
      { id: "p2", title: "Remote work", side: "management", status: "accepted", response_due_at: null },
    ],
    events: [{ id: "ev1", event_type: "note" }],
  },
  { id: "w-old", title: "2024 reopener", status: "closed", starts_at: null, created_at: "2024-03-01T14:00:00Z", proposals: [{ id: "p0", title: "Shift pay", side: "joint", status: "tentative" }], events: [] },
];

function tableClient(rows) {
  const calls = [];
  const chain = (table) => {
    const query = {
      select: (columns) => { calls.push([table, "select", columns]); return query; },
      eq: (column, value) => { calls.push([table, "eq", column, value]); return query; },
      in: (column, value) => { calls.push([table, "in", column, value]); return query; },
      gt: (column, value) => { calls.push([table, "gt", column, value]); query.paged = true; return query; },
      order: () => query,
      limit: () => query,
      // These fixtures fit in one page, so the next page is empty.
      then: (resolve, reject) => Promise.resolve(query.paged ? { data: [], error: null } : rows[table]).then(resolve, reject),
    };
    return query;
  };
  return { calls, from: (table) => chain(table) };
}

// A fake PostgREST table that applies the filters, ordering and limit the
// read asks for, and never returns more than the API's row cap.
function cappedTableClient(tables, maxRows = 1000) {
  const calls = [];
  const from = (table) => {
    const state = { filters: [], order: [], limit: Infinity };
    const query = {
      select: () => query,
      eq: (column, value) => { state.filters.push((row) => row[column] === value); return query; },
      neq: (column, value) => { state.filters.push((row) => row[column] !== value); return query; },
      in: (column, values) => { state.filters.push((row) => values.includes(row[column])); return query; },
      gt: (column, value) => { state.filters.push((row) => row[column] > value); return query; },
      order: (column, { ascending = true } = {}) => { state.order.push([column, ascending]); return query; },
      limit: (count) => { state.limit = count; return query; },
      then: (resolve, reject) => {
        calls.push(table);
        const rows = tables[table].filter((row) => state.filters.every((keep) => keep(row)));
        rows.sort((a, b) => {
          for (const [column, ascending] of state.order) {
            if (a[column] !== b[column]) return (a[column] < b[column] ? -1 : 1) * (ascending ? 1 : -1);
          }
          return 0;
        });
        return Promise.resolve({ data: rows.slice(0, Math.min(state.limit, maxRows)), error: null }).then(resolve, reject);
      },
    };
    return query;
  };
  return { calls, from };
}

const pad = (n) => String(n).padStart(4, "0");

describe("the bargaining table read", () => {
  it("reads the campaign's sessions with their proposals, and no timeline", async () => {
    const client = tableClient({
      casework_bargaining_workspaces: { data: [{ id: "w1", title: "Table", status: "live" }, { id: "w2", title: "Old", status: "closed" }], error: null },
      casework_bargaining_proposals: { data: [{ id: "p1", workspace_id: "w1" }, { id: "p2", workspace_id: "w2" }], error: null },
      casework_bargaining_events: { data: [{ id: "e1", workspace_id: "w1" }], error: null },
    });
    const result = await loadCaseworkBargainingTable(client, "ch-1");
    expect(result.map((row) => [row.id, row.proposals.map((p) => p.id)])).toEqual([["w1", ["p1"]], ["w2", ["p2"]]]);
    // The timeline is read only by the casework hub: a capped sample would
    // misstate per-session totals, and session notes stay staff-side.
    expect(client.calls.some((call) => call[0] === "casework_bargaining_events")).toBe(false);
    expect(client.calls).toContainEqual(["casework_bargaining_workspaces", "eq", "chapter_id", "ch-1"]);
    expect(client.calls).toContainEqual(["casework_bargaining_proposals", "in", "workspace_id", ["w1", "w2"]]);
    expect(client.calls.filter((call) => call[1] === "select").every((call) => !/\bbody\b/.test(call[2]))).toBe(true);
  });

  it("asks nothing more for a campaign with no sessions, and refuses a missing campaign", async () => {
    const client = tableClient({ casework_bargaining_workspaces: { data: [], error: null } });
    await expect(loadCaseworkBargainingTable(client, "ch-1")).resolves.toEqual([]);
    expect(client.calls.some((call) => call[0] !== "casework_bargaining_workspaces")).toBe(false);
    await expect(loadCaseworkBargainingTable(client, "")).rejects.toThrow(/Chapter id required/);
  });

  it("reads every proposal past the API row cap, in position order", async () => {
    // Refs #5710, comment 6539256962: one unpaged read stopped at 1,000 rows.
    const proposals = Array.from({ length: 1100 }, (_, i) => ({
      id: `00000000-0000-4000-8000-00000000${pad(i)}`,
      workspace_id: i % 2 ? "w1" : "w2",
      position: 1099 - i,
      updated_at: "2026-10-01T00:00:00Z",
    }));
    const client = cappedTableClient({
      casework_bargaining_workspaces: [
        { id: "w1", chapter_id: "ch-1", status: "live", updated_at: "2026-10-02T00:00:00Z" },
        { id: "w2", chapter_id: "ch-1", status: "closed", updated_at: "2026-10-01T00:00:00Z" },
      ],
      casework_bargaining_proposals: proposals,
    });
    const result = await loadCaseworkBargainingTable(client, "ch-1");
    expect(result.map((row) => row.proposals.length)).toEqual([550, 550]);
    expect(currentSession(result).proposals.map((row) => row.position).slice(0, 3)).toEqual([0, 2, 4]);
    expect(client.calls.filter((table) => table === "casework_bargaining_proposals")).toHaveLength(3);
  });

  it("still finds an open session behind fifty newer closed ones", async () => {
    // Refs #5710, comment 6539257140: the 50-row history window hid it.
    const closed = Array.from({ length: 50 }, (_, i) => ({
      id: `closed-${pad(i)}`, chapter_id: "ch-1", status: "closed", updated_at: `2026-10-${pad(i + 10).slice(2)}T00:00:00Z`,
    }));
    const client = cappedTableClient({
      casework_bargaining_workspaces: [
        ...closed,
        { id: "w-open", chapter_id: "ch-1", status: "live", updated_at: "2026-09-01T00:00:00Z" },
        { id: "w-other", chapter_id: "ch-2", status: "live", updated_at: "2026-12-01T00:00:00Z" },
      ],
      casework_bargaining_proposals: [{ id: "p1", workspace_id: "w-open", position: 0 }],
    });
    const result = await loadCaseworkBargainingTable(client, "ch-1");
    expect(result).toHaveLength(51);
    expect(currentSession(result)).toMatchObject({ id: "w-open", proposals: [{ id: "p1" }] });
  });

  it("asks for no separate open session when the history has one", async () => {
    const client = cappedTableClient({
      casework_bargaining_workspaces: Array.from({ length: 60 }, (_, i) => ({
        id: `w-${pad(i)}`, chapter_id: "ch-1", status: i === 55 ? "paused" : "closed", updated_at: `2026-${pad(i).slice(2)}`,
      })),
      casework_bargaining_proposals: [],
    });
    const result = await loadCaseworkBargainingTable(client, "ch-1");
    expect(result).toHaveLength(50);
    expect(client.calls.filter((table) => table === "casework_bargaining_workspaces")).toHaveLength(1);
  });

  it("refuses to present proposals past the row limit as complete", async () => {
    const client = cappedTableClient({
      casework_bargaining_workspaces: [{ id: "w1", chapter_id: "ch-1", status: "live", updated_at: "2026-10-01" }],
      casework_bargaining_proposals: Array.from({ length: 5001 }, (_, i) => ({ id: `p-${pad(i)}`, workspace_id: "w1", position: 0 })),
    });
    await expect(loadCaseworkBargainingTable(client, "ch-1")).rejects.toThrow(/exceed their row limit/);
  });

  it("refuses a proposal read that stops advancing", async () => {
    const stuck = {
      from: (table) => {
        const query = {
          select: () => query, eq: () => query, in: () => query, gt: () => query, order: () => query, limit: () => query,
          then: (resolve) => resolve(table === "casework_bargaining_workspaces"
            ? { data: [{ id: "w1", status: "live" }], error: null }
            : { data: [{ id: "p1", workspace_id: "w1" }], error: null }),
        };
        return query;
      },
    };
    await expect(loadCaseworkBargainingTable(stuck, "ch-1")).rejects.toThrow(/could not be read completely/);
  });

  it("leads with the newest open session", () => {
    expect(currentSession(sessions).id).toBe("w-live");
    expect(currentSession([sessions[1]]).id).toBe("w-old");
    expect(currentSession(null)).toBeNull();
  });
});

describe("the Pay tools view's bargaining read", () => {
  it("asks for the campaign's table whatever the hat, so chapter-scoped leaders get it", async () => {
    const client = tableClient({
      casework_bargaining_workspaces: { data: [{ id: "w1", title: "2027 successor contract", status: "live", starts_at: null, created_at: "2026-09-01T14:00:00Z" }], error: null },
      casework_bargaining_proposals: { data: [{ id: "p1", workspace_id: "w1", title: "Wage scale", side: "union", status: "proposed" }], error: null },
      casework_bargaining_events: { data: [], error: null },
    });
    client.rpc = vi.fn(async () => ({ data: null, error: { message: "not in this test" } }));
    // A chapter administrator holds no organization role (canLead is false).
    const actor = buildPayActor({ userId: "user-a", organizationId: "org-1", chapterId: "ch-1", membershipStatus: "active", chapterRoles: ["admin"] });
    wrap(<PayToolsView alt actor={actor} client={client} api={{ loadCatalog: async () => ({ ok: false }) }} />);
    expect(await screen.findByText("Session: Live")).toBeInTheDocument();
    expect(screen.getByText("Wage scale")).toBeInTheDocument();
    expect(client.calls).toContainEqual(["casework_bargaining_workspaces", "eq", "chapter_id", "ch-1"]);
  });

  it("asks nothing without a campaign, and keeps the empty state when the read fails", async () => {
    const client = tableClient({ casework_bargaining_workspaces: { data: null, error: { message: "denied" } } });
    client.rpc = vi.fn(async () => ({ data: null, error: { message: "not in this test" } }));
    wrap(<PayToolsView alt actor={buildPayActor({ userId: "user-a", organizationId: "org-1", membershipStatus: "active" })} client={client} api={{ loadCatalog: async () => ({ ok: false }) }} />);
    expect(client.calls).toEqual([]);
    cleanup();
    wrap(<PayToolsView alt actor={buildPayActor({ userId: "user-a", organizationId: "org-1", chapterId: "ch-1", membershipStatus: "active" })} client={client} api={{ loadCatalog: async () => ({ ok: false }) }} />);
    expect(await screen.findAllByText("The bargaining table could not be loaded. Try again later.")).toHaveLength(2);
  });
});

describe("the alternate shell's Bargaining page on the live table", () => {
  const page = (bargaining, lang = "en") => wrap(<AltBargainingPage tables={{ state: "empty" }} bargaining={bargaining} tabs={null}>{null}</AltBargainingPage>, lang);

  it("shows the session status, each proposal with its status and the session history", () => {
    page({ state: "success", sessions });
    expect(screen.getByText("Session: Live")).toHaveClass("ug-eyebrow-pill");
    const figures = screen.getByRole("region", { name: "At a glance" });
    expect(within(figures).getByText("Proposals").closest(".ug-kpi")).toHaveTextContent("2in 2027 successor contract");
    const proposals = screen.getByRole("heading", { level: 2, name: "Proposals" }).closest(".ug-panel");
    expect(within(proposals).getByText("Countered")).toHaveClass("ug-tag");
    expect(within(proposals).getByText("Wage scale")).toBeInTheDocument();
    expect(within(proposals).getByText("Union · response due November 10, 2026")).toBeInTheDocument();
    expect(within(proposals).getByText("Accepted")).toBeInTheDocument();
    expect(within(proposals).queryByText("Shift pay")).toBeNull();
    const history = screen.getByRole("heading", { level: 2, name: "Session history" }).closest(".ug-panel");
    expect(within(history).getByText("September 1, 2026 · 2 proposals")).toBeInTheDocument();
    expect(within(history).getByText("March 1, 2024 · 1 proposal")).toBeInTheDocument();
    expect(within(history).getByText("Closed")).toBeInTheDocument();
    // The live session feed keeps its "nothing posted" card.
    expect(screen.getByText("No session notes have been posted here.")).toBeInTheDocument();
  });

  it("says a session has no proposal yet, and that the table could not be loaded", () => {
    page({ state: "success", sessions: [{ ...sessions[0], proposals: [] }] });
    expect(screen.getByText("No proposal has been added to this session yet.")).toBeInTheDocument();
    cleanup();
    page({ state: "error", sessions: [] });
    expect(screen.getAllByText("The bargaining table could not be loaded. Try again later.")).toHaveLength(2);
    expect(screen.getByText("No session posted")).toBeInTheDocument();
  });

});

// ── Statistics: the union-wide panels ──────────────────────────────────────

const months = (counts) => counts.map((count, index) => ({ month: `2026-${String(index + 1).padStart(2, "0")}`, count }));
const published = {
  available: true,
  privacyFloor: 10,
  wins: { withheld: false, months: months([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 10]) },
  actions: { withheld: false, months: months([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 20, 40]) },
  outcomes: { withheld: false, rows: [{ outcome: "upheld", count: 30 }, { outcome: "settled", count: 10 }, { outcome: "withdrawn", count: 0 }, { outcome: "denied", count: 10 }, { outcome: "other", count: 0 }] },
  chapters: { rows: [{ id: "ch-1", name: "Riverside Campaign", members: 40, openCases: 12 }, { id: "ch-2", name: "Harbor Campaign", members: null, openCases: 0 }], openCasesWithheld: false },
};
const rpcClient = (answer) => ({ rpc: vi.fn(async () => answer) });

describe("the union statistics read", () => {
  it("calls the worker statistics function and treats an empty answer as unavailable", async () => {
    const client = rpcClient({ data: published, error: null });
    await expect(loadUnionStatistics(client)).resolves.toBe(published);
    expect(client.rpc).toHaveBeenCalledWith("get_member_union_statistics");
    await expect(loadUnionStatistics(rpcClient({ data: null, error: null }))).resolves.toEqual({ available: false });
    await expect(loadUnionStatistics(rpcClient({ data: null, error: { message: "authentication required" } }))).rejects.toThrow("authentication required");
    await expect(loadUnionStatistics(rpcClient({ data: null, error: { message: "boom", code: "XX000" } }))).rejects.toMatchObject({ code: "XX000" });
  });

  it("names months in the reader's language", () => {
    expect(monthLabel("2026-10", "en")).toBe("Oct");
    expect(monthLabel("2026-10", "es")).toMatch(/^oct/);
    expect(monthLabel("soon", "en")).toBe("soon");
    expect(monthLabel(null, "en")).toBe("");
  });
});

describe("the alternate shell's union-wide statistics panels", () => {




  // BUG-UG-MEMBER-UNION-STATISTICS-SURVEY-GATE-20261031: a member the
  // quarterly survey gate locks reads no figures and is told why, in both languages.
  it("tells a worker the quarterly survey gate locks to answer the survey first, in English and Spanish, with no figures", async () => {
    const locked = { data: { available: false, locked: true, reason: "quarterly_survey_gate" }, error: null };
    for (const lang of ["en", "es"]) {
      const text = lang === "en" ? en : es;
      wrap(<UnionStatistics client={rpcClient(locked)} />, lang);
      expect(await screen.findAllByText(text("altTakePart.statsUnionLocked"))).toHaveLength(3);
      expect(screen.getAllByText(text("altTakePart.statsUnionLockedTitle"))).toHaveLength(3);
      expect(screen.queryByRole("img")).toBeNull();
      expect(screen.queryByRole("table")).toBeNull();
      cleanup();
    }
    expect(altTakePartCatalogue.es["altTakePart.statsUnionLocked"]).not.toBe(altTakePartCatalogue.en["altTakePart.statsUnionLocked"]);
  });

});
