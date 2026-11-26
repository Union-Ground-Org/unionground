// @vitest-environment node
import { describe, expect, it } from "vitest";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";
import {
  buildSearchIndex,
  caseFocus,
  mergeServerCaseEntries,
  normalizeText,
  plainSnippet,
  searchEntries,
  serverCaseEntries,
  snippetSegments,
} from "../src/lib/searchIndex.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { t } from "../src/lib/i18n.js";

const tEn = (key, vars) => t("en", key, vars);
const tEs = (key, vars) => t("es", key, vars);

describe("normalizeText", () => {
  it("is diacritic- and case-insensitive in both directions", () => {
    expect(normalizeText("Lección de DERECHOS")).toBe("leccion de derechos");
    expect(normalizeText("reunión")).toContain("reunion");
  });
});

describe("buildSearchIndex", () => {
  const index = buildSearchIndex(fallbackData);

  it("excludes hydrated sealed answers while ordinary form answers remain searchable", () => {
    const entries = buildSearchIndex({ forms: [
      { id: "sealed", templateKey: "fmla_self", status: "draft", sealed: true, answers: { reason: "medicaltripwire" } },
      { id: "ordinary", templateKey: "grievance", status: "draft", answers: { summary: "ordinarytripwire", empty: null } },
      { id: "empty", templateKey: "grievance", status: "draft" },
    ] }, tEn);
    expect(entries).toContainEqual(expect.objectContaining({ id: "form:sealed", type: "form" }));
    expect(JSON.stringify(entries)).not.toContain("medicaltripwire");
    expect(searchEntries(entries, "medicaltripwire")).toEqual([]);
    expect(searchEntries(entries, "ordinarytripwire").flatMap((group) => group.items))
      .toContainEqual(expect.objectContaining({ id: "form:ordinary", type: "form" }));
  });

  it("indexes every member surface present in the snapshot", () => {
    const types = new Set(index.map((entry) => entry.type));
    for (const expected of ["case", "conversation", "broadcast", "event", "lesson", "kb", "notification"]) {
      expect(types.has(expected), `missing type ${expected}`).toBe(true);
    }
  });

  it("returns an empty index without data", () => {
    expect(buildSearchIndex(null)).toEqual([]);
  });

  it("finds member pages by their displayed names without listing hidden or staff pages", () => {
    const data = { ...fallbackData, roles: ["member", "admin"], organizationConfiguration: { switches: { "features.guidance_onboarding.site_guide": false } } };
    const entries = buildSearchIndex(data, tEn);
    expect(searchEntries(entries, tEn("nav.knowRights")).flatMap((group) => group.items)).toContainEqual(expect.objectContaining({
      type: "page", title: tEn("nav.knowRights"), focus: { view: "rights", path: "/m/rights" },
    }));
    expect(entries.filter((item) => item.type === "page").some((item) => ["siteGuide", "admin", "steward", "tasks"].includes(item.focus.view))).toBe(false);
    expect(searchEntries(buildSearchIndex(data, tEs), tEs("nav.knowRights")).flatMap((group) => group.items)).toContainEqual(expect.objectContaining({ type: "page", focus: { view: "rights", path: "/m/rights" } }));
    // Union Ground has no contract clauses page (owner decision,
    // 2026-10-13): search never offers one, by name or by path.
    const pages = entries.filter((item) => item.type === "page");
    expect(pages.some((item) => item.focus.view === "clauses" || item.focus.path === "/m/clauses")).toBe(false);
    expect(searchEntries(entries, "contract clauses").flatMap((group) => group.items).some((item) => item.type === "page" && item.focus.view === "clauses")).toBe(false);
    expect(buildSearchIndex(data, tEs).some((item) => item.type === "page" && item.focus.view === "clauses")).toBe(false);
  });

  it("indexes only occupied officer names from the current member-visible organization and chapter", () => {
    const member = { id: "member-1", organizationId: "org-1", chapterId: "chapter-1" };
    const node = { id: "officer-1", nodeKind: "person", label: "Dolores Whitcombe", subtitle: "President", chapterId: "chapter-1" };
    const memberOrgStructure = { organizationId: "org-1", chapterId: "chapter-1", charts: [{ chartKind: "union", nodes: [node,
      { ...node, id: "foreign", chapterId: "chapter-2", label: "Hidden Officer" },
      { ...node, id: "vacant", vacant: true, label: "Vacant Officer" },
    ] }] };
    const data = { member, memberOrgStructure, memberDirectory: { items: [{ id: "private", fullName: "Private Person" }] }, taskAssignees: [{ id: "private", fullName: "Private Person" }] };
    const people = buildSearchIndex(data, tEn).filter((item) => item.type === "person");
    expect(people).toEqual([expect.objectContaining({ title: "Dolores Whitcombe", snippet: "President", focus: { view: "orgStructure", path: "/m/org-structure", nodeId: "officer-1" } })]);
    expect(searchEntries(people, "dolores president")).toHaveLength(1);
    expect(buildSearchIndex({ ...data, member: { ...member, organizationId: "org-2" } }, tEn).filter((item) => item.type === "person")).toEqual([]);
    expect(buildSearchIndex({ ...data, member: { ...member, chapterId: "chapter-2" } }, tEn).filter((item) => item.type === "person")).toEqual([]);
  });

  it("indexes occupied union role seats and focuses the matched node, but never vacant seats", () => {
    const member = { id: "member-1", organizationId: "org-1", chapterId: "chapter-1" };
    const memberOrgStructure = { organizationId: "org-1", chapterId: "chapter-1", charts: [{ chartKind: "union", nodes: [
      { id: "seat-president", nodeKind: "role", label: "President", subtitle: "Dolores Whitcombe", chapterId: null },
      { id: "seat-open", nodeKind: "role", label: "Chief steward", subtitle: "Seat posted", vacant: true },
      { id: "chapter", nodeKind: "chapter", label: "Chapter one" },
    ] }] };
    const people = buildSearchIndex({ member, memberOrgStructure }, tEn).filter((item) => item.type === "person");
    expect(people).toEqual([expect.objectContaining({ title: "President", focus: { view: "orgStructure", path: "/m/org-structure", nodeId: "seat-president" } })]);
    expect(searchEntries(people, "whitcombe")).toHaveLength(1);
    expect(searchEntries(people, "chief steward")).toHaveLength(0);
  });

  it("indexes the steward roster by name and role only, opening Home", () => {
    const member = { id: "member-1", organizationId: "org-1", chapterId: "wor" };
    const chapterStewards = [
      { id: "st-1", name: "Rosa Diaz", roleLabel: "steward", chapterLabel: "Harborview Care United", contact: { conversation: true, email: "rosa@example.org", phone: "555-0100" } },
      { id: "st-2", name: null, roleLabel: "steward", contact: { conversation: true } },
    ];
    const people = buildSearchIndex({ member, chapterStewards }, tEn).filter((item) => item.type === "person");
    expect(people).toEqual([expect.objectContaining({ title: "Rosa Diaz", snippet: "Committee member · Harborview Care United", focus: { view: "today", path: "/m" } })]);
    expect(JSON.stringify(people)).not.toMatch(/rosa@example|555-0100/);
    expect(searchEntries(people, "rosa")).toHaveLength(1);
    expect(searchEntries(people, "rosa@example.org")).toHaveLength(0);
  });

  it("finds the demo officers although the demo member carries no organization id", () => {
    expect(fallbackData.member.organizationId).toBeUndefined();
    const withoutRoster = { ...fallbackData, chapterStewards: [] };
    const chart = searchEntries(buildSearchIndex(withoutRoster, tEn), "sam okafor").flatMap((group) => group.items);
    expect(chart).toContainEqual(expect.objectContaining({ type: "person", focus: expect.objectContaining({ view: "orgStructure", nodeId: "un-3" }) }));
    // With the roster loaded the same person appears once, as the steward.
    const both = buildSearchIndex(fallbackData, tEn).filter((item) => item.type === "person" && item.title === "Sam Okafor");
    expect(both).toEqual([expect.objectContaining({ focus: { view: "today", path: "/m" } })]);
    // Another chapter's snapshot is still refused.
    const other = { ...withoutRoster, member: { ...fallbackData.member, chapterId: "spr" } };
    expect(buildSearchIndex(other, tEn).filter((item) => item.type === "person")).toEqual([]);
  });

  it("an empty snapshot still offers the static form templates (the FormsView fallback chain)", () => {
    const entries = buildSearchIndex({}, tEn);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((item) => ["template", "page"].includes(item.type))).toBe(true);
  });

  it("carries the deep-link payload a view needs to land ON the item", () => {
    const caseEntry = index.find((entry) => entry.type === "case");
    expect(caseEntry.focus).toMatchObject({
      view: "cases",
      path: `/m/cases?case=${caseEntry.focus.caseId}`,
      filter: "all",
    });
    expect(caseEntry.focus.caseId).toBeTruthy();

    const broadcastEntry = index.find((entry) => entry.type === "broadcast");
    expect(broadcastEntry.focus).toMatchObject({ view: "messages", tab: "broadcasts" });
    expect(broadcastEntry.focus.broadcastId).toBeTruthy();

    const lessonEntry = index.find((entry) => entry.type === "lesson");
    expect(lessonEntry.focus.lessonLabel).toBeTruthy();

    const kbEntry = index.find((entry) => entry.type === "kb");
    expect(kbEntry.focus.kb).toBeTruthy();
  });

  it("skips the plan lesson nudge (it duplicates the rights entry)", () => {
    const planTypes = index.filter((entry) => entry.focus.planId).map((entry) => entry.type);
    expect(planTypes.every((type) => type === "ballot" || type === "pulse")).toBe(true);
  });

  it("indexes form templates under their DISPLAYED titles — static shape via t()", () => {
    // fallbackData has no formTemplates, so the static FORM_TEMPLATES chain
    // applies (the same fallback FormsView uses) and titles resolve through
    // the catalogue — never the raw registry key.
    const withT = buildSearchIndex(fallbackData, tEn);
    const templates = withT.filter((entry) => entry.type === "template");
    expect(templates.length).toBeGreaterThan(0);
    const grievance = templates.find((entry) => entry.focus.templateKey === "grievance");
    expect(grievance.title).toBe(tEn("forms.tpl.grievance"));
    expect(grievance.title).not.toBe("grievance");
    expect(grievance.title).not.toMatch(/^forms\.tpl\./);
    // …and the displayed title is what a member can SEARCH by, in Spanish too.
    const esTitle = tEs("forms.tpl.fmla_self");
    const esGroups = searchEntries(buildSearchIndex(fallbackData, tEs), esTitle.split(/\s+/)[0]);
    expect(esGroups.flatMap((group) => group.items).some((item) => item.title === esTitle)).toBe(true);
  });

  it("indexes DB-shape templates via their pre-resolved text", () => {
    const dbData = {
      ...fallbackData,
      formTemplates: [{ key: "grievance", version: 3, source: "db", titleKey: "Informe de queja formal", blurbKey: "Presenta una queja" }],
      formTemplateVersions: [{ key: "grievance", version: 3, source: "db", titleKey: "Informe de queja formal", blurbKey: "" }],
      forms: [{ id: "f1", templateKey: "grievance", templateVersion: 3, status: "draft", answers: { summary: "sobrecarga de casos" } }],
    };
    const index2 = buildSearchIndex(dbData, tEs);
    const template = index2.find((entry) => entry.type === "template");
    expect(template.title).toBe("Informe de queja formal");
    // The member's own draft carries its pinned template's resolved title too.
    const form = index2.find((entry) => entry.type === "form");
    expect(form.title).toBe("Informe de queja formal");
    // And the draft's answers are searchable.
    const hits = searchEntries(index2, "sobrecarga");
    expect(hits.flatMap((group) => group.items).some((item) => item.id === "form:f1")).toBe(true);
  });

  it("indexes the recognition catalogue that a producer actually emits", () => {
    // The group used to read data.rewardsCatalog, which no producer emits, so
    // it was permanently empty. fallbackData pins 5 recognition rules.
    const rewards = index.filter((item) => item.type === "reward");
    expect(rewards).toHaveLength(fallbackData.recognitionCatalog.rules.length);
    const training = rewards.find((item) => item.id === "reward:training_complete");
    expect(training.title).toBe("Completed training");
    expect(training.focus).toMatchObject({ view: "rewards", path: "/m/rewards" });
    // Point scores were retired, so no entry may advertise one.
    expect(rewards.every((item) => item.meta === "")).toBe(true);
    const groups = searchEntries(index, "orientation");
    expect(groups.some((group) => group.type === "reward")).toBe(true);
  });

  it("finds an event by its displayed location", () => {
    const groups = searchEntries(index, "library");
    expect(groups.flatMap((group) => group.items).some((item) => item.type === "event")).toBe(true);
  });
});

