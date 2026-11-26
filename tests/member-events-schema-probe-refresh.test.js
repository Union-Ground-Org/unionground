import { expect, it } from "vitest";
import { createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";
import { LEGACY_EVENT_COLUMNS } from "../src/lib/eventSchemaCompatibility.js";

// Visual assurance run 37900350268 (October 9, 2026, 3:49 AM ET) audited
// the sibling product while the deployed code already selected the event-model columns
// and SAMPLE had not yet applied 20261009002000_event_model.sql. Every
// member_events read answered HTTP 400 (42703), the compatibility helper
// retried with the legacy columns and the rows rendered, but the failed probe
// stayed in the session registry and every member route showed "Load failed".

const missingColumn = (column) => ({ code: "42703", message: `column member_events.${column} does not exist`, details: null, hint: null });
const event = { id: "event", chapter_id: "home", title: "Meeting", starts_at: "2020-01-01T12:00:00Z" };

function preCutoverClient({ missing = "ends_at", legacyFails = false } = {}) {
  const selects = [];
  return {
    selects,
    from(table) {
      const operations = [];
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => {
          const columns = operations.find(([name]) => name === "select")?.[1][0] ?? "";
          let result = { data: [], error: null };
          if (table === "member_profiles") result = { data: { id: "member", chapter_id: "home", full_name: "Member" }, error: null };
          if (table === "member_events") {
            selects.push(columns);
            if (columns.split(",").includes(missing)) result = { data: null, error: missingColumn(missing) };
            else if (legacyFails) result = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
            else result = { data: [event], error: null };
          }
          return Promise.resolve(result).then(resolve, reject);
        };
        return (...args) => { operations.push([key, args]); return query; };
      } });
      return query;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

it("does not report a schema probe the legacy-column retry recovered as a route refresh failure", async () => {
  const client = preCutoverClient();
  const loader = createMemberSessionLoader(client, { id: "member" });
  const projection = await loader.loadRoute("events");
  // The probe really failed and the retry really ran with the legacy columns.
  expect(client.selects.some((columns) => /\bends_at\b/.test(columns))).toBe(true);
  expect(client.selects).toContain(LEGACY_EVENT_COLUMNS);
  expect(loader.stateForRoute("events")).toEqual({ status: "loaded", error: "", refreshError: "" });
  expect(loader.stateForRoute("today").refreshError).toBe("");
  expect(projection.resourceRefreshFailures).toEqual([]);
  expect(loader.inspect().get("table:member_events").status).toBe("loaded");
  loader.dispose();
});

it("withdraws the check_in_offered probe the same way once its retry succeeds", async () => {
  const client = preCutoverClient({ missing: "check_in_offered" });
  const loader = createMemberSessionLoader(client, { id: "member" });
  const projection = await loader.loadRoute("events");
  expect(client.selects.some((columns) => columns.split(",").includes("check_in_offered"))).toBe(true);
  expect(client.selects.some((columns) => columns.includes("sort_at") && !columns.includes("check_in_offered"))).toBe(true);
  expect(loader.stateForRoute("events").refreshError).toBe("");
  expect(projection.resourceRefreshFailures).toEqual([]);
  loader.dispose();
});

it("still reports member_events as failed when the legacy-column retry also fails", async () => {
  const loader = createMemberSessionLoader(preCutoverClient({ legacyFails: true }), { id: "member" });
  await loader.loadRoute("events").catch(() => {});
  expect(loader.inspect().get("table:member_events").status).toBe("error");
  expect(loader.inspect().get("table:member_events").failure.code).toBe("57014");
  loader.dispose();
});
