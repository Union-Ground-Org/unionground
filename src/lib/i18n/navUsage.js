import { navUsageCatalogueSpanish } from "./locales/es/namespaces/navUsage.js";
// Usage-based navigation (REQ-UG-USAGE-BASED-NAVIGATION-20261001), split
// out of the src/lib/i18n.js barrel like getApp.js. This file is the ONLY
// declaration of every `navUsage.` key and of this record's `settings.def.`
// keys; the barrel spreads it back into `catalogue`, so `t()` is unchanged.
export const navUsageCatalogue = {
  en: {
    "navUsage.groupTitle": "Most used",
    "navUsage.settingsTitle": "Most used places",
    "navUsage.settingsBody": "The places you open most in the last 30 days move to the top of the menu. Pin a place below to keep it at the very top. Counts and pins stay on this device only and are never sent to Union Ground.",
    "navUsage.reset": "Reset most used",
    "navUsage.resetDone": "Reset. Most used is cleared on this device; your pins stay.",
    "navUsage.pinnedGroupTitle": "Pinned",
    "navUsage.pinsTitle": "Pin places to the top of the menu",
    "navUsage.pinsHelp": "Pinned places come first in the side menu on this computer or tablet, in the order you pin them. You can pin up to {max}.",
    "navUsage.pinLabel": "Pin {label}",
    "navUsage.pinShort": "Pin",
    "navUsage.pinnedShort": "Pinned",
    "navUsage.pinsFull": "You have pinned {max} places, the most allowed. Unpin one to pin another.",
    "navUsage.pinDone": "{label} is pinned to the top of the menu.",
    "navUsage.unpinDone": "{label} is no longer pinned.",
    "settings.def.features.home.usage_based_navigation.label": "Most-used navigation",
    "settings.def.features.home.usage_based_navigation.description": "Move each worker's four most-used destinations to the top of the menu, ranked on their own device only. Pinned shortcuts always win.",
  },
  get es() { return navUsageCatalogueSpanish; },
};
