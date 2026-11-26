// @vitest-environment node
// REQ-UG-UNION-CATALOG-SETUP-REVIEW-PREFILL-20260925: the pure payload
// builder behind the setup review and the catalog read normalizer it feeds
// from. Keys are namespaced per organization, the payload never carries a
// dryRun key, and nothing person-shaped or contact-shaped from a public record
// ever reaches it. All values are fictional.
import { describe, expect, it } from "vitest";
import {
  attestationIssues,
  buildSetupPayload,
  chapterKeyFor,
  easternDate,
  MAX_ITEMS,
  newOwnRow,
  nodeKeyFor,
  normalizeSetupProfile,
  rowForErrorPath,
  rowIssues,
  rowsFromProfile,
  rowTypeForKind,
  seatsFromProfile,
  slugPrefix,
  sourceLabelFor,
} from "../src/features/orgSetup/setupPayload.js";
import { loadSetupProfile, probeSetupCatalog } from "../src/features/orgSetup/setupApi.js";
import {
  CATALOG_KEY_PATTERN,
  formatCatalogDate,
  isMissingRpcError,
  searchCatalogKeys,
} from "../src/features/unionCatalog/catalogSearch.js";

const ORG_A = "a1b2c3d4-0000-4000-8000-000000000001";
const ORG_B = "b9c8d7e6-0000-4000-8000-000000000002";
const SENTINEL_EMAIL = "sentinel@example.invalid";
const SENTINEL_PHONE = "555-0100-0000";

function rawProfile(overrides = {}) {
  return {
    found: true,
    organization: {
      key: "olms-900000001",
      name: "Example Workers Local 1",
      structureNote: `Call ${SENTINEL_PHONE} or write ${SENTINEL_EMAIL}`,
      registryId: "11111111-2222-4333-8444-555555555555",
      latitude: 42.1,
      longitude: -72.5,
      confidence: "official_site",
    },
    parents: [],
    children: [{ key: "olms-900000009", name: "Sample Transit Council" }],
    childrenTotal: 1,
    subunits: [
      {
        key: "sub-a", parentKey: null, kind: "council", name: "Example Workers North Council",
        employer: `Employer ${SENTINEL_EMAIL}`, structureNote: SENTINEL_PHONE, electionNote: SENTINEL_EMAIL,
        densityNote: SENTINEL_PHONE, location: "Springfield", members: 120, confidence: "secondary",
        sourceUrl: "https://records.example.invalid/north", asOf: "2026-08-01",
      },
      { key: "sub-b", parentKey: "sub-a", kind: "chapter", name: "Riverbend Chapter", sourceUrl: "http://plain.example.invalid/x", asOf: "2026-08-02" },
      { key: "sub-c", parentKey: null, kind: "committee", name: "Education Committee", sourceUrl: "https://committee.example.invalid/", asOf: null },
      { key: "sub-d", parentKey: null, kind: "retiree_chapter", name: "Retiree Chapter", asOf: "2026-08-03" },
    ],
    seatOutlines: [
      { key: "seat-1", subunitKey: null, seatClass: "officer", title: "President", listed: 1, vacant: 0, asOf: "2026-08-01" },
      { key: "seat-2", subunitKey: "sub-b", seatClass: "board", title: "Board member", listed: 3, vacant: 1, asOf: null },
      { key: "seat-3", subunitKey: null, seatClass: "steward", title: "Steward", listed: 4, vacant: 0 },
      { key: "seat-4", subunitKey: null, seatClass: "delegate", title: "Delegate", listed: 2, vacant: 0 },
    ],
    contacts: [
      { kind: "email", value: SENTINEL_EMAIL, label: "Office" },
      { kind: "phone", value: SENTINEL_PHONE, label: "Office" },
    ],
    documents: [
      { key: "doc-1", kind: "bylaws", title: `Bylaws ${SENTINEL_EMAIL}`, url: "https://docs.example.invalid/bylaws.pdf" },
      { key: "doc-2", kind: "contract", title: "Contract", url: "http://docs.example.invalid/contract.pdf" },
    ],
    coverage: { band: "deep", demandBand: "high" },
    ...overrides,
  };
}

const attestation = { suppliedBy: "Example Admin", suppliedOn: "2026-09-25", authority: "Accepted in setup review by the organization's admin" };