describe("searchEntries", () => {
  const index = buildSearchIndex(fallbackData);

  it("returns nothing for an empty or whitespace query", () => {
    expect(searchEntries(index, "")).toEqual([]);
    expect(searchEntries(index, "   ")).toEqual([]);
  });

  it("finds by title regardless of diacritics and case", () => {
    const groups = searchEntries(index, "section 7");
    const flat = groups.flatMap((group) => group.items);
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.some((item) => item.type === "lesson" || item.type === "kb")).toBe(true);
  });

  it("requires every token to match (AND semantics)", () => {
    const hit = searchEntries(index, "supervisor questions");
    expect(hit.flatMap((group) => group.items).some((item) => item.focus.kb === "supervisor-questions")).toBe(true);
    expect(searchEntries(index, "supervisor zzzznope")).toEqual([]);
  });

  it("matches body/haystack text, not only titles", () => {
    // "non-work time" appears in the Section 7 KB body, not its title.
    const groups = searchEntries(index, "non-work time");
    expect(groups.flatMap((group) => group.items).some((item) => item.type === "kb")).toBe(true);
  });

  it("caps each type group", () => {
    // 20 archived broadcasts share the word "campaign" — the group must cap.
    const groups = searchEntries(index, "campaign", { limitPerType: 5 });
    const broadcastGroup = groups.find((group) => group.type === "broadcast");
    expect(broadcastGroup.items.length).toBeLessThanOrEqual(5);
  });

  it("ranks title matches above body-only matches within a group", () => {
    const entries = [
      { id: "a", type: "kb", title: "About telework", snippet: "", meta: "", focus: {}, haystack: "about telework" },
      { id: "b", type: "kb", title: "Something else", snippet: "", meta: "", focus: {}, haystack: "something else telework mention" },
    ];
    const groups = searchEntries(entries, "telework");
    expect(groups[0].items[0].id).toBe("a");
  });

  it("keeps server-ranked case rows above local matches and does not re-filter them", () => {
    const local = [
      { id: "case:local", type: "case", title: "Local filing", snippet: "", meta: "", focus: {}, haystack: "local filing" },
    ];
    const server = serverCaseEntries([{
      case_id: "server-1",
      reference: "SG-9",
      title: "Filed paperwork",
      articles: "",
      step: "Intake",
      case_type: "Grievance",
      deadline: null,
      rank: 0.8,
      headline: "The steward [[filed]] the step one paperwork.",
      headline_source: "update",
    }]);
    const groups = searchEntries(mergeServerCaseEntries(local, server), "filing");
    expect(groups[0].items.map((item) => item.id)).toEqual(["case:server-1", "case:local"]);
    expect(groups[0].items[0].pinned).toBe(true);
  });
});

