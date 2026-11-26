// REQ-UG-WORKLOAD-CATEGORY-LABELS-VISIBILITY-ORDER-20261103,
// A saved layout must survive the next
// route load. The member session loader caches get_organization_workload_categories;
// without the save invalidating it, the Workload log rebuilt from the copy read
// before the save and the admin's own page went back to the old order.
import { expect, it, vi } from "vitest";
import { createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";
import { WORKLOAD_CATEGORY_KEYS, liveWorkloadCategoriesApi } from "../src/lib/workloadCategories.js";

vi.mock("../src/lib/deferredObservability.js", async (importOriginal) => ({
  ...(await importOriginal()),
  captureSanitizedDiagnostic: vi.fn(() => true),
}));

function harness() {
  const calls = [];
  const rpcData = {};
  const client = {
    from() {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject);
        return () => query;
      } });
      return query;
    },
    rpc: async (name) => { calls.push(name); return { data: structuredClone(rpcData[name] ?? null), error: null }; },
  };
  return { loader: createMemberSessionLoader(client, { id: "member" }), rpcData, calls };
}

const layout = (keys, hidden = []) => ({ categories: keys.map((key) => ({ key, visible: !hidden.includes(key) })), canEdit: true });
const reads = (calls) => calls.filter((name) => name === "get_organization_workload_categories").length;

it("reloads the saved order and visibility after a save instead of the cached copy", async () => {
  const { loader, rpcData, calls } = harness();
  rpcData.get_organization_workload_categories = layout(WORKLOAD_CATEGORY_KEYS);
  expect((await loader.loadRoute("workload")).workload.categories).toEqual(layout(WORKLOAD_CATEGORY_KEYS));
  // A second load without a save is served from the cache.
  await loader.loadRoute("workload");
  expect(reads(calls)).toBe(1);

  const reordered = ["aged_cases", ...WORKLOAD_CATEGORY_KEYS.slice(0, 7)];
  const saved = layout(reordered, ["todos"]);
  const api = liveWorkloadCategoriesApi({
    load: vi.fn(),
    save: async () => { rpcData.get_organization_workload_categories = saved; return saved; },
    guardRef: { current: { captureOperation: () => ({ isCurrent: () => true }) } },
    loaderRef: { current: loader },
    setData: vi.fn(),
  });
  await api.saveWorkloadCategories(saved.categories);

  const after = await loader.loadRoute("workload");
  expect(reads(calls)).toBe(2);
  expect(after.workload.categories).toEqual(saved);
  loader.dispose();
});

// Gate finding r3s1: a saved organization label (a workload category name
// among them) must survive the next page load in the admin's own session.
it("reloads a saved organization label after a save instead of the cached configuration", async () => {
  const { liveOrganizationLabelApi, MEMBER_ORGANIZATION_CONFIGURATION_RESOURCE } = await import("../src/lib/organizationSettingsAdmin.js");
  const { loader, rpcData, calls } = harness();
  const configuration = (labelOverrides) => ({ available: true, organizationId: "org", labelOverrides, switches: {} });
  rpcData.get_member_organization_configuration = configuration({ "workload.cat.priority": "Hot files" });
  expect((await loader.loadRoute("workload")).organizationConfiguration.labelOverrides).toEqual({ "workload.cat.priority": "Hot files" });
  await loader.loadRoute("workload");
  const configReads = () => calls.filter((name) => name === "get_member_organization_configuration").length;
  expect(configReads()).toBe(1);

  let current = true;
  const setData = vi.fn();
  const api = liveOrganizationLabelApi({
    save: async (key, value) => {
      const overrides = { ...rpcData.get_member_organization_configuration.labelOverrides };
      if (value) overrides[key] = value; else delete overrides[key];
      rpcData.get_member_organization_configuration = configuration(overrides);
      return value ? { key, value, updated: true } : { key, value: null, removed: true };
    },
    guardRef: { current: { captureOperation: () => ({ isCurrent: () => current }) } },
    loaderRef: { current: loader },
    setData,
  });
  await expect(api.updateOrganizationLabel("workload.cat.todos", "Tasks")).resolves.toEqual({ key: "workload.cat.todos", value: "Tasks", updated: true });
  const after = await loader.loadRoute("workload");
  expect(configReads()).toBe(2);
  expect(after.organizationConfiguration.labelOverrides).toEqual({ "workload.cat.priority": "Hot files", "workload.cat.todos": "Tasks" });

  // The page follows at once too: a set name is added, a cleared one removed.
  const apply = (state) => setData.mock.calls.reduce((value, [update]) => update(value), state);
  expect(apply({ organizationConfiguration: { labelOverrides: { "workload.cat.priority": "Hot files" } } }).organizationConfiguration.labelOverrides)
    .toEqual({ "workload.cat.priority": "Hot files", "workload.cat.todos": "Tasks" });
  await api.updateOrganizationLabel("workload.cat.priority", "");
  expect(apply({ organizationConfiguration: { labelOverrides: { "workload.cat.priority": "Hot files" } } }).organizationConfiguration.labelOverrides)
    .toEqual({ "workload.cat.todos": "Tasks" });
  expect(apply(null)).toBeNull();
  expect(apply({}).organizationConfiguration.labelOverrides).toEqual({ "workload.cat.todos": "Tasks" });
  expect((await loader.loadRoute("workload")).organizationConfiguration.labelOverrides).toEqual({ "workload.cat.todos": "Tasks" });
  expect(MEMBER_ORGANIZATION_CONFIGURATION_RESOURCE).toBe("rpc:get_member_organization_configuration");

  // A save that answers after the session changed leaves the page and cache alone.
  current = false;
  const writes = setData.mock.calls.length;
  await expect(api.updateOrganizationLabel("nav.home", "Start")).resolves.toBeUndefined();
  expect(setData).toHaveBeenCalledTimes(writes);
  await loader.loadRoute("workload");
  expect(configReads()).toBe(3);
  // No loader yet is not an error.
  current = true;
  const early = liveOrganizationLabelApi({ save: async (key, value) => ({ key, value, updated: true }), guardRef: { current: { captureOperation: () => ({ isCurrent: () => true }) } }, loaderRef: { current: null }, setData: vi.fn() });
  await expect(early.updateOrganizationLabel("nav.home", "Start")).resolves.toEqual({ key: "nav.home", value: "Start", updated: true });
  loader.dispose();
});
