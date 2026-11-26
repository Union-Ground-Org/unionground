import { RAIL_EXTRA_ITEMS } from "../components/BottomNav.jsx";

const rewards = RAIL_EXTRA_ITEMS.find((item) => item.key === "rewards");
const appointments = RAIL_EXTRA_ITEMS.find((item) => item.key === "appointments");
const forms = RAIL_EXTRA_ITEMS.find((item) => item.key === "forms");
const workload = RAIL_EXTRA_ITEMS.find((item) => item.key === "workload");

// Pinned shortcuts and the command palette name each place as the desktop
// rail does, so one place has one name (#9527, B-32 and B-36): Voting, not
// Voice; Know your rights, not Learn; Settings, not More. The phone tab bar
// (BottomNav) keeps its own short labels.
export const SHORTCUT_CATALOG = [
  { key: "today", labelKey: "nav.home", path: "/m", icon: "🏠" },
  { key: "numbers", labelKey: "nav.myReports", path: "/m/numbers", icon: "📈" },
  { key: "voting", labelKey: "nav.voting", path: "/m/voting", icon: "📣" },
  { key: "rights", labelKey: "nav.knowRights", path: "/m/rights", icon: "📚" },
  { key: "cases", labelKey: "nav.myCases", path: "/m/cases", icon: "📁" },
  { key: "messages", labelKey: "nav.messages", path: "/m/messages", icon: "💬" },
  { key: "events", labelKey: "morehub.events", path: "/m/events", icon: "📅" },
  rewards,
  forms,
  appointments,
  workload,
  { key: "voice", labelKey: "morehub.beHeard", path: "/m/voice", icon: "🗣" },
  // The owner's Find my steward / Contact my steward Home entry. It resolves to
  // the Home view because that is where the steward card lives; the key stays
  // distinct from "today" so a member can pin, order and remove it on its own.
  { key: "find-steward", viewKey: "today", labelKey: "nav.findSteward", path: "/m", icon: "🤝" },
  { key: "org-structure", viewKey: "orgStructure", labelKey: "nav.orgStructure", path: "/m/org-structure", icon: "◍" },
  { key: "hub", labelKey: "nav.myChapter", path: "/m/organize/organize", icon: "⌂" },
  { key: "network", viewKey: "coordination", labelKey: "nav.network", path: "/m/network", icon: "◎" },
  { key: "search", labelKey: "nav.search", path: "/m/search", icon: "🔍" },
  { key: "settings", labelKey: "nav.settings", path: "/m/settings", icon: "☰" },
  { key: "compass", labelKey: "nav.compass", icon: "🧭", action: "assistant" },
].filter(Boolean);

export const MAX_SHORTCUTS = 6;
export const WORK_WIDGET_KEYS = ["messages", "appointments", "cases", "forms", "workload", "numbers"];

export function defaultShortcutKeys(hasStewardRole) {
  // Members get Find my steward on by default (owner order 2026-09-22): it is
  // the most common member action and was unreachable from Home. "numbers"
  // makes room for it — My reports is still a Home chip and a rail item. The
  // steward hat's default is unchanged; a steward does not look up their own
  // steward from their desk.
  return hasStewardRole
    ? ["today", "cases", "messages", "numbers", "compass", "settings"]
    : ["today", "find-steward", "voting", "rights", "compass", "settings"];
}

export function normalizeShortcutKeys(value, hasStewardRole = false) {
  if (!Array.isArray(value)) return defaultShortcutKeys(hasStewardRole);
  const allowed = new Set(SHORTCUT_CATALOG.map((item) => item.key));
  const normalized = [...new Set(value.filter((key) => typeof key === "string" && allowed.has(key)))]
    .slice(0, MAX_SHORTCUTS);
  return normalized.length ? normalized : defaultShortcutKeys(hasStewardRole);
}

export function normalizeWidgetOrder(value) {
  const normalized = Array.isArray(value)
    ? [...new Set(value.filter((key) => WORK_WIDGET_KEYS.includes(key)))]
    : [];
  for (const key of WORK_WIDGET_KEYS) if (!normalized.includes(key)) normalized.push(key);
  return normalized;
}

function demoStorageKey(memberId) {
  return memberId ? `sg-navigation-preferences:${memberId}` : null;
}

export function loadDemoNavigationPreferences(memberId, hasStewardRole = false) {
  const key = demoStorageKey(memberId);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.shortcutKeys) || !Array.isArray(parsed?.workWidgetOrder)) return null;
    window.localStorage.removeItem("sg-work-widgets");
    return {
      shortcutKeys: normalizeShortcutKeys(parsed.shortcutKeys, hasStewardRole),
      workWidgetOrder: normalizeWidgetOrder(parsed.workWidgetOrder),
    };
  } catch {
    return null;
  }
}

export function saveDemoNavigationPreferences(memberId, preferences, hasStewardRole = false) {
  const key = demoStorageKey(memberId);
  if (!key || !Array.isArray(preferences?.shortcutKeys) || !Array.isArray(preferences?.workWidgetOrder)) return;
  try {
    window.localStorage.setItem(key, JSON.stringify({
      shortcutKeys: normalizeShortcutKeys(preferences.shortcutKeys, hasStewardRole),
      workWidgetOrder: normalizeWidgetOrder(preferences.workWidgetOrder),
    }));
    window.localStorage.removeItem("sg-work-widgets");
  } catch {
    // Demo preferences remain in React state when storage is unavailable.
  }
}

export function createNavigationPreferenceSaveQueue({
  initial,
  persist,
  canCommit,
  onConfirmed = () => {},
  onRollback = () => {},
}) {
  let confirmed = initial;
  let latestRevision = 0;
  let tail = Promise.resolve();

  return {
    enqueue(snapshot, context) {
      const revision = ++latestRevision;
      const run = tail.catch(() => {}).then(async () => {
        if (!canCommit(context)) return;
        try {
          await persist(snapshot, context);
        } catch (error) {
          if (canCommit(context) && revision === latestRevision) onRollback(confirmed, error);
          throw error;
        }
        if (!canCommit(context)) return;
        confirmed = snapshot;
        onConfirmed(snapshot);
      });
      tail = run.catch(() => {});
      return run;
    },
  };
}