describe("kind mapping and review rows", () => {
  it("maps every catalog sub-unit kind to one of the five row types", () => {
    expect(Object.fromEntries(["chapter", "local", "unit", "bargaining_unit", "retiree_chapter", "council", "district",
      "division", "region", "sector", "department", "committee", "other", "unexpected"].map((kind) => [kind, rowTypeForKind(kind)])))
      .toEqual({
        chapter: "chapter", local: "chapter", unit: "unit", bargaining_unit: "unit", retiree_chapter: "retiree_chapter",
        council: "council", district: "council", division: "council", region: "council", sector: "council",
        department: "office", committee: "office", other: "office", unexpected: "office",
      });
  });

  it("builds included rows from the profile and never from children", () => {
    const profile = normalizeSetupProfile(rawProfile());
    const rows = rowsFromProfile(profile);
    expect(rows.map((row) => [row.id, row.type, row.parentId, row.sourceHost])).toEqual([
      ["sub-a", "council", null, "records.example.invalid"],
      ["sub-b", "chapter", "sub-a", null],
      ["sub-c", "office", null, "committee.example.invalid"],
      ["sub-d", "retiree_chapter", null, null],
    ]);
    expect(rows.some((row) => row.name === "Sample Transit Council")).toBe(false);
    expect(profile.childrenTotal).toBe(1);
    expect(rowsFromProfile({ found: false })).toEqual([]);
    expect(seatsFromProfile({ found: false })).toEqual([]);
  });

  it("offers officer and board seat outlines only, never steward or delegate", () => {
    const seats = seatsFromProfile(normalizeSetupProfile(rawProfile()));
    expect(seats.map((seat) => seat.seatClass)).toEqual(["officer", "board"]);
  });

  it("gives an own row a fixed id and a known type", () => {
    const row = newOwnRow("Harbor Chapter", "nonsense");
    expect(row.type).toBe("chapter");
    expect(row.origin).toBe("own");
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(newOwnRow("Office", "office", "fixed").id).toBe("fixed");
  });
});

describe("keys", () => {
  it("namespaces chapter keys per organization, deterministically, within 26 characters", async () => {
    const a = await chapterKeyFor(ORG_A, "Example Workers Local 1", "sub-b");
    const again = await chapterKeyFor(ORG_A, "Example Workers Local 1", "sub-b");
    const b = await chapterKeyFor(ORG_B, "Example Workers Local 1", "sub-b");
    expect(a).toBe(again);
    expect(a).not.toBe(b);
    for (const key of [a, b]) {
      expect(key).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
      expect(key.length).toBeLessThanOrEqual(26);
    }
    expect(a.startsWith("example-work-a1b2-")).toBe(true);
  });

  it("strips a trailing hyphen from the slug and falls back when nothing is left", () => {
    expect(slugPrefix("Example Work Local")).toBe("example-work");
    expect(slugPrefix("Example Wor- Local")).toBe("example-wor");
    expect(slugPrefix("!!!")).toBe("org");
    expect(slugPrefix(null)).toBe("org");
  });

  it("distinguishes full organization identities when their UUID prefixes match", async () => {
    const otherOrganization = "a1b2ffff-ffff-4fff-8fff-ffffffffffff";
    const first = await chapterKeyFor(ORG_A, "Example Workers Local 1", "sub-b");
    const other = await chapterKeyFor(otherOrganization, "Example Workers Local 1", "sub-b");
    expect(other).not.toBe(first);
    expect(await chapterKeyFor(otherOrganization, "Example Workers Local 1", "sub-b")).toBe(other);
    expect(await chapterKeyFor(ORG_A.toUpperCase(), "Example Workers Local 1", "sub-b")).toBe(first);
    expect(await chapterKeyFor(ORG_A, "Example Workers Local 1", "sub-c")).not.toBe(first);
    for (const key of [first, other]) {
      expect(key).toMatch(/^example-work-a1b2-[0-9a-f]{8}$/);
      expect(key.length).toBeLessThanOrEqual(26);
    }
  });

  it("formats node keys as cat.<12 hex>", async () => {
    expect(await nodeKeyFor("sub-a")).toMatch(/^cat\.[0-9a-f]{12}$/);
  });
});