describe("server case snippets", () => {
  it("splits ts_headline sentinels into highlight segments without treating them as HTML", () => {
    expect(snippetSegments("The steward [[filed]] the paperwork.")).toEqual([
      { text: "The steward ", highlight: false },
      { text: "filed", highlight: true },
      { text: " the paperwork.", highlight: false },
    ]);
    expect(plainSnippet("The steward [[filed]] the paperwork.")).toBe("The steward filed the paperwork.");
  });

  it("deep-links every server case through the CasesView ?case= param", () => {
    expect(caseFocus("abc")).toEqual({ view: "cases", path: "/m/cases?case=abc", caseId: "abc", filter: "all" });
    const [entry] = serverCaseEntries([{
      case_id: "abc",
      reference: "SG-1",
      title: "Overtime",
      articles: "Art. 8",
      step: "Step 1",
      case_type: "Grievance",
      deadline: "2026-07-24",
      rank: 1,
      headline: "[[Overtime]] distribution",
      headline_source: "articles",
    }], { formatDeadline: () => "Jul 24" });
    expect(entry.focus).toEqual(caseFocus("abc"));
    expect(entry.snippetSegments.some((segment) => segment.highlight && segment.text === "Overtime")).toBe(true);
  });

  it("replaces the local twin and appends cases the snapshot never carried", () => {
    const local = buildSearchIndex({
      cases: [{ id: "abc", reference: "SG-1", title: "Overtime", articles: "Art. 8", step: "Step 1", type: "Grievance", deadline: "Jul 24", updates: [] }],
    });
    const server = serverCaseEntries([{
      case_id: "abc",
      reference: "SG-1",
      title: "Overtime",
      articles: "Art. 8",
      step: "Step 1",
      case_type: "Grievance",
      deadline: "2026-07-24",
      rank: 1,
      headline: "[[Overtime]] distribution",
      headline_source: "articles",
    }, {
      case_id: "def",
      reference: "SG-2",
      title: "Assigned caseload",
      articles: "",
      step: "Intake",
      case_type: "Grievance",
      deadline: null,
      rank: 0.4,
      headline: "Assigned [[caseload]] note",
      headline_source: "update",
    }]);
    const merged = mergeServerCaseEntries(local, server);
    expect(merged.filter((item) => item.type === "case").map((item) => item.id)).toEqual(["case:abc", "case:def"]);
    expect(merged.find((item) => item.id === "case:abc").pinned).toBe(true);
    expect(merged.find((item) => item.id === "case:abc").haystack).toContain("overtime");
  });
});

