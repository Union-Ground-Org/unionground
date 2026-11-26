// REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 4a: the member's
// own case read carries member_cases.time_zone, which arrives with its
// migration. This build may be live before the migration applies: a database
// without the column answers 42703 or PGRST204 naming it, and the read runs
// again without the column instead of failing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";
import { MEMBER_HOME_BOOTSTRAP_RPC, memberHomeBootstrapRequested } from "../src/lib/memberHomeBootstrap.js";
import { missingTimeZoneColumn, withoutTimeZoneColumn } from "../src/lib/timeZoneColumn.js";

vi.mock("../src/lib/deferredObservability.js", async (importOriginal) => ({ ...(await importOriginal()), captureSanitizedDiagnostic: vi.fn(() => true) }));
afterEach(() => { vi.restoreAllMocks(); });

const CASE = { id: "case-1", user_id: "member", reference: "GR-2026-14296", title: "Schedule change", case_type: "Scheduling", step: "Intake", status: "active", deadline: "2026-11-27", updated_at: "2026-11-01T12:00:00Z" };

// A PostgREST stand-in that refuses any select naming time_zone with the given error.
function client(code, message) {
  const queries = [];
  return {
    queries,
    from(table) {
      const calls = [];
      queries.push({ table, calls });
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") {
          const select = calls.find(([method]) => method === "select")?.[1][0] ?? "";
          const answer = /\btime_zone\b/.test(select) ? { data: null, error: { code, message } }
            : { data: table === "member_cases" ? [CASE] : table === "member_profiles" ? { id: "member", full_name: "Fictional Member", language: "en" } : [], error: null };
          return (resolve) => resolve(answer);
        }
        return (...args) => { if (typeof key === "string") calls.push([key, args]); return query; };
      } });
      return query;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

describe("the member's case read before the time_zone migration applies", () => {
  it("knows the missing-column answers that name time_zone, and only those", () => {
    expect(missingTimeZoneColumn({ code: "42703", message: "column member_cases.time_zone does not exist" })).toBe(true);
    expect(missingTimeZoneColumn({ code: "PGRST204", message: "Could not find the 'time_zone' column of 'member_cases' in the schema cache" })).toBe(true);
    expect(missingTimeZoneColumn({ code: "42703", message: "column member_cases.deadline does not exist" })).toBe(false);
    expect(missingTimeZoneColumn({ code: "42501", message: "time_zone permission denied" })).toBe(false);
    expect(missingTimeZoneColumn(null)).toBe(false);
    expect(withoutTimeZoneColumn("id,deadline,time_zone")).toBe("id,deadline");
  });

  it.each([["42703", "column member_cases.time_zone does not exist"], ["PGRST204", "Could not find the 'time_zone' column of 'member_cases' in the schema cache"]])(
    "loads My cases without time_zone when the database answers %s", async (code, message) => {
      const fake = client(code, message);
      const loader = createMemberSessionLoader(fake, { id: "member" });
      const projection = await loader.loadRoute("cases");
      expect(projection.cases.map((item) => item.id)).toContain("case-1");
      const reads = fake.queries.filter((query) => query.table === "member_cases").map(({ calls }) => calls.find(([method]) => method === "select")[1][0]);
      expect(reads.at(-1)).not.toMatch(/time_zone/);
      // Still the member's own cases only.
      expect(fake.queries.filter((query) => query.table === "member_cases").at(-1).calls).toContainEqual(["eq", ["user_id", "member"]]);
      // The recovered read is not a reload failure: the probe is withdrawn (#9617 stage 580, r5s2/r6s2).
      expect(loader.stateForRoute("cases").refreshError).toBe("");
      expect(loader.failuresForResources(["table:member_cases"])).toEqual([]);
      loader.dispose();
    });
});

// #9678 round 1 (r1s1/r2s1): every way the member's case read reaches the
// session loader before the migration applies. The loader answers a failed
// first read with error, and a failed refresh that kept earlier rows with those
// rows and refreshFailure; the read without time_zone must recover both, and no
// route may be left with a reload error. The bootstrap here is the function as
// it is before the migration: it answers each case without time_zone.
function server() {
  const state = { bootstrapFails: false };
  const base = client("42703", "column member_cases.time_zone does not exist");
  base.state = state;
  base.rpc = async (name, args) => {
    if (name !== MEMBER_HOME_BOOTSTRAP_RPC) return { data: null, error: null };
    if (state.bootstrapFails) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    const payload = { user_id: "member" };
    for (const resource of memberHomeBootstrapRequested(args)) payload[resource.slice(6)] = resource === "table:member_cases" ? [CASE] : [];
    return { data: payload, error: null };
  };
  return base;
}
const caseSelects = (fake) => fake.queries.filter((query) => query.table === "member_cases").map(({ calls }) => calls.find(([method]) => method === "select")[1][0]);
function expectClean(loader, projection) {
  expect(projection.cases.map((item) => item.id)).toContain("case-1");
  for (const route of ["cases", "today"]) expect(loader.stateForRoute(route).refreshError, route).toBe("");
  expect(loader.failuresForResources(["table:member_cases"])).toEqual([]);
}

describe("every session-loader path of the case read before the migration (#9678 round 1)", () => {
  it("first load through the bootstrap: the rows arrive without time_zone and no table read is needed", async () => {
    const fake = server();
    const loader = createMemberSessionLoader(fake, { id: "member" });
    expectClean(loader, await loader.loadRoute("cases"));
    expect(caseSelects(fake)).toEqual([]);
    loader.dispose();
  });

  it("refresh after a bootstrap load, when the bootstrap then fails: the kept rows' refresh failure is recovered", async () => {
    const fake = server();
    const loader = createMemberSessionLoader(fake, { id: "member" });
    await loader.loadRoute("cases");
    fake.state.bootstrapFails = true;
    expectClean(loader, await loader.loadRoute("cases", { force: true }));
    expect(caseSelects(fake).at(-1)).not.toMatch(/time_zone/);
    // A further refresh, batching now off, stays clean too.
    expectClean(loader, await loader.loadRoute("cases", { force: true }));
    loader.dispose();
  });

  it("first load and refresh with no bootstrap: the failed first read and every refresh are recovered", async () => {
    const fake = server();
    fake.state.bootstrapFails = true;
    const loader = createMemberSessionLoader(fake, { id: "member" });
    expectClean(loader, await loader.loadRoute("cases"));
    expectClean(loader, await loader.loadRoute("cases", { force: true }));
    expect(caseSelects(fake).at(-1)).not.toMatch(/time_zone/);
    loader.dispose();
  });

  it("Home first, then My cases from the cached rows, then a refresh of each", async () => {
    const fake = server();
    const loader = createMemberSessionLoader(fake, { id: "member" });
    await loader.loadRoute("today");
    expectClean(loader, await loader.loadRoute("cases"));
    fake.state.bootstrapFails = true;
    await loader.loadRoute("today", { force: true });
    expectClean(loader, await loader.loadRoute("cases"));
    expectClean(loader, await loader.loadRoute("cases", { force: true }));
    loader.dispose();
  });
});
