// @vitest-environment node
//
// REQ-UG-UNION-CATALOG-PROFILE-DEPTH-20260924: the pure helpers behind the
// catalog-first /unions search and the profile panel. Routing decides which
// searches may reach the RPC at all, every argument object carries all five
// keys, only PGRST202 and 42883 mean "migration pending", and the profile
// normalizer allow-lists every field a signed-out visitor can see.
import { describe, expect, it } from "vitest";
import {
  CATALOG_KEY_PATTERN,
  CATALOG_ORGANIZATION_NAME_MAX,
  catalogPageCount,
  catalogSearchPlan,
  cleanCatalogQuery,
  dateOnly,
  formatCatalogDate,
  isMissingRpcError,
  loadCatalogProfile,
  normalizeCatalogProfile,
  normalizeCatalogRow,
  probeCatalogStatus,
  searchCatalog,
} from "../src/features/unionCatalog/catalogSearch.js";

function rpcClient(respond) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push([name, args]);
      return respond(name, args);
    },
  };
}

const catalogRow = (overrides = {}) => ({
  key: "olms-900000001",
  registryOnly: false,
  name: "Example Workers 1",
  family: "EXW",
  designation: "LU",
  localNumber: "1",
  tier: "local",
  level: "local",
  city: "Springfield",
  state: "MA",
  website: "https://www.example.invalid/local-1",
  membersReported: 1234,
  membersFiscalYear: 2024,
  registryId: "olms-900000001",
  ...overrides,
});

describe("catalogSearchPlan", () => {
  it.each([
    ["two-character query", "ab", {}, "catalog"],
    ["eighty-character query", "a".repeat(80), {}, "catalog"],
    ["state alone", "", { state: "MA" }, "catalog"],
    ["state with a one-character query", "7", { state: "MA" }, "registry"],
    ["bare one-character local number", "7", {}, "registry"],
    ["eighty-one characters", "a".repeat(81), {}, "registry"],
    ["eighty-one characters with a state", "a".repeat(81), { state: "MA" }, "catalog"],
    ["family alone", "", { affiliation: "USW" }, "registry"],
    ["level filter", "steel", { level: "local" }, "registry"],
    ["level with state", "", { state: "MA", level: "local" }, "registry"],
    ["empty query, no filter", "", {}, "registry"],
  ])("routes %s to the %s", (_label, query, filters, expectedSource) => {
    expect(catalogSearchPlan(query, filters, 0, "live").source).toBe(expectedSource);
  });

  it("uses the registry while the catalog is probing or has fallen back", () => {
    expect(catalogSearchPlan("steel", {}, 0, "probing").source).toBe("registry");
    expect(catalogSearchPlan("steel", {}, 0, "fallback").source).toBe("registry");
    expect(catalogSearchPlan("steel", {}, 0, "fallback").args).toBeNull();
  });

  it("always sends all five keys, with nulls for unused ones", () => {
    expect(catalogSearchPlan("steel", {}, 0).args).toEqual({
      p_query: "steel", p_state: null, p_family: null, p_tier: null, p_page: 1,
    });
    expect(catalogSearchPlan("", { state: "MA", affiliation: "USW" }, 3).args).toEqual({
      p_query: null, p_state: "MA", p_family: "USW", p_tier: null, p_page: 4,
    });
  });

  it("sends an over-long query as null when a state carries the search", () => {
    expect(catalogSearchPlan("a".repeat(81), { state: "MA" }).args.p_query).toBeNull();
  });

  it("drops unknown states and families before they reach the RPC", () => {
    expect(catalogSearchPlan("steel", { state: "zz", affiliation: "NOPE" }).args).toEqual({
      p_query: "steel", p_state: null, p_family: null, p_tier: null, p_page: 1,
    });
  });

  it("strips control characters, collapses whitespace and pages from one", () => {
    expect(cleanCatalogQuery("  steel\u0000  workers\t\n east ")).toBe("steel workers east");
    const plan = catalogSearchPlan("  steel\u0000  workers ", {}, 39);
    expect(plan.query).toBe("steel workers");
    expect(plan.args.p_page).toBe(40);
    expect(catalogSearchPlan("steel", {}, 40).args.p_page).toBe(1);
    expect(catalogSearchPlan("steel", {}, -1).args.p_page).toBe(1);
    expect(catalogSearchPlan("steel", {}, 1.5).args.p_page).toBe(1);
  });
});