describe("server snippet sentinels — degenerate headlines", () => {
  it("has no segments at all when the row carried no headline", () => {
    expect(snippetSegments(null)).toEqual([]);
    expect(snippetSegments(undefined)).toEqual([]);
    expect(snippetSegments("")).toEqual([]);
    expect(plainSnippet(null)).toBe("");
  });

  it("renders an unterminated sentinel as plain text rather than swallowing the tail", () => {
    // ts_headline never emits this, but a truncated or hand-built string must
    // still reach the member as readable text instead of vanishing.
    expect(snippetSegments("The steward [[filed")).toEqual([
      { text: "The steward [[filed", highlight: false },
    ]);
    expect(plainSnippet("The steward [[filed")).toBe("The steward [[filed");
  });

  it("drops an empty mark instead of emitting a blank highlight", () => {
    expect(snippetSegments("before[[]]after")).toEqual([
      { text: "before", highlight: false },
      { text: "after", highlight: false },
    ]);
  });

  it("emits no trailing plain segment when the headline ends on a mark", () => {
    expect(snippetSegments("[[filed]]")).toEqual([{ text: "filed", highlight: true }]);
    expect(plainSnippet("[[filed]]")).toBe("filed");
  });
});

describe("serverCaseEntries — rows the RPC may return sparsely", () => {
  it("returns nothing when the RPC yielded no array (error or empty payload)", () => {
    expect(serverCaseEntries(undefined)).toEqual([]);
    expect(serverCaseEntries(null)).toEqual([]);
    expect(serverCaseEntries({ error: "boom" })).toEqual([]);
  });

  it("shows the server's neutral line, never articles or step as the snippet, and defaults rank/source", () => {
    // #7015: search_member_cases sends the neutral type and step line as title
    // and no headline; an older row that still carried articles must not show them.
    const [withArticles, withStep, bare] = serverCaseEntries([
      { case_id: "a1", reference: "SG-1", title: "Grievance · Step 1", articles: "Art. 8", step: "Step 1", case_type: "Grievance" },
      { case_id: "a2", reference: "SG-2", title: "Grievance · Intake", articles: "", step: "Intake", case_type: "Grievance" },
      { case_id: "a3", reference: "SG-3", title: "Grievance", articles: "", step: "", case_type: "Grievance" },
    ]);

    expect(withArticles.title).toBe("SG-1 · Grievance · Step 1");
    expect([withArticles, withStep, bare].map((item) => item.snippet)).toEqual(["", "", ""]);

    // No headline means no marked runs, and the missing rank/source columns
    // must not leak NaN or undefined into the result card.
    expect(withArticles.snippetSegments).toEqual([]);
    expect(withArticles.headlineSource).toBe("");
    expect(withArticles.serverRank).toBe(0);
    expect(withArticles.meta).toBe("");
    expect([withArticles, withStep, bare].map((item) => item.serverOrder)).toEqual([0, 1, 2]);
    expect(bare.focus).toEqual(caseFocus("a3"));
  });
});

