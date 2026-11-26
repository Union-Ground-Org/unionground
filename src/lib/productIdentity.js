// Union Ground serves workers and committees who are still forming a union,
// from the first conversation to a first contract. The name a build prints is
// its own (src/lib/brand.js): Union Ground only in Union Ground LLC's official
// builds, the operator's VITE_BRAND_NAME everywhere else.
import { BRAND } from "./brand.js";

export const PRODUCT_NAME = BRAND.name;
export const PRODUCT_SHORT = BRAND.name;
export const PRODUCT_MARK = BRAND.initial;

// Worker destinations stay on existing routes so live loaders, RLS, and
// tests do not have to rename tables in this wave. Labels change; paths do not.
export const WORKER_NAV_ITEMS = [
  { key: "today", labelKey: "nav.today", path: "/m", icon: "⌂" },
  { key: "work", labelKey: "nav.work", path: "/m/work", icon: "☑" },
  { key: "messages", labelKey: "nav.messages", path: "/m/messages", icon: "✉" },
  { key: "cases", labelKey: "nav.issues", path: "/m/cases", icon: "⚑" },
  { key: "rights", labelKey: "nav.rights", path: "/m/rights", icon: "⚖" },
  { key: "events", labelKey: "nav.meetings", path: "/m/events", icon: "▣" },
  { key: "search", labelKey: "nav.search", path: "/m/search", icon: "🔍" },
];

export const WORKER_RAIL_GROUPS = [
  {
    id: "you",
    labelKey: "rail.you",
    items: [
      { key: "today", labelKey: "nav.today", path: "/m", icon: "⌂" },
      { key: "work", labelKey: "nav.work", path: "/m/work", icon: "☑" },
      { key: "messages", labelKey: "nav.messages", path: "/m/messages", icon: "✉" },
      { key: "cases", labelKey: "nav.issues", path: "/m/cases", icon: "⚑" },
    ],
  },
  {
    id: "campaign",
    labelKey: "rail.campaign",
    items: [
      { key: "events", labelKey: "nav.meetings", path: "/m/events", icon: "▣" },
      { key: "rights", labelKey: "nav.rights", path: "/m/rights", icon: "⚖" },
      { key: "rewards", labelKey: "nav.contributions", path: "/m/rewards", icon: "★" },
      { key: "search", labelKey: "nav.search", path: "/m/search", icon: "🔍" },
    ],
  },
  {
    id: "account",
    labelKey: "rail.account",
    items: [
      { key: "settings", labelKey: "nav.settings", path: "/m/settings", icon: "⚙" },
    ],
  },
];

export const ORGANIZER_RAIL_ITEMS = [
  { key: "organize", labelKey: "nav.campaigns", path: "/m/organize", icon: "◎" },
  { key: "events", labelKey: "nav.meetings", path: "/m/events", icon: "▣" },
  { key: "messages", labelKey: "nav.messages", path: "/m/messages", icon: "✉" },
  { key: "search", labelKey: "nav.search", path: "/m/search", icon: "🔍" },
  { key: "settings", labelKey: "nav.settings", path: "/m/settings", icon: "⚙" },
];

export function railItemsForHat(hat) {
  if (hat === "organize" || hat === "organizer") return ORGANIZER_RAIL_ITEMS;
  if (hat && hat !== "member" && hat !== "worker") {
    return [
      { key: hat, labelKey: `demo.hat${hat.charAt(0).toUpperCase()}${hat.slice(1)}`, path: `/m/${hat}`, icon: "▣" },
      ...ORGANIZER_RAIL_ITEMS.filter((item) => item.key !== hat),
    ];
  }
  return WORKER_RAIL_GROUPS.flatMap((group) => group.items);
}