describe("CATALOG_KEY_PATTERN", () => {
  it.each([
    ["olms-1", true],
    ["olms-900000001", true],
    ["olms-123456789", true],
    ["olms-1234567890", false],
    ["ug-abc123def4", true],
    ["ug-ABC123DEF4", false],
    ["ug-abc123", false],
    ["test-1", false],
    ["olms-1; drop", false],
    ["", false],
  ])("judges %j as %s", (key, expected) => {
    expect(CATALOG_KEY_PATTERN.test(key)).toBe(expected);
  });
});

describe("isMissingRpcError", () => {
  it("treats PGRST202 and 42883 as missing, never a bounds error, a policy error or an outage", () => {
    expect(isMissingRpcError({ code: "PGRST202", message: "Could not find the function" })).toBe(true);
    expect(isMissingRpcError({ code: "42883", message: "does not exist" })).toBe(true);
    expect(isMissingRpcError({ code: "22023", message: "function does not exist" })).toBe(false);
    expect(isMissingRpcError({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingRpcError(new TypeError("fetch failed"))).toBe(false);
    expect(isMissingRpcError(null)).toBe(false);
  });
});

describe("catalogPageCount", () => {
  it("counts pages of twenty-five, capped at forty", () => {
    expect(catalogPageCount(25)).toBe(1);
    expect(catalogPageCount(26)).toBe(2);
    expect(catalogPageCount(1000)).toBe(40);
    expect(catalogPageCount(5000)).toBe(40);
    expect(catalogPageCount(0)).toBe(0);
    expect(catalogPageCount("x")).toBe(0);
  });
});

describe("normalizeCatalogRow", () => {
  it("maps a camelCase RPC row onto the Phase 1 row shape", () => {
    expect(normalizeCatalogRow(catalogRow({ parentName: "Example Workers International" }))).toEqual({
      id: "olms-900000001",
      key: "olms-900000001",
      registryOnly: false,
      name: "Example Workers 1",
      affiliation: "EXW",
      designation: "LU",
      localNumber: "1",
      level: "local",
      city: "Springfield",
      state: "MA",
      website: { href: "https://www.example.invalid/local-1", host: "example.invalid" },
      membersLatest: 1234,
      membersYear: 2024,
      parentName: "Example Workers International",
    });
  });

  it("nulls the 00 sentinel and non-state values, unpaired members and non-http websites", () => {
    const row = normalizeCatalogRow(catalogRow({
      registryOnly: true, state: "00", membersReported: 12, membersFiscalYear: null, website: "ftp://x.example", level: "weird",
    }));
    expect(row.registryOnly).toBe(true);
    expect(row.state).toBeNull();
    expect(row.membersLatest).toBeNull();
    expect(row.membersYear).toBeNull();
    expect(row.website).toBeNull();
    expect(row.level).toBe("unknown");
    expect(row.parentName).toBeNull();
    expect(normalizeCatalogRow(catalogRow({ state: null })).state).toBeNull();
  });

  it("drops malformed rows", () => {
    expect(normalizeCatalogRow(null)).toBeNull();
    expect(normalizeCatalogRow("row")).toBeNull();
    expect(normalizeCatalogRow(catalogRow({ key: 12 }))).toBeNull();
    expect(normalizeCatalogRow(catalogRow({ name: null }))).toBeNull();
    expect(normalizeCatalogRow(catalogRow({ name: " \u0007 " }))).toBeNull();
  });
});

describe("normalizeCatalogProfile", () => {
  const profile = () => ({
    found: true,
    organization: {
      key: "olms-900000001",
      name: "Example Workers 1",
      family: "EXW",
      designation: "LU",
      localNumber: "1",
      level: "local",
      city: "Springfield",
      state: "MA",
      website: "https://www.example.invalid/",
      membersReported: 1234,
      membersFiscalYear: 2024,
      structureNote: "never rendered",
      confidence: "official_site",
      researchedOn: "2026-09-20",
      sourceUrls: [
        "https://www.example.invalid/about",
        "http://example.invalid/about",
        "https://www.example.invalid/about",
        "javascript:alert(1)",
        "https://user:pw@example.invalid/x",
      ],
    },
    parents: [
      { depth: 1, childKey: "olms-900000001", parentKey: "olms-900000002", parentName: "Example Workers Council", parentLabel: null, edgeKind: "parent_body", certainty: "filed", sourceUrl: "https://example.invalid/p" },
      { depth: 1, childKey: "olms-900000001", parentKey: null, parentName: null, parentLabel: "Example State Federation", edgeKind: "state_federation", certainty: "inferred" },
      { depth: 2, childKey: "olms-900000002", parentKey: "olms-900000003", parentName: null, parentLabel: null, edgeKind: "olms_parent", certainty: "guessed" },
    ],
    children: [{ key: "olms-900000009", name: "Example Workers Unit 9" }],
    subunits: [
      { key: "olms-900000001~unit-0123456789ab", kind: "unit", kindLabel: "Unit", name: "Example Unit A", location: "Somewhere", employer: "Example Employer", members: 40, website: "https://example.invalid/u" },
      { key: "olms-900000001~other-0123456789ab", kind: "other", kindLabel: "Caucus", name: null },
      { key: "olms-900000001~odd-0123456789ab", kind: "squad", kindLabel: null, name: "Odd" },
      { kind: "unit", name: "no key" },
    ],
    seatOutlines: [
      { key: "seat-1", subunitKey: null, seatClass: "officer", title: "President", listed: 1, vacant: 0, sourceUrl: "https://example.invalid/s" },
      { key: "seat-2", subunitKey: null, seatClass: "chair", title: null, listed: "3", vacant: -1 },
    ],
    contacts: [
      { kind: "website", value: "https://www.example.invalid/", label: null, basis: "own_site" },
      { kind: "social", value: "not a url", basis: "own_site" },
      { kind: "email", value: "office@example.invalid", basis: "own_site" },
      { kind: "phone", value: "555-0100", basis: "own_site" },
      { kind: "office_address", value: "1 Example Way, Springfield MA", basis: "own_site" },
      { kind: "fax", value: "555-0101" },
      { kind: "email", value: "" },
    ],
    documents: [
      { key: "olms-900000001~0123456789abcdef", kind: "contract", title: "Example agreement", url: "https://docs.example.invalid/agreement.pdf", urlHost: "docs.example.invalid", asOf: "2026-01-15" },
      { key: "olms-900000001~0123456789abcdee", kind: "bylaws", title: null, url: "http://docs.example.invalid/bylaws.pdf", asOf: "bad" },
      { key: "olms-900000001~0123456789abcded", kind: "poster", title: "Odd", url: "https://docs.example.invalid/odd" },
      { kind: "form" },
    ],
    coverage: {
      band: "structured",
      checklist: { website: true, publicContact: true, structure: true, seats: true, governingDocument: false, contract: true, electionCadence: false, hierarchy: "yes" },
      subunits: 2,
      demandBand: null,
      communityVerifiedOn: null,
      lastResearched: "2026-09-21",
    },
  });

  it("returns found:false for anything that is not a found profile", () => {
    expect(normalizeCatalogProfile({ found: false })).toEqual({ found: false });
    expect(normalizeCatalogProfile(null)).toEqual({ found: false });
    expect(normalizeCatalogProfile({ found: true })).toEqual({ found: false });
  });

  it("allow-lists the organization facts and keeps https sources only, deduplicated", () => {
    const result = normalizeCatalogProfile(profile());
    expect(result.found).toBe(true);
    expect(result.organization).toEqual({
      key: "olms-900000001",
      name: "Example Workers 1",
      affiliation: "EXW",
      designation: "LU",
      localNumber: "1",
      level: "local",
      city: "Springfield",
      state: "MA",
      website: { href: "https://www.example.invalid/", host: "example.invalid" },
      membersLatest: 1234,
      membersYear: 2024,
      confidence: "official_site",
      researchedOn: "2026-09-20",
    });
    expect(result.organization).not.toHaveProperty("structureNote");
    expect(result.children).toEqual([{ key: "olms-900000009", name: "Example Workers Unit 9", edgeKind: null, certainty: null }]);
    expect(result.childrenTotal).toBe(1);
    expect(result.sources).toEqual([
      { href: "https://www.example.invalid/about", host: "example.invalid" },
      { href: "http://example.invalid/about", host: "example.invalid" },
    ]);
  });

  it("keeps parents as a list with certainty markers and links only catalog keys", () => {
    const { parents } = normalizeCatalogProfile(profile());
    expect(parents).toEqual([
      { key: "olms-900000002", parentKey: "olms-900000002", parentName: "Example Workers Council", parentLabel: null, certainty: "filed" },
      { key: "label:Example State Federation#1", parentKey: null, parentName: null, parentLabel: "Example State Federation", certainty: "inferred" },
      { key: "olms-900000003", parentKey: "olms-900000003", parentName: null, parentLabel: null, certainty: null },
    ]);
  });

  it("allow-lists child organization identity and provenance without person or tenant fields", () => {
    const data = profile();
    data.children = [
      { key: "olms-9", name: "Example Local", edgeKind: "state_federation", certainty: "inferred", members: 50, tenantId: "secret", officers: [{ name: "Private Person" }] },
      { key: "olms-9", name: "Duplicate", edgeKind: "state_federation", certainty: "inferred" },
      { key: "bad-key", name: "Invalid" },
      { key: "ug-aaaaaaaaaa", name: null, edgeKind: "unrecognized", certainty: "unverified" },
    ];
    data.childrenTotal = 502;
    const result = normalizeCatalogProfile(data);
    expect(result.children).toEqual([
      { key: "olms-9", name: "Example Local", edgeKind: "state_federation", certainty: "inferred" },
      { key: "ug-aaaaaaaaaa", name: null, edgeKind: null, certainty: null },
    ]);
    expect(result.childrenTotal).toBe(502);
    expect(JSON.stringify(result.children)).not.toMatch(/Private Person|secret|members|tenantId|officers/);
    data.children = Array.from({ length: 501 }, (_, index) => ({ key: `olms-${index}`, name: `Example ${index}` }));
    expect(normalizeCatalogProfile(data).children).toHaveLength(500);
  });

  it("keeps sub-unit names and kinds only, with scrubbed nulls and unknown kinds preserved as null", () => {
    const { subunits } = normalizeCatalogProfile(profile());
    expect(subunits).toEqual([
      { key: "olms-900000001~unit-0123456789ab", name: "Example Unit A", kind: "unit", kindLabel: "Unit" },
      { key: "olms-900000001~other-0123456789ab", name: null, kind: "other", kindLabel: "Caucus" },
      { key: "olms-900000001~odd-0123456789ab", name: "Odd", kind: null, kindLabel: null },
    ]);
    for (const subunit of subunits) {
      expect(subunit).not.toHaveProperty("location");
      expect(subunit).not.toHaveProperty("employer");
      expect(subunit).not.toHaveProperty("members");
      expect(subunit).not.toHaveProperty("website");
    }
  });

  it("keeps seat titles and counts with no holder, and rejects unknown classes", () => {
    const { seats } = normalizeCatalogProfile(profile());
    expect(seats).toEqual([
      { key: "seat-1", title: "President", seatClass: "officer", listed: 1, vacant: 0 },
      { key: "seat-2", title: null, seatClass: null, listed: 0, vacant: 0 },
    ]);
  });

  it("links website and social contacts through the host rule and keeps the rest as text", () => {
    const { contacts } = normalizeCatalogProfile(profile());
    expect(contacts).toEqual([
      { key: "website-0", kind: "website", value: "https://www.example.invalid/", link: { href: "https://www.example.invalid/", host: "example.invalid" } },
      { key: "social-1", kind: "social", value: "not a url", link: null },
      { key: "email-2", kind: "email", value: "office@example.invalid", link: null },
      { key: "phone-3", kind: "phone", value: "555-0100", link: null },
      { key: "office_address-4", kind: "office_address", value: "1 Example Way, Springfield MA", link: null },
    ]);
  });

  it("links documents over https only and keeps as-of dates that parse", () => {
    const { documents } = normalizeCatalogProfile(profile());
    expect(documents).toEqual([
      { key: "olms-900000001~0123456789abcdef", kind: "contract", title: "Example agreement", link: { href: "https://docs.example.invalid/agreement.pdf", host: "docs.example.invalid" }, asOf: "2026-01-15" },
      { key: "olms-900000001~0123456789abcdee", kind: "bylaws", title: null, link: null, asOf: null },
      { key: "olms-900000001~0123456789abcded", kind: null, title: "Odd", link: { href: "https://docs.example.invalid/odd", host: "docs.example.invalid" }, asOf: null },
    ]);
  });

  // REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110: a members-only
  // answer keeps every document, with no link even if one arrives, and an
  // answer from before the rule (no documentLinks field) keeps its links.
  it("keeps link-less documents and links none in a members-only answer", () => {
    expect(normalizeCatalogProfile(profile()).documentLinks).toBe("included");
    expect(normalizeCatalogProfile({ ...profile(), documentLinks: "included" }).documentLinks).toBe("included");
    expect(normalizeCatalogProfile({ ...profile(), documentLinks: "anything" }).documentLinks).toBe("included");
    const visitor = normalizeCatalogProfile({
      ...profile(),
      documentLinks: "members",
      documents: profile().documents.map((document) => ({ ...document, url: null, urlHost: null })),
    });
    expect(visitor.documentLinks).toBe("members");
    expect(visitor.documents).toEqual([
      { key: "olms-900000001~0123456789abcdef", kind: "contract", title: "Example agreement", link: null, asOf: "2026-01-15" },
      { key: "olms-900000001~0123456789abcdee", kind: "bylaws", title: null, link: null, asOf: null },
      { key: "olms-900000001~0123456789abcded", kind: null, title: "Odd", link: null, asOf: null },
    ]);
    const stray = normalizeCatalogProfile({ ...profile(), documentLinks: "members" });
    expect(stray.documents.map((document) => document.link)).toEqual([null, null, null]);
  });

  it("reads the eight checklist items as booleans in spec order and tolerates a null coverage", () => {
    const { coverage } = normalizeCatalogProfile(profile());
    expect(coverage).toEqual({
      band: "structured",
      checklist: { website: true, publicContact: true, structure: true, seats: true, governingDocument: false, contract: true, electionCadence: false, hierarchy: false },
      lastResearched: "2026-09-21",
    });
    expect(normalizeCatalogProfile({ ...profile(), coverage: null }).coverage).toBeNull();
    expect(normalizeCatalogProfile({ ...profile(), coverage: { band: "epic", checklist: null } }).coverage.band).toBeNull();
  });

  it("tolerates missing collections", () => {
    const result = normalizeCatalogProfile({ found: true, organization: { name: "Example Workers 2" } });
    expect(result.parents).toEqual([]);
    expect(result.subunits).toEqual([]);
    expect(result.seats).toEqual([]);
    expect(result.contacts).toEqual([]);
    expect(result.documents).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.coverage).toBeNull();
    expect(result.organization.key).toBeNull();
    expect(result.organization.confidence).toBeNull();
  });
});

describe("dates", () => {
  it("accepts only plain calendar dates", () => {
    expect(dateOnly("2026-09-24")).toBe("2026-09-24");
    expect(dateOnly("2026-09-24T00:00:00Z")).toBeNull();
    expect(dateOnly(20260924)).toBeNull();
  });

  it("formats a plain date without shifting the day, in the visitor's locale", () => {
    expect(formatCatalogDate("2026-09-24", "en")).toBe("Sep 24, 2026");
    expect(formatCatalogDate("2026-01-01", "en")).toBe("Jan 1, 2026");
    expect(formatCatalogDate("2026-09-24", "es")).toBe("24 sept 2026");
    expect(formatCatalogDate(null, "en")).toBe("");
    expect(formatCatalogDate("yesterday", "en")).toBe("");
  });
});

describe("RPC wrappers", () => {
  it("probes the status once with no arguments and reads available:true as live", async () => {
    const client = rpcClient(() => ({ data: { available: true, releaseLabel: "20260924-01", releasedOn: "2026-09-25", dataAsOf: "2026-09-24", counts: {} }, error: null }));
    await expect(probeCatalogStatus(client)).resolves.toEqual({ catalog: "live", status: { dataAsOf: "2026-09-24", releasedOn: "2026-09-25", releaseLabel: "20260924-01" } });
    expect(client.calls).toEqual([["get_union_catalog_status", undefined]]);
  });

  it("falls back on a missing function, an inactive catalog, any other error and a thrown outage", async () => {
    const fallback = { catalog: "fallback", status: null };
    await expect(probeCatalogStatus(rpcClient(() => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } })))).resolves.toEqual(fallback);
    await expect(probeCatalogStatus(rpcClient(() => ({ data: { available: false, releaseLabel: null, releasedOn: null, dataAsOf: null, counts: null }, error: null })))).resolves.toEqual(fallback);
    await expect(probeCatalogStatus(rpcClient(() => ({ data: null, error: { code: "500", message: "boom" } })))).resolves.toEqual(fallback);
    await expect(probeCatalogStatus(rpcClient(() => { throw new TypeError("fetch failed"); }))).resolves.toEqual(fallback);
  });

  it("searches with the exact argument object and normalizes the envelope", async () => {
    const client = rpcClient(() => ({
      data: { rows: [catalogRow(), { bad: true }], page: 1, pageSize: 25, total: 1000, totalCapped: true, hasNext: true },
      error: null,
    }));
    const args = { p_query: "example", p_state: null, p_family: null, p_tier: null, p_page: 1 };
    const result = await searchCatalog(client, args);
    expect(client.calls).toEqual([["search_union_catalog", args]]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].key).toBe("olms-900000001");
    expect(result).toMatchObject({ total: 1000, totalCapped: true, hasNext: true });
  });

  it("falls back to the row count and false flags when the envelope is thin", async () => {
    const result = await searchCatalog(rpcClient(() => ({ data: { rows: [catalogRow()] }, error: null })));
    expect(result).toMatchObject({ total: 1, totalCapped: false, hasNext: false });
    const empty = await searchCatalog(rpcClient(() => ({ data: null, error: null })));
    expect(empty).toEqual({ rows: [], total: 0, totalCapped: false, hasNext: false });
  });

  it("throws a MemberApiError that keeps the PostgREST code", async () => {
    const client = rpcClient(() => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.search_union_catalog" } }));
    const error = await searchCatalog(client, {}).catch((caught) => caught);
    expect(error.name).toBe("MemberApiError");
    expect(error.code).toBe("PGRST202");
    expect(isMissingRpcError(error)).toBe(true);
  });

  it("loads a profile by key and normalizes it", async () => {
    const client = rpcClient(() => ({ data: { found: true, organization: { key: "olms-900000001", name: "Example Workers 1" } }, error: null }));
    const profile = await loadCatalogProfile(client, "olms-900000001");
    expect(client.calls).toEqual([["get_union_catalog_profile", { p_key: "olms-900000001" }]]);
    expect(profile.found).toBe(true);
    expect(profile.organization.name).toBe("Example Workers 1");
    await expect(loadCatalogProfile(rpcClient(() => ({ data: { found: false }, error: null })), "olms-900000002")).resolves.toEqual({ found: false });
    const failure = await loadCatalogProfile(rpcClient(() => ({ data: null, error: { code: "22023", message: "invalid catalog key" } })), "olms-1").catch((caught) => caught);
    expect(failure.name).toBe("MemberApiError");
    expect(isMissingRpcError(failure)).toBe(false);
  });
});

