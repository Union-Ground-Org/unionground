// @vitest-environment node
//
// REQ-UG-FIND-YOUR-UNION-PUBLIC-REGISTRY-SEARCH-20260924: the pure query
// helpers behind /unions. A visitor's text must never widen the filter, a
// local number must reach the column that actually carries it, and every row
// that renders must be shaped by the normalizer, not by the raw response.
import { describe, expect, it } from "vitest";
import {
  buildRegistryQuery,
  normalizeRegistryFilters,
  normalizeRegistryRow,
  parseRegistryQuery,
  quotedFilterValue,
  REGISTRY_MAX_PAGES,
  REGISTRY_PAGE_SIZE,
  registryPageCount,
  registrySearchPlan,
  searchRegistry,
  websiteFromRow,
} from "../src/features/unionCatalog/registrySearch.js";

function fakeClient(respond) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = [["from", [table]]];
      calls.push(call);
      const builder = {};
      for (const method of ["select", "eq", "or", "order", "range"]) {
        builder[method] = (...args) => { call.push([method, args]); return builder; };
      }
      builder.then = (resolve, reject) => Promise.resolve().then(() => respond(call)).then(resolve, reject);
      return builder;
    },
  };
}

const steps = (call, method) => call.filter(([name]) => name === method).map(([, args]) => args);

describe("parseRegistryQuery", () => {
  it.each([
    ["Local 600", { localNumber: "600", text: "" }],
    ["lu 12 boston", { localNumber: "12", text: "boston" }],
    ["Branch #0042", { localNumber: "42", text: "" }],
    ["1199", { localNumber: "1199", text: "" }],
    ["#26", { localNumber: "26", text: "" }],
    ["steelworkers", { localNumber: "", text: "steelworkers" }],
    ["  service   employees  ", { localNumber: "", text: "service employees" }],
    ["a", { localNumber: "", text: "" }],
    ["local 7 x", { localNumber: "7", text: "" }],
    ["", { localNumber: "", text: "" }],
    [null, { localNumber: "", text: "" }],
  ])("reads %j", (input, expected) => {
    expect(parseRegistryQuery(input)).toEqual(expected);
  });
});

describe("quotedFilterValue", () => {
  it("double-quotes the value and escapes quotes and backslashes", () => {
    expect(quotedFilterValue("%a%")).toBe('"%a%"');
    expect(quotedFilterValue('%he said "hi", ok%')).toBe('"%he said \\"hi\\", ok%"');
    expect(quotedFilterValue("%50\\%%")).toBe('"%50\\\\%%"');
  });
});

describe("registrySearchPlan", () => {
  it("needs two characters, a local number, or a filter before anything is sent", () => {
    expect(registrySearchPlan("a").searchable).toBe(false);
    expect(registrySearchPlan("").searchable).toBe(false);
    expect(registrySearchPlan("ab").searchable).toBe(true);
    expect(registrySearchPlan("12").searchable).toBe(true);
    expect(registrySearchPlan("", { state: "MA" }).searchable).toBe(true);
    expect(registrySearchPlan("", { affiliation: "SEIU" }).searchable).toBe(true);
    expect(registrySearchPlan("", { level: "national" }).searchable).toBe(true);
  });

  it("escapes LIKE wildcards and drops the PostgREST star", () => {
    expect(registrySearchPlan("50% _x*").pattern).toBe("%50\\% \\_x%");
  });

  it("refuses unknown filter values and out-of-range pages", () => {
    expect(normalizeRegistryFilters({ state: "ZZ", affiliation: "NOPE", level: "galactic", page: -1 }))
      .toEqual({ state: "", affiliation: "", level: "", page: 0 });
    expect(normalizeRegistryFilters({ state: "00", page: REGISTRY_MAX_PAGES }).page).toBe(0);
    expect(normalizeRegistryFilters({ state: "PR", affiliation: "USW", level: "local", page: 3 }))
      .toEqual({ state: "PR", affiliation: "USW", level: "local", page: 3 });
  });
});

