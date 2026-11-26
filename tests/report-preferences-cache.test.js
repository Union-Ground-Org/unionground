// @vitest-environment node
// BUG-UG-WEB-MY-REPORTS-ORDER-NOT-KEPT-20261003: a saved My reports
// order updated app data only, so the member loader kept serving the cached
// get_my_report_preferences value and the next projection restored the layout
// from before the save.
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";
import { confirmReportPreferences, REPORT_PREFERENCES_RESOURCE } from "../src/lib/reportPreferencesCache.js";

let loader = null;
afterEach(() => { loader?.dispose(); loader = null; });

function harness(initial) {
  const server = { prefs: initial };
  const client = {
    from() {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject);
        return () => query;
      } });
      return query;
    },
    rpc: async (name) => ({ data: name === "get_my_report_preferences" ? structuredClone(server.prefs) : null, error: null }),
  };
  loader = createMemberSessionLoader(client, { id: "member" });
  return server;
}

const before = { order: ["actions", "cases"], hidden: [], custom: [] };
const saved = { order: ["cases", "actions"], hidden: [], custom: [] };

it("a later projection shows the saved order once the save is confirmed into the loader", async () => {
  const server = harness(before);
  expect((await loader.loadRoute("numbers")).reportPreferences).toEqual(before);
  // save_my_report_preferences changed the row.
  server.prefs = saved;
  // Unconfirmed, the loader keeps answering from its cached read.
  expect((await loader.loadRoute("numbers")).reportPreferences).toEqual(before);
  confirmReportPreferences(loader, saved);
  expect((await loader.loadRoute("numbers")).reportPreferences).toEqual(saved);
  expect(REPORT_PREFERENCES_RESOURCE).toBe("rpc:get_my_report_preferences");
});

it("a fresh session (a reload) reads the saved row", async () => {
  harness(saved);
  expect((await loader.loadRoute("numbers")).reportPreferences).toEqual(saved);
});

it("the App's save handler confirms the saved layout into its loader (source check)", () => {
  const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("async function handleReportPreferences(config)"));
  expect(handler.slice(0, 600)).toMatch(/confirmReportPreferences\(memberLoaderRef\.current, config\);/);
});
