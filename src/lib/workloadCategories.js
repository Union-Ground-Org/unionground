// REQ-UG-WORKLOAD-CATEGORY-LABELS-VISIBILITY-ORDER-20261103 (#6910):
// the eight fixed workload categories, and which of them an organization
// shows on the member Workload log and in what order. The categories stay the
// fixed columns of member_workload_logs; a hidden one keeps its history and
// still counts on the server, the page only stops asking for and showing it.

export const WORKLOAD_CATEGORY_KEYS = Object.freeze([
  "priority",
  "pending",
  "unread_docs",
  "todos",
  "referrals",
  "ce_activities",
  "assistance_requests",
  "aged_cases",
]);

// The member session loader's cached read of the layout; a save invalidates it.
export const WORKLOAD_CATEGORY_RESOURCE = "rpc:get_organization_workload_categories";

// Each category's name is an organization label (update_organization_label).
export const WORKLOAD_CATEGORY_LABEL_KEYS = Object.freeze(WORKLOAD_CATEGORY_KEYS.map((key) => `workload.cat.${key}`));

const DEFAULT_LAYOUT = Object.freeze(WORKLOAD_CATEGORY_KEYS.map((key) => Object.freeze({ key, visible: true })));

// The server's answer (get_organization_workload_categories) as all eight
// categories in order. Anything it leaves out keeps its default place after
// the listed ones; anything malformed, or a layout with nothing shown, reads
// as the default so the log never loses every category.
export function workloadCategoryLayout(payload) {
  const listed = Array.isArray(payload?.categories) ? payload.categories : null;
  if (!listed) return DEFAULT_LAYOUT;
  const seen = new Set();
  const layout = [];
  for (const item of listed) {
    if (!item || !WORKLOAD_CATEGORY_KEYS.includes(item.key) || seen.has(item.key)) continue;
    seen.add(item.key);
    layout.push({ key: item.key, visible: item.visible !== false });
  }
  for (const key of WORKLOAD_CATEGORY_KEYS) if (!seen.has(key)) layout.push({ key, visible: true });
  return layout.some((item) => item.visible) ? layout : DEFAULT_LAYOUT;
}

export function shownWorkloadCategories(payload) {
  return workloadCategoryLayout(payload).filter((item) => item.visible).map((item) => item.key);
}

function withCategories(current, result) {
  return current ? { ...current, workload: { ...(current.workload ?? {}), categories: result } } : current;
}

// The admin plane's two verbs. App passes its session guard, so a save that
// answers after the session or scope changed leaves member state alone, and
// the admin's own Workload log follows a save at once. The save also drops
// the session loader's cached read, so a later route load fetches the saved
// layout instead of rebuilding the page from the copy read before the save.
export function liveWorkloadCategoriesApi({ load, save, guardRef, loaderRef, setData }) {
  return {
    loadWorkloadCategories: () => load(),
    saveWorkloadCategories: async (categories) => {
      const operation = guardRef.current.captureOperation();
      const result = await save(categories);
      if (!operation.isCurrent()) return undefined;
      loaderRef.current?.invalidateResources([WORKLOAD_CATEGORY_RESOURCE]);
      setData((current) => withCategories(current, result));
      return result;
    },
  };
}

// The SAMPLE desk keeps the server's rules (save_organization_workload_categories):
// all eight once each, at least one shown, and one configuration history
// entry with the shown categories before and after.
export function sampleWorkloadCategoriesApi({ desk, setData, actorName = "Alex Rivera" }) {
  const shown = shownWorkloadCategories;
  return {
    loadWorkloadCategories: async () => ({ categories: workloadCategoryLayout(desk().workloadCategories), canEdit: true }),
    saveWorkloadCategories: async (categories) => {
      const d = desk();
      const valid = Array.isArray(categories) && categories.length === WORKLOAD_CATEGORY_KEYS.length
        && new Set(categories.map((item) => item?.key)).size === WORKLOAD_CATEGORY_KEYS.length
        && categories.every((item) => WORKLOAD_CATEGORY_KEYS.includes(item?.key) && typeof item.visible === "boolean");
      if (!valid) throw new Error("workload-categories-invalid");
      if (!categories.some((item) => item.visible)) throw new Error("workload-categories-none-shown");
      const previousValue = shown(d.workloadCategories);
      const result = { categories: categories.map((item) => ({ key: item.key, visible: item.visible })), canEdit: true };
      d.workloadCategories = result;
      d.configurationAudit = [
        { id: `demo-workload-categories-${(d.configurationAudit ?? []).length + 1}`, action: "setting_updated", key: "workload.categories",
          previousValue, newValue: shown(result), actorName, createdAt: new Date().toISOString() },
        ...(d.configurationAudit ?? []),
      ];
      setData((current) => withCategories(current, result));
      return result;
    },
  };
}