describe("buildRegistryQuery", () => {
  it("sends the local number to local_number (or the whole query to name) and the text to name, city or affiliation, quoted", async () => {
    const client = fakeClient(() => ({ data: [], count: 0, error: null }));
    await buildRegistryQuery(client, registrySearchPlan("lu 12 boston, ma (west)", { state: "MA", affiliation: "SEIU", level: "local", page: 2 }));
    const call = client.calls[0];
    expect(call[0]).toEqual(["from", ["union_orgs"]]);
    expect(steps(call, "select")[0][1]).toEqual({ count: "exact" });
    expect(steps(call, "eq")).toEqual([["state", "MA"], ["affiliation", "SEIU"], ["level", "local"]]);
    expect(steps(call, "or")).toEqual([
      ['local_number.eq."12",name.ilike."%lu 12 boston, ma (west)%"'],
      ['name.ilike."%boston, ma (west)%",city.ilike."%boston, ma (west)%",affiliation.ilike."%boston, ma (west)%"'],
    ]);
    expect(steps(call, "order").map(([column]) => column)).toEqual(["name", "local_number", "id"]);
    expect(steps(call, "range")).toEqual([[2 * REGISTRY_PAGE_SIZE, 3 * REGISTRY_PAGE_SIZE - 1]]);
  });

  it("matches an affiliation code typed as free text", async () => {
    const client = fakeClient(() => ({ data: [], count: 0, error: null }));
    await buildRegistryQuery(client, registrySearchPlan("SEIU"));
    expect(steps(client.calls[0], "eq")).toEqual([]);
    expect(steps(client.calls[0], "or")).toEqual([['name.ilike."%SEIU%",city.ilike."%SEIU%",affiliation.ilike."%SEIU%"']]);
  });

  it("keeps bare and prefixed local numbers reachable", async () => {
    const client = fakeClient(() => ({ data: [], count: 0, error: null }));
    await buildRegistryQuery(client, registrySearchPlan("Local 1"));
    expect(steps(client.calls[0], "eq")).toEqual([]);
    expect(steps(client.calls[0], "or")).toEqual([['local_number.eq."1",name.ilike."%Local 1%"']]);
    await buildRegistryQuery(client, registrySearchPlan("7"));
    expect(steps(client.calls[1], "eq")).toEqual([["local_number", "7"]]);
    expect(steps(client.calls[1], "or")).toEqual([]);
  });

  it("returns null when there is nothing to search or no client", () => {
    const client = fakeClient(() => ({ data: [], count: 0, error: null }));
    expect(buildRegistryQuery(client, registrySearchPlan("a"))).toBeNull();
    expect(buildRegistryQuery(null, registrySearchPlan("abc"))).toBeNull();
    expect(client.calls).toEqual([]);
  });
});

describe("normalizeRegistryRow", () => {
  it("shapes a row, drops the 00 state sentinel and non-http websites, and pairs members with a year", () => {
    expect(normalizeRegistryRow({
      id: "olms-1", name: "  Example  Workers ", affiliation: "EXW", designation: "LU", local_number: "12", level: "local",
      city: "Springfield", state: "00", website: "ftp://example.invalid", members_latest: 1200, members_latest_year: null, parent_name: "Example Workers",
    })).toEqual({
      id: "olms-1", name: "Example Workers", affiliation: "EXW", designation: "LU", localNumber: "12", level: "local",
      city: "Springfield", state: null, website: null, membersLatest: null, membersYear: null, parentName: "Example Workers",
    });
    expect(normalizeRegistryRow({ id: "olms-2", name: "Example Workers", level: "sideways", state: "MA", website: "https://www.example.invalid/x", members_latest: 5, members_latest_year: 2024 }))
      .toMatchObject({ level: "unknown", state: "MA", website: { href: "https://www.example.invalid/x", host: "example.invalid" }, membersLatest: 5, membersYear: 2024 });
    expect(normalizeRegistryRow({ id: "olms-3", name: "   " })).toBeNull();
    expect(normalizeRegistryRow(null)).toBeNull();
    expect(normalizeRegistryRow({ id: 4, name: "Example" })).toBeNull();
  });

  it("strips control characters and bounds long text", () => {
    const row = normalizeRegistryRow({ id: "olms-5", name: `Ex\u0007ample ${"x".repeat(300)}`, level: "local" });
    expect(row.name.startsWith("Example ")).toBe(true);
    expect(row.name.length).toBe(200);
  });

  it("only keeps http(s) websites without credentials", () => {
    expect(websiteFromRow("http://example.invalid")).toEqual({ href: "http://example.invalid/", host: "example.invalid" });
    expect(websiteFromRow("https://user:pw@example.invalid")).toBeNull();
    expect(websiteFromRow("javascript:alert(1)")).toBeNull();
    expect(websiteFromRow("example.invalid")).toBeNull();
    expect(websiteFromRow(42)).toBeNull();
  });
});

describe("searchRegistry", () => {
  it("returns normalized rows and the exact total", async () => {
    const client = fakeClient(() => ({ data: [{ id: "olms-1", name: "Example Workers", level: "local" }, { id: 7, name: "bad" }], count: 41, error: null }));
    const result = await searchRegistry(client, "example");
    expect(result.rows).toEqual([expect.objectContaining({ id: "olms-1", name: "Example Workers" })]);
    expect(result.total).toBe(41);
    expect(result.plan.searchable).toBe(true);
  });

  it("sends nothing for an unsearchable query", async () => {
    const client = fakeClient(() => { throw new Error("must not be called"); });
    expect(await searchRegistry(client, "a")).toMatchObject({ rows: [], total: 0 });
    expect(client.calls).toEqual([]);
  });

  it("throws on a PostgREST error without leaking the row shape", async () => {
    const client = fakeClient(() => ({ data: null, count: null, error: { message: "boom" } }));
    await expect(searchRegistry(client, "example")).rejects.toMatchObject({ name: "MemberApiError" });
  });
});

describe("registryPageCount", () => {
  it("rounds up and caps the page count", () => {
    expect(registryPageCount(0)).toBe(0);
    expect(registryPageCount(1)).toBe(1);
    expect(registryPageCount(REGISTRY_PAGE_SIZE + 1)).toBe(2);
    expect(registryPageCount(10_000)).toBe(REGISTRY_MAX_PAGES);
    expect(registryPageCount("x")).toBe(0);
  });
});