// Review repairs on PR #3397 (findings F1, F3, F19, F20).
describe("review repairs", () => {
  it("(F1) lists each catalog parent once, keeping the first (nearest), and never merges label-only parents", () => {
    const { parents } = normalizeCatalogProfile({
      found: true,
      organization: { key: "olms-900000001", name: "Example Workers 1" },
      parents: [
        { depth: 1, parentKey: "olms-900000003", parentName: "Example Workers Council 3", parentLabel: null, certainty: "filed" },
        { depth: 1, parentKey: "olms-900000002", parentName: "Example Workers International", parentLabel: null, certainty: "inferred" },
        { depth: 2, parentKey: "olms-900000002", parentName: "Example Workers International", parentLabel: null, certainty: "filed" },
        { depth: 1, parentKey: null, parentName: null, parentLabel: "Example State Federation", certainty: "inferred" },
        { depth: 2, parentKey: null, parentName: null, parentLabel: "Example State Federation", certainty: "split" },
      ],
    });
    expect(parents.map((parent) => [parent.key, parent.certainty])).toEqual([
      ["olms-900000003", "filed"],
      ["olms-900000002", "inferred"],
      ["label:Example State Federation#3", "inferred"],
      ["label:Example State Federation#4", "split"],
    ]);
    expect(new Set(parents.map((parent) => parent.key)).size).toBe(parents.length);
  });

  it.each([
    ["a lone astral character", "\u{1F600}", {}, "registry"],
    ["a lone astral character with a state", "\u{1F600}", { state: "MA" }, "registry"],
    ["two astral characters", "\u{1F600}\u{1F600}", {}, "catalog"],
    ["eighty astral characters", "\u{1F600}".repeat(80), {}, "catalog"],
    ["eighty-one astral characters", "\u{1F600}".repeat(81), {}, "registry"],
  ])("(F3) counts code points: routes %s correctly", (_label, query, filters, expected) => {
    expect(catalogSearchPlan(query, filters, 0, "live").source).toBe(expected);
  });

  it("(F3) sends an eighty-code-point astral query as the query itself", () => {
    const query = "\u{1F600}".repeat(80);
    expect(catalogSearchPlan(query, {}, 0, "live").args.p_query).toBe(query);
  });

  it.each([
    ["olms-", false],
    ["olms-abc", false],
    ["olms-12a", false],
    ["ug-abc123de", false],
    ["ug-abc123d", false],
    ["ug-abc123def45", false],
    ["ug-abc123-ef4", false],
    ["OLMS-1", false],
    [" olms-1", false],
    ["olms-1 ", false],
    ["olms-1\n", false],
    ["ug-0000000000", true],
    ["ug-zzzzzzzzzz", true],
    ["olms-0", true],
    ["olms-999999999", true],
  ])("(F19) CATALOG_KEY_PATTERN judges boundary %j as %s", (key, expected) => {
    expect(CATALOG_KEY_PATTERN.test(key)).toBe(expected);
  });

  it("(F20) a profile needs found === true, and parent keys must be catalog keys to link", () => {
    expect(normalizeCatalogProfile({ found: false, organization: { name: "Example Workers 3" } })).toEqual({ found: false });
    expect(normalizeCatalogProfile({ found: "true", organization: { name: "Example Workers 3" } })).toEqual({ found: false });
    const { parents } = normalizeCatalogProfile({
      found: true,
      organization: { name: "Example Workers 3" },
      parents: [{ parentKey: "olms-x", parentName: "Example Workers 4", certainty: "filed" }],
    });
    expect(parents[0].parentKey).toBeNull();
  });
});