describe("mergeServerCaseEntries — nothing to merge", () => {
  it("returns the local index untouched when the server produced no rows", () => {
    const local = [{ id: "case:local", type: "case", title: "Local", snippet: "", meta: "", focus: {}, haystack: "local" }];
    expect(mergeServerCaseEntries(local, undefined)).toBe(local);
    expect(mergeServerCaseEntries(local, [])).toBe(local);
  });

  it("yields the server rows alone when there is no local index to merge into", () => {
    const server = serverCaseEntries([{
      case_id: "only", reference: "SG-7", title: "Server only", articles: "Art. 3",
      step: "Step 2", case_type: "Grievance", deadline: null, rank: 0.5,
      headline: "Server [[only]]", headline_source: "update",
    }]);
    expect(mergeServerCaseEntries(null, server).map((item) => item.id)).toEqual(["case:only"]);
  });
});

describe("pinned server rows without an order", () => {
  it("still outranks every locally scored hit", () => {
    const entries = [
      { id: "case:local", type: "case", title: "Local filing", snippet: "", meta: "", focus: {}, haystack: "local filing", pinned: false },
      { id: "case:pinned", type: "case", title: "Unrelated", snippet: "", meta: "", focus: {}, haystack: "", pinned: true },
    ];
    const groups = searchEntries(entries, "filing");
    expect(groups[0].items.map((item) => item.id)).toEqual(["case:pinned", "case:local"]);
  });
});