describe("buildSetupPayload", () => {
  async function build(extra = {}) {
    const profile = normalizeSetupProfile(rawProfile());
    return buildSetupPayload({
      organizationId: ORG_A,
      organizationName: "Example Workers Local 1",
      rows: rowsFromProfile(profile),
      attestation,
      source: { releaseLabel: "20260924-01", catalogKey: "olms-900000001", dataAsOf: "2026-09-24" },
      nodeSalt: "build-1",
      ...extra,
    });
  }

  it("carries the admin hat and fixed consent, and never a dryRun key", async () => {
    const payload = await build();
    expect(payload).not.toHaveProperty("dryRun");
    expect(payload.selectedHat).toBe("admin");
    expect(payload.schemaVersion).toBe("org-structure/1");
    expect(payload.attestation.personalContactConsent).toBe("not_obtained");
    expect(Object.keys(payload).sort()).toEqual(["attestation", "chapters", "charts", "schemaVersion", "selectedHat", "sources"]);
  });

  it("never reuses a chapter key the organization already has, so a second confirm adds instead of renaming", async () => {
    // Gate round 1 on: keys are deterministic, and the import
    // updates the chapter that owns a reused key.
    const first = await build();
    const [reused, untouched] = first.chapters;
    const again = await build({ existingChapterIds: [reused.chapterKey] });
    const keys = again.chapters.map((chapter) => chapter.chapterKey);
    expect(keys).not.toContain(reused.chapterKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(untouched.chapterKey);
    expect(keys.every((key) => key.length <= 26)).toBe(true);
    // The re-keyed chapter's node moves with it; nodes still point at chapters
    // that are in this payload.
    const nodeChapterKeys = again.charts.union.nodes.filter((node) => node.chapterKey).map((node) => node.chapterKey);
    expect(nodeChapterKeys.sort()).toEqual([...keys].sort());
    const oldNode = first.charts.union.nodes.find((node) => node.chapterKey === reused.chapterKey);
    expect(again.charts.union.nodes.map((node) => node.nodeKey)).not.toContain(oldNode.nodeKey);
    // Same input, same keys: the dry run and the confirm send identical bodies.
    expect(await build({ existingChapterIds: [reused.chapterKey] })).toEqual(again);
  });

  it("keeps shared catalog chapters and their node references distinct across matching organization prefixes", async () => {
    const first = await build();
    const other = await build({ organizationId: "a1b2ffff-ffff-4fff-8fff-ffffffffffff" });
    const firstKeys = first.chapters.map((chapter) => chapter.chapterKey);
    const otherKeys = other.chapters.map((chapter) => chapter.chapterKey);
    expect(otherKeys).toHaveLength(firstKeys.length);
    expect(otherKeys.filter((key) => firstKeys.includes(key))).toEqual([]);
    for (const payload of [first, other]) {
      const chapterKeys = payload.chapters.map((chapter) => chapter.chapterKey).sort();
      const references = payload.charts.union.nodes.filter((node) => node.chapterKey).map((node) => node.chapterKey).sort();
      expect(references).toEqual(chapterKeys);
    }
    expect(await build({ organizationId: "a1b2ffff-ffff-4fff-8fff-ffffffffffff" })).toEqual(other);
  });

  it("never repeats a node key across builds, even when the chart title changed", async () => {
    // Gate round 2 on: the import upserts by node key and
    // replaces a matched node's notes and metrics, and a re-import under a new
    // title used to reproduce every node key while its chapter keys changed.
    const profile = normalizeSetupProfile(rawProfile());
    const make = (organizationName) => buildSetupPayload({
      organizationId: ORG_A, organizationName, rows: rowsFromProfile(profile), attestation,
      seats: seatsFromProfile(profile),
    });
    const first = await make("Example Workers Local 1");
    for (const again of [await make("Example Workers Local 1 (renamed)"), await make("Example Workers Local 1")]) {
      const before = new Set(first.charts.union.nodes.slice(1).map((node) => node.nodeKey));
      const after = again.charts.union.nodes.slice(1).map((node) => node.nodeKey);
      expect(after.length).toBe(before.size);
      expect(after.filter((key) => before.has(key))).toEqual([]);
      expect(again.charts.union.nodes[0].nodeKey).toBe("cat.root");
    }
  });

  it("maps rows to chapters and nodes under one organization root", async () => {
    const payload = await build();
    const nodes = payload.charts.union.nodes;
    expect(nodes[0]).toEqual({ nodeKey: "cat.root", nodeKind: "organization", label: "Example Workers Local 1", sortOrder: 0 });
    expect(nodes.slice(1).map((node) => node.nodeKind)).toEqual(["division", "chapter", "team", "chapter"]);
    expect(payload.chapters.map((chapter) => chapter.name)).toEqual(["Riverbend Chapter", "Retiree Chapter"]);
    expect(payload.chapters.map((chapter) => chapter.orderIndex)).toEqual([2, 3]);
    const council = nodes[1];
    const chapterNode = nodes[2];
    expect(chapterNode.parentKey).toBe(council.nodeKey);
    expect(council.parentKey).toBe("cat.root");
    expect(chapterNode.chapterKey).toBe(payload.chapters[0].chapterKey);
    expect(council.sourceLabel).toBe("records.example.invalid");
    expect(council.sourceAsOf).toBe("2026-08-01");
    expect(nodes[3]).not.toHaveProperty("sourceAsOf");
  });

  it("keeps the setup anchor stable while later units receive fresh node keys", async () => {
    const first = await build({ nodeSalt: 'first-confirm' });
    const later = await build({
      organizationName: 'Edited chart title', nodeSalt: 'later-confirm',
      existingChapterIds: first.chapters.map((chapter) => chapter.chapterKey),
    });
    expect(later.charts.union.nodes[0].nodeKey).toBe(first.charts.union.nodes[0].nodeKey);
    const oldKeys = new Set(first.charts.union.nodes.slice(1).map((node) => node.nodeKey));
    expect(later.charts.union.nodes.slice(1).some((node) => oldKeys.has(node.nodeKey))).toBe(false);
    expect(later.charts.union.nodes.some((node) => node.parentKey === 'cat.root')).toBe(true);
  });

  it("labels the source within 180 characters", async () => {
    const payload = await build();
    expect(payload.sources).toEqual([{ sourceLabel: "Union Ground public-record catalog 20260924-01, olms-900000001", sourceAsOf: "2026-09-24" }]);
    expect(sourceLabelFor("x".repeat(300), "olms-1").length).toBe(180);
    const own = await build({ source: null });
    expect(own).not.toHaveProperty("sources");
  });

  it("never copies a person, contact, employer, note or document into the payload", async () => {
    const raw = rawProfile();
    const payload = await build({ seats: seatsFromProfile(normalizeSetupProfile(raw)) });
    const text = JSON.stringify(payload);
    expect(text).not.toContain(SENTINEL_EMAIL);
    expect(text).not.toContain(SENTINEL_PHONE);
    expect(text).not.toContain("Employer");
    expect(text).not.toContain("Springfield");
    expect(text).not.toContain("Bylaws");
    expect(text).not.toContain("Sample Transit Council");
    expect(text).not.toMatch(/memberUserId|"person"|"contacts"|"notes"|"metrics"|referenceSections|timelineEvents|topicSeeds/);
    // The raw profile itself never reaches the row builder unfiltered either.
    expect(JSON.stringify(rowsFromProfile(normalizeSetupProfile(raw)))).not.toContain(SENTINEL_EMAIL);
  });

  it("adds opted-in seats as vacant role nodes only", async () => {
    const profile = normalizeSetupProfile(rawProfile());
    const payload = await build({
      seats: [...seatsFromProfile(profile), { key: "seat-x", seatClass: "steward", title: "Steward" }],
      seatBadge: "From public records",
      seatSubtitle: (asOf) => (asOf ? `Unconfirmed · listed publicly as of ${asOf}` : ""),
    });
    const roles = payload.charts.union.nodes.filter((node) => node.nodeKind === "role");
    expect(roles.map((node) => [node.label, node.vacant, node.roleClass])).toEqual([["President", true, "director"], ["Board member", true, "functional"]]);
    expect(roles[0]).toMatchObject({ badge: "From public records", subtitle: "Unconfirmed · listed publicly as of 2026-08-01", parentKey: "cat.root" });
    expect(roles[1]).not.toHaveProperty("subtitle");
    const chapterNode = payload.charts.union.nodes.find((node) => node.label === "Riverbend Chapter");
    expect(roles[1].parentKey).toBe(chapterNode.nodeKey);
    const plain = await build({ seats: seatsFromProfile(profile) });
    expect(plain.charts.union.nodes.find((node) => node.nodeKind === "role")).not.toHaveProperty("badge");
  });

  it("caps rows and seats at 500 items", async () => {
    const rows = Array.from({ length: MAX_ITEMS + 5 }, (_, index) => newOwnRow(`Chapter ${index}`, "office", `row-${index}`));
    const payload = await buildSetupPayload({
      organizationId: ORG_A, organizationName: "Example", rows, attestation,
      seats: [{ key: "s", seatClass: "officer", title: "President" }],
    });
    expect(payload.charts.union.nodes).toHaveLength(MAX_ITEMS + 1);
    expect(payload.charts.union.nodes.some((node) => node.nodeKind === "role")).toBe(false);
  });

  it("defaults the supplied-on date to today in Eastern time", async () => {
    const payload = await buildSetupPayload({ organizationId: ORG_A, organizationName: "Example", rows: [], attestation: {} });
    expect(payload.attestation.suppliedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.attestation.suppliedBy).toBe("");
    // 03:30 UTC on the 26th is still the 25th in Eastern time.
    expect(easternDate(new Date("2026-09-26T03:30:00Z"))).toBe("2026-09-25");
  });
});

describe("row and attestation checks", () => {
  it("flags an over-long name without truncating it", () => {
    const long = "L".repeat(121);
    const rows = [newOwnRow(long, "chapter", "a"), newOwnRow("C".repeat(150), "council", "b"), newOwnRow("  ", "office", "c")];
    expect(rowIssues(rows)).toEqual({ a: ["needsShorterName"], c: ["emptyName"] });
    expect(rows[0].name).toBe(long);
  });

  it("flags duplicates within the list and against existing chapters, ignoring case", () => {
    const rows = [newOwnRow("Harbor", "chapter", "a"), newOwnRow("harbor ", "office", "b"), newOwnRow("Main Chapter", "chapter", "c")];
    expect(rowIssues(rows, ["MAIN CHAPTER"])).toEqual({ a: ["duplicateName"], b: ["duplicateName"], c: ["duplicateName"] });
  });

  it("requires suppliedBy 1-160 and authority 1-240", () => {
    expect(attestationIssues({ suppliedBy: "A", authority: "B" })).toEqual([]);
    expect(attestationIssues({ suppliedBy: "", authority: "x".repeat(241) })).toEqual(["suppliedBy", "authority"]);
    expect(attestationIssues(null)).toEqual(["suppliedBy", "authority"]);
  });

  it("points an import error path back at its row", async () => {
    const rows = [newOwnRow("Council", "council", "a"), newOwnRow("Chapter", "chapter", "b")];
    const payload = await buildSetupPayload({ organizationId: ORG_A, organizationName: "Example", rows, attestation });
    expect(rowForErrorPath("chapters[0].chapterKey", rows, payload)?.id).toBe("b");
    expect(rowForErrorPath("charts.union.nodes[1].label", rows, payload)?.id).toBe("a");
    expect(rowForErrorPath("charts.union.nodes[0].label", rows, payload)).toBeNull();
    expect(rowForErrorPath("chapters[9].name", rows, payload)).toBeNull();
    expect(rowForErrorPath("attestation.authority", rows, payload)).toBeNull();
    expect(rowForErrorPath(undefined, rows, payload)).toBeNull();
  });
});

describe("setup catalog reads", () => {
  function client(respond) {
    const calls = [];
    return { calls, async rpc(name, args) { calls.push([name, args]); return respond(name, args); } };
  }

  it("keeps the catalog key pattern and missing-RPC codes", () => {
    expect(CATALOG_KEY_PATTERN.test("olms-900000001")).toBe(true);
    expect(CATALOG_KEY_PATTERN.test("ug-examplex01")).toBe(true);
    expect(CATALOG_KEY_PATTERN.test("11111111-2222-4333-8444-555555555555")).toBe(false);
    expect(isMissingRpcError({ code: "PGRST202" })).toBe(true);
    expect(isMissingRpcError({ code: "42883" })).toBe(true);
    expect(isMissingRpcError({ code: "42501", message: "PGRST202" })).toBe(false);
    expect(isMissingRpcError(null)).toBe(false);
  });

  it("probes status with its release label, and reads every failure as unavailable", async () => {
    expect(await probeSetupCatalog(client(() => ({ data: { available: true, releaseLabel: "20260924-01", dataAsOf: "2026-09-24" }, error: null }))))
      .toEqual({ catalog: "live", status: { releaseLabel: "20260924-01", dataAsOf: "2026-09-24" } });
    expect((await probeSetupCatalog(client(() => ({ data: { available: false }, error: null })))).catalog).toBe("unavailable");
    expect((await probeSetupCatalog(client(() => ({ data: null, error: { code: "PGRST202" } })))).catalog).toBe("unavailable");
    expect((await probeSetupCatalog({ rpc: () => Promise.reject(new Error("offline")) })).catalog).toBe("unavailable");
  });

  it("searches the catalog RPC and keeps catalog keys only", async () => {
    const fake = client(() => ({
      data: { rows: [
        { key: "olms-900000001", name: "Example Workers Local 1", city: "Springfield", state: "MA" },
        { key: "11111111-2222-4333-8444-555555555555", name: "Registry only", registryOnly: true },
        { key: "olms-900000002", name: "   ", state: "zz" },
        { key: "olms-900000003", name: "Example Workers Local 3", state: "zz" },
        null,
      ] },
      error: null,
    }));
    expect(await searchCatalogKeys(fake, "Example")).toEqual([
      { key: "olms-900000001", name: "Example Workers Local 1", city: "Springfield", state: "MA" },
      { key: "olms-900000003", name: "Example Workers Local 3", city: null, state: null },
    ]);
    expect(fake.calls).toEqual([["search_union_catalog", { p_query: "Example", p_state: null, p_family: null, p_tier: null, p_page: 1 }]]);
    await expect(searchCatalogKeys(client(() => ({ data: null, error: { code: "57014", message: "timeout" } })), "Example"))
      .rejects.toMatchObject({ name: "MemberApiError", code: "57014" });
    expect(await searchCatalogKeys(client(() => ({ data: {}, error: null })), "Example")).toEqual([]);
  });

  it("loads a profile by key and normalizes only what setup may use", async () => {
    const fake = client(() => ({ data: rawProfile(), error: null }));
    const profile = await loadSetupProfile(fake, "olms-900000001");
    expect(fake.calls[0]).toEqual(["get_union_catalog_profile", { p_key: "olms-900000001" }]);
    expect(Object.keys(profile).sort()).toEqual(["children", "childrenTotal", "documents", "found", "organization", "seats", "starter", "subunits", "subunitsCapped"]);
    expect(profile.documents).toEqual([{ key: "doc-1", title: `Bylaws ${SENTINEL_EMAIL}`, href: "https://docs.example.invalid/bylaws.pdf", host: "docs.example.invalid" }]);
    expect(profile.subunitsCapped).toBe(false);
    await expect(loadSetupProfile(client(() => ({ data: null, error: { code: "22023", message: "invalid catalog key" } })), "x"))
      .rejects.toMatchObject({ code: "22023" });
  });

  it("drops malformed profile parts and reports a capped sub-unit list", () => {
    expect(normalizeSetupProfile(null)).toEqual({ found: false });
    expect(normalizeSetupProfile({ found: true })).toEqual({ found: false });
    const capped = normalizeSetupProfile(rawProfile({
      subunits: [...Array.from({ length: 499 }, (_, index) => ({ key: `s${index}`, name: `Unit ${index}`, kind: "weird" })), null, { key: "blank", name: "" }],
      seatOutlines: [null, { key: "x", seatClass: "officer", title: "" }, { key: "y", seatClass: "chair", title: "Chair" }],
      documents: [null, { key: "d", url: "https://" }, { key: "e", url: 42 }, { key: "f", url: "https://docs.example.invalid/f", title: "" }],
      childrenTotal: "3",
    }));
    expect(capped.subunits).toHaveLength(499);
    expect(capped.subunits[0].kind).toBe("other");
    expect(capped.subunitsCapped).toBe(true);
    expect(capped.seats).toEqual([]);
    expect(capped.documents).toEqual([{ key: "f", title: "docs.example.invalid", href: "https://docs.example.invalid/f", host: "docs.example.invalid" }]);
    expect(capped.childrenTotal).toBe(0);
  });

  it("formats plain dates without a day shift", () => {
    expect(formatCatalogDate("2026-09-24", "en")).toContain("24");
    expect(formatCatalogDate("not a date", "en")).toBe("");
  });
});

// Review of  (lane uc-4a-ui-review): one regression test per repaired finding.
describe("setup payload review repairs", () => {
  function client(respond) {
    return { async rpc(name, args) { return respond(name, args); } };
  }

  it("makes no chapter key without an organization id", async () => {
    await expect(chapterKeyFor(null, "Example Workers Local 1", "row-1")).rejects.toThrow(/organization id/);
    await expect(buildSetupPayload({ organizationId: null, organizationName: "Example Workers Local 1", rows: [newOwnRow("Example Workers Chapter", "chapter", "row-1")], attestation })).rejects.toThrow();
  });

  it("counts name length in characters, as the database does", () => {
    const astral = "\u{1F3ED}".repeat(70);
    expect(rowIssues([newOwnRow(astral, "chapter", "a")])).toEqual({});
    expect(attestationIssues({ suppliedBy: "\u{1F3ED}".repeat(160), authority: "\u{1F3ED}".repeat(240) })).toEqual([]);
  });

  it("reads a live catalog with no release label as unavailable", async () => {
    expect((await probeSetupCatalog(client(() => ({ data: { available: true, dataAsOf: "2026-09-24" }, error: null })))).catalog).toBe("unavailable");
  });

  it("pins every length limit at its boundary", () => {
    expect(rowIssues([newOwnRow("x".repeat(120), "chapter", "a")])).toEqual({});
    expect(rowIssues([newOwnRow("x".repeat(160), "council", "a")])).toEqual({});
    expect(rowIssues([newOwnRow("x".repeat(161), "council", "a")])).toEqual({ a: ["needsShorterName"] });
    expect(attestationIssues({ suppliedBy: "x".repeat(160), authority: "x".repeat(240) })).toEqual([]);
    expect(attestationIssues({ suppliedBy: "x".repeat(161), authority: "x".repeat(241) })).toEqual(["suppliedBy", "authority"]);
    const profile = normalizeSetupProfile(rawProfile({ subunits: [
      { key: "sub-long", parentKey: null, kind: "chapter", name: "x".repeat(401) },
      { key: "sub-ok", parentKey: null, kind: "chapter", name: "x".repeat(400) },
    ] }));
    expect(profile.subunits.map((item) => item.key)).toEqual(["sub-ok"]);
  });

  it("names a source only when it has a date", async () => {
    const payload = await buildSetupPayload({
      organizationId: ORG_A, organizationName: "Example Workers Local 1", rows: [newOwnRow("Example Workers Chapter", "chapter", "a")], attestation,
      source: { releaseLabel: "20260924-01", catalogKey: "olms-900000001", dataAsOf: null },
    });
    expect(payload.sources).toBeUndefined();
  });

  it("gives seat nodes sort orders after every row", async () => {
    const profile = normalizeSetupProfile(rawProfile());
    const payload = await buildSetupPayload({
      organizationId: ORG_A, organizationName: "Example Workers Local 1", rows: rowsFromProfile(profile), seats: seatsFromProfile(profile), attestation,
    });
    const orders = payload.charts.union.nodes.map((node) => node.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

// REQ-UG-CATALOG-ORGANIZATION-NAMES-OVER-200-CHARACTERS-20261114:
// setup reads catalog organization and child names of up to 1,000 characters.
describe("long catalog organization names in setup", () => {
  const long = (n, lead = "Sindicato Nacional de Trabajadores de Ejemplo") => `${lead.padEnd(n - 1, " de la Industria Ejemplar").slice(0, n - 1)}x`;

  it("keeps an organization and its child listings of up to 1,000 characters, and drops a longer child", () => {
    const profile = normalizeSetupProfile(rawProfile({
      organization: { key: "olms-900000001", name: long(622) },
      children: [
        { key: "olms-900000009", name: long(1000, "Sample Transit Council") },
        { key: "olms-900000010", name: long(1001, "Sample Port Council") },
        { key: "olms-900000011", name: long(201, "Sample Rail Council") },
      ],
    }));
    expect(profile.organization.name).toBe(long(622));
    expect(profile.children.map((child) => child.key)).toEqual(["olms-900000009", "olms-900000011"]);
    expect(profile.children[0].name).toBe(long(1000, "Sample Transit Council"));
    expect(normalizeSetupProfile(rawProfile({ organization: { key: "olms-900000001", name: long(1001) } })).organization.name).toBe("");
  });
});