// REQ-UG-CATALOG-ORGANIZATION-NAMES-OVER-200-CHARACTERS-20261114 (#8743):
// the catalog holds organization names up to 1,000 characters; search rows and
// profiles (web and native share these helpers) show them whole.
describe("long catalog organization names", () => {
  const long = (n, lead = "Sindicato Nacional de Trabajadores de Ejemplo") => `${lead.padEnd(n - 1, " de la Industria Ejemplar").slice(0, n - 1)}x`;

  it("keeps a search row's name and parent name of up to 1,000 characters whole", () => {
    expect(CATALOG_ORGANIZATION_NAME_MAX).toBe(1000);
    for (const n of [201, 622, 1000]) {
      const row = normalizeCatalogRow({ key: "ug-exmx000000", name: long(n), parentName: long(n, "Confederacion de Ejemplo") });
      expect(row.name, String(n)).toBe(long(n));
      expect(row.parentName, String(n)).toBe(long(n, "Confederacion de Ejemplo"));
    }
    const over = normalizeCatalogRow({ key: "ug-exmx000000", name: long(1001) });
    expect([...over.name]).toHaveLength(1000);
    expect(over.name.endsWith("…")).toBe(true);
  });

  it("keeps a profile's organization, parent and child names whole, and still caps sub-unit names at 200", () => {
    const profile = normalizeCatalogProfile({
      found: true,
      organization: { key: "ug-exmx000000", name: long(622) },
      parents: [{ parentKey: "ug-exca000000", parentName: long(900, "Federacion de Ejemplo"), certainty: "confirmed" }],
      children: [{ key: "ug-exbr000000", name: long(1000, "Sindicato dos Trabalhadores de Exemplo"), edgeKind: "parent_body", certainty: "confirmed" }],
      subunits: [{ key: "ug-exmx000000~other-000000000000", name: long(300, "Seccion de Ejemplo"), kind: "other" }],
    });
    expect(profile.organization.name).toBe(long(622));
    expect(profile.parents[0].parentName).toBe(long(900, "Federacion de Ejemplo"));
    expect(profile.children[0].name).toBe(long(1000, "Sindicato dos Trabalhadores de Exemplo"));
    expect([...profile.subunits[0].name]).toHaveLength(200);
    expect(profile.subunits[0].name.endsWith("…")).toBe(true);
  });

  it("counts code points, so a name of 1,000 astral characters is kept and a longer one is cut between characters", () => {
    const astral = "\u{1D518}".repeat(1000);
    expect(normalizeCatalogRow({ key: "ug-exmx000000", name: astral }).name).toBe(astral);
    const cut = normalizeCatalogRow({ key: "ug-exmx000000", name: `${astral}\u{1D518}` }).name;
    expect([...cut]).toHaveLength(1000);
    expect(cut.slice(0, -1)).toBe("\u{1D518}".repeat(999));
  });
});