describe("case update bodies", () => {
  it("are searchable locally even when the title does not mention the words", () => {
    const index = buildSearchIndex({
      cases: [{
        id: "c1", reference: "SG-4", title: "Overtime", articles: "Art. 8",
        step: "Step 1", type: "Scheduling", deadline: "Jul 24",
        updates: [{ body: "Steward left a voicemail for the plant manager" }],
      }],
    }, tEn);
    const groups = searchEntries(index, "voicemail");
    expect(groups.flatMap((group) => group.items).map((item) => item.id)).toEqual(["case:c1"]);
    // Neither the inert article nor the step is indexed or shown.
    expect(index.find((item) => item.id === "case:c1")).toMatchObject({
      title: "SG-4 · Scheduling",
      snippet: "",
    });
    expect(searchEntries(index, "Art. 8")).toEqual([]);
    expect(searchEntries(index, "Step 1")).toEqual([]);
  });
});

// BUG-UG-PASSWORD-REISSUE-HAT-AND-DISCOVERY-20261003: an admin searched
// "reissue" and got "No matches". The password reissue is now findable by the
// words the sign-in error and locked-out members use, for admins only.
describe("password reissue search entry", () => {
  const adminData = { roles: ["admin"] };

  it("finds the reissue for an admin by reissue, password, forgot or the Spanish words", () => {
    const index = buildSearchIndex(adminData, tEn);
    for (const query of ["reissue", "new password", "forgot password", "locked out", "sign-in help"]) {
      const groups = searchEntries(index, query);
      const tool = groups.find((group) => group.type === "tool");
      expect(tool?.items[0], query).toMatchObject({
        title: "Send a worker a new password",
        focus: { staffView: "admin", path: "/m/admin/signin-recovery", sectionId: "admin-signin-recovery" },
      });
      expect(tool.items[0].snippet).toContain("Needs the Admin desk");
    }
    const es = searchEntries(buildSearchIndex(adminData, tEs), "contraseña nueva").find((group) => group.type === "tool");
    expect(es?.items[0].title).toBe("Enviar una contraseña nueva a un trabajador o trabajadora");
  });

  it("is not offered to someone without the Admin role", () => {
    const index = buildSearchIndex({ roles: ["steward", "president"] }, tEn);
    expect(searchEntries(index, "reissue")).toEqual([]);
  });
});
